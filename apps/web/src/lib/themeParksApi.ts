/**
 * themeParksApi.ts — isolated, SERVER-SIDE ThemeParks.wiki (Free API) client.
 *
 * Provider boundary for Phase 12 showtime/schedule work. Queue-Times stays
 * the attraction wait provider (liveWaitApi.ts, untouched); DWP's catalog
 * stays the canonical identity authority. ThemeParks UUIDs are integration
 * metadata (themeParksProviders.ts). Do not import this from browser code —
 * later consumers reach it through a DWP route/server component.
 *
 * Operations (only what showtime/schedule work needs):
 *   getDestinations()            GET /destinations          (discovery)
 *   getEntity(id)                GET /entity/{id}           (timezone/identity)
 *   getLive(id)                  GET /entity/{id}/live      (status + showtimes)
 *   getSchedule(id, {year,month}?) GET /entity/{id}/schedule[/{y}/{m}]
 *   verifyProviderIdentity()     discovery vs. configured WDW/DLR ids
 *
 * Every response is validated + normalized here; raw payloads never leave
 * this module (unused fields — queue, forecast, dining, purchases/pricing —
 * are dropped). Provider UUIDs, offset-aware timestamp strings (kept
 * verbatim), schedule/showtime `type` strings and `lastUpdated` are
 * preserved. Nothing is ever fabricated: a valid-empty payload is
 * `{ ok: true }` with empty arrays; anything else is `{ ok: false }` with a
 * typed error. There are no synthetic schedules/showtimes.
 *
 * Caching (in-memory, per server instance), endpoint-aware:
 *   destinations/entity  fresh 6h,  stale-if-error up to 7d
 *   schedule             fresh 15m, stale-if-error up to 6h
 *   live                 fresh 60s, stale-if-error up to 10m
 * A stale hit is only served when the refresh failed, and is flagged
 * (`meta.origin === "stale"`, `meta.staleReason`, `meta.fetchedAt`) — never
 * silent. Expired entries revalidate with `If-None-Match` (ETag); a 304 just
 * extends freshness. Concurrent identical requests share one in-flight fetch.
 * 429 (and 503) honor `Retry-After` (seconds or HTTP-date, default 60s, cap
 * 1h) with a client-wide backoff: no network calls until it elapses.
 */

import { isValidIsoCalendarDate } from "./plannerWarnings";
import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import {
  THEMEPARKS_API_BASE_URL,
  THEMEPARKS_DESTINATIONS,
  THEMEPARKS_PARKS,
  getThemeParksParkIdsForResort,
} from "./themeParksProviders";

// ============================================
// TYPES
// ============================================

export type ThemeParksErrorKind =
  | "rate_limited"
  | "timeout"
  | "network"
  | "not_found"
  | "http"
  | "invalid_payload"
  | "invalid_request";

export interface ThemeParksError {
  kind: ThemeParksErrorKind;
  message: string;
  httpStatus?: number;
  /** Milliseconds until the provider may be called again (rate limits). */
  retryAfterMs?: number;
}

export interface ThemeParksMeta {
  /** network = fresh fetch; cache = within TTL; revalidated = 304; stale = refresh failed. */
  origin: "network" | "cache" | "revalidated" | "stale";
  /** Epoch ms when the provider last confirmed this data. */
  fetchedAt: number;
  etag: string | null;
  /** Present iff origin === "stale": why the refresh failed. */
  staleReason?: ThemeParksError;
}

export type ThemeParksResult<T> =
  | { ok: true; data: T; meta: ThemeParksMeta }
  | { ok: false; error: ThemeParksError };

export interface ThemeParksDestination {
  entityId: string;
  name: string;
  slug: string | null;
  parks: Array<{ entityId: string; name: string }>;
}

export interface ThemeParksEntity {
  entityId: string;
  name: string;
  entityType: string;
  timeZone: string | null;
  parentId: string | null;
}

export interface ThemeParksShowtime {
  /** Provider label, e.g. "Performance Time" / "Operating". */
  type: string | null;
  /** Offset-aware ISO string, verbatim from the provider. */
  startTime: string;
  endTime: string | null;
}

export interface ThemeParksLiveEntry {
  entityId: string;
  name: string;
  /** ATTRACTION | SHOW | RESTAURANT | PARK | ... (provider value). */
  entityType: string;
  /** Provider park UUID (map with resolveDwpParkFromThemeParksId). */
  parkId: string | null;
  externalId: string | null;
  /** OPERATING | CLOSED | REFURBISHMENT | ... (provider value), when supplied. */
  status: string | null;
  /** Provider's own last-updated timestamp, when supplied. */
  lastUpdated: string | null;
  showtimes: ThemeParksShowtime[];
}

export interface ThemeParksLive {
  entityId: string;
  name: string;
  timeZone: string | null;
  entries: ThemeParksLiveEntry[];
  /** Malformed entries/showtimes discarded during validation. */
  droppedEntries: number;
  droppedShowtimes: number;
}

export interface ThemeParksScheduleEntry {
  /** Provider's calendar date for the entry (YYYY-MM-DD, resort-local). */
  date: string;
  /** OPERATING | TICKETED_EVENT | EXTRA_HOURS | INFORMATIONAL | ... (verbatim). */
  type: string;
  /** Offset-aware ISO strings, verbatim. */
  openingTime: string;
  closingTime: string;
  description: string | null;
  lastUpdated: string | null;
}

export interface ThemeParksParkSchedule {
  entityId: string;
  name: string;
  /** Park's own zone, else the document's (park zones are often null in destination docs). */
  timeZone: string | null;
  entries: ThemeParksScheduleEntry[];
}

export interface ThemeParksSchedule {
  entityId: string;
  name: string;
  timeZone: string | null;
  /** Entries for a park request (empty for a destination request). */
  entries: ThemeParksScheduleEntry[];
  /** Per-park schedules for a destination request (empty for a park request). */
  parks: ThemeParksParkSchedule[];
  droppedEntries: number;
}

export interface ThemeParksIdentityReport {
  ok: boolean;
  /** Human-readable drift findings; empty when configured ids match discovery. */
  mismatches: string[];
}

// ============================================
// VALIDATION / NORMALIZATION (pure)
// ============================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OFFSET_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}
/** Offset-aware (or Z) ISO timestamp that actually parses; else null. */
export function asOffsetTimestamp(v: unknown): string | null {
  const s = str(v);
  if (!s || !OFFSET_TIMESTAMP_RE.test(s) || Number.isNaN(Date.parse(s))) {
    return null;
  }
  return s;
}
function asId(v: unknown): string | null {
  const s = str(v);
  return s && UUID_RE.test(s) ? s : null;
}

export function normalizeDestinations(body: unknown): { destinations: ThemeParksDestination[] } | null {
  if (!isObj(body) || !Array.isArray(body.destinations)) return null;
  const destinations: ThemeParksDestination[] = [];
  for (const d of body.destinations) {
    if (!isObj(d)) continue;
    const entityId = asId(d.id);
    const name = str(d.name);
    if (!entityId || !name) continue;
    const parks: ThemeParksDestination["parks"] = [];
    if (Array.isArray(d.parks)) {
      for (const p of d.parks) {
        if (!isObj(p)) continue;
        const pid = asId(p.id);
        const pname = str(p.name);
        if (pid && pname) parks.push({ entityId: pid, name: pname });
      }
    }
    destinations.push({ entityId, name, slug: str(d.slug), parks });
  }
  return { destinations };
}

export function normalizeEntity(body: unknown): ThemeParksEntity | null {
  if (!isObj(body)) return null;
  const entityId = asId(body.id);
  const name = str(body.name);
  const entityType = str(body.entityType);
  if (!entityId || !name || !entityType) return null;
  return {
    entityId,
    name,
    entityType,
    timeZone: str(body.timezone),
    parentId: asId(body.parentId),
  };
}

export function normalizeLive(body: unknown): ThemeParksLive | null {
  if (!isObj(body) || !Array.isArray(body.liveData)) return null;
  const entityId = asId(body.id);
  const name = str(body.name);
  if (!entityId || !name) return null;
  const entries: ThemeParksLiveEntry[] = [];
  let droppedEntries = 0;
  let droppedShowtimes = 0;
  for (const e of body.liveData) {
    if (!isObj(e)) { droppedEntries++; continue; }
    const id = asId(e.id);
    const ename = str(e.name);
    const entityType = str(e.entityType);
    if (!id || !ename || !entityType) { droppedEntries++; continue; }
    const showtimes: ThemeParksShowtime[] = [];
    if (Array.isArray(e.showtimes)) {
      for (const s of e.showtimes) {
        const startTime = isObj(s) ? asOffsetTimestamp(s.startTime) : null;
        if (!isObj(s) || !startTime) { droppedShowtimes++; continue; }
        showtimes.push({
          type: str(s.type),
          startTime,
          endTime: asOffsetTimestamp(s.endTime),
        });
      }
    }
    entries.push({
      entityId: id,
      name: ename,
      entityType,
      parkId: asId(e.parkId),
      externalId: str(e.externalId),
      status: str(e.status),
      lastUpdated: asOffsetTimestamp(e.lastUpdated),
      showtimes,
    });
  }
  return {
    entityId,
    name,
    timeZone: str(body.timezone),
    entries,
    droppedEntries,
    droppedShowtimes,
  };
}

function normalizeScheduleEntries(
  raw: unknown,
): { entries: ThemeParksScheduleEntry[]; dropped: number } | null {
  if (!Array.isArray(raw)) return null;
  const entries: ThemeParksScheduleEntry[] = [];
  let dropped = 0;
  for (const s of raw) {
    if (!isObj(s)) { dropped++; continue; }
    const date = str(s.date);
    const type = str(s.type);
    const openingTime = asOffsetTimestamp(s.openingTime);
    const closingTime = asOffsetTimestamp(s.closingTime);
    if (!date || !isValidIsoCalendarDate(date) || !type || !openingTime || !closingTime) {
      dropped++;
      continue;
    }
    entries.push({
      date,
      type,
      openingTime,
      closingTime,
      description: str(s.description),
      lastUpdated: asOffsetTimestamp(s.lastUpdated),
    });
  }
  return { entries, dropped };
}

export function normalizeSchedule(body: unknown): ThemeParksSchedule | null {
  if (!isObj(body)) return null;
  const entityId = asId(body.id);
  const name = str(body.name);
  if (!entityId || !name) return null;
  const timeZone = str(body.timezone);
  const own = body.schedule === undefined ? { entries: [], dropped: 0 } : normalizeScheduleEntries(body.schedule);
  if (!own) return null;
  if (body.schedule === undefined && !Array.isArray(body.parks)) return null;
  let dropped = own.dropped;
  const parks: ThemeParksParkSchedule[] = [];
  if (body.parks !== undefined) {
    if (!Array.isArray(body.parks)) return null;
    for (const p of body.parks) {
      if (!isObj(p)) { dropped++; continue; }
      const pid = asId(p.id);
      const pname = str(p.name);
      const pe = normalizeScheduleEntries(p.schedule);
      if (!pid || !pname || !pe) { dropped++; continue; }
      dropped += pe.dropped;
      parks.push({
        entityId: pid,
        name: pname,
        timeZone: str(p.timezone) ?? timeZone,
        entries: pe.entries,
      });
    }
  }
  return { entityId, name, timeZone, entries: own.entries, parks, droppedEntries: dropped };
}

/** Retry-After (delta-seconds or HTTP-date) → ms; default 60s, clamped 1s–1h. */
export function parseRetryAfterMs(header: string | null, nowMs: number): number {
  const DEFAULT = 60_000;
  const MAX = 3_600_000;
  if (!header) return DEFAULT;
  const t = header.trim();
  let ms: number;
  if (/^\d+$/.test(t)) ms = Number(t) * 1000;
  else {
    const at = Date.parse(t);
    if (Number.isNaN(at)) return DEFAULT;
    ms = at - nowMs;
  }
  return Math.min(MAX, Math.max(1000, ms));
}

// ============================================
// CLIENT
// ============================================

const TTL = {
  static: { fresh: 6 * 3_600_000, maxStale: 7 * 86_400_000 },
  schedule: { fresh: 15 * 60_000, maxStale: 6 * 3_600_000 },
  live: { fresh: 60_000, maxStale: 10 * 60_000 },
} as const;

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CACHE_ENTRIES = 64;

export interface ThemeParksClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  baseUrl?: string;
}

interface CacheEntry {
  data: unknown;
  etag: string | null;
  fetchedAt: number;
  freshUntil: number;
}

type TtlClass = keyof typeof TTL;

export function createThemeParksClient(opts: ThemeParksClientOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = opts.baseUrl ?? THEMEPARKS_API_BASE_URL;

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<ThemeParksResult<unknown>>>();
  let blockedUntil = 0;
  let blockedError: ThemeParksError | null = null;

  function remember(key: string, entry: CacheEntry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function fail<T>(error: ThemeParksError, cached: CacheEntry | undefined, cls: TtlClass): ThemeParksResult<T> {
    // Stale-if-error: real, previously validated provider data, clearly flagged.
    // Not for 404/invalid_request (the data would be wrong, not just old).
    if (
      cached &&
      error.kind !== "not_found" &&
      error.kind !== "invalid_request" &&
      now() - cached.fetchedAt <= TTL[cls].maxStale
    ) {
      return {
        ok: true,
        data: cached.data as T,
        meta: { origin: "stale", fetchedAt: cached.fetchedAt, etag: cached.etag, staleReason: error },
      };
    }
    return { ok: false, error };
  }

  async function network(
    key: string,
    path: string,
    cls: TtlClass,
    normalize: (body: unknown) => unknown | null,
  ): Promise<ThemeParksResult<unknown>> {
    const cached = cache.get(key);
    const t0 = now();
    if (t0 < blockedUntil && blockedError) {
      return fail({ ...blockedError, retryAfterMs: blockedUntil - t0 }, cached, cls);
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "DisneyWaitPlanner/1.0 (+https://dwpapp.com)",
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        headers,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (e) {
      const aborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError");
      return fail(
        aborted
          ? { kind: "timeout", message: `ThemeParks request timed out after ${timeoutMs}ms` }
          : { kind: "network", message: e instanceof Error ? e.message : "network failure" },
        cached,
        cls,
      );
    } finally {
      clearTimeout(timer);
    }

    const t1 = now();
    if (res.status === 304 && cached) {
      const entry = { ...cached, fetchedAt: t1, freshUntil: t1 + TTL[cls].fresh };
      remember(key, entry);
      return { ok: true, data: entry.data, meta: { origin: "revalidated", fetchedAt: t1, etag: entry.etag } };
    }
    if (res.status === 429 || res.status === 503) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), t1);
      const error: ThemeParksError = {
        kind: res.status === 429 ? "rate_limited" : "http",
        message: `ThemeParks HTTP ${res.status}`,
        httpStatus: res.status,
        retryAfterMs,
      };
      blockedUntil = t1 + retryAfterMs;
      blockedError = error;
      return fail(error, cached, cls);
    }
    if (res.status === 404) {
      return fail({ kind: "not_found", message: "ThemeParks entity not found", httpStatus: 404 }, cached, cls);
    }
    if (!res.ok) {
      return fail({ kind: "http", message: `ThemeParks HTTP ${res.status}`, httpStatus: res.status }, cached, cls);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return fail({ kind: "invalid_payload", message: "ThemeParks response was not valid JSON" }, cached, cls);
    }
    const data = normalize(body);
    if (data === null) {
      return fail({ kind: "invalid_payload", message: "ThemeParks response failed validation" }, cached, cls);
    }
    const etag = res.headers.get("etag");
    remember(key, { data, etag, fetchedAt: t1, freshUntil: t1 + TTL[cls].fresh });
    return { ok: true, data, meta: { origin: "network", fetchedAt: t1, etag } };
  }

  function request<T>(
    path: string,
    cls: TtlClass,
    normalize: (body: unknown) => T | null,
  ): Promise<ThemeParksResult<T>> {
    const key = path;
    const cached = cache.get(key);
    if (cached && now() < cached.freshUntil) {
      return Promise.resolve({
        ok: true,
        data: cached.data as T,
        meta: { origin: "cache", fetchedAt: cached.fetchedAt, etag: cached.etag },
      });
    }
    const existing = inflight.get(key);
    if (existing) return existing as Promise<ThemeParksResult<T>>;
    const p = network(key, path, cls, normalize).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, p);
    return p as Promise<ThemeParksResult<T>>;
  }

  const badId = (id: string): ThemeParksError | null =>
    UUID_RE.test(id) ? null : { kind: "invalid_request", message: "ThemeParks entity id must be a UUID" };

  return {
    getDestinations: () => request("/destinations", "static", normalizeDestinations),

    getEntity(entityId: string): Promise<ThemeParksResult<ThemeParksEntity>> {
      const bad = badId(entityId);
      if (bad) return Promise.resolve({ ok: false, error: bad });
      return request(`/entity/${entityId}`, "static", normalizeEntity);
    },

    getLive(entityId: string): Promise<ThemeParksResult<ThemeParksLive>> {
      const bad = badId(entityId);
      if (bad) return Promise.resolve({ ok: false, error: bad });
      return request(`/entity/${entityId}/live`, "live", normalizeLive);
    },

    /** No `month` → provider's upcoming-schedule window. */
    getSchedule(
      entityId: string,
      month?: { year: number; month: number },
    ): Promise<ThemeParksResult<ThemeParksSchedule>> {
      const bad = badId(entityId);
      if (bad) return Promise.resolve({ ok: false, error: bad });
      let suffix = "";
      if (month) {
        const { year, month: m } = month;
        if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(m) || m < 1 || m > 12) {
          return Promise.resolve({ ok: false, error: { kind: "invalid_request", message: "invalid schedule year/month" } });
        }
        suffix = `/${year}/${String(m).padStart(2, "0")}`;
      }
      return request(`/entity/${entityId}/schedule${suffix}`, "schedule", normalizeSchedule);
    },

    /** Checks configured WDW/DLR destination + park UUIDs still exist upstream. */
    async verifyProviderIdentity(): Promise<ThemeParksResult<ThemeParksIdentityReport>> {
      const res = await this.getDestinations();
      if (!res.ok) return res;
      const mismatches: string[] = [];
      for (const [resort, cfg] of Object.entries(THEMEPARKS_DESTINATIONS)) {
        const dest = res.data.destinations.find((d) => d.entityId === cfg.entityId);
        if (!dest) {
          mismatches.push(`${resort}: destination ${cfg.entityId} not in discovery`);
          continue;
        }
        for (const parkId of getThemeParksParkIdsForResort(resort as ResortId)) {
          const park = THEMEPARKS_PARKS[parkId];
          if (!dest.parks.some((p) => p.entityId === park.entityId)) {
            mismatches.push(`${resort}/${parkId}: park ${park.entityId} not under destination in discovery`);
          }
        }
      }
      return { ok: true, data: { ok: mismatches.length === 0, mismatches }, meta: res.meta };
    },

    /** Test/diagnostic hook: drop caches and backoff. */
    _reset() {
      cache.clear();
      inflight.clear();
      blockedUntil = 0;
      blockedError = null;
    },
  };
}

export type ThemeParksClient = ReturnType<typeof createThemeParksClient>;

/** Shared server-instance client (cache + backoff persist across requests). */
export const themeParks: ThemeParksClient = createThemeParksClient();

// ============================================
// DEV VERIFICATION (AGENTS.md convention — manual, not CI)
// ============================================

/**
 * Offline scenarios against a stubbed fetch (no network). Run manually, e.g.
 * via tsx:
 *   import { runDevThemeParksApiCases } from "@/lib/themeParksApi";
 *   console.log(await runDevThemeParksApiCases()); // [] when everything passes
 * Returns the labels of failing cases.
 */
const DEV_PARK = "75ea578a-adc8-4116-a54d-dccb60765ef9";
const DEV_LIVE = {
  id: DEV_PARK, name: "Magic Kingdom Park", timezone: "America/New_York",
  liveData: [
    { id: "a0613b70-293f-4a5b-8169-357be1777c62", name: "Casey's Corner Pianist", entityType: "SHOW", parkId: DEV_PARK,
      externalId: "8074;entityType=Entertainment", status: "OPERATING", lastUpdated: "2026-09-30T04:01:56.507Z",
      queue: { STANDBY: { waitTime: 5 } },
      showtimes: [{ type: "Performance Time", startTime: "2026-09-30T10:50:00-04:00", endTime: "2026-09-30T10:50:00-04:00" },
                  { type: "Performance Time", startTime: "2026-09-30 10:50", endTime: "x" }] },
    { id: "c1f39c15-7845-46b5-b6fd-2ae368a32a37", name: "Closed Show", entityType: "SHOW", parkId: DEV_PARK, status: "CLOSED", showtimes: [] },
    { name: "no id" },
  ],
};
const DEV_SCHEDULE = {
  id: DEV_PARK, name: "Magic Kingdom Park", timezone: "America/New_York",
  schedule: [
    { date: "2026-09-30", type: "TICKETED_EVENT", description: "Early Entry", openingTime: "2026-09-30T08:30:00-04:00", closingTime: "2026-09-30T09:00:00-04:00",
      purchases: [{ id: "x", price: { amount: 1 } }] },
    { date: "2026-09-30", type: "OPERATING", openingTime: "2026-09-30T09:00:00-04:00", closingTime: "2026-09-30T22:00:00-04:00" },
    { date: "2026-02-30", type: "OPERATING", openingTime: "2026-02-30T09:00:00-04:00", closingTime: "2026-02-30T22:00:00-04:00" },
    { date: "2026-10-01", type: "OPERATING", openingTime: "2026-10-01T09:00:00", closingTime: "2026-10-01T22:00:00-04:00" },
  ],
};

function devRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), { status, headers });
}

export async function runDevThemeParksApiCases(): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  let t = 1_000_000;
  const mk = (handler: (url: string, init: RequestInit) => Promise<Response> | Response, extra: Partial<ThemeParksClientOptions> = {}) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createThemeParksClient({
      now: () => t,
      fetchImpl: (async (u: unknown, init?: RequestInit) => { calls.push({ url: String(u), init: init ?? {} }); return handler(String(u), init ?? {}); }) as typeof fetch,
      ...extra,
    });
    return { client, calls };
  };

  // Normalization: preserves ids/offsets/types/lastUpdated, drops raw extras + malformed.
  const live = normalizeLive(DEV_LIVE);
  check("live: keeps valid entry, drops idless", live?.entries.length === 2 && live.droppedEntries === 1);
  check("live: preserves offset timestamp verbatim", live?.entries[0].showtimes[0].startTime === "2026-09-30T10:50:00-04:00");
  check("live: drops offset-less showtime", live?.entries[0].showtimes.length === 1 && live.droppedShowtimes === 1);
  check("live: preserves lastUpdated/type/uuid", live?.entries[0].lastUpdated === "2026-09-30T04:01:56.507Z" && live.entries[0].showtimes[0].type === "Performance Time" && live.entries[0].parkId === DEV_PARK);
  check("live: raw queue not leaked", !("queue" in (live?.entries[0] ?? {})));
  check("live: valid-empty stays ok", normalizeLive({ ...DEV_LIVE, liveData: [] })?.entries.length === 0);
  check("live: missing liveData invalid", normalizeLive({ id: DEV_PARK, name: "x" }) === null);
  const sch = normalizeSchedule(DEV_SCHEDULE);
  check("schedule: keeps 2 valid, drops bad date + offset-less", sch?.entries.length === 2 && sch.droppedEntries === 2);
  check("schedule: type/description preserved, purchases dropped", sch?.entries[0].type === "TICKETED_EVENT" && sch.entries[0].description === "Early Entry" && !("purchases" in (sch?.entries[0] ?? {})));
  check("schedule: valid-empty ok", normalizeSchedule({ ...DEV_SCHEDULE, schedule: [] })?.entries.length === 0);
  check("schedule: garbage invalid", normalizeSchedule({ id: DEV_PARK, name: "x" }) === null && normalizeSchedule([]) === null);
  const dsch = normalizeSchedule({ id: THEMEPARKS_DESTINATIONS.WDW.entityId, name: "WDW", timezone: "America/New_York", parks: [{ id: DEV_PARK, name: "MK", timezone: null, schedule: DEV_SCHEDULE.schedule }] });
  check("schedule: destination parks inherit zone", dsch?.parks[0].timeZone === "America/New_York" && dsch.parks[0].entries.length === 2);
  check("retry-after seconds/date/default/clamp",
    parseRetryAfterMs("30", 0) === 30_000 && parseRetryAfterMs(new Date(90_000).toUTCString(), 0) === 90_000 &&
    parseRetryAfterMs(null, 0) === 60_000 && parseRetryAfterMs("999999", 0) === 3_600_000 && parseRetryAfterMs("0", 0) === 1000);

  // Request validation: no network for bad ids/months.
  { const { client, calls } = mk(() => devRes(200, {}));
    const r = await client.getLive("../etc");
    const m = await client.getSchedule(DEV_PARK, { year: 2026, month: 13 });
    check("invalid ids/months rejected without fetch", !r.ok && r.error.kind === "invalid_request" && !m.ok && calls.length === 0); }

  // Cache + in-flight dedupe + valid-empty vs failure.
  { const { client, calls } = mk(async () => devRes(200, { ...DEV_LIVE, liveData: [] }, { etag: 'W/"a"' }));
    const [a, b] = await Promise.all([client.getLive(DEV_PARK), client.getLive(DEV_PARK)]);
    check("dedupe: concurrent calls share one fetch", calls.length === 1 && a.ok && b.ok);
    const c = await client.getLive(DEV_PARK);
    check("cache: fresh hit, no fetch; valid-empty is ok", calls.length === 1 && c.ok && c.meta.origin === "cache" && c.data.entries.length === 0);
    check("live path uses /live", calls[0].url.endsWith(`/entity/${DEV_PARK}/live`)); }

  // ETag revalidation (304) after TTL.
  { let n = 0;
    const { client, calls } = mk((_u, init) => (n++ === 0 ? devRes(200, DEV_SCHEDULE, { etag: 'W/"s"' }) : devRes(304, null)));
    await client.getSchedule(DEV_PARK, { year: 2026, month: 10 });
    t += TTL.schedule.fresh + 1;
    const r = await client.getSchedule(DEV_PARK, { year: 2026, month: 10 });
    const inm = (calls[1].init.headers as Record<string, string>)["If-None-Match"];
    check("etag: If-None-Match sent, 304 revalidates", inm === 'W/"s"' && r.ok && r.meta.origin === "revalidated" && r.data.entries.length === 2);
    check("schedule month path", calls[0].url.endsWith(`/entity/${DEV_PARK}/schedule/2026/10`)); }

  // 429 + Retry-After: backoff blocks network; failure w/o cache is an error (no fabrication).
  { const { client, calls } = mk(() => devRes(429, {}, { "retry-after": "120" }));
    const r = await client.getLive(DEV_PARK);
    const r2 = await client.getSchedule(DEV_PARK);
    check("429: rate_limited with retryAfterMs", !r.ok && r.error.kind === "rate_limited" && r.error.retryAfterMs === 120_000);
    check("429: backoff blocks further calls", !r2.ok && r2.error.kind === "rate_limited" && calls.length === 1);
    t += 121_000; await client.getLive(DEV_PARK);
    check("429: calls resume after Retry-After", calls.length === 2); }

  // Stale-if-error is flagged and bounded.
  { let fail = false;
    const { client } = mk(() => (fail ? devRes(500, {}) : devRes(200, DEV_LIVE)));
    await client.getLive(DEV_PARK); fail = true; t += TTL.live.fresh + 1;
    const s = await client.getLive(DEV_PARK);
    check("stale-if-error flagged", s.ok && s.meta.origin === "stale" && s.meta.staleReason?.kind === "http");
    t += TTL.live.maxStale + 1;
    const g = await client.getLive(DEV_PARK);
    check("stale beyond max age → error", !g.ok && g.error.kind === "http"); }

  // Failure taxonomy.
  { const { client } = mk(() => devRes(404, {}));
    const r = await client.getEntity(DEV_PARK); check("404 → not_found", !r.ok && r.error.kind === "not_found"); }
  { const { client } = mk(() => devRes(200, { nope: true }));
    const r = await client.getLive(DEV_PARK); check("bad shape → invalid_payload", !r.ok && r.error.kind === "invalid_payload"); }
  { const { client } = mk(() => new Response("<html>", { status: 200 }));
    const r = await client.getLive(DEV_PARK); check("non-JSON → invalid_payload", !r.ok && r.error.kind === "invalid_payload"); }
  { const { client } = mk(() => { throw new TypeError("boom"); });
    const r = await client.getLive(DEV_PARK); check("throw → network", !r.ok && r.error.kind === "network"); }
  { const { client } = mk((_u, init) => new Promise<Response>((_res, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))), { timeoutMs: 20 });
    const r = await client.getLive(DEV_PARK); check("hang → timeout", !r.ok && r.error.kind === "timeout"); }

  // Provider identity covers WDW + DLR destinations and every park.
  { const dests = (Object.values(THEMEPARKS_DESTINATIONS) as Array<{ entityId: string; slug: string; providerName: string }>).map((d) => ({
      id: d.entityId, name: d.providerName, slug: d.slug,
      parks: (Object.entries(THEMEPARKS_PARKS) as Array<[ParkId, { entityId: string; providerName: string }]>)
        .filter(([p]) => getThemeParksParkIdsForResort(d.slug === "disneylandresort" ? "DLR" : "WDW").includes(p))
        .map(([, p]) => ({ id: p.entityId, name: p.providerName })) }));
    const { client } = mk(() => devRes(200, { destinations: dests }));
    const ok = await client.verifyProviderIdentity();
    check("identity: WDW+DLR ids match discovery", ok.ok && ok.data.ok && ok.data.mismatches.length === 0);
    const { client: c2 } = mk(() => devRes(200, { destinations: [] }));
    const bad = await c2.verifyProviderIdentity();
    check("identity: drift reported", bad.ok && !bad.data.ok && bad.data.mismatches.length === 2); }
  return failures;
}

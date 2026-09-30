/**
 * themeParksApi.ts — isolated, SERVER-SIDE ThemeParks.wiki (Free API) client.
 *
 * Provider boundary for Phase 12 showtime/schedule work. Queue-Times stays
 * the attraction wait provider (liveWaitApi.ts, untouched); DWP's catalog
 * stays the canonical identity authority. ThemeParks UUIDs are integration
 * metadata (themeParksProviders.ts). SERVER-ONLY: `import "server-only"`
 * (Next.js pattern) makes a Client Component import fail at build time; later
 * consumers reach this through a DWP route/server component.
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

import "server-only";
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
  /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}
/**
 * Offset-aware (or Z) ISO timestamp with in-range time/offset fields and a
 * real calendar date (Date.parse alone would roll 2026-02-30 into March);
 * returned verbatim, else null.
 */
export function asOffsetTimestamp(v: unknown): string | null {
  const s = str(v);
  const m = s ? OFFSET_TIMESTAMP_RE.exec(s) : null;
  if (!s || !m || !isValidIsoCalendarDate(m[1]) || Number.isNaN(Date.parse(s))) {
    return null;
  }
  return s;
}
/** Valid UUID, canonicalized to lowercase so identity comparison is case-stable. */
function asId(v: unknown): string | null {
  const s = str(v);
  return s && UUID_RE.test(s) ? s.toLowerCase() : null;
}

/**
 * Shared optional-field rule for values that carry identity or time/freshness
 * meaning. Absent (`undefined`) or explicit `null` is allowed and yields
 * `null`; a supplied value that fails `parse` yields `INVALID` so the caller
 * rejects the containing record instead of silently degrading it to "absent".
 * Low-impact metadata (names, descriptions, status, zone, externalId, showtime
 * `type`) intentionally stays permissive via plain `str()`.
 */
const INVALID = Symbol("invalid");
function optionalField<T>(raw: unknown, parse: (v: unknown) => T | null): T | null | typeof INVALID {
  if (raw === undefined || raw === null) return null;
  const parsed = parse(raw);
  return parsed === null ? INVALID : parsed;
}

export function normalizeDestinations(body: unknown): { destinations: ThemeParksDestination[] } | null {
  if (!isObj(body) || !Array.isArray(body.destinations)) return null;
  const destinations: ThemeParksDestination[] = [];
  for (const d of body.destinations) {
    if (!isObj(d)) continue;
    const entityId = asId(d.id);
    const name = str(d.name);
    if (!entityId || !name) continue;
    // Provider contract: every destination carries a `parks` array. Missing /
    // non-array, or non-empty with zero valid parks, is schema drift: the
    // destination is invalid (never a silent `parks: []`). Empty = valid-empty.
    if (!Array.isArray(d.parks)) continue;
    const parks: ThemeParksDestination["parks"] = [];
    for (const p of d.parks) {
      if (!isObj(p)) continue;
      const pid = asId(p.id);
      const pname = str(p.name);
      if (pid && pname) parks.push({ entityId: pid, name: pname });
    }
    if (d.parks.length > 0 && parks.length === 0) continue;
    destinations.push({ entityId, name, slug: str(d.slug), parks });
  }
  // Non-empty provider array with zero valid entries = schema drift, not empty data.
  if (body.destinations.length > 0 && destinations.length === 0) return null;
  return { destinations };
}

export function normalizeEntity(body: unknown): ThemeParksEntity | null {
  if (!isObj(body)) return null;
  const entityId = asId(body.id);
  const name = str(body.name);
  const entityType = str(body.entityType);
  if (!entityId || !name || !entityType) return null;
  const parentId = optionalField(body.parentId, asId);
  if (parentId === INVALID) return null;
  return {
    entityId,
    name,
    entityType,
    timeZone: str(body.timezone),
    parentId,
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
    // `showtimes` is optional (absent/undefined for most non-show entities),
    // but when explicitly present — including `null` — it must be an array. Empty = valid-empty; partially valid keeps
    // the valid showtimes (dropped ones counted); non-empty with zero valid
    // showtimes (or a non-array value) is schema drift, so the ENTRY is
    // rejected rather than cached as `showtimes: []`. If that leaves no valid
    // entries the whole payload fails (invalid_payload → stale-if-error).
    const showtimes: ThemeParksShowtime[] = [];
    let entryDroppedShowtimes = 0;
    if (e.showtimes !== undefined) {
      if (!Array.isArray(e.showtimes)) { droppedEntries++; continue; }
      for (const s of e.showtimes) {
        const startTime = isObj(s) ? asOffsetTimestamp(s.startTime) : null;
        const endTime = isObj(s) ? optionalField(s.endTime, asOffsetTimestamp) : null;
        if (!isObj(s) || !startTime || endTime === INVALID) { entryDroppedShowtimes++; continue; }
        showtimes.push({ type: str(s.type), startTime, endTime });
      }
      if (e.showtimes.length > 0 && showtimes.length === 0) { droppedEntries++; continue; }
    }
    // Identity/freshness fields: absent/null ok, malformed supplied value rejects the entry.
    const parkId = optionalField(e.parkId, asId);
    const lastUpdated = optionalField(e.lastUpdated, asOffsetTimestamp);
    if (parkId === INVALID || lastUpdated === INVALID) { droppedEntries++; continue; }
    droppedShowtimes += entryDroppedShowtimes;
    entries.push({
      entityId: id,
      name: ename,
      entityType,
      parkId,
      externalId: str(e.externalId),
      status: str(e.status),
      lastUpdated,
      showtimes,
    });
  }
  // Genuinely empty liveData is valid-empty; non-empty with zero valid entries is not.
  if (body.liveData.length > 0 && entries.length === 0) return null;
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
    const lastUpdated = optionalField(s.lastUpdated, asOffsetTimestamp);
    // The entry's `date` must be the resort-local calendar date its opening
    // starts on (timestamps keep their own offset, so the date part is the
    // local date). closingTime may legitimately fall on a later date
    // (past-midnight closes), so it is deliberately not compared.
    if (
      !date || !isValidIsoCalendarDate(date) || !type || !openingTime || !closingTime ||
      lastUpdated === INVALID || openingTime.slice(0, 10) !== date
    ) {
      dropped++;
      continue;
    }
    entries.push({
      date,
      type,
      openingTime,
      closingTime,
      description: str(s.description),
      lastUpdated,
    });
  }
  // Empty array is valid-empty; non-empty with zero valid entries is invalid.
  if (raw.length > 0 && entries.length === 0) return null;
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
    if (body.parks.length > 0 && parks.length === 0) return null;
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

  /**
   * The abort timer spans the whole exchange — headers AND body consumption —
   * so a stalled body resolves as a typed timeout (with stale-if-error) and
   * never leaves the in-flight dedupe entry hanging.
   */
  async function network(
    key: string,
    path: string,
    cls: TtlClass,
    normalize: (body: unknown) => unknown | null,
  ): Promise<ThemeParksResult<unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await networkOnce(key, path, cls, normalize, controller);
    } finally {
      clearTimeout(timer);
    }
  }

  async function networkOnce(
    key: string,
    path: string,
    cls: TtlClass,
    normalize: (body: unknown) => unknown | null,
    controller: AbortController,
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

    // Rejects on abort so a stalled fetch/body settles even if the underlying
    // stream ignores the signal.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    aborted.catch(() => {});
    const timeoutError = (): ThemeParksError => ({
      kind: "timeout",
      message: `ThemeParks request timed out after ${timeoutMs}ms`,
    });

    let res: Response;
    try {
      res = await Promise.race([
        fetchImpl(`${baseUrl}${path}`, {
          headers,
          signal: controller.signal,
          cache: "no-store",
        }),
        aborted,
      ]);
    } catch (e) {
      const wasAborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError");
      return fail(
        wasAborted
          ? timeoutError()
          : { kind: "network", message: e instanceof Error ? e.message : "network failure" },
        cached,
        cls,
      );
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
      body = await Promise.race([res.json(), aborted]);
    } catch {
      if (controller.signal.aborted) return fail(timeoutError(), cached, cls);
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

  /** Response must describe the entity DWP asked for, else invalid_payload (never cached under that key). */
  const forEntity =
    <T extends { entityId: string }>(requested: string, normalize: (body: unknown) => T | null) =>
    (body: unknown): T | null => {
      const data = normalize(body);
      return data && data.entityId === requested ? data : null;
    };

  const badId = (id: string): ThemeParksError | null =>
    UUID_RE.test(id) ? null : { kind: "invalid_request", message: "ThemeParks entity id must be a UUID" };

  return {
    getDestinations: () => request("/destinations", "static", normalizeDestinations),

    getEntity(requestedId: string): Promise<ThemeParksResult<ThemeParksEntity>> {
      const bad = badId(requestedId);
      if (bad) return Promise.resolve({ ok: false, error: bad });
      const entityId = requestedId.toLowerCase(); // canonical: one cache key + identity compare per entity
      return request(`/entity/${entityId}`, "static", forEntity(entityId, normalizeEntity));
    },

    getLive(requestedId: string): Promise<ThemeParksResult<ThemeParksLive>> {
      const bad = badId(requestedId);
      if (bad) return Promise.resolve({ ok: false, error: bad });
      const entityId = requestedId.toLowerCase(); // canonical: one cache key + identity compare per entity
      return request(`/entity/${entityId}/live`, "live", forEntity(entityId, normalizeLive));
    },

    /** No `month` → provider's upcoming-schedule window. */
    getSchedule(
      requestedId: string,
      month?: { year: number; month: number },
    ): Promise<ThemeParksResult<ThemeParksSchedule>> {
      const bad = badId(requestedId);
      if (bad) return Promise.resolve({ ok: false, error: bad });
      const entityId = requestedId.toLowerCase(); // canonical: one cache key + identity compare per entity
      let suffix = "";
      if (month) {
        const { year, month: m } = month;
        if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(m) || m < 1 || m > 12) {
          return Promise.resolve({ ok: false, error: { kind: "invalid_request", message: "invalid schedule year/month" } });
        }
        suffix = `/${year}/${String(m).padStart(2, "0")}`;
      }
      return request(`/entity/${entityId}/schedule${suffix}`, "schedule", forEntity(entityId, normalizeSchedule));
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
 * via tsx with the react-server condition (so `server-only` is inert):
 *   NODE_OPTIONS=--conditions=react-server npx tsx script.ts
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
  // Array contract: empty => valid-empty; some valid => ok + dropped; non-empty, zero valid => invalid.
  const junk = [{ nope: 1 }, "x", null];
  const goodDest = { id: THEMEPARKS_DESTINATIONS.WDW.entityId, name: "WDW", slug: "wdw", parks: [] };
  check("destinations: empty array valid-empty", normalizeDestinations({ destinations: [] })?.destinations.length === 0);
  check("destinations: partial malformed ok", normalizeDestinations({ destinations: [goodDest, ...junk] })?.destinations.length === 1);
  check("destinations: wholly malformed invalid", normalizeDestinations({ destinations: junk }) === null);
  check("live: partial malformed ok", normalizeLive({ ...DEV_LIVE, liveData: [DEV_LIVE.liveData[1], ...junk] })?.entries.length === 1);
  check("live: wholly malformed invalid", normalizeLive({ ...DEV_LIVE, liveData: junk }) === null);
  check("schedule: wholly malformed invalid", normalizeSchedule({ ...DEV_SCHEDULE, schedule: junk }) === null
    && normalizeSchedule({ ...DEV_SCHEDULE, schedule: [DEV_SCHEDULE.schedule[2], DEV_SCHEDULE.schedule[3]] }) === null);
  const destDoc = (parks: unknown[]) => ({ id: THEMEPARKS_DESTINATIONS.WDW.entityId, name: "WDW", timezone: "America/New_York", parks });
  check("schedule: destination parks empty valid-empty", normalizeSchedule(destDoc([]))?.parks.length === 0);
  check("schedule: destination park wholly malformed schedule dropped, others kept",
    normalizeSchedule(destDoc([{ id: DEV_PARK, name: "MK", schedule: DEV_SCHEDULE.schedule }, { id: THEMEPARKS_PARKS.hs.entityId, name: "HS", schedule: junk }]))?.parks.length === 1);
  check("schedule: destination parks all malformed invalid",
    normalizeSchedule(destDoc([{ id: DEV_PARK, name: "MK", schedule: junk }, ...junk])) === null);
  // Timestamp validation: calendar-impossible dates rejected; valid offset/Z kept verbatim.
  check("timestamp: valid offset + Z preserved verbatim",
    asOffsetTimestamp("2026-09-30T10:50:00-04:00") === "2026-09-30T10:50:00-04:00" &&
    asOffsetTimestamp("2026-09-30T04:01:56.507Z") === "2026-09-30T04:01:56.507Z" &&
    asOffsetTimestamp("2028-02-29T09:00:00-08:00") === "2028-02-29T09:00:00-08:00");
  check("timestamp: calendar-impossible dates rejected",
    asOffsetTimestamp("2026-02-30T10:00:00-04:00") === null && asOffsetTimestamp("2026-13-01T10:00:00Z") === null &&
    asOffsetTimestamp("2026-04-31T10:00:00Z") === null && asOffsetTimestamp("2027-02-29T10:00:00Z") === null);
  check("timestamp: out-of-range time/offset + offset-less rejected",
    asOffsetTimestamp("2026-09-30T24:00:00-04:00") === null && asOffsetTimestamp("2026-09-30T10:60:00Z") === null &&
    asOffsetTimestamp("2026-09-30T10:00:00+25:00") === null && asOffsetTimestamp("2026-09-30T10:00:00") === null);
  check("schedule: impossible-date timestamp entry dropped",
    normalizeSchedule({ ...DEV_SCHEDULE, schedule: [DEV_SCHEDULE.schedule[1], { date: "2026-10-02", type: "OPERATING", openingTime: "2026-02-30T09:00:00-04:00", closingTime: "2026-10-02T22:00:00-04:00" }] })?.entries.length === 1);
  check("live: impossible-date showtime dropped",
    normalizeLive({ ...DEV_LIVE, liveData: [{ ...DEV_LIVE.liveData[0], showtimes: [{ type: "P", startTime: "2026-02-30T10:00:00-04:00" }, { type: "P", startTime: "2026-09-30T10:00:00-04:00" }] }] })?.entries[0].showtimes.length === 1);

  // Nested showtimes: empty valid-empty; partial keeps valid + counts dropped; wholly malformed rejects the entry/payload.
  const showEntry = (showtimes: unknown) => ({ ...DEV_LIVE.liveData[0], showtimes });
  const goodShowtime = { type: "Performance Time", startTime: "2026-09-30T10:50:00-04:00", endTime: "2026-09-30T10:50:00-04:00" };
  const badShowtimes = [{ type: "P", startTime: "2026-02-30T10:00:00-04:00" }, { type: "P" }, "x", null];
  const liveWith = (...entries: unknown[]) => normalizeLive({ ...DEV_LIVE, liveData: entries });
  { const r = liveWith(showEntry([]));
    check("showtimes: empty array valid-empty", r?.entries.length === 1 && r.entries[0].showtimes.length === 0 && r.droppedShowtimes === 0 && r.droppedEntries === 0); }
  check("showtimes: absent valid-empty", liveWith({ ...DEV_LIVE.liveData[0], showtimes: undefined })?.entries[0].showtimes.length === 0);
  { const r = liveWith(showEntry([goodShowtime, ...badShowtimes]));
    check("showtimes: partial keeps valid, counts dropped", r?.entries[0].showtimes.length === 1 && r.droppedShowtimes === 4 && r.droppedEntries === 0); }
  { const r = liveWith(showEntry(badShowtimes), DEV_LIVE.liveData[1]);
    check("showtimes: wholly malformed rejects entry, others kept",
      r?.entries.length === 1 && r.entries[0].name === "Closed Show" && r.droppedEntries === 1 && r.droppedShowtimes === 0); }
  check("showtimes: explicit null rejects entry (not silently empty)", liveWith(showEntry(null), DEV_LIVE.liveData[1])?.entries.length === 1 && liveWith(showEntry(null)) === null);
  check("showtimes: non-array value rejects entry", liveWith(showEntry("10:50 AM"), DEV_LIVE.liveData[1])?.entries.length === 1);
  check("showtimes: only entry wholly malformed → payload invalid", liveWith(showEntry(badShowtimes)) === null);
  // Shared optional-field rule: absent/null ok; malformed supplied value rejects the record.
  const UP = DEV_PARK.toUpperCase();
  const SHOW_ID = "a0613b70-293f-4a5b-8169-357be1777c62";
  const st = (extra: Record<string, unknown>) => ({ ...goodShowtime, ...extra });
  check("uuid: asId output lowercased (live entry + park ids)",
    liveWith({ ...DEV_LIVE.liveData[0], id: SHOW_ID.toUpperCase(), parkId: UP })?.entries[0].parkId === DEV_PARK &&
    liveWith({ ...DEV_LIVE.liveData[0], id: SHOW_ID.toUpperCase() })?.entries[0].entityId === SHOW_ID);
  check("uuid: discovery ids lowercased", normalizeDestinations({ destinations: [{ ...goodDest, id: goodDest.id.toUpperCase() }] })?.destinations[0].entityId === goodDest.id);
  check("endTime: absent and null allowed", ((r) => r?.entries[0].showtimes.length === 2 && r.entries[0].showtimes.every((x) => x.endTime === null))(
    liveWith(showEntry([{ startTime: goodShowtime.startTime }, st({ endTime: null })]))));
  check("endTime: valid preserved verbatim", liveWith(showEntry([goodShowtime]))?.entries[0].showtimes[0].endTime === goodShowtime.endTime);
  { const r = liveWith(showEntry([goodShowtime, st({ endTime: "2026-02-30T10:00:00-04:00" }), st({ endTime: "soon" }), st({ endTime: 5 }), st({ endTime: "" })]));
    check("endTime: malformed non-null drops the showtime (partial)", r?.entries[0].showtimes.length === 1 && r.droppedShowtimes === 4); }
  check("endTime: all showtimes malformed endTime → entry rejected, payload invalid",
    liveWith(showEntry([st({ endTime: "soon" })])) === null && liveWith(showEntry([st({ endTime: "soon" })]), DEV_LIVE.liveData[1])?.entries.length === 1);
  check("lastUpdated: absent/null allowed", liveWith({ ...DEV_LIVE.liveData[0], lastUpdated: null }, { ...DEV_LIVE.liveData[1] })?.entries.length === 2);
  check("lastUpdated: malformed supplied rejects live entry", liveWith({ ...DEV_LIVE.liveData[0], lastUpdated: "yesterday" }, DEV_LIVE.liveData[1])?.entries.length === 1);
  check("parkId: absent/null allowed; malformed supplied rejects entry",
    liveWith({ ...DEV_LIVE.liveData[0], parkId: null }, { ...DEV_LIVE.liveData[1], parkId: undefined })?.entries.length === 2 &&
    liveWith({ ...DEV_LIVE.liveData[0], parkId: "not-a-uuid" }, DEV_LIVE.liveData[1])?.entries.length === 1 &&
    liveWith({ ...DEV_LIVE.liveData[0], parkId: "" }) === null);
  const entDoc = { id: DEV_PARK, name: "MK", entityType: "PARK", timezone: "America/New_York" };
  check("parentId: absent/null allowed; malformed supplied rejects entity",
    normalizeEntity(entDoc)?.parentId === null && normalizeEntity({ ...entDoc, parentId: null })?.parentId === null &&
    normalizeEntity({ ...entDoc, parentId: THEMEPARKS_DESTINATIONS.WDW.entityId.toUpperCase() })?.parentId === THEMEPARKS_DESTINATIONS.WDW.entityId &&
    normalizeEntity({ ...entDoc, parentId: "bogus" }) === null);
  check("schedule lastUpdated: absent/null allowed, malformed drops entry",
    normalizeSchedule({ ...DEV_SCHEDULE, schedule: [{ ...DEV_SCHEDULE.schedule[1], lastUpdated: null }, { ...DEV_SCHEDULE.schedule[1], lastUpdated: "2026-09-30T04:01:56.507Z" }, { ...DEV_SCHEDULE.schedule[1], lastUpdated: "bad" }] })?.entries.length === 2);
  check("permissive metadata stays permissive (status/externalId/timezone/type)",
    ((r) => r?.entries[0].status === null && r.entries[0].externalId === null && r.timeZone === null)(liveWith({ ...DEV_LIVE.liveData[0], status: 5, externalId: 7 }) && normalizeLive({ ...DEV_LIVE, timezone: 3, liveData: [{ ...DEV_LIVE.liveData[0], status: 5, externalId: 7 }] })));

  // Schedule date must equal the calendar-date portion of openingTime; closingTime may cross midnight.
  { const base = { type: "OPERATING", openingTime: "2026-09-30T09:00:00-04:00", closingTime: "2026-09-30T22:00:00-04:00" };
    const sched = (...schedule: unknown[]) => normalizeSchedule({ ...DEV_SCHEDULE, schedule });
    check("schedule: date matches openingTime date accepted", sched({ ...base, date: "2026-09-30" })?.entries.length === 1);
    check("schedule: date ≠ openingTime date rejected (partial keeps others)",
      ((r) => r?.entries.length === 1 && r.droppedEntries === 1)(sched({ ...base, date: "2026-09-30" }, { ...base, date: "2026-10-01" })));
    check("schedule: only mismatched entries → payload invalid", sched({ ...base, date: "2026-10-01" }) === null);
    check("schedule: closingTime crossing midnight accepted",
      sched({ ...base, date: "2026-09-30", closingTime: "2026-10-01T01:00:00-04:00" })?.entries[0].closingTime === "2026-10-01T01:00:00-04:00");
    check("schedule: Z-suffixed openingTime compares on its own date part", sched({ ...base, date: "2026-09-30", openingTime: "2026-09-30T13:00:00Z", closingTime: "2026-10-01T02:00:00Z" })?.entries.length === 1);
    const destMix = normalizeSchedule(destDoc([{ id: DEV_PARK, name: "MK", schedule: [{ ...base, date: "2026-09-30" }] }, { id: THEMEPARKS_PARKS.hs.entityId, name: "HS", schedule: [{ ...base, date: "2026-10-05" }] }]));
    check("schedule: destination park with only mismatched dates dropped, others kept", destMix?.parks.length === 1 && destMix.parks[0].entityId === DEV_PARK); }
  // Nested discovery parks: empty valid-empty; partial retained; non-empty zero-valid / missing / non-array invalid.
  const destWith = (parks: unknown) => ({ id: THEMEPARKS_DESTINATIONS.WDW.entityId, name: "WDW", slug: "wdw", ...(parks === undefined ? {} : { parks }) });
  const goodPark = { id: DEV_PARK, name: "MK" };
  check("discovery parks: empty array valid-empty", normalizeDestinations({ destinations: [destWith([])] })?.destinations[0].parks.length === 0);
  check("discovery parks: partial malformed retains valid", normalizeDestinations({ destinations: [destWith([goodPark, ...junk])] })?.destinations[0].parks.length === 1);
  check("discovery parks: non-empty zero-valid → invalid", normalizeDestinations({ destinations: [destWith(junk)] }) === null);
  check("discovery parks: missing → invalid", normalizeDestinations({ destinations: [destWith(undefined)] }) === null);
  check("discovery parks: non-array → invalid", normalizeDestinations({ destinations: [destWith("parks")] }) === null);
  check("discovery parks: one bad destination dropped, others kept",
    normalizeDestinations({ destinations: [destWith(junk), { ...destWith([goodPark]), id: THEMEPARKS_DESTINATIONS.DLR.entityId }] })?.destinations.length === 1);

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

  // Wholly malformed refresh must not overwrite valid cache with an empty success.
  { let bad = false;
    const { client } = mk(() => devRes(200, bad ? { ...DEV_LIVE, liveData: [{ nope: 1 }] } : DEV_LIVE));
    await client.getLive(DEV_PARK); bad = true; t += TTL.live.fresh + 1;
    const s = await client.getLive(DEV_PARK);
    check("malformed refresh → stale valid data, not empty success",
      s.ok && s.meta.origin === "stale" && s.meta.staleReason?.kind === "invalid_payload" && s.data.entries.length === 2);
    const after = await client.getLive(DEV_PARK);
    check("malformed refresh did not replace cache", after.ok && after.data.entries.length === 2 && after.meta.origin === "stale");
    t += TTL.live.maxStale + 1;
    const g = await client.getLive(DEV_PARK);
    check("malformed refresh past max stale → invalid_payload", !g.ok && g.error.kind === "invalid_payload"); }
  { const { client } = mk(() => devRes(200, { ...DEV_LIVE, liveData: [{ nope: 1 }] }));
    const r = await client.getLive(DEV_PARK);
    check("malformed with no cache → invalid_payload failure", !r.ok && r.error.kind === "invalid_payload"); }
  { const { client } = mk(() => devRes(200, { destinations: [{ nope: 1 }] }));
    const r = await client.getDestinations();
    check("malformed discovery → invalid_payload", !r.ok && r.error.kind === "invalid_payload"); }

  // Nested-parks drift must not replace a previously validated discovery cache.
  { let drift = false;
    const okDests = { destinations: [{ id: THEMEPARKS_DESTINATIONS.WDW.entityId, name: "WDW", slug: "wdw", parks: [{ id: DEV_PARK, name: "MK" }] }] };
    const { client } = mk(() => devRes(200, drift ? { destinations: [{ ...okDests.destinations[0], parks: [{ nope: 1 }] }] } : okDests));
    await client.getDestinations(); drift = true; t += TTL.static.fresh + 1;
    const r = await client.getDestinations();
    check("parks drift → stale valid discovery, not empty parks",
      r.ok && r.meta.origin === "stale" && r.meta.staleReason?.kind === "invalid_payload" && r.data.destinations[0].parks.length === 1); }

  // Showtime schema drift must not replace previously validated showtimes with an empty success.
  { let drift = false;
    const driftLive = { ...DEV_LIVE, liveData: [{ ...DEV_LIVE.liveData[0], showtimes: [{ type: "Performance Time", startTime: 1785000000 }] }] };
    const { client } = mk(() => devRes(200, drift ? driftLive : { ...DEV_LIVE, liveData: [DEV_LIVE.liveData[0]] }));
    await client.getLive(DEV_PARK); drift = true; t += TTL.live.fresh + 1;
    const r = await client.getLive(DEV_PARK);
    check("showtime drift → stale showtimes preserved, not empty success",
      r.ok && r.meta.origin === "stale" && r.meta.staleReason?.kind === "invalid_payload" && r.data.entries[0].showtimes.length === 1);
    t += TTL.live.maxStale + 1;
    const g = await client.getLive(DEV_PARK);
    check("showtime drift past max stale → invalid_payload", !g.ok && g.error.kind === "invalid_payload"); }
  { let drift = false;
    const { client } = mk(() => devRes(200, { ...DEV_LIVE, liveData: [drift ? { ...DEV_LIVE.liveData[0], showtimes: null } : DEV_LIVE.liveData[0]] }));
    await client.getLive(DEV_PARK); drift = true; t += TTL.live.fresh + 1;
    const r = await client.getLive(DEV_PARK);
    check("showtimes: null refresh → stale showtimes preserved, not empty success",
      r.ok && r.meta.origin === "stale" && r.meta.staleReason?.kind === "invalid_payload" && r.data.entries[0].showtimes.length === 1); }
  { const { client } = mk(() => devRes(200, { ...DEV_LIVE, liveData: [{ ...DEV_LIVE.liveData[0], showtimes: [{ type: "P", startTime: "bad" }] }] }));
    const r = await client.getLive(DEV_PARK);
    check("showtime drift with no cache → invalid_payload failure", !r.ok && r.error.kind === "invalid_payload"); }

  // Requested-entity identity: response id must equal the requested UUID.
  const OTHER_PARK = THEMEPARKS_PARKS.hs.entityId;
  { const { client, calls } = mk(() => devRes(200, DEV_LIVE));
    const r = await client.getLive(DEV_PARK.toUpperCase());
    check("identity: matching response id accepted (case-insensitive)", r.ok && r.data.entityId === DEV_PARK && calls.length === 1); }
  for (const [label, body, call] of [
    ["live", DEV_LIVE, (c: ThemeParksClient) => c.getLive(OTHER_PARK)],
    ["schedule", DEV_SCHEDULE, (c: ThemeParksClient) => c.getSchedule(OTHER_PARK)],
    ["entity", { id: DEV_PARK, name: "MK", entityType: "PARK", timezone: "America/New_York" }, (c: ThemeParksClient) => c.getEntity(OTHER_PARK)],
  ] as const) {
    const { client } = mk(() => devRes(200, body));
    const r = await call(client);
    check(`identity: mismatched ${label} id, no cache → invalid_payload`, !r.ok && r.error.kind === "invalid_payload");
    const again = await call(client);
    check(`identity: mismatched ${label} id never cached under requested key`, !again.ok);
  }
  { let wrong = false;
    const { client } = mk(() => devRes(200, wrong ? { ...DEV_LIVE, id: OTHER_PARK } : DEV_LIVE));
    await client.getLive(DEV_PARK); wrong = true; t += TTL.live.fresh + 1;
    const r = await client.getLive(DEV_PARK);
    check("identity: mismatched refresh → correct cached data as stale",
      r.ok && r.meta.origin === "stale" && r.meta.staleReason?.kind === "invalid_payload" && r.data.entityId === DEV_PARK && r.data.entries.length === 2); }
  { let wrong = false;
    const { client } = mk(() => devRes(200, wrong ? { ...DEV_SCHEDULE, id: OTHER_PARK } : DEV_SCHEDULE));
    await client.getSchedule(DEV_PARK); wrong = true; t += TTL.schedule.fresh + 1;
    const r = await client.getSchedule(DEV_PARK);
    check("identity: mismatched schedule refresh → stale correct data",
      r.ok && r.meta.origin === "stale" && r.data.entityId === DEV_PARK); }

  // endTime drift must not replace validated showtimes; UUID casing is canonical across requests.
  { let drift = false;
    const { client } = mk(() => devRes(200, { ...DEV_LIVE, liveData: [{ ...DEV_LIVE.liveData[0], showtimes: drift ? [st({ endTime: "soon" })] : [goodShowtime] }] }));
    await client.getLive(DEV_PARK); drift = true; t += TTL.live.fresh + 1;
    const r = await client.getLive(DEV_PARK);
    check("endTime drift refresh → stale showtimes preserved",
      r.ok && r.meta.origin === "stale" && r.meta.staleReason?.kind === "invalid_payload" && r.data.entries[0].showtimes.length === 1); }
  { const { client, calls } = mk(() => devRes(200, { ...DEV_LIVE, id: DEV_PARK.toUpperCase() }));
    await client.getLive(DEV_PARK.toUpperCase()); const r = await client.getLive(DEV_PARK);
    check("uuid: differently-cased requests share one canonical cache key; upper-case body id accepted",
      r.ok && r.meta.origin === "cache" && calls.length === 1 && calls[0].url.endsWith(`/entity/${DEV_PARK}/live`)); }

  // Date/openingTime drift on refresh preserves the valid stale schedule.
  { let drift = false;
    const good = { ...DEV_SCHEDULE, schedule: [DEV_SCHEDULE.schedule[1]] };
    const bad = { ...DEV_SCHEDULE, schedule: [{ ...DEV_SCHEDULE.schedule[1], date: "2026-10-01" }] };
    const { client } = mk(() => devRes(200, drift ? bad : good));
    await client.getSchedule(DEV_PARK); drift = true; t += TTL.schedule.fresh + 1;
    const r = await client.getSchedule(DEV_PARK);
    check("schedule date drift refresh → stale valid schedule preserved",
      r.ok && r.meta.origin === "stale" && r.meta.staleReason?.kind === "invalid_payload" && r.data.entries.length === 1 && r.data.entries[0].date === "2026-09-30"); }

  // Body-consumption timeout: headers arrive, body stalls.
  { const stall = () => new Response(new ReadableStream({ start() { /* never enqueues or closes */ } }), { status: 200 });
    const { client, calls } = mk(stall, { timeoutMs: 20 });
    const [a, b] = await Promise.all([client.getLive(DEV_PARK), client.getLive(DEV_PARK)]);
    check("stalled body → typed timeout (deduped, not hanging)", !a.ok && a.error.kind === "timeout" && !b.ok && b.error.kind === "timeout" && calls.length === 1);
    const c = await client.getLive(DEV_PARK);
    check("in-flight entry cleared after body timeout (next call fetches)", !c.ok && c.error.kind === "timeout" && calls.length === 2); }
  { let stallNow = false;
    const { client } = mk(() => (stallNow ? new Response(new ReadableStream({ start() {} }), { status: 200 }) : devRes(200, DEV_LIVE)), { timeoutMs: 20 });
    await client.getLive(DEV_PARK); stallNow = true; t += TTL.live.fresh + 1;
    const r = await client.getLive(DEV_PARK);
    check("stalled body refresh → stale-if-error with timeout reason",
      r.ok && r.meta.origin === "stale" && r.meta.staleReason?.kind === "timeout" && r.data.entries.length === 2); }

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

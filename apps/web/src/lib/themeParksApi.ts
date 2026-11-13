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
 *   getChildren(id)              GET /entity/{id}/children  (identity discovery)
 *   getLive(id)                  GET /entity/{id}/live      (status + showtimes)
 *   getSchedule(id, {year,month}?) GET /entity/{id}/schedule[/{y}/{m}]
 *   getHistoryDaily(id, {from,to}) GET /entity/{id}/history/daily (Phase 14.4.2;
 *                                anonymous, separately rate-limited — see below)
 *   verifyProviderIdentity()     discovery vs. configured WDW/DLR ids
 *   verifyEntertainmentMapping() DWP Entertainment → provider UUID audit
 *                                (themeParksEntertainmentMapping.ts)
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
 *   destinations/entity/children  fresh 6h,  stale-if-error up to 7d
 *   schedule             fresh 15m, stale-if-error up to 6h
 *   live                 fresh 60s, stale-if-error up to 10m
 *   history              fresh 1h,  stale-if-error up to 24h (Phase 14.4.2)
 * History is a daily CHANGE LOG, not a calendar. Phase 14.4.2 access tiers
 * (history requests ONLY; live/schedule/children never carry credentials):
 *   authenticated  `x-api-key: $THEMEPARKS_API_KEY` (server env only): ≤ 30
 *                  calendar days, provider pool 600/hour
 *   anonymous      no key (missing/blank/rejected key): ≤ 7 days, pool 60/hour
 * Verified against the provider: a request beyond the caller's tier window is
 * HTTP 403 `{error:{type:"HISTORY_WINDOW_EXCEEDED"}}` (never a truncated 200),
 * and a bad key is silently treated as anonymous (so a 30-day ask with a bad key
 * is that same 403). A 401, or a 403 while a key was sent, marks the key
 * rejected for KEY_REJECT_COOLDOWN_MS (the client then sends no key and reports
 * the anonymous tier) — callers retry with the 7-day window. The key never
 * appears in URLs, errors, logs, cache keys or returned data.
 * Budget (per tier, never assumed globally enforced): a conservative local
 * per-instance rolling-hour cap PLUS the provider's own `RateLimit-History-*`
 * headers, which every response refreshes — near exhaustion the client stops
 * calling until the reported reset, whichever instance spent the quota.
 * Each history 429 keeps its own Retry-After backoff per tier (a history 429
 * never blocks live/schedule calls, and vice versa).
 * 429 (and 503) honor `Retry-After` (seconds or HTTP-date, default 60s, cap
 * 1h) with a client-wide backoff: no network calls until it elapses.
 */

import "server-only";
import { isValidIsoCalendarDate } from "./plannerWarnings";
import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import {
  verifyEntertainmentMapping,
  type EntertainmentMappingReport,
} from "./themeParksEntertainmentMapping";
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
  | "invalid_request"
  /** Phase 14.4.2 history: 401, or 403 other than a window violation (credential not accepted). */
  | "unauthorized"
  /** Phase 14.4.2 history: requested window exceeds the caller's tier (HISTORY_WINDOW_EXCEEDED). */
  | "history_window";

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

export interface ThemeParksChild {
  entityId: string;
  name: string;
  /** ATTRACTION | SHOW | RESTAURANT | ... (provider value, verbatim). */
  entityType: string;
  /** Provider parent UUID (the park, for a park's children). */
  parentId: string | null;
  externalId: string | null;
  slug: string | null;
  location: { latitude: number; longitude: number } | null;
}

/**
 * A park/destination's children. Unlike `/live`, this lists entities that
 * exist in the provider's entity database whether or not they currently
 * have live data, so dormant/seasonal entities still appear (identity
 * discovery). No status/showtimes live here.
 */
export interface ThemeParksChildren {
  entityId: string;
  name: string;
  entityType: string;
  timeZone: string | null;
  children: ThemeParksChild[];
  /** Malformed/duplicate child records discarded during validation. */
  droppedEntries: number;
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
  /**
   * Malformed showtime records discarded for THIS entity during validation
   * (0 = `showtimes` is the complete provider list). Their dates are unknown,
   * so consumers must treat any non-zero value as an incomplete schedule.
   */
  droppedShowtimes: number;
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

export interface ThemeParksHistoryDay {
  /** Resort-local calendar date (YYYY-MM-DD). */
  date: string;
  /** Provider-counted shows that day; null when not supplied. */
  showCount: number | null;
  /** Minutes the entity was OPERATING that day; null when not supplied. */
  operatingMinutes: number | null;
  /** Park-open minutes the entity was scheduled against (`inParkHours.scheduledMinutes`); null when not supplied. */
  scheduledMinutes: number | null;
}

export interface ThemeParksHistoryEntity {
  entityId: string;
  /** ATTRACTION | SHOW | RESTAURANT | PARK | ... (provider value). */
  entityType: string;
  /** `coverage.firstRecordedAt` (YYYY-MM-DD) when supplied. */
  firstRecordedAt: string | null;
  /** Valid day rows only. A missing date is NOT evidence of anything (change log). */
  days: ThemeParksHistoryDay[];
  /** Malformed/duplicate day rows discarded for this entity (non-zero → unreliable). */
  droppedDays: number;
}

export interface ThemeParksHistoryDaily {
  entityId: string;
  timeZone: string | null;
  /** Window the provider says it answered (resort-local dates). */
  from: string;
  to: string;
  entities: ThemeParksHistoryEntity[];
  /** Provider reports a continuation (`next`): the window is NOT complete. */
  hasMore: boolean;
  /** Malformed entity records discarded during validation. */
  droppedEntities: number;
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

function finiteNumber(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

export function normalizeChildren(body: unknown): ThemeParksChildren | null {
  if (!isObj(body) || !Array.isArray(body.children)) return null;
  const entityId = asId(body.id);
  const name = str(body.name);
  const entityType = str(body.entityType);
  if (!entityId || !name || !entityType) return null;
  const children: ThemeParksChild[] = [];
  const seen = new Set<string>();
  let droppedEntries = 0;
  for (const c of body.children) {
    if (!isObj(c)) { droppedEntries++; continue; }
    const id = asId(c.id);
    const cname = str(c.name);
    const ctype = str(c.entityType);
    // Identity fields (id/parentId) reject the record when malformed; a
    // repeated id is ambiguous identity, so the first wins and the repeat is counted.
    const parentId = optionalField(c.parentId, asId);
    if (!id || !cname || !ctype || parentId === INVALID || seen.has(id)) { droppedEntries++; continue; }
    seen.add(id);
    // Low-impact metadata stays permissive: a malformed value becomes null.
    const loc = isObj(c.location) ? c.location : null;
    const latitude = loc ? finiteNumber(loc.latitude, -90, 90) : null;
    const longitude = loc ? finiteNumber(loc.longitude, -180, 180) : null;
    children.push({
      entityId: id,
      name: cname,
      entityType: ctype,
      parentId,
      externalId: str(c.externalId),
      slug: str(c.slug),
      location: latitude !== null && longitude !== null ? { latitude, longitude } : null,
    });
  }
  // Empty children is valid-empty; non-empty with zero valid entries is schema drift.
  if (body.children.length > 0 && children.length === 0) return null;
  return { entityId, name, entityType, timeZone: str(body.timezone), children, droppedEntries };
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
        if (!isObj(s) || !startTime || endTime === INVALID || endsBeforeStart(startTime, endTime)) { entryDroppedShowtimes++; continue; }
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
      droppedShowtimes: entryDroppedShowtimes,
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
      lastUpdated === INVALID || openingTime.slice(0, 10) !== date ||
      endsBeforeStart(openingTime, closingTime)
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

/**
 * Monthly-request boundary check (NOT part of normalizeScheduleEntries: the
 * non-monthly window legitimately spans months). Keeps only entries whose
 * `date` is in the requested year/month, counting the rest as dropped. Same
 * array contract as elsewhere: empty = valid-empty, partly in-month = keep the
 * in-month entries, non-empty with zero in-month = invalid (null). Applies to
 * top-level entries and each nested park's entries (a park whose non-empty
 * schedule is wholly out-of-month is dropped; all parks dropped = invalid).
 */
export function restrictScheduleToMonth(
  schedule: ThemeParksSchedule,
  year: number,
  month: number,
): ThemeParksSchedule | null {
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const filter = (entries: ThemeParksScheduleEntry[]) => {
    const kept = entries.filter((e) => e.date.startsWith(prefix));
    return entries.length > 0 && kept.length === 0 ? null : { kept, dropped: entries.length - kept.length };
  };
  const own = filter(schedule.entries);
  if (!own) return null;
  let dropped = schedule.droppedEntries + own.dropped;
  const parks: ThemeParksParkSchedule[] = [];
  for (const p of schedule.parks) {
    const r = filter(p.entries);
    if (!r) { dropped += p.entries.length; continue; }
    dropped += r.dropped;
    parks.push({ ...p, entries: r.kept });
  }
  if (schedule.parks.length > 0 && parks.length === 0) return null;
  return { ...schedule, entries: own.kept, parks, droppedEntries: dropped };
}

/**
 * Release a response body that will not be consumed so the connection isn't
 * held open. Best-effort and non-blocking: cancellation is started
 * synchronously, and neither a sync throw nor an async rejection may replace
 * the provider error the caller is about to return.
 */
function releaseBody(res: Response): void {
  try {
    void Promise.resolve(res.body?.cancel()).catch(() => {});
  } catch {
    /* ignore: cleanup must never alter the typed provider error */
  }
}

/**
 * Phase 14.4.2 — `/entity/{id}/history/daily` validator. Unknown/unused fields
 * (standby stats, changes, firstOperatingAt, …) are dropped. Never fabricates:
 * a malformed day row is discarded and counted (`droppedDays`), a malformed
 * entity is discarded and counted, and a non-empty `entities` list that yields
 * nothing valid is schema drift (null → invalid_payload).
 */
export function normalizeHistoryDaily(body: unknown): ThemeParksHistoryDaily | null {
  if (!isObj(body) || !Array.isArray(body.entities) || !isObj(body.range)) return null;
  const entityId = asId(body.id);
  const from = str(body.range.from);
  const to = str(body.range.to);
  if (!entityId || !from || !to || !isValidIsoCalendarDate(from) || !isValidIsoCalendarDate(to) || to < from) return null;
  const nonNegNum = (v: unknown): number | null | typeof INVALID =>
    v === undefined || v === null ? null : typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : INVALID;
  const entities: ThemeParksHistoryEntity[] = [];
  let droppedEntities = 0;
  for (const e of body.entities) {
    if (!isObj(e)) { droppedEntities++; continue; }
    const id = asId(e.id);
    const entityType = str(e.entityType);
    if (!id || !entityType || !Array.isArray(e.days)) { droppedEntities++; continue; }
    const first = isObj(e.coverage) ? str(e.coverage.firstRecordedAt) : null;
    const days: ThemeParksHistoryDay[] = [];
    const seen = new Set<string>();
    let droppedDays = 0;
    for (const d of e.days) {
      const date = isObj(d) ? str(d.date) : null;
      if (!isObj(d) || !date || !isValidIsoCalendarDate(date) || date < from || date > to) { droppedDays++; continue; }
      const showCount = nonNegNum(d.showCount);
      const operatingMinutes = nonNegNum(d.operatingMinutes);
      const scheduledMinutes = isObj(d.inParkHours) ? nonNegNum(d.inParkHours.scheduledMinutes) : null;
      if (showCount === INVALID || operatingMinutes === INVALID || scheduledMinutes === INVALID || seen.has(date)) {
        droppedDays++; // duplicate dates are ambiguous: the earlier row stays, the entity is flagged
        continue;
      }
      seen.add(date);
      days.push({ date, showCount, operatingMinutes, scheduledMinutes });
    }
    entities.push({
      entityId: id,
      entityType,
      firstRecordedAt: first && isValidIsoCalendarDate(first) ? first : null,
      days: days.sort((a, b) => a.date.localeCompare(b.date)),
      droppedDays,
    });
  }
  if (body.entities.length > 0 && entities.length === 0) return null;
  const hasMore = body.next !== undefined && body.next !== null && body.next !== false && body.next !== "";
  return { entityId, timeZone: str(body.timezone), from, to, entities, hasMore, droppedEntities };
}

/** True when both endpoints parse and the end instant precedes the start instant (equal is fine). */
function endsBeforeStart(start: string, end: string | null): boolean {
  return end !== null && Date.parse(end) < Date.parse(start);
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
  history: { fresh: 3_600_000, maxStale: 24 * 3_600_000 },
} as const;

export type HistoryTier = "authenticated" | "anonymous";
/** Provider windows per tier (calendar days, inclusive of today). */
export const HISTORY_MAX_DAYS: Record<HistoryTier, number> = { authenticated: 30, anonymous: 7 };
/** Provider pools: authenticated 600/hour, anonymous 60/hour. Local per-instance caps stay well below. */
export const HISTORY_MAX_CALLS_PER_HOUR = 50; // anonymous (kept name: provider pool is 60)
export const HISTORY_MAX_CALLS_PER_HOUR_AUTH = 300; // authenticated (provider pool is 600)
const HISTORY_LOCAL_CAP: Record<HistoryTier, number> = { anonymous: HISTORY_MAX_CALLS_PER_HOUR, authenticated: HISTORY_MAX_CALLS_PER_HOUR_AUTH };
/** Stop calling once the provider reports ≤ this share of the pool left (until its reported reset). */
export const HISTORY_QUOTA_RESERVE_SHARE = 0.05;
/** After a rejected key, send no key (anonymous tier) for this long before trying it again. */
export const KEY_REJECT_COOLDOWN_MS = 3_600_000;

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CACHE_ENTRIES = 64;

export interface ThemeParksClientOptions {
  /**
   * History API key. `undefined` (default) → read THEMEPARKS_API_KEY from the
   * server environment at request time; `null`/blank → force anonymous.
   */
  apiKey?: string | null;
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
  // Client-wide Retry-After backoff, tracked per rate-limit pool: history has its
  // own provider limit, so a history 429 must never block live/schedule calls
  // (and a live 429 must not suppress history's own accounting).
  const blocks = {
    main: { until: 0, error: null as ThemeParksError | null },
    // History pools are per tier: the authenticated and anonymous quotas are independent.
    history: {
      authenticated: { until: 0, error: null as ThemeParksError | null },
      anonymous: { until: 0, error: null as ThemeParksError | null },
    },
  };
  const historyAttempts: Record<HistoryTier, number[]> = { authenticated: [], anonymous: [] };
  let keyRejectedUntil = 0;

  /** Trimmed key from options/env, or null. Read per request; never stored in cache keys, errors or data. */
  function readApiKey(): string | null {
    const raw = opts.apiKey !== undefined ? opts.apiKey : process.env.THEMEPARKS_API_KEY;
    const k = typeof raw === "string" ? raw.trim() : "";
    return k.length > 0 && !/[\r\n]/.test(k) ? k : null;
  }
  /** Defense in depth: a transport error message must never carry the credential. */
  function redactKey(message: string): string {
    const k = readApiKey();
    return k ? message.split(k).join("[redacted]") : message;
  }
  /** Current history access: the key tier unless the key was recently rejected. */
  function historyAccess(): { tier: HistoryTier; maxDays: number } {
    const tier: HistoryTier = readApiKey() !== null && now() >= keyRejectedUntil ? "authenticated" : "anonymous";
    return { tier, maxDays: HISTORY_MAX_DAYS[tier] };
  }

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

  /**
   * Refresh the history pool from the provider's own headers after every
   * response, so the budget reflects what ALL instances have spent (the local cap
   * alone cannot see that). Near exhaustion → stop until the reported reset.
   */
  function learnHistoryQuota(res: Response, block: { until: number; error: ThemeParksError | null }, t: number) {
    const num = (h: string) => { const v = Number(res.headers.get(h)); return res.headers.get(h) !== null && Number.isFinite(v) ? v : null; };
    const limit = num("ratelimit-history-limit");
    const remaining = num("ratelimit-history-remaining");
    const reset = num("ratelimit-history-reset");
    if (limit === null || remaining === null || limit <= 0) return;
    if (remaining <= Math.ceil(limit * HISTORY_QUOTA_RESERVE_SHARE)) {
      const waitMs = Math.min(3_600_000, Math.max(1_000, (reset ?? 3600) * 1000));
      if (t + waitMs > block.until) {
        block.until = t + waitMs;
        block.error = { kind: "rate_limited", message: "ThemeParks history quota nearly exhausted", retryAfterMs: waitMs };
      }
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
    const hist = cls === "history" ? historyAccess() : null;
    const tier: HistoryTier | null = hist ? hist.tier : null;
    const block = tier ? blocks.history[tier] : blocks.main;
    if (t0 < block.until && block.error) {
      return fail({ ...block.error, retryAfterMs: block.until - t0 }, cached, cls);
    }
    if (tier) {
      // Local per-instance cap (rolling hour). Not the global limit: the provider
      // pool is shared by every instance, which `RateLimit-History-*` tracks below.
      const attempts = (historyAttempts[tier] = historyAttempts[tier].filter((t) => t0 - t < 3_600_000));
      if (attempts.length >= HISTORY_LOCAL_CAP[tier]) {
        return fail(
          { kind: "rate_limited", message: "ThemeParks history call budget exhausted", retryAfterMs: attempts[0] + 3_600_000 - t0 },
          cached,
          cls,
        );
      }
      attempts.push(t0);
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "DisneyWaitPlanner/1.0 (+https://dwpapp.com)",
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    // Credentials go ONLY on history requests, and only in this header.
    if (tier === "authenticated") headers["x-api-key"] = readApiKey() ?? "";

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
          : { kind: "network", message: redactKey(e instanceof Error ? e.message : "network failure") },
        cached,
        cls,
      );
    }

    const t1 = now();
    if (tier) {
      learnHistoryQuota(res, block, t1);
      if (res.status === 401 || res.status === 403) {
        // Only an allow-listed error type is read from the body; no provider text is surfaced.
        let windowViolation = false;
        if (res.status === 403) {
          try {
            const b: unknown = await Promise.race([res.json(), aborted]);
            windowViolation = isObj(b) && isObj(b.error) && b.error.type === "HISTORY_WINDOW_EXCEEDED";
          } catch {
            releaseBody(res);
          }
        } else {
          releaseBody(res);
        }
        // A key was sent and refused/ignored (window error with a key means the tier did not apply): cool it down.
        if (tier === "authenticated") keyRejectedUntil = t1 + KEY_REJECT_COOLDOWN_MS;
        return fail(
          windowViolation
            ? { kind: "history_window", message: "ThemeParks history window exceeds this access tier", httpStatus: res.status }
            : { kind: "unauthorized", message: "ThemeParks history credential not accepted", httpStatus: res.status },
          cached,
          cls,
        );
      }
    }
    // Single cleanup point: every non-2xx path below (304 revalidation, 429/503,
    // 404, generic HTTP) is status-only and never reads the body.
    if (res.status === 304 || !res.ok) releaseBody(res);
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
      // Client-wide backoff is monotonic: concurrent responses may arrive in any
      // order, and a later shorter Retry-After must never shorten an active
      // longer deadline (the error travels with the deadline that wins).
      if (t1 + retryAfterMs > block.until) {
        block.until = t1 + retryAfterMs;
        block.error = error;
      }
      const effective = block.error ?? error;
      return fail({ ...effective, retryAfterMs: Math.max(0, block.until - t1) }, cached, cls);
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

    /** Static entity metadata (6h fresh); includes dormant/seasonal entities that `/live` omits. */
    getChildren(requestedId: string): Promise<ThemeParksResult<ThemeParksChildren>> {
      const bad = badId(requestedId);
      if (bad) return Promise.resolve({ ok: false, error: bad });
      const entityId = requestedId.toLowerCase(); // canonical: one cache key + identity compare per entity
      return request(`/entity/${entityId}/children`, "static", forEntity(entityId, normalizeChildren));
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
      const normalize = month
        ? (body: unknown) => {
            const sch = normalizeSchedule(body);
            return sch && restrictScheduleToMonth(sch, month.year, month.month);
          }
        : normalizeSchedule;
      return request(`/entity/${entityId}/schedule${suffix}`, "schedule", forEntity(entityId, normalize));
    },

    /**
     * Phase 14.4.2: park-level daily history for [from, to] (resort-local
     * YYYY-MM-DD, ≤ the current tier's days inclusive). One request covers every child entity —
     * never call this per entity. See header for cache/budget behavior.
     */
    /** Phase 14.4.2: current history tier ("authenticated" 30 d / "anonymous" 7 d); never exposes the key. */
    historyAccess,

    getHistoryDaily(
      requestedId: string,
      range: { from: string; to: string },
    ): Promise<ThemeParksResult<ThemeParksHistoryDaily>> {
      const bad = badId(requestedId);
      if (bad) return Promise.resolve({ ok: false, error: bad });
      const { from, to } = range;
      const spanDays = isValidIsoCalendarDate(from) && isValidIsoCalendarDate(to)
        ? (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1
        : NaN;
      // Never ask beyond the CURRENT tier's window (the provider answers that with a 403).
      const maxDays = historyAccess().maxDays;
      if (!(spanDays >= 1 && spanDays <= maxDays)) {
        return Promise.resolve({ ok: false, error: { kind: "invalid_request", message: `history range must be 1–${maxDays} valid dates` } });
      }
      const entityId = requestedId.toLowerCase();
      // The answered window must be the requested one (a stale/other-window body is never cached under this key).
      const normalize = forEntity(entityId, (body: unknown) => {
        const h = normalizeHistoryDaily(body);
        return h && h.from === from && h.to === to ? h : null;
      });
      return request(`/entity/${entityId}/history/daily?from=${from}&to=${to}`, "history", normalize);
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

    /**
     * Fetches every configured park's children and audits the DWP
     * Entertainment → provider UUID mapping against them (pure verifier in
     * themeParksEntertainmentMapping.ts). Any park failure is returned as that
     * typed error — never a partial/optimistic report. If any park was served
     * stale the aggregate is flagged stale (oldest data, first stale reason).
     */
    async verifyEntertainmentMapping(): Promise<ThemeParksResult<EntertainmentMappingReport>> {
      const parkIds = Object.keys(THEMEPARKS_PARKS) as ParkId[];
      const results = await Promise.all(parkIds.map((p) => this.getChildren(THEMEPARKS_PARKS[p].entityId)));
      const byPark: Partial<Record<ParkId, ThemeParksChildren>> = {};
      const metas: ThemeParksMeta[] = [];
      for (let i = 0; i < parkIds.length; i++) {
        const r = results[i];
        if (!r.ok) return r;
        byPark[parkIds[i]] = r.data;
        metas.push(r.meta);
      }
      const stale = metas.find((m) => m.origin === "stale");
      const meta: ThemeParksMeta = {
        origin: stale ? "stale" : metas.some((m) => m.origin === "network") ? "network" : metas.every((m) => m.origin === "cache") ? "cache" : "revalidated",
        fetchedAt: Math.min(...metas.map((m) => m.fetchedAt)),
        etag: null,
        ...(stale?.staleReason ? { staleReason: stale.staleReason } : {}),
      };
      return { ok: true, data: verifyEntertainmentMapping(byPark), meta };
    },

    /** Test/diagnostic hook: drop caches and backoff. */
    _reset() {
      cache.clear();
      inflight.clear();
      blocks.main.until = 0;
      blocks.main.error = null;
      for (const t of ["authenticated", "anonymous"] as const) {
        blocks.history[t].until = 0;
        blocks.history[t].error = null;
        historyAttempts[t] = [];
      }
      keyRejectedUntil = 0;
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
  check("live: per-entity droppedShowtimes retained (0 for clean entities)", live?.entries[0].droppedShowtimes === 1 && live.entries[1].droppedShowtimes === 0);
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
  // Provider intervals: end before start rejected (parsed instants); equal ok; next-day close ok.
  { const lv = (showtimes: unknown[]) => liveWith(showEntry(showtimes), DEV_LIVE.liveData[1]);
    const shows = (r: ReturnType<typeof normalizeLive>) => r?.entries[0].showtimes.length;
    check("showtime: end before start dropped (partial)", ((r) => shows(r) === 1 && r?.droppedShowtimes === 1)(lv([goodShowtime, st({ startTime: "2026-09-30T10:50:00-04:00", endTime: "2026-09-30T10:49:59-04:00" })])));
    check("showtime: equal endpoints accepted", shows(lv([st({ endTime: goodShowtime.startTime })])) === 1);
    check("showtime: later end accepted", shows(lv([st({ endTime: "2026-09-30T11:30:00-04:00" })])) === 1);
    check("showtime: compares instants across offsets (not strings)",
      shows(lv([st({ startTime: "2026-09-30T10:00:00-04:00", endTime: "2026-09-30T14:30:00Z" })])) === 1 &&
      liveWith(showEntry([st({ startTime: "2026-09-30T10:00:00-04:00", endTime: "2026-09-30T13:30:00Z" })])) === null);
    check("showtime: all end-before-start → entry rejected → payload invalid",
      liveWith(showEntry([st({ endTime: "2026-09-30T09:00:00-04:00" })])) === null);
    const sb = { date: "2026-09-30", type: "OPERATING" };
    const sc = (...schedule: unknown[]) => normalizeSchedule({ ...DEV_SCHEDULE, schedule });
    check("schedule: closing before opening dropped (partial keeps valid)",
      ((r) => r?.entries.length === 1 && r.droppedEntries === 1)(sc({ ...sb, openingTime: "2026-09-30T09:00:00-04:00", closingTime: "2026-09-30T22:00:00-04:00" }, { ...sb, openingTime: "2026-09-30T22:00:00-04:00", closingTime: "2026-09-30T09:00:00-04:00" })));
    check("schedule: equal opening/closing accepted", sc({ ...sb, openingTime: "2026-09-30T09:00:00-04:00", closingTime: "2026-09-30T09:00:00-04:00" })?.entries.length === 1);
    check("schedule: next-day close accepted", sc({ ...sb, openingTime: "2026-09-30T22:00:00-04:00", closingTime: "2026-10-01T02:00:00-04:00" })?.entries.length === 1);
    check("schedule: all closing-before-opening → payload invalid", sc({ ...sb, openingTime: "2026-09-30T22:00:00-04:00", closingTime: "2026-09-30T21:59:59-04:00" }) === null);
    check("schedule: compares instants across offsets",
      sc({ ...sb, openingTime: "2026-09-30T22:00:00-04:00", closingTime: "2026-10-01T01:59:00Z" }) === null &&
      sc({ ...sb, openingTime: "2026-09-30T22:00:00-04:00", closingTime: "2026-10-01T02:01:00Z" })?.entries.length === 1); }
  // Monthly requests: entries must belong to the requested year/month (request boundary only).
  { const oct = (d: string) => ({ date: d, type: "OPERATING", openingTime: `${d}T09:00:00-04:00`, closingTime: `${d}T22:00:00-04:00` });
    const doc = (schedule: unknown[]) => ({ ...DEV_SCHEDULE, schedule });
    const monthly = async (body: unknown) => {
      const { client, calls } = mk(() => devRes(200, body));
      return { r: await client.getSchedule(DEV_PARK, { year: 2026, month: 10 }), calls };
    };
    { const { r, calls } = await monthly(doc([oct("2026-10-01"), oct("2026-10-31")]));
      check("monthly: requested-month entries accepted", r.ok && r.data.entries.length === 2 && r.data.droppedEntries === 0 && calls[0].url.endsWith("/schedule/2026/10")); }
    { const { r } = await monthly(doc([oct("2026-10-01"), oct("2026-11-01"), oct("2025-10-05"), oct("2026-09-30")]));
      check("monthly: mixed keeps requested-month entries, drops others (year and month both checked)",
        r.ok && r.data.entries.length === 1 && r.data.entries[0].date === "2026-10-01" && r.data.droppedEntries === 3); }
    { const { r } = await monthly(doc([oct("2026-11-01")]));
      check("monthly: wholly out-of-month → invalid_payload", !r.ok && r.error.kind === "invalid_payload"); }
    { const { r } = await monthly(doc([]));
      check("monthly: genuinely empty is valid-empty", r.ok && r.data.entries.length === 0); }
    const dest = (parks: unknown[]) => ({ id: DEV_PARK, name: "WDW", timezone: "America/New_York", parks });
    const mkPark = (id: string, dates: string[]) => ({ id, name: id, schedule: dates.map(oct) });
    { const { r } = await monthly(dest([mkPark(DEV_PARK, ["2026-10-02", "2026-11-02"]), mkPark(THEMEPARKS_PARKS.hs.entityId, ["2026-11-03"])]));
      check("monthly: nested parks — mixed kept, wholly out-of-month park dropped",
        r.ok && r.data.parks.length === 1 && r.data.parks[0].entries.length === 1 && r.data.parks[0].entries[0].date === "2026-10-02"); }
    { const { r } = await monthly(dest([mkPark(DEV_PARK, ["2026-11-02"]), mkPark(THEMEPARKS_PARKS.hs.entityId, ["2026-09-03"])]));
      check("monthly: nested parks all wholly out-of-month → invalid_payload", !r.ok && r.error.kind === "invalid_payload"); }
    { const { r } = await monthly(dest([mkPark(DEV_PARK, []), mkPark(THEMEPARKS_PARKS.hs.entityId, ["2026-10-03"])]));
      check("monthly: nested park with empty schedule stays valid-empty", r.ok && r.data.parks.length === 2); }
    { let drift = false;
      const { client } = mk(() => devRes(200, drift ? doc([oct("2026-11-01")]) : doc([oct("2026-10-01")])));
      await client.getSchedule(DEV_PARK, { year: 2026, month: 10 }); drift = true; t += TTL.schedule.fresh + 1;
      const r = await client.getSchedule(DEV_PARK, { year: 2026, month: 10 });
      check("monthly: wholly out-of-month refresh → stale valid month preserved",
        r.ok && r.meta.origin === "stale" && r.meta.staleReason?.kind === "invalid_payload" && r.data.entries[0].date === "2026-10-01"); }
    { const { client, calls } = mk(() => devRes(200, doc([oct("2026-10-01"), oct("2026-11-01"), oct("2026-12-01")])));
      const r = await client.getSchedule(DEV_PARK);
      check("non-monthly: multi-month window unchanged (no month filtering)",
        r.ok && r.data.entries.length === 3 && r.data.droppedEntries === 0 && calls[0].url.endsWith(`/entity/${DEV_PARK}/schedule`)); } }
  // Children (Phase 12.2): strict identity, permissive metadata, valid-empty vs drift.
  { const CH = "92524eb7-4ee5-4eab-936c-2eb8e6eb0ecd";
    const kid = (extra: Record<string, unknown> = {}) => ({ id: CH, name: "Show", entityType: "SHOW", externalId: "1;entityType=Entertainment", parentId: DEV_PARK, slug: null, location: { latitude: 28.4, longitude: -81.5 }, ...extra });
    const doc = (children: unknown) => ({ id: DEV_PARK, name: "Magic Kingdom Park", entityType: "PARK", timezone: "America/New_York", children });
    const n = normalizeChildren(doc([kid()]));
    check("children: preserves id/name/type/parent/externalId/location", n?.children.length === 1 && n.entityId === DEV_PARK && n.timeZone === "America/New_York" &&
      n.children[0].entityId === CH && n.children[0].entityType === "SHOW" && n.children[0].parentId === DEV_PARK && n.children[0].externalId === "1;entityType=Entertainment" && n.children[0].location?.latitude === 28.4);
    check("children: valid-empty ok", normalizeChildren(doc([]))?.children.length === 0);
    check("children: missing/non-array children or bad doc id invalid", normalizeChildren({ ...doc([]), children: undefined }) === null && normalizeChildren(doc("x")) === null && normalizeChildren({ ...doc([kid()]), id: "nope" }) === null && normalizeChildren([]) === null);
    check("children: uuids lowercased", normalizeChildren(doc([kid({ id: CH.toUpperCase(), parentId: DEV_PARK.toUpperCase() })]))?.children[0].entityId === CH && normalizeChildren(doc([kid({ parentId: DEV_PARK.toUpperCase() })]))?.children[0].parentId === DEV_PARK);
    { const r = normalizeChildren(doc([kid(), kid({ id: "bad" }), kid({ id: "a0613b70-293f-4a5b-8169-357be1777c62", name: "" }), kid({ id: "c1f39c15-7845-46b5-b6fd-2ae368a32a37", parentId: "zzz" }), "x", null]));
      check("children: partial malformed keeps valid, counts dropped (bad id/name/parentId/non-object)", r?.children.length === 1 && r.droppedEntries === 5); }
    check("children: wholly malformed → invalid", normalizeChildren(doc([{ nope: 1 }, "x"])) === null);
    { const r = normalizeChildren(doc([kid(), kid({ name: "Dupe" })]));
      check("children: repeated id dropped (first wins, counted)", r?.children.length === 1 && r.children[0].name === "Show" && r.droppedEntries === 1); }
    check("children: absent/null parentId allowed", normalizeChildren(doc([kid({ parentId: null })]))?.children[0].parentId === null && normalizeChildren(doc([{ ...kid(), parentId: undefined }]))?.children[0].parentId === null);
    { const r = normalizeChildren(doc([kid({ location: { latitude: 999, longitude: 1 }, slug: 5, externalId: 7 })]));
      check("children: low-impact metadata permissive (bad location/slug/externalId → null)", r?.children[0].location === null && r.children[0].slug === null && r.children[0].externalId === null); }
    check("children: raw extras not leaked", !("queue" in (normalizeChildren(doc([{ ...kid(), queue: {} }]))?.children[0] ?? {})));
    { const { client, calls } = mk(() => devRes(200, doc([kid()]), { etag: 'W/"c"' }));
      const [a, b] = await Promise.all([client.getChildren(DEV_PARK.toUpperCase()), client.getChildren(DEV_PARK)]);
      t += 60 * 60_000; const c = await client.getChildren(DEV_PARK);
      check("children: path, dedupe, cached as static (still fresh after 1h)", a.ok && b.ok && calls.length === 1 && calls[0].url.endsWith(`/entity/${DEV_PARK}/children`) && c.ok && c.meta.origin === "cache" && calls.length === 1);
      t += TTL.static.fresh;
      let cm = 0; const { client: c2, calls: calls2 } = mk((_u, _i) => (cm++ === 0 ? devRes(200, doc([kid()]), { etag: 'W/"c"' }) : devRes(304, null)));
      await c2.getChildren(DEV_PARK); t += TTL.static.fresh + 1;
      const rv = await c2.getChildren(DEV_PARK);
      check("children: ETag revalidation after static TTL", rv.ok && rv.meta.origin === "revalidated" && (calls2[1].init.headers as Record<string, string>)["If-None-Match"] === 'W/"c"'); }
    { const { client, calls } = mk(() => devRes(200, doc([])));
      const r = await client.getChildren("nope");
      check("children: bad id rejected without fetch", !r.ok && r.error.kind === "invalid_request" && calls.length === 0); }
    { const { client } = mk(() => devRes(200, { ...doc([kid()]), id: THEMEPARKS_PARKS.hs.entityId }));
      const r = await client.getChildren(DEV_PARK);
      check("children: mismatched response id → invalid_payload", !r.ok && r.error.kind === "invalid_payload"); }
    { let drift = false;
      const { client } = mk(() => devRes(200, drift ? doc([{ nope: 1 }]) : doc([kid()])));
      await client.getChildren(DEV_PARK); drift = true; t += TTL.static.fresh + 1;
      const r = await client.getChildren(DEV_PARK);
      check("children: drift refresh → stale valid children preserved", r.ok && r.meta.origin === "stale" && r.meta.staleReason?.kind === "invalid_payload" && r.data.children.length === 1); }
    { let fail = false;
      const { client } = mk(() => (fail ? devRes(500, {}) : devRes(200, doc([kid()]))));
      await client.getChildren(DEV_PARK); fail = true; t += TTL.static.fresh + 1;
      const s = await client.getChildren(DEV_PARK);
      check("children: stale-if-error flagged; 7d bound", s.ok && s.meta.origin === "stale");
      t += TTL.static.maxStale + 1;
      check("children: stale beyond 7d → error", !(await client.getChildren(DEV_PARK)).ok); }
    { const { client } = mk(() => devRes(404, {}));
      const r = await client.getChildren(DEV_PARK); check("children: 404 → not_found", !r.ok && r.error.kind === "not_found"); }
    // verifyEntertainmentMapping wrapper: any park failure is a typed failure, never a partial report.
    { const { client } = mk((u) => (u.includes(THEMEPARKS_PARKS.ak.entityId) ? devRes(500, {}) : devRes(200, { id: u.split("/entity/")[1].split("/")[0], name: "P", entityType: "PARK", children: [] })));
      const r = await client.verifyEntertainmentMapping();
      check("verifyEntertainmentMapping: one park failing → typed error, no partial report", !r.ok && r.error.kind === "http"); }
    { const { client } = mk((u) => { const id = u.split("/entity/")[1].split("/")[0]; return devRes(200, { id, name: "P", entityType: "PARK", children: [] }); });
      const r = await client.verifyEntertainmentMapping();
      check("verifyEntertainmentMapping: empty provider children → mapped entries flagged entity_missing (not ok)", r.ok && !r.data.ok && r.data.findings.some((f) => f.kind === "entity_missing")); } }
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
    await client.getSchedule(DEV_PARK, { year: 2026, month: 9 });
    t += TTL.schedule.fresh + 1;
    const r = await client.getSchedule(DEV_PARK, { year: 2026, month: 9 });
    const inm = (calls[1].init.headers as Record<string, string>)["If-None-Match"];
    check("etag: If-None-Match sent, 304 revalidates", inm === 'W/"s"' && r.ok && r.meta.origin === "revalidated" && r.data.entries.length === 2);
    check("schedule month path", calls[0].url.endsWith(`/entity/${DEV_PARK}/schedule/2026/09`)); }

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

  // Interval drift on refresh preserves valid stale data.
  { let drift = false;
    const badSched = { ...DEV_SCHEDULE, schedule: [{ ...DEV_SCHEDULE.schedule[1], closingTime: "2026-09-30T08:00:00-04:00" }] };
    const goodSched = { ...DEV_SCHEDULE, schedule: [DEV_SCHEDULE.schedule[1]] };
    const { client } = mk(() => devRes(200, drift ? badSched : goodSched));
    await client.getSchedule(DEV_PARK); drift = true; t += TTL.schedule.fresh + 1;
    const r = await client.getSchedule(DEV_PARK);
    check("schedule interval drift refresh → stale valid schedule",
      r.ok && r.meta.origin === "stale" && r.meta.staleReason?.kind === "invalid_payload" && r.data.entries[0].closingTime === "2026-09-30T22:00:00-04:00"); }
  { let drift = false;
    const { client } = mk(() => devRes(200, { ...DEV_LIVE, liveData: [{ ...DEV_LIVE.liveData[0], showtimes: [drift ? st({ endTime: "2026-09-30T09:00:00-04:00" }) : goodShowtime] }] }));
    await client.getLive(DEV_PARK); drift = true; t += TTL.live.fresh + 1;
    const r = await client.getLive(DEV_PARK);
    check("showtime interval drift refresh → stale showtimes preserved",
      r.ok && r.meta.origin === "stale" && r.meta.staleReason?.kind === "invalid_payload" && r.data.entries[0].showtimes.length === 1); }

  // Retry-After backoff is monotonic across concurrent 429s (either arrival order).
  for (const [label, first, second] of [["longer→shorter", "120", "30"], ["shorter→longer", "30", "120"]] as const) {
    const { client, calls } = mk((u) => devRes(429, {}, { "retry-after": u.includes("/live") ? first : second }));
    const [a, b] = await Promise.all([client.getLive(DEV_PARK), client.getSchedule(DEV_PARK)]);
    // The first response can only report what was known when it arrived; the later one must report the longest.
    check(`retry-after ${label}: later response reports the effective (longest) deadline`,
      !a.ok && !b.ok && a.error.kind === "rate_limited" && b.error.retryAfterMs === 120_000 && a.error.retryAfterMs === Number(first) * 1000);
    const c = await client.getEntity(DEV_PARK);
    check(`retry-after ${label}: backoff holds at longest deadline, no new fetch`, !c.ok && c.error.kind === "rate_limited" && c.error.retryAfterMs === 120_000 && calls.length === 2);
    t += 60_000; const d = await client.getEntity(DEV_PARK);
    check(`retry-after ${label}: still blocked after shorter window elapsed`, !d.ok && d.error.retryAfterMs === 60_000 && calls.length === 2);
    t += 60_001; await client.getEntity(DEV_PARK);
    check(`retry-after ${label}: resumes after longest deadline`, calls.length === 3);
  }

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

  // Response-body release on status-only error paths (single shared point).
  { const tracked = (status: number, headers: Record<string, string> = {}, cancelRejects = false) => {
      const flag = { cancelled: false };
      const body = new ReadableStream({
        start() { /* never enqueues */ },
        cancel() { flag.cancelled = true; if (cancelRejects) throw new Error("cancel boom"); },
      });
      return { flag, res: new Response(body, { status, headers }) };
    };
    const cases: Array<[string, number, Record<string, string>, (r: ThemeParksResult<unknown>) => boolean]> = [
      ["429", 429, { "retry-after": "45" }, (r) => !r.ok && r.error.kind === "rate_limited" && r.error.httpStatus === 429 && r.error.retryAfterMs === 45_000],
      ["503", 503, { "retry-after": "20" }, (r) => !r.ok && r.error.kind === "http" && r.error.httpStatus === 503 && r.error.retryAfterMs === 20_000],
      ["404", 404, {}, (r) => !r.ok && r.error.kind === "not_found" && r.error.httpStatus === 404],
      ["500", 500, {}, (r) => !r.ok && r.error.kind === "http" && r.error.httpStatus === 500],
    ];
    for (const [label, status, headers, expectOk] of cases) {
      for (const rejects of [false, true]) {
        const t1 = tracked(status, headers, rejects);
        const { client } = mk(() => t1.res);
        const r = await client.getLive(DEV_PARK);
        check(`body release: ${label} cancels body${rejects ? " (cancel throws) and keeps typed error" : " with typed semantics intact"}`, t1.flag.cancelled && expectOk(r));
      }
    }
    { const t1 = tracked(429, { "retry-after": "60" }, true);
      const { client, calls } = mk(() => t1.res);
      await client.getLive(DEV_PARK); const again = await client.getSchedule(DEV_PARK);
      check("body release: backoff still blocks further calls after cancel", !again.ok && again.error.kind === "rate_limited" && calls.length === 1); }
    { let n = 0; const err = tracked(500);
      const { client } = mk(() => (n++ === 0 ? devRes(200, DEV_LIVE) : err.res));
      await client.getLive(DEV_PARK); t += TTL.live.fresh + 1;
      const r = await client.getLive(DEV_PARK);
      check("body release: 500 refresh cancels body and stale-if-error preserved", err.flag.cancelled && r.ok && r.meta.origin === "stale" && r.meta.staleReason?.kind === "http"); }
    { let n = 0; // 304 has no body by spec; revalidation path must be unaffected by the shared release
      const { client } = mk(() => (n++ === 0 ? devRes(200, DEV_LIVE, { etag: 'W/"y"' }) : devRes(304, null)));
      await client.getLive(DEV_PARK); t += TTL.live.fresh + 1;
      const r = await client.getLive(DEV_PARK);
      check("body release: 304 revalidation still works", r.ok && r.meta.origin === "revalidated"); }
    { const ok = tracked(200);
      const okBody = new Response(JSON.stringify(DEV_LIVE), { status: 200 });
      const { client } = mk(() => okBody);
      const r = await client.getLive(DEV_PARK);
      check("body release: successful body-consuming path unchanged", r.ok && r.meta.origin === "network" && r.data.entries.length === 2 && ok.flag.cancelled === false); } }

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

  // Phase 14.4.2 history client.
  {
    const mka = (h: (url: string, init: RequestInit) => Promise<Response> | Response, extra: Partial<ThemeParksClientOptions> = {}) => mk(h, { apiKey: null, ...extra });
    const W = { from: "2026-11-07", to: "2026-11-13" };
    const day = (date: string, showCount: unknown = 1, om: unknown = 600) => ({ date, showCount, operatingMinutes: om, inParkHours: { scheduledMinutes: 870, operatingMinutes: 600 }, standby: { p50: 1 }, changes: 3 });
    const body = (over: Record<string, unknown> = {}) => ({ id: DEV_PARK, name: "Park", timezone: "America/New_York", range: W, next: null,
      entities: [{ id: "a0613b70-293f-4a5b-8169-1357be1777c6", name: "Show", entityType: "SHOW", coverage: { firstRecordedAt: "2021-10-01" }, days: [day("2026-11-07"), day("2026-11-08", 0, 0)] }], ...over });
    const h = normalizeHistoryDaily(body());
    check("history: keeps counts/minutes/scheduled, drops standby/changes", h?.entities[0].days[0].showCount === 1 && h.entities[0].days[0].scheduledMinutes === 870 && h.entities[0].days[1].showCount === 0 && !("standby" in (h?.entities[0].days[0] ?? {})));
    check("history: next:null → complete; next present → hasMore", h?.hasMore === false && normalizeHistoryDaily(body({ next: "cursor" }))?.hasMore === true);
    check("history: malformed/duplicate/out-of-window day rows are dropped and counted", (() => {
      const r = normalizeHistoryDaily(body({ entities: [{ id: "a0613b70-293f-4a5b-8169-1357be1777c6", entityType: "SHOW", days: [day("2026-11-07"), day("2026-11-07"), day("bad"), day("2026-12-01"), day("2026-11-09", -1)] }] }));
      return r?.entities[0].days.length === 1 && r.entities[0].droppedDays === 4;
    })());
    check("history: malformed entities dropped and counted; wholly malformed invalid", normalizeHistoryDaily(body({ entities: [body().entities[0], { nope: 1 }] }))?.droppedEntities === 1 && normalizeHistoryDaily(body({ entities: [{ nope: 1 }] })) === null);
    check("history: valid-empty ok; garbage invalid", normalizeHistoryDaily(body({ entities: [] }))?.entities.length === 0 && normalizeHistoryDaily({}) === null && normalizeHistoryDaily(body({ range: { from: "x", to: "y" } })) === null);
    check("history: absent days array on an entity drops the entity (never an empty history)", normalizeHistoryDaily(body({ entities: [body().entities[0], { id: "a0613b70-293f-4a5b-8169-1357be1777c7", entityType: "SHOW" }] }))?.droppedEntities === 1);
    // Client: URL, caching, window identity, input validation.
    { const { client, calls } = mka(() => devRes(200, body()));
      const r1 = await client.getHistoryDaily(DEV_PARK, W); const r2 = await client.getHistoryDaily(DEV_PARK, W);
      check("history: park-level request URL with from/to, then served from the 1 h cache", r1.ok && r2.ok && r2.meta.origin === "cache" && calls.length === 1 && calls[0].url.endsWith(`/entity/${DEV_PARK}/history/daily?from=2026-11-07&to=2026-11-13`));
      t += 3_599_000; const r3 = await client.getHistoryDaily(DEV_PARK, W); check("history: still fresh just under 1 h", r3.ok && r3.meta.origin === "cache");
      t += 2_000; await client.getHistoryDaily(DEV_PARK, W); check("history: refetched after 1 h", calls.length === 2); }
    { const { client } = mka(() => devRes(200, body({ range: { from: "2026-11-06", to: "2026-11-12" } })));
      const r = await client.getHistoryDaily(DEV_PARK, W); check("history: answered window ≠ requested window → invalid_payload (never cached)", !r.ok && r.error.kind === "invalid_payload"); }
    { const { client, calls } = mka(() => devRes(200, body()));
      const a = await client.getHistoryDaily("nope", W); const b = await client.getHistoryDaily(DEV_PARK, { from: "2026-11-01", to: "2026-11-13" }); const c = await client.getHistoryDaily(DEV_PARK, { from: "2026-11-13", to: "2026-11-07" });
      check("history: bad id / >7-day (anonymous) / reversed range → invalid_request with no network call", !a.ok && !b.ok && !c.ok && calls.length === 0 && [a, b, c].every((x) => !x.ok && x.error.kind === "invalid_request")); }
    // Stale-if-error (24 h) and flagged.
    { let fail = false; const { client } = mka(() => (fail ? devRes(500, {}) : devRes(200, body())));
      await client.getHistoryDaily(DEV_PARK, W); fail = true; t += 2 * 3_600_000;
      const r = await client.getHistoryDaily(DEV_PARK, W); check("history: failed refresh serves flagged stale data within 24 h", r.ok && r.meta.origin === "stale");
      t += 23 * 3_600_000; const r2 = await client.getHistoryDaily(DEV_PARK, W); check("history: beyond 24 h the failure surfaces", !r2.ok); }
    // Separate rate-limit pools: a history 429 must not block live, and vice versa.
    { let hist429 = true; const { client } = mka((u) => (u.includes("/history/") ? (hist429 ? devRes(429, {}, { "retry-after": "120" }) : devRes(200, body())) : devRes(200, DEV_LIVE)));
      const h1 = await client.getHistoryDaily(DEV_PARK, W);
      const lv = await client.getLive(DEV_PARK);
      check("history 429 → rate_limited, live calls unaffected", !h1.ok && h1.error.kind === "rate_limited" && lv.ok);
      const h2 = await client.getHistoryDaily(DEV_PARK, W); check("history backoff holds without a network call", !h2.ok && h2.error.kind === "rate_limited"); hist429 = false; }
    { let live429 = true; const { client } = mka((u) => (u.includes("/history/") ? devRes(200, body()) : live429 ? devRes(429, {}, { "retry-after": "120" }) : devRes(200, DEV_LIVE)));
      const lv = await client.getLive(DEV_PARK); const hh = await client.getHistoryDaily(DEV_PARK, W); live429 = false;
      check("live 429 does not block history", !lv.ok && lv.error.kind === "rate_limited" && hh.ok); }
    // Local budget: at most HISTORY_MAX_CALLS_PER_HOUR network attempts per rolling hour.
    { const { client, calls } = mka(() => devRes(200, body()));
      const ranges = Array.from({ length: HISTORY_MAX_CALLS_PER_HOUR + 3 }, (_, i) => { const d = new Date(Date.UTC(2026, 10, 7 + i)); const to = new Date(Date.UTC(2026, 10, 13 + i)); return { from: d.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }; });
      let blocked = 0; for (const r of ranges) { const res = await client.getHistoryDaily(DEV_PARK, r); if (!res.ok && res.error.kind === "rate_limited") blocked++; }
      check(`history: budget caps network attempts at ${HISTORY_MAX_CALLS_PER_HOUR}/hour (rest rate_limited, no call)`, calls.length === HISTORY_MAX_CALLS_PER_HOUR && blocked === 3 && HISTORY_MAX_CALLS_PER_HOUR < 60);
      t += 3_601_000; const again = await client.getHistoryDaily(DEV_PARK, ranges[0]); check("history: budget recovers after the rolling hour", again.ok); }
  }

  // Phase 14.4.2 authenticated history (30 d / 600 per hour) vs anonymous (7 d / 60 per hour).
  {
    const KEY = "dev-secret-key-0123456789";
    const W30 = { from: "2026-10-15", to: "2026-11-13" };
    const W7 = { from: "2026-11-07", to: "2026-11-13" };
    const day = (date: string) => ({ date, showCount: 1, operatingMinutes: 600, inParkHours: { scheduledMinutes: 870 } });
    const bodyFor = (r: { from: string; to: string }, over: Record<string, unknown> = {}) => ({ id: DEV_PARK, name: "P", timezone: "America/New_York", range: r, next: null, entities: [{ id: "a0613b70-293f-4a5b-8169-1357be1777c6", entityType: "SHOW", days: [day(r.to)] }], ...over });
    const rangeOf = (u: string) => { const m = /from=([\d-]+)&to=([\d-]+)/.exec(u); return m ? { from: m[1], to: m[2] } : W7; };
    const hdr = (init: RequestInit, name: string) => (init.headers as Record<string, string> | undefined)?.[name];
    const okHandler = (u: string) => devRes(200, bodyFor(rangeOf(u)));
    const leaks = (v: unknown) => JSON.stringify(v).includes(KEY);

    { const { client, calls } = mk(okHandler, { apiKey: KEY });
      const acc = client.historyAccess();
      const r30 = await client.getHistoryDaily(DEV_PARK, W30);
      await client.getLive(DEV_PARK);
      const h = calls.find((c) => c.url.includes("/history/"))!; const l = calls.find((c) => c.url.includes("/live"))!;
      check("auth: key → authenticated tier, 30-day window", acc.tier === "authenticated" && acc.maxDays === 30 && r30.ok);
      check("auth: x-api-key sent on the history request only (never live, never in the URL)", hdr(h.init, "x-api-key") === KEY && hdr(l.init, "x-api-key") === undefined && !h.url.includes(KEY) && !l.url.includes(KEY));
      const over = await client.getHistoryDaily(DEV_PARK, { from: "2026-10-14", to: "2026-11-13" });
      check("auth: 31 days is refused locally (no network)", !over.ok && over.error.kind === "invalid_request" && calls.filter((c) => c.url.includes("/history/")).length === 1);
      check("auth: no secret in results or errors", !leaks(r30) && !leaks(over) && !leaks(acc)); }
    for (const [label, key] of [["missing (env)", undefined], ["null", null], ["blank", "   "], ["control chars", "bad\nkey"]] as const) {
      const saved = process.env.THEMEPARKS_API_KEY; delete process.env.THEMEPARKS_API_KEY;
      try {
        const { client, calls } = mk(okHandler, key === undefined ? {} : { apiKey: key });
        const acc = client.historyAccess(); const r30 = await client.getHistoryDaily(DEV_PARK, W30); const r7 = await client.getHistoryDaily(DEV_PARK, W7);
        check(`anon (${label}): 7-day anonymous tier, 30-day refused locally, no key header`, acc.tier === "anonymous" && acc.maxDays === 7 && !r30.ok && r7.ok && calls.length === 1 && hdr(calls[0].init, "x-api-key") === undefined);
      } finally { if (saved !== undefined) process.env.THEMEPARKS_API_KEY = saved; }
    }
    { const saved = process.env.THEMEPARKS_API_KEY; process.env.THEMEPARKS_API_KEY = KEY;
      try { const { client, calls } = mk(okHandler); const r = await client.getHistoryDaily(DEV_PARK, W30);
        check("env: THEMEPARKS_API_KEY read server-side at request time", r.ok && client.historyAccess().tier === "authenticated" && hdr(calls[0].init, "x-api-key") === KEY);
      } finally { if (saved === undefined) delete process.env.THEMEPARKS_API_KEY; else process.env.THEMEPARKS_API_KEY = saved; } }
    // Provider semantics verified live: >7 days without a (valid) key is 403 HISTORY_WINDOW_EXCEEDED.
    const windowErr = () => devRes(403, { error: { type: "HISTORY_WINDOW_EXCEEDED", message: "Requests without an API key can see history back to 2026-11-07 (7 days).", earliestAllowedDate: "2026-11-07" } });
    { const { client, calls } = mk(() => windowErr(), { apiKey: KEY }); t = 5_000_000;
      const r = await client.getHistoryDaily(DEV_PARK, W30);
      check("auth: provider ignores a bad key (403 HISTORY_WINDOW_EXCEEDED) → history_window, key cooled down, tier → anonymous", !r.ok && r.error.kind === "history_window" && client.historyAccess().tier === "anonymous" && client.historyAccess().maxDays === 7);
      check("auth: the rejected key is no longer sent", await (async () => { await client.getHistoryDaily(DEV_PARK, { from: "2026-11-06", to: "2026-11-12" }); return hdr(calls[calls.length - 1].init, "x-api-key") === undefined; })());
      check("auth: no secret in the failure", !leaks(r));
      t += KEY_REJECT_COOLDOWN_MS + 1; check("auth: key retried after the cooldown", client.historyAccess().tier === "authenticated"); }
    { const { client } = mk(() => devRes(401, { error: "nope" }), { apiKey: KEY });
      const r = await client.getHistoryDaily(DEV_PARK, W30);
      check("auth: 401 → unauthorized, key cooled down", !r.ok && r.error.kind === "unauthorized" && client.historyAccess().tier === "anonymous" && !leaks(r)); }
    { const { client } = mk(() => devRes(403, { error: { type: "FORBIDDEN" } }), { apiKey: KEY });
      const r = await client.getHistoryDaily(DEV_PARK, W30);
      check("auth: other 403 → unauthorized (not a window error)", !r.ok && r.error.kind === "unauthorized" && client.historyAccess().tier === "anonymous"); }
    { const { client } = mk(() => windowErr(), { apiKey: null });
      const r = await client.getHistoryDaily(DEV_PARK, W7);
      check("anon: 403 with no key never marks anything rejected", !r.ok && r.error.kind === "history_window" && client.historyAccess().tier === "anonymous"); }
    { const { client } = mk(() => devRes(403, "<html>"), { apiKey: KEY });
      const r = await client.getHistoryDaily(DEV_PARK, W30);
      check("auth: unparseable 403 body → unauthorized, no provider text surfaced", !r.ok && r.error.kind === "unauthorized" && !/html/i.test(r.error.message)); }
    // 429 / quota: per-tier pools; live untouched.
    { let on429 = true; const { client } = mk((u) => (u.includes("/history/") ? (on429 ? devRes(429, {}, { "retry-after": "90" }) : okHandler(u)) : devRes(200, DEV_LIVE)), { apiKey: KEY }); t = 6_000_000;
      const a = await client.getHistoryDaily(DEV_PARK, W30); const lv = await client.getLive(DEV_PARK); const b = await client.getHistoryDaily(DEV_PARK, W30);
      check("auth: history 429 → rate_limited with Retry-After backoff; live unaffected; no network while backing off", !a.ok && a.error.kind === "rate_limited" && lv.ok && !b.ok && b.error.kind === "rate_limited"); on429 = false;
      t += 91_000; const c = await client.getHistoryDaily(DEV_PARK, W30); check("auth: backoff ends after Retry-After", c.ok); }
    { const { client, calls } = mk((u) => devRes(200, bodyFor(rangeOf(u)), { "ratelimit-history-limit": "600", "ratelimit-history-policy": "600;w=3600", "ratelimit-history-remaining": "20", "ratelimit-history-reset": "120" }), { apiKey: KEY }); t = 7_000_000;
      const r1 = await client.getHistoryDaily(DEV_PARK, W30);
      const r2 = await client.getHistoryDaily(DEV_PARK, { from: "2026-10-14", to: "2026-11-12" });
      check("quota: remaining 20/600 (3.3% ≤ 5% reserve) → the first answer is used, the next call is held without network", r1.ok && !r2.ok && r2.error.kind === "rate_limited" && calls.length === 1);
      t += 121_000; const r3 = await client.getHistoryDaily(DEV_PARK, { from: "2026-10-14", to: "2026-11-12" }); check("quota: resumes after the provider's reported reset", r3.ok && calls.length === 2); }
    { const { client, calls } = mk((u) => devRes(200, bodyFor(rangeOf(u)), { "ratelimit-history-limit": "600", "ratelimit-history-remaining": "400", "ratelimit-history-reset": "3000" }), { apiKey: KEY }); t = 8_000_000;
      await client.getHistoryDaily(DEV_PARK, W30); const r2 = await client.getHistoryDaily(DEV_PARK, { from: "2026-10-14", to: "2026-11-12" });
      check("quota: plenty remaining → no hold", r2.ok && calls.length === 2); }
    { const { client } = mk((u) => devRes(200, bodyFor(rangeOf(u)), { "ratelimit-history-limit": "60", "ratelimit-history-remaining": "2", "ratelimit-history-reset": "7200" }), { apiKey: null }); t = 9_000_000;
      await client.getHistoryDaily(DEV_PARK, W7); const r2 = await client.getHistoryDaily(DEV_PARK, { from: "2026-11-06", to: "2026-11-12" });
      check("quota: anonymous pool (60/h) also honored; wait capped at 1 h", !r2.ok && r2.error.kind === "rate_limited" && (r2.error.retryAfterMs ?? 0) <= 3_600_000); }
    // Local caps per tier (per instance; the provider pool is shared by every instance).
    { const { client, calls } = mk(okHandler, { apiKey: KEY }); t = 10_000_000;
      const ranges = Array.from({ length: HISTORY_MAX_CALLS_PER_HOUR_AUTH + 2 }, (_, i) => ({ from: new Date(Date.UTC(2026, 9, 15 + i)).toISOString().slice(0, 10), to: new Date(Date.UTC(2026, 10, 13 + i)).toISOString().slice(0, 10) }));
      let blocked = 0; for (const r of ranges) { const x = await client.getHistoryDaily(DEV_PARK, r); if (!x.ok && x.error.kind === "rate_limited") blocked++; }
      check(`auth: local cap ${HISTORY_MAX_CALLS_PER_HOUR_AUTH}/hour (< provider 600)`, calls.length === HISTORY_MAX_CALLS_PER_HOUR_AUTH && blocked === 2 && HISTORY_MAX_CALLS_PER_HOUR_AUTH < 600); }
    // Cache: 30-day payload cached 1 h; stale-if-error flagged; window identity enforced.
    { const { client, calls } = mk(okHandler, { apiKey: KEY }); t = 11_000_000;
      const a = await client.getHistoryDaily(DEV_PARK, W30); const b = await client.getHistoryDaily(DEV_PARK, W30);
      check("auth: second 30-day request served from cache", a.ok && b.ok && b.meta.origin === "cache" && calls.length === 1); }
    { const { client } = mk(() => devRes(200, bodyFor({ from: "2026-11-07", to: "2026-11-13" })), { apiKey: KEY });
      const r = await client.getHistoryDaily(DEV_PARK, W30);
      check("auth: provider answering a narrower window than asked → invalid_payload (never trusted as 30 days)", !r.ok && r.error.kind === "invalid_payload"); }
    // Redaction of transport errors.
    { const { client } = mk(() => { throw new TypeError(`connect failed using header ${KEY}`); }, { apiKey: KEY });
      const r = await client.getHistoryDaily(DEV_PARK, W30);
      check("auth: transport error text is redacted", !r.ok && r.error.kind === "network" && !leaks(r) && /redacted/.test(r.error.message)); }
    // Live behaviour is unchanged by a configured key.
    { const withKey = mk(() => devRes(200, DEV_LIVE), { apiKey: KEY }); const without = mk(() => devRes(200, DEV_LIVE), { apiKey: null });
      const a = await withKey.client.getLive(DEV_PARK); const b = await without.client.getLive(DEV_PARK);
      check("live: identical request/response with or without a key (no credential header)", a.ok && b.ok && JSON.stringify(withKey.calls[0].init.headers) === JSON.stringify(without.calls[0].init.headers)); }
  }

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

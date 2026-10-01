/**
 * entertainmentShowtimes.ts — Phase 12.3 normalized Entertainment showtimes.
 *
 * The single server-side boundary between ThemeParks.wiki live data and any
 * consumer that wants "today's showtimes for a curated DWP Entertainment
 * entry". It sits above the existing ThemeParks client (themeParksApi.ts) and
 * the explicit DWP→provider UUID mapping (themeParksEntertainmentMapping.ts);
 * consumers (Wait Times today, Today/Tom later) must use this output and never
 * interpret or join raw provider data themselves.
 *
 * Scope: only active curated DWP Entertainment (ENTERTAINMENT_PLACES) for one
 * park is ever returned. Provider entities are resolved solely via explicit
 * mapped UUIDs — no name matching, no provider-only entries. DWP stays the
 * identity authority; Queue-Times stays attraction wait/open authority.
 *
 * Normalized per-entry `status`:
 *   upcoming     ≥1 known performance today not yet passed
 *   all_passed   known performances today, all passed  → "No more showtimes today"
 *   none_posted  provider answered; none known today   → "No showtimes posted"
 *   unavailable  provider failed / no usable data      → "Showtimes unavailable"
 *   unmapped     intentionally unmapped; never provider-checked (no message)
 * `stale` (park-level) marks stale-if-error data (provider refresh failed,
 * last good payload served) so it stays distinguishable from current data; it
 * does not change the status. Provider `lastUpdated` is retained as
 * maintenance metadata only — never used as a freshness/trust test.
 *
 * Showtimes are never fabricated. Only provider showtime types in
 * PERFORMANCE_SHOWTIME_TYPES count as performances; other types (notably
 * "Operating", which carries operating hours on meet-and-greet style SHOW
 * entities) are excluded and only counted in `provider` metadata.
 *
 * Completeness: a mapped entry is only claimed empty ("No showtimes posted")
 * when every mapped provider ref is present in the live payload and no
 * showtime that could matter today is of an unrecognized type. A missing ref
 * (live omits dormant entities) or an unrecognized type is uncertainty, so a
 * result with no performances then becomes `unavailable`; usable performances
 * from present refs are still returned, with `incomplete: true`.
 *
 * Client-safe: this module has only type imports from the (server-only)
 * ThemeParks client, so the browser may reuse the pure helpers below
 * (`resolveShowtimesResponse`, `showtimesForDisplay`) to degrade consistently
 * on request failure or resort-local date rollover. The server fetch lives in
 * entertainmentShowtimesService.ts.
 *
 * DEV checks (run manually, returns failing labels): runDevEntertainmentShowtimeCases().
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { ENTERTAINMENT_PLACES } from "./entertainmentSuggestions";
import { PARK_TO_RESORT } from "./parkMetadata";
import { formatResortLocalTime, getResortLocalDate } from "./resortTime";
import type {
  ThemeParksError,
  ThemeParksLive,
  ThemeParksResult,
  ThemeParksShowtime,
} from "./themeParksApi";
import {
  getEntertainmentProviderMapping,
  type EntertainmentProviderMapping,
} from "./themeParksEntertainmentMapping";

// ============================================
// TYPES
// ============================================

export type EntertainmentShowtimeStatus =
  | "upcoming"
  | "all_passed"
  | "none_posted"
  | "unavailable"
  | "unmapped";

/** Consumer-facing copy for non-upcoming states (unmapped intentionally has none). */
export const SHOWTIME_STATUS_MESSAGES: Record<EntertainmentShowtimeStatus, string | null> = {
  upcoming: null,
  all_passed: "No more showtimes today",
  none_posted: "No showtimes posted",
  unavailable: "Showtimes unavailable",
  unmapped: null,
};

/** Compact note shown beside known upcoming times when the schedule is incomplete (not exhaustive). */
export const PARTIAL_SHOWTIMES_NOTE = "More showtimes may be unavailable";

/** Provider showtime `type` values that are real performances. */
export const PERFORMANCE_SHOWTIME_TYPES: readonly string[] = ["Performance Time", "Special Ticketed Event"];
/** Known non-performance types (e.g. operating hours on meet-and-greet SHOW entities): excluded, not uncertain. */
export const NON_PERFORMANCE_SHOWTIME_TYPES: readonly string[] = ["Operating"];
/** Label used in `unrecognizedTypes` for a showtime with no type. */
export const UNTYPED_SHOWTIME_LABEL = "(untyped)";

export interface EntertainmentPerformance {
  /** Offset-aware ISO start, verbatim from the provider. */
  startTime: string;
  endTime: string | null;
  /** Resort-local start, e.g. "7:30 PM". */
  localTime: string;
  /** Provider type label ("Performance Time" | "Special Ticketed Event"). */
  type: string | null;
  /** True when the performance has already passed (end, else start, before now). */
  passed: boolean;
}

export interface EntertainmentShowtimeProviderRef {
  entityId: string;
  /** Entity present in the provider's live payload for this park. */
  present: boolean;
  /** Provider status (OPERATING/CLOSED/...), when present. Metadata only. */
  status: string | null;
  /** Provider's own lastUpdated — maintenance/drift metadata, NOT a trust test. */
  lastUpdated: string | null;
  /** Raw provider showtimes seen (all types, any day). */
  rawShowtimeCount: number;
  /** Showtimes excluded for a known non-performance type (e.g. "Operating"). */
  excludedShowtimeCount: number;
  /** Malformed showtime records the ThemeParks validation discarded for this entity (dates unknown). */
  droppedShowtimeCount: number;
  /** Showtimes (any day) whose type is neither a performance nor a known non-performance type. */
  unrecognizedShowtimeCount: number;
}

export interface EntertainmentShowtimeEntry {
  dwpName: string;
  parkId: ParkId;
  status: EntertainmentShowtimeStatus;
  /** All of today's known performances (resort-local), deduped, ascending. May be non-empty for `unavailable` (incomplete data whose known performances have all passed). */
  performances: EntertainmentPerformance[];
  /** Copy for none_posted/all_passed/unavailable; null otherwise. */
  message: string | null;
  /**
   * True when completeness is uncertain: a mapped ref was absent from the live
   * payload, the payload was fetched on a different resort-local day, a ref had malformed showtime records dropped by validation, or an
   * unrecognized-type showtime falls on today. `performances`
   * may then be partial; with none, the status is `unavailable`.
   */
  incomplete: boolean;
  /** Distinct unrecognized provider showtime types dated today (maintenance metadata). */
  unrecognizedTypes: string[];
  /** Per-ref provider metadata; empty for unmapped/unavailable-by-failure. */
  provider: EntertainmentShowtimeProviderRef[];
  /** Reason, for unmapped entries (from the mapping). */
  unmappedReason?: string;
}

export interface EntertainmentShowtimeMeta {
  origin: "network" | "cache" | "revalidated" | "stale";
  /** Epoch ms the provider last confirmed this payload. */
  fetchedAt: number;
  /** Present iff stale: why the refresh failed. */
  staleReason?: ThemeParksError;
}

export interface ParkEntertainmentShowtimes {
  parkId: ParkId;
  resort: ResortId;
  /** Resort-local calendar date the performances were filtered to. */
  localDate: string;
  /** ISO instant the passed/upcoming split was computed against. */
  asOf: string;
  /** Resort-local date the provider payload was fetched on; null on failure. A value ≠ `localDate` makes every mapped schedule incomplete. */
  fetchedLocalDate: string | null;
  /** True iff the data is stale-if-error (provider refresh failed). */
  stale: boolean;
  /** Provider response metadata; null when the provider call failed outright. */
  meta: EntertainmentShowtimeMeta | null;
  /** Typed provider failure when there was no usable data; null otherwise. */
  error: ThemeParksError | null;
  /** Every active curated Entertainment entry for the park. */
  entries: EntertainmentShowtimeEntry[];
}

// ============================================
// NORMALIZATION (pure)
// ============================================

function toMs(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Single "passed" rule: a performance is passed once its end — or its start,
 * when there is no meaningful end (absent, or not after the start) — is before
 * `nowMs`. No grace period.
 */
export function isPerformancePassed(startMs: number, endMs: number, nowMs: number): boolean {
  return Math.max(startMs, Number.isFinite(endMs) ? endMs : startMs) < nowMs;
}

/** Single status rule over today's known performances (shared by the normalizer and display re-evaluation). */
function statusForPerformances(
  performances: Array<{ passed: boolean }>,
  incomplete: boolean,
): EntertainmentShowtimeStatus {
  if (performances.some((p) => !p.passed)) return "upcoming"; // a known upcoming show is real even if the schedule is partial
  // "No more showtimes" / "none posted" are completeness claims: only complete data may make them.
  if (incomplete) return "unavailable";
  return performances.length > 0 ? "all_passed" : "none_posted";
}

function collectPerformances(
  resort: ResortId,
  localDate: string,
  nowMs: number,
  raw: ThemeParksShowtime[],
): { performances: EntertainmentPerformance[]; unrecognizedTypes: string[] } {
  // start instant → { first-seen record, latest valid end instant seen }
  const byStart = new Map<number, { startTime: string; endTime: string | null; endMs: number; type: string }>();
  const unrecognized = new Set<string>();
  for (const s of raw) {
    const startMs = toMs(s.startTime);
    if (!Number.isFinite(startMs)) continue;
    // Resort-local "today": convert the instant, never trust the string's offset/date part.
    if (getResortLocalDate(resort, new Date(startMs)) !== localDate) continue;
    if (s.type !== null && NON_PERFORMANCE_SHOWTIME_TYPES.includes(s.type)) continue;
    if (s.type === null || !PERFORMANCE_SHOWTIME_TYPES.includes(s.type)) {
      unrecognized.add(s.type ?? UNTYPED_SHOWTIME_LABEL);
      continue;
    }
    const endMs = s.endTime ? toMs(s.endTime) : NaN;
    const existing = byStart.get(startMs);
    if (existing) {
      // Same start from another ref/record: one performance. Keep the LATEST
      // valid end so a longer/in-progress duration is never cut short.
      if (Number.isFinite(endMs) && (!Number.isFinite(existing.endMs) || endMs > existing.endMs)) {
        existing.endTime = s.endTime;
        existing.endMs = endMs;
      }
      continue;
    }
    byStart.set(startMs, { startTime: s.startTime, endTime: s.endTime, endMs, type: s.type });
  }
  // `passed` is computed only after merging, from the final end time.
  const performances = [...byStart.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([startMs, p]): EntertainmentPerformance => ({
      startTime: p.startTime,
      endTime: p.endTime,
      localTime: formatResortLocalTime(resort, new Date(startMs)),
      type: p.type,
      passed: isPerformancePassed(startMs, p.endMs, nowMs),
    }));
  return { performances, unrecognizedTypes: [...unrecognized].sort() };
}

function entryFromMapping(
  m: EntertainmentProviderMapping,
  live: ThemeParksLive | null,
  resort: ResortId,
  localDate: string,
  nowMs: number,
  payloadCurrent: boolean,
): EntertainmentShowtimeEntry {
  const base = { dwpName: m.dwpName, parkId: m.parkId };
  if (m.disposition === "unmapped") {
    return { ...base, status: "unmapped", performances: [], message: null, incomplete: false, unrecognizedTypes: [], provider: [], unmappedReason: m.reason };
  }
  if (!live) {
    return { ...base, status: "unavailable", performances: [], message: SHOWTIME_STATUS_MESSAGES.unavailable, incomplete: true, unrecognizedTypes: [], provider: [] };
  }
  const byId = new Map(live.entries.map((e) => [e.entityId.toLowerCase(), e]));
  const provider: EntertainmentShowtimeProviderRef[] = [];
  const raw: ThemeParksShowtime[] = [];
  let anyAbsent = false;
  let anyDropped = false;
  for (const ref of m.provider) {
    const e = byId.get(ref.entityId.toLowerCase());
    if (!e) anyAbsent = true;
    if (e && e.droppedShowtimes > 0) anyDropped = true;
    const showtimes = e?.showtimes ?? [];
    provider.push({
      entityId: ref.entityId,
      present: !!e,
      status: e?.status ?? null,
      lastUpdated: e?.lastUpdated ?? null,
      rawShowtimeCount: showtimes.length,
      droppedShowtimeCount: e?.droppedShowtimes ?? 0,
      excludedShowtimeCount: showtimes.filter((s) => s.type !== null && NON_PERFORMANCE_SHOWTIME_TYPES.includes(s.type)).length,
      unrecognizedShowtimeCount: showtimes.filter((s) => s.type === null || !(PERFORMANCE_SHOWTIME_TYPES.includes(s.type) || NON_PERFORMANCE_SHOWTIME_TYPES.includes(s.type))).length,
    });
    raw.push(...showtimes);
  }
  const { performances, unrecognizedTypes } = collectPerformances(resort, localDate, nowMs, raw);
  const incomplete = anyAbsent || anyDropped || !payloadCurrent || unrecognizedTypes.length > 0;
  const status = statusForPerformances(performances, incomplete);
  return { ...base, status, performances, message: SHOWTIME_STATUS_MESSAGES[status], incomplete, unrecognizedTypes, provider };
}

/**
 * Pure: turn a provider live result for a park into normalized showtimes for
 * every active curated Entertainment entry in that park. `instant` is "now".
 */
export function normalizeParkEntertainmentShowtimes(
  parkId: ParkId,
  result: ThemeParksResult<ThemeParksLive>,
  instant: Date = new Date(),
): ParkEntertainmentShowtimes {
  const resort = PARK_TO_RESORT[parkId] as ResortId;
  const localDate = getResortLocalDate(resort, instant);
  const nowMs = instant.getTime();
  const live = result.ok ? result.data : null;
  // A cached/stale payload fetched on another resort-local day (e.g. just after
  // midnight) cannot vouch that today's schedule is complete. Same-day cache
  // and stale-if-error are unaffected.
  const fetchedLocalDate = result.ok ? getResortLocalDate(resort, new Date(result.meta.fetchedAt)) : null;
  const payloadCurrent = fetchedLocalDate === localDate;
  const entries: EntertainmentShowtimeEntry[] = [];
  for (const place of ENTERTAINMENT_PLACES) {
    if (place.parkId !== parkId) continue;
    const m = getEntertainmentProviderMapping(place.name, parkId);
    if (!m) {
      // Mapping completeness is enforced elsewhere; absent disposition is not provider-checked either.
      entries.push({ dwpName: place.name, parkId, status: "unmapped", performances: [], message: null, incomplete: false, unrecognizedTypes: [], provider: [], unmappedReason: "No provider disposition" });
      continue;
    }
    entries.push(entryFromMapping(m, live, resort, localDate, nowMs, payloadCurrent));
  }
  return {
    parkId,
    resort,
    localDate,
    asOf: instant.toISOString(),
    fetchedLocalDate,
    stale: result.ok && result.meta.origin === "stale",
    meta: result.ok
      ? { origin: result.meta.origin, fetchedAt: result.meta.fetchedAt, ...(result.meta.staleReason ? { staleReason: result.meta.staleReason } : {}) }
      : null,
    error: result.ok ? null : result.error,
    entries,
  };
}

// ============================================
// DEGRADATION HELPERS (pure, client-safe)
// ============================================

function unavailablePark(parkId: ParkId, instant: Date, message: string): ParkEntertainmentShowtimes {
  return normalizeParkEntertainmentShowtimes(parkId, { ok: false, error: { kind: "network", message } }, instant);
}

/**
 * Browser-side: turn a fetched /api/entertainment/showtimes body into display
 * state. `body` is the parsed JSON, or null when the request failed / was
 * non-2xx / was unparseable. Failure (or a body for a different park, or one
 * that isn't the contract shape) degrades to the normalized "unavailable"
 * state — previously shown showtimes are never retained.
 */
export function resolveShowtimesResponse(
  parkId: ParkId,
  body: unknown,
  instant: Date = new Date(),
): ParkEntertainmentShowtimes {
  const d = body as Partial<ParkEntertainmentShowtimes> | null;
  if (!d || typeof d !== "object" || d.parkId !== parkId || !Array.isArray(d.entries) || typeof d.localDate !== "string") {
    return unavailablePark(parkId, instant, "Showtimes request failed");
  }
  return d as ParkEntertainmentShowtimes;
}

/**
 * Display-time guard: data computed for a previous resort-local day (the page
 * stayed open across midnight and refreshes have not succeeded) is never shown
 * as today's showtimes — it degrades to "unavailable".
 */
export function showtimesForDisplay(
  data: ParkEntertainmentShowtimes | null,
  instant: Date = new Date(),
): ParkEntertainmentShowtimes | null {
  if (!data) return null;
  if (data.localDate === getResortLocalDate(data.resort, instant)) return data;
  return unavailablePark(data.parkId, instant, "Showtimes are for a previous day");
}

/**
 * Display-time view of one entry at `instant`: re-evaluates `passed` from the
 * performance start/end so a card does not keep showing a time that passed
 * since the response was computed, and returns only the performances still to
 * show. Status uses the same completeness rule as the normalizer (incomplete
 * data never becomes all_passed). Entries without performances (none_posted,
 * unavailable-by-failure, unmapped) are returned unchanged.
 */
export function entryDisplayAt(
  entry: EntertainmentShowtimeEntry,
  instant: Date = new Date(),
): {
  status: EntertainmentShowtimeStatus;
  message: string | null;
  remaining: EntertainmentPerformance[];
  /** Upcoming times shown from an incomplete schedule: the list may not be exhaustive. */
  partial: boolean;
} {
  if (entry.performances.length === 0) return { status: entry.status, message: entry.message, remaining: [], partial: false };
  const nowMs = instant.getTime();
  const evaluated = entry.performances.map((p) => ({
    p,
    passed: isPerformancePassed(toMs(p.startTime), p.endTime ? toMs(p.endTime) : NaN, nowMs),
  }));
  const status = statusForPerformances(evaluated, entry.incomplete);
  return {
    status,
    message: SHOWTIME_STATUS_MESSAGES[status],
    remaining: evaluated.filter((e) => !e.passed).map((e) => e.p),
    partial: status === "upcoming" && entry.incomplete,
  };
}

// ============================================
// DEV CASES
// ============================================

/**
 * Run manually from Node (e.g. via tsx), like the other DEV_* helpers:
 *   import { runDevEntertainmentShowtimeCases } from "./entertainmentShowtimes";
 *   console.log(await runDevEntertainmentShowtimeCases()); // [] = all pass
 */
export async function runDevEntertainmentShowtimeCases(): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };

  const FANTASMIC_HS = "42328c39-76ab-4f03-b862-4206c8d9f7bb";
  const HAPPILY = "22b78ed9-a692-47cb-b6a4-6d1224ff67e3";
  const STARLIGHT = "d69261dc-62b8-434c-83bd-93649b43c408";
  const BLUEY_SHOW = "95a9cde3-ff1f-40a3-8276-2477ded688f8";
  const BLUEY_ATTR = "888525b0-5a6f-4b8e-9f07-b6a32812b04d";
  const HALLOWEEN_FW = "0bd8e001-83f8-4c9e-9e14-df5a2d6400c3";
  const HALLOWEEN_PR = "7bedcc70-2443-4b54-9815-b41d3a3a59f2";

  const st = (startTime: string, type: string | null = "Performance Time", endTime: string | null = null): ThemeParksShowtime => ({ type, startTime, endTime });
  const entry = (entityId: string, showtimes: ThemeParksShowtime[], status = "OPERATING", droppedShowtimes = 0) =>
    ({ entityId, name: "x", entityType: "SHOW", parkId: null, externalId: null, status, lastUpdated: "2020-01-01T00:00:00Z", showtimes, droppedShowtimes });
  const live = (entries: ReturnType<typeof entry>[], fetchedAt?: number): ThemeParksResult<ThemeParksLive> => ({
    ok: true,
    data: { entityId: "p", name: "p", timeZone: null, entries, droppedEntries: 0, droppedShowtimes: 0 },
    meta: { origin: "network", fetchedAt: fetchedAt ?? NOW.getTime(), etag: null },
  });
  const find = (r: ParkEntertainmentShowtimes, name: string) => r.entries.find((e) => e.dwpName === name)!;

  // WDW (EDT, -04:00) 2026-10-01; now = 3:00 PM EDT
  const NOW = new Date("2026-10-01T19:00:00Z");

  // Upcoming + ordering + passed split + local time formatting
  {
    const r = normalizeParkEntertainmentShowtimes("hs", live([entry(FANTASMIC_HS, [
      st("2026-10-01T21:00:00-04:00"), st("2026-10-01T10:00:00-04:00"), st("2026-10-01T19:30:00-04:00"),
    ])]), NOW);
    const e = find(r, "Fantasmic!");
    check("upcoming: status", e.status === "upcoming" && e.message === null);
    check("ordering: chronological", e.performances.map((p) => p.localTime).join() === "10:00 AM,7:30 PM,9:00 PM");
    check("passed flag split at now", e.performances.map((p) => p.passed).join() === "true,false,false");
    check("resort-local date retained", r.localDate === "2026-10-01" && r.resort === "WDW" && !r.stale);
  }
  // Dedup (exact repeat; same instant expressed with different offset), keeps an end time
  {
    const e = find(normalizeParkEntertainmentShowtimes("hs", live([entry(FANTASMIC_HS, [
      st("2026-10-01T21:00:00-04:00"), st("2026-10-01T21:00:00-04:00", "Performance Time", "2026-10-01T21:25:00-04:00"), st("2026-10-02T01:00:00Z"),
    ])]), NOW), "Fantasmic!");
    check("dedup: same instant collapses to one", e.performances.length === 1 && e.performances[0].endTime === "2026-10-01T21:25:00-04:00");
  }
  // Date filtering / boundaries (resort-local)
  {
    const e = find(normalizeParkEntertainmentShowtimes("hs", live([entry(FANTASMIC_HS, [
      st("2026-09-30T23:59:00-04:00"),  // yesterday, last minute
      st("2026-10-01T00:00:00-04:00"),  // today, first minute
      st("2026-10-01T23:59:00-04:00"),  // today, last minute
      st("2026-10-02T00:00:00-04:00"),  // tomorrow, first minute
      st("2026-10-02T03:30:00Z"),       // 11:30 PM EDT Oct 1 (UTC says Oct 2) → today
      st("2026-10-01T03:30:00Z"),       // 11:30 PM EDT Sep 30 (UTC says Oct 1) → not today
    ])]), NOW), "Fantasmic!");
    check("date filter: resort-local boundaries", e.performances.map((p) => p.localTime).join() === "12:00 AM,11:30 PM,11:59 PM");
  }
  // DLR uses its own zone: 2026-10-02T03:00Z is 8 PM PDT Oct 1; now = Oct 1 1 PM PDT
  {
    const dlrNow = new Date("2026-10-01T20:00:00Z");
    const e = find(normalizeParkEntertainmentShowtimes("disneyland", live([entry("8c36ff0b-3a32-4d7b-9388-0516c19277db", [
      st("2026-10-02T03:00:00Z"), st("2026-10-02T08:00:00Z"),
    ])]), dlrNow), "Fantasmic!");
    check("date filter: DLR zone (PDT)", e.performances.length === 1 && e.performances[0].localTime === "8:00 PM");
  }
  // All passed
  {
    const e = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T09:00:00-04:00"), st("2026-10-01T10:00:00-04:00")])]), NOW), "Happily Ever After");
    check("all passed: status/message", e.status === "all_passed" && e.message === "No more showtimes today" && e.performances.length === 2 && e.performances.every((p) => p.passed));
  }
  // End time keeps an in-progress performance upcoming
  {
    const e = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T14:45:00-04:00", "Performance Time", "2026-10-01T15:15:00-04:00")])]), NOW), "Happily Ever After");
    check("in progress (end after now) is not passed", e.status === "upcoming");
  }
  // Only tomorrow's/yesterday's known → none posted (not "all passed")
  {
    const e = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-02T21:00:00-04:00"), st("2026-09-30T21:00:00-04:00")])]), NOW), "Happily Ever After");
    check("none today (other days only) → none_posted", e.status === "none_posted" && e.message === "No showtimes posted" && e.performances.length === 0);
  }
  // Empty showtimes / entity absent from a successful payload → none posted
  {
    const r = normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [])]), NOW);
    check("valid-empty showtimes → none_posted", find(r, "Happily Ever After").status === "none_posted" && find(r, "Happily Ever After").provider[0].present);
    const missing = find(r, "Disney Starlight: Dream the Night Away");
    check("mapped entity absent from ok payload → unavailable, never none_posted",
      missing.status === "unavailable" && missing.message === "Showtimes unavailable" && missing.incomplete && !missing.provider[0].present);
    check("complete valid-empty entry is not incomplete", !find(r, "Happily Ever After").incomplete);
  }
  // Known non-performance type ("Operating") is excluded without being uncertain
  {
    const e = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T09:00:00-04:00", "Operating", "2026-10-01T17:00:00-04:00")])]), NOW), "Happily Ever After");
    check("Operating only → none_posted (known type, complete), not a performance",
      e.status === "none_posted" && !e.incomplete && e.provider[0].excludedShowtimeCount === 1 && e.provider[0].unrecognizedShowtimeCount === 0 && e.performances.length === 0);
    const t = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T21:00:00-04:00", "Special Ticketed Event")])]), NOW), "Happily Ever After");
    check("ticketed-event performances count", t.status === "upcoming" && t.performances[0].type === "Special Ticketed Event");
  }
  // Unrecognized / untyped showtime types are uncertainty, never a confident none_posted or a fabricated performance
  {
    const e = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T21:00:00-04:00", "Mystery Type")])]), NOW), "Happily Ever After");
    check("unknown type today only → unavailable, no fabricated performance",
      e.status === "unavailable" && e.incomplete && e.performances.length === 0 && e.unrecognizedTypes.join() === "Mystery Type" && e.provider[0].unrecognizedShowtimeCount === 1);
    const n = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T21:00:00-04:00", null)])]), NOW), "Happily Ever After");
    check("untyped showtime today → unavailable", n.status === "unavailable" && n.unrecognizedTypes.join() === UNTYPED_SHOWTIME_LABEL);
    const o = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-02T21:00:00-04:00", "Mystery Type")])]), NOW), "Happily Ever After");
    check("unknown type on another day does not affect today", o.status === "none_posted" && !o.incomplete && o.provider[0].unrecognizedShowtimeCount === 1);
    const m = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T21:00:00-04:00"), st("2026-10-01T22:00:00-04:00", "Mystery Type")])]), NOW), "Happily Ever After");
    check("known performance + unknown type → performances kept, flagged incomplete",
      m.status === "upcoming" && m.performances.length === 1 && m.incomplete && m.unrecognizedTypes.length === 1);
  }
  // Cross-date provider payloads (cached just after resort-local midnight) cannot vouch for today
  {
    const ms = (iso: string) => new Date(iso).getTime();
    // WDW: now 12:30 AM EDT Oct 2 (04:30Z); payload fetched 11:30 PM EDT Oct 1 (03:30Z) vs 12:10 AM EDT Oct 2 (04:10Z)
    const wNow = new Date("2026-10-02T04:30:00Z");
    const prior = normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [])], ms("2026-10-02T03:30:00Z")), wNow);
    check("WDW prior-day payload: fetchedLocalDate reported, empty → unavailable (not none_posted)",
      prior.localDate === "2026-10-02" && prior.fetchedLocalDate === "2026-10-01" && find(prior, "Happily Ever After").status === "unavailable" && find(prior, "Happily Ever After").incomplete);
    const sameDay = normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [])], ms("2026-10-02T04:10:00Z")), wNow);
    check("WDW same-day payload (after local midnight) → none_posted", sameDay.fetchedLocalDate === "2026-10-02" && find(sameDay, "Happily Ever After").status === "none_posted");
    const priorPast = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-02T00:05:00-04:00")])], ms("2026-10-02T03:30:00Z")), new Date("2026-10-02T05:00:00Z")), "Happily Ever After");
    check("WDW prior-day payload, all passed → unavailable, not all_passed", priorPast.status === "unavailable" && priorPast.incomplete);
    const priorUp = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-02T09:00:00-04:00")])], ms("2026-10-02T03:30:00Z")), wNow), "Happily Ever After");
    check("WDW prior-day payload with a known upcoming performance → upcoming + incomplete", priorUp.status === "upcoming" && priorUp.incomplete);
    // UTC date equals the resort date here, but local dates differ: 11:30 PM EDT Oct 1 is Oct 2 in UTC — local date must decide
    const utcTrap = normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [])], ms("2026-10-02T03:30:00Z")), new Date("2026-10-02T03:45:00Z"));
    check("WDW uses resort-local (not UTC) date for fetchedAt: same local day → none_posted", utcTrap.localDate === "2026-10-01" && utcTrap.fetchedLocalDate === "2026-10-01" && find(utcTrap, "Happily Ever After").status === "none_posted");
    // DLR: now 12:30 AM PDT Oct 2 (07:30Z); fetched 11:30 PM PDT Oct 1 (06:30Z) vs 12:10 AM PDT Oct 2 (07:10Z)
    const dNow = new Date("2026-10-02T07:30:00Z");
    const dPrior = normalizeParkEntertainmentShowtimes("disneyland", live([entry(HALLOWEEN_FW, []), entry(HALLOWEEN_PR, [])], ms("2026-10-02T06:30:00Z")), dNow);
    check("DLR prior-day payload → unavailable", dPrior.fetchedLocalDate === "2026-10-01" && find(dPrior, "Halloween Screams").status === "unavailable");
    const dSame = normalizeParkEntertainmentShowtimes("disneyland", live([entry(HALLOWEEN_FW, []), entry(HALLOWEEN_PR, [])], ms("2026-10-02T07:10:00Z")), dNow);
    check("DLR same-day payload → none_posted", find(dSame, "Halloween Screams").status === "none_posted");
    // 02:30Z Oct 2 is 7:30 PM PDT Oct 1 (still same local day as the payload's 6:00 PM PDT fetch)
    const dEve = normalizeParkEntertainmentShowtimes("disneyland", live([entry(HALLOWEEN_FW, []), entry(HALLOWEEN_PR, [])], ms("2026-10-02T01:00:00Z")), new Date("2026-10-02T02:30:00Z"));
    check("DLR evening: UTC date rolled but resort-local date matches → none_posted", dEve.localDate === "2026-10-01" && find(dEve, "Halloween Screams").status === "none_posted");
    // Stale-if-error from the same local day keeps working; from a prior day it is incomplete
    const mkStale = (fetchedAt: number): ThemeParksResult<ThemeParksLive> => ({
      ...live([entry(HAPPILY, [])], fetchedAt) as Extract<ThemeParksResult<ThemeParksLive>, { ok: true }>,
      meta: { origin: "stale", fetchedAt, etag: null, staleReason: { kind: "http", message: "503", httpStatus: 503 } },
    });
    const sSame = normalizeParkEntertainmentShowtimes("mk", mkStale(ms("2026-10-02T04:10:00Z")), wNow);
    check("same-day stale-if-error: still flagged stale, none_posted", sSame.stale && find(sSame, "Happily Ever After").status === "none_posted");
    const sPrior = normalizeParkEntertainmentShowtimes("mk", mkStale(ms("2026-10-02T03:30:00Z")), wNow);
    check("prior-day stale-if-error: flagged stale and unavailable", sPrior.stale && find(sPrior, "Happily Ever After").status === "unavailable");
    check("failure has no fetchedLocalDate", normalizeParkEntertainmentShowtimes("mk", { ok: false, error: { kind: "timeout", message: "t" } }, wNow).fetchedLocalDate === null);
  }
  // all_passed is a completeness claim: only complete schedules may make it
  {
    const past = [st("2026-10-01T09:00:00-04:00"), st("2026-10-01T10:00:00-04:00")];
    const c = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, past)]), NOW), "Happily Ever After");
    check("complete all-passed → all_passed", c.status === "all_passed" && !c.incomplete && c.message === "No more showtimes today");
    const absent = find(normalizeParkEntertainmentShowtimes("disneyland", live([entry(HALLOWEEN_PR, [st("2026-10-01T09:00:00-07:00")])]), new Date("2026-10-01T22:00:00Z")), "Halloween Screams");
    check("incomplete (absent ref) all-passed → unavailable, known performances retained",
      absent.status === "unavailable" && absent.incomplete && absent.message === "Showtimes unavailable" && absent.performances.length === 1 && absent.performances[0].passed);
    const dropped = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, past, "OPERATING", 1)]), NOW), "Happily Ever After");
    check("incomplete (dropped record) all-passed → unavailable", dropped.status === "unavailable" && dropped.incomplete);
    const unk = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [...past, st("2026-10-01T22:00:00-04:00", "Mystery Type")])]), NOW), "Happily Ever After");
    check("incomplete (unrecognized type) all-passed → unavailable", unk.status === "unavailable" && unk.incomplete);
    const up = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [...past, st("2026-10-01T21:00:00-04:00")], "OPERATING", 1)]), NOW), "Happily Ever After");
    check("incomplete with a known upcoming performance → upcoming + incomplete",
      up.status === "upcoming" && up.incomplete && up.performances.length === 3 && up.performances.filter((p) => !p.passed).length === 1);
  }
  // Passed/end-time semantics and display-time re-evaluation (no grace period)
  {
    // now = 3:00 PM EDT
    const pf = (start: string, end: string | null) => find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st(start, "Performance Time", end)])]), NOW), "Happily Ever After").performances[0];
    check("passed: no end → start cutoff (past)", pf("2026-10-01T14:59:00-04:00", null).passed);
    check("passed: no end → start at now is not passed (no grace, no early drop)", !pf("2026-10-01T15:00:00-04:00", null).passed);
    check("passed: end == start (non-meaningful) → start cutoff", pf("2026-10-01T14:00:00-04:00", "2026-10-01T14:00:00-04:00").passed && !pf("2026-10-01T16:00:00-04:00", "2026-10-01T16:00:00-04:00").passed);
    check("passed: meaningful end keeps it current until it ends", !pf("2026-10-01T14:30:00-04:00", "2026-10-01T15:30:00-04:00").passed && pf("2026-10-01T14:00:00-04:00", "2026-10-01T14:59:00-04:00").passed);
    const e0 = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [
      st("2026-10-01T10:00:00-04:00"), st("2026-10-01T14:30:00-04:00", "Performance Time", "2026-10-01T15:30:00-04:00"), st("2026-10-01T20:00:00-04:00"),
    ])]), NOW), "Happily Ever After");
    check("passed: normalized data keeps ALL of today's performances", e0.performances.length === 3 && e0.performances.map((p) => p.passed).join() === "true,false,false");
    const at = (iso: string) => entryDisplayAt(e0, new Date(iso));
    check("display: only not-passed performances remain", at("2026-10-01T19:00:00Z").remaining.map((p) => p.localTime).join() === "2:30 PM,8:00 PM");
    check("display: re-evaluated later → in-progress dropped once its end passes", at("2026-10-01T19:31:00Z").remaining.map((p) => p.localTime).join() === "8:00 PM");
    const done = at("2026-10-02T00:30:00Z");
    check("display: all passed on complete data → all_passed message", done.status === "all_passed" && done.message === "No more showtimes today" && done.remaining.length === 0);
    const inc = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T10:00:00-04:00")], "OPERATING", 1)]), NOW), "Happily Ever After");
    check("display: all passed on incomplete data → unavailable, never all_passed", entryDisplayAt(inc).status === "unavailable");
    const none = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [])]), NOW), "Happily Ever After");
    check("display: entries without performances unchanged", entryDisplayAt(none).status === "none_posted" && entryDisplayAt(none).remaining.length === 0);
  }
  // Partial indication: known upcoming times from incomplete schedules are flagged, complete ones are not
  {
    const complete = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T21:00:00-04:00")])]), NOW), "Happily Ever After");
    check("partial: complete upcoming schedule is not partial", entryDisplayAt(complete, NOW).status === "upcoming" && !entryDisplayAt(complete, NOW).partial);
    for (const [label, ent] of [
      ["dropped record", entry(HAPPILY, [st("2026-10-01T21:00:00-04:00")], "OPERATING", 1)],
      ["unrecognized type", entry(HAPPILY, [st("2026-10-01T21:00:00-04:00"), st("2026-10-01T22:00:00-04:00", "Mystery Type")])],
    ] as const) {
      const e = find(normalizeParkEntertainmentShowtimes("mk", live([ent]), NOW), "Happily Ever After");
      const d = entryDisplayAt(e, NOW);
      check(`partial: incomplete upcoming (${label}) keeps known times and is flagged`, d.status === "upcoming" && d.partial && d.remaining.length === 1);
    }
    const absent = find(normalizeParkEntertainmentShowtimes("disneyland", live([entry(HALLOWEEN_PR, [st("2026-10-01T21:30:00-07:00")])]), new Date("2026-10-01T16:00:00Z")), "Halloween Screams");
    check("partial: absent ref + known upcoming → partial", entryDisplayAt(absent, new Date("2026-10-01T16:00:00Z")).partial);
    const allPast = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T10:00:00-04:00")], "OPERATING", 1)]), NOW), "Happily Ever After");
    const dp = entryDisplayAt(allPast, NOW);
    check("partial: incomplete + all passed stays unavailable (not partial)", dp.status === "unavailable" && !dp.partial && dp.message === "Showtimes unavailable");
    check("partial: becomes unavailable once the last known time passes", entryDisplayAt(find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T21:00:00-04:00")], "OPERATING", 1)]), NOW), "Happily Ever After"), new Date("2026-10-02T02:00:00Z")).status === "unavailable");
  }
  // Dropped (malformed) showtime records from provider validation are uncertainty, never "none posted"
  {
    const d0 = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [], "OPERATING", 0)]), NOW), "Happily Ever After");
    check("dropped: valid-empty entity (0 drops) → still none_posted", d0.status === "none_posted" && !d0.incomplete && d0.provider[0].droppedShowtimeCount === 0);
    const d1 = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [], "OPERATING", 2)]), NOW), "Happily Ever After");
    check("dropped: malformed records, no valid performance → unavailable, not none_posted",
      d1.status === "unavailable" && d1.incomplete && d1.performances.length === 0 && d1.provider[0].droppedShowtimeCount === 2);
    const d2 = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T21:00:00-04:00")], "OPERATING", 1)]), NOW), "Happily Ever After");
    check("dropped: valid performance retained + incomplete", d2.status === "upcoming" && d2.performances.length === 1 && d2.incomplete);
    const d3 = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [], "OPERATING", 0), entry(STARLIGHT, [], "OPERATING", 3)]), NOW), "Happily Ever After");
    check("dropped: another entity's drops do not contaminate this entry", d3.status === "none_posted" && !d3.incomplete);
    const d4 = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [], "OPERATING", 0), entry(STARLIGHT, [], "OPERATING", 3)]), NOW), "Disney Starlight: Dream the Night Away");
    check("dropped: the affected entity itself is unavailable", d4.status === "unavailable" && d4.incomplete);
    const d5 = find(normalizeParkEntertainmentShowtimes("disneyland", live([entry(HALLOWEEN_FW, [], "OPERATING", 0), entry(HALLOWEEN_PR, [], "OPERATING", 1)]), new Date("2026-10-01T16:00:00Z")), "Halloween Screams");
    check("dropped: any dropped ref on a multi-ref entry blocks none_posted", d5.status === "unavailable" && d5.incomplete);
  }
  // Duplicate start merges the latest end, and `passed` follows the merged performance
  {
    // 3:00 PM EDT now; same 2:45 PM start, first record has no/early end (would be passed), second runs to 3:15 PM
    for (const order of [0, 1]) {
      const a = st("2026-10-01T14:45:00-04:00", "Performance Time", null);
      const b = st("2026-10-01T14:45:00-04:00", "Performance Time", "2026-10-01T15:15:00-04:00");
      const c = st("2026-10-01T14:45:00-04:00", "Performance Time", "2026-10-01T14:50:00-04:00");
      const e = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, order ? [b, a, c] : [a, c, b])]), NOW), "Happily Ever After");
      check(`dup start (order ${order}): latest end wins, in-progress not passed`,
        e.performances.length === 1 && e.performances[0].endTime === "2026-10-01T15:15:00-04:00" && !e.performances[0].passed && e.status === "upcoming");
    }
    const f = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T14:00:00-04:00", "Performance Time", "2026-10-01T14:10:00-04:00"), st("2026-10-01T14:00:00-04:00", "Performance Time", "2026-10-01T14:20:00-04:00")])]), NOW), "Happily Ever After");
    check("dup start: merged end still before now → passed", f.status === "all_passed" && f.performances[0].endTime === "2026-10-01T14:20:00-04:00");
  }
  // Multiple provider refs merge + dedupe; one ref absent is fine
  {
    const e = find(normalizeParkEntertainmentShowtimes("disneyland", live([
      entry(BLUEY_SHOW, [st("2026-10-01T16:45:00-07:00"), st("2026-10-01T11:00:00-07:00")]),
      entry(BLUEY_ATTR, [st("2026-10-01T16:45:00-07:00"), st("2026-10-01T15:25:00-07:00")]),
    ]), new Date("2026-10-01T16:00:00Z")), "Bluey's Best Day Ever!");
    check("multi-ref: merged, deduped, sorted", e.performances.map((p) => p.localTime).join() === "11:00 AM,3:25 PM,4:45 PM" && e.provider.length === 2);
    const h = find(normalizeParkEntertainmentShowtimes("disneyland", live([entry(HALLOWEEN_PR, [st("2026-10-01T21:30:00-07:00")])]), new Date("2026-10-01T16:00:00Z")), "Halloween Screams");
    check("multi-ref: one ref absent still resolves from the other (flagged incomplete)", h.status === "upcoming" && h.provider.length === 2 && h.incomplete && !h.provider.find((p) => p.entityId === HALLOWEEN_FW)!.present);
    const none = find(normalizeParkEntertainmentShowtimes("disneyland", live([entry(HALLOWEEN_PR, [])]), new Date("2026-10-01T16:00:00Z")), "Halloween Screams");
    check("multi-ref: present ref empty but other ref absent → unavailable, not none_posted", none.status === "unavailable" && none.incomplete);
    const both = find(normalizeParkEntertainmentShowtimes("disneyland", live([entry(HALLOWEEN_FW, []), entry(HALLOWEEN_PR, [])]), new Date("2026-10-01T16:00:00Z")), "Halloween Screams");
    check("multi-ref: all refs present and empty → none_posted", both.status === "none_posted" && !both.incomplete);
    const allGone = find(normalizeParkEntertainmentShowtimes("disneyland", live([]), new Date("2026-10-01T16:00:00Z")), "Halloween Screams");
    check("multi-ref: no refs present → unavailable", allGone.status === "unavailable" && allGone.provider.every((p) => !p.present));
  }
  // Failure → unavailable for mapped; unmapped stays unmapped
  {
    const err: ThemeParksResult<ThemeParksLive> = { ok: false, error: { kind: "timeout", message: "t" } };
    const r = normalizeParkEntertainmentShowtimes("mk", err, NOW);
    const mappedE = find(r, "Happily Ever After");
    check("failure: mapped → unavailable", mappedE.status === "unavailable" && mappedE.message === "Showtimes unavailable" && mappedE.performances.length === 0);
    check("failure: error surfaced, not stale", r.error?.kind === "timeout" && !r.stale && r.meta === null);
    const u = find(r, "Mickey's Once Upon a Christmastime Parade");
    check("failure: unmapped is not 'unavailable'", u.status === "unmapped" && u.message === null && !!u.unmappedReason);
  }
  // Unmapped entries on a success payload are not checked as empty
  {
    const r = normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [])]), NOW);
    const u = find(r, "Mickey's Once Upon a Christmastime Parade");
    check("success: unmapped is not none_posted", u.status === "unmapped" && u.provider.length === 0);
    check("only active curated entries for the park", r.entries.every((e) => e.parkId === "mk") && r.entries.length === ENTERTAINMENT_PLACES.filter((p) => p.parkId === "mk").length);
  }
  // Stale-if-error stays distinguishable and keeps data
  {
    const stale: ThemeParksResult<ThemeParksLive> = {
      ...live([entry(HAPPILY, [st("2026-10-01T21:00:00-04:00")])]) as Extract<ThemeParksResult<ThemeParksLive>, { ok: true }>,
      meta: { origin: "stale", fetchedAt: NOW.getTime(), etag: null, staleReason: { kind: "http", message: "503", httpStatus: 503 } },
    };
    const r = normalizeParkEntertainmentShowtimes("mk", stale, NOW);
    check("stale: flagged with reason, data kept", r.stale && r.meta?.origin === "stale" && r.meta.staleReason?.kind === "http" && find(r, "Happily Ever After").status === "upcoming");
    check("current data is not stale", !normalizeParkEntertainmentShowtimes("mk", live([]), NOW).stale);
  }
  // Provider lastUpdated is retained, never used as a trust test (ancient lastUpdated still upcoming)
  {
    const e = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T21:00:00-04:00")])]), NOW), "Happily Ever After");
    check("lastUpdated retained and not a freshness gate", e.status === "upcoming" && e.provider[0].lastUpdated === "2020-01-01T00:00:00Z");
  }
  // Provider status (e.g. CLOSED) does not suppress known showtimes or fabricate any
  {
    const e = find(normalizeParkEntertainmentShowtimes("mk", live([entry(STARLIGHT, [], "CLOSED")]), NOW), "Disney Starlight: Dream the Night Away");
    check("closed with no showtimes → none_posted, status retained as metadata", e.status === "none_posted" && e.provider[0].status === "CLOSED");
  }
  // Browser request failure / rollover degrade through the shared contract (page behavior)
  {
    const good = normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T21:00:00-04:00")])]), NOW);
    check("page: baseline success shows upcoming", find(good, "Happily Ever After").status === "upcoming");
    const failed = resolveShowtimesResponse("mk", null, NOW);
    check("page: failed/non-2xx request → unavailable for mapped (no retained showtimes)",
      find(failed, "Happily Ever After").status === "unavailable" && find(failed, "Happily Ever After").performances.length === 0 &&
      find(failed, "Mickey's Once Upon a Christmastime Parade").status === "unmapped" && failed.error !== null && !failed.stale);
    check("page: success response passes through", resolveShowtimesResponse("mk", good, NOW) === good);
    check("page: body for another park → unavailable", find(resolveShowtimesResponse("epcot", good, NOW), "Luminous The Symphony of Us").status === "unavailable");
    check("page: malformed body → unavailable", resolveShowtimesResponse("mk", { parkId: "mk" }, NOW).error !== null && resolveShowtimesResponse("mk", "x", NOW).error !== null);
    check("page: same-day display keeps data", showtimesForDisplay(good, new Date("2026-10-01T23:00:00Z")) === good);
    const rolled = showtimesForDisplay(good, new Date("2026-10-02T04:30:00Z")); // 12:30 AM EDT Oct 2
    check("page: resort-local date rollover → unavailable, not yesterday's showtimes",
      !!rolled && rolled !== good && find(rolled, "Happily Ever After").status === "unavailable" && rolled.localDate === "2026-10-02");
    // Clock-driven re-evaluation boundaries (the page ticks these every 15 s and on tab visibility)
    check("display clock: 11:59:59 PM EDT still shows today's data", showtimesForDisplay(good, new Date("2026-10-02T03:59:59Z")) === good);
    check("display clock: exactly resort-local midnight stops showing prior-day data", showtimesForDisplay(good, new Date("2026-10-02T04:00:00Z")) !== good);
    const dlrGood = normalizeParkEntertainmentShowtimes("disneyland", live([entry("8c36ff0b-3a32-4d7b-9388-0516c19277db", [st("2026-10-01T20:00:00-07:00")])], new Date("2026-10-01T20:00:00Z").getTime()), new Date("2026-10-01T20:00:00Z"));
    check("display clock: DLR keeps the day until PDT midnight (UTC midnight is irrelevant)",
      showtimesForDisplay(dlrGood, new Date("2026-10-02T06:59:59Z")) === dlrGood && showtimesForDisplay(dlrGood, new Date("2026-10-02T07:00:00Z")) !== dlrGood);
    const ended = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T14:30:00-04:00", "Performance Time", "2026-10-01T15:30:00-04:00")])]), NOW), "Happily Ever After");
    check("display clock: performance disappears the instant after its end, not before",
      entryDisplayAt(ended, new Date("2026-10-01T19:30:00Z")).remaining.length === 1 && entryDisplayAt(ended, new Date("2026-10-01T19:30:00.001Z")).remaining.length === 0);
    check("page: no data → null (loading)", showtimesForDisplay(null, NOW) === null);
  }
  return failures;
}

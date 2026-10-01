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
 * DEV checks (run manually, returns failing labels): runDevEntertainmentShowtimeCases().
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { ENTERTAINMENT_PLACES } from "./entertainmentSuggestions";
import { PARK_TO_RESORT } from "./parkMetadata";
import { formatResortLocalTime, getResortLocalDate } from "./resortTime";
import {
  themeParks,
  type ThemeParksError,
  type ThemeParksLive,
  type ThemeParksResult,
  type ThemeParksShowtime,
} from "./themeParksApi";
import {
  getEntertainmentProviderMapping,
  type EntertainmentProviderMapping,
} from "./themeParksEntertainmentMapping";
import { THEMEPARKS_PARKS } from "./themeParksProviders";

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

/** Provider showtime `type` values that are real performances. */
export const PERFORMANCE_SHOWTIME_TYPES: readonly string[] = ["Performance Time", "Special Ticketed Event"];

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
  /** Showtimes excluded for a non-performance type (e.g. "Operating"). */
  excludedShowtimeCount: number;
}

export interface EntertainmentShowtimeEntry {
  dwpName: string;
  parkId: ParkId;
  status: EntertainmentShowtimeStatus;
  /** All of today's known performances (resort-local), deduped, ascending. Empty unless upcoming/all_passed. */
  performances: EntertainmentPerformance[];
  /** Copy for none_posted/all_passed/unavailable; null otherwise. */
  message: string | null;
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

function collectPerformances(
  resort: ResortId,
  localDate: string,
  nowMs: number,
  raw: ThemeParksShowtime[],
): EntertainmentPerformance[] {
  const byStart = new Map<number, EntertainmentPerformance>();
  for (const s of raw) {
    if (s.type === null || !PERFORMANCE_SHOWTIME_TYPES.includes(s.type)) continue;
    const startMs = toMs(s.startTime);
    if (!Number.isFinite(startMs)) continue;
    // Resort-local "today": convert the instant, never trust the string's offset/date part.
    if (getResortLocalDate(resort, new Date(startMs)) !== localDate) continue;
    const endMs = s.endTime ? toMs(s.endTime) : NaN;
    const existing = byStart.get(startMs);
    if (existing) {
      // Same start from another ref/type: one performance; keep an end time if any ref has one.
      if (!existing.endTime && s.endTime) existing.endTime = s.endTime;
      continue;
    }
    byStart.set(startMs, {
      startTime: s.startTime,
      endTime: s.endTime,
      localTime: formatResortLocalTime(resort, new Date(startMs)),
      type: s.type,
      passed: Math.max(startMs, Number.isFinite(endMs) ? endMs : startMs) < nowMs,
    });
  }
  return [...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

function entryFromMapping(
  m: EntertainmentProviderMapping,
  live: ThemeParksLive | null,
  resort: ResortId,
  localDate: string,
  nowMs: number,
): EntertainmentShowtimeEntry {
  const base = { dwpName: m.dwpName, parkId: m.parkId };
  if (m.disposition === "unmapped") {
    return { ...base, status: "unmapped", performances: [], message: null, provider: [], unmappedReason: m.reason };
  }
  if (!live) {
    return { ...base, status: "unavailable", performances: [], message: SHOWTIME_STATUS_MESSAGES.unavailable, provider: [] };
  }
  const byId = new Map(live.entries.map((e) => [e.entityId.toLowerCase(), e]));
  const provider: EntertainmentShowtimeProviderRef[] = [];
  const raw: ThemeParksShowtime[] = [];
  for (const ref of m.provider) {
    const e = byId.get(ref.entityId.toLowerCase());
    const showtimes = e?.showtimes ?? [];
    provider.push({
      entityId: ref.entityId,
      present: !!e,
      status: e?.status ?? null,
      lastUpdated: e?.lastUpdated ?? null,
      rawShowtimeCount: showtimes.length,
      excludedShowtimeCount: showtimes.filter((s) => s.type === null || !PERFORMANCE_SHOWTIME_TYPES.includes(s.type)).length,
    });
    raw.push(...showtimes);
  }
  const performances = collectPerformances(resort, localDate, nowMs, raw);
  let status: EntertainmentShowtimeStatus;
  if (performances.length === 0) status = "none_posted";
  else status = performances.some((p) => !p.passed) ? "upcoming" : "all_passed";
  return { ...base, status, performances, message: SHOWTIME_STATUS_MESSAGES[status], provider };
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
  const entries: EntertainmentShowtimeEntry[] = [];
  for (const place of ENTERTAINMENT_PLACES) {
    if (place.parkId !== parkId) continue;
    const m = getEntertainmentProviderMapping(place.name, parkId);
    if (!m) {
      // Mapping completeness is enforced elsewhere; absent disposition is not provider-checked either.
      entries.push({ dwpName: place.name, parkId, status: "unmapped", performances: [], message: null, provider: [], unmappedReason: "No provider disposition" });
      continue;
    }
    entries.push(entryFromMapping(m, live, resort, localDate, nowMs));
  }
  return {
    parkId,
    resort,
    localDate,
    asOf: instant.toISOString(),
    stale: result.ok && result.meta.origin === "stale",
    meta: result.ok
      ? { origin: result.meta.origin, fetchedAt: result.meta.fetchedAt, ...(result.meta.staleReason ? { staleReason: result.meta.staleReason } : {}) }
      : null,
    error: result.ok ? null : result.error,
    entries,
  };
}

// ============================================
// SERVICE (server-side)
// ============================================

/** Fetch the park's live payload via the shared ThemeParks client and normalize it. Server-side only. */
export async function getParkEntertainmentShowtimes(
  parkId: ParkId,
  opts: { instant?: Date; getLive?: (id: string) => Promise<ThemeParksResult<ThemeParksLive>> } = {},
): Promise<ParkEntertainmentShowtimes> {
  const getLive = opts.getLive ?? ((id: string) => themeParks.getLive(id));
  const result = await getLive(THEMEPARKS_PARKS[parkId].entityId);
  // `now` is taken after the fetch so passed/upcoming reflects delivery time.
  return normalizeParkEntertainmentShowtimes(parkId, result, opts.instant ?? new Date());
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
  const entry = (entityId: string, showtimes: ThemeParksShowtime[], status = "OPERATING") =>
    ({ entityId, name: "x", entityType: "SHOW", parkId: null, externalId: null, status, lastUpdated: "2020-01-01T00:00:00Z", showtimes });
  const live = (entries: ReturnType<typeof entry>[]): ThemeParksResult<ThemeParksLive> => ({
    ok: true,
    data: { entityId: "p", name: "p", timeZone: null, entries, droppedEntries: 0, droppedShowtimes: 0 },
    meta: { origin: "network", fetchedAt: 1, etag: null },
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
    check("entity absent from ok payload → none_posted (not unavailable)", find(r, "Disney Starlight: Dream the Night Away").status === "none_posted" && !find(r, "Disney Starlight: Dream the Night Away").provider[0].present);
  }
  // Non-performance types excluded, never fabricated
  {
    const e = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T09:00:00-04:00", "Operating", "2026-10-01T17:00:00-04:00"), st("2026-10-01T21:00:00-04:00", null)])]), NOW), "Happily Ever After");
    check("operating-hours/untyped showtimes are not performances", e.status === "none_posted" && e.provider[0].excludedShowtimeCount === 2 && e.provider[0].rawShowtimeCount === 2);
    const t = find(normalizeParkEntertainmentShowtimes("mk", live([entry(HAPPILY, [st("2026-10-01T21:00:00-04:00", "Special Ticketed Event")])]), NOW), "Happily Ever After");
    check("ticketed-event performances count", t.status === "upcoming" && t.performances[0].type === "Special Ticketed Event");
  }
  // Multiple provider refs merge + dedupe; one ref absent is fine
  {
    const e = find(normalizeParkEntertainmentShowtimes("disneyland", live([
      entry(BLUEY_SHOW, [st("2026-10-01T16:45:00-07:00"), st("2026-10-01T11:00:00-07:00")]),
      entry(BLUEY_ATTR, [st("2026-10-01T16:45:00-07:00"), st("2026-10-01T15:25:00-07:00")]),
    ]), new Date("2026-10-01T16:00:00Z")), "Bluey's Best Day Ever!");
    check("multi-ref: merged, deduped, sorted", e.performances.map((p) => p.localTime).join() === "11:00 AM,3:25 PM,4:45 PM" && e.provider.length === 2);
    const h = find(normalizeParkEntertainmentShowtimes("disneyland", live([entry(HALLOWEEN_PR, [st("2026-10-01T21:30:00-07:00")])]), new Date("2026-10-01T16:00:00Z")), "Halloween Screams");
    check("multi-ref: one ref absent still resolves from the other", h.status === "upcoming" && h.provider.length === 2 && !h.provider.find((p) => p.entityId === HALLOWEEN_FW)!.present);
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
      meta: { origin: "stale", fetchedAt: 5, etag: null, staleReason: { kind: "http", message: "503", httpStatus: 503 } },
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
  // Service wiring: uses the park's provider UUID and injected clock
  {
    let asked = "";
    const r = await getParkEntertainmentShowtimes("mk", { instant: NOW, getLive: async (id) => { asked = id; return live([entry(HAPPILY, [st("2026-10-01T21:00:00-04:00")])]); } });
    check("service: queries the park's ThemeParks UUID", asked === THEMEPARKS_PARKS.mk.entityId && find(r, "Happily Ever After").status === "upcoming");
  }
  return failures;
}

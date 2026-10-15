/**
 * todayDashboard.ts — pure presentation helpers for the Today dashboard
 * (Phase 12.10). No new data source: it only ranks the existing Queue-Times
 * dataset (`AttractionWait[]`) and reduces the existing normalized
 * Entertainment showtimes (`ParkEntertainmentShowtimes`, via `entryDisplayAt`)
 * into the next few individual upcoming performances. Client-safe and pure.
 *
 * Never fabricates: unmapped entries contribute nothing, and any incomplete or
 * unavailable mapped schedule is surfaced as a `partial` flag so the list is
 * never presented as exhaustive when it may not be.
 */

import type { AttractionWait } from "@disney-wait-planner/shared";
import type { ParkHours } from "./parkHours";
import {
  entryDisplayAt,
  type ParkEntertainmentShowtimes,
} from "./entertainmentShowtimes";

export const TODAY_LIST_COUNT = 5;
export const TODAY_NEXT_SHOWS_COUNT = 3;

// ============================================
// WAIT RANKINGS
// ============================================

/** OPERATING with a finite, non-negative posted wait. Closed/down/invalid are excluded. */
export function isRankableWait(a: AttractionWait): boolean {
  return a.status === "OPERATING" && typeof a.waitMins === "number" && Number.isFinite(a.waitMins) && a.waitMins >= 0;
}

/** True when the displayed wait is DWP mock/fallback, per the explicit `waitSource` provenance field (never inferred). */
export function isFallbackWait(a: AttractionWait): boolean {
  return a.waitSource === "fallback";
}

/**
 * Attractions eligible for the Today rankings. When the dataset is live, a
 * partial Queue-Times payload still carries unmatched catalog rides with
 * fallback (mock) waits; those are NOT confirmed live and must not be ranked
 * (or shown) as the park's current shortest/longest wait, so only
 * non-fallback rows qualify. In mock mode (`dataSource: "mock"`) everything is
 * fallback by definition, so all rows stay eligible — the rows are labelled
 * "Fallback wait · not live" by the page and the footer already says Mock.
 */
export function selectRankableAttractions(
  attractions: AttractionWait[],
  dataSource: "live" | "mock",
): AttractionWait[] {
  return dataSource === "live" ? attractions.filter((a) => !isFallbackWait(a)) : attractions;
}

/** Copy for the Entertainment section: scoped to DWP's curated shows, never "all park entertainment". */
export const NEXT_SHOWS_HEADING = "Next Up: Curated Shows";
export const NEXT_SHOWS_SCOPE_NOTE = "DWP-curated shows with posted times \u2014 not all park entertainment.";
export const NEXT_SHOWS_NONE_REMAINING = "No more curated showtimes today";
export const FALLBACK_WAIT_LABEL = "Fallback wait \u00b7 not live";

/** Lowest operating waits, ascending (stable: dataset order breaks ties). */
export function rankLowestWaits(attractions: AttractionWait[], count = TODAY_LIST_COUNT): AttractionWait[] {
  return attractions.filter(isRankableWait).sort((a, b) => (a.waitMins as number) - (b.waitMins as number)).slice(0, count);
}

/** Highest operating waits, descending (stable: dataset order breaks ties). Overlap with the lowest list is allowed. */
export function rankHighestWaits(attractions: AttractionWait[], count = TODAY_LIST_COUNT): AttractionWait[] {
  return attractions.filter(isRankableWait).sort((a, b) => (b.waitMins as number) - (a.waitMins as number)).slice(0, count);
}

// ============================================
// PARK OPERATING STATUS
// ============================================

export type ParkOperatingKind =
  | "open" // now inside a regular OPERATING window
  | "before_open" // before today's first regular opening
  | "between" // between two regular windows
  | "closed_after_hours" // after today's last regular closing
  | "closed_today" // provider data safely establishes no operation today
  | "unknown"; // loading / unavailable / unverifiable — never guessed

export interface ParkOperatingStatus {
  kind: ParkOperatingKind;
  /** Compact indicator copy; null when nothing may be claimed. */
  text: string | null;
  /** The park is confirmed closed right now by the schedule (never inferred from wait data). */
  confirmedClosed: boolean;
  /** Derived from stale-if-error schedule data. */
  stale: boolean;
}

const UNKNOWN_STATUS: ParkOperatingStatus = { kind: "unknown", text: null, confirmedClosed: false, stale: false };

/**
 * Compact operating status for the selected park from the existing normalized
 * `ParkHours` (already display-guarded for park and resort-local day). Only
 * regular `OPERATING` windows count — ticketed/extra-hours windows live in
 * `additional` and never make the park "open". Times are the resort-local
 * strings the normalizer already produced. Anything other than `hours`/`closed`
 * yields `unknown` with no text.
 */
export function describeParkOperatingStatus(data: ParkHours | null, instant: Date): ParkOperatingStatus {
  if (!data) return UNKNOWN_STATUS;
  const stale = data.stale;
  if (data.status === "closed") {
    return { kind: "closed_today", text: "Closed today", confirmedClosed: true, stale };
  }
  if (data.status !== "hours") return UNKNOWN_STATUS;

  const nowMs = instant.getTime();
  const wins = data.operating
    .map((w) => ({ w, open: Date.parse(w.openingTime), close: Date.parse(w.closingTime) }))
    .filter((x) => Number.isFinite(x.open) && Number.isFinite(x.close) && x.close > x.open)
    .sort((a, b) => a.open - b.open);
  if (wins.length === 0) return UNKNOWN_STATUS;

  const current = wins.find((x) => x.open <= nowMs && nowMs < x.close);
  if (current) return { kind: "open", text: `Open \u00b7 closes ${current.w.closes}`, confirmedClosed: false, stale };
  const next = wins.find((x) => x.open > nowMs);
  if (next) {
    const first = next === wins[0];
    return {
      kind: first ? "before_open" : "between",
      text: first ? `Opens ${next.w.opens}` : `Closed \u00b7 reopens ${next.w.opens}`,
      confirmedClosed: true,
      stale,
    };
  }
  return { kind: "closed_after_hours", text: "Closed for today", confirmedClosed: true, stale };
}

/** Empty-state copy for the wait lists. Closure comes only from the schedule, never from missing Queue-Times data. */
export const PARK_CLOSED_WAITS_MESSAGE = "Park is currently closed.";
export const LIVE_WAITS_UNAVAILABLE_MESSAGE = "Live wait times unavailable.";

/**
 * Message for an empty ranking, or null when there is nothing to explain
 * (still loading, or the list has rows). Confirmed-closed park → closed copy;
 * otherwise (open/unknown) → "Live wait times unavailable." — including when
 * every row was an excluded fallback value.
 */
export function waitListEmptyMessage(args: {
  waitsLoaded: boolean;
  rowCount: number;
  parkConfirmedClosed: boolean;
}): string | null {
  if (!args.waitsLoaded || args.rowCount > 0) return null;
  return args.parkConfirmedClosed ? PARK_CLOSED_WAITS_MESSAGE : LIVE_WAITS_UNAVAILABLE_MESSAGE;
}

// ============================================
// NEXT ENTERTAINMENT PERFORMANCES
// ============================================

export interface TodayUpcomingPerformance {
  dwpName: string;
  /** Resort-local start, e.g. "7:30 PM". */
  localTime: string;
  startMs: number;
}

export type TodayNextShowsState =
  | "loading"
  | "upcoming" // ≥1 known upcoming performance (see `partial`)
  | "none_remaining" // complete schedules, nothing left today
  | "unavailable"; // provider failure / no usable or complete data

export interface TodayNextShows {
  state: TodayNextShowsState;
  performances: TodayUpcomingPerformance[];
  /** Upcoming shown, but some mapped schedule is incomplete/unavailable: the list may not be exhaustive. */
  partial: boolean;
  /** True when ThemeParks.wiki data is being presented (attribution owed). */
  presentsProviderData: boolean;
  /** Stale-if-error data behind an upcoming/none_remaining result: never present it as definitively complete. */
  stale: boolean;
}

/**
 * Next `count` individual performances across all mapped curated Entertainment
 * entries, ascending by start (name breaks ties). `data` must already be the
 * display-guarded, selected-park value (null = still loading). Passed times are
 * re-evaluated against `instant`.
 */
export function selectNextShows(
  data: ParkEntertainmentShowtimes | null,
  instant: Date,
  count = TODAY_NEXT_SHOWS_COUNT,
): TodayNextShows {
  if (!data) return { state: "loading", performances: [], partial: false, presentsProviderData: false, stale: false };
  if (data.error) return { state: "unavailable", performances: [], partial: false, presentsProviderData: false, stale: false };

  const mapped = data.entries.filter((e) => e.status !== "unmapped");
  const nowMs = instant.getTime();
  const all: TodayUpcomingPerformance[] = [];
  let uncertain = false;
  for (const entry of mapped) {
    const d = entryDisplayAt(entry, instant);
    if (d.status === "unavailable" || d.partial) uncertain = true;
    for (const p of d.remaining) {
      const startMs = new Date(p.startTime).getTime();
      // Future-facing list: a performance already underway (end still ahead) is not "next".
      if (Number.isFinite(startMs) && startMs > nowMs) all.push({ dwpName: entry.dwpName, localTime: p.localTime, startMs });
    }
  }
  all.sort((a, b) => a.startMs - b.startMs || a.dwpName.localeCompare(b.dwpName));
  const performances = all.slice(0, count);

  if (performances.length > 0) {
    return { state: "upcoming", performances, partial: uncertain, presentsProviderData: true, stale: data.stale };
  }
  if (mapped.length === 0) return { state: "unavailable", performances: [], partial: false, presentsProviderData: false, stale: false };
  // No known upcoming: only a complete schedule may claim nothing remains.
  return uncertain
    ? { state: "unavailable", performances: [], partial: false, presentsProviderData: true, stale: false }
    : { state: "none_remaining", performances: [], partial: false, presentsProviderData: true, stale: data.stale };
}

// ============================================
// DEV CASES
// ============================================

/**
 * Run manually from Node (e.g. via tsx), like the other DEV_* helpers:
 *   import { runDevTodayDashboardCases } from "./todayDashboard";
 *   console.log(runDevTodayDashboardCases()); // [] = all pass
 */
export function runDevTodayDashboardCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };

  const ride = (id: string, waitMins: number | null | undefined, status: string = "OPERATING", waitSource: string = "live"): AttractionWait =>
    ({ id, name: id, waitMins, status, waitSource } as unknown as AttractionWait);
  const ids = (l: AttractionWait[]) => l.map((a) => a.id).join();

  // Rankings
  {
    const data = [
      ride("a", 30), ride("b", 5), ride("c", 90), ride("d", 45), ride("e", 10), ride("f", 60), ride("g", 20),
      ride("down", 0, "DOWN"), ride("closed", 120, "CLOSED"), ride("nan", NaN), ride("nul", null), ride("neg", -5),
    ];
    check("lowest: ascending top 5, invalid excluded", ids(rankLowestWaits(data)) === "b,e,g,a,d");
    check("highest: descending top 5, invalid excluded", ids(rankHighestWaits(data)) === "c,f,d,a,g");
    check("input not mutated", data[0].id === "a" && data.length === 12);
  }
  {
    const three = [ride("x", 10), ride("y", 40), ride("z", 20)];
    check("fewer than 5: lowest shows all", ids(rankLowestWaits(three)) === "x,z,y");
    check("fewer than 5: highest shows all", ids(rankHighestWaits(three)) === "y,z,x");
    const seven = ["1", "2", "3", "4", "5", "6", "7"].map((n, i) => ride(n, (i + 1) * 10));
    const lo = rankLowestWaits(seven), hi = rankHighestWaits(seven);
    check("7 rides: lists overlap, each 5", lo.length === 5 && hi.length === 5 && lo.some((a) => hi.includes(a)));
    check("empty / none operating", rankLowestWaits([]).length === 0 && rankHighestWaits([ride("c", 5, "CLOSED")]).length === 0);
    check("walk-on 0 min is valid", ids(rankLowestWaits([ride("w", 0), ride("v", 5)])) === "w,v");
  }

  // Regression (Codex P2): fallback waits are never ranked as confirmed live.
  {
    const mixed = [
      ride("liveA", 40), ride("liveB", 25), ride("liveC", 70),
      ride("fbLow", 1, "OPERATING", "fallback"), ride("fbHigh", 999, "OPERATING", "fallback"),
    ];
    const live = selectRankableAttractions(mixed, "live");
    check("live dataset: fallback rows excluded", ids(live) === "liveA,liveB,liveC");
    check("shortest list never contains fallback", ids(rankLowestWaits(live)) === "liveB,liveA,liveC");
    check("longest list never contains fallback", ids(rankHighestWaits(live)) === "liveC,liveA,liveB");
    check("live-sourced 0-minute wait is kept", ids(selectRankableAttractions([ride("z", 0), ride("fb", 5, "OPERATING", "fallback")], "live")) === "z");
    check("missing waitSource (older cache) is not treated as fallback", ids(selectRankableAttractions([{ id: "old", name: "old", waitMins: 10, status: "OPERATING" } as unknown as AttractionWait], "live")) === "old");
    const mock = selectRankableAttractions(mixed, "mock");
    check("mock mode: all rows stay eligible and ranked", mock.length === 5 && ids(rankLowestWaits(mock)).startsWith("fbLow") && ids(rankHighestWaits(mock)).startsWith("fbHigh"));
    check("isFallbackWait is explicit-provenance only", isFallbackWait(ride("f", 5, "OPERATING", "fallback")) && !isFallbackWait(ride("l", 5)));
    check("all-fallback live payload → empty rankings", rankLowestWaits(selectRankableAttractions([ride("f", 5, "OPERATING", "fallback")], "live")).length === 0);
  }

  // Park operating status + empty-wait messaging
  {
    const win = (type: string, open: string, close: string, opens: string, closes: string) =>
      ({ date: "2026-10-01", type, description: null, openingTime: open, closingTime: close, opens, closes, lastUpdated: null });
    const reg = win("OPERATING", "2026-10-01T09:00:00-04:00", "2026-10-01T22:00:00-04:00", "9:00 AM", "10:00 PM");
    const hours = (operating: unknown[], additional: unknown[] = [], extra: object = {}) =>
      ({ parkId: "mk", resort: "WDW", localDate: "2026-10-01", status: "hours", operating, additional, stale: false, ...extra } as unknown as ParkHours);
    const at = (iso: string) => new Date(iso);
    const st = (d: ParkHours | null, iso: string) => describeParkOperatingStatus(d, at(iso));

    let r = st(hours([reg]), "2026-10-01T08:00:00-04:00");
    check("before opening: shows opening time, confirmed closed", r.kind === "before_open" && r.text === "Opens 9:00 AM" && r.confirmedClosed);
    r = st(hours([reg]), "2026-10-01T12:00:00-04:00");
    check("open: shows closing time, not closed", r.kind === "open" && r.text === "Open \u00b7 closes 10:00 PM" && !r.confirmedClosed);
    r = st(hours([reg]), "2026-10-01T09:00:00-04:00");
    check("exactly at opening is open", r.kind === "open");
    r = st(hours([reg]), "2026-10-01T22:00:00-04:00");
    check("exactly at closing is closed for today", r.kind === "closed_after_hours" && r.text === "Closed for today" && r.confirmedClosed);
    r = st(hours([reg]), "2026-10-01T23:30:00-04:00");
    check("after closing: closed for today", r.kind === "closed_after_hours");
    check("confirmed closed today (status closed)", (() => { const x = st(hours([], [], { status: "closed" }), "2026-10-01T12:00:00-04:00"); return x.kind === "closed_today" && x.confirmedClosed; })());
    // Special ticketed events never count as regular hours
    const ticketed = win("TICKETED_EVENT", "2026-10-01T19:00:00-04:00", "2026-10-02T00:00:00-04:00", "7:00 PM", "12:00 AM");
    r = st(hours([reg], [ticketed]), "2026-10-01T23:00:00-04:00");
    check("ticketed event after close does not make the park open", r.kind === "closed_after_hours");
    r = st(hours([], [ticketed], { status: "unknown" }), "2026-10-01T20:00:00-04:00");
    check("only a ticketed event (unknown) is never open", r.kind === "unknown" && r.text === null && !r.confirmedClosed);
    // Two regular windows
    const w1 = win("OPERATING", "2026-10-01T09:00:00-04:00", "2026-10-01T12:00:00-04:00", "9:00 AM", "12:00 PM");
    const w2 = win("OPERATING", "2026-10-01T15:00:00-04:00", "2026-10-01T22:00:00-04:00", "3:00 PM", "10:00 PM");
    r = st(hours([w2, w1]), "2026-10-01T13:00:00-04:00");
    check("between windows: closed, reopens at next", r.kind === "between" && r.text === "Closed \u00b7 reopens 3:00 PM" && r.confirmedClosed);
    // Unknown / unavailable never guess
    for (const status of ["unknown", "unavailable"]) {
      const x = st(hours([reg], [], { status }), "2026-10-01T12:00:00-04:00");
      check(`status ${status}: no claim`, x.kind === "unknown" && x.text === null && !x.confirmedClosed);
    }
    check("null (loading): no claim", st(null, "2026-10-01T12:00:00-04:00").kind === "unknown");
    check("malformed window ignored → unknown", st(hours([{ ...reg, openingTime: "bad", closingTime: "bad" }]), "2026-10-01T12:00:00-04:00").kind === "unknown");
    check("stale flag carried", st(hours([reg], [], { stale: true }), "2026-10-01T12:00:00-04:00").stale);
    // Midnight rollover: previous-day data is degraded to unavailable by parkHoursForDisplay (no claim)
    const nextDay = describeParkOperatingStatus(hours([reg], [], { status: "unavailable" }), at("2026-10-02T00:05:00-04:00"));
    check("rollover: degraded previous-day data makes no claim", nextDay.kind === "unknown" && !nextDay.confirmedClosed);

    // Empty wait messaging
    check("closed + empty → park closed", waitListEmptyMessage({ waitsLoaded: true, rowCount: 0, parkConfirmedClosed: true }) === "Park is currently closed.");
    check("open/unknown + empty → live unavailable", waitListEmptyMessage({ waitsLoaded: true, rowCount: 0, parkConfirmedClosed: false }) === "Live wait times unavailable.");
    check("rows present → no message (closed park with waits keeps rankings)", waitListEmptyMessage({ waitsLoaded: true, rowCount: 3, parkConfirmedClosed: true }) === null);
    check("still loading → no message", waitListEmptyMessage({ waitsLoaded: false, rowCount: 0, parkConfirmedClosed: true }) === null);
    // Missing Queue-Times data alone (park open or hours unknown) never yields a closure claim
    check("no wait data never infers closure", waitListEmptyMessage({ waitsLoaded: true, rowCount: 0, parkConfirmedClosed: describeParkOperatingStatus(null, at("2026-10-01T12:00:00-04:00")).confirmedClosed }) === "Live wait times unavailable.");
    // Fallback-only live payload with open park → unavailable, not closed
    const fbOnly = rankLowestWaits(selectRankableAttractions([ride("f", 5, "OPERATING", "fallback")], "live"));
    check("fallback-only live payload + open park → live unavailable", waitListEmptyMessage({ waitsLoaded: true, rowCount: fbOnly.length, parkConfirmedClosed: st(hours([reg]), "2026-10-01T12:00:00-04:00").confirmedClosed }) === "Live wait times unavailable.");
  }

  // Next shows
  const NOW = new Date("2026-10-01T19:00:00Z"); // 3:00 PM EDT
  const perf = (localTime: string, startTime: string, endTime: string | null = null) =>
    ({ startTime, endTime, localTime, type: "Performance Time", passed: false });
  const entry = (dwpName: string, status: string, performances: ReturnType<typeof perf>[], incomplete = false) =>
    ({ dwpName, parkId: "hs", status, performances, message: null, incomplete, unrecognizedTypes: [], provider: [] });
  const park = (entries: ReturnType<typeof entry>[], error: unknown = null) =>
    ({ parkId: "hs", resort: "WDW", localDate: "2026-10-01", asOf: NOW.toISOString(), fetchedLocalDate: "2026-10-01", stale: false, meta: null, error, entries } as unknown as ParkEntertainmentShowtimes);

  check("loading", selectNextShows(null, NOW).state === "loading");
  check("error → unavailable, no attribution", (() => { const r = selectNextShows(park([], { kind: "network" }), NOW); return r.state === "unavailable" && !r.presentsProviderData; })());
  {
    const r = selectNextShows(park([
      entry("Fantasmic!", "upcoming", [perf("9:00 PM", "2026-10-01T21:00:00-04:00"), perf("10:30 PM", "2026-10-01T22:30:00-04:00"), perf("10:00 AM", "2026-10-01T10:00:00-04:00")]),
      entry("Beauty and the Beast", "upcoming", [perf("4:00 PM", "2026-10-01T16:00:00-04:00"), perf("6:00 PM", "2026-10-01T18:00:00-04:00")]),
      entry("Meet", "unmapped", []),
    ]), NOW);
    check("multi-show: merged, sorted, top 3, passed dropped", r.performances.map((p) => `${p.dwpName}@${p.localTime}`).join() === "Beauty and the Beast@4:00 PM,Beauty and the Beast@6:00 PM,Fantasmic!@9:00 PM");
    check("same show may appear multiple times", r.performances.filter((p) => p.dwpName === "Beauty and the Beast").length === 2);
    check("complete: not partial, attribution owed", r.state === "upcoming" && !r.partial && r.presentsProviderData);
  }
  check("partial when another mapped entry unavailable", selectNextShows(park([
    entry("A", "upcoming", [perf("9:00 PM", "2026-10-01T21:00:00-04:00")]),
    entry("B", "unavailable", [], true),
  ]), NOW).partial);
  check("partial when upcoming entry incomplete", selectNextShows(park([entry("A", "upcoming", [perf("9:00 PM", "2026-10-01T21:00:00-04:00")], true)]), NOW).partial);
  check("all complete & passed → none_remaining", selectNextShows(park([
    entry("A", "all_passed", [perf("10:00 AM", "2026-10-01T10:00:00-04:00", "2026-10-01T10:30:00-04:00")]),
    entry("B", "none_posted", []),
  ]), NOW).state === "none_remaining");
  check("incomplete with nothing upcoming → unavailable (never 'none remaining')", selectNextShows(park([
    entry("A", "all_passed", [perf("10:00 AM", "2026-10-01T10:00:00-04:00", "2026-10-01T10:30:00-04:00")], true),
  ]), NOW).state === "unavailable");
  check("all unmapped → unavailable, no attribution", (() => { const r = selectNextShows(park([entry("A", "unmapped", [])]), NOW); return r.state === "unavailable" && !r.presentsProviderData; })());
  check("time re-evaluated: show passes as clock advances", selectNextShows(park([entry("A", "upcoming", [perf("4:00 PM", "2026-10-01T16:00:00-04:00", "2026-10-01T16:30:00-04:00")])]), new Date("2026-10-01T21:00:00Z")).state === "none_remaining");

  // Regression (Codex P2): already-started performances are excluded from Next up.
  {
    // now = 3:15 PM EDT; 3:00–3:30 PM is underway, 4:00 PM is next.
    const NOW315 = new Date("2026-10-01T19:15:00Z");
    const underway = perf("3:00 PM", "2026-10-01T15:00:00-04:00", "2026-10-01T15:30:00-04:00");
    const later = perf("4:00 PM", "2026-10-01T16:00:00-04:00");
    const r = selectNextShows(park([entry("A", "upcoming", [underway, later])]), NOW315);
    check("started-but-not-ended show excluded; next is future", r.performances.map((p) => p.localTime).join() === "4:00 PM");
    const onlyUnderway = selectNextShows(park([entry("A", "upcoming", [underway])]), NOW315);
    check("only an underway show → nothing upcoming", onlyUnderway.performances.length === 0 && onlyUnderway.state === "none_remaining");
    const exact = selectNextShows(park([entry("A", "upcoming", [perf("3:15 PM", "2026-10-01T15:15:00-04:00", "2026-10-01T15:45:00-04:00")])]), NOW315);
    check("start == now is not upcoming (requires start > now)", exact.performances.length === 0);
  }

  // Regression (Codex P2): stale data is flagged for none_remaining and upcoming, never for fresh data.
  {
    const done = entry("A", "all_passed", [perf("10:00 AM", "2026-10-01T10:00:00-04:00", "2026-10-01T10:30:00-04:00")]);
    const staleNone = selectNextShows({ ...park([done]), stale: true } as ParkEntertainmentShowtimes, NOW);
    check("stale + none_remaining → stale flag", staleNone.state === "none_remaining" && staleNone.stale);
    const freshNone = selectNextShows(park([done]), NOW);
    check("fresh + none_remaining → no stale flag", freshNone.state === "none_remaining" && !freshNone.stale);
    const staleUp = selectNextShows({ ...park([entry("A", "upcoming", [perf("9:00 PM", "2026-10-01T21:00:00-04:00")])]), stale: true } as ParkEntertainmentShowtimes, NOW);
    check("stale + upcoming → stale flag", staleUp.state === "upcoming" && staleUp.stale);
  }

  // Regression (Codex P2): Next up copy is scoped to curated shows, and unmapped
  // entries are not treated as checked (claims are scoped, not implied exhaustive).
  {
    check("scope copy names curated shows", /curated/i.test(NEXT_SHOWS_HEADING) && /curated/i.test(NEXT_SHOWS_SCOPE_NOTE) && /not all park entertainment/i.test(NEXT_SHOWS_SCOPE_NOTE));
    check("none-remaining copy is scoped, not park-wide", /curated/i.test(NEXT_SHOWS_NONE_REMAINING));
    const withUnmapped = selectNextShows(park([
      entry("Mapped", "all_passed", [perf("10:00 AM", "2026-10-01T10:00:00-04:00", "2026-10-01T10:30:00-04:00")]),
      entry("Unmapped Show", "unmapped", []),
    ]), NOW);
    check("unmapped entries contribute nothing and do not change mapped handling", withUnmapped.state === "none_remaining" && withUnmapped.performances.length === 0);
    check("incomplete mapped schedule still unavailable alongside unmapped", selectNextShows(park([
      entry("Mapped", "unavailable", [], true), entry("Unmapped Show", "unmapped", []),
    ]), NOW).state === "unavailable");
  }

  return failures;
}

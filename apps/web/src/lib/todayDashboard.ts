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

/** Lowest operating waits, ascending (stable: dataset order breaks ties). */
export function rankLowestWaits(attractions: AttractionWait[], count = TODAY_LIST_COUNT): AttractionWait[] {
  return attractions.filter(isRankableWait).sort((a, b) => (a.waitMins as number) - (b.waitMins as number)).slice(0, count);
}

/** Highest operating waits, descending (stable: dataset order breaks ties). Overlap with the lowest list is allowed. */
export function rankHighestWaits(attractions: AttractionWait[], count = TODAY_LIST_COUNT): AttractionWait[] {
  return attractions.filter(isRankableWait).sort((a, b) => (b.waitMins as number) - (a.waitMins as number)).slice(0, count);
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

  const ride = (id: string, waitMins: number | null | undefined, status: string = "OPERATING"): AttractionWait =>
    ({ id, name: id, waitMins, status } as unknown as AttractionWait);
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

  return failures;
}

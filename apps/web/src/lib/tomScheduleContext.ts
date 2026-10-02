/**
 * tomScheduleContext.ts — Phase 12.7 Ask Tom Schedule Intelligence (server-only).
 *
 * Enriches the server-side /api/tom/ask request with provider-backed schedule
 * context, strictly through DWP's normalized services:
 *   - exact-date park hours  → parkHoursService.getParkHoursForDate()
 *   - current-day showtimes  → entertainmentShowtimesService.getParkEntertainmentShowtimes()
 * Tom and the planner snapshot never touch ThemeParks.wiki. The planner
 * snapshot stays a compact local read-only summary: this module only READS
 * its `days[].date`, `days[].park`, `dayAutoFallbacks` and `plans` — the
 * existing effective-day-park authority (manual park, else Auto/fallback) —
 * and never invents a park/date resolution of its own.
 *
 * Fetch bounding (no broad provider fetching):
 *   - only days with a valid date that is resort-local today or later, with an
 *     effective park, are considered (past/invalid dates make no provider call);
 *   - (park, date) pairs are deduped, ordered soonest-first, and capped at
 *     MAX_HOURS_TARGETS; days beyond the cap are listed as `not_fetched`;
 *   - showtimes are fetched only for parks with a planner day dated resort-local
 *     TODAY that has planned Entertainment, capped at MAX_SHOWTIME_PARKS, and
 *     only the planned entries are sent (never the whole park catalog).
 *
 * Showtimes are TODAY-ONLY: a future planner date never receives showtimes
 * (and today's /live performances are never relabelled as another date's).
 *
 * Failure semantics: provider failure/partial/unpublished data is passed
 * through as the normalized non-confident status (`unavailable`,
 * `not_yet_available`, incomplete showtimes). Nothing is fabricated; a thrown
 * service error degrades that one target to `unavailable`.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { getResortLocalDate } from "./resortTime";
import { PARK_LABELS, PARK_TO_RESORT, isValidParkId } from "./parkMetadata";
import { comparePlannerDateToResortToday } from "./resortTime";
import { resolveCanonicalIdentity } from "./plannerContextSnapshot";
import { getParkHoursForDate } from "./parkHoursService";
import { getParkEntertainmentShowtimes } from "./entertainmentShowtimesService";
import { THEMEPARKS_ATTRIBUTION_NAME, THEMEPARKS_ATTRIBUTION_URL } from "./themeParksProviders";
import type { ParkDateHours, ParkHoursWindow } from "./parkHours";
import type { ParkEntertainmentShowtimes } from "./entertainmentShowtimes";

export const MAX_HOURS_TARGETS = 4;
export const MAX_SHOWTIME_PARKS = 2;

export interface TomScheduleWindow {
  type: string;
  description: string | null;
  opens: string;
  closes: string;
}

export interface TomScheduleHoursEntry {
  dayId: string;
  dayLabel: string;
  date: string;
  park: ParkId;
  parkName: string;
  /** "hours" | "closed" | "not_yet_available" | "unavailable" (normalized; verbatim) */
  status: ParkDateHours["status"];
  unavailableReason: ParkDateHours["unavailableReason"];
  /** Primary park-hours windows, resort-local (empty unless status "hours"). */
  operating: TomScheduleWindow[];
  /** Provider-described supplemental windows; meaning only as the provider's own type/description says. */
  additional: TomScheduleWindow[];
  stale: boolean;
}

export interface TomScheduleShowtimeEntry {
  name: string;
  /** upcoming | all_passed | none_posted | unavailable | unmapped */
  status: string;
  /** Today's known performances, resort-local start times. */
  times: Array<{ time: string; passed: boolean }>;
  /** True when the known list may be partial. */
  incomplete: boolean;
}

export interface TomScheduleContext {
  source: "ThemeParks.wiki via Disney Wait Planner";
  attribution: { name: string; url: string };
  hours: TomScheduleHoursEntry[];
  /** Days with a dated effective park that were not fetched (cap reached). */
  not_fetched: Array<{ dayId: string; date: string; park: ParkId }>;
  entertainment_showtimes?: {
    scope: "today_only";
    parks: Array<{
      park: ParkId;
      parkName: string;
      localDate: string;
      stale: boolean;
      /** Set when the provider call failed outright: no showtimes known. */
      error: string | null;
      entries: TomScheduleShowtimeEntry[];
    }>;
  };
  note: string;
}

export interface TomScheduleDeps {
  /** Fixed clock (deterministic DEV tests). */
  instant?: Date;
  /** Injectable clock, read again after provider work (rollover DEV tests). Wins over `instant`. */
  now?: () => Date;
  getHours?: (parkId: ParkId, date: string) => Promise<ParkDateHours>;
  getShowtimes?: (parkId: ParkId) => Promise<ParkEntertainmentShowtimes>;
}

interface Target {
  dayId: string;
  dayLabel: string;
  date: string;
  park: ParkId;
  resort: ResortId;
  today: boolean;
  index: number;
}

const NOTE =
  "Schedule data is provider-published and may change. Only statuses 'hours' and 'closed' are confirmed; 'not_yet_available' and 'unavailable' mean the schedule is NOT known — do not state hours for them. Entertainment showtimes cover today only; no showtimes are available for any other date.";

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Effective day park from the snapshot's own authority: manual days[].park, else dayAutoFallbacks. */
function effectivePark(day: Record<string, unknown>, fallbacks: Record<string, unknown> | null): ParkId | null {
  const manual = typeof day.park === "string" ? day.park : null;
  if (manual && isValidParkId(manual)) return manual;
  const id = typeof day.id === "string" ? day.id : null;
  const auto = id && fallbacks && Object.prototype.hasOwnProperty.call(fallbacks, id) ? fallbacks[id] : null;
  return typeof auto === "string" && isValidParkId(auto) ? auto : null;
}

function targetsFromPlanner(planner: Record<string, unknown>, instant: Date): Target[] {
  const days = Array.isArray(planner.days) ? planner.days : [];
  const fallbacks = obj(planner.dayAutoFallbacks);
  const out: Target[] = [];
  days.forEach((d, index) => {
    const day = obj(d);
    if (!day || typeof day.id !== "string" || typeof day.date !== "string") return;
    const park = effectivePark(day, fallbacks);
    if (!park) return;
    const resort = PARK_TO_RESORT[park] as ResortId;
    const rel = comparePlannerDateToResortToday(resort, day.date, instant);
    if (rel !== "today" && rel !== "future") return; // past / invalid: no provider call
    out.push({ dayId: day.id, dayLabel: typeof day.label === "string" ? day.label : day.id, date: day.date, park, resort, today: rel === "today", index });
  });
  return out.sort((a, b) => (a.date === b.date ? a.index - b.index : a.date < b.date ? -1 : 1));
}

const windowOut = (w: ParkHoursWindow): TomScheduleWindow => ({ type: w.type, description: w.description, opens: w.opens, closes: w.closes });

function hoursEntry(t: Target, h: ParkDateHours): TomScheduleHoursEntry {
  const confirmed = h.status === "hours";
  return {
    dayId: t.dayId, dayLabel: t.dayLabel, date: t.date, park: t.park, parkName: PARK_LABELS[t.park],
    status: h.status,
    unavailableReason: h.unavailableReason,
    operating: confirmed ? h.operating.map(windowOut) : [],
    additional: confirmed || h.status === "closed" ? h.additional.map(windowOut) : [],
    stale: h.stale,
  };
}

const unavailableHours = (t: Target): TomScheduleHoursEntry => ({
  dayId: t.dayId, dayLabel: t.dayLabel, date: t.date, park: t.park, parkName: PARK_LABELS[t.park],
  status: "unavailable", unavailableReason: "request_failed", operating: [], additional: [], stale: false,
});

/**
 * Planned Entertainment canonical identities for the given (today) day ids.
 * Uses the snapshot's own resolveCanonicalIdentity (trailing-time cleanup +
 * canonical Entertainment resolution), so legacy names like "Fantasmic 9pm"
 * match the same identity the planner context already recognized.
 */
function plannedEntertainmentKeys(planner: Record<string, unknown>, dayIds: Set<string>, resort: ResortId): Set<string> {
  const keys = new Set<string>();
  for (const p of Array.isArray(planner.plans) ? planner.plans : []) {
    const item = obj(p);
    if (!item || item.type !== "entertainment" || typeof item.name !== "string" || typeof item.dayId !== "string") continue;
    if (!dayIds.has(item.dayId)) continue;
    keys.add(resolveCanonicalIdentity(item.name, "entertainment", resort, item.dayId));
  }
  return keys;
}

/**
 * Build the `context.schedule` object for a Tom request from the (already
 * sanitized) planner context, or null when nothing schedule-relevant exists.
 * Never throws.
 */
export async function buildTomScheduleContext(
  plannerContext: Record<string, unknown> | undefined,
  deps: TomScheduleDeps = {},
): Promise<TomScheduleContext | null> {
  try {
    if (!plannerContext) return null;
    const fixed = deps.instant;
    const clock = deps.now ?? (fixed ? () => fixed : () => new Date());
    const instant = clock();
    // Production services get NO frozen instant: each reads its own clock after
    // its provider fetch, so a request crossing resort-local midnight never
    // normalizes a late response against the request-start day.
    const getHours = deps.getHours ?? ((p: ParkId, d: string) => getParkHoursForDate(p, d));
    const getShowtimes = deps.getShowtimes ?? ((p: ParkId) => getParkEntertainmentShowtimes(p));

    const targets = targetsFromPlanner(plannerContext, instant);
    if (targets.length === 0) return null;

    // Hours: one fetch per distinct (park, date); days sharing it reuse the result.
    const seen = new Set<string>();
    const fetchTargets: Target[] = [];
    const notFetched: TomScheduleContext["not_fetched"] = [];
    for (const t of targets) {
      const k = `${t.park}:${t.date}`;
      if (seen.has(k)) { fetchTargets.push(t); continue; }
      if (seen.size >= MAX_HOURS_TARGETS) { notFetched.push({ dayId: t.dayId, date: t.date, park: t.park }); continue; }
      seen.add(k);
      fetchTargets.push(t);
    }
    const cache = new Map<string, Promise<ParkDateHours | null>>();
    const hours = await Promise.all(fetchTargets.map(async (t) => {
      const k = `${t.park}:${t.date}`;
      if (!cache.has(k)) cache.set(k, getHours(t.park, t.date).catch(() => null));
      const h = await cache.get(k);
      return h ? hoursEntry(t, h) : unavailableHours(t);
    }));

    // Showtimes: today-only, only parks whose TODAY day has planned Entertainment.
    const todayByPark = new Map<ParkId, Target[]>();
    for (const t of targets) if (t.today) todayByPark.set(t.park, [...(todayByPark.get(t.park) ?? []), t]);
    const showParks: NonNullable<TomScheduleContext["entertainment_showtimes"]>["parks"] = [];
    for (const [park, ts] of todayByPark) {
      if (showParks.length >= MAX_SHOWTIME_PARKS) break;
      const wanted = plannedEntertainmentKeys(plannerContext, new Set(ts.map((t) => t.dayId)), ts[0].resort);
      if (wanted.size === 0) continue;
      let st: ParkEntertainmentShowtimes | null = null;
      try { st = await getShowtimes(park); } catch { st = null; }
      // The provider's resort-local "today" must still be the planner's date (midnight rollover).
      // Also re-check the actual current resort-local date after the provider
      // work (never trust a date derived from a frozen request-start instant).
      if (getResortLocalDate(ts[0].resort, clock()) !== ts[0].date) continue;
      if (st && st.localDate !== ts[0].date) continue;
      showParks.push({
        park, parkName: PARK_LABELS[park], localDate: ts[0].date,
        stale: st?.stale ?? false,
        error: st ? (st.error ? st.error.kind : null) : "unavailable",
        entries: st ? st.entries
          .filter((e) => wanted.has(resolveCanonicalIdentity(e.dwpName, "entertainment", ts[0].resort, "")))
          .map((e) => ({
            name: e.dwpName, status: e.status,
            times: e.performances.map((p) => ({ time: p.localTime, passed: p.passed })),
            incomplete: e.incomplete,
          })) : [],
      });
    }

    return {
      source: "ThemeParks.wiki via Disney Wait Planner",
      attribution: { name: THEMEPARKS_ATTRIBUTION_NAME, url: THEMEPARKS_ATTRIBUTION_URL },
      hours,
      not_fetched: notFetched,
      ...(showParks.length > 0 ? { entertainment_showtimes: { scope: "today_only" as const, parks: showParks } } : {}),
      note: NOTE,
    };
  } catch {
    return null;
  }
}

/**
 * True when the schedule carries at least one provider-confirmed fact (so
 * ThemeParks attribution applies): confirmed/closed/not-yet-available hours
 * (the normalizer emits not_yet_available only from successful provider
 * coverage), known showtimes, or
 * a complete valid-empty (`none_posted`) showtime answer. Unavailable,
 * incomplete and error states are not confirmed provider data.
 */
export function scheduleHasProviderData(s: TomScheduleContext | null): boolean {
  if (!s) return false;
  return (
    s.hours.some((h) => h.status === "hours" || h.status === "closed" || h.status === "not_yet_available") ||
    (s.entertainment_showtimes?.parks.some((p) => !p.error && p.entries.some((e) => e.times.length > 0 || (e.status === "none_posted" && !e.incomplete))) ?? false)
  );
}

/** DEV check (run manually; returns failing labels). Highest shared boundary: planner context → schedule context. */
export async function runDevTomScheduleContextCases(): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const NOW = new Date("2026-10-15T15:00:00Z"); // WDW Oct 15 11am; DLR Oct 15 8am
  const win = (date: string): ParkHoursWindow => ({ date, type: "OPERATING", description: null, openingTime: "", closingTime: "", opens: "9:00 AM", closes: "10:00 PM", lastUpdated: null });
  const mkHours = (parkId: ParkId, date: string, status: ParkDateHours["status"], extra: Partial<ParkDateHours> = {}): ParkDateHours => ({
    parkId, resort: PARK_TO_RESORT[parkId] as ResortId, date, localDate: "2026-10-15", asOf: NOW.toISOString(), status,
    unavailableReason: status === "unavailable" ? "request_failed" : null,
    operating: status === "hours" ? [win(date)] : [],
    additional: [], stale: false, meta: null, error: null, droppedEntries: 0, ...extra,
  });
  const asked: string[] = [];
  const hoursFor = (map: Record<string, ParkDateHours | "throw">) => async (p: ParkId, d: string) => {
    asked.push(`${p}:${d}`);
    const r = map[`${p}:${d}`];
    if (r === "throw") throw new Error("boom");
    return r ?? mkHours(p, d, "unavailable");
  };
  const showAsked: string[] = [];
  const mkShow = (parkId: ParkId, localDate: string, name: string, over: Partial<ParkEntertainmentShowtimes> = {}): ParkEntertainmentShowtimes => ({
    parkId, resort: PARK_TO_RESORT[parkId] as ResortId, localDate, asOf: NOW.toISOString(), fetchedLocalDate: localDate, stale: false, meta: null, error: null,
    entries: [
      { dwpName: name, parkId, status: "upcoming", performances: [{ startTime: "", endTime: null, localTime: "9:00 PM", type: "Performance Time", passed: false }], message: null, incomplete: false, unrecognizedTypes: [], provider: [] },
      { dwpName: "Other Show", parkId, status: "upcoming", performances: [{ startTime: "", endTime: null, localTime: "1:00 PM", type: "Performance Time", passed: false }], message: null, incomplete: false, unrecognizedTypes: [], provider: [] },
    ],
    ...over,
  });
  const getShowtimes = (name: string, over: Partial<ParkEntertainmentShowtimes> = {}) => async (p: ParkId) => { showAsked.push(p); return mkShow(p, "2026-10-15", name, over); };
  const day = (id: string, date: string, park?: string) => ({ id, label: id, date, ...(park ? { park } : {}) });

  // Dated day, manual park, published hours
  let ctx = await buildTomScheduleContext({ days: [day("day-1", "2026-10-20", "mk")], plans: [], dayAutoFallbacks: {} }, { instant: NOW, getHours: hoursFor({ "mk:2026-10-20": mkHours("mk", "2026-10-20", "hours") }) });
  check("hours: manual-park dated day gets published hours", ctx?.hours[0]?.status === "hours" && ctx.hours[0].operating[0]?.opens === "9:00 AM" && asked.join() === "mk:2026-10-20");

  // Auto/fallback park
  asked.length = 0;
  ctx = await buildTomScheduleContext({ days: [day("day-1", "2026-10-20")], plans: [], dayAutoFallbacks: { "day-1": "epcot" } }, { instant: NOW, getHours: hoursFor({ "epcot:2026-10-20": mkHours("epcot", "2026-10-20", "hours") }) });
  check("hours: Auto/fallback day park resolves via dayAutoFallbacks", ctx?.hours[0]?.park === "epcot" && asked.join() === "epcot:2026-10-20");
  asked.length = 0;
  ctx = await buildTomScheduleContext({ days: [day("day-1", "2026-10-20", "ak")], plans: [], dayAutoFallbacks: { "day-1": "epcot" } }, { instant: NOW, getHours: hoursFor({}) });
  check("hours: manual park wins over fallback", asked.join() === "ak:2026-10-20");
  asked.length = 0;
  ctx = await buildTomScheduleContext({ days: [day("day-1", "2026-10-20")], plans: [], dayAutoFallbacks: {} }, { instant: NOW, getHours: hoursFor({}) });
  check("hours: no effective park → no context, no fetch", ctx === null && asked.length === 0);
  ctx = await buildTomScheduleContext({ days: [day("day-1", "2026-10-20", "toString")], plans: [], dayAutoFallbacks: { "day-1": "constructor" } }, { instant: NOW, getHours: hoursFor({}) });
  check("hours: invalid/prototype park ids are ignored", ctx === null);

  // Status distinctions preserved; supplemental windows verbatim
  asked.length = 0;
  ctx = await buildTomScheduleContext({ days: [day("d1", "2026-10-20", "mk"), day("d2", "2026-10-21", "mk"), day("d3", "2026-10-22", "mk"), day("d4", "2026-10-23", "mk")], plans: [], dayAutoFallbacks: {} }, {
    instant: NOW,
    getHours: hoursFor({
      "mk:2026-10-20": mkHours("mk", "2026-10-20", "closed"),
      "mk:2026-10-21": mkHours("mk", "2026-10-21", "not_yet_available"),
      "mk:2026-10-22": mkHours("mk", "2026-10-22", "unavailable"),
      "mk:2026-10-23": mkHours("mk", "2026-10-23", "hours", { additional: [{ ...win("2026-10-23"), type: "TICKETED_EVENT", description: "Boo Bash", opens: "7:00 PM", closes: "midnight" }] }),
    }),
  });
  const st = ctx?.hours.map((h) => h.status).join();
  check("hours: Closed / Not yet available / Unavailable / hours kept distinct", st === "closed,not_yet_available,unavailable,hours");
  check("hours: non-confirmed statuses carry no windows", ctx!.hours.slice(0, 3).every((h) => h.operating.length === 0));
  check("hours: provider-described supplemental window passed verbatim", ctx!.hours[3].additional[0]?.description === "Boo Bash" && ctx!.hours[3].additional[0]?.type === "TICKETED_EVENT");

  // Fetch bounding + dedupe + past/invalid skipped
  asked.length = 0;
  const many = [day("d1", "2026-10-14", "mk"), day("d2", "2026-02-30", "mk"), day("d3", "2026-10-25", "mk"), day("d4", "2026-10-25", "mk"), day("d5", "2026-10-26", "mk"), day("d6", "2026-10-27", "mk"), day("d7", "2026-10-28", "mk"), day("d8", "2026-10-29", "mk")];
  ctx = await buildTomScheduleContext({ days: many, plans: [], dayAutoFallbacks: {} }, { instant: NOW, getHours: hoursFor({}) });
  check("bounding: past/invalid skipped, dup (park,date) fetched once, capped at MAX", asked.length === MAX_HOURS_TARGETS && new Set(asked).size === asked.length && asked[0] === "mk:2026-10-25" && ctx!.not_fetched.length === 1 && ctx!.hours.length === 5);

  // Provider failure: rejected service → unavailable, never fabricated
  ctx = await buildTomScheduleContext({ days: [day("d1", "2026-10-20", "mk")], plans: [], dayAutoFallbacks: {} }, { instant: NOW, getHours: hoursFor({ "mk:2026-10-20": "throw" }) });
  check("failure: thrown hours service → unavailable, no windows", ctx?.hours[0]?.status === "unavailable" && ctx.hours[0].operating.length === 0);

  // Resort-local date handling: 2026-10-16T03:00Z = WDW Oct 15 (11pm), DLR Oct 15 (8pm); 05:00Z = WDW Oct 16, DLR Oct 15
  const LATE = new Date("2026-10-16T05:00:00Z");
  asked.length = 0;
  showAsked.length = 0;
  const plan = (dayId: string, name: string) => ({ dayId, name, type: "entertainment", time: "" });
  ctx = await buildTomScheduleContext({ days: [day("w", "2026-10-15", "mk"), day("l", "2026-10-15", "disneyland")], plans: [plan("w", "Happily Ever After"), plan("l", "Fantasmic!")], dayAutoFallbacks: {} }, {
    instant: LATE, getHours: hoursFor({}), getShowtimes: getShowtimes("Fantasmic!"),
  });
  check("resort-local: Oct 15 is past for WDW (skipped) but today for DLR", asked.join() === "disneyland:2026-10-15" && showAsked.join() === "disneyland");

  // Showtimes: today only, planned entries only
  showAsked.length = 0;
  ctx = await buildTomScheduleContext({ days: [day("d1", "2026-10-15", "disneyland")], plans: [plan("d1", "Fantasmic!")], dayAutoFallbacks: {} }, {
    instant: NOW, getHours: hoursFor({}), getShowtimes: getShowtimes("Fantasmic!"),
  });
  const sp = ctx?.entertainment_showtimes?.parks[0];
  check("showtimes: today's planned entertainment gets today's times only", ctx?.entertainment_showtimes?.scope === "today_only" && sp?.entries.length === 1 && sp.entries[0].times[0]?.time === "9:00 PM");

  showAsked.length = 0;
  ctx = await buildTomScheduleContext({ days: [day("d1", "2026-10-16", "disneyland")], plans: [plan("d1", "Fantasmic!")], dayAutoFallbacks: {} }, {
    instant: NOW, getHours: hoursFor({}), getShowtimes: getShowtimes("Fantasmic!"),
  });
  check("showtimes: future planner date never receives today's showtimes (no fetch, no field)", showAsked.length === 0 && ctx?.entertainment_showtimes === undefined);

  ctx = await buildTomScheduleContext({ days: [day("d1", "2026-10-15", "disneyland"), day("d2", "2026-10-16", "disneyland")], plans: [plan("d2", "Fantasmic!")], dayAutoFallbacks: {} }, {
    instant: NOW, getHours: hoursFor({}), getShowtimes: getShowtimes("Fantasmic!"),
  });
  check("showtimes: entertainment planned only on a future day does not trigger today's showtimes", ctx?.entertainment_showtimes === undefined);

  showAsked.length = 0;
  ctx = await buildTomScheduleContext({ days: [day("d1", "2026-10-15", "disneyland")], plans: [{ dayId: "d1", name: "Fantasmic!", type: "attraction", time: "" }], dayAutoFallbacks: {} }, {
    instant: NOW, getHours: hoursFor({}), getShowtimes: getShowtimes("Fantasmic!"),
  });
  check("showtimes: no planned Entertainment → not fetched", showAsked.length === 0);

  // Showtime failure / partial degrade safely
  ctx = await buildTomScheduleContext({ days: [day("d1", "2026-10-15", "disneyland")], plans: [plan("d1", "Fantasmic!")], dayAutoFallbacks: {} }, {
    instant: NOW, getHours: hoursFor({}), getShowtimes: async () => { throw new Error("x"); },
  });
  check("failure: thrown showtimes service → unavailable, no times", ctx?.entertainment_showtimes?.parks[0]?.error === "unavailable" && ctx.entertainment_showtimes.parks[0].entries.length === 0);
  ctx = await buildTomScheduleContext({ days: [day("d1", "2026-10-15", "disneyland")], plans: [plan("d1", "Fantasmic!")], dayAutoFallbacks: {} }, {
    instant: NOW, getHours: hoursFor({}), getShowtimes: async (p) => mkShow(p, "2026-10-15", "Fantasmic!", { error: { kind: "timeout", message: "t" }, entries: [{ dwpName: "Fantasmic!", parkId: p, status: "unavailable", performances: [], message: "Showtimes unavailable", incomplete: true, unrecognizedTypes: [], provider: [] }] }),
  });
  check("failure: provider showtime error passes through as unavailable/incomplete", ctx?.entertainment_showtimes?.parks[0]?.error === "timeout" && ctx.entertainment_showtimes.parks[0].entries[0].status === "unavailable" && ctx.entertainment_showtimes.parks[0].entries[0].incomplete === true && !scheduleHasProviderData(ctx));
  ctx = await buildTomScheduleContext({ days: [day("d1", "2026-10-15", "disneyland")], plans: [plan("d1", "Fantasmic!")], dayAutoFallbacks: {} }, {
    instant: NOW, getHours: hoursFor({}), getShowtimes: async (p) => mkShow(p, "2026-10-14", "Fantasmic!"),
  });
  check("showtimes: provider payload for a different local date is dropped", ctx?.entertainment_showtimes === undefined);

  // Legacy time-suffixed Entertainment name resolves through the canonical path
  showAsked.length = 0;
  ctx = await buildTomScheduleContext({ days: [day("d1", "2026-10-15", "disneyland")], plans: [plan("d1", "Fantasmic 9pm")], dayAutoFallbacks: {} }, {
    instant: NOW, getHours: hoursFor({}), getShowtimes: getShowtimes("Fantasmic!"),
  });
  check("legacy: 'Fantasmic 9pm' matches canonical Fantasmic! and triggers today's showtimes", showAsked.join() === "disneyland" && ctx?.entertainment_showtimes?.parks[0]?.entries.map((e) => e.name).join() === "Fantasmic!");

  // none_posted attribution
  const noneEntry = (status: string, incomplete: boolean) => ({ dwpName: "Fantasmic!", parkId: "disneyland" as ParkId, status: status as never, performances: [], message: null, incomplete, unrecognizedTypes: [], provider: [] });
  const noneCtx = async (entry: ReturnType<typeof noneEntry>, over: Partial<ParkEntertainmentShowtimes> = {}) =>
    buildTomScheduleContext({ days: [day("d1", "2026-10-15", "disneyland")], plans: [plan("d1", "Fantasmic!")], dayAutoFallbacks: {} }, {
      instant: NOW, getHours: hoursFor({}), getShowtimes: async (p) => mkShow(p, "2026-10-15", "Fantasmic!", { entries: [entry], ...over }),
    });
  check("attribution: complete none_posted counts as provider data", scheduleHasProviderData(await noneCtx(noneEntry("none_posted", false))));
  check("attribution: incomplete none_posted does not", !scheduleHasProviderData(await noneCtx(noneEntry("none_posted", true))));
  check("attribution: unavailable entry does not", !scheduleHasProviderData(await noneCtx(noneEntry("unavailable", true))));
  check("attribution: provider error does not", !scheduleHasProviderData(await noneCtx(noneEntry("none_posted", false), { error: { kind: "timeout", message: "t" } })));

  // Midnight rollover: request starts 11:59pm WDW Oct 15; clock is past midnight after provider work
  {
    const times = [new Date("2026-10-16T03:59:00Z"), new Date("2026-10-16T04:01:00Z")];
    let i = 0;
    const now = () => times[Math.min(i++, times.length - 1)];
    // clock() reads: [0] start, [1] post-fetch recheck
    showAsked.length = 0;
    ctx = await buildTomScheduleContext({ days: [day("d1", "2026-10-15", "mk")], plans: [plan("d1", "Happily Ever After")], dayAutoFallbacks: {} }, {
      now, getHours: hoursFor({}), getShowtimes: getShowtimes("Happily Ever After"),
    });
    check("rollover: fetch started before midnight, finished after → yesterday's showtimes NOT attached", showAsked.join() === "mk" && ctx?.entertainment_showtimes === undefined);
    // Same request fully before midnight still attaches
    ctx = await buildTomScheduleContext({ days: [day("d1", "2026-10-15", "mk")], plans: [plan("d1", "Happily Ever After")], dayAutoFallbacks: {} }, {
      now: () => new Date("2026-10-16T03:59:00Z"), getHours: hoursFor({}), getShowtimes: getShowtimes("Happily Ever After"),
    });
    check("rollover: no crossing → showtimes attached", ctx?.entertainment_showtimes?.parks.length === 1);
    // DLR is still Oct 15 at the same instant (8:01pm), so no rollover there
    i = 0;
    ctx = await buildTomScheduleContext({ days: [day("d1", "2026-10-15", "disneyland")], plans: [plan("d1", "Fantasmic!")], dayAutoFallbacks: {} }, {
      now, getHours: hoursFor({}), getShowtimes: getShowtimes("Fantasmic!"),
    });
    check("rollover: resort-local — DLR unaffected by WDW midnight", ctx?.entertainment_showtimes?.parks.length === 1);
  }

  // Attribution: not_yet_available is provider-backed; unavailable is not
  const hoursOnly = async (st: ParkDateHours["status"]) => buildTomScheduleContext({ days: [day("d1", "2026-10-20", "mk")], plans: [], dayAutoFallbacks: {} }, { instant: NOW, getHours: hoursFor({ "mk:2026-10-20": mkHours("mk", "2026-10-20", st) }) });
  check("attribution: not_yet_available counts as provider data", scheduleHasProviderData(await hoursOnly("not_yet_available")));
  check("attribution: unavailable does not", !scheduleHasProviderData(await hoursOnly("unavailable")));
  check("attribution: closed still counts", scheduleHasProviderData(await hoursOnly("closed")));

  // Attribution gating + malformed input
  ctx = await buildTomScheduleContext({ days: [day("d1", "2026-10-20", "mk")], plans: [], dayAutoFallbacks: {} }, { instant: NOW, getHours: hoursFor({ "mk:2026-10-20": mkHours("mk", "2026-10-20", "hours") }) });
  check("attribution: present, and provider data detected", ctx?.attribution.name === THEMEPARKS_ATTRIBUTION_NAME && scheduleHasProviderData(ctx));
  check("input: undefined / malformed planner context → null", (await buildTomScheduleContext(undefined)) === null && (await buildTomScheduleContext({ days: "x", plans: 5 })) === null);
  return failures;
}

/**
 * publishedPerformanceSchedule.ts — Phase 14.6B official published performance schedules.
 *
 * A reusable, pure schedule model for entertainment whose OFFICIAL Disney source publishes a dated
 * lineup rather than a daily live feed: EPCOT's Disney on Broadway Concert Series (Festival of the Arts),
 * Garden Rocks (Flower & Garden), Eat to the Beat (Food & Wine) and the Candlelight Processional
 * (Festival of the Holidays). It is NOT a catalog: `ENTERTAINMENT_PLACES` stays the identity authority and a
 * record only points at an existing entry by exact `(parkId, canonical name)`; the dated event windows stay in
 * `seasonalEventData.ts` (a record names its `eventId` + `seasonYear` and must equal that window).
 *
 * Model — keyed by park + canonical entertainment name + season/year + resort-local date:
 *   - a SEASON record holds the official source(s), verification date, the official run window,
 *     `completeness`, and the dated performance days (optional times, optional performer/narrator names);
 *   - `completeness: "complete"` means the cited source publishes EVERY performance date of the run (the basis
 *     is quoted): a window date it does not list is then a CONFIRMED non-performance day. `"partial"` (only
 *     some dates published) never confirms a non-performance day;
 *   - times are only ever stated when the source states them: season-level `times` apply to every listed day
 *     that does not override them; a day with `times: []` is confirmed date-only (never a fabricated time).
 *
 * Resolution (`getPublishedPerformanceDay`) is three-valued and never extrapolates:
 *   performance      — the date is a listed performance day of a season record whose window contains it;
 *   no_performance   — inside a COMPLETE record's window but not listed;
 *   unknown          — everything else (no record for that season/year, outside every window, partial record).
 * A previous season's schedule is never carried forward: a date only resolves from the record whose own
 * window contains it, so an unannounced season (e.g. Garden Rocks 2027) stays `unknown`.
 *
 * Authority: for these offerings the official schedule decides Waits & Shows / default All Entertainment
 * visibility (confirmed performance → shown, confirmed no-performance → hidden, unknown → the existing
 * seasonal / provider rules decide). ThemeParks.wiki is supplemental and can neither hide a confirmed performance
 * day nor reveal a confirmed non-performance day. Future dates resolve the same way (trip planning) and are
 * distinct from today's live provider showtimes.
 *
 * DEV checks: `runDevPublishedPerformanceScheduleCases()` (run manually from Node).
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { ENTERTAINMENT_PLACES } from "./entertainmentSuggestions";
import { PARK_TO_RESORT } from "./parkMetadata";
import { isValidIsoCalendarDate } from "./plannerWarnings";
import { addDaysToLocalDate, formatLocalDateLabel, getResortLocalDate, RESORT_TIME_ZONES } from "./resortTime";
import { getSeasonalEventSeason } from "./seasonalEvents";
import { SEASONAL_ENTERTAINMENT_EVENTS } from "./seasonalEntertainment";

// ── Types ────────────────────────────────────────────────────────────────

export interface PublishedScheduleSource {
  title: string;
  /** Disney-owned official page (disneyparksblog.com or *.disney.go.com). */
  url: string;
  /** Source publish date, YYYY-MM-DD. */
  publishedDate: string;
  /** Date this record was last verified against the source, YYYY-MM-DD. */
  verifiedOn: string;
}

export interface PublishedPerformanceDay {
  /** Resort-local date, YYYY-MM-DD. */
  date: string;
  /** Resort-local 24h "HH:mm" start times; `[]` = confirmed performing, times NOT published; absent = inherit season `times`. */
  times?: string[];
  /** Official performer / narrator / act names for the date, if published. */
  performers?: string[];
  /** Source-stated detail for the day (e.g. a special finale). */
  note?: string;
}

export interface PublishedScheduleSeason {
  parkId: ParkId;
  /** Exact canonical `ENTERTAINMENT_PLACES` name. */
  name: string;
  seasonYear: number;
  /** Seasonal registry event whose confirmed season window this record must equal. */
  eventId: string;
  /** Official run window (inclusive). */
  windowStart: string;
  windowEnd: string;
  completeness: "complete" | "partial";
  /** Quoted/paraphrased evidence for `completeness` (required for "complete"). */
  completenessBasis: string;
  /** Label for `performers` on a card: "Narrator" | "Featuring" | "Performer". */
  performerLabel: string;
  /** Times the source states for every listed day without its own `times`. Absent = no times published. */
  times?: string[];
  sources: PublishedScheduleSource[];
  days: PublishedPerformanceDay[];
}

export type PublishedDayState = "performance" | "no_performance" | "unknown";

export interface PublishedDayResult {
  state: PublishedDayState;
  /** Set when the date falls in a season record's window. */
  record?: PublishedScheduleSeason;
  /** performance only: effective times ([] = date-only) and names. */
  times: string[];
  performers: string[];
  note?: string;
}

// ── Data authoring helpers ───────────────────────────────────────────────

/** Inclusive date list from `start` to `end`. */
function span(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d: string | null = start; d && d <= end; d = addDaysToLocalDate(d, 1)) out.push(d);
  return out;
}
/** Days for a contiguous inclusive run, optionally with names. */
function run(start: string, end: string, performers?: string[], extra: Partial<PublishedPerformanceDay> = {}): PublishedPerformanceDay[] {
  return span(start, end).map((date) => ({ date, ...(performers ? { performers } : {}), ...extra }));
}
/** Days for explicit dates in one month ("2027-01", [15, 17, ...]). */
function pick(month: string, daysOfMonth: number[], performers?: string[], extra: Partial<PublishedPerformanceDay> = {}): PublishedPerformanceDay[] {
  return daysOfMonth.map((n) => ({ date: `${month}-${String(n).padStart(2, "0")}`, ...(performers ? { performers } : {}), ...extra }));
}

const V = "2026-11-19";
const DPB = "https://disneyparksblog.com";

// ── Official data (verified 2026-11-19; month/day only sources take their year from the dated title/post) ──

export const PUBLISHED_PERFORMANCE_SCHEDULES: PublishedScheduleSeason[] = [
  // Disney on Broadway Concert Series — EPCOT International Festival of the Arts 2027.
  {
    parkId: "epcot", name: "Disney on Broadway Concert Series", seasonYear: 2027, eventId: "epcot-festival-of-the-arts",
    windowStart: "2027-01-15", windowEnd: "2027-03-01", completeness: "complete", performerLabel: "Featuring",
    completenessBasis: "Official schedule dates every pairing (Jan 15–Feb 26) plus the finale (Feb 27–Mar 1): all 46 dates of the run; \"Each night will feature three performances\".",
    times: ["17:15", "18:30", "19:45"],
    sources: [
      { title: "EPCOT Festival of the Arts 2027 Disney on Broadway Concert Series Schedule", url: `${DPB}/disney-experiences/epcot-festival-of-the-arts-2027-disney-on-broadway-concert-series-schedule/`, publishedDate: "2026-11-10", verifiedOn: V },
      { title: "2027 EPCOT International Festival of the Arts: Dates and Offerings", url: `${DPB}/wdw/epcot-international-festival-of-the-arts-dates-and-offerings/`, publishedDate: "2026-09-10", verifiedOn: V },
    ],
    days: [
      ...pick("2027-01", [15, 17, 18, 21, 22, 25, 26], ["Michael James Scott", "Marisha Wallace"]),
      ...pick("2027-01", [16, 19, 20, 23, 24, 27, 28], ["Ashley Brown", "Josh Strickland"]),
      ...pick("2027-01", [29, 31], ["Adam Pascal", "Sherie Rene Scott"]),
      ...pick("2027-02", [1, 4, 5, 8, 9], ["Adam Pascal", "Sherie Rene Scott"]),
      ...pick("2027-01", [30], ["Sierra Boggess", "Norm Lewis"]),
      ...pick("2027-02", [2, 3, 6, 7, 10, 11], ["Sierra Boggess", "Norm Lewis"]),
      ...pick("2027-02", [12, 14, 15, 18, 19, 22, 25], ["Kara Lindsay", "Mason Reeves"]),
      ...pick("2027-02", [13, 16, 17, 20, 21, 23, 24, 26], ["Caissie Levy", "Ryan McCartan"]),
      // Finale: the source names the concert but says its details are still to come, so no times are asserted.
      ...pick("2027-02", [27, 28], undefined, { times: [], note: "Special Finale Concert: Seize the Day! A Newsies Celebration (finale performance details to be announced)" }),
      ...pick("2027-03", [1], undefined, { times: [], note: "Special Finale Concert: Seize the Day! A Newsies Celebration (finale performance details to be announced)" }),
    ].sort((a, b) => (a.date < b.date ? -1 : 1)),
  },
  // Candlelight Processional — EPCOT International Festival of the Holidays 2026.
  {
    parkId: "epcot", name: "Candlelight Processional", seasonYear: 2026, eventId: "epcot-festival-of-the-holidays",
    windowStart: "2026-11-27", windowEnd: "2026-12-30", completeness: "complete", performerLabel: "Narrator",
    completenessBasis: "Official narrator lineup assigns a narrator to every date Nov 27–Dec 30, 2026; \"Performances are held nightly at 4:45 p.m., 6:30 p.m., and 8:00 p.m. EST\".",
    times: ["16:45", "18:30", "20:00"],
    sources: [
      { title: "2026 EPCOT Candlelight Processional Celebrity Narrators Lineup", url: `${DPB}/wdw/epcot-holiday-traditions-and-candlelight-processional-narrators-announced/`, publishedDate: "2026-10-06", verifiedOn: V },
      { title: "2026 EPCOT International Festival of the Holidays Dates and Details", url: `${DPB}/wdw/epcot-festival-of-the-holidays-dates-details/`, publishedDate: "2026-06-24", verifiedOn: V },
    ],
    days: [
      ...run("2026-11-27", "2026-11-28", ["Jordan Fisher"]),
      ...run("2026-11-29", "2026-12-01", ["Gary Sinise"]),
      ...run("2026-12-02", "2026-12-03", ["Benjamin Bratt"]),
      ...run("2026-12-04", "2026-12-05", ["Whoopi Goldberg"]),
      ...run("2026-12-06", "2026-12-07", ["Robin Roberts"]),
      ...run("2026-12-08", "2026-12-09", ["Jason Kelce"]),
      ...run("2026-12-10", "2026-12-12", ["Neil Patrick Harris"]),
      ...run("2026-12-13", "2026-12-14", ["Josh Groban"]),
      ...run("2026-12-15", "2026-12-16", ["Lauren Daigle"]),
      ...run("2026-12-17", "2026-12-19", ["Ralph Macchio"]),
      ...run("2026-12-20", "2026-12-21", ["Henry Winkler"]),
      ...run("2026-12-22", "2026-12-23", ["Lacey Chabert"]),
      ...run("2026-12-24", "2026-12-25", ["Jodi Benson"]),
      ...run("2026-12-26", "2026-12-27", ["Simu Liu"]),
      ...run("2026-12-28", "2026-12-30", ["Eva Longoria"]),
    ],
  },
  // Eat to the Beat — EPCOT International Food & Wine Festival 2026 (concert run Aug 27–Nov 16; HISTORICAL once it ended).
  {
    parkId: "epcot", name: "Eat to the Beat Concert Series", seasonYear: 2026, eventId: "epcot-eat-to-the-beat",
    windowStart: "2026-08-27", windowEnd: "2026-11-16", completeness: "complete", performerLabel: "Performer",
    completenessBasis: "Official full concert schedule names an act for every date Aug 27–Nov 16, 2026 (\"takes place each night from August 27 to November 16\"). The source says \"multiple show times each night\" but publishes none, so no times are recorded.",
    sources: [
      { title: "2026 EPCOT Eat to the Beat Concert Lineup: Full Concert Schedule", url: `${DPB}/wdw/eat-to-the-beat-lineup-full-concert-schedule/`, publishedDate: "2026-06-17", verifiedOn: V },
    ],
    days: [
      ...run("2026-08-27", "2026-08-27", ["Evolution: Motown"]),
      ...run("2026-08-28", "2026-08-31", ["Hanson"]),
      ...run("2026-09-01", "2026-09-03", ["Evolution: Motown"]),
      ...run("2026-09-04", "2026-09-05", ["The War and Treaty"]),
      ...run("2026-09-06", "2026-09-07", ["Yellowcard"]),
      ...run("2026-09-08", "2026-09-10", ["Fly Guys"]),
      ...run("2026-09-11", "2026-09-12", ["Couch"]),
      ...run("2026-09-13", "2026-09-14", ["Fitz and the Tantrums"]),
      ...run("2026-09-15", "2026-09-17", ["Latin Ambition"]),
      ...run("2026-09-18", "2026-09-19", ["MercyMe"]),
      ...run("2026-09-20", "2026-09-21", ["Grupo Manía"]),
      ...run("2026-09-22", "2026-09-24", ["Metro Latino Band"]),
      ...run("2026-09-25", "2026-09-27", ["Element"]),
      ...run("2026-09-28", "2026-09-29", ["New Found Glory"]),
      ...run("2026-09-30", "2026-10-01", ["Smash Mouth"]),
      ...run("2026-10-02", "2026-10-04", ["Champagne Orchestra"]),
      ...run("2026-10-05", "2026-10-06", ["Rey Ruiz"]),
      ...run("2026-10-07", "2026-10-08", ["Tiffany"]),
      ...run("2026-10-09", "2026-10-11", ["Viva Latina"]),
      ...run("2026-10-12", "2026-10-13", ["The Fray"]),
      ...run("2026-10-14", "2026-10-15", ["STARSHIP featuring Mickey Thomas"]),
      ...run("2026-10-16", "2026-10-18", ["Jaclyn Hayden"]),
      ...run("2026-10-19", "2026-10-20", ["Ben Rector"]),
      ...run("2026-10-21", "2026-10-22", ["Allen Stone"]),
      ...run("2026-10-23", "2026-10-25", ["SoundUp"]),
      ...run("2026-10-26", "2026-10-27", ["Lauren Alaina"]),
      ...run("2026-10-28", "2026-10-29", ["Bowling For Soup"]),
      ...run("2026-10-30", "2026-11-01", ["Southbound"]),
      ...run("2026-11-02", "2026-11-03", ["Boyz II Men"]),
      ...run("2026-11-04", "2026-11-05", ["Big Head Todd and The Monsters"]),
      ...run("2026-11-06", "2026-11-08", ["M-80’s"]),
      ...run("2026-11-09", "2026-11-10", ["Grace Potter"]),
      ...run("2026-11-11", "2026-11-12", ["John Stamos and the California Sound"]),
      ...run("2026-11-13", "2026-11-16", ["The Hooligans"]),
    ],
  },
  // Garden Rocks — EPCOT International Flower & Garden Festival 2026 (HISTORICAL; NOT nightly — pairs of days with gaps).
  // The 2027 lineup is not yet announced ("full list of performers ... at a later date"), so there is deliberately no 2027 record.
  {
    parkId: "epcot", name: "Garden Rocks Concert Series", seasonYear: 2026, eventId: "epcot-flower-and-garden",
    windowStart: "2026-03-04", windowEnd: "2026-06-01", completeness: "complete", performerLabel: "Performer",
    completenessBasis: "Official post titled \"Garden Rocks Concert Series 2026 Lineup: Full Schedule and Details\" lists every act with its dates (Mar 5–Jun 1); the run is not nightly, so unlisted festival dates are non-performance days. No times published.",
    sources: [
      { title: "Garden Rocks Concert Series 2026 Lineup: Full Schedule and Details", url: `${DPB}/wdw/garden-rocks-concert-series-lineup-schedule-and-more/`, publishedDate: "2026-01-21", verifiedOn: V },
    ],
    days: [
      ...run("2026-03-05", "2026-03-07", ["The Music of ABBA"]),
      ...run("2026-03-08", "2026-03-09", ["Simple Plan"]),
      ...run("2026-03-13", "2026-03-14", ["Blue October"]),
      ...run("2026-03-15", "2026-03-16", ["Billy Ocean"]),
      ...run("2026-03-20", "2026-03-23", ["THE ORCHESTRA starring former members of ELO & ELO Part II"]),
      ...run("2026-03-27", "2026-03-28", ["Herman’s Hermits starring Peter Noone"]),
      ...run("2026-03-29", "2026-03-30", ["38 Special"]),
      ...run("2026-04-03", "2026-04-04", ["Chubby Checker"]),
      ...run("2026-04-05", "2026-04-06", ["Sugar Ray"]),
      ...run("2026-04-10", "2026-04-11", ["Information Society"]),
      ...run("2026-04-12", "2026-04-13", ["Rick Springfield"]),
      ...run("2026-04-17", "2026-04-18", ["Berlin"]),
      ...run("2026-04-19", "2026-04-20", ["The Commodores"]),
      ...run("2026-04-24", "2026-04-25", ["FireHouse"]),
      ...run("2026-04-26", "2026-04-27", ["Air Supply"]),
      ...run("2026-05-01", "2026-05-02", ["A Flock of Seagulls"]),
      ...run("2026-05-03", "2026-05-04", ["Plain White T’s"]),
      ...run("2026-05-08", "2026-05-09", ["Katrina, formerly of Katrina & The Waves"]),
      ...run("2026-05-10", "2026-05-11", ["98 Degrees"]),
      ...run("2026-05-15", "2026-05-16", ["The Spinners"]),
      ...run("2026-05-17", "2026-05-18", ["Josiah Queen"]),
      ...run("2026-05-22", "2026-05-23", ["Iam Tongi"]),
      ...run("2026-05-24", "2026-05-25", ["A.J. Croce: Croce Plays Croce"]),
      ...run("2026-05-29", "2026-05-30", ["Queensrÿche"]),
      ...run("2026-05-31", "2026-06-01", ["Maverick City Music"]),
    ],
  },
];

// ── Resolution (pure) ────────────────────────────────────────────────────

/** Whether `(parkId, name)` has any published-schedule record (any season). */
export function hasPublishedSchedule(parkId: ParkId | undefined | null, name: string, records: readonly PublishedScheduleSeason[] = PUBLISHED_PERFORMANCE_SCHEDULES): boolean {
  return !!parkId && records.some((r) => r.parkId === parkId && r.name === name);
}

const UNKNOWN: PublishedDayResult = { state: "unknown", times: [], performers: [] };

/**
 * Resolve one resort-local date for a catalog show against the official records. Exact canonical
 * `(parkId, name)`; invalid dates, unrecorded seasons and out-of-window dates are `unknown` (never
 * "no performance"); only a COMPLETE record confirms a window date it does not list.
 */
export function getPublishedPerformanceDay(
  parkId: ParkId | undefined | null,
  name: string,
  date: string | null | undefined,
  records: readonly PublishedScheduleSeason[] = PUBLISHED_PERFORMANCE_SCHEDULES,
): PublishedDayResult {
  if (!parkId || !date || !isValidIsoCalendarDate(date)) return UNKNOWN;
  for (const r of records) {
    if (r.parkId !== parkId || r.name !== name || date < r.windowStart || date > r.windowEnd) continue;
    const day = r.days.find((d) => d.date === date);
    if (day) return { state: "performance", record: r, times: day.times ?? r.times ?? [], performers: day.performers ?? [], ...(day.note ? { note: day.note } : {}) };
    return r.completeness === "complete" ? { state: "no_performance", record: r, times: [], performers: [] } : { ...UNKNOWN, record: r };
  }
  return UNKNOWN;
}

/**
 * The next CONFIRMED performance strictly after `afterDate` (resort-local), for trip planning. Looks only at
 * recorded days — never extrapolates — so it is null when no later date is published.
 */
export function getNextPublishedPerformance(
  parkId: ParkId | undefined | null,
  name: string,
  afterDate: string,
  records: readonly PublishedScheduleSeason[] = PUBLISHED_PERFORMANCE_SCHEDULES,
): { date: string; result: PublishedDayResult } | null {
  if (!parkId || !isValidIsoCalendarDate(afterDate)) return null;
  let best: string | null = null;
  for (const r of records) {
    if (r.parkId !== parkId || r.name !== name) continue;
    for (const d of r.days) if (d.date > afterDate && (best === null || d.date < best)) best = d.date;
  }
  return best ? { date: best, result: getPublishedPerformanceDay(parkId, name, best, records) } : null;
}

// ── Display (pure) ───────────────────────────────────────────────────────

/** "17:15" → "5:15 PM". */
export function formatPublishedTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Resort-local "HH:mm" (24h) at `instant`. */
function localHHmm(resort: ResortId, instant: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: RESORT_TIME_ZONES[resort], hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
}

function dateLabel(date: string, today: string): string {
  const base = formatLocalDateLabel(date) ?? date;
  return date.slice(0, 4) === today.slice(0, 4) ? base : `${base}, ${date.slice(0, 4)}`;
}

/** Text for a day's confirmed times: all of them, or only the ones still ahead on `today`. */
function timesText(times: string[], remainingOnly: boolean, nowHHmm: string): string | null {
  const list = remainingOnly ? times.filter((t) => t >= nowHHmm) : times;
  return list.length > 0 ? list.map(formatPublishedTime).join(" • ") : null;
}

/**
 * Card lines for one catalog show at `instant` (resort-local day), 0–3 short strings, official-schedule only:
 *   today performing  → "Official schedule: 5:15 PM • …" (still-ahead times; date-only says times are not published)
 *                       + "<Label>: names" when published;
 *   today confirmed none → "No performance today (official schedule)";
 *   then, when today is not a performance day and a later date is confirmed → "Next: Fri, Jan 15 • 5:15 PM • …";
 *   with nothing later recorded but an earlier run on file → "Last official run ended …; no newer schedule recorded"
 *   (a statement about DWP's records and that run's own window — never that the next season will not happen).
 * Unknown today with nothing recorded either side → []. Never invents a time; live provider data is not consulted.
 */
export function getPublishedScheduleLines(
  parkId: ParkId | undefined | null,
  name: string,
  instant: Date,
  records: readonly PublishedScheduleSeason[] = PUBLISHED_PERFORMANCE_SCHEDULES,
): string[] {
  if (!parkId || !hasPublishedSchedule(parkId, name, records)) return [];
  const resort = PARK_TO_RESORT[parkId] as ResortId;
  const today = getResortLocalDate(resort, instant);
  const now = getPublishedPerformanceDay(parkId, name, today, records);
  const lines: string[] = [];
  if (now.state === "performance") {
    if (now.times.length === 0) lines.push("Official schedule: performing today (times not published)");
    else {
      const left = timesText(now.times, true, localHHmm(resort, instant));
      lines.push(left ? `Official schedule: ${left}` : "Official schedule: no more performances today");
    }
    if (now.performers.length > 0) lines.push(`${now.record!.performerLabel}: ${now.performers.join(" & ")}`);
    if (now.note) lines.push(now.note);
    return lines;
  }
  if (now.state === "no_performance") lines.push("No performance today (official schedule)");
  const next = getNextPublishedPerformance(parkId, name, today, records);
  if (next) {
    const t = timesText(next.result.times, false, "");
    lines.push(`Next: ${dateLabel(next.date, today)}${t ? ` • ${t}` : ""}`);
  } else {
    const ended = records.filter((r) => r.parkId === parkId && r.name === name && r.windowEnd < today).map((r) => r.windowEnd).sort().pop();
    if (ended) lines.push(`Last official run ended ${dateLabel(ended, today)}; no newer schedule recorded`);
  }
  return lines;
}

// ── Validation + DEV checks ──────────────────────────────────────────────

/** Structural problems with the shipped (or a supplied) record set; `[]` = valid. */
export function validatePublishedPerformanceSchedules(records: readonly PublishedScheduleSeason[] = PUBLISHED_PERFORMANCE_SCHEDULES): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const r of records) {
    const id = `${r.parkId}:${r.name}:${r.seasonYear}`;
    if (keys.has(id)) out.push(`${id}: duplicate season record`);
    keys.add(id);
    const place = ENTERTAINMENT_PLACES.find((p) => p.parkId === r.parkId && p.name === r.name);
    if (!place) out.push(`${id}: not an active catalog entry`);
    else if (place.resort !== PARK_TO_RESORT[r.parkId]) out.push(`${id}: resort mismatch`);
    if (!(SEASONAL_ENTERTAINMENT_EVENTS[r.name] ?? []).some((a) => a.eventId === r.eventId)) out.push(`${id}: no seasonal association to ${r.eventId}`);
    const season = getSeasonalEventSeason(r.eventId, r.seasonYear);
    if (!season || season.startDate !== r.windowStart || season.endDate !== r.windowEnd) out.push(`${id}: window differs from the registry season of ${r.eventId}`);
    if (!isValidIsoCalendarDate(r.windowStart) || !isValidIsoCalendarDate(r.windowEnd) || r.windowStart > r.windowEnd) out.push(`${id}: invalid window`);
    if (r.completeness === "complete" && r.completenessBasis.trim().length < 20) out.push(`${id}: complete record needs a quoted completeness basis`);
    if (r.sources.length === 0) out.push(`${id}: no official source`);
    for (const s of r.sources) {
      let host = "";
      try { host = new URL(s.url).hostname; } catch { out.push(`${id}: bad source url`); }
      if (host && !(host === "disneyparksblog.com" || host.endsWith(".disney.go.com") || host === "disney.go.com")) out.push(`${id}: source is not a Disney-owned domain (${host})`);
      if (!isValidIsoCalendarDate(s.publishedDate) || !isValidIsoCalendarDate(s.verifiedOn)) out.push(`${id}: bad source dates`);
    }
    for (const t of r.times ?? []) if (!hhmm.test(t)) out.push(`${id}: bad season time ${t}`);
    const seen = new Set<string>();
    for (const d of r.days) {
      if (!isValidIsoCalendarDate(d.date)) out.push(`${id}: invalid day ${d.date}`);
      else if (d.date < r.windowStart || d.date > r.windowEnd) out.push(`${id}: day ${d.date} outside window`);
      if (seen.has(d.date)) out.push(`${id}: duplicate day ${d.date}`);
      seen.add(d.date);
      for (const t of d.times ?? []) if (!hhmm.test(t)) out.push(`${id}: bad time ${t} on ${d.date}`);
    }
  }
  return out;
}

export type DevPublishedScheduleCase = { label: string; ok: () => boolean };

const EP: ParkId = "epcot";
const DOB = "Disney on Broadway Concert Series";
const CPR = "Candlelight Processional";
const ETTB = "Eat to the Beat Concert Series";
const GR = "Garden Rocks Concert Series";
const st = (name: string, date: string) => getPublishedPerformanceDay(EP, name, date).state;
const rec = (name: string) => PUBLISHED_PERFORMANCE_SCHEDULES.find((r) => r.name === name)!;
const SYN: PublishedScheduleSeason = {
  parkId: "epcot", name: GR, seasonYear: 2099, eventId: "x", windowStart: "2099-03-01", windowEnd: "2099-03-10", completeness: "partial",
  completenessBasis: "", performerLabel: "Performer", sources: [], days: [{ date: "2099-03-02" }, { date: "2099-03-03", times: ["19:00"] }],
};

export const DEV_PUBLISHED_PERFORMANCE_SCHEDULE_CASES: DevPublishedScheduleCase[] = [
  { label: "shipped records validate (catalog identity, associations, registry windows, Disney-owned sources)", ok: () => validatePublishedPerformanceSchedules().length === 0 },
  { label: "exactly the four EPCOT offerings are covered", ok: () => PUBLISHED_PERFORMANCE_SCHEDULES.map((r) => r.name).sort().join("|") === [CPR, DOB, ETTB, GR].sort().join("|") },
  // Positive / negative / unknown day states
  { label: "positive: Disney on Broadway Jan 20, 2027 performs with three official times and the dated pairing", ok: () => {
    const r = getPublishedPerformanceDay(EP, DOB, "2027-01-20");
    return r.state === "performance" && r.times.join() === "17:15,18:30,19:45" && r.performers.join() === "Ashley Brown,Josh Strickland";
  } },
  { label: "positive: Candlelight Dec 1, 2026 → Gary Sinise, 4:45/6:30/8:00 PM", ok: () => {
    const r = getPublishedPerformanceDay(EP, CPR, "2026-12-01");
    return r.state === "performance" && r.times.map(formatPublishedTime).join() === "4:45 PM,6:30 PM,8:00 PM" && r.performers.join() === "Gary Sinise";
  } },
  { label: "date-only: Eat to the Beat Oct 12, 2026 performs (The Fray) but NO time is fabricated", ok: () => {
    const r = getPublishedPerformanceDay(EP, ETTB, "2026-10-12");
    return r.state === "performance" && r.times.length === 0 && r.performers.join() === "The Fray";
  } },
  { label: "date-only finale: Disney on Broadway Feb 27, 2027 performs but overrides the season times with none", ok: () => {
    const r = getPublishedPerformanceDay(EP, DOB, "2027-02-27");
    return r.state === "performance" && r.times.length === 0 && /Newsies/.test(r.note ?? "");
  } },
  { label: "negative: Garden Rocks Mar 10, 2026 (inside the festival, not in the full lineup) is a confirmed non-performance day", ok: () => st(GR, "2026-03-10") === "no_performance" && st(GR, "2026-03-04") === "no_performance" && st(GR, "2026-03-07") === "performance" },
  { label: "no daily inference: Garden Rocks 2026 performs on 53 of the festival's 90 days", ok: () => rec(GR).days.length === 53 && rec(GR).days.length < span("2026-03-04", "2026-06-01").length },
  { label: "complete nightly runs cover their whole window (DoB 46 dates, Candlelight 34, Eat to the Beat 82)", ok: () =>
    rec(DOB).days.length === 46 && span("2027-01-15", "2027-03-01").length === 46 &&
    rec(CPR).days.length === 34 && span("2026-11-27", "2026-12-30").length === 34 &&
    rec(ETTB).days.length === 82 && span("2026-08-27", "2026-11-16").length === 82 },
  { label: "unknown: before/after a window and for a show with no record (never 'no performance')", ok: () =>
    st(DOB, "2027-01-14") === "unknown" && st(DOB, "2027-03-02") === "unknown" && st(CPR, "2026-11-19") === "unknown" &&
    getPublishedPerformanceDay(EP, "Luminous The Symphony of Us", "2027-01-20").state === "unknown" },
  { label: "unknown: invalid / missing dates and park mismatch", ok: () =>
    st(DOB, "2027-02-30") === "unknown" && st(DOB, "") === "unknown" && getPublishedPerformanceDay(EP, DOB, null).state === "unknown" &&
    getPublishedPerformanceDay("mk", DOB, "2027-01-20").state === "unknown" && getPublishedPerformanceDay(undefined, DOB, "2027-01-20").state === "unknown" },
  // Year boundaries / no carry-forward
  { label: "year boundary: Candlelight 2026 never resolves a 2027 date; Garden Rocks 2027 (unannounced) is unknown on every in-window date", ok: () =>
    st(CPR, "2027-12-01") === "unknown" && st(CPR, "2027-11-30") === "unknown" && st(GR, "2027-03-10") === "unknown" && st(GR, "2027-04-17") === "unknown" && st(GR, "2027-05-31") === "unknown" },
  { label: "year boundary: Eat to the Beat 2027 (festival unannounced) and Disney on Broadway 2026 stay unknown — no previous-year carry-forward", ok: () =>
    st(ETTB, "2027-09-12") === "unknown" && st(DOB, "2026-01-20") === "unknown" && st(DOB, "2028-01-20") === "unknown" },
  { label: "year boundary: a record is chosen by its own window, not the calendar year (Candlelight Dec 30 performs, Dec 31 unknown)", ok: () => st(CPR, "2026-12-30") === "performance" && st(CPR, "2026-12-31") === "unknown" },
  // Partial records never confirm a negative; future dates
  { label: "partial record: listed days perform (times inherit/override), unlisted window days stay unknown", ok: () => {
    const g = (d: string) => getPublishedPerformanceDay(EP, GR, d, [SYN]);
    return g("2099-03-02").state === "performance" && g("2099-03-02").times.length === 0 && g("2099-03-03").times.join() === "19:00" && g("2099-03-05").state === "unknown";
  } },
  { label: "future dates resolve like today (trip planning): Disney on Broadway Feb 14, 2027 → Kara Lindsay & Mason Reeves; next confirmed after today", ok: () => {
    const n = getNextPublishedPerformance(EP, DOB, "2026-11-19");
    return st(DOB, "2027-02-14") === "performance" && getPublishedPerformanceDay(EP, DOB, "2027-02-14").performers.join() === "Kara Lindsay,Mason Reeves" && n?.date === "2027-01-15" &&
      getNextPublishedPerformance(EP, GR, "2026-11-19") === null && getNextPublishedPerformance(EP, DOB, "2027-03-01") === null;
  } },
  { label: "validator rejects bad data (outside-window day, duplicate day, non-Disney source, window ≠ registry, complete without basis)", ok: () => {
    const bad: PublishedScheduleSeason = { ...rec(DOB), completenessBasis: "", sources: [{ title: "x", url: "https://example.com/a", publishedDate: "2026-11-10", verifiedOn: V }], windowEnd: "2027-03-02", days: [...rec(DOB).days, { date: "2027-01-15" }, { date: "2027-05-05" }] };
    const msgs = validatePublishedPerformanceSchedules([bad]).join("|");
    return /outside window/.test(msgs) && /duplicate day/.test(msgs) && /not a Disney-owned/.test(msgs) && /window differs/.test(msgs) && /completeness basis/.test(msgs);
  } },
  // Card lines (resort-local "now")
  { label: "lines: Jan 20, 2027 at noon ET shows all official times + the pairing; at 6:45 PM only the 7:45 PM show remains", ok: () => {
    const noon = getPublishedScheduleLines(EP, DOB, new Date("2027-01-20T17:00:00Z"));
    const late = getPublishedScheduleLines(EP, DOB, new Date("2027-01-20T23:45:00Z"));
    return noon[0] === "Official schedule: 5:15 PM • 6:30 PM • 7:45 PM" && noon[1] === "Featuring: Ashley Brown & Josh Strickland" && late[0] === "Official schedule: 7:45 PM";
  } },
  { label: "lines: after the last show → no more performances; date-only → 'times not published' (no times invented)", ok: () => {
    const done = getPublishedScheduleLines(EP, DOB, new Date("2027-01-21T02:00:00Z"));
    const dateOnly = getPublishedScheduleLines(EP, ETTB, new Date("2026-10-12T17:00:00Z"));
    return done[0] === "Official schedule: no more performances today" && dateOnly[0] === "Official schedule: performing today (times not published)" && dateOnly[1] === "Performer: The Fray" && !dateOnly.some((l) => /\d:\d\d [AP]M/.test(l));
  } },
  { label: "lines: confirmed non-performance day says so and points to the next confirmed date; unknown today with a future date shows only 'Next'", ok: () => {
    const gap = getPublishedScheduleLines(EP, GR, new Date("2026-03-10T17:00:00Z"));
    const pre = getPublishedScheduleLines(EP, DOB, new Date("2026-11-19T17:00:00Z"));
    return gap[0] === "No performance today (official schedule)" && gap[1] === "Next: Fri, Mar 13" &&
      pre.length === 1 && pre[0] === "Next: Fri, Jan 15, 2027 • 5:15 PM • 6:30 PM • 7:45 PM";
  } },
  { label: "lines: after a recorded run ends with nothing newer, only the factual last-run line shows (no Next, no claim about the next season); a different year labels the year", ok: () => {
    const a = getPublishedScheduleLines(EP, GR, new Date("2026-11-19T17:00:00Z"));
    const b = getPublishedScheduleLines(EP, ETTB, new Date("2026-11-19T17:00:00Z"));
    const c = getPublishedScheduleLines(EP, ETTB, new Date("2027-09-12T17:00:00Z"));
    return a.join("|") === "Last official run ended Mon, Jun 1; no newer schedule recorded" && b.join("|") === "Last official run ended Mon, Nov 16; no newer schedule recorded" &&
      c.join("|") === "Last official run ended Mon, Nov 16, 2026; no newer schedule recorded" && !a.concat(b, c).some((l) => /^Next:|No performance|Official schedule/.test(l));
  } },
  { label: "lines: shows without a record produce no lines", ok: () => getPublishedScheduleLines(EP, "Luminous The Symphony of Us", new Date("2026-11-19T17:00:00Z")).length === 0 },
];

export function runDevPublishedPerformanceScheduleCases(): string[] {
  return DEV_PUBLISHED_PERFORMANCE_SCHEDULE_CASES.filter((c) => {
    try { return !c.ok(); } catch { return true; }
  }).map((c) => c.label);
}

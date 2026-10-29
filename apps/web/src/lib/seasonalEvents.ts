/**
 * seasonalEvents.ts — pure lookup/date helpers over the Phase 14.1 seasonal
 * event registry (data lives in seasonalEventData.ts).
 *
 * Events are metadata, not a planner content type. Nothing here fetches,
 * persists, syncs, or reads provider data. "Today" is always the resort-local
 * date (resortTime.ts) and calendar validity reuses `isValidIsoCalendarDate`
 * (plannerWarnings.ts) — no competing date semantics.
 *
 * Lookup rules
 *   - Records are keyed by (eventId, seasonYear); seasonYear is the year the
 *     event begins, so a Nov 2026–Jan 2027 event is the 2026 season.
 *   - Historical lookup by year always works; a past date is reported as
 *     "past" and never as available/upcoming.
 *   - Unknown stays unknown: a select-night event with no confirmed
 *     `eventNights`, or a record with null dates, never yields a yes/no.
 */

import type { ResortId } from "@disney-wait-planner/shared";
import { PARK_TO_RESORT } from "./parkMetadata";
import { isValidIsoCalendarDate } from "./plannerWarnings";
import { getResortLocalDate } from "./resortTime";
import {
  SEASONAL_EVENTS,
  SEASONAL_EVENT_SEASONS,
  type SeasonalEventDefinition,
  type SeasonalEventSeasonRecord,
} from "./seasonalEventData";

export type {
  SeasonalEventDefinition,
  SeasonalEventSeasonRecord,
} from "./seasonalEventData";

export function getSeasonalEvent(
  eventId: string,
): SeasonalEventDefinition | undefined {
  return SEASONAL_EVENTS.find((e) => e.id === eventId);
}

export function getSeasonalEventSeason(
  eventId: string,
  seasonYear: number,
): SeasonalEventSeasonRecord | undefined {
  return SEASONAL_EVENT_SEASONS.find(
    (s) => s.eventId === eventId && s.seasonYear === seasonYear,
  );
}

/** Every recorded season of an event, newest first. */
export function listSeasonalEventSeasons(
  eventId: string,
): SeasonalEventSeasonRecord[] {
  return SEASONAL_EVENT_SEASONS.filter((s) => s.eventId === eventId).sort(
    (a, b) => b.seasonYear - a.seasonYear,
  );
}

/** Every season record for a season year, in registry order. */
export function listSeasonalEventSeasonsForYear(
  seasonYear: number,
): SeasonalEventSeasonRecord[] {
  return SEASONAL_EVENT_SEASONS.filter((s) => s.seasonYear === seasonYear);
}

export type SeasonalEventSeasonStatus =
  | "upcoming"
  | "in_progress"
  | "ended"
  | "unknown";

/**
 * Where a season sits relative to the resort-local today. "unknown" when the
 * dates aren't confirmed — never inferred.
 */
export function getSeasonalEventSeasonStatus(
  resort: ResortId,
  season: SeasonalEventSeasonRecord,
  instant: Date = new Date(),
): SeasonalEventSeasonStatus {
  const { startDate, endDate } = season;
  if (!startDate || !endDate) return "unknown";
  const today = getResortLocalDate(resort, instant);
  if (today < startDate) return "upcoming";
  if (today > endDate) return "ended";
  return "in_progress";
}

export type SeasonalEventDateState =
  /** The date is before resort-local today; never availability. */
  | "past"
  /** Today or future, and the event runs/holds a night on that date. */
  | "scheduled"
  /** Today or future, and confirmed data says the event does not run that date. */
  | "not_scheduled"
  /** Today or future, but the registry can't say (unconfirmed dates/nights). */
  | "unknown"
  /** `date` is not a valid calendar date. */
  | "invalid";

/**
 * Whether the event is (confirmed) happening on a planner "YYYY-MM-DD" date.
 * Continuous events are scheduled throughout their confirmed window;
 * select-night events only on confirmed `eventNights`. Past dates are always
 * "past" regardless of the record — historical data is not availability.
 */
export function getSeasonalEventDateState(
  event: SeasonalEventDefinition,
  season: SeasonalEventSeasonRecord,
  date: string,
  instant: Date = new Date(),
): SeasonalEventDateState {
  if (!isValidIsoCalendarDate(date)) return "invalid";
  if (date < getResortLocalDate(event.resort, instant)) return "past";
  const { startDate, endDate, eventNights } = season;
  if (event.format === "select-night") {
    if (!eventNights) return "unknown";
    return eventNights.includes(date) ? "scheduled" : "not_scheduled";
  }
  if (!startDate || !endDate) return "unknown";
  return date >= startDate && date <= endDate ? "scheduled" : "not_scheduled";
}

/** Registry-integrity problems for one season record (empty when sound). */
export function validateSeasonalEventSeason(
  season: SeasonalEventSeasonRecord,
): string[] {
  const problems: string[] = [];
  const event = getSeasonalEvent(season.eventId);
  if (!event) return [`unknown eventId "${season.eventId}"`];
  const { startDate, endDate, eventNights, seasonYear } = season;

  if (!Number.isInteger(seasonYear)) problems.push("seasonYear not an integer");
  if ((startDate === null) !== (endDate === null)) {
    problems.push("startDate/endDate must both be set or both null");
  }
  if (startDate !== null && !isValidIsoCalendarDate(startDate)) problems.push(`invalid startDate ${startDate}`);
  if (endDate !== null && !isValidIsoCalendarDate(endDate)) problems.push(`invalid endDate ${endDate}`);
  if (startDate && endDate && isValidIsoCalendarDate(startDate) && isValidIsoCalendarDate(endDate)) {
    if (startDate > endDate) problems.push("startDate after endDate");
    if (Number(startDate.slice(0, 4)) !== seasonYear) {
      problems.push("seasonYear must equal the year the event begins");
    }
  }
  if (startDate === null && eventNights?.length) {
    problems.push("eventNights without confirmed start/end");
  }
  if (eventNights) {
    if (event.format === "continuous") problems.push("continuous event must not list eventNights");
    eventNights.forEach((n, i) => {
      if (!isValidIsoCalendarDate(n)) problems.push(`invalid eventNight ${n}`);
      else if (i > 0 && n <= eventNights[i - 1]) problems.push(`eventNights not strictly ascending at ${n}`);
      else if (startDate && endDate && (n < startDate || n > endDate)) problems.push(`eventNight ${n} outside window`);
    });
    if (eventNights.length > 0 && startDate && endDate) {
      if (eventNights[0] !== startDate) problems.push("first eventNight must equal startDate");
      if (eventNights[eventNights.length - 1] !== endDate) problems.push("last eventNight must equal endDate");
    }
  }
  if (!/^https:\/\//.test(season.sourceUrl)) problems.push("sourceUrl must be https");
  if (!isValidIsoCalendarDate(season.verifiedOn)) problems.push("invalid verifiedOn");
  if (season.sourcePublishedDate !== undefined && !isValidIsoCalendarDate(season.sourcePublishedDate)) {
    problems.push("invalid sourcePublishedDate");
  }
  return problems;
}

/** Registry-integrity problems for one event definition (empty when sound). */
export function validateSeasonalEvent(
  event: SeasonalEventDefinition,
): string[] {
  const problems: string[] = [];
  if (!event.parkIds.length) problems.push("no parkIds");
  for (const p of event.parkIds) {
    if (PARK_TO_RESORT[p] !== event.resort) problems.push(`park ${p} not in resort ${event.resort}`);
  }
  if (!/^https:\/\//.test(event.officialUrl)) problems.push("officialUrl must be https");
  return problems;
}

/**
 * DEV checks (not wired into CI; run manually from Node, e.g. via tsx):
 *   import { runDevSeasonalEventCases } from "@/lib/seasonalEvents";
 *   console.log(runDevSeasonalEventCases()); // [] when everything passes
 * Returns the labels of failing checks.
 */
export type DevSeasonalEventCase = { label: string; ok: () => boolean };

const NOW = new Date("2026-10-29T16:00:00Z"); // WDW/DLR local date 2026-10-29

function seasonOf(id: string, year: number): SeasonalEventSeasonRecord {
  const s = getSeasonalEventSeason(id, year);
  if (!s) throw new Error(`missing season ${id}/${year}`);
  return s;
}
function stateOf(id: string, year: number, date: string, now = NOW) {
  return getSeasonalEventDateState(getSeasonalEvent(id)!, seasonOf(id, year), date, now);
}

export const DEV_SEASONAL_EVENT_CASES: DevSeasonalEventCase[] = [
  { label: "event ids unique", ok: () => new Set(SEASONAL_EVENTS.map((e) => e.id)).size === SEASONAL_EVENTS.length },
  { label: "(eventId, seasonYear) unique", ok: () => new Set(SEASONAL_EVENT_SEASONS.map((s) => `${s.eventId}:${s.seasonYear}`)).size === SEASONAL_EVENT_SEASONS.length },
  { label: "all event definitions valid", ok: () => SEASONAL_EVENTS.every((e) => validateSeasonalEvent(e).length === 0) },
  { label: "all season records valid", ok: () => SEASONAL_EVENT_SEASONS.every((s) => validateSeasonalEventSeason(s).length === 0) },
  { label: "required events present", ok: () => ["mnsshp", "mvmcp", "oogie-boogie-bash", "jollywood-nights", "epcot-festival-of-the-arts", "epcot-flower-and-garden", "epcot-food-and-wine", "epcot-festival-of-the-holidays"].every((id) => !!getSeasonalEvent(id)) },
  { label: "party events are select-night + separate ticket", ok: () => ["mnsshp", "mvmcp", "oogie-boogie-bash", "jollywood-nights"].every((id) => { const e = getSeasonalEvent(id)!; return e.format === "select-night" && e.admission === "separate-ticket"; }) },
  { label: "festivals are continuous + park admission", ok: () => SEASONAL_EVENTS.filter((e) => e.category === "epcot-festival").every((e) => e.format === "continuous" && e.admission === "park-admission") },
  { label: "night counts: MNSSHP 38, MVMCP 25, OBB 33, Jollywood 15", ok: () => seasonOf("mnsshp", 2026).eventNights?.length === 38 && seasonOf("mvmcp", 2026).eventNights?.length === 25 && seasonOf("oogie-boogie-bash", 2026).eventNights?.length === 33 && seasonOf("jollywood-nights", 2026).eventNights?.length === 15 },
  { label: "cross-year event is one season (Jollywood 2026 ends 2027-01-05)", ok: () => seasonOf("jollywood-nights", 2026).endDate === "2027-01-05" && !getSeasonalEventSeason("jollywood-nights", 2027) },
  { label: "historical lookup by year", ok: () => getSeasonalEventSeason("epcot-food-and-wine", 2025)?.startDate === "2025-08-28" && listSeasonalEventSeasons("epcot-food-and-wine").map((s) => s.seasonYear).join() === "2026,2025" },
  { label: "unverified season stays absent (no invented 2025 MNSSHP)", ok: () => getSeasonalEventSeason("mnsshp", 2025) === undefined },
  { label: "year listing", ok: () => listSeasonalEventSeasonsForYear(2025).length === 2 },
  { label: "season status: in progress (MVMCP not yet → upcoming)", ok: () => getSeasonalEventSeasonStatus("WDW", seasonOf("mvmcp", 2026), NOW) === "upcoming" && getSeasonalEventSeasonStatus("WDW", seasonOf("epcot-food-and-wine", 2026), NOW) === "in_progress" },
  { label: "season status: ended", ok: () => getSeasonalEventSeasonStatus("WDW", seasonOf("epcot-flower-and-garden", 2026), NOW) === "ended" },
  { label: "season status: null dates → unknown", ok: () => getSeasonalEventSeasonStatus("WDW", { eventId: "mvmcp", seasonYear: 2027, startDate: null, endDate: null, sourceUrl: "https://x", verifiedOn: "2026-10-29" }, NOW) === "unknown" },
  { label: "select-night: listed future night scheduled", ok: () => stateOf("mvmcp", 2026, "2026-11-08") === "scheduled" },
  { label: "select-night: in-window unlisted night not_scheduled", ok: () => stateOf("mvmcp", 2026, "2026-11-10") === "not_scheduled" },
  { label: "historical night is past, never scheduled", ok: () => stateOf("mnsshp", 2026, "2026-10-27") === "past" && stateOf("epcot-food-and-wine", 2025, "2025-09-01") === "past" },
  { label: "same-day night is today, not past", ok: () => stateOf("mnsshp", 2026, "2026-10-29") === "scheduled" },
  { label: "continuous window scheduled / outside not_scheduled", ok: () => stateOf("epcot-festival-of-the-holidays", 2026, "2026-12-01") === "scheduled" && stateOf("epcot-festival-of-the-holidays", 2026, "2027-02-01") === "not_scheduled" },
  { label: "resort-local today: DLR 2026-10-30 05:00Z is still Oct 29", ok: () => stateOf("oogie-boogie-bash", 2026, "2026-10-29", new Date("2026-10-30T05:00:00Z")) === "scheduled" },
  { label: "select-night with unknown nights → unknown", ok: () => getSeasonalEventDateState(getSeasonalEvent("mvmcp")!, { eventId: "mvmcp", seasonYear: 2027, startDate: null, endDate: null, sourceUrl: "https://x", verifiedOn: "2026-10-29" }, "2027-11-20", NOW) === "unknown" },
  { label: "invalid date → invalid", ok: () => stateOf("mvmcp", 2026, "2026-02-30") === "invalid" },
  { label: "validator catches bad record", ok: () => validateSeasonalEventSeason({ eventId: "mvmcp", seasonYear: 2025, startDate: "2026-11-08", endDate: "2026-11-07", eventNights: ["2026-11-09", "2026-11-08"], sourceUrl: "http://x", verifiedOn: "nope" }).length >= 5 },
];

export function runDevSeasonalEventCases(): string[] {
  return DEV_SEASONAL_EVENT_CASES.filter((c) => {
    try { return !c.ok(); } catch { return true; }
  }).map((c) => c.label);
}

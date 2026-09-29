/**
 * resortTime.ts — resort-local date/time foundation.
 *
 * Single maintained source for "what time/date is it at this resort right
 * now". Future schedule-aware features (park hours, showtimes, countdowns)
 * must consume these helpers rather than recomputing timezone math.
 *
 *   WDW → America/New_York      DLR → America/Los_Angeles
 *
 * DST is never hardcoded: the IANA zone + the instant decide EST/EDT and
 * PST/PDT via Intl. Every helper takes an optional explicit `instant` so
 * results are deterministic/testable; omitted, it defaults to `new Date()`.
 *
 * Calendar-date validity reuses `isValidIsoCalendarDate` (plannerWarnings.ts)
 * — no competing date semantics. Planner "YYYY-MM-DD" values are plain
 * calendar dates (no zone), so comparison is done on the strings against the
 * resort-local date.
 */

import type { ResortId } from "@disney-wait-planner/shared";
import { isValidIsoCalendarDate } from "./plannerWarnings";

export const RESORT_TIME_ZONES: Record<ResortId, string> = {
  WDW: "America/New_York",
  DLR: "America/Los_Angeles",
};

/** Resort-local calendar date for the instant, as "YYYY-MM-DD". */
export function getResortLocalDate(
  resort: ResortId,
  instant: Date = new Date(),
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: RESORT_TIME_ZONES[resort],
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Resort-local time of day, e.g. "3:58 PM" (no zone abbreviation). */
export function formatResortLocalTime(
  resort: ResortId,
  instant: Date = new Date(),
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: RESORT_TIME_ZONES[resort],
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(instant);
}

/** Actual zone abbreviation in effect at the instant: EST/EDT/PST/PDT. */
export function getResortTimeZoneAbbreviation(
  resort: ResortId,
  instant: Date = new Date(),
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: RESORT_TIME_ZONES[resort],
    timeZoneName: "short",
  }).formatToParts(instant);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

export type PlannerDateRelation = "past" | "today" | "future";

/**
 * Compare a planner "YYYY-MM-DD" with the resort-local today.
 * Returns null when `planDate` is not a valid calendar date.
 */
export function comparePlannerDateToResortToday(
  resort: ResortId,
  planDate: string,
  instant: Date = new Date(),
): PlannerDateRelation | null {
  if (!isValidIsoCalendarDate(planDate)) return null;
  const today = getResortLocalDate(resort, instant);
  if (planDate < today) return "past";
  if (planDate > today) return "future";
  return "today";
}

/**
 * Reference cases for the helpers above. Mirrors the DEV_PLAN_ALIAS_CASES
 * convention — not wired into CI; run manually from Node (e.g. via tsx):
 *   import { DEV_RESORT_TIME_CASES, runDevResortTimeCase } from "@/lib/resortTime";
 *   for (const c of DEV_RESORT_TIME_CASES) {
 *     const got = runDevResortTimeCase(c);
 *     if (got !== c.expected) console.error("FAIL", c.label, got);
 *   }
 */
export const DEV_RESORT_TIME_CASES: Array<{
  label: string;
  fn: "date" | "time" | "abbr" | "compare";
  resort: ResortId;
  instant: string;
  planDate?: string;
  expected: string | null;
}> = [
  // Same instant, both resorts (EDT vs PDT, summer)
  { label: "WDW time summer", fn: "time", resort: "WDW", instant: "2026-07-01T19:58:00Z", expected: "3:58 PM" },
  { label: "DLR time summer", fn: "time", resort: "DLR", instant: "2026-07-01T19:58:00Z", expected: "12:58 PM" },
  { label: "WDW abbr EDT", fn: "abbr", resort: "WDW", instant: "2026-07-01T19:58:00Z", expected: "EDT" },
  { label: "DLR abbr PDT", fn: "abbr", resort: "DLR", instant: "2026-07-01T19:58:00Z", expected: "PDT" },
  // Winter (EST / PST)
  { label: "WDW abbr EST", fn: "abbr", resort: "WDW", instant: "2026-01-15T17:00:00Z", expected: "EST" },
  { label: "DLR abbr PST", fn: "abbr", resort: "DLR", instant: "2026-01-15T17:00:00Z", expected: "PST" },
  // Near midnight: 03:30Z Jul 2 → WDW 11:30 PM Jul 1, DLR 8:30 PM Jul 1
  { label: "midnight WDW date", fn: "date", resort: "WDW", instant: "2026-07-02T03:30:00Z", expected: "2026-07-01" },
  // 05:00Z Jul 2 → WDW 1:00 AM Jul 2, DLR 10:00 PM Jul 1 (dates differ)
  { label: "differing WDW date", fn: "date", resort: "WDW", instant: "2026-07-02T05:00:00Z", expected: "2026-07-02" },
  { label: "differing DLR date", fn: "date", resort: "DLR", instant: "2026-07-02T05:00:00Z", expected: "2026-07-01" },
  // Planner date vs resort-local today (same instant, different answers)
  { label: "compare WDW today", fn: "compare", resort: "WDW", instant: "2026-07-02T05:00:00Z", planDate: "2026-07-02", expected: "today" },
  { label: "compare DLR past", fn: "compare", resort: "DLR", instant: "2026-07-02T05:00:00Z", planDate: "2026-07-01", expected: "today" },
  { label: "compare DLR yesterday", fn: "compare", resort: "DLR", instant: "2026-07-02T05:00:00Z", planDate: "2026-06-30", expected: "past" },
  { label: "compare future", fn: "compare", resort: "WDW", instant: "2026-07-02T05:00:00Z", planDate: "2026-07-03", expected: "future" },
  { label: "compare invalid", fn: "compare", resort: "WDW", instant: "2026-07-02T05:00:00Z", planDate: "2026-02-30", expected: null },
];

export function runDevResortTimeCase(
  c: (typeof DEV_RESORT_TIME_CASES)[number],
): string | null {
  const instant = new Date(c.instant);
  switch (c.fn) {
    case "date": return getResortLocalDate(c.resort, instant);
    case "time": return formatResortLocalTime(c.resort, instant);
    case "abbr": return getResortTimeZoneAbbreviation(c.resort, instant);
    case "compare": return comparePlannerDateToResortToday(c.resort, c.planDate ?? "", instant);
  }
}

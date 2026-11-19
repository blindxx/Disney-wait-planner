/**
 * plannerPublishedSchedule.ts — Phase 14.6C date-specific official schedule info for My Plans.
 *
 * Pure presentation layer over the ONE official-schedule resolver
 * (`getPublishedPerformanceDay`, publishedPerformanceSchedule.ts); it holds no schedule data and no parallel
 * model. For one planner day (valid resort-local date + effective park) it returns rows for the covered EPCOT
 * offerings, preserving the resolver's three-valued answer:
 *   performance    — listed date: published times (none = "times not published", never invented) + performers;
 *   no_performance — confirmed only by a COMPLETE record (planned shows only; see below);
 *   unknown        — no record / outside every window / partial record (planned shows only).
 *
 * Which shows get a row (informational only — never edits, reorders or filters saved items):
 *   - "planned": the day's own entertainment items that resolve (same `getPlannerItemMetadata` canonical identity
 *     My Plans/Tom use) to a covered show. Shown for every state so the user learns a planned show does not
 *     perform that day, or that its schedule is not published yet.
 *   - "park": other covered shows of the day's effective park with a CONFIRMED performance that date. Never rows
 *     for non-performance/unknown (that would be noise for shows the user never planned).
 * Past dates (resort-local) and invalid dates produce nothing: this is trip-planning information.
 *
 * Tom is deliberately NOT fed from here: the Tom backend's handling of new context fields is unverified (see AGENTS.md).
 *
 * DEV checks: `runDevPlannerPublishedScheduleCases()` (run manually from Node).
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import type { PlannerItemType } from "./plansTransfer";
import { getPlannerItemMetadata, resolvePlannerItemEffectiveType, stripTrailingTimeForInference } from "./plannerItemMetadata";
import {
  PUBLISHED_PERFORMANCE_SCHEDULES,
  formatPublishedTime,
  getPublishedPerformanceDay,
  type PublishedDayState,
} from "./publishedPerformanceSchedule";
import { PARK_TO_RESORT } from "./parkMetadata";
import { comparePlannerDateToResortToday } from "./resortTime";

export interface PlannerPublishedScheduleRow {
  name: string;
  parkId: ParkId;
  source: "planned" | "park";
  state: PublishedDayState;
  /** Display lines for the row (resolver facts only). */
  lines: string[];
  /** Official source page for the record containing the date (performance/no_performance/partial only). */
  sourceUrl?: string;
}

export interface PlannerScheduleItemInput {
  name: string;
  type?: PlannerItemType | string;
}

function describe(state: PublishedDayState, r: ReturnType<typeof getPublishedPerformanceDay>): string[] {
  if (state === "performance") {
    const lines = [r.times.length > 0 ? r.times.map(formatPublishedTime).join(" • ") : "Performing (times not published)"];
    if (r.performers.length > 0) lines.push(`${r.record!.performerLabel}: ${r.performers.join(" & ")}`);
    if (r.note) lines.push(r.note);
    return lines;
  }
  if (state === "no_performance") return ["No performance on this date (official schedule)"];
  return ["Official schedule not published for this date"];
}

/**
 * Rows for one planner day. `date` is the day's own planner date; `parkId` its effective park (may be null for
 * an unresolved Auto day: planned rows still resolve by the item's own canonical park). `resort` is the day's
 * resort context for item resolution. `instant` is only used for the resort-local past/today/future test.
 */
export function getPlannerPublishedScheduleRows(
  date: string | null | undefined,
  parkId: ParkId | null | undefined,
  resort: ResortId,
  items: readonly PlannerScheduleItemInput[],
  instant: Date = new Date(),
  records = PUBLISHED_PERFORMANCE_SCHEDULES,
): PlannerPublishedScheduleRow[] {
  if (!date) return [];
  const rel = comparePlannerDateToResortToday(parkId ? (PARK_TO_RESORT[parkId] as ResortId) : resort, date, instant);
  if (rel !== "today" && rel !== "future") return [];

  const rows: PlannerPublishedScheduleRow[] = [];
  const seen = new Set<string>();
  const row = (name: string, park: ParkId, source: "planned" | "park"): PlannerPublishedScheduleRow | null => {
    const r = getPublishedPerformanceDay(park, name, date, records);
    if (source === "park" && r.state !== "performance") return null;
    const sourceUrl = r.record?.sources[0]?.url;
    return { name, parkId: park, source, state: r.state, lines: describe(r.state, r), ...(sourceUrl ? { sourceUrl } : {}) };
  };

  for (const item of items) {
    const type = resolvePlannerItemEffectiveType(item.type, item.name, resort);
    if (type !== "entertainment") continue;
    // Same trailing-time normalization the type resolver and planner cards use ("Garden Rocks 7pm").
    const meta = getPlannerItemMetadata(stripTrailingTimeForInference(item.name), type, resort);
    if (!meta.canonicalName || !meta.parkId || meta.lifecycle === "legacy") continue;
    const park = meta.parkId as ParkId;
    if (!records.some((r) => r.parkId === park && r.name === meta.canonicalName)) continue;
    const key = `${park}:${meta.canonicalName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const planned = row(meta.canonicalName, park, "planned");
    if (planned) rows.push(planned);
  }

  if (parkId) {
    const names = [...new Set(records.filter((r) => r.parkId === parkId).map((r) => r.name))];
    for (const name of names) {
      const key = `${parkId}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = row(name, parkId, "park");
      if (r) rows.push(r);
    }
  }
  return rows;
}

// ── DEV checks ───────────────────────────────────────────────────────────

export type DevPlannerPublishedScheduleCase = { label: string; ok: () => boolean };

const NOW = new Date("2026-11-19T17:00:00Z");
const rows = (date: string | null, park: ParkId | null, items: PlannerScheduleItemInput[] = [], resort: ResortId = "WDW", now = NOW) =>
  getPlannerPublishedScheduleRows(date, park, resort, items, now);

export const DEV_PLANNER_PUBLISHED_SCHEDULE_CASES: DevPlannerPublishedScheduleCase[] = [
  { label: "positive: EPCOT day Jan 20, 2027 surfaces Disney on Broadway with official times and performers", ok: () => {
    const r = rows("2027-01-20", "epcot");
    return r.length === 1 && r[0].name === "Disney on Broadway Concert Series" && r[0].source === "park" && r[0].state === "performance" &&
      r[0].lines[0] === "5:15 PM • 6:30 PM • 7:45 PM" && r[0].lines[1] === "Featuring: Ashley Brown & Josh Strickland" && !!r[0].sourceUrl;
  } },
  { label: "positive: Candlelight Dec 1, 2026 shows the narrator; the unplanned shows without a performance that date produce no rows", ok: () => {
    const r = rows("2026-12-01", "epcot");
    return r.length === 1 && r[0].name === "Candlelight Processional" && r[0].lines.join("|") === "4:45 PM • 6:30 PM • 8:00 PM|Narrator: Gary Sinise";
  } },
  { label: "date-only: Eat to the Beat on a performing day states times are not published (no fabricated time)", ok: () => {
    const r = getPlannerPublishedScheduleRows("2026-10-12", "epcot", "WDW", [], new Date("2026-10-01T17:00:00Z"));
    const e = r.find((x) => x.name === "Eat to the Beat Concert Series");
    return !!e && e.state === "performance" && e.lines[0] === "Performing (times not published)" && e.lines.some((l) => /The Fray/.test(l)) && !e.lines.some((l) => /[AP]M/.test(l));
  } },
  { label: "date-only finale: Broadway Feb 27, 2027 has no times, keeps the source-stated note", ok: () => {
    const r = rows("2027-02-27", "epcot");
    return r[0]?.lines[0] === "Performing (times not published)" && r[0].lines.some((l) => /Newsies/.test(l));
  } },
  { label: "negative: a PLANNED Garden Rocks on a confirmed non-performance day says so (official schedule)", ok: () => {
    const r = getPlannerPublishedScheduleRows("2026-03-10", "epcot", "WDW", [{ name: "Garden Rocks", type: "entertainment" }], new Date("2026-03-01T17:00:00Z"));
    return r.length === 1 && r[0].source === "planned" && r[0].state === "no_performance" && r[0].lines[0] === "No performance on this date (official schedule)";
  } },
  { label: "unknown: a PLANNED show with no published schedule is 'not published', never 'no performance'", ok: () => {
    const r = rows("2027-04-17", "epcot", [{ name: "Garden Rocks Concert Series", type: "entertainment" }]);
    return r.length === 1 && r[0].state === "unknown" && r[0].lines[0] === "Official schedule not published for this date" && r[0].sourceUrl === undefined;
  } },
  { label: "unplanned shows never get no-performance/unknown rows (no noise)", ok: () => rows("2027-04-17", "epcot").length === 0 && rows("2027-03-02", "epcot").length === 0 },
  { label: "year boundary: Candlelight Dec 30 performs, Dec 31 / Jan 2027 are unknown (no carry-forward); Broadway resolves in 2027", ok: () => {
    const plan = [{ name: "Candlelight Processional", type: "entertainment" }];
    return rows("2026-12-30", "epcot", plan)[0].state === "performance" && rows("2026-12-31", "epcot", plan)[0].state === "unknown" &&
      rows("2027-01-02", "epcot", plan)[0].state === "unknown" && rows("2027-01-15", "epcot")[0].name === "Disney on Broadway Concert Series";
  } },
  { label: "planner compatibility: items are only read — alias/untyped names resolve to the canonical identity, order preserved, one row per show", ok: () => {
    const items = [{ name: "Candlelight 5:00 PM" }, { name: "Candlelight Processional", type: "entertainment" }, { name: "Test Track", type: "attraction" }, { name: "Custom dinner", type: "dining" }];
    const frozen = JSON.stringify(items);
    const r = rows("2026-12-01", "epcot", items);
    return JSON.stringify(items) === frozen && r.filter((x) => x.name === "Candlelight Processional").length === 1 && r[0].source === "planned";
  } },
  { label: "annotated saved/imported names ('Candlelight 5:00 PM', 'Garden Rocks 7pm') resolve alone — unknown/no-performance notices are not suppressed", ok: () => {
    const a = rows("2027-04-17", "epcot", [{ name: "Garden Rocks 7pm" }]);
    const b = getPlannerPublishedScheduleRows("2026-03-10", "epcot", "WDW", [{ name: "Garden Rocks 7pm", type: "entertainment" }], new Date("2026-03-01T17:00:00Z"));
    return a.length === 1 && a[0].name === "Garden Rocks Concert Series" && a[0].state === "unknown" && b.length === 1 && b[0].state === "no_performance" &&
      rows("2027-04-17", "epcot", [{ name: "Candlelight 5:00 PM" }])[0]?.state === "unknown";
  } },
  { label: "planned show on a day with another effective park (or unresolved Auto park) still resolves by its own canonical EPCOT identity", ok: () =>
    rows("2026-12-01", "mk", [{ name: "Candlelight Processional", type: "entertainment" }])[0]?.state === "performance" &&
    rows("2026-12-01", null, [{ name: "Candlelight Processional", type: "entertainment" }])[0]?.state === "performance" &&
    rows("2026-12-01", "mk").length === 0 },
  { label: "other parks/resorts and non-entertainment items produce nothing", ok: () =>
    rows("2027-01-20", "mk").length === 0 && rows("2027-01-20", "disneyland", [], "DLR").length === 0 && rows("2027-01-20", null, [{ name: "Space Mountain", type: "attraction" }]).length === 0 },
  { label: "past / invalid / missing dates produce nothing; today counts as plannable", ok: () =>
    rows("2026-11-18", "epcot", [{ name: "Candlelight Processional", type: "entertainment" }]).length === 0 &&
    rows("2027-02-30", "epcot").length === 0 && rows("", "epcot").length === 0 && rows(null, "epcot").length === 0 &&
    getPlannerPublishedScheduleRows("2026-12-01", "epcot", "WDW", [], new Date("2026-12-01T15:00:00Z")).length === 1 },
];

export function runDevPlannerPublishedScheduleCases(): string[] {
  return DEV_PLANNER_PUBLISHED_SCHEDULE_CASES.filter((c) => {
    try { return !c.ok(); } catch { return true; }
  }).map((c) => c.label);
}

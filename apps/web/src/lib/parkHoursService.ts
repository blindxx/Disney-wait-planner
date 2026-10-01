/**
 * parkHoursService.ts — server-side fetch for Phase 12.4 park hours. Calls the
 * shared ThemeParks client's getSchedule() for the park's configured UUID and
 * hands the result to the pure normalizer in parkHours.ts. Server-only (the
 * ThemeParks client is); the browser reaches it via /api/park-hours.
 *
 * Provider calls (all through the shared client, whose 15 min schedule cache
 * absorbs repeats): exactly ONE default-window request in the normal case.
 * Follow-up monthly requests happen only when the park has no entry of any
 * type dated today (a potential closure, which needs the provider calendar
 * to bracket the date): the current resort-local month, and — only if that
 * still shows no later OPERATING window — the following month. Month and year
 * boundaries come from the resort-local date, never the server clock zone.
 */

import type { ParkId } from "@disney-wait-planner/shared";
import { PARK_TO_RESORT } from "./parkMetadata";
import { getResortLocalDate } from "./resortTime";
import {
  currentResortMonth,
  isClosureCandidate,
  nextResortMonth,
  normalizeParkHours,
  type ParkHours,
  type ParkHoursSources,
} from "./parkHours";
import { themeParks, type ThemeParksResult, type ThemeParksSchedule } from "./themeParksApi";
import { THEMEPARKS_PARKS } from "./themeParksProviders";
import type { ResortId } from "@disney-wait-planner/shared";

type GetSchedule = (
  id: string,
  month?: { year: number; month: number },
) => Promise<ThemeParksResult<ThemeParksSchedule>>;

export async function getParkHours(
  parkId: ParkId,
  opts: { instant?: Date; getSchedule?: GetSchedule } = {},
): Promise<ParkHours> {
  const getSchedule: GetSchedule = opts.getSchedule ?? ((id, month) => themeParks.getSchedule(id, month));
  const resort = PARK_TO_RESORT[parkId] as ResortId;
  const id = THEMEPARKS_PARKS[parkId].entityId;
  // `now` is taken after the fetches so the result reflects delivery time.
  const now = () => opts.instant ?? new Date();

  const src: ParkHoursSources = { primary: await getSchedule(id) };
  if (isClosureCandidate(parkId, src.primary, now())) {
    const localDate = getResortLocalDate(resort, now());
    src.currentMonth = await getSchedule(id, currentResortMonth(localDate));
    if (src.currentMonth.ok && normalizeParkHours(parkId, src, now()).nextOpening === null) {
      src.nextMonth = await getSchedule(id, nextResortMonth(localDate));
    }
  }
  return normalizeParkHours(parkId, src, now());
}

/** DEV check (run manually; returns failing labels): provider UUID, call economy, month boundaries. */
export async function runDevParkHoursServiceCases(): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const ID = THEMEPARKS_PARKS.mk.entityId;
  const op = (date: string) => ({ date, type: "OPERATING", openingTime: `${date}T09:00:00-04:00`, closingTime: `${date}T22:00:00-04:00`, description: null, lastUpdated: null });
  const res = (entries: ReturnType<typeof op>[], at: number): ThemeParksResult<ThemeParksSchedule> =>
    ({ ok: true, data: { entityId: ID, name: "MK", timeZone: "America/New_York", entries, parks: [], droppedEntries: 0 }, meta: { origin: "network", fetchedAt: at, etag: null } });
  const run = async (now: string, data: Record<string, ReturnType<typeof op>[]>) => {
    const instant = new Date(now);
    const asked: string[] = [];
    const r = await getParkHours("mk", {
      instant,
      getSchedule: async (id, month) => {
        const key = month ? `${month.year}-${String(month.month).padStart(2, "0")}` : "default";
        asked.push(`${id === ID ? "mk" : id}:${key}`);
        return data[key] ? res(data[key], instant.getTime()) : { ok: false, error: { kind: "timeout", message: "t" } };
      },
    });
    return { r, asked };
  };

  let o = await run("2026-10-15T15:00:00Z", { default: [op("2026-10-15"), op("2026-10-16")] });
  check("service: normal day = one default-window call with the park UUID", o.asked.join() === "mk:default" && o.r.status === "hours");

  o = await run("2026-10-15T15:00:00Z", { default: [op("2026-10-16")], "2026-10": [op("2026-10-14"), op("2026-10-16")] });
  check("service: potential closure adds only the current month", o.asked.join() === "mk:default,mk:2026-10" && o.r.status === "closed");

  o = await run("2026-10-31T15:00:00Z", { default: [], "2026-10": [op("2026-10-30")], "2026-11": [op("2026-11-02")] });
  check("service: month end fetches next month only when no later window", o.asked.join() === "mk:default,mk:2026-10,mk:2026-11" && o.r.status === "closed" && o.r.nextOpening?.date === "2026-11-02");

  o = await run("2026-12-31T15:00:00Z", { default: [], "2026-12": [op("2026-12-30")], "2027-01": [op("2027-01-01")] });
  check("service: December rolls to January next year", o.asked[2] === "mk:2027-01" && o.r.nextOpening?.relation === "tomorrow");

  o = await run("2026-10-15T15:00:00Z", { default: [op("2026-10-16")] });
  check("service: month follow-up failure → unknown, not Closed", o.r.status === "unknown");

  o = await run("2026-10-15T15:00:00Z", {});
  check("service: primary failure → unavailable, no follow-ups", o.r.status === "unavailable" && o.asked.length === 1);

  // Resort-local date, not server date: 03:00Z Oct 16 is still Oct 15 in Orlando.
  o = await run("2026-10-16T03:00:00Z", { default: [op("2026-10-15"), op("2026-10-16")] });
  check("service: uses the resort-local date", o.r.localDate === "2026-10-15" && o.r.status === "hours");
  return failures;
}

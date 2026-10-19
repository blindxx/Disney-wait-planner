/**
 * entertainmentAllService.ts — server-side fetch for Phase 12.11 All
 * Entertainment. Same shared ThemeParks client (60 s live cache) and clock
 * handling as entertainmentShowtimesService.ts; the pure inventory lives in
 * entertainmentAll.ts. Server-only; the browser reaches it via
 * /api/entertainment/all.
 */

import type { ParkId } from "@disney-wait-planner/shared";
import { buildParkAllEntertainment, type ParkAllEntertainment } from "./entertainmentAll";
import { themeParks, type ThemeParksLive, type ThemeParksResult } from "./themeParksApi";
import { THEMEPARKS_PARKS } from "./themeParksProviders";

/** Fetch the park's live payload via the shared ThemeParks client and build the All Entertainment inventory. */
export async function getParkAllEntertainment(
  parkId: ParkId,
  opts: { instant?: Date; getLive?: (id: string) => Promise<ThemeParksResult<ThemeParksLive>> } = {},
): Promise<ParkAllEntertainment> {
  const getLive = opts.getLive ?? ((id: string) => themeParks.getLive(id));
  const result = await getLive(THEMEPARKS_PARKS[parkId].entityId);
  // `now` is taken after the fetch so passed/upcoming reflects delivery time.
  return buildParkAllEntertainment(parkId, result, opts.instant ?? new Date());
}

/** DEV check (run manually; returns failing labels): service uses the park's provider UUID + injected clock. */
export async function runDevEntertainmentAllServiceCases(): Promise<string[]> {
  const failures: string[] = [];
  let asked = "";
  const r = await getParkAllEntertainment("mk", {
    instant: new Date("2026-10-01T19:00:00Z"),
    getLive: async (id) => { asked = id; return { ok: false, error: { kind: "timeout", message: "t" } }; },
  });
  if (asked !== THEMEPARKS_PARKS.mk.entityId) failures.push("all service: queries the park's ThemeParks UUID");
  if (r.error?.kind !== "timeout" || r.localDate !== "2026-10-01" || r.entries.length !== 0) failures.push("all service: failure → typed error, no entries, injected clock");
  return failures;
}

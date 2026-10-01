/**
 * entertainmentShowtimesService.ts — server-side fetch for Phase 12.3
 * Entertainment showtimes. Calls the shared ThemeParks client and hands the
 * result to the pure normalizer in entertainmentShowtimes.ts. Server-only
 * (the ThemeParks client is); the browser reaches it via
 * /api/entertainment/showtimes.
 */

import type { ParkId } from "@disney-wait-planner/shared";
import {
  normalizeParkEntertainmentShowtimes,
  type ParkEntertainmentShowtimes,
} from "./entertainmentShowtimes";
import { themeParks, type ThemeParksLive, type ThemeParksResult } from "./themeParksApi";
import { THEMEPARKS_PARKS } from "./themeParksProviders";

/** Fetch the park's live payload via the shared ThemeParks client and normalize it. */
export async function getParkEntertainmentShowtimes(
  parkId: ParkId,
  opts: { instant?: Date; getLive?: (id: string) => Promise<ThemeParksResult<ThemeParksLive>> } = {},
): Promise<ParkEntertainmentShowtimes> {
  const getLive = opts.getLive ?? ((id: string) => themeParks.getLive(id));
  const result = await getLive(THEMEPARKS_PARKS[parkId].entityId);
  // `now` is taken after the fetch so passed/upcoming reflects delivery time.
  return normalizeParkEntertainmentShowtimes(parkId, result, opts.instant ?? new Date());
}

/** DEV check (run manually; returns failing labels): service uses the park's provider UUID + injected clock. */
export async function runDevEntertainmentShowtimeServiceCases(): Promise<string[]> {
  const failures: string[] = [];
  let asked = "";
  const r = await getParkEntertainmentShowtimes("mk", {
    instant: new Date("2026-10-01T19:00:00Z"),
    getLive: async (id) => { asked = id; return { ok: false, error: { kind: "timeout", message: "t" } }; },
  });
  if (asked !== THEMEPARKS_PARKS.mk.entityId) failures.push("service: queries the park's ThemeParks UUID");
  if (r.error?.kind !== "timeout" || r.localDate !== "2026-10-01") failures.push("service: normalizes failure with injected clock");
  return failures;
}

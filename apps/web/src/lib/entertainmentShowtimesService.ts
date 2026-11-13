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
import { fetchParkHistory, type GetHistory } from "./entertainmentHistoryService";
import { themeParks, type ThemeParksLive, type ThemeParksResult } from "./themeParksApi";
import { THEMEPARKS_PARKS } from "./themeParksProviders";

/** Fetch the park's live payload via the shared ThemeParks client and normalize it. */
export async function getParkEntertainmentShowtimes(
  parkId: ParkId,
  opts: { instant?: Date; getLive?: (id: string) => Promise<ThemeParksResult<ThemeParksLive>>; getHistory?: GetHistory } = {},
): Promise<ParkEntertainmentShowtimes> {
  const getLive = opts.getLive ?? ((id: string) => themeParks.getLive(id));
  const result = await getLive(THEMEPARKS_PARKS[parkId].entityId);
  // `now` is taken after the fetch so passed/upcoming reflects delivery time.
  const first = normalizeParkEntertainmentShowtimes(parkId, result, opts.instant ?? new Date());
  // Phase 14.4.2: history only when it could decide an entry (bounded provider usage); failure → first pass stands.
  if (!first.entries.some((e) => e.historyCandidate)) return first;
  const instant = opts.instant ?? new Date();
  const history = await fetchParkHistory(parkId, instant, opts.getHistory);
  return normalizeParkEntertainmentShowtimes(parkId, result, opts.instant ?? new Date(), history);
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
  // Phase 14.4.2: no history call unless a candidate exists (provider failure → no history asked).
  let historyCalls = 0;
  await getParkEntertainmentShowtimes("mk", {
    instant: new Date("2026-10-01T19:00:00Z"),
    getLive: async () => ({ ok: false, error: { kind: "timeout", message: "t" } }),
    getHistory: async () => { historyCalls++; return { ok: false, error: { kind: "network", message: "h" } }; },
  });
  if (historyCalls !== 0) failures.push("service: live failure never requests history");
  return failures;
}

/**
 * entertainmentHistoryService.ts — Phase 14.4.2 server-side history fetch for
 * the entertainment services. Pure evidence logic lives in
 * entertainmentHistory.ts; the client (themeParksApi.ts) owns caching (1 h),
 * the 50-calls/hour budget and the history-only 429 backoff.
 *
 * Usage is bounded three ways: (1) history is requested only when the first,
 * history-free pass produced an entry history could decide
 * (`historyCandidate`); (2) one park-level 7-day request per park, never per
 * entity; (3) the shared client cache serves it for an hour. Any failure
 * degrades to forward-horizon-only behavior — it never blocks or fails the
 * showtimes/All Entertainment response.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { historyWindow } from "./entertainmentHistory";
import { PARK_TO_RESORT } from "./parkMetadata";
import { themeParks, type ThemeParksHistoryDaily, type ThemeParksResult } from "./themeParksApi";
import { THEMEPARKS_PARKS } from "./themeParksProviders";

export type GetHistory = (id: string, range: { from: string; to: string }) => Promise<ThemeParksResult<ThemeParksHistoryDaily>>;

/** Park-level [today-6, today] history (resort-local window for `instant`); never throws. */
export async function fetchParkHistory(
  parkId: ParkId,
  instant: Date,
  getHistory: GetHistory = (id, range) => themeParks.getHistoryDaily(id, range),
): Promise<ThemeParksResult<ThemeParksHistoryDaily>> {
  try {
    return await getHistory(THEMEPARKS_PARKS[parkId].entityId, historyWindow(PARK_TO_RESORT[parkId] as ResortId, instant));
  } catch (e) {
    return { ok: false, error: { kind: "network", message: e instanceof Error ? e.message : "history request failed" } };
  }
}

/**
 * entertainmentHistoryService.ts — Phase 14.4.2 server-side history fetch for
 * the entertainment services. Pure evidence logic lives in
 * entertainmentHistory.ts; the client (themeParksApi.ts) owns the optional
 * THEMEPARKS_API_KEY (history requests only), caching (1 h), per-tier budgets
 * (+ the provider's RateLimit-History-* headers) and 401/403/429 handling.
 *
 * Usage is bounded three ways: (1) history is requested only when the first,
 * history-free pass produced an entry history could decide
 * (`historyCandidate`); (2) one park-level request per park (30-day
 * authenticated / 7-day anonymous), never per entity; (3) the shared client
 * cache serves it for an hour. Any failure
 * degrades to forward-horizon-only behavior — it never blocks or fails the
 * showtimes/All Entertainment response.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { HISTORY_SHORT_DAYS, historyWindow } from "./entertainmentHistory";
import { PARK_TO_RESORT } from "./parkMetadata";
import { themeParks, type ThemeParksHistoryDaily, type ThemeParksResult } from "./themeParksApi";
import { THEMEPARKS_PARKS } from "./themeParksProviders";

export type GetHistory = (id: string, range: { from: string; to: string }) => Promise<ThemeParksResult<ThemeParksHistoryDaily>>;
/** Current history access tier (never exposes the key). */
export type GetHistoryAccess = () => { maxDays: number; keyStatus?: "none" | "active" | "cooldown" };

/**
 * Optional, secret-free record of what `fetchParkHistory` did (diagnostics only):
 * the tier/window of each attempt and its typed outcome. Filling it never changes
 * behavior and never issues a request.
 */
export interface HistoryFetchTrace {
  keyStatus: "none" | "active" | "cooldown" | "unknown";
  attempts: Array<{ days: number; tier: "authenticated" | "anonymous"; outcome: string }>;
}

/**
 * Park-level history for `instant`'s resort-local window; never throws.
 *
 * One bounded request per park: the tier's full window (authenticated 30 d /
 * anonymous 7 d). A second, 7-day request happens ONLY when the first could not
 * be used because of access or shape — the key was not accepted (the client has
 * already dropped to the anonymous tier), the window was refused, or the
 * provider paged the long answer (`hasMore`). Timeouts, 429s and network errors
 * are returned as-is (no retry storm); the caller then keeps forward-horizon-only
 * behavior.
 */
export async function fetchParkHistory(
  parkId: ParkId,
  instant: Date,
  getHistory: GetHistory = (id, range) => themeParks.getHistoryDaily(id, range),
  getAccess: GetHistoryAccess = () => themeParks.historyAccess(),
  trace?: HistoryFetchTrace,
): Promise<ThemeParksResult<ThemeParksHistoryDaily>> {
  const resort = PARK_TO_RESORT[parkId] as ResortId;
  const id = THEMEPARKS_PARKS[parkId].entityId;
  const call = async (days: number): Promise<ThemeParksResult<ThemeParksHistoryDaily>> => {
    const access = getAccess();
    let res: ThemeParksResult<ThemeParksHistoryDaily>;
    try {
      res = await getHistory(id, historyWindow(resort, instant, days));
    } catch (e) {
      res = { ok: false, error: { kind: "network", message: e instanceof Error ? e.message : "history request failed" } };
    }
    if (trace) {
      trace.keyStatus = access.keyStatus ?? "unknown";
      trace.attempts.push({
        days,
        tier: access.maxDays > HISTORY_SHORT_DAYS ? "authenticated" : "anonymous",
        outcome: res.ok ? (res.meta.origin === "stale" ? "stale" : res.data.hasMore ? "paged" : "ok") : res.error.kind,
      });
    }
    return res;
  };
  const firstDays = Math.max(HISTORY_SHORT_DAYS, getAccess().maxDays);
  const first = await call(firstDays);
  const accessFailure = (k: string | undefined) => k === "unauthorized" || k === "history_window";
  // A stale-if-error answer whose refresh was refused (key rejected after a good 30-day fetch) is
  // an access failure too: the client serves the cached payload as ok, but it can never be evidence.
  const retryable = first.ok
    ? first.data.hasMore || (first.meta.origin === "stale" && accessFailure(first.meta.staleReason?.kind))
    : accessFailure(first.error.kind);
  if (!retryable || firstDays <= HISTORY_SHORT_DAYS) return first;
  return call(HISTORY_SHORT_DAYS);
}

/** Optional enrichment must never hold the response: past this, callers keep the history-free result. */
export const HISTORY_ENRICHMENT_DEADLINE_MS = 2_000;

/**
 * `fetchParkHistory` bounded by a deadline. On expiry the result is a typed
 * timeout (callers fall back to forward-horizon-only); the underlying request
 * keeps going so the client cache can serve the next call, and its late result
 * is discarded here.
 */
export async function fetchParkHistoryWithin(
  deadlineMs: number,
  parkId: ParkId,
  instant: Date,
  getHistory?: GetHistory,
  getAccess?: GetHistoryAccess,
  trace?: HistoryFetchTrace,
): Promise<ThemeParksResult<ThemeParksHistoryDaily>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ThemeParksResult<ThemeParksHistoryDaily>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: { kind: "timeout", message: "history enrichment deadline" } }), deadlineMs);
  });
  try {
    return await Promise.race([fetchParkHistory(parkId, instant, getHistory, getAccess, trace), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

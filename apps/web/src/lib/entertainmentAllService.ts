/**
 * entertainmentAllService.ts — server-side fetch for Phase 12.11 All
 * Entertainment. Same shared ThemeParks client (60 s live cache) and clock
 * handling as entertainmentShowtimesService.ts; the pure inventory lives in
 * entertainmentAll.ts. Server-only; the browser reaches it via
 * /api/entertainment/all.
 */

import type { ParkId } from "@disney-wait-planner/shared";
import { queryCatalog } from "./catalogQuery";
import { PROVIDER_ENTERTAINMENT_LOCATIONS } from "./entertainmentProviderLocations";
import { PARK_LABELS } from "./parkMetadata";
import { buildParkAllEntertainment, type ParkAllEntertainment } from "./entertainmentAll";
import { HISTORY_ENRICHMENT_DEADLINE_MS, fetchParkHistoryWithin, type GetHistory, type GetHistoryAccess, type HistoryFetchTrace } from "./entertainmentHistoryService";
import { logHistoryDiagnostics, type HistoryDiagSink } from "./historyDiagnostics"; // history-diagnostics (temporary, Preview-only)
import { applyRegisteredMeetWindows } from "./eventExclusiveMeets";
import { themeParks, type ThemeParksLive, type ThemeParksResult } from "./themeParksApi";
import { THEMEPARKS_PARKS } from "./themeParksProviders";

/** Fetch the park's live payload via the shared ThemeParks client and build the All Entertainment inventory. */
export async function getParkAllEntertainment(
  parkId: ParkId,
  opts: { instant?: Date; getLive?: (id: string) => Promise<ThemeParksResult<ThemeParksLive>>; getHistory?: GetHistory; getHistoryAccess?: GetHistoryAccess; skipHistory?: boolean; historyDeadlineMs?: number; diagEnv?: Record<string, string | undefined>; diagSink?: HistoryDiagSink } = {},
): Promise<ParkAllEntertainment> {
  const getLive = opts.getLive ?? ((id: string) => themeParks.getLive(id));
  const raw = await getLive(THEMEPARKS_PARKS[parkId].entityId);
  // `now` is taken after the fetch so passed/upcoming reflects delivery time.
  // Phase 14.4.2: registered party meets read their "Special Ticketed Event"
  // window as operating hours here exactly as on Waits & Shows.
  const result = applyRegisteredMeetWindows(parkId, raw, opts.instant ?? new Date());
  const first = buildParkAllEntertainment(parkId, result, opts.instant ?? new Date());
  // History only when it could decide an entry (bounded provider usage); failure → first pass stands.
  if (opts.skipHistory) return first;
  if (!first.entries.some((e) => e.showtime.historyCandidate)) {
    logHistoryDiagnostics({ parkId, instant: opts.instant ?? new Date(), live: result, history: null, entries: first.entries.map((e) => e.showtime) }, opts.diagEnv ? { env: opts.diagEnv, sink: opts.diagSink } : {}); // history-diagnostics
    return first;
  }
  const instant = opts.instant ?? new Date();
  const trace: HistoryFetchTrace = { keyStatus: "unknown", attempts: [] }; // history-diagnostics
  const history = await fetchParkHistoryWithin(opts.historyDeadlineMs ?? HISTORY_ENRICHMENT_DEADLINE_MS, parkId, instant, opts.getHistory, opts.getHistoryAccess, trace);
  const final = buildParkAllEntertainment(parkId, result, opts.instant ?? new Date(), history);
  logHistoryDiagnostics({ parkId, instant: opts.instant ?? new Date(), live: result, history, trace, entries: final.entries.map((e) => e.showtime) }, opts.diagEnv ? { env: opts.diagEnv, sink: opts.diagSink } : {}); // history-diagnostics
  return final;
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

/**
 * DEV check (run manually; returns failing labels): every provider-only
 * location land is already in DWP's land vocabulary for that park (the active
 * catalogs via catalogQuery), so the two-source land filter never forks it.
 */
export function runDevEntertainmentLocationVocabularyCases(): string[] {
  const failures: string[] = [];
  const res = queryCatalog({});
  if (!res.ok) return ["vocabulary: catalog query failed"];
  const vocab = new Map<string, Set<string>>();
  for (const r of res.results) {
    if (!r.land || !r.park) continue;
    const set = vocab.get(r.park) ?? new Set<string>();
    set.add(r.land);
    vocab.set(r.park, set);
  }
  for (const l of PROVIDER_ENTERTAINMENT_LOCATIONS) {
    if (!vocab.get(PARK_LABELS[l.parkId])?.has(l.land)) failures.push(`vocabulary: "${l.land}" not a known land for ${l.parkId} (${l.entityId})`);
  }
  return failures;
}

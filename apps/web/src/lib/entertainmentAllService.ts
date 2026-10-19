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

/**
 * eventExclusiveMeetsService.ts — server-side fetch for Phase 14.4C event-
 * exclusive character meets. Pure logic lives in eventExclusiveMeets.ts.
 * Server-only; the browser reaches it via /api/entertainment/event-meets.
 *
 * Providers are contacted ONLY when the registry confirms a party today for the
 * park (non-party days cost nothing and never touch a provider). ThemeParks
 * (shared 60 s client) and Queue-Times (exact park payload, short timeout) are
 * fetched independently; neither failure masks the other.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import {
  buildParkEventMeets,
  getConfirmedPartyMeets,
  getEventExclusiveMeetsForPark,
  type ParkEventMeets,
  type QueueTimesFetch,
} from "./eventExclusiveMeets";
import { QUEUE_TIMES_PARK_MAP } from "./liveWaitApi";
import { PARK_TO_RESORT } from "./parkMetadata";
import { getResortLocalDate } from "./resortTime";
import { themeParks, type ThemeParksLive, type ThemeParksResult } from "./themeParksApi";
import { THEMEPARKS_PARKS } from "./themeParksProviders";

const QUEUE_TIMES_TIMEOUT_MS = 8_000;

async function fetchQueueTimes(parkId: ParkId): Promise<QueueTimesFetch> {
  const qtParkId = QUEUE_TIMES_PARK_MAP[`${PARK_TO_RESORT[parkId]}:${parkId}`];
  if (qtParkId === undefined) return { ok: false };
  try {
    const res = await fetch(`https://queue-times.com/parks/${qtParkId}/queue_times.json`, {
      cache: "no-store",
      signal: AbortSignal.timeout(QUEUE_TIMES_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false };
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false };
  }
}

export async function getParkEventMeets(
  parkId: ParkId,
  opts: {
    instant?: Date;
    getLive?: (id: string) => Promise<ThemeParksResult<ThemeParksLive>>;
    getQueueTimes?: (parkId: ParkId) => Promise<QueueTimesFetch>;
  } = {},
): Promise<ParkEventMeets> {
  const getLive = opts.getLive ?? ((id: string) => themeParks.getLive(id));
  const getQt = opts.getQueueTimes ?? fetchQueueTimes;
  const before = opts.instant ?? new Date();
  const localDate = getResortLocalDate(PARK_TO_RESORT[parkId] as ResortId, before);
  if (getConfirmedPartyMeets(parkId, localDate, before).length === 0) return buildParkEventMeets(parkId, null, null, before);
  const needsQt = getEventExclusiveMeetsForPark(parkId).some((m) => !!m.queueTimes);
  const [tp, qt] = await Promise.all([
    getLive(THEMEPARKS_PARKS[parkId].entityId),
    needsQt ? getQt(parkId) : Promise.resolve(null),
  ]);
  // `now` after the fetches so passed/fresh checks reflect delivery time.
  return buildParkEventMeets(parkId, tp, qt, opts.instant ?? new Date());
}

/** DEV check (run manually; returns failing labels): no provider call on non-party days; both providers on party days. */
export async function runDevEventExclusiveMeetsServiceCases(): Promise<string[]> {
  const failures: string[] = [];
  let calls = 0;
  const probe = { getLive: async () => { calls++; return { ok: false, error: { kind: "timeout", message: "t" } } as ThemeParksResult<ThemeParksLive>; }, getQueueTimes: async () => { calls++; return { ok: false } as QueueTimesFetch; } };
  const off = await getParkEventMeets("mk", { ...probe, instant: new Date("2026-11-10T17:00:00Z") });
  if (calls !== 0 || off.partyDate || off.entries.length !== 0) failures.push("meets service: non-party day makes no provider calls");
  let asked = "";
  const on = await getParkEventMeets("mk", {
    instant: new Date("2026-11-12T15:00:00Z"),
    getLive: async (id) => { asked = id; return { ok: false, error: { kind: "timeout", message: "t" } }; },
    getQueueTimes: async () => { calls++; return { ok: false }; },
  });
  if (asked !== THEMEPARKS_PARKS.mk.entityId || calls !== 1) failures.push("meets service: party day queries the park's ThemeParks UUID and Queue-Times");
  if (!on.partyDate || on.error?.kind !== "timeout" || on.entries.length !== 0) failures.push("meets service: ThemeParks failure → typed error, no entries");
  return failures;
}

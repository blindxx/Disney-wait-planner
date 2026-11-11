/**
 * eventExclusiveMeets.ts — Phase 14.4C event-exclusive character meets for
 * Waits & Shows.
 *
 * Shows verified, individually identifiable, STATIONARY character meets that
 * exist only at a separately ticketed party, and only on CONFIRMED party dates.
 * Ordinary meets, roaming characters, generic "Character Greetings" umbrella
 * records, regular seasonal meets (park-admission) and unverified costume
 * identities are never listed here.
 *
 * Single sources reused (nothing duplicated):
 *   - Party dates: the maintained registry (seasonalEventData.ts) via the
 *     explicit park+UUID party associations in
 *     `SEASONAL_PROVIDER_ONLY_EVENTS` (seasonalEntertainment.ts). A meet is
 *     visible iff `getSeasonalProviderEntertainmentRank` is "party-night" for
 *     the resort-local date — i.e. a confirmed party night. Non-party dates
 *     (including inside the holiday season), unannounced/unknown dates and
 *     historical dates are never confirmed. Visible the ENTIRE local calendar
 *     day (before party hours too); status is never required to be OPERATING.
 *   - Schedules / operating hours / completeness: `buildParkAllEntertainment`
 *     (entertainmentAll.ts → entertainmentShowtimes.ts), unchanged.
 *   - Park-qualified Queue-Times ids: `QUEUE_TIMES_PARK_MAP` (liveWaitApi.ts).
 *
 * This module only adds the explicit meet list below (identity: park + exact
 * ThemeParks UUID, optional exact Queue-Times ride id) — never name matching.
 *
 * Provider semantics
 *   - ThemeParks.wiki verifies identity/presence (a record must be present in
 *     the park's successful live payload under its registered UUID, park and
 *     expected name — `meetNameMatches`; a changed name omits that meet) and supplies performances/operating
 *     hours. Its wait value is never used or invented.
 *   - Queue-Times supplies the actual wait ONLY for the verified event-specific
 *     ride id (exact id, expected name, same park payload, fresh). No ordinary
 *     meet's wait is ever substituted. Queue-Times failing never hides a
 *     ThemeParks-verified meet; it only leaves the wait "unavailable".
 *   - A ThemeParks failure is "unavailable" (separate from a confirmed absence,
 *     which simply lists nothing). No static/placeholder cards, ever.
 *
 * Provider limitations are recorded in the registry `note`s.
 *
 * DEV checks: `runDevEventExclusiveMeetCases()` (run manually from Node).
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { buildParkAllEntertainment, allEntryViewAt, type AllEntertainmentEntry } from "./entertainmentAll";
import { PARTIAL_SHOWTIMES_NOTE } from "./entertainmentShowtimes";
import { QUEUE_TIMES_PARK_MAP } from "./liveWaitApi";
import { PARK_TO_RESORT } from "./parkMetadata";
import { getResortLocalDate } from "./resortTime";
import { SEASONAL_PROVIDER_ONLY_EVENTS, getSeasonalProviderEntertainmentRank } from "./seasonalEntertainment";
import type { ThemeParksError, ThemeParksLive, ThemeParksResult } from "./themeParksApi";

// ============================================
// REGISTRY (explicit, park-qualified, exact ids)
// ============================================

export type EventExclusiveMeet = {
  parkId: ParkId;
  /** Exact ThemeParks.wiki SHOW entity UUID (lowercase). Its party association lives in SEASONAL_PROVIDER_ONLY_EVENTS. */
  entityId: string;
  /** Provider display name when verified (informational; the live name is shown). */
  providerName: string;
  /** Exact Queue-Times ride id + expected name for the same physical meet, when one exists. */
  queueTimes?: { rideId: number; name: string };
  note?: string;
};

/**
 * Verified 2026-11-10 against ThemeParks.wiki park children/live and
 * Queue-Times (all six parks). Excluded on purpose (see PR notes): the
 * "Character Greetings at …" umbrella records, ordinary/roaming meets,
 * DCA "Meet Santa Claus at the Disneyland Resort" (park-admission season, not
 * ticketed), and the MNSSHP Halloween Jack and Sally (no current provider
 * record to revalidate — add once the provider republishes it).
 */
export const EVENT_EXCLUSIVE_MEETS: EventExclusiveMeet[] = [
  {
    parkId: "mk", entityId: "6d3b1129-b34c-4b44-bba2-0e1790fef705",
    providerName: "Meet Santa Jack and Sally at Mickey’s Very Merry Christmas Party",
    queueTimes: { rideId: 15395, name: "Meet Santa Jack and Sally at Mickey’s Very Merry Christmas Party" },
    note: "Only meet with its own event-specific Queue-Times row.",
  },
  {
    parkId: "mk", entityId: "418c2111-36d4-4f07-86b2-8058014a263c",
    providerName: "Join Santa Claus at Mickey's Very Merry Christmas Party",
    note: "No Queue-Times record: waits are never shown, schedule/hours only when ThemeParks publishes them.",
  },
  {
    parkId: "hs", entityId: "ae7db7da-a3d9-443b-b4a6-d3c4a2b66121",
    providerName: "Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights",
    note: "No Queue-Times record (the Celebrity Spotlight row there is the ordinary Olaf meet, never substituted).",
  },
];

export function getEventExclusiveMeetsForPark(parkId: ParkId): EventExclusiveMeet[] {
  return EVENT_EXCLUSIVE_MEETS.filter((m) => m.parkId === parkId);
}

/**
 * Meets whose party is CONFIRMED on `localDate` (resort-local "YYYY-MM-DD").
 * Registry-only: provider data never decides visibility.
 */
export function getConfirmedPartyMeets(parkId: ParkId, localDate: string, instant: Date = new Date()): EventExclusiveMeet[] {
  const resort = PARK_TO_RESORT[parkId] as ResortId;
  return getEventExclusiveMeetsForPark(parkId).filter(
    (m) => getSeasonalProviderEntertainmentRank(parkId, m.entityId, { resort, date: localDate, parkId, instant }) === "party-night",
  );
}

// ============================================
// TYPES
// ============================================

export type EventMeetWait =
  | { state: "live"; minutes: number; updatedAt: string }
  /** Queue-Times reports the verified row not operating (normal before the party starts). */
  | { state: "closed"; updatedAt: string }
  | { state: "unavailable"; reason: "no_queue_times_record" | "queue_times_failed" | "stale" | "identity_mismatch" };

export interface EventMeetEntry {
  /** `event-meet:{park}:{uuid}` — park-qualified, stable. */
  id: string;
  parkId: ParkId;
  entityId: string;
  /** Provider's own display name for the verified record. */
  name: string;
  /** ThemeParks status of the record (OPERATING | CLOSED | …); null when not current. */
  status: string | null;
  wait: EventMeetWait;
  /** Normalized performances/operating hours/completeness (same shape as All Entertainment). */
  schedule: AllEntertainmentEntry;
}

export interface ParkEventMeets {
  parkId: ParkId;
  resort: ResortId;
  /** Resort-local date this state was computed for. */
  localDate: string;
  /** True when at least one meet is a CONFIRMED party-date meet today (registry). Gates the whole section. */
  partyDate: boolean;
  /** ThemeParks failure on a party date: identity can't be verified → nothing listed, shown as unavailable (not as absence). */
  error: ThemeParksError | null;
  /** ThemeParks payload is a stale-if-error copy. */
  stale: boolean;
  entries: EventMeetEntry[];
}

export type QueueTimesFetch =
  | { ok: true; body: unknown }
  | { ok: false };

/** A Queue-Times wait older than this is not trusted as current. */
export const QUEUE_TIMES_FRESH_MS = 30 * 60_000;

// ============================================
// QUEUE-TIMES (verified event-specific ids only)
// ============================================

type QtRide = { id: number; name: string; is_open: boolean; wait_time: number; last_updated: string };

function qtRidesById(body: unknown): Map<number, QtRide> | null {
  const b = body as { lands?: unknown; rides?: unknown } | null;
  if (!b || typeof b !== "object") return null;
  const lists: unknown[] = [];
  if (Array.isArray(b.lands)) for (const l of b.lands) { const r = (l as { rides?: unknown })?.rides; if (Array.isArray(r)) lists.push(...r); }
  if (Array.isArray(b.rides)) lists.push(...b.rides);
  if (lists.length === 0 && !Array.isArray(b.lands) && !Array.isArray(b.rides)) return null;
  const map = new Map<number, QtRide>();
  for (const r of lists as Partial<QtRide>[]) {
    if (!r || typeof r.id !== "number" || typeof r.name !== "string" || typeof r.is_open !== "boolean" || typeof r.wait_time !== "number" || typeof r.last_updated !== "string") continue;
    if (!map.has(r.id)) map.set(r.id, r as QtRide);
  }
  return map;
}

/**
 * Identity-guard normalization: tolerant of harmless formatting only —
 * case, Unicode form/diacritics, apostrophes/quotes (dropped, so "Mickey\u2019s" ≡
 * "Mickeys"), "&" ≡ "and", other punctuation, and whitespace. Words are never
 * dropped, reordered or matched by substring, so any real change (a different
 * character, location or event) still differs.
 */
export function normalizeMeetIdentityName(s: string): string {
  return s
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b\u2032`\u00b4'"\u201c\u201d]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** True when `providerName` still names the registered encounter (strict equality after normalization). */
export function meetNameMatches(expected: string, providerName: string): boolean {
  const e = normalizeMeetIdentityName(expected);
  return e.length > 0 && e === normalizeMeetIdentityName(providerName);
}

function waitFor(meet: EventExclusiveMeet, qt: QueueTimesFetch | null, instant: Date): EventMeetWait {
  if (!meet.queueTimes) return { state: "unavailable", reason: "no_queue_times_record" };
  if (!qt || !qt.ok) return { state: "unavailable", reason: "queue_times_failed" };
  const rides = qtRidesById(qt.body);
  if (!rides) return { state: "unavailable", reason: "queue_times_failed" };
  const row = rides.get(meet.queueTimes.rideId);
  if (!row) return { state: "unavailable", reason: "no_queue_times_record" };
  if (!meetNameMatches(meet.queueTimes.name, row.name)) return { state: "unavailable", reason: "identity_mismatch" };
  const updatedMs = Date.parse(row.last_updated);
  if (!Number.isFinite(updatedMs) || instant.getTime() - updatedMs > QUEUE_TIMES_FRESH_MS) return { state: "unavailable", reason: "stale" };
  return row.is_open
    ? { state: "live", minutes: Math.max(0, Math.round(row.wait_time)), updatedAt: row.last_updated }
    : { state: "closed", updatedAt: row.last_updated };
}

// ============================================
// BUILD (pure)
// ============================================

/**
 * Pure: the park's event-meet state for `instant`.
 *
 * `tp` / `qt` may be null when the caller skipped the fetch because no party is
 * confirmed (`partyDate` false → nothing is listed regardless of provider data).
 */
export function buildParkEventMeets(
  parkId: ParkId,
  tp: ThemeParksResult<ThemeParksLive> | null,
  qt: QueueTimesFetch | null,
  instant: Date = new Date(),
): ParkEventMeets {
  const resort = PARK_TO_RESORT[parkId] as ResortId;
  const localDate = getResortLocalDate(resort, instant);
  const confirmed = getConfirmedPartyMeets(parkId, localDate, instant);
  const base: ParkEventMeets = { parkId, resort, localDate, partyDate: confirmed.length > 0, error: null, stale: false, entries: [] };
  if (confirmed.length === 0 || !tp) return base;
  if (!tp.ok) return { ...base, error: tp.error };

  const all = buildParkAllEntertainment(parkId, tp, instant);
  const payloadCurrent = all.fetchedLocalDate === localDate;
  const seen = new Set<string>();
  const entries: EventMeetEntry[] = [];
  for (const meet of confirmed) {
    if (seen.has(meet.entityId)) continue; // one card per physical meet
    const schedule = all.entries.find((e) => e.id === `provider:${meet.entityId}`);
    if (!schedule) continue; // absent from the park's live payload → not verified, never fabricated
    const live = tp.data.entries.find((e) => e.entityId.toLowerCase() === meet.entityId);
    // Identity guard: the live record's current name must still be the registered
    // encounter. A renamed/repurposed record is omitted (never substituted); the
    // other meets are unaffected.
    if (!meetNameMatches(meet.providerName, schedule.name)) continue;
    seen.add(meet.entityId);
    entries.push({
      id: `event-meet:${parkId}:${meet.entityId}`,
      parkId,
      entityId: meet.entityId,
      name: schedule.name,
      status: payloadCurrent ? (live?.status ?? null) : null,
      wait: waitFor(meet, qt, instant),
      schedule,
    });
  }
  return { ...base, stale: all.stale, entries };
}

// ============================================
// DISPLAY (pure, client-safe)
// ============================================

export interface EventMeetView {
  /** "Closed" / "Operating" / null (unknown). Closed before the party starts is normal. */
  statusText: string | null;
  /** "Wait: 25 min" only for a verified live Queue-Times wait; null otherwise. */
  waitText: string | null;
  /** Wait unavailable note (never a guessed wait). */
  waitNote: string | null;
  /** Performances / operating hours text (re-evaluated at `now`). */
  scheduleText: string | null;
}

const WAIT_NOTES: Record<Extract<EventMeetWait, { state: "unavailable" }>["reason"], string | null> = {
  no_queue_times_record: null, // no wait provider for this meet: say nothing rather than imply an outage
  queue_times_failed: "Wait time unavailable",
  stale: "Wait time unavailable",
  identity_mismatch: "Wait time unavailable",
};

export function describeEventMeet(entry: EventMeetEntry, now: Date = new Date()): EventMeetView {
  const view = allEntryViewAt(entry.schedule, now);
  const statusFromWait = entry.wait.state === "closed" ? "Closed" : entry.wait.state === "live" ? "Operating" : null;
  const s = entry.status?.toUpperCase();
  const statusFromProvider = s === "OPERATING" ? "Operating" : s === "CLOSED" ? "Closed" : null;
  // Upcoming-only times from an incomplete schedule keep the standard qualifier (never look complete).
  const timesText = view.collapsedText && view.partial ? `${view.collapsedText} (${PARTIAL_SHOWTIMES_NOTE})` : view.collapsedText;
  const scheduleParts = [timesText, view.hoursText].filter((t): t is string => !!t);
  return {
    statusText: statusFromWait ?? statusFromProvider,
    waitText: entry.wait.state === "live" ? `Wait: ${entry.wait.minutes} min` : null,
    waitNote: entry.wait.state === "unavailable" ? WAIT_NOTES[entry.wait.reason] : null,
    scheduleText: scheduleParts.length > 0 ? scheduleParts.join(" • ") : null,
  };
}

/** Section copy when a party is confirmed but ThemeParks identity could not be verified. */
export const EVENT_MEETS_UNAVAILABLE_MESSAGE = "Party character meets are unavailable right now.";

/** Whether the section shows at all (confirmed party date AND something to say). */
export function eventMeetsSectionState(data: ParkEventMeets | null): "hidden" | "list" | "unavailable" {
  if (!data || !data.partyDate) return "hidden";
  if (data.error) return "unavailable";
  return data.entries.length > 0 ? "list" : "hidden";
}

/** Browser-side: fetched body → state; failure/wrong shape degrades to hidden (nothing retained or fabricated). */
export function resolveEventMeetsResponse(parkId: ParkId, body: unknown): ParkEventMeets | null {
  const d = body as Partial<ParkEventMeets> | null;
  if (!d || typeof d !== "object" || d.parkId !== parkId || !Array.isArray(d.entries) || typeof d.localDate !== "string" || typeof d.partyDate !== "boolean") return null;
  return d as ParkEventMeets;
}

/** Data computed for a previous resort-local day, or another park, is never shown as today's. */
export function eventMeetsForDisplay(data: ParkEventMeets | null, parkId: ParkId, instant: Date = new Date()): ParkEventMeets | null {
  if (!data || data.parkId !== parkId) return null;
  return data.localDate === getResortLocalDate(data.resort, instant) ? data : null;
}

// ============================================
// DEV CASES
// ============================================

export type DevEventMeetCase = { label: string; ok: () => boolean };

const MK = "75ea578a-adc8-4116-a54d-dccb60765ef9";
const HS = "288747d1-8b4f-4a64-867e-ea7c9b27bad8";
const JS_ID = "6d3b1129-b34c-4b44-bba2-0e1790fef705";
const SANTA_ID = "418c2111-36d4-4f07-86b2-8058014a263c";
const GREETINGS_ID = "8b8cb0ec-10a3-41d9-b5cb-81ea8db14370";
const STITCH_ID = "ae7db7da-a3d9-443b-b4a6-d3c4a2b66121";
const JS_NAME = "Meet Santa Jack and Sally at Mickey’s Very Merry Christmas Party";

// Resort-local (EST) instants. MVMCP nights Nov 12–13, non-party Nov 10 and 14; JN night Nov 14 / non-party Nov 13.
const at = (iso: string) => new Date(iso);
const MVMCP_MORNING = at("2026-11-12T13:00:00Z"); // 8:00 AM EST, hours before party
const MVMCP_EVENING = at("2026-11-13T00:30:00Z"); // Nov 12, 7:30 PM EST
const NON_PARTY = at("2026-11-10T17:00:00Z");
const JN_MORNING = at("2026-11-14T15:00:00Z");

const tpEntry = (entityId: string, name: string, parkUuid: string, status: string | null, showtimes: { type: string | null; startTime: string; endTime: string | null }[] = []) =>
  ({ entityId, name, entityType: "SHOW", parkId: parkUuid, externalId: null, status, lastUpdated: null, showtimes, droppedShowtimes: 0 });
const tpOk = (parkUuid: string, entries: ReturnType<typeof tpEntry>[]): ThemeParksResult<ThemeParksLive> =>
  ({ ok: true, data: { entityId: parkUuid, name: "park", timeZone: "America/New_York", entries, droppedEntries: 0, droppedShowtimes: 0 }, meta: { origin: "network", fetchedAt: 0, etag: null } });
const mkEntries = (status = "CLOSED", showtimes: Parameters<typeof tpEntry>[4] = []) => [
  tpEntry(JS_ID, JS_NAME, MK, status, showtimes),
  tpEntry(SANTA_ID, "Join Santa Claus at Mickey's Very Merry Christmas Party", MK, status),
  tpEntry(GREETINGS_ID, "Character Greetings at Mickey's Very Merry Christmas Party", MK, status),
  tpEntry("a2d92647-634d-4eb4-886b-9da858e871f1", "Meet Mickey at Town Square Theater", MK, "OPERATING"),
];
const qtBody = (rows: Partial<QtRide>[]) => ({ lands: [{ id: 1, name: "Main Street, U.S.A.", rides: rows }], rides: [] });
const jsRow = (over: Partial<QtRide> = {}, now = MVMCP_MORNING): Partial<QtRide> =>
  ({ id: 15395, name: JS_NAME, is_open: false, wait_time: 0, last_updated: new Date(now.getTime() - 60_000).toISOString(), ...over });
const ordinaryRow = (now = MVMCP_MORNING): Partial<QtRide> =>
  ({ id: 146, name: "Meet Mickey at Town Square Theater", is_open: true, wait_time: 40, last_updated: new Date(now.getTime() - 60_000).toISOString() });
const build = (now: Date, tp = tpOk(MK, mkEntries()), qt: QueueTimesFetch | null = { ok: true, body: qtBody([jsRow({}, now), ordinaryRow(now)]) }, parkId: ParkId = "mk") =>
  // Payload "fetched" 30 s before `now` (same resort-local day) unless the case overrides it.
  buildParkEventMeets(parkId, tp.ok && tp.meta.fetchedAt === 0 ? { ...tp, meta: { ...tp.meta, fetchedAt: now.getTime() - 30_000 } } : tp, qt, now);

export const DEV_EVENT_MEET_CASES: DevEventMeetCase[] = [
  // Registry integrity
  { label: "registry: every meet is a party-kind association for the same park+UUID in the maintained registry (no second event table)", ok: () =>
    EVENT_EXCLUSIVE_MEETS.every((m) => SEASONAL_PROVIDER_ONLY_EVENTS.some((r) => r.parkId === m.parkId && r.entityId === m.entityId && r.associations.every((a) => a.kind === "party"))) },
  { label: "registry: unique park+UUID, lowercase UUIDs, unique Queue-Times ids, QT ids belong to a mapped park", ok: () => {
    const keys = EVENT_EXCLUSIVE_MEETS.map((m) => `${m.parkId}:${m.entityId}`);
    const qts = EVENT_EXCLUSIVE_MEETS.flatMap((m) => (m.queueTimes ? [m.queueTimes.rideId] : []));
    return new Set(keys).size === keys.length && new Set(qts).size === qts.length &&
      EVENT_EXCLUSIVE_MEETS.every((m) => m.entityId === m.entityId.toLowerCase() && QUEUE_TIMES_PARK_MAP[`${PARK_TO_RESORT[m.parkId]}:${m.parkId}`] !== undefined);
  } },
  { label: "registry: umbrella 'Character Greetings' records and ordinary meets are not registered", ok: () =>
    !EVENT_EXCLUSIVE_MEETS.some((m) => /character greetings/i.test(m.providerName) || m.entityId === GREETINGS_ID || m.queueTimes?.rideId === 146) &&
    EVENT_EXCLUSIVE_MEETS.every((m) => /christmas party|jollywood nights/i.test(m.providerName)) },
  { label: "registry: verified candidates are exactly Santa Jack & Sally, Join Santa Claus (MK), Stitch (HS)", ok: () =>
    EVENT_EXCLUSIVE_MEETS.map((m) => `${m.parkId}:${m.entityId}`).sort().join() === [`mk:${JS_ID}`, `mk:${SANTA_ID}`, `hs:${STITCH_ID}`].sort().join() },
  // Confirmed party vs non-party dates; entire-day visibility
  { label: "party date, hours before party (8 AM): meets listed", ok: () => build(MVMCP_MORNING).entries.map((e) => e.entityId).sort().join() === [JS_ID, SANTA_ID].sort().join() },
  { label: "party date evening: still listed", ok: () => build(MVMCP_EVENING, tpOk(MK, mkEntries("OPERATING")), null).entries.length === 2 },
  { label: "last minute of the local party day listed; first minute of the next (non-party) day hidden", ok: () =>
    build(at("2026-11-14T04:59:00Z")).entries.length === 2 && build(at("2026-11-14T05:00:00Z")).entries.length === 0 && !build(at("2026-11-14T05:00:00Z")).partyDate },
  { label: "first minute of party day (midnight local) listed", ok: () => build(at("2026-11-12T05:00:00Z")).entries.length === 2 },
  { label: "non-party date inside the holiday season (Nov 10): hidden, nothing fetched needed", ok: () => { const r = build(NON_PARTY); return !r.partyDate && r.entries.length === 0 && eventMeetsSectionState(r) === "hidden" && buildParkEventMeets("mk", null, null, NON_PARTY).entries.length === 0; } },
  { label: "unannounced season (2027-11-12) is not a confirmed party date", ok: () => !buildParkEventMeets("mk", tpOk(MK, mkEntries()), null, at("2027-11-12T15:00:00Z")).partyDate },
  { label: "historical party night (2026-11-08) is never treated as confirmed today", ok: () => getConfirmedPartyMeets("mk", "2026-11-08", NON_PARTY).length === 0 },
  { label: "wrong event/park: HS Stitch only on Jollywood nights (Nov 14), not an MVMCP night; MK meets not on HS", ok: () =>
    build(JN_MORNING, tpOk(HS, [tpEntry(STITCH_ID, "Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights", HS, "CLOSED")]), null, "hs").entries.map((e) => e.entityId).join() === STITCH_ID &&
    build(MVMCP_MORNING, tpOk(HS, [tpEntry(STITCH_ID, "Stitch", HS, "CLOSED")]), null, "hs").entries.length === 0 &&
    build(JN_MORNING, tpOk(MK, mkEntries()), null, "mk").entries.length === 0 },
  { label: "no meets for parks with no registered party meets (epcot/ak/dca/disneyland)", ok: () =>
    (["epcot", "ak", "dca", "disneyland"] as ParkId[]).every((p) => !buildParkEventMeets(p, tpOk(MK, mkEntries()), null, MVMCP_MORNING).partyDate) },
  // CLOSED / OPERATING
  { label: "CLOSED before event start is normal: listed, status Closed, no requirement to be OPERATING", ok: () => { const e = build(MVMCP_MORNING).entries[0]; return describeEventMeet(e, MVMCP_MORNING).statusText === "Closed"; } },
  { label: "OPERATING: listed with live Queue-Times wait for the verified id", ok: () => {
    const r = build(MVMCP_EVENING, tpOk(MK, mkEntries("OPERATING")), { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 25 }, MVMCP_EVENING), ordinaryRow(MVMCP_EVENING)]) });
    const js = r.entries.find((e) => e.entityId === JS_ID)!;
    const v = describeEventMeet(js, MVMCP_EVENING);
    return js.wait.state === "live" && v.waitText === "Wait: 25 min" && v.statusText === "Operating";
  } },
  { label: "live 0-minute wait is a real wait (shown), not unavailable", ok: () => {
    const r = build(MVMCP_EVENING, undefined, { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 0 }, MVMCP_EVENING)]) });
    return describeEventMeet(r.entries.find((e) => e.entityId === JS_ID)!, MVMCP_EVENING).waitText === "Wait: 0 min";
  } },
  // Waits vs schedules
  { label: "Join Santa Claus / Stitch have no Queue-Times id: no wait ever shown, ordinary meet wait never substituted", ok: () => {
    const r = build(MVMCP_EVENING, undefined, { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 25 }, MVMCP_EVENING), ordinaryRow(MVMCP_EVENING)]) });
    const santa = r.entries.find((e) => e.entityId === SANTA_ID)!;
    const v = describeEventMeet(santa, MVMCP_EVENING);
    return santa.wait.state === "unavailable" && v.waitText === null && v.waitNote === null;
  } },
  { label: "schedule: verified performances/operating hours come from ThemeParks, separate from the wait", ok: () => {
    const r = build(MVMCP_MORNING, tpOk(MK, mkEntries("CLOSED", [{ type: "Operating", startTime: "2026-11-12T19:00:00-05:00", endTime: "2026-11-12T23:00:00-05:00" }])), null);
    const v = describeEventMeet(r.entries.find((e) => e.entityId === JS_ID)!, MVMCP_MORNING);
    return !!v.scheduleText && /Operating hours:/.test(v.scheduleText) && v.waitText === null;
  } },
  { label: "partial schedule (dropped showtime record alongside a valid performance) keeps the incomplete qualifier", ok: () => {
    const entries = mkEntries("CLOSED", [{ type: "Performance Time", startTime: "2026-11-12T19:00:00-05:00", endTime: null }]).map((e) => (e.entityId === JS_ID ? { ...e, droppedShowtimes: 1 } : e));
    const r = build(MVMCP_MORNING, tpOk(MK, entries), null);
    const v = describeEventMeet(r.entries.find((e) => e.entityId === JS_ID)!, MVMCP_MORNING);
    return !!v.scheduleText && v.scheduleText.includes("7:00 PM") && v.scheduleText.includes(PARTIAL_SHOWTIMES_NOTE);
  } },
  // Provider identity guard (name)
  { label: "identity: exact registered names verify", ok: () => EVENT_EXCLUSIVE_MEETS.every((m) => meetNameMatches(m.providerName, m.providerName)) },
  { label: "identity: harmless variations pass (curly/straight/missing apostrophes, case, whitespace, punctuation, '&'/'and')", ok: () =>
    meetNameMatches("Join Santa Claus at Mickey's Very Merry Christmas Party", "Join Santa Claus at Mickey’s Very Merry Christmas Party") &&
    meetNameMatches("Meet Santa Jack and Sally at Mickey’s Very Merry Christmas Party", "Meet Santa Jack and Sally at Mickey's Very Merry Christmas Party") &&
    meetNameMatches("Join Santa Claus at Mickey's Very Merry Christmas Party", "  JOIN  Santa Claus   at Mickeys Very Merry Christmas Party ") &&
    meetNameMatches("Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights", "Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights!") &&
    meetNameMatches("Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights", "Meet Stitch at Celebrity-Spotlight, at Disney Jollywood Nights") &&
    meetNameMatches("Rock & Roll", "Rock and Roll") && meetNameMatches("Café Meet", "Cafe Meet") },
  { label: "identity: meaningful changes are rejected (different character, event, venue, extra/missing words, substring, empty)", ok: () => {
    const exp = "Meet Santa Jack and Sally at Mickey’s Very Merry Christmas Party";
    return !meetNameMatches(exp, "Meet Santa Claus at Mickey’s Very Merry Christmas Party") &&
      !meetNameMatches(exp, "Meet Halloween Jack and Sally at Mickey’s Not-So-Scary Halloween Party") &&
      !meetNameMatches(exp, "Meet Santa Jack and Sally") &&
      !meetNameMatches(exp, `${exp} Encore`) &&
      !meetNameMatches(exp, "Character Greetings at Mickey's Very Merry Christmas Party") &&
      !meetNameMatches(exp, "Meet Mickey at Town Square Theater") &&
      !meetNameMatches(exp, "") && !meetNameMatches("", "") &&
      !meetNameMatches("Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights", "Meet Olaf at Celebrity Spotlight");
  } },
  { label: "identity: renamed provider record is omitted (UUID/park/party date alone are not enough)", ok: () => {
    const r = build(MVMCP_MORNING, tpOk(MK, mkEntries().map((e) => (e.entityId === JS_ID ? { ...e, name: "Meet Mickey at Town Square Theater" } : e))));
    return !r.entries.some((e) => e.entityId === JS_ID) && !r.entries.some((e) => /Town Square/.test(e.name));
  } },
  { label: "identity: mixed valid/invalid — only the mismatched meet is omitted, the valid one keeps wait/status", ok: () => {
    const r = build(MVMCP_EVENING, tpOk(MK, mkEntries("OPERATING").map((e) => (e.entityId === SANTA_ID ? { ...e, name: "Meet Goofy at Hall of Fame" } : e))),
      { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 20 }, MVMCP_EVENING)]) });
    const js = r.entries.find((e) => e.entityId === JS_ID);
    return r.entries.length === 1 && !!js && js.wait.state === "live" && r.partyDate && r.error === null;
  } },
  { label: "identity: harmless live-name variation still lists, showing the provider's current name", ok: () => {
    const r = build(MVMCP_MORNING, tpOk(MK, mkEntries().map((e) => (e.entityId === SANTA_ID ? { ...e, name: "Join Santa Claus at Mickeys Very Merry Christmas Party" } : e))));
    return r.entries.some((e) => e.entityId === SANTA_ID && e.name === "Join Santa Claus at Mickeys Very Merry Christmas Party");
  } },
  { label: "identity: all meets mismatched → hidden section (not 'unavailable'); non-party dates unaffected", ok: () => {
    const r = build(MVMCP_MORNING, tpOk(MK, mkEntries().map((e) => ({ ...e, name: "Something Else" }))));
    return r.entries.length === 0 && r.error === null && eventMeetsSectionState(r) === "hidden" && !build(NON_PARTY).partyDate;
  } },
  { label: "identity: Queue-Times name guard uses the same tolerance (apostrophe variant OK, other ride rejected)", ok: () => {
    const okRow = build(MVMCP_EVENING, undefined, { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 15, name: JS_NAME.replace("’", "'").toUpperCase() }, MVMCP_EVENING)]) }).entries.find((x) => x.entityId === JS_ID)!;
    const bad = build(MVMCP_EVENING, undefined, { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 15, name: "Meet Santa Jack and Sally" }, MVMCP_EVENING)]) }).entries.find((x) => x.entityId === JS_ID)!;
    return okRow.wait.state === "live" && bad.wait.state === "unavailable";
  } },
  // Provider failures / missing / stale
  { label: "ThemeParks failure on a party date: nothing listed, typed error → 'unavailable' (distinct from absence)", ok: () => {
    const r = buildParkEventMeets("mk", { ok: false, error: { kind: "timeout", message: "t" } }, null, MVMCP_MORNING);
    return r.partyDate && r.entries.length === 0 && r.error?.kind === "timeout" && eventMeetsSectionState(r) === "unavailable";
  } },
  { label: "confirmed absence (valid payload without the record): nothing fabricated, section hidden (not 'unavailable')", ok: () => {
    const r = build(MVMCP_MORNING, tpOk(MK, mkEntries().filter((e) => e.entityId !== JS_ID && e.entityId !== SANTA_ID)));
    return r.entries.length === 0 && r.error === null && eventMeetsSectionState(r) === "hidden";
  } },
  { label: "one record absent from payload: only the verified one is listed", ok: () => build(MVMCP_MORNING, tpOk(MK, mkEntries().filter((e) => e.entityId !== SANTA_ID))).entries.map((e) => e.entityId).join() === JS_ID },
  { label: "record parented to another park is not verified for this park (park matching)", ok: () => {
    const r = build(MVMCP_MORNING, tpOk(MK, mkEntries().map((e) => (e.entityId === JS_ID ? { ...e, parkId: HS } : e))));
    return !r.entries.some((e) => e.entityId === JS_ID);
  } },
  { label: "Queue-Times failure (fetch or malformed): meet still listed, wait 'unavailable' with note", ok: () =>
    [{ ok: false } as QueueTimesFetch, { ok: true, body: null } as QueueTimesFetch, { ok: true, body: "x" } as QueueTimesFetch, null].every((qt) => {
      const e = build(MVMCP_MORNING, undefined, qt).entries.find((x) => x.entityId === JS_ID)!;
      return e.wait.state === "unavailable" && describeEventMeet(e, MVMCP_MORNING).waitText === null;
    }) },
  { label: "Queue-Times stale row (>30 min) is not trusted as a wait", ok: () => {
    const stale = { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 30, last_updated: new Date(MVMCP_EVENING.getTime() - 3 * 3600_000).toISOString() }, MVMCP_EVENING)]) } as QueueTimesFetch;
    const e = build(MVMCP_EVENING, undefined, stale).entries.find((x) => x.entityId === JS_ID)!;
    return e.wait.state === "unavailable" && describeEventMeet(e, MVMCP_EVENING).waitText === null;
  } },
  { label: "Queue-Times id present but wrong name (id drift) → identity mismatch, no wait", ok: () => {
    const e = build(MVMCP_EVENING, undefined, { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 30, name: "Meet Mickey at Town Square Theater" }, MVMCP_EVENING)]) }).entries.find((x) => x.entityId === JS_ID)!;
    return e.wait.state === "unavailable" && e.wait.reason === "identity_mismatch";
  } },
  { label: "Queue-Times has no row for the verified id: no wait, ordinary rows ignored", ok: () => {
    const e = build(MVMCP_EVENING, undefined, { ok: true, body: qtBody([ordinaryRow(MVMCP_EVENING)]) }).entries.find((x) => x.entityId === JS_ID)!;
    return e.wait.state === "unavailable" && e.wait.reason === "no_queue_times_record";
  } },
  { label: "stale-if-error ThemeParks payload is flagged stale", ok: () => {
    const tp = tpOk(MK, mkEntries());
    if (!tp.ok) return false;
    const staleTp: ThemeParksResult<ThemeParksLive> = { ...tp, meta: { origin: "stale", fetchedAt: MVMCP_MORNING.getTime() - 60_000, etag: null, staleReason: { kind: "timeout", message: "t" } } };
    return build(MVMCP_MORNING, staleTp).stale === true;
  } },
  // Dedupe & identity
  { label: "duplicate provider records for one meet render one card; ids are park-qualified", ok: () => {
    const r = build(MVMCP_MORNING, tpOk(MK, [...mkEntries(), tpEntry(JS_ID, JS_NAME, MK, "CLOSED")]));
    return r.entries.filter((e) => e.entityId === JS_ID).length === 1 && r.entries.every((e) => e.id === `event-meet:mk:${e.entityId}`);
  } },
  { label: "umbrella Character Greetings and ordinary meets in the payload never appear", ok: () =>
    !build(MVMCP_MORNING).entries.some((e) => e.entityId === GREETINGS_ID || /Town Square/.test(e.name)) },
  { label: "case-insensitive UUIDs in the provider payload still verify", ok: () =>
    build(MVMCP_MORNING, tpOk(MK, mkEntries().map((e) => ({ ...e, entityId: e.entityId.toUpperCase() })))).entries.length === 2 },
  // Display clock / client degrade
  { label: "client display: previous-day or other-park data is never shown", ok: () => {
    const r = build(MVMCP_MORNING);
    return eventMeetsForDisplay(r, "mk", MVMCP_MORNING) === r && eventMeetsForDisplay(r, "mk", NON_PARTY) === null && eventMeetsForDisplay(r, "hs", MVMCP_MORNING) === null;
  } },
  { label: "client response: malformed/failed body degrades to hidden", ok: () =>
    resolveEventMeetsResponse("mk", null) === null && resolveEventMeetsResponse("mk", { parkId: "hs" }) === null && resolveEventMeetsResponse("mk", build(MVMCP_MORNING))?.entries.length === 2 },
  { label: "regular entertainment and 14.4B seasonal visibility untouched (meets are not curated entries)", ok: () => {
    const all = buildParkAllEntertainment("mk", tpOk(MK, mkEntries()), MVMCP_MORNING);
    return all.entries.filter((e) => e.id === `provider:${JS_ID}`).length === 1 && all.entries.some((e) => e.source === "curated");
  } },
];

export function runDevEventExclusiveMeetCases(): string[] {
  return DEV_EVENT_MEET_CASES.filter((c) => {
    try { return !c.ok(); } catch { return true; }
  }).map((c) => c.label);
}

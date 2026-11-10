/**
 * seasonalVisibility.ts — Phase 14.4A seasonal entertainment visibility.
 *
 * Determines whether a curated entertainment entry is confirmed out-of-season
 * for the current resort-local date. Used by:
 *   - Waits & Shows (/wait-times): hides confirmed out-of-season entries
 *   - All Entertainment (/entertainment/all): toggle includes hidden entries
 *
 * Hides ONLY when confirmed "off-season" per the Phase 14.2 seasonal rank:
 * unknown/neutral entries are never hidden, so incomplete date records and
 * un-associated shows (Frightfully Fun Parade, Frozen Holiday Surprise, etc.)
 * are always visible.
 *
 * Provider evidence override: if the showtimes API has performances today for a
 * show our registry marks off-season, the show remains visible — confirmed
 * current performances establish visibility (including Christmas parades on
 * non-party dates, and performances that have already passed today). This
 * needs the show to be explicitly mapped to its provider entity
 * (themeParksEntertainmentMapping.ts); an unmapped show can never be
 * evidenced. Registry-confirmed party dates are visible all day regardless of
 * provider data. Unknown data (no/unavailable showtimes) is never evidence
 * either way: it neither overrides the registry nor is treated as "zero
 * performances" in any message (see SHOWTIME_STATUS_MESSAGES).
 *
 * My Plans / Lightning Lane are unaffected: those pages never call this module
 * and seasonal items remain selectable year-round (dates optional).
 *
 * DEV checks: `runDevSeasonalVisibilityCases()` (run manually from Node).
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import {
  getEntertainmentForPark,
  type EntertainmentPlace,
} from "./entertainmentSuggestions";
import { SHOWTIME_STATUS_MESSAGES } from "./entertainmentShowtimes";
import { getSeasonalEntertainmentRank, getSeasonalProviderEntertainmentRank } from "./seasonalEntertainment";
import { PARK_TO_RESORT } from "./parkMetadata";
import { getResortLocalDate } from "./resortTime";
import { buildParkAllEntertainment, type AllEntertainmentEntry } from "./entertainmentAll";
import { normalizeParkEntertainmentShowtimes } from "./entertainmentShowtimes";
import { THEMEPARKS_PARKS } from "./themeParksProviders";
import type { ThemeParksLive, ThemeParksResult, ThemeParksShowtime } from "./themeParksApi";

// ============================================
// WAITS & SHOWS VISIBILITY
// ============================================

/**
 * Whether a curated entertainment entry is confirmed out-of-season for
 * `today` (resort-local calendar date "YYYY-MM-DD"). Returns true only when
 * `getSeasonalEntertainmentRank` returns "off-season" AND no provider
 * performance evidence overrides it.
 *
 * Always returns false (never hidden) for:
 *   - Shows with no association in SEASONAL_ENTERTAINMENT_EVENTS (neutral rank)
 *   - Shows whose seasonal dates are unconfirmed (unknown rank)
 *   - Shows with any confirmed in-season association (season/party-night rank)
 *   - Shows for which showtimeEntries reports at least one performance today
 *
 * @param showtimeEntries  Today's showtime entries from the provider, if available.
 * @param instant          Clock for `getSeasonalEntertainmentRank`; defaults to new Date().
 */
export function isEntertainmentConfirmedOutOfSeason(
  place: EntertainmentPlace,
  resort: ResortId,
  today: string,
  showtimeEntries?: { dwpName: string; performances: unknown[] }[],
  instant?: Date,
): boolean {
  const rank = getSeasonalEntertainmentRank(place.name, {
    resort,
    date: today,
    parkId: place.parkId,
    instant: instant ?? new Date(),
  });
  if (rank !== "off-season") return false;

  // Provider evidence: confirmed performances today override the registry
  if (showtimeEntries) {
    const entry = showtimeEntries.find((e) => e.dwpName === place.name);
    if (entry && entry.performances.length > 0) return false;
  }

  return true;
}

// ============================================
// ALL ENTERTAINMENT ENTRY VISIBILITY
// ============================================

/**
 * Whether a live All Entertainment entry is confirmed out-of-season for
 * the current resort-local date, applying the same provider-evidence override.
 *
 * Provider-only entries (Phase 14.4B) are hidden ONLY when they carry an
 * explicit park+UUID party association (`SEASONAL_PROVIDER_ONLY_EVENTS`) and
 * today is a confirmed non-party date; verified same-day performances OR
 * verified operating hours (the schedule of a meet) keep them visible. Every
 * unlisted provider-only record is unclassified and never hidden.
 *
 * Returns false for:
 *   - unclassified provider_only entries (no explicit event association)
 *   - entries with no matching catalog place (name not in DWP catalog)
 *   - entries for which the showtime has at least one performance today
 *   - entries whose seasonal rank is not "off-season" (neutral, unknown, in-season)
 */
export function isAllEntryConfirmedOutOfSeason(
  entry: AllEntertainmentEntry,
  parkId: ParkId,
  resort: ResortId,
  today: string,
  instant?: Date,
): boolean {
  if (entry.source === "provider_only") {
    const PREFIX = "provider:";
    if (!entry.id.startsWith(PREFIX)) return false;
    const rank = getSeasonalProviderEntertainmentRank(parkId, entry.id.slice(PREFIX.length), {
      resort, date: today, parkId, instant: instant ?? new Date(),
    });
    if (rank !== "off-season") return false;
    // Provider evidence: a verified performance, or verified operating hours, today.
    return entry.showtime.performances.length === 0 && (entry.operatingHours?.length ?? 0) === 0;
  }
  if (entry.source !== "curated") return false;
  const place = getEntertainmentForPark(parkId).find((p) => p.name === entry.name);
  if (!place) return false;
  return isEntertainmentConfirmedOutOfSeason(
    place,
    resort,
    today,
    [{ dwpName: entry.name, performances: entry.showtime.performances }],
    instant,
  );
}

/**
 * All Entertainment list after the seasonal rule: toggle OFF hides confirmed
 * out-of-season entries (curated and explicitly-classified provider-only),
 * toggle ON reveals them. Pure, so the page and DEV cases share one rule.
 */
export function applyAllEntertainmentSeasonalVisibility(
  entries: AllEntertainmentEntry[],
  parkId: ParkId,
  resort: ResortId,
  today: string,
  showOutOfSeason: boolean,
  instant?: Date,
): AllEntertainmentEntry[] {
  return showOutOfSeason
    ? entries
    : entries.filter((e) => !isAllEntryConfirmedOutOfSeason(e, parkId, resort, today, instant));
}

// ============================================
// ALL ENTERTAINMENT TOGGLE
// ============================================

/**
 * Curated out-of-season entries for the given park and today, in catalog order.
 * Used by the All Entertainment "Show out-of-season entertainment" toggle to
 * include confirmed off-season shows absent from the live provider inventory.
 *
 * @param existingIds  IDs already in the live inventory (to avoid duplicates).
 * @param instant      Clock for testing; defaults to new Date().
 */
export function getOffSeasonCuratedEntertainment(
  parkId: ParkId,
  today: string,
  existingIds: Set<string>,
  instant?: Date,
): EntertainmentPlace[] {
  const resort = PARK_TO_RESORT[parkId] as ResortId;
  return getEntertainmentForPark(parkId).filter((place) => {
    const id = `curated:${parkId}:${place.name}`;
    if (existingIds.has(id)) return false;
    return isEntertainmentConfirmedOutOfSeason(place, resort, today, undefined, instant);
  });
}

/**
 * Synthesize a minimal AllEntertainmentEntry for a curated show that is
 * confirmed out-of-season (no live provider data available). These entries
 * appear in All Entertainment when the out-of-season toggle is ON.
 */
export function makeOffSeasonEntry(
  place: EntertainmentPlace,
  parkId: ParkId,
): AllEntertainmentEntry {
  return {
    id: `curated:${parkId}:${place.name}`,
    source: "curated",
    name: place.name,
    land: place.land ?? null,
    venue: null,
    showtime: {
      dwpName: place.name,
      parkId,
      status: "unavailable",
      performances: [],
      message: SHOWTIME_STATUS_MESSAGES.unavailable,
      incomplete: true,
      unrecognizedTypes: [],
      provider: [],
    },
  };
}

// ============================================
// DEV CASES
// ============================================

export type DevSeasonalVisibilityCase = { label: string; ok: () => boolean };

// 2026-11-10 17:00 UTC → WDW: 12:00 PM EST, DLR: 9:00 AM PST
const NOW = new Date("2026-11-10T17:00:00Z");
const TODAY_WDW = getResortLocalDate("WDW", NOW); // "2026-11-10"
const TODAY_DLR = getResortLocalDate("DLR", NOW); // "2026-11-10"

function oos(name: string, resort: ResortId, today: string, parkId: ParkId, showtimes?: { dwpName: string; performances: unknown[] }[]): boolean {
  const place = getEntertainmentForPark(parkId).find((p) => p.name === name);
  if (!place) throw new Error(`no place: ${name}`);
  return isEntertainmentConfirmedOutOfSeason(place, resort, today, showtimes, NOW);
}

// Phase 14.4B helpers: synthetic provider payloads for MK (offline).
const MK_UUID = THEMEPARKS_PARKS.mk.entityId;
const XMAS_PARADE = "1a6e4b4a-fdf4-4379-83e4-741c9f5c343e";
const XMAS_PARADE_PARTY = "99baf196-9dfc-4b13-af77-025e87ac2a7d";
const MINNIE_FW = "bb28947d-a747-44f0-ac71-1fa8188f4cee";
const MERRIEST = "767b8357-ce52-4e09-810f-30ee81f8136c";
const perf = (startTime: string, type: string | null = "Performance Time", endTime: string | null = null): ThemeParksShowtime => ({ type, startTime, endTime });
const mkEntry = (entityId: string, name: string, showtimes: ThemeParksShowtime[], over: Partial<ThemeParksLive["entries"][number]> = {}): ThemeParksLive["entries"][number] => ({
  entityId, name, entityType: "SHOW", parkId: MK_UUID, externalId: null, status: "OPERATING", lastUpdated: null, showtimes, droppedShowtimes: 0, ...over,
});
const mkLive = (entries: ThemeParksLive["entries"], at: Date): ThemeParksResult<ThemeParksLive> => ({
  ok: true,
  data: { entityId: MK_UUID, name: "MK", timeZone: null, entries, droppedEntries: 0, droppedShowtimes: 0 },
  meta: { origin: "network", fetchedAt: at.getTime(), etag: null },
});
const mkShowtimes = (entries: ThemeParksLive["entries"], at: Date) => normalizeParkEntertainmentShowtimes("mk", mkLive(entries, at), at);
const mkAll = (entries: ThemeParksLive["entries"], at: Date) => buildParkAllEntertainment("mk", mkLive(entries, at), at);

const HS_UUID = THEMEPARKS_PARKS.hs.entityId;
const SANTA_JACK_SALLY = "6d3b1129-b34c-4b44-bba2-0e1790fef705";
const JOIN_SANTA = "418c2111-36d4-4f07-86b2-8058014a263c";
const MVMCP_GREETINGS = "8b8cb0ec-10a3-41d9-b5cb-81ea8db14370";
const JN_STITCH = "ae7db7da-a3d9-443b-b4a6-d3c4a2b66121";
const JN_PIXAR_DISCO = "71da34dd-a27e-4db5-aef3-f880ef939f98";
const DRUM_CORPS = "bc2c2ffe-3cf0-4e75-a408-bf5e86515c4c"; // ordinary HS provider-only (unclassified)
const hsAll = (entries: ThemeParksLive["entries"], at: Date) => buildParkAllEntertainment("hs", {
  ok: true,
  data: { entityId: HS_UUID, name: "HS", timeZone: null, entries, droppedEntries: 0, droppedShowtimes: 0 },
  meta: { origin: "network", fetchedAt: at.getTime(), etag: null },
}, at);
const hsEntry = (entityId: string, name: string, showtimes: ThemeParksShowtime[] = [], status = "CLOSED") => mkEntry(entityId, name, showtimes, { parkId: HS_UUID, status });
const byId = (all: { entries: AllEntertainmentEntry[] }, id: string) => all.entries.find((e) => e.id === `provider:${id}`)!;
const hiddenP = (all: { entries: AllEntertainmentEntry[] }, id: string, park: ParkId, date: string, at: Date) =>
  isAllEntryConfirmedOutOfSeason(byId(all, id), park, "WDW", date, at);

export const DEV_SEASONAL_VISIBILITY_CASES: DevSeasonalVisibilityCase[] = [
  // ── WDW: Halloween party shows ended Oct 31 ──────────────────────────────
  { label: "MNSSHP party shows hidden Nov 10 (season ended Oct 31)", ok: () =>
    oos("Hocus Pocus Villain Spelltacular", "WDW", TODAY_WDW, "mk") &&
    oos("Mickey's Boo-To-You Halloween Parade", "WDW", TODAY_WDW, "mk") &&
    oos("Disney's Not-So-Spooky Spectacular", "WDW", TODAY_WDW, "mk") },

  // ── WDW: MVMCP — started Nov 8; Nov 10 is not a party night ─────────────
  { label: "MVMCP party shows hidden Nov 10 (non-party night, window open)", ok: () =>
    oos("Mickey's Once Upon a Christmastime Parade", "WDW", TODAY_WDW, "mk") &&
    oos("Minnie's Wonderful Christmastime Fireworks", "WDW", TODAY_WDW, "mk") &&
    oos("Mickey's Most Merriest Celebration", "WDW", TODAY_WDW, "mk") },

  { label: "MVMCP party shows visible on confirmed party night Nov 8", ok: () => {
    const d = "2026-11-08";
    const now = new Date("2026-11-08T17:00:00Z");
    const place = getEntertainmentForPark("mk").find((p) => p.name === "Mickey's Once Upon a Christmastime Parade")!;
    return !isEntertainmentConfirmedOutOfSeason(place, "WDW", d, undefined, now);
  } },

  // ── WDW: Jollywood Nights (HS) — started Nov 7; Nov 10 not a party night ─
  { label: "Jollywood Nights shows hidden Nov 10 (non-party night)", ok: () =>
    oos("Disney Holidays in Hollywood", "WDW", TODAY_WDW, "hs") &&
    oos("What’s This? Tim Burton’s The Nightmare Before Christmas Sing-Along", "WDW", TODAY_WDW, "hs") &&
    oos("Glisten!", "WDW", TODAY_WDW, "hs") &&
    oos("Jingle Bell, Jingle BAM!", "WDW", TODAY_WDW, "hs") },

  { label: "Jollywood Nights show visible on confirmed party night Nov 7", ok: () => {
    const d = "2026-11-07";
    const now = new Date("2026-11-07T17:00:00Z");
    const place = getEntertainmentForPark("hs").find((p) => p.name === "Disney Holidays in Hollywood")!;
    return !isEntertainmentConfirmedOutOfSeason(place, "WDW", d, undefined, now);
  } },

  // ── WDW: EPCOT Festival of the Holidays (Nov 27–Dec 30) ──────────────────
  { label: "EPCOT holiday shows hidden Nov 10 (pre-season, festival starts Nov 27)", ok: () =>
    oos("Candlelight Processional", "WDW", TODAY_WDW, "epcot") &&
    oos("JOYFUL! A Celebration of the Season", "WDW", TODAY_WDW, "epcot") },

  { label: "EPCOT holiday shows visible Dec 1 (festival in progress)", ok: () => {
    const d = "2026-12-01";
    const now = new Date("2026-12-01T17:00:00Z");
    const place = getEntertainmentForPark("epcot").find((p) => p.name === "Candlelight Processional")!;
    return !isEntertainmentConfirmedOutOfSeason(place, "WDW", d, undefined, now);
  } },

  // ── DLR: Halloween shows ended Oct 31 ────────────────────────────────────
  { label: "DLR Halloween shows hidden Nov 10 (all ended Oct 31)", ok: () =>
    oos("Halloween Screams", "DLR", TODAY_DLR, "disneyland") &&
    oos("Mickey & Friends Halloween Cavalcade", "DLR", TODAY_DLR, "disneyland") &&
    oos("Madame Leota's Swinging Wake – A Haunted Mansion Street Party", "DLR", TODAY_DLR, "dca") },

  // ── DLR: Holidays (Nov 13–Jan 6) not yet started on Nov 10 ──────────────
  { label: "DLR holiday shows hidden Nov 10 (pre-season, starts Nov 13)", ok: () =>
    oos("Believe... in Holiday Magic", "DLR", TODAY_DLR, "disneyland") &&
    oos("A Christmas Fantasy Parade", "DLR", TODAY_DLR, "disneyland") &&
    oos("Mickey's Happy Holidays", "DLR", TODAY_DLR, "dca") &&
    oos("Disney ¡Viva Navidad! Street Party", "DLR", TODAY_DLR, "dca") },

  { label: "DLR holiday shows visible Nov 15 (season in progress)", ok: () => {
    const d = "2026-11-15";
    const now = new Date("2026-11-15T17:00:00Z");
    const place = getEntertainmentForPark("disneyland").find((p) => p.name === "Believe... in Holiday Magic")!;
    return !isEntertainmentConfirmedOutOfSeason(place, "DLR", d, undefined, now);
  } },

  // ── Cross-year: Jollywood Nights ends Jan 5, 2027 ────────────────────────
  { label: "Cross-year: Jollywood Jan 3 2027 (confirmed party night) is visible", ok: () => {
    const d = "2027-01-03";
    const now = new Date("2027-01-03T17:00:00Z");
    const place = getEntertainmentForPark("hs").find((p) => p.name === "Glisten!")!;
    return !isEntertainmentConfirmedOutOfSeason(place, "WDW", d, undefined, now);
  } },

  { label: "Cross-year: Jollywood Jan 6 2027 (prior season ended Jan 5, no 2027 record) is neutral/visible", ok: () => {
    // eventStateOnDate returns "past" for the 2026 record (ended Jan 5); there is no 2027 record.
    // getSeasonalEntertainmentRank only acts on "scheduled"/"not_scheduled" — "past" leaves
    // sawConfirmedOff=false → "neutral". An ended season cannot confirm off-season without
    // a same-year "not_scheduled" record for the query date's own year.
    const d = "2027-01-06";
    const now = new Date("2027-01-06T17:00:00Z");
    const place = getEntertainmentForPark("hs").find((p) => p.name === "Glisten!")!;
    return !isEntertainmentConfirmedOutOfSeason(place, "WDW", d, undefined, now);
  } },

  // ── Cross-year: DLR Holidays ends Jan 6, 2027 ────────────────────────────
  { label: "Cross-year: DLR Holidays Jan 5 2027 (in-season) is visible", ok: () => {
    const d = "2027-01-05";
    const now = new Date("2027-01-05T17:00:00Z");
    const place = getEntertainmentForPark("disneyland").find((p) => p.name === "Believe... in Holiday Magic")!;
    return !isEntertainmentConfirmedOutOfSeason(place, "DLR", d, undefined, now);
  } },

  // ── Unknown dates: unannounced future seasons stay visible ───────────────
  { label: "Unknown season dates: unannounced 2027 MNSSHP keeps shows visible", ok: () => {
    const d = "2027-10-31";
    const now = new Date("2027-10-31T17:00:00Z");
    const place = getEntertainmentForPark("mk").find((p) => p.name === "Hocus Pocus Villain Spelltacular")!;
    // No 2027 MNSSHP season record → "unknown" → not hidden
    return !isEntertainmentConfirmedOutOfSeason(place, "WDW", d, undefined, now);
  } },

  // ── Neutral: regular shows and unassociated seasonal never hidden ─────────
  { label: "Regular shows (Happily Ever After, Festival of Fantasy) never hidden", ok: () =>
    !oos("Happily Ever After", "WDW", TODAY_WDW, "mk") &&
    !oos("Festival of Fantasy Parade", "WDW", TODAY_WDW, "mk") &&
    !oos("Fantasmic!", "WDW", TODAY_WDW, "hs") &&
    !oos("Luminous The Symphony of Us", "WDW", TODAY_WDW, "epcot") },

  { label: "Unassociated seasonal: Frozen Holiday Surprise always visible", ok: () =>
    !oos("Frozen Holiday Surprise", "WDW", TODAY_WDW, "mk") },

  // ── Provider evidence override ────────────────────────────────────────────
  { label: "Provider performances today override off-season registry (DLR holidays pre-season)", ok: () => {
    const fakeShowtimes = [{ dwpName: "Believe... in Holiday Magic", performances: [{}] }];
    const place = getEntertainmentForPark("disneyland").find((p) => p.name === "Believe... in Holiday Magic")!;
    return !isEntertainmentConfirmedOutOfSeason(place, "DLR", TODAY_DLR, fakeShowtimes, NOW);
  } },

  { label: "Empty performances array does not override off-season registry", ok: () => {
    const fakeShowtimes = [{ dwpName: "Believe... in Holiday Magic", performances: [] }];
    const place = getEntertainmentForPark("disneyland").find((p) => p.name === "Believe... in Holiday Magic")!;
    return isEntertainmentConfirmedOutOfSeason(place, "DLR", TODAY_DLR, fakeShowtimes, NOW);
  } },

  { label: "Absent from showtimes entries does not override off-season registry", ok: () => {
    const fakeShowtimes = [{ dwpName: "Other Show", performances: [{}] }];
    const place = getEntertainmentForPark("disneyland").find((p) => p.name === "Believe... in Holiday Magic")!;
    return isEntertainmentConfirmedOutOfSeason(place, "DLR", TODAY_DLR, fakeShowtimes, NOW);
  } },

  // ── All Entertainment toggle: getOffSeasonCuratedEntertainment ───────────
  { label: "getOffSeasonCuratedEntertainment returns hidden MK shows on Nov 10", ok: () => {
    const names = getOffSeasonCuratedEntertainment("mk", TODAY_WDW, new Set(), NOW).map((p) => p.name);
    // MK shows only — "Disney Holidays in Hollywood" is a HS show and must not appear here.
    return names.includes("Hocus Pocus Villain Spelltacular") &&
      names.includes("Mickey's Once Upon a Christmastime Parade") &&
      !names.includes("Disney Holidays in Hollywood");
  } },

  { label: "getOffSeasonCuratedEntertainment excludes regular shows and unassociated seasonal", ok: () => {
    const names = getOffSeasonCuratedEntertainment("mk", TODAY_WDW, new Set(), NOW).map((p) => p.name);
    return !names.includes("Happily Ever After") &&
      !names.includes("Festival of Fantasy Parade") &&
      !names.includes("Frozen Holiday Surprise");
  } },

  { label: "getOffSeasonCuratedEntertainment excludes entries already in live inventory", ok: () => {
    const existing = new Set(["curated:mk:Hocus Pocus Villain Spelltacular"]);
    const names = getOffSeasonCuratedEntertainment("mk", TODAY_WDW, existing, NOW).map((p) => p.name);
    return !names.includes("Hocus Pocus Villain Spelltacular") &&
      names.includes("Mickey's Once Upon a Christmastime Parade");
  } },

  { label: "getOffSeasonCuratedEntertainment for HS returns Jollywood shows", ok: () => {
    const names = getOffSeasonCuratedEntertainment("hs", TODAY_WDW, new Set(), NOW).map((p) => p.name);
    return names.includes("Disney Holidays in Hollywood") && names.includes("Glisten!");
  } },

  { label: "getOffSeasonCuratedEntertainment for DCA returns hidden DLR holiday shows", ok: () => {
    const names = getOffSeasonCuratedEntertainment("dca", TODAY_DLR, new Set(), NOW).map((p) => p.name);
    return names.includes("Mickey's Happy Holidays") && names.includes("Disney ¡Viva Navidad! Street Party");
  } },

  // ── isAllEntryConfirmedOutOfSeason ────────────────────────────────────────
  { label: "isAllEntryConfirmedOutOfSeason: provider-present curated off-season entry is hidden (toggle OFF)", ok: () => {
    const entry: AllEntertainmentEntry = makeOffSeasonEntry(
      getEntertainmentForPark("mk").find((p) => p.name === "Hocus Pocus Villain Spelltacular")!,
      "mk",
    );
    // Override id/source as if it came from live inventory (source is already "curated")
    return isAllEntryConfirmedOutOfSeason(entry, "mk", "WDW", TODAY_WDW, NOW);
  } },

  { label: "isAllEntryConfirmedOutOfSeason: curated off-season entry with live performances is NOT hidden", ok: () => {
    // Simulate provider-present entry with an active performance
    const place = getEntertainmentForPark("disneyland").find((p) => p.name === "Believe... in Holiday Magic")!;
    const entry: AllEntertainmentEntry = {
      id: `curated:disneyland:${place.name}`,
      source: "curated",
      name: place.name,
      land: place.land ?? null,
      venue: null,
      showtime: {
        dwpName: place.name,
        parkId: "disneyland",
        status: "upcoming",
        performances: [{ startTime: "2026-11-10T22:00:00Z", endTime: null, localTime: "2:00 PM", type: null, passed: false }],
        message: null,
        incomplete: false,
        unrecognizedTypes: [],
        provider: [],
      },
    };
    return !isAllEntryConfirmedOutOfSeason(entry, "disneyland", "DLR", TODAY_DLR, NOW);
  } },

  { label: "isAllEntryConfirmedOutOfSeason: unclassified provider_only entry is never hidden", ok: () => {
    const entry: AllEntertainmentEntry = {
      id: "provider_only:mk:some-provider-show",
      source: "provider_only",
      name: "Some Provider-Only Show",
      land: null,
      venue: null,
      showtime: {
        dwpName: "Some Provider-Only Show",
        parkId: "mk",
        status: "unavailable",
        performances: [],
        message: null,
        incomplete: false,
        unrecognizedTypes: [],
        provider: [],
      },
    };
    return !isAllEntryConfirmedOutOfSeason(entry, "mk", "WDW", TODAY_WDW, NOW);
  } },

  { label: "isAllEntryConfirmedOutOfSeason: neutral/regular curated entry is never hidden", ok: () => {
    const place = getEntertainmentForPark("mk").find((p) => p.name === "Happily Ever After")!;
    const entry: AllEntertainmentEntry = {
      id: `curated:mk:${place.name}`,
      source: "curated",
      name: place.name,
      land: place.land ?? null,
      venue: null,
      showtime: {
        dwpName: place.name,
        parkId: "mk",
        status: "unavailable",
        performances: [],
        message: null,
        incomplete: false,
        unrecognizedTypes: [],
        provider: [],
      },
    };
    return !isAllEntryConfirmedOutOfSeason(entry, "mk", "WDW", TODAY_WDW, NOW);
  } },

  { label: "isAllEntryConfirmedOutOfSeason: curated entry with unknown dates is never hidden", ok: () => {
    // Frozen Holiday Surprise is in catalog but has no season association → "unknown" → never hidden
    const place = getEntertainmentForPark("mk").find((p) => p.name === "Frozen Holiday Surprise")!;
    if (!place) return true; // not in catalog → pass (not an error case for this function)
    const entry: AllEntertainmentEntry = {
      id: `curated:mk:${place.name}`,
      source: "curated",
      name: place.name,
      land: place.land ?? null,
      venue: null,
      showtime: {
        dwpName: place.name,
        parkId: "mk",
        status: "unavailable",
        performances: [],
        message: null,
        incomplete: false,
        unrecognizedTypes: [],
        provider: [],
      },
    };
    return !isAllEntryConfirmedOutOfSeason(entry, "mk", "WDW", TODAY_WDW, NOW);
  } },

  // ── makeOffSeasonEntry shape ──────────────────────────────────────────────
  { label: "makeOffSeasonEntry produces valid AllEntertainmentEntry shape", ok: () => {
    const place = getEntertainmentForPark("mk").find((p) => p.name === "Hocus Pocus Villain Spelltacular")!;
    const e = makeOffSeasonEntry(place, "mk");
    return e.id === "curated:mk:Hocus Pocus Villain Spelltacular" &&
      e.source === "curated" &&
      e.name === place.name &&
      e.land === place.land &&
      e.venue === null &&
      e.showtime.status === "unavailable" &&
      e.showtime.performances.length === 0 &&
      e.showtime.provider.length === 0 &&
      e.showtime.incomplete === true;
  } },
  // ── Phase 14.4B: verified-performance override + party-date visibility ────
  { label: "14.4B: MK Christmas parade performing today (non-party Nov 10) overrides hiding — Waits & Shows path", ok: () => {
    const entries = mkShowtimes([mkEntry(XMAS_PARADE, "Mickey's Once Upon a Christmastime Parade", [perf("2026-11-10T14:00:00-05:00")])], NOW).entries;
    return oos("Mickey's Once Upon a Christmastime Parade", "WDW", TODAY_WDW, "mk") === true &&
      oos("Mickey's Once Upon a Christmastime Parade", "WDW", TODAY_WDW, "mk", entries) === false;
  } },
  { label: "14.4B: same parade performing today overrides hiding — All Entertainment path", ok: () => {
    const all = mkAll([mkEntry(XMAS_PARADE, "Mickey's Once Upon a Christmastime Parade", [perf("2026-11-10T14:00:00-05:00")])], NOW);
    const e = all.entries.find((x) => x.name === "Mickey's Once Upon a Christmastime Parade")!;
    return e.showtime.performances.length === 1 && !isAllEntryConfirmedOutOfSeason(e, "mk", "WDW", TODAY_WDW, NOW);
  } },
  { label: "14.4B: override survives after the performance has passed (still performed today)", ok: () => {
    const late = new Date("2026-11-11T02:00:00Z"); // 9:00 PM EST Nov 10
    const entries = mkShowtimes([mkEntry(XMAS_PARADE, "Mickey's Once Upon a Christmastime Parade", [perf("2026-11-10T14:00:00-05:00")])], late).entries;
    return oos("Mickey's Once Upon a Christmastime Parade", "WDW", TODAY_WDW, "mk", entries) === false;
  } },
  { label: "14.4B: party-only Christmas shows present but with no performance on a non-party date stay hidden", ok: () => {
    const all = mkAll([
      mkEntry(XMAS_PARADE, "Mickey's Once Upon a Christmastime Parade", [], { status: "CLOSED" }),
      mkEntry(XMAS_PARADE_PARTY, "Mickey's Once Upon a Christmastime Parade at Mickey's Very Merry Christmas Party", [], { status: "CLOSED" }),
      mkEntry(MINNIE_FW, "Minnie's Wonderful Christmastime Fireworks at Mickey's Very Merry Christmas Party", [], { status: "CLOSED" }),
      mkEntry(MERRIEST, "Mickey's Most Merriest Celebration at Mickey's Very Merry Christmas Party", [], { status: "CLOSED" }),
    ], NOW);
    return ["Mickey's Once Upon a Christmastime Parade", "Minnie's Wonderful Christmastime Fireworks", "Mickey's Most Merriest Celebration"]
      .every((n) => { const e = all.entries.find((x) => x.name === n)!; return !!e && isAllEntryConfirmedOutOfSeason(e, "mk", "WDW", TODAY_WDW, NOW); });
  } },
  { label: "14.4B: confirmed party date (Nov 8) keeps party shows visible all day, even with no provider data at all", ok: () => {
    const now = new Date("2026-11-08T17:00:00Z");
    const names = ["Mickey's Once Upon a Christmastime Parade", "Minnie's Wonderful Christmastime Fireworks", "Mickey's Most Merriest Celebration"];
    const noData = mkAll([], now);
    const closed = mkAll([mkEntry(MERRIEST, "Mickey's Most Merriest Celebration at Mickey's Very Merry Christmas Party", [], { status: "CLOSED" })], now);
    return [noData, closed].every((all) => names.every((n) => { const e = all.entries.find((x) => x.name === n)!; return !!e && !isAllEntryConfirmedOutOfSeason(e, "mk", "WDW", "2026-11-08", now); }));
  } },
  { label: "14.4B: unknown data is not evidence — failed/unavailable showtimes neither override nor fabricate performances", ok: () => {
    const failed: ThemeParksResult<ThemeParksLive> = { ok: false, error: { kind: "timeout", message: "t" } };
    const entries = normalizeParkEntertainmentShowtimes("mk", failed, NOW).entries;
    const e = entries.find((x) => x.dwpName === "Mickey's Once Upon a Christmastime Parade")!;
    return e.performances.length === 0 && e.status === "unavailable" && e.message === "Showtimes unavailable" &&
      oos("Mickey's Once Upon a Christmastime Parade", "WDW", TODAY_WDW, "mk", entries) === true;
  } },
  { label: "14.4B: incomplete (one ref absent) but known performance still overrides", ok: () => {
    const entries = mkShowtimes([mkEntry(XMAS_PARADE_PARTY, "Mickey's Once Upon a Christmastime Parade at Mickey's Very Merry Christmas Party", [perf("2026-11-10T20:00:00-05:00", "Special Ticketed Event")])], NOW).entries;
    const e = entries.find((x) => x.dwpName === "Mickey's Once Upon a Christmastime Parade")!;
    return e.incomplete && e.performances.length === 1 && oos("Mickey's Once Upon a Christmastime Parade", "WDW", TODAY_WDW, "mk", entries) === false;
  } },
  { label: "14.4B: provider 'Operating' hours are not performances and never override hiding", ok: () => {
    const entries = mkShowtimes([mkEntry(XMAS_PARADE, "Mickey's Once Upon a Christmastime Parade", [perf("2026-11-10T09:00:00-05:00", "Operating", "2026-11-10T18:00:00-05:00")])], NOW).entries;
    return oos("Mickey's Once Upon a Christmastime Parade", "WDW", TODAY_WDW, "mk", entries) === true;
  } },
  { label: "14.4B: Mickey's Mix Magic (limited, DLR) and DCA Clubhouse are never hidden", ok: () =>
    !oos("Mickey's Mix Magic", "DLR", TODAY_DLR, "disneyland") && !oos("Disney Jr. Mickey Mouse Clubhouse Live!", "DLR", TODAY_DLR, "dca") },

  // ── Phase 14.4B: provider-only party entertainment ────────────────────────
  { label: "14.4B provider-only: MVMCP + Jollywood party records hidden on non-party Nov 10 (default OFF)", ok: () => {
    const mk = mkAll([mkEntry(SANTA_JACK_SALLY, "Meet Santa Jack and Sally at Mickey’s Very Merry Christmas Party", [], { status: "CLOSED" }), mkEntry(JOIN_SANTA, "Join Santa Claus at Mickey's Very Merry Christmas Party", [], { status: "CLOSED" }), mkEntry(MVMCP_GREETINGS, "Character Greetings at Mickey's Very Merry Christmas Party", [], { status: "CLOSED" })], NOW);
    const hs = hsAll([hsEntry(JN_STITCH, "Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights"), hsEntry(JN_PIXAR_DISCO, "Pixar Disco at Disney Jollywood Nights")], NOW);
    return [SANTA_JACK_SALLY, JOIN_SANTA, MVMCP_GREETINGS].every((id) => byId(mk, id).source === "provider_only" && hiddenP(mk, id, "mk", TODAY_WDW, NOW)) &&
      [JN_STITCH, JN_PIXAR_DISCO].every((id) => byId(hs, id).source === "provider_only" && hiddenP(hs, id, "hs", TODAY_WDW, NOW));
  } },
  { label: "14.4B provider-only: toggle ON reveals them; OFF hides only the classified ones (ordinary provider-only kept)", ok: () => {
    const hs = hsAll([hsEntry(JN_STITCH, "Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights"), hsEntry(JN_PIXAR_DISCO, "Pixar Disco at Disney Jollywood Nights"), hsEntry(DRUM_CORPS, "Green Army Drum Corps", [], "OPERATING")], NOW);
    const off = applyAllEntertainmentSeasonalVisibility(hs.entries, "hs", "WDW", TODAY_WDW, false, NOW);
    const on = applyAllEntertainmentSeasonalVisibility(hs.entries, "hs", "WDW", TODAY_WDW, true, NOW);
    const names = (l: AllEntertainmentEntry[]) => l.filter((e) => e.source === "provider_only").map((e) => e.id.slice(9)).sort().join();
    return names(off) === DRUM_CORPS && names(on) === [DRUM_CORPS, JN_PIXAR_DISCO, JN_STITCH].sort().join() && on.length === hs.entries.length;
  } },
  { label: "14.4B provider-only: confirmed party dates (Nov 8 MVMCP, Nov 7 Jollywood) visible all day with no provider data", ok: () => {
    const n8 = new Date("2026-11-08T17:00:00Z"); const n7 = new Date("2026-11-07T17:00:00Z");
    const mk = mkAll([mkEntry(SANTA_JACK_SALLY, "Meet Santa Jack and Sally", [], { status: "CLOSED" })], n8);
    const hs = hsAll([hsEntry(JN_PIXAR_DISCO, "Pixar Disco at Disney Jollywood Nights")], n7);
    return !hiddenP(mk, SANTA_JACK_SALLY, "mk", "2026-11-08", n8) && !hiddenP(hs, JN_PIXAR_DISCO, "hs", "2026-11-07", n7);
  } },
  { label: "14.4B provider-only: verified same-day performance overrides hiding on a non-party date", ok: () => {
    const hs = hsAll([hsEntry(JN_PIXAR_DISCO, "Pixar Disco at Disney Jollywood Nights", [perf("2026-11-10T21:00:00-05:00")], "OPERATING")], NOW);
    return byId(hs, JN_PIXAR_DISCO).showtime.performances.length === 1 && !hiddenP(hs, JN_PIXAR_DISCO, "hs", TODAY_WDW, NOW);
  } },
  { label: "14.4B provider-only: verified operating hours today (a meet's schedule) also keep it visible", ok: () => {
    const mk = mkAll([mkEntry(SANTA_JACK_SALLY, "Meet Santa Jack and Sally", [perf("2026-11-10T10:00:00-05:00", "Operating", "2026-11-10T17:00:00-05:00")], { status: "OPERATING" })], NOW);
    const e = byId(mk, SANTA_JACK_SALLY);
    return e.showtime.performances.length === 0 && (e.operatingHours?.length ?? 0) === 1 && !hiddenP(mk, SANTA_JACK_SALLY, "mk", TODAY_WDW, NOW);
  } },
  { label: "14.4B provider-only: unclassified records are never hidden — no name or character inference", ok: () => {
    const hs = hsAll([
      hsEntry(DRUM_CORPS, "Green Army Drum Corps"),
      hsEntry("11111111-1111-4111-8111-111111111111", "Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights"), // look-alike name, different uuid
      hsEntry("22222222-2222-4222-8222-222222222222", "Meet Santa Jack and Sally"),
    ], NOW);
    return hs.entries.filter((e) => e.source === "provider_only").length === 3 &&
      hs.entries.filter((e) => e.source === "provider_only").every((e) => !isAllEntryConfirmedOutOfSeason(e, "hs", "WDW", TODAY_WDW, NOW));
  } },
  { label: "14.4B provider-only: classification is park-qualified (MK uuid in an HS inventory is not hidden)", ok: () => {
    const hs = hsAll([hsEntry(SANTA_JACK_SALLY, "Meet Santa Jack and Sally")], NOW);
    return !isAllEntryConfirmedOutOfSeason(byId(hs, SANTA_JACK_SALLY), "hs", "WDW", TODAY_WDW, NOW);
  } },
  { label: "14.4B provider-only: unknown seasons stay visible (unannounced 2027 party season)", ok: () => {
    const n = new Date("2027-11-20T17:00:00Z");
    const mk = mkAll([mkEntry(SANTA_JACK_SALLY, "Meet Santa Jack and Sally", [], { status: "CLOSED" })], n);
    return !hiddenP(mk, SANTA_JACK_SALLY, "mk", "2027-11-20", n);
  } },
  // ── Phase 14.4B: Frightfully Fun Parade ───────────────────────────────────
  { label: "14.4B Frightfully Fun Parade: hidden by default throughout 2026 incl. OBB party date Oct 31", ok: () => {
    const place = getEntertainmentForPark("dca").find((p) => p.name === "Frightfully Fun Parade")!;
    const early = new Date("2026-10-29T17:00:00Z");
    return isEntertainmentConfirmedOutOfSeason(place, "DLR", "2026-10-31", undefined, early) &&
      oos("Frightfully Fun Parade", "DLR", TODAY_DLR, "dca") &&
      isEntertainmentConfirmedOutOfSeason(place, "DLR", "2026-12-15", undefined, NOW);
  } },
  { label: "14.4B Frightfully Fun Parade: existing toggle lists it (OFF hides, ON reveals) in 2026", ok: () => {
    const early = new Date("2026-10-29T17:00:00Z");
    return getOffSeasonCuratedEntertainment("dca", "2026-10-31", new Set(), early).some((p) => p.name === "Frightfully Fun Parade") &&
      getOffSeasonCuratedEntertainment("dca", TODAY_DLR, new Set(), NOW).some((p) => p.name === "Frightfully Fun Parade");
  } },
  { label: "14.4B Frightfully Fun Parade: future seasons are unknown, not cancelled (2027 visible)", ok: () => {
    const place = getEntertainmentForPark("dca").find((p) => p.name === "Frightfully Fun Parade")!;
    const n = new Date("2027-10-31T17:00:00Z");
    return !isEntertainmentConfirmedOutOfSeason(place, "DLR", "2027-10-31", undefined, n) && !isEntertainmentConfirmedOutOfSeason(place, "DLR", "2028-10-31", undefined, n);
  } },
  { label: "14.4B Frightfully Fun Parade: verified performances today still override (never fabricate absence)", ok: () =>
    !oos("Frightfully Fun Parade", "DLR", TODAY_DLR, "dca", [{ dwpName: "Frightfully Fun Parade", performances: [{}] }]) },
];

export function runDevSeasonalVisibilityCases(): string[] {
  return DEV_SEASONAL_VISIBILITY_CASES.filter((c) => {
    try { return !c.ok(); } catch { return true; }
  }).map((c) => c.label);
}

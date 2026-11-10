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
 * current performances establish visibility.
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
import { getSeasonalEntertainmentRank } from "./seasonalEntertainment";
import { PARK_TO_RESORT } from "./parkMetadata";
import { getResortLocalDate } from "./resortTime";
import type { AllEntertainmentEntry } from "./entertainmentAll";

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
 * Returns false for:
 *   - provider_only entries (never hidden — DWP catalog is not the source of truth)
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

  { label: "Unassociated seasonal: Frozen Holiday Surprise and Frightfully Fun Parade always visible", ok: () =>
    !oos("Frozen Holiday Surprise", "WDW", TODAY_WDW, "mk") &&
    !oos("Frightfully Fun Parade", "DLR", TODAY_DLR, "dca") },

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

  { label: "isAllEntryConfirmedOutOfSeason: provider_only entry is never hidden", ok: () => {
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
];

export function runDevSeasonalVisibilityCases(): string[] {
  return DEV_SEASONAL_VISIBILITY_CASES.filter((c) => {
    try { return !c.ok(); } catch { return true; }
  }).map((c) => c.label);
}

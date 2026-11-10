/**
 * seasonalEntertainment.ts — Phase 14.2 date-aware seasonal ordering of My
 * Plans entertainment suggestions.
 *
 * Pure ordering layer over the Phase 14.1 event registry (seasonalEvents.ts /
 * seasonalEventData.ts) and the active Entertainment catalog
 * (entertainmentSuggestions.ts). It never adds, removes, renames, or retypes a
 * suggestion — it only partitions the existing list into "boosted" (confirmed
 * relevant to the planning date), "neutral" (unchanged position) and
 * "demoted" (confirmed out of season). Nothing is hidden, so manual
 * search/add keeps working for every canonical entertainment name, and
 * nothing here touches saved plans or storage.
 *
 * Event ↔ entertainment associations are EXPLICIT (`SEASONAL_ENTERTAINMENT_
 * EVENTS`, keyed by canonical entertainment name). `availabilityTheme`
 * (halloween/christmas) is never used to infer a party association: a
 * Halloween-themed show may run all season, only on party nights, or both.
 *
 *   "party"  — exclusive to a select-night party; boosted only on a confirmed
 *              party night, demoted on other dates the registry can confirm.
 *   "season" — runs throughout a general seasonal event window (e.g. Halloween
 *              Time); boosted on dates inside the confirmed window.
 *
 * Date rules
 *   - Undated day (no valid date) → no reordering. Today's date is never
 *     substituted for a missing planner date.
 *   - Past dates (resort-local) are historical → no reordering.
 *   - Boost only on a CONFIRMED "scheduled" state; demote only on a CONFIRMED
 *     "not_scheduled" state. Unannounced seasons / null dates / missing
 *     records are "unknown" → neutral, never treated as confirmed.
 *   - A cross-year season (Nov 2026–Jan 2027) is found via the previous year's
 *     record, but only to confirm "scheduled"; "not scheduled" requires a
 *     season record for the date's own year.
 *
 * Park rules: an association applies only when the day's park (if resolved) is
 * one of the event's parks AND the show itself is presented in that park. With
 * no resolved park, the resort-level event match is used.
 *
 * DEV checks: `runDevSeasonalEntertainmentCases()` (run manually, see bottom).
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import {
  ENTERTAINMENT_PLACES,
  getEntertainmentSuggestions,
  resolveEntertainmentKey,
} from "./entertainmentSuggestions";
import { normalizeKey } from "./plansMatching";
import { resolveDwpEntertainmentFromThemeParksId } from "./themeParksEntertainmentMapping";
import { isValidIsoCalendarDate } from "./plannerWarnings";
import {
  getSeasonalEvent,
  getSeasonalEventDateState,
  getSeasonalEventSeason,
  type SeasonalEventDateState,
} from "./seasonalEvents";
import type { SeasonalEventDefinition } from "./seasonalEventData";

export type SeasonalEntertainmentAssociation = {
  /** `SEASONAL_EVENTS` id from seasonalEventData.ts. */
  eventId: string;
  kind: "party" | "season";
  /**
   * Phase 14.4B: event season years (the year the season BEGINS, as in
   * `SEASONAL_EVENT_SEASONS`) in which the show is CONFIRMED NOT presented at
   * this event, even on the event's own nights. Reads as confirmed off-season
   * for dates in those seasons only; every other season stays unknown (never
   * "permanently cancelled"). Past dates remain historical (no reordering).
   */
  absentSeasonYears?: number[];
  /** Maintainer note: what confirmed the absence (no URL is recorded unless one was verified). */
  absenceEvidence?: string;
  /**
   * Verified limitation worth keeping with the association (e.g. the show runs
   * only "on select days" of its parent event). Informational: the association
   * only ever decides hiding OUTSIDE the event's dates; inside them the entry
   * is simply not hidden and shows its provider status/times truthfully — it is
   * never assumed to perform every event day.
   */
  note?: string;
};

/**
 * Explicit canonical entertainment name → associated events. Names must match
 * ENTERTAINMENT_PLACES exactly (validated by the DEV cases). Seasonal catalog
 * entries not listed here (e.g. "Frightfully Fun Parade", whose 2026 Oogie
 * Boogie Bash status is not confirmed) keep their neutral position.
 */
export const SEASONAL_ENTERTAINMENT_EVENTS: Record<string, SeasonalEntertainmentAssociation[]> = {
  // Mickey's Not-So-Scary Halloween Party (WDW, Magic Kingdom) — party-only.
  "Hocus Pocus Villain Spelltacular": [{ eventId: "mnsshp", kind: "party" }],
  "Mickey's Boo-To-You Halloween Parade": [{ eventId: "mnsshp", kind: "party" }],
  "Disney's Not-So-Spooky Spectacular": [{ eventId: "mnsshp", kind: "party" }],
  // Mickey's Very Merry Christmas Party (WDW, Magic Kingdom) — party-only.
  "Mickey's Once Upon a Christmastime Parade": [{ eventId: "mvmcp", kind: "party" }],
  "Minnie's Wonderful Christmastime Fireworks": [{ eventId: "mvmcp", kind: "party" }],
  "Mickey's Most Merriest Celebration": [{ eventId: "mvmcp", kind: "party" }],
  // Oogie Boogie Bash (DLR, DCA) — party-only.
  "Madame Leota's Swinging Wake – A Haunted Mansion Street Party": [{ eventId: "oogie-boogie-bash", kind: "party" }],
  // Halloween Time at the Disneyland Resort — general park-admission season.
  "Halloween Screams": [{ eventId: "halloween-time-dlr", kind: "season" }],
  "Mickey & Friends Halloween Cavalcade": [{ eventId: "halloween-time-dlr", kind: "season" }],
  // Holidays at the Disneyland Resort — general park-admission season.
  "Believe... in Holiday Magic": [{ eventId: "holidays-dlr", kind: "season" }],
  "A Christmas Fantasy Parade": [{ eventId: "holidays-dlr", kind: "season" }],
  // Phase 14.4A — DLR Holidays DCA shows (park-admission season, confirmed).
  "Mickey's Happy Holidays": [{ eventId: "holidays-dlr", kind: "season" }],
  "Disney ¡Viva Navidad! Street Party": [{ eventId: "holidays-dlr", kind: "season" }],
  // Disney Jollywood Nights (WDW, Hollywood Studios) — party-only.
  // Show names confirmed from Disney Parks Blog / provider; the party suffix
  // ("at Disney Jollywood Nights") is a naming variant — same show.
  "Disney Holidays in Hollywood": [{ eventId: "jollywood-nights", kind: "party" }],
  "What’s This? Tim Burton’s The Nightmare Before Christmas Sing-Along": [{ eventId: "jollywood-nights", kind: "party" }],
  "Glisten!": [{ eventId: "jollywood-nights", kind: "party" }],
  "Jingle Bell, Jingle BAM!": [{ eventId: "jollywood-nights", kind: "party" }],
  // EPCOT International Festival of the Holidays (WDW, EPCOT) — park-admission season.
  "Candlelight Processional": [{ eventId: "epcot-festival-of-the-holidays", kind: "season" }],
  "JOYFUL! A Celebration of the Season": [{ eventId: "epcot-festival-of-the-holidays", kind: "season" }],
  // Frightfully Fun Parade (DLR, DCA): Oogie Boogie Bash entertainment. Official
  // 2026 evidence confirms it did NOT return for the 2026 season (replaced by
  // Madame Leota's Swinging Wake), so it reads as confirmed off-season for every
  // 2026 date incl. OBB nights. 2027+ has no absence record → unknown/neutral.
  "Frightfully Fun Parade": [{
    eventId: "oogie-boogie-bash", kind: "party", absentSeasonYears: [2026],
    absenceEvidence: "Official 2026 Oogie Boogie Bash entertainment confirms the parade did not return (replaced by Madame Leota's Swinging Wake); maintainer-confirmed 2026-11-10, no source URL recorded.",
  }],
  // Frozen Holiday Surprise (WDW, MK): Phase 14.4B — Disney Parks Blog presents it as a
  // regular Magic Kingdom holiday offering (not MVMCP-exclusive), so it belongs to the
  // park-admission Holidays at Walt Disney World season, not a party.
  // It also plays at Mickey's Very Merry Christmas Party (DPB lists it in the party lineup), so a party
  // night keeps it visible even before the park-admission season opens.
  "Frozen Holiday Surprise": [{ eventId: "holidays-wdw", kind: "season" }, { eventId: "mvmcp", kind: "party" }],
  // Phase 14.4B: Plaza de la Familia festival stage show (DCA, Aug 21–Nov 2 2026, park admission).
  "The Storytellers of Plaza de la Familia Celebrate The Musical World of Coco!": [{ eventId: "plaza-de-la-familia", kind: "season" }],
};

/** "party-night" / "season" boost; "off-season" demotes; "neutral" is unchanged. */
export type SeasonalEntertainmentRank = "party-night" | "season" | "neutral" | "off-season";

export type SeasonalSuggestionContext = {
  resort: ResortId;
  /** Planner day "YYYY-MM-DD"; null/undefined/invalid = undated → no reordering. */
  date: string | null | undefined;
  /** The day's effective park, when resolved. */
  parkId?: ParkId | null;
  /** Injectable clock for tests; defaults to now. */
  instant?: Date;
};

/**
 * Registry state for an event on a date, searching the date's own season year
 * and the previous year's (cross-year seasons). Only returns "not_scheduled"
 * when a record actually covers that part of the calendar.
 */
function eventStateOnDate(
  event: SeasonalEventDefinition,
  date: string,
  instant: Date,
): SeasonalEventDateState {
  const year = Number(date.slice(0, 4));
  const own = getSeasonalEventSeason(event.id, year);
  const prior = getSeasonalEventSeason(event.id, year - 1);
  const ownState = own ? getSeasonalEventDateState(event, own, date, instant) : null;
  const priorState = prior ? getSeasonalEventDateState(event, prior, date, instant) : null;

  for (const s of [ownState, priorState]) {
    if (s === "invalid" || s === "past" || s === "scheduled") return s;
  }
  // Only the date's own season-year record can confirm "not scheduled"; a
  // prior-year season can only confirm "scheduled" (cross-year carry-over).
  // Anything else is an unannounced season → unknown.
  if (ownState === "not_scheduled") return "not_scheduled";
  return "unknown";
}

/** Rank of one canonical entertainment name for the given date/park context. */
export function getSeasonalEntertainmentRank(
  name: string,
  ctx: SeasonalSuggestionContext,
): SeasonalEntertainmentRank {
  const { resort, date, parkId } = ctx;
  if (!date || !isValidIsoCalendarDate(date)) return "neutral";
  const instant = ctx.instant ?? new Date();

  const key = resolveEntertainmentKey(name, resort);
  if (!key) return "neutral";
  const place = ENTERTAINMENT_PLACES.find((p) => p.resort === resort && normalizeKey(p.name) === key);
  if (!place) return "neutral";
  const associations = SEASONAL_ENTERTAINMENT_EVENTS[place.name];
  if (!associations) return "neutral";
  // The show itself must be presented in the day's park.
  if (parkId && place.parkId !== parkId) return "neutral";
  return rankForAssociations(associations, resort, parkId, date, instant);
}

/** Season year (start year) of the event season that covers `date`: a still-running prior-year (cross-year) season, else the date's own year. */
function seasonYearOnDate(event: SeasonalEventDefinition, date: string, instant: Date): number {
  const year = Number(date.slice(0, 4));
  const prior = getSeasonalEventSeason(event.id, year - 1);
  if (prior && getSeasonalEventDateState(event, prior, date, instant) === "scheduled") return year - 1;
  return year;
}

function rankForAssociations(
  associations: SeasonalEntertainmentAssociation[],
  resort: ResortId,
  parkId: ParkId | null | undefined,
  date: string,
  instant: Date,
): SeasonalEntertainmentRank {
  let best: SeasonalEntertainmentRank = "neutral";
  let sawConfirmedOff = false;
  for (const a of associations) {
    const event = getSeasonalEvent(a.eventId);
    if (!event || event.resort !== resort) continue;
    if (parkId && !event.parkIds.includes(parkId)) continue;
    const state = eventStateOnDate(event, date, instant);
    if (a.absentSeasonYears?.includes(seasonYearOnDate(event, date, instant)) && state !== "past" && state !== "invalid") {
      sawConfirmedOff = true; // confirmed absent this season, even on event nights
    } else if (state === "scheduled") {
      const r: SeasonalEntertainmentRank = a.kind === "party" ? "party-night" : "season";
      if (best === "neutral" || r === "party-night") best = r;
    } else if (state === "not_scheduled") {
      sawConfirmedOff = true;
    }
  }
  if (best !== "neutral") return best;
  return sawConfirmedOff ? "off-season" : "neutral";
}

/**
 * Phase 14.4B: explicit, per-record event associations for PROVIDER-ONLY
 * seasonal entertainment (SHOW entities with no DWP catalog entry): ticketed
 * party records (kind "party"), and festival / park-admission holiday
 * records (kind "season"). Keyed by park + provider entity UUID (lowercase),
 * never by name or character identity.
 *
 * Each row was individually verified against ThemeParks.wiki park children
 * (2026-11-10) — the record is parented to that park and its own name or an
 * official Disney source ties it to the event (see `note`). Unlisted provider
 * records stay unclassified (never hidden). Event ids/dates come from the
 * maintained registry (seasonalEventData.ts) — no date table here. Provider
 * ids drift; `runDevSeasonalEntertainmentCases` checks structure, and an
 * entity that vanishes simply stops appearing.
 */
export type SeasonalProviderEntertainmentAssociation = {
  parkId: ParkId;
  entityId: string;
  /** Provider's display name when verified — informational only. */
  providerName: string;
  associations: SeasonalEntertainmentAssociation[];
};

const partyOnly = (parkId: ParkId, entityId: string, providerName: string, eventId: string): SeasonalProviderEntertainmentAssociation =>
  ({ parkId, entityId, providerName, associations: [{ eventId, kind: "party" }] });
const seasonOnly = (parkId: ParkId, entityId: string, providerName: string, eventId: string, note?: string): SeasonalProviderEntertainmentAssociation =>
  ({ parkId, entityId, providerName, associations: [{ eventId, kind: "season", ...(note ? { note } : {}) }] });

export const SEASONAL_PROVIDER_ONLY_EVENTS: SeasonalProviderEntertainmentAssociation[] = [
  // Mickey's Very Merry Christmas Party (WDW, Magic Kingdom)
  partyOnly("mk", "6d3b1129-b34c-4b44-bba2-0e1790fef705", "Meet Santa Jack and Sally at Mickey’s Very Merry Christmas Party", "mvmcp"),
  partyOnly("mk", "418c2111-36d4-4f07-86b2-8058014a263c", "Join Santa Claus at Mickey's Very Merry Christmas Party", "mvmcp"),
  partyOnly("mk", "8b8cb0ec-10a3-41d9-b5cb-81ea8db14370", "Character Greetings at Mickey's Very Merry Christmas Party", "mvmcp"),
  // Disney Jollywood Nights (WDW, Hollywood Studios)
  partyOnly("hs", "ae7db7da-a3d9-443b-b4a6-d3c4a2b66121", "Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights", "jollywood-nights"),
  partyOnly("hs", "dc332105-e524-4dca-9a47-df672f8472fd", "Character Greetings at Disney Jollywood Nights", "jollywood-nights"),
  partyOnly("hs", "74b46a33-ec93-4222-a3d5-d8372b1498e9", "Grand Avenue Dance Party at Disney Jollywood Nights", "jollywood-nights"),
  partyOnly("hs", "71da34dd-a27e-4db5-aef3-f880ef939f98", "Pixar Disco at Disney Jollywood Nights", "jollywood-nights"),
  // EPCOT festivals (park admission). Concert names carry the festival in the provider record.
  seasonOnly("epcot", "0e35a7a2-c2cd-451b-88e2-afc9d370e69e", "Garden Rocks Concert Series at EPCOT International Flower & Garden Festival", "epcot-flower-and-garden",
    "Parent-festival window only; day-level schedule not verified (sources disagree between nightly and weekends) — never assumed to perform every festival day."),
  seasonOnly("epcot", "d6bb186c-382f-4ae6-bc76-fde8f141ed69", "Eat to the Beat Concert Series Presented by Enterprise® at EPCOT International Food & Wine Festival", "epcot-eat-to-the-beat",
    "Concert series ends Nov 16, 2026 — five days before the festival (Nov 21): modelled as its own registry event, not the parent festival."),
  // DCA festivals / holidays (park admission).
  seasonOnly("dca", "4b7f57a0-c841-43d1-8abb-d13a3b7f2597", "Cookin' with the Jammin’ Chefs", "dca-food-and-wine",
    "Disneyland press release: daily festival entertainment (Mar 6–Apr 27, 2026)."),
  seasonOnly("dca", "2fdd02e8-3835-4ef8-bd07-4c3332fb84fa", "Confection Purrfection with the SuperKitties", "dca-food-and-wine",
    "Disneyland press release: runs only \"on select days\" of the festival — hidden outside the festival, never assumed to perform every festival day."),
  seasonOnly("dca", "e9c263c4-80dc-4431-bfc9-581a0ff1f578", "Holiday Toy Drummers", "holidays-dlr",
    "Official Disneyland listing: returns for Holidays at the Disneyland Resort (Nov 13, 2026; one official page says Nov 18, the registry season start is used)."),
];

const PROVIDER_EVENTS_BY_KEY: Map<string, SeasonalProviderEntertainmentAssociation> = new Map(
  SEASONAL_PROVIDER_ONLY_EVENTS.map((r) => [`${r.parkId}:${r.entityId}`, r]),
);

/**
 * Seasonal rank of one provider-only record (park-qualified, exact UUID, any
 * case). Unlisted records, undated/past dates and unknown seasons are
 * "neutral" — only a confirmed non-party date reads "off-season".
 */
export function getSeasonalProviderEntertainmentRank(
  parkId: ParkId,
  entityId: string,
  ctx: SeasonalSuggestionContext,
): SeasonalEntertainmentRank {
  const row = PROVIDER_EVENTS_BY_KEY.get(`${parkId}:${entityId.toLowerCase()}`);
  if (!row) return "neutral";
  const { resort, date } = ctx;
  if (!date || !isValidIsoCalendarDate(date)) return "neutral";
  if (ctx.parkId && ctx.parkId !== parkId) return "neutral";
  return rankForAssociations(row.associations, resort, parkId, date, ctx.instant ?? new Date());
}

/**
 * Partition the resort's entertainment suggestions by seasonal relevance.
 * `boosted` (party nights first, then general seasonal), `neutral`, and
 * `demoted` together are exactly `getEntertainmentSuggestions(resort)`, each
 * group in catalog order.
 */
export function partitionEntertainmentSuggestions(ctx: SeasonalSuggestionContext): {
  boosted: string[];
  neutral: string[];
  demoted: string[];
} {
  const party: string[] = [];
  const season: string[] = [];
  const neutral: string[] = [];
  const demoted: string[] = [];
  for (const name of getEntertainmentSuggestions(ctx.resort)) {
    switch (getSeasonalEntertainmentRank(name, ctx)) {
      case "party-night": party.push(name); break;
      case "season": season.push(name); break;
      case "off-season": demoted.push(name); break;
      default: neutral.push(name);
    }
  }
  return { boosted: [...party, ...season], neutral, demoted };
}

/**
 * DEV checks (not wired into CI; run manually from Node, e.g. via tsx):
 *   import { runDevSeasonalEntertainmentCases } from "./seasonalEntertainment";
 *   console.log(runDevSeasonalEntertainmentCases()); // [] when everything passes
 * Returns the labels of failing checks.
 */
export type DevSeasonalEntertainmentCase = { label: string; ok: () => boolean };

const NOW = new Date("2026-10-29T16:00:00Z"); // WDW/DLR local date 2026-10-29
const HOCUS = "Hocus Pocus Villain Spelltacular";
const MERRIEST = "Mickey's Most Merriest Celebration";
const LEOTA = "Madame Leota's Swinging Wake – A Haunted Mansion Street Party";
const SCREAMS = "Halloween Screams";
const BELIEVE = "Believe... in Holiday Magic";
const rank = (name: string, resort: ResortId, date: string | null | undefined, parkId?: ParkId | null) =>
  getSeasonalEntertainmentRank(name, { resort, date, parkId, instant: NOW });
const prank = (parkId: ParkId, entityId: string, resort: ResortId, date: string | null | undefined) =>
  getSeasonalProviderEntertainmentRank(parkId, entityId, { resort, date, parkId, instant: NOW });
const part = (resort: ResortId, date: string | null | undefined, parkId?: ParkId | null) =>
  partitionEntertainmentSuggestions({ resort, date, parkId, instant: NOW });
const sameAsCatalog = (resort: ResortId, date: string | null | undefined, parkId?: ParkId | null) => {
  const p = part(resort, date, parkId);
  return [...p.boosted, ...p.neutral, ...p.demoted].join("|") === [...p.neutral].join("|") &&
    p.neutral.join("|") === getEntertainmentSuggestions(resort).join("|");
};

export const DEV_SEASONAL_ENTERTAINMENT_CASES: DevSeasonalEntertainmentCase[] = [
  { label: "associations name active catalog entertainment in the event's resort/park", ok: () =>
    Object.entries(SEASONAL_ENTERTAINMENT_EVENTS).every(([name, assocs]) => {
      const place = ENTERTAINMENT_PLACES.find((p) => p.name === name);
      return !!place && assocs.every((a) => {
        const e = getSeasonalEvent(a.eventId);
        return !!e && e.resort === place.resort && !!place.parkId && e.parkIds.includes(place.parkId) &&
          (a.kind !== "party" || e.format === "select-night");
      });
    }) },
  // Party nights vs non-party nights
  { label: "MNSSHP night (Oct 31, MK): party show boosted as party-night", ok: () => rank(HOCUS, "WDW", "2026-10-31", "mk") === "party-night" },
  { label: "MNSSHP window but non-party night (Oct 30): party show demoted, not hidden", ok: () => rank(HOCUS, "WDW", "2026-10-30", "mk") === "off-season" && part("WDW", "2026-10-30", "mk").demoted.includes(HOCUS) },
  { label: "MVMCP night (Nov 8): Christmas party show boosted; Halloween party show demoted", ok: () => rank(MERRIEST, "WDW", "2026-11-08", "mk") === "party-night" && rank(HOCUS, "WDW", "2026-11-08", "mk") === "off-season" },
  { label: "MVMCP non-party night (Nov 10, in window): Christmas party show demoted", ok: () => rank(MERRIEST, "WDW", "2026-11-10", "mk") === "off-season" },
  { label: "a seasonal tag alone does not imply a party (every seasonal catalog entry needs an explicit association)", ok: () =>
    ENTERTAINMENT_PLACES.filter((p) => p.availabilityType === "seasonal").every((p) => !!SEASONAL_ENTERTAINMENT_EVENTS[p.name]) },
  { label: "party nights sort before general seasonal in boosted", ok: () => { const b = part("DLR", "2026-10-31", "dca").boosted; return b[0] === LEOTA; } },
  // Regular seasonal events (continuous windows)
  { label: "Halloween Time window (Oct 31, Disneyland): season boost", ok: () => rank(SCREAMS, "DLR", "2026-10-31", "disneyland") === "season" },
  { label: "after Halloween Time (Nov 20): Screams demoted, Believe boosted", ok: () => rank(SCREAMS, "DLR", "2026-11-20", "disneyland") === "off-season" && rank(BELIEVE, "DLR", "2026-11-20", "disneyland") === "season" },
  { label: "cross-year season: Holidays DLR boosts on 2027-01-04, unannounced-2027 date after it stays neutral", ok: () => rank(BELIEVE, "DLR", "2027-01-04", "disneyland") === "season" && rank(BELIEVE, "DLR", "2027-01-10", "disneyland") === "neutral" },
  { label: "regular/limited entertainment never reordered", ok: () => rank("Fantasmic!", "DLR", "2026-11-20", "disneyland") === "neutral" && rank("Happily Ever After", "WDW", "2026-11-08", "mk") === "neutral" },
  // Unknown / historical / undated
  { label: "unannounced future season (2027-11-20) stays neutral, not confirmed", ok: () => sameAsCatalog("WDW", "2027-11-20", "mk") && rank(MERRIEST, "WDW", "2027-11-20", "mk") === "neutral" },
  { label: "unannounced 2027 Halloween (2027-10-15, DLR) stays neutral", ok: () => sameAsCatalog("DLR", "2027-10-15", "disneyland") },
  { label: "historical date (Oct 27) is not boosted or demoted", ok: () => sameAsCatalog("WDW", "2026-10-27", "mk") },
  { label: "historical year (2025) is not boosted or demoted", ok: () => sameAsCatalog("DLR", "2025-10-31", "dca") },
  { label: "same-day (today) is not historical", ok: () => rank(HOCUS, "WDW", "2026-10-29", "mk") === "party-night" },
  { label: "undated (null/undefined/empty/invalid) keeps catalog order", ok: () => [null, undefined, "", "2026-02-30", "nope"].every((d) => sameAsCatalog("WDW", d, "mk") && sameAsCatalog("DLR", d, null)) },
  // Resort / park boundaries
  { label: "WDW date never boosts DLR shows (resort boundary)", ok: () => rank(LEOTA, "WDW", "2026-10-31", "mk") === "neutral" && !part("WDW", "2026-10-31", "mk").boosted.includes(LEOTA) },
  { label: "OBB night (Oct 31) boosts Leota at DCA; Disneyland park day does not (park boundary)", ok: () => rank(LEOTA, "DLR", "2026-10-31", "dca") === "party-night" && rank(LEOTA, "DLR", "2026-10-31", "disneyland") === "neutral" },
  { label: "MK party shows are neutral on an EPCOT/HS day", ok: () => rank(HOCUS, "WDW", "2026-10-31", "epcot") === "neutral" && rank(MERRIEST, "WDW", "2026-11-08", "hs") === "neutral" },
  { label: "Halloween Screams (Disneyland show) not boosted on a DCA day", ok: () => rank(SCREAMS, "DLR", "2026-10-31", "dca") === "neutral" },
  { label: "unresolved park falls back to resort-level event match", ok: () => rank(HOCUS, "WDW", "2026-10-31", null) === "party-night" && rank(HOCUS, "WDW", "2026-10-31", undefined) === "party-night" },
  // Nothing hidden; manual search intact
  { label: "partition is an exact permutation of the catalog suggestions (never hides)", ok: () => (["WDW", "DLR"] as ResortId[]).every((r) => ["2026-10-31", "2026-11-08", "2026-11-20", "2027-11-20", null].every((d) => { const p = part(r, d, null); return [...p.boosted, ...p.neutral, ...p.demoted].sort().join("|") === getEntertainmentSuggestions(r).slice().sort().join("|"); })) },
  { label: "every canonical entertainment name stays suggestible on a party night", ok: () => { const all = new Set(ENTERTAINMENT_PLACES.filter((p) => p.resort === "WDW").map((p) => p.name)); const p = part("WDW", "2026-11-08", "mk"); const got = new Set([...p.boosted, ...p.neutral, ...p.demoted]); return [...all].every((n) => got.has(n)); } },
  { label: "disambiguated names (Fantasmic! — location) still rank neutral without error", ok: () => rank("Fantasmic! — Hollywood Studios", "WDW", "2026-11-08", "hs") === "neutral" },
  // Phase 14.4A: new Jollywood Nights associations
  { label: "Phase 14.4A: Jollywood Nights party associations cover all four HS shows", ok: () =>
    ["Disney Holidays in Hollywood", "What’s This? Tim Burton’s The Nightmare Before Christmas Sing-Along", "Glisten!", "Jingle Bell, Jingle BAM!"]
      .every((n) => SEASONAL_ENTERTAINMENT_EVENTS[n]?.[0]?.eventId === "jollywood-nights" && SEASONAL_ENTERTAINMENT_EVENTS[n][0].kind === "party") },
  { label: "Phase 14.4A: Jollywood Nights show demoted on Nov 10 (non-party night, Nov 7 was last)", ok: () => rank("Glisten!", "WDW", "2026-11-10", "hs") === "off-season" },
  { label: "Phase 14.4A: Jollywood Nights show boosted on party night Nov 7", ok: () => rank("Disney Holidays in Hollywood", "WDW", "2026-11-07", "hs") === "party-night" },
  // Phase 14.4A: EPCOT festival of the holidays associations
  { label: "Phase 14.4A: EPCOT holiday shows are season associations", ok: () =>
    SEASONAL_ENTERTAINMENT_EVENTS["Candlelight Processional"]?.[0]?.kind === "season" &&
    SEASONAL_ENTERTAINMENT_EVENTS["Candlelight Processional"][0].eventId === "epcot-festival-of-the-holidays" &&
    SEASONAL_ENTERTAINMENT_EVENTS["JOYFUL! A Celebration of the Season"]?.[0]?.eventId === "epcot-festival-of-the-holidays" },
  { label: "Phase 14.4A: Candlelight Processional demoted Nov 10 (festival starts Nov 27), boosted Dec 1", ok: () =>
    rank("Candlelight Processional", "WDW", "2026-11-10", "epcot") === "off-season" &&
    rank("Candlelight Processional", "WDW", "2026-12-01", "epcot") === "season" },
  // Phase 14.4A: DLR holiday DCA shows
  { label: "Phase 14.4A: DLR holiday DCA shows are season associations (holidays-dlr)", ok: () =>
    SEASONAL_ENTERTAINMENT_EVENTS["Mickey's Happy Holidays"]?.[0]?.eventId === "holidays-dlr" &&
    SEASONAL_ENTERTAINMENT_EVENTS["Disney ¡Viva Navidad! Street Party"]?.[0]?.eventId === "holidays-dlr" },
  { label: "Phase 14.4A: DLR holiday DCA shows demoted Nov 10 (starts Nov 13), boosted Nov 20", ok: () =>
    rank("Mickey's Happy Holidays", "DLR", "2026-11-10", "dca") === "off-season" &&
    rank("Disney ¡Viva Navidad! Street Party", "DLR", "2026-11-20", "dca") === "season" },
  // Phase 14.4B: Frightfully Fun Parade — confirmed absent from the 2026 Oogie Boogie Bash season
  { label: "14.4B: Frightfully Fun Parade is confirmed off-season on an OBB night (Oct 31, DCA) — absent for 2026", ok: () => rank("Frightfully Fun Parade", "DLR", "2026-10-31", "dca") === "off-season" },
  { label: "14.4B: Frightfully Fun Parade off-season throughout 2026 (today, Nov, Dec) incl. unresolved park", ok: () =>
    ["2026-10-29", "2026-10-31", "2026-11-20", "2026-12-31"].every((d) => rank("Frightfully Fun Parade", "DLR", d, "dca") === "off-season") &&
    rank("Frightfully Fun Parade", "DLR", "2026-10-31", null) === "off-season" },
  { label: "14.4B: Frightfully Fun Parade absence is DCA-park-bound (Disneyland day neutral) and DLR-resort-bound (WDW neutral)", ok: () =>
    rank("Frightfully Fun Parade", "DLR", "2026-10-31", "disneyland") === "neutral" && rank("Frightfully Fun Parade", "WDW", "2026-10-31", "mk") === "neutral" },
  { label: "14.4B: Frightfully Fun Parade future seasons stay unknown/neutral — not permanently cancelled", ok: () =>
    ["2027-10-30", "2027-10-31", "2028-10-31"].every((d) => rank("Frightfully Fun Parade", "DLR", d, "dca") === "neutral") },
  { label: "14.4B: Frightfully Fun Parade past 2026 dates are historical (no reordering)", ok: () => rank("Frightfully Fun Parade", "DLR", "2026-10-20", "dca") === "neutral" },
  { label: "14.4B: Frightfully Fun Parade demoted, never removed — still suggestible/resolvable for old plans", ok: () => {
    const p = part("DLR", "2026-10-31", "dca");
    return p.demoted.includes("Frightfully Fun Parade") && !p.boosted.includes("Frightfully Fun Parade") &&
      getEntertainmentSuggestions("DLR").includes("Frightfully Fun Parade") && resolveEntertainmentKey("Frightfully Fun Parade", "DLR") !== null;
  } },
  { label: "14.4B: absence records are explicit, evidenced and attached to a registry event season that exists", ok: () =>
    Object.entries(SEASONAL_ENTERTAINMENT_EVENTS).every(([, assocs]) => assocs.every((a) =>
      !a.absentSeasonYears || (!!a.absenceEvidence && a.absentSeasonYears.every((y) => !!getSeasonalEventSeason(a.eventId, y))))) },
  // Phase 14.4B: provider-only party associations
  { label: "14.4B: provider-only table is structurally sound (canonical unique uuids, park ∈ event parks, party → select-night, not claimed by a curated mapping)", ok: () => {
    const ids = SEASONAL_PROVIDER_ONLY_EVENTS.map((r) => r.entityId);
    return new Set(ids).size === ids.length && SEASONAL_PROVIDER_ONLY_EVENTS.length > 0 &&
      SEASONAL_PROVIDER_ONLY_EVENTS.every((r) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.entityId) &&
        resolveDwpEntertainmentFromThemeParksId(r.entityId) === null &&
        r.associations.every((a) => { const e = getSeasonalEvent(a.eventId); return !!e && e.parkIds.includes(r.parkId) && (a.kind !== "party" || e.format === "select-night"); }));
  } },
  { label: "14.4B: provider-only MVMCP record: party-night Nov 8, off-season on non-party Nov 10", ok: () =>
    prank("mk", "6d3b1129-b34c-4b44-bba2-0e1790fef705", "WDW", "2026-11-08") === "party-night" &&
    prank("mk", "6d3b1129-b34c-4b44-bba2-0e1790fef705", "WDW", "2026-11-10") === "off-season" },
  { label: "14.4B: provider-only Jollywood record: party-night Nov 7 / Jan 3 2027, off-season Nov 10, neutral after season (Jan 6 2027)", ok: () => {
    const id = "71da34dd-a27e-4db5-aef3-f880ef939f98"; // Pixar Disco
    return prank("hs", id, "WDW", "2026-11-07") === "party-night" && prank("hs", id, "WDW", "2027-01-03") === "party-night" &&
      prank("hs", id, "WDW", "2026-11-10") === "off-season" && prank("hs", id, "WDW", "2027-01-06") === "neutral";
  } },
  { label: "14.4B: provider-only lookup is park-qualified, case-insensitive, exact-id (unlisted/other-park/undated → neutral)", ok: () =>
    prank("mk", "6D3B1129-B34C-4B44-BBA2-0E1790FEF705", "WDW", "2026-11-10") === "off-season" &&
    prank("hs", "6d3b1129-b34c-4b44-bba2-0e1790fef705", "WDW", "2026-11-10") === "neutral" &&
    prank("mk", "00000000-0000-4000-8000-000000000000", "WDW", "2026-11-10") === "neutral" &&
    prank("mk", "6d3b1129-b34c-4b44-bba2-0e1790fef705", "WDW", null) === "neutral" &&
    getSeasonalProviderEntertainmentRank("mk", "6d3b1129-b34c-4b44-bba2-0e1790fef705", { resort: "WDW", date: "2026-11-10", parkId: "hs", instant: NOW }) === "neutral" },
  // Phase 14.4B: seasonal coverage corrections
  { label: "14.4B: Frozen Holiday Surprise is a regular WDW holiday offering (season) AND plays MVMCP nights (party)", ok: () => {
    const a = SEASONAL_ENTERTAINMENT_EVENTS["Frozen Holiday Surprise"];
    return a?.some((x) => x.eventId === "holidays-wdw" && x.kind === "season") && a?.some((x) => x.eventId === "mvmcp" && x.kind === "party");
  } },
  { label: "14.4B: Frozen Holiday Surprise dates — off-season before Nov 13 (non-party), party-night on MVMCP nights, season Nov 21 / Jan 6 2027, unknown after / next year", ok: () =>
    rank("Frozen Holiday Surprise", "WDW", "2026-11-10", "mk") === "off-season" &&
    rank("Frozen Holiday Surprise", "WDW", "2026-11-08", "mk") === "party-night" &&
    rank("Frozen Holiday Surprise", "WDW", "2026-11-21", "mk") === "season" &&
    rank("Frozen Holiday Surprise", "WDW", "2027-01-06", "mk") === "season" &&
    rank("Frozen Holiday Surprise", "WDW", "2027-01-07", "mk") === "neutral" &&
    rank("Frozen Holiday Surprise", "WDW", "2027-11-20", "mk") === "neutral" &&
    rank("Frozen Holiday Surprise", "WDW", "2026-11-21", "epcot") === "neutral" },
  { label: "14.4B: Plaza de la Familia Storytellers — season through Nov 2 2026, off-season after, unknown 2027", ok: () => {
    const n = "The Storytellers of Plaza de la Familia Celebrate The Musical World of Coco!";
    return rank(n, "DLR", "2026-10-29", "dca") === "season" && rank(n, "DLR", "2026-11-03", "dca") === "off-season" &&
      rank(n, "DLR", "2026-11-03", "disneyland") === "neutral" && rank(n, "DLR", "2027-09-01", "dca") === "neutral";
  } },
  { label: "14.4B: provider-only festival rows are 'season' kind with a continuous park-admission event in the row's park", ok: () => {
    const seasonRows = SEASONAL_PROVIDER_ONLY_EVENTS.filter((r) => r.associations.every((a) => a.kind === "season"));
    return seasonRows.length >= 5 && seasonRows.every((r) => r.associations.every((a) => { const e = getSeasonalEvent(a.eventId)!; return e.format === "continuous" && e.parkIds.includes(r.parkId); }));
  } },
  { label: "14.4B: Garden Rocks follows the parent Flower & Garden window only (2027 in-window season, outside off-season, unannounced 2028 neutral)", ok: () => {
    const id = "0e35a7a2-c2cd-451b-88e2-afc9d370e69e";
    return prank("epcot", id, "WDW", "2026-11-10") === "off-season" && prank("epcot", id, "WDW", "2027-04-01") === "season" &&
      prank("epcot", id, "WDW", "2027-06-15") === "off-season" && prank("epcot", id, "WDW", "2028-04-01") === "neutral";
  } },
  { label: "14.4B: Eat to the Beat is season through Nov 16 but off-season Nov 17–21 even though the festival is still running (date-specific limit)", ok: () => {
    const id = "d6bb186c-382f-4ae6-bc76-fde8f141ed69";
    return prank("epcot", id, "WDW", "2026-11-12") === "season" && prank("epcot", id, "WDW", "2026-11-16") === "season" &&
      prank("epcot", id, "WDW", "2026-11-17") === "off-season" && prank("epcot", id, "WDW", "2026-11-21") === "off-season" && prank("epcot", id, "WDW", "2027-09-15") === "neutral";
  } },
  { label: "14.4B: DCA Food & Wine acts off-season in Nov 2026, unknown in 2027; Toy Drummers season Nov 13 – Jan 6, unknown after", ok: () => {
    const chefs = "4b7f57a0-c841-43d1-8abb-d13a3b7f2597", kitties = "2fdd02e8-3835-4ef8-bd07-4c3332fb84fa", drummers = "e9c263c4-80dc-4431-bfc9-581a0ff1f578";
    return prank("dca", chefs, "DLR", "2026-11-10") === "off-season" && prank("dca", kitties, "DLR", "2026-11-10") === "off-season" && prank("dca", chefs, "DLR", "2027-03-15") === "neutral" &&
      prank("dca", drummers, "DLR", "2026-11-12") === "off-season" && prank("dca", drummers, "DLR", "2026-11-13") === "season" && prank("dca", drummers, "DLR", "2027-01-06") === "season" && prank("dca", drummers, "DLR", "2027-01-07") === "neutral";
  } },
  { label: "14.4B: select-days limitation is recorded on the association (Confection Purrfection) — not modelled as every day", ok: () =>
    !!SEASONAL_PROVIDER_ONLY_EVENTS.find((r) => r.entityId === "2fdd02e8-3835-4ef8-bd07-4c3332fb84fa")?.associations[0].note?.includes("select days") },
  { label: "14.4B: registry events referenced by provider rows have a season record for the audited year (2026) or an announced one", ok: () =>
    SEASONAL_PROVIDER_ONLY_EVENTS.every((r) => r.associations.every((a) => !!getSeasonalEventSeason(a.eventId, 2026) || !!getSeasonalEventSeason(a.eventId, 2027))) },
];

export function runDevSeasonalEntertainmentCases(): string[] {
  return DEV_SEASONAL_ENTERTAINMENT_CASES.filter((c) => {
    try { return !c.ok(); } catch { return true; }
  }).map((c) => c.label);
}

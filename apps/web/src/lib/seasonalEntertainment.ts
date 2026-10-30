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

  let best: SeasonalEntertainmentRank = "neutral";
  let sawConfirmedOff = false;
  for (const a of associations) {
    const event = getSeasonalEvent(a.eventId);
    if (!event || event.resort !== resort) continue;
    if (parkId && !event.parkIds.includes(parkId)) continue;
    const state = eventStateOnDate(event, date, instant);
    if (state === "scheduled") {
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
  { label: "Halloween tag alone does not imply a party (unmapped seasonal stays neutral)", ok: () => rank("Frightfully Fun Parade", "DLR", "2026-10-31", "dca") === "neutral" },
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
];

export function runDevSeasonalEntertainmentCases(): string[] {
  return DEV_SEASONAL_ENTERTAINMENT_CASES.filter((c) => {
    try { return !c.ok(); } catch { return true; }
  }).map((c) => c.label);
}

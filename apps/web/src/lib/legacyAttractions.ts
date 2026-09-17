/**
 * legacyAttractions.ts — Attraction legacy/permanent identity.
 *
 * Attractions' ACTIVE/current catalog is `mockAttractionWaits` (packages/
 * shared/src/waitTimes/mock.ts) — the only catalog enumerated by Wait Times,
 * live wait lookups (liveWaitApi.ts), and My Plans attraction matching
 * (plansMatching.ts's lookupWait()/ALIASES_DLR/ALIASES_WDW, crossDayChecks.ts's
 * RIDE_TO_PARK_DLR/RIDE_TO_PARK_WDW). Mirrors DINING_PLACES/ENTERTAINMENT_PLACES
 * in diningSuggestions.ts/entertainmentSuggestions.ts.
 *
 * Permanently closed/replaced attractions that old saved/imported/
 * cloud-restored plans should keep recognizing live instead in
 * `LEGACY_ATTRACTIONS` below — deliberately NOT exported for enumeration and
 * NOT added to mockAttractionWaits, so this list structurally cannot reach
 * Wait Times, live wait lookups, or current attraction suggestions/
 * enumeration. Only `resolveAttractionIdentityKey`/`getAttractionContext`
 * consult it, as a fallback after the active catalog (mockAttractionWaits,
 * plus ALIASES_DLR/ALIASES_WDW) fails to match — mirrors
 * resolveDiningKey/resolveEntertainmentKey's active-then-legacy pattern
 * exactly (see those files' own doc comments for the full rationale).
 *
 * This does NOT touch plansMatching.ts's lookupWait()/liveWaitApi.ts's live
 * dedupe — both remain scoped to mockAttractionWaits only, exactly as
 * before, so a legacy identity never enters current wait-time resolution.
 * The only consumers of this module are the park/day-inference and
 * cross-day-duplicate-detection paths that already have this active-first/
 * legacy-fallback treatment for dining/entertainment (crossDayChecks.ts's
 * inferDayPark + computeCrossDayChecks's local tryResolve/
 * parkIdFromCanonicalKey, plansContextInference.ts's tryResolve) — a
 * legacy-only day (e.g. its only recognizable item is "Splash Mountain")
 * still recovers the correct historical park/resort instead of silently
 * losing all signal, the same gap dining/entertainment already closed.
 *
 * Add an entry here (never to mockAttractionWaits) when a current
 * attraction is confirmed permanently closed/replaced with no announced
 * return. Do not add refurbishment/seasonal/temporary closures here —
 * those remain plannedClosures.ts's concern (presentation + live-status
 * enforcement for a still-current attraction), not an identity change.
 */

import { mockAttractionWaits, type ParkId, type ResortId } from "@disney-wait-planner/shared";
import { normalizeKey, stripAnnotations, ALIASES_DLR, ALIASES_WDW } from "./plansMatching";

export type LegacyAttraction = {
  name: string;
  resort: ResortId;
  /** The park this attraction was in, when it had one. */
  parkId?: ParkId;
  /**
   * Historical themed land/area, preserved as it was known while the
   * attraction operated (may differ from a current active-catalog land
   * label if the area was later renamed — e.g. Disneyland's Critter
   * Country, since renamed Bayou Country).
   */
  land?: string;
};

const LEGACY_ATTRACTIONS: LegacyAttraction[] = [
  // Frontierland log flume, opened 1992; permanently closed Jan 23, 2023.
  // Replaced in the same location by Tiana's Bayou Adventure (active
  // catalog, parkId "mk", opened June 28, 2024). No announced return.
  { name: "Splash Mountain", resort: "WDW", parkId: "mk", land: "Frontierland" },
  // Critter Country log flume, opened 1989; permanently closed May 31,
  // 2023. Replaced in the same location — since renamed "Bayou Country" —
  // by Tiana's Bayou Adventure (active catalog, parkId "disneyland",
  // opened Nov 15, 2024). Land preserved as the historical "Critter
  // Country" name (distinct from the active catalog's current "Bayou
  // Country" label) so old saved/imported plans keep their original
  // historical context. No announced return.
  { name: "Splash Mountain", resort: "DLR", parkId: "disneyland", land: "Critter Country" },
  // Hollywood Boulevard dark ride/walking tour, opened 1989; permanently
  // closed Aug 13, 2017. Replaced in the same building by Mickey &
  // Minnie's Runaway Railway (active catalog, parkId "hs", opened Mar 4,
  // 2020). Never at DLR. No announced return.
  { name: "The Great Movie Ride", resort: "WDW", parkId: "hs", land: "Hollywood Boulevard" },
  // World Discovery (then Future World) pavilion attraction, open (under
  // varying names, incl. "Ellen's Energy Adventure") since 1982;
  // permanently closed Aug 13, 2017. Replaced in the same pavilion by
  // Guardians of the Galaxy: Cosmic Rewind (active catalog, parkId
  // "epcot", opened May 27, 2022). Never at DLR. No announced return.
  { name: "Universe of Energy", resort: "WDW", parkId: "epcot", land: "World Discovery" },
];

const ACTIVE_ATTRACTION_KEYS_BY_RESORT: Record<ResortId, Set<string>> = {
  DLR: new Set(mockAttractionWaits.filter((a) => a.resortId === "DLR").map((a) => normalizeKey(a.name))),
  WDW: new Set(mockAttractionWaits.filter((a) => a.resortId === "WDW").map((a) => normalizeKey(a.name))),
};

const LEGACY_ATTRACTION_KEYS_BY_RESORT: Record<ResortId, Set<string>> = {
  DLR: new Set(LEGACY_ATTRACTIONS.filter((a) => a.resort === "DLR").map((a) => normalizeKey(a.name))),
  WDW: new Set(LEGACY_ATTRACTIONS.filter((a) => a.resort === "WDW").map((a) => normalizeKey(a.name))),
};

/**
 * Aliases for legacy-only identities — same shape/rules as ALIASES_DLR/
 * ALIASES_WDW in plansMatching.ts, only ever consulted after the active
 * catalog and its own aliases fail to match (see resolveAttractionIdentityKey).
 * Kept separate from ALIASES_DLR/ALIASES_WDW — those maps' documented
 * contract is "value must match normalizeKey() output of a mock ride name"
 * (an active identity), so a legacy target never belongs there.
 */
const LEGACY_ATTRACTION_ALIASES: Record<string, string> = {
  "great movie ride": "the great movie ride",
  // Universe of Energy's own former name (1996–2017 overlay era) — see the
  // LEGACY_ATTRACTIONS entry's doc comment.
  "ellens energy adventure": "universe of energy",
};

/**
 * Resolve a (possibly aliased) name to its canonical attraction identity
 * key, active-first, legacy-fallback. Mirrors resolveDiningKey/
 * resolveEntertainmentKey's stage order exactly (see diningSuggestions.ts/
 * entertainmentSuggestions.ts):
 *   Stage 1: exact normalized match (active catalog).
 *   Stage 3: alias lookup (ALIASES_DLR/ALIASES_WDW), incl. "the "-prefix
 *            fallback, matching plansMatching.ts's lookupWait()/
 *            crossDayChecks.ts's resolveIdentityKey conventions.
 *   Legacy fallback: only reached when the active catalog found nothing —
 *            same exact + alias stages against LEGACY_ATTRACTIONS/
 *            LEGACY_ATTRACTION_ALIASES.
 *
 * Returns null when nothing resolves in either catalog. Does not perform
 * whole-word containment matching (unlike lookupWait()'s Stage 2 / the
 * duplicate-detection containment fallback in crossDayChecks.ts) — those
 * remain each caller's own concern; this function is deliberately the same
 * narrow exact+alias primitive resolveDiningKey/resolveEntertainmentKey are.
 */
export function resolveAttractionIdentityKey(name: string, resort: ResortId): string | null {
  const key = normalizeKey(stripAnnotations(name));
  const aliases = resort === "DLR" ? ALIASES_DLR : ALIASES_WDW;

  if (ACTIVE_ATTRACTION_KEYS_BY_RESORT[resort].has(key)) return key;
  const aliasTarget = aliases[key] ?? (key.startsWith("the ") ? aliases[key.slice(4)] : undefined);
  if (aliasTarget && ACTIVE_ATTRACTION_KEYS_BY_RESORT[resort].has(aliasTarget)) return aliasTarget;

  // Legacy fallback — only reached when the active catalog found nothing.
  if (LEGACY_ATTRACTION_KEYS_BY_RESORT[resort].has(key)) return key;
  const legacyAliasTarget = LEGACY_ATTRACTION_ALIASES[key];
  if (legacyAliasTarget && LEGACY_ATTRACTION_KEYS_BY_RESORT[resort].has(legacyAliasTarget)) {
    return legacyAliasTarget;
  }
  return null;
}

export type AttractionContext = { resortId: ResortId; parkId: ParkId | null };

/**
 * Resolve the resort + parkId context for an attraction plan item's current
 * name — active catalog first, legacy as fallback (see
 * resolveAttractionIdentityKey). Mirrors getDiningContext/
 * getEntertainmentParkId. Returns undefined only when the name itself
 * doesn't resolve to any known attraction identity (active or legacy).
 */
export function getAttractionContext(name: string, resort: ResortId): AttractionContext | undefined {
  const key = resolveAttractionIdentityKey(name, resort);
  if (!key) return undefined;
  const activeMatch = mockAttractionWaits.find(
    (a) => a.resortId === resort && normalizeKey(a.name) === key,
  );
  if (activeMatch) return { resortId: resort, parkId: activeMatch.parkId };
  const legacyMatch = LEGACY_ATTRACTIONS.find(
    (a) => a.resort === resort && normalizeKey(a.name) === key,
  );
  if (legacyMatch) return { resortId: resort, parkId: legacyMatch.parkId ?? null };
  return undefined;
}

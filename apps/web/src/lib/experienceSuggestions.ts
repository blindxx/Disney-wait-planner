/**
 * experienceSuggestions.ts — EXP.0 Experience foundation catalog.
 *
 * Authoritative source for the "experience" planner item type — a fourth
 * content type alongside attraction/dining/entertainment (see
 * PlannerItemType in plansTransfer.ts) for plan-worthy activities that are
 * neither a ride, a meal, nor scheduled entertainment (character boutiques,
 * workshops, and similar bookable/plannable experiences).
 *
 * EXP.0 scope is deliberately narrow: the active catalog contains ONLY
 * Bibbidi Bobbidi Boutique, at both Disneyland Resort and Walt Disney World.
 * "BBB" is common guest planning shorthand but is NOT catalogued as an alias
 * here — see the EXP.0 brief; adding it is out of scope for this foundation
 * slice.
 *
 * Mirrors the active+legacy/resolver/context pattern established by
 * diningSuggestions.ts/entertainmentSuggestions.ts exactly: `EXPERIENCE_PLACES`
 * is the ACTIVE/current catalog, `LEGACY_EXPERIENCE_PLACES` (currently empty —
 * no Experience identity has ever been retired) is the separate, non-exported
 * fallback catalog reserved for a future permanently-closed/replaced
 * Experience identity, and `resolveExperienceKey`/`getExperienceContext`
 * follow the same stage-1 (exact) + stage-3 (alias) + stage-2 (whole-word
 * containment) + legacy-fallback resolution used by resolveDiningKey.
 *
 * EXP.0 wired only plannerItemMetadata.ts's Experience dispatch (My Plans
 * metadata resolution). EXP.1 wires this module into the rest of normal
 * planner recognition: Smart Entry suggestions (getExperienceSuggestions,
 * added to plans/page.tsx's autocomplete list), type inference
 * (inferPlannerItemType in diningSuggestions.ts, via isExperienceName),
 * resort/park/day inference (plansContextInference.ts's inference map +
 * Stage 3d fallback, and crossDayChecks.ts's inferDayPark fallback), the
 * type-aware cross-day canonical identity/duplicate-resolution path
 * (crossDayChecks.ts's tryResolveByType/parkIdFromCanonicalKey), and the
 * manual custom-type selector (plans/page.tsx — Experience is both a
 * selectable option for unmatched entries and included in
 * isKnownPlannerName so a known maintained Experience name keeps using
 * automatic inference). Still deferred: Tom integration, the Wait Times
 * page, and the EXP.2 effective-type/reclassification override table — see
 * the EXP.1 brief's critical boundary.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import {
  normalizeKey,
  stripAnnotations,
  tokenize,
  containsWholeWordSequence,
} from "./plansMatching";

export type ExperiencePlace = {
  name: string;
  resort: ResortId;
  /** Park/area display label shown under the activity name. */
  location: string;
  /** The theme park this experience is presented in, when it has one. */
  parkId?: ParkId;
  /**
   * Themed land/area within the park, using the same land vocabulary as
   * attraction/dining/entertainment data (packages/shared/src/waitTimes/
   * mock.ts) so a future combined land filter/display doesn't need a second
   * taxonomy.
   */
  land?: string;
};

export const EXPERIENCE_PLACES: ExperiencePlace[] = [
  { name: "Bibbidi Bobbidi Boutique", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Fantasyland" },
  { name: "Bibbidi Bobbidi Boutique", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Fantasyland" },
];

const EXPERIENCE_KEYS: Set<string> = new Set(
  EXPERIENCE_PLACES.map((p) => normalizeKey(p.name)),
);

// Per-resort canonical key sets, used to validate that a resolved key
// actually has an offering at the requested resort before returning it —
// mirrors DINING_KEYS_BY_RESORT/ENTERTAINMENT_KEYS_BY_RESORT.
const EXPERIENCE_KEYS_BY_RESORT: Record<ResortId, Set<string>> = {
  DLR: new Set(EXPERIENCE_PLACES.filter((p) => p.resort === "DLR").map((p) => normalizeKey(p.name))),
  WDW: new Set(EXPERIENCE_PLACES.filter((p) => p.resort === "WDW").map((p) => normalizeKey(p.name))),
};

/**
 * Permanently closed/replaced Experience identities kept ONLY so that
 * saved, imported, or cloud-restored plan items naming them still resolve
 * to the correct type/canonical name/location — never for current planning.
 * Mirrors LEGACY_DINING_PLACES/LEGACY_ENTERTAINMENT_PLACES exactly.
 *
 * Empty for EXP.0 — no Experience identity has ever been retired, since
 * this is the type's first catalog entry. Add an entry here (never re-add
 * it to EXPERIENCE_PLACES) when a current Experience is confirmed
 * permanently closed/replaced.
 */
const LEGACY_EXPERIENCE_PLACES: ExperiencePlace[] = [];

const LEGACY_EXPERIENCE_KEYS: Set<string> = new Set(
  LEGACY_EXPERIENCE_PLACES.map((p) => normalizeKey(p.name)),
);

const LEGACY_EXPERIENCE_KEYS_BY_RESORT: Record<ResortId, Set<string>> = {
  DLR: new Set(LEGACY_EXPERIENCE_PLACES.filter((p) => p.resort === "DLR").map((p) => normalizeKey(p.name))),
  WDW: new Set(LEGACY_EXPERIENCE_PLACES.filter((p) => p.resort === "WDW").map((p) => normalizeKey(p.name))),
};

/**
 * Manual alias map for legitimate Experience name variants only — mirrors
 * DINING_ALIASES/ENTERTAINMENT_ALIASES (no fuzzy matching, just an explicit
 * lookup table). Empty for EXP.0: Bibbidi Bobbidi Boutique's official name
 * needs no alias, and "BBB" is deliberately excluded — it is planning
 * shorthand, not a catalog alias (see this file's module doc comment).
 */
const EXPERIENCE_ALIASES: Record<string, string> = {};

/**
 * Strip a disambiguation suffix appended by getExperienceSuggestions(), e.g.
 * "Bibbidi Bobbidi Boutique — Magic Kingdom" → "Bibbidi Bobbidi Boutique".
 * No-op when absent. Mirrors stripDiningSuffix/stripEntertainmentSuffix.
 */
function stripExperienceSuffix(str: string): string {
  const idx = str.indexOf(" — ");
  return idx === -1 ? str : str.slice(0, idx);
}

/**
 * Resolve a (possibly aliased or partially-typed) name to its canonical
 * EXPERIENCE_KEYS entry. Single source of truth for Experience recognition,
 * mirroring resolveDiningKey exactly:
 *
 * Stage 1: exact normalized match.
 * Stage 3: alias lookup (EXPERIENCE_ALIASES).
 * Stage 2: whole-word containment (≥2 meaningful tokens, unambiguous) — lets
 * "The Bibbidi Bobbidi Boutique" and similar wording variants still resolve
 * without needing an explicit alias entry.
 *
 * When resort is supplied, the resolved key is validated against
 * EXPERIENCE_KEYS_BY_RESORT before being returned. Without a resort,
 * validation is skipped, preserving existing unscoped/ambiguous lookup
 * behavior.
 *
 * Legacy fallback: when nothing in the active catalog matches, the same
 * stage-1 (exact) lookup runs against LEGACY_EXPERIENCE_PLACES (currently
 * empty, so this fallback is a structural no-op until a future slice adds a
 * retired Experience identity).
 *
 * Returns null when nothing resolves in either catalog.
 */
export function resolveExperienceKey(name: string, resort?: ResortId): string | null {
  const key = normalizeKey(stripAnnotations(stripExperienceSuffix(name)));

  let candidate: string | null = null;
  if (EXPERIENCE_KEYS.has(key)) {
    candidate = key;
  } else {
    const aliasTarget = EXPERIENCE_ALIASES[key];
    if (aliasTarget && EXPERIENCE_KEYS.has(aliasTarget)) {
      candidate = aliasTarget;
    } else {
      const tokens = tokenize(key);
      if (tokens.length >= 2) {
        let hit: string | null = null;
        let matchCount = 0;
        for (const experienceKey of EXPERIENCE_KEYS) {
          if (containsWholeWordSequence(experienceKey, tokens)) {
            matchCount++;
            if (matchCount > 1) {
              hit = null;
              break;
            }
            hit = experienceKey;
          }
        }
        if (matchCount === 1) candidate = hit;
      }
    }
  }

  if (candidate) {
    if (resort && !EXPERIENCE_KEYS_BY_RESORT[resort].has(candidate)) return null;
    return candidate;
  }

  // Legacy fallback — only reached when the active catalog found nothing.
  if (!LEGACY_EXPERIENCE_KEYS.has(key)) return null;
  if (resort && !LEGACY_EXPERIENCE_KEYS_BY_RESORT[resort].has(key)) return null;
  return key;
}

/**
 * Find catalog entries by a key already resolved via resolveExperienceKey —
 * active catalog first, legacy as fallback (a key can only ever exist in one
 * or the other, never both). Mirrors findDiningPlacesByKey/
 * findEntertainmentPlacesByKey.
 */
function findExperiencePlacesByKey(key: string): ExperiencePlace[] {
  const active = EXPERIENCE_PLACES.filter((p) => normalizeKey(p.name) === key);
  if (active.length > 0) return active;
  return LEGACY_EXPERIENCE_PLACES.filter((p) => normalizeKey(p.name) === key);
}

/**
 * True when the given activity name matches a known Experience (exact,
 * alias, or containment — see resolveExperienceKey). EXP.1 — consulted by
 * inferPlannerItemType (diningSuggestions.ts) and isKnownPlannerName
 * (plans/page.tsx) — see module doc comment.
 */
export function isExperienceName(name: string, resort?: ResortId): boolean {
  return resolveExperienceKey(name, resort) !== null;
}

/**
 * Autocomplete suggestion list, scoped to the active resort — mirrors
 * getDiningSuggestions/getEntertainmentSuggestions. EXP.1 — wired into
 * plans/page.tsx's Smart Entry suggestions aggregation — see module doc
 * comment.
 */
export function getExperienceSuggestions(resort: ResortId): string[] {
  const scoped = EXPERIENCE_PLACES.filter((p) => p.resort === resort);
  const byKey = new Map<string, ExperiencePlace[]>();
  for (const place of scoped) {
    const key = normalizeKey(place.name);
    const list = byKey.get(key) ?? [];
    list.push(place);
    byKey.set(key, list);
  }
  const result: string[] = [];
  for (const places of byKey.values()) {
    const distinctLocations = new Set(places.map((p) => p.location));
    if (distinctLocations.size <= 1) {
      result.push(places[0].name);
    } else {
      for (const p of places) {
        result.push(`${p.name} — ${p.location}`);
      }
    }
  }
  return result;
}

/** Resort + optional park context for a recognized Experience identity. */
export type ExperienceContext = {
  resortId: ResortId;
  parkId: ParkId | null;
  /** Canonical display name for this identity (active or legacy). */
  name: string;
  /** Themed land/area within the park, when maintained. */
  land?: string;
  /** Maintained display area — see ExperiencePlace's own `location`. */
  location: string;
  /** Whether this identity resolved via the active catalog or the legacy fallback. */
  lifecycle: "active" | "legacy";
};

/**
 * Resolve the resort + parkId + canonical name/land/lifecycle context for an
 * Experience item's current name, preferring a match within the active
 * resort, falling back to any resort — active catalog first, legacy as
 * fallback. Mirrors getDiningContext/getEntertainmentContext exactly, giving
 * plannerItemMetadata.ts's Experience dispatch the same single context
 * lookup the other three types already have.
 *
 * Returns undefined only when the name itself doesn't resolve to any known
 * Experience identity (active or legacy).
 */
export function getExperienceContext(name: string, resort: ResortId): ExperienceContext | undefined {
  const key = resolveExperienceKey(name, resort);
  if (!key) return undefined;
  const matches = findExperiencePlacesByKey(key);
  if (matches.length === 0) return undefined;
  const match = matches.find((p) => p.resort === resort) ?? matches[0];
  return {
    resortId: match.resort,
    parkId: match.parkId ?? null,
    name: match.name,
    land: match.land,
    location: match.location,
    lifecycle: EXPERIENCE_KEYS.has(key) ? "active" : "legacy",
  };
}

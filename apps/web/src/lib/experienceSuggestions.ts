/**
 * experienceSuggestions.ts — EXP.0 Experience foundation catalog.
 *
 * Authoritative source for the "experience" planner item type — a fourth
 * content type alongside attraction/dining/entertainment (see
 * PlannerItemType in plansTransfer.ts) for plan-worthy activities that are
 * neither a ride, a meal, nor scheduled entertainment (character boutiques,
 * workshops, and similar bookable/plannable experiences).
 *
 * EXP.0 scope was deliberately narrow: the active catalog contained ONLY
 * Bibbidi Bobbidi Boutique, at both Disneyland Resort and Walt Disney World.
 * "BBB" is common guest planning shorthand but is NOT catalogued as an alias
 * here — see the EXP.0 brief; adding it was out of scope for that foundation
 * slice and remains out of scope for EXP.2.
 *
 * EXP.2 catalog cutover: Savi's Workshop – Handbuilt Lightsabers, Droid
 * Depot, and Olaf Draws! moved into this active catalog from the
 * Entertainment catalog (entertainmentSuggestions.ts's ENTERTAINMENT_PLACES)
 * — a category migration, not a new addition or a lifecycle retirement.
 * Their resort/park/land metadata and legitimate aliases (see
 * EXPERIENCE_ALIASES below) are carried over unchanged from that catalog.
 * A historical/imported plan item naming one of these three identities with
 * an explicit `type: "entertainment"` must still resolve as Experience —
 * see resolvePlannerItemEffectiveType() in plannerItemMetadata.ts, the
 * single shared resolver responsible for that narrow, explicit historical-
 * compatibility override (never broad string matching).
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
 * metadata resolution). EXP.1 wired this module into the rest of normal
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
 * automatic inference). EXP.2 added the effective-type/reclassification
 * override (resolvePlannerItemEffectiveType in plannerItemMetadata.ts) and
 * wired it into My Plans hydration/import/restore and Tom's read-only
 * planner-context resolution (plannerContextSnapshot.ts) — see that
 * function's own doc comment for the full precedence. Tom integration
 * itself remains read-only, per AGENTS.md; no planner-context Wait Times
 * "Experience" section was added (Wait Times naturally stops showing these
 * three identities once they're removed from ENTERTAINMENT_PLACES).
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
  /**
   * CODEX P1 fix — the authoritative marker for the EXP.2 historical
   * Entertainment→Experience reclassification override, carried on the
   * catalog entry itself rather than duplicated as a separate hard-coded
   * name list elsewhere. True ONLY for the three identities EXP.2 moved
   * here from ENTERTAINMENT_PLACES (Savi's Workshop – Handbuilt
   * Lightsabers, Droid Depot, Olaf Draws!) — set on every resort variant of
   * each. Omitted (falsy) for every other entry, including Bibbidi Bobbidi
   * Boutique, which must never receive the override. Consult this only via
   * isReclassifiedFromEntertainmentKey() below, on a key already resolved
   * through resolveExperienceKey() — never by matching this field against
   * a raw/unresolved name.
   */
  reclassifiedFromEntertainment?: true;
};

export const EXPERIENCE_PLACES: ExperiencePlace[] = [
  { name: "Bibbidi Bobbidi Boutique", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Fantasyland" },
  { name: "Bibbidi Bobbidi Boutique", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Fantasyland" },
  // ---- EXP.2 catalog cutover — moved from ENTERTAINMENT_PLACES ----
  // reclassifiedFromEntertainment: true marks these as the approved
  // historical Entertainment→Experience override identities — see the
  // field's own doc comment on ExperiencePlace above.
  { name: "Savi's Workshop – Handbuilt Lightsabers", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Star Wars: Galaxy’s Edge", reclassifiedFromEntertainment: true },
  { name: "Savi's Workshop – Handbuilt Lightsabers", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Star Wars: Galaxy’s Edge", reclassifiedFromEntertainment: true },
  { name: "Droid Depot", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Star Wars: Galaxy’s Edge", reclassifiedFromEntertainment: true },
  { name: "Droid Depot", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Star Wars: Galaxy’s Edge", reclassifiedFromEntertainment: true },
  { name: "Olaf Draws!", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Animation Courtyard", reclassifiedFromEntertainment: true },
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

// CODEX P1 fix — derived directly from EXPERIENCE_PLACES's own
// reclassifiedFromEntertainment flag (see that field's doc comment above),
// so the set of identities eligible for the EXP.2 historical Entertainment→
// Experience override lives in exactly one place: this catalog. No separate
// canonical-name list is maintained anywhere else.
const RECLASSIFIED_FROM_ENTERTAINMENT_KEYS: ReadonlySet<string> = new Set(
  EXPERIENCE_PLACES.filter((p) => p.reclassifiedFromEntertainment).map((p) => normalizeKey(p.name)),
);

/**
 * True when `key` — a canonical Experience key already resolved via
 * resolveExperienceKey() (never a raw/unresolved name) — identifies one of
 * the approved historical Entertainment→Experience reclassification
 * identities (currently Savi's Workshop – Handbuilt Lightsabers, Droid
 * Depot, and Olaf Draws!). Because resolveExperienceKey() already routes a
 * maintained alias (e.g. "build a droid") to its canonical key through the
 * same authoritative alias/containment resolution used everywhere else in
 * this module, an alias for one of these three identities receives the same
 * answer as its canonical name — there is no second alias table here.
 * Bibbidi Bobbidi Boutique's key is never in this set, so it is never
 * eligible for the override. CODEX P1 fix — see
 * RECLASSIFIED_FROM_ENTERTAINMENT_KEYS above for where this is sourced from
 * (the catalog's own metadata, not a duplicated name list).
 */
export function isReclassifiedFromEntertainmentKey(key: string): boolean {
  return RECLASSIFIED_FROM_ENTERTAINMENT_KEYS.has(key);
}

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
 * lookup table). Bibbidi Bobbidi Boutique's official name needs no alias,
 * and "BBB" is deliberately excluded — it is planning shorthand, not a
 * catalog alias (see this file's module doc comment).
 *
 * EXP.2 catalog cutover: the Savi's Workshop / Droid Depot entries below are
 * carried over unchanged from ENTERTAINMENT_ALIASES (entertainmentSuggestions.ts)
 * — same keys/values, preserving guest-entered shorthand recognition across
 * the category migration. Olaf Draws! never had an entertainment alias, so
 * none is added here.
 */
const EXPERIENCE_ALIASES: Record<string, string> = {
  "savis": "savis workshop handbuilt lightsabers",
  "savi's": "savis workshop handbuilt lightsabers",
  "savi workshop": "savis workshop handbuilt lightsabers",
  "savis workshop": "savis workshop handbuilt lightsabers",
  "savi's workshop": "savis workshop handbuilt lightsabers",
  "savi lightsaber": "savis workshop handbuilt lightsabers",
  "lightsaber build": "savis workshop handbuilt lightsabers",
  "build lightsaber": "savis workshop handbuilt lightsabers",
  "handbuilt lightsabers": "savis workshop handbuilt lightsabers",
  "lightsaber experience": "savis workshop handbuilt lightsabers",
  "savi experience": "savis workshop handbuilt lightsabers",
  "build a droid": "droid depot",
  "droid build": "droid depot",
  "build droid": "droid depot",
  "custom droid": "droid depot",
  "astromech droid": "droid depot",
};

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

/**
 * Reference test cases for isReclassifiedFromEntertainmentKey() — CODEX P1
 * fix. Mirrors the DEV_PLAN_ALIAS_CASES convention in plansMatching.ts — not
 * wired into CI (no test runner in this repo), run manually from Node:
 *
 *   import { DEV_RECLASSIFIED_FROM_ENTERTAINMENT_CASES, resolveExperienceKey, isReclassifiedFromEntertainmentKey } from "@/lib/experienceSuggestions";
 *   for (const c of DEV_RECLASSIFIED_FROM_ENTERTAINMENT_CASES) {
 *     const got = isReclassifiedFromEntertainmentKey(resolveExperienceKey(c.name, c.resort) ?? "");
 *     const ok = got === c.expected;
 *     console.log(ok ? "✓" : "✗ FAIL", c.description, got);
 *   }
 *
 * Proves the reclassification-eligibility marker lives ONLY on
 * EXPERIENCE_PLACES itself (this catalog), that a maintained alias resolves
 * to the same answer as its canonical name (both flow through
 * resolveExperienceKey first), and that Bibbidi Bobbidi Boutique is
 * permanently excluded.
 */
export const DEV_RECLASSIFIED_FROM_ENTERTAINMENT_CASES: Array<{
  description: string;
  name: string;
  resort?: ResortId;
  expected: boolean;
}> = [
  {
    description: "Savi's Workshop canonical name (DLR) is marked reclassified",
    name: "Savi's Workshop – Handbuilt Lightsabers",
    resort: "DLR",
    expected: true,
  },
  {
    description: "Savi's Workshop canonical name (WDW) is marked reclassified",
    name: "Savi's Workshop – Handbuilt Lightsabers",
    resort: "WDW",
    expected: true,
  },
  {
    description: "Savi's Workshop alias ('savis') resolves to the same marked identity",
    name: "savis",
    expected: true,
  },
  {
    description: "Droid Depot canonical name is marked reclassified",
    name: "Droid Depot",
    resort: "WDW",
    expected: true,
  },
  {
    description: "Droid Depot alias ('build a droid') resolves to the same marked identity",
    name: "build a droid",
    resort: "DLR",
    expected: true,
  },
  {
    description: "Olaf Draws! canonical name is marked reclassified",
    name: "Olaf Draws!",
    resort: "WDW",
    expected: true,
  },
  {
    description: "Bibbidi Bobbidi Boutique is NEVER marked reclassified",
    name: "Bibbidi Bobbidi Boutique",
    resort: "WDW",
    expected: false,
  },
  {
    description: "Bibbidi Bobbidi Boutique (DLR) is NEVER marked reclassified",
    name: "Bibbidi Bobbidi Boutique",
    resort: "DLR",
    expected: false,
  },
];

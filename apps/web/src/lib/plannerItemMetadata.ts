/**
 * plannerItemMetadata.ts — shared planner location/lifecycle contract.
 *
 * A single read-only lookup that, given a planner item's name + type +
 * resort, returns normalized canonical identity/location/lifecycle metadata
 * for later My Plans presentation. This module owns no attraction/dining/
 * entertainment data of its own — it only dispatches to each domain's
 * existing authoritative accessor (getAttractionContext/getDiningContext/
 * getEntertainmentContext), honoring AGENTS.md's "Single maintained source
 * of truth" invariant. Extend the relevant domain source (legacyAttractions.ts/
 * diningSuggestions.ts/entertainmentSuggestions.ts) when metadata is missing —
 * never add a parallel catalog, alias map, or location table here.
 *
 * Each domain accessor already resolves active-first, legacy-fallback (see
 * their own doc comments), so this contract inherits that behavior for free:
 * a still-current identity resolves `lifecycle: "active"`, a permanently
 * closed/replaced one resolves `lifecycle: "legacy"`, and an unrecognized
 * name resolves with every optional field omitted — never invented metadata.
 *
 * Location shape: `parkId` + `land` together give "park + finer location
 * when maintained"; when a domain has no land for that identity, `land` is
 * simply omitted, leaving `parkId` alone as the park-only fallback. EPCOT
 * World Showcase attractions/dining/entertainment already share the single
 * maintained "World Showcase" land label (no pavilion granularity) via their
 * own catalogs, so no special-casing is needed here. `nonParkLocation` is
 * populated only when the identity has no single-park identity at all (e.g.
 * a Disney Springs restaurant or a resort-hotel dining location) — sourced
 * from the domain's own maintained `location` field, never invented.
 *
 * Deliberately does NOT read plannedClosures.ts: lifecycle here is the
 * canonical identity's own active/legacy status, not refurbishment/closure
 * timing (see AGENTS.md's Wait/closure correctness section on why those stay
 * separate). Refurbishment/closure window integration is a later, independent
 * slice — out of scope here.
 *
 * Structurally ready for a future Experience/seasonal item type: the
 * dispatch below is a switch over PlannerItemType, and an unrecognized/future
 * type simply falls through to the same "no invented metadata" bare result
 * as an unknown name, requiring no changes here to stay correct until that
 * type is actually implemented.
 *
 * EXP.2 also added resolvePlannerItemEffectiveType() to this module — a
 * distinct, prior concern from getPlannerItemMetadata() above: given a plan
 * item's raw/stored type, name, and (optional) resort, it resolves which
 * PlannerItemType the item should actually be treated as (trusting an
 * explicit stored type, applying the narrow historical Entertainment→
 * Experience reclassification override for three approved identities, and
 * otherwise falling back to name-based inference). Callers resolve the
 * effective type first, then pass it into getPlannerItemMetadata() as
 * usual. See that function's own doc comment for the full precedence.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import type { PlannerItemType } from "./plansTransfer";
import { getAttractionContext } from "./legacyAttractions";
import { getDiningContext, inferPlannerItemType } from "./diningSuggestions";
import { getEntertainmentContext } from "./entertainmentSuggestions";
import { getExperienceContext, resolveExperienceKey, isReclassifiedFromEntertainmentKey } from "./experienceSuggestions";

/** Lifecycle status of a resolved canonical identity. */
export type PlannerItemLifecycle = "active" | "legacy";

export type PlannerItemMetadata = {
  /** The planner item type this metadata was resolved for. */
  type: PlannerItemType;
  /** Resort this lookup was scoped to. */
  resortId: ResortId;
  /** Recognized canonical display name — omitted for an unknown/custom name. */
  canonicalName?: string;
  /** Theme park, when the identity has one. */
  parkId?: ParkId;
  /** Themed land/area within the park, when maintained. */
  land?: string;
  /**
   * Canonical non-park location (resort hotel, Downtown Disney, Disney
   * Springs, etc.), only when the identity has no single-park identity.
   * Never set alongside `parkId`.
   */
  nonParkLocation?: string;
  /**
   * "active" for a current identity, "legacy" for a permanently closed/
   * replaced one recognized only so historical plan items keep resolving.
   * Omitted entirely for an unrecognized name — never guessed.
   */
  lifecycle?: PlannerItemLifecycle;
};

// ---------------------------------------------------------------------------
// EXP.2 — shared effective-type resolver
// ---------------------------------------------------------------------------

// Duplicated locally rather than imported/exported (mirrors the same
// deliberate duplication already present in plans/page.tsx,
// plannerContextSnapshot.ts, and crossDayChecks.ts — see their own copies'
// doc comments): strips a trailing time-like suffix (e.g. "9pm", "9:00 PM",
// "21:00") from a name before type lookup only, so an old imported/restored
// item like "Fantasmic 9pm" still resolves by its activity name. Never
// touches the stored/display name, only this module's own lookup key.
function stripTrailingTimeForInference(name: string): string {
  return name
    .replace(/\s*\b\d{1,2}(:\d{2})?\s*(am|pm)\b\s*$/i, "")
    .replace(/\s*\b\d{1,2}:\d{2}\s*$/, "")
    .trim();
}

/**
 * Resolves a planner item's effective PlannerItemType from its stored/
 * imported raw type value, current name, and (when known) resort. The
 * single authoritative resolver for "what type should this item actually be
 * treated as" — supersedes the near-identical resolveHydratedPlannerItemType/
 * resolveImportedPlannerItemType (formerly in plans/page.tsx) and
 * resolveItemType (formerly in plannerContextSnapshot.ts), which
 * independently reimplemented this same precedence. Every hydration/import/
 * restore/Tom-planner-context call site uses this function rather than
 * re-deriving the type locally.
 *
 * Precedence:
 *   1. Approved reclassified identity → "experience", regardless of
 *      rawType. Eligibility is resolved via resolveExperienceKey() (the
 *      authoritative Experience canonical/alias/containment resolver —
 *      never broad string matching) and then checked against
 *      isReclassifiedFromEntertainmentKey() (experienceSuggestions.ts),
 *      which reads the reclassifiedFromEntertainment flag carried on the
 *      catalog entries themselves (CODEX P1 fix — no duplicated canonical-
 *      name list is maintained here or anywhere else). This is the narrow
 *      historical-compatibility override: only the identities the catalog
 *      itself marks (Savi's Workshop, Droid Depot, Olaf Draws!) are
 *      affected — a maintained alias for one of them (e.g. "build a droid")
 *      resolves the same way its canonical name does, since both flow
 *      through the same resolveExperienceKey() call, while a similarly-
 *      named but unrelated custom entry is never accidentally converted.
 *   2. An explicit, already-trusted stored type — "dining", "entertainment",
 *      or "experience" — is preserved as-is. ("attraction" is deliberately
 *      NOT trusted here: it has always been the universal pre-Phase-9
 *      default/omitted value, so it is treated the same as a missing type
 *      and re-inferred below — this mirrors the exact behavior every
 *      superseded implementation already had.)
 *   3. Otherwise, name-based inference via inferPlannerItemType()
 *      (diningSuggestions.ts) — the same existing authoritative resolver
 *      Add/Edit and manual entry already use.
 */
export function resolvePlannerItemEffectiveType(
  rawType: unknown,
  name: string,
  resort?: ResortId,
): PlannerItemType {
  const cleanedName = stripTrailingTimeForInference(name);

  const experienceKey = resolveExperienceKey(cleanedName, resort);
  if (experienceKey && isReclassifiedFromEntertainmentKey(experienceKey)) {
    return "experience";
  }

  if (rawType === "dining" || rawType === "entertainment" || rawType === "experience") {
    return rawType;
  }

  return inferPlannerItemType(cleanedName, resort);
}

/**
 * Resolve normalized planner metadata for a plan item's current name + type
 * + resort. See the module doc comment above for the full contract.
 */
export function getPlannerItemMetadata(
  name: string,
  type: PlannerItemType,
  resort: ResortId,
): PlannerItemMetadata {
  switch (type) {
    case "attraction": {
      const ctx = getAttractionContext(name, resort);
      if (!ctx) return { type, resortId: resort };
      return {
        type,
        resortId: ctx.resortId,
        canonicalName: ctx.name,
        parkId: ctx.parkId ?? undefined,
        land: ctx.land,
        lifecycle: ctx.lifecycle,
      };
    }
    case "dining": {
      const ctx = getDiningContext(name, resort);
      if (!ctx) return { type, resortId: resort };
      return {
        type,
        resortId: ctx.resortId,
        canonicalName: ctx.name,
        parkId: ctx.parkId ?? undefined,
        land: ctx.land,
        nonParkLocation: ctx.parkId ? undefined : ctx.location,
        lifecycle: ctx.lifecycle,
      };
    }
    case "entertainment": {
      const ctx = getEntertainmentContext(name, resort);
      if (!ctx) return { type, resortId: resort };
      return {
        type,
        resortId: ctx.resortId,
        canonicalName: ctx.name,
        parkId: ctx.parkId ?? undefined,
        land: ctx.land,
        nonParkLocation: ctx.parkId ? undefined : ctx.location,
        lifecycle: ctx.lifecycle,
      };
    }
    case "experience": {
      const ctx = getExperienceContext(name, resort);
      if (!ctx) return { type, resortId: resort };
      return {
        type,
        resortId: ctx.resortId,
        canonicalName: ctx.name,
        parkId: ctx.parkId ?? undefined,
        land: ctx.land,
        nonParkLocation: ctx.parkId ? undefined : ctx.location,
        lifecycle: ctx.lifecycle,
      };
    }
    default:
      // No domain resolver for this type — resolve as unknown rather than
      // guess. Structurally unreachable today (PlannerItemType is exhaustively
      // handled above), kept as a safety net for a future added type.
      return { type, resortId: resort };
  }
}

// ---------------------------------------------------------------------------
// Dev-only validation
// ---------------------------------------------------------------------------

/**
 * Reference test cases for getPlannerItemMetadata(). Mirrors the
 * DEV_PLAN_ALIAS_CASES convention in plansMatching.ts — not wired into CI
 * (no test runner in this repo), run manually from Node:
 *
 *   import { DEV_PLANNER_ITEM_METADATA_CASES, getPlannerItemMetadata } from "@/lib/plannerItemMetadata";
 *   for (const c of DEV_PLANNER_ITEM_METADATA_CASES) {
 *     const got = getPlannerItemMetadata(c.name, c.type, c.resort);
 *     const ok = JSON.stringify(got) === JSON.stringify(c.expected);
 *     console.log(ok ? "✓" : "✗ FAIL", c.description, got);
 *   }
 */
export const DEV_PLANNER_ITEM_METADATA_CASES: Array<{
  description: string;
  name: string;
  type: PlannerItemType;
  resort: ResortId;
  expected: PlannerItemMetadata;
}> = [
  // ---- Active attractions, WDW + DLR ----
  {
    description: "active attraction, WDW (Space Mountain, MK/Tomorrowland)",
    name: "Space Mountain",
    type: "attraction",
    resort: "WDW",
    expected: {
      type: "attraction", resortId: "WDW", canonicalName: "Space Mountain",
      parkId: "mk", land: "Tomorrowland", lifecycle: "active",
    },
  },
  {
    description: "active attraction, DLR (Space Mountain, Disneyland/Tomorrowland)",
    name: "Space Mountain",
    type: "attraction",
    resort: "DLR",
    expected: {
      type: "attraction", resortId: "DLR", canonicalName: "Space Mountain",
      parkId: "disneyland", land: "Tomorrowland", lifecycle: "active",
    },
  },
  {
    description: "active attraction alias (Aladdin -> Magic Carpets of Aladdin, WDW)",
    name: "Aladdin",
    type: "attraction",
    resort: "WDW",
    expected: {
      type: "attraction", resortId: "WDW", canonicalName: "Magic Carpets of Aladdin",
      parkId: "mk", land: "Adventureland", lifecycle: "active",
    },
  },
  // ---- EPCOT World Showcase — no pavilion granularity ----
  {
    description: "active attraction, EPCOT World Showcase (Frozen Ever After)",
    name: "Frozen Ever After",
    type: "attraction",
    resort: "WDW",
    expected: {
      type: "attraction", resortId: "WDW", canonicalName: "Frozen Ever After",
      parkId: "epcot", land: "World Showcase", lifecycle: "active",
    },
  },
  // ---- Legacy attractions, WDW + DLR (same name, different historical park/land) ----
  {
    description: "legacy attraction, WDW (Splash Mountain, MK/Frontierland)",
    name: "Splash Mountain",
    type: "attraction",
    resort: "WDW",
    expected: {
      type: "attraction", resortId: "WDW", canonicalName: "Splash Mountain",
      parkId: "mk", land: "Frontierland", lifecycle: "legacy",
    },
  },
  {
    description: "legacy attraction, DLR (Splash Mountain, Disneyland/Critter Country)",
    name: "Splash Mountain",
    type: "attraction",
    resort: "DLR",
    expected: {
      type: "attraction", resortId: "DLR", canonicalName: "Splash Mountain",
      parkId: "disneyland", land: "Critter Country", lifecycle: "legacy",
    },
  },
  {
    description: "legacy attraction alias (Ellen's Energy Adventure -> Universe of Energy, WDW)",
    name: "Ellen's Energy Adventure",
    type: "attraction",
    resort: "WDW",
    expected: {
      type: "attraction", resortId: "WDW", canonicalName: "Universe of Energy",
      parkId: "epcot", land: "World Discovery", lifecycle: "legacy",
    },
  },
  // ---- Active dining, WDW + DLR ----
  {
    description: "active dining alias (CRT -> Cinderella's Royal Table, WDW)",
    name: "CRT",
    type: "dining",
    resort: "WDW",
    expected: {
      type: "dining", resortId: "WDW", canonicalName: "Cinderella's Royal Table",
      parkId: "mk", land: "Fantasyland", lifecycle: "active",
    },
  },
  {
    description: "active dining, DLR (Blue Bayou Restaurant, Disneyland/New Orleans Square)",
    name: "Blue Bayou Restaurant",
    type: "dining",
    resort: "DLR",
    expected: {
      type: "dining", resortId: "DLR", canonicalName: "Blue Bayou Restaurant",
      parkId: "disneyland", land: "New Orleans Square", lifecycle: "active",
    },
  },
  // ---- Non-park dining location ----
  {
    description: "active dining, non-park location (Napa Rose, Grand Californian Hotel)",
    name: "Napa Rose",
    type: "dining",
    resort: "DLR",
    expected: {
      type: "dining", resortId: "DLR", canonicalName: "Napa Rose",
      nonParkLocation: "Disney's Grand Californian Hotel", lifecycle: "active",
    },
  },
  // ---- Legacy dining, WDW + DLR ----
  {
    description: "legacy dining, non-park location (Steakhouse 55, Disneyland Hotel)",
    name: "Steakhouse 55",
    type: "dining",
    resort: "DLR",
    expected: {
      type: "dining", resortId: "DLR", canonicalName: "Steakhouse 55",
      nonParkLocation: "Disneyland Hotel", lifecycle: "legacy",
    },
  },
  {
    description: "legacy dining, EPCOT World Showcase (Tokyo Dining)",
    name: "Tokyo Dining",
    type: "dining",
    resort: "WDW",
    expected: {
      type: "dining", resortId: "WDW", canonicalName: "Tokyo Dining",
      parkId: "epcot", land: "World Showcase", lifecycle: "legacy",
    },
  },
  // ---- Active entertainment, WDW + DLR ----
  {
    description: "active entertainment alias (HEA -> Happily Ever After, WDW)",
    name: "HEA",
    type: "entertainment",
    resort: "WDW",
    expected: {
      type: "entertainment", resortId: "WDW", canonicalName: "Happily Ever After",
      parkId: "mk", land: "Main Street, U.S.A.", lifecycle: "active",
    },
  },
  {
    description: "active entertainment, DLR (Fantasmic!, Disneyland/Frontierland)",
    name: "Fantasmic!",
    type: "entertainment",
    resort: "DLR",
    expected: {
      type: "entertainment", resortId: "DLR", canonicalName: "Fantasmic!",
      parkId: "disneyland", land: "Frontierland", lifecycle: "active",
    },
  },
  // ---- Legacy entertainment alias ----
  {
    description: "legacy entertainment alias (Together Forever -> full title, DLR)",
    name: "Together Forever",
    type: "entertainment",
    resort: "DLR",
    expected: {
      type: "entertainment", resortId: "DLR",
      canonicalName: "Together Forever — A Pixar Nighttime Spectacular",
      parkId: "disneyland", land: "Main Street, U.S.A.", lifecycle: "legacy",
    },
  },
  // ---- Active Experience, WDW + DLR (EXP.0) ----
  {
    description: "active experience, DLR (Bibbidi Bobbidi Boutique, Disneyland/Fantasyland)",
    name: "Bibbidi Bobbidi Boutique",
    type: "experience",
    resort: "DLR",
    expected: {
      type: "experience", resortId: "DLR", canonicalName: "Bibbidi Bobbidi Boutique",
      parkId: "disneyland", land: "Fantasyland", lifecycle: "active",
    },
  },
  {
    description: "active experience, WDW (Bibbidi Bobbidi Boutique, Magic Kingdom/Fantasyland)",
    name: "Bibbidi Bobbidi Boutique",
    type: "experience",
    resort: "WDW",
    expected: {
      type: "experience", resortId: "WDW", canonicalName: "Bibbidi Bobbidi Boutique",
      parkId: "mk", land: "Fantasyland", lifecycle: "active",
    },
  },
  // ---- EXP.2 catalog cutover — moved Entertainment→Experience identities ----
  {
    description: "active experience, DLR (Savi's Workshop, Disneyland/Galaxy's Edge) — EXP.2 cutover",
    name: "Savi's Workshop – Handbuilt Lightsabers",
    type: "experience",
    resort: "DLR",
    expected: {
      type: "experience", resortId: "DLR", canonicalName: "Savi's Workshop – Handbuilt Lightsabers",
      parkId: "disneyland", land: "Star Wars: Galaxy’s Edge", lifecycle: "active",
    },
  },
  {
    description: "active experience, WDW (Droid Depot, Hollywood Studios/Galaxy's Edge) — EXP.2 cutover",
    name: "Droid Depot",
    type: "experience",
    resort: "WDW",
    expected: {
      type: "experience", resortId: "WDW", canonicalName: "Droid Depot",
      parkId: "hs", land: "Star Wars: Galaxy’s Edge", lifecycle: "active",
    },
  },
  {
    description: "active experience, WDW (Olaf Draws!, Hollywood Studios/Animation Courtyard) — EXP.2 cutover",
    name: "Olaf Draws!",
    type: "experience",
    resort: "WDW",
    expected: {
      type: "experience", resortId: "WDW", canonicalName: "Olaf Draws!",
      parkId: "hs", land: "Animation Courtyard", lifecycle: "active",
    },
  },
  // ---- Unknown/custom — no invented metadata ----
  {
    description: "unknown/custom attraction name",
    name: "Made Up Ride Nobody Has Heard Of",
    type: "attraction",
    resort: "WDW",
    expected: { type: "attraction", resortId: "WDW" },
  },
  {
    description: "unknown/custom dining name",
    name: "Some Random Snack Cart",
    type: "dining",
    resort: "DLR",
    expected: { type: "dining", resortId: "DLR" },
  },
  {
    description: "unknown/custom experience name",
    name: "Made Up Experience Nobody Has Heard Of",
    type: "experience",
    resort: "WDW",
    expected: { type: "experience", resortId: "WDW" },
  },
];

/**
 * Reference test cases for resolvePlannerItemEffectiveType() — EXP.2.
 * Mirrors the DEV_PLAN_ALIAS_CASES convention in plansMatching.ts — not
 * wired into CI (no test runner in this repo), run manually from Node:
 *
 *   import { DEV_RESOLVE_PLANNER_ITEM_EFFECTIVE_TYPE_CASES, resolvePlannerItemEffectiveType } from "@/lib/plannerItemMetadata";
 *   for (const c of DEV_RESOLVE_PLANNER_ITEM_EFFECTIVE_TYPE_CASES) {
 *     const got = resolvePlannerItemEffectiveType(c.rawType, c.name, c.resort);
 *     const ok = got === c.expected;
 *     console.log(ok ? "✓" : "✗ FAIL", c.description, got);
 *   }
 *
 * Covers the full precedence order (reclassification override > explicit
 * trusted type > name inference) and guards against the override
 * broadening beyond the three approved identities.
 */
export const DEV_RESOLVE_PLANNER_ITEM_EFFECTIVE_TYPE_CASES: Array<{
  description: string;
  rawType: unknown;
  name: string;
  resort?: ResortId;
  expected: PlannerItemType;
}> = [
  // ---- Precedence 1: reclassification override wins over explicit stale type ----
  {
    description: "historical Savi's Workshop + explicit entertainment (DLR) -> experience",
    rawType: "entertainment",
    name: "Savi's Workshop – Handbuilt Lightsabers",
    resort: "DLR",
    expected: "experience",
  },
  {
    description: "historical Savi's Workshop + explicit entertainment (WDW) -> experience",
    rawType: "entertainment",
    name: "Savi's Workshop – Handbuilt Lightsabers",
    resort: "WDW",
    expected: "experience",
  },
  {
    description: "historical Droid Depot + explicit entertainment -> experience",
    rawType: "entertainment",
    name: "Droid Depot",
    resort: "WDW",
    expected: "experience",
  },
  {
    description: "historical Olaf Draws! + explicit entertainment -> experience",
    rawType: "entertainment",
    name: "Olaf Draws!",
    resort: "WDW",
    expected: "experience",
  },
  {
    description: "historical Savi's Workshop alias (\"Savi's\") + explicit entertainment, no resort -> experience",
    rawType: "entertainment",
    name: "Savi's",
    expected: "experience",
  },
  {
    description: "historical Droid Depot alias (\"build a droid\") + explicit entertainment -> experience",
    rawType: "entertainment",
    name: "build a droid",
    resort: "DLR",
    expected: "experience",
  },
  {
    description: "reclassification override applies even with no stored type at all",
    rawType: undefined,
    name: "Droid Depot",
    resort: "DLR",
    expected: "experience",
  },
  // ---- Precedence 2: explicit trusted type preserved for unrelated names ----
  {
    description: "unrelated custom item + explicit entertainment -> remains entertainment",
    rawType: "entertainment",
    name: "Some Made Up Nighttime Show",
    resort: "WDW",
    expected: "entertainment",
  },
  {
    description: "current explicit experience (Bibbidi Bobbidi Boutique) -> remains experience",
    rawType: "experience",
    name: "Bibbidi Bobbidi Boutique",
    resort: "WDW",
    expected: "experience",
  },
  {
    description: "unrelated explicit dining -> remains dining",
    rawType: "dining",
    name: "Some Random Snack Cart",
    resort: "DLR",
    expected: "dining",
  },
  {
    description: "unrelated real entertainment name + explicit entertainment -> remains entertainment",
    rawType: "entertainment",
    name: "Happily Ever After",
    resort: "WDW",
    expected: "entertainment",
  },
  // ---- Precedence 3: missing/invalid/"attraction" type falls back to name inference ----
  {
    description: "missing type on a known dining name -> inferred dining",
    rawType: undefined,
    name: "Blue Bayou Restaurant",
    resort: "DLR",
    expected: "dining",
  },
  {
    description: "stale explicit \"attraction\" on a now-Experience name -> re-inferred experience (pre-Phase-9 default is never trusted)",
    rawType: "attraction",
    name: "Droid Depot",
    resort: "WDW",
    expected: "experience",
  },
  {
    description: "unknown/custom name with no type -> defaults to attraction",
    rawType: undefined,
    name: "Made Up Ride Nobody Has Heard Of",
    resort: "WDW",
    expected: "attraction",
  },
  // ---- Similarly-named custom entries are never swept in by the override ----
  {
    description: "unrelated name merely containing \"droid\" is not reclassified",
    rawType: "entertainment",
    name: "Droid Racing Simulator Meetup",
    resort: "WDW",
    expected: "entertainment",
  },
  // ---- CODEX P1 fix — the override is scoped to the catalog's own marker,
  // not "any Experience identity"; Bibbidi Bobbidi Boutique must never
  // receive it even under a contrived stale/explicit "entertainment" type ----
  {
    description: "Bibbidi Bobbidi Boutique + contrived explicit entertainment is NOT overridden to experience (never catalog-marked)",
    rawType: "entertainment",
    name: "Bibbidi Bobbidi Boutique",
    resort: "WDW",
    expected: "entertainment",
  },
];

/**
 * catalogQuery.ts — DWP↔Tom canonical catalog query contract (DWP producer side).
 *
 * DWP is the authoritative source for stable canonical planner/catalog
 * metadata (canonical identity/name, type, resort, park, land, active vs.
 * legacy lifecycle). This module is the single implementation behind
 * `GET /api/catalog/query` (see that route for auth/transport) and answers
 * structured filter queries — never a free-text search, and never by
 * parsing a natural-language question (that stays Tom's responsibility).
 *
 * Deliberately forks no data of its own: every result is read directly from
 * the existing per-domain ACTIVE catalogs and their existing alias/canonical
 * resolvers —
 *   - attraction: `mockAttractionWaits` (packages/shared) +
 *     `resolveAttractionIdentityKey` (legacyAttractions.ts)
 *   - dining: `DINING_PLACES` + `resolveDiningKey` (diningSuggestions.ts)
 *   - entertainment: `ENTERTAINMENT_PLACES` + `resolveEntertainmentKey`
 *     (entertainmentSuggestions.ts)
 *   - experience: `EXPERIENCE_PLACES` + `resolveExperienceKey`
 *     (experienceSuggestions.ts)
 * plus `PARK_LABELS`/`PARK_TO_RESORT` (crossDayChecks.ts) for canonical park
 * display names. Per AGENTS.md's "Single maintained source of truth", add
 * new metadata to those existing sources — never here.
 *
 * Active-only by construction: each domain's name resolver
 * (resolveAttractionIdentityKey/resolveDiningKey/resolveEntertainmentKey/
 * resolveExperienceKey) falls back to that domain's LEGACY catalog so old
 * saved plans keep resolving, but those legacy catalogs are deliberately
 * NOT exported from their modules. This module only ever filters the
 * exported ACTIVE arrays for the resolved key, so a name that resolves
 * exclusively via a legacy fallback (e.g. "Splash Mountain" at WDW, replaced
 * by Tiana's Bayou Adventure) naturally yields zero rows here — no separate
 * "active-only" filter/flag is needed.
 *
 * Non-park identities (e.g. Napa Rose, Oga's Cantina's Downtown Disney
 * cousins — none currently, but resort-hotel/Disney Springs/Downtown Disney
 * dining generally) preserve their existing `location` metadata as
 * `nonParkLocation` instead of inventing a park/land, mirroring
 * plannerItemMetadata.ts's `getPlannerItemMetadata` contract exactly.
 */

import { mockAttractionWaits, type ParkId, type ResortId } from "@disney-wait-planner/shared";
import { normalizeKey } from "./plansMatching";
import { resolveAttractionIdentityKey } from "./legacyAttractions";
import { DINING_PLACES, resolveDiningKey, type DiningPlace } from "./diningSuggestions";
import { ENTERTAINMENT_PLACES, resolveEntertainmentKey, type EntertainmentPlace } from "./entertainmentSuggestions";
import { EXPERIENCE_PLACES, resolveExperienceKey, type ExperiencePlace } from "./experienceSuggestions";
import { PARK_LABELS, PARK_TO_RESORT, isValidParkId } from "./crossDayChecks";
import type { PlannerItemType } from "./plansTransfer";

const RESORT_IDS: ResortId[] = ["DLR", "WDW"];
const CATALOG_TYPES: PlannerItemType[] = ["attraction", "dining", "entertainment", "experience"];

/** Defensive bound — every individual filter value is a short structured token, never free text. */
const MAX_FILTER_LEN = 200;

/** Defensive cap on total rows returned — the combined active catalog is small (well under this). */
const MAX_RESULTS = 500;

/** Raw, unvalidated query filters — exactly what a caller (the HTTP route) receives from query params. */
export type CatalogQueryFilters = {
  name?: string;
  type?: string;
  resort?: string;
  park?: string;
  land?: string;
};

/** Canonical, stable result shape — human-readable metadata only, never internal-only ids. */
export type CatalogResult = {
  type: PlannerItemType;
  canonicalName: string;
  resort: ResortId;
  /** Canonical park display name (e.g. "Hollywood Studios"), when the identity has one. */
  park?: string;
  /** Themed land/area, when maintained for this identity. */
  land?: string;
  /**
   * Canonical non-park location (resort hotel, Downtown Disney, Disney
   * Springs, etc.) — only when the identity has no single-park identity.
   * Never set alongside `park`.
   */
  nonParkLocation?: string;
  /** Always "active" — see module doc comment on why legacy rows never reach this far. */
  lifecycle: "active";
};

export type CatalogQueryResponse =
  | { ok: true; results: CatalogResult[]; truncated?: true }
  | { ok: false; error: string };

function isPlannerItemType(value: string): value is PlannerItemType {
  return (CATALOG_TYPES as string[]).includes(value);
}

function isResortId(value: string): value is ResortId {
  return (RESORT_IDS as string[]).includes(value);
}

/**
 * Resolves a caller-supplied park filter (either a raw ParkId code, e.g.
 * "hs", or its canonical display label, e.g. "Hollywood Studios") to a
 * ParkId — case-insensitively for the code, and via normalizeKey (so
 * punctuation/apostrophe variants match) for the label. Returns null when
 * the value matches neither, so the caller can reject it rather than
 * silently running an unbounded/free-text park search.
 */
function resolveParkFilter(raw: string): ParkId | null {
  const lowered = raw.trim().toLowerCase();
  if (isValidParkId(lowered)) return lowered;
  const key = normalizeKey(raw);
  for (const parkId of Object.keys(PARK_LABELS) as ParkId[]) {
    if (normalizeKey(PARK_LABELS[parkId]) === key) return parkId;
  }
  return null;
}

/** Parsed/validated filters, ready to run against each domain's active catalog. */
type ParsedFilters = {
  name?: string;
  type?: PlannerItemType;
  resort?: ResortId;
  park?: ParkId;
  land?: string;
};

/**
 * CODEX P2 fix — the resort hint used to resolve a `name` (e.g. so a
 * resort-scoped alias like entertainment's "Halloween Parade"/"projection
 * show" can resolve at all — see ENTERTAINMENT_ALIASES_BY_RESORT in
 * entertainmentSuggestions.ts) must not require an explicit `resort` filter
 * when `park` already identifies one unambiguously. Every ParkId belongs to
 * exactly one resort (PARK_TO_RESORT, the same maintained park→resort
 * relationship crossDayChecks.ts/resolveParkFilter above already use) — no
 * new metadata is introduced here.
 *
 * An explicit `filters.resort` always wins and is never overridden by a
 * park-derived guess: this is only ever used to fill in a MISSING resort
 * hint, never to second-guess an explicit one. When both are supplied and
 * disagree (e.g. resort=WDW + park=Disneyland), this still returns the
 * explicit resort — the subsequent park filter (applied identically to
 * every result below, resolved-by-name or not) then naturally yields no
 * match rather than silently swapping in the park's resort.
 */
function resolveIdentityResortHint(filters: ParsedFilters): ResortId | undefined {
  return filters.resort ?? (filters.park ? PARK_TO_RESORT[filters.park] : undefined);
}

function toResult(
  type: PlannerItemType,
  resort: ResortId,
  entry: { name: string; land?: string; parkId?: ParkId | null; location?: string },
): CatalogResult {
  const parkId = entry.parkId ?? undefined;
  return {
    type,
    canonicalName: entry.name,
    resort,
    ...(parkId ? { park: PARK_LABELS[parkId] } : {}),
    ...(entry.land ? { land: entry.land } : {}),
    ...(!parkId && entry.location ? { nonParkLocation: entry.location } : {}),
    lifecycle: "active",
  };
}

function landMatches(entryLand: string | undefined, filterLand: string | undefined): boolean {
  if (!filterLand) return true;
  return normalizeKey(entryLand ?? "") === normalizeKey(filterLand);
}

function queryAttractions(filters: ParsedFilters): CatalogResult[] {
  const results: CatalogResult[] = [];

  if (filters.name) {
    // CODEX P2 fix — narrow identity resolution to the park-derived resort
    // when no explicit resort was supplied (see resolveIdentityResortHint).
    // Falls back to searching both resorts only when neither resort nor
    // park narrows it, same as before this fix.
    const identityHint = resolveIdentityResortHint(filters);
    const resortsToSearch = identityHint ? [identityHint] : RESORT_IDS;
    for (const resort of resortsToSearch) {
      const key = resolveAttractionIdentityKey(filters.name, resort, { allowContainment: true });
      if (!key) continue;
      for (const entry of mockAttractionWaits) {
        if (entry.resortId !== resort) continue;
        if (normalizeKey(entry.name) !== key) continue;
        if (filters.park && entry.parkId !== filters.park) continue;
        if (!landMatches(entry.land, filters.land)) continue;
        results.push(toResult("attraction", resort, entry));
      }
    }
    return results;
  }

  for (const entry of mockAttractionWaits) {
    if (filters.resort && entry.resortId !== filters.resort) continue;
    if (filters.park && entry.parkId !== filters.park) continue;
    if (!landMatches(entry.land, filters.land)) continue;
    results.push(toResult("attraction", entry.resortId, entry));
  }
  return results;
}

/**
 * Shared query path for the three domains (dining/entertainment/experience)
 * whose catalog entry shape and resolver signature already match exactly
 * (`{ name, resort, parkId?, land?, location }` + `resolveKey(name, resort?)`).
 * Attractions are handled separately above only because
 * resolveAttractionIdentityKey requires an explicit resort argument (no
 * across-both-resorts overload) and AttractionWait uses `resortId` rather
 * than `resort`.
 */
function queryPlaceDomain<T extends { name: string; resort: ResortId; parkId?: ParkId; land?: string; location: string }>(
  type: PlannerItemType,
  activeEntries: T[],
  resolveKey: (name: string, resort?: ResortId) => string | null,
  filters: ParsedFilters,
): CatalogResult[] {
  let candidates = activeEntries;
  if (filters.name) {
    // CODEX P2 fix — see resolveIdentityResortHint: falls back to a
    // park-derived resort hint when no explicit resort was given, so a
    // resort-scoped alias (e.g. entertainment's "Halloween Parade"/
    // "projection show") can still resolve when the caller supplied an
    // unambiguous park instead of a resort.
    const key = resolveKey(filters.name, resolveIdentityResortHint(filters));
    if (!key) return [];
    candidates = activeEntries.filter((e) => normalizeKey(e.name) === key);
  }
  return candidates
    .filter((e) => !filters.resort || e.resort === filters.resort)
    .filter((e) => !filters.park || e.parkId === filters.park)
    .filter((e) => landMatches(e.land, filters.land))
    .map((e) => toResult(type, e.resort, e));
}

/**
 * Structured, read-only catalog query. Validates all filters up front
 * (returning `{ ok: false, error }` for anything malformed/unrecognized)
 * rather than guessing or silently ignoring bad input, then runs the
 * requested domain(s) — `type` restricts to one, omitted searches all four.
 *
 * Behavior notes (see module doc comment for the sourcing contract):
 *   - `name` resolves through each domain's existing alias/canonical
 *     resolver; an unrecognized name yields a clean empty result, not an
 *     error.
 *   - Without a `resort` hint, a shared identity (e.g. Oga's Cantina, active
 *     at both DLR and WDW) returns every valid active variant rather than
 *     guessing one.
 *   - `park` accepts either a raw ParkId code or its canonical display
 *     label; an unrecognized park is rejected (`ok: false`) rather than
 *     silently matching nothing, since it is a small closed set. `land` has
 *     no closed enum (it is free-form maintained catalog text), so an
 *     unrecognized `land` simply yields an empty result.
 */
export function queryCatalog(filters: CatalogQueryFilters): CatalogQueryResponse {
  const rawName = filters.name?.trim();
  const rawPark = filters.park?.trim();
  const rawLand = filters.land?.trim();

  if (filters.name !== undefined && !rawName) {
    return { ok: false, error: "name filter must not be empty" };
  }
  for (const [label, value] of [
    ["name", rawName],
    ["park", rawPark],
    ["land", rawLand],
  ] as const) {
    if (value !== undefined && value.length > MAX_FILTER_LEN) {
      return { ok: false, error: `${label} filter is too long` };
    }
  }

  let type: PlannerItemType | undefined;
  if (filters.type !== undefined) {
    if (!isPlannerItemType(filters.type)) {
      return { ok: false, error: "Invalid type filter" };
    }
    type = filters.type;
  }

  let resort: ResortId | undefined;
  if (filters.resort !== undefined) {
    if (!isResortId(filters.resort)) {
      return { ok: false, error: "Invalid resort filter" };
    }
    resort = filters.resort;
  }

  let park: ParkId | undefined;
  if (rawPark) {
    const resolved = resolveParkFilter(rawPark);
    if (!resolved) return { ok: false, error: "Unknown park filter" };
    park = resolved;
  }

  const parsed: ParsedFilters = { name: rawName, type, resort, park, land: rawLand };
  const domains = type ? [type] : CATALOG_TYPES;

  const results: CatalogResult[] = [];
  for (const domain of domains) {
    switch (domain) {
      case "attraction":
        results.push(...queryAttractions(parsed));
        break;
      case "dining":
        results.push(...queryPlaceDomain<DiningPlace>("dining", DINING_PLACES, resolveDiningKey, parsed));
        break;
      case "entertainment":
        results.push(
          ...queryPlaceDomain<EntertainmentPlace>("entertainment", ENTERTAINMENT_PLACES, resolveEntertainmentKey, parsed),
        );
        break;
      case "experience":
        results.push(...queryPlaceDomain<ExperiencePlace>("experience", EXPERIENCE_PLACES, resolveExperienceKey, parsed));
        break;
    }
  }

  if (results.length > MAX_RESULTS) {
    return { ok: true, results: results.slice(0, MAX_RESULTS), truncated: true };
  }
  return { ok: true, results };
}

// ---------------------------------------------------------------------------
// Dev-only validation
// ---------------------------------------------------------------------------

/**
 * Reference test cases for queryCatalog(). Mirrors the DEV_PLAN_ALIAS_CASES
 * convention in plansMatching.ts — not wired into CI (no test runner in this
 * repo), run manually from Node:
 *
 *   import { DEV_CATALOG_QUERY_CASES, queryCatalog } from "@/lib/catalogQuery";
 *   for (const c of DEV_CATALOG_QUERY_CASES) {
 *     const got = queryCatalog(c.filters);
 *     const ok = JSON.stringify(got) === JSON.stringify(c.expected);
 *     console.log(ok ? "✓" : "✗ FAIL", c.description, got);
 *   }
 */
export const DEV_CATALOG_QUERY_CASES: Array<{
  description: string;
  filters: CatalogQueryFilters;
  expected: CatalogQueryResponse;
}> = [
  {
    description: "TRON alias/canonical lookup -> Attraction / WDW / Magic Kingdom / Tomorrowland",
    filters: { name: "TRON" },
    expected: {
      ok: true,
      results: [
        {
          type: "attraction",
          canonicalName: "TRON Lightcycle / Run",
          resort: "WDW",
          park: "Magic Kingdom",
          land: "Tomorrowland",
          lifecycle: "active",
        },
      ],
    },
  },
  {
    description: "Oga's Cantina without resort -> both valid DLR + WDW active variants",
    filters: { name: "Oga's Cantina" },
    expected: {
      ok: true,
      results: [
        {
          type: "dining",
          canonicalName: "Oga's Cantina",
          resort: "DLR",
          park: "Disneyland",
          land: "Star Wars: Galaxy’s Edge",
          lifecycle: "active",
        },
        {
          type: "dining",
          canonicalName: "Oga's Cantina",
          resort: "WDW",
          park: "Hollywood Studios",
          land: "Star Wars: Galaxy’s Edge",
          lifecycle: "active",
        },
      ],
    },
  },
  {
    description: "Oga's Cantina with resort=DLR -> only the requested resort's variant",
    filters: { name: "Oga's Cantina", resort: "DLR" },
    expected: {
      ok: true,
      results: [
        {
          type: "dining",
          canonicalName: "Oga's Cantina",
          resort: "DLR",
          park: "Disneyland",
          land: "Star Wars: Galaxy’s Edge",
          lifecycle: "active",
        },
      ],
    },
  },
  {
    description: "type=experience + park=Hollywood Studios includes Savi's, Droid Depot, Olaf Draws!",
    filters: { type: "experience", park: "Hollywood Studios" },
    expected: {
      ok: true,
      results: [
        {
          type: "experience",
          canonicalName: "Savi's Workshop – Handbuilt Lightsabers",
          resort: "WDW",
          park: "Hollywood Studios",
          land: "Star Wars: Galaxy’s Edge",
          lifecycle: "active",
        },
        {
          type: "experience",
          canonicalName: "Droid Depot",
          resort: "WDW",
          park: "Hollywood Studios",
          land: "Star Wars: Galaxy’s Edge",
          lifecycle: "active",
        },
        {
          type: "experience",
          canonicalName: "Olaf Draws!",
          resort: "WDW",
          park: "Hollywood Studios",
          land: "Animation Courtyard",
          lifecycle: "active",
        },
      ],
    },
  },
  {
    description: "type=entertainment + park=Disneyland filtering (DLR-only rows, catalog order)",
    filters: { type: "entertainment", park: "Disneyland" },
    expected: {
      ok: true,
      results: ENTERTAINMENT_PLACES.filter((p) => p.resort === "DLR" && p.parkId === "disneyland").map(
        (p): CatalogResult => ({
          type: "entertainment",
          canonicalName: p.name,
          resort: p.resort,
          park: "Disneyland",
          ...(p.land ? { land: p.land } : {}),
          lifecycle: "active",
        }),
      ),
    },
  },
  // ---- CODEX P2 fix — resort-scoped alias resolution via park-derived
  // resort hint (no explicit `resort` supplied) ----
  {
    description: "CODEX P2: 'projection show' (WDW-only resort-scoped alias) + park=Hollywood Studios, no explicit resort -> resolves via park-derived resort hint",
    filters: { name: "projection show", park: "Hollywood Studios" },
    expected: {
      ok: true,
      results: [
        {
          type: "entertainment",
          canonicalName: "Wonderful World of Animation",
          resort: "WDW",
          park: "Hollywood Studios",
          land: "Hollywood Boulevard",
          lifecycle: "active",
        },
      ],
    },
  },
  {
    description: "CODEX P2: 'halloween parade' (resort-ambiguous alias) + park=Disney California Adventure, no explicit resort -> resolves the DLR variant via park-derived resort hint",
    filters: { name: "halloween parade", park: "Disney California Adventure" },
    expected: {
      ok: true,
      results: [
        {
          type: "entertainment",
          canonicalName: "Frightfully Fun Parade",
          resort: "DLR",
          park: "Disney California Adventure",
          land: "Paradise Gardens Park",
          lifecycle: "active",
        },
      ],
    },
  },
  {
    description: "CODEX P2: 'halloween parade' + explicit compatible resort=WDW + park=Magic Kingdom -> still resolves correctly (explicit resort path unaffected)",
    filters: { name: "halloween parade", resort: "WDW", park: "Magic Kingdom" },
    expected: {
      ok: true,
      results: [
        {
          type: "entertainment",
          canonicalName: "Mickey's Boo-To-You Halloween Parade",
          resort: "WDW",
          park: "Magic Kingdom",
          land: "Main Street, U.S.A.",
          lifecycle: "active",
        },
      ],
    },
  },
  {
    description: "CODEX P2: 'halloween parade' + explicit CONFLICTING resort=WDW + park=Disneyland (a DLR park) -> no silent park-derived override, yields no match rather than an error",
    filters: { name: "halloween parade", resort: "WDW", park: "Disneyland" },
    expected: { ok: true, results: [] },
  },
  {
    description: "type=dining + land=Star Wars: Galaxy's Edge (straight apostrophe) matches catalog's typographic apostrophe",
    filters: { type: "dining", land: "Star Wars: Galaxy's Edge" },
    expected: {
      ok: true,
      results: DINING_PLACES.filter((p) => p.land === "Star Wars: Galaxy’s Edge").map(
        (p): CatalogResult => ({
          type: "dining",
          canonicalName: p.name,
          resort: p.resort,
          ...(p.parkId ? { park: PARK_LABELS[p.parkId] } : {}),
          land: p.land as string,
          lifecycle: "active",
        }),
      ),
    },
  },
  {
    description: "unknown name -> clean empty result, not an error",
    filters: { name: "Some Made Up Place Nobody Has Heard Of" },
    expected: { ok: true, results: [] },
  },
  {
    description: "active-only behavior: legacy-only WDW 'Splash Mountain' (replaced by Tiana's Bayou Adventure) never appears",
    filters: { name: "Splash Mountain", resort: "WDW" },
    expected: { ok: true, results: [] },
  },
  {
    description: "intentional non-park dining metadata preserved (Napa Rose, Grand Californian Hotel) instead of inventing a park/land",
    filters: { name: "Napa Rose", resort: "DLR" },
    expected: {
      ok: true,
      results: [
        {
          type: "dining",
          canonicalName: "Napa Rose",
          resort: "DLR",
          nonParkLocation: "Disney's Grand Californian Hotel",
          lifecycle: "active",
        },
      ],
    },
  },
  {
    description: "invalid type filter is rejected",
    filters: { type: "snack" },
    expected: { ok: false, error: "Invalid type filter" },
  },
  {
    description: "invalid resort filter is rejected",
    filters: { resort: "FL" },
    expected: { ok: false, error: "Invalid resort filter" },
  },
  {
    description: "unrecognized park filter is rejected (small closed set, unlike free-form land)",
    filters: { park: "Not A Real Park" },
    expected: { ok: false, error: "Unknown park filter" },
  },
  {
    description: "empty name filter is rejected rather than treated as 'no filter'",
    filters: { name: "   " },
    expected: { ok: false, error: "name filter must not be empty" },
  },
];

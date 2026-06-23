/**
 * entertainmentSuggestions.ts — Phase 9.2 Entertainment Smart Entry recognition.
 *
 * Known scheduled entertainment across Disneyland Resort and Walt Disney
 * World: stage shows, parades, nighttime spectaculars, and major
 * theater-style entertainment guests commonly build itineraries around.
 * Deliberately excludes atmosphere performers, roaming characters,
 * temporary one-off entertainment, live showtime schedules, and dining
 * package products.
 *
 * Each entry carries lightweight metadata (resort + park/area label) so the
 * planner can show location context, plus an optional availabilityType so
 * future phases can identify recurring seasonal/holiday entertainment
 * without a data model redesign. availabilityType is data-only in Phase
 * 9.2 — it is stored but never rendered as a badge/warning/filter.
 *
 * isEntertainmentName() uses stage-1 (exact) + stage-3 (alias) matching
 * only — no whole-word containment stage. Unlike dining names, several
 * entertainment titles share leading words with well-known attractions
 * (e.g. "Indiana Jones" / "Indiana Jones Epic Stunt Spectacular", "Finding
 * Nemo" / "Finding Nemo: The Big Blue... and Beyond!"), so a containment
 * match would misclassify common attraction shorthand as entertainment.
 * Recognition is therefore deliberately conservative: only an exact title
 * or an explicit alias counts.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { normalizeKey, stripAnnotations } from "./plansMatching";

/**
 * Recurrence pattern for an entertainment offering. Data-only metadata in
 * Phase 9.2 — not surfaced in any UI (no badges, warnings, or filters).
 *   "regular"  — runs year-round / as part of the standard daily lineup.
 *   "seasonal" — tied to a recurring holiday/seasonal event (e.g. Halloween,
 *                Christmastime).
 *   "limited"  — runs only during specific limited-time engagements.
 */
export type EntertainmentAvailabilityType = "regular" | "seasonal" | "limited";

/**
 * Optional seasonal/holiday theme tag for entertainment with
 * availabilityType "seasonal" or "limited". Data-only, like
 * availabilityType — not surfaced in any UI yet. Lets future phases group
 * or label recurring holiday entertainment without re-deriving it from
 * free-text names.
 */
export type EntertainmentTheme = "halloween" | "christmas" | "anniversary";

export type EntertainmentPlace = {
  name: string;
  resort: ResortId;
  /** Park/area display label shown under the activity name. */
  location: string;
  /**
   * The theme park this entertainment is presented in — used for day park
   * inference alongside attractions and dining. Omitted only for offerings
   * with no single-park identity (none currently in this dataset).
   */
  parkId?: ParkId;
  /** Optional recurrence metadata — see EntertainmentAvailabilityType. */
  availabilityType?: EntertainmentAvailabilityType;
  /** Optional seasonal/holiday theme — see EntertainmentTheme. */
  availabilityTheme?: EntertainmentTheme;
};

export const ENTERTAINMENT_PLACES: EntertainmentPlace[] = [
  // ---- Disneyland Park / DCA ----
  { name: "Fantasmic!", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", availabilityType: "regular" },
  { name: "World of Color", resort: "DLR", location: "Disney California Adventure", parkId: "dca", availabilityType: "regular" },
  { name: "Wondrous Journeys", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", availabilityType: "regular" },
  { name: "Magic Happens Parade", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", availabilityType: "limited" },
  { name: "Enchanted Tiki Room", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", availabilityType: "regular" },
  { name: "Turtle Talk with Crush", resort: "DLR", location: "Disney California Adventure", parkId: "dca", availabilityType: "regular" },
  { name: "Paint the Night", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", availabilityType: "limited" },
  { name: "Halloween Screams", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", availabilityType: "seasonal", availabilityTheme: "halloween" },
  { name: "Believe... in Holiday Magic", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", availabilityType: "seasonal", availabilityTheme: "christmas" },
  { name: "A Christmas Fantasy Parade", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", availabilityType: "seasonal", availabilityTheme: "christmas" },
  { name: "Frightfully Fun Parade", resort: "DLR", location: "Disney California Adventure", parkId: "dca", availabilityType: "seasonal", availabilityTheme: "halloween" },
  { name: "Main Street Electrical Parade", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", availabilityType: "limited" },
  { name: "Royal Princess Cavalcade", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", availabilityType: "limited" },
  { name: "Together Forever — A Pixar Nighttime Spectacular", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", availabilityType: "limited" },
  { name: "Better Together: A Pixar Pals Celebration!", resort: "DLR", location: "Disney California Adventure", parkId: "dca", availabilityType: "limited" },

  // ---- Magic Kingdom ----
  { name: "Happily Ever After", resort: "WDW", location: "Magic Kingdom", parkId: "mk", availabilityType: "regular" },
  { name: "Disney Starlight: Dream the Night Away", resort: "WDW", location: "Magic Kingdom", parkId: "mk", availabilityType: "regular" },
  { name: "Festival of Fantasy Parade", resort: "WDW", location: "Magic Kingdom", parkId: "mk", availabilityType: "regular" },
  { name: "Mickey's PhilharMagic", resort: "WDW", location: "Magic Kingdom", parkId: "mk", availabilityType: "regular" },
  { name: "Enchanted Tiki Room", resort: "WDW", location: "Magic Kingdom", parkId: "mk", availabilityType: "regular" },
  { name: "Country Bear Musical Jamboree", resort: "WDW", location: "Magic Kingdom", parkId: "mk", availabilityType: "regular" },
  { name: "Disney Adventure Friends Cavalcade", resort: "WDW", location: "Magic Kingdom", parkId: "mk", availabilityType: "regular" },
  { name: "Mickey's Boo-To-You Halloween Parade", resort: "WDW", location: "Magic Kingdom", parkId: "mk", availabilityType: "seasonal", availabilityTheme: "halloween" },
  { name: "Mickey's Once Upon a Christmastime Parade", resort: "WDW", location: "Magic Kingdom", parkId: "mk", availabilityType: "seasonal", availabilityTheme: "christmas" },
  { name: "Disney's Not-So-Spooky Spectacular", resort: "WDW", location: "Magic Kingdom", parkId: "mk", availabilityType: "seasonal", availabilityTheme: "halloween" },
  { name: "Hocus Pocus Villain Spelltacular", resort: "WDW", location: "Magic Kingdom", parkId: "mk", availabilityType: "seasonal", availabilityTheme: "halloween" },
  { name: "Minnie's Wonderful Christmastime Fireworks", resort: "WDW", location: "Magic Kingdom", parkId: "mk", availabilityType: "seasonal", availabilityTheme: "christmas" },
  { name: "Mickey's Most Merriest Celebration", resort: "WDW", location: "Magic Kingdom", parkId: "mk", availabilityType: "seasonal", availabilityTheme: "christmas" },

  // ---- EPCOT ----
  { name: "Turtle Talk with Crush", resort: "WDW", location: "EPCOT", parkId: "epcot", availabilityType: "regular" },
  { name: "Luminous The Symphony of Us", resort: "WDW", location: "EPCOT", parkId: "epcot", availabilityType: "regular" },

  // ---- Hollywood Studios ----
  { name: "Fantasmic!", resort: "WDW", location: "Hollywood Studios", parkId: "hs", availabilityType: "regular" },
  { name: "Beauty and the Beast Live on Stage", resort: "WDW", location: "Hollywood Studios", parkId: "hs", availabilityType: "regular" },
  { name: "For the First Time in Forever: A Frozen Sing-Along Celebration", resort: "WDW", location: "Hollywood Studios", parkId: "hs", availabilityType: "regular" },
  { name: "Indiana Jones Epic Stunt Spectacular", resort: "WDW", location: "Hollywood Studios", parkId: "hs", availabilityType: "regular" },
  { name: "Wonderful World of Animation", resort: "WDW", location: "Hollywood Studios", parkId: "hs", availabilityType: "regular" },

  // ---- Animal Kingdom ----
  { name: "Festival of the Lion King", resort: "WDW", location: "Animal Kingdom", parkId: "ak", availabilityType: "regular" },
  { name: "Finding Nemo: The Big Blue... and Beyond!", resort: "WDW", location: "Animal Kingdom", parkId: "ak", availabilityType: "regular" },

  // ---- Galaxy's Edge experiences (DLR + WDW) ----
  { name: "Savi's Workshop – Handbuilt Lightsabers", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", availabilityType: "regular" },
  { name: "Savi's Workshop – Handbuilt Lightsabers", resort: "WDW", location: "Hollywood Studios", parkId: "hs", availabilityType: "regular" },
  { name: "Droid Depot", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", availabilityType: "regular" },
  { name: "Droid Depot", resort: "WDW", location: "Hollywood Studios", parkId: "hs", availabilityType: "regular" },
];

const ENTERTAINMENT_KEYS: Set<string> = new Set(
  ENTERTAINMENT_PLACES.map((p) => normalizeKey(p.name)),
);

// Phase 9.3.5 — per-resort canonical key sets, used to validate that a
// resolved key actually has an offering at the requested resort before
// returning it (e.g. "Happily Ever After" exists only at WDW, so it must
// not resolve when resort="DLR" is passed).
const ENTERTAINMENT_KEYS_BY_RESORT: Record<ResortId, Set<string>> = {
  DLR: new Set(ENTERTAINMENT_PLACES.filter((p) => p.resort === "DLR").map((p) => normalizeKey(p.name))),
  WDW: new Set(ENTERTAINMENT_PLACES.filter((p) => p.resort === "WDW").map((p) => normalizeKey(p.name))),
};

/**
 * Manual alias map for common guest-entered entertainment shorthand that is
 * unambiguous regardless of resort — mirrors DINING_ALIASES in
 * diningSuggestions.ts (no fuzzy matching, just an explicit lookup table).
 *
 * Keys:   normalizeKey() output of the user-entered alias.
 * Values: normalizeKey() output of the canonical ENTERTAINMENT_PLACES name.
 *
 * Generic shorthand that could plausibly mean a different show at each
 * resort (e.g. "Halloween Parade") is deliberately NOT here — see
 * ENTERTAINMENT_ALIASES_BY_RESORT below.
 */
const ENTERTAINMENT_ALIASES: Record<string, string> = {
  "hea": "happily ever after",
  "fotlk": "festival of the lion king",
  "fantasmic": "fantasmic",
  "frozen sing along": "for the first time in forever a frozen sing along celebration",
  "starlight": "disney starlight dream the night away",
  "disney starlight": "disney starlight dream the night away",
  "boo to you": "mickeys boo to you halloween parade",
  "christmastime parade": "mickeys once upon a christmastime parade",
  "tiki room": "enchanted tiki room",
  "country bear jamboree": "country bear musical jamboree",
  "fotf": "festival of fantasy parade",
  "magic happens": "magic happens parade",
  "adventure friends cavalcade": "disney adventure friends cavalcade",
  "disney adventure friends": "disney adventure friends cavalcade",
  "not so spooky": "disneys not so spooky spectacular",
  "not so spooky fireworks": "disneys not so spooky spectacular",
  "hocus pocus": "hocus pocus villain spelltacular",
  "villain spelltacular": "hocus pocus villain spelltacular",
  "christmastime fireworks": "minnies wonderful christmastime fireworks",
  "minnies fireworks": "minnies wonderful christmastime fireworks",
  "most merriest celebration": "mickeys most merriest celebration",
  "oogie boogie parade": "frightfully fun parade",
  "together forever": "together forever a pixar nighttime spectacular",
  "pixar nighttime spectacular": "together forever a pixar nighttime spectacular",
  "better together": "better together a pixar pals celebration",
  "pixar pals celebration": "better together a pixar pals celebration",
  "luminous": "luminous the symphony of us",
  "symphony of us": "luminous the symphony of us",
  "luminous symphony": "luminous the symphony of us",
  "wwoa": "wonderful world of animation",
  "hollywood studios projection show": "wonderful world of animation",
  "dhs projection show": "wonderful world of animation",
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
 * Resort-scoped alias overrides for shorthand that is genuinely ambiguous
 * across resorts (the same generic phrase names a different DLR vs. WDW
 * show). Only consulted when a resort is supplied to resolveEntertainmentKey
 * — with no resort, these intentionally do not match (no match beats a
 * wrong-resort guess).
 */
const ENTERTAINMENT_ALIASES_BY_RESORT: Record<ResortId, Record<string, string>> = {
  DLR: {
    "halloween parade": "frightfully fun parade",
    "halloween fireworks": "halloween screams",
    "christmas fireworks": "believe in holiday magic",
  },
  WDW: {
    "halloween parade": "mickeys boo to you halloween parade",
    "halloween fireworks": "disneys not so spooky spectacular",
    "christmas fireworks": "minnies wonderful christmastime fireworks",
    "projection show": "wonderful world of animation",
  },
};

/**
 * Strip a disambiguation suffix appended by getEntertainmentSuggestions(),
 * e.g. "Fantasmic! — Hollywood Studios" → "Fantasmic!". No-op when absent.
 * Kept local to entertainment, mirroring stripDiningSuffix().
 */
function stripEntertainmentSuffix(str: string): string {
  const idx = str.indexOf(" — ");
  return idx === -1 ? str : str.slice(0, idx);
}

/**
 * Resolve a (possibly aliased) name to its canonical ENTERTAINMENT_KEYS
 * entry. Single source of truth for entertainment recognition — every
 * consumer (isEntertainmentName, getEntertainmentLocation, park/day
 * inference) resolves through this function.
 *
 * Stage 1: exact normalized match.
 * Stage 3: alias lookup — resort-unambiguous aliases first, then (only when
 *          resort is supplied) the resort-scoped alias overrides.
 *
 * When resort is supplied, the resolved key is validated against
 * ENTERTAINMENT_KEYS_BY_RESORT before being returned — e.g. "Happily Ever
 * After" or "Cinderella's Royal Table"-style WDW-only names must not resolve
 * for resort="DLR" (and vice versa). Without a resort, validation is skipped
 * and any resort-unambiguous match resolves, preserving existing ambiguous
 * lookup behavior.
 *
 * Deliberately no whole-word containment stage (unlike resolveDiningKey) —
 * see the module doc comment for why: it would let attraction shorthand
 * like "Indiana Jones" or "Finding Nemo" resolve as entertainment.
 * Returns null when nothing resolves.
 */
export function resolveEntertainmentKey(name: string, resort?: ResortId): string | null {
  const key = normalizeKey(stripAnnotations(stripEntertainmentSuffix(name)));

  let candidate: string | null = null;
  if (ENTERTAINMENT_KEYS.has(key)) {
    candidate = key;
  } else {
    const aliasTarget = ENTERTAINMENT_ALIASES[key];
    if (aliasTarget && ENTERTAINMENT_KEYS.has(aliasTarget)) {
      candidate = aliasTarget;
    } else if (resort) {
      const resortAliasTarget = ENTERTAINMENT_ALIASES_BY_RESORT[resort][key];
      if (resortAliasTarget && ENTERTAINMENT_KEYS.has(resortAliasTarget)) candidate = resortAliasTarget;
    }
  }

  if (!candidate) return null;
  if (resort && !ENTERTAINMENT_KEYS_BY_RESORT[resort].has(candidate)) return null;
  return candidate;
}

/**
 * True when the given activity name matches a known entertainment offering
 * (exact or alias — see resolveEntertainmentKey). Pass resort when known so
 * resort-scoped aliases (e.g. "Halloween Parade") resolve correctly; without
 * it, only resort-unambiguous names/aliases match.
 */
export function isEntertainmentName(name: string, resort?: ResortId): boolean {
  return resolveEntertainmentKey(name, resort) !== null;
}

/**
 * Autocomplete suggestion list, scoped to the active resort (mirrors
 * getDiningSuggestions()). Names that exist at both resorts under different
 * locations (e.g. Fantasmic!) are disambiguated with " — <location>" only
 * when more than one distinct location remains within the scoped list.
 */
export function getEntertainmentSuggestions(resort: ResortId): string[] {
  const scoped = ENTERTAINMENT_PLACES.filter((p) => p.resort === resort);
  const byKey = new Map<string, EntertainmentPlace[]>();
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

/**
 * Resolve the display location label for an entertainment item's current
 * name, preferring a match within the active resort, falling back to any
 * resort. Returns undefined for unknown/custom names.
 */
export function getEntertainmentLocation(name: string, resort: ResortId): string | undefined {
  const key = resolveEntertainmentKey(name, resort);
  if (!key) return undefined;
  const matches = ENTERTAINMENT_PLACES.filter((p) => normalizeKey(p.name) === key);
  if (matches.length === 0) return undefined;
  return (matches.find((p) => p.resort === resort) ?? matches[0]).location;
}

/**
 * Resolve the canonical display name for an entertainment item's current
 * name, preferring a match within the active resort, falling back to any
 * resort. Returns undefined for unknown/custom names.
 */
export function getEntertainmentCanonicalName(name: string, resort: ResortId): string | undefined {
  const key = resolveEntertainmentKey(name, resort);
  if (!key) return undefined;
  const matches = ENTERTAINMENT_PLACES.filter((p) => normalizeKey(p.name) === key);
  if (matches.length === 0) return undefined;
  return (matches.find((p) => p.resort === resort) ?? matches[0]).name;
}

/**
 * Resolve the availabilityType metadata for an entertainment item's current
 * name. Data-only in Phase 9.2 — no consumer renders this yet. Preferring a
 * match within the active resort, falling back to any resort. Returns
 * undefined for unknown/custom names.
 */
export function getEntertainmentAvailabilityType(
  name: string,
  resort: ResortId,
): EntertainmentAvailabilityType | undefined {
  const key = resolveEntertainmentKey(name, resort);
  if (!key) return undefined;
  const matches = ENTERTAINMENT_PLACES.filter((p) => normalizeKey(p.name) === key);
  if (matches.length === 0) return undefined;
  return (matches.find((p) => p.resort === resort) ?? matches[0]).availabilityType;
}

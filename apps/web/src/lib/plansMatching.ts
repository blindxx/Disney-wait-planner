/**
 * plansMatching.ts — Shared name-matching + alias logic for the My Plans overlay.
 *
 * Single source of truth for:
 *   normalizeKey()               — stable lookup key from a raw name
 *   tokenize() / containsWholeWordSequence() — stage-2 containment check
 *   stripAnnotations()           — strip "(flex window)", "[rope drop]", etc.
 *   ALIASES_DLR / ALIASES_WDW   — resort-specific shorthand maps (incl. DCA)
 *   lookupWait()                 — 3-stage deterministic wait resolution
 *   devResolvePlanAlias()        — dev-only alias inspector
 *   DEV_PLAN_ALIAS_CASES         — dev-only validation test cases
 *
 * Normalization rules (conservative, must not break existing matches):
 *   - Lowercase + trim + collapse whitespace
 *   - Remove apostrophes (typographic and ASCII) — "Tiana's" → "tianas"
 *   - Replace all remaining non-alphanumeric chars with a space
 *   - "&" and "and" are both preserved as-is after the above (they become
 *     " " via non-alphanumeric rule for "&" specifically), then collapsed.
 *
 * Thresholds / badge logic are NOT here — see waitBadge.ts.
 */

import type { ResortId } from "@disney-wait-planner/shared";

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an attraction or plan item name to a stable lookup key.
 *   - Lowercase + trim
 *   - Remove apostrophes (typographic and ASCII) so "Tiana's" → "tianas"
 *   - Replace all remaining non-alphanumeric characters with a space
 *   - Collapse duplicate spaces
 */
export function normalizeKey(str: string): string {
  return str
    .trim()
    .toLowerCase()
    .replace(/['\u2019\u2018]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set(["the", "of", "and", "a", "an", "to", "at"]);

/** Tokens from a normalized key with stop words removed. */
export function tokenize(key: string): string[] {
  return key.split(" ").filter((t) => t && !STOP_WORDS.has(t));
}

/**
 * Stage-2 containment check.
 * True when planTokens appear as a whole-word sequence inside the
 * stop-word-filtered version of attrKey (prefix or interior match).
 * Caller must ensure planTokens.length >= 2.
 */
export function containsWholeWordSequence(
  attrKey: string,
  planTokens: string[],
): boolean {
  const planStr = planTokens.join(" ");
  const attrFiltered = attrKey
    .split(" ")
    .filter((t) => t && !STOP_WORDS.has(t))
    .join(" ");
  return (" " + attrFiltered + " ").includes(" " + planStr + " ");
}

/**
 * Strip parenthetical and bracket annotations before matching.
 * Applied only to the plan item key — never to displayed content.
 * "Haunted Mansion (flex window)"  → "Haunted Mansion"
 * "[rope drop] Space Mountain"     → "Space Mountain"
 */
export function stripAnnotations(str: string): string {
  return str
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Alias maps
// ---------------------------------------------------------------------------

/**
 * Manual alias map for DLR — acronyms and common shorthands.
 * Covers both Disneyland Park (DL) and Disney California Adventure (DCA).
 *
 * Keys:   normalizeKey() output of the user-entered alias.
 * Values: normalizeKey() output of the canonical mock attraction name.
 */
export const ALIASES_DLR: Record<string, string> = {
  // ---- Acronyms ----
  rotr:  "star wars rise of the resistance",
  mmrr:  "mickey minnies runaway railway",
  btmrr: "big thunder mountain railroad",
  btmr:  "big thunder mountain railroad",
  potc:  "pirates of the caribbean",
  iasw:  "its a small world",
  mfsr:  "millennium falcon smugglers run",
  hm:    "haunted mansion",
  jc:    "jungle cruise",
  sm:    "space mountain",
  gotg:  "guardians of the galaxy mission breakout",
  tsmm:  "toy story midway mania",
  rac:   "radiator springs racers",
  rsr:   "radiator springs racers",           // RSR acronym (DCA)
  web:   "web slingers a spider man adventure",
  grr:   "grizzly river run",

  // ---- Common shorthands (Disneyland Park) ----
  "pirates":                     "pirates of the caribbean",
  "guardians":                   "guardians of the galaxy mission breakout",
  "big thunder":                 "big thunder mountain railroad",
  "thunder mountain":            "big thunder mountain railroad",
  "runaway railway":             "mickey minnies runaway railway",
  "guardians mission breakout":  "guardians of the galaxy mission breakout",
  "guardians breakout":          "guardians of the galaxy mission breakout",
  "rise":                        "star wars rise of the resistance",
  "smuggler":                    "millennium falcon smugglers run",
  "smugglers":                   "millennium falcon smugglers run",
  "smugglers run":               "millennium falcon smugglers run",

  // ---- Monsters, Inc. Mike & Sulley to the Rescue! (DCA) ----
  // normalizeKey strips "," "." "&" → "monsters inc mike sulley to the rescue"
  "monsters":                    "monsters inc mike sulley to the rescue",
  "monsters inc":                "monsters inc mike sulley to the rescue",
  "mike sulley":                 "monsters inc mike sulley to the rescue",

  // ---- Radiator Springs Racers (DCA) ----
  // "rac" + "rsr" already covered above via acronyms

  // ---- WEB SLINGERS: A Spider-Man Adventure (DCA) ----
  // normalizeKey: "web slingers: a spider-man adventure" → "web slingers a spider man adventure"
  "web slinger":                 "web slingers a spider man adventure",
  "webslingers":                 "web slingers a spider man adventure",
  "spider man":                  "web slingers a spider man adventure",

  // ---- Soarin' Around the World (DCA) ----
  // normalizeKey strips apostrophe: "soarin'" → "soarin"
  "soarin":                      "soarin around the world",
  "soarin over california":      "soarin around the world", // legacy DCA name

  // ---- Tiana's Bayou Adventure (DL Bayou Country) — cross-resort parity ----
  // Single token "tiana" cannot reach stage-2 (≥2 tokens required); alias needed.
  "tiana":                       "tianas bayou adventure",
  "tianas bayou":                "tianas bayou adventure",

  // ---- Single-token shorthands that can't hit stage-2 ----
  "indy":                        "indiana jones adventure",   // Indiana Jones™ Adventure
  "matterhorn":                  "matterhorn bobsleds",
  "pinocchio":                   "pinocchios daring journey", // Pinocchio's Daring Journey
  "toad":                        "mr toads wild ride",        // Mr. Toad's Wild Ride
  "pooh":                        "the many adventures of winnie the pooh",
  "mermaid":                     "the little mermaid ariels undersea adventure", // DCA

  // ---- Possessive-s shorthands (stage-2 won't match "rabbit" → "rabbits …") ----
  "peter pan":                   "peter pans flight",         // Peter Pan's Flight
  "snow white":                  "snow whites enchanted wish", // Snow White's Enchanted Wish
  "mr toad":                     "mr toads wild ride",
  "roger rabbit":                "roger rabbits car toon spin",

  // ---- The Little Mermaid (DCA) — explicit for discoverability ----
  "little mermaid":              "the little mermaid ariels undersea adventure",

  // ---- WEB SLINGERS two-word form ----
  "web slingers":                "web slingers a spider man adventure",

  // ---- Mickey & Minnie's Runaway Railway variants ----
  // "mickey & minnie" normalizes to "mickey minnie" (& → space, collapse)
  "mickey and minnie":           "mickey minnies runaway railway",
  "mickey minnie":               "mickey minnies runaway railway",
  "mickey minnies":              "mickey minnies runaway railway",

  // ---- Single-token ride names that can't hit stage-2 ----
  "dumbo":                       "dumbo the flying elephant",
  "space":                       "space mountain",
  "buzz":                        "buzz lightyear astro blasters",  // Buzz Lightyear Astro Blasters (DL)
};

/**
 * Manual alias map for WDW — acronyms and common shorthands.
 * Separate from ALIASES_DLR — never merged. Values must match normalizeKey()
 * output of WDW mock ride names.
 */
export const ALIASES_WDW: Record<string, string> = {
  // ---- Acronyms ----
  fop:   "avatar flight of passage",
  rotr:  "star wars rise of the resistance",
  mmrr:  "mickey minnies runaway railway",
  btmrr: "big thunder mountain railroad",
  btmr:  "big thunder mountain railroad",
  hm:    "haunted mansion",
  tott:  "the twilight zone tower of terror",
  tot:   "the twilight zone tower of terror",
  nrj:   "navi river journey",
  mfsr:  "millennium falcon smugglers run",
  rnr:   "rock n roller coaster starring aerosmith",  // Rock 'n' Roller Coaster

  // ---- Common shorthands ----
  "flight of passage":           "avatar flight of passage",
  "everest":                     "expedition everest",
  "expedition":                  "expedition everest",           // single-word shorthand
  "safaris":                     "kilimanjaro safaris",
  "cosmic rewind":               "guardians of the galaxy cosmic rewind",
  "guardians":                   "guardians of the galaxy cosmic rewind",
  "slinky":                      "slinky dog dash",
  "slinky dog":                  "slinky dog dash",
  "frozen":                      "frozen ever after",
  "ratatouille":                 "remys ratatouille adventure",
  "ratatouillie":                "remys ratatouille adventure",  // common misspelling
  "ratatoullie":                 "remys ratatouille adventure",  // common misspelling
  "remy":                        "remys ratatouille adventure",
  "remys":                       "remys ratatouille adventure",
  "remy ratatouille":            "remys ratatouille adventure",
  "remys ratatouille":           "remys ratatouille adventure",
  "tower of terror":             "the twilight zone tower of terror",

  // ---- Rock 'n' Roller Coaster Starring Aerosmith (HS) ----
  // normalizeKey strips apostrophes → "rock n roller coaster starring aerosmith"
  "rock n roller":               "rock n roller coaster starring aerosmith",
  "rock n roller coaster":       "rock n roller coaster starring aerosmith",
  "rock and roller":             "rock n roller coaster starring aerosmith",
  "rock and roller coaster":     "rock n roller coaster starring aerosmith",
  "aerosmith":                   "rock n roller coaster starring aerosmith",

  "rise":                        "star wars rise of the resistance",
  "smugglers run":               "millennium falcon smugglers run",
  "runaway railway":             "mickey minnies runaway railway",

  // ---- Journey Into Imagination With Figment (EPCOT World Celebration) ----
  // "figment" is a single token — stage-2 can't reach it without an alias.
  "figment":                     "journey into imagination with figment",
  "journey into imagination":    "journey into imagination with figment",

  // ---- TRON Lightcycle / Run (MK Tomorrowland) ----
  // normalizeKey: "/" → space → "tron lightcycle run"
  "tron":                        "tron lightcycle run",
  "tron lightcycle":             "tron lightcycle run",
  "lightcycle":                  "tron lightcycle run",

  // ---- Seven Dwarfs Mine Train (MK Fantasyland) ----
  "seven dwarfs":                "seven dwarfs mine train",
  "mine train":                  "seven dwarfs mine train",

  // ---- Cross-resort shorthand parity (same key as ALIASES_DLR, WDW canonical) ----
  "pirates":                     "pirates of the caribbean",          // MK Adventureland
  "smuggler":                    "millennium falcon smugglers run",    // HS Galaxy's Edge
  "smugglers":                   "millennium falcon smugglers run",    // HS Galaxy's Edge
  "big thunder":                 "big thunder mountain railroad",      // MK Frontierland
  "thunder mountain":            "big thunder mountain railroad",      // MK Frontierland
  "soarin":                      "soarin around the world",           // EPCOT World Nature

  // ---- Tiana's Bayou Adventure (MK Frontierland) — cross-resort parity ----
  "tiana":                       "tianas bayou adventure",
  "tianas bayou":                "tianas bayou adventure",

  // ---- Possessive-s shorthands ----
  // stage-2 won't match "peter pan" into "peter pans flight" ("pans" ≠ "pan")
  "peter pan":                   "peter pans flight",                 // MK Fantasyland
  "pooh":                        "the many adventures of winnie the pooh", // MK Fantasyland

  // ---- Animal Kingdom ----
  "kali":                        "kali river rapids",                 // AK Asia
  "kali river":                  "kali river rapids",
  "navi river":                  "navi river journey",                // AK Pandora

  // ---- MK Tomorrowland ----
  // "peoplemover" is a single token → stage-2 fails (only 1 meaningful token).
  "peoplemover":                 "tomorrowland transit authority peoplemover",

  // ---- EPCOT World Showcase ----
  "gran fiesta":                 "gran fiesta tour starring the three caballeros",
  "three caballeros":            "gran fiesta tour starring the three caballeros",

  // ---- MK Fantasyland ----
  // "mermaid" alone is a single token → needs alias
  "mermaid":                     "under the sea journey of the little mermaid",

  // ---- Mickey & Minnie's Runaway Railway variants ----
  // "mickey & minnie" normalizes to "mickey minnie" (& → space, collapse)
  "mickey and minnie":           "mickey minnies runaway railway",
  "mickey minnie":               "mickey minnies runaway railway",
  "mickey minnies":              "mickey minnies runaway railway",

  // ---- Single-token ride names that can't hit stage-2 ----
  "dumbo":                       "dumbo the flying elephant",         // MK Fantasyland
  "spaceship":                   "spaceship earth",                   // EPCOT World Celebration
  "space":                       "space mountain",                    // MK Tomorrowland
  "buzz":                        "buzz lightyears space ranger spin", // Buzz Lightyear's Space Ranger Spin (MK)

  // ---- The Barnstormer (MK Fantasyland) ----
  // "the barnstormer" is an exact stage-1 match; "barnstormer" needs this alias.
  "barnstormer":                 "the barnstormer",

  // ---- Seven Dwarfs Mine Train — additional acronym/shorthand ----
  // "seven dwarfs" already present above; add acronym + numeric form.
  sdmt:                          "seven dwarfs mine train",
  "7 dwarfs":                    "seven dwarfs mine train",

  // ---- Magic Carpets of Aladdin (MK Adventureland) ----
  "aladdin":                     "magic carpets of aladdin",
  "magic carpet":                "magic carpets of aladdin",
  "magic carpets":               "magic carpets of aladdin",
};

// ---------------------------------------------------------------------------
// Wait lookup
// ---------------------------------------------------------------------------

export type WaitEntry = {
  status: string;
  waitMins: number | null;
  canonicalName: string;
};

/**
 * 3-stage deterministic wait lookup for a plan item name.
 * Order: Stage 1 (exact) → Stage 3 (alias) → Stage 2 (containment).
 * Parenthetical/bracket annotations are stripped before matching.
 * Returns null on no match or ambiguous containment.
 */
export function lookupWait(
  planName: string,
  waitMap: Map<string, WaitEntry>,
  aliases: Record<string, string>,
): WaitEntry | null {
  // Strip annotations (flex windows, labels, etc.) before normalizing
  const planKey = normalizeKey(stripAnnotations(planName));

  // Stage 1: exact normalized match
  const exact = waitMap.get(planKey);
  if (exact) return exact;

  // Stage 3: manual alias lookup.
  // Conservative fallback: if planKey starts with "the ", also check aliases
  // for the key with "the " stripped (e.g. "the barnstormer" → "barnstormer").
  // Stage 1 always runs first, so canonical keys that begin with "the" (like
  // "the barnstormer") are already found via exact match without stripping.
  const aliasTarget =
    aliases[planKey] ??
    (planKey.startsWith("the ") ? aliases[planKey.slice(4)] : undefined);
  if (aliasTarget) {
    const aliasResult = waitMap.get(aliasTarget);
    if (aliasResult) return aliasResult;
  }

  // Stage 2: whole-word containment (≥2 meaningful tokens required)
  const planTokens = tokenize(planKey);
  if (planTokens.length < 2) return null;

  const matches: WaitEntry[] = [];
  for (const [attrKey, info] of waitMap) {
    if (containsWholeWordSequence(attrKey, planTokens)) {
      matches.push(info);
    }
  }

  // Ambiguous → fail silently
  if (matches.length !== 1) return null;
  return matches[0];
}

// ---------------------------------------------------------------------------
// Dev-only validation
// ---------------------------------------------------------------------------

/**
 * Resolve a raw plan item name to its canonical normalized key (dev utility).
 * Applies normalizeKey + alias lookup exactly as lookupWait does in Stage 1/3.
 * Does NOT verify the key exists in the waitMap — use for alias inspection only.
 *
 * Usage in browser DevTools (Plans page must be mounted):
 *   import("/plans").then(m => /* not possible from client pages *\/)
 *   // Instead, inspect via DEV_PLAN_ALIAS_CASES at module load time.
 */
export function devResolvePlanAlias(input: string, resort: ResortId): string {
  const aliases = resort === "DLR" ? ALIASES_DLR : ALIASES_WDW;
  const key = normalizeKey(stripAnnotations(input));
  return aliases[key] ?? key;
}

/**
 * Reference test cases for alias resolution.
 * DLR (incl. DCA): 8 cases — monsters, RSR, Web Slingers, Soarin'.
 * WDW:             8 cases — Everest, Rock 'n' Roller, Tower of Terror, "the"-prefix.
 *
 * Run from Node:
 *   import { DEV_PLAN_ALIAS_CASES, devResolvePlanAlias } from "@/lib/plansMatching";
 *   DEV_PLAN_ALIAS_CASES.forEach(c => {
 *     const got = devResolvePlanAlias(c.input, c.resort);
 *     console.log(got === c.expectedKey ? "✓" : "✗ FAIL", c.input, "→", got);
 *   });
 */
export const DEV_PLAN_ALIAS_CASES: Array<{
  input: string;
  resort: ResortId;
  expectedKey: string;
}> = [
  // DLR / DCA
  { input: "monsters",               resort: "DLR", expectedKey: "monsters inc mike sulley to the rescue" },
  { input: "monsters inc",           resort: "DLR", expectedKey: "monsters inc mike sulley to the rescue" },
  { input: "rsr",                    resort: "DLR", expectedKey: "radiator springs racers" },
  { input: "web slinger",            resort: "DLR", expectedKey: "web slingers a spider man adventure" },
  { input: "webslingers",            resort: "DLR", expectedKey: "web slingers a spider man adventure" },
  { input: "soarin",                 resort: "DLR", expectedKey: "soarin around the world" },
  { input: "soarin'",                resort: "DLR", expectedKey: "soarin around the world" }, // apostrophe stripped
  { input: "soarin over california", resort: "DLR", expectedKey: "soarin around the world" }, // legacy name
  // WDW
  { input: "everest",                resort: "WDW", expectedKey: "expedition everest" },
  { input: "expedition",             resort: "WDW", expectedKey: "expedition everest" },
  { input: "rock n roller",          resort: "WDW", expectedKey: "rock n roller coaster starring aerosmith" },
  { input: "rock and roller",        resort: "WDW", expectedKey: "rock n roller coaster starring aerosmith" },
  { input: "aerosmith",              resort: "WDW", expectedKey: "rock n roller coaster starring aerosmith" },
  { input: "tower of terror",        resort: "WDW", expectedKey: "the twilight zone tower of terror" },
  { input: "The Twilight Zone Tower of Terror", resort: "WDW", expectedKey: "the twilight zone tower of terror" },
  { input: "the haunted mansion",    resort: "WDW", expectedKey: "the haunted mansion" }, // exact match in waitMap
  // --- WDW: figment + new additions ---
  { input: "figment",               resort: "WDW", expectedKey: "journey into imagination with figment" },
  { input: "journey into imagination", resort: "WDW", expectedKey: "journey into imagination with figment" },
  { input: "tron",                  resort: "WDW", expectedKey: "tron lightcycle run" },
  { input: "tron lightcycle",       resort: "WDW", expectedKey: "tron lightcycle run" },
  { input: "seven dwarfs",          resort: "WDW", expectedKey: "seven dwarfs mine train" },
  { input: "pirates",               resort: "WDW", expectedKey: "pirates of the caribbean" },
  { input: "tiana",                 resort: "WDW", expectedKey: "tianas bayou adventure" },
  { input: "kali",                  resort: "WDW", expectedKey: "kali river rapids" },
  { input: "peoplemover",           resort: "WDW", expectedKey: "tomorrowland transit authority peoplemover" },
  { input: "gran fiesta",           resort: "WDW", expectedKey: "gran fiesta tour starring the three caballeros" },
  { input: "soarin",                resort: "WDW", expectedKey: "soarin around the world" }, // EPCOT
  // --- DLR: new additions ---
  { input: "indy",                  resort: "DLR", expectedKey: "indiana jones adventure" },
  { input: "matterhorn",            resort: "DLR", expectedKey: "matterhorn bobsleds" },
  { input: "tiana",                 resort: "DLR", expectedKey: "tianas bayou adventure" },
  { input: "peter pan",             resort: "DLR", expectedKey: "peter pans flight" },
  { input: "snow white",            resort: "DLR", expectedKey: "snow whites enchanted wish" },
  { input: "mr toad",               resort: "DLR", expectedKey: "mr toads wild ride" },
  { input: "pinocchio",             resort: "DLR", expectedKey: "pinocchios daring journey" },
  { input: "roger rabbit",          resort: "DLR", expectedKey: "roger rabbits car toon spin" },
  { input: "pooh",                  resort: "DLR", expectedKey: "the many adventures of winnie the pooh" },
  { input: "mermaid",               resort: "DLR", expectedKey: "the little mermaid ariels undersea adventure" },
  // --- Targeted patch: DLR ---
  { input: "mickey and minnie",     resort: "DLR", expectedKey: "mickey minnies runaway railway" },
  { input: "mickey & minnie",       resort: "DLR", expectedKey: "mickey minnies runaway railway" }, // normalizes to "mickey minnie"
  { input: "dumbo",                 resort: "DLR", expectedKey: "dumbo the flying elephant" },
  { input: "space",                 resort: "DLR", expectedKey: "space mountain" },
  { input: "buzz",                  resort: "DLR", expectedKey: "buzz lightyear astro blasters" },
  // --- Targeted patch: WDW ---
  { input: "mickey and minnie",     resort: "WDW", expectedKey: "mickey minnies runaway railway" },
  { input: "dumbo",                 resort: "WDW", expectedKey: "dumbo the flying elephant" },
  { input: "spaceship",             resort: "WDW", expectedKey: "spaceship earth" },
  { input: "space",                 resort: "WDW", expectedKey: "space mountain" },
  { input: "buzz",                  resort: "WDW", expectedKey: "buzz lightyears space ranger spin" },
  { input: "barnstormer",           resort: "WDW", expectedKey: "the barnstormer" },
  { input: "sdmt",                  resort: "WDW", expectedKey: "seven dwarfs mine train" },
  { input: "7 dwarfs",              resort: "WDW", expectedKey: "seven dwarfs mine train" },
  { input: "aladdin",               resort: "WDW", expectedKey: "magic carpets of aladdin" },
  { input: "magic carpet",          resort: "WDW", expectedKey: "magic carpets of aladdin" },
];

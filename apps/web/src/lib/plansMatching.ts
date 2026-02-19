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

  // Stage 3: manual alias lookup
  const aliasTarget = aliases[planKey];
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
];

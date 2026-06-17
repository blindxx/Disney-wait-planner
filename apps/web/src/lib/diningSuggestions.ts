/**
 * diningSuggestions.ts — Phase 9.1 Dining Smart Entry recognition.
 *
 * Known dining locations across Disneyland Resort and Walt Disney World.
 * Covers major table-service restaurants plus destination-style quick-service
 * locations guests commonly build itineraries around. Deliberately excludes
 * Starbucks, Joffrey's, carts, kiosks, festival booths, and other transient
 * snack/food locations that aren't planned as standalone activities.
 *
 * isDiningName() mirrors the stage-1 (exact) + stage-2 (whole-word
 * containment) logic used by lookupWait() in plansMatching.ts, so a known
 * dining name is recognized the same way attraction names already are.
 */

import {
  normalizeKey,
  stripAnnotations,
  tokenize,
  containsWholeWordSequence,
} from "./plansMatching";
import type { PlannerItemType } from "./plansTransfer";

export const DINING_PLACE_NAMES: string[] = [
  // ---- Disneyland Park / DCA — table service ----
  "Blue Bayou Restaurant",
  "Carthay Circle Restaurant",
  "Napa Rose",
  "Storytellers Cafe",
  "Steakhouse 55",
  "Cafe Orleans",
  "Plaza Inn",
  "Lamplight Lounge",
  "Story Book Dining at Artist Point",

  // ---- Disneyland Park / DCA — destination-style quick service ----
  "Bengal Barbecue",
  "Galactic Grill",
  "Award Wieners",
  "Pym Test Kitchen",
  "Smokejumpers Grill",
  "Tropical Hideaway",
  "Red Rose Taverne",
  "Ronto Roasters",
  "Docking Bay 7 Food and Cargo",
  "Oga's Cantina",

  // ---- Downtown Disney (Anaheim) ----
  "Naples Ristorante e Bar",
  "Black Tap",
  "Salt & Straw",

  // ---- Magic Kingdom — table service ----
  "Be Our Guest Restaurant",
  "Cinderella's Royal Table",
  "Liberty Tree Tavern",
  "Tony's Town Square Restaurant",
  "The Crystal Palace",
  "Skipper Canteen",

  // ---- Magic Kingdom — destination-style quick service ----
  "Cosmic Ray's Starlight Cafe",
  "Pecos Bill Tall Tale Inn and Cafe",
  "Columbia Harbour House",
  "Pinocchio Village Haus",

  // ---- EPCOT ----
  "Topolino's Terrace",
  "Space 220",
  "Le Cellier Steakhouse",
  "Akershus Royal Banquet Hall",
  "Garden Grill",
  "Sunshine Seasons",

  // ---- Hollywood Studios ----
  "Sci-Fi Dine-In Theater Restaurant",
  "50's Prime Time Cafe",
  "Hollywood Brown Derby",
  "Mama Melrose's Ristorante Italiano",
  "Roundup Rodeo BBQ",
  "Backlot Express",
  "Woody's Lunch Box",
  "Docking Bay 7 Food and Cargo",
  "Ronto Roasters",
  "ABC Commissary",

  // ---- Animal Kingdom ----
  "Tiffins",
  "Tusker House",
  "Yak & Yeti Restaurant",
  "Satu'li Canteen",
  "Flame Tree Barbecue",
  "Regal Eagle Smokehouse",

  // ---- Disney Springs ----
  "Chef Art Smith's Homecomin'",
  "Wine Bar George",
  "The BOATHOUSE",
  "Morimoto Asia",
  "Jaleo",
  "Raglan Road",
  "STK Orlando",
  "Summer House on the Lake",
  "Gideon's Bakehouse",
  "Earl of Sandwich",
  "D-Luxe Burger",
  "Chicken Guy!",
  "Din Tai Fung",
  "Jock Lindsey's Hangar Bar",

  // ---- Major WDW resorts ----
  "Chef Mickey's",
  "California Grill",
  "Narcoossee's",
  "'Ohana",
  "Boma",
  "Jiko",
  "Sanaa",
  "Rainforest Cafe",
  "Jazz Kitchen Coastal Grill & Patio",
  "Ballast Point",
];

const DINING_KEYS: Set<string> = new Set(
  DINING_PLACE_NAMES.map((name) => normalizeKey(name)),
);

/**
 * True when the given activity name matches a known dining location.
 * Stage 1: exact normalized match.
 * Stage 2: whole-word containment (≥2 meaningful tokens required) against
 * the known dining key set — mirrors lookupWait()'s containment stage so
 * minor wording differences (e.g. dropped "Restaurant") still resolve.
 */
export function isDiningName(name: string): boolean {
  const key = normalizeKey(stripAnnotations(name));
  if (DINING_KEYS.has(key)) return true;

  const tokens = tokenize(key);
  if (tokens.length < 2) return false;

  let matchCount = 0;
  for (const diningKey of DINING_KEYS) {
    if (containsWholeWordSequence(diningKey, tokens)) {
      matchCount++;
      if (matchCount > 1) return false;
    }
  }
  return matchCount === 1;
}

/**
 * Infer a planner item's type from its current activity name.
 * Single source of truth for Add/Edit/import — keeps name-based type
 * inference consistent everywhere a name is entered or changed.
 * Extend here (not at call sites) when entertainment recognition lands.
 */
export function inferPlannerItemType(name: string): PlannerItemType {
  return isDiningName(name) ? "dining" : "attraction";
}

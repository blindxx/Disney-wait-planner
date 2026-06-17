/**
 * diningSuggestions.ts — Phase 9.1 Dining Smart Entry recognition.
 *
 * Known dining locations across Disneyland Resort and Walt Disney World.
 * Covers reservation-based table service, character dining, signature
 * dining, dinner shows, and destination-style quick-service locations
 * guests commonly build itineraries around. Deliberately excludes
 * Starbucks, Joffrey's, carts, kiosks, festival booths, resort quick
 * service / food courts, pool bars, coffee locations, grab-and-go
 * markets, and generic lounges.
 *
 * Each entry carries lightweight metadata (resort + park/area label) so
 * the planner can show location context and disambiguate same-named
 * locations that exist at both resorts (e.g. Oga's Cantina).
 *
 * isDiningName() mirrors the stage-1 (exact) + stage-2 (whole-word
 * containment) logic used by lookupWait() in plansMatching.ts, so a known
 * dining name is recognized the same way attraction names already are.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import {
  normalizeKey,
  stripAnnotations,
  tokenize,
  containsWholeWordSequence,
} from "./plansMatching";
import type { PlannerItemType } from "./plansTransfer";

export type DiningPlace = {
  name: string;
  resort: ResortId;
  /** Park/area/resort display label shown under the activity name. */
  location: string;
  /**
   * The theme park this location is inside, when it is one of the six core
   * parks — used so dining can participate in day park inference alongside
   * attractions. Omitted for resort hotels, Downtown Disney, and Disney
   * Springs locations, which have no single-park identity.
   */
  parkId?: ParkId;
};

export const DINING_PLACES: DiningPlace[] = [
  // ---- Disneyland Park / DCA — table service ----
  { name: "Blue Bayou Restaurant", resort: "DLR", location: "Disneyland Park", parkId: "disneyland" },
  { name: "Carthay Circle Restaurant", resort: "DLR", location: "Disney California Adventure", parkId: "dca" },
  { name: "Napa Rose", resort: "DLR", location: "Disney's Grand Californian Hotel" },
  { name: "Storytellers Cafe", resort: "DLR", location: "Disney's Grand Californian Hotel" },
  { name: "Steakhouse 55", resort: "DLR", location: "Disneyland Hotel" },
  { name: "Cafe Orleans", resort: "DLR", location: "Disneyland Park", parkId: "disneyland" },
  { name: "Plaza Inn", resort: "DLR", location: "Disneyland Park", parkId: "disneyland" },
  { name: "Lamplight Lounge", resort: "DLR", location: "Disney California Adventure", parkId: "dca" },
  { name: "Goofy's Kitchen", resort: "DLR", location: "Disneyland Hotel" },
  { name: "Carnation Cafe", resort: "DLR", location: "Disneyland Park", parkId: "disneyland" },
  { name: "River Belle Terrace", resort: "DLR", location: "Disneyland Park", parkId: "disneyland" },
  { name: "Rancho del Zocalo Restaurante", resort: "DLR", location: "Disneyland Park", parkId: "disneyland" },
  { name: "Wine Country Trattoria", resort: "DLR", location: "Disney California Adventure", parkId: "dca" },

  // ---- Disneyland Park / DCA — destination-style quick service ----
  { name: "Bengal Barbecue", resort: "DLR", location: "Disneyland Park", parkId: "disneyland" },
  { name: "Galactic Grill", resort: "DLR", location: "Disneyland Park", parkId: "disneyland" },
  { name: "Award Wieners", resort: "DLR", location: "Disney California Adventure", parkId: "dca" },
  { name: "Pym Test Kitchen", resort: "DLR", location: "Disney California Adventure", parkId: "dca" },
  { name: "Smokejumpers Grill", resort: "DLR", location: "Disney California Adventure", parkId: "dca" },
  { name: "Tropical Hideaway", resort: "DLR", location: "Disneyland Park", parkId: "disneyland" },
  { name: "Red Rose Taverne", resort: "DLR", location: "Disneyland Park", parkId: "disneyland" },
  { name: "Ronto Roasters", resort: "DLR", location: "Disneyland Park", parkId: "disneyland" },
  { name: "Docking Bay 7 Food and Cargo", resort: "DLR", location: "Disneyland Park", parkId: "disneyland" },
  { name: "Oga's Cantina", resort: "DLR", location: "Disneyland Park", parkId: "disneyland" },

  // ---- Downtown Disney (Anaheim) ----
  { name: "Naples Ristorante e Bar", resort: "DLR", location: "Downtown Disney" },
  { name: "Black Tap", resort: "DLR", location: "Downtown Disney" },
  { name: "Salt & Straw", resort: "DLR", location: "Downtown Disney" },
  { name: "Earl of Sandwich", resort: "DLR", location: "Downtown Disney" },
  { name: "Paseo", resort: "DLR", location: "Downtown Disney" },
  { name: "Centrico", resort: "DLR", location: "Downtown Disney" },
  { name: "Tiendita", resort: "DLR", location: "Downtown Disney" },

  // ---- Magic Kingdom — table service ----
  { name: "Be Our Guest Restaurant", resort: "WDW", location: "Magic Kingdom", parkId: "mk" },
  { name: "Cinderella's Royal Table", resort: "WDW", location: "Magic Kingdom", parkId: "mk" },
  { name: "Liberty Tree Tavern", resort: "WDW", location: "Magic Kingdom", parkId: "mk" },
  { name: "Tony's Town Square Restaurant", resort: "WDW", location: "Magic Kingdom", parkId: "mk" },
  { name: "The Crystal Palace", resort: "WDW", location: "Magic Kingdom", parkId: "mk" },
  { name: "Jungle Navigation Co. LTD Skipper Canteen", resort: "WDW", location: "Magic Kingdom", parkId: "mk" },
  { name: "The Plaza Restaurant", resort: "WDW", location: "Magic Kingdom", parkId: "mk" },
  { name: "The Diamond Horseshoe", resort: "WDW", location: "Magic Kingdom", parkId: "mk" },

  // ---- Magic Kingdom — destination-style quick service ----
  { name: "Cosmic Ray's Starlight Cafe", resort: "WDW", location: "Magic Kingdom", parkId: "mk" },
  { name: "Pecos Bill Tall Tale Inn and Cafe", resort: "WDW", location: "Magic Kingdom", parkId: "mk" },
  { name: "Columbia Harbour House", resort: "WDW", location: "Magic Kingdom", parkId: "mk" },
  { name: "Pinocchio Village Haus", resort: "WDW", location: "Magic Kingdom", parkId: "mk" },
  { name: "Beak and Barrel", resort: "WDW", location: "Magic Kingdom", parkId: "mk" },

  // ---- EPCOT — World Showcase + Future World/World Celebration ----
  { name: "Topolino's Terrace", resort: "WDW", location: "Disney's Riviera Resort" },
  { name: "Space 220", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Le Cellier Steakhouse", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Akershus Royal Banquet Hall", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Garden Grill", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Sunshine Seasons", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Rose & Crown Dining Room", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Teppan Edo", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Tokyo Dining", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Via Napoli", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Tutto Italia", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Biergarten", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Chefs de France", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "San Angel Inn", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "La Hacienda de San Angel", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Nine Dragons", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Spice Road Table", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Regal Eagle Smokehouse", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Katsura Grill", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "GEO-82", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Shiki-Sai: Sushi Izakaya", resort: "WDW", location: "EPCOT", parkId: "epcot" },
  { name: "Coral Reef Restaurant", resort: "WDW", location: "EPCOT", parkId: "epcot" },

  // ---- Hollywood Studios ----
  { name: "Sci-Fi Dine-In Theater Restaurant", resort: "WDW", location: "Hollywood Studios", parkId: "hs" },
  { name: "50's Prime Time Cafe", resort: "WDW", location: "Hollywood Studios", parkId: "hs" },
  { name: "Hollywood Brown Derby", resort: "WDW", location: "Hollywood Studios", parkId: "hs" },
  { name: "Roundup Rodeo BBQ", resort: "WDW", location: "Hollywood Studios", parkId: "hs" },
  { name: "Backlot Express", resort: "WDW", location: "Hollywood Studios", parkId: "hs" },
  { name: "Woody's Lunch Box", resort: "WDW", location: "Hollywood Studios", parkId: "hs" },
  { name: "Docking Bay 7 Food and Cargo", resort: "WDW", location: "Hollywood Studios", parkId: "hs" },
  { name: "Ronto Roasters", resort: "WDW", location: "Hollywood Studios", parkId: "hs" },
  { name: "ABC Commissary", resort: "WDW", location: "Hollywood Studios", parkId: "hs" },
  { name: "Oga's Cantina", resort: "WDW", location: "Hollywood Studios", parkId: "hs" },

  // ---- Animal Kingdom ----
  { name: "Tiffins", resort: "WDW", location: "Animal Kingdom", parkId: "ak" },
  { name: "Tusker House", resort: "WDW", location: "Animal Kingdom", parkId: "ak" },
  { name: "Yak & Yeti Restaurant", resort: "WDW", location: "Animal Kingdom", parkId: "ak" },
  { name: "Satu'li Canteen", resort: "WDW", location: "Animal Kingdom", parkId: "ak" },
  { name: "Flame Tree Barbecue", resort: "WDW", location: "Animal Kingdom", parkId: "ak" },
  { name: "Nomad Lounge", resort: "WDW", location: "Animal Kingdom", parkId: "ak" },

  // ---- Disney Springs ----
  { name: "Chef Art Smith's Homecomin'", resort: "WDW", location: "Disney Springs" },
  { name: "Wine Bar George", resort: "WDW", location: "Disney Springs" },
  { name: "The BOATHOUSE", resort: "WDW", location: "Disney Springs" },
  { name: "Morimoto Asia", resort: "WDW", location: "Disney Springs" },
  { name: "Jaleo", resort: "WDW", location: "Disney Springs" },
  { name: "Raglan Road", resort: "WDW", location: "Disney Springs" },
  { name: "STK Orlando", resort: "WDW", location: "Disney Springs" },
  { name: "Summer House on the Lake", resort: "WDW", location: "Disney Springs" },
  { name: "Gideon's Bakehouse", resort: "WDW", location: "Disney Springs" },
  { name: "Earl of Sandwich", resort: "WDW", location: "Disney Springs" },
  { name: "D-Luxe Burger", resort: "WDW", location: "Disney Springs" },
  { name: "Chicken Guy!", resort: "WDW", location: "Disney Springs" },
  { name: "Din Tai Fung", resort: "WDW", location: "Disney Springs" },

  // ---- Major WDW resorts — character / signature / dinner-show dining ----
  { name: "Chef Mickey's", resort: "WDW", location: "Disney's Contemporary Resort" },
  { name: "California Grill", resort: "WDW", location: "Disney's Contemporary Resort" },
  { name: "Steakhouse 71", resort: "WDW", location: "Disney's Contemporary Resort" },
  { name: "Narcoossee's", resort: "WDW", location: "Disney's Grand Floridian Resort" },
  { name: "'Ohana", resort: "WDW", location: "Disney's Polynesian Resort" },
  { name: "Boma", resort: "WDW", location: "Disney's Animal Kingdom Lodge" },
  { name: "Jiko", resort: "WDW", location: "Disney's Animal Kingdom Lodge" },
  { name: "Sanaa", resort: "WDW", location: "Disney's Animal Kingdom Lodge" },
  { name: "Beaches & Cream", resort: "WDW", location: "Disney's Beach Club Resort" },
  { name: "Cape May Cafe", resort: "WDW", location: "Disney's Beach Club Resort" },
  { name: "Whispering Canyon Cafe", resort: "WDW", location: "Disney's Wilderness Lodge" },
  { name: "Story Book Dining at Artist Point", resort: "WDW", location: "Disney's Wilderness Lodge" },
  { name: "Sebastian's Bistro", resort: "WDW", location: "Disney's Caribbean Beach Resort" },
];

const DINING_KEYS: Set<string> = new Set(
  DINING_PLACES.map((p) => normalizeKey(p.name)),
);

/**
 * Manual alias map for common guest-entered dining shorthand — mirrors the
 * ALIASES_DLR / ALIASES_WDW philosophy in plansMatching.ts (no fuzzy
 * matching, just an explicit lookup table).
 *
 * Keys:   normalizeKey() output of the user-entered alias.
 * Values: normalizeKey() output of the canonical DINING_PLACES name.
 *
 * Needed mainly for shorthand that the stage-2 containment check in
 * isDiningName() can't reach (single-token names like "CRT", or names that
 * drop/reorder words relative to the canonical form), and for
 * getDiningLocation(), which only does exact-key lookup.
 */
const DINING_ALIASES: Record<string, string> = {
  "skipper canteen":  "jungle navigation co ltd skipper canteen",
  "rose and crown":   "rose crown dining room",
  "brown derby":      "hollywood brown derby",
  "coral reef":       "coral reef restaurant",
  "rancho del zocalo": "rancho del zocalo restaurante",
  "storytellers":     "storytellers cafe",
  "plaza restaurant": "the plaza restaurant",
  "be our guest":     "be our guest restaurant",
  "crt":              "cinderellas royal table",
  // "Ohana" needs no alias: normalizeKey() already strips the apostrophe
  // from "'Ohana", so "Ohana" hits the exact-match stage directly.
};

/**
 * Strip a disambiguation suffix appended by getDiningSuggestions(), e.g.
 * "Oga's Cantina — Hollywood Studios" → "Oga's Cantina". No-op when absent.
 * Kept local to dining (not in plansMatching.ts) since attraction names
 * never carry this suffix format.
 */
function stripDiningSuffix(str: string): string {
  const idx = str.indexOf(" — ");
  return idx === -1 ? str : str.slice(0, idx);
}

/**
 * Resolve a (possibly aliased) typed name to its canonical DINING_KEYS entry.
 * Stage 1: exact normalized match. Stage 3: alias lookup. Returns null when
 * neither resolves (caller may still fall back to containment matching).
 *
 * Exported so other inference systems (e.g. day park/resort inference in
 * plansContextInference.ts and page.tsx) can resolve dining aliases through
 * this single source of truth instead of duplicating DINING_ALIASES lookup
 * logic.
 */
export function resolveDiningKey(name: string): string | null {
  const key = normalizeKey(stripAnnotations(stripDiningSuffix(name)));
  if (DINING_KEYS.has(key)) return key;
  const aliasTarget = DINING_ALIASES[key];
  if (aliasTarget && DINING_KEYS.has(aliasTarget)) return aliasTarget;
  return null;
}

/**
 * True when the given activity name matches a known dining location.
 * Stage 1: exact normalized match. Stage 3: alias lookup.
 * Stage 2: whole-word containment (≥2 meaningful tokens required) against
 * the known dining key set — mirrors lookupWait()'s containment stage so
 * minor wording differences (e.g. dropped "Restaurant") still resolve.
 */
export function isDiningName(name: string): boolean {
  if (resolveDiningKey(name)) return true;

  const key = normalizeKey(stripAnnotations(stripDiningSuffix(name)));
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

/**
 * Autocomplete suggestion list, scoped to the active resort (mirrors how
 * attraction suggestions are scoped to selectedResort via waitMap). Names
 * that exist at both resorts under different locations (e.g. Oga's Cantina)
 * are disambiguated with " — <location>" only when more than one distinct
 * location remains within the scoped list.
 */
export function getDiningSuggestions(resort: ResortId): string[] {
  const scoped = DINING_PLACES.filter((p) => p.resort === resort);
  const byKey = new Map<string, DiningPlace[]>();
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
 * Resolve the display location label for a dining item's current name,
 * preferring a match within the active resort, falling back to any resort.
 * Returns undefined for unknown/custom names.
 */
export function getDiningLocation(name: string, resort: ResortId): string | undefined {
  const key = resolveDiningKey(name);
  if (!key) return undefined;
  const matches = DINING_PLACES.filter((p) => normalizeKey(p.name) === key);
  if (matches.length === 0) return undefined;
  return (matches.find((p) => p.resort === resort) ?? matches[0]).location;
}

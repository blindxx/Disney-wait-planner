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
 *
 * Active vs. legacy identity: `DINING_PLACES` is the ACTIVE/current catalog
 * — the only one enumerated by Smart Entry suggestions
 * (getDiningSuggestions). Permanently closed/replaced dining that old
 * saved/imported/cloud-restored plans should keep recognizing lives instead
 * in the separate `LEGACY_DINING_PLACES` list further down, which is
 * deliberately NOT exported for enumeration — only `resolveDiningKey` and
 * the location/canonical-name/parkId lookups consult it, as a fallback
 * after the active catalog fails to match. Mirrors
 * ENTERTAINMENT_PLACES/LEGACY_ENTERTAINMENT_PLACES in
 * entertainmentSuggestions.ts exactly — see that file's doc comment for the
 * full rationale, including why park/day-inference consumers must go
 * through getDiningContext (resort + optional parkId — see its doc comment
 * for why a parkId-only lookup isn't enough) rather than building their own
 * name→parkId map from DINING_PLACES alone.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import {
  normalizeKey,
  stripAnnotations,
  tokenize,
  containsWholeWordSequence,
} from "./plansMatching";
import type { PlannerItemType } from "./plansTransfer";
import { isEntertainmentName } from "./entertainmentSuggestions";

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
  /**
   * Themed land/area within the park where this dining location sits (e.g.
   * "Toy Story Land", "Star Wars: Galaxy's Edge") — distinct from
   * `location`, which is the park-level display label. Uses the same land
   * vocabulary as attraction wait data (packages/shared/src/waitTimes/
   * mock.ts) and ENTERTAINMENT_PLACES so a future combined land filter/
   * display doesn't need a second taxonomy. A handful of dining-only areas
   * with no current attraction/entertainment presence in that vocabulary
   * (e.g. "Commissary Lane", "Discovery Island", "Buena Vista Street",
   * "Pacific Wharf") are introduced here using their official Disney names,
   * ready for attractions/entertainment to adopt the same label later.
   * Verified against current restaurant locations as of this catalog
   * revision. Omitted for entries with no single in-park land — resort
   * hotels, Downtown Disney, and Disney Springs, where `location` already
   * is the canonical area and forcing a park-land label would misrepresent
   * them.
   */
  land?: string;
};

export const DINING_PLACES: DiningPlace[] = [
  // ---- Disneyland Park / DCA — table service ----
  { name: "Blue Bayou Restaurant", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "New Orleans Square" },
  { name: "Carthay Circle Restaurant", resort: "DLR", location: "Disney California Adventure", parkId: "dca", land: "Buena Vista Street" },
  { name: "Napa Rose", resort: "DLR", location: "Disney's Grand Californian Hotel" },
  { name: "Storytellers Cafe", resort: "DLR", location: "Disney's Grand Californian Hotel" },
  { name: "Cafe Orleans", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "New Orleans Square" },
  { name: "Plaza Inn", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Main Street, U.S.A." },
  { name: "Lamplight Lounge", resort: "DLR", location: "Disney California Adventure", parkId: "dca", land: "Pixar Pier" },
  { name: "Goofy's Kitchen", resort: "DLR", location: "Disneyland Hotel" },
  { name: "Carnation Cafe", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Main Street, U.S.A." },
  { name: "River Belle Terrace", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Frontierland" },
  { name: "Rancho del Zocalo Restaurante", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Frontierland" },
  { name: "Wine Country Trattoria", resort: "DLR", location: "Disney California Adventure", parkId: "dca", land: "Performance Corridor" },

  // ---- Disneyland Park / DCA — destination-style quick service ----
  { name: "Bengal Barbecue", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Adventureland" },
  { name: "Galactic Grill", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Tomorrowland" },
  { name: "Award Wieners", resort: "DLR", location: "Disney California Adventure", parkId: "dca", land: "Hollywood Land" },
  { name: "Pym Test Kitchen", resort: "DLR", location: "Disney California Adventure", parkId: "dca", land: "Avengers Campus" },
  { name: "Smokejumpers Grill", resort: "DLR", location: "Disney California Adventure", parkId: "dca", land: "Grizzly Peak" },
  { name: "Tropical Hideaway", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Adventureland" },
  { name: "Red Rose Taverne", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Fantasyland" },
  { name: "Ronto Roasters", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Star Wars: Galaxy’s Edge" },
  { name: "Docking Bay 7 Food and Cargo", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Star Wars: Galaxy’s Edge" },
  { name: "Oga's Cantina", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Star Wars: Galaxy’s Edge" },

  // ---- Downtown Disney (Anaheim) ----
  { name: "Naples Ristorante e Bar", resort: "DLR", location: "Downtown Disney" },
  { name: "Black Tap", resort: "DLR", location: "Downtown Disney" },
  { name: "Salt & Straw", resort: "DLR", location: "Downtown Disney" },
  { name: "Earl of Sandwich", resort: "DLR", location: "Downtown Disney" },
  { name: "Paseo", resort: "DLR", location: "Downtown Disney" },
  { name: "Centrico", resort: "DLR", location: "Downtown Disney" },
  { name: "Tiendita", resort: "DLR", location: "Downtown Disney" },
  // Maintenance audit addition — ground-up-built standalone location,
  // opened July 1, 2024. Din Tai Fung's only Disney destination location
  // is here at DLR; WDW/Disney Springs has none. (A prior revision of this
  // catalog incorrectly also listed a WDW/Disney Springs entry, describing
  // it as a parallel same-name-at-both-resorts case like "Earl of
  // Sandwich" — that was bad catalog data, since removed.)
  { name: "Din Tai Fung", resort: "DLR", location: "Downtown Disney" },

  // ---- Magic Kingdom — table service ----
  { name: "Be Our Guest Restaurant", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Fantasyland" },
  { name: "Cinderella's Royal Table", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Fantasyland" },
  { name: "Liberty Tree Tavern", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Liberty Square" },
  { name: "Tony's Town Square Restaurant", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Main Street, U.S.A." },
  { name: "The Crystal Palace", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Main Street, U.S.A." },
  { name: "Jungle Navigation Co. LTD Skipper Canteen", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Adventureland" },
  { name: "The Plaza Restaurant", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Main Street, U.S.A." },
  { name: "The Diamond Horseshoe", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Frontierland" },

  // ---- Magic Kingdom — destination-style quick service ----
  { name: "Cosmic Ray's Starlight Cafe", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Tomorrowland" },
  { name: "Pecos Bill Tall Tale Inn and Cafe", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Frontierland" },
  { name: "Columbia Harbour House", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Liberty Square" },
  { name: "Pinocchio Village Haus", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Fantasyland" },
  { name: "The Beak and Barrel", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Adventureland" },

  // ---- EPCOT — World Showcase + Future World/World Celebration ----
  { name: "Topolino's Terrace", resort: "WDW", location: "Disney's Riviera Resort" },
  { name: "Space 220", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Discovery" },
  { name: "Le Cellier Steakhouse", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "Akershus Royal Banquet Hall", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "Garden Grill", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Nature" },
  { name: "Sunshine Seasons", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Nature" },
  { name: "Rose & Crown Dining Room", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "Teppan Edo", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "Via Napoli", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "Tutto Italia", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "Biergarten", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "Chefs de France", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  // Maintenance audit addition — table-service galette/crepe restaurant in
  // the France pavilion (distinct from its own walk-up quick-service
  // counter, Crêpes à Emporter, which is out of scope per the existing
  // ordinary-quick-service exclusion). Canonical name uses Disney's
  // official accented spelling; normalizeKey() turns "ê" into a
  // key-splitting space (canonical key becomes "la cr perie de paris"), so
  // the unaccented "La Creperie de Paris" is handled the same way every
  // other alternate-spelling shorthand is in this catalog — via
  // DINING_ALIASES, not a parallel normalization/mapping mechanism (see
  // the alias below).
  { name: "La Crêperie de Paris", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "San Angel Inn", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "La Hacienda de San Angel", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "Nine Dragons", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "Spice Road Table", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "Regal Eagle Smokehouse", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "Katsura Grill", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "GEO-82", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Celebration" },
  { name: "Shiki-Sai: Sushi Izakaya", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
  { name: "Coral Reef Restaurant", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Nature" },

  // ---- Hollywood Studios ----
  { name: "Sci-Fi Dine-In Theater Restaurant", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Commissary Lane" },
  { name: "50's Prime Time Cafe", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Commissary Lane" },
  { name: "Hollywood Brown Derby", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Hollywood Boulevard" },
  { name: "Roundup Rodeo BBQ", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Toy Story Land" },
  { name: "Backlot Express", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Echo Lake" },
  { name: "Woody's Lunch Box", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Toy Story Land" },
  { name: "Docking Bay 7 Food and Cargo", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Star Wars: Galaxy’s Edge" },
  { name: "Ronto Roasters", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Star Wars: Galaxy’s Edge" },
  { name: "ABC Commissary", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Commissary Lane" },
  { name: "Oga's Cantina", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Star Wars: Galaxy’s Edge" },

  // ---- Animal Kingdom ----
  { name: "Tiffins", resort: "WDW", location: "Animal Kingdom", parkId: "ak", land: "Discovery Island" },
  { name: "Tusker House", resort: "WDW", location: "Animal Kingdom", parkId: "ak", land: "Africa" },
  { name: "Yak & Yeti Restaurant", resort: "WDW", location: "Animal Kingdom", parkId: "ak", land: "Asia" },
  { name: "Satu'li Canteen", resort: "WDW", location: "Animal Kingdom", parkId: "ak", land: "Pandora – The World of Avatar" },
  { name: "Flame Tree Barbecue", resort: "WDW", location: "Animal Kingdom", parkId: "ak", land: "Discovery Island" },
  { name: "Nomad Lounge", resort: "WDW", location: "Animal Kingdom", parkId: "ak", land: "Discovery Island" },

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
  // Maintenance audit additions below — all confirmed current, table
  // service or destination-tier quick service commonly planned around.
  // Rainforest Cafe (Disney Springs AND Animal Kingdom's entrance plaza) is
  // deliberately NOT catalogued at all: it's the only current WDW dining
  // name with two distinct current locations within the same resort, and
  // this catalog has no location-aware identity — every lookup
  // (resolveDiningKey/getDiningLocation/getDiningCanonicalName/
  // getDiningContext) and crossDayChecks.ts's cross-day duplicate
  // composite-key generation resolve a name by resort only. Adding just one
  // location (as a prior revision of this catalog briefly did) is worse
  // than adding neither: an unsuffixed "Rainforest Cafe" typed for the
  // OTHER location would silently resolve to the cataloged one's
  // metadata/park instead of failing to resolve at all. Catalog it properly
  // only once same-name + same-resort + different-location identity is
  // supported (a real architecture change, out of scope for this
  // maintenance phase) — until then it falls back to custom/unrecognized
  // like any other name DWP doesn't know, which is the correct behavior
  // here, not a gap to paper over.
  // The Polite Pig: quick service, but Michelin Guide-recognized and one of
  // Disney Springs' most notable destination dining spots (largest bourbon
  // bar on Disney property) — fits "destination-style quick service
  // commonly planned around", not ordinary quick service.
  { name: "The Polite Pig", resort: "WDW", location: "Disney Springs" },
  { name: "Maria & Enzo's Ristorante", resort: "WDW", location: "Disney Springs" },
  // Six Ravens: savory counter-service concept from the same team as the
  // already-cataloged Gideon's Bakehouse, open since Aug 3, 2026 with
  // demonstrated destination-level demand (uses a virtual queue).
  { name: "Six Ravens", resort: "WDW", location: "Disney Springs" },

  // ---- Major WDW resorts — character / signature / dinner-show dining ----
  { name: "Chef Mickey's", resort: "WDW", location: "Disney's Contemporary Resort" },
  { name: "California Grill", resort: "WDW", location: "Disney's Contemporary Resort" },
  { name: "Steakhouse 71", resort: "WDW", location: "Disney's Contemporary Resort" },
  { name: "Narcoossee's", resort: "WDW", location: "Disney's Grand Floridian Resort" },
  // Maintenance audit addition — active signature dining at Grand
  // Floridian (reopened 2021 after remodel; not closed/replaced). Canonical
  // name uses Disney's official accented spelling ("Cítricos"); the
  // unaccented "Citricos" resolves via the DINING_ALIASES entry below,
  // following the same pattern established for "La Crêperie de Paris".
  { name: "Cítricos", resort: "WDW", location: "Disney's Grand Floridian Resort" },
  { name: "'Ohana", resort: "WDW", location: "Disney's Polynesian Resort" },
  { name: "Boma", resort: "WDW", location: "Disney's Animal Kingdom Lodge" },
  { name: "Jiko", resort: "WDW", location: "Disney's Animal Kingdom Lodge" },
  { name: "Sanaa", resort: "WDW", location: "Disney's Animal Kingdom Lodge" },
  { name: "Beaches & Cream", resort: "WDW", location: "Disney's Beach Club Resort" },
  { name: "Cape May Cafe", resort: "WDW", location: "Disney's Beach Club Resort" },
  { name: "Whispering Canyon Cafe", resort: "WDW", location: "Disney's Wilderness Lodge" },
  { name: "Story Book Dining at Artist Point", resort: "WDW", location: "Disney's Wilderness Lodge" },
  { name: "Sebastian's Bistro", resort: "WDW", location: "Disney's Caribbean Beach Resort" },
  // Maintenance audit additions — extend supported resort dining to two
  // Disney-owned/operated resorts not previously represented in the
  // catalog (both confirmed current, active signature dining).
  { name: "Yachtsman Steakhouse", resort: "WDW", location: "Disney's Yacht Club Resort" },
  { name: "The Cake Bake Shop Restaurant by Gwendolyn Rogers", resort: "WDW", location: "Disney's BoardWalk" },
];

const DINING_KEYS: Set<string> = new Set(
  DINING_PLACES.map((p) => normalizeKey(p.name)),
);

// Phase 9.3.5 — per-resort canonical key sets, used to validate that a
// resolved key actually has a location at the requested resort before
// returning it (e.g. "Cinderella's Royal Table" exists only at WDW, so it
// must not resolve when resort="DLR" is passed).
const DINING_KEYS_BY_RESORT: Record<ResortId, Set<string>> = {
  DLR: new Set(DINING_PLACES.filter((p) => p.resort === "DLR").map((p) => normalizeKey(p.name))),
  WDW: new Set(DINING_PLACES.filter((p) => p.resort === "WDW").map((p) => normalizeKey(p.name))),
};

/**
 * Permanently closed/replaced dining identities kept ONLY so that saved,
 * imported, or cloud-restored plan items naming them still resolve to the
 * correct type (dining, not "attraction"/custom) and correct historical
 * canonical name/location/park — never for current planning. Mirrors
 * LEGACY_ENTERTAINMENT_PLACES in entertainmentSuggestions.ts exactly.
 *
 * Deliberately NOT exported and NOT read by getDiningSuggestions, so this
 * list structurally cannot reach My Plans' Smart Entry suggestions. Only
 * resolveDiningKey (and the lookups built on it — getDiningLocation/
 * getDiningCanonicalName/getDiningContext/getDiningParkId) consult it, as a
 * fallback after the active catalog above fails to match. Park/day-inference
 * consumers (crossDayChecks.ts's inferDayPark, plansContextInference.ts's
 * tryResolve) must go through getDiningContext — not build their own
 * name→parkId map from DINING_PLACES alone, and not a parkId-only lookup —
 * so a legacy-only Auto day (e.g. its only recognizable item is "Tokyo
 * Dining") still recovers the correct historical park instead of silently
 * losing all park signal despite the name resolving, AND a legacy-only
 * Auto day whose only recognizable item has no park of its own (e.g.
 * "Steakhouse 55", a Disneyland Hotel restaurant) still recovers its
 * correct historical resort instead of losing all signal (the Entertainment
 * bug this maintenance phase was told
 * not to repeat).
 *
 * Add an entry here (never re-add it to DINING_PLACES) when a current
 * location is confirmed permanently closed/replaced.
 */
const LEGACY_DINING_PLACES: DiningPlace[] = [
  // Closed July 2021 (confirmed permanent — Disney stated no plans to
  // reopen); the space was later converted to lounge use, with a new
  // signature restaurant targeted for 2027. Never at WDW.
  { name: "Steakhouse 55", resort: "DLR", location: "Disneyland Hotel" },
  // Closed November 2022, replaced in the same Japan pavilion space by
  // Shiki-Sai: Sushi Izakaya (active catalog, opened August 2023). Never
  // at DLR.
  { name: "Tokyo Dining", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase" },
];

const LEGACY_DINING_KEYS: Set<string> = new Set(
  LEGACY_DINING_PLACES.map((p) => normalizeKey(p.name)),
);

const LEGACY_DINING_KEYS_BY_RESORT: Record<ResortId, Set<string>> = {
  DLR: new Set(LEGACY_DINING_PLACES.filter((p) => p.resort === "DLR").map((p) => normalizeKey(p.name))),
  WDW: new Set(LEGACY_DINING_PLACES.filter((p) => p.resort === "WDW").map((p) => normalizeKey(p.name))),
};

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
  // Maintenance audit — Beak and Barrel's official name is "The Beak and
  // Barrel"; this alias keeps the pre-rename form (and any saved/imported
  // plans using it) resolving to the renamed canonical entry.
  "beak and barrel":  "the beak and barrel",
  // Maintenance audit — common shorthand for the long official name.
  "cake bake shop":   "the cake bake shop restaurant by gwendolyn rogers",
  // Maintenance audit — the canonical name's accented "ê" makes
  // normalizeKey() split "crêperie" into "cr" + "perie" (turning the
  // accent into a space, like every other non-alphanumeric character),
  // so the plain-ASCII spelling needs an explicit alias to resolve to the
  // same identity rather than a parallel normalization mechanism.
  "la creperie de paris": "la cr perie de paris",
  // Maintenance audit — same pattern for "Cítricos": normalizeKey() turns
  // the accented "í" into a key-splitting space ("c tricos"), so the
  // common unaccented "Citricos" spelling needs this explicit alias.
  "citricos": "c tricos",
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
 * Extract the disambiguation suffix's location half, e.g. "Oga's Cantina —
 * Hollywood Studios" → "Hollywood Studios". Returns null when absent. The
 * counterpart to stripDiningSuffix (which discards this half) — used by
 * pickDiningMatch below to disambiguate a name that resolves to more than
 * one entry within the same resort, where resort alone isn't enough to
 * pick the right record. No current DINING_PLACES entry shares a name
 * within one resort (getDiningSuggestions() already anticipates that case
 * via its own " — <location>" suffix generation — see its distinctLocations
 * check below — so this keeps the location-aware getters correct if/when a
 * future entry needs it, rather than leaving a latent bug for that day).
 */
function extractDiningSuffixLocation(str: string): string | null {
  const idx = str.indexOf(" — ");
  return idx === -1 ? null : str.slice(idx + 3).trim();
}

/**
 * Pick the single DiningPlace record a resolved key's matches should use.
 * Prefers an exact (resort, location) match against a disambiguation
 * suffix in the original name when present (needed if the same name ever
 * has more than one location within one resort), otherwise falls back to
 * the existing resort-only preference used throughout this file. No-op for
 * every name without a suffix — i.e. every existing caller's behavior is
 * unchanged.
 */
function pickDiningMatch(matches: DiningPlace[], resort: ResortId, name: string): DiningPlace {
  const suffixLocation = extractDiningSuffixLocation(name);
  if (suffixLocation) {
    const exact = matches.find((p) => p.resort === resort && p.location === suffixLocation);
    if (exact) return exact;
  }
  return matches.find((p) => p.resort === resort) ?? matches[0];
}

/**
 * Resolve a (possibly aliased or partially-typed) name to its canonical
 * DINING_KEYS entry. Single source of truth for dining recognition — every
 * consumer (isDiningName, getDiningLocation, park/day inference) resolves
 * through this function so a name like "Blue Bayou" or "Rose and Crown"
 * matches consistently everywhere instead of being recognized as dining in
 * one place but failing to resolve metadata in another.
 *
 * Stage 1: exact normalized match.
 * Stage 3: alias lookup (DINING_ALIASES).
 * Stage 2: whole-word containment (≥2 meaningful tokens, unambiguous) —
 * mirrors lookupWait()'s containment stage so minor wording differences
 * (e.g. dropped "Restaurant") still resolve.
 *
 * When resort is supplied, the resolved key is validated against
 * DINING_KEYS_BY_RESORT before being returned — e.g. "Cinderella's Royal
 * Table" must not resolve for resort="DLR" (and vice versa for DLR-only
 * locations). Without a resort, validation is skipped, preserving existing
 * unscoped/ambiguous lookup behavior.
 *
 * Legacy fallback: when nothing in the active catalog matches, the same
 * stage-1 (exact) lookup runs against LEGACY_DINING_PLACES so old
 * saved/imported plan text (e.g. "Steakhouse 55", "Tokyo Dining") still
 * resolves instead of falling back to "custom/attraction" — mirrors
 * resolveEntertainmentKey's active-then-legacy fallback exactly. This is
 * the ONLY path legacy dining identities can be reached through; the active
 * catalog is always tried first and exclusively for anything reachable from
 * current Smart Entry suggestions (getDiningSuggestions never enumerates
 * legacy entries).
 *
 * Returns null when nothing resolves in either catalog.
 */
export function resolveDiningKey(name: string, resort?: ResortId): string | null {
  const key = normalizeKey(stripAnnotations(stripDiningSuffix(name)));

  let candidate: string | null = null;
  if (DINING_KEYS.has(key)) {
    candidate = key;
  } else {
    const aliasTarget = DINING_ALIASES[key];
    if (aliasTarget && DINING_KEYS.has(aliasTarget)) {
      candidate = aliasTarget;
    } else {
      const tokens = tokenize(key);
      if (tokens.length >= 2) {
        let hit: string | null = null;
        let matchCount = 0;
        for (const diningKey of DINING_KEYS) {
          if (containsWholeWordSequence(diningKey, tokens)) {
            matchCount++;
            if (matchCount > 1) {
              hit = null;
              break;
            }
            hit = diningKey;
          }
        }
        if (matchCount === 1) candidate = hit;
      }
    }
  }

  if (candidate) {
    if (resort && !DINING_KEYS_BY_RESORT[resort].has(candidate)) return null;
    return candidate;
  }

  // Legacy fallback — only reached when the active catalog found nothing.
  // Exact match only (no containment stage): the legacy catalog is small
  // and deliberately conservative, mirroring resolveEntertainmentKey.
  if (!LEGACY_DINING_KEYS.has(key)) return null;
  if (resort && !LEGACY_DINING_KEYS_BY_RESORT[resort].has(key)) return null;
  return key;
}

/**
 * Find catalog entries by a key already resolved via resolveDiningKey —
 * active catalog first, legacy as fallback (a key can only ever exist in
 * one or the other, never both, so this is unambiguous). Shared by the
 * location/canonical-name/parkId lookups below so each one doesn't need to
 * duplicate the active-then-legacy search. Mirrors
 * findEntertainmentPlacesByKey in entertainmentSuggestions.ts.
 */
function findDiningPlacesByKey(key: string): DiningPlace[] {
  const active = DINING_PLACES.filter((p) => normalizeKey(p.name) === key);
  if (active.length > 0) return active;
  return LEGACY_DINING_PLACES.filter((p) => normalizeKey(p.name) === key);
}

/**
 * True when the given activity name matches a known dining location
 * (exact, alias, or containment — see resolveDiningKey). This also returns
 * true for a legacy-only (permanently closed/replaced) identity, since
 * "dining" is still the correct type for it — resolveDiningKey's legacy
 * fallback exists precisely so retired dining is labeled correctly rather
 * than falling back to "attraction"/custom.
 */
export function isDiningName(name: string, resort?: ResortId): boolean {
  return resolveDiningKey(name, resort) !== null;
}

/**
 * Infer a planner item's type from its current activity name.
 * Single source of truth for Add/Edit/import — keeps name-based type
 * inference consistent everywhere a name is entered or changed.
 * resort is passed through to isEntertainmentName so resort-scoped
 * entertainment aliases (e.g. "Halloween Parade") resolve to the correct
 * resort's show instead of guessing; entertainment is checked first since
 * it never overlaps with known dining names.
 */
export function inferPlannerItemType(name: string, resort: ResortId): PlannerItemType {
  if (isEntertainmentName(name, resort)) return "entertainment";
  return isDiningName(name, resort) ? "dining" : "attraction";
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
 * preferring a match within the active resort, falling back to any resort —
 * active catalog first, legacy as fallback (see findDiningPlacesByKey).
 * Returns undefined for unknown/custom names.
 */
export function getDiningLocation(name: string, resort: ResortId): string | undefined {
  const key = resolveDiningKey(name);
  if (!key) return undefined;
  const matches = findDiningPlacesByKey(key);
  if (matches.length === 0) return undefined;
  return pickDiningMatch(matches, resort, name).location;
}

/**
 * Resolve the canonical display name for a dining item's current name,
 * preferring a match within the active resort, falling back to any resort —
 * active catalog first, legacy as fallback (see findDiningPlacesByKey).
 * Returns undefined for unknown/custom names. Mirrors how lookupWait()
 * exposes a canonical attraction name for alias-entered ride titles.
 */
export function getDiningCanonicalName(name: string, resort: ResortId): string | undefined {
  const key = resolveDiningKey(name);
  if (!key) return undefined;
  const matches = findDiningPlacesByKey(key);
  if (matches.length === 0) return undefined;
  return pickDiningMatch(matches, resort, name).name;
}

/** Resort + optional park context for a recognized dining identity. */
export type DiningContext = { resortId: ResortId; parkId: ParkId | null };

/**
 * Resolve the resort + parkId context for a dining item's current name,
 * preferring a match within the active resort, falling back to any resort —
 * active catalog first, legacy as fallback (see findDiningPlacesByKey).
 *
 * This is the lookup park/day/resort-inference consumers (crossDayChecks.ts's
 * inferDayPark, plansContextInference.ts's buildInferenceMap/tryResolve)
 * should use instead of building their own name→parkId map from
 * DINING_PLACES alone, and instead of a parkId-only lookup: a name that
 * resolves to a dining identity with no single-park identity (resort
 * hotels, Downtown Disney, Disney Springs — and legacy identities in the
 * same position, e.g. "Steakhouse 55") must still be distinguishable from a
 * name that doesn't resolve to any dining identity at all, so a
 * recognized-but-permanently-closed, resort-only location (Steakhouse 55)
 * keeps contributing its resort as inference signal exactly like active
 * non-park dining already does via buildInferenceMap's
 * `parkId: d.parkId ?? null`, rather than silently losing all signal
 * because it has no park of its own. A parkId-only lookup can't make that
 * distinction (both cases would read as "no parkId"); returning the whole
 * `{ resortId, parkId }` pair (parkId: null, not undefined, for the
 * no-single-park case) can.
 *
 * Returns undefined only when the name itself doesn't resolve to any known
 * dining identity (active or legacy).
 */
export function getDiningContext(name: string, resort: ResortId): DiningContext | undefined {
  const key = resolveDiningKey(name, resort);
  if (!key) return undefined;
  const matches = findDiningPlacesByKey(key);
  if (matches.length === 0) return undefined;
  const match = pickDiningMatch(matches, resort, name);
  return { resortId: match.resort, parkId: match.parkId ?? null };
}

/**
 * Resolve just the parkId for a dining item's current name — a thin
 * convenience wrapper over getDiningContext for callers that only care
 * about the park (e.g. display), not the resort/no-park distinction.
 * Mirrors getEntertainmentParkId in entertainmentSuggestions.ts. Returns
 * undefined for unknown/custom names or entries with no single-park
 * identity — inference consumers that need to tell those two cases apart
 * should use getDiningContext instead.
 */
export function getDiningParkId(name: string, resort: ResortId): ParkId | undefined {
  return getDiningContext(name, resort)?.parkId ?? undefined;
}

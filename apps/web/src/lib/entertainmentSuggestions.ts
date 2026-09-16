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
 *
 * Catalog refresh note: "The Magic of Disney Animation" (Hollywood
 * Studios) is an umbrella location/collection, not itself an entry here —
 * only its individually plan-worthy pieces are catalogued (Olaf Draws! and
 * Once Upon a Studio Theater). Olaf Draws! is a deliberate scope exception:
 * it isn't a conventional show, but is included because guests plan around
 * it the same way.
 *
 * Active vs. legacy identity: `ENTERTAINMENT_PLACES` is the ACTIVE/current
 * catalog — the only one enumerated by Wait Times (getEntertainmentForPark)
 * and Smart Entry suggestions (getEntertainmentSuggestions). Retired/
 * replaced entertainment that old saved/imported/cloud-restored plans
 * should keep recognizing lives instead in the separate
 * `LEGACY_ENTERTAINMENT_PLACES` list below, which is deliberately NOT
 * exported for enumeration — only `resolveEntertainmentKey` and the
 * name/location/canonical-name/availabilityType/parkId lookups consult it,
 * as a fallback after the active catalog fails to match. This keeps exactly
 * one enumerable "current" catalog while still letting old plan text
 * resolve to its correct historical identity (type, canonical name, and
 * park/location) rather than falling back to "custom/attraction" — this
 * includes park/day inference (crossDayChecks.ts's inferDayPark,
 * plansContextInference.ts's tryResolve), which must use
 * `getEntertainmentParkId` for entertainment items rather than building
 * their own name→parkId map from ENTERTAINMENT_PLACES alone, or a
 * legacy-only Auto day (e.g. one whose only recognizable item is "Together
 * Forever") would fail to recover its historical park despite the name
 * itself resolving correctly.
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
  /**
   * Themed land/area within the park where this entertainment is
   * presented (e.g. "Main Street, U.S.A.", "Frontierland") — distinct from
   * `location`, which is the park-level display label used elsewhere (My
   * Plans Smart Entry, etc.). Uses the same land vocabulary as attraction
   * wait data (packages/shared/src/waitTimes/mock.ts) so Wait Times can
   * filter entertainment and attractions under one shared Land selector
   * without a second land taxonomy. Verified against current show/venue
   * locations as of this catalog revision — not copied from any legacy
   * mock. Omitted only for offerings with no single in-park land (none
   * currently in this dataset).
   */
  land?: string;
  /** Optional recurrence metadata — see EntertainmentAvailabilityType. */
  availabilityType?: EntertainmentAvailabilityType;
  /** Optional seasonal/holiday theme — see EntertainmentTheme. */
  availabilityTheme?: EntertainmentTheme;
};

export const ENTERTAINMENT_PLACES: EntertainmentPlace[] = [
  // ---- Disneyland Park / DCA ----
  // Lifecycle audit note (limited-engagement entries below): "Magic Happens
  // Parade", "Paint the Night", "Main Street Electrical Parade", "Royal
  // Princess Cavalcade", and "Mickey's Mix Magic" are not running today, but
  // are retained as current/plan-worthy — each has an official announced
  // return (Magic Happens: summer 2027) or a well-established recurring
  // revival pattern (Paint the Night, MSEP) with no evidence of permanent
  // discontinuation. Royal Princess Cavalcade and Mickey's Mix Magic have
  // uncertain current status (no confirmed recent run, but also no
  // confirmed end) — kept per "don't guess-remove from schedule absence
  // alone"; flag for re-verification in a future catalog pass. By contrast,
  // "Together Forever — A Pixar Nighttime Spectacular" (Disneyland Park) and
  // "Better Together: A Pixar Pals Celebration!" (DCA) are LEGACY-only (see
  // LEGACY_ENTERTAINMENT_PLACES below) — both were one-off Pixar
  // Fest/70th-Anniversary tie-ins with no standing calendar slot and no
  // announced future return, unlike the recurring-anniversary pattern
  // behind Paint the Night/MSEP.
  { name: "Fantasmic!", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Frontierland", availabilityType: "regular" },
  { name: "World of Color", resort: "DLR", location: "Disney California Adventure", parkId: "dca", land: "Paradise Gardens Park", availabilityType: "regular" },
  { name: "Wondrous Journeys", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Main Street, U.S.A.", availabilityType: "regular" },
  { name: "Magic Happens Parade", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Main Street, U.S.A.", availabilityType: "limited" },
  { name: "Enchanted Tiki Room", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Adventureland", availabilityType: "regular" },
  { name: "Turtle Talk with Crush", resort: "DLR", location: "Disney California Adventure", parkId: "dca", land: "Hollywood Land", availabilityType: "regular" },
  { name: "Paint the Night", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Main Street, U.S.A.", availabilityType: "limited" },
  { name: "Halloween Screams", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Main Street, U.S.A.", availabilityType: "seasonal", availabilityTheme: "halloween" },
  { name: "Believe... in Holiday Magic", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Main Street, U.S.A.", availabilityType: "seasonal", availabilityTheme: "christmas" },
  { name: "A Christmas Fantasy Parade", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Main Street, U.S.A.", availabilityType: "seasonal", availabilityTheme: "christmas" },
  { name: "Frightfully Fun Parade", resort: "DLR", location: "Disney California Adventure", parkId: "dca", land: "Paradise Gardens Park", availabilityType: "seasonal", availabilityTheme: "halloween" },
  { name: "Main Street Electrical Parade", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Main Street, U.S.A.", availabilityType: "limited" },
  { name: "Royal Princess Cavalcade", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Fantasyland", availabilityType: "limited" },
  { name: "Mickey's Mix Magic", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Main Street, U.S.A.", availabilityType: "limited" },
  { name: "Bluey's Best Day Ever!", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Fantasyland", availabilityType: "regular" },
  { name: "Disney Jr. Mickey Mouse Clubhouse Live!", resort: "DLR", location: "Disney California Adventure", parkId: "dca", land: "Hollywood Land", availabilityType: "regular" },
  // Confirmed current for the 2026 Halloween Time season (general park
  // hours, not party-exclusive); has recurred annually since its 2021 debut.
  { name: "Mickey & Friends Halloween Cavalcade", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Main Street, U.S.A.", availabilityType: "seasonal", availabilityTheme: "halloween" },
  // Debuted Aug 18, 2026 as the marquee processional entertainment for
  // Oogie Boogie Bash (separately-ticketed after-hours Halloween party),
  // replacing Frightfully Fun Parade for the 2026 season. Confirmed at
  // Hollywood Land via official/press coverage.
  { name: "Madame Leota's Swinging Wake – A Haunted Mansion Street Party", resort: "DLR", location: "Disney California Adventure", parkId: "dca", land: "Hollywood Land", availabilityType: "seasonal", availabilityTheme: "halloween" },

  // ---- Magic Kingdom ----
  // Hocus Pocus Villain Spelltacular and Mickey's Most Merriest Celebration
  // perform on the Cinderella Castle forecourt stage — grouped under Main
  // Street, U.S.A. (the same land used for the park's other castle-facing
  // hub shows/fireworks) since the castle forecourt/hub isn't a distinct
  // land in the existing land vocabulary.
  { name: "Happily Ever After", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Main Street, U.S.A.", availabilityType: "regular" },
  { name: "Disney Starlight: Dream the Night Away", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Main Street, U.S.A.", availabilityType: "regular" },
  { name: "Festival of Fantasy Parade", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Main Street, U.S.A.", availabilityType: "regular" },
  { name: "Mickey's PhilharMagic", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Fantasyland", availabilityType: "regular" },
  { name: "Enchanted Tiki Room", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Adventureland", availabilityType: "regular" },
  { name: "Country Bear Musical Jamboree", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Frontierland", availabilityType: "regular" },
  { name: "Disney Adventure Friends Cavalcade", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Main Street, U.S.A.", availabilityType: "regular" },
  { name: "Mickey's Boo-To-You Halloween Parade", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Main Street, U.S.A.", availabilityType: "seasonal", availabilityTheme: "halloween" },
  { name: "Mickey's Once Upon a Christmastime Parade", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Main Street, U.S.A.", availabilityType: "seasonal", availabilityTheme: "christmas" },
  { name: "Disney's Not-So-Spooky Spectacular", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Main Street, U.S.A.", availabilityType: "seasonal", availabilityTheme: "halloween" },
  { name: "Hocus Pocus Villain Spelltacular", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Main Street, U.S.A.", availabilityType: "seasonal", availabilityTheme: "halloween" },
  { name: "Minnie's Wonderful Christmastime Fireworks", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Main Street, U.S.A.", availabilityType: "seasonal", availabilityTheme: "christmas" },
  { name: "Mickey's Most Merriest Celebration", resort: "WDW", location: "Magic Kingdom", parkId: "mk", land: "Main Street, U.S.A.", availabilityType: "seasonal", availabilityTheme: "christmas" },

  // ---- EPCOT ----
  { name: "Turtle Talk with Crush", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Nature", availabilityType: "regular" },
  { name: "Luminous The Symphony of Us", resort: "WDW", location: "EPCOT", parkId: "epcot", land: "World Showcase", availabilityType: "regular" },

  // ---- Hollywood Studios ----
  { name: "Fantasmic!", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Sunset Boulevard", availabilityType: "regular" },
  { name: "Beauty and the Beast Live on Stage", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Sunset Boulevard", availabilityType: "regular" },
  { name: "For the First Time in Forever: A Frozen Sing-Along Celebration", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Echo Lake", availabilityType: "regular" },
  { name: "Indiana Jones Epic Stunt Spectacular", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Echo Lake", availabilityType: "regular" },
  { name: "Wonderful World of Animation", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Hollywood Boulevard", availabilityType: "regular" },
  { name: "Disney Movie Magic", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Hollywood Boulevard", availabilityType: "regular" },
  { name: "Disney Villains: Unfairly Ever After", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Sunset Boulevard", availabilityType: "regular" },
  { name: "The Little Mermaid – A Musical Adventure", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Animation Courtyard", availabilityType: "regular" },
  { name: "Disney Jr. Mickey Mouse Clubhouse Live!", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Animation Courtyard", availabilityType: "regular" },
  // ---- Hollywood Studios — The Magic of Disney Animation collection ----
  // The Magic of Disney Animation itself is an umbrella location, not an
  // individual plan-worthy entry. Only its individually plan-worthy pieces
  // are catalogued: Olaf Draws! and Once Upon a Studio Theater. Off the
  // Page! (character meets) and Drawn to Wonderland (play area) are
  // deliberately excluded — out of catalog scope.
  { name: "Olaf Draws!", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Animation Courtyard", availabilityType: "regular" },
  { name: "Once Upon a Studio Theater", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Animation Courtyard", availabilityType: "regular" },

  // ---- Animal Kingdom ----
  { name: "Festival of the Lion King", resort: "WDW", location: "Animal Kingdom", parkId: "ak", land: "Africa", availabilityType: "regular" },
  { name: "Finding Nemo: The Big Blue... and Beyond!", resort: "WDW", location: "Animal Kingdom", parkId: "ak", land: "Asia", availabilityType: "regular" },
  { name: "Zootopia: Better Zoogether!", resort: "WDW", location: "Animal Kingdom", parkId: "ak", land: "Discovery Island", availabilityType: "regular" },

  // ---- Galaxy's Edge experiences (DLR + WDW) ----
  { name: "Savi's Workshop – Handbuilt Lightsabers", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Star Wars: Galaxy’s Edge", availabilityType: "regular" },
  { name: "Savi's Workshop – Handbuilt Lightsabers", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Star Wars: Galaxy’s Edge", availabilityType: "regular" },
  { name: "Droid Depot", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Star Wars: Galaxy’s Edge", availabilityType: "regular" },
  { name: "Droid Depot", resort: "WDW", location: "Hollywood Studios", parkId: "hs", land: "Star Wars: Galaxy’s Edge", availabilityType: "regular" },
];

/**
 * All canonical entertainment offerings presented at a given park, in
 * catalog order. Single source of truth for park-scoped entertainment —
 * consumers (e.g. Wait Times) derive their Entertainment section from this
 * rather than maintaining a page-local list.
 */
export function getEntertainmentForPark(parkId: ParkId): EntertainmentPlace[] {
  return ENTERTAINMENT_PLACES.filter((p) => p.parkId === parkId);
}

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
 * Retired/replaced entertainment identities kept ONLY so that saved,
 * imported, or cloud-restored plan items naming them still resolve to the
 * correct type (entertainment, not "attraction"/custom) and correct
 * historical canonical name/park/location — never for current planning.
 *
 * Deliberately NOT exported and NOT read by getEntertainmentForPark or
 * getEntertainmentSuggestions, so this list structurally cannot reach Wait
 * Times or current Smart Entry suggestions. Only resolveEntertainmentKey
 * (and the lookups built on it — getEntertainmentLocation/
 * getEntertainmentCanonicalName/getEntertainmentAvailabilityType/
 * getEntertainmentParkId) consult it, as a fallback after the active
 * catalog above fails to match. Park/day-inference consumers
 * (crossDayChecks.ts's inferDayPark, plansContextInference.ts's
 * tryResolve) must go through getEntertainmentParkId — not build their own
 * name→parkId map from ENTERTAINMENT_PLACES alone — so a legacy-only Auto
 * day (e.g. its only recognizable item is "Together Forever") still
 * recovers the correct historical park instead of silently losing all
 * park signal despite the name resolving.
 *
 * Add an entry here (never re-add it to ENTERTAINMENT_PLACES) when a
 * current offering is confirmed permanently ended/replaced with no
 * announced recurring return.
 */
const LEGACY_ENTERTAINMENT_PLACES: EntertainmentPlace[] = [
  // Ran at Disneyland Park (Sleeping Beauty Castle / Rivers of America /
  // Main Street, U.S.A.) for Pixar Fest 2018 and again Apr–Aug 2024 —
  // never at DCA. No announced return; Pixar Fest itself has no announced
  // future edition as of this catalog revision.
  { name: "Together Forever — A Pixar Nighttime Spectacular", resort: "DLR", location: "Disneyland Park", parkId: "disneyland", land: "Main Street, U.S.A.", availabilityType: "limited" },
  // Ran at Disney California Adventure for Pixar Fest 2024 and the
  // Disneyland Resort 70th Anniversary 2025; ended Aug 3, 2025. Confirmed
  // not returning in 2026, no 2027 announcement.
  { name: "Better Together: A Pixar Pals Celebration!", resort: "DLR", location: "Disney California Adventure", parkId: "dca", land: "Hollywood Land", availabilityType: "limited" },
];

const LEGACY_ENTERTAINMENT_KEYS: Set<string> = new Set(
  LEGACY_ENTERTAINMENT_PLACES.map((p) => normalizeKey(p.name)),
);

const LEGACY_ENTERTAINMENT_KEYS_BY_RESORT: Record<ResortId, Set<string>> = {
  DLR: new Set(LEGACY_ENTERTAINMENT_PLACES.filter((p) => p.resort === "DLR").map((p) => normalizeKey(p.name))),
  WDW: new Set(LEGACY_ENTERTAINMENT_PLACES.filter((p) => p.resort === "WDW").map((p) => normalizeKey(p.name))),
};

/**
 * Aliases for legacy-only identities — same shape/rules as
 * ENTERTAINMENT_ALIASES, only ever consulted after the active catalog and
 * its aliases fail to match (see resolveEntertainmentKey).
 */
const LEGACY_ENTERTAINMENT_ALIASES: Record<string, string> = {
  "together forever": "together forever a pixar nighttime spectacular",
  "pixar nighttime spectacular": "together forever a pixar nighttime spectacular",
  "better together": "better together a pixar pals celebration",
  "pixar pals celebration": "better together a pixar pals celebration",
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
  "villains unfairly ever after": "disney villains unfairly ever after",
  "unfairly ever after": "disney villains unfairly ever after",
  "little mermaid musical adventure": "the little mermaid a musical adventure",
  "mickey mouse clubhouse live": "disney jr mickey mouse clubhouse live",
  "mickey mouse clubhouse": "disney jr mickey mouse clubhouse live",
  "once upon a studio": "once upon a studio theater",
  "better zoogether": "zootopia better zoogether",
  // World of Color's specific edition (e.g. "– ONE", "Happiness!") rotates
  // over time; the canonical entry stays the durable "World of Color"
  // umbrella name so saved/imported plans keep resolving as editions
  // change, while these aliases let guests enter either current edition
  // name and still land on the same canonical identity.
  "world of color happiness": "world of color",
  "world of color one": "world of color",
  "mickey and friends halloween cavalcade": "mickey friends halloween cavalcade",
  "halloween cavalcade": "mickey friends halloween cavalcade",
  "madame leota's swinging wake": "madame leotas swinging wake a haunted mansion street party",
  "madame leotas swinging wake": "madame leotas swinging wake a haunted mansion street party",
  "leota's swinging wake": "madame leotas swinging wake a haunted mansion street party",
  "swinging wake": "madame leotas swinging wake a haunted mansion street party",
  "haunted mansion street party": "madame leotas swinging wake a haunted mansion street party",
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
 *
 * Legacy fallback: when nothing in the active catalog matches, the same
 * stage-1/stage-3 lookup runs against LEGACY_ENTERTAINMENT_PLACES/
 * LEGACY_ENTERTAINMENT_ALIASES so old saved/imported plan text (e.g.
 * "Together Forever") still resolves — this is the ONLY path legacy
 * identities can be reached through; the active catalog is always tried
 * first and exclusively for anything reachable from Wait Times/current
 * suggestions/park inference (those consumers never call this fallback
 * path with an already-active-resolved key, since active always wins).
 *
 * Returns null when nothing resolves in either catalog.
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

  if (candidate) {
    if (resort && !ENTERTAINMENT_KEYS_BY_RESORT[resort].has(candidate)) return null;
    return candidate;
  }

  // Legacy fallback — only reached when the active catalog found nothing.
  let legacyCandidate: string | null = null;
  if (LEGACY_ENTERTAINMENT_KEYS.has(key)) {
    legacyCandidate = key;
  } else {
    const legacyAliasTarget = LEGACY_ENTERTAINMENT_ALIASES[key];
    if (legacyAliasTarget && LEGACY_ENTERTAINMENT_KEYS.has(legacyAliasTarget)) {
      legacyCandidate = legacyAliasTarget;
    }
  }
  if (!legacyCandidate) return null;
  if (resort && !LEGACY_ENTERTAINMENT_KEYS_BY_RESORT[resort].has(legacyCandidate)) return null;
  return legacyCandidate;
}

/**
 * Find catalog entries by a key already resolved via resolveEntertainmentKey
 * — active catalog first, legacy as fallback (a key can only ever exist in
 * one or the other, never both, so this is unambiguous). Shared by the
 * name/location/canonical-name/availabilityType lookups below so each one
 * doesn't need to duplicate the active-then-legacy search.
 */
function findEntertainmentPlacesByKey(key: string): EntertainmentPlace[] {
  const active = ENTERTAINMENT_PLACES.filter((p) => normalizeKey(p.name) === key);
  if (active.length > 0) return active;
  return LEGACY_ENTERTAINMENT_PLACES.filter((p) => normalizeKey(p.name) === key);
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
  const matches = findEntertainmentPlacesByKey(key);
  if (matches.length === 0) return undefined;
  return (matches.find((p) => p.resort === resort) ?? matches[0]).location;
}

/**
 * Resolve the parkId for an entertainment item's current name, preferring a
 * match within the active resort, falling back to any resort — active
 * catalog first, legacy as fallback (see findEntertainmentPlacesByKey).
 *
 * For park/day-inference consumers (crossDayChecks.ts's inferDayPark,
 * plansContextInference.ts's buildInferenceMap/tryResolve) that need
 * historical park context for recognized-but-retired entertainment (e.g. an
 * imported/cloud-restored Auto day whose only recognizable item is
 * "Together Forever") without enumerating the legacy catalog wholesale —
 * this is the narrow lookup those consumers should use instead of building
 * their own name→parkId map from ENTERTAINMENT_PLACES alone. Returns
 * undefined for unknown/custom names or entries with no single-park
 * identity.
 */
export function getEntertainmentParkId(name: string, resort: ResortId): ParkId | undefined {
  const key = resolveEntertainmentKey(name, resort);
  if (!key) return undefined;
  const matches = findEntertainmentPlacesByKey(key);
  if (matches.length === 0) return undefined;
  return (matches.find((p) => p.resort === resort) ?? matches[0]).parkId;
}

/**
 * Resolve the canonical display name for an entertainment item's current
 * name, preferring a match within the active resort, falling back to any
 * resort. Returns undefined for unknown/custom names.
 */
export function getEntertainmentCanonicalName(name: string, resort: ResortId): string | undefined {
  const key = resolveEntertainmentKey(name, resort);
  if (!key) return undefined;
  const matches = findEntertainmentPlacesByKey(key);
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
  const matches = findEntertainmentPlacesByKey(key);
  if (matches.length === 0) return undefined;
  return (matches.find((p) => p.resort === resort) ?? matches[0]).availabilityType;
}

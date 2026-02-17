/**
 * Mock Wait Times Data
 * Provides realistic sample data for development and testing.
 * In production, this would be replaced with real API data.
 *
 * RIDES ONLY — no shows, parades, fireworks, character meets,
 * galleries, walkthroughs, trails, or play areas.
 */

import type { AttractionWait, ParkId, ResortId, WaitStatus } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Helper to generate a recent ISO timestamp.
 * Creates timestamps within the last 5 minutes for realism.
 */
function recentTimestamp(minutesAgo: number = 0): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - minutesAgo);
  return now.toISOString();
}

/** Minimal definition used to build mock data. */
type RideDef = {
  id: string;
  name: string;
  land: string;
  /** Override default OPERATING status */
  status?: WaitStatus;
  /** Typical wait in minutes (null when non-OPERATING) */
  waitMins?: number | null;
};

/** Expand a compact ride definition into a full AttractionWait object. */
function toAttractionWait(
  ride: RideDef,
  parkId: ParkId,
  resortId: ResortId,
  index: number,
): AttractionWait {
  const status: WaitStatus = ride.status ?? "OPERATING";
  return {
    id: ride.id,
    themeParksId: `TBD-${ride.id}`,
    name: ride.name,
    land: ride.land,
    resortId,
    parkId,
    status,
    waitMins: status === "OPERATING" ? (ride.waitMins ?? 15) : null,
    updatedAt: recentTimestamp(index % 5),
  };
}

// ---------------------------------------------------------------------------
// Disneyland Park — ALL ride attractions (34 rides)
// ---------------------------------------------------------------------------

const DISNEYLAND_RIDES: RideDef[] = [
  // ---- Main Street, U.S.A. ----
  {
    id: "dl-disneyland-railroad",
    name: "Disneyland Railroad",
    land: "Main Street, U.S.A.",
    waitMins: 10,
  },
  // ---- Adventureland ----
  {
    id: "dl-indiana-jones",
    name: "Indiana Jones\u2122 Adventure",
    land: "Adventureland",
    waitMins: 90,
  },
  {
    id: "dl-jungle-cruise",
    name: "Jungle Cruise",
    land: "Adventureland",
    waitMins: 45,
  },

  // ---- New Orleans Square ----
  // Seasonal overlay: Haunted Mansion Holiday (same ride, not a separate entry)
  {
    id: "dl-haunted-mansion",
    name: "Haunted Mansion",
    land: "New Orleans Square",
    waitMins: 55,
  },
  {
    id: "dl-pirates",
    name: "Pirates of the Caribbean",
    land: "New Orleans Square",
    waitMins: 25,
  },

  // ---- Critter Country ----
  {
    id: "dl-davy-crockett-canoes",
    name: "Davy Crockett\u2019s Explorer Canoes",
    land: "Critter Country",
    waitMins: 30,
  },
  {
    id: "dl-tianas-bayou",
    name: "Tiana\u2019s Bayou Adventure",
    land: "Critter Country",
    waitMins: 85,
  },

  // ---- Star Wars: Galaxy's Edge ----
  {
    id: "dl-rise-of-resistance",
    name: "Star Wars: Rise of the Resistance",
    land: "Star Wars: Galaxy\u2019s Edge",
    waitMins: 80,
  },
  {
    id: "dl-smugglers-run",
    name: "Millennium Falcon: Smugglers Run",
    land: "Star Wars: Galaxy\u2019s Edge",
    waitMins: 60,
  },

  // ---- Frontierland ----
  {
    id: "dl-big-thunder",
    name: "Big Thunder Mountain Railroad",
    land: "Frontierland",
    waitMins: 50,
  },
  {
    id: "dl-mark-twain",
    name: "Mark Twain Riverboat",
    land: "Frontierland",
    waitMins: 10,
  },
  {
    id: "dl-sailing-ship-columbia",
    name: "Sailing Ship Columbia",
    land: "Frontierland",
    status: "CLOSED", // seasonal operation
    waitMins: null,
  },

  // ---- Fantasyland ----
  {
    id: "dl-alice-wonderland",
    name: "Alice in Wonderland",
    land: "Fantasyland",
    waitMins: 30,
  },
  {
    id: "dl-casey-jr",
    name: "Casey Jr. Circus Train",
    land: "Fantasyland",
    waitMins: 20,
  },
  {
    id: "dl-dumbo",
    name: "Dumbo the Flying Elephant",
    land: "Fantasyland",
    waitMins: 25,
  },
  {
    id: "dl-its-a-small-world",
    name: "\"it's a small world\"",
    land: "Fantasyland",
    waitMins: 20,
  },
  {
    id: "dl-king-arthur-carrousel",
    name: "King Arthur Carrousel",
    land: "Fantasyland",
    waitMins: 10,
  },
  {
    id: "dl-mad-tea-party",
    name: "Mad Tea Party",
    land: "Fantasyland",
    waitMins: 20,
  },
  {
    id: "dl-matterhorn",
    name: "Matterhorn Bobsleds",
    land: "Fantasyland",
    waitMins: 75,
  },
  {
    id: "dl-mr-toads-wild-ride",
    name: "Mr. Toad\u2019s Wild Ride",
    land: "Fantasyland",
    waitMins: 35,
  },
  {
    id: "dl-peter-pan",
    name: "Peter Pan\u2019s Flight",
    land: "Fantasyland",
    waitMins: 55,
  },
  {
    id: "dl-pinocchio",
    name: "Pinocchio\u2019s Daring Journey",
    land: "Fantasyland",
    waitMins: 15,
  },
  {
    id: "dl-snow-white",
    name: "Snow White\u2019s Enchanted Wish",
    land: "Fantasyland",
    waitMins: 30,
  },
  {
    id: "dl-storybook-land",
    name: "Storybook Land Canal Boats",
    land: "Fantasyland",
    waitMins: 20,
  },

  // ---- Mickey's Toontown ----
  {
    id: "dl-gadgetcoaster",
    name: "Chip \u2019n\u2019 Dale\u2019s GADGETcoaster",
    land: "Mickey\u2019s Toontown",
    waitMins: 25,
  },
  {
    id: "dl-runaway-railway",
    name: "Mickey & Minnie\u2019s Runaway Railway",
    land: "Mickey\u2019s Toontown",
    waitMins: 65,
  },
  {
    id: "dl-roger-rabbit",
    name: "Roger Rabbit\u2019s Car Toon Spin",
    land: "Mickey\u2019s Toontown",
    waitMins: 35,
  },

  // ---- Tomorrowland ----
  {
    id: "dl-astro-orbitor",
    name: "Astro Orbitor",
    land: "Tomorrowland",
    waitMins: 20,
  },
  {
    id: "dl-autopia",
    name: "Autopia",
    land: "Tomorrowland",
    waitMins: 30,
  },
  {
    id: "dl-buzz-lightyear",
    name: "Buzz Lightyear Astro Blasters",
    land: "Tomorrowland",
    waitMins: 35,
  },
  {
    id: "dl-disneyland-monorail",
    name: "Disneyland Monorail",
    land: "Tomorrowland",
    waitMins: 10,
  },
  {
    id: "dl-finding-nemo",
    name: "Finding Nemo Submarine Voyage",
    land: "Tomorrowland",
    status: "DOWN",
    waitMins: null,
  },
  {
    id: "dl-space-mountain",
    name: "Space Mountain",
    land: "Tomorrowland",
    waitMins: 65,
  },
  {
    id: "dl-star-tours",
    name: "Star Tours \u2013 The Adventures Continue",
    land: "Tomorrowland",
    waitMins: 30,
  },
];

// ---------------------------------------------------------------------------
// Disney California Adventure — ALL ride attractions (19 rides)
// ---------------------------------------------------------------------------

const DCA_RIDES: RideDef[] = [
  // ---- Avengers Campus ----
  {
    id: "dca-guardians",
    name: "Guardians of the Galaxy \u2013 Mission: BREAKOUT!",
    land: "Avengers Campus",
    waitMins: 60,
  },
  {
    id: "dca-webslingers",
    name: "WEB SLINGERS: A Spider-Man Adventure",
    land: "Avengers Campus",
    waitMins: 70,
  },

  // ---- Cars Land ----
  {
    id: "dca-luigis",
    name: "Luigi\u2019s Rollickin\u2019 Roadsters",
    land: "Cars Land",
    status: "DOWN",
    waitMins: null,
  },
  {
    id: "dca-maters",
    name: "Mater\u2019s Junkyard Jamboree",
    land: "Cars Land",
    waitMins: 25,
  },
  {
    id: "dca-radiator-springs",
    name: "Radiator Springs Racers",
    land: "Cars Land",
    waitMins: 90,
  },

  // ---- Pixar Pier ----
  {
    id: "dca-incredicoaster",
    name: "Incredicoaster",
    land: "Pixar Pier",
    waitMins: 55,
  },
  {
    id: "dca-inside-out",
    name: "Inside Out Emotional Whirlwind",
    land: "Pixar Pier",
    waitMins: 15,
  },
  {
    id: "dca-jessies-carousel",
    name: "Jessie\u2019s Critter Carousel",
    land: "Pixar Pier",
    waitMins: 10,
  },
  {
    id: "dca-pixar-pal-a-round-swinging",
    name: "Pixar Pal-A-Round - Swinging",
    land: "Pixar Pier",
    waitMins: 25,
  },
  {
    id: "dca-pixar-pal-a-round-non-swinging",
    name: "Pixar Pal-A-Round \u2013 Non-Swinging", // en-dash matches Queue-Times feed
    land: "Pixar Pier",
    waitMins: 20,
  },
  {
    id: "dca-toy-story-midway",
    name: "Toy Story Midway Mania!",
    land: "Pixar Pier",
    waitMins: 65,
  },

  // ---- Grizzly Peak ----
  {
    id: "dca-grizzly-river",
    name: "Grizzly River Run",
    land: "Grizzly Peak",
    status: "CLOSED", // seasonal / weather-dependent
    waitMins: null,
  },
  {
    id: "dca-soarin",
    name: "Soarin\u2019 Around the World",
    land: "Grizzly Peak",
    waitMins: 40,
  },

  // ---- Hollywood Land ----
  {
    id: "dca-monsters-inc",
    name: "Monsters, Inc. Mike & Sulley to the Rescue!",
    land: "Hollywood Land",
    waitMins: 20,
  },

  // ---- Paradise Gardens Park ----
  {
    id: "dca-golden-zephyr",
    name: "Golden Zephyr",
    land: "Paradise Gardens Park",
    waitMins: 15,
  },
  {
    id: "dca-goofy-sky-school",
    name: "Goofy\u2019s Sky School",
    land: "Paradise Gardens Park",
    waitMins: 35,
  },
  {
    id: "dca-jumpin-jellyfish",
    name: "Jumpin\u2019 Jellyfish",
    land: "Paradise Gardens Park",
    waitMins: 15,
  },
  {
    id: "dca-little-mermaid",
    name: "The Little Mermaid ~ Ariel\u2019s Undersea Adventure",
    land: "Paradise Gardens Park",
    waitMins: 10,
  },
  {
    id: "dca-silly-symphony-swings",
    name: "Silly Symphony Swings",
    land: "Paradise Gardens Park",
    waitMins: 20,
  },
];

// ---------------------------------------------------------------------------
// Walt Disney World — Magic Kingdom (5 rides)
// ---------------------------------------------------------------------------

const MK_RIDES: RideDef[] = [
  // ---- Fantasyland ----
  {
    id: "mk-its-a-small-world",
    name: "\"it's a small world\"",
    land: "Fantasyland",
    waitMins: 20,
  },
  {
    id: "mk-peter-pan",
    name: "Peter Pan\u2019s Flight",
    land: "Fantasyland",
    waitMins: 60,
  },

  // ---- Frontierland ----
  {
    id: "mk-big-thunder",
    name: "Big Thunder Mountain Railroad",
    land: "Frontierland",
    waitMins: 45,
  },

  // ---- Liberty Square ----
  {
    id: "mk-haunted-mansion",
    name: "Haunted Mansion",
    land: "Liberty Square",
    waitMins: 50,
  },

  // ---- Tomorrowland ----
  {
    id: "mk-space-mountain",
    name: "Space Mountain",
    land: "Tomorrowland",
    waitMins: 70,
  },
  {
    id: "mk-buzz-lightyear",
    name: "Buzz Lightyear\u2019s Space Ranger Spin",
    land: "Tomorrowland",
    waitMins: 35,
  },
];

// ---------------------------------------------------------------------------
// Walt Disney World — EPCOT (4 rides)
// ---------------------------------------------------------------------------

const EPCOT_RIDES: RideDef[] = [
  // ---- World Discovery ----
  {
    id: "epcot-guardians",
    name: "Guardians of the Galaxy: Cosmic Rewind",
    land: "World Discovery",
    waitMins: 85,
  },
  {
    id: "epcot-test-track",
    name: "Test Track",
    land: "World Discovery",
    status: "CLOSED",
    waitMins: null,
  },

  // ---- World Nature ----
  {
    id: "epcot-soarin",
    name: "Soarin\u2019 Around the World",
    land: "World Nature",
    waitMins: 40,
  },

  // ---- World Showcase ----
  {
    id: "epcot-frozen",
    name: "Frozen Ever After",
    land: "World Showcase",
    waitMins: 55,
  },
  {
    id: "epcot-remys",
    name: "Remy\u2019s Ratatouille Adventure",
    land: "World Showcase",
    waitMins: 35,
  },
];

// ---------------------------------------------------------------------------
// Walt Disney World — Hollywood Studios (5 rides)
// ---------------------------------------------------------------------------

const HS_RIDES: RideDef[] = [
  // ---- Hollywood Boulevard ----
  {
    id: "hs-tower-of-terror",
    name: "The Twilight Zone Tower of Terror",
    land: "Hollywood Boulevard",
    waitMins: 50,
  },
  {
    id: "hs-runaway-railway",
    name: "Mickey \u0026 Minnie\u2019s Runaway Railway",
    land: "Hollywood Boulevard",
    waitMins: 45,
  },

  // ---- Star Wars: Galaxy's Edge ----
  {
    id: "hs-rise-of-resistance",
    name: "Star Wars: Rise of the Resistance",
    land: "Star Wars: Galaxy\u2019s Edge",
    waitMins: 75,
  },
  {
    id: "hs-smugglers-run",
    name: "Millennium Falcon: Smugglers Run",
    land: "Star Wars: Galaxy\u2019s Edge",
    waitMins: 55,
  },

  // ---- Toy Story Land ----
  {
    id: "hs-slinky-dog",
    name: "Slinky Dog Dash",
    land: "Toy Story Land",
    waitMins: 80,
  },

  // ---- Sunset Boulevard ----
  {
    id: "hs-rock-n-roller-coaster",
    name: "Rock 'n' Roller Coaster Starring Aerosmith",
    land: "Sunset Boulevard",
    waitMins: 60,
  },
];

// ---------------------------------------------------------------------------
// Walt Disney World — Animal Kingdom (5 rides)
// ---------------------------------------------------------------------------

const AK_RIDES: RideDef[] = [
  // ---- Pandora ----
  {
    id: "ak-flight-of-passage",
    name: "Avatar Flight of Passage",
    land: "Pandora \u2013 The World of Avatar",
    waitMins: 90,
  },
  {
    id: "ak-navi-river",
    name: "Na\u2019vi River Journey",
    land: "Pandora \u2013 The World of Avatar",
    waitMins: 40,
  },

  // ---- Asia ----
  {
    id: "ak-expedition-everest",
    name: "Expedition Everest",
    land: "Asia",
    waitMins: 60,
  },

  // ---- Africa ----
  {
    id: "ak-kilimanjaro",
    name: "Kilimanjaro Safaris",
    land: "Africa",
    waitMins: 25,
  },

  // ---- DinoLand U.S.A. ----
  {
    id: "ak-dinosaur",
    name: "DINOSAUR",
    land: "DinoLand U.S.A.",
    status: "DOWN",
    waitMins: null,
  },
];

// ---------------------------------------------------------------------------
// Exported mock data — same shape the UI already consumes
// ---------------------------------------------------------------------------

/**
 * Mock attraction wait time data for Disneyland Resort and Walt Disney World.
 * Includes a mix of operating, down, and closed attractions.
 *
 * DLR — Disneyland Park:               34 rides
 * DLR — Disney California Adventure:   19 rides
 * WDW — Magic Kingdom:                  5 rides
 * WDW — EPCOT:                          5 rides
 * WDW — Hollywood Studios:              5 rides
 * WDW — Animal Kingdom:                 5 rides
 */
export const mockAttractionWaits: AttractionWait[] = [
  ...DISNEYLAND_RIDES.map((r, i) => toAttractionWait(r, "disneyland", "DLR", i)),
  ...DCA_RIDES.map((r, i) => toAttractionWait(r, "dca", "DLR", i)),
  ...MK_RIDES.map((r, i) => toAttractionWait(r, "mk", "WDW", i)),
  ...EPCOT_RIDES.map((r, i) => toAttractionWait(r, "epcot", "WDW", i)),
  ...HS_RIDES.map((r, i) => toAttractionWait(r, "hs", "WDW", i)),
  ...AK_RIDES.map((r, i) => toAttractionWait(r, "ak", "WDW", i)),
];

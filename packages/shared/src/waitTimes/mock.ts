/**
 * Mock Wait Times Data
 * Provides realistic sample data for development and testing.
 * In production, this would be replaced with real API data.
 */

import type { AttractionWait } from "./types";

/**
 * Helper to generate a recent ISO timestamp.
 * Creates timestamps within the last 5 minutes for realism.
 */
function recentTimestamp(minutesAgo: number = 0): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() - minutesAgo);
  return now.toISOString();
}

/**
 * Mock attraction wait time data for both Disneyland Resort parks.
 * Includes a mix of operating, down, and closed attractions.
 */
export const mockAttractionWaits: AttractionWait[] = [
  // ============================================
  // DISNEYLAND PARK ATTRACTIONS
  // ============================================

  // Tomorrowland
  {
    id: "dl-space-mountain",
    themeParksId: "TBD-dl-space-mountain",
    name: "Space Mountain",
    land: "Tomorrowland",
    parkId: "disneyland",
    status: "OPERATING",
    waitMins: 65,
    updatedAt: recentTimestamp(1),
  },
  {
    id: "dl-buzz-lightyear",
    themeParksId: "TBD-dl-buzz-lightyear",
    name: "Buzz Lightyear Astro Blasters",
    land: "Tomorrowland",
    parkId: "disneyland",
    status: "OPERATING",
    waitMins: 35,
    updatedAt: recentTimestamp(2),
  },
  {
    id: "dl-finding-nemo",
    themeParksId: "TBD-dl-finding-nemo",
    name: "Finding Nemo Submarine Voyage",
    land: "Tomorrowland",
    parkId: "disneyland",
    status: "DOWN",
    waitMins: null,
    updatedAt: recentTimestamp(3),
  },

  // Fantasyland
  {
    id: "dl-matterhorn",
    themeParksId: "TBD-dl-matterhorn",
    name: "Matterhorn Bobsleds",
    land: "Fantasyland",
    parkId: "disneyland",
    status: "OPERATING",
    waitMins: 75,
    updatedAt: recentTimestamp(1),
  },
  {
    id: "dl-its-a-small-world",
    themeParksId: "TBD-dl-its-a-small-world",
    name: "\"it's a small world\"",
    land: "Fantasyland",
    parkId: "disneyland",
    status: "OPERATING",
    waitMins: 20,
    updatedAt: recentTimestamp(2),
  },
  {
    id: "dl-alice-wonderland",
    themeParksId: "TBD-dl-alice-wonderland",
    name: "Alice in Wonderland",
    land: "Fantasyland",
    parkId: "disneyland",
    status: "OPERATING",
    waitMins: 30,
    updatedAt: recentTimestamp(1),
  },

  // Adventureland
  {
    id: "dl-indiana-jones",
    themeParksId: "TBD-dl-indiana-jones",
    name: "Indiana Jones Adventure",
    land: "Adventureland",
    parkId: "disneyland",
    status: "OPERATING",
    waitMins: 90,
    updatedAt: recentTimestamp(1),
  },
  {
    id: "dl-jungle-cruise",
    themeParksId: "TBD-dl-jungle-cruise",
    name: "Jungle Cruise",
    land: "Adventureland",
    parkId: "disneyland",
    status: "OPERATING",
    waitMins: 45,
    updatedAt: recentTimestamp(3),
  },

  // New Orleans Square
  {
    id: "dl-haunted-mansion",
    themeParksId: "TBD-dl-haunted-mansion",
    name: "Haunted Mansion",
    land: "New Orleans Square",
    parkId: "disneyland",
    status: "OPERATING",
    waitMins: 55,
    updatedAt: recentTimestamp(2),
  },
  {
    id: "dl-pirates",
    themeParksId: "TBD-dl-pirates",
    name: "Pirates of the Caribbean",
    land: "New Orleans Square",
    parkId: "disneyland",
    status: "OPERATING",
    waitMins: 25,
    updatedAt: recentTimestamp(1),
  },

  // Critter Country
  {
    id: "dl-tianas-bayou",
    themeParksId: "TBD-dl-tianas-bayou",
    name: "Tiana's Bayou Adventure",
    land: "Critter Country",
    parkId: "disneyland",
    status: "OPERATING",
    waitMins: 85,
    updatedAt: recentTimestamp(1),
  },

  // Star Wars: Galaxy's Edge
  {
    id: "dl-rise-of-resistance",
    themeParksId: "TBD-dl-rise-of-resistance",
    name: "Star Wars: Rise of the Resistance",
    land: "Star Wars: Galaxy's Edge",
    parkId: "disneyland",
    status: "OPERATING",
    waitMins: 80,
    updatedAt: recentTimestamp(1),
  },
  {
    id: "dl-smugglers-run",
    themeParksId: "TBD-dl-smugglers-run",
    name: "Millennium Falcon: Smugglers Run",
    land: "Star Wars: Galaxy's Edge",
    parkId: "disneyland",
    status: "CLOSED",
    waitMins: null,
    updatedAt: recentTimestamp(5),
  },

  // Frontierland
  {
    id: "dl-big-thunder",
    themeParksId: "TBD-dl-big-thunder",
    name: "Big Thunder Mountain Railroad",
    land: "Frontierland",
    parkId: "disneyland",
    status: "OPERATING",
    waitMins: 50,
    updatedAt: recentTimestamp(2),
  },

  // ============================================
  // DISNEY CALIFORNIA ADVENTURE ATTRACTIONS
  // ============================================

  // Avengers Campus
  {
    id: "dca-webslingers",
    themeParksId: "TBD-dca-webslingers",
    name: "WEB SLINGERS: A Spider-Man Adventure",
    land: "Avengers Campus",
    parkId: "dca",
    status: "OPERATING",
    waitMins: 70,
    updatedAt: recentTimestamp(1),
  },
  {
    id: "dca-guardians",
    themeParksId: "TBD-dca-guardians",
    name: "Guardians of the Galaxy - Mission: BREAKOUT!",
    land: "Avengers Campus",
    parkId: "dca",
    status: "OPERATING",
    waitMins: 60,
    updatedAt: recentTimestamp(2),
  },

  // Cars Land
  {
    id: "dca-radiator-springs",
    themeParksId: "TBD-dca-radiator-springs",
    name: "Radiator Springs Racers",
    land: "Cars Land",
    parkId: "dca",
    status: "OPERATING",
    waitMins: 90,
    updatedAt: recentTimestamp(1),
  },
  {
    id: "dca-luigis",
    themeParksId: "TBD-dca-luigis",
    name: "Luigi's Rollickin' Roadsters",
    land: "Cars Land",
    parkId: "dca",
    status: "DOWN",
    waitMins: null,
    updatedAt: recentTimestamp(4),
  },
  {
    id: "dca-maters",
    themeParksId: "TBD-dca-maters",
    name: "Mater's Junkyard Jamboree",
    land: "Cars Land",
    parkId: "dca",
    status: "OPERATING",
    waitMins: 25,
    updatedAt: recentTimestamp(2),
  },

  // Pixar Pier
  {
    id: "dca-incredicoaster",
    themeParksId: "TBD-dca-incredicoaster",
    name: "Incredicoaster",
    land: "Pixar Pier",
    parkId: "dca",
    status: "OPERATING",
    waitMins: 55,
    updatedAt: recentTimestamp(1),
  },
  {
    id: "dca-toy-story-midway",
    themeParksId: "TBD-dca-toy-story-midway",
    name: "Toy Story Midway Mania!",
    land: "Pixar Pier",
    parkId: "dca",
    status: "OPERATING",
    waitMins: 65,
    updatedAt: recentTimestamp(2),
  },
  {
    id: "dca-inside-out",
    themeParksId: "TBD-dca-inside-out",
    name: "Inside Out Emotional Whirlwind",
    land: "Pixar Pier",
    parkId: "dca",
    status: "OPERATING",
    waitMins: 15,
    updatedAt: recentTimestamp(3),
  },

  // Grizzly Peak
  {
    id: "dca-grizzly-river",
    themeParksId: "TBD-dca-grizzly-river",
    name: "Grizzly River Run",
    land: "Grizzly Peak",
    parkId: "dca",
    status: "CLOSED",
    waitMins: null,
    updatedAt: recentTimestamp(5),
  },
  {
    id: "dca-soarin",
    themeParksId: "TBD-dca-soarin",
    name: "Soarin' Around the World",
    land: "Grizzly Peak",
    parkId: "dca",
    status: "OPERATING",
    waitMins: 40,
    updatedAt: recentTimestamp(1),
  },

  // Hollywood Land
  {
    id: "dca-monsters-inc",
    themeParksId: "TBD-dca-monsters-inc",
    name: "Monsters, Inc. Mike & Sulley to the Rescue!",
    land: "Hollywood Land",
    parkId: "dca",
    status: "OPERATING",
    waitMins: 20,
    updatedAt: recentTimestamp(2),
  },

  // Paradise Gardens Park
  {
    id: "dca-little-mermaid",
    themeParksId: "TBD-dca-little-mermaid",
    name: "The Little Mermaid ~ Ariel's Undersea Adventure",
    land: "Paradise Gardens Park",
    parkId: "dca",
    status: "OPERATING",
    waitMins: 10,
    updatedAt: recentTimestamp(1),
  },
  {
    id: "dca-goofy-sky-school",
    themeParksId: "TBD-dca-goofy-sky-school",
    name: "Goofy's Sky School",
    land: "Paradise Gardens Park",
    parkId: "dca",
    status: "OPERATING",
    waitMins: 35,
    updatedAt: recentTimestamp(2),
  },
];

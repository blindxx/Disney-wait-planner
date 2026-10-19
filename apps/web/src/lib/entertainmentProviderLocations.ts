/**
 * entertainmentProviderLocations.ts — Phase 12.11 explicit locations for
 * provider-only ThemeParks SHOW entities (All Entertainment page).
 *
 * ThemeParks carries coordinates but no land, and DWP never derives a land
 * from a provider name or coordinates. A provider-only entity therefore has a
 * location only when it is listed here: an explicit, park-qualified
 * `parkId + provider UUID` record holding a land from DWP's existing land
 * vocabulary (the same strings the Attractions / Dining / Entertainment
 * catalogs use, e.g. "Main Street, U.S.A.", "World Celebration") and an
 * optional specific venue. Anything not listed stays unknown (no land, shown
 * only under "All Lands") — unknown is correct, never a guess.
 *
 * Verification basis: each record was checked against the park's provider
 * children (entity exists, type SHOW, in that park) and against the park's
 * official layout by the maintainer. Entries whose land could not be
 * established with confidence (roaming bands, event-only shows, venues whose
 * land is ambiguous) are intentionally omitted. Extend this table when a
 * location is verified; do not add a parallel location source.
 *
 * Lookups are exact on park + lowercase UUID, so an id listed for one park
 * never resolves in another. Curated entries keep their land from the
 * Entertainment catalog and never use this table. Pure module.
 *
 * DEV checks (run manually, returns failing labels):
 * runDevEntertainmentProviderLocationCases(); the land-vocabulary check lives
 * in entertainmentAllService.ts (it needs the catalogs).
 */

import type { ParkId } from "@disney-wait-planner/shared";
import type { ThemeParksChildren } from "./themeParksApi";
import { THEMEPARKS_ENTERTAINMENT_MAPPING } from "./themeParksEntertainmentMapping";

export interface ProviderEntertainmentLocation {
  parkId: ParkId;
  /** Provider entity UUID (lowercase). */
  entityId: string;
  /** DWP land vocabulary string for that park. */
  land: string;
  /** Specific venue, only where it adds information beyond the land. */
  venue?: string;
}

const MAIN_ST = "Main Street, U.S.A.";
const GALAXYS_EDGE = "Star Wars: Galaxy’s Edge";
const TOONTOWN = "Mickey’s Toontown";

const loc = (parkId: ParkId, entityId: string, land: string, venue?: string): ProviderEntertainmentLocation =>
  venue ? { parkId, entityId, land, venue } : { parkId, entityId, land };

export const PROVIDER_ENTERTAINMENT_LOCATIONS: ProviderEntertainmentLocation[] = [
  // ---- Disneyland Park ----
  loc("disneyland", "78568c55-6dcb-4893-a14e-ba7ed9bddaff", "Fantasyland"), // Disneyland Band at "it's a small world" Promenade
  loc("disneyland", "cb84b53c-dbb5-483d-a717-00d9259c6484", "Frontierland"), // Disneyland Band at Frontierland
  loc("disneyland", "a6760f7b-3489-47df-9547-d70dd2d8cb76", MAIN_ST), // Disneyland Band at Main Street, U.S.A.
  loc("disneyland", "e9ef1443-c735-43b6-81c6-45e53527cf93", GALAXYS_EDGE), // Fire of the Rising Moons
  loc("disneyland", "eeafc865-a4e0-4dc5-9cea-446108bf7d48", MAIN_ST), // Flag Retreat Ceremony
  loc("disneyland", "3220fd76-38e4-49a4-afa3-4842c07203fa", "New Orleans Square"), // Jambalaya Jazz
  loc("disneyland", "8b12916b-a384-4305-838a-c4b07affbb14", MAIN_ST), // Main Street Piano Player
  loc("disneyland", "7884bda0-7016-4dea-9626-d97372dff10b", MAIN_ST), // Main Street Straw Hatters
  loc("disneyland", "33cbbd09-6d93-40d7-b758-9d7b7d3fd2eb", "Fantasyland", "Royal Hall"), // Meet Disney Princesses at Royal Hall
  loc("disneyland", "5a107a57-9174-4f3f-9be7-625a5d5bb899", TOONTOWN, "Mickey’s House"), // Mickey's House and Meet Mickey Mouse
  loc("disneyland", "72340a8a-b6d2-474f-aca5-5ea7d2d52335", "Fantasyland", "Royal Theatre"), // Storytelling at Royal Theatre
  loc("disneyland", "34f7bd8a-ec8e-41ac-9d63-d94ffc54f1ef", "Fantasyland"), // Tapestry of Happiness
  loc("disneyland", "fdf0e3b1-2eeb-42b4-9516-5d43463d021e", MAIN_ST), // The Dapper Dans

  // ---- Disney California Adventure ----
  loc("dca", "531f6200-393e-4e4d-b95e-aedd30102e49", "Avengers Campus"), // Ancient Sanctum
  loc("dca", "3ee735b5-68dc-470a-a4a2-6ddd415b9cbd", "Avengers Campus"), // Avengers Headquarters
  loc("dca", "0c6c7664-94f0-48b0-91ce-7cc2108a72c9", "Avengers Campus"), // Guardians of the Galaxy: Awesome Dance Off!
  loc("dca", "bdb0a3ec-eb7a-41c9-918f-ccee7194743e", "Avengers Campus"), // The Amazing Spider-Man!
  loc("dca", "1b6a816a-337c-431c-8df6-72f993e15e64", "Avengers Campus"), // Warriors of Wakanda
  loc("dca", "8d4b6d5f-558f-4210-82b5-02b0570232ea", "Buena Vista Street"), // Citizens of Buena Vista Street
  loc("dca", "449e351b-a05a-4a52-8893-0ed5c1f6fc48", "Buena Vista Street"), // Five & Dime
  loc("dca", "4c570f5a-c5da-4388-9804-dd56123d18ce", "Buena Vista Street"), // Meet Disney Pals on Buena Vista Street
  loc("dca", "f71bfc6e-2f10-40a1-bf29-a4b98c5350f4", "Cars Land"), // Meet the Residents of Radiator Springs in Cars Land
  loc("dca", "dca741a6-3472-4d4f-a9aa-7774aae81754", "Paradise Gardens Park"), // Paradise Garden Bandstand

  // ---- Magic Kingdom ----
  loc("mk", "1eee22e8-1d0a-4809-a42b-df3ae55c69d5", MAIN_ST), // The Dapper Dans
  loc("mk", "51392ca4-f824-42d8-8808-8110ec8e0e22", MAIN_ST), // Main Street Philharmonic
  loc("mk", "a0613b70-293f-4a5b-8169-357be1777c62", MAIN_ST, "Casey’s Corner"), // Casey's Corner Pianist
  loc("mk", "1c708beb-41e1-43ae-8dd8-1e85075aeb38", MAIN_ST), // Flag Retreat
  loc("mk", "a2d92647-634d-4eb4-886b-9da858e871f1", MAIN_ST, "Town Square Theater"), // Meet Mickey at Town Square Theater
  loc("mk", "40737d3d-0ff6-4a9e-a050-beb87bf90120", "Fantasyland", "Princess Fairytale Hall"), // Meet Cinderella and a Visiting Princess
  loc("mk", "cf4b2ba4-3626-4de7-9d07-abe8a65b1665", "Fantasyland", "Princess Fairytale Hall"), // Meet Princess Tiana and a Visiting Princess
  loc("mk", "012a211b-4c91-451c-8a0e-5e3ab398eda8", "Fantasyland", "Ariel’s Grotto"), // Meet Ariel at Her Grotto
  loc("mk", "166f2985-7b27-4eff-a8b3-29c3448ba198", "Fantasyland", "Pete’s Silly Sideshow"), // Meet Daring Disney Pals as Circus Stars
  loc("mk", "b5d6d1d1-e960-4c8f-a8a4-b9748b386b64", "Fantasyland", "Pete’s Silly Sideshow"), // Meet Dashing Disney Pals as Circus Stars

  // ---- EPCOT ----
  loc("epcot", "fd8afd63-0cb5-4f77-b47b-fb277f12d9f8", "World Celebration", "CommuniCore Plaza"), // ¡Celebración Encanto!
  loc("epcot", "3beaa9a5-6404-4446-bfd1-e0d0eea65e85", "World Celebration"), // JAMMitors
  loc("epcot", "76eadac1-cdfa-45e5-a25c-54ed4c3a604f", "World Showcase", "Mexico"), // Marimba de las Américas
  loc("epcot", "ea730d0c-7723-429d-89a4-9e76f053f5ac", "World Showcase", "Mexico"), // Mariachi Cobre
  loc("epcot", "c5f6c7e4-d5cd-4d71-8e02-57d8bb43b3ba", "World Showcase", "The American Adventure"), // Voices of Liberty
  loc("epcot", "296d164a-8b9a-49d3-a285-637b86731260", "World Showcase", "Japan"), // Matsuriza
  loc("epcot", "6e70f3fb-faab-41b1-8d26-b85d1c5cfa26", "World Showcase", "Canada"), // Entertainment at Canada Mill Stage
  loc("epcot", "8e1a9a60-9311-4f79-b6a8-1b5172e4f7c9", "World Showcase", "Germany"), // Entertainment at Germany Gazebo
  loc("epcot", "41aba635-48e4-43bf-9bb1-3b811b5705d0", "World Showcase", "United Kingdom"), // Rose & Crown Pub Musician
  loc("epcot", "33bd3bad-6803-4c5e-97ac-f7e31261a604", "World Showcase", "Norway"), // Meet Anna and Elsa at Royal Sommerhus
  loc("epcot", "a70b81bf-2934-433c-9723-afb2f24112bf", "World Nature", "ImageWorks"), // Meet Figment Inside ImageWorks

  // ---- Hollywood Studios ----
  loc("hs", "343de9f4-e100-4a52-9285-0fcc3a486603", GALAXYS_EDGE), // First Order Searches for the Resistance
  loc("hs", "bc2c2ffe-3cf0-4e75-a408-bf5e86515c4c", "Toy Story Land"), // Green Army Drum Corps
  loc("hs", "eea07a8d-30e0-42d8-9c47-58cc038801e8", "Toy Story Land"), // Meet the Toys in Toy Story Land
  loc("hs", "c113b1cf-7b6d-416a-8e21-bf8f387ecd77", "Animation Courtyard", "Walt Disney Presents"), // Meet Ariel at Walt Disney Presents

  // ---- Animal Kingdom ----
  loc("ak", "d8497541-53a2-4206-b95f-39cb238ae511", "Africa", "Harambe Village"), // Tam Tam Drummers of Harambe
  loc("ak", "a8781403-1344-4c06-89ef-b7a39b99ae59", "Africa", "Harambe Village"), // Harambe Village Street Band – Burudika
  loc("ak", "a08d9f84-fbdf-45f3-9b68-645d296de307", "Discovery Island"), // DiVine
  loc("ak", "2a55aee6-c87a-4bda-a3d4-b022693a62a3", "Discovery Island", "Tree of Life"), // Tree of Life Awakenings
  loc("ak", "13d7c9d1-a785-403d-9ba8-71fee2f02d55", "Discovery Island", "Adventurers Outpost"), // Meet Favorite Disney Pals at Adventurers Outpost
  loc("ak", "d8214ba6-22a7-4a92-8977-bae3779d5c4c", "Asia", "Anandapur Theater"), // Feathered Friends in Flight!
];

const byKey = new Map<string, ProviderEntertainmentLocation>();
for (const l of PROVIDER_ENTERTAINMENT_LOCATIONS) byKey.set(`${l.parkId}:${l.entityId.toLowerCase()}`, l);

/** Exact, park-qualified lookup. Unlisted (or listed for a different park) → undefined: location unknown. */
export function getProviderEntertainmentLocation(parkId: ParkId, entityId: string): ProviderEntertainmentLocation | undefined {
  return byKey.get(`${parkId}:${entityId.toLowerCase()}`);
}

/**
 * Verify the table against provider children (run with fresh `getChildren`
 * payloads): every record must exist in its park's children as a SHOW.
 * Returns problem strings; empty = verified.
 */
export function verifyProviderEntertainmentLocations(
  childrenByPark: Partial<Record<ParkId, ThemeParksChildren>>,
  locations: ProviderEntertainmentLocation[] = PROVIDER_ENTERTAINMENT_LOCATIONS,
): string[] {
  const problems: string[] = [];
  for (const l of locations) {
    const payload = childrenByPark[l.parkId];
    if (!payload) { problems.push(`${l.parkId}: no children payload supplied`); continue; }
    const child = payload.children.find((c) => c.entityId.toLowerCase() === l.entityId.toLowerCase());
    if (!child) problems.push(`${l.parkId}:${l.entityId} not in park children`);
    else if (child.entityType !== "SHOW") problems.push(`${l.parkId}:${l.entityId} is ${child.entityType}, expected SHOW`);
  }
  return problems;
}

/** DEV: structural checks (offline). Returns failing labels. */
export function runDevEntertainmentProviderLocationCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const keys = PROVIDER_ENTERTAINMENT_LOCATIONS.map((l) => `${l.parkId}:${l.entityId}`);
  check("locations: park-qualified keys unique", new Set(keys).size === keys.length);
  check("locations: ids are lowercase UUIDs", PROVIDER_ENTERTAINMENT_LOCATIONS.every((l) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(l.entityId)));
  check("locations: an entity id belongs to exactly one park", new Set(PROVIDER_ENTERTAINMENT_LOCATIONS.map((l) => l.entityId)).size === PROVIDER_ENTERTAINMENT_LOCATIONS.length);
  check("locations: land non-empty, venue (if any) non-empty", PROVIDER_ENTERTAINMENT_LOCATIONS.every((l) => l.land.trim() && (l.venue === undefined || l.venue.trim())));
  const curatedIds = new Set(THEMEPARKS_ENTERTAINMENT_MAPPING.flatMap((m) => (m.disposition === "mapped" ? m.provider.map((r) => r.entityId.toLowerCase()) : [])));
  check("locations: never targets a curated-mapped entity (curated land comes from the catalog)", PROVIDER_ENTERTAINMENT_LOCATIONS.every((l) => !curatedIds.has(l.entityId)));
  const parksCovered = new Set(PROVIDER_ENTERTAINMENT_LOCATIONS.map((l) => l.parkId));
  check("locations: all six parks covered", parksCovered.size === 6);
  const enc = getProviderEntertainmentLocation("epcot", "FD8AFD63-0CB5-4F77-B47B-FB277F12D9F8");
  check("lookup: case-insensitive uuid, land + venue", enc?.land === "World Celebration" && enc.venue === "CommuniCore Plaza");
  check("lookup: venue optional", getProviderEntertainmentLocation("epcot", "3beaa9a5-6404-4446-bfd1-e0d0eea65e85")?.venue === undefined);
  check("lookup: park-qualified (same uuid, wrong park → unknown)", getProviderEntertainmentLocation("mk", "fd8afd63-0cb5-4f77-b47b-fb277f12d9f8") === undefined);
  check("lookup: unlisted → unknown", getProviderEntertainmentLocation("hs", "ffffffff-ffff-4fff-8fff-ffffffffffff") === undefined);
  const fake: Partial<Record<ParkId, ThemeParksChildren>> = {
    epcot: { entityId: "e", name: "e", entityType: "THEME_PARK", timeZone: null, droppedEntries: 0, children: [{ entityId: "fd8afd63-0cb5-4f77-b47b-fb277f12d9f8", name: "x", entityType: "SHOW", parentId: null, externalId: null, slug: null, location: null }] },
  };
  const one = [PROVIDER_ENTERTAINMENT_LOCATIONS.find((l) => l.parkId === "epcot" && l.venue === "CommuniCore Plaza")!];
  check("verify: present SHOW passes", verifyProviderEntertainmentLocations(fake, one).length === 0);
  check("verify: missing park payload / entity / wrong type flagged",
    verifyProviderEntertainmentLocations({}, one).length === 1 &&
    verifyProviderEntertainmentLocations({ epcot: { ...fake.epcot!, children: [] } }, one).length === 1 &&
    verifyProviderEntertainmentLocations({ epcot: { ...fake.epcot!, children: [{ ...fake.epcot!.children[0], entityType: "ATTRACTION" }] } }, one).length === 1);
  return failures;
}

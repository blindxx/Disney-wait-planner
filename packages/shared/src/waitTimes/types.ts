/**
 * Wait Times Types
 * Defines the shape of attraction wait time data for Disney parks.
 */

/** Supported resort identifiers */
export type ResortId = "DLR" | "WDW";

/** Supported park identifiers */
export type ParkId =
  // Disneyland Resort (DLR)
  | "disneyland"
  | "dca"
  // Walt Disney World (WDW)
  | "mk"
  | "epcot"
  | "hs"
  | "ak";

/** Possible operational statuses for an attraction */
export type WaitStatus = "OPERATING" | "DOWN" | "CLOSED";

/** Represents wait time data for a single attraction */
export type AttractionWait = {
  /** Unique identifier for the attraction (e.g., "dl-space-mountain") */
  id: string;
  /** ThemeParks.wiki entity ID placeholder (e.g., "TBD-dl-space-mountain") */
  themeParksId: string;
  /** Display name of the attraction */
  name: string;
  /** Themed land where the attraction is located (optional) */
  land?: string;
  /** Which resort this attraction belongs to */
  resortId: ResortId;
  /** Which park this attraction belongs to */
  parkId: ParkId;
  /** Current operational status */
  status: WaitStatus;
  /** Current wait time in minutes (null if not operating) */
  waitMins: number | null;
  /** ISO timestamp of when this data was last updated */
  updatedAt: string;
};

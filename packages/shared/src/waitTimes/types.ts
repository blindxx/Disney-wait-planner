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
  /**
   * Provenance of the numeric `waitMins` currently displayed for this
   * attraction: "live" when it was overlaid from usable Queue-Times live
   * data (including a live 0-minute wait, and Railroad-style multi-station
   * aggregation of live data), "fallback" when no usable live match exists
   * and `waitMins`/`status` are DWP's own mock/fallback values instead.
   * Consumers must read this field rather than inferring provenance from
   * `waitMins`, `status`, or `updatedAt`.
   */
  waitSource: "live" | "fallback";
};

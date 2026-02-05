/**
 * Wait Times Types
 * Defines the shape of attraction wait time data for Disney parks.
 */

/** Supported park identifiers */
export type ParkId = "disneyland" | "dca";

/** Possible operational statuses for an attraction */
export type WaitStatus = "OPERATING" | "DOWN" | "CLOSED";

/** Represents wait time data for a single attraction */
export type AttractionWait = {
  /** Unique identifier for the attraction (e.g., "dl-space-mountain") */
  id: string;
  /** Display name of the attraction */
  name: string;
  /** Themed land where the attraction is located (optional) */
  land?: string;
  /** Which park this attraction belongs to */
  parkId: ParkId;
  /** Current operational status */
  status: WaitStatus;
  /** Current wait time in minutes (null if not operating) */
  waitMins: number | null;
  /** ISO timestamp of when this data was last updated */
  updatedAt: string;
};

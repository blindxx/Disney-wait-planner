export type ParkId = "DL" | "DCA";

// Wait Times
export type { AttractionWait } from "./waitTimes/types";
export { mockAttractionWaits } from "./waitTimes/mock";
/**
 * Shared Package Exports
 * Central export point for all shared types and utilities.
 */

// Wait Times module - types and mock data for attraction wait times
export * from "./waitTimes";

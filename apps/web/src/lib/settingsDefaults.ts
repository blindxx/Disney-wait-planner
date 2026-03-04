/**
 * Settings defaults helper — Phase 7.1
 *
 * Reads user-configured defaults from localStorage (set on /settings).
 * Used as fallback initializers on pages that have no page-specific stored state.
 *
 * localStorage keys:
 *   dw:settings:defaultResort  — "DLR" | "WDW"
 *   dw:settings:defaultPark    — park id string
 */

import { type ParkId, type ResortId } from "@disney-wait-planner/shared";

export const SETTINGS_RESORT_KEY = "dw:settings:defaultResort";
export const SETTINGS_PARK_KEY = "dw:settings:defaultPark";

const RESORT_FIRST_PARK: Record<ResortId, ParkId> = {
  DLR: "disneyland",
  WDW: "mk",
};

const VALID_PARKS: Record<ResortId, ParkId[]> = {
  DLR: ["disneyland", "dca"],
  WDW: ["mk", "epcot", "hs", "ak"],
};

/**
 * Returns the user's configured default resort and park.
 * Falls back to DLR + Disneyland if no settings exist.
 * Ensures defaultPark is valid for the chosen resort.
 *
 * Must only be called client-side (localStorage access).
 */
export function getSettingsDefaults(): { defaultResort: ResortId; defaultPark: ParkId } {
  if (typeof window === "undefined") {
    return { defaultResort: "DLR", defaultPark: "disneyland" };
  }
  try {
    const storedResort = localStorage.getItem(SETTINGS_RESORT_KEY);
    const resort: ResortId =
      storedResort === "DLR" || storedResort === "WDW" ? storedResort : "DLR";

    const storedPark = localStorage.getItem(SETTINGS_PARK_KEY);
    const validParks = VALID_PARKS[resort] as string[];
    const park: ParkId =
      storedPark && validParks.includes(storedPark)
        ? (storedPark as ParkId)
        : RESORT_FIRST_PARK[resort];

    return { defaultResort: resort, defaultPark: park };
  } catch {
    return { defaultResort: "DLR", defaultPark: "disneyland" };
  }
}

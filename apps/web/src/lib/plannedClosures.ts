/**
 * plannedClosures.ts — Single source of truth for planned attraction closures.
 *
 * Exports:
 *   PLANNED_CLOSURES  — Map<key, ClosureEntry> for all known refurbishments.
 *   getClosureTiming  — Date-aware timing: "UPCOMING" | "ACTIVE" | "ENDED".
 *   ClosureTiming     — Type for the timing result.
 *
 * Key format: `${parkId}:${normalizedAttractionName}` (lowercase, straight punctuation).
 * This matches the output of normalizeAttractionName() in liveWaitApi.ts.
 *
 * Consumed by:
 *   liveWaitApi.ts    — live status enforcement (force CLOSED when ACTIVE).
 *   wait-times/page.tsx — Planned Closures UI section.
 */

import type { ParkId } from "@disney-wait-planner/shared";

// ============================================
// TYPES
// ============================================

export type ClosureTiming = "UPCOMING" | "ACTIVE" | "ENDED";

export type ClosureEntry = {
  /** Display name (e.g., "Jungle Cruise"). */
  name: string;
  parkId: ParkId;
  land?: string;
  /**
   * ISO date range for timing logic.
   * Format: "YYYY-MM-DD - YYYY-MM-DD" or "YYYY-MM-DD - TBD" (open-ended).
   * Undefined = indefinite closure (always ACTIVE).
   */
  dateRange?: string;
  /** Human-readable date range for UI display (e.g., "Feb 17, 2026 \u2013 TBD"). */
  displayDateRange?: string;
};

// ============================================
// DATE HELPERS
// ============================================

/**
 * Convert a Date to "YYYY-MM-DD" in the local timezone.
 */
export function normalizeToDayKeyLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Parse an ISO date range string into start and end components.
 * Supports:
 *   "2026-02-17 - 2026-02-26"  → { start: "2026-02-17", end: "2026-02-26" }
 *   "2026-02-17 - TBD"         → { start: "2026-02-17", end: null }
 */
export function parseClosureDateRange(
  range: string,
): { start: string; end: string | null } {
  const parts = range.split(" - ");
  const start = parts[0].trim();
  const endStr = parts[1]?.trim();
  const end =
    !endStr || endStr.toUpperCase() === "TBD" ? null : endStr;
  return { start, end };
}

/**
 * Determine the closure timing relative to now.
 *
 * - undefined dateRange  → always "ACTIVE" (indefinite refurbishment)
 * - start > today        → "UPCOMING"
 * - end !== null && end < today → "ENDED"
 * - otherwise            → "ACTIVE"
 */
export function getClosureTiming(
  dateRange: string | undefined,
  now: Date,
): ClosureTiming {
  if (!dateRange) return "ACTIVE";

  const todayKey = normalizeToDayKeyLocal(now);
  const { start, end } = parseClosureDateRange(dateRange);

  if (todayKey < start) return "UPCOMING";
  if (end !== null && todayKey > end) return "ENDED";
  return "ACTIVE";
}

// ============================================
// PLANNED CLOSURES DATA
// ============================================

/**
 * All known planned closures (refurbishments).
 * Manually updated Feb 2026.
 *
 * Key: `${parkId}:${normalizedAttractionName}` — must match
 *      normalizeAttractionName() output in liveWaitApi.ts.
 */
export const PLANNED_CLOSURES = new Map<string, ClosureEntry>([
  // ---- DLR: Disneyland Park ----
  [
    "disneyland:jungle cruise",
    {
      name: "Jungle Cruise",
      parkId: "disneyland",
      land: "Adventureland",
      dateRange: "2026-02-17 - TBD",
      displayDateRange: "Feb 17, 2026 \u2013 TBD",
    },
  ],
  [
    "disneyland:space mountain",
    {
      name: "Space Mountain",
      parkId: "disneyland",
      land: "Tomorrowland",
      dateRange: "2026-02-23 - 2026-02-26",
      displayDateRange: "Feb 23 \u2013 26, 2026",
    },
  ],
  [
    "disneyland:great moments with mr. lincoln",
    {
      name: "Great Moments with Mr. Lincoln",
      parkId: "disneyland",
      land: "Main Street, U.S.A.",
    },
  ],
  // ---- DLR: Disney California Adventure ----
  [
    "dca:grizzly river run",
    {
      name: "Grizzly River Run",
      parkId: "dca",
      land: "Grizzly Peak",
    },
  ],
  [
    "dca:jumpin' jellyfish",
    {
      name: "Jumpin\u2019 Jellyfish",
      parkId: "dca",
      land: "Paradise Gardens Park",
      dateRange: "2026-02-23 - 2026-03-05",
      displayDateRange: "Feb 23 \u2013 Mar 5, 2026",
    },
  ],
  [
    "dca:golden zephyr",
    {
      name: "Golden Zephyr",
      parkId: "dca",
      land: "Paradise Gardens Park",
      dateRange: "2026-03-09 - 2026-03-17",
      displayDateRange: "Mar 9 \u2013 17, 2026",
    },
  ],
  // ---- WDW: EPCOT ----
  [
    "epcot:test track",
    {
      name: "Test Track",
      parkId: "epcot",
      land: "World Discovery",
      dateRange: "2026-01-09 - TBD",
      displayDateRange: "Jan 9 \u2013 Late 2026",
    },
  ],
]);

/**
 * plannedClosures.ts — Single source of truth for planned attraction closures.
 *
 * Exports:
 *   PLANNED_CLOSURES                  — Map<key, ClosureEntry>
 *   getClosureTiming                  — "UPCOMING" | "ACTIVE" | "ENDED"
 *   formatClosureDateRangeForDisplay  — ISO dateRange → human-readable label
 *   ClosureTiming                     — type
 *
 * Key format: `${parkId}:${normalizedAttractionName}` (lowercase, straight punctuation).
 * This matches the output of normalizeAttractionName() in liveWaitApi.ts.
 *
 * Consumed by:
 *   liveWaitApi.ts        — live status enforcement (force CLOSED when ACTIVE).
 *   wait-times/page.tsx   — Planned Closures UI section.
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
   * ISO date range for timing logic AND display (via formatClosureDateRangeForDisplay).
   * Format: "YYYY-MM-DD - YYYY-MM-DD" or "YYYY-MM-DD - TBD" (open-ended).
   * Undefined = indefinite closure (always ACTIVE).
   */
  dateRange?: string;
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
 * - undefined dateRange              → "ACTIVE" (indefinite refurbishment)
 * - today < start                    → "UPCOMING" (closure has not started)
 * - end !== null && today > end      → "ENDED"   (closure is over)
 * - otherwise (on/after start)       → "ACTIVE"
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
// DISPLAY FORMATTER
// ============================================

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Format an ISO date string "YYYY-MM-DD" as "Mon D, YYYY" (no leading zero on day).
 * Returns the original string if it cannot be parsed.
 */
function formatIsoDate(iso: string): string {
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (isNaN(y) || isNaN(m) || isNaN(d) || m < 1 || m > 12) return iso;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/**
 * Convert an ISO dateRange to a human-readable display label.
 *
 * Examples:
 *   undefined                        → "TBD"
 *   "2026-02-17 - TBD"               → "Feb 17, 2026 – TBD"
 *   "2026-02-23 - 2026-02-26"        → "Feb 23, 2026 – Feb 26, 2026"
 *
 * Never throws — returns the raw string (or "TBD") on any parse failure.
 */
export function formatClosureDateRangeForDisplay(
  dateRange: string | undefined,
): string {
  if (!dateRange) return "TBD";
  try {
    const { start, end } = parseClosureDateRange(dateRange);
    const startLabel = formatIsoDate(start);
    const endLabel = end === null ? "TBD" : formatIsoDate(end);
    return `${startLabel} \u2013 ${endLabel}`;
  } catch {
    return dateRange || "TBD";
  }
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
    },
  ],
  [
    "disneyland:space mountain",
    {
      name: "Space Mountain",
      parkId: "disneyland",
      land: "Tomorrowland",
      dateRange: "2026-02-23 - 2026-02-26",
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
    },
  ],
  [
    "dca:golden zephyr",
    {
      name: "Golden Zephyr",
      parkId: "dca",
      land: "Paradise Gardens Park",
      dateRange: "2026-03-09 - 2026-03-17",
    },
  ],
  // ---- WDW: Magic Kingdom ----
  [
    "mk:big thunder mountain railroad",
    {
      name: "Big Thunder Mountain Railroad",
      parkId: "mk",
      land: "Frontierland",
      dateRange: "2025-01-01 - 2026-05-01",
    },
  ],
  [
    "mk:buzz lightyear's space ranger spin",
    {
      name: "Buzz Lightyear\u2019s Space Ranger Spin",
      parkId: "mk",
      land: "Tomorrowland",
      dateRange: "2025-08-04 - 2026-05-01",
    },
  ],
  // ---- WDW: Hollywood Studios ----
  [
    "hs:rock 'n' roller coaster starring aerosmith",
    {
      name: "Rock \u2019n\u2019 Roller Coaster Starring Aerosmith",
      parkId: "hs",
      land: "Sunset Boulevard",
      dateRange: "2026-03-02 - 2026-07-15",
    },
  ],
  // ---- WDW: Animal Kingdom ----
  [
    "ak:dinosaur",
    {
      name: "DINOSAUR",
      parkId: "ak",
      land: "DinoLand U.S.A.",
      dateRange: "2026-02-02 - TBD",
    },
  ],
]);

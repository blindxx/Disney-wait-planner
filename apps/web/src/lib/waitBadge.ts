/**
 * waitBadge.ts — Single source of truth for wait-time badge logic.
 *
 * All threshold comparisons (30 / 60) live here so every page uses identical
 * boundary values.  Two helpers are provided for the two visual patterns used:
 *
 *  getWaitBadgeProps — full badge (colored background + label)
 *                       used by: wait-times/page.tsx, plans/page.tsx
 *
 *  getFallbackStatusLabel — provenance caption for a DOWN/CLOSED badge whose
 *                       status came from DWP mock/fallback data (waitSource)
 *                       used by: wait-times, plans, lightning
 *
 *  getWaitTextColor  — text-only color for a large wait number on white bg
 *                       used by: page.tsx (Today / home)
 *
 * Thresholds (DO NOT change here — change only here):
 *   < 30  → green
 *   30–59 → yellow
 *   ≥ 60  → red
 *
 * Statuses:
 *   DOWN   → orange  ("Down")
 *   CLOSED → gray    ("Closed")
 */

import { mockAttractionWaits, type WaitStatus } from "@disney-wait-planner/shared";

// Allow callers that have status typed as `string` (e.g. waitMap in plans/page.tsx)
// without losing the precise union when callers already have WaitStatus.
type StatusInput = WaitStatus | string;

// ---------------------------------------------------------------------------
// Internal color maps — copied verbatim from the pages they replace.
// Each value is a theme variable (defined only on dark-converted routes, see
// globals.css) with the original light color as the fallback.
// ---------------------------------------------------------------------------

/** Inline-style colors for badge spans (colored background + dark text). */
const BADGE_STYLE = {
  green:  { backgroundColor: "var(--wait-green-bg, #dcfce7)", color: "var(--wait-green-fg, #166534)" },
  yellow: { backgroundColor: "var(--wait-yellow-bg, #fef9c3)", color: "var(--wait-yellow-fg, #854d0e)" },
  red:    { backgroundColor: "var(--wait-red-bg, #fee2e2)", color: "var(--wait-red-fg, #991b1b)" },
  orange: { backgroundColor: "var(--wait-orange-bg, #ffedd5)", color: "var(--wait-orange-fg, #c2410c)" },
  gray:   { backgroundColor: "var(--wait-gray-bg, #f3f4f6)", color: "var(--wait-gray-fg, #6b7280)" },
} as const;

/** Text-only colors for the home page wait-number display (on a white background). */
const TEXT_COLOR = {
  green:  "var(--wait-text-green, #16a34a)",
  yellow: "var(--wait-text-yellow, #d97706)",
  red:    "var(--wait-text-red, #dc2626)",
} as const;

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Returns the label and inline backgroundColor/color for a wait badge span.
 *
 * Returns `null` when status is OPERATING but waitMins is unknown — callers
 * decide how to handle that edge case (show "—" or render nothing).
 *
 * Boundary check:
 *   29 → green  |  30 → yellow  |  59 → yellow  |  60 → red
 */
export function getWaitBadgeProps(args: {
  status: StatusInput;
  waitMins: number | null;
}): { label: string; style: { backgroundColor: string; color: string } } | null {
  const { status, waitMins } = args;

  if (status === "DOWN")   return { label: "Down",   style: BADGE_STYLE.orange };
  if (status === "CLOSED") return { label: "Closed", style: BADGE_STYLE.gray   };
  if (waitMins == null)    return null;

  const label = `${waitMins} min`;
  if (waitMins < 30) return { label, style: BADGE_STYLE.green  };
  if (waitMins < 60) return { label, style: BADGE_STYLE.yellow };
  return                   { label, style: BADGE_STYLE.red     };
}

/**
 * Returns a text-only color for the home page's large wait-number display.
 * These are lighter / more saturated shades suitable for text on a white background
 * (intentionally different from the darker badge text colors).
 *
 * Boundary check:
 *   29 → green  |  30 → yellow  |  59 → yellow  |  60 → red
 */
export function getWaitTextColor(waitMins: number): string {
  if (waitMins < 30) return TEXT_COLOR.green;
  if (waitMins < 60) return TEXT_COLOR.yellow;
  return TEXT_COLOR.red;
}

// ---------------------------------------------------------------------------
// Fallback status provenance
// ---------------------------------------------------------------------------

export const FALLBACK_STATUS_LABEL = "Fallback status \u00b7 not live";

/**
 * Provenance caption for a DOWN/CLOSED badge. Returns FALLBACK_STATUS_LABEL
 * only when the explicit `waitSource` field says the row is DWP mock/fallback
 * data (never inferred from status/waitMins/timestamps); live rows, rows with
 * missing provenance, and OPERATING rows return null. OPERATING fallback rows
 * keep their existing numeric "Fallback wait" caption (Wait Times page).
 * Display-only: no effect on status resolution or closure enforcement.
 */
export function getFallbackStatusLabel(args: {
  status: StatusInput;
  waitSource?: "live" | "fallback" | string | null;
}): string | null {
  return args.waitSource === "fallback" && (args.status === "DOWN" || args.status === "CLOSED")
    ? FALLBACK_STATUS_LABEL
    : null;
}

/**
 * DEV checks (run manually from Node; returns failing labels, [] = all pass).
 */
export function runDevFallbackStatusLabelCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  check("fallback CLOSED null wait → status label", getFallbackStatusLabel({ status: "CLOSED", waitSource: "fallback" }) === FALLBACK_STATUS_LABEL);
  check("fallback DOWN null wait → status label", getFallbackStatusLabel({ status: "DOWN", waitSource: "fallback" }) === FALLBACK_STATUS_LABEL);
  check("fallback OPERATING (numeric or null wait) → no status label", getFallbackStatusLabel({ status: "OPERATING", waitSource: "fallback" }) === null);
  check("live CLOSED → no label", getFallbackStatusLabel({ status: "CLOSED", waitSource: "live" }) === null);
  check("live DOWN → no label", getFallbackStatusLabel({ status: "DOWN", waitSource: "live" }) === null);
  check("live OPERATING → no label", getFallbackStatusLabel({ status: "OPERATING", waitSource: "live" }) === null);
  check("missing provenance is never treated as fallback", getFallbackStatusLabel({ status: "DOWN" }) === null && getFallbackStatusLabel({ status: "CLOSED", waitSource: null }) === null);
  const mockClosed = mockAttractionWaits.find((m) => m.status === "CLOSED" && m.waitMins === null);
  check("real mock CLOSED/null-wait row (waitSource fallback) → status label", !!mockClosed && getFallbackStatusLabel({ status: mockClosed.status, waitSource: mockClosed.waitSource }) === FALLBACK_STATUS_LABEL);
  check("badge unchanged by provenance (CLOSED → Closed, DOWN → Down)", getWaitBadgeProps({ status: "CLOSED", waitMins: null })?.label === "Closed" && getWaitBadgeProps({ status: "DOWN", waitMins: null })?.label === "Down");
  return failures;
}

/**
 * plannerWarnings.ts — shared legacy/refurbishment presentation logic for
 * planner-item cards (My Plans, Lightning Lane).
 *
 * Single source for the exact wording and date-range/window semantics of:
 *   - the recognized-legacy-identity warning ("⚠ No longer operating")
 *   - the attraction refurbishment notice ("⚠ Closed for refurbishment • …" /
 *     "ⓘ Refurbishment scheduled • …")
 *
 * This module owns no lifecycle/closure data of its own — it only formats
 * what the maintained read contracts already resolve:
 *   - getPlannerItemMetadata() (plannerItemMetadata.ts) — canonical
 *     identity/lifecycle. Callers resolve this themselves (the dayResort
 *     precedence and any cross-resort combination is a presentation
 *     decision specific to each surface's location display) and pass the
 *     resulting `lifecycle`/`canonicalName`/`parkId` in here.
 *   - getClosureWindowForAttraction() (plannedClosures.ts) — the raw
 *     maintained closure/refurbishment window.
 *
 * A PERMANENT closure window is deliberately never rendered as a
 * refurbishment notice: canonical lifecycle (recognized-legacy identity)
 * stays the sole "No longer operating" signal, and a closureType is never
 * inferred into legacy status here or anywhere else.
 */

import type { ParkId } from "@disney-wait-planner/shared";
import {
  getClosureWindowForAttraction,
  formatClosureDateRangeForDisplay,
  normalizeToDayKeyLocal,
  type ClosureWindow,
} from "./plannedClosures";

/** Fixed wording for a recognized legacy (no-longer-operating) identity. */
export const LEGACY_ATTRACTION_WARNING = "⚠ No longer operating";

export type RefurbishmentLine = { text: string; variant: "warning" | "info" };

/** Minimal ISO "YYYY-MM-DD" calendar-date validator (rejects "2025-02-30", etc). */
function isValidIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split("-");
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (y < 2000 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(y, m - 1, d);
  return (
    date.getFullYear() === y &&
    date.getMonth() === m - 1 &&
    date.getDate() === d
  );
}

const CLOSURE_DATE_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "Mon D, YYYY" — mirrors plannedClosures.ts's own (private) date formatting. */
function formatClosureIsoDate(iso: string): string {
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (isNaN(y) || isNaN(m) || isNaN(d) || m < 1 || m > 12) return iso;
  return `${CLOSURE_DATE_MONTHS[m - 1]} ${d}, ${y}`;
}

/**
 * "<date range>" portion of the refurbishment line. An open-ended closure
 * (no maintained end date) never invents a reopening date — it renders
 * "Starting <date>" instead of a range.
 */
function closureDateRangeLabel(window: ClosureWindow): string {
  if (window.startDate && window.endDate) {
    return formatClosureDateRangeForDisplay(
      `${window.startDate} - ${window.endDate}`,
      undefined,
      window.closureType
    );
  }
  if (window.startDate) {
    return `Starting ${formatClosureIsoDate(window.startDate)}`;
  }
  return formatClosureDateRangeForDisplay(undefined, undefined, window.closureType);
}

/**
 * Where an ISO "YYYY-MM-DD" date falls relative to a closure's maintained
 * window: "before" a future start, "inside" the window, or "after" a
 * bounded window's end. An undated start never counts as "before" (an
 * indefinite closure has already begun); an open-ended (null) end never
 * counts as "after" — it has no end to have passed.
 */
function classifyDateAgainstClosureWindow(
  date: string,
  window: ClosureWindow
): "before" | "inside" | "after" {
  if (window.startDate && date < window.startDate) return "before";
  if (window.endDate && date > window.endDate) return "after";
  return "inside";
}

/**
 * Attraction-only refurbishment indicator, sourced entirely from the
 * maintained getClosureWindowForAttraction() read contract — never from
 * canonical lifecycle. A PERMANENT closure window is deliberately skipped
 * here (never rendered as "refurbishment"): canonical lifecycle (recognized
 * legacy identity) stays the sole "No longer operating" signal, and this
 * module doesn't invent a distinct permanent-closure wording of its own.
 *
 * A bounded (non-open-ended) window that has already ended never shows a
 * notice — neither "warning" (a known plan date's visit already passed the
 * window's end) nor "scheduled" (there's nothing left to schedule). With no
 * usable plan date, "ended" is judged against today's date via the same
 * local-day-key convention plannedClosures.ts uses internally
 * (normalizeToDayKeyLocal) — never inventing a plan date.
 *
 * Critically, an undated card can only ever resolve "scheduled" (info) or
 * no notice — never the "warning" variant. The warning specifically means
 * "the known plan date conflicts with this closure"; falling back to
 * today's date for classification must not be read as such a conflict.
 */
export function resolveRefurbishmentLine(
  canonicalName: string | undefined,
  parkId: ParkId | undefined,
  planDate: string | undefined
): RefurbishmentLine | undefined {
  if (!canonicalName || !parkId) return undefined;
  const window = getClosureWindowForAttraction(canonicalName, parkId);
  if (!window || window.closureType === "PERMANENT") return undefined;

  const usablePlanDate = planDate && isValidIsoCalendarDate(planDate) ? planDate : undefined;
  const referenceDate = usablePlanDate ?? normalizeToDayKeyLocal(new Date());
  const position = classifyDateAgainstClosureWindow(referenceDate, window);
  if (position === "after") return undefined;

  const rangeLabel = closureDateRangeLabel(window);
  if (usablePlanDate && position === "inside") {
    return { text: `⚠ Closed for refurbishment • ${rangeLabel}`, variant: "warning" };
  }
  // Either a dated plan before a future window, or no usable plan date and
  // the window isn't over yet (still upcoming, active, or open-ended).
  return { text: `ⓘ Refurbishment scheduled • ${rangeLabel}`, variant: "info" };
}

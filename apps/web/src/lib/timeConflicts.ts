/**
 * Shared time conflict detection engine for My Plans and Lightning Lane.
 *
 * All time strings must already be in internal canonical "H:MM" 24h format
 * (as produced by timeUtils). Callers are responsible for normalization before
 * passing items here.
 */

/** Convert canonical "H:MM" internal format to minutes from midnight. Returns -1 if invalid. */
function toMinutes(t: string): number {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return -1;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export type ConflictResult = {
  /** IDs of items where end <= start (invalid time range). */
  invalidRanges: string[];
  /** Unique pairs of IDs whose time ranges overlap. Ordered by first appearance index. */
  overlaps: Array<{ a: string; b: string }>;
};

/**
 * Detect time conflicts in a list of items with optional end times.
 *
 * Rules:
 * - Items without a valid start time are ignored.
 * - Invalid range: end exists and end <= start → id added to invalidRanges.
 * - Overlap: startA < endB AND startB < endA (standard interval overlap test).
 * - Items without an end time are treated as non-overlapping (no bounded range).
 * - Overlap pairs are unique, ordered by index in the input array (i < j).
 */
export function detectTimeConflicts(
  items: Array<{ id: string; start: string; end?: string }>
): ConflictResult {
  const invalidRanges: string[] = [];
  const overlaps: Array<{ a: string; b: string }> = [];

  type Parsed = { id: string; startMin: number; endMin: number | null };
  const parsed: Parsed[] = [];

  for (const item of items) {
    const startMin = toMinutes(item.start);
    if (startMin < 0) continue; // skip items without a valid start time

    let endMin: number | null = null;
    if (item.end) {
      const e = toMinutes(item.end);
      if (e >= 0) {
        endMin = e;
        if (e <= startMin) {
          invalidRanges.push(item.id);
        }
      }
    }

    parsed.push({ id: item.id, startMin, endMin });
  }

  // Filter to valid items only — invalid ranges (end <= start) must not pollute
  // the overlap calculation and cause false positives on unrelated valid items.
  const validItems = parsed.filter(
    (p) => p.endMin !== null && p.endMin > p.startMin
  );

  // Overlap check — only between valid items (both have a bounded, valid end time)
  for (let i = 0; i < validItems.length; i++) {
    for (let j = i + 1; j < validItems.length; j++) {
      const a = validItems[i];
      const b = validItems[j];
      // endMin is guaranteed non-null and > startMin by the filter above
      if (a.startMin < b.endMin! && b.startMin < a.endMin!) {
        overlaps.push({ a: a.id, b: b.id });
      }
    }
  }

  return { invalidRanges, overlaps };
}

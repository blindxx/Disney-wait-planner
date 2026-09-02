/**
 * plannedClosures.ts — Single source of truth for planned attraction closures.
 *
 * Exports:
 *   PLANNED_CLOSURES                  — Map<key, ClosureEntry>
 *   getClosureTiming                  — "UPCOMING" | "ACTIVE" | "ENDED" (PRESENTATION only)
 *   isClosureStatusEnforced           — boolean (STATUS ENFORCEMENT only)
 *   formatClosureDateRangeForDisplay  — ISO dateRange → human-readable label
 *   ClosureTiming, ClosureType        — types
 *   PERMANENT_RETENTION_DAYS          — days a PERMANENT closure stays in the
 *                                        active Planned Closures presentation
 *                                        after its closure date before aging out
 *
 * Closure lifecycle (ClosureEntry.closureType, optional, defaults to
 * "TEMPORARY" for back-compat with every existing record):
 *   "TEMPORARY" — refurbishment; may have a known end date, an open-ended
 *                 TBD end date, or attraction-specific reopening wording
 *                 (reopeningLabel). Never treated as "Reopening TBD" unless
 *                 reopeningLabel is explicitly set — open-ended closures
 *                 default to a neutral "TBD".
 *   "PERMANENT" — always displays "Closed Permanently"; stays in the active
 *                 Planned Closures *presentation* for PERMANENT_RETENTION_DAYS
 *                 (~1 year) after its dateRange start, then deterministically
 *                 ages out of that presentation only (the record, canonical
 *                 attraction data, aliases, and planner matching are
 *                 untouched) — AND keeps forcing live status CLOSED forever,
 *                 independent of that presentation retention window. These
 *                 are two intentionally separate concerns, split across
 *                 getClosureTiming() (presentation) and
 *                 isClosureStatusEnforced() (status enforcement) — do not
 *                 use one in place of the other.
 *
 * Key format: `${parkId}:${normalizedAttractionName}` (lowercase, straight punctuation).
 * This matches the output of normalizeAttractionName() in liveWaitApi.ts.
 *
 * Consumed by:
 *   liveWaitApi.ts        — live status enforcement, via isClosureStatusEnforced().
 *   wait-times/page.tsx   — Planned Closures UI section, via getClosureTiming().
 */

import type { ParkId } from "@disney-wait-planner/shared";

// ============================================
// TYPES
// ============================================

export type ClosureTiming = "UPCOMING" | "ACTIVE" | "ENDED";

/**
 * Closure lifecycle type.
 *   "TEMPORARY" — refurbishment; expected to reopen (known date or TBD).
 *   "PERMANENT" — attraction is not expected to reopen.
 * Omit for existing/refurbishment records — defaults to "TEMPORARY"
 * everywhere it's read, so no migration of existing entries is required.
 */
export type ClosureType = "TEMPORARY" | "PERMANENT";

export type ClosureEntry = {
  /** Display name (e.g., "Jungle Cruise"). */
  name: string;
  parkId: ParkId;
  land?: string;
  /**
   * ISO date range for timing logic AND display (via formatClosureDateRangeForDisplay).
   * Format: "YYYY-MM-DD - YYYY-MM-DD" or "YYYY-MM-DD - TBD" (open-ended).
   * Undefined = indefinite closure (always ACTIVE).
   *
   * For a PERMANENT closure, the start date doubles as the closure date
   * used by the retention/aging-out window (see PERMANENT_RETENTION_DAYS) —
   * there is no separate "closedOn" field.
   */
  dateRange?: string;
  /**
   * Optional override for the open-ended ("TBD") end-date label, e.g.
   * "Reopening TBD" for a closure that is expected to reopen eventually.
   * Only used when dateRange has no known end date (or is undefined) AND
   * closureType is "TEMPORARY" (or omitted). Omit for indefinite closures
   * with no confirmed reopening — the formatter defaults to a neutral
   * "TBD" in that case. Ignored for "PERMANENT" closures, which always
   * display "Closed Permanently" instead.
   */
  reopeningLabel?: string;
  /**
   * Closure lifecycle type. Omit for existing records (refurbishments) —
   * defaults to "TEMPORARY". Set to "PERMANENT" only when repository
   * evidence (official Disney announcement, not speculation) confirms the
   * attraction will not reopen.
   */
  closureType?: ClosureType;
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
 * How long a PERMANENT closure stays in the active Planned Closures list
 * after its closure date (dateRange start), before deterministically aging
 * out. Aging out only affects getClosureTiming()'s active-list presentation
 * — it never touches canonical attraction data, aliases, planner matching,
 * saved plans, or (critically) live status enforcement, which is governed
 * separately by isClosureStatusEnforced() and never expires for a
 * PERMANENT closure.
 */
export const PERMANENT_RETENTION_DAYS = 365;

/**
 * Add `days` to an ISO "YYYY-MM-DD" string and return the result in the
 * same format. Uses UTC internally purely to avoid DST arithmetic bugs —
 * the result is a plain calendar date, compared as a string exactly like
 * every other date in this module. Returns null if `iso` cannot be parsed.
 */
function addDaysToIsoDate(iso: string, days: number): string | null {
  const parts = iso.split("-");
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map((p) => parseInt(p, 10));
  if ([y, m, d].some((n) => isNaN(n))) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Determine the closure timing relative to now.
 *
 * TEMPORARY (default, unchanged from prior behavior):
 * - undefined dateRange              → "ACTIVE" (indefinite refurbishment)
 * - today < start                    → "UPCOMING" (closure has not started)
 * - end !== null && today > end      → "ENDED"   (closure is over)
 * - otherwise (on/after start)       → "ACTIVE"
 *
 * PERMANENT:
 * - undefined dateRange              → "ACTIVE" (closure date unknown —
 *                                       never invent one; can't age out)
 * - today < start                    → "UPCOMING" (announced future closure)
 * - today > start + PERMANENT_RETENTION_DAYS → "ENDED" (aged out of the
 *                                       active list; the record itself is
 *                                       untouched)
 * - otherwise (on/after start, within retention window) → "ACTIVE"
 */
export function getClosureTiming(
  dateRange: string | undefined,
  now: Date,
  closureType: ClosureType = "TEMPORARY",
): ClosureTiming {
  if (!dateRange) return "ACTIVE";

  const todayKey = normalizeToDayKeyLocal(now);
  const { start, end } = parseClosureDateRange(dateRange);

  if (todayKey < start) return "UPCOMING";

  if (closureType === "PERMANENT") {
    const retentionCutoff = addDaysToIsoDate(start, PERMANENT_RETENTION_DAYS);
    if (retentionCutoff !== null && todayKey > retentionCutoff) return "ENDED";
    return "ACTIVE";
  }

  if (end !== null && todayKey > end) return "ENDED";
  return "ACTIVE";
}

/**
 * Determine whether a closure should force live status to CLOSED right now.
 *
 * Deliberately separate from getClosureTiming(): that function's "ENDED"
 * result for a PERMANENT closure means only "aged out of the active Planned
 * Closures *presentation*" (see PERMANENT_RETENTION_DAYS) — it must NOT be
 * read as "no longer closed". A PERMANENT closure is never expected to
 * reopen, so once it starts it keeps forcing CLOSED forever, independent of
 * the ~1-year presentation retention window. Using getClosureTiming's
 * ACTIVE/ENDED result for status enforcement was the bug: after retention
 * expired, a permanently closed attraction could fall through to
 * Queue-Times and show as DOWN/OPERATING.
 *
 * TEMPORARY (default, unchanged from prior behavior — identical to
 * `getClosureTiming(...) === "ACTIVE"`):
 * - undefined dateRange              → true  (indefinite refurbishment)
 * - today < start                    → false (UPCOMING — not yet closed)
 * - end !== null && today > end      → false (ENDED — closure is over)
 * - otherwise (on/after start)       → true
 *
 * PERMANENT:
 * - undefined dateRange              → true  (closure date unknown, but the
 *                                       attraction is still permanently closed)
 * - today < start                    → false (UPCOMING — not yet closed)
 * - otherwise (on/after start)       → true  (forever — retention window
 *                                       does not apply to enforcement)
 */
export function isClosureStatusEnforced(
  dateRange: string | undefined,
  now: Date,
  closureType: ClosureType = "TEMPORARY",
): boolean {
  if (!dateRange) return true;

  const todayKey = normalizeToDayKeyLocal(now);
  const { start, end } = parseClosureDateRange(dateRange);

  if (todayKey < start) return false;

  if (closureType === "PERMANENT") return true;

  if (end !== null && todayKey > end) return false;
  return true;
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

/** Fixed display label for any PERMANENT closure, regardless of dateRange. */
export const PERMANENTLY_CLOSED_LABEL = "Closed Permanently";

/**
 * Convert an ISO dateRange to a human-readable display label.
 *
 * closureType "PERMANENT" always renders PERMANENTLY_CLOSED_LABEL
 * ("Closed Permanently"), regardless of dateRange or openEndedLabel.
 *
 * For closureType "TEMPORARY" (default, unchanged from prior behavior),
 * open-ended ("TBD") end dates default to a neutral "TBD" label. Pass
 * `openEndedLabel` (from ClosureEntry.reopeningLabel) to override that
 * label for a specific closure — e.g. "Reopening TBD" for a closure
 * known to be temporary. Closures with no expected reopening should
 * omit reopeningLabel and keep the neutral default — never invent a
 * "Reopening TBD" label for an open-ended closure without evidence.
 *
 * Examples:
 *   undefined                                    → "TBD"
 *   "2026-02-17 - TBD"                            → "Feb 17, 2026 – TBD"
 *   "2026-02-17 - TBD", "Reopening TBD"           → "Feb 17, 2026 – Reopening TBD"
 *   "2026-02-23 - 2026-02-26"                     → "Feb 23, 2026 – Feb 26, 2026"
 *   (any dateRange), (any), "PERMANENT"           → "Closed Permanently"
 *
 * Never throws — returns the raw string (or "TBD") on any parse failure.
 */
export function formatClosureDateRangeForDisplay(
  dateRange: string | undefined,
  openEndedLabel?: string,
  closureType: ClosureType = "TEMPORARY",
): string {
  if (closureType === "PERMANENT") return PERMANENTLY_CLOSED_LABEL;

  const label = openEndedLabel ?? "TBD";
  if (!dateRange) return label;
  try {
    const { start, end } = parseClosureDateRange(dateRange);
    const startLabel = formatIsoDate(start);
    const endLabel = end === null ? label : formatIsoDate(end);
    return `${startLabel} \u2013 ${endLabel}`;
  } catch {
    return dateRange || label;
  }
}

// ============================================
// PLANNED CLOSURES DATA
// ============================================

/**
 * All known planned closures (refurbishments).
 * Manually updated Mar 2026.
 *
 * Key: `${parkId}:${normalizedAttractionName}` — must match
 *      normalizeAttractionName() output in liveWaitApi.ts.
 */
export const PLANNED_CLOSURES = new Map<string, ClosureEntry>([
  // ---- DLR: Disneyland Park ----
  // (no active Disneyland Resort closures)
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
      dateRange: "2025-08-04 - 2026-04-08",
    },
  ],
  [
    "mk:walt disney's carousel of progress",
    {
      name: "Walt Disney\u2019s Carousel of Progress",
      parkId: "mk",
      land: "Tomorrowland",
      dateRange: "2026-07-06 - TBD",
      reopeningLabel: "Reopening TBD",
    },
  ],
  // ---- WDW: Hollywood Studios ----
  [
    "hs:rock 'n' roller coaster starring the muppets",
    {
      name: "Rock \u2019n\u2019 Roller Coaster Starring The Muppets",
      parkId: "hs",
      land: "Sunset Boulevard",
      dateRange: "2026-03-02 - 2026-05-25",
    },
  ],
  // ---- WDW: Animal Kingdom ----
  // Permanent closure confirmed — not expected to reopen. dateRange's start
  // (2026-02-02) is the closure date and doubles as the retention/aging-out
  // anchor (see PERMANENT_RETENTION_DAYS); the "TBD" end is irrelevant for
  // PERMANENT display (formatClosureDateRangeForDisplay always renders
  // "Closed Permanently" for this closureType) but is kept so dateRange
  // still parses as a normal start/end pair.
  [
    "ak:dinosaur",
    {
      name: "DINOSAUR",
      parkId: "ak",
      land: "DinoLand U.S.A.",
      dateRange: "2026-02-02 - TBD",
      closureType: "PERMANENT",
    },
  ],
]);

// ============================================
// DEV-ONLY VALIDATION
// ============================================

/**
 * Reference test cases for getClosureTiming() [PRESENTATION] +
 * isClosureStatusEnforced() [STATUS ENFORCEMENT] + formatClosureDateRangeForDisplay(),
 * covering the temporary/permanent lifecycle split, the permanent-closure
 * presentation retention/aging-out window, and — critically — that status
 * enforcement for a PERMANENT closure never expires even after it ages out
 * of the active Planned Closures presentation (that was the P2 bug: a
 * permanently closed attraction could fall through to Queue-Times as
 * DOWN/OPERATING once retention expired). Mirrors the DEV_PLAN_ALIAS_CASES
 * convention in plansMatching.ts — not wired into CI (no test runner in
 * this repo), run manually from Node:
 *
 *   import {
 *     DEV_CLOSURE_TIMING_CASES, getClosureTiming,
 *     isClosureStatusEnforced, formatClosureDateRangeForDisplay,
 *   } from "@/lib/plannedClosures";
 *   for (const c of DEV_CLOSURE_TIMING_CASES) {
 *     const now = new Date(`${c.now}T12:00:00`);
 *     const timing = getClosureTiming(c.dateRange, now, c.closureType);
 *     const enforced = isClosureStatusEnforced(c.dateRange, now, c.closureType);
 *     const label = formatClosureDateRangeForDisplay(c.dateRange, c.reopeningLabel, c.closureType);
 *     const ok = timing === c.expectedTiming && enforced === c.expectedEnforced && label === c.expectedLabel;
 *     console.log(ok ? "✓" : "✗ FAIL", c.description, { timing, enforced, label });
 *   }
 */
export const DEV_CLOSURE_TIMING_CASES: Array<{
  description: string;
  dateRange: string | undefined;
  reopeningLabel?: string;
  closureType?: ClosureType;
  /** "YYYY-MM-DD" — evaluated at local noon to avoid DST/midnight edge cases. */
  now: string;
  /** Expected getClosureTiming() result — active-list PRESENTATION only. */
  expectedTiming: ClosureTiming;
  /** Expected isClosureStatusEnforced() result — live STATUS ENFORCEMENT only. */
  expectedEnforced: boolean;
  expectedLabel: string;
}> = [
  // ---- TEMPORARY: known end date (unchanged prior behavior) ----
  {
    description: "temporary, active, known end date",
    expectedEnforced: true,
    dateRange: "2026-03-02 - 2026-05-25",
    now: "2026-04-01",
    expectedTiming: "ACTIVE",
    expectedLabel: "Mar 2, 2026 – May 25, 2026",
  },
  {
    description: "temporary, upcoming, known end date",
    expectedEnforced: false,
    dateRange: "2026-03-02 - 2026-05-25",
    now: "2026-01-01",
    expectedTiming: "UPCOMING",
    expectedLabel: "Mar 2, 2026 – May 25, 2026",
  },
  {
    description: "temporary, ended, known end date",
    expectedEnforced: false,
    dateRange: "2026-03-02 - 2026-05-25",
    now: "2026-06-01",
    expectedTiming: "ENDED",
    expectedLabel: "Mar 2, 2026 – May 25, 2026",
  },
  // ---- TEMPORARY: open-ended (TBD) — custom reopening wording ----
  {
    description: "temporary, open-ended, custom Reopening TBD wording (Carousel of Progress)",
    expectedEnforced: true,
    dateRange: "2026-07-06 - TBD",
    reopeningLabel: "Reopening TBD",
    now: "2026-08-01",
    expectedTiming: "ACTIVE",
    expectedLabel: "Jul 6, 2026 – Reopening TBD",
  },
  // ---- TEMPORARY: open-ended, no override — must stay neutral "TBD", never invented ----
  {
    description: "temporary, open-ended, no reopeningLabel stays neutral TBD (never invented)",
    expectedEnforced: true,
    dateRange: "2026-02-02 - TBD",
    now: "2026-08-01",
    expectedTiming: "ACTIVE",
    expectedLabel: "Feb 2, 2026 – TBD",
  },
  // ---- PERMANENT: active, inside retention window ----
  {
    description: "permanent, active, well inside 1-year retention window",
    expectedEnforced: true,
    dateRange: "2026-01-15 - TBD",
    closureType: "PERMANENT",
    now: "2026-03-01",
    expectedTiming: "ACTIVE",
    expectedLabel: "Closed Permanently",
  },
  // ---- PERMANENT: still active exactly at the retention boundary ----
  {
    description: "permanent, active, exactly on the 365-day retention boundary",
    expectedEnforced: true,
    dateRange: "2025-01-01 - TBD",
    closureType: "PERMANENT",
    now: "2026-01-01", // 2025-01-01 + 365 days
    expectedTiming: "ACTIVE",
    expectedLabel: "Closed Permanently",
  },
  // ---- PERMANENT: aged out of PRESENTATION the day after the retention
  // boundary, but status enforcement must NOT expire (P2 regression case:
  // ENDED presentation + still-true enforcement, together, is the fix). ----
  {
    description: "permanent, ages out of presentation the day after retention, enforcement stays true",
    expectedEnforced: true,
    dateRange: "2025-01-01 - TBD",
    closureType: "PERMANENT",
    now: "2026-01-02",
    expectedTiming: "ENDED",
    expectedLabel: "Closed Permanently",
  },
  // ---- PERMANENT: years past retention — enforcement still never expires ----
  {
    description: "permanent, years past retention, presentation hidden but still force-CLOSED",
    expectedEnforced: true,
    dateRange: "2025-01-01 - TBD",
    closureType: "PERMANENT",
    now: "2028-06-15",
    expectedTiming: "ENDED",
    expectedLabel: "Closed Permanently",
  },
  // ---- PERMANENT: announced but not yet in effect ----
  {
    description: "permanent, upcoming (announced future closure date)",
    expectedEnforced: false,
    dateRange: "2026-12-25 - TBD",
    closureType: "PERMANENT",
    now: "2026-08-01",
    expectedTiming: "UPCOMING",
    expectedLabel: "Closed Permanently",
  },
  // ---- PERMANENT: no known closure date — never invented, stays ACTIVE ----
  {
    description: "permanent, no dateRange, never ages out (no date to compute from)",
    expectedEnforced: true,
    dateRange: undefined,
    closureType: "PERMANENT",
    now: "2030-01-01",
    expectedTiming: "ACTIVE",
    expectedLabel: "Closed Permanently",
  },
  // ---- Legacy records without closureType behave exactly as before ----
  {
    description: "legacy record with no closureType field behaves as TEMPORARY",
    expectedEnforced: true,
    dateRange: "2025-01-01 - 2026-05-01",
    now: "2025-06-01",
    expectedTiming: "ACTIVE",
    expectedLabel: "Jan 1, 2025 – May 1, 2026",
  },
];

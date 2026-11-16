/**
 * entertainmentLifecycleDetector.ts — Phase 14.5C pure decision logic for the
 * active entertainment lifecycle (automated hide / restore / re-hide). No I/O:
 * the scheduled monitor (entertainmentLifecycleMonitor.ts) feeds it provider
 * showtimes and stored evidence; the store (entertainmentLifecycleStore.ts)
 * persists what it decides.
 *
 * Evidence unit = one canonical show × one resort-local date, classified as:
 *   active   a VERIFIED current performance exists for the date;
 *   inactive credible provider evidence of zero activity (the existing 14.4.1/
 *            14.4.2 `confirmedNoActivityToday`, from a fresh, complete payload
 *            of a park with healthy coverage) — or a validated history "dark" day;
 *   silent   the show's own provider entities published nothing while the park
 *            as a whole is healthy (show-specific silence). NEVER inactive;
 *   unknown  everything else (failures, stale/partial data, CLOSED alone, an
 *            unhealthy park). Never counts toward anything.
 * Unmapped shows produce NO observation (a nonexistent provider observation is
 * never inferred), so they can never be hidden automatically.
 *
 * Rules (identical for `regular` and `limited`; seasonal/holiday/festival/party
 * entries and legacy/unknown identities are never evaluated):
 *   HIDE      ≥ 21 distinct inactive dates in the rolling 30 resort-local days
 *             ending today, counting only dates AFTER the latest active-cycle
 *             reset (the latest active day / restoration). Dates need not be
 *             consecutive; active days before the window never matter.
 *   SILENCE   ≥ 10 distinct silent dates after the reset → audit flag + a
 *             secondary evaluation request (history backfill). Silence alone
 *             never hides; only inactive days (e.g. history-"dark" backfill) do.
 *   RESTORE   an auto-hidden show gets a verified active observation newer than
 *             the cycle reset it was hidden under → visible again, cycle reset
 *             to that active day, so older inactive evidence can never re-hide
 *             it; a later 21-of-30 pattern can. A future-return announcement is
 *             not evidence and is never an input here.
 *   Registry (reviewed) decisions are never overwritten: a `confirmed` hidden
 *   record is left alone (a performance only raises an audit flag); a
 *   `provisional` hidden record is restorable at request time (see
 *   entertainmentLifecycleVisibility.ts) and also flagged.
 *
 * Identity: keyed by `entertainmentMappingKey(parkId, canonical name)`; a
 * provider edition/variant name (World of Color – ONE / Happiness!) resolves to
 * the canonical catalog entry via the existing alias resolver, never a new row.
 *
 * DEV checks: `runDevEntertainmentLifecycleDetectorCases()` (entertainmentLifecycleDev.ts).
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { MIN_PUBLISHED_ENTITIES_TODAY, isActive, isDark } from "./entertainmentHistory";
import type { ParkHistoryEvidence } from "./entertainmentHistory";
import type { EntertainmentShowtimeEntry, ParkEntertainmentShowtimes } from "./entertainmentShowtimes";
import { seasonalExemptionReason } from "./entertainmentLifecycleRegistry";
import { ENTERTAINMENT_PLACES, resolveEntertainmentKey } from "./entertainmentSuggestions";
import { PARK_TO_RESORT } from "./parkMetadata";
import { addDaysToLocalDate } from "./resortTime";
import { entertainmentMappingKey } from "./themeParksEntertainmentMapping";
import type { ThemeParksHistoryDaily, ThemeParksResult } from "./themeParksApi";

// ============================================
// CONSTANTS
// ============================================

export const LIFECYCLE_WINDOW_DAYS = 30;
export const LIFECYCLE_MIN_INACTIVE_DAYS = 21;
export const LIFECYCLE_SILENCE_FLAG_DAYS = 10;
/** Evidence older than this may be pruned (cycle reset dates survive in state). */
export const LIFECYCLE_RETENTION_DAYS = 90;

export type LifecycleDayClass = "active" | "inactive" | "silent" | "unknown";
/** Order-independent precedence: a stronger observation replaces a weaker one, never the reverse. */
export const LIFECYCLE_CLASS_RANK: Record<LifecycleDayClass, number> = { unknown: 0, silent: 1, inactive: 2, active: 3 };

export type LifecycleObservationSource = "live" | "history_backfill";

export interface ShowDayObservation {
  parkId: ParkId;
  showKey: string;
  showName: string;
  localDate: string;
  dayClass: LifecycleDayClass;
  /** How `inactive`/`active` was established (diagnostic; also audit evidence). */
  basis: string | null;
  performanceCount: number;
  source: LifecycleObservationSource;
  /** Why the observation cannot stand alone / why it is not stronger (audit). */
  limitations: string[];
}

// ============================================
// IDENTITY / ELIGIBILITY
// ============================================

type CatalogPlace = (typeof ENTERTAINMENT_PLACES)[number];

/**
 * Resolve a (possibly variant) name to the canonical ACTIVE catalog entry of
 * `parkId` via the existing alias resolver. Legacy/unknown names resolve to null.
 */
export function resolveLifecycleShow(parkId: ParkId, rawName: string): { place: CatalogPlace; showKey: string } | null {
  const exact = ENTERTAINMENT_PLACES.find((p) => p.parkId === parkId && p.name === rawName);
  const place = exact ?? (() => {
    const key = resolveEntertainmentKey(rawName, PARK_TO_RESORT[parkId] as ResortId);
    if (!key) return undefined;
    return ENTERTAINMENT_PLACES.find((p) => p.parkId === parkId && entertainmentMappingKey(parkId, p.name) === `${parkId}:${key}`);
  })();
  return place ? { place, showKey: entertainmentMappingKey(parkId, place.name) } : null;
}

/** Active regular/limited catalog entry that is not a seasonal/holiday/festival/party offering. */
export function isLifecycleEligiblePlace(place: CatalogPlace): boolean {
  if (seasonalExemptionReason(place)) return false;
  return place.availabilityType === undefined || place.availabilityType === "regular" || place.availabilityType === "limited";
}

/** Eligible by exact canonical (parkId, name) in the ACTIVE catalog. Legacy/unknown/seasonal → false. */
export function isLifecycleEligible(parkId: ParkId, name: string): boolean {
  const place = ENTERTAINMENT_PLACES.find((p) => p.parkId === parkId && p.name === name);
  return !!place && isLifecycleEligiblePlace(place);
}

// ============================================
// DAY CLASSIFICATION (live showtimes)
// ============================================

export interface ParkObservationHealth {
  healthy: boolean;
  /** Why not healthy (empty when healthy). */
  limitations: string[];
}

/**
 * Park-level gate for NEGATIVE evidence (inactive/silent). A fresh, current,
 * non-stale payload with at least `MIN_PUBLISHED_ENTITIES_TODAY` shows already
 * publishing performances proves the provider is serving today's schedules —
 * so one show's absence is about that show, not the feed.
 */
export function assessParkHealth(st: ParkEntertainmentShowtimes): ParkObservationHealth {
  const limitations: string[] = [];
  if (st.error) limitations.push(`provider unavailable (${st.error.kind})`);
  else {
    if (st.stale) limitations.push("provider payload is stale-if-error");
    if (st.fetchedLocalDate !== st.localDate) limitations.push("provider payload was fetched on a different resort-local day");
    const published = st.entries.filter((e) => e.performances.length > 0).length;
    if (published < MIN_PUBLISHED_ENTITIES_TODAY) limitations.push(`park coverage not healthy (${published} shows publishing, need ${MIN_PUBLISHED_ENTITIES_TODAY})`);
  }
  return { healthy: limitations.length === 0, limitations };
}

/**
 * Classify one catalog entry's day. Pure. `null` = no observation (unmapped /
 * not eligible): nothing is inferred for a show with no provider mapping.
 */
export function observeShowDay(entry: EntertainmentShowtimeEntry, localDate: string, health: ParkObservationHealth): ShowDayObservation | null {
  const resolved = resolveLifecycleShow(entry.parkId, entry.dwpName);
  if (!resolved || !isLifecycleEligiblePlace(resolved.place) || entry.status === "unmapped") return null;
  const base = { parkId: entry.parkId, showKey: resolved.showKey, showName: resolved.place.name, localDate, source: "live" as const };

  if (entry.performances.length > 0) {
    return { ...base, dayClass: "active", basis: "live_performance", performanceCount: entry.performances.length, limitations: [] };
  }
  if (entry.confirmedNoActivityToday === true && health.healthy) {
    return { ...base, dayClass: "inactive", basis: entry.inactivityBasis ?? "confirmed_no_activity", performanceCount: 0, limitations: ["provider evidence only; not independently verified"] };
  }
  // Show-specific silence: every mapped entity absent (or present with no records at all)
  // while the rest of the park is healthy. Ambiguous records (dropped/unrecognized/OPERATING) never qualify.
  const silent =
    health.healthy &&
    entry.provider.length > 0 &&
    entry.unrecognizedTypes.length === 0 &&
    // Incompleteness must be explained by the absence itself; any other cause (dropped records, stale day) is ambiguity.
    (entry.provider.some((r) => !r.present) || !entry.incomplete) &&
    entry.provider.every((r) => !r.present || (r.rawShowtimeCount === 0 && r.droppedShowtimeCount === 0 && r.unrecognizedShowtimeCount === 0 && r.status?.toUpperCase() !== "OPERATING"));
  if (silent) {
    return { ...base, dayClass: "silent", basis: "provider_silence", performanceCount: 0, limitations: ["silence is not inactivity: the provider may simply not list this show"] };
  }
  return {
    ...base,
    dayClass: "unknown",
    basis: null,
    performanceCount: 0,
    limitations: health.healthy ? [`no credible evidence (status ${entry.status}${entry.incomplete ? ", incomplete" : ""})`] : health.limitations,
  };
}

/** Observations for every eligible, mapped catalog show of the park. */
export function observeParkDay(st: ParkEntertainmentShowtimes): ShowDayObservation[] {
  const health = assessParkHealth(st);
  const out: ShowDayObservation[] = [];
  for (const e of st.entries) {
    const o = observeShowDay(e, st.localDate, health);
    if (o) out.push(o);
  }
  return out;
}

// ============================================
// HISTORY BACKFILL (secondary evaluation)
// ============================================

/**
 * Secondary evaluation: per-day observations from validated ThemeParks history
 * for ONE show's mapped refs. Only days the whole-park gates accept
 * (`usablePriorDays`: fresh, complete, covered, not park-wide anomalous) are
 * used, never today; a ref with discarded rows, or a day any ref has no row for,
 * is unknown (skipped). performed on any ref → active; every ref dark → inactive.
 */
export function historyBackfillObservations(args: {
  parkId: ParkId;
  showKey: string;
  showName: string;
  refIds: string[];
  evidence: ParkHistoryEvidence | null;
  history: ThemeParksResult<ThemeParksHistoryDaily> | null;
}): ShowDayObservation[] {
  const { evidence, history, refIds } = args;
  if (!evidence || !evidence.usable || !history || !history.ok || refIds.length === 0) return [];
  const byRef = refIds.map((id) => history.data.entities.find((e) => e.entityId.toLowerCase() === id.toLowerCase()));
  if (byRef.some((e) => !e || e.droppedDays > 0)) return [];
  const out: ShowDayObservation[] = [];
  for (const date of evidence.usablePriorDays) {
    const rows = byRef.map((e) => e!.days.find((d) => d.date === date));
    const performed = rows.some((r) => !!r && isActive(r));
    const dark = rows.every((r) => !!r && !isActive(r) && isDark(r));
    if (!performed && !dark) continue;
    out.push({
      parkId: args.parkId, showKey: args.showKey, showName: args.showName, localDate: date,
      dayClass: performed ? "active" : "inactive",
      basis: performed ? "history_performed" : "history_dark",
      performanceCount: 0,
      source: "history_backfill",
      limitations: ["ThemeParks history is a change log; day validated by park-level coverage gates only"],
    });
  }
  return out;
}

// ============================================
// EVALUATION
// ============================================

export type LifecycleStatus = "visible" | "auto_hidden";
export type LifecycleAuditFlag = "provider_silence" | "registry_conflict";
export type LifecycleEventType = "auto_hide" | "auto_restore" | "silence_flag" | "registry_conflict";

export interface LifecycleShowState {
  status: LifecycleStatus;
  cycleResetDate: string | null;
  lastActiveDate: string | null;
  hiddenLocalDate: string | null;
  hideCount: number;
  restoreCount: number;
  silenceFlagged: boolean;
  secondaryEvaluatedOn: string | null;
  auditFlag: LifecycleAuditFlag | null;
}

export const EMPTY_LIFECYCLE_STATE: LifecycleShowState = {
  status: "visible", cycleResetDate: null, lastActiveDate: null, hiddenLocalDate: null,
  hideCount: 0, restoreCount: 0, silenceFlagged: false, secondaryEvaluatedOn: null, auditFlag: null,
};

export type RegistryHideKind = "none" | "confirmed" | "provisional";

export interface PlannedLifecycleEvent {
  type: LifecycleEventType;
  localDate: string;
  evidence: Record<string, unknown>;
  coverageLimitations: string[];
}

export interface LifecycleEvaluation {
  state: LifecycleShowState;
  inactiveDays: number;
  silentDays: number;
  events: PlannedLifecycleEvent[];
  /** Silence threshold met and a history backfill has not yet been tried today. */
  needsSecondary: boolean;
  changed: boolean;
}

const COVERAGE_LIMITATIONS = [
  "provider evidence only: ThemeParks.wiki/Queue-Times observations are never independent confirmation",
  "missing history, empty schedules, CLOSED status and elapsed time are never counted as inactivity",
  "an automatic hide is provisional until the scheduled research audit verifies it",
];

/**
 * Pure evaluation of one show. `observations` are the stored per-date classes
 * (any order, any duplicates: the strongest class per date wins).
 */
export function evaluateShowLifecycle(input: {
  today: string;
  observations: Array<{ localDate: string; dayClass: LifecycleDayClass; basis?: string | null; performanceCount?: number }>;
  state: LifecycleShowState | null;
  eligible: boolean;
  registryHide: RegistryHideKind;
}): LifecycleEvaluation {
  const { today, eligible, registryHide } = input;
  const prev = input.state ?? EMPTY_LIFECYCLE_STATE;
  const next: LifecycleShowState = { ...prev };
  const events: PlannedLifecycleEvent[] = [];
  const windowStart = addDaysToLocalDate(today, -(LIFECYCLE_WINDOW_DAYS - 1)) ?? today;

  const best = new Map<string, { cls: LifecycleDayClass; basis: string | null; perf: number }>();
  for (const o of input.observations) {
    if (o.localDate > today) continue; // never a future date
    const cur = best.get(o.localDate);
    if (!cur || LIFECYCLE_CLASS_RANK[o.dayClass] > LIFECYCLE_CLASS_RANK[cur.cls]) best.set(o.localDate, { cls: o.dayClass, basis: o.basis ?? null, perf: o.performanceCount ?? 0 });
  }
  let lastActive: string | null = prev.lastActiveDate;
  for (const [d, v] of best) if (v.cls === "active" && (!lastActive || d > lastActive)) lastActive = d;

  const result = (): LifecycleEvaluation => ({
    state: next,
    inactiveDays: countAfterReset("inactive"),
    silentDays: countAfterReset("silent"),
    events,
    needsSecondary: false,
    changed: JSON.stringify(next) !== JSON.stringify(prev),
  });
  const countAfterReset = (cls: LifecycleDayClass): number => {
    const reset = next.cycleResetDate;
    let n = 0;
    for (const [d, v] of best) if (v.cls === cls && d >= windowStart && (!reset || d > reset)) n++;
    return n;
  };

  next.lastActiveDate = lastActive;
  if (!eligible) return result(); // legacy / seasonal / unknown: never evaluated, never auto-resurfaced

  // A verified active day newer than the reset this cycle is running under.
  const newActive = lastActive !== null && (prev.cycleResetDate === null || lastActive > prev.cycleResetDate);

  if (registryHide === "confirmed" || registryHide === "provisional") {
    // Reviewed registry decision: never overwritten, no automatic decisions of our own.
    if (newActive && lastActive === today) {
      if (next.auditFlag !== "registry_conflict") events.push({
        type: "registry_conflict", localDate: today,
        evidence: { activeDate: lastActive, registryDecision: `hidden (${registryHide})`, performanceCount: best.get(today)?.perf ?? 0 },
        coverageLimitations: [...COVERAGE_LIMITATIONS, "the registry decision was NOT changed; the audit must review it"],
      });
      next.auditFlag = "registry_conflict";
    }
    return result();
  }

  if (prev.status === "auto_hidden") {
    if (newActive && lastActive) {
      next.status = "visible";
      next.cycleResetDate = lastActive;
      next.restoreCount = prev.restoreCount + 1;
      next.silenceFlagged = false;
      next.secondaryEvaluatedOn = null;
      next.auditFlag = null;
      events.push({
        type: "auto_restore", localDate: today,
        evidence: { activeDate: lastActive, hiddenLocalDate: prev.hiddenLocalDate, performanceCount: best.get(lastActive)?.perf ?? 0, basis: best.get(lastActive)?.basis ?? null, previousCycleReset: prev.cycleResetDate },
        coverageLimitations: COVERAGE_LIMITATIONS,
      });
    }
    return result();
  }

  // visible
  if (newActive && lastActive) {
    next.cycleResetDate = lastActive;
    if (next.silenceFlagged) { next.silenceFlagged = false; next.secondaryEvaluatedOn = null; }
    if (next.auditFlag === "provider_silence" || next.auditFlag === "registry_conflict") next.auditFlag = null;
  }
  const inactive = countAfterReset("inactive");
  const silent = countAfterReset("silent");
  if (inactive >= LIFECYCLE_MIN_INACTIVE_DAYS) {
    const inactiveDates = [...best].filter(([d, v]) => v.cls === "inactive" && d >= windowStart && (!next.cycleResetDate || d > next.cycleResetDate)).map(([d]) => d).sort();
    const bases: Record<string, number> = {};
    for (const [d, v] of best) if (inactiveDates.includes(d)) bases[v.basis ?? "unspecified"] = (bases[v.basis ?? "unspecified"] ?? 0) + 1;
    next.status = "auto_hidden";
    next.hiddenLocalDate = today;
    next.hideCount = prev.hideCount + 1;
    next.auditFlag = null;
    events.push({
      type: "auto_hide", localDate: today,
      evidence: { windowStart, windowEnd: today, inactiveDays: inactive, threshold: LIFECYCLE_MIN_INACTIVE_DAYS, inactiveDates, bases, silentDays: silent, cycleResetDate: next.cycleResetDate, activeDaysSinceReset: 0 },
      coverageLimitations: COVERAGE_LIMITATIONS,
    });
    return result();
  }
  let needsSecondary = false;
  if (silent >= LIFECYCLE_SILENCE_FLAG_DAYS) {
    if (!next.silenceFlagged) {
      next.silenceFlagged = true;
      next.auditFlag = "provider_silence";
      events.push({
        type: "silence_flag", localDate: today,
        evidence: { windowStart, windowEnd: today, silentDays: silent, threshold: LIFECYCLE_SILENCE_FLAG_DAYS, inactiveDays: inactive, cycleResetDate: next.cycleResetDate },
        coverageLimitations: [...COVERAGE_LIMITATIONS, "show-specific provider silence cannot hide a show; a secondary history evaluation was requested"],
      });
    }
    needsSecondary = next.secondaryEvaluatedOn !== today;
  }
  const r = result();
  r.needsSecondary = needsSecondary;
  return r;
}

/** DEV helper: rolling window start (resort-local dates). */
export function lifecycleWindowStart(today: string): string {
  return addDaysToLocalDate(today, -(LIFECYCLE_WINDOW_DAYS - 1)) ?? today;
}

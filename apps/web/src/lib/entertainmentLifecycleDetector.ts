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
 *   dormant  (14.5C-fix) a mapped show whose provider entity IS in the fresh,
 *            healthy park feed with status CLOSED and no records, no performance.
 *            Counts like `inactive` toward the hide threshold (distinct dates);
 *   silent   the show's own provider entities are ABSENT (or empty with another
 *            status) while the park as a whole is healthy. Counts toward the
 *            10-day silence WARNING; counts toward hiding only once the show's
 *            identity is established: a verified performance was observed for it
 *            OR its canonical provider mapping is validated (`isMappingIdentityEstablished`:
 *            mapped, unambiguous, structurally valid) — so an already-stale catalog
 *            show is hideable without a performance recorded since deployment;
 *   unknown  everything else (failures, stale/partial data, CLOSED alone, an
 *            unhealthy park). Never counts toward anything.
 * Unmapped shows produce NO observation (a nonexistent provider observation is
 * never inferred), so they can never be hidden automatically.
 *
 * Rules (identical for `regular` and `limited`; seasonal/holiday/festival/party
 * entries and legacy/unknown identities are never evaluated):
 *   HIDE      ≥ 21 distinct dates classed inactive OR dormant (OR silent, with
 *             identity established) in the rolling 30 resort-local days ending
 *             today, counting only dates AFTER the latest active-cycle reset
 *             (the latest active day / restoration). A date is one class, so
 *             "distinct" is by construction; dates need not be consecutive.
 *   SILENCE   ≥ 10 distinct silent/dormant dates after the reset → audit flag + a
 *             secondary evaluation request (history backfill). Unknown/incomplete
 *             days, missing history rows, weak coverage and outages never count.
 *   FINALITY  negative classes count only when the observation was made in the
 *             resort-local END-OF-DAY window (`isDayEndWindow`, ≥ 22:00): an
 *             earlier observation of a still-running day is provisional and is
 *             replaced by a later in-window one. Active days count immediately.
 *   RESTORE   an auto-hidden show gets a verified active observation newer than
 *             the cycle reset it was hidden under → visible again, cycle reset
 *             to that active day, so older inactive evidence can never re-hide
 *             it; a later 21-of-30 pattern can. A future-return announcement is
 *             not evidence and is never an input here.
 *   Registry (reviewed) hides are RESTORABLE by a verified performance, even when
 *   confirmed (inactive/suspended/returning): the registry record is never edited;
 *   the restoration is persisted (`registryRestored`) with a `registry_restore`
 *   audit event + `registry_conflict` flag, the cycle resets, and later 21-of-30
 *   inactivity can hide again. A `discontinued` record is LOCKED: a performance
 *   only raises an audit flag. Legacy identities are never evaluated.
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
import { ENTERTAINMENT_LIFECYCLE_REGISTRY, lifecycleRecordKey, seasonalExemptionReason, type EntertainmentLifecycleRegistry } from "./entertainmentLifecycleRegistry";
import { ENTERTAINMENT_PLACES, resolveEntertainmentKey } from "./entertainmentSuggestions";
import { PARK_TO_RESORT } from "./parkMetadata";
import { RESORT_TIME_ZONES, addDaysToLocalDate } from "./resortTime";
import {
  THEMEPARKS_ENTERTAINMENT_MAPPING,
  entertainmentMappingKey,
  validateEntertainmentMappingStructure,
  type EntertainmentProviderMapping,
} from "./themeParksEntertainmentMapping";
import type { ThemeParksHistoryDaily, ThemeParksResult } from "./themeParksApi";

// ============================================
// CONSTANTS
// ============================================

export const LIFECYCLE_WINDOW_DAYS = 30;
export const LIFECYCLE_MIN_INACTIVE_DAYS = 21;
export const LIFECYCLE_SILENCE_FLAG_DAYS = 10;
/** Evidence older than this may be pruned (cycle reset dates survive in state). */
export const LIFECYCLE_RETENTION_DAYS = 90;

export type LifecycleDayClass = "active" | "inactive" | "dormant" | "silent" | "unknown";
/** Precedence within the same finality: a stronger observation replaces a weaker one, never the reverse. */
export const LIFECYCLE_CLASS_RANK: Record<LifecycleDayClass, number> = { unknown: 0, silent: 1, dormant: 2, inactive: 3, active: 4 };

/** Resort-local hour from which a day's NEGATIVE observation may be final (see header, FINALITY). */
export const LIFECYCLE_DAY_END_HOUR = 22;

/** Resort-local hour (0-23) of `instant`. DST-correct (Intl, IANA zone). */
export function resortLocalHour(resort: ResortId, instant: Date): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: RESORT_TIME_ZONES[resort], hour: "numeric", hourCycle: "h23" }).formatToParts(instant).find((x) => x.type === "hour")?.value;
  return Number(h ?? "0") % 24;
}

/** True when `instant` is in the resort-local end-of-day window [22:00, 24:00): negatives observed now may be final. */
export function isDayEndWindow(resort: ResortId, instant: Date): boolean {
  return resortLocalHour(resort, instant) >= LIFECYCLE_DAY_END_HOUR;
}

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
  /** Counts toward negative thresholds: active rows always; negatives only when observed in the day-end window. */
  final: boolean;
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

/**
 * Identity via a VALIDATED existing canonical provider mapping (no prior performance
 * needed): the show is `mapped` with ≥ 1 ref, its key has no structural finding in the
 * maintained mapping validator (duplicate/orphan/invalid UUID/empty refs), and every
 * ref id is owned by exactly this one entry (no shared/ambiguous entity). Unmapped,
 * ambiguous or malformed mappings never establish identity. Static data only — it
 * cannot prove the provider still lists the entity (that is what the healthy-feed
 * absence evidence measures).
 */
export function isMappingIdentityEstablished(
  parkId: ParkId,
  name: string,
  mapping: EntertainmentProviderMapping[] = THEMEPARKS_ENTERTAINMENT_MAPPING,
): boolean {
  const key = entertainmentMappingKey(parkId, name);
  const m = mapping.find((x) => entertainmentMappingKey(x.parkId, x.dwpName) === key);
  if (!m || m.disposition !== "mapped" || m.provider.length === 0) return false;
  if (validateEntertainmentMappingStructure(mapping).some((f) => f.key === key)) return false;
  const ids = m.provider.map((r) => r.entityId.toLowerCase());
  if (new Set(ids).size !== ids.length) return false;
  for (const other of mapping) {
    if (other === m || other.disposition !== "mapped") continue;
    if (other.provider.some((r) => ids.includes(r.entityId.toLowerCase()))) return false;
  }
  return true;
}

// ============================================
// DAY CLASSIFICATION (live showtimes)
// ============================================

export interface ParkObservationHealth {
  healthy: boolean;
  /**
   * False when the validation layer discarded provider entities this run: a mapped
   * entity missing from the payload may then be a discarded record, not genuine
   * absence. Absence-based classes (`silent`/`dormant` with an absent ref) are unknown.
   */
  absenceReliable?: boolean;
  /** Why not healthy (empty when healthy). */
  limitations: string[];
}

/**
 * Park-level gate for NEGATIVE evidence (inactive/dormant/silent). A fresh, current,
 * non-stale payload with at least `MIN_PUBLISHED_ENTITIES_TODAY` PROVIDER entities
 * (any type, via `providerCoverage` — the same `countEntitiesActiveToday` the
 * 14.4.2 history gate uses) already publishing today proves the provider is serving
 * today's schedules, so one show's absence is about that show, not the feed. Parks
 * with few mapped curated shows (EPCOT, DCA) are judged by the whole feed; only a
 * payload without coverage metadata falls back to counting curated entries.
 */
export function assessParkHealth(st: ParkEntertainmentShowtimes): ParkObservationHealth {
  const limitations: string[] = [];
  if (st.error) limitations.push(`provider unavailable (${st.error.kind})`);
  else {
    if (st.stale) limitations.push("provider payload is stale-if-error");
    if (st.fetchedLocalDate !== st.localDate) limitations.push("provider payload was fetched on a different resort-local day");
    const published = st.providerCoverage ? st.providerCoverage.publishedEntities : st.entries.filter((e) => e.performances.length > 0).length;
    if (published < MIN_PUBLISHED_ENTITIES_TODAY) limitations.push(`park coverage not healthy (${published} provider entities publishing, need ${MIN_PUBLISHED_ENTITIES_TODAY})`);
  }
  const absenceReliable = !st.providerCoverage || st.providerCoverage.droppedEntities === 0;
  return { healthy: limitations.length === 0, absenceReliable, limitations };
}

/**
 * Classify one catalog entry's day. Pure. `null` = no observation (unmapped /
 * not eligible): nothing is inferred for a show with no provider mapping.
 * `dayEnd` = the observation was made in the resort-local end-of-day window; a
 * negative class observed earlier is provisional (`final: false`) and never counts.
 */
export function observeShowDay(entry: EntertainmentShowtimeEntry, localDate: string, health: ParkObservationHealth, dayEnd = true): ShowDayObservation | null {
  const resolved = resolveLifecycleShow(entry.parkId, entry.dwpName);
  if (!resolved || !isLifecycleEligiblePlace(resolved.place) || entry.status === "unmapped") return null;
  const base = { parkId: entry.parkId, showKey: resolved.showKey, showName: resolved.place.name, localDate, source: "live" as const };
  const partial = dayEnd ? [] : ["observed before the resort-local end-of-day window: provisional, never counted"];

  if (entry.performances.length > 0) {
    return { ...base, dayClass: "active", basis: "live_performance", performanceCount: entry.performances.length, final: true, limitations: [] };
  }
  const negative = (dayClass: LifecycleDayClass, basis: string, limitations: string[]): ShowDayObservation =>
    ({ ...base, dayClass, basis, performanceCount: 0, final: dayEnd, limitations: [...limitations, ...partial] });
  if (entry.confirmedNoActivityToday === true && health.healthy) {
    return negative("inactive", entry.inactivityBasis ?? "confirmed_no_activity", ["provider evidence only; not independently verified"]);
  }
  // Provider emptiness on a fresh, healthy park feed. Ambiguous records (dropped/unrecognized/OPERATING) never qualify.
  const empty =
    health.healthy &&
    entry.provider.length > 0 &&
    entry.unrecognizedTypes.length === 0 &&
    // Incompleteness must be explained by the absence itself; any other cause (dropped records, stale day) is ambiguity.
    (entry.provider.some((r) => !r.present) || !entry.incomplete) &&
    entry.provider.every((r) => !r.present || (r.rawShowtimeCount === 0 && r.droppedShowtimeCount === 0 && r.unrecognizedShowtimeCount === 0 && r.status?.toUpperCase() !== "OPERATING"));
  // A discarded (malformed) provider entity is indistinguishable from absence: never count an absent ref then.
  const absenceAmbiguous = health.absenceReliable === false && entry.provider.some((r) => !r.present);
  if (empty && absenceAmbiguous) {
    return { ...base, dayClass: "unknown", basis: null, performanceCount: 0, final: dayEnd, limitations: ["provider entities were discarded by validation this run: absence cannot be told from a malformed record"] };
  }
  if (empty) {
    // Dormant: the entity is in the feed and explicitly CLOSED (identity established by its presence).
    const present = entry.provider.filter((r) => r.present);
    if (present.length > 0 && present.every((r) => r.status?.toUpperCase() === "CLOSED")) {
      return negative("dormant", "provider_closed", ["provider CLOSED with no performance on a healthy feed; counts only across ≥ 21 distinct days"]);
    }
    return negative("silent", "provider_silence", ["silence is not inactivity: the provider may simply not list this show; counts toward hiding only once identity is established"]);
  }
  return {
    ...base,
    dayClass: "unknown",
    basis: null,
    performanceCount: 0,
    final: dayEnd,
    limitations: health.healthy ? [`no credible evidence (status ${entry.status}${entry.incomplete ? ", incomplete" : ""})`] : health.limitations,
  };
}

/** Observations for every eligible, mapped catalog show of the park. */
export function observeParkDay(st: ParkEntertainmentShowtimes, dayEnd = true): ShowDayObservation[] {
  const health = assessParkHealth(st);
  const out: ShowDayObservation[] = [];
  for (const e of st.entries) {
    const o = observeShowDay(e, st.localDate, health, dayEnd);
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
      final: true, // a validated, completed prior day
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
export type LifecycleEventType = "auto_hide" | "auto_restore" | "silence_flag" | "registry_conflict" | "registry_restore";

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
  /** A verified performance overrode a reviewed registry hide (persisted; the registry record itself is never edited). */
  registryRestored: boolean;
}

export const EMPTY_LIFECYCLE_STATE: LifecycleShowState = {
  status: "visible", cycleResetDate: null, lastActiveDate: null, hiddenLocalDate: null,
  hideCount: 0, restoreCount: 0, silenceFlagged: false, secondaryEvaluatedOn: null, auditFlag: null, registryRestored: false,
};

/** none = no registry hide; restorable = hidden, assessment ≠ discontinued; locked = hidden + discontinued. */
export type RegistryHideKind = "none" | "restorable" | "locked";

/** Reviewed registry hide kind for a canonical show (never changed here). */
export function registryHideKind(parkId: ParkId, name: string, registry: EntertainmentLifecycleRegistry = ENTERTAINMENT_LIFECYCLE_REGISTRY): RegistryHideKind {
  const key = entertainmentMappingKey(parkId, name);
  const r = registry.records.find((x) => lifecycleRecordKey(x) === key);
  if (!r || r.visibility.decision !== "hidden") return "none";
  return r.assessment === "discontinued" ? "locked" : "restorable";
}

export interface PlannedLifecycleEvent {
  type: LifecycleEventType;
  localDate: string;
  evidence: Record<string, unknown>;
  coverageLimitations: string[];
}

export interface LifecycleEvaluation {
  state: LifecycleShowState;
  /** Verified inactive days after the reset (final only). */
  inactiveDays: number;
  /** Dormant days (+ silent days once identity is established) after the reset (final only). */
  dormantDays: number;
  /** Silent + dormant days after the reset (final only): drives the silence warning. */
  silentDays: number;
  events: PlannedLifecycleEvent[];
  /** Silence threshold met and a history backfill has not yet been tried today. */
  needsSecondary: boolean;
  changed: boolean;
}

const COVERAGE_LIMITATIONS = [
  "provider evidence only: ThemeParks.wiki/Queue-Times observations are never independent confirmation",
  "missing history, empty schedules, unknown/partial data and elapsed time are never counted as inactivity",
  "an automatic hide is provisional until the scheduled research audit verifies it",
];

export interface LifecycleObservationInput {
  localDate: string;
  dayClass: LifecycleDayClass;
  basis?: string | null;
  performanceCount?: number;
  /** Defaults to true (stored rows written before the finality column). */
  final?: boolean;
}

/**
 * Pure evaluation of one show. `observations` are the stored per-date classes
 * (any order, any duplicates: the strongest class per date wins; callers store
 * one row per date). Negative classes count only when `final`.
 */
export function evaluateShowLifecycle(input: {
  today: string;
  observations: LifecycleObservationInput[];
  state: LifecycleShowState | null;
  eligible: boolean;
  registryHide: RegistryHideKind;
  /** The show's canonical provider mapping is validated (`isMappingIdentityEstablished`): absence on a healthy feed may count without a prior performance. */
  mappingEstablished?: boolean;
}): LifecycleEvaluation {
  const { today, eligible } = input;
  const prev = input.state ?? EMPTY_LIFECYCLE_STATE;
  const next: LifecycleShowState = { ...prev };
  const events: PlannedLifecycleEvent[] = [];
  const windowStart = addDaysToLocalDate(today, -(LIFECYCLE_WINDOW_DAYS - 1)) ?? today;

  const best = new Map<string, { cls: LifecycleDayClass; basis: string | null; perf: number; final: boolean }>();
  for (const o of input.observations) {
    if (o.localDate > today) continue; // never a future date
    const cur = best.get(o.localDate);
    const final = o.final !== false;
    // active beats everything; otherwise a final row beats a provisional one; then the stronger class.
    const better = !cur || (o.dayClass === "active" && cur.cls !== "active") ||
      (cur.cls !== "active" && ((final && !cur.final) || (final === cur.final && LIFECYCLE_CLASS_RANK[o.dayClass] > LIFECYCLE_CLASS_RANK[cur.cls])));
    if (better) best.set(o.localDate, { cls: o.dayClass, basis: o.basis ?? null, perf: o.performanceCount ?? 0, final: o.dayClass === "active" ? true : final });
  }
  let lastActive: string | null = prev.lastActiveDate;
  for (const [d, v] of best) if (v.cls === "active" && (!lastActive || d > lastActive)) lastActive = d;
  // Identity: a verified performance was ever observed (persisted in state), OR the canonical provider mapping is validated.
  const identityBasis: "performance" | "validated_mapping" | null = lastActive !== null ? "performance" : input.mappingEstablished ? "validated_mapping" : null;
  const identityEstablished = identityBasis !== null;

  const countAfterReset = (match: (v: { cls: LifecycleDayClass; final: boolean }) => boolean): string[] => {
    const reset = next.cycleResetDate;
    const out: string[] = [];
    for (const [d, v] of best) if (v.final && match(v) && d >= windowStart && (!reset || d > reset)) out.push(d);
    return out.sort();
  };
  const inactiveDates = () => countAfterReset((v) => v.cls === "inactive");
  const dormantDates = () => countAfterReset((v) => v.cls === "dormant" || (v.cls === "silent" && identityEstablished));
  const silentDates = () => countAfterReset((v) => v.cls === "silent" || v.cls === "dormant");
  const result = (): LifecycleEvaluation => ({
    state: next,
    inactiveDays: inactiveDates().length,
    dormantDays: dormantDates().length,
    silentDays: silentDates().length,
    events,
    needsSecondary: false,
    changed: JSON.stringify(next) !== JSON.stringify(prev),
  });

  next.lastActiveDate = lastActive;
  if (!eligible) return result(); // legacy / seasonal / unknown: never evaluated, never auto-resurfaced

  // A verified active day newer than the reset this cycle is running under.
  const newActive = lastActive !== null && (prev.cycleResetDate === null || lastActive > prev.cycleResetDate);
  const activeEvidence = lastActive ? { activeDate: lastActive, performanceCount: best.get(lastActive)?.perf ?? 0, basis: best.get(lastActive)?.basis ?? null } : {};

  // Reviewed registry hide that has not been overridden yet.
  if (input.registryHide !== "none" && !prev.registryRestored) {
    if (input.registryHide === "locked") {
      // Discontinued: never restored automatically; a performance only raises an audit flag.
      if (newActive && lastActive === today) {
        if (next.auditFlag !== "registry_conflict") events.push({
          type: "registry_conflict", localDate: today,
          evidence: { ...activeEvidence, registryDecision: "hidden (discontinued)", action: "flag_only" },
          coverageLimitations: [...COVERAGE_LIMITATIONS, "the registry decision was NOT changed; discontinued records are never auto-restored"],
        });
        next.auditFlag = "registry_conflict";
      }
      return result();
    }
    // Restorable (inactive/suspended/returning): a verified current performance overrides the hide.
    if (newActive && lastActive) {
      next.registryRestored = true;
      next.status = "visible";
      next.cycleResetDate = lastActive;
      next.auditFlag = "registry_conflict";
      next.silenceFlagged = false;
      next.secondaryEvaluatedOn = null;
      events.push({
        type: "registry_restore", localDate: today,
        evidence: { ...activeEvidence, registryDecision: "hidden (restorable)", action: "restored_on_verified_performance", previousCycleReset: prev.cycleResetDate },
        coverageLimitations: [...COVERAGE_LIMITATIONS, "the registry record was NOT edited; the audit must review and update it"],
      });
    }
    return result(); // still registry-hidden (no automatic decisions of our own), or just restored with a fresh cycle
  }

  if (prev.status === "auto_hidden") {
    if (newActive && lastActive) {
      next.status = "visible";
      next.cycleResetDate = lastActive;
      next.restoreCount = prev.restoreCount + 1;
      next.silenceFlagged = false;
      next.secondaryEvaluatedOn = null;
      next.auditFlag = prev.registryRestored ? "registry_conflict" : null;
      events.push({
        type: "auto_restore", localDate: today,
        evidence: { ...activeEvidence, hiddenLocalDate: prev.hiddenLocalDate, previousCycleReset: prev.cycleResetDate },
        coverageLimitations: COVERAGE_LIMITATIONS,
      });
    }
    return result();
  }

  // visible
  if (newActive && lastActive) {
    next.cycleResetDate = lastActive;
    if (next.silenceFlagged) { next.silenceFlagged = false; next.secondaryEvaluatedOn = null; }
    if (next.auditFlag === "provider_silence") next.auditFlag = null;
  }
  const inactive = inactiveDates();
  const dormant = dormantDates();
  const silent = silentDates();
  const counted = inactive.length + dormant.length; // distinct by construction: one class per date
  if (counted >= LIFECYCLE_MIN_INACTIVE_DAYS) {
    const bases: Record<string, number> = {};
    for (const d of [...inactive, ...dormant]) { const b = best.get(d)!; const k = `${b.cls}:${b.basis ?? "unspecified"}`; bases[k] = (bases[k] ?? 0) + 1; }
    next.status = "auto_hidden";
    next.hiddenLocalDate = today;
    next.hideCount = prev.hideCount + 1;
    next.auditFlag = prev.registryRestored ? "registry_conflict" : null;
    events.push({
      type: "auto_hide", localDate: today,
      evidence: {
        windowStart, windowEnd: today, countedDays: counted, inactiveDays: inactive.length, dormantDays: dormant.length, threshold: LIFECYCLE_MIN_INACTIVE_DAYS,
        inactiveDates: inactive, dormantDates: dormant, identityEstablished, identityBasis, bases, silentDays: silent.length, cycleResetDate: next.cycleResetDate, activeDaysSinceReset: 0,
      },
      coverageLimitations: COVERAGE_LIMITATIONS,
    });
    return result();
  }
  let needsSecondary = false;
  if (silent.length >= LIFECYCLE_SILENCE_FLAG_DAYS) {
    if (!next.silenceFlagged) {
      next.silenceFlagged = true;
      if (next.auditFlag !== "registry_conflict") next.auditFlag = "provider_silence";
      events.push({
        type: "silence_flag", localDate: today,
        evidence: { windowStart, windowEnd: today, silentDays: silent.length, threshold: LIFECYCLE_SILENCE_FLAG_DAYS, inactiveDays: inactive.length, dormantDays: dormant.length, identityEstablished, identityBasis, cycleResetDate: next.cycleResetDate },
        coverageLimitations: [...COVERAGE_LIMITATIONS, "provider silence alone cannot hide a show; a secondary history evaluation was requested"],
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

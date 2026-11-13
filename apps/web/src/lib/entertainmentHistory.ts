/**
 * entertainmentHistory.ts — Phase 14.4.2 history evidence for "not performing
 * today". Pure (type-only imports from the server-only ThemeParks client), so
 * entertainmentShowtimes.ts / entertainmentAll.ts can use it unchanged.
 *
 * ThemeParks `/history/daily` is a CHANGE LOG of daily aggregates, not a
 * calendar: a missing row, `showCount: 0` on its own, or a lagging feed prove
 * nothing. History here can only (a) VETO hiding (today's row shows activity)
 * or (b) corroborate a clean, current live "nothing today" reading for one
 * mapped provider ref. It never hides anything by itself and never overrides a
 * verified live performance/operating window. Every uncertainty → no support →
 * the entry stays visible.
 *
 * Two evidence modes, chosen by the window the provider ANSWERED (not by what
 * we hoped for): the anonymous 7-day window (6 prior days) uses the "short"
 * rules — unchanged from the first 14.4.2 cut and the guaranteed fallback; the
 * authenticated 30-day window (29 prior days) uses the "long" rules, which add
 * recency, weekday recurrence and an intermittence-rate test. A long payload is
 * judged by the long rules ONLY (the short rules never silently re-enable on it:
 * 30 days can show that a recent "dark" pair was a rare outage, not a pattern).
 *
 * Whole-park gates (`usable`, both modes):
 *   - fresh: fetched on today's resort-local date, not stale-if-error;
 *   - complete: no continuation (`next`), no dropped entities, and the answered
 *     window is exactly [today-(N-1), today] for N ∈ {7, 30} (midnight rollover
 *     or another window rejects it);
 *   - current: YESTERDAY is covered (≥ 5 SHOW rows and ≥ 50% of the busiest
 *     prior day's rows) — a lagging feed is detected, not assumed away;
 *   - enough usable prior days: covered AND not park-wide anomalous (≥ 30% of
 *     ≥ 8 reporting SHOWs at zero — outage/weather/provider gap, e.g. MK
 *     2026-11-10). short: ≥ 4 of 6; long: ≥ 50% of the prior days AND ≥ 4 of the
 *     most recent 7 (old coverage alone never qualifies).
 * Per-ref day classes (usable prior days only): performed = showCount>0 or
 * operatingMinutes>0; dark = showCount 0 AND operatingMinutes 0 while the park
 * was scheduled open; anything else (absent row, null counts) = unknown.
 *
 * SHORT rules (a ref supports inactivity; all refs of an entry must):
 *   generic:  performed ≥ 3, dark days NOT explained by confirmed party nights
 *             ≥ 2, classified (performed+dark) ≥ 5;
 *   party:    today is a registry-confirmed party night, the ref was dark on
 *             ≥ 2 confirmed party nights, never performed on one, performed on
 *             ≥ 2 confirmed NON-party nights, classified ≥ 4.
 * LONG rules (RECENT = the last 14 prior days; old activity never counts):
 *   active recently:  recent classified ≥ 8 AND recent performed ≥ 3 — a show
 *             that has stopped (or is only sparsely recorded) is NOT hidden by
 *             history (lifecycle detection is a later phase);
 *   party:    today is a confirmed party night; over the window ≥ 3 party-dark
 *             nights, 0 party-performed, ≥ 1 party-dark night in RECENT and
 *             ≥ 2 non-party performances in RECENT → "history_party";
 *   weekly:   ≥ 2 prior same-weekday days (same party-night class as today,
 *             ≤ 4 look-backs) all dark and none performed → "history_weekly".
 *             A weekly show that performed even once on this weekday, or moved
 *             to it, is not hidden;
 *   intermittent: ≥ 2 non-party-explained dark days in RECENT, dark ≥ 20% of
 *             recent classified days, AND ≥ 1 such dark day in the last 7 prior
 *             days → "history". The rate stops two rare outages in a daily show
 *             from qualifying; the 7-day recency stops a show that went daily
 *             (schedule change) from being hidden on stale gaps.
 * A ref that performed on any party night in the window never gets party-date
 * support in either mode. Both modes also need: no today row showing activity,
 * no dropped day rows, and (in entertainmentShowtimes) a clean current live
 * payload with a published-today quorum. Nothing here is show-specific.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { addDaysToLocalDate, getResortLocalDate } from "./resortTime";
import { getPartyNightEventIds, getPartyNightState } from "./seasonalEvents";
import type { ThemeParksHistoryDaily, ThemeParksHistoryEntity, ThemeParksResult } from "./themeParksApi";

/** Anonymous window (days, inclusive of today) and authenticated window. */
export const HISTORY_SHORT_DAYS = 7;
export const HISTORY_LONG_DAYS = 30;
/** @deprecated alias of HISTORY_SHORT_DAYS (the original single window). */
export const HISTORY_WINDOW_DAYS = HISTORY_SHORT_DAYS;
export const HISTORY_COVERAGE_MIN_ROWS = 5;
export const HISTORY_COVERAGE_MIN_SHARE = 0.5;
export const HISTORY_ANOMALY_MIN_ROWS = 8;
export const HISTORY_ANOMALY_ZERO_SHARE = 0.3;
// short (7-day) rules
export const HISTORY_MIN_USABLE_PRIOR_DAYS = 4;
export const HISTORY_GENERIC_MIN_PERFORMED = 3;
export const HISTORY_GENERIC_MIN_UNEXPLAINED_DARK = 2;
export const HISTORY_GENERIC_MIN_CLASSIFIED = 5;
export const HISTORY_PARTY_MIN_DARK = 2;
export const HISTORY_PARTY_MIN_NONPARTY_PERFORMED = 2;
export const HISTORY_PARTY_MIN_CLASSIFIED = 4;
// long (30-day) rules
export const HISTORY_RECENT_DAYS = 14;
export const HISTORY_LONG_MIN_USABLE_SHARE = 0.5;
export const HISTORY_LONG_MIN_USABLE_RECENT7 = 4;
export const HISTORY_LONG_MIN_RECENT_CLASSIFIED = 8;
export const HISTORY_LONG_MIN_RECENT_PERFORMED = 3;
export const HISTORY_LONG_PARTY_MIN_DARK = 3;
export const HISTORY_LONG_PARTY_MIN_RECENT_NONPARTY_PERFORMED = 2;
export const HISTORY_LONG_WEEKLY_MIN_DARK = 2;
export const HISTORY_LONG_WEEKLY_LOOKBACKS = 4;
export const HISTORY_LONG_INTERMITTENT_MIN_DARK = 2;
export const HISTORY_LONG_INTERMITTENT_MIN_DARK_SHARE = 0.2;
/** Distinct live entities with a performance/operating record today before an empty ref is meaningful ("today's schedules have posted"). */
export const MIN_PUBLISHED_ENTITIES_TODAY = 3;

/** Park-level evidence rejection codes (diagnostics only; the decision logic is unchanged). */
export type HistoryRejectCode =
  | "unavailable" | "stale" | "fetched_other_day" | "window_unsupported" | "window_mismatch"
  | "paged" | "dropped_entities" | "lagging" | "few_usable_days" | "low_recent_coverage";
/** Per-ref decision codes: "supported" or the first reason a ref did not qualify. */
export type HistoryRefCode =
  | "supported" | "no_evidence" | "ref_absent" | "ref_unreliable" | "today_active" | "party_performed"
  | "recent_coverage_low" | "recent_performed_low" | "party_dark_insufficient" | "party_recent_insufficient" | "no_pattern" | "party_pattern_insufficient";

export type InactivityBasis = "forward_horizon" | "history" | "history_party" | "history_weekly";

interface DayCounts { classified: number; performed: number; dark: number; unexplainedDark: number; partyDark: number; nonPartyPerformed: number }

export interface HistoryRefProfile {
  performed: number;
  dark: number;
  /** Dark days that were NOT confirmed party nights. */
  unexplainedDark: number;
  unknown: number;
  partyDark: number;
  partyPerformed: number;
  nonPartyPerformed: number;
  /** Counts over the last HISTORY_RECENT_DAYS usable prior days. */
  recent: DayCounts;
  /** Non-party-explained dark days within the last 7 prior days (usable ones). */
  darkLast7: number;
  /** Prior same-weekday days (same party-night class as today, ≤ lookbacks, usable & classified). */
  sameWeekday: { classified: number; performed: number; dark: number };
  /** Malformed day rows were discarded for this entity: never evidence. */
  unreliable: boolean;
  /** Today's (partial) row shows activity: contradicts "not performing today". */
  todayActive: boolean;
}

export interface ParkHistoryEvidence {
  today: string;
  /** Answered window length (7 or 30); 0 when unknown/rejected. */
  windowDays: number;
  /** "short" = anonymous 7-day rules; "long" = authenticated 30-day rules. */
  mode: "short" | "long" | null;
  /** Whole-park gates passed (see header). */
  usable: boolean;
  /** Why not usable (null when usable). Diagnostic only. */
  reason: string | null;
  /** Stable aggregate code for `reason` (diagnostics/logging; never free text). */
  reasonCode: HistoryRejectCode | null;
  usablePriorDays: string[];
  anomalousDays: string[];
  /** lowercase entityId → profile; computed only when `usable` (todayActive is also kept when not). */
  refs: Map<string, HistoryRefProfile>;
}

/** [today-(days-1), today] in resort-local dates; `days` defaults to the anonymous window. */
export function historyWindow(resort: ResortId, instant: Date, days: number = HISTORY_SHORT_DAYS): { from: string; to: string } {
  const to = getResortLocalDate(resort, instant);
  return { from: addDaysToLocalDate(to, -(days - 1)) ?? to, to };
}

const isActive = (d: { showCount: number | null; operatingMinutes: number | null }) =>
  (d.showCount ?? 0) > 0 || (d.operatingMinutes ?? 0) > 0;

const isDark = (d: { showCount: number | null; operatingMinutes: number | null; scheduledMinutes: number | null }) =>
  d.showCount === 0 && d.operatingMinutes === 0 && (d.scheduledMinutes ?? 0) > 0;

const emptyCounts = (): DayCounts => ({ classified: 0, performed: 0, dark: 0, unexplainedDark: 0, partyDark: 0, nonPartyPerformed: 0 });

function profileFor(parkId: ParkId, e: ThemeParksHistoryEntity, usableDays: string[], priorDays: string[], today: string): HistoryRefProfile {
  const p: HistoryRefProfile = {
    performed: 0, dark: 0, unexplainedDark: 0, unknown: 0, partyDark: 0, partyPerformed: 0, nonPartyPerformed: 0,
    recent: emptyCounts(), darkLast7: 0, sameWeekday: { classified: 0, performed: 0, dark: 0 },
    unreliable: e.droppedDays > 0, todayActive: false,
  };
  const byDate = new Map(e.days.map((d) => [d.date, d]));
  const t = byDate.get(today);
  p.todayActive = !!t && isActive(t);
  const recentSet = new Set(priorDays.slice(-HISTORY_RECENT_DAYS));
  const last7 = new Set(priorDays.slice(-7));
  const todayEvents = getPartyNightEventIds(parkId, today);
  const todayIsParty = todayEvents.length > 0;
  const wdDays = new Set<string>();
  for (let k = 1; k <= HISTORY_LONG_WEEKLY_LOOKBACKS; k++) { const d = addDaysToLocalDate(today, -7 * k); if (d) wdDays.add(d); }
  for (const date of usableDays) {
    const row = byDate.get(date);
    // A prior night's class relative to TODAY's party: "same" = a night of an event
    // that is also confirmed today; "other" = a night of a different party; "none" =
    // registry confirms no party; "unknown" = the registry cannot say.
    const ids = getPartyNightEventIds(parkId, date);
    const cls: "same" | "other" | "none" | "unknown" =
      ids.length > 0 ? (ids.some((i) => todayEvents.includes(i)) ? "same" : "other")
        : getPartyNightState(parkId, date) === "not_party" ? "none" : "unknown";
    const performed = !!row && isActive(row);
    const dark = !performed && !!row && isDark(row);
    if (performed) {
      p.performed++;
      if (cls === "same") p.partyPerformed++;
      else if (cls === "none") p.nonPartyPerformed++;
    } else if (dark) {
      p.dark++;
      if (cls === "same") p.partyDark++;
      else if (cls !== "other") p.unexplainedDark++; // dark on another party's night is explained by that party
    } else {
      p.unknown++;
    }
    if (!performed && !dark) continue;
    const unexplained = dark && cls !== "same" && cls !== "other";
    if (recentSet.has(date)) {
      p.recent.classified++;
      if (performed) { p.recent.performed++; if (cls === "none") p.recent.nonPartyPerformed++; }
      else { p.recent.dark++; if (cls === "same") p.recent.partyDark++; else if (unexplained) p.recent.unexplainedDark++; }
    }
    if (unexplained && last7.has(date)) p.darkLast7++;
    // Same weekday as today, compared only against days of the same party-night class
    // (a party-night dark Friday says nothing about an ordinary Friday, and vice versa).
    if (wdDays.has(date) && (todayIsParty ? cls === "same" : cls === "none" || cls === "unknown")) {
      p.sameWeekday.classified++;
      if (performed) p.sameWeekday.performed++; else p.sameWeekday.dark++;
    }
  }
  return p;
}

/**
 * Pure: park-level history → per-ref evidence. `null` result (not fetched) → null.
 * A failed/stale/incomplete payload yields `usable: false` evidence (never throws);
 * today-activity vetoes are still honored from any payload that carries today's rows.
 */
export function buildParkHistoryEvidence(
  parkId: ParkId,
  resort: ResortId,
  result: ThemeParksResult<ThemeParksHistoryDaily> | null,
  instant: Date,
): ParkHistoryEvidence | null {
  if (!result) return null;
  const today = getResortLocalDate(resort, instant);
  const base: ParkHistoryEvidence = { today, windowDays: 0, mode: null, usable: false, reason: null, reasonCode: null, usablePriorDays: [], anomalousDays: [], refs: new Map() };
  if (!result.ok) return { ...base, reason: `history unavailable (${result.error.kind})`, reasonCode: "unavailable" };
  const h = result.data;
  const span = Math.round((Date.parse(`${h.to}T00:00:00Z`) - Date.parse(`${h.from}T00:00:00Z`)) / 86_400_000) + 1;

  const blank = (): HistoryRefProfile => ({ performed: 0, dark: 0, unexplainedDark: 0, unknown: 0, partyDark: 0, partyPerformed: 0, nonPartyPerformed: 0, recent: emptyCounts(), darkLast7: 0, sameWeekday: { classified: 0, performed: 0, dark: 0 }, unreliable: true, todayActive: true });
  // Today's activity veto needs only today's rows in the answered window.
  const todayVeto = new Map<string, HistoryRefProfile>();
  if (h.to === today) {
    for (const e of h.entities) {
      const t = e.days.find((d) => d.date === today);
      if (t && isActive(t)) todayVeto.set(e.entityId.toLowerCase(), blank());
    }
  }
  const reject = (reason: string, reasonCode: HistoryRejectCode): ParkHistoryEvidence => ({ ...base, reason, reasonCode, refs: todayVeto });

  if (result.meta.origin === "stale") return reject("history is stale-if-error", "stale");
  if (getResortLocalDate(resort, new Date(result.meta.fetchedAt)) !== today) return reject("history fetched on a different resort-local day", "fetched_other_day");
  if (span !== HISTORY_SHORT_DAYS && span !== HISTORY_LONG_DAYS) return reject("history window is neither the 7-day nor the 30-day window", "window_unsupported");
  if (h.to !== today || h.from !== (addDaysToLocalDate(today, -(span - 1)) ?? "")) return reject("history window does not match today's resort-local window", "window_mismatch");
  if (h.hasMore) return reject("history has a continuation (incomplete)", "paged");
  if (h.droppedEntities > 0) return reject("history had malformed entities discarded", "dropped_entities");
  const mode = span === HISTORY_LONG_DAYS ? "long" : "short";

  const priorDays: string[] = [];
  for (let d = h.from; d < today; d = addDaysToLocalDate(d, 1) ?? today) priorDays.push(d);
  const shows = h.entities.filter((e) => e.entityType === "SHOW");
  const stats = priorDays.map((date) => {
    let rows = 0;
    let zero = 0;
    for (const e of shows) {
      const r = e.days.find((d) => d.date === date);
      if (!r) continue;
      rows++;
      if (r.showCount === 0 && r.operatingMinutes === 0) zero++;
    }
    return { date, rows, zero };
  });
  const maxRows = Math.max(0, ...stats.map((s) => s.rows));
  const covered = (s: { rows: number }) => s.rows >= HISTORY_COVERAGE_MIN_ROWS && s.rows >= HISTORY_COVERAGE_MIN_SHARE * maxRows;
  const anomalous = (s: { rows: number; zero: number }) => s.rows >= HISTORY_ANOMALY_MIN_ROWS && s.zero / s.rows >= HISTORY_ANOMALY_ZERO_SHARE;
  const yesterday = addDaysToLocalDate(today, -1);
  const yStat = stats.find((s) => s.date === yesterday);
  const anomalousDays = stats.filter((s) => covered(s) && anomalous(s)).map((s) => s.date);
  const usablePriorDays = stats.filter((s) => covered(s) && !anomalous(s)).map((s) => s.date);
  const withDays = { ...base, windowDays: span, mode, anomalousDays, usablePriorDays } as ParkHistoryEvidence;
  if (!yStat || !covered(yStat)) return { ...withDays, reason: "history does not yet cover yesterday (lagging feed)", reasonCode: "lagging", refs: todayVeto };
  if (mode === "short") {
    if (usablePriorDays.length < HISTORY_MIN_USABLE_PRIOR_DAYS) return { ...withDays, reason: "too few usable prior days", reasonCode: "few_usable_days", refs: todayVeto };
  } else {
    const recent7 = new Set(priorDays.slice(-7));
    if (usablePriorDays.length < Math.ceil(priorDays.length * HISTORY_LONG_MIN_USABLE_SHARE)) return { ...withDays, reason: "too few usable prior days (30-day window)", reasonCode: "few_usable_days", refs: todayVeto };
    if (usablePriorDays.filter((d) => recent7.has(d)).length < HISTORY_LONG_MIN_USABLE_RECENT7) return { ...withDays, reason: "too little recent coverage (last 7 days)", reasonCode: "low_recent_coverage", refs: todayVeto };
  }

  const refs = new Map<string, HistoryRefProfile>();
  for (const e of h.entities) refs.set(e.entityId.toLowerCase(), profileFor(parkId, e, usablePriorDays, priorDays, today));
  return { ...withDays, usable: true, reason: null, reasonCode: null, refs };
}

/**
 * Per-ref verdict with the reason (Phase 14.4.2 diagnostics). `basis: null` =
 * history does not support inactivity (visible). `todayParty` is the registry
 * state for today's resort-local date at the park. The `code` explains the
 * FIRST failing gate; it never changes the decision.
 */
export function historySupportDecision(
  evidence: ParkHistoryEvidence | null,
  entityId: string,
  todayParty: "party" | "not_party" | "unknown",
): { basis: InactivityBasis | null; code: HistoryRefCode } {
  const no = (code: HistoryRefCode) => ({ basis: null, code });
  if (!evidence || !evidence.usable) return no("no_evidence");
  const p = evidence.refs.get(entityId.toLowerCase());
  if (!p) return no("ref_absent");
  if (p.unreliable) return no("ref_unreliable");
  if (p.todayActive) return no("today_active");
  if (todayParty === "party" && p.partyPerformed > 0) return no("party_performed"); // performs on party nights: never assume suppression
  const yes = (basis: InactivityBasis) => ({ basis, code: "supported" as HistoryRefCode });
  if (evidence.mode === "long") {
    const r = p.recent;
    if (r.classified < HISTORY_LONG_MIN_RECENT_CLASSIFIED) return no("recent_coverage_low"); // sparsely recorded recently
    if (r.performed < HISTORY_LONG_MIN_RECENT_PERFORMED) return no("recent_performed_low"); // not demonstrably active recently
    if (todayParty === "party" && p.partyDark >= HISTORY_LONG_PARTY_MIN_DARK && r.partyDark >= 1 && r.nonPartyPerformed >= HISTORY_LONG_PARTY_MIN_RECENT_NONPARTY_PERFORMED) return yes("history_party");
    if (p.sameWeekday.classified >= HISTORY_LONG_WEEKLY_MIN_DARK && p.sameWeekday.performed === 0 && p.sameWeekday.dark >= HISTORY_LONG_WEEKLY_MIN_DARK) return yes("history_weekly");
    if (r.unexplainedDark >= HISTORY_LONG_INTERMITTENT_MIN_DARK && r.unexplainedDark / r.classified >= HISTORY_LONG_INTERMITTENT_MIN_DARK_SHARE && p.darkLast7 >= 1) return yes("history");
    if (todayParty === "party") return no(p.partyDark < HISTORY_LONG_PARTY_MIN_DARK ? "party_dark_insufficient" : "party_recent_insufficient");
    return no("no_pattern");
  }
  const classified = p.performed + p.dark;
  if (todayParty === "party") {
    if (p.partyDark >= HISTORY_PARTY_MIN_DARK && p.nonPartyPerformed >= HISTORY_PARTY_MIN_NONPARTY_PERFORMED && classified >= HISTORY_PARTY_MIN_CLASSIFIED) return yes("history_party");
  }
  if (p.performed >= HISTORY_GENERIC_MIN_PERFORMED && p.unexplainedDark >= HISTORY_GENERIC_MIN_UNEXPLAINED_DARK && classified >= HISTORY_GENERIC_MIN_CLASSIFIED) return yes("history");
  return no(todayParty === "party" ? "party_pattern_insufficient" : "no_pattern");
}

/** Per-ref verdict (basis only). `null` = history does not support inactivity (visible). */
export function historySupportForRef(
  evidence: ParkHistoryEvidence | null,
  entityId: string,
  todayParty: "party" | "not_party" | "unknown",
): InactivityBasis | null {
  return historySupportDecision(evidence, entityId, todayParty).basis;
}

/** True when history for this ref shows activity in today's (partial) row: vetoes ANY inactivity route. */
export function historyShowsActivityToday(evidence: ParkHistoryEvidence | null, entityId: string): boolean {
  return !!evidence?.refs.get(entityId.toLowerCase())?.todayActive;
}

// ============================================
// DEV CHECKS (run manually; returns failing labels)
// ============================================

type Row = { date: string; showCount: number | null; operatingMinutes: number | null; scheduledMinutes: number | null };
const row = (date: string, showCount: number | null, operatingMinutes: number | null = showCount ? 600 : 0, scheduledMinutes: number | null = 870): Row => ({ date, showCount, operatingMinutes, scheduledMinutes });
const ent = (id: string, days: Row[], type = "SHOW", droppedDays = 0): ThemeParksHistoryEntity => ({ entityId: id, entityType: type, firstRecordedAt: null, days, droppedDays });

/** Per-entity day spec for `devHistoryFixture`: counts oldest → today ("-" = no row), or a generator. */
export type DevHistorySpec = Array<number | "-"> | ((date: string, index: number) => number | "-");

/** Test fixture builder (exported for the DEV suites in entertainmentHistoryDev.ts). */
export function devHistoryFixture(
  today: string,
  specs: Record<string, DevHistorySpec>,
  opts: { days?: number; fetchedAt?: number; origin?: "network" | "cache" | "stale"; hasMore?: boolean; droppedEntities?: number; filler?: boolean } = {},
): ThemeParksResult<ThemeParksHistoryDaily> {
  const n = opts.days ?? HISTORY_SHORT_DAYS;
  const dates = Array.from({ length: n }, (_, i) => addDaysToLocalDate(today, i - (n - 1))!);
  const entities = Object.entries(specs).map(([id, v]) =>
    ent(id, dates.flatMap((d, i) => { const c = typeof v === "function" ? v(d, i) : (v[i] ?? "-"); return c === "-" ? [] : [row(d, c)]; })));
  if (opts.filler !== false) {
    // Ten steadily performing SHOWs so day coverage/anomaly stats have a population.
    for (let k = 0; k < 10; k++) entities.push(ent(`filler-${k}`, dates.map((d) => row(d, 2))));
  }
  const fetchedAt = opts.fetchedAt ?? Date.parse(`${today}T16:00:00Z`);
  return {
    ok: true,
    data: { entityId: "park", timeZone: "America/New_York", from: dates[0], to: today, entities, hasMore: opts.hasMore ?? false, droppedEntities: opts.droppedEntities ?? 0 },
    meta: { origin: opts.origin ?? "network", fetchedAt, etag: null, ...(opts.origin === "stale" ? { staleReason: { kind: "network" as const, message: "x" } } : {}) },
  };
}

export function runDevEntertainmentHistoryCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const NOW = new Date("2026-11-13T16:30:00Z"); // 11:30 AM EST Nov 13 (a confirmed MVMCP night)
  const T = "2026-11-13";
  const ev = (r: ThemeParksResult<ThemeParksHistoryDaily> | null) => buildParkHistoryEvidence("mk", "WDW", r, NOW);
  // window: Nov 7..13. Party nights (MVMCP) 8, 9, 12, 13. Entity columns: 7,8,9,10,11,12,13(today).
  const hea = devHistoryFixture(T, { hea: [1, 0, "-", 1, 1, 0, "-"] });
  check("windows: 7-day [today-6, today], 30-day [today-29, today]", historyWindow("WDW", NOW).from === "2026-11-07" && historyWindow("WDW", NOW).to === T && historyWindow("WDW", NOW, 30).from === "2026-10-15");
  const e1 = ev(hea)!;
  check("healthy history is usable", e1.usable && e1.reason === null);
  check("HEA-style: dark only on party nights, performs otherwise → party support on a party date", historySupportForRef(e1, "hea", "party") === "history_party");
  check("same entity on a NON-party date: dark days are party-explained → no support (emptiness unexplained)", historySupportForRef(e1, "hea", "not_party") === null && historySupportForRef(e1, "hea", "unknown") === null);
  // performs on a party night → no party suppression
  const perf = ev(devHistoryFixture(T, { x: [1, 1, 1, 1, 1, 0, "-"] }))!;
  check("performed on a party night → never party-suppressed", historySupportForRef(perf, "x", "party") === null);
  // single party-dark night is not 'multiple'
  const one = ev(devHistoryFixture(T, { x: [1, 0, "-", 1, 1, 1, "-"] }))!;
  check("only one party-dark night → no party support", historySupportForRef(one, "x", "party") === null);
  // regular daily performer, no dark days: never supported
  const daily = ev(devHistoryFixture(T, { x: [3, 3, 3, 3, 3, 3, "-"] }))!;
  check("performs every day → no support (empty live is more likely lag)", historySupportForRef(daily, "x", "party") === null && historySupportForRef(daily, "x", "not_party") === null);
  // generic dark-day pattern (non-party-explained): Nov 7,11 dark (not party), 8..? performed
  const dark = ev(devHistoryFixture(T, { x: [0, 2, 2, "-", 0, 2, "-"], y: [2, 2, 2, 2, 2, 2, "-"] }))!;
  check("unexplained dark ≥2 + performed ≥3 + classified ≥5 → generic support", historySupportForRef(dark, "x", "not_party") === "history");
  const darkFew = ev(devHistoryFixture(T, { x: [0, 2, "-", "-", 0, 2, "-"] }))!;
  check("too few classified days → no support", historySupportForRef(darkFew, "x", "not_party") === null);
  // missing rows / showCount 0 alone are not proof
  const missing = ev(devHistoryFixture(T, { x: ["-", "-", "-", "-", "-", "-", "-"] }))!;
  check("no rows at all → no support", historySupportForRef(missing, "x", "not_party") === null && historySupportForRef(missing, "unknown-id", "party") === null);
  // park-closed 'dark' (scheduledMinutes 0) is unknown, not dark
  const closedPark = devHistoryFixture(T, { x: [2, 2, 2, 2, 2, 2, "-"] });
  if (closedPark.ok) closedPark.data.entities.find((e) => e.entityId === "x")!.days = closedPark.data.entities.find((e) => e.entityId === "x")!.days.map((d, i) => (i === 3 || i === 4 ? row(d.date, 0, 0, 0) : d));
  check("showCount 0 while park had no scheduled hours is unknown, not dark", historySupportForRef(ev(closedPark), "x", "not_party") === null);
  // today's row shows activity → veto, even for stale history
  const todayAct = devHistoryFixture(T, { hea: [1, 0, "-", 1, 1, 0, 1] });
  check("today's row active → vetoes support", historySupportForRef(ev(todayAct), "hea", "party") === null && historyShowsActivityToday(ev(todayAct), "hea"));
  const staleAct = devHistoryFixture(T, { hea: [1, 0, "-", 1, 1, 0, 1] }, { origin: "stale" });
  check("stale history still vetoes (activity is evidence) but never supports", historyShowsActivityToday(ev(staleAct), "hea") && ev(staleAct)!.usable === false);
  // reliability gates
  check("stale-if-error history is not usable", !ev(devHistoryFixture(T, { hea: [1, 0, "-", 1, 1, 0, "-"] }, { origin: "stale" }))!.usable);
  check("continuation (next) → not usable", !ev(devHistoryFixture(T, { hea: [1, 0, "-", 1, 1, 0, "-"] }, { hasMore: true }))!.usable);
  check("dropped entities → not usable", !ev(devHistoryFixture(T, { hea: [1, 0, "-", 1, 1, 0, "-"] }, { droppedEntities: 1 }))!.usable);
  check("history fetched on the previous resort-local day → not usable (midnight)", !ev(devHistoryFixture(T, { hea: [1, 0, "-", 1, 1, 0, "-"] }, { fetchedAt: Date.parse("2026-11-13T04:30:00Z") }))!.usable);
  const shifted = devHistoryFixture("2026-11-12", { hea: [1, 0, "-", 1, 1, 0, "-"] });
  check("window answered for another day → not usable", !ev(shifted)!.usable);
  check("failed history → unusable evidence, never throws", ev({ ok: false, error: { kind: "rate_limited", message: "x" } })!.usable === false && ev(null) === null);
  // lagging feed: yesterday has no rows
  const lag = devHistoryFixture(T, { hea: [1, 0, "-", 1, 1, "-", "-"] }, { filler: false });
  if (lag.ok) for (let k = 0; k < 10; k++) lag.data.entities.push(ent(`f${k}`, ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"].map((d) => row(d, 2))));
  check("history lagging (yesterday uncovered) → not usable", !ev(lag)!.usable && /lagging/.test(ev(lag)!.reason ?? ""));
  // anomalous park-wide zero day is excluded
  const anom = devHistoryFixture(T, { x: [2, 2, 2, 0, 2, 2, "-"] }, { filler: false });
  if (anom.ok) for (let k = 0; k < 12; k++) anom.data.entities.push(ent(`f${k}`, anom.data.entities[0].days.map((d, i) => row(d.date, i === 3 ? 0 : 2))));
  const ea = ev(anom)!;
  check("park-wide zero day is anomalous and excluded", ea.anomalousDays.includes("2026-11-10") && !ea.usablePriorDays.includes("2026-11-10"));
  check("anomalous day never counts as a dark day", ea.refs.get("x")!.dark === 0);
  // dropped day rows → entity unreliable
  const dr = devHistoryFixture(T, { x: [0, 2, 2, 2, 0, 2, "-"] });
  if (dr.ok) dr.data.entities.find((e) => e.entityId === "x")!.droppedDays = 1;
  check("dropped day rows make the entity unreliable", historySupportForRef(ev(dr), "x", "not_party") === null);
  return failures;
}

/**
 * 30-day (authenticated) evidence cases. Fixtures are generated from the date,
 * never from a show name; Disneyland has no confirmed select-night party, so its
 * party class is always "unknown" (no party confounds), while Magic Kingdom
 * exercises the cross-event window (MNSSHP nights in October, MVMCP in November).
 */
export function runDevEntertainmentHistoryLongWindowCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const T = "2026-11-13"; // Friday
  const DLR_NOW = new Date("2026-11-13T19:00:00Z"); // 11:00 AM PST
  const MK_NOW = new Date("2026-11-13T16:30:00Z");
  const wd = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
  const dlr = (r: ThemeParksResult<ThemeParksHistoryDaily> | null, at = DLR_NOW) => buildParkHistoryEvidence("disneyland", "DLR", r, at)!;
  const mk = (r: ThemeParksResult<ThemeParksHistoryDaily> | null, at = MK_NOW) => buildParkHistoryEvidence("mk", "WDW", r, at)!;
  const fx = (specs: Record<string, DevHistorySpec>, o: Parameters<typeof devHistoryFixture>[2] = {}) => devHistoryFixture(T, specs, { days: 30, ...o });
  const sup = (e: ParkHistoryEvidence, id: string, party: "party" | "not_party" | "unknown" = "unknown") => historySupportForRef(e, id, party);
  const last7 = (d: string) => d >= "2026-11-06"; // 11-06..11-12 are the last 7 prior days

  const e0 = dlr(fx({ x: () => 2 }));
  check("30-day payload → long mode, 29 prior days", e0.usable && e0.mode === "long" && e0.windowDays === 30 && e0.usablePriorDays.length === 29);
  check("7-day payload → short mode (anonymous fallback unchanged)", buildParkHistoryEvidence("disneyland", "DLR", devHistoryFixture(T, { x: [2, 2, 2, 2, 2, 2, "-"] }), DLR_NOW)!.mode === "short");

  // Weekly show: dark every Friday, performs the rest of the week.
  const weekly: DevHistorySpec = (d) => (d === T ? "-" : wd(d) === 5 ? 0 : 2);
  check("weekly: dark on every prior Friday, active otherwise → history_weekly on a Friday", sup(dlr(fx({ x: weekly })), "x") === "history_weekly");
  const nonFri = new Date("2026-11-14T19:00:00Z"); // Saturday: same data shifted? (window answered for Nov 13 → rejected by date)
  check("weekly: the same evidence is never reused on another day (window must end today)", !dlr(fx({ x: weekly }), nonFri).usable);
  check("weekly: one prior Friday it performed → no weekly support", sup(dlr(fx({ x: (d) => (d === T ? "-" : d === "2026-10-30" ? 2 : wd(d) === 5 ? 0 : 2) })), "x") === null);
  check("weekly: only one classified prior Friday is not a pattern", sup(dlr(fx({ x: (d) => (d === T ? "-" : wd(d) === 5 ? (d === "2026-11-06" ? 0 : "-") : 2) })), "x") === null);
  // Moved weekday: dark on Fridays until two weeks ago, then performs Fridays → no support today.
  check("changed schedule: now performs on this weekday (last two Fridays active) → visible", sup(dlr(fx({ x: (d) => (d === T ? "-" : wd(d) === 5 ? (d >= "2026-10-30" ? 2 : 0) : 2) })), "x") === null);

  // Intermittent show.
  const inter: DevHistorySpec = (d) => (d === T ? "-" : ["2026-11-12", "2026-11-09", "2026-11-04", "2026-10-28"].includes(d) ? 0 : 2); // 4 dark in the last 14 prior days (28.6%)
  check("intermittent: ≥2 dark in recent 14, ≥20% of recent days, one in the last 7 → history", sup(dlr(fx({ x: inter })), "x") === "history");
  check("daily show with ONE rare outage → visible", sup(dlr(fx({ x: (d) => (d === T ? "-" : d === "2026-11-10" ? 0 : 2) })), "x") === null);
  check("daily show with two outages across 14 days (14% < 20%) → visible", sup(dlr(fx({ x: (d) => (d === T ? "-" : d === "2026-11-10" || d === "2026-11-01" ? 0 : 2) })), "x") === null);
  check("went daily (schedule change): dark days only older than 7 days → visible", sup(dlr(fx({ x: (d) => (d === T ? "-" : ["2026-10-31", "2026-11-02", "2026-11-04"].includes(d) ? 0 : 2) })), "x") === null);
  check("old gaps beyond the recent 14 days never count", sup(dlr(fx({ x: (d) => (d === T ? "-" : d < "2026-10-30" && wd(d) % 2 === 0 ? 0 : 2) })), "x") === null);

  // Old activity alone cannot establish today's inactivity.
  check("only old activity (nothing recorded in the last 14 days) → visible", sup(dlr(fx({ x: (d) => (d <= "2026-10-28" ? (wd(d) === 2 ? 0 : 2) : "-") })), "x") === null);
  check("stopped performing (dark all recent days) → visible (lifecycle is a later phase)", sup(dlr(fx({ x: (d) => (d === T ? "-" : d >= "2026-10-30" ? 0 : 2) })), "x") === null);
  check("sparse recent coverage (< 8 classified recent days) → visible", sup(dlr(fx({ x: (d) => (d === T ? "-" : d >= "2026-10-30" && !["2026-11-12", "2026-11-09", "2026-11-04", "2026-11-02", "2026-11-06"].includes(d) ? "-" : d === "2026-11-12" || d === "2026-11-09" ? 0 : 2) })), "x") === null);

  // Park-level gates.
  check("long: lagging feed (yesterday uncovered) → unusable", (() => { const r = fx({ x: inter }, { filler: false }); if (r.ok) for (let k = 0; k < 10; k++) r.data.entities.push(ent(`f${k}`, r.data.entities[0].days.filter((d) => d.date < "2026-11-12").map((d) => row(d.date, 2)))); return !dlr(r).usable && /lagging/.test(dlr(r).reason ?? ""); })());
  check("long: fillers only cover the first 10 days → too few usable days / lag → unusable", (() => { const r = fx({ x: inter }, { filler: false }); if (r.ok) { r.data.entities.push(...Array.from({ length: 10 }, (_, k) => ent(`f${k}`, r.data.entities[0].days.filter((d) => d.date <= "2026-10-24").map((d) => row(d.date, 2))))); } return !dlr(r).usable; })());
  check("long: only old coverage (recent 7 days thin) → unusable", (() => {
    const r = fx({ x: inter }, { filler: false });
    if (r.ok) { r.data.entities.push(...Array.from({ length: 10 }, (_, k) => ent(`f${k}`, r.data.entities[0].days.map((d) => row(d.date, 2)).filter((d) => !(d.date >= "2026-11-07" && d.date <= "2026-11-11") )))); }
    return !dlr(r).usable;
  })());
  check("long: continuation (pagination) → unusable", !dlr(fx({ x: inter }, { hasMore: true })).usable);
  check("long: stale-if-error → unusable (veto only)", !dlr(fx({ x: inter }, { origin: "stale" })).usable);
  check("long: dropped entities → unusable", !dlr(fx({ x: inter }, { droppedEntities: 1 })).usable);
  check("long: fetched on the previous resort-local day → unusable", !dlr(fx({ x: inter }, { fetchedAt: Date.parse("2026-11-13T05:00:00Z") })).usable);
  check("long: 30-day window answered for yesterday (just after local midnight) → unusable", !dlr(fx({ x: inter }), new Date("2026-11-14T08:30:00Z")).usable);
  check("long: window of an unsupported length (e.g. 14 days) → unusable", !dlr(fx({ x: inter }, { days: 14 })).usable);
  check("long: today's activity vetoes", sup(dlr(fx({ x: (d) => (d === T ? 1 : inter(d, 0)) })), "x") === null);
  check("long: park-wide anomaly days are excluded from the dark counts", (() => {
    const r = fx({ x: (d) => (d === T ? "-" : d === "2026-11-10" || d === "2026-11-11" ? 0 : 2) }, { filler: false });
    if (r.ok) for (let k = 0; k < 12; k++) r.data.entities.push(ent(`f${k}`, r.data.entities[0].days.map((d) => row(d.date, d.date === "2026-11-10" || d.date === "2026-11-11" ? 0 : 2))));
    const e = dlr(r); return e.anomalousDays.includes("2026-11-10") && sup(e, "x") === null;
  })());
  check("long: dropped day rows → entity unreliable", (() => { const r = fx({ x: inter }); if (r.ok) r.data.entities.find((e) => e.entityId === "x")!.droppedDays = 1; return sup(dlr(r), "x") === null; })());
  check("long: entity absent from history → visible", sup(dlr(fx({ y: inter })), "x") === null);

  // Party nights across events (MK: MNSSHP Oct nights, MVMCP Nov 8, 9, 12, 13).
  const mvmcp = (d: string) => getPartyNightEventIds("mk", d).includes("mvmcp");
  const heaLike: DevHistorySpec = (d) => (d === T || d === "2026-11-09" ? "-" : mvmcp(d) ? 0 : 2); // dark on 11-08, 11-12 only observed
  check("MK long: 2 observed MVMCP dark nights is not enough (need ≥ 3)", sup(mk(fx({ x: heaLike })), "x", "party") === null);
  const heaLike3: DevHistorySpec = (d) => (d === T ? "-" : mvmcp(d) ? 0 : 2);
  check("MK long: dark on ≥3 MVMCP nights, performs on others (incl. MNSSHP nights) → history_party", sup(mk(fx({ x: heaLike3 })), "x", "party") === "history_party");
  check("MK long: performing on a prior MVMCP night vetoes party suppression", sup(mk(fx({ x: (d) => (d === "2026-11-12" ? 2 : heaLike3(d, 0)) })), "x", "party") === null);
  check("MK long: another party's nights (MNSSHP) neither veto nor support", sup(mk(fx({ x: (d) => (d === T ? "-" : getPartyNightEventIds("mk", d).includes("mnsshp") ? 2 : mvmcp(d) ? 0 : 2) })), "x", "party") === "history_party");
  check("MK long: dark only on another party's nights is explained, not intermittent", sup(mk(fx({ x: (d) => (d === T ? "-" : getPartyNightEventIds("mk", d).includes("mnsshp") ? 0 : 2) })), "x", "not_party") === null);
  check("MK long: party-explained darkness is no support on a non-party date", sup(mk(fx({ x: heaLike3 })), "x", "not_party") === null);
  return failures;
}

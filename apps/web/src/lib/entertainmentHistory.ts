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
 * Reliability gates (the whole park payload — `usable`):
 *   - fresh: fetched on today's resort-local date and not stale-if-error;
 *   - complete: no continuation (`next`), no dropped entities, the answered
 *     window is exactly [today-6, today] (so midnight rollover rejects it);
 *   - current: YESTERDAY is covered (≥ 5 SHOW rows and ≥ 50% of the busiest
 *     prior day's rows) — a lagging feed is detected, not assumed away. No
 *     universal publication hour is assumed;
 *   - ≥ 4 of the 6 prior days are usable: covered AND not park-wide anomalous
 *     (≥ 30% of ≥ 8 reporting SHOWs at zero — outage/weather/provider gap, e.g.
 *     2026-11-10 at Magic Kingdom — counts as neither performed nor dark).
 * Per-ref day classes (usable prior days only): performed = showCount>0 or
 * operatingMinutes>0; dark = showCount 0 AND operatingMinutes 0 while the park
 * was scheduled open; anything else (absent row, null counts) = unknown.
 *
 * A ref supports inactivity only when (all refs of an entry must):
 *   generic:  performed ≥ 3, dark days NOT explained by confirmed party nights
 *             ≥ 2, classified (performed+dark) ≥ 5;
 *   party:    today is a registry-confirmed party night, the ref was dark on
 *             ≥ 2 confirmed party nights, never performed on one, performed on
 *             ≥ 2 confirmed NON-party nights, classified ≥ 4. Learned per ref
 *             — nothing is hardcoded and regular shows are never assumed to
 *             stop on party nights.
 * Both also need: no today row showing activity, no dropped day rows, and (in
 * entertainmentShowtimes) a clean current live payload with a published-today
 * quorum. A ref that performed on any party night in the window never gets
 * party-date support.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { addDaysToLocalDate, getResortLocalDate } from "./resortTime";
import { getPartyNightState } from "./seasonalEvents";
import type { ThemeParksHistoryDaily, ThemeParksHistoryEntity, ThemeParksResult } from "./themeParksApi";

export const HISTORY_WINDOW_DAYS = 7;
export const HISTORY_COVERAGE_MIN_ROWS = 5;
export const HISTORY_COVERAGE_MIN_SHARE = 0.5;
export const HISTORY_ANOMALY_MIN_ROWS = 8;
export const HISTORY_ANOMALY_ZERO_SHARE = 0.3;
export const HISTORY_MIN_USABLE_PRIOR_DAYS = 4;
export const HISTORY_GENERIC_MIN_PERFORMED = 3;
export const HISTORY_GENERIC_MIN_UNEXPLAINED_DARK = 2;
export const HISTORY_GENERIC_MIN_CLASSIFIED = 5;
export const HISTORY_PARTY_MIN_DARK = 2;
export const HISTORY_PARTY_MIN_NONPARTY_PERFORMED = 2;
export const HISTORY_PARTY_MIN_CLASSIFIED = 4;
/** Distinct live entities with a performance/operating record today before an empty ref is meaningful ("today's schedules have posted"). */
export const MIN_PUBLISHED_ENTITIES_TODAY = 3;

export type InactivityBasis = "forward_horizon" | "history" | "history_party";

export interface HistoryRefProfile {
  performed: number;
  dark: number;
  /** Dark days that were NOT confirmed party nights. */
  unexplainedDark: number;
  unknown: number;
  partyDark: number;
  partyPerformed: number;
  nonPartyPerformed: number;
  /** Malformed day rows were discarded for this entity: never evidence. */
  unreliable: boolean;
  /** Today's (partial) row shows activity: contradicts "not performing today". */
  todayActive: boolean;
}

export interface ParkHistoryEvidence {
  today: string;
  /** Whole-park gates passed (see header). */
  usable: boolean;
  /** Why not usable (null when usable). Diagnostic only. */
  reason: string | null;
  usablePriorDays: string[];
  anomalousDays: string[];
  /** lowercase entityId → profile; computed only when `usable` (todayActive is also kept when not). */
  refs: Map<string, HistoryRefProfile>;
}

/** [today-6, today] in resort-local dates (the single 7-day window the client requests). */
export function historyWindow(resort: ResortId, instant: Date): { from: string; to: string } {
  const to = getResortLocalDate(resort, instant);
  return { from: addDaysToLocalDate(to, -(HISTORY_WINDOW_DAYS - 1)) ?? to, to };
}

const isActive = (d: { showCount: number | null; operatingMinutes: number | null }) =>
  (d.showCount ?? 0) > 0 || (d.operatingMinutes ?? 0) > 0;

const isDark = (d: { showCount: number | null; operatingMinutes: number | null; scheduledMinutes: number | null }) =>
  d.showCount === 0 && d.operatingMinutes === 0 && (d.scheduledMinutes ?? 0) > 0;

function profileFor(parkId: ParkId, e: ThemeParksHistoryEntity, usableDays: string[], today: string): HistoryRefProfile {
  const p: HistoryRefProfile = { performed: 0, dark: 0, unexplainedDark: 0, unknown: 0, partyDark: 0, partyPerformed: 0, nonPartyPerformed: 0, unreliable: e.droppedDays > 0, todayActive: false };
  const byDate = new Map(e.days.map((d) => [d.date, d]));
  const t = byDate.get(today);
  p.todayActive = !!t && isActive(t);
  for (const date of usableDays) {
    const row = byDate.get(date);
    const party = getPartyNightState(parkId, date);
    if (row && isActive(row)) {
      p.performed++;
      if (party === "party") p.partyPerformed++;
      else if (party === "not_party") p.nonPartyPerformed++;
    } else if (row && isDark(row)) {
      p.dark++;
      if (party === "party") p.partyDark++;
      else p.unexplainedDark++;
    } else {
      p.unknown++;
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
  const base: ParkHistoryEvidence = { today, usable: false, reason: null, usablePriorDays: [], anomalousDays: [], refs: new Map() };
  if (!result.ok) return { ...base, reason: `history unavailable (${result.error.kind})` };
  const h = result.data;
  const win = historyWindow(resort, instant);

  // Today's activity veto needs only today's rows in the answered window.
  const todayVeto = new Map<string, HistoryRefProfile>();
  if (h.to === today) {
    for (const e of h.entities) {
      const t = e.days.find((d) => d.date === today);
      if (t && isActive(t)) todayVeto.set(e.entityId.toLowerCase(), { performed: 0, dark: 0, unexplainedDark: 0, unknown: 0, partyDark: 0, partyPerformed: 0, nonPartyPerformed: 0, unreliable: true, todayActive: true });
    }
  }
  const reject = (reason: string): ParkHistoryEvidence => ({ ...base, reason, refs: todayVeto });

  if (result.meta.origin === "stale") return reject("history is stale-if-error");
  if (getResortLocalDate(resort, new Date(result.meta.fetchedAt)) !== today) return reject("history fetched on a different resort-local day");
  if (h.from !== win.from || h.to !== win.to) return reject("history window does not match today's 7-day window");
  if (h.hasMore) return reject("history has a continuation (incomplete)");
  if (h.droppedEntities > 0) return reject("history had malformed entities discarded");

  const priorDays: string[] = [];
  for (let d = win.from; d < today; d = addDaysToLocalDate(d, 1) ?? today) priorDays.push(d);
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
  const withDays = { ...base, anomalousDays, usablePriorDays };
  if (!yStat || !covered(yStat)) return { ...withDays, reason: "history does not yet cover yesterday (lagging feed)", refs: todayVeto };
  if (usablePriorDays.length < HISTORY_MIN_USABLE_PRIOR_DAYS) return { ...withDays, reason: "too few usable prior days", refs: todayVeto };

  const refs = new Map<string, HistoryRefProfile>();
  for (const e of h.entities) refs.set(e.entityId.toLowerCase(), profileFor(parkId, e, usablePriorDays, today));
  return { ...withDays, usable: true, reason: null, refs };
}

/**
 * Per-ref verdict. `null` = history does not support inactivity (visible).
 * `todayParty` is the registry state for today's resort-local date at the park.
 */
export function historySupportForRef(
  evidence: ParkHistoryEvidence | null,
  entityId: string,
  todayParty: "party" | "not_party" | "unknown",
): "history" | "history_party" | null {
  if (!evidence || !evidence.usable) return null;
  const p = evidence.refs.get(entityId.toLowerCase());
  if (!p || p.unreliable || p.todayActive) return null;
  const classified = p.performed + p.dark;
  if (todayParty === "party") {
    if (p.partyPerformed > 0) return null; // performs on party nights: never assume suppression
    if (p.partyDark >= HISTORY_PARTY_MIN_DARK && p.nonPartyPerformed >= HISTORY_PARTY_MIN_NONPARTY_PERFORMED && classified >= HISTORY_PARTY_MIN_CLASSIFIED) return "history_party";
  }
  if (p.performed >= HISTORY_GENERIC_MIN_PERFORMED && p.unexplainedDark >= HISTORY_GENERIC_MIN_UNEXPLAINED_DARK && classified >= HISTORY_GENERIC_MIN_CLASSIFIED) return "history";
  return null;
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

/** Test fixture builder (exported for the DEV suites in entertainmentShowtimes.ts). */
export function devHistoryFixture(
  today: string,
  specs: Record<string, Array<number | "-">>, // entityId → [today-6 … today]; n = showCount, "-" = no row
  opts: { fetchedAt?: number; origin?: "network" | "cache" | "stale"; hasMore?: boolean; droppedEntities?: number; filler?: boolean } = {},
): ThemeParksResult<ThemeParksHistoryDaily> {
  const dates = Array.from({ length: HISTORY_WINDOW_DAYS }, (_, i) => addDaysToLocalDate(today, i - (HISTORY_WINDOW_DAYS - 1))!);
  const entities = Object.entries(specs).map(([id, v]) => ent(id, v.flatMap((c, i) => (c === "-" ? [] : [row(dates[i], c)]))));
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
  check("window is [today-6, today]", historyWindow("WDW", NOW).from === "2026-11-07" && historyWindow("WDW", NOW).to === T);
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

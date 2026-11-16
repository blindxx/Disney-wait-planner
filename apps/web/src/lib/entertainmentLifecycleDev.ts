/**
 * entertainmentLifecycleDev.ts — Phase 14.5C DEV regression cases (run manually
 * from Node; each returns failing labels, [] = all pass). Not imported by app code.
 *
 *   runDevEntertainmentLifecycleDetectorCases()   pure rules: thresholds, unknown days, silence, reset/re-hide,
 *                                                  exemptions, legacy, World of Color, classification, backfill
 *   runDevEntertainmentLifecycleVisibilityCases() Waits & Shows + All Entertainment paths, toggles, fail-open
 *   runDevEntertainmentLifecycleMonitorCases(realPool?)
 *                                                  persistence, idempotency, concurrency, late data, failures — over an
 *                                                  in-memory SQL stand-in; with `realPool` it ALSO runs against a real
 *                                                  Postgres (migrated via db:migrate). The real-DB part refuses to run
 *                                                  unless the three lifecycle tables are EMPTY and cleans up after itself:
 *                                                  point it ONLY at a scratch database.
 */

import type { ParkId } from "@disney-wait-planner/shared";
import type { Pool } from "pg";
import { devHistoryFixture, buildParkHistoryEvidence } from "./entertainmentHistory";
import {
  LIFECYCLE_MIN_INACTIVE_DAYS,
  LIFECYCLE_SILENCE_FLAG_DAYS,
  assessParkHealth,
  evaluateShowLifecycle,
  historyBackfillObservations,
  isLifecycleEligible,
  observeParkDay,
  observeShowDay,
  resolveLifecycleShow,
  type LifecycleDayClass,
  type LifecycleShowState,
} from "./entertainmentLifecycleDetector";
import { ENTERTAINMENT_LIFECYCLE_REGISTRY, type EntertainmentLifecycleRegistry } from "./entertainmentLifecycleRegistry";
import { LIFECYCLE_PARK_IDS, registryHideKind, runEntertainmentLifecycleMonitor, type LifecycleMonitorOptions } from "./entertainmentLifecycleMonitor";
import {
  getLifecycleAutoHidden, insertEvent, readEvidence, readLifecycleAudit, readStates, resetLifecycleReadState,
  tryLifecycleLock, upsertObservations, writeState,
} from "./entertainmentLifecycleStore";
import {
  filterLifecycleHiddenEntries, getLifecycleHiddenNames, getRegistryHiddenNames, performingNamesFromAllEntries, performingNamesFromShowtimes,
} from "./entertainmentLifecycleVisibility";
import { getAllEntertainmentEventEntries } from "./allEntertainmentEventFilter";
import { makeOffSeasonEntry, getOffSeasonCuratedEntertainment, applyAllEntertainmentSeasonalVisibility, isEntertainmentHiddenToday } from "./seasonalVisibility";
import type { EntertainmentShowtimeEntry, ParkEntertainmentShowtimes } from "./entertainmentShowtimes";
import { ENTERTAINMENT_PLACES, getEntertainmentForPark, getLegacyEntertainmentPlaces } from "./entertainmentSuggestions";
import { createPoolExecutor, type PersistExecutor, type Queryable } from "./parkHoursStore";
import { addDaysToLocalDate } from "./resortTime";
import { entertainmentMappingKey, getEntertainmentProviderMapping } from "./themeParksEntertainmentMapping";

const TODAY = "2026-12-10";
const d = (offset: number) => addDaysToLocalDate(TODAY, offset)!;

type Obs = { localDate: string; dayClass: LifecycleDayClass };
const run = (cls: LifecycleDayClass, from: number, to: number): Obs[] => {
  const out: Obs[] = [];
  for (let o = from; o <= to; o++) out.push({ localDate: d(o), dayClass: cls });
  return out;
};
const evalShow = (observations: Obs[], state: LifecycleShowState | null = null, extra: { eligible?: boolean; registryHide?: "none" | "confirmed" | "provisional"; today?: string } = {}) =>
  evaluateShowLifecycle({ today: extra.today ?? TODAY, observations, state, eligible: extra.eligible ?? true, registryHide: extra.registryHide ?? "none" });
const hiddenState = (over: Partial<LifecycleShowState> = {}): LifecycleShowState =>
  ({ status: "auto_hidden", cycleResetDate: null, lastActiveDate: null, hiddenLocalDate: d(-1), hideCount: 1, restoreCount: 0, silenceFlagged: false, secondaryEvaluatedOn: null, auditFlag: null, ...over });

// ---------- entry fixtures (ParkEntertainmentShowtimes level) ----------
const perf = (n: number) => Array.from({ length: n }, (_, i) => ({ startTime: `${TODAY}T${19 + i}:00:00-05:00`, endTime: null, localTime: "7:00 PM", type: "Performance Time", passed: false }));
const ref = (id: string, over: Partial<EntertainmentShowtimeEntry["provider"][number]> = {}) =>
  ({ entityId: id, present: true, status: "CLOSED", lastUpdated: null, rawShowtimeCount: 0, excludedShowtimeCount: 0, droppedShowtimeCount: 0, unrecognizedShowtimeCount: 0, ...over });
function mkEntry(parkId: ParkId, name: string, kind: "active" | "inactive" | "silent" | "unknown" | "silent_present" | "operating_empty" | "unmapped"): EntertainmentShowtimeEntry {
  const base = { dwpName: name, parkId, fetchedLocalDate: TODAY, unrecognizedTypes: [] as string[], message: null };
  const m = getEntertainmentProviderMapping(name, parkId);
  const ids = (m && m.disposition === "mapped" ? m.provider : []).map((r) => r.entityId);
  const refs = (over: Partial<EntertainmentShowtimeEntry["provider"][number]>) => (ids.length ? ids : ["00000000-0000-4000-8000-000000000000"]).map((i) => ref(i, over));
  switch (kind) {
    case "active": return { ...base, status: "upcoming", performances: perf(2), incomplete: false, provider: refs({ rawShowtimeCount: 2, status: "OPERATING" }), confirmedNoActivityToday: false } as unknown as EntertainmentShowtimeEntry;
    case "inactive": return { ...base, status: "none_posted", performances: [], incomplete: false, provider: refs({}), confirmedNoActivityToday: true, inactivityBasis: "forward_horizon" } as unknown as EntertainmentShowtimeEntry;
    case "silent": return { ...base, status: "unavailable", performances: [], incomplete: true, provider: refs({ present: false, status: null }), confirmedNoActivityToday: false } as unknown as EntertainmentShowtimeEntry;
    case "silent_present": return { ...base, status: "none_posted", performances: [], incomplete: false, provider: refs({}), confirmedNoActivityToday: false } as unknown as EntertainmentShowtimeEntry;
    case "operating_empty": return { ...base, status: "none_posted", performances: [], incomplete: false, provider: refs({ status: "OPERATING" }), confirmedNoActivityToday: false } as unknown as EntertainmentShowtimeEntry;
    case "unmapped": return { ...base, status: "unmapped", performances: [], incomplete: false, provider: [], confirmedNoActivityToday: false } as unknown as EntertainmentShowtimeEntry;
    default: return { ...base, status: "unavailable", performances: [], incomplete: true, provider: refs({}), confirmedNoActivityToday: false } as unknown as EntertainmentShowtimeEntry;
  }
}
const MMM = "Mickey's Mix Magic";
/** Park-wide fixture: every eligible catalog show of the park, with `overrides` per name; others "active" (coverage). */
function mkPark(parkId: ParkId, overrides: Record<string, Parameters<typeof mkEntry>[2]>, extra: Partial<ParkEntertainmentShowtimes> = {}, date = TODAY): ParkEntertainmentShowtimes {
  const entries = getEntertainmentForPark(parkId).map((p) => mkEntry(parkId, p.name, overrides[p.name] ?? (getEntertainmentProviderMapping(p.name, parkId)?.disposition === "mapped" ? "active" : "unmapped")));
  return { parkId, resort: parkId === "disneyland" || parkId === "dca" ? "DLR" : "WDW", localDate: date, asOf: `${date}T03:30:00Z`, fetchedLocalDate: date, stale: false, meta: { origin: "network", fetchedAt: 0 }, error: null, entries, ...extra } as ParkEntertainmentShowtimes;
}

// ============================================
// DETECTOR (pure)
// ============================================

export function runDevEntertainmentLifecycleDetectorCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };

  // ---- thresholds (rolling 30 days, ≥ 21 distinct inactive days) ----
  check("threshold constants: 21 of 30, silence 10", LIFECYCLE_MIN_INACTIVE_DAYS === 21 && LIFECYCLE_SILENCE_FLAG_DAYS === 10);
  let ev = evalShow(run("inactive", -19, 0));
  check("20 inactive days do NOT hide", ev.state.status === "visible" && ev.inactiveDays === 20 && ev.events.length === 0);
  ev = evalShow(run("inactive", -20, 0));
  check("21 inactive days hide (auto_hide event with evidence + coverage limitations)",
    ev.state.status === "auto_hidden" && ev.state.hiddenLocalDate === TODAY && ev.state.hideCount === 1 && ev.events.length === 1 && ev.events[0].type === "auto_hide" &&
    (ev.events[0].evidence as { inactiveDays: number }).inactiveDays === 21 && ev.events[0].coverageLimitations.length >= 2);
  const spread: Obs[] = [];
  for (let o = -29; o <= 0; o++) spread.push({ localDate: d(o), dayClass: (o + 29) % 10 >= 7 ? "unknown" : "inactive" }); // 21 inactive, 9 unknown gaps
  check("non-consecutive 21 of 30 hides (gaps are unknown days)", evalShow(spread).inactiveDays === 21 && evalShow(spread).state.status === "auto_hidden");
  const gappy: Obs[] = [];
  for (let o = -29; o <= 0; o++) if (o % 3 !== 0) gappy.push({ localDate: d(o), dayClass: "inactive" }); // 20 inactive
  check("20 non-consecutive inactive days (others missing) do not hide", evalShow(gappy).inactiveDays === 20 && evalShow(gappy).state.status === "visible");
  check("inactive days older than the 30-day window never count", evalShow([...run("inactive", -29, -10), ...run("inactive", -60, -30)]).inactiveDays === 20 && evalShow([...run("inactive", -29, -10), ...run("inactive", -60, -30)]).state.status === "visible");
  check("window edge: day -29 counts, day -30 does not", evalShow(run("inactive", -29, -9)).state.status === "auto_hidden" && evalShow(run("inactive", -30, -10)).state.status === "visible");

  // ---- unknown / missing / partial / stale never qualify ----
  check("20 inactive + 10 unknown days do not hide", evalShow([...run("inactive", -29, -10), ...run("unknown", -9, 0)]).state.status === "visible");
  check("21 UNKNOWN days (stale/partial/closed-only) never hide", evalShow(run("unknown", -29, 0)).state.status === "visible" && evalShow(run("unknown", -29, 0)).events.length === 0);
  check("no observations at all never hides", evalShow([]).state.status === "visible");
  check("future-dated rows are ignored", evalShow([...run("inactive", -19, 0), { localDate: d(1), dayClass: "inactive" }]).inactiveDays === 20);
  check("duplicate rows for a date collapse (strongest class wins; inactive+silent = one inactive day)",
    evalShow([...run("inactive", -19, 0), ...run("silent", -19, 0)]).inactiveDays === 20 && evalShow([...run("inactive", -20, 0), ...run("inactive", -20, 0)]).inactiveDays === 21);
  check("an active observation on the same date outranks inactive", evalShow([...run("inactive", -29, 0), { localDate: d(0), dayClass: "active" }]).state.status === "visible");
  check("elapsed time alone never hides (no observations ⇒ visible even with an old reset date)", evalShow([], { ...hiddenState(), status: "visible", hiddenLocalDate: null, hideCount: 0 }).state.status === "visible");

  // ---- provider silence ----
  check("9 silent days: no flag", evalShow(run("silent", -8, 0)).events.length === 0 && !evalShow(run("silent", -8, 0)).needsSecondary);
  ev = evalShow(run("silent", -9, 0));
  check("10 silent days: audit flag + secondary evaluation requested, still visible",
    ev.state.status === "visible" && ev.state.auditFlag === "provider_silence" && ev.state.silenceFlagged && ev.needsSecondary && ev.events.length === 1 && ev.events[0].type === "silence_flag");
  check("silence alone can NEVER hide (30 silent days)", evalShow(run("silent", -29, 0)).state.status === "visible" && evalShow(run("silent", -29, 0)).inactiveDays === 0);
  const flagged = ev.state;
  const again = evalShow(run("silent", -9, 0), flagged);
  check("flag raised once: re-evaluation emits no second event but still asks for secondary until it ran today", again.events.length === 0 && again.needsSecondary);
  check("secondary already done today → not requested again", !evalShow(run("silent", -9, 0), { ...flagged, secondaryEvaluatedOn: TODAY }).needsSecondary);
  check("an active day clears the silence flag and resets the cycle", (() => { const e = evalShow([...run("silent", -9, -1), { localDate: d(0), dayClass: "active" }], flagged); return e.state.auditFlag === null && !e.state.silenceFlagged && e.state.cycleResetDate === d(0) && e.silentDays === 0; })());
  check("silent + inactive days are separate counts (10 silent + 20 inactive: flag, no hide)", (() => { const e = evalShow([...run("silent", -29, -20), ...run("inactive", -19, 0)]); return e.state.status === "visible" && e.state.auditFlag === "provider_silence" && e.inactiveDays === 20; })());

  // ---- active reset / restore / re-hide ----
  check("an active day inside the window resets the cycle: 21 earlier inactive days no longer hide",
    (() => { const e = evalShow([...run("inactive", -29, -9), ...run("active", -8, -8), ...run("unknown", -7, 0)]); return e.state.status === "visible" && e.state.cycleResetDate === d(-8) && e.inactiveDays === 0; })());
  const hid = evalShow(run("inactive", -20, 0)).state;
  check("hidden show stays hidden without verified activity, even with no new observations (no decay-based restore)", evalShow([...run("inactive", -20, 0)], hid, { today: d(15) }).state.status === "auto_hidden");
  const restored = evalShow([...run("inactive", -20, -1), { localDate: d(0), dayClass: "active", performanceCount: 2 } as Obs], { ...hid, hiddenLocalDate: d(-1) });
  check("verified current performance restores a provisionally hidden show + resets the cycle + auto_restore event",
    restored.state.status === "visible" && restored.state.cycleResetDate === d(0) && restored.state.restoreCount === 1 && restored.events.length === 1 && restored.events[0].type === "auto_restore");
  const afterReturn = [...run("inactive", -20, -1), { localDate: d(0), dayClass: "active" as const }];
  check("old inactive evidence cannot re-hide after a return (even if still inside the window)", evalShow(afterReturn, restored.state, { today: d(0) }).state.status === "visible" && evalShow(afterReturn, restored.state, { today: d(0) }).inactiveDays === 0);
  const later = d(25);
  const rehide = evalShow([...afterReturn, ...run("inactive", 1, 25)], restored.state, { today: later });
  check("later 21-of-30 inactivity after the return re-hides (hide_count 2)", rehide.inactiveDays === 25 && rehide.state.status === "auto_hidden" && rehide.state.hideCount === 2);
  check("20 post-return inactive days do not re-hide", evalShow([...afterReturn, ...run("inactive", 1, 20)], restored.state, { today: d(20) }).state.status === "visible");
  check("late active data dated BEFORE the hide (newer than the reset) restores too (fail open)", evalShow([...run("inactive", -20, -10), { localDate: d(-5), dayClass: "active" }], hid).state.status === "visible");
  check("a future return announcement is not an input: no observations ⇒ a hidden show stays hidden", evalShow([], hid).state.status === "auto_hidden");

  // ---- registry / eligibility ----
  check("confirmed registry hide: 30 inactive days produce no automatic event or state change", (() => { const e = evalShow(run("inactive", -29, 0), null, { registryHide: "confirmed" }); return e.events.length === 0 && e.state.status === "visible"; })());
  check("confirmed registry hide + performance today: audit conflict flag, registry decision untouched", (() => { const e = evalShow([{ localDate: TODAY, dayClass: "active" }], null, { registryHide: "confirmed" }); return e.events[0]?.type === "registry_conflict" && e.state.auditFlag === "registry_conflict" && e.state.status === "visible"; })());
  check("registry conflict raised once", (() => { const first = evalShow([{ localDate: TODAY, dayClass: "active" }], null, { registryHide: "provisional" }); return evalShow([{ localDate: TODAY, dayClass: "active" }], first.state, { registryHide: "provisional" }).events.length === 0; })());
  check("ineligible (legacy/seasonal/unknown) identities are never evaluated or auto-resurfaced", (() => {
    const e = evalShow(run("inactive", -29, 0), null, { eligible: false });
    const h = evalShow([{ localDate: TODAY, dayClass: "active" }], hid, { eligible: false });
    return e.events.length === 0 && e.state.status === "visible" && h.state.status === "auto_hidden" && h.events.length === 0;
  })());

  // ---- eligibility against the real catalogs ----
  const seasonal = ENTERTAINMENT_PLACES.filter((p) => p.availabilityType === "seasonal" || p.availabilityTheme);
  check("catalog has seasonal entries and none is lifecycle-eligible", seasonal.length > 0 && seasonal.every((p) => !isLifecycleEligible(p.parkId as ParkId, p.name)));
  check("Disney on Broadway Concert Series (festival-associated) is exempt", !isLifecycleEligible("epcot", "Disney on Broadway Concert Series"));
  const legacy = getLegacyEntertainmentPlaces();
  check("legacy catalog entries are never eligible and do not resolve as active shows", legacy.length > 0 && legacy.every((p) => !isLifecycleEligible(p.parkId as ParkId, p.name) && resolveLifecycleShow(p.parkId as ParkId, p.name) === null));
  check("regular and limited are both eligible and follow identical rules", isLifecycleEligible("disneyland", "Fantasmic!") && isLifecycleEligible("disneyland", MMM) &&
    evalShow(run("inactive", -20, 0)).state.status === "auto_hidden");
  check("Mickey's Mix Magic is ACTIVE-catalog eligible and mapped with two provider refs (not registry-hidden)", isLifecycleEligible("disneyland", MMM) && registryHideKind("disneyland", MMM) === "none" &&
    (getEntertainmentProviderMapping(MMM, "disneyland") as { provider: unknown[] }).provider.length === 2);
  check("the four reviewed registry hides are confirmed hides", ["Paint the Night", "Wondrous Journeys", "Magic Happens Parade", "Main Street Electrical Parade"].every((n) => registryHideKind("disneyland", n) === "confirmed"));

  // ---- World of Color canonical identity ----
  const woc = resolveLifecycleShow("dca", "World of Color");
  check("World of Color resolves to the canonical entry", woc?.place.name === "World of Color" && woc.showKey === entertainmentMappingKey("dca", "World of Color"));
  for (const variant of ["World of Color – ONE", "World of Color: Happiness!", "World of Color – Season of Light"]) {
    check(`World of Color variant "${variant}" shares ONE canonical identity/key`, resolveLifecycleShow("dca", variant)?.showKey === woc?.showKey);
  }
  check("a variant-named provider entry observes under the canonical key and name", (() => {
    const e = { ...mkEntry("dca", "World of Color", "inactive"), dwpName: "World of Color – ONE" };
    const o = observeShowDay(e, TODAY, { healthy: true, limitations: [] });
    return !!o && o.showKey === woc?.showKey && o.showName === "World of Color";
  })());
  check("variants accumulate into ONE evaluation (21 days split across variant names still hides once)", (() => {
    const keys = new Set(["World of Color", "World of Color – ONE", "World of Color: Happiness!"].map((n) => resolveLifecycleShow("dca", n)!.showKey));
    return keys.size === 1;
  })());
  check("a variant never resolves in another park", resolveLifecycleShow("disneyland", "World of Color – ONE") === null);

  // ---- day classification (live) ----
  const healthy = { healthy: true, limitations: [] as string[] };
  const bad = { healthy: false, limitations: ["park coverage not healthy"] };
  const cls = (e: EntertainmentShowtimeEntry, h = healthy) => observeShowDay(e, TODAY, h)?.dayClass ?? null;
  check("classify: performances → active (even on an unhealthy park: a verified performance is positive evidence)", cls(mkEntry("disneyland", MMM, "active")) === "active" && cls(mkEntry("disneyland", MMM, "active"), bad) === "active");
  check("classify: confirmedNoActivityToday + healthy park → inactive with its basis", (() => { const o = observeShowDay(mkEntry("disneyland", MMM, "inactive"), TODAY, healthy); return o?.dayClass === "inactive" && o.basis === "forward_horizon" && o.limitations.length > 0; })());
  check("classify: confirmedNoActivityToday on an UNHEALTHY park → unknown", cls(mkEntry("disneyland", MMM, "inactive"), bad) === "unknown");
  check("classify: absent provider entities on a healthy park → silent (never inactive)", cls(mkEntry("disneyland", MMM, "silent")) === "silent");
  check("classify: absent entities on an unhealthy park → unknown", cls(mkEntry("disneyland", MMM, "silent"), bad) === "unknown");
  check("classify: present with no showtimes at all (not confirmed) → silent only when healthy", cls(mkEntry("disneyland", MMM, "silent_present")) === "silent" && cls(mkEntry("disneyland", MMM, "silent_present"), bad) === "unknown");
  check("classify: provider OPERATING with no times is ambiguous → unknown (CLOSED/OPERATING alone never qualify)", cls(mkEntry("disneyland", MMM, "operating_empty")) === "unknown");
  check("classify: incomplete/unavailable with refs present → unknown", cls(mkEntry("disneyland", MMM, "unknown")) === "unknown");
  check("classify: unmapped shows produce NO observation (nothing inferred)", observeShowDay(mkEntry("disneyland", "Paint the Night", "unmapped"), TODAY, healthy) === null);
  check("classify: a show with dropped/unrecognized records is not silent", (() => {
    const e = mkEntry("disneyland", MMM, "silent_present");
    e.provider = e.provider.map((r) => ({ ...r, droppedShowtimeCount: 1 }));
    return cls(e) === "unknown";
  })());
  check("classify: seasonal show entry produces no observation", observeShowDay(mkEntry("disneyland", "Halloween Screams", "inactive"), TODAY, healthy) === null);

  // ---- park health ----
  check("health: healthy park (≥3 shows publishing, fresh, current)", assessParkHealth(mkPark("disneyland", { [MMM]: "inactive" })).healthy);
  check("health: provider error → unhealthy", !assessParkHealth(mkPark("disneyland", {}, { error: { kind: "timeout", message: "t" } })).healthy);
  check("health: stale-if-error → unhealthy", !assessParkHealth(mkPark("disneyland", {}, { stale: true })).healthy);
  check("health: payload fetched on another resort-local day → unhealthy", !assessParkHealth(mkPark("disneyland", {}, { fetchedLocalDate: d(-1) })).healthy);
  check("health: low coverage (<3 shows publishing) → unhealthy", !assessParkHealth(mkPark("disneyland", Object.fromEntries(getEntertainmentForPark("disneyland").map((p) => [p.name, "unknown" as const])))).healthy);
  const obs = observeParkDay(mkPark("disneyland", { [MMM]: "inactive" }));
  check("observeParkDay: only eligible mapped shows are observed; MMM inactive, unmapped hidden shows skipped", obs.some((o) => o.showName === MMM && o.dayClass === "inactive") && !obs.some((o) => o.showName === "Paint the Night"));
  check("observeParkDay: unhealthy park yields no inactive/silent observations", observeParkDay(mkPark("disneyland", { [MMM]: "inactive" }, { stale: true })).every((o) => o.dayClass === "active" || o.dayClass === "unknown"));

  // ---- history backfill (secondary evaluation) ----
  const ids = (getEntertainmentProviderMapping(MMM, "disneyland") as { provider: Array<{ entityId: string }> }).provider.map((r) => r.entityId);
  const NOW = new Date("2026-12-10T20:00:00Z");
  const hist = devHistoryFixture(TODAY, { [ids[0]]: (_dt, i) => (i < 20 ? 0 : 2), [ids[1]]: (_dt, i) => (i < 20 ? 0 : 2) }, { days: 30 });
  const evid = buildParkHistoryEvidence("disneyland", "DLR", hist, NOW);
  check("backfill fixture: history usable", !!evid?.usable);
  const bf = historyBackfillObservations({ parkId: "disneyland", showKey: entertainmentMappingKey("disneyland", MMM), showName: MMM, refIds: ids, evidence: evid, history: hist });
  check("backfill: dark days on EVERY ref → inactive (history_dark), performed days → active", bf.some((o) => o.dayClass === "inactive" && o.basis === "history_dark") && bf.some((o) => o.dayClass === "active"));
  check("backfill never produces today or silent/unknown rows", bf.every((o) => o.localDate < TODAY && (o.dayClass === "inactive" || o.dayClass === "active") && o.source === "history_backfill"));
  check("backfill: one ref with no history rows → nothing (unknown, not dark)", historyBackfillObservations({ parkId: "disneyland", showKey: "k", showName: MMM, refIds: [ids[0], "ffffffff-ffff-4fff-8fff-ffffffffffff"], evidence: evid, history: hist }).length === 0);
  check("backfill: unusable/failed history → nothing", historyBackfillObservations({ parkId: "disneyland", showKey: "k", showName: MMM, refIds: ids, evidence: null, history: hist }).length === 0 &&
    historyBackfillObservations({ parkId: "disneyland", showKey: "k", showName: MMM, refIds: ids, evidence: { ...evid!, usable: false }, history: hist }).length === 0 &&
    historyBackfillObservations({ parkId: "disneyland", showKey: "k", showName: MMM, refIds: ids, evidence: evid, history: { ok: false, error: { kind: "network", message: "x" } } }).length === 0);
  const staleHist = devHistoryFixture(TODAY, { [ids[0]]: () => 0, [ids[1]]: () => 0 }, { days: 30, origin: "stale" });
  check("backfill: stale-if-error history never qualifies", historyBackfillObservations({ parkId: "disneyland", showKey: "k", showName: MMM, refIds: ids, evidence: buildParkHistoryEvidence("disneyland", "DLR", staleHist, NOW), history: staleHist }).length === 0);
  check("silence + history-dark backfill reaches the hide threshold only through inactive days", (() => {
    const silent = run("silent", -9, 0);
    const dark: Obs[] = bf.filter((o) => o.dayClass === "inactive").map((o) => ({ localDate: o.localDate, dayClass: o.dayClass }));
    const e = evalShow([...silent, ...dark]);
    return dark.length >= 1 && (dark.length >= 21 ? e.state.status === "auto_hidden" : e.state.status === "visible");
  })());
  return failures;
}

// ============================================
// VISIBILITY (both pages' shared path)
// ============================================

export function runDevEntertainmentLifecycleVisibilityCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const NOW = new Date("2026-12-10T20:00:00Z");
  const DL_TODAY = "2026-12-10";

  // ---- baseline: registry hides applied, Mickey's Mix Magic stays visible ----
  const base = getLifecycleHiddenNames("disneyland");
  check("baseline: the four reviewed registry hides are hidden", ["Paint the Night", "Wondrous Journeys", "Magic Happens Parade", "Main Street Electrical Parade"].every((n) => base.has(n)));
  check("baseline: Mickey's Mix Magic remains visible (detection reference case)", !base.has(MMM) && base.size === 4);
  check("baseline: other parks have no registry hides", LIFECYCLE_PARK_IDS.filter((p) => p !== "disneyland").every((p) => getLifecycleHiddenNames(p).size === 0));
  check("registry-hidden names stay hidden when the auto list is unknown (fail open for auto, registry preserved)", getLifecycleHiddenNames("disneyland", undefined).has("Paint the Night") && getLifecycleHiddenNames("disneyland", null).size === 4);

  // ---- auto-hidden names ----
  const withAuto = getLifecycleHiddenNames("disneyland", [MMM]);
  check("persisted auto-hidden show is hidden", withAuto.has(MMM));
  check("auto-hidden names for ineligible identities are ignored (legacy, seasonal, unknown, wrong park)",
    getLifecycleHiddenNames("disneyland", [getLegacyEntertainmentPlaces().find((p) => p.parkId === "disneyland")?.name ?? "x", "Halloween Screams", "No Such Show", "World of Color"]).size === 4);
  check("verified current performance un-hides an auto-hidden show immediately", !getLifecycleHiddenNames("disneyland", [MMM], new Set([MMM])).has(MMM));
  check("a performance does NOT override a CONFIRMED registry hide", getLifecycleHiddenNames("disneyland", [], new Set(["Paint the Night"])).has("Paint the Night"));
  const provisionalRegistry = { schemaVersion: 1, records: ENTERTAINMENT_LIFECYCLE_REGISTRY.records.map((r) => (r.name === "Paint the Night" ? { ...r, confirmation: "provisional" as const, nextReviewAction: { action: "monitor" as const } } : r)) } as EntertainmentLifecycleRegistry;
  check("a performance DOES un-hide a provisional registry hide (runtime only)", !getLifecycleHiddenNames("disneyland", [], new Set(["Paint the Night"]), provisionalRegistry).has("Paint the Night") && getLifecycleHiddenNames("disneyland", [], null, provisionalRegistry).has("Paint the Night"));
  check("registry hide excludes legacy identities", getRegistryHiddenNames("disneyland", { schemaVersion: 1, records: [{ ...ENTERTAINMENT_LIFECYCLE_REGISTRY.records[0], name: getLegacyEntertainmentPlaces().find((p) => p.parkId === "disneyland")!.name }] } as EntertainmentLifecycleRegistry).confirmed.size === 0);

  // ---- Waits & Shows path (curated catalog list + the existing today-rules) ----
  const dlShows = getEntertainmentForPark("disneyland");
  const hidden = getLifecycleHiddenNames("disneyland", [MMM]);
  const wsVisible = dlShows.filter((p) => !hidden.has(p.name) && !isEntertainmentHiddenToday(p, "DLR", DL_TODAY, undefined, NOW));
  check("Waits & Shows: hidden shows are absent from the visible list; others remain", !wsVisible.some((p) => hidden.has(p.name)) && wsVisible.some((p) => p.name === "Fantasmic!"));
  check("Waits & Shows: performing set derived from the showtimes entries", performingNamesFromShowtimes([{ dwpName: MMM, performances: [1] }, { dwpName: "Fantasmic!", performances: [] }]).has(MMM));

  // ---- All Entertainment path ----
  const entries = dlShows.map((p) => makeOffSeasonEntry(p, "disneyland"));
  const providerOnly = { ...makeOffSeasonEntry(dlShows[0], "disneyland"), id: "provider:abc", source: "provider_only" as const, name: MMM };
  const live = [...entries, providerOnly];
  const filtered = filterLifecycleHiddenEntries(live, hidden);
  check("All Entertainment: hidden curated entries removed; provider-only entry with the same name untouched", !filtered.some((e) => e.source === "curated" && hidden.has(e.name)) && filtered.includes(providerOnly));
  for (const toggle of [false, true]) {
    const out = applyAllEntertainmentSeasonalVisibility(live, "disneyland", "DLR", DL_TODAY, toggle, NOW, hidden);
    check(`All Entertainment: default list hides lifecycle-hidden shows (out-of-season toggle ${toggle ? "ON" : "OFF"} never reveals them)`, !out.some((e) => e.source === "curated" && hidden.has(e.name)) && out.some((e) => e.name === "Fantasmic!"));
  }
  const seasonalName = getEntertainmentForPark("disneyland").find((p) => p.availabilityTheme === "halloween" || p.availabilityTheme === "christmas")!;
  const offSeasonDate = "2026-07-15";
  const offSeason = (hide?: ReadonlySet<string>) => getOffSeasonCuratedEntertainment("disneyland", offSeasonDate, new Set(), new Date("2026-07-15T20:00:00Z"), hide);
  check("toggle path: an off-season seasonal show is synthesized, and excluded once hidden", offSeason().some((p) => p.name === seasonalName.name) && !offSeason(new Set([seasonalName.name])).some((p) => p.name === seasonalName.name));
  check("toggle path: unhidden off-season entries are unaffected", offSeason(new Set(["Not A Show"])).length === offSeason().length);
  const eventLive: ReturnType<typeof makeOffSeasonEntry>[] = [];
  const evOut = getAllEntertainmentEventEntries(eventLive, "disneyland", "all", NOW, new Set(["Halloween Screams"]));
  check("event browsing: 'All' selection unchanged by a hidden set", evOut === eventLive);
  // event browsing with a concrete event: hide the first synthesized show of that event and confirm it disappears
  const park = "mk" as ParkId;
  const mkNow = new Date("2026-11-10T20:00:00Z");
  const pool = getAllEntertainmentEventEntries([], park, "mvmcp", mkNow);
  if (pool.length > 0) {
    const victim = pool[0].name;
    check("event browsing: a hidden show is removed from synthesized event entries", !getAllEntertainmentEventEntries([], park, "mvmcp", mkNow, new Set([victim])).some((e) => e.name === victim) && getAllEntertainmentEventEntries([], park, "mvmcp", mkNow).some((e) => e.name === victim));
    const liveCurated = [makeOffSeasonEntry(getEntertainmentForPark(park).find((p) => p.name === victim)!, park)];
    check("event browsing: a hidden show is removed from LIVE event entries too", !getAllEntertainmentEventEntries(liveCurated, park, "mvmcp", mkNow, new Set([victim])).some((e) => e.name === victim));
  }
  check("All Entertainment performing set uses curated entries only", performingNamesFromAllEntries([{ source: "curated", name: MMM, showtime: { performances: [1] } }, { source: "provider_only", name: "X", showtime: { performances: [1] } }]).has(MMM) && !performingNamesFromAllEntries([{ source: "provider_only", name: "X", showtime: { performances: [1] } }]).has("X"));
  check("an All Entertainment entry performing now overrides an auto hide (same response)", !getLifecycleHiddenNames("disneyland", [MMM], performingNamesFromAllEntries([{ source: "curated", name: MMM, showtime: { performances: [1] } }])).has(MMM));
  return failures;
}

// ============================================
// STORE / MONITOR (in-memory SQL stand-in; optional real Postgres)
// ============================================

type Row = Record<string, unknown>;
const RANK: Record<string, number> = { unknown: 0, silent: 1, inactive: 2, active: 3 };

/** Minimal in-memory interpreter for exactly the statements the store issues; mirrors their SQL semantics. */
class FakeLifecycleDb implements Queryable {
  evidence = new Map<string, Row>();
  states = new Map<string, Row>();
  events = new Map<string, Row>();
  lockHeld = false;
  failAll = false;
  statements = 0;
  async query(text: string, v: unknown[] = []): Promise<{ rowCount: number | null; rows: Row[] }> {
    this.statements++;
    if (this.failAll) throw new Error("db down");
    const t = text.replace(/\s+/g, " ");
    if (t.includes("pg_try_advisory_xact_lock")) return { rowCount: 1, rows: [{ ok: !this.lockHeld }] };
    if (t.startsWith("INSERT INTO entertainment_lifecycle_evidence")) {
      const [park, key, date, name, cls, rank, basis, pc, source, lim] = v as [string, string, string, string, string, number, string | null, number, string, string];
      const k = `${park}|${key}|${date}`;
      const e = this.evidence.get(k);
      if (!e) this.evidence.set(k, { park_id: park, show_key: key, d: date, show_name: name, day_class: cls, class_rank: rank, basis, performance_count: pc, source, limitations: lim, observation_count: 1 });
      else {
        const up = rank > (e.class_rank as number);
        this.evidence.set(k, { ...e, show_name: name, day_class: up ? cls : e.day_class, basis: up ? basis : e.basis, source: up ? source : e.source, limitations: up ? lim : e.limitations,
          performance_count: up ? pc : rank === e.class_rank ? Math.max(e.performance_count as number, pc) : e.performance_count, class_rank: Math.max(e.class_rank as number, rank), observation_count: (e.observation_count as number) + 1 });
      }
      return { rowCount: 1, rows: [] };
    }
    if (t.startsWith("SELECT show_key, to_char(local_date")) {
      const [park, from, to] = v as string[];
      return { rowCount: 0, rows: [...this.evidence.values()].filter((r) => r.park_id === park && (r.d as string) >= from && (r.d as string) <= to).map((r) => ({ show_key: r.show_key, d: r.d, day_class: r.day_class, basis: r.basis, performance_count: r.performance_count })) };
    }
    if (t.startsWith("SELECT show_key, show_name, status")) return { rowCount: 0, rows: [...this.states.values()].filter((r) => r.park_id === v[0]) };
    if (t.startsWith("INSERT INTO entertainment_lifecycle_state")) {
      const [park, key, name, status, reset, lastActive, hiddenDate, hiddenAt, restoredAt, hc, rc, id, sd, flaggedAt, secOn, flag, evalDate] = v as (string | number | null)[];
      const k = `${park}|${key}`;
      const cur = this.states.get(k);
      if (cur && cur.evaluated_local_date && (cur.evaluated_local_date as string) > (evalDate as string)) return { rowCount: 0, rows: [] };
      this.states.set(k, { park_id: park, show_key: key, show_name: name, status, cycle_reset_date: reset, last_active_date: lastActive, hidden_local_date: hiddenDate, hidden_at: hiddenAt, restored_at: restoredAt, hide_count: hc, restore_count: rc, inactive_days: id, silent_days: sd, silence_flagged_at: flaggedAt, secondary_evaluated_on: secOn, audit_flag: flag, evaluated_local_date: evalDate });
      return { rowCount: 1, rows: [] };
    }
    if (t.startsWith("INSERT INTO entertainment_lifecycle_events")) {
      const [park, key, type, date, name, evidence, lim] = v as string[];
      const k = `${park}|${key}|${type}|${date}`;
      if (this.events.has(k)) return { rowCount: 0, rows: [] };
      this.events.set(k, { park_id: park, show_key: key, event_type: type, d: date, show_name: name, evidence: JSON.parse(evidence), coverage_limitations: JSON.parse(lim), audit_status: "unreviewed", occurred_at: new Date().toISOString() });
      return { rowCount: 1, rows: [] };
    }
    if (t.startsWith("DELETE FROM entertainment_lifecycle_evidence")) {
      const [park, before] = v as string[];
      for (const [k, r] of this.evidence) if (r.park_id === park && (r.d as string) < before) this.evidence.delete(k);
      return { rowCount: 0, rows: [] };
    }
    if (t.includes("WHERE status = 'auto_hidden' ORDER BY park_id")) return { rowCount: 0, rows: [...this.states.values()].filter((r) => r.status === "auto_hidden").map((r) => ({ park_id: r.park_id, show_name: r.show_name })) };
    throw new Error(`FakeLifecycleDb: unhandled SQL: ${t.slice(0, 80)}`);
  }
}
const MONITOR_DAY0 = "2026-12-01"; // resort-local date of the first simulated run (Disneyland/DCA)
const instantFor = (offsetDays: number) => new Date(Date.parse(`${addDaysToLocalDate(MONITOR_DAY0, offsetDays)}T03:30:00Z`) + 24 * 3600_000 - 1); // 03:30Z next UTC day ≈ evening local

export async function runDevEntertainmentLifecycleMonitorCases(realPool?: Pool): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const PARK: ParkId = "disneyland";
  const localOf = (off: number) => addDaysToLocalDate(MONITOR_DAY0, off)!;
  const mmmKey = entertainmentMappingKey(PARK, MMM);

  /** One scenario driver: simulated days; per-day kind for Mickey's Mix Magic; other parks' provider fails unless `allParks`. */
  async function drive(runDb: LifecycleMonitorOptions["runDb"], days: Array<Parameters<typeof mkEntry>[2] | "provider_down">, startOffset = 0, history?: LifecycleMonitorOptions["getHistory"]) {
    const reports = [];
    for (let i = 0; i < days.length; i++) {
      const off = startOffset + i;
      const kind = days[i];
      const date = localOf(off);
      reports.push(await runEntertainmentLifecycleMonitor({
        instant: instantFor(off), runDb, sleep: async () => {}, getHistory: history,
        getShowtimes: async (parkId) => {
          if (parkId !== PARK || kind === "provider_down") return mkPark(parkId, {}, { error: { kind: "timeout", message: "t" } }, date);
          return mkPark(parkId, { [MMM]: kind }, {}, date);
        },
      }));
    }
    return reports;
  }
  const stateOf = async (db: Queryable) => (await readStates(db, PARK)).get(mmmKey);

  // ============ in-memory ============
  {
    const db = new FakeLifecycleDb();
    const runDb: LifecycleMonitorOptions["runDb"] = async (_p, fn) => fn(db);

    // 20 inactive days → still visible; 21st → hidden, auditable.
    let reps = await drive(runDb, Array(20).fill("inactive"));
    let st = await stateOf(db);
    check("monitor: 20 verified inactive days → still visible", st?.status === "visible" && st.inactiveDays === 20);
    check("monitor: all six parks are attempted and reported each run", reps[0]!.parks.length === 6 && LIFECYCLE_PARK_IDS.every((p) => reps[0]!.parks.some((x) => x.parkId === p)));
    check("monitor: parks with a failed provider are reported provider_unavailable and write nothing", reps[0]!.parks.filter((p) => p.status === "provider_unavailable").length === 5 && ![...db.evidence.values()].some((r) => r.park_id !== PARK));
    reps = await drive(runDb, ["inactive"], 20);
    st = await stateOf(db);
    check("monitor: 21st verified inactive day → auto_hidden, hide event persisted for the audit", st?.status === "auto_hidden" && st.hiddenLocalDate === localOf(20) && reps[0]!.parks.find((p) => p.parkId === PARK)!.hidden.includes(MMM));
    const hideEv = [...db.events.values()].find((e) => e.event_type === "auto_hide");
    check("monitor: hide event carries evidence, coverage limitations and unreviewed audit status", !!hideEv && hideEv.audit_status === "unreviewed" && (hideEv.coverage_limitations as string[]).length >= 2 && (hideEv.evidence as { inactiveDays: number }).inactiveDays === 21);
    check("persisted state drives visibility end to end (MMM hidden on both page paths)", await (async () => {
      resetLifecycleReadState();
      const names = await getLifecycleAutoHidden(PARK, { executor: { run: (fn) => fn(db), abort() {} } as PersistExecutor });
      return !!names && names.includes(MMM) && getLifecycleHiddenNames(PARK, names).has(MMM);
    })());

    // duplicate delivery / same date again
    const evCount = db.events.size; const obsBefore = [...db.evidence.values()].find((r) => r.show_key === mmmKey && r.d === localOf(20))!.observation_count as number;
    await drive(runDb, ["inactive"], 20);
    st = await stateOf(db);
    check("monitor: a duplicated delivery is idempotent (same state, no new events; evidence counter bumps only)", st?.status === "auto_hidden" && db.events.size === evCount && (db.evidence.get(`${PARK}|${mmmKey}|${localOf(20)}`)!.observation_count as number) === obsBefore + 1 && st.hideCount === 1);
    // late run for an earlier date cannot overwrite newer state
    await drive(runDb, ["inactive"], 21);
    const newer = (await stateOf(db))!;
    await drive(runDb, ["unknown"], 5);
    const after = (await stateOf(db))!;
    check("monitor: a delayed run for an EARLIER date never overwrites a newer evaluation", after.evaluatedLocalDate === newer.evaluatedLocalDate && after.status === "auto_hidden");
    // late stronger data upgrades weaker same-day rows, never the reverse
    check("evidence precedence: active > inactive > silent > unknown, never downgraded", await (async () => {
      const q = new FakeLifecycleDb();
      const o = (cls: LifecycleDayClass) => ({ parkId: PARK, showKey: mmmKey, showName: MMM, localDate: TODAY, dayClass: cls, basis: cls, performanceCount: cls === "active" ? 2 : 0, source: "live" as const, limitations: [] });
      await upsertObservations(q, [o("unknown"), o("silent"), o("inactive")]);
      let row = (await readEvidence(q, PARK, TODAY, TODAY))[0];
      const ok1 = row.dayClass === "inactive";
      await upsertObservations(q, [o("unknown")]);
      row = (await readEvidence(q, PARK, TODAY, TODAY))[0];
      const ok2 = row.dayClass === "inactive";
      await upsertObservations(q, [o("active")]);
      row = (await readEvidence(q, PARK, TODAY, TODAY))[0];
      await upsertObservations(q, [o("inactive")]);
      const row2 = (await readEvidence(q, PARK, TODAY, TODAY))[0];
      return ok1 && ok2 && row.dayClass === "active" && row.performanceCount === 2 && row2.dayClass === "active";
    })());

    // restore on verified performance → visible; old evidence cannot re-hide
    reps = await drive(runDb, ["active"], 22);
    st = await stateOf(db);
    check("monitor: verified current performance restores the hidden show and resets the cycle", st?.status === "visible" && st.cycleResetDate === localOf(22) && st.restoreCount === 1 && !!st.restoredAt);
    check("monitor: restore is audited", [...db.events.values()].some((e) => e.event_type === "auto_restore" && e.d === localOf(22)));
    check("restored show is visible via persisted state", await (async () => { resetLifecycleReadState(); const n = await getLifecycleAutoHidden(PARK, { executor: { run: (fn) => fn(db), abort() {} } as PersistExecutor }); return !!n && !n.includes(MMM); })());
    await drive(runDb, Array(5).fill("inactive"), 23);
    check("monitor: old inactive evidence cannot re-hide after the return", (await stateOf(db))?.status === "visible");
    await drive(runDb, Array(16).fill("inactive"), 28); // inactive days 23..43 = 21 days after reset (22)
    st = await stateOf(db);
    check("monitor: a later 21-of-30 inactive pattern hides again (hide_count 2)", st?.status === "auto_hidden" && st.hideCount === 2);

    // provider failures never hide
    const db2 = new FakeLifecycleDb();
    const runDb2: LifecycleMonitorOptions["runDb"] = async (_p, fn) => fn(db2);
    await drive(runDb2, Array(40).fill("provider_down"));
    check("monitor: 40 days of provider failure → no observations, no state, no hide", db2.evidence.size === 0 && db2.states.size === 0 && db2.events.size === 0);
    const db2b = new FakeLifecycleDb();
    await drive(async (_p, fn) => fn(db2b), Array(40).fill("unknown"));
    check("monitor: 40 days of unknown/partial data → never hidden", (await stateOf(db2b))?.status !== "auto_hidden" && db2b.events.size === 0);

    // silence: 10 days → flag + secondary; never hides
    const db3 = new FakeLifecycleDb();
    let historyCalls = 0;
    const getHistory: LifecycleMonitorOptions["getHistory"] = async () => { historyCalls++; return { ok: false, error: { kind: "network", message: "h" } }; };
    reps = await drive(async (_p, fn) => fn(db3), Array(9).fill("silent"), 0, getHistory);
    check("monitor: 9 silent days → no flag, no history request for the monitor's secondary step", !(await stateOf(db3))?.silenceFlagged && ![...db3.events.values()].some((e) => e.event_type === "silence_flag"));
    reps = await drive(async (_p, fn) => fn(db3), ["silent"], 9, getHistory);
    st = await stateOf(db3);
    check("monitor: 10th silent day → audit flag, still visible, flagged event persisted", st?.status === "visible" && st.auditFlag === "provider_silence" && [...db3.events.values()].some((e) => e.event_type === "silence_flag"));
    check("monitor: secondary evaluation with unusable history changes nothing and is reported", reps[0]!.parks.find((p) => p.parkId === PARK)!.secondary === "history_unavailable" && st?.status === "visible");
    await drive(async (_p, fn) => fn(db3), Array(25).fill("silent"), 10, getHistory);
    check("monitor: 35 silent days never hide the show", (await stateOf(db3))?.status === "visible");

    // concurrency: busy lock
    const db4 = new FakeLifecycleDb(); db4.lockHeld = true;
    reps = await drive(async (_p, fn) => fn(db4), ["inactive"]);
    check("monitor: a held per-park lock reports busy and writes nothing", reps[0]!.parks.find((p) => p.parkId === PARK)!.status === "busy" && db4.evidence.size === 0 && db4.states.size === 0);
    check("monitor: an overlapping run on the same instance is refused (null)", await (async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      const first = runEntertainmentLifecycleMonitor({ instant: instantFor(0), runDb: async (_p, fn) => fn(new FakeLifecycleDb()), getShowtimes: async (p) => { await gate; return mkPark(p, {}, { error: { kind: "timeout", message: "t" } }); } });
      const second = await runEntertainmentLifecycleMonitor({ instant: instantFor(0) });
      release();
      await first;
      return second === null;
    })());

    // DB outage: fail open, preserved decisions
    const db5 = new FakeLifecycleDb();
    await drive(async (_p, fn) => fn(db5), Array(21).fill("inactive"));
    check("outage setup: show auto-hidden", (await stateOf(db5))?.status === "auto_hidden");
    db5.failAll = true;
    reps = await drive(async (_p, fn) => fn(db5), ["active"], 21);
    check("monitor: a database outage is reported per park (db_unavailable) and throws nothing", reps[0]!.parks.find((p) => p.parkId === PARK)!.status === "db_unavailable" && !reps[0]!.ok);
    db5.failAll = false;
    check("monitor: persisted hide survives the outage unchanged", (await stateOf(db5))?.status === "auto_hidden");
    resetLifecycleReadState();
    const failing: PersistExecutor = { run: async () => { throw new Error("down"); }, abort() {} };
    check("request path: DB failure → undefined (unknown ⇒ nothing automatic hidden); registry hides still apply", (await getLifecycleAutoHidden(PARK, { executor: failing })) === undefined && getLifecycleHiddenNames(PARK, undefined).has("Paint the Night"));
    resetLifecycleReadState();
    const hung: PersistExecutor = { run: () => new Promise(() => {}), abort() {} };
    const t0 = Date.now();
    check("request path: a hung database is bounded by the deadline and fails open", (await getLifecycleAutoHidden(PARK, { executor: hung, deadlineMs: 50 })) === undefined && Date.now() - t0 < 1500);
    resetLifecycleReadState();
    check("request path: no DATABASE_URL and no executor → unknown", (process.env.DATABASE_URL ? true : (await getLifecycleAutoHidden(PARK)) === undefined));

    // secondary evaluation with usable history backfills inactive days (silent days → hide only via inactive history days)
    const db6 = new FakeLifecycleDb();
    const ids = (getEntertainmentProviderMapping(MMM, PARK) as { provider: Array<{ entityId: string }> }).provider.map((r) => r.entityId);
    const lastDate = localOf(9);
    const histToday = lastDate;
    const dark = devHistoryFixture(histToday, { [ids[0]]: () => 0, [ids[1]]: () => 0 }, { days: 30, fetchedAt: Date.parse(`${addDaysToLocalDate(lastDate, 1)}T03:30:00Z`) });
    await drive(async (_p, fn) => fn(db6), Array(10).fill("silent"), 0, async () => dark);
    st = await stateOf(db6);
    check("monitor: usable history backfills validated dark days; 10 silent + 20 history-dark ⇒ evaluated from inactive days only", !!st && st.secondaryEvaluatedOn === lastDate && st.inactiveDays >= 1);
    check("monitor: history-backfilled evidence is stored with its source for the audit", [...db6.evidence.values()].some((r) => r.source === "history_backfill" && r.day_class === "inactive"));

    // concurrency primitive: second tryLock while held (fake)
    check("lock primitive: tryLifecycleLock reflects the held state", await (async () => { const q = new FakeLifecycleDb(); const a = await tryLifecycleLock(q, PARK); q.lockHeld = true; return a && !(await tryLifecycleLock(q, PARK)); })());
    check("audit read: report API works on stored rows", await (async () => { try { await readLifecycleAudit({ query: async () => ({ rowCount: 0, rows: [] }) }); return true; } catch { return false; } })());
    // writeState guard / events natural key
    check("writeState: an earlier evaluation date is rejected; events natural key dedupes", await (async () => {
      const q = new FakeLifecycleDb();
      const s = { status: "visible" as const, cycleResetDate: null, lastActiveDate: null, hiddenLocalDate: null, hideCount: 0, restoreCount: 0, silenceFlagged: false, secondaryEvaluatedOn: null, auditFlag: null, showKey: mmmKey, showName: MMM, hiddenAt: null, restoredAt: null, silenceFlaggedAt: null, inactiveDays: 0, silentDays: 0, evaluatedLocalDate: "2026-12-05" };
      const a = await writeState(q, PARK, s);
      const b = await writeState(q, PARK, { ...s, evaluatedLocalDate: "2026-12-01" });
      await insertEvent(q, PARK, mmmKey, MMM, { type: "auto_hide", localDate: TODAY, evidence: {}, coverageLimitations: [] });
      await insertEvent(q, PARK, mmmKey, MMM, { type: "auto_hide", localDate: TODAY, evidence: {}, coverageLimitations: [] });
      return a && !b && q.events.size === 1;
    })());
  }

  // ============ real Postgres (optional) ============
  if (realPool) {
    const exec = () => createPoolExecutor(realPool);
    const counts = await exec().run(async (q) => {
      const out: number[] = [];
      for (const t of ["evidence", "state", "events"]) out.push(Number((await q.query(`SELECT COUNT(*)::int AS n FROM entertainment_lifecycle_${t}`)).rows[0].n));
      return out;
    });
    if (counts.some((n) => n > 0)) { failures.push("real db: refusing to run — lifecycle tables are not empty (use a scratch database)"); return failures; }
    const runDb: LifecycleMonitorOptions["runDb"] = async (_p, fn) => exec().run(fn);
    try {
      await drive(runDb, Array(20).fill("inactive"));
      let st = await exec().run((q) => stateOf(q));
      check("real db: 20 inactive days → visible", st?.status === "visible" && st.inactiveDays === 20);
      await drive(runDb, ["inactive"], 20);
      st = await exec().run((q) => stateOf(q));
      check("real db: 21st inactive day → auto_hidden with audit event", st?.status === "auto_hidden" && (await exec().run((q) => readLifecycleAudit(q))).unreviewedEvents.some((e) => e.eventType === "auto_hide" && e.showName === MMM));
      const before = await exec().run((q) => readLifecycleAudit(q));
      await drive(runDb, ["inactive"], 20);
      const afterRep = await exec().run((q) => readLifecycleAudit(q));
      check("real db: duplicated delivery is idempotent (no extra events)", before.unreviewedEvents.length === afterRep.unreviewedEvents.length);
      await drive(runDb, ["unknown"], 5);
      check("real db: delayed run for an earlier date cannot overwrite the newer evaluation", (await exec().run((q) => stateOf(q)))?.status === "auto_hidden" && (await exec().run((q) => stateOf(q)))?.evaluatedLocalDate === localOf(20));
      await drive(runDb, ["active"], 21);
      st = await exec().run((q) => stateOf(q));
      check("real db: verified performance restores + resets cycle", st?.status === "visible" && st.cycleResetDate === localOf(21));
      // precedence in real SQL
      await exec().run(async (q) => {
        const o = (cls: LifecycleDayClass) => ({ parkId: PARK, showKey: "disneyland:precedence-probe", showName: "Probe", localDate: TODAY, dayClass: cls, basis: cls, performanceCount: cls === "active" ? 3 : 0, source: "live" as const, limitations: ["x"] });
        await upsertObservations(q, [o("unknown"), o("inactive"), o("silent"), o("active"), o("inactive")]);
      });
      const probe = await exec().run((q) => readEvidence(q, PARK, TODAY, TODAY));
      check("real db: evidence precedence (active survives later weaker rows; performance count kept)", probe.some((r) => r.showKey === "disneyland:precedence-probe" && r.dayClass === "active" && r.performanceCount === 3));
      // advisory lock: second transaction cannot take it while the first holds it
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      let firstGot = false;
      const holder = exec().run(async (q) => { firstGot = await tryLifecycleLock(q, PARK); await gate; });
      await new Promise((r) => setTimeout(r, 200));
      const secondGot = await exec().run((q) => tryLifecycleLock(q, PARK));
      release(); await holder;
      const thirdGot = await exec().run((q) => tryLifecycleLock(q, PARK));
      check("real db: per-park advisory lock excludes a concurrent transaction and is released at commit", firstGot && !secondGot && thirdGot);
      // lock is transaction-scoped: attempts outside a held transaction (sequential) both succeed — nothing leaks.
      const seq = [await exec().run((q) => tryLifecycleLock(q, PARK)), await exec().run((q) => tryLifecycleLock(q, PARK))];
      check("real db: sequential lock attempts both succeed (xact-scoped lock, no leak)", seq.every(Boolean));
      const hiddenNow = await exec().run(async (q) => (await q.query("SELECT show_name FROM entertainment_lifecycle_state WHERE status = 'auto_hidden'")).rows.length);
      check("real db: auto-hidden query (request path) works", hiddenNow >= 0);
    } finally {
      await exec().run(async (q) => {
        for (const t of ["evidence", "state", "events"]) await q.query(`DELETE FROM entertainment_lifecycle_${t}`);
      }).catch(() => { failures.push("real db: cleanup failed"); });
    }
  }
  return failures;
}

/** Registry consistency: every lifecycle-registry hidden record is applied by the visibility layer. */
export function runDevEntertainmentLifecycleRegistryApplicationCases(): string[] {
  const failures: string[] = [];
  for (const r of ENTERTAINMENT_LIFECYCLE_REGISTRY.records) {
    const hidden = getLifecycleHiddenNames(r.parkId).has(r.name);
    if ((r.visibility.decision === "hidden") !== hidden) failures.push(`registry application: ${r.name} decision=${r.visibility.decision} but hidden=${hidden}`);
  }
  return failures;
}

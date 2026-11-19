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
import vercelConfig from "../../vercel.json";
import type { Pool } from "pg";
import { devHistoryFixture, buildParkHistoryEvidence } from "./entertainmentHistory";
import {
  LIFECYCLE_MIN_INACTIVE_DAYS,
  LIFECYCLE_SILENCE_FLAG_DAYS,
  assessParkHealth,
  evaluateShowLifecycle,
  historyBackfillObservations,
  isDayEndWindow,
  isLifecycleEligible,
  isMappingIdentityEstablished,
  observeParkDay,
  registryHideKind,
  resortLocalHour,
  type RegistryHideKind,
  observeShowDay,
  resolveLifecycleShow,
  type LifecycleDayClass,
  type LifecycleShowState,
} from "./entertainmentLifecycleDetector";
import { ENTERTAINMENT_LIFECYCLE_REGISTRY, type EntertainmentLifecycleRegistry } from "./entertainmentLifecycleRegistry";
import { LEGACY_COMEBACK_MIN_DAYS, LEGACY_COMEBACK_WINDOW_DAYS, evaluateLegacyLifecycle, observeLegacyParkDay, resolveLegacyShow, type LegacyIdentityOptions } from "./entertainmentLifecycleDetector";
import { LIFECYCLE_CRON_PATH, LIFECYCLE_PARK_IDS, runEntertainmentLifecycleMonitor, type LifecycleMonitorOptions } from "./entertainmentLifecycleMonitor";
import {
  getLifecycleAutoHidden, insertEvent, readEvidence, readLifecycleAudit, readStates, resetLifecycleReadState,
  tryLifecycleLock, upsertObservations, writeState, getLifecycleVisibilityState,
} from "./entertainmentLifecycleStore";
import {
  activeRetainedEvidence, nextRetainedLifecycleEvidence, type RetainedLifecycleEvidence,
  filterLifecycleHiddenEntries, getLifecycleHiddenNames, getRegistryHiddenNames, performingNamesFromAllEntries, performingNamesFromShowtimes,
} from "./entertainmentLifecycleVisibility";
import { getAllEntertainmentEventEntries } from "./allEntertainmentEventFilter";
import { makeOffSeasonEntry, getOffSeasonCuratedEntertainment, applyAllEntertainmentSeasonalVisibility, isEntertainmentHiddenToday, nextRetainedInactivity, applyRetainedInactivity, type RetainedInactivity } from "./seasonalVisibility";
import { normalizeParkEntertainmentShowtimes, resolveShowtimesResponse, type EntertainmentShowtimeEntry, type ParkEntertainmentShowtimes } from "./entertainmentShowtimes";
import { getSeasonalEntertainmentRank } from "./seasonalEntertainment";
import { ENTERTAINMENT_PLACES, getEntertainmentForPark, getLegacyEntertainmentPlaces } from "./entertainmentSuggestions";
import { createPoolExecutor, type PersistExecutor, type Queryable } from "./parkHoursStore";
import { addDaysToLocalDate, getResortLocalDate } from "./resortTime";
import {
  LEGACY_ENTERTAINMENT_PROVIDER_MAPPING, THEMEPARKS_ENTERTAINMENT_MAPPING, entertainmentMappingKey, getEntertainmentProviderMapping,
  isLegacyIdentityEstablished, legacyProviderEntityIds, validateLegacyProviderMapping, type EntertainmentProviderMapping,
  discoverLegacyProviderIdentities, mergeDiscoveredLegacyIdentities, type DiscoveredLegacyIdentity,
} from "./themeParksEntertainmentMapping";
import { THEMEPARKS_PARKS } from "./themeParksProviders";
import { buildParkAllEntertainment } from "./entertainmentAll";
import { findShowtimeEntry, getLegacyComebackPlaces, legacyIdentityOptions, mergeLegacyComebackEntries, splitLegacyComebackEntries } from "./entertainmentLifecycleVisibility";
import type { ThemeParksLive } from "./themeParksApi";

const TODAY = "2026-12-10";
const d = (offset: number) => addDaysToLocalDate(TODAY, offset)!;

type Obs = { localDate: string; dayClass: LifecycleDayClass; final?: boolean; performanceCount?: number };
const run = (cls: LifecycleDayClass, from: number, to: number): Obs[] => {
  const out: Obs[] = [];
  for (let o = from; o <= to; o++) out.push({ localDate: d(o), dayClass: cls });
  return out;
};
const evalShow = (observations: Obs[], state: LifecycleShowState | null = null, extra: { eligible?: boolean; registryHide?: RegistryHideKind; today?: string } = {}) =>
  evaluateShowLifecycle({ today: extra.today ?? TODAY, observations, state, eligible: extra.eligible ?? true, registryHide: extra.registryHide ?? "none" });
const hiddenState = (over: Partial<LifecycleShowState> = {}): LifecycleShowState =>
  ({ status: "auto_hidden", cycleResetDate: null, lastActiveDate: null, hiddenLocalDate: d(-1), hideCount: 1, restoreCount: 0, silenceFlagged: false, secondaryEvaluatedOn: null, auditFlag: null, registryRestored: false, ...over });

// ---------- entry fixtures (ParkEntertainmentShowtimes level) ----------
const perf = (n: number) => Array.from({ length: n }, (_, i) => ({ startTime: `${TODAY}T${19 + i}:00:00-05:00`, endTime: null, localTime: "7:00 PM", type: "Performance Time", passed: false }));
const ref = (id: string, over: Partial<EntertainmentShowtimeEntry["provider"][number]> = {}) =>
  ({ entityId: id, present: true, status: "CLOSED", lastUpdated: null, rawShowtimeCount: 0, excludedShowtimeCount: 0, droppedShowtimeCount: 0, unrecognizedShowtimeCount: 0, ...over });
function mkEntry(parkId: ParkId, name: string, kind: "active" | "inactive" | "silent" | "dormant" | "unknown" | "silent_present" | "operating_empty" | "unmapped", idsOverride?: string[]): EntertainmentShowtimeEntry {
  const base = { dwpName: name, parkId, fetchedLocalDate: TODAY, unrecognizedTypes: [] as string[], message: null };
  const m = getEntertainmentProviderMapping(name, parkId);
  const ids = idsOverride ?? (m && m.disposition === "mapped" ? m.provider : []).map((r) => r.entityId);
  const refs = (over: Partial<EntertainmentShowtimeEntry["provider"][number]>) => (ids.length ? ids : ["00000000-0000-4000-8000-000000000000"]).map((i) => ref(i, over));
  switch (kind) {
    case "active": return { ...base, status: "upcoming", performances: perf(2), incomplete: false, provider: refs({ rawShowtimeCount: 2, status: "OPERATING" }), confirmedNoActivityToday: false } as unknown as EntertainmentShowtimeEntry;
    case "inactive": return { ...base, status: "none_posted", performances: [], incomplete: false, provider: refs({}), confirmedNoActivityToday: true, inactivityBasis: "forward_horizon" } as unknown as EntertainmentShowtimeEntry;
    case "silent": return { ...base, status: "unavailable", performances: [], incomplete: true, provider: refs({ present: false, status: null }), confirmedNoActivityToday: false } as unknown as EntertainmentShowtimeEntry;
    case "dormant": return { ...base, status: "none_posted", performances: [], incomplete: false, provider: refs({ status: "CLOSED" }), confirmedNoActivityToday: false } as unknown as EntertainmentShowtimeEntry;
    case "silent_present": return { ...base, status: "none_posted", performances: [], incomplete: false, provider: refs({ status: null }), confirmedNoActivityToday: false } as unknown as EntertainmentShowtimeEntry;
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
  check("registry-hidden (not yet restored): 30 inactive days produce no automatic event or state change", (() => { const e = evalShow(run("inactive", -29, 0), null, { registryHide: "restorable" }); return e.events.length === 0 && e.state.status === "visible" && !e.state.registryRestored; })());
  check("registry-hidden + discontinued (locked) + performance today: audit conflict flag only, never restored", (() => { const e = evalShow([{ localDate: TODAY, dayClass: "active" }], null, { registryHide: "locked" }); return e.events.length === 1 && e.events[0].type === "registry_conflict" && e.state.auditFlag === "registry_conflict" && !e.state.registryRestored; })());
  check("locked conflict raised once", (() => { const first = evalShow([{ localDate: TODAY, dayClass: "active" }], null, { registryHide: "locked" }); return evalShow([{ localDate: TODAY, dayClass: "active" }], first.state, { registryHide: "locked" }).events.length === 0; })());
  // ---- registry restoration (confirmed or not): verified performance restores a restorable registry hide ----
  const regRestore = evalShow([...run("inactive", -10, -1), { localDate: TODAY, dayClass: "active", performanceCount: 2 }], null, { registryHide: "restorable" });
  check("registry restoration: verified performance restores an inactive/suspended registry hide, persisted + audited (registry_restore + conflict flag), cycle reset",
    regRestore.state.registryRestored && regRestore.state.cycleResetDate === TODAY && regRestore.state.auditFlag === "registry_conflict" &&
    regRestore.events.length === 1 && regRestore.events[0].type === "registry_restore" && regRestore.events[0].coverageLimitations.some((l) => /NOT edited/.test(l)));
  check("registry restoration: only performances newer than the reset restore (no performance → stays registry-hidden, no events)", evalShow(run("inactive", -10, 0), null, { registryHide: "restorable" }).events.length === 0);
  check("registry restoration: after restoring, old inactive days cannot re-hide; a later 21-of-30 pattern can (normal lifecycle)", (() => {
    const st = regRestore.state;
    const mid = evalShow([...run("inactive", -10, -1), { localDate: TODAY, dayClass: "active" }, ...run("inactive", 1, 20)], st, { registryHide: "restorable", today: d(20) });
    const re = evalShow([...run("inactive", -10, -1), { localDate: TODAY, dayClass: "active" }, ...run("inactive", 1, 21)], st, { registryHide: "restorable", today: d(21) });
    return mid.state.status === "visible" && re.state.status === "auto_hidden" && re.state.registryRestored && re.events[0].type === "auto_hide";
  })());
  check("registry restoration: re-hidden then performing again → auto_restore (registry override stays recorded)", (() => {
    const re = evalShow([...run("inactive", 1, 21)], { ...regRestore.state, cycleResetDate: TODAY }, { registryHide: "restorable", today: d(21) });
    const back = evalShow([...run("inactive", 1, 21), { localDate: d(22), dayClass: "active" }], re.state, { registryHide: "restorable", today: d(22) });
    return back.state.status === "visible" && back.state.registryRestored && back.events[0].type === "auto_restore";
  })());
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
  check("the four reviewed registry hides are restorable (inactive assessment, none discontinued)", ["Paint the Night", "Wondrous Journeys", "Magic Happens Parade", "Main Street Electrical Parade"].every((n) => registryHideKind("disneyland", n) === "restorable"));

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
  check("classify: present, no status/records, healthy → silent; unhealthy → unknown", cls(mkEntry("disneyland", MMM, "silent_present")) === "silent" && cls(mkEntry("disneyland", MMM, "silent_present"), bad) === "unknown");
  check("classify: present + CLOSED + no performance on a healthy feed → dormant (basis provider_closed); unhealthy → unknown", (() => { const o = observeShowDay(mkEntry("disneyland", MMM, "dormant"), TODAY, healthy); return o?.dayClass === "dormant" && o.basis === "provider_closed" && o.final && cls(mkEntry("disneyland", MMM, "dormant"), bad) === "unknown"; })());
  check("classify: CLOSED with showtimes/dropped/unrecognized records is not dormant", (() => { const e = mkEntry("disneyland", MMM, "dormant"); e.provider = e.provider.map((r) => ({ ...r, rawShowtimeCount: 1 })); const f = mkEntry("disneyland", MMM, "dormant"); f.provider = f.provider.map((r) => ({ ...r, droppedShowtimeCount: 1 })); return cls(e) === "unknown" && cls(f) === "unknown"; })());
  check("classify: one entity absent + one CLOSED → dormant; all absent → silent", (() => { const e = mkEntry("disneyland", MMM, "dormant"); e.provider = e.provider.map((r, i) => (i === 0 ? { ...r, present: false, status: null } : r)); e.incomplete = true; return cls(e) === "dormant" && cls(mkEntry("disneyland", MMM, "silent")) === "silent"; })());
  check("classify: negatives observed before the day-end window are provisional (final=false); active is always final", (() => {
    const early = (k: Parameters<typeof mkEntry>[2]) => observeShowDay(mkEntry("disneyland", MMM, k), TODAY, healthy, false);
    return early("inactive")?.final === false && early("dormant")?.final === false && early("silent")?.final === false && early("active")?.final === true;
  })());
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

  // ---- provider dormancy (14.5C fix): dormant + verified-inactive days combine toward 21-of-30 ----
  let dv = evalShow(run("dormant", -19, 0));
  check("dormancy: 20 dormant days do NOT hide", dv.state.status === "visible" && dv.dormantDays === 20);
  dv = evalShow(run("dormant", -20, 0));
  check("dormancy: 21 dormant days hide provisionally with durable evidence (dormantDates, bases, limitations)", dv.state.status === "auto_hidden" && dv.events.length === 1 && dv.events[0].type === "auto_hide" &&
    (dv.events[0].evidence as { dormantDates: string[]; dormantDays: number }).dormantDays === 21 && (dv.events[0].evidence as { dormantDates: string[] }).dormantDates.length === 21 &&
    ((dv.events[0].evidence as { bases: Record<string, number> }).bases["dormant:unspecified"] ?? 0) === 21 && dv.events[0].coverageLimitations.length >= 2);
  const mixed = (i: number, dd: number) => [...run("inactive", -(i + dd - 1), -dd), ...run("dormant", -(dd - 1), 0)];
  check("mixed evidence: 11 inactive + 10 dormant distinct days hide (21)", evalShow(mixed(11, 10)).state.status === "auto_hidden" && evalShow(mixed(11, 10)).events[0].type === "auto_hide");
  check("mixed evidence: 11 inactive + 9 dormant (20) do not hide", evalShow(mixed(11, 9)).state.status === "visible");
  check("mixed evidence: unknown days between never count (10+10 with 10 unknown gap → no hide)", evalShow([...run("inactive", -29, -20), ...run("unknown", -19, -10), ...run("dormant", -9, 0)]).state.status === "visible");
  check("mixed evidence: a date is one class, so overlapping rows never double count (21 days stay 21)", evalShow([...run("inactive", -20, 0), ...run("dormant", -20, 0)]).events[0].type === "auto_hide" && (evalShow([...run("inactive", -19, 0), ...run("dormant", -19, 0)]).state.status === "visible"));
  check("dormancy: unknown/missing days alone (CLOSED unconfirmed, outage, weak coverage) never hide", evalShow(run("unknown", -29, 0)).state.status === "visible");
  check("dormancy: silent (absent) days do NOT hide when identity was never established", (() => { const e = evalShow(run("silent", -29, 0)); return e.state.status === "visible" && e.dormantDays === 0 && e.state.auditFlag === "provider_silence"; })());
  check("dormancy: silent (absent) days hide once a verified performance was ever observed (identity established)", (() => {
    const e = evalShow([{ localDate: d(-29), dayClass: "active" }, ...run("silent", -20, 0)]);
    return e.state.status === "auto_hidden" && (e.events[0].evidence as { identityEstablished: boolean }).identityEstablished === true;
  })());
  check("dormancy: persisted lastActiveDate also establishes identity after evidence pruning", evalShow(run("silent", -20, 0), { ...hiddenState(), status: "visible", hiddenLocalDate: null, hideCount: 0, lastActiveDate: d(-80), cycleResetDate: d(-80) }).state.status === "auto_hidden");
  check("silence warning stays at 10 days: 9 dormant → none; 10 dormant → flag + secondary", evalShow(run("dormant", -8, 0)).events.length === 0 && (() => { const e = evalShow(run("dormant", -9, 0)); return e.events[0]?.type === "silence_flag" && e.needsSecondary && e.state.status === "visible"; })());
  check("dormancy: an active day resets the cycle (21 dormant then performing → visible, no hide)", (() => { const e = evalShow([...run("dormant", -21, -1), { localDate: d(0), dayClass: "active" }]); return e.state.status === "visible" && e.dormantDays === 0; })());
  check("dormancy: hidden by dormancy → verified performance restores, then 21 new inactive/dormant days re-hide", (() => {
    const h = evalShow(run("dormant", -20, 0)).state;
    const r = evalShow([...run("dormant", -20, -1), { localDate: d(0), dayClass: "active" }], h);
    const re = evalShow([...run("dormant", -20, -1), { localDate: d(0), dayClass: "active" }, ...run("inactive", 1, 11), ...run("dormant", 12, 21)], r.state, { today: d(21) });
    return r.state.status === "visible" && r.events[0].type === "auto_restore" && re.state.status === "auto_hidden" && re.state.hideCount === 2;
  })());
  check("dormancy: exempt/ineligible identities (seasonal, legacy) are never hidden by dormancy", evalShow(run("dormant", -29, 0), null, { eligible: false }).state.status === "visible" && !isLifecycleEligible("disneyland", "Halloween Screams"));
  check("dormancy: World of Color variant observations share the canonical key (dormant under any edition name)", (() => {
    const e = { ...mkEntry("dca", "World of Color", "dormant"), dwpName: "World of Color: Happiness!" };
    const o = observeShowDay(e, TODAY, { healthy: true, limitations: [] });
    return o?.dayClass === "dormant" && o.showKey === entertainmentMappingKey("dca", "World of Color");
  })());

  // ---- day boundaries / finality ----
  check("finality: 21 PROVISIONAL (partial-day) inactive days never hide", (() => { const e = evalShow(run("inactive", -29, 0).map((o) => ({ ...o, final: false }))); return e.state.status === "visible" && e.inactiveDays === 0; })());
  check("finality: a final row replaces a provisional one for the same date and then counts", (() => {
    const obsList = [...run("inactive", -20, 0).map((o) => ({ ...o, final: false })), ...run("dormant", -20, 0)]; // final dormant rows override provisional inactive
    const e = evalShow(obsList);
    return e.state.status === "auto_hidden" && e.dormantDays === 21;
  })());
  check("finality: a provisional negative never overrides a final one; active is immediate even if provisional elsewhere", (() => {
    const e = evalShow([{ localDate: d(0), dayClass: "inactive", final: true }, { localDate: d(0), dayClass: "dormant", final: false }]);
    const act = evalShow([...run("inactive", -20, -1), { localDate: d(0), dayClass: "active", final: false }], hiddenState());
    return e.inactiveDays === 1 && e.dormantDays === 0 && act.state.status === "visible";
  })());
  check("finality: 21 final days with the current day provisional → 20 count, no hide (completed days only)", evalShow([...run("inactive", -20, -1), { localDate: d(0), dayClass: "inactive", final: false }]).state.status === "visible");
  const WDW = "WDW" as const, DLR = "DLR" as const;
  const hrs = (resort: "WDW" | "DLR", iso: string) => resortLocalHour(resort, new Date(iso));
  check("timezone: Disneyland 03:30Z (the old schedule) is 19:30 PST / 20:30 PDT — NOT final", hrs(DLR, "2026-12-10T03:30:00Z") === 19 && hrs(DLR, "2026-07-10T03:30:00Z") === 20 && !isDayEndWindow(DLR, new Date("2026-12-10T03:30:00Z")) && !isDayEndWindow(DLR, new Date("2026-07-10T03:30:00Z")));
  check("timezone: Disneyland 06:30Z is 22:30 PST / 23:30 PDT — final window", isDayEndWindow(DLR, new Date("2026-12-10T06:30:00Z")) && isDayEndWindow(DLR, new Date("2026-07-10T06:30:00Z")));
  check("timezone: WDW 03:30Z is 22:30 EST / 23:30 EDT — final window; WDW 06:30Z is the next local morning — not final", isDayEndWindow(WDW, new Date("2026-12-10T03:30:00Z")) && isDayEndWindow(WDW, new Date("2026-07-10T03:30:00Z")) && !isDayEndWindow(WDW, new Date("2026-12-10T06:30:00Z")) && !isDayEndWindow(WDW, new Date("2026-07-10T06:30:00Z")));
  check("timezone: DST transitions keep both cron instants inside their window (spring forward + fall back)", [
    ["WDW", "2026-03-09T03:30:00Z"], ["WDW", "2026-11-02T03:30:00Z"], ["WDW", "2026-03-08T03:30:00Z"], ["WDW", "2026-11-01T03:30:00Z"],
    ["DLR", "2026-03-09T06:30:00Z"], ["DLR", "2026-11-02T06:30:00Z"], ["DLR", "2026-03-08T06:30:00Z"], ["DLR", "2026-11-01T06:30:00Z"],
  ].every(([r, t]) => isDayEndWindow(r as "WDW" | "DLR", new Date(t))));
  check("timezone: window is [22:00, 24:00) local — 21:59 no, 22:00 yes, 23:59 yes, 00:00 no", !isDayEndWindow(DLR, new Date("2026-12-10T05:59:00Z")) && isDayEndWindow(DLR, new Date("2026-12-10T06:00:00Z")) && isDayEndWindow(DLR, new Date("2026-12-10T07:59:00Z")) && !isDayEndWindow(DLR, new Date("2026-12-10T08:00:00Z")));

  // ---- already-stale shows: validated-mapping identity ----
  const mapOf = (...e: Array<{ n: string; ids: string[] | null }>) => e.map((x) => (x.ids ? { dwpName: x.n, parkId: "disneyland" as ParkId, disposition: "mapped" as const, provider: x.ids.map((id) => ({ entityId: id, entityType: "SHOW" as const, providerName: x.n })) } : { dwpName: x.n, parkId: "disneyland" as ParkId, disposition: "unmapped" as const, reason: "r" })) as unknown as Parameters<typeof isMappingIdentityEstablished>[2];
  const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222";
  check("mapping identity: a shipped mapped show (Mickey's Mix Magic, World of Color) is established; unmapped/legacy/unknown are not",
    isMappingIdentityEstablished("disneyland", MMM) && isMappingIdentityEstablished("dca", "World of Color") && !isMappingIdentityEstablished("disneyland", "Paint the Night") && !isMappingIdentityEstablished("disneyland", "No Such Show"));
  check("mapping identity: every shipped mapped entry passes (no ambiguity in the maintained mapping)", ENTERTAINMENT_PLACES.every((p) => { const m = getEntertainmentProviderMapping(p.name, p.parkId as ParkId); return !m || m.disposition !== "mapped" || isMappingIdentityEstablished(p.parkId as ParkId, p.name); }));
  check("mapping ambiguity: a provider id shared by two entries establishes neither", (() => { const m = mapOf({ n: "Fantasmic!", ids: [U1] }, { n: MMM, ids: [U1, U2] }); return !isMappingIdentityEstablished("disneyland", "Fantasmic!", m) && !isMappingIdentityEstablished("disneyland", MMM, m); })());
  check("mapping ambiguity: duplicate refs inside one entry, empty refs, malformed UUID → not established", !isMappingIdentityEstablished("disneyland", MMM, mapOf({ n: MMM, ids: [U1, U1] })) && !isMappingIdentityEstablished("disneyland", MMM, mapOf({ n: MMM, ids: [] })) && !isMappingIdentityEstablished("disneyland", MMM, mapOf({ n: MMM, ids: ["NOT-A-UUID"] })));
  check("mapping ambiguity: an intentionally unmapped entry never establishes identity", !isMappingIdentityEstablished("disneyland", MMM, mapOf({ n: MMM, ids: null })));
  check("mapping: a clean custom mapping establishes it", isMappingIdentityEstablished("disneyland", MMM, mapOf({ n: MMM, ids: [U1] })));
  const mapped = (obsList: Obs[], established: boolean, st: LifecycleShowState | null = null) => evaluateShowLifecycle({ today: TODAY, observations: obsList, state: st, eligible: true, registryHide: "none", mappingEstablished: established });
  check("stale show: 20 healthy-feed absent days with a validated mapping do not hide (flag only)", (() => { const e = mapped(run("silent", -19, 0), true); return e.state.status === "visible" && e.dormantDays === 20 && e.state.auditFlag === "provider_silence"; })());
  check("stale show: 21 absent days with a validated mapping hide (no performance ever observed), identityBasis validated_mapping", (() => { const e = mapped(run("silent", -20, 0), true); return e.state.status === "auto_hidden" && e.events[0].type === "auto_hide" && (e.events[0].evidence as { identityBasis: string }).identityBasis === "validated_mapping" && e.state.lastActiveDate === null; })());
  check("stale show: the same 21 absent days WITHOUT a validated mapping never hide", mapped(run("silent", -29, 0), false).state.status === "visible");
  check("stale show: a performance identity still wins the basis label", (mapped([{ localDate: d(-29), dayClass: "active" }, ...run("silent", -20, 0)], true).events[0].evidence as { identityBasis: string }).identityBasis === "performance");
  check("stale show: unknown days between absent days never count (11 + gap + 10 → no hide)", mapped([...run("silent", -29, -19), ...run("unknown", -18, -9), ...run("silent", -8, 0)], true).state.status === "visible");
  check("stale show: absent + dormant + inactive combine by distinct date (7 each = 21)", mapped([...run("silent", -20, -14), ...run("dormant", -13, -7), ...run("inactive", -6, 0)], true).state.status === "auto_hidden");
  check("stale show: restore/reset/re-hide on the mapping basis", (() => {
    const h = mapped(run("silent", -20, 0), true).state;
    const r = mapped([...run("silent", -20, -1), { localDate: d(0), dayClass: "active" }], true, h);
    const re = evaluateShowLifecycle({ today: d(21), observations: [{ localDate: d(0), dayClass: "active" }, ...run("silent", 1, 21)], state: r.state, eligible: true, registryHide: "none", mappingEstablished: true });
    return r.state.status === "visible" && r.events[0].type === "auto_restore" && re.state.status === "auto_hidden" && re.state.hideCount === 2;
  })());
  check("stale show: seasonal/legacy identities stay exempt even with a mapping", !isLifecycleEligible("disneyland", "Halloween Screams") && evaluateShowLifecycle({ today: TODAY, observations: run("silent", -29, 0), state: null, eligible: false, registryHide: "none", mappingEstablished: true }).state.status === "visible");

  // ---- Vercel cron registration + delayed-cron / DST boundaries ----
  const crons = (vercelConfig as { crons: Array<{ path: string; schedule: string }> }).crons;
  const lc = crons.filter((c) => c.path.startsWith(LIFECYCLE_CRON_PATH));
  check("cron: exactly two lifecycle crons, distinct paths, schedules 0 3 * * * (WDW) and 0 6 * * * (DLR)", lc.length === 2 && new Set(lc.map((c) => c.path)).size === 2 && lc.some((c) => c.schedule === "0 3 * * *") && lc.some((c) => c.schedule === "0 6 * * *"));
  check("cron: lifecycle paths target the real route (with a window query only); park-hours cron untouched", lc.every((c) => /^\/api\/cron\/entertainment-lifecycle(\?window=(wdw|dlr))?$/.test(c.path)) && crons.some((c) => c.path === "/api/cron/park-hours" && c.schedule === "0 2 * * *"));
  const dstDates = ["2026-01-15", "2026-03-07", "2026-03-08", "2026-03-09", "2026-07-15", "2026-10-31", "2026-11-01", "2026-11-02", "2026-12-15"];
  const hourOk = (resort: "WDW" | "DLR", hour: string, date: string) => Array.from({ length: 60 }, (_, m) => isDayEndWindow(resort, new Date(`${date}T${hour}:${String(m).padStart(2, "0")}:00Z`))).every(Boolean);
  check("cron: any minute within the 03:00Z hour is final for WDW and within 06:00Z for DLR on every DST-relevant date", dstDates.every((dt) => hourOk("WDW", "03", dt) && hourOk("DLR", "06", dt)));
  check("cron: the NEXT UTC hour is only provisional in summer (delayed run fails safe) — WDW 04:00Z EDT, DLR 07:00Z PDT", !isDayEndWindow("WDW", new Date("2026-07-15T04:00:00Z")) && !isDayEndWindow("DLR", new Date("2026-07-15T07:00:00Z")) && !isDayEndWindow("WDW", new Date("2026-03-09T04:00:00Z")));
  check("cron: the old 03:30/06:30 schedule's jitter would have crossed midnight in summer (regression guard for the hour choice)", !isDayEndWindow("WDW", new Date("2026-07-15T04:30:00Z")) && !isDayEndWindow("DLR", new Date("2026-07-15T07:30:00Z")));
  check("cron: each run is a provisional-for-the-other-resort run (WDW 03:00Z is 19:00/20:00 at Disneyland; DLR 06:00Z is the next morning at WDW)", !isDayEndWindow("DLR", new Date("2026-12-15T03:00:00Z")) && !isDayEndWindow("DLR", new Date("2026-07-15T03:00:00Z")) && !isDayEndWindow("WDW", new Date("2026-12-15T06:00:00Z")) && !isDayEndWindow("WDW", new Date("2026-07-15T06:00:00Z")));

  // ---- review fixes: provider-wide coverage + discarded entities ----
  const cov = (publishedEntities: number, droppedEntities = 0) => ({ providerCoverage: { publishedEntities, droppedEntities, droppedShowtimes: 0 } });
  const epcotShow = ENTERTAINMENT_PLACES.find((p) => p.parkId === "epcot" && isLifecycleEligible("epcot", p.name) && getEntertainmentProviderMapping(p.name, "epcot")?.disposition === "mapped")!.name;
  check("coverage: EPCOT (one eligible mapped show) is healthy when the PROVIDER feed has ≥ 3 entities publishing", assessParkHealth(mkPark("epcot", { [epcotShow]: "silent" }, cov(5))).healthy && !assessParkHealth(mkPark("epcot", { [epcotShow]: "silent" })).healthy);
  check("coverage: provider-wide count below the quorum is still unhealthy (EPCOT with 2 entities; DCA with 2)", !assessParkHealth(mkPark("epcot", { [epcotShow]: "silent" }, cov(2))).healthy && !assessParkHealth(mkPark("dca", {}, cov(2))).healthy && assessParkHealth(mkPark("dca", {}, cov(3))).healthy);
  check("coverage: EPCOT absence is a silent observation on a provider-healthy feed; unknown on a weak feed", observeParkDay(mkPark("epcot", { [epcotShow]: "silent" }, cov(5)), true).find((o) => o.showName === epcotShow)?.dayClass === "silent" && observeParkDay(mkPark("epcot", { [epcotShow]: "silent" }, cov(1)), true).find((o) => o.showName === epcotShow)?.dayClass === "unknown");
  check("coverage: error / stale / wrong-day gates still apply on top of provider-wide coverage", !assessParkHealth(mkPark("epcot", {}, { ...cov(9), stale: true })).healthy && !assessParkHealth(mkPark("epcot", {}, { ...cov(9), error: { kind: "timeout", message: "t" } })).healthy && !assessParkHealth(mkPark("epcot", {}, { ...cov(9), fetchedLocalDate: d(-1) })).healthy);
  const droppedPark = (kind: Parameters<typeof mkEntry>[2]) => mkPark("disneyland", { [MMM]: kind }, cov(6, 1));
  const clsOf = (st: ParkEntertainmentShowtimes) => observeParkDay(st, true).find((o) => o.showName === MMM)?.dayClass;
  check("discarded entities: an ABSENT mapped ref is unknown (not silent) when the payload dropped entities", clsOf(droppedPark("silent")) === "unknown" && clsOf(mkPark("disneyland", { [MMM]: "silent" }, cov(6, 0))) === "silent");
  check("discarded entities: partially absent + CLOSED is unknown too; fully present CLOSED stays dormant; confirmed inactive and active are unaffected", (() => {
    const e = mkEntry("disneyland", MMM, "dormant"); e.provider = e.provider.map((r, i) => (i === 0 ? { ...r, present: false, status: null } : r)); e.incomplete = true;
    const mixedPark = { ...mkPark("disneyland", {}, cov(6, 1)), entries: [e, ...mkPark("disneyland", {}).entries.filter((x) => x.dwpName !== MMM)] };
    return clsOf(mixedPark) === "unknown" && clsOf(droppedPark("dormant")) === "dormant" && clsOf(droppedPark("inactive")) === "inactive" && clsOf(droppedPark("active")) === "active";
  })());
  check("discarded entities: the normalizer carries provider-wide coverage and the dropped counts from the live payload", (() => {
    const t = (id: string) => ({ type: "Performance Time", startTime: `${TODAY}T19:00:00-08:00`, endTime: null });
    const ent = (id: string, st: ReturnType<typeof t>[]) => ({ entityId: id, name: "x", entityType: "SHOW", parkId: null, externalId: null, status: "OPERATING", lastUpdated: null, showtimes: st, droppedShowtimes: 0 });
    const live = { ok: true as const, data: { entityId: "p", name: "p", timeZone: null, entries: [ent("a", [t("a")]), ent("b", [t("b")]), ent("c", [t("c")]), ent("d", [])], droppedEntries: 2, droppedShowtimes: 1 }, meta: { origin: "network" as const, fetchedAt: Date.parse(`${TODAY}T21:00:00Z`), etag: null } };
    const st = normalizeParkEntertainmentShowtimes("epcot", live, new Date(`${TODAY}T21:00:00Z`));
    const failed = normalizeParkEntertainmentShowtimes("epcot", { ok: false, error: { kind: "timeout", message: "t" } }, new Date(`${TODAY}T21:00:00Z`));
    return st.providerCoverage?.publishedEntities === 3 && st.providerCoverage.droppedEntities === 2 && st.providerCoverage.droppedShowtimes === 1 && failed.providerCoverage === undefined && assessParkHealth(st).healthy && assessParkHealth(st).absenceReliable === false;
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
  const withAssessment = (name: string, assessment: "inactive" | "suspended" | "discontinued" | "returning") =>
    ({ schemaVersion: 1, records: ENTERTAINMENT_LIFECYCLE_REGISTRY.records.map((r) => (r.name === name ? { ...r, assessment } : r)) }) as EntertainmentLifecycleRegistry;
  check("registry restoration: a CONFIRMED inactive registry hide is overridden by a verified performance (record untouched)",
    ENTERTAINMENT_LIFECYCLE_REGISTRY.records.find((r) => r.name === "Paint the Night")!.confirmation === "confirmed" &&
    !getLifecycleHiddenNames("disneyland", [], new Set(["Paint the Night"])).has("Paint the Night") && getLifecycleHiddenNames("disneyland", [], null).has("Paint the Night") &&
    ENTERTAINMENT_LIFECYCLE_REGISTRY.records.find((r) => r.name === "Paint the Night")!.visibility.decision === "hidden");
  check("registry restoration: suspended/returning assessments are restorable too", ["suspended", "returning", "inactive"].every((a) => !getLifecycleHiddenNames("disneyland", [], new Set(["Paint the Night"]), withAssessment("Paint the Night", a as "inactive")).has("Paint the Night")));
  const discontinued = withAssessment("Paint the Night", "discontinued");
  check("registry protection: a DISCONTINUED registry hide is never overridden by a performance or a restored marker", getLifecycleHiddenNames("disneyland", [], new Set(["Paint the Night"]), discontinued, ["Paint the Night"]).has("Paint the Night"));
  check("durable registry restoration: a persisted override un-hides without a performance in the response", !getLifecycleHiddenNames("disneyland", [], null, undefined, ["Paint the Night"]).has("Paint the Night") && getLifecycleHiddenNames("disneyland", [], null, undefined, []).has("Paint the Night"));
  check("durable restoration then auto re-hide: auto-hidden wins over the registry override", getLifecycleHiddenNames("disneyland", ["Paint the Night"], null, undefined, ["Paint the Night"]).has("Paint the Night"));
  check("an auto-hidden entry for a discontinued registry record stays hidden even while performing (locked)", getLifecycleHiddenNames("disneyland", ["Paint the Night"], new Set(["Paint the Night"]), discontinued).has("Paint the Night"));
  check("registry hide excludes legacy identities", getRegistryHiddenNames("disneyland", { schemaVersion: 1, records: [{ ...ENTERTAINMENT_LIFECYCLE_REGISTRY.records[0], name: getLegacyEntertainmentPlaces().find((p) => p.parkId === "disneyland")!.name }] } as EntertainmentLifecycleRegistry).restorable.size === 0);

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

  // ---- registry restoration across both page paths + toggle ----
  const pn = getEntertainmentForPark("disneyland").find((p) => p.name === "Paint the Night")!;
  const pnEntry = makeOffSeasonEntry(pn, "disneyland");
  const restoredSet = getLifecycleHiddenNames("disneyland", [], null, undefined, ["Paint the Night"]);
  for (const toggle of [false, true]) {
    check(`All Entertainment (toggle ${toggle ? "ON" : "OFF"}): hidden registry show absent; a durably restored one is shown`,
      !applyAllEntertainmentSeasonalVisibility([pnEntry], "disneyland", "DLR", DL_TODAY, toggle, NOW, getLifecycleHiddenNames("disneyland")).length &&
      applyAllEntertainmentSeasonalVisibility([pnEntry], "disneyland", "DLR", DL_TODAY, toggle, NOW, restoredSet).length === 1);
  }
  check("Waits & Shows: a durably restored registry show is in the visible list; discontinued stays out", getEntertainmentForPark("disneyland").filter((p) => !restoredSet.has(p.name)).some((p) => p.name === "Paint the Night"));
  check("dormancy-hidden show uses the same set on both paths (auto-hidden name → hidden; performing in the response → visible)", getLifecycleHiddenNames("disneyland", ["Fantasmic!"]).has("Fantasmic!") && !getLifecycleHiddenNames("disneyland", ["Fantasmic!"], performingNamesFromShowtimes([{ dwpName: "Fantasmic!", performances: [1] }])).has("Fantasmic!"));
  return failures;
}

// ============================================
// STORE / MONITOR (in-memory SQL stand-in; optional real Postgres)
// ============================================

type Row = Record<string, unknown>;

/** Minimal in-memory interpreter for exactly the statements the store issues; mirrors their SQL semantics. */
class FakeLifecycleDb implements Queryable {
  evidence = new Map<string, Row>();
  states = new Map<string, Row>();
  events = new Map<string, Row>();
  identities = new Map<string, Row>();
  /** Simulates the identity table not being migrated yet: only identity SQL fails. */
  failIdentitySql = false;
  lockHeld = false;
  failAll = false;
  statements = 0;
  async query(text: string, v: unknown[] = []): Promise<{ rowCount: number | null; rows: Row[] }> {
    this.statements++;
    if (this.failAll) throw new Error("db down");
    const t = text.replace(/\s+/g, " ");
    if (t.includes("pg_try_advisory_xact_lock")) return { rowCount: 1, rows: [{ ok: !this.lockHeld }] };
    if (t.startsWith("INSERT INTO entertainment_lifecycle_evidence")) {
      const [park, key, date, name, cls, rank, fin, basis, pc, source, lim] = v as [string, string, string, string, string, number, boolean, string | null, number, string, string];
      const k = `${park}|${key}|${date}`;
      const e = this.evidence.get(k);
      if (!e) this.evidence.set(k, { park_id: park, show_key: key, d: date, show_name: name, day_class: cls, class_rank: rank, is_final: fin, basis, performance_count: pc, source, limitations: lim, observation_count: 1 });
      else {
        const er = e.class_rank as number, ef = e.is_final as boolean;
        const take = er < 4 && (rank === 4 || (fin && !ef) || (fin === ef && rank > er)); // mirrors the SQL CASE
        this.evidence.set(k, { ...e, show_name: name, day_class: take ? cls : e.day_class, basis: take ? basis : e.basis, source: take ? source : e.source, limitations: take ? lim : e.limitations,
          performance_count: take ? pc : er === 4 && rank === 4 ? Math.max(e.performance_count as number, pc) : e.performance_count, class_rank: take ? rank : er, is_final: ef || fin, observation_count: (e.observation_count as number) + 1 });
      }
      return { rowCount: 1, rows: [] };
    }
    if (t.startsWith("SELECT show_key, to_char(local_date")) {
      const [park, from, to] = v as string[];
      return { rowCount: 0, rows: [...this.evidence.values()].filter((r) => r.park_id === park && (r.d as string) >= from && (r.d as string) <= to).map((r) => ({ show_key: r.show_key, d: r.d, day_class: r.day_class, basis: r.basis, performance_count: r.performance_count, is_final: r.is_final })) };
    }
    if (t.startsWith("SELECT show_key, show_name, status")) return { rowCount: 0, rows: [...this.states.values()].filter((r) => r.park_id === v[0]) };
    if (t.startsWith("INSERT INTO entertainment_lifecycle_state")) {
      const [park, key, name, status, reset, lastActive, hiddenDate, hiddenAt, restoredAt, hc, rc, id, dd, sd, flaggedAt, regAt, secOn, flag, evalDate] = v as (string | number | null)[];
      const k = `${park}|${key}`;
      const cur = this.states.get(k);
      if (cur && cur.evaluated_local_date && (cur.evaluated_local_date as string) > (evalDate as string)) return { rowCount: 0, rows: [] };
      this.states.set(k, { park_id: park, show_key: key, show_name: name, status, cycle_reset_date: reset, last_active_date: lastActive, hidden_local_date: hiddenDate, hidden_at: hiddenAt, restored_at: restoredAt, hide_count: hc, restore_count: rc, inactive_days: id, dormant_days: dd, silent_days: sd, silence_flagged_at: flaggedAt, registry_restored_at: regAt, secondary_evaluated_on: secOn, audit_flag: flag, evaluated_local_date: evalDate });
      return { rowCount: 1, rows: [] };
    }
    if (this.failIdentitySql && t.includes("entertainment_legacy_identity")) throw new Error('relation "entertainment_legacy_identity" does not exist');
    if (t.includes("FROM entertainment_legacy_identity")) {
      const park = v[0] as string | undefined;
      return { rowCount: 0, rows: [...this.identities.values()].filter((r) => r.status === "validated" && (!park || r.park_id === park)).map((r) => ({ park_id: r.park_id, show_name: r.show_name, entity_id: r.entity_id, provider_name: r.provider_name })).sort((a, b) => `${a.park_id}${a.show_name}`.localeCompare(`${b.park_id}${b.show_name}`)) };
    }
    if (t.startsWith("UPDATE entertainment_legacy_identity")) {
      const [park, key, ent] = v as string[];
      const r = this.identities.get(`${park}|${key}|${ent}`);
      if (r && r.status === "validated") { r.status = "superseded"; return { rowCount: 1, rows: [] }; }
      return { rowCount: 0, rows: [] };
    }
    if (t.startsWith("INSERT INTO entertainment_legacy_identity")) {
      const [park, key, name, ent, pname, date] = v as string[];
      const k = `${park}|${key}|${ent}`;
      const prior = this.identities.get(k);
      if (prior && prior.status === "validated") return { rowCount: 0, rows: [] };
      // mirrors the partial unique indexes (one validated row per show and per entity)
      for (const r of this.identities.values()) if (r.status === "validated" && r.park_id === park && (r.show_key === key || r.entity_id === ent)) throw new Error("unique violation");
      this.identities.set(k, { park_id: park, show_key: key, show_name: name, entity_id: ent, provider_name: pname, status: "validated", first_validated_date: date });
      return { rowCount: 1, rows: [] };
    }
    if (t.startsWith("INSERT INTO entertainment_lifecycle_events") && t.includes("WHERE NOT EXISTS")) {
      const [park, key, type, date, name, evidence, lim] = v as string[];
      const k = `${park}|${key}|${type}|${date}`;
      const dup = [...this.events.values()].some((e) => e.park_id === park && e.show_key === key && e.event_type === type && JSON.stringify(e.evidence) === JSON.stringify(JSON.parse(evidence)));
      if (dup || this.events.has(k)) return { rowCount: 0, rows: [] };
      this.events.set(k, { park_id: park, show_key: key, event_type: type, d: date, show_name: name, evidence: JSON.parse(evidence), coverage_limitations: JSON.parse(lim), audit_status: "unreviewed", occurred_at: new Date().toISOString() });
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
    if (t.includes("registry_restored_at IS NOT NULL) AS restored")) return { rowCount: 0, rows: [...this.states.values()].filter((r) => r.status === "auto_hidden" || r.status === "legacy_comeback" || r.registry_restored_at != null).map((r) => ({ park_id: r.park_id, show_name: r.show_name, status: r.status, restored: r.registry_restored_at != null })) };
    throw new Error(`FakeLifecycleDb: unhandled SQL: ${t.slice(0, 80)}`);
  }
}
const MONITOR_DAY0 = "2026-12-01"; // resort-local date of the first simulated run (Disneyland/DCA)
// 06:30Z of the next UTC day = 22:30 PST on the Disneyland resort-local date (inside the day-end window ⇒ negatives are FINAL).
const instantFor = (offsetDays: number) => new Date(`${addDaysToLocalDate(MONITOR_DAY0, offsetDays + 1)}T06:30:00Z`);

export async function runDevEntertainmentLifecycleMonitorCases(realPool?: Pool): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const PARK: ParkId = "disneyland";
  const localOf = (off: number) => addDaysToLocalDate(MONITOR_DAY0, off)!;
  const mmmKey = entertainmentMappingKey(PARK, MMM);

  /** One scenario driver: simulated days; per-day kind for Mickey's Mix Magic; other parks' provider fails unless `allParks`. */
  async function drive(runDb: LifecycleMonitorOptions["runDb"], days: Array<Parameters<typeof mkEntry>[2] | "provider_down" | "stale" | "silent_weak">, startOffset = 0, history?: LifecycleMonitorOptions["getHistory"], opts: { instantOf?: (off: number) => Date; registry?: EntertainmentLifecycleRegistry } = {}) {
    const reports = [];
    for (let i = 0; i < days.length; i++) {
      const off = startOffset + i;
      const kind = days[i];
      const date = localOf(off);
      reports.push(await runEntertainmentLifecycleMonitor({
        instant: (opts.instantOf ?? instantFor)(off), runDb, sleep: async () => {}, getHistory: history, registry: opts.registry,
        getShowtimes: async (parkId) => {
          if (parkId !== PARK || kind === "provider_down") return mkPark(parkId, {}, { error: { kind: "timeout", message: "t" } }, date);
          if (kind === "silent_weak") return mkPark(parkId, { ...Object.fromEntries(getEntertainmentForPark(parkId).map((p) => [p.name, "unknown" as const])), [MMM]: "silent" }, {}, date);
          if (kind === "stale") return mkPark(parkId, { [MMM]: "dormant" }, { stale: true }, date);
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
      const o = (cls: LifecycleDayClass) => ({ parkId: PARK, showKey: mmmKey, showName: MMM, localDate: TODAY, dayClass: cls, basis: cls, performanceCount: cls === "active" ? 2 : 0, source: "live" as const, final: true, limitations: [] });
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
    await drive(async (_p, fn) => fn(db3), Array(10).fill("silent"), 10, getHistory);
    check("monitor: 20 days of healthy-feed absence of a validated-mapping show → flagged, still visible", (await stateOf(db3))?.status === "visible" && (await stateOf(db3))?.dormantDays === 20);
    await drive(async (_p, fn) => fn(db3), ["silent"], 20, getHistory);
    check("monitor: the 21st absent day hides a never-observed but validated-mapping show (identity via mapping, durable evidence)", (await stateOf(db3))?.status === "auto_hidden" &&
      ((): boolean => { const e = [...db3.events.values()].find((x) => x.event_type === "auto_hide"); return !!e && (e.evidence as { identityBasis: string }).identityBasis === "validated_mapping" && (e.evidence as { dormantDays: number }).dormantDays === 21; })());

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
    check("audit read: completeness metadata (unreviewed total + applied limit) is reported for truncation detection", await (async () => {
      const r = await readLifecycleAudit({ query: async (sql: string) => (/COUNT\(\*\)/.test(sql) ? { rowCount: 1, rows: [{ n: "1500" }] } : { rowCount: 0, rows: [] }) }, 7);
      return r.unreviewedTotal === 1500 && r.eventLimit === 7 && r.unreviewedEvents.length === 0;
    })());
    // writeState guard / events natural key
    check("writeState: an earlier evaluation date is rejected; events natural key dedupes", await (async () => {
      const q = new FakeLifecycleDb();
      const s = { status: "visible" as const, cycleResetDate: null, lastActiveDate: null, hiddenLocalDate: null, hideCount: 0, restoreCount: 0, silenceFlagged: false, secondaryEvaluatedOn: null, auditFlag: null, showKey: mmmKey, showName: MMM, hiddenAt: null, restoredAt: null, silenceFlaggedAt: null, registryRestored: false, registryRestoredAt: null, inactiveDays: 0, dormantDays: 0, silentDays: 0, evaluatedLocalDate: "2026-12-05" };
      const a = await writeState(q, PARK, s);
      const b = await writeState(q, PARK, { ...s, evaluatedLocalDate: "2026-12-01" });
      await insertEvent(q, PARK, mmmKey, MMM, { type: "auto_hide", localDate: TODAY, evidence: {}, coverageLimitations: [] });
      await insertEvent(q, PARK, mmmKey, MMM, { type: "auto_hide", localDate: TODAY, evidence: {}, coverageLimitations: [] });
      return a && !b && q.events.size === 1;
    })());

    // ---- 14.5C fixes: dormancy through the monitor ----
    const mk = () => { const x = new FakeLifecycleDb(); return { x, runDb: (async (_p, fn) => fn(x)) as LifecycleMonitorOptions["runDb"] }; };
    {
      const a = mk();
      await drive(a.runDb, Array(20).fill("dormant"));
      check("monitor dormancy: 20 verified dormant days (fresh healthy feed, CLOSED, no performance) → visible", (await stateOf(a.x))?.status === "visible" && (await stateOf(a.x))?.dormantDays === 20);
      await drive(a.runDb, ["dormant"], 20);
      st = await stateOf(a.x);
      const he = [...a.x.events.values()].find((e) => e.event_type === "auto_hide");
      check("monitor dormancy: 21st dormant day hides provisionally with durable evidence + audit event", st?.status === "auto_hidden" && !!he && (he.evidence as { dormantDays: number }).dormantDays === 21 && he.audit_status === "unreviewed");
      check("monitor dormancy: dormant rows are stored with class 'dormant' and basis provider_closed", [...a.x.evidence.values()].some((r) => r.day_class === "dormant" && r.basis === "provider_closed" && r.is_final === true));

      const b = mk();
      await drive(b.runDb, [...Array(11).fill("inactive"), ...Array(10).fill("dormant")]);
      check("monitor mixed evidence: 11 inactive + 10 dormant distinct days hide", (await stateOf(b.x))?.status === "auto_hidden");
      const c = mk();
      await drive(c.runDb, [...Array(11).fill("inactive"), ...Array(9).fill("dormant")]);
      check("monitor mixed evidence: 20 combined days do not hide", (await stateOf(c.x))?.status === "visible");

      const o = mk();
      await drive(o.runDb, [...Array(12).fill("dormant"), ...Array(10).fill("provider_down"), ...Array(9).fill("dormant")]);
      check("monitor outage: provider outage days are not evidence — 21 dormant days spread over 31 (20 in window) do not hide", (await stateOf(o.x))?.status === "visible");
      const sth = mk();
      await drive(sth.runDb, Array(30).fill("stale"));
      check("monitor weak data: stale-if-error feeds never count (30 days of 'dormant' on stale data → nothing)", (await stateOf(sth.x))?.status !== "auto_hidden" && ![...sth.x.evidence.values()].some((r) => r.day_class === "dormant"));
      const op = mk();
      await drive(op.runDb, Array(30).fill("operating_empty"));
      check("monitor weak data: provider OPERATING with no times is ambiguous — never counted", (await stateOf(op.x))?.status !== "auto_hidden");

      // restore + re-hide on dormancy
      await drive(a.runDb, ["active"], 21);
      check("monitor dormancy: verified performance restores and resets the cycle", (await stateOf(a.x))?.status === "visible" && (await stateOf(a.x))?.cycleResetDate === localOf(21));
      await drive(a.runDb, Array(20).fill("dormant"), 22);
      check("monitor dormancy: 20 post-return dormant days do not re-hide", (await stateOf(a.x))?.status === "visible");
      await drive(a.runDb, ["inactive"], 42);
      check("monitor dormancy: 21st combined post-return day re-hides (hide_count 2)", (await stateOf(a.x))?.status === "auto_hidden" && (await stateOf(a.x))?.hideCount === 2);
    }

    // ---- day boundaries through the monitor ----
    {
      // 03:30Z of the NEXT UTC day = 19:30 PST local on the Disneyland date: partial day, provisional.
      const early = (off: number) => new Date(`${addDaysToLocalDate(MONITOR_DAY0, off + 1)}T03:30:00Z`);
      const t = mk();
      const reps2 = await drive(t.runDb, Array(25).fill("inactive"), 0, undefined, { instantOf: early });
      const dl = reps2[0]!.parks.find((p) => p.parkId === PARK)!;
      check("boundary: the 03:30Z run is NOT inside Disneyland's day-end window (dayEnd=false) but IS inside WDW's", dl.dayEnd === false && reps2[0]!.parks.find((p) => p.parkId === "mk")!.dayEnd === true);
      check("boundary: 25 days of partial-day (provisional) Disneyland negatives never hide", (await stateOf(t.x)) === undefined || ((await stateOf(t.x))?.status === "visible" && (await stateOf(t.x))?.inactiveDays === 0));
      check("boundary: provisional rows are stored non-final", [...t.x.evidence.values()].every((r) => r.day_class === "active" || r.is_final === false));
      // completed-day reconciliation: each date's own in-window run (same resort-local date) finalizes its provisional row
      const t2 = mk();
      for (let off = 0; off < 20; off++) { await drive(t2.runDb, ["inactive"], off, undefined, { instantOf: early }); await drive(t2.runDb, ["inactive"], off); }
      check("boundary: dates reconciled by their own in-window run are counted (20 → visible)", (await stateOf(t2.x))?.inactiveDays === 20 && (await stateOf(t2.x))?.status === "visible" && [...t2.x.evidence.values()].every((r) => r.is_final === true));
      await drive(t2.runDb, ["inactive"], 20, undefined, { instantOf: early });
      check("boundary: the 21st date is only provisional until its in-window run (still visible)", (await stateOf(t2.x))?.status === "visible");
      await drive(t2.runDb, ["inactive"], 20);
      check("boundary: the 21st date finalized → hides", (await stateOf(t2.x))?.status === "auto_hidden");
      // a performance during a partial day restores immediately (active is always final)
      await drive(t2.runDb, ["active"], 21, undefined, { instantOf: early });
      check("boundary: a verified performance observed in a partial day restores immediately", (await stateOf(t2.x))?.status === "visible");
      // a provisional negative never downgrades/overrides a final active, and a final replaces a provisional
      const rows = [...t2.x.evidence.values()].filter((r) => r.show_key === mmmKey);
      check("boundary: active rows are final", rows.filter((r) => r.day_class === "active").every((r) => r.is_final === true));
    }

    // ---- already-stale shows: identity via validated mapping ----
    {
      const a = mk();
      await drive(a.runDb, Array(20).fill("silent"));
      check("stale show: 20 absent days on healthy feeds (never observed performing) → visible", (await stateOf(a.x))?.status === "visible" && (await stateOf(a.x))?.lastActiveDate == null);
      await drive(a.runDb, ["silent"], 20);
      check("stale show: 21 absent days hide it without any recorded performance", (await stateOf(a.x))?.status === "auto_hidden" && (await stateOf(a.x))?.lastActiveDate == null);
      await drive(a.runDb, ["active"], 21);
      check("stale show: a later verified performance restores and resets the cycle", (await stateOf(a.x))?.status === "visible" && (await stateOf(a.x))?.cycleResetDate === localOf(21));
      await drive(a.runDb, Array(20).fill("silent"), 22);
      check("stale show: 20 post-return absent days do not re-hide; the 21st does", (await stateOf(a.x))?.status === "visible" && (await (async () => { await drive(a.runDb, ["silent"], 42); return (await stateOf(a.x))?.status === "auto_hidden"; })()));
      const w = mk();
      await drive(w.runDb, Array(30).fill("silent_weak"));
      check("stale show: weak park coverage (<3 shows publishing) never counts absence", (await stateOf(w.x))?.status !== "auto_hidden" && ![...w.x.evidence.values()].some((r) => r.day_class === "silent"));
      const gap = mk();
      await drive(gap.runDb, [...Array(12).fill("silent"), ...Array(10).fill("provider_down"), ...Array(9).fill("silent")]);
      check("stale show: provider outage days are gaps, not absence (21 absent days spread over 31 → 20 in window → visible)", (await stateOf(gap.x))?.status === "visible");
      const stale = mk();
      await drive(stale.runDb, Array(30).fill("stale"));
      check("stale show: stale-if-error feeds never count as absence", (await stateOf(stale.x))?.status !== "auto_hidden");
      const unk = mk();
      await drive(unk.runDb, [...Array(11).fill("silent"), ...Array(10).fill("unknown"), ...Array(10).fill("silent")]);
      check("stale show: unknown/incomplete days between absent days never count", (await stateOf(unk.x))?.status !== "auto_hidden");
      const prov = mk();
      await drive(prov.runDb, Array(25).fill("silent"), 0, undefined, { instantOf: (off) => new Date(`${addDaysToLocalDate(MONITOR_DAY0, off + 1)}T03:00:00Z`) });
      check("stale show: absence observed before the Disneyland day-end window is provisional and never hides", (await stateOf(prov.x))?.status !== "auto_hidden");
    }

    // ---- both resort runs: idempotent and provider-safe ----
    {
      const x = mk();
      const calls: string[] = [];
      const run1 = async (iso: string) => runEntertainmentLifecycleMonitor({
        instant: new Date(iso), runDb: x.runDb, sleep: async () => {},
        getShowtimes: async (parkId) => { calls.push(parkId); return mkPark(parkId, { [MMM]: "silent" }, {}, parkId === "disneyland" || parkId === "dca" ? "2026-12-01" : "2026-12-01"); },
      });
      const wdw = await run1("2026-12-02T03:00:00Z"); // 22:00 EST Dec 1 (WDW final) / 19:00 PST (Disneyland provisional)
      const dlr = await run1("2026-12-02T06:00:00Z"); // 22:00 PST Dec 1 (Disneyland final)
      check("both runs: one provider fetch per park per run (6 + 6), none extra", calls.length === 12 && LIFECYCLE_PARK_IDS.every((p) => calls.filter((c) => c === p).length === 2));
      check("both runs: finality is per resort (WDW run: mk final, disneyland provisional; DLR run: disneyland final)", wdw!.parks.find((p) => p.parkId === "mk")!.dayEnd && !wdw!.parks.find((p) => p.parkId === "disneyland")!.dayEnd && dlr!.parks.find((p) => p.parkId === "disneyland")!.dayEnd && !dlr!.parks.find((p) => p.parkId === "mk")!.dayEnd);
      const row = x.x.evidence.get(`${PARK}|${mmmKey}|2026-12-01`);
      check("both runs: the provisional Disneyland row from the WDW run is finalized by the DLR run (one row, observation_count 2)", row?.is_final === true && row.observation_count === 2 && x.x.evidence.size >= 1);
      const snap = JSON.stringify([...x.x.evidence.entries()].map(([k, r]) => [k, r.day_class, r.is_final]));
      await run1("2026-12-02T03:00:00Z"); await run1("2026-12-02T06:00:00Z");
      check("both runs: re-delivering both runs changes nothing but counters (idempotent)", JSON.stringify([...x.x.evidence.entries()].map(([k, r]) => [k, r.day_class, r.is_final])) === snap && x.x.events.size === 0);
    }

    // ---- review fixes through the monitor: EPCOT coverage + discarded entities ----
    {
      const epcotShow = ENTERTAINMENT_PLACES.find((p) => p.parkId === "epcot" && isLifecycleEligible("epcot", p.name) && getEntertainmentProviderMapping(p.name, "epcot")?.disposition === "mapped")!.name;
      const epKey = entertainmentMappingKey("epcot", epcotShow);
      const wdwInstant = (off: number) => new Date(`${addDaysToLocalDate(MONITOR_DAY0, off + 1)}T03:00:00Z`); // 22:00 EST: WDW day-end window
      const epDrive = async (x: FakeLifecycleDb, n: number, covOf: { publishedEntities: number; droppedEntities: number }, start = 0) => {
        for (let off = start; off < start + n; off++) {
          await runEntertainmentLifecycleMonitor({ instant: wdwInstant(off), runDb: async (_p, fn) => fn(x), sleep: async () => {},
            getShowtimes: async (parkId) => (parkId === "epcot" ? mkPark("epcot", { [epcotShow]: "silent" }, { providerCoverage: { ...covOf, droppedShowtimes: 0 } }, localOf(off)) : mkPark(parkId, {}, { error: { kind: "timeout", message: "t" } }, localOf(off))) });
        }
      };
      const epState = async (x: FakeLifecycleDb) => (await readStates(x, "epcot")).get(epKey);
      const e1 = new FakeLifecycleDb();
      await epDrive(e1, 20, { publishedEntities: 6, droppedEntities: 0 });
      check("EPCOT via monitor: 20 absent days on a provider-healthy feed → visible", (await epState(e1))?.status === "visible" && (await epState(e1))?.dormantDays === 20);
      await epDrive(e1, 1, { publishedEntities: 6, droppedEntities: 0 }, 20);
      check("EPCOT via monitor: the 21st absent day hides the show (provider-wide coverage, mapping identity)", (await epState(e1))?.status === "auto_hidden");
      const e2 = new FakeLifecycleDb();
      await epDrive(e2, 30, { publishedEntities: 2, droppedEntities: 0 });
      check("EPCOT via monitor: a weak provider feed (2 entities) never counts absence", (await epState(e2))?.status !== "auto_hidden" && ![...e2.evidence.values()].some((r) => r.day_class === "silent"));
      const e3 = new FakeLifecycleDb();
      await epDrive(e3, 30, { publishedEntities: 6, droppedEntities: 1 });
      check("discarded entities via monitor: 30 days with a malformed/dropped provider entity never hide on absence", (await epState(e3))?.status !== "auto_hidden" && ![...e3.evidence.values()].some((r) => r.day_class === "silent" || r.day_class === "dormant"));
    }

    // ---- registry restoration / protection through the monitor ----
    {
      const reg = (assessment: "inactive" | "discontinued", confirmation: "confirmed" | "provisional" = "confirmed") => ({ schemaVersion: 1, records: [{ ...ENTERTAINMENT_LIFECYCLE_REGISTRY.records.find((r) => r.name === MMM)!, assessment, confirmation, visibility: { decision: "hidden", reason: "test" } }] }) as unknown as EntertainmentLifecycleRegistry;
      const r1 = mk();
      await drive(r1.runDb, Array(3).fill("inactive"), 0, undefined, { registry: reg("inactive") });
      check("registry hide + inactive observations: nothing decided automatically", (await stateOf(r1.x))?.status === "visible" && !(await stateOf(r1.x))?.registryRestored && r1.x.events.size === 0);
      resetLifecycleReadState();
      let vs = await getLifecycleVisibilityState(PARK, { executor: { run: (fn) => fn(r1.x), abort() {} } as PersistExecutor });
      check("registry hide not restored: persisted state lists nothing (registry hide stands)", !!vs && vs.registryRestored.length === 0 && getLifecycleHiddenNames(PARK, vs.autoHidden, null, reg("inactive"), vs.registryRestored).has(MMM));
      const rep = await drive(r1.runDb, ["active"], 3, undefined, { registry: reg("inactive") });
      st = await stateOf(r1.x);
      check("registry restoration: a verified performance restores a CONFIRMED inactive registry hide, durably", st?.status === "visible" && st.registryRestored === true && st.cycleResetDate === localOf(3) && rep[0]!.parks.find((p) => p.parkId === PARK)!.registryRestored.includes(MMM));
      check("registry restoration: audited as registry_restore with coverage limitations and the registry record unchanged", [...r1.x.events.values()].some((e) => e.event_type === "registry_restore" && (e.coverage_limitations as string[]).some((l) => /NOT edited/.test(l))) && st?.auditFlag === "registry_conflict");
      resetLifecycleReadState();
      vs = await getLifecycleVisibilityState(PARK, { executor: { run: (fn) => fn(r1.x), abort() {} } as PersistExecutor });
      check("registry restoration: persisted override un-hides on the shared set (both pages), even with no performance in the response", !!vs && vs.registryRestored.includes(MMM) && !getLifecycleHiddenNames(PARK, vs.autoHidden, null, reg("inactive"), vs.registryRestored).has(MMM));
      await drive(r1.runDb, Array(20).fill("inactive"), 4, undefined, { registry: reg("inactive") });
      check("registry restoration: 20 later inactive days do not re-hide", (await stateOf(r1.x))?.status === "visible");
      await drive(r1.runDb, ["dormant"], 24, undefined, { registry: reg("inactive") });
      st = await stateOf(r1.x);
      resetLifecycleReadState();
      vs = await getLifecycleVisibilityState(PARK, { executor: { run: (fn) => fn(r1.x), abort() {} } as PersistExecutor });
      check("registry restoration: later 21-of-30 inactivity re-hides; the shared set hides it again", st?.status === "auto_hidden" && !!vs && getLifecycleHiddenNames(PARK, vs.autoHidden, null, reg("inactive"), vs.registryRestored).has(MMM));

      const r2 = mk();
      await drive(r2.runDb, ["active"], 0, undefined, { registry: reg("discontinued") });
      st = await stateOf(r2.x);
      check("registry protection: a DISCONTINUED record is never auto-restored (conflict event only)", st?.registryRestored !== true && [...r2.x.events.values()].every((e) => e.event_type === "registry_conflict") && r2.x.events.size === 1);
      const r3 = mk();
      await drive(r3.runDb, Array(25).fill("dormant"), 0, undefined, { registry: reg("inactive") });
      check("registry hide: 25 dormant days produce no auto_hide (already registry-hidden)", ![...r3.x.events.values()].some((e) => e.event_type === "auto_hide"));
      check("legacy protection: no lifecycle rows are ever written for a legacy/unknown identity", ![...r1.x.states.values(), ...r2.x.states.values(), ...r3.x.states.values()].some((r) => getLegacyEntertainmentPlaces().some((l) => l.name === r.show_name)));
    }
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
        const o = (cls: LifecycleDayClass) => ({ parkId: PARK, showKey: "disneyland:precedence-probe", showName: "Probe", localDate: TODAY, dayClass: cls, basis: cls, performanceCount: cls === "active" ? 3 : 0, source: "live" as const, final: true, limitations: ["x"] });
        await upsertObservations(q, [o("unknown"), o("inactive"), o("silent"), o("active"), o("inactive")]);
      });
      const probe = await exec().run((q) => readEvidence(q, PARK, TODAY, TODAY));
      check("real db: evidence precedence (active survives later weaker rows; performance count kept)", probe.some((r) => r.showKey === "disneyland:precedence-probe" && r.dayClass === "active" && r.performanceCount === 3));
      // finality + dormant precedence in real SQL (CHECK constraint accepts 'dormant')
      await exec().run(async (q) => {
        const o = (cls: LifecycleDayClass, fin: boolean) => ({ parkId: PARK, showKey: "disneyland:final-probe", showName: "Probe", localDate: TODAY, dayClass: cls, basis: cls, performanceCount: cls === "active" ? 2 : 0, source: "live" as const, final: fin, limitations: [] as string[] });
        await upsertObservations(q, [o("inactive", false)]);
        await upsertObservations(q, [o("dormant", true)]);
        await upsertObservations(q, [o("inactive", false)]);
      });
      const fp = (await exec().run((q) => readEvidence(q, PARK, TODAY, TODAY))).find((r) => r.showKey === "disneyland:final-probe");
      check("real db: a FINAL dormant row replaces a provisional inactive one and a later provisional row cannot undo it", fp?.dayClass === "dormant" && fp.final === true);
      await exec().run(async (q) => { await upsertObservations(q, [{ parkId: PARK, showKey: "disneyland:final-probe", showName: "Probe", localDate: TODAY, dayClass: "active", basis: "a", performanceCount: 1, source: "live", final: true, limitations: [] }]);
        await upsertObservations(q, [{ parkId: PARK, showKey: "disneyland:final-probe", showName: "Probe", localDate: TODAY, dayClass: "inactive", basis: "i", performanceCount: 0, source: "live", final: true, limitations: [] }]); });
      check("real db: active is never replaced by a later final negative", (await exec().run((q) => readEvidence(q, PARK, TODAY, TODAY))).find((r) => r.showKey === "disneyland:final-probe")?.dayClass === "active");
      // registry restoration + dormancy durable in real Postgres
      const regRec = { schemaVersion: 1, records: [{ ...ENTERTAINMENT_LIFECYCLE_REGISTRY.records.find((r) => r.name === MMM)!, assessment: "inactive", confirmation: "confirmed", visibility: { decision: "hidden", reason: "test" } }] } as unknown as EntertainmentLifecycleRegistry;
      await drive(runDb, ["active"], 40, undefined, { registry: regRec });
      st = await exec().run((q) => stateOf(q));
      const vsReal = await exec().run(async (q) => (await q.query("SELECT show_name FROM entertainment_lifecycle_state WHERE registry_restored_at IS NOT NULL")).rows.map((r) => String(r.show_name)));
      check("real db: registry restoration persisted (registry_restored_at) and audited", st?.registryRestored === true && vsReal.includes(MMM) && (await exec().run((q) => readLifecycleAudit(q))).unreviewedEvents.some((e) => e.eventType === "registry_restore"));
      await drive(runDb, Array(21).fill("dormant"), 41, undefined, { registry: regRec });
      st = await exec().run((q) => stateOf(q));
      check("real db: 21 dormant days after the registry restoration hide the show again", st?.status === "auto_hidden" && st.dormantDays === 21);
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

/**
 * Waits & Shows refresh-flicker regression (page keeps same-park/same-day hide evidence across failed
 * refreshes). Mirrors the page's reducer + hide-set derivation. Run manually: [] = all pass.
 */
export function runDevLifecycleRefreshEvidenceCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const NOW = new Date("2026-12-10T20:00:00Z"); // 3 PM EST, WDW
  const HEA = "Happily Ever After";
  const okMk = (autoHidden?: string[], restored?: string[], localDate = "2026-12-10"): ParkEntertainmentShowtimes =>
    ({ parkId: "mk", resort: "WDW", localDate, error: null, entries: [], ...(autoHidden ? { lifecycleAutoHidden: autoHidden } : {}), ...(restored ? { lifecycleRegistryRestored: restored } : {}) }) as unknown as ParkEntertainmentShowtimes;
  const failedMk = resolveShowtimesResponse("mk", null, NOW);
  // The page's derivation: current response evidence, else retained.
  const hiddenFor = (park: "mk" | "epcot", resp: ParkEntertainmentShowtimes | null, ev: RetainedLifecycleEvidence | null, at = NOW) => {
    const r = activeRetainedEvidence(ev, park, at);
    return getLifecycleHiddenNames(park, resp?.lifecycleAutoHidden ?? r?.autoHidden, performingNamesFromShowtimes(resp?.entries), undefined, resp?.lifecycleRegistryRestored ?? r?.registryRestored);
  };

  const ev1 = nextRetainedLifecycleEvidence(null, "mk", okMk([HEA]));
  check("success carrying the list is retained", !!ev1 && ev1.autoHidden?.[0] === HEA && ev1.localDate === "2026-12-10");
  check("baseline: hidden from the successful response", hiddenFor("mk", okMk([HEA]), ev1).has(HEA));
  check("root cause: without retention a failed refresh fails open (show reappears)", !hiddenFor("mk", failedMk, null).has(HEA));
  const evAfterFail = nextRetainedLifecycleEvidence(ev1, "mk", failedMk);
  check("failed refresh keeps the evidence", evAfterFail === ev1);
  check("failed refresh: show stays hidden (no flicker)", hiddenFor("mk", failedMk, evAfterFail).has(HEA));
  check("failed refresh: performances are not retained (unavailable response has no performing names)", performingNamesFromShowtimes(failedMk.entries).size === 0);
  check("success without lifecycle fields (DB unavailable) keeps evidence", nextRetainedLifecycleEvidence(ev1, "mk", okMk()) === ev1 && hiddenFor("mk", okMk(), ev1).has(HEA));
  check("null/other-park response keeps same-park evidence and never adopts a foreign body",
    nextRetainedLifecycleEvidence(ev1, "mk", null) === ev1 && nextRetainedLifecycleEvidence(ev1, "mk", { ...okMk([]), parkId: "epcot" } as unknown as ParkEntertainmentShowtimes) === ev1);

  // overlapping requests: only the latest request's response is applied (page token guard), so the
  // reducer sees them in latest-wins order; a later success replaces, a later failure keeps.
  let ev: RetainedLifecycleEvidence | null = null;
  for (const r of [okMk([HEA]), failedMk, failedMk]) ev = nextRetainedLifecycleEvidence(ev, "mk", r);
  check("success → fail → fail sequence keeps hiding", hiddenFor("mk", failedMk, ev).has(HEA));
  ev = nextRetainedLifecycleEvidence(ev, "mk", okMk([]));
  check("legitimate resurfacing: a later healthy response with an empty list replaces evidence and un-hides", !hiddenFor("mk", okMk([]), ev).has(HEA));
  check("after resurfacing a following failure does not re-hide", !hiddenFor("mk", failedMk, nextRetainedLifecycleEvidence(ev, "mk", failedMk)).has(HEA));

  // lifecycle arrays are independent of provider errors (route reads them separately)
  const providerErrWithList = { ...okMk([]), error: { kind: "network", message: "x" } } as unknown as ParkEntertainmentShowtimes;
  const evErr = nextRetainedLifecycleEvidence(ev1, "mk", providerErrWithList);
  check("provider-error body carrying lifecycle arrays replaces retained evidence", !!evErr && evErr !== ev1 && evErr.autoHidden?.length === 0);
  check("…so a following network failure does not resurrect the old hide", !hiddenFor("mk", failedMk, nextRetainedLifecycleEvidence(evErr, "mk", failedMk)).has(HEA));

  // park / date transitions
  check("park change drops retained evidence", nextRetainedLifecycleEvidence(ev1, "epcot", failedMk) === null && activeRetainedEvidence(ev1, "epcot", NOW) === null);
  check("park switch back after a failed epcot refresh does not resurrect mk evidence", nextRetainedLifecycleEvidence(nextRetainedLifecycleEvidence(ev1, "epcot", failedMk), "mk", failedMk) === null);
  check("same resort-local day: evidence active", activeRetainedEvidence(ev1, "mk", new Date("2026-12-11T04:59:00Z")) === ev1); // 11:59 PM EST
  check("resort-local midnight invalidates retained evidence", activeRetainedEvidence(ev1, "mk", new Date("2026-12-11T05:00:00Z")) === null);
  check("day rollover with a failed refresh fails open (never stale evidence on a new day)", !hiddenFor("mk", failedMk, ev1, new Date("2026-12-11T05:30:00Z")).has(HEA));

  // registry decisions preserved
  const restoredEv = nextRetainedLifecycleEvidence(null, "disneyland", { parkId: "disneyland", resort: "DLR", localDate: "2026-12-10", error: null, entries: [], lifecycleAutoHidden: [], lifecycleRegistryRestored: ["Paint the Night"] } as unknown as ParkEntertainmentShowtimes);
  const dlrFail = resolveShowtimesResponse("disneyland", null, NOW);
  check("retained registryRestored keeps a restored registry show visible across a failure", !hiddenFor("disneyland" as never, dlrFail, restoredEv).has("Paint the Night") && hiddenFor("disneyland" as never, dlrFail, restoredEv).has("Wondrous Journeys"));
  check("first load (no evidence) fails open for auto-hide but registry hides stand", getLifecycleHiddenNames("disneyland", undefined, null, undefined, undefined).has("Paint the Night"));
  return failures;
}

/**
 * Same-day inactivity retention across refresh uncertainty (history timeout / provider failure).
 * Run manually: [] = all pass.
 */
export function runDevInactivityRetentionCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const NOW = new Date("2026-12-10T20:00:00Z"); // 3 PM EST, WDW
  const HEA = "Happily Ever After";
  const place = getEntertainmentForPark("mk").find((p) => p.name === HEA)!;
  type E = { dwpName: string; performances: unknown[]; status?: string; incomplete?: boolean; historyCandidate?: boolean; confirmedNoActivityToday?: boolean };
  const resp = (e: Partial<E>, extra: Record<string, unknown> = {}, localDate = "2026-12-10") =>
    ({ parkId: "mk", resort: "WDW", localDate, error: null, stale: false, entries: [{ dwpName: HEA, performances: [], status: "none_posted", incomplete: false, ...e }], ...extra }) as unknown as ParkEntertainmentShowtimes;
  const confirmed = resp({ confirmedNoActivityToday: true });
  const historyTimedOut = resp({ historyCandidate: true, confirmedNoActivityToday: false });
  const failed = resp({ status: "unavailable", incomplete: true }, { error: { kind: "network", message: "x" } });
  const hidden = (r: ParkEntertainmentShowtimes, ev: RetainedInactivity | null, at = NOW, park: "mk" | "epcot" = "mk") =>
    isEntertainmentHiddenToday(place, "WDW", "2026-12-10", applyRetainedInactivity(r as never, ev, park, at), at);

  const ev1 = nextRetainedInactivity(null, "mk", confirmed);
  check("confirmed response retains the name", !!ev1 && ev1.names.includes(HEA));
  check("baseline: confirmed → hidden", hidden(confirmed, ev1));
  check("root cause: history-timeout response alone reappears (no retention)", !hidden(historyTimedOut, null));
  const ev2 = nextRetainedInactivity(ev1, "mk", historyTimedOut);
  check("uncertain (history timeout) keeps retained name and stays hidden", ev2!.names.includes(HEA) && hidden(historyTimedOut, ev2));
  const ev3 = nextRetainedInactivity(ev2, "mk", failed);
  check("provider failure keeps retained name and stays hidden", ev3!.names.includes(HEA) && hidden(failed, ev3));
  check("confirmed → uncertain → confirmed stays hidden throughout and re-confirms", hidden(confirmed, nextRetainedInactivity(ev3, "mk", confirmed)));
  let ev = ev1;
  for (let i = 0; i < 5; i++) ev = nextRetainedInactivity(ev, "mk", i % 2 ? failed : historyTimedOut);
  check("repeated uncertain refreshes keep hiding", hidden(failed, ev) && hidden(historyTimedOut, ev));

  // first load / never confirmed
  check("first load fail-open: no retained evidence → uncertain entry visible", !hidden(historyTimedOut, null) && !hidden(failed, null));
  check("uncertain response never creates evidence", nextRetainedInactivity(null, "mk", historyTimedOut)!.names.length === 0 && nextRetainedInactivity(null, "mk", failed)!.names.length === 0);

  // genuine resurfacing
  const performing = resp({ performances: [{ startTime: "2026-12-10T22:00:00-05:00" }], status: "upcoming" });
  check("verified performance overrides retained inactivity immediately", !hidden(performing, ev));
  check("performance clears retained name", !nextRetainedInactivity(ev, "mk", performing)!.names.includes(HEA));
  const operating = resp({ confirmedNoActivityToday: false });
  check("fresh authoritative not-inactive (clean, not a history candidate) replaces retained", !hidden(operating, ev) && !nextRetainedInactivity(ev, "mk", operating)!.names.includes(HEA));
  check("a following failure does not re-hide after genuine resurfacing", !hidden(failed, nextRetainedInactivity(nextRetainedInactivity(ev, "mk", operating), "mk", failed)));
  check("stale payload is uncertain, not proof", hidden(resp({ confirmedNoActivityToday: false }, { stale: true }), ev));

  // park / date
  check("park change drops retained names", nextRetainedInactivity(ev, "epcot", failed) === null && !hidden(failed, ev, NOW, "epcot"));
  check("other-park/null responses never adopt or erase same-park evidence", nextRetainedInactivity(ev, "mk", null) === ev && nextRetainedInactivity(ev, "mk", { ...confirmed, parkId: "epcot" } as never) === ev);
  const midnight = new Date("2026-12-11T05:00:00Z");
  check("resort-local midnight invalidates retained inactivity (fails open)", !hidden(historyTimedOut, ev, midnight) && hidden(historyTimedOut, ev, new Date("2026-12-11T04:59:00Z")));
  check("new-day response does not inherit yesterday's names", nextRetainedInactivity(ev, "mk", resp({ historyCandidate: true }, {}, "2026-12-11"))!.names.length === 0);

  // party night keeps visible even if retained
  const partyPlace = getEntertainmentForPark("mk").find((p) => getSeasonalEntertainmentRank(p.name, { resort: "WDW", date: "2026-12-10", parkId: "mk", instant: NOW }) === "party-night");
  if (partyPlace) {
    const pr = { ...historyTimedOut, entries: [{ ...historyTimedOut.entries[0], dwpName: partyPlace.name }] } as ParkEntertainmentShowtimes;
    const pev = { parkId: "mk", resort: "WDW", localDate: "2026-12-10", names: [partyPlace.name] } as RetainedInactivity;
    check("party-night exception preserved with retained inactivity", !isEntertainmentHiddenToday(partyPlace, "WDW", "2026-12-10", applyRetainedInactivity(pr as never, pev, "mk", NOW), NOW));
  }
  return failures;
}

// ============================================
// PHASE 14.5D — LEGACY COMEBACKS
// ============================================

const LEGACY_NAME = "Together Forever — A Pixar Nighttime Spectacular"; // legacy, disneyland
const LEGACY_NAME_DCA = "Better Together: A Pixar Pals Celebration!"; // legacy, dca
const LEGACY_ID = "11111111-1111-4111-8111-111111111111";
const LEGACY_ID_2 = "22222222-2222-4222-8222-222222222222";
const fixtureLegacy = (...m: EntertainmentProviderMapping[]): LegacyIdentityOptions => ({ legacyMapping: m });
const legacyMapped = (name: string, parkId: ParkId, id: string): EntertainmentProviderMapping =>
  ({ dwpName: name, parkId, disposition: "mapped", provider: [{ entityId: id, entityType: "SHOW", providerName: name }] });
/** Established fixture for the Disneyland legacy show; the DCA legacy show stays unmapped. */
const LEGACY_FIXTURE: LegacyIdentityOptions = fixtureLegacy(
  legacyMapped(LEGACY_NAME, "disneyland", LEGACY_ID),
  { dwpName: LEGACY_NAME_DCA, parkId: "dca", disposition: "unmapped", reason: "none" },
);
const legacyKey = entertainmentMappingKey("disneyland", LEGACY_NAME);

export async function runDevLegacyComebackCases(): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const evalLegacy = (observations: Obs[], state: LifecycleShowState | null = null, established = true, today = TODAY) =>
    evaluateLegacyLifecycle({ today, observations, state, identityEstablished: established });
  const surfaced = (over: Partial<LifecycleShowState> = {}): LifecycleShowState =>
    ({ status: "legacy_comeback", cycleResetDate: d(-1), lastActiveDate: d(-1), hiddenLocalDate: null, hideCount: 0, restoreCount: 1, silenceFlagged: false, secondaryEvaluatedOn: null, auditFlag: null, registryRestored: false, ...over });

  // ---------- identity ----------
  check("constants: 7 of 14", LEGACY_COMEBACK_MIN_DAYS === 7 && LEGACY_COMEBACK_WINDOW_DAYS === 14);
  check("shipped legacy registry is structurally valid and covers every legacy identity", validateLegacyProviderMapping().length === 0);
  check("shipped legacy shows have no verified provider identity yet → never established, never observed",
    getLegacyEntertainmentPlaces().every((p) => !isLegacyIdentityEstablished(p.parkId!, p.name)) && legacyProviderEntityIds().size === 0);
  check("fixture: a mapped, unambiguous legacy identity is established", isLegacyIdentityEstablished("disneyland", LEGACY_NAME, LEGACY_FIXTURE.legacyMapping) && !!resolveLegacyShow("disneyland", LEGACY_NAME, LEGACY_FIXTURE));
  check("unmapped legacy identity is not established", !resolveLegacyShow("dca", LEGACY_NAME_DCA, LEGACY_FIXTURE));
  check("identity is park-qualified: the same name in another park does not resolve", !resolveLegacyShow("dca", LEGACY_NAME, LEGACY_FIXTURE) && !resolveLegacyShow("mk", LEGACY_NAME, LEGACY_FIXTURE));
  check("no name-only/alias/fuzzy resolution (alias 'Together Forever', case change)", !resolveLegacyShow("disneyland", "Together Forever", LEGACY_FIXTURE) && !resolveLegacyShow("disneyland", LEGACY_NAME.toLowerCase(), LEGACY_FIXTURE));
  const activeId = (THEMEPARKS_ENTERTAINMENT_MAPPING.find((m) => m.disposition === "mapped") as Extract<EntertainmentProviderMapping, { disposition: "mapped" }>).provider[0].entityId;
  const ambiguous = (m: EntertainmentProviderMapping[]) => !isLegacyIdentityEstablished("disneyland", LEGACY_NAME, m);
  check("ambiguity: provider id shared with an ACTIVE mapping → not established", ambiguous([legacyMapped(LEGACY_NAME, "disneyland", activeId)]));
  check("ambiguity: provider id shared by two legacy entries → neither established",
    ambiguous([legacyMapped(LEGACY_NAME, "disneyland", LEGACY_ID), legacyMapped(LEGACY_NAME_DCA, "dca", LEGACY_ID)]) && !isLegacyIdentityEstablished("dca", LEGACY_NAME_DCA, [legacyMapped(LEGACY_NAME, "disneyland", LEGACY_ID), legacyMapped(LEGACY_NAME_DCA, "dca", LEGACY_ID)]));
  check("ambiguity: malformed UUID / non-SHOW / empty refs → not established",
    ambiguous([legacyMapped(LEGACY_NAME, "disneyland", "NOT-A-UUID")]) &&
    ambiguous([{ dwpName: LEGACY_NAME, parkId: "disneyland", disposition: "mapped", provider: [{ entityId: LEGACY_ID, entityType: "ATTRACTION", providerName: "x" }] }]) &&
    ambiguous([{ dwpName: LEGACY_NAME, parkId: "disneyland", disposition: "mapped", provider: [] }]));
  check("a legacy registry entry for an ACTIVE identity is rejected", validateLegacyProviderMapping([legacyMapped(MMM, "disneyland", LEGACY_ID)]).some((f) => f.kind === "legacy_unknown_identity") && !resolveLegacyShow("disneyland", MMM, fixtureLegacy(legacyMapped(MMM, "disneyland", LEGACY_ID))));
  check("registry validation: missing disposition for a legacy identity is reported", validateLegacyProviderMapping([]).filter((f) => f.kind === "legacy_missing_disposition").length === getLegacyEntertainmentPlaces().length);
  check("a legacy name that is also an active identity never resolves even if listed as legacy", !resolveLegacyShow("disneyland", MMM, { ...fixtureLegacy(legacyMapped(MMM, "disneyland", LEGACY_ID)), legacyPlaces: [{ name: MMM, parkId: "disneyland" }] }));

  // ---------- qualification (pure) ----------
  let ev = evalLegacy(run("active", -5, 0));
  check("6 active days do NOT qualify", ev.state.status === "legacy_hidden" && ev.events.length === 0);
  ev = evalLegacy(run("active", -6, 0));
  check("7 distinct active days within 14 → comeback with evidence + limitations",
    ev.state.status === "legacy_comeback" && ev.state.restoreCount === 1 && ev.state.cycleResetDate === TODAY && ev.events.length === 1 && ev.events[0].type === "legacy_comeback" &&
    (ev.events[0].evidence as { activeDays: number }).activeDays === 7 && ev.events[0].coverageLimitations.length >= 3);
  check("7 non-consecutive active days inside the 14-day window qualify", evalLegacy([-13, -11, -9, -7, -5, -3, 0].map((o) => ({ localDate: d(o), dayClass: "active" as const }))).state.status === "legacy_comeback");
  check("active days outside the rolling 14 days do not count (6 inside + 1 at -14)", evalLegacy([...run("active", -5, 0), { localDate: d(-14), dayClass: "active" }]).state.status === "legacy_hidden");
  check("duplicate rows for one date count once", evalLegacy([...run("active", -5, 0), ...run("active", -5, 0)]).state.status === "legacy_hidden");
  check("inactive/dormant/silent/unknown days never count toward a comeback", evalLegacy([...run("active", -5, 0), ...run("inactive", -9, -6), ...run("silent", -13, -10)]).state.status === "legacy_hidden");
  check("future-dated rows are ignored", evalLegacy([...run("active", -5, 0), { localDate: d(1), dayClass: "active" }]).state.status === "legacy_hidden");
  check("unestablished identity: nothing changes, nothing emitted (even with 14 active days)", (() => { const r = evalLegacy(run("active", -13, 0), null, false); return r.state.status === "legacy_hidden" && r.events.length === 0 && !r.changed; })());
  check("repeat evaluation of a surfaced show is a no-op", (() => { const r = evalLegacy(run("active", -6, 0), surfaced({ cycleResetDate: TODAY, lastActiveDate: TODAY })); return r.events.length === 0 && r.state.status === "legacy_comeback" && !r.changed; })());
  check("only days after the latest re-hide count toward the next comeback", evalLegacy(run("active", -6, 0), { ...surfaced(), status: "legacy_hidden", hiddenLocalDate: d(-3), hideCount: 1 }).state.status === "legacy_hidden"
    && evalLegacy(run("active", -6, 0), { ...surfaced(), status: "legacy_hidden", hiddenLocalDate: d(-7), hideCount: 1 }).state.status === "legacy_comeback");

  // ---------- re-hide / re-comeback (21-of-30 reuse) ----------
  const sc = surfaced({ cycleResetDate: d(-21), lastActiveDate: d(-21), hiddenLocalDate: null });
  ev = evalLegacy(run("inactive", -19, 0), sc);
  check("20 inactive days do not re-hide", ev.state.status === "legacy_comeback" && ev.events.length === 0);
  ev = evalLegacy(run("inactive", -20, 0), sc);
  check("21 inactive days re-hide (legacy_rehide event; hiddenLocalDate; hideCount)",
    ev.state.status === "legacy_hidden" && ev.state.hiddenLocalDate === TODAY && ev.state.hideCount === 1 && ev.events.length === 1 && ev.events[0].type === "legacy_rehide" && ev.events[0].coverageLimitations.length >= 3);
  ev = evalLegacy([...run("dormant", -9, 0), ...run("inactive", -20, -10)], sc);
  check("dormant + inactive days combine (distinct dates) toward the re-hide", ev.state.status === "legacy_hidden");
  ev = evalLegacy([...run("silent", -20, 0)], sc);
  check("sustained silence re-hides once a performance established identity (it did, to come back)", ev.state.status === "legacy_hidden" && ev.events[0]?.type === "legacy_rehide");
  ev = evalLegacy([...run("inactive", -20, 0).map((o) => ({ ...o, final: false }))], sc);
  check("provisional (not day-end) negatives never re-hide", ev.state.status === "legacy_comeback" && ev.events.length === 0);
  ev = evalLegacy([...run("inactive", -20, -1), { localDate: TODAY, dayClass: "active" }], sc);
  check("a verified active day resets the cycle: 20 old inactive days + active today → stays surfaced", ev.state.status === "legacy_comeback" && ev.state.cycleResetDate === TODAY && ev.events.length === 0);
  ev = evalLegacy(run("unknown", -29, 0), sc);
  check("unknown days (outage/stale) can never re-hide", ev.state.status === "legacy_comeback" && ev.events.length === 0);
  check("silence flags / secondary evaluation are never produced for legacy shows", (() => { const r = evalLegacy(run("silent", -11, 0), sc); return r.events.every((e) => e.type !== "silence_flag") && !r.needsSecondary && !r.state.silenceFlagged; })());
  const hidden1 = evalLegacy(run("inactive", -20, 0), sc).state;
  const old = run("active", -26, -21);
  check("after a re-hide the old active days cannot start a new comeback", evalLegacy([...old, ...run("active", -2, 0)], { ...hidden1, hiddenLocalDate: d(-3) }).state.status === "legacy_hidden");
  ev = evalLegacy(run("active", -6, 0), { ...hidden1, hiddenLocalDate: d(-10) });
  check("a fresh 7-of-14 after the re-hide starts the next cycle (comebackCount 2)", ev.state.status === "legacy_comeback" && ev.state.restoreCount === 2 && ev.events[0].type === "legacy_comeback" && (ev.events[0].evidence as { cycle: number }).cycle === 2);

  // ---------- observation / failures / day boundaries ----------
  const legacyPark = (kind: Parameters<typeof mkEntry>[2], extra: Partial<ParkEntertainmentShowtimes> = {}, date = TODAY) =>
    mkPark("disneyland", {}, { legacyEntries: [mkEntry("disneyland", LEGACY_NAME, kind, [LEGACY_ID])], ...extra }, date);
  const obsOf = (st: ParkEntertainmentShowtimes, dayEnd = true, o: LegacyIdentityOptions = LEGACY_FIXTURE) => observeLegacyParkDay(st, dayEnd, o);
  check("observe: verified performance → active, final immediately (even before the day-end window)", (() => { const o = obsOf(legacyPark("active"), false); return o.length === 1 && o[0].dayClass === "active" && o[0].final && o[0].showKey === legacyKey; })());
  check("observe: clean empty day → inactive; closed → dormant; absent → silent (day-end: final)", ["inactive", "dormant", "silent"].every((k) => { const o = obsOf(legacyPark(k as "inactive")); return o.length === 1 && o[0].dayClass === k && o[0].final; }));
  check("day boundary: negatives before the day-end window are provisional (never counted)", ["inactive", "dormant", "silent"].every((k) => obsOf(legacyPark(k as "inactive"), false)[0].final === false));
  check("observe: provider failure / stale-if-error / previous-day payload yield NO observation",
    obsOf(legacyPark("active", { error: { kind: "timeout", message: "t" } })).length === 0 && obsOf(legacyPark("active", { stale: true })).length === 0 && obsOf(legacyPark("active", { fetchedLocalDate: d(-1) })).length === 0);
  check("observe: unestablished identity (shipped registry) → nothing, even with a performing entry", obsOf(legacyPark("active"), true, {}).length === 0);
  check("observe: unmapped entry / entry for another park / duplicate entry are skipped",
    obsOf(legacyPark("unmapped")).length === 0 &&
    obsOf(mkPark("dca", {}, { legacyEntries: [mkEntry("disneyland", LEGACY_NAME, "active", [LEGACY_ID])] })).length === 0 &&
    obsOf(legacyPark("active", { legacyEntries: [mkEntry("disneyland", LEGACY_NAME, "active", [LEGACY_ID]), mkEntry("disneyland", LEGACY_NAME, "active", [LEGACY_ID])] })).length === 1);
  check("observe: no legacy entries → none (active-show observation unchanged)", observeLegacyParkDay(mkPark("disneyland", {}), true, LEGACY_FIXTURE).length === 0 && !observeParkDay(legacyPark("active")).some((o) => o.showKey === legacyKey));
  check("observe: unknown (OPERATING without times) is not activity or inactivity", obsOf(legacyPark("operating_empty"))[0].dayClass === "unknown");
  check("observe: weak park coverage cannot produce negative evidence", obsOf(mkPark("disneyland", Object.fromEntries(getEntertainmentForPark("disneyland").map((p) => [p.name, "unknown" as const])), { legacyEntries: [mkEntry("disneyland", LEGACY_NAME, "inactive", [LEGACY_ID])] }))[0]?.dayClass === "unknown");

  // ---------- both-page visibility (shared logic) ----------
  const placeOf = (names: ReadonlyArray<string> | null | undefined, o: LegacyIdentityOptions = LEGACY_FIXTURE) => getLegacyComebackPlaces("disneyland", names, o).map((p) => p.name);
  check("shared: a persisted comeback of an established legacy identity surfaces", placeOf([LEGACY_NAME]).join() === LEGACY_NAME);
  check("shared: unknown/undefined/non-array comeback list surfaces nothing (fail open)", placeOf(undefined).length === 0 && placeOf(null).length === 0 && placeOf("x" as never).length === 0);
  check("shared: unestablished / wrong-park / active / unknown / duplicate names never surface",
    placeOf([LEGACY_NAME], {}).length === 0 && getLegacyComebackPlaces("dca", [LEGACY_NAME], LEGACY_FIXTURE).length === 0 && placeOf([MMM, "No Such Show", "Together Forever"]).length === 0 && placeOf([LEGACY_NAME, LEGACY_NAME]).length === 1);
  const cardEntry = mkEntry("disneyland", LEGACY_NAME, "active", [LEGACY_ID]);
  const stForPage = legacyPark("active", { legacyEntries: [cardEntry] });
  check("Waits & Shows: the card finds the legacy showtime entry; active entries still win by name", findShowtimeEntry(stForPage, LEGACY_NAME) === cardEntry && findShowtimeEntry(stForPage, MMM)?.dwpName === MMM && findShowtimeEntry(stForPage, "x") === undefined && findShowtimeEntry(null, LEGACY_NAME) === undefined);
  check("Waits & Shows: legacy entries never leak into the active entries list (no provider-only/active duplicate)", !stForPage.entries.some((e) => e.dwpName === LEGACY_NAME));

  // All Entertainment against a real provider payload (mutating the shipped registry, restored in finally).
  const registryBackup = LEGACY_ENTERTAINMENT_PROVIDER_MAPPING.slice();
  try {
    const idx = LEGACY_ENTERTAINMENT_PROVIDER_MAPPING.findIndex((m) => m.dwpName === LEGACY_NAME);
    LEGACY_ENTERTAINMENT_PROVIDER_MAPPING[idx] = legacyMapped(LEGACY_NAME, "disneyland", LEGACY_ID);
    const instant = new Date(`${TODAY}T20:00:00Z`);
    const live = (extraId?: string): ThemeParksLive => ({
      entityId: "park", name: "Disneyland Park", timeZone: "America/Los_Angeles", droppedEntries: 0, droppedShowtimes: 0,
      entries: [
        { entityId: LEGACY_ID, name: LEGACY_NAME, entityType: "SHOW", parkId: null, externalId: null, status: "OPERATING", lastUpdated: null, droppedShowtimes: 0, showtimes: [{ type: "Performance Time", startTime: `${TODAY}T20:30:00-08:00`, endTime: null }] },
        ...(extraId ? [{ entityId: extraId, name: "Some Provider Only Show", entityType: "SHOW", parkId: null, externalId: null, status: "OPERATING", lastUpdated: null, droppedShowtimes: 0, showtimes: [] }] : []),
      ],
    });
    const ok = (data: ThemeParksLive) => ({ ok: true as const, data, meta: { origin: "network" as const, fetchedAt: instant.getTime(), etag: null } });
    const all = buildParkAllEntertainment("disneyland", ok(live(LEGACY_ID_2)), instant);
    check("All: a registered legacy entity is never provider-only (no provider-only duplicate); other provider-only shows still are",
      !all.entries.some((e) => e.source === "provider_only" && e.id === `provider:${LEGACY_ID}`) && all.entries.some((e) => e.source === "provider_only" && e.id === `provider:${LEGACY_ID_2}`));
    check("All: the legacy entry is listed separately, curated-shaped, with its legacy land, and not in `entries`", all.legacyEntries?.length === 1 && all.legacyEntries[0].id === `curated:disneyland:${LEGACY_NAME}` && all.legacyEntries[0].land === "Main Street, U.S.A." && !all.entries.some((e) => e.name === LEGACY_NAME));
    check("All: legacy entry carries the verified performance", (all.legacyEntries?.[0].showtime.performances.length ?? 0) === 1);
    const merged = mergeLegacyComebackEntries(all.entries, all.legacyEntries, "disneyland", [LEGACY_NAME], LEGACY_FIXTURE);
    check("All: a persisted comeback adds the legacy entry exactly once", merged.filter((e) => e.name === LEGACY_NAME).length === 1 && merged.length === all.entries.length + 1);
    // Review finding: a comeback with only a FUTURE performance has confirmedNoActivityToday and must not be dropped by the daily filter.
    const futureOnly = { ...all.legacyEntries![0], showtime: { ...all.legacyEntries![0].showtime, performances: [], confirmedNoActivityToday: true, inactivityBasis: "forward_horizon" as const } };
    const mergedFuture = mergeLegacyComebackEntries(all.entries, [futureOnly], "disneyland", [LEGACY_NAME], LEGACY_FIXTURE);
    const todayLocal = getResortLocalDate("DLR", instant);
    const naive = applyAllEntertainmentSeasonalVisibility(mergedFuture, "disneyland", "DLR", todayLocal, false, instant);
    check("All: (regression guard) the unsplit daily filter WOULD drop a no-activity-today comeback", !naive.some((e) => e.name === LEGACY_NAME));
    const sp = splitLegacyComebackEntries(mergedFuture, [futureOnly]);
    const kept = [...applyAllEntertainmentSeasonalVisibility(sp.regular, "disneyland", "DLR", todayLocal, false, instant), ...sp.legacy];
    check("All: comebacks are exempt from the daily inactivity filter (kept; regular entries still filtered), matching Waits & Shows", kept.some((e) => e.name === LEGACY_NAME) && sp.legacy.length === 1 && sp.regular.length === all.entries.length);
    check("All: merging is idempotent (never duplicates on re-merge)", mergeLegacyComebackEntries(merged, all.legacyEntries, "disneyland", [LEGACY_NAME], LEGACY_FIXTURE).length === merged.length);
    check("All: no persisted comeback → legacy show absent; unknown list → absent", mergeLegacyComebackEntries(all.entries, all.legacyEntries, "disneyland", [], LEGACY_FIXTURE).length === all.entries.length && mergeLegacyComebackEntries(all.entries, all.legacyEntries, "disneyland", undefined, LEGACY_FIXTURE).length === all.entries.length);
    const dup = [...all.entries, { ...all.legacyEntries![0], id: `provider:${LEGACY_ID}`, source: "provider_only" as const }];
    check("All: a provider-only entry already carrying the legacy entity blocks the legacy merge (duplicate guard)", mergeLegacyComebackEntries(dup, all.legacyEntries, "disneyland", [LEGACY_NAME], LEGACY_FIXTURE).length === dup.length);
    check("All: lifecycle hide set cannot hide a legacy comeback (legacy never in the hidden set)", filterLifecycleHiddenEntries(merged, getLifecycleHiddenNames("disneyland", [LEGACY_NAME])).some((e) => e.name === LEGACY_NAME));
    check("All: provider failure → no legacy entries (nothing fabricated)", buildParkAllEntertainment("disneyland", { ok: false, error: { kind: "timeout", message: "t" } }, instant).legacyEntries === undefined);
    const st = normalizeParkEntertainmentShowtimes("disneyland", ok(live()), instant);
    check("Waits & Shows normalizer: legacyEntries for the established legacy show only (separate from entries)", st.legacyEntries?.length === 1 && st.legacyEntries[0].dwpName === LEGACY_NAME && st.legacyEntries[0].performances.length === 1 && !st.entries.some((e) => e.dwpName === LEGACY_NAME));
    check("Waits & Shows normalizer: other parks / failures carry no legacy entries", normalizeParkEntertainmentShowtimes("dca", ok(live()), instant).legacyEntries === undefined && normalizeParkEntertainmentShowtimes("disneyland", { ok: false, error: { kind: "timeout", message: "t" } }, instant).legacyEntries === undefined);
  } finally {
    LEGACY_ENTERTAINMENT_PROVIDER_MAPPING.splice(0, LEGACY_ENTERTAINMENT_PROVIDER_MAPPING.length, ...registryBackup);
  }
  check("shipped registry restored after fixtures", LEGACY_ENTERTAINMENT_PROVIDER_MAPPING.every((m) => m.disposition === "unmapped"));
  check("catalog preserved: legacy catalog unchanged and no legacy identity in the active catalog or Smart Entry source",
    getLegacyEntertainmentPlaces().length === 2 && !ENTERTAINMENT_PLACES.some((p) => getLegacyEntertainmentPlaces().some((l) => l.name === p.name)) && !getEntertainmentForPark("disneyland").some((p) => p.name === LEGACY_NAME));

  // ---------- retained evidence (refresh flicker) ----------
  const retainedBody = { parkId: "disneyland" as ParkId, resort: "DLR" as const, localDate: TODAY, lifecycleAutoHidden: [] as string[], lifecycleLegacyComebacks: [LEGACY_NAME] };
  const rEv = nextRetainedLifecycleEvidence(null, "disneyland", retainedBody);
  check("refresh: legacy comebacks are retained across a failed refresh (same park/day) like the hide evidence", rEv?.legacyComebacks?.[0] === LEGACY_NAME && nextRetainedLifecycleEvidence(rEv, "disneyland", null) === rEv && activeRetainedEvidence(rEv, "disneyland", new Date(`${TODAY}T20:00:00Z`))?.legacyComebacks?.length === 1);
  check("refresh: another park / next resort day never reuses retained comebacks", nextRetainedLifecycleEvidence(rEv, "dca", null) === null && activeRetainedEvidence(rEv, "disneyland", new Date("2026-12-12T20:00:00Z")) === null);
  check("refresh: a healthy response without the legacy list drops stale retained comebacks", nextRetainedLifecycleEvidence(rEv, "disneyland", { ...retainedBody, lifecycleLegacyComebacks: undefined })?.legacyComebacks === undefined);

  // ---------- monitor over the in-memory SQL stand-in ----------
  const PARK: ParkId = "disneyland";
  const localOf = (off: number) => addDaysToLocalDate(MONITOR_DAY0, off)!;
  type Day = Parameters<typeof mkEntry>[2] | "provider_down" | "stale" | "prev_day";
  async function drive(runDb: LifecycleMonitorOptions["runDb"], days: Day[], startOffset = 0, instantOf: (off: number) => Date = instantFor, legacyIdentity: LegacyIdentityOptions = LEGACY_FIXTURE) {
    const reports = [];
    for (let i = 0; i < days.length; i++) {
      const off = startOffset + i; const kind = days[i]; const date = localOf(off);
      reports.push(await runEntertainmentLifecycleMonitor({
        instant: instantOf(off), runDb, sleep: async () => {}, legacyIdentity,
        getShowtimes: async (parkId) => {
          if (parkId !== PARK || kind === "provider_down") return mkPark(parkId, {}, { error: { kind: "timeout", message: "t" } }, date);
          const k = kind === "stale" || kind === "prev_day" ? "active" : kind;
          const extra: Partial<ParkEntertainmentShowtimes> = { legacyEntries: [mkEntry(PARK, LEGACY_NAME, k, [LEGACY_ID])] };
          if (kind === "stale") extra.stale = true;
          if (kind === "prev_day") extra.fetchedLocalDate = localOf(off - 1);
          return mkPark(parkId, {}, extra, date);
        },
      }));
    }
    return reports;
  }
  const stateOf = async (db: Queryable) => (await readStates(db, PARK)).get(legacyKey);
  const eventsOf = (db: FakeLifecycleDb, type: string) => [...db.events.values()].filter((e) => e.show_key === legacyKey && e.event_type === type);

  {
    const db = new FakeLifecycleDb();
    const runDb: LifecycleMonitorOptions["runDb"] = async (_p, fn) => fn(db);
    let reps = await drive(runDb, Array(6).fill("active"));
    check("monitor: 6 verified active days → no state row, no events", (await stateOf(db)) === undefined && eventsOf(db, "legacy_comeback").length === 0);
    check("monitor: 6 days of evidence are persisted for the legacy identity (same evidence table)", [...db.evidence.values()].filter((r) => r.show_key === legacyKey).length === 6);
    reps = await drive(runDb, ["active"], 6);
    let st = await stateOf(db);
    check("monitor: 7th verified day → legacy_comeback persisted, reported, audited", st?.status === "legacy_comeback" && st.restoreCount === 1 && !!st.restoredAt && reps[0]!.parks.find((p) => p.parkId === PARK)!.legacyComebacks.includes(LEGACY_NAME) && eventsOf(db, "legacy_comeback").length === 1);
    const ce = eventsOf(db, "legacy_comeback")[0];
    check("monitor: comeback event has evidence, coverage limitations and unreviewed status", ce.audit_status === "unreviewed" && (ce.evidence as { activeDays: number }).activeDays === 7 && (ce.coverage_limitations as string[]).length >= 3);
    check("monitor: the active-show lifecycle is untouched by the legacy run (no hide/restore/flag events for anything)", [...db.events.values()].every((e) => e.event_type === "legacy_comeback"));
    check("persisted state drives both pages end to end", await (async () => {
      resetLifecycleReadState();
      const v = await getLifecycleVisibilityState(PARK, { executor: { run: (fn) => fn(db), abort() {} } as PersistExecutor });
      return !!v && v.legacyComebacks.includes(LEGACY_NAME) && v.autoHidden.length === 0 && getLegacyComebackPlaces(PARK, v.legacyComebacks, LEGACY_FIXTURE).length === 1;
    })());
    check("legacy comebacks are never in the active hide set", !getLifecycleHiddenNames(PARK, (await getLifecycleAutoHidden(PARK, { executor: { run: (fn) => fn(db), abort() {} } as PersistExecutor })) ?? undefined).has(LEGACY_NAME));

    // idempotency / dedupe
    const evCount = db.events.size;
    await drive(runDb, ["active"], 6);
    check("audit idempotency: a duplicated delivery adds no event and keeps counters", db.events.size === evCount && (await stateOf(db))?.restoreCount === 1);
    await drive(runDb, ["active"], 7);
    check("audit idempotency: further active days while surfaced add no comeback event", eventsOf(db, "legacy_comeback").length === 1 && (await stateOf(db))?.status === "legacy_comeback");
    const newer = (await stateOf(db))!;
    await drive(runDb, ["inactive"], 3);
    check("late run for an EARLIER date never overwrites newer legacy state", (await stateOf(db))?.evaluatedLocalDate === newer.evaluatedLocalDate && (await stateOf(db))?.status === "legacy_comeback");

    // failures never transition
    const core = async () => { const x = (await stateOf(db))!; return JSON.stringify([x.status, x.restoreCount, x.hideCount, x.hiddenLocalDate, x.cycleResetDate, x.lastActiveDate, x.restoredAt]); };
    const before = await core();
    const evBefore = db.events.size;
    reps = await drive(runDb, ["provider_down", "stale", "prev_day", "provider_down"], 8);
    check("failures: outage / stale / previous-day payloads change no legacy state and emit nothing", (await core()) === before && db.events.size === evBefore);
    check("failures: stale and previous-day payloads write no evidence for the legacy show", ![...db.evidence.values()].some((r) => r.show_key === legacyKey && ((r.d as string) === localOf(9) || (r.d as string) === localOf(10))));
    await drive(runDb, Array(40).fill("provider_down"), 12);
    check("failures: a long outage never re-hides (elapsed time and unknown days never count)", (await stateOf(db))?.status === "legacy_comeback");

    // re-hide: 21 distinct final inactive days after the last active (offset 7), cycle reset at 7
    await drive(runDb, Array(20).fill("inactive"), 52); // far later days; window rolls
    st = await stateOf(db);
    check("re-hide: 20 inactive days → still surfaced", st?.status === "legacy_comeback");
    reps = await drive(runDb, ["inactive"], 72);
    st = await stateOf(db);
    check("re-hide: 21st inactive day → legacy_hidden, audited once", st?.status === "legacy_hidden" && st.hideCount === 1 && st.hiddenLocalDate === localOf(72) && eventsOf(db, "legacy_rehide").length === 1 && reps[0]!.parks.find((p) => p.parkId === PARK)!.legacyRehidden.includes(LEGACY_NAME));
    check("re-hide: legacy comebacks list no longer includes it", await (async () => { resetLifecycleReadState(); const v = await getLifecycleVisibilityState(PARK, { executor: { run: (fn) => fn(db), abort() {} } as PersistExecutor }); return !!v && !v.legacyComebacks.includes(LEGACY_NAME); })());
    await drive(runDb, ["inactive"], 72);
    check("re-hide: duplicate delivery adds no second event", eventsOf(db, "legacy_rehide").length === 1);
    await drive(runDb, Array(6).fill("active"), 73);
    check("re-comeback: 6 active days → still hidden", (await stateOf(db))?.status === "legacy_hidden");
    await drive(runDb, ["active"], 79);
    st = await stateOf(db);
    check("re-comeback: 7 active days after the re-hide → second cycle (comeback #2, separate audit event)", st?.status === "legacy_comeback" && st.restoreCount === 2 && eventsOf(db, "legacy_comeback").length === 2);
  }

  // provisional negatives (earlier than the day-end window) never re-hide
  {
    const db = new FakeLifecycleDb();
    const runDb: LifecycleMonitorOptions["runDb"] = async (_p, fn) => fn(db);
    await drive(runDb, Array(7).fill("active"));
    const midday = (off: number) => new Date(`${localOf(off)}T20:00:00Z`); // 12:00 PST: before the day-end window
    await drive(runDb, Array(25).fill("inactive"), 7, midday);
    check("day boundary: 25 mid-day (provisional) inactive observations never re-hide", (await stateOf(db))?.status === "legacy_comeback");
    check("day boundary: provisional rows are stored non-final", [...db.evidence.values()].filter((r) => r.show_key === legacyKey && r.d !== localOf(0) && (r.d as string) > localOf(6)).every((r) => r.is_final === false));
  }

  // identity ambiguity / shipped registry: the monitor never evaluates or writes legacy rows
  {
    const db = new FakeLifecycleDb();
    const runDb: LifecycleMonitorOptions["runDb"] = async (_p, fn) => fn(db);
    await drive(runDb, Array(10).fill("active"), 0, instantFor, {}); // shipped (unmapped) registry
    check("identity: with the shipped registry (no verified identity) 10 performing days write no legacy rows", [...db.evidence.values()].every((r) => r.show_key !== legacyKey) && db.states.size === [...db.states.values()].filter((r) => r.show_key !== legacyKey).length);
    const amb = fixtureLegacy(legacyMapped(LEGACY_NAME, "disneyland", activeId));
    await drive(runDb, Array(10).fill("active"), 0, instantFor, amb);
    check("identity: an ambiguous (active-shared) provider id never produces rows or a comeback", [...db.evidence.values()].every((r) => r.show_key !== legacyKey) && ![...db.events.values()].some((e) => e.event_type === "legacy_comeback"));
    await drive(runDb, Array(7).fill("active"), 0, instantFor, LEGACY_FIXTURE);
    check("identity: the same evidence qualifies once the identity is established", (await stateOf(db))?.status === "legacy_comeback");
    // identity later withdrawn: the page validation stops surfacing it even though a state row remains
    check("identity: if the identity is later no longer established, the shared page logic stops surfacing the persisted comeback", getLegacyComebackPlaces(PARK, [LEGACY_NAME], {}).length === 0);
  }

  // DB failure leaves state untouched
  {
    const db = new FakeLifecycleDb();
    const runDb: LifecycleMonitorOptions["runDb"] = async (_p, fn) => fn(db);
    await drive(runDb, Array(7).fill("active"));
    db.failAll = true;
    const reps = await drive(runDb, ["inactive"], 7);
    db.failAll = false;
    check("failures: a database outage reports db_unavailable and changes nothing", reps[0]!.parks.find((p) => p.parkId === PARK)!.status === "db_unavailable" && (await stateOf(db))?.status === "legacy_comeback");
  }
  return failures;
}

// ============================================
// PHASE 14.5D FOLLOW-UP — AUTOMATIC LEGACY IDENTITY DISCOVERY
// ============================================

const DL_UUID = THEMEPARKS_PARKS.disneyland.entityId;
const DCA_UUID = THEMEPARKS_PARKS.dca.entityId;
const LID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const LID2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const LID3 = "cccccccc-3333-4333-8333-cccccccccccc";
type LiveRow = { entityId: string; name: string; entityType: string; parkId: string | null };
const lr = (entityId: string, name: string, entityType = "SHOW", parkId: string | null = null): LiveRow => ({ entityId, name, entityType, parkId });
const disc = (parkId: ParkId, live: LiveRow[], existing: DiscoveredLegacyIdentity[] = [], manual?: EntertainmentProviderMapping[]) =>
  discoverLegacyProviderIdentities({ parkId, parkUuid: parkId === "dca" ? DCA_UUID : DL_UUID, live, existing, manual });
const dId = (entityId: string, name = LEGACY_NAME, parkId: ParkId = "disneyland"): DiscoveredLegacyIdentity => ({ parkId, name, entityId, providerName: name });

export async function runDevLegacyIdentityDiscoveryCases(): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const kinds = (r: ReturnType<typeof disc>) => r.flags.map((f) => f.kind).join(",");

  // ---------- pure discovery ----------
  let r = disc("disneyland", [lr(LID, LEGACY_NAME)]);
  check("discovery: exact canonical name + park + SHOW → validated identity, discovered flag", r.identities.length === 1 && r.identities[0].entityId === LID && r.identities[0].name === LEGACY_NAME && kinds(r) === "identity_discovered");
  r = disc("disneyland", [lr(LID, "Together Forever")]);
  check("discovery: approved legacy alias resolves to the canonical legacy show (canonical name kept)", r.identities.length === 1 && r.identities[0].name === LEGACY_NAME);
  r = disc("disneyland", [lr(LID, "Pixar Nighttime Magic"), lr(LID2, "Together Forever Spectacular")]);
  check("discovery: no fuzzy/partial/unapproved-name matching", r.identities.length === 0 && r.flags.length === 0);
  r = disc("disneyland", [lr(LID, MMM), lr(LID2, "Fantasmic!")]);
  check("discovery: active catalog identities are never discovered as legacy", r.identities.length === 0 && r.flags.length === 0);
  r = disc("disneyland", [lr(LID, LEGACY_NAME, "ATTRACTION")]);
  check("discovery: wrong provider type → flagged, never an identity", r.identities.length === 0 && kinds(r) === "identity_candidate" && /wrong_type/.test(String(r.flags[0].evidence.candidates && (r.flags[0].evidence.candidates as Array<{ rejected: string }>)[0].rejected)));
  r = disc("disneyland", [lr(LID, LEGACY_NAME_DCA)]);
  check("discovery: a legacy show of ANOTHER park in this park's payload → wrong_park flag, no identity", r.identities.length === 0 && kinds(r) === "identity_candidate");
  r = disc("dca", [lr(LID, LEGACY_NAME)]);
  check("discovery: cross-park (Disneyland legacy name in DCA payload) rejected", r.identities.length === 0 && kinds(r) === "identity_candidate");
  r = disc("disneyland", [lr(LID, LEGACY_NAME, "SHOW", DCA_UUID)]);
  check("discovery: entity owned by a different provider park rejected", r.identities.length === 0 && kinds(r) === "identity_candidate");
  r = disc("disneyland", [lr(LID.toUpperCase(), LEGACY_NAME), lr("not-a-uuid", "Together Forever")]);
  check("discovery: malformed ids rejected and flagged", r.identities.length === 0 && r.flags.length === 1 && r.flags[0].kind === "identity_candidate");
  r = disc("disneyland", [lr(LID, LEGACY_NAME), lr(LID2, LEGACY_NAME)]);
  check("discovery: duplicate candidates for one legacy show → ambiguous, nothing persisted", r.identities.length === 0 && kinds(r) === "identity_candidate" && /duplicate/.test(String(r.flags[0].evidence.reason)));
  r = disc("disneyland", [lr(LID, LEGACY_NAME), lr(LID2, "Together Forever", "ATTRACTION")]);
  check("discovery: a clean candidate plus a rejected look-alike is still ambiguous", r.identities.length === 0 && kinds(r) === "identity_candidate");
  const activeEntity = (THEMEPARKS_ENTERTAINMENT_MAPPING.find((m) => m.disposition === "mapped") as Extract<EntertainmentProviderMapping, { disposition: "mapped" }>).provider[0].entityId;
  r = disc("disneyland", [lr(activeEntity, LEGACY_NAME)]);
  check("discovery: an entity already mapped to an ACTIVE show is a conflict", r.identities.length === 0 && kinds(r) === "identity_candidate");
  r = disc("disneyland", [lr(LID, LEGACY_NAME)], [dId(LID, LEGACY_NAME_DCA, "dca")]);
  check("discovery: an entity already the persisted identity of another show is a conflict", r.identities.length === 0 && kinds(r) === "identity_candidate");
  r = disc("disneyland", [lr(LID, LEGACY_NAME)], [], [legacyMapped(LEGACY_NAME_DCA, "dca", LID)]);
  check("discovery: an entity manually mapped to another legacy show is a conflict", r.identities.length === 0 && kinds(r) === "identity_candidate");
  r = disc("disneyland", [lr(LID2, LEGACY_NAME)], [], [legacyMapped(LEGACY_NAME, "disneyland", LID)]);
  check("discovery: a manual `mapped` entry is authoritative (discovery skips that show, no flag)", r.identities.length === 0 && r.flags.length === 0);
  r = disc("disneyland", [lr(LID, LEGACY_NAME)], [dId(LID)]);
  check("discovery: an already-persisted identity is unchanged (idempotent: nothing to write or flag)", r.identities.length === 0 && r.flags.length === 0 && r.superseded.length === 0);
  r = disc("disneyland", [lr(LID2, LEGACY_NAME)], [dId(LID)]);
  check("UUID change: old entity gone + one clean new entity → supersede + audit flag (never silent)", r.identities[0]?.entityId === LID2 && r.superseded[0]?.entityId === LID && kinds(r) === "identity_change");
  r = disc("disneyland", [lr(LID, LEGACY_NAME), lr(LID2, LEGACY_NAME)], [dId(LID)]);
  check("UUID change: while the validated entity is still published, a second candidate is a conflict (no merge)", r.identities.length === 0 && r.superseded.length === 0 && kinds(r) === "identity_candidate");
  r = disc("disneyland", [lr(LID, "Renamed Provider Show"), lr(LID2, LEGACY_NAME)], [dId(LID)]);
  check("UUID change: the validated entity is still published (renamed) while a new one matches → conflict, no supersede", r.identities.length === 0 && r.superseded.length === 0 && kinds(r) === "identity_candidate" && /still published/.test(String(r.flags[0].evidence.reason)));
  r = disc("disneyland", [lr(LID2, LEGACY_NAME), lr(LID3, LEGACY_NAME)], [dId(LID)]);
  check("UUID change: two new candidates after the old one vanished → ambiguous, old identity kept", r.identities.length === 0 && r.superseded.length === 0 && kinds(r) === "identity_candidate");

  // ---------- merge (effective registry) ----------
  const merged = (ids: DiscoveredLegacyIdentity[], manual?: EntertainmentProviderMapping[]) => mergeDiscoveredLegacyIdentities(ids, manual);
  check("merge: a discovered identity establishes the legacy show (no manual update)", isLegacyIdentityEstablished("disneyland", LEGACY_NAME, merged([dId(LID)])) && !isLegacyIdentityEstablished("dca", LEGACY_NAME_DCA, merged([dId(LID)])));
  check("merge: no discovered identities → the manual registry object itself", merged([]) === LEGACY_ENTERTAINMENT_PROVIDER_MAPPING && mergeDiscoveredLegacyIdentities(undefined) === LEGACY_ENTERTAINMENT_PROVIDER_MAPPING);
  check("merge: manual `mapped` stays authoritative over a discovered id", (() => { const m = merged([dId(LID2)], [legacyMapped(LEGACY_NAME, "disneyland", LID), { dwpName: LEGACY_NAME_DCA, parkId: "dca", disposition: "unmapped", reason: "x" }]); const e = m.find((x) => x.dwpName === LEGACY_NAME)!; return e.disposition === "mapped" && e.provider[0].entityId === LID; })());
  check("merge: discovered id shared with an ACTIVE mapping is dropped", !isLegacyIdentityEstablished("disneyland", LEGACY_NAME, merged([dId(activeEntity)])));
  check("merge: two discovered identities sharing one id are both dropped", (() => { const m = merged([dId(LID), dId(LID, LEGACY_NAME_DCA, "dca")]); return !isLegacyIdentityEstablished("disneyland", LEGACY_NAME, m) && !isLegacyIdentityEstablished("dca", LEGACY_NAME_DCA, m); })());
  check("merge: identities for non-legacy names / malformed ids are ignored", !isLegacyIdentityEstablished("disneyland", MMM, merged([dId(LID, MMM)])) && !isLegacyIdentityEstablished("disneyland", LEGACY_NAME, merged([dId("BAD-ID")])));

  // ---------- monitor over the in-memory SQL stand-in ----------
  const PARK: ParkId = "disneyland";
  const localOf = (off: number) => addDaysToLocalDate(MONITOR_DAY0, off)!;
  type Cand = { id: string; name?: string; type?: string; status?: string; perf?: boolean; parkId?: string | null };
  type Kind = "perf" | "closed" | "absent" | "down" | "stale";
  type World = { cands: Cand[]; fillers?: number; dropped?: number };
  const worldOf = (kind: Kind, id = LID): World => ({ cands: kind === "absent" ? [] : [{ id, name: LEGACY_NAME, perf: kind === "perf" || kind === "stale", status: kind === "closed" ? "CLOSED" : "OPERATING" }] });
  const mkLive = (date: string, w: World): ThemeParksLive => ({
    entityId: DL_UUID, name: "Disneyland Park", timeZone: "America/Los_Angeles", droppedEntries: w.dropped ?? 0, droppedShowtimes: 0,
    entries: [
      ...Array.from({ length: w.fillers ?? 3 }, (_, i) => ({ entityId: `f0f0f0f0-0000-4000-8000-00000000000${i}`, name: `Provider Filler ${i}`, entityType: "SHOW", parkId: null, externalId: null, status: "OPERATING", lastUpdated: null, droppedShowtimes: 0, showtimes: [{ type: "Performance Time", startTime: `${date}T20:30:00-08:00`, endTime: null }] })),
      ...w.cands.map((c) => ({ entityId: c.id, name: c.name ?? LEGACY_NAME, entityType: c.type ?? "SHOW", parkId: c.parkId ?? null, externalId: null, status: c.status ?? "OPERATING", lastUpdated: null, droppedShowtimes: 0, showtimes: c.perf ? [{ type: "Performance Time", startTime: `${date}T19:30:00-08:00`, endTime: null }] : [] })),
    ],
  });
  async function drive(runDb: LifecycleMonitorOptions["runDb"], days: Array<Kind | World>, start = 0, legacyIdentity?: LegacyIdentityOptions) {
    const reps = [];
    for (let i = 0; i < days.length; i++) {
      const off = start + i; const day = days[i]; const kind = typeof day === "string" ? day : "perf"; const date = localOf(off);
      const world = typeof day === "string" ? worldOf(day) : day;
      reps.push(await runEntertainmentLifecycleMonitor({
        instant: instantFor(off), runDb, sleep: async () => {}, legacyIdentity,
        getShowtimes: async (parkId, instant, _h, captureLive) => {
          if (parkId !== PARK || kind === "down") return mkPark(parkId, {}, { error: { kind: "timeout", message: "t" } }, date);
          const origin = typeof day === "string" && day === "stale" ? "stale" as const : "network" as const;
          const res = { ok: true as const, data: mkLive(date, world), meta: { origin, fetchedAt: instant.getTime(), etag: null } };
          captureLive?.(res);
          return normalizeParkEntertainmentShowtimes(PARK, res, instant);
        },
      }));
    }
    return reps;
  }
  const lKey = legacyKey;
  const stateOf = async (db: Queryable) => (await readStates(db, PARK)).get(lKey);
  const ids = (db: FakeLifecycleDb, status = "validated") => [...db.identities.values()].filter((x) => x.status === status);
  const evs = (db: FakeLifecycleDb, type: string) => [...db.events.values()].filter((e) => e.event_type === type);
  const ex = (db: FakeLifecycleDb) => ({ run: (fn: (q: Queryable) => Promise<unknown>) => fn(db), abort() {} }) as unknown as PersistExecutor;

  {
    const db = new FakeLifecycleDb();
    const runDb: LifecycleMonitorOptions["runDb"] = async (_p, fn) => fn(db);
    const reps = await drive(runDb, ["perf"]);
    check("monitor: shipped registry is unmapped, yet the provider-published show is discovered and persisted (no manual update)", ids(db).length === 1 && ids(db)[0].entity_id === LID && ids(db)[0].show_key === lKey && reps[0]!.parks.find((p) => p.parkId === PARK)!.legacyIdentitiesDiscovered.includes(LEGACY_NAME));
    check("monitor: discovery writes an unreviewed audit event with evidence + limitations", (() => { const e = evs(db, "legacy_identity_discovered")[0]; return !!e && e.audit_status === "unreviewed" && (e.evidence as { entityId: string }).entityId === LID && (e.coverage_limitations as string[]).length >= 3; })());
    check("monitor: the discovered identity is observed the same run (active evidence row)", [...db.evidence.values()].some((x) => x.show_key === lKey && x.day_class === "active"));
    check("monitor: an identity alone never surfaces anything (no comeback state/event after 1 day)", (await stateOf(db)) === undefined && evs(db, "legacy_comeback").length === 0);
    await drive(runDb, Array(5).fill("perf"), 1);
    check("qualification: 6 verified days → not surfaced", (await stateOf(db)) === undefined);
    // restart: fresh monitor invocation + fresh read cache over the same persisted rows
    resetLifecycleReadState();
    const vs0 = await getLifecycleVisibilityState(PARK, { executor: ex(db) });
    check("persistence/restart: identity survives and is served to the pages; no comeback yet", !!vs0 && vs0.legacyIdentities.length === 1 && vs0.legacyIdentities[0].entityId === LID && vs0.legacyComebacks.length === 0);
    await drive(runDb, ["perf"], 6);
    const st = await stateOf(db);
    check("qualification: 7th verified day (restart, no manual mapping) → legacy_comeback persisted and audited once", st?.status === "legacy_comeback" && st.restoreCount === 1 && evs(db, "legacy_comeback").length === 1);
    resetLifecycleReadState();
    const vs = await getLifecycleVisibilityState(PARK, { executor: ex(db) });
    check("pages: persisted comeback + persisted identity surface the show through the shared helpers (both pages)", !!vs && getLegacyComebackPlaces(PARK, vs.legacyComebacks, legacyIdentityOptions(vs.legacyIdentities)).map((p) => p.name).join() === LEGACY_NAME);
    check("pages: without the identity (unknown/older body) a comeback name surfaces nothing (fail open)", getLegacyComebackPlaces(PARK, vs!.legacyComebacks, legacyIdentityOptions(undefined)).length === 0);
    // the same persisted identity drives both page data builders
    const instant = instantFor(6);
    const res = { ok: true as const, data: mkLive(localOf(6), worldOf("perf")), meta: { origin: "network" as const, fetchedAt: instant.getTime(), etag: null } };
    const effective = mergeDiscoveredLegacyIdentities(vs!.legacyIdentities);
    const stp = normalizeParkEntertainmentShowtimes(PARK, res, instant, null, effective);
    const all = buildParkAllEntertainment(PARK, res, instant, null, effective);
    check("Waits & Shows data: the discovered identity yields a legacy entry (and none without it)", stp.legacyEntries?.length === 1 && stp.legacyEntries[0].performances.length === 1 && normalizeParkEntertainmentShowtimes(PARK, res, instant).legacyEntries === undefined);
    check("All Entertainment data: legacy entry listed once; the discovered entity is not provider-only; without identity it is provider-only",
      all.legacyEntries?.length === 1 && !all.entries.some((e) => e.id === `provider:${LID}`) &&
      mergeLegacyComebackEntries(all.entries, all.legacyEntries, PARK, vs!.legacyComebacks, legacyIdentityOptions(vs!.legacyIdentities)).filter((e) => e.name === LEGACY_NAME).length === 1 &&
      buildParkAllEntertainment(PARK, res, instant).entries.some((e) => e.id === `provider:${LID}`));

    // idempotency
    const evN = db.events.size, idN = db.identities.size;
    await drive(runDb, ["perf"], 6);
    check("idempotency: a duplicated delivery adds no identity row and no audit event", db.events.size === evN && db.identities.size === idN);

    // outage / stale / dropped / weak coverage: no transition and no new identity
    const core = async () => { const x = (await stateOf(db))!; return JSON.stringify([x.status, x.restoreCount, x.hideCount, x.cycleResetDate, x.lastActiveDate]); };
    const before = await core();
    await drive(runDb, ["down", "stale", "down"], 7);
    check("outage: provider failure / stale payload change nothing (identity, state, events)", (await core()) === before && ids(db).length === 1 && db.events.size === evN);
    check("outage: long outage never re-hides", (await drive(runDb, Array(35).fill("down"), 10), (await stateOf(db))?.status === "legacy_comeback"));

    // UUID change while surfaced: history kept, audited, no silent merge of two live entities
    await drive(runDb, [{ cands: [{ id: LID, name: LEGACY_NAME, perf: true }, { id: LID2, name: LEGACY_NAME, perf: true }] }], 45);
    check("UUID change: two live matches with the validated one still published → conflict flagged, identity unchanged", ids(db).length === 1 && ids(db)[0].entity_id === LID && evs(db, "legacy_identity_candidate").length === 1 && evs(db, "legacy_identity_change").length === 0);
    await drive(runDb, [{ cands: [{ id: LID, name: LEGACY_NAME, perf: true }, { id: LID2, name: LEGACY_NAME, perf: true }] }], 46);
    check("audit dedupe: a standing conflict is flagged once, not every run", evs(db, "legacy_identity_candidate").length === 1);
    const evidenceBefore = [...db.evidence.values()].filter((x) => x.show_key === lKey).length;
    await drive(runDb, [{ cands: [{ id: LID2, name: LEGACY_NAME, perf: true }] }], 47);
    check("UUID change: old entity gone + one clean new entity → old superseded, new validated, change audited", ids(db).length === 1 && ids(db)[0].entity_id === LID2 && ids(db, "superseded").length === 1 && ids(db, "superseded")[0].entity_id === LID && evs(db, "legacy_identity_change").length === 1);
    check("UUID change: valid history is kept under the same canonical show (evidence not lost, new day tracked via the new entity)", [...db.evidence.values()].filter((x) => x.show_key === lKey).length >= evidenceBefore && [...db.evidence.values()].some((x) => x.show_key === lKey && x.d === localOf(47) && x.day_class === "active"));
    check("UUID change: surfaced state is not reset or duplicated", (await stateOf(db))?.status === "legacy_comeback" && (await stateOf(db))?.restoreCount === 1 && evs(db, "legacy_comeback").length === 1);

    // A → B → A: the superseded original returns and is reactivated (review finding), history/state intact
    await drive(runDb, [{ cands: [{ id: LID, name: LEGACY_NAME, perf: true }] }], 48);
    check("UUID return: the superseded UUID is reactivated as the single validated identity (row reused, replacement superseded)", ids(db).length === 1 && ids(db)[0].entity_id === LID && ids(db, "superseded").length === 1 && ids(db, "superseded")[0].entity_id === LID2 && db.identities.size === 2 && evs(db, "legacy_identity_change").length === 2);
    check("UUID return: the show keeps being observed and stays surfaced", [...db.evidence.values()].some((x) => x.show_key === lKey && x.d === localOf(48) && x.day_class === "active") && (await stateOf(db))?.status === "legacy_comeback");
    await drive(runDb, [{ cands: [{ id: LID, name: LEGACY_NAME, perf: true }] }], 48);
    check("UUID return: duplicate delivery is idempotent", ids(db).length === 1 && db.identities.size === 2 && evs(db, "legacy_identity_change").length === 2);
    await drive(runDb, [{ cands: [{ id: LID2, name: LEGACY_NAME, perf: true }] }], 49);
    check("UUID flip-flop: B returns again and is reactivated too (no dead end in either direction)", ids(db).length === 1 && ids(db)[0].entity_id === LID2 && db.identities.size === 2);
    // re-hide (21-of-30, final silent days with identity established) and re-comeback, all with the persisted identity
    await drive(runDb, Array(20).fill("absent"), 50);
    check("re-hide: 20 final absent days → still surfaced", (await stateOf(db))?.status === "legacy_comeback");
    await drive(runDb, ["absent"], 70);
    check("re-hide: 21st day → legacy_hidden, audited once; identity retained", (await stateOf(db))?.status === "legacy_hidden" && evs(db, "legacy_rehide").length === 1 && ids(db).length === 1);
    await drive(runDb, Array(6).fill({ cands: [{ id: LID2, perf: true }] } as World), 71);
    check("re-comeback: 6 days → hidden", (await stateOf(db))?.status === "legacy_hidden");
    await drive(runDb, [{ cands: [{ id: LID2, perf: true }] }], 77);
    check("re-comeback: 7th day → second cycle via the same persisted identity", (await stateOf(db))?.status === "legacy_comeback" && (await stateOf(db))?.restoreCount === 2 && ids(db).length === 1);
  }

  // discovery requires a fresh, healthy, complete payload
  {
    const db = new FakeLifecycleDb();
    const runDb: LifecycleMonitorOptions["runDb"] = async (_p, fn) => fn(db);
    await drive(runDb, [{ cands: [{ id: LID }], fillers: 3, dropped: 1 }]);
    check("discovery: a payload with discarded (malformed) entities never discovers", ids(db).length === 0);
    await drive(runDb, [{ cands: [{ id: LID }], fillers: 0 }], 1);
    check("discovery: weak park coverage never discovers", ids(db).length === 0);
    await drive(runDb, ["stale"], 2);
    check("discovery: stale-if-error payload never discovers", ids(db).length === 0);
    await drive(runDb, ["down"], 3);
    check("discovery: provider outage never discovers", ids(db).length === 0);
    await drive(runDb, [{ cands: [{ id: LID, type: "ATTRACTION" }] }, { cands: [{ id: LID, type: "ATTRACTION" }] }], 4);
    check("discovery: wrong-type candidate is flagged once (deduped across runs), never persisted, never observed", ids(db).length === 0 && evs(db, "legacy_identity_candidate").length === 1 && ![...db.evidence.values()].some((x) => x.show_key === lKey));
    await drive(runDb, [{ cands: [{ id: LID, name: LEGACY_NAME }, { id: LID2, name: "Together Forever" }] }], 6);
    check("discovery: duplicate candidates flagged, never persisted or surfaced", ids(db).length === 0 && evs(db, "legacy_identity_candidate").length === 2);
    await drive(runDb, Array(10).fill({ cands: [{ id: LID }, { id: LID2, name: "Together Forever" }], fillers: 3 } as World), 7);
    check("discovery: an ambiguous show can never come back, however many performances", (await stateOf(db)) === undefined);
  }

  // manual mapping is authoritative in the monitor
  {
    const db = new FakeLifecycleDb();
    const runDb: LifecycleMonitorOptions["runDb"] = async (_p, fn) => fn(db);
    await drive(runDb, [{ cands: [{ id: LID2, perf: true }] }], 0, LEGACY_FIXTURE); // fixture manual id = LEGACY_ID, provider offers LID2
    check("manual mapping: authoritative — a different provider entity is neither discovered nor flagged", ids(db).length === 0 && evs(db, "legacy_identity_candidate").length === 0 && ![...db.evidence.values()].some((x) => x.show_key === lKey && x.day_class === "active"));
    await drive(runDb, [{ cands: [{ id: LEGACY_ID, perf: true }] }], 1, LEGACY_FIXTURE);
    check("manual mapping: the manual id is observed as before", [...db.evidence.values()].some((x) => x.show_key === lKey && x.day_class === "active"));
  }

  // identity table not migrated: active lifecycle unaffected, legacy manual-only
  {
    const db = new FakeLifecycleDb();
    db.failIdentitySql = true;
    const runDb: LifecycleMonitorOptions["runDb"] = async (_p, fn) => fn(db);
    const reps = await drive(runDb, ["perf"]);
    check("failure: identity persistence unavailable → park still ok, active shows still evaluated, nothing discovered", reps[0]!.parks.find((p) => p.parkId === PARK)!.status === "ok" && db.identities.size === 0 && [...db.evidence.values()].some((x) => x.park_id === PARK && x.show_key !== lKey));
    resetLifecycleReadState();
    check("failure: identity read failure leaves the lifecycle visibility state readable (fail open)", await (async () => { await drive(runDb, Array(1).fill("perf"), 1); const v = await getLifecycleVisibilityState(PARK, { executor: ex(db) }); return !!v && v.legacyIdentities.length === 0; })());
  }
  return failures;
}

/**
 * entertainmentLifecycleMonitor.ts — Phase 14.5C scheduled lifecycle monitor.
 * Server-only. Driven by Vercel Cron via /api/cron/entertainment-lifecycle
 * (03:30 UTC daily), independent of page traffic.
 *
 * Per run, for each of the six parks (the single maintained park list):
 *  1. FETCH (all parks concurrently, per-park deadline): the SAME showtimes
 *     service the pages use (`getParkEntertainmentShowtimes`), so provider
 *     caching, the 14.4.1/14.4.2 evidence rules and the history budgets/rate
 *     limits are reused verbatim — no new provider client, no extra requests
 *     beyond the (cached) live call and, only when a candidate exists, the
 *     park-level history call the service already makes.
 *  2. OBSERVE (pure): eligible mapped shows → per-show day class
 *     (entertainmentLifecycleDetector.observeParkDay). A failed/stale/unhealthy
 *     provider yields NO negative evidence; a failed park is skipped entirely.
 *  3. PERSIST + EVALUATE (parks sequentially, one transaction each, under a
 *     per-park advisory lock): upsert observations, re-read the stored window,
 *     evaluate every eligible show, write state + audit events. Idempotent: a
 *     repeated delivery changes nothing.
 *  4. SECONDARY evaluation (only for shows whose provider silence reached the
 *     threshold): validated ThemeParks history (shared client cache/budget; one
 *     park-level request at most, reused if step 1 already fetched it) backfills
 *     per-day dark/performed observations, then the same evaluation re-runs.
 *
 * Fail open for NEW hiding: any provider/DB failure leaves state untouched
 * (no hide is ever produced from missing data); reviewed registry decisions are
 * never edited. The monitor never touches the registry JSON, the catalogs, the
 * legacy catalog, Smart Entry, My Plans or sync.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { ENTERTAINMENT_LIFECYCLE_REGISTRY, type EntertainmentLifecycleRegistry } from "./entertainmentLifecycleRegistry";
import {
  EMPTY_LIFECYCLE_STATE,
  LIFECYCLE_RETENTION_DAYS,
  evaluateShowLifecycle,
  historyBackfillObservations,
  isDayEndWindow,
  isLifecycleEligiblePlace,
  observeParkDay,
  registryHideKind,
  type ShowDayObservation,
} from "./entertainmentLifecycleDetector";
import {
  insertEvent,
  pruneEvidence,
  readEvidence,
  readStates,
  tryLifecycleLock,
  upsertObservations,
  writeState,
  type StoredLifecycleState,
} from "./entertainmentLifecycleStore";
import { buildParkHistoryEvidence } from "./entertainmentHistory";
import { fetchParkHistoryWithin, type GetHistory, type GetHistoryAccess } from "./entertainmentHistoryService";
import type { ParkEntertainmentShowtimes } from "./entertainmentShowtimes";
import { getParkEntertainmentShowtimes } from "./entertainmentShowtimesService";
import { ENTERTAINMENT_PLACES } from "./entertainmentSuggestions";
import { getParkHoursPool } from "./db";
import { PARK_LABELS, PARK_TO_RESORT } from "./parkMetadata";
import { createPoolExecutor, type Queryable } from "./parkHoursStore";
import { addDaysToLocalDate } from "./resortTime";
import { entertainmentMappingKey, getThemeParksEntertainmentRefs } from "./themeParksEntertainmentMapping";
import type { ThemeParksHistoryDaily, ThemeParksResult } from "./themeParksApi";

/** Every supported park — derived from the single maintained park list. */
export const LIFECYCLE_PARK_IDS = Object.keys(PARK_LABELS) as ParkId[];

export const LIFECYCLE_PROVIDER_DEADLINE_MS = 20_000;
export const LIFECYCLE_HISTORY_DEADLINE_MS = 8_000;
export const LIFECYCLE_BUDGET_MS = 45_000;
const DB_ATTEMPTS = 3;
const DB_RETRY_PAUSE_MS = 400;

export type ParkLifecycleStatus = "ok" | "provider_unavailable" | "db_unavailable" | "busy" | "skipped_deadline";

export interface ParkLifecycleResult {
  parkId: ParkId;
  status: ParkLifecycleStatus;
  observed: number;
  classes: { active: number; inactive: number; dormant: number; silent: number; unknown: number };
  hidden: string[];
  restored: string[];
  silenceFlagged: string[];
  registryConflicts: string[];
  registryRestored: string[];
  /** Observations were made in the resort-local end-of-day window (negatives are final and count). */
  dayEnd: boolean;
  secondary: "none" | "done" | "history_unavailable";
}

export interface LifecycleMonitorReport {
  ok: boolean;
  startedAt: string;
  durationMs: number;
  parks: ParkLifecycleResult[];
  counts: { total: number; ok: number; failed: number };
}

type RunDb = <T>(parkId: ParkId, fn: (q: Queryable) => Promise<T>) => Promise<T>;

export interface LifecycleMonitorOptions {
  instant?: Date;
  budgetMs?: number;
  providerDeadlineMs?: number;
  /** Test seams. */
  getShowtimes?: (parkId: ParkId, instant: Date, captureHistory: GetHistory | undefined) => Promise<ParkEntertainmentShowtimes>;
  getHistory?: GetHistory;
  getHistoryAccess?: GetHistoryAccess;
  /** Registry used for reviewed hide decisions (default: the shipped registry). */
  registry?: EntertainmentLifecycleRegistry;
  runDb?: RunDb;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface ApplyResult { hidden: string[]; restored: string[]; silenceFlagged: string[]; registryConflicts: string[]; registryRestored: string[]; needsSecondary: Array<{ showKey: string; showName: string }> }

/**
 * One locked transaction body: persist observations, evaluate every eligible
 * show of the park from the stored window, write state + audit events.
 * `markSecondary` = shows whose history backfill was just applied (their
 * `secondary_evaluated_on` is set so it is not requested twice in a day).
 */
async function evaluateAndPersist(
  q: Queryable,
  parkId: ParkId,
  today: string,
  now: Date,
  observations: ShowDayObservation[],
  markSecondary: ReadonlySet<string>,
  registry: EntertainmentLifecycleRegistry,
): Promise<ApplyResult> {
  const res: ApplyResult = { hidden: [], restored: [], silenceFlagged: [], registryConflicts: [], registryRestored: [], needsSecondary: [] };
  await upsertObservations(q, observations);
  const rows = await readEvidence(q, parkId, addDaysToLocalDate(today, -(LIFECYCLE_RETENTION_DAYS - 1)) ?? today, today);
  const states = await readStates(q, parkId);
  const byShow = new Map<string, typeof rows>();
  for (const r of rows) byShow.set(r.showKey, [...(byShow.get(r.showKey) ?? []), r]);
  const nowIso = now.toISOString();

  for (const place of ENTERTAINMENT_PLACES) {
    if (place.parkId !== parkId || !isLifecycleEligiblePlace(place)) continue;
    const showKey = entertainmentMappingKey(parkId, place.name);
    const obs = byShow.get(showKey) ?? [];
    const prev = states.get(showKey) ?? null;
    if (obs.length === 0 && !prev) continue; // nothing observed, nothing stored
    const ev = evaluateShowLifecycle({
      today,
      observations: obs,
      state: prev ? { ...EMPTY_LIFECYCLE_STATE, ...prev } : null,
      eligible: true,
      registryHide: registryHideKind(parkId, place.name, registry),
    });
    const s = ev.state;
    const hasType = (t: string) => ev.events.some((e) => e.type === t);
    const next: StoredLifecycleState = {
      ...s,
      showKey, showName: place.name,
      hiddenAt: hasType("auto_hide") ? nowIso : prev?.hiddenAt ?? null,
      restoredAt: hasType("auto_restore") ? nowIso : prev?.restoredAt ?? null,
      registryRestoredAt: s.registryRestored ? prev?.registryRestoredAt ?? nowIso : null,
      silenceFlaggedAt: !s.silenceFlagged ? null : hasType("silence_flag") ? nowIso : prev?.silenceFlaggedAt ?? nowIso,
      secondaryEvaluatedOn: markSecondary.has(showKey) && s.silenceFlagged ? today : s.secondaryEvaluatedOn,
      inactiveDays: ev.inactiveDays,
      dormantDays: ev.dormantDays,
      silentDays: ev.silentDays,
      evaluatedLocalDate: today,
    };
    const wrote = await writeState(q, parkId, next);
    if (!wrote) continue; // a newer evaluation already exists: this (late) run changes nothing, emits nothing
    for (const e of ev.events) {
      await insertEvent(q, parkId, showKey, place.name, e);
      if (e.type === "auto_hide") res.hidden.push(place.name);
      else if (e.type === "auto_restore") res.restored.push(place.name);
      else if (e.type === "silence_flag") res.silenceFlagged.push(place.name);
      else if (e.type === "registry_restore") res.registryRestored.push(place.name);
      else res.registryConflicts.push(place.name);
    }
    if (ev.needsSecondary) res.needsSecondary.push({ showKey, showName: place.name });
  }
  await pruneEvidence(q, parkId, addDaysToLocalDate(today, -LIFECYCLE_RETENTION_DAYS) ?? today);
  return res;
}

function defaultRunDb(sleep: (ms: number) => Promise<void>): RunDb {
  return async (_parkId, fn) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= DB_ATTEMPTS; attempt++) {
      try {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
        return await createPoolExecutor(getParkHoursPool()).run(fn);
      } catch (e) {
        lastErr = e;
        if (e instanceof LockBusyError) throw e;
        if (attempt < DB_ATTEMPTS) await sleep(DB_RETRY_PAUSE_MS);
      }
    }
    throw lastErr;
  };
}

class LockBusyError extends Error {}

/** Per-park transaction: take the advisory lock (busy → LockBusyError) then run `body`. */
async function lockedTx<T>(runDb: RunDb, parkId: ParkId, body: (q: Queryable) => Promise<T>): Promise<T> {
  return runDb(parkId, async (q) => {
    if (!(await tryLifecycleLock(q, parkId))) throw new LockBusyError("lifecycle run already active for park");
    return body(q);
  });
}

let running = false;

/** Resolves to null when a run is already active on this instance. Never throws. */
export async function runEntertainmentLifecycleMonitor(options: LifecycleMonitorOptions = {}): Promise<LifecycleMonitorReport | null> {
  if (running) return null;
  running = true;
  const startedMs = Date.now();
  try {
    const instant = options.instant ?? new Date();
    const budgetMs = options.budgetMs ?? LIFECYCLE_BUDGET_MS;
    const sleep = options.sleep ?? defaultSleep;
    const runDb = options.runDb ?? defaultRunDb(sleep);
    const registry = options.registry ?? ENTERTAINMENT_LIFECYCLE_REGISTRY;
    const providerDeadlineMs = options.providerDeadlineMs ?? LIFECYCLE_PROVIDER_DEADLINE_MS;
    const histories = new Map<ParkId, ThemeParksResult<ThemeParksHistoryDaily>>();
    const getShowtimes = options.getShowtimes ?? ((parkId: ParkId, at: Date, capture: GetHistory | undefined) =>
      getParkEntertainmentShowtimes(parkId, { instant: at, getHistory: capture, getHistoryAccess: options.getHistoryAccess, historyDeadlineMs: LIFECYCLE_HISTORY_DEADLINE_MS }));

    // ---- 1. FETCH (concurrent; per-park deadline; late results discarded) ----
    const fetched = await Promise.all(LIFECYCLE_PARK_IDS.map(async (parkId): Promise<ParkEntertainmentShowtimes | null> => {
      const capture: GetHistory | undefined = options.getHistory
        ? async (id, range) => { const r = await options.getHistory!(id, range); histories.set(parkId, r); return r; }
        : undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          getShowtimes(parkId, instant, capture),
          new Promise<null>((r) => { timer = setTimeout(() => r(null), providerDeadlineMs); }),
        ]);
      } catch {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));

    // ---- 2-4. OBSERVE → PERSIST/EVALUATE → SECONDARY (parks sequentially) ----
    const parks: ParkLifecycleResult[] = [];
    for (let i = 0; i < LIFECYCLE_PARK_IDS.length; i++) {
      const parkId = LIFECYCLE_PARK_IDS[i];
      const st = fetched[i];
      const base: ParkLifecycleResult = { parkId, status: "ok", observed: 0, classes: { active: 0, inactive: 0, dormant: 0, silent: 0, unknown: 0 }, hidden: [], restored: [], silenceFlagged: [], registryConflicts: [], registryRestored: [], dayEnd: false, secondary: "none" };
      base.dayEnd = isDayEndWindow(PARK_TO_RESORT[parkId] as ResortId, instant);
      if (Date.now() - startedMs > budgetMs) { parks.push({ ...base, status: "skipped_deadline" }); continue; }
      if (!st || st.error) { parks.push({ ...base, status: "provider_unavailable" }); continue; }
      const observations = observeParkDay(st, base.dayEnd);
      for (const o of observations) base.classes[o.dayClass]++;
      base.observed = observations.length;
      try {
        const applied = await lockedTx(runDb, parkId, (q) => evaluateAndPersist(q, parkId, st.localDate, instant, observations, new Set(), registry));
        base.hidden.push(...applied.hidden); base.restored.push(...applied.restored);
        base.silenceFlagged.push(...applied.silenceFlagged); base.registryConflicts.push(...applied.registryConflicts); base.registryRestored.push(...applied.registryRestored);

        if (applied.needsSecondary.length > 0 && Date.now() - startedMs <= budgetMs) {
          const hist = histories.get(parkId) ?? await fetchParkHistoryWithin(LIFECYCLE_HISTORY_DEADLINE_MS, parkId, instant, options.getHistory, options.getHistoryAccess);
          const evidence = buildParkHistoryEvidence(parkId, PARK_TO_RESORT[parkId] as ResortId, hist, instant);
          const backfill: ShowDayObservation[] = [];
          for (const s of applied.needsSecondary) {
            backfill.push(...historyBackfillObservations({
              parkId, showKey: s.showKey, showName: s.showName,
              refIds: getThemeParksEntertainmentRefs(s.showName, parkId).map((r) => r.entityId),
              evidence, history: hist,
            }));
          }
          base.secondary = evidence?.usable ? "done" : "history_unavailable";
          // Re-evaluate only when history was usable; an unusable window changes nothing and is retried next run.
          if (evidence?.usable) {
            const again = await lockedTx(runDb, parkId, (q) => evaluateAndPersist(q, parkId, st.localDate, instant, backfill, new Set(applied.needsSecondary.map((s) => s.showKey)), registry));
            base.hidden.push(...again.hidden); base.restored.push(...again.restored);
            base.silenceFlagged.push(...again.silenceFlagged); base.registryConflicts.push(...again.registryConflicts); base.registryRestored.push(...again.registryRestored);
          }
        }
        parks.push(base);
      } catch (e) {
        parks.push({ ...base, status: e instanceof LockBusyError ? "busy" : "db_unavailable" });
      }
    }
    const okCount = parks.filter((p) => p.status === "ok").length;
    return {
      ok: okCount === parks.length,
      startedAt: new Date(startedMs).toISOString(),
      durationMs: Date.now() - startedMs,
      parks,
      counts: { total: parks.length, ok: okCount, failed: parks.length - okCount },
    };
  } finally {
    running = false;
  }
}

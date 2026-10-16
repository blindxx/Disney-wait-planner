/**
 * parkHoursRefresh.ts — Phase 12.10.2B daily refresh of ThemeParks.wiki regular
 * park hours for all six parks, persisted through the existing 12.10.2A store.
 * Server-only. Driven by Vercel Cron via /api/cron/park-hours (02:00 UTC).
 *
 * Nothing new is trusted or stored here: provider data comes ONLY from the
 * shared ThemeParks client via `getParkHours()` (same normalization, 15 min
 * cache, 8 s per-request timeout, stale-if-error flagging), and persistence is
 * ONLY `persistParkRegularHours()` (same validation, freshness, newer-wins
 * upsert, single-flight, deadline/abort and failure cooldown). Visitor-triggered
 * persistence in `parkHoursService.ts` is untouched and keeps working.
 *
 * Shape (bounded by construction):
 *  1. FETCH phase — all parks concurrently (provider calls are independent and
 *     cached), each with at most MAX_FETCH_ATTEMPTS attempts inside one per-park
 *     deadline; a late result after the deadline is discarded. `getParkHours`'s
 *     own fire-and-forget persistence is replaced by a capture hook, so the
 *     cron persists exactly what it fetched, no extra provider calls.
 *  2. PERSIST phase — parks SEQUENTIALLY (the store is single-flight per
 *     instance, so concurrency would only make it skip), each awaited for a
 *     real outcome. A "busy" outcome (a visitor's write in flight) is retried
 *     a few times with a short pause; a cooldown is not waited out. Once the
 *     overall budget is spent the remaining parks are reported
 *     `skipped_deadline` rather than started.
 *  Failures are isolated per park; the run always returns a per-park report.
 *
 * Retries are safe: persistence is an idempotent, strictly-newer-wins upsert
 * (a repeated/duplicated cron delivery resolves to `nothing_to_write`), and an
 * overlapping run on the same instance is refused.
 */

import { timingSafeEqual } from "node:crypto";
import type { ParkId } from "@disney-wait-planner/shared";
import { PARK_LABELS } from "./parkMetadata";
import { getParkHours } from "./parkHoursService";
import {
  persistParkRegularHours,
  resetParkHoursStoreState,
  type PersistOutcome,
  type PersistableScheduleResponse,
  type Queryable,
} from "./parkHoursStore";
import { THEMEPARKS_PARKS } from "./themeParksProviders";
import type { ThemeParksResult, ThemeParksSchedule } from "./themeParksApi";

/** Every supported park — derived from the single maintained park list. */
export const REFRESH_PARK_IDS = Object.keys(PARK_LABELS) as ParkId[];

export const MAX_FETCH_ATTEMPTS = 2;
export const MAX_PERSIST_ATTEMPTS = 3;
const FETCH_RETRY_PAUSE_MS = 250;
const PERSIST_BUSY_PAUSE_MS = 500;
/** Per-park provider deadline (covers all attempts). */
export const DEFAULT_FETCH_DEADLINE_MS = 20_000;
/** Overall budget; the route's maxDuration (60 s, Hobby ceiling) leaves headroom beyond it. */
export const DEFAULT_BUDGET_MS = 45_000;
const PERSIST_DEADLINE_MS = 3_000;

export type ParkRefreshStatus =
  | "persisted"
  | "nothing_to_write"
  | "provider_unavailable"
  | "fetch_timeout"
  | "persist_busy"
  | "persist_cooldown"
  | "persist_failed"
  | "persist_timed_out"
  | "persist_unconfigured"
  | "skipped_deadline";

export interface ParkRefreshResult {
  parkId: ParkId;
  status: ParkRefreshStatus;
  ok: boolean;
  fetchAttempts: number;
  persistAttempts: number;
}

export interface ParkHoursRefreshReport {
  ok: boolean;
  startedAt: string;
  durationMs: number;
  parks: ParkRefreshResult[];
  counts: { total: number; ok: number; failed: number };
}

type GetSchedule = (id: string, month?: { year: number; month: number }) => Promise<ThemeParksResult<ThemeParksSchedule>>;
type PersistFn = (parkId: ParkId, responses: PersistableScheduleResponse[], instant: Date) => Promise<PersistOutcome>;

export interface RefreshOptions {
  instant?: Date;
  budgetMs?: number;
  fetchDeadlineMs?: number;
  /** Test seams. */
  getSchedule?: GetSchedule;
  persist?: PersistFn;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const OK_STATUSES = new Set<ParkRefreshStatus>(["persisted", "nothing_to_write"]);

interface Captured { responses: PersistableScheduleResponse[]; instant: Date }
interface FetchOutcome { attempts: number; captured: Captured | null; timedOut: boolean }

async function fetchPark(
  parkId: ParkId,
  o: RefreshOptions,
  deadlineMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<FetchOutcome> {
  let attempts = 0;
  let captured: Captured | null = null;
  let abandoned = false;
  const loop = (async () => {
    while (attempts < MAX_FETCH_ATTEMPTS && !abandoned) {
      if (attempts > 0) await sleep(FETCH_RETRY_PAUSE_MS);
      if (abandoned) return;
      attempts++;
      let cap: Captured | null = null;
      try {
        await getParkHours(parkId, {
          instant: o.instant,
          getSchedule: o.getSchedule,
          // Capture instead of the service's fire-and-forget write; the cron awaits its own.
          persist: (_p, responses, instant) => { cap = { responses, instant }; },
          keepAlive: () => {},
        });
      } catch { /* provider/normalizer trouble: treated as an unusable attempt */ }
      if (abandoned) return;
      const c = cap as Captured | null;
      if (c && c.responses.some((r) => r.result.ok)) { captured = c; return; }
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    loop.then(() => false, () => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), deadlineMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut) abandoned = true; // late completion of this attempt is ignored
  return { attempts, captured: timedOut ? null : captured, timedOut };
}

let running = false;
export function isParkHoursRefreshRunning(): boolean { return running; }

/** Runs one refresh. Returns null when another run is already active on this instance. NEVER throws. */
export async function runParkHoursRefresh(o: RefreshOptions = {}): Promise<ParkHoursRefreshReport | null> {
  if (running) return null;
  running = true;
  const t0 = Date.now();
  const budgetMs = o.budgetMs ?? DEFAULT_BUDGET_MS;
  const fetchDeadlineMs = Math.min(o.fetchDeadlineMs ?? DEFAULT_FETCH_DEADLINE_MS, budgetMs);
  const sleep = o.sleep ?? defaultSleep;
  const persist: PersistFn =
    o.persist ?? ((p, r, i) => persistParkRegularHours(p, r, { instant: i, deadlineMs: PERSIST_DEADLINE_MS }));
  const spent = () => Date.now() - t0;
  try {
    const fetched = await Promise.all(
      REFRESH_PARK_IDS.map((p): Promise<FetchOutcome> =>
        fetchPark(p, o, fetchDeadlineMs, sleep).catch(() => ({ attempts: 0, captured: null, timedOut: false }))),
    );
    const parks: ParkRefreshResult[] = [];
    for (let i = 0; i < REFRESH_PARK_IDS.length; i++) {
      const parkId = REFRESH_PARK_IDS[i];
      const f = fetched[i];
      const row = (status: ParkRefreshStatus, persistAttempts = 0): ParkRefreshResult =>
        ({ parkId, status, ok: OK_STATUSES.has(status), fetchAttempts: f.attempts, persistAttempts });
      if (!f.captured) { parks.push(row(f.timedOut ? "fetch_timeout" : "provider_unavailable")); continue; }
      let status: ParkRefreshStatus = "skipped_deadline";
      let tries = 0;
      while (tries < MAX_PERSIST_ATTEMPTS && spent() < budgetMs) {
        tries++;
        let outcome: PersistOutcome;
        try { outcome = await persist(parkId, f.captured.responses, f.captured.instant); } catch { outcome = "failed"; }
        if (outcome === "busy") {
          status = "persist_busy";
          if (tries < MAX_PERSIST_ATTEMPTS && spent() + PERSIST_BUSY_PAUSE_MS < budgetMs) { await sleep(PERSIST_BUSY_PAUSE_MS); continue; }
          break;
        }
        status =
          outcome === "persisted" ? "persisted"
          : outcome === "nothing_to_write" ? "nothing_to_write"
          : outcome === "cooldown" ? "persist_cooldown"
          : outcome === "unconfigured" ? "persist_unconfigured"
          : outcome === "timed_out" ? "persist_timed_out"
          : "persist_failed";
        break;
      }
      parks.push(row(status, tries));
    }
    const okCount = parks.filter((p) => p.ok).length;
    return {
      ok: okCount === parks.length,
      startedAt: new Date(t0).toISOString(),
      durationMs: spent(),
      parks,
      counts: { total: parks.length, ok: okCount, failed: parks.length - okCount },
    };
  } finally {
    running = false;
  }
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Missing secret ⇒ fail closed. */
export function authorizeCronRequest(authorization: string | null, secret: string | undefined): "ok" | "unconfigured" | "unauthorized" {
  if (!secret) return "unconfigured";
  if (!authorization) return "unauthorized";
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(authorization);
  return given.length === expected.length && timingSafeEqual(given, expected) ? "ok" : "unauthorized";
}

/** DEV checks (run manually; return failing labels): auth, six parks, partial failures, retries, bounds. */
export async function runDevParkHoursRefreshCases(): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const instant = new Date("2026-10-15T02:00:00Z");
  const noSleep = async () => {};
  const idToPark = new Map(REFRESH_PARK_IDS.map((p) => [THEMEPARKS_PARKS[p].entityId, p]));
  const west = (p: ParkId) => p === "disneyland" || p === "dca";
  const okResult = (id: string): ThemeParksResult<ThemeParksSchedule> => {
    const p = idToPark.get(id)!;
    const date = "2026-10-14"; // resort-local "today" at the 02:00Z cron instant
    const off = west(p) ? "-07:00" : "-04:00";
    return {
      ok: true,
      data: { entityId: id, name: p, timeZone: west(p) ? "America/Los_Angeles" : "America/New_York", entries: [{ date, type: "OPERATING", openingTime: `${date}T09:00:00${off}`, closingTime: `${date}T22:00:00${off}`, description: null, lastUpdated: null }], parks: [], droppedEntries: 0 },
      meta: { origin: "network", fetchedAt: instant.getTime(), etag: null },
    };
  };
  const fail: ThemeParksResult<ThemeParksSchedule> = { ok: false, error: { kind: "timeout", message: "t" } };
  const quiet = console.warn; console.warn = () => {};
  const get = (rep: ParkHoursRefreshReport, p: ParkId) => rep.parks.find((x) => x.parkId === p)!;
  try {
    // --- auth ---
    check("auth: missing secret fails closed even with a matching-looking header", authorizeCronRequest("Bearer undefined", undefined) === "unconfigured" && authorizeCronRequest("Bearer ", "") === "unconfigured");
    check("auth: no header → unauthorized", authorizeCronRequest(null, "s3cret") === "unauthorized");
    check("auth: wrong / wrong-length / wrong-scheme → unauthorized", ["Bearer nope", "Bearer s3cre", "Bearer s3cret2", "s3cret", "Basic s3cret"].every((h) => authorizeCronRequest(h, "s3cret") === "unauthorized"));
    check("auth: correct bearer → ok", authorizeCronRequest("Bearer s3cret", "s3cret") === "ok");

    // --- six parks, real store over a fake DB, idempotent re-run ---
    check("six parks: the maintained park list has exactly six", REFRESH_PARK_IDS.length === 6 && new Set(REFRESH_PARK_IDS).size === 6);
    resetParkHoursStoreState();
    const asked: string[] = [];
    let writes = 0;
    const db: Queryable = { query: async () => { writes++; return { rowCount: 1, rows: [] }; } };
    const getSchedule: GetSchedule = async (id) => { asked.push(idToPark.get(id) ?? id); return okResult(id); };
    const realPersist: PersistFn = (p, r, i) => persistParkRegularHours(p, r, { instant: i, db });
    let rep = (await runParkHoursRefresh({ instant, getSchedule, persist: realPersist, sleep: noSleep }))!;
    check("six parks: all six attempted once on the provider and persisted", rep.ok && rep.parks.length === 6 && rep.parks.every((p) => p.status === "persisted" && p.fetchAttempts === 1) && new Set(asked).size === 6 && asked.length === 6);
    check("six parks: report is per-park and counts add up", rep.counts.total === 6 && rep.counts.ok === 6 && rep.counts.failed === 0);
    const before = writes;
    rep = (await runParkHoursRefresh({ instant, getSchedule, persist: realPersist, sleep: noSleep }))!;
    check("retry safety: re-running the same data writes nothing new and still succeeds", rep.ok && rep.parks.every((p) => p.status === "nothing_to_write") && writes === before);

    // --- partial failures ---
    resetParkHoursStoreState();
    const calls: Record<string, number> = {};
    rep = (await runParkHoursRefresh({
      instant,
      getSchedule: async (id) => { const p = idToPark.get(id)!; calls[p] = (calls[p] ?? 0) + 1; return p === "ak" ? fail : okResult(id); },
      persist: async (p) => (p === "epcot" ? "failed" : "persisted"),
      sleep: noSleep,
    }))!;
    check("partial: provider failure on one park is isolated and reported", get(rep, "ak").status === "provider_unavailable" && get(rep, "mk").status === "persisted" && get(rep, "hs").status === "persisted");
    check("partial: failing park retried at most MAX_FETCH_ATTEMPTS", calls.ak === MAX_FETCH_ATTEMPTS && calls.mk === 1 && get(rep, "ak").fetchAttempts === MAX_FETCH_ATTEMPTS);
    check("partial: persist failure on one park does not stop the others", get(rep, "epcot").status === "persist_failed" && rep.counts.failed === 2 && !rep.ok && get(rep, "dca").status === "persisted");
    rep = (await runParkHoursRefresh({ instant, getSchedule: async (id) => { if (idToPark.get(id) === "mk") throw new Error("boom"); return okResult(id); }, persist: async () => { throw new Error("db"); }, sleep: noSleep }))!;
    check("partial: throwing provider/persist never escapes the run", rep.parks.length === 6 && get(rep, "mk").status === "provider_unavailable" && get(rep, "hs").status === "persist_failed");

    // --- retries on busy / cooldown ---
    let n = 0;
    rep = (await runParkHoursRefresh({ instant, getSchedule, persist: async (p) => (p === "mk" && ++n < 2 ? "busy" : "persisted"), sleep: noSleep }))!;
    check("retry: a busy store is retried and then succeeds", get(rep, "mk").status === "persisted" && get(rep, "mk").persistAttempts === 2);
    let busyCalls = 0;
    rep = (await runParkHoursRefresh({ instant, getSchedule, persist: async (p) => { if (p === "mk") busyCalls++; return p === "mk" ? "busy" : "persisted"; }, sleep: noSleep }))!;
    check("retry: persistent busy is bounded and reported", busyCalls === MAX_PERSIST_ATTEMPTS && get(rep, "mk").status === "persist_busy");
    let coolCalls = 0;
    rep = (await runParkHoursRefresh({ instant, getSchedule, persist: async (p) => { if (p === "mk") coolCalls++; return p === "mk" ? "cooldown" : "persisted"; }, sleep: noSleep }))!;
    check("retry: cooldown is reported, not waited out or retried", coolCalls === 1 && get(rep, "mk").status === "persist_cooldown");

    // --- execution bounds ---
    let t = Date.now();
    rep = (await runParkHoursRefresh({
      instant, fetchDeadlineMs: 60,
      getSchedule: async (id) => (idToPark.get(id) === "hs" ? new Promise<never>(() => {}) : okResult(id)),
      persist: async () => "persisted", sleep: noSleep,
    }))!;
    check("bounds: a hung provider call times out that park only, within the deadline", get(rep, "hs").status === "fetch_timeout" && rep.counts.ok === 5 && Date.now() - t < 1000);
    t = Date.now();
    rep = (await runParkHoursRefresh({ instant, budgetMs: 120, getSchedule, persist: () => new Promise<PersistOutcome>((r) => setTimeout(() => r("persisted"), 70)), sleep: noSleep }))!;
    const skipped = rep.parks.filter((p) => p.status === "skipped_deadline").length;
    check("bounds: exhausted budget stops starting persists; remaining parks reported skipped", skipped >= 1 && skipped <= 4 && rep.parks.length === 6 && !rep.ok && Date.now() - t < 1000);
    check("bounds: defaults leave headroom under the 60 s function limit", DEFAULT_BUDGET_MS + PERSIST_DEADLINE_MS + 5_000 <= 60_000 && DEFAULT_FETCH_DEADLINE_MS <= DEFAULT_BUDGET_MS);

    // --- overlap guard ---
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const first = runParkHoursRefresh({ instant, getSchedule: async (id) => { await gate; return okResult(id); }, persist: async () => "persisted", sleep: noSleep });
    const second = await runParkHoursRefresh({ instant, getSchedule, persist: async () => "persisted", sleep: noSleep });
    check("overlap: a concurrent run on the same instance is refused", second === null && isParkHoursRefreshRunning());
    release?.();
    const done = await first;
    check("overlap: the first run completes and clears the guard", !!done && done.ok && !isParkHoursRefreshRunning());
  } finally {
    console.warn = quiet;
    resetParkHoursStoreState();
  }
  return failures;
}

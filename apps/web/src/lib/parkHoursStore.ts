/**
 * parkHoursStore.ts — Phase 12.10.2A durable persistence of VERIFIED
 * ThemeParks.wiki regular (`OPERATING`) park hours in Neon (`park_regular_hours`,
 * db-schema.sql). Server-only. No new provider requests: the park-hours
 * service hands over the schedule responses it already fetched.
 *
 * Trust rules (all enforced before anything reaches SQL):
 *  - Only an `ok`, non-stale response with zero dropped entries, a matching
 *    park entity and a matching/absent timezone is eligible. Failed, stale,
 *    partially-malformed or foreign data writes nothing.
 *  - A date is stored only when the provider positively lists OPERATING
 *    window(s) for it AND every one of that date's OPERATING entries is valid
 *    (parseable, close after open, ≤ 24 h, opens on the entry's own date,
 *    non-overlapping). Otherwise the whole date is skipped (incomplete set).
 *    A missing date or an empty schedule is NEVER recorded as closed.
 *  - Overnight windows are kept dated by their opening day, closing after
 *    midnight, exactly as parkHours.ts treats them.
 *  - Rows older than the rolling window (resort-local today − 7 days) are not
 *    written, and are deleted (throttled).
 *
 * Write safety: one multi-row `INSERT … ON CONFLICT DO UPDATE … WHERE`
 * statement (atomic; rows sorted so concurrent writers lock in one order).
 * An existing row is touched only by a STRICTLY newer provider fetch.
 * `source_fetched_at` is a monotonic high-water mark of the newest observation
 * for the row: a newer observation with IDENTICAL windows advances it (and
 * `verified_at`) but leaves the stored content columns as they were, so an
 * older, different response can never overwrite newer verified hours (e.g.
 * A(t0), A(t2), B(t1) ends as A@t2 whatever the writer order). Changed windows
 * replace the content. Duplicate / out-of-order writers converge. An
 * in-process memo skips the round trip for observations no newer than one this
 * instance already persisted.
 *
 * Failure isolation: `persistParkRegularHours` never throws and never waits
 * longer than its deadline; after a failure it stays off the DB for a cooldown.
 */

import { createHash } from "node:crypto";
import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import type { Pool, PoolClient } from "pg";
import { getParkHoursPool } from "./db";
import { PARK_TO_RESORT } from "./parkMetadata";
import { isValidIsoCalendarDate } from "./plannerWarnings";
import { addDaysToLocalDate, getResortLocalDate, RESORT_TIME_ZONES } from "./resortTime";
import type { ThemeParksResult, ThemeParksSchedule } from "./themeParksApi";
import { THEMEPARKS_PARKS } from "./themeParksProviders";

/** How the date's entry set was obtained. */
export type RegularHoursCoverage = "default_window" | "month";

export interface PersistableScheduleResponse {
  coverage: RegularHoursCoverage;
  result: ThemeParksResult<ThemeParksSchedule>;
}

export interface StoredWindow {
  /** UTC ISO instants. */
  opens: string;
  closes: string;
}

export interface RegularHoursRecord {
  parkId: ParkId;
  date: string;
  windows: StoredWindow[];
  windowsHash: string;
  coverage: RegularHoursCoverage;
  /** Epoch ms the provider response was fetched. */
  sourceFetchedAt: number;
  /** Max provider lastUpdated across the date's windows (ISO) or null. */
  providerLastUpdated: string | null;
}

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
}

export const RETENTION_DAYS = 7;
const MAX_WINDOWS_PER_DAY = 8;
const MAX_WINDOW_MS = 24 * 3600_000;
const MAX_SOURCE_AGE_MS = 24 * 3600_000;
const FUTURE_SKEW_MS = 5 * 60_000;
const RETENTION_INTERVAL_MS = 3600_000;
const FAILURE_COOLDOWN_MS = 60_000;
const DEFAULT_DEADLINE_MS = 1500;

// ============================================
// PURE: validation → records
// ============================================

function hashWindows(windows: StoredWindow[]): string {
  return createHash("sha256").update(JSON.stringify(windows)).digest("hex");
}

/** Oldest resort-local date still retained for `resort` at `instant`. */
export function retentionCutoffDate(resort: ResortId, instant: Date): string {
  return addDaysToLocalDate(getResortLocalDate(resort, instant), -RETENTION_DAYS) as string;
}

/**
 * Pure: the records safe to persist from the schedule responses a park-hours
 * request already fetched. When several responses cover a date, the newest
 * fetch wins (ties: first listed).
 */
export function buildRegularHoursRecords(
  parkId: ParkId,
  responses: PersistableScheduleResponse[],
  instant: Date = new Date(),
): RegularHoursRecord[] {
  const resort = PARK_TO_RESORT[parkId] as ResortId;
  const cutoff = retentionCutoffDate(resort, instant);
  const entityId = THEMEPARKS_PARKS[parkId].entityId.toLowerCase();
  const byDate = new Map<string, RegularHoursRecord>();

  for (const { coverage, result } of responses) {
    if (!result.ok) continue;
    const { data, meta } = result;
    if (meta.origin === "stale") continue;
    if (data.droppedEntries !== 0) continue;
    if (data.entityId.toLowerCase() !== entityId) continue;
    if (data.timeZone !== null && data.timeZone !== RESORT_TIME_ZONES[resort]) continue;
    const fetchedAt = meta.fetchedAt;
    if (!Number.isFinite(fetchedAt)) continue;
    if (fetchedAt > instant.getTime() + FUTURE_SKEW_MS) continue;
    if (instant.getTime() - fetchedAt > MAX_SOURCE_AGE_MS) continue;

    const perDate = new Map<string, Array<{ o: number; c: number; lu: string | null }>>();
    const tainted = new Set<string>();
    for (const e of data.entries) {
      if (e.type !== "OPERATING") continue;
      if (!isValidIsoCalendarDate(e.date)) continue; // unattributable; client already drops these
      const o = Date.parse(e.openingTime);
      const c = Date.parse(e.closingTime);
      const ok =
        Number.isFinite(o) && Number.isFinite(c) && c > o && c - o <= MAX_WINDOW_MS &&
        getResortLocalDate(resort, new Date(o)) === e.date;
      if (!ok) { tainted.add(e.date); continue; }
      const list = perDate.get(e.date) ?? [];
      list.push({ o, c, lu: e.lastUpdated });
      perDate.set(e.date, list);
    }

    for (const [date, raw] of perDate) {
      if (tainted.has(date) || date < cutoff) continue;
      const sorted = raw.slice().sort((a, b) => a.o - b.o || a.c - b.c);
      const uniq = sorted.filter((w, i) => i === 0 || w.o !== sorted[i - 1].o || w.c !== sorted[i - 1].c);
      if (uniq.length > MAX_WINDOWS_PER_DAY) continue;
      if (uniq.some((w, i) => i > 0 && w.o < uniq[i - 1].c)) continue; // overlapping → untrustworthy
      const windows = uniq.map((w) => ({ opens: new Date(w.o).toISOString(), closes: new Date(w.c).toISOString() }));
      const updated = uniq
        .map((w) => (w.lu ? Date.parse(w.lu) : NaN))
        .filter(Number.isFinite);
      const rec: RegularHoursRecord = {
        parkId,
        date,
        windows,
        windowsHash: hashWindows(windows),
        coverage,
        sourceFetchedAt: fetchedAt,
        providerLastUpdated: updated.length ? new Date(Math.max(...updated)).toISOString() : null,
      };
      const prev = byDate.get(date);
      if (!prev || rec.sourceFetchedAt > prev.sourceFetchedAt) byDate.set(date, rec);
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ============================================
// DB: idempotent, concurrency-safe upsert / retention / read
// ============================================

/**
 * Atomic batch upsert. Returns the number of rows actually inserted/updated
 * (rows no newer than the stored observation are skipped and not counted; a
 * newer identical observation counts: it advances the freshness mark only).
 */
export async function upsertRegularHours(db: Queryable, records: RegularHoursRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  const sorted = records.slice().sort((a, b) =>
    a.parkId === b.parkId ? (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) : a.parkId < b.parkId ? -1 : 1);
  const res = await db.query(
    `INSERT INTO park_regular_hours AS t
       (park_id, hours_date, windows, windows_hash, coverage, source_fetched_at, provider_last_updated)
     SELECT p, d, w::jsonb, h, c, to_timestamp(f / 1000.0), CASE WHEN u IS NULL THEN NULL ELSE u::timestamptz END
     FROM unnest($1::text[], $2::date[], $3::text[], $4::text[], $5::text[], $6::double precision[], $7::text[])
       AS x(p, d, w, h, c, f, u)
     ON CONFLICT (park_id, hours_date) DO UPDATE SET
       windows = CASE WHEN t.windows_hash = EXCLUDED.windows_hash THEN t.windows ELSE EXCLUDED.windows END,
       windows_hash = EXCLUDED.windows_hash,
       coverage = CASE WHEN t.windows_hash = EXCLUDED.windows_hash THEN t.coverage ELSE EXCLUDED.coverage END,
       provider_last_updated = CASE WHEN t.windows_hash = EXCLUDED.windows_hash THEN t.provider_last_updated ELSE EXCLUDED.provider_last_updated END,
       source_fetched_at = EXCLUDED.source_fetched_at,
       verified_at = NOW()
     WHERE t.source_fetched_at < EXCLUDED.source_fetched_at`,
    [
      sorted.map((r) => r.parkId),
      sorted.map((r) => r.date),
      sorted.map((r) => JSON.stringify(r.windows)),
      sorted.map((r) => r.windowsHash),
      sorted.map((r) => r.coverage),
      sorted.map((r) => r.sourceFetchedAt),
      sorted.map((r) => r.providerLastUpdated),
    ],
  );
  return res.rowCount ?? 0;
}

/** Delete this park's rows dated before `cutoffDate` (rolling 7-day history). */
export async function deleteExpiredRegularHours(db: Queryable, parkId: ParkId, cutoffDate: string): Promise<number> {
  const res = await db.query(`DELETE FROM park_regular_hours WHERE park_id = $1 AND hours_date < $2::date`, [parkId, cutoffDate]);
  return res.rowCount ?? 0;
}

export interface StoredRegularHours {
  parkId: string;
  date: string;
  windows: StoredWindow[];
  coverage: string;
  sourceFetchedAt: number;
}

/** Stored verified rows for a park with `from <= date <= to` (inclusive, YYYY-MM-DD). */
export async function readStoredRegularHours(db: Queryable, parkId: ParkId, from: string, to: string): Promise<StoredRegularHours[]> {
  const res = await db.query(
    `SELECT park_id, to_char(hours_date, 'YYYY-MM-DD') AS d, windows, coverage,
            (extract(epoch FROM source_fetched_at) * 1000)::double precision AS f
     FROM park_regular_hours
     WHERE park_id = $1 AND hours_date >= $2::date AND hours_date <= $3::date
     ORDER BY hours_date`,
    [parkId, from, to],
  );
  return res.rows.map((r) => ({
    parkId: String(r.park_id),
    date: String(r.d),
    windows: r.windows as StoredWindow[],
    coverage: String(r.coverage),
    sourceFetchedAt: Math.round(Number(r.f)),
  }));
}

// ============================================
// Opportunistic, failure-isolated entry point
// ============================================

interface Memo { hash: string; fetchedAt: number }
const memo = new Map<string, Memo>();
const retentionRanAt = new Map<ParkId, number>();
let blockedUntil = 0;
/** At most ONE persistence attempt in flight per server instance. */
let inflight = false;
/** Bumped when an attempt is abandoned; late completions of old attempts are ignored. */
let generation = 0;

/** Test hook: clear in-process memo / throttles / cooldown / in-flight gate. */
export function resetParkHoursStoreState(): void {
  memo.clear();
  retentionRanAt.clear();
  blockedUntil = 0;
  inflight = false;
  generation++;
}

/**
 * Runs the persistence statements on ONE bounded connection and can tear that
 * connection down. `abort()` must make any in-flight statement stop (for the
 * real pool: destroy the client, so the server sees the disconnect and cancels
 * the query) and must be safe to call at any time, repeatedly.
 */
export interface PersistExecutor {
  run<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  abort(): void;
}

/**
 * Server-side cap on each persistence statement (SET LOCAL: pooler-safe). Destroying a
 * client socket does not by itself stop a statement the server is already executing, so
 * this is what guarantees an abandoned write ends on the database within a few seconds.
 */
const STATEMENT_TIMEOUT_MS = 4000;

/**
 * Real executor: a client from the DEDICATED park-hours pool (never the shared
 * auth/planner pool), one transaction with a server-side statement_timeout.
 * Any failure or abort destroys the connection instead of returning it.
 */
export function createPoolExecutor(pool: Pool): PersistExecutor {
  let client: PoolClient | null = null;
  let done = false;
  const finish = (destroy: boolean) => {
    if (done || !client) { done = true; return; }
    done = true;
    try { client.release(destroy); } catch { /* already gone */ }
  };
  return {
    async run<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      if (done) { try { c.release(true); } catch { /* aborted while connecting */ } throw new Error("aborted"); }
      client = c;
      c.on("error", () => {}); // checked-out clients have no pool error listener
      try {
        await c.query("BEGIN");
        await c.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        const out = await fn(c as unknown as Queryable);
        await c.query("COMMIT");
        finish(false);
        return out;
      } catch (err) {
        finish(true);
        throw err;
      }
    },
    abort() { finish(true); },
  };
}

export interface PersistOptions {
  instant?: Date;
  /** Injected queryable (tests); wrapped in a no-op-abort executor. */
  db?: Queryable;
  /** Injected executor (tests); default is a dedicated-pool executor when DATABASE_URL is set. */
  executor?: PersistExecutor;
  deadlineMs?: number;
  /** Monotonic-enough wall clock for cooldown/throttles (tests). Default Date.now. */
  clock?: () => number;
}

/** Records still worth writing (not already known to this instance) + whether retention is due. */
function planWork(parkId: ParkId, responses: PersistableScheduleResponse[], instant: Date, nowMs: number) {
  const fresh = buildRegularHoursRecords(parkId, responses, instant).filter((r) => {
    const m = memo.get(`${r.parkId}:${r.date}`);
    if (!m) return true;
    return r.sourceFetchedAt > m.fetchedAt; // mirrors SQL: only strictly newer observations touch a row
  });
  const retentionDue = nowMs - (retentionRanAt.get(parkId) ?? 0) >= RETENTION_INTERVAL_MS && responses.some((x) => x.result.ok);
  return { fresh, retentionDue };
}

/**
 * Persist verified regular hours from already-fetched responses. NEVER throws;
 * resolves within `deadlineMs`. Bounded by construction:
 *  - single-flight: while an attempt is running, other callers return at once
 *    (best effort — their records are re-offered by the next request);
 *  - on deadline the attempt is ABORTED (connection destroyed) and the store
 *    stays off the DB for a cooldown, so a permanently hung database costs at
 *    most one abandoned attempt per cooldown and never accumulates;
 *  - it only ever uses the dedicated one-connection pool, never the shared one.
 * No-op without DATABASE_URL (or an injected db/executor).
 */
export async function persistParkRegularHours(
  parkId: ParkId,
  responses: PersistableScheduleResponse[],
  opts: PersistOptions = {},
): Promise<void> {
  try {
    const clock = opts.clock ?? Date.now;
    const instant = opts.instant ?? new Date();
    const startedAt = clock();
    if (startedAt < blockedUntil || inflight) return;
    const { fresh, retentionDue } = planWork(parkId, responses, instant, startedAt);
    if (fresh.length === 0 && !retentionDue) return;

    let executor = opts.executor ?? (opts.db ? { run: (fn) => fn(opts.db as Queryable), abort() {} } as PersistExecutor : null);
    if (!executor) {
      if (!process.env.DATABASE_URL) return;
      executor = createPoolExecutor(getParkHoursPool());
    }
    const exec = executor;

    inflight = true;
    const mine = ++generation;
    const current = () => mine === generation;
    const work = exec.run(async (q) => {
      await upsertRegularHours(q, fresh);
      if (retentionDue) {
        const resort = PARK_TO_RESORT[parkId] as ResortId;
        await deleteExpiredRegularHours(q, parkId, retentionCutoffDate(resort, instant));
      }
    }).then(
      () => {
        if (!current()) return;
        for (const r of fresh) memo.set(`${r.parkId}:${r.date}`, { hash: r.windowsHash, fetchedAt: r.sourceFetchedAt });
        if (retentionDue) retentionRanAt.set(parkId, startedAt);
      },
      (err) => {
        if (!current()) return;
        blockedUntil = clock() + FAILURE_COOLDOWN_MS;
        console.warn("[parkHoursStore] persist failed:", err instanceof Error ? err.message : String(err));
      },
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      work.then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), opts.deadlineMs ?? DEFAULT_DEADLINE_MS); }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      // Abandon: stop the underlying query, ignore any late completion, back off.
      generation++;
      blockedUntil = clock() + FAILURE_COOLDOWN_MS;
      try { exec.abort(); } catch { /* best effort */ }
      console.warn("[parkHoursStore] persist timed out; aborted and cooling down");
    }
    if (current() || timedOut) inflight = false;
  } catch (err) {
    inflight = false;
    console.warn("[parkHoursStore] persist skipped:", err instanceof Error ? err.message : String(err));
  }
}

// ============================================
// DEV checks (run manually; return failing labels)
// ============================================

/**
 * Pure + fake-DB cases always run. SQL semantics (idempotency, concurrency,
 * retention, newer-wins) run only when `realDb` (a Queryable against a
 * DISPOSABLE database that has db-schema.sql applied) is supplied.
 */
export async function runDevParkHoursStoreCases(realDb?: Queryable, realPool?: Pool): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const ID = THEMEPARKS_PARKS.mk.entityId;
  const NOW = new Date("2026-10-15T15:00:00Z");
  const T = NOW.getTime();
  type E = ThemeParksSchedule["entries"][number];
  const ent = (date: string, open = "09:00", close = "22:00", over: Partial<E> = {}): E => {
    const closeDate = close < open ? addDaysToLocalDate(date, 1) : date;
    return { date, type: "OPERATING", openingTime: `${date}T${open}:00-04:00`, closingTime: `${closeDate}T${close}:00-04:00`, description: null, lastUpdated: null, ...over };
  };
  const resp = (entries: E[], over: { origin?: "network" | "stale"; fetchedAt?: number; dropped?: number; tz?: string | null; id?: string } = {}, coverage: RegularHoursCoverage = "default_window"): PersistableScheduleResponse => ({
    coverage,
    result: {
      ok: true,
      data: { entityId: over.id ?? ID, name: "MK", timeZone: over.tz === undefined ? "America/New_York" : over.tz, entries, parks: [], droppedEntries: over.dropped ?? 0 },
      meta: { origin: over.origin ?? "network", fetchedAt: over.fetchedAt ?? T, etag: null },
    },
  });
  const build = (r: PersistableScheduleResponse[]) => buildRegularHoursRecords("mk", r, NOW);

  // --- validation ---
  let recs = build([resp([ent("2026-10-15"), ent("2026-10-16")])]);
  check("store: valid dates become records", recs.length === 2 && recs[0].date === "2026-10-15" && recs[0].windows[0].opens === "2026-10-15T13:00:00.000Z");
  check("store: failed response writes nothing", build([{ coverage: "month", result: { ok: false, error: { kind: "timeout", message: "t" } } }]).length === 0);
  check("store: stale response writes nothing", build([resp([ent("2026-10-15")], { origin: "stale" })]).length === 0);
  check("store: dropped entries → nothing", build([resp([ent("2026-10-15")], { dropped: 1 })]).length === 0);
  check("store: wrong park entity → nothing", build([resp([ent("2026-10-15")], { id: "00000000-0000-0000-0000-000000000000" })]).length === 0);
  check("store: timezone mismatch → nothing", build([resp([ent("2026-10-15")], { tz: "America/Los_Angeles" })]).length === 0);
  check("store: empty schedule writes nothing (no closure inferred)", build([resp([])]).length === 0);
  check("store: non-OPERATING entries ignored", build([resp([ent("2026-10-15", "09:00", "22:00", { type: "TICKETED_EVENT" })])]).length === 0);
  check("store: too-old / future-skewed source rejected", build([resp([ent("2026-10-15")], { fetchedAt: T - 25 * 3600_000 })]).length === 0 && build([resp([ent("2026-10-15")], { fetchedAt: T + 3600_000 })]).length === 0);
  check("store: close ≤ open → date skipped", build([resp([ent("2026-10-15", "22:00", "22:00", { closingTime: "2026-10-15T22:00:00-04:00", openingTime: "2026-10-15T22:00:00-04:00" })])]).length === 0);
  check("store: unparseable time → date skipped", build([resp([ent("2026-10-15", "09:00", "22:00", { openingTime: "garbage" })])]).length === 0);
  check("store: window >24h → date skipped", build([resp([ent("2026-10-15", "09:00", "22:00", { closingTime: "2026-10-16T12:00:00-04:00" })])]).length === 0);
  check("store: opening date ≠ entry date → date skipped", build([resp([ent("2026-10-16", "09:00", "22:00", { openingTime: "2026-10-15T09:00:00-04:00" })])]).length === 0);
  recs = build([resp([ent("2026-10-15", "09:00", "22:00"), ent("2026-10-15", "09:00", "22:00", { openingTime: "2026-10-15T09:00:00-04:00", closingTime: "2026-10-15T22:00:00-04:00" })])]);
  check("store: identical duplicate windows collapse", recs.length === 1 && recs[0].windows.length === 1);
  check("store: overlapping windows → date skipped", build([resp([ent("2026-10-15", "09:00", "15:00"), ent("2026-10-15", "14:00", "20:00")])]).length === 0);
  recs = build([resp([ent("2026-10-15", "18:00", "22:00"), ent("2026-10-15", "09:00", "14:00")])]);
  check("store: multiple windows per day stored ascending", recs.length === 1 && recs[0].windows.length === 2 && recs[0].windows[0].opens < recs[0].windows[1].opens);
  recs = build([resp([ent("2026-10-15", "09:00", "22:00"), ent("2026-10-16", "09:00", "22:00", { openingTime: "bad" })])]);
  check("store: one bad date does not discard other valid dates", recs.length === 1 && recs[0].date === "2026-10-15");
  recs = build([resp([ent("2026-10-15", "09:00", "22:00"), ent("2026-10-15", "23:00", "22:00", { openingTime: "bad" })])]);
  check("store: invalid sibling window taints the whole date (incomplete set)", recs.length === 0);

  // --- overnight ---
  recs = build([resp([ent("2026-10-15", "09:00", "02:00")])]);
  check("store: overnight window stays dated by opening day, closes next day", recs.length === 1 && recs[0].date === "2026-10-15" && recs[0].windows[0].closes === "2026-10-16T06:00:00.000Z");
  recs = build([resp([ent("2026-10-15", "20:00", "03:00")])]);
  check("store: resort-local date drives dating (opens 00:00Z next day, still Oct 15 local)", recs.length === 1 && recs[0].windows[0].opens === "2026-10-16T00:00:00.000Z");

  // --- coverage / merge ---
  recs = build([resp([ent("2026-10-15", "09:00", "22:00")], { fetchedAt: T - 60_000 }, "default_window"), resp([ent("2026-10-15", "08:00", "22:00")], { fetchedAt: T }, "month")]);
  check("store: newest fetch wins per date; coverage recorded", recs.length === 1 && recs[0].coverage === "month" && recs[0].windows[0].opens === "2026-10-15T12:00:00.000Z");
  recs = build([resp([ent("2026-10-15")], {}, "default_window"), resp([ent("2026-10-15")], {}, "month")]);
  check("store: equal fetch ties keep first", recs.length === 1 && recs[0].coverage === "default_window");
  check("store: equal windows hash equal across offset spellings", build([resp([ent("2026-10-15", "09:00", "22:00", { openingTime: "2026-10-15T13:00:00Z", closingTime: "2026-10-16T02:00:00Z" })])])[0]?.windowsHash === build([resp([ent("2026-10-15")])])[0]?.windowsHash);

  // --- retention window (pure) ---
  recs = build([resp([ent("2026-10-07"), ent("2026-10-08"), ent("2026-10-31")])]);
  check("store: dates older than 7 resort-local days not written; today-7 kept; future kept", recs.map((r) => r.date).join() === "2026-10-08,2026-10-31");
  check("store: retention cutoff is resort-local", retentionCutoffDate("WDW", new Date("2026-10-15T02:00:00Z")) === "2026-10-07");

  // --- failure isolation (fake DB) ---
  resetParkHoursStoreState();
  let calls = 0;
  const failing: Queryable = { query: async () => { calls++; throw new Error("boom"); } };
  const warn = console.warn; console.warn = () => {};
  try {
    let threw = false;
    try { await persistParkRegularHours("mk", [resp([ent("2026-10-15")])], { instant: NOW, db: failing }); } catch { threw = true; }
    check("store: DB failure never throws", !threw && calls >= 1);
    const c1 = calls;
    await persistParkRegularHours("mk", [resp([ent("2026-10-16")])], { instant: NOW, db: failing });
    check("store: failure cooldown skips the DB", calls === c1);
    resetParkHoursStoreState();
    const hang: Queryable = { query: () => new Promise(() => {}) };
    const t0 = Date.now();
    await persistParkRegularHours("mk", [resp([ent("2026-10-15")])], { instant: NOW, db: hang, deadlineMs: 50 });
    check("store: hung DB bounded by deadline", Date.now() - t0 < 1000);
  } finally { console.warn = warn; }
  resetParkHoursStoreState();
  calls = 0;
  const noop: Queryable = { query: async () => { calls++; return { rowCount: 0, rows: [] }; } };
  await persistParkRegularHours("mk", [{ coverage: "month", result: { ok: false, error: { kind: "timeout", message: "t" } } }], { instant: NOW, db: noop });
  check("store: failed provider response makes no DB call", calls === 0);
  await persistParkRegularHours("mk", [resp([ent("2026-10-15")])], { instant: NOW, db: noop });
  const afterFirst = calls;
  await persistParkRegularHours("mk", [resp([ent("2026-10-15")])], { instant: NOW, db: noop });
  check("store: same observation repeated is memoized (no redundant DB call)", afterFirst > 0 && calls === afterFirst);
  await persistParkRegularHours("mk", [resp([ent("2026-10-15")], { fetchedAt: T + 1000 })], { instant: NOW, db: noop });
  check("store: newer identical observation reaches the DB (freshness must advance)", calls > afterFirst);
  const afterNewer = calls;
  await persistParkRegularHours("mk", [resp([ent("2026-10-15", "08:00", "22:00")], { fetchedAt: T + 2000 })], { instant: NOW, db: noop });
  check("store: changed windows reach the DB", calls > afterNewer);

  // --- bounded in-flight work: hung writes, cooldown, recovery, concurrency ---
  {
    const warn2 = console.warn; console.warn = () => {};
    try {
      let t = 1_000_000;
      const clock = () => t;
      let n = 0;
      const fresh = () => [resp([ent("2026-10-15", "09:00", "22:00")], { fetchedAt: T + 1000 * ++n })];
      const mkExec = (impl: (fn: (q: Queryable) => Promise<unknown>) => Promise<unknown>) => {
        const x = { runs: 0, aborts: 0, active: 0, maxActive: 0 };
        const exec: PersistExecutor = {
          run: (async (fn: (q: Queryable) => Promise<unknown>) => {
            x.runs++; x.active++; x.maxActive = Math.max(x.maxActive, x.active);
            try { return await impl(fn); } finally { /* active drops on abort/settle */ }
          }) as PersistExecutor["run"],
          abort: () => { x.aborts++; x.active = Math.max(0, x.active - 1); },
        };
        return { x, exec };
      };
      const okQ: Queryable = { query: async () => ({ rowCount: 1, rows: [] }) };
      const hung = () => mkExec(() => new Promise(() => {}));

      // permanently hung write
      resetParkHoursStoreState();
      let h = hung();
      const t0 = Date.now();
      await persistParkRegularHours("mk", fresh(), { instant: NOW, executor: h.exec, deadlineMs: 30, clock });
      check("bounded: hung write returns at the deadline", Date.now() - t0 < 1000 && h.x.runs === 1);
      check("bounded: hung write is aborted (underlying work torn down)", h.x.aborts === 1);

      // repeated requests during cooldown never touch the DB
      for (let i = 0; i < 25; i++) { t += 1000; await persistParkRegularHours("mk", fresh(), { instant: NOW, executor: h.exec, deadlineMs: 30, clock }); }
      check("bounded: repeated requests after timeout make no DB attempts (cooldown)", h.x.runs === 1);

      // cooldown over but DB still hung → exactly one more attempt, aborted again; never >1 active
      for (let cycle = 0; cycle < 4; cycle++) {
        t += 61_000;
        await persistParkRegularHours("mk", fresh(), { instant: NOW, executor: h.exec, deadlineMs: 20, clock });
      }
      check("bounded: permanently hung DB → one attempt per cooldown, all aborted, none accumulate", h.x.runs === 5 && h.x.aborts === 5 && h.x.maxActive === 1);

      // recovery
      t += 61_000;
      const good = mkExec((fn) => fn(okQ));
      const batch = fresh();
      await persistParkRegularHours("mk", batch, { instant: NOW, executor: good.exec, deadlineMs: 200, clock });
      check("bounded: recovers after cooldown when the DB is healthy", good.x.runs === 1 && good.x.aborts === 0);
      await persistParkRegularHours("mk", batch, { instant: NOW, executor: good.exec, deadlineMs: 200, clock });
      check("bounded: recovered write is memoized (no redundant attempt)", good.x.runs === 1);

      // failure (not timeout) also cools down and recovers
      resetParkHoursStoreState();
      const bad = mkExec(async () => { throw new Error("boom"); });
      await persistParkRegularHours("mk", fresh(), { instant: NOW, executor: bad.exec, clock });
      await persistParkRegularHours("mk", fresh(), { instant: NOW, executor: bad.exec, clock });
      check("bounded: rejected write cools down", bad.x.runs === 1);
      t += 61_000;
      await persistParkRegularHours("mk", fresh(), { instant: NOW, executor: good.exec, clock });
      check("bounded: recovery after a rejected write", good.x.runs === 2);

      // concurrent callers: single-flight
      resetParkHoursStoreState();
      const slow = mkExec((fn) => new Promise((resolve, reject) => setTimeout(() => fn(okQ).then(resolve, reject), 60)));
      const results = await Promise.all(Array.from({ length: 12 }, () => persistParkRegularHours("mk", fresh(), { instant: NOW, executor: slow.exec, deadlineMs: 500, clock })));
      check("bounded: concurrent callers share one in-flight attempt and all resolve", results.length === 12 && slow.x.runs === 1 && slow.x.maxActive === 1);
      await persistParkRegularHours("mk", [resp([ent("2026-10-15", "08:00", "21:00")], { fetchedAt: T + 1000 * ++n })], { instant: NOW, executor: slow.exec, deadlineMs: 500, clock });
      check("bounded: gate reopens after completion", slow.x.runs === 2);

      // late completion of an abandoned attempt must not poison state
      resetParkHoursStoreState();
      let release: (() => void) | undefined;
      const late = mkExec(() => new Promise<void>((resolve) => { release = resolve; }));
      const lateBatch = fresh();
      await persistParkRegularHours("mk", lateBatch, { instant: NOW, executor: late.exec, deadlineMs: 20, clock });
      release?.();
      await new Promise((r) => setTimeout(r, 10));
      t += 61_000;
      const retry = mkExec((fn) => fn(okQ));
      await persistParkRegularHours("mk", lateBatch, { instant: NOW, executor: retry.exec, clock });
      check("bounded: late completion of an abandoned write does not mark records as stored", retry.x.runs === 1);

      // work that never reaches the DB (nothing eligible) takes no gate and no connection
      resetParkHoursStoreState();
      const idle = mkExec((fn) => fn(okQ));
      await persistParkRegularHours("mk", [{ coverage: "month", result: { ok: false, error: { kind: "timeout", message: "t" } } }], { instant: NOW, executor: idle.exec, clock });
      check("bounded: failed provider response never acquires an executor run", idle.x.runs === 0);
    } finally { console.warn = warn2; }
  }

  // --- real pool executor: abort destroys the connection and cancels the query ---
  if (realPool) {
    const pool = realPool;
    const exec = createPoolExecutor(pool);
    const started = Date.now();
    // The server cannot be relied on to notice a dropped socket mid-query; statement_timeout is
    // the server-side guarantee, so use a short one here to keep the check fast.
    const p = exec.run(async (q) => { await q.query("SET LOCAL statement_timeout = 400"); return q.query("SELECT pg_sleep(30)"); }).then(() => "done", (e) => `err:${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 150));
    exec.abort();
    const outcome = await Promise.race([p, new Promise<string>((r) => setTimeout(() => r("still-hung"), 3000))]);
    check("pool: abort rejects the in-flight run promptly", outcome.startsWith("err:") && Date.now() - started < 3000);
    await new Promise((r) => setTimeout(r, 1000));
    const probe = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(30)%' AND state = 'active'`);
    check("pool: server-side query is gone after abort", Number(probe.rows[0].n) === 0);
    const ok = await createPoolExecutor(pool).run((q) => q.query("SELECT 1 AS x"));
    check("pool: connection slot is reusable after abort", ok.rows[0].x === 1);
    const exec2 = createPoolExecutor(pool);
    let timedOut = false;
    await exec2.run(async (q) => { await q.query("SET LOCAL statement_timeout = 100"); return q.query("SELECT pg_sleep(5)"); }).catch(() => { timedOut = true; });
    check("pool: statement_timeout failure destroys and frees the slot", timedOut && (await createPoolExecutor(pool).run((q) => q.query("SELECT 2 AS x"))).rows[0].x === 2);
  }

  // --- SQL semantics (real disposable Postgres) ---
  if (realDb) {
    const db = realDb;
    const count = async () => Number((await db.query(`SELECT count(*)::int AS n FROM park_regular_hours`)).rows[0].n);
    const get = async (d: string) => (await readStoredRegularHours(db, "mk", d, d))[0];
    await db.query(`DELETE FROM park_regular_hours`);
    resetParkHoursStoreState();
    const r1 = build([resp([ent("2026-10-15"), ent("2026-10-16", "09:00", "02:00")])]);
    check("sql: first write inserts all rows", (await upsertRegularHours(db, r1)) === 2 && (await count()) === 2);
    check("sql: replay of same batch is a no-op (idempotent)", (await upsertRegularHours(db, r1)) === 0);
    const row = await get("2026-10-16");
    check("sql: overnight window round-trips", row?.windows[0].closes === "2026-10-17T06:00:00.000Z" && row.sourceFetchedAt === T);
    const older = build([resp([ent("2026-10-15", "07:00", "22:00")], { fetchedAt: T - 5000 })]);
    check("sql: older fetch never replaces newer row", (await upsertRegularHours(db, older)) === 0 && (await get("2026-10-15")).windows[0].opens === "2026-10-15T13:00:00.000Z");
    const sameTime = build([resp([ent("2026-10-15", "07:00", "22:00")], { fetchedAt: T })]);
    check("sql: equal fetch time never replaces (stable under ties)", (await upsertRegularHours(db, sameTime)) === 0);
    const newerSame = buildRegularHoursRecords("mk", [resp([ent("2026-10-15")], { fetchedAt: T + 3600_000 })], new Date(T + 3600_000));
    const before = await get("2026-10-15");
    check("sql: newer identical observation advances freshness only (content untouched)",
      (await upsertRegularHours(db, newerSame)) === 1 &&
      (await get("2026-10-15")).sourceFetchedAt === T + 3600_000 &&
      JSON.stringify((await get("2026-10-15")).windows) === JSON.stringify(before.windows) &&
      (await get("2026-10-15")).coverage === before.coverage);
    check("sql: replaying the same observation is a no-op (idempotent)", (await upsertRegularHours(db, newerSame)) === 0);
    check("sql: older identical observation is a no-op", (await upsertRegularHours(db, build([resp([ent("2026-10-15")], { fetchedAt: T + 1000 })]))) === 0);
    const changedRecs = buildRegularHoursRecords("mk", [resp([ent("2026-10-15", "08:00", "23:00")], { fetchedAt: T + 8 * 3600_000 })], new Date(T + 8 * 3600_000));
    check("sql: newer changed data replaces", (await upsertRegularHours(db, changedRecs)) === 1 && (await get("2026-10-15")).windows[0].opens === "2026-10-15T12:00:00.000Z");
    // Regression (Codex P2): A(t0), A(t2), B(t1) must end as A@t2 in EVERY arrival order.
    {
      const A = (t: number) => buildRegularHoursRecords("mk", [resp([ent("2026-10-25", "09:00", "22:00")], { fetchedAt: t })], new Date(t));
      const B = (t: number) => buildRegularHoursRecords("mk", [resp([ent("2026-10-25", "08:00", "23:00")], { fetchedAt: t })], new Date(t));
      const t0 = T, t1 = T + 60_000, t2 = T + 120_000;
      const orders: Array<Array<[string, () => RegularHoursRecord[]]>> = [
        [["A0", () => A(t0)], ["A2", () => A(t2)], ["B1", () => B(t1)]],
        [["A0", () => A(t0)], ["B1", () => B(t1)], ["A2", () => A(t2)]],
        [["B1", () => B(t1)], ["A2", () => A(t2)], ["A0", () => A(t0)]],
        [["A2", () => A(t2)], ["B1", () => B(t1)], ["A0", () => A(t0)]],
        [["B1", () => B(t1)], ["A0", () => A(t0)], ["A2", () => A(t2)]],
        [["A2", () => A(t2)], ["A0", () => A(t0)], ["B1", () => B(t1)]],
      ];
      let bad = "";
      for (const order of orders) {
        await db.query(`DELETE FROM park_regular_hours WHERE hours_date = '2026-10-25'`);
        for (const [, mk] of order) await upsertRegularHours(db, mk()); // independent writers, sequential arrival
        const row = (await readStoredRegularHours(db, "mk", "2026-10-25", "2026-10-25"))[0];
        if (!row || row.windows[0].opens !== "2026-10-25T13:00:00.000Z" || row.sourceFetchedAt !== t2) bad += order.map((o) => o[0]).join(">") + " ";
      }
      check("sql: A(t0), A(t2), B(t1) ends as A@t2 for every arrival order (sequential writers)" + (bad ? ` [bad: ${bad}]` : ""), bad === "");
      // truly concurrent independent writers, repeated to shake out lock ordering
      let badC = 0;
      for (let k = 0; k < 20; k++) {
        await db.query(`DELETE FROM park_regular_hours WHERE hours_date = '2026-10-25'`);
        await Promise.all([A(t0), A(t2), B(t1)].sort(() => Math.random() - 0.5).map((recs) => upsertRegularHours(db, recs)));
        const row = (await readStoredRegularHours(db, "mk", "2026-10-25", "2026-10-25"))[0];
        if (!row || row.windows[0].opens !== "2026-10-25T13:00:00.000Z" || row.sourceFetchedAt !== t2) badC++;
      }
      check("sql: concurrent independent writers A(t0), A(t2), B(t1) never end on B", badC === 0);
      // via the opportunistic entry point with separate "instances" (state reset between = different process memo)
      await db.query(`DELETE FROM park_regular_hours WHERE hours_date = '2026-10-25'`);
      for (const [resps, at] of [[[resp([ent("2026-10-25", "09:00", "22:00")], { fetchedAt: t0 })], t0], [[resp([ent("2026-10-25", "09:00", "22:00")], { fetchedAt: t2 })], t2], [[resp([ent("2026-10-25", "08:00", "23:00")], { fetchedAt: t1 })], t1]] as const) {
        resetParkHoursStoreState();
        await persistParkRegularHours("mk", [...resps], { instant: new Date(at), db });
      }
      const via = (await readStoredRegularHours(db, "mk", "2026-10-25", "2026-10-25"))[0];
      check("sql: persist entry point across independent instances keeps A@t2", via?.sourceFetchedAt === t2 && via.windows[0].opens === "2026-10-25T13:00:00.000Z");
    }
    // concurrency: many parallel writers of overlapping batches, mixed freshness
    await db.query(`DELETE FROM park_regular_hours`);
    const base = Array.from({ length: 6 }, (_, i) => `2026-10-${String(15 + i).padStart(2, "0")}`);
    const writers = Array.from({ length: 24 }, (_, i) => {
      const dates = i % 2 ? base : base.slice().reverse();
      const at = T + i * 1000;
      return upsertRegularHours(db, buildRegularHoursRecords("mk", [resp(dates.map((d) => ent(d, i % 3 === 0 ? "09:00" : "10:00", "22:00")), { fetchedAt: at })], new Date(at)));
    });
    let concErr = false;
    await Promise.all(writers).catch(() => { concErr = true; });
    const rows = await readStoredRegularHours(db, "mk", "2026-10-15", "2026-10-20");
    check("sql: concurrent writers: no error, one row per date", !concErr && rows.length === 6 && (await count()) === 6);
    // Writer 23 (newest) has 10:00 windows; identical newer data is intentionally not rewritten,
    // so assert convergence on the newest CONTENT, never on a stale (older-content) writer.
    check("sql: concurrent writers converge on the newest content", rows.every((r) => r.windows[0].opens.endsWith("T14:00:00.000Z") && r.sourceFetchedAt >= T + 22 * 1000));
    // retention
    await db.query(`DELETE FROM park_regular_hours`);
    await db.query(
      `INSERT INTO park_regular_hours (park_id, hours_date, windows, windows_hash, coverage, source_fetched_at)
       VALUES ('mk','2026-10-07','[{"opens":"a","closes":"b"}]','h','month',NOW()),
              ('mk','2026-10-08','[{"opens":"a","closes":"b"}]','h','month',NOW()),
              ('ep','2026-10-01','[{"opens":"a","closes":"b"}]','h','month',NOW())`,
    );
    const del = await deleteExpiredRegularHours(db, "mk", retentionCutoffDate("WDW", NOW));
    const left = (await db.query(`SELECT park_id, to_char(hours_date,'YYYY-MM-DD') AS d FROM park_regular_hours ORDER BY 1,2`)).rows.map((r) => `${r.park_id}:${r.d}`).join();
    check("sql: retention deletes only this park's rows older than cutoff", del === 1 && left === "ep:2026-10-01,mk:2026-10-08");
    let emptyRejected = false;
    try { await db.query(`INSERT INTO park_regular_hours (park_id, hours_date, windows, windows_hash, coverage, source_fetched_at) VALUES ('mk','2026-11-01','[]','h','month',NOW())`); } catch { emptyRejected = true; }
    check("sql: empty window set rejected by CHECK (no closure inference)", emptyRejected);
    // end-to-end through the opportunistic entry point
    await db.query(`DELETE FROM park_regular_hours`);
    resetParkHoursStoreState();
    await persistParkRegularHours("mk", [resp([ent("2026-10-15"), ent("2026-10-06")])], { instant: NOW, db });
    const e2e = await readStoredRegularHours(db, "mk", "2026-10-01", "2026-10-31");
    check("sql: persist entry point writes valid, skips expired", e2e.length === 1 && e2e[0].date === "2026-10-15");
  }
  return failures;
}

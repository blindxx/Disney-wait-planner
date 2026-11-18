/**
 * entertainmentLifecycleStore.ts — Phase 14.5C Postgres persistence for the
 * active entertainment lifecycle (schema: db-schema.sql, verified by
 * scripts/migrate-db.mjs). Server-only. Pure decisions live in
 * entertainmentLifecycleDetector.ts; this module only reads/writes rows.
 *
 * WRITE side (the scheduled monitor only), always inside ONE transaction that
 * holds a per-park advisory lock, so two overlapping cron deliveries serialize
 * (the second reports "busy") instead of interleaving:
 *  - `upsertObservations`: per (show, resort-local date); a stronger class
 *    (unknown < silent < inactive < active) replaces a weaker one, never the
 *    reverse; a repeat of the same class only bumps the counter. So duplicate
 *    deliveries and late (history backfill) data are idempotent and
 *    order-independent, and an `active` day can never be downgraded.
 *  - `writeState` is guarded by `evaluated_local_date`: a delayed run for an
 *    EARLIER date can never overwrite a newer evaluation.
 *  - `insertEvent` has a natural key (park, show, type, date): a repeated
 *    decision is a no-op. Events are the audit trail (see readLifecycleAudit).
 *
 * Phase 14.5D: LEGACY identities use the same tables (status `legacy_comeback` / `legacy_hidden`, events
 * `legacy_comeback` / `legacy_rehide`); `getLifecycleVisibilityState` also returns the persisted legacy comebacks.
 *
 * READ side for the entertainment APIs (`getLifecycleAutoHidden`): best-effort,
 * bounded, cached, and FAIL OPEN — any problem returns `undefined` ("unknown"),
 * which hides nothing automatic. It reuses the dedicated one-connection pool
 * (never the auth/planner pool), like parkHoursStore's bounded reads.
 */

import type { ParkId } from "@disney-wait-planner/shared";
import { getParkHoursPool } from "./db";
import {
  LIFECYCLE_CLASS_RANK,
  type LifecycleAuditFlag,
  type LifecycleDayClass,
  type LifecycleShowState,
  type PlannedLifecycleEvent,
  type ShowDayObservation,
} from "./entertainmentLifecycleDetector";
import { createPoolExecutor, type PersistExecutor, type Queryable } from "./parkHoursStore";
import type { DiscoveredLegacyIdentity } from "./themeParksEntertainmentMapping";

// ============================================
// WRITE SIDE
// ============================================

/** Per-park transaction-scoped advisory lock. false = another run holds it. */
export async function tryLifecycleLock(q: Queryable, parkId: ParkId): Promise<boolean> {
  const res = await q.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok", [`dwp:entertainment-lifecycle:${parkId}`]);
  return res.rows[0]?.ok === true;
}

export async function upsertObservations(q: Queryable, observations: ShowDayObservation[]): Promise<void> {
  // Replacement rule (order-independent, idempotent): an `active` row is never replaced; a new `active` always replaces;
  // otherwise a FINAL row replaces a provisional one, and between equally-final rows the stronger class wins.
  for (const o of observations) {
    await q.query(
      `INSERT INTO entertainment_lifecycle_evidence AS e
         (park_id, show_key, local_date, show_name, day_class, class_rank, is_final, basis, performance_count, source, limitations)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (park_id, show_key, local_date) DO UPDATE SET
         show_name = EXCLUDED.show_name,
         day_class = CASE WHEN e.class_rank < 4 AND (EXCLUDED.class_rank = 4 OR (EXCLUDED.is_final AND NOT e.is_final)
                          OR (EXCLUDED.is_final = e.is_final AND EXCLUDED.class_rank > e.class_rank)) THEN EXCLUDED.day_class ELSE e.day_class END,
         basis = CASE WHEN e.class_rank < 4 AND (EXCLUDED.class_rank = 4 OR (EXCLUDED.is_final AND NOT e.is_final)
                      OR (EXCLUDED.is_final = e.is_final AND EXCLUDED.class_rank > e.class_rank)) THEN EXCLUDED.basis ELSE e.basis END,
         source = CASE WHEN e.class_rank < 4 AND (EXCLUDED.class_rank = 4 OR (EXCLUDED.is_final AND NOT e.is_final)
                       OR (EXCLUDED.is_final = e.is_final AND EXCLUDED.class_rank > e.class_rank)) THEN EXCLUDED.source ELSE e.source END,
         limitations = CASE WHEN e.class_rank < 4 AND (EXCLUDED.class_rank = 4 OR (EXCLUDED.is_final AND NOT e.is_final)
                            OR (EXCLUDED.is_final = e.is_final AND EXCLUDED.class_rank > e.class_rank)) THEN EXCLUDED.limitations ELSE e.limitations END,
         performance_count = CASE
           WHEN e.class_rank < 4 AND (EXCLUDED.class_rank = 4 OR (EXCLUDED.is_final AND NOT e.is_final)
                OR (EXCLUDED.is_final = e.is_final AND EXCLUDED.class_rank > e.class_rank)) THEN EXCLUDED.performance_count
           WHEN e.class_rank = 4 AND EXCLUDED.class_rank = 4 THEN GREATEST(e.performance_count, EXCLUDED.performance_count)
           ELSE e.performance_count END,
         class_rank = CASE WHEN e.class_rank < 4 AND (EXCLUDED.class_rank = 4 OR (EXCLUDED.is_final AND NOT e.is_final)
                           OR (EXCLUDED.is_final = e.is_final AND EXCLUDED.class_rank > e.class_rank)) THEN EXCLUDED.class_rank ELSE e.class_rank END,
         is_final = e.is_final OR EXCLUDED.is_final,
         observation_count = e.observation_count + 1,
         last_observed_at = NOW()`,
      [o.parkId, o.showKey, o.localDate, o.showName, o.dayClass, LIFECYCLE_CLASS_RANK[o.dayClass], o.final, o.basis, o.performanceCount, o.source, JSON.stringify(o.limitations)],
    );
  }
}

export interface StoredEvidenceRow { showKey: string; localDate: string; dayClass: LifecycleDayClass; basis: string | null; performanceCount: number; final: boolean }

export async function readEvidence(q: Queryable, parkId: ParkId, from: string, to: string): Promise<StoredEvidenceRow[]> {
  const res = await q.query(
    `SELECT show_key, to_char(local_date, 'YYYY-MM-DD') AS d, day_class, basis, performance_count, is_final
     FROM entertainment_lifecycle_evidence
     WHERE park_id = $1 AND local_date >= $2::date AND local_date <= $3::date`,
    [parkId, from, to],
  );
  return res.rows.map((r) => ({
    showKey: String(r.show_key), localDate: String(r.d), dayClass: String(r.day_class) as LifecycleDayClass,
    basis: r.basis == null ? null : String(r.basis), performanceCount: Number(r.performance_count), final: r.is_final !== false,
  }));
}

export interface StoredLifecycleState extends LifecycleShowState {
  showKey: string;
  showName: string;
  hiddenAt: string | null;
  restoredAt: string | null;
  silenceFlaggedAt: string | null;
  registryRestoredAt: string | null;
  inactiveDays: number;
  dormantDays: number;
  silentDays: number;
  evaluatedLocalDate: string | null;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string | Date).toISOString());
const dateOrNull = (v: unknown): string | null => (v == null ? null : String(v));

export async function readStates(q: Queryable, parkId: ParkId): Promise<Map<string, StoredLifecycleState>> {
  const res = await q.query(
    `SELECT show_key, show_name, status,
            to_char(cycle_reset_date, 'YYYY-MM-DD') AS cycle_reset_date,
            to_char(last_active_date, 'YYYY-MM-DD') AS last_active_date,
            to_char(hidden_local_date, 'YYYY-MM-DD') AS hidden_local_date,
            hidden_at, restored_at, hide_count, restore_count, inactive_days, dormant_days, silent_days,
            silence_flagged_at, registry_restored_at, to_char(secondary_evaluated_on, 'YYYY-MM-DD') AS secondary_evaluated_on,
            audit_flag, to_char(evaluated_local_date, 'YYYY-MM-DD') AS evaluated_local_date
     FROM entertainment_lifecycle_state WHERE park_id = $1`,
    [parkId],
  );
  const out = new Map<string, StoredLifecycleState>();
  for (const r of res.rows) {
    out.set(String(r.show_key), {
      showKey: String(r.show_key), showName: String(r.show_name),
      status: r.status === "auto_hidden" || r.status === "legacy_comeback" || r.status === "legacy_hidden" ? (r.status as StoredLifecycleState["status"]) : "visible",
      cycleResetDate: dateOrNull(r.cycle_reset_date), lastActiveDate: dateOrNull(r.last_active_date),
      hiddenLocalDate: dateOrNull(r.hidden_local_date), hiddenAt: iso(r.hidden_at), restoredAt: iso(r.restored_at),
      hideCount: Number(r.hide_count), restoreCount: Number(r.restore_count),
      inactiveDays: Number(r.inactive_days), dormantDays: Number(r.dormant_days), silentDays: Number(r.silent_days),
      registryRestored: r.registry_restored_at != null, registryRestoredAt: iso(r.registry_restored_at),
      silenceFlagged: r.silence_flagged_at != null, silenceFlaggedAt: iso(r.silence_flagged_at),
      secondaryEvaluatedOn: dateOrNull(r.secondary_evaluated_on),
      auditFlag: (r.audit_flag as LifecycleAuditFlag | null) ?? null,
      evaluatedLocalDate: dateOrNull(r.evaluated_local_date),
    });
  }
  return out;
}

/** Newer-evaluation-wins upsert: a delayed run for an earlier resort-local date never overwrites a later one. */
export async function writeState(q: Queryable, parkId: ParkId, s: StoredLifecycleState): Promise<boolean> {
  const res = await q.query(
    `INSERT INTO entertainment_lifecycle_state AS st
       (park_id, show_key, show_name, status, cycle_reset_date, last_active_date, hidden_local_date, hidden_at, restored_at,
        hide_count, restore_count, inactive_days, dormant_days, silent_days, silence_flagged_at, registry_restored_at,
        secondary_evaluated_on, audit_flag, evaluated_local_date, updated_at)
     VALUES ($1, $2, $3, $4, $5::date, $6::date, $7::date, $8::timestamptz, $9::timestamptz,
             $10, $11, $12, $13, $14, $15::timestamptz, $16::timestamptz, $17::date, $18, $19::date, NOW())
     ON CONFLICT (park_id, show_key) DO UPDATE SET
       show_name = EXCLUDED.show_name, status = EXCLUDED.status, cycle_reset_date = EXCLUDED.cycle_reset_date,
       last_active_date = EXCLUDED.last_active_date, hidden_local_date = EXCLUDED.hidden_local_date,
       hidden_at = EXCLUDED.hidden_at, restored_at = EXCLUDED.restored_at, hide_count = EXCLUDED.hide_count,
       restore_count = EXCLUDED.restore_count, inactive_days = EXCLUDED.inactive_days, dormant_days = EXCLUDED.dormant_days,
       silent_days = EXCLUDED.silent_days, silence_flagged_at = EXCLUDED.silence_flagged_at,
       registry_restored_at = EXCLUDED.registry_restored_at, secondary_evaluated_on = EXCLUDED.secondary_evaluated_on,
       audit_flag = EXCLUDED.audit_flag, evaluated_local_date = EXCLUDED.evaluated_local_date, updated_at = NOW()
     WHERE st.evaluated_local_date IS NULL OR st.evaluated_local_date <= EXCLUDED.evaluated_local_date`,
    [
      parkId, s.showKey, s.showName, s.status, s.cycleResetDate, s.lastActiveDate, s.hiddenLocalDate, s.hiddenAt, s.restoredAt,
      s.hideCount, s.restoreCount, s.inactiveDays, s.dormantDays, s.silentDays, s.silenceFlaggedAt, s.registryRestoredAt,
      s.secondaryEvaluatedOn, s.auditFlag, s.evaluatedLocalDate,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function insertEvent(q: Queryable, parkId: ParkId, showKey: string, showName: string, e: PlannedLifecycleEvent): Promise<void> {
  await q.query(
    `INSERT INTO entertainment_lifecycle_events (park_id, show_key, event_type, local_date, show_name, evidence, coverage_limitations)
     VALUES ($1, $2, $3, $4::date, $5, $6::jsonb, $7::jsonb)
     ON CONFLICT (park_id, show_key, event_type, local_date) DO NOTHING`,
    [parkId, showKey, e.type, e.localDate, showName, JSON.stringify(e.evidence), JSON.stringify(e.coverageLimitations)],
  );
}

/**
 * Like `insertEvent`, but also a no-op when an event of the same (park, show, type) with IDENTICAL evidence
 * already exists on any date — a standing identity conflict is flagged once, not re-flagged every run.
 */
export async function insertEventOnce(q: Queryable, parkId: ParkId, showKey: string, showName: string, e: PlannedLifecycleEvent): Promise<void> {
  await q.query(
    `INSERT INTO entertainment_lifecycle_events (park_id, show_key, event_type, local_date, show_name, evidence, coverage_limitations)
     SELECT $1, $2, $3, $4::date, $5, $6::jsonb, $7::jsonb
     WHERE NOT EXISTS (SELECT 1 FROM entertainment_lifecycle_events WHERE park_id = $1 AND show_key = $2 AND event_type = $3 AND evidence = $6::jsonb)
     ON CONFLICT (park_id, show_key, event_type, local_date) DO NOTHING`,
    [parkId, showKey, e.type, e.localDate, showName, JSON.stringify(e.evidence), JSON.stringify(e.coverageLimitations)],
  );
}

export async function pruneEvidence(q: Queryable, parkId: ParkId, before: string): Promise<void> {
  await q.query("DELETE FROM entertainment_lifecycle_evidence WHERE park_id = $1 AND local_date < $2::date", [parkId, before]);
}

// ============================================
// LEGACY PROVIDER IDENTITIES (Phase 14.5D follow-up)
// ============================================

/**
 * Validated discovered provider identities for legacy shows (`entertainment_legacy_identity`). One
 * `validated` row per (park, show) and per (park, entity) is enforced by partial unique indexes; a
 * replaced identity stays as `superseded` (history). Written only by the monitor inside its locked
 * transaction; rows are never edited by requests. Keyed by the park-qualified canonical show key, so
 * evidence/comeback history stays attached to the same show across a provider UUID change.
 */
export async function readLegacyIdentities(q: Queryable, parkId?: ParkId): Promise<DiscoveredLegacyIdentity[]> {
  const res = await q.query(
    `SELECT park_id, show_name, entity_id, provider_name FROM entertainment_legacy_identity
     WHERE status = 'validated' ${parkId ? "AND park_id = $1" : ""} ORDER BY park_id, show_name`,
    parkId ? [parkId] : [],
  );
  return res.rows.map((r) => ({ parkId: String(r.park_id) as ParkId, name: String(r.show_name), entityId: String(r.entity_id), providerName: String(r.provider_name) }));
}

export async function supersedeLegacyIdentity(q: Queryable, parkId: ParkId, showKey: string, entityId: string): Promise<void> {
  await q.query(
    `UPDATE entertainment_legacy_identity SET status = 'superseded', superseded_at = NOW()
     WHERE park_id = $1 AND show_key = $2 AND entity_id = $3 AND status = 'validated'`,
    [parkId, showKey, entityId],
  );
}

/** Idempotent: a repeat of an already-validated (park, show, entity) is a no-op; a previously superseded entity that returns is REACTIVATED (its row is kept, never duplicated). */
export async function insertLegacyIdentity(q: Queryable, parkId: ParkId, showKey: string, id: DiscoveredLegacyIdentity, localDate: string): Promise<boolean> {
  const res = await q.query(
    `INSERT INTO entertainment_legacy_identity (park_id, show_key, show_name, entity_id, entity_type, provider_name, status, first_validated_date)
     VALUES ($1, $2, $3, $4, 'SHOW', $5, 'validated', $6::date)
     ON CONFLICT (park_id, show_key, entity_id) DO UPDATE SET
       status = 'validated', superseded_at = NULL, validated_at = NOW(), provider_name = EXCLUDED.provider_name
     WHERE entertainment_legacy_identity.status = 'superseded'`,
    [parkId, showKey, id.name, id.entityId, id.providerName, localDate],
  );
  return (res.rowCount ?? 0) > 0;
}

// ============================================
// AUDIT READ (server-key-protected route)
// ============================================

export interface LifecycleAuditReport {
  hidden: Array<{ parkId: string; showName: string; hiddenLocalDate: string | null; hiddenAt: string | null; hideCount: number; restoreCount: number; auditFlag: string | null }>;
  /** Phase 14.5D: legacy catalog shows currently surfaced by the automatic comeback rule (awaiting audit review; catalog unchanged). */
  legacyComebacks: Array<{ parkId: string; showName: string; restoredAt: string | null; comebackCount: number; rehideCount: number; lastActiveDate: string | null }>;
  /** Unresolved candidates: flagged states (silence, registry conflict). */
  flagged: Array<{ parkId: string; showName: string; auditFlag: string; silentDays: number; inactiveDays: number; status: string; silenceFlaggedAt: string | null }>;
  /** Decisions awaiting the research audit (audit_status = 'unreviewed'), newest first. */
  unreviewedEvents: Array<{ parkId: string; showName: string; eventType: string; localDate: string; occurredAt: string; evidence: unknown; coverageLimitations: unknown }>;
}

export async function readLifecycleAudit(q: Queryable, limit = 200): Promise<LifecycleAuditReport> {
  // Sequential: one client runs one query at a time (pg deprecates overlapping queries).
  const h = await q.query(`SELECT park_id, show_name, to_char(hidden_local_date, 'YYYY-MM-DD') AS d, hidden_at, hide_count, restore_count, audit_flag
             FROM entertainment_lifecycle_state WHERE status = 'auto_hidden' ORDER BY hidden_at`);
  const lc = await q.query(`SELECT park_id, show_name, restored_at, restore_count, hide_count, to_char(last_active_date, 'YYYY-MM-DD') AS d
             FROM entertainment_lifecycle_state WHERE status = 'legacy_comeback' ORDER BY restored_at`);
  const f = await q.query(`SELECT park_id, show_name, audit_flag, silent_days, inactive_days, status, silence_flagged_at
             FROM entertainment_lifecycle_state WHERE audit_flag IS NOT NULL ORDER BY park_id, show_name`);
  const ev = await q.query(`SELECT park_id, show_name, event_type, to_char(local_date, 'YYYY-MM-DD') AS d, occurred_at, evidence, coverage_limitations
             FROM entertainment_lifecycle_events WHERE audit_status = 'unreviewed' ORDER BY occurred_at DESC LIMIT $1`, [limit]);
  return {
    hidden: h.rows.map((r) => ({ parkId: String(r.park_id), showName: String(r.show_name), hiddenLocalDate: dateOrNull(r.d), hiddenAt: iso(r.hidden_at), hideCount: Number(r.hide_count), restoreCount: Number(r.restore_count), auditFlag: r.audit_flag == null ? null : String(r.audit_flag) })),
    legacyComebacks: lc.rows.map((r) => ({ parkId: String(r.park_id), showName: String(r.show_name), restoredAt: iso(r.restored_at), comebackCount: Number(r.restore_count), rehideCount: Number(r.hide_count), lastActiveDate: dateOrNull(r.d) })),
    flagged: f.rows.map((r) => ({ parkId: String(r.park_id), showName: String(r.show_name), auditFlag: String(r.audit_flag), silentDays: Number(r.silent_days), inactiveDays: Number(r.inactive_days), status: String(r.status), silenceFlaggedAt: iso(r.silence_flagged_at) })),
    unreviewedEvents: ev.rows.map((r) => ({ parkId: String(r.park_id), showName: String(r.show_name), eventType: String(r.event_type), localDate: String(r.d), occurredAt: iso(r.occurred_at) ?? "", evidence: r.evidence, coverageLimitations: r.coverage_limitations })),
  };
}

// ============================================
// REQUEST-PATH READ (fail open, cached, bounded)
// ============================================

const READ_DEADLINE_MS = 1000;
const CACHE_TTL_MS = 60_000;
/** A good answer may bridge a database blip for this long; beyond it the list is "unknown" (hides nothing). */
const STALE_OK_MS = 10 * 60_000;
const FAILURE_COOLDOWN_MS = 60_000;

/** `legacyComebacks` (Phase 14.5D): legacy catalog names currently persisted as comebacks (status `legacy_comeback`). */
export interface LifecycleVisibilityState {
  autoHidden: string[];
  registryRestored: string[];
  legacyComebacks: string[];
  /** Persisted validated legacy provider identities for the park (14.5D follow-up); empty when none/unknown. */
  legacyIdentities: DiscoveredLegacyIdentity[];
}

let cache: { at: number; byPark: Map<string, LifecycleVisibilityState> } | null = null;
let inflight: Promise<void> | null = null;
let blockedUntil = 0;

export function resetLifecycleReadState(): void { cache = null; inflight = null; blockedUntil = 0; }

async function refresh(clock: () => number, executor: PersistExecutor, deadlineMs: number, identityExecutor?: () => PersistExecutor | null): Promise<void> {
  let failed = false;
  const work = executor
    .run((q) => q.query("SELECT park_id, show_name, status, (registry_restored_at IS NOT NULL) AS restored FROM entertainment_lifecycle_state WHERE status IN ('auto_hidden', 'legacy_comeback') OR registry_restored_at IS NOT NULL ORDER BY park_id, show_name"))
    .catch(() => { failed = true; return null; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const res = await Promise.race([work, new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), deadlineMs); })]);
  if (timer) clearTimeout(timer);
  if (res === "timeout") { try { executor.abort(); } catch { /* best effort */ } blockedUntil = clock() + FAILURE_COOLDOWN_MS; return; }
  if (failed || !res) { blockedUntil = clock() + FAILURE_COOLDOWN_MS; return; }
  const byPark = new Map<string, LifecycleVisibilityState>();
  // Identities: separate, best-effort, bounded transaction (any failure → none; active lifecycle visibility is unaffected).
  let identities: DiscoveredLegacyIdentity[] = [];
  const idExec = identityExecutor?.() ?? null;
  if (idExec) {
    let idTimer: ReturnType<typeof setTimeout> | undefined;
    const idWork = idExec.run((q) => readLegacyIdentities(q)).catch(() => null);
    const idRes = await Promise.race([idWork, new Promise<"timeout">((r) => { idTimer = setTimeout(() => r("timeout"), deadlineMs); })]);
    if (idTimer) clearTimeout(idTimer);
    if (idRes === "timeout") { try { idExec.abort(); } catch { /* best effort */ } }
    else if (Array.isArray(idRes)) identities = idRes;
  }
  for (const id of identities) {
    const cur = byPark.get(id.parkId) ?? { autoHidden: [], registryRestored: [], legacyComebacks: [], legacyIdentities: [] };
    cur.legacyIdentities.push(id);
    byPark.set(id.parkId, cur);
  }
  for (const r of res.rows) {
    const k = String(r.park_id);
    const cur = byPark.get(k) ?? { autoHidden: [], registryRestored: [], legacyComebacks: [], legacyIdentities: [] };
    if (r.status === "auto_hidden") cur.autoHidden.push(String(r.show_name));
    if (r.status === "legacy_comeback") cur.legacyComebacks.push(String(r.show_name));
    if (r.restored === true) cur.registryRestored.push(String(r.show_name));
    byPark.set(k, cur);
  }
  cache = { at: clock(), byPark };
}

/**
 * Persisted lifecycle visibility state for a park (auto-hidden names + durably
 * restored registry hides), or `undefined` when unknown. NEVER throws and never
 * blocks past `deadlineMs`: unknown (no DATABASE_URL, DB down, timeout, cooldown)
 * means "hide nothing automatic" — fail open.
 */
export async function getLifecycleVisibilityState(
  parkId: ParkId,
  opts: { clock?: () => number; executor?: PersistExecutor; deadlineMs?: number } = {},
): Promise<LifecycleVisibilityState | undefined> {
  try {
    const clock = opts.clock ?? Date.now;
    const fresh = cache && clock() - cache.at < CACHE_TTL_MS;
    if (!fresh && clock() >= blockedUntil) {
      if (!inflight) {
        let executor = opts.executor ?? null;
        if (!executor && process.env.DATABASE_URL) executor = createPoolExecutor(getParkHoursPool());
        if (executor) {
          const injected = opts.executor;
          const idFactory = () => injected ?? (process.env.DATABASE_URL ? createPoolExecutor(getParkHoursPool()) : null);
          const run = refresh(clock, executor, opts.deadlineMs ?? READ_DEADLINE_MS, idFactory).catch(() => { blockedUntil = clock() + FAILURE_COOLDOWN_MS; });
          inflight = run.finally(() => { inflight = null; });
        }
      }
      if (inflight) await inflight;
    }
    if (cache && clock() - cache.at < STALE_OK_MS) return cache.byPark.get(parkId) ?? { autoHidden: [], registryRestored: [], legacyComebacks: [], legacyIdentities: [] };
    return undefined;
  } catch {
    return undefined;
  }
}

/** Auto-hidden names only (unknown → undefined). */
export async function getLifecycleAutoHidden(parkId: ParkId, opts: Parameters<typeof getLifecycleVisibilityState>[1] = {}): Promise<string[] | undefined> {
  return (await getLifecycleVisibilityState(parkId, opts))?.autoHidden;
}

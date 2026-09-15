/**
 * GET  /api/sync/planner?profileId=…&lastOpId=…&lastOpId=… — fetch the
 *   signed-in user's latest planner blob. `lastOpId` may be repeated to
 *   query MULTIPLE pending operations in one request (Codex P1, 9th round —
 *   see below).
 *   200: { plannerJson: SyncedPlannerPayload, updatedAt: string, revision: number,
 *          opStatuses: Array<{ opId: string; found: boolean; revision: number | null }> }
 *   204: no usable planner payload available; this includes:
 *          • no row in user_planner and no legacy row in user_plans
 *          • user_planner row exists but planner_json is corrupt/unparseable
 *            (for profileId "default" with valid legacy data this is self-healed
 *            by the write-through and returns 200 instead)
 *          • legacy user_plans row exists but plans_json is corrupt/unparseable
 *   400: missing or invalid profileId
 *   401: not signed in
 *
 * `lastOpId` (SH.2, Codex P1 7th/8th rounds; generalized to a repeatable
 * param in the 9th) is OPTIONAL — when supplied one or more times, the
 * response also carries `opStatuses`, one entry PER supplied opId, each an
 * answer to "was the write tagged with this opId ever accepted", looked up
 * against the append-only `user_planner_writes` table (see db-schema.sql
 * and handleWrite's own doc below).
 *
 * Codex P1 fix (9th round) — the client's pending-operation set
 * (syncHelper.ts's listPendingOps()) can legitimately hold MORE THAN ONE
 * still-unresolved opId at once (multiple tabs unloading before either is
 * resolved — see reconcilePendingOperations()'s own doc in syncHelper.ts
 * for the full architecture). Rather than have the client guess which ONE
 * to check (a "latest only" heuristic the round-9 directive explicitly
 * forbids), this endpoint resolves EVERY supplied opId, unconditionally,
 * in the SAME request/transaction — there is no picking, so there is
 * nothing to get wrong.
 *
 * Codex P1 fix (8th round) — the 7th round's opStatus lookup ran as a
 * SEPARATE, UNLOCKED query, entirely independent of the per-(user,profile)
 * advisory lock that serializes every PUT/POST for this pair. That let a
 * concurrent write's transaction be ACTIVELY IN PROGRESS (already past this
 * lookup's own read, not yet committed) at the exact moment this lookup
 * ran, so `found: false` could be returned even though the operation was, at
 * that very instant, in the process of being accepted — a false negative a
 * client could wrongly treat as conclusive proof of failure. The fix: when
 * one or more `lastOpId` are supplied, the ENTIRE read (every opStatus
 * lookup + the user_planner select + the legacy-migration fallback,
 * whichever fires) now runs inside ONE transaction holding the SAME
 * `pg_advisory_xact_lock` used by handleWrite — see getPlannerWithOpStatus()
 * below. Any write already IN PROGRESS for this (user, profile) is holding
 * that same lock, so this lookup simply waits for it to commit (or roll
 * back) before proceeding, and then sees its up-to-date, fully-committed
 * result — never a point-in-time snapshot torn mid-write. This makes each
 * `found` a DETERMINISTIC fact as of a single consistent instant, not a
 * racy unlocked read.
 *
 * What this does NOT and cannot resolve: a write whose HTTP request has not
 * yet reached this server process at all (still queued in the browser, or
 * in transit over the network) has no transaction to serialize against —
 * no lock, however placed, can make the server aware of a request it has
 * not received yet. `found: false` therefore still never means "will never
 * be accepted", only "not accepted as of this fully-serialized instant" —
 * see reconcilePendingOperations()'s own doc in syncHelper.ts for why the
 * client accordingly treats `found: false` as inconclusive (never retiring
 * that op's pending evidence on it) and only `found: true` as proof, rather
 * than the server trying to manufacture a third "unresolved" wire value for
 * a fact it fundamentally cannot observe.
 *
 * When no `lastOpId` is supplied, GET is unaffected — the ordinary,
 * unlocked fast path (unchanged from prior rounds) is used, since there is
 * no pending operation to verify.
 *
 * PUT  /api/sync/planner?profileId=…&clientOpId=… — merge-write the planner
 *   blob for (user, profile)
 * POST /api/sync/planner?profileId=…&clientOpId=… — same as PUT (supports
 *   navigator.sendBeacon on unload)
 *   200: { updatedAt: string, revision: number }
 *   400: invalid JSON, malformed body, structurally invalid planner shape,
 *        an otherwise-valid payload carrying a top-level domain this
 *        server build doesn't recognize (see findUnknownDomainKeys in
 *        syncPayload.ts — never silently dropped with a 200), or
 *        missing/invalid profileId
 *   401: not signed in
 *   413: payload exceeds size limit
 *
 * `clientOpId` (SH.2, Codex P1 7th/8th rounds) is OPTIONAL and, when
 * present, is always a QUERY parameter — NEVER a body field, since a body
 * field would trip findUnknownDomainKeys' unknown-top-level-key rejection
 * below.
 *
 * Codex P1 fix (8th round) — TRUE IDEMPOTENCY. The 7th round recorded
 * acceptance into `user_planner_writes` AFTER an UNCONDITIONAL merge/
 * upsert — every delivery of a given clientOpId, duplicate or not, still
 * re-ran the full merge against whatever `user_planner` currently held.
 * A delayed duplicate beacon (e.g. a network-level retry) arriving AFTER a
 * newer write C had already landed would merge ITS OWN (stale) payload
 * against C and overwrite C's domains with the duplicate's old content —
 * `user_planner_writes`' ON CONFLICT DO NOTHING only deduplicated the
 * LEDGER row, never the planner mutation itself. The fix: `clientOpId`
 * now identifies ONE idempotent operation for real. Under the SAME
 * advisory lock, BEFORE any merge/upsert, handleWrite first checks whether
 * this exact (userId, profileId, clientOpId) is already recorded:
 *   • already recorded — the planner is NOT touched again; the ORIGINAL
 *     accepted {updatedAt, revision} (copied verbatim from the ledger row,
 *     not re-derived from user_planner's possibly-since-changed current
 *     state) is returned as-is.
 *   • not yet recorded — the merge/upsert proceeds exactly as before, and
 *     the ledger row is inserted (still ON CONFLICT DO NOTHING, as
 *     defense-in-depth against a genuinely simultaneous duplicate that
 *     also passed the check — see handleWrite's own doc) with the revision
 *     AND updated_at this write actually produced.
 * Both branches happen inside the SAME transaction/lock as every other
 * write for this (user, profile), so two literally-concurrent deliveries
 * of the same clientOpId are still fully serialized: the second one to
 * acquire the lock always sees the first one's already-committed ledger
 * row and takes the "already recorded" branch. A duplicate can therefore
 * never overwrite a planner revision written after the original — see
 * handleWrite's own doc for the exact sequencing. An ordinary push that
 * omits `clientOpId` (the debounced doPush() path) is completely
 * unaffected — this table is populated and consulted only for callers that
 * opt in by supplying one (today, only registerUnloadSync's beacon).
 *
 * SH.2 (Codex P1) — `revision` is a monotonically increasing integer
 * (backed by the `user_planner_revision_seq` Postgres sequence — see
 * db-schema.sql), assigned fresh on every successful write via
 * `nextval()`. It is the AUTHORITATIVE ordering signal for this
 * (user, profile) pair's planner state: strictly higher always means
 * "written later", regardless of `updated_at`. `updated_at` uses `NOW()`,
 * which is fixed at TRANSACTION START in Postgres — under the
 * pg_advisory_xact_lock serialization below, a transaction that starts
 * earlier but is blocked waiting for the lock can still commit its write
 * AFTER a later-starting transaction that acquired the lock first, yet
 * retain an EARLIER `updated_at` than the write it was actually applied
 * after. `revision` has no such gap: it is only ever assigned at the
 * moment a write actually executes (inside the locked section), so it is
 * strictly ordered by actual commit order. Client code (syncHelper.ts)
 * uses `revision`, never `updated_at` or response arrival order, to decide
 * whether a push/pull response may advance the durable confirmed planner
 * baseline for this (user, profile) pair.
 * Phase 7.6: stores a combined Plans + Lightning payload per (user_id, profile_id).
 * The profile_id is user-supplied from the client's active local profile.
 *
 * SH.1 (Authoritative Planner Sync Core): PUT/POST no longer replace the
 * stored row wholesale. The wire contract is unchanged (still the flat
 * `{version:1, plans, lightning, days?}` shape — see syncPayload.ts) and a
 * request that doesn't validate against it is now rejected outright (400)
 * rather than being stored verbatim. What changed internally is the write
 * itself: under the existing per-(user,profile) advisory lock, the
 * currently-stored row is read and mergePlannerDomains() (syncPayload.ts)
 * overlays only the domains the incoming request actually validates for —
 * `plans`/`lightning` always (present-empty is an intentional clear), and
 * `days` only when present and valid. Any other key already in the stored
 * row — including a domain this server build has never heard of, such as a
 * future SH.3 `dayMeta` written by a newer client — survives untouched,
 * because the merge starts from the existing stored object rather than
 * from a fixed list of fields to reconstruct. This generalizes and
 * replaces the old bespoke "if incoming lacks `days`, read and re-splice
 * existing `days`" block, and is what makes an old (pre-SH.1, or
 * SH.1-but-pre-SH.3) client's GET -> local edit -> PUT cycle safe against
 * erasing a domain it doesn't know exists, without needing this server
 * build's code to know that domain's name either.
 *
 * Phase 7.6.1 legacy fallback: if no user_planner row exists, falls back to the
 * legacy user_plans table (Phase 7.2 plans-only data). The legacy payload is
 * normalized to the combined planner shape (lightning defaults to empty) and
 * written through into user_planner so subsequent reads hit the new table.
 * Important: the legacy fallback only activates when profileId === "default".
 * Legacy data was never profile-scoped, so it belongs to the default profile
 * only. Non-default profiles skip the fallback and proceed directly to 204.
 * Unchanged by SH.1: this path only ever runs when no user_planner row
 * exists yet, so there is nothing for mergePlannerDomains() to preserve.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession, type Session } from "next-auth";
import type { Pool, PoolClient } from "pg";
import { authOptions } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { findUnknownDomainKeys, mergePlannerDomains, parseSyncedPlannerPayload } from "@/lib/syncPayload";

// 1 MB hard limit; realistic planner payloads are well under 100 KB.
const MAX_BODY_BYTES = 1_000_000;

// Profile IDs are normalized on the client (lowercase, alphanumeric + dash, ≤32 chars).
// We accept a slightly broader pattern to tolerate any edge cases, capped at 64 chars.
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_\-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

function getUserId(session: Session | null): string | null {
  if (!session?.user) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (session.user as any).id ?? session.user.email ?? null;
}

function validateProfileId(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (!PROFILE_ID_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Lightweight validation for an OPTIONAL client-supplied opId — accepts any
 * non-empty, reasonably-bounded string (the client always sends a
 * crypto.randomUUID(), but this endpoint has no reason to enforce that exact
 * shape; it is stored and compared as an opaque string either way). Returns
 * null for missing/empty/oversized values, which callers treat as "no opId
 * supplied" rather than an error — both `lastOpId` (GET) and `clientOpId`
 * (PUT/POST) are optional.
 */
function validateOpId(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return trimmed;
}

// Defensive cap — the client's pending-operation set is expected to stay
// tiny in practice (bounded by how many tabs have unloaded with an
// unresolved beacon since the last successful resolution), but this bounds
// the query cost of a single GET against a malformed/abusive client rather
// than relying on that expectation alone. Opts NOT sent (beyond the cap)
// are simply left unresolved by THIS request — they remain in the client's
// pending set and are retried on a later pull, exactly like any other
// not-yet-resolved op (see reconcilePendingOperations' own doc in
// syncHelper.ts).
//
// Codex P1 fix (10th round) — this cap alone is NOT what guarantees every
// op eventually gets queried: if the client always sent the SAME leading
// slice of an oversized pending set, ops beyond this cap would starve
// forever whenever the earlier ones stay unresolved (found: false is never
// dropped — see reconcilePendingOperations' own doc). Fairness across
// pulls is the CLIENT's responsibility (syncHelper.ts's
// selectPendingOpBatch(), a rotating window over the full pending set) —
// this server-side constant exists only to bound per-request cost and is
// intentionally kept equal to selectPendingOpBatch's own default batch
// size, so the client never sends more than this endpoint will actually
// process.
const MAX_LAST_OP_IDS = 25;

/**
 * Validates and de-duplicates the (possibly repeated) `lastOpId` query
 * parameters, capping the result at MAX_LAST_OP_IDS.
 */
function validateOpIds(raw: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    const valid = validateOpId(entry);
    if (valid && !seen.has(valid)) {
      seen.add(valid);
      result.push(valid);
      if (result.length >= MAX_LAST_OP_IDS) break;
    }
  }
  return result;
}

type OpStatus = { opId: string; found: boolean; revision: number | null };
type Queryable = Pool | PoolClient;

/**
 * Look up whether `opId` was ever durably recorded as accepted for this
 * (userId, profileId) — see user_planner_writes' own doc in db-schema.sql.
 *
 * Codex P1 fix (8th round) — accepts a `Queryable` (a bare `Pool` OR an
 * already-`BEGIN`-ed `PoolClient` holding the per-(user,profile) advisory
 * lock), so the SAME lookup logic serves both: the ordinary unlocked
 * fast path (no `lastOpId` — never calls this at all) and the LOCKED path
 * (getPlannerWithOpStatus below), which passes its own transactional
 * `client` so this lookup is serialized against any write for this exact
 * (user, profile) — see this file's module doc for why an unlocked lookup
 * could return a stale `found: false` while a concurrent write was still
 * committing.
 */
async function lookupOpStatus(
  db: Queryable,
  userId: string,
  profileId: string,
  opId: string
): Promise<OpStatus> {
  const { rows } = await db.query<{ revision: string }>(
    "SELECT revision FROM user_planner_writes WHERE user_id = $1 AND profile_id = $2 AND client_op_id = $3",
    [userId, profileId, opId]
  );
  return rows.length > 0
    ? { opId, found: true, revision: Number(rows[0].revision) }
    : { opId, found: false, revision: null };
}

// ── GET ──────────────────────────────────────────────────────────────────────

/**
 * The `lastOpId`-present path (Codex P1, 8th round; generalized to multiple
 * opIds in the 9th). Runs the ENTIRE read — every opStatus lookup, the
 * user_planner select, and the legacy-migration fallback if it fires —
 * inside ONE transaction holding the same `pg_advisory_xact_lock`
 * handleWrite uses for this (user, profile). See this file's module doc
 * for why: it eliminates the race where an unlocked opStatus lookup could
 * return `found: false` while the write that would have made it `true` was
 * still an in-progress, uncommitted transaction. Structurally identical to
 * the pre-8th-round unlocked fast path otherwise — same three response
 * tiers, same normalization/migration logic — just fully serialized and
 * with `opStatuses` (one entry per requested opId) attached to every
 * response tier (never reachable on 204, since a write that recorded an
 * opId always also upserts a `user_planner` row in the SAME transaction —
 * see handleWrite's own doc).
 */
async function getPlannerWithOpStatus(
  pool: Pool,
  userId: string,
  profileId: string,
  lastOpIds: string[]
): Promise<NextResponse> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [userId, profileId]);

    // Codex P1 fix (9th round) — resolve EVERY requested opId, not just
    // one; see this file's module doc for why there is no "pick one"
    // heuristic here. All lookups run inside this SAME locked transaction.
    const opStatuses: OpStatus[] = [];
    for (const opId of lastOpIds) {
      opStatuses.push(await lookupOpStatus(client, userId, profileId, opId));
    }

    const { rows } = await client.query<{ planner_json: string; updated_at: Date; revision: string }>(
      "SELECT planner_json, updated_at, revision FROM user_planner WHERE user_id = $1 AND profile_id = $2",
      [userId, profileId]
    );
    if (rows.length > 0) {
      let plannerJson: unknown;
      try {
        plannerJson = JSON.parse(rows[0].planner_json);
      } catch {
        // Stored data is corrupted — treat as missing and fall through to legacy
      }
      if (plannerJson !== undefined) {
        await client.query("COMMIT");
        return NextResponse.json({
          plannerJson,
          updatedAt: rows[0].updated_at.toISOString(),
          revision: Number(rows[0].revision),
          opStatuses,
        });
      }
    }

    if (profileId === "default") {
      const { rows: legacyRows } = await client.query<{ plans_json: string; updated_at: Date }>(
        "SELECT plans_json, updated_at FROM user_plans WHERE user_id = $1",
        [userId]
      );
      if (legacyRows.length > 0) {
        let legacyPlans: unknown;
        try {
          legacyPlans = JSON.parse(legacyRows[0].plans_json);
        } catch {
          // Legacy data corrupted — treat as missing
        }
        if (
          legacyPlans &&
          typeof legacyPlans === "object" &&
          !Array.isArray(legacyPlans) &&
          typeof (legacyPlans as Record<string, unknown>).version === "number" &&
          Array.isArray((legacyPlans as Record<string, unknown>).items)
        ) {
          const normalizedPlanner = {
            version: 1,
            plans: legacyPlans,
            lightning: { version: 1, items: [] },
          };
          const normalizedJson = JSON.stringify(normalizedPlanner);
          const legacyUpdatedAt = legacyRows[0].updated_at;
          // Already holding the lock (unlike the unlocked fast path below,
          // which needs its own separate re-check) — safe to write the
          // legacy-migrated shape through directly, self-healing a
          // corrupted row via DO UPDATE.
          const { rows: migratedRows } = await client.query<{ revision: string }>(
            `INSERT INTO user_planner (user_id, profile_id, planner_json, updated_at, revision)
             VALUES ($1, $2, $3, $4, nextval('user_planner_revision_seq'))
             ON CONFLICT (user_id, profile_id) DO UPDATE
               SET planner_json = EXCLUDED.planner_json,
                   updated_at   = EXCLUDED.updated_at,
                   revision     = EXCLUDED.revision
             RETURNING revision`,
            [userId, profileId, normalizedJson, legacyUpdatedAt]
          );
          const migratedRevision = migratedRows[0]?.revision;
          if (migratedRevision !== undefined) {
            await client.query("COMMIT");
            return NextResponse.json({
              plannerJson: normalizedPlanner,
              updatedAt: legacyUpdatedAt.toISOString(),
              revision: Number(migratedRevision),
              opStatuses,
            });
          }
          // Migration write unexpectedly returned nothing — fall through
          // to the best-effort legacy-only response below (still commits;
          // nothing was written, so there is nothing to roll back).
          await client.query("COMMIT");
          return NextResponse.json({
            plannerJson: normalizedPlanner,
            updatedAt: legacyUpdatedAt.toISOString(),
            opStatuses,
          });
        }
      }
    }

    // Neither table has data — definitively empty. Every opStatus.found is
    // structurally guaranteed false here (see this function's own doc).
    await client.query("COMMIT");
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getServerSession(authOptions) as Session | null;
  const userId = getUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profileId = validateProfileId(req.nextUrl.searchParams.get("profileId"));
  if (!profileId) {
    return NextResponse.json({ error: "Missing or invalid profileId" }, { status: 400 });
  }
  const lastOpIds = validateOpIds(req.nextUrl.searchParams.getAll("lastOpId"));

  const pool = getPool();

  // Codex P1 fix (8th round; generalized 9th) — route through the locked
  // path whenever there is at least one operation to verify; see
  // getPlannerWithOpStatus's own doc and this file's module doc for why the
  // lookup itself must be lock-serialized against concurrent writes. An
  // ordinary pull with no pending operations (the common case) takes the
  // unchanged, unlocked fast path below.
  if (lastOpIds.length > 0) {
    return getPlannerWithOpStatus(pool, userId, profileId, lastOpIds);
  }

  // ── 1. Try new user_planner table first ──────────────────────────────────
  const { rows } = await pool.query<{ planner_json: string; updated_at: Date; revision: string }>(
    "SELECT planner_json, updated_at, revision FROM user_planner WHERE user_id = $1 AND profile_id = $2",
    [userId, profileId]
  );

  if (rows.length > 0) {
    let plannerJson: unknown;
    try {
      plannerJson = JSON.parse(rows[0].planner_json);
    } catch {
      // Stored data is corrupted — treat as missing and fall through to legacy
    }
    if (plannerJson !== undefined) {
      return NextResponse.json({
        plannerJson,
        updatedAt: rows[0].updated_at.toISOString(),
        revision: Number(rows[0].revision),
      });
    }
  }

  // ── 2. Legacy fallback: try user_plans (Phase 7.2 plans-only table) ──────
  // Only attempt for profileId "default" — legacy data was never profile-scoped,
  // so it belongs to the default profile.
  if (profileId === "default") {
    const { rows: legacyRows } = await pool.query<{ plans_json: string; updated_at: Date }>(
      "SELECT plans_json, updated_at FROM user_plans WHERE user_id = $1",
      [userId]
    );

    if (legacyRows.length > 0) {
      let legacyPlans: unknown;
      try {
        legacyPlans = JSON.parse(legacyRows[0].plans_json);
      } catch {
        // Legacy data corrupted — treat as missing
      }

      if (
        legacyPlans &&
        typeof legacyPlans === "object" &&
        !Array.isArray(legacyPlans) &&
        typeof (legacyPlans as Record<string, unknown>).version === "number" &&
        Array.isArray((legacyPlans as Record<string, unknown>).items)
      ) {
        // Normalize into the combined planner shape (lightning defaults to empty)
        const normalizedPlanner = {
          version: 1,
          plans: legacyPlans,
          lightning: { version: 1, items: [] },
        };
        const normalizedJson = JSON.stringify(normalizedPlanner);
        const legacyUpdatedAt = legacyRows[0].updated_at;

        // Codex fix (audit finding) — the initial user_planner SELECT above
        // (step 1) ran unlocked, so a concurrent PUT for this same
        // (user_id, profile_id) — e.g. a device pushing a freshly reordered
        // days[] — could commit its row in the gap between that SELECT and
        // this write-through migration. Writing the legacy (days-less)
        // shape through unconditionally at that point would silently
        // clobber the concurrent writer's fresher, possibly days[]-bearing
        // row — the exact same class of TOCTOU Fix 1 closes for PUT-vs-PUT,
        // just on the GET-vs-PUT side. Closed the same way: acquire the
        // shared per-(user, profile) advisory lock, then RE-CHECK
        // user_planner inside it before writing anything through. If a
        // valid row now exists (the concurrent writer won the race), it is
        // the freshest truth — return it instead of overwriting it with
        // stale legacy data. Only writes the legacy-migrated shape through
        // when the row is still genuinely missing or corrupted once the
        // lock is held. Ignore errors on the lock/migration path — this
        // remains best-effort; the read still succeeds with legacy data.
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
            userId,
            profileId,
          ]);
          const { rows: freshRows } = await client.query<{
            planner_json: string;
            updated_at: Date;
            revision: string;
          }>(
            "SELECT planner_json, updated_at, revision FROM user_planner WHERE user_id = $1 AND profile_id = $2",
            [userId, profileId]
          );
          if (freshRows.length > 0) {
            let freshParsed: unknown;
            try {
              freshParsed = JSON.parse(freshRows[0].planner_json);
            } catch {
              freshParsed = undefined;
            }
            if (freshParsed !== undefined) {
              // A concurrent writer committed a valid row while this GET's
              // earlier unlocked SELECT and the legacy lookup above were
              // running — use its data instead of the stale legacy shape.
              await client.query("COMMIT");
              return NextResponse.json({
                plannerJson: freshParsed,
                updatedAt: freshRows[0].updated_at.toISOString(),
                revision: Number(freshRows[0].revision),
              });
            }
          }
          // Still genuinely missing/corrupted under the lock — safe to
          // write the legacy-migrated shape through. Uses DO UPDATE (not DO
          // NOTHING) so a pre-existing corrupted row is repaired in place —
          // this is the self-heal path for corrupted rows. Assigns a fresh
          // `revision` via nextval() like every other write, so this
          // migrated row participates in the same strict ordering as any
          // other confirmed state for this (user, profile) pair.
          const { rows: migratedRows } = await client.query<{ revision: string }>(
            `INSERT INTO user_planner (user_id, profile_id, planner_json, updated_at, revision)
             VALUES ($1, $2, $3, $4, nextval('user_planner_revision_seq'))
             ON CONFLICT (user_id, profile_id) DO UPDATE
               SET planner_json = EXCLUDED.planner_json,
                   updated_at   = EXCLUDED.updated_at,
                   revision     = EXCLUDED.revision
             RETURNING revision`,
            [userId, profileId, normalizedJson, legacyUpdatedAt]
          );
          const migratedRevision = migratedRows[0]?.revision;
          await client.query("COMMIT");
          if (migratedRevision !== undefined) {
            return NextResponse.json({
              plannerJson: normalizedPlanner,
              updatedAt: legacyUpdatedAt.toISOString(),
              revision: Number(migratedRevision),
            });
          }
        } catch {
          await client.query("ROLLBACK").catch(() => {});
          // Best-effort — do not fail the read if migration write fails
        } finally {
          client.release();
        }

        return NextResponse.json({
          plannerJson: normalizedPlanner,
          updatedAt: legacyUpdatedAt.toISOString(),
        });
      }
    }
  }

  // ── 3. Neither table has data — definitively empty ────────────────────────
  return new NextResponse(null, { status: 204 });
}

// ── PUT / POST (shared handler) ───────────────────────────────────────────────

async function handleWrite(req: NextRequest): Promise<NextResponse> {
  const session = await getServerSession(authOptions) as Session | null;
  const userId = getUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profileId = validateProfileId(req.nextUrl.searchParams.get("profileId"));
  if (!profileId) {
    return NextResponse.json({ error: "Missing or invalid profileId" }, { status: 400 });
  }
  const clientOpId = validateOpId(req.nextUrl.searchParams.get("clientOpId"));

  // Reject oversized payloads early using Content-Length if present
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let body: string;
  try {
    body = await req.text();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Use UTF-8 byte length to match actual transmitted size
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  // Validate that the body is parseable JSON before storing
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // SH.1 — reject anything that doesn't validate as a recognized planner
  // shape BEFORE taking the lock or touching storage, rather than falling
  // through to store it verbatim (the pre-SH.1 behavior — "any JSON-
  // parseable body" was accepted as the new cloud truth, which is exactly
  // the "structurally invalid writes must fail safely" gap this closes).
  // Every legitimate caller (syncHelper's buildSyncedPlannerPayload, used
  // by both the debounced push and the unload beacon) always produces a
  // payload that validates here, so this only ever rejects genuinely
  // invalid writes — no behavior change for any real client.
  const incomingParsed = parseSyncedPlannerPayload(parsedBody);
  if (!incomingParsed) {
    return NextResponse.json({ error: "Invalid planner payload shape" }, { status: 400 });
  }
  const incomingRaw = parsedBody as Record<string, unknown>;

  // Codex P2 fix — a payload can validate the known shape above (it has
  // valid plans/lightning/days) while ALSO carrying a top-level key this
  // server build doesn't recognize as any domain (e.g. a newer client
  // running code ahead of this deployment). mergePlannerDomains() only
  // ever copies specifically-named keys into what it stores, so such a
  // key would previously be silently dropped while the request still
  // returned 200 — a write must never succeed while discarding part of
  // what it was asked to persist. Reject explicitly instead, before the
  // lock is taken and before any row is read or written, so an
  // unrecognized write has zero effect on stored data. This only ever
  // affects a client ahead of this server's known domains; the identical
  // write succeeds once a later phase recognizes that domain.
  const unknownDomains = findUnknownDomainKeys(incomingRaw);
  if (unknownDomains.length > 0) {
    return NextResponse.json(
      { error: "Unrecognized planner domain(s) in payload", domains: unknownDomains },
      { status: 400 }
    );
  }

  const pool = getPool();

  // SH.1 — generalized merge-on-write under the existing per-(user,profile)
  // advisory lock, replacing the old bespoke "if incoming lacks `days`,
  // read and re-splice existing `days`" block. See mergePlannerDomains()
  // in syncPayload.ts for the full rationale — in short: the merge starts
  // from whatever is currently stored (unknown keys included) and overlays
  // only the domains this write's payload actually validates for, so a
  // domain this server build has never heard of survives an old client's
  // write without needing a matching bespoke preserve branch here.
  //
  // Locking is unchanged from the prior implementation: two independent
  // 32-bit hash keys (userId, profileId) rather than a concatenated string
  // (avoids a delimiter-collision edge case at the cost of a vanishingly
  // rare cross-profile lock collision, which only costs extra
  // serialization, never correctness). pg_advisory_xact_lock serializes
  // all writers for the same (user_id, profile_id) pair for the duration
  // of this transaction (released automatically on COMMIT/ROLLBACK), so
  // the read below always sees the most recently committed row for this
  // profile — no TOCTOU window between reading `existingRaw` and writing
  // `bodyToStore`.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      userId,
      profileId,
    ]);

    // Codex P1 fix (8th round) — TRUE IDEMPOTENCY: if this exact
    // (userId, profileId, clientOpId) was already accepted by a PRIOR
    // request, this is a duplicate delivery (network retry, a resend, or
    // any other re-delivery of the identical operation) — return the
    // ORIGINAL accepted result verbatim and do NOT touch `user_planner`
    // again. Checked FIRST, before any merge/upsert, under the SAME
    // advisory lock as the rest of this transaction, so two literally
    // concurrent deliveries of the same clientOpId are fully serialized:
    // whichever acquires the lock second always sees the first's
    // already-committed ledger row here and takes this branch — a
    // duplicate can therefore never merge/overwrite a planner revision
    // written after the original (see this file's module doc for the full
    // rationale, and required case #4/#5 in the round-8 report).
    if (clientOpId) {
      const { rows: existingOpRows } = await client.query<{ revision: string; updated_at: Date }>(
        "SELECT revision, updated_at FROM user_planner_writes WHERE user_id = $1 AND profile_id = $2 AND client_op_id = $3",
        [userId, profileId, clientOpId]
      );
      if (existingOpRows.length > 0) {
        await client.query("COMMIT");
        return NextResponse.json({
          updatedAt: existingOpRows[0].updated_at.toISOString(),
          revision: Number(existingOpRows[0].revision),
        });
      }
    }

    const { rows: existingRows } = await client.query<{ planner_json: string }>(
      "SELECT planner_json FROM user_planner WHERE user_id = $1 AND profile_id = $2",
      [userId, profileId]
    );
    let existingRaw: unknown = null;
    if (existingRows.length > 0) {
      try {
        existingRaw = JSON.parse(existingRows[0].planner_json);
      } catch {
        existingRaw = null; // corrupted existing row — nothing recoverable to preserve from it
      }
    }
    const bodyToStore = JSON.stringify(
      mergePlannerDomains(existingRaw, incomingRaw, incomingParsed)
    );

    // SH.2 (Codex P1) — `revision` is assigned via nextval() at the moment
    // this write actually executes, under the advisory lock's
    // serialization — see this file's module doc for why this is the
    // authoritative ordering signal, not `updated_at`.
    const { rows } = await client.query<{ updated_at: Date; revision: string }>(
      `INSERT INTO user_planner (user_id, profile_id, planner_json, updated_at, revision)
       VALUES ($1, $2, $3, NOW(), nextval('user_planner_revision_seq'))
       ON CONFLICT (user_id, profile_id) DO UPDATE
         SET planner_json = EXCLUDED.planner_json,
             updated_at   = NOW(),
             revision     = EXCLUDED.revision
       RETURNING updated_at, revision`,
      [userId, profileId, bodyToStore]
    );

    // SH.2 (Codex P1, 7th/8th rounds) — durably record acceptance of this
    // write under its client-supplied opId, in the SAME transaction/lock as
    // the upsert above, so a later `lastOpId` GET lookup can never observe
    // "accepted" without the write itself having actually landed (or vice
    // versa). Skipped entirely when the caller didn't supply one — see
    // user_planner_writes' own doc in db-schema.sql. `updated_at` is copied
    // from THIS write's own RETURNING clause (not a later re-read), so a
    // duplicate delivery caught by the check above always replays the
    // EXACT original result — see this file's module doc. ON CONFLICT DO
    // NOTHING is defense-in-depth only: the per-(user,profile) advisory
    // lock held for this entire transaction already makes it impossible
    // for two requests to both pass the "not yet recorded" check above for
    // the SAME clientOpId (the second can only reach that check after the
    // first has committed and released the lock, at which point it would
    // see the first's row and take the early-return branch instead) — this
    // INSERT is therefore expected to always succeed in practice, and the
    // clause exists only to fail safe rather than error if that invariant
    // is ever violated.
    if (clientOpId) {
      await client.query(
        `INSERT INTO user_planner_writes (user_id, profile_id, client_op_id, revision, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, profile_id, client_op_id) DO NOTHING`,
        [userId, profileId, clientOpId, rows[0].revision, rows[0].updated_at]
      );
    }

    await client.query("COMMIT");
    return NextResponse.json({
      updatedAt: rows[0].updated_at.toISOString(),
      revision: Number(rows[0].revision),
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const PUT = handleWrite;
// POST allows navigator.sendBeacon (which always uses POST) on page unload
export const POST = handleWrite;

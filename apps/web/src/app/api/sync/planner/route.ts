/**
 * GET  /api/sync/planner?profileId=… — fetch the signed-in user's latest planner blob
 *   200: { plannerJson: SyncedPlannerPayload, updatedAt: string, revision: number }
 *   204: no usable planner payload available; this includes:
 *          • no row in user_planner and no legacy row in user_plans
 *          • user_planner row exists but planner_json is corrupt/unparseable
 *            (for profileId "default" with valid legacy data this is self-healed
 *            by the write-through and returns 200 instead)
 *          • legacy user_plans row exists but plans_json is corrupt/unparseable
 *   400: missing or invalid profileId
 *   401: not signed in
 *
 * PUT  /api/sync/planner?profileId=… — merge-write the planner blob for (user, profile)
 * POST /api/sync/planner?profileId=… — same as PUT (supports navigator.sendBeacon on unload)
 *   200: { updatedAt: string, revision: number }
 *   400: invalid JSON, malformed body, structurally invalid planner shape,
 *        an otherwise-valid payload carrying a top-level domain this
 *        server build doesn't recognize (see findUnknownDomainKeys in
 *        syncPayload.ts — never silently dropped with a 200), or
 *        missing/invalid profileId
 *   401: not signed in
 *   413: payload exceeds size limit
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

// ── GET ──────────────────────────────────────────────────────────────────────

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

  const pool = getPool();

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

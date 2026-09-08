/**
 * GET  /api/sync/planner?profileId=… — fetch the signed-in user's latest planner blob
 *   200: { plannerJson: SyncedPlannerPayload, updatedAt: string }
 *   204: no usable planner payload available; this includes:
 *          • no row in user_planner and no legacy row in user_plans
 *          • user_planner row exists but planner_json is corrupt/unparseable
 *            (for profileId "default" with valid legacy data this is self-healed
 *            by the write-through and returns 200 instead)
 *          • legacy user_plans row exists but plans_json is corrupt/unparseable
 *   400: missing or invalid profileId
 *   401: not signed in
 *
 * PUT  /api/sync/planner?profileId=… — replace the planner blob for (user, profile)
 * POST /api/sync/planner?profileId=… — same as PUT (supports navigator.sendBeacon on unload)
 *   200: { updatedAt: string }
 *   400: invalid JSON, malformed body, or missing/invalid profileId
 *   401: not signed in
 *   413: payload exceeds size limit
 *
 * Phase 7.6: stores a combined Plans + Lightning payload per (user_id, profile_id).
 * The profile_id is user-supplied from the client's active local profile.
 *
 * Phase 7.6.1 legacy fallback: if no user_planner row exists, falls back to the
 * legacy user_plans table (Phase 7.2 plans-only data). The legacy payload is
 * normalized to the combined planner shape (lightning defaults to empty) and
 * written through into user_planner so subsequent reads hit the new table.
 * Important: the legacy fallback only activates when profileId === "default".
 * Legacy data was never profile-scoped, so it belongs to the default profile
 * only. Non-default profiles skip the fallback and proceed directly to 204.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession, type Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { parseSyncedPlannerPayload } from "@/lib/syncPayload";

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
  const { rows } = await pool.query<{ planner_json: string; updated_at: Date }>(
    "SELECT planner_json, updated_at FROM user_planner WHERE user_id = $1 AND profile_id = $2",
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
          }>(
            "SELECT planner_json, updated_at FROM user_planner WHERE user_id = $1 AND profile_id = $2",
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
              });
            }
          }
          // Still genuinely missing/corrupted under the lock — safe to
          // write the legacy-migrated shape through. Uses DO UPDATE (not DO
          // NOTHING) so a pre-existing corrupted row is repaired in place —
          // this is the self-heal path for corrupted rows.
          await client.query(
            `INSERT INTO user_planner (user_id, profile_id, planner_json, updated_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, profile_id) DO UPDATE
               SET planner_json = EXCLUDED.planner_json,
                   updated_at   = EXCLUDED.updated_at`,
            [userId, profileId, normalizedJson, legacyUpdatedAt]
          );
          await client.query("COMMIT");
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

  const pool = getPool();

  // Codex fix — legacy-writer days[] preservation, made atomic. A client
  // running code from before the `days` addition (or a current client with
  // nothing local to send) still pushes a valid combined-planner body that
  // simply omits `days`. planner_json is stored/replaced wholesale below,
  // so without this, such a write would silently erase a newer `days[]`
  // already stored by another, up-to-date device for this same profile.
  //
  // The read-then-write (check existing days[], then INSERT/UPDATE) is a
  // classic TOCTOU: two overlapping writers for the same (user, profile) —
  // e.g. an old-format write and a concurrent new-format reorder — could
  // each read the row before the other's write commits, so the "preserve
  // existing days" writer could still clobber the order the other writer
  // was in the middle of establishing. pg_advisory_xact_lock serializes
  // all writers for the same (user_id, profile_id) pair for the duration of
  // this transaction (released automatically on COMMIT/ROLLBACK): the
  // second writer's lock acquisition blocks until the first's transaction
  // commits, so by the time it runs its own SELECT it sees the first
  // writer's already-committed row — closing the race without requiring a
  // schema change or version bump.
  //
  // bodyToStore defaults to the raw incoming body unchanged — this only
  // ever reshapes the write when the incoming payload both (a) parses as
  // a valid combined-planner shape via the same client-side validation
  // semantics (parseSyncedPlannerPayload), reused here rather than
  // reimplemented, and (b) itself has no valid `days` (omitted, or present
  // but malformed — both collapse to "no days" through that same parser).
  // Anything else — an unrecognized shape, or one that already carries its
  // own valid `days` — is stored exactly as received, preserving the
  // existing "plans/lightning replacement unchanged" and "opaque
  // planner_json" behavior for every other case.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Two independent 32-bit hash keys (userId, profileId) rather than a
    // concatenated string — avoids a delimiter-collision edge case (e.g.
    // userId "a" + profileId "b:c" hashing the same as userId "a:b" +
    // profileId "c") at the cost of a vanishingly rare cross-profile lock
    // collision, which only costs extra serialization, never correctness.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      userId,
      profileId,
    ]);

    let bodyToStore = body;
    const incoming = parseSyncedPlannerPayload(parsedBody);
    if (incoming && !incoming.days) {
      const { rows: existingRows } = await client.query<{ planner_json: string }>(
        "SELECT planner_json FROM user_planner WHERE user_id = $1 AND profile_id = $2",
        [userId, profileId]
      );
      if (existingRows.length > 0) {
        let existingParsed: unknown;
        try {
          existingParsed = JSON.parse(existingRows[0].planner_json);
        } catch {
          existingParsed = null;
        }
        // Only ever preserves a genuinely VALID existing days[] (same
        // sanitization the client already applies) — never blindly carries
        // forward malformed existing data.
        const existing = parseSyncedPlannerPayload(existingParsed);
        if (existing?.days) {
          // Merge into the raw parsed body (not the normalized `incoming`
          // object) so plans/lightning are stored exactly as the client sent
          // them — only the top-level `days` key is added.
          bodyToStore = JSON.stringify({
            ...(parsedBody as Record<string, unknown>),
            days: existing.days,
          });
        }
      }
    }

    const { rows } = await client.query<{ updated_at: Date }>(
      `INSERT INTO user_planner (user_id, profile_id, planner_json, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, profile_id) DO UPDATE
         SET planner_json = EXCLUDED.planner_json,
             updated_at   = NOW()
       RETURNING updated_at`,
      [userId, profileId, bodyToStore]
    );

    await client.query("COMMIT");
    return NextResponse.json({ updatedAt: rows[0].updated_at.toISOString() });
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

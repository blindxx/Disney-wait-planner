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

        // Write-through migrate into user_planner so future reads skip this path.
        // Uses DO UPDATE (not DO NOTHING) so that a pre-existing corrupted row
        // is repaired in place — this is the self-heal path for corrupted rows.
        // Ignore errors — migration is best-effort; the read still succeeds.
        try {
          await pool.query(
            `INSERT INTO user_planner (user_id, profile_id, planner_json, updated_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, profile_id) DO UPDATE
               SET planner_json = EXCLUDED.planner_json,
                   updated_at   = EXCLUDED.updated_at`,
            [userId, profileId, normalizedJson, legacyUpdatedAt]
          );
        } catch {
          // Best-effort — do not fail the read if migration write fails
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

  // Codex fix — legacy-writer days[] preservation. A client running code
  // from before the `days` addition (or a current client with nothing
  // local to send) still pushes a valid combined-planner body that simply
  // omits `days`. planner_json is stored/replaced wholesale below, so
  // without this, such a write would silently erase a newer `days[]`
  // already stored by another, up-to-date device for this same profile.
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
  let bodyToStore = body;
  const incoming = parseSyncedPlannerPayload(parsedBody);
  if (incoming && !incoming.days) {
    const { rows: existingRows } = await pool.query<{ planner_json: string }>(
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

  const { rows } = await pool.query<{ updated_at: Date }>(
    `INSERT INTO user_planner (user_id, profile_id, planner_json, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, profile_id) DO UPDATE
       SET planner_json = EXCLUDED.planner_json,
           updated_at   = NOW()
     RETURNING updated_at`,
    [userId, profileId, bodyToStore]
  );

  return NextResponse.json({ updatedAt: rows[0].updated_at.toISOString() });
}

export const PUT = handleWrite;
// POST allows navigator.sendBeacon (which always uses POST) on page unload
export const POST = handleWrite;

/**
 * GET  /api/sync/planner?profileId=… — fetch the signed-in user's latest planner blob
 *   200: { plannerJson: SyncedPlannerPayload, updatedAt: string }
 *   204: authenticated but no planner stored yet for this profile
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
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession, type Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPool } from "@/lib/db";

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

  const { rows } = await getPool().query<{ planner_json: string; updated_at: Date }>(
    "SELECT planner_json, updated_at FROM user_planner WHERE user_id = $1 AND profile_id = $2",
    [userId, profileId]
  );

  if (rows.length === 0) {
    return new NextResponse(null, { status: 204 });
  }

  let plannerJson: unknown;
  try {
    plannerJson = JSON.parse(rows[0].planner_json);
  } catch {
    // Stored data is corrupted — treat as missing
    return new NextResponse(null, { status: 204 });
  }

  return NextResponse.json({
    plannerJson,
    updatedAt: rows[0].updated_at.toISOString(),
  });
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
  try {
    JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { rows } = await getPool().query<{ updated_at: Date }>(
    `INSERT INTO user_planner (user_id, profile_id, planner_json, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, profile_id) DO UPDATE
       SET planner_json = EXCLUDED.planner_json,
           updated_at   = NOW()
     RETURNING updated_at`,
    [userId, profileId, body]
  );

  return NextResponse.json({ updatedAt: rows[0].updated_at.toISOString() });
}

export const PUT = handleWrite;
// POST allows navigator.sendBeacon (which always uses POST) on page unload
export const POST = handleWrite;

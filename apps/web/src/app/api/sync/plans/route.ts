/**
 * GET  /api/sync/plans — fetch the signed-in user's latest plans blob
 *   200: { plansJson: object, updatedAt: string }
 *   204: authenticated but no plans stored yet
 *   401: not signed in
 *
 * PUT  /api/sync/plans — replace the signed-in user's plans blob
 * POST /api/sync/plans — same as PUT (supports navigator.sendBeacon on unload)
 *   200: { updatedAt: string }
 *   400: invalid JSON or malformed body
 *   401: not signed in
 *   413: payload exceeds size limit
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession, type Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPool } from "@/lib/db";

// 1 MB hard limit; realistic Plans payloads are well under 50 KB.
const MAX_BODY_BYTES = 1_000_000;

function getUserId(session: Session | null): string | null {
  if (!session?.user) return null;
  // id is injected by the session callback in auth.ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (session.user as any).id ?? session.user.email ?? null;
}

// ── GET ─────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const session = await getServerSession(authOptions) as Session | null;
  const userId = getUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { rows } = await getPool().query<{ plans_json: string; updated_at: Date }>(
    "SELECT plans_json, updated_at FROM user_plans WHERE user_id = $1",
    [userId]
  );

  if (rows.length === 0) {
    return new NextResponse(null, { status: 204 });
  }

  let plansJson: unknown;
  try {
    plansJson = JSON.parse(rows[0].plans_json);
  } catch {
    // Stored data is corrupted — treat as missing
    return new NextResponse(null, { status: 204 });
  }

  return NextResponse.json({
    plansJson,
    updatedAt: rows[0].updated_at.toISOString(),
  });
}

// ── PUT / POST (shared handler) ──────────────────────────────────────────────

async function handleWrite(req: NextRequest): Promise<NextResponse> {
  const session = await getServerSession(authOptions) as Session | null;
  const userId = getUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  // Use UTF-8 byte length to match actual transmitted size — JS string .length
  // counts UTF-16 code units, which underestimates multi-byte characters.
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
    `INSERT INTO user_plans (user_id, plans_json, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET plans_json = EXCLUDED.plans_json,
           updated_at = NOW()
     RETURNING updated_at`,
    [userId, body]
  );

  return NextResponse.json({ updatedAt: rows[0].updated_at.toISOString() });
}

export const PUT = handleWrite;
// POST allows navigator.sendBeacon (which always uses POST) on page unload
export const POST = handleWrite;

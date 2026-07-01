/**
 * POST /api/tom/ask
 *
 * Server-side proxy that forwards questions to the Tom Railway service.
 * Keeps TOM_API_URL / TOM_API_KEY server-only so the browser never sees them.
 *
 * Gated by a shared caller token (DWP_TOM_PROXY_KEY) so this route can't be
 * used to burn the Tom API key from outside this app — Tom Q&A has no
 * account/session concept, so NextAuth's user session isn't applicable here.
 * Callers must send: x-dwp-tom-proxy-key: <DWP_TOM_PROXY_KEY>
 *
 * Request body:
 *   { question: string, session_id?: string, user_id?: string, park?: string, date?: string }
 *
 * Upstream: POST ${TOM_API_URL}/api/ask
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";

export const dynamic = "force-dynamic";

interface AskRequestBody {
  question?: unknown;
  session_id?: unknown;
  user_id?: unknown;
  park?: unknown;
  date?: unknown;
}

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message, meta: { ok: false } }, { status });
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export async function POST(request: NextRequest) {
  const proxyKey = process.env.DWP_TOM_PROXY_KEY;
  if (!proxyKey) {
    return errorResponse("Tom proxy is not configured", 500);
  }

  const callerKey = request.headers.get("x-dwp-tom-proxy-key");
  if (!callerKey || !safeEqual(callerKey, proxyKey)) {
    return errorResponse("Unauthorized", 401);
  }

  let body: AskRequestBody;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid request body", 400);
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return errorResponse("Missing question", 400);
  }

  const tomApiUrl = process.env.TOM_API_URL;
  const tomApiKey = process.env.TOM_API_KEY;
  if (!tomApiUrl || !tomApiKey) {
    return errorResponse("Tom is not configured", 500);
  }

  const context: Record<string, string> = { source: "disney-wait-planner" };
  const sessionId = asNonEmptyString(body.session_id);
  const userId = asNonEmptyString(body.user_id);
  const park = asNonEmptyString(body.park);
  const date = asNonEmptyString(body.date);
  if (sessionId) context.session_id = sessionId;
  if (userId) context.user_id = userId;
  if (park) context.park = park;
  if (date) context.date = date;

  let upstream: Response;
  try {
    upstream = await fetch(`${tomApiUrl}/api/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tomApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ question, context }),
      cache: "no-store",
    });
  } catch {
    return errorResponse("Failed to reach Tom", 500);
  }

  if (!upstream.ok) {
    return errorResponse("Tom request failed", 500);
  }

  let upstreamBody: unknown;
  try {
    upstreamBody = await upstream.json();
  } catch {
    return errorResponse("Tom returned an invalid response", 500);
  }

  const data =
    upstreamBody && typeof upstreamBody === "object"
      ? (upstreamBody as Record<string, unknown>)
      : {};

  const answer = asNonEmptyString(data.answer);
  if (!answer) {
    return errorResponse("Tom returned no answer", 500);
  }

  const sources = Array.isArray(data.sources) ? data.sources : [];

  return NextResponse.json({ answer, sources, meta: { ok: true } });
}

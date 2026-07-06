/**
 * POST /api/tom/ask
 *
 * Server-side proxy that forwards questions to the Tom Railway service.
 * Keeps TOM_API_URL / TOM_API_KEY server-only so the browser never sees them.
 *
 * DWP_TOM_PROXY_KEY is optional and only used for manual/admin test calls
 * (e.g. curl) via the x-dwp-tom-proxy-key header — normal browser requests
 * never send this header and are not required to. It is never sent by, or
 * documented for, browser/frontend code.
 *
 * Basic abuse protection: fixed-window rate limiting keyed by a
 * deployment-trusted client IP, always enforced, plus an IP+session_id
 * bucket when session_id is provided (so rotating session_id values
 * cannot bypass the IP cap). Caller-supplied "x-forwarded-for" is not
 * trusted for this purpose. See lib/tomRateLimit.ts.
 *
 * Request body:
 *   { question: string, session_id?: string, user_id?: string, park?: string, date?: string }
 *
 * Upstream: POST ${TOM_API_URL}/api/ask
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { checkTomRateLimit, getTrustedClientIp } from "@/lib/tomRateLimit";

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
  // Optional gate for manual/admin test calls only — normal browser requests
  // omit this header and skip straight to the validation below.
  const callerKey = request.headers.get("x-dwp-tom-proxy-key");
  if (callerKey !== null) {
    const proxyKey = process.env.DWP_TOM_PROXY_KEY;
    if (!proxyKey || !safeEqual(callerKey, proxyKey)) {
      return errorResponse("Unauthorized", 401);
    }
  }

  let body: AskRequestBody;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid request body", 400);
  }

  const rateLimitSessionId = asNonEmptyString(body.session_id);
  const clientIp = getTrustedClientIp(request);
  if (!checkTomRateLimit(clientIp, rateLimitSessionId).allowed) {
    console.warn("[tom/ask] rate limit exceeded", { ip: clientIp, hasSession: Boolean(rateLimitSessionId) });
    return errorResponse("Too many requests. Please try again soon.", 429);
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
  const sessionId = rateLimitSessionId;
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
    console.warn("[tom/ask] failed to reach Tom upstream");
    return errorResponse("Failed to reach Tom", 500);
  }

  if (!upstream.ok) {
    console.warn("[tom/ask] Tom upstream returned non-OK status", { status: upstream.status });
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

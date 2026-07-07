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
 *   { question: string, session_id?: string, user_id?: string, park?: string,
 *     date?: string, planner_context?: object }
 *
 * planner_context (Phase 10.4) is an optional, compact, read-only summary of
 * the caller's local Disney Wait Planner data (days, plans, Lightning
 * selections) — see lib/plannerContextSnapshot.ts on the client. It is
 * forwarded to Tom under context.planner for read-only Q&A only; this route
 * never uses it to write/modify planner data and applies a size cap so an
 * oversized or malformed value is safely dropped rather than forwarded.
 *
 * Upstream: POST ${TOM_API_URL}/api/ask
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { checkTomRateLimit, getTrustedClientIp } from "@/lib/tomRateLimit";

export const dynamic = "force-dynamic";

// Compact snapshots are well under this; guards against a malformed/oversized
// client payload reaching the upstream request.
const MAX_PLANNER_CONTEXT_BYTES = 30_000;

interface AskRequestBody {
  question?: unknown;
  session_id?: unknown;
  user_id?: unknown;
  park?: unknown;
  date?: unknown;
  planner_context?: unknown;
}

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message, meta: { ok: false } }, { status });
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Defensively validates the optional client-supplied planner context: must be
 * a plain JSON object under the size cap. Returns a deep JSON-cloned copy
 * (strips functions/prototype weirdness) or undefined if the value is
 * missing, malformed, or too large — malformed context is dropped silently
 * rather than failing the request, since the question can still be answered.
 */
function sanitizePlannerContext(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_PLANNER_CONTEXT_BYTES) return undefined;
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return undefined;
  }
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

  const context: Record<string, unknown> = { source: "disney-wait-planner" };
  const sessionId = rateLimitSessionId;
  const userId = asNonEmptyString(body.user_id);
  const park = asNonEmptyString(body.park);
  const date = asNonEmptyString(body.date);
  if (sessionId) context.session_id = sessionId;
  if (userId) context.user_id = userId;
  if (park) context.park = park;
  if (date) context.date = date;

  const plannerContext = sanitizePlannerContext(body.planner_context);
  if (plannerContext) context.planner = plannerContext;

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

/**
 * GET /api/waits/queue-times
 *
 * Server-side proxy that forwards queue time requests to Queue-Times.com.
 * Runs on the server, so there are no CORS issues from the browser.
 *
 * Query params:
 *   qtParkId  (required) — Queue-Times park ID (digits only)
 *
 * Upstream: https://queue-times.com/parks/{qtParkId}/queue_times.json
 */

import { NextRequest, NextResponse } from "next/server";

// Prevent Next.js / Vercel edge from statically caching this route.
// The only throttling mechanism is the 60 s in-memory TTL in liveWaitApi.ts.
export const dynamic = "force-dynamic";

const UPSTREAM_BASE = "https://queue-times.com/parks";

export async function GET(request: NextRequest) {
  const qtParkId = request.nextUrl.searchParams.get("qtParkId");

  // Validate: must be present and contain only digits
  if (!qtParkId || !/^\d+$/.test(qtParkId)) {
    return NextResponse.json(
      { error: "Missing or invalid qtParkId (digits only)" },
      { status: 400 },
    );
  }

  const url = `${UPSTREAM_BASE}/${qtParkId}/queue_times.json`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      // Bypass Next.js fetch cache entirely; liveWaitApi.ts owns the 60 s TTL.
      cache: "no-store",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to reach Queue-Times upstream" },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    return NextResponse.json(
      { error: `Upstream returned ${upstream.status}` },
      { status: 502 },
    );
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return NextResponse.json(
      { error: "Upstream returned non-JSON response" },
      { status: 502 },
    );
  }

  return NextResponse.json(body, {
    headers: {
      // Prevent edge/CDN caching; freshness is managed by liveWaitApi.ts TTL.
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

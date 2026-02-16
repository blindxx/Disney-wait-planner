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
      // Next.js fetch cache: revalidate every 60 seconds at the edge
      next: { revalidate: 60 },
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
      // Allow edge/CDN caching: fresh for 60 s, serve stale up to 5 min while revalidating
      "Cache-Control": "s-maxage=60, stale-while-revalidate=300",
    },
  });
}

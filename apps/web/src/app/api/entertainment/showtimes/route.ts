/**
 * GET /api/entertainment/showtimes?parkId=<DWP park id>
 *
 * Server-side boundary for Phase 12.3 Entertainment showtimes. Returns the
 * normalized ParkEntertainmentShowtimes contract from
 * lib/entertainmentShowtimes.ts; the browser never calls ThemeParks.wiki.
 * Provider failure is a 200 with `error` set and every mapped entry
 * `unavailable` (not an HTTP error) so consumers get one uniform shape.
 */

import { NextRequest, NextResponse } from "next/server";
import { getParkEntertainmentShowtimes } from "../../../../lib/entertainmentShowtimesService";
import { isValidParkId } from "../../../../lib/parkMetadata";

// The ThemeParks client owns caching (60 s live TTL); never cache at the edge.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const parkId = request.nextUrl.searchParams.get("parkId");
  if (!parkId || !isValidParkId(parkId)) {
    return NextResponse.json({ error: "Missing or invalid parkId" }, { status: 400 });
  }
  const result = await getParkEntertainmentShowtimes(parkId);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

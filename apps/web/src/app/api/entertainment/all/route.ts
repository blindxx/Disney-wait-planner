/**
 * GET /api/entertainment/all?parkId=<DWP park id>
 *
 * Server-side boundary for Phase 12.11 All Entertainment (hidden page
 * /entertainment/all): the park's live SHOW inventory, curated and
 * provider-only, labelled explicitly (see lib/entertainmentAll.ts). The
 * browser never calls ThemeParks.wiki. Provider failure is a 200 with `error`
 * set and no entries, like /api/entertainment/showtimes, which is unchanged.
 */

import { NextRequest, NextResponse } from "next/server";
import { getParkAllEntertainment } from "../../../../lib/entertainmentAllService";
import { isValidParkId } from "../../../../lib/parkMetadata";

// The ThemeParks client owns caching (60 s live TTL); never cache at the edge.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const parkId = request.nextUrl.searchParams.get("parkId");
  if (!parkId || !isValidParkId(parkId)) {
    return NextResponse.json({ error: "Missing or invalid parkId" }, { status: 400 });
  }
  const result = await getParkAllEntertainment(parkId);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

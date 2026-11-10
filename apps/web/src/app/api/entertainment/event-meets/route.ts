/**
 * GET /api/entertainment/event-meets?parkId=<DWP park id>
 *
 * Server-side boundary for Phase 14.4C event-exclusive character meets shown on
 * Waits & Shows (see lib/eventExclusiveMeets.ts). Providers are only contacted
 * on confirmed party dates. The browser never calls ThemeParks.wiki or
 * Queue-Times for this. Provider failure is a 200 with `error` set and no
 * entries, like the sibling entertainment routes.
 */

import { NextRequest, NextResponse } from "next/server";
import { getParkEventMeets } from "../../../../lib/eventExclusiveMeetsService";
import { isValidParkId } from "../../../../lib/parkMetadata";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const parkId = request.nextUrl.searchParams.get("parkId");
  if (!parkId || !isValidParkId(parkId)) {
    return NextResponse.json({ error: "Missing or invalid parkId" }, { status: 400 });
  }
  const result = await getParkEventMeets(parkId);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

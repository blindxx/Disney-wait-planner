/**
 * GET /api/park-hours?parkId=<DWP park id>[&date=YYYY-MM-DD]
 *
 * With `date` (Phase 12.6): the exact-date ParkDateHours contract for that
 * resort-local calendar date (My Plans). Without it: unchanged "now" contract.
 *
 * Server-side boundary for Phase 12.4 park hours. Returns the normalized
 * ParkHours contract from lib/parkHours.ts; the browser never calls
 * ThemeParks.wiki. Provider failure is a 200 with `status: "unavailable"` and
 * a typed `error` (not an HTTP error) so consumers get one uniform shape.
 */

import { NextRequest, NextResponse } from "next/server";
import { getParkHours, getParkHoursForDate } from "../../../lib/parkHoursService";
import { isValidParkId } from "../../../lib/parkMetadata";
import { isValidIsoCalendarDate } from "../../../lib/plannerWarnings";

// The ThemeParks client owns caching (15 min schedule TTL); never cache at the edge.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const parkId = request.nextUrl.searchParams.get("parkId");
  if (!parkId || !isValidParkId(parkId)) {
    return NextResponse.json({ error: "Missing or invalid parkId" }, { status: 400 });
  }
  const date = request.nextUrl.searchParams.get("date");
  if (date !== null) {
    if (!isValidIsoCalendarDate(date)) {
      return NextResponse.json({ error: "Invalid date (expected YYYY-MM-DD)" }, { status: 400 });
    }
    const exact = await getParkHoursForDate(parkId, date);
    return NextResponse.json(exact, { headers: { "Cache-Control": "no-store, max-age=0" } });
  }
  const result = await getParkHours(parkId);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

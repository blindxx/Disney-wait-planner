/**
 * GET /api/cron/park-hours — Phase 12.10.2B daily park-hours refresh.
 *
 * Invoked by Vercel Cron (apps/web/vercel.json, 02:00 UTC), which sends
 * `Authorization: Bearer $CRON_SECRET`. Fails CLOSED: with CRON_SECRET unset
 * the route does no work and returns 500; a missing/wrong header returns 401
 * before any provider or database call. See lib/parkHoursRefresh.ts.
 *
 * Status: 200 all six parks ok; 207 partial; 502 none ok; 409 a run is already
 * active on this instance. Body is the per-park report (no secrets, no raw
 * provider/database error text). Env: CRON_SECRET (server-only).
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeCronRequest, runParkHoursRefresh } from "../../../../lib/parkHoursRefresh";

export const dynamic = "force-dynamic";
/** Hobby-compatible ceiling; the refresh's own budget (45 s) finishes well inside it. */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(request: NextRequest) {
  const auth = authorizeCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET);
  if (auth === "unconfigured") return NextResponse.json({ error: "Cron is not configured" }, { status: 500, headers: NO_STORE });
  if (auth === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  const report = await runParkHoursRefresh();
  if (!report) return NextResponse.json({ error: "A refresh is already running" }, { status: 409, headers: NO_STORE });
  const status = report.ok ? 200 : report.counts.ok === 0 ? 502 : 207;
  return NextResponse.json(report, { status, headers: NO_STORE });
}

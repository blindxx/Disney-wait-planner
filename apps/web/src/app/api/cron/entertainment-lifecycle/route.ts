/**
 * GET /api/cron/entertainment-lifecycle — Phase 14.5C scheduled lifecycle monitor.
 *
 * Invoked by Vercel Cron (apps/web/vercel.json) TWICE daily, each run covering all
 * six parks: 03:30 UTC lands in the resort-local end-of-day window (22:00–24:00,
 * DST-safe) for Walt Disney World (22:30 EST / 23:30 EDT), 06:30 UTC for
 * Disneyland Resort (22:30 PST / 23:30 PDT). A park's negative observations only
 * count as final when made in ITS window (the other run's are provisional), so a
 * partial resort-local day is never final negative evidence. Sends
 * `Authorization: Bearer $CRON_SECRET`. Same fail-CLOSED auth as
 * /api/cron/park-hours: CRON_SECRET unset → 500, bad/missing header → 401, both
 * before any provider or database call. Idempotent and safe to invoke more often.
 * See lib/entertainmentLifecycleMonitor.ts.
 *
 * Status: 200 all six parks ok; 207 partial; 502 none ok; 409 a run is already
 * active on this instance. Body = per-park report (no secrets, no raw provider or
 * database error text). Env: CRON_SECRET, DATABASE_URL (server-only).
 */

import { NextRequest, NextResponse } from "next/server";
import { runEntertainmentLifecycleMonitor } from "../../../../lib/entertainmentLifecycleMonitor";
import { authorizeCronRequest } from "../../../../lib/parkHoursRefresh";

export const dynamic = "force-dynamic";
/** Hobby-compatible ceiling; the monitor's own budget (45 s) finishes inside it. */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(request: NextRequest) {
  const auth = authorizeCronRequest(request.headers.get("authorization"), process.env.CRON_SECRET);
  if (auth === "unconfigured") return NextResponse.json({ error: "Cron is not configured" }, { status: 500, headers: NO_STORE });
  if (auth === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  const report = await runEntertainmentLifecycleMonitor();
  if (!report) return NextResponse.json({ error: "A lifecycle run is already running" }, { status: 409, headers: NO_STORE });
  const status = report.ok ? 200 : report.counts.ok === 0 ? 502 : 207;
  return NextResponse.json(report, { status, headers: NO_STORE });
}

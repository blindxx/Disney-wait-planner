/**
 * GET /api/catalog/lifecycle-audit
 *
 * Phase 14.5C read-only, server-key-protected feed for the later scheduled
 * research audit (14.5E): every automatically hidden show, unresolved candidates
 * (provider-silence / registry-conflict flags) and the unreviewed decision
 * events with their evidence and coverage limitations. Same auth pattern as
 * /api/catalog/query: `x-dwp-catalog-api-key` vs DWP_CATALOG_API_KEY, timing-safe,
 * always required. Never writes; the audit proposes registry changes through a
 * normal commit/PR (candidates are never auto-promoted).
 *
 * Phase 14.5E-B1 (additive, auth unchanged): optional `?limit=` (1..1000, default
 * 200) for the unreviewed-event page, and completeness metadata in `meta`
 * (`generatedAt`, `eventLimit`, `eventsReturned`, `unreviewedTotal`,
 * `eventsTruncated`) so the GitHub Actions snapshot bridge can detect truncation
 * and stale/cached responses. Existing fields are unchanged.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getParkHoursPool } from "@/lib/db";
import { LIFECYCLE_AUDIT_MAX_LIMIT, readLifecycleAudit } from "@/lib/entertainmentLifecycleStore";
import { createPoolExecutor } from "@/lib/parkHoursStore";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export async function GET(request: NextRequest) {
  const expectedKey = process.env.DWP_CATALOG_API_KEY;
  if (!expectedKey) return NextResponse.json({ error: "Catalog API is not configured", meta: { ok: false } }, { status: 500, headers: NO_STORE });
  const providedKey = request.headers.get("x-dwp-catalog-api-key");
  if (!providedKey || !safeEqual(providedKey, expectedKey)) return NextResponse.json({ error: "Unauthorized", meta: { ok: false } }, { status: 401, headers: NO_STORE });
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "Lifecycle store is unavailable", meta: { ok: false } }, { status: 503, headers: NO_STORE });
  const rawLimit = request.nextUrl.searchParams.get("limit");
  let limit = 200;
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!/^\d+$/.test(rawLimit) || n < 1 || n > LIFECYCLE_AUDIT_MAX_LIMIT) return NextResponse.json({ error: "Invalid limit", meta: { ok: false } }, { status: 400, headers: NO_STORE });
    limit = n;
  }
  try {
    const report = await createPoolExecutor(getParkHoursPool()).run((q) => readLifecycleAudit(q, limit));
    const eventsReturned = report.unreviewedEvents.length;
    return NextResponse.json({
      ...report,
      meta: { ok: true, generatedAt: new Date().toISOString(), eventLimit: report.eventLimit, eventsReturned, unreviewedTotal: report.unreviewedTotal, eventsTruncated: report.unreviewedTotal > eventsReturned },
    }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Lifecycle store is unavailable", meta: { ok: false } }, { status: 503, headers: NO_STORE });
  }
}

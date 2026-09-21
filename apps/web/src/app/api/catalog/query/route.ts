/**
 * GET /api/catalog/query
 *
 * Server-only, authenticated, read-only DWP catalog query API — the DWP↔Tom
 * canonical catalog contract's producer side. Answers structured filter
 * queries (name/type/resort/park/land) against DWP's existing authoritative
 * planner/catalog metadata; see lib/catalogQuery.ts for the full contract
 * and sourcing rules (single-source-of-truth reuse, active-only behavior).
 *
 * This route deliberately does NOT accept or parse a natural-language
 * question — that responsibility stays with Tom. It also performs no
 * writes and no free-text search; every filter is matched against DWP's
 * existing canonical/alias resolvers.
 *
 * Auth: server-to-server only, via a shared secret in the
 * `x-dwp-catalog-api-key` header, checked with a timing-safe comparison —
 * mirrors /api/tom/ask's existing `x-dwp-tom-proxy-key` / DWP_TOM_PROXY_KEY
 * convention (see that route's doc comment), except the key is REQUIRED
 * here (never optional): unlike /api/tom/ask, which primarily serves
 * browser requests and only optionally gates manual/admin calls, this route
 * has no legitimate unauthenticated caller — every request must be a
 * trusted server (Tom).
 *
 * Env: DWP_CATALOG_API_KEY (server-only — never expose via NEXT_PUBLIC_*).
 *
 * Query params (all optional, combinable): name, type, resort, park, land.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { queryCatalog } from "@/lib/catalogQuery";

export const dynamic = "force-dynamic";

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message, meta: { ok: false } }, { status });
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export async function GET(request: NextRequest) {
  const expectedKey = process.env.DWP_CATALOG_API_KEY;
  if (!expectedKey) {
    return errorResponse("Catalog API is not configured", 500);
  }

  const providedKey = request.headers.get("x-dwp-catalog-api-key");
  if (!providedKey || !safeEqual(providedKey, expectedKey)) {
    return errorResponse("Unauthorized", 401);
  }

  const params = request.nextUrl.searchParams;
  const result = queryCatalog({
    name: params.get("name") ?? undefined,
    type: params.get("type") ?? undefined,
    resort: params.get("resort") ?? undefined,
    park: params.get("park") ?? undefined,
    land: params.get("land") ?? undefined,
  });

  if (!result.ok) {
    return errorResponse(result.error, 400);
  }

  return NextResponse.json({
    results: result.results,
    meta: { ok: true, count: result.results.length, ...(result.truncated ? { truncated: true } : {}) },
  });
}

/**
 * GET /api/tom/showtimes?park=<ParkId>[&show=<name>]
 *
 * Phase 12.8.1 — planner-independent, server-to-server Entertainment showtimes
 * lookup for Tom. Returns TODAY's (resort-local) showtimes for DWP's curated,
 * ThemeParks-mapped Entertainment in ONE park, with no dependence on planner
 * dates, planner parks, or saved Entertainment. Tom does the natural-language
 * park/show identification (and asks the user to clarify when ambiguous); DWP
 * validates the structured canonical ParkId only (mk, epcot, hs, ak,
 * disneyland, dca) and never inspects a question. Follow-up lookups after Tom
 * resolves an ambiguous show are just another call (optionally with `show`).
 *
 * Contract and semantics live in lib/tomScheduleContext.ts
 * (lookupTomParkShowtimes). Reuses getParkEntertainmentShowtimes() and its
 * cached, park-wide provider call; unmapped/provider-only shows are excluded.
 *
 * Auth: REQUIRED `x-dwp-catalog-api-key` header checked against
 * DWP_CATALOG_API_KEY (timing-safe) — the same server-to-server credential
 * Tom already uses for /api/catalog/query. No new env var; never NEXT_PUBLIC_*.
 *
 * Errors: 500 not configured, 401 unauthorized, 400 invalid/missing park or
 * invalid show. Provider failure is a 200 with `error` set (never fabricated).
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { lookupTomParkShowtimes } from "@/lib/tomScheduleContext";

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
  if (!expectedKey) return errorResponse("Showtimes API is not configured", 500);

  const providedKey = request.headers.get("x-dwp-catalog-api-key");
  if (!providedKey || !safeEqual(providedKey, expectedKey)) return errorResponse("Unauthorized", 401);

  const params = request.nextUrl.searchParams;
  // Exactly one park / at most one show: repeated params are ambiguous, never guessed.
  if (params.getAll("park").length > 1 || params.getAll("show").length > 1) {
    return errorResponse("Specify exactly one park (and at most one show)", 400);
  }
  const result = await lookupTomParkShowtimes(params.get("park") ?? undefined, params.get("show") ?? undefined);
  if (!result.ok) return errorResponse(result.error, result.status);

  return NextResponse.json(result.data, { headers: { "Cache-Control": "no-store, max-age=0" } });
}

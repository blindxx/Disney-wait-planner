/**
 * GET /api/sync/profiles — fetch the signed-in user's durable account-wide
 *   profile registry (SH.4.1 — Account Profile Registry; see the SH.4
 *   architecture audit this implements).
 *   200: { profiles: Array<{ profileId, name, updatedAt, deletedAt }> }
 *        Always 200 when authenticated, even with zero rows (empty array) —
 *        there is no separate "missing" status to distinguish, unlike the
 *        planner's 204: a profile simply not yet registered is represented
 *        the same way as "no rows at all", by being absent from this array.
 *        Tombstoned rows (`deletedAt` set) ARE included — the client needs
 *        them to avoid resurrecting a deleted profile during adoption; see
 *        profileRegistrySync.ts's own doc. Full delete lifecycle/UI is
 *        SH.4.3 — SH.4.1 never sets `deleted_at` itself.
 *   401: not signed in
 *
 * PUT /api/sync/profiles — additively register one or more local profiles
 *   that are not yet known to the account's registry (SH.4.1 legacy
 *   adoption — see profileRegistrySync.ts). This is the ONLY write this
 *   endpoint supports, and it is deliberately conflict-free: every insert
 *   is `ON CONFLICT (user_id, profile_id) DO NOTHING`, so a profileId the
 *   server already has a row for — active OR tombstoned — is silently left
 *   untouched, never renamed and never resurrected. Renaming or deleting an
 *   already-registered profile is SH.4.2/SH.4.3 scope, not this endpoint.
 *   body: { profiles: Array<{ profileId: string, name: string }> }
 *   200: { registered: string[] } — ids that were newly inserted by THIS
 *        request (an id already known, active or tombstoned, is simply
 *        omitted from this list — not an error)
 *   400: invalid JSON, a malformed body, or an empty/oversized `profiles`
 *        array — i.e. the ENVELOPE itself is unusable. An individual entry
 *        with an invalid profileId/name is instead silently skipped (Codex
 *        P2 follow-up) rather than failing the whole request — see
 *        parseAdoptBody's own doc — so this only returns 400 when NOTHING
 *        in the array validates
 *   401: not signed in
 *   413: payload exceeds size limit
 *
 * The server owns every timestamp this endpoint writes (`created_at`/
 * `updated_at` are both `NOW()`) — the client never supplies one, so there
 * is no client-clock trust issue. There is also no ordering DECISION to
 * make in the first place: because every write here is a conflict-free
 * additive insert (never an update), there is nothing for a revision or a
 * pending-op ledger to protect — unlike `/api/sync/planner`, this endpoint
 * has no merge/conflict step at all in SH.4.1.
 *
 * Deliberately NOT layered onto `/api/sync/planner` or given any of its
 * revision/pending-op/advisory-lock machinery: `user_profiles` stores
 * profile IDENTITY METADATA only (id + display name), never planner
 * content, and reconciling it must stay independent of planner-domain
 * conflict resolution — see the SH.4 registry audit for the full
 * rationale and profileRegistrySync.ts for the client-side half of this
 * contract.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession, type Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { getUserId, validateProfileId, validateProfileName } from "@/lib/syncIdentity";

// This route depends on the signed-in user's auth session and the database
// on every call — there is nothing cacheable/static about "the account's
// profile registry". Force dynamic rendering explicitly: without this,
// `next build` attempts to statically prerender this route's GET (this
// file has no other signal — such as reading a request searchParam, as
// /api/sync/planner's GET does — that would make Next treat it as dynamic
// automatically), which actually executes the handler at build time and
// fails hard against a build environment with no DATABASE_URL set, rather
// than deferring execution to request time as every sync route needs.
export const dynamic = "force-dynamic";

// Small metadata rows — 50 KB is generous for any realistic number of
// device-local profile names in one adoption request.
const MAX_BODY_BYTES = 50_000;

// Defensive cap — a real device's local profile list is expected to stay
// tiny; this only bounds the cost of a single malformed/abusive request.
const MAX_PROFILES_PER_REQUEST = 50;

type ProfileRow = { profile_id: string; name: string; updated_at: Date; deleted_at: Date | null };

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const session = (await getServerSession(authOptions)) as Session | null;
  const userId = getUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { rows } = await getPool().query<ProfileRow>(
    "SELECT profile_id, name, updated_at, deleted_at FROM user_profiles WHERE user_id = $1 ORDER BY profile_id",
    [userId]
  );

  return NextResponse.json({
    profiles: rows.map((r) => ({
      profileId: r.profile_id,
      name: r.name,
      updatedAt: r.updated_at.toISOString(),
      deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
    })),
  });
}

// ── PUT (additive adoption only) ─────────────────────────────────────────────

type AdoptEntry = { profileId: string; name: string };

/**
 * Parses and validates the PUT body.
 *
 * STRUCTURAL problems fail the WHOLE request (returns null -> 400): invalid
 * JSON, a missing/non-array `profiles` field, or an empty/oversized array.
 * There is no reasonable partial interpretation of a malformed envelope.
 *
 * An INDIVIDUAL entry with an invalid profileId/name is instead silently
 * SKIPPED rather than failing the whole batch (Codex P2 follow-up — this
 * endpoint previously failed closed on the first bad entry, mirroring
 * /api/sync/planner's philosophy; that philosophy fits planner's PUT, which
 * writes ONE interdependent blob where a partial write could genuinely
 * corrupt state, but does NOT fit this endpoint: every row here is an
 * independent, conflict-free additive insert (`ON CONFLICT DO NOTHING` per
 * row, in the same bulk statement), so one legacy/malformed/oversized entry
 * has no reason to block registration of every OTHER, unrelated valid
 * profile in the same adoption round). Returns null only when NOTHING in
 * the array validates — there is nothing to insert either way.
 */
function parseAdoptBody(raw: string): AdoptEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { profiles?: unknown }).profiles)
  ) {
    return null;
  }
  const rawProfiles = (parsed as { profiles: unknown[] }).profiles;
  if (rawProfiles.length === 0 || rawProfiles.length > MAX_PROFILES_PER_REQUEST) return null;

  const result: AdoptEntry[] = [];
  const seen = new Set<string>();
  for (const entry of rawProfiles) {
    if (!entry || typeof entry !== "object") continue; // skip this entry only, not the batch
    const rawId = (entry as { profileId?: unknown }).profileId;
    const profileId = validateProfileId(typeof rawId === "string" ? rawId : null);
    const name = validateProfileName((entry as { name?: unknown }).name);
    if (!profileId || !name) continue; // skip this entry only, not the batch
    if (seen.has(profileId)) continue; // duplicate within one request — harmless, dedupe
    seen.add(profileId);
    result.push({ profileId, name });
  }
  if (result.length === 0) return null;
  return result;
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const session = (await getServerSession(authOptions)) as Session | null;
  const userId = getUserId(session);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let body: string;
  try {
    body = await req.text();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const entries = parseAdoptBody(body);
  if (!entries) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const profileIds = entries.map((e) => e.profileId);
  const names = entries.map((e) => e.name);

  // Single conflict-free bulk insert: any (user_id, profile_id) already
  // present — active or tombstoned — is left completely untouched by
  // ON CONFLICT DO NOTHING, so this can never rename or resurrect an
  // existing row. RETURNING only reports the ids that were actually new.
  const { rows } = await getPool().query<{ profile_id: string }>(
    `INSERT INTO user_profiles (user_id, profile_id, name, created_at, updated_at)
     SELECT $1, x.profile_id, x.name, NOW(), NOW()
     FROM UNNEST($2::text[], $3::text[]) AS x(profile_id, name)
     ON CONFLICT (user_id, profile_id) DO NOTHING
     RETURNING profile_id`,
    [userId, profileIds, names]
  );

  return NextResponse.json({ registered: rows.map((r) => r.profile_id) });
}

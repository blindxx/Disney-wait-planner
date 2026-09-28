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
 * PUT /api/sync/profiles — SH.5 register-or-rename one or more local
 *   profiles for the account's registry (SH.4.1 legacy adoption AND SH.4.2
 *   rename propagation — see profileRegistrySync.ts). This is the ONLY
 *   write this endpoint supports. Every entry carries an explicit `intent`
 *   (defaults to `"adopt"` when omitted/invalid — the SAFER, conflict-free
 *   semantic), scoped to the caller's OWN `user_id` (never another
 *   account's row) via two SEPARATE queries, one per intent:
 *     - Codex finding #1 — `"adopt"` entries are INSERT-ONLY
 *       (`ON CONFLICT DO NOTHING`): an id the account has never seen is
 *       inserted; an id it already has a row for — active OR tombstoned —
 *       is left COMPLETELY untouched, never renamed. This is the original
 *       SH.4.1 additive-adoption guarantee, and it must hold even for a
 *       STALE adoption request (e.g. a delayed retry of computeProfilesToAdopt's
 *       own candidate list, sent after some OTHER push already registered
 *       the id under a different name) — an adopt entry can never act as
 *       an unintended rename.
 *     - `"rename"` entries are an UPSERT: an id the account already has an
 *       ACTIVE (non-tombstoned) row for has its `name`/`updated_at`
 *       UPDATED — last-write-wins, since a profile's display name has no
 *       independent revision/conflict model of its own (see
 *       profileRegistrySync.ts's computeProfilesToRename, the only client
 *       path that ever sends this intent — it requires an EXPLICIT, local
 *       pending-rename marker before proposing one). An id not yet known
 *       at all is still inserted (this account's own deliberate claim on
 *       the name), but a TOMBSTONED row is excluded from the UPDATE branch
 *       by its WHERE clause — never renamed, never resurrected, by either
 *       intent. Full delete lifecycle/UI beyond the existing device-local
 *       compatibility shim is still SH.4.3 scope.
 *   body: { profiles: Array<{ profileId: string, name: string, intent?: "adopt" | "rename" }> }
 *   200: { registered: string[] } — ids that were newly inserted OR renamed
 *        by THIS request (a tombstoned id, an adopt entry for an
 *        already-known id, or a push whose name already matched the stored
 *        row, is simply omitted from this list — not an error)
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
 * is no client-clock trust issue. The ordering DECISION for a rename is
 * simple last-write-wins on `name`/`updated_at`: there is nothing for a
 * revision or a pending-op ledger to protect here, unlike
 * `/api/sync/planner` — a display name has no interdependent fields a
 * partial/out-of-order write could corrupt, so this endpoint still has no
 * merge/conflict step of `/api/sync/planner`'s kind.
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
import {
  getUserId,
  validateProfileId,
  validateProfileName,
  MAX_PROFILES_PER_ADOPTION_REQUEST,
} from "@/lib/syncIdentity";

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

// ── PUT (adopt = insert-only; rename = explicit-intent update) ───────────────

type ProfileIntent = "adopt" | "rename";
type AdoptEntry = { profileId: string; name: string; intent: ProfileIntent };

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
 * independent write, so one legacy/malformed/oversized entry has no reason
 * to block registration of every OTHER, unrelated valid profile in the same
 * request). Returns null only when NOTHING in the array validates — there
 * is nothing to write either way.
 *
 * Codex finding #1 — `intent` defaults to `"adopt"` (the safer,
 * conflict-free/insert-only semantic) whenever it is missing or not exactly
 * `"rename"`: an older/malformed client that never sends this field gets
 * the ORIGINAL SH.4.1 additive-only behavior, never the update path, so it
 * can never accidentally rename an existing row it didn't explicitly ask
 * to rename.
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
  if (rawProfiles.length === 0 || rawProfiles.length > MAX_PROFILES_PER_ADOPTION_REQUEST) return null;

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
    const rawIntent = (entry as { intent?: unknown }).intent;
    const intent: ProfileIntent = rawIntent === "rename" ? "rename" : "adopt";
    result.push({ profileId, name, intent });
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

  const adoptEntries = entries.filter((e) => e.intent === "adopt");
  const renameEntries = entries.filter((e) => e.intent === "rename");
  const registered: string[] = [];

  // Codex finding #1 — "adopt" entries are INSERT-ONLY, exactly SH.4.1's
  // original additive-adoption guarantee: ON CONFLICT DO NOTHING means an
  // id this account already has ANY row for — active OR tombstoned — is
  // left completely untouched, never renamed. This must hold even for a
  // STALE adopt request (e.g. a delayed retry sent after some other push
  // already registered the id under a different name): an adopt entry can
  // never act as an unintended rename.
  if (adoptEntries.length > 0) {
    const { rows } = await getPool().query<{ profile_id: string }>(
      `INSERT INTO user_profiles (user_id, profile_id, name, created_at, updated_at)
       SELECT $1, x.profile_id, x.name, NOW(), NOW()
       FROM UNNEST($2::text[], $3::text[]) AS x(profile_id, name)
       ON CONFLICT (user_id, profile_id) DO NOTHING
       RETURNING profile_id`,
      [userId, adoptEntries.map((e) => e.profileId), adoptEntries.map((e) => e.name)]
    );
    registered.push(...rows.map((r) => r.profile_id));
  }

  // "rename" entries are an explicit-intent UPSERT, scoped to the caller's
  // own user_id (never another account's row): a KNOWN, ACTIVE row has its
  // name/updated_at UPDATED — last-write-wins, since a profile's display
  // name has no independent revision/conflict model of its own (see
  // profileRegistrySync.ts's computeProfilesToRename, the only client path
  // that ever sends this intent, and only for an id it holds an explicit,
  // local pending-rename marker for). An id not yet known at all is still
  // inserted (this account's own deliberate claim on the name). A
  // TOMBSTONED row (deleted_at IS NOT NULL) is excluded from the UPDATE
  // branch by the WHERE clause, so it is never renamed or resurrected. The
  // `name IS DISTINCT FROM` guard skips a no-op re-push so it doesn't
  // needlessly bump updated_at or appear in RETURNING.
  if (renameEntries.length > 0) {
    const { rows } = await getPool().query<{ profile_id: string }>(
      `INSERT INTO user_profiles (user_id, profile_id, name, created_at, updated_at)
       SELECT $1, x.profile_id, x.name, NOW(), NOW()
       FROM UNNEST($2::text[], $3::text[]) AS x(profile_id, name)
       ON CONFLICT (user_id, profile_id) DO UPDATE
         SET name = EXCLUDED.name, updated_at = NOW()
         WHERE user_profiles.deleted_at IS NULL
           AND user_profiles.name IS DISTINCT FROM EXCLUDED.name
       RETURNING profile_id`,
      [userId, renameEntries.map((e) => e.profileId), renameEntries.map((e) => e.name)]
    );
    registered.push(...rows.map((r) => r.profile_id));
  }

  return NextResponse.json({ registered });
}

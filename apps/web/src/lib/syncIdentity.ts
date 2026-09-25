/**
 * syncIdentity.ts — SH.4.1
 *
 * Shared authenticated-identity, profile-id, and profile-name validation for
 * the sync API routes AND local profile creation. Extracted out of
 * `/api/sync/planner/route.ts` so the profile-id shape rule has exactly one
 * maintained definition instead of being copy-pasted per route and risking
 * drift — the SH.4 registry audit called this out explicitly when scoping
 * `/api/sync/profiles`, which needs the exact same rule `/api/sync/planner`
 * already enforces (a profile registry row and a planner row must always
 * agree on what a valid profile id is).
 *
 * `/api/sync/plans` (the standalone legacy plans-only endpoint — see
 * AGENTS.md) has no profile-id concept at all and is unaffected.
 *
 * SH.4.1 Codex P2 follow-up — MAX_PROFILE_NAME_LENGTH/validateProfileName/
 * sanitizeProfileName below are the ONE maintained profile-name constraint,
 * shared by `/api/sync/profiles`'s PUT (server-side acceptance) and
 * profileStorage.ts's createProfile/renameProfile (client-side input
 * boundary) — previously the server kept its own private 200-char limit
 * that local creation didn't enforce at all, so a name typed locally could
 * pass client-side validation and only fail once it reached the server.
 * This module has no server-only dependency (no secrets, no Node-only API),
 * so it is safe to import from client code exactly like server route code.
 */

import type { Session } from "next-auth";

/**
 * Resolve the authenticated user's identity the same way every sync route
 * does: the adapter-assigned numeric id when present, falling back to email.
 * Returns null when there is no session (unauthenticated).
 */
export function getUserId(session: Session | null): string | null {
  if (!session?.user) return null;
  // id is injected by the session callback in auth.ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (session.user as any).id ?? session.user.email ?? null;
}

// Profile IDs are normalized on the client (lowercase, alphanumeric + dash,
// ≤32 chars — see profileStorage.ts's normalizeId/uniqueId). This pattern
// accepts a slightly broader shape to tolerate any edge cases, capped at 64
// chars — the same bound every sync table's `profile_id TEXT` column keys on.
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_\-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

/** Validates and trims a raw profile id string; returns null if invalid. */
export function validateProfileId(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (!PROFILE_ID_RE.test(trimmed)) return null;
  return trimmed;
}

// Maximum stored profile display-name length — matches /api/sync/profiles's
// PUT validation exactly (see validateProfileName below, which that route
// now imports from here instead of keeping its own copy).
export const MAX_PROFILE_NAME_LENGTH = 200;

/**
 * Strict validation matching `/api/sync/profiles`'s PUT contract exactly:
 * trims and REJECTS (returns null) an empty or over-limit name. Used by the
 * server to decide whether an individual adoption-batch entry is
 * acceptable, and by the client (profileRegistrySync.ts's
 * filterAdoptableProfiles) to pre-filter a batch before sending, so a
 * legacy oversized entry — one created before sanitizeProfileName existed
 * at the local input boundary — never even reaches the server as part of an
 * otherwise-valid batch.
 */
export function validateProfileName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_PROFILE_NAME_LENGTH) return null;
  return trimmed;
}

/**
 * Sanitizes a raw profile display name for LOCAL creation/rename
 * (profileStorage.ts's createProfile/renameProfile) — trims and TRUNCATES
 * (never rejects) to the shared limit, so a user's create/rename action
 * always succeeds with some valid, server-acceptable name rather than being
 * silently dropped over length alone. Returns null only for an empty/
 * whitespace-only name — callers decide their own fallback (createProfile
 * falls back to "New Profile"; renameProfile no-ops, matching its existing
 * behavior for an empty name).
 */
export function sanitizeProfileName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_PROFILE_NAME_LENGTH ? trimmed.slice(0, MAX_PROFILE_NAME_LENGTH) : trimmed;
}

// SH.4.1 Codex P2 follow-up (4th round) — the ONE maintained maximum number
// of profiles a single `/api/sync/profiles` PUT request may carry. Both
// route.ts's own request-size defense and profileRegistrySync.ts's
// batchProfilesForAdoption() (which splits an adoption round's candidates
// into requests the server will actually accept) import this same constant,
// so the two can never drift apart — without batching, the server rejecting
// an oversized `profiles` array fails the WHOLE request, and therefore
// every profile in it, repeatedly, on every future round, whenever a device
// has more than this many profiles to adopt at once.
export const MAX_PROFILES_PER_ADOPTION_REQUEST = 50;

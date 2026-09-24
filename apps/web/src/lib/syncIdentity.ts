/**
 * syncIdentity.ts — SH.4.1
 *
 * Shared authenticated-identity and profile-id validation for the sync API
 * routes. Extracted out of `/api/sync/planner/route.ts` so the profile-id
 * shape rule has exactly one maintained definition instead of being
 * copy-pasted per route and risking drift — the SH.4 registry audit called
 * this out explicitly when scoping `/api/sync/profiles`, which needs the
 * exact same rule `/api/sync/planner` already enforces (a profile registry
 * row and a planner row must always agree on what a valid profile id is).
 *
 * `/api/sync/plans` (the standalone legacy plans-only endpoint — see
 * AGENTS.md) has no profile-id concept at all and is unaffected.
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

/**
 * profileRegistrySync.ts — SH.4.1 Account Profile Registry
 *
 * Client-side reconciliation between the device-local profile list
 * (profileStorage.ts's `dwp.profiles`) and the durable, account-wide
 * registry (`user_profiles` table, via /api/sync/profiles).
 *
 * Deliberately NOT part of syncHelper.ts and never imported by it: this
 * reconciles profile IDENTITY METADATA (id + display name) only, never
 * planner content, and has no revision/pending-op/confirmed-baseline
 * machinery of its own. Registry reconciliation and planner sync
 * (SH.2/SH.3) run completely independently — neither calls into the
 * other — even though they share the same profileId as an addressing key.
 * See the SH.4 architecture audit for the full rationale.
 *
 * SH.4.1 scope — additive legacy adoption only:
 *   - Local profiles unknown to the CURRENT account's server registry are
 *     pushed up (registered). Codex P1 follow-up (3rd round) — this is NO
 *     LONGER cross-account exclusive: a local id already durably associated
 *     with a DIFFERENT account on this device is still eligible for the
 *     CURRENT account's own, independent adoption — see
 *     profileStorage.ts's module doc for why the previous "one owner slot
 *     per id, ever" model was itself the bug (it broke delete suppression
 *     for a second account, and more fundamentally, two accounts CAN each
 *     legitimately own their own distinct server row under the identical
 *     literal grandfathered id — `user_profiles`' PK is `(user_id,
 *     profile_id)`, so there is no server-side conflict between them).
 *   - Server profiles unknown locally, and neither tombstoned nor locally
 *     deleted BY THE CURRENT ACCOUNT on this device, are pulled down
 *     (discovered) — see profileStorage.ts's mergeProfilesAdditive/
 *     adoptServerProfiles for the local-merge half of this, and
 *     selectLocallyDeletedIdsForAccount for the account-scoping.
 *   - A server-known id (active OR tombstoned) is never overwritten by a
 *     stale local copy: the server enforces this with a conflict-free
 *     `ON CONFLICT DO NOTHING` insert, and this module mirrors it by never
 *     including an already-known id (computeProfilesToAdopt) in the
 *     adopt-push list in the first place.
 *   - A tombstoned (deletedAt set) server profile, OR an id THIS ACCOUNT has
 *     explicitly, locally deleted, is never pulled into the local list
 *     (selectActiveServerProfiles drops both). The local-delete case is a
 *     device-local, ACCOUNT-SCOPED compatibility shim only
 *     (profileStorage.ts's getLocallyDeletedProfileIds) — it does not touch
 *     the server's row, so other devices (or a different account on this
 *     SAME device) are unaffected — until SH.4.3 implements real
 *     server-side tombstones. Full delete lifecycle/UI beyond that is
 *     SH.4.3 scope.
 *   - A name that would fail the server's own validation (currently:
 *     empty, or longer than syncIdentity.ts's MAX_PROFILE_NAME_LENGTH) is
 *     filtered out of the adopt-push list per-entry (filterAdoptableProfiles
 *     — Codex P2 follow-up), rather than sent and rejected, or worse,
 *     allowed to fail the WHOLE batch — see filterAdoptableProfiles' own
 *     doc. New profiles created after this fix can never exceed the limit
 *     in the first place (profileStorage.ts's createProfile/renameProfile
 *     sanitize at the input boundary); this filter exists for legacy local
 *     profiles that predate that fix.
 *   - Every round that reaches the server successfully durably stamps
 *     ownership (profileStorage.ts's markProfileOwner) for every id the
 *     server confirms belongs to this account, keyed by `(profileId,
 *     userId)` — never affecting any other account's own entry for the
 *     same id. Codex P1 follow-up (2nd round) — this is NEVER decided from
 *     the PUT response's own `registered` field: a push whose response is
 *     lost or malformed may still have committed server-side, so whenever a
 *     push was attempted this round, ownership is instead decided from a
 *     fresh, AUTHORITATIVE re-GET performed right after it (see
 *     resolveAuthoritativeServerProfiles and reconcileProfileRegistry's own
 *     doc) — never from assuming the push failed just because its own
 *     response did. This closes the window where a commit that actually
 *     reached the server, but whose response didn't reach this client,
 *     would otherwise leave the id looking "unowned".
 *   - Renaming an id already known to the server is NOT propagated in
 *     either direction yet — SH.4.2 owns that policy. An id already present
 *     both locally and on the server keeps its LOCAL name untouched here.
 *   - `dwp.activeProfile` is never read or written anywhere in this module
 *     — it stays entirely device-local, exactly as it does today.
 *   - New-profile id generation (collision-resistant ids independent of
 *     name) is SH.4.2 scope; this module only ever adopts ids the device
 *     already has under today's name-derived scheme.
 *
 * SH.4.1 Codex P1 follow-up — every reconciliation round is bound to the
 * authenticated identity that started it via a lightweight epoch guard
 * (setRegistryIdentity/advanceRegistryIdentity/isRegistryRunCurrent below).
 * This is a cancellation TOKEN, not a planner-style revision/conflict
 * engine: it decides nothing about WHAT to merge, only WHETHER a given
 * in-flight round is still allowed to act (issue a request, or write to
 * `dwp.profiles`/the ownership map) once auth identity has moved on. See
 * reconcileProfileRegistry's own doc for exactly where it's checked.
 *
 * Codex P1 follow-up (2nd round) — this binding is a LIFECYCLE resource, not
 * just an auth-transition guard: the Settings integration that owns it MUST
 * invalidate it (call setRegistryIdentity(null)) on its own unmount, not
 * only when the resolved identity value changes. A round left bound to "the
 * last identity Settings happened to run under" would otherwise keep
 * looking current indefinitely once Settings unmounts — nothing else in the
 * app calls setRegistryIdentity — letting it complete a later request/local
 * write with no live UI still vouching for that identity. See
 * settings/page.tsx's own effect for where this is done.
 */

import {
  type Profile,
  getProfiles,
  adoptServerProfiles,
  markProfileOwner,
  getLocallyDeletedProfileIds,
} from "./profileStorage";
import { validateProfileName } from "./syncIdentity";

// ===== TYPES =====

/** One row as returned by GET /api/sync/profiles. */
export type ServerProfileRecord = {
  profileId: string;
  name: string;
  updatedAt: string;
  deletedAt: string | null;
};

// ===== PURE RECONCILIATION LOGIC =====

/**
 * Given the full server registry (including tombstones) FOR THE CURRENT
 * ACCOUNT, and this device's current local profile list, compute the local
 * profiles that should be PUSHED to that account's server registry because
 * it does not yet know about their id — by id alone, regardless of
 * tombstone state. A tombstoned id is already "known" to the server and
 * must never be re-adopted/resurrected via this path; only an explicit,
 * deliberate un-delete (not implemented in SH.4.1) may ever clear a
 * tombstone. A local id whose name differs from what the server already
 * has under the same id is likewise excluded — this function only ever
 * proposes ids the server has NEVER seen, never a "correction" to one it
 * has.
 *
 * Codex P1 follow-up (3rd round) — this function is intentionally
 * ACCOUNT-AGNOSTIC beyond `serverProfiles` already being scoped to the
 * caller's own account (by construction — every `GET /api/sync/profiles`
 * only ever returns the authenticated account's own rows). It does NOT
 * exclude a local id merely because a DIFFERENT account has separately
 * claimed it on this device: `serverProfiles` is already authoritative for
 * "does MY account know this id" (a failed GET aborts the whole
 * reconciliation round before this function is ever called — see
 * reconcileProfileRegistry — so `known` here is always complete and
 * correct for the CURRENT account when this runs), and `user_profiles`'
 * PK is `(user_id, profile_id)`, so a second account registering the
 * identical literal id creates its own, entirely unrelated row — there is
 * no server-side reason to block it. The PRIOR round's cross-account
 * ownership exclusion was itself the bug this fixes (see
 * profileStorage.ts's module doc): it silently gave whichever account
 * reconciled an id FIRST a permanent, exclusive local claim to it, which
 * both prevented a second account's own legitimate, distinct history under
 * that id from ever registering AND broke that second account's own
 * delete-suppression.
 *
 * Pure — takes every input as a parameter, so it stays directly
 * DEV-testable without a browser/localStorage.
 *
 * Run from Node:
 *   import { DEV_COMPUTE_PROFILES_TO_ADOPT_CASES, computeProfilesToAdopt } from "@/lib/profileRegistrySync";
 *   DEV_COMPUTE_PROFILES_TO_ADOPT_CASES.forEach(c => {
 *     const got = computeProfilesToAdopt(c.serverProfiles, c.localProfiles);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function computeProfilesToAdopt(
  serverProfiles: ServerProfileRecord[],
  localProfiles: Profile[]
): Profile[] {
  const known = new Set(serverProfiles.map((p) => p.profileId));
  return localProfiles.filter((p) => !known.has(p.id));
}

export const DEV_COMPUTE_PROFILES_TO_ADOPT_CASES: Array<{
  name: string;
  serverProfiles: ServerProfileRecord[];
  localProfiles: Profile[];
  expected: Profile[];
}> = [
  {
    name: "empty server + existing local custom profiles — additive adoption of everything",
    serverProfiles: [],
    localProfiles: [
      { id: "default", name: "Default" },
      { id: "mom", name: "Mom" },
    ],
    expected: [
      { id: "default", name: "Default" },
      { id: "mom", name: "Mom" },
    ],
  },
  {
    name: "grandfathered custom id preserved exactly in the push list — no id/name rewriting",
    serverProfiles: [],
    localProfiles: [{ id: "lindsay-2", name: "Lindsay" }],
    expected: [{ id: "lindsay-2", name: "Lindsay" }],
  },
  {
    name: "same id already server-known (active) — local stale name never re-pushed/overwritten",
    serverProfiles: [
      { profileId: "mom", name: "Mom", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    localProfiles: [{ id: "mom", name: "Mommy (stale local copy)" }],
    expected: [],
  },
  {
    name: "tombstoned server id — local stale copy never re-pushed/resurrected via adoption",
    serverProfiles: [
      {
        profileId: "mom",
        name: "Mom",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-02-01T00:00:00.000Z",
      },
    ],
    localProfiles: [{ id: "mom", name: "Mom" }],
    expected: [],
  },
  {
    name: "mixed — only the genuinely unknown local id is proposed for adoption",
    serverProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    localProfiles: [
      { id: "default", name: "Default" },
      { id: "lindsay", name: "Lindsay" },
    ],
    expected: [{ id: "lindsay", name: "Lindsay" }],
  },
  {
    name: "unowned legacy profile remains adoptable",
    serverProfiles: [],
    localProfiles: [{ id: "legacy-trip", name: "Legacy Trip" }],
    expected: [{ id: "legacy-trip", name: "Legacy Trip" }],
  },
  {
    name: "Codex P1 follow-up (3rd round) — B can adopt B's own local 'family' even though A already owns 'family' on this same device/server-agnostic local list — B's OWN (empty) registry is what governs B's adoption, not A's prior claim",
    serverProfiles: [], // B's own GET — B's account has never registered "family"
    localProfiles: [{ id: "family", name: "Family" }],
    expected: [{ id: "family", name: "Family" }],
  },
];

/**
 * Filters `candidates` down to entries whose name satisfies
 * syncIdentity.ts's shared MAX_PROFILE_NAME_LENGTH constraint, dropping any
 * individual entry that doesn't (Codex P2 follow-up) — never failing the
 * whole batch over one legacy/malformed entry. Mirrors, client-side, the
 * SAME per-entry skip behavior `/api/sync/profiles`'s PUT now applies
 * server-side (parseAdoptBody in route.ts) — applying it here too means an
 * oversized legacy entry doesn't even cost a wasted network round-trip
 * before being dropped, and keeps this module's own adoption decision
 * self-contained/verifiable independent of the server's own validation.
 * New profiles created after this fix can never exceed the limit in the
 * first place (profileStorage.ts's createProfile/renameProfile sanitize at
 * the input boundary) — this filter exists for legacy local profiles that
 * predate that fix and may already carry an oversized name.
 *
 * Pure — takes every input as a parameter.
 *
 * Run from Node:
 *   import { DEV_FILTER_ADOPTABLE_PROFILES_CASES, filterAdoptableProfiles } from "@/lib/profileRegistrySync";
 *   DEV_FILTER_ADOPTABLE_PROFILES_CASES.forEach(c => {
 *     const got = filterAdoptableProfiles(c.candidates);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function filterAdoptableProfiles(candidates: Profile[]): Profile[] {
  return candidates.filter((p) => validateProfileName(p.name) !== null);
}

export const DEV_FILTER_ADOPTABLE_PROFILES_CASES: Array<{
  name: string;
  candidates: Profile[];
  expected: Profile[];
}> = [
  {
    name: "valid names continue unchanged",
    candidates: [
      { id: "default", name: "Default" },
      { id: "mom", name: "Mom" },
    ],
    expected: [
      { id: "default", name: "Default" },
      { id: "mom", name: "Mom" },
    ],
  },
  {
    name: "Codex P2 follow-up — one oversized legacy profile is dropped, valid siblings in the same batch still adopt",
    candidates: [
      { id: "default", name: "Default" },
      { id: "legacy-huge", name: "L".repeat(250) },
      { id: "mom", name: "Mom" },
    ],
    expected: [
      { id: "default", name: "Default" },
      { id: "mom", name: "Mom" },
    ],
  },
  {
    name: "a name at exactly the shared limit is still valid",
    candidates: [{ id: "exact", name: "N".repeat(200) }],
    expected: [{ id: "exact", name: "N".repeat(200) }],
  },
  {
    name: "an empty/whitespace-only legacy name is also dropped, not just an oversized one",
    candidates: [
      { id: "blank", name: "   " },
      { id: "mom", name: "Mom" },
    ],
    expected: [{ id: "mom", name: "Mom" }],
  },
];

/**
 * Given the server registry, return the ACTIVE (non-tombstoned) profiles,
 * excluding any id this device has explicitly, locally deleted
 * (`locallyDeletedIds` — profileStorage.ts's getLocallyDeletedProfileIds(),
 * the SH.4.1 delete/discovery compatibility shim — see this module's own
 * doc above), in the plain {id,name} shape profileStorage.ts's local list
 * uses. Pass the result to profileStorage.ts's adoptServerProfiles to
 * actually merge it in. Pure — takes every input as a parameter.
 *
 * Run from Node:
 *   import { DEV_SELECT_ACTIVE_SERVER_PROFILES_CASES, selectActiveServerProfiles } from "@/lib/profileRegistrySync";
 *   DEV_SELECT_ACTIVE_SERVER_PROFILES_CASES.forEach(c => {
 *     const got = selectActiveServerProfiles(c.serverProfiles, c.locallyDeletedIds);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function selectActiveServerProfiles(
  serverProfiles: ServerProfileRecord[],
  locallyDeletedIds: ReadonlySet<string>
): Profile[] {
  return serverProfiles
    .filter((p) => !p.deletedAt && !locallyDeletedIds.has(p.profileId))
    .map((p) => ({ id: p.profileId, name: p.name }));
}

export const DEV_SELECT_ACTIVE_SERVER_PROFILES_CASES: Array<{
  name: string;
  serverProfiles: ServerProfileRecord[];
  locallyDeletedIds: Set<string>;
  expected: Profile[];
}> = [
  {
    name: "server profiles + fresh device containing only local Default — active profiles surfaced for discovery",
    serverProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
      { profileId: "mom", name: "Mom", updatedAt: "2026-01-02T00:00:00.000Z", deletedAt: null },
    ],
    locallyDeletedIds: new Set(),
    expected: [
      { id: "default", name: "Default" },
      { id: "mom", name: "Mom" },
    ],
  },
  {
    name: "tombstoned server profile excluded from discovery entirely",
    serverProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
      {
        profileId: "mom",
        name: "Mom",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-02-01T00:00:00.000Z",
      },
    ],
    locallyDeletedIds: new Set(),
    expected: [{ id: "default", name: "Default" }],
  },
  {
    name: "Codex P1 #3 — an id this device explicitly deleted locally is suppressed from rediscovery even though the server row is still active",
    serverProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
      { profileId: "mom", name: "Mom", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    locallyDeletedIds: new Set(["mom"]),
    expected: [{ id: "default", name: "Default" }],
  },
  {
    name: "empty server registry — nothing to discover",
    serverProfiles: [],
    locallyDeletedIds: new Set(),
    expected: [],
  },
];

// ===== IDENTITY-BOUND STALE-RUN GUARD (Codex P1 finding #1) =====
//
// A reconciliation round is asynchronous (GET, then PUT, then local writes)
// and must not be allowed to act under an identity that is no longer
// current by the time each step resolves — e.g. the session transitions
// from user A to user B while A's round is still in flight. This is a
// plain, pure epoch counter: NOT a planner-style revision/conflict engine
// (it has no ordering contract over DATA, no persisted state, and decides
// nothing about what to merge) — it only answers "is this specific
// in-flight round still allowed to act at all".

export type RegistryIdentityState = { currentUserId: string | null; epoch: number };

/**
 * Pure state-transition step: advances to `nextUserId`, bumping `epoch`
 * only when the identity actually changes (including to/from null on
 * sign-out/loading). A no-op (same state returned) when `nextUserId` already
 * matches — mirrors syncHelper.ts's setSyncUserId()/setSyncProfileId() no-op
 * guard, kept as an entirely separate state machine so registry
 * reconciliation never shares mutable state with planner sync.
 */
export function advanceRegistryIdentity(
  state: RegistryIdentityState,
  nextUserId: string | null
): RegistryIdentityState {
  if (nextUserId === state.currentUserId) return state;
  return { currentUserId: nextUserId, epoch: state.epoch + 1 };
}

/**
 * Pure staleness check: a round captured under `capturedUserId` at
 * `capturedEpoch` may still act only while `state` has NOT moved on to any
 * other identity since — including a later round back to the SAME user id
 * (e.g. A -> B -> A): that later A is a NEW round with its own freshly
 * captured epoch, and the ORIGINAL A round must still be treated as stale,
 * since it has no way to know what happened while B was current.
 *
 * Run from Node:
 *   import { DEV_STALE_RUN_GUARD_CASES, advanceRegistryIdentity, isRegistryRunCurrent } from "@/lib/profileRegistrySync";
 *   DEV_STALE_RUN_GUARD_CASES.forEach(c => {
 *     let state: import("@/lib/profileRegistrySync").RegistryIdentityState = { currentUserId: null, epoch: 0 };
 *     state = advanceRegistryIdentity(state, c.capturedUserId); // the round starts under this identity
 *     const capturedEpoch = state.epoch;
 *     for (const nextUserId of c.laterTransitions) state = advanceRegistryIdentity(state, nextUserId);
 *     const got = isRegistryRunCurrent(state, c.capturedUserId, capturedEpoch);
 *     console.log(got === c.expectedStillCurrent ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function isRegistryRunCurrent(
  state: RegistryIdentityState,
  capturedUserId: string,
  capturedEpoch: number
): boolean {
  return state.currentUserId === capturedUserId && state.epoch === capturedEpoch;
}

export const DEV_STALE_RUN_GUARD_CASES: Array<{
  name: string;
  capturedUserId: string;
  laterTransitions: Array<string | null>;
  expectedStillCurrent: boolean;
}> = [
  {
    name: "no identity change while the round is in flight — it remains current",
    capturedUserId: "userA",
    laterTransitions: [],
    expectedStillCurrent: true,
  },
  {
    name: "Codex P1 #1 — identity changes to B before the round resolves — A's round is no longer current",
    capturedUserId: "userA",
    laterTransitions: ["userB"],
    expectedStillCurrent: false,
  },
  {
    name: "identity drops to signed-out before the round resolves — A's round is no longer current",
    capturedUserId: "userA",
    laterTransitions: [null],
    expectedStillCurrent: false,
  },
  {
    name: "identity changes to B then back to A — the ORIGINAL A round is still stale (a new round under A must be captured fresh)",
    capturedUserId: "userA",
    laterTransitions: ["userB", "userA"],
    expectedStillCurrent: false,
  },
  {
    name: "Codex P1 follow-up (2nd round) — Settings unmounts while A's round is in flight (cleanup invalidates to null) — the pending A round is stale",
    capturedUserId: "userA",
    laterTransitions: [null],
    expectedStillCurrent: false,
  },
  {
    name: "Codex P1 follow-up (2nd round) — Settings unmounts (-> null) then remounts as B — A's original round is still stale, exactly as a direct A -> B transition would be",
    capturedUserId: "userA",
    laterTransitions: [null, "userB"],
    expectedStillCurrent: false,
  },
];

let registryIdentityState: RegistryIdentityState = { currentUserId: null, epoch: 0 };

/**
 * Call this with the resolved authenticated identity (including null on
 * sign-out/loading) on every auth-state re-render — mirrors syncHelper.ts's
 * setSyncUserId() for planner sync, kept entirely separate. Must be called
 * BEFORE starting a reconciliation round for a given identity (see
 * reconcileProfileRegistry, which refuses to run otherwise) — this is what
 * lets a later call from a DIFFERENT identity invalidate an earlier,
 * still-in-flight round for the previous one.
 */
export function setRegistryIdentity(userId: string | null): void {
  registryIdentityState = advanceRegistryIdentity(registryIdentityState, userId);
}

// ===== AMBIGUOUS ADOPTION OUTCOME RESOLUTION (Codex P1 follow-up #3) =====

/**
 * Decide which server-profile set is AUTHORITATIVE for this round's
 * ownership-stamping and discovery — i.e. never derived from a PUT's own
 * (possibly lost/malformed) response. When no push was attempted this
 * round, the initial GET is already authoritative (nothing could have
 * changed server-side that this round itself caused). When a push WAS
 * attempted, a commit that reached the server but whose response never
 * reached this client must still be reflected — so the fresh, confirmatory
 * re-GET performed right after the push (`reconfirmedServerProfiles`) is
 * used instead, whenever it itself succeeded. If even THAT re-GET fails
 * (`null`), this deliberately falls back to the pre-push snapshot rather
 * than guessing: nothing gets falsely stamped as owned this round, and a
 * LATER round's fresh GET will correctly pick up a commit that did land,
 * with no retry loop needed here.
 *
 * Pure — takes every input as a parameter.
 *
 * Run from Node:
 *   import { DEV_RESOLVE_AUTHORITATIVE_SERVER_PROFILES_CASES, resolveAuthoritativeServerProfiles } from "@/lib/profileRegistrySync";
 *   DEV_RESOLVE_AUTHORITATIVE_SERVER_PROFILES_CASES.forEach(c => {
 *     const got = resolveAuthoritativeServerProfiles(c.initialServerProfiles, c.pushAttempted, c.reconfirmedServerProfiles);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function resolveAuthoritativeServerProfiles(
  initialServerProfiles: ServerProfileRecord[],
  pushAttempted: boolean,
  reconfirmedServerProfiles: ServerProfileRecord[] | null
): ServerProfileRecord[] {
  if (pushAttempted && reconfirmedServerProfiles !== null) return reconfirmedServerProfiles;
  return initialServerProfiles;
}

export const DEV_RESOLVE_AUTHORITATIVE_SERVER_PROFILES_CASES: Array<{
  name: string;
  initialServerProfiles: ServerProfileRecord[];
  pushAttempted: boolean;
  reconfirmedServerProfiles: ServerProfileRecord[] | null;
  expected: ServerProfileRecord[];
}> = [
  {
    name: "no push attempted this round — the initial GET is already authoritative",
    initialServerProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    pushAttempted: false,
    reconfirmedServerProfiles: null,
    expected: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
  },
  {
    name: "Codex P1 follow-up #3 — push attempted, PUT response lost, but the confirmatory re-GET reveals the commit that actually happened",
    initialServerProfiles: [],
    pushAttempted: true,
    reconfirmedServerProfiles: [
      { profileId: "family", name: "Family", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    expected: [
      { profileId: "family", name: "Family", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
  },
  {
    name: "push attempted and the re-GET confirms nothing new committed — falls back correctly to the (unchanged) initial snapshot",
    initialServerProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    pushAttempted: true,
    reconfirmedServerProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    expected: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
  },
  {
    name: "push attempted but even the confirmatory re-GET failed — conservatively falls back to the pre-push snapshot rather than guessing",
    initialServerProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    pushAttempted: true,
    reconfirmedServerProfiles: null,
    expected: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
  },
];

// ===== NETWORK ORCHESTRATION =====
//
// Everything below is a thin, best-effort I/O wrapper around the pure
// functions above. It is deliberately NOT exercised by DEV_* cases (it has
// no interesting branching of its own — every actual decision lives in the
// pure functions, which the cases above cover directly) and never throws:
// exactly like syncHelper.ts's scheduleSync()/doPush(), a failed/absent
// network response degrades to a silent no-op rather than surfacing an
// error to the page, since the local-first profile list already works
// fully offline.

type ProfilesGetResponse = { profiles: ServerProfileRecord[] };

function isServerProfileRecord(value: unknown): value is ServerProfileRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.profileId === "string" &&
    typeof v.name === "string" &&
    typeof v.updatedAt === "string" &&
    (v.deletedAt === null || typeof v.deletedAt === "string")
  );
}

async function fetchServerProfiles(): Promise<ServerProfileRecord[] | null> {
  try {
    const res = await fetch("/api/sync/profiles", { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<ProfilesGetResponse> | null;
    if (!data || !Array.isArray(data.profiles) || !data.profiles.every(isServerProfileRecord)) {
      return null;
    }
    return data.profiles;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget push of the adopt-list. Codex P1 follow-up (2nd round) —
 * its outcome (success, non-2xx, a lost/malformed response, or a thrown
 * network error) is deliberately NEVER used to decide ownership:
 * reconcileProfileRegistry always re-confirms via a fresh, authoritative GET
 * afterward instead (see resolveAuthoritativeServerProfiles's own doc),
 * since a commit that reached the server but whose response never reached
 * this client must still be reflected, not treated as though it never
 * happened. Swallows all errors — best-effort, exactly like
 * scheduleSync()'s doPush() for planner sync.
 */
async function pushProfilesToAdopt(toAdopt: Profile[]): Promise<void> {
  if (toAdopt.length === 0) return;
  try {
    await fetch("/api/sync/profiles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profiles: toAdopt.map((p) => ({ profileId: p.id, name: p.name })),
      }),
    });
  } catch {
    // Best-effort — the confirmatory re-GET below determines what actually
    // committed, regardless of what happened to this request/response.
  }
}

/**
 * Runs one round of registry reconciliation for `userId`, the authenticated
 * identity the caller has ALREADY bound via setRegistryIdentity(userId)
 * (called synchronously, immediately before this) — refuses to run at all
 * if that binding doesn't hold, and re-checks it after every await before
 * issuing the next request or writing anything locally (see
 * isRegistryRunCurrent's own doc): if the identity has moved on — including
 * to null, which the Settings integration's unmount cleanup sets — this
 * round stops immediately, performing no further request and no local
 * mutation. Silently no-ops on any auth/network failure — never throws,
 * never blocks page rendering, and never touches planner content or
 * `dwp.activeProfile`.
 *
 * Codex P1 follow-up (2nd round) finding #3 — when this round proposes
 * anything to adopt, its outcome is never taken on faith from the PUT's own
 * response: a fresh, authoritative re-GET runs right after the push, and
 * ownership/discovery for this round are both decided from THAT result
 * (resolveAuthoritativeServerProfiles), never from the push response. This
 * closes the window where a push that actually committed server-side, but
 * whose response was lost, would otherwise leave the id "unowned".
 *
 * Codex P1/P2 follow-up (3rd round) — `computeProfilesToAdopt` no longer
 * excludes a local id merely because a DIFFERENT account owns it on this
 * device (see its own doc); `filterAdoptableProfiles` drops any individual
 * candidate whose name fails the shared length constraint instead of
 * letting it poison the whole push; and `getLocallyDeletedProfileIds(userId)`
 * only ever suppresses discovery for ids THIS account (or no account) has
 * locally deleted, never a different account's own same-id deletion.
 */
export async function reconcileProfileRegistry(userId: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (registryIdentityState.currentUserId !== userId) return;
  const capturedEpoch = registryIdentityState.epoch;
  const isCurrent = () => isRegistryRunCurrent(registryIdentityState, userId, capturedEpoch);

  const initialServerProfiles = await fetchServerProfiles();
  if (!isCurrent() || initialServerProfiles === null) return;

  const localProfiles = getProfiles();
  const toAdopt = filterAdoptableProfiles(computeProfilesToAdopt(initialServerProfiles, localProfiles));

  const pushAttempted = toAdopt.length > 0;
  let reconfirmedServerProfiles: ServerProfileRecord[] | null = null;
  if (pushAttempted) {
    await pushProfilesToAdopt(toAdopt);
    if (!isCurrent()) return;
    reconfirmedServerProfiles = await fetchServerProfiles();
    if (!isCurrent()) return;
  }

  const authoritativeServerProfiles = resolveAuthoritativeServerProfiles(
    initialServerProfiles,
    pushAttempted,
    reconfirmedServerProfiles
  );

  // Every id the server authoritatively confirms as this account's is
  // durably stamped as owned by `userId` — keyed by (profileId, userId), so
  // this NEVER disturbs any other account's own independent entry for the
  // same literal id (Codex P1 follow-up, 3rd round — see
  // profileStorage.ts's applyProfileOwnerStamp/module doc).
  for (const id of authoritativeServerProfiles.map((p) => p.profileId)) {
    markProfileOwner(id, userId);
  }

  const locallyDeletedIds = getLocallyDeletedProfileIds(userId);
  adoptServerProfiles(selectActiveServerProfiles(authoritativeServerProfiles, locallyDeletedIds));
}

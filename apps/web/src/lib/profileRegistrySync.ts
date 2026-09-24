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
 *   - Local profiles unknown to the server, and not durably owned by a
 *     DIFFERENT account on this device, are pushed up (registered).
 *   - Server profiles unknown locally, and neither tombstoned nor locally
 *     deleted on this device, are pulled down (discovered) — see
 *     profileStorage.ts's mergeProfilesAdditive/adoptServerProfiles for the
 *     local-merge half of this.
 *   - A server-known id (active OR tombstoned) is never overwritten by a
 *     stale local copy: the server enforces this with a conflict-free
 *     `ON CONFLICT DO NOTHING` insert, and this module mirrors it by never
 *     including an already-known id (computeProfilesToAdopt) in the
 *     adopt-push list in the first place.
 *   - A tombstoned (deletedAt set) server profile, OR an id THIS DEVICE has
 *     explicitly, locally deleted, is never pulled into the local list
 *     (selectActiveServerProfiles drops both). The local-delete case is a
 *     device-local compatibility shim only (profileStorage.ts's
 *     getLocallyDeletedProfileIds) — it does not touch the server's row, so
 *     other devices are unaffected — until SH.4.3 implements real
 *     server-side tombstones. Full delete lifecycle/UI beyond that is
 *     SH.4.3 scope.
 *   - A local profile id already durably associated with a DIFFERENT
 *     account (profileStorage.ts's getProfileOwners) is NEVER proposed for
 *     adoption into the current account, even if the current account's
 *     registry doesn't know about it yet — this is what stops account A's
 *     profiles from bleeding into account B's registry merely because both
 *     signed into the same browser. An id with NO owner yet (the common
 *     case for every pre-SH.4 legacy profile) remains freely adoptable by
 *     whichever account reconciles it first.
 *   - Every round that reaches the server successfully durably stamps
 *     ownership (profileStorage.ts's markProfileOwner) for every id the
 *     server confirms belongs to this account — both what GET already
 *     returned and what this round's PUT just registered — so a LATER
 *     reconciliation under a different account can correctly refuse to
 *     re-adopt it.
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
 */

import {
  type Profile,
  getProfiles,
  adoptServerProfiles,
  getProfileOwners,
  markProfileOwner,
  getLocallyDeletedProfileIds,
} from "./profileStorage";

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
 * Given the full server registry (including tombstones) and this device's
 * current local profile list, compute the local profiles that should be
 * PUSHED to the server because it does not yet know about their id — by id
 * alone, regardless of tombstone state. A tombstoned id is already "known"
 * to the server and must never be re-adopted/resurrected via this path;
 * only an explicit, deliberate un-delete (not implemented in SH.4.1) may
 * ever clear a tombstone. A local id whose name differs from what the
 * server already has under the same id is likewise excluded — this
 * function only ever proposes ids the server has NEVER seen, never a
 * "correction" to one it has.
 *
 * `profileOwners` (profileStorage.ts's getProfileOwners()) is this device's
 * durable record of which account previously claimed each id. An id already
 * owned by a DIFFERENT account than `currentOwnerUserId` is excluded even
 * though the CURRENT account's server registry has never seen it — that is
 * exactly the case this guards against (an A-owned id must never be
 * proposed as though it were B's unowned legacy profile just because it
 * still sits in this browser's local list). An id with no entry in
 * `profileOwners` at all (the common case for a genuine pre-SH.4 legacy
 * profile) is treated as unowned and remains adoptable.
 *
 * Pure — takes every input as a parameter, including the ownership map, so
 * it stays directly DEV-testable without a browser/localStorage.
 *
 * Run from Node:
 *   import { DEV_COMPUTE_PROFILES_TO_ADOPT_CASES, computeProfilesToAdopt } from "@/lib/profileRegistrySync";
 *   DEV_COMPUTE_PROFILES_TO_ADOPT_CASES.forEach(c => {
 *     const got = computeProfilesToAdopt(c.serverProfiles, c.localProfiles, c.currentOwnerUserId, c.profileOwners);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function computeProfilesToAdopt(
  serverProfiles: ServerProfileRecord[],
  localProfiles: Profile[],
  currentOwnerUserId: string,
  profileOwners: Record<string, string>
): Profile[] {
  const known = new Set(serverProfiles.map((p) => p.profileId));
  return localProfiles.filter((p) => {
    if (known.has(p.id)) return false;
    const owner = profileOwners[p.id];
    return owner === undefined || owner === currentOwnerUserId;
  });
}

export const DEV_COMPUTE_PROFILES_TO_ADOPT_CASES: Array<{
  name: string;
  serverProfiles: ServerProfileRecord[];
  localProfiles: Profile[];
  currentOwnerUserId: string;
  profileOwners: Record<string, string>;
  expected: Profile[];
}> = [
  {
    name: "empty server + existing local custom profiles, none owned — additive adoption of everything",
    serverProfiles: [],
    localProfiles: [
      { id: "default", name: "Default" },
      { id: "mom", name: "Mom" },
    ],
    currentOwnerUserId: "userA",
    profileOwners: {},
    expected: [
      { id: "default", name: "Default" },
      { id: "mom", name: "Mom" },
    ],
  },
  {
    name: "grandfathered custom id preserved exactly in the push list — no id/name rewriting",
    serverProfiles: [],
    localProfiles: [{ id: "lindsay-2", name: "Lindsay" }],
    currentOwnerUserId: "userA",
    profileOwners: {},
    expected: [{ id: "lindsay-2", name: "Lindsay" }],
  },
  {
    name: "same id already server-known (active) — local stale name never re-pushed/overwritten",
    serverProfiles: [
      { profileId: "mom", name: "Mom", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    localProfiles: [{ id: "mom", name: "Mommy (stale local copy)" }],
    currentOwnerUserId: "userA",
    profileOwners: { mom: "userA" },
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
    currentOwnerUserId: "userA",
    profileOwners: { mom: "userA" },
    expected: [],
  },
  {
    name: "mixed — only the genuinely unknown, unowned local id is proposed for adoption",
    serverProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    localProfiles: [
      { id: "default", name: "Default" },
      { id: "lindsay", name: "Lindsay" },
    ],
    currentOwnerUserId: "userA",
    profileOwners: { default: "userA" },
    expected: [{ id: "lindsay", name: "Lindsay" }],
  },
  {
    name: "Codex P1 #2 — A-owned local profile is never adopted into B's registry, even though B's own registry has never seen it",
    serverProfiles: [],
    localProfiles: [{ id: "family", name: "Family" }],
    currentOwnerUserId: "userB",
    profileOwners: { family: "userA" },
    expected: [],
  },
  {
    name: "genuinely unowned legacy profile remains adoptable even when OTHER local profiles are already owned by someone else",
    serverProfiles: [],
    localProfiles: [
      { id: "family", name: "Family" },
      { id: "legacy-trip", name: "Legacy Trip" },
    ],
    currentOwnerUserId: "userB",
    profileOwners: { family: "userA" },
    expected: [{ id: "legacy-trip", name: "Legacy Trip" }],
  },
  {
    name: "a profile already owned by the CURRENT account remains adoptable (e.g. retrying a push the server never actually received)",
    serverProfiles: [],
    localProfiles: [{ id: "mom", name: "Mom" }],
    currentOwnerUserId: "userA",
    profileOwners: { mom: "userA" },
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
 * Pushes the adopt-list and returns the ids the server actually confirms as
 * newly registered (its `registered` response field) — never assumed;
 * `[]` on any failure (network error, non-2xx, or malformed body), which the
 * caller correctly treats as "nothing to durably attribute to this account
 * yet" rather than guessing.
 */
async function pushProfilesToAdopt(toAdopt: Profile[]): Promise<string[]> {
  if (toAdopt.length === 0) return [];
  try {
    const res = await fetch("/api/sync/profiles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profiles: toAdopt.map((p) => ({ profileId: p.id, name: p.name })),
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { registered?: unknown } | null;
    if (!data || !Array.isArray(data.registered)) return [];
    return data.registered.filter((id): id is string => typeof id === "string");
  } catch {
    // Best-effort — a failed push just means these ids stay unowned/local-only
    // until the next reconciliation round picks them up again.
    return [];
  }
}

/**
 * Runs one round of registry reconciliation for `userId`, the authenticated
 * identity the caller has ALREADY bound via setRegistryIdentity(userId)
 * (called synchronously, immediately before this) — refuses to run at all
 * if that binding doesn't hold, and re-checks it after every await before
 * issuing the next request or writing anything locally (see
 * isRegistryRunCurrent's own doc): if the identity has moved on in the
 * meantime, this round stops immediately, performing no further request and
 * no local mutation. Silently no-ops on any auth/network failure — never
 * throws, never blocks page rendering, and never touches planner content or
 * `dwp.activeProfile`.
 */
export async function reconcileProfileRegistry(userId: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (registryIdentityState.currentUserId !== userId) return;
  const capturedEpoch = registryIdentityState.epoch;
  const isCurrent = () => isRegistryRunCurrent(registryIdentityState, userId, capturedEpoch);

  const serverProfiles = await fetchServerProfiles();
  if (!isCurrent() || serverProfiles === null) return;

  const localProfiles = getProfiles();
  const profileOwners = getProfileOwners();
  const toAdopt = computeProfilesToAdopt(serverProfiles, localProfiles, userId, profileOwners);

  const registeredIds = await pushProfilesToAdopt(toAdopt);
  if (!isCurrent()) return;

  // Every id the server just confirmed as this account's — whether it was
  // already there (GET) or just registered (this round's PUT) — is durably
  // stamped as owned by `userId` so a later round under a DIFFERENT account
  // correctly refuses to re-adopt it (Codex P1 finding #2).
  for (const id of [...serverProfiles.map((p) => p.profileId), ...registeredIds]) {
    markProfileOwner(id, userId);
  }

  const locallyDeletedIds = getLocallyDeletedProfileIds();
  adoptServerProfiles(selectActiveServerProfiles(serverProfiles, locallyDeletedIds));
}

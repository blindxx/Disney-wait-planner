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
 *   - Local profiles unknown to the CURRENT account's server registry, and
 *     not durably owned by a DIFFERENT account on this device
 *     (computeProfilesToAdopt's `ownedByOtherAccountIds` parameter —
 *     profileStorage.ts's getProfileIdsOwnedByOtherAccounts), are pushed up
 *     (registered). Codex P1 follow-up (6th round) — the 3rd round removed
 *     this cross-account check, reasoning that a fresh, authoritative GET
 *     already tells the current account everything it needs to know about
 *     its OWN registrations; that reasoning covers "is this already mine"
 *     but not "is this SOMEONE ELSE's" — without it, account A's local
 *     ownership stamp for "family" on a shared browser did nothing to stop
 *     account B, signing in later with an empty registry, from adopting
 *     that same local id as B's own. Restoring the check is NOT a return to
 *     the old single-owner-per-id model (profileStorage.ts's module doc):
 *     provenance stays keyed per `(profileId, accountKey)`, and an id two
 *     accounts each independently, authoritatively own (via their own past
 *     successful reconciliations) simply carries both entries side by side
 *     — this only ever asks "besides me, does someone else already own it",
 *     never rejecting or overwriting either account's own fact. A
 *     genuinely unowned id (the common case for a pre-SH.4 legacy profile)
 *     remains freely adoptable by whichever account reconciles it first.
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
 *   - The (already-filtered, already-validated) adopt-list is split into
 *     batches of at most syncIdentity.ts's MAX_PROFILES_PER_ADOPTION_REQUEST
 *     (batchProfilesForAdoption — Codex P2 follow-up, 4th round) before
 *     sending, since the server rejects an oversized `profiles` array
 *     outright: without this, a device with more than that many profiles to
 *     adopt at once would have its ENTIRE request fail, repeatedly,
 *     registering nothing every round. sendAdoptionBatches re-checks the
 *     identity guard before and after every individual batch.
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
 *   - SH.5 — renaming an id already known to the server IS now propagated,
 *     in both directions, as an addition alongside (not a replacement for)
 *     SH.4.1's original additive adoption: a device's OWN pending local
 *     rename (profileStorage.ts's getPendingProfileRenames) is pushed
 *     (computeProfilesToRename) and retried every round until a
 *     reconfirmed re-GET matches; a mismatch with NO pending marker (this
 *     device never touched it — a DIFFERENT device renamed it) is pulled
 *     instead (selectServerRenamesToApply), updating the local name to
 *     match the server's. This is the ONLY case where an id already
 *     present both locally and on the server has its LOCAL name touched by
 *     reconciliation; discovery of a brand-new id (below) still never
 *     rewrites an EXISTING local entry's name.
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
 * SH.4.4 Codex P1 fix — this binding's PRIMARY owner is now the GLOBAL
 * authenticated lifecycle guard in SessionProviderWrapper.tsx (mounted once,
 * at the app root, above every page — the same shared boundary
 * ActiveProfileAuthGuard already uses there for active-profile correction),
 * not settings/page.tsx. Before this fix, ONLY settings/page.tsx ever called
 * setRegistryIdentity/reconcileProfileRegistry, so a legacy local profile
 * belonging to an account that never happened to visit Settings sat
 * unreconciled — and therefore never durably ownership-stamped — for the
 * entire session, remaining freely adoptable by a DIFFERENT account that
 * signed in on the same device and reconciled first (e.g. by visiting
 * Settings itself). Binding identity from the app-root guard means every
 * authenticated session resolution — not just a Settings visit — attempts a
 * reconciliation round, so a legacy profile in active local use is claimed
 * for its account well before any other account gets a chance to.
 *
 * Because the root-level guard is mounted for the lifetime of the whole
 * app/session (it never unmounts on ordinary page navigation, unlike
 * settings/page.tsx), it does NOT need an unmount-time
 * setRegistryIdentity(null) of its own: advanceRegistryIdentity already
 * bumps the epoch on every actual identity transition (including through
 * null on sign-out), which is the only event that can legitimately
 * invalidate an in-flight round — see advanceRegistryIdentity's own doc.
 * settings/page.tsx still calls reconcileProfileRegistry() itself (for a
 * prompt UI refresh while the page is open), but — Codex P1 fix — it must
 * NOT also call setRegistryIdentity() any more: since it no longer owns the
 * binding, its own unmount must not reset identity to null out from under
 * a still-authenticated, still-in-flight ROOT-level round. See
 * SessionProviderWrapper.tsx's own doc for where the binding now lives, and
 * shouldAttemptRegistryReconciliation() below for the shared, pure gating
 * decision both callers rely on.
 */

import {
  type Profile,
  type PendingRenames,
  getProfiles,
  filterVisibleProfiles,
  adoptServerProfiles,
  markProfileOwner,
  getLocallyDeletedProfileIds,
  getProfileIdsOwnedByOtherAccounts,
  getPendingProfileRenames,
  clearProfileRenamePending,
  applyServerRenames,
} from "./profileStorage";
import { validateProfileName, MAX_PROFILES_PER_ADOPTION_REQUEST } from "./syncIdentity";

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
 * ACCOUNT, this device's current local profile list, and the ids durably
 * owned by a DIFFERENT account (profileStorage.ts's
 * getProfileIdsOwnedByOtherAccounts), compute the local profiles that
 * should be PUSHED to the current account's server registry.
 *
 * A local id is excluded when EITHER:
 *   - it is already known to the CURRENT account's own server registry
 *     (`known`, from `serverProfiles`) — regardless of tombstone state: a
 *     tombstoned id is already "known" and must never be re-adopted/
 *     resurrected via this path; only an explicit, deliberate un-delete
 *     (not implemented in SH.4.1) may ever clear a tombstone. A local id
 *     whose name differs from what the server already has under the same
 *     id is likewise excluded — this function only ever proposes ids the
 *     CURRENT account's server has NEVER seen, never a "correction" to one
 *     it has; OR
 *   - it is durably owned by a DIFFERENT account (`ownedByOtherAccountIds`)
 *     — Codex P1 follow-up (6th round), restoring a check the 3rd round
 *     removed. See this module's own header doc and
 *     profileStorage.ts's selectProfileIdsOwnedByOtherAccounts for the full
 *     rationale: a fresh GET only ever proves "is this mine", never "is
 *     this someone else's", so it cannot by itself prevent account B from
 *     adopting a local id account A has already durably claimed on this
 *     same device.
 *
 * A genuinely unowned id (absent from BOTH `known` and
 * `ownedByOtherAccountIds`) remains freely adoptable — this is what keeps
 * every pre-SH.4 legacy profile adoptable by whichever account reconciles
 * it first, and what lets an id already owned by the CURRENT account
 * (which would normally already be in `known` too) proceed without being
 * second-guessed by its own ownership record.
 *
 * Codex P1 follow-up (9th round) — the canonical shared `default` id can
 * never appear in `ownedByOtherAccountIds` in the first place
 * (profileStorage.ts's CANONICAL_SHARED_PROFILE_ID exemption in
 * selectProfileIdsOwnedByOtherAccounts/getProfileIdsOwnedByOtherAccounts),
 * so this function needs no `default`-specific branch of its own: a local
 * `default` entry stays adoptable purely because the caller never hands it
 * an ownership exclusion for that id, exactly like a genuinely unowned
 * legacy profile.
 *
 * Pure — takes every input as a parameter, so it stays directly
 * DEV-testable without a browser/localStorage.
 *
 * Run from Node:
 *   import { DEV_COMPUTE_PROFILES_TO_ADOPT_CASES, computeProfilesToAdopt } from "@/lib/profileRegistrySync";
 *   DEV_COMPUTE_PROFILES_TO_ADOPT_CASES.forEach(c => {
 *     const got = computeProfilesToAdopt(c.serverProfiles, c.localProfiles, c.ownedByOtherAccountIds);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function computeProfilesToAdopt(
  serverProfiles: ServerProfileRecord[],
  localProfiles: Profile[],
  ownedByOtherAccountIds: ReadonlySet<string>
): Profile[] {
  const known = new Set(serverProfiles.map((p) => p.profileId));
  return localProfiles.filter((p) => !known.has(p.id) && !ownedByOtherAccountIds.has(p.id));
}

export const DEV_COMPUTE_PROFILES_TO_ADOPT_CASES: Array<{
  name: string;
  serverProfiles: ServerProfileRecord[];
  localProfiles: Profile[];
  ownedByOtherAccountIds: Set<string>;
  expected: Profile[];
}> = [
  {
    name: "empty server + existing local custom profiles, none owned by anyone else — additive adoption of everything",
    serverProfiles: [],
    localProfiles: [
      { id: "default", name: "Default" },
      { id: "mom", name: "Mom" },
    ],
    ownedByOtherAccountIds: new Set(),
    expected: [
      { id: "default", name: "Default" },
      { id: "mom", name: "Mom" },
    ],
  },
  {
    name: "grandfathered custom id preserved exactly in the push list — no id/name rewriting",
    serverProfiles: [],
    localProfiles: [{ id: "lindsay-2", name: "Lindsay" }],
    ownedByOtherAccountIds: new Set(),
    expected: [{ id: "lindsay-2", name: "Lindsay" }],
  },
  {
    name: "same id already server-known (active) — local stale name never re-pushed/overwritten",
    serverProfiles: [
      { profileId: "mom", name: "Mom", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    localProfiles: [{ id: "mom", name: "Mommy (stale local copy)" }],
    ownedByOtherAccountIds: new Set(),
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
    ownedByOtherAccountIds: new Set(),
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
    ownedByOtherAccountIds: new Set(),
    expected: [{ id: "lindsay", name: "Lindsay" }],
  },
  {
    name: "genuinely unowned legacy profile remains adoptable by its first account",
    serverProfiles: [],
    localProfiles: [{ id: "legacy-trip", name: "Legacy Trip" }],
    ownedByOtherAccountIds: new Set(),
    expected: [{ id: "legacy-trip", name: "Legacy Trip" }],
  },
  {
    name: "Codex P1 follow-up (6th round) — an A-owned local profile is NOT adopted into B merely because B's own server registry lacks that id",
    serverProfiles: [], // B's own GET — B's account has never registered "family"
    localProfiles: [{ id: "family", name: "Family" }],
    ownedByOtherAccountIds: new Set(["family"]), // durably owned by account A
    expected: [],
  },
  {
    name: "current-account-owned/same-id state remains valid — an id owned by ME (never in ownedByOtherAccountIds) stays adoptable even if not yet reflected in this round's own GET",
    serverProfiles: [],
    localProfiles: [{ id: "family", name: "Family" }],
    ownedByOtherAccountIds: new Set(), // "family" is MY OWN ownership, so it is never in this set — see selectProfileIdsOwnedByOtherAccounts
    expected: [{ id: "family", name: "Family" }],
  },
  {
    name: "two accounts with independently authoritative same-id profiles remain supported — an id already known to MY OWN server registry is excluded via `known`, unaffected by another account's own separate ownership of the identical literal id",
    serverProfiles: [
      { profileId: "family", name: "Family", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ], // this account's OWN server row for "family"
    localProfiles: [{ id: "family", name: "Family" }],
    ownedByOtherAccountIds: new Set(["family"]), // a DIFFERENT account also, independently, owns "family"
    expected: [],
  },
  {
    name: "unowned legacy profile remains adoptable even when a DIFFERENT local id is owned by another account",
    serverProfiles: [],
    localProfiles: [
      { id: "family", name: "Family" },
      { id: "legacy-trip", name: "Legacy Trip" },
    ],
    ownedByOtherAccountIds: new Set(["family"]),
    expected: [{ id: "legacy-trip", name: "Legacy Trip" }],
  },
  {
    name: "Codex P1 follow-up (9th round) — A already owns the canonical 'default' id, but B's own empty registry can still adopt/register B's own 'default': profileStorage.ts's getProfileIdsOwnedByOtherAccounts never includes 'default', so ownedByOtherAccountIds is empty for it here regardless of A's ownership",
    serverProfiles: [], // B's own GET — B's account has never registered anything yet
    localProfiles: [{ id: "default", name: "Default" }],
    ownedByOtherAccountIds: new Set(), // "default" is exempt — see selectProfileIdsOwnedByOtherAccounts
    expected: [{ id: "default", name: "Default" }],
  },
  {
    name: "Codex P1 follow-up (4th round, bounded adjacency) — an id A deleted locally must never be silently re-adopted for A just because B's unrelated discovery re-added it to the shared list; reconcileProfileRegistry pre-filters it out of `localProfiles` via filterVisibleProfiles before this function ever runs, so it is simply absent here, exactly as this case models",
    serverProfiles: [], // A's own account has never registered "family"
    localProfiles: [{ id: "default", name: "Default" }], // "family" already excluded upstream — see reconcileProfileRegistry
    ownedByOtherAccountIds: new Set(),
    expected: [{ id: "default", name: "Default" }],
  },
  {
    name: "SH.4.1a Codex P1 follow-up (exact-HEAD finding #2) — B signs in and reconciles BEFORE A's own reconciliation ever ran: A's createProfile now stamps ownership immediately at creation time (profileStorage.ts's own doc), so B's reconciliation already sees 'family' as owned by another account and excludes it, even though A's server-side registry row may not exist yet either",
    serverProfiles: [], // B's own GET — B's account has never registered "family"
    localProfiles: [{ id: "family", name: "Family" }], // physically present on this shared device from A's own local create
    ownedByOtherAccountIds: new Set(["family"]), // stamped immediately by A's createProfile, not by a completed reconciliation
    expected: [],
  },
];

// ===== SH.5 RENAME PROPAGATION =====

/**
 * Given the server registry, this device's current local profiles, this
 * device's own unconfirmed pending renames (profileStorage.ts's
 * getPendingProfileRenames), and the ids durably owned by a DIFFERENT
 * account, compute the {id, name} pairs that should be PUSHED as rename
 * updates this round — the PUSH-side counterpart to computeProfilesToAdopt,
 * for an id the account's OWN server row ALREADY exists for (an id the
 * server has never seen belongs to computeProfilesToAdopt instead; this
 * function explicitly skips anything not already server-known).
 *
 * An id is proposed for rename ONLY when ALL of:
 *   - it has a pending-rename entry (this device deliberately renamed it,
 *     not merely observed a mismatch — see this module's own header doc for
 *     why directionality matters: an id can equally be mismatched because
 *     ANOTHER device renamed it, which must be PULLED, never overwritten by
 *     a push from a device that never touched it — selectServerRenamesToApply
 *     below owns that pull path);
 *   - the pending entry's name still matches the CURRENT local name (a
 *     newer, un-pushed edit hasn't superseded it — always true in practice
 *     since renameProfile writes both together, but checked defensively);
 *   - the server already has an ACTIVE row for this id (a not-yet-known id
 *     is computeProfilesToAdopt's job, not a rename);
 *   - the server's current name for it differs from the pending name
 *     (nothing to push otherwise — already converged);
 *   - it is not durably owned by a DIFFERENT account (mirrors
 *     computeProfilesToAdopt's own exclusion — this account's push must
 *     never target a row it doesn't own).
 *
 * Pure — takes every input as a parameter.
 *
 * Run from Node:
 *   import { DEV_COMPUTE_PROFILES_TO_RENAME_CASES, computeProfilesToRename } from "@/lib/profileRegistrySync";
 *   DEV_COMPUTE_PROFILES_TO_RENAME_CASES.forEach(c => {
 *     const got = computeProfilesToRename(c.serverProfiles, c.localProfiles, c.pendingRenames, c.ownedByOtherAccountIds);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function computeProfilesToRename(
  serverProfiles: ServerProfileRecord[],
  localProfiles: Profile[],
  pendingRenames: PendingRenames,
  ownedByOtherAccountIds: ReadonlySet<string>
): Profile[] {
  const serverNameById = new Map(serverProfiles.filter((p) => !p.deletedAt).map((p) => [p.profileId, p.name]));
  const localNameById = new Map(localProfiles.map((p) => [p.id, p.name]));
  const out: Profile[] = [];
  for (const [id, pending] of Object.entries(pendingRenames)) {
    if (ownedByOtherAccountIds.has(id)) continue;
    if (localNameById.get(id) !== pending.name) continue; // superseded by a newer local edit
    const serverName = serverNameById.get(id);
    if (serverName === undefined) continue; // not yet server-known — computeProfilesToAdopt's job
    if (serverName === pending.name) continue; // already converged
    out.push({ id, name: pending.name });
  }
  return out;
}

export const DEV_COMPUTE_PROFILES_TO_RENAME_CASES: Array<{
  name: string;
  serverProfiles: ServerProfileRecord[];
  localProfiles: Profile[];
  pendingRenames: PendingRenames;
  ownedByOtherAccountIds: Set<string>;
  expected: Profile[];
}> = [
  {
    name: "a locally-renamed, already-server-known id is pushed",
    serverProfiles: [{ profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Our Family Trip" }],
    pendingRenames: { default: { name: "Our Family Trip", renamedAt: 1 } },
    ownedByOtherAccountIds: new Set(),
    expected: [{ id: "default", name: "Our Family Trip" }],
  },
  {
    name: "no pending rename for a mismatched id — never pushed here (that's a PULL, via selectServerRenamesToApply, not a push)",
    serverProfiles: [{ profileId: "default", name: "Old Name (renamed elsewhere)", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Default" }],
    pendingRenames: {},
    ownedByOtherAccountIds: new Set(),
    expected: [],
  },
  {
    name: "pending rename for an id NOT yet known to the server — skipped (computeProfilesToAdopt's job, avoids a duplicate push)",
    serverProfiles: [],
    localProfiles: [{ id: "mom", name: "Mom" }],
    pendingRenames: { mom: { name: "Mom", renamedAt: 1 } },
    ownedByOtherAccountIds: new Set(),
    expected: [],
  },
  {
    name: "pending rename already matches server's current name — nothing to push, converged",
    serverProfiles: [{ profileId: "default", name: "Our Family Trip", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Our Family Trip" }],
    pendingRenames: { default: { name: "Our Family Trip", renamedAt: 1 } },
    ownedByOtherAccountIds: new Set(),
    expected: [],
  },
  {
    name: "pending rename superseded by an even newer local edit not yet reflected in the marker — not pushed this round (defensive; the newer renameProfile call already wrote a newer marker in practice)",
    serverProfiles: [{ profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Even Newer Name" }],
    pendingRenames: { default: { name: "Our Family Trip", renamedAt: 1 } },
    ownedByOtherAccountIds: new Set(),
    expected: [],
  },
  {
    name: "id durably owned by a DIFFERENT account — never pushed as this account's rename",
    serverProfiles: [],
    localProfiles: [{ id: "family", name: "My Rename" }],
    pendingRenames: { family: { name: "My Rename", renamedAt: 1 } },
    ownedByOtherAccountIds: new Set(["family"]),
    expected: [],
  },
  {
    name: "the canonical 'default' id is never in ownedByOtherAccountIds (see profileStorage.ts's exemption), so its own rename is always pushable for this account",
    serverProfiles: [{ profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Our Family Trip" }],
    pendingRenames: { default: { name: "Our Family Trip", renamedAt: 1 } },
    ownedByOtherAccountIds: new Set(),
    expected: [{ id: "default", name: "Our Family Trip" }],
  },
];

/**
 * Given the (post-push, if any) authoritative server registry, this
 * device's current local profiles, and the ids this device itself has an
 * unconfirmed pending rename for, compute the {id, name} pairs that should
 * be PULLED into the local profile list this round — the PULL-side
 * counterpart to computeProfilesToRename. An id qualifies only when it is
 * already locally known (an id not locally present is discovery's job —
 * selectActiveServerProfiles/commitDiscoveredProfiles — not a rename), its
 * server name differs from the local name, and this device does NOT have
 * its own pending rename in flight for it (own-pending-rename ids are
 * ALWAYS resolved via computeProfilesToRename's push + this round's own
 * reconfirmed re-GET, never by blindly pulling a possibly-stale
 * pre-push server snapshot over a local edit that hasn't been sent yet).
 *
 * Pure — takes every input as a parameter.
 *
 * Run from Node:
 *   import { DEV_SELECT_SERVER_RENAMES_TO_APPLY_CASES, selectServerRenamesToApply } from "@/lib/profileRegistrySync";
 *   DEV_SELECT_SERVER_RENAMES_TO_APPLY_CASES.forEach(c => {
 *     const got = selectServerRenamesToApply(c.serverProfiles, c.localProfiles, c.pendingRenameIds);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function selectServerRenamesToApply(
  serverProfiles: ServerProfileRecord[],
  localProfiles: Profile[],
  pendingRenameIds: ReadonlySet<string>
): Profile[] {
  const localNameById = new Map(localProfiles.map((p) => [p.id, p.name]));
  const out: Profile[] = [];
  for (const sp of serverProfiles) {
    if (sp.deletedAt) continue;
    if (pendingRenameIds.has(sp.profileId)) continue; // this device's own unconfirmed rename wins locally for now
    const localName = localNameById.get(sp.profileId);
    if (localName === undefined) continue; // not locally known — discovery's job, not a rename
    if (localName === sp.name) continue; // already converged
    out.push({ id: sp.profileId, name: sp.name });
  }
  return out;
}

export const DEV_SELECT_SERVER_RENAMES_TO_APPLY_CASES: Array<{
  name: string;
  serverProfiles: ServerProfileRecord[];
  localProfiles: Profile[];
  pendingRenameIds: Set<string>;
  expected: Profile[];
}> = [
  {
    name: "SH.5 — the production repro: `default` was renamed on another device; this device pulls the server's newer name for its own already-bootstrapped `default` entry",
    serverProfiles: [{ profileId: "default", name: "Our Family Trip", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Default" }],
    pendingRenameIds: new Set(),
    expected: [{ id: "default", name: "Our Family Trip" }],
  },
  {
    name: "this device has its OWN unconfirmed pending rename for the same id — never overwritten by a pull; the push path (computeProfilesToRename) owns it instead",
    serverProfiles: [{ profileId: "default", name: "Old Name", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "My New Name" }],
    pendingRenameIds: new Set(["default"]),
    expected: [],
  },
  {
    name: "an id not locally known at all is left to discovery, never proposed here",
    serverProfiles: [{ profileId: "mom", name: "Mom", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Default" }],
    pendingRenameIds: new Set(),
    expected: [],
  },
  {
    name: "a tombstoned server row is never pulled as a rename",
    serverProfiles: [
      { profileId: "mom", name: "Mom (server)", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: "2026-02-01T00:00:00.000Z" },
    ],
    localProfiles: [{ id: "mom", name: "Mom (local)" }],
    pendingRenameIds: new Set(),
    expected: [],
  },
  {
    name: "names already match — nothing to pull",
    serverProfiles: [{ profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Default" }],
    pendingRenameIds: new Set(),
    expected: [],
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
 * Splits `toAdopt` into deterministic, order-preserving batches of at most
 * MAX_PROFILES_PER_ADOPTION_REQUEST entries (Codex P2 follow-up, 4th
 * round). `/api/sync/profiles`'s PUT rejects the WHOLE request (400) when
 * its `profiles` array exceeds that same limit — a device with more than
 * this many profiles to adopt in one round would otherwise have its entire
 * adoption request fail, repeatedly, every future round, registering
 * NOTHING at all rather than the (majority) of profiles that would have
 * fit. Splitting is a pure, mechanical chunking — it does not change WHICH
 * profiles are adoptable (that is computeProfilesToAdopt/
 * filterAdoptableProfiles's job) or impose any smaller cap of its own;
 * every candidate is still sent, just across as many requests as needed.
 *
 * Pure — takes every input as a parameter.
 *
 * Run from Node:
 *   import { DEV_BATCH_PROFILES_FOR_ADOPTION_CASES, batchProfilesForAdoption } from "@/lib/profileRegistrySync";
 *   DEV_BATCH_PROFILES_FOR_ADOPTION_CASES.forEach(c => {
 *     const got = batchProfilesForAdoption(c.toAdopt);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function batchProfilesForAdoption(toAdopt: Profile[]): Profile[][] {
  if (toAdopt.length === 0) return [];
  const batches: Profile[][] = [];
  for (let i = 0; i < toAdopt.length; i += MAX_PROFILES_PER_ADOPTION_REQUEST) {
    batches.push(toAdopt.slice(i, i + MAX_PROFILES_PER_ADOPTION_REQUEST));
  }
  return batches;
}

function makeProfile(n: number): Profile {
  return { id: `p${n}`, name: `Profile ${n}` };
}

export const DEV_BATCH_PROFILES_FOR_ADOPTION_CASES: Array<{
  name: string;
  toAdopt: Profile[];
  expected: Profile[][];
}> = [
  {
    name: "empty input — no batches",
    toAdopt: [],
    expected: [],
  },
  {
    name: "fewer than the limit — a single batch",
    toAdopt: [makeProfile(1), makeProfile(2), makeProfile(3)],
    expected: [[makeProfile(1), makeProfile(2), makeProfile(3)]],
  },
  {
    name: "exactly the limit (50) — a single, full batch, not a trailing empty one",
    toAdopt: Array.from({ length: 50 }, (_, i) => makeProfile(i)),
    expected: [Array.from({ length: 50 }, (_, i) => makeProfile(i))],
  },
  {
    name: "Codex P2 follow-up (4th round) — 51 adoptable profiles split into batches of at most 50",
    toAdopt: Array.from({ length: 51 }, (_, i) => makeProfile(i)),
    expected: [Array.from({ length: 50 }, (_, i) => makeProfile(i)), [makeProfile(50)]],
  },
  {
    name: "exactly double the limit (100) — two full batches, order preserved",
    toAdopt: Array.from({ length: 100 }, (_, i) => makeProfile(i)),
    expected: [
      Array.from({ length: 50 }, (_, i) => makeProfile(i)),
      Array.from({ length: 50 }, (_, i) => makeProfile(50 + i)),
    ],
  },
];

/**
 * Sends `batches` in order via `sendBatch`, checking `isCurrent()` BEFORE
 * every batch (never sending a batch once identity has gone stale) and
 * AGAIN immediately after each batch's request resolves (never proceeding
 * to the next batch — or letting the caller proceed to whatever runs after
 * this returns, such as the final authoritative re-GET — once stale).
 * Codex P1/P2 follow-up (4th round) — this is the ONLY looping/async-
 * sequencing logic the adoption path needs, factored out so the exact
 * stale-check-before-and-after-every-batch behavior is directly testable
 * with fake `sendBatch`/`isCurrent` callbacks, without any real network I/O
 * or timing. Returns true only if every batch was sent while still
 * current; false the moment staleness is detected, at which point no
 * further batches are sent — reconcileProfileRegistry re-checks
 * `isCurrent()` itself immediately after calling this, so it never needs to
 * branch on this return value to stay safe, but the value makes the
 * short-circuit directly observable for testing.
 *
 * Run from Node (needs a `for...of` + `await`, unlike this file's other
 * synchronous DEV_* runners, since this function is itself async):
 *   import { DEV_SEND_ADOPTION_BATCHES_CASES, sendAdoptionBatches } from "@/lib/profileRegistrySync";
 *   for (const c of DEV_SEND_ADOPTION_BATCHES_CASES) {
 *     const sent = [];
 *     let sentCount = 0;
 *     const isCurrent = () => c.staleAtBatchIndex === null || sentCount < c.staleAtBatchIndex;
 *     const result = await sendAdoptionBatches(c.batches, async (b) => { sent.push(b); sentCount++; }, isCurrent);
 *     const ok = result === c.expectedReturn && JSON.stringify(sent) === JSON.stringify(c.expectedBatchesSent);
 *     console.log(ok ? "✓" : "✗ FAIL", c.name);
 *   }
 */
export async function sendAdoptionBatches(
  batches: Profile[][],
  sendBatch: (batch: Profile[]) => Promise<void>,
  isCurrent: () => boolean
): Promise<boolean> {
  for (const batch of batches) {
    if (!isCurrent()) return false;
    await sendBatch(batch);
    if (!isCurrent()) return false;
  }
  return true;
}

export const DEV_SEND_ADOPTION_BATCHES_CASES: Array<{
  name: string;
  batches: Profile[][];
  staleAtBatchIndex: number | null;
  expectedBatchesSent: Profile[][];
  expectedReturn: boolean;
}> = [
  {
    name: "all batches sent while identity remains current",
    batches: [[makeProfile(1)], [makeProfile(2)]],
    staleAtBatchIndex: null,
    expectedBatchesSent: [[makeProfile(1)], [makeProfile(2)]],
    expectedReturn: true,
  },
  {
    name: "Codex P1/P2 follow-up (4th round) — identity goes stale between batches — a later batch is never sent",
    batches: [[makeProfile(1)], [makeProfile(2)], [makeProfile(3)]],
    staleAtBatchIndex: 1,
    expectedBatchesSent: [[makeProfile(1)]],
    expectedReturn: false,
  },
  {
    name: "already stale before the first batch — nothing is sent, no mutation attempted",
    batches: [[makeProfile(1)]],
    staleAtBatchIndex: 0,
    expectedBatchesSent: [],
    expectedReturn: false,
  },
  {
    name: "no batches to send — trivially returns true without calling sendBatch",
    batches: [],
    staleAtBatchIndex: null,
    expectedBatchesSent: [],
    expectedReturn: true,
  },
];

/**
 * Stamps ownership for each id in `profileIds`, checking `isCurrent()`
 * BEFORE every stamp (never attempting one once identity has gone stale)
 * and AGAIN immediately after each stamp's own write resolves — mirrors
 * sendAdoptionBatches's own stale-check-before-and-after pattern exactly,
 * one level down.
 *
 * Codex P1 follow-up (12th round) — this loop's own body was previously
 * fully synchronous (a plain `for` calling markProfileOwner directly, no
 * `await` at all), so there was no gap for identity to go stale mid-loop.
 * profileStorage.ts's markProfileOwner is now an async, lock-acquiring
 * write (Codex P1 finding #2's fix — see its own doc), which introduces a
 * genuine await boundary per id: identity CAN advance while a call is
 * queued waiting for the registry-state lock (another tab's own
 * reconciliation activity, or this same tab's own concurrent registry
 * work, currently holding it). Factoring the loop out here, exactly like
 * sendAdoptionBatches, makes the stale-check-before-and-after behavior
 * directly testable with a fake `stampOwner`/`isCurrent`, without any real
 * storage or Web Locks I/O. Returns true only if every id was stamped
 * while still current; false the moment staleness is detected, at which
 * point no further ids are stamped — reconcileProfileRegistry re-checks
 * `isCurrent()` itself immediately after calling this, exactly like it
 * already does after sendAdoptionBatches.
 *
 * Run from Node (needs a `for...of` + `await`, like sendAdoptionBatches's
 * own runner):
 *   import { DEV_STAMP_OWNERSHIP_FOR_IDS_CASES, stampOwnershipForIds } from "@/lib/profileRegistrySync";
 *   for (const c of DEV_STAMP_OWNERSHIP_FOR_IDS_CASES) {
 *     const stamped = [];
 *     let stampedCount = 0;
 *     const isCurrent = () => c.staleAtIndex === null || stampedCount < c.staleAtIndex;
 *     const result = await stampOwnershipForIds(c.profileIds, "userA", isCurrent, async (id) => { stamped.push(id); stampedCount++; });
 *     const ok = result === c.expectedReturn && JSON.stringify(stamped) === JSON.stringify(c.expectedStampedIds);
 *     console.log(ok ? "✓" : "✗ FAIL", c.name);
 *   }
 */
export async function stampOwnershipForIds(
  profileIds: string[],
  ownerUserId: string,
  isCurrent: () => boolean,
  stampOwner: (id: string, ownerUserId: string) => Promise<void>
): Promise<boolean> {
  for (const id of profileIds) {
    if (!isCurrent()) return false;
    await stampOwner(id, ownerUserId);
    if (!isCurrent()) return false;
  }
  return true;
}

export const DEV_STAMP_OWNERSHIP_FOR_IDS_CASES: Array<{
  name: string;
  profileIds: string[];
  staleAtIndex: number | null;
  expectedStampedIds: string[];
  expectedReturn: boolean;
}> = [
  {
    name: "all ids stamped while identity remains current",
    profileIds: ["family", "mom"],
    staleAtIndex: null,
    expectedStampedIds: ["family", "mom"],
    expectedReturn: true,
  },
  {
    name: "Codex P1 follow-up (12th round) — identity goes stale between stamps (e.g. while awaiting the registry-state lock) — a later id is never stamped",
    profileIds: ["family", "mom", "trip2026"],
    staleAtIndex: 1,
    expectedStampedIds: ["family"],
    expectedReturn: false,
  },
  {
    name: "already stale before the first id — nothing is stamped",
    profileIds: ["family"],
    staleAtIndex: 0,
    expectedStampedIds: [],
    expectedReturn: false,
  },
  {
    name: "no ids to stamp — trivially returns true without calling stampOwner",
    profileIds: [],
    staleAtIndex: null,
    expectedStampedIds: [],
    expectedReturn: true,
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

/**
 * SH.4.4 Codex P1 fix — shared, pure gating decision for whether a resolved
 * authenticated-session lifecycle event should (re)bind registry identity
 * (setRegistryIdentity) and, when authenticated, attempt a reconciliation
 * round (reconcileProfileRegistry). Factored out so the SAME decision drives
 * both the GLOBAL root-level guard (SessionProviderWrapper.tsx — the
 * primary owner as of this fix) and settings/page.tsx's own page-local
 * trigger, without duplicating the branching logic in two places that could
 * drift apart.
 *
 * "loading" is a genuinely UNRESOLVED identity state — never treated as
 * equivalent to "unauthenticated" (mirrors every other
 * `sessionStatus === "loading"` guard already established in this codebase;
 * see settings/page.tsx's own 11th-round fix and
 * SessionProviderWrapper.tsx's own doc for the identical distinction).
 * `authenticatedUserId === null` while `sessionStatus === "authenticated"`
 * is defensive — next-auth should never resolve "authenticated" without a
 * usable session, but there is nothing to bind identity to in that case, so
 * this also declines.
 *
 * Pure — takes both values as parameters.
 *
 * Run from Node:
 *   import { DEV_SHOULD_ATTEMPT_REGISTRY_RECONCILIATION_CASES, shouldAttemptRegistryReconciliation } from "@/lib/profileRegistrySync";
 *   DEV_SHOULD_ATTEMPT_REGISTRY_RECONCILIATION_CASES.forEach(c => {
 *     const got = shouldAttemptRegistryReconciliation(c.sessionStatus, c.authenticatedUserId);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export type SessionLifecycleStatus = "loading" | "authenticated" | "unauthenticated";

export function shouldAttemptRegistryReconciliation(
  sessionStatus: SessionLifecycleStatus,
  authenticatedUserId: string | null
): boolean {
  return sessionStatus !== "loading" && authenticatedUserId !== null;
}

export const DEV_SHOULD_ATTEMPT_REGISTRY_RECONCILIATION_CASES: Array<{
  name: string;
  sessionStatus: SessionLifecycleStatus;
  authenticatedUserId: string | null;
  expected: boolean;
}> = [
  {
    name: "unresolved session — never attempted, identity not yet known",
    sessionStatus: "loading",
    authenticatedUserId: null,
    expected: false,
  },
  {
    name: "resolved signed-out — never attempted, no account to reconcile against",
    sessionStatus: "unauthenticated",
    authenticatedUserId: null,
    expected: false,
  },
  {
    name: "SH.4.4 Codex P1 — resolved authenticated with a resolved user id — attempted regardless of which page/component is mounted (this is what lets a legacy profile reconcile without ever visiting Settings)",
    sessionStatus: "authenticated",
    authenticatedUserId: "userA",
    expected: true,
  },
  {
    name: "defensive — authenticated status but no resolvable user id — never attempted (nothing to bind identity to)",
    sessionStatus: "authenticated",
    authenticatedUserId: null,
    expected: false,
  },
];

/**
 * PR #161 Codex fix — shared, pure gating decision for whether
 * settings/page.tsx's own profile-management UI/actions (the Profiles
 * section — Add/Rename/Delete/Switch, gated on `profiles.length > 0`) must
 * be withheld right now. True ONLY while the authenticated session is
 * genuinely UNRESOLVED ("loading").
 *
 * Before this fix, settings/page.tsx's auth-transition effect treated
 * `sessionStatus === "loading"` as a pure no-op — correct for the INITIAL
 * mount window (where `profiles` starts empty and the section simply never
 * renders yet), but wrong for a LATER transition back into "loading" mid-
 * session (e.g. an account switch/session refetch): `profiles` would still
 * hold whatever the PREVIOUS resolved identity left there, and the section
 * would keep rendering it — fully actionable (Add/Rename/Delete/Switch) —
 * against a profile list/active id that no CURRENT session vouches for.
 * settings/page.tsx now clears its own `profiles` state (reusing the exact
 * same `profiles.length > 0` render gate, rather than introducing a
 * parallel one) whenever this returns true — see its own effect for where
 * this is called.
 *
 * A resolved "authenticated" or "unauthenticated" status never withholds on
 * this basis alone — each already has its own separate, legitimate reason
 * to show or hide the section; this predicate only ever answers the LOADING
 * question.
 *
 * Pure — takes the single value as a parameter.
 *
 * Run from Node:
 *   import { DEV_SHOULD_WITHHOLD_PROFILE_CONTROLS_CASES, shouldWithholdProfileControls } from "@/lib/profileRegistrySync";
 *   DEV_SHOULD_WITHHOLD_PROFILE_CONTROLS_CASES.forEach(c => {
 *     const got = shouldWithholdProfileControls(c.sessionStatus);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function shouldWithholdProfileControls(sessionStatus: SessionLifecycleStatus): boolean {
  return sessionStatus === "loading";
}

export const DEV_SHOULD_WITHHOLD_PROFILE_CONTROLS_CASES: Array<{
  name: string;
  sessionStatus: SessionLifecycleStatus;
  expected: boolean;
}> = [
  {
    name: "PR #161 Codex fix — unresolved session (initial mount OR a later mid-session transition back into loading) — withheld",
    sessionStatus: "loading",
    expected: true,
  },
  {
    name: "resolved authenticated — not withheld on this basis (the account's own effective list is safe to show)",
    sessionStatus: "authenticated",
    expected: false,
  },
  {
    name: "resolved signed-out — not withheld on this basis (the local-first/UNOWNED list is safe to show)",
    sessionStatus: "unauthenticated",
    expected: false,
  },
];

/**
 * PR #161 Codex fix — shared, pure gating decision for whether the GLOBAL
 * legacy planner-data adoption guard (SessionProviderWrapper.tsx's
 * LegacyPlannerAdoptionGuard) should run
 * profileStorage.ts's adoptLegacyProfileValueIfSafe() for the active
 * profile's SH.4-migrated planner domains right now.
 *
 * Before this fix, safe legacy-to-qualified planner-data adoption (driven
 * by profileStorage.ts's existing decideLegacyKeyAdoption() fail-closed/
 * idempotent rules) only ever ran from Plans'/Lightning's own auth-
 * transition effects (retargetPlansStorageIdentity()/
 * retargetLightningStorageIdentity() in plans/page.tsx/lightning/page.tsx).
 * A user who signed in and went straight to Tom without ever visiting
 * Plans or Lightning first therefore had their qualified planner keys stay
 * empty: plannerContextSnapshot.ts is explicitly read-only and never
 * adopts on its own (see its own module doc), so Tom's planner_context
 * silently omitted legitimate legacy data that was simply never copied
 * over yet.
 *
 * Identical shape to shouldAttemptRegistryReconciliation() above (a
 * resolved, authenticated identity) — kept as its own separate, distinctly
 * named predicate rather than reused directly, since it gates a
 * differently scoped concern: local, synchronous legacy-data adoption,
 * never a network round or the registry identity binding
 * shouldAttemptRegistryReconciliation() itself governs.
 *
 * Pure — takes both values as parameters.
 *
 * Run from Node:
 *   import { DEV_SHOULD_ADOPT_LEGACY_PLANNER_DATA_CASES, shouldAdoptLegacyPlannerData } from "@/lib/profileRegistrySync";
 *   DEV_SHOULD_ADOPT_LEGACY_PLANNER_DATA_CASES.forEach(c => {
 *     const got = shouldAdoptLegacyPlannerData(c.sessionStatus, c.authenticatedUserId);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function shouldAdoptLegacyPlannerData(
  sessionStatus: SessionLifecycleStatus,
  authenticatedUserId: string | null
): boolean {
  return sessionStatus !== "loading" && authenticatedUserId !== null;
}

export const DEV_SHOULD_ADOPT_LEGACY_PLANNER_DATA_CASES: Array<{
  name: string;
  sessionStatus: SessionLifecycleStatus;
  authenticatedUserId: string | null;
  expected: boolean;
}> = [
  {
    name: "unresolved session — never adopts; identity not yet known, would risk adopting into the wrong (or no) account's qualified keys",
    sessionStatus: "loading",
    authenticatedUserId: null,
    expected: false,
  },
  {
    name: "resolved signed-out — never adopts; there is no qualified key to adopt into",
    sessionStatus: "unauthenticated",
    authenticatedUserId: null,
    expected: false,
  },
  {
    name: "PR #161 Codex fix — resolved authenticated with a resolved user id — adopts regardless of which page/component is mounted, so Tom (or any other qualified reader) sees adopted legacy data even when the user never visits Plans or Lightning first",
    sessionStatus: "authenticated",
    authenticatedUserId: "userA",
    expected: true,
  },
  {
    name: "defensive — authenticated status but no resolvable user id — never adopts (nothing to adopt into)",
    sessionStatus: "authenticated",
    authenticatedUserId: null,
    expected: false,
  },
];

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
  {
    name: "Codex P2 follow-up (4th round) — 51 profiles adopted across two batches are ALL reflected once the single final re-GET runs (batching never changes this decision — it's still one authoritative snapshot after every batch has been attempted)",
    initialServerProfiles: [],
    pushAttempted: true,
    reconfirmedServerProfiles: Array.from({ length: 51 }, (_, i) => ({
      profileId: `p${i}`,
      name: `Profile ${i}`,
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    })),
    expected: Array.from({ length: 51 }, (_, i) => ({
      profileId: `p${i}`,
      name: `Profile ${i}`,
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    })),
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
 * Fire-and-forget push of a batch of {id, name} pairs — SH.5: carries BOTH
 * brand-new adoptions (computeProfilesToAdopt) and rename updates for
 * already-known ids (computeProfilesToRename); the server's own UPSERT
 * (see /api/sync/profiles's route doc) decides which case each entry is,
 * so this function needs no branching of its own. Codex P1 follow-up (2nd
 * round) — its outcome (success, non-2xx, a lost/malformed response, or a
 * thrown network error) is deliberately NEVER used to decide ownership:
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
 * SH.5 — a single, immediate, best-effort registration push for ONE
 * just-created profile, exported for settings/page.tsx's handleAddProfile
 * to await BEFORE its own location.reload(). createProfile() already
 * stamps LOCAL ownership provenance synchronously at create time (see its
 * own doc in profileStorage.ts), but until this addition, the actual
 * SERVER registration was deferred entirely to the NEXT full
 * reconcileProfileRegistry round — which only runs on the freshly reloaded
 * page, as a fire-and-forget effect with no visibility into whether it
 * ever got a chance to complete before the user navigated away again. This
 * closes that single-point-of-failure window with ONE extra, awaited
 * attempt that runs BEFORE the reload — it does not replace the normal
 * round, which still runs afterward exactly as before and will retry this
 * exact id again if this attempt's own request fails, since
 * computeProfilesToAdopt recomputes "unknown to the server" fresh every
 * round regardless of what any previous attempt did.
 */
export async function pushNewProfileRegistration(profile: Profile): Promise<void> {
  await pushProfilesToAdopt([profile]);
}

/**
 * Performs the FINAL, commit-time merge of a reconciliation round:
 * re-reads this account's CURRENT local-deletion markers via
 * `readLocallyDeletedIds` — never a value captured earlier in the round,
 * before the PUT/GET awaits — and merges `authoritativeServerProfiles`
 * into the local list through `mergeIntoLocal` using that fresh read.
 *
 * Codex P2 follow-up (6th round) — a reconciliation round's PUT/GET awaits
 * can take long enough for another tab (same account, same browser) to
 * explicitly delete a profile in between. Reusing a `locallyDeletedIds`
 * snapshot captured BEFORE those awaits at commit time would silently
 * override that newer, durable local fact — re-adding a profile the user
 * just told this exact browser to forget. Factoring the read out behind
 * `readLocallyDeletedIds` (rather than inlining a `getLocallyDeletedProfileIds`
 * call directly in reconcileProfileRegistry) makes the "read happens HERE,
 * at commit time, never earlier" contract directly testable: a fake
 * `readLocallyDeletedIds` can return different values depending on when
 * it's invoked, proving this function only ever acts on whatever it
 * returns AT THE MOMENT this runs, never a value from outer scope.
 *
 * Codex P1 follow-up (12th round) — `mergeIntoLocal` is now awaited:
 * profileStorage.ts's adoptServerProfiles (the real-world `mergeIntoLocal`
 * every caller passes) became an async, lock-acquiring read-merge-write as
 * part of Codex finding #3's fix (see its own doc) — this function simply
 * propagates that await so its own caller (reconcileProfileRegistry) can
 * correctly sequence whatever runs after it.
 *
 * Run from Node (needs `await`, unlike this file's non-async DEV_*
 * runners, since this function is itself async):
 *   import { DEV_COMMIT_DISCOVERED_PROFILES_CASES, commitDiscoveredProfiles } from "@/lib/profileRegistrySync";
 *   for (const c of DEV_COMMIT_DISCOVERED_PROFILES_CASES) {
 *     let merged = null;
 *     await commitDiscoveredProfiles(c.authoritativeServerProfiles, () => c.locallyDeletedIdsAtCommitTime, (candidates) => { merged = candidates; });
 *     console.log(JSON.stringify(merged) === JSON.stringify(c.expectedMerged) ? "✓" : "✗ FAIL", c.name);
 *   }
 */
export async function commitDiscoveredProfiles(
  authoritativeServerProfiles: ServerProfileRecord[],
  readLocallyDeletedIds: () => ReadonlySet<string>,
  mergeIntoLocal: (candidates: Profile[]) => void | Promise<void | Profile[]>
): Promise<void> {
  const locallyDeletedIds = readLocallyDeletedIds();
  await mergeIntoLocal(selectActiveServerProfiles(authoritativeServerProfiles, locallyDeletedIds));
}

export const DEV_COMMIT_DISCOVERED_PROFILES_CASES: Array<{
  name: string;
  authoritativeServerProfiles: ServerProfileRecord[];
  locallyDeletedIdsAtCommitTime: Set<string>;
  expectedMerged: Profile[];
}> = [
  {
    name: "Codex P2 follow-up (6th round) — a same-account deletion that landed in another tab DURING the round's awaits is honored at commit time, preventing rediscovery/re-add",
    authoritativeServerProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
      { profileId: "family", name: "Family", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    locallyDeletedIdsAtCommitTime: new Set(["family"]),
    expectedMerged: [{ id: "default", name: "Default" }],
  },
  {
    name: "no deletion at commit time — both profiles merged normally",
    authoritativeServerProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
      { profileId: "family", name: "Family", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    locallyDeletedIdsAtCommitTime: new Set(),
    expectedMerged: [
      { id: "default", name: "Default" },
      { id: "family", name: "Family" },
    ],
  },
  {
    name: "Codex P2 follow-up (6th round) — a stale pre-await snapshot (simulated here as an empty set closed over separately) is never consulted; only whatever readLocallyDeletedIds() returns at call time decides the outcome",
    authoritativeServerProfiles: [
      { profileId: "family", name: "Family", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    // The "stale" pre-await state would have been empty (no deletion yet
    // when the round started); this case's readLocallyDeletedIds (see the
    // runner) ignores that and returns the NEWER commit-time set instead.
    locallyDeletedIdsAtCommitTime: new Set(["family"]),
    expectedMerged: [],
  },
];

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
 * Codex P1/P2 follow-up (3rd round) — `filterAdoptableProfiles` drops any
 * individual candidate whose name fails the shared length constraint
 * instead of letting it poison the whole push; and
 * `getLocallyDeletedProfileIds(userId)` only ever suppresses discovery for
 * ids THIS account (or no account) has locally deleted, never a different
 * account's own same-id deletion.
 *
 * Codex P1 follow-up (6th round) — `computeProfilesToAdopt` EXCLUDES a
 * local id durably owned by a DIFFERENT account
 * (getProfileIdsOwnedByOtherAccounts(userId), computed fresh each round) —
 * restored after the 3rd round removed it; see computeProfilesToAdopt's own
 * doc and this module's header doc for why that removal was itself a bug.
 *
 * Codex P2 follow-up (6th round) — the FINAL discovery/local-merge step
 * (commitDiscoveredProfiles) re-reads `getLocallyDeletedProfileIds(userId)`
 * at commit time, immediately before merging — NEVER the snapshot captured
 * earlier in this function, before the PUT/GET awaits below. A same-account
 * deletion made in another tab while those awaits are in flight must win
 * over this now-stale round's view; see commitDiscoveredProfiles's own doc.
 *
 * Codex P2 follow-up (4th round) — the adopt-list is split into batches of
 * at most MAX_PROFILES_PER_ADOPTION_REQUEST (batchProfilesForAdoption)
 * before sending, since the server rejects an oversized `profiles` array
 * outright; sendAdoptionBatches re-checks `isCurrent()` before AND after
 * every individual batch, so identity going stale between batches stops
 * any further batch from being sent — exactly like every other await
 * boundary in this function. Still exactly ONE confirmatory re-GET runs
 * after ALL batches have been attempted (never one per batch): it reflects
 * whatever actually committed across every batch, so a batch whose own
 * response was lost or that never got sent at all (because identity went
 * stale, or a network error) is handled identically to the single-batch
 * case — resolveAuthoritativeServerProfiles decides what's real from that
 * one authoritative snapshot, never from assuming any batch succeeded.
 *
 * Codex P1 follow-up (12th round) — the ownership-stamping loop and the
 * final commit are now each preceded by their own `isCurrent()` check
 * (stampOwnershipForIds's own internal before/after checks, plus an
 * explicit check before commitDiscoveredProfiles), exactly mirroring the
 * pattern already established around sendAdoptionBatches above: both
 * markProfileOwner and adoptServerProfiles became async, lock-acquiring
 * writes as part of this round's local-mutation-serialization fix (Codex
 * findings #2/#3 — see profileStorage.ts's own "LOCAL MUTATION
 * SERIALIZATION" section doc), introducing genuinely new await boundaries
 * that did not exist when this tail of the function was fully synchronous.
 * An identity/profile transition landing in one of those new gaps (this
 * same tab's own Settings sign-out/switch, or another tab's) is caught by
 * the SAME re-check discipline every other await in this function already
 * uses, so it stops before any further stale write — never a stronger,
 * fail-closed guarantee than the rest of this function already provides
 * (one already-in-flight write may still land, exactly like an in-flight
 * network request already could; see sendAdoptionBatches's own doc).
 */
export async function reconcileProfileRegistry(userId: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (registryIdentityState.currentUserId !== userId) return;
  const capturedEpoch = registryIdentityState.epoch;
  const isCurrent = () => isRegistryRunCurrent(registryIdentityState, userId, capturedEpoch);

  const initialServerProfiles = await fetchServerProfiles();
  if (!isCurrent() || initialServerProfiles === null) return;

  // Codex P1 follow-up (4th round, bounded adjacency) — this snapshot feeds
  // BOTH the ADOPTION candidates below and (as a starting point only — see
  // the commit-time re-read further down) the discovery/merge decision.
  // Without filtering adoption candidates too, an id `userId` explicitly
  // deleted locally, but which reappears in the shared `dwp.profiles` list
  // only because a DIFFERENT account's own unrelated discovery re-added it
  // (adoptServerProfiles is account-agnostic — it just merges into the one
  // shared list), would look to computeProfilesToAdopt like a brand-new,
  // never-registered local profile and get silently PUSHED as newly
  // `userId`'s own — resurrecting exactly what this account just deleted.
  const locallyDeletedIds = getLocallyDeletedProfileIds(userId);
  const localProfiles = filterVisibleProfiles(getProfiles(), locallyDeletedIds);
  // Codex P1 follow-up (6th round) — ids durably owned by a DIFFERENT
  // account must never be proposed for this account's adoption, even
  // though this account's own (empty, for a never-before-seen id) GET
  // response alone can't tell the two cases apart — see
  // computeProfilesToAdopt's own doc.
  const ownedByOtherAccountIds = getProfileIdsOwnedByOtherAccounts(userId);
  const toAdopt = filterAdoptableProfiles(
    computeProfilesToAdopt(initialServerProfiles, localProfiles, ownedByOtherAccountIds)
  );
  // SH.5 — rename propagation, push side: an id ALREADY known to the
  // server whose CURRENT local name is this device's own unconfirmed
  // rename (profileStorage.ts's getPendingProfileRenames) gets pushed
  // alongside brand-new adoptions in the SAME batch — the server's UPSERT
  // (see /api/sync/profiles's route doc) inserts an unknown id and updates
  // an already-owned one identically, so both cases share one combined
  // push/re-GET/reconfirm cycle below. See computeProfilesToRename's own
  // doc for why only a PENDING (self-initiated) rename is ever pushed here
  // — a mismatch with no pending marker means a DIFFERENT device renamed
  // it, which is pulled further down (selectServerRenamesToApply), never
  // pushed from here.
  // Codex account-isolation fix — scoped to THIS round's own `userId`:
  // getPendingProfileRenames now returns only ids `userId` itself renamed,
  // never a different account's own pending rename recorded on a shared
  // browser (see profileStorage.ts's PendingRenamesByAccount doc).
  const pendingRenames = getPendingProfileRenames(userId);
  const toRename = filterAdoptableProfiles(
    computeProfilesToRename(initialServerProfiles, localProfiles, pendingRenames, ownedByOtherAccountIds)
  );
  const toPush = [...toAdopt, ...toRename];
  const batches = batchProfilesForAdoption(toPush);

  const pushAttempted = batches.length > 0;
  let reconfirmedServerProfiles: ServerProfileRecord[] | null = null;
  if (pushAttempted) {
    await sendAdoptionBatches(batches, pushProfilesToAdopt, isCurrent);
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
  //
  // Codex P1 follow-up (12th round) — markProfileOwner is now an async,
  // lock-acquiring write (finding #2's fix, serialized against a
  // concurrent local deletion marker on `dwp.profileRegistryState` — see
  // its own doc), a genuine NEW await boundary per id that did not exist
  // when this loop was fully synchronous. stampOwnershipForIds
  // re-checks `isCurrent()` before and after every single stamp — the SAME
  // stale-check-before-and-after discipline sendAdoptionBatches already
  // applies per batch, one level down — so identity going stale while a
  // stamp is queued on the registry-state lock stops any FURTHER stamp
  // from being attempted.
  if (!isCurrent()) return;
  await stampOwnershipForIds(
    authoritativeServerProfiles.map((p) => p.profileId),
    userId,
    isCurrent,
    markProfileOwner
  );
  if (!isCurrent()) return;

  // SH.5 — rename propagation, push confirmation: clear THIS account's
  // (`userId`'s) own pending-rename marker for every id whose PUSHED name
  // is now confirmed by `authoritativeServerProfiles` (the SAME re-GET the
  // ownership stamp above already trusts). An id whose push failed, or
  // whose reconfirmed name still doesn't match, simply keeps its marker —
  // computeProfilesToRename will propose it again on the NEXT round,
  // exactly like an adoption candidate that failed to register keeps
  // getting proposed via computeProfilesToAdopt's own fresh recomputation.
  // Codex account-isolation fix — scoping the clear to `userId` means this
  // round can only ever clear ITS OWN pending rename, never a different
  // account's (see profileStorage.ts's clearPendingRenameForAccount doc).
  if (toRename.length > 0) {
    const authoritativeNameById = new Map(authoritativeServerProfiles.map((p) => [p.profileId, p.name]));
    for (const renamed of toRename) {
      if (authoritativeNameById.get(renamed.id) === renamed.name) {
        await clearProfileRenamePending(renamed.id, renamed.name, userId);
      }
    }
  }
  if (!isCurrent()) return;

  // Codex P2 follow-up (6th round) — deliberately NOT `locallyDeletedIds`
  // (the snapshot captured above, before this round's PUT/GET awaits):
  // commitDiscoveredProfiles re-reads this account's deletion markers
  // fresh, right now, so a same-account deletion made in another tab while
  // those awaits were in flight is what actually decides this merge — see
  // commitDiscoveredProfiles's own doc.
  //
  // Codex P1 follow-up (12th round) — adoptServerProfiles (passed here as
  // `mergeIntoLocal`) is now itself async — finding #3's fix serializes its
  // read-merge-write of `dwp.profiles` against every other local writer
  // (createProfile/renameProfile/deleteProfile) via the SAME kind of lock,
  // so a concurrent local create/rename/delete can never be lost to a
  // stale reconciliation snapshot. commitDiscoveredProfiles's own await of
  // `mergeIntoLocal` propagates that here.
  await commitDiscoveredProfiles(
    authoritativeServerProfiles,
    () => getLocallyDeletedProfileIds(userId),
    adoptServerProfiles
  );

  // SH.5 — rename propagation, pull side: an id THIS device already knows
  // about locally (so not discovery's job above) whose server name differs
  // from the local name, and that this device does NOT itself have an
  // unconfirmed pending rename for (that case is the push path above,
  // never overwritten by a pull), gets its LOCAL name updated to match the
  // server's — this is what lets `default` (always already locally known
  // from boot, on every device, before any network call — see
  // profileStorage.ts's getProfiles/DEFAULT_PROFILE) actually pick up a
  // custom name pushed from a DIFFERENT device, closing the gap
  // mergeProfilesAdditive's own deliberate "never renames an existing
  // entry" behavior leaves for genuine cross-device renames.
  //
  // `pendingRenameIds` is read fresh here, right before use — mirrors
  // `commitDiscoveredProfiles`'s own "re-read at commit time" discipline —
  // so a rename this device made WHILE the round's earlier awaits were in
  // flight is honored rather than clobbered by a pull built from a stale
  // pre-round snapshot.
  if (!isCurrent()) return;
  // Codex account-isolation fix — scoped to `userId`: a pull must only ever
  // be suppressed by THIS account's own pending rename, never a different
  // account's (which this account's reconciliation can no longer even see —
  // see getPendingProfileRenames's own doc).
  const pendingRenameIdsAtCommit = new Set(Object.keys(getPendingProfileRenames(userId)));
  const renamesToApply = selectServerRenamesToApply(authoritativeServerProfiles, getProfiles(), pendingRenameIdsAtCommit);
  await applyServerRenames(renamesToApply);
}

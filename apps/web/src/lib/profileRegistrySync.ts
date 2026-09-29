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
 * null on sign-out), which is the only event that can invalidate an
 * in-flight round via the IDENTITY epoch — see advanceRegistryIdentity's
 * own doc. (Codex finding #2 — a SEPARATE, round-sequencing guard also
 * invalidates an in-flight round when a NEWER round for the SAME identity
 * has started since, independent of any identity transition — see the
 * "RECONCILIATION-ROUND STALE-RUN GUARD" section further below for why
 * that gap existed and how it's closed; it does not change anything about
 * this guard's own identity-transition responsibility described here.)
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
  applyPendingRename,
  selectPendingRenamesForAccount,
  clearPendingRenameForAccount,
  discardPendingRenameForAccount,
  mergeProfileRenames,
  markProfileRenamePending,
  markProfileRenameBackfilled,
  getRenameBackfilledIds,
  CANONICAL_SHARED_PROFILE_ID,
  DEFAULT_PROFILE_NAME,
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
 * Codex finding — ONE-TIME PRE-LEDGER RENAME BACKFILL. Given the server
 * registry, this device's current local profiles, this account's own
 * pending renames, and the ids this account has already run this exact
 * backfill for before (profileStorage.ts's getRenameBackfilledIds — never
 * re-applied for the same (profileId, accountKey) pair), compute the {id,
 * name} pairs that must be durably recorded as pending renames BEFORE this
 * round's normal push/pull machinery (computeProfilesToRename/
 * selectServerRenamesToApply) ever runs.
 *
 * Why this exists: `dwp.profilePendingRenames` (the rename ledger) did not
 * always exist. An existing user's `dwp.profiles` can already hold a local
 * custom name that predates it — back when renameProfile() was purely
 * local and never pushed anything server-side at all (see AGENTS.md's own
 * "single maintained source of truth" history for this feature). The FIRST
 * time such a device reconciles under the new ledger, that local/server
 * mismatch has NO pending marker to explain it — structurally identical to
 * "a DIFFERENT device already pushed a rename I haven't pulled yet" —
 * so without this, selectServerRenamesToApply's own pull path would
 * silently overwrite the user's real custom name with the server's stale
 * registered one, the very first time they ever benefit from this feature.
 *
 * Returns TWO separate lists, not one — this is the Codex fix for a
 * migration-completion gap:
 *   - `toBackfillAsPending`: {id, name} pairs that must be durably recorded
 *     as pending renames (a genuine local/server mismatch to preserve).
 *   - `idsToMarkComplete`: EVERY id examined this round that is eligible for
 *     the pre-ledger migration at all (locally known, server-known, not
 *     already ledger-tracked, not already backfilled before) — regardless
 *     of whether it turned out mismatched or already converged.
 *
 * Codex finding: an EARLIER version of this function only ever returned (and
 * the caller only ever marked-complete) the mismatched subset. That left an
 * already-converged, server-known id — e.g. a device that reconciles for the
 * first time under the new ledger with local name already equal to the
 * server's — permanently unmarked. If a DIFFERENT device later legitimately
 * renamed that same id, THIS device would still see a "local != server"
 * mismatch on some later round with no pending marker and no backfill stamp
 * — structurally indistinguishable from genuine pre-ledger local intent — and
 * would incorrectly re-propose the (by-then stale) local name as a backfill
 * candidate, pushing it back over the other device's newer, legitimate
 * rename. Marking completion for EVERY eligible id — converged or
 * mismatched — the FIRST time it's examined ensures the one-time guard
 * (`alreadyBackfilledIds`) always excludes it from then on, so this legacy
 * backfill logic only ever fires during the actual upgrade transition and
 * can never reinterpret a later remote rename as legacy local intent.
 *
 * An id is ELIGIBLE for migration completion (added to `idsToMarkComplete`)
 * when ALL of:
 *   - it is already locally known (in `localProfiles`, which callers pass
 *     already filtered to this account's own visible list — an id this
 *     account locally deleted is never eligible);
 *   - the server ALREADY has an ACTIVE row for it (a not-yet-known id is
 *     computeProfilesToAdopt's job — nothing to preserve against, since a
 *     brand-new registration can't be "overwritten"; it stays eligible on a
 *     later round once the server does know it);
 *   - it has NO pending-rename marker yet (an id already tracked by the
 *     ledger has nothing to backfill — the normal push/pull machinery
 *     already owns it, and this function running again after its own
 *     backfill already recorded a marker must be a no-op, not a
 *     re-proposal);
 *   - this exact (profileId, accountKey) pair has never been backfilled
 *     before (the durable, one-time-only guard).
 *
 * Among ELIGIBLE ids, one is additionally added to `toBackfillAsPending`
 * (a genuine customization to preserve) only when BOTH:
 *   - its local name DIFFERS from the server's confirmed name (nothing to
 *     preserve when they already agree — such an id still gets marked
 *     complete, just with no pending marker);
 *   - for the CANONICAL_SHARED_PROFILE_ID (`default`) SPECIFICALLY: the
 *     local name is not simply DEFAULT_PROFILE_NAME, the literal, untouched
 *     bootstrap value every device auto-creates `default` with (see that
 *     constant's own doc). `default` is the ONE id every device creates
 *     locally on its own, independent of the normal adopt/discover-and-
 *     copy-name flow every OTHER id goes through — so a mismatch for it
 *     can ALSO legitimately arise from a genuinely untouched device simply
 *     not yet having pulled ANOTHER device's already-pushed rename (this
 *     feature's own earlier rounds), which must still be pulled normally,
 *     never mistaken for this device's own "customization" and pushed
 *     back over it. Such a `default` mismatch is STILL added to
 *     `idsToMarkComplete` (migration is complete either way — there's no
 *     further pre-ledger local intent left to discover for it), just not to
 *     `toBackfillAsPending`. A non-default id gets no equivalent bootstrap
 *     check, because it has no equivalent auto-created "untouched" value to
 *     detect — every non-default id this account locally holds got there
 *     either by this device genuinely creating/renaming it, or by adopting
 *     it with whatever name the server already had, so a later mismatch
 *     ordinarily does mean local, self-initiated intent to preserve.
 *
 * Bounded scope, NOT a general conflict resolver: this is a one-time,
 * best-effort migration heuristic for the transition off purely-local
 * renames, not a mechanism for correctly resolving genuinely ambiguous,
 * concurrent multi-device pre-SH.5 rename intent (e.g. two devices each
 * carrying their OWN distinct customization for the same id, racing to be
 * the first to reconcile post-upgrade). Like the separately-deferred
 * simultaneous two-tab rename ordering race, resolving that ambiguity is
 * explicitly out of scope here — this function does not attempt to add new
 * conflict-detection or versioning architecture to arbitrate it. What it
 * DOES guarantee, unconditionally, is the bounded, one-time nature of the
 * migration itself: any id this function examines is judged exactly once
 * per (profileId, accountKey) — `idsToMarkComplete`'s one-time guard — after
 * which normal SH.5 rename reconciliation (computeProfilesToRename /
 * selectServerRenamesToApply) exclusively governs it, so a later, ordinary
 * (non-concurrent) remote rename is always pulled normally rather than
 * re-examined by this legacy path.
 *
 * Pure — takes every input as a parameter.
 *
 * Run from Node:
 *   import { DEV_COMPUTE_RENAME_BACKFILL_CANDIDATES_CASES, computeRenameBackfillCandidates } from "@/lib/profileRegistrySync";
 *   DEV_COMPUTE_RENAME_BACKFILL_CANDIDATES_CASES.forEach(c => {
 *     const got = computeRenameBackfillCandidates(c.serverProfiles, c.localProfiles, c.pendingRenames, c.alreadyBackfilledIds);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function computeRenameBackfillCandidates(
  serverProfiles: ServerProfileRecord[],
  localProfiles: Profile[],
  pendingRenames: PendingRenames,
  alreadyBackfilledIds: ReadonlySet<string>
): { toBackfillAsPending: Profile[]; idsToMarkComplete: string[] } {
  const serverNameById = new Map(serverProfiles.filter((p) => !p.deletedAt).map((p) => [p.profileId, p.name]));
  const toBackfillAsPending: Profile[] = [];
  const idsToMarkComplete: string[] = [];
  for (const local of localProfiles) {
    if (pendingRenames[local.id]) continue; // already tracked by the ledger — nothing to backfill
    if (alreadyBackfilledIds.has(local.id)) continue; // one-time-only guard
    const serverName = serverNameById.get(local.id);
    if (serverName === undefined) continue; // not yet server-known — computeProfilesToAdopt's job
    // Eligible for migration completion regardless of convergence — see
    // this function's own doc for why converged ids must ALSO be marked.
    idsToMarkComplete.push(local.id);
    if (serverName === local.name) continue; // already converged, nothing to preserve as a pending rename
    if (local.id === CANONICAL_SHARED_PROFILE_ID && local.name === DEFAULT_PROFILE_NAME) continue; // untouched bootstrap value, not a customization
    toBackfillAsPending.push({ id: local.id, name: local.name });
  }
  return { toBackfillAsPending, idsToMarkComplete };
}

export const DEV_COMPUTE_RENAME_BACKFILL_CANDIDATES_CASES: Array<{
  name: string;
  serverProfiles: ServerProfileRecord[];
  localProfiles: Profile[];
  pendingRenames: PendingRenames;
  alreadyBackfilledIds: Set<string>;
  expected: { toBackfillAsPending: Profile[]; idsToMarkComplete: string[] };
}> = [
  {
    name: "the realistic existing-user flow — local `default` already has a custom name from before the ledger existed; the server still has the literal bootstrap name",
    serverProfiles: [{ profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Our Family Trip" }],
    pendingRenames: {},
    alreadyBackfilledIds: new Set(),
    expected: { toBackfillAsPending: [{ id: "default", name: "Our Family Trip" }], idsToMarkComplete: ["default"] },
  },
  {
    name: "a genuinely untouched device — local `default` is still the literal bootstrap name, but ANOTHER device already legitimately pushed a rename; must be PULLED normally, never mistaken for this device's own customization — still marked migration-complete since there is no further pre-ledger local intent to discover for it",
    serverProfiles: [{ profileId: "default", name: "Renamed On Another Device", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Default" }],
    pendingRenames: {},
    alreadyBackfilledIds: new Set(),
    expected: { toBackfillAsPending: [], idsToMarkComplete: ["default"] },
  },
  {
    name: "a non-default id's local/server mismatch with no marker is treated as this device's own genuine pre-SH.5 customization and backfilled — non-default ids have no bootstrap-value exception the way `default` does",
    serverProfiles: [{ profileId: "family", name: "Family", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "family", name: "The Smiths" }],
    pendingRenames: {},
    alreadyBackfilledIds: new Set(),
    expected: { toBackfillAsPending: [{ id: "family", name: "The Smiths" }], idsToMarkComplete: ["family"] },
  },
  {
    name: "already backfilled once for this (id, account) — never proposed again, even though the mismatch (by itself) still looks identical",
    serverProfiles: [{ profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Our Family Trip" }],
    pendingRenames: {},
    alreadyBackfilledIds: new Set(["default"]),
    expected: { toBackfillAsPending: [], idsToMarkComplete: [] },
  },
  {
    name: "a pending marker already exists for the id — the ledger already owns it, never a backfill candidate, and not re-marked complete (the ledger already covers it)",
    serverProfiles: [{ profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Our Family Trip" }],
    pendingRenames: { default: { name: "Our Family Trip", renamedAt: 1 } },
    alreadyBackfilledIds: new Set(),
    expected: { toBackfillAsPending: [], idsToMarkComplete: [] },
  },
  {
    name: "id not yet known to the server at all — computeProfilesToAdopt's job, never a backfill or completion candidate yet",
    serverProfiles: [],
    localProfiles: [{ id: "family", name: "The Smiths" }],
    pendingRenames: {},
    alreadyBackfilledIds: new Set(),
    expected: { toBackfillAsPending: [], idsToMarkComplete: [] },
  },
  {
    name: "Codex finding — local and server names already agree: nothing to backfill as pending, but STILL marked migration-complete so a later legitimate remote rename is never mistaken for stale local intent",
    serverProfiles: [{ profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Default" }],
    pendingRenames: {},
    alreadyBackfilledIds: new Set(),
    expected: { toBackfillAsPending: [], idsToMarkComplete: ["default"] },
  },
  {
    name: "a tombstoned server row is never a backfill or completion target",
    serverProfiles: [
      { profileId: "family", name: "Family", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: "2026-02-01T00:00:00.000Z" },
    ],
    localProfiles: [{ id: "family", name: "The Smiths" }],
    pendingRenames: {},
    alreadyBackfilledIds: new Set(),
    expected: { toBackfillAsPending: [], idsToMarkComplete: [] },
  },
];

/**
 * Codex finding — composed end-to-end regression for the COMPLETE upgrade
 * flow: an existing user's pre-ledger local rename is discovered, durably
 * backfilled as a pending marker (never lost even if the round were
 * interrupted right after), immediately picked up by THIS SAME round's own
 * computeProfilesToRename (no extra round-trip needed), and once the push
 * is confirmed, the one-time backfill guard AND the pending marker both end
 * up exactly where a normal (non-backfilled) rename would leave them —
 * proving the backfilled marker behaves identically to a fresh
 * user-initiated rename from that point on, not a special, parallel path.
 *
 * Run from Node:
 *   import {
 *     DEV_RENAME_BACKFILL_UPGRADE_FLOW_CASES,
 *     computeRenameBackfillCandidates,
 *     computeProfilesToRename,
 *     selectConfirmedPendingRenames,
 *   } from "@/lib/profileRegistrySync";
 *   import {
 *     applyRenameBackfillStamp,
 *     selectRenameBackfilledIdsForAccount,
 *     applyPendingRename,
 *     selectPendingRenamesForAccount,
 *     clearPendingRenameForAccount,
 *   } from "@/lib/profileStorage";
 *   DEV_RENAME_BACKFILL_UPGRADE_FLOW_CASES.forEach(c => {
 *     // Round 1 (first reconciliation ever under the new ledger): the
 *     // mismatch is detected and durably backfilled BEFORE any push/pull.
 *     let registryState = {};
 *     let pendingState = {};
 *     const alreadyBackfilled = selectRenameBackfilledIdsForAccount(registryState, c.accountKey);
 *     const { toBackfillAsPending, idsToMarkComplete } = computeRenameBackfillCandidates(c.serverProfiles, c.localProfiles, {}, alreadyBackfilled);
 *     for (const candidate of toBackfillAsPending) {
 *       pendingState = applyPendingRename(pendingState, candidate.id, c.accountKey, candidate.name, 1);
 *     }
 *     for (const id of idsToMarkComplete) {
 *       registryState = applyRenameBackfillStamp(registryState, id, c.accountKey);
 *     }
 *     const localNamePreserved = c.localProfiles.find(p => p.id === c.profileId)?.name;
 *
 *     // SAME round: computeProfilesToRename immediately sees the freshly
 *     // backfilled marker and proposes it for push — no extra round-trip.
 *     const pendingForAccount = selectPendingRenamesForAccount(pendingState, c.accountKey);
 *     const toRename = computeProfilesToRename(c.serverProfiles, c.localProfiles, pendingForAccount);
 *
 *     // Push succeeds and is confirmed; both the marker and the one-time
 *     // guard end up exactly as a normal (non-backfilled) rename would leave them.
 *     const authoritativeAfterPush = [{ profileId: c.profileId, name: c.localName, updatedAt: "x", deletedAt: null }];
 *     const confirmed = selectConfirmedPendingRenames(pendingForAccount, authoritativeAfterPush);
 *     pendingState = clearPendingRenameForAccount(pendingState, c.profileId, c.accountKey, c.localName);
 *
 *     // Round 2 (a later reconciliation): the one-time guard means the
 *     // ALREADY-CONFIRMED id is never re-backfilled, even if some other
 *     // unrelated mismatch existed transiently.
 *     const stillBackfilledOnlyOnce = computeRenameBackfillCandidates(
 *       authoritativeAfterPush, c.localProfiles, {}, selectRenameBackfilledIdsForAccount(registryState, c.accountKey)
 *     );
 *
 *     const ok =
 *       localNamePreserved === c.localName &&
 *       JSON.stringify(toRename) === JSON.stringify([{ id: c.profileId, name: c.localName }]) &&
 *       JSON.stringify(confirmed) === JSON.stringify([{ id: c.profileId, name: c.localName }]) &&
 *       selectPendingRenamesForAccount(pendingState, c.accountKey)[c.profileId] === undefined &&
 *       stillBackfilledOnlyOnce.toBackfillAsPending.length === 0 &&
 *       stillBackfilledOnlyOnce.idsToMarkComplete.length === 0;
 *     console.log(ok ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_RENAME_BACKFILL_UPGRADE_FLOW_CASES: Array<{
  name: string;
  profileId: string;
  accountKey: string;
  localName: string;
  serverProfiles: ServerProfileRecord[];
  localProfiles: Profile[];
}> = [
  {
    name: "Codex finding — the realistic existing-user flow: local `default` has a custom name from before the ledger existed, while the server still has the literal bootstrap 'Default' — the full upgrade round preserves it, pushes it, and confirms it exactly like an ordinary rename",
    profileId: "default",
    accountKey: "userA",
    localName: "Our Family Trip",
    serverProfiles: [{ profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Our Family Trip" }],
  },
  {
    name: "same guarantee for a pre-ledger rename of an ordinary (non-canonical) profile id",
    profileId: "family",
    accountKey: "userA",
    localName: "The Smiths",
    serverProfiles: [{ profileId: "family", name: "Family", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "family", name: "The Smiths" }],
  },
];

/**
 * Codex finding — composed end-to-end regression for the specific migration-
 * completion gap fixed above: an id that is ALREADY CONVERGED (local name ==
 * server name) the very first time it's examined under the new ledger must
 * still be marked migration-complete, so that a LATER, genuinely different
 * device's legitimate rename of that same id is correctly PULLED on this
 * device's next reconciliation — never re-proposed as a stale local backfill
 * candidate that would push the old name back over the newer one.
 *
 * Round 1 (first post-upgrade reconciliation): local and server names for
 * the id already agree. computeRenameBackfillCandidates must report it in
 * `idsToMarkComplete` (migration done) while `toBackfillAsPending` stays
 * empty (nothing to preserve — there was no divergent local customization).
 *
 * Round 2 (a later reconciliation, after another device renamed the SAME
 * id on the server): this device's local copy is unchanged, since round 1
 * converged and pushed nothing. Because round 1 already stamped the id
 * complete, round 2's computeRenameBackfillCandidates must exclude it
 * entirely (both lists empty) via the one-time `alreadyBackfilledIds`
 * guard — proving it can never reinterpret the new remote rename as this
 * device's own legacy local intent. selectServerRenamesToApply (the normal,
 * unrelated pull path) must then correctly propose pulling the other
 * device's newer name, exactly as it would for any ordinary remote rename.
 *
 * Run from Node:
 *   import {
 *     DEV_CONVERGED_BACKFILL_THEN_REMOTE_RENAME_PULLED_CASES,
 *     computeRenameBackfillCandidates,
 *     selectServerRenamesToApply,
 *   } from "@/lib/profileRegistrySync";
 *   import {
 *     applyRenameBackfillStamp,
 *     selectRenameBackfilledIdsForAccount,
 *   } from "@/lib/profileStorage";
 *   DEV_CONVERGED_BACKFILL_THEN_REMOTE_RENAME_PULLED_CASES.forEach(c => {
 *     // Round 1: first post-upgrade reconciliation. Local already equals
 *     // server — converged, nothing to preserve as a pending rename — but
 *     // migration completion must still be recorded.
 *     let registryState = {};
 *     const alreadyBackfilled1 = selectRenameBackfilledIdsForAccount(registryState, c.accountKey);
 *     const round1 = computeRenameBackfillCandidates(c.serverProfilesRound1, c.localProfiles, {}, alreadyBackfilled1);
 *     for (const id of round1.idsToMarkComplete) {
 *       registryState = applyRenameBackfillStamp(registryState, id, c.accountKey);
 *     }
 *     const migrationMarkedComplete = selectRenameBackfilledIdsForAccount(registryState, c.accountKey).has(c.profileId);
 *
 *     // Round 2: another device legitimately renamed the same id on the
 *     // server. This device's local copy is unchanged (round 1 pushed
 *     // nothing). The one-time guard must exclude it from backfill
 *     // consideration entirely, and the normal pull path must apply the
 *     // newer remote name instead.
 *     const alreadyBackfilled2 = selectRenameBackfilledIdsForAccount(registryState, c.accountKey);
 *     const round2 = computeRenameBackfillCandidates(c.serverProfilesRound2, c.localProfiles, {}, alreadyBackfilled2);
 *     const round2Pulls = selectServerRenamesToApply(c.serverProfilesRound2, c.localProfiles, new Set());
 *
 *     const ok =
 *       round1.toBackfillAsPending.length === 0 &&
 *       JSON.stringify(round1.idsToMarkComplete) === JSON.stringify([c.profileId]) &&
 *       migrationMarkedComplete &&
 *       round2.toBackfillAsPending.length === 0 &&
 *       round2.idsToMarkComplete.length === 0 &&
 *       JSON.stringify(round2Pulls) === JSON.stringify([{ id: c.profileId, name: c.remoteRenamedName }]);
 *     console.log(ok ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_CONVERGED_BACKFILL_THEN_REMOTE_RENAME_PULLED_CASES: Array<{
  name: string;
  profileId: string;
  accountKey: string;
  localProfiles: Profile[];
  serverProfilesRound1: ServerProfileRecord[];
  serverProfilesRound2: ServerProfileRecord[];
  remoteRenamedName: string;
}> = [
  {
    name: "Codex finding — canonical `default`: converges on round 1 (migration marked complete with nothing pending), then another device renames it; round 2 correctly pulls the newer remote name instead of re-backfilling the stale local one",
    profileId: "default",
    accountKey: "userA",
    localProfiles: [{ id: "default", name: "Family" }],
    serverProfilesRound1: [{ profileId: "default", name: "Family", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    serverProfilesRound2: [{ profileId: "default", name: "The Smiths", updatedAt: "2026-02-01T00:00:00.000Z", deletedAt: null }],
    remoteRenamedName: "The Smiths",
  },
  {
    name: "same guarantee for an ordinary (non-canonical) profile id",
    profileId: "family",
    accountKey: "userA",
    localProfiles: [{ id: "family", name: "Family" }],
    serverProfilesRound1: [{ profileId: "family", name: "Family", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    serverProfilesRound2: [{ profileId: "family", name: "The Smiths", updatedAt: "2026-02-01T00:00:00.000Z", deletedAt: null }],
    remoteRenamedName: "The Smiths",
  },
];

/**
 * Codex finding — composed end-to-end regression for the bounded pre-SH.5
 * migration's `default` exception: a GENUINELY UNTOUCHED device (local
 * `default` still the literal bootstrap `DEFAULT_PROFILE_NAME`) whose server
 * `default` already carries a DIFFERENT device's genuine custom name must
 * PULL that custom name normally, not treat its own untouched bootstrap
 * value as something to preserve.
 *
 * Round 1 (first post-upgrade reconciliation): local `default` is still the
 * literal bootstrap value; the server's `default` is already a custom name
 * pushed by another device. `toBackfillAsPending` must stay empty (nothing
 * of this device's own to preserve) while `idsToMarkComplete` still records
 * `default` (migration is done either way — see this function's own doc).
 * With no pending marker created, `selectServerRenamesToApply` — the normal,
 * unrelated pull path — must then propose pulling the server's custom name,
 * and merging it must actually update the local copy.
 *
 * Round 2 (immediately after, one-time-guard check): with `default` now
 * marked complete AND locally updated to match the server, a second
 * reconciliation must not re-propose it for backfill at all (both lists
 * empty) — proving the migration ran exactly once.
 *
 * Round 3 (a later, ordinary remote rename after migration completion):
 * some OTHER device renames `default` again. Because migration already
 * completed in round 1, this is governed exclusively by normal SH.5
 * reconciliation — `selectServerRenamesToApply` must pull it like any other
 * remote rename, and `computeRenameBackfillCandidates` must still report
 * `default` as fully excluded (never re-examined by this legacy path).
 *
 * Run from Node:
 *   import {
 *     DEV_UNTOUCHED_DEFAULT_PULLS_SERVER_CUSTOM_NAME_CASES,
 *     computeRenameBackfillCandidates,
 *     selectServerRenamesToApply,
 *   } from "@/lib/profileRegistrySync";
 *   import {
 *     applyRenameBackfillStamp,
 *     selectRenameBackfilledIdsForAccount,
 *     mergeProfileRenames,
 *   } from "@/lib/profileStorage";
 *   DEV_UNTOUCHED_DEFAULT_PULLS_SERVER_CUSTOM_NAME_CASES.forEach(c => {
 *     // Round 1: untouched local `default`, server already has another
 *     // device's genuine custom name. Nothing of this device's own to
 *     // preserve, but migration completion is still recorded.
 *     let registryState = {};
 *     let localProfiles = c.localProfiles;
 *     const alreadyBackfilled1 = selectRenameBackfilledIdsForAccount(registryState, c.accountKey);
 *     const round1 = computeRenameBackfillCandidates(c.serverProfilesRound1, localProfiles, {}, alreadyBackfilled1);
 *     for (const id of round1.idsToMarkComplete) {
 *       registryState = applyRenameBackfillStamp(registryState, id, c.accountKey);
 *     }
 *     const round1Pulls = selectServerRenamesToApply(c.serverProfilesRound1, localProfiles, new Set());
 *     localProfiles = mergeProfileRenames(localProfiles, round1Pulls);
 *     const nameAfterRound1 = localProfiles.find(p => p.id === c.profileId)?.name;
 *
 *     // Round 2: one-time-guard check — must not re-propose `default` at all.
 *     const alreadyBackfilled2 = selectRenameBackfilledIdsForAccount(registryState, c.accountKey);
 *     const round2 = computeRenameBackfillCandidates(c.serverProfilesRound1, localProfiles, {}, alreadyBackfilled2);
 *
 *     // Round 3: a later, ordinary remote rename by some OTHER device —
 *     // governed exclusively by normal SH.5 reconciliation from here on.
 *     const round3 = computeRenameBackfillCandidates(c.serverProfilesRound3, localProfiles, {}, alreadyBackfilled2);
 *     const round3Pulls = selectServerRenamesToApply(c.serverProfilesRound3, localProfiles, new Set());
 *
 *     const ok =
 *       round1.toBackfillAsPending.length === 0 &&
 *       JSON.stringify(round1.idsToMarkComplete) === JSON.stringify([c.profileId]) &&
 *       JSON.stringify(round1Pulls) === JSON.stringify([{ id: c.profileId, name: c.firstCustomName }]) &&
 *       nameAfterRound1 === c.firstCustomName &&
 *       round2.toBackfillAsPending.length === 0 &&
 *       round2.idsToMarkComplete.length === 0 &&
 *       round3.toBackfillAsPending.length === 0 &&
 *       round3.idsToMarkComplete.length === 0 &&
 *       JSON.stringify(round3Pulls) === JSON.stringify([{ id: c.profileId, name: c.laterRemoteRenamedName }]);
 *     console.log(ok ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_UNTOUCHED_DEFAULT_PULLS_SERVER_CUSTOM_NAME_CASES: Array<{
  name: string;
  profileId: string;
  accountKey: string;
  localProfiles: Profile[];
  serverProfilesRound1: ServerProfileRecord[];
  firstCustomName: string;
  serverProfilesRound3: ServerProfileRecord[];
  laterRemoteRenamedName: string;
}> = [
  {
    name: "Codex finding — a genuinely untouched device pulls another device's already-pushed custom `default` name during the bounded migration, never mistaking its own bootstrap value for customization; a later, ordinary remote rename after completion still pulls normally",
    profileId: "default",
    accountKey: "userA",
    localProfiles: [{ id: "default", name: "Default" }],
    serverProfilesRound1: [{ profileId: "default", name: "Our Family Trip", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    firstCustomName: "Our Family Trip",
    serverProfilesRound3: [{ profileId: "default", name: "The Smiths", updatedAt: "2026-03-01T00:00:00.000Z", deletedAt: null }],
    laterRemoteRenamedName: "The Smiths",
  },
];

/**
 * Given the server registry and this device's current local profiles and
 * own unconfirmed pending renames (profileStorage.ts's
 * getPendingProfileRenames), compute the {id, name} pairs that should be
 * PUSHED as rename updates this round — the PUSH-side counterpart to
 * computeProfilesToAdopt, for an id the account's OWN server row ALREADY
 * exists for (an id the server has never seen belongs to
 * computeProfilesToAdopt instead; this function explicitly skips anything
 * not already server-known).
 *
 * An id is proposed for rename ONLY when ALL of:
 *   - it has a pending-rename entry (this device deliberately renamed it,
 *     not merely observed a mismatch — see this module's own header doc for
 *     why directionality matters: an id can equally be mismatched because
 *     ANOTHER device renamed it, which must be PULLED, never overwritten by
 *     a push from a device that never touched it — selectServerRenamesToApply
 *     below owns that pull path);
 *   - this device still has the profile locally at all (this account
 *     deleted it, or it was never here — nothing left to push);
 *   - the server ALREADY has an ACTIVE row for this id, SCOPED TO THIS
 *     ACCOUNT (`serverProfiles` is this round's own GET response, which the
 *     server itself already scopes by `user_id` — see /api/sync/profiles's
 *     route doc). That row's mere existence IS this account's own
 *     confirmed, unambiguous ownership of it, full stop — a not-yet-known
 *     id is computeProfilesToAdopt's job, not a rename;
 *   - the server's current name for it differs from the pending name
 *     (nothing to push otherwise — already converged).
 *
 * Codex finding #1 — deliberately takes NO `ownedByOtherAccountIds`
 * parameter, unlike computeProfilesToAdopt. That exclusion protects
 * ADOPTION (a brand-new registration this account has never made before)
 * from mistaking a legacy local id another account independently owns for
 * an unclaimed one; a rename target has no such ambiguity to protect
 * against, because it is ALWAYS already confirmed via THIS round's own
 * `serverProfiles` — i.e. the server's own `user_id`-scoped row already
 * proves the CURRENT account owns it, regardless of whether some OTHER
 * account also, independently, owns the identical literal non-default id
 * (profileStorage.ts's own module doc: two accounts can each legitimately
 * own the same literal id). Reusing computeProfilesToAdopt's exclusion here
 * previously blocked exactly that legitimate case — a confirmed rename for
 * a co-owned id was silently dropped every round, forever, even though the
 * account's own server row for it was right there in `serverProfiles`.
 *
 * Pure — takes every input as a parameter.
 *
 * Run from Node:
 *   import { DEV_COMPUTE_PROFILES_TO_RENAME_CASES, computeProfilesToRename } from "@/lib/profileRegistrySync";
 *   DEV_COMPUTE_PROFILES_TO_RENAME_CASES.forEach(c => {
 *     const got = computeProfilesToRename(c.serverProfiles, c.localProfiles, c.pendingRenames);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function computeProfilesToRename(
  serverProfiles: ServerProfileRecord[],
  localProfiles: Profile[],
  pendingRenames: PendingRenames
): Profile[] {
  const serverNameById = new Map(serverProfiles.filter((p) => !p.deletedAt).map((p) => [p.profileId, p.name]));
  const localIds = new Set(localProfiles.map((p) => p.id));
  const out: Profile[] = [];
  for (const [id, pending] of Object.entries(pendingRenames)) {
    // Codex finding — presence, NOT name equality: `dwp.profiles` is a
    // single SHARED local list, not per-account, so a DIFFERENT account's
    // own legitimate pull (selectServerRenamesToApply/applyServerRenames)
    // can freely overwrite the shared display name for an id this account
    // ALSO has a pending rename for — most likely for the canonical
    // `default` id, which every account shares. Requiring the shared name
    // to still match this account's own pending value would strand that
    // pending rename forever the instant another account's pull (or its
    // own discovery) touched the same shared row. The pending marker
    // itself (scoped per (profileId, accountKey) — see profileStorage.ts's
    // PendingRenamesByAccount) is already the sole source of truth for
    // "what THIS account still intends"; only genuine ABSENCE from the
    // local list (this account deleted the profile, or it was never here)
    // means there is nothing left to push.
    if (!localIds.has(id)) continue;
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
  expected: Profile[];
}> = [
  {
    name: "a locally-renamed, already-server-known id is pushed",
    serverProfiles: [{ profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Our Family Trip" }],
    pendingRenames: { default: { name: "Our Family Trip", renamedAt: 1 } },
    expected: [{ id: "default", name: "Our Family Trip" }],
  },
  {
    name: "no pending rename for a mismatched id — never pushed here (that's a PULL, via selectServerRenamesToApply, not a push)",
    serverProfiles: [{ profileId: "default", name: "Old Name (renamed elsewhere)", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Default" }],
    pendingRenames: {},
    expected: [],
  },
  {
    name: "pending rename for an id NOT yet known to the server — skipped (computeProfilesToAdopt's job, avoids a duplicate push)",
    serverProfiles: [],
    localProfiles: [{ id: "mom", name: "Mom" }],
    pendingRenames: { mom: { name: "Mom", renamedAt: 1 } },
    expected: [],
  },
  {
    name: "pending rename already matches server's current name — nothing to push, converged",
    serverProfiles: [{ profileId: "default", name: "Our Family Trip", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Our Family Trip" }],
    pendingRenames: { default: { name: "Our Family Trip", renamedAt: 1 } },
    expected: [],
  },
  {
    name: "another account's legitimate pull already overwrote the SHARED local display name; this account's own pending rename is still pushed rather than abandoned (the shared dwp.profiles name is no longer proof of what THIS account intends — only the account-scoped pending marker is)",
    serverProfiles: [{ profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Some Other Account's Name" }],
    pendingRenames: { default: { name: "Our Family Trip", renamedAt: 1 } },
    expected: [{ id: "default", name: "Our Family Trip" }],
  },
  {
    name: "this account no longer has the profile locally at all (e.g. deleted it) — genuinely nothing to push, unlike a mere name mismatch above",
    serverProfiles: [{ profileId: "family", name: "Family", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Default" }],
    pendingRenames: { family: { name: "The Smiths", renamedAt: 1 } },
    expected: [],
  },
  {
    name: "an id NOT yet confirmed via this account's own serverProfiles is never pushed as a rename, even with a pending marker for it — computeProfilesToAdopt's job instead",
    serverProfiles: [],
    localProfiles: [{ id: "family", name: "My Rename" }],
    pendingRenames: { family: { name: "My Rename", renamedAt: 1 } },
    expected: [],
  },
  {
    name: "Codex finding #1 — a NON-default id independently owned by another account TOO is still renamed for this account, because this round's own serverProfiles already confirms THIS account's active row for it; the old ownedByOtherAccountIds exclusion (removed) would have wrongly blocked this forever",
    serverProfiles: [{ profileId: "family", name: "Old Family Name", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "family", name: "The Smiths" }],
    pendingRenames: { family: { name: "The Smiths", renamedAt: 1 } },
    expected: [{ id: "family", name: "The Smiths" }],
  },
  {
    name: "the canonical 'default' id's own rename is always pushable for this account once confirmed via serverProfiles",
    serverProfiles: [{ profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    localProfiles: [{ id: "default", name: "Our Family Trip" }],
    pendingRenames: { default: { name: "Our Family Trip", renamedAt: 1 } },
    expected: [{ id: "default", name: "Our Family Trip" }],
  },
];

/**
 * Codex finding #2 — given this account's FULL pending-rename map and the
 * (post-push, if any) authoritative server registry, return every {id,
 * name} pair whose pending name is ALREADY confirmed by the server —
 * regardless of whether that id was pushed THIS round.
 *
 * Before this fix, a pending marker was only ever checked for confirmation
 * by iterating `toRename` — the ids computeProfilesToRename decided to
 * PUSH this round. But computeProfilesToRename deliberately excludes an id
 * whose server name ALREADY matches its pending name ("already converged —
 * nothing to push"), so a marker that becomes satisfied WITHOUT this
 * round's own push (e.g. a PREVIOUS round's PUT committed successfully,
 * but that round's OWN confirmatory re-GET then failed —
 * resolveAuthoritativeServerProfiles falls back to the pre-push snapshot
 * in that case, leaving the marker standing) was never re-examined: a
 * LATER round's plain initial GET already shows it converged, so nothing
 * gets pushed, and nothing previously iterated the pending set on that
 * path to notice the marker was already satisfied and clear it. This
 * function checks the pending set DIRECTLY against whatever
 * `authoritativeServerProfiles` this round actually has — independent of
 * computeProfilesToRename's own "did I push it" decision — so a marker
 * left over from a past confirmation failure is cleared the moment ANY
 * later round observes the server already agrees, pushed or not.
 *
 * A tombstoned server row is never treated as confirming a rename (mirrors
 * computeProfilesToRename's own `!p.deletedAt` filter) — a deleted
 * profile's name is not this account's rename converging, whatever
 * lingering `name` value the tombstoned row happens to carry.
 *
 * Pure — takes every input as a parameter.
 *
 * Run from Node:
 *   import { DEV_SELECT_CONFIRMED_PENDING_RENAMES_CASES, selectConfirmedPendingRenames } from "@/lib/profileRegistrySync";
 *   DEV_SELECT_CONFIRMED_PENDING_RENAMES_CASES.forEach(c => {
 *     const got = selectConfirmedPendingRenames(c.pendingRenames, c.authoritativeServerProfiles);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function selectConfirmedPendingRenames(
  pendingRenames: PendingRenames,
  authoritativeServerProfiles: ServerProfileRecord[]
): Profile[] {
  const authoritativeNameById = new Map(
    authoritativeServerProfiles.filter((p) => !p.deletedAt).map((p) => [p.profileId, p.name])
  );
  const out: Profile[] = [];
  for (const [id, pending] of Object.entries(pendingRenames)) {
    if (authoritativeNameById.get(id) === pending.name) {
      out.push({ id, name: pending.name });
    }
  }
  return out;
}

export const DEV_SELECT_CONFIRMED_PENDING_RENAMES_CASES: Array<{
  name: string;
  pendingRenames: PendingRenames;
  authoritativeServerProfiles: ServerProfileRecord[];
  expected: Profile[];
}> = [
  {
    name: "Codex finding #2 — a marker left over from a PAST push whose own confirmation failed is now cleared once a LATER round's authoritative state simply already agrees, even though this round pushed nothing for it",
    pendingRenames: { default: { name: "Our Family Trip", renamedAt: 1 } },
    authoritativeServerProfiles: [
      { profileId: "default", name: "Our Family Trip", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    expected: [{ id: "default", name: "Our Family Trip" }],
  },
  {
    name: "not yet confirmed — server name still differs — marker stays",
    pendingRenames: { default: { name: "Our Family Trip", renamedAt: 1 } },
    authoritativeServerProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    expected: [],
  },
  {
    name: "id not yet present server-side at all — nothing to confirm",
    pendingRenames: { mom: { name: "Mom", renamedAt: 1 } },
    authoritativeServerProfiles: [],
    expected: [],
  },
  {
    name: "a tombstoned server row is never treated as confirming a rename, even if its lingering name happens to match",
    pendingRenames: { mom: { name: "Mom", renamedAt: 1 } },
    authoritativeServerProfiles: [
      { profileId: "mom", name: "Mom", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: "2026-02-01T00:00:00.000Z" },
    ],
    expected: [],
  },
  {
    name: "multiple pending ids — only the ones the authoritative state actually confirms are returned",
    pendingRenames: {
      default: { name: "Our Family Trip", renamedAt: 1 },
      mom: { name: "Mom (new)", renamedAt: 2 },
    },
    authoritativeServerProfiles: [
      { profileId: "default", name: "Our Family Trip", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
      { profileId: "mom", name: "Mom (old, not yet confirmed)", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    expected: [{ id: "default", name: "Our Family Trip" }],
  },
  {
    name: "empty pending set — nothing to confirm",
    pendingRenames: {},
    authoritativeServerProfiles: [
      { profileId: "default", name: "Our Family Trip", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    expected: [],
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
 * Codex finding on d7cfaff — composed regression proving the rename-PULL
 * commit step must match against THIS account's own effective local view
 * (filtered through its own local-deletion markers via
 * profileStorage.ts's filterVisibleProfiles), never the raw shared
 * `dwp.profiles` array — exactly like every other push/adopt computation in
 * reconcileProfileRegistry already does.
 *
 * Scenario: `family` is co-owned — A and B each independently own the
 * identical literal id (profileStorage.ts's own documented, supported case).
 * A deletes `family` locally: it is hidden from A's OWN effective view, but
 * NEVER removed from the one shared `dwp.profiles` array, because B still
 * owns and displays it there under B's own retained name. A's own
 * account-scoped server GET (`authoritativeServerProfiles`) can still show
 * an ACTIVE row for `family` with some OTHER name (A's own account's server
 * state, independent of B's) — id equality with the shared array's entry is
 * all `selectServerRenamesToApply` needs to match on, with no account
 * awareness of its own.
 *
 * Before the fix: matching against the RAW shared array would propose
 * pulling A's own server name over B's retained shared entry — contaminating
 * B's profile with a rename that belongs only to A's own (deleted,
 * hidden-from-A) relationship to that id.
 *
 * After the fix: matching against `filterVisibleProfiles(rawSharedProfiles,
 * locallyDeletedIdsForA)` excludes `family` from A's own candidate set
 * entirely — A's reconciliation proposes nothing for it, and B's retained
 * entry is left completely untouched.
 *
 * Run from Node:
 *   import { DEV_CO_OWNED_DELETE_RENAME_PULL_ISOLATION_CASES, selectServerRenamesToApply } from "@/lib/profileRegistrySync";
 *   import { filterVisibleProfiles } from "@/lib/profileStorage";
 *   DEV_CO_OWNED_DELETE_RENAME_PULL_ISOLATION_CASES.forEach(c => {
 *     const withoutFix = selectServerRenamesToApply(c.authoritativeServerProfilesForA, c.rawSharedProfiles, c.pendingRenameIds);
 *     const visibleForA = filterVisibleProfiles(c.rawSharedProfiles, c.locallyDeletedIdsForA);
 *     const withFix = selectServerRenamesToApply(c.authoritativeServerProfilesForA, visibleForA, c.pendingRenameIds);
 *     const ok =
 *       JSON.stringify(withoutFix) === JSON.stringify(c.expectedWithoutFix) &&
 *       JSON.stringify(withFix) === JSON.stringify(c.expectedWithFix);
 *     console.log(ok ? "✓" : "✗ FAIL", c.name, { withoutFix, withFix });
 *   });
 */
export const DEV_CO_OWNED_DELETE_RENAME_PULL_ISOLATION_CASES: Array<{
  name: string;
  rawSharedProfiles: Profile[];
  locallyDeletedIdsForA: Set<string>;
  authoritativeServerProfilesForA: ServerProfileRecord[];
  pendingRenameIds: Set<string>;
  expectedWithoutFix: Profile[];
  expectedWithFix: Profile[];
}> = [
  {
    name: "Codex finding — A deleted co-owned `family` locally; B's retained shared entry must never receive A's own server-scoped rename",
    rawSharedProfiles: [{ id: "family", name: "The Smiths" }],
    locallyDeletedIdsForA: new Set(["family"]),
    authoritativeServerProfilesForA: [
      { profileId: "family", name: "Family Reunion", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    pendingRenameIds: new Set(),
    expectedWithoutFix: [{ id: "family", name: "Family Reunion" }],
    expectedWithFix: [],
  },
  {
    name: "same guarantee for the canonical `default` id — A deleted A's own relationship to it locally, but B's shared bootstrap `default` entry survives untouched",
    rawSharedProfiles: [{ id: "default", name: "B's Trip" }],
    locallyDeletedIdsForA: new Set(["default"]),
    authoritativeServerProfilesForA: [
      { profileId: "default", name: "A's Old Trip", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    pendingRenameIds: new Set(),
    expectedWithoutFix: [{ id: "default", name: "A's Old Trip" }],
    expectedWithFix: [],
  },
  {
    name: "a DIFFERENT, non-deleted id in the same round is unaffected by A's deletion of `family` — the filter is scoped to the deleted id only, not a blanket suppression",
    rawSharedProfiles: [
      { id: "family", name: "The Smiths" },
      { id: "vacation", name: "Old Vacation Name" },
    ],
    locallyDeletedIdsForA: new Set(["family"]),
    authoritativeServerProfilesForA: [
      { profileId: "family", name: "Family Reunion", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
      { profileId: "vacation", name: "New Vacation Name", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    pendingRenameIds: new Set(),
    expectedWithoutFix: [
      { id: "family", name: "Family Reunion" },
      { id: "vacation", name: "New Vacation Name" },
    ],
    expectedWithFix: [{ id: "vacation", name: "New Vacation Name" }],
  },
];

/**
 * Codex finding #1 — composed end-to-end regression for the COMPLETE
 * A -> B -> A shared-device flow, exercising the SAME pure functions
 * reconcileProfileRegistry itself calls (profileStorage.ts's
 * applyPendingRename/selectPendingRenamesForAccount/
 * clearPendingRenameForAccount/mergeProfileRenames, plus this module's own
 * computeProfilesToRename/selectConfirmedPendingRenames) against a single
 * shared, mutable `dwp.profiles`-style array — not just the isolated
 * marker helpers PR #162's own account-isolation fix covered. Proves the
 * account-scoped pending marker alone is not enough on its own: the SHARED
 * local display name a different account's own legitimate pull can
 * overwrite must never be mistaken for "A's rename no longer applies".
 *
 * Steps: (1) A renames the profile — updates the ONE shared local list AND
 * records A's own pending marker; (2) B signs into the SAME browser and
 * pulls B's OWN server-confirmed name for the identical id, legitimately
 * overwriting the shared local list out from under A's still-unconfirmed
 * rename; (3) switching back to A, A's reconciliation round must still
 * compute a push for A's original intended name (computeProfilesToRename)
 * despite the shared list no longer reading back A's own last local edit;
 * (4) once A's push is confirmed, selectConfirmedPendingRenames clears
 * ONLY A's own marker.
 *
 * Run from Node:
 *   import {
 *     DEV_PENDING_RENAME_SURVIVES_CROSS_ACCOUNT_PULL_CASES,
 *     computeProfilesToRename,
 *     selectServerRenamesToApply,
 *     selectConfirmedPendingRenames,
 *   } from "@/lib/profileRegistrySync";
 *   import {
 *     applyPendingRename,
 *     selectPendingRenamesForAccount,
 *     clearPendingRenameForAccount,
 *     mergeProfileRenames,
 *   } from "@/lib/profileStorage";
 *   DEV_PENDING_RENAME_SURVIVES_CROSS_ACCOUNT_PULL_CASES.forEach(c => {
 *     // (1) A renames locally + records A's own pending marker.
 *     let profiles = c.initialProfiles;
 *     let pendingState = applyPendingRename({}, c.profileId, c.accountA, c.aIntendedName, 1);
 *     profiles = profiles.map(p => p.id === c.profileId ? { ...p, name: c.aIntendedName } : p);
 *
 *     // (2) B signs in and legitimately pulls B's own server name, overwriting the SHARED list.
 *     const bPending = new Set(Object.keys(selectPendingRenamesForAccount(pendingState, c.accountB)));
 *     const bPulls = selectServerRenamesToApply(c.serverProfilesForB, profiles, bPending);
 *     profiles = mergeProfileRenames(profiles, bPulls);
 *     const sharedNameAfterB = profiles.find(p => p.id === c.profileId)?.name;
 *
 *     // (3) Switch back to A — A's own marker is untouched, and still pushable
 *     // even though the shared list no longer reflects A's last local edit.
 *     const aPending = selectPendingRenamesForAccount(pendingState, c.accountA);
 *     const toRename = computeProfilesToRename(c.serverProfilesForA, profiles, aPending);
 *
 *     // (4) A's push is confirmed — only A's own marker is cleared.
 *     const authoritativeAfterAPush = [{ profileId: c.profileId, name: c.aIntendedName, updatedAt: "x", deletedAt: null }];
 *     const confirmed = selectConfirmedPendingRenames(aPending, authoritativeAfterAPush);
 *     pendingState = clearPendingRenameForAccount(pendingState, c.profileId, c.accountA, c.aIntendedName);
 *     const aStillPendingBeforeConfirm = Object.keys(bPending).length >= 0 && aPending[c.profileId]?.name === c.aIntendedName;
 *
 *     const ok =
 *       sharedNameAfterB === c.expectedSharedNameAfterBPulls &&
 *       JSON.stringify(toRename) === JSON.stringify(c.expectedAPush) &&
 *       aStillPendingBeforeConfirm &&
 *       JSON.stringify(confirmed) === JSON.stringify(c.expectedAPush) &&
 *       selectPendingRenamesForAccount(pendingState, c.accountA)[c.profileId] === undefined;
 *     console.log(ok ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_PENDING_RENAME_SURVIVES_CROSS_ACCOUNT_PULL_CASES: Array<{
  name: string;
  profileId: string;
  accountA: string;
  accountB: string;
  aIntendedName: string;
  initialProfiles: Profile[];
  serverProfilesForA: ServerProfileRecord[];
  serverProfilesForB: ServerProfileRecord[];
  expectedSharedNameAfterBPulls: string;
  expectedAPush: Profile[];
}> = [
  {
    name: "Codex finding #1 — canonical `default`: A's pending rename survives B's own legitimate pull of the shared local name, and is still pushed once A reconciles again",
    profileId: "default",
    accountA: "userA",
    accountB: "userB",
    aIntendedName: "A's Family Trip",
    initialProfiles: [{ id: "default", name: "Default" }],
    // A's OWN server row hasn't been pushed to yet — still the old name.
    serverProfilesForA: [{ profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    // B's OWN, entirely separate server row for the identical shared id.
    serverProfilesForB: [
      { profileId: "default", name: "B's Own Default Name", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    expectedSharedNameAfterBPulls: "B's Own Default Name",
    expectedAPush: [{ id: "default", name: "A's Family Trip" }],
  },
  {
    name: "same guarantee for an ordinary (non-canonical) profile id",
    profileId: "family",
    accountA: "userA",
    accountB: "userB",
    aIntendedName: "The Smiths",
    initialProfiles: [{ id: "family", name: "Family" }],
    serverProfilesForA: [{ profileId: "family", name: "Family", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    serverProfilesForB: [
      { profileId: "family", name: "B's Own Family Name", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    expectedSharedNameAfterBPulls: "B's Own Family Name",
    expectedAPush: [{ id: "family", name: "The Smiths" }],
  },
];

/**
 * Codex finding #2 — composed end-to-end regression across TWO simulated
 * reconciliation rounds: round N's push commits server-side but its OWN
 * confirmatory re-GET fails (so `authoritativeServerProfiles` falls back
 * to the pre-push snapshot per resolveAuthoritativeServerProfiles's own
 * doc, leaving the marker standing); round N+1's plain initial GET already
 * shows it converged, so computeProfilesToRename correctly proposes
 * NOTHING to push (`toRename` empty) — proving the marker can ONLY be
 * cleared via selectConfirmedPendingRenames checking the full pending set
 * directly, never by iterating `toRename`.
 *
 * Run from Node:
 *   import {
 *     DEV_PENDING_RENAME_CLEARED_WITHOUT_PUSH_CASES,
 *     computeProfilesToRename,
 *     resolveAuthoritativeServerProfiles,
 *     selectConfirmedPendingRenames,
 *   } from "@/lib/profileRegistrySync";
 *   DEV_PENDING_RENAME_CLEARED_WITHOUT_PUSH_CASES.forEach(c => {
 *     // Round N: server already committed the rename, but this round's own
 *     // confirmatory re-GET failed — authoritative falls back to the STALE
 *     // pre-push snapshot, so the marker is correctly left standing.
 *     const roundNAuthoritative = resolveAuthoritativeServerProfiles(c.roundNInitialServerProfiles, true, null);
 *     const roundNConfirmed = selectConfirmedPendingRenames(c.pendingRenames, roundNAuthoritative);
 *
 *     // Round N+1: a fresh plain GET now shows the true, already-converged
 *     // state. Nothing gets pushed...
 *     const roundNPlus1ToRename = computeProfilesToRename(c.roundNPlus1ServerProfiles, c.localProfiles, c.pendingRenames);
 *     // ...but the marker must still be recognized as confirmed and cleared.
 *     const roundNPlus1Authoritative = resolveAuthoritativeServerProfiles(c.roundNPlus1ServerProfiles, roundNPlus1ToRename.length > 0, null);
 *     const roundNPlus1Confirmed = selectConfirmedPendingRenames(c.pendingRenames, roundNPlus1Authoritative);
 *
 *     const ok =
 *       roundNConfirmed.length === 0 &&
 *       roundNPlus1ToRename.length === 0 &&
 *       JSON.stringify(roundNPlus1Confirmed) === JSON.stringify(c.expectedConfirmedAtRoundNPlus1);
 *     console.log(ok ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_PENDING_RENAME_CLEARED_WITHOUT_PUSH_CASES: Array<{
  name: string;
  pendingRenames: PendingRenames;
  localProfiles: Profile[];
  roundNInitialServerProfiles: ServerProfileRecord[];
  roundNPlus1ServerProfiles: ServerProfileRecord[];
  expectedConfirmedAtRoundNPlus1: Profile[];
}> = [
  {
    name: "Codex finding #2 — a marker surviving a failed confirmatory re-GET is cleared by the NEXT round even though that round pushes nothing (already converged)",
    pendingRenames: { default: { name: "Our Family Trip", renamedAt: 1 } },
    localProfiles: [{ id: "default", name: "Our Family Trip" }],
    roundNInitialServerProfiles: [{ profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
    roundNPlus1ServerProfiles: [
      { profileId: "default", name: "Our Family Trip", updatedAt: "2026-01-02T00:00:00.000Z", deletedAt: null },
    ],
    expectedConfirmedAtRoundNPlus1: [{ id: "default", name: "Our Family Trip" }],
  },
];

/**
 * Codex finding #3 — composed end-to-end regression: delete a profile with
 * an unconfirmed pending rename, then recreate a DIFFERENT profile that
 * lands on the IDENTICAL normalized id (createProfile's own deterministic
 * normalizeId()), and prove the next reconciliation round proposes nothing
 * to push for it — the deleted profile's stale rename marker must not be
 * mistaken for a genuine pending rename of its successor. Exercises the
 * SAME pure functions deleteProfile/createProfile/reconcileProfileRegistry
 * themselves call (profileStorage.ts's discardPendingRenameForAccount, this
 * module's own computeProfilesToRename), not just the isolated marker
 * helper.
 *
 * Run from Node:
 *   import { DEV_STALE_RENAME_DISCARDED_ON_DELETE_RECREATE_CASES, computeProfilesToRename } from "@/lib/profileRegistrySync";
 *   import { applyPendingRename, discardPendingRenameForAccount, selectPendingRenamesForAccount } from "@/lib/profileStorage";
 *   DEV_STALE_RENAME_DISCARDED_ON_DELETE_RECREATE_CASES.forEach(c => {
 *     // The original profile is renamed but the push never confirms before it's deleted.
 *     let pendingState = applyPendingRename({}, c.profileId, c.accountKey, c.staleRenameName, 1);
 *     // deleteProfile discards this account's own marker for it, unconditionally.
 *     pendingState = discardPendingRenameForAccount(pendingState, c.profileId, c.accountKey);
 *     // A later createProfile lands a DIFFERENT, brand-new profile on the identical normalized id.
 *     const recreatedLocalProfiles = [{ id: c.profileId, name: c.recreatedProfileName }];
 *     const pendingForAccount = selectPendingRenamesForAccount(pendingState, c.accountKey);
 *     // The next reconciliation round must propose NOTHING to push for this id —
 *     // no marker survived to push the stale name onto the new profile.
 *     const toRename = computeProfilesToRename(c.serverProfiles, recreatedLocalProfiles, pendingForAccount);
 *     const ok = Object.keys(pendingForAccount).length === 0 && toRename.length === 0;
 *     console.log(ok ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_STALE_RENAME_DISCARDED_ON_DELETE_RECREATE_CASES: Array<{
  name: string;
  profileId: string;
  accountKey: string;
  staleRenameName: string;
  recreatedProfileName: string;
  serverProfiles: ServerProfileRecord[];
}> = [
  {
    name: "Codex finding #3 — a rename pending at delete time never resurfaces to rename the profile later recreated under the same id",
    profileId: "family",
    accountKey: "userA",
    staleRenameName: "The Smiths (never confirmed, then deleted)",
    recreatedProfileName: "The Garcias",
    serverProfiles: [{ profileId: "family", name: "Family", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null }],
  },
  {
    name: "same guarantee when the recreated profile happens to be given the EXACT SAME display name as the stale rename — still nothing pending, still nothing to push, since the new create's own name flows through computeProfilesToAdopt/normal push, not a leftover marker",
    profileId: "family",
    accountKey: "userA",
    staleRenameName: "The Smiths",
    recreatedProfileName: "The Smiths",
    serverProfiles: [],
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
 * Pure — takes every input as a parameter. Generic over `T` (Codex finding
 * #1) purely so the SAME chunking logic batches both plain adopt candidates
 * and the richer `{ ...Profile, intent }` entries reconcileProfileRegistry
 * now also sends for rename pushes — no behavioral difference for either
 * shape.
 *
 * Run from Node:
 *   import { DEV_BATCH_PROFILES_FOR_ADOPTION_CASES, batchProfilesForAdoption } from "@/lib/profileRegistrySync";
 *   DEV_BATCH_PROFILES_FOR_ADOPTION_CASES.forEach(c => {
 *     const got = batchProfilesForAdoption(c.toAdopt);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function batchProfilesForAdoption<T>(toAdopt: T[]): T[][] {
  if (toAdopt.length === 0) return [];
  const batches: T[][] = [];
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
export async function sendAdoptionBatches<T>(
  batches: T[][],
  sendBatch: (batch: T[]) => Promise<void>,
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

// ===== RECONCILIATION-ROUND STALE-RUN GUARD (Codex finding #2) =====
//
// isRegistryRunCurrent above catches an IDENTITY transition (A -> B, or
// A -> signed-out) invalidating an in-flight round — but setRegistryIdentity
// is a deliberate NO-OP when the identity does not actually change (see its
// own doc: this is what lets a page re-render or remount under the SAME
// user without spuriously invalidating other in-flight work). That no-op is
// exactly the gap this closes: TWO overlapping reconcileProfileRegistry
// calls for the SAME account — e.g. the global SessionProviderWrapper guard
// and Settings' own page-local effect both firing around the same session
// resolution, or a rename immediately followed by another trigger before
// the first round's own network round-trips resolve — share the IDENTICAL
// captured epoch throughout, so isRegistryRunCurrent alone cannot tell an
// OLDER round apart from a NEWER one for the same identity. Without this,
// an older round's own stale `authoritativeServerProfiles` snapshot could
// resolve AFTER a newer round already applied a fresher one, and its own
// final pull-application step (applyServerRenames) would silently restore
// the older, already-superseded name locally.
//
// A plain, pure monotonic counter — NOT a revision/conflict engine, exactly
// like the identity epoch above: it answers only "has a NEWER round started
// since I began", never anything about what to merge.

/**
 * Pure staleness check: a round captured under `capturedRoundId` may still
 * act only while no NEWER round (`latestRoundId`) has started since —
 * mirrors isRegistryRunCurrent's own shape, one level down (round
 * sequencing rather than identity). A later round for a DIFFERENT identity
 * is already caught by isRegistryRunCurrent, so this check needs no
 * identity awareness of its own — it fires equally for a same-identity or
 * cross-identity newer round, which is harmless: either way, an OLDER round
 * has no business committing its own stale snapshot once ANY newer round
 * has begun.
 *
 * Run from Node:
 *   import { DEV_RECONCILIATION_ROUND_STALE_GUARD_CASES, isReconciliationRoundCurrent } from "@/lib/profileRegistrySync";
 *   DEV_RECONCILIATION_ROUND_STALE_GUARD_CASES.forEach(c => {
 *     const got = isReconciliationRoundCurrent(c.latestRoundId, c.capturedRoundId);
 *     console.log(got === c.expectedStillCurrent ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function isReconciliationRoundCurrent(latestRoundId: number, capturedRoundId: number): boolean {
  return capturedRoundId === latestRoundId;
}

export const DEV_RECONCILIATION_ROUND_STALE_GUARD_CASES: Array<{
  name: string;
  capturedRoundId: number;
  latestRoundId: number;
  expectedStillCurrent: boolean;
}> = [
  {
    name: "no newer round has started since this one began — still current",
    capturedRoundId: 1,
    latestRoundId: 1,
    expectedStillCurrent: true,
  },
  {
    name: "Codex finding #2 — a NEWER round (same or different identity) started after this one — this older round is stale",
    capturedRoundId: 1,
    latestRoundId: 2,
    expectedStillCurrent: false,
  },
  {
    name: "a round several generations behind the latest is still correctly stale",
    capturedRoundId: 1,
    latestRoundId: 5,
    expectedStillCurrent: false,
  },
];

/**
 * Codex finding #2 — composed end-to-end regression: two overlapping
 * SAME-ACCOUNT reconciliation rounds, where the OLDER round's own
 * confirmatory work resolves AFTER the NEWER round has already applied its
 * own (fresher) pull to the ONE shared local profile list. Proves the
 * older round's own stale snapshot is never applied once round-sequencing
 * marks it non-current — exercising the actual pull-application primitives
 * reconcileProfileRegistry itself calls (this module's own
 * selectServerRenamesToApply, profileStorage.ts's mergeProfileRenames), not
 * just the isolated isReconciliationRoundCurrent guard above.
 *
 * Run from Node:
 *   import { DEV_STALE_ROUND_NEVER_APPLIES_CASES, selectServerRenamesToApply, isReconciliationRoundCurrent } from "@/lib/profileRegistrySync";
 *   import { mergeProfileRenames } from "@/lib/profileStorage";
 *   DEV_STALE_ROUND_NEVER_APPLIES_CASES.forEach(c => {
 *     let profiles = c.initialProfiles;
 *
 *     // Round 1 starts (captures roundId 1) and computes its OWN
 *     // authoritative snapshot from whatever the server showed AT THAT TIME.
 *     const round1RoundId = 1;
 *
 *     // Round 2 starts (captures roundId 2 — now the latest) and runs to
 *     // completion FIRST, applying its own fresher snapshot to the shared list.
 *     const round2RoundId = 2;
 *     const latestRoundIdAfterRound2 = round2RoundId;
 *     const round2Pulls = selectServerRenamesToApply(c.round2AuthoritativeServerProfiles, profiles, new Set());
 *     profiles = mergeProfileRenames(profiles, round2Pulls);
 *     const nameAfterRound2 = profiles.find(p => p.id === c.profileId)?.name;
 *
 *     // Round 1 finally reaches its own final pull-application checkpoint —
 *     // but a newer round (round 2) has since started, so it must skip.
 *     const round1StillCurrent = isReconciliationRoundCurrent(latestRoundIdAfterRound2, round1RoundId);
 *     if (round1StillCurrent) {
 *       const round1Pulls = selectServerRenamesToApply(c.round1AuthoritativeServerProfiles, profiles, new Set());
 *       profiles = mergeProfileRenames(profiles, round1Pulls);
 *     }
 *     const nameAfterRound1Checkpoint = profiles.find(p => p.id === c.profileId)?.name;
 *
 *     const ok =
 *       nameAfterRound2 === c.expectedNameAfterRound2 &&
 *       round1StillCurrent === false &&
 *       nameAfterRound1Checkpoint === c.expectedNameAfterRound2; // unchanged — round 1's stale pull never applied
 *     console.log(ok ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_STALE_ROUND_NEVER_APPLIES_CASES: Array<{
  name: string;
  profileId: string;
  initialProfiles: Profile[];
  round1AuthoritativeServerProfiles: ServerProfileRecord[];
  round2AuthoritativeServerProfiles: ServerProfileRecord[];
  expectedNameAfterRound2: string;
}> = [
  {
    name: "Codex finding #2 — an older round's stale server-name snapshot never overwrites a newer round's already-applied fresher name",
    profileId: "default",
    initialProfiles: [{ id: "default", name: "Default" }],
    // Round 1's OWN view, captured before round 2 ever ran — already stale by the time round 1 gets to act.
    round1AuthoritativeServerProfiles: [
      { profileId: "default", name: "Renamed On Another Device (mid-flight)", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    // Round 2's fresher, later view — this is the name that must survive.
    round2AuthoritativeServerProfiles: [
      { profileId: "default", name: "Renamed Again, Even Newer", updatedAt: "2026-01-02T00:00:00.000Z", deletedAt: null },
    ],
    expectedNameAfterRound2: "Renamed Again, Even Newer",
  },
];

let latestReconciliationRoundId = 0;

/**
 * Starts a new reconciliation round: increments and returns the new
 * latest-round id, which reconcileProfileRegistry captures for the
 * lifetime of that one call. Called ONLY after the identity check already
 * passed (see reconcileProfileRegistry's own early `return` above it), so
 * a call that never even attempts a round (wrong/stale identity) can never
 * spuriously bump this counter and invalidate a DIFFERENT, legitimately
 * in-flight round for the current identity.
 */
function beginReconciliationRound(): number {
  latestReconciliationRoundId += 1;
  return latestReconciliationRoundId;
}

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
 * Codex finding #1 — a {id, name} pair tagged with the explicit INTENT
 * this push carries: `"adopt"` for a brand-new candidate
 * (computeProfilesToAdopt) that must be INSERT-ONLY server-side (never
 * overwrite an existing row, even a stale/delayed adopt retry — see
 * /api/sync/profiles's route doc), or `"rename"` for an id this account
 * already has an explicit, local pending-rename marker for
 * (computeProfilesToRename) and therefore deliberately intends to UPDATE.
 * The server no longer infers this from "is the row already there" — a
 * single conflict-free UPSERT could not otherwise tell "stale adopt retry
 * for an id someone else just renamed" apart from "a genuine intentional
 * rename", which is exactly what let an adoption silently overwrite an
 * unrelated name before this fix.
 */
type ProfilePushEntry = Profile & { intent: "adopt" | "rename" };

/**
 * Fire-and-forget push of a batch of intent-tagged {id, name, intent}
 * entries — SH.5: carries BOTH brand-new adoptions and rename updates for
 * already-known ids in one request; /api/sync/profiles's PUT runs each
 * intent through its OWN separate, differently-scoped query (see its own
 * route doc) rather than inferring intent from conflict state. Codex P1
 * follow-up (2nd round) — its outcome (success, non-2xx, a lost/malformed
 * response, or a thrown network error) is deliberately NEVER used to decide
 * ownership: reconcileProfileRegistry always re-confirms via a fresh,
 * authoritative GET afterward instead (see resolveAuthoritativeServerProfiles's
 * own doc), since a commit that reached the server but whose response never
 * reached this client must still be reflected, not treated as though it
 * never happened. Swallows all errors — best-effort, exactly like
 * scheduleSync()'s doPush() for planner sync.
 */
async function pushProfilesToAdopt(toAdopt: ProfilePushEntry[]): Promise<void> {
  await putProfiles(toAdopt);
}

/**
 * The raw PUT behind pushProfilesToAdopt. Resolves with the response's
 * `registered` ids, or null on any failure/empty batch. Reconciliation
 * rounds ignore the result (see pushProfilesToAdopt's own doc); only
 * pushNewProfileRegistration's display-only "Last synced" path reads it,
 * and even there only alongside a confirmatory GET.
 */
async function putProfiles(toAdopt: ProfilePushEntry[]): Promise<string[] | null> {
  if (toAdopt.length === 0) return null;
  try {
    const res = await fetch("/api/sync/profiles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profiles: toAdopt.map((p) => ({ profileId: p.id, name: p.name, intent: p.intent })),
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { registered?: unknown } | null;
    if (!data || !Array.isArray(data.registered)) return null;
    return data.registered.filter((id): id is string => typeof id === "string");
  } catch {
    // Best-effort — the confirmatory re-GET below determines what actually
    // committed, regardless of what happened to this request/response.
    return null;
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
 * round regardless of what any previous attempt did. Always tagged
 * `"adopt"` (Codex finding #1) — a brand-new profile has no pending-rename
 * marker of its own yet, so this is never a rename push.
 */
export async function pushNewProfileRegistration(profile: Profile, userId?: string): Promise<void> {
  const registered = await putProfiles([{ ...profile, intent: "adopt" }]);
  // SH.7B — a registration this PUT reports as newly inserted counts as
  // meaningful registry sync activity, but only once a fresh GET confirms
  // the row (never from the PUT response alone) and only if the identity
  // that started this is still the bound one.
  if (!userId || !registered || !registered.includes(profile.id)) return;
  const confirmed = await fetchServerProfiles();
  if (registryIdentityState.currentUserId !== userId || confirmed === null) return;
  if (confirmed.some((p) => !p.deletedAt && p.profileId === profile.id && p.name === profile.name)) {
    recordRegistrySynced(userId, [profile.id]);
  }
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
): Promise<void | Profile[]> {
  const locallyDeletedIds = readLocallyDeletedIds();
  return await mergeIntoLocal(selectActiveServerProfiles(authoritativeServerProfiles, locallyDeletedIds));
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

// ===== SH.7B REGISTRY "LAST SYNCED" PRESENTATION =====

/**
 * Same-tab event dispatched when a meaningful registry change is recorded
 * (recordRegistrySynced). A presentation-only signal for Settings' "Last
 * synced" row — deliberately separate from syncHelper.ts's
 * SYNC_STATE_CHANGED_EVENT, so registry activity never touches planner sync
 * state, status, or errors.
 */
export const PROFILE_REGISTRY_SYNCED_EVENT = "dwp:profileRegistrySynced";

/**
 * Display-only timestamp of the last MEANINGFUL registry change for a
 * profile. Qualified by account (unlike planner's profile-only
 * `dwp:sync:{profileId}:lastSyncedAt`), so it can't carry across accounts
 * sharing an id like `default` on one browser. Never read by any sync logic.
 */
export function registryLastSyncedKey(userId: string, profileId: string): string {
  return `dwp:registrySync:${userId}:${profileId}:lastSyncedAt`;
}

export function getRegistryLastSyncedAt(userId: string, profileId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(registryLastSyncedKey(userId, profileId));
  } catch {
    return null;
  }
}

function recordRegistrySynced(userId: string, profileIds: string[]): void {
  if (typeof window === "undefined" || profileIds.length === 0) return;
  const now = new Date().toISOString();
  try {
    for (const id of profileIds) localStorage.setItem(registryLastSyncedKey(userId, id), now);
    window.dispatchEvent(new CustomEvent(PROFILE_REGISTRY_SYNCED_EVENT));
  } catch {}
}

/**
 * Pure: the profile ids a round MEANINGFULLY changed — the only ones that
 * may refresh "Last synced". A request merely succeeding is never enough;
 * an id counts only when:
 *   - PUSHED (`pushed`, the adopt/rename entries this round sent): the
 *     authoritative re-GET now shows that exact name on an active row, and
 *     the round's initial GET did not (a new registration or a confirmed
 *     rename); or
 *   - DISCOVERED: absent from `localBefore`, present in `localAfter`, and an
 *     active authoritative server row; or
 *   - PULLED RENAME: in both lists with a different name, `localAfter`'s
 *     name equal to the authoritative server name.
 * A no-op round (everything already converged) returns []. Local deletion
 * never appears here: it produces no server-side change and no entry.
 *
 * Run from Node:
 *   import { DEV_SELECT_MEANINGFUL_REGISTRY_CHANGE_CASES, selectMeaningfulRegistryChangeIds } from "@/lib/profileRegistrySync";
 *   DEV_SELECT_MEANINGFUL_REGISTRY_CHANGE_CASES.forEach(c => {
 *     const got = selectMeaningfulRegistryChangeIds(c.initial, c.authoritative, c.pushed, c.localBefore, c.localAfter);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function selectMeaningfulRegistryChangeIds(
  initialServerProfiles: ServerProfileRecord[],
  authoritativeServerProfiles: ServerProfileRecord[],
  pushed: Profile[],
  localBefore: Profile[],
  localAfter: Profile[]
): string[] {
  const nameOf = (rows: ServerProfileRecord[]) =>
    new Map(rows.filter((p) => !p.deletedAt).map((p) => [p.profileId, p.name]));
  const initial = nameOf(initialServerProfiles);
  const authoritative = nameOf(authoritativeServerProfiles);
  const ids = new Set<string>();
  for (const p of pushed) {
    if (authoritative.get(p.id) === p.name && initial.get(p.id) !== p.name) ids.add(p.id);
  }
  const before = new Map(localBefore.map((p) => [p.id, p.name]));
  for (const p of localAfter) {
    const serverName = authoritative.get(p.id);
    if (serverName === undefined) continue;
    const beforeName = before.get(p.id);
    if (beforeName === undefined || (beforeName !== p.name && serverName === p.name)) ids.add(p.id);
  }
  return [...ids];
}

export const DEV_SELECT_MEANINGFUL_REGISTRY_CHANGE_CASES: Array<{
  name: string;
  initial: ServerProfileRecord[];
  authoritative: ServerProfileRecord[];
  pushed: Profile[];
  localBefore: Profile[];
  localAfter: Profile[];
  expected: string[];
}> = [
  {
    name: "no-op round — converged everywhere, nothing pushed or changed locally",
    initial: [{ profileId: "default", name: "Default", updatedAt: "x", deletedAt: null }],
    authoritative: [{ profileId: "default", name: "Default", updatedAt: "x", deletedAt: null }],
    pushed: [],
    localBefore: [{ id: "default", name: "Default" }],
    localAfter: [{ id: "default", name: "Default" }],
    expected: [],
  },
  {
    name: "confirmed new registration",
    initial: [],
    authoritative: [{ profileId: "mom", name: "Mom", updatedAt: "x", deletedAt: null }],
    pushed: [{ id: "mom", name: "Mom" }],
    localBefore: [{ id: "mom", name: "Mom" }],
    localAfter: [{ id: "mom", name: "Mom" }],
    expected: ["mom"],
  },
  {
    name: "push attempted but not confirmed by the re-GET — not meaningful",
    initial: [],
    authoritative: [],
    pushed: [{ id: "mom", name: "Mom" }],
    localBefore: [{ id: "mom", name: "Mom" }],
    localAfter: [{ id: "mom", name: "Mom" }],
    expected: [],
  },
  {
    name: "confirmed rename push",
    initial: [{ profileId: "default", name: "Default", updatedAt: "x", deletedAt: null }],
    authoritative: [{ profileId: "default", name: "Trip", updatedAt: "y", deletedAt: null }],
    pushed: [{ id: "default", name: "Trip" }],
    localBefore: [{ id: "default", name: "Trip" }],
    localAfter: [{ id: "default", name: "Trip" }],
    expected: ["default"],
  },
  {
    name: "remote profile discovered",
    initial: [{ profileId: "dad", name: "Dad", updatedAt: "x", deletedAt: null }],
    authoritative: [{ profileId: "dad", name: "Dad", updatedAt: "x", deletedAt: null }],
    pushed: [],
    localBefore: [{ id: "default", name: "Default" }],
    localAfter: [{ id: "default", name: "Default" }, { id: "dad", name: "Dad" }],
    expected: ["dad"],
  },
  {
    name: "remote rename pulled",
    initial: [{ profileId: "default", name: "Trip", updatedAt: "x", deletedAt: null }],
    authoritative: [{ profileId: "default", name: "Trip", updatedAt: "x", deletedAt: null }],
    pushed: [],
    localBefore: [{ id: "default", name: "Default" }],
    localAfter: [{ id: "default", name: "Trip" }],
    expected: ["default"],
  },
  {
    name: "local-only change with no server row (e.g. local delete) is never registry activity",
    initial: [],
    authoritative: [],
    pushed: [],
    localBefore: [{ id: "default", name: "Default" }, { id: "kid", name: "Kid" }],
    localAfter: [{ id: "default", name: "Default" }],
    expected: [],
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
  // Codex finding #2 — captured AFTER the identity check above, so a call
  // that never even starts a round (wrong/stale identity) can't spuriously
  // invalidate a different, legitimately in-flight round for the CURRENT
  // identity. Folded into the SAME `isCurrent()` every existing checkpoint
  // in this function already calls, so a newer round for this identity
  // (e.g. an overlapping trigger from a second mount point) stops this
  // older round at its very next checkpoint — including, critically, the
  // final pull-application step, which is what could otherwise restore an
  // already-superseded name locally. See isReconciliationRoundCurrent's own
  // doc for why this needs no identity awareness of its own.
  const capturedRoundId = beginReconciliationRound();
  const isCurrent = () =>
    isRegistryRunCurrent(registryIdentityState, userId, capturedEpoch) &&
    isReconciliationRoundCurrent(latestReconciliationRoundId, capturedRoundId);

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
  // Codex finding — ONE-TIME PRE-LEDGER RENAME BACKFILL, run BEFORE this
  // round ever reads `pendingRenames` for the normal push/pull decisions
  // below: an existing user's local custom name that predates
  // `dwp.profilePendingRenames` entirely has no marker to protect it from
  // selectServerRenamesToApply's own pull step (further down this
  // function) mistaking it for a stale copy of ANOTHER device's already-
  // pushed rename and silently overwriting it — see
  // computeRenameBackfillCandidates's own doc for the full rationale and
  // why the canonical `default` id needs its own bootstrap-name check.
  // Durably marks a pending-rename marker for genuine mismatches (so a
  // crash/interruption right after this still preserves the user's intent
  // for the NEXT round to retry), then re-reads `pendingRenames` fresh so
  // this SAME round's own toRename computation below immediately attempts
  // to push it, rather than waiting a full extra round-trip.
  //
  // Codex finding — migration completion is marked for EVERY eligible id
  // this round examines (`idsToMarkComplete`), not only the ones that
  // needed a pending marker. An already-converged, server-known id left
  // unmarked would remain indistinguishable from genuine pre-ledger local
  // intent forever, so a LATER legitimate remote rename of that same id
  // would be misread as this device's own stale customization and pushed
  // back over the newer name. Marking completion here — the first round
  // this id is ever eligible — ensures the one-time guard
  // (`alreadyBackfilledIds`) excludes it on every later round, so this
  // legacy backfill logic only ever fires during the actual upgrade
  // transition. See computeRenameBackfillCandidates's own doc for the full
  // rationale.
  const alreadyBackfilledIds = getRenameBackfilledIds(userId);
  const { toBackfillAsPending, idsToMarkComplete } = computeRenameBackfillCandidates(
    initialServerProfiles,
    localProfiles,
    getPendingProfileRenames(userId),
    alreadyBackfilledIds
  );
  for (const candidate of toBackfillAsPending) {
    if (!isCurrent()) return;
    await markProfileRenamePending(candidate.id, candidate.name, userId);
  }
  for (const id of idsToMarkComplete) {
    if (!isCurrent()) return;
    await markProfileRenameBackfilled(id, userId);
  }
  if (!isCurrent()) return;
  // Codex account-isolation fix — scoped to THIS round's own `userId`:
  // getPendingProfileRenames now returns only ids `userId` itself renamed,
  // never a different account's own pending rename recorded on a shared
  // browser (see profileStorage.ts's PendingRenamesByAccount doc). Read
  // fresh here (not reused from the backfill computation above) so it
  // reflects any marker the backfill pass just durably recorded.
  const pendingRenames = getPendingProfileRenames(userId);
  // Codex finding #1 — no ownedByOtherAccountIds argument: a rename target
  // is always already confirmed via `initialServerProfiles` (this round's
  // own user_id-scoped GET), which is unambiguous proof of THIS account's
  // ownership regardless of whether some OTHER account also, independently,
  // owns the identical literal id — see computeProfilesToRename's own doc.
  const toRename = filterAdoptableProfiles(
    computeProfilesToRename(initialServerProfiles, localProfiles, pendingRenames)
  );
  // Codex finding #1 — each entry is tagged with its own explicit intent so
  // /api/sync/profiles's PUT can run adopt candidates through an
  // INSERT-ONLY query and rename candidates through a separate, explicit
  // UPDATE query, rather than inferring intent server-side from conflict
  // state (which let a stale/delayed adopt retry silently overwrite an
  // unrelated existing name — see the route's own doc).
  const toPush: ProfilePushEntry[] = [
    ...toAdopt.map((p) => ({ ...p, intent: "adopt" as const })),
    ...toRename.map((p) => ({ ...p, intent: "rename" as const })),
  ];
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
  // (`userId`'s) own pending-rename marker for every id whose name
  // `authoritativeServerProfiles` already confirms. An id whose push
  // failed, or whose reconfirmed name still doesn't match, simply keeps
  // its marker — computeProfilesToRename will propose it again on the
  // NEXT round, exactly like an adoption candidate that failed to
  // register keeps getting proposed via computeProfilesToAdopt's own
  // fresh recomputation.
  // Codex finding #2 — checked against the FULL `pendingRenames` set
  // (selectConfirmedPendingRenames), not just `toRename` (the ids THIS
  // round decided to push): an id whose PUT committed in a PREVIOUS round
  // but whose own confirmatory re-GET then failed can leave its marker
  // standing even though the write genuinely landed; computeProfilesToRename
  // correctly treats it as already-converged and pushes nothing for it —
  // "nothing to push" is not the same as "already cleared", so it must
  // still be checked here even when it was never in `toRename` this round.
  // Codex account-isolation fix — scoping the clear to `userId` means this
  // round can only ever clear ITS OWN pending rename, never a different
  // account's (see profileStorage.ts's clearPendingRenameForAccount doc).
  for (const confirmed of selectConfirmedPendingRenames(pendingRenames, authoritativeServerProfiles)) {
    await clearProfileRenamePending(confirmed.id, confirmed.name, userId);
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
  const localBeforeDiscovery = getProfiles();
  const discoveredMerge = await commitDiscoveredProfiles(
    authoritativeServerProfiles,
    () => getLocallyDeletedProfileIds(userId),
    adoptServerProfiles
  );
  // SH.7B — meaningful-change ids, accumulated across the round's three
  // effects (confirmed push, discovery, pulled rename); see
  // selectMeaningfulRegistryChangeIds. Recorded only at the end, and only
  // if this round is still current.
  const changedIds = new Set(
    selectMeaningfulRegistryChangeIds(
      initialServerProfiles,
      authoritativeServerProfiles,
      toPush,
      localBeforeDiscovery,
      Array.isArray(discoveredMerge) ? discoveredMerge : localBeforeDiscovery
    )
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
  // Codex finding on d7cfaff — this step previously matched against the RAW
  // shared `getProfiles()` list, unfiltered by this account's own
  // local-deletion markers, unlike every other push/adopt computation in
  // this round (`localProfiles` above is already filtered via
  // filterVisibleProfiles). `dwp.profiles` is one shared array across
  // accounts on the same browser — filterVisibleProfiles's own doc
  // describes exactly why an id A deleted can still legitimately sit in
  // that shared array, retained there because a CO-OWNING account B never
  // deleted it. Without filtering here, this account's own server-scoped
  // rename for that id (an id THIS account deleted, so has no business
  // touching) would still match it by id in `getProfiles()` and get pushed
  // through `applyServerRenames` into the ONE shared entry — contaminating
  // B's retained, still-visible local copy with a rename intent that
  // belongs only to A's own (deleted, hidden-from-A) relationship to that
  // id. Filtering through this account's own local-deletion markers, freshly
  // re-read right here (mirroring `pendingRenameIdsAtCommit` and
  // `commitDiscoveredProfiles`'s own re-read-at-commit discipline, so a
  // deletion made while this round's earlier awaits were in flight is
  // honored too), makes this pull step see exactly the same "this account's
  // own effective local view" as every other computation in this round —
  // an id A deleted is simply absent from A's own rename-pull candidates,
  // exactly as it already is absent from A's own adopt/rename-push
  // candidates above.
  const visibleLocalProfilesAtCommit = filterVisibleProfiles(getProfiles(), getLocallyDeletedProfileIds(userId));
  const renamesToApply = selectServerRenamesToApply(
    authoritativeServerProfiles,
    visibleLocalProfilesAtCommit,
    pendingRenameIdsAtCommit
  );
  const renamedMerge = await applyServerRenames(renamesToApply);
  for (const id of selectMeaningfulRegistryChangeIds(
    initialServerProfiles,
    authoritativeServerProfiles,
    [],
    visibleLocalProfilesAtCommit,
    renamedMerge
  )) {
    changedIds.add(id);
  }
  // A no-op round (nothing pushed-and-confirmed, discovered, or renamed)
  // leaves changedIds empty and never refreshes "Last synced".
  if (!isCurrent()) return;
  recordRegistrySynced(userId, [...changedIds]);
}

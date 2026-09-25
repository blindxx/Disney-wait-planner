/**
 * profileStorage.ts — Phase 7.5 Local Profiles
 *
 * Lightweight profile namespace layer on top of existing localStorage keys.
 * Profiles are device-local only and do not affect cloud sync.
 *
 * Global keys (never namespaced):
 *   dwp.activeProfile  — currently active profile id
 *   dwp.profiles       — JSON array of Profile objects
 *
 * Per-profile namespaced keys (dwp:{profileId}:{baseKey}):
 *   dwp:{id}:plans          — plans data (mirrors legacy dwp.myPlans)
 *   dwp:{id}:lightning      — lightning data (mirrors legacy dwp.lightning.v1)
 *   dwp:{id}:selectedResort — active resort (mirrors legacy dwp.selectedResort)
 *   dwp:{id}:selectedPark   — active park (mirrors legacy dwp.selectedPark)
 */

import { purgeProfileSyncState } from "./syncHelper";
import { sanitizeProfileName } from "./syncIdentity";

// ===== TYPES =====

export type Profile = {
  id: string;
  name: string;
};

// ===== CONSTANTS =====

const ACTIVE_PROFILE_KEY = "dwp.activeProfile";
const PROFILES_LIST_KEY = "dwp.profiles";

/**
 * SH.4.1 (Codex follow-up rounds) — durable, per-`(accountKey, profileId)`
 * REGISTRY PROVENANCE, entirely separate from `dwp.profiles` (what a device
 * shows) and from syncHelper.ts's planner-content ownership marker
 * (`getLocalContentOwner`/`setLocalContentOwner`, which governs PLANNER DATA
 * for a shared browser, not this list). This is the minimum durable state
 * needed to answer two questions no single reconciliation round can answer
 * from the network response alone:
 *   - `owned`: has THIS account's reconciliation confirmed that this
 *     profile id belongs to it (per the server's own GET/PUT response)?
 *   - `locallyDeleted`: did THIS account's session (or no session at all —
 *     see UNOWNED_ACCOUNT_KEY below) explicitly Delete this id
 *     (deleteProfile below) on this device? A device-local COMPATIBILITY
 *     SHIM ONLY, not a real tombstone — it does not touch the server's
 *     `user_profiles`/`user_planner` rows, so it cannot help a DIFFERENT
 *     DEVICE learn about the deletion. It exists purely so THIS device's
 *     own next registry reconciliation round doesn't immediately
 *     rediscover the id it was just told to forget, until SH.4.3
 *     implements real server-side tombstones this device can also observe.
 *
 * Codex P1 follow-up (3rd round) — keyed by `(profileId, accountKey)`, NOT
 * by profileId alone: two different accounts can each independently record
 * BOTH facts for the identical literal grandfathered profile id, without
 * either one affecting the other. This replaces the prior shape
 * (`{ [profileId]: { owner?: string; locallyDeleted?: boolean } }`, a
 * single global slot per id), whose "owner" field could only ever name ONE
 * account — a genuine second account with its own legitimate, distinct
 * history under the same local id could never get its own ownership
 * record, AND (Codex P1, this round) that same single-slot design broke
 * delete suppression for that second account entirely, since a
 * `locallyDeleted` flag recorded under one account's ownership was then
 * unconditionally cross-referenced against whichever single owner
 * happened to be recorded, permanently — the exact bug this reshaping
 * fixes.
 *
 * `accountKey` is either a real authenticated userId, or the sentinel
 * UNOWNED_ACCOUNT_KEY for a fact recorded while no account was
 * authenticated (or migrated from the old single-slot shape's genuinely
 * unowned case — see migrateProfileRegistryState) — an ambiguous case with
 * no specific account to scope to, so it is treated the ORIGINAL way: it
 * applies for whichever account reconciles the id next, exactly like a
 * pre-SH.4 legacy profile with no owner at all always has.
 *
 * Deliberately a flat, unbounded-growth-tolerant map (bounded in practice by
 * however many (profile id, account) pairs this device has ever touched —
 * never pruned, no revision/ledger, no conflict resolution) — this is
 * provenance metadata, not another planner-style sync engine.
 */
const PROFILE_REGISTRY_STATE_KEY = "dwp.profileRegistryState";

/** Sentinel account key for a provenance fact recorded with no authenticated account. */
export const UNOWNED_ACCOUNT_KEY = "__unowned__";

export type ProfileRegistryAccountState = {
  owned?: boolean;
  locallyDeleted?: boolean;
};

/** `{ [profileId]: { [accountKey]: ProfileRegistryAccountState } }` */
export type ProfileRegistryState = Record<string, Record<string, ProfileRegistryAccountState>>;

/** Structural shape of a value under the OLD (pre-3rd-round) single-slot-per-id map. */
type LegacyProfileRegistryEntry = { owner?: string; locallyDeleted?: boolean };

function isLegacyEntry(value: unknown): value is LegacyProfileRegistryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  // A NEW-shape value is an account map: every one of ITS OWN values is
  // itself an object, never the literal keys "owner"/"locallyDeleted"
  // holding a plain string/boolean. Realistic authenticated userIds (an
  // adapter-issued numeric id, or an email address) can never collide with
  // either literal key name, so this structural check reliably tells the
  // two shapes apart.
  const ownerIsScalar = v.owner === undefined || typeof v.owner === "string";
  const deletedIsScalar = v.locallyDeleted === undefined || typeof v.locallyDeleted === "boolean";
  const hasAnyLegacyField = v.owner !== undefined || v.locallyDeleted !== undefined;
  return hasAnyLegacyField && ownerIsScalar && deletedIsScalar;
}

/**
 * Migrates whatever shape is currently stored under PROFILE_REGISTRY_STATE_KEY
 * into the current per-`(profileId, accountKey)` shape — READ-TIME
 * normalization (mirrors this module's own bootstrapProfiles() legacy
 * migration pattern), so existing Preview/production state from either
 * pre-SH.4.1 (no key at all) or the prior single-slot-per-id round is read
 * safely rather than stranded or misinterpreted. A legacy entry's `owner`
 * (if any) becomes that SAME account's own `owned: true` fact; a legacy
 * entry with NO owner (genuinely unowned/ambiguous) folds into
 * UNOWNED_ACCOUNT_KEY, preserving the original "applies to whoever
 * reconciles it next" behavior for that unambiguous case. Already-new-shape
 * or unrecognized/malformed values pass through (re-validated field by
 * field so a corrupted nested value can't crash a later read) or are
 * dropped, matching this module's existing fail-safe philosophy elsewhere.
 * Exported for direct DEV testing; not otherwise expected to be called
 * outside readProfileRegistryState below.
 *
 * Run from Node:
 *   import { DEV_MIGRATE_PROFILE_REGISTRY_STATE_CASES, migrateProfileRegistryState } from "@/lib/profileStorage";
 *   DEV_MIGRATE_PROFILE_REGISTRY_STATE_CASES.forEach(c => {
 *     const got = migrateProfileRegistryState(c.input);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function migrateProfileRegistryState(input: Record<string, unknown>): ProfileRegistryState {
  const migrated: ProfileRegistryState = {};
  for (const [profileId, value] of Object.entries(input)) {
    if (isLegacyEntry(value)) {
      const key = value.owner ?? UNOWNED_ACCOUNT_KEY;
      const entry: ProfileRegistryAccountState = {};
      if (value.owner) entry.owned = true;
      if (value.locallyDeleted) entry.locallyDeleted = true;
      migrated[profileId] = { [key]: entry };
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue; // malformed — drop
    const byAccount: Record<string, ProfileRegistryAccountState> = {};
    for (const [accountKey, accountValue] of Object.entries(value as Record<string, unknown>)) {
      if (!accountValue || typeof accountValue !== "object" || Array.isArray(accountValue)) continue;
      const v = accountValue as Record<string, unknown>;
      const entry: ProfileRegistryAccountState = {};
      if (v.owned === true) entry.owned = true;
      if (v.locallyDeleted === true) entry.locallyDeleted = true;
      if (Object.keys(entry).length > 0) byAccount[accountKey] = entry;
    }
    if (Object.keys(byAccount).length > 0) migrated[profileId] = byAccount;
  }
  return migrated;
}

export const DEV_MIGRATE_PROFILE_REGISTRY_STATE_CASES: Array<{
  name: string;
  input: Record<string, unknown>;
  expected: ProfileRegistryState;
}> = [
  {
    name: "legacy shape with owner + locallyDeleted — preserved under that account's own entry",
    input: { family: { owner: "userA", locallyDeleted: true } },
    expected: { family: { userA: { owned: true, locallyDeleted: true } } },
  },
  {
    name: "legacy shape with only locallyDeleted (genuinely unowned) — folds into the shared unowned bucket",
    input: { mom: { locallyDeleted: true } },
    expected: { mom: { [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true } } },
  },
  {
    name: "legacy shape with only owner (no deletion) — preserved as that account's owned fact",
    input: { mom: { owner: "userA" } },
    expected: { mom: { userA: { owned: true } } },
  },
  {
    name: "already new-shape input — passes through unchanged (idempotent)",
    input: { family: { userA: { owned: true }, userB: { locallyDeleted: true } } },
    expected: { family: { userA: { owned: true }, userB: { locallyDeleted: true } } },
  },
  {
    name: "empty input — empty result",
    input: {},
    expected: {},
  },
  {
    name: "malformed entry (not an object) — dropped, not crashed on",
    input: { broken: "not-an-object" as unknown as Record<string, unknown> },
    expected: {},
  },
];

function readProfileRegistryState(): ProfileRegistryState {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(PROFILE_REGISTRY_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return migrateProfileRegistryState(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

function writeProfileRegistryState(state: ProfileRegistryState): void {
  try {
    localStorage.setItem(PROFILE_REGISTRY_STATE_KEY, JSON.stringify(state));
  } catch {}
}

/**
 * Pure state transition: durably associate `profileId` with `ownerUserId`'s
 * account within `state`, returning the updated state (the SAME object
 * reference when already recorded — idempotent, and lets callers skip an
 * unnecessary write). Codex P1 follow-up (3rd round) — writes ONLY to
 * `state[profileId][ownerUserId]`, never touching any OTHER account's own
 * entry for the same profileId — this is what lets two different accounts
 * each independently own the identical literal id.
 *
 * Run from Node:
 *   import { DEV_APPLY_PROFILE_OWNER_STAMP_CASES, applyProfileOwnerStamp } from "@/lib/profileStorage";
 *   DEV_APPLY_PROFILE_OWNER_STAMP_CASES.forEach(c => {
 *     let state = c.initialState;
 *     for (const step of c.steps) state = applyProfileOwnerStamp(state, step.profileId, step.ownerUserId);
 *     console.log(JSON.stringify(state) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function applyProfileOwnerStamp(
  state: ProfileRegistryState,
  profileId: string,
  ownerUserId: string
): ProfileRegistryState {
  if (state[profileId]?.[ownerUserId]?.owned) return state;
  return {
    ...state,
    [profileId]: {
      ...state[profileId],
      [ownerUserId]: { ...state[profileId]?.[ownerUserId], owned: true },
    },
  };
}

export const DEV_APPLY_PROFILE_OWNER_STAMP_CASES: Array<{
  name: string;
  initialState: ProfileRegistryState;
  steps: Array<{ profileId: string; ownerUserId: string }>;
  expected: ProfileRegistryState;
}> = [
  {
    name: "authoritative server discovery stamps (userId, profileId) correctly",
    initialState: {},
    steps: [{ profileId: "family", ownerUserId: "userA" }],
    expected: { family: { userA: { owned: true } } },
  },
  {
    name: "Codex P1 follow-up #1 — A and B can both independently own the identical literal grandfathered id",
    initialState: {},
    steps: [
      { profileId: "family", ownerUserId: "userA" },
      { profileId: "family", ownerUserId: "userB" },
    ],
    expected: { family: { userA: { owned: true }, userB: { owned: true } } },
  },
  {
    name: "re-stamping the same (profileId, userId) pair is idempotent and never disturbs another account's own entry",
    initialState: { family: { userA: { owned: true }, userB: { owned: true, locallyDeleted: true } } },
    steps: [{ profileId: "family", ownerUserId: "userA" }],
    expected: { family: { userA: { owned: true }, userB: { owned: true, locallyDeleted: true } } },
  },
];

/**
 * Durably associate `profileId` with `ownerUserId`'s account — see
 * applyProfileOwnerStamp's own doc for the pure transition this wraps.
 * Called by profileRegistrySync.ts's reconciliation orchestrator once a
 * round has confirmed (via an authoritative GET) that an id belongs to the
 * current account.
 */
export function markProfileOwner(profileId: string, ownerUserId: string): void {
  const state = readProfileRegistryState();
  const updated = applyProfileOwnerStamp(state, profileId, ownerUserId);
  if (updated !== state) writeProfileRegistryState(updated);
}

/**
 * Pure state transition: mark `profileId` as explicitly, locally deleted
 * under `accountKey` (a real userId, or UNOWNED_ACCOUNT_KEY when no account
 * was authenticated at delete time) within `state`, returning the updated
 * state. Never touches any OTHER account's own entry for the same
 * profileId — see this module's own doc above for why that is exactly the
 * fix for account A's delete suppressing account B's distinct same-id
 * profile.
 */
export function applyLocalDeletionMarker(
  state: ProfileRegistryState,
  profileId: string,
  accountKey: string
): ProfileRegistryState {
  return {
    ...state,
    [profileId]: {
      ...state[profileId],
      [accountKey]: { ...state[profileId]?.[accountKey], locallyDeleted: true },
    },
  };
}

/**
 * Pure state transition: clear ONLY `accountKey`'s own local-deletion
 * marker for `profileId` (a real userId, or UNOWNED_ACCOUNT_KEY when no
 * account is authenticated), preserving that same account's `owned` fact if
 * any, and leaving EVERY OTHER account's entry for the identical
 * `profileId` completely untouched. Called when this exact id is
 * explicitly (re)created (createProfile below) — a deliberate new Create is
 * THAT account's (or, when signed out, the shared unowned bucket's) own
 * signal that the id should be eligible for discovery/adoption again for
 * IT specifically.
 *
 * Codex P1 follow-up (5th round) — previously this cleared EVERY account's
 * marker for the id at once: if B had locally deleted "family" and A later
 * created A's own "family" (the same literal id, since normalizeId() is
 * deterministic), A's creation would ALSO silently clear B's unrelated
 * suppression, resurrecting "family" for B's next reconciliation even
 * though B never asked for that. Scoping the clear to exactly the creating
 * account is the fix — mirrors applyLocalDeletionMarker's own
 * single-account write above.
 */
export function clearLocalDeletionMarkerForAccount(
  state: ProfileRegistryState,
  profileId: string,
  accountKey: string
): ProfileRegistryState {
  const entry = state[profileId]?.[accountKey];
  if (!entry?.locallyDeleted) return state;
  const byAccount = { ...state[profileId] };
  if (entry.owned) {
    byAccount[accountKey] = { owned: true };
  } else {
    delete byAccount[accountKey];
  }
  const next = { ...state };
  if (Object.keys(byAccount).length === 0) {
    delete next[profileId];
  } else {
    next[profileId] = byAccount;
  }
  return next;
}

export const DEV_CLEAR_LOCAL_DELETION_MARKER_FOR_ACCOUNT_CASES: Array<{
  name: string;
  state: ProfileRegistryState;
  profileId: string;
  accountKey: string;
  expected: ProfileRegistryState;
}> = [
  {
    name: "recreate clears the creating account's own deletion marker, preserving its owned fact",
    state: { family: { userA: { owned: true, locallyDeleted: true } } },
    profileId: "family",
    accountKey: "userA",
    expected: { family: { userA: { owned: true } } },
  },
  {
    name: "Codex P1 follow-up (5th round) — A recreating 'family' clears ONLY A's marker; B's independent suppression for the identical literal id survives untouched",
    state: {
      family: {
        userA: { owned: true, locallyDeleted: true },
        userB: { owned: true, locallyDeleted: true },
      },
    },
    profileId: "family",
    accountKey: "userA",
    expected: {
      family: {
        userA: { owned: true },
        userB: { owned: true, locallyDeleted: true },
      },
    },
  },
  {
    name: "signed-out/unowned creation clears only the shared unowned sentinel's marker, never a real account's",
    state: {
      family: {
        [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true },
        userA: { owned: true, locallyDeleted: true },
      },
    },
    profileId: "family",
    accountKey: UNOWNED_ACCOUNT_KEY,
    expected: {
      family: {
        userA: { owned: true, locallyDeleted: true },
      },
    },
  },
  {
    name: "no deletion marker present for this account — state returned unchanged",
    state: { family: { userA: { owned: true } } },
    profileId: "family",
    accountKey: "userA",
    expected: { family: { userA: { owned: true } } },
  },
  {
    name: "unknown profileId — state returned unchanged",
    state: {},
    profileId: "family",
    accountKey: "userA",
    expected: {},
  },
];

function markProfileLocallyDeleted(profileId: string, accountKey: string): void {
  const state = readProfileRegistryState();
  writeProfileRegistryState(applyLocalDeletionMarker(state, profileId, accountKey));
}

function clearLocalDeletionMarker(profileId: string, accountKey: string): void {
  const state = readProfileRegistryState();
  const updated = clearLocalDeletionMarkerForAccount(state, profileId, accountKey);
  if (updated !== state) writeProfileRegistryState(updated);
}

/**
 * Pure filter: given the full per-`(profileId, accountKey)` provenance
 * state and the CURRENT reconciling account, return the ids whose
 * local-delete suppression applies to that account — ACCOUNT-SCOPED: an id
 * is suppressed for `currentOwnerUserId` only when THAT account's own entry
 * says `locallyDeleted`, or the shared UNOWNED_ACCOUNT_KEY entry does (a
 * genuinely ambiguous deletion — with no account, or predating this fix's
 * migration — safe to suppress for whoever reconciles it next, matching
 * the ORIGINAL behavior for that unambiguous case). A DIFFERENT account's
 * OWN deletion of the identical literal id is never consulted here — that
 * is exactly what stops account A's delete of a grandfathered id from
 * hiding account B's own, distinct profile under that same literal id on a
 * shared browser. Pure — takes the state as a parameter, so it stays
 * directly DEV-testable without a browser/localStorage.
 *
 * Run from Node:
 *   import { DEV_SELECT_LOCALLY_DELETED_FOR_ACCOUNT_CASES, selectLocallyDeletedIdsForAccount } from "@/lib/profileStorage";
 *   DEV_SELECT_LOCALLY_DELETED_FOR_ACCOUNT_CASES.forEach(c => {
 *     const got = [...selectLocallyDeletedIdsForAccount(c.state, c.currentOwnerUserId)].sort();
 *     console.log(JSON.stringify(got) === JSON.stringify([...c.expected].sort()) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function selectLocallyDeletedIdsForAccount(
  state: ProfileRegistryState,
  currentOwnerUserId: string
): Set<string> {
  const ids = new Set<string>();
  for (const [id, byAccount] of Object.entries(state)) {
    const mine = byAccount[currentOwnerUserId];
    const unowned = byAccount[UNOWNED_ACCOUNT_KEY];
    if (mine?.locallyDeleted || unowned?.locallyDeleted) {
      ids.add(id);
    }
  }
  return ids;
}

export const DEV_SELECT_LOCALLY_DELETED_FOR_ACCOUNT_CASES: Array<{
  name: string;
  state: ProfileRegistryState;
  currentOwnerUserId: string;
  expected: string[];
}> = [
  {
    name: "genuinely unowned legacy id, locally deleted (no account) — suppressed for whoever reconciles it (unchanged original behavior)",
    state: { mom: { [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true } } },
    currentOwnerUserId: "userA",
    expected: ["mom"],
  },
  {
    name: "A deletes A's own 'family' — A's OWN reconciliation still suppresses it",
    state: { family: { userA: { owned: true, locallyDeleted: true } } },
    currentOwnerUserId: "userA",
    expected: ["family"],
  },
  {
    name: "Codex P1 follow-up (3rd round) — A deletes A's own 'family'; B's reconciliation (same grandfathered id, independent account) is NOT suppressed",
    state: { family: { userA: { owned: true, locallyDeleted: true } } },
    currentOwnerUserId: "userB",
    expected: [],
  },
  {
    name: "Codex P1 follow-up (3rd round) — B independently deletes B's own 'family'; A's reconciliation is NOT suppressed",
    state: { family: { userB: { owned: true, locallyDeleted: true } } },
    currentOwnerUserId: "userA",
    expected: [],
  },
  {
    name: "A and B have both independently deleted their own distinct 'family' — each suppresses only for themselves",
    state: {
      family: {
        userA: { owned: true, locallyDeleted: true },
        userB: { owned: true, locallyDeleted: true },
      },
    },
    currentOwnerUserId: "userA",
    expected: ["family"],
  },
  {
    name: "owned but not locally deleted — never suppressed regardless of account",
    state: { mom: { userA: { owned: true } } },
    currentOwnerUserId: "userA",
    expected: [],
  },
  {
    name: "empty state — nothing suppressed",
    state: {},
    currentOwnerUserId: "userA",
    expected: [],
  },
];

/**
 * Bulk read of every profile id whose local-delete suppression applies to
 * `currentOwnerUserId` — see selectLocallyDeletedIdsForAccount's own doc for
 * the account-scoping rationale. Pass this straight into
 * profileRegistrySync.ts's selectActiveServerProfiles, which treats it as
 * plain input data.
 */
export function getLocallyDeletedProfileIds(currentOwnerUserId: string): Set<string> {
  return selectLocallyDeletedIdsForAccount(readProfileRegistryState(), currentOwnerUserId);
}

/**
 * Pure filter: hide any profile whose id is in `locallyDeletedIds` from
 * `profiles`, WITHOUT removing it from `profiles` itself — callers pass the
 * result on for display, never write it back. Codex P1 follow-up (4th
 * round) — account-scoped deletion previously only ever gated what
 * REJOINED `dwp.profiles` during reconciliation (selectActiveServerProfiles/
 * adoptServerProfiles); it did nothing for an id ALREADY sitting in the
 * shared list. Concretely: A deletes "family" (removed from `dwp.profiles`,
 * marked locally deleted for A); B later discovers B's own, distinct
 * "family" and adoptServerProfiles adds `{id:"family",...}` BACK into the
 * one shared `dwp.profiles` array; when A returns, that entry is already
 * present, so the additive-merge guard in adoptServerProfiles/
 * mergeProfilesAdditive (which only ever prevents ADDING a duplicate) never
 * gets a chance to keep it hidden from A — nothing previously re-derived
 * A's EFFECTIVE list from the raw stored one. This filter is that missing
 * step. It must never be used to justify writing a filtered list back to
 * `dwp.profiles` — that would physically delete B's entry out from under
 * B, which is exactly what this fix must not do.
 *
 * Run from Node:
 *   import { DEV_FILTER_VISIBLE_PROFILES_CASES, filterVisibleProfiles } from "@/lib/profileStorage";
 *   DEV_FILTER_VISIBLE_PROFILES_CASES.forEach(c => {
 *     const got = filterVisibleProfiles(c.profiles, c.locallyDeletedIds);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function filterVisibleProfiles(profiles: Profile[], locallyDeletedIds: ReadonlySet<string>): Profile[] {
  if (locallyDeletedIds.size === 0) return profiles;
  return profiles.filter((p) => !locallyDeletedIds.has(p.id));
}

export const DEV_FILTER_VISIBLE_PROFILES_CASES: Array<{
  name: string;
  profiles: Profile[];
  locallyDeletedIds: Set<string>;
  expected: Profile[];
}> = [
  {
    name: "no locally-deleted ids — list returned unchanged (same reference, no copy needed)",
    profiles: [
      { id: "default", name: "Default" },
      { id: "family", name: "Family" },
    ],
    locallyDeletedIds: new Set(),
    expected: [
      { id: "default", name: "Default" },
      { id: "family", name: "Family" },
    ],
  },
  {
    name: "Codex P1 follow-up (4th round) — A's deleted 'family' is hidden even though it is already present in the shared list (e.g. B re-added it via discovery)",
    profiles: [
      { id: "default", name: "Default" },
      { id: "family", name: "Family" },
    ],
    locallyDeletedIds: new Set(["family"]),
    expected: [{ id: "default", name: "Default" }],
  },
  {
    name: "an id not present in the list is simply absent from the result — filtering never adds anything",
    profiles: [{ id: "default", name: "Default" }],
    locallyDeletedIds: new Set(["family"]),
    expected: [{ id: "default", name: "Default" }],
  },
];

/**
 * Returns the EFFECTIVE profile list for `currentOwnerUserId` (a real
 * userId, or UNOWNED_ACCOUNT_KEY when signed out): every profile currently
 * in the shared local `dwp.profiles` list, except an id THIS account has
 * explicitly, locally deleted (getLocallyDeletedProfileIds/
 * filterVisibleProfiles above). This is a READ-ONLY, per-render view — it
 * never writes to `dwp.profiles`, so the underlying shared list (and
 * therefore any OTHER account's own same-id profile) is completely
 * unaffected; only what THIS call returns for display is filtered. Callers
 * displaying the profile picker (settings/page.tsx) should call this
 * instead of getProfiles() directly whenever an authenticated identity (or
 * its signed-out equivalent, UNOWNED_ACCOUNT_KEY) is known.
 */
export function getVisibleProfiles(currentOwnerUserId: string): Profile[] {
  return filterVisibleProfiles(getProfiles(), getLocallyDeletedProfileIds(currentOwnerUserId));
}

const DEFAULT_PROFILE: Profile = { id: "default", name: "Default" };

/** Legacy single-user keys that get migrated into the Default namespace on first bootstrap. */
const LEGACY_KEY_MAP: Record<string, string> = {
  plans: "dwp.myPlans",
  lightning: "dwp.lightning.v1",
  selectedResort: "dwp.selectedResort",
  selectedPark: "dwp.selectedPark",
};

// ===== NAMESPACED KEY BUILDER =====

/**
 * Build the namespaced localStorage key for a given profile and base key.
 * Example: buildNamespacedKey("lindsay", "plans") → "dwp:lindsay:plans"
 */
export function buildNamespacedKey(profileId: string, baseKey: string): string {
  return `dwp:${profileId}:${baseKey}`;
}

// ===== PROFILE LIST HELPERS =====

/**
 * Read the profiles list.
 * - On the server (typeof window === "undefined"), returns [DEFAULT_PROFILE].
 * - In the browser, reads from localStorage and returns [] on error or invalid data.
 */
function readProfiles(): Profile[] {
  if (typeof window === "undefined") return [DEFAULT_PROFILE];
  try {
    const raw = localStorage.getItem(PROFILES_LIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return (parsed as Profile[]).filter(
        (p) => p && typeof p.id === "string" && typeof p.name === "string"
      );
    }
    return [];
  } catch {
    return [];
  }
}

/** Persist the profiles list to localStorage. */
function writeProfiles(profiles: Profile[]): void {
  try {
    localStorage.setItem(PROFILES_LIST_KEY, JSON.stringify(profiles));
  } catch {}
}

/**
 * Returns the current profiles list.
 * Always includes at least the Default profile.
 */
export function getProfiles(): Profile[] {
  const profiles = readProfiles();
  // Guarantee Default always appears
  if (!profiles.some((p) => p.id === "default")) {
    const withDefault = [DEFAULT_PROFILE, ...profiles];
    writeProfiles(withDefault);
    return withDefault;
  }
  return profiles;
}

// ===== ACTIVE PROFILE =====

/**
 * Returns the currently active profile id.
 * Falls back to "default" if no value is set or the stored id is invalid.
 */
export function getActiveProfileId(): string {
  if (typeof window === "undefined") return "default";
  try {
    const stored = localStorage.getItem(ACTIVE_PROFILE_KEY);
    const fallback = "default";
    if (!stored) return fallback;
    const profiles = getProfiles();
    return profiles.some((p) => p.id === stored) ? stored : fallback;
  } catch {
    return "default";
  }
}

/** Persist the active profile id. */
export function setActiveProfileId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_PROFILE_KEY, id);
  } catch {}
}

/**
 * Pure decision: is `activeId` visible in `visibleProfiles`? If so, keep it
 * unchanged; otherwise fall back to "default" — the SAME fallback
 * getActiveProfileId() already uses for its own raw-list validation
 * ("default" can never be deleted, so it is always present in ANY
 * account's effective visible list — see deleteProfile's own
 * `id === "default"` guard — making this a safe, unconditional fallback,
 * never a dead end).
 *
 * Codex P1 follow-up (5th round) — this is deliberately a SEPARATE decision
 * from getActiveProfileId()'s own (which validates against the RAW,
 * unfiltered `dwp.profiles` and remains parameterless/account-agnostic,
 * since it is called from many pages — plans/lightning/tom/wait-times —
 * with no account context of their own; see this module's own doc and
 * ensureActiveProfileVisible below for where this one is actually applied).
 *
 * Pure — takes every input as a parameter.
 *
 * Run from Node:
 *   import { DEV_RESOLVE_ACTIVE_PROFILE_FOR_VISIBLE_LIST_CASES, resolveActiveProfileForVisibleList } from "@/lib/profileStorage";
 *   DEV_RESOLVE_ACTIVE_PROFILE_FOR_VISIBLE_LIST_CASES.forEach(c => {
 *     const got = resolveActiveProfileForVisibleList(c.activeId, c.visibleProfiles);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function resolveActiveProfileForVisibleList(activeId: string, visibleProfiles: Profile[]): string {
  return visibleProfiles.some((p) => p.id === activeId) ? activeId : "default";
}

export const DEV_RESOLVE_ACTIVE_PROFILE_FOR_VISIBLE_LIST_CASES: Array<{
  name: string;
  activeId: string;
  visibleProfiles: Profile[];
  expected: string;
}> = [
  {
    name: "active id is visible for this account — kept unchanged",
    activeId: "family",
    visibleProfiles: [
      { id: "default", name: "Default" },
      { id: "family", name: "Family" },
    ],
    expected: "family",
  },
  {
    name: "Codex P1 follow-up (5th round) — active id is NOT in this account's visible list (locally suppressed) — falls back to default",
    activeId: "family",
    visibleProfiles: [{ id: "default", name: "Default" }],
    expected: "default",
  },
  {
    name: "already active on default — unchanged",
    activeId: "default",
    visibleProfiles: [{ id: "default", name: "Default" }],
    expected: "default",
  },
];

/**
 * Validates the currently stored active profile id against
 * `currentOwnerUserId`'s EFFECTIVE visible profile list (getVisibleProfiles)
 * — NOT the raw shared `dwp.profiles` getActiveProfileId() itself checks —
 * and corrects the stored `dwp.activeProfile` to "default" when it isn't
 * visible for this account (resolveActiveProfileForVisibleList).
 *
 * Codex P1 follow-up (5th round) — meant to run once per authenticated-
 * account transition/reconciliation (see settings/page.tsx's own effect),
 * so that by the time ANY downstream consumer calls the plain,
 * account-agnostic getActiveProfileId() (plans/lightning/tom/wait-times —
 * see this module's own doc), the stored value has ALREADY been corrected
 * and is guaranteed both raw-list-valid AND visible for the current
 * account — those pages need no changes of their own.
 *
 * Never deletes or rewrites the underlying `dwp.profiles` entry itself — a
 * profile hidden for THIS account stays fully intact in the shared list for
 * whichever account it actually belongs to; only the separate, device-local
 * `dwp.activeProfile` POINTER may be redirected. activeProfile itself
 * remains exactly as device-local as before — this only changes what value
 * it may be corrected TO during an account transition, never where it is
 * stored or who can read it.
 */
export function ensureActiveProfileVisible(currentOwnerUserId: string): void {
  const activeId = getActiveProfileId();
  const resolved = resolveActiveProfileForVisibleList(activeId, getVisibleProfiles(currentOwnerUserId));
  if (resolved !== activeId) setActiveProfileId(resolved);
}

// ===== PROFILE CRUD =====

/**
 * Normalize a display name into a stable id string.
 * "My Family" → "my-family"
 */
function normalizeId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "profile"
  );
}

/**
 * Make a base id unique within the existing id list by appending -2, -3, …
 */
function uniqueId(base: string, existingIds: string[]): string {
  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Create a new profile with the given display name.
 * Generates a stable id, adds to the profiles list, and returns the new Profile.
 *
 * SH.4.1 Codex P2 follow-up — the name is sanitized (trimmed, truncated to
 * MAX_PROFILE_NAME_LENGTH) via sanitizeProfileName rather than merely
 * trimmed, so a profile created here can never later be silently rejected
 * by /api/sync/profiles's server-side validation — see syncIdentity.ts's
 * own doc for the shared constraint both boundaries now enforce.
 *
 * `currentOwnerUserId` (SH.4.1 Codex P1 follow-up, 5th round) — the
 * authenticated account performing the create, if any (pass the caller's
 * own resolved `authenticatedUserId`; omit/null when signed out) — mirrors
 * deleteProfile's own `currentOwnerUserId` parameter exactly. Scopes the
 * deletion-marker clear (below) to that specific account (or the shared
 * UNOWNED_ACCOUNT_KEY bucket when signed out), so creating/recreating id X
 * can never clear a DIFFERENT account's own suppression for that same
 * literal id.
 */
export function createProfile(name: string, currentOwnerUserId: string | null = null): Profile {
  const trimmed = sanitizeProfileName(name) ?? "New Profile";
  const profiles = getProfiles();
  const existingIds = profiles.map((p) => p.id);
  const base = normalizeId(trimmed);
  const id = uniqueId(base, existingIds);
  const newProfile: Profile = { id, name: trimmed };
  writeProfiles([...profiles, newProfile]);
  // SH.4.1 (Codex P1 finding #3, follow-up round) — an explicit, deliberate
  // create always means this id should be eligible for discovery/adoption
  // going forward FOR THIS ACCOUNT, even if this exact id was locally
  // deleted by it before: the only way uniqueId() above can return an id
  // not already in `profiles` is if nothing currently in the list holds it,
  // including a previously deleted same-named profile. Scoped to
  // `currentOwnerUserId` only (Codex P1 follow-up, 5th round) — see
  // clearLocalDeletionMarker/clearLocalDeletionMarkerForAccount's own doc
  // for why a DIFFERENT account's own suppression of the identical literal
  // id must never be cleared by this.
  clearLocalDeletionMarker(id, currentOwnerUserId ?? UNOWNED_ACCOUNT_KEY);
  return newProfile;
}

/**
 * Rename an existing profile (name only — id stays stable).
 * No-op if the profile id does not exist or the name is empty.
 *
 * SH.4.1 Codex P2 follow-up — sanitized via sanitizeProfileName (see
 * createProfile's own doc) so a rename can never exceed the shared
 * server-validated limit either.
 */
export function renameProfile(id: string, name: string): void {
  const trimmed = sanitizeProfileName(name);
  if (!trimmed) return;
  const profiles = getProfiles();
  const updated = profiles.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
  writeProfiles(updated);
}

/**
 * Delete a profile: removes it from the list and cleans up all its namespaced keys.
 * The last remaining profile cannot be deleted.
 * If the deleted profile was active, switches active to "default".
 *
 * `currentOwnerUserId` (SH.4.1 Codex P1 follow-up, 3rd round) — the
 * authenticated account performing the delete, if any (pass the caller's
 * own resolved `authenticatedUserId`; omit/null when signed out). Scopes
 * the local-delete/rediscovery-suppression marker to that specific account
 * (or the shared UNOWNED_ACCOUNT_KEY bucket when signed out) — see
 * applyLocalDeletionMarker's own doc — so deleting a profile while signed
 * in as one account can never suppress a DIFFERENT account's own, distinct
 * profile under the same grandfathered id on a shared browser.
 */
export function deleteProfile(id: string, currentOwnerUserId: string | null = null): void {
  if (id === "default") return; // Default is protected from deletion via this path
  const profiles = getProfiles();
  if (profiles.length <= 1) return; // Cannot delete the last profile

  const updated = profiles.filter((p) => p.id !== id);
  writeProfiles(updated);

  // Clean up all namespaced keys for the deleted profile.
  // Iterate backwards so removals do not shift the indices of remaining keys.
  try {
    const prefix = `dwp:${id}:`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        localStorage.removeItem(key);
      }
    }
  } catch {}

  // SH.2.1 P1 fix (Codex finding #1, this round) — the loop above only
  // matches this profile's plain `dwp:{id}:{baseKey}` canonical keys (the
  // shape this module itself owns — see the module doc above). It does NOT
  // reach the sync layer's OWN per-profile key shapes (local-edit facts,
  // confirmed facts, pending pushes, the local-content-owner marker — all
  // namespaced `dwp:localEditFact:...`/`dwp:sync:...`, never `dwp:{id}:...`
  // directly). Those are DURABLE, profile-owned sync state: left behind, a
  // profile recreated with the SAME normalized id (normalizeId() is
  // deterministic) could resurrect them — a leftover local-edit fact in
  // particular can outrank the new, empty profile's canonical value the
  // moment any sync/conflict decision reads durable local authority for
  // that key. purgeProfileSyncState() (syncHelper.ts) is the shared purge
  // for that entire key family — see its own doc, and
  // isProfileOwnedSyncKey()'s doc in syncPayload.ts, for the full rationale
  // and the exact shapes covered. Deliberately NOT duplicating knowledge of
  // any of those key shapes here.
  purgeProfileSyncState(id);

  // SH.4.1 — mark this id as locally deleted, scoped to `currentOwnerUserId`
  // (or the shared unowned bucket when signed out — see this function's own
  // doc and applyLocalDeletionMarker's), so a subsequent registry
  // reconciliation round (profileRegistrySync.ts's selectActiveServerProfiles)
  // does not immediately rediscover/re-add it for THAT account, without
  // affecting any other account's own same-id profile. This device's local
  // delete does NOT touch the server's `user_profiles` row for this id (if
  // any) — it remains active until SH.4.3 implements real server-side
  // tombstones — nor any `user_planner` cloud planner data.
  markProfileLocallyDeleted(id, currentOwnerUserId ?? UNOWNED_ACCOUNT_KEY);

  // If the deleted profile was active, explicitly persist fallback to default.
  // Compare raw localStorage directly — getActiveProfileId() already applies
  // validation fallback, so by the time we call it the profile list no longer
  // contains `id` and the helper returns "default" regardless, making the
  // comparison always false and the setActiveProfileId() call unreachable.
  try {
    if (localStorage.getItem(ACTIVE_PROFILE_KEY) === id) {
      setActiveProfileId("default");
    }
  } catch {}
}

// ===== BOOTSTRAP & MIGRATION =====

/**
 * Ensure the profile system is initialized on first use.
 * - Guarantees the Default profile exists in the list.
 * - Ensures activeProfile is set and points to a valid profile.
 * - Migrates legacy single-user storage into the Default namespace (idempotent).
 *
 * Safe to call on every page mount — migration only runs when needed.
 */
export function bootstrapProfiles(): void {
  if (typeof window === "undefined") return;

  // 1. Ensure Default profile exists
  const profiles = readProfiles();
  const hasDefault = profiles.some((p) => p.id === "default");
  if (!hasDefault) {
    writeProfiles([DEFAULT_PROFILE, ...profiles]);
  }

  // 2. Ensure activeProfile is set and valid in raw storage.
  // Read raw localStorage directly — getActiveProfileId() already validates/
  // falls back, so comparing its result would never trigger the write.
  const validProfiles = hasDefault ? profiles : [DEFAULT_PROFILE, ...profiles];
  try {
    const rawActiveId = localStorage.getItem(ACTIVE_PROFILE_KEY);
    if (!rawActiveId || !validProfiles.some((p) => p.id === rawActiveId)) {
      setActiveProfileId("default");
    }
  } catch {
    setActiveProfileId("default");
  }

  // 3. Migrate legacy single-user data into Default namespace (idempotent)
  //    Only copies if the namespaced key doesn't already exist.
  for (const [baseKey, legacyKey] of Object.entries(LEGACY_KEY_MAP)) {
    const nsKey = buildNamespacedKey("default", baseKey);
    try {
      const hasNsData = localStorage.getItem(nsKey) !== null;
      if (!hasNsData) {
        const legacyData = localStorage.getItem(legacyKey);
        if (legacyData !== null) {
          localStorage.setItem(nsKey, legacyData);
        }
      }
    } catch {}
  }
}

// ===== CONVENIENCE: ACTIVE PROFILE KEYS =====

/**
 * Returns the currently active Profile object (id + name).
 * Falls back to the Default profile if the active id is not found.
 * Call after bootstrapProfiles() to ensure the profile is initialized.
 */
export function getActiveProfile(): Profile {
  const id = getActiveProfileId();
  const profiles = getProfiles();
  return profiles.find((p) => p.id === id) ?? DEFAULT_PROFILE;
}

/**
 * Returns the namespaced keys for the currently active profile.
 * Call after bootstrapProfiles() to ensure the profile is initialized.
 */
export function getActiveProfileKeys(): {
  plans: string;
  lightning: string;
  selectedResort: string;
  selectedPark: string;
} {
  const id = getActiveProfileId();
  return {
    plans: buildNamespacedKey(id, "plans"),
    lightning: buildNamespacedKey(id, "lightning"),
    selectedResort: buildNamespacedKey(id, "selectedResort"),
    selectedPark: buildNamespacedKey(id, "selectedPark"),
  };
}

// ===== SH.4.1 — REGISTRY RECONCILIATION (ADDITIVE MERGE) =====
//
// `dwp.profiles` remains this module's own source of truth for what a
// device shows in its profile picker; SH.4.1 adds a durable, account-wide
// registry behind it (`user_profiles` table, via /api/sync/profiles — see
// profileRegistrySync.ts) so a second authenticated device can discover the
// same ids/names. The two functions below are the ONLY seam between that
// registry and this device's local list, and they are deliberately narrow:
// additive-only, never renaming or removing an existing local entry. Any
// tombstone/rename-propagation policy belongs to a later phase (SH.4.2/
// SH.4.3), not here.

/**
 * Merge `candidates` (typically the account's ACTIVE server-known profiles
 * — see selectActiveServerProfiles in profileRegistrySync.ts) into an
 * existing local profile list, additively only: a candidate whose id is
 * already present in `local` is dropped — the existing local entry (id AND
 * name) is left completely untouched, so a stale local name can never be
 * overwritten by this merge and a candidate can never resurrect/rename
 * anything already known locally. A candidate whose id is new is appended
 * exactly as given, preserving its id unchanged. Pure — never touches
 * localStorage; callers persist the result themselves (see
 * adoptServerProfiles below).
 *
 * Run from Node:
 *   import { DEV_MERGE_PROFILES_ADDITIVE_CASES, mergeProfilesAdditive } from "@/lib/profileStorage";
 *   DEV_MERGE_PROFILES_ADDITIVE_CASES.forEach(c => {
 *     const got = mergeProfilesAdditive(c.local, c.candidates);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function mergeProfilesAdditive(local: Profile[], candidates: Profile[]): Profile[] {
  const localIds = new Set(local.map((p) => p.id));
  const additions = candidates.filter((p) => !localIds.has(p.id));
  if (additions.length === 0) return local;
  return [...local, ...additions];
}

export const DEV_MERGE_PROFILES_ADDITIVE_CASES: Array<{
  name: string;
  local: Profile[];
  candidates: Profile[];
  expected: Profile[];
}> = [
  {
    name: "fresh device with only local Default — server profiles discovered/appended",
    local: [{ id: "default", name: "Default" }],
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
    name: "already-known id — local name preserved, candidate's name never overwrites it",
    local: [{ id: "mom", name: "Mommy (local stale name)" }],
    candidates: [{ id: "mom", name: "Mom" }],
    expected: [{ id: "mom", name: "Mommy (local stale name)" }],
  },
  {
    name: "grandfathered custom id preserved exactly when adopted onto an empty local list",
    local: [],
    candidates: [{ id: "lindsay-2", name: "Lindsay" }],
    expected: [{ id: "lindsay-2", name: "Lindsay" }],
  },
  {
    name: "no candidates — local list returned unchanged (same reference, no write needed)",
    local: [{ id: "default", name: "Default" }],
    candidates: [],
    expected: [{ id: "default", name: "Default" }],
  },
];

/**
 * Persist the additive merge of `serverProfiles` into the local
 * `dwp.profiles` list and return the resulting list. `serverProfiles` is
 * expected to already be filtered to ACTIVE/non-tombstoned rows by the
 * caller (see selectActiveServerProfiles in profileRegistrySync.ts) — this
 * function itself has no concept of tombstones, only of "candidates safe to
 * merge in". Never removes, renames, or reorders an existing local entry;
 * only ever appends ids this device didn't already know about. Only writes
 * to localStorage when the merge actually adds something.
 */
export function adoptServerProfiles(serverProfiles: Profile[]): Profile[] {
  const local = getProfiles();
  const merged = mergeProfilesAdditive(local, serverProfiles);
  if (merged.length !== local.length) writeProfiles(merged);
  return merged;
}

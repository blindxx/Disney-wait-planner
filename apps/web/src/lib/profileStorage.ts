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
 * The canonical "always exists" profile id (see DEFAULT_PROFILE further
 * below) is a SPECIAL SHARED LOGICAL id, not an ordinary user-created
 * profile: every fresh device and every freshly authenticated account
 * automatically has it (getProfiles()'s own default-presence guarantee;
 * bootstrapProfiles()), so every account independently, legitimately
 * "creates" the identical literal id `default` by definition — there is no
 * meaningful sense in which one account's registration of `default` is a
 * competing claim against another account's own.
 *
 * Codex P1 follow-up (9th round) — the ordinary cross-account ownership
 * exclusion (selectProfileIdsOwnedByOtherAccounts/
 * selectProfileIdsExclusivelyOwnedByOthers below) exists to protect a
 * DELIBERATELY created/registered profile from being silently claimed by a
 * different account that never created it. Applying that SAME protection
 * to `default` backfired: once account A's reconciliation registered
 * `default` (which it always eventually does, since `default` always
 * exists locally), account B signing in later with an empty registry saw
 * `default` as "owned by another account" — blocked from B's own adoption
 * forever, AND hidden from B's effective profile list, even though B
 * never had any way to avoid colliding with the universal `default` id in
 * the first place. `default` is exempted from both of those exclusion
 * queries specifically for this reason; every OTHER profile id keeps the
 * exact same cross-account exclusion semantics as before.
 */
const CANONICAL_SHARED_PROFILE_ID = "default";

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
 * Pure query: given the full per-`(profileId, accountKey)` provenance state
 * and the CURRENT reconciling account, return the ids durably owned by AT
 * LEAST ONE account OTHER than `currentOwnerUserId`. The shared
 * UNOWNED_ACCOUNT_KEY sentinel is never counted as "another account" here —
 * it represents no specific account at all, never a competing claim.
 *
 * Codex P1 follow-up (6th round) — restores the ownership check
 * computeProfilesToAdopt (profileRegistrySync.ts) uses to decide adoption
 * eligibility. The 3rd-round rewrite removed that check on the reasoning
 * that a fresh, authoritative GET already tells the CURRENT account
 * everything it needs — true for "is this already mine", but not for "is
 * this SOMEONE ELSE's": account A's local reconciliation can stamp
 * `family: {userA:{owned:true}}` in this device's SHARED provenance store,
 * and when account B later signs into the SAME browser, B's own GET
 * legitimately returns nothing for "family" (B has never registered it) —
 * without this check, B's reconciliation would then treat the local
 * "family" entry as an ordinary unowned legacy profile and adopt it as
 * B's own, even though it durably belongs to A. This is NOT a return to
 * the old single-owner-per-id model: the underlying state is still keyed
 * per `(profileId, accountKey)`, and an id already owned by BOTH accounts
 * (each independently, via its own prior successful reconciliation) simply
 * has both entries — this query only ever asks "besides me, does anyone
 * else own it", never rejecting or overwriting either account's own fact.
 *
 * Codex P1 follow-up (9th round) — the canonical shared id
 * (CANONICAL_SHARED_PROFILE_ID, `"default"`) is exempt: it is never
 * included in this result no matter who else has registered it, since
 * every account independently, legitimately creates that identical literal
 * id by definition — see CANONICAL_SHARED_PROFILE_ID's own doc. This is
 * what stops account B's adoption round (computeProfilesToAdopt, via
 * getProfileIdsOwnedByOtherAccounts) from being permanently blocked from
 * registering B's own `default` merely because account A's reconciliation
 * happened to register it first. Every OTHER profile id keeps the exact
 * same exclusion semantics as before this exemption.
 *
 * Run from Node:
 *   import { DEV_SELECT_PROFILE_IDS_OWNED_BY_OTHER_ACCOUNTS_CASES, selectProfileIdsOwnedByOtherAccounts } from "@/lib/profileStorage";
 *   DEV_SELECT_PROFILE_IDS_OWNED_BY_OTHER_ACCOUNTS_CASES.forEach(c => {
 *     const got = [...selectProfileIdsOwnedByOtherAccounts(c.state, c.currentOwnerUserId)].sort();
 *     console.log(JSON.stringify(got) === JSON.stringify([...c.expected].sort()) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function selectProfileIdsOwnedByOtherAccounts(
  state: ProfileRegistryState,
  currentOwnerUserId: string
): Set<string> {
  const ids = new Set<string>();
  for (const [id, byAccount] of Object.entries(state)) {
    if (id === CANONICAL_SHARED_PROFILE_ID) continue; // every account may independently own `default`
    const ownedByOther = Object.entries(byAccount).some(
      ([accountKey, entry]) =>
        accountKey !== currentOwnerUserId && accountKey !== UNOWNED_ACCOUNT_KEY && entry?.owned
    );
    if (ownedByOther) ids.add(id);
  }
  return ids;
}

export const DEV_SELECT_PROFILE_IDS_OWNED_BY_OTHER_ACCOUNTS_CASES: Array<{
  name: string;
  state: ProfileRegistryState;
  currentOwnerUserId: string;
  expected: string[];
}> = [
  {
    name: "empty state — nothing owned by anyone",
    state: {},
    currentOwnerUserId: "userB",
    expected: [],
  },
  {
    name: "Codex P1 follow-up (6th round) — A owns 'family'; from B's perspective, 'family' is owned by another account",
    state: { family: { userA: { owned: true } } },
    currentOwnerUserId: "userB",
    expected: ["family"],
  },
  {
    name: "Codex P1 follow-up (9th round) — A owns the canonical 'default' id; it is NEVER counted as owned by another account, so B's own empty registry can still adopt/register B's own 'default'",
    state: { default: { userA: { owned: true } } },
    currentOwnerUserId: "userB",
    expected: [],
  },
  {
    name: "the current account's OWN ownership is never counted as 'another account'",
    state: { family: { userA: { owned: true } } },
    currentOwnerUserId: "userA",
    expected: [],
  },
  {
    name: "two accounts each independently own the identical literal id — this low-level query truthfully reports userB also owns 'family'; the 'two accounts remain supported' guarantee is enforced one level up by computeProfilesToAdopt's own `known` check, not by hiding this fact here",
    state: { family: { userA: { owned: true }, userB: { owned: true } } },
    currentOwnerUserId: "userA",
    expected: ["family"],
  },
  {
    name: "the shared unowned sentinel is never treated as a competing account, even if (hypothetically) marked owned",
    state: { mom: { [UNOWNED_ACCOUNT_KEY]: { owned: true } } },
    currentOwnerUserId: "userB",
    expected: [],
  },
  {
    name: "only a deletion marker, no ownership — never counted as 'owned by another account'",
    state: { mom: { userA: { locallyDeleted: true } } },
    currentOwnerUserId: "userB",
    expected: [],
  },
];

/**
 * Bulk read of every profile id durably owned by an account OTHER than
 * `currentOwnerUserId` — see selectProfileIdsOwnedByOtherAccounts's own doc.
 * Pass this straight into profileRegistrySync.ts's computeProfilesToAdopt,
 * which treats it as plain input data.
 */
export function getProfileIdsOwnedByOtherAccounts(currentOwnerUserId: string): Set<string> {
  return selectProfileIdsOwnedByOtherAccounts(readProfileRegistryState(), currentOwnerUserId);
}

/**
 * Pure query: given the full provenance state and the CURRENT account,
 * return the ids owned by another real account AND NOT also owned by
 * `currentOwnerUserId`. This is DELIBERATELY a different question from
 * `selectProfileIdsOwnedByOtherAccounts` above ("does anyone besides me own
 * this"), which two-owner adoption/cleanup decisions correctly answer
 * without regard to whether the current account ALSO owns the id — those
 * decisions have an INDEPENDENT signal (adoption's own fresh `known` set
 * from this round's GET; cleanup's need to protect ANY co-owner's data
 * regardless of who is deleting) that already accounts for "is this
 * already mine" on its own.
 *
 * Codex P1 follow-up (8th round) — VISIBILITY has no such independent
 * signal: whether an id should be shown to `currentOwnerUserId` can ONLY be
 * decided from this same provenance state, so it must explicitly check
 * "and do I not also own it" itself, or an id BOTH accounts legitimately,
 * independently own (profileStorage.ts's own module doc — two accounts can
 * always independently own the identical literal id) would be wrongly
 * hidden from an owner just because another account owns it too. This
 * query exists ONLY for that visibility decision
 * (selectHiddenProfileIdsForAccount below) — adoption/cleanup-safety must
 * keep using selectProfileIdsOwnedByOtherAccounts unchanged.
 *
 * Codex P1 follow-up (9th round) — the canonical shared id
 * (CANONICAL_SHARED_PROFILE_ID, `"default"`) is exempt here too, for the
 * same reason selectProfileIdsOwnedByOtherAccounts exempts it: every
 * account independently, legitimately creates the identical literal
 * `default` id, so account A registering it must never hide it from
 * account B's own effective profile list. Every OTHER profile id keeps
 * the exact same exclusive-ownership hiding semantics as before.
 *
 * Run from Node:
 *   import { DEV_SELECT_PROFILE_IDS_EXCLUSIVELY_OWNED_BY_OTHERS_CASES, selectProfileIdsExclusivelyOwnedByOthers } from "@/lib/profileStorage";
 *   DEV_SELECT_PROFILE_IDS_EXCLUSIVELY_OWNED_BY_OTHERS_CASES.forEach(c => {
 *     const got = [...selectProfileIdsExclusivelyOwnedByOthers(c.state, c.currentOwnerUserId)].sort();
 *     console.log(JSON.stringify(got) === JSON.stringify([...c.expected].sort()) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function selectProfileIdsExclusivelyOwnedByOthers(
  state: ProfileRegistryState,
  currentOwnerUserId: string
): Set<string> {
  const ids = new Set<string>();
  for (const [id, byAccount] of Object.entries(state)) {
    if (id === CANONICAL_SHARED_PROFILE_ID) continue; // every account may independently own `default`
    if (byAccount[currentOwnerUserId]?.owned) continue; // I own it too — never hidden from me
    const ownedByOther = Object.entries(byAccount).some(
      ([accountKey, entry]) =>
        accountKey !== currentOwnerUserId && accountKey !== UNOWNED_ACCOUNT_KEY && entry?.owned
    );
    if (ownedByOther) ids.add(id);
  }
  return ids;
}

export const DEV_SELECT_PROFILE_IDS_EXCLUSIVELY_OWNED_BY_OTHERS_CASES: Array<{
  name: string;
  state: ProfileRegistryState;
  currentOwnerUserId: string;
  expected: string[];
}> = [
  {
    name: "empty state — nothing exclusively owned by anyone",
    state: {},
    currentOwnerUserId: "userB",
    expected: [],
  },
  {
    name: "A owns 'family' only — exclusively owned by another account from B's perspective",
    state: { family: { userA: { owned: true } } },
    currentOwnerUserId: "userB",
    expected: ["family"],
  },
  {
    name: "Codex P1 follow-up (9th round) — A owns the canonical 'default' id; it never hides 'default' from B's own effective list",
    state: { default: { userA: { owned: true } } },
    currentOwnerUserId: "userB",
    expected: [],
  },
  {
    name: "the current account's OWN ownership is never counted as 'exclusively owned by another'",
    state: { family: { userA: { owned: true } } },
    currentOwnerUserId: "userA",
    expected: [],
  },
  {
    name: "Codex P1 follow-up (8th round) — A and B both independently own the identical literal id — NOT exclusively owned by another from EITHER one's own perspective",
    state: { family: { userA: { owned: true }, userB: { owned: true } } },
    currentOwnerUserId: "userA",
    expected: [],
  },
  {
    name: "same two-owner id from B's own perspective is equally not exclusively owned by another",
    state: { family: { userA: { owned: true }, userB: { owned: true } } },
    currentOwnerUserId: "userB",
    expected: [],
  },
  {
    name: "the shared unowned sentinel is never treated as a competing account",
    state: { mom: { [UNOWNED_ACCOUNT_KEY]: { owned: true } } },
    currentOwnerUserId: "userB",
    expected: [],
  },
  {
    name: "only a deletion marker, no ownership — never counted as exclusively owned by another",
    state: { mom: { userA: { locallyDeleted: true } } },
    currentOwnerUserId: "userB",
    expected: [],
  },
];

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

/**
 * Pure state transition: the FULL deletion-marker consumption an explicit
 * create/recreate of `profileId` performs for `currentOwnerUserId` — an
 * EXPLICIT RECLAIM TRANSITION, not a general weakening of deletion
 * suppression. Composes clearLocalDeletionMarkerForAccount twice: once for
 * `currentOwnerUserId`'s own marker (unchanged from the 5th round's fix),
 * and — ONLY when `currentOwnerUserId` is a REAL authenticated account, not
 * the shared UNOWNED_ACCOUNT_KEY sentinel itself — a SECOND time for that
 * shared UNOWNED_ACCOUNT_KEY bucket's own marker.
 *
 * Codex P2 follow-up (10th round) — a profile deleted while SIGNED OUT
 * records its marker under UNOWNED_ACCOUNT_KEY (deleteProfile's own
 * `currentOwnerUserId ?? UNOWNED_ACCOUNT_KEY` scoping), which
 * selectLocallyDeletedIdsForAccount deliberately also suppresses for every
 * authenticated account's OWN reconciliation (a genuinely ambiguous,
 * ownerless deletion is treated the ORIGINAL way — safe to suppress for
 * whoever reconciles it next — see that function's own doc). That
 * suppression previously OUTLIVED an authenticated account explicitly
 * creating/recreating the exact same id: account A deliberately typing
 * "Family" back in only ever cleared A's OWN (nonexistent, since A never
 * owned or deleted it before) marker, leaving the shared unowned marker
 * fully intact — so A's brand-new profile was immediately re-suppressed
 * from A's own effective visible list (selectHiddenProfileIdsForAccount)
 * and from A's own adoption candidates (reconcileProfileRegistry's
 * `filterVisibleProfiles(getProfiles(), locallyDeletedIds)`), the instant
 * it was created — a zombie profile physically present in `dwp.profiles`
 * but permanently invisible and unsyncable for the very account that just
 * created it.
 *
 * An authenticated account's explicit create is exactly the deliberate
 * signal that resolves that original ambiguity for good: it is what makes
 * this reclaim safe to apply to the SHARED bucket, not just the creating
 * account's own slot. A DIFFERENT real account's (B's, C's, etc.) own
 * deletion marker for the identical literal id is NEVER touched here —
 * clearLocalDeletionMarkerForAccount's own single-account write guarantee
 * is unchanged, so this composition can only ever affect
 * `currentOwnerUserId`'s own slot and the shared unowned slot, nothing
 * else. A SIGNED-OUT create/recreate (`currentOwnerUserId ===
 * UNOWNED_ACCOUNT_KEY`) is unaffected by this change: the two clears
 * collapse into the exact same single clear as before (there is no
 * separate "shared bucket" to additionally reclaim when the creator IS the
 * shared bucket), matching this module's own pre-existing signed-out
 * create behavior exactly.
 *
 * Ownership provenance is never touched: each underlying
 * clearLocalDeletionMarkerForAccount call preserves that account's own
 * `owned` fact if any (converting `{owned:true, locallyDeleted:true}` to
 * `{owned:true}` rather than deleting the entry), for both the creating
 * account's slot and the shared unowned slot.
 *
 * Run from Node:
 *   import { DEV_CLEAR_LOCAL_DELETION_MARKERS_FOR_RECREATE_CASES, clearLocalDeletionMarkersForRecreate } from "@/lib/profileStorage";
 *   DEV_CLEAR_LOCAL_DELETION_MARKERS_FOR_RECREATE_CASES.forEach(c => {
 *     const got = clearLocalDeletionMarkersForRecreate(c.state, c.profileId, c.currentOwnerUserId);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function clearLocalDeletionMarkersForRecreate(
  state: ProfileRegistryState,
  profileId: string,
  currentOwnerUserId: string
): ProfileRegistryState {
  let next = clearLocalDeletionMarkerForAccount(state, profileId, currentOwnerUserId);
  if (currentOwnerUserId !== UNOWNED_ACCOUNT_KEY) {
    next = clearLocalDeletionMarkerForAccount(next, profileId, UNOWNED_ACCOUNT_KEY);
  }
  return next;
}

export const DEV_CLEAR_LOCAL_DELETION_MARKERS_FOR_RECREATE_CASES: Array<{
  name: string;
  state: ProfileRegistryState;
  profileId: string;
  currentOwnerUserId: string;
  expected: ProfileRegistryState;
}> = [
  {
    name: "Codex P2 follow-up (10th round) — signed-out delete then A's authenticated recreate: the shared unowned marker is consumed even though A never had a marker of her own",
    state: { family: { [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true } } },
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: {},
  },
  {
    name: "Codex P2 follow-up (10th round) — A's own marker AND the shared unowned marker are both consumed by A's recreate, preserving A's owned fact",
    state: {
      family: {
        userA: { owned: true, locallyDeleted: true },
        [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true },
      },
    },
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: { family: { userA: { owned: true } } },
  },
  {
    name: "Codex P2 follow-up (10th round) — B's own deletion marker for the identical literal id survives A's recreation untouched",
    state: {
      family: {
        userB: { owned: true, locallyDeleted: true },
        [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true },
      },
    },
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: { family: { userB: { owned: true, locallyDeleted: true } } },
  },
  {
    name: "Codex P2 follow-up (10th round) — ownership provenance for a completely different id is never disturbed by this composed clear",
    state: {
      family: {
        userA: { owned: true, locallyDeleted: true },
        [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true },
      },
      mom: { userA: { owned: true } },
    },
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: {
      family: { userA: { owned: true } },
      mom: { userA: { owned: true } },
    },
  },
  {
    name: "Codex P2 follow-up (10th round) — a signed-out recreate clears ONLY the shared unowned marker, exactly as before this fix — a real account's own marker for the identical id is left untouched",
    state: {
      family: {
        [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true },
        userA: { owned: true, locallyDeleted: true },
      },
    },
    profileId: "family",
    currentOwnerUserId: UNOWNED_ACCOUNT_KEY,
    expected: { family: { userA: { owned: true, locallyDeleted: true } } },
  },
  {
    name: "no deletion markers present at all — state returned unchanged",
    state: { family: { userA: { owned: true } } },
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: { family: { userA: { owned: true } } },
  },
  {
    name: "unknown profileId — state returned unchanged",
    state: {},
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: {},
  },
];

/**
 * Composed end-to-end regression scenario: a signed-out delete followed by
 * an authenticated account's explicit recreate must leave the profile
 * VISIBLE to that account (selectHiddenProfileIdsForAccount's own
 * effective-visibility check) — not merely have its raw provenance marker
 * cleared in isolation. Exercises the exact real-world sequence
 * deleteProfile (signed out) -> createProfile (authenticated) ->
 * getVisibleProfiles (authenticated) runs.
 *
 * Codex P2 follow-up (10th round) — this is the precise scenario the fix
 * targets: before it, `expectedHidden` for the first case below would have
 * been `true` (a zombie, permanently invisible profile) instead of `false`.
 *
 * Run from Node:
 *   import { DEV_RECREATE_VISIBILITY_CASES, applyLocalDeletionMarker, clearLocalDeletionMarkersForRecreate, selectHiddenProfileIdsForAccount } from "@/lib/profileStorage";
 *   DEV_RECREATE_VISIBILITY_CASES.forEach(c => {
 *     let state = applyLocalDeletionMarker({}, c.profileId, c.deletedByAccountKey);
 *     state = clearLocalDeletionMarkersForRecreate(state, c.profileId, c.recreatedByAccountKey);
 *     const got = selectHiddenProfileIdsForAccount(state, c.checkVisibilityForAccountKey).has(c.profileId);
 *     console.log(got === c.expectedHidden ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_RECREATE_VISIBILITY_CASES: Array<{
  name: string;
  profileId: string;
  deletedByAccountKey: string;
  recreatedByAccountKey: string;
  checkVisibilityForAccountKey: string;
  expectedHidden: boolean;
}> = [
  {
    name: "Codex P2 follow-up (10th round) — signed-out delete -> A's authenticated recreate -> profile immediately visible to A",
    profileId: "family",
    deletedByAccountKey: UNOWNED_ACCOUNT_KEY,
    recreatedByAccountKey: "userA",
    checkVisibilityForAccountKey: "userA",
    expectedHidden: false,
  },
  {
    name: "signed-out delete -> signed-out recreate -> still visible while signed out (unaffected by this fix)",
    profileId: "family",
    deletedByAccountKey: UNOWNED_ACCOUNT_KEY,
    recreatedByAccountKey: UNOWNED_ACCOUNT_KEY,
    checkVisibilityForAccountKey: UNOWNED_ACCOUNT_KEY,
    expectedHidden: false,
  },
];

function clearLocalDeletionMarker(profileId: string, accountKey: string): void {
  const state = readProfileRegistryState();
  const updated = clearLocalDeletionMarkersForRecreate(state, profileId, accountKey);
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
 * Pure computation: the full set of profile ids that must be HIDDEN from
 * `currentOwnerUserId`'s effective view — the union of two INDEPENDENT
 * reasons: `selectLocallyDeletedIdsForAccount`'s own account-scoped delete
 * suppression, and `selectProfileIdsExclusivelyOwnedByOthers`'s cross-
 * account ownership exclusion.
 *
 * Codex P1 follow-up (8th round) — `getVisibleProfiles` previously
 * consulted ONLY the deletion-marker reason: an id sitting in the shared
 * `dwp.profiles` list but durably owned ONLY by a DIFFERENT real account
 * (e.g. discovered onto this device by that other account's own
 * reconciliation, or grandfathered in some other way) was never filtered
 * out for an account that never deleted it and never owned it either —
 * account A could see, select, rename, or delete a profile that in fact
 * belongs only to account B. Folding in
 * `selectProfileIdsExclusivelyOwnedByOthers` (NOT the plain
 * `selectProfileIdsOwnedByOtherAccounts` adoption/cleanup use — see that
 * function's own doc for why visibility needs the "exclusively" variant)
 * closes that leak: a genuinely unowned legacy profile (no owner entry for
 * ANY real account) is never in the ownership-exclusion set, so it remains
 * visible/selectable exactly as before — this is what keeps a pre-SH.4
 * legacy profile safely adoptable; an id owned by BOTH
 * `currentOwnerUserId` and another account also remains visible for
 * `currentOwnerUserId`, since `selectProfileIdsExclusivelyOwnedByOthers`
 * explicitly excludes an id the current account itself owns from its
 * result, regardless of who else also owns it.
 *
 * Codex P1 follow-up (9th round) — SIGNED-OUT MODE (`currentOwnerUserId ===
 * UNOWNED_ACCOUNT_KEY`) never applies the cross-account ownership exclusion
 * at all, only the local-deletion reason. The 8th round's fix above
 * introduced a regression: once ANY real authenticated account had, at some
 * point, registered ownership of a profile that was created and used on
 * this very device (an entirely ordinary, expected outcome of this
 * device's OWN prior reconciliation rounds), signing back out made that
 * profile look "exclusively owned by another account" from the signed-out
 * viewpoint and hid it — even though its local data
 * (`dwp:{id}:plans`/`lightning`/etc.) is still fully intact on-device and
 * nothing else is contending for it. Cross-account ownership exclusion
 * exists ONLY to keep two DIFFERENT SIGNED-IN accounts sharing one browser
 * from seeing each other's exclusively-owned profiles — it has no meaning
 * when nobody is signed in: with no authenticated account to protect
 * against, every profile physically present in `dwp.profiles` belongs to
 * whoever is using this device right now, exactly like pre-SH.4
 * local-first behavior. Local-deletion suppression (this account's own, or
 * the shared UNOWNED_ACCOUNT_KEY bucket's) still fully applies while
 * signed out — that reason is unrelated to authenticated ownership and is
 * exactly the pre-SH.4.1 signed-out delete behavior.
 *
 * Run from Node:
 *   import { DEV_SELECT_HIDDEN_PROFILE_IDS_FOR_ACCOUNT_CASES, selectHiddenProfileIdsForAccount } from "@/lib/profileStorage";
 *   DEV_SELECT_HIDDEN_PROFILE_IDS_FOR_ACCOUNT_CASES.forEach(c => {
 *     const got = [...selectHiddenProfileIdsForAccount(c.state, c.currentOwnerUserId)].sort();
 *     console.log(JSON.stringify(got) === JSON.stringify([...c.expected].sort()) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function selectHiddenProfileIdsForAccount(
  state: ProfileRegistryState,
  currentOwnerUserId: string
): Set<string> {
  const hidden = selectLocallyDeletedIdsForAccount(state, currentOwnerUserId);
  // Codex P1 follow-up (9th round) — signed-out mode retains full local-first
  // access to whatever this device's profile list already contains: no
  // authenticated account is present to protect FROM, so authenticated
  // ownership provenance is never a reason to hide a local profile here.
  if (currentOwnerUserId === UNOWNED_ACCOUNT_KEY) return hidden;
  for (const id of selectProfileIdsExclusivelyOwnedByOthers(state, currentOwnerUserId)) {
    hidden.add(id);
  }
  return hidden;
}

export const DEV_SELECT_HIDDEN_PROFILE_IDS_FOR_ACCOUNT_CASES: Array<{
  name: string;
  state: ProfileRegistryState;
  currentOwnerUserId: string;
  expected: string[];
}> = [
  {
    name: "id locally deleted by A — hidden for A",
    state: { mom: { userA: { owned: true, locallyDeleted: true } } },
    currentOwnerUserId: "userA",
    expected: ["mom"],
  },
  {
    name: "Codex P1 follow-up (8th round) — an id owned ONLY by B is hidden from A even though A never deleted or owned it",
    state: { family: { userB: { owned: true } } },
    currentOwnerUserId: "userA",
    expected: ["family"],
  },
  {
    name: "an id owned by A is visible to A even though an unrelated id is owned by B",
    state: { family: { userA: { owned: true } }, mom: { userB: { owned: true } } },
    currentOwnerUserId: "userA",
    expected: ["mom"],
  },
  {
    name: "genuinely unowned legacy id — never hidden from anyone",
    state: {},
    currentOwnerUserId: "userA",
    expected: [],
  },
  {
    name: "an id owned by BOTH A and B remains visible to A",
    state: { family: { userA: { owned: true }, userB: { owned: true } } },
    currentOwnerUserId: "userA",
    expected: [],
  },
  {
    name: "Codex P1 follow-up (9th round) — signed-out view RETAINS a profile previously registered by a real authenticated account on this device (no authenticated-ownership exclusion while signed out — this REVERSES the 8th round's own now-fixed regression)",
    state: { family: { userA: { owned: true } } },
    currentOwnerUserId: UNOWNED_ACCOUNT_KEY,
    expected: [],
  },
  {
    name: "signed-out viewer sees a genuinely unowned id as visible",
    state: {},
    currentOwnerUserId: UNOWNED_ACCOUNT_KEY,
    expected: [],
  },
  {
    name: "Codex P1 follow-up (9th round) — signed-out profile picker never becomes empty solely because every local profile has SOME authenticated ownership provenance: all three ids, each owned by a different past authenticated account, remain fully visible",
    state: {
      family: { userA: { owned: true } },
      mom: { userB: { owned: true } },
      trip2024: { userA: { owned: true }, userB: { owned: true } },
    },
    currentOwnerUserId: UNOWNED_ACCOUNT_KEY,
    expected: [],
  },
  {
    name: "Codex P1 follow-up (9th round) — signed-out mode still honors its OWN (unowned-bucket) local-deletion marker — that reason is unrelated to authenticated ownership and is unaffected by this fix",
    state: { family: { [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true }, userA: { owned: true } } },
    currentOwnerUserId: UNOWNED_ACCOUNT_KEY,
    expected: ["family"],
  },
  {
    name: "Codex P1 follow-up (9th round) — signing back in as A restores account-scoped authenticated visibility rules: the SAME id owned only by B is hidden again once A is authenticated",
    state: { family: { userB: { owned: true } } },
    currentOwnerUserId: "userA",
    expected: ["family"],
  },
  {
    name: "the canonical 'default' id owned by A is never hidden from B (visibility exemption applies through this composed function too)",
    state: { default: { userA: { owned: true } } },
    currentOwnerUserId: "userB",
    expected: [],
  },
  {
    name: "an id hidden for BOTH reasons at once (A locally deleted it, AND B independently owns it) is hidden exactly once",
    state: { mom: { userA: { locallyDeleted: true }, userB: { owned: true } } },
    currentOwnerUserId: "userA",
    expected: ["mom"],
  },
];

/**
 * Returns the EFFECTIVE profile list for `currentOwnerUserId` (a real
 * userId, or UNOWNED_ACCOUNT_KEY when signed out): every profile currently
 * in the shared local `dwp.profiles` list, except an id hidden from this
 * account for either reason `selectHiddenProfileIdsForAccount` covers
 * (this account's own local deletion, or durable ownership by a DIFFERENT
 * real account). This is a READ-ONLY, per-render view — it never writes to
 * `dwp.profiles`, so the underlying shared list (and therefore any OTHER
 * account's own same-id profile) is completely unaffected; only what THIS
 * call returns for display is filtered. Callers displaying the profile
 * picker (settings/page.tsx) should call this instead of getProfiles()
 * directly whenever an authenticated identity (or its signed-out
 * equivalent, UNOWNED_ACCOUNT_KEY) is known — every UI action (select,
 * rename, delete) that reads its candidate list FROM this function's
 * result can never act on an id owned only by another account, since it
 * simply never appears in the list handed to those handlers.
 */
export function getVisibleProfiles(currentOwnerUserId: string): Profile[] {
  return filterVisibleProfiles(
    getProfiles(),
    selectHiddenProfileIdsForAccount(readProfileRegistryState(), currentOwnerUserId)
  );
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
 * Composed end-to-end regression scenarios for the exact pipeline
 * ensureActiveProfileVisible(currentOwnerUserId) runs (selectHiddenProfileIdsForAccount
 * -> filterVisibleProfiles -> resolveActiveProfileForVisibleList), covering
 * the sign-out active-profile guarantee that no single one of those pure
 * functions' own DEV cases exercises end-to-end.
 *
 * Codex P1 follow-up (9th round) — before this round's fix, a device's own
 * previously-active profile — one this device created and has been using,
 * which some past authenticated session happened to register — would have
 * been force-corrected back to "default" the instant its account signed
 * out, even though nothing else on this device is contending for it and
 * its local data is fully intact. activeProfile stays exactly where it was
 * once signed out, confirming it validates against the signed-out
 * EFFECTIVE local list, not against authenticated ownership provenance.
 *
 * Run from Node:
 *   import { DEV_SIGNED_OUT_ACTIVE_PROFILE_CASES, selectHiddenProfileIdsForAccount, filterVisibleProfiles, resolveActiveProfileForVisibleList } from "@/lib/profileStorage";
 *   DEV_SIGNED_OUT_ACTIVE_PROFILE_CASES.forEach(c => {
 *     const visible = filterVisibleProfiles(c.profiles, selectHiddenProfileIdsForAccount(c.state, c.currentOwnerUserId));
 *     const got = resolveActiveProfileForVisibleList(c.activeId, visible);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_SIGNED_OUT_ACTIVE_PROFILE_CASES: Array<{
  name: string;
  profiles: Profile[];
  state: ProfileRegistryState;
  currentOwnerUserId: string;
  activeId: string;
  expected: string;
}> = [
  {
    name: "Codex P1 follow-up (9th round) — signed-out activeProfile stays on this device's own active profile, even though a real account previously registered it",
    profiles: [
      { id: "default", name: "Default" },
      { id: "family", name: "Family" },
    ],
    state: { family: { userA: { owned: true } } },
    currentOwnerUserId: UNOWNED_ACCOUNT_KEY,
    activeId: "family",
    expected: "family",
  },
  {
    name: "signed-out activeProfile still falls back to default when the active id was genuinely, locally deleted while signed out (unrelated to ownership, unaffected by this fix)",
    profiles: [
      { id: "default", name: "Default" },
      { id: "family", name: "Family" },
    ],
    state: { family: { [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true }, userA: { owned: true } } },
    currentOwnerUserId: UNOWNED_ACCOUNT_KEY,
    activeId: "family",
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
 * Pure decision: when `profileId` already exists physically in raw
 * `dwp.profiles`, is it a RETAINED HIDDEN entry that `currentOwnerUserId`'s
 * explicit create may RECLAIM outright (reuse the existing id, no `-2`
 * suffix) — rather than an ordinary collision that must still be suffixed?
 *
 * Codex P2 follow-up (11th round) — deleteProfile's own
 * isDestructiveProfileCleanupSafe (8th round) can leave a raw
 * `dwp.profiles` entry PHYSICALLY PRESENT after a delete, specifically
 * because destructively wiping it would have destroyed some OTHER real
 * account's still-owned data: the id stays in the list, but the deleting
 * scope's own local-deletion marker (often the shared UNOWNED_ACCOUNT_KEY
 * bucket, for a signed-out delete) hides it from view
 * (selectHiddenProfileIdsForAccount). Without this check, createProfile's
 * existing `uniqueId()` step sees that retained raw id in `existingIds`
 * and treats it as an ORDINARY collision — silently diverting to `-2`
 * instead of ever running the intended reclaim transition
 * (clearLocalDeletionMarkersForRecreate) against the id the user actually
 * meant to recreate, leaving it permanently hidden and the `-2` sibling as
 * a confusing, unrelated duplicate.
 *
 * Reclaimable requires BOTH:
 *   - the shared UNOWNED_ACCOUNT_KEY bucket itself has explicitly, locally
 *     deleted this id (`state[profileId]?.[UNOWNED_ACCOUNT_KEY]?.locallyDeleted`)
 *     — the SPECIFIC ambiguous, ownerless signal a signed-out delete
 *     leaves behind, and the only signal this reclaim path acts on
 *     (mirrors exactly what clearLocalDeletionMarkersForRecreate itself
 *     already knows how to consume). This alone already implies the id is
 *     hidden for `currentOwnerUserId` — selectLocallyDeletedIdsForAccount
 *     suppresses an id for EVERY account whenever the shared unowned
 *     bucket has deleted it, regardless of whether that account already
 *     owns it; AND
 *   - NO account OTHER than `currentOwnerUserId` currently, exclusively
 *     owns this id (`selectProfileIdsExclusivelyOwnedByOthers` — the SAME
 *     "excludes my own ownership" variant getVisibleProfiles itself uses,
 *     deliberately NOT the plain selectProfileIdsOwnedByOtherAccounts
 *     adoption/cleanup-safety uses). This is what makes reclaim actually
 *     WORK: if some different real account B still exclusively owns the
 *     id, clearing the shared marker would NOT make it visible to
 *     `currentOwnerUserId` anyway (B's own exclusive ownership would still
 *     hide it, and the pre-existing cross-account adoption exclusion — 6th
 *     round — would still block `currentOwnerUserId` from ever registering
 *     it), so reclaiming the literal id would only create an invisible,
 *     unsyncable zombie under B's id instead of `currentOwnerUserId`'s own
 *     new profile. That is exactly the "another account's exclusively-
 *     owned ... profile must not be silently claimed" case: ordinary
 *     `-2` suffixing is correct here. An id `currentOwnerUserId` already,
 *     independently owns (alone or alongside another co-owner) is NEVER
 *     excluded by this check — see selectProfileIdsExclusivelyOwnedByOthers's
 *     own doc.
 *
 * Reclaiming itself never rewrites the existing entry's id or its stored
 * name/planner data — see createProfile's own doc for exactly what a
 * reclaim does (skip appending a new `dwp.profiles` row; only consume
 * deletion markers via clearLocalDeletionMarkersForRecreate). Keeps
 * `default` semantics unchanged: deleteProfile can never mark `default`
 * deleted at all, so `default` can never satisfy the first condition.
 *
 * Run from Node:
 *   import { DEV_IS_RETAINED_HIDDEN_ID_RECLAIMABLE_CASES, isRetainedHiddenIdReclaimable } from "@/lib/profileStorage";
 *   DEV_IS_RETAINED_HIDDEN_ID_RECLAIMABLE_CASES.forEach(c => {
 *     const got = isRetainedHiddenIdReclaimable(c.state, c.profileId, c.currentOwnerUserId);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function isRetainedHiddenIdReclaimable(
  state: ProfileRegistryState,
  profileId: string,
  currentOwnerUserId: string
): boolean {
  const unownedDeleted = state[profileId]?.[UNOWNED_ACCOUNT_KEY]?.locallyDeleted === true;
  if (!unownedDeleted) return false;
  return !selectProfileIdsExclusivelyOwnedByOthers(state, currentOwnerUserId).has(profileId);
}

export const DEV_IS_RETAINED_HIDDEN_ID_RECLAIMABLE_CASES: Array<{
  name: string;
  state: ProfileRegistryState;
  profileId: string;
  currentOwnerUserId: string;
  expected: boolean;
}> = [
  {
    name: "Codex P2 follow-up (11th round) — A already durably owns 'family' herself; a stray shared unowned deletion marker hides it, but reclaim is safe since no OTHER account is involved",
    state: { family: { userA: { owned: true }, [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true } } },
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: true,
  },
  {
    name: "Codex P2 follow-up (11th round) — genuinely unowned 'family', retained with only a shared unowned marker — reclaimable for A, who is not blocked by any other owner",
    state: { family: { [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true } } },
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: true,
  },
  {
    name: "Codex P2 follow-up (11th round) — 'family' is exclusively owned by a DIFFERENT real account B; even with a shared unowned marker present, NOT reclaimable — reclaiming would only produce an invisible zombie under B's still-exclusive ownership",
    state: { family: { userB: { owned: true }, [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true } } },
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: false,
  },
  {
    name: "Codex P2 follow-up (11th round) — 'family' is co-owned by BOTH A and B; A's own independent co-ownership is never blocked by B's separate co-ownership, so it remains reclaimable for A",
    state: {
      family: { userA: { owned: true }, userB: { owned: true }, [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true } },
    },
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: true,
  },
  {
    name: "another account's exclusively-owned id with NO shared unowned marker at all — not reclaimable (ordinary exclusively-other-owned profile; must not be silently claimed)",
    state: { family: { userB: { owned: true } } },
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: false,
  },
  {
    name: "genuinely unowned id with no markers at all — not reclaimable (nothing to reclaim; an ordinary, unrelated collision uses normal suffix behavior)",
    state: {},
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: false,
  },
  {
    name: "signed-out creator reclaims her own earlier signed-out delete of a genuinely unowned id",
    state: { family: { [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true } } },
    profileId: "family",
    currentOwnerUserId: UNOWNED_ACCOUNT_KEY,
    expected: true,
  },
  {
    name: "signed-out creator reclaim is blocked when a real account B exclusively owns the id",
    state: { family: { userB: { owned: true }, [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true } } },
    profileId: "family",
    currentOwnerUserId: UNOWNED_ACCOUNT_KEY,
    expected: false,
  },
  {
    name: "the canonical 'default' id is never reclaimable — deleteProfile can never mark it deleted at all, so it never satisfies the shared-unowned-marker precondition",
    state: {},
    profileId: "default",
    currentOwnerUserId: "userA",
    expected: false,
  },
];

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
 *
 * Codex P2 follow-up (10th round) — when `currentOwnerUserId` is a REAL
 * authenticated account, this ALSO consumes the shared UNOWNED_ACCOUNT_KEY
 * bucket's own marker for id X (clearLocalDeletionMarkersForRecreate's own
 * doc) — an explicit reclaim transition: a deletion recorded while signed
 * out is genuinely ambiguous/ownerless, and an authenticated account's own
 * deliberate create is exactly the signal that resolves it, so the
 * recreated profile is immediately visible to THAT account and eligible
 * for normal registry adoption again, rather than staying invisibly
 * suppressed by a signed-out marker nobody can otherwise clear. A
 * DIFFERENT real account's own marker for the identical id is still never
 * touched. A signed-out create/recreate is unaffected — it still only ever
 * clears the shared bucket's own marker, exactly as before this fix.
 *
 * Codex P2 follow-up (11th round) — the id-SELECTION step itself is fixed
 * too: previously, whenever the literal generated `base` id already
 * existed in raw `dwp.profiles` — including a RETAINED HIDDEN entry the
 * 8th round's isDestructiveProfileCleanupSafe deliberately left behind —
 * uniqueId() always treated it as an ordinary collision and suffixed to
 * `-2`, so the 10th round's own reclaim transition above ran against the
 * WRONG id (the brand-new `-2` sibling) and never touched the id the user
 * actually meant to recreate. See isRetainedHiddenIdReclaimable's own doc
 * for the exact eligibility rule this now checks FIRST: when the raw
 * `base` id is reclaimable for this create's scope, the EXISTING entry is
 * reused outright — no new `dwp.profiles` row is appended, and neither its
 * id nor its currently stored name is ever rewritten — and only the
 * deletion-marker reclaim transition below runs against it. An id that is
 * merely an ORDINARY collision (this account's own existing profile, a
 * genuinely unowned/visible legacy id, or another account's exclusively-
 * owned, non-reclaimable profile) is completely unaffected and still
 * suffixes exactly as before.
 */
export function createProfile(name: string, currentOwnerUserId: string | null = null): Profile {
  const trimmed = sanitizeProfileName(name) ?? "New Profile";
  const scopeKey = currentOwnerUserId ?? UNOWNED_ACCOUNT_KEY;
  const profiles = getProfiles();
  const existingIds = profiles.map((p) => p.id);
  const base = normalizeId(trimmed);

  if (existingIds.includes(base) && isRetainedHiddenIdReclaimable(readProfileRegistryState(), base, scopeKey)) {
    // Reclaim: reuse the existing physical entry exactly as stored — never
    // append a duplicate row, never rewrite its id or name (see this
    // function's own doc and isRetainedHiddenIdReclaimable's for why the
    // shared-name representation is deliberately left untouched here,
    // matching the co-owned-profile architecture this module already
    // supports elsewhere).
    const existing = profiles.find((p) => p.id === base)!;
    clearLocalDeletionMarker(base, scopeKey);
    return existing;
  }

  const id = uniqueId(base, existingIds);
  const newProfile: Profile = { id, name: trimmed };
  writeProfiles([...profiles, newProfile]);
  // SH.4.1 (Codex P1 finding #3, follow-up round) — an explicit, deliberate
  // create always means this id should be eligible for discovery/adoption
  // going forward FOR THIS ACCOUNT, even if this exact id was locally
  // deleted by it before: the only way uniqueId() above can return an id
  // not already in `profiles` is if nothing currently in the list holds it,
  // including a previously deleted same-named profile. Scoped to
  // `currentOwnerUserId` (Codex P1 follow-up, 5th round), and — when
  // `currentOwnerUserId` is a real account — ALSO reclaiming the shared
  // unowned bucket's own marker (Codex P2 follow-up, 10th round) — see
  // clearLocalDeletionMarker/clearLocalDeletionMarkersForRecreate's own doc
  // for why a DIFFERENT account's own suppression of the identical literal
  // id must never be cleared by this.
  clearLocalDeletionMarker(id, scopeKey);
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
 * Pure decision: is it safe to DESTRUCTIVELY clean up `profileId`'s shared
 * physical data — remove it from the shared `dwp.profiles` list, wipe its
 * `dwp:{profileId}:*` namespaced keys, and purge its sync provenance — as
 * part of `currentOwnerUserId`'s delete? Safe only when NO account OTHER
 * than `currentOwnerUserId` durably, independently owns this literal id
 * (`selectProfileIdsOwnedByOtherAccounts`) — i.e. `currentOwnerUserId` is
 * either this id's sole owner or the id is genuinely unowned.
 *
 * Codex P1 follow-up (8th round) — two different accounts can each,
 * independently, legitimately own the identical literal profile id on the
 * SAME device (profileStorage.ts's module doc, applyProfileOwnerStamp),
 * but that co-ownership is only ever a PROVENANCE fact — the shared
 * `dwp.profiles` entry and its `dwp:{id}:*` namespaced planner/lightning/
 * park-context data, plus its `dwp:sync:*`/`dwp:localEditFact:*` sync
 * provenance (purgeProfileSyncState, syncHelper.ts), remain ONE PHYSICAL
 * copy on this device, not one per owning account. deleteProfile
 * previously ran that destructive cleanup unconditionally on every delete;
 * when a second account legitimately co-owned the same id, deleting it as
 * the first account would destroy the SECOND account's own local-first
 * planner content, sync provenance, and any of its unsynced edits — data
 * that account never asked to delete and has no way to recover, since none
 * of it was ever synced away from B (that is the entire point of
 * local-first: it may only ever exist in this one browser's localStorage).
 * This predicate is what gates that: when it returns false, deleteProfile
 * leaves ALL of that physical data completely untouched, and relies
 * entirely on the existing account-scoped local-deletion marker
 * (markProfileLocallyDeleted/selectHiddenProfileIdsForAccount) to hide the
 * id from `currentOwnerUserId`'s own effective view going forward, without
 * touching what the other, still-owning account sees or has stored.
 *
 * Run from Node:
 *   import { DEV_IS_DESTRUCTIVE_PROFILE_CLEANUP_SAFE_CASES, isDestructiveProfileCleanupSafe } from "@/lib/profileStorage";
 *   DEV_IS_DESTRUCTIVE_PROFILE_CLEANUP_SAFE_CASES.forEach(c => {
 *     const got = isDestructiveProfileCleanupSafe(c.state, c.profileId, c.currentOwnerUserId);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 *
 * Note (Codex P1 follow-up, 9th round): this reuses
 * selectProfileIdsOwnedByOtherAccounts, which is now also the function that
 * exempts the canonical `default` id from cross-account ownership exclusion
 * (see CANONICAL_SHARED_PROFILE_ID's own doc) — so this predicate would
 * likewise report "safe" for `profileId === "default"` regardless of other
 * owners. That is never actually reachable: deleteProfile unconditionally
 * refuses to delete `default` before this predicate is ever consulted.
 */
export function isDestructiveProfileCleanupSafe(
  state: ProfileRegistryState,
  profileId: string,
  currentOwnerUserId: string
): boolean {
  return !selectProfileIdsOwnedByOtherAccounts(state, currentOwnerUserId).has(profileId);
}

export const DEV_IS_DESTRUCTIVE_PROFILE_CLEANUP_SAFE_CASES: Array<{
  name: string;
  state: ProfileRegistryState;
  profileId: string;
  currentOwnerUserId: string;
  expected: boolean;
}> = [
  {
    name: "A-only ownership + A delete — no other owner, safe to fully clean up shared data",
    state: { family: { userA: { owned: true } } },
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: true,
  },
  {
    name: "Codex P1 follow-up (8th round) — A+B same-id ownership + A delete — B still owns it, NOT safe to destroy shared physical data",
    state: { family: { userA: { owned: true }, userB: { owned: true } } },
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: false,
  },
  {
    name: "symmetric case — B deleting while A also owns the identical literal id is equally not safe",
    state: { family: { userA: { owned: true }, userB: { owned: true } } },
    profileId: "family",
    currentOwnerUserId: "userB",
    expected: false,
  },
  {
    name: "genuinely unowned legacy profile deletion — no one else has any claim, safe to fully clean up",
    state: {},
    profileId: "legacy-trip",
    currentOwnerUserId: "userA",
    expected: true,
  },
  {
    name: "signed-out deletion of a profile actually owned by a real account — protected, NOT safe",
    state: { family: { userA: { owned: true } } },
    profileId: "family",
    currentOwnerUserId: UNOWNED_ACCOUNT_KEY,
    expected: false,
  },
  {
    name: "signed-out deletion of a genuinely unowned profile — safe, matches pre-SH.4.1 behavior",
    state: {},
    profileId: "legacy-trip",
    currentOwnerUserId: UNOWNED_ACCOUNT_KEY,
    expected: true,
  },
  {
    name: "last remaining owner deletion — id was never actually shared (only this account's own ownership fact exists) — safe",
    state: { family: { userA: { owned: true }, [UNOWNED_ACCOUNT_KEY]: { locallyDeleted: true } } },
    profileId: "family",
    currentOwnerUserId: "userA",
    expected: true,
  },
];

/**
 * Delete a profile for `currentOwnerUserId`'s own view: always hides it
 * from that account going forward (the account-scoped local-deletion
 * marker below), and — ONLY when `isDestructiveProfileCleanupSafe` confirms
 * no OTHER account still owns this literal id — also destructively removes
 * it from the shared `dwp.profiles` list and wipes its namespaced/sync
 * data. The last remaining VISIBLE profile cannot be deleted this way
 * (callers gate the delete action on `getVisibleProfiles`'s own result, so
 * `profiles.length` here reflects the raw shared list, which may still
 * exceed 1 even when only one entry is visible to this account — that is
 * fine, since a length-1 raw list can only ever mean the single remaining
 * physical entry, safe or not, is the one this call is about).
 * If the deleted profile was active for this device, switches active to
 * "default".
 *
 * `currentOwnerUserId` (SH.4.1 Codex P1 follow-up, 3rd round) — the
 * authenticated account performing the delete, if any (pass the caller's
 * own resolved `authenticatedUserId`; omit/null when signed out). Scopes
 * the local-delete/rediscovery-suppression marker to that specific account
 * (or the shared UNOWNED_ACCOUNT_KEY bucket when signed out) — see
 * applyLocalDeletionMarker's own doc — so deleting a profile while signed
 * in as one account can never suppress a DIFFERENT account's own, distinct
 * profile under the same grandfathered id on a shared browser.
 *
 * Codex P1 follow-up (8th round) — see isDestructiveProfileCleanupSafe's
 * own doc for why the destructive half of this (list removal + namespaced/
 * sync-provenance wipe) must be conditional: two accounts can legitimately,
 * independently own the identical literal id on this one device, but the
 * physical data behind that id is ONE shared copy, not one per account.
 */
export function deleteProfile(id: string, currentOwnerUserId: string | null = null): void {
  if (id === "default") return; // Default is protected from deletion via this path
  const profiles = getProfiles();
  if (profiles.length <= 1) return; // Cannot delete the last profile

  const scopeKey = currentOwnerUserId ?? UNOWNED_ACCOUNT_KEY;
  const destructiveCleanupSafe = isDestructiveProfileCleanupSafe(readProfileRegistryState(), id, scopeKey);

  if (destructiveCleanupSafe) {
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
  }
  // else: isDestructiveProfileCleanupSafe found another real account still,
  // independently, owns this literal id on this device — the shared
  // dwp.profiles entry, its dwp:{id}:* namespaced data, and its sync
  // provenance all remain COMPLETELY untouched, so that account's own
  // local-first planner content and any unsynced edits survive this delete
  // intact. Only `scopeKey`'s own view of the id is suppressed, below.

  // SH.4.1 — mark this id as locally deleted, scoped to `scopeKey` (a real
  // userId, or the shared unowned bucket when signed out — see this
  // function's own doc and applyLocalDeletionMarker's), so a subsequent
  // registry reconciliation round
  // (profileRegistrySync.ts's selectActiveServerProfiles) does not
  // immediately rediscover/re-add it for THAT account, and so
  // selectHiddenProfileIdsForAccount hides it from that account's own
  // effective view immediately — without affecting any other account's own
  // same-id profile. This device's local delete does NOT touch the
  // server's `user_profiles` row for this id (if any) — it remains active
  // until SH.4.3 implements real server-side tombstones — nor any
  // `user_planner` cloud planner data.
  markProfileLocallyDeleted(id, scopeKey);

  // If the deleted profile was active, explicitly persist fallback to
  // default. Compare raw localStorage directly rather than calling
  // getActiveProfileId(), because the two cleanup branches above leave the
  // raw list in different states: when destructive cleanup ran, `id` is
  // already gone from `dwp.profiles`, so getActiveProfileId()'s own
  // raw-list validation would already return "default" and a comparison
  // against `id` would always be false; when it did NOT run (another
  // account still owns `id`), `id` is still a perfectly valid raw-list
  // entry for THAT account, so getActiveProfileId() would NOT fall back on
  // its own even though `currentOwnerUserId`/`scopeKey` must no longer keep
  // it active. Reading the raw pointer directly covers both cases
  // uniformly: whenever it still equals `id`, this account's own active
  // pointer must move to "default", regardless of whether the underlying
  // entry itself survives for someone else.
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

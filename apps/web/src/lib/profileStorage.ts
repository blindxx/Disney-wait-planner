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

// ===== TYPES =====

export type Profile = {
  id: string;
  name: string;
};

// ===== CONSTANTS =====

const ACTIVE_PROFILE_KEY = "dwp.activeProfile";
const PROFILES_LIST_KEY = "dwp.profiles";

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
 */
export function createProfile(name: string): Profile {
  const trimmed = name.trim() || "New Profile";
  const profiles = getProfiles();
  const existingIds = profiles.map((p) => p.id);
  const base = normalizeId(trimmed);
  const id = uniqueId(base, existingIds);
  const newProfile: Profile = { id, name: trimmed };
  writeProfiles([...profiles, newProfile]);
  return newProfile;
}

/**
 * Rename an existing profile (name only — id stays stable).
 * No-op if the profile id does not exist.
 */
export function renameProfile(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const profiles = getProfiles();
  const updated = profiles.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
  writeProfiles(updated);
}

/**
 * Delete a profile: removes it from the list and cleans up all its namespaced keys.
 * The last remaining profile cannot be deleted.
 * If the deleted profile was active, switches active to "default".
 */
export function deleteProfile(id: string): void {
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

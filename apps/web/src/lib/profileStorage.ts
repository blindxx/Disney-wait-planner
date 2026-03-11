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

  // Clean up all namespaced keys for the deleted profile
  try {
    const allKeys = Object.keys(localStorage);
    const prefix = `dwp:${id}:`;
    for (const key of allKeys) {
      if (key.startsWith(prefix)) {
        localStorage.removeItem(key);
      }
    }
  } catch {}

  // If the deleted profile was active, fall back to default
  if (getActiveProfileId() === id) {
    setActiveProfileId("default");
  }
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

  // 2. Ensure activeProfile is set and valid
  const validProfiles = hasDefault ? profiles : [DEFAULT_PROFILE, ...profiles];
  const activeId = getActiveProfileId();
  if (!validProfiles.some((p) => p.id === activeId)) {
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

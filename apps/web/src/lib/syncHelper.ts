/*
Cloud Sync Safety Notes — Phase 7.6 (Sync Scope Expansion)
This module manages debounced cloud planner synchronization.
Critical invariants:
• Debounced sync operations must not cross auth/session boundaries.
• Debounced sync operations must not cross profile boundaries.
• Only the most recent local state should be pushed to the cloud.
• Pending sync timers must be safely cancelable during auth/profile transitions.
• Sync scheduling must not cause duplicate or conflicting writes.
• Stale in-flight results from a prior profile must never be applied to the
  current profile's state.
Reviewers should check any changes affecting:
- debounce timers
- session/auth transitions
- profile switch transitions
- push ordering
- payload construction (reads from localStorage at push time)
- payload correctness
*/

/**
 * syncHelper — client-side planner cloud sync (Phase 7.6)
 *
 * Usage:
 *   setSyncProfileId(profileId)  — call on profile switch to retarget sync
 *   scheduleSync()               — debounced push after any planner mutation
 *   pullPlanner(profileId)       — fetch combined cloud planner on sign-in
 *   registerUnloadSync()         — best-effort beacon push on page unload
 *   cancelScheduledSync()        — cancel pending sync (auth/profile transitions)
 *
 * localStorage keys:
 *   dwp:sync:{profileId}:lastSyncedAt — ISO timestamp of last successful push
 *
 * The synced payload (SyncedPlannerPayload) includes both plans and lightning
 * for the active profile. It is read fresh from localStorage at push time
 * so no payload needs to be passed through the call chain.
 */

import { buildNamespacedKey } from "./profileStorage";
import { buildSyncedPlannerPayload, parseSyncedPlannerPayload, type SyncedPlannerPayload } from "./syncPayload";

// ── Constants ─────────────────────────────────────────────────────────────────

// 500 KB soft cap — planner payloads are typically < 100 KB.
const MAX_SYNC_BYTES = 500_000;
// Debounce window: wait this long after the last mutation before pushing.
const DEBOUNCE_MS = 3_000;

// ── Last-synced key helpers ────────────────────────────────────────────────────

/** Returns the localStorage key for the last-synced timestamp for a given profile. */
export function lastSyncedKeyForProfile(profileId: string): string {
  return `dwp:sync:${profileId}:lastSyncedAt`;
}

function syncStatusKeyForProfile(profileId: string): string {
  return `dwp:sync:${profileId}:status`;
}

function syncErrorKeyForProfile(profileId: string): string {
  return `dwp:sync:${profileId}:lastError`;
}

// ── Sync state observer ───────────────────────────────────────────────────────

/**
 * Custom event name dispatched on window whenever sync status changes.
 * Listen to this for same-tab reactive updates (e.g. on the Settings page).
 */
export const SYNC_STATE_CHANGED_EVENT = "dwp:syncStateChanged";

export interface SyncState {
  status: "idle" | "syncing" | "error";
  lastSyncedAt: string | null;
  lastError: string | null;
}

/**
 * Read the current sync state for a profile from localStorage.
 * Safe to call in SSR (returns defaults).
 */
export function getSyncStateForProfile(profileId: string): SyncState {
  if (typeof window === "undefined") {
    return { status: "idle", lastSyncedAt: null, lastError: null };
  }
  try {
    const rawStatus = localStorage.getItem(syncStatusKeyForProfile(profileId));
    const status: SyncState["status"] =
      rawStatus === "syncing" || rawStatus === "error" ? rawStatus : "idle";
    const lastSyncedAt = localStorage.getItem(lastSyncedKeyForProfile(profileId));
    const lastError = localStorage.getItem(syncErrorKeyForProfile(profileId));
    return { status, lastSyncedAt, lastError };
  } catch {
    return { status: "idle", lastSyncedAt: null, lastError: null };
  }
}

// ── Module-level state ────────────────────────────────────────────────────────

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

/**
 * The profile ID that sync is currently targeting.
 * Updated by setSyncProfileId(); read by doPush() and registerUnloadSync().
 * Defaults to "default" (matches the default profile from profileStorage).
 */
let currentSyncProfileId = "default";

// ── setSyncProfileId ──────────────────────────────────────────────────────────

/**
 * Set the active profile that sync operations should target.
 * If the profile changes, any pending debounced push for the prior profile
 * is immediately cancelled to prevent cross-profile contamination.
 * The caller is responsible for triggering a cloud pull for the new profile
 * before re-opening the sync gate.
 */
export function setSyncProfileId(profileId: string): void {
  if (profileId === currentSyncProfileId) return;
  // Profile changed — cancel any pending work for the old profile.
  cancelScheduledSync();
  currentSyncProfileId = profileId;
}

// ── scheduleSync ──────────────────────────────────────────────────────────────

/**
 * Schedule a debounced cloud push for the current sync profile.
 * Call this after every successful local planner persist (plans or lightning).
 * Reads plans + lightning from localStorage at push time — no payload arg needed.
 * Silently no-ops in SSR or when the user is not signed in (401 responses ignored).
 */
export function scheduleSync(): void {
  if (typeof window === "undefined") return; // SSR guard
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void doPush();
  }, DEBOUNCE_MS);
}

// ── cancelScheduledSync ───────────────────────────────────────────────────────

/**
 * Cancel any pending debounced sync push.
 * Call this on auth transitions (loading/authenticated) and profile switches
 * to prevent a queued stale PUT from firing during the pull window.
 */
export function cancelScheduledSync(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

// ── pullPlanner ───────────────────────────────────────────────────────────────

/**
 * Pull the latest combined planner blob for the signed-in user + profile.
 *
 * Returns:
 *   SyncedPlannerPayload — a valid combined planner payload was parsed
 *   null                 — no usable planner payload could be parsed; this
 *                          includes: 204 No Content (nothing stored yet),
 *                          a payload that failed JSON parsing or shape
 *                          validation in parseSyncedPlannerPayload(), or
 *                          a legacy plans-only response that could not be
 *                          normalized into the combined shape
 *
 * Throws on:
 *   non-OK HTTP responses (401, 5xx, etc.)
 *   network/fetch failures
 *
 * Callers must catch to distinguish "unknown failure" from "known empty".
 * A thrown error must NOT reopen the push gate — cloud state is uncertain.
 */
export async function pullPlanner(profileId: string): Promise<SyncedPlannerPayload | null> {
  const url = `/api/sync/planner?profileId=${encodeURIComponent(profileId)}`;
  const res = await fetch(url, { credentials: "include" });
  // Definitively empty — no planner stored for this user+profile yet
  if (res.status === 204) return null;
  // Any other non-OK status is a real failure; let it throw
  if (!res.ok) throw new Error(`sync/planner GET ${res.status}`);
  const data = (await res.json()) as { plannerJson?: unknown };
  return parseSyncedPlannerPayload(data.plannerJson ?? null);
}

/**
 * @deprecated Backward-compat wrapper: pulls planner and returns plans portion only.
 * Kept for smooth migration; prefer pullPlanner() directly in new code.
 */
export async function pullPlans(): Promise<{
  version: number;
  items: unknown[];
} | null> {
  const payload = await pullPlanner(currentSyncProfileId);
  return payload?.plans ?? null;
}

// ── registerUnloadSync ────────────────────────────────────────────────────────

/**
 * Register a beforeunload handler that sends a best-effort POST beacon.
 * Uses navigator.sendBeacon so the request outlives the page.
 * Reads planner data from localStorage at unload time (always current).
 * Returns a cleanup function; call it in useEffect cleanup.
 */
export function registerUnloadSync(): () => void {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return () => {};
  }

  const handler = (): void => {
    // Cancel any pending debounce — beacon takes over
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    const profileId = currentSyncProfileId;
    const payload = buildPayloadFromStorage(profileId);
    if (!payload) return;
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).length > MAX_SYNC_BYTES) return;
    navigator.sendBeacon(
      `/api/sync/planner?profileId=${encodeURIComponent(profileId)}`,
      new Blob([body], { type: "application/json" })
    );
  };

  window.addEventListener("beforeunload", handler);
  return () => window.removeEventListener("beforeunload", handler);
}

// ── internal helpers ──────────────────────────────────────────────────────────

/**
 * Parse a single raw localStorage value (plans or lightning) into a
 * normalized dataset entry. Returns null when the stored data is in an
 * unsafe or unrecognisable state so the caller can abort the push.
 *
 *   null raw (missing key)         → { version: 1, items: [] }  (empty — safe)
 *   JSON array (legacy shape)      → { version: 1, items: array } (normalised)
 *   { version: number, items[] }   → use as-is
 *   malformed JSON / unknown shape → null  (do NOT coerce to empty)
 */
function parseLocalDatasetEntry(
  raw: string | null
): { version: number; items: unknown[] } | null {
  if (raw === null) return { version: 1, items: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed JSON — unsafe
  }
  if (Array.isArray(parsed)) {
    return { version: 1, items: parsed }; // legacy array-only shape
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    typeof (parsed as Record<string, unknown>).version === "number" &&
    Array.isArray((parsed as Record<string, unknown>).items)
  ) {
    const p = parsed as { version: number; items: unknown[] };
    return { version: p.version, items: p.items };
  }
  return null; // unexpected shape — unsafe
}

/**
 * Read the current plans + lightning for a profile from localStorage and
 * construct a SyncedPlannerPayload.
 *
 * Returns null when:
 *   • localStorage is unavailable (SSR guard)
 *   • either dataset contains malformed JSON or an unrecognised shape
 *     (prevents pushing stale/empty data over valid cloud state)
 *
 * Missing localStorage keys are treated as empty datasets (safe).
 * Legacy array-only shapes are normalised automatically.
 */
function buildPayloadFromStorage(profileId: string): SyncedPlannerPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const plansRaw = localStorage.getItem(buildNamespacedKey(profileId, "plans"));
    const lightningRaw = localStorage.getItem(buildNamespacedKey(profileId, "lightning"));

    const plans = parseLocalDatasetEntry(plansRaw);
    const lightning = parseLocalDatasetEntry(lightningRaw);

    // If either dataset is in an unsafe/unrecognised state, abort — do not
    // push potentially empty data over valid cloud state.
    if (plans === null || lightning === null) return null;

    return buildSyncedPlannerPayload(plans, lightning);
  } catch {
    return null;
  }
}

// ── internal push ─────────────────────────────────────────────────────────────

async function doPush(): Promise<void> {
  if (inFlight) {
    // Re-schedule so the latest payload gets sent after the current request
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void doPush(), 1_000);
    return;
  }

  // Capture the profile at push-start so all writes target the originating
  // profile unconditionally, even if the user switches profiles mid-flight.
  const profileId = currentSyncProfileId;

  const payload = buildPayloadFromStorage(profileId);
  if (!payload) return;

  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).length > MAX_SYNC_BYTES) return;

  inFlight = true;
  // Mark syncing for the originating profile. This write is intentionally
  // unconditional — storage is namespaced by profileId so writing "syncing"
  // here is always correct for the profile that started this request.
  try {
    localStorage.setItem(syncStatusKeyForProfile(profileId), "syncing");
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(SYNC_STATE_CHANGED_EVENT));
  } catch {}
  try {
    const res = await fetch(
      `/api/sync/planner?profileId=${encodeURIComponent(profileId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body,
      }
    );
    if (res.ok) {
      // Write completion state to the originating profileId unconditionally —
      // storage is per-profile so this is always safe regardless of whether
      // the user has switched to a different profile mid-flight.
      // lastSyncedAt is also written unconditionally: the originating profile
      // completed a real successful sync and should always record its own timestamp.
      // Timestamp write is best-effort — quota or private-mode errors must not
      // prevent the status transition and event dispatch below.
      try {
        localStorage.setItem(lastSyncedKeyForProfile(profileId), new Date().toISOString());
      } catch {}
      // Status writes are best-effort; event dispatch MUST always execute.
      try {
        localStorage.setItem(syncStatusKeyForProfile(profileId), "idle");
      } catch {}
      try {
        localStorage.removeItem(syncErrorKeyForProfile(profileId));
      } catch {}
      try {
        window.dispatchEvent(new CustomEvent(SYNC_STATE_CHANGED_EVENT));
      } catch {}
    } else if (res.status !== 401) {
      // Non-401 failure — record error state for the originating profile.
      try {
        localStorage.setItem(syncStatusKeyForProfile(profileId), "error");
      } catch {}
      try {
        localStorage.setItem(syncErrorKeyForProfile(profileId), `HTTP ${res.status}`);
      } catch {}
      try {
        window.dispatchEvent(new CustomEvent(SYNC_STATE_CHANGED_EVENT));
      } catch {}
    } else {
      // 401 — user not signed in; return originating profile to a clean idle state.
      // Also clear lastError so the profile doesn't show a stale error after sign-out.
      try {
        localStorage.setItem(syncStatusKeyForProfile(profileId), "idle");
      } catch {}
      try {
        localStorage.removeItem(syncErrorKeyForProfile(profileId));
      } catch {}
      try {
        window.dispatchEvent(new CustomEvent(SYNC_STATE_CHANGED_EVENT));
      } catch {}
    }
  } catch {
    // Network error — record error state on the originating profile
    try {
      localStorage.setItem(syncStatusKeyForProfile(profileId), "error");
    } catch {}
    try {
      localStorage.setItem(syncErrorKeyForProfile(profileId), "Network error");
    } catch {}
    try {
      window.dispatchEvent(new CustomEvent(SYNC_STATE_CHANGED_EVENT));
    } catch {}
  } finally {
    inFlight = false;
  }
}

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
 *   SyncedPlannerPayload — cloud data found (plans + lightning)
 *   null                 — cloud is definitively empty (204 No Content) or
 *                          cloud payload is present but legacy plans-only shape
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
 * Read the current plans + lightning for a profile from localStorage and
 * construct a SyncedPlannerPayload. Returns null if localStorage is unavailable.
 * Tolerates missing/corrupt keys gracefully (treats as empty arrays).
 */
function buildPayloadFromStorage(profileId: string): SyncedPlannerPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const plansKey = buildNamespacedKey(profileId, "plans");
    const lightningKey = buildNamespacedKey(profileId, "lightning");
    const plansRaw = localStorage.getItem(plansKey);
    const lightningRaw = localStorage.getItem(lightningKey);

    let plans: { version: number; items: unknown[] } = { version: 1, items: [] };
    let lightning: { version: number; items: unknown[] } = { version: 1, items: [] };

    if (plansRaw) {
      try {
        const p = JSON.parse(plansRaw) as { version?: number; items?: unknown[] };
        if (typeof p.version === "number" && Array.isArray(p.items)) {
          plans = { version: p.version, items: p.items };
        }
      } catch {}
    }

    if (lightningRaw) {
      try {
        const l = JSON.parse(lightningRaw) as { version?: number; items?: unknown[] };
        if (typeof l.version === "number" && Array.isArray(l.items)) {
          lightning = { version: l.version, items: l.items };
        }
      } catch {}
    }

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

  // Capture the profile at push-start; if it changes mid-flight the result
  // will be dropped (stale guard below).
  const profileId = currentSyncProfileId;

  const payload = buildPayloadFromStorage(profileId);
  if (!payload) return;

  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).length > MAX_SYNC_BYTES) return;

  inFlight = true;
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
      // Only record the sync timestamp if the profile hasn't changed
      // since this request started — prevents writing a stale timestamp
      // to the new profile's key.
      if (currentSyncProfileId === profileId) {
        try {
          localStorage.setItem(lastSyncedKeyForProfile(profileId), new Date().toISOString());
        } catch {
          // quota errors must not crash the app
        }
      }
    }
    // 401 = not signed in, silently ignore
    // Other errors are also silently ignored; local data stays intact
  } catch {
    // Network errors are silently ignored — local data is always the fallback
  } finally {
    inFlight = false;
  }
}

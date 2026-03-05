/**
 * syncHelper — client-side Plans cloud sync (Phase 7.2)
 *
 * Usage:
 *   scheduleSync(payload)  — debounced push after every Plans mutation
 *   pullPlans()            — fetch cloud plans on sign-in
 *   registerUnloadSync(fn) — best-effort beacon push on page unload
 *
 * localStorage keys:
 *   dwp:sync:lastSyncedAt — ISO timestamp of last successful push
 */

export const LAST_SYNCED_KEY = "dwp:sync:lastSyncedAt";

// 500 KB soft cap — Plans payloads are typically < 50 KB.
const MAX_SYNC_BYTES = 500_000;
// Debounce window: wait this long after the last mutation before pushing.
const DEBOUNCE_MS = 3_000;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

// ── scheduleSync ─────────────────────────────────────────────────────────────

/**
 * Schedule a debounced cloud push.
 * Call this after every successful local Plans persist.
 * Silently no-ops in SSR or when the user is not signed in (401 responses are ignored).
 */
export function scheduleSync(payload: unknown): void {
  if (typeof window === "undefined") return; // SSR guard
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void doPush(payload);
  }, DEBOUNCE_MS);
}

// ── pullPlans ─────────────────────────────────────────────────────────────────

/**
 * Pull the latest cloud plans for the currently signed-in user.
 * Returns null when the user is signed out (401), has no cloud data (204),
 * or when a network error occurs.
 */
export async function pullPlans(): Promise<{
  version: number;
  items: unknown[];
} | null> {
  try {
    const res = await fetch("/api/sync/plans", { credentials: "include" });
    if (res.status === 204 || !res.ok) return null;
    const data = (await res.json()) as { plansJson?: unknown };
    // Validate basic shape before returning
    const pj = data.plansJson;
    if (
      pj &&
      typeof pj === "object" &&
      !Array.isArray(pj) &&
      typeof (pj as Record<string, unknown>).version === "number" &&
      Array.isArray((pj as Record<string, unknown>).items)
    ) {
      return pj as { version: number; items: unknown[] };
    }
    return null;
  } catch {
    return null;
  }
}

// ── registerUnloadSync ────────────────────────────────────────────────────────

/**
 * Register a beforeunload handler that sends a best-effort POST beacon.
 * Uses navigator.sendBeacon so the request outlives the page.
 * Returns a cleanup function; call it in useEffect cleanup.
 */
export function registerUnloadSync(getPayload: () => unknown): () => void {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return () => {};
  }

  const handler = (): void => {
    // Cancel any pending debounce — beacon takes over
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    const body = JSON.stringify(getPayload());
    if (body.length > MAX_SYNC_BYTES) return;
    navigator.sendBeacon(
      "/api/sync/plans",
      new Blob([body], { type: "application/json" })
    );
  };

  window.addEventListener("beforeunload", handler);
  return () => window.removeEventListener("beforeunload", handler);
}

// ── internal push ─────────────────────────────────────────────────────────────

async function doPush(payload: unknown): Promise<void> {
  if (inFlight) {
    // Re-schedule so the latest payload gets sent after the current request
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void doPush(payload), 1_000);
    return;
  }

  const body = JSON.stringify(payload);
  if (body.length > MAX_SYNC_BYTES) return;

  inFlight = true;
  try {
    const res = await fetch("/api/sync/plans", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body,
    });
    if (res.ok) {
      try {
        localStorage.setItem(LAST_SYNCED_KEY, new Date().toISOString());
      } catch {
        // quota errors must not crash the app
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

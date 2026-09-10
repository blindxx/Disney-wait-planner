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
 *   setSyncUserId(userId)        — call on auth transition to retarget sync
 *                                  (null when signed out/loading)
 *   scheduleSync()               — debounced push after any planner mutation
 *   pullPlanner(profileId)       — fetch combined cloud planner on sign-in
 *   registerUnloadSync()         — best-effort beacon push on page unload
 *   cancelScheduledSync()        — cancel pending sync (auth/profile transitions)
 *   getConfirmedSnapshot(userId, profileId)          — read the current
 *                                                       confirmed baseline
 *   commitConfirmedBaseline(userId, profileId,       — advance specific
 *     revision, accepted)                              domain(s) of that
 *                                                       baseline, gated by
 *                                                       server revision
 *
 * localStorage keys:
 *   dwp:sync:{profileId}:lastSyncedAt                  — ISO timestamp of
 *                                                         last successful push
 *   dwp:sync:{userId}:{profileId}:confirmedSnapshot    — the current
 *                                                         confirmed baseline
 *                                                         (see below)
 *
 * The synced payload (SyncedPlannerPayload) includes both plans and lightning
 * for the active profile. It is read fresh from localStorage at push time
 * so no payload needs to be passed through the call chain.
 *
 * ── Cloud-confirmed local snapshot contract (SH.2) ──────────────────────────
 *
 * "For authenticated user U and profile P, what exact planner snapshot is
 * the newest server-confirmed state?" — answered by
 * getConfirmedSnapshot(userId, profileId). A domain's confirmed value
 * represents "the state currently accepted as synchronized for this
 * domain" — NOT merely "the last successful PUT payload". It advances two
 * ways, both writing the SAME durable key:
 *   • doPush() (below) commits the literal request body of every
 *     SUCCESSFUL push, gated by the server-issued `revision` in that
 *     push's response.
 *   • commitConfirmedBaseline() (below) is called by a page's pull effect
 *     after a pull resolves, for whichever domain(s) it determined were
 *     cloud-won AND successfully persisted this pull — a domain a pull
 *     hydrates from cloud is just as validly "confirmed" as one a push
 *     just sent, and must advance the SAME record so a LATER pull never
 *     misclassifies that already-hydrated state as an unsynced local edit
 *     (Codex P1, 1st round), gated by the same pull's GET response
 *     `revision`. It reads the CURRENT confirmed record fresh (never a
 *     frozen pull-start snapshot) and replaces only the domain(s) passed
 *     in, leaving every other domain's confirmation exactly as it was —
 *     so it can never let an older write clobber a domain some OTHER
 *     concurrent commit (a push, or another tab's pull) already advanced
 *     further than this one knows about.
 *
 * Codex P1 fix (3rd round) — TWO further guarantees, both enforced by
 * nextConfirmedBaseline() (syncPayload.ts), which both commit paths above
 * delegate to:
 *   • Identity scope: the storage key is keyed by BOTH userId and
 *     profileId (confirmedSnapshotKeyForIdentity below) — "profile" is a
 *     LOCAL, per-device concept independent of which cloud account is
 *     signed in, so a bare profileId key would let account B, signing in
 *     after account A signs out on the same device/profile, read (and
 *     potentially re-confirm) account A's leftover confirmed record. With
 *     userId in the key, B's read is a DIFFERENT key A never touched —
 *     B's own confirmed state (or lack thereof) is unaffected by A ever
 *     having used this profile slot.
 *   • Revision ordering: every commit carries the server-issued `revision`
 *     that produced it (see api/sync/planner/route.ts's module doc for why
 *     this — not `updated_at`, not response arrival order — is the only
 *     authoritative ordering signal under concurrent writes). A commit
 *     whose revision is <= the currently-confirmed revision is rejected
 *     outright, so two concurrent pushes' responses arriving in EITHER
 *     order converge on the same final confirmed state — whichever
 *     server-committed LATER (higher revision), never whichever response
 *     happened to arrive at this tab last.
 *
 * Either way, the record is:
 *   • NEVER a fresh read of the current plans/lightning/days storage keys
 *     at the moment of commit — those are mutable and may already hold a
 *     newer, still-unaccepted edit; only the EXACT value this pull (or
 *     push) determined was accepted is ever written.
 *   • NEVER dependent on response/resolution timing — each commit is
 *     gated by server-issued revision, never by when the response happened
 *     to arrive or resolve.
 *   • NEVER dependent on which tab performed the push or pull —
 *     localStorage is shared across same-origin tabs, so any tab for this
 *     user+profile reads the identical value via a plain fresh read of the
 *     same durable key, and converges on the same newest revision
 *     regardless of which tab wrote it.
 * Consumers (plans/page.tsx, lightning/page.tsx) treat this as the single
 * source of truth for "was my current local content already accepted by
 * the cloud" — see captureConfirmedSnapshotForPull() in each page for how
 * a pull's OWN immutable baseline is frozen from it, and each page's pull
 * effect for how commitConfirmedBaseline() is called afterward.
 */

import { buildNamespacedKey } from "./profileStorage";
import {
  buildSyncedPlannerPayload,
  parseSyncedPlannerPayload,
  parseConfirmedPlannerSnapshot,
  nextConfirmedBaseline,
  type SyncedPlannerPayload,
  type ConfirmedPlannerSnapshot,
} from "./syncPayload";

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

/**
 * Returns the localStorage key for the confirmed planner snapshot for a
 * given (userId, profileId) pair. Codex P1 fix (3rd round) — keyed by BOTH:
 * "profile" is a LOCAL, per-device concept (e.g. a family member slot)
 * entirely independent of which cloud account is signed in, so a
 * profileId-only key would let a DIFFERENT account, signing into the same
 * profile slot on the same browser, read (and potentially build on) the
 * previous account's confirmed record. userId is resolved the same way the
 * server does (session.user.id, falling back to email) — see each page's
 * auth-transition effect for where this is read from useSession().
 */
export function confirmedSnapshotKeyForIdentity(userId: string, profileId: string): string {
  return `dwp:sync:${userId}:${profileId}:confirmedSnapshot`;
}

// ── Confirmed snapshot ────────────────────────────────────────────────────────

/**
 * Read the current ConfirmedPlannerSnapshot (revision + planner state) for
 * this authenticated user + profile — see the module doc's "Cloud-confirmed
 * local snapshot contract" above. Returns null when nothing has ever been
 * confirmed for this exact (userId, profileId) pair (fresh profile,
 * always-offline, never signed in, or a DIFFERENT account previously used
 * this profile slot) or the stored value is missing/corrupt — callers must
 * treat null as "nothing to compare against yet", not as an error.
 *
 * Safe to call from any tab: this is a plain localStorage read of a key
 * that is durable (survives reloads) and shared (every same-origin tab for
 * this browser sees the identical value), so it needs no message-passing
 * or event subscription to be correct — only a re-read at the moment the
 * caller wants an answer.
 */
export function getConfirmedSnapshot(userId: string, profileId: string): ConfirmedPlannerSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(confirmedSnapshotKeyForIdentity(userId, profileId));
    if (!raw) return null;
    return parseConfirmedPlannerSnapshot(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/**
 * Advance the confirmed baseline for whichever domain(s) a pull (or push —
 * see doPush() below) just determined were cloud-won AND successfully
 * persisted, gated by the server-issued `revision` that produced them —
 * see the module doc's "Cloud-confirmed local snapshot contract" above and
 * nextConfirmedBaseline()'s own doc in syncPayload.ts for the full merge +
 * revision-ordering rule.
 *
 * Reads the CURRENT confirmed record fresh (via getConfirmedSnapshot,
 * never a value the caller captured earlier) so this can never clobber a
 * domain — or regress a revision — some OTHER concurrent commit (a push,
 * or another tab's own pull/push) already advanced further than the caller
 * knows about; only the domain(s) present in `accepted` are ever
 * overwritten, and only when `revision` is strictly newer than whatever is
 * already confirmed. Best-effort: a write failure here (quota,
 * private-mode) is swallowed, matching the tier of every other
 * confirmed-state write in this module — it simply means the next pull
 * falls back to whatever was confirmed before.
 *
 * Call this AFTER persistence for the accepted domain(s) has already
 * succeeded — never speculatively before a write is known to have landed
 * ("failed persistence must not advance the baseline").
 */
export function commitConfirmedBaseline(
  userId: string,
  profileId: string,
  revision: number,
  accepted: {
    plans?: { version: number; items: unknown[] };
    lightning?: { version: number; items: unknown[] };
    days?: string[];
  }
): void {
  if (typeof window === "undefined") return;
  if (!accepted.plans && !accepted.lightning && !accepted.days) return;
  try {
    const current = getConfirmedSnapshot(userId, profileId);
    const next = nextConfirmedBaseline(current, revision, accepted);
    if (!next) return; // rejected — not newer than what's already confirmed
    localStorage.setItem(confirmedSnapshotKeyForIdentity(userId, profileId), JSON.stringify(next));
  } catch {}
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

/**
 * The authenticated user id that sync is currently targeting, used solely
 * to scope confirmed-baseline commits (Codex P1, 3rd round) — see
 * confirmedSnapshotKeyForIdentity's own doc. null while signed out or
 * before the session has resolved; doPush() skips the confirmed-baseline
 * commit step entirely when null (it never guesses an identity).
 * Updated by setSyncUserId().
 */
let currentSyncUserId: string | null = null;

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

// ── setSyncUserId ─────────────────────────────────────────────────────────────

/**
 * Set the authenticated user id that sync's confirmed-baseline commits
 * should target — call this on every auth transition (each page's
 * auth-transition effect, right where sessionStatus is read), passing
 * `session?.user?.id ?? session?.user?.email ?? null` (the same resolution
 * order the server uses — see getUserId() in api/sync/planner/route.ts).
 * If the identity changes (including transitioning to/from null on
 * sign-out/sign-in), any pending debounced push is cancelled first — a
 * push scheduled under a PRIOR identity must never be allowed to commit a
 * confirmed baseline under a NEW one, or vice versa.
 */
export function setSyncUserId(userId: string | null): void {
  if (userId === currentSyncUserId) return;
  cancelScheduledSync();
  currentSyncUserId = userId;
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
 *   SyncedPlannerPayload & { revision: number | null } — a valid combined
 *     planner payload was parsed. `revision` is the server-authoritative
 *     ordering value for this exact response (see api/sync/planner/
 *     route.ts's module doc) — null only if the server response
 *     unexpectedly omitted it (defensive; should not happen against this
 *     server build). Callers must treat a null `revision` as "cannot
 *     safely advance the confirmed baseline from this response" and skip
 *     the commitConfirmedBaseline() call entirely for it — never
 *     substitute 0 or any other sentinel, which could wrongly compare as
 *     "older" or, worse, coincidentally valid.
 *   null — no usable planner payload could be parsed; this includes: 204
 *     No Content (nothing stored yet), a payload that failed JSON parsing
 *     or shape validation in parseSyncedPlannerPayload(), or a legacy
 *     plans-only response that could not be normalized into the combined
 *     shape
 *
 * Throws on:
 *   non-OK HTTP responses (401, 5xx, etc.)
 *   network/fetch failures
 *
 * Callers must catch to distinguish "unknown failure" from "known empty".
 * A thrown error must NOT reopen the push gate — cloud state is uncertain.
 */
export async function pullPlanner(
  profileId: string
): Promise<(SyncedPlannerPayload & { revision: number | null }) | null> {
  const url = `/api/sync/planner?profileId=${encodeURIComponent(profileId)}`;
  const res = await fetch(url, { credentials: "include" });
  // Definitively empty — no planner stored for this user+profile yet
  if (res.status === 204) return null;
  // Any other non-OK status is a real failure; let it throw
  if (!res.ok) throw new Error(`sync/planner GET ${res.status}`);
  const data = (await res.json()) as { plannerJson?: unknown; revision?: unknown };
  const parsed = parseSyncedPlannerPayload(data.plannerJson ?? null);
  if (!parsed) return null;
  const revision = typeof data.revision === "number" && Number.isFinite(data.revision) ? data.revision : null;
  return { ...parsed, revision };
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
 * Phase 11.2 Codex fix — read the profile's locally persisted days[] order
 * (dwp:{profileId}:days, owned/written by the Plans page) for inclusion in
 * the sync payload. Returns undefined when the key is missing, unreadable,
 * or not an array — unlike plans/lightning, a missing or malformed local
 * `days` value is never a reason to abort the push: buildSyncedPlannerPayload
 * sanitizes whatever is returned here down to valid canonical day IDs (or
 * omits the field entirely), so this only needs to hand it the raw parsed
 * value, not pre-validate it.
 */
function readLocalDaysOrder(profileId: string): unknown[] | undefined {
  try {
    const raw = localStorage.getItem(buildNamespacedKey(profileId, "days"));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the current plans + lightning + days for a profile from localStorage
 * and construct a SyncedPlannerPayload.
 *
 * Returns null when:
 *   • localStorage is unavailable (SSR guard)
 *   • either the plans or lightning dataset contains malformed JSON or an
 *     unrecognised shape (prevents pushing stale/empty data over valid
 *     cloud state)
 *
 * Missing localStorage keys for plans/lightning are treated as empty
 * datasets (safe). Legacy array-only shapes are normalised automatically.
 * A missing/malformed local `days[]` is not fatal — see readLocalDaysOrder.
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

    const days = readLocalDaysOrder(profileId);
    return buildSyncedPlannerPayload(plans, lightning, days);
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

  // Capture the profile and user identity at push-start so all writes
  // target the originating profile/identity unconditionally, even if the
  // user switches profiles or signs into a different account mid-flight.
  const profileId = currentSyncProfileId;
  const userId = currentSyncUserId;

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
      // SH.2 architecture (Codex P1, 3rd round) — commit the EXACT payload
      // this request just sent as a CANDIDATE confirmed snapshot, gated by
      // the server-issued `revision` in this response (never blind
      // overwrite, never response-arrival order — see
      // commitConfirmedBaseline's own doc). Requires a known userId: if
      // this push somehow completed without one (should not happen, since
      // scheduleSync() is only ever invoked while authenticated), there is
      // no safe identity to commit under, so the confirmed-baseline step
      // is skipped entirely — lastSyncedAt/status above still record the
      // push's success for UI purposes regardless.
      if (userId) {
        try {
          const responseData = (await res.json()) as { revision?: unknown };
          const revision =
            typeof responseData.revision === "number" && Number.isFinite(responseData.revision)
              ? responseData.revision
              : null;
          if (revision !== null) {
            commitConfirmedBaseline(userId, profileId, revision, {
              plans: payload.plans,
              lightning: payload.lightning,
              days: payload.days,
            });
          }
        } catch {
          // Response body unreadable/malformed — cannot safely commit a
          // confirmed baseline without a known revision; the push itself
          // still succeeded (res.ok), only the local confirmation record
          // is skipped this time.
        }
      }
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

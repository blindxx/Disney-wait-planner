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
 *   await commitConfirmedBaseline(userId, profileId, — advance specific
 *     revision, accepted)                              domain(s) of that
 *                                                       baseline, gated by
 *                                                       server revision AND
 *                                                       serialized across
 *                                                       tabs (async — see
 *                                                       its own doc); fails
 *                                                       safe (no-op) if the
 *                                                       Web Locks API is
 *                                                       unavailable
 *   getLocalContentOwner(profileId)                  — read which identity
 *                                                       this profile's raw
 *                                                       local content is
 *                                                       currently attributed
 *                                                       to (see its own doc)
 *   setLocalContentOwner(profileId, userId)          — record that
 *                                                       attribution — ONLY
 *                                                       after a pull's final
 *                                                       coherent snapshot is
 *                                                       durably persisted
 *                                                       (6th round; see
 *                                                       each page's pull
 *                                                       effect)
 *   await resolvePendingBeaconAfterPull(userId,      — resolve a possibly-
 *     profileId, cloudRevision, cloudSnapshot)          beaconed local
 *                                                       snapshot against a
 *                                                       just-fetched GET
 *                                                       response (6th round;
 *                                                       see its own doc)
 *
 * localStorage keys:
 *   dwp:sync:{profileId}:lastSyncedAt                  — ISO timestamp of
 *                                                         last successful push
 *   dwp:sync:{profileId}:localContentOwner             — see
 *                                                         getLocalContentOwner's
 *                                                         own doc
 *   dwp:sync:{userId}:{profileId}:state                — the consolidated
 *                                                         sync identity state
 *                                                         for this user+
 *                                                         profile — confirmed
 *                                                         baseline AND any
 *                                                         pending beacon (see
 *                                                         SyncIdentityState in
 *                                                         syncPayload.ts and
 *                                                         the section below)
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
 *     profileId (syncIdentityStateKeyForIdentity below) — "profile" is a
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
 * Codex P1 fix (4th round) — revision ordering above is only correct if
 * the read-compute-write sequence that applies it is itself atomic; see
 * commitConfirmedBaseline()'s own doc for why a plain read-then-write is
 * NOT atomic across tabs, and how the Web Locks API closes that gap.
 * Codex P1 fix (5th round) — re-audited and hardened to FAIL SAFE (skip
 * the commit entirely) when the Locks API is unavailable, rather than
 * fall back to the unserialized sequence — see commitConfirmedBaseline's
 * own doc for why a "graceful" fallback there would silently reintroduce
 * the exact regression this mechanism exists to prevent.
 *
 * Codex P1 fix (5th round) — identity-scoping the BASELINE side of a
 * conflict decision (3rd round) is not sufficient on its own: the
 * CANDIDATE side (a fresh read of plans/lightning/days localStorage)
 * carries no identity attribution at all. See getLocalContentOwner()'s own
 * doc below for the authenticated-conflict-session boundary that closes
 * this — every conflict decision now verifies the candidate belongs to
 * the SAME authenticated context as the baseline before trusting it.
 *
 * Codex P1 fix (6th round) — TWO further gaps: (1) the 5th round's
 * ownership marker was written at the START of an auth transition, before
 * the pull it was meant to describe had even resolved — a failed or
 * cancelled pull left ownership relabeled to the new identity anyway, so a
 * LATER session for that identity would trust the PREVIOUS identity's
 * still-unreplaced bytes as its own. getLocalContentOwner()'s own doc
 * below now documents the corrected durable boundary: ownership transfers
 * ONLY after a pull's final coherent snapshot is actually persisted (see
 * each page's pull effect). (2) sendBeacon() can durably persist a newer
 * server snapshot without ever returning its revision, so the confirmed
 * baseline could be stuck stale indefinitely relative to what the server
 * actually has. See SyncIdentityState/resolveSyncIdentityStateAfterPull
 * (syncPayload.ts) and resolvePendingBeaconAfterPull (below) for how a
 * beaconed-but-unconfirmed snapshot is tracked and reconciled against the
 * next successful pull's own GET response.
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
  parseSyncIdentityState,
  nextConfirmedBaseline,
  resolveSyncIdentityStateAfterPull,
  type SyncedPlannerPayload,
  type ConfirmedPlannerSnapshot,
  type SyncIdentityState,
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
 * Returns the localStorage key for a profile's "local content owner"
 * marker — see getLocalContentOwner()/setLocalContentOwner() below (Codex
 * P1, 5th round).
 */
function localContentOwnerKeyForProfile(profileId: string): string {
  return `dwp:sync:${profileId}:localContentOwner`;
}

/**
 * SH.2 architecture (Codex P1, 5th round) — AUTHENTICATED CONFLICT SESSION
 * boundary. "For every SH.2 conflict decision, the baseline and local
 * candidate MUST belong to the same authenticated conflict context."
 * getConfirmedSnapshot()/commitConfirmedBaseline() already scope the
 * BASELINE side of every conflict decision by identity (userId+profileId).
 * Nothing, until this fix, scoped the CANDIDATE side: a fresh read of
 * plans/lightning/days localStorage carries no identity attribution at
 * all — it is whatever bytes are sitting under this profile's key,
 * regardless of which account last wrote them.
 *
 * Root cause this closes — account A can leave this profile's local
 * content in localStorage; if account B then signs in WITHOUT a page
 * remount (so B's pull effect runs against the SAME long-lived component
 * instance A's did), B's conflict decision compares a fresh "current" read
 * of that same, still-loaded storage against B's OWN baseline. Two
 * distinct baseline tiers can both be fooled by this:
 *   • The page-local FALLBACK ref (used when B has no confirmed snapshot
 *     yet in this browser) — A's leftover content simply becomes B's
 *     apparent "local edit" the moment current is compared against it.
 *   • A REAL, correctly userId-scoped confirmed snapshot for B (e.g. B
 *     used this exact browser before A did) — A's leftover content still
 *     differs from B's own last-confirmed state, so the comparison STILL
 *     reports "changed", even though B never touched anything this
 *     session. Identity-scoping the baseline alone (3rd round) does not
 *     protect against a mismatched CANDIDATE.
 * Either way, the foreign content gets classified as "this identity's own
 * unsynced winner" and can overwrite this identity's real cloud state on
 * the very next push.
 *
 * getLocalContentOwner(profileId) / setLocalContentOwner(profileId, userId)
 * are a small, explicit, per-profile durable marker recording which
 * identity's conflict session most recently established ownership of this
 * profile's local content. This is deliberately NOT a rescoping of the
 * plans/lightning/days storage keys themselves — their schema, key names,
 * and content are completely unchanged; this is one extra pointer used
 * purely to answer "does the content currently in this profile's storage
 * belong to the identity now asking about it" before any conflict
 * decision trusts a fresh read of that storage as candidate evidence. A
 * null/absent marker (a profile that has never been authenticated-tagged
 * before) is trusted for ANY identity — this is what preserves local-first
 * adoption for anonymous → first sign-in, and for a fresh profile's very
 * first authenticated use: there is no "other identity" to have owned it.
 * Only a marker naming a DIFFERENT, KNOWN identity is a mismatch.
 *
 * See each page's auth-transition effect for how this is CONSULTED (read
 * BEFORE being overwritten with the newly-resolved identity, so a
 * transition's own mismatch verdict reflects who owned the content going
 * INTO the transition) and how a mismatch is handled (every domain's
 * "current" read for that pull's conflict decision is substituted with
 * this pull's own frozen baseline, so it can never be misread as a local
 * edit — see the pull effect's own doc for the full substitution rule).
 *
 * Codex P1 fix (6th round) — DURABLE TRANSFER BOUNDARY. setLocalContentOwner()
 * must NEVER be called at the START of an auth transition, before the
 * pull it describes has resolved — doing so is exactly the bug Codex
 * flagged: a failed or cancelled pull would leave ownership relabeled to
 * the new identity while the profile's raw bytes are still the PREVIOUS
 * identity's, unreplaced. A LATER session for the new identity would then
 * see its OWN name on the marker (no mismatch detected) and wrongly trust
 * — and potentially push — the previous identity's leftover content as its
 * own confirmed-eligible local candidate.
 *
 * The corrected boundary: each page calls setLocalContentOwner() ONLY at
 * the END of its pull effect's `.then()`, and ONLY when ALL of the
 * following hold —
 *   (a) the pull was not cancelled/superseded (the pre-existing `cancelled`
 *       flag, checked as this callback's first statement, already
 *       guarantees this — a stale pull's callback returns before reaching
 *       ownership logic at all);
 *   (b) the pull did not throw (a `.catch()` branch never calls this);
 *   (c) this pull's own hydration/day writes succeeded (the SAME
 *       `hydrationSucceeded && !daysWriteFailed` condition that already
 *       gates `setSyncReady(true)` — a persistence failure means the local
 *       snapshot is not yet the coherent, durable one this identity should
 *       be credited with).
 * Only once all three hold has "the final coherent local snapshot" this
 * pull computed actually landed on disk (or been confirmed to already
 * match, requiring no write) — exactly the moment ownership is safe to
 * establish or reaffirm.
 */
export function getLocalContentOwner(profileId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(localContentOwnerKeyForProfile(profileId));
  } catch {
    return null;
  }
}

/**
 * See getLocalContentOwner()'s own doc for the full contract, especially
 * the DURABLE TRANSFER BOUNDARY (6th round) — call this ONLY after a
 * pull's final coherent snapshot has actually been persisted, never
 * speculatively at transition start. `userId` null is a no-op (defensive
 * only — callers only invoke this from the "authenticated" branch of their
 * auth-transition effect, where a real identity is expected; there is no
 * legitimate reason to tag ownership as "no one").
 */
export function setLocalContentOwner(profileId: string, userId: string | null): void {
  if (typeof window === "undefined" || userId === null) return;
  try {
    localStorage.setItem(localContentOwnerKeyForProfile(profileId), userId);
  } catch {}
}

/**
 * Returns the localStorage key for the CONSOLIDATED sync identity state for
 * a given (userId, profileId) pair — see SyncIdentityState's own doc in
 * syncPayload.ts (Codex P1, 6th round) for why `confirmed` and
 * `pendingBeacon` are stored together under one key, read-compute-written
 * as one atomic unit. Codex P1 fix (3rd round, carried forward) — keyed by
 * BOTH: "profile" is a LOCAL, per-device concept (e.g. a family member
 * slot) entirely independent of which cloud account is signed in, so a
 * profileId-only key would let a DIFFERENT account, signing into the same
 * profile slot on the same browser, read (and potentially build on) the
 * previous account's confirmed record. userId is resolved the same way the
 * server does (session.user.id, falling back to email) — see each page's
 * auth-transition effect for where this is read from useSession().
 *
 * Renamed from the pre-6th-round confirmedSnapshotKeyForIdentity (which
 * stored a bare ConfirmedPlannerSnapshot at
 * `dwp:sync:{userId}:{profileId}:confirmedSnapshot`) — the stored SHAPE
 * changed, not just this function's name, so a value written under the OLD
 * key name is never misread as this new shape. Any pre-existing confirmed
 * snapshot simply degrades to "nothing confirmed yet" (parseSyncIdentityState
 * treats an unrecognized value as null) and is re-established on the next
 * successful pull/push — exactly the same safe, already-hardened fallback
 * path a genuinely fresh profile's first confirmation takes.
 */
function syncIdentityStateKeyForIdentity(userId: string, profileId: string): string {
  return `dwp:sync:${userId}:${profileId}:state`;
}

// ── Sync identity state (confirmed snapshot + pending beacon) ──────────────────

/**
 * Read the current SyncIdentityState for this authenticated user + profile
 * — see its own doc in syncPayload.ts. Never null: an absent/corrupt
 * stored value degrades to `{ confirmed: null, pendingBeacon: null }`,
 * exactly like a fresh profile's first-ever read.
 *
 * Safe to call from any tab: this is a plain localStorage read of a key
 * that is durable (survives reloads) and shared (every same-origin tab for
 * this browser sees the identical value), so it needs no message-passing
 * or event subscription to be correct — only a re-read at the moment the
 * caller wants an answer.
 */
export function getSyncIdentityState(userId: string, profileId: string): SyncIdentityState {
  const EMPTY: SyncIdentityState = { confirmed: null, pendingBeacon: null };
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = localStorage.getItem(syncIdentityStateKeyForIdentity(userId, profileId));
    if (!raw) return EMPTY;
    return parseSyncIdentityState(JSON.parse(raw) as unknown) ?? EMPTY;
  } catch {
    return EMPTY;
  }
}

/**
 * Read just the confirmed baseline (revision + planner state) for this
 * authenticated user + profile — see the module doc's "Cloud-confirmed
 * local snapshot contract" above. Returns null when nothing has ever been
 * confirmed for this exact (userId, profileId) pair (fresh profile,
 * always-offline, never signed in, or a DIFFERENT account previously used
 * this profile slot) or the stored value is missing/corrupt — callers must
 * treat null as "nothing to compare against yet", not as an error.
 */
export function getConfirmedSnapshot(userId: string, profileId: string): ConfirmedPlannerSnapshot | null {
  return getSyncIdentityState(userId, profileId).confirmed;
}

/**
 * The Web Locks API name a mutation of this (userId, profileId) pair's
 * sync identity state acquires before its read-compute-write sequence —
 * see withSyncIdentityStateLock()'s own doc (Codex P1, 4th/6th rounds) for
 * why this is needed. Scoped identically to syncIdentityStateKeyForIdentity
 * so mutations for a DIFFERENT (userId, profileId) pair never contend with
 * each other, only concurrent mutations for the SAME pair (the only case
 * where regression is even possible).
 */
function syncIdentityStateLockNameForIdentity(userId: string, profileId: string): string {
  return `dwp:sync:${userId}:${profileId}:state:lock`;
}

/**
 * SH.2 architecture (Codex P1, 4th round, generalized 6th round) — the
 * SINGLE critical section every mutation of a (userId, profileId)'s sync
 * identity state goes through: commitConfirmedBaseline() and
 * resolvePendingBeaconAfterPull() (both below) are thin wrappers around
 * this, passing a pure `mutate` function that computes the next state from
 * the current one. Consolidating both callers onto one locked
 * read-compute-write primitive is what makes `confirmed` and
 * `pendingBeacon` genuinely ONE atomic unit (see SyncIdentityState's own
 * doc in syncPayload.ts) rather than two independently-racing writers of
 * the same key.
 *
 * Codex P1 fix (4th round) — the read, compute, and write here form a
 * single compound operation whose correctness depends on nothing else
 * changing the SAME durable record in between. Within one tab that's
 * automatic (JS is single-threaded and nothing here awaits mid-sequence),
 * but ACROSS TABS it is not: two tabs can each call this function at
 * effectively the same wall-clock moment, both read the SAME "current"
 * value before either has written, both independently compute a `next`
 * that looks valid relative to that shared stale read, and then both
 * write — whichever write lands LAST wins outright, even if it should have
 * lost (a plain read-then-write sequence has no way to detect that a
 * different write landed in the gap between this tab's own read and
 * write). The fix is to make the whole read-compute-write sequence a
 * single critical section, serialized across every tab of this origin,
 * using the Web Locks API (`navigator.locks`) — `navigator.locks.request(name, fn)`
 * queues concurrent requests for the same `name` and runs `fn` for only one
 * requester at a time, in every tab, with no window for two `fn` bodies to
 * interleave. Under the lock, whichever mutation runs SECOND always
 * re-reads the OTHER's just-written value as `current`, so the final
 * result is deterministic regardless of which tab's request was queued
 * first — there is no unserialized window left to race in, not a smaller
 * one.
 *
 * Codex P1 fix (5th round) — re-audited whether falling back to an
 * unserialized sequence when `navigator.locks` is unavailable was an
 * acceptable trade-off for a CORRECTNESS invariant. It is not: "graceful
 * degradation" here means silently reintroducing the exact cross-tab
 * regression the lock exists to close, with no signal that the safety
 * property no longer holds. This function therefore FAILS SAFE: when
 * `navigator.locks` is unavailable (older browsers, or a non-secure
 * context — Locks API requires a secure context), it does NOT mutate
 * anything, rather than mutate through an unprotected path that could
 * regress. The practical effect in that environment is that
 * confirmed-baseline/pending-beacon hardening simply never activates —
 * every pull falls back to the pre-confirmation baseline/ownership-tag
 * tiers (see getLocalContentOwner()'s own doc), a known, narrower, and
 * strictly safer degradation than knowingly permitting the monotonic-
 * revision invariant to be violated.
 *
 * `mutate` receives the CURRENT state fresh (never a value the caller
 * captured earlier) and must return the next state to persist — it may
 * return the SAME object (or an equal one) to signal "no change needed";
 * this function does not special-case that, since writing an unchanged
 * value back is harmless. Errors thrown by `mutate` or the write itself
 * are swallowed (best-effort tier, matching every other confirmed-state
 * write in this module) — the caller learns nothing back from a failure
 * except that the mutation silently didn't happen.
 */
async function withSyncIdentityStateLock(
  userId: string,
  profileId: string,
  mutate: (current: SyncIdentityState) => SyncIdentityState
): Promise<void> {
  if (typeof window === "undefined") return;
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  // Codex P1 fix (5th round) — fail safe: no lock, no mutation. See this
  // function's own doc above for why an unserialized fallback is never an
  // acceptable substitute for atomicity here.
  if (!locks) return;
  try {
    await locks.request(syncIdentityStateLockNameForIdentity(userId, profileId), () => {
      try {
        const current = getSyncIdentityState(userId, profileId);
        const next = mutate(current);
        localStorage.setItem(syncIdentityStateKeyForIdentity(userId, profileId), JSON.stringify(next));
      } catch {}
    });
  } catch {
    // Locks API present but the request itself failed unexpectedly — the
    // mutation is simply dropped (best-effort tier), never retried through
    // an unprotected path.
  }
}

/**
 * Advance the confirmed baseline for whichever domain(s) a pull (or push —
 * see doPush() below) just determined were cloud-won AND successfully
 * persisted, gated by the server-issued `revision` that produced them —
 * see the module doc's "Cloud-confirmed local snapshot contract" above and
 * nextConfirmedBaseline()'s own doc in syncPayload.ts for the full merge +
 * revision-ordering rule. `pendingBeacon` (if any) is left completely
 * untouched by this call — only resolvePendingBeaconAfterPull() below ever
 * changes it, since only a fresh GET response can conclusively resolve it.
 *
 * Call this AFTER persistence for the accepted domain(s) has already
 * succeeded — never speculatively before a write is known to have landed
 * ("failed persistence must not advance the baseline").
 */
export async function commitConfirmedBaseline(
  userId: string,
  profileId: string,
  revision: number,
  accepted: {
    plans?: { version: number; items: unknown[] };
    lightning?: { version: number; items: unknown[] };
    days?: string[];
  }
): Promise<void> {
  if (typeof window === "undefined") return;
  if (!accepted.plans && !accepted.lightning && !accepted.days) return;
  await withSyncIdentityStateLock(userId, profileId, (current) => {
    const next = nextConfirmedBaseline(current.confirmed, revision, accepted);
    return next ? { confirmed: next, pendingBeacon: current.pendingBeacon } : current;
  });
}

/**
 * SH.2 architecture (Codex P1, 6th round) — BEACON UNCERTAINTY resolution.
 * Call this after EVERY successful pull (a genuinely resolved GET — never
 * from a `.catch()` branch, which teaches nothing about a pending beacon's
 * fate) for the SAME (userId, profileId) the pull was for, passing the
 * GET's own `revision`/parsed snapshot (both null for a definitive 204).
 *
 * Delegates to resolveSyncIdentityStateAfterPull() (syncPayload.ts) for the
 * actual decision — see its own doc for the full delivered/undelivered
 * contract — under the SAME lock every other sync-identity-state mutation
 * uses, so this can never race commitConfirmedBaseline() for the same
 * identity into an inconsistent combination of `confirmed`/`pendingBeacon`.
 * Safe (and expected) to call even when no pendingBeacon exists — it is
 * then a harmless no-op pass-through of `confirmed`.
 */
export async function resolvePendingBeaconAfterPull(
  userId: string,
  profileId: string,
  cloudRevision: number | null,
  cloudSnapshot: SyncedPlannerPayload | null
): Promise<void> {
  if (typeof window === "undefined") return;
  await withSyncIdentityStateLock(userId, profileId, (current) =>
    resolveSyncIdentityStateAfterPull(current, cloudRevision, cloudSnapshot)
  );
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
 * The authenticated user id that sync is currently targeting, used to
 * scope confirmed-baseline commits (Codex P1, 3rd round) and pending-beacon
 * marking (Codex P1, 6th round) — see syncIdentityStateKeyForIdentity's own
 * doc. null while signed out or before the session has resolved; doPush()
 * and registerUnloadSync() both skip their respective identity-scoped
 * writes entirely when null (neither ever guesses an identity).
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
 *
 * Codex P1 fix (6th round) — BEACON UNCERTAINTY. sendBeacon()'s boolean
 * return only means "the browser accepted this for background delivery",
 * never "the server received and persisted it" — by the time any response
 * would arrive, this page is already gone, so there is no revision to read
 * back the way doPush() gets one. Treating a queued beacon as silently
 * equivalent to "nothing happened" is what let a beacon-persisted newer
 * server snapshot go unrecognized by this device's own confirmed baseline
 * (Codex finding): the NEXT session would still compare against the OLD
 * confirmed revision and could misclassify or even overwrite the
 * server-authoritative state the beacon itself just established.
 *
 * The fix: when sendBeacon() reports the request was queued, record the
 * EXACT payload just queued as this identity's `pendingBeacon` (see
 * SyncIdentityState's own doc in syncPayload.ts) — never a revision (none
 * exists to record) and never a client timestamp. The next successful pull
 * for this SAME (userId, profileId) resolves the uncertainty conclusively
 * against the server's own GET response — see resolvePendingBeaconAfterPull's
 * own doc and each page's pull effect for where that happens.
 *
 * This write is deliberately a SYNCHRONOUS, direct read-merge-write — NOT
 * routed through withSyncIdentityStateLock(), unlike every other mutation
 * of this record. beforeunload cannot reliably await async work (
 * navigator.locks.request always returns a Promise, even for a synchronous
 * callback) before the page is torn down; skipping the lock here trades an
 * astronomically unlikely same-instant cross-tab race — self-healing on
 * either side's next pull regardless — for actually guaranteeing the
 * pending marker gets written at all, which is the one property this whole
 * mechanism depends on.
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
    const userId = currentSyncUserId;
    const payload = buildPayloadFromStorage(profileId);
    if (!payload) return;
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).length > MAX_SYNC_BYTES) return;
    const queued = navigator.sendBeacon(
      `/api/sync/planner?profileId=${encodeURIComponent(profileId)}`,
      new Blob([body], { type: "application/json" })
    );
    if (queued && userId) {
      try {
        const current = getSyncIdentityState(userId, profileId);
        const next: SyncIdentityState = { confirmed: current.confirmed, pendingBeacon: payload };
        localStorage.setItem(syncIdentityStateKeyForIdentity(userId, profileId), JSON.stringify(next));
      } catch {}
    }
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
            await commitConfirmedBaseline(userId, profileId, revision, {
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

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
 *   listPendingOps(userId, profileId)                — read ALL currently
 *                                                       pending (unresolved
 *                                                       or not-yet-durably-
 *                                                       retired) unload
 *                                                       beacon opIds for
 *                                                       this identity (9th
 *                                                       round; see its own
 *                                                       doc — replaces the
 *                                                       7th/8th rounds'
 *                                                       single-opId
 *                                                       getPendingBeaconOpId)
 *   await reconcilePendingOperations(userId,          — resolve EVERY
 *     profileId, opStatuses, cloudRevision,              pending op this
 *     cloudSnapshot)                                     SAME GET response
 *                                                         reported on
 *                                                         against a
 *                                                         server-verified
 *                                                         fact each, and
 *                                                         retire ONLY the
 *                                                         ones whose
 *                                                         confirmed-baseline
 *                                                         promotion is
 *                                                         DURABLY confirmed
 *                                                         to have succeeded
 *                                                         (9th round; see
 *                                                         its own doc — MUST
 *                                                         be awaited and its
 *                                                         effect folded into
 *                                                         this pull's
 *                                                         baseline BEFORE
 *                                                         winner selection)
 *
 * localStorage keys:
 *   dwp:sync:{profileId}:lastSyncedAt                  — ISO timestamp of
 *                                                         last successful push
 *   dwp:sync:{profileId}:localContentOwner             — see
 *                                                         getLocalContentOwner's
 *                                                         own doc
 *   dwp:sync:{userId}:{profileId}:confirmedSnapshot    — the durable
 *                                                         confirmed
 *                                                         ConfirmedPlannerSnapshot
 *                                                         for this user+
 *                                                         profile, mutated
 *                                                         ONLY under
 *                                                         withConfirmedSnapshotLock
 *   dwp:sync:{userId}:{profileId}:pendingOp:{opId}     — ONE key PER
 *                                                         still-pending
 *                                                         unload beacon
 *                                                         opId for this
 *                                                         user+profile (9th
 *                                                         round; see the
 *                                                         "Pending
 *                                                         operations"
 *                                                         section below) —
 *                                                         deliberately
 *                                                         per-operation
 *                                                         rather than a
 *                                                         single mutable
 *                                                         scalar or a
 *                                                         compound
 *                                                         set/array, so
 *                                                         adding OR removing
 *                                                         one op is a single
 *                                                         unconditional
 *                                                         key write/delete
 *                                                         that can never
 *                                                         race or clobber a
 *                                                         DIFFERENT op's key
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
 * actually has — the 6th round tracked this via a consolidated
 * SyncIdentityState (confirmed + pendingBeacon in one record) and resolved
 * it by comparing the pending payload's CONTENT against a later GET.
 *
 * Codex P1 fix (7th round) — the 6th round's content-comparison beacon
 * resolution was unsound: `user_planner` keeps no history, so "beacon B
 * failed" and "beacon B succeeded, then a newer write C superseded it" are
 * OBSERVATIONALLY IDENTICAL from a single GET's content alone (both show
 * "current cloud content differs from what B sent"). No client-side
 * heuristic can tell them apart — the fix is a minimal SERVER-VERIFIABLE
 * write-acknowledgment: a client-generated opaque `clientOpId`
 * (crypto.randomUUID(), never a timestamp, never used for ordering) that
 * the server durably records as accepted (see `user_planner_writes` in
 * db-schema.sql), independent of the row's later content. A subsequent
 * pull's GET, given the pending opId as `lastOpId`, gets back a conclusive
 * `opStatus.found` fact from the server — see resolveConfirmedAfterBeacon()
 * (syncPayload.ts) and resolveConfirmedSnapshotAfterBeacon() (below).
 *
 * This also required SEPARATING `pendingBeaconOpId` from `confirmed` onto
 * its own, independent, UNLOCKED key (pendingBeaconOpIdKeyForIdentity
 * below) — the 6th round's consolidation of both fields into one
 * Web-Locks-protected record required registerUnloadSync()'s beforeunload
 * write (which cannot reliably await a lock) to touch that SAME locked
 * record, which is exactly the metadata race Codex flagged for the 7th
 * round (pending-beacon state read-modify-written unlocked while confirmed
 * state used Web Locks). Now `pendingBeaconOpId` needs no read-modify-write
 * at all — it is a single opaque scalar, always fully overwritten by
 * whichever beacon fires last.
 *
 * Codex P1 fix (9th round) — the 7th/8th rounds' "last-write-wins, only the
 * MOST RECENT beacon matters" assumption was itself a bug: it is a "latest
 * only" timing heuristic the round-8 directive already warns against, and
 * it actively DESTROYS evidence. If tab 1 registers pending beacon A and
 * tab 2 later registers pending beacon B (both still genuinely unresolved),
 * overwriting the single scalar key to B silently discards A — no pull will
 * ever check A's fate again, even though A might still be sitting,
 * unaccepted, in some queue. Separately, the 8th round's
 * resolveConfirmedSnapshotAfterBeacon() cleared the pending marker BEFORE
 * confirming that the paired confirmed-baseline promotion had durably
 * succeeded — if Web Locks were unavailable, or the lock request failed, or
 * the promotion was itself rejected as stale, the marker was already gone
 * while the baseline it was supposed to gate remained un-promoted, again
 * losing the evidence needed to retry later.
 *
 * Both bugs share one cause: treating "pending operations" as a single
 * mutable slot instead of a durable, per-operation SET. The fix replaces
 * `pendingBeaconOpId` with one INDEPENDENT localStorage key PER pending
 * opId (`dwp:sync:{userId}:{profileId}:pendingOp:{opId}` — see the "Pending
 * operations" section below). Registering a new op is then a pure,
 * unconditional single-key write — no read of any existing set required,
 * so it can never race or clobber a DIFFERENT op's key, satisfying the
 * cross-tab requirement without any lock at all. Retiring an op is a pure,
 * unconditional single-key delete, gated on the SAME op's confirmed-
 * baseline promotion having been PROVEN to run to completion under
 * withConfirmedSnapshotLock (see its updated return contract and
 * reconcilePendingOperations() below) — never before. `confirmed` remains
 * exclusively mutated under the lock; each pending-op key is exclusively
 * mutated by plain, unconditional, single-key writes/deletes. No field is
 * ever touched by both a locked and an unlocked writer, and no two
 * DIFFERENT operations' evidence ever shares a key.
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
  resolveConfirmedAfterBeacon,
  type SyncedPlannerPayload,
  type ConfirmedPlannerSnapshot,
} from "./syncPayload";

/**
 * The server's conclusive answer (see api/sync/planner/route.ts's GET
 * handler) to "was the write tagged with this opId ever accepted" — see
 * resolveConfirmedAfterBeacon()'s own doc in syncPayload.ts for the full
 * decision this feeds into.
 */
export interface OpStatus {
  opId: string;
  found: boolean;
  revision: number | null;
}

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
 * Returns the localStorage key for the durable confirmed baseline
 * (ConfirmedPlannerSnapshot) for a given (userId, profileId) pair. Codex P1
 * fix (3rd round, carried forward) — keyed by BOTH: "profile" is a LOCAL,
 * per-device concept (e.g. a family member slot) entirely independent of
 * which cloud account is signed in, so a profileId-only key would let a
 * DIFFERENT account, signing into the same profile slot on the same
 * browser, read (and potentially build on) the previous account's
 * confirmed record. userId is resolved the same way the server does
 * (session.user.id, falling back to email) — see each page's
 * auth-transition effect for where this is read from useSession().
 *
 * Codex P1 fix (7th round) — reverted the 6th round's consolidation of
 * this record with `pendingBeacon` into one `:state` key (formerly
 * SyncIdentityState). `pendingBeaconOpId` is now tracked completely
 * independently (see pendingBeaconOpIdKeyForIdentity below) — see the
 * module doc's 7th-round paragraph for why. A value written under the
 * 6th round's `:state` key name is a DIFFERENT shape and is never misread
 * as a bare ConfirmedPlannerSnapshot (parseConfirmedPlannerSnapshot
 * requires a top-level `revision`, which that shape never had) — this key
 * name reverts to the pre-6th-round name specifically so no stale `:state`
 * value is ever read from here at all.
 */
function confirmedSnapshotKeyForIdentity(userId: string, profileId: string): string {
  return `dwp:sync:${userId}:${profileId}:confirmedSnapshot`;
}

// ── Confirmed snapshot (Web-Locks-protected) ────────────────────────────────────

/**
 * Read just the confirmed baseline (revision + planner state) for this
 * authenticated user + profile — see the module doc's "Cloud-confirmed
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
 * The Web Locks API name a mutation of this (userId, profileId) pair's
 * confirmed snapshot acquires before its read-compute-write sequence — see
 * withConfirmedSnapshotLock()'s own doc (Codex P1, 4th/6th rounds) for why
 * this is needed. Scoped identically to confirmedSnapshotKeyForIdentity so
 * mutations for a DIFFERENT (userId, profileId) pair never contend with
 * each other, only concurrent mutations for the SAME pair (the only case
 * where regression is even possible).
 */
function confirmedSnapshotLockNameForIdentity(userId: string, profileId: string): string {
  return `dwp:sync:${userId}:${profileId}:confirmedSnapshot:lock`;
}

/**
 * SH.2 architecture (Codex P1, 4th round; scope narrowed back to just the
 * confirmed snapshot in the 7th round) — the SINGLE critical section every
 * mutation of a (userId, profileId)'s confirmed snapshot goes through:
 * commitConfirmedBaseline() and reconcilePendingOperations() (both below)
 * are thin wrappers around this, passing a pure `mutate` function that
 * computes the next snapshot from the current one (or null to signal
 * "no change" — see below).
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
 * confirmed-baseline hardening simply never activates — every pull falls
 * back to the pre-confirmation baseline/ownership-tag tiers (see
 * getLocalContentOwner()'s own doc), a known, narrower, and strictly safer
 * degradation than knowingly permitting the monotonic-revision invariant
 * to be violated.
 *
 * `mutate` receives the CURRENT confirmed snapshot fresh (never a value the
 * caller captured earlier) and must return the next snapshot to persist,
 * or `null` to mean "nothing to persist" — either because there is
 * genuinely no change (nextConfirmedBaseline rejected a stale/duplicate
 * revision) or because `current` was already null and stays null. A `null`
 * return never triggers a write — this is what makes "reject, keep
 * whatever is already stored" and "there was never anything to store"
 * indistinguishable in effect, which is correct here since neither case
 * ever needs `confirmedSnapshot`'s key to change.
 *
 * Codex P1 fix (9th round) — RETURN CONTRACT for callers that need to know
 * whether the mutation actually ran (reconcilePendingOperations() below is
 * exactly such a caller: retiring a pending op's evidence must never happen
 * before its paired promotion is PROVEN to have run to completion under
 * this lock). Returns:
 *   • `undefined` — did NOT run under the lock at all: no Web Locks API
 *     (SSR, older browser, non-secure context), or the `locks.request()`
 *     call itself failed, or `mutate`/the write threw inside the locked
 *     section. The caller must treat this as "unknown — nothing was
 *     durably established," never as a successful no-op.
 *   • the resulting `ConfirmedPlannerSnapshot | null` — the lock WAS
 *     acquired and `mutate` DID run to completion: either a NEW value was
 *     computed and durably written (returned here), or `mutate` returned
 *     `null` (no change needed — `current` is returned instead, itself
 *     still a fully valid, freshly-read value, e.g. because a CONCURRENT
 *     commit already advanced confirmed past what this call would have
 *     written — see nextConfirmedBaseline's own doc). Either way the
 *     caller can trust this return value as an accurate post-lock read.
 * commitConfirmedBaseline() (below) simply awaits and discards this value
 * (an ordinary cloud-won-domain commit has no follow-on evidence to
 * retire); reconcilePendingOperations() inspects it directly.
 */
async function withConfirmedSnapshotLock(
  userId: string,
  profileId: string,
  mutate: (current: ConfirmedPlannerSnapshot | null) => ConfirmedPlannerSnapshot | null
): Promise<ConfirmedPlannerSnapshot | null | undefined> {
  if (typeof window === "undefined") return undefined;
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  // Codex P1 fix (5th round) — fail safe: no lock, no mutation. See this
  // function's own doc above for why an unserialized fallback is never an
  // acceptable substitute for atomicity here.
  if (!locks) return undefined;
  try {
    return await locks.request(confirmedSnapshotLockNameForIdentity(userId, profileId), () => {
      try {
        const current = getConfirmedSnapshot(userId, profileId);
        const next = mutate(current);
        if (next) {
          localStorage.setItem(confirmedSnapshotKeyForIdentity(userId, profileId), JSON.stringify(next));
          return next;
        }
        return current;
      } catch {
        return undefined;
      }
    });
  } catch {
    // Locks API present but the request itself failed unexpectedly — the
    // mutation is simply dropped (best-effort tier), never retried through
    // an unprotected path.
    return undefined;
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
  await withConfirmedSnapshotLock(userId, profileId, (current) =>
    nextConfirmedBaseline(current, revision, accepted)
  );
}

// ── Pending operations (one UNLOCKED key PER opId — see module doc, 9th round) ──

/**
 * SH.2 architecture (Codex P1, 9th round) — PENDING UNLOAD OPERATIONS ARE
 * DURABLE UNRESOLVED FACTS, one per client-generated opId, tracked
 * independently. Replaces the 7th/8th rounds' single mutable
 * `pendingBeaconOpId` scalar — see the module doc's 9th-round paragraph for
 * the full root-cause analysis of why a single slot (and clearing it before
 * promotion was proven durable) both lost operation evidence.
 *
 * The key is namespaced PER opId: `dwp:sync:{userId}:{profileId}:pendingOp:{opId}`.
 * This is the entire mechanism that makes registration and retirement
 * race-free without any lock:
 *   • Registering op X (addPendingOp, called from registerUnloadSync's
 *     beforeunload handler, which cannot reliably await a lock) is ONE
 *     unconditional `setItem` on X's OWN key — no read of any other op's
 *     state, no read of X's own prior state either (there is nothing
 *     meaningful to merge; a duplicate registration of the same opId is
 *     just the same value written again). Two tabs registering DIFFERENT
 *     opIds touch DIFFERENT keys — physically impossible to race.
 *   • Retiring op X (removePendingOp, called only from
 *     reconcilePendingOperations() below, only after X's confirmed-baseline
 *     promotion is durably confirmed) is ONE unconditional `removeItem` on
 *     X's OWN key — it cannot ever touch, corrupt, or accidentally clear a
 *     DIFFERENT still-pending op Y's key, unlike a compare-and-clear (or
 *     any read-modify-write) against a single shared scalar or a compound
 *     set/array value would.
 * `listPendingOps` reads the CURRENT full set by scanning localStorage for
 * this prefix — a plain, unlocked enumeration is safe here because each
 * entry's own presence/absence is independently, atomically true or false
 * at any instant; there is no cross-entry invariant a scan could observe
 * "half-updated".
 */
const PENDING_OP_PREFIX_TEMPLATE = (userId: string, profileId: string): string =>
  `dwp:sync:${userId}:${profileId}:pendingOp:`;

function pendingOpKeyForIdentity(userId: string, profileId: string, opId: string): string {
  return `${PENDING_OP_PREFIX_TEMPLATE(userId, profileId)}${opId}`;
}

/**
 * Read every currently-pending unload-beacon opId for this user + profile —
 * see each page's pull effect for how this is read BEFORE a pull's fetch
 * (to pass as `lastOpIds`) and reconcilePendingOperations() below for how
 * an individual entry is retired once its promotion durably succeeds.
 * Order is not meaningful (see reconcilePendingOperations' own doc for why
 * no ordering assumption is needed — every accepted op in a pull's response
 * resolves against the SAME server-current snapshot/revision).
 */
export function listPendingOps(userId: string, profileId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const prefix = PENDING_OP_PREFIX_TEMPLATE(userId, profileId);
    const opIds: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        opIds.push(key.slice(prefix.length));
      }
    }
    return opIds;
  } catch {
    return [];
  }
}

function addPendingOp(userId: string, profileId: string, opId: string): void {
  try {
    localStorage.setItem(pendingOpKeyForIdentity(userId, profileId, opId), opId);
  } catch {}
}

function removePendingOp(userId: string, profileId: string, opId: string): void {
  try {
    localStorage.removeItem(pendingOpKeyForIdentity(userId, profileId, opId));
  } catch {}
}

/**
 * SH.2 architecture (Codex P1, 7th–9th rounds) — BEACON UNCERTAINTY
 * resolution via server-verified operation identity, generalized to a
 * pending-operation SET. Call this after EVERY successful pull (a
 * genuinely resolved GET — never from a `.catch()` branch, which teaches
 * nothing about any pending op's fate) for the SAME (userId, profileId) the
 * pull was for, passing:
 *   • `opStatuses` — this SAME GET response's own server-verified fact for
 *     EVERY opId this pull queried (see pullPlanner()'s own doc) — one
 *     entry per opId in `listPendingOps()`'s result at the time this pull's
 *     fetch started. Never inferred from content comparison or timing.
 *   • `cloudRevision`/`cloudSnapshot` — this SAME GET response's own
 *     revision/snapshot (both null for a 204/unparseable response).
 *
 * DETERMINISTIC MULTI-OP POLICY — every op this pull queried is resolved,
 * unconditionally, every pull; there is no "pick the latest" or "pick the
 * oldest" heuristic to get wrong, because there is nothing to pick: all of
 * them are checked. All ops found `accepted` in the SAME pull share the
 * SAME target: THIS GET response's own current `cloudSnapshot`/
 * `cloudRevision` (there is only ever one row per (user, profile) —
 * op-specific revisions are a ledger fact used only to answer "accepted or
 * not", never to select which content to adopt). This is what lets an
 * older accepted op (e.g. opA, server revision 5) retire safely once a
 * newer op (opB, revision 6) has ALSO been accepted and this pull's own GET
 * reports the row at revision 6: promoting confirmed to revision 6 (via
 * resolveConfirmedAfterBeacon(), which routes through the existing
 * monotonic nextConfirmedBaseline() gate) is what BOTH opA's and opB's
 * "accepted" status resolve into — opA's own promotion attempt, if it were
 * separately tried against revision 6, would simply be rejected as stale
 * by nextConfirmedBaseline() and reduce to "already subsumed", which
 * withConfirmedSnapshotLock's return contract (see its own doc) reports
 * identically to "just wrote it" — a REAL server revision fact, never a
 * client ordering assumption, is what proves the older op is subsumed.
 *
 * REMOVE-AFTER-PROMOTION RULE (fixes Codex P1 finding #1 from the 9th
 * round): an accepted op's pending entry is retired ONLY when
 * withConfirmedSnapshotLock's return value (see its own doc) is NOT
 * `undefined` — i.e. the lock was actually acquired and the mutation
 * (write, or a proven-already-subsumed no-op) ran to completion. If Web
 * Locks are unavailable, or the lock request fails, or an internal error
 * occurs, the return is `undefined` and EVERY accepted op from this pull is
 * left pending for a later pull to retry — never retired speculatively
 * ahead of durable proof. An op the server reports as NOT found (not yet
 * accepted) is never touched either way, positively or negatively — it
 * simply remains pending, exactly matching "an unaccepted/not-yet-seen op
 * remains pending".
 *
 * The promotion attempt itself runs at most ONCE per pull (not once per
 * accepted op) since — per the policy above — every accepted op in one
 * pull shares the same target; its single result is then applied to
 * retire every accepted-and-found op from `opStatuses` together. This is
 * both simpler and correct.
 */
export async function reconcilePendingOperations(
  userId: string,
  profileId: string,
  opStatuses: OpStatus[],
  cloudRevision: number | null,
  cloudSnapshot: SyncedPlannerPayload | null
): Promise<void> {
  const acceptedOpIds = opStatuses.filter((s) => s.found).map((s) => s.opId);
  if (acceptedOpIds.length === 0) return;
  if (typeof window === "undefined") return;
  const result = await withConfirmedSnapshotLock(userId, profileId, (current) =>
    resolveConfirmedAfterBeacon(current, true, cloudRevision, cloudSnapshot)
  );
  // `undefined` means the lock was never acquired / the mutation never ran
  // to completion — durable proof does not exist, so every accepted op
  // from this pull stays pending rather than being retired speculatively.
  if (result === undefined) return;
  for (const opId of acceptedOpIds) {
    removePendingOp(userId, profileId, opId);
  }
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
 * scope confirmed-baseline commits (Codex P1, 3rd round) and pending-op
 * registration (Codex P1, 6th/7th/9th rounds) — see
 * confirmedSnapshotKeyForIdentity's and pendingOpKeyForIdentity's own docs.
 * null while signed out or before the session has resolved; doPush()
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

function parseOpStatus(raw: unknown): OpStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.opId !== "string" || typeof r.found !== "boolean") return null;
  const revision = typeof r.revision === "number" && Number.isFinite(r.revision) ? r.revision : null;
  return { opId: r.opId, found: r.found, revision };
}

function parseOpStatuses(raw: unknown): OpStatus[] {
  if (!Array.isArray(raw)) return [];
  const parsed: OpStatus[] = [];
  for (const entry of raw) {
    const status = parseOpStatus(entry);
    if (status) parsed.push(status);
  }
  return parsed;
}

/**
 * Pull the latest combined planner blob for the signed-in user + profile.
 *
 * `lastOpIds` (Codex P1, 7th round; generalized to a set in the 9th) is
 * OPTIONAL — pass the FULL current pending-operation set (listPendingOps())
 * when non-empty, so the server can attach a conclusive `opStatuses` entry
 * (see api/sync/planner/route.ts's GET doc) for EACH one to this SAME
 * response. Omit (or pass an empty array) for an ordinary pull with no
 * pending operations to resolve.
 *
 * Returns:
 *   SyncedPlannerPayload & { revision: number | null; opStatuses: OpStatus[] } —
 *     a valid combined planner payload was parsed. `revision` is the
 *     server-authoritative ordering value for this exact response (see
 *     api/sync/planner/route.ts's module doc) — null only if the server
 *     response unexpectedly omitted it (defensive; should not happen
 *     against this server build). Callers must treat a null `revision` as
 *     "cannot safely advance the confirmed baseline from this response"
 *     and skip the commitConfirmedBaseline() call entirely for it — never
 *     substitute 0 or any other sentinel, which could wrongly compare as
 *     "older" or, worse, coincidentally valid. `opStatuses` is `[]` when
 *     `lastOpIds` was not supplied/empty, or the server response omitted/
 *     malformed it (defensive) — callers should treat a missing entry for
 *     a queried opId the same as `found: false` for it (still pending).
 *   null — no usable planner payload could be parsed; this includes: 204
 *     No Content (nothing stored yet), a payload that failed JSON parsing
 *     or shape validation in parseSyncedPlannerPayload(), or a legacy
 *     plans-only response that could not be normalized into the combined
 *     shape. A 204 specifically is itself a CONCLUSIVE "none of the queried
 *     opIds were ever accepted" answer — a write that records an opId
 *     always also upserts a `user_planner` row in the SAME transaction (see
 *     handleWrite in api/sync/planner/route.ts), so 204 (no row in
 *     user_planner at all) is structurally incompatible with ANY opId
 *     having been accepted. Callers may safely treat a null pullPlanner()
 *     result as "no queried op was accepted" unconditionally, without
 *     needing to inspect (nonexistent, since 204 has no body) opStatuses.
 *
 * Throws on:
 *   non-OK HTTP responses (401, 5xx, etc.)
 *   network/fetch failures
 *
 * Callers must catch to distinguish "unknown failure" from "known empty".
 * A thrown error must NOT reopen the push gate — cloud state is uncertain.
 */
export async function pullPlanner(
  profileId: string,
  lastOpIds?: string[]
): Promise<(SyncedPlannerPayload & { revision: number | null; opStatuses: OpStatus[] }) | null> {
  const params = new URLSearchParams({ profileId });
  for (const opId of lastOpIds ?? []) {
    params.append("lastOpId", opId);
  }
  const url = `/api/sync/planner?${params.toString()}`;
  const res = await fetch(url, { credentials: "include" });
  // Definitively empty — no planner stored for this user+profile yet
  if (res.status === 204) return null;
  // Any other non-OK status is a real failure; let it throw
  if (!res.ok) throw new Error(`sync/planner GET ${res.status}`);
  const data = (await res.json()) as { plannerJson?: unknown; revision?: unknown; opStatuses?: unknown };
  const parsed = parseSyncedPlannerPayload(data.plannerJson ?? null);
  if (!parsed) return null;
  const revision = typeof data.revision === "number" && Number.isFinite(data.revision) ? data.revision : null;
  const opStatuses = parseOpStatuses(data.opStatuses);
  return { ...parsed, revision, opStatuses };
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
 * Generates the opaque, client-side write-identity token
 * (`clientOpId`/`lastOpId`) a beacon is tagged with — see the module doc's
 * 7th-round paragraph and resolveConfirmedAfterBeacon()'s own doc in
 * syncPayload.ts for why this must be a random, opaque, order-independent
 * value, NEVER a timestamp: it is compared for exact equality against a
 * server-recorded fact, never used to infer ordering. `crypto.randomUUID()`
 * is used when available (all evergreen browsers); the fallback (older
 * browsers lacking it, or a non-secure context) is a Math.random()-based
 * string — acceptable because this value is never used for security, only
 * as an opaque key the server echoes back verbatim in `opStatus.opId`.
 */
function generateOpId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

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
 * Codex P1 fix (7th round) — the 6th round's fix recorded the beacon's
 * PAYLOAD as `pendingBeacon` via a read-modify-write of the SAME record
 * `confirmed` lived in, which is exactly what created the metadata race
 * Codex flagged (that read-modify-write could never be routed through
 * withConfirmedSnapshotLock — beforeunload cannot reliably await async
 * work — so it ran unlocked against a record another tab's LOCKED commit
 * could be updating at the same instant). The fix here is architectural,
 * not a bigger lock: tag this beacon with a fresh, random `clientOpId`
 * (generateOpId() above) sent as a QUERY PARAMETER on the beacon URL (never
 * a body field — see api/sync/planner/route.ts's doc for why a body field
 * would trip the unknown-domain-key rejection), and record ONLY that opId
 * — never the payload itself, and never merged with `confirmed`.
 *
 * Codex P1 fix (9th round) — record it via addPendingOp(), which writes
 * this opId under its OWN independent key (see the "Pending operations"
 * section's doc) rather than overwriting a single shared scalar. This is
 * still a plain, unconditional single-key write — no read of any existing
 * value needed, so there is no compound read-modify-write left for a lock
 * to protect — but it no longer discards a DIFFERENT, still-unresolved
 * beacon's evidence the way overwriting one shared slot did. The next
 * successful pull for this SAME (userId, profileId) resolves EVERY
 * currently-pending op (this one included) conclusively against the
 * server's own GET response — see reconcilePendingOperations()'s own doc
 * and each page's pull effect for where that happens.
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
    const opId = generateOpId();
    const queued = navigator.sendBeacon(
      `/api/sync/planner?profileId=${encodeURIComponent(profileId)}&clientOpId=${encodeURIComponent(opId)}`,
      new Blob([body], { type: "application/json" })
    );
    if (queued && userId) {
      addPendingOp(userId, profileId, opId);
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

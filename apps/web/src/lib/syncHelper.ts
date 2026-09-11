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
 *   getConfirmedState(userId, profileId)              — read the current
 *                                                       PER-DOMAIN confirmed
 *                                                       state (plans/
 *                                                       lightning/days each
 *                                                       independently, each
 *                                                       with its OWN
 *                                                       revision — 11th
 *                                                       round; see its own
 *                                                       doc; replaces the
 *                                                       old single-mixed-
 *                                                       snapshot
 *                                                       getConfirmedSnapshot)
 *   await commitConfirmedBaseline(userId, profileId, — record specific
 *     revision, accepted)                              domain(s) as
 *                                                       CONFIRMED at that
 *                                                       revision — an
 *                                                       immutable fact,
 *                                                       never a locked
 *                                                       read-modify-write
 *                                                       (11th round; see
 *                                                       its own doc);
 *                                                       returns whether
 *                                                       every attempted
 *                                                       domain write
 *                                                       durably succeeded
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
 *   selectPendingOpBatch(userId, profileId, maxBatch) — the BOUNDED, FAIRLY
 *                                                       ROTATED subset of
 *                                                       listPendingOps()'s
 *                                                       result to actually
 *                                                       query THIS pull
 *                                                       (10th round; see its
 *                                                       own doc) — call this
 *                                                       instead of
 *                                                       listPendingOps()
 *                                                       directly when
 *                                                       building a pull's
 *                                                       `lastOpIds`, so a
 *                                                       pending set larger
 *                                                       than the server's
 *                                                       cap still guarantees
 *                                                       every op is
 *                                                       eventually queried
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
 *   await commitLocalDomainRaw(key,                  — the shared LOCAL
 *     expectedPreviousRaw, nextRaw,                     persistence commit
 *     isStillValid?)                                    primitive (12th
 *                                                        round; FAIL-CLOSED
 *                                                        no-Web-Locks
 *                                                        behavior and
 *                                                        `isStillValid` added
 *                                                        13th round; see its
 *                                                        own doc) — writes
 *                                                        `nextRaw` to a
 *                                                        synced domain's
 *                                                        localStorage `key`
 *                                                        ONLY if: Web Locks
 *                                                        are actually
 *                                                        available (else
 *                                                        "unavailable" —
 *                                                        no read, no write);
 *                                                        the value there
 *                                                        right now still
 *                                                        equals
 *                                                        `expectedPreviousRaw`
 *                                                        (else "superseded");
 *                                                        AND, checked LAST,
 *                                                        still inside the
 *                                                        lock, `isStillValid()`
 *                                                        (else "aborted") —
 *                                                        pass a closure over
 *                                                        isPullContextCurrent(ctx)
 *                                                        here so a commit
 *                                                        that goes stale
 *                                                        while queued for the
 *                                                        lock never lands
 *   commitLocalDomainRawSync(key, nextRaw)            — the ordinary-edit
 *                                                        primitive (16th
 *                                                        round; see its own
 *                                                        doc — REPLACES the
 *                                                        13th round's async,
 *                                                        Web-Locks-
 *                                                        participating
 *                                                        forceCommitLocalDomainRaw):
 *                                                        a single SYNCHRONOUS
 *                                                        localStorage
 *                                                        getItem/setItem
 *                                                        pair — no Promise,
 *                                                        no lock, no
 *                                                        queuing — so the
 *                                                        write is durable
 *                                                        before this call
 *                                                        even returns. Used
 *                                                        by every ordinary
 *                                                        user-edit writer
 *                                                        (Plans/Lightning
 *                                                        items, days, and
 *                                                        every Remove/Clear/
 *                                                        Restore/import
 *                                                        path), which always
 *                                                        represent the
 *                                                        user's own freshest
 *                                                        intent and so are
 *                                                        never rejected —
 *                                                        "noop" only when
 *                                                        the durable value
 *                                                        already equals it
 *   isLocalDomainCommitSuccess(status)               — true for "committed"
 *                                                        or "noop" (the
 *                                                        durable value is
 *                                                        confirmed to be, or
 *                                                        already was, the
 *                                                        caller's intended
 *                                                        value); false for
 *                                                        "superseded",
 *                                                        "aborted",
 *                                                        "unavailable", or
 *                                                        "failed" — gates
 *                                                        that must only
 *                                                        advance once a
 *                                                        winning domain is
 *                                                        durably committed
 *                                                        (ownership,
 *                                                        syncReady,
 *                                                        confirmed-baseline)
 *                                                        should check this,
 *                                                        never React state
 *   beginPullContext()                               — snapshot this pull's
 *                                                        immutable execution
 *                                                        context (13th round;
 *                                                        see "Pull execution
 *                                                        context" below) —
 *                                                        call ONCE per pull,
 *                                                        right after that
 *                                                        transition's own
 *                                                        setSyncUserId()/
 *                                                        setSyncProfileId()
 *                                                        calls
 *   isPullContextCurrent(ctx)                        — true only if no
 *                                                        genuine identity/
 *                                                        profile transition
 *                                                        has happened since
 *                                                        `ctx` was captured
 *                                                        (13th round) — check
 *                                                        after every awaited
 *                                                        boundary a pull
 *                                                        performs, before any
 *                                                        further durable
 *                                                        write or gate
 *                                                        transition
 *
 * localStorage keys:
 *   dwp:sync:{profileId}:lastSyncedAt                  — ISO timestamp of
 *                                                         last successful push
 *   dwp:sync:{profileId}:localContentOwner             — see
 *                                                         getLocalContentOwner's
 *                                                         own doc
 *   dwp:sync:{userId}:{profileId}:confirmedFact:{domain}:{revision} — ONE
 *                                                         KEY PER
 *                                                         (domain,revision)
 *                                                         confirmed fact
 *                                                         (11th round; see
 *                                                         the "Per-domain
 *                                                         confirmed state"
 *                                                         section below) —
 *                                                         an immutable
 *                                                         historical
 *                                                         record, written
 *                                                         with a plain
 *                                                         unconditional
 *                                                         setItem (no lock,
 *                                                         no read-modify-
 *                                                         write); the
 *                                                         CURRENT confirmed
 *                                                         value for a
 *                                                         domain is
 *                                                         computed at READ
 *                                                         time as the
 *                                                         max-revision fact
 *                                                         among whatever
 *                                                         exists for that
 *                                                         domain, and
 *                                                         opportunistically
 *                                                         pruned down to
 *                                                         just that max on
 *                                                         every write
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
 *   dwp:sync:{userId}:{profileId}:pendingOpCursor      — the ROTATION
 *                                                         CURSOR
 *                                                         selectPendingOpBatch()
 *                                                         uses to guarantee
 *                                                         every pending op
 *                                                         is eventually
 *                                                         queried even when
 *                                                         the set exceeds
 *                                                         the server's
 *                                                         per-pull cap (10th
 *                                                         round; see its own
 *                                                         doc) — a single
 *                                                         opaque opId,
 *                                                         unconditionally
 *                                                         overwritten, no
 *                                                         lock needed
 *
 * The synced payload (SyncedPlannerPayload) includes both plans and lightning
 * for the active profile. It is read fresh from localStorage at push time
 * so no payload needs to be passed through the call chain.
 *
 * ── Cloud-confirmed local snapshot contract (SH.2) ──────────────────────────
 *
 * "For authenticated user U and profile P, what exact planner state is the
 * newest server-confirmed state — PER DOMAIN?" — answered by
 * getConfirmedState(userId, profileId), returning an independent
 * `{ revision, value }` fact for each of plans/lightning/days that has ever
 * been confirmed (any subset may be absent — "never confirmed yet for this
 * domain"). A domain's confirmed value represents "the state currently
 * accepted as synchronized for this domain" — NOT merely "the last
 * successful PUT payload". It advances two ways, both recording facts under
 * the SAME per-domain storage:
 *   • doPush() (below) records the literal request body of every
 *     SUCCESSFUL push, tagged with the server-issued `revision` in that
 *     push's response.
 *   • commitConfirmedBaseline() (below) is called by a page's pull effect
 *     after a pull resolves, for whichever domain(s) it determined were
 *     cloud-won AND successfully persisted this pull — a domain a pull
 *     hydrates from cloud is just as validly "confirmed" as one a push
 *     just sent, and must advance the SAME per-domain record so a LATER
 *     pull never misclassifies that already-hydrated state as an unsynced
 *     local edit (Codex P1, 1st round), tagged with the same pull's GET
 *     response `revision`. Domains NOT passed in this call are completely
 *     unaffected — there is no "current record" this call reads or
 *     replaces at all (see the 11th round's redesign below); a domain's
 *     own facts simply accumulate independently of what any OTHER domain's
 *     commit does.
 *
 * Codex P1 fix (3rd round) — TWO further guarantees:
 *   • Identity scope: the storage key is keyed by BOTH userId and
 *     profileId (confirmedFactKey below) — "profile" is a LOCAL, per-device
 *     concept independent of which cloud account is signed in, so a bare
 *     profileId key would let account B, signing in after account A signs
 *     out on the same device/profile, read (and potentially re-confirm)
 *     account A's leftover confirmed record. With userId in the key, B's
 *     read is a DIFFERENT key A never touched — B's own confirmed state
 *     (or lack thereof) is unaffected by A ever having used this profile
 *     slot.
 *   • Revision ordering: every commit carries the server-issued `revision`
 *     that produced it (see api/sync/planner/route.ts's module doc for why
 *     this — not `updated_at`, not response arrival order — is the only
 *     authoritative ordering signal under concurrent writes). Two
 *     concurrent pushes' responses arriving in EITHER order converge on the
 *     same final confirmed state per domain — whichever server-committed
 *     LATER (higher revision) for THAT domain, never whichever response
 *     happened to arrive at this tab last, and never blocked by some OTHER
 *     domain's unrelated revision (see the 11th round below for why this
 *     last guarantee needed a full redesign, not just a bigger lock).
 *
 * Codex P1 fix (4th round) — revision ordering above is only correct if the
 * read-compute-write sequence that applies it is itself atomic across tabs.
 * Codex P1 fix (5th round) — hardened to FAIL SAFE (skip the commit
 * entirely) when the Locks API is unavailable, rather than fall back to an
 * unserialized sequence that could silently reintroduce a regression.
 * (Both superseded by the 11th round's redesign below, which removes the
 * Web-Locks dependency from this mechanism entirely — kept here as
 * historical record of the problem these rounds were solving.)
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
 * `opStatus.found` fact from the server — see
 * acceptedDomainFactsFromBeacon() (syncPayload.ts) and
 * reconcilePendingOperations() (below).
 *
 * This also required SEPARATING `pendingBeaconOpId` from `confirmed` onto
 * its own, independent, UNLOCKED key — the 6th round's consolidation of
 * both fields into one Web-Locks-protected record required
 * registerUnloadSync()'s beforeunload write (which cannot reliably await a
 * lock) to touch that SAME locked record, which is exactly the metadata
 * race Codex flagged for the 7th round (pending-beacon state read-
 * modify-written unlocked while confirmed state used Web Locks). Now
 * `pendingBeaconOpId` needs no read-modify-write at all — it was a single
 * opaque scalar, always fully overwritten by whichever beacon fired last.
 *
 * Codex P1 fix (9th round) — the 7th/8th rounds' "last-write-wins, only the
 * MOST RECENT beacon matters" assumption was itself a bug: it is a "latest
 * only" timing heuristic that actively DESTROYS evidence. If tab 1
 * registers pending beacon A and tab 2 later registers pending beacon B
 * (both still genuinely unresolved), overwriting the single scalar key to
 * B silently discards A — no pull will ever check A's fate again, even
 * though A might still be sitting, unaccepted, in some queue. Separately,
 * the 8th round's beacon-resolution helper cleared the pending marker
 * BEFORE confirming that the paired confirmed-baseline promotion had
 * durably succeeded — if Web Locks were unavailable, or the lock request
 * failed, or the promotion was itself rejected as stale, the marker was
 * already gone while the baseline it was supposed to gate remained
 * un-promoted, again losing the evidence needed to retry later.
 *
 * Both bugs shared one cause: treating "pending operations" as a single
 * mutable slot instead of a durable, per-operation SET. The fix replaced
 * `pendingBeaconOpId` with one INDEPENDENT localStorage key PER pending
 * opId (`dwp:sync:{userId}:{profileId}:pendingOp:{opId}` — see the "Pending
 * operations" section below). Registering a new op is a pure, unconditional
 * single-key write — no read of any existing set required, so it can never
 * race or clobber a DIFFERENT op's key. Retiring an op is a pure,
 * unconditional single-key delete, gated on the SAME op's confirmed-
 * baseline promotion having been PROVEN to durably succeed (see
 * commitConfirmedBaseline's return value and reconcilePendingOperations()
 * below) — never before.
 *
 * Codex P1 fix (11th round) — TWO further P1s in the confirmed-state
 * architecture itself:
 *   (1) MIXED-DOMAIN REVISION. The single `ConfirmedPlannerSnapshot
 *       { revision; snapshot }` record covered plans+lightning+days
 *       TOGETHER under one revision. Disjoint pulls/pushes can legitimately
 *       confirm DIFFERENT domains at DIFFERENT server revisions (e.g. a
 *       Days-only cloud win at revision 7, while Plans is still only
 *       confirmed as of revision 5 from an earlier, unrelated commit) —
 *       assigning the WHOLE mixed snapshot the newest revision made the
 *       OLDER domain look newer than it genuinely was, so a later,
 *       perfectly legitimate revision-6 update to Plans would be wrongly
 *       rejected as "stale" against the borrowed revision 7 that Plans
 *       itself was never actually confirmed at.
 *   (2) WEB-LOCKS DEPENDENCY. When Web Locks were unavailable, the
 *       read-compute-write mutation was skipped entirely (fail-safe, per
 *       the 5th round). That was NOT safe enough on its own: after a
 *       SUCCESSFUL push, skipping the confirmed-state update left the
 *       durable/fallback baseline stale, and a LATER pull — in this same
 *       browser, this same tab, possibly after a reload — would then
 *       compare fresh local storage (already reflecting the pushed state)
 *       against the STALE confirmed baseline, see a "difference", and
 *       misclassify already-synced content as an unsynced local edit,
 *       potentially overwriting newer cloud state written by another
 *       device in the meantime. "Skip the write" is only safe if nothing
 *       downstream can be destructive about the resulting staleness — here
 *       it very much could be.
 *
 * Both are fixed by the SAME redesign: confirmed state is now a set of
 * PER-DOMAIN, PER-REVISION, IMMUTABLE facts (see "Per-domain confirmed
 * state" below) rather than one mutable mixed-domain slot. Each domain's
 * OWN current confirmed value is computed at READ time as the max-revision
 * fact recorded for it — this closes (1) structurally (there is no shared
 * revision to borrow; each domain's revision is only ever compared against
 * ITS OWN prior facts) and closes (2) by removing the Web-Locks dependency
 * entirely: recording an immutable fact is a plain, unconditional
 * `localStorage.setItem` — no read, no lock, no compare-then-write — so it
 * is exactly as reliable with or without the Web Locks API. See
 * "Per-domain confirmed state" below for the full mechanism.
 *
 * Consumers (plans/page.tsx, lightning/page.tsx) treat getConfirmedState()
 * as the single source of truth for "was my current local content already
 * accepted by the cloud", per domain — see captureConfirmedSnapshotForPull()
 * in each page for how a pull's OWN immutable baseline is frozen from it
 * (per domain, independently), and each page's pull effect for how
 * commitConfirmedBaseline() is called afterward.
 *
 * ── Local-domain commit (SH.2, Codex P1, 12th round) ────────────────────────
 *
 * Codex found two P1s in local persistence AFTER pull reconciliation has
 * already picked a winner for a synced domain (plans/lightning/days):
 *   (1) STALE-WINNER OVERWRITE. Hydration's sequence was read current local
 *       domain → choose winner → LATER localStorage.setItem(...). Nothing
 *       re-checked the durable value immediately before that final write, so
 *       another tab's genuinely newer same-domain write landing in the
 *       window between the read and the write was silently clobbered by the
 *       pull's now-stale winner.
 *   (2) REACT-STATE COMPARISON. Some "is a write still needed" checks
 *       compared the winning value against REACT STATE (e.g. itemsRef.current)
 *       instead of the actual durable localStorage value. If an earlier
 *       direct write AND its persistence effect had both failed, React state
 *       could already equal the winner while disk stayed on the OLD value —
 *       the check then wrongly concluded "already persisted", skipped the
 *       write, and let sync/ownership gates reopen over data that was never
 *       actually durable.
 *
 * Both are fixed by routing every synced-domain local write through a
 * shared decision core (decideLocalDomainCommit() in syncPayload.ts — the
 * pure "noop/superseded/write" decision), keyed purely by the domain's
 * localStorage key (which already uniquely identifies profile+domain via
 * buildNamespacedKey, so no separate profile/user threading is needed
 * here) — but, as of the 16th round, through TWO DELIBERATELY SEPARATE
 * primitives rather than one shared async API, because ordinary edits and
 * hydration need genuinely different guarantees (see "Local-domain commit,
 * 16th round" below for why forcing both through one lock-participating
 * API was itself a P1):
 *   • commitLocalDomainRaw(key, expectedPreviousRaw, nextRaw) — the CAS
 *     ("compare-and-swap") policy hydration uses: writes `nextRaw` ONLY if
 *     the durable value read right now still equals `expectedPreviousRaw`
 *     (the durable value hydration's OWN winner decision was based on).
 *     If it doesn't — some other write already landed — the commit reports
 *     "superseded" and never touches disk, so that newer write survives
 *     untouched. This is a pure VALUE comparison, never a timestamp or
 *     arrival-order heuristic, so it is correct regardless of which tab
 *     produced the divergent value or how much wall-clock time passed. When
 *     the Web Locks API (navigator.locks) is available, the entire
 *     read-decide-write sequence for a given key runs inside
 *     `navigator.locks.request(name, ...)`, giving true mutual exclusion
 *     across every OTHER commitLocalDomainRaw() caller contending for that
 *     SAME key.
 *   • commitLocalDomainRawSync(key, nextRaw) — the SYNCHRONOUS policy
 *     ordinary user-edit writers use (16th round — see its own doc): a
 *     single localStorage.getItem/setItem pair, no Promise, no lock
 *     involvement at all. A live edit is by definition the user's freshest
 *     intent, so it is never rejected — it always writes (skipping only
 *     when the durable value already equals it, itself a "noop" success).
 *
 * Codex P1 fix (13th round) — the 12th round's own report mischaracterized
 * the no-Web-Locks path as "sufficient for correctness": a plain
 * read-decide-write is NOT compare-and-swap without a lock. The read and
 * the write are two separate operations with a real gap between them; two
 * tabs can both read a matching value before either writes, and the second
 * write silently clobbers the first with neither side able to detect it —
 * an unguarded lost update, not a rare residual. There is no lock-free way
 * to close that gap against plain localStorage, so commitLocalDomainRaw()
 * — the CAS policy whose result GATES ownership/confirmed-baseline/
 * syncReady — FAILS CLOSED as "unavailable" when Web Locks are absent: it
 * neither reads nor writes anything, so no destructive overwrite is
 * possible and (isLocalDomainCommitSuccess() treats "unavailable" exactly
 * like "failed") no false confirmation is possible either. This is a
 * permanent, environment-determined refusal — never a timing retry or a
 * probability-based heuristic — so cross-tab conflict resolution for
 * synced domains simply stays deferred in a browser lacking Web Locks,
 * while ordinary local editing keeps working regardless: it was never
 * gated on Web Locks (commitLocalDomainRawSync never touches the lock at
 * all — see "Local-domain commit, 16th round" below).
 *
 * isLocalDomainCommitSuccess(status) is the single "may gates advance"
 * predicate every caller uses afterward — true for "committed" or "noop",
 * false for "superseded", "aborted", "unavailable", or "failed" — so
 * ownership/syncReady/confirmed-baseline advancement is always derived from
 * what ACTUALLY happened on disk, never from React memory.
 *
 * ── Local-domain commit, LOCAL-FIRST DURABILITY (SH.2, Codex P1, 16th
 * round) ─────────────────────────────────────────────────────────────────
 *
 * Codex found that the 13th round's design — ordinary user-edit writers
 * (forceCommitLocalDomainRaw, REMOVED this round) sharing the SAME per-key
 * Web Lock as hydration's CAS commit — had a real cost nothing had
 * accounted for: if ANOTHER tab currently held that lock (its own
 * hydration CAS, or its own ordinary edit), `navigator.locks.request()`
 * QUEUES the write and does not run it until the lock is released — an
 * UNBOUNDED wait bearing no relationship to how long the user's own action
 * took. Every ordinary-edit call site fires this with `void` (never
 * awaited — they are synchronous DOM/React event handlers, not async
 * functions), so nothing observed or waited for that delay. If the user
 * closed the tab while the lock was held elsewhere, the queued write could
 * NEVER RUN: the durable value on disk stayed OLD, an unload beacon push
 * (which reads localStorage synchronously, right now) sent the stale
 * content, and the user's most recent edit was lost both locally AND in
 * the cloud.
 *
 * The fix separates the LOCAL-FIRST DURABILITY CONTRACT's two distinct
 * requirements onto two different primitives instead of forcing both
 * through one async API:
 *   • ORDINARY user edit persistence needs IMMEDIATE, LOCAL-FIRST
 *     durability — durable before the call that made it returns, full
 *     stop, with NO dependency on anything (a lock, a queue, an await)
 *     that could outlive page teardown. commitLocalDomainRawSync() is
 *     exactly that: synchronous, no Promise, no lock — by the time it
 *     returns, the write has already landed (or definitively failed).
 *   • PULL HYDRATION/CAS still needs SERIALIZED, conflict-safe commit —
 *     commitLocalDomainRaw() is unchanged: a fundamentally different
 *     question ("does this decision, made against a specific baseline,
 *     still hold") from "durably persist the user's live edit right now".
 * This reopens a NARROWER version of the cross-tab race the shared lock
 * used to close for ordinary writers specifically: a genuinely
 * simultaneous cross-tab write (landing in the exact instant between
 * another tab's own lock-protected hydration CAS's read and write) is
 * possible again in principle. Accepted as the correct trade-off — see
 * this round's own report — because it is the SAME class of residual risk
 * already documented since the 12th/13th rounds, hydration's own CAS check
 * still catches an ordinary edit that landed BEFORE its critical section
 * began (every required case), and an ordinary edit was never a
 * participant in any correctness proof that depended on cross-tab mutual
 * exclusion — only on overwriting unconditionally, which a plain setItem
 * still does perfectly.
 *
 * ── Pull execution context (SH.2, Codex P1, 13th round) ─────────────────────
 *
 * Codex found two more P1s, both instances of the SAME failure class as the
 * Web-Locks finding above: a durable write or gate transition executing
 * under an execution context that is no longer the one it started under.
 *   (1) AUTH IDENTITY WITHOUT EPOCH. Each page's auth-transition effect
 *       depended on `sessionStatus` but not the resolved authenticated user
 *       id itself. NextAuth can switch the signed-in user A → B while
 *       `sessionStatus` remains "authenticated" throughout (no
 *       loading/unauthenticated edge for React to key an effect re-run on).
 *       The effect never re-ran, so `activeUserIdRef`/`setSyncUserId` never
 *       retargeted to B, and any pull already in flight for A kept running
 *       under A's client conflict context indefinitely.
 *   (2) NO REVALIDATION ACROSS AWAITED LOCAL-DOMAIN COMMITS. The 12th
 *       round's reconciliation added several `await commitLocalDomainRaw(...)`
 *       calls in sequence. If the surrounding auth/profile transition set
 *       this pull's `cancelled` flag while one of those awaits was pending
 *       (or, worse, while a commit sat queued waiting for a Web Lock held by
 *       another writer), the callback resumed and could still perform
 *       LATER writes, ownership transfer, confirmed-baseline commits, and
 *       `syncReady` transitions — exactly the durable-state corruption the
 *       Web-Locks fix was trying to prevent, just via a different unguarded
 *       gap.
 *
 * Both are fixed by giving every pull ONE immutable execution context,
 * captured exactly once at pull start, instead of re-deriving "who is this
 * for" from mutable refs/session state after each await:
 *   • currentPullEpoch (module-private) is a monotonic counter bumped by
 *     setSyncUserId()/setSyncProfileId() whenever the value they are given
 *     is ACTUALLY different from the current one (their existing early-
 *     return-on-no-change guard is exactly the signal "a genuine identity
 *     or profile transition is happening right now").
 *   • beginPullContext() snapshots { epoch, userId, profileId } from that
 *     module state — call this ONCE, synchronously, immediately after this
 *     transition's own setSyncUserId()/setSyncProfileId() calls, and close
 *     over the returned PullContext for the rest of that one pull. Never
 *     re-read activeUserIdRef.current / currentSyncUserId / currentSyncProfileId
 *     after an await to attribute a write — use the CAPTURED ctx.userId /
 *     ctx.profileId instead, so a later identity switch cannot retroactively
 *     change which account an in-flight pull's writes are scoped to.
 *   • isPullContextCurrent(ctx) is a pure check: true only if no genuine
 *     identity/profile transition has happened since ctx was captured (i.e.
 *     the epoch hasn't moved). Each page's pull effect calls this — via one
 *     shared `isPullCurrent()` closure that ALSO checks the effect's own
 *     `cancelled` flag, so both "a NEW pull superseded this one" (epoch) and
 *     "this exact effect run was cleaned up for any other reason" (cancelled)
 *     are covered by ONE call site pattern instead of scattered ad hoc
 *     conditions — after EVERY awaited boundary (reconcilePendingOperations,
 *     each commitLocalDomainRaw) and BEFORE every subsequent durable write or
 *     gate transition (the next domain's commit, setLocalContentOwner,
 *     commitConfirmedBaseline, setSyncReady). A stale continuation's
 *     `isPullCurrent()` starts returning false the instant the epoch moves,
 *     so it stops before doing anything further — the REMAINING steps
 *     simply never execute; nothing already durably committed is undone
 *     (there is nothing unsafe about a write that was genuinely valid the
 *     moment it landed).
 *   • commitLocalDomainRaw() additionally accepts this SAME `isPullCurrent`
 *     closure as its `isStillValid` parameter, re-checked as the LAST step
 *     before the actual `localStorage.setItem` — still INSIDE the Web Lock's
 *     critical section. This closes the specific gap a caller-side-only
 *     check cannot: if the epoch moves WHILE a commit sits queued waiting
 *     for the lock (held by some other writer), the outer "check after the
 *     await resolves" pattern would only catch it AFTER the write already
 *     happened. Re-checking at the last possible instant, before the
 *     mutation itself, means an invalidated commit reports "aborted" and
 *     never touches disk — no matter how long it waited for the lock.
 *
 * Each page's auth-transition effect also now depends on the resolved
 * authenticated user id itself (a derived primitive, not the whole
 * next-auth `session` object — see that effect's own doc for why the whole
 * object is still deliberately excluded), so a genuine A → B switch re-runs
 * the effect — cancelling A's lifecycle (cleanup sets `cancelled`),
 * retargeting via setSyncUserId(B) (bumping the epoch), and starting B's
 * pull under a freshly-captured PullContext — even though `sessionStatus`
 * never left "authenticated" the whole time.
 */

import { buildNamespacedKey } from "./profileStorage";
import {
  buildSyncedPlannerPayload,
  parseSyncedPlannerPayload,
  parseConfirmedPlannerDomainFact,
  parseConfirmedDaysFact,
  resolveConfirmedDomainState,
  confirmedFactRevisionIsUnambiguous,
  acceptedDomainFactsFromBeacon,
  decideLocalDomainCommit,
  isPullEpochCurrent,
  canonicalizeJSON,
  type SyncedPlannerPayload,
  type ConfirmedDomainFact,
  type ConfirmedPlannerState,
  type AcceptedPlannerDomains,
} from "./syncPayload";

/**
 * The server's conclusive answer (see api/sync/planner/route.ts's GET
 * handler) to "was the write tagged with this opId ever accepted" — see
 * acceptedDomainFactsFromBeacon()'s own doc in syncPayload.ts for the full
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
// Codex P1 fix (10th round) — the largest pending-op batch a single pull
// will query. MUST match api/sync/planner/route.ts's own MAX_LAST_OP_IDS
// cap — see selectPendingOpBatch()'s own doc for why a cap this small
// still guarantees every op is eventually queried via rotation.
const MAX_PENDING_OPS_PER_PULL = 25;

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

// ── Local-domain commit (SH.2, Codex P1, 12th/13th/16th rounds) ─────────────
// See the module doc's own "Local-domain commit" section above for the full
// architecture. Keyed purely by the target localStorage key (which already
// uniquely identifies profile+domain), so these primitives need no separate
// identity parameters and are callable from module-level pure helpers (e.g.
// plans/page.tsx's saveToStorage/saveDays) with no React refs in scope.
//
// Codex P1 fix (13th round) — the 12th round's own report mischaracterized
// the no-Web-Locks fallback as "sufficient for correctness": a plain
// read-decide-write is NOT compare-and-swap without a lock, because the read
// and the write are two SEPARATE operations with a real gap between them —
// two tabs can both read a matching value before either writes, and the
// second write silently clobbers the first with no way for either side to
// detect it. That is a genuine unguarded lost-update, not a rare residual.
// This round's fix does NOT try to patch that gap with a smarter read; there
// is no lock-free way to close it against plain localStorage. Instead,
// commitLocalDomainRaw() (the CAS policy hydration uses to gate ownership/
// confirmed-baseline/syncReady) FAILS CLOSED when Web Locks are unavailable —
// it returns "unavailable" without reading OR writing anything at all. No
// destructive overwrite is possible (nothing is written) and no false
// confirmation is possible (isLocalDomainCommitSuccess is false for
// "unavailable", exactly like "failed"). This is deliberately NOT a timing
// retry or a probability-based heuristic — it is a permanent, environment-
// determined refusal: cross-tab conflict resolution for synced domains stays
// deferred in that browser until it gains genuine serialization.
//
// Codex P1 fix (13th round, finding #2) — commitLocalDomainRaw() also
// accepts an optional `isStillValid` predicate, re-checked as the LAST step
// before the actual mutation, still INSIDE the lock's critical section. A
// caller's own pull-context epoch (see "Pull execution context" below) can
// invalidate WHILE this commit sits queued waiting for the lock (held by
// some other writer) — checking validity only after the whole call resolves
// would be too late; the write could already have landed under a since-
// superseded identity/profile. Re-checking here, immediately before
// `localStorage.setItem`, closes that window completely: an invalidated
// caller's commit reports "aborted" and never touches disk.
//
// Codex P1 fix (16th round) — the 13th round had ORDINARY user-edit writers
// (forceCommitLocalDomainRaw — REMOVED this round) ALSO acquire the SAME
// per-key Web Lock as commitLocalDomainRaw, reasoning that a concurrent
// hydration commit could otherwise interleave mid-write. Codex found the
// actual cost: if ANOTHER tab currently holds that lock, `navigator.locks
// .request()` QUEUES the ordinary edit's write and does not run it until
// the lock is released — an unbounded wait bearing no relationship to how
// long the user's own action took, and since ordinary-edit call sites fire
// this with `void` (never awaited — they are synchronous DOM/React event
// handlers), nothing observed or waited for that delay. If the user closed
// the tab while the lock was held elsewhere, the queued write could NEVER
// RUN: the durable value on disk stayed OLD, an unload beacon push (reading
// localStorage synchronously, right now) sent the stale content, and the
// user's most recent edit was lost both locally and in the cloud.
//
// The fix separates the two requirements the LOCAL-FIRST DURABILITY
// CONTRACT calls out explicitly, onto two different primitives instead of
// forcing both through one async API:
//   • Ordinary user edits need IMMEDIATE, LOCAL-FIRST durability — the
//     mutation must be durable before the call that made it returns, full
//     stop, with no dependency on anything that could outlive page
//     teardown. commitLocalDomainRawSync() below is a single SYNCHRONOUS
//     localStorage.getItem/setItem pair — no Promise, no lock acquisition,
//     no queuing, ever. By the time it returns, the write has already
//     landed (or definitively failed); a beforeunload handler firing any
//     time afterward — a microtask, a minute — reads the true latest value
//     by ordinary JS execution order, not by awaiting anything.
//   • Pull hydration/CAS still needs SERIALIZED, conflict-safe commit —
//     commitLocalDomainRaw() is UNCHANGED: still async, still Web-Locks-
//     gated, still the right tool for "does this decision, made against a
//     specific baseline, still hold" — a fundamentally different question
//     from "durably persist the user's live edit right now."
// This does reopen a NARROWER version of the cross-tab race the shared lock
// used to close for ordinary writers specifically: a genuinely simultaneous
// cross-tab write (this tab's plain setItem landing in the exact instant
// between another tab's OWN lock-protected hydration CAS's read and write)
// is possible in principle again. This is the correct trade-off — see this
// round's own report — because (a) it is the SAME class of residual risk
// already documented and accepted since the 12th/13th rounds for the
// no-Web-Locks case generally, (b) hydration's own CAS check (a fresh read
// immediately before writing, inside its lock) still catches an ordinary
// edit that landed BEFORE that critical section began — which is every
// required case (an edit followed by page close, or an edit racing a pull
// that has not yet reached its own critical section) — and (c) an ordinary
// edit was never a participant in any correctness proof that depended on
// cross-tab mutual exclusion, only on being able to overwrite
// unconditionally, which a plain setItem still does perfectly.

export type LocalDomainCommitStatus = "committed" | "noop" | "superseded" | "failed" | "unavailable" | "aborted";

function localDomainCommitLockName(key: string): string {
  return `dwp:localDomainCommit:${key}`;
}

/** True only when the Web Locks API is actually present and callable. */
function hasLocalDomainSerialization(): boolean {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return !!locks && typeof locks.request === "function";
}

/**
 * Runs `fn` (a synchronous read-decide-write) serialized against every
 * other caller contending for the SAME `key`, via the Web Locks API. Used
 * exclusively by commitLocalDomainRaw() (the CAS policy) below — ordinary
 * edits no longer participate in this lock at all (16th round; see this
 * section's own doc above).
 */
function withLocalDomainCommitLock<T>(key: string, fn: () => T): Promise<T> {
  if (hasLocalDomainSerialization()) {
    return navigator.locks.request(localDomainCommitLockName(key), () => fn());
  }
  return Promise.resolve(fn());
}

/**
 * CAS ("compare-and-swap") commit policy — used by pull hydration. Writes
 * `nextRaw` to `key` only if the durable value there right now still equals
 * `expectedPreviousRaw` (the durable value the caller's OWN winner decision
 * was based on, captured via a fresh read at decision time — never React
 * state). If some other write has landed since — this SAME tab's own
 * ordinary edit, or another tab's, it makes no difference which — that
 * write is newer by construction and must survive: this call reports
 * "superseded" and never touches disk.
 *
 * FAILS CLOSED as "unavailable" (no read, no write) when Web Locks are not
 * present (13th round) — see this section's own module doc for why a plain
 * read-decide-write is not genuinely CAS-safe without one.
 *
 * `isStillValid`, when provided, is re-checked as the last step before the
 * actual write, still inside the lock's critical section — pass a closure
 * over the caller's own pull-context epoch (isPullContextCurrent(ctx)) so a
 * commit that went stale while queued for the lock never lands. Defaults to
 * always-valid for callers with no such context.
 */
export function commitLocalDomainRaw(
  key: string,
  expectedPreviousRaw: string | null,
  nextRaw: string,
  isStillValid: () => boolean = () => true
): Promise<LocalDomainCommitStatus> {
  if (!hasLocalDomainSerialization()) return Promise.resolve("unavailable");
  return withLocalDomainCommitLock(key, (): LocalDomainCommitStatus => {
    let currentRaw: string | null;
    try {
      currentRaw = localStorage.getItem(key);
    } catch {
      return "failed";
    }
    const decision = decideLocalDomainCommit(currentRaw, expectedPreviousRaw, nextRaw);
    if (decision !== "write") return decision;
    // Codex P1 fix (13th round) — the LAST gate before mutation, evaluated
    // here rather than by the caller after this Promise resolves, so a
    // context that went stale while this commit sat queued for the lock is
    // still caught before anything is written.
    if (!isStillValid()) return "aborted";
    try {
      localStorage.setItem(key, nextRaw);
    } catch {
      return "failed";
    }
    return "committed";
  });
}

/** The outcomes commitLocalDomainRawSync() (below) can report — a strict
 * subset of LocalDomainCommitStatus, since a synchronous, lock-free,
 * always-unconditional write can never be "superseded", "aborted", or
 * "unavailable" (there is no baseline to violate, no queued wait to go
 * stale during, and no serialization primitive it depends on). */
export type LocalDomainSyncCommitStatus = "committed" | "noop" | "failed";

/**
 * Unconditional, SYNCHRONOUS commit policy — used by ORDINARY user-edit
 * writers: Plans/Lightning items, days, and every Remove/Clear/Restore/
 * import path that persists one of those domains (see this round's own
 * report for the full writer audit). Codex P1 fix (16th round) — see this
 * section's own module doc above for the full rationale; in short, this
 * is a single localStorage.getItem/setItem pair that runs to completion
 * BEFORE this function returns — no Promise, no lock, no possibility of
 * being queued behind another tab's operation, so the write is durable by
 * the time any subsequent code (including a beforeunload handler) runs,
 * satisfying the LOCAL-FIRST DURABILITY CONTRACT's "immediate/local-first
 * durability" requirement by construction rather than by awaiting anything.
 * A live edit is the user's own freshest intent, so it is never rejected:
 * "noop" only when the durable value already equals it (still a success).
 */
export function commitLocalDomainRawSync(key: string, nextRaw: string): LocalDomainSyncCommitStatus {
  if (typeof window === "undefined") return "failed";
  let currentRaw: string | null;
  try {
    currentRaw = localStorage.getItem(key);
  } catch {
    return "failed";
  }
  const decision = decideLocalDomainCommit(currentRaw, currentRaw, nextRaw);
  if (decision === "noop") return "noop";
  try {
    localStorage.setItem(key, nextRaw);
  } catch {
    return "failed";
  }
  return "committed";
}

/**
 * The single "may gates advance" predicate every caller uses after a
 * commit: true for "committed" (a real write just landed) or "noop" (the
 * durable value already was the intended one) — both mean the intended
 * value is CONFIRMED durable right now. False for "superseded" (a newer
 * write won the race), "aborted" (the caller's own context went stale
 * before the write), "unavailable" (no safe serialization primitive exists
 * in this environment), or "failed" (a real localStorage exception) — all
 * four mean the intended value is NOT confirmed durable, so ownership/
 * syncReady/confirmed-baseline advancement must not proceed as if it were.
 * Also accepts LocalDomainSyncCommitStatus (a strict subset), so callers of
 * either primitive can share this one check.
 */
export function isLocalDomainCommitSuccess(status: LocalDomainCommitStatus): boolean {
  return status === "committed" || status === "noop";
}

/**
 * SH.2 architecture (Codex P1, 5th round) — AUTHENTICATED CONFLICT SESSION
 * boundary. "For every SH.2 conflict decision, the baseline and local
 * candidate MUST belong to the same authenticated conflict context."
 * getConfirmedState()/commitConfirmedBaseline() already scope the
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

// ── Shared stable-prefix key snapshot (SH.2, Codex P1, 15th round) ──────────────

/**
 * Snapshot every localStorage KEY currently starting with `prefix` — the
 * ONE shared stable-enumeration primitive every SH.2 mutable-set scan in
 * this module uses (confirmed facts below, pending operations further
 * down) — see the ARCHITECTURAL RULE this round's own report cites: a
 * bespoke enumeration loop per call site is exactly how the confirmed-fact
 * scan (13th/14th rounds) and listPendingOps() (9th round) drifted apart
 * and ended up with two different bugs from the SAME root cause.
 *
 * Scans BACKWARD from a single captured `length`, never forward:
 * `localStorage` has no atomic enumeration primitive, so an index-based
 * scan is exposed to a concurrent `removeItem` (another tab's opportunistic
 * prune or pending-op retirement, or one interleaved with this very call)
 * shifting later indices down by one. A FORWARD scan that has already
 * consumed an index silently skips whatever key shifts into it — including,
 * in the worst case, the one fact/op a caller most needed to see. A
 * BACKWARD scan cannot lose a live key this way: removing an index behind
 * the current position only shifts NOT-YET-VISITED keys forward into the
 * remaining scan range (at worst visited twice — harmless; `seen` dedupes
 * it, and every reduction this module performs over the result is order/
 * duplicate-independent regardless), never out of it; removing an index
 * already visited cannot affect indices still to be scanned at all.
 *
 * A key INSERTED during the scan (e.g. a pending op added by this same tab,
 * or a fact recorded by another one) is either captured (if it lands at an
 * index still to be visited) or simply not part of THIS snapshot (if it
 * lands where the scan has already passed, or beyond the captured
 * `length`) — never a correctness problem, since "a write that happened
 * concurrently with a read may or may not be reflected in that SAME read"
 * is the ordinary, expected behavior of any snapshot read; the write is
 * always durably visible to the NEXT scan regardless.
 *
 * Deliberately returns KEY STRINGS only, not values — every call site reads
 * each key's VALUE in a separate pass, by its exact string via `getItem`,
 * which is immune to any further index shifting entirely (getItem addresses
 * by key, never by position).
 */
function snapshotKeysWithPrefix(prefix: string): string[] {
  const keys: string[] = [];
  try {
    const seen = new Set<string>();
    const length = localStorage.length;
    for (let i = length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key || seen.has(key) || !key.startsWith(prefix)) continue;
      seen.add(key);
      keys.push(key);
    }
  } catch {}
  return keys;
}

// ── Per-domain confirmed state (immutable facts — NO Web Locks needed) ──────────

/** The three synced domains this module tracks confirmed facts for. */
type ConfirmedDomainName = "plans" | "lightning" | "days";
const CONFIRMED_DOMAIN_NAMES: readonly ConfirmedDomainName[] = ["plans", "lightning", "days"];

/**
 * SH.2 architecture (Codex P1, 11th round; storage representation replaced
 * 15th round) — see the module doc's 11th-round paragraph for the full
 * mixed-domain-revision root-cause analysis this section originally closed.
 * Every confirmed fact for a (userId, profileId, domain) is stored under
 * its own key, namespaced by its own revision AND (as of the 15th round) a
 * per-recording unique instance id:
 * `dwp:sync:{userId}:{profileId}:confirmedFact:{domain}:{revision}:{instanceId}`
 * — see confirmedFactKey()'s own doc below for why the instance id exists.
 *
 * This is the entire mechanism that removes the mixed-domain-revision bug,
 * the Web-Locks dependency, AND (15th round) the write-side race the 14th
 * round's version still had:
 *   • Per-domain: plans/lightning/days each scan and reduce ONLY their own
 *     facts (see getConfirmedState() below) — a domain's confirmed revision
 *     is never compared against, borrowed from, or blocked by another
 *     domain's facts.
 *   • Per-recording, physically immutable: every call to recordConfirmedFact()
 *     writes to a key NO OTHER CALL — from any tab, for any domain+revision,
 *     even a literal duplicate recording — could ever also target. There is
 *     no read-before-write, so there is no TOCTOU window for two concurrent
 *     callers to both observe "absent" and race to write: unlike the 14th
 *     round's read-then-compare-then-write sequence (itself an un-atomic
 *     check-then-act localStorage cannot safely provide without a lock —
 *     Codex's 15th-round finding), a plain unconditional `setItem` to an
 *     already-unique key cannot race with anything.
 *   • Reconciliation moves ENTIRELY to READ time: resolveConfirmedDomainState()
 *     (syncPayload.ts) looks at whatever facts exist for a domain's HIGHEST
 *     recorded revision only — never falls back to an older one, even an
 *     unambiguous one (Codex P1, 16th round — see that function's own doc
 *     for why the 15th round's "fall back to the next-lower unambiguous
 *     revision" behavior was itself unsound) — and reports "confirmed" if
 *     they all canonically agree, or "conflict" if they don't. Write order
 *     therefore never matters at all, for identical OR conflicting values
 *     alike — only which facts exist matters, and a fresh read always sees
 *     all of them (via the shared, concurrency-safe snapshotKeysWithPrefix()
 *     primitive above).
 *
 * This is precisely why NO Web Locks API involvement is needed anywhere in
 * this section: correctness comes from genuine per-write physical
 * immutability + read-time reduction over a concurrency-safe scan, never
 * from serializing a compound read-modify-write.
 */
function confirmedFactPrefix(userId: string, profileId: string, domain: ConfirmedDomainName): string {
  return `dwp:sync:${userId}:${profileId}:confirmedFact:${domain}:`;
}

/**
 * Codex P1 fix (15th round) — each RECORDED ATTEMPT gets its own
 * permanently-unique physical key (`instanceId`, a fresh generateOpId() per
 * call — see that function's own doc), never shared with any other
 * recordConfirmedFact() call, even for the SAME domain+revision, even from
 * the SAME tab. This is what makes writing a fact a single unconditional
 * `setItem` with NO read-before-write, ever: there is no key two callers
 * could ever contend for, so there is no TOCTOU window left to close. See
 * resolveConfirmedDomainState() (syncPayload.ts) for how multiple facts
 * recorded for the same revision are reconciled at READ time instead.
 */
function confirmedFactKey(
  userId: string,
  profileId: string,
  domain: ConfirmedDomainName,
  revision: number,
  instanceId: string
): string {
  return `${confirmedFactPrefix(userId, profileId, domain)}${revision}:${instanceId}`;
}

function parseConfirmedFactForDomain(
  domain: ConfirmedDomainName,
  raw: unknown
): ConfirmedDomainFact<unknown> | null {
  return domain === "days" ? parseConfirmedDaysFact(raw) : parseConfirmedPlannerDomainFact(raw);
}

/**
 * Read + parse every currently-recorded fact for one (userId, profileId,
 * domain): first snapshot the matching KEYS via snapshotKeysWithPrefix()
 * (the shared stable-enumeration primitive — see its own doc), THEN read
 * each key's VALUE by its exact string via `getItem`. This second pass is
 * immune to any further index shifting entirely, since `getItem` addresses
 * by key, never by position. A key that disappears between the snapshot
 * and this read (pruned by a concurrent writer in the gap between the two
 * passes) is simply excluded — see selectConfirmedFactPruneKeys()'s own doc
 * for why a fact this read misses because it was JUST pruned can never
 * have been the domain's confirmed value anyway.
 */
function scanConfirmedFactEntries(
  userId: string,
  profileId: string,
  domain: ConfirmedDomainName
): Array<{ key: string; raw: unknown }> {
  const entries: Array<{ key: string; raw: unknown }> = [];
  for (const key of snapshotKeysWithPrefix(confirmedFactPrefix(userId, profileId, domain))) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) continue; // pruned/removed since the snapshot — see doc above
      entries.push({ key, raw: JSON.parse(raw) });
    } catch {
      // Corrupted entry, or a transient localStorage error — simplest safe
      // handling is to skip it from the candidate set (it can never be
      // parsed into a valid fact, so it can never be selected either).
      // Best-effort pruning elsewhere removes such debris opportunistically.
    }
  }
  return entries;
}

/**
 * Read the CURRENT per-domain confirmed state for this authenticated user +
 * profile — see the module doc's "Cloud-confirmed local snapshot contract"
 * above. Each of plans/lightning/days is independently computed by
 * resolveConfirmedDomainState() (syncPayload.ts) over whatever facts have
 * been recorded for it, and returns one of THREE statuses (Codex P1, 16th
 * round — see that function's own doc for the full contract this replaces):
 *   • "none"      — no facts recorded for this domain at all.
 *   • "confirmed" — the highest recorded revision's fact(s) all canonically
 *     agree; `.fact` is the trustworthy confirmed value.
 *   • "conflict"  — the highest recorded revision's facts DISAGREE. The
 *     domain's confirmed state is presently UNKNOWABLE. Callers (see
 *     captureConfirmedSnapshotForPull in each page) MUST fail closed for
 *     this domain — never substitute an older, individually-unambiguous
 *     revision as if it were current truth; that was exactly the P1 Codex
 *     found in the previous version of this function, which silently
 *     dropped the conflict signal and fell back to a stale baseline,
 *     letting a pull misclassify newer state as unsynced and overwrite it.
 * A "conflict" is logged via console.error (best-effort) so the underlying
 * inconsistency is at least observable; it is always temporary — the
 * moment a newer, unambiguous revision is recorded, it becomes the domain's
 * new highest revision and normal "confirmed" resolution resumes with no
 * special handling needed anywhere.
 *
 * Safe to call from any tab: this is a plain localStorage scan of keys that
 * are durable (survive reloads) and shared (every same-origin tab for this
 * browser sees the identical set), so it needs no message-passing or event
 * subscription to be correct — only a fresh scan at the moment the caller
 * wants an answer. No Web Locks involvement — see this section's own doc.
 */
export function getConfirmedState(userId: string, profileId: string): ConfirmedPlannerState {
  if (typeof window === "undefined") {
    return { plans: { status: "none" }, lightning: { status: "none" }, days: { status: "none" } };
  }
  const state = {} as ConfirmedPlannerState;
  for (const domain of CONFIRMED_DOMAIN_NAMES) {
    const facts = scanConfirmedFactEntries(userId, profileId, domain)
      .map(({ raw }) => parseConfirmedFactForDomain(domain, raw))
      .filter((f): f is ConfirmedDomainFact<unknown> => f !== null);
    const result = resolveConfirmedDomainState(facts);
    if (result.status === "conflict") {
      try {
        console.error(
          `SH.2: ${domain}'s confirmed state is conflicted at revision ${result.revision} — sync stays gated for this domain until a later unambiguous revision resolves it.`
        );
      } catch {}
    }
    // Safe cast: parseConfirmedFactForDomain's per-domain branch already
    // guarantees the value shape matches this domain's own slot type.
    (state as unknown as Record<string, unknown>)[domain] = result;
  }
  return state;
}

/**
 * Selects which of this domain's currently-recorded fact keys are safe to
 * prune (delete), given `confirmedRevision` — the revision
 * resolveConfirmedDomainState() reports as "confirmed" right now, or `null`
 * if it instead reports "none" or "conflict" (Codex P1, 16th round: since
 * that function only ever looks at the TOP recorded revision, `null` here
 * covers BOTH "nothing recorded yet" and "the top revision is itself
 * conflicted" — in either case there is no revision this domain can safely
 * treat as superseded, so nothing at all is pruned; every historical fact,
 * including the conflicting frontier's, is left in place until a later
 * unambiguous revision establishes a real confirmedRevision):
 *   • any fact whose revision is STRICTLY LESS than `confirmedRevision` is
 *     fully superseded — deleted outright.
 *   • facts AT `confirmedRevision` (necessarily all canonically identical,
 *     by definition of "confirmed") are deduped down to one representative;
 *     duplicates carry no additional information.
 * Pruning is a pure optimization: skipping it entirely (or it failing
 * mid-way) never changes what getConfirmedState() computes, since
 * resolveConfirmedDomainState() reduces correctly over however many facts —
 * duplicate or conflicting — happen to still exist.
 */
function selectConfirmedFactPruneKeys(
  entries: Array<{ key: string; fact: ConfirmedDomainFact<unknown> }>,
  confirmedRevision: number | null
): string[] {
  const toDelete: string[] = [];
  const keptCanonicalValuesByRevision = new Map<number, Set<string>>();
  for (const { key, fact } of entries) {
    if (confirmedRevision !== null && fact.revision < confirmedRevision) {
      toDelete.push(key);
      continue;
    }
    const canonical = canonicalizeJSON(fact.value);
    let kept = keptCanonicalValuesByRevision.get(fact.revision);
    if (!kept) {
      kept = new Set<string>();
      keptCanonicalValuesByRevision.set(fact.revision, kept);
    }
    if (kept.has(canonical)) {
      toDelete.push(key); // a duplicate of an already-kept value — redundant
    } else {
      kept.add(canonical);
    }
  }
  return toDelete;
}

/**
 * Records ONE immutable confirmed fact for a single domain — Codex P1 fix
 * (15th round): a single unconditional `setItem` to a permanently-unique
 * key (see confirmedFactKey's own doc) — no read-before-write, no
 * TOCTUOU window, no Web Locks needed, ever.
 *
 * Immediately afterward, checks whether THIS revision (not necessarily the
 * domain's overall max — see confirmedFactRevisionIsUnambiguous()'s own doc
 * in syncPayload.ts) is unambiguous among everything now recorded for it:
 *   • yes -> returns true. Whether or not it ends up being the domain's
 *     CURRENT confirmed value (a higher revision may already be
 *     unambiguously confirmed) is irrelevant to THIS call's own success —
 *     it durably, unambiguously recorded what it was asked to.
 *   • no (a DIFFERENT canonical value is also recorded for this exact
 *     revision — an upstream reconciliation inconsistency, e.g.
 *     plans/page.tsx and lightning/page.tsx computing different content for
 *     the SAME shared "plans"/"days" domain at the SAME revision, never a
 *     legitimate "which is newer" question) -> returns false, exactly like
 *     a thrown localStorage.setItem, so it blocks ownership/syncReady/
 *     pending-op-retirement gating the same way any other "not durably
 *     confirmed" outcome does — this is the CONFIRMED-FACT CONTRACT's
 *     "fail closed for that domain" requirement, enforced at READ time
 *     rather than by refusing the write (which round 14's version tried,
 *     and which round 13 already established cannot be done safely without
 *     a lock). Surfaced via console.error so the inconsistency is at least
 *     observable rather than silently hidden.
 *
 * Opportunistically PRUNES this domain's redundant/superseded facts after
 * every call — see selectConfirmedFactPruneKeys()'s own doc. Pure
 * optimization; never a correctness dependency.
 */
function recordConfirmedFact(
  userId: string,
  profileId: string,
  domain: ConfirmedDomainName,
  revision: number,
  value: unknown
): boolean {
  const key = confirmedFactKey(userId, profileId, domain, revision, generateOpId());
  try {
    localStorage.setItem(key, JSON.stringify({ revision, value }));
  } catch {
    return false;
  }
  let success = true;
  try {
    const entries = scanConfirmedFactEntries(userId, profileId, domain);
    const parsed = entries
      .map((e) => ({ key: e.key, fact: parseConfirmedFactForDomain(domain, e.raw) }))
      .filter((e): e is { key: string; fact: ConfirmedDomainFact<unknown> } => e.fact !== null);
    const facts = parsed.map((p) => p.fact);
    if (!confirmedFactRevisionIsUnambiguous(facts, revision)) {
      success = false;
      try {
        console.error(
          `SH.2: confirmed-fact conflict for ${domain} at revision ${revision} — deferring confirmation until resolved.`
        );
      } catch {}
    }
    const domainResult = resolveConfirmedDomainState(facts);
    const confirmedRevision = domainResult.status === "confirmed" ? domainResult.fact.revision : null;
    const pruneKeys = selectConfirmedFactPruneKeys(parsed, confirmedRevision);
    for (const pruneKey of pruneKeys) {
      try {
        localStorage.removeItem(pruneKey);
      } catch {}
    }
  } catch {
    // Best-effort scan/prune failure never flips an already-durable write
    // to a failure, and never blocks pruning from being retried on a later
    // call.
  }
  return success;
}

/**
 * Record whichever domain(s) a pull (or push — see doPush() below) just
 * determined were cloud-won AND successfully persisted, as confirmed at the
 * server-issued `revision` that produced them — see the module doc's
 * "Cloud-confirmed local snapshot contract" above. Each domain present in
 * `accepted` is recorded as its OWN independent immutable fact (see
 * recordConfirmedFact()); domains NOT present are completely untouched —
 * there is no "current record" this call reads, merges into, or could ever
 * reject as stale, since a fact is always simply true on its own terms (see
 * this section's own doc for why the old "reject the whole stale mixed
 * commit" step no longer exists).
 *
 * Call this AFTER persistence for the accepted domain(s) has already
 * succeeded — never speculatively before a write is known to have landed
 * ("failed persistence must not advance the baseline"). Returns whether
 * EVERY domain actually present in `accepted` was durably recorded — a
 * caller with follow-on evidence to retire (reconcilePendingOperations()
 * below) must check this before doing so; ordinary callers (doPush(), the
 * pull effects' per-domain commits) may safely ignore the return value,
 * exactly as they did when this returned `Promise<void>`.
 *
 * Codex P1 fix (14th round) — `false` now also covers a recordConfirmedFact()
 * CONFLICT (a different caller already recorded a different canonical value
 * for this exact domain+revision), not just an I/O failure — both mean
 * "this domain's fact for this revision is not durably confirmed as the
 * value THIS caller intended", which must block follow-on gating identically
 * either way.
 */
export async function commitConfirmedBaseline(
  userId: string,
  profileId: string,
  revision: number,
  accepted: AcceptedPlannerDomains
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (accepted.plans === undefined && accepted.lightning === undefined && accepted.days === undefined) {
    return true;
  }
  let allOk = true;
  if (accepted.plans !== undefined) {
    allOk = recordConfirmedFact(userId, profileId, "plans", revision, accepted.plans) && allOk;
  }
  if (accepted.lightning !== undefined) {
    allOk = recordConfirmedFact(userId, profileId, "lightning", revision, accepted.lightning) && allOk;
  }
  if (accepted.days !== undefined) {
    allOk = recordConfirmedFact(userId, profileId, "days", revision, accepted.days) && allOk;
  }
  return allOk;
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
 * `listPendingOps` reads the CURRENT full set via the shared
 * snapshotKeysWithPrefix() primitive (see its own doc above) — each
 * entry's own presence/absence IS independently, atomically true or false
 * at any instant (there is no cross-entry invariant a scan could observe
 * "half-updated"), but the ENUMERATION mechanism itself still needed to be
 * safe against a concurrent retirement shifting indices mid-scan — see
 * Codex P1 fix (15th round): the previous version of this function used
 * its own bespoke forward index loop, which could silently skip a
 * still-pending op if another tab retired an earlier one during the scan.
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
  const prefix = PENDING_OP_PREFIX_TEMPLATE(userId, profileId);
  // Codex P1 fix (15th round) — routes through the SAME shared
  // snapshotKeysWithPrefix() the confirmed-fact scan uses, replacing the
  // bespoke forward index loop this function used to have: another tab
  // retiring op A (removePendingOp — a plain removeItem) WHILE this scan
  // was enumerating could shift op B/C down into an already-consumed
  // index, silently skipping them. See snapshotKeysWithPrefix's own doc.
  return snapshotKeysWithPrefix(prefix).map((key) => key.slice(prefix.length));
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
 * Returns the localStorage key for the ROTATION CURSOR that
 * selectPendingOpBatch() (below) uses to guarantee eventual fairness
 * across pulls when the pending-op set exceeds MAX_PENDING_OPS_PER_PULL —
 * see that function's own doc (Codex P1, 10th round).
 */
function pendingOpCursorKeyForIdentity(userId: string, profileId: string): string {
  return `dwp:sync:${userId}:${profileId}:pendingOpCursor`;
}

/**
 * SH.2 architecture (Codex P1, 10th round) — PENDING-OP FAIRNESS. The
 * server bounds a single GET's opStatus lookups to MAX_LAST_OP_IDS (25 —
 * see route.ts's module doc) to keep query cost bounded regardless of how
 * many operations have accumulated. Round 9 correctly never drops
 * unresolved evidence (an op the server reports `found: false` stays
 * pending indefinitely — see reconcilePendingOperations' own doc), but
 * simply sending `listPendingOps()`'s result UNTRUNCATED (or truncated by
 * always taking the same leading slice) means: if the pending set exceeds
 * 25 and the first 25 never resolve (e.g. their beacons genuinely never
 * arrived), every later op is STARVED — never queried, ever, no matter how
 * many pulls happen, because the same leading 25 always crowd out
 * everything after them. This is what Codex flagged.
 *
 * The fix is a durable ROTATION CURSOR (`dwp:sync:{userId}:{profileId}:pendingOpCursor`,
 * a single opId — the LAST one included in the most recently selected
 * batch), advanced every time truncation actually happens. Each call:
 *   1. Reads the FULL current pending set (listPendingOps() — always a
 *      fresh scan, so concurrently-added ops from another tab are always
 *      visible and immediately eligible for rotation, never lost).
 *   2. If the set already fits within `maxBatch`, returns it as-is —
 *      untouched, and the cursor is left alone (nothing to rotate).
 *   3. Otherwise, locates the cursor's opId in the CURRENT set. If found,
 *      the batch starts at the NEXT position after it (wrapping around to
 *      the start past the end) — this is what guarantees progress: each
 *      oversized pull covers a DIFFERENT `maxBatch`-sized window than the
 *      last, so within `ceil(N / maxBatch)` pulls every op in an N-sized
 *      set has been included in at least one batch, and the cycle simply
 *      repeats indefinitely as pulls continue.
 *   4. If the cursor's opId is NOT found (it was retired since the last
 *      pull, or this is the very first oversized pull), the batch starts
 *      from the beginning — a safe, simple fallback: it never corrupts
 *      anything (there is no shared mutable structure to corrupt, just a
 *      single opaque resume marker), and the eventual-fairness guarantee
 *      still holds from a fresh start, so this is a graceful degradation,
 *      never a bug. This is also EXACTLY why "resolving/removing one op
 *      cannot corrupt the traversal state": removing the op the cursor
 *      currently points at just resets rotation to the beginning next
 *      time, never throws, never skips the rest of the set, never leaves
 *      it in some invalid position (there is no "position" — only an
 *      opaque opId that either matches something in the current set or
 *      doesn't).
 *   5. Writes the new cursor (the LAST opId in the just-selected batch) —
 *      a plain, unconditional single-key overwrite, matching every other
 *      pending-op write in this module: no lock needed, since correctness
 *      here only requires EVENTUAL rotation, not exact cross-tab
 *      coordination — if two tabs race this write, the practical effect is
 *      simply that one tab's chosen starting point "wins" for the next
 *      pull, which is still a valid, safe rotation state (never a
 *      correctness violation, only a possibly slightly less optimal
 *      cadence for that one cycle).
 *
 * Duplicate opIds are structurally impossible here (each pending op has
 * its own key — see listPendingOps' own doc), so there is nothing extra to
 * guard against for that requirement. Request/URL size stays bounded
 * regardless of total pending-set size, since the returned batch is always
 * capped at `maxBatch`.
 */
export function selectPendingOpBatch(
  userId: string,
  profileId: string,
  maxBatch: number = MAX_PENDING_OPS_PER_PULL
): string[] {
  if (typeof window === "undefined") return [];
  const allOpIds = listPendingOps(userId, profileId);
  if (allOpIds.length <= maxBatch) return allOpIds;
  let cursor: string | null = null;
  try {
    cursor = localStorage.getItem(pendingOpCursorKeyForIdentity(userId, profileId));
  } catch {}
  const cursorIndex = cursor !== null ? allOpIds.indexOf(cursor) : -1;
  const start = cursorIndex === -1 ? 0 : (cursorIndex + 1) % allOpIds.length;
  const batch: string[] = [];
  for (let i = 0; i < maxBatch; i++) {
    batch.push(allOpIds[(start + i) % allOpIds.length]);
  }
  try {
    localStorage.setItem(pendingOpCursorKeyForIdentity(userId, profileId), batch[batch.length - 1]);
  } catch {}
  return batch;
}

/**
 * SH.2 architecture (Codex P1, 7th–9th rounds; per-domain facts in the
 * 11th) — BEACON UNCERTAINTY resolution via server-verified operation
 * identity, generalized to a pending-operation SET. Call this after EVERY
 * successful pull (a genuinely resolved GET — never from a `.catch()`
 * branch, which teaches nothing about any pending op's fate) for the SAME
 * (userId, profileId) the pull was for, passing:
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
 * reports the row at revision 6: recording plans/lightning/days facts at
 * revision 6 (via acceptedDomainFactsFromBeacon() + commitConfirmedBaseline())
 * is what BOTH opA's and opB's "accepted" status resolve into — opA's own
 * revision (5) never even enters this call, since only THIS pull's own
 * current cloudRevision (6) is ever recorded; resolveConfirmedDomainState()
 * (syncPayload.ts) is what proves, at READ time, that revision 6 correctly
 * supersedes anything opA might separately have contributed.
 *
 * REMOVE-AFTER-PROMOTION RULE (fixes Codex P1 finding #1 from the 9th
 * round; re-grounded in the 11th): an accepted op's pending entry is
 * retired ONLY when commitConfirmedBaseline()'s return value is `true` —
 * i.e. EVERY domain fact this call attempted to record was durably
 * written (see recordConfirmedFact()'s own doc for the only way this can
 * fail: a thrown localStorage.setItem — quota, private-mode, security
 * errors). If any domain's write failed, every accepted op from this pull
 * is left pending for a later pull to retry — never retired speculatively
 * ahead of durable proof. Codex P1 fix (11th round) — this no longer has
 * ANY dependency on Web Locks: recording a fact is always attempted,
 * regardless of the Locks API's availability, so this mechanism is exactly
 * as reliable with or without it (see recordConfirmedFact's own doc). An
 * op the server reports as NOT found (not yet accepted) is never touched
 * either way, positively or negatively — it simply remains pending,
 * exactly matching "an unaccepted/not-yet-seen op remains pending".
 *
 * The recording attempt itself runs at most ONCE per pull (not once per
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
  const resolved = acceptedDomainFactsFromBeacon(true, cloudRevision, cloudSnapshot);
  if (!resolved) return;
  const allOk = await commitConfirmedBaseline(userId, profileId, resolved.revision, resolved.accepted);
  // A failed write means durable proof does not exist for at least one
  // domain — every accepted op from this pull stays pending rather than
  // being retired speculatively.
  if (!allOk) return;
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
 * scope confirmed-baseline commits (Codex P1, 3rd/11th rounds) and
 * pending-op registration (Codex P1, 6th/7th/9th rounds) — see
 * confirmedFactKey's and pendingOpKeyForIdentity's own docs. null while
 * signed out or before the session has resolved; doPush()
 * and registerUnloadSync() both skip their respective identity-scoped
 * writes entirely when null (neither ever guesses an identity).
 * Updated by setSyncUserId().
 */
let currentSyncUserId: string | null = null;

/**
 * SH.2 architecture (Codex P1, 13th round) — see "Pull execution context" in
 * the module doc above for the full architecture. Bumped by
 * setSyncUserId()/setSyncProfileId() below whenever the value they are
 * given is a GENUINE change (their own early-return-on-no-change guard is
 * exactly the signal). A pull's captured PullContext.epoch stops matching
 * this counter the instant such a change happens, at any point during that
 * pull's lifetime — including while an awaited step is in flight.
 */
let currentPullEpoch = 0;

/**
 * One pull's immutable execution context — capture ONCE via
 * beginPullContext(), immediately after that transition's own
 * setSyncUserId()/setSyncProfileId() calls, and close over the result for
 * the rest of that pull. Never re-read currentSyncUserId/currentSyncProfileId
 * (or a page's own activeUserIdRef/activeProfileIdRef) after an await to
 * decide who a write is for — use ctx.userId/ctx.profileId, which cannot be
 * retroactively changed by a later transition.
 */
export interface PullContext {
  readonly epoch: number;
  readonly userId: string | null;
  readonly profileId: string;
}

/**
 * Snapshot the current sync identity as one immutable pull context. Call
 * this exactly once per pull/transition, after setSyncUserId()/
 * setSyncProfileId() have already been called for it.
 */
export function beginPullContext(): PullContext {
  return { epoch: currentPullEpoch, userId: currentSyncUserId, profileId: currentSyncProfileId };
}

/**
 * True only if no genuine identity/profile transition has happened since
 * `ctx` was captured. Check this after EVERY awaited boundary a pull
 * performs, before any subsequent durable write or gate transition — see
 * "Pull execution context" in the module doc above for the full contract
 * and the DEV_* reference cases for the exact required scenarios.
 */
export function isPullContextCurrent(ctx: PullContext): boolean {
  return isPullEpochCurrent(ctx.epoch, currentPullEpoch);
}

// ── setSyncProfileId ──────────────────────────────────────────────────────────

/**
 * Set the active profile that sync operations should target.
 * If the profile changes, any pending debounced push for the prior profile
 * is immediately cancelled to prevent cross-profile contamination, and the
 * pull epoch (see above) advances — invalidating any PullContext captured
 * under the prior profile.
 * The caller is responsible for triggering a cloud pull for the new profile
 * before re-opening the sync gate.
 */
export function setSyncProfileId(profileId: string): void {
  if (profileId === currentSyncProfileId) return;
  // Profile changed — cancel any pending work for the old profile.
  cancelScheduledSync();
  currentSyncProfileId = profileId;
  currentPullEpoch += 1;
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
 * confirmed baseline under a NEW one, or vice versa — and the pull epoch
 * (see above) advances, invalidating any PullContext captured under the
 * prior identity even if it is mid-await right now.
 */
export function setSyncUserId(userId: string | null): void {
  if (userId === currentSyncUserId) return;
  cancelScheduledSync();
  currentSyncUserId = userId;
  currentPullEpoch += 1;
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
 * 7th-round paragraph and acceptedDomainFactsFromBeacon()'s own doc in
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

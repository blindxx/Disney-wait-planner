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
 *   await getConfirmedStateAtomic(userId, profileId)  — the SAME per-domain
 *                                                       confirmed state as
 *                                                       getConfirmedState(),
 *                                                       but serialized
 *                                                       against every
 *                                                       recordConfirmedFact()
 *                                                       write for this
 *                                                       identity via a
 *                                                       dedicated Web Lock —
 *                                                       returns `null`
 *                                                       (FAIL CLOSED) if Web
 *                                                       Locks are
 *                                                       unavailable, rather
 *                                                       than an un-atomic
 *                                                       scan (SH.2.2, "make
 *                                                       confirmed-authority
 *                                                       scans atomic"
 *                                                       round; see its own
 *                                                       doc). Use ONLY at a
 *                                                       commit boundary that
 *                                                       needs this stronger
 *                                                       guarantee — every
 *                                                       ORDINARY read stays
 *                                                       on the plain,
 *                                                       synchronous
 *                                                       getConfirmedState()
 *                                                       above.
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
 *     isStillValid?,                                    primitive (12th
 *     isAuthorityStillValid?)                           round; FAIL-CLOSED
 *                                                        no-Web-Locks
 *                                                        behavior and
 *                                                        `isStillValid` added
 *                                                        13th round;
 *                                                        `isAuthorityStillValid`
 *                                                        added SH.2.2's
 *                                                        Codex P1 follow-up
 *                                                        round, now
 *                                                        `() => Promise<boolean>`
 *                                                        and `await`ed
 *                                                        (SH.2.2 "make
 *                                                        confirmed-authority
 *                                                        scans atomic"
 *                                                        round — backed by
 *                                                        getConfirmedStateAtomic(),
 *                                                        never the plain
 *                                                        getConfirmedState()
 *                                                        scan, at this
 *                                                        commit boundary);
 *                                                        see its own
 *                                                        doc) — writes
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
 *                                                        still inside the
 *                                                        lock, `isStillValid()`
 *                                                        (else "aborted") —
 *                                                        pass a closure over
 *                                                        isPullContextCurrent(ctx)
 *                                                        here so a commit
 *                                                        that goes stale
 *                                                        while queued for the
 *                                                        lock never lands;
 *                                                        AND, checked LAST of
 *                                                        all, still inside
 *                                                        the lock,
 *                                                        `isAuthorityStillValid()`
 *                                                        (else the DISTINCT
 *                                                        "authority-superseded"
 *                                                        — never conflated
 *                                                        with "superseded")
 *                                                        — pass a closure
 *                                                        that re-derives
 *                                                        confirmed-authority
 *                                                        validity fresh so a
 *                                                        newer confirmed
 *                                                        revision landing
 *                                                        while THIS call was
 *                                                        queued for the lock
 *                                                        (invisible to both
 *                                                        the canonical CAS
 *                                                        and to
 *                                                        `isStillValid`'s
 *                                                        pull-epoch check)
 *                                                        never lands either
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
 *   isLocalDomainCommitSuccess(status)               — true for "committed",
 *                                                        "committed-
 *                                                        unprotected" (SH.2.4
 *                                                        Codex P1 follow-up
 *                                                        round — see
 *                                                        commitLocalDomainRawSync's
 *                                                        own doc), or "noop"
 *                                                        (the durable value
 *                                                        is confirmed to be,
 *                                                        or already was, the
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
 *                                                         DIFFERENT op's key.
 *                                                         SH.2.3 — the VALUE
 *                                                         stored at this key
 *                                                         is now a
 *                                                         JSON-serialized
 *                                                         PendingOpRecord
 *                                                         (opId + this
 *                                                         operation's own
 *                                                         per-domain
 *                                                         evidence — see
 *                                                         buildPendingOpDomains()/
 *                                                         getPendingOpRecord()
 *                                                         below), not the
 *                                                         bare opId string
 *                                                         the 9th round
 *                                                         wrote; every
 *                                                         reader that only
 *                                                         needs the SET OF
 *                                                         opIds (listPendingOps,
 *                                                         selectPendingOpBatch)
 *                                                         still derives it
 *                                                         from the KEY
 *                                                         suffix, unaffected
 *                                                         by this value
 *                                                         format change. A
 *                                                         pre-SH.2.3 entry
 *                                                         (bare opId as the
 *                                                         value) still reads
 *                                                         back safely via
 *                                                         getPendingOpRecord()'s
 *                                                         own JSON.parse
 *                                                         failure fallback —
 *                                                         see its own doc.
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
  resolveEffectiveDurableRaw,
  isProfileOwnedSyncKey,
  confirmedDomainResultsEqual,
  resolveHydrationApplyIntentDisposition,
  isPendingOpDomainEvidenceCurrent,
  canonicalDigest,
  knownBaseRevisionFromConfirmedState,
  parseObservedRevisionFact,
  resolveObservedServerRevision,
  resolveObservedServerRevisionAdvance,
  planHydrationProvenanceDedup,
  isHydrationProvenanceFactObsoleteAfterConfirm,
  planOrdinaryEditFactCommit,
  decideOrdinaryEditPersistOutcome,
  type LocalEditFactRecord,
  type SyncedPlannerPayload,
  type ConfirmedDomainFact,
  type ConfirmedPlannerState,
  type ConfirmedDomainResult,
  type AcceptedPlannerDomains,
  type HydrationApplyIntent,
  type PendingOpRecord,
  type HydrationProvenanceFactRecord,
  type ObservedRevisionFact,
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
  /**
   * SH.2.5.1 — true only when the server has durably, DETERMINISTICALLY
   * rejected this exact operation as a stale first delivery (see
   * evaluateOperationBaseRevision's own doc in syncPayload.ts and
   * lookupOpStatus's own doc in api/sync/planner/route.ts). Unlike
   * `found: false` (merely "not accepted as of this instant" — still
   * possibly in flight), `rejected: true` means this operation can NEVER
   * become accepted later (a row's revision only ever increases), so
   * reconcilePendingOperations() below retires it unconditionally rather
   * than leaving it pending indefinitely. Always false/absent when `found`
   * is true.
   */
  rejected?: boolean;
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

export type LocalDomainCommitStatus =
  | "committed"
  | "noop"
  | "superseded"
  | "authority-superseded"
  | "failed"
  | "unavailable"
  | "aborted";

// ── Local edit facts (SH.2, Codex P1, 17th round) ───────────────────────────
// LOCAL-FIRST + CROSS-TAB SERIALIZATION — durable, unconditional, lock-free
// publication of ordinary-edit intent, separate from the canonical domain
// key those edits also still write directly (unchanged for every existing
// reader — loadFromStorage, buildSyncedPlannerPayload, mount-time hydration
// — none of which need to know this log exists).
//
// Root cause this closes — Codex P1 finding #3, 17th round: since the 16th
// round made ordinary edits unlocked and synchronous (see this section's own
// doc above), a genuinely concurrent CROSS-TAB interleaving is possible in
// principle: hydration (tab H) reads the canonical key's current value
// inside its Web Lock, an ordinary edit in a DIFFERENT tab (E, which never
// requests this lock) writes a newer value in between, and H's own
// setItem — still inside the SAME synchronous, non-yielding lock callback —
// overwrites it. A single-tab race is not possible here (H's lock callback
// has no `await` in it, so nothing else in THAT tab can run between its own
// read and write), but nothing stops a truly concurrent OTHER tab's plain,
// unlocked setItem from landing in that window.
//
// Each ordinary edit (commitLocalDomainRawSync) additionally publishes an
// append-only, permanently-unique "edit fact" key — `editId` a fresh
// generateOpId() per call, mirroring confirmedFactKey's own physical-
// immutability argument: a plain, unconditional setItem to an
// already-unique key can never race with anything, from any tab. Hydration
// (commitLocalDomainRaw) snapshots this keyspace BEFORE it even requests
// its lock, then re-validates that snapshot as the LAST step before its own
// write, still inside the lock: if any edit-fact key now exists that was
// not present in the baseline snapshot, some tab's edit landed after this
// commit's own decision was made (whether or not the plain raw-value CAS
// above happened to also catch it), and this commit reports "superseded"
// instead of overwriting it. This is a supplement to the existing raw-value
// CAS, not a replacement: the raw check already catches the ordinary case
// where the edit's canonical write landed before hydration's own read; the
// edit-fact check exists specifically for the narrower window where it did
// not (edit's own canonical write not yet visible, but its edit-fact
// already is, or the reverse).
//
// This does not achieve a FORMALLY zero-probability race (two back-to-back,
// non-yielding synchronous statements in H's own lock callback — the final
// edit-fact re-scan and the write immediately after it — still bound a
// residual window with no JS yield point inside it, unclosable by any
// mechanism plain localStorage read/write registers can provide without
// every writer, including ordinary edits, sharing true mutual exclusion,
// which the task explicitly forbids requiring of them). What it closes
// completely is the PRACTICALLY significant concern: the edit-fact log
// itself is NEVER touched by hydration, so a user's true edit is NEVER
// unrecoverably lost even in that worst case — see readLatestDurableValue()
// below for how the unload/push path reads this log as authoritative
// specifically so a transient canonical-key clobber can never cause a lost
// push, regardless of this residual window.
//
// RESOLVED — SH.2.4 "Concurrent Local Edit Fact Safety" (recorded, not yet
// fixed, during SH.2.2's Codex P1 follow-up rounds; fixed this round): the
// PRACTICALLY significant instance of this concurrent-edit-fact deletion
// race was commitLocalDomainRawSync()'s own retirement — see its own doc
// below and planOrdinaryEditFactCommit() in syncPayload.ts for the full
// root-cause writeup and fix. In short: that function used to re-scan the
// edit-fact keyspace AFTER its own writes and delete every key that was not
// its own, with no way to tell "a fact I already knew about" from "a fact a
// concurrent OTHER tab just published" — two racing ordinary edits could
// each delete the other's still-unresolved fact, exactly the failure this
// phase closes. The fix retires ONLY a snapshot taken BEFORE that call's
// own writes (never a key outside it, structurally), mirroring
// commitLocalDomainRaw()'s own `baselineEditFactIds` discipline immediately
// below — which was, and remains, correct on its own terms: its retirement
// loop only ever removes keys it itself proved (via its own re-validation
// gates) were part of its own observed, unchanged baseline.
function localEditFactPrefix(key: string): string {
  return `dwp:localEditFact:${key}:`;
}

function localEditFactKey(key: string, editId: string): string {
  return `${localEditFactPrefix(key)}${editId}`;
}

/**
 * Reads the newest DURABLE value published for `key` — preferring the
 * local-edit-fact log over the canonical key itself. commitLocalDomainRawSync()
 * always prunes a canonical key's edit-fact log down to exactly one entry
 * (the edit it just published) on every successful call, so "exactly one
 * fact key exists" is the overwhelmingly common case and its value is
 * always at least as fresh as the canonical key's own current value — even
 * if a concurrent hydration race (see this section's own doc above)
 * transiently clobbers the canonical key itself.
 *
 * SH.2.1 P3 — this is now a thin localStorage I/O wrapper around
 * resolveEffectiveDurableRaw() (syncPayload.ts), the PURE decision this
 * function reduces to: read every currently-recorded edit-fact key's raw
 * value plus the canonical key's own raw value, then let that pure
 * function decide which one is authoritative. Extracted specifically so
 * the SAME decision plans/page.tsx's and lightning/page.tsx's pull effect
 * now ALSO makes (for pre-fetch snapshots, post-fetch "current" candidates,
 * and winner selection — see resolveEffectiveDurableRaw()'s own doc for
 * the full SH.2.1 P3 rationale) is provably identical to the one this
 * function has always made for the unload/push path
 * (buildPayloadFromStorage() below, via doPush()/registerUnloadSync()) —
 * ONE shared resolver, not two separate interpretations of "current local
 * value" for different parts of the sync state machine.
 *
 * Exported (like getConfirmedState/commitConfirmedBaseline and the other
 * primitives in this module) purely so DEV_*-style Node coverage can
 * exercise the pure core directly against the real production
 * implementation.
 */
export function readLatestDurableValue(key: string): string | null {
  const factRawValues: string[] = [];
  for (const factKey of snapshotKeysWithPrefix(localEditFactPrefix(key))) {
    try {
      const raw = localStorage.getItem(factKey);
      if (raw !== null) factRawValues.push(raw);
    } catch {}
  }
  let canonicalRaw: string | null;
  try {
    canonicalRaw = localStorage.getItem(key);
  } catch {
    canonicalRaw = null;
  }
  return resolveEffectiveDurableRaw(canonicalRaw, factRawValues);
}

/**
 * SH.2.2 (Codex P1 "hydration-provenance causality" round) — does a
 * currently-surviving local-edit fact exist for `key` at all, right now?
 * See hasHydrationProvenanceMatch's own doc above for WHY this matters:
 * hydration provenance must mean "these bytes are still causally
 * attributable to hydration", never merely "these bytes happen to match
 * something a past hydration produced". A local-edit fact currently
 * existing for this key means the MOST RECENT durable-authority-changing
 * event for it was a genuine user edit — LOCAL-EDIT FACT LIFECYCLE (see
 * commitLocalDomainRaw's own doc) guarantees that ANY successful hydration
 * commit already retired every edit fact it captured as its own
 * `baselineEditFactIds` frontier, so a fact surviving THIS check can only
 * be newer than the LAST hydration commit for this key — never a stale
 * leftover from one. Callers (each page's hydration-provenance
 * consultation) must treat a `true` result as an absolute veto: skip the
 * hydration-provenance lookup entirely, regardless of whether the edit's
 * OWN bytes happen to coincide with some historical hydration-provenance
 * record's value — an edit that reverts to old content is still a genuine,
 * newer edit, and a value-only match (ignoring this causal signal) would
 * silently let cloud/reconciliation win over it, exactly the "old
 * hydration facts mask new local edits" failure class this round closes.
 */
export function hasSurvivingEditFact(key: string): boolean {
  return snapshotKeysWithPrefix(localEditFactPrefix(key)).length > 0;
}

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
function withLocalDomainCommitLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (hasLocalDomainSerialization()) {
    // lib.dom.d.ts's LockGrantedCallback<T> types the callback as returning
    // `T` verbatim, not `T | PromiseLike<T>` — it does not model the Locks
    // API's own runtime behavior of awaiting a returned promise before
    // releasing the lock. Passing our `Promise<T>`-returning callback
    // therefore infers the lock request's own generic as `Promise<T>`
    // itself, yielding `Promise<Promise<T>>` — `.then((v) => v)` performs
    // the SAME flattening every Promise constructor already does for a
    // thenable returned from a handler, unwrapping the type correctly to
    // match what actually happens at runtime.
    return navigator.locks.request(localDomainCommitLockName(key), () => fn()).then((v) => v);
  }
  return fn();
}

// ── Confirmed-authority atomic observability (SH.2.2, Codex P1 "make
// confirmed-authority scans atomic" round) ─────────────────────────────────
// Root cause: getConfirmedState() (below) reads every confirmed-fact key via
// snapshotKeysWithPrefix() — capture `localStorage.length`, then enumerate
// indices `length-1` down to `0`. That produces a STABLE snapshot against
// same-tab removal (see snapshotKeysWithPrefix's own doc), but it is NOT an
// atomic snapshot against a DIFFERENT tab's concurrent WRITE: `.length` and
// each `.key(i)` are separate synchronous calls to the shared, cross-process
// localStorage backend, and nothing fences them together as one atomic
// operation. A write from another tab that lands in the real-world gap
// between this tab's `.length` read and its enumeration finishing can settle
// at a storage position this scan's already-captured `length` bound never
// visits — a genuine torn read, invisible to this tab's own single-threaded,
// non-yielding JS execution (which cannot itself be interrupted mid-scan),
// because the interleaving happens in the shared storage backend, not in
// this tab's own event loop. recordConfirmedFact()'s write is itself always
// safe in isolation (a plain `setItem` to a permanently-unique key — see the
// "Per-domain confirmed state" section above), but a REVALIDATION scan that
// races a write in this window can observe old authority as still current —
// exactly the gap SH.2.2's commit-time authority check depends on being
// closed at the hydration commit boundary.
//
// Fix: a dedicated per-(userId, profileId) Web Lock — confirmedAuthorityLockName()
// below — serializes every confirmed-fact WRITE (recordConfirmedFact, all
// three domains share it) against every ATOMIC confirmed-state READ
// (getConfirmedStateAtomic() below) for that same identity. Total ordering
// under a shared lock name means a scan run inside it can never observe a
// PARTIAL write: either it runs entirely before a not-yet-acquired writer
// (legitimately "happens-before" it — that writer simply waits its turn, and
// its fact becomes visible to the NEXT scan) or entirely after a writer that
// already released the lock (its fact is now fully, durably visible). No
// third possibility exists, unlike the plain `.length`-bounded scan above.
// One lock per (userId, profileId) — not per domain — is deliberately
// coarser than the canonical-domain-key lock's granularity: confirmed-fact
// writes and atomic reads are both rare, short, purely-synchronous critical
// sections (no I/O beyond localStorage itself), so the small cross-domain
// contention cost is worth keeping this to ONE lock resource rather than
// three, while EACH domain's own facts/revisions remain completely
// independent DATA (this lock only ever gates observability, never merges or
// blocks one domain's revision against another's — see the "Per-domain
// confirmed state" section above, unchanged).
//
// getConfirmedState() itself (the plain, synchronous, non-atomic scan) is
// UNCHANGED and still the right tool for every ORDINARY read (the once-per-
// pull baseline check before winner selection, and any other caller that
// does not sit at a commit boundary) — those are already revalidated later
// by the atomic check if they turn out to matter, so paying the (tiny but
// nonzero) lock-acquisition cost on every such read would be unjustified.
// getConfirmedStateAtomic() below is a NEW, ADDITIONAL primitive used ONLY
// where SH.2.2 already established a commit-time gate needs to exist — it
// does not replace or duplicate getConfirmedState()'s own scan logic; it
// simply runs that SAME function's body inside the serializing lock.
//
// FAIL CLOSED (this round's explicit requirement) — getConfirmedStateAtomic()
// returns `null` when Web Locks are unavailable, rather than silently
// falling back to the non-atomic scan (which would just reintroduce the
// exact race this fix closes) or fabricating an optimistic answer. Every
// caller of this function is a commit-time gate that already knows how to
// treat "authority could not be safely established" as equivalent to "do
// not accept this winner" — see each page's own `checkAuthorityStillValid`/
// `revalidateAuthorityBeforeCommit` doc for how a `null` result is folded
// into the SAME whole-pull deferral path as a genuine authority change,
// mirroring commitLocalDomainRaw()'s own "unavailable" fail-closed status
// for the identical class of environment limitation. recordConfirmedFact()'s
// WRITE side, by contrast, does NOT need to fail closed when Web Locks are
// unavailable — writing to a permanently-unique key is unconditionally safe
// on its own terms (per the 15th round's own invariant, unchanged); it
// simply runs its existing body directly, without the lock, exactly as
// before this round, so ordinary confirmed-fact recording (including every
// push's own confirmation) keeps working in a browser lacking Web Locks —
// only the STRONGER atomic-observability guarantee is unavailable there.
function confirmedAuthorityLockName(userId: string, profileId: string): string {
  return `dwp:confirmedAuthority:${userId}:${profileId}`;
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
 *
 * Codex P1 fix (17th round) — a SECOND, independent gate immediately before
 * that same write: `baselineEditFactIds` snapshots this key's local-edit-fact
 * keyspace (see this section's own module doc above) SYNCHRONOUSLY at call
 * time, before the lock is even requested. If the keyspace has GROWN by the
 * time this commit is about to write — some tab's ordinary edit landed
 * after this decision's inputs were captured — this commit reports
 * "superseded" and never writes, exactly like the existing raw-value CAS
 * above, even in the narrow window where the raw-value check alone would
 * have missed it (the edit's fact key already visible, its canonical write
 * not yet, or vice versa).
 *
 * LOCAL-EDIT FACT LIFECYCLE (Codex P1, 18th round) — a local-edit fact means
 * "unresolved local intent", not "a local edit happened at some point". A
 * successful "committed" write here durably supersedes whatever content was
 * on disk before it, so it must ALSO retire the edit fact(s) that described
 * that now-superseded content — otherwise readLatestDurableValue() (which
 * prefers a surviving edit fact over the canonical key) keeps resurrecting
 * the stale pre-hydration value forever, capable of later being pushed back
 * over the very cloud state that just won. This closes Codex P1 finding #1,
 * 18th round.
 *
 * `baselineEditFactIds` is exactly the right retire set: it is the COMPLETE
 * and CURRENT edit-fact keyspace for this key as of decision time, proven
 * so by the re-validation loop immediately above (any key outside it would
 * already have made this commit report "superseded" instead of reaching the
 * write) — an "explicit edit-fact frontier", snapshotted, validated, then
 * consumed. Retiring exactly this set — never a blind "clear every fact for
 * this key right now" — is what guarantees a fact published AFTER this
 * snapshot (required case 2: a genuinely newer local edit that appeared
 * while this hydration was in flight) is never touched: such a fact either
 * already aborted this commit via the loop above (most cases), or, in the
 * single-threaded window between that loop and this retirement running (no
 * `await` between them), cannot exist at all.
 *
 * COMMIT-TIME AUTHORITY REVALIDATION (SH.2.2, Codex P1 follow-up round;
 * extended to gate "noop" too in the SH.2.2 second follow-up round below) —
 * `isAuthorityStillValid`, when provided, is a FOURTH gate, checked LAST of
 * all — still inside the lock's critical section, immediately before ANY
 * success return (a real write, or a genuine noop — see below). Root cause
 * this closes: SH.2.2's original fix re-validated confirmed authority
 * (getConfirmedState() vs. this pull's own cloud revision) ONLY at the page
 * level, BEFORE calling this function — but this function can then itself
 * wait on `navigator.locks.request()` if another writer (this tab's own
 * concurrent commit, or another tab's) currently holds this key's lock.
 * Confirmed authority can advance DURING that wait (e.g. an already-in-
 * flight push resolves and calls commitConfirmedBaseline() for a newer
 * revision) without ever touching this key's canonical bytes — so the
 * raw-value CAS above still passes — and without advancing the pull epoch —
 * so a caller's own `isStillValid` (pull/auth/profile cancellation) still
 * passes too. Neither existing gate can see this: the page-level pre-check
 * is simply too early, from this function's point of view, relative to the
 * lock wait it cannot itself see or control. Re-checking authority as the
 * LAST statement before ANY success return — after canonical CAS, after the
 * noop-safety check, after `isStillValid`, after the edit-fact re-scan — is
 * what actually closes the gap: nothing can happen between this check and
 * the return, since there is no further `await` between them.
 *
 * NOOP IS NOT AN EARLY EXIT (SH.2.2, Codex P1 SECOND follow-up round) — the
 * first follow-up round above left one gap: the noop-safety check
 * (immediately below) still RETURNED "noop" directly, bypassing
 * `isStillValid`, the edit-fact re-scan, AND `isAuthorityStillValid`
 * entirely. Since `isLocalDomainCommitSuccess()` treats "noop" and
 * "committed" identically, this let a stale pull's commit be reported
 * SUCCESSFUL — reopening syncReady and letting the page continue from an
 * obsolete server revision — purely because the bytes it wanted to write
 * already happened to already be on disk, with NONE of the validation a
 * "committed" outcome is required to pass first. The fix: the noop-safety
 * check now only sets a flag (`isSafeNoop`); the ACTUAL "noop" return
 * happens AFTER `isStillValid`, the edit-fact re-scan, and
 * `isAuthorityStillValid` all pass — the identical gate sequence a
 * "committed" outcome passes through, with the write/retire step itself
 * skipped (nothing changed on disk, so nothing needs writing; per the
 * LOCAL-EDIT FACT LIFECYCLE rule below, nothing needs retiring either — see
 * that rule's own doc for why a fact that already agreed with `nextRaw` was
 * never "superseded" by anything this call did).
 *
 * Ordering (a genuine local edit or an aborted context must still win over
 * a commit-time authority regression, and BOTH must still win over a
 * would-be noop being reported as success — required cases 1 & 3):
 * canonical CAS ("superseded") → noop-safety (sets `isSafeNoop`, does NOT
 * return) → `isStillValid` ("aborted") → edit-fact re-scan ("superseded")
 * → `isAuthorityStillValid` ("authority-superseded") → `isSafeNoop`?
 * ("noop") → write + retire ("committed"). Reports the DISTINCT status
 * "authority-superseded" — never reused as the existing "superseded"
 * (which means "a local edit intervened") — so callers can still tell the
 * two apart when logging/reconciling, even though both feed the SAME
 * SH.2.2 one-shot recovery decision (decideStaleResponseRecovery() in
 * syncPayload.ts already treats "local-edit-superseded" as
 * always-safe-to-retry; each page's pull effect maps "authority-superseded"
 * the same way). Never writes, never retires any edit fact, on
 * "authority-superseded" — identical non-mutation guarantee to every other
 * non-"committed" outcome, "noop" included. Defaults to always-valid, so
 * every EXISTING caller (and the no-Web-Locks "unavailable" fail-closed
 * path, which never even reaches this check) is unaffected unless it opts
 * in.
 *
 * Retirement runs on "committed" ONLY — including a "noop"-shaped commit
 * this function upgrades to "committed" when canonical bytes already
 * equalled `nextRaw` but a surviving edit fact still disagreed (see the
 * HYDRATION NOOP MUST NOT OUTRANK A SURVIVING FACT doc below) — never on
 * any outcome where nothing was actually superseded (a GENUINE noop, or
 * any other non-write outcome — required case 3: a failed persistence must
 * leave edit facts and gates untouched; a genuine noop must leave them
 * untouched too, unchanged by this round).
 *
 * HYDRATION NOOP MUST NOT OUTRANK A SURVIVING FACT (Codex, earlier round;
 * gate ordering corrected in the SH.2.2 second follow-up round above) — a
 * THIRD gate, evaluated only when the byte-level CAS above says "noop"
 * (`currentRaw === nextRaw`): that comparison alone proves canonical bytes
 * already equal the winner, never that DURABLE AUTHORITY does. Canonical
 * can equal `nextRaw` purely because a prior pull left it at a stale
 * pre-hydration value (the documented cross-tab hydration race) while a
 * surviving, unresolved edit fact — outranking canonical per
 * resolveEffectiveDurableRaw()'s own rule — still holds a genuinely
 * different value. Reporting that as a safe "noop" would let hydration
 * count as SUCCESS (isLocalDomainCommitSuccess treats noop and committed
 * identically) while leaving the stale fact fully intact and unretired:
 * durably authoritative for every later readLatestDurableValue() read,
 * capable of resurfacing and even being pushed back over the cloud state
 * this pull just recorded as confirmed. A byte-level noop is provisionally
 * trusted (`isSafeNoop = true`) ONLY when
 * resolveEffectiveDurableRaw(currentRaw, this decision's own
 * baselineEditFactIds frontier) already agrees with `nextRaw` — but, as of
 * the SH.2.2 second follow-up round, that verdict alone no longer returns
 * "noop" immediately; it still has to survive `isStillValid`, the
 * edit-fact re-scan, and `isAuthorityStillValid` below before this function
 * actually reports success. When resolveEffectiveDurableRaw() disagrees
 * with `nextRaw` (`isSafeNoop` stays false), this falls through to the
 * EXACT SAME validation-then-write-and-retire path a genuine "write"
 * decision takes — canonical already holds `nextRaw`'s bytes (the setItem
 * below is a harmless idempotent rewrite), but the conflicting fact
 * frontier still needs the SAME validity/re-scan gates (required case 6: a
 * fact landing AFTER this snapshot still reports "superseded", never
 * silently retired) and the SAME retirement.
 */
export function commitLocalDomainRaw(
  key: string,
  expectedPreviousRaw: string | null,
  nextRaw: string,
  isStillValid: () => boolean = () => true,
  isAuthorityStillValid: () => Promise<boolean> = () => Promise.resolve(true),
  precomputedBaselineEditFactIds?: readonly string[]
): Promise<LocalDomainCommitStatus> {
  if (!hasLocalDomainSerialization()) return Promise.resolve("unavailable");
  // SH.2.4.1 — when a caller (commitDomainHydration(), which durably
  // records this SAME frontier into its HydrationApplyIntent BEFORE this
  // function is ever invoked) already snapshotted the pre-write edit-fact
  // keyspace, reuse that EXACT snapshot rather than taking a second,
  // independently-timed one here — the intent's own crash-recovery frontier
  // (see resolveHydrationApplyIntentDisposition's own doc in syncPayload.ts)
  // must be provably identical to the set this function actually retires on
  // a "committed" write, by construction, not merely by the two calls
  // happening to run back-to-back with no `await` between them. Callers
  // with no such pre-existing snapshot (the unauthenticated path, and every
  // pre-SH.2.4.1 caller) are unaffected — this function takes its own
  // snapshot exactly as before.
  const baselineEditFactIds = precomputedBaselineEditFactIds
    ? new Set(precomputedBaselineEditFactIds)
    : new Set(snapshotKeysWithPrefix(localEditFactPrefix(key)));
  return withLocalDomainCommitLock(key, async (): Promise<LocalDomainCommitStatus> => {
    let currentRaw: string | null;
    try {
      currentRaw = localStorage.getItem(key);
    } catch {
      return "failed";
    }
    const decision = decideLocalDomainCommit(currentRaw, expectedPreviousRaw, nextRaw);
    if (decision === "superseded") return "superseded";
    // SH.2.2 (Codex P1 second follow-up round) — NOOP IS NOT AN EARLY EXIT.
    // `isSafeNoop` records the HYDRATION NOOP SAFETY verdict (below) as a
    // flag rather than returning immediately: a "noop" is a SUCCESS outcome
    // exactly like "committed" (isLocalDomainCommitSuccess treats them
    // identically), so it is subject to the EXACT SAME validation sequence
    // every other successful return must pass — see this function's own
    // doc above ("COMMIT-TIME AUTHORITY REVALIDATION") for why returning
    // "noop" before that sequence ran was itself the bug this round closes:
    // confirmed authority (or a concurrent local edit) can advance during
    // THIS call's own lock wait exactly as easily whether the byte-level
    // decision was "write" or "noop" — canonical bytes already matching
    // `nextRaw` proves nothing about whether that match is still safe to
    // report as success at the moment this function actually returns.
    let isSafeNoop = false;
    if (decision === "noop") {
      // HYDRATION NOOP MUST NOT OUTRANK A SURVIVING FACT (Codex, earlier
      // round) — see this function's own doc above for the full rationale.
      // `decision === "noop"` only proves canonical bytes already equal
      // `nextRaw`; it says nothing about a surviving edit fact that might
      // still disagree. Read baselineEditFactIds' own raw values (the SAME
      // frontier the shared re-scan below validates) and ask the ONE
      // shared durable-authority resolver whether it agrees with nextRaw.
      const baselineFactRawValues: string[] = [];
      for (const factKey of baselineEditFactIds) {
        let factRaw: string | null;
        try {
          factRaw = localStorage.getItem(factKey);
        } catch {
          continue;
        }
        if (factRaw !== null) baselineFactRawValues.push(factRaw);
      }
      const effectiveDurableRaw = resolveEffectiveDurableRaw(currentRaw, baselineFactRawValues);
      if (effectiveDurableRaw === nextRaw) {
        isSafeNoop = true;
      }
      // Durable authority disagrees with nextRaw — NOT a safe noop. Falls
      // through to the exact same validation-then-write-and-retire path
      // "write" takes below: canonical already holds nextRaw's bytes, so
      // the setItem there is a harmless idempotent rewrite, but the
      // conflicting fact frontier still needs validating and retiring.
    }
    // Codex P1 fix (13th round) — the LAST gate before mutation, evaluated
    // here rather than by the caller after this Promise resolves, so a
    // context that went stale while this commit sat queued for the lock is
    // still caught before anything is written. Codex P1 fix (SH.2.2 second
    // follow-up round) — now evaluated UNCONDITIONALLY on the path to ANY
    // success return, "noop" included: a stale pull/auth/profile context
    // must abort a would-be noop exactly as it already aborted a would-be
    // write, never let it slip through as a quiet success.
    if (!isStillValid()) return "aborted";
    // Codex P1 fix (17th round) — the LAST gate of all before this round,
    // evaluated as the final statement before the write itself: any
    // edit-fact key not in the baseline snapshot means a concurrent edit —
    // from ANY tab, since ordinary edits never participate in this lock —
    // is newer than this decision and must survive. See this section's own
    // module doc above for the residual window this does and does not
    // close. Codex P1 fix (SH.2.2 second follow-up round) — now evaluated
    // UNCONDITIONALLY on the path to ANY success return, "noop" included:
    // required case 3 — a local edit that appears while this call waits
    // for the lock must still take precedence over a would-be noop exactly
    // as it already did over a would-be write, and the edit itself must
    // survive untouched (this loop only ever READS keys to compare against
    // `baselineEditFactIds`; it never writes or retires anything — a noop
    // that reaches this point still retires nothing below either way).
    for (const factKey of snapshotKeysWithPrefix(localEditFactPrefix(key))) {
      if (!baselineEditFactIds.has(factKey)) return "superseded";
    }
    // SH.2.2 (Codex P1 follow-up round) — COMMIT-TIME AUTHORITY
    // REVALIDATION: the LAST gate of all, checked immediately before ANY
    // success return — see this function's own doc above for the full
    // rationale (confirmed authority can advance during THIS call's own
    // lock wait, which neither the canonical CAS above nor a caller's
    // `isStillValid` can observe). A distinct, non-"superseded" status —
    // "superseded" remains reserved for a genuine local-edit race (required
    // case 3: a local edit occupies the priority slot immediately above
    // this one and always wins first). Codex P1 fix (SH.2.2 second
    // follow-up round) — now evaluated UNCONDITIONALLY on the path to ANY
    // success return, "noop" included (required case 1): a stale pull must
    // never be treated as successful, reopen syncReady, or let a page's
    // pull effect continue from an obsolete server revision merely because
    // the bytes it wanted to write already happened to be on disk.
    if (!(await isAuthorityStillValid())) return "authority-superseded";
    // SH.2.2 (Codex P1 "make confirmed-authority scans atomic" round) — a
    // SECOND edit-fact re-scan, immediately after the authority check above.
    // Making `isAuthorityStillValid` genuinely atomic (see
    // confirmedAuthorityLockName's own doc above) requires it to `await` a
    // separate Web Lock — a real yield point this function did not have
    // before. Without this second scan, a genuinely concurrent OTHER tab's
    // ordinary edit (commitLocalDomainRawSync, which never participates in
    // any lock) could land in exactly that new await window, after the
    // first edit-fact re-scan already passed, and this commit would still
    // overwrite it — reopening the precise race the 17th round's rescan was
    // built to close. Re-running the SAME check, with the SAME
    // `baselineEditFactIds` frontier, immediately after the only await left
    // between here and the write, closes it again: an edit that landed
    // before the FIRST rescan is still caught there (cheaply, before ever
    // acquiring the confirmed-authority lock — required case: local edit
    // still wins over a commit-time authority regression, unchanged); an
    // edit that landed only during the authority check's own await is
    // caught HERE instead, still reported as "superseded" (never
    // "authority-superseded") — the local edit still wins as the reported
    // reason either way, exactly preserving the existing precedence. Only
    // one real yield point remains between this statement and the write —
    // eliminated, not just narrowed.
    for (const factKey of snapshotKeysWithPrefix(localEditFactPrefix(key))) {
      if (!baselineEditFactIds.has(factKey)) return "superseded";
    }
    // A genuine safe noop has now passed every gate a real write would
    // have: pull/auth/profile context is still current, no concurrent edit
    // fact landed during the lock wait, and confirmed authority is still
    // valid. Return here — BEFORE the write/retire below — so a noop never
    // performs the write (nothing changed on disk; the setItem would be a
    // no-op in practice, but is still skipped on principle) and, per the
    // established LOCAL-EDIT FACT LIFECYCLE rule, never retires a fact
    // either (retirement is reserved for a write that actually superseded
    // something — see that rule's own doc below; a fact that already
    // agreed with `nextRaw`, as this round's `isSafeNoop` verdict itself
    // proves, was never "superseded" by anything this call did).
    if (isSafeNoop) return "noop";
    try {
      localStorage.setItem(key, nextRaw);
    } catch {
      return "failed";
    }
    // Codex P1 fix (18th round) — LOCAL-EDIT FACT LIFECYCLE: this write just
    // durably superseded exactly the facts captured in `baselineEditFactIds`
    // (proven complete and current by the re-validation loop above) — see
    // this function's own doc above for why retiring precisely this set,
    // and only on a genuine "committed" write, is what keeps
    // readLatestDurableValue() resolving to the new winner instead of a
    // stale pre-hydration edit.
    for (const factKey of baselineEditFactIds) {
      try {
        localStorage.removeItem(factKey);
      } catch {}
    }
    return "committed";
  });
}

/** The outcomes commitLocalDomainRawSync() (below) can report — a strict
 * subset of LocalDomainCommitStatus, since a synchronous, lock-free,
 * always-unconditional write can never be "superseded", "aborted", or
 * "unavailable" (there is no baseline to violate, no queued wait to go
 * stale during, and no serialization primitive it depends on).
 * "committed-unprotected" (SH.2.4 Codex P1 follow-up round) — see
 * decideOrdinaryEditPersistOutcome()'s own doc in syncPayload.ts — is
 * added this round: the requested value is durably preserved (never lost
 * to React state alone), but only ONE of {new edit fact, canonical
 * overwrite} actually landed, so this write does not carry the FULL SH.2.4
 * concurrent-fact protection a genuine fact+canonical pair provides.
 * isLocalDomainCommitSuccess() still treats it as success. */
export type LocalDomainSyncCommitStatus = "committed" | "committed-unprotected" | "noop" | "failed";

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
 *
 * SH.2.1 P1 fix (Codex finding #2, this round) — "the durable value" for
 * that noop check means the EFFECTIVE DURABLE value (canonical + any still-
 * unresolved edit fact for this key — see readLatestDurableValue()'s own
 * doc above), never the canonical key's raw bytes alone. Canonical storage
 * can be stale relative to a surviving edit fact (the documented cross-tab
 * hydration race); comparing `nextRaw` against canonical alone let a
 * genuine user action — deliberately setting this key back to canonical's
 * stale value — look like a no-op, silently leaving that unrelated, older
 * edit fact as durable authority instead of publishing the user's actual,
 * fresher intent. Comparing against the effective durable value instead
 * means a true no-op is still recognized whenever `nextRaw` already IS
 * durable authority (whichever key holds it), while any genuine divergence
 * — including a value that happens to match stale canonical bytes — always
 * publishes a fresh edit fact, exactly as an ordinary edit should.
 *
 * Codex P1 fix (17th round) — before writing the canonical key, first
 * publishes this edit as its own permanently-unique, append-only
 * local-edit-fact entry (see this section's own module doc above) — a
 * single unconditional setItem to a key nothing else could ever also
 * target, so it can never race with anything, from any tab. This is what
 * lets hydration's own commitLocalDomainRaw() detect "an edit landed after
 * my decision was made" even in the narrow window its raw-value CAS alone
 * could miss, and what lets readLatestDurableValue() (below) always recover
 * this edit's true content even if a concurrent hydration race transiently
 * clobbers the canonical key afterward.
 *
 * SH.2.4 fix (Concurrent Local Edit Fact Safety) — retirement of this key's
 * OTHER edit-fact entries used to be a re-scan taken AFTER this call's own
 * writes, deleting every key that was not the one just published. Because
 * ordinary edits are deliberately unlocked and synchronous (16th round,
 * above), a genuinely concurrent OTHER tab's own commitLocalDomainRawSync()
 * call can publish ITS fact at any point relative to this call's own
 * statements — including strictly between this call's fact/canonical writes
 * and that post-write re-scan. Such a re-scan cannot distinguish "a fact I
 * already knew about and am superseding" from "a fact a different writer
 * just published a moment ago" — it deleted both identically, so two tabs
 * racing this function could each delete the OTHER's still-unresolved fact.
 * See planOrdinaryEditFactCommit()'s own module doc in syncPayload.ts for
 * the full root-cause writeup and the fix: `baselineFacts` is this key's
 * local-edit-fact keyspace captured BEFORE any of this call's own writes —
 * this writer's own observed frontier — and retirement is computed as a
 * pure function of ONLY that snapshot, so a fact that did not exist yet
 * when this call started is structurally unreachable by the plan, never a
 * candidate for deletion no matter how this call's own writes and a
 * concurrent tab's interleave. Same-value dedup (an existing baseline fact
 * already carrying `nextRaw`'s exact bytes is reused instead of duplicated)
 * is also handled by that same pure decision — see its own doc.
 *
 * SH.2.4 Codex P1 follow-up fix ("fact allocation near quota must not block
 * a best-effort canonical write") — a NEW fact key (`plan.ownFactKey`, when
 * `plan.writeNew`) is written BEFORE the canonical key, but allocating a
 * brand-new key can fail on `QuotaExceededError` in a case where
 * overwriting the EXISTING canonical key with the same/smaller value would
 * still succeed (a new key needs genuinely additional storage; an overwrite
 * usually does not). The previous implementation returned "failed" the
 * instant that fact `setItem` threw, WITHOUT ever attempting the canonical
 * write — a user's edit that could have been durably preserved was instead
 * left only in React state, and lost on reload. The fix: attempt BOTH
 * writes unconditionally (neither leg's failure skips the other), then
 * classify the outcome via decideOrdinaryEditPersistOutcome() (syncPayload.ts
 * — see its own doc for the full case analysis). Retirement of this
 * decision's own observed baseline facts still runs whenever EITHER leg
 * landed (never when both failed — fail safely, nothing durable changed, so
 * nothing already on disk is disturbed).
 */
export function commitLocalDomainRawSync(key: string, nextRaw: string): LocalDomainSyncCommitStatus {
  if (typeof window === "undefined") return "failed";
  let canonicalRaw: string | null;
  try {
    canonicalRaw = localStorage.getItem(key);
  } catch {
    return "failed";
  }
  // SH.2.4 — this key's local-edit-fact keyspace, snapshotted (keys AND
  // their raw content) BEFORE any of this call's own writes. This is both
  // the noop check's own input (via resolveEffectiveDurableRaw(), unchanged
  // from before this round) and the frontier planOrdinaryEditFactCommit()
  // below is allowed to retire from — see this function's own doc above.
  const baselineFacts: LocalEditFactRecord[] = [];
  for (const factKey of snapshotKeysWithPrefix(localEditFactPrefix(key))) {
    let raw: string | null;
    try {
      raw = localStorage.getItem(factKey);
    } catch {
      continue;
    }
    if (raw !== null) baselineFacts.push({ key: factKey, raw });
  }
  // SH.2.1 P1 fix (Codex finding #2, this round) — the noop check below
  // compares against the EFFECTIVE DURABLE value (canonical + any still-
  // unresolved edit fact), never canonical bytes alone. See this
  // function's own doc above for the full rationale. This is a force-
  // commit policy — the durable value read here also stands in as its own
  // "expected previous" baseline — so decideLocalDomainCommit() can still
  // only return "write" or "noop", never "superseded": an ordinary edit is
  // always the user's freshest intent and is never rejected.
  const durableRaw = resolveEffectiveDurableRaw(
    canonicalRaw,
    baselineFacts.map((fact) => fact.raw)
  );
  const decision = decideLocalDomainCommit(durableRaw, durableRaw, nextRaw);
  if (decision === "noop") {
    // SH.2.5.2 (Codex review, "effective-value local-write noops" finding)
    // — `decision === "noop"` only proves the EFFECTIVE durable value
    // (canonical, or a surviving fact outranking a stale canonical — see
    // resolveEffectiveDurableRaw()) already equals `nextRaw`. It does NOT
    // prove canonical storage itself holds those bytes: when a surviving
    // fact is the one supplying `durableRaw`, canonical can still be
    // stale. Treating this as a true no-op and returning immediately would
    // leave canonical stale indefinitely, relying on the protecting fact
    // never being retired by anything else in the meantime — exactly the
    // gap that let a later reconciliation/retirement elsewhere expose
    // stale canonical bytes once the fact was gone (see
    // reconcilePendingOperations()'s own "materialize before retire" doc
    // below for the accepted-operation half of this same root cause).
    //
    // The fix: a noop still reports "noop" (nothing NEW was durably
    // recorded — this is not a fresh edit, and no new fact is published,
    // exactly as before), but first REPAIRS canonical storage with a
    // plain, unconditional overwrite whenever it does not already hold
    // `nextRaw`'s bytes — a best-effort materialization of authority that
    // already exists, never a new decision. This is safe unconditionally:
    // `nextRaw` is already durable authority by construction (that is what
    // "noop" means here), so writing it to canonical can never regress
    // anything, only bring canonical in line with what is already true.
    // Consistent with this function's own established synchronous,
    // lock-free write policy (16th round, above) — no new locking is
    // introduced, and a failed repair attempt is not a durability loss:
    // the surviving fact(s) already keep `nextRaw` durably recoverable via
    // readLatestDurableValue(), so this call simply leaves the repair for
    // a later noop/edit/reconciliation to retry. The protecting fact(s)
    // are left completely untouched either way — retirement is reserved
    // for the paths that already own it (an ordinary edit's own
    // planOrdinaryEditFactCommit() retirement, or accepted-operation
    // reconciliation's materialize-then-retire — never duplicated here).
    if (canonicalRaw !== nextRaw) {
      try {
        localStorage.setItem(key, nextRaw);
      } catch {}
    }
    return "noop";
  }
  const plan = planOrdinaryEditFactCommit(baselineFacts, nextRaw, localEditFactKey(key, generateOpId()));
  // SH.2.4 Codex P1 follow-up — attempt BOTH the new fact and the canonical
  // overwrite unconditionally; neither leg's failure is allowed to skip the
  // other (see this function's own doc above for why a new-key allocation
  // can fail near quota even when the canonical overwrite would still
  // succeed). `factPublished` is already true when no new fact was even
  // needed (a baseline fact already matched `nextRaw` — see
  // planOrdinaryEditFactCommit's own dedup doc): that existing fact already
  // durably represents this intent, nothing further to attempt for it.
  let factPublished = !plan.writeNew;
  if (plan.writeNew) {
    try {
      localStorage.setItem(plan.ownFactKey, nextRaw);
      factPublished = true;
    } catch {}
  }
  let canonicalWritten = false;
  try {
    localStorage.setItem(key, nextRaw);
    canonicalWritten = true;
  } catch {}
  const outcome = decideOrdinaryEditPersistOutcome(factPublished, canonicalWritten);
  if (outcome === "failed") {
    // Fail safely: neither leg landed, so nothing durable changed — the
    // baseline facts this decision observed are left completely untouched,
    // exactly as they were before this call.
    return "failed";
  }
  // At least one of {fact, canonical} now durably holds `nextRaw` — every
  // baseline fact this decision observed is proven stale relative to it
  // regardless of WHICH leg landed (see planOrdinaryEditFactCommit's own
  // doc: `keysToRetire` never names a key outside this decision's own
  // baseline, so retiring it here is exactly as safe as the fully-
  // successful path already was).
  for (const staleKey of plan.keysToRetire) {
    try {
      localStorage.removeItem(staleKey);
    } catch {}
  }
  return outcome;
}

/**
 * The single "may gates advance" predicate every caller uses after a
 * commit: true for "committed" (a real write just landed) or "noop" (the
 * durable value already was the intended one) — both mean the intended
 * value is CONFIRMED durable right now. False for "superseded" (a newer
 * local write won the race), "authority-superseded" (SH.2.2's Codex P1
 * follow-up round — confirmed authority advanced past this pull's own
 * cloud revision while this commit waited for the lock), "aborted" (the
 * caller's own context went stale before the write), "unavailable" (no
 * safe serialization primitive exists in this environment), or "failed" (a
 * real localStorage exception) — all five mean the intended value is NOT
 * confirmed durable, so ownership/syncReady/confirmed-baseline advancement
 * must not proceed as if it were. Also accepts LocalDomainSyncCommitStatus,
 * so callers of either primitive can share this one check — explicitly
 * unioned in the parameter type below rather than relying on one being a
 * structural subset of the other, since LocalDomainSyncCommitStatus's
 * "committed-unprotected" (see next paragraph) has no counterpart in
 * LocalDomainCommitStatus: commitLocalDomainRaw() (the CAS/hydration path)
 * never produces it — only commitLocalDomainRawSync() can — so it must not
 * pollute LocalDomainCommitStatus itself (callers like
 * DomainHydrationCommitStatus narrow from that exact type and must never
 * have to account for an outcome commitLocalDomainRaw() cannot return).
 *
 * "committed-unprotected" (SH.2.4 Codex P1 follow-up round;
 * decideOrdinaryEditPersistOutcome() in syncPayload.ts) is ALSO true here:
 * the requested value is durably preserved on disk — via the surviving new
 * fact, or via canonical directly — even though only one of the two legs
 * commitLocalDomainRawSync() attempts actually landed. The overriding LOCAL-
 * FIRST DURABILITY CONTRACT is "never lose the user's edit to React state
 * alone", which this outcome satisfies exactly as fully as "committed"
 * does; it is reported under a distinct name only so it is never confused
 * with the fully fact-protected case, never so gates treat it as failure.
 */
export function isLocalDomainCommitSuccess(status: LocalDomainCommitStatus | LocalDomainSyncCommitStatus): boolean {
  return status === "committed" || status === "committed-unprotected" || status === "noop";
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

/**
 * SH.2.1 P1 fix (this round, Codex finding #1) — I/O wrapper profileStorage.
 * ts's deleteProfile() calls, IN ADDITION to its own removal of the
 * profile's plain `dwp:{profileId}:{baseKey}` canonical keys, to purge
 * every OTHER key shape this module's sync layer owns for that profile:
 * local-edit facts, the local-content-owner marker, confirmed facts, and
 * pending pushes (+ their rotation cursor). See isProfileOwnedSyncKey()'s
 * own doc in syncPayload.ts for the full root-cause rationale (durable
 * edit facts left behind can resurrect deleted planner state the moment a
 * profile with the same normalized id is recreated) and the exact key
 * shapes this covers.
 *
 * A single full-localStorage scan (snapshotKeysWithPrefix("") — every key
 * startsWith the empty string) filtered through the one shared PURE
 * predicate, rather than a bespoke prefix per key family: this is a rare,
 * user-initiated, one-shot cleanup (not a hot path), so the O(n) scan cost
 * is irrelevant next to the correctness benefit of one shared rule instead
 * of several hand-maintained prefixes drifting apart over time.
 */
export function purgeProfileSyncState(profileId: string): void {
  for (const key of snapshotKeysWithPrefix("")) {
    if (!isProfileOwnedSyncKey(key, profileId)) continue;
    try {
      localStorage.removeItem(key);
    } catch {}
  }
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

// ── Observed server revision (SH.2.5.1 Codex P1 follow-up) ─────────────────
// See syncPayload.ts's own "Observed server revision" section doc for the
// full root-cause and architecture. This is a SECOND, deliberately separate
// physically-immutable-fact store from confirmedFact* above: facts here
// carry no domain and no value, only `{ revision }`, so there is no
// canonical-value conflict to ever detect — recording is always simply
// true, and reducing to "the max ever observed" is safe under any
// interleaving of concurrent readers/writers without a lock.
function observedRevisionFactPrefix(userId: string, profileId: string): string {
  return `dwp:sync:${userId}:${profileId}:observedRevision:`;
}

function observedRevisionFactKey(userId: string, profileId: string, revision: number, instanceId: string): string {
  return `${observedRevisionFactPrefix(userId, profileId)}${revision}:${instanceId}`;
}

function scanObservedRevisionFacts(
  userId: string,
  profileId: string
): Array<{ key: string; fact: ObservedRevisionFact }> {
  const entries: Array<{ key: string; fact: ObservedRevisionFact }> = [];
  for (const key of snapshotKeysWithPrefix(observedRevisionFactPrefix(userId, profileId))) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      const fact = parseObservedRevisionFact(JSON.parse(raw));
      if (fact) entries.push({ key, fact });
    } catch {
      // Corrupted entry — simply excluded from the max reduction below.
    }
  }
  return entries;
}

/**
 * Read this device's best current knowledge of the highest server revision
 * ever observed for this (userId, profileId) pair — from ANY usable pull
 * response, independent of whether any domain's value was ever recorded as
 * server-confirmed. 0 ("nothing observed yet") when nothing has been
 * recorded. See getKnownBaseRevision() below for how this is combined with
 * knownBaseRevisionFromConfirmedState() to produce the `baseRevision` a
 * tagged operation actually sends.
 */
export function getObservedServerRevision(userId: string, profileId: string): number {
  if (typeof window === "undefined") return 0;
  return resolveObservedServerRevision(scanObservedRevisionFacts(userId, profileId).map((e) => e.fact));
}

/**
 * Records that a usable pull observed `revision` as this (userId,
 * profileId) row's server revision — called for EVERY pull response that
 * carries a definite numeric revision, whether or not any domain hydrated
 * from it (see each page's pull effect). MONOTONIC by construction:
 * resolveObservedServerRevisionAdvance() (syncPayload.ts) skips the write
 * entirely when `revision` would not exceed what is already durably
 * recorded, so a stale/delayed pull response landing after a newer one was
 * already processed can never regress this device's knowledge, regardless
 * of arrival order. When it IS a genuine advance, the new fact is written
 * FIRST (a fresh, permanently-unique key — never a read-modify-write of an
 * existing one), and only then are the now-superseded lower facts pruned —
 * this ordering guarantees a concurrent reader's own scan-max is always
 * monotonically non-decreasing, even mid-prune: it can only ever see the
 * new higher fact ADDED before older ones are removed, never a transient
 * gap where nothing is recorded at all.
 */
export function recordObservedServerRevision(userId: string, profileId: string, revision: number): void {
  if (typeof window === "undefined") return;
  const existing = scanObservedRevisionFacts(userId, profileId);
  const currentMax = resolveObservedServerRevision(existing.map((e) => e.fact));
  if (!resolveObservedServerRevisionAdvance(revision, currentMax)) return;
  const key = observedRevisionFactKey(userId, profileId, revision, generateOpId());
  try {
    localStorage.setItem(key, JSON.stringify({ revision }));
  } catch {
    return; // write failed — nothing durable changed, nothing to prune
  }
  // Opportunistic prune — pure optimization, never a correctness dependency
  // (a stray lower fact left behind changes nothing about the max this or
  // any other reader computes). Only removes keys THIS call itself observed
  // in its own pre-write scan, never a key some OTHER concurrent writer may
  // have added since — mirroring selectConfirmedFactPruneKeys' own
  // never-delete-what-you-didn't-verify discipline above.
  for (const { key: staleKey } of existing) {
    try {
      localStorage.removeItem(staleKey);
    } catch {}
  }
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
 *
 * SH.2.2 (Codex P1 "make confirmed-authority scans atomic" round) — the
 * write itself remains unconditionally safe without a lock (a permanently-
 * unique key can never race), but this call's own INTERNAL unambiguity
 * scan (scanConfirmedFactEntries, right below) is exactly the same kind of
 * `.length`-bounded enumeration getConfirmedStateAtomic() exists to
 * protect — so its body now runs inside confirmedAuthorityLockName()'s lock
 * (when available), serializing it against every OTHER concurrent
 * recordConfirmedFact() call AND every getConfirmedStateAtomic() read for
 * the SAME identity. Never fails closed when Web Locks are unavailable —
 * see that lock helper's own doc above for why the write side doesn't need
 * to (a permanently-unique-key write needs no serialization to be safe on
 * its own terms; only the STRONGER cross-call atomic-observability
 * guarantee requires one).
 */
/**
 * The lock-free CORE of recordConfirmedFact() — a single unconditional
 * `setItem` to a permanently-unique key, plus the unambiguity scan/prune and
 * cross-store hydration-provenance prune. Extracted (SH.2.2 "consolidated
 * hydration commit boundary" round) so commitDomainHydration() below can
 * invoke it directly while ALREADY holding confirmedAuthorityLockName()'s
 * lock for the surrounding commit — calling recordConfirmedFact() itself
 * there would re-request the SAME lock name from inside its own held
 * callback, which the Locks API does not grant reentrantly (a genuine
 * deadlock, not merely a wasted wait). recordConfirmedFact() (below) is the
 * ONLY other caller and remains the right entry point for any caller NOT
 * already inside that lock.
 */
function recordConfirmedFactBody(
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
    // to a failure, and never blocks pruning from being retried on a
    // later call.
  }
  // SH.2.2 (Codex P1 "prune superseded hydration provenance" round),
  // corrected by SH.2.3 (Codex P1 "preserve hydration provenance that
  // still describes canonical local storage" round) — CROSS-STORE prune:
  // recording a confirmed fact for THIS domain at THIS revision is NOT, by
  // itself, proof that every hydration-provenance record at or below that
  // revision is obsolete. That was only ever true for the caller where a
  // CAS-protected canonical WRITE to this SAME key just happened in this
  // SAME held lock (commitDomainHydration()'s pure-cloud-value branch,
  // immediately before it calls this function) — commitConfirmedBaseline()
  // (doPush()'s synchronous confirmation, and reconcilePendingOperations()'s
  // accepted-operation reconciliation, both calling THIS SAME shared body)
  // never writes canonical storage at all: it records whatever a domain's
  // canonical value already was at an earlier moment, and — because the
  // combined payload always includes plans+lightning together — routinely
  // confirms a domain the current write never touched. If a PRIOR pull had
  // persisted a non-pure reconciled value for that untouched domain
  // (recorded only as hydration provenance — see isExactCloudValue()'s own
  // doc for why a reconciled value is never eligible for confirmed
  // authority), that value is STILL sitting on canonical storage right now,
  // completely unrelated to whatever THIS confirm's own value says — and a
  // blind `<= revision` sweep would delete the ONLY record that explains it,
  // leaving it to be misread as a fresh local edit and pushed back over
  // newer cloud data by whichever pull looks next.
  //
  // The fix: read this domain's CURRENT canonical/durable value fresh,
  // right now, and prune a hydration-provenance record only when
  // isHydrationProvenanceFactObsoleteAfterConfirm() (syncPayload.ts) proves
  // it no longer matches — i.e. canonical storage has actually moved past
  // it — never merely because a confirm happened. When the original
  // assumption DOES hold (the hydration-commit caller), current canonical
  // content trivially equals the newly-confirmed value, so every genuinely
  // superseded older record is still pruned exactly as before — this is a
  // strict correction, not a behavior change, for that path. Runs
  // regardless of this call's own `success` flag, same as before: a
  // confirmed-fact AMBIGUITY is a separate question from whether any
  // INDIVIDUAL hydration-provenance record still explains current disk
  // content, which this check answers directly rather than assuming.
  //
  // If the current canonical value itself cannot be reliably read (a
  // genuine parse failure — see parseLocalDatasetEntry's own doc; a merely
  // MISSING key is a legitimate empty value, not a failure), this call has
  // no safe basis to judge ANY record obsolete — per the invariant
  // ("removed only when proven no longer necessary"), it skips this
  // domain's cross-store prune entirely rather than guess. Nothing is lost
  // by skipping: hydration provenance's own self-pruning
  // (planHydrationProvenanceDedup(), recordHydrationProvenance() below)
  // independently bounds this store's growth on every future write
  // regardless of whether this cross-store pass ever fires for it.
  try {
    const domainKey = domainCanonicalKey(profileId, domain);
    let currentCanonicalValue: unknown = null;
    try {
      const currentRaw = readLatestDurableValue(domainKey);
      if (domain === "days") {
        const parsedDays: unknown = currentRaw !== null ? JSON.parse(currentRaw) : null;
        currentCanonicalValue = Array.isArray(parsedDays) ? parsedDays : null;
      } else {
        currentCanonicalValue = parseLocalDatasetEntry(currentRaw);
      }
    } catch {
      currentCanonicalValue = null;
    }
    if (currentCanonicalValue !== null) {
      pruneHydrationProvenanceFacts(userId, profileId, domain, (factRevision, factValue) =>
        isHydrationProvenanceFactObsoleteAfterConfirm(factRevision, factValue, revision, currentCanonicalValue)
      );
    }
  } catch {}
  return success;
}

async function recordConfirmedFact(
  userId: string,
  profileId: string,
  domain: ConfirmedDomainName,
  revision: number,
  value: unknown
): Promise<boolean> {
  if (hasLocalDomainSerialization()) {
    return navigator.locks.request(confirmedAuthorityLockName(userId, profileId), () =>
      recordConfirmedFactBody(userId, profileId, domain, revision, value)
    );
  }
  return recordConfirmedFactBody(userId, profileId, domain, revision, value);
}

/**
 * ATOMIC commit-time confirmed-state read — see confirmedAuthorityLockName's
 * own doc above for the full root-cause and mechanism. Runs
 * getConfirmedState()'s existing, UNCHANGED scan logic inside the SAME lock
 * recordConfirmedFact() writes hold, so the returned state can never be a
 * torn read against a concurrently-publishing fact for this (userId,
 * profileId). Returns `null` — FAIL CLOSED — when Web Locks are
 * unavailable, rather than silently falling back to the non-atomic scan;
 * every caller is a commit-time gate (see each page's `checkAuthorityStillValid`/
 * `revalidateAuthorityBeforeCommit`) that already treats a `null` result as
 * "authority could not be safely established" and defers the whole pull,
 * exactly like a genuine authority change. Use getConfirmedState() directly
 * (unchanged) for any ORDINARY, non-commit-time read — this function exists
 * ONLY for the stronger guarantee a commit boundary needs.
 */
export function getConfirmedStateAtomic(userId: string, profileId: string): Promise<ConfirmedPlannerState | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (!hasLocalDomainSerialization()) return Promise.resolve(null);
  return navigator.locks.request(confirmedAuthorityLockName(userId, profileId), () =>
    getConfirmedState(userId, profileId)
  );
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
    allOk = (await recordConfirmedFact(userId, profileId, "plans", revision, accepted.plans)) && allOk;
  }
  if (accepted.lightning !== undefined) {
    allOk = (await recordConfirmedFact(userId, profileId, "lightning", revision, accepted.lightning)) && allOk;
  }
  if (accepted.days !== undefined) {
    allOk = (await recordConfirmedFact(userId, profileId, "days", revision, accepted.days)) && allOk;
  }
  return allOk;
}

// ── Hydration provenance (SH.2.2, Codex P1 "authority vs. hydration-
// provenance" round) — a SECOND, DELIBERATELY NON-AUTHORITATIVE fact store,
// separate from confirmed facts above ────────────────────────────────────
//
// Root cause — see isExactCloudValue()'s own doc in syncPayload.ts for the
// full example: a domain being "cloud-won" at the DOMAIN level says nothing
// about whether the WINNING VALUE a pull actually persists is byte-for-byte
// the server's own value for that domain. Cross-domain reconciliation
// (reconcilePlannerSnapshot in crossDayChecks.ts) can filter or extend a
// cloud-won domain's winning value based on THIS DEVICE'S OWN local state in
// ANOTHER domain (Days removing a day locally filters a sibling's items
// referencing it; a newly cloud-won item can extend days[] with a day cloud
// itself never listed). Recording that ALTERED value as a "confirmed fact"
// under the server's own revision would assert something the server never
// said — and, critically, is not even well-defined ACROSS TABS: two tabs
// with DIFFERENT local state in the OTHER domain, reconciling the SAME GET
// response, legitimately derive DIFFERENT winning values for THIS domain —
// recording either as "the" confirmed value for that domain+revision would
// manufacture a conflict the server itself has no ambiguity about at all.
//
// Confirmed facts (above) therefore now record ONLY a PURE cloud winner — a
// winning value that canonically equals the literal cloud value this pull
// fetched (see isExactCloudValue(), syncPayload.ts) — never a reconciliation
// that altered it. But SH.2.2's original partial-apply-provenance guarantee
// ("an already-applied domain from an aborted pull must remain identifiable
// as hydration, not become pushable local intent") still has to hold for
// the ALTERED case too — a reconciled-but-not-pure-cloud winner is JUST AS
// much a hydration result as a pure one, and a REPLACEMENT pull must still
// be able to recognize it as such rather than misreading disk content that
// diverges from an (unratcheted) confirmed baseline as a genuine user edit.
//
// Hydration-provenance facts close that gap WITHOUT polluting confirmed
// server authority: stored under their OWN prefix
// (`dwp:sync:{userId}:{profileId}:hydrationFact:{domain}:{revision}:{instanceId}`
// — deliberately the SAME physical shape as a confirmed fact, `{revision,
// value}`, reusing the SAME parseConfirmedFactForDomain() parser — but under
// a domain-parallel keyspace resolveConfirmedDomainState()/getConfirmedState()
// NEVER scan, so they can never feed cross-tab "confirmed authority"
// comparisons, never trigger "authority-changed"/conflict detection, and —
// unlike confirmed facts — MULTIPLE hydration-provenance facts recorded for
// the exact same domain+revision, even with DIFFERING values, are NOT an
// error: each is independently a legitimate hydration result some tab
// derived from its OWN local state at that moment; there is no single
// "true" value to reconcile them down to, so no ambiguity/conflict
// resolution logic exists for this store at all (a deliberate, structural
// difference from confirmedFact's own read-time reduction) — hasHydrationProvenanceMatch()
// below only ever asks "does ANY recorded fact for this domain match this
// SPECIFIC candidate value", never "what is THE value for this revision".
//
// Consumed by each page's pull effect at the SAME point the existing
// `contentOwnershipMismatch` substitution already runs (see
// buildPreFetchPullBaseline's/buildPostFetchPullBaseline's own callers):
// before computing `changedLocally` for a domain, if the fresh disk read
// differs from this pull's own baseline, but a hydration-provenance fact at
// a revision no newer than this pull's own cloudRevision records the EXACT
// same value, the disk content is recognized as an earlier pull's own
// hydration output rather than an unsynced edit — the SAME substitution
// mechanism `contentOwnershipMismatch` already uses (never a NEW page-level
// boolean/ref: one shared, testable predicate, symmetric across both
// pages). A genuine local edit is unaffected: commitLocalDomainRawSync()
// always publishes a local-edit fact, and loadEffectiveDurable*()/
// readLatestDurableValue() already prefer a surviving edit fact over the
// canonical key BEFORE this substitution is even consulted — hydration
// provenance is only ever checked against the CANONICAL-key-derived
// "current" value, so it can never override a genuine, still-unresolved
// edit.
//
// No Web Lock is used for either the write or the read here (unlike
// confirmed facts' getConfirmedStateAtomic()/recordConfirmedFact() pairing
// — see confirmedAuthorityLockName's own doc above): there is no
// authoritative "current true value" this store must ever agree on
// atomically across tabs — each fact is independently valid on its own
// terms, and a torn read here can, AT WORST, miss a legitimate match this
// one time (the SAME cheap, permanently-unique-key write recordConfirmedFact()
// itself used before the atomicity round — correct, just not linearizable),
// falling through to the SAME existing local-edit/CAS protections that
// already make an unnecessary "changedLocally" classification merely
// wasteful (a fresh reconciliation redoes the exact same work), never
// unsafe.
function hydrationProvenancePrefix(userId: string, profileId: string, domain: ConfirmedDomainName): string {
  return `dwp:sync:${userId}:${profileId}:hydrationFact:${domain}:`;
}

function hydrationProvenanceKey(
  userId: string,
  profileId: string,
  domain: ConfirmedDomainName,
  revision: number,
  instanceId: string
): string {
  return `${hydrationProvenancePrefix(userId, profileId, domain)}${revision}:${instanceId}`;
}

/**
 * Durably records that a LOCALLY-RECONCILED hydration result (one this
 * pull's own reconciliation produced, which is NOT byte-for-byte the
 * server's own cloud value — see this section's own doc above) was written
 * to `domain`'s local storage, tagged with the server revision it was
 * reconciled against. A plain, unconditional `setItem` to a permanently-
 * unique key — like recordConfirmedFact() before the atomicity round, this
 * can never race with anything, from any tab, since no two calls ever
 * target the same key. Returns `false` only on a genuine write exception
 * (storage quota, disabled storage) — callers must treat that exactly like
 * any other "required provenance could not be durably recorded" failure:
 * fail the whole pull closed (new `"provenance-write-failed"` reason,
 * syncPayload.ts) BEFORE any authority ratchet, ownership transfer,
 * syncReady, or push — per this round's explicit requirement.
 */
/**
 * SH.2.2 (Codex P1 "prune superseded hydration provenance" round) — deletes
 * every hydration-provenance fact for (userId, profileId, domain) that
 * `isPrunable(factRevision)` accepts. Used by recordConfirmedFact() (above —
 * cross-store-prunes records `r <= revision` once genuine CONFIRMED
 * authority is established AT OR BELOW that revision, a strictly stronger
 * signal that supersedes any hydration record at or below it, from any
 * writer — `<=`, not `<`, since confirmed authority is a single-truth
 * signal that even same-revision hydration siblings cannot survive).
 *
 * SH.2.3 (Codex P1 "deduplicate same-revision hydration provenance facts"
 * round) — recordHydrationProvenance()'s OWN self-pruning below no longer
 * goes through this generic `isPrunable` sweep: strictly-older pruning AND
 * same-revision DEDUPLICATION (collapsing canonically-identical same-
 * revision duplicates to one survivor, while still preserving genuinely
 * different same-revision siblings — this function's simple boolean
 * predicate has no way to express "delete all but one of a group of
 * matching entries") are now decided together by planHydrationProvenanceDedup()
 * (syncPayload.ts) against the full parsed fact set, and applied directly
 * by recordHydrationProvenance() itself. This function is kept for the
 * recordConfirmedFact() cross-store call site above, whose `<=` sweep never
 * needed to distinguish same-revision siblings from duplicates in the first
 * place (every fact at or below the confirmed revision is superseded
 * regardless of its own value).
 *
 * Why pruning strictly-older records is safe at all: a hydration-provenance
 * record can only ever "explain" CURRENT disk content — see
 * hasHydrationProvenanceMatch's own doc. commitLocalDomainRaw()'s CAS
 * guarantees at most one writer's value can ever land on a given canonical
 * key at a time; the moment ANY later write (hydration OR confirmed, this
 * tab or another) succeeds for that key, it PROVES the canonical key has
 * moved on — every OLDER record, from any writer, can never again match
 * current disk, so deleting it loses nothing a live pull could still need.
 * This is the exact mechanism that keeps this store BOUNDED (never
 * accumulating full historical planner snapshots): the keyspace for one
 * domain only ever holds however many DISTINCT values genuinely concurrent
 * writers produced at the CURRENT frontier revision — typically zero or
 * one, occasionally a few during a real race, never growing across
 * repeated ordinary reconciliations.
 */
/**
 * SH.2.3 (Codex P1 "preserve hydration provenance that still describes
 * canonical local storage" round) — `isPrunable` now receives the fact's OWN
 * value alongside its revision, not merely its revision: the sole remaining
 * caller (recordConfirmedFactBody's cross-store prune, below) needs it to
 * decide obsolescence via isHydrationProvenanceFactObsoleteAfterConfirm()
 * (syncPayload.ts) rather than a revision-only bound. See that function's
 * own doc for why a revision-only predicate is no longer sufficient.
 */
function pruneHydrationProvenanceFacts(
  userId: string,
  profileId: string,
  domain: ConfirmedDomainName,
  isPrunable: (factRevision: number, factValue: unknown) => boolean
): void {
  for (const key of snapshotKeysWithPrefix(hydrationProvenancePrefix(userId, profileId, domain))) {
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      continue;
    }
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const fact = parseConfirmedFactForDomain(domain, parsed);
    if (fact === null) continue;
    if (isPrunable(fact.revision, fact.value)) {
      try {
        localStorage.removeItem(key);
      } catch {}
    }
  }
}

/**
 * SH.2.3 (Codex P1 "deduplicate same-revision hydration provenance facts"
 * round) — reads the full CURRENT set of recorded facts for this
 * (userId, profileId, domain), hands it to the pure planHydrationProvenanceDedup()
 * (syncPayload.ts) alongside the `{revision, value}` about to be recorded,
 * and only writes a NEW physically-unique key when the plan says one is
 * actually needed (`writeNew`) — never unconditionally, as the previous
 * "always write, prune only strictly-older" version did. See that
 * function's own doc for the full dedup/pruning rule this replaces. Both
 * ordinary hydration commits (commitDomainHydration below) and SH.2.3's
 * accepted-operation reconciliation (reconcilePendingOperations below) call
 * THIS SAME function, so both get the bounded behavior automatically — no
 * separate pruning path to keep in sync.
 *
 * Returns `false` only on a genuine write exception when a new key actually
 * needed to be written (storage quota, disabled storage) — a call that
 * determines no write is needed at all (`writeNew: false`) cannot fail this
 * way, and still reports `true`: the durable invariant this function exists
 * to establish ("this value at this revision is recorded") already held
 * before this call, so there is nothing this call could fail to durably
 * record. Pruning (`keysToDelete`) remains best-effort exactly as before —
 * a pruning failure never flips an already-satisfied invariant to a
 * failure.
 */
export async function recordHydrationProvenance(
  userId: string,
  profileId: string,
  domain: ConfirmedDomainName,
  revision: number,
  value: unknown
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const existing: HydrationProvenanceFactRecord[] = [];
  for (const factKey of snapshotKeysWithPrefix(hydrationProvenancePrefix(userId, profileId, domain))) {
    let raw: string | null;
    try {
      raw = localStorage.getItem(factKey);
    } catch {
      continue;
    }
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const fact = parseConfirmedFactForDomain(domain, parsed);
    if (fact === null) continue;
    existing.push({ key: factKey, revision: fact.revision, value: fact.value });
  }
  const plan = planHydrationProvenanceDedup(existing, revision, value);
  if (plan.writeNew) {
    const key = hydrationProvenanceKey(userId, profileId, domain, revision, generateOpId());
    try {
      localStorage.setItem(key, JSON.stringify({ revision, value }));
    } catch {
      return false;
    }
  }
  try {
    for (const staleKey of plan.keysToDelete) {
      localStorage.removeItem(staleKey);
    }
  } catch {
    // Best-effort pruning failure never flips an already-durable write to a
    // failure — mirrors recordConfirmedFact's own established convention.
  }
  return true;
}

/**
 * Does ANY recorded hydration-provenance fact for (userId, profileId,
 * domain), at a revision no newer than `maxRevision`, canonically equal
 * `value`? See this section's own doc above for why this is an EXISTENCE
 * check over independently-valid facts, never a single-value reduction like
 * resolveConfirmedDomainState(). `maxRevision` bounds the search to facts
 * this pull's OWN view of cloud could plausibly have produced or seen
 * produced (never a revision NEWER than this pull's own cloudRevision,
 * which this pull has no basis to trust yet) — pass `Number.POSITIVE_INFINITY`
 * when this pull's own cloudRevision is unknown (a 204/unparseable
 * response establishes no bound to check against either way, mirroring
 * resolvePostFetchDomainBaseline's own null-cloudRevision handling).
 */
export function hasHydrationProvenanceMatch(
  userId: string,
  profileId: string,
  domain: ConfirmedDomainName,
  maxRevision: number,
  value: unknown
): boolean {
  if (typeof window === "undefined") return false;
  const targetCanonical = canonicalizeJSON(value);
  for (const key of snapshotKeysWithPrefix(hydrationProvenancePrefix(userId, profileId, domain))) {
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      continue;
    }
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const fact = parseConfirmedFactForDomain(domain, parsed);
    if (fact === null) continue;
    if (fact.revision > maxRevision) continue;
    if (canonicalizeJSON(fact.value) === targetCanonical) return true;
  }
  return false;
}

// ── Consolidated hydration commit boundary (SH.2.2, "stop adding isolated
// authority checks" round) ──────────────────────────────────────────────
//
// ROOT ISSUE this closes: the pull effects (plans/page.tsx,
// lightning/page.tsx) used to serialize ONE logical per-domain commit
// across independently-acquired-and-released stages — a pre-commit
// atomic authority read (its own lock cycle), commitLocalDomainRaw()'s
// in-lock re-check via an `isAuthorityStillValid` callback (a SECOND,
// separate lock cycle, nested inside the per-key lock), and, after the
// per-key lock had already been released, a provenance/confirmed-fact
// write followed by a reread-and-ratchet of "whatever confirmed authority
// is current now" (a THIRD, independently-timed lock cycle). Between any
// two of those cycles, another writer for the SAME identity could publish
// a confirmed fact, and the final ratchet had no way to tell its OWN
// self-caused advancement apart from a genuinely external one — ratcheting
// to "whatever is current" either way.
//
// commitDomainHydration() replaces all three with ONE
// confirmedAuthorityLockName() acquisition, held for the entire critical
// section: fresh authority validation, the nested per-key CAS commit, and
// (when eligible) the provenance/confirmed-fact write — returning the
// EXACT authority state this call itself established, read back while
// STILL holding the same lock, never a later independently-timed reread.
// No other writer for this (userId, profileId) can ever run concurrently
// with any part of it, since every writer for this identity — this
// function, recordConfirmedFact(), getConfirmedStateAtomic() — contends
// for the identical lock name (see confirmedAuthorityLockName's own doc
// above). A change to confirmed authority detected at the START of this
// call (before the per-key lock is even requested) is reported as
// "authority-changed" and nothing is written; commitLocalDomainRaw()'s own
// `isAuthorityStillValid` re-check is therefore passed as its default
// (always-valid) — the race that parameter existed to catch cannot occur
// while this lock is held, not merely re-checked-and-still-possible.
//
// `provenance`, when non-null, is recorded ONLY once the CAS commit itself
// reports "committed" or "noop" (isLocalDomainCommitSuccess's own
// equivalence, preserved) — never speculatively ahead of durable proof,
// exactly like the previous separate recordDomainProvenance() step. Pass
// `null` when the caller's own domain-specific eligibility gate (e.g.
// "did local win this domain locally" — a decision made from information
// already known BEFORE this call, never from this call's own not-yet-known
// outcome) says this attempt should not be recorded either way.
//
// See resolveHydrationApplyIntentDisposition()'s own doc (syncPayload.ts)
// for the CRASH/RELOAD SAFETY half of this: a durable intent marker is
// written immediately before the CAS commit is attempted and cleared once
// the provenance write (or the decision not to attempt one) is known,
// still inside this SAME held lock — narrowing the crash window down to
// two back-to-back synchronous statements with no further `await` between
// them, and giving a future reload durable evidence to reconcile even a
// genuine interruption in that narrow window.
//
// REQUIRED PRECONDITION (SH.2.2, Codex P1 "require the hydration intent
// before mutating" round) — when `provenance` is non-null (this commit, if
// it succeeds, WILL attempt a follow-up confirmed/hydration-provenance
// write, opening the exact gap the intent marker exists to cover), durably
// storing that marker is no longer best-effort: a `localStorage.setItem`
// failure here now reports "provenance-write-failed" and returns
// IMMEDIATELY, BEFORE commitLocalDomainRaw() is ever called — canonical
// storage is never touched. Root cause this closes: the marker used to be
// written inside a swallowing try/catch and this function proceeded
// regardless of whether it landed. If that write failed (e.g. a transient
// quota error affecting only THIS new key) but the canonical mutation
// itself then succeeded, AND the follow-up provenance write also failed
// (a correlated quota exhaustion is the realistic case — overwriting an
// EXISTING canonical key needs no new space, but two NEW small keys next
// to it can each independently fail), a reload would find durably-mutated
// canonical bytes with NO marker at all to explain them — silently
// defeating the very crash/reload-safety mechanism this round's own prior
// pass built. Requiring the marker as a precondition means: whenever this
// function's canonical write can actually happen, the durable evidence
// needed to recover from a worse failure later in the SAME call already
// exists on disk first. `provenance === null` commits are unaffected —
// they never attempt a follow-up provenance write, so there is no gap for
// a marker to cover, and none is written (unchanged from before this
// round).
export type DomainHydrationCommitStatus =
  | "committed"
  | "noop"
  | "superseded"
  | "aborted"
  | "authority-changed"
  | "provenance-write-failed"
  | "unavailable"
  | "failed";

export interface DomainHydrationCommitResult {
  status: DomainHydrationCommitStatus;
  /**
   * SH.2.4.1 (Codex P1 "provenance failure must not mask primary hydration
   * success" round) — the canonical commit's OWN outcome, captured
   * INDEPENDENTLY of whether a subsequent provenance/confirmed-fact write
   * later downgrades the outward-facing `status` to
   * "provenance-write-failed". `"committed"`/`"noop"` here means the
   * winning value is DURABLY on disk right now, full stop — regardless of
   * what `status` says.
   *
   * ROOT CAUSE this closes: `status` is a single field forced to carry two
   * logically separate outcomes — "did the canonical write land" and "did
   * the follow-up provenance/confirmed-fact write also land" — and the
   * second could silently overwrite the first. Every existing caller
   * (plans/page.tsx, lightning/page.tsx) derived its
   * `primaryPersistSucceeded`/`hydrationSucceeded`/`daysWriteFailed` gates
   * by comparing `status` directly against `"committed"`/`"noop"`, so a
   * provenance failure AFTER a genuinely successful canonical write made
   * those gates read as "primary persistence failed" — skipping the
   * `setItems`/`setDays`/`setLightningVersion` React-state reconciliation
   * that should have run unconditionally once disk already held the
   * winner. A subsequent local edit could then persist THAT stale React
   * state back over the already-durable canonical value, silently
   * reverting it.
   *
   * `null` whenever the canonical commit itself did not reach
   * "committed"/"noop" — including a `provenance-write-failed` result from
   * the INTENT marker write failing (see the REQUIRED PRECONDITION doc
   * above): that failure aborts BEFORE commitLocalDomainRaw() is ever
   * called, so canonical storage is provably untouched and there is no
   * primary success to report. Callers must keep checking `status` for
   * every OTHER purpose this field does not replace — telling
   * "provenance-write-failed" apart from a genuine full success (so
   * ownership/syncReady/push still fail closed, and decideStaleResponseRecovery()
   * in syncPayload.ts still never auto-retries it), and telling
   * "committed" apart from "noop" where that distinction itself matters
   * (e.g. invalidating a content-derived cache only on a REAL write).
   */
  primaryCommitStatus: "committed" | "noop" | null;
  /**
   * The confirmed-authority state as of the moment this call returned —
   * `null` only when no authenticated identity was available to look one
   * up. For "committed"/"noop", this is the EXACT state this call itself
   * established (or confirmed unchanged); for "authority-changed", the
   * fresh state that was found to differ from the caller's expectation.
   * Callers ratchet their own frozen `winnerSelectionAuthority[domain]` to
   * this value directly — there is no separate reread/ratchet step left to
   * perform.
   */
  authority: ConfirmedPlannerState | null;
}

export interface DomainHydrationProvenanceInput {
  /** The server revision this pull's response carried. */
  revision: number;
  /**
   * True when the winning value being committed is byte-for-byte the
   * literal cloud value this pull fetched (see isExactCloudValue()'s own
   * doc in syncPayload.ts) — decides confirmed-authority vs
   * hydration-provenance recording, exactly like recordDomainProvenance()
   * (removed) used to.
   */
  isPureCloudValue: boolean;
  /** The value commitConfirmedBaseline() should record when `isPureCloudValue`. */
  confirmedValue: unknown;
  /** The value recordHydrationProvenance() should record otherwise. */
  hydrationValue: unknown;
}

function hydrationApplyIntentKey(userId: string, profileId: string, domain: ConfirmedDomainName): string {
  return `dwp:sync:${userId}:${profileId}:hydrationApplyIntent:${domain}`;
}

function readHydrationApplyIntent(
  userId: string,
  profileId: string,
  domain: ConfirmedDomainName
): HydrationApplyIntent | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(hydrationApplyIntentKey(userId, profileId, domain));
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HydrationApplyIntent>;
    if (
      typeof parsed.key === "string" &&
      typeof parsed.revision === "number" &&
      Number.isFinite(parsed.revision) &&
      typeof parsed.nextRaw === "string"
    ) {
      // SH.2.4.1 — `baselineEditFactIds` is `null` (never fabricated as
      // `[]`) whenever it is missing or malformed, e.g. an intent written
      // by pre-SH.2.4.1 code that survived a crash across a deploy boundary
      // — see resolveHydrationApplyIntentDisposition's own "FAIL CLOSED ON
      // UNKNOWN BASELINE" doc in syncPayload.ts for why that distinction
      // (unknown vs. genuinely empty) must be preserved rather than
      // collapsed to a default.
      const baselineEditFactIds =
        Array.isArray(parsed.baselineEditFactIds) && parsed.baselineEditFactIds.every((id) => typeof id === "string")
          ? parsed.baselineEditFactIds
          : null;
      return { key: parsed.key, revision: parsed.revision, nextRaw: parsed.nextRaw, baselineEditFactIds };
    }
  } catch {}
  return null;
}

export async function commitDomainHydration(input: {
  userId: string | null;
  profileId: string;
  domain: ConfirmedDomainName;
  key: string;
  expectedPreviousRaw: string | null;
  nextRaw: string;
  isStillValid: () => boolean;
  expectedAuthority: ConfirmedDomainResult<unknown>;
  provenance: DomainHydrationProvenanceInput | null;
}): Promise<DomainHydrationCommitResult> {
  const { userId, profileId, domain, key, expectedPreviousRaw, nextRaw, isStillValid, expectedAuthority, provenance } =
    input;
  if (!hasLocalDomainSerialization()) return { status: "unavailable", primaryCommitStatus: null, authority: null };
  if (!userId) {
    // No authenticated identity — no confirmed-authority concept applies
    // (unauthenticated local-only usage); behaves exactly like a plain
    // local commit always has, with no provenance recorded.
    const commitStatus = await commitLocalDomainRaw(key, expectedPreviousRaw, nextRaw, isStillValid);
    const status: DomainHydrationCommitStatus =
      commitStatus === "authority-superseded" ? "authority-changed" : commitStatus;
    const primaryCommitStatus = commitStatus === "committed" || commitStatus === "noop" ? commitStatus : null;
    return { status, primaryCommitStatus, authority: null };
  }
  return navigator.locks.request(
    confirmedAuthorityLockName(userId, profileId),
    async (): Promise<DomainHydrationCommitResult> => {
      const freshAuthority = getConfirmedState(userId, profileId);
      if (!confirmedDomainResultsEqual(freshAuthority[domain], expectedAuthority)) {
        return { status: "authority-changed", primaryCommitStatus: null, authority: freshAuthority };
      }
      const intentKey = hydrationApplyIntentKey(userId, profileId, domain);
      // SH.2.4.1 — captured BEFORE the intent is written (and reused,
      // below, as the EXACT snapshot commitLocalDomainRaw() itself retires)
      // so the intent's own crash-recovery frontier can never drift from
      // what actually gets retired on a successful commit. Only needed when
      // `provenance` is set — a `provenance === null` commit never writes
      // an intent at all (see the REQUIRED PRECONDITION doc above), so
      // there is nothing for a frontier to protect.
      const baselineEditFactIds = provenance ? snapshotKeysWithPrefix(localEditFactPrefix(key)) : null;
      if (provenance) {
        // SH.2.2 (Codex P1 "require the hydration intent before mutating"
        // round) — REQUIRED PRECONDITION, not best-effort: see this
        // section's own doc above for the full root-cause. A failure to
        // durably store the marker aborts BEFORE commitLocalDomainRaw() is
        // ever called — canonical storage is guaranteed untouched.
        let intentStored = false;
        try {
          const intent: HydrationApplyIntent = {
            key,
            revision: provenance.revision,
            nextRaw,
            baselineEditFactIds,
          };
          localStorage.setItem(intentKey, JSON.stringify(intent));
          intentStored = true;
        } catch {}
        if (!intentStored) {
          // The intent marker itself never landed — REQUIRED PRECONDITION
          // above means commitLocalDomainRaw() was never even called, so
          // canonical storage is provably untouched: `primaryCommitStatus`
          // is `null` here, unlike the two provenance-write-failed returns
          // further below (which happen strictly AFTER a successful
          // canonical commit).
          return { status: "provenance-write-failed", primaryCommitStatus: null, authority: freshAuthority };
        }
      }
      // commitLocalDomainRaw()'s own `isAuthorityStillValid` parameter is
      // left at its default (always-valid) — see this section's own doc
      // above for why the race it exists to catch cannot occur while this
      // call holds confirmedAuthorityLockName() for the whole operation.
      // Its `precomputedBaselineEditFactIds` parameter is passed the SAME
      // frontier just durably recorded above (`undefined` when no intent
      // was written at all) — see commitLocalDomainRaw's own doc for why
      // reusing this exact snapshot, rather than letting it take a second,
      // independently-timed one, is what makes the intent's frontier
      // provably identical to what gets retired.
      const commitStatus = await commitLocalDomainRaw(
        key,
        expectedPreviousRaw,
        nextRaw,
        isStillValid,
        () => Promise.resolve(true),
        baselineEditFactIds ?? undefined
      );
      if (
        commitStatus === "unavailable" ||
        commitStatus === "failed" ||
        commitStatus === "superseded" ||
        commitStatus === "aborted"
      ) {
        if (provenance) {
          try {
            localStorage.removeItem(intentKey);
          } catch {}
        }
        return { status: commitStatus, primaryCommitStatus: null, authority: freshAuthority };
      }
      // commitStatus is "noop" or "committed" here at runtime
      // ("authority-superseded" cannot occur — see above); narrow the type
      // explicitly since TypeScript cannot infer that from the default
      // isAuthorityStillValid argument alone.
      if (commitStatus === "authority-superseded") {
        return { status: "authority-changed", primaryCommitStatus: null, authority: freshAuthority };
      }
      if (!provenance) {
        return { status: commitStatus, primaryCommitStatus: commitStatus, authority: freshAuthority };
      }
      // SH.2.4.1 — from here on, `commitStatus` ("committed" or "noop") is
      // the canonical commit's OWN, ALREADY-DURABLE outcome: every return
      // below carries it as `primaryCommitStatus` regardless of whether the
      // follow-up provenance write that follows succeeds, so a caller can
      // always tell "the winning value is on disk" apart from "the
      // provenance/confirmed-fact record describing it also landed" — see
      // DomainHydrationCommitResult's own doc for the full root cause this
      // closes.
      let updatedAuthority = freshAuthority;
      if (provenance.isPureCloudValue) {
        const ok = recordConfirmedFactBody(userId, profileId, domain, provenance.revision, provenance.confirmedValue);
        if (!ok) return { status: "provenance-write-failed", primaryCommitStatus: commitStatus, authority: freshAuthority };
        // Re-read, STILL inside this SAME held lock — reflects exactly the
        // fact this call itself just wrote; no external writer for this
        // identity could have run anything while this lock was held, so
        // this can never absorb an externally-caused advancement. This IS
        // the ratchet — there is no further reread step.
        updatedAuthority = getConfirmedState(userId, profileId);
      } else {
        const ok = await recordHydrationProvenance(userId, profileId, domain, provenance.revision, provenance.hydrationValue);
        if (!ok) return { status: "provenance-write-failed", primaryCommitStatus: commitStatus, authority: freshAuthority };
      }
      try {
        localStorage.removeItem(intentKey);
      } catch {}
      return { status: commitStatus, primaryCommitStatus: commitStatus, authority: updatedAuthority };
    }
  );
}

/**
 * SH.2.4.1 (Codex P1 "hydration-intent crash-recovery frontier" round) —
 * the caller-side half of `hasNewerEditFact` that
 * resolveHydrationApplyIntentDisposition() (syncPayload.ts) needs: true
 * only when a CURRENTLY-surviving local-edit-fact key for `intent.key` is
 * NOT a member of `intent.baselineEditFactIds` — i.e. it was published
 * strictly after this hydration attempt's own pre-write snapshot, so it can
 * only be a genuinely newer post-baseline user edit, never the same stale
 * pre-hydration evidence a crash between commitLocalDomainRaw()'s canonical
 * `setItem` and its baseline-retirement loop can leave behind (see that
 * function's own doc for the write/retire pairing this recovers from).
 *
 * Deliberately DISTINCT from hasSurvivingEditFact() (unchanged, still
 * correct for every other caller): that function's own invariant — "any
 * surviving fact is newer" — holds only once a hydration commit has
 * actually retired its baseline, which is exactly what this specific
 * recovery path cannot assume happened.
 *
 * `baselineEditFactIds === null` (an intent written before this round, or
 * otherwise unparseable — see readHydrationApplyIntent's own doc) always
 * returns `false`: with no captured frontier to diff against, this cannot
 * PROVE any surviving fact is newer, and FAILS CLOSED rather than either
 * assuming "every surviving fact is newer" (silently reinstating the bug
 * this round closes) or "none is" in a way that would resolve the intent
 * outright (it does not — see resolveHydrationApplyIntentDisposition's own
 * "FAIL CLOSED ON UNKNOWN BASELINE" doc for how an unproven `false` here
 * still falls through to "incomplete" absent a matching durable fact).
 */
function hasNewerEditFactBeyondHydrationBaseline(intent: HydrationApplyIntent): boolean {
  if (intent.baselineEditFactIds === null) return false;
  const baseline = new Set(intent.baselineEditFactIds);
  return snapshotKeysWithPrefix(localEditFactPrefix(intent.key)).some((factKey) => !baseline.has(factKey));
}

/**
 * True when ANY domain of (userId, profileId) has a leftover
 * hydration-apply-intent marker whose disposition is "incomplete" — see
 * resolveHydrationApplyIntentDisposition()'s own doc in syncPayload.ts.
 * Consulted by buildPayloadFromStorage() below so neither doPush() nor
 * registerUnloadSync()'s beacon can turn an unresolved, possibly-partial
 * hydration write into a pushed "local edit" — the CRASH/RELOAD SAFETY
 * half of this round's requirement, independent of in-memory syncReady
 * (this reads only durable evidence). Opportunistically clears every
 * marker this scan finds "resolved" or "stale", so a healthy profile pays
 * this scan's cost only once per leftover marker, not on every push.
 */
function hasIncompleteHydrationApplyIntent(userId: string, profileId: string): boolean {
  let incomplete = false;
  for (const domain of CONFIRMED_DOMAIN_NAMES) {
    const intent = readHydrationApplyIntent(userId, profileId, domain);
    if (intent === null) continue;
    let canonicalRaw: string | null;
    try {
      canonicalRaw = localStorage.getItem(intent.key);
    } catch {
      canonicalRaw = null;
    }
    let hasMatchingDurableFact = false;
    if (canonicalRaw === intent.nextRaw) {
      try {
        const value = JSON.parse(intent.nextRaw) as unknown;
        const confirmedResult = getConfirmedState(userId, profileId)[domain];
        hasMatchingDurableFact =
          (confirmedResult.status === "confirmed" &&
            canonicalizeJSON(confirmedResult.fact.value) === canonicalizeJSON(value)) ||
          hasHydrationProvenanceMatch(userId, profileId, domain, Number.POSITIVE_INFINITY, value);
      } catch {
        hasMatchingDurableFact = false;
      }
    }
    const disposition = resolveHydrationApplyIntentDisposition(
      intent,
      canonicalRaw,
      hasNewerEditFactBeyondHydrationBaseline(intent),
      hasMatchingDurableFact
    );
    if (disposition === "incomplete") {
      incomplete = true;
      continue;
    }
    try {
      localStorage.removeItem(hydrationApplyIntentKey(userId, profileId, domain));
    } catch {}
  }
  return incomplete;
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

/**
 * SH.2.3 — the canonical localStorage key for a synced domain, keyed only
 * by profileId (matches buildPayloadFromStorage's own reads) — used to
 * locate a domain's local-edit-fact keyspace (localEditFactPrefix below)
 * when capturing or re-checking a pending operation's own per-domain
 * evidence. `ConfirmedDomainName` and the payload's own domain field names
 * ("plans"/"lightning"/"days") are deliberately identical strings.
 */
function domainCanonicalKey(profileId: string, domain: ConfirmedDomainName): string {
  return buildNamespacedKey(profileId, domain);
}

/**
 * SH.2.5.1 — the `baseRevision` a tagged operation (doPush()'s PUT,
 * registerUnloadSync()'s beacon) binds itself to: this device's best
 * current knowledge of this (userId, profileId) row's server revision,
 * captured AT SEND TIME. Combines TWO independent sources, taking the max:
 *   • knownBaseRevisionFromConfirmedState() — the highest revision any
 *     domain's own value was actually recorded as server-confirmed at (see
 *     its own doc in syncPayload.ts).
 *   • getObservedServerRevision() (SH.2.5.1 Codex P1 follow-up) — the
 *     highest revision ANY usable pull response has ever reported for this
 *     row, independent of whether any domain's value won that pull (see
 *     its own doc above and the "Observed server revision" section in
 *     syncPayload.ts). This is what keeps `baseRevision` advancing even for
 *     a device whose local edits keep legitimately winning every pull —
 *     without that pull ever needing to falsely mark a local-winning
 *     domain as server-confirmed just to make revision knowledge progress.
 * Callers only invoke this when `userId` is known (mirroring the existing
 * `if (userId) { addPendingOp(...) }` gating both send paths already use)
 * — there is no safe identity to scope either store under otherwise.
 */
function getKnownBaseRevision(userId: string, profileId: string): number {
  const fromConfirmedDomains = knownBaseRevisionFromConfirmedState(getConfirmedState(userId, profileId));
  const fromObservedPulls = getObservedServerRevision(userId, profileId);
  return Math.max(fromConfirmedDomains, fromObservedPulls);
}

/**
 * SH.2.3 — captures a pending operation's own per-domain evidence AT SEND
 * TIME, right before it is persisted (addPendingOp) and the request is
 * actually sent: a COMPACT FINGERPRINT (canonicalDigest(), syncPayload.ts —
 * Codex P1 "bound unresolved-operation storage" round) of each domain's own
 * value from the payload just built — never the full value itself, which
 * would durably duplicate an entire Plans/Lightning/Days dataset per
 * unresolved operation — plus the SNAPSHOT of local-edit-fact keys currently
 * present for that domain's canonical key (this operation's own "edit-fact
 * frontier" — the SAME kind of snapshot commitLocalDomainRaw's own
 * `baselineEditFactIds` takes, just from the SEND side rather than the WRITE
 * side). See isPendingOpDomainEvidenceCurrent()'s and canonicalDigest()'s
 * own docs in syncPayload.ts for why this bounded pair is sufficient to let
 * reconcilePendingOperations() later tell "this operation's own now-resolved
 * content" apart from "a genuine local edit made after it" — never from the
 * full content itself.
 */
function buildPendingOpDomains(profileId: string, payload: SyncedPlannerPayload): PendingOpRecord["domains"] {
  const domains: PendingOpRecord["domains"] = {
    plans: {
      digest: canonicalDigest(payload.plans),
      editFactKeys: snapshotKeysWithPrefix(localEditFactPrefix(domainCanonicalKey(profileId, "plans"))),
    },
    lightning: {
      digest: canonicalDigest(payload.lightning),
      editFactKeys: snapshotKeysWithPrefix(localEditFactPrefix(domainCanonicalKey(profileId, "lightning"))),
    },
  };
  if (payload.days !== undefined) {
    domains.days = {
      digest: canonicalDigest(payload.days),
      editFactKeys: snapshotKeysWithPrefix(localEditFactPrefix(domainCanonicalKey(profileId, "days"))),
    };
  }
  return domains;
}

/**
 * SH.2.3 — registers a pending operation's full evidence record (not merely
 * its opId, as before this phase — see this phase's own module note above
 * "Pending-operation domain evidence" doc in syncPayload.ts) under its
 * existing per-opId key. `domains` is `null` for a caller that has no
 * per-domain evidence to attach (there is none today — every caller now
 * builds one via buildPendingOpDomains() — but the parameter stays
 * optional so a record without evidence still round-trips through
 * getPendingOpRecord() exactly like a pre-SH.2.3 legacy entry would).
 *
 * Codex P1 fix ("pending evidence persistence" round) — returns whether the
 * write durably succeeded. This is no longer a fire-and-forget best-effort
 * write: both callers (doPush(), registerUnloadSync()) now REQUIRE a `true`
 * return before sending the network request at all — "no durable pending
 * evidence → do not send" (this round's own invariant). A localStorage
 * failure here (quota, private-mode, security error) must never be silently
 * swallowed into "the write proceeded with no recovery evidence", which is
 * exactly the uncertain-outcome-with-no-recovery-path gap this whole phase
 * exists to close.
 */
function addPendingOp(
  userId: string,
  profileId: string,
  opId: string,
  domains: PendingOpRecord["domains"] | null = null
): boolean {
  try {
    const record: PendingOpRecord = { opId, domains: domains ?? {} };
    localStorage.setItem(pendingOpKeyForIdentity(userId, profileId, opId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * SH.2.3 — reads a pending operation's full evidence record. Handles TWO
 * legacy/degraded shapes gracefully, both falling back to "no per-domain
 * evidence available" rather than throwing or treating the op as absent:
 * a pre-SH.2.3 entry (this key's value was the bare opId string, not JSON —
 * JSON.parse throws) and a value that parses but doesn't match the expected
 * shape (defensive). Either way the caller still gets a valid record with
 * `domains: {}`, so reconcilePendingOperations() simply skips the
 * retire+record step for every domain (no evidence to check) while still
 * retiring the pending-op key itself once accepted — exactly the pre-SH.2.3
 * behavior for an op registered before this phase shipped.
 */
function getPendingOpRecord(userId: string, profileId: string, opId: string): PendingOpRecord {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(pendingOpKeyForIdentity(userId, profileId, opId));
  } catch {}
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as Record<string, unknown>).opId === "string" &&
        typeof (parsed as Record<string, unknown>).domains === "object" &&
        (parsed as Record<string, unknown>).domains !== null
      ) {
        return parsed as PendingOpRecord;
      }
    } catch {}
  }
  return { opId, domains: {} };
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
 *
 * PULL OUTCOME CONTRACT (Codex P1, 17th round) — returns whether the PULL
 * that called this may continue past this point: `true` when there was
 * nothing to promote, or promotion (commitConfirmedBaseline) durably
 * succeeded; `false` ONLY when at least one op was found accepted by this
 * SAME GET response but its promotion could not be durably proven (a real
 * localStorage write failure, or a recordConfirmedFact() conflict — see
 * commitConfirmedBaseline's own doc). A caller MUST fail the entire pull
 * closed on `false`: no winner selection, no ownership transfer, no
 * confirmed-baseline commit, no syncReady — the accepted-but-unpromoted
 * evidence is real (the server DID accept this write) but this device has
 * not yet durably recorded what it resolved into, so proceeding as if
 * `getConfirmedState()` already reflected it would let the pull select a
 * winner, and potentially overwrite local content, against a stale/partial
 * baseline. The pending op itself is deliberately left untouched either
 * way (removePendingOp is only ever reached after a successful promotion,
 * unchanged from prior rounds) — a `false` return is purely a SIGNAL for
 * this pull to stop; the evidence for the NEXT pull to retry is already
 * exactly as durable as it always was.
 *
 * A GET that returned no usable snapshot at all (a 204, or an unparseable
 * response — `acceptedDomainFactsFromBeacon` returns null) is NOT a
 * promotion failure: there is nothing this pull could have promoted to, so
 * it returns `true` — the accepted op(s) simply remain pending for a later
 * pull that DOES receive a usable snapshot, exactly as before this round.
 */
export async function reconcilePendingOperations(
  userId: string,
  profileId: string,
  opStatuses: OpStatus[],
  cloudRevision: number | null,
  cloudSnapshot: SyncedPlannerPayload | null
): Promise<boolean> {
  if (typeof window === "undefined") return true;

  // SH.2.5.1 — retire every DEFINITIVELY rejected op's pending-evidence key
  // unconditionally, before anything else this function does. `rejected:
  // true` (see OpStatus's own doc above) is a permanent, deterministic
  // fact — unlike an accepted op, there is no confirmed-baseline promotion
  // to gate this retirement on: the operation never mutated `user_planner`
  // at all, so there is nothing here to reconcile against this pull's own
  // cloudSnapshot/cloudRevision, and no provenance to record. The
  // underlying local content (canonical storage + edit-fact(s)) this
  // rejected operation was built from is completely untouched by this —
  // buildPayloadFromStorage() only ever reads — so it remains exactly as
  // durable as it already was, ready for a LATER debounced push/beacon
  // (tagged with a fresh opId and, by then, this device's now-current
  // baseRevision) to resend normally rather than being stuck as an
  // unresolved pending record forever.
  for (const status of opStatuses) {
    if (status.rejected) {
      removePendingOp(userId, profileId, status.opId);
    }
  }

  const acceptedOpIds = opStatuses.filter((s) => s.found).map((s) => s.opId);
  if (acceptedOpIds.length === 0) return true;
  const resolved = acceptedDomainFactsFromBeacon(true, cloudRevision, cloudSnapshot);
  if (!resolved) return true;
  const allOk = await commitConfirmedBaseline(userId, profileId, resolved.revision, resolved.accepted);
  // A failed write means durable proof does not exist for at least one
  // domain — every accepted op from this pull stays pending rather than
  // being retired speculatively, and the caller must fail this pull closed.
  if (!allOk) return false;
  for (const opId of acceptedOpIds) {
    // SH.2.3 — before retiring this op's pending-evidence key, check
    // whether its OWN captured per-domain evidence is still the CURRENT
    // explanation for that domain's local content (see
    // isPendingOpDomainEvidenceCurrent()'s own doc in syncPayload.ts for
    // the full rationale). This is what stops an accepted-but-now-stale
    // operation's payload from being misread as a fresh local edit on a
    // LATER pull, once confirmed authority has advanced past it (op A
    // accepted here, then device Y's B becomes the newer confirmed
    // baseline): without this, A's own still-surviving local-edit fact
    // would remain an absolute veto against recognizing A as resolved, and
    // winner selection would push stale A right back over newer B.
    //
    // Codex P1 fix ("provenance before retirement" round) — ORDERING AND
    // FAIL-CLOSED: replacement provenance (recordHydrationProvenance) is
    // now durably recorded BEFORE either this domain's edit-fact(s) or
    // (once every domain is handled) the pending-op key itself is retired —
    // never after. The previous version retired the edit-fact FIRST, then
    // attempted the provenance write, then removed the pending-op key
    // UNCONDITIONALLY regardless of whether that write actually succeeded:
    // a provenance failure (recordHydrationProvenance returns `false` on a
    // genuine write exception — quota, private-mode, security error — it
    // does not throw) left this domain with NEITHER a surviving edit-fact
    // NOR a durable provenance record NOR a pending op to retry from —
    // exactly the "no durable evidence for an uncertain outcome" gap this
    // whole phase exists to close, just relocated to the retirement side
    // instead of the send side. Now: a provenance failure for ANY domain
    // this op was eligible to explain marks the whole op `domainFailed`,
    // which suppresses removePendingOp() for it below — the pending-op
    // record (and every domain's still-intact edit-fact/evidence) is left
    // exactly as durable as it already was, for the NEXT pull to retry the
    // SAME idempotent check (a domain already successfully retired this
    // round is simply a no-op next time — its edit-fact is already gone and
    // isPendingOpDomainEvidenceCurrent() sees an empty current set, still
    // "frontier intact").
    let domainFailed = false;
    try {
      const record = getPendingOpRecord(userId, profileId, opId);
      for (const domain of CONFIRMED_DOMAIN_NAMES) {
        const evidence = record.domains[domain];
        if (!evidence) continue;
        const key = domainCanonicalKey(profileId, domain);
        const currentEditFactKeys = snapshotKeysWithPrefix(localEditFactPrefix(key));
        // Read via the SAME normalization buildPayloadFromStorage() used to
        // produce `evidence.digest` in the first place (parseLocalDatasetEntry
        // for plans/lightning, a plain array for days) — comparing raw JSON
        // directly would spuriously disagree with a legacy array-only shape
        // still on disk for plans/lightning even when it represents the
        // identical dataset this operation sent. This SAME freshly-read
        // value (never the compact evidence, which no longer carries the
        // full value at all — see canonicalDigest's own "bound unresolved-
        // operation storage" doc in syncPayload.ts) is what gets recorded as
        // provenance below on a match.
        let currentValue: unknown = null;
        // SH.2.5.2 — hoisted out of the try block below (was previously
        // block-scoped and discarded) so the materialize-before-retire step
        // further down can reuse this EXACT same effective-durable raw
        // string as the value to materialize into canonical storage, never
        // a re-read that could observe a different moment in time.
        let currentRaw: string | null = null;
        try {
          currentRaw = readLatestDurableValue(key);
          if (domain === "days") {
            const parsed: unknown = currentRaw !== null ? JSON.parse(currentRaw) : null;
            currentValue = Array.isArray(parsed) ? parsed : null;
          } else {
            currentValue = parseLocalDatasetEntry(currentRaw);
          }
        } catch {
          currentValue = null;
          currentRaw = null;
        }
        const isCurrent = isPendingOpDomainEvidenceCurrent(
          currentEditFactKeys,
          evidence.editFactKeys,
          canonicalDigest(currentValue),
          evidence.digest
        );
        if (!isCurrent) continue;
        // Record the operation's now-current value as hydration-provenance-
        // equivalent evidence FIRST — only once THIS write is durably
        // proven (a genuine `true` return, not merely "did not throw") does
        // retiring the edit-fact(s) below become safe: retiring first and
        // recording second is exactly the ordering Codex flagged, since a
        // provenance write can fail without throwing.
        let provenanceOk = false;
        try {
          provenanceOk = await recordHydrationProvenance(userId, profileId, domain, resolved.revision, currentValue);
        } catch {
          provenanceOk = false;
        }
        if (!provenanceOk) {
          // Fail closed for this op: leave this domain's edit-fact(s) and
          // the pending-op record itself fully intact — see this loop's own
          // doc above for why a later pull safely retries the identical
          // check rather than losing evidence.
          domainFailed = true;
          continue;
        }
        // Durable replacement evidence now exists — the SAME LOCAL-EDIT
        // FACT LIFECYCLE retirement a hydration commit performs (see
        // commitLocalDomainRaw's own doc above) is safe to perform now, so
        // a subsequent pull's winner selection recognizes this domain's
        // still-on-disk bytes as explained rather than a fresh edit, and
        // defers to whatever the CURRENT confirmed baseline is.
        //
        // SH.2.5.2 (Codex review, "accepted-operation reconciliation"
        // finding) — MATERIALIZE BEFORE RETIRE. `currentRaw` is the
        // EFFECTIVE durable value this now-accepted operation's evidence
        // matched (canonical + any surviving edit fact — see
        // readLatestDurableValue()/resolveEffectiveDurableRaw()'s own
        // docs), not necessarily what canonical storage itself currently
        // holds: `currentEditFactKeys` can outrank a canonical key that is
        // still stale (e.g. a prior edit whose canonical leg never landed —
        // SH.2.4's own "committed-unprotected" persist outcome). Retiring
        // those facts BEFORE canonical durably holds this exact value would
        // leave canonical's stale bytes as the ONLY surviving evidence for
        // readLatestDurableValue() from that point on — exactly the "an
        // authoritative fact retires while canonical still contains an
        // older value" gap this round closes. `currentRaw === null` (both
        // the fact read and the fallback failed) means there is nothing
        // durable to materialize or retire — fail this domain closed rather
        // than guessing.
        if (currentRaw === null) {
          domainFailed = true;
          continue;
        }
        let canonicalRawAtDecision: string | null;
        try {
          canonicalRawAtDecision = localStorage.getItem(key);
        } catch {
          domainFailed = true;
          continue;
        }
        if (canonicalRawAtDecision === currentRaw) {
          // Canonical already durably holds the accepted value — nothing to
          // materialize, safe to retire the observed baseline directly.
          for (const factKey of currentEditFactKeys) {
            try {
              localStorage.removeItem(factKey);
            } catch {}
          }
        } else {
          // Canonical is stale relative to the accepted value — materialize
          // it via the SAME CAS/authority-protected primitive every other
          // durable local-domain write uses, never a bespoke setItem.
          // `currentEditFactKeys` is passed as this commit's own baseline:
          // on a genuine "committed" write, commitLocalDomainRaw() retires
          // EXACTLY that frontier itself (see its own LOCAL-EDIT FACT
          // LIFECYCLE doc) — a fact that appeared AFTER this snapshot (a
          // genuinely newer/concurrent edit) is, by construction, not a
          // member of it, so the CAS's own re-scan reports "superseded"
          // instead of ever touching it: never deleted, never overwritten.
          const materializeStatus = await commitLocalDomainRaw(
            key,
            canonicalRawAtDecision,
            currentRaw,
            undefined,
            undefined,
            currentEditFactKeys
          );
          if (materializeStatus === "committed") {
            // commitLocalDomainRaw() already retired currentEditFactKeys.
          } else if (materializeStatus === "noop") {
            // A concurrent writer already materialized this exact value —
            // commitLocalDomainRaw()'s own re-scan already proved no fact
            // outside this frontier survived, so retiring it directly here
            // is exactly as safe as the already-matching branch above.
            for (const factKey of currentEditFactKeys) {
              try {
                localStorage.removeItem(factKey);
              } catch {}
            }
          } else {
            // "superseded" / "authority-superseded" / "aborted" / "failed" /
            // "unavailable" — safe materialization could not be proven.
            // Fail conservatively: retain the fact(s) and the pending-op
            // record untouched for a later pull to retry the identical
            // check, exactly like a provenance-write failure above. A
            // newer/concurrent fact is never deleted or overwritten by this
            // branch.
            domainFailed = true;
            continue;
          }
        }
      }
    } catch {
      domainFailed = true;
    }
    // The op's core "was it accepted" fact is already durably promoted via
    // commitConfirmedBaseline() above regardless of `domainFailed` — only
    // the SUPPLEMENTARY provenance/edit-fact explanation above is at risk,
    // so a provenance failure here never re-opens this function's own PULL
    // OUTCOME CONTRACT (it does not return `false`); it only keeps this ONE
    // op's pending-evidence key alive for a later retry instead of retiring
    // it on unproven replacement evidence.
    if (!domainFailed) {
      removePendingOp(userId, profileId, opId);
    }
  }
  return true;
}

// ── Sync state observer ───────────────────────────────────────────────────────

/**
 * Custom event name dispatched on window whenever sync status changes.
 * Listen to this for same-tab reactive updates (e.g. on the Settings page).
 */
export const SYNC_STATE_CHANGED_EVENT = "dwp:syncStateChanged";

/**
 * SH.2.5.1 Codex P1 follow-up (problem 2) — custom event dispatched on
 * `window` when doPush() receives a DETERMINISTIC stale-first-delivery 409
 * (see evaluateOperationBaseRevision's own doc in syncPayload.ts).
 * `user_planner` was never touched by that rejected write, so the mounted
 * page's own local edit (still fully intact — this module never writes
 * canonical storage) needs a fresh pull to learn the row's actual current
 * revision before it can be retried; without one, this device would keep
 * retrying with the SAME now-known-stale `baseRevision` until an unrelated
 * reload/auth transition happened to trigger a pull anyway.
 *
 * `detail` is `{ userId, profileId }` — the identity the REJECTED push was
 * for (captured at that push's own start, exactly like every other
 * profile-scoped write in this module). A listener (see each page's pull
 * effect) MUST compare this against its OWN currently active identity
 * before reacting — a rejection for a profile/user this tab has since
 * navigated away from must never trigger a pull under the WRONG identity.
 *
 * Deliberately a SEPARATE event from SYNC_STATE_CHANGED_EVENT above: that
 * one fires on every ordinary status transition (idle/syncing/error/…) and
 * would be a poor signal to schedule a whole extra pull from — this one
 * fires ONLY for the narrow, DETERMINISTIC condition that actually needs
 * one. Listeners are expected to feed this into the SAME existing
 * "replacement pull" mechanism each page already has for stale-response
 * recovery (staleRetryTick/staleRetryPendingRef — see
 * decideStaleResponseRecovery's own doc in syncPayload.ts and each page's
 * pull effect) rather than scheduling a pull through any new mechanism.
 */
export const STALE_OPERATION_REJECTED_EVENT = "dwp:staleOperationRejected";

export interface StaleOperationRejectedDetail {
  userId: string;
  profileId: string;
}

/**
 * SH.2.2 ("fail closed when push confirmation is not durable" round) —
 * "unresolved" is a DISTINCT status from "idle": the most recent push
 * completed over HTTP (server accepted it — never a transport/auth error,
 * unlike "error") but could not yet be durably confirmed locally (a
 * malformed/missing response revision, or a genuine recordConfirmedFact
 * conflict). See doPush()'s own doc for the full contract and how it
 * self-resolves via the pending-op mechanism on the next successful pull.
 */
export interface SyncState {
  status: "idle" | "syncing" | "error" | "unresolved";
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
      rawStatus === "syncing" || rawStatus === "error" || rawStatus === "unresolved" ? rawStatus : "idle";
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
 *
 * SH.2.6 P2 follow-up (Codex) — CLEAR STALE "syncing" AT THE TRANSITION
 * BOUNDARY, never reactively from a superseded push's own completion. See
 * clearStaleSyncingStatus's own doc for the full rationale: once ANY time
 * has passed after a transition, a later push's completion can no longer
 * safely tell "the profile's status key still says 'syncing' because
 * nobody has touched it since MY write" apart from "a DIFFERENT tab, for
 * the new/current identity, has ALSO legitimately written 'syncing' to
 * this SAME profile-only key since" — the two are indistinguishable from
 * that vantage point, and clearing in the second case would stomp on a
 * genuinely active sync. This function, however, IS a safe place to
 * clear: it runs synchronously, exactly once, at the precise instant a
 * genuine transition happens, strictly BEFORE `currentSyncProfileId` is
 * reassigned and before any push under the new profile could possibly
 * have run in THIS tab — so a "syncing" value still present on
 * `currentSyncProfileId`'s key at this exact statement can only be a
 * leftover from whatever was happening under the OLD profile, never
 * something the new one already wrote. Targets the OLD profileId
 * (captured before reassignment below), and — like doPush()'s own
 * completion gating — only ever touches a status that is STILL exactly
 * "syncing"; any other value (idle/error/unresolved) is left alone.
 */
export function setSyncProfileId(profileId: string): void {
  if (profileId === currentSyncProfileId) return;
  // Profile changed — cancel any pending work for the old profile.
  cancelScheduledSync();
  clearStaleSyncingStatus(currentSyncProfileId);
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
 *
 * SH.2.6 P2 follow-up (Codex) — clears a stale "syncing" left behind by a
 * now-superseded push for `currentSyncProfileId`, at this exact
 * transition instant — see setSyncProfileId's own doc for the full
 * rationale (identical here: A -> B and sign-out/sign-in are both
 * "the identity changed" transitions). Runs BEFORE `currentSyncUserId` is
 * reassigned, targeting the profile this identity change is happening
 * under — a "syncing" value still present at this exact statement can
 * only be the prior identity's own leftover, never something the new one
 * already wrote in THIS tab.
 */
export function setSyncUserId(userId: string | null): void {
  if (userId === currentSyncUserId) return;
  cancelScheduledSync();
  clearStaleSyncingStatus(currentSyncProfileId);
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
  // SH.2.5.1 — the DETERMINISTIC "this operation was rejected as stale and
  // will never be accepted" fact (see lookupOpStatus's own doc in
  // api/sync/planner/route.ts). Only ever true when `found` is false;
  // absent/malformed defaults to false (the ordinary, ambiguous case),
  // never fabricated.
  const rejected = r.rejected === true;
  return { opId: r.opId, found: r.found, revision, ...(rejected ? { rejected: true } : {}) };
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
 * SH.2.6 — the shape pullPlanner() resolves to for every HTTP 200 response.
 * Deliberately a discriminated union on `plans`/`lightning` rather than
 * extending `SyncedPlannerPayload` unconditionally: a 200 response's
 * `plannerJson` can independently be USABLE (parses and validates via
 * parseSyncedPlannerPayload) or UNUSABLE (malformed/unexpected shape — see
 * api/sync/planner/route.ts's GET doc for how `null`/`{}`/legacy-shaped
 * `planner_json` reaches the client as a 200, not a 204), while `revision`
 * and `opStatuses` are independently valid server facts about this (user,
 * profile) row's WRITE history either way — a corrupted/unexpected
 * `plannerJson` says nothing about whether the row's `revision` counter or
 * the requested `lastOpId` lookups are trustworthy. `plans`/`lightning` are
 * both `null` together (never one without the other) exactly when content
 * was unusable — parseSyncedPlannerPayload() itself is all-or-nothing, so
 * there is no partial-content case to represent.
 */
export type PulledPlannerEnvelope =
  | (SyncedPlannerPayload & { revision: number | null; opStatuses: OpStatus[] })
  | { plans: null; lightning: null; days?: undefined; revision: number | null; opStatuses: OpStatus[] };

/**
 * SH.2.6 — pure decision core for a single HTTP 200 `/api/sync/planner` GET
 * response body: separates "is the planner CONTENT safe to hydrate from"
 * from "are the revision/opStatuses METADATA usable" (see PulledPlannerEnvelope's
 * own doc). Never called for a 204 (no body to derive from — pullPlanner()
 * returns `null` directly for that case, before this function is reached).
 *
 * Unusable content (`parseSyncedPlannerPayload` returns null — malformed
 * JSON already coerced to `null` by the caller, an unexpected shape like
 * `{}`, or a legacy-only response this device's caller could not normalize)
 * NEVER falls back to an empty planner (`{version:1,items:[]}`) — that
 * would be indistinguishable from a genuinely empty cloud planner and could
 * let a later winner-selection treat "content we couldn't read" as "content
 * that says delete everything". `plans`/`lightning` stay `null` instead,
 * exactly like every existing call site's own `planner?.plans`/
 * `planner?.lightning` truthy-checks already treat "no usable domain
 * value" — those checks continue to behave identically whether `planner`
 * itself is absent (204) or present-but-content-null (this case).
 *
 * `revision`/`opStatuses` are extracted independently of content validity
 * and never fabricated: a non-finite/non-numeric `revision` stays `null`
 * (see this function's own DEV cases), and a missing/malformed `opStatuses`
 * stays `[]` (parseOpStatuses' own contract) — both regardless of whether
 * `plannerJson` was usable.
 */
export function derivePulledPlannerEnvelope(data: {
  plannerJson?: unknown;
  revision?: unknown;
  opStatuses?: unknown;
}): PulledPlannerEnvelope {
  const revision = typeof data.revision === "number" && Number.isFinite(data.revision) ? data.revision : null;
  const opStatuses = parseOpStatuses(data.opStatuses);
  const parsed = parseSyncedPlannerPayload(data.plannerJson ?? null);
  if (!parsed) {
    return { plans: null, lightning: null, revision, opStatuses };
  }
  return { ...parsed, revision, opStatuses };
}

/**
 * Reference cases for derivePulledPlannerEnvelope() — run from Node:
 *   import { DEV_PULLED_PLANNER_ENVELOPE_CASES, derivePulledPlannerEnvelope } from "@/lib/syncHelper";
 *   DEV_PULLED_PLANNER_ENVELOPE_CASES.forEach(c => {
 *     const got = derivePulledPlannerEnvelope(c.data);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_PULLED_PLANNER_ENVELOPE_CASES: Array<{
  name: string;
  data: { plannerJson?: unknown; revision?: unknown; opStatuses?: unknown };
  expected: PulledPlannerEnvelope;
}> = [
  {
    name: "valid planner + valid revision + valid opStatuses — full content preserved",
    data: {
      plannerJson: { version: 1, plans: { version: 1, items: ["a"] }, lightning: { version: 1, items: [] } },
      revision: 7,
      opStatuses: [{ opId: "op-1", found: true, revision: 7 }],
    },
    expected: {
      version: 1,
      plans: { version: 1, items: ["a"] },
      lightning: { version: 1, items: [] },
      revision: 7,
      opStatuses: [{ opId: "op-1", found: true, revision: 7 }],
    },
  },
  {
    name: "required — 200 with unusable plannerJson (null) + valid revision — revision preserved, content null (never empty)",
    data: { plannerJson: null, revision: 5, opStatuses: [] },
    expected: { plans: null, lightning: null, revision: 5, opStatuses: [] },
  },
  {
    name: "required — 200 with unusable plannerJson ({}) — content null, revision still preserved",
    data: { plannerJson: {}, revision: 3, opStatuses: [] },
    expected: { plans: null, lightning: null, revision: 3, opStatuses: [] },
  },
  {
    name: "required — valid queried opStatuses survive unusable planner content",
    data: { plannerJson: { version: 1 }, revision: 4, opStatuses: [{ opId: "op-9", found: true, revision: 4 }] },
    expected: {
      plans: null,
      lightning: null,
      revision: 4,
      opStatuses: [{ opId: "op-9", found: true, revision: 4 }],
    },
  },
  {
    name: "required — malformed revision (non-numeric) is never fabricated as authoritative, even with valid content",
    data: {
      plannerJson: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
      revision: "not-a-number",
      opStatuses: [],
    },
    expected: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      revision: null,
      opStatuses: [],
    },
  },
  {
    name: "missing revision field entirely — stays null, not coerced to 0",
    data: { plannerJson: null, opStatuses: [] },
    expected: { plans: null, lightning: null, revision: null, opStatuses: [] },
  },
  {
    name: "malformed opStatuses (not an array) — degrades to [], never fabricated, content still preserved",
    data: {
      plannerJson: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
      revision: 2,
      opStatuses: "not-an-array",
    },
    expected: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      revision: 2,
      opStatuses: [],
    },
  },
];

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
 *   PulledPlannerEnvelope — an HTTP 200 response was received. `revision`/
 *     `opStatuses` are always independently derived (see
 *     derivePulledPlannerEnvelope's own doc) regardless of content
 *     usability. `plans`/`lightning` are the parsed domain values when
 *     `plannerJson` was usable, or BOTH `null` (SH.2.6 — never coerced to
 *     an empty `{version:1,items:[]}`) when it was not — callers' existing
 *     `planner?.plans`/`planner?.lightning` truthy-checks already treat
 *     "no usable domain value" identically to the pre-SH.2.6 "planner is
 *     null" case, so this never widens what gets hydrated; it only widens
 *     what `revision`/`opStatuses` remain available for reconciliation.
 *     Callers that need a genuine `SyncedPlannerPayload` for downstream
 *     reconciliation (e.g. reconcilePendingOperations' `cloudSnapshot` —
 *     see its own doc) must narrow on `plans` (or `lightning`) being
 *     non-null first, exactly like `!!planner?.lightning` already does.
 *   null — genuinely empty: HTTP 204 No Content, nothing stored yet for
 *     this user+profile. Distinct from the 200-but-unusable-content case
 *     above — a 204 is itself a CONCLUSIVE "none of the queried opIds were
 *     ever accepted" answer (a write that records an opId always also
 *     upserts a `user_planner` row in the SAME transaction — see
 *     handleWrite in api/sync/planner/route.ts), so 204 (no row in
 *     user_planner at all) is structurally incompatible with ANY opId
 *     having been accepted. Callers may safely treat a null pullPlanner()
 *     result as "no queried op was accepted" unconditionally, without
 *     needing to inspect (nonexistent, since 204 has no body) opStatuses —
 *     this contract does NOT extend to the 200-but-unusable-content case,
 *     whose own `opStatuses` must still be consulted normally.
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
): Promise<PulledPlannerEnvelope | null> {
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
  return derivePulledPlannerEnvelope(data);
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
    // SH.2.6 — capture this beacon's base revision BEFORE snapshotting
    // localStorage into a payload, not after. localStorage is shared
    // across tabs: reading `baseRevision` AFTER buildPayloadFromStorage()
    // (the pre-SH.2.6 order) let a concurrent write from ANOTHER tab —
    // its own doPush() or beacon completing and calling
    // commitConfirmedBaseline()/recordObservedServerRevision() — land in
    // the gap between the two calls. That tab's revision advance would
    // then be attached to THIS tab's already-stale payload P (built
    // before the advance), so `baseRevision` would claim knowledge P's own
    // snapshot never actually reflected — exactly what let a stale P sail
    // through evaluateOperationBaseRevision()'s "current" branch (server
    // sees baseRevision === currentRevision and accepts P outright) instead
    // of being rejected as stale. Reading `baseRevision` FIRST bounds it to
    // AT MOST what was known when this snapshot began: if another tab's
    // write still lands in the (now much smaller) gap before
    // buildPayloadFromStorage() runs, the worst case is a spurious 409
    // (baseRevision is stale relative to a revision this device hadn't
    // captured yet) — handled by the existing STALE_OPERATION_REJECTED_EVENT
    // recovery pull below — never a false accept of a stale payload.
    // Only computed when `userId` is known, mirroring the pending-op
    // registration gating immediately below — there is no confirmed-state
    // scope to read otherwise, and an old/untagged beacon (no `userId`)
    // must remain exactly as unprotected as it already was.
    const baseRevision = userId ? getKnownBaseRevision(userId, profileId) : null;
    const payload = buildPayloadFromStorage(profileId, userId);
    if (!payload) return;
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).length > MAX_SYNC_BYTES) return;
    const opId = generateOpId();
    // SH.2.3 — persist this beacon's pending evidence BEFORE calling
    // sendBeacon(), not after it returns: sendBeacon()'s own return value
    // only tells us the browser accepted the request for background
    // delivery (see this function's own doc above), and a beforeunload
    // handler can itself be interrupted by page teardown at any statement
    // boundary — registering first, then undoing the registration if the
    // browser never actually queued it (below), closes that ordering gap
    // the same way doPush() now does for ordinary PUTs.
    //
    // Codex P1 fix ("pending evidence persistence" round) — "no durable
    // pending evidence → do not send": if addPendingOp() itself could not
    // durably persist this evidence (a localStorage write failure), the
    // beacon is never sent at all. There is no later retry this handler can
    // schedule (the page is unloading right now) — but the content is
    // already safely durable in local canonical storage and its own
    // local-edit fact, exactly as it was before this handler ran, for a
    // LATER session's ordinary doPush()/beacon to pick up and push
    // (correctly evidenced) once storage pressure clears.
    if (userId) {
      const registered = addPendingOp(userId, profileId, opId, buildPendingOpDomains(profileId, payload));
      if (!registered) return;
    }
    const baseRevisionParam = baseRevision !== null ? `&baseRevision=${baseRevision}` : "";
    const queued = navigator.sendBeacon(
      `/api/sync/planner?profileId=${encodeURIComponent(profileId)}&clientOpId=${encodeURIComponent(opId)}${baseRevisionParam}`,
      new Blob([body], { type: "application/json" })
    );
    if (!queued && userId) {
      // Never actually sent — nothing for a later pull to reconcile, so
      // don't leave phantom pending-op evidence behind.
      removePendingOp(userId, profileId, opId);
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
    // Codex P1 fix (17th round) — reads the newest DURABLE edit for the
    // days key, not merely whatever the canonical key currently holds; see
    // readLatestDurableValue()'s own doc above.
    const raw = readLatestDurableValue(buildNamespacedKey(profileId, "days"));
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
 *
 * SH.2.2 ("consolidated hydration commit boundary" round) — CRASH/RELOAD
 * SAFETY: also returns null when `userId` is known and
 * hasIncompleteHydrationApplyIntent() reports a leftover, unresolved
 * hydration-apply intent for this profile — see that function's own doc
 * above. Shared by doPush() and registerUnloadSync()'s beacon (both route
 * through this same function), so neither path can turn a possibly-partial
 * hydration write into a pushed "local edit" while it remains unresolved;
 * the next successful pull's own commitDomainHydration() call resolves it
 * normally.
 */
function buildPayloadFromStorage(profileId: string, userId: string | null): SyncedPlannerPayload | null {
  if (typeof window === "undefined") return null;
  if (userId && hasIncompleteHydrationApplyIntent(userId, profileId)) return null;
  try {
    // Codex P1 fix (17th round) — LOCAL-FIRST + CROSS-TAB SERIALIZATION:
    // "unload serializes the newest durable edit state, not merely the
    // canonical key" (used by both doPush() and registerUnloadSync()'s
    // beforeunload handler below, since both route through this same
    // function) — see readLatestDurableValue()'s own doc above for why this
    // is guaranteed to reflect the user's true latest edit even in the rare
    // window where a concurrent hydration race has transiently clobbered
    // the canonical key itself.
    const plansRaw = readLatestDurableValue(buildNamespacedKey(profileId, "plans"));
    const lightningRaw = readLatestDurableValue(buildNamespacedKey(profileId, "lightning"));

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

/**
 * SH.2.6 — pure decision core for whether doPush() may publish its
 * UI-facing completion state (syncStatusKeyForProfile/syncErrorKeyForProfile/
 * lastSyncedKeyForProfile + SYNC_STATE_CHANGED_EVENT) once its network round
 * trip resolves. Codex P1 finding: those three keys are namespaced ONLY by
 * profileId, never by userId (see their own doc above) — correct for the
 * documented "profile, not tab" isolation, but it means an in-flight push
 * captured under user A can complete AFTER the same profile slot has
 * transitioned to user B (e.g. A signs out, B signs in, both on the
 * "default" profile), silently overwriting B's sync-status UI with A's
 * now-irrelevant completion (settings/page.tsx's SYNC_STATE_CHANGED_EVENT
 * listener re-reads that SAME profile-keyed status with no identity check
 * at all — see getSyncStateForProfile()'s own callers).
 *
 * Deliberately identical logic to isPullEpochCurrent() — push completion
 * and pull continuation are answering the exact same question ("has a
 * genuine identity/profile transition happened since I started"), so this
 * reuses currentPullEpoch/isPullEpochCurrent (bumped by setSyncUserId()/
 * setSyncProfileId() on every genuine change) rather than introducing a
 * second status-storage or identity-tracking architecture. `pushEpoch` is
 * the epoch doPush() captured at start (alongside userId/profileId);
 * `epochAtCompletion` is a FRESH read of currentPullEpoch taken at each
 * point after an awaited boundary (the network fetch, and again after the
 * inner commitConfirmedBaseline() await on the 2xx path) — never a value
 * cached from before that await, which could already be stale by the time
 * it's checked.
 *
 * This gates ONLY the UI-facing status publication, never the underlying
 * operation: removePendingOp()/commitConfirmedBaseline() and the
 * STALE_OPERATION_REJECTED_EVENT dispatch remain unconditional, exactly as
 * before — they are already correctly scoped to the CAPTURED (userId,
 * profileId), not the current one (per this module's existing "an
 * already-running, origin-scoped operation may finish safely" invariant —
 * see the module doc), and STALE_OPERATION_REJECTED_EVENT's own listeners
 * already self-filter on `detail.userId`/`detail.profileId` (see
 * plans/page.tsx's own handler). Only the profile-keyed UI status writes
 * have no such per-event identity to filter on, which is exactly the gap
 * this closes.
 */
export function shouldPublishPushCompletionStatus(pushEpoch: number, epochAtCompletion: number): boolean {
  return isPullEpochCurrent(pushEpoch, epochAtCompletion);
}

/**
 * Reference cases for shouldPublishPushCompletionStatus() — run from Node:
 *   import { DEV_SHOULD_PUBLISH_PUSH_COMPLETION_STATUS_CASES, shouldPublishPushCompletionStatus } from "@/lib/syncHelper";
 *   DEV_SHOULD_PUBLISH_PUSH_COMPLETION_STATUS_CASES.forEach(c => {
 *     const got = shouldPublishPushCompletionStatus(c.pushEpoch, c.epochAtCompletion);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_SHOULD_PUBLISH_PUSH_COMPLETION_STATUS_CASES: Array<{
  name: string;
  pushEpoch: number;
  epochAtCompletion: number;
  expected: boolean;
}> = [
  {
    name: "no transition since push started — publish normally",
    pushEpoch: 3,
    epochAtCompletion: 3,
    expected: true,
  },
  {
    name: "required — in-flight A -> B auth transition (setSyncUserId bumps epoch) completing as a 409/unresolved write — suppressed, B's UI must not inherit A's unresolved status",
    pushEpoch: 3,
    epochAtCompletion: 4,
    expected: false,
  },
  {
    name: "required — same scenario, an ordinary 2xx/idle completion instead of unresolved — still suppressed, any stale completion value is blocked identically regardless of which status it is",
    pushEpoch: 5,
    epochAtCompletion: 6,
    expected: false,
  },
  {
    name: "profile switch (setSyncProfileId) during the same push — also suppressed, same epoch mechanism covers both identity and profile transitions",
    pushEpoch: 10,
    epochAtCompletion: 11,
    expected: false,
  },
  {
    name: "multiple transitions while this push was in flight — still suppressed, not merely off-by-one",
    pushEpoch: 2,
    epochAtCompletion: 9,
    expected: false,
  },
];

/**
 * SH.2.6 P2 follow-up (Codex) — "do not clear an indistinguishable
 * current-tab sync". An EARLIER version of this fix had doPush() itself
 * clear a stale "syncing" reactively, from inside its own suppressed-
 * completion path, whenever the profile's status key was STILL exactly
 * "syncing" at that moment. That reasoning is sound WITHIN one tab (this
 * module's `inFlight` flag fully serializes same-tab pushes, so nothing
 * else in the SAME tab could have written to the key between this push's
 * own pre-request write and its own completion check) — but it is UNSAFE
 * across tabs: a DIFFERENT tab, for the new/current identity, can
 * legitimately start its own push and write "syncing" to this SAME
 * profile-only key AFTER a transition but BEFORE this now-superseded
 * push's response resolves. At that point "the key still says syncing"
 * no longer means "nobody has touched it since my own write" — it is
 * indistinguishable from "another tab's genuinely active sync", and a
 * reactive clear from the superseded push's completion could stomp on
 * that real, in-progress sync.
 *
 * The fix: clearing responsibility moves ENTIRELY to the
 * identity/profile-TRANSITION boundary — see clearStaleSyncingStatus's
 * own doc below and its call sites in setSyncUserId()/setSyncProfileId().
 * That is the ONE place a "syncing" leftover can be attributed with
 * certainty (nothing under the new identity/profile has had a chance to
 * write anything yet, in THIS tab, at the exact synchronous instant the
 * transition happens). doPush()'s own suppressed-completion path is now a
 * PURE noop — see applyCompletion() below — it never attempts to touch
 * the status key at all once shouldPublishPushCompletionStatus() says no,
 * so it can never race with, or misidentify, a legitimately different
 * tab's active sync.
 */

/**
 * SH.2.6 P2 follow-up (Codex) — pure predicate for whether
 * clearStaleSyncingStatus() should touch the status key at all: only ever
 * "syncing" itself. Any other value (idle/error/unresolved), or a missing
 * key, is left completely untouched — it can only belong to something
 * else this device has no business overwriting. Extracted as its own pure
 * function purely so DEV_*-style Node coverage can exercise this decision
 * directly, mirroring shouldPublishPushCompletionStatus's own pattern.
 */
export function shouldClearStaleSyncingStatus(currentStatus: string | null): boolean {
  return currentStatus === "syncing";
}

/**
 * Reference cases for shouldClearStaleSyncingStatus() — run from Node:
 *   import { DEV_SHOULD_CLEAR_STALE_SYNCING_STATUS_CASES, shouldClearStaleSyncingStatus } from "@/lib/syncHelper";
 *   DEV_SHOULD_CLEAR_STALE_SYNCING_STATUS_CASES.forEach(c => {
 *     const got = shouldClearStaleSyncingStatus(c.currentStatus);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_SHOULD_CLEAR_STALE_SYNCING_STATUS_CASES: Array<{
  name: string;
  currentStatus: string | null;
  expected: boolean;
}> = [
  {
    name: "required — status is still exactly \"syncing\" — safe to clear (this IS what a stale leftover looks like at the transition boundary)",
    currentStatus: "syncing",
    expected: true,
  },
  {
    name: "status already idle — never touch it; nothing to clear",
    currentStatus: "idle",
    expected: false,
  },
  {
    name: "status shows error — never downgrade a real error to idle on the transition's say-so",
    currentStatus: "error",
    expected: false,
  },
  {
    name: "status shows unresolved — never overwrite a genuinely unresolved outcome",
    currentStatus: "unresolved",
    expected: false,
  },
  {
    name: "status key missing entirely (null) — nothing to clear",
    currentStatus: null,
    expected: false,
  },
];

/**
 * SH.2.6 P2 follow-up (Codex) — clears a stale "syncing" left behind by a
 * now-superseded operation for `profileId`. Called ONLY from the
 * identity/profile-transition boundary (setSyncUserId()/setSyncProfileId()
 * — see their own docs for why that call site, and only that call site, is
 * safe: it runs synchronously at the exact instant a genuine transition
 * happens, strictly before anything under the new identity/profile could
 * have written anything in THIS tab). Re-reads the status key itself
 * (never trusts a value the caller already had) and applies
 * shouldClearStaleSyncingStatus() above to decide whether to touch it at
 * all. Resets to "idle" and clears any stale error text, mirroring
 * exactly what an ordinary successful completion would have left behind —
 * a neutral terminal state, never a fabricated "success" for an operation
 * whose actual outcome is no longer this device's to report.
 */
function clearStaleSyncingStatus(profileId: string): void {
  let currentStatus: string | null = null;
  try {
    currentStatus = localStorage.getItem(syncStatusKeyForProfile(profileId));
  } catch {
    return;
  }
  if (!shouldClearStaleSyncingStatus(currentStatus)) return;
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
  // SH.2.6 — capture the sync epoch (bumped by setSyncUserId()/
  // setSyncProfileId() on every genuine transition) alongside identity, so
  // this push's own UI-facing completion writes can be gated against it
  // later via shouldPublishPushCompletionStatus() — see that function's own
  // doc for the full rationale.
  const pushEpoch = currentPullEpoch;

  // SH.2.6 — capture this push's base revision BEFORE snapshotting
  // localStorage into a payload, not after (the pre-SH.2.6 order, which
  // read `baseRevision` down near `opId` below). localStorage is shared
  // across tabs: reading it second let a concurrent write from ANOTHER tab
  // — its own doPush()/beacon completing and calling
  // commitConfirmedBaseline()/recordObservedServerRevision() — land in the
  // gap between building payload P and reading `baseRevision`, tagging P
  // with a revision its own snapshot never actually reflected. Because the
  // server's evaluateOperationBaseRevision() (syncPayload.ts) accepts
  // outright whenever baseRevision === currentRevision, that stale P would
  // sail straight through as "current" instead of being rejected — exactly
  // the coherence gap this fix closes. Reading `baseRevision` FIRST bounds
  // it to AT MOST what this device knew when the snapshot began: if
  // another tab's write still lands in the (now much smaller) gap before
  // buildPayloadFromStorage() runs, the worst case is a spurious 409 (this
  // device's baseRevision is stale relative to a revision it hadn't
  // captured yet), handled by the existing STALE_OPERATION_REJECTED_EVENT
  // recovery pull below — never a false accept of a stale payload.
  // Gated on `userId` exactly like the pending-op registration below:
  // without a known identity there is no confirmed-state scope to read,
  // and this push stays exactly as unprotected as any pre-SH.2.5.1 write.
  const baseRevision = userId ? getKnownBaseRevision(userId, profileId) : null;

  const payload = buildPayloadFromStorage(profileId, userId);
  if (!payload) return;

  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).length > MAX_SYNC_BYTES) return;

  // SH.2.3 ("persist pending evidence before sending" fix) — every push is
  // tagged with its own clientOpId and, when an identity is known,
  // registered as a pending operation BEFORE fetch() is ever called — not
  // after it resolves (the SH.2.2-era version of this function only
  // registered on a confirmed-non-durable response, which meant a
  // connection drop between the server committing this write and its
  // response arriving lost the evidence entirely: the server has a durable,
  // server-verifiable record of this write via `clientOpId`, but this
  // device would have had no pending-op key to hand a later pull as
  // `lastOpId`, so that record could never be reconciled). Registering
  // unconditionally, before the request is even sent, is what "every
  // network write whose outcome can become uncertain must have durable
  // per-operation evidence BEFORE it can reach the server" (this phase's
  // own target model) requires — exactly mirroring what
  // registerUnloadSync()'s beacon now also does below. `domains` (built
  // from THIS payload, right now) is the per-domain evidence
  // reconcilePendingOperations() later uses to tell this operation's own,
  // now-resolved content apart from a genuine local edit made after it —
  // see buildPendingOpDomains()'s and isPendingOpDomainEvidenceCurrent()'s
  // own docs above/syncPayload.ts.
  //
  // If the response below DOES confirm durably (synchronously, in this
  // same call), the op is retired immediately — see `confirmedDurably`
  // below — rather than left for a later pull to rediscover; if it does
  // not (a malformed/missing revision, a genuine recordConfirmedFact
  // conflict, a non-2xx response, or the fetch itself throwing), the
  // already-durable pending-op record is exactly what lets the next
  // successful pull's reconcilePendingOperations() resolve it conclusively
  // against the server's own state.
  const opId = generateOpId();
  // Codex P1 fix ("pending evidence persistence" round) — "no durable
  // pending evidence → do not send": if addPendingOp() could not durably
  // persist this operation's recovery evidence (a localStorage write
  // failure — quota, private-mode, security error), the PUT is never sent
  // at all. Surfacing this as the SAME "error" status/event the network-
  // failure catch block below already uses keeps the UI from reporting a
  // false idle/synced state; the content itself stays exactly as durable
  // locally as it already was (this function never touched canonical
  // storage), and the NEXT scheduleSync() debounce (triggered by any
  // further edit, or by this same profile's next mount/pull cycle) simply
  // retries once storage pressure clears — no new retry machinery needed.
  if (userId) {
    const registered = addPendingOp(userId, profileId, opId, buildPendingOpDomains(profileId, payload));
    if (!registered) {
      try {
        localStorage.setItem(syncStatusKeyForProfile(profileId), "error");
      } catch {}
      try {
        localStorage.setItem(syncErrorKeyForProfile(profileId), "Local evidence write failed");
      } catch {}
      try {
        window.dispatchEvent(new CustomEvent(SYNC_STATE_CHANGED_EVENT));
      } catch {}
      return;
    }
  }

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
  // SH.2.6 / SH.2.6 P2 follow-up — every completion branch below (including
  // the catch block, reached when the fetch itself throws before any
  // response exists) funnels its UI-facing writes through this SAME
  // shouldPublishPushCompletionStatus() gate. Declared here (before the
  // try block), not inside it, specifically so the catch block below can
  // also reach it. Re-checks `currentPullEpoch` FRESH at each call site
  // (never a value cached before this await, or before an inner one),
  // matching every other "re-check after an awaited boundary" gate in
  // this function.
  //
  // When suppressed, this is a PURE noop — it never attempts to clear
  // "syncing" or touch the status key in any way. See the module doc just
  // above clearStaleSyncingStatus() for why: only the identity/profile-
  // transition boundary (setSyncUserId()/setSyncProfileId()) can safely
  // tell "this push's own untouched leftover" apart from "a different
  // tab's legitimately active sync for the new/current identity" — a
  // superseded push's own completion cannot, and must never guess.
  const applyCompletion = (publish: () => void): void => {
    if (shouldPublishPushCompletionStatus(pushEpoch, currentPullEpoch)) {
      publish();
    }
  };
  try {
    const baseRevisionParam = baseRevision !== null ? `&baseRevision=${baseRevision}` : "";
    const res = await fetch(
      `/api/sync/planner?profileId=${encodeURIComponent(profileId)}&clientOpId=${encodeURIComponent(opId)}${baseRevisionParam}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body,
      }
    );
    if (res.status === 409 && userId) {
      // SH.2.5.1 — a DETERMINISTIC stale-first-delivery rejection (see
      // evaluateOperationBaseRevision's own doc in syncPayload.ts):
      // `user_planner` was never touched, so there is nothing to reconcile
      // against this response, only this op's own now-resolved fate. Retire
      // it immediately rather than treating it as an uncertain transport
      // failure ("error") — the underlying local content this push read
      // from remains completely untouched (this function never writes
      // canonical storage) and the next successful pull's ordinary winner
      // selection reconciles it against whatever the ACTUAL current cloud
      // state is, exactly as it already does for any other unsynced local
      // edit. "unresolved" (not "idle") because this device's local state
      // is genuinely not yet known to match the cloud.
      //
      // This retirement is UNCONDITIONAL on identity currency — it is
      // already correctly scoped to the CAPTURED (userId, profileId), not
      // whichever identity is active now (see this module's "an already-
      // running, origin-scoped operation may finish safely" invariant).
      removePendingOp(userId, profileId, opId);
      // SH.2.6 — the UI-facing status/error writes below are NOT scoped by
      // identity (syncStatusKeyForProfile/syncErrorKeyForProfile are keyed
      // only by profileId — see shouldPublishPushCompletionStatus's own
      // doc), so publish them only while no genuine identity/profile
      // transition has happened since this push captured `pushEpoch`.
      // Suppressing them here is exactly what stops a since-superseded
      // user A's "unresolved" from overwriting a since-signed-in user B's
      // sync-status UI for the same profile slot. A's own stale "syncing"
      // leftover (if any) was already cleared at the transition boundary
      // itself — see setSyncUserId()/setSyncProfileId()'s own doc — never
      // here.
      applyCompletion(() => {
        try {
          localStorage.setItem(syncStatusKeyForProfile(profileId), "unresolved");
        } catch {}
        try {
          localStorage.removeItem(syncErrorKeyForProfile(profileId));
        } catch {}
        try {
          window.dispatchEvent(new CustomEvent(SYNC_STATE_CHANGED_EVENT));
        } catch {}
      });
      // SH.2.5.1 Codex P1 follow-up (problem 2) — retiring the rejected op
      // above is NOT enough on its own: this device's `baseRevision`
      // knowledge is still exactly as stale as it was before this push (the
      // rejection told it "you were wrong", not "here is the truth"). Without
      // a fresh pull, every SUBSEQUENT push/beacon would keep resending the
      // SAME stale baseRevision and keep getting rejected — see
      // STALE_OPERATION_REJECTED_EVENT's own doc above for why this event
      // (rather than pulling directly from this module, which owns no page
      // lifecycle) is what lets the mounted page's EXISTING replacement-pull
      // mechanism (staleRetryTick/staleRetryPendingRef) pick this up, so the
      // recovery pull goes through the SAME winner-selection path that
      // already preserves local edits — never a raw forced overwrite.
      try {
        window.dispatchEvent(
          new CustomEvent<StaleOperationRejectedDetail>(STALE_OPERATION_REJECTED_EVENT, {
            detail: { userId, profileId },
          })
        );
      } catch {}
    } else if (res.ok) {
      // SH.2.6 — lastSyncedAt is a UI-facing datum exactly like status/error
      // (same profile-only key shape — see shouldPublishPushCompletionStatus's
      // own doc), so it is gated the same way: only published while this
      // push's captured identity/profile is still the active one. A push
      // "happened" is true regardless, but recording ITS timestamp as if it
      // were the CURRENTLY active identity's own last-synced moment would be
      // exactly the same stale-completion leak this round closes.
      const identityCurrentAfterFetch = shouldPublishPushCompletionStatus(pushEpoch, currentPullEpoch);
      if (identityCurrentAfterFetch) {
        try {
          localStorage.setItem(lastSyncedKeyForProfile(profileId), new Date().toISOString());
        } catch {}
      }
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
      //
      // SH.2.2 ("fail closed when push confirmation is not durable" round)
      // — HTTP 2xx alone is NOT a fully reconciled local success:
      // `confirmedDurably` tracks whether a confirmed-baseline fact was
      // actually, durably recorded for this exact push. When it wasn't —
      // an unreadable/malformed body, a non-numeric revision, or
      // commitConfirmedBaseline() itself returning false (a genuine
      // recordConfirmedFact conflict) — this push's own opId is registered
      // as pending (see this function's own doc above) and status is set
      // to "unresolved", never "idle": the server DID accept the write,
      // but this device cannot yet prove what it resolved into, so it must
      // not report a fully-synced state until the next pull's
      // reconcilePendingOperations() durably closes that gap.
      let confirmedDurably = false;
      if (userId) {
        try {
          const responseData = (await res.json()) as { revision?: unknown };
          const revision =
            typeof responseData.revision === "number" && Number.isFinite(responseData.revision)
              ? responseData.revision
              : null;
          if (revision !== null) {
            confirmedDurably = await commitConfirmedBaseline(userId, profileId, revision, {
              plans: payload.plans,
              lightning: payload.lightning,
              days: payload.days,
            });
          }
        } catch {
          // Response body unreadable/malformed — cannot safely commit a
          // confirmed baseline without a known revision; confirmedDurably
          // stays false, handled identically to any other non-durable
          // outcome below.
        }
        // SH.2.3 — this op was already registered as pending BEFORE the
        // request was sent (above); retire it now only on PROVEN durable
        // confirmation, never merely because the request returned (see this
        // function's own doc above and reconcilePendingOperations' PULL
        // OUTCOME CONTRACT doc for why "the request returned" and "the
        // outcome is durably known" are deliberately different gates). When
        // it is NOT durable, the already-registered record is left exactly
        // as pending as it always was — no redundant re-registration
        // needed.
        if (confirmedDurably) {
          removePendingOp(userId, profileId, opId);
        }
      }
      // SH.2.6 — re-check identity currency HERE, not reusing
      // `identityCurrentAfterFetch` captured above: the `await res.json()`/
      // `await commitConfirmedBaseline()` calls inside the `if (userId)`
      // block above are ANOTHER awaited boundary this function crossed
      // since that snapshot, during which a fresh transition could have
      // happened. applyCompletion() re-checks `currentPullEpoch` fresh
      // right now, so a transition that happened during THESE inner
      // awaits (not merely the outer fetch) is caught too. Status writes
      // are best-effort; event dispatch MUST always execute when
      // publication is allowed.
      applyCompletion(() => {
        try {
          localStorage.setItem(syncStatusKeyForProfile(profileId), userId && !confirmedDurably ? "unresolved" : "idle");
        } catch {}
        try {
          localStorage.removeItem(syncErrorKeyForProfile(profileId));
        } catch {}
        try {
          window.dispatchEvent(new CustomEvent(SYNC_STATE_CHANGED_EVENT));
        } catch {}
      });
    } else if (res.status !== 401) {
      // Non-401 failure — record error state for the originating profile.
      // SH.2.6 — gated the same way as every other completion write above:
      // an HTTP failure for a since-superseded identity must not overwrite
      // the currently active identity's sync-status UI for this profile.
      applyCompletion(() => {
        try {
          localStorage.setItem(syncStatusKeyForProfile(profileId), "error");
        } catch {}
        try {
          localStorage.setItem(syncErrorKeyForProfile(profileId), `HTTP ${res.status}`);
        } catch {}
        try {
          window.dispatchEvent(new CustomEvent(SYNC_STATE_CHANGED_EVENT));
        } catch {}
      });
    } else {
      // 401 — user not signed in; return originating profile to a clean idle state.
      // Also clear lastError so the profile doesn't show a stale error after sign-out.
      // SH.2.6 — gated identically: a 401 for a since-superseded identity
      // must not force the currently active identity's status back to
      // "idle" out from under it.
      applyCompletion(() => {
        try {
          localStorage.setItem(syncStatusKeyForProfile(profileId), "idle");
        } catch {}
        try {
          localStorage.removeItem(syncErrorKeyForProfile(profileId));
        } catch {}
        try {
          window.dispatchEvent(new CustomEvent(SYNC_STATE_CHANGED_EVENT));
        } catch {}
      });
    }
  } catch {
    // Network error — record error state on the originating profile.
    // SH.2.6 — gated identically: this catch can be entered after any
    // awaited boundary in the try block above (the outer fetch, or the
    // inner res.json()/commitConfirmedBaseline() calls), so identity
    // currency must be re-checked fresh here too, never assumed from an
    // earlier snapshot. `applyCompletion` was declared BEFORE the try
    // block specifically so it is reachable here too, even when the fetch
    // itself throws before any response exists.
    applyCompletion(() => {
      try {
        localStorage.setItem(syncStatusKeyForProfile(profileId), "error");
      } catch {}
      try {
        localStorage.setItem(syncErrorKeyForProfile(profileId), "Network error");
      } catch {}
      try {
        window.dispatchEvent(new CustomEvent(SYNC_STATE_CHANGED_EVENT));
      } catch {}
    });
  } finally {
    inFlight = false;
  }
}

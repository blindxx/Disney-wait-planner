"use client";

import { useEffect } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import {
  ensureActiveProfileVisible,
  shouldReloadForActiveProfileCorrection,
  UNOWNED_ACCOUNT_KEY,
} from "@/lib/profileStorage";
import { getUserId } from "@/lib/syncIdentity";
import { invalidatePendingUnloadSync } from "@/lib/syncHelper";
import {
  reconcileProfileRegistry,
  setRegistryIdentity,
  shouldAttemptRegistryReconciliation,
} from "@/lib/profileRegistrySync";

/**
 * Codex P1 follow-up (12th round) — GLOBAL auth-transition active-profile
 * safety (Codex finding #1). Before this round, `ensureActiveProfileVisible`
 * — the function that validates/corrects the device-local
 * `dwp.activeProfile` pointer against the CURRENT account's effective
 * visible profile list (profileStorage.ts's own doc) — was only ever
 * called from settings/page.tsx's own reconciliation effect. An A -> B
 * authenticated account switch while Plans, Lightning, or Tom was mounted
 * (none of which called it) left `dwp.activeProfile` pointing at A's own,
 * now-hidden profile — B could sync/pull/push under it, or Tom could build
 * planner context from it — until the user happened to visit Settings,
 * whose own effect would only then, finally, correct it.
 *
 * This component is mounted ONCE, inside <SessionProvider>, wrapping every
 * page via the root layout (app/layout.tsx) — the SAME shared, page-
 * independent boundary next-auth's own `useSession()` context is rooted
 * at, and the highest point in the tree from which a session-status change
 * is visible to literally every page, regardless of which one happens to
 * be mounted. Rendering it BEFORE `{children}` in SessionProviderWrapper's
 * JSX means its effect runs before any currently-mounted page's own
 * auth-transition effect in the SAME React commit (effects fire in the
 * order their owning components appear in the tree), so a page that itself
 * reads `dwp.activeProfile`/`getActiveProfileKeys()` as part of handling
 * the identical transition already sees the corrected value.
 *
 * SESSION "loading" — an UNRESOLVED identity state, distinct from BOTH
 * "authenticated" and "unauthenticated" (mirrors settings/page.tsx's own
 * 11th-round fix for the identical distinction in its own reconciliation
 * effect): this effect performs NO correction, infers no identity, and
 * mutates nothing while `sessionStatus === "loading"` — `dwp.activeProfile`
 * is left exactly as it was until the session actually resolves one way or
 * the other. Only a RESOLVED "authenticated" or "unauthenticated" status
 * ever reaches ensureActiveProfileVisible below.
 *
 * Explicit "unauthenticated" retains the existing signed-out local-first
 * semantics unchanged: ensureActiveProfileVisible(UNOWNED_ACCOUNT_KEY) is
 * the SAME call settings/page.tsx's own signed-out branch already makes.
 *
 * `dwp.activeProfile` stays exactly as device-local as before — this
 * component only ever corrects WHAT VALUE it may be pointing at during an
 * identity transition, never where it is stored, who can read it, or the
 * planner-sync/account-namespace storage model itself (unchanged — see
 * AGENTS.md and syncHelper.ts's own module doc).
 *
 * SH.4.1d Codex P1 follow-up — "Retarget mounted pages after correcting the
 * active profile." Correcting `dwp.activeProfile` here is not, by itself,
 * enough: Plans/Lightning/Tom each capture their own profile-scoped refs,
 * localStorage keys, and sync identity (activeProfileIdRef, planKeyRef,
 * daysKeyRef, currentSyncProfileId, …) exactly once, at mount, and have no
 * effect of their own that re-derives them on a LATER transition — so a
 * mounted page's sync/pull/hydration/write path could otherwise go on
 * combining the OLD profile id with identity/provenance now scoped to the
 * corrected profile. A correction forces the SAME full reload every OTHER
 * `dwp.activeProfile` writer in this codebase already performs immediately
 * after changing it (settings/page.tsx's own switch/create/delete
 * handlers) — the one, already-proven-safe mechanism this codebase uses to
 * retarget a mounted page to a corrected profile, applied here at the
 * shared boundary every page mounts under instead of separately inside
 * each page. This is fail-closed: nothing continues running against the
 * stale profile identity past the reload.
 *
 * SH.4 Codex P1 fix — "Initial profile correction." This previously tracked
 * `hasResolvedOnceRef` and skipped the reload on a page's very first
 * resolved transition, on the assumption that no mounted page could have
 * read `dwp.activeProfile` before this guard's own effect ran. That
 * assumption is false: Plans/Lightning/Tom's own mount effects run
 * unconditionally on first render (`[]` deps), regardless of session
 * status, so a child can already have mounted and read the STALE pointer
 * while `sessionStatus` was still "loading" — well before this effect ever
 * ran for a resolved status. shouldReloadForActiveProfileCorrection() now
 * gates on nothing but whether a correction actually happened — see its
 * own doc for the full rationale — so `hasResolvedOnceRef` is removed
 * rather than kept as unused/misleading state.
 */
function ActiveProfileAuthGuard(): null {
  const { data: session, status: sessionStatus } = useSession();
  const authenticatedUserId = sessionStatus === "authenticated" ? getUserId(session) : null;

  useEffect(() => {
    if (sessionStatus === "loading") return;
    const corrected = ensureActiveProfileVisible(authenticatedUserId ?? UNOWNED_ACCOUNT_KEY);
    if (shouldReloadForActiveProfileCorrection(corrected)) {
      // Codex P1 fix — "auth-transition unload-beacon." Must run BEFORE
      // window.location.reload() below, and before any other effect in
      // this same commit (this component renders above {children} — see
      // this component's own doc): an authenticated A -> B transition that
      // requires this correction can have Plans'/Lightning's own
      // auth-transition effect (same commit, running right after this one)
      // retarget currentSyncUserId to B while currentSyncProfileId still
      // names A's own now-corrected-away-from profile, since only this
      // reload re-derives the corrected profile id. Without this call, a
      // beforeunload beacon firing during the reload could tag A's still-
      // profileId-scoped local content with B's already-active session
      // cookie. See invalidatePendingUnloadSync()'s own doc in
      // syncHelper.ts for the full root cause.
      invalidatePendingUnloadSync();
      window.location.reload();
    }
  }, [sessionStatus, authenticatedUserId]);

  return null;
}

/**
 * SH.4.4 Codex P1 fix — GLOBAL account profile registry reconciliation
 * lifecycle. Before this fix, registry reconciliation (profileRegistrySync.ts's
 * setRegistryIdentity/reconcileProfileRegistry) was triggered ONLY from
 * settings/page.tsx's own effect — a legacy local profile belonging to an
 * account that never happened to visit Settings during a session sat
 * unreconciled (and therefore never durably ownership-stamped) for as long
 * as that held, remaining freely adoptable by a DIFFERENT account that
 * signed in on the same device and reconciled first. See
 * profileRegistrySync.ts's own module doc for the full rationale.
 *
 * Mounted here for the SAME reason ActiveProfileAuthGuard above is: this is
 * the shared, page-independent boundary next-auth's own `useSession()`
 * context is rooted at, and the highest point in the tree from which a
 * session-status change is visible to literally every page, regardless of
 * which one happens to be mounted — so every authenticated session
 * resolution attempts a reconciliation round, not just a Settings visit.
 *
 * This component is the PRIMARY owner of the identity binding
 * (setRegistryIdentity) as of this fix — see
 * profileRegistrySync.ts's own doc. It deliberately does NOT reset identity
 * to null in a cleanup function: it is mounted for the lifetime of the
 * whole app/session (it never unmounts on ordinary page navigation, unlike
 * settings/page.tsx, which DID need that on its own unmount when it was the
 * sole owner), so the only event that can legitimately invalidate an
 * in-flight round — an actual identity transition — is already covered by
 * the next call to setRegistryIdentity() with the new value
 * (advanceRegistryIdentity bumps the epoch whenever the identity itself
 * changes, including through null on sign-out).
 *
 * shouldAttemptRegistryReconciliation() is the same pure decision
 * settings/page.tsx's own `if (sessionStatus === "loading") return;` /
 * `if (!authenticatedUserId) { ...; return; }` branching is structurally
 * equivalent to — factored out here as its own tested predicate so this
 * guard's gating logic doesn't silently drift from that structural
 * equivalent. See its own doc in profileRegistrySync.ts.
 */
function ProfileRegistryReconciliationGuard(): null {
  const { data: session, status: sessionStatus } = useSession();
  const authenticatedUserId = sessionStatus === "authenticated" ? getUserId(session) : null;

  useEffect(() => {
    if (sessionStatus === "loading") return;
    setRegistryIdentity(authenticatedUserId);
    if (!shouldAttemptRegistryReconciliation(sessionStatus, authenticatedUserId)) return;
    reconcileProfileRegistry(authenticatedUserId as string);
  }, [sessionStatus, authenticatedUserId]);

  return null;
}

export default function SessionProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider>
      <ActiveProfileAuthGuard />
      <ProfileRegistryReconciliationGuard />
      {children}
    </SessionProvider>
  );
}

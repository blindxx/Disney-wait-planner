"use client";

import { useEffect } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import { ensureActiveProfileVisible, UNOWNED_ACCOUNT_KEY } from "@/lib/profileStorage";
import { getUserId } from "@/lib/syncIdentity";

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
 */
function ActiveProfileAuthGuard(): null {
  const { data: session, status: sessionStatus } = useSession();
  const authenticatedUserId = sessionStatus === "authenticated" ? getUserId(session) : null;

  useEffect(() => {
    if (sessionStatus === "loading") return;
    ensureActiveProfileVisible(authenticatedUserId ?? UNOWNED_ACCOUNT_KEY);
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
      {children}
    </SessionProvider>
  );
}

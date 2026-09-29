"use client";

/**
 * Settings Page — Phase 7.1
 *
 * Stores user defaults for resort and park selection.
 * These defaults act only as fallback initializers on pages
 * that have no existing stored state.
 *
 * localStorage keys:
 *   dw:settings:defaultResort  — "DLR" | "WDW"
 *   dw:settings:defaultPark    — park id string
 */

import { useEffect, useRef, useState } from "react";
import { type ParkId, type ResortId } from "@disney-wait-planner/shared";
import {
  getSettingsDefaults,
  SETTINGS_RESORT_KEY,
  SETTINGS_PARK_KEY,
} from "../../lib/settingsDefaults";
import { useSession, signIn, signOut } from "next-auth/react";
import {
  getSyncStateForProfile,
  SYNC_STATE_CHANGED_EVENT,
  type SyncState,
} from "../../lib/syncHelper";
import {
  type Profile,
  bootstrapProfiles,
  getVisibleProfiles,
  ensureActiveProfileVisible,
  UNOWNED_ACCOUNT_KEY,
  getActiveProfileId,
  setActiveProfileId as setActiveProfileIdInStorage,
  createProfile,
  renameProfile,
  deleteProfile,
  getActiveProfileKeys,
  PROFILE_NAME_CHANGED_EVENT,
  PROFILES_LIST_KEY,
} from "../../lib/profileStorage";
import {
  reconcileProfileRegistry,
  shouldWithholdProfileControls,
  pushNewProfileRegistration,
  getRegistryLastSyncedAt,
  PROFILE_REGISTRY_SYNCED_EVENT,
} from "../../lib/profileRegistrySync";

// ============================================
// CONSTANTS
// ============================================

const RESORT_LABELS: Record<ResortId, string> = {
  DLR: "Disneyland Resort",
  WDW: "Walt Disney World",
};

const RESORT_PARKS: Record<ResortId, { id: ParkId; label: string }[]> = {
  DLR: [
    { id: "disneyland", label: "Disneyland" },
    { id: "dca", label: "California Adventure" },
  ],
  WDW: [
    { id: "mk", label: "Magic Kingdom" },
    { id: "epcot", label: "EPCOT" },
    { id: "hs", label: "Hollywood Studios" },
    { id: "ak", label: "Animal Kingdom" },
  ],
};

// ============================================
// HELPERS
// ============================================

function formatRelativeTime(isoString: string): string {
  const ts = new Date(isoString).getTime();
  if (isNaN(ts)) return "--"; // guard against malformed stored value
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "just now"; // clock skew guard
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
}

const SYNC_STATUS_COLOR: Record<"idle" | "syncing" | "error" | "unresolved", string> = {
  idle: "#6b7280",
  syncing: "#2563eb",
  error: "#dc2626",
  unresolved: "#d97706",
};

const SYNC_STATUS_LABEL: Record<"idle" | "syncing" | "error" | "unresolved", string> = {
  idle: "Idle",
  syncing: "Syncing\u2026",
  error: "Error",
  unresolved: "Confirming\u2026",
};

/** Minimum ms "Syncing…" remains visible — prevents sub-100ms flicker. */
const MIN_SYNC_DISPLAY_MS = 400;

// ============================================
// PAGE COMPONENT
// ============================================

export default function SettingsPage() {
  const [defaultResort, setDefaultResort] = useState<ResortId>("DLR");
  const [defaultPark, setDefaultPark] = useState<ParkId>("disneyland");
  // Prevents a DLR→WDW flip on pages where the stored default differs from
  // the initial useState value. Resort/park buttons only render once ready=true.
  const [ready, setReady] = useState(false);

  // Active session context (dwp.selectedResort / dwp.selectedPark).
  // Either key alone is sufficient; the resolved pair is always coherent.
  // Null when no session context exists; display falls back live to defaults.
  const [sessionResort, setSessionResort] = useState<ResortId | null>(null);
  const [sessionPark, setSessionPark] = useState<ParkId | null>(null);

  // Profiles state
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileIdState] = useState<string>("default");

  // Profile-aware storage key refs — set once on mount after bootstrapProfiles().
  const profileKeysRef = useRef({ selectedResort: "dwp.selectedResort", selectedPark: "dwp.selectedPark" });

  // Account & Sync state
  const { data: session, status: sessionStatus } = useSession();
  // SH.4.1 (Codex P1 finding #1, follow-up round) — the actual resolved
  // identity, not just the auth STATUS string. Mirrors plans/page.tsx's own
  // `authenticatedUserId` (same resolution order as getUserId() in
  // api/sync/planner/route.ts / syncIdentity.ts) so the registry-
  // reconciliation effect below re-runs whenever the SIGNED-IN USER changes
  // — including an A -> B account switch that a next-auth session update
  // could in principle deliver without `sessionStatus` itself ever leaving
  // "authenticated" — not only on the coarser loading/authenticated
  // transitions `sessionStatus` alone would catch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const authenticatedUserId =
    sessionStatus === "authenticated" ? ((session?.user as any)?.id ?? session?.user?.email ?? null) : null;
  // SH.4.1 (Codex P1 follow-up, 4th round) — the account key to scope
  // profile VISIBILITY by (getVisibleProfiles/getLocallyDeletedProfileIds):
  // the real authenticated userId when signed in, or the shared
  // UNOWNED_ACCOUNT_KEY bucket when signed out — mirrors exactly how
  // deleteProfile's own `currentOwnerUserId ?? UNOWNED_ACCOUNT_KEY` already
  // scopes the write side of this same provenance.
  const visibilityOwnerKey = authenticatedUserId ?? UNOWNED_ACCOUNT_KEY;
  // Codex finding — a ref mirror of `visibilityOwnerKey`, kept fresh via the
  // tiny effect below, mirrors the SAME established pattern this codebase
  // already uses for keeping a MOUNT-ONLY (`[]` deps) effect's closure
  // current (e.g. plans/wait-times/page.tsx's own selectedResortRef/
  // selectedParkRef). The PROFILE_NAME_CHANGED_EVENT listener registered in
  // the mount effect below never re-subscribes once auth resolves, so
  // closing over `visibilityOwnerKey` directly would permanently bake in
  // whatever it happened to be at mount — typically UNOWNED_ACCOUNT_KEY,
  // since useSession() starts in "loading" before next-auth's own session
  // fetch resolves (see the 11th-round doc above `authenticatedUserId`'s
  // own definition for the identical timing concern). Reading `.current`
  // instead means the listener always uses whichever owner key is CURRENTLY
  // resolved at the moment a rename event actually fires, never a stale
  // signed-out snapshot from before authentication resolved.
  const visibilityOwnerKeyRef = useRef(visibilityOwnerKey);
  useEffect(() => {
    visibilityOwnerKeyRef.current = visibilityOwnerKey;
  }, [visibilityOwnerKey]);
  const [emailInput, setEmailInput] = useState("");
  const [signInSent, setSignInSent] = useState(false);
  const [signInError, setSignInError] = useState("");
  const [syncState, setSyncState] = useState<SyncState>({
    status: "idle",
    lastSyncedAt: null,
    lastError: null,
  });
  // displayedSyncState is what the UI renders — mirrors syncState but holds
  // "syncing" visible for at least MIN_SYNC_DISPLAY_MS before transitioning.
  const [displayedSyncState, setDisplayedSyncState] = useState<SyncState>({
    status: "idle",
    lastSyncedAt: null,
    lastError: null,
  });
  const syncingStartedAtRef = useRef<number | null>(null);

  // SH.7B — last MEANINGFUL profile-registry change for the active profile
  // (profileRegistrySync.ts's recordRegistrySynced — never a no-op check).
  // Presentation-only and separate from planner syncState above: "Last
  // synced" shows whichever of the two is later, without either engine
  // writing into the other's state.
  const [registryLastSyncedAt, setRegistryLastSyncedAt] = useState<string | null>(null);
  useEffect(() => {
    if (!authenticatedUserId) {
      setRegistryLastSyncedAt(null);
      return;
    }
    const refresh = () => setRegistryLastSyncedAt(getRegistryLastSyncedAt(authenticatedUserId, activeProfileId));
    refresh();
    window.addEventListener(PROFILE_REGISTRY_SYNCED_EVENT, refresh);
    return () => window.removeEventListener(PROFILE_REGISTRY_SYNCED_EVENT, refresh);
  }, [authenticatedUserId, activeProfileId]);
  const displayedLastSyncedAt = [displayedSyncState.lastSyncedAt, registryLastSyncedAt]
    .filter((t): t is string => !!t)
    .sort((x, y) => Date.parse(y) - Date.parse(x))[0] ?? null;

  // Hydrate from localStorage on mount (client-side only).
  useEffect(() => {
    // Bootstrap profiles system — account-agnostic structural setup
    // (guarantees Default exists, migrates legacy keys) that must always
    // run on mount regardless of session status.
    bootstrapProfiles();
    const profileKeys = getActiveProfileKeys();
    profileKeysRef.current = profileKeys;
    // Codex P1 follow-up (11th round) — profiles/activeProfileId are
    // DELIBERATELY NOT populated here anymore. This is a ONE-TIME (`[]`
    // deps) effect, so it would otherwise bake in whatever
    // `visibilityOwnerKey` happened to resolve to on the very FIRST
    // render — typically UNOWNED_ACCOUNT_KEY, since useSession() starts in
    // "loading" before next-auth's own session fetch resolves — and
    // project the signed-out/local-first view (with usable profile
    // controls) before authentication has actually resolved one way or the
    // other. Leaving `profiles` at its initial empty array here means the
    // entire Profiles section (gated on `profiles.length > 0` in the JSX
    // below) simply does not render — no picker, no Add/Rename/Delete
    // controls — until the registry-reconciliation effect below populates
    // it for a DEFINITE, resolved session status (authenticated or
    // explicitly unauthenticated); that effect now explicitly refuses to
    // do anything at all while `sessionStatus === "loading"` — see its own
    // doc.

    const { defaultResort: resort, defaultPark: park } = getSettingsDefaults();
    setDefaultResort(resort);
    setDefaultPark(park);
    // Read active session context from the active profile's namespaced keys.
    // Either key alone is sufficient to establish context; the missing side
    // is derived/validated.
    try {
      const storedResort = localStorage.getItem(profileKeys.selectedResort);
      const storedPark = localStorage.getItem(profileKeys.selectedPark);
      const hasResort = storedResort === "DLR" || storedResort === "WDW";
      // Find which resort owns storedPark, if any.
      const parkResort = storedPark
        ? (Object.entries(RESORT_PARKS) as [ResortId, { id: ParkId; label: string }[]][])
            .find(([, parks]) => parks.some((p) => p.id === storedPark))?.[0] ?? null
        : null;
      const haspark = parkResort !== null;

      if (hasResort || haspark) {
        const resolvedResort: ResortId = hasResort ? (storedResort as ResortId) : parkResort!;
        // Only store the actual stored park key in state — never a derived
        // fallback. The fallback (default park → first park) is computed
        // reactively in render from the live defaultPark so it stays current
        // when the user changes defaults without reloading the page.
        const parkBelongsToResort =
          haspark && RESORT_PARKS[resolvedResort].some((p) => p.id === storedPark);
        setSessionResort(resolvedResort);
        setSessionPark(parkBelongsToResort ? (storedPark as ParkId) : null);
      }
    } catch {}
    setReady(true); // Reveal selectors after correct state is set — prevents flicker.
    // Read sync state for the active profile
    const profileId = getActiveProfileId();
    setSyncState(getSyncStateForProfile(profileId));

    // Listen for same-tab sync state changes (e.g. sync fires while on Settings)
    const handleSyncStateChanged = () => {
      setSyncState(getSyncStateForProfile(profileId));
    };
    window.addEventListener(SYNC_STATE_CHANGED_EVENT, handleSyncStateChanged);
    // Codex finding — a background reconciliation round (e.g. the GLOBAL
    // SessionProviderWrapper guard, not this page's own effect below) can
    // pull a fresher profile name (profileStorage.ts's applyServerRenames)
    // while Settings is already mounted; same-tab localStorage writes never
    // fire the native `storage` event, so without this the picker and the
    // "Syncing profile: X" label would keep showing the stale name — see
    // PROFILE_NAME_CHANGED_EVENT's own doc. Reads visibilityOwnerKeyRef.current
    // (see its own doc above), NOT the closed-over `visibilityOwnerKey`
    // directly — this effect never re-subscribes once auth resolves, so the
    // closed-over value would otherwise permanently bake in whatever was
    // resolved at MOUNT time (typically the signed-out UNOWNED_ACCOUNT_KEY
    // bucket, since useSession() starts in "loading"), refreshing the
    // picker with the WRONG account's visibility for the rest of the page's
    // lifetime even after authentication resolves.
    const handleProfileNameChanged = () => {
      setProfiles(getVisibleProfiles(visibilityOwnerKeyRef.current));
    };
    window.addEventListener(PROFILE_NAME_CHANGED_EVENT, handleProfileNameChanged);
    // Codex finding — the CROSS-TAB half of the same problem: a rename
    // pulled while a DIFFERENT tab on this browser is mounted writes
    // `dwp.profiles` there, which fires the native `storage` event in every
    // OTHER tab (never the tab that wrote it) — see PROFILES_LIST_KEY's own
    // doc. Reuses the identical refresh (and the same
    // visibilityOwnerKeyRef.current freshness fix) as the same-tab listener
    // above rather than duplicating the logic.
    const handleStorage = (e: StorageEvent) => {
      if (e.key === PROFILES_LIST_KEY) handleProfileNameChanged();
    };
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(SYNC_STATE_CHANGED_EVENT, handleSyncStateChanged);
      window.removeEventListener(PROFILE_NAME_CHANGED_EVENT, handleProfileNameChanged);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  // SH.4.1 — account profile registry reconciliation. Deliberately a
  // SEPARATE effect from planner sync (which lives in plans/page.tsx and
  // has its own auth-transition handling): this only reconciles the
  // device-local profile LIST (dwp.profiles) against the durable
  // `user_profiles` registry — legacy local profiles get additively
  // registered, and any account profiles this device hasn't seen yet get
  // additively discovered — never planner content, never
  // `dwp.activeProfile`. See profileRegistrySync.ts for the full contract.
  //
  // SH.4.1 (Codex P1 finding #1) — keyed on `authenticatedUserId` (the
  // resolved identity), not `sessionStatus` alone, so an A -> B account
  // switch always re-runs this effect even in the (rare, but possible with
  // next-auth) case where `sessionStatus` itself never leaves
  // "authenticated".
  //
  // SH.4.4 Codex P1 fix — this effect NO LONGER calls setRegistryIdentity()
  // itself. Registry identity is now bound by the GLOBAL authenticated
  // lifecycle guard in SessionProviderWrapper.tsx (mounted once at the app
  // root, above every page — its effect runs before this one in the same
  // React commit whenever both fire together, per its own doc), which is
  // now the binding's PRIMARY owner — see profileRegistrySync.ts's own
  // module doc for the full rationale (a legacy profile used without ever
  // visiting Settings must still reconcile). This effect only calls
  // reconcileProfileRegistry() below, for a prompt UI refresh while Settings
  // itself is open — it relies on the root-level guard having already bound
  // identity to `authenticatedUserId` by the time this runs.
  //
  // Critically, this effect's cleanup must NOT call setRegistryIdentity(null)
  // any more either: Settings unmounts on ordinary navigation (unlike the
  // root-level guard, which persists for the whole session), and resetting
  // identity to null there would invalidate the root-level guard's own
  // still-authenticated, still-in-flight round out from under it. `cancelled`
  // below exists purely to suppress THIS component's own setProfiles() call
  // after unmount — reconcileProfileRegistry's own internal staleness checks
  // (isRegistryRunCurrent) are unaffected by it.
  //
  // Best-effort and silent: reconcileProfileRegistry() never throws, and a
  // signed-out/loading session simply skips this round.
  //
  // Codex P1 follow-up (5th round) — ensureActiveProfileVisible runs FIRST,
  // synchronously, independent of the async network reconciliation below:
  // it is a purely LOCAL check (does THIS account's effective visible list
  // still contain the currently active profile id?), so it must never be
  // gated on/skipped by a failed or slow network round. This is exactly
  // what stops a stale-for-this-account active id (e.g. account A had it
  // active, then locally deleted it, and a DIFFERENT account B's own
  // unrelated discovery re-added the raw id to the shared `dwp.profiles`
  // list) from continuing to look "valid" to A's own getActiveProfileId()
  // just because the raw list happens to contain it again. React state
  // (`activeProfileId`) is re-synced right after, so the UI and every
  // handler below (handleRenameProfile/handleDeleteProfile, which read the
  // `activeProfileId` state) immediately reflect the corrected value too.
  //
  // Codex P1 follow-up (11th round) — `sessionStatus === "loading"` is an
  // UNRESOLVED identity state, distinct from BOTH "authenticated" and
  // "unauthenticated": it means next-auth has not yet determined whether
  // anyone is signed in at all. Previously this effect derived
  // `authenticatedUserId` as `null` during loading (identical to genuinely
  // signed out — see that value's own derivation above) and branched on
  // `!authenticatedUserId` alone, so it projected the FULL signed-out/
  // UNOWNED local-first view — including making Add/Rename/Delete/switch
  // controls usable (the Profiles section renders once `profiles.length >
  // 0`) — before authentication had actually resolved one way or the
  // other. A user could interact with profile controls scoped to
  // UNOWNED_ACCOUNT_KEY during that brief unresolved window even though
  // they turned out to already be signed in, or vice versa. The guard
  // below makes "loading" a no-op for every LOCAL/DURABLE side effect: no
  // registry identity transition (that binding now lives in
  // SessionProviderWrapper.tsx's own guard — see this effect's own SH.4.4
  // doc above), no ensureActiveProfileVisible call — so `dwp.activeProfile`
  // and every deletion/provenance marker this effect could otherwise touch
  // stay completely untouched while identity is unresolved. Because
  // `authenticatedUserId` is `null` in BOTH the loading and unauthenticated
  // cases, `sessionStatus` itself must be in this effect's dependency
  // array — otherwise a loading -> unauthenticated transition (identical
  // `authenticatedUserId` value on both sides) would never re-run this
  // effect, and the signed-out view would never actually get projected.
  //
  // PR #161 Codex fix — "loading" is NOT a no-op for the `profiles` REACT
  // STATE (rendering only — never localStorage/durable state): it now
  // clears it via shouldWithholdProfileControls(), reusing the SAME
  // `profiles.length > 0` gate the Profiles section already renders behind
  // (see its own doc in profileRegistrySync.ts). This closes a gap the
  // 11th-round fix above only handled at INITIAL mount (where `profiles`
  // starts empty and simply hadn't rendered yet): a LATER transition back
  // into "loading" mid-session (e.g. an account switch/session refetch)
  // previously left `profiles` holding whatever the PREVIOUS resolved
  // identity's list was, so the Profiles section kept rendering it — fully
  // actionable (Add/Rename/Delete/Switch) — against a list/active id no
  // CURRENT session vouches for.
  useEffect(() => {
    if (shouldWithholdProfileControls(sessionStatus)) {
      setProfiles([]);
      return;
    }
    if (!authenticatedUserId) {
      // SH.4.1 Codex P2 follow-up (6th round) — signing out must NOT just
      // invalidate the network identity guard above and stop: without
      // recomputing local state here, Settings would keep showing the
      // PREVIOUS authenticated account's effective profile list/active id
      // (whatever the last authenticated render left in React state) until
      // something else happened to re-render it. This branch is purely
      // local (no fetch/registry network activity while signed out) —
      // `visibilityOwnerKey` already resolves to UNOWNED_ACCOUNT_KEY here
      // since `authenticatedUserId` is null.
      ensureActiveProfileVisible(visibilityOwnerKey);
      setActiveProfileIdState(getActiveProfileId());
      setProfiles(getVisibleProfiles(visibilityOwnerKey));
      return;
    }
    ensureActiveProfileVisible(authenticatedUserId);
    setActiveProfileIdState(getActiveProfileId());
    setProfiles(getVisibleProfiles(authenticatedUserId));
    let cancelled = false;
    reconcileProfileRegistry(authenticatedUserId).then(() => {
      // SH.4.1 (Codex P1 follow-up, 4th round) — re-derive the EFFECTIVE
      // list for `authenticatedUserId` after reconciling, not the raw
      // shared list: reconciliation may have just re-added an id (via
      // adoptServerProfiles) that THIS account has separately, locally
      // deleted — see getVisibleProfiles's own doc.
      if (!cancelled) setProfiles(getVisibleProfiles(authenticatedUserId));
    });
    return () => {
      cancelled = true;
    };
  }, [sessionStatus, authenticatedUserId]);

  // Mediate syncState → displayedSyncState with a minimum "syncing" display time.
  useEffect(() => {
    if (syncState.status === "syncing") {
      // Entering syncing: show immediately and record the start time.
      syncingStartedAtRef.current = Date.now();
      setDisplayedSyncState(syncState);
    } else if (displayedSyncState.status === "syncing") {
      // Leaving syncing: hold the display until MIN_SYNC_DISPLAY_MS has elapsed.
      const elapsed = syncingStartedAtRef.current !== null
        ? Date.now() - syncingStartedAtRef.current
        : MIN_SYNC_DISPLAY_MS;
      const remaining = MIN_SYNC_DISPLAY_MS - elapsed;
      if (remaining <= 0) {
        syncingStartedAtRef.current = null;
        setDisplayedSyncState(syncState);
      } else {
        const next = syncState; // capture for closure
        const t = setTimeout(() => {
          syncingStartedAtRef.current = null;
          setDisplayedSyncState(next);
        }, remaining);
        return () => clearTimeout(t);
      }
    } else {
      // Not a syncing transition — apply immediately (covers error, idle at rest).
      setDisplayedSyncState(syncState);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncState]);

  // Handlers — persist immediately on change.

  function handleResortChange(resort: ResortId) {
    // No-op if already selected — prevents defaultPark from being silently reset
    // to the first park of the resort on an accidental re-click.
    if (resort === defaultResort) return;
    const firstPark = RESORT_PARKS[resort][0].id;
    setDefaultResort(resort);
    setDefaultPark(firstPark);
    try {
      localStorage.setItem(SETTINGS_RESORT_KEY, resort);
      localStorage.setItem(SETTINGS_PARK_KEY, firstPark);
    } catch {}
  }

  function handleParkChange(park: ParkId) {
    setDefaultPark(park);
    try {
      localStorage.setItem(SETTINGS_PARK_KEY, park);
    } catch {}
  }

  function handleProfileSwitch(id: string) {
    setActiveProfileIdInStorage(id);
    setActiveProfileIdState(id);
    // Reload so all pages pick up the new profile's data cleanly
    location.reload();
  }

  // Codex P1 follow-up (12th round) — createProfile/renameProfile/
  // deleteProfile all became async in profileStorage.ts: their
  // `dwp.profiles` read-modify-write is now serialized via the Web Locks
  // API against every other writer of that same key (see profileStorage.ts's
  // own "LOCAL MUTATION SERIALIZATION" section doc), closing a lost-update
  // race against server-profile adoption running concurrently. These
  // handlers simply await the result before continuing — mirrors
  // handleSendSignInLink's own existing async-handler pattern below.
  async function handleAddProfile() {
    const name = window.prompt("New profile name:");
    if (!name || !name.trim()) return;
    // SH.4.1 Codex P1 follow-up (5th round) — scope the deletion-marker
    // clear this create performs to the currently authenticated account
    // (or the shared unowned bucket when signed out), so creating/
    // recreating this id can never clear a DIFFERENT account's own
    // suppression for the same literal id — see createProfile's own doc.
    const profile = await createProfile(name, authenticatedUserId);
    setProfiles(getVisibleProfiles(visibilityOwnerKey));
    // Switch to the newly created profile immediately
    setActiveProfileIdInStorage(profile.id);
    setActiveProfileIdState(profile.id);
    // SH.5 — attempt ONE immediate, awaited registration push before the
    // reload below, rather than relying ENTIRELY on the next page load's
    // own fire-and-forget reconciliation round to ever register this
    // profile server-side — see pushNewProfileRegistration's own doc for
    // why this closes a real single-point-of-failure window. Best-effort:
    // this never throws, and the normal round on the reloaded page still
    // runs afterward and will retry this exact id if this attempt's own
    // request failed.
    if (authenticatedUserId) {
      await pushNewProfileRegistration(profile, authenticatedUserId);
    }
    location.reload();
  }

  async function handleRenameProfile() {
    const current = profiles.find((p) => p.id === activeProfileId);
    if (!current) return;
    const name = window.prompt("Rename profile:", current.name);
    if (!name || !name.trim()) return;
    // Codex account-isolation fix — scope the pending-rename marker this
    // rename records to the CURRENTLY authenticated account (or the shared
    // unowned bucket when signed out), mirroring how handleAddProfile/
    // handleDeleteProfile already scope createProfile/deleteProfile's own
    // provenance writes — see renameProfile's own doc.
    await renameProfile(activeProfileId, name, authenticatedUserId);
    setProfiles(getVisibleProfiles(visibilityOwnerKey));
    // SH.5 — a rename doesn't reload the page (unlike Add/Delete), so
    // nothing else would otherwise trigger a fresh reconciliation round to
    // push it this session. Fire-and-forget, mirrors the SAME pattern
    // ProfileRegistryReconciliationGuard already uses on every session
    // resolution — reconcileProfileRegistry never throws and is safe to
    // call redundantly.
    if (authenticatedUserId) {
      reconcileProfileRegistry(authenticatedUserId);
    }
  }

  async function handleDeleteProfile() {
    if (profiles.length <= 1 || activeProfileId === "default") return;
    const current = profiles.find((p) => p.id === activeProfileId);
    const confirmed = window.confirm(
      `Delete profile "${current?.name ?? activeProfileId}"? All its stored data will be removed.`
    );
    if (!confirmed) return;
    // SH.4.1 Codex P1 follow-up (3rd round) — scope the local-delete/
    // rediscovery-suppression marker to the currently authenticated account
    // (or the shared unowned bucket when signed out), so this delete can
    // never suppress a DIFFERENT account's own, distinct profile under the
    // same grandfathered id on a shared browser — see deleteProfile's own
    // doc in profileStorage.ts.
    await deleteProfile(activeProfileId, authenticatedUserId);
    const remaining = getVisibleProfiles(visibilityOwnerKey);
    setProfiles(remaining);
    setActiveProfileIdState("default");
    location.reload();
  }

  async function handleSendSignInLink() {
    setSignInError("");
    const trimmedEmail = emailInput.trim();
    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      setSignInError("Please enter a valid email address.");
      return;
    }
    const result = await signIn("email", {
      email: trimmedEmail,
      redirect: false,
    });
    if (result?.error) {
      setSignInError("Something went wrong. Please try again.");
    } else {
      setSignInSent(true);
    }
  }

  const parks = RESORT_PARKS[defaultResort];

  // Derive current context display values. Falls back live to the selected
  // defaults when no coherent session context is stored — stays reactive
  // when the user changes defaults without a page reload.
  const contextResort: ResortId = sessionResort ?? defaultResort;
  // sessionPark is only set when an actual stored park key is valid for
  // contextResort. When sessionPark is null (resort-only session or no
  // session), fall back reactively: prefer the default park if it belongs
  // to contextResort, otherwise use the first park in the resort list.
  const contextPark: ParkId = sessionPark ?? (
    RESORT_PARKS[contextResort].some((p) => p.id === defaultPark)
      ? defaultPark
      : RESORT_PARKS[contextResort][0].id
  );
  const contextParkLabel =
    RESORT_PARKS[contextResort]?.find((p) => p.id === contextPark)?.label ?? contextPark;

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "16px" }}>
      {/* Keyframe animation for syncing pulse — scoped, no external CSS needed */}
      <style>{`
        @keyframes dwp-sync-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
        .dwp-syncing { animation: dwp-sync-pulse 1.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .dwp-syncing { animation: none; } }
      `}</style>
      <h1
        style={{
          fontSize: "24px",
          fontWeight: 700,
          color: "#111827",
          marginBottom: "8px",
        }}
      >
        Settings
      </h1>
      <p
        style={{
          fontSize: "14px",
          color: "#6b7280",
          marginBottom: "28px",
          lineHeight: "1.5",
        }}
      >
        These defaults initialize resort and park selection on pages you visit
        for the first time. They never overwrite a selection you have already
        made.
      </p>

      {/* ── Current Park Context (informational, read-only) ── */}
      {ready && (
        <section style={{ marginBottom: "20px" }}>
          <h2
            style={{
              fontSize: "15px",
              fontWeight: 600,
              color: "#374151",
              marginBottom: "4px",
            }}
          >
            Current Park Context
          </h2>
          <p style={{ fontSize: "13px", color: "#6b7280", margin: "0 0 3px" }}>
            <span>Resort: </span>
            <span style={{ color: "#111827", fontWeight: 500 }}>{RESORT_LABELS[contextResort]}</span>
          </p>
          <p style={{ fontSize: "13px", color: "#6b7280", margin: "0 0 8px" }}>
            <span>Park: </span>
            <span style={{ color: "#111827", fontWeight: 500 }}>{contextParkLabel}</span>
          </p>
          <p style={{ fontSize: "12px", color: "#9ca3af", margin: 0, lineHeight: "1.4" }}>
            Current context reflects your active park selection. Defaults apply when no current selection exists or after using Reset.
          </p>
        </section>
      )}

      {/* ── Default Resort + Park ── */}
      {/* Only rendered after hydration to prevent DLR→WDW flip on stored WDW defaults */}
      {ready ? (
        <>
          <section style={{ marginBottom: "28px" }}>
            <h2
              style={{
                fontSize: "15px",
                fontWeight: 600,
                color: "#374151",
                marginBottom: "10px",
              }}
            >
              Default Resort
            </h2>
            <div style={{ display: "flex", gap: "8px" }}>
              {(Object.keys(RESORT_LABELS) as ResortId[]).map((resort) => (
                <button
                  key={resort}
                  onClick={() => handleResortChange(resort)}
                  style={{
                    flex: 1,
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: `1px solid ${defaultResort === resort ? "#1e3a5f" : "#d1d5db"}`,
                    cursor: "pointer",
                    fontWeight: 600,
                    fontSize: "14px",
                    backgroundColor: defaultResort === resort ? "#1e3a5f" : "#f9fafb",
                    color: defaultResort === resort ? "#fff" : "#374151",
                    minHeight: "44px",
                    transition: "background-color 0.15s ease, color 0.15s ease",
                  }}
                >
                  {RESORT_LABELS[resort]}
                </button>
              ))}
            </div>
          </section>

          <section style={{ marginBottom: "28px" }}>
            <h2
              style={{
                fontSize: "15px",
                fontWeight: 600,
                color: "#374151",
                marginBottom: "10px",
              }}
            >
              Default Park
            </h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              {parks.map(({ id: parkId, label }) => (
                <button
                  key={parkId}
                  onClick={() => handleParkChange(parkId)}
                  style={{
                    flex: "1 1 calc(50% - 4px)",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: "none",
                    cursor: "pointer",
                    fontWeight: 600,
                    fontSize: "14px",
                    backgroundColor: defaultPark === parkId ? "#2563eb" : "#f3f4f6",
                    color: defaultPark === parkId ? "#fff" : "#374151",
                    minHeight: "44px",
                    transition: "background-color 0.15s ease, color 0.15s ease",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
        </>
      ) : (
        /* Skeleton placeholders for resort + park buttons while hydrating */
        <>
          <section style={{ marginBottom: "28px" }}>
            <div style={{ height: "21px", width: "100px", borderRadius: 4, backgroundColor: "#f3f4f6", marginBottom: "10px" }} />
            <div style={{ display: "flex", gap: "8px" }}>
              <div style={{ flex: 1, height: 44, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
              <div style={{ flex: 1, height: 44, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
            </div>
          </section>
          <section style={{ marginBottom: "28px" }}>
            <div style={{ height: "21px", width: "80px", borderRadius: 4, backgroundColor: "#f3f4f6", marginBottom: "10px" }} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
              <div style={{ flex: "1 1 calc(50% - 4px)", height: 44, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
              <div style={{ flex: "1 1 calc(50% - 4px)", height: 44, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
            </div>
          </section>
        </>
      )}

      {/* ── Profiles ── */}
      {ready && profiles.length > 0 && (
        <section style={{ marginBottom: "28px" }}>
          <h2
            style={{
              fontSize: "15px",
              fontWeight: 600,
              color: "#374151",
              marginBottom: "10px",
            }}
          >
            Profiles
          </h2>
          <label
            htmlFor="activeProfileSelect"
            style={{ display: "block", fontSize: "13px", color: "#6b7280", marginBottom: "8px" }}
          >
            Active Profile:
          </label>
          <select
            id="activeProfileSelect"
            value={activeProfileId}
            onChange={(e) => handleProfileSwitch(e.target.value)}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid #d1d5db",
              fontSize: "14px",
              minHeight: "44px",
              backgroundColor: "#fff",
              color: "#111827",
              marginBottom: "10px",
              cursor: "pointer",
            }}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button
              onClick={() => void handleAddProfile()}
              style={{
                flex: "1 1 auto",
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: "13px",
                backgroundColor: "#f9fafb",
                color: "#374151",
                minHeight: "44px",
              }}
            >
              Add Profile
            </button>
            <button
              onClick={() => void handleRenameProfile()}
              style={{
                flex: "1 1 auto",
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: "13px",
                backgroundColor: "#f9fafb",
                color: "#374151",
                minHeight: "44px",
              }}
            >
              Rename
            </button>
            <button
              onClick={() => void handleDeleteProfile()}
              disabled={profiles.length <= 1 || activeProfileId === "default"}
              style={{
                flex: "1 1 auto",
                padding: "10px 12px",
                borderRadius: "8px",
                border: `1px solid ${(profiles.length <= 1 || activeProfileId === "default") ? "#e5e7eb" : "#fca5a5"}`,
                cursor: (profiles.length <= 1 || activeProfileId === "default") ? "not-allowed" : "pointer",
                fontWeight: 600,
                fontSize: "13px",
                backgroundColor: "#f9fafb",
                color: (profiles.length <= 1 || activeProfileId === "default") ? "#9ca3af" : "#dc2626",
                minHeight: "44px",
              }}
            >
              Delete
            </button>
          </div>
          <p style={{ fontSize: "12px", color: "#9ca3af", marginTop: "8px" }}>
            Each profile stores separate Plans, Lightning, and park context. Signed-in profile names sync across devices; planner data stays separate for each profile.
          </p>
        </section>
      )}

      {/* ── Account / Sync ── */}
      <section
        style={{
          padding: "16px",
          borderRadius: "8px",
          border: "1px solid #e5e7eb",
          backgroundColor: "#f9fafb",
          marginBottom: "4px",
        }}
      >
        <h2
          style={{
            fontSize: "15px",
            fontWeight: 600,
            color: "#374151",
            marginBottom: "12px",
          }}
        >
          Account &amp; Sync
        </h2>

        {/* Loading skeleton while session resolves */}
        {sessionStatus === "loading" && (
          <div style={{ height: 44, borderRadius: 8, backgroundColor: "#e5e7eb" }} />
        )}

        {/* Signed-out state */}
        {sessionStatus === "unauthenticated" && !signInSent && (
          <div>
            <p style={{ fontSize: "13px", color: "#6b7280", marginBottom: "10px" }}>
              We&apos;ll email you a link to sign in. No password.
            </p>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <input
                type="email"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void handleSendSignInLink(); }}
                placeholder="you@example.com"
                style={{
                  flex: "1 1 180px",
                  padding: "10px 12px",
                  borderRadius: "8px",
                  border: "1px solid #d1d5db",
                  fontSize: "14px",
                  minHeight: "44px",
                  backgroundColor: "#fff",
                  color: "#111827",
                  outline: "none",
                }}
              />
              <button
                onClick={() => void handleSendSignInLink()}
                style={{
                  flex: "0 0 auto",
                  padding: "10px 16px",
                  borderRadius: "8px",
                  border: "none",
                  cursor: "pointer",
                  fontWeight: 600,
                  fontSize: "14px",
                  backgroundColor: "#1e3a5f",
                  color: "#fff",
                  minHeight: "44px",
                  whiteSpace: "nowrap",
                }}
              >
                Send sign-in link
              </button>
            </div>
            {signInError && (
              <p style={{ fontSize: "13px", color: "#dc2626", marginTop: "8px" }}>
                {signInError}
              </p>
            )}
          </div>
        )}

        {/* Email sent confirmation */}
        {sessionStatus === "unauthenticated" && signInSent && (
          <p style={{ fontSize: "14px", color: "#374151" }}>
            Check your inbox — we sent a sign-in link to{" "}
            <strong>{emailInput}</strong>.
          </p>
        )}

        {/* Signed-in state */}
        {sessionStatus === "authenticated" && session?.user && (
          <div>
            <p style={{ fontSize: "14px", color: "#374151", marginBottom: "4px" }}>
              Signed in as <strong>{session.user.email}</strong>
            </p>
            <p style={{ fontSize: "13px", color: "#6b7280", marginBottom: "2px" }}>
              Syncing profile:{" "}
              <strong style={{ color: "#111827" }}>
                {profiles.find((p) => p.id === activeProfileId)?.name ?? activeProfileId}
              </strong>
            </p>

            {/* Sync status row — rendered from displayedSyncState for min-duration stability */}
            <p style={{ fontSize: "13px", color: "#6b7280", marginBottom: "2px" }}>
              Status:{" "}
              <span
                className={displayedSyncState.status === "syncing" ? "dwp-syncing" : undefined}
                style={{ color: SYNC_STATUS_COLOR[displayedSyncState.status], fontWeight: 500 }}
              >
                {SYNC_STATUS_LABEL[displayedSyncState.status]}
              </span>
            </p>
            <p style={{ fontSize: "13px", color: "#6b7280", marginBottom: displayedSyncState.status === "error" ? "4px" : "12px" }}>
              Last synced:{" "}
              {displayedLastSyncedAt ? formatRelativeTime(displayedLastSyncedAt) : "--"}
            </p>

            {/* Error message — persists until next successful sync */}
            {displayedSyncState.status === "error" && (
              <p style={{ fontSize: "13px", color: "#dc2626", marginBottom: "12px" }}>
                Last sync failed
                {displayedSyncState.lastError ? ` (${displayedSyncState.lastError})` : ""}.
                {" "}Changes are stored locally.
              </p>
            )}

            <button
              onClick={() => { setSignInSent(false); void signOut({ redirect: false }); }}
              style={{
                padding: "10px 16px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: "14px",
                backgroundColor: "#f9fafb",
                color: "#374151",
                minHeight: "44px",
              }}
            >
              Sign out
            </button>
          </div>
        )}

        {/* Signed-out sync status note */}
        {sessionStatus === "unauthenticated" && (
          <p style={{ fontSize: "12px", color: "#9ca3af", marginTop: "8px", marginBottom: "0" }}>
            Not signed in — local-only mode. Sign in above to enable cloud sync.
          </p>
        )}
      </section>

      {/* ── Reset Current Selection ── */}
      <section style={{ marginTop: "20px" }}>
        <h2
          style={{
            fontSize: "15px",
            fontWeight: 600,
            color: "#374151",
            marginBottom: "6px",
          }}
        >
          Reset Current Selection
        </h2>
        <p style={{ fontSize: "13px", color: "#6b7280", marginBottom: "12px" }}>
          Clears your current resort &amp; park selection so Settings defaults
          apply again on your next visit.
        </p>
        <button
          onClick={() => {
            try {
              localStorage.removeItem(profileKeysRef.current.selectedResort);
              localStorage.removeItem(profileKeysRef.current.selectedPark);
            } catch {}
            location.reload();
          }}
          style={{
            padding: "10px 16px",
            borderRadius: "8px",
            border: "1px solid #d1d5db",
            cursor: "pointer",
            fontWeight: 600,
            fontSize: "14px",
            backgroundColor: "#f9fafb",
            color: "#374151",
            minHeight: "44px",
          }}
        >
          Reset resort &amp; park to defaults
        </button>
      </section>
    </div>
  );
}

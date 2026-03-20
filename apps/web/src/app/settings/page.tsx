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
  getProfiles,
  getActiveProfileId,
  setActiveProfileId as setActiveProfileIdInStorage,
  createProfile,
  renameProfile,
  deleteProfile,
  getActiveProfileKeys,
} from "../../lib/profileStorage";

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

const SYNC_STATUS_COLOR: Record<"idle" | "syncing" | "error", string> = {
  idle: "#6b7280",
  syncing: "#2563eb",
  error: "#dc2626",
};

const SYNC_STATUS_LABEL: Record<"idle" | "syncing" | "error", string> = {
  idle: "Idle",
  syncing: "Syncing\u2026",
  error: "Error",
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

  // Hydrate from localStorage on mount (client-side only).
  useEffect(() => {
    // Bootstrap profiles system and load profile state
    bootstrapProfiles();
    const profileKeys = getActiveProfileKeys();
    profileKeysRef.current = profileKeys;
    setProfiles(getProfiles());
    setActiveProfileIdState(getActiveProfileId());

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
    return () => {
      window.removeEventListener(SYNC_STATE_CHANGED_EVENT, handleSyncStateChanged);
    };
  }, []);

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

  function handleAddProfile() {
    const name = window.prompt("New profile name:");
    if (!name || !name.trim()) return;
    const profile = createProfile(name);
    setProfiles(getProfiles());
    // Switch to the newly created profile immediately
    setActiveProfileIdInStorage(profile.id);
    setActiveProfileIdState(profile.id);
    location.reload();
  }

  function handleRenameProfile() {
    if (activeProfileId === "default") return;
    const current = profiles.find((p) => p.id === activeProfileId);
    if (!current) return;
    const name = window.prompt("Rename profile:", current.name);
    if (!name || !name.trim()) return;
    renameProfile(activeProfileId, name);
    setProfiles(getProfiles());
  }

  function handleDeleteProfile() {
    if (profiles.length <= 1 || activeProfileId === "default") return;
    const current = profiles.find((p) => p.id === activeProfileId);
    const confirmed = window.confirm(
      `Delete profile "${current?.name ?? activeProfileId}"? All its stored data will be removed.`
    );
    if (!confirmed) return;
    deleteProfile(activeProfileId);
    const remaining = getProfiles();
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
              onClick={handleAddProfile}
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
              onClick={handleRenameProfile}
              disabled={activeProfileId === "default"}
              style={{
                flex: "1 1 auto",
                padding: "10px 12px",
                borderRadius: "8px",
                border: `1px solid ${activeProfileId === "default" ? "#e5e7eb" : "#d1d5db"}`,
                cursor: activeProfileId === "default" ? "not-allowed" : "pointer",
                fontWeight: 600,
                fontSize: "13px",
                backgroundColor: "#f9fafb",
                color: activeProfileId === "default" ? "#9ca3af" : "#374151",
                minHeight: "44px",
              }}
            >
              Rename
            </button>
            <button
              onClick={handleDeleteProfile}
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
            Each profile stores separate Plans, Lightning, and park context. Profiles are local to this device.
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
              {displayedSyncState.lastSyncedAt
                ? formatRelativeTime(displayedSyncState.lastSyncedAt)
                : "--"}
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

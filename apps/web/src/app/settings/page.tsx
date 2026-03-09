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

import { useEffect, useState } from "react";
import { type ParkId, type ResortId } from "@disney-wait-planner/shared";
import {
  getSettingsDefaults,
  SETTINGS_RESORT_KEY,
  SETTINGS_PARK_KEY,
} from "../../lib/settingsDefaults";
import { useSession, signIn, signOut } from "next-auth/react";
import { LAST_SYNCED_KEY } from "../../lib/syncHelper";

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

  // Account & Sync state
  const { data: session, status: sessionStatus } = useSession();
  const [emailInput, setEmailInput] = useState("");
  const [signInSent, setSignInSent] = useState(false);
  const [signInError, setSignInError] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  // Hydrate from localStorage on mount (client-side only).
  useEffect(() => {
    const { defaultResort: resort, defaultPark: park } = getSettingsDefaults();
    setDefaultResort(resort);
    setDefaultPark(park);
    // Read active session context using the same normalization as the rest of
    // the app (matches Plans' readSessionContext logic). Either key alone is
    // sufficient to establish context; the missing side is derived/validated.
    try {
      const storedResort = localStorage.getItem("dwp.selectedResort");
      const storedPark = localStorage.getItem("dwp.selectedPark");
      const hasResort = storedResort === "DLR" || storedResort === "WDW";
      // Find which resort owns storedPark, if any.
      const parkResort = storedPark
        ? (Object.entries(RESORT_PARKS) as [ResortId, { id: ParkId; label: string }[]][])
            .find(([, parks]) => parks.some((p) => p.id === storedPark))?.[0] ?? null
        : null;
      const haspark = parkResort !== null;

      if (hasResort || haspark) {
        const resolvedResort: ResortId = hasResort ? (storedResort as ResortId) : parkResort!;
        // Validate park against the resolved resort to prevent cross-resort mismatch.
        const parkBelongsToResort =
          haspark && RESORT_PARKS[resolvedResort].some((p) => p.id === storedPark);
        const resolvedPark: ParkId = parkBelongsToResort
          ? (storedPark as ParkId)
          // Prefer the current/default park if valid for the resolved resort.
          // This matches the resolution order used elsewhere in the app when
          // the park key is absent but the resort key exists.
          : RESORT_PARKS[resolvedResort].some((p) => p.id === park)
            ? park
            : RESORT_PARKS[resolvedResort][0].id;
        setSessionResort(resolvedResort);
        setSessionPark(resolvedPark);
      }
    } catch {}
    setReady(true); // Reveal selectors after correct state is set — prevents flicker.
    // Read last sync time
    try {
      setLastSyncedAt(localStorage.getItem(LAST_SYNCED_KEY));
    } catch {}
  }, []);

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
  const contextPark: ParkId = sessionPark ?? defaultPark;
  const contextParkLabel =
    RESORT_PARKS[contextResort]?.find((p) => p.id === contextPark)?.label ?? contextPark;

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "16px" }}>
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
          <p style={{ fontSize: "13px", color: "#6b7280", margin: "0 0 1px" }}>
            Resort: {RESORT_LABELS[contextResort]}
          </p>
          <p style={{ fontSize: "13px", color: "#6b7280", margin: 0 }}>
            Park: {contextParkLabel}
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
            <p style={{ fontSize: "13px", color: "#6b7280", marginBottom: "12px" }}>
              {lastSyncedAt
                ? `Last synced: ${new Date(lastSyncedAt).toLocaleString()}`
                : "Never synced"}
              {" · "}Auto-sync: On
            </p>
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
              localStorage.removeItem("dwp.selectedResort");
              localStorage.removeItem("dwp.selectedPark");
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

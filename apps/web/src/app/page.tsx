"use client";

/**
 * Today (Home) Page — Phase 2.2 Visual Priority Cues
 *
 * Displays at-a-glance "best options right now" for the selected park.
 * Shows lowest wait times for operating attractions only.
 * Down/Closed attractions are filtered out of the best options list.
 *
 * Mobile-first design:
 *   - Park selector (2 big buttons)
 *   - Current time indicator
 *   - 5 best options with visual priority cues (short list, minimal scrolling)
 *   - Primary action: "View all wait times"
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { type AttractionWait, type ParkId, type ResortId } from "@disney-wait-planner/shared";
import { getWaitDataset, LIVE_ENABLED } from "../lib/liveWaitApi";
import { getWaitTextColor } from "../lib/waitBadge";
import { getSettingsDefaults, SETTINGS_RESORT_KEY, SETTINGS_PARK_KEY } from "../lib/settingsDefaults";
import { bootstrapProfiles, getActiveProfileKeys, getActiveProfile } from "../lib/profileStorage";

// ============================================
// CONSTANTS
// ============================================

/** Shared resort key with Lightning + Plans pages for consistent persistence. */
const STORAGE_RESORT_KEY = "dwp.selectedResort";
/** Shared park key with Wait Times for consistent persistence. */
const STORAGE_PARK_KEY = "dwp.selectedPark";

const RESORT_LABELS: Record<ResortId, string> = {
  DLR: "Disneyland Resort",
  WDW: "Walt Disney World",
};

/** Parks per resort with friendly display names. */
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


const BEST_OPTIONS_COUNT = 5;

// ============================================
// RESPONSIVE CSS
// ============================================

const RESPONSIVE_CSS = `
  /* Page container */
  .today-page {
    max-width: 600px;
    margin: 0 auto;
    padding: 16px;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  /* Park selector buttons */
  .park-selector {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }

  .park-btn {
    flex: 1;
    padding: 12px 16px;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    font-weight: 600;
    font-size: 16px;
    line-height: 1.2;
    text-align: center;
    transition: background-color 0.15s ease, color 0.15s ease;
    min-height: 48px;
  }

  /* Best options list */
  .options-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 20px;
  }

  .option-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    background-color: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    min-height: 72px;
    position: relative;
  }

  .option-item-top {
    border-color: #bfdbfe;
    background-color: #f0f7ff;
  }

  /* Top pick badge */
  .top-pick-badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #1d4ed8;
    background-color: #dbeafe;
    padding: 2px 8px;
    border-radius: 4px;
    line-height: 1.4;
    margin-bottom: 4px;
  }

  /* Wait time block */
  .wait-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    min-width: 56px;
  }

  .wait-number {
    font-size: 32px;
    font-weight: 800;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  .wait-label {
    font-size: 11px;
    color: #6b7280;
    margin-top: 2px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  /* Primary button */
  .primary-btn {
    display: block;
    width: 100%;
    padding: 16px 24px;
    border-radius: 8px;
    border: none;
    background-color: #2563eb;
    color: #fff;
    font-weight: 600;
    font-size: 16px;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
    transition: background-color 0.15s ease;
    min-height: 56px;
    margin-top: auto;
  }

  .primary-btn:hover {
    background-color: #1d4ed8;
  }

  @media (min-width: 768px) {
    .today-page {
      padding: 24px;
    }
  }
`;

// ============================================
// MAIN PAGE COMPONENT
// ============================================

export default function TodayPage() {
  const [selectedResort, setSelectedResort] = useState<ResortId>("DLR");
  const [selectedPark, setSelectedPark] = useState<ParkId>("disneyland");
  // Tracks whether localStorage hydration has completed.
  // Resort/park selectors are only rendered after ready=true to avoid a
  // visible "DLR → WDW" flip on pages with a stored WDW selection.
  const [ready, setReady] = useState(false);
  // Mirror of dw:settings:* keys, kept in sync so isAlreadyDefault is reactive.
  const [settingsResort, setSettingsResort] = useState<ResortId>("DLR");
  const [settingsPark, setSettingsPark] = useState<ParkId>("disneyland");
  const [currentTime, setCurrentTime] = useState("");
  const [attractions, setAttractions] = useState<AttractionWait[]>([]);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [dataSource, setDataSource] = useState<"live" | "mock">("mock");
  const [activeProfileName, setActiveProfileName] = useState<string | null>(null);

  // Profile-aware storage key refs — set once on mount after bootstrapProfiles().
  const resortKeyRef = useRef(STORAGE_RESORT_KEY);
  const parkKeyRef = useRef(STORAGE_PARK_KEY);

  // Refs for the latest resort+park so refreshData stays stable.
  const selectedResortRef = useRef(selectedResort);
  const selectedParkRef = useRef(selectedPark);
  useEffect(() => { selectedResortRef.current = selectedResort; }, [selectedResort]);
  useEffect(() => { selectedParkRef.current = selectedPark; }, [selectedPark]);

  // Hydrate resort + park from localStorage on mount (shared context with Wait Times).
  // If page-specific stored values are absent, fall back to Settings defaults.
  // Never writes to localStorage during initialization (Phase 7.1.1 rule).
  // Sets ready=true at the end so selectors render with the correct state (no flicker).
  useEffect(() => {
    bootstrapProfiles();
    const profileKeys = getActiveProfileKeys();
    resortKeyRef.current = profileKeys.selectedResort;
    parkKeyRef.current = profileKeys.selectedPark;
    setActiveProfileName(getActiveProfile().name);

    try {
      const { defaultResort, defaultPark } = getSettingsDefaults();
      // Mirror settings defaults into state for reactive isAlreadyDefault checks.
      setSettingsResort(defaultResort);
      setSettingsPark(defaultPark);

      const storedResort = localStorage.getItem(resortKeyRef.current);
      const resort: ResortId =
        storedResort === "DLR" || storedResort === "WDW"
          ? storedResort
          : defaultResort;
      setSelectedResort(resort);

      const validParkIds = RESORT_PARKS[resort].map((p) => p.id) as string[];
      const storedPark = localStorage.getItem(parkKeyRef.current);
      if (storedPark && validParkIds.includes(storedPark)) {
        setSelectedPark(storedPark as ParkId);
      } else {
        setSelectedPark(
          validParkIds.includes(defaultPark)
            ? (defaultPark as ParkId)
            : RESORT_PARKS[resort][0].id
        );
      }
    } catch {}
    setReady(true); // Reveal selectors only after state is correct — prevents flicker.
  }, []);

  // When resort changes, switch park to first park of that resort and persist both.
  // Persistence is explicit here (user-initiated) — NOT in a useEffect —
  // so initialization never auto-writes the default to localStorage.
  function handleResortChange(resort: ResortId) {
    if (resort === selectedResort) return;
    const firstPark = RESORT_PARKS[resort][0].id;
    setSelectedResort(resort);
    setSelectedPark(firstPark);
    try {
      localStorage.setItem(resortKeyRef.current, resort);
      localStorage.setItem(parkKeyRef.current, firstPark);
    } catch {}
  }

  // Update current time every minute
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const hours = now.getHours();
      const minutes = now.getMinutes();
      const ampm = hours >= 12 ? "PM" : "AM";
      const displayHours = hours % 12 || 12;
      const displayMinutes = minutes.toString().padStart(2, "0");
      setCurrentTime(`${displayHours}:${displayMinutes} ${ampm}`);
    };

    updateTime();
    const interval = setInterval(updateTime, 60000); // Update every minute
    return () => clearInterval(interval);
  }, []);

  // Fetch wait data for the selected resort+park on mount and on change.
  useEffect(() => {
    let cancelled = false;
    getWaitDataset({ resortId: selectedResort, parkId: selectedPark }).then(
      ({ data, dataSource: ds, lastUpdated: lu }) => {
        if (!cancelled) {
          setAttractions(data);
          setDataSource(ds);
          setLastUpdated(lu);
        }
      },
    );
    return () => { cancelled = true; };
  }, [selectedResort, selectedPark]);

  // Silent refresh — reads current resort+park from refs.
  const refreshData = useCallback(() => {
    getWaitDataset({ resortId: selectedResortRef.current, parkId: selectedParkRef.current }).then(
      ({ data, dataSource: ds, lastUpdated: lu }) => {
        setAttractions(data);
        setDataSource(ds);
        setLastUpdated(lu);
      },
    );
  }, []); // stable — resort+park read from refs

  // Phase 6.3 — Tab focus refresh (primary trigger).
  // Fires once when the user returns to this tab; TTL cache in getWaitDataset
  // ensures no redundant network request if data is still fresh.
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") {
        refreshData();
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [refreshData]);

  // Phase 6.3 — Guarded 120 s interval (secondary trigger).
  // Only active when live mode is on; skips tick if tab is hidden.
  useEffect(() => {
    if (!LIVE_ENABLED) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") {
        refreshData();
      }
    }, 120_000);
    return () => clearInterval(id);
  }, [refreshData]);

  // Get best options: lowest wait times for selected park.
  // Excludes Down/Closed attractions — only OPERATING with a valid wait time.
  // If fewer than BEST_OPTIONS_COUNT qualify, show fewer (no backfill).
  const bestOptions = useMemo(() => {
    return attractions
      .filter((a) => a.status === "OPERATING")
      .filter((a) => a.waitMins != null)
      .sort((a, b) => (a.waitMins ?? 999) - (b.waitMins ?? 999))
      .slice(0, BEST_OPTIONS_COUNT);
  }, [attractions]);

  return (
    <>
      <style>{RESPONSIVE_CSS}</style>

      <div className="today-page">
        {/* Page Title */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "8px" }}>
          <h1 style={{ fontSize: "28px", fontWeight: 700, color: "#111827", margin: 0 }}>
            Today
          </h1>
          {activeProfileName && (
            <span style={{ fontSize: "12px", color: "#9ca3af" }}>
              Profile: {activeProfileName}
            </span>
          )}
        </div>

        {/* Current Time */}
        <div
          style={{
            fontSize: "15px",
            color: "#6b7280",
            marginBottom: "20px",
          }}
        >
          Now: {currentTime}
        </div>

        {/* Resort + Park Selectors — only rendered after hydration to prevent
            a visible DLR→WDW flip when the stored selection differs from the
            server-safe default. Placeholder preserves layout height. */}
        {ready ? (
          <>
            {/* Resort Selector */}
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              {(Object.keys(RESORT_LABELS) as ResortId[]).map((resort) => (
                <button
                  key={resort}
                  onClick={() => handleResortChange(resort)}
                  style={{
                    flex: 1,
                    padding: "8px 6px",
                    borderRadius: 8,
                    border: `1px solid ${selectedResort === resort ? "#1e3a5f" : "#d1d5db"}`,
                    cursor: "pointer",
                    fontWeight: 600,
                    fontSize: 13,
                    backgroundColor: selectedResort === resort ? "#1e3a5f" : "#f9fafb",
                    color: selectedResort === resort ? "#fff" : "#374151",
                    minHeight: 36,
                  }}
                >
                  {RESORT_LABELS[resort]}
                </button>
              ))}
            </div>

            {/* Park Selector */}
            <div className="park-selector">
              {RESORT_PARKS[selectedResort].map(({ id: parkId, label }) => (
                <button
                  key={parkId}
                  className="park-btn"
                  onClick={() => {
                    setSelectedPark(parkId);
                    try {
                      localStorage.setItem(parkKeyRef.current, parkId);
                      localStorage.setItem(resortKeyRef.current, selectedResort);
                    } catch {}
                  }}
                  style={{
                    backgroundColor: selectedPark === parkId ? "#2563eb" : "#f3f4f6",
                    color: selectedPark === parkId ? "#fff" : "#374151",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Set as default shortcut / "Default" label */}
            {selectedResort === settingsResort && selectedPark === settingsPark ? (
              <span
                style={{
                  display: "block",
                  padding: "4px 0",
                  marginBottom: "12px",
                  fontSize: "12px",
                  color: "#9ca3af",
                }}
              >
                Default
              </span>
            ) : (
              <button
                onClick={() => {
                  try {
                    localStorage.setItem(SETTINGS_RESORT_KEY, selectedResort);
                    localStorage.setItem(SETTINGS_PARK_KEY, selectedPark);
                    setSettingsResort(selectedResort);
                    setSettingsPark(selectedPark);
                  } catch {}
                }}
                style={{
                  background: "none",
                  border: "none",
                  padding: "4px 0",
                  marginBottom: "12px",
                  fontSize: "12px",
                  color: "#6b7280",
                  cursor: "pointer",
                  textDecoration: "underline",
                  display: "block",
                }}
              >
                Set as default
              </button>
            )}
          </>
        ) : (
          /* Skeleton placeholders preserve layout while hydration runs */
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <div style={{ flex: 1, height: 36, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
              <div style={{ flex: 1, height: 36, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
              <div style={{ flex: 1, height: 32, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
              <div style={{ flex: 1, height: 32, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
            </div>
            <div style={{ height: 24, marginBottom: "12px" }} />
          </>
        )}

        {/* Section Header */}
        <h2
          style={{
            fontSize: "18px",
            fontWeight: 600,
            color: "#111827",
            marginBottom: "12px",
          }}
        >
          Best options right now
        </h2>

        {/* Best Options List */}
        <div className="options-list">
          {bestOptions.map((attraction, index) => {
            const isTopPick = index === 0;
            // Color code wait time — thresholds centralized in waitBadge.ts
            const waitColor = getWaitTextColor(attraction.waitMins ?? 0);

            return (
              <div
                key={attraction.id}
                className={`option-item${isTopPick ? " option-item-top" : ""}`}
              >
                {/* Left: Name + Land + Badge */}
                <div style={{ flex: "1 1 0%", minWidth: 0 }}>
                  {isTopPick && (
                    <div>
                      <span className="top-pick-badge">Top pick</span>
                    </div>
                  )}
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: "15px",
                      lineHeight: "1.3",
                      color: "#111827",
                      wordWrap: "break-word",
                    }}
                  >
                    {attraction.name}
                  </div>
                  {attraction.land && (
                    <div
                      style={{
                        fontSize: "12px",
                        color: "#9ca3af",
                        marginTop: "2px",
                        lineHeight: "1.3",
                      }}
                    >
                      {attraction.land}
                    </div>
                  )}
                </div>

                {/* Right: Wait Time (most prominent) */}
                <div className="wait-block">
                  <div className="wait-number" style={{ color: waitColor }}>
                    {attraction.waitMins}
                  </div>
                  <div className="wait-label">min</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Primary Action Button */}
        <Link href="/wait-times" className="primary-btn">
          View all wait times
        </Link>

        {/* Last-updated trust affordance */}
        <div
          style={{
            marginTop: "12px",
            fontSize: "12px",
            color: "#9ca3af",
            textAlign: "right",
          }}
        >
          {dataSource === "live" ? "Live" : "Mock"} &bull; Updated{" "}
          {lastUpdated != null
            ? new Date(lastUpdated).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })
            : "\u2014"}
        </div>
      </div>
    </>
  );
}

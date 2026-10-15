"use client";

/**
 * Today (Home) Page — Phase 2.2 Visual Priority Cues
 *
 * Displays at-a-glance "best options right now" for the selected park.
 * Shows lowest wait times for operating attractions only.
 * Down/Closed attractions are filtered out of the best options list.
 *
 * Phase 12.10 — compact daily park overview for the selected park:
 *   park hours (/api/park-hours), lowest + highest 5 operating waits (same
 *   Queue-Times dataset), and the next 3 upcoming Entertainment performances
 *   (/api/entertainment/showtimes). Rankings/show selection live in
 *   lib/todayDashboard.ts; hours/showtimes interpretation stays in
 *   parkHours.ts / entertainmentShowtimes.ts.
 *
 * Mobile-first design:
 *   - Park selector (2 big buttons)
 *   - Current time indicator + today's park hours
 *   - Best options / Longest waits / Next up (short lists, minimal scrolling)
 *   - Primary action: "View Waits & Shows"
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { type AttractionWait, type ParkId, type ResortId } from "@disney-wait-planner/shared";
import { getWaitDataset, LIVE_ENABLED } from "../lib/liveWaitApi";
import { getWaitTextColor } from "../lib/waitBadge";
import ResortClock from "../components/ResortClock";
import ParkHoursLine from "../components/ParkHoursLine";
import ThemeParksAttribution from "../components/ThemeParksAttribution";
import {
  describeParkHours,
  parkHoursForDisplay,
  resolveParkHoursResponse,
  type ParkHours,
} from "../lib/parkHours";
import {
  PARTIAL_SHOWTIMES_NOTE,
  resolveShowtimesResponse,
  showtimesForDisplay,
  type ParkEntertainmentShowtimes,
} from "../lib/entertainmentShowtimes";
import { getResortLocalDate } from "../lib/resortTime";
import { getEntertainmentForPark } from "../lib/entertainmentSuggestions";
import { rankHighestWaits, rankLowestWaits, selectNextShows } from "../lib/todayDashboard";
import { getSettingsDefaults, SETTINGS_RESORT_KEY, SETTINGS_PARK_KEY } from "../lib/settingsDefaults";
import {
  bootstrapProfiles,
  getActiveProfileKeys,
  getActiveProfile,
  PROFILE_NAME_CHANGED_EVENT,
  PROFILES_LIST_KEY,
} from "../lib/profileStorage";

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


// ============================================
// RESPONSIVE CSS
// ============================================

const RESPONSIVE_CSS = `
  /* Page container */
  .today-page {
    max-width: 600px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
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

  /* 4-park resorts (WDW): 2x2 grid on mobile, single row from tablet up.
     Equal-width cells keep sizing consistent and labels fully readable. */
  .park-selector-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-auto-rows: 1fr; /* both rows equal height even if a label wraps */
  }
  .park-selector-grid .park-btn {
    padding: 10px 6px;
    font-size: 14px;
    overflow-wrap: anywhere;
  }
  @media (min-width: 768px) {
    .park-selector-grid {
      display: flex;
    }
    .park-selector-grid .park-btn {
      padding: 12px 16px;
      font-size: 16px;
    }
  }

  /* Best options list */
  .options-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
  }

  .option-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    background-color: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    min-height: 56px;
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
    font-size: 28px;
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

  .today-section-title {
    font-size: 17px;
    font-weight: 600;
    color: #111827;
    margin: 0 0 8px;
  }

  .today-empty {
    font-size: 14px;
    color: #6b7280;
    padding: 4px 0 12px;
  }

  .show-item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    background-color: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
  }

  /* Dashboard sections stack on mobile; two columns on desktop. */
  .today-grid {
    display: grid;
    grid-template-columns: 1fr;
    column-gap: 20px;
  }

  @media (min-width: 768px) {
    .today-page {
      padding: 24px;
    }
  }

  @media (min-width: 900px) {
    .today-page {
      max-width: 960px;
    }
    .today-grid {
      grid-template-columns: 1fr 1fr;
    }
    .today-grid-full {
      grid-column: 1 / -1;
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
  const [attractions, setAttractions] = useState<AttractionWait[]>([]);
  // Park the stored attractions belong to; data from another park is never rendered.
  const [attractionsPark, setAttractionsPark] = useState<ParkId | null>(null);
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
  // This effect only reads resort/park from localStorage; any writes during init are
  // limited to bootstrapProfiles() (e.g., initializing/migrating profile keys).
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

  // Codex finding — a background reconciliation round (e.g. the GLOBAL
  // SessionProviderWrapper guard) can pull a fresher profile name
  // (profileStorage.ts's applyServerRenames) while this page is already
  // mounted; same-tab localStorage writes never fire the native `storage`
  // event, so without this the "Profile: X" label above would keep
  // showing the stale name until a reload/remount — see
  // PROFILE_NAME_CHANGED_EVENT's own doc. Also covers the CROSS-TAB half of
  // the same problem: a rename pulled while a DIFFERENT tab on this browser
  // is mounted writes `dwp.profiles` there, which fires the native
  // `storage` event in every OTHER tab (never the tab that wrote it) — see
  // PROFILES_LIST_KEY's own doc. Both listeners perform the identical
  // refresh, so they're co-located in one effect rather than duplicated.
  useEffect(() => {
    function handleProfileNameChanged() {
      setActiveProfileName(getActiveProfile().name);
    }
    function handleStorage(e: StorageEvent) {
      if (e.key === PROFILES_LIST_KEY) handleProfileNameChanged();
    }
    window.addEventListener(PROFILE_NAME_CHANGED_EVENT, handleProfileNameChanged);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(PROFILE_NAME_CHANGED_EVENT, handleProfileNameChanged);
      window.removeEventListener("storage", handleStorage);
    };
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

  // Latest-request-wins for Queue-Times data: every load (park change, tab
  // focus, interval) takes a token and only the newest may commit, so a slow
  // response for a previously selected park can never overwrite current data.
  // Responses are additionally checked against the park they were requested for.
  const waitsTokenRef = useRef(0);
  const loadWaits = useCallback((resortId: ResortId, parkId: ParkId) => {
    const token = ++waitsTokenRef.current;
    getWaitDataset({ resortId, parkId }).then(
      ({ data, dataSource: ds, lastUpdated: lu }) => {
        if (token !== waitsTokenRef.current) return;
        if (selectedResortRef.current !== resortId || selectedParkRef.current !== parkId) return;
        setAttractions(data);
        setAttractionsPark(parkId);
        setDataSource(ds);
        setLastUpdated(lu);
      },
    );
  }, []);

  // Fetch wait data for the selected resort+park on mount and on change.
  useEffect(() => {
    loadWaits(selectedResort, selectedPark);
    return () => { waitsTokenRef.current++; }; // invalidate in-flight on change/unmount
  }, [selectedResort, selectedPark, loadWaits]);

  // Silent refresh — reads current resort+park from refs.
  const refreshData = useCallback(() => {
    loadWaits(selectedResortRef.current, selectedParkRef.current);
  }, [loadWaits]); // stable — resort+park read from refs

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

  // Ranked lists (lib/todayDashboard.ts): OPERATING with a valid wait only.
  // If fewer than 5 (or 10) qualify, lists are shorter and may overlap (no backfill).
  const parkAttractions = attractionsPark === selectedPark ? attractions : [];
  const waitsLoaded = attractionsPark === selectedPark;
  const bestOptions = useMemo(() => rankLowestWaits(parkAttractions), [parkAttractions]);
  const longestWaits = useMemo(() => rankHighestWaits(parkAttractions), [parkAttractions]);

  // Display clock (15 s, same cadence as ResortClock): re-evaluates passed
  // performances and the resort-local date. Display-only — never fetches.
  const [displayNow, setDisplayNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setDisplayNow(new Date());
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    tick();
    const id = setInterval(() => { if (document.visibilityState === "visible") tick(); }, 15_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  // Resort-local date: crossing midnight changes it, which refetches schedule data once.
  const resortToday = getResortLocalDate(selectedResort, displayNow);

  // Schedule data (ThemeParks.wiki via DWP routes). Each request is
  // latest-request-wins (token) and dropped on park/day change (cancelled);
  // failure degrades to "unavailable" and never keeps previous data.
  const [showtimesRaw, setShowtimes] = useState<ParkEntertainmentShowtimes | null>(null);
  const [parkHoursRaw, setParkHours] = useState<ParkHours | null>(null);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let latestShowtimes = 0;
    let latestHours = 0;
    const parkId = selectedPark;
    const loadShowtimes = () => {
      const token = ++latestShowtimes;
      fetch(`/api/entertainment/showtimes?parkId=${encodeURIComponent(parkId)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((body) => { if (!cancelled && token === latestShowtimes) setShowtimes(resolveShowtimesResponse(parkId, body)); });
    };
    const loadHours = () => {
      const token = ++latestHours;
      fetch(`/api/park-hours?parkId=${encodeURIComponent(parkId)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((body) => { if (!cancelled && token === latestHours) setParkHours(resolveParkHoursResponse(parkId, body)); });
    };
    const loadAll = () => { loadShowtimes(); loadHours(); };
    setShowtimes(null);
    setParkHours(null);
    loadAll();
    const onVisible = () => { if (document.visibilityState === "visible") loadAll(); };
    document.addEventListener("visibilitychange", onVisible);
    const id = setInterval(() => { if (document.visibilityState === "visible") loadAll(); }, 120_000);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, selectedPark, resortToday]);

  // Never show data retained from another park or a previous resort-local day.
  const showtimesCurrent = showtimesForDisplay(showtimesRaw, displayNow);
  const showtimes = showtimesCurrent && showtimesCurrent.parkId === selectedPark ? showtimesCurrent : null;
  const parkHoursCurrent = parkHoursForDisplay(parkHoursRaw, displayNow);
  const parkHours = parkHoursCurrent && parkHoursCurrent.parkId === selectedPark ? parkHoursCurrent : null;
  const nextShows = selectNextShows(showtimes, displayNow);
  const landByShow = useMemo(
    () => new Map(getEntertainmentForPark(selectedPark).map((p) => [p.name, p.land])),
    [selectedPark],
  );
  const parkHoursPresented = !!parkHours && describeParkHours(parkHours).presentsProviderData;
  const themeParksPresented = parkHoursPresented || nextShows.presentsProviderData;

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

        {/* Resort-local clock — shared with Wait Times. Mounted after
            hydration so the stored resort (not the DLR default) sets the zone;
            placeholder preserves layout height. */}
        {ready ? (
          <ResortClock resort={selectedResort} marginBottom={20} />
        ) : (
          <div style={{ height: 35, marginBottom: 20 }} />
        )}

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
            <div className={`park-selector${RESORT_PARKS[selectedResort].length > 2 ? " park-selector-grid" : ""}`}>
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

        {/* Today's park hours (selected park, resort-local today) */}
        {ready && <ParkHoursLine data={parkHours} />}

        <div className="today-grid">
        <section>
        <h2 className="today-section-title">Shortest Waits Right Now</h2>

        {/* Best Options List */}
        <div className="options-list">
          {waitsLoaded && bestOptions.length === 0 && (
            <div className="today-empty">No operating wait times right now.</div>
          )}
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
        </section>

        <section>
        <h2 className="today-section-title">Longest Waits Right Now</h2>
        <div className="options-list">
          {waitsLoaded && longestWaits.length === 0 && (
            <div className="today-empty">No operating wait times right now.</div>
          )}
          {longestWaits.map((attraction) => (
            <div key={attraction.id} className="option-item">
              <div style={{ flex: "1 1 0%", minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "15px", lineHeight: "1.3", color: "#111827", wordWrap: "break-word" }}>
                  {attraction.name}
                </div>
                {attraction.land && (
                  <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "2px", lineHeight: "1.3" }}>
                    {attraction.land}
                  </div>
                )}
              </div>
              <div className="wait-block">
                <div className="wait-number" style={{ color: getWaitTextColor(attraction.waitMins ?? 0) }}>
                  {attraction.waitMins}
                </div>
                <div className="wait-label">min</div>
              </div>
            </div>
          ))}
        </div>
        </section>

        <section className="today-grid-full">
        <h2 className="today-section-title">Next up: Entertainment</h2>
        <div className="options-list">
          {nextShows.state === "loading" && <div className="today-empty" aria-hidden style={{ minHeight: 20 }} />}
          {nextShows.state === "upcoming" &&
            nextShows.performances.map((p) => (
              <div key={`${p.dwpName}|${p.startMs}`} className="show-item">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: "15px", lineHeight: "1.3", color: "#111827", wordWrap: "break-word" }}>
                    {p.dwpName}
                  </div>
                  {landByShow.get(p.dwpName) && (
                    <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "2px", lineHeight: "1.3" }}>
                      {landByShow.get(p.dwpName)}
                    </div>
                  )}
                </div>
                <div style={{ fontWeight: 700, fontSize: "16px", color: "#374151", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                  {p.localTime}
                </div>
              </div>
            ))}
          {nextShows.state === "upcoming" && nextShows.partial && (
            <div style={{ fontSize: "12px", color: "#9ca3af" }}>
              {PARTIAL_SHOWTIMES_NOTE}
              {nextShows.stale && " (may be outdated)"}
            </div>
          )}
          {nextShows.state === "upcoming" && !nextShows.partial && nextShows.stale && (
            <div style={{ fontSize: "12px", color: "#9ca3af" }}>Showtimes may be out of date</div>
          )}
          {nextShows.state === "none_remaining" && (
            <div className="today-empty">
              No more showtimes today
              {nextShows.stale && <span title="Showtimes may be out of date"> (may be outdated)</span>}
            </div>
          )}
          {nextShows.state === "unavailable" && <div className="today-empty">Showtimes unavailable</div>}
        </div>
        </section>
        </div>

        {/* Primary Action Button */}
        <Link href="/wait-times" className="primary-btn">
          View Waits & Shows
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

        {/* ThemeParks.wiki attribution — owed whenever its park hours or showtimes are presented */}
        {themeParksPresented && (
          <div style={{ marginTop: "6px", fontSize: "12px", color: "#9ca3af", textAlign: "right" }}>
            {parkHoursPresented && nextShows.presentsProviderData ? "Park hours and showtimes" : parkHoursPresented ? "Park hours" : "Showtimes"} powered by{" "}
            <ThemeParksAttribution
              linkOnly
              style={{ fontSize: "inherit", color: "#6b7280", opacity: 1, textDecoration: "underline" }}
            />
          </div>
        )}
      </div>
    </>
  );
}

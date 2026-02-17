"use client";

/**
 * Wait Times Page
 * Displays current attraction wait times for Disneyland Resort (DLR) and
 * Walt Disney World (WDW) parks.
 * Allows filtering by resort, park, operating status, land, and sorting.
 *
 * Responsive layout:
 *   Mobile  — full-width stacked card list
 *   Tablet  — 2-column grid of cards
 *   Desktop — 3-column grid, wider container, tighter density
 */

import { useEffect, useMemo, useState } from "react";
import {
  type AttractionWait,
  type ParkId,
  type ResortId,
} from "@disney-wait-planner/shared";
import { getWaitDataset, LIVE_ENABLED } from "../../lib/liveWaitApi";
import {
  PLANNED_CLOSURES,
  getClosureTiming,
} from "@/lib/plannedClosures";

// ============================================
// SHOW TYPE
// ============================================

type Show = {
  id: string;
  name: string;
  parkId: ParkId;
  land?: string;
  times: string[];
};

// ============================================
// MOCK SHOWS DATA
// ============================================

const MOCK_SHOWS: Show[] = [
  // ---- DLR: Disneyland Park ----
  {
    id: "fantasmic",
    name: "Fantasmic!",
    parkId: "disneyland",
    land: "New Orleans Square",
    times: ["9:00 PM"],
  },
  {
    id: "magic-happens",
    name: "Magic Happens Parade",
    parkId: "disneyland",
    land: "Main Street, U.S.A.",
    times: ["11:00 AM", "3:00 PM"],
  },
  {
    id: "msep",
    name: "Main Street Electrical Parade",
    parkId: "disneyland",
    land: "Main Street, U.S.A.",
    times: ["7:45 PM", "9:45 PM"],
  },
  {
    id: "royal-cavalcade",
    name: "Royal Princess Cavalcade",
    parkId: "disneyland",
    land: "Fantasyland",
    times: ["10:30 AM", "1:30 PM", "4:30 PM"],
  },
  // ---- DLR: Disney California Adventure ----
  {
    id: "together-forever",
    name: "Together Forever \u2014 A Pixar Nighttime Spectacular",
    parkId: "dca",
    land: "Paradise Gardens Park",
    times: ["9:00 PM"],
  },
  {
    id: "pixar-pals",
    name: "Better Together: A Pixar Pals Celebration!",
    parkId: "dca",
    land: "Hollywood Land",
    times: ["11:30 AM", "2:30 PM", "5:00 PM"],
  },
  // ---- WDW: Magic Kingdom ----
  {
    id: "mk-festival-of-fantasy",
    name: "Festival of Fantasy Parade",
    parkId: "mk",
    land: "Main Street, U.S.A.",
    times: ["3:00 PM"],
  },
  {
    id: "mk-happily-ever-after",
    name: "Happily Ever After",
    parkId: "mk",
    land: "Main Street, U.S.A.",
    times: ["9:00 PM"],
  },
  // ---- WDW: Hollywood Studios ----
  {
    id: "hs-fantasmic",
    name: "Fantasmic!",
    parkId: "hs",
    land: "Hollywood Hills Amphitheater",
    times: ["9:30 PM"],
  },
  // ---- WDW: Animal Kingdom ----
  {
    id: "ak-finding-nemo",
    name: "Finding Nemo: The Big Blue... and Beyond!",
    parkId: "ak",
    land: "Discovery Island",
    times: ["11:00 AM", "1:30 PM", "4:00 PM"],
  },
];

// PLANNED_CLOSURES is the single source of truth for refurbishment data.
// Imported from @/lib/plannedClosures — no local duplication.

// ============================================
// RESORT + PARK CONSTANTS
// ============================================

/** Parks grouped by resort */
const RESORT_PARKS: Record<ResortId, ParkId[]> = {
  DLR: ["disneyland", "dca"],
  WDW: ["mk", "epcot", "hs", "ak"],
};

/** Short label for each resort toggle button */
const RESORT_LABELS: Record<ResortId, string> = {
  DLR: "Disneyland Resort",
  WDW: "Walt Disney World",
};

/** Short tab labels that fit on narrow screens */
const PARK_TAB_LABELS: Record<ParkId, string> = {
  disneyland: "Disneyland",
  dca: "California Adventure",
  mk: "Magic Kingdom",
  epcot: "EPCOT",
  hs: "Hollywood Studios",
  ak: "Animal Kingdom",
};

/** Available sort options */
type SortOption = "wait-desc" | "name-asc";

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "wait-desc", label: "Wait (Longest)" },
  { value: "name-asc", label: "Name (A-Z)" },
];

// ============================================
// PERSISTENCE HELPERS
// ============================================

const STORAGE_RESORT_KEY = "dwp.selectedResort";
const STORAGE_PARK_KEY = "dwp.selectedPark";

/** Read and validate resort from localStorage. Returns "DLR" on missing/invalid. */
function loadStoredResort(): ResortId {
  try {
    const v = localStorage.getItem(STORAGE_RESORT_KEY);
    if (v === "DLR" || v === "WDW") return v;
  } catch {}
  return "DLR";
}

/**
 * Read and validate park from localStorage for the given resort.
 * Falls back to first park in the resort if missing or no longer valid.
 */
function loadStoredPark(resort: ResortId): ParkId {
  try {
    const v = localStorage.getItem(STORAGE_PARK_KEY);
    if (v && (RESORT_PARKS[resort] as string[]).includes(v)) return v as ParkId;
  } catch {}
  return RESORT_PARKS[resort][0];
}

// ============================================
// RESPONSIVE CSS
// ============================================

/**
 * All responsive styles live here so media queries can override properly.
 * Inline styles have higher specificity than class selectors, so any
 * property that changes across breakpoints MUST be in CSS only.
 */
const RESPONSIVE_CSS = `
  /* ---- Animations ---- */
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .skeleton-pulse {
    animation: pulse 1.5s ease-in-out infinite;
  }

  /* ---- Page container ---- */
  .wait-page {
    max-width: 800px;
    margin: 0 auto;
    padding: 16px;
    overflow-x: hidden;
  }

  /* ---- Resort toggle buttons ---- */
  .resort-tab {
    flex: 1 1 0%;
    padding: 8px 6px;
    border-radius: 8px;
    border: 1px solid #d1d5db;
    cursor: pointer;
    font-weight: 600;
    font-size: 13px;
    line-height: 1.2;
    text-align: center;
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }

  /* ---- Park tab buttons ---- */
  .park-tab {
    flex: 1 1 0%;
    padding: 10px 8px;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    font-weight: 600;
    font-size: 14px;
    line-height: 1.2;
    text-align: center;
    transition: background-color 0.15s ease, color 0.15s ease;
  }

  /* ---- Grid container — mobile: bordered list ---- */
  .wait-grid {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    overflow: hidden;
  }

  /* ---- Card — mobile: stacked rows ---- */
  .wait-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    min-height: 56px;
    border-bottom: 1px solid #e5e7eb;
    background-color: #fff;
  }
  .wait-card:last-child {
    border-bottom: none;
  }

  /* ---- Empty state ---- */
  .wait-empty {
    padding: 48px 20px;
    text-align: center;
    color: #6b7280;
    font-size: 15px;
    background-color: #fff;
  }

  /* ============================================
     Tablet — 768px+  (2-column grid)
     ============================================ */
  @media (min-width: 768px) {
    .wait-page {
      padding: 20px;
    }

    .resort-tab {
      flex: 0 1 auto;
      padding: 8px 16px;
    }

    .park-tab {
      flex: 0 1 auto;
      padding: 10px 20px;
    }

    .wait-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      border: none;
      border-radius: 0;
      overflow: visible;
    }

    .wait-card {
      border: 1px solid #e5e7eb;
      border-radius: 8px;
    }
    .wait-card:last-child {
      border: 1px solid #e5e7eb;
    }

    .wait-empty {
      grid-column: 1 / -1;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
    }
  }

  /* ============================================
     Desktop — 1024px+  (3-column grid, wider)
     ============================================ */
  @media (min-width: 1024px) {
    .wait-page {
      max-width: 1100px;
      padding: 24px;
    }

    .wait-grid {
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }

    .wait-card {
      padding: 10px 14px;
      min-height: 52px;
    }
  }
`;

// ============================================
// HELPER COMPONENTS
// ============================================

/**
 * WaitBadge — single element conveying both status and wait time.
 * Color-coded by wait length for at-a-glance readability.
 */
function WaitBadge({ attraction }: { attraction: AttractionWait }) {
  let label: string;
  let bg: string;
  let color: string;

  if (attraction.status === "DOWN") {
    label = "Down";
    bg = "#fef3c7";
    color = "#92400e";
  } else if (attraction.status === "CLOSED") {
    label = "Closed";
    bg = "#f3f4f6";
    color = "#6b7280";
  } else if (attraction.waitMins == null) {
    label = "\u2014";
    bg = "#f3f4f6";
    color = "#6b7280";
  } else {
    const mins = attraction.waitMins;
    label = `${mins} min`;
    if (mins <= 20) {
      bg = "#dcfce7";
      color = "#166534";
    } else if (mins <= 45) {
      bg = "#fef9c3";
      color = "#854d0e";
    } else {
      bg = "#fee2e2";
      color = "#991b1b";
    }
  }

  return (
    <span
      style={{
        display: "inline-block",
        padding: "4px 10px",
        borderRadius: "6px",
        fontSize: "14px",
        fontWeight: 600,
        lineHeight: "1.2",
        whiteSpace: "nowrap",
        flexShrink: 0,
        backgroundColor: bg,
        color,
      }}
    >
      {label}
    </span>
  );
}

/**
 * AttractionCard — responsive attraction display.
 * Layout and spacing adapt via .wait-card CSS class.
 */
function AttractionCard({ attraction }: { attraction: AttractionWait }) {
  return (
    <div className="wait-card">
      {/* Left: name + land */}
      <div style={{ flex: "1 1 0%", minWidth: 0 }}>
        <div
          style={{
            fontWeight: 600,
            fontSize: "15px",
            lineHeight: "1.3",
            color: "#111827",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical" as const,
            overflow: "hidden",
          }}
        >
          {attraction.name}
        </div>
        {attraction.land && (
          <div
            style={{
              fontSize: "13px",
              lineHeight: "1.3",
              color: "#6b7280",
              marginTop: "2px",
            }}
          >
            {attraction.land}
          </div>
        )}
      </div>

      {/* Right: wait badge */}
      <WaitBadge attraction={attraction} />
    </div>
  );
}

/**
 * SkeletonCard — placeholder shown while switching parks.
 * Uses .wait-card class so skeletons match the responsive grid.
 */
function SkeletonCard() {
  return (
    <div className="wait-card">
      <div style={{ flex: "1 1 0%", minWidth: 0 }}>
        <div
          className="skeleton-pulse"
          style={{
            height: "14px",
            width: "65%",
            borderRadius: "4px",
            backgroundColor: "#e5e7eb",
          }}
        />
        <div
          className="skeleton-pulse"
          style={{
            height: "12px",
            width: "40%",
            borderRadius: "4px",
            backgroundColor: "#f3f4f6",
            marginTop: "6px",
          }}
        />
      </div>
      <div
        className="skeleton-pulse"
        style={{
          height: "26px",
          width: "58px",
          borderRadius: "6px",
          backgroundColor: "#e5e7eb",
          flexShrink: 0,
        }}
      />
    </div>
  );
}

// ============================================
// MAIN PAGE COMPONENT
// ============================================

export default function WaitTimesPage() {
  // State for resort, park, filter, and sort
  // Initial values are server-safe defaults; localStorage hydration runs in useEffect.
  const [selectedResort, setSelectedResort] = useState<ResortId>("DLR");
  const [selectedPark, setSelectedPark] = useState<ParkId>("disneyland");
  const [operatingOnly, setOperatingOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>("wait-desc");
  const [selectedLand, setSelectedLand] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  /** Attraction data for the current resort+park (live or mock). */
  const [attractions, setAttractions] = useState<AttractionWait[]>([]);

  // Hydrate resort + park from localStorage on client mount (runs once).
  useEffect(() => {
    const resort = loadStoredResort();
    const park = loadStoredPark(resort);
    setSelectedResort(resort);
    setSelectedPark(park);
  }, []);

  // Persist resort whenever it changes.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_RESORT_KEY, selectedResort); } catch {}
  }, [selectedResort]);

  // Persist park whenever it changes.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_PARK_KEY, selectedPark); } catch {}
  }, [selectedPark]);

  /** Handle resort change — reset park to first in new resort and clear land filter */
  function handleResortChange(resort: ResortId) {
    setSelectedResort(resort);
    setSelectedPark(RESORT_PARKS[resort][0]);
    setSelectedLand("");
  }

  // Fetch wait data when resort or park changes.
  // Uses getWaitDataset which returns live data (if enabled + reachable) or
  // falls back to mock — no crashes, same shape either way.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    getWaitDataset({ resortId: selectedResort, parkId: selectedPark }).then(
      ({ data }) => {
        if (!cancelled) {
          setAttractions(data);
          setIsLoading(false);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [selectedResort, selectedPark]);

  /** Parks available for the currently selected resort */
  const resortParks = RESORT_PARKS[selectedResort];

  /** Unique sorted land names for the selected park (derived from loaded data). */
  const availableLands = useMemo(() => {
    const lands = attractions.map((a) => a.land).filter((l): l is string => !!l);
    return [...new Set(lands)].sort();
  }, [attractions]);

  /**
   * Filter and sort attractions based on current settings.
   * Scoped strictly to selectedResort — no cross-resort data can appear.
   */
  const filteredAttractions = useMemo(() => {
    // attractions is already scoped to selectedResort+selectedPark by getWaitDataset
    let results = attractions.slice();

    if (operatingOnly) {
      results = results.filter((a) => a.status === "OPERATING");
    }

    if (selectedLand) {
      results = results.filter((a) => a.land === selectedLand);
    }

    results.sort((a, b) => {
      if (sortBy === "wait-desc") {
        const waitA = a.waitMins ?? -1;
        const waitB = b.waitMins ?? -1;
        return waitB - waitA;
      } else {
        return a.name.localeCompare(b.name);
      }
    });

    return results;
  }, [attractions, operatingOnly, selectedLand, sortBy]);

  return (
    <>
      {/* Responsive styles — must be CSS (not inline) for media queries */}
      <style>{RESPONSIVE_CSS}</style>

      <div className="wait-page">
        {/* Page Header */}
        <h1
          style={{
            fontSize: "22px",
            fontWeight: 700,
            color: "#111827",
            marginBottom: "16px",
          }}
        >
          Wait Times
        </h1>

        {/* Resort Toggle — DLR | WDW */}
        <div
          style={{
            display: "flex",
            gap: "8px",
            marginBottom: "10px",
          }}
        >
          {(Object.keys(RESORT_LABELS) as ResortId[]).map((resortId) => (
            <button
              key={resortId}
              className="resort-tab"
              onClick={() => handleResortChange(resortId)}
              style={{
                backgroundColor:
                  selectedResort === resortId ? "#1e3a5f" : "#f9fafb",
                color: selectedResort === resortId ? "#fff" : "#374151",
                borderColor:
                  selectedResort === resortId ? "#1e3a5f" : "#d1d5db",
              }}
            >
              {RESORT_LABELS[resortId]}
            </button>
          ))}
        </div>

        {/* Park Tabs — scoped to selected resort */}
        <div
          style={{
            display: "flex",
            gap: "8px",
            marginBottom: "12px",
          }}
        >
          {resortParks.map((parkId) => (
            <button
              key={parkId}
              className="park-tab"
              onClick={() => { setSelectedPark(parkId); setSelectedLand(""); }}
              style={{
                backgroundColor:
                  selectedPark === parkId ? "#2563eb" : "#f3f4f6",
                color: selectedPark === parkId ? "#fff" : "#374151",
              }}
            >
              {PARK_TAB_LABELS[parkId]}
            </button>
          ))}
        </div>

        {/* Controls Row: Filter + Sort — wraps on narrow screens */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "10px",
            marginBottom: "12px",
            padding: "10px 12px",
            backgroundColor: "#f9fafb",
            borderRadius: "8px",
          }}
        >
          {/* Operating Only Toggle */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              cursor: "pointer",
              fontSize: "14px",
              color: "#374151",
              minHeight: "32px",
            }}
          >
            <input
              type="checkbox"
              checked={operatingOnly}
              onChange={(e) => setOperatingOnly(e.target.checked)}
              style={{ width: "18px", height: "18px", cursor: "pointer" }}
            />
            Operating only
          </label>

          {/* Land Filter */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "13px", color: "#6b7280" }}>Land:</span>
            <select
              value={selectedLand}
              onChange={(e) => setSelectedLand(e.target.value)}
              style={{
                padding: "6px 10px",
                borderRadius: "6px",
                border: "1px solid #d1d5db",
                backgroundColor: "#fff",
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              <option value="">All Lands</option>
              {availableLands.map((land) => (
                <option key={land} value={land}>
                  {land}
                </option>
              ))}
            </select>
          </div>

          {/* Spacer pushes sort to the right when room allows */}
          <div style={{ flex: "1 1 0%", minWidth: "8px" }} />

          {/* Sort Dropdown */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "13px", color: "#6b7280" }}>Sort:</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              style={{
                padding: "6px 10px",
                borderRadius: "6px",
                border: "1px solid #d1d5db",
                backgroundColor: "#fff",
                fontSize: "14px",
                cursor: "pointer",
              }}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Attractions Grid / List */}
        <div className="wait-grid">
          {isLoading ? (
            Array.from({ length: 9 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))
          ) : filteredAttractions.length === 0 ? (
            <div className="wait-empty">
              No attractions match your filters.
            </div>
          ) : (
            filteredAttractions.map((attraction) => (
              <AttractionCard key={attraction.id} attraction={attraction} />
            ))
          )}
        </div>

        {/* Results Summary */}
        {!isLoading && (
          <div
            style={{
              marginTop: "10px",
              fontSize: "13px",
              color: "#9ca3af",
              textAlign: "center",
            }}
          >
            Showing {filteredAttractions.length} attraction
            {filteredAttractions.length !== 1 ? "s" : ""}
          </div>
        )}

        {/* ---- Entertainment (Shows) ---- */}
        {(() => {
          const shows = MOCK_SHOWS.filter(
            (s) =>
              s.parkId === selectedPark &&
              (!selectedLand || s.land === selectedLand)
          );
          if (shows.length === 0) return null;
          return (
            <div style={{ marginTop: "20px" }}>
              <h2
                style={{
                  fontSize: "16px",
                  fontWeight: 700,
                  color: "#111827",
                  marginBottom: "10px",
                }}
              >
                Entertainment
              </h2>
              <div
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: "8px",
                  overflow: "hidden",
                }}
              >
                {shows.map((show) => (
                  <div
                    key={show.id}
                    style={{
                      padding: "12px 16px",
                      borderBottom: "1px solid #e5e7eb",
                      backgroundColor: "#fff",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: "15px",
                        color: "#111827",
                        lineHeight: "1.3",
                      }}
                    >
                      {show.name}
                    </div>
                    {show.land && (
                      <div
                        style={{
                          fontSize: "13px",
                          color: "#6b7280",
                          marginTop: "2px",
                        }}
                      >
                        {show.land}
                      </div>
                    )}
                    <div
                      style={{
                        marginTop: "6px",
                        fontSize: "13px",
                        color: "#374151",
                        lineHeight: "1.5",
                        wordBreak: "break-word",
                      }}
                    >
                      {show.times.length === 1 ? (
                        <span>Next: {show.times[0]}</span>
                      ) : (
                        <span style={{ color: "#6b7280" }}>Today: {show.times.join(" \u2022 ")}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* ---- Planned Closures (Refurbishments) ---- */}
        {(() => {
          const now = new Date();
          const refurbs = Array.from(PLANNED_CLOSURES.entries()).filter(
            ([, entry]) =>
              entry.parkId === selectedPark &&
              (!selectedLand || entry.land === selectedLand) &&
              getClosureTiming(entry.dateRange, now) !== "ENDED",
          );
          if (refurbs.length === 0) return null;
          return (
            <div style={{ marginTop: "20px" }}>
              <h2
                style={{
                  fontSize: "16px",
                  fontWeight: 700,
                  color: "#111827",
                  marginBottom: "10px",
                }}
              >
                Planned Closures
              </h2>
              <div
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: "8px",
                  overflow: "hidden",
                }}
              >
                {refurbs.map(([key, entry]) => (
                  <div
                    key={key}
                    style={{
                      padding: "12px 16px",
                      borderBottom: "1px solid #e5e7eb",
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: "0 8px",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: "15px",
                        color: "#111827",
                        lineHeight: "1.3",
                        flex: "1 1 auto",
                        order: 1,
                      }}
                    >
                      {entry.name}
                    </div>
                    {entry.land && (
                      <div
                        style={{
                          fontSize: "13px",
                          color: "#6b7280",
                          marginTop: "2px",
                          flex: "0 0 100%",
                          order: 3,
                        }}
                      >
                        {entry.land}
                      </div>
                    )}
                    {entry.displayDateRange && (
                      <div
                        style={{
                          fontSize: "12px",
                          color: "#6b7280",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          backgroundColor: "#f3f4f6",
                          border: "1px solid #e5e7eb",
                          whiteSpace: "nowrap",
                          flex: "0 0 auto",
                          order: 2,
                        }}
                      >
                        {entry.displayDateRange}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Attribution — shown only when live data is enabled */}
      {LIVE_ENABLED && (
        <div
          style={{
            marginTop: "16px",
            textAlign: "center",
            fontSize: "12px",
            color: "#9ca3af",
          }}
        >
          Wait times powered by{" "}
          <a
            href="https://queue-times.com"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#6b7280", textDecoration: "underline" }}
          >
            Queue-Times.com
          </a>
        </div>
      )}
    </>
  );
}

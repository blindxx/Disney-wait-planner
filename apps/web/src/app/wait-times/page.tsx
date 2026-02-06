"use client";

/**
 * Wait Times Page
 * Displays current attraction wait times for Disneyland Resort parks.
 * Allows filtering by park, operating status, and sorting options.
 *
 * Mobile-first layout: full-width cards readable while walking in a park.
 */

import { useEffect, useMemo, useState } from "react";
import {
  mockAttractionWaits,
  type AttractionWait,
  type ParkId,
} from "@disney-wait-planner/shared";

// ============================================
// CONSTANTS
// ============================================

/** Display names for each park */
const PARK_NAMES: Record<ParkId, string> = {
  disneyland: "Disneyland Park",
  dca: "Disney California Adventure",
};

/** Short tab labels that fit on narrow screens */
const PARK_TAB_LABELS: Record<ParkId, string> = {
  disneyland: "Disneyland",
  dca: "California Adventure",
};

/** Available sort options */
type SortOption = "wait-desc" | "name-asc";

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "wait-desc", label: "Wait (Longest)" },
  { value: "name-asc", label: "Name (A-Z)" },
];

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
 * AttractionCard — mobile-friendly attraction display.
 * Name + land on the left, wait badge on the right.
 */
function AttractionCard({ attraction }: { attraction: AttractionWait }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "12px 16px",
        minHeight: "56px",
        borderBottom: "1px solid #e5e7eb",
        backgroundColor: "#fff",
      }}
    >
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
 * Matches AttractionCard height to prevent layout jump.
 */
function SkeletonCard() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "12px 16px",
        minHeight: "56px",
        borderBottom: "1px solid #e5e7eb",
        backgroundColor: "#fff",
      }}
    >
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
  // State for park selection, filter, and sort
  const [selectedPark, setSelectedPark] = useState<ParkId>("disneyland");
  const [operatingOnly, setOperatingOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>("wait-desc");
  const [isLoading, setIsLoading] = useState(true);

  // Brief loading on mount and park switch for skeleton transition
  useEffect(() => {
    setIsLoading(true);
    const t = setTimeout(() => setIsLoading(false), 350);
    return () => clearTimeout(t);
  }, [selectedPark]);

  /**
   * Filter and sort attractions based on current settings.
   * Uses useMemo to avoid recalculating on every render.
   */
  const filteredAttractions = useMemo(() => {
    let results = mockAttractionWaits.filter(
      (a) => a.parkId === selectedPark
    );

    if (operatingOnly) {
      results = results.filter((a) => a.status === "OPERATING");
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
  }, [selectedPark, operatingOnly, sortBy]);

  return (
    <>
      {/* Skeleton animation keyframes */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .skeleton-pulse {
          animation: pulse 1.5s ease-in-out infinite;
        }
      `}</style>

      <div
        style={{
          maxWidth: "800px",
          margin: "0 auto",
          padding: "16px",
          /* Prevent any horizontal scroll from long content */
          overflowX: "hidden",
        }}
      >
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

        {/* Park Tabs — equal width, short labels for mobile */}
        <div
          style={{
            display: "flex",
            gap: "8px",
            marginBottom: "12px",
          }}
        >
          {(Object.keys(PARK_NAMES) as ParkId[]).map((parkId) => (
            <button
              key={parkId}
              onClick={() => setSelectedPark(parkId)}
              style={{
                flex: "1 1 0%",
                padding: "10px 8px",
                borderRadius: "8px",
                border: "none",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: "14px",
                lineHeight: "1.2",
                textAlign: "center",
                backgroundColor:
                  selectedPark === parkId ? "#2563eb" : "#f3f4f6",
                color: selectedPark === parkId ? "#fff" : "#374151",
                transition: "background-color 0.15s ease, color 0.15s ease",
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

        {/* Attractions List */}
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: "8px",
            overflow: "hidden",
          }}
        >
          {isLoading ? (
            /* Skeleton loading cards — stable height, no layout jump */
            Array.from({ length: 8 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))
          ) : filteredAttractions.length === 0 ? (
            <div
              style={{
                padding: "48px 20px",
                textAlign: "center",
                color: "#6b7280",
                fontSize: "15px",
              }}
            >
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
      </div>
    </>
  );
}

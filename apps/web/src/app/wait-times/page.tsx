"use client";

/**
 * Wait Times Page
 * Displays current attraction wait times for Disneyland Resort parks.
 * Allows filtering by park, operating status, and sorting options.
 */

import { useMemo, useState } from "react";
import {
  mockAttractionWaits,
  type AttractionWait,
  type ParkId,
  type WaitStatus,
} from "@disney-wait-planner/shared";

// ============================================
// CONSTANTS
// ============================================

/** Display names for each park */
const PARK_NAMES: Record<ParkId, string> = {
  disneyland: "Disneyland Park",
  dca: "Disney California Adventure",
};

/** Available sort options */
type SortOption = "wait-desc" | "name-asc";

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "wait-desc", label: "Wait (Longest First)" },
  { value: "name-asc", label: "Name (A-Z)" },
];

// ============================================
// HELPER COMPONENTS
// ============================================

/**
 * StatusBadge - Displays the operational status with appropriate styling
 */
function StatusBadge({ status }: { status: WaitStatus }) {
  // Define styles for each status type
  const styles: Record<WaitStatus, { bg: string; text: string }> = {
    OPERATING: { bg: "#dcfce7", text: "#166534" }, // Green
    DOWN: { bg: "#fef3c7", text: "#92400e" }, // Amber/warning
    CLOSED: { bg: "#f3f4f6", text: "#6b7280" }, // Gray/muted
  };

  const style = styles[status];

  return (
    <span
      style={{
        backgroundColor: style.bg,
        color: style.text,
        padding: "2px 8px",
        borderRadius: "4px",
        fontSize: "12px",
        fontWeight: 500,
      }}
    >
      {status}
    </span>
  );
}

/**
 * AttractionRow - Displays a single attraction's wait time info
 */
function AttractionRow({ attraction }: { attraction: AttractionWait }) {
  // Format the wait time display
  const waitDisplay =
    attraction.status === "OPERATING" && attraction.waitMins !== null
      ? `${attraction.waitMins} min`
      : "—";

  // Format the last updated time
  const updatedTime = new Date(attraction.updatedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        borderBottom: "1px solid #e5e7eb",
        backgroundColor: "#fff",
      }}
    >
      {/* Left side: Name and land */}
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, color: "#111827" }}>
          {attraction.name}
        </div>
        {attraction.land && (
          <div style={{ fontSize: "13px", color: "#6b7280", marginTop: "2px" }}>
            {attraction.land}
          </div>
        )}
      </div>

      {/* Right side: Status, wait time, and last updated */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "16px",
          textAlign: "right",
        }}
      >
        <StatusBadge status={attraction.status} />
        <div style={{ minWidth: "60px", fontWeight: 600, color: "#111827" }}>
          {waitDisplay}
        </div>
        <div style={{ fontSize: "12px", color: "#9ca3af", minWidth: "70px" }}>
          {updatedTime}
        </div>
      </div>
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

  /**
   * Filter and sort attractions based on current settings.
   * Uses useMemo to avoid recalculating on every render.
   */
  const filteredAttractions = useMemo(() => {
    // Start with all attractions for the selected park
    let results = mockAttractionWaits.filter(
      (a) => a.parkId === selectedPark
    );

    // Apply "operating only" filter if enabled
    if (operatingOnly) {
      results = results.filter((a) => a.status === "OPERATING");
    }

    // Sort based on selected option
    results.sort((a, b) => {
      if (sortBy === "wait-desc") {
        // Sort by wait time descending
        // Treat null waits as -1 so they appear at the end
        const waitA = a.waitMins ?? -1;
        const waitB = b.waitMins ?? -1;
        return waitB - waitA;
      } else {
        // Sort by name alphabetically
        return a.name.localeCompare(b.name);
      }
    });

    return results;
  }, [selectedPark, operatingOnly, sortBy]);

  return (
    <div style={{ maxWidth: "800px", margin: "0 auto", padding: "20px" }}>
      {/* Page Header */}
      <h1
        style={{
          fontSize: "24px",
          fontWeight: 700,
          color: "#111827",
          marginBottom: "20px",
        }}
      >
        Wait Times
      </h1>

      {/* Park Tabs */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          marginBottom: "16px",
        }}
      >
        {(Object.keys(PARK_NAMES) as ParkId[]).map((parkId) => (
          <button
            key={parkId}
            onClick={() => setSelectedPark(parkId)}
            style={{
              padding: "10px 16px",
              borderRadius: "8px",
              border: "none",
              cursor: "pointer",
              fontWeight: 500,
              backgroundColor:
                selectedPark === parkId ? "#2563eb" : "#f3f4f6",
              color: selectedPark === parkId ? "#fff" : "#374151",
              transition: "all 0.15s ease",
            }}
          >
            {PARK_NAMES[parkId]}
          </button>
        ))}
      </div>

      {/* Controls Row: Filter and Sort */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "16px",
          padding: "12px 16px",
          backgroundColor: "#f9fafb",
          borderRadius: "8px",
        }}
      >
        {/* Operating Only Toggle */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            cursor: "pointer",
            fontSize: "14px",
            color: "#374151",
          }}
        >
          <input
            type="checkbox"
            checked={operatingOnly}
            onChange={(e) => setOperatingOnly(e.target.checked)}
            style={{ width: "16px", height: "16px", cursor: "pointer" }}
          />
          Operating only
        </label>

        {/* Sort Dropdown */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "14px", color: "#6b7280" }}>Sort:</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
            style={{
              padding: "6px 12px",
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
        {filteredAttractions.length === 0 ? (
          <div
            style={{
              padding: "40px 20px",
              textAlign: "center",
              color: "#6b7280",
            }}
          >
            No attractions match your filters.
          </div>
        ) : (
          filteredAttractions.map((attraction) => (
            <AttractionRow key={attraction.id} attraction={attraction} />
          ))
        )}
      </div>

      {/* Results Summary */}
      <div
        style={{
          marginTop: "12px",
          fontSize: "13px",
          color: "#9ca3af",
          textAlign: "center",
        }}
      >
        Showing {filteredAttractions.length} attraction
        {filteredAttractions.length !== 1 ? "s" : ""}
      </div>
    </div>
  );
}

"use client";

import { useState, useMemo } from "react";
import { mockAttractionWaits, type ParkId, type AttractionWait } from "@disney-wait-planner/shared";

type SortOption = "wait-desc" | "name-asc";

export default function WaitTimesPage() {
  const [selectedPark, setSelectedPark] = useState<ParkId>("DL");
  const [operatingOnly, setOperatingOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>("wait-desc");

  const filteredAndSortedAttractions = useMemo(() => {
    let attractions = mockAttractionWaits.filter(
      (attraction) => attraction.parkId === selectedPark
    );

    if (operatingOnly) {
      attractions = attractions.filter((a) => a.isOperational);
    }

    attractions.sort((a, b) => {
      if (sortBy === "wait-desc") {
        return b.waitTime - a.waitTime;
      } else {
        return a.name.localeCompare(b.name);
      }
    });

    return attractions;
  }, [selectedPark, operatingOnly, sortBy]);

  const formatTime = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  };

  const getLandName = (attractionId: string): string => {
    // Simple land mapping based on attraction ID
    const landMap: Record<string, string> = {
      "dl-space-mountain": "Tomorrowland",
      "dl-matterhorn": "Fantasyland",
      "dl-big-thunder": "Frontierland",
      "dl-splash-mountain": "Critter Country",
      "dl-indiana-jones": "Adventureland",
      "dl-pirates": "New Orleans Square",
      "dl-haunted-mansion": "New Orleans Square",
      "dl-star-tours": "Tomorrowland",
      "dca-radiator-springs": "Cars Land",
      "dca-guardians": "Hollywood Land",
      "dca-incredicoaster": "Pixar Pier",
      "dca-soarin": "Grizzly Peak",
      "dca-toy-story": "Pixar Pier",
      "dca-grizzly-river": "Grizzly Peak",
      "dca-web-slingers": "Avengers Campus",
      "dca-little-mermaid": "Paradise Gardens Park",
    };
    return landMap[attractionId] || "Unknown";
  };

  return (
    <div style={{ maxWidth: "800px", margin: "0 auto", padding: "20px" }}>
      <h1 style={{ fontSize: "2rem", fontWeight: "bold", marginBottom: "24px" }}>
        Wait Times
      </h1>

      {/* Park Tabs */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "20px", borderBottom: "2px solid #e5e7eb" }}>
        <button
          onClick={() => setSelectedPark("DL")}
          style={{
            padding: "12px 24px",
            background: "none",
            border: "none",
            borderBottom: selectedPark === "DL" ? "3px solid #2563eb" : "3px solid transparent",
            fontWeight: selectedPark === "DL" ? "600" : "400",
            color: selectedPark === "DL" ? "#2563eb" : "#6b7280",
            cursor: "pointer",
            fontSize: "1rem",
            marginBottom: "-2px",
          }}
        >
          Disneyland Park
        </button>
        <button
          onClick={() => setSelectedPark("DCA")}
          style={{
            padding: "12px 24px",
            background: "none",
            border: "none",
            borderBottom: selectedPark === "DCA" ? "3px solid #2563eb" : "3px solid transparent",
            fontWeight: selectedPark === "DCA" ? "600" : "400",
            color: selectedPark === "DCA" ? "#2563eb" : "#6b7280",
            cursor: "pointer",
            fontSize: "1rem",
            marginBottom: "-2px",
          }}
        >
          Disney California Adventure
        </button>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={operatingOnly}
            onChange={(e) => setOperatingOnly(e.target.checked)}
            style={{ width: "18px", height: "18px", cursor: "pointer" }}
          />
          <span style={{ fontSize: "0.95rem" }}>Operating only</span>
        </label>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <label htmlFor="sort" style={{ fontSize: "0.95rem", color: "#6b7280" }}>
            Sort:
          </label>
          <select
            id="sort"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
            style={{
              padding: "6px 12px",
              border: "1px solid #d1d5db",
              borderRadius: "6px",
              fontSize: "0.95rem",
              cursor: "pointer",
              background: "white",
            }}
          >
            <option value="wait-desc">Wait (longest first)</option>
            <option value="name-asc">Name (A-Z)</option>
          </select>
        </div>
      </div>

      {/* Attractions List */}
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {filteredAndSortedAttractions.map((attraction) => (
          <div
            key={attraction.id}
            style={{
              padding: "16px",
              border: "1px solid #e5e7eb",
              borderRadius: "8px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: "white",
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: "600", fontSize: "1.05rem", marginBottom: "4px" }}>
                {attraction.name}
              </div>
              <div style={{ fontSize: "0.85rem", color: "#6b7280", marginBottom: "6px" }}>
                {getLandName(attraction.id)}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: "4px",
                    fontSize: "0.75rem",
                    fontWeight: "500",
                    background: attraction.isOperational ? "#dcfce7" : "#fee2e2",
                    color: attraction.isOperational ? "#15803d" : "#991b1b",
                  }}
                >
                  {attraction.isOperational ? "Operating" : "Closed"}
                </span>
                <span style={{ fontSize: "0.8rem", color: "#9ca3af" }}>
                  Updated {formatTime(attraction.lastUpdated)}
                </span>
              </div>
            </div>

            <div style={{ textAlign: "right", marginLeft: "16px" }}>
              <div style={{ fontSize: "2rem", fontWeight: "700", color: attraction.isOperational ? "#1f2937" : "#9ca3af" }}>
                {attraction.isOperational ? attraction.waitTime : "—"}
              </div>
              {attraction.isOperational && (
                <div style={{ fontSize: "0.8rem", color: "#6b7280", marginTop: "2px" }}>
                  mins
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {filteredAndSortedAttractions.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px", color: "#6b7280" }}>
          No attractions found.
        </div>
      )}
    </div>
  );
}

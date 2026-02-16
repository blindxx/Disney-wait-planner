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

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  mockAttractionWaits,
  type AttractionWait,
  type ParkId,
} from "@disney-wait-planner/shared";

// ============================================
// CONSTANTS
// ============================================

// Home page is DLR-only; typed narrowly to avoid requiring WDW park entries
const PARK_NAMES: Record<"disneyland" | "dca", string> = {
  disneyland: "Disneyland",
  dca: "California Adventure",
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
  const [selectedPark, setSelectedPark] = useState<ParkId>("disneyland");
  const [currentTime, setCurrentTime] = useState("");

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

  // Get best options: lowest wait times for selected park.
  // Excludes Down/Closed attractions — only OPERATING with a valid wait time.
  // If fewer than BEST_OPTIONS_COUNT qualify, show fewer (no backfill).
  const bestOptions = useMemo(() => {
    return mockAttractionWaits
      .filter((a) => a.parkId === selectedPark && a.status === "OPERATING")
      .filter((a) => a.waitMins != null)
      .sort((a, b) => (a.waitMins ?? 999) - (b.waitMins ?? 999))
      .slice(0, BEST_OPTIONS_COUNT);
  }, [selectedPark]);

  return (
    <>
      <style>{RESPONSIVE_CSS}</style>

      <div className="today-page">
        {/* Page Title */}
        <h1
          style={{
            fontSize: "28px",
            fontWeight: 700,
            color: "#111827",
            marginBottom: "8px",
          }}
        >
          Today
        </h1>

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

        {/* Park Selector */}
        <div className="park-selector">
          {(Object.keys(PARK_NAMES) as ("disneyland" | "dca")[]).map((parkId) => (
            <button
              key={parkId}
              className="park-btn"
              onClick={() => setSelectedPark(parkId)}
              style={{
                backgroundColor:
                  selectedPark === parkId ? "#2563eb" : "#f3f4f6",
                color: selectedPark === parkId ? "#fff" : "#374151",
              }}
            >
              {PARK_NAMES[parkId]}
            </button>
          ))}
        </div>

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
            // Color code wait time: green <=20, amber <=45, red >45
            const waitColor =
              (attraction.waitMins ?? 0) <= 20
                ? "#16a34a"
                : (attraction.waitMins ?? 0) <= 45
                  ? "#d97706"
                  : "#dc2626";

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
      </div>
    </>
  );
}

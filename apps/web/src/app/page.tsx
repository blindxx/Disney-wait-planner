"use client";

/**
 * Today (Home) Page — Phase 2.1 MVP
 *
 * Displays at-a-glance "best options right now" for the selected park.
 * Shows lowest wait times for operating attractions only.
 *
 * Mobile-first design:
 *   - Park selector (2 big buttons)
 *   - Current time indicator
 *   - 5 best options (short list, minimal scrolling)
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

const PARK_NAMES: Record<ParkId, string> = {
  disneyland: "Disneyland",
  dca: "California Adventure",
};

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
    gap: 12px;
    margin-bottom: 20px;
  }

  .option-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px;
    background-color: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    min-height: 72px;
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

  // Get best options: lowest wait times for selected park, operating only
  const bestOptions = useMemo(() => {
    return mockAttractionWaits
      .filter((a) => a.parkId === selectedPark && a.status === "OPERATING")
      .filter((a) => a.waitMins != null)
      .sort((a, b) => (a.waitMins ?? 999) - (b.waitMins ?? 999))
      .slice(0, 5);
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
          {(Object.keys(PARK_NAMES) as ParkId[]).map((parkId) => (
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
          {bestOptions.map((attraction) => (
            <div key={attraction.id} className="option-item">
              {/* Attraction Name */}
              <div style={{ flex: "1 1 0%", minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: "16px",
                    lineHeight: "1.3",
                    color: "#111827",
                    wordWrap: "break-word",
                  }}
                >
                  {attraction.name}
                </div>
              </div>

              {/* Wait Time */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    fontSize: "28px",
                    fontWeight: 700,
                    color: "#2563eb",
                    lineHeight: "1",
                  }}
                >
                  {attraction.waitMins}
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "#6b7280",
                    marginTop: "2px",
                  }}
                >
                  min
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Primary Action Button */}
        <Link href="/wait-times" className="primary-btn">
          View all wait times
        </Link>
      </div>
    </>
  );
}

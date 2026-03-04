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

  // Hydrate from localStorage on mount (client-side only).
  useEffect(() => {
    const { defaultResort: resort, defaultPark: park } = getSettingsDefaults();
    setDefaultResort(resort);
    setDefaultPark(park);
  }, []);

  // Handlers — persist immediately on change.

  function handleResortChange(resort: ResortId) {
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

  const parks = RESORT_PARKS[defaultResort];

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

      {/* ── Default Resort ── */}
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

      {/* ── Default Park ── */}
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

      {/* ── Account / Sync (Placeholder) ── */}
      <section
        style={{
          padding: "16px",
          borderRadius: "8px",
          border: "1px solid #e5e7eb",
          backgroundColor: "#f9fafb",
        }}
      >
        <h2
          style={{
            fontSize: "15px",
            fontWeight: 600,
            color: "#374151",
            marginBottom: "6px",
          }}
        >
          Account &amp; Sync
        </h2>
        <p style={{ fontSize: "14px", color: "#6b7280", margin: 0 }}>
          Cloud Sync coming in Phase 7.2
        </p>
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

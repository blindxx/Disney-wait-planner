"use client";

import { useState, useEffect, useMemo } from "react";
import {
  parseAmPmToken,
  parse24hToken,
  parseMilToken,
  formatSingleTime,
} from "@/lib/timeUtils";
import {
  mockAttractionWaits,
  type AttractionWait,
  type ResortId,
} from "@disney-wait-planner/shared";
import { getWaitDatasetForResort, LIVE_ENABLED } from "@/lib/liveWaitApi";
import {
  normalizeKey,
  ALIASES_DLR,
  ALIASES_WDW,
  lookupWait,
  type WaitEntry,
} from "@/lib/plansMatching";
import { getWaitBadgeProps } from "@/lib/waitBadge";

// ===== RESORT CONSTANTS =====

/** Shared with My Plans — both pages read/write the same key for consistency. */
const STORAGE_RESORT_KEY = "dwp.selectedResort";

const RESORT_LABELS: Record<ResortId, string> = {
  DLR: "Disneyland Resort",
  WDW: "Walt Disney World",
};

// ===== TYPES =====

type LightningItem = {
  id: string;
  name: string;
  startTime: string; // internal "H:MM" 24h format
  endTime: string;   // internal "H:MM" 24h format, or "" if no end time
};

type StoredSchema = {
  version: 1;
  items: LightningItem[];
};

// ===== STORAGE =====

const STORAGE_KEY = "dwp.lightning.v1";

function loadFromStorage(): LightningItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as StoredSchema).version === 1 &&
      Array.isArray((parsed as StoredSchema).items)
    ) {
      return (parsed as StoredSchema).items;
    }
    // Wrong version or corrupt structure — clear and start fresh
    localStorage.removeItem(STORAGE_KEY);
    return [];
  } catch {
    // JSON parse failed — clear bad data
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    return [];
  }
}

function saveToStorage(items: LightningItem[]): void {
  try {
    const schema: StoredSchema = { version: 1, items };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schema));
  } catch {}
}

// ===== ID GENERATION =====

function makeId(): string {
  return `ll-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// Time parsing helpers (parseAmPmToken, parse24hToken, parseMilToken,
// formatSingleTime) are imported from @/lib/timeUtils.

/**
 * Validate and normalize a single time input from the Lightning Lane form.
 * Returns:
 *   ""      — input was empty (no time specified)
 *   "H:MM"  — valid normalized 24h time
 *   null    — input was non-empty but invalid (caller should show error)
 *
 * Accepted formats: "15:00", "1500", "3pm", "3:30pm", "3:30 PM", etc.
 */
function normalizeTimeInput(raw: string): string | null {
  const s = raw.trim().replace(/[\u2013\u2014]/g, "-");
  if (!s) return "";

  // 4-digit military: "1500" => "15:00"
  const mil = parseMilToken(s);
  if (mil !== null) return mil;

  // Strict 24h: "H:MM" or "HH:MM"
  const h24 = parse24hToken(s);
  if (h24 !== null) return h24;

  // AM/PM: "3pm", "3:30pm", "3:30 PM", "3 pm", etc.
  const ampm = parseAmPmToken(s);
  if (ampm !== null) return ampm;

  return null;
}

// ===== COUNTDOWN HELPERS =====

/** Parse "H:MM" internal format to total minutes from midnight */
function toMinutes(t: string): number {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return -1;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Bucket 0=now, 1=soon (≤30m), 2=upcoming (>30m), 3=expired
type Bucket = "now" | "soon" | "upcoming" | "expired";

const BUCKET_ORDER: Record<Bucket, number> = {
  now: 0,
  soon: 1,
  upcoming: 2,
  expired: 3,
};

function getBucket(item: LightningItem, nowMinutes: number): Bucket {
  const start = toMinutes(item.startTime);
  if (nowMinutes < start) {
    return start - nowMinutes <= 30 ? "soon" : "upcoming";
  }
  if (item.endTime) {
    const end = toMinutes(item.endTime);
    if (nowMinutes > end) return "expired";
  }
  return "now";
}

/**
 * Return a sorted copy of items — never mutates state.
 * Sort key: (bucket priority, startTime ascending, id for stability).
 * Based only on startTime + id so items don't reshuffle on every 10s tick.
 */
function sortedItems(items: LightningItem[], nowMinutes: number): LightningItem[] {
  return [...items].sort((a, b) => {
    const orderDiff = BUCKET_ORDER[getBucket(a, nowMinutes)] - BUCKET_ORDER[getBucket(b, nowMinutes)];
    if (orderDiff !== 0) return orderDiff;
    const startDiff = toMinutes(a.startTime) - toMinutes(b.startTime);
    if (startDiff !== 0) return startDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Format a countdown string like "2h 30m" or "45m" for upcoming/soon reservations */
function formatCountdown(item: LightningItem, nowMinutes: number): string {
  const start = toMinutes(item.startTime);
  const diff = start - nowMinutes;
  if (diff <= 0) return "";
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function nowInMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// ===== PAGE COMPONENT =====

export default function LightningPage() {
  const [items, setItems] = useState<LightningItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Form state
  const [rideName, setRideName] = useState("");
  const [startRaw, setStartRaw] = useState("");
  const [endRaw, setEndRaw] = useState("");
  const [startError, setStartError] = useState("");
  const [endError, setEndError] = useState("");

  // Shared "now" state drives all countdowns — one interval for the whole page
  const [now, setNow] = useState(nowInMinutes);

  // Resort selection — shared localStorage key with My Plans for consistency
  const [selectedResort, setSelectedResort] = useState<ResortId>("DLR");

  // Live attraction wait data for the selected resort (all parks merged)
  const [liveAttractions, setLiveAttractions] = useState<AttractionWait[]>([]);

  // Load persisted reservations on mount
  useEffect(() => {
    setItems(loadFromStorage());
    setLoaded(true);
  }, []);

  // Persist whenever items change (after initial load)
  useEffect(() => {
    if (loaded) saveToStorage(items);
  }, [items, loaded]);

  // Single interval updates "now" every 10 seconds
  useEffect(() => {
    const id = setInterval(() => {
      setNow(nowInMinutes());
    }, 10_000);
    return () => clearInterval(id);
  }, []);

  // Hydrate selectedResort from localStorage on client mount (runs once)
  useEffect(() => {
    try {
      const v = localStorage.getItem(STORAGE_RESORT_KEY);
      if (v === "DLR" || v === "WDW") setSelectedResort(v);
    } catch {}
  }, []);

  // Persist selectedResort whenever it changes
  useEffect(() => {
    try { localStorage.setItem(STORAGE_RESORT_KEY, selectedResort); } catch {}
  }, [selectedResort]);

  // Fetch live wait data for all parks in the selected resort.
  // Shares the same TTL cache as My Plans / Wait Times — no second fetch path.
  useEffect(() => {
    if (!LIVE_ENABLED) return;
    let cancelled = false;
    getWaitDatasetForResort(selectedResort).then(({ data }) => {
      if (!cancelled) setLiveAttractions(data);
    });
    return () => { cancelled = true; };
  }, [selectedResort]);

  // Build a deterministic wait lookup map scoped to selectedResort.
  // Identical pattern to My Plans — resort-scoped, park-aware (no cross-park collisions).
  const waitMap = useMemo(() => {
    const source =
      LIVE_ENABLED && liveAttractions.length > 0 ? liveAttractions : mockAttractionWaits;
    const map = new Map<string, WaitEntry>();
    for (const a of source) {
      if (a.resortId !== selectedResort) continue;
      map.set(normalizeKey(a.name), {
        status: a.status,
        waitMins: a.waitMins,
        canonicalName: a.name,
      });
    }
    return map;
  }, [selectedResort, liveAttractions]);

  // Derived form validity
  const nameValid = rideName.trim().length > 0;
  const startNorm = normalizeTimeInput(startRaw);
  const endNorm = normalizeTimeInput(endRaw);
  const startValid = startNorm !== null && startNorm !== "";
  const endFieldEmpty = endRaw.trim() === "";
  const endValid = endFieldEmpty || (endNorm !== null && endNorm !== "");
  const formValid = nameValid && startValid && endValid && !startError && !endError;

  function handleAdd() {
    const s = normalizeTimeInput(startRaw);
    if (!s) {
      setStartError("Invalid time. Try: 3pm, 3:30 PM, 15:30, or 1530");
      return;
    }

    let e = "";
    if (!endFieldEmpty) {
      const en = normalizeTimeInput(endRaw);
      if (!en) {
        setEndError("Invalid time. Try: 4pm, 4:30 PM, 16:30, or 1630");
        return;
      }
      e = en;
    }

    const newItem: LightningItem = {
      id: makeId(),
      name: rideName.trim(),
      startTime: s,
      endTime: e,
    };

    setItems((prev) => [...prev, newItem]);
    setRideName("");
    setStartRaw("");
    setEndRaw("");
    setStartError("");
    setEndError("");
  }

  function handleRemove(id: string) {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  function handleStartBlur() {
    if (!startRaw.trim()) {
      setStartError("");
      return;
    }
    if (normalizeTimeInput(startRaw) === null) {
      setStartError("Invalid time. Try: 10am, 10:30 AM, 10:30, or 1030");
    } else {
      setStartError("");
    }
  }

  function handleEndBlur() {
    if (!endRaw.trim()) {
      setEndError("");
      return;
    }
    if (normalizeTimeInput(endRaw) === null) {
      setEndError("Invalid time. Try: 11am, 11:30 AM, 11:30, or 1130");
    } else {
      setEndError("");
    }
  }

  return (
    <div style={{ maxWidth: 560, margin: "0 auto" }}>
      <h1 className="title">Lightning Lane</h1>

      {/* ── Add Form ── */}
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: "1.25rem",
          marginBottom: "1.5rem",
          boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
        }}
      >
        <h2
          style={{
            fontSize: "1.05rem",
            fontWeight: 600,
            marginBottom: "1rem",
            color: "#1a1a2e",
          }}
        >
          Add Reservation
        </h2>

        {/* Ride Name */}
        <div style={{ marginBottom: "0.875rem" }}>
          <label style={labelStyle}>
            Ride name <span style={{ color: "#dc2626" }}>*</span>
          </label>
          <input
            type="text"
            value={rideName}
            onChange={(e) => setRideName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && formValid) handleAdd(); }}
            placeholder="e.g. Space Mountain"
            style={inputStyle()}
          />
        </div>

        {/* Start Time */}
        <div style={{ marginBottom: "0.875rem" }}>
          <label style={labelStyle}>
            Return window start <span style={{ color: "#dc2626" }}>*</span>
          </label>
          <input
            type="text"
            value={startRaw}
            onChange={(e) => {
              setStartRaw(e.target.value);
              setStartError("");
            }}
            onBlur={handleStartBlur}
            onKeyDown={(e) => { if (e.key === "Enter" && formValid) handleAdd(); }}
            placeholder="e.g. 3pm, 3:30 PM, 15:30"
            style={inputStyle(!!startError)}
          />
          {startError && <p style={errorStyle}>{startError}</p>}
        </div>

        {/* End Time (optional) */}
        <div style={{ marginBottom: "1.25rem" }}>
          <label style={labelStyle}>
            Return window end{" "}
            <span style={{ color: "#6b7280", fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            type="text"
            value={endRaw}
            onChange={(e) => {
              setEndRaw(e.target.value);
              setEndError("");
            }}
            onBlur={handleEndBlur}
            onKeyDown={(e) => { if (e.key === "Enter" && formValid) handleAdd(); }}
            placeholder="e.g. 4pm, 4:30 PM, 16:30"
            style={inputStyle(!!endError)}
          />
          {endError && <p style={errorStyle}>{endError}</p>}
        </div>

        <button
          onClick={handleAdd}
          disabled={!formValid}
          style={{
            width: "100%",
            padding: "0.875rem",
            fontSize: "1rem",
            fontWeight: 600,
            borderRadius: 8,
            border: "none",
            background: formValid ? "#1a1a2e" : "#e5e7eb",
            color: formValid ? "#fff" : "#9ca3af",
            cursor: formValid ? "pointer" : "not-allowed",
            minHeight: 48,
            transition: "background 0.15s",
          }}
        >
          Add Reservation
        </button>
      </div>

      {/* ── Resort Toggle — scopes live wait overlay to selected resort ── */}
      <div style={{ display: "flex", gap: 8, marginBottom: "0.5rem" }}>
        {(Object.keys(RESORT_LABELS) as ResortId[]).map((resortId) => (
          <button
            key={resortId}
            onClick={() => setSelectedResort(resortId)}
            style={{
              flex: "1 1 0%",
              padding: "8px 6px",
              borderRadius: 8,
              border: `1px solid ${selectedResort === resortId ? "#1e3a5f" : "#d1d5db"}`,
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 13,
              lineHeight: 1.2,
              textAlign: "center",
              backgroundColor: selectedResort === resortId ? "#1e3a5f" : "#f9fafb",
              color: selectedResort === resortId ? "#fff" : "#374151",
              minHeight: 36,
            }}
          >
            {RESORT_LABELS[resortId]}
          </button>
        ))}
      </div>
      <p style={{ fontSize: "0.7rem", color: "#9ca3af", marginBottom: "0.75rem" }}>
        Wait overlay: {selectedResort}
      </p>

      {/* ── Reservation List ── */}
      {!loaded ? null : items.length === 0 ? (
        <p
          style={{
            color: "#9ca3af",
            textAlign: "center",
            padding: "2.5rem 1rem",
            fontSize: "0.95rem",
          }}
        >
          No reservations yet. Add one above.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {sortedItems(items, now).map((item) => {
            const bucket = getBucket(item, now);
            const aliases = selectedResort === "DLR" ? ALIASES_DLR : ALIASES_WDW;
            return (
              <ReservationCard
                key={item.id}
                item={item}
                bucket={bucket}
                now={now}
                onRemove={() => handleRemove(item.id)}
                waitEntry={lookupWait(item.name, waitMap, aliases)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ===== RESERVATION CARD =====

function ReservationCard({
  item,
  bucket,
  now,
  onRemove,
  waitEntry,
}: {
  item: LightningItem;
  bucket: Bucket;
  now: number;
  onRemove: () => void;
  waitEntry: WaitEntry | null;
}) {
  const showCountdown = bucket === "soon" || bucket === "upcoming";
  const countdown = showCountdown ? formatCountdown(item, now) : "";

  // Compute live wait badge — same logic as My Plans (getWaitBadgeProps).
  // Prefix "Live: " on operating waits so it reads distinctly from the countdown.
  const liveBadge = (() => {
    if (!waitEntry) return null;
    const badge = getWaitBadgeProps({ status: waitEntry.status, waitMins: waitEntry.waitMins });
    if (!badge) return null;
    const label =
      badge.label === "Down" || badge.label === "Closed"
        ? badge.label
        : `Live: ${badge.label}`;
    return { label, style: badge.style };
  })();

  const borderColor =
    bucket === "now"
      ? "#16a34a"
      : bucket === "soon"
      ? "#d97706"
      : bucket === "upcoming"
      ? "#2563eb"
      : "#d1d5db";

  const countdownColor = bucket === "soon" ? "#d97706" : "#2563eb";

  return (
    <div
      style={{
        background: bucket === "expired" ? "#f9fafb" : "#fff",
        borderRadius: 12,
        padding: "1rem 1.25rem",
        boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
        opacity: bucket === "expired" ? 0.7 : 1,
        borderLeft: `${bucket === "soon" ? 6 : 4}px solid ${borderColor}`,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "0.75rem",
        }}
      >
        {/* Left: ride info + status */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Ride name + live wait badge */}
          <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "0.35rem", marginBottom: "0.2rem" }}>
            <span
              style={{
                fontWeight: 600,
                fontSize: "1.05rem",
                color: bucket === "expired" ? "#6b7280" : "#1a1a2e",
                wordBreak: "break-word",
              }}
            >
              {item.name}
            </span>
            {liveBadge && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  padding: "0.15rem 0.45rem",
                  borderRadius: 4,
                  whiteSpace: "nowrap",
                  lineHeight: 1.4,
                  flexShrink: 0,
                  ...liveBadge.style,
                }}
              >
                {liveBadge.label}
              </span>
            )}
          </div>

          {/* Time window */}
          <div
            style={{
              fontSize: "0.875rem",
              color: "#6b7280",
              marginBottom: "0.6rem",
            }}
          >
            {formatSingleTime(item.startTime)}
            {item.endTime ? `\u2013${formatSingleTime(item.endTime)}` : ""}
          </div>

          {/* Status indicators */}
          {bucket === "now" && (
            <span
              style={{
                display: "inline-block",
                background: "#16a34a",
                color: "#fff",
                fontWeight: 700,
                fontSize: "0.95rem",
                padding: "0.3rem 0.85rem",
                borderRadius: 20,
                letterSpacing: "0.06em",
              }}
            >
              NOW
            </span>
          )}

          {showCountdown && countdown && (
            <div style={{ display: "flex", alignItems: "baseline", gap: "0.35rem" }}>
              <span
                style={{
                  fontSize: bucket === "soon" ? "1.9rem" : "1.6rem",
                  fontWeight: 700,
                  color: countdownColor,
                  lineHeight: 1,
                }}
              >
                {countdown}
              </span>
              <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
                until start
              </span>
            </div>
          )}

          {bucket === "expired" && (
            <span
              style={{
                fontSize: "0.8rem",
                color: "#9ca3af",
                fontStyle: "italic",
              }}
            >
              Expired
            </span>
          )}
        </div>

        {/* Remove button */}
        <button
          onClick={onRemove}
          aria-label={`Remove ${item.name}`}
          style={{
            flexShrink: 0,
            background: "none",
            border: "1.5px solid #e5e7eb",
            borderRadius: 8,
            padding: "0.4rem 0.65rem",
            fontSize: "0.8rem",
            color: "#9ca3af",
            cursor: "pointer",
            minWidth: 44,
            minHeight: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

// ===== SHARED STYLES =====

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.875rem",
  fontWeight: 500,
  marginBottom: "0.3rem",
  color: "#374151",
};

const errorStyle: React.CSSProperties = {
  color: "#dc2626",
  fontSize: "0.8rem",
  marginTop: "0.25rem",
};

function inputStyle(hasError = false): React.CSSProperties {
  return {
    width: "100%",
    padding: "0.65rem 0.75rem",
    fontSize: "1rem",
    borderRadius: 8,
    border: `1.5px solid ${hasError ? "#dc2626" : "#d1d5db"}`,
    outline: "none",
    boxSizing: "border-box",
    background: "#fff",
  };
}

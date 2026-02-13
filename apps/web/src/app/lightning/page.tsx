"use client";

import { useState, useEffect } from "react";

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

// ===== TIME PARSING (same strict pattern as My Plans) =====

/** Strip internal whitespace and lowercase for AM/PM token comparison */
function normalizeAmPmStr(str: string): string {
  return str.replace(/\s+/g, "").toLowerCase();
}

/**
 * Parse an AM/PM time token (e.g. "10am", "10 pm", "10:00am").
 * Returns internal 24h string "H:MM" or null if invalid.
 * Hours must be 1–12. Single-digit minutes => treated as 00 (strict).
 */
function parseAmPmToken(raw: string): string | null {
  const s = normalizeAmPmStr(raw);
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?([ap]m)$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const rawMin = m[2];
  const meridiem = m[3];

  if (h < 1 || h > 12) return null;

  let min = 0;
  if (rawMin !== undefined) {
    // Single-digit minute is treated strictly as 00
    min = rawMin.length === 1 ? 0 : parseInt(rawMin, 10);
    if (min < 0 || min > 59) return null;
  }

  if (meridiem === "am") {
    if (h === 12) h = 0; // 12am => midnight
  } else {
    if (h !== 12) h += 12; // 1–11pm => +12; 12pm stays 12
  }
  return `${h}:${String(min).padStart(2, "0")}`;
}

/**
 * Parse a strict 24h time token "H:MM" or "HH:MM" (must have exactly 2 digit minutes).
 * Returns "H:MM" string or null if invalid.
 */
function parse24hToken(str: string): string | null {
  const m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${h}:${m[2]}`;
}

/**
 * Parse a 4-digit military time token e.g. "1500" => "15:00", "0730" => "7:30".
 * Returns canonical "H:MM" (no leading zero on hour) or null if invalid.
 */
function parseMilToken(str: string): string | null {
  if (!/^\d{4}$/.test(str)) return null;
  const h = parseInt(str.slice(0, 2), 10);
  const min = parseInt(str.slice(2), 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${h}:${String(min).padStart(2, "0")}`;
}

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

// ===== DISPLAY FORMATTER =====

/** Format internal "H:MM" (24h) to "h:MM AM/PM" for display */
function formatTime(t: string): string {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const meridiem = h < 12 ? "AM" : "PM";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${min} ${meridiem}`;
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
            return (
              <ReservationCard
                key={item.id}
                item={item}
                bucket={bucket}
                now={now}
                onRemove={() => handleRemove(item.id)}
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
}: {
  item: LightningItem;
  bucket: Bucket;
  now: number;
  onRemove: () => void;
}) {
  const showCountdown = bucket === "soon" || bucket === "upcoming";
  const countdown = showCountdown ? formatCountdown(item, now) : "";

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
        borderLeft: `4px solid ${borderColor}`,
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
          {/* Ride name */}
          <div
            style={{
              fontWeight: 600,
              fontSize: "1.05rem",
              color: bucket === "expired" ? "#6b7280" : "#1a1a2e",
              marginBottom: "0.2rem",
              wordBreak: "break-word",
            }}
          >
            {item.name}
          </div>

          {/* Time window */}
          <div
            style={{
              fontSize: "0.875rem",
              color: "#6b7280",
              marginBottom: "0.6rem",
            }}
          >
            {formatTime(item.startTime)}
            {item.endTime ? `\u2013${formatTime(item.endTime)}` : ""}
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
                  fontSize: "1.6rem",
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

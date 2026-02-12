"use client";

import { useState } from "react";

type PlanItem = {
  id: string;
  name: string;
  timeLabel: string;
};

type Mode = "view" | "add" | "edit" | "import";

let nextId = 1;
function makeId() {
  return String(nextId++);
}

// ===== TIME PARSING UTILITIES =====

/** Strip internal whitespace and lowercase for AM/PM token comparison */
function normalizeAmPmStr(str: string): string {
  return str.replace(/\s+/g, "").toLowerCase();
}

/**
 * Parse an AM/PM time token (e.g. "10am", "10 pm", "10:00am", "10:0am").
 * Returns internal 24h string "H:MM" or null if invalid.
 * Hours must be 1-12. Single-digit minutes => treated as 00 (strict).
 */
function parseAmPmToken(raw: string): string | null {
  const s = normalizeAmPmStr(raw);
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?([ap]m)$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const rawMin = m[2];
  const meridiem = m[3];

  // AM/PM hours must be 1-12
  if (h < 1 || h > 12) return null;

  let min = 0;
  if (rawMin !== undefined) {
    // Single-digit minute is treated strictly as 00
    min = rawMin.length === 1 ? 0 : parseInt(rawMin, 10);
    if (min < 0 || min > 59) return null;
  }

  if (meridiem === "am") {
    if (h === 12) h = 0; // 12am => 0
  } else {
    if (h !== 12) h += 12; // 1-11 pm => +12; 12pm stays 12
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

/** True if the string contains at least one alphanumeric character. */
function hasValidName(s: string): boolean {
  return /[a-zA-Z0-9]/.test(s);
}

/**
 * Parse a single import line into { timeLabel, name } or null (ignored).
 *
 * Priority order:
 *   1. Leading AM/PM range   (both sides explicit am/pm, atomic)
 *   2. Leading AM/PM single
 *   3. Leading AM/PM time-only → null
 *   4. Leading 24h range     (permissive detection, strict validation, atomic)
 *   5. Leading 24h single
 *   6. Leading 24h time-only → null
 *   7. Trailing AM/PM range
 *   8. Trailing 24h range
 *   9. Trailing AM/PM single
 *  10. Trailing 24h single
 *  11. Name-only (timeLabel = "")
 *
 * "time-only" lines (valid time, no name) are returned as null (ignored).
 * Punctuation-only lines are returned as null.
 */
function parseLine(rawLine: string): { timeLabel: string; name: string } | null {
  const line = rawLine.trim();
  if (!line || !hasValidName(line)) return null;

  // ---- LEADING AM/PM RANGE: AMPM - AMPM [name] ----
  // Both sides must carry explicit am/pm suffix (no guessing).
  let m = line.match(
    /^(\d{1,2}(?::\d{1,2})?\s*[ap]m)\s*-\s*(\d{1,2}(?::\d{1,2})?\s*[ap]m)\s*(.*)/i
  );
  if (m) {
    const start = parseAmPmToken(m[1]);
    const end = parseAmPmToken(m[2]);
    const rest = m[3].trim();
    if (start && end) {
      // time-only or garbage-only after removing times => ignored
      if (!rest || !hasValidName(rest)) return null;
      return { timeLabel: `${start}-${end}`, name: rest };
    }
    // Atomic: at least one side invalid => whole line is name-only
    return { timeLabel: "", name: line };
  }

  // ---- LEADING AM/PM SINGLE: AMPM <space> name ----
  m = line.match(/^(\d{1,2}(?::\d{1,2})?\s*[ap]m)\s+(.*)/i);
  if (m) {
    const time = parseAmPmToken(m[1]);
    const rest = m[2].trim();
    if (time) {
      if (!rest || !hasValidName(rest)) return null;
      return { timeLabel: time, name: rest };
    }
    return { timeLabel: "", name: line };
  }

  // ---- LEADING AM/PM TIME-ONLY (entire line) ----
  m = line.match(/^(\d{1,2}(?::\d{1,2})?\s*[ap]m)$/i);
  if (m && parseAmPmToken(m[1])) return null;

  // ---- LEADING 24H RANGE (permissive detection for atomicity) ----
  // Use \d{1,2}:\d{1,2} to detect range attempts even with single-digit minutes,
  // then validate strictly with parse24hToken (requires \d{2} minutes).
  m = line.match(/^(\d{1,2}:\d{1,2})\s*-\s*(\d{1,2}:\d{1,2})\s*(.*)/);
  if (m) {
    const start = parse24hToken(m[1]);
    const end = parse24hToken(m[2]);
    const rest = m[3].trim();
    if (start && end) {
      if (!rest || !hasValidName(rest)) return null;
      return { timeLabel: `${start}-${end}`, name: rest };
    }
    // Atomic: either side invalid => name-only (no partial salvage)
    return { timeLabel: "", name: line };
  }

  // ---- LEADING 24H SINGLE: H:MM <space> name ----
  m = line.match(/^(\d{1,2}:\d{2})\s+(.*)/);
  if (m) {
    const time = parse24hToken(m[1]);
    const rest = m[2].trim();
    if (time) {
      if (!rest || !hasValidName(rest)) return null;
      return { timeLabel: time, name: rest };
    }
    return { timeLabel: "", name: line };
  }

  // ---- LEADING 24H TIME-ONLY ----
  m = line.match(/^(\d{1,2}:\d{2})$/);
  if (m && parse24hToken(m[1])) return null;

  // ---- TRAILING PATTERNS (only reached when no leading time matched) ----

  // Trailing AM/PM range: name <space> AMPM-AMPM
  m = line.match(
    /^(.*)\s+(\d{1,2}(?::\d{1,2})?\s*[ap]m)\s*-\s*(\d{1,2}(?::\d{1,2})?\s*[ap]m)$/i
  );
  if (m) {
    const namePart = m[1].trim();
    const start = parseAmPmToken(m[2]);
    const end = parseAmPmToken(m[3]);
    if (start && end && hasValidName(namePart)) {
      return { timeLabel: `${start}-${end}`, name: namePart };
    }
    if (!hasValidName(namePart)) return null;
    // Atomic: invalid time(s) => name-only
    return { timeLabel: "", name: line };
  }

  // Trailing 24h range: name <space> H:MM-H:MM
  m = line.match(/^(.*)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (m) {
    const namePart = m[1].trim();
    const start = parse24hToken(m[2]);
    const end = parse24hToken(m[3]);
    if (start && end && hasValidName(namePart)) {
      return { timeLabel: `${start}-${end}`, name: namePart };
    }
    if (!hasValidName(namePart)) return null;
    return { timeLabel: "", name: line };
  }

  // Trailing AM/PM single: name <space> AMPM
  m = line.match(/^(.*)\s+(\d{1,2}(?::\d{1,2})?\s*[ap]m)$/i);
  if (m) {
    const namePart = m[1].trim();
    const time = parseAmPmToken(m[2]);
    if (time && hasValidName(namePart)) {
      return { timeLabel: time, name: namePart };
    }
    if (!hasValidName(namePart)) return null;
    return { timeLabel: "", name: line };
  }

  // Trailing 24h single: name <space> H:MM
  m = line.match(/^(.*)\s+(\d{1,2}:\d{2})$/);
  if (m) {
    const namePart = m[1].trim();
    const time = parse24hToken(m[2]);
    if (time && hasValidName(namePart)) {
      return { timeLabel: time, name: namePart };
    }
    if (!hasValidName(namePart)) return null;
    return { timeLabel: "", name: line };
  }

  // ---- NAME-ONLY: no time found ----
  return { timeLabel: "", name: line };
}

// ===== 12-HOUR DISPLAY FORMATTER =====

/** Format a single internal "H:MM" value to "h:MM AM/PM". */
function formatSingleTime(t: string): string {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t; // fallback: return as-is
  let h = parseInt(m[1], 10);
  const min = m[2];
  const meridiem = h < 12 ? "AM" : "PM";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${min} ${meridiem}`;
}

/**
 * Format an internal timeLabel ("H:MM" or "H:MM-H:MM") to display format.
 * Non-standard labels (free-text from the edit form) are returned as-is.
 */
function formatTimeLabel(timeLabel: string): string {
  if (!timeLabel) return "";
  // Range: contains exactly one dash between two time-like tokens
  const rangeMatch = timeLabel.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (rangeMatch) {
    return `${formatSingleTime(rangeMatch[1])}\u2013${formatSingleTime(rangeMatch[2])}`;
  }
  // Single time
  if (/^\d{1,2}:\d{2}$/.test(timeLabel)) {
    return formatSingleTime(timeLabel);
  }
  // Free-text label from manual entry: display as-is
  return timeLabel;
}

// ===== COMPONENT =====

export default function PlansPage() {
  const [items, setItems] = useState<PlanItem[]>([]);
  const [mode, setMode] = useState<Mode>("view");
  const [editTarget, setEditTarget] = useState<PlanItem | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formTime, setFormTime] = useState("");
  const [formError, setFormError] = useState("");
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");

  function openAdd() {
    setFormName("");
    setFormTime("");
    setFormError("");
    setEditTarget(null);
    setMode("add");
  }

  function openEdit(item: PlanItem) {
    setFormName(item.name);
    setFormTime(item.timeLabel);
    setFormError("");
    setEditTarget(item);
    setMode("edit");
  }

  function openImport() {
    setImportText("");
    setImportError("");
    setMode("import");
  }

  function closeModal() {
    setMode("view");
    setEditTarget(null);
    setFormError("");
    setImportError("");
  }

  function handleSave() {
    const trimmed = formName.trim();
    if (!trimmed) {
      setFormError("Activity name is required.");
      return;
    }
    if (mode === "add") {
      setItems((prev) => [
        ...prev,
        { id: makeId(), name: trimmed, timeLabel: formTime.trim() },
      ]);
    } else if (mode === "edit" && editTarget) {
      setItems((prev) =>
        prev.map((it) =>
          it.id === editTarget.id
            ? { ...it, name: trimmed, timeLabel: formTime.trim() }
            : it
        )
      );
    }
    closeModal();
  }

  function handleImport() {
    const lines = importText.split("\n");
    const newItems: PlanItem[] = [];
    for (const line of lines) {
      const parsed = parseLine(line);
      if (parsed) {
        newItems.push({
          id: makeId(),
          name: parsed.name,
          timeLabel: parsed.timeLabel,
        });
      }
    }
    if (newItems.length === 0) {
      setImportError("No valid activities found. Check your text and try again.");
      return;
    }
    setItems((prev) => [...prev, ...newItems]);
    setImportText("");
    setMode("view");
  }

  function handleDelete(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
    setDeleteConfirmId(null);
  }

  function moveUp(index: number) {
    if (index === 0) return;
    setItems((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }

  function moveDown(index: number) {
    if (index === items.length - 1) return;
    setItems((prev) => {
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }

  return (
    <>
      <style>{`
        .plans-container {
          max-width: 480px;
          margin: 0 auto;
          padding: 0 0 4rem 0;
        }
        .plans-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 1.5rem;
        }
        .plans-title {
          font-size: 1.75rem;
          font-weight: 700;
          color: #1a1a2e;
        }
        .plans-header-actions {
          display: flex;
          gap: 0.5rem;
        }
        .btn-add {
          background-color: #2563eb;
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 1rem;
          font-weight: 600;
          padding: 0.6rem 1.25rem;
          cursor: pointer;
          min-height: 44px;
          min-width: 44px;
          white-space: nowrap;
        }
        .btn-add:active {
          background-color: #1d4ed8;
        }
        .btn-import {
          background-color: #fff;
          color: #2563eb;
          border: 1px solid #2563eb;
          border-radius: 8px;
          font-size: 1rem;
          font-weight: 600;
          padding: 0.6rem 1.25rem;
          cursor: pointer;
          min-height: 44px;
          min-width: 44px;
          white-space: nowrap;
        }
        .btn-import:active {
          background-color: #eff6ff;
        }
        .empty-state {
          text-align: center;
          padding: 3rem 1rem;
          color: #6b7280;
        }
        .empty-icon {
          font-size: 3rem;
          margin-bottom: 0.75rem;
        }
        .empty-text {
          font-size: 1.1rem;
          margin-bottom: 0.5rem;
        }
        .empty-hint {
          font-size: 0.9rem;
          color: #9ca3af;
        }
        .timeline {
          list-style: none;
          position: relative;
        }
        .timeline::before {
          content: "";
          position: absolute;
          left: 20px;
          top: 0;
          bottom: 0;
          width: 2px;
          background-color: #e5e7eb;
          z-index: 0;
        }
        .timeline-item {
          position: relative;
          display: flex;
          flex-direction: column;
          padding-left: 52px;
          margin-bottom: 0.75rem;
          z-index: 1;
        }
        .step-circle {
          position: absolute;
          left: 0;
          top: 14px;
          width: 42px;
          height: 42px;
          border-radius: 50%;
          background-color: #2563eb;
          color: #fff;
          font-size: 0.875rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 2;
          flex-shrink: 0;
        }
        .item-card {
          background: #fff;
          border-radius: 10px;
          padding: 0.75rem 1rem;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
          border: 1px solid #e5e7eb;
          min-height: 72px;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }
        .item-top {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 0.5rem;
        }
        .item-name {
          font-size: 1rem;
          font-weight: 600;
          color: #111827;
          flex: 1;
          word-break: break-word;
        }
        .item-time {
          font-size: 0.8rem;
          color: #6b7280;
          margin-top: 0.1rem;
        }
        .item-actions {
          display: flex;
          gap: 0.25rem;
          flex-shrink: 0;
          margin-top: -0.1rem;
        }
        .icon-btn {
          background: none;
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          min-width: 36px;
          min-height: 36px;
          font-size: 1rem;
          color: #6b7280;
          padding: 0;
          transition: background-color 0.15s;
        }
        .icon-btn:active {
          background-color: #f3f4f6;
        }
        .icon-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        .icon-btn.danger {
          color: #dc2626;
          border-color: #fca5a5;
        }
        .reorder-group {
          display: flex;
          gap: 0.25rem;
          margin-top: 0.5rem;
          border-top: 1px solid #f3f4f6;
          padding-top: 0.5rem;
        }
        .confirm-row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-top: 0.5rem;
          padding: 0.5rem 0.75rem;
          background-color: #fef2f2;
          border-radius: 6px;
          border: 1px solid #fca5a5;
        }
        .confirm-text {
          font-size: 0.85rem;
          color: #dc2626;
          flex: 1;
        }
        .btn-confirm-delete {
          background-color: #dc2626;
          color: #fff;
          border: none;
          border-radius: 6px;
          font-size: 0.8rem;
          font-weight: 600;
          padding: 0.4rem 0.75rem;
          cursor: pointer;
          min-height: 36px;
          white-space: nowrap;
        }
        .btn-confirm-delete:active {
          background-color: #b91c1c;
        }
        .btn-cancel-delete {
          background: none;
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          font-size: 0.8rem;
          padding: 0.4rem 0.75rem;
          cursor: pointer;
          min-height: 36px;
          color: #6b7280;
        }
        .backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.45);
          z-index: 100;
          display: flex;
          align-items: flex-end;
          justify-content: center;
        }
        @media (min-width: 480px) {
          .backdrop {
            align-items: center;
          }
        }
        .modal {
          background: #fff;
          border-radius: 16px 16px 0 0;
          width: 100%;
          max-width: 480px;
          box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.15);
          /* Constrain to visible viewport so keyboard doesn't bury the sheet.
             dvh (dynamic viewport height) shrinks when the soft keyboard opens;
             vh fallback for browsers that don't support dvh yet. */
          max-height: 85vh;
          max-height: 85dvh;
          /* Flex column so title, scrollable body, and actions stack cleanly */
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        @media (min-width: 480px) {
          .modal {
            border-radius: 16px;
          }
        }
        .modal-title {
          font-size: 1.25rem;
          font-weight: 700;
          color: #1a1a2e;
          padding: 1.5rem 1.25rem 0;
          flex-shrink: 0;
          margin-bottom: 1.25rem;
        }
        /* Scrollable body — grows to fill available space between title and actions */
        .modal-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          padding: 0 1.25rem;
          /* scroll-padding keeps the focused input clear of the title bar */
          scroll-padding-top: 0.5rem;
        }
        .form-field {
          margin-bottom: 1rem;
        }
        .form-label {
          display: block;
          font-size: 0.875rem;
          font-weight: 600;
          color: #374151;
          margin-bottom: 0.4rem;
        }
        .form-input {
          width: 100%;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          padding: 0.7rem 0.875rem;
          font-size: 1rem;
          color: #111827;
          background: #fff;
          outline: none;
          min-height: 48px;
          font-family: inherit;
          box-sizing: border-box;
        }
        .form-input:focus {
          border-color: #2563eb;
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
        }
        .form-input.error {
          border-color: #dc2626;
        }
        .form-textarea {
          width: 100%;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          padding: 0.7rem 0.875rem;
          font-size: 0.9rem;
          color: #111827;
          background: #fff;
          outline: none;
          font-family: inherit;
          resize: vertical;
          min-height: 160px;
          box-sizing: border-box;
          line-height: 1.5;
        }
        .form-textarea:focus {
          border-color: #2563eb;
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
        }
        .form-error {
          font-size: 0.8rem;
          color: #dc2626;
          margin-top: 0.3rem;
        }
        .form-hint {
          font-size: 0.78rem;
          color: #9ca3af;
          margin-top: 0.25rem;
        }
        .modal-actions {
          display: flex;
          gap: 0.75rem;
          flex-shrink: 0;
          padding: 1rem 1.25rem;
          /* Keep safe distance from the home indicator on notched devices */
          padding-bottom: max(1rem, env(safe-area-inset-bottom));
          border-top: 1px solid #f3f4f6;
        }
        .btn-save {
          flex: 1;
          background-color: #2563eb;
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 1rem;
          font-weight: 600;
          padding: 0.75rem;
          cursor: pointer;
          min-height: 48px;
        }
        .btn-save:active {
          background-color: #1d4ed8;
        }
        .btn-cancel {
          flex: 1;
          background: none;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          font-size: 1rem;
          color: #374151;
          padding: 0.75rem;
          cursor: pointer;
          min-height: 48px;
        }
        .btn-cancel:active {
          background-color: #f3f4f6;
        }
      `}</style>

      <div className="plans-container">
        <div className="plans-header">
          <h1 className="plans-title">My Plans</h1>
          <div className="plans-header-actions">
            <button className="btn-import" onClick={openImport}>
              Import
            </button>
            <button className="btn-add" onClick={openAdd}>
              + Add
            </button>
          </div>
        </div>

        {items.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🗓</div>
            <p className="empty-text">No activities planned yet.</p>
            <p className="empty-hint">Tap &ldquo;+ Add&rdquo; to build your day.</p>
          </div>
        ) : (
          <ul className="timeline">
            {items.map((item, index) => (
              <li key={item.id} className="timeline-item">
                <div className="step-circle">{index + 1}</div>
                <div className="item-card">
                  <div className="item-top">
                    <div style={{ flex: 1 }}>
                      <div className="item-name">{item.name}</div>
                      {item.timeLabel && (
                        <div className="item-time">
                          {formatTimeLabel(item.timeLabel)}
                        </div>
                      )}
                    </div>
                    <div className="item-actions">
                      <button
                        className="icon-btn"
                        aria-label="Edit"
                        onClick={() => {
                          setDeleteConfirmId(null);
                          openEdit(item);
                        }}
                      >
                        ✏️
                      </button>
                      <button
                        className="icon-btn danger"
                        aria-label="Delete"
                        onClick={() =>
                          setDeleteConfirmId(
                            deleteConfirmId === item.id ? null : item.id
                          )
                        }
                      >
                        🗑
                      </button>
                    </div>
                  </div>

                  {deleteConfirmId === item.id && (
                    <div className="confirm-row">
                      <span className="confirm-text">Remove this activity?</span>
                      <button
                        className="btn-cancel-delete"
                        onClick={() => setDeleteConfirmId(null)}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn-confirm-delete"
                        onClick={() => handleDelete(item.id)}
                      >
                        Yes, delete
                      </button>
                    </div>
                  )}

                  <div className="reorder-group">
                    <button
                      className="icon-btn"
                      aria-label="Move up"
                      disabled={index === 0}
                      onClick={() => moveUp(index)}
                    >
                      ↑
                    </button>
                    <button
                      className="icon-btn"
                      aria-label="Move down"
                      disabled={index === items.length - 1}
                      onClick={() => moveDown(index)}
                    >
                      ↓
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {mode !== "view" && (
        <div className="backdrop" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">
              {mode === "add"
                ? "Add activity"
                : mode === "edit"
                ? "Edit activity"
                : "Import activities"}
            </h2>

            <div className="modal-body">
              {mode === "import" ? (
                <div className="form-field">
                  <label className="form-label" htmlFor="import-text">
                    Paste your schedule
                  </label>
                  <textarea
                    id="import-text"
                    className="form-textarea"
                    placeholder={
                      "One activity per line. Examples:\n" +
                      "Space Mountain 10am\n" +
                      "10:30 Haunted Mansion\n" +
                      "Fantasmic! 7:00pm-8:00pm\n" +
                      "10am-11am Morning Block"
                    }
                    value={importText}
                    onChange={(e) => {
                      setImportText(e.target.value);
                      if (importError) setImportError("");
                    }}
                    autoFocus
                  />
                  {importError && (
                    <p className="form-error">{importError}</p>
                  )}
                  <p className="form-hint">
                    Supports leading or trailing times in 24h (10:00) or AM/PM (10am, 10:00pm).
                    Ranges like 10am&ndash;11am or 10:00&ndash;11:00 are also supported.
                    Punctuation-only and time-only lines are skipped.
                  </p>
                </div>
              ) : (
                <>
                  <div className="form-field">
                    <label className="form-label" htmlFor="plan-name">
                      Activity name{" "}
                      <span style={{ color: "#dc2626" }}>*</span>
                    </label>
                    <input
                      id="plan-name"
                      className={`form-input${formError ? " error" : ""}`}
                      type="text"
                      placeholder="e.g. Space Mountain"
                      value={formName}
                      onChange={(e) => {
                        setFormName(e.target.value);
                        if (formError) setFormError("");
                      }}
                      autoFocus
                    />
                    {formError && <p className="form-error">{formError}</p>}
                  </div>

                  <div className="form-field">
                    <label className="form-label" htmlFor="plan-time">
                      Time window{" "}
                      <span style={{ color: "#9ca3af", fontWeight: 400 }}>
                        (optional)
                      </span>
                    </label>
                    <input
                      id="plan-time"
                      className="form-input"
                      type="text"
                      placeholder="e.g. Morning, 10:00 AM, 2:00 – 3:00 PM"
                      value={formTime}
                      onChange={(e) => setFormTime(e.target.value)}
                    />
                    <p className="form-hint">
                      Free text — use whatever label makes sense.
                    </p>
                  </div>
                </>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn-cancel" onClick={closeModal}>
                Cancel
              </button>
              <button
                className="btn-save"
                onClick={mode === "import" ? handleImport : handleSave}
              >
                {mode === "import" ? "Parse & Add" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

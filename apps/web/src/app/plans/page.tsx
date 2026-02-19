"use client";

import { useState, useEffect, useMemo } from "react";
import {
  mockAttractionWaits,
  type AttractionWait,
  type ResortId,
} from "@disney-wait-planner/shared";
import {
  normalizeEditTimeLabel,
  parseLine,
  formatTimeLabel,
  stripTrailingTimeTokens,
} from "@/lib/timeUtils";
import { getWaitBadgeProps } from "@/lib/waitBadge";
import { getWaitDatasetForResort, LIVE_ENABLED } from "@/lib/liveWaitApi";
import {
  normalizeKey,
  ALIASES_DLR,
  ALIASES_WDW,
  lookupWait,
} from "@/lib/plansMatching";

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

// ===== NAME POLISH HELPERS =====

/**
 * Strip a trailing "(en dash)" debug marker from an activity name, then trim.
 * "Snack / Rest (en dash)" → "Snack / Rest"
 * "Lunch (Plaza Inn)"      → unchanged
 * "Blah (en dash) extra"   → unchanged (not at end)
 */
function stripEnDashSuffix(name: string): string {
  return name.replace(/\s*\(en dash\)$/, "").trim();
}

/**
 * Minimal CSV row splitter that handles double-quoted fields with embedded
 * commas and escaped quotes (""). Returns an array of trimmed cell strings.
 * Malformed input (e.g. unterminated quote) returns whatever was parsed so far.
 */
function parseCSVRow(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) {
      // trailing comma produced an empty last cell — push and stop
      if (cells.length > 0) cells.push("");
      break;
    }
    if (line[i] === '"') {
      // Quoted field
      i++; // skip opening quote
      let cell = "";
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            cell += '"'; // escaped quote
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          cell += line[i++];
        }
      }
      cells.push(cell.trim());
      if (line[i] === ",") i++; // skip comma after quoted field
    } else {
      // Unquoted field
      const end = line.indexOf(",", i);
      if (end === -1) {
        cells.push(line.slice(i).trim());
        break;
      } else {
        cells.push(line.slice(i, end).trim());
        i = end + 1;
      }
    }
  }
  return cells;
}

// ===== LOCALSTORAGE PERSISTENCE =====

const STORAGE_KEY = "dwp.myPlans";
const SCHEMA_VERSION = 1;

function loadFromStorage(): PlanItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // v1 shape: { version: 1, items: [...] }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof parsed.version === "number" &&
      Array.isArray(parsed.items)
    ) {
      if (parsed.version === 1) {
        return parsed.items as PlanItem[];
      }
      // Unknown future version — start empty
      return [];
    }
    // v0 shape: raw array (unversioned legacy)
    if (Array.isArray(parsed)) {
      const migrated = { version: SCHEMA_VERSION, items: parsed };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      } catch {
        // best-effort migration write — ignore quota errors
      }
      return parsed as PlanItem[];
    }
    // Corrupt or unrecognised — start empty
    return [];
  } catch {
    return [];
  }
}

function saveToStorage(items: PlanItem[]): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, items })
    );
  } catch {
    // Quota or security errors must not crash the app
  }
}

// ===== AUTO-SORT =====

const SORT_KEY = "dwp.autoSort";

function loadSortPref(): boolean {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (!raw) return false;
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

/**
 * Extract the sort key (minutes from midnight) for a timeLabel.
 * Ranges use the start time. Untimed / free-text items sink to the bottom.
 */
function sortKey(timeLabel: string): number {
  if (!timeLabel) return Infinity;
  // Range "H:MM-H:MM" → sort by start
  const rangeMatch = timeLabel.match(/^(\d{1,2}:\d{2})-\d{1,2}:\d{2}$/);
  const token = rangeMatch ? rangeMatch[1] : timeLabel;
  const m = token.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return Infinity;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** Return a new array sorted earliest → latest. Stable for equal start times. */
function sortPlanItems(items: PlanItem[]): PlanItem[] {
  return items.slice().sort((a, b) => sortKey(a.timeLabel) - sortKey(b.timeLabel));
}

// ===== WAIT OVERLAY HELPERS =====

/** Resort labels shown in the toggle — matches Wait Times page. */
const RESORT_LABELS: Record<ResortId, string> = {
  DLR: "Disneyland Resort",
  WDW: "Walt Disney World",
};

// ===== RESORT PERSISTENCE =====

const STORAGE_RESORT_KEY = "dwp.selectedResort";

/** Read and validate resort from localStorage. Returns "DLR" on missing/invalid. */
function loadStoredResort(): ResortId {
  try {
    const v = localStorage.getItem(STORAGE_RESORT_KEY);
    if (v === "DLR" || v === "WDW") return v;
  } catch {}
  return "DLR";
}

/**
 * When true, a matched plan item displays the official attraction name
 * (from the wait dataset) as a secondary line below the plan title.
 * Stored plan data is never mutated or persisted.
 */
const DISPLAY_CANONICAL_RIDE_NAME = true;

// ===== COMPONENT =====

export default function PlansPage() {
  // Initial value is server-safe default; localStorage hydration runs in useEffect.
  const [selectedResort, setSelectedResort] = useState<ResortId>("DLR");
  const [items, setItems] = useState<PlanItem[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [autoSortEnabled, setAutoSortEnabled] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [mode, setMode] = useState<Mode>("view");
  const [editTarget, setEditTarget] = useState<PlanItem | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formTime, setFormTime] = useState("");
  const [formError, setFormError] = useState("");
  const [formTimeError, setFormTimeError] = useState("");
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");

  // Live wait data for the selected resort (all parks merged).
  // Empty when live is disabled; waitMap falls back to mock in that case.
  const [liveAttractions, setLiveAttractions] = useState<AttractionWait[]>([]);

  // Hydrate selectedResort from localStorage on client mount (runs once).
  useEffect(() => {
    setSelectedResort(loadStoredResort());
  }, []);

  // Persist selectedResort whenever it changes.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_RESORT_KEY, selectedResort); } catch {}
  }, [selectedResort]);

  // Fetch live wait data for all parks in the selected resort.
  // Uses the same TTL cache as the Wait Times page (results are shared).
  // No-ops when live API is disabled — waitMap falls back to mock.
  useEffect(() => {
    if (!LIVE_ENABLED) return;
    let cancelled = false;
    getWaitDatasetForResort(selectedResort).then(({ data }) => {
      if (!cancelled) setLiveAttractions(data);
    });
    return () => { cancelled = true; };
  }, [selectedResort]);

  // Build a deterministic wait lookup map scoped to selectedResort.
  // Source: live data (when enabled + available) or mock (fallback).
  // Keyed by normalizeKey(name); values carry status + waitMins.
  // Park-scoping within a resort is preserved: getWaitDatasetForResort
  // fetches each park independently, so cross-park collisions cannot occur
  // across resorts (DLR vs WDW), and same-name attractions within one
  // resort resolve deterministically (last writer wins, acceptable because
  // duplicate names within one resort do not exist in the dataset).
  const waitMap = useMemo(() => {
    const source =
      LIVE_ENABLED && liveAttractions.length > 0 ? liveAttractions : mockAttractionWaits;
    const map = new Map<string, { status: string; waitMins: number | null; canonicalName: string }>();
    for (const a of source) {
      if (a.resortId !== selectedResort) continue; // resort scope guard
      map.set(normalizeKey(a.name), {
        status: a.status,
        waitMins: a.waitMins,
        canonicalName: a.name,
      });
    }
    return map;
  }, [selectedResort, liveAttractions]);

  // Load saved plan and preferences from localStorage once on mount (client-side only)
  useEffect(() => {
    setItems(loadFromStorage());
    setAutoSortEnabled(loadSortPref());
    setInitialized(true);
  }, []);

  // Persist plan to localStorage on every mutation (after initial load)
  useEffect(() => {
    if (!initialized) return;
    saveToStorage(items);
  }, [items, initialized]);

  function openAdd() {
    setFormName("");
    setFormTime("");
    setFormError("");
    setFormTimeError("");
    setEditTarget(null);
    setMode("add");
  }

  function openEdit(item: PlanItem) {
    setFormName(item.name);
    setFormTime(item.timeLabel);
    setFormError("");
    setFormTimeError("");
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
    setFormTimeError("");
    setImportError("");
  }

  function handleSave() {
    let trimmed = formName.trim();
    if (!trimmed) {
      setFormError("Activity name is required.");
      return;
    }

    // Validate and normalize the time window field.
    // normalizeEditTimeLabel returns:
    //   ""    → no time (field was empty or cleared)
    //   "H:MM" / "H:MM-H:MM" → canonical 24h label
    //   null  → invalid input
    const rawTime = formTime.trim();
    let timeWindow = "";
    if (rawTime) {
      const normalized = normalizeEditTimeLabel(rawTime);
      if (normalized === null) {
        setFormTimeError("Enter a valid time (e.g. 3pm, 15:00, or 15:00-16:00).");
        return;
      }
      timeWindow = normalized;
    }

    // When saving with a time window, strip up to 2 trailing time tokens from
    // the name so accidental leftovers (e.g. "Space Mountain 10pm 22:00") are
    // cleaned. Guard: do not strip if it would empty the name.
    if (timeWindow) {
      const stripped = stripTrailingTimeTokens(trimmed, 2);
      if (stripped) trimmed = stripped;
    }

    // Strip trailing "(en dash)" debug marker if present, then re-validate.
    trimmed = stripEnDashSuffix(trimmed);
    if (!trimmed) {
      setFormError("Activity name is required.");
      return;
    }

    if (mode === "add") {
      setItems((prev) => {
        const next = [...prev, { id: makeId(), name: trimmed, timeLabel: timeWindow }];
        return autoSortEnabled ? sortPlanItems(next) : next;
      });
    } else if (mode === "edit" && editTarget) {
      setItems((prev) => {
        const next = prev.map((it) =>
          it.id === editTarget.id
            ? { ...it, name: trimmed, timeLabel: timeWindow }
            : it
        );
        return autoSortEnabled ? sortPlanItems(next) : next;
      });
    }
    closeModal();
  }

  // Shared pipeline for both paste and file import.
  // Normalizes Unicode dashes per-line before calling parseLine.
  function processImportText(text: string) {
    const lines = text.split("\n");
    const newItems: PlanItem[] = [];
    for (const line of lines) {
      const normalized = line.replace(/[\u2013\u2014]/g, "-");
      const parsed = parseLine(normalized);
      if (parsed) {
        newItems.push({
          id: makeId(),
          name: stripEnDashSuffix(parsed.name),
          timeLabel: parsed.timeLabel,
        });
      }
    }
    if (newItems.length === 0) {
      setImportError("No valid activities found. Check your text and try again.");
      return;
    }
    setItems((prev) => {
      const next = [...prev, ...newItems];
      return autoSortEnabled ? sortPlanItems(next) : next;
    });
    setImportText("");
    setMode("view");
  }

  function handleImport() {
    processImportText(importText);
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = (ev.target?.result as string) ?? "";
      processImportText(text);
    };
    reader.readAsText(file);
    // Reset so selecting the same file again triggers onChange
    e.target.value = "";
  }

  // Convert CSV rows into TXT-like lines and feed into the shared import pipeline.
  // Format A (2+ cols): "<timeLabel> <name>" constructed from first two cells.
  // Format B (1 col):   treat the single cell as a plain TXT line.
  function processCSVText(text: string) {
    const rows = text.split("\n");
    const txtLines: string[] = [];
    for (const row of rows) {
      const trimmedRow = row.trim();
      if (!trimmedRow) continue;
      try {
        const cells = parseCSVRow(trimmedRow);
        if (cells.length === 0) continue;
        // Skip exact CSV header rows (case-insensitive, trimmed comparison)
        const c0 = cells[0].toLowerCase();
        const c1 = cells.length >= 2 ? cells[1].toLowerCase() : "";
        if (cells.length >= 2 && c0 === "timelabel" && c1 === "name") continue;
        if (cells.length === 1 && c0 === "line") continue;
        if (cells.length >= 2 && cells[1]) {
          // Two-column: time + name → assemble TXT-style line
          const timeCell = cells[0];
          const nameCell = cells[1];
          txtLines.push(timeCell ? `${timeCell} ${nameCell}` : nameCell);
        } else if (cells[0]) {
          // Single column: treat as plain TXT line
          txtLines.push(cells[0]);
        }
      } catch {
        // Skip malformed rows without crashing
      }
    }
    // Delegate to existing pipeline (handles empty-result error, sort, persist)
    processImportText(txtLines.join("\n"));
  }

  function handleCSVFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = (ev.target?.result as string) ?? "";
      processCSVText(text);
    };
    reader.readAsText(file);
    e.target.value = "";
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

  function handleClearAll() {
    setItems([]);
    setDeleteConfirmId(null);
    setClearConfirm(false);
  }

  function handleToggleSort(checked: boolean) {
    setAutoSortEnabled(checked);
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(checked));
    } catch {
      // quota / security errors must not crash the app
    }
    // If enabling, re-sort the current list immediately
    if (checked) {
      setItems((prev) => sortPlanItems(prev));
    }
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
        .btn-clear {
          background-color: #fff;
          color: #dc2626;
          border: 1px solid #fca5a5;
          border-radius: 8px;
          font-size: 1rem;
          font-weight: 600;
          padding: 0.6rem 1.25rem;
          cursor: pointer;
          min-height: 44px;
          min-width: 44px;
          white-space: nowrap;
        }
        .btn-clear:active {
          background-color: #fef2f2;
        }
        .btn-clear:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        .clear-confirm-row {
          margin-bottom: 1rem;
        }
        .sort-toggle-row {
          display: flex;
          align-items: center;
          margin-bottom: 1rem;
        }
        .sort-toggle-label {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.875rem;
          color: #374151;
          cursor: pointer;
          min-height: 44px;
          user-select: none;
        }
        .sort-toggle-label input[type="checkbox"] {
          width: 18px;
          height: 18px;
          cursor: pointer;
          accent-color: #2563eb;
          flex-shrink: 0;
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
          word-break: break-word;
          overflow-wrap: break-word;
        }
        .item-canonical {
          font-size: 0.7rem;
          color: #9ca3af;
          font-style: italic;
          line-height: 1.3;
          margin-top: 0.1rem;
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
        .file-input-hidden {
          display: none;
        }
        .btn-file-label {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          background-color: #fff;
          color: #374151;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          font-size: 0.9rem;
          font-weight: 500;
          padding: 0.6rem 1rem;
          cursor: pointer;
          min-height: 44px;
          white-space: nowrap;
        }
        .btn-file-label:active {
          background-color: #f3f4f6;
        }
        .item-name-row {
          display: flex;
          align-items: baseline;
          flex-wrap: wrap;
          gap: 0.35rem;
        }
        /* Structural properties only — colors applied via inline style
           to stay in exact parity with the Wait Times page WaitBadge. */
        .wait-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 0.7rem;
          font-weight: 600;
          padding: 0.15rem 0.45rem;
          border-radius: 4px;
          white-space: nowrap;
          line-height: 1.4;
          flex-shrink: 0;
          min-width: 52px;
          text-align: center;
        }
        .wait-scope-label {
          font-size: 0.7rem;
          color: #9ca3af;
          margin: -0.4rem 0 0.75rem;
        }
        /* Resort toggle — matches Wait Times page visual style */
        .plans-resort-row {
          display: flex;
          gap: 8px;
          margin-bottom: 0.75rem;
        }
        .plans-resort-tab {
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
          min-height: 36px;
        }
      `}</style>

      <div className="plans-container">
        <div className="plans-header">
          <h1 className="plans-title">My Plans</h1>
          <div className="plans-header-actions">
            <button
              className="btn-clear"
              disabled={items.length === 0}
              onClick={() => setClearConfirm(true)}
            >
              Clear all
            </button>
            <button className="btn-import" onClick={openImport}>
              Import
            </button>
            <button className="btn-add" onClick={openAdd}>
              + Add
            </button>
          </div>
        </div>

        {/* Resort Toggle — scopes the wait overlay to the selected resort */}
        <div className="plans-resort-row">
          {(Object.keys(RESORT_LABELS) as ResortId[]).map((resortId) => (
            <button
              key={resortId}
              className="plans-resort-tab"
              onClick={() => setSelectedResort(resortId)}
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

        <div className="sort-toggle-row">
          <label className="sort-toggle-label">
            <input
              type="checkbox"
              checked={autoSortEnabled}
              onChange={(e) => handleToggleSort(e.target.checked)}
            />
            Auto-sort by time
          </label>
        </div>

        <p className="wait-scope-label">Wait overlay: {selectedResort}</p>

        {clearConfirm && (
          <div className="clear-confirm-row">
            <div className="confirm-row">
              <span className="confirm-text">Clear all activities?</span>
              <button
                className="btn-cancel-delete"
                onClick={() => setClearConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="btn-confirm-delete"
                onClick={handleClearAll}
              >
                Yes, clear all
              </button>
            </div>
          </div>
        )}

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
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="item-name-row">
                        <span className="item-name">{item.name}</span>
                        {(() => {
                          const w = lookupWait(item.name, waitMap, selectedResort === "DLR" ? ALIASES_DLR : ALIASES_WDW);
                          if (!w) return null;
                          const badge = getWaitBadgeProps({ status: w.status, waitMins: w.waitMins });
                          if (!badge) return null;
                          return (
                            <span
                              className="wait-badge"
                              style={badge.style}
                            >
                              {badge.label}
                            </span>
                          );
                        })()}
                      </div>
                      {DISPLAY_CANONICAL_RIDE_NAME && (() => {
                        const w = lookupWait(item.name, waitMap, selectedResort === "DLR" ? ALIASES_DLR : ALIASES_WDW);
                        if (!w || w.canonicalName === item.name) return null;
                        const hasLabel =
                          w.status === "DOWN" || w.status === "CLOSED" || w.waitMins != null;
                        if (!hasLabel) return null;
                        return (
                          <div className="item-canonical">{w.canonicalName}</div>
                        );
                      })()}
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
                  <p className="form-hint" style={{ marginBottom: "0.75rem" }}>
                    Supports leading or trailing times in 24h (10:00) or AM/PM (10am, 10:00pm).
                    Ranges like 10am&ndash;11am or 10:00&ndash;11:00 are also supported.
                    En/em dashes are handled automatically.
                    Punctuation-only and time-only lines are skipped.
                  </p>
                  <p className="form-hint" style={{ marginBottom: "0.4rem" }}>
                    — or upload a file —
                  </p>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <label className="btn-file-label" htmlFor="file-import">
                      📂 .txt file
                      <input
                        id="file-import"
                        type="file"
                        accept=".txt"
                        className="file-input-hidden"
                        onChange={handleFile}
                      />
                    </label>
                    <label className="btn-file-label" htmlFor="csv-import">
                      📊 .csv file
                      <input
                        id="csv-import"
                        type="file"
                        accept=".csv,text/csv"
                        className="file-input-hidden"
                        onChange={handleCSVFile}
                      />
                    </label>
                  </div>
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
                      className={`form-input${formTimeError ? " error" : ""}`}
                      type="text"
                      placeholder="e.g. 3pm, 15:00 or 15:00-16:00"
                      value={formTime}
                      onChange={(e) => {
                        setFormTime(e.target.value);
                        if (formTimeError) setFormTimeError("");
                      }}
                    />
                    {formTimeError ? (
                      <p className="form-error">{formTimeError}</p>
                    ) : (
                      <p className="form-hint">
                        Single time (3pm, 15:00, 1500) or range (3pm-4pm, 15:00-16:00).
                      </p>
                    )}
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

// ============================================================

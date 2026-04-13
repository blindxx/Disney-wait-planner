"use client";

/*
Async State Safety Notes
This component coordinates local plan editing with cloud synchronization.
Critical invariants:
• Debounced sync must never write stale state across auth/session transitions.
• Sync scheduling must respect the `initialized`, `syncReady`, and
  `sessionStatus === "authenticated"` gates.
• Pending sync operations must not overwrite newer edits.
• Plan item IDs must remain globally unique even after localStorage
  hydration or cloud plan hydration.
• Hydration ordering (local → cloud) must not cause ID reuse.
Reviewers should carefully check any changes affecting:
- debounce timing
- sync scheduling
- hydration logic
- plan item ID generation
- session/auth state transitions
*/

import { useState, useEffect, useMemo, useRef } from "react";
import {
  buildDayPlanExportPayload,
  buildPlannerBackupPayload,
  parseDayPlanImportPayload,
  parsePlannerBackupFile,
  type DayExportItem,
  type LightningBackupItem,
  type PlannerBackupPayload,
} from "@/lib/plansTransfer";
import {
  mockAttractionWaits,
  type AttractionWait,
  type ParkId,
  type ResortId,
} from "@disney-wait-planner/shared";
import {
  normalizeEditTimeLabel,
  parseLine,
  formatTimeLabel,
  stripTrailingTimeTokens,
} from "@/lib/timeUtils";
import { detectTimeConflicts } from "@/lib/timeConflicts";
import { getWaitBadgeProps } from "@/lib/waitBadge";
import { getWaitDatasetForResort, LIVE_ENABLED } from "@/lib/liveWaitApi";
import {
  normalizeKey,
  ALIASES_DLR,
  ALIASES_WDW,
  lookupWait,
} from "@/lib/plansMatching";
import { AttractionSuggestInput } from "@/components/AttractionSuggestInput";
import { getSettingsDefaults } from "@/lib/settingsDefaults";
import { inferPlansContext } from "@/lib/plansContextInference";
import { bootstrapProfiles, getActiveProfileKeys, getActiveProfile, getActiveProfileId, buildNamespacedKey } from "@/lib/profileStorage";
import { useSession } from "next-auth/react";
import {
  setSyncProfileId,
  scheduleSync,
  pullPlanner,
  registerUnloadSync,
  cancelScheduledSync,
} from "@/lib/syncHelper";

type PlanItem = {
  id: string;
  name: string;
  timeLabel: string;
  dayId: string; // Phase 8.0
};

type Mode = "view" | "add" | "edit" | "import" | "edit-day";

let nextId = 1;
function makeId() {
  return String(nextId++);
}

/** Advance nextId past any IDs already present in a hydrated item list. */
function reseedNextId(items: { id: string }[]): void {
  const maxId = items.reduce((max, item) => {
    const n = parseInt(item.id, 10);
    return isNaN(n) ? max : Math.max(max, n);
  }, 0);
  if (maxId >= nextId) nextId = maxId + 1;
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

function loadFromStorage(key: string = STORAGE_KEY): PlanItem[] {
  try {
    const raw = localStorage.getItem(key);
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
        localStorage.setItem(key, JSON.stringify(migrated));
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

function saveToStorage(items: PlanItem[], key: string = STORAGE_KEY): void {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ version: SCHEMA_VERSION, items })
    );
  } catch {
    // Quota or security errors must not crash the app
  }
}

// ===== DAY MANAGEMENT (Phase 8.0 / 8.0.1 / 8.0.2) =====

// Phase 8.0.5 — 1-based, no leading zeros: day-1, day-2, day-10 are valid;
// day-0, day-01, day-00 are not.
const VALID_DAY_ID_RE = /^day-([1-9]\d*)$/;

/**
 * Normalize any raw value to a canonical day ID (Phase 8.0.2).
 * - Non-string or empty/whitespace-only → "day-1"
 * - Trimmed value must match ^day-\d+$ or → "day-1"
 * - " day-3 " → "day-3" (trimmed before check)
 * - "banana" / "day-two" / "" → "day-1"
 */
function normalizeDayId(raw: unknown): string {
  if (typeof raw !== "string") return "day-1";
  const trimmed = raw.trim();
  return VALID_DAY_ID_RE.test(trimmed) ? trimmed : "day-1";
}

/**
 * Parse numeric suffix from a canonical day ID.
 * Uses VALID_DAY_ID_RE (^day-([1-9]\d*)$) so non-canonical values like
 * day-0 / day-01 return Infinity and sort after all valid day IDs.
 */
function parseDayNum(id: string): number {
  const m = VALID_DAY_ID_RE.exec(id);
  return m ? parseInt(m[1], 10) : Infinity;
}

/**
 * Sort comparator: canonical day IDs order by numeric suffix.
 * Uses direct comparison (not subtraction) so Infinity - Infinity = NaN
 * can never occur. Malformed values sort after all valid day IDs.
 */
function daySort(a: string, b: string): number {
  const aNum = parseDayNum(a);
  const bNum = parseDayNum(b);
  if (aNum === bNum) return a < b ? -1 : a > b ? 1 : 0;
  return aNum < bNum ? -1 : 1;
}

/**
 * Normalize dayId on every item.
 * Handles missing, empty, or non-string dayId values (Phase 8.0.1).
 * Returns the same array reference when no normalization is needed (idempotent).
 */
function migrateDayIds(items: PlanItem[]): PlanItem[] {
  const needsMigration = items.some(
    (it) => normalizeDayId(it.dayId as unknown) !== (it.dayId as unknown)
  );
  if (!needsMigration) return items;
  return items.map((it) => ({
    ...it,
    dayId: normalizeDayId(it.dayId as unknown),
  }));
}

// ===== DAY METADATA (Phase 8.1 — labels + dates) =====

type DayMeta = {
  label?: string; // Optional user-set label, e.g. "Magic Kingdom Day"
  date?: string;  // Optional ISO date (YYYY-MM-DD), informational only
};

/**
 * Strict calendar-date validator for YYYY-MM-DD strings (Phase 8.1.1).
 * Rejects impossible month/day combinations and JS Date rollover cases.
 * "2025-02-30", "2025-13-01", "9000-00-00" all return false.
 * Uses local Date constructor to avoid timezone shift.
 */
function isValidIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split("-");
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  // Quick range guard before Date construction (year floor: 2000+)
  if (y < 2000 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Cross-check: JS Date normalises overflow (Feb 30 → Mar 2). If the
  // resulting date's fields don't match the inputs, the date was invalid.
  const date = new Date(y, m - 1, d);
  return (
    date.getFullYear() === y &&
    date.getMonth() === m - 1 &&
    date.getDate() === d
  );
}

/**
 * Format an ISO date string (YYYY-MM-DD) as a short friendly date.
 * Returns "" when the value fails strict calendar validation.
 * Uses local Date construction to avoid timezone shift.
 * "2025-05-12" → "Mon, May 12"
 */
function formatDayDate(iso: string): string {
  if (!isValidIsoCalendarDate(iso)) return "";
  try {
    const parts = iso.split("-");
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

/**
 * Derive the display string for a day pill (Phase 8.1.1 — date-only fix).
 * - label + date → "Magic Kingdom Day — Mon, May 12"
 * - label only   → "Magic Kingdom Day"
 * - date only    → "Day 1 — Mon, May 12"
 * - neither      → "Day 1"
 */
function dayDisplayLabel(dayId: string, meta: Record<string, DayMeta>): string {
  const m = meta[dayId];
  const label = m?.label?.trim();
  const date = m?.date;
  // Use custom label if set, otherwise fall back to "Day N"
  const baseLabel = label || dayLabelFromId(dayId);
  if (date) {
    const formatted = formatDayDate(date);
    if (formatted) return `${baseLabel} — ${formatted}`;
  }
  return baseLabel;
}

function loadDayMeta(key: string): Record<string, DayMeta> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, DayMeta> = {};
    for (const [dayId, rawMeta] of Object.entries(parsed as Record<string, unknown>)) {
      // Ignore any key that isn't a valid canonical day ID
      if (!VALID_DAY_ID_RE.test(dayId)) continue;
      if (typeof rawMeta !== "object" || rawMeta === null) continue;
      const entry = rawMeta as Record<string, unknown>;
      const label = typeof entry.label === "string" ? entry.label.trim() : "";
      const rawDate = typeof entry.date === "string" ? entry.date.trim() : "";
      // Only accept strict calendar-valid dates; silently discard anything else
      const date = isValidIsoCalendarDate(rawDate) ? rawDate : "";
      if (label || date) {
        result[dayId] = {
          ...(label ? { label } : {}),
          ...(date ? { date } : {}),
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveDayMeta(meta: Record<string, DayMeta>, key: string): void {
  try {
    localStorage.setItem(key, JSON.stringify(meta));
  } catch {}
}

/** "day-1" → "Day 1", "day-3" → "Day 3". Falls back to the raw id. */
function dayLabelFromId(dayId: string): string {
  const n = parseInt(dayId.split("-")[1], 10);
  return isNaN(n) ? dayId : `Day ${n}`;
}

function loadDays(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return ["day-1"];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      // Phase 8.0.3 — normalize each entry through strict canonical check,
      // dedupe, sort, then guarantee "day-1" baseline.
      const sanitized = [
        ...new Set(
          (parsed as unknown[])
            .map((d) => normalizeDayId(d))
            .filter((d) => d !== "day-1") // collect non-baseline first
        ),
      ];
      return ["day-1", ...sanitized].sort(daySort);
    }
    return ["day-1"];
  } catch {
    return ["day-1"];
  }
}

function saveDays(days: string[], key: string): void {
  try {
    localStorage.setItem(key, JSON.stringify(days));
  } catch {}
}

function loadActiveDayId(key: string): string {
  // Phase 8.0.4 — route through strict normalizeDayId so invalid stored
  // values (arbitrary strings, whitespace, non-string) become "day-1".
  try {
    return normalizeDayId(localStorage.getItem(key));
  } catch {
    return "day-1";
  }
}

function saveActiveDayId(dayId: string, key: string): void {
  // Phase 8.0.4 — normalize before write so storage stays canonical.
  try {
    localStorage.setItem(key, normalizeDayId(dayId));
  } catch {}
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

/** Friendly park name for the park-line display on plan cards. */
const PARK_LABELS: Record<ParkId, string> = {
  disneyland: "Disneyland",
  dca: "Disney California Adventure",
  mk: "Magic Kingdom",
  epcot: "EPCOT",
  hs: "Hollywood Studios",
  ak: "Animal Kingdom",
};

/** Ordered list of parks per resort — drives the park selector UI. */
const RESORT_PARKS: Record<ResortId, ParkId[]> = {
  DLR: ["disneyland", "dca"],
  WDW: ["mk", "epcot", "hs", "ak"],
};

// ===== RESORT PERSISTENCE =====

const STORAGE_RESORT_KEY = "dwp.selectedResort";
const STORAGE_PARK_KEY = "dwp.selectedPark";

/** Parks that belong to each resort — used to derive resort from a stored park. */
const PARK_TO_RESORT: Partial<Record<string, ResortId>> = {
  disneyland: "DLR",
  dca: "DLR",
  mk: "WDW",
  epcot: "WDW",
  hs: "WDW",
  ak: "WDW",
};

/**
 * Read and validate resort from localStorage.
 * Falls back to Settings default resort (which itself falls back to "DLR").
 * Only uses settings default when no page-specific stored value exists.
 */
function loadStoredResort(key: string = STORAGE_RESORT_KEY): ResortId {
  try {
    const v = localStorage.getItem(key);
    if (v === "DLR" || v === "WDW") return v;
  } catch {}
  return getSettingsDefaults().defaultResort;
}

/**
 * Check whether either session context key exists in localStorage.
 * If true, inference must be skipped.
 * Returns the stored resort and park (park is null if absent or invalid for resort).
 */
function readSessionContext(
  resortKey: string = STORAGE_RESORT_KEY,
  parkKey: string = STORAGE_PARK_KEY,
): { exists: boolean; resort: ResortId; park: ParkId | null } {
  try {
    const storedResort = localStorage.getItem(resortKey);
    const storedPark = localStorage.getItem(parkKey);
    const hasResort = storedResort === "DLR" || storedResort === "WDW";
    const haspark = !!storedPark && storedPark in PARK_TO_RESORT;

    if (hasResort || haspark) {
      // Derive resort: explicit resort key wins; fall back to deriving from park.
      const resort: ResortId =
        hasResort
          ? (storedResort as ResortId)
          : (PARK_TO_RESORT[storedPark!] ?? getSettingsDefaults().defaultResort);
      // Validate stored park against the resolved resort to prevent cross-resort mismatch.
      const park: ParkId | null =
        haspark && RESORT_PARKS[resort].includes(storedPark as ParkId)
          ? (storedPark as ParkId)
          : null;
      return { exists: true, resort, park };
    }
  } catch {}
  return { exists: false, resort: getSettingsDefaults().defaultResort, park: null };
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
  // Prevents resort selector from briefly showing DLR when WDW is stored.
  const [ready, setReady] = useState(false);
  const [items, setItems] = useState<PlanItem[]>([]);
  // Ref that always holds the latest items — used inside async callbacks to avoid
  // stale closure snapshots (e.g. deciding empty/non-empty in handleDayImportFile).
  const itemsRef = useRef<PlanItem[]>([]);
  itemsRef.current = items;
  const [initialized, setInitialized] = useState(false);

  // Profile-aware storage key refs — set once on mount after bootstrapProfiles().
  // Using refs ensures the values are stable across re-renders and available
  // in all effects without adding them as dependencies.
  const planKeyRef = useRef(STORAGE_KEY);
  const resortKeyRef = useRef(STORAGE_RESORT_KEY);
  const parkKeyRef = useRef(STORAGE_PARK_KEY);
  // Stable ref to the active profile id — used by sync effects to target the
  // correct cloud record and to initialise the module-level sync target.
  const activeProfileIdRef = useRef("default");
  // Phase 8.0 — per-profile day storage key refs
  const activeDayKeyRef = useRef("dwp:default:activeDayId");
  const daysKeyRef = useRef("dwp:default:days");

  const [activeProfileName, setActiveProfileName] = useState<string | null>(null);

  // Auth session — used to trigger cloud pull on sign-in
  const { status: sessionStatus } = useSession();
  // Tracks whether the user made a local edit after the current pull started.
  // Reset to false each time a new pull begins; set to true on any mutation.
  // The pull callback checks this before applying cloud state so it never
  // overwrites edits that happened while the GET was in flight.
  const localEditRef = useRef(false);
  // Gate: ensures context inference runs at most once per page load.
  const contextInferredRef = useRef(false);
  // Gate: set by import pipelines (processImportText) to signal that the
  // items-watcher should run inference even when session context keys exist.
  // Only real import flows set this — manual add/edit paths do not.
  // Consumed (reset to false) immediately after the watcher reads it.
  const importJustRanRef = useRef(false);
  // Monotonic counter for JSON import requests. Only the latest request's
  // FileReader callback is allowed to commit state, preventing stale results
  // from a previous (slower) import from overwriting a more recent import.
  const jsonImportRequestRef = useRef(0);
  // Tracks how many items existed when the page first mounted. Used to
  // distinguish ordinary revisits (existing plans) from true import-triggered
  // inference events (items went from zero to non-zero in this lifecycle).
  const initialItemCountRef = useRef(0);
  // Gate: prevents scheduleSync() from running until the initial cloud pull
  // resolves. Stays false while authenticated session status is loading or
  // while the GET /api/sync/plans request is in-flight. Set true after pull
  // completes (authenticated path) or immediately (unauthenticated path).
  const [syncReady, setSyncReady] = useState(false);
  // Phase 8.0 — multi-day state (default to day-1; hydrated from storage on mount)
  const [activeDayId, setActiveDayId] = useState<string>("day-1");
  const [days, setDays] = useState<string[]>(["day-1"]);
  // Phase 8.1 — day metadata (labels + dates) and per-profile storage key
  const dayMetaKeyRef = useRef("dwp:default:dayMeta");
  const [dayMeta, setDayMeta] = useState<Record<string, DayMeta>>({});
  // Phase 8.1 — day control UI state
  // removeConfirmDayId: the day whose removal is pending confirmation (null = no pending)
  const [removeConfirmDayId, setRemoveConfirmDayId] = useState<string | null>(null);
  // clearDayTargetId: the specific day ID to clear (null = no pending clear-day action).
  // Carries the intended target explicitly so modal and header actions cannot cross-target.
  const [clearDayTargetId, setClearDayTargetId] = useState<string | null>(null);
  // Phase 8.1 — edit-day modal state
  const [editingDayId, setEditingDayId] = useState<string | null>(null);
  const [editDayLabel, setEditDayLabel] = useState("");
  const [editDayDate, setEditDayDate] = useState("");
  const [editDayDateError, setEditDayDateError] = useState("");
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

  // Phase 8.2 — Day import confirmation state (shown when active day has items).
  // targetDayId is captured at file-selection time to prevent drift if the user
  // switches active day between file pick and confirmation (fix D).
  const [pendingDayImportItems, setPendingDayImportItems] = useState<{
    items: DayExportItem[];
    targetDayId: string;
    existingCount: number;
  } | null>(null);
  const [dayImportError, setDayImportError] = useState("");
  // Stale-request guard for day JSON import (same pattern as jsonImportRequestRef)
  const dayImportRequestRef = useRef(0);
  // Refs for the three modal import file inputs (separate accept filters per type)
  const modalTxtInputRef = useRef<HTMLInputElement>(null);
  const modalCsvInputRef = useRef<HTMLInputElement>(null);
  const modalJsonInputRef = useRef<HTMLInputElement>(null);

  // Phase 8.2 — Backup / Restore modal state
  const [showBackupRestore, setShowBackupRestore] = useState(false);
  const [backupRestoreError, setBackupRestoreError] = useState("");
  const [restoreConfirmPayload, setRestoreConfirmPayload] = useState<PlannerBackupPayload | null>(null);
  // Stale-request guard for restore file reads
  const restoreRequestRef = useRef(0);

  // Live wait data for the selected resort (all parks merged).
  // Empty when live is disabled; waitMap falls back to mock in that case.
  const [liveAttractions, setLiveAttractions] = useState<AttractionWait[]>([]);
  // Active park shown in the park selector. Set by inference or manual selection.
  // Defaults to the first park of the resolved resort after initialization.
  // Reset to the first park of the new resort when the user switches resort.
  const [selectedPark, setSelectedPark] = useState<ParkId | null>(null);

  // Phase 7.3 — Context priority model (runs once on mount, client-side only).
  // Priority 1: Session context (dwp.selectedResort or dwp.selectedPark exists) → use it.
  // Priority 2: Infer resort from plans dataset (one-time bootstrap, no re-runs).
  // Priority 3: Settings defaults fallback.
  // Sets ready=true after resolution to prevent selector flicker.
  // NOTE: combined with plans loading below so inference can access loaded plans.

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

  // Park name lookup: canonical normalized name → friendly park label.
  // Built from the same source data as waitMap — no extra fetch.
  const parkMap = useMemo(() => {
    const source =
      LIVE_ENABLED && liveAttractions.length > 0 ? liveAttractions : mockAttractionWaits;
    const map = new Map<string, string>();
    for (const a of source) {
      if (a.resortId !== selectedResort) continue;
      map.set(normalizeKey(a.name), PARK_LABELS[a.parkId] ?? a.parkId);
    }
    return map;
  }, [selectedResort, liveAttractions]);

  // Canonical attraction names for autocomplete in the add/edit modal.
  const suggestions = useMemo(
    () => Array.from(waitMap.values()).map((v) => v.canonicalName),
    [waitMap]
  );

  // Phase 8.0 — Items visible in the current day (display-only; storage unchanged).
  const displayedItems = useMemo(
    () => items.filter((it) => it.dayId === activeDayId),
    [items, activeDayId]
  );

  // Phase 8.1 — item counts per day for the day selector display.
  const itemCountByDay = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const it of items) {
      counts[it.dayId] = (counts[it.dayId] ?? 0) + 1;
    }
    return counts;
  }, [items]);

  // Compute time conflict sets scoped to the active day only (Phase 8.0.3).
  // Previously used `items` (all days), which produced false overlap warnings
  // between plans on different days. Now uses displayedItems so conflicts are
  // day-local. Switches days recompute correctly via displayedItems dependency.
  // Parses timeLabel into start/end for each item that has a canonical "H:MM" or
  // "H:MM-H:MM" label; free-text or empty labels are skipped (non-overlapping).
  const { invalidIds, overlapCountById } = useMemo(() => {
    const conflictInput = displayedItems.flatMap((item) => {
      if (!item.timeLabel) return [];
      const rangeMatch = item.timeLabel.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
      if (rangeMatch) return [{ id: item.id, start: rangeMatch[1], end: rangeMatch[2] }];
      if (/^\d{1,2}:\d{2}$/.test(item.timeLabel)) return [{ id: item.id, start: item.timeLabel }];
      return [];
    });
    const { invalidRanges, overlaps } = detectTimeConflicts(conflictInput);
    const overlapCountById: Record<string, number> = {};
    for (const { a, b } of overlaps) {
      overlapCountById[a] = (overlapCountById[a] ?? 0) + 1;
      overlapCountById[b] = (overlapCountById[b] ?? 0) + 1;
    }
    return {
      invalidIds: new Set(invalidRanges),
      overlapCountById,
    };
  }, [displayedItems]);

  // Load saved plan and preferences from localStorage once on mount (client-side only).
  // After loading, reseed nextId to be greater than any persisted item ID so
  // that newly created items never collide with hydrated ones (avoids React key
  // collisions and incorrect edit/delete behaviour after a page reload).
  // Also applies the Phase 7.3 context priority model (see comment above):
  //   Priority 1 → Session context keys exist in localStorage → use stored resort.
  //   Priority 2 → Infer resort/park from loaded plans (one-time, runs here since
  //                plans are available; guarded by contextInferredRef).
  //   Priority 3 → Settings defaults.
  useEffect(() => {
    // Bootstrap profiles system and resolve namespaced keys for this page load.
    bootstrapProfiles();
    const profileKeys = getActiveProfileKeys();
    planKeyRef.current = profileKeys.plans;
    resortKeyRef.current = profileKeys.selectedResort;
    parkKeyRef.current = profileKeys.selectedPark;
    setActiveProfileName(getActiveProfile().name);
    const currentProfileId = getActiveProfileId();
    activeProfileIdRef.current = currentProfileId;
    // Phase 8.0 — set per-profile day storage keys
    activeDayKeyRef.current = buildNamespacedKey(currentProfileId, "activeDayId");
    daysKeyRef.current = buildNamespacedKey(currentProfileId, "days");
    // Phase 8.1 — set per-profile day metadata key
    dayMetaKeyRef.current = buildNamespacedKey(currentProfileId, "dayMeta");
    // Retarget the module-level sync to this profile; cancels any pending work
    // from a prior profile (safe no-op on first mount).
    setSyncProfileId(currentProfileId);

    // Load plans, run Phase 8.0 dayId migration (idempotent), persist if needed.
    const rawLoaded = loadFromStorage(planKeyRef.current);
    const loaded = migrateDayIds(rawLoaded);
    if (loaded !== rawLoaded) {
      // Migration ran — persist migrated items so next load is clean.
      saveToStorage(loaded, planKeyRef.current);
    }
    // Record how many items existed at mount. The post-import effect uses this
    // to distinguish ordinary page revisits (pre-existing plans) from true
    // import-triggered events where inference is allowed.
    initialItemCountRef.current = loaded.length;
    if (loaded.length > 0) reseedNextId(loaded);
    setItems(loaded);

    // Phase 8.0 — Load days list and active day for this profile.
    // Phase 8.0.1 — Merge dayIds actually present in items into stored list
    // so synced/imported items with day-2/day-3 always appear in the selector.
    const storedDays = loadDays(daysKeyRef.current);
    const storedActiveDayId = loadActiveDayId(activeDayKeyRef.current);
    const itemDayIds = [...new Set(loaded.map((it) => it.dayId))];
    const mergedDays = [...new Set(["day-1", ...storedDays, ...itemDayIds])].sort(daySort);
    if (mergedDays.join(",") !== storedDays.join(",")) {
      saveDays(mergedDays, daysKeyRef.current);
    }
    const validActiveDayId = mergedDays.includes(storedActiveDayId)
      ? storedActiveDayId
      : mergedDays[0];
    // Phase 8.0.4 — self-heal: if the stored active day was unusable and we
    // fell back to a different value, persist the corrected value immediately
    // so subsequent reloads resolve without re-fallbacking.
    if (validActiveDayId !== storedActiveDayId) {
      saveActiveDayId(validActiveDayId, activeDayKeyRef.current);
    }
    setDays(mergedDays);
    setActiveDayId(validActiveDayId);
    // Phase 8.1 — load day metadata (labels + dates)
    setDayMeta(loadDayMeta(dayMetaKeyRef.current));
    setAutoSortEnabled(loadSortPref());
    setInitialized(true);

    // --- Context priority resolution ---
    const session = readSessionContext(resortKeyRef.current, parkKeyRef.current);

    if (session.exists) {
      // Priority 1: session context key(s) exist — respect them, skip inference.
      // Lock the inference gate only when items existed at mount (ordinary revisit
      // with existing plans). If mounted with empty plans, leave the gate open so
      // a subsequent import can still run inference as a true bootstrap event.
      if (loaded.length > 0) {
        contextInferredRef.current = true;
      }
      setSelectedResort(session.resort);
      setSelectedPark(session.park ?? RESORT_PARKS[session.resort][0]);
      setReady(true);
      return;
    }

    // Priority 2 (removed): existing plans at mount no longer trigger inference.
    // Inference is import-triggered only — ordinary page visits with pre-existing
    // plans must not reassert inferred context over active session or defaults.

    // Priority 3: settings defaults.
    const { defaultResort, defaultPark } = getSettingsDefaults();
    setSelectedResort(defaultResort);
    // Prefer the stored default park if it belongs to the resolved resort,
    // then fall back to the first park in the resort list.
    const p3Park = RESORT_PARKS[defaultResort].find((p) => p === defaultPark)
      ? defaultPark
      : RESORT_PARKS[defaultResort][0];
    setSelectedPark(p3Park as ParkId);
    setReady(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phase 7.3.1 — Post-import inference trigger.
  // Runs inference when plans first become available after the page is already
  // initialized (e.g. the user imports a plan while the Plans page is open).
  // The initialization effect above only covers plans that existed at mount time;
  // this effect covers the case where plans arrive later.
  //
  // Guards (ALL must be true to proceed):
  //   1. initialized — page has fully hydrated
  //   2. contextInferredRef.current === false — inference has not already run
  //   3. items.length > 0 — plans are now available
  //   4. no session context — explicit selection always wins
  //
  // Marks contextInferredRef=true on first execution regardless of result,
  // so subsequent items changes (edits, deletions) never re-trigger inference.
  useEffect(() => {
    if (!initialized) return;
    if (contextInferredRef.current) return;
    // Consume the import flag unconditionally so it is always reset even when
    // an early-return guard fires (e.g. initialItemCountRef.current > 0 when
    // the user imports while they already had items). Leaving it true would
    // let a later non-import items change (e.g. after Clear All resets
    // initialItemCountRef to 0) incorrectly bypass session-context precedence.
    const isImport = importJustRanRef.current;
    importJustRanRef.current = false;
    // Only allow inference on a true fresh-import event: items went from zero
    // to non-zero during this page lifecycle. Items that existed at mount
    // (initialItemCountRef.current > 0) represent an ordinary page revisit —
    // existing plans must not reassert inferred context on simple page visits.
    if (items.length === 0 || initialItemCountRef.current > 0) return;

    const session = readSessionContext(resortKeyRef.current, parkKeyRef.current);
    // Explicit session context exists — mark resolved and skip inference.
    // Exception: if this is a real import flow (importJustRanRef was true),
    // allow inference to proceed even when a manual selection wrote session
    // keys, because import is a deliberate restore action.
    // Manual add/edit/delete flows never set importJustRanRef, so they always
    // respect the existing explicit session context.
    if (session.exists && !isImport) {
      contextInferredRef.current = true;
      return;
    }

    // Run inference (one-time).
    contextInferredRef.current = true;
    const inferred = inferPlansContext(items);
    if (inferred.resort) {
      setSelectedResort(inferred.resort);
      const resolvedPark = (inferred.park ?? RESORT_PARKS[inferred.resort][0]) as ParkId;
      setSelectedPark(resolvedPark);
      // Phase 7.3.4: persist inferred context immediately to session keys
      try { localStorage.setItem(resortKeyRef.current, inferred.resort); } catch {}
      try { localStorage.setItem(parkKeyRef.current, resolvedPark); } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, initialized]);

  // Persist to localStorage on every items mutation (after initial load).
  // Also marks localEditRef so any in-flight pull sees the edit and skips
  // overwriting it. Kept separate from the sync effect so that syncReady
  // state changes don't trigger localEditRef (only real items changes do).
  useEffect(() => {
    if (!initialized) return;
    localEditRef.current = true;
    saveToStorage(items, planKeyRef.current);
  }, [items, initialized]);

  // Schedule a debounced cloud push after every items change, but only once
  // syncReady is true (initial cloud pull has resolved) AND the user is
  // authenticated. Unauthenticated edits are local-only — no network calls.
  // NOTE: no unmount cleanup here intentionally — cancelling on unmount would
  // silently drop the pending push on SPA navigation before the debounce fires,
  // because beforeunload does not fire on in-app route changes. Auth/session
  // transitions are already protected by the syncReady gate and the separate
  // loading/unauthenticated branches in the effect below.
  useEffect(() => {
    if (!initialized || !syncReady || sessionStatus !== "authenticated") return;
    scheduleSync();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, initialized, syncReady, sessionStatus]);

  // Manage syncReady gate based on auth state transitions.
  // loading      → gate resets to false immediately; guards against re-auth races
  //                where the user was previously unauthenticated (syncReady=true).
  // authenticated → gate resets to false, pull resolves, then gate opens.
  // unauthenticated → gate opens immediately (local-only, no cloud pull needed).
  useEffect(() => {
    if (sessionStatus === "loading") {
      // Cancel any queued debounced push from a prior signed-out session
      // before entering the loading state — prevents stale local data from
      // being sent while we don't yet know the final auth state.
      cancelScheduledSync();
      setSyncReady(false);
      return;
    }
    if (sessionStatus === "unauthenticated") {
      setSyncReady(true);
      return;
    }
    // authenticated
    if (!initialized) return;
    // Cancel any pending debounced push before starting the cloud pull so a
    // queued stale PUT cannot fire during the initial pull window.
    cancelScheduledSync();
    // Cancellation flag: React sets this to true when the effect re-runs
    // (i.e. sessionStatus or initialized changed). Any in-flight pullPlans()
    // that resolves after the flag is set will be ignored, preventing stale
    // cloud data from overwriting local state mid-auth-transition.
    let cancelled = false;
    // Reset the local-edit guard so the upcoming pull starts with a clean slate.
    // If the user edits anything while the pull is in flight, localEditRef
    // flips back to true and we skip applying the cloud result.
    localEditRef.current = false;
    setSyncReady(false);
    const profileKeysForPull = getActiveProfileKeys();
    void pullPlanner(activeProfileIdRef.current)
      .then((planner) => {
        if (cancelled) return;
        // Extract the plans portion from the combined planner payload.
        const cloud = planner?.plans ?? null;
        // Only apply cloud data if no local edits occurred while the pull was
        // in flight. Either way, open the sync gate so edits can push.
        if (!localEditRef.current && cloud) {
          // Phase 8.0.1 — normalize dayIds from cloud before applying to state.
          const cloudItems = migrateDayIds(cloud.items as PlanItem[]);
          reseedNextId(cloudItems);
          setItems(cloudItems);
          // Merge cloud item day IDs into the days list.
          // Uses functional setDays(prev) — this is an async .then() callback
          // so `days` from the outer closure may be stale; `prev` is always fresh.
          const cloudDayIds = [...new Set(cloudItems.map((it) => it.dayId))];
          setDays((prev) => {
            const next = [...new Set([...prev, ...cloudDayIds])].sort(daySort);
            if (next.join(",") === prev.join(",")) return prev;
            saveDays(next, daysKeyRef.current);
            return next;
          });
          // Phase 7.3.6: if no explicit session context exists, allow the
          // items-watcher to re-run inference once on the authoritative cloud
          // dataset. The mount-time inference ran on stale local plans; the
          // cloud pull is the definitive source for this page load.
          if (!readSessionContext(resortKeyRef.current, parkKeyRef.current).exists) {
            contextInferredRef.current = false;
            // If the cloud pull cleared all items, this page is effectively in
            // a fresh-import-ready state. Reset the mount-count guard so that
            // a subsequent import correctly triggers inference.
            if (cloudItems.length === 0) {
              initialItemCountRef.current = 0;
            }
          }
        }
        // Phase 7.6.3 — Sync Hydration Safety: hydrate lightning into localStorage
        // so sync pushes always include a complete dataset regardless of which page loads first.
        // Phase 7.6.4 — Hydration Guard: only open syncReady when the opposite-dataset
        // write succeeds. A failed write leaves the key missing, which syncHelper would
        // treat as empty data on the next push — potentially overwriting valid cloud state.
        let hydrationSucceeded = true;
        if (typeof window !== "undefined") {
          if (planner?.lightning) {
            try {
              localStorage.setItem(
                profileKeysForPull.lightning,
                JSON.stringify(planner.lightning)
              );
            } catch {
              hydrationSucceeded = false;
            }
          }
        }
        if (hydrationSucceeded) setSyncReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        // Network or server error — cloud state is unknown (not definitively
        // empty). Keep the push gate closed to avoid overwriting cloud data
        // with potentially stale local plans. Gate reopens on the next auth
        // cycle (sign-out + sign-in, or page reload).
      });
    return () => { cancelled = true; };
  }, [sessionStatus, initialized]);

  // Register a best-effort sendBeacon push on page unload.
  // Requires both syncReady (initial pull resolved) AND authenticated session.
  // Signed-out users have syncReady=true (local-only path) but must not send
  // a beacon that would just receive a 401 and waste the unload budget.
  useEffect(() => {
    if (!syncReady || sessionStatus !== "authenticated") return;
    const cleanup = registerUnloadSync();
    return cleanup;
  }, [syncReady, sessionStatus]);

  // Phase 8.0 — create the next sequential day and switch to it.
  // Computes directly from current rendered days state; no functional updater
  // captures, no side effects inside updater callbacks.
  function handleAddDay() {
    // Phase 8.0.10 — resolve profile keys at write time so a profile switch
    // between mount and this click always targets the correct namespace.
    const _profileId = getActiveProfileId();
    const _daysKey = buildNamespacedKey(_profileId, "days");
    const _activeDayKey = buildNamespacedKey(_profileId, "activeDayId");
    daysKeyRef.current = _daysKey;
    activeDayKeyRef.current = _activeDayKey;

    const nums = days
      .map((d) => parseInt(d.split("-")[1], 10))
      .filter((n) => !isNaN(n));
    const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 2;
    const candidate = `day-${nextNum}`;
    if (days.includes(candidate)) return; // already exists — no-op
    const nextDays = [...days, candidate].sort(daySort);
    setDays(nextDays);
    saveDays(nextDays, _daysKey);
    setActiveDayId(candidate);
    saveActiveDayId(candidate, _activeDayKey);
  }

  // Phase 8.1 — open the edit-day label/date modal for a specific day.
  function openEditDay(dayId: string) {
    // Clear any pending destructive confirms so they cannot remain active
    // behind the modal or reappear immediately after closing.
    setRemoveConfirmDayId(null);
    setClearDayTargetId(null);
    setClearConfirm(false);
    const m = dayMeta[dayId];
    setEditingDayId(dayId);
    setEditDayLabel(m?.label ?? "");
    setEditDayDate(m?.date ?? "");
    setEditDayDateError("");
    setMode("edit-day");
  }

  // Phase 8.1 — save label and/or date for the currently edited day.
  function handleSaveDayMeta() {
    const dayId = editingDayId;
    if (!dayId) return;
    const trimmedLabel = editDayLabel.trim();
    const trimmedDate = editDayDate.trim();
    // Validate: must be a strict calendar-valid date, not just a matching regex
    if (trimmedDate && !isValidIsoCalendarDate(trimmedDate)) {
      setEditDayDateError("Enter a valid date as YYYY-MM-DD (e.g. 2025-05-12).");
      return;
    }
    const _profileId = getActiveProfileId();
    const _dayMetaKey = buildNamespacedKey(_profileId, "dayMeta");
    dayMetaKeyRef.current = _dayMetaKey;
    const nextMeta = { ...dayMeta };
    if (!trimmedLabel && !trimmedDate) {
      delete nextMeta[dayId];
    } else {
      nextMeta[dayId] = {
        ...(trimmedLabel ? { label: trimmedLabel } : {}),
        ...(trimmedDate ? { date: trimmedDate } : {}),
      };
    }
    setDayMeta(nextMeta);
    saveDayMeta(nextMeta, _dayMetaKey);
    closeModal();
  }

  // Phase 8.1 — remove a day entirely. Must not be the last day or day-1.
  // Preserves canonical IDs of remaining days; does NOT reindex.
  function handleRemoveDay(dayId: string) {
    if (dayId === "day-1") return;   // Day 1 is a permanent base day
    if (days.length <= 1) return;   // Cannot remove the last day
    const _profileId = getActiveProfileId();
    const _daysKey = buildNamespacedKey(_profileId, "days");
    const _activeDayKey = buildNamespacedKey(_profileId, "activeDayId");
    const _dayMetaKey = buildNamespacedKey(_profileId, "dayMeta");
    daysKeyRef.current = _daysKey;
    activeDayKeyRef.current = _activeDayKey;
    dayMetaKeyRef.current = _dayMetaKey;
    // Remove all items that belonged to this day
    setItems((prev) => prev.filter((it) => it.dayId !== dayId));
    // Remove from days list (no reindexing)
    const nextDays = days.filter((d) => d !== dayId);
    setDays(nextDays);
    saveDays(nextDays, _daysKey);
    // Remove day metadata entry
    const nextMeta = { ...dayMeta };
    delete nextMeta[dayId];
    setDayMeta(nextMeta);
    saveDayMeta(nextMeta, _dayMetaKey);
    // Active day reset guard — result must always be a valid existing day ID.
    if (activeDayId === dayId) {
      // Removed day was active: prefer the previous day; else first remaining.
      const removedIdx = days.indexOf(dayId);
      const nextActive = removedIdx > 0 ? days[removedIdx - 1] : nextDays[0];
      setActiveDayId(nextActive);
      saveActiveDayId(nextActive, _activeDayKey);
    } else if (!nextDays.includes(activeDayId)) {
      // Guard against unexpected invalid active day (should not normally occur).
      setActiveDayId(nextDays[0]);
      saveActiveDayId(nextDays[0], _activeDayKey);
    }
    // else: active day is still valid — no change needed.
    setRemoveConfirmDayId(null);
  }

  // Phase 8.1 — clear all items from the target day.
  // Uses clearDayTargetId (set when the confirm row was opened) to avoid
  // targeting activeDayId when the confirm was triggered from the edit modal.
  // Preserves day structure, labels, dates, and all other days.
  function handleClearDay() {
    const target = clearDayTargetId;
    if (!target) return;
    setItems((prev) => prev.filter((it) => it.dayId !== target));
    setClearDayTargetId(null);
  }

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
    // Display stored 24h time in friendly 12h format for editing (e.g. "15:00-16:00" → "3:00 PM–4:00 PM").
    // normalizeEditTimeLabel on save still normalizes whatever the user types back to storage format.
    setFormTime(formatTimeLabel(item.timeLabel));
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
    setEditingDayId(null);
    setFormError("");
    setFormTimeError("");
    setImportError("");
    setEditDayDateError("");
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
        const next = [...prev, { id: makeId(), name: trimmed, timeLabel: timeWindow, dayId: activeDayId }];
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
          dayId: activeDayId,
        });
      }
    }
    if (newItems.length === 0) {
      setImportError("No valid activities found. Check your text and try again.");
      return;
    }
    // Signal the items-watcher that this is a real import — allows inference
    // to bypass session context even when the user manually changed resort/park
    // after a Clear All. Must be set before setItems so the watcher sees it.
    importJustRanRef.current = true;
    setItems((prev) => {
      const next = [...prev, ...newItems];
      return autoSortEnabled ? sortPlanItems(next) : next;
    });
    // Fix 6 (Phase 8.1.1) — Apply context inference directly from the newly
    // imported items. The reactive items-watcher only fires when items go from
    // 0 → N in this page lifecycle; when items already existed at mount the
    // watcher guard blocks inference. Calling applyImportContextInference here
    // ensures context is reliably updated after every text/CSV import, matching
    // the behaviour already in place for JSON restore.
    applyImportContextInference(newItems);
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

  // Phase 8.0 / 8.0.8 — reorder within the active day.
  // itemId is the stable identity of the clicked item; displayIndex is kept
  // only for the top-boundary guard (index === 0 ⇒ already at top).
  // Inside the updater, the current position is re-resolved from itemId so
  // a stale render-time displayIndex can never target the wrong item.
  function moveUp(displayIndex: number, itemId: string) {
    if (displayIndex === 0) return;
    setItems((prev) => {
      const dayItems = prev.filter((it) => it.dayId === activeDayId);
      const liveIdx = dayItems.findIndex((it) => it.id === itemId);
      if (liveIdx <= 0) return prev; // not found or already at top
      const idAbove = dayItems[liveIdx - 1].id;
      const gA = prev.findIndex((it) => it.id === itemId);
      const gB = prev.findIndex((it) => it.id === idAbove);
      if (gA === -1 || gB === -1) return prev;
      const next = [...prev];
      [next[gA], next[gB]] = [next[gB], next[gA]];
      return next;
    });
  }

  function moveDown(itemId: string) {
    setItems((prev) => {
      const dayItems = prev.filter((it) => it.dayId === activeDayId);
      const liveIdx = dayItems.findIndex((it) => it.id === itemId);
      if (liveIdx === -1 || liveIdx >= dayItems.length - 1) return prev;
      const idBelow = dayItems[liveIdx + 1].id;
      const gA = prev.findIndex((it) => it.id === itemId);
      const gB = prev.findIndex((it) => it.id === idBelow);
      if (gA === -1 || gB === -1) return prev;
      const next = [...prev];
      [next[gA], next[gB]] = [next[gB], next[gA]];
      return next;
    });
  }

  function handleClearAll() {
    setItems([]);
    setDeleteConfirmId(null);
    setClearConfirm(false);
    // Fix 5: reset all day-level transient UI state on full reset
    setClearDayTargetId(null);
    setRemoveConfirmDayId(null);
    // Phase 8.1 — full reset: revert to one empty Day 1, clear all day metadata.
    const _profileId = getActiveProfileId();
    const _daysKey = buildNamespacedKey(_profileId, "days");
    const _activeDayKey = buildNamespacedKey(_profileId, "activeDayId");
    const _dayMetaKey = buildNamespacedKey(_profileId, "dayMeta");
    daysKeyRef.current = _daysKey;
    activeDayKeyRef.current = _activeDayKey;
    dayMetaKeyRef.current = _dayMetaKey;
    const resetDays = ["day-1"];
    setDays(resetDays);
    saveDays(resetDays, _daysKey);
    setActiveDayId("day-1");
    saveActiveDayId("day-1", _activeDayKey);
    setDayMeta({});
    saveDayMeta({}, _dayMetaKey);
    // Phase 7.3.6: "Clear All" is a full session reset — the user is starting
    // fresh, so both the inference gate and the stored session context must be
    // cleared. Without this, a subsequent import is blocked on two levels:
    //   1. contextInferredRef stays true → items-watcher guard exits immediately
    //   2. dwp.selectedResort/Park keys still exist → readSessionContext().exists
    //      returns true → watcher treats it as an explicit selection and skips inference
    contextInferredRef.current = false;
    initialItemCountRef.current = 0; // re-open import-inference eligibility
    try { localStorage.removeItem(resortKeyRef.current); } catch {}
    try { localStorage.removeItem(parkKeyRef.current); } catch {}
    // Phase 8.3.2 — Clear All is a full planner reset; wipe Lightning so no
    // hidden day-scoped items survive into the next session (BUG C fix).
    const _lightningKey = buildNamespacedKey(_profileId, "lightning");
    try { localStorage.setItem(_lightningKey, JSON.stringify({ version: 1, items: [] })); } catch {}
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

  // Phase 8.2 — Export active day plans only (day-plan-export format).
  function handleExportDay() {
    const activeDayPlans = items.filter((it) => it.dayId === activeDayId);
    const payload = buildDayPlanExportPayload(activeDayPlans);
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const a = document.createElement("a");
    a.href = url;
    a.download = `disney-wait-planner-day-${today}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Phase 8.2 — Export full planner backup (planner-backup format).
  function handleExportBackup() {
    // Phase 8.3.2 — include current Lightning items in full backup.
    let lightningItems: LightningBackupItem[] = [];
    try {
      const _lightningKey = buildNamespacedKey(activeProfileIdRef.current, "lightning");
      const rawLightning = localStorage.getItem(_lightningKey);
      if (rawLightning) {
        const parsed = JSON.parse(rawLightning) as unknown;
        if (
          typeof parsed === "object" && parsed !== null &&
          (parsed as Record<string, unknown>).version === 1 &&
          Array.isArray((parsed as Record<string, unknown>).items)
        ) {
          lightningItems = ((parsed as Record<string, unknown>).items as LightningBackupItem[])
            // Phase 8.3.3 — normalize dayId at export time so pre-8.3 items
            // (missing/invalid dayId) are safely canonical before entering the payload.
            .map((it) => ({ ...it, dayId: normalizeDayId(it.dayId) }));
        }
      }
    } catch {}
    const payload = buildPlannerBackupPayload({
      days,
      plans: items,
      activeDayId,
      dayMeta,
      lightning: lightningItems,
    });
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const a = document.createElement("a");
    a.href = url;
    a.download = `disney-wait-planner-backup-${today}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Phase 8.2 — Day plan context inference helper.
  // Runs inference only when importing into an empty day (bootstrap behavior).
  // Marks contextInferredRef=true so the reactive items-watcher does not re-run.
  function applyImportContextInference(inferenceBasis: PlanItem[]) {
    contextInferredRef.current = true;
    if (inferenceBasis.length === 0) return;
    const inferred = inferPlansContext(inferenceBasis);
    if (inferred.resort) {
      const resolvedPark = (inferred.park ?? RESORT_PARKS[inferred.resort][0]) as ParkId;
      setSelectedResort(inferred.resort);
      setSelectedPark(resolvedPark);
      try { localStorage.setItem(resortKeyRef.current, inferred.resort); } catch {}
      try { localStorage.setItem(parkKeyRef.current, resolvedPark); } catch {}
    }
  }

  // Phase 8.2 — Apply pending day import items to the target day.
  // targetDayId is the day selected at file-pick time (fix D — never drifts).
  // Imported items receive fresh local IDs to prevent collisions (fix E).
  // Called after user confirmation (non-empty day) or immediately (empty day).
  function applyDayImport(
    importedItems: DayExportItem[],
    wasEmpty: boolean,
    targetDayId: string
  ) {
    // Assign fresh IDs — do not preserve imported IDs (collision prevention, fix E).
    const newItems: PlanItem[] = importedItems.map((it) => ({
      id: makeId(),
      name: it.name,
      timeLabel: it.timeLabel,
      dayId: targetDayId,
    }));
    setItems((prev) => {
      const withoutTargetDay = prev.filter((it) => it.dayId !== targetDayId);
      const next = [...withoutTargetDay, ...newItems];
      return autoSortEnabled ? sortPlanItems(next) : next;
    });
    // Inference runs ONLY when importing into an empty day (bootstrap behavior).
    if (wasEmpty) {
      applyImportContextInference(newItems);
    }
    setPendingDayImportItems(null);
    setDayImportError("");
  }

  // Parse TXT lines into DayExportItem[] without assigning IDs or dayId.
  // IDs are assigned fresh in applyDayImport; dayId is set to the target day.
  function parseTxtToDayItems(text: string): DayExportItem[] {
    const lines = text.split("\n");
    const result: DayExportItem[] = [];
    for (const line of lines) {
      const normalized = line.replace(/[\u2013\u2014]/g, "-");
      const parsed = parseLine(normalized);
      if (parsed) {
        result.push({
          id: "", // placeholder — applyDayImport assigns fresh ID
          name: stripEnDashSuffix(parsed.name),
          timeLabel: parsed.timeLabel,
        });
      }
    }
    return result;
  }

  // Parse CSV text into DayExportItem[] via the shared TXT pipeline.
  // Mirrors processCSVText but returns items without mutating state.
  function parseCsvToDayItems(text: string): DayExportItem[] {
    const rows = text.split("\n");
    const txtLines: string[] = [];
    for (const row of rows) {
      const trimmedRow = row.trim();
      if (!trimmedRow) continue;
      try {
        const cells = parseCSVRow(trimmedRow);
        if (cells.length === 0) continue;
        const c0 = cells[0].toLowerCase();
        const c1 = cells.length >= 2 ? cells[1].toLowerCase() : "";
        if (cells.length >= 2 && c0 === "timelabel" && c1 === "name") continue;
        if (cells.length === 1 && c0 === "line") continue;
        if (cells.length >= 2 && cells[1]) {
          const timeCell = cells[0];
          const nameCell = cells[1];
          txtLines.push(timeCell ? `${timeCell} ${nameCell}` : nameCell);
        } else if (cells[0]) {
          txtLines.push(cells[0]);
        }
      } catch {
        // Skip malformed rows without crashing
      }
    }
    return parseTxtToDayItems(txtLines.join("\n"));
  }

  // Phase 8.2 — Day plan import via file picker.
  // Replaces ONLY target day items; no new day created; day label/date unchanged.
  // targetDayId is captured synchronously from the render that fired onChange,
  // so it always reflects the day active at file-selection time (fix D).
  function handleDayImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Clear stale pending/error state at the start of every new import attempt.
    setPendingDayImportItems(null);
    setDayImportError("");
    // Size guard before reading (1 MB)
    if (file.size > 1_048_576) {
      setDayImportError("File is too large to import (maximum: 1 MB).");
      e.target.value = "";
      return;
    }
    // Capture targetDayId synchronously at file-selection time to prevent day-switch drift.
    // Emptiness is re-checked at apply time via itemsRef to avoid stale closure snapshots.
    const targetDayId = activeDayId;
    const requestId = ++dayImportRequestRef.current;
    const fileName = file.name.toLowerCase();
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (requestId !== dayImportRequestRef.current) return; // stale
      const text = (ev.target?.result as string) ?? "";
      let parsedItems: DayExportItem[] | null = null;
      let errorMsg = "";

      if (fileName.endsWith(".json")) {
        // Inspect payload type before validating — reject full backups with guidance.
        let rawJson: unknown = null;
        try { rawJson = JSON.parse(text); } catch { /* fall through to error */ }
        if (rawJson && typeof rawJson === "object" && !Array.isArray(rawJson)) {
          const t = (rawJson as Record<string, unknown>).type;
          if (t === "planner-backup") {
            errorMsg =
              "This file is a full planner backup. Use Backup / Restore to load it.";
          } else if (t === "day-plan-export") {
            const dayItems = parseDayPlanImportPayload(rawJson);
            if (dayItems === null) {
              errorMsg = "Invalid day plan export: the file structure or fields are not valid.";
            } else {
              parsedItems = dayItems;
            }
          } else {
            errorMsg =
              "Invalid file: expected a day plan export (disney-wait-planner-day-*.json).";
          }
        } else {
          errorMsg = "Invalid file: could not parse as JSON.";
        }
      } else if (fileName.endsWith(".csv")) {
        const csvItems = parseCsvToDayItems(text);
        if (csvItems.length === 0) {
          errorMsg =
            "No valid activities found. Check your CSV file and try again.";
        } else {
          parsedItems = csvItems;
        }
      } else {
        // .txt and other text extensions
        const txtItems = parseTxtToDayItems(text);
        if (txtItems.length === 0) {
          errorMsg =
            "No valid activities found. Check your text file and try again.";
        } else {
          parsedItems = txtItems;
        }
      }

      if (errorMsg || parsedItems === null) {
        setDayImportError(errorMsg || "Import failed.");
        return;
      }

      setDayImportError("");
      // Re-check emptiness using current items state (itemsRef) to avoid stale closure.
      // targetDayId was captured at selection time and is not re-read here.
      const currentTargetDayItems = itemsRef.current.filter((it) => it.dayId === targetDayId);
      const wasEmpty = currentTargetDayItems.length === 0;
      if (wasEmpty) {
        // Empty day — apply immediately, no confirmation needed.
        applyDayImport(parsedItems, true, targetDayId);
      } else {
        // Non-empty day — store pending state; show confirmation.
        setPendingDayImportItems({
          items: parsedItems,
          targetDayId,
          existingCount: currentTargetDayItems.length,
        });
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // Restore file handler: uses the safe backup file parser as the primary path,
  // then peeks at the raw JSON type only to provide specific error guidance.
  function handleRestoreFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Pre-read size guard (1 MB) — mirrors the guard inside parsePlannerBackupFile.
    if (file.size > 1_048_576) {
      setBackupRestoreError("File is too large to import (maximum: 1 MB).");
      e.target.value = "";
      return;
    }
    const requestId = ++restoreRequestRef.current;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (requestId !== restoreRequestRef.current) return; // stale
      const text = (ev.target?.result as string) ?? "";
      // Use the safe backup file parser as the primary validation path.
      const payload = parsePlannerBackupFile(text);
      if (payload) {
        setBackupRestoreError("");
        setRestoreConfirmPayload(payload);
        return;
      }
      // Parse failed — peek at type field to give specific guidance.
      let rawType: unknown = null;
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          rawType = (parsed as Record<string, unknown>).type;
        }
      } catch { /* fall through */ }
      if (rawType === "day-plan-export") {
        setBackupRestoreError(
          "This file is a day plan export. Use Import to load it into the active day."
        );
      } else {
        setBackupRestoreError(
          "Invalid file: expected a planner backup (disney-wait-planner-backup-*.json)."
        );
      }
      setRestoreConfirmPayload(null);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // Phase 8.2 — Apply confirmed restore: replace entire planner state.
  function handleRestoreConfirm() {
    if (!restoreConfirmPayload) return;
    const { data } = restoreConfirmPayload;
    const restoredPlans: PlanItem[] = (data.plans as PlanItem[]).map((it) => ({
      id: it.id,
      name: it.name,
      timeLabel: it.timeLabel,
      dayId: normalizeDayId((it as PlanItem).dayId),
    }));
    const restoredDays: string[] = [...new Set(data.days as string[])].sort(daySort);
    const restoredActiveDayId = normalizeDayId(data.activeDayId as string);
    // Only persist dayMeta keys that belong to actual restored days.
    const restoredDaysSet = new Set(restoredDays);
    const restoredDayMeta: Record<string, DayMeta> =
      data.dayMeta
        ? (Object.fromEntries(
            Object.entries(data.dayMeta).filter(([k]) => restoredDaysSet.has(k))
          ) as Record<string, DayMeta>)
        : {};

    reseedNextId(restoredPlans);
    setItems(autoSortEnabled ? sortPlanItems(restoredPlans) : restoredPlans);
    setDays(restoredDays);
    saveDays(restoredDays, daysKeyRef.current);
    setActiveDayId(restoredActiveDayId);
    saveActiveDayId(restoredActiveDayId, activeDayKeyRef.current);
    setDayMeta(restoredDayMeta);
    saveDayMeta(restoredDayMeta, dayMetaKeyRef.current);
    // Phase 8.3.2 — Full restore replaces Lightning from backup payload.
    // data.lightning is present on new backups (fully replaces current state).
    // data.lightning is absent on old backups — fall back to empty so no
    // pre-restore items survive as hidden data across any day.
    const restoredLightningItems: LightningBackupItem[] = (data.lightning ?? []).map((it) => ({
      ...it,
      dayId: normalizeDayId(it.dayId),
    }));
    const _lightningKey = buildNamespacedKey(activeProfileIdRef.current, "lightning");
    try {
      localStorage.setItem(_lightningKey, JSON.stringify({ version: 1, items: restoredLightningItems }));
    } catch {}

    // Close modal and clear all transient UI state (I)
    setRestoreConfirmPayload(null);
    setBackupRestoreError("");
    setShowBackupRestore(false);
    setClearConfirm(false);
    setClearDayTargetId(null);
    setRemoveConfirmDayId(null);
    setDeleteConfirmId(null);
    setPendingDayImportItems(null);
    setDayImportError("");
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
          gap: 1rem;
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
          flex-shrink: 0;
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
          display: inline-flex;
          align-items: center;
          justify-content: center;
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
          text-decoration: none;
          box-sizing: border-box;
        }
        .btn-import:active {
          background-color: #eff6ff;
        }
        .btn-import:disabled {
          opacity: 0.3;
          cursor: not-allowed;
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
        @media (max-width: 640px) {
          .plans-header {
            flex-direction: column;
            align-items: stretch;
          }
          .plans-header-actions {
            flex-wrap: wrap;
            gap: 0.625rem 0.5rem;
            margin-top: 0.25rem;
          }
          .btn-clear {
            flex: 1 1 calc(50% - 0.25rem);
          }
          .btn-import {
            flex: 1 1 calc(33.333% - 0.334rem);
          }
          .btn-add {
            flex: 0 0 100%;
          }
          .btn-file-label {
            flex: 1 1 auto;
            justify-content: center;
          }
        }
        .clear-confirm-row {
          margin-top: 0.75rem;
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
        .item-park {
          font-size: 0.7rem;
          color: #9ca3af;
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
          min-width: 44px;
          min-height: 44px;
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
          gap: 0.75rem;
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
          /* overflow:hidden removed — it was clipping the AttractionSuggestInput
             absolute dropdown; modal-body handles its own overflow-y:auto scroll */
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
          padding: 0 1.25rem 1.25rem;
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
          line-height: 1.7;
        }
        .form-textarea::placeholder {
          opacity: 0.6;
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
        /* Park selector — same visual style as the resort selector above */
        .plans-park-row {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-bottom: 0.75rem;
        }
        .plans-park-tab {
          flex: 1 1 calc(50% - 3px);
          min-width: 0;
          padding: 6px 4px;
          border-radius: 8px;
          border: 1px solid #d1d5db;
          cursor: pointer;
          font-weight: 500;
          font-size: 12px;
          line-height: 1.3;
          text-align: center;
          transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
          min-height: 32px;
        }
        /* Phase 8.0 — Day Selector */
        .day-selector-row {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 1rem;
          flex-wrap: wrap;
          align-items: center;
        }
        /* Phase 8.0 — standalone "btn-day" used for + Add Day button only */
        .btn-day {
          background-color: #f9fafb;
          color: #374151;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          font-size: 0.875rem;
          font-weight: 600;
          padding: 0.5rem 0.875rem;
          cursor: pointer;
          min-height: 36px;
          white-space: nowrap;
          transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
        }
        .btn-day:active {
          opacity: 0.85;
        }
        /* Phase 8.1 — compound day pill (wrapper replaces per-day .btn-day) */
        .day-pill {
          display: inline-flex;
          align-items: stretch;
          border-radius: 8px;
          overflow: hidden;
          border: 1px solid #d1d5db;
          white-space: nowrap;
        }
        .day-pill-active {
          border-color: #2563eb;
        }
        .btn-day-select {
          background-color: #f9fafb;
          color: #374151;
          border: none;
          font-size: 0.875rem;
          font-weight: 600;
          padding: 0.5rem 0.5rem 0.5rem 0.875rem;
          cursor: pointer;
          min-height: 36px;
          transition: background-color 0.15s ease, color 0.15s ease;
        }
        .day-pill-active .btn-day-select {
          background-color: #2563eb;
          color: #fff;
        }
        .btn-day-select:active {
          opacity: 0.85;
        }
        .day-count {
          font-weight: 400;
          font-size: 0.8rem;
          margin-left: 0.25rem;
          opacity: 0.75;
        }
        .day-pill-divider {
          width: 1px;
          background-color: #d1d5db;
          flex-shrink: 0;
        }
        .day-pill-active .day-pill-divider {
          background-color: rgba(255, 255, 255, 0.3);
        }
        .btn-day-icon {
          background-color: #f9fafb;
          color: #9ca3af;
          border: none;
          font-size: 0.75rem;
          padding: 0 0.45rem;
          cursor: pointer;
          min-height: 36px;
          min-width: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background-color 0.15s ease, color 0.15s ease;
          line-height: 1;
        }
        .day-pill-active .btn-day-icon {
          background-color: #2563eb;
          color: rgba(255, 255, 255, 0.7);
        }
        .btn-day-icon:hover {
          background-color: #e5e7eb;
          color: #374151;
        }
        .day-pill-active .btn-day-icon:hover {
          background-color: #1d4ed8;
          color: #fff;
        }
        .btn-day-remove {
          background-color: #f9fafb;
          color: #9ca3af;
          border: none;
          font-size: 1rem;
          padding: 0 0.45rem;
          cursor: pointer;
          min-height: 36px;
          min-width: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background-color 0.15s ease, color 0.15s ease;
          line-height: 1;
        }
        .day-pill-active .btn-day-remove {
          background-color: #2563eb;
          color: rgba(255, 255, 255, 0.65);
        }
        .btn-day-remove:hover {
          background-color: #fef2f2;
          color: #dc2626;
        }
        .day-pill-active .btn-day-remove:hover {
          background-color: #1d4ed8;
          color: #fca5a5;
        }
        /* Phase 8.1.2 — keyboard focus inside clipped pill boundary.
           overflow:hidden clips the default browser outline, so we use
           outline-offset:-2px to draw the indicator inside the element.
           :focus-visible only fires for keyboard navigation, never mouse. */
        .day-pill button:focus-visible {
          outline: 2px solid #2563eb;
          outline-offset: -2px;
        }
        .day-pill-active button:focus-visible {
          outline-color: #fff;
        }
        .day-remove-confirm-row {
          margin-bottom: 1rem;
        }
        .day-clear-confirm-row {
          margin-bottom: 1rem;
        }
      `}</style>

      <div className="plans-container">
        <div className="plans-header">
          <div>
            <h1 className="plans-title">My Plans</h1>
            {activeProfileName && (
              <span style={{ fontSize: "12px", color: "#9ca3af", display: "block", marginTop: "2px" }}>
                Profile: {activeProfileName}
              </span>
            )}
          </div>
          <div className="plans-header-actions">
            <button
              className="btn-clear"
              disabled={items.length === 0}
              onClick={() => {
                // Fix 4: reset sibling confirms before opening this one
                setRemoveConfirmDayId(null);
                setClearDayTargetId(null);
                setClearConfirm(true);
              }}
            >
              Clear all
            </button>
            <button
              className="btn-clear"
              disabled={displayedItems.length === 0}
              onClick={() => {
                // Fix 4: reset sibling confirms before opening this one
                setRemoveConfirmDayId(null);
                setClearConfirm(false);
                setClearDayTargetId(activeDayId);
              }}
              title="Clear items from this day only"
            >
              Clear day
            </button>
            {/* Phase 8.2.4 fix A — Import button opens the modal (not OS file picker directly) */}
            <button
              className="btn-import"
              title="Import day plan (.json / .txt / .csv)"
              onClick={() => openImport()}
            >
              Import
            </button>
            <button
              className="btn-import"
              onClick={handleExportDay}
              disabled={displayedItems.length === 0}
              title="Export active day plan"
            >
              Export
            </button>
            <button
              className="btn-import"
              onClick={() => {
                setBackupRestoreError("");
                setRestoreConfirmPayload(null);
                setShowBackupRestore(true);
              }}
              title="Backup or restore full planner"
            >
              Backup
            </button>
            <button className="btn-add" onClick={openAdd}>
              + Add
            </button>
          </div>
        </div>

        {/* Resort Toggle — scopes the wait overlay to the selected resort.
            Gated by ready to prevent a DLR→WDW flip when WDW is stored. */}
        {ready ? (
          <div className="plans-resort-row">
            {(Object.keys(RESORT_LABELS) as ResortId[]).map((resortId) => (
              <button
                key={resortId}
                className="plans-resort-tab"
                onClick={() => {
                  setSelectedResort(resortId);
                  const firstPark = RESORT_PARKS[resortId][0];
                  setSelectedPark(firstPark); // reset to first park of new resort
                  try { localStorage.setItem(resortKeyRef.current, resortId); } catch {}
                  try { localStorage.setItem(parkKeyRef.current, firstPark); } catch {}
                }}
                style={{
                  backgroundColor: selectedResort === resortId ? "#1e3a5f" : "#f9fafb",
                  color: selectedResort === resortId ? "#fff" : "#374151",
                  borderColor: selectedResort === resortId ? "#1e3a5f" : "#d1d5db",
                }}
              >
                {RESORT_LABELS[resortId]}
              </button>
            ))}
          </div>
        ) : (
          <div className="plans-resort-row">
            <div style={{ flex: 1, height: 36, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
            <div style={{ flex: 1, height: 36, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
          </div>
        )}

        {/* Park selector — shows all parks for the selected resort.
            Active park is highlighted (same style as resort selector).
            Gated by ready to prevent flicker before hydration. */}
        {ready ? (
          <div className="plans-park-row">
            {RESORT_PARKS[selectedResort].map((parkId) => (
              <button
                key={parkId}
                className="plans-park-tab"
                onClick={() => {
                  setSelectedPark(parkId);
                  try { localStorage.setItem(parkKeyRef.current, parkId); } catch {}
                }}
                style={{
                  backgroundColor: selectedPark === parkId ? "#1e3a5f" : "#f9fafb",
                  color: selectedPark === parkId ? "#fff" : "#374151",
                  borderColor: selectedPark === parkId ? "#1e3a5f" : "#d1d5db",
                }}
              >
                {PARK_LABELS[parkId]}
              </button>
            ))}
          </div>
        ) : (
          <div className="plans-park-row">
            <div style={{ flex: 1, height: 32, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
            <div style={{ flex: 1, height: 32, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
          </div>
        )}

        {/* Phase 8.0 / 8.1 — Day Selector with labels, counts, edit, remove.
            Gated by initialized to prevent a Day 1 flash before localStorage
            hydration resolves (same pattern as resort/park tab ready gate). */}
        {initialized ? (
        <div className="day-selector-row">
          {days.map((dayId) => {
            const isActive = activeDayId === dayId;
            const count = itemCountByDay[dayId] ?? 0;
            const label = dayDisplayLabel(dayId, dayMeta);
            return (
              <div
                key={dayId}
                className={`day-pill${isActive ? " day-pill-active" : ""}`}
              >
                {/* Select-day button — the main clickable label area */}
                <button
                  className="btn-day-select"
                  aria-pressed={isActive}
                  onClick={() => {
                    // Phase 8.0.10 — resolve active-day key at click time.
                    const _activeDayKey = buildNamespacedKey(getActiveProfileId(), "activeDayId");
                    activeDayKeyRef.current = _activeDayKey;
                    setActiveDayId(dayId);
                    saveActiveDayId(dayId, _activeDayKey);
                    setRemoveConfirmDayId(null);
                    setClearDayTargetId(null);
                  }}
                >
                  {label}
                  {count > 0 && (
                    <span className="day-count">({count})</span>
                  )}
                </button>
                <div className="day-pill-divider" aria-hidden="true" />
                {/* Edit label/date */}
                <button
                  className="btn-day-icon"
                  aria-label={`Edit label for ${label}`}
                  title="Edit label / date"
                  onClick={() => openEditDay(dayId)}
                >
                  ✏
                </button>
                {/* Remove day — only shown for non-Day-1 days when more than one day exists */}
                {days.length > 1 && dayId !== "day-1" && (
                  <>
                    <div className="day-pill-divider" aria-hidden="true" />
                    <button
                      className="btn-day-remove"
                      aria-label={`Remove ${label}`}
                      title="Remove this day"
                      onClick={() => {
                        const itemCount = itemCountByDay[dayId] ?? 0;
                        if (itemCount > 0) {
                          // Reset sibling confirms before opening this one
                          setClearDayTargetId(null);
                          setClearConfirm(false);
                          setRemoveConfirmDayId(dayId);
                        } else {
                          // Empty day — remove immediately, but still clear
                          // sibling confirms so no stale UI remains behind.
                          setClearDayTargetId(null);
                          setClearConfirm(false);
                          handleRemoveDay(dayId);
                        }
                      }}
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            );
          })}
          <button className="btn-day" onClick={handleAddDay}>
            + Add Day
          </button>
        </div>
        ) : (
          /* Skeleton shown before localStorage hydration to prevent Day 1 flash */
          <div className="day-selector-row" aria-hidden="true">
            <div style={{ height: 36, width: 56, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
          </div>
        )}

        {/* Phase 8.1 — Remove day confirmation (shown when day has items) */}
        {removeConfirmDayId !== null && (
          <div className="day-remove-confirm-row">
            <div className="confirm-row">
              <span className="confirm-text">
                Remove {dayDisplayLabel(removeConfirmDayId, dayMeta)}?
                {(itemCountByDay[removeConfirmDayId] ?? 0) > 0 && (
                  <>{" "}({itemCountByDay[removeConfirmDayId]} {itemCountByDay[removeConfirmDayId] === 1 ? "item" : "items"} will be deleted)</>
                )}
              </span>
              <button
                className="btn-cancel-delete"
                onClick={() => setRemoveConfirmDayId(null)}
              >
                Cancel
              </button>
              <button
                className="btn-confirm-delete"
                onClick={() => handleRemoveDay(removeConfirmDayId)}
              >
                Yes, remove
              </button>
            </div>
          </div>
        )}

        {/* Phase 8.2.1 — Unified destructive confirmation: same stable location for Clear all & Clear day */}
        {(clearConfirm || clearDayTargetId !== null) && (
          <div className="clear-confirm-row">
            <div className="confirm-row">
              <span className="confirm-text">
                {clearConfirm
                  ? `Clear all activities (${items.length} total across ${Object.keys(itemCountByDay).length} ${Object.keys(itemCountByDay).length === 1 ? "day" : "days"})?`
                  : `Clear all activities from ${dayDisplayLabel(clearDayTargetId!, dayMeta)}?`}
              </span>
              <button
                className="btn-cancel-delete"
                onClick={() => { setClearConfirm(false); setClearDayTargetId(null); }}
              >
                Cancel
              </button>
              <button
                className="btn-confirm-delete"
                onClick={clearConfirm ? handleClearAll : handleClearDay}
              >
                Yes, clear
              </button>
            </div>
          </div>
        )}

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

        <p className="wait-scope-label">
          Wait overlay: {selectedResort}{selectedPark && PARK_LABELS[selectedPark] ? ` / ${PARK_LABELS[selectedPark]}` : ""}
        </p>


        {/* Phase 8.2 — Day import error display */}
        {dayImportError && (
          <div className="clear-confirm-row">
            <div className="confirm-row" style={{ borderColor: "#fca5a5", backgroundColor: "#fef2f2" }}>
              <span className="confirm-text" style={{ color: "#dc2626" }}>{dayImportError}</span>
              <button
                className="btn-cancel-delete"
                onClick={() => setDayImportError("")}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Phase 8.2 — Day import confirmation (non-empty day).
            Uses targetDayId captured at file-selection time — not activeDayId (fix D). */}
        {pendingDayImportItems !== null && (
          <div className="clear-confirm-row">
            <div className="confirm-row">
              <span className="confirm-text">
                Replace {pendingDayImportItems.existingCount} {pendingDayImportItems.existingCount === 1 ? "item" : "items"} in {dayDisplayLabel(pendingDayImportItems.targetDayId, dayMeta)} with {pendingDayImportItems.items.length} imported {pendingDayImportItems.items.length === 1 ? "item" : "items"}?
              </span>
              <button
                className="btn-cancel-delete"
                onClick={() => setPendingDayImportItems(null)}
              >
                Cancel
              </button>
              <button
                className="btn-confirm-delete"
                onClick={() =>
                  applyDayImport(
                    pendingDayImportItems.items,
                    false,
                    pendingDayImportItems.targetDayId
                  )
                }
              >
                Yes, replace
              </button>
            </div>
          </div>
        )}

        {!initialized ? null : displayedItems.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🗓</div>
            <p className="empty-text">No activities planned yet.</p>
            <p className="empty-hint">Tap &ldquo;+ Add&rdquo; to build your day.</p>
          </div>
        ) : (
          <ul className="timeline">
            {displayedItems.map((item, index) => (
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
                        if (!w) return null;
                        const hasLabel =
                          w.status === "DOWN" || w.status === "CLOSED" || w.waitMins != null;
                        if (!hasLabel) return null;
                        const parkLabel = parkMap.get(normalizeKey(w.canonicalName));
                        return (
                          <>
                            {w.canonicalName !== item.name && (
                              <div className="item-canonical">{w.canonicalName}</div>
                            )}
                            {parkLabel && (
                              <div className="item-park">{parkLabel}</div>
                            )}
                          </>
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

                  {invalidIds.has(item.id) ? (
                    <p style={{ fontSize: "0.8rem", color: "#dc2626", margin: "0.25rem 0 0" }}>
                      ⚠️ End time is before start time
                    </p>
                  ) : (overlapCountById[item.id] ?? 0) > 0 ? (
                    <p style={{ fontSize: "0.8rem", color: "#d97706", margin: "0.25rem 0 0" }}>
                      ⚠️ Overlaps with {overlapCountById[item.id] === 1 ? "1 other item" : `${overlapCountById[item.id]} other items`}
                    </p>
                  ) : null}

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
                      onClick={() => moveUp(index, item.id)}
                    >
                      ↑
                    </button>
                    <button
                      className="icon-btn"
                      aria-label="Move down"
                      disabled={index === displayedItems.length - 1}
                      onClick={() => moveDown(item.id)}
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

      {/* Phase 8.2 — Backup / Restore modal */}
      {showBackupRestore && (
        <div
          className="backdrop"
          onClick={() => {
            setShowBackupRestore(false);
            setRestoreConfirmPayload(null);
            setBackupRestoreError("");
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">Backup / Restore</h2>
            <div className="modal-body">

              {/* Backup section */}
              <div className="form-field">
                <p className="form-label">Backup planner</p>
                <p className="form-hint" style={{ marginBottom: "0.75rem" }}>
                  Downloads a full backup of all days, items, and labels. File name: <code>disney-wait-planner-backup-YYYY-MM-DD.json</code>
                </p>
                <button
                  className="btn-import"
                  style={{ width: "100%", textAlign: "center" }}
                  onClick={handleExportBackup}
                >
                  Download backup
                </button>
              </div>

              {/* Divider */}
              <div style={{ borderTop: "1px solid #e5e7eb", margin: "1rem 0" }} />

              {/* Restore section */}
              <div className="form-field">
                <p className="form-label">Restore from backup</p>
                <p className="form-hint" style={{ marginBottom: "0.75rem" }}>
                  Replaces <strong>all</strong> days, items, and labels with the backup contents. This cannot be undone.
                </p>

                {restoreConfirmPayload ? (
                  <div className="confirm-row">
                    <span className="confirm-text">
                      Replace entire planner with backup ({restoreConfirmPayload.data.days.length} {restoreConfirmPayload.data.days.length === 1 ? "day" : "days"}, {restoreConfirmPayload.data.plans.length} {restoreConfirmPayload.data.plans.length === 1 ? "item" : "items"})?
                    </span>
                    <button
                      className="btn-cancel-delete"
                      onClick={() => setRestoreConfirmPayload(null)}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn-confirm-delete"
                      onClick={handleRestoreConfirm}
                    >
                      Yes, restore
                    </button>
                  </div>
                ) : (
                  <label className="btn-file-label" style={{ width: "100%", justifyContent: "center", boxSizing: "border-box" }}>
                    📂 Choose backup file
                    <input
                      type="file"
                      accept=".json,application/json"
                      className="file-input-hidden"
                      onChange={handleRestoreFile}
                    />
                  </label>
                )}

                {backupRestoreError && (
                  <p className="form-error" style={{ marginTop: "0.5rem" }}>{backupRestoreError}</p>
                )}
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="btn-cancel"
                onClick={() => {
                  setShowBackupRestore(false);
                  setRestoreConfirmPayload(null);
                  setBackupRestoreError("");
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {mode !== "view" && (
        <div className="backdrop" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">
              {mode === "add"
                ? "Add activity"
                : mode === "edit"
                ? "Edit activity"
                : mode === "edit-day"
                ? `Edit day — ${editingDayId ? dayLabelFromId(editingDayId) : ""}`
                : "Import activities"}
            </h2>

            <div className="modal-body">
              {mode === "edit-day" ? (
                <>
                  <div className="form-field">
                    <label className="form-label" htmlFor="day-label">
                      Label{" "}
                      <span style={{ color: "#9ca3af", fontWeight: 400 }}>(optional)</span>
                    </label>
                    <input
                      id="day-label"
                      className="form-input"
                      type="text"
                      placeholder="e.g. Magic Kingdom Day"
                      value={editDayLabel}
                      onChange={(e) => setEditDayLabel(e.target.value)}
                      autoFocus
                    />
                    <p className="form-hint">
                      Leave blank to show the default day number.
                    </p>
                  </div>
                  <div className="form-field">
                    <label className="form-label" htmlFor="day-date">
                      Date{" "}
                      <span style={{ color: "#9ca3af", fontWeight: 400 }}>(optional)</span>
                    </label>
                    <input
                      id="day-date"
                      className={`form-input${editDayDateError ? " error" : ""}`}
                      type="text"
                      placeholder="YYYY-MM-DD (e.g. 2025-05-12)"
                      value={editDayDate}
                      onChange={(e) => {
                        setEditDayDate(e.target.value);
                        if (editDayDateError) setEditDayDateError("");
                      }}
                    />
                    {editDayDateError ? (
                      <p className="form-error">{editDayDateError}</p>
                    ) : (
                      <p className="form-hint">
                        Informational only — shown alongside the label in the day selector.
                      </p>
                    )}
                  </div>
                  <div className="form-field" style={{ borderTop: "1px solid #f3f4f6", paddingTop: "1rem" }}>
                    <p style={{ fontSize: "0.875rem", color: "#6b7280", marginBottom: "0.5rem" }}>
                      Clear this day
                    </p>
                    {editingDayId && (itemCountByDay[editingDayId] ?? 0) > 0 ? (
                      <button
                        className="btn-clear"
                        style={{ fontSize: "0.875rem", padding: "0.5rem 1rem", minHeight: 40 }}
                        onClick={() => {
                          // Fix 3: target the edited day, not activeDayId
                          // Fix 4: close modal and reset sibling confirms first
                          const target = editingDayId;
                          closeModal();
                          setRemoveConfirmDayId(null);
                          setClearConfirm(false);
                          if (target) setClearDayTargetId(target);
                        }}
                      >
                        Remove {itemCountByDay[editingDayId]} {itemCountByDay[editingDayId] === 1 ? "item" : "items"} from this day
                      </button>
                    ) : (
                      <p style={{ fontSize: "0.8rem", color: "#9ca3af" }}>
                        No items on this day.
                      </p>
                    )}
                  </div>
                </>
              ) : mode === "import" ? (
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
                  <p className="form-hint" style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>
                    — or upload a file —
                  </p>
                  {/* Hidden file inputs — each scoped to its own format, triggered by buttons below */}
                  <input
                    ref={modalTxtInputRef}
                    type="file"
                    accept=".txt,text/plain"
                    className="file-input-hidden"
                    onChange={(e) => { handleDayImportFile(e); setMode("view"); }}
                  />
                  <input
                    ref={modalCsvInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="file-input-hidden"
                    onChange={(e) => { handleDayImportFile(e); setMode("view"); }}
                  />
                  <input
                    ref={modalJsonInputRef}
                    type="file"
                    accept=".json,application/json"
                    className="file-input-hidden"
                    onChange={(e) => { handleDayImportFile(e); setMode("view"); }}
                  />
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="btn-file-label"
                      onClick={() => modalTxtInputRef.current?.click()}
                    >
                      📂 Text (.txt)
                    </button>
                    <button
                      type="button"
                      className="btn-file-label"
                      onClick={() => modalCsvInputRef.current?.click()}
                    >
                      📊 Spreadsheet (.csv)
                    </button>
                    <button
                      type="button"
                      className="btn-file-label"
                      onClick={() => modalJsonInputRef.current?.click()}
                    >
                      📋 Day plan (.json)
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="form-field">
                    <label className="form-label" htmlFor="plan-name">
                      Activity name{" "}
                      <span style={{ color: "#dc2626" }}>*</span>
                    </label>
                    <AttractionSuggestInput
                      id="plan-name"
                      value={formName}
                      onChange={(v) => {
                        setFormName(v);
                        if (formError) setFormError("");
                      }}
                      suggestions={suggestions}
                      placeholder="e.g. Space Mountain"
                      inputClassName={`form-input${formError ? " error" : ""}`}
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
                onClick={
                  mode === "import"
                    ? handleImport
                    : mode === "edit-day"
                    ? handleSaveDayMeta
                    : handleSave
                }
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

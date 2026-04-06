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
  buildPlansExportPayload,
  parseImportedPlansFile,
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

type Mode = "view" | "add" | "edit" | "import";

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
 * Invalid / non-canonical values return Infinity so they sort after all valid days.
 */
function parseDayNum(id: string): number {
  const m = /^day-(\d+)$/.exec(id);
  return m ? parseInt(m[1], 10) : Infinity;
}

/**
 * Sort comparator: canonical day IDs order by numeric suffix.
 * Malformed values (Infinity) always sort after valid day IDs.
 * Secondary string comparison provides a stable tiebreaker.
 */
function daySort(a: string, b: string): number {
  const diff = parseDayNum(a) - parseDayNum(b);
  if (diff !== 0) return diff;
  return a < b ? -1 : a > b ? 1 : 0;
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
          // Merge cloud item day IDs into the days list (stale-safe, pure updater).
          // Phase 8.0.5: saveDays side effect captured outside updater.
          const cloudDayIds = [...new Set(cloudItems.map((it) => it.dayId))];
          let mergedCloudDays: string[] | null = null;
          setDays((prev) => {
            const merged = [...new Set([...prev, ...cloudDayIds])].sort(daySort);
            if (merged.join(",") === prev.join(",")) return prev;
            mergedCloudDays = merged;
            return merged;
          });
          if (mergedCloudDays) saveDays(mergedCloudDays, daysKeyRef.current);
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

  // Phase 8.0 / 8.0.1 / 8.0.5 — create the next sequential day and switch to it.
  // Uses functional setDays (stale-safe) with a pure updater: captured-result
  // pattern moves all side effects outside the updater so it is safe to replay
  // in React Strict Mode without duplicating writes.
  function handleAddDay() {
    let newDayId: string | null = null;
    let nextDays: string[] | null = null;
    setDays((prev) => {
      const nums = prev
        .map((d) => parseInt(d.split("-")[1], 10))
        .filter((n) => !isNaN(n));
      const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 2;
      const candidate = `day-${nextNum}`;
      if (prev.includes(candidate)) return prev; // duplicate guard
      const updated = [...prev, candidate].sort(daySort);
      // Capture for side effects below — updater must remain pure.
      newDayId = candidate;
      nextDays = updated;
      return updated;
    });
    // Side effects run after the pure updater. The updater is called
    // synchronously inside event handlers, so these values are set here.
    if (nextDays) saveDays(nextDays, daysKeyRef.current);
    if (newDayId) {
      setActiveDayId(newDayId);
      saveActiveDayId(newDayId, activeDayKeyRef.current);
    }
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

  // Phase 8.0 — moveUp/moveDown operate within the active day's items only.
  // displayIndex is the index within displayedItems (filtered by activeDayId).
  function moveUp(displayIndex: number) {
    if (displayIndex === 0) return;
    setItems((prev) => {
      const dayItems = prev.filter((it) => it.dayId === activeDayId);
      const idA = dayItems[displayIndex]?.id;
      const idB = dayItems[displayIndex - 1]?.id;
      if (!idA || !idB) return prev;
      const gA = prev.findIndex((it) => it.id === idA);
      const gB = prev.findIndex((it) => it.id === idB);
      if (gA === -1 || gB === -1) return prev;
      const next = [...prev];
      [next[gA], next[gB]] = [next[gB], next[gA]];
      return next;
    });
  }

  function moveDown(displayIndex: number) {
    setItems((prev) => {
      const dayItems = prev.filter((it) => it.dayId === activeDayId);
      if (displayIndex >= dayItems.length - 1) return prev;
      const idA = dayItems[displayIndex]?.id;
      const idB = dayItems[displayIndex + 1]?.id;
      if (!idA || !idB) return prev;
      const gA = prev.findIndex((it) => it.id === idA);
      const gB = prev.findIndex((it) => it.id === idB);
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

  // Phase 7.4 — Export Plans: build payload, stringify, trigger browser download.
  function handleExportPlans() {
    const payload = buildPlansExportPayload(items);
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const a = document.createElement("a");
    a.href = url;
    a.download = `disney-wait-planner-plans-${today}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Phase 7.4 follow-up — Import-driven context restore.
  // Runs inference on the provided items and immediately updates resort/park
  // state if a confident result is found. Treats the import as a deliberate
  // restore action — overrides any prior manual park selection in this session.
  // Also marks contextInferredRef=true so the reactive items-watcher does not
  // re-run inference and potentially undo the result with a stale full-list pass.
  function applyImportContextInference(inferenceBasis: PlanItem[]) {
    // Prevent the items-watcher from re-running inference after this import.
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

  // Phase 7.4 — JSON restore via the import modal: validate, replace items, restore context.
  function handleJsonImportModal(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Capture a snapshot of the current request counter before the async read.
    // If another import starts before this one resolves, the counter advances
    // and the stale callback exits early without touching state.
    const requestId = ++jsonImportRequestRef.current;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (requestId !== jsonImportRequestRef.current) return; // stale import result
      const text = (ev.target?.result as string) ?? "";
      try {
        const rawImported = parseImportedPlansFile(text);
        // Phase 8.0 — preserve existing dayId from backup; assign "day-1" if absent.
        const importedItems: PlanItem[] = rawImported.map((it) => ({
          id: it.id,
          name: it.name,
          timeLabel: it.timeLabel,
          dayId: normalizeDayId(it.dayId), // Phase 8.0.2 — strict canonical check
        }));
        // Merge imported day IDs into the days list (stale-safe, pure updater).
        // Phase 8.0.5: saveDays side effect captured outside updater.
        const importedDayIds = [...new Set(importedItems.map((it) => it.dayId))];
        let mergedDaysResult: string[] | null = null;
        setDays((prev) => {
          const merged = [...new Set([...prev, ...importedDayIds])].sort(daySort);
          if (merged.join(",") === prev.join(",")) return prev;
          mergedDaysResult = merged;
          return merged;
        });
        if (mergedDaysResult) saveDays(mergedDaysResult, daysKeyRef.current);
        reseedNextId(importedItems);
        setItems(autoSortEnabled ? sortPlanItems(importedItems) : importedItems);
        applyImportContextInference(importedItems);
        setImportText("");
        setMode("view");
      } catch (err) {
        setImportError(err instanceof Error ? err.message : "Import failed.");
      }
    };
    reader.readAsText(file);
    // Reset so selecting the same file again triggers onChange
    e.target.value = "";
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
        }
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
        .btn-day-active {
          background-color: #2563eb;
          color: #fff;
          border-color: #2563eb;
        }
        .btn-day:active {
          opacity: 0.85;
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
              onClick={() => setClearConfirm(true)}
            >
              Clear all
            </button>
            <button className="btn-import" onClick={openImport}>
              Import
            </button>
            <button
              className="btn-import"
              onClick={handleExportPlans}
              disabled={items.length === 0}
            >
              Export
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

        {/* Phase 8.0 — Day Selector */}
        <div className="day-selector-row">
          {days.map((dayId) => (
            <button
              key={dayId}
              className={`btn-day${activeDayId === dayId ? " btn-day-active" : ""}`}
              aria-pressed={activeDayId === dayId}
              onClick={() => {
                setActiveDayId(dayId);
                saveActiveDayId(dayId, activeDayKeyRef.current);
              }}
            >
              {dayLabelFromId(dayId)}
            </button>
          ))}
          <button className="btn-day" onClick={handleAddDay}>
            + Add Day
          </button>
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

        <p className="wait-scope-label">
          Wait overlay: {selectedResort}{selectedPark && PARK_LABELS[selectedPark] ? ` / ${PARK_LABELS[selectedPark]}` : ""}
        </p>

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

        {displayedItems.length === 0 ? (
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
                      onClick={() => moveUp(index)}
                    >
                      ↑
                    </button>
                    <button
                      className="icon-btn"
                      aria-label="Move down"
                      disabled={index === displayedItems.length - 1}
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
                    <label className="btn-file-label" htmlFor="json-import">
                      📋 .json backup
                      <input
                        id="json-import"
                        type="file"
                        accept=".json,application/json"
                        className="file-input-hidden"
                        onChange={handleJsonImportModal}
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

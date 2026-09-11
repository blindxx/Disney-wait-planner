"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import {
  parseAmPmToken,
  parse24hToken,
  parseMilToken,
  formatSingleTime,
  formatTimeLabel,
} from "@/lib/timeUtils";
import { detectTimeConflicts } from "@/lib/timeConflicts";
import { computeCrossDayChecks, pickWinningDays, pickWinningItems, reconcilePlannerSnapshot } from "@/lib/crossDayChecks";
import { inferPlansContext } from "@/lib/plansContextInference";
import {
  mockAttractionWaits,
  type AttractionWait,
  type ParkId,
  type ResortId,
} from "@disney-wait-planner/shared";
import { getWaitDatasetForResort, LIVE_ENABLED } from "@/lib/liveWaitApi";
import { getSettingsDefaults } from "@/lib/settingsDefaults";
import { bootstrapProfiles, getActiveProfileKeys, getActiveProfile, getActiveProfileId, buildNamespacedKey } from "@/lib/profileStorage";
import { useSession } from "next-auth/react";
import {
  setSyncProfileId,
  setSyncUserId,
  scheduleSync,
  pullPlanner,
  registerUnloadSync,
  cancelScheduledSync,
  getConfirmedState,
  commitConfirmedBaseline,
  getLocalContentOwner,
  setLocalContentOwner,
  selectPendingOpBatch,
  reconcilePendingOperations,
  commitLocalDomainRaw,
  commitLocalDomainRawSync,
  isLocalDomainCommitSuccess,
  beginPullContext,
  isPullContextCurrent,
  readLatestDurableValue,
} from "@/lib/syncHelper";
import {
  capturePreFetchDomainSnapshot,
  resolvePostFetchDomainBaseline,
  decideStaleResponseRecovery,
  type DomainPreFetchSnapshot,
  type DomainBaselineOutcome,
} from "@/lib/syncPayload";
import {
  normalizeKey,
  ALIASES_DLR,
  ALIASES_WDW,
  lookupWait,
  type WaitEntry,
} from "@/lib/plansMatching";
import { getWaitBadgeProps } from "@/lib/waitBadge";
import { AttractionSuggestInput } from "@/components/AttractionSuggestInput";

// ===== RESORT CONSTANTS =====

/** Shared with My Plans — both pages read/write the same key for consistency. */
const STORAGE_RESORT_KEY = "dwp.selectedResort";

const RESORT_LABELS: Record<ResortId, string> = {
  DLR: "Disneyland Resort",
  WDW: "Walt Disney World",
};

/** Friendly park name for the park-line on reservation cards. */
const PARK_LABELS: Record<ParkId, string> = {
  disneyland: "Disneyland",
  dca: "Disney California Adventure",
  mk: "Magic Kingdom",
  epcot: "EPCOT",
  hs: "Hollywood Studios",
  ak: "Animal Kingdom",
};

/** Parks that belong to each resort — used to validate dayParks overrides. */
const PARK_TO_RESORT: Partial<Record<string, ResortId>> = {
  disneyland: "DLR",
  dca: "DLR",
  mk: "WDW",
  epcot: "WDW",
  hs: "WDW",
  ak: "WDW",
};

// ===== TYPES =====

// Phase 8.8 — Day metadata (read-only mirror of My Plans structure)
type DayMeta = {
  label?: string;
  date?: string;
};

type LightningItem = {
  id: string;
  name: string;
  startTime: string; // internal "H:MM" 24h format
  endTime: string;   // internal "H:MM" 24h format, or "" if no end time
  dayId: string;     // Phase 8.3 — canonical "day-1", "day-2", etc.
};

type StoredSchema = {
  version: 1;
  items: LightningItem[];
};

// ===== DAY NORMALIZATION (Phase 8.3) =====

// Canonical format: 1-based, no leading zeros — "day-1", "day-2", "day-10".
const VALID_DAY_ID_RE = /^day-([1-9]\d*)$/;

/**
 * Normalize any raw value to a canonical day ID.
 * Non-string, empty, whitespace-only, or malformed → "day-1".
 */
function normalizeDayId(raw: unknown): string {
  if (typeof raw !== "string") return "day-1";
  const trimmed = raw.trim();
  return VALID_DAY_ID_RE.test(trimmed) ? trimmed : "day-1";
}

/**
 * Normalize dayId on every Lightning item (idempotent).
 * Handles missing, empty, or non-string dayId values.
 * Returns the same array reference when no normalization is needed.
 */
function migrateLightningDayIds(items: LightningItem[]): LightningItem[] {
  const needsMigration = items.some(
    (it) => normalizeDayId(it.dayId as unknown) !== it.dayId
  );
  if (!needsMigration) return items;
  return items.map((it) => ({
    ...it,
    dayId: normalizeDayId(it.dayId as unknown),
  }));
}

// ===== DAY LIST LOADER (Phase 8.3.2) =====

/**
 * Load the planner day list from profile storage (read-only).
 * Always guarantees "day-1" as the baseline.
 * Used by safeActiveDayId to validate the active day against the known planner model.
 */
/**
 * SH.2.1 P3 — parses the SAME sanitize/dedupe/day-1-baseline rules
 * loadKnownDays() applies, but from an already-read raw string — shared by
 * loadKnownDays() (canonical) and loadEffectiveDurableDays() (below).
 * Mirrors plans/page.tsx's own parseDaysRaw() exactly.
 */
function parseDaysRaw(raw: string | null): string[] {
  try {
    if (!raw) return ["day-1"];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return ["day-1"];
    const seen = new Set<string>();
    const valid: string[] = [];
    for (const d of parsed as unknown[]) {
      const id = normalizeDayId(d);
      if (!seen.has(id)) { seen.add(id); valid.push(id); }
    }
    // Phase 11.2 — appended, not unshifted, so this defensive fallback never
    // overrides a genuinely persisted (positional) order.
    if (!seen.has("day-1")) valid.push("day-1");
    return valid;
  } catch {
    return ["day-1"];
  }
}

function loadKnownDays(key: string): string[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return ["day-1"];
  }
  return parseDaysRaw(raw);
}

/**
 * SH.2.1 P3 — THE authority-bearing read for the days domain. Mirrors
 * plans/page.tsx's own loadEffectiveDurableDays() exactly, see its doc
 * there for the full rationale.
 *
 * SH.2.1 P1 fix (this round, Codex finding #1) — ALSO the correct read for
 * mount-time UI hydration; see loadEffectiveDurableLightningItems()'s own
 * doc above for the full rationale.
 */
function loadEffectiveDurableDays(key: string): string[] {
  return parseDaysRaw(readLatestDurableValue(key));
}

// ===== DAY CONTEXT HELPERS (Phase 8.8) =====

/**
 * Default "Day N" label for a day with no custom label set.
 * Phase 11.2 — positional (mirrors plans/page.tsx): N is this day's 1-based
 * position within `knownDays` (the planner's persisted order), not derived
 * from the dayId's own numeric suffix. Falls back to the raw id if it isn't
 * present in knownDays (should not normally happen).
 */
function dayLabelFromId(dayId: string, knownDays: string[]): string {
  const idx = knownDays.indexOf(dayId);
  return idx === -1 ? dayId : `Day ${idx + 1}`;
}

/** Human-readable day label using optional dayMeta (no date formatting — label only). */
function dayContextLabel(dayId: string, meta: Record<string, DayMeta>, knownDays: string[]): string {
  const label = meta[dayId]?.label?.trim();
  return label || dayLabelFromId(dayId, knownDays);
}

/** Load per-day park overrides from profile-scoped localStorage (read-only on Lightning page). */
function loadDayParks(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (VALID_DAY_ID_RE.test(k) && typeof v === "string" && v in PARK_TO_RESORT) {
        result[k] = v;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Load day metadata from profile-scoped localStorage (read-only on Lightning page). */
function loadDayMeta(key: string): Record<string, DayMeta> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, DayMeta> = {};
    for (const [dayId, rawMeta] of Object.entries(parsed as Record<string, unknown>)) {
      if (!VALID_DAY_ID_RE.test(dayId)) continue;
      if (typeof rawMeta !== "object" || rawMeta === null) continue;
      const entry = rawMeta as Record<string, unknown>;
      const label = typeof entry.label === "string" ? entry.label.trim() : "";
      if (label) result[dayId] = { label };
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Load plan items for the active day from the profile's plans storage key.
 * Only name + dayId + timeLabel are needed — no other fields are read.
 * timeLabel is read (not just name) so the active-day Lightning conflict
 * section can compare plan times against Lightning times.
 * Handles both v0 (raw array) and v1 ({version,items}) schemas.
 */
function loadPlanItemsForDay(plansKey: string, dayId: string): { name: string; timeLabel?: string }[] {
  try {
    const raw = localStorage.getItem(plansKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    let items: unknown[];
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>).items)
    ) {
      items = (parsed as { items: unknown[] }).items;
    } else if (Array.isArray(parsed)) {
      items = parsed;
    } else {
      return [];
    }
    return items
      .filter(
        (it): it is { name: string; dayId?: string; timeLabel?: string } =>
          typeof it === "object" &&
          it !== null &&
          typeof (it as Record<string, unknown>).name === "string"
      )
      .filter((it) => (it.dayId ?? "day-1") === dayId)
      .map((it) => ({ name: it.name, timeLabel: it.timeLabel }));
  } catch {
    return [];
  }
}

/**
 * Load plan items for ALL days from the profile's plans storage key.
 * Mirrors loadPlanItemsForDay but without the day filter — used by the
 * shared cross-day engine (computeCrossDayChecks) for full conflict parity
 * with My Plans and for the "Lightning Lane on Multiple Days" section.
 */
function loadAllPlanItems(plansKey: string): { name: string; dayId: string; timeLabel?: string }[] {
  try {
    const raw = localStorage.getItem(plansKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    let items: unknown[];
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>).items)
    ) {
      items = (parsed as { items: unknown[] }).items;
    } else if (Array.isArray(parsed)) {
      items = parsed;
    } else {
      return [];
    }
    return items
      .filter(
        (it): it is { name: string; dayId?: string; timeLabel?: string } =>
          typeof it === "object" &&
          it !== null &&
          typeof (it as Record<string, unknown>).name === "string"
      )
      .map((it) => ({ name: it.name, dayId: it.dayId ?? "day-1", timeLabel: it.timeLabel }));
  } catch {
    return [];
  }
}

/**
 * Parse a raw Plans storage string down to its FULL, untyped `items`
 * array (unlike loadAllPlanItems/loadPlanItemsForDay above, which project
 * each entry down to {name, dayId, timeLabel} for read-only UI display).
 * Codex P1 fix (4th round) — reconcilePlannerSnapshot's sibling-domain
 * output must be written back to Plans' own storage verbatim (id, type,
 * timeLabel and every other field intact) whenever this pull sanitizes a
 * stale Plans item, so this mirrors Plans page's own parseLightningRawItems:
 * full raw objects preserved, only used to read `dayId` for reconciliation.
 */
function parsePlansRawItems(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as Record<string, unknown>).items)
    ) {
      return (parsed as Record<string, unknown>).items as unknown[];
    }
  } catch {
    // malformed — treat as no items, same tier as every other opportunistic
    // read of this opaque sibling dataset on this page.
  }
  return [];
}

// ===== STORAGE =====

const STORAGE_KEY = "dwp.lightning.v1";

function loadFromStorage(key: string = STORAGE_KEY): LightningItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as StoredSchema).version === 1 &&
      Array.isArray((parsed as StoredSchema).items)
    ) {
      // Phase 8.3 — normalize dayId on every loaded item (handles legacy items with
      // no dayId, invalid dayId, or non-string dayId — all normalize to "day-1").
      return migrateLightningDayIds((parsed as StoredSchema).items as LightningItem[]);
    }
    // Wrong version or corrupt structure — clear and start fresh
    localStorage.removeItem(key);
    return [];
  } catch {
    // JSON parse failed — clear bad data
    try {
      localStorage.removeItem(key);
    } catch {}
    return [];
  }
}

/**
 * SH.2.1 P3 — parses the SAME v1 Lightning-item shape loadFromStorage()
 * recognizes, but from an already-read raw string rather than reading
 * localStorage itself, and WITHOUT loadFromStorage's destructive
 * removeItem()-on-corrupt-data side effect: the raw string this parses may
 * come from a local-edit-fact key (see loadEffectiveDurableLightningItems()
 * below), never the canonical key itself, so a parse failure here must
 * never delete the CANONICAL key — an unrelated key this function was
 * never asked to touch.
 */
function parseDurableLightningItemsRaw(raw: string | null): LightningItem[] {
  try {
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as StoredSchema).version === 1 &&
      Array.isArray((parsed as StoredSchema).items)
    ) {
      return migrateLightningDayIds((parsed as StoredSchema).items as LightningItem[]);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * SH.2.1 P3 — THE authority-bearing read for the Lightning domain: mirrors
 * plans/page.tsx's own loadEffectiveDurablePlanItems() exactly, see its
 * doc there for the full rationale. Use this — never loadFromStorage()
 * directly — for any sync/conflict decision touching the Lightning domain.
 *
 * SH.2.1 P1 fix (this round, Codex finding #1) — ALSO the correct read for
 * mount-time UI hydration, for the same reason: rendering canonical bytes
 * alone at mount could show a stale value when a newer local-edit fact
 * survives unresolved (the documented cross-tab hydration race).
 */
function loadEffectiveDurableLightningItems(key: string): LightningItem[] {
  return parseDurableLightningItemsRaw(readLatestDurableValue(key));
}

// SH.2 architecture (Codex P1, 12th round; primitive replaced 16th round) —
// routes through the shared commitLocalDomainRawSync primitive (see its own
// doc in syncHelper.ts) instead of a bare setItem: mirrors plans/page.tsx's
// own saveToStorage exactly — see its doc there for the full rationale.
function saveToStorage(items: LightningItem[], key: string = STORAGE_KEY): void {
  const schema: StoredSchema = { version: 1, items };
  commitLocalDomainRawSync(key, JSON.stringify(schema));
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
  // Codex P1 #2 fix — ref that always holds the latest items, mirroring
  // itemsRef in plans/page.tsx: the cloud-pull's .then() callback is an
  // async context whose closure over `items` is fixed to whatever it was
  // when the effect was (re)created, not necessarily what's current by the
  // time the pull resolves — reading this ref instead lets the days-domain
  // reconciliation source day IDs from the CURRENT local items when local
  // Lightning wins its own conflict decision.
  const itemsRef = useRef<LightningItem[]>([]);
  itemsRef.current = items;

  // Profile-aware storage key refs — set once on mount after bootstrapProfiles().
  const lightningKeyRef = useRef(STORAGE_KEY);
  const resortKeyRef = useRef(STORAGE_RESORT_KEY);
  // Stable ref to the active profile id — used by sync effects.
  const activeProfileIdRef = useRef("default");
  // SH.2 architecture (Codex P1, 3rd round) — stable ref to the currently
  // authenticated user's identity, used ONLY to scope confirmed-baseline
  // reads/writes. Mirrors plans/page.tsx exactly — see its own detailed
  // doc for the full rationale.
  const activeUserIdRef = useRef<string | null>(null);
  // Phase 8.3 — per-profile activeDayId key. Phase 9.4 — the day picker on this
  // page now also writes this key (handleSelectDay), shared with My Plans.
  const activeDayKeyRef = useRef("dwp:default:activeDayId");
  // Phase 8.3 — active day for filtering; read from localStorage on mount.
  const [activeDayId, setActiveDayId] = useState<string>("day-1");
  // Codex fix — ref that always holds the latest activeDayId, mirroring the
  // same pattern in plans/page.tsx: the cloud-pull's .then() callback is an
  // async context whose closure over activeDayId is fixed to whatever it
  // was when the effect was (re)created, not necessarily what's current by
  // the time the pull resolves — reading this ref instead avoids acting on
  // a stale snapshot when revalidating activeDayId against a newly
  // authoritative cloud days[] order.
  const activeDayIdRef = useRef(activeDayId);
  activeDayIdRef.current = activeDayId;
  // Phase 8.3.2 — per-profile days key. Plans page owns writes for normal
  // UI-driven day mutations (reorder/add/remove/duplicate) — Lightning has
  // no such controls. Codex fix (Phase 11.2) — the cloud-pull handler below
  // is a scoped exception: it writes the resolved authoritative synced
  // order here before reopening the sync gate, since a subsequent push
  // reads this key directly and must never revert what was just pulled.
  const daysKeyRef = useRef("dwp:default:days");
  // Phase 8.3.2 — known planner days for safe display-day validation.
  const [knownDays, setKnownDays] = useState<string[]>(["day-1"]);
  // SH.2 — ref that always holds the latest knownDays, mirroring daysRef in
  // plans/page.tsx: the cross-tab storage listener below (a mount-time-only
  // effect) needs the current value to tell a genuine cross-tab days[]
  // change apart from a no-op hydration write, which a closure over
  // `knownDays` captured at effect-creation time cannot provide.
  const knownDaysRef = useRef(knownDays);
  knownDaysRef.current = knownDays;
  // Phase 8.8 — per-day park overrides (read-only; Plans page owns writes).
  const dayParksKeyRef = useRef("dwp:default:dayParks");
  const [dayParks, setDayParks] = useState<Record<string, string>>({});
  // Phase 8.8 — day metadata for display labels (read-only).
  const dayMetaKeyRef = useRef("dwp:default:dayMeta");
  const [dayMeta, setDayMeta] = useState<Record<string, DayMeta>>({});
  // Phase 8.8 — plan items for the active day, read from profile plans storage
  // so Lightning can infer the auto park the same way My Plans does.
  const plansKeyRef = useRef("dwp:default:plans");
  const [planDayItems, setPlanDayItems] = useState<{ name: string; timeLabel?: string }[]>([]);
  // Phase 9.4 — plan items across ALL days, used by the shared cross-day engine
  // (computeCrossDayChecks) for "Lightning Lane on Multiple Days" and full
  // conflict parity with My Plans (read-only; Plans page owns writes).
  const [allPlanItems, setAllPlanItems] = useState<{ name: string; dayId: string; timeLabel?: string }[]>([]);
  // Stable ref used inside storage event handler to get current safeActiveDayId
  // without adding it to the effect dependency array.
  const safeActiveDayIdRef = useRef("day-1");
  // SH.2 architecture — reconciliation-from-authoritative-state model,
  // mirroring plans/page.tsx (see its own detailed doc for the full
  // rationale). Repeated Codex findings on the previous ref-per-event-type
  // approach (localLightningEditRef/localDaysEditRef reset-on-pull-start
  // discarding a pre-existing unpushed edit; a permanent removed-day
  // tombstone in pendingRemovedDayIdsRef that could blacklist a
  // legitimately REUSED day ID; this page's own items able to re-add a
  // day another tab had already removed, before the coupled Lightning
  // deletion here happened to land) all traced back to the same root
  // cause: inferring "did local change" from whether/when a 'storage'
  // event fired, rather than from local storage's own content.
  // localStorage is the device-local authority; a 'storage' event is only
  // ever a notification, never proof of ordering or synchronization.
  //
  // itemsBaselineRef/daysBaselineRef hold this page's own FALLBACK
  // baseline — used only when no confirmed snapshot exists yet for this
  // profile (see buildPostFetchPullBaseline() below, the ONE place this
  // fallback is actually consulted). Captured once at mount, and updated
  // ONLY when a pull resolves and cloud wins a domain (local was unchanged,
  // so adopting cloud's value is safe) — NEVER merely because a pull effect
  // re-ran, and NEVER when local won a domain's conflict.
  // buildPostFetchPullBaseline() prefers a real confirmed snapshot over
  // these refs whenever one exists.
  const itemsBaselineRef = useRef<LightningItem[]>([]);
  const daysBaselineRef = useRef<string[]>([]);
  // Same fallback concept, applied to the OPPOSITE dataset (Plans' raw
  // storage) this page hydrates on every pull (Phase 7.6.3). Captured as
  // the raw string (Lightning never parses/normalizes Plans items) so
  // comparison is a simple, exact string check. A null baseline (key
  // absent at mount) legitimately compares unequal to any later non-null
  // read.
  const plansRawBaselineRef = useRef<string | null>(null);

  // SH.2.1 — mirrors plans/page.tsx exactly (see its own detailed doc for
  // the full architecture, the SH.2 18th round's P1 this replaced, and the
  // SH.2.1 P2 fix: a confirmed fact newer than this pull's own response, or
  // a response carrying no revision at all, must never be used as this
  // pull's baseline). buildPreFetchPullBaseline()/buildPostFetchPullBaseline()
  // below are pure page-local GLUE only, wired into the shared
  // capturePreFetchDomainSnapshot()/resolvePostFetchDomainBaseline()
  // functions (syncPayload.ts) — no baseline/conflict/recovery/staleness
  // DECISION lives in this file. Stage 2 is called UNCONDITIONALLY, exactly
  // once per pull — never conditionally skipped (see plans/page.tsx's own
  // doc for why that conditional was itself the P2 bug). Note this page's
  // "items" is the LIGHTNING domain (confirmed.lightning) and its
  // "plansRaw" is the SIBLING domain (confirmed.plans) — the mirror image
  // of plans/page.tsx throughout.
  //
  // `identity` is REQUIRED on stage 2 — never defaults to the live
  // activeUserIdRef/activeProfileIdRef refs, for the same reason as
  // plans/page.tsx (see its own doc).

  /**
   * FOREIGN BYTES CAN NEVER BECOME A FALLBACK CANDIDATE — mirrors
   * plans/page.tsx's own domainFallbackValue() exactly, see its doc there
   * for the full rationale.
   */
  function domainFallbackValue<T>(ref: { current: T }, neutral: T, contentOwnershipMismatch: boolean): T {
    return contentOwnershipMismatch ? neutral : ref.current;
  }

  /** Mirrors plans/page.tsx's own clearRefOnFallbackMismatch() exactly. */
  function clearRefOnFallbackMismatch<T>(
    ref: { current: T },
    outcome: DomainBaselineOutcome<T>,
    neutral: T,
    contentOwnershipMismatch: boolean
  ): void {
    if (contentOwnershipMismatch && outcome.kind === "fallback") {
      ref.current = neutral;
    }
  }

  /**
   * STAGE 1 (pre-fetch) — mirrors plans/page.tsx's own
   * buildPreFetchPullBaseline() exactly, see its doc there for the full
   * rationale, including the SH.2.1 P3 fix: this is the domain's EFFECTIVE
   * DURABLE value (via loadEffectiveDurableLightningItems()/
   * loadEffectiveDurableDays()/readLatestDurableValue(), never
   * loadFromStorage()/loadKnownDays()/a raw canonical read) — required
   * case 6, a conflict-recovery "recovered" outcome reuses this frozen
   * value, so it must already reflect durable local intent.
   */
  function buildPreFetchPullBaseline(): {
    items: DomainPreFetchSnapshot<LightningItem[]>;
    days: DomainPreFetchSnapshot<string[]>;
    plansRaw: DomainPreFetchSnapshot<string | null>;
  } {
    return {
      items: capturePreFetchDomainSnapshot(migrateLightningDayIds(loadEffectiveDurableLightningItems(lightningKeyRef.current))),
      days: capturePreFetchDomainSnapshot(loadEffectiveDurableDays(daysKeyRef.current)),
      plansRaw: capturePreFetchDomainSnapshot(readLatestDurableValue(getActiveProfileKeys().plans)),
    };
  }

  /**
   * STAGE 2 (post-fetch) — mirrors plans/page.tsx's own
   * buildPostFetchPullBaseline() exactly, see its doc there for the full
   * rationale, including the revision-bound now enforced inside
   * resolvePostFetchDomainBaseline() itself.
   */
  function buildPostFetchPullBaseline(
    contentOwnershipMismatch: boolean,
    identity: { userId: string | null; profileId: string },
    cloudRevision: number | null,
    preFetch: {
      items: DomainPreFetchSnapshot<LightningItem[]>;
      days: DomainPreFetchSnapshot<string[]>;
      plansRaw: DomainPreFetchSnapshot<string | null>;
    }
  ): {
    items: DomainBaselineOutcome<LightningItem[]>;
    days: DomainBaselineOutcome<string[]>;
    plansRaw: DomainBaselineOutcome<string | null>;
  } {
    const confirmed = identity.userId
      ? getConfirmedState(identity.userId, identity.profileId)
      : { plans: { status: "none" as const }, lightning: { status: "none" as const }, days: { status: "none" as const } };

    const items = resolvePostFetchDomainBaseline(
      confirmed.lightning,
      cloudRevision,
      (raw) => migrateLightningDayIds(raw.items as LightningItem[]),
      preFetch.items,
      domainFallbackValue(itemsBaselineRef, [] as LightningItem[], contentOwnershipMismatch)
    );
    clearRefOnFallbackMismatch(itemsBaselineRef, items, [], contentOwnershipMismatch);

    const days = resolvePostFetchDomainBaseline(
      confirmed.days,
      cloudRevision,
      (raw) => raw,
      preFetch.days,
      domainFallbackValue(daysBaselineRef, ["day-1"], contentOwnershipMismatch)
    );
    clearRefOnFallbackMismatch(daysBaselineRef, days, ["day-1"], contentOwnershipMismatch);

    const plansRaw = resolvePostFetchDomainBaseline(
      confirmed.plans,
      cloudRevision,
      (raw) => JSON.stringify(raw),
      preFetch.plansRaw,
      domainFallbackValue(plansRawBaselineRef, null, contentOwnershipMismatch)
    );
    clearRefOnFallbackMismatch(plansRawBaselineRef, plansRaw, null, contentOwnershipMismatch);

    return { items, days, plansRaw };
  }

  /**
   * Mirrors plans/page.tsx's own UnusableDomain type exactly.
   */
  type UnusableDomain =
    | { domain: "plans" | "lightning" | "days"; reason: "conflict"; revision: number }
    | {
        domain: "plans" | "lightning" | "days";
        reason: "stale-response";
        confirmedRevision: number;
        cloudRevision: number | null;
      };

  /**
   * Mirrors plans/page.tsx's own collectUnusableDomains() exactly.
   */
  function collectUnusableDomains(outcomes: {
    items: DomainBaselineOutcome<unknown>;
    days: DomainBaselineOutcome<unknown>;
    plansRaw: DomainBaselineOutcome<unknown>;
  }): UnusableDomain[] {
    const unusable: UnusableDomain[] = [];
    const check = (domain: "plans" | "lightning" | "days", outcome: DomainBaselineOutcome<unknown>) => {
      if (outcome.kind === "gated") {
        unusable.push({ domain, reason: "conflict", revision: outcome.revision });
      } else if (outcome.kind === "stale-response") {
        unusable.push({
          domain,
          reason: "stale-response",
          confirmedRevision: outcome.confirmedRevision,
          cloudRevision: outcome.cloudRevision,
        });
      }
    };
    check("lightning", outcomes.items);
    check("plans", outcomes.plansRaw);
    check("days", outcomes.days);
    return unusable;
  }

  /**
   * Mirrors plans/page.tsx's own requireResolvedValue() exactly.
   */
  function requireResolvedValue<T>(outcome: DomainBaselineOutcome<T>): T {
    if (outcome.kind === "gated" || outcome.kind === "stale-response") {
      throw new Error("SH.2.1: requireResolvedValue() called on an unusable domain outcome");
    }
    return outcome.value;
  }
  // Phase 8.9.2 — captured target day ID for Clear Day Lightning confirmation (null = not pending).
  const [clearDayLightningTarget, setClearDayLightningTarget] = useState<string | null>(null);

  // Auth session — used to trigger cloud pull on sign-in.
  const { data: session, status: sessionStatus } = useSession();
  // SH.2 architecture (Codex P1, 13th round) — mirrors plans/page.tsx
  // exactly, see its own detailed doc. The RESOLVED authenticated user id
  // as its own primitive value, used as an auth-transition-effect
  // dependency alongside `sessionStatus` so a genuine A -> B identity
  // switch re-runs that effect even when `sessionStatus` never leaves
  // "authenticated".
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const authenticatedUserId =
    sessionStatus === "authenticated" ? ((session?.user as any)?.id ?? session?.user?.email ?? null) : null;
  // Gate: prevents scheduleSync() from running until the initial cloud pull
  // resolves. Same semantics as plans/page.tsx syncReady.
  const [syncReady, setSyncReady] = useState(false);
  // SH.2.1 (this round) — STALE-RESPONSE PULL RECOVERY. Mirrors
  // plans/page.tsx's own staleRetryTick/staleRetryPendingRef exactly — see
  // their doc there for the full rationale (required case 6: Plans and
  // Lightning stay symmetric).
  const [staleRetryTick, setStaleRetryTick] = useState(0);
  const staleRetryPendingRef = useRef(false);

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
  // Prevents resort selector from briefly showing DLR when WDW is stored.
  const [ready, setReady] = useState(false);

  // Live attraction wait data for the selected resort (all parks merged)
  const [liveAttractions, setLiveAttractions] = useState<AttractionWait[]>([]);

  const [activeProfileName, setActiveProfileName] = useState<string | null>(null);

  // Load persisted reservations on mount
  useEffect(() => {
    bootstrapProfiles();
    const profileKeys = getActiveProfileKeys();
    lightningKeyRef.current = profileKeys.lightning;
    resortKeyRef.current = profileKeys.selectedResort;
    setActiveProfileName(getActiveProfile().name);
    const currentProfileId = getActiveProfileId();
    activeProfileIdRef.current = currentProfileId;
    // Phase 8.3 — set per-profile activeDayId key (read-only; Plans page owns writes).
    activeDayKeyRef.current = buildNamespacedKey(currentProfileId, "activeDayId");
    // Phase 8.3 — load the active day so Lightning reflects the current day.
    // normalizeDayId handles null (no stored value) → "day-1".
    setActiveDayId(normalizeDayId(localStorage.getItem(activeDayKeyRef.current)));
    // Phase 8.3.2 — load known planner days for safe display-day validation.
    daysKeyRef.current = buildNamespacedKey(currentProfileId, "days");
    // SH.2.1 P1 fix (this round, Codex finding #1) — reads the days
    // domain's EFFECTIVE DURABLE value (see loadEffectiveDurableDays()'s own
    // doc above), never canonical-only loadKnownDays(): rendering canonical
    // bytes alone at mount could show a stale value when a newer local-edit
    // fact survives unresolved (the documented cross-tab hydration race).
    const loadedKnownDays = loadEffectiveDurableDays(daysKeyRef.current);
    setKnownDays(loadedKnownDays);
    // Phase 8.8 — load day park overrides and metadata (read-only context display).
    dayParksKeyRef.current = buildNamespacedKey(currentProfileId, "dayParks");
    setDayParks(loadDayParks(dayParksKeyRef.current));
    dayMetaKeyRef.current = buildNamespacedKey(currentProfileId, "dayMeta");
    setDayMeta(loadDayMeta(dayMetaKeyRef.current));
    // Phase 8.8 — load plan items so auto park can be inferred the same way My Plans does.
    plansKeyRef.current = buildNamespacedKey(currentProfileId, "plans");
    const loadedActiveDayId = normalizeDayId(localStorage.getItem(buildNamespacedKey(currentProfileId, "activeDayId")));
    setPlanDayItems(loadPlanItemsForDay(plansKeyRef.current, loadedActiveDayId));
    setAllPlanItems(loadAllPlanItems(plansKeyRef.current));
    // Retarget the module-level sync to this profile.
    setSyncProfileId(currentProfileId);
    // SH.2.1 P1 fix (this round, Codex finding #1) — same rationale as
    // `loadedKnownDays` just above: reads the Lightning domain's effective
    // durable value (see loadEffectiveDurableLightningItems()'s own doc
    // above), never canonical-only loadFromStorage(), so mount-time
    // rendering can never regress behind a surviving local-edit fact.
    const loadedItems = loadEffectiveDurableLightningItems(lightningKeyRef.current);
    setItems(loadedItems);
    // SH.2 architecture — capture this page's own FALLBACK baselines from
    // the values just loaded above. This is only a STARTING assumption for
    // a profile that has never had a successful push yet (or is offline/
    // unauthenticated) — buildPostFetchPullBaseline() (declared above)
    // prefers a real confirmed snapshot the moment one exists, falling
    // back to these refs only
    // until then.
    itemsBaselineRef.current = loadedItems;
    daysBaselineRef.current = loadedKnownDays;
    // Same baseline concept for the opposite (Plans) dataset this page
    // hydrates on every pull — captured as the raw string since no
    // parsing/normalization is needed for a page that doesn't own that
    // domain.
    try {
      plansRawBaselineRef.current = localStorage.getItem(plansKeyRef.current);
    } catch {
      plansRawBaselineRef.current = null;
    }
    setLoaded(true);
  }, []);

  // Persist whenever items change (after initial load). SH.2 architecture —
  // no ref-marking needed here: a pull's own fresh read of localStorage at
  // resolution time (see the pull effect below) already reflects whatever
  // this effect just wrote, compared against the stable itemsBaselineRef.
  useEffect(() => {
    if (!loaded) return;
    saveToStorage(items, lightningKeyRef.current);
  }, [items, loaded]);

  // Schedule a debounced cloud push after every items change, but only once
  // syncReady is true (initial cloud pull resolved) AND user is authenticated.
  useEffect(() => {
    if (!loaded || !syncReady || sessionStatus !== "authenticated") return;
    scheduleSync();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, loaded, syncReady, sessionStatus]);

  // Manage syncReady gate based on auth state transitions — mirrors plans/page.tsx.
  useEffect(() => {
    // SH.2.1 (this round) — see plans/page.tsx's own doc on
    // staleRetryPendingRef for why this reset is unconditional.
    staleRetryPendingRef.current = false;
    if (sessionStatus === "loading") {
      cancelScheduledSync();
      // Codex P1 fix (13th round) — mirrors plans/page.tsx exactly: retarget
      // sync identity to "signed out" and advance the pull epoch, so any
      // authenticated pull still in flight is invalidated immediately.
      setSyncUserId(null);
      setSyncReady(false);
      return;
    }
    if (sessionStatus === "unauthenticated") {
      setSyncUserId(null);
      setSyncReady(true);
      return;
    }
    // authenticated
    if (!loaded) return;
    // SH.2 architecture (Codex P1, 3rd round; identity now sourced from the
    // authenticatedUserId dependency — 13th round) — resolve and record
    // this session's authenticated identity BEFORE anything else in this
    // branch. Mirrors plans/page.tsx exactly — see its own detailed doc.
    const resolvedUserId = authenticatedUserId;
    // SH.2 architecture (Codex P1, 5th round) — AUTHENTICATED CONFLICT
    // SESSION boundary. Mirrors plans/page.tsx exactly — see its own
    // detailed doc for the full root-cause explanation, why this
    // supersedes the 4th round's previousUserId-based fallback-ref rebase
    // (obsolete machinery, removed), and why a null/absent ownership
    // marker is trusted (preserves local-first sign-in behavior).
    //
    // Codex P1 fix (6th round) — DURABLE TRANSFER BOUNDARY: the ownership
    // WRITE is deliberately NOT here — see getLocalContentOwner's own doc
    // in syncHelper.ts and plans/page.tsx's mirrored comment. It happens at
    // the END of this pull's `.then()` below, only once the pull genuinely
    // resolved AND its own hydration/day writes succeeded.
    const priorLocalContentOwner = getLocalContentOwner(activeProfileIdRef.current);
    const contentOwnershipMismatch =
      priorLocalContentOwner !== null && priorLocalContentOwner !== resolvedUserId;
    activeUserIdRef.current = resolvedUserId;
    setSyncUserId(resolvedUserId);
    cancelScheduledSync();
    // SH.2 architecture (Codex P1, 13th round) — capture this pull's
    // immutable execution context. Mirrors plans/page.tsx exactly — see its
    // own detailed doc in the module doc of syncHelper.ts ("Pull execution
    // context") for the full contract.
    const pullCtx = beginPullContext();
    let cancelled = false;
    // SH.2 architecture (Codex P1, 13th round) — the ONE helper every check
    // in this pull uses instead of scattered `if (cancelled)` conditions.
    // Mirrors plans/page.tsx exactly — see its own detailed doc.
    const isPullCurrent = () => !cancelled && isPullContextCurrent(pullCtx);
    // SH.2 architecture — no ref resets here. Winner selection for this
    // pull is entirely a function of (a) itemsBaselineRef/daysBaselineRef
    // (stable across this whole mount — see their own doc) and (b) fresh
    // reads of local storage taken below, at resolution time. There is
    // nothing to "reset" at pull start: resetting an event-driven flag
    // here is exactly the mechanism that let a pre-existing, still-unpushed
    // edit get silently discarded by a later pull (Codex finding).
    setSyncReady(false);
    const profileKeysForPull = getActiveProfileKeys();
    // SH.2.1 — STAGE 1: freeze this pull's causal disk snapshot NOW, before
    // the GET is even issued (Codex P1 #2, preserved). `preFetchBaseline` is
    // closed over by `.then()` below and consulted there instead of any
    // ref — see buildPreFetchPullBaseline()'s own doc above. Every pull's
    // baseline DECISION is made once, unconditionally, in stage 2 below —
    // this is purely a disk-bytes freeze. Mirrors plans/page.tsx exactly.
    const preFetchBaseline = buildPreFetchPullBaseline();
    // SH.2 architecture (Codex P1, 7th round; generalized to a set in the
    // 9th; fairly bounded in the 10th) — read a BOUNDED, FAIRLY ROTATED
    // batch of still-pending unload-beacon opIds BEFORE this pull's fetch
    // starts. Mirrors plans/page.tsx exactly — see its own doc.
    const pendingOpIds = pullCtx.userId
      ? selectPendingOpBatch(pullCtx.userId, pullCtx.profileId)
      : [];
    void pullPlanner(pullCtx.profileId, pendingOpIds)
      .then(async (planner) => {
        if (!isPullCurrent()) return;
        const cloud = planner?.lightning ?? null;
        let cloudLightningItems: LightningItem[] | null = null;
        if (cloud) {
          // Phase 8.3 — normalize dayIds from cloud items so legacy items
          // (no dayId) are safely migrated to "day-1" on hydration.
          cloudLightningItems = migrateLightningDayIds(cloud.items as LightningItem[]);
        }
        const cloudDaysOrder = planner?.days;

        // SH.2 architecture (Codex P1, 8th round; generalized 9th) — PULL
        // ORDER: resolve EVERY pending op's fate against THIS SAME GET
        // response BEFORE any winner is selected. Mirrors plans/page.tsx
        // exactly — see its own detailed doc for the full rationale.
        const opStatuses = planner?.opStatuses ?? [];
        // PULL OUTCOME CONTRACT (Codex P1, 17th round) — mirrors
        // plans/page.tsx exactly, see its own detailed doc.
        const promotionOk =
          pullCtx.userId && pendingOpIds.length > 0
            ? await reconcilePendingOperations(pullCtx.userId, pullCtx.profileId, opStatuses, planner?.revision ?? null, planner)
            : true;
        // A newer pull may have started, or this exact effect instance may
        // have been cleaned up, while the await above was in flight —
        // re-check before this stale pull mutates anything further (Codex
        // P1, 13th round — mirrors plans/page.tsx exactly).
        if (!isPullCurrent()) return;
        // PULL OUTCOME CONTRACT (Codex P1, 17th round) — mirrors
        // plans/page.tsx exactly, see its own detailed doc: an accepted
        // beacon whose promotion could not be durably proven fails this
        // entire pull closed, leaving the pending op untouched for retry.
        if (!promotionOk) {
          try {
            console.error("SH.2: pull deferred — accepted beacon promotion could not be durably confirmed; pending op retained for retry.");
          } catch {}
          return;
        }
        // This pull's EFFECTIVE baseline for winner selection — SH.2.1
        // STAGE 2, called UNCONDITIONALLY, exactly once, every pull, now
        // that this pull's own authoritative response is known. Codex P1
        // (SH.2.1 P2) — the PREVIOUS conditional (`anyAccepted ||
        // preFetchGatedDomains.length > 0`) could skip re-reading confirmed
        // state entirely, so a race landing between pre-fetch and this call
        // was never checked against this pull's own revision at all. The
        // revision bound now lives INSIDE resolvePostFetchDomainBaseline()
        // itself (see its own doc in syncPayload.ts), so calling stage 2
        // unconditionally is what actually closes that race — a
        // `getConfirmedState()` read newer than this pull's own
        // `cloudRevision` resolves to "stale-response" rather than being
        // blindly trusted as this pull's baseline. Mirrors plans/page.tsx
        // exactly — see its own detailed doc.
        const baselineOutcomes = buildPostFetchPullBaseline(
          contentOwnershipMismatch,
          { userId: pullCtx.userId, profileId: pullCtx.profileId },
          planner?.revision ?? null,
          preFetchBaseline
        );

        // CONFIRMED-STATE CONTRACT (Codex P1, 16th round; conflict recovery
        // added 17th; SH.2.1 P1 enforced by DomainBaselineOutcome's own
        // discriminated union; SH.2.1 P2 adds "stale-response" as a second,
        // equally unusable outcome kind) — mirrors plans/page.tsx exactly,
        // see its own detailed doc: a conflict at ANY domain's newest
        // confirmed revision that this pull could NOT repair, OR a
        // confirmed revision NEWER than this pull's own response, means the
        // entire pull bails out here rather than proceeding for the healthy
        // domains while leaving syncReady closed — since push always sends
        // plans+lightning+days combined in one request. Local storage is
        // left completely untouched; the next pull resolves it automatically
        // once a later unambiguous (or, for a stale-response domain, simply
        // a later/equal) revision resolves it.
        const unusableDomains = collectUnusableDomains(baselineOutcomes);
        if (unusableDomains.length > 0) {
          for (const unusable of unusableDomains) {
            try {
              if (unusable.reason === "conflict") {
                console.error(
                  `SH.2: pull deferred — ${unusable.domain}'s confirmed state is conflicted at revision ${unusable.revision}.`
                );
              } else {
                console.error(
                  `SH.2.1: pull deferred — ${unusable.domain}'s confirmed state is already at revision ${unusable.confirmedRevision}, newer than this pull's own response (revision ${unusable.cloudRevision ?? "none"}); refusing to hydrate an older response over it.`
                );
              }
            } catch {}
          }
          // SH.2.1 (this round) — STALE-RESPONSE PULL RECOVERY. Mirrors
          // plans/page.tsx exactly, see its own detailed doc: retry only
          // when EVERY unusable domain is "stale-response", never when ANY
          // is "conflict" (required cases 5 & 6).
          if (
            isPullCurrent() &&
            !staleRetryPendingRef.current &&
            decideStaleResponseRecovery(unusableDomains) === "retry"
          ) {
            staleRetryPendingRef.current = true;
            setStaleRetryTick((t) => t + 1);
          }
          return;
        }
        // Every outcome above is now proven usable — safe to read `.value`
        // off each. Mirrors plans/page.tsx exactly.
        const effectiveBaseline = {
          items: requireResolvedValue(baselineOutcomes.items),
          days: requireResolvedValue(baselineOutcomes.days),
          plansRaw: requireResolvedValue(baselineOutcomes.plansRaw),
        };

        // SH.2 architecture — read CURRENT local state fresh, right now,
        // for both domains this page owns. This is what actually closes
        // the Codex findings: a domain's winner is determined by comparing
        // this fresh read against a STABLE baseline (never reset merely
        // because this effect re-ran), not by consulting a flag that could
        // have been reset or never set at all. See pickWinningItems/
        // pickWinningDays/reconcilePlannerSnapshot in crossDayChecks.ts
        // (and their DEV_*_CASES) for the full model and its regression
        // cases — mirrors plans/page.tsx exactly.
        //
        // SH.2.1 P3 — mirrors plans/page.tsx exactly: TWO deliberately
        // separate reads per domain, never conflated. `currentItemsRaw`/
        // `currentDaysRaw`/`currentPlansRaw` are the LITERAL canonical
        // key's raw bytes — used ONLY as commitLocalDomainRaw's
        // `expectedPreviousRaw` CAS argument below. `currentItems`/
        // `currentDays`/`currentPlansRawDurable` are THE authority-bearing
        // reads, via loadEffectiveDurableLightningItems()/
        // loadEffectiveDurableDays()/readLatestDurableValue() — used for
        // changed-locally/winner selection. See plans/page.tsx's own
        // detailed doc for the full rationale.
        const currentItemsRaw = localStorage.getItem(lightningKeyRef.current);
        const currentItems = migrateLightningDayIds(loadEffectiveDurableLightningItems(lightningKeyRef.current));
        const currentDaysRaw = localStorage.getItem(daysKeyRef.current);
        const currentDays = loadEffectiveDurableDays(daysKeyRef.current);
        const currentPlansRaw = localStorage.getItem(profileKeysForPull.plans);
        const currentPlansRawDurable = readLatestDurableValue(profileKeysForPull.plans);

        // SH.2 architecture (Codex P1, 5th round) — AUTHENTICATED CONFLICT
        // SESSION substitution — mirrors plans/page.tsx exactly (see its
        // own detailed doc). When this transition's ownership check found
        // the raw content in storage attributed to a different, known
        // identity, every "current" fed into a conflict decision below is
        // forced to equal this pull's own effective baseline instead of a
        // real (possibly foreign-owned) read.
        const itemsForComparison = contentOwnershipMismatch ? effectiveBaseline.items : currentItems;
        const daysForComparison = contentOwnershipMismatch ? effectiveBaseline.days : currentDays;
        const plansRawForComparison = contentOwnershipMismatch ? effectiveBaseline.plansRaw : currentPlansRawDurable;

        // SH.2 architecture (Codex P1, 2nd round) — resolve the SIBLING
        // (Plans) dataset's own local-vs-cloud CANDIDATE (winning items,
        // before removed-day sanitization) EARLY, so reconcilePlannerSnapshot
        // below can reconcile it structurally alongside Lightning's own
        // items — not just extend days[] with its day IDs. Same
        // baseline-comparison model as Lightning's own domains: a fresh
        // raw read compared against effectiveBaseline.plansRaw (this
        // pull's causal baseline, advanced ahead of any pre-fetch freeze if
        // an accepted beacon was just resolved above) tells whether Plans
        // changed since this pull started. Codex P1 fix (4th round) — the
        // actual hydration WRITE to Plans' storage is deferred until AFTER
        // reconciliation below (it needs the sanitized result, not the raw
        // cloud payload — see reconcilePlannerSnapshot's own doc), unlike
        // the 2nd round's version of this code which wrote here first.
        const plansChangedLocally = plansRawForComparison !== effectiveBaseline.plansRaw;
        const plansCandidateItems: unknown[] =
          !plansChangedLocally && planner?.plans
            ? (planner.plans.items as unknown[])
            : parsePlansRawItems(plansRawForComparison);

        const { items: itemsCandidate, changedLocally: itemsChangedLocally } = pickWinningItems(
          effectiveBaseline.items,
          itemsForComparison,
          cloudLightningItems
        );
        const { days: daysCandidate, changedLocally: daysChangedLocally } = pickWinningDays(
          effectiveBaseline.days,
          daysForComparison,
          cloudDaysOrder
        );
        // Structural reconciliation (Codex P1, 4th round) — reconciles
        // BOTH domains that will actually be persisted this pull, not just
        // Lightning's own items plus a derived Plans day-id list:
        // itemsCandidate/itemsChangedLocally is trusted outright when
        // locally-won (never filtered merely because winningDays omits a
        // day it references — reconciled back in instead, which is also
        // what still closes Codex finding #3 from an earlier round —
        // Lightning re-adding a removed day before the coupled deletion
        // here happened to land); plansCandidateItems/plansChangedLocally
        // get the SAME two-way treatment for ITS actual items, not merely
        // its day IDs — a stale (cloud/unchanged) Plans item referencing a
        // day the winning days[] removed is now filtered OUT of the
        // returned siblingItems array itself, closing the gap where such
        // an item could survive verbatim in Plans' own persisted storage
        // even after its day was correctly dropped from days[] — see
        // reconcilePlannerSnapshot's own doc for the full rule.
        const { items: winningLightningItems, siblingItems: winningPlansItems, days: winningDays } =
          reconcilePlannerSnapshot(
            { items: itemsCandidate, changedLocally: itemsChangedLocally },
            { items: plansCandidateItems, changedLocally: plansChangedLocally },
            effectiveBaseline.days,
            daysCandidate
          );

        // SH.2 architecture (Codex P1, 7th round) — DURABLE-BEFORE-OWNERSHIP
        // for THIS page's own PRIMARY domain (Lightning's own items).
        // Codex P1 fix (12th round) — routes through the shared
        // commitLocalDomainRaw primitive (see its own doc in syncHelper.ts)
        // instead of a bespoke read-current/choose-winner/setItem sequence:
        // mirrors plans/page.tsx exactly — see its own detailed doc for the
        // full rationale (never trusts itemsRef.current/knownDaysRef.current
        // for "is a write still needed" — Codex finding #2; never clobbers a
        // same-tab or cross-tab write that lands after `currentItemsRaw` was
        // captured above — Codex finding #1).
        const nextItemsRaw = JSON.stringify({ version: 1, items: winningLightningItems });
        const itemsCommitStatus = await commitLocalDomainRaw(
          lightningKeyRef.current,
          currentItemsRaw,
          nextItemsRaw,
          isPullCurrent
        );
        // Codex P1 fix (13th round) — re-check after EVERY awaited
        // local-domain commit, before using its result for anything.
        // Mirrors plans/page.tsx exactly — see its own detailed doc.
        if (!isPullCurrent()) return;
        const primaryPersistSucceeded = isLocalDomainCommitSuccess(itemsCommitStatus);
        // Only touch React state once the durable write is confirmed (or
        // confirmed unnecessary) AND the winning result actually differs
        // from what's already rendered.
        if (primaryPersistSucceeded && JSON.stringify(winningLightningItems) !== JSON.stringify(itemsRef.current)) {
          setItems(winningLightningItems);
        }
        // Cloud "won" the items domain when local hadn't changed and a
        // valid cloud payload existed — safe to trust immediately as this
        // page's new baseline (see itemsBaselineRef's own doc: updating
        // here does not risk discarding an unpushed edit, since none
        // exists in this branch).
        const itemsCloudWon = !itemsChangedLocally && cloudLightningItems !== null;
        if (itemsCloudWon) {
          // Codex P1 fix (7th round; commit outcome generalized 12th) —
          // only trust winningLightningItems as the new fallback baseline
          // when it is actually durably confirmed on disk (committed or
          // noop). Mirrors plans/page.tsx.
          if (primaryPersistSucceeded) {
            itemsBaselineRef.current = winningLightningItems;
          }
        }

        // Phase 7.6.3 — Sync Hydration Safety: hydrate Plans into
        // localStorage so sync pushes always include a complete dataset
        // regardless of which page loads first. Codex P1 fix (4th round) —
        // writes the RECONCILED/sanitized winningPlansItems (from
        // reconcilePlannerSnapshot above), not planner.plans verbatim: a
        // stale item this pull's days reconciliation determined should be
        // dropped (its day removed by the winning days[], and Plans itself
        // didn't win this domain locally) must never survive into Plans'
        // own persisted storage just because it was still present in the
        // raw cloud payload — that was the actual gap (days[] correctly
        // excluded the day, but the orphaned item itself was written
        // through verbatim). Performed here — BEFORE the Days domain block
        // below — so that block's own day-invalidation refresh (reading
        // Plans' storage fresh) sees the sanitized content, not a stale
        // pre-write copy.
        // Phase 7.6.4 — Hydration Guard: only open syncReady when the
        // opposite-dataset write succeeds. A failed write leaves the key
        // missing, which syncHelper would treat as empty data on the next
        // push — potentially overwriting valid cloud state.
        // Codex P1 fix (10th round; commit primitive 12th) — this commit is
        // UNCONDITIONAL on whether `planner?.plans` existed at all;
        // persistence depends ONLY on whether the durable value on disk
        // actually differs from the reconciled winningPlansItems. Mirrors
        // plans/page.tsx's own Lightning-sibling fix exactly.
        const winningPlansRawToWrite = JSON.stringify({ version: 1, items: winningPlansItems });
        const plansCommitStatus = await commitLocalDomainRaw(
          profileKeysForPull.plans,
          currentPlansRaw,
          winningPlansRawToWrite,
          isPullCurrent
        );
        if (!isPullCurrent()) return;
        const hydrationSucceeded = isLocalDomainCommitSuccess(plansCommitStatus);
        // Codex P1 fix (1st round; commit outcome generalized 12th) —
        // tracks specifically whether THIS pull's final durable Plans value
        // is CLOUD-SOURCED (distinct from hydrationSucceeded, which is also
        // true on a "noop" outcome where disk already held that exact
        // value) — only a durably-confirmed, cloud-derived value is
        // eligible to advance Plans' confirmed baseline below.
        const plansHydrationWritten = hydrationSucceeded && !plansChangedLocally && !!planner?.plans;
        if (hydrationSucceeded) {
          plansRawBaselineRef.current = winningPlansRawToWrite;
        }

        // Days domain — same shared commit primitive as Lightning's own
        // items.
        const nextDaysRaw = JSON.stringify(winningDays);
        const daysCommitStatus = await commitLocalDomainRaw(
          daysKeyRef.current,
          currentDaysRaw,
          nextDaysRaw,
          isPullCurrent
        );
        if (!isPullCurrent()) return;
        const daysWriteFailed = !isLocalDomainCommitSuccess(daysCommitStatus);
        if (!daysWriteFailed && winningDays.join(",") !== knownDaysRef.current.join(",")) {
          setKnownDays(winningDays);
          // Revalidate activeDayId against the newly winning order: another
          // device may have removed the day this device currently has
          // active (e.g. Remove Day there, synced here). Mirrors the exact
          // same fallback plans/page.tsx already uses locally. Reads
          // activeDayIdRef (not the closure `activeDayId`) since this async
          // callback's closure could otherwise be stale relative to a
          // day-picker switch the user made while the pull was in flight.
          if (!winningDays.includes(activeDayIdRef.current)) {
            const nextActiveDayId = winningDays[0];
            setActiveDayId(nextActiveDayId);
            try {
              localStorage.setItem(activeDayKeyRef.current, nextActiveDayId);
            } catch {}
            // Refresh day-scoped Lightning state that depends on the active
            // day — would otherwise stay stale, showing plan items for the
            // now-invalid removed day, until some unrelated trigger (e.g.
            // the user manually picking a day) happened to refresh it.
            setPlanDayItems(loadPlanItemsForDay(profileKeysForPull.plans, nextActiveDayId));
          }
        }
        // Days FALLBACK baseline updates only when NEITHER domain had a
        // local, unconfirmed change this pull — i.e. winningDays is
        // entirely cloud-sourced (including any additive extension, since
        // that extension was itself derived from cloud-sourced winning
        // items) — AND the days write itself durably succeeded. If either
        // domain won locally, any extension may be locally sourced too;
        // leave this fallback stale so a later pull (absent a genuine
        // confirmed snapshot by then) keeps protecting it rather than
        // assuming it's safe.
        if (itemsCloudWon && !daysChangedLocally && !daysWriteFailed) {
          daysBaselineRef.current = winningDays;
        }

        // Same-tab writes do not fire a storage event, so refresh
        // planDayItems/allPlanItems explicitly after every pull. Reads
        // fresh from the storage KEY (not from `planner.plans` directly),
        // so this correctly reflects whichever data is actually in storage
        // — the cloud snapshot just written above, the foreign tab's newer
        // edit that write was skipped to protect, or (Codex P1, 10th round)
        // the reconciled B-safe/empty content this pull just wrote on a
        // 204/no-cloud-plans ownership transfer. Unconditional on
        // `planner?.plans` now — gating this UI refresh on cloud's presence
        // let it keep showing a previous identity's stale cross-referenced
        // plan items even after the underlying storage was correctly
        // overwritten.
        setPlanDayItems(loadPlanItemsForDay(profileKeysForPull.plans, safeActiveDayIdRef.current));
        setAllPlanItems(loadAllPlanItems(profileKeysForPull.plans));
        // Codex fix — a failed authoritative days[] write (daysWriteFailed)
        // keeps the gate closed exactly like a failed plans-hydration write
        // already does, so a stale locally-persisted order can never be
        // pushed back over the cloud's actual value. Codex P1 fix (7th
        // round) — also requires `primaryPersistSucceeded` (this page's own
        // Lightning items write). Mirrors plans/page.tsx.
        if (hydrationSucceeded && !daysWriteFailed && primaryPersistSucceeded) setSyncReady(true);

        // SH.2 architecture (Codex P1, 6th round) — DURABLE TRANSFER
        // BOUNDARY. Mirrors plans/page.tsx exactly — see its own detailed
        // comment and getLocalContentOwner's doc in syncHelper.ts. Codex P1
        // fix (7th round) — also requires `primaryPersistSucceeded`.
        if (pullCtx.userId && hydrationSucceeded && !daysWriteFailed && primaryPersistSucceeded) {
          setLocalContentOwner(pullCtx.profileId, pullCtx.userId);
        }

        // SH.2 architecture (Codex P1, 8th round) — beacon resolution was
        // MOVED to the top of this `.then()`, before winner selection.
        // Mirrors plans/page.tsx exactly — see its own detailed doc.

        // SH.2 architecture (Codex P1, 1st + 3rd rounds) — commit the
        // DURABLE confirmed baseline for whichever domain(s) this pull
        // determined were cloud-won AND successfully persisted. This is
        // what makes a pull-hydrated domain just as "confirmed" as a
        // pushed one, so a LATER pull's buildPostFetchPullBaseline()
        // never misclassifies it as an unsynced local edit — see
        // commitConfirmedBaseline's own doc in syncHelper.ts. Local-won
        // domains are simply omitted: their prior confirmation status is
        // left untouched, exactly matching this pull's own conflict
        // decision (never "retroactively" changed by a later event).
        // 3rd round: the commit is now identity-scoped (activeUserIdRef)
        // and revision-gated — it's skipped entirely when we don't know
        // which account this is for, or when the GET response carried no
        // server revision, since an un-ordered commit could otherwise
        // regress a newer confirmed snapshot written by a concurrent push.
        const acceptedForBaseline: {
          plans?: { version: number; items: unknown[] };
          lightning?: { version: number; items: unknown[] };
          days?: string[];
        } = {};
        // Codex P1 fix (7th round) — also requires `primaryPersistSucceeded`:
        // metadata must never advance ahead of the durable state it
        // describes. Mirrors plans/page.tsx.
        if (itemsCloudWon && primaryPersistSucceeded) {
          acceptedForBaseline.lightning = { version: 1, items: winningLightningItems };
        }
        if (plansHydrationWritten && planner?.plans) {
          // Codex P1 fix (4th round) — commit the SAME sanitized content
          // that was actually persisted to Plans' storage above, not the
          // raw planner.plans payload; committing the unsanitized version
          // would re-introduce the orphaned item into the durable
          // confirmed record even though it was correctly stripped from
          // local storage.
          acceptedForBaseline.plans = { version: planner.plans.version, items: winningPlansItems };
        }
        // Days is committed only when winningDays is ENTIRELY cloud-derived
        // — own items cloud-won, Plans didn't win locally either (so no
        // locally-sourced day could have been folded into the
        // reconciliation step above), days itself didn't win locally, and
        // the write actually succeeded. Mirrors the daysBaselineRef
        // fallback-tier condition just above, now also accounting for the
        // sibling dataset.
        if (itemsCloudWon && primaryPersistSucceeded && !plansChangedLocally && !daysChangedLocally && !daysWriteFailed) {
          acceptedForBaseline.days = winningDays;
        }
        if (pullCtx.userId && planner?.revision != null) {
          // Async (Codex P1, 4th round; no longer Web-Locks-dependent as of
          // the 11th — see commitConfirmedBaseline's own doc); fired
          // without awaiting since nothing later in this callback depends
          // on the commit having landed. Scoped to pullCtx.userId/
          // pullCtx.profileId (13th round), not the live refs.
          void commitConfirmedBaseline(
            pullCtx.userId,
            pullCtx.profileId,
            planner.revision,
            acceptedForBaseline
          );
        }
      })
      .catch(() => {
        if (!isPullCurrent()) return;
        // Cloud state is uncertain — keep push gate closed.
      });
    return () => { cancelled = true; };
  // `session` itself is deliberately excluded — mirrors plans/page.tsx
  // exactly, see its own detailed doc. `authenticatedUserId` (Codex P1,
  // 13th round) is included so this effect DOES still re-run on a genuine
  // authenticated-identity change even when `sessionStatus` never leaves
  // "authenticated". `staleRetryTick` (SH.2.1, this round) is included so a
  // stale-response bail-out's own scheduled replacement pull actually runs
  // this effect again — mirrors plans/page.tsx exactly, see its own doc.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, loaded, authenticatedUserId, staleRetryTick]);

  // Register a best-effort sendBeacon push on page unload.
  useEffect(() => {
    if (!syncReady || sessionStatus !== "authenticated") return;
    const cleanup = registerUnloadSync();
    return cleanup;
  }, [syncReady, sessionStatus]);

  // Single interval updates "now" every 10 seconds
  useEffect(() => {
    const id = setInterval(() => {
      setNow(nowInMinutes());
    }, 10_000);
    return () => clearInterval(id);
  }, []);

  // Hydrate selectedResort from localStorage on client mount (runs once).
  // If no page-specific stored resort exists, fall back to Settings default.
  // Sets ready=true last so the selector renders with the correct value — no flicker.
  // Note: bootstrapProfiles() has already run in the load effect above, setting resortKeyRef.
  useEffect(() => {
    try {
      const v = localStorage.getItem(resortKeyRef.current);
      if (v === "DLR" || v === "WDW") {
        setSelectedResort(v);
      } else {
        setSelectedResort(getSettingsDefaults().defaultResort);
      }
    } catch {}
    setReady(true);
  }, []);

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

  // Park name lookup: canonical normalized name → friendly park label.
  // Built from the same source as waitMap — no extra fetch.
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

  // Inline edit state — tracks which card is being edited (name + start/end times)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingStart, setEditingStart] = useState("");
  const [editingEnd, setEditingEnd] = useState("");
  const [editingStartErr, setEditingStartErr] = useState("");
  const [editingEndErr, setEditingEndErr] = useState("");

  // Canonical attraction names for autocomplete, scoped to selectedResort.
  const suggestions = useMemo(
    () => Array.from(waitMap.values()).map((v) => v.canonicalName),
    [waitMap]
  );

  // Phase 8.3.2 — Safe display-day resolution using the known planner day model (BUG A fix).
  // Rule: if activeDayId is a valid known planner day, use it exactly — even when zero
  // Lightning items exist for that day. A blank valid day must stay blank.
  // Fallback (stale/invalid activeDayId only): show first Lightning-populated day if
  // one exists; otherwise "day-1". Nothing is persisted or globally mutated here.
  const safeActiveDayId = useMemo(() => {
    if (knownDays.includes(activeDayId)) return activeDayId;
    if (items.length > 0) return items[0].dayId;
    return "day-1";
  }, [activeDayId, knownDays, items]);

  // Phase 8.8 — Listen for storage changes from My Plans (active day, dayParks, dayMeta).
  // Plans page owns writes; Lightning page reads reactively.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === activeDayKeyRef.current && e.newValue !== null) {
        const newDay = normalizeDayId(e.newValue);
        setActiveDayId(newDay);
        // Reload plan items scoped to the newly active day.
        setPlanDayItems(loadPlanItemsForDay(plansKeyRef.current, newDay));
        setAllPlanItems(loadAllPlanItems(plansKeyRef.current));
      }
      if (e.key === daysKeyRef.current) {
        // SH.2 architecture — UI-reactivity only: refresh this tab's
        // displayed knownDays to match what another tab just persisted,
        // purely to avoid a stale display. Conflict resolution no longer
        // depends on this listener at all — the pull effect above always
        // re-reads localStorage fresh and compares it against a stable
        // baseline (pickWinningDays/reconcilePlannerSnapshot in
        // crossDayChecks.ts), so there is nothing here to "protect" a
        // pending pull from; a genuine days[] change and a no-op hydration
        // write are treated identically since both are equally irrelevant
        // to the pull's own independent, storage-event-free comparison.
        const next = loadKnownDays(daysKeyRef.current);
        const isGenuineChange = next.join(",") !== knownDaysRef.current.join(",");
        if (isGenuineChange) {
          setKnownDays(next);
        }
      }
      if (e.key === dayParksKeyRef.current) {
        setDayParks(loadDayParks(dayParksKeyRef.current));
      }
      if (e.key === dayMetaKeyRef.current) {
        setDayMeta(loadDayMeta(dayMetaKeyRef.current));
      }
      if (e.key === plansKeyRef.current) {
        // Plans changed — re-infer using current active day. SH.2
        // architecture — UI-reactivity only, same rationale as the
        // daysKeyRef branch above: the pull effect's own fresh read plus
        // baseline comparison is what actually protects against a stale
        // cloud overwrite, not this listener.
        setPlanDayItems(loadPlanItemsForDay(plansKeyRef.current, safeActiveDayIdRef.current));
        setAllPlanItems(loadAllPlanItems(plansKeyRef.current));
      }
      // Phase 11.0 review fix — reconcile this page's own Lightning items when
      // another tab (e.g. My Plans doing Remove Day) writes the active profile's
      // Lightning storage key directly. Without this, a stale tab's in-memory
      // `items` still holds the removed day's entries, and the very next local
      // edit here would persist that stale array — resurrecting entries Remove
      // Day already deleted. This only ever fires for writes from OTHER tabs
      // (the tab that wrote the key never receives its own 'storage' event), so
      // it cannot clobber an in-progress edit made in this tab. SH.2
      // architecture — no ref-marking needed: the pull effect's own fresh
      // read of this same key at resolution time already reflects whatever
      // was just reloaded here, compared against the stable itemsBaselineRef.
      if (e.key === lightningKeyRef.current) {
        setItems(loadFromStorage(lightningKeyRef.current));
      }
      // SH.2 architecture — no confirmed-snapshot listener here (removed —
      // obsolete under the pull-start-baseline model). Each pull captures
      // its own causal baseline fresh, once, at pull start (see
      // buildPreFetchPullBaseline()) — a live cross-tab listener
      // that could update an in-use baseline mid-pull is exactly the
      // mechanism Codex P1 #2 flagged.
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Keep safeActiveDayIdRef in sync so the storage handler can read it without
  // capturing a stale closure.
  safeActiveDayIdRef.current = safeActiveDayId;

  // Phase 8.8 — Resolved park for the active day, matching My Plans resolution order:
  //   1. Manual override (dayParks entry) that matches selectedResort → Manual mode
  //      (same resort guard as My Plans: PARK_TO_RESORT[override] === selectedResort)
  //   2. Infer from plan items for this day via inferPlansContext → Auto mode
  //   3. null → Auto mode, "no park set yet"
  const { resolvedDayPark, dayParkMode } = useMemo<{
    resolvedDayPark: string | null;
    dayParkMode: "Manual" | "Auto";
  }>(() => {
    const override = dayParks[safeActiveDayId];
    if (override && PARK_TO_RESORT[override] === selectedResort) {
      return { resolvedDayPark: override, dayParkMode: "Manual" };
    }
    const inferred = inferPlansContext(
      planDayItems.map((it, i) => ({ id: String(i), name: it.name, timeLabel: "" }))
    );
    if (inferred.park) {
      return { resolvedDayPark: inferred.park, dayParkMode: "Auto" };
    }
    return { resolvedDayPark: null, dayParkMode: "Auto" };
  }, [dayParks, safeActiveDayId, planDayItems, selectedResort]);

  // Resort to use for mismatch lookups: prefer the resort of the resolved day park
  // so that MK-day + DLR overlay still resolves MK attractions correctly.
  const mismatchResort: ResortId =
    (resolvedDayPark ? (PARK_TO_RESORT[resolvedDayPark] ?? null) : null) ?? selectedResort;

  // Phase 8.8 — Build wait and park-id maps scoped to mismatchResort.
  // Scoping to one resort eliminates same-name cross-resort collisions (e.g. Space Mountain
  // exists in both DLR and WDW with different parks) and ensures lookupWait receives entries
  // from the resort the day actually belongs to, not the Lightning overlay resort.
  const { mismatchWaitMap, mismatchParkIdMap } = useMemo(() => {
    const source =
      LIVE_ENABLED && liveAttractions.length > 0 ? liveAttractions : mockAttractionWaits;
    const wMap = new Map<string, WaitEntry>();
    const pMap = new Map<string, string>();
    for (const a of source) {
      if (a.resortId !== mismatchResort) continue;
      wMap.set(normalizeKey(a.name), {
        status: a.status,
        waitMins: a.waitMins,
        canonicalName: a.name,
      });
      pMap.set(normalizeKey(a.name), a.parkId as string);
    }
    return { mismatchWaitMap: wMap, mismatchParkIdMap: pMap };
  }, [mismatchResort, liveAttractions]);

  // Phase 8.8 — Mismatch warning for add form.
  // Shown whenever the resolved day park (manual or auto-inferred) differs from the
  // attraction's park. No resolved park → no warning.
  const addFormMismatchWarning = useMemo<string | null>(() => {
    if (!resolvedDayPark || !rideName.trim()) return null;
    const aliases = mismatchResort === "DLR" ? ALIASES_DLR : ALIASES_WDW;
    const waitEntry = lookupWait(rideName.trim(), mismatchWaitMap, aliases);
    if (!waitEntry) return null;
    const attractionPark = mismatchParkIdMap.get(normalizeKey(waitEntry.canonicalName));
    if (!attractionPark || attractionPark === resolvedDayPark) return null;
    const attractionParkLabel = PARK_LABELS[attractionPark as ParkId] ?? attractionPark;
    const dayParkLabel = PARK_LABELS[resolvedDayPark as ParkId] ?? resolvedDayPark;
    return `This attraction is in ${attractionParkLabel}, but this day is currently set to ${dayParkLabel}.`;
  }, [resolvedDayPark, mismatchResort, rideName, mismatchWaitMap, mismatchParkIdMap]);

  // Phase 8.8 — Mismatch warning for inline edit form.
  const editMismatchWarning = useMemo<string | null>(() => {
    if (!resolvedDayPark || !editingName.trim()) return null;
    const aliases = mismatchResort === "DLR" ? ALIASES_DLR : ALIASES_WDW;
    const waitEntry = lookupWait(editingName.trim(), mismatchWaitMap, aliases);
    if (!waitEntry) return null;
    const attractionPark = mismatchParkIdMap.get(normalizeKey(waitEntry.canonicalName));
    if (!attractionPark || attractionPark === resolvedDayPark) return null;
    const attractionParkLabel = PARK_LABELS[attractionPark as ParkId] ?? attractionPark;
    const dayParkLabel = PARK_LABELS[resolvedDayPark as ParkId] ?? resolvedDayPark;
    return `This attraction is in ${attractionParkLabel}, but this day is currently set to ${dayParkLabel}.`;
  }, [resolvedDayPark, mismatchResort, editingName, mismatchWaitMap, mismatchParkIdMap]);

  // Phase 8.3 — Items visible in the active day (display-only; storage unchanged).
  // All items are stored together; this view is scoped to the current day.
  const displayedItems = useMemo(
    () => items.filter((it) => it.dayId === safeActiveDayId),
    [items, safeActiveDayId]
  );

  // Compute time conflict sets from current day's items only (Phase 8.3),
  // substituting live edit values for the item currently being edited
  // so warnings update on every keystroke.
  const { invalidIds: llInvalidIds, overlapCountById: llOverlapCountById } = useMemo(() => {
    const conflictInput = displayedItems.map((item) => {
      if (item.id === editingId) {
        // Use live editing values when valid; fall back to stored values otherwise.
        const liveStart = normalizeTimeInput(editingStart) || item.startTime;
        const rawEnd = editingEnd.trim()
          ? (normalizeTimeInput(editingEnd) ?? item.endTime)
          : item.endTime;
        return { id: item.id, start: liveStart, end: rawEnd || undefined };
      }
      return { id: item.id, start: item.startTime, end: item.endTime || undefined };
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
  }, [displayedItems, editingId, editingStart, editingEnd]);

  // Phase 9.4 — Lightning Lane cross-day awareness, reusing the exact same
  // identity resolution, duplicate grouping, and overlap-test semantics as My
  // Plans' crossDayChecks (now shared via computeCrossDayChecks) instead of a
  // separate, narrower reimplementation. detectTimeConflicts silently drops any
  // item lacking a valid end time from overlap consideration, which is what
  // previously caused point-time-plan-vs-Lightning-window conflicts to be missed.
  const crossDayChecks = useMemo(() => {
    // Codex P2 — ignore Lightning entries whose dayId no longer exists in
    // knownDays (e.g. a deleted planner day) before building the by-day map.
    const knownDaySet = new Set(knownDays);
    const llItemsByDay = new Map<string, Array<{ name: string; startTime: string; endTime: string }>>();
    for (const it of items) {
      if (!knownDaySet.has(it.dayId)) continue;
      const bucket = llItemsByDay.get(it.dayId) ?? [];
      bucket.push({ name: it.name, startTime: it.startTime, endTime: it.endTime });
      llItemsByDay.set(it.dayId, bucket);
    }
    const planItemsWithIds = allPlanItems.map((it, i) => ({
      id: `p${i}`,
      name: it.name,
      dayId: it.dayId,
      timeLabel: it.timeLabel ?? "",
    }));
    return computeCrossDayChecks(planItemsWithIds, llItemsByDay, knownDays, dayParks);
  }, [items, allPlanItems, knownDays, dayParks]);

  // Lightning-vs-Plan conflicts for the active day only (same scope as before).
  const activeDayLightningConflicts = useMemo(
    () => crossDayChecks.lightningPlanConflicts.filter((c) => c.planDayId === safeActiveDayId),
    [crossDayChecks, safeActiveDayId]
  );

  // "Lightning Lane on Multiple Days" — same attraction booked via Lightning
  // on 2+ distinct days. Filtered to groups that include the active day, with
  // the active day emphasized, mirroring My Plans' active-day filtering.
  const activeDayLightningDuplicates = useMemo(
    () =>
      crossDayChecks.lightningDuplicates.filter((dup) =>
        dup.parkSections.some((sec) => sec.dayIds.includes(safeActiveDayId))
      ),
    [crossDayChecks, safeActiveDayId]
  );

  function handleStartEdit(item: LightningItem) {
    setEditingId(item.id);
    setEditingName(item.name);
    // Prefill times in 12h format for friendly editing (stored as 24h, displayed as 12h)
    setEditingStart(item.startTime ? formatSingleTime(item.startTime) : "");
    setEditingEnd(item.endTime ? formatSingleTime(item.endTime) : "");
    setEditingStartErr("");
    setEditingEndErr("");
  }

  function handleSaveEdit() {
    if (!editingId || !editingName.trim()) return;
    const normStart = normalizeTimeInput(editingStart);
    if (!normStart) {
      setEditingStartErr("Invalid time. Try: 3pm, 3:30 PM, 15:30, or 1530");
      return;
    }
    const normEnd = editingEnd.trim() ? normalizeTimeInput(editingEnd) : "";
    if (normEnd === null) {
      setEditingEndErr("Invalid time. Try: 4pm, 4:30 PM, 16:30, or 1630");
      return;
    }
    setItems((prev) =>
      prev.map((it) =>
        it.id === editingId
          ? { ...it, name: editingName.trim(), startTime: normStart, endTime: normEnd }
          : it
      )
    );
    setEditingId(null);
    setEditingName("");
    setEditingStart("");
    setEditingEnd("");
    setEditingStartErr("");
    setEditingEndErr("");
  }

  function handleCancelEdit() {
    setEditingId(null);
    setEditingName("");
    setEditingStart("");
    setEditingEnd("");
    setEditingStartErr("");
    setEditingEndErr("");
  }

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
      dayId: safeActiveDayId, // Phase 8.3.2 — creation day === displayed day (BUG B fix)
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

  // Phase 9.4 — Day picker write path. Writes the same per-profile activeDayId
  // key that My Plans owns, so switching days here stays in sync with My Plans
  // (same-tab writes don't fire 'storage', so planDayItems is refreshed inline).
  function handleSelectDay(dayId: string) {
    const normalized = normalizeDayId(dayId);
    try {
      localStorage.setItem(activeDayKeyRef.current, normalized);
    } catch {}
    setActiveDayId(normalized);
    setPlanDayItems(loadPlanItemsForDay(plansKeyRef.current, normalized));
  }

  // Phase 8.9.2 — removes all Lightning entries for the captured target day only.
  // Uses setItems() so the existing persist + scheduleSync effects fire normally.
  function handleClearDayLightning() {
    const target = clearDayLightningTarget;
    if (!target) return;
    setItems((prev) => {
      if (!prev.some((item) => item.dayId === target)) return prev;
      return prev.filter((item) => item.dayId !== target);
    });
    setClearDayLightningTarget(null);
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
      <div className="lightning-header">
        <h1 className="title" style={{ margin: 0 }}>Lightning Lane</h1>
        <div className="lightning-header-actions">
          {activeProfileName && (
            <span style={{ fontSize: "12px", color: "#9ca3af" }}>Profile: {activeProfileName}</span>
          )}
          <button
            style={{
              background: "#fff",
              color: "#dc2626",
              border: "1px solid #fca5a5",
              borderRadius: 8,
              fontSize: "0.85rem",
              fontWeight: 600,
              padding: "0.4rem 0.75rem",
              cursor: displayedItems.length === 0 ? "not-allowed" : "pointer",
              whiteSpace: "nowrap",
              opacity: displayedItems.length === 0 ? 0.3 : 1,
            }}
            disabled={displayedItems.length === 0}
            onClick={() => setClearDayLightningTarget(safeActiveDayId)}
            title="Clear Lightning selections from this day only. Plans are preserved."
          >
            Clear Day Lightning
          </button>
        </div>
      </div>
      <style jsx>{`
        .lightning-header {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          margin-bottom: 1rem;
        }
        .lightning-header-actions {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        @media (max-width: 480px) {
          .lightning-header {
            flex-direction: column;
            align-items: stretch;
            gap: 0.5rem;
          }
          .lightning-header-actions {
            flex-wrap: wrap;
          }
        }
      `}</style>

      {/* Phase 8.9.2 — Clear Day Lightning confirmation (target captured at click time) */}
      {clearDayLightningTarget !== null && (
        <div style={{ marginBottom: "1rem", padding: "0.6rem 1rem", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.9rem", color: "#b91c1c", flex: "1 1 auto", minWidth: 0 }}>
            {`Clear all Lightning selections from ${dayContextLabel(clearDayLightningTarget, dayMeta, knownDays)}?`}
          </span>
          <button
            style={{ background: "#fff", border: "1px solid #d1d5db", borderRadius: 6, padding: "0.3rem 0.75rem", cursor: "pointer", fontSize: "0.85rem", whiteSpace: "nowrap" }}
            onClick={() => setClearDayLightningTarget(null)}
          >
            Cancel
          </button>
          <button
            style={{ background: "#dc2626", color: "#fff", border: "none", borderRadius: 6, padding: "0.3rem 0.75rem", cursor: "pointer", fontSize: "0.85rem", fontWeight: 600, whiteSpace: "nowrap" }}
            onClick={handleClearDayLightning}
          >
            Yes, clear
          </button>
        </div>
      )}

      {/* Phase 9.4 — Day Picker, shared with My Plans via the same active-day
          storage key. Switching days here updates the same per-profile
          activeDayId used by My Plans, so both pages stay in sync. */}
      {loaded && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.75rem" }}>
          {knownDays.map((dayId) => {
            const isActive = safeActiveDayId === dayId;
            return (
              <button
                key={dayId}
                aria-pressed={isActive}
                onClick={() => handleSelectDay(dayId)}
                style={{
                  background: isActive ? "#1e3a5f" : "#f9fafb",
                  color: isActive ? "#fff" : "#374151",
                  border: `1px solid ${isActive ? "#1e3a5f" : "#d1d5db"}`,
                  borderRadius: 8,
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  padding: "0.4rem 0.75rem",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {dayContextLabel(dayId, dayMeta, knownDays)}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Phase 8.8: Active Day Context Banner ── */}
      {loaded && (
        <div
          style={{
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            borderRadius: 10,
            padding: "0.6rem 1rem",
            marginBottom: "1rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.5rem",
          }}
        >
          <div>
            <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "#1e40af", lineHeight: 1.3 }}>
              {dayContextLabel(safeActiveDayId, dayMeta, knownDays)}
            </div>
            {resolvedDayPark ? (
              <div style={{ fontSize: "0.78rem", color: "#3b82f6", marginTop: 1 }}>
                {PARK_LABELS[resolvedDayPark as ParkId] ?? resolvedDayPark}{" "}
                <span style={{ color: "#93c5fd" }}>({dayParkMode})</span>
              </div>
            ) : (
              <div style={{ fontSize: "0.78rem", color: "#93c5fd", marginTop: 1 }}>
                Auto — no park set yet
              </div>
            )}
          </div>
        </div>
      )}

      {/* Phase 9.4 — Lightning Lane on Multiple Days: same attraction booked via
          Lightning on 2+ distinct days. Uses the same duplicate detection /
          canonical matching as My Plans' cross-day checks; hidden when empty.
          The active day is emphasized the same way My Plans does it. */}
      {loaded && activeDayLightningDuplicates.length > 0 && (
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.75rem 1rem",
            background: "#fffbeb",
            border: "1px solid #fcd34d",
            borderRadius: 8,
          }}
        >
          <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "#78350f", textTransform: "uppercase", letterSpacing: "0.04em", marginTop: "0.4rem", marginBottom: "0.2rem" }}>
            Lightning Lane on Multiple Days
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {activeDayLightningDuplicates.map((dup, i) => (
              <li
                key={dup.identityKey}
                style={{
                  fontSize: "0.8rem",
                  color: "#92400e",
                  padding: "0.25rem 0",
                  borderTop: i === 0 ? "none" : "1px solid #fde68a",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.1rem",
                }}
              >
                <span style={{ fontWeight: 500 }}>{dup.displayName}</span>
                {dup.parkSections.map((sec) => (
                  <span key={sec.parkLabel} style={{ color: "#b45309" }}>
                    {sec.parkLabel}:{" "}
                    {sec.dayIds.map((d, di) => (
                      <span key={d}>
                        {di > 0 && ", "}
                        {d === safeActiveDayId ? (
                          <strong>Current: {dayContextLabel(d, dayMeta, knownDays)}</strong>
                        ) : (
                          dayContextLabel(d, dayMeta, knownDays)
                        )}
                      </span>
                    ))}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Phase 9.4 — Lightning Lane conflicts for the active day. Mirrors the
          "Lightning Lane conflicts" section on My Plans; hidden when empty.
          Cross-day duplicate warnings are shown separately above. */}
      {loaded && activeDayLightningConflicts.length > 0 && (
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.75rem 1rem",
            background: "#fffbeb",
            border: "1px solid #fcd34d",
            borderRadius: 8,
          }}
        >
          <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "#78350f", textTransform: "uppercase", letterSpacing: "0.04em", marginTop: "0.4rem", marginBottom: "0.2rem" }}>
            Lightning Lane conflicts
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {activeDayLightningConflicts.map((c, i) => (
              <li
                key={c.id}
                style={{
                  fontSize: "0.8rem",
                  color: "#92400e",
                  padding: "0.25rem 0",
                  borderTop: i === 0 ? "none" : "1px solid #fde68a",
                }}
              >
                <span style={{ fontWeight: 500 }}>{c.attractionName}</span>
                <span style={{ color: "#b45309" }}>
                  {" "}
                  — Plan {formatTimeLabel(c.planTime)} · Lightning {formatTimeLabel(c.lightningTime)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

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
          <AttractionSuggestInput
            value={rideName}
            onChange={setRideName}
            suggestions={suggestions}
            placeholder="e.g. Space Mountain"
            inputStyle={inputStyle()}
            onKeyDown={(e) => { if (e.key === "Enter" && formValid) handleAdd(); }}
          />
        </div>

        {/* Phase 8.8 — Park mismatch warning (informational only, does not block save) */}
        {addFormMismatchWarning && (
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.4rem",
              background: "#fffbeb",
              border: "1px solid #fcd34d",
              borderRadius: 8,
              padding: "0.5rem 0.75rem",
              marginBottom: "0.875rem",
              fontSize: "0.8rem",
              color: "#92400e",
            }}
          >
            <span style={{ flexShrink: 0 }}>⚠</span>
            <span>{addFormMismatchWarning}</span>
          </div>
        )}

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

      {/* ── Resort Toggle — scopes live wait overlay to selected resort.
          Gated by ready to prevent a DLR→WDW flip when WDW is stored. ── */}
      {ready ? (
        <div style={{ display: "flex", gap: 8, marginBottom: "0.5rem" }}>
          {(Object.keys(RESORT_LABELS) as ResortId[]).map((resortId) => (
            <button
              key={resortId}
              onClick={() => {
                setSelectedResort(resortId);
                try { localStorage.setItem(resortKeyRef.current, resortId); } catch {}
              }}
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
      ) : (
        <div style={{ display: "flex", gap: 8, marginBottom: "0.5rem" }}>
          <div style={{ flex: "1 1 0%", height: 36, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
          <div style={{ flex: "1 1 0%", height: 36, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
        </div>
      )}
      <p style={{ fontSize: "0.7rem", color: "#9ca3af", marginBottom: "0.75rem" }}>
        Wait overlay: {selectedResort}
      </p>

      {/* ── Reservation List ── */}
      {!loaded ? null : displayedItems.length === 0 ? (
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
          {sortedItems(displayedItems, now).map((item) => {
            const bucket = getBucket(item, now);
            const aliases = selectedResort === "DLR" ? ALIASES_DLR : ALIASES_WDW;
            const waitEntry = lookupWait(item.name, waitMap, aliases);
            const parkLabel = waitEntry
              ? (parkMap.get(normalizeKey(waitEntry.canonicalName)) ?? null)
              : null;
            return (
              <ReservationCard
                key={item.id}
                item={item}
                bucket={bucket}
                now={now}
                onRemove={() => handleRemove(item.id)}
                waitEntry={waitEntry}
                parkLabel={parkLabel}
                isEditing={editingId === item.id}
                editingName={editingName}
                editingStart={editingStart}
                editingEnd={editingEnd}
                editingStartErr={editingStartErr}
                editingEndErr={editingEndErr}
                onEditNameChange={setEditingName}
                onEditStartChange={(v) => { setEditingStart(v); setEditingStartErr(""); }}
                onEditEndChange={(v) => { setEditingEnd(v); setEditingEndErr(""); }}
                onEdit={() => handleStartEdit(item)}
                onEditSave={handleSaveEdit}
                onEditCancel={handleCancelEdit}
                suggestions={suggestions}
                isInvalid={llInvalidIds.has(item.id)}
                overlapCount={llOverlapCountById[item.id] ?? 0}
                editMismatchWarning={editingId === item.id ? editMismatchWarning : null}
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
  parkLabel,
  isEditing,
  editingName,
  editingStart,
  editingEnd,
  editingStartErr,
  editingEndErr,
  onEditNameChange,
  onEditStartChange,
  onEditEndChange,
  onEdit,
  onEditSave,
  onEditCancel,
  suggestions,
  isInvalid,
  overlapCount,
  editMismatchWarning,
}: {
  item: LightningItem;
  bucket: Bucket;
  now: number;
  onRemove: () => void;
  waitEntry: WaitEntry | null;
  parkLabel: string | null;
  isEditing: boolean;
  editingName: string;
  editingStart: string;
  editingEnd: string;
  editingStartErr: string;
  editingEndErr: string;
  onEditNameChange: (v: string) => void;
  onEditStartChange: (v: string) => void;
  onEditEndChange: (v: string) => void;
  onEdit: () => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  suggestions: string[];
  isInvalid: boolean;
  overlapCount: number;
  editMismatchWarning: string | null;
}) {
  const showCountdown = bucket === "soon" || bucket === "upcoming";
  const countdown = showCountdown ? formatCountdown(item, now) : "";

  // Compute live wait badge — same logic as My Plans (getWaitBadgeProps).
  // Status overrides minutes: Down/Closed show status label, operating shows "X min".
  const liveBadge = (() => {
    if (!waitEntry) return null;
    return getWaitBadgeProps({ status: waitEntry.status, waitMins: waitEntry.waitMins });
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
          {/* Ride name + live wait badge — or inline edit panel */}
          {isEditing ? (
            <div style={{ marginBottom: "0.5rem" }}>
              {/* Attraction name */}
              <AttractionSuggestInput
                value={editingName}
                onChange={onEditNameChange}
                suggestions={suggestions}
                placeholder="Ride name"
                inputStyle={{
                  width: "100%",
                  padding: "0.5rem 0.65rem",
                  fontSize: "1rem",
                  borderRadius: 8,
                  border: "1.5px solid #2563eb",
                  outline: "none",
                  boxSizing: "border-box",
                  background: "#fff",
                }}
                onKeyDown={(e) => { if (e.key === "Escape") onEditCancel(); }}
                autoFocus
              />
              {/* Phase 8.8 — Park mismatch warning in inline edit (informational only) */}
              {editMismatchWarning && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "0.3rem",
                    background: "#fffbeb",
                    border: "1px solid #fcd34d",
                    borderRadius: 6,
                    padding: "0.35rem 0.6rem",
                    marginTop: 6,
                    fontSize: "0.75rem",
                    color: "#92400e",
                  }}
                >
                  <span style={{ flexShrink: 0 }}>⚠</span>
                  <span>{editMismatchWarning}</span>
                </div>
              )}
              {/* Start time (prefilled in 12h, accepts any format) */}
              <div style={{ marginTop: 6 }}>
                <input
                  type="text"
                  value={editingStart}
                  onChange={(e) => onEditStartChange(e.target.value)}
                  placeholder="Start time (e.g. 3:00 PM, 15:00)"
                  style={{
                    width: "100%",
                    padding: "0.45rem 0.65rem",
                    fontSize: "0.9rem",
                    borderRadius: 8,
                    border: `1.5px solid ${editingStartErr ? "#dc2626" : "#d1d5db"}`,
                    outline: "none",
                    boxSizing: "border-box",
                    background: "#fff",
                  }}
                />
                {editingStartErr && (
                  <p style={{ color: "#dc2626", fontSize: "0.75rem", margin: "0.2rem 0 0" }}>
                    {editingStartErr}
                  </p>
                )}
              </div>
              {/* End time (optional) */}
              <div style={{ marginTop: 6 }}>
                <input
                  type="text"
                  value={editingEnd}
                  onChange={(e) => onEditEndChange(e.target.value)}
                  placeholder="End time (optional)"
                  style={{
                    width: "100%",
                    padding: "0.45rem 0.65rem",
                    fontSize: "0.9rem",
                    borderRadius: 8,
                    border: `1.5px solid ${editingEndErr ? "#dc2626" : "#d1d5db"}`,
                    outline: "none",
                    boxSizing: "border-box",
                    background: "#fff",
                  }}
                />
                {editingEndErr && (
                  <p style={{ color: "#dc2626", fontSize: "0.75rem", margin: "0.2rem 0 0" }}>
                    {editingEndErr}
                  </p>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button
                  onClick={onEditSave}
                  disabled={!editingName.trim()}
                  style={{
                    flex: 1,
                    padding: "0.4rem 0.75rem",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    borderRadius: 7,
                    border: "none",
                    background: editingName.trim() ? "#1a1a2e" : "#e5e7eb",
                    color: editingName.trim() ? "#fff" : "#9ca3af",
                    cursor: editingName.trim() ? "pointer" : "not-allowed",
                    minHeight: 36,
                  }}
                >
                  Save
                </button>
                <button
                  onClick={onEditCancel}
                  style={{
                    flex: 1,
                    padding: "0.4rem 0.75rem",
                    fontSize: "0.85rem",
                    borderRadius: 7,
                    border: "1.5px solid #e5e7eb",
                    background: "none",
                    color: "#6b7280",
                    cursor: "pointer",
                    minHeight: 36,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
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
          )}

          {/* Canonical attraction name + park line — only when a match exists */}
          {waitEntry &&
            (waitEntry.status === "DOWN" || waitEntry.status === "CLOSED" || waitEntry.waitMins != null) && (
            <>
              {normalizeKey(waitEntry.canonicalName) !== normalizeKey(item.name) && (
                <div
                  style={{
                    fontSize: "0.7rem",
                    color: "#9ca3af",
                    fontStyle: "italic",
                    lineHeight: 1.3,
                    marginTop: "0.1rem",
                    wordBreak: "break-word",
                  }}
                >
                  {waitEntry.canonicalName}
                </div>
              )}
              {parkLabel && (
                <div
                  style={{
                    fontSize: "0.7rem",
                    color: "#9ca3af",
                    lineHeight: 1.3,
                    marginTop: "0.1rem",
                    marginBottom: "0.15rem",
                    wordBreak: "break-word",
                  }}
                >
                  {parkLabel}
                </div>
              )}
            </>
          )}

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

          {isInvalid ? (
            <p style={{ fontSize: "0.8rem", color: "#dc2626", margin: "0.3rem 0 0" }}>
              ⚠️ End time is before start time
            </p>
          ) : overlapCount > 0 ? (
            <p style={{ fontSize: "0.8rem", color: "#d97706", margin: "0.3rem 0 0" }}>
              ⚠️ Overlaps with {overlapCount === 1 ? "1 other item" : `${overlapCount} other items`}
            </p>
          ) : null}
        </div>

        {/* Edit + Remove buttons */}
        {!isEditing && (
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {/* Edit — matches Plans .icon-btn style exactly */}
            <button
              onClick={onEdit}
              aria-label={`Edit ${item.name}`}
              style={{
                background: "none",
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                padding: 0,
                fontSize: "1rem",
                color: "#6b7280",
                cursor: "pointer",
                minWidth: 44,
                minHeight: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background-color 0.15s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = "#f9fafb";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = "";
              }}
            >
              ✏️
            </button>
            {/* Delete — matches Plans .icon-btn.danger style exactly */}
            <button
              onClick={onRemove}
              aria-label={`Remove ${item.name}`}
              style={{
                background: "none",
                border: "1px solid #fca5a5",
                borderRadius: 6,
                padding: 0,
                fontSize: "1rem",
                color: "#dc2626",
                cursor: "pointer",
                minWidth: 44,
                minHeight: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background-color 0.15s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = "#fef2f2";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = "";
              }}
            >
              🗑
            </button>
          </div>
        )}
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

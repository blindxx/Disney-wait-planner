/**
 * plannerContextSnapshot.ts — Phase 10.4 Tom Planner-Aware Context
 *
 * Builds a small, read-only summary of the active profile's local planner
 * state (days, plans, Lightning selections) so Tom can answer questions like
 * "what do I have planned today?" or "what am I repeating?" without ever
 * writing back to planner storage.
 *
 * Reads only the existing namespaced planner localStorage keys (via
 * profileStorage's buildNamespacedKey) — never mutates them, never reads
 * unrelated keys, and never includes secrets, sync tokens, account data, or
 * raw backup payloads. Item counts are capped to keep the payload compact.
 */

import { bootstrapProfiles, getActiveProfile, buildNamespacedKey } from "./profileStorage";
import { normalizeKey } from "./plansMatching";
import { inferPlansContext } from "./plansContextInference";
import { detectTimeConflicts } from "./timeConflicts";

/** Hard cap on plan/Lightning items included per dataset, to keep the payload compact. */
const MAX_ITEMS = 200;
const MAX_NAME_LEN = 120;

/**
 * Client-side byte budget, kept safely under the server's hard cap
 * (MAX_PLANNER_CONTEXT_BYTES in api/tom/ask/route.ts) so the proxy almost
 * never has to drop planner_context outright — large planners are truncated
 * here instead of being dropped wholesale. Measured the same way the server
 * measures it (JSON.stringify(...).length) so the two stay comparable.
 */
const MAX_SNAPSHOT_BYTES = 29_000;

type SnapshotItemType = "attraction" | "dining" | "entertainment";

export type PlannerContextSnapshotItem = {
  dayId: string;
  name: string;
  type: SnapshotItemType;
  time: string;
};

export type PlannerContextSnapshotLightningItem = {
  dayId: string;
  name: string;
  startTime: string;
  endTime: string;
};

export type PlannerContextSnapshotDay = {
  id: string;
  label: string;
  date?: string;
  park?: string;
};

export type PlannerContextSnapshotRepeat = { name: string; dayIds: string[] };

export type PlannerContextSnapshotConflict = {
  dayId: string;
  name: string;
  planTime: string;
  lightningStart: string;
  lightningEnd: string;
};

export type PlannerContextSnapshot = {
  profile: { id: string; name: string };
  resort?: string;
  park?: string;
  days: PlannerContextSnapshotDay[];
  plans: PlannerContextSnapshotItem[];
  lightning: PlannerContextSnapshotLightningItem[];
  repeats: PlannerContextSnapshotRepeat[];
  conflicts: PlannerContextSnapshotConflict[];
  /** Present (and true) only when some data was left out to fit the byte budget. */
  meta?: { truncated: true };
};

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** "day-1" → "Day 1". Falls back to the raw id — mirrors plans/lightning pages. */
function dayLabelFromId(dayId: string): string {
  const n = parseInt(dayId.split("-")[1], 10);
  return isNaN(n) ? dayId : `Day ${n}`;
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Resort/park session keys store a plain string (not JSON) — read as-is. */
function readPlainString(key: string): string | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw && raw.trim() ? raw : undefined;
  } catch {
    return undefined;
  }
}

function readDays(profileId: string): string[] {
  const parsed = readJson(buildNamespacedKey(profileId, "days"));
  if (Array.isArray(parsed)) {
    const valid = parsed.filter(
      (d): d is string => typeof d === "string" && /^day-[1-9]\d*$/.test(d)
    );
    if (valid.length > 0) return valid;
  }
  return ["day-1"];
}

function readDayMeta(profileId: string): Record<string, { label?: string; date?: string }> {
  const parsed = readJson(buildNamespacedKey(profileId, "dayMeta"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const result: Record<string, { label?: string; date?: string }> = {};
  for (const [dayId, rawMeta] of Object.entries(parsed as Record<string, unknown>)) {
    if (!rawMeta || typeof rawMeta !== "object") continue;
    const m = rawMeta as Record<string, unknown>;
    const label = typeof m.label === "string" && m.label.trim() ? m.label.trim() : undefined;
    const date = typeof m.date === "string" && m.date.trim() ? m.date.trim() : undefined;
    if (label || date) result[dayId] = { label, date };
  }
  return result;
}

function readDayParks(profileId: string): Record<string, string> {
  const parsed = readJson(buildNamespacedKey(profileId, "dayParks"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const result: Record<string, string> = {};
  for (const [dayId, park] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof park === "string" && park.trim()) result[dayId] = park;
  }
  return result;
}

/** Mirrors the { version, items } / legacy-array storage shape used by plans + lightning. */
function readItemsDataset(key: string): unknown[] {
  const parsed = readJson(key);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).items)) {
    return (parsed as Record<string, unknown>).items as unknown[];
  }
  return [];
}

function toPlanItem(raw: unknown): PlannerContextSnapshotItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim()) return null;
  const type: SnapshotItemType = r.type === "dining" || r.type === "entertainment" ? r.type : "attraction";
  return {
    dayId: typeof r.dayId === "string" && r.dayId ? r.dayId : "day-1",
    name: truncate(r.name, MAX_NAME_LEN),
    type,
    time: typeof r.timeLabel === "string" ? r.timeLabel : "",
  };
}

function toLightningItem(raw: unknown): PlannerContextSnapshotLightningItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim()) return null;
  return {
    dayId: typeof r.dayId === "string" && r.dayId ? r.dayId : "day-1",
    name: truncate(r.name, MAX_NAME_LEN),
    startTime: typeof r.startTime === "string" ? r.startTime : "",
    endTime: typeof r.endTime === "string" ? r.endTime : "",
  };
}

/** Items whose normalized name appears on 2+ distinct days. */
function findRepeats(plans: PlannerContextSnapshotItem[]): PlannerContextSnapshotRepeat[] {
  const byKey = new Map<string, { name: string; dayIds: Set<string> }>();
  for (const p of plans) {
    const key = normalizeKey(p.name);
    if (!key) continue;
    const entry = byKey.get(key) ?? { name: p.name, dayIds: new Set<string>() };
    entry.dayIds.add(p.dayId);
    byKey.set(key, entry);
  }
  const repeats: PlannerContextSnapshotRepeat[] = [];
  for (const { name, dayIds } of byKey.values()) {
    if (dayIds.size > 1) repeats.push({ name, dayIds: [...dayIds] });
  }
  return repeats;
}

/**
 * Same-day / same-name plan + Lightning pairs whose time ranges actually
 * overlap. Same day + same name alone is not a conflict — the Plans page
 * only surfaces a Lightning/plan conflict once detectTimeConflicts (the
 * same interval-overlap engine used by crossDayChecks.ts) confirms a real
 * overlap, so this mirrors that requirement rather than introducing a
 * separate, looser definition of "conflict". Items with no usable time on
 * either side never produce a conflict.
 */
function findConflicts(
  plans: PlannerContextSnapshotItem[],
  lightning: PlannerContextSnapshotLightningItem[]
): PlannerContextSnapshotConflict[] {
  const lightningByDayAndKey = new Map<string, PlannerContextSnapshotLightningItem>();
  for (const l of lightning) {
    lightningByDayAndKey.set(`${l.dayId}::${normalizeKey(l.name)}`, l);
  }
  const conflicts: PlannerContextSnapshotConflict[] = [];
  for (const p of plans) {
    const match = lightningByDayAndKey.get(`${p.dayId}::${normalizeKey(p.name)}`);
    if (!match || !match.startTime) continue;

    const rangeMatch = p.time.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    const planStart = rangeMatch ? rangeMatch[1] : /^\d{1,2}:\d{2}$/.test(p.time) ? p.time : undefined;
    if (!planStart) continue; // no usable plan time — never a conflict
    const planEnd = rangeMatch ? rangeMatch[2] : undefined;

    const { overlaps } = detectTimeConflicts([
      { id: "plan", start: planStart, end: planEnd },
      { id: "lightning", start: match.startTime, end: match.endTime || undefined },
    ]);
    if (overlaps.length === 0) continue;

    conflicts.push({
      dayId: p.dayId,
      name: p.name,
      planTime: p.time,
      lightningStart: match.startTime,
      lightningEnd: match.endTime,
    });
  }
  return conflicts;
}

function jsonSize(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Keeps at most the first half of an array (rounded up), or [] once down to 1 element. */
function halve<T>(arr: T[]): T[] {
  return arr.length <= 1 ? [] : arr.slice(0, Math.ceil(arr.length / 2));
}

/**
 * Trims a snapshot to fit within MAX_SNAPSHOT_BYTES, preferring a partial
 * snapshot over dropping planner_context entirely (the server otherwise
 * drops anything over its own cap). Cuts in order of least- to
 * most-important: conflicts, repeats, Lightning items, plan items, then
 * (as a last resort) days — profile/resort/park are never cut.
 */
function fitToByteBudget(snapshot: PlannerContextSnapshot): PlannerContextSnapshot {
  if (jsonSize(snapshot) <= MAX_SNAPSHOT_BYTES) return snapshot;

  const trimmed: PlannerContextSnapshot = { ...snapshot, meta: { truncated: true } };

  trimmed.conflicts = [];
  if (jsonSize(trimmed) <= MAX_SNAPSHOT_BYTES) return trimmed;

  trimmed.repeats = [];
  if (jsonSize(trimmed) <= MAX_SNAPSHOT_BYTES) return trimmed;

  while (trimmed.lightning.length > 0 && jsonSize(trimmed) > MAX_SNAPSHOT_BYTES) {
    trimmed.lightning = halve(trimmed.lightning);
  }
  while (trimmed.plans.length > 0 && jsonSize(trimmed) > MAX_SNAPSHOT_BYTES) {
    trimmed.plans = halve(trimmed.plans);
  }
  while (trimmed.days.length > 0 && jsonSize(trimmed) > MAX_SNAPSHOT_BYTES) {
    trimmed.days = halve(trimmed.days);
  }

  return trimmed;
}

/**
 * Builds a compact, read-only planner context snapshot for the active
 * profile, or undefined when there's nothing useful to send (no plans and
 * no Lightning selections, or localStorage is unavailable e.g. during SSR).
 */
export function buildPlannerContextSnapshot(): PlannerContextSnapshot | undefined {
  if (typeof window === "undefined") return undefined;

  try {
    // Ensures the Default profile + active profile id are initialized and
    // legacy dwp.myPlans / dwp.lightning.v1 data is migrated into the
    // namespaced dwp:{id}:plans / dwp:{id}:lightning keys before we read
    // them below. Idempotent — safe to call on every snapshot build.
    bootstrapProfiles();

    const profile = getActiveProfile();
    const days = readDays(profile.id);
    const dayMeta = readDayMeta(profile.id);
    const dayParks = readDayParks(profile.id);

    const parsedPlans = readItemsDataset(buildNamespacedKey(profile.id, "plans"))
      .map(toPlanItem)
      .filter((x): x is PlannerContextSnapshotItem => x !== null);
    const parsedLightning = readItemsDataset(buildNamespacedKey(profile.id, "lightning"))
      .map(toLightningItem)
      .filter((x): x is PlannerContextSnapshotLightningItem => x !== null);

    const plans = parsedPlans.slice(0, MAX_ITEMS);
    const lightning = parsedLightning.slice(0, MAX_ITEMS);
    // MAX_ITEMS itself already dropped some items — flag it below even if
    // the resulting payload turns out to be within the byte budget.
    const itemCapTruncated = plans.length < parsedPlans.length || lightning.length < parsedLightning.length;

    if (plans.length === 0 && lightning.length === 0) return undefined;

    const storedResort = readPlainString(buildNamespacedKey(profile.id, "selectedResort"));
    const storedPark = readPlainString(buildNamespacedKey(profile.id, "selectedPark"));
    const inferred = inferPlansContext(
      plans.map((p) => ({ id: `${p.dayId}:${p.name}`, name: p.name, timeLabel: p.time }))
    );

    const days_: PlannerContextSnapshotDay[] = days.map((id) => ({
      id,
      label: dayMeta[id]?.label || dayLabelFromId(id),
      date: dayMeta[id]?.date,
      park: dayParks[id],
    }));

    const snapshot: PlannerContextSnapshot = {
      profile: { id: profile.id, name: profile.name },
      resort: storedResort ?? inferred.resort,
      park: storedPark ?? inferred.park,
      days: days_,
      plans,
      lightning,
      repeats: findRepeats(plans),
      conflicts: findConflicts(plans, lightning),
      ...(itemCapTruncated ? { meta: { truncated: true } } : {}),
    };

    return fitToByteBudget(snapshot);
  } catch {
    return undefined;
  }
}

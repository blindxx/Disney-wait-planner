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
 *
 * Phase 10.5 audit (Planner Insights, DWP-side only): this snapshot already
 * carries sufficient explicit data for deterministic ordering, optional
 * dates, category/park/repeat/conflict summaries, empty-day detection,
 * before/after day navigation, and first/last-activity calculations — see
 * the per-field notes on PlannerContextSnapshot/PlannerContextSnapshotDay
 * below. No new fields were needed; day display names were already covered
 * by `days[].label`. Nothing here infers dates, times, durations, transport,
 * walking, feasibility, or intent — only what the planner explicitly stores.
 */

import type { ResortId } from "@disney-wait-planner/shared";
import { bootstrapProfiles, getActiveProfile, buildNamespacedKey } from "./profileStorage";
import { normalizeKey, ALIASES_DLR, ALIASES_WDW, tokenize, containsWholeWordSequence } from "./plansMatching";
import { inferPlansContext } from "./plansContextInference";
import { detectTimeConflicts } from "./timeConflicts";
import { resolveIdentityKey, RIDE_TO_PARK_DLR, RIDE_TO_PARK_WDW, PARK_TO_RESORT, daySort, inferDayPark } from "./crossDayChecks";
import { resolveDiningKey } from "./diningSuggestions";
import { resolveEntertainmentKey } from "./entertainmentSuggestions";

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
  /**
   * Phase 10.5 — this IS the day's display name: the user's custom/renamed
   * label when set (dayMeta[id].label, same field the Plans page's
   * dayDisplayLabel reads), otherwise the "Day N" default derived from id.
   * Always populated. Tom should use this when responding about a day, while
   * still accepting numeric "Day X" references (id encodes that as day-X).
   */
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
  resort?: string;
  park?: string;
  /**
   * Phase 10.5 — always sorted ascending by day number (daySort), so the
   * array's own order gives before/after-day navigation for free; no
   * separate index/order field is needed.
   */
  days: PlannerContextSnapshotDay[];
  /**
   * Phase 10.5 — items keep their original per-day storage order (only ever
   * trimmed from the end, never reordered), which mirrors the Plans page's
   * own stable time-sort: valid times sort first, and this array order is
   * the planner-order tie-breaker beneath equal/missing times — see
   * plans/page.tsx's sortKey(). It's also the sole ordering signal when a
   * day has no valid times at all. First/last activity for a day and
   * category summaries are both derivable directly from this plus each
   * item's own `time`/`type` — no separate ordering or summary field needed.
   */
  plans: PlannerContextSnapshotItem[];
  lightning: PlannerContextSnapshotLightningItem[];
  repeats: PlannerContextSnapshotRepeat[];
  conflicts: PlannerContextSnapshotConflict[];
  /**
   * Phase 10.4.1 — DWP's own authoritative Auto-day park context for days
   * that have no explicit/manual park (see days[].park for those): item-name
   * inference (crossDayChecks.ts's inferDayPark) first, falling back to a
   * restored backup-export-time fallback for custom-only days when
   * inference finds nothing — the same two Auto-mode sources My Plans'
   * resolveDayPark itself checks, in the same order. Keyed by canonical day
   * id → canonical park id. Days with a manual park, or with neither source
   * resolving a park, are simply absent — never present in both this map
   * and days[].park for the same day.
   */
  dayAutoFallbacks: Record<string, string>;
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

/**
 * Phase 10.4.1 — DWP's own restored Auto-day fallbacks (My Plans' Phase 9.6
 * backup-gap-fix state: the effective park snapshotted at backup-export time
 * for custom-only Auto days, restored on backup import and now persisted to
 * profile-scoped localStorage so it outlives the /plans page session — see
 * dayAutoFallbacksKeyRef in plans/page.tsx). Same validation shape as
 * readDayParks: only valid park id values are accepted.
 */
function readRestoredDayAutoFallbacks(profileId: string): Record<string, string> {
  const parsed = readJson(buildNamespacedKey(profileId, "dayAutoFallbacks"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const result: Record<string, string> = {};
  for (const [dayId, park] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof park === "string" && park in PARK_TO_RESORT) result[dayId] = park;
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

// Phase 9.3.4 (mirrored) — strip trailing time-like text (e.g. "9pm", "9:00 PM")
// from a name before type/identity inference only, so old imported items like
// "Fantasmic 9pm" resolve by their activity name. Never touches display names
// or stored times. Duplicated from the same pattern in plans/page.tsx and
// crossDayChecks.ts (neither exports it) rather than importing a page module.
function stripTrailingTimeForInference(name: string): string {
  return name
    .replace(/\s*\b\d{1,2}(:\d{2})?\s*(am|pm)\b\s*$/i, "")
    .replace(/\s*\b\d{1,2}:\d{2}\s*$/, "")
    .trim();
}

/**
 * Resolves the effective item type the same way My Plans hydration does
 * (resolveHydratedPlannerItemType in plans/page.tsx): an explicit
 * dining/entertainment type is trusted as-is, but a missing or stale
 * "attraction" type (e.g. from a pre-Phase-9 backup) is re-classified using
 * the same dining/entertainment name resolvers, so legacy/restored items are
 * still reported to Tom under their real type instead of defaulting wrong.
 */
function resolveItemType(raw: unknown, name: string): SnapshotItemType {
  if (raw === "dining" || raw === "entertainment") return raw;
  const cleaned = stripTrailingTimeForInference(name);
  if (
    resolveEntertainmentKey(cleaned) !== null ||
    resolveEntertainmentKey(cleaned, "DLR") !== null ||
    resolveEntertainmentKey(cleaned, "WDW") !== null
  ) {
    return "entertainment";
  }
  if (resolveDiningKey(cleaned) !== null) return "dining";
  return "attraction";
}

/**
 * Attraction-only alias + containment resolution, mirroring crossDayChecks.ts's
 * private tryResolve(): exact alias match first (via resolveIdentityKey), then
 * whole-word token containment against the same shared attraction→park maps
 * the Plans/Lightning pages use (RIDE_TO_PARK_DLR/WDW), so e.g. "Millennium
 * Falcon" matches "Millennium Falcon: Smugglers Run" the same way the planner
 * UI's duplicate/conflict detection does. Returns null (ambiguous or no
 * match) rather than guessing when more than one attraction contains the
 * token sequence.
 */
function tryResolveAttraction(name: string, resort: ResortId): string | null {
  const aliases = resort === "DLR" ? ALIASES_DLR : ALIASES_WDW;
  const rideMap = resort === "DLR" ? RIDE_TO_PARK_DLR : RIDE_TO_PARK_WDW;
  const key = resolveIdentityKey(name, aliases);
  if (rideMap.has(key)) return key;
  const tokens = tokenize(key);
  if (tokens.length < 2) return null;
  let hit: string | null = null;
  for (const attrKey of rideMap.keys()) {
    if (containsWholeWordSequence(attrKey, tokens)) {
      if (hit !== null) return null;
      hit = attrKey;
    }
  }
  return hit;
}

/**
 * Canonical alias-resolved identity key for a planner item, mirroring the
 * identity resolution crossDayChecks.ts uses for cross-day duplicate
 * detection (tryResolveAttraction / resolveDiningKey / resolveEntertainmentKey)
 * so aliases like "ROTR" and "Rise of the Resistance" are treated as the same
 * item rather than only matching on exact normalized name, and containment
 * matches (e.g. "Millennium Falcon" inside "Millennium Falcon: Smugglers
 * Run") are recognized too. resortHint should be the specific day's resort
 * when known (see buildDayResortMap) — attraction aliases can resolve
 * differently per resort, so a day-specific hint is tried before falling
 * back to the ambiguous dual-resort check below. Falls back to a plain
 * normalized name when no alias/canonical match is found, which behaves the
 * same as a normalizeKey-only match for unrecognized/custom names.
 *
 * dayId is only used to scope the "ambiguous, no resort hint" attraction
 * case below — it never affects dining/entertainment or resort-known
 * attraction resolution.
 */
function resolveCanonicalIdentity(
  name: string,
  type: SnapshotItemType,
  resortHint: ResortId | undefined,
  dayId: string
): string {
  const cleaned = stripTrailingTimeForInference(name);

  if (type === "dining") {
    const key = resolveDiningKey(cleaned, resortHint);
    if (key) return `dining:${key}`;
  } else if (type === "entertainment") {
    const key = resolveEntertainmentKey(cleaned, resortHint);
    if (key) return `entertainment:${key}`;
  } else if (resortHint) {
    const key = tryResolveAttraction(cleaned, resortHint);
    if (key) return `attraction:${key}`;
  } else {
    const dlrKey = tryResolveAttraction(cleaned, "DLR");
    const wdwKey = tryResolveAttraction(cleaned, "WDW");
    // Mirrors crossDayChecks.ts's resolveAttractionKey: for attractions
    // specifically (unlike dining/entertainment), when BOTH resorts
    // recognize the name and there's no day/profile resort hint to
    // disambiguate, the planner UI treats it as unresolved rather than
    // merging — even when dlrKey === wdwKey, since that can still mean two
    // different rides that happen to share a name (e.g. "Space Mountain"
    // at both Disneyland and Magic Kingdom), not one shared attraction.
    // Scoped to this item's own day so it can't falsely repeat-match the
    // same ambiguous name recorded on a different, equally unresolved day.
    if (dlrKey && wdwKey) return `attraction:ambiguous:${dayId}:${normalizeKey(cleaned)}`;
    if (dlrKey) return `attraction:${dlrKey}`;
    if (wdwKey) return `attraction:${wdwKey}`;
  }
  return `${type}:${normalizeKey(cleaned)}`;
}

/**
 * Infers a resort from a set of item names alone (no day context) — mirrors
 * crossDayChecks.ts's private inferResortFromItems(): prefer inferPlansContext's
 * two-stage scoring, then fall back to counting which resort's attraction map
 * recognizes exactly one park across the names.
 */
function inferResortForNames(names: string[]): ResortId | undefined {
  if (names.length === 0) return undefined;
  const inferred = inferPlansContext(names.map((name) => ({ id: "", name, timeLabel: "" })));
  if (inferred.resort) return inferred.resort;

  const dlrParks = new Set<string>();
  const wdwParks = new Set<string>();
  for (const name of names) {
    const dlrKey = tryResolveAttraction(name, "DLR");
    if (dlrKey) {
      const p = RIDE_TO_PARK_DLR.get(dlrKey);
      if (p) dlrParks.add(p);
    }
    const wdwKey = tryResolveAttraction(name, "WDW");
    if (wdwKey) {
      const p = RIDE_TO_PARK_WDW.get(wdwKey);
      if (p) wdwParks.add(p);
    }
  }
  if (dlrParks.size === 1 && wdwParks.size !== 1) return "DLR";
  if (wdwParks.size === 1 && dlrParks.size !== 1) return "WDW";
  return undefined;
}

/**
 * Per-day resort map, mirroring crossDayChecks.ts's dayResortMap construction:
 * a manual dayParks override wins, otherwise the resort is inferred from that
 * day's own plan items, then its own Lightning items. Days with no signal at
 * all are simply absent from the map — callers fall back to the profile-wide
 * resort hint in that case.
 */
function buildDayResortMap(
  plans: PlannerContextSnapshotItem[],
  lightning: PlannerContextSnapshotLightningItem[],
  days: string[],
  dayParks: Record<string, string>
): Map<string, ResortId> {
  const map = new Map<string, ResortId>();
  for (const dayId of days) {
    const override = dayParks[dayId];
    if (override && override in PARK_TO_RESORT) {
      map.set(dayId, PARK_TO_RESORT[override] as ResortId);
      continue;
    }
    const planResort = inferResortForNames(plans.filter((p) => p.dayId === dayId).map((p) => p.name));
    if (planResort) {
      map.set(dayId, planResort);
      continue;
    }
    const llResort = inferResortForNames(lightning.filter((l) => l.dayId === dayId).map((l) => l.name));
    if (llResort) map.set(dayId, llResort);
  }
  return map;
}

/**
 * Auto-day park fallback for every day that has no explicit/manual park
 * (dayParks[dayId] absent). Mirrors My Plans' resolveDayPark priority chain
 * for its two Auto-mode steps, reusing both of its authoritative sources
 * rather than a second, weaker item-name inference:
 *   1. crossDayChecks.ts's inferDayPark over this day's plan items (mirrors
 *      resolveDayPark step 2) — takes priority when it resolves a park.
 *   2. DWP's own restored Auto fallback (mirrors resolveDayPark step 2.5):
 *      the effective park snapshotted at backup-export time for custom-only
 *      days, restored on backup import and persisted to localStorage (see
 *      readRestoredDayAutoFallbacks) — used only when step 1 finds nothing.
 * Days where neither source resolves a park are simply absent — callers
 * fall back further down their own priority chain (item-level park fields,
 * name inference, or the profile-wide resort/park fields already on the
 * snapshot). resolveDayPark's step 3 (global selectedPark) is deliberately
 * NOT reused here — that generic fallback is Tom's own responsibility
 * (consumer contract tier 5), not a DWP-specific signal.
 */
function buildDayAutoFallbacks(
  plans: PlannerContextSnapshotItem[],
  days: string[],
  dayParks: Record<string, string>,
  dayResortMap: Map<string, ResortId>,
  profileResortHint: ResortId | undefined,
  restoredAutoFallbacks: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const dayId of days) {
    if (dayParks[dayId]) continue; // manual override — never duplicated here
    const resortHint = dayResortMap.get(dayId) ?? profileResortHint;
    const dayPlanItems = plans.filter((p) => p.dayId === dayId).map((p) => ({ name: p.name }));
    const inferredPark = resortHint ? inferDayPark(dayPlanItems, resortHint) : null;
    if (inferredPark) {
      result[dayId] = inferredPark;
      continue;
    }
    const restored = restoredAutoFallbacks[dayId];
    if (restored) result[dayId] = restored;
  }
  return result;
}

function toPlanItem(raw: unknown): PlannerContextSnapshotItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim()) return null;
  return {
    dayId: typeof r.dayId === "string" && r.dayId ? r.dayId : "day-1",
    name: truncate(r.name, MAX_NAME_LEN),
    type: resolveItemType(r.type, r.name),
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

/**
 * Items whose canonical (alias-resolved) identity appears on 2+ distinct
 * days — e.g. "ROTR" on Day 1 and "Rise of the Resistance" on Day 3 count
 * as the same repeat, matching how crossDayChecks.ts identifies duplicates.
 * Each item resolves using its own day's resort hint (dayResortMap) when
 * known, falling back to the profile-wide resort hint otherwise — mirrors
 * crossDayChecks.ts's day-aware resolution so a DCA-day "Guardians" isn't
 * resolved against a WDW profile-wide hint.
 */
function findRepeats(
  plans: PlannerContextSnapshotItem[],
  dayResortMap: Map<string, ResortId>,
  profileResortHint: ResortId | undefined
): PlannerContextSnapshotRepeat[] {
  const byKey = new Map<string, { name: string; dayIds: Set<string> }>();
  for (const p of plans) {
    const resortHint = dayResortMap.get(p.dayId) ?? profileResortHint;
    const key = resolveCanonicalIdentity(p.name, p.type, resortHint, p.dayId);
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
 * Same-day / same-attraction plan + Lightning pairs whose time ranges
 * actually overlap. Same day + same identity alone is not a conflict — the
 * Plans page only surfaces a Lightning/plan conflict once detectTimeConflicts
 * (the same interval-overlap engine used by crossDayChecks.ts) confirms a
 * real overlap, so this mirrors that requirement rather than introducing a
 * separate, looser definition of "conflict". Items with no usable time on
 * either side never produce a conflict.
 *
 * Identity is alias-resolved (e.g. "ROTR" vs "Rise of the Resistance") via
 * resolveCanonicalIdentity, matching crossDayChecks.ts's identity resolution
 * for this same check. Both sides are always resolved as "attraction" —
 * Lightning Lane only ever applies to attractions, and crossDayChecks.ts's
 * own Lightning/plan conflict check resolves the plan side the same way
 * regardless of the plan item's own type.
 *
 * Every same-day/same-identity Lightning selection is checked (not just
 * one) — a day can have more than one Lightning selection for the same
 * attraction (e.g. after a return-time change), and an earlier one can
 * overlap a plan even when the latest one doesn't.
 *
 * Identity resolution uses each day's own resort hint (dayResortMap) when
 * known, falling back to the profile-wide hint — a plan and Lightning
 * selection are always compared for the same dayId, so one resort lookup
 * per day covers both sides of the pair.
 */
function findConflicts(
  plans: PlannerContextSnapshotItem[],
  lightning: PlannerContextSnapshotLightningItem[],
  dayResortMap: Map<string, ResortId>,
  profileResortHint: ResortId | undefined
): PlannerContextSnapshotConflict[] {
  const lightningByDayAndKey = new Map<string, PlannerContextSnapshotLightningItem[]>();
  for (const l of lightning) {
    const resortHint = dayResortMap.get(l.dayId) ?? profileResortHint;
    const key = `${l.dayId}::${resolveCanonicalIdentity(l.name, "attraction", resortHint, l.dayId)}`;
    const bucket = lightningByDayAndKey.get(key);
    if (bucket) bucket.push(l);
    else lightningByDayAndKey.set(key, [l]);
  }

  const conflicts: PlannerContextSnapshotConflict[] = [];
  for (const p of plans) {
    const resortHint = dayResortMap.get(p.dayId) ?? profileResortHint;
    const candidates = lightningByDayAndKey.get(
      `${p.dayId}::${resolveCanonicalIdentity(p.name, "attraction", resortHint, p.dayId)}`
    );
    if (!candidates || candidates.length === 0) continue;

    const rangeMatch = p.time.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    const planStart = rangeMatch ? rangeMatch[1] : /^\d{1,2}:\d{2}$/.test(p.time) ? p.time : undefined;
    if (!planStart) continue; // no usable plan time — never a conflict
    const planEnd = rangeMatch ? rangeMatch[2] : undefined;

    for (const candidate of candidates) {
      if (!candidate.startTime) continue;

      const { overlaps } = detectTimeConflicts([
        { id: "plan", start: planStart, end: planEnd },
        { id: "lightning", start: candidate.startTime, end: candidate.endTime || undefined },
      ]);
      if (overlaps.length === 0) continue;

      conflicts.push({
        dayId: p.dayId,
        name: p.name,
        planTime: p.time,
        lightningStart: candidate.startTime,
        lightningEnd: candidate.endTime,
      });
    }
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

/** Same as halve(), but for a day-id-keyed record instead of an array. */
function halveRecord(rec: Record<string, string>): Record<string, string> {
  const entries = Object.entries(rec);
  if (entries.length <= 1) return {};
  return Object.fromEntries(entries.slice(0, Math.ceil(entries.length / 2)));
}

/**
 * Trims a snapshot to fit within MAX_SNAPSHOT_BYTES, preferring a partial
 * snapshot over dropping planner_context entirely (the server otherwise
 * drops anything over its own cap). Cuts in order of least- to
 * most-important: conflicts, repeats, dayAutoFallbacks, Lightning items,
 * plan items, then (as a last resort) days — profile/resort/park are never
 * cut. dayAutoFallbacks is cut after conflicts/repeats (both derived,
 * secondary signals) but before the core plans/lightning/days data, so it's
 * preserved whenever the budget allows.
 */
function fitToByteBudget(snapshot: PlannerContextSnapshot): PlannerContextSnapshot {
  if (jsonSize(snapshot) <= MAX_SNAPSHOT_BYTES) return snapshot;

  const trimmed: PlannerContextSnapshot = { ...snapshot, meta: { truncated: true } };

  trimmed.conflicts = [];
  if (jsonSize(trimmed) <= MAX_SNAPSHOT_BYTES) return trimmed;

  trimmed.repeats = [];
  if (jsonSize(trimmed) <= MAX_SNAPSHOT_BYTES) return trimmed;

  while (Object.keys(trimmed.dayAutoFallbacks).length > 0 && jsonSize(trimmed) > MAX_SNAPSHOT_BYTES) {
    trimmed.dayAutoFallbacks = halveRecord(trimmed.dayAutoFallbacks);
  }
  if (jsonSize(trimmed) <= MAX_SNAPSHOT_BYTES) return trimmed;

  while (trimmed.lightning.length > 0 && jsonSize(trimmed) > MAX_SNAPSHOT_BYTES) {
    trimmed.lightning = halve(trimmed.lightning);
  }
  while (trimmed.plans.length > 0 && jsonSize(trimmed) > MAX_SNAPSHOT_BYTES) {
    trimmed.plans = halve(trimmed.plans);
  }
  while (trimmed.days.length > 0 && jsonSize(trimmed) > MAX_SNAPSHOT_BYTES) {
    trimmed.days = halve(trimmed.days);
    // Keep dayAutoFallbacks consistent with the surviving day list.
    const remaining = new Set(trimmed.days.map((d) => d.id));
    trimmed.dayAutoFallbacks = Object.fromEntries(
      Object.entries(trimmed.dayAutoFallbacks).filter(([dayId]) => remaining.has(dayId))
    );
  }

  return trimmed;
}

/**
 * Builds a compact, read-only planner context snapshot for the active
 * profile. bootstrapProfiles() guarantees a profile (Default, if nothing
 * else) always exists once this runs client-side, so a snapshot is returned
 * even for a brand-new/empty planner — days:[...], plans:[], lightning:[],
 * etc. Only returns undefined when there is no planner/profile context to
 * read at all: SSR (no window/localStorage) or a thrown error while reading
 * (Phase 10.4.2 — previously also omitted for an empty planner with zero
 * plans/Lightning; that gate is removed so Tom can still answer questions
 * like "what park is Day 1?" on an otherwise-empty planner).
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
    const restoredAutoFallbacks = readRestoredDayAutoFallbacks(profile.id);

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

    const storedResort = readPlainString(buildNamespacedKey(profile.id, "selectedResort"));
    const storedPark = readPlainString(buildNamespacedKey(profile.id, "selectedPark"));
    const inferred = inferPlansContext(
      plans.map((p) => ({ id: `${p.dayId}:${p.name}`, name: p.name, timeLabel: p.time }))
    );
    // Profile-wide resort guess, used only as a fallback for days that have
    // no day-specific resort signal of their own (see buildDayResortMap).
    const profileResortHint: ResortId | undefined =
      storedResort === "DLR" || storedResort === "WDW" ? storedResort : inferred.resort;

    // Self-heal the day list the same way My Plans does on load (Phase
    // 8.0.1): merge dayIds actually present in plans/Lightning into the
    // stored days list, so a stale/missing dwp:{profile}:days (e.g. after a
    // restore or cloud sync that didn't touch it) can't leave items whose
    // dayId has no matching `days` entry. Read-only — unlike My Plans, this
    // never writes the merged list back to storage.
    const itemDayIds = [...plans.map((p) => p.dayId), ...lightning.map((l) => l.dayId)];
    const mergedDayIds = [...new Set(["day-1", ...days, ...itemDayIds])].sort(daySort);

    // Per-day resort map (manual override, then that day's own plan/Lightning
    // items) — mirrors crossDayChecks.ts's dayResortMap so a DCA day isn't
    // resolved against a WDW profile-wide hint (or vice versa). Built from
    // the self-healed day list so fallback days get their own resort
    // inference too, not just the profile-wide hint.
    const dayResortMap = buildDayResortMap(plans, lightning, mergedDayIds, dayParks);

    const days_: PlannerContextSnapshotDay[] = mergedDayIds.map((id) => ({
      id,
      label: dayMeta[id]?.label || dayLabelFromId(id),
      date: dayMeta[id]?.date,
      park: dayParks[id],
    }));

    const snapshot: PlannerContextSnapshot = {
      resort: storedResort ?? inferred.resort,
      park: storedPark ?? inferred.park,
      days: days_,
      plans,
      lightning,
      repeats: findRepeats(plans, dayResortMap, profileResortHint),
      conflicts: findConflicts(plans, lightning, dayResortMap, profileResortHint),
      dayAutoFallbacks: buildDayAutoFallbacks(plans, mergedDayIds, dayParks, dayResortMap, profileResortHint, restoredAutoFallbacks),
      ...(itemCapTruncated ? { meta: { truncated: true } } : {}),
    };

    return fitToByteBudget(snapshot);
  } catch {
    return undefined;
  }
}

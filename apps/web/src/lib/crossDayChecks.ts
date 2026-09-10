import {
  mockAttractionWaits,
  type ParkId,
  type ResortId,
} from "@disney-wait-planner/shared";
import { formatTimeLabel } from "@/lib/timeUtils";
import { detectTimeConflicts } from "@/lib/timeConflicts";
import {
  normalizeKey,
  ALIASES_DLR,
  ALIASES_WDW,
  stripAnnotations,
  tokenize,
  containsWholeWordSequence,
} from "@/lib/plansMatching";
import { inferPlansContext } from "@/lib/plansContextInference";
import { resolveDiningKey, DINING_PLACES } from "@/lib/diningSuggestions";
import { resolveEntertainmentKey, ENTERTAINMENT_PLACES } from "@/lib/entertainmentSuggestions";

export type PlannerItemType = "attraction" | "dining" | "entertainment";

export type ParkSection = { parkLabel: string; dayIds: string[] };
export type CrossDayDuplicate = {
  identityKey: string;
  displayName: string;
  parkSections: ParkSection[];
  totalDays: number;
  hasTimeConflict: boolean;
  itemType: PlannerItemType;
};
export type LightningPlanConflict = {
  id: string;
  attractionName: string;
  planDayId: string;
  planTime: string;
  lightningTime: string;
};

export type CrossDayEntry = {
  id: string;
  name: string;
  timeLabel: string;
  dayId: string;
  type?: PlannerItemType;
};

export type LLConflictItem = { name: string; startTime: string; endTime: string };

export type CrossDayChecksResult = {
  planDuplicates: CrossDayDuplicate[];
  lightningDuplicates: CrossDayDuplicate[];
  lightningPlanConflicts: LightningPlanConflict[];
};

/**
 * Sort comparator: canonical day IDs order by numeric suffix.
 */
export function daySort(a: string, b: string): number {
  const aNum = parseDayNumLocal(a);
  const bNum = parseDayNumLocal(b);
  if (aNum === bNum) return a < b ? -1 : a > b ? 1 : 0;
  return aNum < bNum ? -1 : 1;
}

function parseDayNumLocal(dayId: string): number {
  const m = /^day-(\d+)$/.exec(dayId);
  return m ? parseInt(m[1], 10) : Infinity;
}

/**
 * SH.2 Codex P1 fix — distinguishes a pure days[] REORDER (same set of day
 * IDs, different order — e.g. Move Up/Down) from a MEMBERSHIP change (a day
 * was added and/or removed — e.g. Remove Day, Add Day, Duplicate Day).
 *
 * Used by plans/page.tsx's cross-tab days[] storage listener to decide
 * whether a genuine cross-tab days[] change also implies the shared
 * plans/items storage may have changed: Remove Day deletes that day's plan
 * items in the same handler that shrinks `days`, so a membership change
 * observed from another tab means this tab's own in-flight pull must not
 * apply a stale cloud items snapshot (which would still contain the
 * removed day's items) and persist it back over the other tab's newer
 * plans storage, resurrecting items it just deleted. A pure reorder never
 * touches items, so it must NOT trigger this coupling — doing so would
 * unnecessarily block an otherwise-valid cloud plans apply, regressing the
 * SH.2 guarantee that unrelated conflict domains stay independent.
 */
export function isDaysMembershipChange(prevDayIds: string[], nextDayIds: string[]): boolean {
  if (prevDayIds.length !== nextDayIds.length) return true;
  const nextSet = new Set(nextDayIds);
  if (prevDayIds.some((id) => !nextSet.has(id))) return true;
  const prevSet = new Set(prevDayIds);
  return nextDayIds.some((id) => !prevSet.has(id));
}

/**
 * Reference cases for isDaysMembershipChange() — Codex P1 #1 fix. Run from
 * Node (mirrors the DEV_PLAN_ALIAS_CASES convention in plansMatching.ts):
 *   import { DEV_DAYS_MEMBERSHIP_CASES, isDaysMembershipChange } from "@/lib/crossDayChecks";
 *   DEV_DAYS_MEMBERSHIP_CASES.forEach(c => {
 *     const got = isDaysMembershipChange(c.prev, c.next);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_DAYS_MEMBERSHIP_CASES: Array<{
  name: string;
  prev: string[];
  next: string[];
  expected: boolean;
}> = [
  {
    name: "identical order — no change at all",
    prev: ["day-1", "day-2"],
    next: ["day-1", "day-2"],
    expected: false,
  },
  {
    name: "pure reorder — Move Up/Down swaps two days, same set (regression case B)",
    prev: ["day-1", "day-2", "day-3"],
    next: ["day-1", "day-3", "day-2"],
    expected: false,
  },
  {
    name: "day removed — Remove Day shrinks the set (regression case A)",
    prev: ["day-1", "day-2", "day-3"],
    next: ["day-1", "day-3"],
    expected: true,
  },
  {
    name: "day added — Add Day/Duplicate Day grows the set",
    prev: ["day-1", "day-2"],
    next: ["day-1", "day-2", "day-3"],
    expected: true,
  },
  {
    name: "same length, different set — swap-in-place edge case (length check alone is insufficient)",
    prev: ["day-1", "day-2", "day-3"],
    next: ["day-1", "day-2", "day-4"],
    expected: true,
  },
];

/**
 * SH.2 Codex P1 fix — event shape fed into reduceSiblingPlansStale() below.
 * "days" is a genuine cross-tab days[] storage event this tab observed
 * (prevIds/nextIds are the known-days set immediately before/after it).
 * "plans" is a cross-tab plans storage event this tab observed.
 */
export type SiblingStaleEvent =
  | { type: "days"; prevIds: string[]; nextIds: string[] }
  | { type: "plans" };

/**
 * SH.2 Codex P1 fix — pure state transition for whether Lightning should
 * currently distrust sibling Plans-derived day IDs for additive days[]
 * reconciliation. Used by lightning/page.tsx's cross-tab storage listeners
 * (the actual, single source of truth for plansSiblingStaleForDaysRef —
 * not a reimplementation kept in sync by hand) so the exact same decision
 * logic exercised in production is what DEV_SIBLING_STALE_CASES below
 * validates.
 *
 * Root cause this closes: Remove Day writes the shared `days` key
 * synchronously but its coupled plans-item deletion is persisted slightly
 * later, via the OTHER tab's own items-persist effect. So Lightning can
 * observe the `days` MEMBERSHIP event — and even have its own pending
 * pull resolve — entirely before the coupled `plans` event arrives. In
 * that window, a fresh read of shared plans storage can still return the
 * OLD, pre-deletion items, so the removed day must not be trusted as
 * "discovered" via that stale sibling snapshot.
 *
 * Rules (a left fold over the observed event sequence, starting `false`):
 *   - "days" event that is a genuine MEMBERSHIP change (isDaysMembershipChange)
 *     → true (a pure reorder — same day-ID set — never sets this: it
 *       doesn't invalidate sibling-derived day IDs).
 *   - "plans" event → false (proof the sibling snapshot has caught up).
 *   - Anything else → state unchanged.
 * Once true, stays true until a "plans" event is observed — deliberately
 * NOT time- or pull-cycle-bounded, since "a new pull started" or "some
 * time passed" is not proof the sibling write landed (Codex: correctness
 * must not depend on storage-event vs. network timing).
 */
export function reduceSiblingPlansStale(current: boolean, event: SiblingStaleEvent): boolean {
  if (event.type === "plans") return false;
  return current || isDaysMembershipChange(event.prevIds, event.nextIds);
}

/**
 * Reference cases for reduceSiblingPlansStale() — Codex P1 (Lightning
 * event-ordering) fix. Each case is an ordered event sequence (simulating
 * the exact cross-tab storage-event arrival order Codex described) folded
 * through reduceSiblingPlansStale starting from `false`; `expected` is the
 * resulting staleness state at the point a pending pull would resolve
 * (immediately after the listed events, before any further event).
 * Run from Node:
 *   import { DEV_SIBLING_STALE_CASES, reduceSiblingPlansStale } from "@/lib/crossDayChecks";
 *   DEV_SIBLING_STALE_CASES.forEach(c => {
 *     const got = c.events.reduce(reduceSiblingPlansStale, false);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_SIBLING_STALE_CASES: Array<{
  name: string;
  events: SiblingStaleEvent[];
  expected: boolean;
}> = [
  {
    name: "regression case A — Remove Day membership event arrives, pull resolves before the coupled plans event: sibling plan data must be distrusted",
    events: [{ type: "days", prevIds: ["day-1", "day-2", "day-3"], nextIds: ["day-1", "day-3"] }],
    expected: true,
  },
  {
    name: "regression case B — the coupled plans event later arrives: sibling plan data is trusted again",
    events: [
      { type: "days", prevIds: ["day-1", "day-2", "day-3"], nextIds: ["day-1", "day-3"] },
      { type: "plans" },
    ],
    expected: false,
  },
  {
    name: "pure reorder — same day-ID set, only order differs: never distrusted, unrelated hydration must not be blocked",
    events: [{ type: "days", prevIds: ["day-1", "day-2", "day-3"], nextIds: ["day-1", "day-3", "day-2"] }],
    expected: false,
  },
  {
    name: "Duplicate Day — membership grows (new day), same distrust-until-confirmed rule applies",
    events: [{ type: "days", prevIds: ["day-1", "day-2"], nextIds: ["day-1", "day-2", "day-3"] }],
    expected: true,
  },
  {
    name: "Add Day (no items) — membership event alone still marks distrust even though nothing was actually resurrectable",
    events: [{ type: "days", prevIds: ["day-1"], nextIds: ["day-1", "day-2"] }],
    expected: true,
  },
  {
    name: "no events at all — default trusted state",
    events: [],
    expected: false,
  },
  {
    name: "plans event with no preceding days event — already trusted, stays trusted (idempotent)",
    events: [{ type: "plans" }],
    expected: false,
  },
  {
    name: "two membership changes before the coupled plans event finally arrives — still distrusted until plans confirms",
    events: [
      { type: "days", prevIds: ["day-1", "day-2"], nextIds: ["day-1"] },
      { type: "days", prevIds: ["day-1"], nextIds: ["day-1", "day-4"] },
    ],
    expected: true,
  },
  {
    name: "membership change, then plans confirms, then a later pure reorder — reorder must not re-trigger distrust",
    events: [
      { type: "days", prevIds: ["day-1", "day-2"], nextIds: ["day-1"] },
      { type: "plans" },
      { type: "days", prevIds: ["day-1"], nextIds: ["day-1"] },
    ],
    expected: false,
  },
];

export function resolveIdentityKey(name: string, aliases: Record<string, string>): string {
  const key = normalizeKey(stripAnnotations(name));
  const aliasTarget =
    aliases[key] ??
    (key.startsWith("the ") ? aliases[key.slice(4)] : undefined);
  return aliasTarget ?? key;
}

function stripTrailingTimeForInference(name: string): string {
  return name
    .replace(/\s*\b\d{1,2}(:\d{2})?\s*(am|pm)\b\s*$/i, "")
    .replace(/\s*\b\d{1,2}:\d{2}\s*$/, "")
    .trim();
}

const PARK_LABELS: Record<ParkId, string> = {
  disneyland: "Disneyland",
  dca: "Disney California Adventure",
  mk: "Magic Kingdom",
  epcot: "EPCOT",
  hs: "Hollywood Studios",
  ak: "Animal Kingdom",
};

export const PARK_TO_RESORT: Partial<Record<string, ResortId>> = {
  disneyland: "DLR",
  dca: "DLR",
  mk: "WDW",
  epcot: "WDW",
  hs: "WDW",
  ak: "WDW",
};

export const RIDE_TO_PARK_DLR = new Map<string, string>();
export const RIDE_TO_PARK_WDW = new Map<string, string>();
for (const _inf of mockAttractionWaits) {
  if (_inf.resortId === "DLR") RIDE_TO_PARK_DLR.set(normalizeKey(_inf.name), _inf.parkId);
  else if (_inf.resortId === "WDW") RIDE_TO_PARK_WDW.set(normalizeKey(_inf.name), _inf.parkId);
}

const DINING_PARK_DLR = new Map<string, string>();
const DINING_PARK_WDW = new Map<string, string>();
for (const _d of DINING_PLACES) {
  if (!_d.parkId) continue;
  if (_d.resort === "DLR") DINING_PARK_DLR.set(normalizeKey(_d.name), _d.parkId);
  else if (_d.resort === "WDW") DINING_PARK_WDW.set(normalizeKey(_d.name), _d.parkId);
}

const ENTERTAINMENT_PARK_DLR = new Map<string, string>();
const ENTERTAINMENT_PARK_WDW = new Map<string, string>();
for (const _e of ENTERTAINMENT_PLACES) {
  if (!_e.parkId) continue;
  if (_e.resort === "DLR") ENTERTAINMENT_PARK_DLR.set(normalizeKey(_e.name), _e.parkId);
  else if (_e.resort === "WDW") ENTERTAINMENT_PARK_WDW.set(normalizeKey(_e.name), _e.parkId);
}

/**
 * Infer the most-frequented park for a set of plan items within a resort.
 * Extracted from the My Plans page (Phase 10.4.1) so other consumers (e.g.
 * Tom's planner_context builder) can reuse the exact same Auto-day park
 * inference used by My Plans' resolveDayPark, instead of a second, weaker
 * one.
 *
 * Algorithm:
 *   1. Normalize each item name via stripAnnotations + normalizeKey.
 *   2. Exact match against RIDE_TO_PARK_{resort} map.
 *   3. Alias lookup (Stage 3 of the plansMatching pipeline).
 *   4. Fall back to dining/entertainment name resolution + their own park maps.
 *   5. Count park hits, return the park with the highest count.
 *   6. Tie → null (caller falls back to selectedPark).
 *   7. No matches → null.
 *
 * Pure and deterministic: no randomness, no side effects.
 */
export function inferDayPark(dayItems: { name: string }[], resort: ResortId): ParkId | null {
  if (dayItems.length === 0) return null;
  const map = resort === "DLR" ? RIDE_TO_PARK_DLR : RIDE_TO_PARK_WDW;
  const diningMap = resort === "DLR" ? DINING_PARK_DLR : DINING_PARK_WDW;
  const entertainmentMap = resort === "DLR" ? ENTERTAINMENT_PARK_DLR : ENTERTAINMENT_PARK_WDW;
  const aliases = resort === "DLR" ? ALIASES_DLR : ALIASES_WDW;
  const parkCount = new Map<string, number>();
  for (const item of dayItems) {
    const key = normalizeKey(stripAnnotations(item.name));
    let parkId = map.get(key) ?? null;
    if (!parkId) {
      const aliasTarget = aliases[key] ?? (key.startsWith("the ") ? aliases[key.slice(4)] : undefined);
      if (aliasTarget) parkId = map.get(aliasTarget) ?? null;
    }
    if (!parkId) {
      // Dining lookup uses its own isolated map — never RIDE_TO_PARK_*,
      // which feeds attraction duplicate/identity matching elsewhere.
      const diningKey = resolveDiningKey(item.name, resort);
      if (diningKey) parkId = diningMap.get(diningKey) ?? null;
    }
    if (!parkId) {
      // Entertainment lookup uses its own isolated map, mirroring dining.
      const entertainmentKey = resolveEntertainmentKey(item.name, resort);
      if (entertainmentKey) parkId = entertainmentMap.get(entertainmentKey) ?? null;
    }
    if (parkId) parkCount.set(parkId, (parkCount.get(parkId) ?? 0) + 1);
  }
  if (parkCount.size === 0) return null;
  let maxCount = 0;
  let winner: string | null = null;
  let tied = false;
  for (const [p, c] of parkCount.entries()) {
    if (c > maxCount) { maxCount = c; winner = p; tied = false; }
    else if (c === maxCount) { tied = true; }
  }
  return (!tied && winner) ? (winner as ParkId) : null;
}

/**
 * Shared cross-day duplicate / Lightning-vs-Plan conflict detection engine.
 * Extracted verbatim (no behavior change) from the My Plans page so both
 * My Plans and the Lightning page reuse identical semantics.
 */
export function computeCrossDayChecks(
  items: CrossDayEntry[],
  llItemsByDay: Map<string, LLConflictItem[]>,
  days: string[],
  dayParks: Record<string, string>
): CrossDayChecksResult {
  const runDuplicates = days.length >= 2;

  // Phase 11.2 — cross-day presentation follows planner order, not numeric
  // dayId order: sort by each id's position in the caller-supplied `days`
  // list (the persisted, possibly-reordered planner order). An id that
  // somehow isn't in `days` sorts after everything that is, via daySort as
  // a last-resort tiebreak, so it's never silently dropped from output.
  function dayPositionSort(a: string, b: string): number {
    const aIdx = days.indexOf(a);
    const bIdx = days.indexOf(b);
    if (aIdx === -1 && bIdx === -1) return daySort(a, b);
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  }

  function tryResolve(name: string, resort: ResortId): string | null {
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

  function tryResolveByType(name: string, resort: ResortId, type: PlannerItemType): string | null {
    if (type === "dining") return resolveDiningKey(name, resort);
    if (type === "entertainment") return resolveEntertainmentKey(name, resort);
    return tryResolve(name, resort);
  }

  function inferResortFromItems(namedItems: { name: string }[]): ResortId | undefined {
    if (namedItems.length === 0) return undefined;
    const inf = inferPlansContext(
      namedItems.map((it) => ({ id: "", name: it.name, timeLabel: "" }))
    );
    if (inf.resort) return inf.resort;
    const dlrP = new Set<string>();
    const wdwP = new Set<string>();
    for (const it of namedItems) {
      const dk = tryResolve(it.name, "DLR");
      if (dk) { const p = RIDE_TO_PARK_DLR.get(dk); if (p) dlrP.add(p); }
      const wk = tryResolve(it.name, "WDW");
      if (wk) { const p = RIDE_TO_PARK_WDW.get(wk); if (p) wdwP.add(p); }
    }
    if (dlrP.size === 1 && wdwP.size !== 1) return "DLR";
    if (wdwP.size === 1 && dlrP.size !== 1) return "WDW";
    return undefined;
  }

  const dayResortMap = new Map<string, ResortId>();
  for (const dayId of days) {
    const override = dayParks[dayId];
    if (override && override in PARK_TO_RESORT) {
      dayResortMap.set(dayId, PARK_TO_RESORT[override] as ResortId);
      continue;
    }
    const planResort = inferResortFromItems(items.filter((it) => it.dayId === dayId));
    if (planResort) { dayResortMap.set(dayId, planResort); continue; }
    const llResort = inferResortFromItems(llItemsByDay.get(dayId) ?? []);
    if (llResort) { dayResortMap.set(dayId, llResort); continue; }
  }

  function resolveAttractionKey(
    name: string,
    dayId: string,
    type: PlannerItemType = "attraction"
  ): { compositeKey: string } | null {
    const lookupName = stripTrailingTimeForInference(name);
    const knownResort = dayResortMap.get(dayId);
    if (knownResort !== undefined) {
      const k = tryResolveByType(lookupName, knownResort, type);
      return k ? { compositeKey: `${type}:${knownResort}:${k}` } : null;
    }
    const dlrKey = tryResolveByType(lookupName, "DLR", type);
    const wdwKey = tryResolveByType(lookupName, "WDW", type);
    if (type !== "attraction" && dlrKey && wdwKey && dlrKey === wdwKey) {
      return { compositeKey: `${type}:ANY:${dlrKey}` };
    }
    if (dlrKey && !wdwKey) return { compositeKey: `${type}:DLR:${dlrKey}` };
    if (wdwKey && !dlrKey) return { compositeKey: `${type}:WDW:${wdwKey}` };
    return null;
  }

  function splitCompositeKey(compositeKey: string): { type: PlannerItemType; resort: ResortId | "ANY"; canonicalKey: string } | null {
    const firstColon = compositeKey.indexOf(":");
    const secondColon = compositeKey.indexOf(":", firstColon + 1);
    if (firstColon === -1 || secondColon === -1) return null;
    return {
      type: compositeKey.slice(0, firstColon) as PlannerItemType,
      resort: compositeKey.slice(firstColon + 1, secondColon) as ResortId | "ANY",
      canonicalKey: compositeKey.slice(secondColon + 1),
    };
  }

  function parkLabelFromCompositeKey(compositeKey: string): string {
    const parts = splitCompositeKey(compositeKey);
    if (!parts) return compositeKey;
    const { type, resort, canonicalKey } = parts;
    const dlrMap = type === "dining" ? DINING_PARK_DLR : type === "entertainment" ? ENTERTAINMENT_PARK_DLR : RIDE_TO_PARK_DLR;
    const wdwMap = type === "dining" ? DINING_PARK_WDW : type === "entertainment" ? ENTERTAINMENT_PARK_WDW : RIDE_TO_PARK_WDW;
    if (resort === "ANY") {
      const dlrParkId = dlrMap.get(canonicalKey) as ParkId | undefined;
      const wdwParkId = wdwMap.get(canonicalKey) as ParkId | undefined;
      if (dlrParkId && wdwParkId) {
        const dlrLabel = PARK_LABELS[dlrParkId] ?? dlrParkId;
        const wdwLabel = PARK_LABELS[wdwParkId] ?? wdwParkId;
        return dlrLabel === wdwLabel ? dlrLabel : `${dlrLabel} / ${wdwLabel}`;
      }
      const parkId = dlrParkId ?? wdwParkId;
      return parkId ? (PARK_LABELS[parkId] ?? canonicalKey) : canonicalKey;
    }
    const map = resort === "DLR" ? dlrMap : wdwMap;
    const parkId = map.get(canonicalKey) as ParkId | undefined;
    return parkId ? (PARK_LABELS[parkId] ?? resort) : resort;
  }

  function identityKeyFrom(compositeKey: string): string {
    const firstColon = compositeKey.indexOf(":");
    const secondColon = compositeKey.indexOf(":", firstColon + 1);
    if (firstColon === -1) return compositeKey;
    if (secondColon === -1) return compositeKey.slice(firstColon + 1);
    return `${compositeKey.slice(0, firstColon)}:${compositeKey.slice(secondColon + 1)}`;
  }

  function buildDuplicates(
    entries: Array<{ name: string; dayId: string; timeLabel?: string; type?: PlannerItemType }>
  ): CrossDayDuplicate[] {
    type CompositeEntry = { name: string; dayIds: Set<string>; timesByDay: Map<string, Set<string>> };
    const byComposite = new Map<string, CompositeEntry>();

    for (const entry of entries) {
      const resolved = resolveAttractionKey(entry.name, entry.dayId, entry.type ?? "attraction");
      if (!resolved) continue;
      if (!byComposite.has(resolved.compositeKey)) {
        byComposite.set(resolved.compositeKey, { name: entry.name, dayIds: new Set(), timesByDay: new Map() });
      }
      const ce = byComposite.get(resolved.compositeKey)!;
      ce.dayIds.add(entry.dayId);
      if (entry.timeLabel) {
        const rm = entry.timeLabel.match(/^(\d{1,2}:\d{2})/);
        if (rm) {
          if (!ce.timesByDay.has(entry.dayId)) ce.timesByDay.set(entry.dayId, new Set());
          ce.timesByDay.get(entry.dayId)!.add(rm[1]);
        }
      }
    }

    type IdentityEntry = { displayName: string; sections: Map<string, CompositeEntry> };
    const byIdentity = new Map<string, IdentityEntry>();
    for (const [compositeKey, ce] of byComposite) {
      const iKey = identityKeyFrom(compositeKey);
      if (!byIdentity.has(iKey)) {
        byIdentity.set(iKey, { displayName: ce.name, sections: new Map() });
      }
      byIdentity.get(iKey)!.sections.set(compositeKey, ce);
    }

    const result: CrossDayDuplicate[] = [];
    for (const [identityKey, { displayName, sections }] of byIdentity) {
      const allDays = new Set<string>();
      const parkSections: ParkSection[] = [];
      const allTimes: string[] = [];

      for (const [compositeKey, ce] of sections) {
        for (const d of ce.dayIds) allDays.add(d);
        for (const [dayId, times] of ce.timesByDay) {
          for (const t of times) allTimes.push(`${dayId}:${t}`);
        }
        parkSections.push({
          parkLabel: parkLabelFromCompositeKey(compositeKey),
          dayIds: [...ce.dayIds].sort(dayPositionSort),
        });
      }

      if (allDays.size > 1) {
        const timeTodays = new Map<string, Set<string>>();
        for (const token of allTimes) {
          const firstColon = token.indexOf(":");
          const dayPart = token.slice(0, firstColon);
          const timePart = token.slice(firstColon + 1);
          if (!timeTodays.has(timePart)) timeTodays.set(timePart, new Set());
          timeTodays.get(timePart)!.add(dayPart);
        }
        const hasTimeConflict = [...timeTodays.values()].some((days) => days.size >= 2);
        const typeColon = identityKey.indexOf(":");
        const itemType = (typeColon === -1 ? "attraction" : identityKey.slice(0, typeColon)) as PlannerItemType;
        result.push({
          identityKey,
          displayName,
          parkSections: parkSections
            .filter((s) => s.dayIds.length > 0)
            .sort((a, b) => a.parkLabel.localeCompare(b.parkLabel)),
          totalDays: allDays.size,
          hasTimeConflict,
          itemType,
        });
      }
    }
    return result;
  }

  const planDuplicates = runDuplicates
    ? buildDuplicates(items.map((it) => ({ name: it.name, dayId: it.dayId, timeLabel: it.timeLabel, type: it.type })))
    : [];

  const llFlatEntries: Array<{ name: string; dayId: string; timeLabel?: string }> = [];
  for (const [llDayId, llDayItems] of llItemsByDay) {
    for (const it of llDayItems) {
      llFlatEntries.push({
        name: it.name,
        dayId: llDayId,
        timeLabel: it.startTime ? (it.endTime ? `${it.startTime}-${it.endTime}` : it.startTime) : undefined,
      });
    }
  }
  const lightningDuplicates = runDuplicates ? buildDuplicates(llFlatEntries) : [];

  function fallbackIdentityKey(name: string): string | null {
    const dlrKey = resolveIdentityKey(name, ALIASES_DLR);
    const wdwKey = resolveIdentityKey(name, ALIASES_WDW);
    return dlrKey === wdwKey ? `attraction:${dlrKey}` : null;
  }

  const lightningPlanConflicts: LightningPlanConflict[] = [];
  const seenConflicts = new Set<string>();

  for (const item of items) {
    if (!item.timeLabel) continue;
    let planStart: string | undefined;
    let planEnd: string | undefined;
    const rangeM = item.timeLabel.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (rangeM) {
      planStart = rangeM[1];
      planEnd = rangeM[2];
    } else if (/^\d{1,2}:\d{2}$/.test(item.timeLabel)) {
      planStart = item.timeLabel;
    }
    if (!planStart) continue;

    const planResolved = resolveAttractionKey(item.name, item.dayId);
    const planIdentity = planResolved
      ? identityKeyFrom(planResolved.compositeKey)
      : fallbackIdentityKey(item.name);
    if (!planIdentity) continue;

    for (const llIt of llItemsByDay.get(item.dayId) ?? []) {
      if (!llIt.startTime) continue;
      const llResolved = resolveAttractionKey(llIt.name, item.dayId);
      const llIdentity = llResolved
        ? identityKeyFrom(llResolved.compositeKey)
        : fallbackIdentityKey(llIt.name);
      if (!llIdentity || llIdentity !== planIdentity) continue;

      const { overlaps } = detectTimeConflicts([
        { id: "plan", start: planStart, end: planEnd },
        { id: "ll", start: llIt.startTime, end: llIt.endTime || undefined },
      ]);
      if (overlaps.length === 0) continue;

      const conflictKey = `${item.id}:${llIt.name}:${item.dayId}`;
      if (seenConflicts.has(conflictKey)) continue;
      seenConflicts.add(conflictKey);

      const llTimeLabel = llIt.endTime
        ? `${formatTimeLabel(llIt.startTime)}–${formatTimeLabel(llIt.endTime)}`
        : formatTimeLabel(llIt.startTime);
      lightningPlanConflicts.push({
        id: conflictKey,
        attractionName: item.name,
        planDayId: item.dayId,
        planTime: item.timeLabel,
        lightningTime: llTimeLabel,
      });
    }
  }

  return { planDuplicates, lightningDuplicates, lightningPlanConflicts };
}

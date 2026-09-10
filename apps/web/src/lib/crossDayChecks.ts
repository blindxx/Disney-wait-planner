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
 * SH.2 Codex P1 fix (Add Day false-positive) — returns the day IDs present
 * in `prevDayIds` but absent from `nextDayIds`: the days a genuine
 * cross-tab days[] change actually REMOVED. Empty for a pure REORDER
 * (same set, different order — e.g. Move Up/Down) and empty for a PURE
 * ADDITION (Add Day, or Duplicate Day's new day-ID — day IDs are never
 * reused, see handleAddDay/handleDuplicateDay's "max suffix + 1" rule, so
 * a brand-new ID can never itself be "removed").
 *
 * Both plans/page.tsx and lightning/page.tsx use this — not the broader
 * "did the day-ID SET change at all" check a previous SH.2 fix used — to
 * decide what needs protecting from a cross-tab days[] event. Only a
 * REMOVAL is unambiguous evidence that a coupled plans-item deletion may
 * be in flight (Remove Day deletes that day's items in the same handler
 * that shrinks `days`): a day ID, once removed, can never legitimately
 * reappear, so removed IDs can be filtered out of any item/day-ID set
 * permanently and safely, with no "wait for confirmation" needed. A pure
 * ADDITION (Add Day: no items ever coming; Duplicate Day: items ARE
 * coming, but indistinguishable from Add Day by this diff alone) is
 * NOT treated as evidence of a plans change here — using set-membership
 * change as that evidence (the previous approach) let Add Day incorrectly
 * mark the plans domain dirty forever (for this pull cycle), since no
 * plans event ever follows it to clear that mark.
 */
export function removedDayIds(prevDayIds: string[], nextDayIds: string[]): string[] {
  const nextSet = new Set(nextDayIds);
  return prevDayIds.filter((id) => !nextSet.has(id));
}

/**
 * SH.2 Codex P1 fix — given a set of day IDs already known-removed (but
 * whose coupled plans-item deletion hasn't yet been independently
 * confirmed) and a FRESH read of the day IDs actually referenced by the
 * current persisted plans/Lightning-sibling snapshot, returns the subset
 * that remains unconfirmed: a removed day ID is confirmed (dropped from
 * the result) only when the fresh snapshot no longer references it at
 * all. An unrelated snapshot that still contains it — e.g., a third tab's
 * own stale write, landing after the removal but before the removing
 * tab's own coupled plans write — leaves it pending rather than falsely
 * clearing it. This is content evidence, not event identity: "a plans
 * storage event happened" is not proof of anything by itself; "the
 * current persisted plans content is actually compatible with the newer
 * days membership" is.
 */
export function confirmRemovedDayIds(pending: string[], freshReferencedDayIds: string[]): string[] {
  const freshSet = new Set(freshReferencedDayIds);
  return pending.filter((id) => freshSet.has(id));
}

/**
 * Reference cases for removedDayIds() + confirmRemovedDayIds() — Codex P1
 * (Add Day false-positive) and Codex P2 (sibling staleness must clear on
 * content, not event identity) fixes. Run from Node:
 *   import { DEV_REMOVED_DAY_IDS_CASES, removedDayIds, confirmRemovedDayIds } from "@/lib/crossDayChecks";
 *   DEV_REMOVED_DAY_IDS_CASES.forEach(c => {
 *     const got = removedDayIds(c.prev, c.next);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expectedRemoved) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_REMOVED_DAY_IDS_CASES: Array<{
  name: string;
  prev: string[];
  next: string[];
  expectedRemoved: string[];
}> = [
  {
    name: "identical order — no change at all",
    prev: ["day-1", "day-2"],
    next: ["day-1", "day-2"],
    expectedRemoved: [],
  },
  {
    name: "pure reorder — Move Up/Down swaps two days, same set",
    prev: ["day-1", "day-2", "day-3"],
    next: ["day-1", "day-3", "day-2"],
    expectedRemoved: [],
  },
  {
    name: "Add Day — pure addition, no removed days (regression case 1: must not block plans hydration)",
    prev: ["day-1"],
    next: ["day-1", "day-2"],
    expectedRemoved: [],
  },
  {
    name: "Duplicate Day — pure addition (from the days[] diff's perspective), no removed days",
    prev: ["day-1", "day-2"],
    next: ["day-1", "day-2", "day-3"],
    expectedRemoved: [],
  },
  {
    name: "Remove Day (populated) — day-2 removed (regression case 3: stays distrusted until confirmed)",
    prev: ["day-1", "day-2", "day-3"],
    next: ["day-1", "day-3"],
    expectedRemoved: ["day-2"],
  },
  {
    name: "Remove Day (empty day) — same removedDayIds result regardless of whether the day had items (regression case 7)",
    prev: ["day-1", "day-2", "day-3"],
    next: ["day-1", "day-3"],
    expectedRemoved: ["day-2"],
  },
  {
    name: "multiple removals in one event",
    prev: ["day-1", "day-2", "day-3", "day-4"],
    next: ["day-1", "day-4"],
    expectedRemoved: ["day-2", "day-3"],
  },
];

/**
 * Reference cases for confirmRemovedDayIds() — Codex P2 fix. Run from Node:
 *   import { DEV_CONFIRM_REMOVED_CASES, confirmRemovedDayIds } from "@/lib/crossDayChecks";
 *   DEV_CONFIRM_REMOVED_CASES.forEach(c => {
 *     const got = confirmRemovedDayIds(c.pending, c.freshReferencedDayIds);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_CONFIRM_REMOVED_CASES: Array<{
  name: string;
  pending: string[];
  freshReferencedDayIds: string[];
  expected: string[];
}> = [
  {
    name: "regression case 4 — the actual post-removal plans dataset arrives (day-2 genuinely absent): confirmed, cleared",
    pending: ["day-2"],
    freshReferencedDayIds: ["day-1", "day-3"],
    expected: [],
  },
  {
    name: "regression case 5 — three-tab case: an unrelated plans write that still contains the removed day's items must NOT clear it",
    pending: ["day-2"],
    freshReferencedDayIds: ["day-1", "day-2", "day-3"],
    expected: ["day-2"],
  },
  {
    name: "regression case 6 — after the unrelated write, the correct plans event finally arrives without day-2: now clears",
    pending: ["day-2"],
    freshReferencedDayIds: ["day-1", "day-3"],
    expected: [],
  },
  {
    name: "multiple pending, only one confirmed by this particular fresh snapshot",
    pending: ["day-2", "day-5"],
    freshReferencedDayIds: ["day-1", "day-5"],
    expected: ["day-5"],
  },
  {
    name: "empty pending set — no-op",
    pending: [],
    freshReferencedDayIds: ["day-1", "day-2"],
    expected: [],
  },
  {
    name: "empty fresh snapshot (e.g. all plans cleared) — confirms everything pending",
    pending: ["day-2", "day-3"],
    freshReferencedDayIds: [],
    expected: [],
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

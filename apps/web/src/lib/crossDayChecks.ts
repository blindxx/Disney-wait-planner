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
 * SH.2 — returns the day IDs present in `prevDayIds` but absent from
 * `nextDayIds`: the days a comparison between two days[] snapshots says
 * were REMOVED. Empty for a pure REORDER (same set, different order) and
 * empty for a pure ADDITION (a day present in `nextDayIds` but not
 * `prevDayIds` is never "removed").
 *
 * IMPORTANT: day IDs CAN be reused. handleAddDay/handleDuplicateDay derive
 * a new ID from `max(existing numeric suffixes) + 1` — if the
 * HIGHEST-numbered day is the one removed, the very next Add/Duplicate Day
 * generates that exact same ID again (e.g. days [day-1,day-2,day-3] →
 * remove day-3 → days [day-1,day-2] → Add Day → day-3 again). An earlier
 * SH.2 fix treated a removed ID as a permanent, session-lifetime tombstone
 * on this false assumption, which could blacklist a legitimately reused
 * ID forever (Codex finding). This function itself makes no such
 * assumption — it is a pure, stateless snapshot comparison, always
 * recomputed fresh against the CURRENT baseline/winning days[] for a
 * single pull (see reconcileItemsWithDays below), never accumulated into
 * a persistent set. If day-3 is removed then re-added before the next
 * comparison, `nextDayIds` simply contains day-3 again and it is not
 * reported as removed relative to that comparison.
 */
export function removedDayIds(prevDayIds: string[], nextDayIds: string[]): string[] {
  const nextSet = new Set(nextDayIds);
  return prevDayIds.filter((id) => !nextSet.has(id));
}

/**
 * SH.2 architecture (Codex P1, 2nd round) — extract the distinct dayId
 * values referenced by a raw, untyped item array (e.g. a cloud payload's
 * `plans.items`/`lightning.items`, before either page's own normalization
 * runs). Shared by plans/page.tsx and lightning/page.tsx so each page can
 * discover which days the SIBLING dataset's surviving content needs,
 * without either page needing the other's item typing — an entry missing
 * a string `dayId` is simply skipped, never defaulted, since this is only
 * ever used to find EXTRA days to protect, not to reconstruct items.
 */
export function extractDayIdsFromRawItems(items: unknown[]): string[] {
  const ids = new Set<string>();
  for (const it of items) {
    if (it && typeof it === "object" && typeof (it as Record<string, unknown>).dayId === "string") {
      ids.add((it as Record<string, unknown>).dayId as string);
    }
  }
  return [...ids];
}

/**
 * Reference cases for extractDayIdsFromRawItems(). Run from Node:
 *   import { DEV_EXTRACT_DAY_IDS_CASES, extractDayIdsFromRawItems } from "@/lib/crossDayChecks";
 *   DEV_EXTRACT_DAY_IDS_CASES.forEach(c => {
 *     const got = extractDayIdsFromRawItems(c.items);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_EXTRACT_DAY_IDS_CASES: Array<{
  name: string;
  items: unknown[];
  expected: string[];
}> = [
  { name: "empty array — no ids", items: [], expected: [] },
  {
    name: "duplicate dayIds collapse to distinct set, first-seen order",
    items: [{ dayId: "day-2" }, { dayId: "day-1" }, { dayId: "day-2" }],
    expected: ["day-2", "day-1"],
  },
  {
    name: "malformed entries (missing/non-string dayId, non-object) are skipped, not defaulted",
    items: [{ dayId: "day-1" }, { dayId: 5 }, "not-an-object", null, {}, { dayId: "day-3" }],
    expected: ["day-1", "day-3"],
  },
];

/** Order-and-content-sensitive equality for two days[] snapshots. */
function daysArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * SH.2 architecture — determines the winning days[] for one pull.
 *
 * `baseline` is this page's own local days[] as last confirmed synced
 * (captured once at mount, or updated after this page's own successful
 * push/cloud-apply — never reset merely because a pull effect re-ran).
 * `current` is a FRESH read of local days[] storage taken at pull
 * resolution time — not a cached ref, not gated by whether any 'storage'
 * event fired. localStorage is the device-local authority; a 'storage'
 * event is only ever a notification that MAY prompt a fresh read, never
 * proof of what that read will contain or when.
 *
 * Local wins outright whenever `current` differs from `baseline` in ANY
 * way (reorder or membership) — that direct comparison, not an inferred
 * "was this a membership change", is what protects a local change (made
 * before OR during this pull, in this tab or another) from a stale cloud
 * apply. When local hasn't changed, cloud's order applies if the pull
 * returned one; otherwise (no cloud days at all, or a legacy payload that
 * omits the field) current local order is kept as-is.
 */
export function pickWinningDays(
  baseline: string[],
  current: string[],
  cloudDays: string[] | undefined
): { days: string[]; changedLocally: boolean } {
  const changedLocally = !daysArraysEqual(baseline, current);
  if (changedLocally) return { days: current, changedLocally };
  if (cloudDays && cloudDays.length > 0) return { days: cloudDays, changedLocally: false };
  return { days: current, changedLocally: false };
}

/**
 * SH.2 architecture — determines the winning item array (PlanItem[] or
 * LightningItem[]) for one pull. Same "local wins whenever a fresh read
 * differs from the stable baseline" rule as pickWinningDays, applied to
 * this page's own item domain — see its doc for the full rationale.
 */
export function pickWinningItems<T>(
  baseline: T[],
  current: T[],
  cloudItems: T[] | null
): { items: T[]; changedLocally: boolean } {
  const changedLocally = JSON.stringify(baseline) !== JSON.stringify(current);
  if (changedLocally) return { items: current, changedLocally };
  if (cloudItems) return { items: cloudItems, changedLocally: false };
  return { items: current, changedLocally: false };
}

/**
 * Reference cases for pickWinningItems() — generic over both PlanItem[]
 * and LightningItem[], so these use a minimal shared shape. Run from Node:
 *   import { DEV_PICK_WINNING_ITEMS_CASES, pickWinningItems } from "@/lib/crossDayChecks";
 *   DEV_PICK_WINNING_ITEMS_CASES.forEach(c => {
 *     const got = pickWinningItems(c.baseline, c.current, c.cloudItems);
 *     ...
 *   });
 */
export const DEV_PICK_WINNING_ITEMS_CASES: Array<{
  name: string;
  baseline: Array<{ dayId: string; id: string }>;
  current: Array<{ dayId: string; id: string }>;
  cloudItems: Array<{ dayId: string; id: string }> | null;
  expectedWinner: "current" | "cloud";
  expectedChangedLocally: boolean;
}> = [
  {
    name: "no local change, no cloud payload — current kept (e.g. unauthenticated)",
    baseline: [{ id: "1", dayId: "day-1" }],
    current: [{ id: "1", dayId: "day-1" }],
    cloudItems: null,
    expectedWinner: "current",
    expectedChangedLocally: false,
  },
  {
    name: "no local change, cloud items present — cloud wins",
    baseline: [{ id: "1", dayId: "day-1" }],
    current: [{ id: "1", dayId: "day-1" }],
    cloudItems: [{ id: "1", dayId: "day-1" }, { id: "2", dayId: "day-2" }],
    expectedWinner: "cloud",
    expectedChangedLocally: false,
  },
  {
    name: "edit made before this pull started (baseline predates it) — local wins even though the pull hasn't touched anything yet",
    baseline: [{ id: "1", dayId: "day-1" }],
    current: [{ id: "1", dayId: "day-1" }, { id: "2", dayId: "day-1" }],
    cloudItems: [{ id: "1", dayId: "day-1" }],
    expectedWinner: "current",
    expectedChangedLocally: true,
  },
  {
    name: "cross-tab edit landed in storage during the pull — fresh read (current) differs from baseline, local wins",
    baseline: [{ id: "1", dayId: "day-1" }],
    current: [{ id: "1", dayId: "day-1" }, { id: "2", dayId: "day-2" }],
    cloudItems: [{ id: "1", dayId: "day-1" }],
    expectedWinner: "current",
    expectedChangedLocally: true,
  },
];

/**
 * SH.2 architecture — structural reconciliation. Given the winning items
 * for one pull (already chosen by pickWinningItems, which also reports
 * whether they won because LOCAL storage differed from the pull-start
 * baseline), the winning days[] (already chosen by pickWinningDays), and
 * the days[] baseline those days[] were compared against, returns items
 * sanitized to only reference days present in the (possibly extended)
 * returned days[].
 *
 * Codex P1 fix — `itemsChangedLocally` (pickWinningItems' own verdict for
 * `items`) is what lets this function tell apart the two cases that used
 * to be conflated under one blanket "day missing from winningDays means
 * removed" rule:
 *
 *   - itemsChangedLocally === true: `items` is this pull's LOCALLY
 *     winning set — a real, possibly still-unpushed local edit. It must
 *     NEVER be discarded merely because the INDEPENDENTLY-decided days
 *     winner happens to omit a day it references (e.g. days won from a
 *     cloud snapshot — or an unrelated device's state — that simply
 *     doesn't know about this locally-edited day yet). Every day these
 *     items reference is trusted outright and reconciled into the
 *     returned days[] (appended when missing, never reordering or
 *     removing existing entries) — this is what actually closes "a
 *     locally winning Plans/Lightning item got deleted because
 *     cloud-winning days[] removed its day".
 *   - itemsChangedLocally === false: `items` is cloud-sourced, or is the
 *     unchanged-local fallback (no local edit AND no valid cloud payload)
 *     — either way it is NOT evidence of a fresh local decision to keep
 *     referencing a day. A day present in `daysBaseline` but absent from
 *     `winningDays` is then authoritatively removed for this pull, and
 *     any such item is dropped — a stale cloud/local snapshot must never
 *     resurrect a day a local (or already-synced) removal dropped. A day
 *     NOT in `daysBaseline` at all (never known before this pull) is
 *     still legitimate new-day evidence either way, appended to the
 *     returned days[].
 *
 * Codex P1 fix (2nd round) — `extraDiscoveredDayIds`/`extraChangedLocally`
 * let the SIBLING dataset (Lightning's day IDs, from Plans' own pull, or
 * vice versa) participate in days reconciliation with the IDENTICAL
 * two-way trust rule as `items` above, but evaluated INDEPENDENTLY: a
 * page's own items winning locally must never automatically launder a
 * STALE sibling snapshot's day references too, and — the case this round
 * closes — a page preserving a genuinely newer LOCAL sibling edit (it
 * skipped overwriting the sibling's storage this pull because the sibling
 * changed since baseline) must not have that preserved sibling item
 * orphaned merely because its OWN items happened to win from cloud.
 * `extraChangedLocally` is that sibling's own verdict: true when the
 * sibling dataset being fed in is itself the locally-winning/preserved
 * one (its day IDs are trusted outright, appended unconditionally, exactly
 * like a locally-winning `items` set); false when it is cloud-sourced or
 * unchanged-stale (its day IDs are subject to the SAME removed-day filter
 * as non-locally-winning `items` — a stale sibling reference can never
 * resurrect a day a local removal dropped). Every persisted item from
 * EITHER dataset that survives into the final snapshot ends up covered:
 * `items`' own days via `itemsChangedLocally`, the sibling's via
 * `extraChangedLocally` — resolved once, together, not layered as a
 * separate pass.
 */
export function reconcileItemsWithDays<T extends { dayId: string }>(
  items: T[],
  itemsChangedLocally: boolean,
  daysBaseline: string[],
  winningDays: string[],
  extraDiscoveredDayIds: string[] = [],
  extraChangedLocally: boolean = false
): { items: T[]; days: string[] } {
  const removed = new Set(removedDayIds(daysBaseline, winningDays));
  const sanitizedItems = itemsChangedLocally
    ? items
    : removed.size === 0
      ? items
      : items.filter((it) => !removed.has(it.dayId));
  const trustedExtra = extraChangedLocally
    ? extraDiscoveredDayIds
    : extraDiscoveredDayIds.filter((id) => !removed.has(id));
  const knownDays = new Set(winningDays);
  const discovered = [
    ...new Set([...sanitizedItems.map((it) => it.dayId), ...trustedExtra]),
  ].filter((id) => !knownDays.has(id));
  const days = discovered.length > 0 ? [...winningDays, ...discovered.sort(daySort)] : winningDays;
  return { items: sanitizedItems, days };
}

/**
 * Reference cases for removedDayIds() + pickWinningDays(). Run from Node:
 *   import { DEV_DAYS_RECONCILIATION_CASES, removedDayIds, pickWinningDays } from "@/lib/crossDayChecks";
 *   DEV_DAYS_RECONCILIATION_CASES.forEach(c => {
 *     const gotRemoved = removedDayIds(c.baseline, c.winningDaysForRemovedCheck ?? c.current);
 *     const gotWinner = pickWinningDays(c.baseline, c.current, c.cloudDays);
 *     ...
 *   });
 */
export const DEV_DAYS_RECONCILIATION_CASES: Array<{
  name: string;
  baseline: string[];
  current: string[];
  cloudDays: string[] | undefined;
  expectedDays: string[];
  expectedChangedLocally: boolean;
}> = [
  {
    name: "no local change, no cloud days (unauthenticated/local-only) — current kept as-is",
    baseline: ["day-1"],
    current: ["day-1"],
    cloudDays: undefined,
    expectedDays: ["day-1"],
    expectedChangedLocally: false,
  },
  {
    name: "no local change, cloud days present — cloud replaces local outright",
    baseline: ["day-1"],
    current: ["day-1"],
    cloudDays: ["day-1", "day-2"],
    expectedDays: ["day-1", "day-2"],
    expectedChangedLocally: false,
  },
  {
    name: "no local change, legacy cloud payload (no days field) — local order preserved",
    baseline: ["day-1", "day-2"],
    current: ["day-1", "day-2"],
    cloudDays: undefined,
    expectedDays: ["day-1", "day-2"],
    expectedChangedLocally: false,
  },
  {
    name: "pure reorder — local wins, cloud days ignored even if present",
    baseline: ["day-1", "day-2", "day-3"],
    current: ["day-1", "day-3", "day-2"],
    cloudDays: ["day-1", "day-2", "day-3"],
    expectedDays: ["day-1", "day-3", "day-2"],
    expectedChangedLocally: true,
  },
  {
    name: "Add Day — local wins (membership changed), cloud order ignored",
    baseline: ["day-1"],
    current: ["day-1", "day-2"],
    cloudDays: ["day-1"],
    expectedDays: ["day-1", "day-2"],
    expectedChangedLocally: true,
  },
  {
    name: "Remove Day (populated) — local wins, removed day stays removed",
    baseline: ["day-1", "day-2", "day-3"],
    current: ["day-1", "day-3"],
    cloudDays: ["day-1", "day-2", "day-3"],
    expectedDays: ["day-1", "day-3"],
    expectedChangedLocally: true,
  },
  {
    name: "remove highest day then recreate same ID — current equals baseline again, treated as unchanged",
    baseline: ["day-1", "day-2", "day-3"],
    current: ["day-1", "day-2", "day-3"],
    cloudDays: undefined,
    expectedDays: ["day-1", "day-2", "day-3"],
    expectedChangedLocally: false,
  },
];

/**
 * Reference cases for reconcileItemsWithDays() — the structural
 * reconciliation step that closes two Codex findings without any
 * tombstone: (1) a removed day resurrected via a stale sibling/cloud item
 * snapshot, and (2) a LOCALLY winning item wrongly deleted merely because
 * the independently-decided days winner omitted its day. Run from Node:
 *   import { DEV_RECONCILE_ITEMS_CASES, reconcileItemsWithDays } from "@/lib/crossDayChecks";
 *   DEV_RECONCILE_ITEMS_CASES.forEach(c => {
 *     const got = reconcileItemsWithDays(c.items, c.itemsChangedLocally, c.daysBaseline, c.winningDays, c.extraDiscoveredDayIds, c.extraChangedLocally);
 *     ...
 *   });
 */
export const DEV_RECONCILE_ITEMS_CASES: Array<{
  name: string;
  items: Array<{ dayId: string }>;
  itemsChangedLocally: boolean;
  daysBaseline: string[];
  winningDays: string[];
  extraDiscoveredDayIds?: string[];
  extraChangedLocally?: boolean;
  expectedItemDayIds: string[];
  expectedDays: string[];
}> = [
  {
    name: "regression — stale (non-locally-winning) item snapshot still references a day the winning days[] already removed: dropped, not re-added",
    items: [{ dayId: "day-1" }, { dayId: "day-2" }, { dayId: "day-2" }],
    itemsChangedLocally: false,
    daysBaseline: ["day-1", "day-2", "day-3"],
    winningDays: ["day-1", "day-3"],
    expectedItemDayIds: ["day-1"],
    expectedDays: ["day-1", "day-3"],
  },
  {
    name: "legitimate new day (items not locally winning): winning items reference a day cloud omitted — appended, not dropped",
    items: [{ dayId: "day-1" }, { dayId: "day-4" }],
    itemsChangedLocally: false,
    daysBaseline: ["day-1"],
    winningDays: ["day-1"],
    expectedItemDayIds: ["day-1", "day-4"],
    expectedDays: ["day-1", "day-4"],
  },
  {
    name: "sibling-discovered day ID also subject to the same removed-day filter when neither items nor the sibling won locally",
    items: [{ dayId: "day-1" }],
    itemsChangedLocally: false,
    daysBaseline: ["day-1", "day-2"],
    winningDays: ["day-1"],
    extraDiscoveredDayIds: ["day-2", "day-5"],
    extraChangedLocally: false,
    expectedItemDayIds: ["day-1"],
    expectedDays: ["day-1", "day-5"],
  },
  {
    name: "day removed then recreated with the same ID before this pull — no longer treated as removed, items trusted",
    items: [{ dayId: "day-3" }],
    itemsChangedLocally: false,
    daysBaseline: ["day-1", "day-2", "day-3"],
    winningDays: ["day-1", "day-2", "day-3"],
    expectedItemDayIds: ["day-3"],
    expectedDays: ["day-1", "day-2", "day-3"],
  },
  {
    name: "nothing to reconcile — items already fully consistent with winningDays",
    items: [{ dayId: "day-1" }, { dayId: "day-2" }],
    itemsChangedLocally: false,
    daysBaseline: ["day-1", "day-2"],
    winningDays: ["day-1", "day-2"],
    expectedItemDayIds: ["day-1", "day-2"],
    expectedDays: ["day-1", "day-2"],
  },
  {
    name: "Codex P1 — locally winning item survives even though cloud-winning days[] removed its day (day reconciled back in)",
    items: [{ dayId: "day-1" }, { dayId: "day-5" }],
    itemsChangedLocally: true,
    daysBaseline: ["day-1", "day-5"],
    winningDays: ["day-1"],
    expectedItemDayIds: ["day-1", "day-5"],
    expectedDays: ["day-1", "day-5"],
  },
  {
    name: "Codex P1 — locally winning items untouched by removal reconcile cleanly against locally-won days too",
    items: [{ dayId: "day-1" }, { dayId: "day-3" }],
    itemsChangedLocally: true,
    daysBaseline: ["day-1", "day-2", "day-3"],
    winningDays: ["day-1", "day-3"],
    expectedItemDayIds: ["day-1", "day-3"],
    expectedDays: ["day-1", "day-3"],
  },
  {
    name: "Codex P1 (2nd round) — a STALE (non-locally-winning) sibling day reference is NOT trusted merely because OWN items happened to win locally",
    items: [{ dayId: "day-1" }],
    itemsChangedLocally: true,
    daysBaseline: ["day-1", "day-2"],
    winningDays: ["day-1"],
    extraDiscoveredDayIds: ["day-2"],
    extraChangedLocally: false,
    expectedItemDayIds: ["day-1"],
    expectedDays: ["day-1"],
  },
  {
    name: "Codex P1 (2nd round) — a preserved LOCALLY-winning sibling item is not orphaned when OWN items are cloud-sourced (Plans preserves newer local Lightning while cloud days omit its day)",
    items: [{ dayId: "day-1" }],
    itemsChangedLocally: false,
    daysBaseline: ["day-1", "day-2"],
    winningDays: ["day-1"],
    extraDiscoveredDayIds: ["day-2"],
    extraChangedLocally: true,
    expectedItemDayIds: ["day-1"],
    expectedDays: ["day-1", "day-2"],
  },
  {
    name: "Codex P1 (2nd round) — both item datasets survive locally: final days cover both coherently",
    items: [{ dayId: "day-1" }, { dayId: "day-3" }],
    itemsChangedLocally: true,
    daysBaseline: ["day-1", "day-3", "day-4"],
    winningDays: ["day-1", "day-3"],
    extraDiscoveredDayIds: ["day-4"],
    extraChangedLocally: true,
    expectedItemDayIds: ["day-1", "day-3"],
    expectedDays: ["day-1", "day-3", "day-4"],
  },
  {
    name: "local day removal wins while a preserved-local sibling is ALSO stale relative to it — removal still survives (sibling's own preservation doesn't launder a day IT doesn't actually reference)",
    items: [{ dayId: "day-1" }],
    itemsChangedLocally: true,
    daysBaseline: ["day-1", "day-2"],
    winningDays: ["day-1"],
    extraDiscoveredDayIds: [],
    extraChangedLocally: true,
    expectedItemDayIds: ["day-1"],
    expectedDays: ["day-1"],
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

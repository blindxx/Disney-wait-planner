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
import {
  capturePreFetchDomainSnapshot,
  resolvePostFetchDomainBaseline,
  resolveEffectiveDurableRaw,
  type ConfirmedDomainResult,
} from "@/lib/syncPayload";

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
 * single pull (see reconcilePlannerSnapshot below), never accumulated into
 * a persistent set. If day-3 is removed then re-added before the next
 * comparison, `nextDayIds` simply contains day-3 again and it is not
 * reported as removed relative to that comparison.
 */
export function removedDayIds(prevDayIds: string[], nextDayIds: string[]): string[] {
  const nextSet = new Set(nextDayIds);
  return prevDayIds.filter((id) => !nextSet.has(id));
}

/**
 * Extracts a raw, untyped item's `dayId`, or undefined when it's missing,
 * non-string, or the entry itself isn't an object — used by
 * reconcilePlannerSnapshot() below to filter/discover days from the
 * SIBLING dataset, which neither page ever types (it only ever touches
 * `dayId`). Never defaults a missing dayId — an item lacking one is simply
 * exempt from both the removed-day filter and day-discovery, never
 * silently coerced to "day-1" (that normalization is each domain's OWN
 * loader's job, not this cross-dataset reconciliation step's).
 */
function rawItemDayId(it: unknown): string | undefined {
  return it && typeof it === "object" && typeof (it as Record<string, unknown>).dayId === "string"
    ? ((it as Record<string, unknown>).dayId as string)
    : undefined;
}

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
 * SH.2.1 — integration coverage for the conflict-recovery authority
 * abstraction (capturePreFetchDomainSnapshot/resolvePostFetchDomainBaseline
 * in syncPayload.ts) chained into pickWinningItems() above, exercising the
 * REAL two-stage production sequence a pull actually runs rather than a
 * reimplementation: stage 1 (pre-fetch capture) runs first, exactly as
 * plans/page.tsx's and lightning/page.tsx's pull effect run it before the
 * fetch is issued; its result feeds stage 2 (post-fetch resolution) exactly
 * as those pages run it once the authoritative response is known — with a
 * FRESH `confirmed` read, called UNCONDITIONALLY on every pull (see
 * syncPayload.ts's own P2 doc for why the old "only re-derive when
 * justified" conditional is gone); stage 2's outcome becomes
 * pickWinningItems()'s own `baseline` argument, exactly as both pages use
 * `effectiveBaseline.items`/`days`/`lightningRaw`/`plansRaw`.
 *
 * This is what actually proves both SH.2.1 P1 (conflict recovery) and P2
 * (revision-bounded confirmed authority) are fixed structurally (see
 * syncPayload.ts's own module doc for both root causes): `preFetchDiskValue`
 * stands in for the real on-disk bytes at the moment stage 1 runs, and
 * `currentAtResolution` stands in for the fresh disk read the pull's
 * `.then()` takes immediately before calling pickWinningItems() — the two
 * are deliberately SEPARATE inputs here (never collapsed into one "current"
 * value) specifically to distinguish:
 *   • pre-existing, uncertain bytes that never changed during the fetch
 *     (`currentAtResolution === preFetchDiskValue`) — must lose to a
 *     strictly-newer authoritative cloud revision once recovered, never
 *     survive as if they were a fresh edit;
 *   • a genuine local edit made WHILE the fetch/recovery was in flight
 *     (`currentAtResolution !== preFetchDiskValue`) — must win outright,
 *     protected exactly like any other local edit, even though this same
 *     domain was conflicted moments earlier;
 *   • disk that ALREADY reflects an already-confirmed, but-newer-than-this-
 *     pull's-own-response revision (`currentAtResolution` equal to that
 *     newer confirmed value) — the Codex P2 scenario: must NEVER be treated
 *     as "unchanged relative to baseline" and overwritten by this pull's own
 *     stale cloud payload, because that "baseline" (the newer confirmed
 *     fact) must never have been used as this pull's baseline in the first
 *     place — see the "stale-response" cases below, where pickWinningItems()
 *     is never even reached.
 */
export const DEV_PULL_BASELINE_RECOVERY_INTEGRATION_CASES: Array<{
  name: string;
  confirmed: ConfirmedDomainResult<string>;
  cloudRevision: number | null;
  preFetchDiskValue: Array<{ id: string; dayId: string }>;
  currentAtResolution: Array<{ id: string; dayId: string }>;
  cloudItems: Array<{ id: string; dayId: string }> | null;
  fallbackValue: Array<{ id: string; dayId: string }>;
  expectedStageTwoKind: "confirmed" | "recovered" | "gated" | "stale-response" | "fallback";
  expectedWinner: "current" | "cloud" | "none (unusable this pull)";
}> = [
  {
    name: "required — stale pre-existing bytes cannot defeat authoritative recovery: conflicted rev6, authoritative rev7 recovers, disk never touched during the fetch — cloud (rev7) wins outright",
    confirmed: { status: "conflict", revision: 6 },
    cloudRevision: 7,
    preFetchDiskValue: [{ id: "1", dayId: "day-1" }],
    currentAtResolution: [{ id: "1", dayId: "day-1" }],
    cloudItems: [{ id: "1", dayId: "day-1" }, { id: "2", dayId: "day-2" }],
    fallbackValue: [],
    expectedStageTwoKind: "recovered",
    expectedWinner: "cloud",
  },
  {
    name: "required — genuine local edit made during the fetch/recovery window remains protected: same conflicted-then-recovered domain, but disk changed since stage 1's snapshot — local wins, cloud never overwrites it",
    confirmed: { status: "conflict", revision: 6 },
    cloudRevision: 7,
    preFetchDiskValue: [{ id: "1", dayId: "day-1" }],
    currentAtResolution: [{ id: "1", dayId: "day-1" }, { id: "2", dayId: "day-1" }],
    cloudItems: [{ id: "1", dayId: "day-1" }, { id: "9", dayId: "day-2" }],
    fallbackValue: [],
    expectedStageTwoKind: "recovered",
    expectedWinner: "current",
  },
  {
    name: "conflict + equal revision stays gated — no recovery attempted, no winner selection reachable",
    confirmed: { status: "conflict", revision: 6 },
    cloudRevision: 6,
    preFetchDiskValue: [{ id: "1", dayId: "day-1" }],
    currentAtResolution: [{ id: "1", dayId: "day-1" }],
    cloudItems: [{ id: "1", dayId: "day-1" }, { id: "2", dayId: "day-2" }],
    fallbackValue: [],
    expectedStageTwoKind: "gated",
    expectedWinner: "none (unusable this pull)",
  },
  {
    name: "normal confirmed baseline (no conflict at all) — confirmed value used as pickWinningItems' baseline, cloud wins when local unchanged",
    confirmed: { status: "confirmed", fact: { revision: 5, value: JSON.stringify([{ id: "1", dayId: "day-1" }]) } },
    cloudRevision: 5,
    preFetchDiskValue: [{ id: "1", dayId: "day-1" }],
    currentAtResolution: [{ id: "1", dayId: "day-1" }],
    cloudItems: [{ id: "1", dayId: "day-1" }, { id: "2", dayId: "day-2" }],
    fallbackValue: [],
    expectedStageTwoKind: "confirmed",
    expectedWinner: "cloud",
  },
  {
    name: "no confirmed baseline yet (fresh/offline profile) — falls back to the caller's own baseline ref value; a local edit made before this pull started (disk differs from that fallback ref) wins over cloud",
    confirmed: { status: "none" },
    cloudRevision: null,
    preFetchDiskValue: [{ id: "1", dayId: "day-1" }, { id: "2", dayId: "day-1" }],
    currentAtResolution: [{ id: "1", dayId: "day-1" }, { id: "2", dayId: "day-1" }],
    cloudItems: [{ id: "9", dayId: "day-9" }],
    fallbackValue: [{ id: "1", dayId: "day-1" }],
    expectedStageTwoKind: "fallback",
    expectedWinner: "current",
  },
  {
    name: "required (Codex P2 regression) — confirmed rev8 + this pull's own GET rev7: even though disk EXACTLY matches the newer confirmed value (the dangerous \"looks unchanged\" condition that would let a naive comparison pick cloud), the pull fails safe as stale-response BEFORE pickWinningItems ever runs — rev7's cloud payload (missing the rev8 item) is never selected, never overwrites rev8",
    confirmed: { status: "confirmed", fact: { revision: 8, value: JSON.stringify([{ id: "1", dayId: "day-1" }, { id: "9", dayId: "day-9" }]) } },
    cloudRevision: 7,
    preFetchDiskValue: [{ id: "1", dayId: "day-1" }],
    currentAtResolution: [{ id: "1", dayId: "day-1" }, { id: "9", dayId: "day-9" }],
    cloudItems: [{ id: "1", dayId: "day-1" }],
    fallbackValue: [],
    expectedStageTwoKind: "stale-response",
    expectedWinner: "none (unusable this pull)",
  },
  {
    name: "a null cloudRevision (204/unparseable) establishes no authority bound — an existing confirmed fact still fails safe as stale-response rather than being trusted blindly",
    confirmed: { status: "confirmed", fact: { revision: 1, value: JSON.stringify([{ id: "1", dayId: "day-1" }]) } },
    cloudRevision: null,
    preFetchDiskValue: [{ id: "1", dayId: "day-1" }],
    currentAtResolution: [{ id: "1", dayId: "day-1" }],
    cloudItems: null,
    fallbackValue: [],
    expectedStageTwoKind: "stale-response",
    expectedWinner: "none (unusable this pull)",
  },
];

/**
 * Run from Node:
 *   import { DEV_PULL_BASELINE_RECOVERY_INTEGRATION_CASES, pickWinningItems } from "@/lib/crossDayChecks";
 *   import { capturePreFetchDomainSnapshot, resolvePostFetchDomainBaseline } from "@/lib/syncPayload";
 *   DEV_PULL_BASELINE_RECOVERY_INTEGRATION_CASES.forEach(c => {
 *     const mapValue = (raw: string) => JSON.parse(raw);
 *     const stage1 = capturePreFetchDomainSnapshot(c.preFetchDiskValue);
 *     const stage2 = resolvePostFetchDomainBaseline(c.confirmed, c.cloudRevision, mapValue, stage1, c.fallbackValue);
 *     const kindOk = stage2.kind === c.expectedStageTwoKind;
 *     let winnerOk: boolean;
 *     if (stage2.kind === "gated" || stage2.kind === "stale-response") {
 *       winnerOk = c.expectedWinner === "none (unusable this pull)";
 *     } else {
 *       const { items, changedLocally } = pickWinningItems(stage2.value, c.currentAtResolution, c.cloudItems);
 *       const winner = changedLocally ? "current" : (items === c.cloudItems ? "cloud" : "current");
 *       winnerOk = winner === c.expectedWinner;
 *     }
 *     console.log(kindOk && winnerOk ? "✓" : "✗ FAIL", c.name);
 *   });
 */

/**
 * SH.2.1 P3 — integration coverage for the DURABLE LOCAL AUTHORITY fix
 * (resolveEffectiveDurableRaw in syncPayload.ts, the same pure core
 * syncHelper.ts's readLatestDurableValue() now reduces to) chained into the
 * REAL pre-fetch → post-fetch winner sequence above (capturePreFetchDomainSnapshot
 * / resolvePostFetchDomainBaseline / pickWinningItems) — proving the exact
 * scenario Codex described: a genuine local edit ("C") that survives ONLY
 * in the local-edit-fact log while the canonical key still holds a STALE
 * value ("B", left behind by the documented cross-tab hydration race) must
 * be recognized as this pull's true current local authority, at every
 * point the pull lifecycle asks "what is local state right now" — never
 * silently outranked by the stale canonical bytes.
 *
 * Each case models the domain's storage state as `canonicalRaw` +
 * `factRawValues` (exactly what readLatestDurableValue() itself reads) at
 * up to two points in time — PRE-FETCH (stage 1's frozen snapshot) and
 * POST-FETCH/resolution (stage 2's "current" candidate) — deliberately
 * kept as SEPARATE inputs, mirroring the real pull effect's own two
 * distinct read sites, never collapsed into one.
 */
export const DEV_DURABLE_LOCAL_AUTHORITY_INTEGRATION_CASES: Array<{
  name: string;
  confirmed: ConfirmedDomainResult<string>;
  cloudRevision: number | null;
  preFetchCanonicalRaw: string | null;
  preFetchFactRawValues: string[];
  postFetchCanonicalRaw: string | null;
  postFetchFactRawValues: string[];
  cloudItems: Array<{ id: string; dayId: string }> | null;
  fallbackValue: Array<{ id: string; dayId: string }>;
  expectedStageTwoKind: "confirmed" | "recovered" | "gated" | "stale-response" | "fallback";
  expectedWinner: "current" | "cloud" | "none (unusable this pull)";
}> = [
  {
    name: "required cases 1 & 2 — edit C survives only in the edit-fact log while canonical still holds stale B, and baseline itself equals that SAME stale B (the actual Codex regression shape: a naive canonical-only read would see current===baseline===B and wrongly call it 'unchanged'): this pull must still see C as current local authority, and C cannot be silently retired by cloud D",
    confirmed: { status: "none" },
    cloudRevision: null,
    preFetchCanonicalRaw: JSON.stringify([{ id: "B", dayId: "day-1" }]),
    preFetchFactRawValues: [JSON.stringify([{ id: "C", dayId: "day-1" }])],
    postFetchCanonicalRaw: JSON.stringify([{ id: "B", dayId: "day-1" }]),
    postFetchFactRawValues: [JSON.stringify([{ id: "C", dayId: "day-1" }])],
    cloudItems: [{ id: "D", dayId: "day-1" }],
    fallbackValue: [{ id: "B", dayId: "day-1" }],
    expectedStageTwoKind: "fallback",
    expectedWinner: "current",
  },
  {
    name: "required case 3 (part a) — edit C already durably CONFIRMED (an earlier pull recorded it): baseline already matches C, so cloud D legitimately wins even though C's fact has not been retired yet",
    confirmed: { status: "confirmed", fact: { revision: 5, value: JSON.stringify([{ id: "C", dayId: "day-1" }]) } },
    cloudRevision: 5,
    preFetchCanonicalRaw: JSON.stringify([{ id: "C", dayId: "day-1" }]),
    preFetchFactRawValues: [JSON.stringify([{ id: "C", dayId: "day-1" }])],
    postFetchCanonicalRaw: JSON.stringify([{ id: "C", dayId: "day-1" }]),
    postFetchFactRawValues: [JSON.stringify([{ id: "C", dayId: "day-1" }])],
    cloudItems: [{ id: "D", dayId: "day-1" }],
    fallbackValue: [],
    expectedStageTwoKind: "confirmed",
    expectedWinner: "cloud",
  },
  {
    name: "required case 5 — normal case, no edit facts anywhere: durable read equals canonical value, ordinary cloud-wins-when-unchanged behavior unaffected",
    confirmed: { status: "none" },
    cloudRevision: null,
    preFetchCanonicalRaw: JSON.stringify([{ id: "B", dayId: "day-1" }]),
    preFetchFactRawValues: [],
    postFetchCanonicalRaw: JSON.stringify([{ id: "B", dayId: "day-1" }]),
    postFetchFactRawValues: [],
    cloudItems: [{ id: "D", dayId: "day-1" }],
    fallbackValue: [{ id: "B", dayId: "day-1" }],
    expectedStageTwoKind: "fallback",
    expectedWinner: "cloud",
  },
  {
    name: "required case 6 — pre-fetch conflict-recovery snapshot uses durable authority (C), not stale canonical bytes (B): recovered baseline correctly equals C, so an unchanged post-fetch read (also C) lets cloud D legitimately win — were the bug present (baseline wrongly B), this SAME unchanged read would look spuriously 'changed' (B≠C) and wrongly block cloud, so this case's expected winner ('cloud') only holds when recovery truly used C",
    confirmed: { status: "conflict", revision: 6 },
    cloudRevision: 7,
    preFetchCanonicalRaw: JSON.stringify([{ id: "B", dayId: "day-1" }]),
    preFetchFactRawValues: [JSON.stringify([{ id: "C", dayId: "day-1" }])],
    postFetchCanonicalRaw: JSON.stringify([{ id: "B", dayId: "day-1" }]),
    postFetchFactRawValues: [JSON.stringify([{ id: "C", dayId: "day-1" }])],
    cloudItems: [{ id: "D", dayId: "day-1" }],
    fallbackValue: [],
    expectedStageTwoKind: "recovered",
    expectedWinner: "cloud",
  },
];

/**
 * Run from Node:
 *   import { DEV_DURABLE_LOCAL_AUTHORITY_INTEGRATION_CASES, pickWinningItems } from "@/lib/crossDayChecks";
 *   import { resolveEffectiveDurableRaw, capturePreFetchDomainSnapshot, resolvePostFetchDomainBaseline } from "@/lib/syncPayload";
 *   DEV_DURABLE_LOCAL_AUTHORITY_INTEGRATION_CASES.forEach(c => {
 *     const mapValue = (raw) => JSON.parse(raw);
 *     const preFetchDurableRaw = resolveEffectiveDurableRaw(c.preFetchCanonicalRaw, c.preFetchFactRawValues);
 *     const stage1 = capturePreFetchDomainSnapshot(preFetchDurableRaw ? mapValue(preFetchDurableRaw) : []);
 *     const postFetchDurableRaw = resolveEffectiveDurableRaw(c.postFetchCanonicalRaw, c.postFetchFactRawValues);
 *     const current = postFetchDurableRaw ? mapValue(postFetchDurableRaw) : [];
 *     const stage2 = resolvePostFetchDomainBaseline(c.confirmed, c.cloudRevision, mapValue, stage1, c.fallbackValue);
 *     const kindOk = stage2.kind === c.expectedStageTwoKind;
 *     let winnerOk;
 *     if (stage2.kind === "gated" || stage2.kind === "stale-response") {
 *       winnerOk = c.expectedWinner === "none (unusable this pull)";
 *     } else {
 *       const { items, changedLocally } = pickWinningItems(stage2.value, current, c.cloudItems);
 *       const winner = changedLocally ? "current" : (items === c.cloudItems ? "cloud" : "current");
 *       winnerOk = winner === c.expectedWinner;
 *     }
 *     console.log(kindOk && winnerOk ? "✓" : "✗ FAIL", c.name);
 *   });
 *
 * Required case 3 (part b) — once hydration legitimately retires C's fact
 * (this pull's own commitLocalDomainRaw success, unaffected by this round —
 * see syncHelper.ts's own doc), a SUBSEQUENT durable read resolves to the
 * hydrated value with NO fact log left to consult:
 *   resolveEffectiveDurableRaw(JSON.stringify([{id:"D",dayId:"day-1"}]), [])
 *     === JSON.stringify([{id:"D",dayId:"day-1"}])   // hydrated D, not stale C
 *
 * Required case 4 — a new edit E appearing DURING hydration (between the
 * baseline fact-keyspace snapshot and the write) makes the fact log
 * AMBIGUOUS (two facts, no ordering information): resolveEffectiveDurableRaw
 * itself safely refuses to guess between them and falls back to the
 * (older) canonical value rather than fabricating a winner —
 *   resolveEffectiveDurableRaw(canonicalB, [factC, factE]) === canonicalB
 * — this is NOT what protects E from being retired (E itself remains fully
 * intact in the fact log; nothing here deletes it). The actual "E is not
 * retired" guarantee is commitLocalDomainRaw's own untouched
 * `baselineEditFactIds` re-scan (syncHelper.ts) — a STRUCTURAL check (did
 * the fact KEYSPACE grow) independent of this function, which this round
 * does not modify. See DEV_DECIDE_LOCAL_DOMAIN_COMMIT_CASES/that function's
 * own doc for its existing, unaffected coverage.
 */

/**
 * SH.2 architecture (Codex P1, 4th round) — structural reconciliation over
 * the domains that will ACTUALLY be persisted: this page's own typed item
 * domain (`primary`) AND the sibling page's raw item domain (`sibling`),
 * reconciled together against ONE shared removed-day computation, so a day
 * dropped by the winning days[] can never leave an orphaned item behind in
 * EITHER dataset's actually-persisted storage.
 *
 * Root cause this closes: the previous model (reconcileItemsWithDays)
 * only ever sanitized the CALLER's own `items` array; the sibling
 * dataset's surviving content was represented merely as a list of
 * "discovered day IDs" used to EXTEND winningDays, never as the actual
 * item array a caller could sanitize and write back. A day legitimately
 * removed by winningDays was therefore correctly excluded from the final
 * days[] list, but the sibling's own raw localStorage payload — hydrated
 * or left untouched verbatim by the caller — still contained the item
 * that referenced it: an orphan (item.dayId ∉ days[]) that the derived
 * days[] list itself never revealed. This function fixes that by taking
 * the sibling's actual candidate items as input and returning its
 * SANITIZED items alongside the primary's — callers now persist BOTH,
 * closing the gap structurally rather than patching the symptom.
 *
 * `primary`/`sibling` are each `{ items, changedLocally }` — `changedLocally`
 * is that domain's own pickWinningItems() verdict for the items being fed
 * in (already-typed for primary, opaque unknown[] for sibling — neither
 * page ever needs the other's item typing, only `dayId`). Same two-way
 * trust rule as before, now applied structurally to EACH domain's actual
 * items rather than to one items array plus one derived day-id list:
 *
 *   - changedLocally === true: this domain's items are the pull's LOCALLY
 *     winning set — a real, possibly still-unpushed edit (in EITHER
 *     dataset). Trusted outright, never filtered by the removed-day set;
 *     every day referenced is reconciled into the returned days[]
 *     (appended when missing, never reordering/removing existing
 *     entries).
 *   - changedLocally === false: this domain's items are cloud-sourced, or
 *     the unchanged-local fallback — not evidence of a fresh local
 *     decision to keep referencing a day. Any item whose dayId is in
 *     `daysBaseline` but absent from `winningDays` is authoritatively
 *     removed for this pull and filtered OUT of the returned item array
 *     itself (not merely omitted from days[]) — a stale cloud/local
 *     snapshot, in either dataset, can never resurrect a day a local (or
 *     already-synced) removal dropped, and can never leave that day's
 *     item behind as an orphan either.
 *
 * A day NOT in `daysBaseline` at all (never known before this pull) is
 * still legitimate new-day evidence from either domain, appended to the
 * returned days[] regardless of that domain's changedLocally verdict.
 */
export function reconcilePlannerSnapshot<P extends { dayId: string }>(
  primary: { items: P[]; changedLocally: boolean },
  sibling: { items: unknown[]; changedLocally: boolean },
  daysBaseline: string[],
  winningDays: string[]
): { items: P[]; siblingItems: unknown[]; days: string[] } {
  const removed = new Set(removedDayIds(daysBaseline, winningDays));
  const sanitizedPrimary =
    primary.changedLocally || removed.size === 0
      ? primary.items
      : primary.items.filter((it) => !removed.has(it.dayId));
  const sanitizedSibling =
    sibling.changedLocally || removed.size === 0
      ? sibling.items
      : sibling.items.filter((it) => {
          const id = rawItemDayId(it);
          return id === undefined || !removed.has(id);
        });
  const knownDays = new Set(winningDays);
  const discoveredIds = new Set<string>();
  for (const it of sanitizedPrimary) discoveredIds.add(it.dayId);
  for (const it of sanitizedSibling) {
    const id = rawItemDayId(it);
    if (id) discoveredIds.add(id);
  }
  const discovered = [...discoveredIds].filter((id) => !knownDays.has(id));
  const days = discovered.length > 0 ? [...winningDays, ...discovered.sort(daySort)] : winningDays;
  return { items: sanitizedPrimary, siblingItems: sanitizedSibling, days };
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
 * Reference cases for reconcilePlannerSnapshot() — the structural
 * reconciliation step (4th round) that closes three Codex findings without
 * any tombstone: (1) a removed day resurrected via a stale sibling/cloud
 * item snapshot, (2) a LOCALLY winning item wrongly deleted merely because
 * the independently-decided days winner omitted its day, and (3) a stale
 * sibling item surviving in the sibling's OWN persisted storage even after
 * its day is correctly dropped from the derived days[] list. Run from Node:
 *   import { DEV_RECONCILE_PLANNER_SNAPSHOT_CASES, reconcilePlannerSnapshot } from "@/lib/crossDayChecks";
 *   DEV_RECONCILE_PLANNER_SNAPSHOT_CASES.forEach(c => {
 *     const got = reconcilePlannerSnapshot(c.primary, c.sibling, c.daysBaseline, c.winningDays);
 *     ...
 *   });
 */
export const DEV_RECONCILE_PLANNER_SNAPSHOT_CASES: Array<{
  name: string;
  primary: { items: Array<{ dayId: string }>; changedLocally: boolean };
  sibling: { items: unknown[]; changedLocally: boolean };
  daysBaseline: string[];
  winningDays: string[];
  expectedPrimaryDayIds: string[];
  expectedSiblingDayIds: string[];
  expectedDays: string[];
}> = [
  {
    name: "regression — stale (non-locally-winning) primary item snapshot still references a day the winning days[] already removed: dropped, not re-added",
    primary: { items: [{ dayId: "day-1" }, { dayId: "day-2" }, { dayId: "day-2" }], changedLocally: false },
    sibling: { items: [], changedLocally: false },
    daysBaseline: ["day-1", "day-2", "day-3"],
    winningDays: ["day-1", "day-3"],
    expectedPrimaryDayIds: ["day-1"],
    expectedSiblingDayIds: [],
    expectedDays: ["day-1", "day-3"],
  },
  {
    name: "legitimate new day (primary not locally winning): winning items reference a day cloud omitted — appended, not dropped",
    primary: { items: [{ dayId: "day-1" }, { dayId: "day-4" }], changedLocally: false },
    sibling: { items: [], changedLocally: false },
    daysBaseline: ["day-1"],
    winningDays: ["day-1"],
    expectedPrimaryDayIds: ["day-1", "day-4"],
    expectedSiblingDayIds: [],
    expectedDays: ["day-1", "day-4"],
  },
  {
    name: "Codex P1 (4th round) — stale (non-locally-winning) SIBLING items referencing a removed day are filtered from the actual sibling item array, not merely excluded from days[]",
    primary: { items: [{ dayId: "day-1" }], changedLocally: false },
    sibling: { items: [{ dayId: "day-2" }, { dayId: "day-5" }], changedLocally: false },
    daysBaseline: ["day-1", "day-2"],
    winningDays: ["day-1"],
    expectedPrimaryDayIds: ["day-1"],
    expectedSiblingDayIds: ["day-5"],
    expectedDays: ["day-1", "day-5"],
  },
  {
    name: "day removed then recreated with the same ID before this pull — no longer treated as removed, primary items trusted",
    primary: { items: [{ dayId: "day-3" }], changedLocally: false },
    sibling: { items: [], changedLocally: false },
    daysBaseline: ["day-1", "day-2", "day-3"],
    winningDays: ["day-1", "day-2", "day-3"],
    expectedPrimaryDayIds: ["day-3"],
    expectedSiblingDayIds: [],
    expectedDays: ["day-1", "day-2", "day-3"],
  },
  {
    name: "nothing to reconcile — both datasets already fully consistent with winningDays",
    primary: { items: [{ dayId: "day-1" }, { dayId: "day-2" }], changedLocally: false },
    sibling: { items: [{ dayId: "day-1" }], changedLocally: false },
    daysBaseline: ["day-1", "day-2"],
    winningDays: ["day-1", "day-2"],
    expectedPrimaryDayIds: ["day-1", "day-2"],
    expectedSiblingDayIds: ["day-1"],
    expectedDays: ["day-1", "day-2"],
  },
  {
    name: "Codex P1 — locally winning primary item survives even though cloud-winning days[] removed its day (day reconciled back in)",
    primary: { items: [{ dayId: "day-1" }, { dayId: "day-5" }], changedLocally: true },
    sibling: { items: [], changedLocally: false },
    daysBaseline: ["day-1", "day-5"],
    winningDays: ["day-1"],
    expectedPrimaryDayIds: ["day-1", "day-5"],
    expectedSiblingDayIds: [],
    expectedDays: ["day-1", "day-5"],
  },
  {
    name: "Codex P1 (2nd round) — a STALE (non-locally-winning) sibling day reference is NOT trusted merely because primary happened to win locally: filtered from the sibling's own items",
    primary: { items: [{ dayId: "day-1" }], changedLocally: true },
    sibling: { items: [{ dayId: "day-2" }], changedLocally: false },
    daysBaseline: ["day-1", "day-2"],
    winningDays: ["day-1"],
    expectedPrimaryDayIds: ["day-1"],
    expectedSiblingDayIds: [],
    expectedDays: ["day-1"],
  },
  {
    name: "Codex P1 (2nd round) — a preserved LOCALLY-winning sibling item is not orphaned when primary is cloud-sourced (e.g. Plans preserves newer local Lightning while cloud days omit its day)",
    primary: { items: [{ dayId: "day-1" }], changedLocally: false },
    sibling: { items: [{ dayId: "day-2" }], changedLocally: true },
    daysBaseline: ["day-1", "day-2"],
    winningDays: ["day-1"],
    expectedPrimaryDayIds: ["day-1"],
    expectedSiblingDayIds: ["day-2"],
    expectedDays: ["day-1", "day-2"],
  },
  {
    name: "Codex P1 (2nd round) — both item datasets survive locally: final days cover both coherently",
    primary: { items: [{ dayId: "day-1" }, { dayId: "day-3" }], changedLocally: true },
    sibling: { items: [{ dayId: "day-4" }], changedLocally: true },
    daysBaseline: ["day-1", "day-3", "day-4"],
    winningDays: ["day-1", "day-3"],
    expectedPrimaryDayIds: ["day-1", "day-3"],
    expectedSiblingDayIds: ["day-4"],
    expectedDays: ["day-1", "day-3", "day-4"],
  },
  {
    name: "local day removal wins while a preserved-local sibling is ALSO stale relative to it — removal still survives (sibling's own preservation doesn't launder a day IT doesn't actually reference)",
    primary: { items: [{ dayId: "day-1" }], changedLocally: true },
    sibling: { items: [], changedLocally: true },
    daysBaseline: ["day-1", "day-2"],
    winningDays: ["day-1"],
    expectedPrimaryDayIds: ["day-1"],
    expectedSiblingDayIds: [],
    expectedDays: ["day-1"],
  },
  {
    name: "Codex P1 (4th round) — malformed sibling entry (missing dayId) survives untouched, never treated as a match against the removed set",
    primary: { items: [{ dayId: "day-1" }], changedLocally: false },
    sibling: { items: [{ notDayId: "oops" }, "not-an-object", null], changedLocally: false },
    daysBaseline: ["day-1", "day-2"],
    winningDays: ["day-1"],
    expectedPrimaryDayIds: ["day-1"],
    expectedSiblingDayIds: [],
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

/**
 * plansContextInference.ts — Phase 7.3 (revised in 7.3.3)
 *
 * Pure, deterministic inference of resort/park context from a plans dataset.
 * Used as a one-time bootstrap fallback when no session context keys exist in
 * localStorage (dwp.selectedResort / dwp.selectedPark).
 *
 * No React state. No side effects. No localStorage access.
 * Accepts a plans dataset and returns the inferred context only.
 *
 * Algorithm (two-stage scoring — replaces "first unambiguous match" from 7.3):
 *
 *   Stage 1 — Resolve resort:
 *     Tier 1: Count items that resolve UNAMBIGUOUSLY to each resort (one resort
 *             matches, the other does not). The resort with more unambiguous
 *             matches wins.
 *     Tier 2: If Tier 1 is tied (including both-zero), count items that match
 *             EACH resort at all (including ambiguous items). More consistent
 *             matches wins.
 *     If Tier 2 is also tied: truly ambiguous — return {} (caller uses settings
 *             default).
 *
 *   Stage 2 — Resolve park within the winning resort:
 *     Filter to items with any match in the winning resort.
 *     Count matches per park. Most frequent park wins.
 *     Tiebreak: most recently added item (last in stable array) that matches
 *               any of the tied parks.
 *
 * Why two-stage scoring beats "first unambiguous":
 *   A dataset of {Soarin' + Big Thunder + Rise + Smugglers + Mickey & Minnie's}
 *   has Soarin' as the only unambiguous match (WDW/EPCOT). The prior algorithm
 *   returned EPCOT, ignoring that Rise, Smugglers, and Mickey all map to
 *   WDW/Hollywood Studios when WDW is already established via Soarin'.
 *   With two-stage scoring: Soarin' → WDW unique → Stage 1 picks WDW.
 *   Stage 2 then counts HS=2 (Smugglers, Mickey), MK=1 (Big Thunder),
 *   EPCOT=1 (Soarin') → correctly returns WDW/Hollywood Studios.
 *
 * Matching uses Stage 1 (exact) + Stage 3 (alias) only.
 * Stage 2 containment is intentionally excluded — too broad for inference.
 *
 * "Most recent" = last item in the stable PlanItem[] array (most recently
 * added), since PlanItem has no timestamp field.
 */

import { mockAttractionWaits, type ParkId, type ResortId } from "@disney-wait-planner/shared";
import {
  normalizeKey,
  ALIASES_DLR,
  ALIASES_WDW,
  stripAnnotations,
} from "@/lib/plansMatching";

type PlanItem = { id: string; name: string; timeLabel: string };
type ResolvedContext = { parkId: ParkId; resortId: ResortId };

/** Build a normalized-name → {parkId, resortId} map for one resort. */
function buildInferenceMap(resortId: ResortId): Map<string, ResolvedContext> {
  const map = new Map<string, ResolvedContext>();
  for (const a of mockAttractionWaits) {
    if (a.resortId !== resortId) continue;
    map.set(normalizeKey(a.name), { parkId: a.parkId as ParkId, resortId });
  }
  return map;
}

/**
 * Stage 1 (exact) + Stage 3 (alias) lookup.
 * Containment (Stage 2) is intentionally excluded — for inference we require
 * a stronger signal to avoid false positives.
 */
function tryResolve(
  name: string,
  map: Map<string, ResolvedContext>,
  aliases: Record<string, string>,
): ResolvedContext | null {
  const key = normalizeKey(stripAnnotations(name));

  // Stage 1: exact normalized match
  const exact = map.get(key);
  if (exact) return exact;

  // Stage 3: alias lookup (mirrors lookupWait's "the"-strip fallback)
  const aliasTarget =
    aliases[key] ??
    (key.startsWith("the ") ? aliases[key.slice(4)] : undefined);
  if (aliasTarget) {
    const aliasResult = map.get(aliasTarget);
    if (aliasResult) return aliasResult;
  }

  return null;
}

/**
 * Infer resort/park context from a plans dataset using two-stage scoring.
 *
 * Returns {} when inference is not possible (empty plans, or genuinely
 * ambiguous) — the caller falls back to Settings defaults.
 */
export function inferPlansContext(
  plans: PlanItem[],
): { resort?: ResortId; park?: ParkId } {
  if (plans.length === 0) return {};

  const dlrMap = buildInferenceMap("DLR");
  const wdwMap = buildInferenceMap("WDW");

  // Pre-compute both resort matches for every plan item in one pass.
  const allMatches = plans.map((p) => ({
    dlr: tryResolve(p.name, dlrMap, ALIASES_DLR),
    wdw: tryResolve(p.name, wdwMap, ALIASES_WDW),
  }));

  // ── Stage 1: Determine resort ──────────────────────────────────────────────

  let dlrUniqueCount = 0; // matches only DLR
  let wdwUniqueCount = 0; // matches only WDW
  let dlrAnyCount = 0;    // matches DLR at all (including ambiguous)
  let wdwAnyCount = 0;    // matches WDW at all (including ambiguous)

  for (const m of allMatches) {
    if (m.dlr) dlrAnyCount++;
    if (m.wdw) wdwAnyCount++;
    if (m.dlr && !m.wdw) dlrUniqueCount++;
    if (m.wdw && !m.dlr) wdwUniqueCount++;
  }

  let resort: ResortId | null = null;

  // Tier 1: prefer resort with more unambiguous-only matches.
  if (dlrUniqueCount > wdwUniqueCount) {
    resort = "DLR";
  } else if (wdwUniqueCount > dlrUniqueCount) {
    resort = "WDW";
  } else {
    // Tier 2: fall back to overall match frequency (includes ambiguous items).
    if (dlrAnyCount > wdwAnyCount) {
      resort = "DLR";
    } else if (wdwAnyCount > dlrAnyCount) {
      resort = "WDW";
    } else {
      // Genuinely ambiguous — cannot determine resort safely.
      return {};
    }
  }

  // ── Stage 2: Determine park within the resolved resort ────────────────────
  //
  // Count how many items resolve to each park within the winning resort.
  // Items that don't match the winning resort are ignored.
  // Most frequent park wins; tiebreak = most recently added item.

  const parkCount = new Map<ParkId, number>();

  for (const m of allMatches) {
    const resolved = resort === "DLR" ? m.dlr : m.wdw;
    if (!resolved) continue;
    parkCount.set(resolved.parkId, (parkCount.get(resolved.parkId) ?? 0) + 1);
  }

  if (parkCount.size === 0) {
    // Resort determined but no park could be resolved.
    return { resort };
  }

  // Find the maximum count.
  let maxCount = 0;
  for (const count of parkCount.values()) {
    if (count > maxCount) maxCount = count;
  }

  // Collect all parks tied at the max count.
  const topParks = [...parkCount.entries()]
    .filter(([, count]) => count === maxCount)
    .map(([parkId]) => parkId);

  if (topParks.length === 1) {
    return { resort, park: topParks[0] };
  }

  // Tiebreak: most recently added (last in array) item whose park is in the
  // top set. Iterate from the end (most recent) to the start (oldest).
  for (let i = plans.length - 1; i >= 0; i--) {
    const resolved = resort === "DLR" ? allMatches[i].dlr : allMatches[i].wdw;
    if (!resolved) continue;
    if (topParks.includes(resolved.parkId)) {
      return { resort, park: resolved.parkId };
    }
  }

  // Deterministic fallback: first top park in insertion order.
  return { resort, park: topParks[0] };
}

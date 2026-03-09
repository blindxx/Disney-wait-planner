/**
 * plansContextInference.ts — Phase 7.3
 *
 * Pure, deterministic inference of resort/park context from a plans dataset.
 * Used as a one-time bootstrap fallback when no session context keys exist in
 * localStorage (dwp.selectedResort / dwp.selectedPark).
 *
 * No React state. No side effects. No localStorage access.
 * Accepts a plans dataset and returns the inferred context only.
 *
 * Algorithm:
 *   1. Iterate plans from most recent (last in stable array) to oldest.
 *   2. For each plan item, attempt Stage 1 (exact) + Stage 3 (alias) matching
 *      against both DLR and WDW datasets independently.
 *      (Stage 2 containment is intentionally omitted — too ambiguous for inference.)
 *   3. Accept only unambiguous matches: resolves in exactly ONE resort.
 *      If a name matches in both resorts (e.g. "Space Mountain"), skip it.
 *   4. Return { resort, park } for the first unambiguous match found.
 *   5. If no plan resolves safely, return {} → caller falls back to Settings defaults.
 *
 * "Most recent" is determined by position in the existing stable array ordering
 * (last item = most recently added), since PlanItem has no timestamp.
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
 * Infer resort/park context from a plans dataset.
 *
 * Returns { resort, park } for the most recent plan item that resolves
 * unambiguously to exactly one resort/park pair.
 * Returns {} if inference is not possible (no plans, or all matches ambiguous).
 */
export function inferPlansContext(
  plans: PlanItem[],
): { resort?: ResortId; park?: ParkId } {
  if (plans.length === 0) return {};

  const dlrMap = buildInferenceMap("DLR");
  const wdwMap = buildInferenceMap("WDW");

  // Iterate from most recent (last item = most recently added) to oldest.
  for (let i = plans.length - 1; i >= 0; i--) {
    const name = plans[i].name;
    const dlr = tryResolve(name, dlrMap, ALIASES_DLR);
    const wdw = tryResolve(name, wdwMap, ALIASES_WDW);

    // Ambiguous: name resolves in both resorts (e.g. "Space Mountain") — skip.
    if (dlr && wdw) continue;

    if (dlr) return { resort: "DLR", park: dlr.parkId };
    if (wdw) return { resort: "WDW", park: wdw.parkId };
  }

  return {};
}

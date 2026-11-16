/**
 * entertainmentLifecycleVisibility.ts — Phase 14.5C the ONE place that turns
 * lifecycle decisions into "hide this canonical show" for the entertainment
 * surfaces. Pure and client-safe (no DB, no provider): the server attaches the
 * persisted auto-hidden names to the entertainment API bodies
 * (`lifecycleAutoHidden`), and both pages call this same function.
 *
 * Hidden = (reviewed registry `hidden` decisions) ∪ (persisted `auto_hidden`
 * names), restricted to ACTIVE, eligible catalog identities. Unknown, legacy
 * and seasonal names can never be hidden here (and legacy shows are not in the
 * active lists to begin with — nothing here can bring one back).
 *
 * Verified current performance (`performing`, taken from the SAME response the
 * page already holds) un-hides provisionally hidden shows immediately, without
 * waiting for the next monitor run: auto-hidden ones, and registry records that
 * are still `provisional`. A `confirmed` registry hide is a reviewed decision
 * and is never overridden here. No filtering system of its own: the pages apply
 * the returned set on top of the existing seasonal/performance-day rules, and
 * the All Entertainment synthesized/event/toggle paths take it as a parameter.
 *
 * Fail open: a missing/undefined `autoHidden` (DB down, older body) hides
 * nothing automatic; registry decisions still apply (static bundled data).
 */

import type { ParkId } from "@disney-wait-planner/shared";
import { ENTERTAINMENT_LIFECYCLE_REGISTRY, getLifecycleCatalogState, type EntertainmentLifecycleRegistry } from "./entertainmentLifecycleRegistry";
import { isLifecycleEligible } from "./entertainmentLifecycleDetector";

/** Names of curated shows with verified performances in the given showtime entries. */
export function performingNamesFromShowtimes(entries: ReadonlyArray<{ dwpName: string; performances: unknown[] }> | null | undefined): Set<string> {
  return new Set((entries ?? []).filter((e) => e.performances.length > 0).map((e) => e.dwpName));
}

/** Same, from All Entertainment entries (curated only — provider-only entries are not catalog identities). */
export function performingNamesFromAllEntries(entries: ReadonlyArray<{ source: string; name: string; showtime: { performances: unknown[] } }> | null | undefined): Set<string> {
  return new Set((entries ?? []).filter((e) => e.source === "curated" && e.showtime.performances.length > 0).map((e) => e.name));
}

/** Registry `hidden` decisions for active, eligible identities of the park. */
export function getRegistryHiddenNames(
  parkId: ParkId,
  registry: EntertainmentLifecycleRegistry = ENTERTAINMENT_LIFECYCLE_REGISTRY,
): { confirmed: Set<string>; provisional: Set<string> } {
  const confirmed = new Set<string>();
  const provisional = new Set<string>();
  for (const r of registry.records) {
    if (r.parkId !== parkId || r.visibility.decision !== "hidden") continue;
    if (getLifecycleCatalogState(r) !== "active" || !isLifecycleEligible(r.parkId, r.name)) continue;
    (r.confirmation === "confirmed" ? confirmed : provisional).add(r.name);
  }
  return { confirmed, provisional };
}

/**
 * Canonical names to hide for `parkId`. `autoHidden` = persisted auto-hidden
 * names from the API body (undefined = unknown → nothing automatic hidden).
 */
export function getLifecycleHiddenNames(
  parkId: ParkId,
  autoHidden?: readonly string[] | null,
  performing?: ReadonlySet<string> | null,
  registry: EntertainmentLifecycleRegistry = ENTERTAINMENT_LIFECYCLE_REGISTRY,
): Set<string> {
  const hidden = new Set<string>();
  const reg = getRegistryHiddenNames(parkId, registry);
  for (const n of reg.confirmed) hidden.add(n);
  for (const n of reg.provisional) if (!performing?.has(n)) hidden.add(n);
  if (Array.isArray(autoHidden)) {
    for (const n of autoHidden) {
      if (typeof n === "string" && isLifecycleEligible(parkId, n) && !performing?.has(n) && !reg.confirmed.has(n)) hidden.add(n);
    }
  }
  return hidden;
}

/** Remove lifecycle-hidden curated entries (All Entertainment). Provider-only entries are untouched. */
export function filterLifecycleHiddenEntries<T extends { source: string; name: string }>(entries: readonly T[], hidden: ReadonlySet<string>): T[] {
  if (hidden.size === 0) return entries.slice();
  return entries.filter((e) => !(e.source === "curated" && hidden.has(e.name)));
}

/**
 * entertainmentLifecycleVisibility.ts — Phase 14.5C the ONE place that turns
 * lifecycle decisions into "hide this canonical show" for the entertainment
 * surfaces. Pure and client-safe (no DB, no provider): the server attaches the
 * persisted auto-hidden names to the entertainment API bodies
 * (`lifecycleAutoHidden`), and both pages call this same function.
 *
 * Hidden = (reviewed registry `hidden` decisions, minus durably restored ones)
 * ∪ (persisted `auto_hidden` names), restricted to ACTIVE, eligible catalog identities. Unknown, legacy
 * and seasonal names can never be hidden here (and legacy shows are not in the
 * active lists to begin with — nothing here can bring one back).
 *
 * Verified current performance (`performing`, taken from the SAME response the
 * page already holds) un-hides auto-hidden shows AND registry-hidden shows whose
 * assessment is not `discontinued` immediately, without waiting for the next
 * monitor run (the monitor persists the restoration, `registryRestored`, and
 * flags it for audit; the registry record is never edited). A `discontinued`
 * registry hide is locked and never overridden. No filtering system of its own:
 * the pages apply the returned set on top of the existing seasonal/performance-day
 * rules, and the All Entertainment synthesized/event/toggle paths take it as a parameter.
 *
 * Legacy comebacks (Phase 14.5D): `getLegacyComebackPlaces` / `mergeLegacyComebackEntries` are the ONE
 * place that turns the persisted `lifecycleLegacyComebacks` names into legacy catalog shows to surface on
 * Waits & Shows and All Entertainment. A name surfaces only when it is an exact, park-qualified LEGACY
 * catalog identity whose provider identity is established (never an active identity, alias or provider-only
 * record) — so nothing here changes the legacy catalog, Smart Entry or planner identities. Unknown/undefined
 * input surfaces nothing. A comeback is never inferred from the page's own response: only the persisted
 * 7-of-14 state surfaces a legacy show.
 *
 * Fail open: a missing/undefined `autoHidden` (DB down, older body) hides
 * nothing automatic; registry decisions still apply (static bundled data).
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { ENTERTAINMENT_LIFECYCLE_REGISTRY, getLifecycleCatalogState, type EntertainmentLifecycleRegistry } from "./entertainmentLifecycleRegistry";
import { isLifecycleEligible, resolveLegacyShow, type LegacyIdentityOptions } from "./entertainmentLifecycleDetector";
import { getLegacyEntertainmentPlaces, type EntertainmentPlace } from "./entertainmentSuggestions";
import { mergeDiscoveredLegacyIdentities, type DiscoveredLegacyIdentity } from "./themeParksEntertainmentMapping";
import { getResortLocalDate } from "./resortTime";

/** Names of curated shows with verified performances in the given showtime entries. */
export function performingNamesFromShowtimes(entries: ReadonlyArray<{ dwpName: string; performances: unknown[] }> | null | undefined): Set<string> {
  return new Set((entries ?? []).filter((e) => e.performances.length > 0).map((e) => e.dwpName));
}

/** Same, from All Entertainment entries (curated only — provider-only entries are not catalog identities). */
export function performingNamesFromAllEntries(entries: ReadonlyArray<{ source: string; name: string; showtime: { performances: unknown[] } }> | null | undefined): Set<string> {
  return new Set((entries ?? []).filter((e) => e.source === "curated" && e.showtime.performances.length > 0).map((e) => e.name));
}

/**
 * Registry `hidden` decisions for active, eligible identities of the park.
 * `restorable` (assessment ≠ discontinued) may be overridden by verified
 * activity; `locked` (discontinued) never is.
 */
export function getRegistryHiddenNames(
  parkId: ParkId,
  registry: EntertainmentLifecycleRegistry = ENTERTAINMENT_LIFECYCLE_REGISTRY,
): { restorable: Set<string>; locked: Set<string> } {
  const restorable = new Set<string>();
  const locked = new Set<string>();
  for (const r of registry.records) {
    if (r.parkId !== parkId || r.visibility.decision !== "hidden") continue;
    if (getLifecycleCatalogState(r) !== "active" || !isLifecycleEligible(r.parkId, r.name)) continue;
    (r.assessment === "discontinued" ? locked : restorable).add(r.name);
  }
  return { restorable, locked };
}

/**
 * Canonical names to hide for `parkId`.
 *  - `autoHidden`: persisted auto-hidden names from the API body (undefined = unknown → none).
 *  - `performing`: names with verified performances in the SAME response (immediate un-hide).
 *  - `registryRestored`: names whose registry hide was durably overridden by the monitor
 *    (undefined = unknown → the registry hide stands unless `performing` overrides it).
 */
export function getLifecycleHiddenNames(
  parkId: ParkId,
  autoHidden?: readonly string[] | null,
  performing?: ReadonlySet<string> | null,
  registry: EntertainmentLifecycleRegistry = ENTERTAINMENT_LIFECYCLE_REGISTRY,
  registryRestored?: readonly string[] | null,
): Set<string> {
  const hidden = new Set<string>();
  const reg = getRegistryHiddenNames(parkId, registry);
  const restored = new Set(Array.isArray(registryRestored) ? registryRestored : []);
  for (const n of reg.locked) hidden.add(n);
  for (const n of reg.restorable) if (!performing?.has(n) && !restored.has(n)) hidden.add(n);
  if (Array.isArray(autoHidden)) {
    for (const n of autoHidden) {
      if (typeof n === "string" && isLifecycleEligible(parkId, n) && !performing?.has(n) && !reg.locked.has(n)) hidden.add(n);
    }
  }
  return hidden;
}

/** Remove lifecycle-hidden curated entries (All Entertainment). Provider-only entries are untouched. */
export function filterLifecycleHiddenEntries<T extends { source: string; name: string }>(entries: readonly T[], hidden: ReadonlySet<string>): T[] {
  if (hidden.size === 0) return entries.slice();
  return entries.filter((e) => !(e.source === "curated" && hidden.has(e.name)));
}

// ============================================
// Refresh-resilient evidence (Waits & Shows flicker fix)
// ============================================

/**
 * Hide evidence (names only — never performances) from the last showtimes response that
 * carried it, scoped to one park and one resort-local day. A transient refresh failure (or a
 * body without the lifecycle fields) must not fail the hide set open and briefly resurface
 * hidden shows; retained names are never a performance schedule and are never shown as current.
 */
export interface RetainedLifecycleEvidence {
  parkId: ParkId;
  resort: ResortId;
  localDate: string;
  autoHidden?: string[];
  registryRestored?: string[];
  /** Phase 14.5D: persisted legacy comebacks (names only), retained like the hide evidence so a refresh failure does not flicker them. */
  legacyComebacks?: string[];
  /** Persisted discovered legacy identities, retained with the comebacks they validate. */
  legacyIdentities?: DiscoveredLegacyIdentity[];
}

type EvidenceResponse = {
  parkId: ParkId;
  resort: RetainedLifecycleEvidence["resort"];
  localDate: string;
  error?: unknown;
  lifecycleAutoHidden?: string[];
  lifecycleRegistryRestored?: string[];
  lifecycleLegacyComebacks?: string[];
  lifecycleLegacyIdentities?: DiscoveredLegacyIdentity[];
} | null | undefined;

/**
 * Next retained evidence after a response for `parkId`. A healthy response that carries the
 * auto-hidden list replaces the evidence (so a legitimately restored show resurfaces at once).
 * The lifecycle arrays are read independently of the provider, so a provider-error body that carries
 * them is still authoritative. A failed request (no body) or a body without the list keeps the previous evidence only for the SAME park;
 * evidence from another park is dropped. (Same-day validity is enforced at use by
 * `activeRetainedEvidence`.)
 */
export function nextRetainedLifecycleEvidence(
  prev: RetainedLifecycleEvidence | null,
  parkId: ParkId,
  response: EvidenceResponse,
): RetainedLifecycleEvidence | null {
  const kept = prev && prev.parkId === parkId ? prev : null;
  if (!response || response.parkId !== parkId || !Array.isArray(response.lifecycleAutoHidden)) return kept;
  return {
    parkId,
    resort: response.resort,
    localDate: response.localDate,
    autoHidden: response.lifecycleAutoHidden.slice(),
    ...(Array.isArray(response.lifecycleRegistryRestored) ? { registryRestored: response.lifecycleRegistryRestored.slice() } : {}),
    ...(Array.isArray(response.lifecycleLegacyComebacks) ? { legacyComebacks: response.lifecycleLegacyComebacks.slice() } : {}),
    ...(Array.isArray(response.lifecycleLegacyIdentities) ? { legacyIdentities: response.lifecycleLegacyIdentities.slice() } : {}),
  };
}

/** Retained evidence usable now: same park and still the same resort-local day, else null. */
export function activeRetainedEvidence(
  retained: RetainedLifecycleEvidence | null,
  parkId: ParkId,
  instant: Date,
): RetainedLifecycleEvidence | null {
  if (!retained || retained.parkId !== parkId) return null;
  return retained.localDate === getResortLocalDate(retained.resort, instant) ? retained : null;
}

// ============================================
// Legacy comebacks (Phase 14.5D)
// ============================================

/**
 * Identity options for the legacy helpers below from the persisted discovered identities carried by the API
 * body (`lifecycleLegacyIdentities`). Manual `mapped` entries stay authoritative; an ambiguous/malformed
 * identity is dropped; undefined/unknown → the manual registry only.
 */
export function legacyIdentityOptions(identities: ReadonlyArray<DiscoveredLegacyIdentity> | null | undefined): LegacyIdentityOptions {
  return Array.isArray(identities) && identities.length > 0 ? { legacyMapping: mergeDiscoveredLegacyIdentities(identities) } : {};
}

/** Legacy catalog places to surface for `parkId` from persisted comeback names (validated; deduplicated; unknown → none). */
export function getLegacyComebackPlaces(parkId: ParkId, comebacks: readonly string[] | null | undefined, o: LegacyIdentityOptions = {}): EntertainmentPlace[] {
  if (!Array.isArray(comebacks)) return [];
  const legacyPlaces = o.legacyPlaces ?? getLegacyEntertainmentPlaces();
  const out: EntertainmentPlace[] = [];
  const seen = new Set<string>();
  for (const n of comebacks) {
    if (typeof n !== "string" || seen.has(n) || !resolveLegacyShow(parkId, n, o)) continue;
    const place = (legacyPlaces as readonly EntertainmentPlace[]).find((p) => p.parkId === parkId && p.name === n);
    if (!place) continue;
    seen.add(n);
    out.push(place);
  }
  return out;
}

/** The showtime entry for a Waits & Shows card: active entries first, then (comeback-only) legacy entries. */
export function findShowtimeEntry<T extends { dwpName: string }>(showtimes: { entries: readonly T[]; legacyEntries?: readonly T[] } | null | undefined, name: string): T | undefined {
  return showtimes?.entries.find((e) => e.dwpName === name) ?? showtimes?.legacyEntries?.find((e) => e.dwpName === name);
}

/**
 * All Entertainment: add the legacy entries of persisted comebacks to the live list. Exactly once per show:
 * skipped when an entry with the same id or name already exists, or when ANY existing entry (curated or
 * provider-only) already carries one of the legacy entry's provider entity ids (provider-only duplicate guard).
 */
export function mergeLegacyComebackEntries<T extends { id: string; source: string; name: string; showtime: { provider: ReadonlyArray<{ entityId: string }> } }>(
  entries: readonly T[],
  legacyEntries: readonly T[] | null | undefined,
  parkId: ParkId,
  comebacks: readonly string[] | null | undefined,
  o: LegacyIdentityOptions = {},
): T[] {
  const names = new Set(getLegacyComebackPlaces(parkId, comebacks, o).map((p) => p.name));
  if (names.size === 0 || !legacyEntries?.length) return entries.slice();
  const ids = new Set(entries.map((e) => e.id));
  const have = new Set(entries.map((e) => e.name));
  const entities = new Set(entries.flatMap((e) => e.showtime.provider.map((r) => r.entityId.toLowerCase())));
  const out = entries.slice();
  for (const le of legacyEntries) {
    if (le.source !== "curated" || !names.has(le.name) || ids.has(le.id) || have.has(le.name)) continue;
    if (le.showtime.provider.some((r) => entities.has(r.entityId.toLowerCase()))) continue;
    ids.add(le.id); have.add(le.name);
    for (const r of le.showtime.provider) entities.add(r.entityId.toLowerCase());
    out.push(le);
  }
  return out;
}

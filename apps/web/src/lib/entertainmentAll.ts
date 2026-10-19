/**
 * entertainmentAll.ts — Phase 12.11 normalized "All Entertainment" inventory
 * (hidden route /entertainment/all).
 *
 * A broader sibling of the Phase 12.3 curated showtimes contract. For one park
 * it returns every LIVE provider SHOW the park's ThemeParks payload carries,
 * each explicitly labelled:
 *   curated        a mapped active DWP Entertainment entry (identity + land
 *                  come from ENTERTAINMENT_PLACES; its showtime result is the
 *                  unchanged `normalizeParkEntertainmentShowtimes` entry)
 *   provider_only  a live SHOW entity that no explicit mapping claims. Shown
 *                  under the provider's own name; never added to a DWP
 *                  catalog. Its land/venue come only from the explicit
 *                  park+UUID table in entertainmentProviderLocations.ts;
 *                  otherwise they stay unknown (never inferred from name or
 *                  coordinates). The source classification is internal — the
 *                  UI shows no badge.
 * Labels come only from the explicit mapping (entity-id membership) — there is
 * no runtime name matching.
 *
 * Not in the inventory: unmapped curated entries and curated entries none of
 * whose provider refs are in the live payload (dormant/seasonal — `/live`
 * omits them), and non-SHOW provider entities. Provider failure yields no
 * entries plus the typed `error`; nothing is fabricated.
 *
 * Showtime semantics are reused, not re-implemented: performance-type
 * filtering, resort-local date, passed rule, completeness/uncertainty
 * (`incomplete`, `stale`, previous-day degrade) all come from
 * entertainmentShowtimes.ts. The existing curated API is unchanged.
 *
 * Client-safe (type-only imports from the server-only ThemeParks client); the
 * server fetch lives in entertainmentAllService.ts.
 *
 * DEV checks (run manually, returns failing labels): runDevEntertainmentAllCases().
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { ENTERTAINMENT_PLACES } from "./entertainmentSuggestions";
import {
  PARTIAL_SHOWTIMES_NOTE,
  SHOWTIME_STATUS_MESSAGES,
  collectOperatingIntervals,
  entryDisplayAt,
  entryFromMapping,
  isPerformancePassed,
  normalizeParkEntertainmentShowtimes,
  type EntertainmentOperatingInterval,
  type EntertainmentShowtimeEntry,
  type EntertainmentShowtimeMeta,
  type EntertainmentShowtimeStatus,
} from "./entertainmentShowtimes";
import { PARK_TO_RESORT } from "./parkMetadata";
import { getProviderEntertainmentLocation } from "./entertainmentProviderLocations";
import { getResortLocalDate } from "./resortTime";
import type { ThemeParksError, ThemeParksLive, ThemeParksResult, ThemeParksShowtime } from "./themeParksApi";
import { THEMEPARKS_ENTERTAINMENT_MAPPING } from "./themeParksEntertainmentMapping";
import { THEMEPARKS_PARKS } from "./themeParksProviders";

// ============================================
// TYPES
// ============================================

export type AllEntertainmentSource = "curated" | "provider_only";

export interface AllEntertainmentEntry {
  /** Stable across refreshes (expansion state keys off it): curated → park + DWP name; provider-only → provider entity id. */
  id: string;
  source: AllEntertainmentSource;
  /** Curated: DWP name. Provider-only: the provider's own name (display only). */
  name: string;
  /** Curated: catalog land. Provider-only: land from the explicit location table, else null (unknown). */
  land: string | null;
  /** Specific venue, only from the explicit location table (provider-only); null when unknown. */
  venue: string | null;
  /** Normalized showtimes. For provider-only, `dwpName` merely carries the provider's display name. */
  showtime: EntertainmentShowtimeEntry;
  /**
   * Today's provider "Operating" intervals (Phase 12.12), separate from
   * performances. Empty when none are published, when the payload was fetched on
   * a previous resort-local day, or on an older body lacking the field.
   */
  operatingHours?: EntertainmentOperatingInterval[];
}

/** Prefix of the operating-hours line. */
export const OPERATING_HOURS_PREFIX = "Operating hours: ";

/** Shown with the list when the provider payload had discarded (malformed) entries: the inventory may be missing shows. */
export const INVENTORY_INCOMPLETE_NOTE = "Some entertainment may be missing from this list.";
/** Empty-list copy when nothing could be confirmed and the payload was incomplete (vs. valid-empty). */
export const INVENTORY_INCOMPLETE_EMPTY_MESSAGE = "No entertainment could be confirmed for this park right now. The provider's list may be incomplete.";

export interface ParkAllEntertainment {
  parkId: ParkId;
  resort: ResortId;
  /** Resort-local calendar date the performances were filtered to. */
  localDate: string;
  asOf: string;
  fetchedLocalDate: string | null;
  stale: boolean;
  meta: EntertainmentShowtimeMeta | null;
  error: ThemeParksError | null;
  /**
   * True when the live payload discarded entries during validation
   * (`droppedEntries > 0`): valid entries are kept, but the inventory cannot be
   * claimed complete. False on provider failure (there is `error` instead).
   */
  inventoryIncomplete: boolean;
  entries: AllEntertainmentEntry[];
}

// ============================================
// NORMALIZATION (pure)
// ============================================

/** Curated catalog land for a park-qualified DWP name (catalog identity, not provider data). */
function curatedLand(parkId: ParkId, dwpName: string): string | null {
  return ENTERTAINMENT_PLACES.find((p) => p.parkId === parkId && p.name === dwpName)?.land ?? null;
}

/** Entity ids claimed by any explicit curated mapping (lowercase). */
function mappedEntityIds(): Set<string> {
  const ids = new Set<string>();
  for (const m of THEMEPARKS_ENTERTAINMENT_MAPPING) {
    if (m.disposition === "mapped") for (const r of m.provider) ids.add(r.entityId.toLowerCase());
  }
  return ids;
}

/**
 * Pure: turn a provider live result for a park into the All Entertainment
 * inventory. `instant` is "now". Unsorted — sorting is a display concern
 * (`sortAllEntertainment`) because it depends on the advancing clock.
 */
export function buildParkAllEntertainment(
  parkId: ParkId,
  result: ThemeParksResult<ThemeParksLive>,
  instant: Date = new Date(),
): ParkAllEntertainment {
  const curated = normalizeParkEntertainmentShowtimes(parkId, result, instant);
  const resort = PARK_TO_RESORT[parkId] as ResortId;
  const entries: AllEntertainmentEntry[] = [];
  const liveForHours = result.ok ? result.data : null;
  // A payload fetched on another resort-local day cannot vouch for today's hours.
  const hoursCurrent = curated.fetchedLocalDate === curated.localDate;
  const hoursFor = (entityIds: string[]): EntertainmentOperatingInterval[] => {
    if (!liveForHours || !hoursCurrent) return [];
    const ids = new Set(entityIds.map((i) => i.toLowerCase()));
    const raw = liveForHours.entries.filter((x) => ids.has(x.entityId.toLowerCase())).flatMap((x) => x.showtimes);
    return collectOperatingIntervals(resort, curated.localDate, raw);
  };

  for (const e of curated.entries) {
    if (e.status === "unmapped") continue; // never provider-checked
    if (!e.provider.some((r) => r.present)) continue; // no live presence: dormant-only, or provider failure
    entries.push({ id: `curated:${parkId}:${e.dwpName}`, source: "curated", name: e.dwpName, land: curatedLand(parkId, e.dwpName), venue: null, showtime: e, operatingHours: hoursFor(e.provider.map((r) => r.entityId)) });
  }

  const live = result.ok ? result.data : null;
  if (live) {
    const claimed = mappedEntityIds();
    const parkUuid = THEMEPARKS_PARKS[parkId].entityId.toLowerCase();
    const nowMs = instant.getTime();
    const localDate = getResortLocalDate(resort, instant);
    const payloadCurrent = curated.fetchedLocalDate === localDate;
    const seen = new Set<string>();
    for (const le of live.entries) {
      const key = le.entityId.toLowerCase();
      if (le.entityType !== "SHOW" || claimed.has(key) || seen.has(key)) continue;
      if (le.parkId !== null && le.parkId.toLowerCase() !== parkUuid) continue;
      seen.add(key);
      // Same completeness/performance rules as curated entries, via a throwaway
      // single-ref record (not stored anywhere, never a catalog mapping).
      const showtime = entryFromMapping(
        { dwpName: le.name, parkId, disposition: "mapped", provider: [{ entityId: le.entityId, entityType: "SHOW", providerName: le.name }] },
        live,
        resort,
        localDate,
        nowMs,
        payloadCurrent,
      );
      const location = getProviderEntertainmentLocation(parkId, key);
      entries.push({ id: `provider:${key}`, source: "provider_only", name: le.name, land: location?.land ?? null, venue: location?.venue ?? null, showtime, operatingHours: hoursFor([le.entityId]) });
    }
  }

  return {
    parkId,
    resort,
    localDate: curated.localDate,
    asOf: curated.asOf,
    fetchedLocalDate: curated.fetchedLocalDate,
    stale: curated.stale,
    meta: curated.meta,
    error: curated.error,
    inventoryIncomplete: !!live && live.droppedEntries > 0,
    entries,
  };
}

// ============================================
// DEGRADATION HELPERS (pure, client-safe)
// ============================================

function unavailablePark(parkId: ParkId, instant: Date, message: string): ParkAllEntertainment {
  return buildParkAllEntertainment(parkId, { ok: false, error: { kind: "network", message } }, instant);
}

/** Browser-side: fetched /api/entertainment/all body → display state; failure or wrong shape degrades to the unavailable state (old data is never retained). */
export function resolveAllEntertainmentResponse(parkId: ParkId, body: unknown, instant: Date = new Date()): ParkAllEntertainment {
  const d = body as Partial<ParkAllEntertainment> | null;
  if (!d || typeof d !== "object" || d.parkId !== parkId || !Array.isArray(d.entries) || typeof d.localDate !== "string") {
    return unavailablePark(parkId, instant, "All Entertainment request failed");
  }
  return d as ParkAllEntertainment;
}

/** Data computed for a previous resort-local day is never shown as today's. */
export function allEntertainmentForDisplay(data: ParkAllEntertainment | null, instant: Date = new Date()): ParkAllEntertainment | null {
  if (!data) return null;
  if (data.localDate === getResortLocalDate(data.resort, instant)) return data;
  return unavailablePark(data.parkId, instant, "Showtimes are for a previous day");
}

/**
 * ThemeParks.wiki attribution is owed whenever a successful provider response
 * is presented — including a valid-empty one ("nothing listed" is provider
 * data). Failed requests (and previous-day degradation) present none.
 */
export function allEntertainmentPresentsProviderData(data: ParkAllEntertainment | null): boolean {
  return !!data && !data.error;
}

/** Copy for a successful but empty inventory (valid-empty vs. incomplete-empty). */
export const INVENTORY_EMPTY_MESSAGE = "No live entertainment is listed for this park right now.";

/**
 * Empty-inventory state for a successful response: the message plus whether the
 * existing stale-data warning ("may be outdated") must accompany it (stale-if-error
 * payloads). null when there is an error or entries exist.
 */
export function allEntertainmentEmptyState(data: ParkAllEntertainment | null): { message: string; stale: boolean } | null {
  if (!data || data.error || data.entries.length > 0) return null;
  return { message: allEntertainmentIsIncomplete(data) ? INVENTORY_INCOMPLETE_EMPTY_MESSAGE : INVENTORY_EMPTY_MESSAGE, stale: data.stale };
}

/** Whether the list must be flagged as possibly incomplete (tolerates older bodies lacking the field). */
export function allEntertainmentIsIncomplete(data: ParkAllEntertainment | null): boolean {
  return !!data && !data.error && data.inventoryIncomplete === true;
}

// ============================================
// DISPLAY (pure, client-safe)
// ============================================

export interface AllEntertainmentView {
  status: EntertainmentShowtimeStatus;
  /** Collapsed line — identical to Waits & Shows: upcoming/in-progress times joined by " • ", else the status message. */
  collapsedText: string | null;
  /** Upcoming-only times shown from an incomplete schedule (collapsed note). */
  partial: boolean;
  /** Full daily schedule, re-evaluated at `now` (passed times are muted by the UI). */
  times: Array<{ localTime: string; passed: boolean }>;
  /** True when expanding reveals something the collapsed line omits (passed times). */
  expandable: boolean;
  /** Schedule may be non-exhaustive (shown in the expanded view too). */
  incomplete: boolean;
  /** Next/in-progress performance start (ms), null when none remain. */
  nextStartMs: number | null;
  /** "Operating hours: 9:00 AM–5:00 PM", shown after performances; null when no verified hours. */
  hoursText: string | null;
}

export function allEntryViewAt(entry: AllEntertainmentEntry, now: Date = new Date()): AllEntertainmentView {
  const d = entryDisplayAt(entry.showtime, now);
  const nowMs = now.getTime();
  const times = entry.showtime.performances.map((p) => ({
    localTime: p.localTime,
    passed: isPerformancePassed(new Date(p.startTime).getTime(), p.endTime ? new Date(p.endTime).getTime() : NaN, nowMs),
  }));
  const hours = entry.operatingHours ?? [];
  const hoursText = hours.length > 0 ? `${OPERATING_HOURS_PREFIX}${hours.map((h) => h.label).join(", ")}` : null;
  return {
    status: d.status,
    // Verified hours replace only the "No showtimes posted" claim; every other message stays.
    collapsedText: d.status === "upcoming" ? d.remaining.map((p) => p.localTime).join(" • ") : d.status === "none_posted" && hoursText ? null : d.message,
    partial: d.partial,
    times,
    expandable: times.length > d.remaining.length,
    incomplete: entry.showtime.incomplete,
    nextStartMs: d.remaining.length > 0 ? new Date(d.remaining[0].startTime).getTime() : null,
    hoursText,
  };
}

/**
 * Card layout flags. The showtimes container renders only with showtime content
 * (collapsed text or an expanded schedule); operating hours never open it. The
 * stale warning goes on the showtimes line when that renders, else beside the hours.
 */
export function allEntryLayout(view: AllEntertainmentView, expanded: boolean, stale: boolean): {
  showFull: boolean;
  showShowtimes: boolean;
  showtimesStale: boolean;
  hoursStale: boolean;
} {
  const showFull = expanded && view.times.length > 0;
  const showShowtimes = !!view.collapsedText || showFull;
  return {
    showFull,
    showShowtimes,
    showtimesStale: stale && showShowtimes,
    hoursStale: stale && !showShowtimes && !!view.hoursText,
  };
}

const STATUS_RANK: Record<EntertainmentShowtimeStatus, number> = { upcoming: 0, all_passed: 1, none_posted: 2, unavailable: 3, unmapped: 4 };

/** Sort by next (or in-progress) showtime at `now`; entries with none remaining follow, then by name. */
export function sortAllEntertainment(entries: AllEntertainmentEntry[], now: Date = new Date()): AllEntertainmentEntry[] {
  return entries
    .map((e) => ({ e, v: allEntryViewAt(e, now) }))
    .sort((a, b) => {
      const ra = STATUS_RANK[a.v.status];
      const rb = STATUS_RANK[b.v.status];
      if (ra !== rb) return ra - rb;
      if (a.v.nextStartMs !== null && b.v.nextStartMs !== null && a.v.nextStartMs !== b.v.nextStartMs) return a.v.nextStartMs - b.v.nextStartMs;
      return a.e.name.localeCompare(b.e.name) || a.e.id.localeCompare(b.e.id);
    })
    .map((x) => x.e);
}

/** Aggregate provider operating status across present refs: "OPERATING" if any ref is, else the first reported status, else null. */
export function allEntryProviderStatus(entry: AllEntertainmentEntry): string | null {
  const present = entry.showtime.provider.filter((r) => r.present && r.status);
  if (present.some((r) => r.status === "OPERATING")) return "OPERATING";
  return present[0]?.status ?? null;
}

/** "Land · Venue" when both are known, the land alone when the venue is unknown, null when the location is unknown. */
export function allEntryLocationLabel(entry: AllEntertainmentEntry): string | null {
  if (!entry.land) return null;
  return entry.venue ? `${entry.land} · ${entry.venue}` : entry.land;
}

/** Lands present in the inventory (curated catalog lands + verified provider-only lands). */
export function allEntertainmentLands(entries: AllEntertainmentEntry[]): string[] {
  return [...new Set(entries.map((e) => e.land).filter((l): l is string => !!l))].sort();
}

/** Shared land filter + operating-only toggle. Entries with unknown location match only "All Lands". */
export function filterAllEntertainment(
  entries: AllEntertainmentEntry[],
  opts: { land?: string; operatingOnly?: boolean },
): AllEntertainmentEntry[] {
  return entries.filter(
    (e) => (!opts.land || e.land === opts.land) && (!opts.operatingOnly || allEntryProviderStatus(e) === "OPERATING"),
  );
}

/**
 * DOM id for a card's showtimes region (aria-controls target). Entry ids can
 * hold spaces/punctuation (curated ids embed the DWP name), which an id
 * reference must not. Every char outside [A-Za-z0-9-] — "_" included — becomes
 * `_<hex>_`, so the result is whitespace-free and distinct entry ids never collide.
 */
export function showtimesRegionId(entryId: string): string {
  return `times-${entryId.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
}

/** Link target from Waits & Shows; carries the park so the page opens on it. */
export function allEntertainmentHref(parkId: ParkId): string {
  return `/entertainment/all?park=${encodeURIComponent(parkId)}`;
}

/**
 * Waits & Shows Entertainment section layout. The All Entertainment link is
 * independent of the curated list (a land filter can leave no curated shows
 * while the park still has live entertainment), so it is always shown; the
 * description and grid render only when curated cards remain.
 */
export function waitsEntertainmentSectionState(visibleCuratedCount: number): { showLink: boolean; showGrid: boolean } {
  return { showLink: true, showGrid: visibleCuratedCount > 0 };
}

/** Immutable expansion toggle; ids are stable so expansion survives data refreshes and clock ticks. */
export function toggleExpanded(expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded);
  if (!next.delete(id)) next.add(id);
  return next;
}

// ============================================
// DEV CASES
// ============================================

/**
 * Run manually from Node (e.g. via tsx), like the other DEV_* helpers:
 *   import { runDevEntertainmentAllCases } from "./entertainmentAll";
 *   console.log(runDevEntertainmentAllCases()); // [] = all pass
 */
export function runDevEntertainmentAllCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };

  const FANTASMIC_HS = "42328c39-76ab-4f03-b862-4206c8d9f7bb";
  const PROVIDER_ONLY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PROVIDER_ONLY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const PROVIDER_ATTRACTION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const OTHER_PARK_SHOW = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const HS_UUID = THEMEPARKS_PARKS.hs.entityId;
  const NOW = new Date("2026-10-01T19:00:00Z"); // 3:00 PM EDT

  const st = (startTime: string, type: string | null = "Performance Time", endTime: string | null = null): ThemeParksShowtime => ({ type, startTime, endTime });
  const entry = (entityId: string, name: string, showtimes: ThemeParksShowtime[], over: Partial<ThemeParksLive["entries"][number]> = {}) => ({
    entityId, name, entityType: "SHOW", parkId: HS_UUID, externalId: null, status: "OPERATING", lastUpdated: null, showtimes, droppedShowtimes: 0, ...over,
  });
  const live = (entries: ReturnType<typeof entry>[], origin: "network" | "stale" = "network", fetchedAt = NOW.getTime()): ThemeParksResult<ThemeParksLive> => ({
    ok: true,
    data: { entityId: HS_UUID, name: "HS", timeZone: null, entries, droppedEntries: 0, droppedShowtimes: 0 },
    meta: { origin, fetchedAt, etag: null },
  });
  const byName = (r: ParkAllEntertainment, n: string) => r.entries.find((e) => e.name === n);

  const base = buildParkAllEntertainment("hs", live([
    entry(FANTASMIC_HS, "Fantasmic! (provider name)", [st("2026-10-01T10:00:00-04:00"), st("2026-10-01T19:30:00-04:00"), st("2026-10-01T21:00:00-04:00")]),
    entry(PROVIDER_ONLY_A, "Provider Street Band", [st("2026-10-01T20:00:00-04:00")]),
    entry(PROVIDER_ONLY_B, "Meet a Character", [st("2026-10-01T09:00:00-04:00", "Operating", "2026-10-01T18:00:00-04:00")]),
    entry(PROVIDER_ATTRACTION, "Some Ride", [], { entityType: "ATTRACTION" }),
    entry(OTHER_PARK_SHOW, "Other Park Show", [st("2026-10-01T20:00:00-04:00")], { parkId: THEMEPARKS_PARKS.mk.entityId }),
  ]), NOW);

  // ---- inventory ----
  check("inventory: curated mapped entry present (identity from DWP, not provider name)", !!byName(base, "Fantasmic!") && !byName(base, "Fantasmic! (provider name)"));
  check("inventory: provider-only SHOW entities included", !!byName(base, "Provider Street Band") && !!byName(base, "Meet a Character"));
  check("inventory: non-SHOW provider entities excluded", !byName(base, "Some Ride"));
  check("inventory: other-park SHOW excluded", !byName(base, "Other Park Show"));
  check("inventory: mapped ref never repeated as provider-only", base.entries.filter((e) => e.id.includes(FANTASMIC_HS)).length === 0);
  check("inventory: dormant curated entries (not in live) excluded", base.entries.filter((e) => e.source === "curated").length === 1);
  check("inventory: unmapped curated never listed", base.entries.every((e) => e.showtime.status !== "unmapped"));
  check("inventory: ids unique", new Set(base.entries.map((e) => e.id)).size === base.entries.length);
  {
    const dup = buildParkAllEntertainment("hs", live([entry(PROVIDER_ONLY_A, "A", []), entry(PROVIDER_ONLY_A, "A", [])]), NOW);
    check("inventory: duplicate provider entity listed once", dup.entries.length === 1);
    const failed = buildParkAllEntertainment("hs", { ok: false, error: { kind: "timeout", message: "t" } }, NOW);
    check("inventory: provider failure → no entries + typed error (nothing fabricated)", failed.entries.length === 0 && failed.error?.kind === "timeout");
    const empty = buildParkAllEntertainment("hs", live([]), NOW);
    check("inventory: valid-empty live → no entries, no error", empty.entries.length === 0 && empty.error === null);
  }

  // ---- classification ----
  const fant = byName(base, "Fantasmic!")!;
  const po = byName(base, "Provider Street Band")!;
  check("classification: curated source + catalog land, no venue", fant.source === "curated" && fant.land !== null && fant.venue === null);
  check("classification: unlisted provider-only keeps source, location unknown (never inferred)", po.source === "provider_only" && po.land === null && po.venue === null && allEntryLocationLabel(po) === null);
  check("classification: provider-only id keyed by entity id", po.id === `provider:${PROVIDER_ONLY_A}`);

  // ---- locations (explicit park+UUID table only) ----
  {
    const DRUM_CORPS = "bc2c2ffe-3cf0-4e75-a408-bf5e86515c4c"; // hs → Toy Story Land (no venue)
    const MEET_ARIEL = "c113b1cf-7b6d-416a-8e21-bf8f387ecd77"; // hs → Animation Courtyard · Walt Disney Presents
    const loc = buildParkAllEntertainment("hs", live([
      entry(DRUM_CORPS, "Green Army Drum Corps", [st("2026-10-01T20:00:00-04:00")]),
      entry(MEET_ARIEL, "Meet Ariel", [st("2026-10-01T20:30:00-04:00")]),
      entry(PROVIDER_ONLY_A, "Not Listed", [st("2026-10-01T20:15:00-04:00")]),
    ]), NOW);
    const drum = loc.entries.find((e) => e.id === `provider:${DRUM_CORPS}`)!;
    const ariel = loc.entries.find((e) => e.id === `provider:${MEET_ARIEL}`)!;
    const unlisted = loc.entries.find((e) => e.id === `provider:${PROVIDER_ONLY_A}`)!;
    check("locations: listed provider-only gets land; source stays provider_only", drum.land === "Toy Story Land" && drum.venue === null && drum.source === "provider_only");
    check("locations: land + venue label 'Land · Venue'", ariel.venue === "Walt Disney Presents" && allEntryLocationLabel(ariel) === "Animation Courtyard · Walt Disney Presents");
    check("locations: land alone when venue unknown", allEntryLocationLabel(drum) === "Toy Story Land");
    check("locations: unknown location → no label, no land", allEntryLocationLabel(unlisted) === null && unlisted.land === null);
    check("locations: lands list includes verified provider-only lands", allEntertainmentLands(loc.entries).join() === "Animation Courtyard,Toy Story Land");
    check("filter: verified provider-only land selectable", filterAllEntertainment(loc.entries, { land: "Toy Story Land" }).map((e) => e.id).join() === drum.id);
    check("filter: unknown locations stay visible under All Lands only", filterAllEntertainment(loc.entries, {}).includes(unlisted) && !filterAllEntertainment(loc.entries, { land: "Toy Story Land" }).includes(unlisted));
    // park-qualified: the same UUID in another park's payload resolves to nothing
    const wrongPark = buildParkAllEntertainment("mk", { ...live([entry(DRUM_CORPS, "Green Army Drum Corps", [], { parkId: THEMEPARKS_PARKS.mk.entityId })]) }, NOW);
    check("locations: park-qualified uuid match (hs id in mk → unknown)", wrongPark.entries.length === 1 && wrongPark.entries[0].land === null);
    // curated entries never take their land from the provider-location table
    check("locations: curated land comes from the catalog", fant.land === "Sunset Boulevard");
  }

  // ---- performance-type filtering / no fabricated times ----
  const meet = byName(base, "Meet a Character")!;
  check("types: 'Operating' hours are not performances (none posted, nothing fabricated)", meet.showtime.performances.length === 0 && meet.showtime.status === "none_posted");
  {
    const r = buildParkAllEntertainment("hs", live([entry(PROVIDER_ONLY_A, "P", [st("2026-10-01T20:00:00-04:00", "Mystery Type")])]), NOW);
    const e = r.entries[0].showtime;
    check("uncertainty: unrecognized type → incomplete, unavailable when nothing else", e.incomplete && e.status === "unavailable" && e.performances.length === 0);
    const d = buildParkAllEntertainment("hs", live([entry(PROVIDER_ONLY_A, "P", [st("2026-10-01T20:00:00-04:00")], { droppedShowtimes: 1 })]), NOW).entries[0].showtime;
    check("uncertainty: dropped showtimes → incomplete but known time kept", d.incomplete && d.status === "upcoming" && d.performances.length === 1);
    check("uncertainty: partial flag on upcoming incomplete view", allEntryViewAt(buildParkAllEntertainment("hs", live([entry(PROVIDER_ONLY_A, "P", [st("2026-10-01T20:00:00-04:00")], { droppedShowtimes: 1 })]), NOW).entries[0], NOW).partial);
    const stale = buildParkAllEntertainment("hs", live([entry(PROVIDER_ONLY_A, "P", [])], "stale"), NOW);
    check("uncertainty: stale-if-error flagged", stale.stale && stale.meta?.origin === "stale");
    const prevDay = buildParkAllEntertainment("hs", live([entry(PROVIDER_ONLY_A, "P", [st("2026-10-01T20:00:00-04:00")])], "network", new Date("2026-09-30T19:00:00Z").getTime()), NOW);
    check("uncertainty: payload fetched a previous day → incomplete", prevDay.entries[0].showtime.incomplete);
    const nextDay = allEntertainmentForDisplay(base, new Date("2026-10-02T12:00:00Z"));
    check("uncertainty: previous-day data degrades to unavailable (no entries)", !!nextDay && nextDay.entries.length === 0 && nextDay.error !== null);
    check("uncertainty: same-day data untouched", allEntertainmentForDisplay(base, NOW) === base);
    check("uncertainty: failed/foreign response degrades", resolveAllEntertainmentResponse("hs", null, NOW).error !== null && resolveAllEntertainmentResponse("hs", { parkId: "mk", entries: [], localDate: "x" }, NOW).error !== null);
  }

  // ---- time progression (collapsed line == Waits & Shows) ----
  {
    const v0 = allEntryViewAt(fant, NOW);
    check("progression: collapsed shows only upcoming times", v0.status === "upcoming" && v0.collapsedText === "7:30 PM • 9:00 PM");
    const ws = entryDisplayAt(fant.showtime, NOW);
    check("progression: collapsed text identical to Waits & Shows", v0.collapsedText === ws.remaining.map((p) => p.localTime).join(" • "));
    const later = new Date("2026-10-01T23:30:00Z"); // 7:30 PM EDT: 7:30 show starts → not passed (no end → passed only after start)
    check("progression: start instant still counts until it passes", allEntryViewAt(fant, new Date("2026-10-01T23:30:00Z")).collapsedText === "7:30 PM • 9:00 PM");
    check("progression: advances after a time passes", allEntryViewAt(fant, new Date(later.getTime() + 60_000)).collapsedText === "9:00 PM");
    check("progression: all passed → message", allEntryViewAt(fant, new Date("2026-10-02T02:00:00Z")).collapsedText === SHOWTIME_STATUS_MESSAGES.all_passed);
    const inProg = buildParkAllEntertainment("hs", live([entry(PROVIDER_ONLY_A, "P", [st("2026-10-01T14:30:00-04:00", "Performance Time", "2026-10-01T15:30:00-04:00")])]), NOW).entries[0];
    check("progression: in-progress performance stays listed", allEntryViewAt(inProg, NOW).collapsedText === "2:30 PM");
  }

  // ---- expansion ----
  {
    const v = allEntryViewAt(fant, NOW);
    check("expansion: full schedule incl. passed, flagged", v.times.map((t) => `${t.localTime}${t.passed ? "*" : ""}`).join() === "10:00 AM*,7:30 PM,9:00 PM");
    check("expansion: expandable only when passed times are hidden", v.expandable && !allEntryViewAt(po, NOW).expandable && !allEntryViewAt(meet, NOW).expandable);
    check("expansion: all-passed entry expandable", allEntryViewAt(fant, new Date("2026-10-02T02:00:00Z")).expandable);
    let ex: ReadonlySet<string> = new Set();
    ex = toggleExpanded(ex, fant.id);
    check("expansion: toggle on", ex.has(fant.id));
    const refreshed = buildParkAllEntertainment("hs", live([entry(FANTASMIC_HS, "x", [st("2026-10-01T10:00:00-04:00"), st("2026-10-01T19:30:00-04:00")])]), new Date(NOW.getTime() + 120_000));
    check("expansion: persists across refreshed data (stable id)", ex.has(refreshed.entries[0].id));
    check("expansion: toggle off", !toggleExpanded(ex, fant.id).has(fant.id) && ex.has(fant.id));
  }

  // ---- sorting ----
  {
    const sorted = sortAllEntertainment(base.entries, NOW).map((e) => e.name);
    check("sorting: by next showtime, then none-upcoming", sorted.join() === "Fantasmic!,Provider Street Band,Meet a Character");
    const early = buildParkAllEntertainment("hs", live([
      entry(PROVIDER_ONLY_A, "Zed", [st("2026-10-01T16:00:00-04:00")]),
      entry(PROVIDER_ONLY_B, "Alpha", [st("2026-10-01T18:00:00-04:00")]),
      entry(FANTASMIC_HS, "x", [st("2026-10-01T10:00:00-04:00")]),
    ]), NOW);
    check("sorting: earliest next time first; all-passed after upcoming", sortAllEntertainment(early.entries, NOW).map((e) => e.name).join() === "Zed,Alpha,Fantasmic!");
    check("sorting: re-sorts as time advances", sortAllEntertainment(early.entries, new Date("2026-10-01T21:00:00Z")).map((e) => e.name).join() === "Alpha,Fantasmic!,Zed");
  }

  // ---- filtering ----
  {
    const land = fant.land!;
    check("filtering: land keeps matching entries only", filterAllEntertainment(base.entries, { land }).every((e) => e.land === land) && filterAllEntertainment(base.entries, { land }).length === 1);
    check("filtering: land excludes unknown-location provider-only entries", !filterAllEntertainment(base.entries, { land }).some((e) => e.source === "provider_only"));
    check("filtering: lands list = known lands only", allEntertainmentLands(base.entries).join() === land);
    const closed = buildParkAllEntertainment("hs", live([entry(PROVIDER_ONLY_A, "Closed One", [], { status: "CLOSED" }), entry(PROVIDER_ONLY_B, "Open One", [])]), NOW);
    check("filtering: operating-only keeps OPERATING only", filterAllEntertainment(closed.entries, { operatingOnly: true }).map((e) => e.name).join() === "Open One");
    check("filtering: no filters keeps all", filterAllEntertainment(base.entries, {}).length === base.entries.length);
  }

  // ---- accessibility ----
  {
    const ids = ["curated:hs:Fantasmic!", "curated:mk:Happily Ever After", "curated:mk:Happily_Ever After", "provider:abc"].map(showtimesRegionId);
    check("a11y: region id has no whitespace and only id-safe chars", ids.every((i) => /^[A-Za-z0-9_-]+$/.test(i)));
    check("a11y: region id is deterministic and unique per entry id", showtimesRegionId("curated:hs:Fantasmic!") === ids[0] && new Set(ids).size === ids.length);
    check("a11y: every inventory entry yields a whitespace-free id", base.entries.every((e) => !/\s/.test(showtimesRegionId(e.id))));
  }

  // ---- Waits & Shows link ----
  {
    check("link: shown even when the land filter leaves no curated shows", waitsEntertainmentSectionState(0).showLink);
    check("link: no empty curated grid when nothing is visible", !waitsEntertainmentSectionState(0).showGrid && waitsEntertainmentSectionState(3).showGrid && waitsEntertainmentSectionState(3).showLink);
    check("link: carries the selected park", allEntertainmentHref("epcot") === "/entertainment/all?park=epcot");
  }

  // ---- attribution ----
  check("attribution: owed when inventory presented", allEntertainmentPresentsProviderData(base));
  check("attribution: owed for a successful valid-empty response", allEntertainmentPresentsProviderData(buildParkAllEntertainment("hs", live([]), NOW)));
  check("attribution: not owed on failed request / null / previous-day degrade",
    !allEntertainmentPresentsProviderData(buildParkAllEntertainment("hs", { ok: false, error: { kind: "network", message: "n" } }, NOW)) &&
    !allEntertainmentPresentsProviderData(null) &&
    !allEntertainmentPresentsProviderData(allEntertainmentForDisplay(base, new Date("2026-10-02T12:00:00Z"))) &&
    !allEntertainmentPresentsProviderData(resolveAllEntertainmentResponse("hs", null, NOW)));

  // ---- stale empty inventory ----
  {
    const staleEmpty = buildParkAllEntertainment("hs", live([], "stale"), NOW);
    const s = allEntertainmentEmptyState(staleEmpty);
    check("stale-empty: complete-empty shows empty message with stale warning", !!s && s.stale && s.message === INVENTORY_EMPTY_MESSAGE);
    const staleIncomplete = (() => {
      const r = live([], "stale") as Extract<ThemeParksResult<ThemeParksLive>, { ok: true }>;
      return buildParkAllEntertainment("hs", { ...r, data: { ...r.data, droppedEntries: 1 } }, NOW);
    })();
    const si = allEntertainmentEmptyState(staleIncomplete);
    check("stale-empty: incomplete-empty shows incomplete message with stale warning", !!si && si.stale && si.message === INVENTORY_INCOMPLETE_EMPTY_MESSAGE);
    const fresh = allEntertainmentEmptyState(buildParkAllEntertainment("hs", live([]), NOW));
    check("stale-empty: fresh empty has no stale warning", !!fresh && !fresh.stale && fresh.message === INVENTORY_EMPTY_MESSAGE);
    check("stale-empty: stale attribution still owed", allEntertainmentPresentsProviderData(staleEmpty) && allEntertainmentPresentsProviderData(staleIncomplete));
    check("stale-empty: provider failure / null / populated → no empty state", allEntertainmentEmptyState(buildParkAllEntertainment("hs", { ok: false, error: { kind: "network", message: "n" } }, NOW)) === null && allEntertainmentEmptyState(null) === null && allEntertainmentEmptyState(buildParkAllEntertainment("hs", live([entry(PROVIDER_ONLY_A, "P", [])], "stale"), NOW)) === null);
  }

  // ---- incomplete inventory (droppedEntries) ----
  {
    const withDropped = (entries: ReturnType<typeof entry>[], droppedEntries: number): ThemeParksResult<ThemeParksLive> => {
      const r = live(entries) as Extract<ThemeParksResult<ThemeParksLive>, { ok: true }>;
      return { ...r, data: { ...r.data, droppedEntries } };
    };
    const kept = buildParkAllEntertainment("hs", withDropped([entry(PROVIDER_ONLY_A, "Kept Show", [st("2026-10-01T20:00:00-04:00")])], 2), NOW);
    check("incomplete: dropped entries flag the inventory", kept.inventoryIncomplete && allEntertainmentIsIncomplete(kept));
    check("incomplete: valid entries and their showtimes preserved (nothing fabricated)", kept.entries.length === 1 && kept.entries[0].showtime.performances.length === 1);
    const emptyIncomplete = buildParkAllEntertainment("hs", withDropped([], 1), NOW);
    check("incomplete: empty + dropped is incomplete-empty (not valid-empty)", emptyIncomplete.entries.length === 0 && allEntertainmentIsIncomplete(emptyIncomplete));
    const validEmpty = buildParkAllEntertainment("hs", live([]), NOW);
    check("incomplete: valid-empty is complete", !validEmpty.inventoryIncomplete && !allEntertainmentIsIncomplete(validEmpty));
    check("incomplete: clean payload with entries is complete", !base.inventoryIncomplete);
    check("incomplete: failure is an error, not 'incomplete'", !buildParkAllEntertainment("hs", { ok: false, error: { kind: "network", message: "n" } }, NOW).inventoryIncomplete);
    check("incomplete: both incomplete states still owe attribution", allEntertainmentPresentsProviderData(emptyIncomplete) && allEntertainmentPresentsProviderData(kept));
    check("incomplete: older body without the field is treated as complete", !allEntertainmentIsIncomplete({ ...validEmpty, inventoryIncomplete: undefined } as unknown as ParkAllEntertainment));
  }
  // ---- operating hours (Phase 12.12) ----
  {
    const HOURS = "Operating hours: 9:00 AM–5:00 PM";
    const op = (a: string, b: string | null) => st(a, "Operating", b);
    const one = (shows: ThemeParksShowtime[], over: Partial<ThemeParksLive["entries"][number]> = {}, res = live([entry(PROVIDER_ONLY_A, "P", shows, over)]), at = NOW) => {
      const e = buildParkAllEntertainment("hs", res, at).entries[0];
      return { e, v: allEntryViewAt(e, at) };
    };
    const only = one([op("2026-10-01T09:00:00-04:00", "2026-10-01T17:00:00-04:00")]);
    check("hours: operating-only replaces 'No showtimes posted'", only.v.status === "none_posted" && only.v.collapsedText === null && only.v.hoursText === HOURS && only.e.showtime.performances.length === 0);
    check("hours: operating-only keeps none_posted sort rank (sorting unchanged)", sortAllEntertainment(buildParkAllEntertainment("hs", live([entry(PROVIDER_ONLY_A, "A Hours Only", [op("2026-10-01T09:00:00-04:00", "2026-10-01T17:00:00-04:00")]), entry(PROVIDER_ONLY_B, "B Plain", [])]), NOW).entries, NOW).map((x) => x.name).join() === "A Hours Only,B Plain");
    const none = one([]);
    check("hours: none published → 'No showtimes posted' unchanged, no hours line", none.v.collapsedText === SHOWTIME_STATUS_MESSAGES.none_posted && none.v.hoursText === null);
    const mixed = one([st("2026-10-01T20:00:00-04:00"), op("2026-10-01T09:00:00-04:00", "2026-10-01T17:00:00-04:00")]);
    check("hours: mixed → performances first, hours second", mixed.v.status === "upcoming" && mixed.v.collapsedText === "8:00 PM" && mixed.v.hoursText === HOURS && mixed.e.showtime.performances.length === 1);
    const closed = one([st("2026-10-01T20:00:00-04:00"), op("2026-10-01T09:00:00-04:00", "2026-10-01T17:00:00-04:00")], { status: "CLOSED" });
    check("hours: provider CLOSED still keeps upcoming performances", closed.v.status === "upcoming" && closed.v.collapsedText === "8:00 PM" && allEntryProviderStatus(closed.e) === "CLOSED");
    const passed = allEntryViewAt(mixed.e, new Date("2026-10-02T02:00:00Z"));
    check("hours: all-passed message kept (only none_posted is replaced)", passed.collapsedText === SHOWTIME_STATUS_MESSAGES.all_passed && passed.hoursText === HOURS);
    const unavailable = one([op("2026-10-01T09:00:00-04:00", "2026-10-01T17:00:00-04:00"), st("2026-10-01T20:00:00-04:00", "Mystery Type")]);
    check("hours: unavailable message kept alongside hours", unavailable.v.status === "unavailable" && unavailable.v.collapsedText === SHOWTIME_STATUS_MESSAGES.unavailable && unavailable.v.hoursText === HOURS);
    check("hours: curated entry uses its mapped refs", buildParkAllEntertainment("hs", live([entry(FANTASMIC_HS, "x", [op("2026-10-01T09:00:00-04:00", "2026-10-01T17:00:00-04:00")])]), NOW).entries[0].operatingHours?.[0].label === "9:00 AM–5:00 PM");

    // invalid / incomplete intervals are never displayed or guessed
    check("hours: missing end dropped", one([op("2026-10-01T09:00:00-04:00", null)]).v.hoursText === null);
    check("hours: unparseable start/end dropped", one([op("garbage", "2026-10-01T17:00:00-04:00"), op("2026-10-01T09:00:00-04:00", "garbage")]).v.hoursText === null);
    check("hours: reversed and zero-length dropped", one([op("2026-10-01T17:00:00-04:00", "2026-10-01T09:00:00-04:00"), op("2026-10-01T09:00:00-04:00", "2026-10-01T09:00:00-04:00")]).v.hoursText === null);
    check("hours: >24h interval dropped as invalid", one([op("2026-10-01T09:00:00-04:00", "2026-10-02T09:00:01-04:00")]).v.hoursText === null);
    check("hours: other days ignored (resort-local start)", one([op("2026-09-30T09:00:00-04:00", "2026-09-30T17:00:00-04:00"), op("2026-10-02T09:00:00-04:00", "2026-10-02T17:00:00-04:00")]).v.hoursText === null);
    check("hours: unrecognized/performance types never become hours", one([st("2026-10-01T09:00:00-04:00", "Performance Time", "2026-10-01T17:00:00-04:00"), st("2026-10-01T09:00:00-04:00", "Mystery Type", "2026-10-01T17:00:00-04:00")]).v.hoursText === null);

    // dedupe / merge
    const dup = one([op("2026-10-01T09:00:00-04:00", "2026-10-01T17:00:00-04:00"), op("2026-10-01T13:00:00Z", "2026-10-01T21:00:00Z")]);
    check("hours: duplicate (same instants, different offsets) collapses", dup.v.hoursText === HOURS);
    const ov = one([op("2026-10-01T09:00:00-04:00", "2026-10-01T13:00:00-04:00"), op("2026-10-01T12:00:00-04:00", "2026-10-01T17:00:00-04:00")]);
    check("hours: overlapping intervals merge", ov.v.hoursText === HOURS);
    const two = one([op("2026-10-01T17:00:00-04:00", "2026-10-01T21:00:00-04:00"), op("2026-10-01T09:00:00-04:00", "2026-10-01T13:00:00-04:00")]);
    check("hours: separate intervals sorted and comma-joined", two.v.hoursText === "Operating hours: 9:00 AM–1:00 PM, 5:00 PM–9:00 PM");

    // overnight + resort-local day (UTC date differs) + DST
    const night = one([op("2026-10-01T21:00:00-04:00", "2026-10-02T01:00:00-04:00")]);
    check("hours: overnight span labelled next day", night.v.hoursText === "Operating hours: 9:00 PM–1:00 AM (next day)");
    const utcTrap = one([op("2026-10-02T02:00:00Z", "2026-10-02T03:30:00Z")]); // 10 PM–11:30 PM EDT Oct 1 (UTC says Oct 2)
    check("hours: resort-local date decides, not UTC", utcTrap.v.hoursText === "Operating hours: 10:00 PM–11:30 PM");
    const dlr = buildParkAllEntertainment("disneyland", { ok: true, data: { entityId: "p", name: "p", timeZone: null, entries: [entry(PROVIDER_ONLY_A, "P", [op("2026-10-01T08:00:00-07:00", "2026-10-01T22:00:00-07:00")], { parkId: THEMEPARKS_PARKS.disneyland.entityId })], droppedEntries: 0, droppedShowtimes: 0 }, meta: { origin: "network", fetchedAt: new Date("2026-10-01T20:00:00Z").getTime(), etag: null } }, new Date("2026-10-01T20:00:00Z"));
    check("hours: DLR formatted in PDT", allEntryViewAt(dlr.entries[0], new Date("2026-10-01T20:00:00Z")).hoursText === "Operating hours: 8:00 AM–10:00 PM");
    // DST fall-back 2026-11-01 (WDW): 1:00 AM EDT → 1:00 AM EST repeats; 9 AM–5 PM EST is 8 elapsed hours
    const dstNow = new Date("2026-11-01T17:00:00Z");
    const dst = one([op("2026-11-01T09:00:00-05:00", "2026-11-01T17:00:00-05:00")], {}, live([entry(PROVIDER_ONLY_A, "P", [op("2026-11-01T09:00:00-05:00", "2026-11-01T17:00:00-05:00")])], "network", dstNow.getTime()), dstNow);
    check("hours: DST fall-back day shows EST wall times", dst.v.hoursText === HOURS);
    const dstNight = one([op("2026-11-01T00:00:00-04:00", "2026-11-01T03:00:00-05:00")], {}, live([entry(PROVIDER_ONLY_A, "P", [op("2026-11-01T00:00:00-04:00", "2026-11-01T03:00:00-05:00")])], "network", dstNow.getTime()), dstNow);
    check("hours: span across the repeated hour keeps real elapsed time", dstNight.v.hoursText === "Operating hours: 12:00 AM–3:00 AM");

    // stale / previous-day payloads
    const staleSame = one([op("2026-10-01T09:00:00-04:00", "2026-10-01T17:00:00-04:00")], {}, live([entry(PROVIDER_ONLY_A, "P", [op("2026-10-01T09:00:00-04:00", "2026-10-01T17:00:00-04:00")])], "stale"));
    check("hours: same-day stale-if-error still shows hours (page flags it stale)", staleSame.v.hoursText === HOURS && buildParkAllEntertainment("hs", live([], "stale"), NOW).stale);
    const prev = one([op("2026-10-01T09:00:00-04:00", "2026-10-01T17:00:00-04:00")], {}, live([entry(PROVIDER_ONLY_A, "P", [op("2026-10-01T09:00:00-04:00", "2026-10-01T17:00:00-04:00")])], "network", new Date("2026-09-30T19:00:00Z").getTime()));
    check("hours: previous-day payload cannot vouch for today's hours", prev.v.hoursText === null);
    const nextDay = allEntertainmentForDisplay(buildParkAllEntertainment("hs", live([entry(PROVIDER_ONLY_A, "P", [op("2026-10-01T09:00:00-04:00", "2026-10-01T17:00:00-04:00")])]), NOW), new Date("2026-10-02T12:00:00Z"));
    check("hours: resort-local rollover drops yesterday's hours with the entries", !!nextDay && nextDay.entries.length === 0);
    check("hours: provider failure → no hours fabricated", buildParkAllEntertainment("hs", { ok: false, error: { kind: "timeout", message: "t" } }, NOW).entries.length === 0);
    check("hours: older body without the field renders no hours line", allEntryViewAt({ ...only.e, operatingHours: undefined }, NOW).hoursText === null);

    // curated API untouched
    check("hours: curated showtimes entry shape unchanged (no hours field)", !("operatingHours" in only.e.showtime) && !("operatingHours" in normalizeParkEntertainmentShowtimes("hs", live([entry(FANTASMIC_HS, "x", [op("2026-10-01T09:00:00-04:00", "2026-10-01T17:00:00-04:00")])]), NOW).entries[0]));
  }
  // ---- card layout (hours-only must not open an empty showtimes container) ----
  {
    const H = [st("2026-10-01T09:00:00-04:00", "Operating", "2026-10-01T17:00:00-04:00")];
    const lay = (shows: ThemeParksShowtime[], expanded: boolean, stale: boolean) => {
      const e = buildParkAllEntertainment("hs", live([entry(PROVIDER_ONLY_A, "P", shows)]), NOW).entries[0];
      const v = allEntryViewAt(e, NOW);
      return { v, l: allEntryLayout(v, expanded, stale) };
    };
    const ho = lay(H, false, true);
    check("layout: hours-only → no showtimes container, stale beside hours", !!ho.v.hoursText && !ho.l.showShowtimes && !ho.l.showtimesStale && ho.l.hoursStale);
    check("layout: hours-only not-stale → no stale anywhere", !lay(H, false, false).l.hoursStale && !lay(H, false, false).l.showtimesStale);
    check("layout: hours-only expanded still no container", !lay(H, true, true).l.showShowtimes);
    const mx = lay([st("2026-10-01T20:00:00-04:00"), ...H], false, true);
    check("layout: mixed → showtimes container, stale on showtimes line only", mx.l.showShowtimes && mx.l.showtimesStale && !mx.l.hoursStale && !!mx.v.hoursText);
    const none = lay([], false, true);
    check("layout: none posted without hours keeps message container + stale", none.l.showShowtimes && none.l.showtimesStale && !none.l.hoursStale);
    const done = allEntryLayout(allEntryViewAt(buildParkAllEntertainment("hs", live([entry(PROVIDER_ONLY_A, "P", [st("2026-10-01T10:00:00-04:00"), ...H])]), NOW).entries[0], NOW), true, false);
    check("layout: expanded schedule shows full list", done.showFull && done.showShowtimes);
  }
  check("copy: partial note constant reused", PARTIAL_SHOWTIMES_NOTE === "More showtimes may be unavailable");

  return failures;
}

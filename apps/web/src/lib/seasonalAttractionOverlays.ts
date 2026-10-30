/**
 * seasonalAttractionOverlays.ts — Phase 14.3 date-aware seasonal attraction
 * DISPLAY names (dataset + pure resolver).
 *
 * An overlay is a seasonal display name for ONE canonical attraction (e.g.
 * "Haunted Mansion Holiday" for `dl-haunted-mansion`). It is never a separate
 * identity: planner/Lightning/sync/import/export keep resolving the canonical
 * name, the alias maps in liveWaitApi.ts / plansMatching.ts keep folding every
 * provider spelling into that one identity, and nothing here can change a
 * ride's status, wait time or closure handling — the result is a presentation
 * string only (`AttractionWait.displayName`).
 *
 * Kept separate from seasonalEventData.ts (events are metadata, not ride
 * names). Dates are plain resort-local "YYYY-MM-DD" (resortTime.ts); string
 * comparison is correct across year boundaries, and `seasonYear` is the year
 * the season BEGINS (matching seasonalEventData.ts).
 *
 * Data rules
 *   - startDate/endDate only from official Disney sources; unverified is
 *     `null`, never guessed or extrapolated. Each record carries its source
 *     and verification date. Past seasons stay as verified history.
 *   - Shared Queue-Times/DWP alias maps remain the identity authority; this
 *     file only decides which name to SHOW.
 *
 * Display priority (see resolveAttractionDisplayName)
 *   1. today inside confirmed [start, end]            → overlay name
 *   2. confirmed start, no end (today >= start)       → follow the selected
 *      Queue-Times row's name (may switch back and forth)
 *   3. today after confirmed end / before confirmed start → canonical
 *   4. no confirmed dates                             → follow the selected
 *      provider row's name; with no provider evidence → canonical
 *   5. `timeSpecific` variants                        → overlay ONLY when the
 *      selected provider row carries that name; dates never decide
 *   6. "selected row" is whatever freshest-row selection already chose in
 *      liveWaitApi.ts; this module only reads its name
 *
 * DEV checks: `runDevSeasonalAttractionOverlayCases()` (run manually).
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { isValidIsoCalendarDate } from "./plannerWarnings";
import { getResortLocalDate } from "./resortTime";

export type SeasonalAttractionOverlay = {
  /** Stable, never-reused identifier. */
  id: string;
  /** `AttractionWait.id` of the ONE canonical attraction this names. */
  canonicalId: string;
  resort: ResortId;
  parkId: ParkId;
  /** Official seasonal display name. */
  overlayName: string;
  /** Year the season begins (a Nov 2026–Jan 2027 overlay is 2026). */
  seasonYear: number;
  /** Confirmed first day (resort-local) or null when not officially confirmed. */
  startDate: string | null;
  /** Confirmed last day (resort-local) or null when not officially confirmed. */
  endDate: string | null;
  /**
   * Time-of-day variant (not a date-range overlay): shown only when the
   * selected provider row confirms it. Dates never trigger it.
   */
  timeSpecific?: true;
  sourceUrl: string;
  /** Publication date of that source (YYYY-MM-DD) when stated by it. */
  sourcePublishedDate?: string;
  /** Date the maintainer verified the record against `sourceUrl`. */
  verifiedOn: string;
  note?: string;
};

const DL = "https://disneyland.disney.go.com/attractions";
const PRESS = "https://disneyexperiences.com/disneyland-press/release";
const V = "2026-10-30";

export const SEASONAL_ATTRACTION_OVERLAYS: SeasonalAttractionOverlay[] = [
  {
    id: "dl-haunted-mansion-holiday-2026", canonicalId: "dl-haunted-mansion", resort: "DLR", parkId: "disneyland",
    overlayName: "Haunted Mansion Holiday", seasonYear: 2026, startDate: "2026-08-21", endDate: null,
    sourceUrl: `${DL}/disneyland/haunted-mansion-holiday/`, verifiedOn: V,
    note: 'Official page: "scheduled to return August 21, 2026". Runs into the holidays but no official per-attraction end date was found (resort holidays end 2027-01-06); end left null.',
  },
  {
    id: "dl-small-world-holiday-2026", canonicalId: "dl-its-a-small-world", resort: "DLR", parkId: "disneyland",
    overlayName: "\"it's a small world\" Holiday", seasonYear: 2026, startDate: "2026-11-13", endDate: null,
    sourceUrl: `${DL}/disneyland/its-a-small-world-holiday/`, verifiedOn: V,
    note: 'Official page: "returning November 13, 2026"; no end date given. Magic Kingdom\'s small world has no overlay.',
  },
  {
    id: "dca-luigis-haul-o-ween-2026", canonicalId: "dca-luigis", resort: "DLR", parkId: "dca",
    overlayName: "Luigi's Honkin' Haul-O-Ween", seasonYear: 2026, startDate: "2026-08-21", endDate: "2026-10-31",
    sourceUrl: `${PRESS}/haul-o-ween-at-cars-land-fun-facts/`, sourcePublishedDate: "2026-08-21", verifiedOn: V,
    note: "Press release describes the overlay as part of Halloween Time, Aug. 21–Oct. 31, 2026; the attraction page itself lists no dates.",
  },
  {
    id: "dca-luigis-joy-to-the-whirl-2026", canonicalId: "dca-luigis", resort: "DLR", parkId: "dca",
    overlayName: "Luigi's Joy to the Whirl", seasonYear: 2026, startDate: "2026-11-13", endDate: null,
    sourceUrl: `${DL}/disney-california-adventure/luigis-joy-whirl/`, verifiedOn: V,
    note: 'Official page: "returning November 13, 2026"; no end date given. (A search snippet showed Nov 18 — the fetched page says Nov 13, matching Holidays at the Disneyland Resort.)',
  },
  {
    id: "dca-maters-graveyard-jamboree-2026", canonicalId: "dca-maters", resort: "DLR", parkId: "dca",
    overlayName: "Mater's Graveyard JamBOOree", seasonYear: 2026, startDate: "2026-08-21", endDate: "2026-10-31",
    sourceUrl: `${PRESS}/haul-o-ween-at-cars-land-fun-facts/`, sourcePublishedDate: "2026-08-21", verifiedOn: V,
    note: "Same press release as Luigi's Haul-O-Ween (Halloween Time, Aug. 21–Oct. 31, 2026).",
  },
  {
    id: "dca-maters-jingle-jamboree-2026", canonicalId: "dca-maters", resort: "DLR", parkId: "dca",
    overlayName: "Mater's Jingle Jamboree", seasonYear: 2026, startDate: "2026-11-13", endDate: null,
    sourceUrl: `${DL}/disney-california-adventure/maters-jingle-jamboree/`, verifiedOn: V,
    note: 'Official page: "returning November 13, 2026"; no end date given.',
  },
  {
    id: "epcot-glimmering-greenhouses-2026", canonicalId: "epcot-living-with-the-land", resort: "WDW", parkId: "epcot",
    overlayName: "Living with the Land – Glimmering Greenhouses", seasonYear: 2026, startDate: null, endDate: null,
    sourceUrl: "https://disneyworld.disney.go.com/attractions/epcot/glimmering-greenhouses/", verifiedOn: V,
    note: "No official ride-overlay dates found (festival is 2026-11-27–12-30, but the overlay appeared early in 2025); dates null so display follows Queue-Times.",
  },
  {
    id: "dca-guardians-monsters-after-dark-2026", canonicalId: "dca-guardians", resort: "DLR", parkId: "dca",
    overlayName: "Guardians of the Galaxy – Monsters After Dark", seasonYear: 2026, startDate: null, endDate: null, timeSpecific: true,
    sourceUrl: `${PRESS}/guardians-of-the-galaxy-monsters-after-dark/`, sourcePublishedDate: "2026-08-21", verifiedOn: V,
    note: 'Halloween Time (Aug. 21–Oct. 31, 2026) overlay that begins "in the late afternoon each day" — no fixed time, so provider-confirmed only. Queue-Times publishes it as a SEPARATE row (id 5146); it is deliberately NOT aliased in liveWaitApi.ts (see report), so this record is inert until that is approved.',
  },
];

// ── Lookup ──────────────────────────────────────────────────────────────

export function getOverlaysForAttraction(canonicalId: string): SeasonalAttractionOverlay[] {
  return SEASONAL_ATTRACTION_OVERLAYS.filter((o) => o.canonicalId === canonicalId);
}

/** Verified history: every recorded season for an attraction, newest first. */
export function listOverlaySeasons(canonicalId: string): SeasonalAttractionOverlay[] {
  return getOverlaysForAttraction(canonicalId).sort((a, b) => b.seasonYear - a.seasonYear);
}

/**
 * Comparison key for a provider/overlay name: lowercased, dashes folded,
 * quotes/apostrophes and spacing ignored — so Queue-Times' quoted vs unquoted
 * `"it's a small world" Holiday` and en-dash vs hyphen both match. Used only
 * to compare names for DISPLAY; identity still goes through the alias maps.
 */
export function overlayNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type OverlayWindow = "inside" | "open" | "outside";

/**
 * Where `today` sits relative to the CONFIRMED dates only.
 *   inside  — both dates known and today within [start, end]
 *   open    — an unknown boundary leaves the overlay possible (start known and
 *             reached with no end, or no start and not past a known end)
 *   outside — before a confirmed start, or after a confirmed end
 */
function windowFor(o: SeasonalAttractionOverlay, today: string): OverlayWindow {
  if (o.startDate && today < o.startDate) return "outside";
  if (o.endDate && today > o.endDate) return "outside";
  return o.startDate && o.endDate ? "inside" : "open";
}

export type DisplayNameInput = {
  canonicalId: string;
  /** Resort-local "YYYY-MM-DD" for "today". */
  today: string;
  /**
   * Raw name of the provider row ALREADY selected for this attraction by the
   * existing freshest-row logic, or undefined with no provider evidence.
   */
  selectedProviderName?: string;
};

/**
 * Seasonal display name for the attraction, or null to show the canonical
 * name. Pure; reads nothing but its arguments and the overlay dataset.
 */
export function resolveAttractionDisplayName(input: DisplayNameInput): string | null {
  if (!isValidIsoCalendarDate(input.today)) return null;
  const overlays = getOverlaysForAttraction(input.canonicalId);
  if (overlays.length === 0) return null;
  const providerKey = input.selectedProviderName ? overlayNameKey(input.selectedProviderName) : null;

  // Rule 1 first: a confirmed window beats any provider name.
  for (const o of overlays) {
    if (!o.timeSpecific && windowFor(o, input.today) === "inside") return o.overlayName;
  }
  // Rules 2/4/5: provider-confirmed naming.
  if (providerKey) {
    for (const o of overlays) {
      if (overlayNameKey(o.overlayName) !== providerKey) continue;
      if (o.timeSpecific || windowFor(o, input.today) === "open") return o.overlayName;
    }
  }
  return null; // rules 3/4: canonical
}

/** Convenience for callers holding a resort + instant. */
export function resolveAttractionDisplayNameAt(
  resort: ResortId,
  input: Omit<DisplayNameInput, "today">,
  instant: Date = new Date(),
): string | null {
  return resolveAttractionDisplayName({ ...input, today: getResortLocalDate(resort, instant) });
}

// ── Validation + DEV cases ──────────────────────────────────────────────

export function validateSeasonalAttractionOverlay(o: SeasonalAttractionOverlay): string[] {
  const errs: string[] = [];
  if (!o.id || !o.canonicalId || !o.overlayName) errs.push("missing id/canonicalId/overlayName");
  for (const [k, v] of [["startDate", o.startDate], ["endDate", o.endDate]] as const) {
    if (v !== null && !isValidIsoCalendarDate(v)) errs.push(`${k} invalid`);
  }
  if (o.startDate && o.endDate && o.endDate < o.startDate) errs.push("end before start");
  if (o.startDate && Number(o.startDate.slice(0, 4)) !== o.seasonYear) errs.push("seasonYear != start year");
  if (!/^https:\/\//.test(o.sourceUrl)) errs.push("sourceUrl");
  if (!isValidIsoCalendarDate(o.verifiedOn)) errs.push("verifiedOn");
  return errs;
}

/**
 * DEV checks (not wired into CI; run manually from Node, e.g. via tsx):
 *   import { runDevSeasonalAttractionOverlayCases } from "@/lib/seasonalAttractionOverlays";
 *   console.log(runDevSeasonalAttractionOverlayCases()); // [] when everything passes
 * Wait/status/dedupe preservation cases live next to the Queue-Times cases:
 * `DEV_QUEUE_TIMES_DEDUPE_CASES` in liveWaitApi.ts.
 */
export type DevSeasonalAttractionOverlayCase = { label: string; ok: () => boolean };

const HM = "dl-haunted-mansion";
const SW = "dl-its-a-small-world";
const LUIGI = "dca-luigis";
const GOTG = "dca-guardians";
const LWTL = "epcot-living-with-the-land";
const name = (canonicalId: string, today: string, selectedProviderName?: string) =>
  resolveAttractionDisplayName({ canonicalId, today, selectedProviderName });

export const DEV_SEASONAL_ATTRACTION_OVERLAY_CASES: DevSeasonalAttractionOverlayCase[] = [
  { label: "ids unique", ok: () => new Set(SEASONAL_ATTRACTION_OVERLAYS.map((o) => o.id)).size === SEASONAL_ATTRACTION_OVERLAYS.length },
  { label: "all records valid", ok: () => SEASONAL_ATTRACTION_OVERLAYS.every((o) => validateSeasonalAttractionOverlay(o).length === 0) },
  { label: "validator catches bad record", ok: () => validateSeasonalAttractionOverlay({ ...SEASONAL_ATTRACTION_OVERLAYS[0], startDate: "2026-11-02", endDate: "2026-11-01", sourceUrl: "x" }).length >= 2 },
  { label: "every overlay targets an existing canonical attraction (one identity each)", ok: () => SEASONAL_ATTRACTION_OVERLAYS.every((o) => ["dl-haunted-mansion", "dl-its-a-small-world", "dca-luigis", "dca-maters", "dca-guardians", "epcot-living-with-the-land"].includes(o.canonicalId)) },
  // Rule 1 + date boundaries (closed window: Luigi's Halloween 2026-08-21..2026-10-31)
  { label: "day before confirmed start → canonical", ok: () => name(LUIGI, "2026-08-20", "Luigi's Honkin' Haul-O-Ween") === null },
  { label: "confirmed start day → overlay (regardless of provider name)", ok: () => name(LUIGI, "2026-08-21", "Luigi's Rollickin' Roadsters") === "Luigi's Honkin' Haul-O-Ween" },
  { label: "confirmed end day → overlay", ok: () => name(LUIGI, "2026-10-31") === "Luigi's Honkin' Haul-O-Ween" },
  // Rule 3
  { label: "day after confirmed end → canonical even if provider still says overlay", ok: () => name(LUIGI, "2026-11-01", "Luigi's Honkin' Haul-O-Ween") === null },
  { label: "Halloween→Christmas gap → canonical", ok: () => name(LUIGI, "2026-11-12", "Luigi's Rollickin' Roadsters") === null },
  // Rule 2: unknown end
  { label: "unknown end: before start → canonical", ok: () => name(SW, "2026-11-12", '"it\'s a small world" Holiday') === null },
  { label: "unknown end: start day + provider overlay name → overlay", ok: () => name(SW, "2026-11-13", '"it\'s a small world" Holiday') === '"it\'s a small world" Holiday' },
  { label: "unknown end: provider switches back to canonical → canonical", ok: () => name(SW, "2026-12-01", '"it\'s a small world"') === null },
  { label: "unknown end: provider switches to overlay again → overlay", ok: () => name(SW, "2026-12-02", "it's a small world Holiday") === '"it\'s a small world" Holiday' },
  { label: "unknown end: no provider evidence → canonical", ok: () => name(SW, "2026-12-01") === null },
  { label: "unknown end: far-future date with provider overlay → still follows provider", ok: () => name(SW, "2027-03-01", '"it\'s a small world" Holiday') !== null },
  // Cross-year (Luigi's Joy to the Whirl: start 2026-11-13, season year 2026, crosses into 2027)
  { label: "cross-year: December and January dates resolve in the 2026 season", ok: () => name(LUIGI, "2026-12-25", "Luigi's Joy to the Whirl") === "Luigi's Joy to the Whirl" && name(LUIGI, "2027-01-03", "Luigi's Joy to the Whirl") === "Luigi's Joy to the Whirl" },
  { label: "cross-year: synthetic closed window spans New Year", ok: () => { const o = { ...SEASONAL_ATTRACTION_OVERLAYS[1], startDate: "2026-11-13", endDate: "2027-01-06" }; return windowFor(o, "2026-12-31") === "inside" && windowFor(o, "2027-01-06") === "inside" && windowFor(o, "2027-01-07") === "outside"; } },
  // Rule 4
  { label: "no confirmed dates + provider overlay row → overlay", ok: () => name(LWTL, "2026-11-22", "Living with the Land – Glimmering Greenhouses") === "Living with the Land – Glimmering Greenhouses" },
  { label: "no confirmed dates + hyphen spelling from provider → overlay", ok: () => name(LWTL, "2026-11-22", "Living with the Land - Glimmering Greenhouses") !== null },
  { label: "no confirmed dates + canonical provider row → canonical", ok: () => name(LWTL, "2026-11-22", "Living with the Land") === null },
  { label: "no confirmed dates + no provider evidence → canonical", ok: () => name(LWTL, "2026-11-22") === null },
  // Provider switching with open start (Haunted Mansion Holiday, start 2026-08-21)
  { label: "HMH before start → canonical even if provider overlay", ok: () => name(HM, "2026-08-20", "Haunted Mansion Holiday") === null },
  { label: "HMH after start follows provider overlay and switch back", ok: () => name(HM, "2026-11-01", "Haunted Mansion Holiday") === "Haunted Mansion Holiday" && name(HM, "2026-11-01", "Haunted Mansion") === null },
  // Rule 5
  { label: "time-specific: provider-confirmed → overlay on any date", ok: () => name(GOTG, "2026-10-15", "Guardians of the Galaxy - Monsters After Dark") === "Guardians of the Galaxy – Monsters After Dark" },
  { label: "time-specific: never date-only", ok: () => name(GOTG, "2026-10-15") === null && name(GOTG, "2026-10-15", "Guardians of the Galaxy - Mission: BREAKOUT!") === null },
  // Rule 6/7
  { label: "regular provider row selected inside window still shows overlay (rule 1 beats row choice)", ok: () => name(LUIGI, "2026-09-15", "Luigi's Rollickin' Roadsters") === "Luigi's Honkin' Haul-O-Ween" },
  { label: "overlay of one attraction never leaks to another", ok: () => name(HM, "2026-09-15", "Luigi's Honkin' Haul-O-Ween") === null && name("dl-space-mountain", "2026-09-15", "Space Mountain") === null },
  { label: "invalid date → canonical", ok: () => name(LUIGI, "2026-02-31") === null },
  { label: "verified history lookup newest first", ok: () => listOverlaySeasons(LUIGI).length === 2 && listOverlaySeasons(LUIGI)[0].seasonYear === 2026 },
  { label: "resort-local date: late-evening PT is still that PT date", ok: () => resolveAttractionDisplayNameAt("DLR", { canonicalId: LUIGI }, new Date("2026-11-01T06:30:00Z")) === "Luigi's Honkin' Haul-O-Ween" },
];

export function runDevSeasonalAttractionOverlayCases(): string[] {
  return DEV_SEASONAL_ATTRACTION_OVERLAY_CASES.filter((c) => {
    try { return !c.ok(); } catch { return true; }
  }).map((c) => c.label);
}

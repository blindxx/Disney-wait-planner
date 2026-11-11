/**
 * allEntertainmentEventFilter.ts — Phase 14.4D park-reactive Event filter for
 * the All Entertainment page (pure; never fetches, never reads provider data
 * beyond the entries it is handed).
 *
 * Single source of truth: everything is derived from the maintained registry
 * (seasonalEventData.ts / seasonalEvents.ts) and the explicit curated /
 * provider-only associations (seasonalEntertainment.ts). No show-name guessing,
 * no parallel event table. Narrower offerings (Eat to the Beat, Garden Rocks)
 * are grouped under their parent festival via the registry's `parentEventId`;
 * the association itself still points at the narrow event, so seasonal
 * visibility and its narrower window are untouched.
 *
 * An event is offered for a park when it is a top-level event hosted there AND
 *   - it (or a child offering) has curated/provider-only entertainment at the
 *     park, OR
 *   - the registry has confirmed dates for an in-progress / upcoming season.
 * Events with neither are hidden; a historical season alone never qualifies.
 *
 * Browsing a specific event ignores seasonal hiding (catalog browsing): live
 * entries associated with the event plus synthesized curated records for
 * associated catalog shows absent from the live inventory (status
 * "unavailable"). Provider-only records are only ever the live ones — nothing
 * is fabricated. Times/status on a card remain today's provider data.
 *
 * DEV checks: `runDevAllEntertainmentEventFilterCases()` (run manually from Node).
 */

import type { ParkId } from "@disney-wait-planner/shared";
import type { AllEntertainmentEntry } from "./entertainmentAll";
import { filterAllEntertainment } from "./entertainmentAll";
import { getEntertainmentForPark } from "./entertainmentSuggestions";
import { getResortLocalDate } from "./resortTime";
import { SEASONAL_ENTERTAINMENT_EVENTS, SEASONAL_PROVIDER_ONLY_EVENTS } from "./seasonalEntertainment";
import { SEASONAL_EVENTS, type SeasonalEventDefinition, type SeasonalEventSeasonRecord } from "./seasonalEventData";
import { getSeasonalEvent, getSeasonalEventSeasonStatus, listSeasonalEventSeasons } from "./seasonalEvents";
import { applyAllEntertainmentSeasonalVisibility, getOffSeasonCuratedEntertainment, makeOffSeasonEntry } from "./seasonalVisibility";

/** Filter value meaning "no event filter" (the default). */
export const ALL_ENTERTAINMENT_EVENT_ALL = "";
export const EVENT_NO_ENTERTAINMENT_MESSAGE = "No entertainment currently tracked for this event.";
export const EVENT_INFO_NOTE = "Entertainment shown is associated with this event. Individual performance dates and times may vary.";

/**
 * Short dropdown labels keyed by registry event id (presentation only — ids,
 * dates, associations and the full official names stay in the registry and the
 * information card). Every registry event must have an entry (DEV-checked).
 */
export const EVENT_SHORT_LABELS: Record<string, string> = {
  "mnsshp": "Not-So-Scary Party",
  "mvmcp": "Very Merry Christmas Party",
  "jollywood-nights": "Jollywood Nights",
  "oogie-boogie-bash": "Oogie Boogie Bash",
  "halloween-time-dlr": "Halloween Time",
  "holidays-dlr": "DLR Holidays",
  "holidays-wdw": "WDW Holidays",
  "plaza-de-la-familia": "Plaza de la Familia",
  "lunar-new-year-dca": "Lunar New Year",
  "dca-food-and-wine": "DCA Food & Wine",
  "epcot-festival-of-the-arts": "Festival of the Arts",
  "epcot-flower-and-garden": "Flower & Garden",
  "epcot-food-and-wine": "Food & Wine",
  "epcot-festival-of-the-holidays": "Festival of the Holidays",
  "epcot-eat-to-the-beat": "Eat to the Beat",
};

/** Short label for an event id (full registry name if an id is ever missing from the map). */
export function eventShortLabel(eventId: string): string {
  return EVENT_SHORT_LABELS[eventId] ?? getSeasonalEvent(eventId)?.name ?? eventId;
}
/** Night lists longer than this collapse behind a toggle. */
export const EVENT_NIGHTS_PREVIEW = 6;

export type AllEntertainmentEventOption = { value: string; label: string };

const PROVIDER_ID_PREFIX = "provider:";

function rootEventId(eventId: string): string {
  return getSeasonalEvent(eventId)?.parentEventId ?? eventId;
}

/** Whether the out-of-season checkbox applies (only in the default "All Entertainment" view). */
export function showOutOfSeasonToggle(eventValue: string): boolean {
  return eventValue === ALL_ENTERTAINMENT_EVENT_ALL;
}

/** Whether the "Operating only" checkbox applies (only in the default "All Entertainment" view). */
export function showOperatingOnlyToggle(eventValue: string): boolean {
  return eventValue === ALL_ENTERTAINMENT_EVENT_ALL;
}

/** The page's resettable filter selections (park/resort are deliberately NOT part of it). */
export type AllEntertainmentFilterState = { event: string; land: string; operatingOnly: boolean; showOutOfSeason: boolean };

export const DEFAULT_ALL_ENTERTAINMENT_FILTERS: Readonly<AllEntertainmentFilterState> = { event: ALL_ENTERTAINMENT_EVENT_ALL, land: "", operatingOnly: false, showOutOfSeason: false };

/** Fresh default selections for "Reset filters" (a new object each call; never touches park/resort or provider data). */
export function resetAllEntertainmentFilters(): AllEntertainmentFilterState {
  return { ...DEFAULT_ALL_ENTERTAINMENT_FILTERS };
}

/** "Reset filters" is shown only when some selection differs from its default (hidden checkbox states count). */
export function showResetFilters(state: AllEntertainmentFilterState): boolean {
  const d = DEFAULT_ALL_ENTERTAINMENT_FILTERS;
  return state.event !== d.event || state.land !== d.land || state.operatingOnly !== d.operatingOnly || state.showOutOfSeason !== d.showOutOfSeason;
}

/**
 * Land/operating options effectively applied: in event browsing mode the
 * checkbox states are ignored (full associated catalog); the land filter stays.
 * The page keeps the checkbox state itself, so it is restored on return to All.
 */
export function effectiveEventBrowseFilters(eventValue: string, opts: { land?: string; operatingOnly?: boolean }): { land?: string; operatingOnly?: boolean } {
  return showOperatingOnlyToggle(eventValue) ? opts : { land: opts.land, operatingOnly: false };
}

/**
 * Parent-event ids an entry is associated with at `parkId`, from the maintained
 * associations only (curated: by canonical name; provider-only: park + exact
 * UUID). Child offerings resolve to their parent. Events must host the park.
 * Deduped.
 */
export function getAllEntryEventIds(entry: AllEntertainmentEntry, parkId: ParkId): string[] {
  let associations: { eventId: string }[] = [];
  if (entry.source === "provider_only") {
    if (entry.id.startsWith(PROVIDER_ID_PREFIX)) {
      const uuid = entry.id.slice(PROVIDER_ID_PREFIX.length).toLowerCase();
      associations = SEASONAL_PROVIDER_ONLY_EVENTS.find((r) => r.parkId === parkId && r.entityId.toLowerCase() === uuid)?.associations ?? [];
    }
  } else if (entry.source === "curated") {
    associations = SEASONAL_ENTERTAINMENT_EVENTS[entry.name] ?? [];
  }
  const ids = new Set<string>();
  for (const a of associations) {
    const ev = getSeasonalEvent(a.eventId);
    if (ev && ev.parkIds.includes(parkId)) ids.add(rootEventId(a.eventId));
  }
  return [...ids];
}

/**
 * The season to show for an event: the in-progress one, else the earliest
 * upcoming one, with confirmed start/end. Ended seasons and null-date records
 * never qualify (historical data is not "upcoming").
 */
export function getApplicableEventSeason(event: SeasonalEventDefinition, instant: Date = new Date()): SeasonalEventSeasonRecord | undefined {
  const live = listSeasonalEventSeasons(event.id)
    .map((s) => ({ s, status: getSeasonalEventSeasonStatus(event.resort, s, instant) }))
    .filter((x) => x.status === "in_progress" || x.status === "upcoming")
    .sort((a, b) => (a.status === b.status ? (a.s.startDate! < b.s.startDate! ? -1 : 1) : a.status === "in_progress" ? -1 : 1));
  return live[0]?.s;
}

function eventsWithAssociationsAt(parkId: ParkId): Set<string> {
  const used = new Set<string>();
  for (const place of getEntertainmentForPark(parkId)) {
    for (const a of SEASONAL_ENTERTAINMENT_EVENTS[place.name] ?? []) {
      const ev = getSeasonalEvent(a.eventId);
      if (ev && ev.parkIds.includes(parkId)) used.add(rootEventId(a.eventId));
    }
  }
  for (const r of SEASONAL_PROVIDER_ONLY_EVENTS) {
    if (r.parkId !== parkId) continue;
    for (const a of r.associations) {
      const ev = getSeasonalEvent(a.eventId);
      if (ev && ev.parkIds.includes(parkId)) used.add(rootEventId(a.eventId));
    }
  }
  return used;
}

/**
 * Dropdown options for a park: "All Entertainment", then qualifying top-level
 * registry events (see header) in registry order. Static for a park apart from
 * the resort-local season status; independent of provider data.
 */
export function getAllEntertainmentEventOptions(parkId: ParkId, instant: Date = new Date()): AllEntertainmentEventOption[] {
  const associated = eventsWithAssociationsAt(parkId);
  const events = SEASONAL_EVENTS
    .filter((e) => !e.parentEventId && e.parkIds.includes(parkId))
    .filter((e) => associated.has(e.id) || !!getApplicableEventSeason(e, instant))
    .map((e) => ({ value: e.id, label: eventShortLabel(e.id) }));
  return [{ value: ALL_ENTERTAINMENT_EVENT_ALL, label: "All Entertainment" }, ...events];
}

/** The selection if it is an option for this park, else "All" (park/resort switch, season rollover). */
export function resolveEventSelection(parkId: ParkId, eventValue: string, instant: Date = new Date()): string {
  return getAllEntertainmentEventOptions(parkId, instant).some((o) => o.value === eventValue) ? eventValue : ALL_ENTERTAINMENT_EVENT_ALL;
}

/**
 * Entries browsed for a selected event: live entries associated with it
 * (seasonal hiding intentionally NOT applied) plus synthesized curated records
 * for associated catalog shows missing from the live inventory. Order: live
 * (input order) then synthesized (catalog order); each id at most once.
 * "All" returns the input unchanged. Never creates provider-only records.
 */
export function getAllEntertainmentEventEntries(
  live: AllEntertainmentEntry[],
  parkId: ParkId,
  eventValue: string,
  instant: Date = new Date(),
): AllEntertainmentEntry[] {
  const value = resolveEventSelection(parkId, eventValue, instant);
  if (value === ALL_ENTERTAINMENT_EVENT_ALL) return live;
  const seen = new Set<string>();
  const out: AllEntertainmentEntry[] = [];
  for (const e of live) {
    if (seen.has(e.id) || !getAllEntryEventIds(e, parkId).includes(value)) continue;
    seen.add(e.id);
    out.push(e);
  }
  for (const place of getEntertainmentForPark(parkId)) {
    const synth = makeOffSeasonEntry(place, parkId);
    if (seen.has(synth.id) || !getAllEntryEventIds(synth, parkId).includes(value)) continue;
    seen.add(synth.id);
    out.push(synth);
  }
  return out;
}

// ── Event date display ────────────────────────────────────────────────────

export type AllEntertainmentEventInfo = {
  eventId: string;
  name: string;
  admission: string;
  /** e.g. "2026–27 season"; null when no confirmed in-progress/upcoming season. */
  seasonLabel: string | null;
  statusLabel: string | null;
  /** Festival/celebration (or party window) "Aug 27 – Nov 21, 2026". */
  rangeText: string | null;
  /** Ticketed parties: remaining confirmed nights (today or later), formatted. */
  nights: string[] | null;
  /** Set when upcoming dates are not confirmed in the registry. */
  unannouncedText: string | null;
  /** Narrower child offerings with their own confirmed windows. */
  offerings: string[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function md(iso: string): string { return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`; }

/** "Aug 27 – Nov 21, 2026" or "Nov 13, 2026 – Jan 6, 2027" (year shown wherever it differs). */
export function formatEventRange(start: string, end: string): string {
  const sy = start.slice(0, 4), ey = end.slice(0, 4);
  return sy === ey ? `${md(start)} – ${md(end)}, ${ey}` : `${md(start)}, ${sy} – ${md(end)}, ${ey}`;
}

function seasonLabelFor(s: SeasonalEventSeasonRecord): string {
  const sy = s.startDate!.slice(0, 4), ey = s.endDate!.slice(0, 4);
  return sy === ey ? `${sy} season` : `${sy}–${ey.slice(2)} season`;
}

/** Compact event information for a selected event; null for "All"/invalid selections. Never presents ended seasons. */
export function describeAllEntertainmentEvent(parkId: ParkId, eventValue: string, instant: Date = new Date()): AllEntertainmentEventInfo | null {
  if (resolveEventSelection(parkId, eventValue, instant) === ALL_ENTERTAINMENT_EVENT_ALL) return null;
  const event = getSeasonalEvent(eventValue)!;
  const today = getResortLocalDate(event.resort, instant);
  const admission = event.admission === "separate-ticket" ? "Separate ticket" : "Park admission";
  const season = getApplicableEventSeason(event, instant);
  const offerings: string[] = [];
  for (const child of SEASONAL_EVENTS.filter((e) => e.parentEventId === event.id && e.parkIds.includes(parkId))) {
    const cs = getApplicableEventSeason(child, instant);
    if (!cs) continue;
    if (season && cs.startDate === season.startDate && cs.endDate === season.endDate) continue;
    offerings.push(`${child.name}: ${formatEventRange(cs.startDate!, cs.endDate!)}`);
  }
  if (!season) {
    return {
      eventId: event.id, name: event.name, admission, seasonLabel: null, statusLabel: null, rangeText: null, nights: null,
      unannouncedText: "Upcoming dates have not been announced.", offerings,
    };
  }
  const startYear = season.startDate!.slice(0, 4);
  const nights = event.format === "select-night" && season.eventNights
    ? season.eventNights.filter((n) => n >= today).map((n) => (n.slice(0, 4) === startYear ? md(n) : `${md(n)}, ${n.slice(0, 4)}`))
    : null;
  return {
    eventId: event.id, name: event.name, admission,
    seasonLabel: seasonLabelFor(season),
    statusLabel: getSeasonalEventSeasonStatus(event.resort, season, instant) === "in_progress" ? "In progress" : "Upcoming",
    rangeText: formatEventRange(season.startDate!, season.endDate!),
    nights, unannouncedText: null, offerings,
  };
}

// ── DEV cases ─────────────────────────────────────────────────────────────

export type DevAllEntertainmentEventCase = { label: string; ok: () => boolean };

// 2026-11-10 17:00 UTC → WDW/DLR local date 2026-11-10
const NOW = new Date("2026-11-10T17:00:00Z");
const LATER = new Date("2027-07-01T17:00:00Z"); // every recorded season has ended
const ALL_PARKS: ParkId[] = ["disneyland", "dca", "mk", "epcot", "hs", "ak"];
const GARDEN_ROCKS = "0e35a7a2-c2cd-451b-88e2-afc9d370e69e";
const EAT_TO_THE_BEAT = "d6bb186c-382f-4ae6-bc76-fde8f141ed69";
const JN_STITCH = "ae7db7da-a3d9-443b-b4a6-d3c4a2b66121";
const SANTA_JACK_SALLY = "6d3b1129-b34c-4b44-bba2-0e1790fef705";
const DRUM_CORPS = "bc2c2ffe-3cf0-4e75-a408-bf5e86515c4c"; // unclassified HS provider-only

const vals = (p: ParkId, at: Date = NOW) => getAllEntertainmentEventOptions(p, at).map((o) => o.value);
const sameSet = (a: string[], b: string[]) => a.length === b.length && b.every((x) => a.includes(x));
const mkCur = (parkId: ParkId, name: string): AllEntertainmentEntry => makeOffSeasonEntry({ name } as Parameters<typeof makeOffSeasonEntry>[0], parkId);
const mkProv = (parkId: ParkId, uuid: string, name: string): AllEntertainmentEntry => ({ ...mkCur(parkId, name), id: `provider:${uuid}`, source: "provider_only" });
const names = (es: AllEntertainmentEntry[]) => es.map((e) => e.name);
const info = (p: ParkId, v: string, at: Date = NOW) => describeAllEntertainmentEvent(p, v, at)!;

export const DEV_ALL_ENTERTAINMENT_EVENT_FILTER_CASES: DevAllEntertainmentEventCase[] = [
  { label: "14.4D options: first is All Entertainment; no Regular option anywhere", ok: () =>
    ALL_PARKS.every((p) => { const o = getAllEntertainmentEventOptions(p, NOW); return o[0].value === "" && o[0].label === "All Entertainment" && !o.some((x) => x.value === "regular" || x.label === "Regular"); }) },
  { label: "14.4D options (Nov 10 2026): MK", ok: () => sameSet(vals("mk"), ["", "mnsshp", "mvmcp", "holidays-wdw"]) },
  { label: "14.4D options: EPCOT parents incl. date-only Festival of the Arts; no Eat to the Beat entry", ok: () =>
    sameSet(vals("epcot"), ["", "epcot-festival-of-the-arts", "epcot-flower-and-garden", "epcot-food-and-wine", "epcot-festival-of-the-holidays", "holidays-wdw"]) },
  { label: "14.4D options: HS, AK (date-only Holidays at WDW), Disneyland, DCA", ok: () =>
    sameSet(vals("hs"), ["", "jollywood-nights", "holidays-wdw"]) && sameSet(vals("ak"), ["", "holidays-wdw"]) &&
    sameSet(vals("disneyland"), ["", "halloween-time-dlr", "holidays-dlr"]) &&
    sameSet(vals("dca"), ["", "oogie-boogie-bash", "holidays-dlr", "plaza-de-la-familia", "dca-food-and-wine"]) },
  { label: "14.4D options: associations only (MNSSHP, season ended), dates only (Arts, AK Holidays), both (Flower & Garden), neither hidden (DCA Lunar New Year, Halloween Time at DCA)", ok: () =>
    vals("mk").includes("mnsshp") && vals("epcot").includes("epcot-festival-of-the-arts") && vals("ak").includes("holidays-wdw") &&
    vals("epcot").includes("epcot-flower-and-garden") && !vals("dca").includes("lunar-new-year-dca") && !vals("dca").includes("halloween-time-dlr") },
  { label: "14.4D options: a historical season alone never qualifies (Jul 2027: Arts/Holidays-at-AK gone, associated events stay)", ok: () =>
    !vals("epcot", LATER).includes("epcot-festival-of-the-arts") && !vals("ak", LATER).includes("holidays-wdw") && vals("mk", LATER).includes("mnsshp") && sameSet(vals("ak", LATER), [""]) },
  { label: "14.4D options: every option is a top-level registry event hosting the park, labelled by its short label", ok: () =>
    ALL_PARKS.every((p) => getAllEntertainmentEventOptions(p, NOW).slice(1).every((o) => { const e = getSeasonalEvent(o.value); return !!e && !e.parentEventId && e.parkIds.includes(p) && eventShortLabel(e.id) === o.label; })) },
  { label: "14.4D short labels: requested mapping, every registry event covered, no stale keys, all shorter than official names", ok: () =>
    EVENT_SHORT_LABELS["mnsshp"] === "Not-So-Scary Party" && EVENT_SHORT_LABELS["mvmcp"] === "Very Merry Christmas Party" &&
    EVENT_SHORT_LABELS["jollywood-nights"] === "Jollywood Nights" && EVENT_SHORT_LABELS["epcot-festival-of-the-arts"] === "Festival of the Arts" &&
    EVENT_SHORT_LABELS["epcot-flower-and-garden"] === "Flower & Garden" && EVENT_SHORT_LABELS["epcot-food-and-wine"] === "Food & Wine" &&
    EVENT_SHORT_LABELS["epcot-festival-of-the-holidays"] === "Festival of the Holidays" && EVENT_SHORT_LABELS["holidays-wdw"] === "WDW Holidays" &&
    EVENT_SHORT_LABELS["oogie-boogie-bash"] === "Oogie Boogie Bash" && EVENT_SHORT_LABELS["plaza-de-la-familia"] === "Plaza de la Familia" &&
    EVENT_SHORT_LABELS["lunar-new-year-dca"] === "Lunar New Year" &&
    SEASONAL_EVENTS.every((e) => !!EVENT_SHORT_LABELS[e.id] && EVENT_SHORT_LABELS[e.id].length <= e.name.length) &&
    Object.keys(EVENT_SHORT_LABELS).every((id) => !!getSeasonalEvent(id)) },
  { label: "14.4D info card keeps the full official event name (not the short label)", ok: () =>
    info("mk", "mnsshp").name === "Mickey's Not-So-Scary Halloween Party" && info("epcot", "epcot-food-and-wine").name === "EPCOT International Food & Wine Festival" },
  { label: "14.4D checkbox semantics: both checkboxes only in All mode; event mode ignores their state, keeps land; default unchanged", ok: () =>
    showOperatingOnlyToggle("") && showOutOfSeasonToggle("") && !showOperatingOnlyToggle("mvmcp") && !showOutOfSeasonToggle("mvmcp") &&
    effectiveEventBrowseFilters("mvmcp", { land: "Fantasyland", operatingOnly: true }).operatingOnly === false &&
    effectiveEventBrowseFilters("mvmcp", { land: "Fantasyland", operatingOnly: true }).land === "Fantasyland" &&
    effectiveEventBrowseFilters("", { land: "X", operatingOnly: true }).operatingOnly === true },
  { label: "14.4D event mode with operating-only checked still shows the full associated catalog; returning to All restores the filter", ok: () => {
    const pool = getAllEntertainmentEventEntries([mkCur("mk", "Frozen Holiday Surprise")], "mk", "mvmcp", NOW);
    const eventMode = filterAllEntertainment(pool, effectiveEventBrowseFilters("mvmcp", { operatingOnly: true }));
    const allMode = filterAllEntertainment(pool, effectiveEventBrowseFilters("", { operatingOnly: true }));
    return eventMode.length === pool.length && pool.length > 1 && allMode.length === 0;
  } },
  { label: "14.4D reset: default state hides the Reset button", ok: () => !showResetFilters(resetAllEntertainmentFilters()) && !showResetFilters({ ...DEFAULT_ALL_ENTERTAINMENT_FILTERS }) },
  { label: "14.4D reset: each active filter (event, land, operating only, out-of-season) shows the button, hidden checkbox states included", ok: () => {
    const d = DEFAULT_ALL_ENTERTAINMENT_FILTERS;
    return showResetFilters({ ...d, event: "mvmcp" }) && showResetFilters({ ...d, land: "Fantasyland" }) && showResetFilters({ ...d, operatingOnly: true }) &&
      showResetFilters({ ...d, showOutOfSeason: true }) && showResetFilters({ event: "mvmcp", land: "", operatingOnly: true, showOutOfSeason: true });
  } },
  { label: "14.4D reset: combined filters return to defaults; result is a fresh object and defaults are not mutated", ok: () => {
    const active: AllEntertainmentFilterState = { event: "mvmcp", land: "Fantasyland", operatingOnly: true, showOutOfSeason: true };
    const r = resetAllEntertainmentFilters(); r.land = "mutated";
    return showResetFilters(active) && !showResetFilters(resetAllEntertainmentFilters()) && DEFAULT_ALL_ENTERTAINMENT_FILTERS.land === "" &&
      JSON.stringify(resetAllEntertainmentFilters()) === JSON.stringify({ event: "", land: "", operatingOnly: false, showOutOfSeason: false });
  } },
  { label: "14.4D reset from event-browsing mode restores default visibility (checkboxes shown, full live list, no event pool)", ok: () => {
    const reset = resetAllEntertainmentFilters();
    const live = [mkCur("mk", "Happily Ever After")];
    return showOutOfSeasonToggle(reset.event) && showOperatingOnlyToggle(reset.event) && getAllEntertainmentEventEntries(live, "mk", reset.event, NOW) === live &&
      !showOutOfSeasonToggle("mvmcp") && resolveEventSelection("mk", reset.event, NOW) === "";
  } },
  { label: "14.4D reset state carries no park/resort or provider fields (park switch and refetch effects are untouched)", ok: () =>
    Object.keys(resetAllEntertainmentFilters()).sort().join() === "event,land,operatingOnly,showOutOfSeason" },
  { label: "14.4D info card carries one concise availability disclaimer (no performance promise)", ok: () => EVENT_INFO_NOTE === "Entertainment shown is associated with this event. Individual performance dates and times may vary." },
  { label: "14.4D parent grouping: Garden Rocks → Flower & Garden, Eat to the Beat → Food & Wine (via registry parentEventId)", ok: () =>
    getAllEntryEventIds(mkProv("epcot", GARDEN_ROCKS, "g"), "epcot").join() === "epcot-flower-and-garden" &&
    getAllEntryEventIds(mkProv("epcot", EAT_TO_THE_BEAT, "e"), "epcot").join() === "epcot-food-and-wine" },
  { label: "14.4D park switch/reset: selection invalid for new park resolves to All; valid one kept", ok: () =>
    resolveEventSelection("hs", "mnsshp", NOW) === "" && resolveEventSelection("mk", "mnsshp", NOW) === "mnsshp" && resolveEventSelection("mk", "", NOW) === "" },
  { label: "14.4D checkbox visible only for All Entertainment", ok: () => showOutOfSeasonToggle("") && !showOutOfSeasonToggle("mnsshp") },
  { label: "14.4D default behaviour unchanged: 'All' returns the live list identity", ok: () => {
    const live = [mkCur("mk", "Frozen Holiday Surprise"), mkCur("mk", "Happily Ever After")];
    return getAllEntertainmentEventEntries(live, "mk", "", NOW) === live;
  } },
  { label: "14.4D event selection overrides seasonal hiding (live confirmed-off-season entry kept) and synthesizes missing curated shows", ok: () => {
    const hocus = { ...mkCur("mk", "Hocus Pocus Villain Spelltacular"), id: "curated:mk:Hocus Pocus Villain Spelltacular" };
    const hiddenByDefault = applyAllEntertainmentSeasonalVisibility([hocus], "mk", "WDW", "2026-11-10", false, NOW).length === 0;
    const out = getAllEntertainmentEventEntries([hocus], "mk", "mnsshp", NOW);
    return hiddenByDefault && out[0] === hocus && out.length === 3 && new Set(out.map((e) => e.id)).size === 3 &&
      names(out).includes("Mickey's Boo-To-You Halloween Parade") && getOffSeasonCuratedEntertainment("mk", "2026-11-10", new Set(), NOW).length >= 3;
  } },
  { label: "14.4D provider-only: only live records are shown, never fabricated; unlisted/other-event records excluded", ok: () => {
    const live = [mkProv("hs", JN_STITCH, "Stitch"), mkProv("hs", DRUM_CORPS, "Drum Corps"), mkProv("mk", SANTA_JACK_SALLY, "x")];
    const hs = getAllEntertainmentEventEntries(live, "hs", "jollywood-nights", NOW);
    const none = getAllEntertainmentEventEntries([], "hs", "jollywood-nights", NOW);
    return hs.some((e) => e.id === `provider:${JN_STITCH}`) && !hs.some((e) => e.id === `provider:${DRUM_CORPS}`) &&
      none.every((e) => e.source === "curated" && e.showtime.status === "unavailable" && e.showtime.performances.length === 0);
  } },
  { label: "14.4D multi-associated Frozen Holiday Surprise appears once under each of Holidays at WDW and MVMCP", ok: () => {
    const live = [mkCur("mk", "Frozen Holiday Surprise"), mkCur("mk", "Frozen Holiday Surprise")];
    const h = getAllEntertainmentEventEntries(live, "mk", "holidays-wdw", NOW).filter((e) => e.name === "Frozen Holiday Surprise");
    const m = getAllEntertainmentEventEntries(live, "mk", "mvmcp", NOW).filter((e) => e.name === "Frozen Holiday Surprise");
    return h.length === 1 && m.length === 1;
  } },
  { label: "14.4D date-only event has no entertainment (message path): Festival of the Arts / AK Holidays", ok: () =>
    getAllEntertainmentEventEntries([], "epcot", "epcot-festival-of-the-arts", NOW).length === 0 &&
    getAllEntertainmentEventEntries([], "ak", "holidays-wdw", NOW).length === 0 &&
    EVENT_NO_ENTERTAINMENT_MESSAGE === "No entertainment currently tracked for this event." },
  { label: "14.4D event browsing combines with land + operating-only; synthesized never satisfy operating-only; order stable", ok: () => {
    const a = { ...mkCur("mk", "Frozen Holiday Surprise"), land: "Fantasyland" };
    const b = { ...mkCur("mk", "Mickey's Most Merriest Celebration"), land: "Main Street, U.S.A." };
    const browsed = getAllEntertainmentEventEntries([a, b], "mk", "mvmcp", NOW);
    const lan = filterAllEntertainment(browsed, { land: "Fantasyland" });
    return names(browsed).slice(0, 2).join("|") === `${a.name}|${b.name}` && lan[0] === a && lan.every((e) => e.land === "Fantasyland") &&
      filterAllEntertainment(browsed, { operatingOnly: true }).length === 0;
  } },
  { label: "14.4D party schedule: MVMCP separate ticket, in progress, remaining nights only (23 from Nov 12)", ok: () => {
    const i = info("mk", "mvmcp");
    return i.admission === "Separate ticket" && i.statusLabel === "In progress" && i.nights?.length === 23 && i.nights[0] === "Nov 12" && !i.nights.includes("Nov 8") && i.rangeText === "Nov 8 – Dec 22, 2026";
  } },
  { label: "14.4D festival range + narrower offering: Food & Wine Aug 27 – Nov 21, 2026; Eat to the Beat ends Nov 16", ok: () => {
    const i = info("epcot", "epcot-food-and-wine");
    return i.admission === "Park admission" && i.rangeText === "Aug 27 – Nov 21, 2026" && i.nights === null && i.offerings.join() === "EPCOT Eat to the Beat Concert Series: Aug 27 – Nov 16, 2026";
  } },
  { label: "14.4D cross-year seasons: Jollywood nights include 2027 dates; Holidays range spans years", ok: () => {
    const j = info("hs", "jollywood-nights"); const h = info("mk", "holidays-wdw");
    return j.seasonLabel === "2026–27 season" && !!j.nights?.includes("Jan 3, 2027") && j.nights![0] === "Nov 14" && h.rangeText === "Nov 13, 2026 – Jan 6, 2027" && h.statusLabel === "Upcoming" && h.nights === null;
  } },
  { label: "14.4D upcoming vs historical: Flower & Garden shows the 2027 season, never the ended 2026 dates", ok: () => {
    const i = info("epcot", "epcot-flower-and-garden");
    return i.seasonLabel === "2027 season" && i.rangeText === "Mar 10 – May 31, 2027" && i.statusLabel === "Upcoming";
  } },
  { label: "14.4D unannounced: ended-only event (MNSSHP) says dates not announced, no historical dates", ok: () => {
    const i = info("mk", "mnsshp");
    return i.unannouncedText === "Upcoming dates have not been announced." && i.rangeText === null && i.nights === null && i.seasonLabel === null;
  } },
  { label: "14.4D info is null for All Entertainment / stale selections", ok: () => describeAllEntertainmentEvent("mk", "", NOW) === null && describeAllEntertainmentEvent("hs", "mnsshp", NOW) === null },
];

export function runDevAllEntertainmentEventFilterCases(): string[] {
  return DEV_ALL_ENTERTAINMENT_EVENT_FILTER_CASES.filter((c) => {
    try { return !c.ok(); } catch { return true; }
  }).map((c) => c.label);
}

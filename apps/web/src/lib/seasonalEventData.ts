/**
 * seasonalEventData.ts — Phase 14.1 seasonal event registry (DATA ONLY).
 *
 * Authoritative, hand-maintained metadata for major recurring WDW/DLR
 * seasonal events. Events are metadata — NOT a planner content type and not
 * a catalog (Attractions/Dining/Entertainment/Experiences) — and nothing here
 * is derived from ThemeParks.wiki TICKETED_EVENT records. Seasonal
 * entertainment keeps living in `entertainmentSuggestions.ts`
 * (`availabilityType` / `availabilityTheme`); this module does not duplicate it.
 *
 * Structure
 *   SEASONAL_EVENTS         — one stable definition per event (identity).
 *   SEASONAL_EVENT_SEASONS  — dated records keyed by (eventId, seasonYear),
 *                             where seasonYear is the year the event BEGINS
 *                             (Nov 2026–Jan 2027 is the 2026 season).
 *
 * Data rules
 *   - Dates come only from official Disney sources (Disney Parks Blog posts /
 *     disney.go.com pages) and each season records its source + verification.
 *   - Unverified dates are omitted, never guessed. Unannounced dates are `null`
 *     (and `eventNights` omitted) — never extrapolated from prior years.
 *   - Prior seasons are listed only where verified; absence of a season means
 *     "not verified", not "did not run".
 *   - Historical seasons answer historical lookups only; see seasonalEvents.ts
 *     for how past dates are kept from reading as future availability.
 *   - Parks reuse `ParkId` (parkMetadata.ts / shared); dates are plain
 *     "YYYY-MM-DD" resort-local calendar dates validated by
 *     `isValidIsoCalendarDate` (plannerWarnings.ts).
 *
 * Validate edits with `runDevSeasonalEventCases()` in seasonalEvents.ts.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";

export type SeasonalEventCategory =
  | "halloween-party"
  | "christmas-party"
  | "halloween-season"
  | "christmas-season"
  | "epcot-festival";

/**
 * "continuous"   — runs every day of its start–end window.
 * "select-night" — ticketed party held only on specific nights within its
 *                  window (`eventNights`); the window alone does not say which.
 */
export type SeasonalEventFormat = "continuous" | "select-night";

/**
 * "park-admission"  — included with regular theme park admission.
 * "separate-ticket" — requires its own event ticket.
 */
export type SeasonalEventAdmission = "park-admission" | "separate-ticket";

export type SeasonalEventDefinition = {
  /** Stable, never-reused identifier. */
  id: string;
  /** Official Disney event name. */
  name: string;
  resort: ResortId;
  /** Park(s) hosting the event; every park must belong to `resort`. */
  parkIds: ParkId[];
  category: SeasonalEventCategory;
  format: SeasonalEventFormat;
  admission: SeasonalEventAdmission;
  /** Official Disney event information / ticket page. */
  officialUrl: string;
};

export type SeasonalEventSeasonRecord = {
  eventId: string;
  /** Year the event begins (cross-year events stay one season). */
  seasonYear: number;
  /** Confirmed first day, or null when not announced/verified. */
  startDate: string | null;
  /** Confirmed last day, or null when not announced/verified. */
  endDate: string | null;
  /** Confirmed individual event nights (ascending). Omitted when unknown. */
  eventNights?: string[];
  /** Official page the dates were verified against. */
  sourceUrl: string;
  /** Publication date of that source (YYYY-MM-DD) when stated by it. */
  sourcePublishedDate?: string;
  /** Date the maintainer verified the record against `sourceUrl`. */
  verifiedOn: string;
  /** Free-form note on what was/wasn't confirmed. */
  note?: string;
};

const WDW_EVENTS = "https://disneyworld.disney.go.com/events-tours";
const DLR_EVENTS = "https://disneyland.disney.go.com/events-tours";

export const SEASONAL_EVENTS: SeasonalEventDefinition[] = [
  // ── Halloween ────────────────────────────────────────────────────────
  { id: "mnsshp", name: "Mickey's Not-So-Scary Halloween Party", resort: "WDW", parkIds: ["mk"], category: "halloween-party", format: "select-night", admission: "separate-ticket", officialUrl: `${WDW_EVENTS}/magic-kingdom/mickeys-not-so-scary-halloween-party/` },
  { id: "oogie-boogie-bash", name: "Oogie Boogie Bash", resort: "DLR", parkIds: ["dca"], category: "halloween-party", format: "select-night", admission: "separate-ticket", officialUrl: `${DLR_EVENTS}/disney-california-adventure/oogie-boogie-bash-halloween-party/` },
  { id: "halloween-time-dlr", name: "Halloween Time at the Disneyland Resort", resort: "DLR", parkIds: ["disneyland", "dca"], category: "halloween-season", format: "continuous", admission: "park-admission", officialUrl: `${DLR_EVENTS}/halloween-time-at-the-disneyland-resort/` },
  // ── Christmas / holidays ─────────────────────────────────────────────
  { id: "mvmcp", name: "Mickey's Very Merry Christmas Party", resort: "WDW", parkIds: ["mk"], category: "christmas-party", format: "select-night", admission: "separate-ticket", officialUrl: `${WDW_EVENTS}/magic-kingdom/mickeys-very-merry-christmas-party/` },
  { id: "jollywood-nights", name: "Disney Jollywood Nights", resort: "WDW", parkIds: ["hs"], category: "christmas-party", format: "select-night", admission: "separate-ticket", officialUrl: `${WDW_EVENTS}/hollywood-studios/disney-jollywood-nights/` },
  { id: "holidays-dlr", name: "Holidays at the Disneyland Resort", resort: "DLR", parkIds: ["disneyland", "dca"], category: "christmas-season", format: "continuous", admission: "park-admission", officialUrl: `${DLR_EVENTS}/calendar/` },
  // ── EPCOT festivals ──────────────────────────────────────────────────
  { id: "epcot-festival-of-the-arts", name: "EPCOT International Festival of the Arts", resort: "WDW", parkIds: ["epcot"], category: "epcot-festival", format: "continuous", admission: "park-admission", officialUrl: `${WDW_EVENTS}/epcot/epcot-international-festival-of-the-arts/` },
  { id: "epcot-flower-and-garden", name: "EPCOT International Flower & Garden Festival", resort: "WDW", parkIds: ["epcot"], category: "epcot-festival", format: "continuous", admission: "park-admission", officialUrl: `${WDW_EVENTS}/epcot/epcot-international-flower-and-garden-festival/` },
  { id: "epcot-food-and-wine", name: "EPCOT International Food & Wine Festival", resort: "WDW", parkIds: ["epcot"], category: "epcot-festival", format: "continuous", admission: "park-admission", officialUrl: `${WDW_EVENTS}/epcot/epcot-international-food-and-wine-festival/` },
  { id: "epcot-festival-of-the-holidays", name: "EPCOT International Festival of the Holidays", resort: "WDW", parkIds: ["epcot"], category: "epcot-festival", format: "continuous", admission: "park-admission", officialUrl: `${WDW_EVENTS}/epcot/holiday-festival/` },
];

const V = "2026-10-29";
const DPB = "https://disneyparksblog.com";

export const SEASONAL_EVENT_SEASONS: SeasonalEventSeasonRecord[] = [
  // ── 2026 season ──────────────────────────────────────────────────────
  {
    eventId: "mnsshp", seasonYear: 2026, startDate: "2026-08-07", endDate: "2026-10-31",
    eventNights: [
      "2026-08-07", "2026-08-11", "2026-08-14", "2026-08-18", "2026-08-21", "2026-08-23", "2026-08-25", "2026-08-28", "2026-08-30",
      "2026-09-01", "2026-09-04", "2026-09-08", "2026-09-11", "2026-09-13", "2026-09-15", "2026-09-18", "2026-09-20", "2026-09-22", "2026-09-24", "2026-09-25", "2026-09-27", "2026-09-29",
      "2026-10-01", "2026-10-02", "2026-10-04", "2026-10-06", "2026-10-08", "2026-10-09", "2026-10-13", "2026-10-15", "2026-10-16", "2026-10-18", "2026-10-22", "2026-10-23", "2026-10-25", "2026-10-27", "2026-10-29", "2026-10-31",
    ],
    sourceUrl: `${DPB}/wdw/mickeys-not-so-scary-halloween-party-dates-teaser-treats/`, sourcePublishedDate: "2026-08-03", verifiedOn: V,
    note: "Disney Parks Blog full night list; third-party calendars disagreed on some Aug/Sep nights and were not used.",
  },
  {
    eventId: "oogie-boogie-bash", seasonYear: 2026, startDate: "2026-08-18", endDate: "2026-10-31",
    eventNights: [
      "2026-08-18", "2026-08-20", "2026-08-23", "2026-08-25", "2026-08-27", "2026-08-30",
      "2026-09-01", "2026-09-03", "2026-09-06", "2026-09-08", "2026-09-10", "2026-09-13", "2026-09-15", "2026-09-17", "2026-09-20", "2026-09-22", "2026-09-24", "2026-09-27", "2026-09-29",
      "2026-10-01", "2026-10-04", "2026-10-06", "2026-10-08", "2026-10-11", "2026-10-13", "2026-10-15", "2026-10-18", "2026-10-20", "2026-10-22", "2026-10-25", "2026-10-27", "2026-10-29", "2026-10-31",
    ],
    sourceUrl: `${DPB}/dlr/disneyland-resort-2026-calendar-events-and-offers/`, sourcePublishedDate: "2025-12-02", verifiedOn: V,
    note: "33 nights (6 Aug, 13 Sep, 14 Oct); post updated July 24, 2026.",
  },
  {
    eventId: "halloween-time-dlr", seasonYear: 2026, startDate: "2026-08-21", endDate: "2026-10-31",
    sourceUrl: `${DPB}/dlr/disneyland-resort-2026-calendar-events-and-offers/`, sourcePublishedDate: "2025-12-02", verifiedOn: V,
  },
  {
    eventId: "mvmcp", seasonYear: 2026, startDate: "2026-11-08", endDate: "2026-12-22",
    eventNights: [
      "2026-11-08", "2026-11-09", "2026-11-12", "2026-11-13", "2026-11-15", "2026-11-17", "2026-11-19", "2026-11-20", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-29",
      "2026-12-01", "2026-12-03", "2026-12-04", "2026-12-06", "2026-12-08", "2026-12-10", "2026-12-11", "2026-12-13", "2026-12-15", "2026-12-17", "2026-12-18", "2026-12-20", "2026-12-22",
    ],
    sourceUrl: `${DPB}/wdw/mickeys-very-merry-christmas-party-dates-and-festive-details/`, sourcePublishedDate: "2026-10-06", verifiedOn: V,
  },
  {
    eventId: "jollywood-nights", seasonYear: 2026, startDate: "2026-11-07", endDate: "2027-01-05",
    eventNights: [
      "2026-11-07", "2026-11-14", "2026-11-16", "2026-11-21", "2026-11-23", "2026-11-28",
      "2026-12-05", "2026-12-07", "2026-12-12", "2026-12-14", "2026-12-19", "2026-12-21", "2026-12-23",
      "2027-01-03", "2027-01-05",
    ],
    sourceUrl: `${DPB}/wdw/disney-jollywood-nights-dates-tickets-and-more/`, sourcePublishedDate: "2026-10-06", verifiedOn: V,
    note: "Cross-year season; January nights belong to the 2026 season. Source gives the January year implicitly (first January extension).",
  },
  {
    eventId: "holidays-dlr", seasonYear: 2026, startDate: "2026-11-13", endDate: "2027-01-06",
    sourceUrl: `${DPB}/dlr/disneyland-resort-2026-calendar-events-and-offers/`, sourcePublishedDate: "2025-12-02", verifiedOn: V,
    note: "Start moved from Nov 18 to Nov 13 in the July 24, 2026 update.",
  },
  {
    eventId: "epcot-festival-of-the-arts", seasonYear: 2026, startDate: "2026-01-16", endDate: "2026-02-23",
    sourceUrl: `${DPB}/wdw/2026-disney-world-calendar-and-details/`, verifiedOn: V,
  },
  {
    eventId: "epcot-flower-and-garden", seasonYear: 2026, startDate: "2026-03-04", endDate: "2026-06-01",
    sourceUrl: `${DPB}/wdw/2026-disney-world-calendar-and-details/`, verifiedOn: V,
  },
  {
    eventId: "epcot-food-and-wine", seasonYear: 2026, startDate: "2026-08-27", endDate: "2026-11-21",
    sourceUrl: `${DPB}/wdw/disney-eats-epcot-international-food-and-wine-festival-foodie-guide/`, sourcePublishedDate: "2026-08-19", verifiedOn: V,
  },
  {
    eventId: "epcot-festival-of-the-holidays", seasonYear: 2026, startDate: "2026-11-27", endDate: "2026-12-30",
    sourceUrl: `${DPB}/wdw/epcot-festival-of-the-holidays-dates-details/`, sourcePublishedDate: "2026-06-24", verifiedOn: V,
  },
  // ── 2025 season (verified records only) ──────────────────────────────
  {
    eventId: "epcot-food-and-wine", seasonYear: 2025, startDate: "2025-08-28", endDate: "2025-11-22",
    sourceUrl: `${DPB}/wdw/2025-epcot-food-and-wine-festival-dates/`, sourcePublishedDate: "2025-07-02", verifiedOn: V,
  },
  {
    eventId: "epcot-festival-of-the-holidays", seasonYear: 2025, startDate: "2025-11-28", endDate: "2025-12-30",
    sourceUrl: `${DPB}/wdw/holidays-at-disney-world-2025-christmas-lights-festive-fun-and-more/`, sourcePublishedDate: "2025-11-24", verifiedOn: V,
  },
];

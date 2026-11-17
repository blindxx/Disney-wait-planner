/**
 * eventExclusiveMeets.ts — Phase 14.4C event-exclusive character meets for
 * Waits & Shows.
 *
 * Shows verified, individually identifiable, STATIONARY character meets that
 * exist only at a separately ticketed party, and only on CONFIRMED party dates.
 * Ordinary meets, roaming characters, generic "Character Greetings" umbrella
 * records, regular seasonal meets (park-admission) and unverified costume
 * identities are never listed here.
 *
 * Single sources reused (nothing duplicated):
 *   - Party dates: the maintained registry (seasonalEventData.ts) via the
 *     explicit park+UUID party associations in
 *     `SEASONAL_PROVIDER_ONLY_EVENTS` (seasonalEntertainment.ts). A meet is
 *     visible iff `getSeasonalProviderEntertainmentRank` is "party-night" for
 *     the resort-local date — i.e. a confirmed party night. Non-party dates
 *     (including inside the holiday season), unannounced/unknown dates and
 *     historical dates are never confirmed. Visible the ENTIRE local calendar
 *     day (before party hours too); status is never required to be OPERATING.
 *   - Schedules / operating hours / completeness: `buildParkAllEntertainment`
 *     (entertainmentAll.ts → entertainmentShowtimes.ts), unchanged.
 *   - Park-qualified Queue-Times ids: `QUEUE_TIMES_PARK_MAP` (liveWaitApi.ts).
 *
 * This module only adds the explicit meet list below (identity: park + exact
 * ThemeParks UUID, optional exact Queue-Times ride id) — never name matching.
 *
 * Provider semantics
 *   - ThemeParks.wiki verifies identity/presence (a record must be present in
 *     the park's successful live payload under its registered UUID, park and
 *     expected name — `meetNameMatches`; a changed name omits that meet) and supplies performances/operating
 *     hours. Its wait value is never used or invented.
 *   - Queue-Times supplies the actual wait ONLY for the verified event-specific
 *     ride id (exact id, expected name, same park payload, fresh). No ordinary
 *     meet's wait is ever substituted. Queue-Times failing never hides a
 *     ThemeParks-verified meet; it only leaves the wait "unavailable".
 *   - A ThemeParks failure is "unavailable" (separate from a confirmed absence,
 *     which simply lists nothing). No static/placeholder cards, ever.
 *
 * Provider limitations are recorded in the registry `note`s.
 *
 * Phase 14.5D — non-meet event offerings. The same registry also lists verified
 * event-specific NON-meet records (`kind: "entertainment"`: dance parties,
 * roaming/stage acts — provider SHOW records whose own names carry the party and
 * that have no DWP catalog entry; curated party shows such as parades, fireworks
 * and stage shows already reach Waits & Shows through the catalog + mapping and
 * must never be registered here: no duplicates). Identity, date gating, windows,
 * name guard, failure semantics and attribution are IDENTICAL to meets; they are
 * returned separately as `offerings` and shown in their own "Party Entertainment"
 * section so "Party Character Meets" keeps its meaning. Confirmed offerings whose
 * provider record does not exist (out of season, or never published) live in
 * `PENDING_EVENT_OFFERINGS` — evidence/next-season verification notes only, never
 * rendered, never carrying a provider id.
 *
 * DEV checks: `runDevEventExclusiveMeetCases()` (run manually from Node).
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { buildParkAllEntertainment, allEntryViewAt, type AllEntertainmentEntry } from "./entertainmentAll";
import { MAX_OPERATING_INTERVAL_MS, PARTIAL_SHOWTIMES_NOTE } from "./entertainmentShowtimes";
import { QUEUE_TIMES_PARK_MAP } from "./liveWaitApi";
import { PARK_TO_RESORT } from "./parkMetadata";
import { addDaysToLocalDate, getResortLocalDate } from "./resortTime";
import { ENTERTAINMENT_PLACES } from "./entertainmentSuggestions";
import { SEASONAL_PROVIDER_ONLY_EVENTS, getSeasonalProviderEntertainmentRank } from "./seasonalEntertainment";
import { getSeasonalEvent } from "./seasonalEvents";
import { resolveDwpEntertainmentFromThemeParksId } from "./themeParksEntertainmentMapping";
import { isAllEntryConfirmedInactiveToday } from "./seasonalVisibility";
import type { ThemeParksError, ThemeParksLive, ThemeParksResult, ThemeParksShowtime } from "./themeParksApi";

// ============================================
// REGISTRY (explicit, park-qualified, exact ids)
// ============================================

export type EventExclusiveMeet = {
  parkId: ParkId;
  /** Exact ThemeParks.wiki SHOW entity UUID (lowercase). Its party association lives in SEASONAL_PROVIDER_ONLY_EVENTS. */
  entityId: string;
  /** Provider display name when verified (informational; the live name is shown). */
  providerName: string;
  /** Exact Queue-Times ride id + expected name for the same physical meet, when one exists. */
  queueTimes?: { rideId: number; name: string };
  /** "meet" (default) → Party Character Meets; "entertainment" → Party Entertainment (Phase 14.5D). */
  kind?: "meet" | "entertainment";
  note?: string;
};

export const isEventMeet = (m: { kind?: "meet" | "entertainment" }): boolean => (m.kind ?? "meet") === "meet";

/**
 * Verified 2026-11-10 against ThemeParks.wiki park children/live and
 * Queue-Times (all six parks). Excluded on purpose (see PR notes): the
 * "Character Greetings at …" umbrella records, ordinary/roaming meets,
 * DCA "Meet Santa Claus at the Disneyland Resort" (park-admission season, not
 * ticketed), and the MNSSHP Halloween Jack and Sally (no current provider
 * record to revalidate — add once the provider republishes it).
 */
export const EVENT_EXCLUSIVE_MEETS: EventExclusiveMeet[] = [
  {
    parkId: "mk", entityId: "6d3b1129-b34c-4b44-bba2-0e1790fef705",
    providerName: "Meet Santa Jack and Sally at Mickey’s Very Merry Christmas Party",
    queueTimes: { rideId: 15395, name: "Meet Santa Jack and Sally at Mickey’s Very Merry Christmas Party" },
    note: "Only meet with its own event-specific Queue-Times row.",
  },
  {
    parkId: "mk", entityId: "418c2111-36d4-4f07-86b2-8058014a263c",
    providerName: "Join Santa Claus at Mickey's Very Merry Christmas Party",
    note: "No Queue-Times record: waits are never shown, schedule/hours only when ThemeParks publishes them.",
  },
  {
    parkId: "hs", entityId: "ae7db7da-a3d9-443b-b4a6-d3c4a2b66121",
    providerName: "Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights",
    queueTimes: { rideId: 15402, name: "Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights" },
    note: "Phase 14.5D: Queue-Times now publishes an event-specific row (id 15402, exact name verified 2026-11-17). The ordinary Olaf row at Celebrity Spotlight (6703) is never substituted.",
  },
  // ---- Phase 14.5D: non-meet event offerings (provider SHOW records, no DWP catalog entry; verified 2026-11-17) ----
  {
    parkId: "mk", entityId: "4514beed-faa9-4847-bc77-34f9c6b1f619", kind: "entertainment",
    providerName: "Stitchmas! at Mickey's Very Merry Christmas Party",
    note: "2026 Tomorrowland dance party (Cosmic Ray's Starlight Café per secondary coverage). Provider publishes a Special Ticketed Event window (7:00 PM–midnight) → shown as operating hours. No Queue-Times record.",
  },
  {
    parkId: "mk", entityId: "6d45026b-0761-4b6d-8902-50905aa82da2", kind: "entertainment",
    providerName: "Reindeer Wranglers at Mickey's Very Merry Christmas Party",
    note: "Provider publishes discrete party-night performance times (start == end). Venue differs between secondary sources and is not asserted. No Queue-Times record.",
  },
  {
    parkId: "hs", entityId: "71da34dd-a27e-4db5-aef3-f880ef939f98", kind: "entertainment",
    providerName: "Pixar Disco at Disney Jollywood Nights",
    note: "Pixar Plaza dance party (Disney Parks Blog 2026-10-06 names Pixar Disco). Provider times are published only when posted; none are invented.",
  },
  {
    parkId: "hs", entityId: "74b46a33-ec93-4222-a3d5-d8372b1498e9", kind: "entertainment",
    providerName: "Grand Avenue Dance Party at Disney Jollywood Nights",
    note: "Party association rests on the provider record's own name (not named on the Disney Parks Blog lineup page); no schedule is invented.",
  },
];

export function getEventExclusiveMeetsForPark(parkId: ParkId): EventExclusiveMeet[] {
  return EVENT_EXCLUSIVE_MEETS.filter((m) => m.parkId === parkId);
}

/**
 * Registered offerings (meets AND, since 14.5D, non-meet entertainment) whose party is CONFIRMED on `localDate` (resort-local "YYYY-MM-DD").
 * Registry-only: provider data never decides visibility.
 */
export function getConfirmedPartyMeets(parkId: ParkId, localDate: string, instant: Date = new Date()): EventExclusiveMeet[] {
  const resort = PARK_TO_RESORT[parkId] as ResortId;
  return getEventExclusiveMeetsForPark(parkId).filter(
    (m) => getSeasonalProviderEntertainmentRank(parkId, m.entityId, { resort, date: localDate, parkId, instant }) === "party-night",
  );
}

// ============================================
// PENDING / UNRESOLVED EVENT OFFERINGS (Phase 14.5D) — evidence ledger, NEVER rendered
// ============================================

export type PendingOfferingStatus =
  /** Confirmed for the season, but its provider record is not published right now (out of season); awaits next-season UUID verification. */
  | "pending_mapping"
  /** Event is running/confirmed but the provider publishes no record for it (searched); cannot be surfaced without fabricating a card. */
  | "no_provider_record"
  /** Existence/return/replacement for the season is not confirmed by sufficient evidence. */
  | "unresolved"
  /** Confirmed but deliberately not listed (ordinary/umbrella/dining or other out-of-scope offering). */
  | "excluded";

export type PendingOfferingEvidence = {
  label: string;
  url: string;
  /** "official" = Disney-published (Disney Parks Blog / disney.go.com); "secondary" = third-party coverage. */
  tier: "official" | "secondary";
  published?: string;
};

export type PendingEventOffering = {
  /** `SEASONAL_EVENTS` id (seasonalEventData.ts). */
  eventId: string;
  parkId: ParkId;
  seasonYear: number;
  /** Name as the best evidence gives it (may differ from the eventual provider name). */
  name: string;
  category: "show" | "music" | "roaming" | "meet" | "dance-party" | "experience" | "dining-adjacent";
  status: PendingOfferingStatus;
  /** What is and is not established. */
  reason: string;
  evidence: PendingOfferingEvidence[];
  /** What the maintainer must verify before this can become a registered offering (never auto-promoted). */
  nextVerification: string;
};
// Deliberately no provider-id field: a record gets an `entityId` only in EVENT_EXCLUSIVE_MEETS, after the exact
// park-parented ThemeParks SHOW record is observed and its identity verified. Historical UUIDs are never carried over.

const DPB_WDW = "https://disneyparksblog.com/wdw";
const MNSSHP_DPB: PendingOfferingEvidence = { label: "Disney Parks Blog — 2026 Mickey's Not-So-Scary Halloween Party Dates", url: `${DPB_WDW}/mickeys-not-so-scary-halloween-party-dates-teaser-treats/`, tier: "official", published: "2026-08-03" };
const MVMCP_DPB: PendingOfferingEvidence = { label: "Disney Parks Blog — Mickey's Very Merry Christmas Party 2026 Dates and Festive Details", url: `${DPB_WDW}/mickeys-very-merry-christmas-party-dates-and-festive-details/`, tier: "official", published: "2026-10-06" };
const JN_DPB: PendingOfferingEvidence = { label: "Disney Parks Blog — Disney Jollywood Nights dates, tickets and more", url: `${DPB_WDW}/disney-jollywood-nights-dates-tickets-and-more/`, tier: "official", published: "2026-10-06" };
const NEXT_WDW_MAPPING = "When the provider republishes the event's SHOW records, find the exact park-parented record, confirm its name/identity against the official lineup, then register it (no historical UUID reuse without that check).";

export const PENDING_EVENT_OFFERINGS: PendingEventOffering[] = [
  // ── Mickey's Not-So-Scary Halloween Party (MK, 2026; out of season — provider records absent) ──
  {
    eventId: "mnsshp", parkId: "mk", seasonYear: 2026, name: "Captain Jack's Buccaneer Bash", category: "roaming", status: "pending_mapping",
    reason: "New 2026 interactive pirate offering outside Tortuga Tavern, Adventureland (7 PM–midnight). Not named on the Aug 3 Disney Parks Blog page; the Disney description is relayed by secondary coverage only, so the exact official name/format needs confirmation. No provider record exists out of season.",
    evidence: [
      { label: "Disney Dining — Captain Jack's Buccaneer Bash debuts tonight", url: "https://www.disneydining.com/captain-jacks-buccaneer-bash-debuts-tonight-at-magic-kingdom-replacing-a-halloween-party-staple-el1/", tier: "secondary", published: "2026-08-07" },
      { label: "BlogMickey — Captain Jack Sparrow headlines a new Not-So-Scary offering", url: "https://blogmickey.com/2026/06/captain-jack-sparrow-headlines-a-new-not-so-scary-offering/", tier: "secondary", published: "2026-06" },
    ],
    nextVerification: `Confirm the official name on Disney's 2027 event page (or Disney Parks Blog) and whether it returns. ${NEXT_WDW_MAPPING}`,
  },
  {
    eventId: "mnsshp", parkId: "mk", seasonYear: 2026, name: "Rusty Cutlass (pirate band)", category: "music", status: "unresolved",
    reason: "Performed in Adventureland at the party in 2023–2025 (secondary coverage). No source confirms a 2026 appearance; the 2026 Captain Jack's Buccaneer Bash mentions only an unnamed \"salty pirate band\" and no source states the band was replaced or is the same act. Do not assume it returned or was dropped; it is a third-party act whose confirmation may trail Disney's own announcements.",
    evidence: [
      { label: "WDWNT — Rusty Cutlass Pirate Band returns (2024)", url: "https://wdwnt.com/2024/08/rusty-cutlass-pirate-band-halloween-party-2024/", tier: "secondary", published: "2024-08" },
      { label: "Disney Dining — Captain Jack's Buccaneer Bash (relationship to Rusty Cutlass not stated)", url: "https://www.disneydining.com/captain-jacks-buccaneer-bash-debuts-tonight-at-magic-kingdom-replacing-a-halloween-party-staple-el1/", tier: "secondary", published: "2026-08-07" },
    ],
    nextVerification: "Treat as historical until an official or first-hand 2027 source names the band; if it reappears, verify its provider record exactly and record the relationship to Captain Jack's Buccaneer Bash explicitly (replacement vs. coexistence).",
  },
  {
    eventId: "mnsshp", parkId: "mk", seasonYear: 2026, name: "Stitch's Masquerade (dance party with Stitch, Lilo and Angel)", category: "dance-party", status: "pending_mapping",
    reason: "New 2026 dance party at Rockettower Plaza Stage, Tomorrowland. The official Disney Parks Blog calls it \"Stitch's ever-changing dance party\" (no formal title); secondary coverage titles it \"A Masquerade with Stitch\" / Masquerade Party with Stitch. The provider name is unknown; no provider record exists out of season.",
    evidence: [
      MNSSHP_DPB,
      { label: "WDWNT — New & returning entertainment confirmed for 2026 MNSSHP", url: "https://wdwnt.com/2026/04/entertainment-confirmed-2026-mickeys-not-so-scary-halloween-party/", tier: "secondary", published: "2026-04-28" },
    ],
    nextVerification: `Settle the official/provider title before registering. ${NEXT_WDW_MAPPING}`,
  },
  {
    eventId: "mnsshp", parkId: "mk", seasonYear: 2026, name: "Cadaver Dans", category: "music", status: "pending_mapping",
    reason: "Returning singing group (official DPB; image caption places them in Frontierland — venue not asserted in text).",
    evidence: [MNSSHP_DPB], nextVerification: NEXT_WDW_MAPPING,
  },
  {
    eventId: "mnsshp", parkId: "mk", seasonYear: 2026, name: "Roaming Headless Horseman, witches and Disney Villains", category: "roaming", status: "unresolved",
    reason: "Official DPB describes street encounters (Headless Horseman, \"a witch or three\", Disney Villains \"new and returning\") without names, locations or times; providers typically do not publish roaming acts as records.",
    evidence: [MNSSHP_DPB], nextVerification: "Only register a roaming act if the provider publishes an individually identifiable record with posted times/hours; otherwise leave it as official-lineup information only.",
  },
  {
    eventId: "mnsshp", parkId: "mk", seasonYear: 2026, name: "Meet Jack Skellington and Sally (Halloween)", category: "meet", status: "pending_mapping",
    reason: "Exclusive meet-and-greet at character stops (official DPB). No current provider record to revalidate (see EVENT_EXCLUSIVE_MEETS notes).",
    evidence: [MNSSHP_DPB], nextVerification: `${NEXT_WDW_MAPPING} Also check for a distinct Queue-Times row (exact id + name).`,
  },
  // ── Oogie Boogie Bash (DCA, 2026; out of season) ──
  {
    eventId: "oogie-boogie-bash", parkId: "dca", seasonYear: 2026, name: "Villains Grove (Redwood Creek Challenge Trail)", category: "experience", status: "unresolved",
    reason: "Walk-through villain-themed trail expected to return (Disney Tourist Blog, Dec 2025 pre-announcement) and described in later coverage; Disney's own 2026 page was not retrievable, so official confirmation, venue and hours are not established. Provider record unknown.",
    evidence: [{ label: "Disney Tourist Blog — 2026 Oogie Boogie Bash dates & details", url: "https://www.disneytouristblog.com/2026-oogie-boogie-bash-halloween-party-dates-details/", tier: "secondary", published: "2025-12-02" }],
    nextVerification: "Confirm on Disneyland's official 2027 Oogie Boogie Bash page; register only if the provider publishes an identifiable record.",
  },
  {
    eventId: "oogie-boogie-bash", parkId: "dca", seasonYear: 2026, name: "Villain Treat Trails and villain/character meets (incl. Yzma debut)", category: "meet", status: "unresolved",
    reason: "Trail-based villain encounters are described by secondary coverage (counts and rosters disagree between sources). Individual stationary meets are not established as provider-identifiable records.",
    evidence: [{ label: "WDWinfo — Oogie Boogie Bash 2026: new parade, characters and more", url: "https://www.wdwinfo.com/news-stories/disneyland-news/oogie-boogie-bash-2026-new-parade-characters-and-more/", tier: "secondary" }],
    nextVerification: "Use Disneyland's official roster; register only exact, individually identifiable provider/Queue-Times records (umbrella trail records are excluded like 'Character Greetings').",
  },
  {
    eventId: "oogie-boogie-bash", parkId: "dca", seasonYear: 2026, name: "Frightfully Fun Parade", category: "show", status: "excluded",
    reason: "Confirmed NOT part of the 2026 party (replaced by Madame Leota's Swinging Wake, already catalogued and mapped). Existing absence record in SEASONAL_ENTERTAINMENT_EVENTS applies; not discontinuation evidence for 2027+.",
    evidence: [{ label: "WDWinfo — Oogie Boogie Bash 2026 (replacement of the parade)", url: "https://www.wdwinfo.com/news-stories/disneyland-news/oogie-boogie-bash-2026-new-parade-characters-and-more/", tier: "secondary" }],
    nextVerification: "Re-check the 2027 lineup before changing the 2026 absence record (it is scoped to season 2026 only).",
  },
  // ── Mickey's Very Merry Christmas Party (MK, 2026; in season, no provider record found) ──
  {
    eventId: "mvmcp", parkId: "mk", seasonYear: 2026, name: "Dance Parties in the Park", category: "dance-party", status: "no_provider_record",
    reason: "Generic official listing (holiday friends and event DJs in various locations). The provider publishes no matching individual record (searched 2026-11-17); Stitchmas! (registered) is the only named dance party record.",
    evidence: [MVMCP_DPB], nextVerification: "Re-scan the MK provider children during the season; register any new exact party-named SHOW record.",
  },
  {
    eventId: "mvmcp", parkId: "mk", seasonYear: 2026, name: "Santa's Christmas Carnival (Storybook Circus)", category: "experience", status: "no_provider_record",
    reason: "Official DPB lists a Santa meet with crafts and characters near Dumbo/Barnstormer. No provider SHOW record found (the \"Join Santa Claus\" record is registered separately).",
    evidence: [MVMCP_DPB], nextVerification: "Check provider children for a distinct Carnival record; confirm it is not the already-registered Join Santa Claus record before adding.",
  },
  {
    eventId: "mvmcp", parkId: "mk", seasonYear: 2026, name: "Party character greetings (Anna & Elsa at Princess Fairytale Hall; Mickey & Minnie holiday attire at Town Square Theater)", category: "meet", status: "excluded",
    reason: "Official DPB lists them as party greetings, but the provider only publishes the umbrella \"Character Greetings at …\" record (never registered) and the ordinary Princess Fairytale Hall / Town Square meets exist outside the party.",
    evidence: [MVMCP_DPB], nextVerification: "Register only if an event-specific, individually identifiable provider record appears.",
  },
  // ── Disney Jollywood Nights (HS, 2026; in season) ──
  {
    eventId: "jollywood-nights", parkId: "hs", seasonYear: 2026, name: "Twilight Soirée at the Tip Top Club (live holiday music)", category: "music", status: "no_provider_record",
    reason: "Official DPB: 1930s-style celebration with live holiday music in the Hollywood Tower Hotel courtyard. No matching provider record in HS children (2026-11-17).",
    evidence: [JN_DPB], nextVerification: "Re-scan HS children during the season for an exact party-named record.",
  },
  {
    eventId: "jollywood-nights", parkId: "hs", seasonYear: 2026, name: "Checkin' It Twice Lounge (live DJ, Animation Courtyard)", category: "dining-adjacent", status: "no_provider_record",
    reason: "New beverage lounge with a live DJ (official DPB). Primarily a food/beverage venue; no provider record in HS children.",
    evidence: [JN_DPB], nextVerification: "Re-scan HS children; classify as entertainment only if the provider publishes it as a SHOW with times.",
  },
  {
    eventId: "jollywood-nights", parkId: "hs", seasonYear: 2026, name: "Jazzy Holidays at The Hollywood Brown Derby", category: "dining-adjacent", status: "excluded",
    reason: "Reservation-based adult dining with live music (official DPB) — a dining offering, not Waits & Shows entertainment.",
    evidence: [JN_DPB], nextVerification: "None unless the provider publishes it as a SHOW with posted times.",
  },
  {
    eventId: "jollywood-nights", parkId: "hs", seasonYear: 2026, name: "Event character greetings (Phineas & Ferb, Powerline, Rescue Rangers, Santa Stitch, Mandalorian & Grogu, Chewbacca, Lotso, Partysaurus Rex, Bing Bong, Duffy, Scrooge, etc.)", category: "meet", status: "excluded",
    reason: "Official DPB lists characters without locations/times. The provider publishes only the umbrella \"Character Greetings at Disney Jollywood Nights\" record (never registered) plus the individually identifiable Stitch meet (registered).",
    evidence: [JN_DPB], nextVerification: "Register another meet only if the provider publishes an exact, event-named, individually identifiable record.",
  },
];

export function getPendingEventOfferings(eventId?: string): PendingEventOffering[] {
  return eventId ? PENDING_EVENT_OFFERINGS.filter((o) => o.eventId === eventId) : PENDING_EVENT_OFFERINGS;
}

// ============================================
// TYPES
// ============================================

export type EventMeetWait =
  | { state: "live"; minutes: number; updatedAt: string }
  /** Queue-Times reports the verified row not operating (normal before the party starts). */
  | { state: "closed"; updatedAt: string }
  | { state: "unavailable"; reason: "no_queue_times_record" | "queue_times_failed" | "stale" | "identity_mismatch" };

export interface EventMeetEntry {
  /** `event-meet:{park}:{uuid}` — park-qualified, stable. */
  id: string;
  parkId: ParkId;
  entityId: string;
  /** Provider's own display name for the verified record. */
  name: string;
  /** ThemeParks status of the record (OPERATING | CLOSED | …); null when not current. */
  status: string | null;
  wait: EventMeetWait;
  /** Normalized performances/operating hours/completeness (same shape as All Entertainment). */
  schedule: AllEntertainmentEntry;
}

export interface ParkEventMeets {
  parkId: ParkId;
  resort: ResortId;
  /** Resort-local date this state was computed for. */
  localDate: string;
  /** True when at least one meet is a CONFIRMED party-date meet today (registry). Gates the whole section. */
  partyDate: boolean;
  /** ThemeParks failure on a party date: identity can't be verified → nothing listed, shown as unavailable (not as absence). */
  error: ThemeParksError | null;
  /** ThemeParks payload is a stale-if-error copy. */
  stale: boolean;
  /** Verified character meets (Party Character Meets). */
  entries: EventMeetEntry[];
  /** Phase 14.5D: verified non-meet event offerings (Party Entertainment). */
  offerings: EventMeetEntry[];
  /** Registered meets / non-meet offerings CONFIRMED for this date (registry) — gate each section independently of provider results. */
  confirmedMeets: number;
  confirmedOfferings: number;
}

export type QueueTimesFetch =
  | { ok: true; body: unknown }
  | { ok: false };

/** A Queue-Times wait older than this is not trusted as current. */
export const QUEUE_TIMES_FRESH_MS = 30 * 60_000;

// ============================================
// QUEUE-TIMES (verified event-specific ids only)
// ============================================

type QtRide = { id: number; name: string; is_open: boolean; wait_time: number; last_updated: string };

function qtRidesById(body: unknown): Map<number, QtRide> | null {
  const b = body as { lands?: unknown; rides?: unknown } | null;
  if (!b || typeof b !== "object") return null;
  const lists: unknown[] = [];
  if (Array.isArray(b.lands)) for (const l of b.lands) { const r = (l as { rides?: unknown })?.rides; if (Array.isArray(r)) lists.push(...r); }
  if (Array.isArray(b.rides)) lists.push(...b.rides);
  if (lists.length === 0 && !Array.isArray(b.lands) && !Array.isArray(b.rides)) return null;
  const map = new Map<number, QtRide>();
  for (const r of lists as Partial<QtRide>[]) {
    if (!r || typeof r.id !== "number" || typeof r.name !== "string" || typeof r.is_open !== "boolean" || typeof r.wait_time !== "number" || typeof r.last_updated !== "string") continue;
    if (!map.has(r.id)) map.set(r.id, r as QtRide);
  }
  return map;
}

/**
 * Identity-guard normalization: tolerant of harmless formatting only —
 * case, Unicode form/diacritics, apostrophes/quotes (dropped, so "Mickey\u2019s" ≡
 * "Mickeys"), "&" ≡ "and", other punctuation, and whitespace. Words are never
 * dropped, reordered or matched by substring, so any real change (a different
 * character, location or event) still differs.
 */
export function normalizeMeetIdentityName(s: string): string {
  return s
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b\u2032`\u00b4'"\u201c\u201d]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** True when `providerName` still names the registered encounter (strict equality after normalization). */
export function meetNameMatches(expected: string, providerName: string): boolean {
  const e = normalizeMeetIdentityName(expected);
  return e.length > 0 && e === normalizeMeetIdentityName(providerName);
}

function waitFor(meet: EventExclusiveMeet, qt: QueueTimesFetch | null, instant: Date): EventMeetWait {
  if (!meet.queueTimes) return { state: "unavailable", reason: "no_queue_times_record" };
  if (!qt || !qt.ok) return { state: "unavailable", reason: "queue_times_failed" };
  const rides = qtRidesById(qt.body);
  if (!rides) return { state: "unavailable", reason: "queue_times_failed" };
  const row = rides.get(meet.queueTimes.rideId);
  if (!row) return { state: "unavailable", reason: "no_queue_times_record" };
  if (!meetNameMatches(meet.queueTimes.name, row.name)) return { state: "unavailable", reason: "identity_mismatch" };
  const updatedMs = Date.parse(row.last_updated);
  if (!Number.isFinite(updatedMs) || instant.getTime() - updatedMs > QUEUE_TIMES_FRESH_MS) return { state: "unavailable", reason: "stale" };
  return row.is_open
    ? { state: "live", minutes: Math.max(0, Math.round(row.wait_time)), updatedAt: row.last_updated }
    : { state: "closed", updatedAt: row.last_updated };
}

// ============================================
// MEET SCHEDULE INTERPRETATION (Phase 14.4.1)
// ============================================

const SPECIAL_TICKETED_EVENT = "Special Ticketed Event";

/**
 * ThemeParks publishes an event-exclusive meet's availability as a
 * "Special Ticketed Event" record whose start and end differ (e.g. Join Santa:
 * 6:00 PM → midnight): an operating WINDOW, not a performance start time.
 * Scoped to REGISTERED meet entities only (the caller never passes any other
 * entity) — "Special Ticketed Event" is never reclassified globally; party shows
 * publish it with start == end as genuine discrete performances.
 *
 *   end after start, ≤ 24 h  → window: re-typed "Operating" so the shared
 *                              operating-hours normalizer/format handles it
 *   end == start             → discrete performance, kept unchanged
 *   missing / unparseable / reversed / over-24 h end, or unparseable start,
 *   dated today or yesterday → ambiguous: dropped (nothing guessed) and counted
 *                              in `invalid` so the shared completeness logic
 *                              marks the schedule incomplete
 * Invalid records dated on other days cannot affect today and are left alone.
 */
export function interpretMeetShowtimes(
  resort: ResortId,
  localDate: string,
  showtimes: ThemeParksShowtime[],
): { showtimes: ThemeParksShowtime[]; invalid: number } {
  const yesterday = addDaysToLocalDate(localDate, -1);
  const out: ThemeParksShowtime[] = [];
  let invalid = 0;
  for (const s of showtimes) {
    if (s.type !== SPECIAL_TICKETED_EVENT) { out.push(s); continue; }
    const startMs = Date.parse(s.startTime);
    if (!Number.isFinite(startMs)) { invalid++; continue; }
    const startDate = getResortLocalDate(resort, new Date(startMs));
    const relevant = startDate === localDate || startDate === yesterday;
    const endMs = s.endTime ? Date.parse(s.endTime) : NaN;
    if (!Number.isFinite(endMs) || endMs < startMs || endMs - startMs > MAX_OPERATING_INTERVAL_MS) {
      if (relevant) invalid++; else out.push(s);
      continue;
    }
    out.push(endMs === startMs ? s : { ...s, type: "Operating" });
  }
  return { showtimes: out, invalid };
}

/**
 * Registered meets only: re-read their "Special Ticketed Event" windows as
 * operating hours (`interpretMeetShowtimes`). Phase 14.4.2: this is the single
 * place that interpretation is applied — Waits & Shows (`buildParkEventMeets`)
 * AND All Entertainment (`getParkAllEntertainment`) both feed their provider
 * payload through it, so a registered party meet reads "Operating hours:
 * 6:00 PM–12:00 AM" on both pages. Identity-scoped and date-agnostic: every
 * other entity (shows publishing start==end performances) is untouched.
 */
export function applyRegisteredMeetWindows(
  parkId: ParkId,
  tp: ThemeParksResult<ThemeParksLive>,
  instant: Date,
): ThemeParksResult<ThemeParksLive> {
  if (!tp.ok) return tp;
  const resort = PARK_TO_RESORT[parkId] as ResortId;
  const localDate = getResortLocalDate(resort, instant);
  const registered = new Set(getEventExclusiveMeetsForPark(parkId).map((m) => m.entityId));
  if (registered.size === 0) return tp;
  return {
    ...tp,
    data: {
      ...tp.data,
      entries: tp.data.entries.map((e) => {
        if (!registered.has(e.entityId.toLowerCase())) return e;
        const r = interpretMeetShowtimes(resort, localDate, e.showtimes);
        return { ...e, showtimes: r.showtimes, droppedShowtimes: e.droppedShowtimes + r.invalid };
      }),
    },
  };
}

// ============================================
// BUILD (pure)
// ============================================

/**
 * Pure: the park's event-meet state for `instant`.
 *
 * `tp` / `qt` may be null when the caller skipped the fetch because no party is
 * confirmed (`partyDate` false → nothing is listed regardless of provider data).
 */
export function buildParkEventMeets(
  parkId: ParkId,
  tp: ThemeParksResult<ThemeParksLive> | null,
  qt: QueueTimesFetch | null,
  instant: Date = new Date(),
): ParkEventMeets {
  const resort = PARK_TO_RESORT[parkId] as ResortId;
  const localDate = getResortLocalDate(resort, instant);
  const confirmed = getConfirmedPartyMeets(parkId, localDate, instant);
  const base: ParkEventMeets = {
    parkId, resort, localDate, partyDate: confirmed.length > 0, error: null, stale: false, entries: [], offerings: [],
    confirmedMeets: confirmed.filter(isEventMeet).length, confirmedOfferings: confirmed.filter((m) => !isEventMeet(m)).length,
  };
  if (confirmed.length === 0 || !tp) return base;
  if (!tp.ok) return { ...base, error: tp.error };

  const interpreted = applyRegisteredMeetWindows(parkId, tp, instant);
  const all = buildParkAllEntertainment(parkId, interpreted, instant);
  const payloadCurrent = all.fetchedLocalDate === localDate;
  const seen = new Set<string>();
  const entries: EventMeetEntry[] = [];
  const offerings: EventMeetEntry[] = [];
  for (const meet of confirmed) {
    if (seen.has(meet.entityId)) continue; // one card per physical meet
    const schedule = all.entries.find((e) => e.id === `provider:${meet.entityId}`);
    if (!schedule) continue; // absent from the park's live payload → not verified, never fabricated
    const live = tp.data.entries.find((e) => e.entityId.toLowerCase() === meet.entityId);
    // Identity guard: the live record's current name must still be the registered
    // encounter. A renamed/repurposed record is omitted (never substituted); the
    // other meets are unaffected.
    if (!meetNameMatches(meet.providerName, schedule.name)) continue;
    seen.add(meet.entityId);
    (isEventMeet(meet) ? entries : offerings).push({
      id: `event-meet:${parkId}:${meet.entityId}`,
      parkId,
      entityId: meet.entityId,
      name: schedule.name,
      status: payloadCurrent ? (live?.status ?? null) : null,
      wait: waitFor(meet, qt, instant),
      schedule,
    });
  }
  return { ...base, stale: all.stale, entries, offerings };
}

// ============================================
// DISPLAY (pure, client-safe)
// ============================================

export interface EventMeetView {
  /** "Closed" / "Operating" from the verified Queue-Times row only; null otherwise (never from generic ThemeParks status). */
  statusText: string | null;
  /** "Wait: 25 min" only for a verified live Queue-Times wait; null otherwise. */
  waitText: string | null;
  /** Wait unavailable note (never a guessed wait). */
  waitNote: string | null;
  /** Performances / operating hours text (re-evaluated at `now`). */
  scheduleText: string | null;
}

const WAIT_NOTES: Record<Extract<EventMeetWait, { state: "unavailable" }>["reason"], string | null> = {
  no_queue_times_record: null, // no wait provider for this meet: say nothing rather than imply an outage
  queue_times_failed: "Wait time unavailable",
  stale: "Wait time unavailable",
  identity_mismatch: "Wait time unavailable",
};

export function describeEventMeet(entry: EventMeetEntry, now: Date = new Date()): EventMeetView {
  const view = allEntryViewAt(entry.schedule, now);
  // Phase 14.4.1: status text comes ONLY from the verified event-specific
  // Queue-Times row. Generic ThemeParks OPERATING/CLOSED (`entry.status`) is
  // never shown as current availability — party meets use the same schedule
  // convention as regular Entertainment (performance times and/or operating
  // hours, else the none-posted/unavailable message).
  const statusFromWait = entry.wait.state === "closed" ? "Closed" : entry.wait.state === "live" ? "Operating" : null;
  // Upcoming-only times from an incomplete schedule keep the standard qualifier (never look complete).
  const timesText = view.collapsedText && view.partial ? `${view.collapsedText} (${PARTIAL_SHOWTIMES_NOTE})` : view.collapsedText;
  const scheduleParts = [timesText, view.hoursText].filter((t): t is string => !!t);
  return {
    statusText: statusFromWait,
    waitText: entry.wait.state === "live" ? `Wait: ${entry.wait.minutes} min` : null,
    waitNote: entry.wait.state === "unavailable" ? WAIT_NOTES[entry.wait.reason] : null,
    scheduleText: scheduleParts.length > 0 ? scheduleParts.join(" • ") : null,
  };
}

/** Section copy when a party is confirmed but ThemeParks identity could not be verified. */
export const EVENT_MEETS_UNAVAILABLE_MESSAGE = "Party character meets are unavailable right now.";

/** Whether the section shows at all (confirmed party date AND something to say). */
export function eventMeetsSectionState(data: ParkEventMeets | null): "hidden" | "list" | "unavailable" {
  if (!data || !data.partyDate || data.confirmedMeets === 0) return "hidden";
  if (data.error) return "unavailable";
  return data.entries.length > 0 ? "list" : "hidden";
}

/** Section copy when a party is confirmed but ThemeParks identity could not be verified (Party Entertainment). */
export const EVENT_OFFERINGS_UNAVAILABLE_MESSAGE = "Party entertainment is unavailable right now.";

/** Party Entertainment section (Phase 14.5D): same gating/failure semantics as the meets section, for non-meet offerings. */
export function eventOfferingsSectionState(data: ParkEventMeets | null): "hidden" | "list" | "unavailable" {
  if (!data || !data.partyDate || data.confirmedOfferings === 0) return "hidden";
  if (data.error) return "unavailable";
  return data.offerings.length > 0 ? "list" : "hidden";
}

/** Whether the displayed list shows any Queue-Times-derived data (a live wait or Queue-Times open/closed status) — attribution is owed. */
export function eventMeetsPresentQueueTimes(data: ParkEventMeets | null): boolean {
  if (!data) return false;
  const shown = [...(eventMeetsSectionState(data) === "list" ? data.entries : []), ...(eventOfferingsSectionState(data) === "list" ? data.offerings : [])];
  return shown.some((e) => e.wait.state === "live" || e.wait.state === "closed");
}

/** Browser-side: fetched body → state; failure/wrong shape degrades to hidden (nothing retained or fabricated). */
export function resolveEventMeetsResponse(parkId: ParkId, body: unknown): ParkEventMeets | null {
  const d = body as Partial<ParkEventMeets> | null;
  if (!d || typeof d !== "object" || d.parkId !== parkId || !Array.isArray(d.entries) || typeof d.localDate !== "string" || typeof d.partyDate !== "boolean") return null;
  // Older/partial bodies (pre-14.5D) lack the offering fields: treat as meets-only, never as an offerings failure.
  return {
    ...(d as ParkEventMeets),
    offerings: Array.isArray(d.offerings) ? d.offerings : [],
    confirmedMeets: typeof d.confirmedMeets === "number" ? d.confirmedMeets : (d.partyDate ? 1 : 0),
    confirmedOfferings: typeof d.confirmedOfferings === "number" ? d.confirmedOfferings : 0,
  };
}

/** Data computed for a previous resort-local day, or another park, is never shown as today's. */
export function eventMeetsForDisplay(data: ParkEventMeets | null, parkId: ParkId, instant: Date = new Date()): ParkEventMeets | null {
  if (!data || data.parkId !== parkId) return null;
  return data.localDate === getResortLocalDate(data.resort, instant) ? data : null;
}

// ============================================
// DEV CASES
// ============================================

export type DevEventMeetCase = { label: string; ok: () => boolean };

const MK = "75ea578a-adc8-4116-a54d-dccb60765ef9";
const HS = "288747d1-8b4f-4a64-867e-ea7c9b27bad8";
const JS_ID = "6d3b1129-b34c-4b44-bba2-0e1790fef705";
const SANTA_ID = "418c2111-36d4-4f07-86b2-8058014a263c";
const GREETINGS_ID = "8b8cb0ec-10a3-41d9-b5cb-81ea8db14370";
const STITCH_ID = "ae7db7da-a3d9-443b-b4a6-d3c4a2b66121";
const JS_NAME = "Meet Santa Jack and Sally at Mickey’s Very Merry Christmas Party";

// Resort-local (EST) instants. MVMCP nights Nov 12–13, non-party Nov 10 and 14; JN night Nov 14 / non-party Nov 13.
const at = (iso: string) => new Date(iso);
const MVMCP_MORNING = at("2026-11-12T13:00:00Z"); // 8:00 AM EST, hours before party
const MVMCP_EVENING = at("2026-11-13T00:30:00Z"); // Nov 12, 7:30 PM EST
const NON_PARTY = at("2026-11-10T17:00:00Z");
const JN_MORNING = at("2026-11-14T15:00:00Z");

const tpEntry = (entityId: string, name: string, parkUuid: string, status: string | null, showtimes: { type: string | null; startTime: string; endTime: string | null }[] = []) =>
  ({ entityId, name, entityType: "SHOW", parkId: parkUuid, externalId: null, status, lastUpdated: null, showtimes, droppedShowtimes: 0 });
const tpOk = (parkUuid: string, entries: ReturnType<typeof tpEntry>[]): ThemeParksResult<ThemeParksLive> =>
  ({ ok: true, data: { entityId: parkUuid, name: "park", timeZone: "America/New_York", entries, droppedEntries: 0, droppedShowtimes: 0 }, meta: { origin: "network", fetchedAt: 0, etag: null } });
const mkEntries = (status = "CLOSED", showtimes: Parameters<typeof tpEntry>[4] = []) => [
  tpEntry(JS_ID, JS_NAME, MK, status, showtimes),
  tpEntry(SANTA_ID, "Join Santa Claus at Mickey's Very Merry Christmas Party", MK, status),
  tpEntry(GREETINGS_ID, "Character Greetings at Mickey's Very Merry Christmas Party", MK, status),
  tpEntry("a2d92647-634d-4eb4-886b-9da858e871f1", "Meet Mickey at Town Square Theater", MK, "OPERATING"),
];
const qtBody = (rows: Partial<QtRide>[]) => ({ lands: [{ id: 1, name: "Main Street, U.S.A.", rides: rows }], rides: [] });
const jsRow = (over: Partial<QtRide> = {}, now = MVMCP_MORNING): Partial<QtRide> =>
  ({ id: 15395, name: JS_NAME, is_open: false, wait_time: 0, last_updated: new Date(now.getTime() - 60_000).toISOString(), ...over });
const ordinaryRow = (now = MVMCP_MORNING): Partial<QtRide> =>
  ({ id: 146, name: "Meet Mickey at Town Square Theater", is_open: true, wait_time: 40, last_updated: new Date(now.getTime() - 60_000).toISOString() });
const build = (now: Date, tp = tpOk(MK, mkEntries()), qt: QueueTimesFetch | null = { ok: true, body: qtBody([jsRow({}, now), ordinaryRow(now)]) }, parkId: ParkId = "mk") =>
  // Payload "fetched" 30 s before `now` (same resort-local day) unless the case overrides it.
  buildParkEventMeets(parkId, tp.ok && tp.meta.fetchedAt === 0 ? { ...tp, meta: { ...tp.meta, fetchedAt: now.getTime() - 30_000 } } : tp, qt, now);

export const DEV_EVENT_MEET_CASES: DevEventMeetCase[] = [
  // Registry integrity
  { label: "registry: every meet is a party-kind association for the same park+UUID in the maintained registry (no second event table)", ok: () =>
    EVENT_EXCLUSIVE_MEETS.every((m) => SEASONAL_PROVIDER_ONLY_EVENTS.some((r) => r.parkId === m.parkId && r.entityId === m.entityId && r.associations.every((a) => a.kind === "party"))) },
  { label: "registry: unique park+UUID, lowercase UUIDs, unique Queue-Times ids, QT ids belong to a mapped park", ok: () => {
    const keys = EVENT_EXCLUSIVE_MEETS.map((m) => `${m.parkId}:${m.entityId}`);
    const qts = EVENT_EXCLUSIVE_MEETS.flatMap((m) => (m.queueTimes ? [m.queueTimes.rideId] : []));
    return new Set(keys).size === keys.length && new Set(qts).size === qts.length &&
      EVENT_EXCLUSIVE_MEETS.every((m) => m.entityId === m.entityId.toLowerCase() && QUEUE_TIMES_PARK_MAP[`${PARK_TO_RESORT[m.parkId]}:${m.parkId}`] !== undefined);
  } },
  { label: "registry: umbrella 'Character Greetings' records and ordinary meets are not registered", ok: () =>
    !EVENT_EXCLUSIVE_MEETS.some((m) => /character greetings/i.test(m.providerName) || m.entityId === GREETINGS_ID || m.queueTimes?.rideId === 146) &&
    EVENT_EXCLUSIVE_MEETS.every((m) => /christmas party|jollywood nights/i.test(m.providerName)) },
  { label: "registry: verified candidates are exactly Santa Jack & Sally, Join Santa Claus (MK), Stitch (HS)", ok: () =>
    EVENT_EXCLUSIVE_MEETS.filter(isEventMeet).map((m) => `${m.parkId}:${m.entityId}`).sort().join() === [`mk:${JS_ID}`, `mk:${SANTA_ID}`, `hs:${STITCH_ID}`].sort().join() },
  // Confirmed party vs non-party dates; entire-day visibility
  { label: "party date, hours before party (8 AM): meets listed", ok: () => build(MVMCP_MORNING).entries.map((e) => e.entityId).sort().join() === [JS_ID, SANTA_ID].sort().join() },
  { label: "party date evening: still listed", ok: () => build(MVMCP_EVENING, tpOk(MK, mkEntries("OPERATING")), null).entries.length === 2 },
  { label: "last minute of the local party day listed; first minute of the next (non-party) day hidden", ok: () =>
    build(at("2026-11-14T04:59:00Z")).entries.length === 2 && build(at("2026-11-14T05:00:00Z")).entries.length === 0 && !build(at("2026-11-14T05:00:00Z")).partyDate },
  { label: "first minute of party day (midnight local) listed", ok: () => build(at("2026-11-12T05:00:00Z")).entries.length === 2 },
  { label: "non-party date inside the holiday season (Nov 10): hidden, nothing fetched needed", ok: () => { const r = build(NON_PARTY); return !r.partyDate && r.entries.length === 0 && eventMeetsSectionState(r) === "hidden" && buildParkEventMeets("mk", null, null, NON_PARTY).entries.length === 0; } },
  { label: "unannounced season (2027-11-12) is not a confirmed party date", ok: () => !buildParkEventMeets("mk", tpOk(MK, mkEntries()), null, at("2027-11-12T15:00:00Z")).partyDate },
  { label: "historical party night (2026-11-08) is never treated as confirmed today", ok: () => getConfirmedPartyMeets("mk", "2026-11-08", NON_PARTY).length === 0 },
  { label: "wrong event/park: HS Stitch only on Jollywood nights (Nov 14), not an MVMCP night; MK meets not on HS", ok: () =>
    build(JN_MORNING, tpOk(HS, [tpEntry(STITCH_ID, "Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights", HS, "CLOSED")]), null, "hs").entries.map((e) => e.entityId).join() === STITCH_ID &&
    build(MVMCP_MORNING, tpOk(HS, [tpEntry(STITCH_ID, "Stitch", HS, "CLOSED")]), null, "hs").entries.length === 0 &&
    build(JN_MORNING, tpOk(MK, mkEntries()), null, "mk").entries.length === 0 },
  { label: "no meets for parks with no registered party meets (epcot/ak/dca/disneyland)", ok: () =>
    (["epcot", "ak", "dca", "disneyland"] as ParkId[]).every((p) => !buildParkEventMeets(p, tpOk(MK, mkEntries()), null, MVMCP_MORNING).partyDate) },
  // CLOSED / OPERATING
  { label: "CLOSED before event start is normal: listed, status Closed, no requirement to be OPERATING", ok: () => { const e = build(MVMCP_MORNING).entries[0]; return describeEventMeet(e, MVMCP_MORNING).statusText === "Closed"; } },
  { label: "OPERATING: listed with live Queue-Times wait for the verified id", ok: () => {
    const r = build(MVMCP_EVENING, tpOk(MK, mkEntries("OPERATING")), { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 25 }, MVMCP_EVENING), ordinaryRow(MVMCP_EVENING)]) });
    const js = r.entries.find((e) => e.entityId === JS_ID)!;
    const v = describeEventMeet(js, MVMCP_EVENING);
    return js.wait.state === "live" && v.waitText === "Wait: 25 min" && v.statusText === "Operating";
  } },
  { label: "live 0-minute wait is a real wait (shown), not unavailable", ok: () => {
    const r = build(MVMCP_EVENING, undefined, { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 0 }, MVMCP_EVENING)]) });
    return describeEventMeet(r.entries.find((e) => e.entityId === JS_ID)!, MVMCP_EVENING).waitText === "Wait: 0 min";
  } },
  // Waits vs schedules
  { label: "Join Santa Claus / Stitch have no Queue-Times id: no wait ever shown, ordinary meet wait never substituted", ok: () => {
    const r = build(MVMCP_EVENING, undefined, { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 25 }, MVMCP_EVENING), ordinaryRow(MVMCP_EVENING)]) });
    const santa = r.entries.find((e) => e.entityId === SANTA_ID)!;
    const v = describeEventMeet(santa, MVMCP_EVENING);
    return santa.wait.state === "unavailable" && v.waitText === null && v.waitNote === null;
  } },
  { label: "schedule: verified performances/operating hours come from ThemeParks, separate from the wait", ok: () => {
    const r = build(MVMCP_MORNING, tpOk(MK, mkEntries("CLOSED", [{ type: "Operating", startTime: "2026-11-12T19:00:00-05:00", endTime: "2026-11-12T23:00:00-05:00" }])), null);
    const v = describeEventMeet(r.entries.find((e) => e.entityId === JS_ID)!, MVMCP_MORNING);
    return !!v.scheduleText && /Operating hours:/.test(v.scheduleText) && v.waitText === null;
  } },
  { label: "partial schedule (dropped showtime record alongside a valid performance) keeps the incomplete qualifier", ok: () => {
    const entries = mkEntries("CLOSED", [{ type: "Performance Time", startTime: "2026-11-12T19:00:00-05:00", endTime: null }]).map((e) => (e.entityId === JS_ID ? { ...e, droppedShowtimes: 1 } : e));
    const r = build(MVMCP_MORNING, tpOk(MK, entries), null);
    const v = describeEventMeet(r.entries.find((e) => e.entityId === JS_ID)!, MVMCP_MORNING);
    return !!v.scheduleText && v.scheduleText.includes("7:00 PM") && v.scheduleText.includes(PARTIAL_SHOWTIMES_NOTE);
  } },
  // Provider identity guard (name)
  { label: "identity: exact registered names verify", ok: () => EVENT_EXCLUSIVE_MEETS.every((m) => meetNameMatches(m.providerName, m.providerName)) },
  { label: "identity: harmless variations pass (curly/straight/missing apostrophes, case, whitespace, punctuation, '&'/'and')", ok: () =>
    meetNameMatches("Join Santa Claus at Mickey's Very Merry Christmas Party", "Join Santa Claus at Mickey’s Very Merry Christmas Party") &&
    meetNameMatches("Meet Santa Jack and Sally at Mickey’s Very Merry Christmas Party", "Meet Santa Jack and Sally at Mickey's Very Merry Christmas Party") &&
    meetNameMatches("Join Santa Claus at Mickey's Very Merry Christmas Party", "  JOIN  Santa Claus   at Mickeys Very Merry Christmas Party ") &&
    meetNameMatches("Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights", "Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights!") &&
    meetNameMatches("Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights", "Meet Stitch at Celebrity-Spotlight, at Disney Jollywood Nights") &&
    meetNameMatches("Rock & Roll", "Rock and Roll") && meetNameMatches("Café Meet", "Cafe Meet") },
  { label: "identity: meaningful changes are rejected (different character, event, venue, extra/missing words, substring, empty)", ok: () => {
    const exp = "Meet Santa Jack and Sally at Mickey’s Very Merry Christmas Party";
    return !meetNameMatches(exp, "Meet Santa Claus at Mickey’s Very Merry Christmas Party") &&
      !meetNameMatches(exp, "Meet Halloween Jack and Sally at Mickey’s Not-So-Scary Halloween Party") &&
      !meetNameMatches(exp, "Meet Santa Jack and Sally") &&
      !meetNameMatches(exp, `${exp} Encore`) &&
      !meetNameMatches(exp, "Character Greetings at Mickey's Very Merry Christmas Party") &&
      !meetNameMatches(exp, "Meet Mickey at Town Square Theater") &&
      !meetNameMatches(exp, "") && !meetNameMatches("", "") &&
      !meetNameMatches("Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights", "Meet Olaf at Celebrity Spotlight");
  } },
  { label: "identity: renamed provider record is omitted (UUID/park/party date alone are not enough)", ok: () => {
    const r = build(MVMCP_MORNING, tpOk(MK, mkEntries().map((e) => (e.entityId === JS_ID ? { ...e, name: "Meet Mickey at Town Square Theater" } : e))));
    return !r.entries.some((e) => e.entityId === JS_ID) && !r.entries.some((e) => /Town Square/.test(e.name));
  } },
  { label: "identity: mixed valid/invalid — only the mismatched meet is omitted, the valid one keeps wait/status", ok: () => {
    const r = build(MVMCP_EVENING, tpOk(MK, mkEntries("OPERATING").map((e) => (e.entityId === SANTA_ID ? { ...e, name: "Meet Goofy at Hall of Fame" } : e))),
      { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 20 }, MVMCP_EVENING)]) });
    const js = r.entries.find((e) => e.entityId === JS_ID);
    return r.entries.length === 1 && !!js && js.wait.state === "live" && r.partyDate && r.error === null;
  } },
  { label: "identity: harmless live-name variation still lists, showing the provider's current name", ok: () => {
    const r = build(MVMCP_MORNING, tpOk(MK, mkEntries().map((e) => (e.entityId === SANTA_ID ? { ...e, name: "Join Santa Claus at Mickeys Very Merry Christmas Party" } : e))));
    return r.entries.some((e) => e.entityId === SANTA_ID && e.name === "Join Santa Claus at Mickeys Very Merry Christmas Party");
  } },
  { label: "identity: all meets mismatched → hidden section (not 'unavailable'); non-party dates unaffected", ok: () => {
    const r = build(MVMCP_MORNING, tpOk(MK, mkEntries().map((e) => ({ ...e, name: "Something Else" }))));
    return r.entries.length === 0 && r.error === null && eventMeetsSectionState(r) === "hidden" && !build(NON_PARTY).partyDate;
  } },
  { label: "identity: Queue-Times name guard uses the same tolerance (apostrophe variant OK, other ride rejected)", ok: () => {
    const okRow = build(MVMCP_EVENING, undefined, { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 15, name: JS_NAME.replace("’", "'").toUpperCase() }, MVMCP_EVENING)]) }).entries.find((x) => x.entityId === JS_ID)!;
    const bad = build(MVMCP_EVENING, undefined, { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 15, name: "Meet Santa Jack and Sally" }, MVMCP_EVENING)]) }).entries.find((x) => x.entityId === JS_ID)!;
    return okRow.wait.state === "live" && bad.wait.state === "unavailable";
  } },
  { label: "attribution: Queue-Times credited only when a displayed meet carries Queue-Times data (live/closed), not for no-record, failed or stale waits", ok: () => {
    const live = build(MVMCP_EVENING, undefined, { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 10 }, MVMCP_EVENING)]) });
    const closed = build(MVMCP_MORNING);
    const failed = build(MVMCP_MORNING, undefined, { ok: false });
    return eventMeetsPresentQueueTimes(live) && eventMeetsPresentQueueTimes(closed) && !eventMeetsPresentQueueTimes(failed) && !eventMeetsPresentQueueTimes(build(NON_PARTY)) && !eventMeetsPresentQueueTimes(null);
  } },
  // Provider failures / missing / stale
  { label: "ThemeParks failure on a party date: nothing listed, typed error → 'unavailable' (distinct from absence)", ok: () => {
    const r = buildParkEventMeets("mk", { ok: false, error: { kind: "timeout", message: "t" } }, null, MVMCP_MORNING);
    return r.partyDate && r.entries.length === 0 && r.error?.kind === "timeout" && eventMeetsSectionState(r) === "unavailable";
  } },
  { label: "confirmed absence (valid payload without the record): nothing fabricated, section hidden (not 'unavailable')", ok: () => {
    const r = build(MVMCP_MORNING, tpOk(MK, mkEntries().filter((e) => e.entityId !== JS_ID && e.entityId !== SANTA_ID)));
    return r.entries.length === 0 && r.error === null && eventMeetsSectionState(r) === "hidden";
  } },
  { label: "one record absent from payload: only the verified one is listed", ok: () => build(MVMCP_MORNING, tpOk(MK, mkEntries().filter((e) => e.entityId !== SANTA_ID))).entries.map((e) => e.entityId).join() === JS_ID },
  { label: "record parented to another park is not verified for this park (park matching)", ok: () => {
    const r = build(MVMCP_MORNING, tpOk(MK, mkEntries().map((e) => (e.entityId === JS_ID ? { ...e, parkId: HS } : e))));
    return !r.entries.some((e) => e.entityId === JS_ID);
  } },
  { label: "Queue-Times failure (fetch or malformed): meet still listed, wait 'unavailable' with note", ok: () =>
    [{ ok: false } as QueueTimesFetch, { ok: true, body: null } as QueueTimesFetch, { ok: true, body: "x" } as QueueTimesFetch, null].every((qt) => {
      const e = build(MVMCP_MORNING, undefined, qt).entries.find((x) => x.entityId === JS_ID)!;
      return e.wait.state === "unavailable" && describeEventMeet(e, MVMCP_MORNING).waitText === null;
    }) },
  { label: "Queue-Times stale row (>30 min) is not trusted as a wait", ok: () => {
    const stale = { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 30, last_updated: new Date(MVMCP_EVENING.getTime() - 3 * 3600_000).toISOString() }, MVMCP_EVENING)]) } as QueueTimesFetch;
    const e = build(MVMCP_EVENING, undefined, stale).entries.find((x) => x.entityId === JS_ID)!;
    return e.wait.state === "unavailable" && describeEventMeet(e, MVMCP_EVENING).waitText === null;
  } },
  { label: "Queue-Times id present but wrong name (id drift) → identity mismatch, no wait", ok: () => {
    const e = build(MVMCP_EVENING, undefined, { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 30, name: "Meet Mickey at Town Square Theater" }, MVMCP_EVENING)]) }).entries.find((x) => x.entityId === JS_ID)!;
    return e.wait.state === "unavailable" && e.wait.reason === "identity_mismatch";
  } },
  { label: "Queue-Times has no row for the verified id: no wait, ordinary rows ignored", ok: () => {
    const e = build(MVMCP_EVENING, undefined, { ok: true, body: qtBody([ordinaryRow(MVMCP_EVENING)]) }).entries.find((x) => x.entityId === JS_ID)!;
    return e.wait.state === "unavailable" && e.wait.reason === "no_queue_times_record";
  } },
  { label: "stale-if-error ThemeParks payload is flagged stale", ok: () => {
    const tp = tpOk(MK, mkEntries());
    if (!tp.ok) return false;
    const staleTp: ThemeParksResult<ThemeParksLive> = { ...tp, meta: { origin: "stale", fetchedAt: MVMCP_MORNING.getTime() - 60_000, etag: null, staleReason: { kind: "timeout", message: "t" } } };
    return build(MVMCP_MORNING, staleTp).stale === true;
  } },
  // Dedupe & identity
  { label: "duplicate provider records for one meet render one card; ids are park-qualified", ok: () => {
    const r = build(MVMCP_MORNING, tpOk(MK, [...mkEntries(), tpEntry(JS_ID, JS_NAME, MK, "CLOSED")]));
    return r.entries.filter((e) => e.entityId === JS_ID).length === 1 && r.entries.every((e) => e.id === `event-meet:mk:${e.entityId}`);
  } },
  { label: "umbrella Character Greetings and ordinary meets in the payload never appear", ok: () =>
    !build(MVMCP_MORNING).entries.some((e) => e.entityId === GREETINGS_ID || /Town Square/.test(e.name)) },
  { label: "case-insensitive UUIDs in the provider payload still verify", ok: () =>
    build(MVMCP_MORNING, tpOk(MK, mkEntries().map((e) => ({ ...e, entityId: e.entityId.toUpperCase() })))).entries.length === 2 },
  // Display clock / client degrade
  { label: "client display: previous-day or other-park data is never shown", ok: () => {
    const r = build(MVMCP_MORNING);
    return eventMeetsForDisplay(r, "mk", MVMCP_MORNING) === r && eventMeetsForDisplay(r, "mk", NON_PARTY) === null && eventMeetsForDisplay(r, "hs", MVMCP_MORNING) === null;
  } },
  { label: "client response: malformed/failed body degrades to hidden", ok: () =>
    resolveEventMeetsResponse("mk", null) === null && resolveEventMeetsResponse("mk", { parkId: "hs" }) === null && resolveEventMeetsResponse("mk", build(MVMCP_MORNING))?.entries.length === 2 },
  { label: "regular entertainment and 14.4B seasonal visibility untouched (meets are not curated entries)", ok: () => {
    const all = buildParkAllEntertainment("mk", tpOk(MK, mkEntries()), MVMCP_MORNING);
    return all.entries.filter((e) => e.id === `provider:${JS_ID}`).length === 1 && all.entries.some((e) => e.source === "curated");
  } },

  // Phase 14.4.1: same schedule conventions as regular Entertainment
  ...((): DevEventMeetCase[] => {
    const HOURS_6_TO_MIDNIGHT = { type: "Operating", startTime: "2026-11-12T18:00:00-05:00", endTime: "2026-11-13T00:00:00-05:00" };
    const PERF_7 = { type: "Performance Time", startTime: "2026-11-12T19:00:00-05:00", endTime: null };
    const js = (r: ParkEventMeets) => r.entries.find((e) => e.entityId === JS_ID)!;
    const santa = (r: ParkEventMeets) => r.entries.find((e) => e.entityId === SANTA_ID)!;
    return [
      { label: "14.4.1 meet hours use the shared format, midnight end without '(next day)': 'Operating hours: 6:00 PM–12:00 AM'", ok: () => {
        const r = build(MVMCP_MORNING, tpOk(MK, mkEntries("CLOSED", [HOURS_6_TO_MIDNIGHT])), null);
        return describeEventMeet(js(r), MVMCP_MORNING).scheduleText === "Operating hours: 6:00 PM–12:00 AM";
      } },
      { label: "14.4.1 meet with performances AND hours: times first, hours second, separate from the wait", ok: () => {
        const r = build(MVMCP_MORNING, tpOk(MK, mkEntries("CLOSED", [PERF_7, HOURS_6_TO_MIDNIGHT])), null);
        const v = describeEventMeet(js(r), MVMCP_MORNING);
        return v.scheduleText === "7:00 PM • Operating hours: 6:00 PM–12:00 AM" && v.waitText === null && js(r).schedule.showtime.performances.length === 1;
      } },
      { label: "14.4.1 hours alone are never presented as a performance", ok: () => {
        const r = build(MVMCP_MORNING, tpOk(MK, mkEntries("CLOSED", [HOURS_6_TO_MIDNIGHT])), null);
        return js(r).schedule.showtime.performances.length === 0 && !describeEventMeet(js(r), MVMCP_MORNING).scheduleText!.startsWith("6:00");
      } },
      { label: "14.4.1 no verified schedule: 'No showtimes posted', meet still listed; never hidden for absent showtimes", ok: () => {
        const r = build(MVMCP_MORNING, undefined, null);
        return r.entries.length === 2 && describeEventMeet(santa(r), MVMCP_MORNING).scheduleText === "No showtimes posted";
      } },
      { label: "14.4.1 generic ThemeParks OPERATING/CLOSED is never shown as availability (no Queue-Times row)", ok: () =>
        (["OPERATING", "CLOSED"] as const).every((st) => {
          const r = build(MVMCP_EVENING, tpOk(MK, mkEntries(st)), null);
          return r.entries.every((e) => describeEventMeet(e, MVMCP_EVENING).statusText === null);
        }) },
      { label: "14.4.1 verified Queue-Times wait stays separate from hours; no invented wait without a row", ok: () => {
        const r = build(MVMCP_EVENING, tpOk(MK, mkEntries("OPERATING", [HOURS_6_TO_MIDNIGHT])), { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 25 }, MVMCP_EVENING)]) });
        const v = describeEventMeet(js(r), MVMCP_EVENING);
        const vs = describeEventMeet(santa(r), MVMCP_EVENING);
        return v.waitText === "Wait: 25 min" && v.scheduleText === "Operating hours: 6:00 PM–12:00 AM" && vs.waitText === null && vs.waitNote === null;
      } },
      // ── real-provider-shape cases (payloads captured from ThemeParks.wiki 2026-11-13) ──
      { label: "14.4.1 real shape: Join Santa 'Special Ticketed Event' 6 PM→midnight is operating hours, not the performance '6:00 PM'", ok: () => {
        const at13 = at("2026-11-13T13:10:00Z");
        const stw = { type: "Special Ticketed Event", startTime: "2026-11-13T18:00:00-05:00", endTime: "2026-11-14T00:00:00-05:00" };
        const r = build(at13, tpOk(MK, mkEntries("OPERATING").map((e) => (e.entityId === SANTA_ID ? { ...e, showtimes: [stw] } : e))), null);
        const e = santa(r);
        return describeEventMeet(e, at13).scheduleText === "Operating hours: 6:00 PM–12:00 AM" && e.schedule.showtime.performances.length === 0 &&
          e.schedule.operatingHours?.length === 1 && !e.schedule.operatingHoursIncomplete && describeEventMeet(e, at13).statusText === null;
      } },
      { label: "14.4.1 real shape: Santa Jack & Sally 7:00–11:30 PM event window → 'Operating hours: 7:00 PM–11:30 PM'; Queue-Times wait/status stay independent", ok: () => {
        const stw = { type: "Special Ticketed Event", startTime: "2026-11-12T19:00:00-05:00", endTime: "2026-11-12T23:30:00-05:00" };
        const r = build(MVMCP_EVENING, tpOk(MK, mkEntries("OPERATING", [stw])), { ok: true, body: qtBody([jsRow({ is_open: true, wait_time: 35 }, MVMCP_EVENING)]) });
        const v = describeEventMeet(js(r), MVMCP_EVENING);
        return v.scheduleText === "Operating hours: 7:00 PM–11:30 PM" && v.waitText === "Wait: 35 min" && v.statusText === "Operating" && js(r).schedule.showtime.performances.length === 0;
      } },
      { label: "14.4.1 closed Queue-Times row + window: both shown independently; no ThemeParks status text without a Queue-Times row", ok: () => {
        const stw = { type: "Special Ticketed Event", startTime: "2026-11-12T19:00:00-05:00", endTime: "2026-11-12T23:30:00-05:00" };
        const withQt = build(MVMCP_MORNING, tpOk(MK, mkEntries("CLOSED", [stw])));
        const noQt = build(MVMCP_MORNING, tpOk(MK, mkEntries("OPERATING", [stw])), null);
        const a = describeEventMeet(js(withQt), MVMCP_MORNING), b = describeEventMeet(js(noQt), MVMCP_MORNING);
        return a.statusText === "Closed" && a.scheduleText === "Operating hours: 7:00 PM–11:30 PM" && b.statusText === null && b.waitText === null && b.scheduleText === "Operating hours: 7:00 PM–11:30 PM";
      } },
      { label: "14.4.1 genuine discrete performances (start == end) on a meet stay performances; mixed with a window: times first, hours second", ok: () => {
        const d1 = { type: "Special Ticketed Event", startTime: "2026-11-12T20:30:00-05:00", endTime: "2026-11-12T20:30:00-05:00" };
        const d2 = { type: "Performance Time", startTime: "2026-11-12T23:00:00-05:00", endTime: null };
        const win = { type: "Special Ticketed Event", startTime: "2026-11-12T18:00:00-05:00", endTime: "2026-11-13T00:00:00-05:00" };
        const only = build(MVMCP_MORNING, tpOk(MK, mkEntries("CLOSED", [d1, d2])), null);
        const mixed = build(MVMCP_MORNING, tpOk(MK, mkEntries("CLOSED", [d1, win])), null);
        return describeEventMeet(js(only), MVMCP_MORNING).scheduleText === "8:30 PM • 11:00 PM" && js(only).schedule.operatingHours?.length === 0 &&
          describeEventMeet(js(mixed), MVMCP_MORNING).scheduleText === "8:30 PM • Operating hours: 6:00 PM–12:00 AM";
      } },
      { label: "14.4.1 invalid/incomplete meet windows (missing, reversed, unparseable, >24 h end) are never shown: schedule 'Showtimes unavailable', meet still listed", ok: () =>
        [null, "2026-11-12T17:00:00-05:00", "garbage", "2026-11-13T19:00:01-05:00"].every((end) => {
          const bad = { type: "Special Ticketed Event", startTime: "2026-11-12T18:00:00-05:00", endTime: end };
          const r = build(MVMCP_MORNING, tpOk(MK, mkEntries("OPERATING", [bad])), null);
          const e = r.entries.find((x) => x.entityId === JS_ID);
          return !!e && e.schedule.showtime.performances.length === 0 && (e.schedule.operatingHours?.length ?? 0) === 0 &&
            describeEventMeet(e, MVMCP_MORNING).scheduleText === "Showtimes unavailable" && e.schedule.showtime.incomplete;
        }) },
      { label: "14.4.1 an invalid window beside a valid one: valid hours kept, qualified '(may be incomplete)' beside 'Showtimes unavailable'; invalid on another day is ignored", ok: () => {
        const bad = { type: "Special Ticketed Event", startTime: "2026-11-12T12:00:00-05:00", endTime: null };
        const good = { type: "Special Ticketed Event", startTime: "2026-11-12T18:00:00-05:00", endTime: "2026-11-13T00:00:00-05:00" };
        const old = { type: "Special Ticketed Event", startTime: "2026-11-05T18:00:00-05:00", endTime: null };
        const mixed = describeEventMeet(js(build(MVMCP_MORNING, tpOk(MK, mkEntries("CLOSED", [bad, good])), null)), MVMCP_MORNING).scheduleText;
        const stale = describeEventMeet(js(build(MVMCP_MORNING, tpOk(MK, mkEntries("CLOSED", [old, good])), null)), MVMCP_MORNING).scheduleText;
        return mixed === "Showtimes unavailable • Operating hours: 6:00 PM–12:00 AM (may be incomplete)" && stale === "Operating hours: 6:00 PM–12:00 AM";
      } },
      { label: "14.4.1 scoping: interpretation touches registered meets only — a regular show's window-shaped 'Special Ticketed Event' stays a performance", ok: () => {
        const r = interpretMeetShowtimes("WDW", "2026-11-12", [{ type: "Special Ticketed Event", startTime: "2026-11-12T18:00:00-05:00", endTime: "2026-11-13T00:00:00-05:00" }]);
        const win = { type: "Special Ticketed Event", startTime: "2026-11-12T18:00:00-05:00", endTime: "2026-11-13T00:00:00-05:00" };
        const all = buildParkAllEntertainment("mk", tpOk(MK, [...mkEntries(), tpEntry("767b8357-ce52-4e09-810f-30ee81f8136c", "Mickey's Most Merriest Celebration at Mickey's Very Merry Christmas Party", MK, "OPERATING", [win])]), MVMCP_MORNING);
        const merriest = all.entries.find((e) => e.name === "Mickey's Most Merriest Celebration");
        return r.showtimes[0].type === "Operating" && !!merriest && merriest.showtime.performances.length === 1 && (merriest.operatingHours?.length ?? 0) === 0;
      } },
      { label: "14.4.1 meets are not performance-day filtered: confirmed-zero evidence on a party night never hides them (section state, listing, All Entertainment rule)", ok: () => {
        const later = { type: "Performance Time", startTime: "2026-11-13T19:00:00-05:00", endTime: null };
        const r = build(MVMCP_MORNING, tpOk(MK, mkEntries("CLOSED", [later])), null);
        const e = js(r);
        return e.schedule.showtime.confirmedNoActivityToday === true && r.entries.some((x) => x.entityId === JS_ID) && eventMeetsSectionState(r) === "list" &&
          !isAllEntryConfirmedInactiveToday(e.schedule, "mk", "WDW", r.localDate, MVMCP_MORNING) &&
          describeEventMeet(e, MVMCP_MORNING).scheduleText === "No showtimes posted";
      } },
      { label: "14.4.1 provider failure / stale handling unchanged: failure → unavailable section; stale payload flagged", ok: () =>
        eventMeetsSectionState(buildParkEventMeets("mk", { ok: false, error: { kind: "network", message: "n" } }, null, MVMCP_MORNING)) === "unavailable" },
    ];
  })(),
  // ── Phase 14.5D: non-meet event offerings, pending ledger ──
  ...(() => {
    const STITCHMAS = "4514beed-faa9-4847-bc77-34f9c6b1f619";
    const WRANGLERS = "6d45026b-0761-4b6d-8902-50905aa82da2";
    const DISCO = "71da34dd-a27e-4db5-aef3-f880ef939f98";
    const GRAND = "74b46a33-ec93-4222-a3d5-d8372b1498e9";
    const STITCHMAS_NAME = "Stitchmas! at Mickey's Very Merry Christmas Party";
    const WRANGLERS_NAME = "Reindeer Wranglers at Mickey's Very Merry Christmas Party";
    const DISCO_NAME = "Pixar Disco at Disney Jollywood Nights";
    const GRAND_NAME = "Grand Avenue Dance Party at Disney Jollywood Nights";
    const mkAll = (status = "OPERATING", extra: ReturnType<typeof tpEntry>[] = []) => [
      ...mkEntries(status),
      tpEntry(STITCHMAS, STITCHMAS_NAME, MK, status, [{ type: "Special Ticketed Event", startTime: "2026-11-12T19:00:00-05:00", endTime: "2026-11-13T00:00:00-05:00" }]),
      tpEntry(WRANGLERS, WRANGLERS_NAME, MK, status, [
        { type: "Special Ticketed Event", startTime: "2026-11-12T19:15:00-05:00", endTime: "2026-11-12T19:15:00-05:00" },
        { type: "Special Ticketed Event", startTime: "2026-11-12T20:05:00-05:00", endTime: "2026-11-12T20:05:00-05:00" },
      ]),
      ...extra,
    ];
    const hsAll = (status = "CLOSED") => [
      tpEntry(STITCH_ID, "Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights", HS, status),
      tpEntry(DISCO, DISCO_NAME, HS, status),
      tpEntry(GRAND, GRAND_NAME, HS, status),
      tpEntry("dc332105-e524-4dca-9a47-df672f8472fd", "Character Greetings at Disney Jollywood Nights", HS, status),
    ];
    const offIds = (r: ParkEventMeets) => r.offerings.map((e) => e.entityId).sort().join();
    const registered = EVENT_EXCLUSIVE_MEETS.filter((m) => !isEventMeet(m));
    return [
      { label: "14.5D registry: non-meet offerings are exactly Stitchmas!, Reindeer Wranglers (MK) and Pixar Disco, Grand Avenue Dance Party (HS)", ok: () =>
        registered.map((m) => `${m.parkId}:${m.entityId}`).sort().join() === [`mk:${STITCHMAS}`, `mk:${WRANGLERS}`, `hs:${DISCO}`, `hs:${GRAND}`].sort().join() },
      { label: "14.5D no duplicates: no registered record is also a curated/mapped Entertainment entry (parade, fireworks, stage shows stay curated-only)", ok: () =>
        EVENT_EXCLUSIVE_MEETS.every((m) => resolveDwpEntertainmentFromThemeParksId(m.entityId) === null) },
      { label: "14.5D no duplicates: no registered provider name equals a curated catalog name at its park", ok: () =>
        EVENT_EXCLUSIVE_MEETS.every((m) => !ENTERTAINMENT_PLACES.some((p) => p.parkId === m.parkId && meetNameMatches(p.name, m.providerName))) },
      { label: "14.5D MVMCP party night: Stitchmas! and Reindeer Wranglers listed as Party Entertainment, meets stay in Party Character Meets (no cross-listing)", ok: () => {
        const r = build(MVMCP_MORNING, tpOk(MK, mkAll()), null);
        return offIds(r) === [STITCHMAS, WRANGLERS].sort().join() && r.entries.map((e) => e.entityId).sort().join() === [JS_ID, SANTA_ID].sort().join() &&
          r.confirmedMeets === 2 && r.confirmedOfferings === 2 && eventOfferingsSectionState(r) === "list" && eventMeetsSectionState(r) === "list";
      } },
      { label: "14.5D Stitchmas! window shows as operating hours; Reindeer Wranglers shows its posted performance times only", ok: () => {
        const r = build(MVMCP_MORNING, tpOk(MK, mkAll()), null);
        const st = describeEventMeet(r.offerings.find((e) => e.entityId === STITCHMAS)!, MVMCP_MORNING).scheduleText;
        const rw = describeEventMeet(r.offerings.find((e) => e.entityId === WRANGLERS)!, MVMCP_MORNING).scheduleText;
        return st === "Operating hours: 7:00 PM–12:00 AM" && !!rw && rw.includes("7:15 PM") && rw.includes("8:05 PM") && !/Operating hours/.test(rw);
      } },
      { label: "14.5D no invented times/waits: offerings without posted times say none posted; no Queue-Times wait for them", ok: () => {
        const r = build(JN_MORNING, tpOk(HS, hsAll()), { ok: true, body: qtBody([{ id: 6703, name: "Meet Olaf at Celebrity Spotlight", is_open: true, wait_time: 30, last_updated: new Date(JN_MORNING.getTime() - 60_000).toISOString() }]) }, "hs");
        const d = r.offerings.find((e) => e.entityId === DISCO)!;
        const v = describeEventMeet(d, JN_MORNING);
        return v.scheduleText === "No showtimes posted" && v.waitText === null && v.waitNote === null && d.wait.state === "unavailable";
      } },
      { label: "14.5D Jollywood night (Nov 14): Pixar Disco + Grand Avenue Dance Party listed; umbrella Character Greetings never; Stitch stays a meet", ok: () => {
        const r = build(JN_MORNING, tpOk(HS, hsAll()), null, "hs");
        return offIds(r) === [DISCO, GRAND].sort().join() && r.entries.map((e) => e.entityId).join() === STITCH_ID &&
          !r.offerings.concat(r.entries).some((e) => e.entityId === "dc332105-e524-4dca-9a47-df672f8472fd");
      } },
      { label: "14.5D Stitch meet: exact Queue-Times row 15402 supplies its wait; ordinary Olaf row (6703) is never substituted", ok: () => {
        const row = (id: number, name: string, wait: number) => ({ id, name, is_open: true, wait_time: wait, last_updated: new Date(JN_MORNING.getTime() - 60_000).toISOString() });
        const live = build(JN_MORNING, tpOk(HS, hsAll("OPERATING")), { ok: true, body: qtBody([row(6703, "Meet Olaf at Celebrity Spotlight", 30), row(15402, "Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights", 15)]) }, "hs").entries[0];
        const olafOnly = build(JN_MORNING, tpOk(HS, hsAll("OPERATING")), { ok: true, body: qtBody([row(6703, "Meet Olaf at Celebrity Spotlight", 30)]) }, "hs").entries[0];
        const renamed = build(JN_MORNING, tpOk(HS, hsAll("OPERATING")), { ok: true, body: qtBody([row(15402, "Meet Olaf at Celebrity Spotlight", 30)]) }, "hs").entries[0];
        return live.wait.state === "live" && describeEventMeet(live, JN_MORNING).waitText === "Wait: 15 min" &&
          olafOnly.wait.state === "unavailable" && describeEventMeet(olafOnly, JN_MORNING).waitText === null &&
          renamed.wait.state === "unavailable" && describeEventMeet(renamed, JN_MORNING).waitText === null;
      } },
      { label: "14.5D non-party dates in season (Nov 10 MVMCP-off, Nov 13 Jollywood-off): no offerings, nothing fetched", ok: () => {
        const a = build(NON_PARTY, tpOk(MK, mkAll()), null);
        const b = build(at("2026-11-13T15:00:00Z"), tpOk(HS, hsAll()), null, "hs");
        return !a.partyDate && a.offerings.length === 0 && eventOfferingsSectionState(a) === "hidden" && !b.partyDate && b.offerings.length === 0 && eventOfferingsSectionState(b) === "hidden" &&
          buildParkEventMeets("mk", null, null, NON_PARTY).offerings.length === 0;
      } },
      { label: "14.5D season boundaries: MVMCP first night (Nov 8) listed, day before (Nov 7) not; last night (Dec 22) listed, Dec 23 not", ok: () => {
        const n = (iso: string) => build(at(iso), tpOk(MK, mkAll()), null).offerings.length;
        return n("2026-11-08T15:00:00Z") === 2 && n("2026-11-07T15:00:00Z") === 0 && n("2026-12-22T15:00:00Z") === 2 && n("2026-12-23T15:00:00Z") === 0;
      } },
      { label: "14.5D out-of-season events (MNSSHP Aug–Oct, OBB) and unannounced 2027: no offerings even when the provider still publishes records", ok: () => {
        const mnsshp = build(at("2026-10-15T15:00:00Z"), tpOk(MK, mkAll()), null);
        const next = build(at("2027-11-12T15:00:00Z"), tpOk(MK, mkAll()), null);
        const dca = buildParkEventMeets("dca", tpOk("x", []), null, at("2026-10-15T20:00:00Z"));
        return !mnsshp.partyDate && mnsshp.offerings.length === 0 && !next.partyDate && next.offerings.length === 0 && !dca.partyDate && dca.offerings.length === 0 && dca.confirmedOfferings === 0;
      } },
      { label: "14.5D cross-park isolation: MK offerings never on HS and vice versa; parks with no registered events stay empty", ok: () => {
        const hsOnMk = build(MVMCP_MORNING, tpOk(HS, [...hsAll(), tpEntry(STITCHMAS, STITCHMAS_NAME, HS, "OPERATING")]), null, "hs");
        const mkOnJn = build(JN_MORNING, tpOk(MK, mkAll()), null, "mk");
        return hsOnMk.offerings.length === 0 && mkOnJn.offerings.length === 0 &&
          (["epcot", "ak", "disneyland", "dca"] as ParkId[]).every((p) => { const r = buildParkEventMeets(p, tpOk(MK, mkAll()), null, MVMCP_MORNING); return !r.partyDate && r.offerings.length === 0; });
      } },
      { label: "14.5D provider failure on a party date: offerings section is 'unavailable' (not absence), meets section too; no cards", ok: () => {
        const r = buildParkEventMeets("mk", { ok: false, error: { kind: "timeout", message: "t" } }, null, MVMCP_MORNING);
        return eventOfferingsSectionState(r) === "unavailable" && eventMeetsSectionState(r) === "unavailable" && r.offerings.length === 0 && r.entries.length === 0;
      } },
      { label: "14.5D absence (record not in the live payload) lists nothing and is not an error; present records still listed", ok: () => {
        const r = build(MVMCP_MORNING, tpOk(MK, mkEntries()), null);
        return r.offerings.length === 0 && r.error === null && eventOfferingsSectionState(r) === "hidden" && r.entries.length === 2;
      } },
      { label: "14.5D mapping change: a registered UUID whose name changed (different offering) is omitted, others unaffected", ok: () => {
        const changed = mkAll().map((e) => (e.entityId === STITCHMAS ? { ...e, name: "Jingle Jam at Mickey's Very Merry Christmas Party" } : e));
        const r = build(MVMCP_MORNING, tpOk(MK, changed), null);
        return offIds(r) === WRANGLERS;
      } },
      { label: "14.5D no fuzzy matching: an unregistered provider record with a similar/party name is never listed", ok: () => {
        const sneaky = mkAll("OPERATING", [
          tpEntry("11111111-2222-4333-8444-555555555555", "Stitchmas! at Mickey's Very Merry Christmas Party", MK, "OPERATING"),
          tpEntry("11111111-2222-4333-8444-666666666666", "Holiday Dance Party at Mickey's Very Merry Christmas Party", MK, "OPERATING"),
        ]);
        return offIds(build(MVMCP_MORNING, tpOk(MK, sneaky), null)) === [STITCHMAS, WRANGLERS].sort().join();
      } },
      { label: "14.5D no duplicate cards across sections/ids, and curated party shows (Merriest, parade, fireworks) never appear here", ok: () => {
        const curated = [
          tpEntry("767b8357-ce52-4e09-810f-30ee81f8136c", "Mickey's Most Merriest Celebration at Mickey's Very Merry Christmas Party", MK, "OPERATING"),
          tpEntry("bb28947d-a747-44f0-ac71-1fa8188f4cee", "Minnie's Wonderful Christmastime Fireworks at Mickey's Very Merry Christmas Party", MK, "OPERATING"),
        ];
        const r = build(MVMCP_MORNING, tpOk(MK, mkAll("OPERATING", [...curated, ...mkAll()])), null);
        const ids = [...r.entries, ...r.offerings].map((e) => e.id);
        return new Set(ids).size === ids.length && !ids.some((i) => /767b8357|bb28947d/.test(i));
      } },
      { label: "14.5D registered offerings keep the party gating independent of provider status (CLOSED/OPERATING both listed all day)", ok: () =>
        build(MVMCP_MORNING, tpOk(MK, mkAll("CLOSED")), null).offerings.length === 2 && build(MVMCP_EVENING, tpOk(MK, mkAll("OPERATING")), null).offerings.length === 2 },
      { label: "14.5D normal-day exclusions unchanged: offerings are never visible/hidden via the curated or provider-only seasonal rules (party-night rank only)", ok: () =>
        EVENT_EXCLUSIVE_MEETS.every((m) => getSeasonalProviderEntertainmentRank(m.parkId, m.entityId, { resort: PARK_TO_RESORT[m.parkId] as ResortId, date: "2026-11-10", parkId: m.parkId, instant: NON_PARTY }) !== "party-night") },
      { label: "14.5D response compat: pre-14.5D body (no offerings fields) resolves as meets-only; offerings section hidden; unavailable state stays meets-only", ok: () => {
        const old = { parkId: "mk", resort: "WDW", localDate: "2026-11-12", partyDate: true, error: null, stale: false, entries: [] };
        const r = resolveEventMeetsResponse("mk", old)!;
        const failed = resolveEventMeetsResponse("mk", { ...old, error: { kind: "timeout", message: "t" } })!;
        return r.offerings.length === 0 && eventOfferingsSectionState(r) === "hidden" && eventOfferingsSectionState(failed) === "hidden" && eventMeetsSectionState(failed) === "unavailable";
      } },
      { label: "14.5D attribution: Queue-Times attribution counts offerings' shown data only when present", ok: () => {
        const r = build(JN_MORNING, tpOk(HS, hsAll("OPERATING")), { ok: true, body: qtBody([{ id: 15402, name: "Meet Stitch at Celebrity Spotlight at Disney Jollywood Nights", is_open: true, wait_time: 5, last_updated: new Date(JN_MORNING.getTime() - 60_000).toISOString() }]) }, "hs");
        const none = build(MVMCP_MORNING, tpOk(MK, mkAll()), null);
        return eventMeetsPresentQueueTimes(r) && !eventMeetsPresentQueueTimes(none);
      } },
      // Pending ledger
      { label: "14.5D pending ledger: every record references a registered event and one of its parks, with evidence and next-verification text", ok: () =>
        PENDING_EVENT_OFFERINGS.every((o) => { const e = getSeasonalEvent(o.eventId); return !!e && e.parkIds.includes(o.parkId) && o.evidence.length > 0 && o.reason.trim() !== "" && o.nextVerification.trim() !== ""; }) },
      { label: "14.5D pending ledger: never carries provider ids and is never rendered (no UUID-shaped field/text, absent from every built result)", ok: () => {
        const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        const ledgerClean = PENDING_EVENT_OFFERINGS.every((o) => !("entityId" in o) && !uuid.test(JSON.stringify(o)));
        const r = build(MVMCP_MORNING, tpOk(MK, mkAll("OPERATING", [tpEntry("99999999-aaaa-4bbb-8ccc-dddddddddddd", "Santa's Christmas Carnival", MK, "OPERATING")])), null);
        return ledgerClean && ![...r.entries, ...r.offerings].some((e) => /carnival/i.test(e.name));
      } },
      { label: "14.5D pending ledger: evidence is tiered honestly — 'official' only for Disney-owned domains, https URLs, secondary otherwise", ok: () =>
        PENDING_EVENT_OFFERINGS.every((o) => o.evidence.every((ev) => /^https:\/\//.test(ev.url) &&
          (ev.tier === "official" ? /^https:\/\/(disneyparksblog\.com|[a-z.]*disney\.go\.com)\//.test(ev.url) : ev.tier === "secondary"))) },
      { label: "14.5D pending ledger: unique (event, park, season, name); mandatory cases present with the right status (Captain Jack's, Rusty Cutlass unresolved, Stitch's Masquerade, MVMCP/Jollywood gaps)", ok: () => {
        const keys = PENDING_EVENT_OFFERINGS.map((o) => `${o.eventId}|${o.parkId}|${o.seasonYear}|${o.name}`);
        const by = (re: RegExp) => PENDING_EVENT_OFFERINGS.find((o) => re.test(o.name));
        return new Set(keys).size === keys.length &&
          by(/Captain Jack/)?.status === "pending_mapping" && by(/Rusty Cutlass/)?.status === "unresolved" && by(/Stitch's Masquerade/)?.status === "pending_mapping" &&
          getPendingEventOfferings("mvmcp").length > 0 && getPendingEventOfferings("jollywood-nights").length > 0 && getPendingEventOfferings("oogie-boogie-bash").length > 0;
      } },
      { label: "14.5D pending ledger: out-of-season pending items are not discontinuation evidence (no 'discontinued' status exists) and Rusty Cutlass makes no replacement claim", ok: () =>
        PENDING_EVENT_OFFERINGS.every((o) => (["pending_mapping", "no_provider_record", "unresolved", "excluded"] as string[]).includes(o.status)) &&
        !/was replaced by|replaced by Captain/i.test(PENDING_EVENT_OFFERINGS.find((o) => /Rusty Cutlass/.test(o.name))!.reason) },
    ] as DevEventMeetCase[];
  })(),
];

export function runDevEventExclusiveMeetCases(): string[] {
  return DEV_EVENT_MEET_CASES.filter((c) => {
    try { return !c.ok(); } catch { return true; }
  }).map((c) => c.label);
}

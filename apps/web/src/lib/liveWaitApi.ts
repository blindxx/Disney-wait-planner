/**
 * liveWaitApi.ts — Live Wait Times API (Queue-Times.com integration)
 *
 * Single entry point: getWaitDataset({ resortId, parkId })
 * Returns normalized AttractionWait[] with metadata about the data source.
 *
 * Data source: Queue-Times.com via the local proxy at /api/waits/queue-times
 * Attribution: "Powered by Queue-Times.com" must be shown when live mode is on.
 *
 * Config (env vars):
 *   NEXT_PUBLIC_WAIT_API_ENABLED   "true" | "false"  (default: false)
 *   NEXT_PUBLIC_WAIT_API_BASE_URL  string (optional; defaults to same-origin "")
 *
 * Behavior:
 *   - Live disabled                → returns mock data, no fetch
 *   - Park has no mapping          → returns mock data, no fetch
 *   - Cache valid (< 60 s)         → returns cached data immediately, no fetch
 *   - Cache stale                  → fetches via proxy, caches, returns live data
 *   - Any fetch failure            → silently falls back to mock, never throws
 *   - In-flight deduplication      → one request per resortId:parkId at a time
 */

import {
  mockAttractionWaits,
  type AttractionWait,
  type ParkId,
  type ResortId,
  type WaitStatus,
} from "@disney-wait-planner/shared";
import {
  PLANNED_CLOSURES,
  isClosureStatusEnforced,
  normalizeAttractionName,
} from "./plannedClosures";

// ============================================
// CONFIG
// ============================================

const API_ENABLED = process.env.NEXT_PUBLIC_WAIT_API_ENABLED === "true";

/**
 * Optional base URL override for the proxy (default: same origin "").
 * Trailing slash is stripped to allow consistent path joining.
 */
const API_BASE_URL = (process.env.NEXT_PUBLIC_WAIT_API_BASE_URL ?? "").replace(
  /\/$/,
  "",
);

/** Live mode active when explicitly enabled. Base URL is optional (defaults to same origin). */
export const LIVE_ENABLED = API_ENABLED;

/** Fetch abort timeout in milliseconds (5 seconds). */
const REQUEST_TIMEOUT_MS = 5_000;

/** Cache TTL in milliseconds (60 seconds). */
const CACHE_TTL_MS = 60_000;

// ============================================
// QUEUE-TIMES PARK MAPPING
// ============================================

/**
 * Maps app (resortId, parkId) pairs to Queue-Times.com park IDs.
 * IDs verified from https://queue-times.com/parks.json on 2026-02-16.
 */
const QUEUE_TIMES_PARK_MAP: Partial<Record<string, number>> = {
  "DLR:disneyland": 16, // Queue-Times: Disneyland
  "DLR:dca": 17,        // Queue-Times: Disney California Adventure
  "WDW:mk": 6,          // Queue-Times: Disney Magic Kingdom
  "WDW:epcot": 5,       // Queue-Times: Epcot
  "WDW:hs": 7,          // Queue-Times: Disney Hollywood Studios
  "WDW:ak": 8,          // Queue-Times: Animal Kingdom
};

// PLANNED_CLOSURES and isClosureStatusEnforced are imported from ./plannedClosures.

// ============================================
// PUBLIC RETURN TYPE
// ============================================

export type WaitDataset = {
  /** Normalized attraction wait data — same shape as mock. */
  data: AttractionWait[];
  /** Indicates whether data came from the live API or mock. */
  dataSource: "live" | "mock";
  /** Epoch ms timestamp of when live data was fetched; null for mock. */
  lastUpdated: number | null;
};

// ============================================
// IN-MEMORY CACHE + IN-FLIGHT DEDUPE
// ============================================

type CacheEntry = WaitDataset & {
  /** Epoch ms at which this entry expires. */
  expiresAt: number;
};

/** Cache keyed by `${resortId}:${parkId}`. */
const cache = new Map<string, CacheEntry>();

/** In-flight Promises keyed by `${resortId}:${parkId}` for deduplication. */
const inFlight = new Map<string, Promise<WaitDataset>>();

function cacheKey(resortId: ResortId, parkId: ParkId): string {
  return `${resortId}:${parkId}`;
}

// ============================================
// SESSION STORAGE PERSISTENCE
// ============================================

/**
 * Namespace prefix for all sessionStorage/localStorage keys.
 * Scoped per-tab (sessionStorage) / per-browser (localStorage); the
 * `v2` segment bumps whenever the normalization/dedup logic changes, so a
 * previously persisted entry computed by an older version of
 * normalizeQueueTimesResponse is never read back — it simply misses under
 * the new key and a fresh fetch is triggered instead.
 */
const SS_PREFIX = "dwp:wt:v2:";

/** Shape of the value stored in sessionStorage — kept minimal. */
type StoredEntry = {
  data: AttractionWait[];
  dataSource: "live" | "mock";
  lastUpdated: number | null;
  expiresAt: number;
};

/**
 * Read a cache entry from sessionStorage.
 * Returns null on any error, missing key, or type mismatch.
 * Safe to call during SSR (typeof window guard).
 */
function readSessionCache(key: string): CacheEntry | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = sessionStorage.getItem(SS_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredEntry>;
    if (!Array.isArray(parsed.data) || typeof parsed.expiresAt !== "number") {
      return null;
    }
    return {
      data: parsed.data as AttractionWait[],
      dataSource: parsed.dataSource === "live" ? "live" : "mock",
      lastUpdated: typeof parsed.lastUpdated === "number" ? parsed.lastUpdated : null,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * Persist a cache entry to sessionStorage.
 * Silently ignores any error (quota exceeded, restricted environment, SSR).
 */
function writeSessionCache(key: string, entry: CacheEntry): void {
  try {
    if (typeof window === "undefined") return;
    const stored: StoredEntry = {
      data: entry.data,
      dataSource: entry.dataSource,
      lastUpdated: entry.lastUpdated,
      expiresAt: entry.expiresAt,
    };
    sessionStorage.setItem(SS_PREFIX + key, JSON.stringify(stored));
  } catch {
    // sessionStorage unavailable (private browsing, quota, iframe) — in-memory only
  }
}

// ============================================
// LOCAL STORAGE PERSISTENCE (tertiary)
// ============================================

/**
 * Read a cache entry from localStorage.
 * Tertiary fallback: survives full browser close/reopen (mobile Chrome, etc.).
 * Same schema and validation as readSessionCache.
 */
function readLocalCache(key: string): CacheEntry | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = localStorage.getItem(SS_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredEntry>;
    if (!Array.isArray(parsed.data) || typeof parsed.expiresAt !== "number") {
      return null;
    }
    return {
      data: parsed.data as AttractionWait[],
      dataSource: parsed.dataSource === "live" ? "live" : "mock",
      lastUpdated: typeof parsed.lastUpdated === "number" ? parsed.lastUpdated : null,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * Persist a cache entry to localStorage.
 * Silently ignores any error (quota exceeded, restricted environment, SSR).
 */
function writeLocalCache(key: string, entry: CacheEntry): void {
  try {
    if (typeof window === "undefined") return;
    const stored: StoredEntry = {
      data: entry.data,
      dataSource: entry.dataSource,
      lastUpdated: entry.lastUpdated,
      expiresAt: entry.expiresAt,
    };
    localStorage.setItem(SS_PREFIX + key, JSON.stringify(stored));
  } catch {
    // localStorage unavailable (private browsing, quota, iframe) — continue without
  }
}

// ============================================
// QUEUE-TIMES RESPONSE NORMALIZATION
// ============================================

/**
 * Queue-Times.com queue_times.json shape:
 * { lands: [{ id, name, rides: [{ id, name, is_open, wait_time, last_updated }] }] }
 *
 * Normalization strategy: overlay live data onto the mock attraction list.
 * - Start with all mock rides for this park (preserves id, land, themeParksId).
 * - For each mock ride, match by name (case-insensitive) to a live ride.
 * - If matched: update status, waitMins, updatedAt from live data.
 * - If not matched: keep mock values unchanged.
 *
 * This ensures the UI always sees the full expected set of rides.
 */

type QTRide = {
  id: number;
  name: string;
  is_open: boolean;
  wait_time: number;
  last_updated: string;
};

type QTLand = {
  id: number;
  name: string;
  rides: QTRide[];
};

type QTResponse = {
  lands: QTLand[];
  /**
   * Queue-Times also returns a top-level `rides` array for rides not yet
   * assigned to a land (e.g. newly added/renamed rides). These must be
   * merged into the same freshness resolution as `lands[].rides`, or a
   * fresher top-level row can be silently invisible to the app while a
   * stale land-nested row for the same attraction continues to be shown.
   */
  rides?: QTRide[];
};

// normalizeAttractionName is defined in and exported from ./plannedClosures
// (imported above) — it anchors that module's closure-key format, so it
// lives there rather than being duplicated here.

/**
 * WDW-only alias map: normalized-alias → canonical-normalized-mock-name.
 *
 * Queue-Times may use a shorter or slightly different name than our mock data.
 * After building liveByName from live data, aliases are resolved so that
 * mock-ride lookups (using the canonical name) still find the live entry.
 *
 * Keys and values must both be in normalizeAttractionName() output form
 * (lowercase, straight punctuation, whitespace collapsed).
 */
const ALIASES_WDW = new Map<string, string>([
  // Expedition Everest (Animal Kingdom) — Queue-Times uses full ride subtitle
  ["expedition everest - legend of the forbidden mountain", "expedition everest"],
  // Rock 'n' Roller Coaster (Hollywood Studios) — supports both Aerosmith (old) and The Muppets (new) naming
  ["rnr",                                           "rock 'n' roller coaster starring the muppets"],
  ["rock n roller",                                 "rock 'n' roller coaster starring the muppets"],
  ["rock n roller coaster",                         "rock 'n' roller coaster starring the muppets"],
  ["rock 'n' roller coaster",                       "rock 'n' roller coaster starring the muppets"],
  ["rockin roller coaster",                         "rock 'n' roller coaster starring the muppets"],
  ["aerosmith",                                     "rock 'n' roller coaster starring the muppets"],
  ["rock n roller coaster starring aerosmith",      "rock 'n' roller coaster starring the muppets"],
  ["rock 'n' roller coaster starring aerosmith",    "rock 'n' roller coaster starring the muppets"],
  ["rock n roller coaster starring the muppets",    "rock 'n' roller coaster starring the muppets"],
  ["muppets",                                       "rock 'n' roller coaster starring the muppets"],
  // Buzz Lightyear's Space Ranger Spin (Magic Kingdom)
  ["buzz",                                       "buzz lightyear's space ranger spin"],
  ["buzz lightyear",                             "buzz lightyear's space ranger spin"],
  ["space ranger spin",                          "buzz lightyear's space ranger spin"],
  ["space ranger",                               "buzz lightyear's space ranger spin"],
  ["blsrs",                                      "buzz lightyear's space ranger spin"],
  ["buzz lightyear space ranger spin",           "buzz lightyear's space ranger spin"],
  ["buzz lightyear's space ranger spin",         "buzz lightyear's space ranger spin"],
  // "it's a small world" (Magic Kingdom) — mock name has surrounding typographic quotes;
  // Queue-Times omits them. Both sides normalized, value retains the literal " chars.
  ["it's a small world",                         "\"it's a small world\""],
  // Pirates of the Caribbean (Magic Kingdom) — common shortening
  ["pirates",                                    "pirates of the caribbean"],
  // The Many Adventures of Winnie the Pooh (Magic Kingdom)
  ["winnie the pooh",                            "the many adventures of winnie the pooh"],
  ["pooh",                                       "the many adventures of winnie the pooh"],
  ["many adventures of winnie the pooh",         "the many adventures of winnie the pooh"],
  // Seven Dwarfs Mine Train (Magic Kingdom)
  ["seven dwarfs",                               "seven dwarfs mine train"],
  ["mine train",                                 "seven dwarfs mine train"],
  // TRON Lightcycle / Run (Magic Kingdom) — Queue-Times may omit slash
  ["tron lightcycle run",                        "tron lightcycle / run"],
  ["tron",                                       "tron lightcycle / run"],
  // Under the Sea – Journey of the Little Mermaid (Magic Kingdom)
  ["little mermaid",                             "under the sea - journey of the little mermaid"],
  ["journey of the little mermaid",              "under the sea - journey of the little mermaid"],
  ["under the sea journey of the little mermaid","under the sea - journey of the little mermaid"],
  // Tomorrowland Transit Authority PeopleMover (Magic Kingdom)
  ["peoplemover",                                "tomorrowland transit authority peoplemover"],
  ["tomorrowland transit",                       "tomorrowland transit authority peoplemover"],
  ["tta",                                        "tomorrowland transit authority peoplemover"],
  // Mission: SPACE (EPCOT) — Queue-Times may omit colon
  ["mission space",                              "mission: space"],
  // Journey Into Imagination With Figment (EPCOT)
  ["figment",                                    "journey into imagination with figment"],
  ["journey into imagination",                   "journey into imagination with figment"],
  // Gran Fiesta Tour Starring The Three Caballeros (EPCOT) — subtitle truncation
  ["gran fiesta tour",                           "gran fiesta tour starring the three caballeros"],
  ["three caballeros",                           "gran fiesta tour starring the three caballeros"],
  ["gran fiesta tour starring three caballeros", "gran fiesta tour starring the three caballeros"],
  // Star Tours – The Adventures Continue (Hollywood Studios) — subtitle truncation
  ["star tours",                                 "star tours - the adventures continue"],
  ["star tours the adventures continue",         "star tours - the adventures continue"],
  // Kali River Rapids (Animal Kingdom) — common shortening
  ["kali river",                                 "kali river rapids"],
  // Magic Carpets of Aladdin (Magic Kingdom) — API includes leading "The"
  ["the magic carpets of aladdin",               "magic carpets of aladdin"],
  // Walt Disney's Carousel of Progress (Magic Kingdom) — common shortenings
  ["carousel of progress",                       "walt disney's carousel of progress"],
  ["cop",                                        "walt disney's carousel of progress"],
  // Soarin' Across America (EPCOT) — Phase 8.5.1: canonical renamed; "Around the World"
  // kept as alias so Queue-Times entries with the old name still resolve.
  ["soarin' around the world",                   "soarin' across america"],
  ["soarin around the world",                    "soarin' across america"],
  // Walt Disney World Railroad (Magic Kingdom) — Queue-Times exposes each
  // station as its own ride record rather than one attraction. All
  // stations are the same physical ride and the same canonical DWP
  // attraction/land (Main Street, U.S.A.); resolving them to one key lets
  // MULTI_STATION_IDENTITIES_WDW/aggregateStationRecords() (below) combine
  // the simultaneous station records into one authoritative status/wait
  // instead of the app showing a separate card per station.
  // Confirmed provider strings: Main Street, U.S.A. and Fantasyland
  // (Fantasyland station ID 1181, observed live). Frontierland is a real
  // physical station of this ride but its exact current Queue-Times string
  // is unconfirmed — kept defensively since an unused alias key is a no-op
  // if Queue-Times never sends it, and this needs no separate confirmation
  // for correctness: any string reported for a Railroad station that isn't
  // recognized here would surface as an "Unmatched live attraction" dev
  // warning rather than silently misbehave.
  ["walt disney world railroad - main street, u.s.a.", "walt disney world railroad"],
  ["walt disney world railroad - main street usa",      "walt disney world railroad"],
  ["walt disney world railroad - frontierland",         "walt disney world railroad"],
  ["walt disney world railroad - fantasyland",          "walt disney world railroad"],
  // Living with the Land (EPCOT, World Nature) — Queue-Times renames this to
  // "Living with the Land – Glimmering Greenhouses" during the EPCOT
  // International Festival of the Holidays (confirmed via Queue-Times-derived
  // tracker wdwstats.com's "livingwiththelandglimmeringgreenhouses" page).
  // normalizeAttractionName() folds en/em dash to "-", covering both the
  // en-dash and hyphen forms Disney/Queue-Times may use.
  ["living with the land - glimmering greenhouses", "living with the land"],
]);

/**
 * DLR-only alias map: normalized-alias → canonical-normalized-mock-name.
 * Same contract as ALIASES_WDW — keys and values in normalizeAttractionName() form.
 */
const ALIASES_DLR = new Map<string, string>([
  // Haunted Mansion (Disneyland Park) — Queue-Times renames this to "Haunted
  // Mansion Holiday" during the seasonal Nightmare Before Christmas overlay
  // (same ride, same canonical DWP identity — never a separate attraction).
  // Not inferred/time-based: either provider name is recognized whenever
  // Queue-Times actually returns it.
  ["haunted mansion holiday",                    "haunted mansion"],
  // "it's a small world" (Disneyland Park) — Queue-Times renames this to
  // "it's a small world" Holiday during the Nov–Jan seasonal overlay.
  // Confirmed via Queue-Times-derived trackers (dlstats.com/dlpstats.com
  // "itsasmallworldholiday"); DLR-only, MK's small world has no overlay.
  // Both a quoted and unquoted key are covered since it's uncertain which
  // exact punctuation Queue-Times' feed uses.
  ["\"it's a small world\" holiday",             "\"it's a small world\""],
  ["it's a small world holiday",                 "\"it's a small world\""],
  // Luigi's Rollickin' Roadsters (DCA, Cars Land) — Queue-Times renames this
  // for the Halloween and Christmas seasonal overlays (confirmed distinct
  // Queue-Times ride IDs; same physical ride, same canonical identity).
  ["luigi's honkin' haul-o-ween",                "luigi's rollickin' roadsters"],
  ["luigi's joy to the whirl",                   "luigi's rollickin' roadsters"],
  // Mater's Junkyard Jamboree (DCA, Cars Land) — same seasonal-overlay
  // pattern as Luigi's above (confirmed distinct Queue-Times ride IDs).
  ["mater's graveyard jambooree",                "mater's junkyard jamboree"],
  ["mater's jingle jamboree",                    "mater's junkyard jamboree"],
  // The Many Adventures of Winnie the Pooh (Disneyland Park)
  ["winnie the pooh",                            "the many adventures of winnie the pooh"],
  ["pooh",                                       "the many adventures of winnie the pooh"],
  ["many adventures of winnie the pooh",         "the many adventures of winnie the pooh"],
  // "it's a small world" (Disneyland) — mock name has surrounding typographic quotes;
  // Queue-Times omits them. Both sides normalized, value retains the literal " chars.
  ["it's a small world",                         "\"it's a small world\""],
  // Soarin' Across America (DCA) — canonical as of July 2026.
  // Queue-Times may still return old names; alias them all to the new canonical.
  ["soarin' over california",                    "soarin' across america"],
  ["soarin over california",                     "soarin' across america"],
  ["soarin' around the world",                   "soarin' across america"],
  ["soarin around the world",                    "soarin' across america"],
]);

/**
 * Returns true if `candidate` is strictly fresher than `current` based on
 * `last_updated`. Used to resolve duplicate provider rows that normalize to
 * the same attraction identity — the freshest timestamp wins.
 *
 * Unparseable/missing timestamps never beat an existing valid one, so a
 * malformed duplicate can't clobber a good record.
 */
function isFresher(candidate: QTRide, current: QTRide): boolean {
  const candidateTime = Date.parse(candidate.last_updated);
  const currentTime = Date.parse(current.last_updated);
  if (Number.isNaN(candidateTime)) return false;
  if (Number.isNaN(currentTime)) return true;
  return candidateTime > currentTime;
}

/**
 * Canonical identities (post-ALIASES_WDW resolution) whose Queue-Times rows
 * are simultaneous ride *stations*, not sequential revisions of one record.
 *
 * Ordinary duplicate handling (liveByName below: freshest `last_updated`
 * row wins, older rows discarded) assumes every row for a given identity is
 * describing the *same* thing at a different point in time — true for a
 * renamed/aliased attraction (e.g. Rock 'n' Roller Coaster's old/new name),
 * where only one literal name is "current" at once. It is wrong here:
 * Walt Disney World Railroad is a single loop with three boarding stations
 * (Main Street, U.S.A.; Frontierland; Fantasyland), and Queue-Times reports
 * each station as its own ride record. Those records can legitimately have
 * different `last_updated` values while all being simultaneously valid —
 * picking only the freshest would let a station that happens to report a
 * moment later, but is itself closed/boarding-only, discard another
 * station's evidence that the ride is actually running.
 *
 * Rows for these identities never enter the freshest-wins loop below.
 * Instead: each row is first resolved to its own physical station via
 * stationIdentity() and deduped against other rows for that SAME station
 * (Queue-Times can report one station twice — e.g. once in `lands[].rides`,
 * once in the top-level `rides` array — and only the freshest revision of
 * a given station may count as its current state); only then are the
 * surviving, per-station-deduped rows combined by aggregateStationRecords()
 * into the canonical result. Ordinary duplicate/revision handling is
 * completely unaffected for every other identity.
 */
const MULTI_STATION_IDENTITIES_WDW = new Set<string>([
  "walt disney world railroad",
]);

/**
 * Combines simultaneous station records for one multi-station identity
 * (see MULTI_STATION_IDENTITIES_WDW) into a single synthesized live record.
 *
 * Status: the attraction is treated as operating if ANY station reports
 * `is_open`. Queue-Times models each physical boarding platform as its own
 * "ride", but the train itself is a single circuit — one open station means
 * trains are running, so a closed station must never force the whole
 * attraction DOWN while another station shows it operating.
 *
 * Wait: the `wait_time` of the freshest OPERATING station (freshest by
 * `last_updated`, via the same isFresher() rule the rest of this module
 * uses for tie-breaking). This is deliberately not min/max/a fixed
 * station's priority — a boarding wait is a live, single-queue number tied
 * to whichever station a rider actually queues at, and the freshest report
 * among the currently-running stations is the most recently observed truth
 * for that queue. When no station is operating, wait is 0/not applicable
 * (the downstream overlay maps `is_open: false` to waitMins: null
 * regardless of this value).
 *
 * last_updated: the freshest OPERATING station's timestamp when the
 * attraction is operating; otherwise the freshest station's timestamp
 * overall, so a fully-down attraction still carries a sensible "last
 * checked" time instead of an arbitrary one.
 *
 * Ties (equal/unparseable timestamps) resolve deterministically to the
 * first station encountered in provider response order — the same
 * first-seen-wins behavior isFresher() already produces for ordinary
 * duplicates.
 */
/**
 * Identifies which physical station a Queue-Times row is reporting on,
 * within one multi-station canonical identity (see
 * MULTI_STATION_IDENTITIES_WDW) — distinct from identifying a *duplicate
 * revision* of that same station. Queue-Times can report the same
 * physical station twice in one payload (e.g. once in `lands[].rides`,
 * once in the top-level `rides` array — see QTResponse's own doc comment
 * on why that top-level array exists), and those duplicate rows must be
 * resolved to one freshest revision *before* aggregateStationRecords()
 * ever treats a row as evidence of a distinct, simultaneously-valid
 * station.
 *
 * Prefers Queue-Times' own stable per-ride `id` — the same identifier
 * `isFresher`'s ordinary duplicate-revision resolution effectively relies
 * on elsewhere in this module (rows for one ride sharing an id/name should
 * collapse to their freshest `last_updated`). Falls back to the row's own
 * normalized station name only when `id` isn't a usable number at
 * runtime (the QTResponse body is `unknown` cast, so a malformed payload
 * can't be ruled out) — deliberately the row's *own* name, never the
 * canonical alias-resolved identity, so two genuinely distinct stations
 * (different ids and different names) are never collapsed together.
 */
function stationIdentity(ride: QTRide): string {
  if (typeof ride.id === "number" && Number.isFinite(ride.id)) {
    return `id:${ride.id}`;
  }
  return `name:${normalizeAttractionName(ride.name)}`;
}

function aggregateStationRecords(stations: QTRide[]): QTRide {
  const operatingStations = stations.filter((s) => s.is_open);
  const pool = operatingStations.length > 0 ? operatingStations : stations;

  let freshest = pool[0];
  for (const candidate of pool.slice(1)) {
    if (isFresher(candidate, freshest)) {
      freshest = candidate;
    }
  }

  return {
    id: freshest.id,
    name: freshest.name,
    is_open: operatingStations.length > 0,
    wait_time: operatingStations.length > 0 ? freshest.wait_time : 0,
    last_updated: freshest.last_updated,
  };
}

function normalizeQueueTimesResponse(
  body: unknown,
  resortId: ResortId,
  parkId: ParkId,
): AttractionWait[] {
  const mockPark = mockAttractionWaits.filter(
    (a) => a.resortId === resortId && a.parkId === parkId,
  );

  // Guard: must be an object with a lands array
  if (
    body === null ||
    typeof body !== "object" ||
    !Array.isArray((body as QTResponse).lands)
  ) {
    return mockPark;
  }

  const qt = body as QTResponse;

  // Build canonical attraction identity → live ride lookup.
  //
  // Queue-Times can return multiple rows that resolve to the same effective
  // attraction identity — either literal name duplicates, or an old/new
  // alias pair (e.g. a stale row under the old name alongside a fresh row
  // under the current name). Resolving each ride to its canonical identity
  // *before* comparing freshness ensures the freshest row always wins,
  // regardless of which literal name it was published under.
  const aliasMap =
    resortId === "WDW" ? ALIASES_WDW : resortId === "DLR" ? ALIASES_DLR : null;

  const allRides: QTRide[] = qt.lands.flatMap((land) => land.rides ?? []);
  allRides.push(...(qt.rides ?? []));

  const multiStationIdentities = resortId === "WDW" ? MULTI_STATION_IDENTITIES_WDW : null;

  // Rides resolving to a multi-station identity are collected separately,
  // keyed first by canonical identity and then by stationIdentity() — the
  // inner map resolves duplicate revisions of the SAME physical station
  // (e.g. a row from `lands[].rides` and a row from the top-level `rides`
  // array both describing Fantasyland) to their freshest revision via the
  // same isFresher() rule used for ordinary duplicates below, so a stale
  // revision can never smuggle a station's outdated state into
  // aggregateStationRecords(). Only after that per-station dedupe does
  // aggregateStationRecords() treat the surviving rows as distinct,
  // simultaneously-valid stations — it never sees raw, unresolved
  // duplicate revisions.
  const stationGroups = new Map<string, Map<string, QTRide>>();

  const liveByName = new Map<string, QTRide>();
  for (const ride of allRides) {
    const normName = normalizeAttractionName(ride.name);
    const key = aliasMap?.get(normName) ?? normName;

    if (multiStationIdentities?.has(key)) {
      let stations = stationGroups.get(key);
      if (!stations) {
        stations = new Map<string, QTRide>();
        stationGroups.set(key, stations);
      }
      const stationKey = stationIdentity(ride);
      const existingStation = stations.get(stationKey);
      if (!existingStation || isFresher(ride, existingStation)) {
        stations.set(stationKey, ride);
      }
      continue;
    }

    const existing = liveByName.get(key);
    if (existing && !isFresher(ride, existing)) {
      continue;
    }
    liveByName.set(key, ride);
  }
  for (const [key, stations] of stationGroups) {
    liveByName.set(key, aggregateStationRecords(Array.from(stations.values())));
  }

  // Dev-only: warn about live rides that have no mock counterpart.
  // Helps identify attractions we should add or rename in mock.ts.
  if (process.env.NODE_ENV !== "production") {
    const mockNames = new Set(mockPark.map((a) => normalizeAttractionName(a.name)));
    for (const [normLiveName, ride] of liveByName) {
      if (!mockNames.has(normLiveName) && (ride.is_open || ride.wait_time > 0)) {
        console.warn("[LiveWaitApi] Unmatched live attraction:", ride.name);
      }
    }
  }

  const now = new Date();

  // Overlay live values onto mock rides; keep mock where no match exists.
  // Status priority:
  //   1. Planned closure (status enforced) → "CLOSED" (unless sanity override)
  //   2. Planned closure (not enforced)    → fall through to live
  //   3. Live says not open                → "DOWN"   (temporary outage)
  //   4. Live says open                    → "OPERATING" with live wait time
  //
  // "Status enforced" (isClosureStatusEnforced) is deliberately NOT the same
  // check as the Planned Closures UI's active-list presentation
  // (getClosureTiming): a PERMANENT closure ages out of that presentation
  // ~1 year after its closure date, but must keep forcing CLOSED forever —
  // it is never expected to reopen, so it must never fall through to
  // Queue-Times as DOWN/OPERATING just because it's no longer shown in the
  // Planned Closures list.
  const resolved = mockPark.map((mockRide): AttractionWait => {
    const normName = normalizeAttractionName(mockRide.name);
    const closureKey = `${parkId}:${normName}`;
    const live = liveByName.get(normName);

    if (PLANNED_CLOSURES.has(closureKey)) {
      const entry = PLANNED_CLOSURES.get(closureKey);

      if (isClosureStatusEnforced(entry?.dateRange, now, entry?.closureType)) {
        // SANITY OVERRIDE: if live clearly reports the ride is operating
        // (is_open=true AND wait_time>0), do NOT force CLOSED — live data wins.
        if (!isClearlyOperatingFromLive(live)) {
          return { ...mockRide, status: "CLOSED", waitMins: null };
        }
        if (process.env.NODE_ENV !== "production") {
          console.debug("[closure] sanity override: live operating", {
            key: closureKey,
            wait: live?.wait_time,
          });
        }
        // Fall through to live status below.
      }
      // Not enforced (UPCOMING, or TEMPORARY past its end date): fall
      // through to live status below.
    }

    if (!live) return mockRide; // no match: keep mock values (waitSource "fallback")

    // Ride not operating: explicitly clear wait time so no stale/mock minutes leak.
    // Still a live match (waitSource "live") even though no numeric wait is shown —
    // provenance reflects the match, not the resulting status/wait value.
    if (!live.is_open) {
      return {
        ...mockRide,
        status: "DOWN",
        waitMins: null,
        updatedAt: live.last_updated,
        waitSource: "live",
      };
    }

    // Ride operating: apply live wait time (including a live 0-minute wait).
    return {
      ...mockRide,
      status: "OPERATING",
      waitMins: live.wait_time,
      updatedAt: live.last_updated,
      waitSource: "live",
    };
  });

  // Final safeguard: collapse any resolved attractions that share the same
  // canonical identity (alias-equivalent names) into a single record, keeping
  // whichever has the freshest `updatedAt`. This guarantees the array the UI
  // actually renders and sorts can never contain a stale duplicate, even if
  // some other path were to introduce one upstream of this point.
  return dedupeByCanonicalIdentity(resolved, aliasMap);
}

/**
 * Collapses attractions that resolve to the same canonical identity
 * (via the resort's alias map, falling back to the normalized name),
 * keeping only the entry with the freshest `updatedAt`. Order of first
 * occurrence is preserved for ties/no-duplicates so existing sort/filter
 * behavior is unaffected.
 */
function dedupeByCanonicalIdentity(
  attractions: AttractionWait[],
  aliasMap: Map<string, string> | null,
): AttractionWait[] {
  const byKey = new Map<string, AttractionWait>();
  const keyOrder: string[] = [];

  for (const attraction of attractions) {
    const normName = normalizeAttractionName(attraction.name);
    const key = aliasMap?.get(normName) ?? normName;
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, attraction);
      keyOrder.push(key);
      continue;
    }

    const existingTime = Date.parse(existing.updatedAt);
    const candidateTime = Date.parse(attraction.updatedAt);
    const candidateIsFresher =
      !Number.isNaN(candidateTime) &&
      (Number.isNaN(existingTime) || candidateTime > existingTime);

    if (candidateIsFresher) {
      byKey.set(key, attraction);
    }
  }

  return keyOrder.map((key) => byKey.get(key)!);
}

// ============================================
// SANITY OVERRIDE HELPER
// ============================================

/**
 * Returns true ONLY when live data unambiguously shows the ride is operating:
 *   is_open === true AND wait_time is a positive number.
 *
 * Used to bypass planned-closure enforcement when stale/incorrect closure
 * data would otherwise incorrectly hide an operating attraction.
 * In mock mode live is undefined → returns false → no regression.
 */
function isClearlyOperatingFromLive(
  live: { is_open?: boolean; wait_time?: number | null } | undefined,
): boolean {
  return (
    live?.is_open === true &&
    typeof live.wait_time === "number" &&
    live.wait_time > 0
  );
}

// ============================================
// FETCH HELPER
// ============================================

async function fetchLiveData(
  resortId: ResortId,
  parkId: ParkId,
): Promise<WaitDataset> {
  const qtParkId = QUEUE_TIMES_PARK_MAP[`${resortId}:${parkId}`];
  if (qtParkId === undefined) {
    throw new Error(`No Queue-Times mapping for ${resortId}:${parkId}`);
  }

  const url = `${API_BASE_URL}/api/waits/queue-times?qtParkId=${qtParkId}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("JSON parse failure");
    }

    const data = normalizeQueueTimesResponse(body, resortId, parkId);
    const lastUpdated = Date.now();
    return { data, dataSource: "live", lastUpdated };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================
// MOCK FALLBACK
// ============================================

function getMockDataset(resortId: ResortId, parkId: ParkId): WaitDataset {
  return {
    data: mockAttractionWaits.filter(
      (a) => a.resortId === resortId && a.parkId === parkId,
    ),
    dataSource: "mock",
    lastUpdated: null,
  };
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Returns wait time data for the given resort + park.
 *
 * - LIVE_ENABLED = false  → returns mock data immediately (no fetch)
 * - No park mapping       → returns mock data immediately (no fetch)
 * - Cache valid           → returns cached data immediately (no fetch)
 * - Cache stale           → fetches via proxy; on success caches + returns live
 * - Fetch fails           → returns mock data (never throws to caller)
 * - Concurrent calls      → in-flight deduplication (one Promise per key)
 */
export async function getWaitDataset({
  resortId,
  parkId,
}: {
  resortId: ResortId;
  parkId: ParkId;
}): Promise<WaitDataset> {
  // Short-circuit: live API disabled
  if (!LIVE_ENABLED) {
    return getMockDataset(resortId, parkId);
  }

  // Short-circuit: no mapping for this park (returns mock silently)
  if (QUEUE_TIMES_PARK_MAP[`${resortId}:${parkId}`] === undefined) {
    return getMockDataset(resortId, parkId);
  }

  const key = cacheKey(resortId, parkId);
  const now = Date.now();

  // 1. Return valid in-memory cached entry immediately (no fetch)
  const cached = cache.get(key);
  if (cached && now < cached.expiresAt) {
    return {
      data: cached.data,
      dataSource: cached.dataSource,
      lastUpdated: cached.lastUpdated,
    };
  }

  // 2. Deduplicate: return the in-flight Promise if a request is already running
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }

  // 3. In-memory miss — try sessionStorage (survives F5 within same tab session).
  const session = readSessionCache(key);
  if (session && now < session.expiresAt) {
    cache.set(key, session); // re-warm in-memory for subsequent calls this session
    return {
      data: session.data,
      dataSource: session.dataSource,
      lastUpdated: session.lastUpdated,
    };
  }

  // 4. sessionStorage miss — try localStorage (survives full browser close/reopen).
  const local = readLocalCache(key);
  if (local && now < local.expiresAt) {
    cache.set(key, local); // re-warm in-memory for subsequent calls this session
    return {
      data: local.data,
      dataSource: local.dataSource,
      lastUpdated: local.lastUpdated,
    };
  }

  // 5. Start a new fetch, register as in-flight
  const request = fetchLiveData(resortId, parkId)
    .then((result) => {
      const entry: CacheEntry = { ...result, expiresAt: now + CACHE_TTL_MS };
      cache.set(key, entry);
      writeSessionCache(key, entry); // survives F5
      writeLocalCache(key, entry);   // survives browser restart
      return result;
    })
    .catch((): WaitDataset => {
      // Any fetch error (network, timeout, non-2xx, parse, no mapping) → mock fallback.
      // Not persisted to sessionStorage: a failed fetch should be retried next page load.
      return getMockDataset(resortId, parkId);
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, request);
  return request;
}

// ============================================
// RESORT-LEVEL HELPERS (used by My Plans)
// ============================================

/**
 * All parks per resort, in display order.
 * Exported so consumers (e.g. My Plans) can iterate parks without
 * duplicating the list.
 */
export const RESORT_PARKS: Record<ResortId, ParkId[]> = {
  DLR: ["disneyland", "dca"],
  WDW: ["mk", "epcot", "hs", "ak"],
};

/**
 * Fetch and merge live wait data for EVERY park in a resort.
 *
 * Uses the same per-park TTL cache as getWaitDataset so concurrent calls
 * (e.g. Wait Times page already loaded one park) share cached results.
 *
 * dataSource is "live" if at least one park returned live data.
 * lastUpdated is the earliest (oldest) timestamp across parks.
 * Falls back transparently to mock if live is disabled or a park fails.
 */
export async function getWaitDatasetForResort(
  resortId: ResortId,
): Promise<WaitDataset> {
  const parks = RESORT_PARKS[resortId];
  const results = await Promise.all(
    parks.map((parkId) => getWaitDataset({ resortId, parkId })),
  );
  const data = results.flatMap((r) => r.data);
  const isLive = results.some((r) => r.dataSource === "live");
  const lastUpdated = results.reduce<number | null>((acc, r) => {
    if (r.lastUpdated == null) return acc;
    return acc == null ? r.lastUpdated : Math.min(acc, r.lastUpdated);
  }, null);
  return { data, dataSource: isLive ? "live" : "mock", lastUpdated };
}

// ============================================
// DEV-ONLY REGRESSION CASES (Queue-Times canonical identity / dedupe)
// ============================================

/**
 * Dev-only wrapper exposing normalizeQueueTimesResponse for manual
 * regression checks (see DEV_QUEUE_TIMES_DEDUPE_CASES below). Not used by
 * any production code path.
 */
export function devNormalizeQueueTimesResponse(
  body: unknown,
  resortId: ResortId,
  parkId: ParkId,
): AttractionWait[] {
  return normalizeQueueTimesResponse(body, resortId, parkId);
}

/** Builds a minimal Queue-Times ride record for DEV case construction. */
function devQTRide(
  id: number,
  name: string,
  isOpen: boolean,
  waitTime: number,
  lastUpdated: string,
): QTRide {
  return { id, name, is_open: isOpen, wait_time: waitTime, last_updated: lastUpdated };
}

/**
 * Regression cases for Queue-Times canonical identity / dedupe / station
 * aggregation handling — in particular Walt Disney World Railroad, which
 * Queue-Times exposes as one ride record per station (Main Street, U.S.A.;
 * Frontierland; Fantasyland) instead of one attraction — plus wait-value
 * provenance (`waitSource`), so a card can be told apart from the ground
 * truth it actually came from rather than inferred from its status/wait.
 * Mirrors the DEV_PLAN_ALIAS_CASES / DEV_CLOSURE_TIMING_CASES convention
 * (plansMatching.ts, plannedClosures.ts) — not wired into CI (no test
 * runner in this repo), run manually from Node:
 *
 *   import { DEV_QUEUE_TIMES_DEDUPE_CASES, devNormalizeQueueTimesResponse } from "@/lib/liveWaitApi";
 *   for (const c of DEV_QUEUE_TIMES_DEDUPE_CASES) {
 *     const result = devNormalizeQueueTimesResponse(c.body, c.resortId, c.parkId);
 *     const failure = c.check(result);
 *     console.log(failure ? `✗ FAIL ${c.description}: ${failure}` : `✓ ${c.description}`);
 *   }
 */
export const DEV_QUEUE_TIMES_DEDUPE_CASES: Array<{
  description: string;
  resortId: ResortId;
  parkId: ParkId;
  body: unknown;
  /** Returns null on pass, or a failure message. */
  check: (result: AttractionWait[]) => string | null;
}> = [
  {
    description: "Main Street, U.S.A. Railroad variant resolves to canonical attraction (live, positive wait)",
    resortId: "WDW",
    parkId: "mk",
    body: {
      lands: [
        {
          id: 1,
          name: "Main Street, U.S.A.",
          rides: [
            devQTRide(1180, "Walt Disney World Railroad - Main Street, U.S.A.", true, 10, "2026-01-01T12:00:00Z"),
          ],
        },
      ],
    },
    check: (result) => {
      const matches = result.filter((a) => a.id === "mk-wdw-railroad");
      if (matches.length !== 1) return `expected exactly 1 railroad card, got ${matches.length}`;
      const railroad = matches[0];
      if (railroad.status !== "OPERATING" || railroad.waitMins !== 10) {
        return `expected OPERATING/10, got ${railroad.status}/${railroad.waitMins}`;
      }
      if (railroad.land !== "Main Street, U.S.A.") return `expected canonical land, got ${railroad.land}`;
      if (railroad.waitSource !== "live") return `expected waitSource "live", got ${railroad.waitSource}`;
      return null;
    },
  },
  {
    description: "Fantasyland Railroad variant (provider ID 1181) resolves to same canonical attraction (live, DOWN)",
    resortId: "WDW",
    parkId: "mk",
    body: {
      lands: [
        {
          id: 2,
          name: "Fantasyland",
          rides: [
            devQTRide(1181, "Walt Disney World Railroad - Fantasyland", false, 0, "2026-01-01T12:00:00Z"),
          ],
        },
      ],
    },
    check: (result) => {
      const matches = result.filter((a) => a.id === "mk-wdw-railroad");
      if (matches.length !== 1) return `expected exactly 1 railroad card, got ${matches.length}`;
      const railroad = matches[0];
      if (railroad.land !== "Main Street, U.S.A.") return `expected canonical land, got ${railroad.land}`;
      // Closed live station: no numeric wait shown, but still a live match —
      // status/waitMins must never make a live record look like fallback.
      if (railroad.status !== "DOWN" || railroad.waitMins !== null) {
        return `expected DOWN/null, got ${railroad.status}/${railroad.waitMins}`;
      }
      if (railroad.waitSource !== "live") return `expected waitSource "live", got ${railroad.waitSource}`;
      return null;
    },
  },
  {
    description: "Frontierland Railroad variant resolves to same canonical attraction",
    resortId: "WDW",
    parkId: "mk",
    body: {
      lands: [
        {
          id: 3,
          name: "Frontierland",
          rides: [
            devQTRide(1182, "Walt Disney World Railroad - Frontierland", false, 0, "2026-01-01T12:00:00Z"),
          ],
        },
      ],
    },
    check: (result) => {
      const matches = result.filter((a) => a.id === "mk-wdw-railroad");
      if (matches.length !== 1) return `expected exactly 1 railroad card, got ${matches.length}`;
      if (matches[0].land !== "Main Street, U.S.A.") return `expected canonical land, got ${matches[0].land}`;
      if (matches[0].waitSource !== "live") return `expected waitSource "live", got ${matches[0].waitSource}`;
      return null;
    },
  },
  {
    description:
      "Codex P2: an OLDER operating station must not be discarded by a NEWER closed station (station aggregation, not freshest-wins)",
    resortId: "WDW",
    parkId: "mk",
    body: {
      lands: [
        // Main Street: operating, 10 min, OLDER timestamp.
        { id: 1, name: "Main Street, U.S.A.", rides: [devQTRide(1180, "Walt Disney World Railroad - Main Street, U.S.A.", true, 10, "2026-01-01T12:00:00Z")] },
        // Fantasyland: closed, NEWER timestamp — must not win outright.
        { id: 2, name: "Fantasyland", rides: [devQTRide(1181, "Walt Disney World Railroad - Fantasyland", false, 0, "2026-01-01T12:05:00Z")] },
        // Frontierland: also closed, timestamp in between.
        { id: 3, name: "Frontierland", rides: [devQTRide(1182, "Walt Disney World Railroad - Frontierland", false, 0, "2026-01-01T12:02:00Z")] },
      ],
    },
    check: (result) => {
      const matches = result.filter((a) => a.id === "mk-wdw-railroad");
      if (matches.length !== 1) return `expected exactly 1 railroad card, got ${matches.length}`;
      // Any station open → the ride is running. Wait comes from the (only)
      // operating station, not from whichever station reported last.
      if (matches[0].status !== "OPERATING" || matches[0].waitMins !== 10) {
        return `expected OPERATING/10 (Main Street, the only open station) to win, got ${matches[0].status}/${matches[0].waitMins}`;
      }
      if (matches[0].waitSource !== "live") return `expected waitSource "live", got ${matches[0].waitSource}`;
      return null;
    },
  },
  {
    description: "All Railroad stations closed → aggregate DOWN, not OPERATING",
    resortId: "WDW",
    parkId: "mk",
    body: {
      lands: [
        { id: 1, name: "Main Street, U.S.A.", rides: [devQTRide(1180, "Walt Disney World Railroad - Main Street, U.S.A.", false, 0, "2026-01-01T12:00:00Z")] },
        { id: 2, name: "Fantasyland", rides: [devQTRide(1181, "Walt Disney World Railroad - Fantasyland", false, 0, "2026-01-01T12:05:00Z")] },
        { id: 3, name: "Frontierland", rides: [devQTRide(1182, "Walt Disney World Railroad - Frontierland", false, 0, "2026-01-01T12:02:00Z")] },
      ],
    },
    check: (result) => {
      const matches = result.filter((a) => a.id === "mk-wdw-railroad");
      if (matches.length !== 1) return `expected exactly 1 railroad card, got ${matches.length}`;
      if (matches[0].status !== "DOWN" || matches[0].waitMins !== null) {
        return `expected DOWN/null, got ${matches[0].status}/${matches[0].waitMins}`;
      }
      if (matches[0].waitSource !== "live") return `expected waitSource "live", got ${matches[0].waitSource}`;
      return null;
    },
  },
  {
    description:
      "Multiple operating Railroad stations with differing waits/timestamps → freshest OPERATING station's wait wins",
    resortId: "WDW",
    parkId: "mk",
    body: {
      lands: [
        // Main Street: operating, older timestamp.
        { id: 1, name: "Main Street, U.S.A.", rides: [devQTRide(1180, "Walt Disney World Railroad - Main Street, U.S.A.", true, 10, "2026-01-01T12:00:00Z")] },
        // Fantasyland: also operating, NEWER timestamp, different wait — this should win.
        { id: 2, name: "Fantasyland", rides: [devQTRide(1181, "Walt Disney World Railroad - Fantasyland", true, 25, "2026-01-01T12:07:00Z")] },
        // Frontierland: closed — excluded from the operating-station pool entirely.
        { id: 3, name: "Frontierland", rides: [devQTRide(1182, "Walt Disney World Railroad - Frontierland", false, 0, "2026-01-01T12:09:00Z")] },
      ],
    },
    check: (result) => {
      const matches = result.filter((a) => a.id === "mk-wdw-railroad");
      if (matches.length !== 1) return `expected exactly 1 railroad card, got ${matches.length}`;
      if (matches[0].status !== "OPERATING" || matches[0].waitMins !== 25) {
        return `expected OPERATING/25 (freshest operating station, Fantasyland) to win, got ${matches[0].status}/${matches[0].waitMins}`;
      }
      return null;
    },
  },
  {
    description: "Equal/unparseable timestamps across station variants stay deterministic (first-seen wins)",
    resortId: "WDW",
    parkId: "mk",
    body: {
      lands: [
        { id: 1, name: "Main Street, U.S.A.", rides: [devQTRide(1180, "Walt Disney World Railroad - Main Street, U.S.A.", true, 10, "not-a-timestamp")] },
        { id: 2, name: "Fantasyland", rides: [devQTRide(1181, "Walt Disney World Railroad - Fantasyland", true, 25, "not-a-timestamp")] },
      ],
    },
    check: (result) => {
      const matches = result.filter((a) => a.id === "mk-wdw-railroad");
      if (matches.length !== 1) return `expected exactly 1 railroad card, got ${matches.length}`;
      // Neither timestamp parses, so isFresher() never lets the second
      // operating station displace the first — Main Street (seen first,
      // and itself operating) must win, deterministically.
      if (matches[0].status !== "OPERATING" || matches[0].waitMins !== 10) {
        return `expected first-seen (Main Street, OPERATING/10) to win, got ${matches[0].status}/${matches[0].waitMins}`;
      }
      return null;
    },
  },
  {
    description:
      "Codex P2 follow-up: same station (Fantasyland, id 1181) OLDER revision OPEN + NEWER revision CLOSED → freshest revision (CLOSED) wins before aggregation",
    resortId: "WDW",
    parkId: "mk",
    body: {
      lands: [
        {
          id: 2,
          name: "Fantasyland",
          rides: [
            // Older revision: OPEN. Must not survive station-revision dedupe.
            devQTRide(1181, "Walt Disney World Railroad - Fantasyland", true, 15, "2026-01-01T12:00:00Z"),
            // Newer revision of the SAME station (same id): CLOSED.
            devQTRide(1181, "Walt Disney World Railroad - Fantasyland", false, 0, "2026-01-01T12:05:00Z"),
          ],
        },
      ],
    },
    check: (result) => {
      const matches = result.filter((a) => a.id === "mk-wdw-railroad");
      if (matches.length !== 1) return `expected exactly 1 railroad card, got ${matches.length}`;
      // Only one physical station present (Fantasyland). If the stale OPEN
      // revision incorrectly survived alongside the fresh CLOSED one,
      // aggregateStationRecords() would see 2 "stations" and wrongly report
      // OPERATING from the stale row.
      if (matches[0].status !== "DOWN" || matches[0].waitMins !== null) {
        return `expected DOWN/null (freshest CLOSED revision), got ${matches[0].status}/${matches[0].waitMins}`;
      }
      return null;
    },
  },
  {
    description:
      "Codex P2 follow-up: same station (Fantasyland, id 1181) OLDER revision CLOSED + NEWER revision OPEN → freshest revision (OPEN) wins",
    resortId: "WDW",
    parkId: "mk",
    body: {
      lands: [
        {
          id: 2,
          name: "Fantasyland",
          rides: [
            // Older revision: CLOSED.
            devQTRide(1181, "Walt Disney World Railroad - Fantasyland", false, 0, "2026-01-01T12:00:00Z"),
            // Newer revision of the SAME station (same id): OPEN.
            devQTRide(1181, "Walt Disney World Railroad - Fantasyland", true, 20, "2026-01-01T12:05:00Z"),
          ],
        },
      ],
    },
    check: (result) => {
      const matches = result.filter((a) => a.id === "mk-wdw-railroad");
      if (matches.length !== 1) return `expected exactly 1 railroad card, got ${matches.length}`;
      if (matches[0].status !== "OPERATING" || matches[0].waitMins !== 20) {
        return `expected OPERATING/20 (freshest OPEN revision), got ${matches[0].status}/${matches[0].waitMins}`;
      }
      return null;
    },
  },
  {
    description:
      "Codex P2 follow-up: duplicate revisions of one station plus a distinct operating station — the distinct station still participates",
    resortId: "WDW",
    parkId: "mk",
    body: {
      lands: [
        {
          id: 2,
          name: "Fantasyland",
          rides: [
            // Two revisions of the SAME station (id 1181) — both resolve
            // CLOSED after dedupe (freshest of the two wins).
            devQTRide(1181, "Walt Disney World Railroad - Fantasyland", true, 15, "2026-01-01T12:00:00Z"),
            devQTRide(1181, "Walt Disney World Railroad - Fantasyland", false, 0, "2026-01-01T12:05:00Z"),
          ],
        },
        {
          id: 1,
          name: "Main Street, U.S.A.",
          // A genuinely DISTINCT station (different id, different name) —
          // must still be counted in the aggregation pool despite
          // Fantasyland contributing 2 raw rows for 1 station.
          rides: [devQTRide(1180, "Walt Disney World Railroad - Main Street, U.S.A.", true, 8, "2026-01-01T12:02:00Z")],
        },
      ],
    },
    check: (result) => {
      const matches = result.filter((a) => a.id === "mk-wdw-railroad");
      if (matches.length !== 1) return `expected exactly 1 railroad card, got ${matches.length}`;
      // Fantasyland resolves CLOSED; Main Street is the only operating
      // station and must win — proving it wasn't lost/miscounted just
      // because Fantasyland supplied 2 raw rows for what is still 1 station.
      if (matches[0].status !== "OPERATING" || matches[0].waitMins !== 8) {
        return `expected OPERATING/8 (Main Street, the only operating station) to win, got ${matches[0].status}/${matches[0].waitMins}`;
      }
      return null;
    },
  },
  {
    description:
      "Codex P2 follow-up: same station duplicated across lands[].rides AND the top-level rides array → freshest revision wins",
    resortId: "WDW",
    parkId: "mk",
    body: {
      lands: [
        {
          id: 2,
          name: "Fantasyland",
          // Older revision of Fantasyland (id 1181), nested under its land — OPEN.
          rides: [devQTRide(1181, "Walt Disney World Railroad - Fantasyland", true, 12, "2026-01-01T12:00:00Z")],
        },
      ],
      // Newer revision of the SAME station (same id 1181), reported at the
      // top level instead (QTResponse's own doc comment: Queue-Times uses
      // this for rides not yet assigned to a land) — CLOSED. This is the
      // exact shape Codex P2 flagged: both rows could previously reach
      // aggregateStationRecords() as if they were 2 different stations.
      rides: [devQTRide(1181, "Walt Disney World Railroad - Fantasyland", false, 0, "2026-01-01T12:06:00Z")],
    },
    check: (result) => {
      const matches = result.filter((a) => a.id === "mk-wdw-railroad");
      if (matches.length !== 1) return `expected exactly 1 railroad card, got ${matches.length}`;
      if (matches[0].status !== "DOWN" || matches[0].waitMins !== null) {
        return `expected DOWN/null (top-level revision is freshest and CLOSED), got ${matches[0].status}/${matches[0].waitMins}`;
      }
      return null;
    },
  },
  {
    description: "Codex P2 follow-up: distinct Railroad stations are never deduped together into one station",
    resortId: "WDW",
    parkId: "mk",
    body: {
      lands: [
        // Main Street: CLOSED, and reported LAST/newest — if station
        // identity were mistakenly based on the shared canonical key
        // rather than each row's own station, this closed row would
        // overwrite Fantasyland's entry entirely (same fake "station"),
        // leaving no evidence the ride is actually running.
        { id: 2, name: "Fantasyland", rides: [devQTRide(1181, "Walt Disney World Railroad - Fantasyland", true, 18, "2026-01-01T12:00:00Z")] },
        { id: 1, name: "Main Street, U.S.A.", rides: [devQTRide(1180, "Walt Disney World Railroad - Main Street, U.S.A.", false, 0, "2026-01-01T12:10:00Z")] },
      ],
    },
    check: (result) => {
      const matches = result.filter((a) => a.id === "mk-wdw-railroad");
      if (matches.length !== 1) return `expected exactly 1 railroad card, got ${matches.length}`;
      // Fantasyland (id 1181) and Main Street (id 1180) are distinct
      // stations and must both remain visible to aggregation — Fantasyland
      // operating must still win even though Main Street's closed row is
      // both different-id AND chronologically last.
      if (matches[0].status !== "OPERATING" || matches[0].waitMins !== 18) {
        return `expected OPERATING/18 (Fantasyland, still a distinct operating station) to win, got ${matches[0].status}/${matches[0].waitMins}`;
      }
      return null;
    },
  },
  {
    description: "Unrelated existing alias dedupe (Rock 'n' Roller Coaster old/new name) is unchanged — freshest wins, not aggregated",
    resortId: "WDW",
    parkId: "hs",
    body: {
      lands: [
        {
          id: 1,
          name: "Sunset Boulevard",
          rides: [
            devQTRide(200, "Rock 'n' Roller Coaster Starring Aerosmith", true, 20, "2026-01-01T12:00:00Z"),
            devQTRide(201, "Rock 'n' Roller Coaster Starring The Muppets", true, 35, "2026-01-01T12:10:00Z"),
          ],
        },
      ],
    },
    check: (result) => {
      const matches = result.filter((a) => a.id === "hs-rock-n-roller-coaster");
      if (matches.length !== 1) return `expected exactly 1 Rock 'n' Roller card, got ${matches.length}`;
      if (matches[0].waitMins !== 35) return `expected freshest (Muppets, 35) to win, got ${matches[0].waitMins}`;
      if (matches[0].waitSource !== "live") return `expected waitSource "live", got ${matches[0].waitSource}`;
      return null;
    },
  },
  // ---- Wait provenance (waitSource) cases ----
  {
    description: "Provenance: unmatched attraction with no live row keeps mock wait, marked fallback",
    resortId: "WDW",
    parkId: "mk",
    // No ride in this payload matches any mock MK attraction by name/alias.
    body: { lands: [{ id: 1, name: "Main Street, U.S.A.", rides: [] }] },
    check: (result) => {
      const junglecruise = result.find((a) => a.id === "mk-jungle-cruise");
      if (!junglecruise) return "expected mk-jungle-cruise in mock MK park data";
      if (junglecruise.waitSource !== "fallback") {
        return `expected waitSource "fallback" for an unmatched attraction, got ${junglecruise.waitSource}`;
      }
      if (junglecruise.waitMins == null) return "expected a numeric mock fallback wait to be displayed";
      return null;
    },
  },
  {
    description: "Provenance: live 0-minute wait is NOT marked fallback",
    resortId: "WDW",
    parkId: "mk",
    body: {
      lands: [
        { id: 1, name: "Adventureland", rides: [devQTRide(300, "Jungle Cruise", true, 0, "2026-01-01T12:00:00Z")] },
      ],
    },
    check: (result) => {
      const junglecruise = result.find((a) => a.id === "mk-jungle-cruise");
      if (!junglecruise) return "expected mk-jungle-cruise in mock MK park data";
      if (junglecruise.status !== "OPERATING" || junglecruise.waitMins !== 0) {
        return `expected OPERATING/0, got ${junglecruise.status}/${junglecruise.waitMins}`;
      }
      if (junglecruise.waitSource !== "live") {
        return `expected waitSource "live" for a live 0-minute wait, got ${junglecruise.waitSource}`;
      }
      return null;
    },
  },
  {
    description: "Provenance: aliased live record (Expedition Everest subtitle) remains live, not fallback",
    resortId: "WDW",
    parkId: "ak",
    body: {
      lands: [
        {
          id: 1,
          name: "Discovery Island",
          rides: [
            devQTRide(400, "Expedition Everest - Legend of the Forbidden Mountain", true, 45, "2026-01-01T12:00:00Z"),
          ],
        },
      ],
    },
    check: (result) => {
      const everest = result.find((a) => a.id === "ak-expedition-everest");
      if (!everest) return "expected ak-expedition-everest in mock AK park data";
      if (everest.waitMins !== 45) return `expected live wait 45, got ${everest.waitMins}`;
      if (everest.waitSource !== "live") return `expected waitSource "live", got ${everest.waitSource}`;
      return null;
    },
  },
];

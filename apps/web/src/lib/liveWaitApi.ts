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
import { PLANNED_CLOSURES, getClosureTiming } from "./plannedClosures";

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

// PLANNED_CLOSURES and getClosureTiming are imported from ./plannedClosures.

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
 * Namespace prefix for all sessionStorage keys.
 * Scoped per-tab; clears automatically when the tab/session closes.
 */
const SS_PREFIX = "dwp:wt:";

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
};

/**
 * Normalize an attraction name for comparison.
 * Queue-Times uses straight punctuation; mock data uses smart/typographic variants.
 * Without this, names like "Tiana's …" vs "Tiana's …" or
 * "Star Tours – …" vs "Star Tours - …" fail to match.
 */
function normalizeAttractionName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\u00a0/g, " ")         // NBSP → space
    .replace(/\s+/g, " ")            // collapse whitespace
    .replace(/[\u2018\u2019]/g, "'") // curly apostrophes → straight
    .replace(/[\u201c\u201d]/g, '"') // curly quotes → straight
    .replace(/[\u2013\u2014]/g, "-") // en-dash / em-dash → hyphen
    .replace(/~/g, "-")             // tilde separator → hyphen (e.g. "~ Ariel's")
    .replace(/\u2122/g, "")        // ™ — e.g. "Indiana Jones™ Adventure"
    .replace(/\u00ae/g, "")        // ®
    .replace(/\u00a9/g, "")        // ©
    ;
}

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
  // Rock 'n' Roller Coaster Starring Aerosmith (Hollywood Studios)
  ["rnr",                                        "rock 'n' roller coaster starring aerosmith"],
  ["rock n roller",                              "rock 'n' roller coaster starring aerosmith"],
  ["rock n roller coaster",                      "rock 'n' roller coaster starring aerosmith"],
  ["rock 'n' roller coaster",                    "rock 'n' roller coaster starring aerosmith"],
  ["rockin roller coaster",                      "rock 'n' roller coaster starring aerosmith"],
  ["aerosmith",                                  "rock 'n' roller coaster starring aerosmith"],
  ["rock n roller coaster starring aerosmith",   "rock 'n' roller coaster starring aerosmith"],
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
  // TriceraTop Spin (Animal Kingdom) — common misspelling with trailing 's'
  ["triceratops spin",                           "triceratop spin"],
]);

/**
 * DLR-only alias map: normalized-alias → canonical-normalized-mock-name.
 * Same contract as ALIASES_WDW — keys and values in normalizeAttractionName() form.
 */
const ALIASES_DLR = new Map<string, string>([
  // The Many Adventures of Winnie the Pooh (Disneyland Park)
  ["winnie the pooh",                            "the many adventures of winnie the pooh"],
  ["pooh",                                       "the many adventures of winnie the pooh"],
  ["many adventures of winnie the pooh",         "the many adventures of winnie the pooh"],
  // "it's a small world" (Disneyland) — mock name has surrounding typographic quotes;
  // Queue-Times omits them. Both sides normalized, value retains the literal " chars.
  ["it's a small world",                         "\"it's a small world\""],
]);

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

  // Build normalized name → live ride lookup.
  // Keys are canonicalized so smart vs straight punctuation variants match.
  const liveByName = new Map<string, QTRide>();
  for (const land of qt.lands) {
    for (const ride of land.rides ?? []) {
      liveByName.set(normalizeAttractionName(ride.name), ride);
    }
  }

  // Alias expansion: if Queue-Times uses a short/alternate name, map it to
  // the canonical mock name so the per-ride lookup below finds the live entry.
  if (resortId === "WDW") {
    for (const [alias, canonical] of ALIASES_WDW) {
      if (!liveByName.has(canonical) && liveByName.has(alias)) {
        liveByName.set(canonical, liveByName.get(alias)!);
      }
    }
  }
  if (resortId === "DLR") {
    for (const [alias, canonical] of ALIASES_DLR) {
      if (!liveByName.has(canonical) && liveByName.has(alias)) {
        liveByName.set(canonical, liveByName.get(alias)!);
      }
    }
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
  //   1. Planned closure (ACTIVE timing) → "CLOSED" (unless sanity override)
  //   2. Planned closure (UPCOMING/ENDED) → fall through to live
  //   3. Live says not open              → "DOWN"   (temporary outage)
  //   4. Live says open                  → "OPERATING" with live wait time
  return mockPark.map((mockRide): AttractionWait => {
    const normName = normalizeAttractionName(mockRide.name);
    const closureKey = `${parkId}:${normName}`;
    const live = liveByName.get(normName);

    if (PLANNED_CLOSURES.has(closureKey)) {
      const entry = PLANNED_CLOSURES.get(closureKey);
      const timing = getClosureTiming(entry?.dateRange, now);

      if (timing === "ACTIVE") {
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
      // UPCOMING or ENDED: fall through to live status below.
    }

    if (!live) return mockRide; // no match: keep mock values unchanged

    // Ride not operating: explicitly clear wait time so no stale/mock minutes leak.
    if (!live.is_open) {
      return {
        ...mockRide,
        status: "DOWN",
        waitMins: null,
        updatedAt: live.last_updated,
      };
    }

    // Ride operating: apply live wait time.
    return {
      ...mockRide,
      status: "OPERATING",
      waitMins: live.wait_time,
      updatedAt: live.last_updated,
    };
  });
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

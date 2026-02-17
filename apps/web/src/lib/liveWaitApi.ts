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

/**
 * Planned closure lookup keyed by `${parkId}:${lowercaseName}`.
 * Manually updated Feb 2026. Must stay in sync with MOCK_REFURBS in page.tsx.
 *
 * Used in live mode only: if a ride's key is here, its status is always
 * "CLOSED" (planned refurbishment) rather than "DOWN" (temporary outage).
 */
// Keys use straight punctuation because they are compared against
// normalizeAttractionName() output, which has already been canonicalized.
const PLANNED_CLOSURE_NAMES = new Set<string>([
  // Disneyland Park
  "disneyland:jungle cruise",
  "disneyland:space mountain",
  // Disney California Adventure
  "dca:grizzly river run",
  "dca:jumpin' jellyfish", // straight apostrophe (normalized form)
  "dca:golden zephyr",
  // Walt Disney World — EPCOT
  "epcot:test track",
]);

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
    ;
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

  // Build normalized name → live ride lookup.
  // Keys are canonicalized so smart vs straight punctuation variants match.
  const liveByName = new Map<string, QTRide>();
  for (const land of qt.lands) {
    for (const ride of land.rides ?? []) {
      liveByName.set(normalizeAttractionName(ride.name), ride);
    }
  }

  // Overlay live values onto mock rides; keep mock where no match exists.
  // Status priority:
  //   1. Planned closure list  → "CLOSED" (refurbishment, always wins)
  //   2. Live says not open    → "DOWN"   (temporary outage)
  //   3. Live says open        → "OPERATING" with live wait time
  return mockPark.map((mockRide): AttractionWait => {
    const normName = normalizeAttractionName(mockRide.name);
    const closureKey = `${parkId}:${normName}`;

    // Planned closure: always CLOSED regardless of live status
    if (PLANNED_CLOSURE_NAMES.has(closureKey)) {
      return { ...mockRide, status: "CLOSED", waitMins: null };
    }

    const live = liveByName.get(normName);
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

  // Return valid cached entry immediately (no fetch)
  const cached = cache.get(key);
  if (cached && now < cached.expiresAt) {
    return {
      data: cached.data,
      dataSource: cached.dataSource,
      lastUpdated: cached.lastUpdated,
    };
  }

  // Deduplicate: return the in-flight Promise if a request is already running
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }

  // Start a new fetch, register as in-flight
  const request = fetchLiveData(resortId, parkId)
    .then((result) => {
      cache.set(key, { ...result, expiresAt: now + CACHE_TTL_MS });
      return result;
    })
    .catch((): WaitDataset => {
      // Any fetch error (network, timeout, non-2xx, parse, no mapping) → mock fallback
      return getMockDataset(resortId, parkId);
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, request);
  return request;
}

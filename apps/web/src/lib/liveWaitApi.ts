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

// ============================================
// CLOSURE DATE RANGE HELPERS
// ============================================

export type ClosureTiming = "ACTIVE" | "UPCOMING" | "ENDED";

/** Returns local YYYY-MM-DD string (uses local clock, not UTC). */
function normalizeToDayKeyLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parses a dateRange string into { startKey, endKey? }.
 * endKey is omitted for open-ended ranges (e.g. "YYYY-MM-DD - TBD").
 *
 * Supported formats:
 *   "YYYY-MM-DD - YYYY-MM-DD"  → bounded range { startKey, endKey }
 *   "YYYY-MM-DD - TBD"         → open-ended    { startKey }
 *
 * Returns null if no parseable ISO date is found (conservative).
 */
function parseClosureDateRange(
  dateRange: string,
): { startKey: string; endKey?: string } | null {
  const dates = dateRange.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  if (dates.length >= 2) {
    const a = dates[0] as string;
    const b = dates[1] as string;
    return { startKey: a <= b ? a : b, endKey: a <= b ? b : a };
  }
  if (dates.length === 1 && /tbd/i.test(dateRange)) {
    // Open-ended: start is known, end is TBD
    return { startKey: dates[0] as string };
  }
  return null; // no parseable date — conservative
}

/**
 * Returns when a planned closure applies relative to `now`.
 *
 * - undefined dateRange     → "ACTIVE" (conservative: always force-closed)
 * - Unparseable             → "ACTIVE" (conservative: preserve prior behavior)
 * - today < start           → "UPCOMING" (closure has not started — do NOT override)
 * - endKey set, today > end → "ENDED"   (closure is over — do NOT override)
 * - otherwise               → "ACTIVE"  (includes open-ended on/after start)
 */
export function getClosureTiming(
  dateRange: string | undefined,
  now: Date,
): ClosureTiming {
  if (!dateRange) return "ACTIVE";
  const range = parseClosureDateRange(dateRange);
  if (!range) return "ACTIVE";
  const todayKey = normalizeToDayKeyLocal(now);
  if (todayKey < range.startKey) return "UPCOMING";
  if (range.endKey !== undefined && todayKey > range.endKey) return "ENDED";
  return "ACTIVE";
}

// Dev-only sanity checks (stripped in production builds)
if (process.env.NODE_ENV !== "production") {
  const _t = new Date("2026-02-17T12:00:00");
  // Bounded range
  console.debug("[closureTiming] ACTIVE  :", getClosureTiming("2026-02-16 - 2026-02-20", _t)); // => ACTIVE
  console.debug("[closureTiming] UPCOMING:", getClosureTiming("2026-02-18 - 2026-02-20", _t)); // => UPCOMING
  console.debug("[closureTiming] ENDED   :", getClosureTiming("2026-02-10 - 2026-02-12", _t)); // => ENDED
  // Open-ended (TBD)
  console.debug("[closureTiming] TBD/UPC :", getClosureTiming("2026-02-23 - TBD", _t));        // => UPCOMING (start in future)
  console.debug("[closureTiming] TBD/ACT :", getClosureTiming("2026-02-01 - TBD", _t));        // => ACTIVE   (past start, no end)
}

/**
 * Planned closure lookup keyed by `${parkId}:${lowercaseName}`.
 * Value = dateRange string or undefined.
 *   - undefined              → always CLOSED (conservative, no date enforcement)
 *   - "YYYY-MM-DD - YYYY-MM-DD" → CLOSED only within bounded range
 *   - "YYYY-MM-DD - TBD"    → CLOSED from start date onwards (open-ended)
 *
 * Keys use straight punctuation (normalizeAttractionName output).
 * Manually updated Feb 2026. Must stay in sync with MOCK_REFURBS in page.tsx.
 */
const PLANNED_CLOSURES = new Map<string, string | undefined>([
  // Disneyland Park
  ["disneyland:jungle cruise", undefined],
  ["disneyland:space mountain", "2026-02-23 - 2026-02-26"],
  // Disney California Adventure
  ["dca:grizzly river run", undefined],
  ["dca:jumpin' jellyfish", undefined], // straight apostrophe (normalized form)
  ["dca:golden zephyr", undefined],
  // Walt Disney World — Magic Kingdom
  ["mk:big thunder mountain railroad", "2025-01-01 - 2026-05-01"],
  ["mk:buzz lightyear's space ranger spin", "2025-08-04 - 2026-05-01"],
  // Walt Disney World — Hollywood Studios
  ["hs:rock 'n' roller coaster starring aerosmith", "2026-03-02 - 2026-07-15"],
  // Walt Disney World — Animal Kingdom
  ["ak:dinosaur", "2026-02-02 - TBD"],
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

  // WDW alias expansion: if Queue-Times uses a short/alternate name, map it to
  // the canonical mock name so the per-ride lookup below finds the live entry.
  if (resortId === "WDW") {
    for (const [alias, canonical] of ALIASES_WDW) {
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
  //   1. Planned closure (ACTIVE timing) → "CLOSED" (refurbishment, always wins)
  //   2. Planned closure (UPCOMING/ENDED) → fall through to live status
  //   3. Live says not open              → "DOWN"   (temporary outage)
  //   4. Live says open                  → "OPERATING" with live wait time
  return mockPark.map((mockRide): AttractionWait => {
    const normName = normalizeAttractionName(mockRide.name);
    const closureKey = `${parkId}:${normName}`;

    if (PLANNED_CLOSURES.has(closureKey)) {
      const timing = getClosureTiming(PLANNED_CLOSURES.get(closureKey), now);
      if (timing === "ACTIVE") {
        // Closure is in effect: force CLOSED regardless of live status.
        return { ...mockRide, status: "CLOSED", waitMins: null };
      }
      // UPCOMING or ENDED: do not suppress live wait time — fall through.
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

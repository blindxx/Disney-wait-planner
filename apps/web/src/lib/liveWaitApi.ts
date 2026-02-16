/**
 * liveWaitApi.ts — Live Wait Times API Foundation
 *
 * Single entry point: getWaitDataset({ resortId, parkId })
 * Returns normalized AttractionWait[] with metadata about the data source.
 *
 * Config (env vars):
 *   NEXT_PUBLIC_WAIT_API_ENABLED   "true" | "false"  (default: false)
 *   NEXT_PUBLIC_WAIT_API_BASE_URL  string (required only if enabled)
 *
 * Behavior:
 *   - Live API disabled or base URL missing  → returns mock data
 *   - Live API enabled + cache valid         → returns cached data
 *   - Live API enabled + cache stale         → fetches, caches 60 s, returns live
 *   - Live fetch fails (any error)           → falls back to mock, never throws
 *   - In-flight deduplication               → one request per key at a time
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
const API_BASE_URL = process.env.NEXT_PUBLIC_WAIT_API_BASE_URL ?? "";

/** Live mode is only active when explicitly enabled AND a base URL is provided. */
const LIVE_ENABLED = API_ENABLED && API_BASE_URL.trim() !== "";

/** Fetch abort timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 8_000;

/** Cache TTL in milliseconds (60 seconds). */
const CACHE_TTL_MS = 60_000;

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
// NORMALIZATION
// ============================================

/**
 * Expected shape of a single attraction from the live API.
 * Centralized here so future API shape changes only require editing this one
 * function — pages and components are fully decoupled from the wire format.
 *
 * Assumed API contract (default mapping):
 *   id           — string  unique attraction identifier
 *   name         — string  display name
 *   wait         — number | null  current wait in minutes
 *   status       — "OPERATING" | "DOWN" | "CLOSED"
 *   land         — string?  themed land (optional)
 *   parkId       — string   e.g. "disneyland"
 *   resortId     — string   e.g. "DLR"
 *   themeParksId — string?  (optional, falls back to id)
 *   updatedAt    — string?  ISO timestamp (optional)
 */
type ApiAttractionRaw = Record<string, unknown>;

function normalizeStatus(raw: unknown): WaitStatus {
  if (raw === "OPERATING" || raw === "DOWN" || raw === "CLOSED") return raw;
  return "OPERATING";
}

function normalizeAttraction(
  raw: ApiAttractionRaw,
  fallbackResortId: ResortId,
  fallbackParkId: ParkId,
): AttractionWait {
  const id = String(raw.id ?? "");
  const status = normalizeStatus(raw.status);
  return {
    id,
    themeParksId: String(raw.themeParksId ?? raw.id ?? ""),
    name: String(raw.name ?? "Unknown"),
    land: raw.land != null ? String(raw.land) : undefined,
    resortId: (raw.resortId as ResortId) ?? fallbackResortId,
    parkId: (raw.parkId as ParkId) ?? fallbackParkId,
    status,
    waitMins:
      status === "OPERATING" && raw.wait != null ? Number(raw.wait) : null,
    updatedAt:
      raw.updatedAt != null ? String(raw.updatedAt) : new Date().toISOString(),
  };
}

/**
 * Normalize an unknown API response body into AttractionWait[].
 *
 * Supports three common shapes:
 *   - Flat array:             [ { id, name, wait, ... }, ... ]
 *   - Wrapped attractions:    { attractions: [ ... ] }
 *   - Wrapped data:           { data: [ ... ] }
 */
function normalizeResponse(
  body: unknown,
  resortId: ResortId,
  parkId: ParkId,
): AttractionWait[] {
  let items: unknown[];

  if (Array.isArray(body)) {
    items = body;
  } else if (body !== null && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.attractions)) {
      items = obj.attractions;
    } else if (Array.isArray(obj.data)) {
      items = obj.data;
    } else {
      return [];
    }
  } else {
    return [];
  }

  return items
    .filter(
      (item): item is ApiAttractionRaw =>
        item !== null && typeof item === "object",
    )
    .map((item) => normalizeAttraction(item, resortId, parkId));
}

// ============================================
// FETCH HELPER
// ============================================

async function fetchLiveData(
  resortId: ResortId,
  parkId: ParkId,
): Promise<WaitDataset> {
  const url = `${API_BASE_URL}/waits?resortId=${encodeURIComponent(resortId)}&parkId=${encodeURIComponent(parkId)}`;
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

    const data = normalizeResponse(body, resortId, parkId);
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
 * - Cache valid           → returns cached data immediately (no fetch)
 * - Cache stale           → fetches live data; on success caches + returns live
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
  // Short-circuit: live API disabled or no base URL configured
  if (!LIVE_ENABLED) {
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
      // Any fetch error (network, timeout, non-2xx, parse) → mock fallback
      return getMockDataset(resortId, parkId);
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, request);
  return request;
}

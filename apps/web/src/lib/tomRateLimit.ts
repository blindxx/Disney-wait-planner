/**
 * Minimal in-memory rate limiter for POST /api/tom/ask.
 *
 * Fixed-window counter keyed by client IP (+ session_id when provided).
 * Intentionally process-local: no Redis/DB/external service. On serverless
 * platforms with multiple instances this limits per-instance, not globally,
 * which is an accepted tradeoff for "basic abuse protection" at this phase.
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 10;

interface WindowEntry {
  count: number;
  windowStart: number;
}

const hits = new Map<string, WindowEntry>();

// Bound memory growth: opportunistically drop stale entries.
function pruneExpired(now: number) {
  for (const [key, entry] of hits) {
    if (now - entry.windowStart >= WINDOW_MS) {
      hits.delete(key);
    }
  }
}

export function buildRateLimitKey(ip: string, sessionId?: string): string {
  return sessionId ? `${ip}:${sessionId}` : ip;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

export function checkRateLimit(key: string): RateLimitResult {
  const now = Date.now();

  if (hits.size > 5000) {
    pruneExpired(now);
  }

  const entry = hits.get(key);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    hits.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - 1 };
  }

  if (entry.count >= MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, remaining: 0 };
  }

  entry.count += 1;
  return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - entry.count };
}

export function getClientIp(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  const cfConnectingIp = headers.get("cf-connecting-ip");
  if (cfConnectingIp) return cfConnectingIp.trim();

  return "unknown";
}

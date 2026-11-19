// Phase 14.5E-B1 — pure logic for the lifecycle audit snapshot bridge (no I/O).
// Used by lifecycle-audit-snapshot.mjs (GitHub Actions) and the DEV cases.
//
// Contract: validate the protected /api/catalog/lifecycle-audit response, sanitize
// it for a PUBLIC repository, and merge it additively into the previous snapshot.
// Nothing here ever drops a previously retained event.

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_RETAINED_EVENTS = 5000;
export const MAX_RESPONSE_SKEW_MS = 10 * 60_000;
export const STALE_AFTER_HOURS = 48;

const PARK_ID = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_TYPE = /^[a-z_]{3,48}$/;
const SENSITIVE_KEY = /(key|token|secret|password|passwd|authorization|cookie|credential|url|uri|href|header|email)/i;
const MAX_STRING = 240;
const MAX_ITEMS = 60;
const MAX_KEYS = 40;
const MAX_DEPTH = 3;

export class SnapshotError extends Error {}
const fail = (msg) => { throw new SnapshotError(msg); };

/** Token-shaped substrings (anywhere in a sentence): known credential prefixes and long unbroken key-like runs. */
const TOKEN_PREFIXED = /\b(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-|AKIA|AIza)[A-Za-z0-9_-]{8,}/g;
const TOKEN_RUN = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
const URL_WITH_SECRETISH = /https?:\/\/\S*[?#@]\S*/gi;
const AUTH_SCHEME = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Redacts credential-/URL-shaped substrings wherever they occur; keeps short human-readable evidence. */
function cleanString(s) {
  const r = s.replace(URL_WITH_SECRETISH, "[redacted]").replace(AUTH_SCHEME, "[redacted]").replace(TOKEN_PREFIXED, "[redacted]").replace(TOKEN_RUN, "[redacted]");
  return r.length > MAX_STRING ? `${r.slice(0, MAX_STRING)}…` : r;
}

/** Whitelist-by-shape sanitizer: JSON scalars, bounded arrays/objects, no sensitive-looking keys. */
export function sanitizeEvidence(value, depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return cleanString(value);
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => sanitizeEvidence(v, depth + 1)).filter((v) => v !== undefined);
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).slice(0, MAX_KEYS)) {
      if (SENSITIVE_KEY.test(k)) continue;
      const v = sanitizeEvidence(value[k], depth + 1);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return undefined;
}

const str = (v, what) => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : fail(`invalid ${what}`));
const parkId = (v) => (typeof v === "string" && PARK_ID.test(v) ? v : fail("invalid parkId"));
const dateOrNull = (v) => (v == null ? null : typeof v === "string" && DATE.test(v) ? v : fail("invalid date"));
const isoOrNull = (v) => (v == null ? null : typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : fail("invalid timestamp"));
const nonNegInt = (v, what) => (Number.isInteger(v) && v >= 0 ? v : fail(`invalid ${what}`));

/** Stable, park-qualified, deterministic id. Mirrors the table's natural key (park, show, type, local date). */
export function eventId(e) {
  return `${e.parkId}:${e.eventType}:${e.localDate}:${e.showName.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/**
 * Validates an API response (status already checked) and returns sanitized data.
 * Any structural problem throws — a malformed/empty/error body is never publishable.
 */
export function parseAuditResponse(body, nowMs = Date.now()) {
  if (!body || typeof body !== "object") fail("response is not a JSON object");
  const m = body.meta;
  if (!m || m.ok !== true) fail("response meta.ok is not true");
  for (const k of ["hidden", "legacyComebacks", "flagged", "unreviewedEvents"]) if (!Array.isArray(body[k])) fail(`response.${k} is not an array`);
  const gen = typeof m.generatedAt === "string" ? Date.parse(m.generatedAt) : NaN;
  if (Number.isNaN(gen)) fail("response lacks meta.generatedAt (API not deployed with the 14.5E-B1 completeness metadata?)");
  if (Math.abs(nowMs - gen) > MAX_RESPONSE_SKEW_MS) fail("response generatedAt is not current (cached or clock-skewed response)");
  const completeness = {
    eventLimit: nonNegInt(m.eventLimit, "meta.eventLimit"),
    eventsReturned: nonNegInt(m.eventsReturned, "meta.eventsReturned"),
    unreviewedTotal: nonNegInt(m.unreviewedTotal, "meta.unreviewedTotal"),
    eventsTruncated: typeof m.eventsTruncated === "boolean" ? m.eventsTruncated : fail("invalid meta.eventsTruncated"),
  };
  if (completeness.eventsReturned !== body.unreviewedEvents.length) fail("meta.eventsReturned does not match the events array");
  if (!completeness.eventsTruncated && completeness.unreviewedTotal > completeness.eventsReturned) fail("inconsistent truncation metadata");

  const events = body.unreviewedEvents.map((e) => {
    const ev = { parkId: parkId(e.parkId), showName: str(e.showName, "showName"), eventType: EVENT_TYPE.test(e.eventType) ? e.eventType : fail("invalid eventType"), localDate: dateOrNull(e.localDate) ?? fail("missing localDate"), occurredAt: isoOrNull(e.occurredAt) ?? fail("missing occurredAt") };
    return { eventId: eventId(ev), ...ev, evidenceSummary: sanitizeEvidence(e.evidence) ?? {}, coverageLimitations: (Array.isArray(e.coverageLimitations) ? e.coverageLimitations : []).filter((x) => typeof x === "string").slice(0, MAX_ITEMS).map(cleanString) };
  });
  if (new Set(events.map((e) => e.eventId)).size !== events.length) fail("duplicate event identities in response");

  return {
    generatedAt: m.generatedAt,
    completeness,
    hidden: body.hidden.map((r) => ({ parkId: parkId(r.parkId), showName: str(r.showName, "showName"), hiddenLocalDate: dateOrNull(r.hiddenLocalDate), hiddenAt: isoOrNull(r.hiddenAt), hideCount: nonNegInt(r.hideCount, "hideCount"), restoreCount: nonNegInt(r.restoreCount, "restoreCount"), auditFlag: r.auditFlag == null ? null : cleanString(String(r.auditFlag)) })),
    legacyComebacks: body.legacyComebacks.map((r) => ({ parkId: parkId(r.parkId), showName: str(r.showName, "showName"), restoredAt: isoOrNull(r.restoredAt), comebackCount: nonNegInt(r.comebackCount, "comebackCount"), rehideCount: nonNegInt(r.rehideCount, "rehideCount"), lastActiveDate: dateOrNull(r.lastActiveDate) })),
    flagged: body.flagged.map((r) => ({ parkId: parkId(r.parkId), showName: str(r.showName, "showName"), auditFlag: cleanString(String(r.auditFlag)), silentDays: nonNegInt(r.silentDays, "silentDays"), inactiveDays: nonNegInt(r.inactiveDays, "inactiveDays"), status: cleanString(String(r.status)), silenceFlaggedAt: isoOrNull(r.silenceFlaggedAt) })),
    events,
  };
}

/** Validates a previously written snapshot (null = none yet). Throws on corruption so it is never silently replaced. */
export function parsePreviousSnapshot(json) {
  if (json == null) return null;
  if (typeof json !== "object" || json.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || !Array.isArray(json.events)) fail("existing snapshot is unreadable or has an unknown schemaVersion; refusing to overwrite");
  for (const e of json.events) if (!e || typeof e.eventId !== "string" || typeof e.firstSeenAt !== "string") fail("existing snapshot has malformed events; refusing to overwrite");
  return json;
}

/**
 * Additive merge. Current-state lists replace the previous ones (they ARE the current state);
 * events are keyed by eventId: new → added, known → refreshed with `lastSeenAt`, absent from this fetch → retained
 * (`inLatestFetch: false`), never deleted. A genuine new episode has a new localDate, hence a new eventId.
 */
export function buildSnapshot(prev, parsed, fetchedAtIso) {
  const byId = new Map((prev?.events ?? []).map((e) => [e.eventId, e]));
  const seen = new Set();
  for (const e of parsed.events) {
    seen.add(e.eventId);
    const old = byId.get(e.eventId);
    byId.set(e.eventId, { ...e, firstSeenAt: old?.firstSeenAt ?? fetchedAtIso, lastSeenAt: fetchedAtIso, inLatestFetch: true });
  }
  const events = [...byId.values()].map((e) => (seen.has(e.eventId) ? e : { ...e, inLatestFetch: false }))
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : a.eventId < b.eventId ? -1 : 1));
  if (events.length > MAX_RETAINED_EVENTS) fail(`retained events exceed ${MAX_RETAINED_EVENTS}; needs a reviewed retention decision`);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    note: "Read-only sanitized export of /api/catalog/lifecycle-audit for the monthly Data Audit. Findings only: never a catalog, tracker or visibility decision. Reconcile via a reviewed PR against dataAuditTracker.json / entertainmentLifecycleRegistry.json.",
    generatedAt: parsed.generatedAt,
    fetchedAt: fetchedAtIso,
    staleAfterHours: STALE_AFTER_HOURS,
    completeness: { ...parsed.completeness, complete: !parsed.completeness.eventsTruncated, retainedEvents: events.length, eventsInLatestFetch: parsed.events.length },
    hidden: parsed.hidden,
    legacyComebacks: parsed.legacyComebacks,
    flagged: parsed.flagged,
    events,
  };
}

/**
 * Last-line guard: neither the raw key nor its JSON-escaped form may appear anywhere in the snapshot, and no
 * individual string value (or object key) may contain it. No minimum length: a short key fails closed too.
 */
export function assertNoSecret(snapshot, secret) {
  if (!secret) fail("no API key available for the leak check");
  const serialized = JSON.stringify(snapshot);
  if (serialized.includes(secret) || serialized.includes(JSON.stringify(secret).slice(1, -1))) fail("snapshot contains the API key; aborting");
  const walk = (v) => {
    if (typeof v === "string") { if (v.includes(secret)) fail("snapshot contains the API key; aborting"); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { walk(k); walk(x); }
  };
  walk(snapshot);
}

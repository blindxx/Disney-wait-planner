// Phase 14.5E-B1 DEV checks (run manually; no test framework):
//   node apps/web/scripts/lifecycle-audit-snapshot.dev-cases.mjs   -> prints failing labels, exits 1 on any failure
import { SnapshotError, assertNoSecret, buildSnapshot, eventId, parseAuditResponse, parsePreviousSnapshot, sanitizeEvidence } from "./lifecycle-audit-snapshot.lib.mjs";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const ev = (o = {}) => ({ parkId: "disneyland", showName: "Paint the Night", eventType: "auto_hide", localDate: "2026-11-10", occurredAt: "2026-11-11T06:10:00.000Z", evidence: { inactiveDays: 21, bases: ["x"] }, coverageLimitations: ["provider evidence only"], ...o });
const body = (events = [ev()], meta = {}) => ({
  hidden: [], legacyComebacks: [], flagged: [], unreviewedEvents: events,
  meta: { ok: true, generatedAt: "2026-11-19T11:59:00.000Z", eventLimit: 1000, eventsReturned: events.length, unreviewedTotal: events.length, eventsTruncated: false, ...meta },
});
const throws = (fn) => { try { fn(); return false; } catch (e) { return e instanceof SnapshotError; } };

export function runDevLifecycleAuditSnapshotCases() {
  const failures = [];
  const check = (label, ok) => { if (!ok) failures.push(label); };

  const p = parseAuditResponse(body(), NOW);
  check("valid response parses with stable park-qualified event id", p.events[0].eventId === "disneyland:auto_hide:2026-11-10:paint-the-night" && p.events[0].eventId === eventId(p.events[0]));
  check("meta.ok false rejected", throws(() => parseAuditResponse({ ...body(), meta: { ok: false } }, NOW)));
  check("error body rejected", throws(() => parseAuditResponse({ error: "Unauthorized", meta: { ok: false } }, NOW)));
  check("missing arrays rejected (never an empty publish)", throws(() => parseAuditResponse({ meta: body().meta }, NOW)));
  check("old API without completeness metadata rejected", throws(() => { const b = body(); delete b.meta.generatedAt; parseAuditResponse(b, NOW); }));
  check("stale/cached response rejected", throws(() => parseAuditResponse(body([ev()], { generatedAt: "2026-11-17T00:00:00.000Z" }), NOW)));
  check("eventsReturned mismatch rejected", throws(() => parseAuditResponse(body([ev()], { eventsReturned: 5 }), NOW)));
  check("inconsistent truncation flag rejected", throws(() => parseAuditResponse(body([ev()], { unreviewedTotal: 9, eventsTruncated: false }), NOW)));
  check("duplicate event identities rejected", throws(() => parseAuditResponse(body([ev(), ev()]), NOW)));
  check("bad parkId / eventType / date rejected", throws(() => parseAuditResponse(body([ev({ parkId: "../x" })]), NOW)) && throws(() => parseAuditResponse(body([ev({ eventType: "Bad Type!" })]), NOW)) && throws(() => parseAuditResponse(body([ev({ localDate: "11/10" })]), NOW)));

  const tr = parseAuditResponse(body([ev()], { unreviewedTotal: 1500, eventsTruncated: true }), NOW);
  check("truncation is surfaced as complete=false", buildSnapshot(null, tr, "2026-11-19T12:00:00Z").completeness.complete === false);

  const s = sanitizeEvidence({ ok: 1, apiKey: "abc", nested: { token: "t", fine: "v", deep: { a: { b: { c: 1 } } } }, link: "https://x.test/p?token=abc", url: "https://x.test", long: "A".repeat(300), blob: "QWxhZGRpbjpvcGVuIHNlc2FtZVF1aWNrQnJvd25Gb3hKdW1wc092ZXI", arr: Array(200).fill(1), n: NaN });
  check("sanitizer drops sensitive keys, redacts URLs/tokens, bounds size/depth", !("apiKey" in s) && !("url" in s) && !("token" in s.nested) && s.nested.fine === "v" && s.link === "[redacted]" && s.blob === "[redacted]" && s.long.length <= 241 && s.arr.length === 60 && s.n === null && !("deep" in s.nested && JSON.stringify(s.nested.deep).includes('"c"')));
  check("sanitizer keeps ordinary dates/counts/provider identifiers", JSON.stringify(sanitizeEvidence({ activeDates: ["2026-11-01"], entityId: "a1b2c3d4-0000-4000-8000-000000000001", n: 3 })).includes("a1b2c3d4"));

  // merge: additive, dedupe, new episode, retention
  const t1 = "2026-11-19T12:00:00Z", t2 = "2026-11-20T12:00:00Z";
  const s1 = buildSnapshot(null, parseAuditResponse(body([ev(), ev({ eventType: "silence_flag", localDate: "2026-11-05" })]), NOW), t1);
  const again = buildSnapshot(s1, parseAuditResponse(body([ev(), ev({ eventType: "silence_flag", localDate: "2026-11-05" })]), NOW), t2);
  check("repeat observation is deduplicated, firstSeenAt kept, lastSeenAt refreshed", again.events.length === 2 && again.events.every((e) => e.firstSeenAt === t1 && e.lastSeenAt === t2));
  const newEpisode = buildSnapshot(again, parseAuditResponse(body([ev({ localDate: "2027-02-01", occurredAt: "2027-02-02T06:00:00.000Z" })]), NOW), t2);
  check("same show/type on a new date is a distinct new episode (never merged away)", newEpisode.events.filter((e) => e.eventType === "auto_hide").length === 2);
  check("events absent from a later fetch are retained and marked inLatestFetch=false", newEpisode.events.length === 3 && newEpisode.events.find((e) => e.eventType === "silence_flag").inLatestFetch === false);
  const empty = buildSnapshot(again, parseAuditResponse(body([]), NOW), t2);
  check("an empty (valid) fetch never erases retained history", empty.events.length === 2 && empty.completeness.eventsInLatestFetch === 0);
  check("complete flag true for untruncated fetch", again.completeness.complete === true && again.completeness.retainedEvents === 2);

  check("corrupt/unknown previous snapshot refuses overwrite", throws(() => parsePreviousSnapshot({ schemaVersion: 99, events: [] })) && throws(() => parsePreviousSnapshot({ schemaVersion: 1, events: [{}] })) && parsePreviousSnapshot(null) === null);
  check("secret guard aborts when key appears in output", throws(() => assertNoSecret('{"x":"supersecretvalue"}', "supersecretvalue")) && !throws(() => assertNoSecret("{}", "supersecretvalue")));
  return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = runDevLifecycleAuditSnapshotCases();
  console.log(f.length ? `FAILED:\n- ${f.join("\n- ")}` : "all lifecycle audit snapshot DEV cases passed");
  process.exit(f.length ? 1 : 0);
}

#!/usr/bin/env node
// Phase 14.5E-B1 — read-only lifecycle audit snapshot bridge (runs in GitHub Actions).
//
// Reads the key-protected GET /api/catalog/lifecycle-audit and writes a sanitized,
// additive snapshot JSON. Env: DWP_AUDIT_BASE_URL (https origin), DWP_LIFECYCLE_AUDIT_API_KEY
// (dedicated GitHub Actions secret). Args: --out <file>. The existing --out file (if any) is the previous snapshot.
//
// Exit codes: 0 written & complete | 2 written but INCOMPLETE (events truncated; still merged additively)
// | 1 failure — nothing is written, any existing snapshot file is left untouched.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { SnapshotError, assertNoSecret, buildSnapshot, parseAuditResponse, parsePreviousSnapshot } from "./lifecycle-audit-snapshot.lib.mjs";

const LIMIT = 1000; // API ceiling (LIFECYCLE_AUDIT_MAX_LIMIT)
const TIMEOUT_MS = 30_000;

async function main() {
  const out = process.argv[process.argv.indexOf("--out") + 1];
  if (!out || process.argv.indexOf("--out") < 0) throw new SnapshotError("usage: --out <file>");
  const base = process.env.DWP_AUDIT_BASE_URL;
  const key = process.env.DWP_LIFECYCLE_AUDIT_API_KEY;
  if (!base || !key?.trim()) throw new SnapshotError("DWP_AUDIT_BASE_URL and DWP_LIFECYCLE_AUDIT_API_KEY must be set");
  let url;
  try { url = new URL("/api/catalog/lifecycle-audit", base); } catch { throw new SnapshotError("DWP_AUDIT_BASE_URL is not a valid URL"); }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && process.env.DWP_AUDIT_ALLOW_HTTP === "1")) throw new SnapshotError("DWP_AUDIT_BASE_URL must be https");
  url.searchParams.set("limit", String(LIMIT));

  let prev = null;
  if (existsSync(out)) {
    try { prev = parsePreviousSnapshot(JSON.parse(readFileSync(out, "utf8"))); } catch (e) { throw e instanceof SnapshotError ? e : new SnapshotError("existing snapshot is not valid JSON; refusing to overwrite"); }
  }

  const res = await fetch(url, { headers: { "x-dwp-catalog-api-key": key, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status !== 200) throw new SnapshotError(`API responded HTTP ${res.status}`); // body deliberately not echoed
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) throw new SnapshotError("API response is not JSON");
  let body;
  try { body = await res.json(); } catch { throw new SnapshotError("API response is not valid JSON"); }

  const parsed = parseAuditResponse(body);
  const snapshot = buildSnapshot(prev, parsed, new Date().toISOString());
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  assertNoSecret(snapshot, key);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.tmp`, serialized);
  renameSync(`${out}.tmp`, out); // atomic: a partial write can never replace a good snapshot
  const c = snapshot.completeness;
  console.log(`snapshot written: ${c.eventsInLatestFetch} events fetched, ${c.retainedEvents} retained, ${snapshot.hidden.length} hidden, ${snapshot.flagged.length} flagged, ${snapshot.legacyComebacks.length} legacy comebacks`);
  if (!c.complete) {
    console.error(`INCOMPLETE: API returned ${c.eventsReturned} of ${c.unreviewedTotal} unreviewed events (limit ${c.eventLimit}). Snapshot marked complete=false.`);
    return 2;
  }
  return 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(`FATAL: ${e instanceof SnapshotError ? e.message : `unexpected ${e?.name ?? "error"}`}`); // never print raw errors (could embed request details)
  process.exit(1);
});

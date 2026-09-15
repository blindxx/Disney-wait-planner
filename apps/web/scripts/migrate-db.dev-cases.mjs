#!/usr/bin/env node
// ============================================================
// SH.2.7 — dev-only validation cases for migrate-db.mjs's exact DEFAULT
// verification and JS-safe revision bound.
//
// This repo has no test runner (see AGENTS.md) — validation logic
// follows the existing DEV_*_CASES convention (see plansMatching.ts,
// plannedClosures.ts): a plain array of cases, run manually from Node.
//
// Usage:
//   node apps/web/scripts/migrate-db.dev-cases.mjs
//
// Exits non-zero if any case fails.
// ============================================================

import { parseDefaultLiteral, defaultMatchesExpected, JS_MAX_SAFE_REVISION } from "./migrate-db.mjs";

// Each case: an actual `information_schema.columns.column_default` string
// (or null), the `expectedDefault` contract entry it's checked against,
// and whether that match should succeed.
export const DEV_DEFAULT_MATCH_CASES = [
  // Exact required DEFAULT accepted.
  { actual: "0", expected: { kind: "numeric", value: 0n }, expectMatch: true },
  { actual: "'accepted'::text", expected: { kind: "text", value: "accepted" }, expectMatch: true },

  // Equivalent Postgres cast/format of the same value accepted.
  { actual: "'0'::bigint", expected: { kind: "numeric", value: 0n }, expectMatch: true },
  { actual: "(0)::bigint", expected: { kind: "numeric", value: 0n }, expectMatch: true },
  { actual: "'accepted'::character varying", expected: { kind: "text", value: "accepted" }, expectMatch: true },
  { actual: "('accepted')::text", expected: { kind: "text", value: "accepted" }, expectMatch: true },

  // Substring lookalikes rejected — the bug this replaces.
  { actual: "'unaccepted'::text", expected: { kind: "text", value: "accepted" }, expectMatch: false },
  { actual: "'accepted2'::text", expected: { kind: "text", value: "accepted" }, expectMatch: false },

  // Incompatible numeric defaults rejected.
  { actual: "10", expected: { kind: "numeric", value: 0n }, expectMatch: false },
  { actual: "'100'::bigint", expected: { kind: "numeric", value: 0n }, expectMatch: false },

  // No default at all never matches a required value.
  { actual: null, expected: { kind: "numeric", value: 0n }, expectMatch: false },
  { actual: null, expected: { kind: "text", value: "accepted" }, expectMatch: false },

  // A non-constant default (e.g. NOW()) is never treated as satisfying an
  // exact-value contract — only `hasDefault` (existence) covers those.
  { actual: "now()", expected: { kind: "numeric", value: 0n }, expectMatch: false },
];

export const DEV_PARSE_LITERAL_CASES = [
  { raw: "0", expectedKind: "numeric", expectedValue: 0n },
  { raw: "10", expectedKind: "numeric", expectedValue: 10n },
  { raw: "'0'::bigint", expectedKind: "numeric", expectedValue: 0n },
  { raw: "(0)::bigint", expectedKind: "numeric", expectedValue: 0n },
  { raw: "'accepted'::text", expectedKind: "text", expectedValue: "accepted" },
  { raw: "'accepted'::character varying", expectedKind: "text", expectedValue: "accepted" },
  { raw: "''::text", expectedKind: "text", expectedValue: "" },
  { raw: "'it''s'::text", expectedKind: "text", expectedValue: "it's" },
  { raw: "now()", expectedKind: "unknown", expectedValue: "now()" },
];

function describeExpected(expected) {
  return `{ kind: "${expected.kind}", value: ${JSON.stringify(String(expected.value))} }`;
}

function runDefaultMatchCases() {
  let failures = 0;
  for (const c of DEV_DEFAULT_MATCH_CASES) {
    const got = defaultMatchesExpected(c.actual, c.expected);
    const ok = got === c.expectMatch;
    if (!ok) failures++;
    console.log(
      `${ok ? "✓" : "✗ FAIL"} defaultMatchesExpected(${JSON.stringify(c.actual)}, ` +
        `${describeExpected(c.expected)}) => ${got} (expected ${c.expectMatch})`
    );
  }
  return failures;
}

function runParseLiteralCases() {
  let failures = 0;
  for (const c of DEV_PARSE_LITERAL_CASES) {
    const got = parseDefaultLiteral(c.raw);
    const ok = got.kind === c.expectedKind && got.value === c.expectedValue;
    if (!ok) failures++;
    console.log(
      `${ok ? "✓" : "✗ FAIL"} parseDefaultLiteral(${JSON.stringify(c.raw)}) => ` +
        `${JSON.stringify({ kind: got.kind, value: String(got.value) })}`
    );
  }
  return failures;
}

function runJsSafeRevisionCases() {
  let failures = 0;
  const cases = [
    { value: 0n, expectSafe: true },
    { value: JS_MAX_SAFE_REVISION, expectSafe: true },
    { value: JS_MAX_SAFE_REVISION + 1n, expectSafe: false },
    { value: JS_MAX_SAFE_REVISION * 1000n, expectSafe: false },
  ];
  for (const c of cases) {
    const isSafe = c.value <= JS_MAX_SAFE_REVISION;
    const ok = isSafe === c.expectSafe;
    if (!ok) failures++;
    console.log(`${ok ? "✓" : "✗ FAIL"} ${c.value} <= MAX_SAFE_REVISION => ${isSafe}`);
  }
  return failures;
}

const totalFailures = runParseLiteralCases() + runDefaultMatchCases() + runJsSafeRevisionCases();
if (totalFailures > 0) {
  console.error(`\n${totalFailures} case(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll cases passed.");
}

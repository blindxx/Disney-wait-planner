// Shared PostgreSQL connection-string normalization (runtime pools in db.ts
// and scripts/migrate-db.mjs). Plain ESM so Node scripts and Next both import
// the same single implementation.
//
// WHY: pg-connection-string (2.x, used by pg 8.x) currently treats
// sslmode=prefer|require|verify-ca as aliases for verify-full (full
// certificate + hostname verification) and emits a SECURITY WARNING that a
// future major version will switch to libpq semantics (require = encrypt only,
// NO certificate verification). Writing sslmode=verify-full explicitly keeps
// today's strict behavior on every pg version and silences the warning.
//
// SCOPE (deliberately minimal):
//  - Only an exact `sslmode=require` is rewritten, to `verify-full`.
//  - Everything else is returned byte-for-byte unchanged: other sslmodes,
//    missing sslmode, channel_binding, credentials (percent-encoding kept),
//    host, port, db name, all other parameters and their order.
//  - `uselibpqcompat=true` opts into libpq semantics on purpose; left alone.
//  - Never disables verification. Never logs/throws with the URL: an
//    unparseable value is returned unchanged for pg to handle as before.

/**
 * @param {string} connectionString
 * @returns {string}
 */
export function normalizeDatabaseUrl(connectionString) {
  if (typeof connectionString !== "string" || connectionString === "") return connectionString;

  let url;
  try {
    url = new URL(connectionString);
  } catch {
    return connectionString; // not a URL (e.g. key=value form): pass through untouched
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return connectionString;
  if (!url.search) return connectionString;

  const decode = (s) => {
    try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; }
  };
  const pairs = url.search.slice(1).split("&");
  const keyOf = (p) => decode(p.split("=", 1)[0]);
  const valueOf = (p) => (p.includes("=") ? decode(p.slice(p.indexOf("=") + 1)) : "");

  if (pairs.some((p) => keyOf(p) === "uselibpqcompat" && valueOf(p) === "true")) {
    return connectionString;
  }

  let changed = false;
  const next = pairs.map((p) => {
    if (keyOf(p) === "sslmode" && valueOf(p) === "require") {
      changed = true;
      return "sslmode=verify-full";
    }
    return p;
  });
  if (!changed) return connectionString;

  url.search = next.join("&");
  return url.toString();
}

// ---------------------------------------------------------------------------
// DEV checks (run manually from Node; return failing labels):
//   node -e 'import("./src/lib/dbConnectionString.mjs").then(async m=>console.log(await m.runDevDbConnectionStringCases()))'
// ---------------------------------------------------------------------------
export async function runDevDbConnectionStringCases() {
  const failures = [];
  const check = (label, ok) => { if (!ok) failures.push(label); };
  const n = normalizeDatabaseUrl;
  const base = "postgresql://user:pw@ep-x-pooler.us-east-2.aws.neon.tech/neondb";

  // require -> verify-full, channel_binding preserved, order preserved
  check("require normalized", n(`${base}?sslmode=require&channel_binding=require`) === `${base}?sslmode=verify-full&channel_binding=require`);
  check("require not first param", n(`${base}?application_name=a%20b&sslmode=require&connect_timeout=5`) === `${base}?application_name=a%20b&sslmode=verify-full&connect_timeout=5`);
  check("postgres:// scheme", n("postgres://u:p@h/db?sslmode=require") === "postgres://u:p@h/db?sslmode=verify-full");

  // unchanged inputs (returned identical)
  for (const [label, u] of [
    ["verify-full unchanged", `${base}?sslmode=verify-full&channel_binding=require`],
    ["verify-ca unchanged", `${base}?sslmode=verify-ca`],
    ["prefer unchanged", `${base}?sslmode=prefer`],
    ["disable unchanged", `${base}?sslmode=disable`],
    ["no-verify unchanged", `${base}?sslmode=no-verify`],
    ["no sslmode unchanged", `${base}?channel_binding=require`],
    ["no query unchanged", base],
    ["uppercase REQUIRE unchanged (exact match only)", `${base}?sslmode=REQUIRE`],
    ["libpq-compat opt-in unchanged", `${base}?uselibpqcompat=true&sslmode=require`],
    ["require inside other param value unchanged", `${base}?options=sslmode%3Drequire`],
    ["key sslmodex unchanged", `${base}?sslmodex=require`],
  ]) check(label, n(u) === u);

  // encoded credentials survive byte-for-byte
  const enc = "postgresql://us%40er:p%3Aa%2Fs%40s%25w%23d@h.example.com:5432/db%20x?sslmode=require";
  check("encoded creds preserved", n(enc) === "postgresql://us%40er:p%3Aa%2Fs%40s%25w%23d@h.example.com:5432/db%20x?sslmode=verify-full");
  const dec = new URL(n(enc));
  check("encoded creds decode identically", decodeURIComponent(dec.username) === "us@er" && decodeURIComponent(dec.password) === "p:a/s@s%w#d");

  // invalid / empty inputs: no throw, unchanged, no secret in any error
  for (const bad of ["not a url", "postgresql://user:secret@:bad:port/db?sslmode=require", "", "host=h user=u password=secret sslmode=require", "mysql://u:p@h/db?sslmode=require"]) {
    let out, threw = false;
    try { out = n(bad); } catch { threw = true; }
    check(`invalid passthrough: ${bad.slice(0, 12)}`, !threw && out === bad);
  }
  check("undefined passthrough", n(undefined) === undefined);

  // idempotent
  const once = n(`${base}?sslmode=require&channel_binding=require`);
  check("idempotent", n(once) === once);

  // Behavior vs real pg-connection-string: same ssl config, no warning, channel_binding kept
  try {
    // pg-connection-string is pg's own (transitive) dependency: resolve it from pg.
    const { createRequire } = await import("node:module");
    const pgRequire = createRequire(createRequire(import.meta.url).resolve("pg"));
    const { parse } = pgRequire("pg-connection-string");
    const warnings = [];
    const onWarn = (w) => warnings.push(String(w && w.message));
    process.on("warning", onWarn);
    const raw = `${base}?sslmode=require&channel_binding=require`;
    const before = parse(raw);
    const after = parse(n(raw));
    await new Promise((r) => setTimeout(r, 20));
    process.off("warning", onWarn);
    check("pg ssl config identical (strict verification kept)", JSON.stringify(before.ssl) === JSON.stringify(after.ssl) && after.ssl && after.ssl.rejectUnauthorized !== false);
    check("channel_binding preserved through pg parse", after.channel_binding === "require");
    check("host/user/password/database identical", before.host === after.host && before.user === after.user && before.password === after.password && before.database === after.database);
    const w2 = [];
    const f = (w) => w2.push(String(w && w.message));
    process.on("warning", f);
    parse(n(raw));
    await new Promise((r) => setTimeout(r, 20));
    process.off("warning", f);
    check("no sslmode security warning after normalization", !w2.some((m) => m.includes("SECURITY WARNING")));
  } catch (e) {
    failures.push("pg-connection-string comparison failed to run");
  }

  // Redaction: failures/labels above never embed a URL; helper never logs.
  const logged = [];
  const origErr = console.error, origWarn = console.warn, origLog = console.log;
  console.error = console.warn = console.log = (...a) => logged.push(a.join(" "));
  try { n("postgresql://user:topsecret@:bad/db?sslmode=require"); n(`${base}?sslmode=require`); } finally {
    console.error = origErr; console.warn = origWarn; console.log = origLog;
  }
  check("helper never logs", logged.length === 0);

  // Call-site wiring: runtime pools and migration script use the helper, never raw env.
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const dbTs = fs.readFileSync(path.join(here, "db.ts"), "utf8");
    const mig = fs.readFileSync(path.join(here, "..", "..", "scripts", "migrate-db.mjs"), "utf8");
    check("db.ts imports helper", /normalizeDatabaseUrl[\s\S]*from "\.\/dbConnectionString\.mjs"/.test(dbTs));
    check("db.ts: both pools normalized", (dbTs.match(/connectionString: normalizeDatabaseUrl\(process\.env\.DATABASE_URL\)/g) || []).length === 2);
    check("db.ts: no raw connectionString", !/connectionString: process\.env\.DATABASE_URL/.test(dbTs));
    check("migrate-db.mjs imports helper", /from "\.\.\/src\/lib\/dbConnectionString\.mjs"/.test(mig));
    check("migrate-db.mjs: client normalized", /new Client\(\{ connectionString: normalizeDatabaseUrl\(databaseUrl\) \}\)/.test(mig));
    check("pool options preserved", /max: 1,\s*connectionTimeoutMillis: 2000,\s*idleTimeoutMillis: 10_000,\s*query_timeout: 5000/.test(dbTs));
  } catch {
    failures.push("call-site wiring check failed to run");
  }

  return failures;
}

// DEV-only SMTP config checks, kept out of smtpConfig.mjs so production code
// (auth.ts -> smtpConfig.mjs) never bundles this file: it loads NextAuth's
// internal providers.js by absolute path, which Turbopack warns about when it
// is reachable from a production route. Never import this from app code.
import { parseSmtpServer, toEmailProviderServer } from "./smtpConfig.mjs";

// ---------------------------------------------------------------------------
// DEV checks (run manually from Node; return failing labels):
//   node -e 'import("./src/lib/smtpConfigDev.mjs").then(async m=>console.log(await m.runDevSmtpConfigCases()))'
// ---------------------------------------------------------------------------
export async function runDevSmtpConfigCases() {
  const failures = [];
  const check = (label, ok) => { if (!ok) failures.push(label); };
  const p = parseSmtpServer;
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Oracle: nodemailer's own (deprecated) parser, warning suppressed for the comparison only.
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const legacy = req("nodemailer/lib/shared").parseConnectionUrl;
  const oracle = (s) => {
    const prev = process.noDeprecation;
    process.noDeprecation = true;
    try { return legacy(s); } finally { process.noDeprecation = prev; }
  };

  const formats = [
    "smtp://user:pass@smtp.example.com:587",
    "smtp://user:pass@smtp.example.com",
    "smtps://user:pass@smtp.example.com:465",
    "smtps://user:pass@smtp.example.com",
    "smtp://smtp.example.com:25",
    "smtp://user@smtp.example.com:587",
    "smtp://user:@smtp.example.com:587",
    "smtp://us%40er%2Bx:p%40ss%3Aw%2Frd%25%23@smtp.example.com:587",
    "smtp://apikey:SG.abc:def@smtp.sendgrid.net:587",
    "smtp://u:p@SMTP.Example.COM:2525",
    "smtp://u:p@[::1]:587",
    "smtp://u:p@h.example.com:587?secure=true",
    "smtp://u:p@h.example.com:587?requireTLS=true&ignoreTLS=false",
    "smtp://u:p@h.example.com:587?pool=true&maxConnections=5&maxMessages=100",
    "smtp://u:p@h.example.com:587?connectionTimeout=5000&greetingTimeout=3000&socketTimeout=10000",
    "smtp://u:p@h.example.com:587?name=client.example.com&localAddress=10.0.0.1",
    "smtps://u:p@h.example.com?tls.rejectUnauthorized=false&tls.servername=h.example.com",
    "smtp://u:p@h.example.com:587?tls.minVersion=TLSv1.2",
    "smtp://u:p@h.example.com:587?foo.bar=1&port=2525&host=evil&secure=true",
    "smtp://u:p@h.example.com:587?empty=&x=a%20b",
    "smtp://u:p@h.example.com:587?a=1&a=2",
    "direct://h.example.com",
    "smtp://u:p@h.example.com:0",
  ];
  for (const f of formats) check(`matches nodemailer parse: ${f.replace(/:[^:@/]*@/, ":***@").slice(0, 60)}`, eq(p(f), oracle(f)));

  // Explicit expectations (independent of the oracle).
  check("smtp => secure false (STARTTLS)", p("smtp://u:p@h:587").secure === false);
  check("smtps => secure true", p("smtps://u:p@h:465").secure === true);
  check("port numeric", p("smtp://u:p@h:587").port === 587);
  check("no port => none", !("port" in p("smtp://u:p@h")));
  check("encoded creds decoded", eq(p("smtp://us%40er:p%40ss%3Aw%2Frd@h:587").auth, { user: "us@er", pass: "p@ss:w/rd" }));
  check("pass with raw colon kept", p("smtp://apikey:a:b@h:587").auth.pass === "a:b");
  check("query cannot override URL host/port", (() => { const o = p("smtp://u:p@h:587?host=x&port=1"); return o.host === "h" && o.port === 587; })());
  check("query secure cannot override smtps", p("smtps://u:p@h?secure=false").secure === true);
  check("tls.* nested", eq(p("smtps://u:p@h?tls.rejectUnauthorized=false").tls, { rejectUnauthorized: false }));
  check("booleans/numbers coerced", (() => { const o = p("smtp://u:p@h?requireTLS=true&pool=false&maxConnections=3"); return o.requireTLS === true && o.pool === false && o.maxConnections === 3; })());

  // Missing / invalid / unsupported: returned unchanged, never throws.
  for (const v of [undefined, "", "not a url", "smtp://:bad:port@/", "http://u:p@h/", "user:pass@host", "smtp://u:p@h:99999999"]) {
    let out, threw = false;
    try { out = p(v); } catch { threw = true; }
    const unchangedish = out === v || (typeof out === "object" && out !== null && v === "smtp://u:p@h:99999999");
    check(`no throw / passthrough: ${String(v).slice(0, 14)}`, !threw && unchangedish);
  }

  // Redaction: never logs, outputs contain no URL string.
  const logged = [];
  const o = { e: console.error, w: console.warn, l: console.log };
  console.error = console.warn = console.log = (...a) => logged.push(a.join(" "));
  try { p("smtp://u:topsecret@h:587"); p("smtp://:topsecret@:bad/"); } finally { console.error = o.e; console.warn = o.w; console.log = o.l; }
  check("never logs", logged.length === 0);

  // Equivalent transport + no deprecated parser: spy on url.parse in a child
  // process (version-independent: the runtime DEP0169 warning only exists on
  // newer Node, so counting calls is the reliable check). Also run with
  // --throw-deprecation so the real warning would fail the child on Node 24+.
  try {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const me = fileURLToPath(new URL("./smtpConfig.mjs", import.meta.url));
    const code = (arg) => `const u=require("url");let calls=0;const o=u.parse;u.parse=function(...a){calls++;return o.apply(this,a)};import("${me}").then(m=>{const nm=require("nodemailer");const t=nm.createTransport(${arg});process.stdout.write(JSON.stringify({calls,host:t.options.host,port:t.options.port,secure:t.options.secure,user:t.options.auth&&t.options.auth.user,pass:t.options.auth&&t.options.auth.pass}))})`;
    const run = (arg, flag) => spawnSync(process.execPath, [flag, "-e", code(arg)], { cwd: process.cwd(), encoding: "utf8" });
    const url = "smtp://us%40er:p%3Aw@smtp.example.com:587";
    const mine = run(`m.parseSmtpServer(${JSON.stringify(url)})`, "--throw-deprecation");
    check("structured config: child ran clean", mine.status === 0);
    const mineOut = mine.status === 0 ? JSON.parse(mine.stdout) : null;
    check("structured config: url.parse never called", !!mineOut && mineOut.calls === 0);
    const control = run(JSON.stringify(url), "--no-deprecation");
    const controlOut = control.status === 0 ? JSON.parse(control.stdout) : null;
    check("control: raw string DOES call url.parse (check is meaningful)", !!controlOut && controlOut.calls > 0);
    check("transport options equal legacy string transport", !!mineOut && !!controlOut && eq({ ...mineOut, calls: 0 }, { ...controlOut, calls: 0 }));
    check("transport options as expected", !!mineOut && mineOut.host === "smtp.example.com" && mineOut.port === 587 && mineOut.secure === false && mineOut.user === "us@er" && mineOut.pass === "p:w");
  } catch {
    failures.push("transport/deprecation check failed to run");
  }

  // End to end through NextAuth's real provider merge (EmailProvider defaults
  // port 25 / empty auth must not leak): compare string vs structured transport.
  try {
    const { createRequire: cr } = await import("node:module");
    const rq = cr(import.meta.url);
    const EmailProvider = rq("next-auth/providers/email").default;
    // Internal module (not in next-auth's "exports"): load by absolute path.
    const { dirname, join } = await import("node:path");
    const parseProviders = rq(join(dirname(rq.resolve("next-auth")), "core", "lib", "providers.js")).default;
    const nm = rq("nodemailer");
    const SmtpTransport = rq("nodemailer/lib/smtp-transport");
    const effective = (server) => {
      const { providers } = parseProviders({ providers: [EmailProvider({ server, from: "a@b.c" })], url: new URL("https://x.test/api/auth"), providerId: "email" });
      const prov = providers.find((x) => x.id === "email");
      const prev = process.noDeprecation; process.noDeprecation = true;
      try {
        const t = nm.createTransport(prov.server);
        const tr = new SmtpTransport(t.options);
        const c = new (rq("nodemailer/lib/smtp-connection"))(tr.options);
        return { host: tr.options.host, port: c.port, secure: c.secureConnection, auth: tr.options.auth ? { user: tr.options.auth.user, pass: tr.options.auth.pass } : null };
      } finally { process.noDeprecation = prev; }
    };
    for (const u of [
      "smtp://u:p@smtp.example.com:587", "smtp://u:p@smtp.example.com", "smtps://u:p@smtp.example.com",
      "smtps://u:p@smtp.example.com:465", "smtp://smtp.example.com", "smtp://smtp.example.com:2525",
      "smtp://u:p@smtp.example.com:465", "smtp://u%40x:p%3Aq@smtp.example.com:587?requireTLS=true",
    ]) {
      check(`e2e provider merge equals string path: ${u.replace(/:[^:@/]*@/, ":***@")}`, eq(effective(toEmailProviderServer(u)), effective(u)));
    }
    check("e2e implicit smtps port 465", effective(toEmailProviderServer("smtps://u:p@h.example.com")).port === 465);
    check("e2e implicit smtp port 587", effective(toEmailProviderServer("smtp://u:p@h.example.com")).port === 587);
    check("e2e no creds => no auth", effective(toEmailProviderServer("smtp://h.example.com:587")).auth === null);
    check("toEmailProviderServer passthrough", toEmailProviderServer(undefined) === undefined && toEmailProviderServer("nope") === "nope");
  } catch (e) {
    failures.push("end-to-end provider merge check failed to run");
  }

  // Wiring: auth.ts uses the helper and not the raw string.
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const auth = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "auth.ts"), "utf8");
    check("auth.ts imports helper", /toEmailProviderServer[\s\S]*from "\.\/smtpConfig\.mjs"/.test(auth));
    check("auth.ts: server parsed", /server: toEmailProviderServer\(process\.env\.EMAIL_SERVER\)/.test(auth));
    check("auth.ts: no raw EMAIL_SERVER server", !/server: process\.env\.EMAIL_SERVER/.test(auth));
    check("auth.ts: from/session/pages unchanged", /from: process\.env\.EMAIL_FROM/.test(auth) && /strategy: "database"/.test(auth) && /signIn: "\/settings"/.test(auth));
  } catch {
    failures.push("wiring check failed to run");
  }

  return failures;
}

// EMAIL_SERVER (SMTP URL) -> structured Nodemailer SMTP options.
//
// WHY: nodemailer 7.0.13 `createTransport("smtp://...")` calls
// shared.parseConnectionUrl(), which uses the deprecated `url.parse()` and
// emits Node DEP0169 on every email sign-in. Passing NextAuth's EmailProvider a
// structured options object instead skips that code path entirely (nodemailer
// only parses when given a string / `options.url`).
//
// This is a faithful port of nodemailer's parseConnectionUrl using the WHATWG
// URL API, so the resulting transport options are identical for supported URLs:
//  - smtp: => secure:false (STARTTLS if offered); smtps: => secure:true;
//    direct: => direct:true
//  - port only when numeric and non-zero; host = hostname (IPv6 brackets removed)
//  - auth = percent-decoded "user:pass" split at the FIRST ':' (pass keeps
//    later colons) exactly like nodemailer
//  - query options: numeric strings -> Number, "true"/"false" -> boolean,
//    `tls.*` -> nested tls object, other dotted keys ignored, and a query key
//    never overrides protocol/host/port/auth already derived from the URL.
//
// Safety: pure, never logs, never throws with URL content. Anything that is
// missing or unparseable is returned UNCHANGED, so behavior is exactly what it
// was before (nodemailer decides) and no secret can end up in an error.

/**
 * @param {unknown} server EMAIL_SERVER value
 * @returns {unknown} structured SMTP options, or `server` unchanged if not a parseable smtp(s)/direct URL
 */
export function parseSmtpServer(server) {
  if (typeof server !== "string" || server === "") return server;

  let url;
  try {
    url = new URL(server);
  } catch {
    return server;
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:" && url.protocol !== "direct:") return server;

  const decode = (s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  };

  const options = {};
  if (url.protocol === "smtp:") options.secure = false;
  else if (url.protocol === "smtps:") options.secure = true;
  else options.direct = true;

  if (url.port && Number(url.port)) options.port = Number(url.port);

  // WHATWG keeps non-special-scheme hosts as-is; legacy url.parse lowercased them.
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname) options.host = hostname;

  if (url.username || url.password) {
    // Legacy semantics: decode "user:pass" as a whole, then split at the first ':'.
    const parts = decode(url.username + (url.password ? `:${url.password}` : "")).split(":");
    options.auth = { user: parts.shift(), pass: parts.join(":") };
  }

  // Query: repeated keys become arrays (legacy url.parse(.., true) behavior).
  const query = {};
  for (const [k, v] of url.searchParams) {
    if (k in query) query[k] = [].concat(query[k], v);
    else query[k] = v;
  }
  for (const key of Object.keys(query)) {
    let obj = options;
    let lKey = key;
    let value = query[key];
    if (!isNaN(value)) value = Number(value);
    if (value === "true") value = true;
    else if (value === "false") value = false;

    if (key.indexOf("tls.") === 0) {
      lKey = key.slice(4);
      if (!options.tls) options.tls = {};
      obj = options.tls;
    } else if (key.indexOf(".") >= 0) {
      continue;
    }
    if (!(lKey in obj)) obj[lKey] = value;
  }
  return options;
}

/**
 * parseSmtpServer() for NextAuth's EmailProvider specifically.
 *
 * NextAuth deep-merges an object `server` over its provider defaults
 * ({ host: "localhost", port: 25, auth: { user: "", pass: "" } }), whereas a
 * string `server` replaced them wholesale. Any key the URL did not set would
 * therefore silently inherit a default. Pin those explicitly to what nodemailer
 * itself would have chosen for the string form:
 *  - no port => nodemailer's own default (465 when secure, else 587), not 25
 *  - no credentials => `auth: undefined` (no empty-credential AUTH attempt)
 *  - no host => nodemailer's default "localhost" (same as before)
 * Non-object results (missing/invalid EMAIL_SERVER) are returned unchanged.
 *
 * @param {unknown} server EMAIL_SERVER value
 */
export function toEmailProviderServer(server) {
  const parsed = parseSmtpServer(server);
  if (parsed === null || typeof parsed !== "object") return parsed;
  const out = { ...parsed };
  if (!out.direct && !("port" in out)) out.port = out.secure ? 465 : 587;
  if (!("host" in out)) out.host = "localhost";
  if (!("auth" in out)) out.auth = undefined;
  return out;
}

/**
 * GET /api/link-preview?url=<encoded URL>
 *
 * Server-side link metadata fetcher for Discord-style preview cards under
 * links in Tom chat responses (Phase 10.3.1). Fetches the target page's
 * <head>, extracting Open Graph tags first and falling back to standard
 * meta/title tags.
 *
 * Only ever returns 200 with a metadata object — every failure mode
 * (invalid/unsafe URL, blocked host, timeout, non-HTML response, upstream
 * error, unparseable HTML) resolves to all-null fields rather than an error
 * status, so the client can render a plain link with no user-facing error.
 *
 * No DB, external services, or HTML-parsing libraries: metadata is pulled
 * out of a capped slice of the raw response body with small regexes.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const FETCH_TIMEOUT_MS = 3000;
// <head> metadata lives well within this; caps how much of a large/slow
// page we read before giving up.
const MAX_BODY_BYTES = 200_000;
const USER_AGENT = "Mozilla/5.0 (compatible; DisneyWaitPlannerBot/1.0; +link-preview)";
// Redirects followed after the initial request — each hop is revalidated,
// so this also bounds how many requests one preview lookup can trigger.
const MAX_REDIRECT_HOPS = 5;

interface LinkMetadata {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

function emptyMetadata(): LinkMetadata {
  return { title: null, description: null, image: null, siteName: null };
}

/** Only http:/https: URLs are safe to preview (blocks javascript:, data:, file:, chrome:, about:, etc). */
function isSafeHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Loopback/private/link-local IPv4 ranges — matched by dotted-quad prefix. */
function isBlockedIPv4(ipv4: string): boolean {
  if (ipv4 === "0.0.0.0") return true;
  if (/^127\./.test(ipv4)) return true;
  if (/^10\./.test(ipv4)) return true;
  if (/^192\.168\./.test(ipv4)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ipv4)) return true;
  if (/^169\.254\./.test(ipv4)) return true;
  return false;
}

function ipv4OctetsToHextets(ipv4: string): [number, number] | null {
  const octets = ipv4.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
}

/**
 * Expands an IPv6 literal (no brackets, "::" compression allowed, optional
 * trailing dotted-quad IPv4 tail) into its 8 constituent 16-bit hextets, or
 * null if it isn't parseable. Used to check numeric address ranges — regex
 * prefix-matching the way isBlockedIPv4 does isn't reliable for IPv6 since
 * "::" can compress any run of zero groups anywhere in the address.
 */
function expandIPv6Groups(address: string): number[] | null {
  if (!address.includes(":")) return null;

  const parsePart = (part: string): number[] | null => {
    if (part === "") return [];
    const rawGroups = part.split(":");
    const groups: number[] = [];
    for (let i = 0; i < rawGroups.length; i++) {
      const g = rawGroups[i];
      if (g.includes(".")) {
        if (i !== rawGroups.length - 1) return null;
        const mapped = ipv4OctetsToHextets(g);
        if (!mapped) return null;
        groups.push(mapped[0], mapped[1]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        groups.push(parseInt(g, 16));
      }
    }
    return groups;
  };

  const compressedParts = address.split("::");
  if (compressedParts.length > 2) return null;

  if (compressedParts.length === 1) {
    const groups = parsePart(compressedParts[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const head = parsePart(compressedParts[0]);
  const tail = parsePart(compressedParts[1]);
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}

/**
 * Blocks loopback (::1), link-local (fe80::/10), unique-local/private
 * (fc00::/7), multicast (ff00::/8), the unspecified address (::), and
 * IPv4-mapped/-compatible addresses (e.g. ::ffff:127.0.0.1) whose embedded
 * IPv4 address is itself blocked. An address that fails to parse is
 * blocked rather than let through, since "unrecognized" shouldn't mean
 * "assumed safe" for an SSRF guard.
 */
function isBlockedIPv6(address: string): boolean {
  const groups = expandIPv6Groups(address);
  if (!groups) return true;

  const isZero = (g: number) => g === 0;

  if (groups.slice(0, 7).every(isZero) && groups[7] === 1) return true; // ::1
  if (groups.every(isZero)) return true; // ::
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  // ::ffff:a.b.c.d (IPv4-mapped) and the deprecated ::a.b.c.d
  // (IPv4-compatible) both carry an IPv4 address in the low 32 bits.
  if (groups.slice(0, 5).every(isZero) && (groups[5] === 0xffff || groups[5] === 0)) {
    const ipv4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    if (isBlockedIPv4(ipv4)) return true;
  }

  return false;
}

/**
 * Basic SSRF guard against loopback/private/link-local hosts, for both IPv4
 * and IPv6. Tom's response text isn't fully trusted (it's LLM output that
 * can be steered by user input), so this route shouldn't be usable to probe
 * internal network addresses even though it's not taking raw user input
 * directly.
 */
function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower.includes(":")) return isBlockedIPv6(lower);
  return isBlockedIPv4(lower);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&[lr]squo;/g, "'")
    .replace(/&[lr]dquo;/g, '"')
    .replace(/&hellip;/g, "…")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
}

/** Matches a <meta> tag with the given property/name key, regardless of attribute order. */
function extractMeta(html: string, attr: "property" | "name", key: string): string | undefined {
  const keyContent = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']*)["']`, "i");
  const contentKey = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${key}["']`, "i");
  const match = html.match(keyContent) || html.match(contentKey);
  const raw = match?.[1];
  return raw ? decodeEntities(raw).trim() || undefined : undefined;
}

function extractTitleTag(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const raw = match?.[1];
  return raw ? decodeEntities(raw).trim() || undefined : undefined;
}

function resolveUrl(base: string, maybeRelative: string): string | undefined {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return undefined;
  }
}

/**
 * Combines the scheme check with the SSRF host guard. Used both for the
 * originally requested URL and for every redirect target, since a public
 * URL can 3xx to a private/loopback/link-local address and automatic
 * redirect-following would otherwise bypass isBlockedHost entirely.
 */
function isSafePublicUrl(value: string | null | undefined): value is string {
  if (!isSafeHttpUrl(value)) return false;
  return !isBlockedHost(new URL(value).hostname);
}

/**
 * Fetches startUrl with redirect: "manual" and follows redirects by hand,
 * re-validating each Location target (safe scheme + not private/loopback)
 * before requesting it, and resolving relative Location headers against the
 * current URL. Stops and returns null if a redirect target is unsafe, its
 * Location header is missing/unparseable, or the hop limit is exceeded.
 */
async function fetchFollowingSafeRedirects(startUrl: URL, signal: AbortSignal): Promise<Response | null> {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const response = await fetch(currentUrl.toString(), {
      signal,
      redirect: "manual",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      cache: "no-store",
    });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    // Another redirect, but we're out of hops — refuse rather than follow.
    if (hop === MAX_REDIRECT_HOPS) {
      return null;
    }

    const location = response.headers.get("location");
    const nextUrlString = location ? resolveUrl(currentUrl.toString(), location) : undefined;
    if (!isSafePublicUrl(nextUrlString)) {
      return null;
    }
    currentUrl = new URL(nextUrlString);
  }

  return null;
}

/** Reads the response body up to MAX_BODY_BYTES, stopping early once </head> is seen. */
async function readCappedHtml(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let html = "";
  let bytesRead = 0;
  try {
    while (bytesRead < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return html;
}

export async function GET(request: NextRequest) {
  const rawUrl = request.nextUrl.searchParams.get("url");
  if (!isSafePublicUrl(rawUrl)) {
    return NextResponse.json(emptyMetadata());
  }

  const target = new URL(rawUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstream = await fetchFollowingSafeRedirects(target, controller.signal);

    if (!upstream || !upstream.ok) {
      return NextResponse.json(emptyMetadata());
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return NextResponse.json(emptyMetadata());
    }

    const html = await readCappedHtml(upstream);
    if (!html) {
      return NextResponse.json(emptyMetadata());
    }

    // Resolve relative URLs (e.g. og:image) against the final, post-redirect
    // page URL rather than the originally requested one.
    const finalUrl = upstream.url || target.toString();

    const title = extractMeta(html, "property", "og:title") || extractTitleTag(html);
    const description =
      extractMeta(html, "property", "og:description") || extractMeta(html, "name", "description");
    const rawImage = extractMeta(html, "property", "og:image");
    const resolvedImage = rawImage ? resolveUrl(finalUrl, rawImage) : undefined;
    const image = resolvedImage && isSafeHttpUrl(resolvedImage) ? resolvedImage : undefined;
    const siteName = extractMeta(html, "property", "og:site_name") || new URL(finalUrl).hostname;

    return NextResponse.json({
      title: title || null,
      description: description || null,
      image: image || null,
      siteName: siteName || null,
    });
  } catch {
    // Timeout (AbortError), network error, blocked site, or malformed
    // response — all treated the same: no preview, no user-facing error.
    return NextResponse.json(emptyMetadata());
  } finally {
    clearTimeout(timeout);
  }
}

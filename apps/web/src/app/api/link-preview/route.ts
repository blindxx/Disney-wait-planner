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
function isSafeHttpUrl(value: string | null): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Basic SSRF guard against loopback/private/link-local hosts. Tom's response
 * text isn't fully trusted (it's LLM output that can be steered by user
 * input), so this route shouldn't be usable to probe internal network
 * addresses even though it's not taking raw user input directly.
 */
function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower === "0.0.0.0" || lower === "::1" || lower === "::") return true;
  if (/^127\./.test(lower)) return true;
  if (/^10\./.test(lower)) return true;
  if (/^192\.168\./.test(lower)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(lower)) return true;
  if (/^169\.254\./.test(lower)) return true;
  return false;
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
  if (!isSafeHttpUrl(rawUrl)) {
    return NextResponse.json(emptyMetadata());
  }

  const target = new URL(rawUrl);
  if (isBlockedHost(target.hostname)) {
    return NextResponse.json(emptyMetadata());
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstream = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      cache: "no-store",
    });

    if (!upstream.ok) {
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

    const title = extractMeta(html, "property", "og:title") || extractTitleTag(html);
    const description =
      extractMeta(html, "property", "og:description") || extractMeta(html, "name", "description");
    const rawImage = extractMeta(html, "property", "og:image");
    const resolvedImage = rawImage ? resolveUrl(target.toString(), rawImage) : undefined;
    const image = resolvedImage && isSafeHttpUrl(resolvedImage) ? resolvedImage : undefined;
    const siteName = extractMeta(html, "property", "og:site_name") || target.hostname;

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

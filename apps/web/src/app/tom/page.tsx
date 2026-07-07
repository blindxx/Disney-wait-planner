"use client";

/**
 * Tom Chat Page — Phase 10.3, planner-aware context added in Phase 10.4
 *
 * Minimal mobile-first chat UI for the Tom assistant.
 * Talks only to POST /api/tom/ask (this app's own proxy route) — never
 * calls the Tom Railway service directly. Request body is
 * { question, session_id, source, planner_context? } — planner_context is a
 * compact, read-only snapshot (see lib/plannerContextSnapshot.ts) built
 * fresh from the active profile's local planner data at send time, and is
 * omitted entirely when there is nothing to send (no plans, no Lightning).
 * Tom never writes back to planner storage — it only answers questions.
 *
 * localStorage keys:
 *   dwp.tomChat.v1 — local-only conversation cache: { messages, sessionId,
 *   updatedAt }. Restored on mount if updatedAt is within CHAT_TTL_MS,
 *   otherwise treated as expired and discarded. The same sessionId is
 *   reused for every message (including across reloads) so Tom can
 *   maintain conversation context server-side. Never synced to a backend.
 *   dwp.tom.sessionId — pre-10.3 session id. Only ever read, as a one-time
 *   fallback when dwp.tomChat.v1 is missing/malformed, so upgrading users
 *   keep their existing Tom server-side follow-up context instead of
 *   silently starting a new session. Nothing writes to this key anymore.
 */

import { useEffect, useRef, useState } from "react";
import { buildPlannerContextSnapshot } from "@/lib/plannerContextSnapshot";

const CHAT_STORAGE_KEY = "dwp.tomChat.v1";
const LEGACY_SESSION_STORAGE_KEY = "dwp.tom.sessionId";
const CHAT_TTL_MS = 24 * 60 * 60 * 1000;
const TOM_SOURCE = "disney-wait-planner";
const TOM_AVATAR_SRC = "/images/tom-avatar.png";
const DISCORD_INVITE_URL = "https://discord.gg/tMhXGHEgt";

const HELPER_TEXT =
  "Ask about Disney attractions, dining, entertainment, wait times, park updates, and Disney news.";
const INFO_TEXT =
  "Tom Morrow is Disney Wait Planner's AI assistant, inspired by Disney's classic futuristic character of the same name. Ask Tom about Disney parks, attractions, dining, entertainment, wait times, and the latest Disney news. Tom can also answer read-only questions about your local planner, like what you have planned, dining, entertainment, Lightning selections, conflicts, and repeats.";

/** How close (px) to the bottom of the scroll container still counts as "at the bottom" for auto-scroll. */
const NEAR_BOTTOM_THRESHOLD = 80;

/** Example prompts shown before the first message, spanning a few of Tom's capabilities. */
const STARTER_PROMPTS = [
  "What's new at Walt Disney World?",
  "What's new at Disneyland?",
  "What's the latest Star Wars news?",
  "What's the latest Marvel news?",
  "Tell me about Savi's Workshop.",
];

type ChatRole = "user" | "tom";

/** A source returned by Tom — shape is upstream-defined, so we render defensively. */
type TomSource = string | { title?: string; url?: string; name?: string };

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  sources?: TomSource[];
}

interface StoredChatState {
  messages: ChatMessage[];
  sessionId: string;
  updatedAt: number;
}

function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Validates one persisted message, dropping anything malformed rather than failing the whole restore. */
function normalizeStoredMessage(raw: unknown): ChatMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Record<string, unknown>;
  const role = candidate.role;
  const text = candidate.text;
  if ((role !== "user" && role !== "tom") || typeof text !== "string") return undefined;
  const id = typeof candidate.id === "string" && candidate.id ? candidate.id : generateId();
  const sources = normalizeSources(candidate.sources);
  return { id, role, text, sources: sources.length > 0 ? sources : undefined };
}

function normalizeStoredMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const result: ChatMessage[] = [];
  for (const item of raw) {
    const normalized = normalizeStoredMessage(item);
    if (normalized) result.push(normalized);
  }
  return result;
}

/** Reads the pre-10.3 session id, if any — used only as a migration fallback below. */
function loadLegacySessionId(): string | null {
  try {
    const legacy = localStorage.getItem(LEGACY_SESSION_STORAGE_KEY);
    return legacy && legacy.trim() ? legacy : null;
  } catch {
    return null;
  }
}

/** messages: [] paired with a migrated legacy session id, or null if there's nothing to migrate. */
function migrateFromLegacySession(): { messages: ChatMessage[]; sessionId: string } | null {
  const legacySessionId = loadLegacySessionId();
  return legacySessionId ? { messages: [], sessionId: legacySessionId } : null;
}

/**
 * Restores the locally persisted chat if present and younger than CHAT_TTL_MS.
 * If dwp.tomChat.v1 is missing or malformed (as opposed to present-but-expired),
 * falls back to the pre-10.3 dwp.tom.sessionId so upgrading users keep their
 * existing Tom server-side follow-up context instead of silently starting a
 * new session. A present-but-expired entry still expires normally — no
 * migration kicks in for that case.
 */
function loadStoredChat(): { messages: ChatMessage[]; sessionId: string } | null {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return migrateFromLegacySession();

    const parsed = JSON.parse(raw) as Partial<StoredChatState> | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.sessionId !== "string" || !parsed.sessionId) {
      return migrateFromLegacySession();
    }

    if (typeof parsed.updatedAt !== "number" || Date.now() - parsed.updatedAt > CHAT_TTL_MS) {
      return null;
    }

    return { messages: normalizeStoredMessages(parsed.messages), sessionId: parsed.sessionId };
  } catch {
    return migrateFromLegacySession();
  }
}

function saveStoredChat(state: StoredChatState): void {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) — chat still
    // works for the current tab, it just won't persist across reloads.
  }
}

function sourceLabel(source: TomSource): string {
  if (typeof source === "string") return source;
  return source.title || source.name || source.url || "Source";
}

/** Only http:/https: URLs are safe to render as clickable links (blocks javascript:, data:, etc). */
function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const URL_PATTERN = /https?:\/\/[^\s]+/g;

/** Trailing punctuation that's almost never part of the URL itself (e.g. end of a sentence). */
function splitTrailingPunctuation(url: string): { url: string; trailing: string } {
  const match = url.match(/[.,!?;:)\]}'"]+$/);
  if (!match) return { url, trailing: "" };
  return { url: url.slice(0, url.length - match[0].length), trailing: match[0] };
}

/**
 * Splits Tom's response text into plain-text and clickable-link segments.
 * Only well-formed http:/https: URLs become links; everything else (including
 * javascript:, data:, and other unsafe schemes) is left as plain text.
 */
function linkifyText(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  URL_PATTERN.lastIndex = 0;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const { url, trailing } = splitTrailingPunctuation(match[0]);
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));

    if (isSafeHttpUrl(url)) {
      parts.push(
        <a key={key++} className="tom-link" href={url} target="_blank" rel="noopener noreferrer">
          {url}
        </a>
      );
    } else {
      parts.push(url);
    }
    if (trailing) parts.push(trailing);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

/** Unique, in-order safe http(s) URLs found in Tom's response text — the candidates for preview cards. */
function extractSafeUrls(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  let match: RegExpExecArray | null;
  URL_PATTERN.lastIndex = 0;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const { url } = splitTrailingPunctuation(match[0]);
    if (isSafeHttpUrl(url) && !seen.has(url)) {
      seen.add(url);
      result.push(url);
    }
  }
  return result;
}

/** Metadata for one link preview card — mirrors the /api/link-preview response shape. */
interface LinkPreviewData {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

type LinkPreviewResult = LinkPreviewData | null;

/**
 * Module-level cache (not component state) so previews survive across
 * messages and "New Chat" resets for the lifetime of the tab, avoiding
 * repeated duplicate fetches of the same URL in a chat session. `null`
 * means "fetched, no usable preview" (renders as a plain link, not retried).
 */
const linkPreviewCache = new Map<string, LinkPreviewResult>();
const linkPreviewInFlight = new Map<string, Promise<LinkPreviewResult>>();

function toPreviewData(url: string, raw: unknown): LinkPreviewResult {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const title = typeof candidate.title === "string" && candidate.title ? candidate.title : undefined;
  const description =
    typeof candidate.description === "string" && candidate.description ? candidate.description : undefined;
  const image = isSafeHttpUrl(candidate.image) ? candidate.image : undefined;
  const siteName = typeof candidate.siteName === "string" && candidate.siteName ? candidate.siteName : undefined;
  if (!title && !description && !image) return null;
  return { url, title, description, image, siteName };
}

/** Fetches (and caches) preview metadata for one URL; failures resolve to null rather than throwing. */
function fetchLinkPreview(url: string): Promise<LinkPreviewResult> {
  const cached = linkPreviewCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  const inFlight = linkPreviewInFlight.get(url);
  if (inFlight) return inFlight;

  const promise = fetch(`/api/link-preview?url=${encodeURIComponent(url)}`)
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => toPreviewData(url, data))
    .catch(() => null)
    .then((result) => {
      linkPreviewCache.set(url, result);
      linkPreviewInFlight.delete(url);
      return result;
    });

  linkPreviewInFlight.set(url, promise);
  return promise;
}

/**
 * Fetches previews for each URL in a Tom message and renders a card for any
 * that resolve to metadata. Cards arrive asynchronously, one at a time,
 * after the message itself has already rendered — onCardsChange lets the
 * parent re-pin scroll to bottom (only if the user was already there) once
 * the DOM has actually grown to include a new card.
 */
function LinkPreviewCards({ urls, onCardsChange }: { urls: string[]; onCardsChange: () => void }) {
  const [previews, setPreviews] = useState<Record<string, LinkPreviewResult>>({});

  useEffect(() => {
    let cancelled = false;
    urls.forEach((url) => {
      const cached = linkPreviewCache.get(url);
      if (cached !== undefined) {
        setPreviews((prev) => (url in prev ? prev : { ...prev, [url]: cached }));
        return;
      }
      fetchLinkPreview(url).then((result) => {
        if (!cancelled) setPreviews((prev) => ({ ...prev, [url]: result }));
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urls.join("\n")]);

  const cards = urls
    .map((url) => previews[url])
    .filter((card): card is LinkPreviewData => Boolean(card));

  // Fires after React has committed the DOM update for a newly-appeared
  // card (useEffect runs post-paint), so the parent's scrollHeight read is
  // accurate. Re-fires each time the visible card count changes.
  const cardCount = cards.length;
  useEffect(() => {
    if (cardCount > 0) onCardsChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardCount]);

  if (cards.length === 0) return null;

  return (
    <div className="tom-previews">
      {cards.map((card) => (
        <a
          key={card.url}
          className="tom-preview-card"
          href={card.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {card.image && <img className="tom-preview-image" src={card.image} alt="" />}
          <div className="tom-preview-body">
            {card.siteName && <div className="tom-preview-site">{card.siteName}</div>}
            {card.title && <div className="tom-preview-title">{card.title}</div>}
            {card.description && <div className="tom-preview-desc">{card.description}</div>}
          </div>
        </a>
      ))}
    </div>
  );
}

function sourceHref(source: TomSource): string | undefined {
  if (typeof source === "string") return undefined;
  return isSafeHttpUrl(source.url) ? source.url : undefined;
}

/** Normalizes one raw upstream source into a TomSource, or undefined if it isn't usable. */
function normalizeSource(raw: unknown): TomSource | undefined {
  if (typeof raw === "string") return raw;

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const candidate = raw as Record<string, unknown>;
    const title = typeof candidate.title === "string" ? candidate.title : undefined;
    const url = typeof candidate.url === "string" ? candidate.url : undefined;
    const name = typeof candidate.name === "string" ? candidate.name : undefined;
    if (title !== undefined || url !== undefined || name !== undefined) {
      return { title, url, name };
    }
  }

  return undefined;
}

/** Filters raw upstream sources down to only well-formed entries; invalid elements are dropped. */
function normalizeSources(raw: unknown): TomSource[] {
  if (!Array.isArray(raw)) return [];
  const result: TomSource[] = [];
  for (const item of raw) {
    const normalized = normalizeSource(item);
    if (normalized !== undefined) result.push(normalized);
  }
  return result;
}

const CHAT_CSS = `
  .tom-page {
    position: relative;
    max-width: 700px;
    /* Cancel the shared .main wrapper 2rem top/bottom padding (see
       globals.css) — otherwise it stacks with the viewport-based height
       below and pushes the input row below the fold on mobile. */
    margin: -2rem auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    height: calc(100vh - 50px);
    height: calc(100dvh - 50px);
    min-height: 480px;
  }

  .tom-jump-btn {
    position: absolute;
    right: 20px;
    bottom: 78px;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 14px;
    border-radius: 999px;
    border: none;
    background-color: #1e3a5f;
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
  }
  .tom-jump-btn:hover {
    background-color: #16324f;
  }

  .tom-header {
    margin-bottom: 12px;
  }
  .tom-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    row-gap: 6px;
  }
  .tom-title-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tom-avatar-icon {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
  }
  .tom-title {
    font-size: 20px;
    font-weight: 700;
    color: #111827;
    margin: 0;
  }
  .tom-new-chat-btn {
    flex-shrink: 0;
    padding: 6px 14px;
    border-radius: 999px;
    border: 1px solid #d1d5db;
    background-color: #fff;
    color: #1e3a5f;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .tom-new-chat-btn:hover {
    background-color: #f3f4f6;
  }
  .tom-helper {
    margin: 4px 0 0;
    font-size: 13px;
    line-height: 1.4;
    color: #6b7280;
  }

  .tom-info-wrap {
    position: relative;
    display: inline-flex;
  }
  .tom-info-btn {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    border-radius: 50%;
    border: 1px solid #9ca3af;
    background-color: #fff;
    color: #6b7280;
    font-size: 12px;
    font-style: italic;
    font-weight: 700;
    line-height: 1;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .tom-info-btn:focus-visible {
    outline: 2px solid #1e3a5f;
    outline-offset: 2px;
  }
  .tom-info-tooltip {
    display: none;
    position: absolute;
    top: 26px;
    left: 0;
    z-index: 10;
    width: 260px;
    max-width: 75vw;
    padding: 10px 12px;
    border-radius: 8px;
    background-color: #111827;
    color: #f9fafb;
    font-size: 12px;
    line-height: 1.45;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
  }
  .tom-info-wrap:hover .tom-info-tooltip,
  .tom-info-wrap:focus-within .tom-info-tooltip,
  .tom-info-wrap.show .tom-info-tooltip {
    display: block;
  }

  .tom-discord-hint {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid rgba(249, 250, 251, 0.2);
    color: #d1d5db;
  }
  .tom-discord-link {
    color: #93c5fd;
    text-decoration: underline;
  }

  .tom-messages {
    flex: 1 1 auto;
    /* Without this, a flex item will not shrink below its content height, so
       the message list cannot become the scrollable region — the whole page
       scrolls instead, burying the input row below the fold on mobile. */
    min-height: 0;
    overflow-y: auto;
    overflow-anchor: none;
    scroll-behavior: smooth;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 4px 2px 12px;
  }

  .tom-bubble-row {
    display: flex;
    align-items: flex-end;
  }
  .tom-bubble-row.user {
    justify-content: flex-end;
  }
  .tom-bubble-row.tom {
    justify-content: flex-start;
  }

  .tom-avatar-msg {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
    margin-right: 8px;
  }

  .tom-bubble {
    max-width: 85%;
    padding: 10px 14px;
    border-radius: 14px;
    font-size: 15px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .tom-bubble.user {
    background-color: #1e3a5f;
    color: #fff;
    border-bottom-right-radius: 4px;
  }
  .tom-bubble.tom {
    background-color: #f3f4f6;
    color: #111827;
    border-bottom-left-radius: 4px;
  }

  .tom-link {
    color: #1e3a5f;
    text-decoration: underline;
    word-break: break-all;
  }
  .tom-bubble.user .tom-link {
    color: #cfe0f5;
  }

  .tom-previews {
    max-width: 85%;
    margin-top: 6px;
    margin-left: 38px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .tom-preview-card {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 8px;
    border: 1px solid #e5e7eb;
    background-color: #fff;
    text-decoration: none;
    color: inherit;
  }
  .tom-preview-card:hover {
    border-color: #cbd5e1;
  }
  .tom-preview-image {
    width: 100%;
    max-width: 100%;
    /* Fixed (not max-) height reserves the box the instant the <img> is
       inserted, before the image itself has loaded — otherwise the box
       grows once the image decodes and its intrinsic size is known,
       shifting content below it out from under a user pinned to the
       bottom a second time, after the card-insertion scroll fix already
       ran. */
    height: 160px;
    object-fit: cover;
    display: block;
    background-color: #f3f4f6;
  }
  .tom-preview-body {
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .tom-preview-site {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #6b7280;
  }
  .tom-preview-title {
    font-size: 13px;
    font-weight: 600;
    color: #111827;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .tom-preview-desc {
    font-size: 12px;
    line-height: 1.35;
    color: #6b7280;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .tom-sources {
    max-width: 85%;
    margin-top: 6px;
    padding: 8px 10px;
    border-radius: 8px;
    background-color: #f9fafb;
    border: 1px solid #e5e7eb;
    font-size: 12px;
    color: #6b7280;
  }
  .tom-sources-label {
    font-weight: 600;
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #6b7280;
  }
  .tom-sources ul {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .tom-sources li {
    line-height: 1.4;
  }

  .tom-typing {
    display: inline-flex;
    gap: 4px;
    padding: 10px 14px;
  }
  .tom-typing span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background-color: #9ca3af;
    animation: tom-typing-bounce 1.2s infinite ease-in-out;
  }
  .tom-typing span:nth-child(2) { animation-delay: 0.15s; }
  .tom-typing span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes tom-typing-bounce {
    0%, 80%, 100% { transform: translateY(0); opacity: 0.5; }
    40% { transform: translateY(-4px); opacity: 1; }
  }

  .tom-error {
    margin: 8px 2px;
    padding: 10px 14px;
    border-radius: 8px;
    background-color: #fef2f2;
    border: 1px solid #fecaca;
    color: #991b1b;
    font-size: 14px;
  }

  .tom-form {
    display: flex;
    gap: 8px;
    padding-top: 10px;
    border-top: 1px solid #e5e7eb;
  }

  .tom-input {
    flex: 1 1 auto;
    padding: 10px 14px;
    border-radius: 20px;
    border: 1px solid #d1d5db;
    font-size: 15px;
    outline: none;
  }
  .tom-input:focus {
    border-color: #1e3a5f;
  }

  .tom-send {
    flex: 0 0 auto;
    padding: 10px 20px;
    border-radius: 20px;
    border: none;
    background-color: #1e3a5f;
    color: #fff;
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
  }
  .tom-send:disabled {
    background-color: #9ca3af;
    cursor: not-allowed;
  }

  .tom-empty {
    text-align: center;
    color: #6b7280;
    font-size: 14px;
    padding: 40px 20px;
    line-height: 1.5;
    margin: auto 0;
  }
  .tom-empty-title {
    color: #374151;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .tom-avatar-empty {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    object-fit: cover;
    display: block;
    margin: 0 auto 12px;
  }

  .tom-examples {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-top: 18px;
  }
  .tom-example-chip {
    padding: 8px 14px;
    border-radius: 999px;
    border: 1px solid #d1d5db;
    background-color: #fff;
    color: #1e3a5f;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }
  .tom-example-chip:hover {
    background-color: #f3f4f6;
  }
  .tom-example-chip:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  @media (max-width: 480px) {
    .tom-page {
      padding: 12px;
    }
    .tom-bubble {
      max-width: 90%;
      font-size: 14px;
      padding: 9px 12px;
    }
    .tom-sources {
      max-width: 90%;
    }
    .tom-previews {
      max-width: 90%;
      margin-left: 30px;
    }
    .tom-preview-image {
      height: 120px;
    }
    .tom-messages {
      gap: 10px;
    }
    .tom-info-tooltip {
      /* Centering under the (narrow) info button, rather than growing from
         its left edge, keeps the tooltip clear of both screen edges
         regardless of how far right the button sits in the header. */
      left: 50%;
      transform: translateX(-50%);
      width: min(280px, 90vw);
      max-width: min(280px, 90vw);
    }
    .tom-empty {
      margin: 0;
      padding: 16px 20px 24px;
    }
    .tom-avatar-empty {
      width: 44px;
      height: 44px;
    }
    .tom-avatar-msg {
      width: 24px;
      height: 24px;
      margin-right: 6px;
    }
    .tom-new-chat-btn {
      padding: 5px 10px;
      font-size: 11px;
    }
    .tom-examples {
      flex-direction: column;
      align-items: stretch;
    }
    .tom-example-chip {
      text-align: center;
    }
    .tom-jump-btn {
      left: 50%;
      right: auto;
      bottom: 72px;
      transform: translateX(-50%);
      max-width: calc(100% - 28px);
      white-space: nowrap;
    }
  }
`;

export default function TomChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string>(() => generateId());
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const messagesRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  // Mirrors `sessionId` for synchronous reads inside async callbacks, so an
  // in-flight request started before "New Chat" can detect it's now stale.
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Restore a persisted conversation (if any, and not older than 24h) once on
  // mount — this runs client-only so it never causes an SSR hydration mismatch.
  useEffect(() => {
    const stored = loadStoredChat();
    if (stored) {
      setMessages(stored.messages);
      setSessionId(stored.sessionId);
    }
    setHydrated(true);
  }, []);

  // Persist after every change, once the initial restore above has run —
  // guarding on `hydrated` stops this from clobbering storage with the
  // pre-restore empty state.
  useEffect(() => {
    if (!hydrated) return;
    saveStoredChat({ messages, sessionId, updatedAt: Date.now() });
  }, [messages, sessionId, hydrated]);

  function handleMessagesScroll() {
    const el = messagesRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
    isNearBottomRef.current = nearBottom;
    setShowJumpToLatest(!nearBottom);
  }

  function scrollToLatest() {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
  }

  /**
   * Called after a preview card's DOM has actually been inserted (see
   * LinkPreviewCards' onCardsChange). A preview card renders asynchronously,
   * well after the message it belongs to, so it isn't covered by the
   * messages/loading auto-scroll effect below — without this, a card
   * appearing while the user is pinned to the bottom would silently grow
   * the scrollable content out from under them and make the jump-to-latest
   * button appear as if they'd scrolled away, even though they hadn't.
   */
  function handlePreviewCardsChange() {
    const el = messagesRef.current;
    if (!el) return;
    if (isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    handleMessagesScroll();
  }

  // Recompute near-bottom state on layout/size changes (not just scroll) so the
  // jump button stays correct through mobile toolbar show/hide and keyboard
  // open/close, which resize the container without firing a scroll event.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => handleMessagesScroll());
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Auto-scroll to the newest message, but only if the user was already
  // near the bottom — someone scrolled up to re-read history shouldn't get
  // yanked back down by an incoming reply.
  useEffect(() => {
    const el = messagesRef.current;
    if (el && isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, loading]);

  /** Returns true on success so the caller can decide whether to restore the input. */
  async function sendQuestion(question: string): Promise<boolean> {
    // Captured at request start: if "New Chat" swaps in a new session before
    // this resolves, sessionIdRef.current will no longer match and the
    // response below is discarded instead of landing in the new conversation.
    const requestSessionId = sessionId;
    const isStale = () => sessionIdRef.current !== requestSessionId;

    setLoading(true);
    setError(null);

    try {
      // Built fresh per request (not cached) so it reflects the latest local
      // planner edits; undefined when there's nothing useful to send.
      const plannerContext = buildPlannerContextSnapshot();

      const res = await fetch("/api/tom/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          session_id: requestSessionId,
          source: TOM_SOURCE,
          ...(plannerContext ? { planner_context: plannerContext } : {}),
        }),
      });

      if (isStale()) return true;

      if (res.status === 429) {
        setError("Tom is getting a lot of questions right now. Please wait a moment and try again.");
        return false;
      }

      if (!res.ok) {
        setError("Something went wrong. Please try again.");
        return false;
      }

      const data = await res.json();
      if (isStale()) return true;

      const answer = typeof data?.answer === "string" ? data.answer : "";
      if (!answer) {
        setError("Something went wrong. Please try again.");
        return false;
      }

      const sources = normalizeSources(data?.sources);
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          role: "tom",
          text: answer,
          sources: sources.length > 0 ? sources : undefined,
        },
      ]);
      return true;
    } catch {
      if (!isStale()) setError("Something went wrong. Please try again.");
      return false;
    } finally {
      if (!isStale()) setLoading(false);
    }
  }

  function submitQuestion(question: string) {
    const requestSessionId = sessionId;
    setInput("");
    setMessages((prev) => [...prev, { id: generateId(), role: "user", text: question }]);
    void sendQuestion(question).then((ok) => {
      // Keep the failed question in the input box so it can be retried or
      // edited — but only if the conversation wasn't reset in the meantime.
      if (!ok && sessionIdRef.current === requestSessionId) setInput(question);
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || loading) return;
    submitQuestion(question);
  }

  function handleStarterPrompt(question: string) {
    if (loading) return;
    submitQuestion(question);
  }

  /** Clears the conversation, starts a fresh session id, and replaces the persisted chat. */
  function handleNewChat() {
    const newSessionId = generateId();
    // Update the ref synchronously, before any state-setter-triggered
    // re-render/effect runs — a fetch already in flight can resolve on the
    // microtask queue before React flushes effects, so the ref update can't
    // wait on the `sessionIdRef.current = sessionId` sync effect below.
    sessionIdRef.current = newSessionId;
    setMessages([]);
    setSessionId(newSessionId);
    setInput("");
    setError(null);
    setLoading(false);
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
  }

  return (
    <>
      <style>{CHAT_CSS}</style>
      <div className="tom-page">
        <div className="tom-header">
          <div className="tom-title-row">
            <div className="tom-title-left">
              <img className="tom-avatar-icon" src={TOM_AVATAR_SRC} alt="" aria-hidden="true" />
              <h1 className="tom-title">Ask Tom</h1>
              <div className={`tom-info-wrap${infoOpen ? " show" : ""}`}>
                <button
                  type="button"
                  className="tom-info-btn"
                  aria-label="About Tom"
                  aria-expanded={infoOpen}
                  onClick={() => setInfoOpen((v) => !v)}
                  onBlur={() => setInfoOpen(false)}
                >
                  i
                </button>
                <div className="tom-info-tooltip" role="tooltip">
                  {INFO_TEXT}
                  <div className="tom-discord-hint">
                    Want a longer chat history or prefer Discord?{" "}
                    <a
                      href={DISCORD_INVITE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="tom-discord-link"
                    >
                      Chat with Tom on Discord.
                    </a>
                  </div>
                </div>
              </div>
            </div>
            <button type="button" className="tom-new-chat-btn" onClick={handleNewChat}>
              New Chat
            </button>
          </div>
          <p className="tom-helper">{HELPER_TEXT}</p>
        </div>

        <div className="tom-messages" ref={messagesRef} onScroll={handleMessagesScroll}>
          {messages.length === 0 && !loading && (
            <div className="tom-empty">
              <img className="tom-avatar-empty" src={TOM_AVATAR_SRC} alt="Tom Morrow" />
              <div className="tom-empty-title">Ask Tom anything about your Disney trip</div>
              <div>
                Ask Tom about Disney parks, wait times, attractions, and the latest Disney,
                Marvel, and Star Wars news.
              </div>
              <div className="tom-examples" role="group" aria-label="Example questions">
                {STARTER_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className="tom-example-chip"
                    onClick={() => handleStarterPrompt(prompt)}
                    disabled={loading}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => (
            <div key={message.id}>
              <div className={`tom-bubble-row ${message.role}`}>
                {message.role === "tom" && (
                  <img className="tom-avatar-msg" src={TOM_AVATAR_SRC} alt="" aria-hidden="true" />
                )}
                <div className={`tom-bubble ${message.role}`}>
                  {message.role === "tom" ? linkifyText(message.text) : message.text}
                </div>
              </div>
              {message.role === "tom" && (
                <LinkPreviewCards urls={extractSafeUrls(message.text)} onCardsChange={handlePreviewCardsChange} />
              )}
              {message.sources && message.sources.length > 0 && (
                <div className="tom-sources" style={{ marginLeft: message.role === "tom" ? "38px" : "auto", textAlign: message.role === "tom" ? "left" : "right" }}>
                  <span className="tom-sources-label">Sources</span>
                  <ul>
                    {message.sources.map((source, i) => {
                      const href = sourceHref(source);
                      return (
                        <li key={i}>
                          {href ? (
                            <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "#6b7280" }}>
                              {sourceLabel(source)}
                            </a>
                          ) : (
                            sourceLabel(source)
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="tom-bubble-row tom">
              <div className="tom-bubble tom tom-typing">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
        </div>

        {messages.length > 0 && showJumpToLatest && (
          <button
            type="button"
            className="tom-jump-btn"
            onClick={scrollToLatest}
            aria-label="Jump to latest message"
          >
            ↓ New messages
          </button>
        )}

        {error && <div className="tom-error">{error}</div>}

        <form className="tom-form" onSubmit={handleSubmit}>
          <input
            className="tom-input"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask Tom a question..."
            disabled={loading}
            aria-label="Message to Tom"
          />
          <button className="tom-send" type="submit" disabled={loading || !input.trim()}>
            Send
          </button>
        </form>
      </div>
    </>
  );
}

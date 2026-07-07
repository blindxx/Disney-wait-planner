"use client";

/**
 * Tom Chat Page — Phase 10.2
 *
 * Minimal mobile-first chat UI for the Tom assistant.
 * Talks only to POST /api/tom/ask (this app's own proxy route) — never
 * calls the Tom Railway service directly and never sends planner data,
 * Lightning, profiles, conflicts, or recommendations. Every request body
 * is limited to { question, session_id, source }.
 *
 * localStorage keys:
 *   dwp.tom.sessionId — anonymous session id, generated once and reused
 *   for every message (including across reloads) so Tom can maintain
 *   conversation context server-side.
 */

import { useEffect, useRef, useState } from "react";

const SESSION_STORAGE_KEY = "dwp.tom.sessionId";
const TOM_SOURCE = "disney-wait-planner";

const HELPER_TEXT =
  "Ask about Disney attractions, dining, entertainment, wait times, park updates, and Disney news.";
const INFO_TEXT =
  "Tom Morrow is Disney Wait Planner's AI assistant, inspired by Disney's classic futuristic character of the same name. Ask Tom about Disney parks, attractions, dining, entertainment, wait times, and the latest Disney news.";

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

function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Reads (or creates + persists) the anonymous session id used to group this browser's messages. */
function getOrCreateSessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const created = generateId();
    localStorage.setItem(SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    // localStorage unavailable (private browsing, etc.) — fall back to a
    // per-request id rather than failing the chat entirely.
    return generateId();
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
    margin: 0 auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    height: calc(100vh - 96px);
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
    gap: 6px;
  }
  .tom-title {
    font-size: 20px;
    font-weight: 700;
    color: #111827;
    margin: 0;
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

  .tom-messages {
    flex: 1 1 auto;
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
  }
  .tom-bubble-row.user {
    justify-content: flex-end;
  }
  .tom-bubble-row.tom {
    justify-content: flex-start;
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
      height: calc(100vh - 80px);
    }
    .tom-bubble {
      max-width: 90%;
      font-size: 14px;
      padding: 9px 12px;
    }
    .tom-sources {
      max-width: 90%;
    }
    .tom-messages {
      gap: 10px;
    }
    .tom-info-tooltip {
      width: 220px;
    }
    .tom-empty {
      margin: 0;
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
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const messagesRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

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
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/tom/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          session_id: getOrCreateSessionId(),
          source: TOM_SOURCE,
        }),
      });

      if (res.status === 429) {
        setError("Tom is getting a lot of questions right now. Please wait a moment and try again.");
        return false;
      }

      if (!res.ok) {
        setError("Something went wrong. Please try again.");
        return false;
      }

      const data = await res.json();
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
      setError("Something went wrong. Please try again.");
      return false;
    } finally {
      setLoading(false);
    }
  }

  function submitQuestion(question: string) {
    setInput("");
    setMessages((prev) => [...prev, { id: generateId(), role: "user", text: question }]);
    void sendQuestion(question).then((ok) => {
      // Keep the failed question in the input box so it can be retried or edited.
      if (!ok) setInput(question);
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

  return (
    <>
      <style>{CHAT_CSS}</style>
      <div className="tom-page">
        <div className="tom-header">
          <div className="tom-title-row">
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
              </div>
            </div>
          </div>
          <p className="tom-helper">{HELPER_TEXT}</p>
        </div>

        <div className="tom-messages" ref={messagesRef} onScroll={handleMessagesScroll}>
          {messages.length === 0 && !loading && (
            <div className="tom-empty">
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
                <div className={`tom-bubble ${message.role}`}>
                  {message.role === "tom" ? linkifyText(message.text) : message.text}
                </div>
              </div>
              {message.sources && message.sources.length > 0 && (
                <div className="tom-sources" style={{ marginLeft: message.role === "tom" ? "2px" : "auto", textAlign: message.role === "tom" ? "left" : "right" }}>
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

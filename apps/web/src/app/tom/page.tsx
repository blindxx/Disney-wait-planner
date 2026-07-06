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

import { useState } from "react";

const SESSION_STORAGE_KEY = "dwp.tom.sessionId";
const TOM_SOURCE = "disney-wait-planner";

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
    max-width: 700px;
    margin: 0 auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    height: calc(100vh - 96px);
    min-height: 480px;
  }

  .tom-messages {
    flex: 1 1 auto;
    overflow-y: auto;
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

  .tom-sources {
    max-width: 85%;
    margin-top: 4px;
    font-size: 12px;
    color: #6b7280;
  }
  .tom-sources ul {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
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
    color: #9ca3af;
    font-size: 14px;
    padding: 40px 20px;
  }
`;

export default function TomChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendQuestion(question: string) {
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
        return;
      }

      if (!res.ok) {
        setError("Something went wrong. Please try again.");
        return;
      }

      const data = await res.json();
      const answer = typeof data?.answer === "string" ? data.answer : "";
      if (!answer) {
        setError("Something went wrong. Please try again.");
        return;
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
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { id: generateId(), role: "user", text: question }]);
    void sendQuestion(question);
  }

  return (
    <>
      <style>{CHAT_CSS}</style>
      <div className="tom-page">
        <h1 style={{ fontSize: "20px", fontWeight: 700, color: "#111827", marginBottom: "12px" }}>
          Ask Tom
        </h1>

        <div className="tom-messages">
          {messages.length === 0 && !loading && (
            <div className="tom-empty">Ask Tom anything about your Disney trip.</div>
          )}

          {messages.map((message) => (
            <div key={message.id}>
              <div className={`tom-bubble-row ${message.role}`}>
                <div className={`tom-bubble ${message.role}`}>{message.text}</div>
              </div>
              {message.sources && message.sources.length > 0 && (
                <div className="tom-sources" style={{ marginLeft: message.role === "tom" ? "2px" : "auto", textAlign: message.role === "tom" ? "left" : "right" }}>
                  Sources:
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

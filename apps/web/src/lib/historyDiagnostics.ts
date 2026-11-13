/**
 * historyDiagnostics.ts — TEMPORARY Phase 14.4.2 Vercel-Preview diagnostics for
 * history-assisted entertainment filtering. Delete this file and its two call
 * sites (entertainmentShowtimesService.ts, entertainmentAllService.ts, each
 * marked "history-diagnostics") once Preview verification is done.
 *
 * Contract:
 *  - ENABLED ONLY when `VERCEL_ENV === "preview"` (never production, never local).
 *  - One concise, aggregate summary per history decision; identical summaries are
 *    suppressed for HISTORY_DIAG_DEDUPE_MS so cached/polling requests don't repeat.
 *  - Built only from data the services already hold: it issues NO provider
 *    request and never re-fetches. Output is a whitelist of primitives — park,
 *    resort-local date, tier, windows, outcome, coverage counts, aggregate
 *    reason codes and counts. Never keys, headers, tokens, URLs, provider error
 *    text, entity ids/names or raw payloads.
 *  - No public endpoint, no client-side code.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import {
  buildParkHistoryEvidence,
  historySupportDecision,
  MIN_PUBLISHED_ENTITIES_TODAY,
  type HistoryRefCode,
  type HistoryRejectCode,
} from "./entertainmentHistory";
import type { HistoryFetchTrace } from "./entertainmentHistoryService";
import { countEntitiesActiveToday, type EntertainmentShowtimeEntry } from "./entertainmentShowtimes";
import { PARK_TO_RESORT } from "./parkMetadata";
import { getResortLocalDate } from "./resortTime";
import { getPartyNightState } from "./seasonalEvents";
import type { ThemeParksHistoryDaily, ThemeParksLive, ThemeParksResult } from "./themeParksApi";

export const HISTORY_DIAG_TAG = "[themeparks/history]";
export const HISTORY_DIAG_DEDUPE_MS = 10 * 60_000;

/** True only in a Vercel Preview deployment. `env` is injectable for tests. */
export function isHistoryDiagnosticsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV === "preview";
}

export interface HistoryDiagnosticSummary {
  park: ParkId;
  /** Resort-local date the decision was made for. */
  date: string;
  partyState: "party" | "not_party" | "unknown";
  /** True when a history request was needed and attempted; false = no entry needed history. */
  historyAttempted: boolean;
  /** Tier of the FIRST attempt; null when none was made. */
  tier: "authenticated" | "anonymous" | null;
  /** Non-secret key state: none (not configured/blank) | active | cooldown (refused recently) | unknown. */
  keyStatus: "none" | "active" | "cooldown" | "unknown";
  requestedDays: number[];
  /** Window length the provider ANSWERED with (the payload actually used), else null. */
  receivedDays: number | null;
  /** ok | fallback_7d (a 7-day retry was needed) | stale | paged | failed:<kind> | not_needed. */
  outcome: string;
  /** Provider payload complete (not paged). null when no payload. */
  windowComplete: boolean | null;
  coverage: { mode: "short" | "long" | null; usablePriorDays: number; anomalousDays: number };
  /** Park-level evidence accepted, or the aggregate rejection code. */
  evidence: "accepted" | HistoryRejectCode | "none";
  entries: number;
  /** Entries whose live data was clean and empty today so history could decide. */
  candidates: number;
  /** Entries hidden by history, by basis (generic = history, party = history_party). */
  hiddenByHistory: { generic: number; party: number; weekly: number };
  /** Entries hidden by the 14.4.1 forward horizon (context only). */
  hiddenByForwardHorizon: number;
  /** Candidates left visible, by FIRST failing gate (aggregate counts only). */
  keptVisible: Record<string, number>;
}

export interface HistoryDiagnosticInput {
  parkId: ParkId;
  instant: Date;
  live: ThemeParksResult<ThemeParksLive>;
  /** History used for the final normalization; null when none was needed/attempted. */
  history: ThemeParksResult<ThemeParksHistoryDaily> | null;
  trace?: HistoryFetchTrace;
  /** Final normalized entries (curated showtimes entries; All Entertainment passes its `showtime` records). */
  entries: EntertainmentShowtimeEntry[];
}

/** Pure: aggregate, whitelisted summary. Issues no requests. */
export function buildHistoryDiagnosticSummary(input: HistoryDiagnosticInput): HistoryDiagnosticSummary {
  const { parkId, instant, live, history, trace, entries } = input;
  const resort = PARK_TO_RESORT[parkId] as ResortId;
  const evidence = buildParkHistoryEvidence(parkId, resort, history, instant);
  const today = getResortLocalDate(resort, instant);
  const partyState = getPartyNightState(parkId, today);
  const attempts = trace?.attempts ?? [];
  const received = history?.ok ? Math.round((Date.parse(`${history.data.to}T00:00:00Z`) - Date.parse(`${history.data.from}T00:00:00Z`)) / 86_400_000) + 1 : null;
  let outcome = "not_needed";
  if (history) {
    const last = attempts[attempts.length - 1];
    outcome = history.ok
      ? history.meta.origin === "stale" ? "stale" : history.data.hasMore ? "paged" : attempts.length > 1 ? "fallback_7d" : "ok"
      : `failed:${history.error.kind}`;
    if (!history.ok && !last) outcome = `failed:${history.error.kind}`;
  }
  const hidden = { generic: 0, party: 0, weekly: 0 };
  let forward = 0;
  let candidates = 0;
  const kept: Record<string, number> = {};
  const liveData = live.ok ? live.data : null;
  const published = !!liveData && countEntitiesActiveToday(liveData, resort, today) >= MIN_PUBLISHED_ENTITIES_TODAY;
  for (const e of entries) {
    if (e.confirmedNoActivityToday) {
      if (e.inactivityBasis === "history") hidden.generic++;
      else if (e.inactivityBasis === "history_party") hidden.party++;
      else if (e.inactivityBasis === "history_weekly") hidden.weekly++;
      else forward++;
      continue;
    }
    if (!e.historyCandidate) continue;
    candidates++;
    let code: HistoryRefCode | "no_quorum" | "no_history" = "no_history";
    if (history && evidence) {
      if (!published) code = "no_quorum";
      else {
        code = "supported";
        for (const r of e.provider) {
          const d = historySupportDecision(evidence, r.entityId, partyState);
          if (d.basis === null) { code = d.code; break; }
        }
      }
    }
    kept[code] = (kept[code] ?? 0) + 1;
  }
  return {
    park: parkId,
    date: today,
    partyState,
    historyAttempted: history !== null,
    tier: attempts[0]?.tier ?? null,
    keyStatus: trace?.keyStatus ?? "unknown",
    requestedDays: attempts.map((a) => a.days),
    receivedDays: received,
    outcome,
    windowComplete: history?.ok ? !history.data.hasMore : null,
    coverage: { mode: evidence?.mode ?? null, usablePriorDays: evidence?.usablePriorDays.length ?? 0, anomalousDays: evidence?.anomalousDays.length ?? 0 },
    evidence: !evidence ? "none" : evidence.usable ? "accepted" : (evidence.reasonCode ?? "none"),
    entries: entries.length,
    candidates,
    hiddenByHistory: hidden,
    hiddenByForwardHorizon: forward,
    keptVisible: kept,
  };
}

export type HistoryDiagSink = (tag: string, summary: HistoryDiagnosticSummary) => void;

const lastLogged = new Map<string, number>();

/**
 * Preview-only: log one summary line unless an identical one was logged within
 * the dedupe window. Returns whether it logged. Never throws.
 */
export function logHistoryDiagnostics(
  input: HistoryDiagnosticInput,
  opts: { env?: Record<string, string | undefined>; sink?: HistoryDiagSink; nowMs?: number } = {},
): boolean {
  try {
    if (!isHistoryDiagnosticsEnabled(opts.env)) return false; // production/local: not even built
    const summary = buildHistoryDiagnosticSummary(input);
    const key = JSON.stringify(summary);
    const now = opts.nowMs ?? Date.now();
    const prev = lastLogged.get(key);
    if (prev !== undefined && now - prev < HISTORY_DIAG_DEDUPE_MS) return false;
    lastLogged.set(key, now);
    if (lastLogged.size > 64) { const oldest = lastLogged.keys().next().value; if (oldest !== undefined) lastLogged.delete(oldest); }
    (opts.sink ?? ((tag, s) => console.info(tag, JSON.stringify(s))))(HISTORY_DIAG_TAG, summary);
    return true;
  } catch {
    return false; // diagnostics must never affect a response
  }
}

/** Test hook: forget dedupe state. */
export function _resetHistoryDiagnosticsDedupe(): void {
  lastLogged.clear();
}

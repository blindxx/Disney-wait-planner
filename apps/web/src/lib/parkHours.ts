/**
 * parkHours.ts — Phase 12.4 normalized ThemeParks.wiki park hours.
 *
 * The single boundary between ThemeParks schedule data and any consumer that
 * wants "what are today's park hours / when does the park next open".
 * Consumers (Wait Times today, Today/Tom later) must use this output and never
 * interpret raw provider schedule entries themselves. Pure and client-safe
 * (type-only imports from the server-only ThemeParks client); the server fetch
 * orchestration lives in parkHoursService.ts.
 *
 * Provider schedule semantics (observed against the live API, Oct 2026):
 *   - Entries are `{date, type, openingTime, closingTime, description?}` with
 *     offset-aware timestamps; `date` is the resort-local calendar date.
 *   - `OPERATING` is the park's normal operating window (one per open day).
 *   - Early Entry arrives as `TICKETED_EVENT` with description "Early Entry";
 *     after-hours events as `TICKETED_EVENT` with description "Special
 *     Ticketed Event". `type` alone never identifies either, so no meaning is
 *     assigned from `type`: only the provider's own `description`, verbatim.
 *   - There is NO explicit "closed" entry type. A closed day is simply absent.
 *   - The default (non-monthly) request covers today through roughly the end
 *     of the current month; monthly requests cover a calendar month.
 *
 * Normalized `status`:
 *   hours        ≥1 OPERATING window dated today (resort-local)
 *   closed       provider data safely establishes closure (see below)
 *   unknown      valid response, but no safely interpretable operating window
 *                (`unknownReason` says why) — NEVER shown as Closed
 *   unavailable  provider failed / no usable data
 *
 * Closed is derived only when ALL hold (absence of OPERATING alone is never
 * enough): provider data is not stale and was fetched on today's resort-local
 * date; no entries were dropped as malformed; the schedule's zone (if given)
 * is the resort's zone; there is no entry of ANY type dated today; no known
 * OPERATING window (e.g. yesterday's past-midnight close) contains `now`; and
 * known OPERATING entries exist both before AND after today (the provider's
 * calendar brackets the date, so the gap is a gap, not missing coverage).
 * Consequently a Closed result always has a next OPERATING window; closed
 * days the provider data cannot bracket stay `unknown` (shown "Unavailable").
 *
 * Nothing is ever fabricated or extrapolated: windows are exactly what the
 * provider supplied; the next opening is the earliest provider OPERATING
 * entry after today, never inferred from patterns. Provider `lastUpdated` is
 * carried as metadata only — never a freshness/trust test; stale-if-error
 * (`stale`) is flagged, never silent.
 *
 * DEV checks (run manually; returns failing labels): runDevParkHoursCases().
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { PARK_TO_RESORT } from "./parkMetadata";
import {
  RESORT_TIME_ZONES,
  addDaysToLocalDate,
  formatLocalDateLabel,
  formatResortLocalTime,
  getResortLocalDate,
} from "./resortTime";
import type {
  ThemeParksError,
  ThemeParksResult,
  ThemeParksSchedule,
  ThemeParksScheduleEntry,
} from "./themeParksApi";

// ============================================
// TYPES
// ============================================

export type ParkHoursStatus = "hours" | "closed" | "unknown" | "unavailable";

export type ParkHoursUnknownReason =
  /** Valid response with no schedule entries at all. */
  | "empty_schedule"
  /** Entries exist for today but none is OPERATING. */
  | "only_non_operating"
  /** Nothing dated today, but closure cannot be safely established. */
  | "closure_unverified"
  /** Schedule's timezone is not the resort's; dates can't be trusted. */
  | "timezone_mismatch";

export interface ParkHoursWindow {
  /** Provider's resort-local calendar date. */
  date: string;
  /** Provider schedule type, verbatim (OPERATING | TICKETED_EVENT | EXTRA_HOURS | ...). */
  type: string;
  /** Provider description, verbatim (the only source of user-facing labels). */
  description: string | null;
  /** Offset-aware ISO strings, verbatim. */
  openingTime: string;
  closingTime: string;
  /** Resort-local rendering of the instants, e.g. "9:00 AM". */
  opens: string;
  closes: string;
  /** Provider lastUpdated — maintenance metadata only, NOT a trust test. */
  lastUpdated: string | null;
}

export interface ParkNextOpening {
  date: string;
  relation: "tomorrow" | "later";
  /** All OPERATING windows the provider lists for that date, ascending. */
  windows: ParkHoursWindow[];
}

export interface ParkHoursMeta {
  origin: "network" | "cache" | "revalidated" | "stale";
  /** Oldest epoch ms among the provider responses used. */
  fetchedAt: number;
  staleReason?: ThemeParksError;
}

export interface ParkHours {
  parkId: ParkId;
  resort: ResortId;
  /** Resort-local calendar date the result was computed for. */
  localDate: string;
  /** ISO instant the result was computed against. */
  asOf: string;
  status: ParkHoursStatus;
  unknownReason: ParkHoursUnknownReason | null;
  /** Today's OPERATING windows (primary park hours), ascending. */
  operating: ParkHoursWindow[];
  /** Today's other provider windows (any non-OPERATING type), preserved verbatim, ascending. */
  additional: ParkHoursWindow[];
  /** Earliest provider OPERATING date after today, when the fetched data has one. */
  nextOpening: ParkNextOpening | null;
  /** True iff any provider response used was stale-if-error. */
  stale: boolean;
  meta: ParkHoursMeta | null;
  /** Typed provider failure when there was no usable data; null otherwise. */
  error: ThemeParksError | null;
  /** Malformed schedule entries the ThemeParks validation discarded. */
  droppedEntries: number;
}

/** Provider results feeding one normalization (follow-ups only exist when the service needed them). */
export interface ParkHoursSources {
  /** Default upcoming-window schedule. */
  primary: ThemeParksResult<ThemeParksSchedule>;
  /** Current resort-local month (closure bracketing); undefined = not requested. */
  currentMonth?: ThemeParksResult<ThemeParksSchedule>;
  /** Following resort-local month (next opening past the current month); undefined = not requested. */
  nextMonth?: ThemeParksResult<ThemeParksSchedule>;
}

// ============================================
// NORMALIZATION (pure)
// ============================================

function resortOf(parkId: ParkId): ResortId {
  return PARK_TO_RESORT[parkId] as ResortId;
}

const byOpening = (a: ParkHoursWindow, b: ParkHoursWindow) =>
  Date.parse(a.openingTime) - Date.parse(b.openingTime) ||
  Date.parse(a.closingTime) - Date.parse(b.closingTime);

function toWindow(resort: ResortId, e: ThemeParksScheduleEntry): ParkHoursWindow {
  return {
    date: e.date,
    type: e.type,
    description: e.description,
    openingTime: e.openingTime,
    closingTime: e.closingTime,
    opens: formatResortLocalTime(resort, new Date(e.openingTime)),
    closes: formatResortLocalTime(resort, new Date(e.closingTime)),
    lastUpdated: e.lastUpdated,
  };
}

function windowKey(w: ParkHoursWindow): string {
  return `${w.date}|${w.type}|${w.openingTime}|${w.closingTime}|${w.description ?? ""}`;
}

/** Year/month of the resort-local month after `localDate` (December rolls the year). */
export function nextResortMonth(localDate: string): { year: number; month: number } {
  const [y, m] = localDate.split("-").map(Number);
  return m === 12 ? { year: y + 1, month: 1 } : { year: y, month: m + 1 };
}

export function currentResortMonth(localDate: string): { year: number; month: number } {
  const [y, m] = localDate.split("-").map(Number);
  return { year: y, month: m };
}

function emptyParkHours(parkId: ParkId, instant: Date): ParkHours {
  const resort = resortOf(parkId);
  return {
    parkId,
    resort,
    localDate: getResortLocalDate(resort, instant),
    asOf: instant.toISOString(),
    status: "unavailable",
    unknownReason: null,
    operating: [],
    additional: [],
    nextOpening: null,
    stale: false,
    meta: null,
    error: null,
    droppedEntries: 0,
  };
}

/**
 * True when the primary (default-window) schedule is valid but has no entry
 * of any type dated today — the only case where the service needs follow-up
 * month requests to decide closed vs. unknown.
 */
export function isClosureCandidate(
  parkId: ParkId,
  primary: ThemeParksResult<ThemeParksSchedule>,
  instant: Date,
): boolean {
  if (!primary.ok) return false;
  const localDate = getResortLocalDate(resortOf(parkId), instant);
  return !primary.data.entries.some((e) => e.date === localDate);
}

/**
 * Pure: turn provider schedule result(s) for a park into the normalized
 * contract. `instant` is "now".
 */
export function normalizeParkHours(
  parkId: ParkId,
  src: ParkHoursSources,
  instant: Date = new Date(),
): ParkHours {
  const base = emptyParkHours(parkId, instant);
  const { resort, localDate } = base;
  if (!src.primary.ok) return { ...base, error: src.primary.error };

  // Follow-up results that failed simply contribute nothing (see below).
  const used = [src.primary, src.currentMonth, src.nextMonth].filter(
    (r): r is Extract<ThemeParksResult<ThemeParksSchedule>, { ok: true }> => !!r && r.ok,
  );
  const stale = used.find((r) => r.meta.origin === "stale");
  const meta: ParkHoursMeta = {
    origin: stale ? "stale" : src.primary.meta.origin,
    fetchedAt: Math.min(...used.map((r) => r.meta.fetchedAt)),
    ...(stale?.meta.staleReason ? { staleReason: stale.meta.staleReason } : {}),
  };
  const common = { ...base, stale: !!stale, meta };

  if (used.some((r) => r.data.timeZone !== null && r.data.timeZone !== RESORT_TIME_ZONES[resort])) {
    return { ...common, status: "unknown", unknownReason: "timezone_mismatch" };
  }

  const dropped = used.reduce((n, r) => n + r.data.droppedEntries, 0);
  const seen = new Set<string>();
  const windows: ParkHoursWindow[] = [];
  for (const r of used) {
    for (const e of r.data.entries) {
      const w = toWindow(resort, e);
      const k = windowKey(w);
      if (seen.has(k)) continue;
      seen.add(k);
      windows.push(w);
    }
  }
  const nowMs = instant.getTime();
  const operatingAll = windows.filter((w) => w.type === "OPERATING").sort(byOpening);
  const today = windows.filter((w) => w.date === localDate).sort(byOpening);
  const operating = today.filter((w) => w.type === "OPERATING");
  const additional = today.filter((w) => w.type !== "OPERATING");

  // Earliest provider OPERATING date after today (all that date's windows).
  const nextDate = operatingAll.find((w) => w.date > localDate)?.date ?? null;
  const tomorrow = addDaysToLocalDate(localDate, 1);
  const nextOpening: ParkNextOpening | null = nextDate
    ? {
        date: nextDate,
        relation: nextDate === tomorrow ? "tomorrow" : "later",
        windows: operatingAll.filter((w) => w.date === nextDate),
      }
    : null;
  const result = { ...common, droppedEntries: dropped, operating, additional, nextOpening };

  if (operating.length > 0) return { ...result, status: "hours" };
  if (windows.length === 0) return { ...result, status: "unknown", unknownReason: "empty_schedule" };
  if (today.length > 0) return { ...result, status: "unknown", unknownReason: "only_non_operating" };

  // Nothing dated today. Closed only when the provider data safely establishes it.
  const fetchedToday = used.every((r) => getResortLocalDate(resort, new Date(r.meta.fetchedAt)) === localDate);
  const openNow = operatingAll.some((w) => Date.parse(w.openingTime) <= nowMs && nowMs < Date.parse(w.closingTime));
  const bracketed = operatingAll.some((w) => w.date < localDate) && operatingAll.some((w) => w.date > localDate);
  if (!stale && fetchedToday && dropped === 0 && !openNow && bracketed) {
    return { ...result, status: "closed" };
  }
  return { ...result, status: "unknown", unknownReason: "closure_unverified" };
}

// ============================================
// DISPLAY (pure, client-safe)
// ============================================

/** "9:00 AM–10:00 PM" */
export function formatParkHoursRange(w: Pick<ParkHoursWindow, "opens" | "closes">): string {
  return `${w.opens}–${w.closes}`;
}

/** Provider types whose own `description` may label a compact additional window. */
const LABELLED_ADDITIONAL_TYPES: readonly string[] = ["EXTRA_HOURS", "TICKETED_EVENT"];

export interface ParkHoursDisplay {
  /** "Park hours: 9:00 AM–10:00 PM" | "Park hours: Closed" | "Park hours: Unavailable". */
  headline: string;
  /** Closed only: "Tomorrow: …" / "Next opening: Sat, Oct 3 · …". */
  nextLine: string | null;
  /** Compact additional windows, labelled with the provider's own description. */
  extras: string[];
  /** True when ThemeParks.wiki schedule data is being presented (attribution owed). */
  presentsProviderData: boolean;
  stale: boolean;
}

export function describeParkHours(data: ParkHours): ParkHoursDisplay {
  if (data.status === "hours") {
    const seen = new Set<string>();
    const extras: string[] = [];
    for (const w of data.additional) {
      if (!w.description || !LABELLED_ADDITIONAL_TYPES.includes(w.type)) continue;
      const text = `${w.description}: ${formatParkHoursRange(w)}`;
      if (!seen.has(text)) { seen.add(text); extras.push(text); }
    }
    return {
      headline: `Park hours: ${data.operating.map(formatParkHoursRange).join(", ")}`,
      nextLine: null,
      extras,
      presentsProviderData: true,
      stale: data.stale,
    };
  }
  if (data.status === "closed") {
    let nextLine: string | null = null;
    const n = data.nextOpening;
    if (n && n.windows.length > 0) {
      const ranges = n.windows.map(formatParkHoursRange).join(", ");
      const label = n.relation === "tomorrow" ? "Tomorrow" : formatLocalDateLabel(n.date);
      nextLine = n.relation === "tomorrow" ? `Tomorrow: ${ranges}` : label ? `Next opening: ${label} · ${ranges}` : null;
    }
    return { headline: "Park hours: Closed", nextLine, extras: [], presentsProviderData: true, stale: data.stale };
  }
  return { headline: "Park hours: Unavailable", nextLine: null, extras: [], presentsProviderData: false, stale: false };
}

function unavailablePark(parkId: ParkId, instant: Date, message: string): ParkHours {
  return normalizeParkHours(parkId, { primary: { ok: false, error: { kind: "network", message } } }, instant);
}

const STATUSES: readonly string[] = ["hours", "closed", "unknown", "unavailable"];

/**
 * Browser-side: turn a fetched /api/park-hours body into display state.
 * `body` is the parsed JSON, or null when the request failed / was non-2xx /
 * unparseable. Failure (or a body for another park, or not the contract shape)
 * degrades to the normalized "unavailable" state — earlier hours are never kept.
 */
export function resolveParkHoursResponse(parkId: ParkId, body: unknown, instant: Date = new Date()): ParkHours {
  const d = body as Partial<ParkHours> | null;
  if (
    !d || typeof d !== "object" || d.parkId !== parkId || typeof d.localDate !== "string" ||
    typeof d.status !== "string" || !STATUSES.includes(d.status) ||
    !Array.isArray(d.operating) || !Array.isArray(d.additional)
  ) {
    return unavailablePark(parkId, instant, "Park hours request failed");
  }
  return d as ParkHours;
}

/**
 * Display-time guard: hours computed for a previous resort-local day (page left
 * open across midnight, refreshes failing) are never shown as today's.
 */
export function parkHoursForDisplay(data: ParkHours | null, instant: Date = new Date()): ParkHours | null {
  if (!data) return null;
  if (data.localDate === getResortLocalDate(data.resort, instant)) return data;
  return unavailablePark(data.parkId, instant, "Park hours are for a previous day");
}

// ============================================
// DEV CASES
// ============================================

/**
 * Run manually from Node (e.g. via tsx), like the other DEV_* helpers:
 *   import { runDevParkHoursCases } from "./parkHours";
 *   console.log(runDevParkHoursCases()); // [] = all pass
 */
export function runDevParkHoursCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };

  const MK_ID = "75ea578a-adc8-4116-a54d-dccb60765ef9";
  const DL_ID = "7340550b-c14d-4def-80bb-acdb51d49a66";
  type E = ThemeParksScheduleEntry;
  const op = (date: string, open: string, close: string, off = "-04:00", closeDate = date): E => ({
    date, type: "OPERATING", openingTime: `${date}T${open}:00${off}`, closingTime: `${closeDate}T${close}:00${off}`, description: null, lastUpdated: null,
  });
  const extra = (date: string, type: string, description: string | null, open: string, close: string, off = "-04:00"): E => ({
    date, type, openingTime: `${date}T${open}:00${off}`, closingTime: `${date}T${close}:00${off}`, description, lastUpdated: "2026-09-30T04:01:56.507Z",
  });
  const sched = (entries: E[], tz: string | null = "America/New_York", droppedEntries = 0, id = MK_ID): ThemeParksSchedule =>
    ({ entityId: id, name: "Park", timeZone: tz, entries, parks: [], droppedEntries });
  const ok = (s: ThemeParksSchedule, fetchedAt: number, origin: "network" | "cache" | "stale" = "network"): ThemeParksResult<ThemeParksSchedule> =>
    ({ ok: true, data: s, meta: { origin, fetchedAt, etag: null, ...(origin === "stale" ? { staleReason: { kind: "network" as const, message: "x" } } : {}) } });
  const fail: ThemeParksResult<ThemeParksSchedule> = { ok: false, error: { kind: "timeout", message: "t" } };
  const T = (iso: string) => new Date(iso);

  // ---- normal OPERATING hours (WDW, EDT)
  const NOW = T("2026-10-01T15:00:00Z"); // 11:00 AM EDT Oct 1
  let r = normalizeParkHours("mk", { primary: ok(sched([op("2026-10-01", "09:00", "22:00"), op("2026-10-02", "09:00", "22:00")]), NOW.getTime()) }, NOW);
  check("hours: status", r.status === "hours" && r.operating.length === 1);
  check("hours: headline", describeParkHours(r).headline === "Park hours: 9:00 AM–10:00 PM");
  check("hours: nextOpening carried", r.nextOpening?.relation === "tomorrow" && r.nextOpening.date === "2026-10-02");
  check("hours: provider timestamps verbatim", r.operating[0].openingTime === "2026-10-01T09:00:00-04:00");

  // ---- DLR (PDT) resort-local rendering, never the browser/server zone
  const DL_NOW = T("2026-10-01T18:00:00Z"); // 11:00 AM PDT
  r = normalizeParkHours("disneyland", { primary: ok(sched([op("2026-10-01", "08:00", "23:00", "-07:00")], "America/Los_Angeles", 0, DL_ID), DL_NOW.getTime()) }, DL_NOW);
  check("DLR: hours in PDT", describeParkHours(r).headline === "Park hours: 8:00 AM–11:00 PM");
  // Winter offsets render the same local clock time
  const WIN = T("2026-01-15T17:00:00Z");
  r = normalizeParkHours("mk", { primary: ok(sched([op("2026-01-15", "09:00", "21:00", "-05:00")]), WIN.getTime()) }, WIN);
  check("WDW winter EST hours", describeParkHours(r).headline === "Park hours: 9:00 AM–9:00 PM");

  // ---- resort-local date boundaries: 05:00Z Oct 2 = WDW Oct 2 1:00 AM, DLR Oct 1 10:00 PM
  const B = T("2026-10-02T05:00:00Z");
  r = normalizeParkHours("mk", { primary: ok(sched([op("2026-10-01", "09:00", "22:00"), op("2026-10-02", "09:00", "22:00")]), B.getTime()) }, B);
  check("boundary WDW: today is Oct 2", r.localDate === "2026-10-02" && r.operating[0].date === "2026-10-02");
  r = normalizeParkHours("disneyland", { primary: ok(sched([op("2026-10-01", "08:00", "23:00", "-07:00"), op("2026-10-02", "08:00", "23:00", "-07:00")], "America/Los_Angeles", 0, DL_ID), B.getTime()) }, B);
  check("boundary DLR: same instant is still Oct 1", r.localDate === "2026-10-01" && r.operating[0].date === "2026-10-01");
  check("boundary DLR: next is tomorrow Oct 2", r.nextOpening?.date === "2026-10-02" && r.nextOpening.relation === "tomorrow");

  // ---- multiple schedule types / windows preserved
  const multi = sched([
    extra("2026-10-01", "TICKETED_EVENT", "Early Entry", "08:30", "09:00"),
    op("2026-10-01", "09:00", "18:00"),
    extra("2026-10-01", "TICKETED_EVENT", "Special Ticketed Event", "19:00", "23:59"),
    extra("2026-10-01", "TICKETED_EVENT", null, "23:00", "23:30"),
    extra("2026-10-01", "INFORMATIONAL", "Fireworks", "21:00", "21:30"),
    extra("2026-10-01", "EXTRA_HOURS", "Extended Evening", "18:00", "20:00"),
  ]);
  r = normalizeParkHours("mk", { primary: ok(multi, NOW.getTime()) }, NOW);
  const d = describeParkHours(r);
  check("multi: OPERATING is the headline", d.headline === "Park hours: 9:00 AM–6:00 PM");
  check("multi: all additional windows preserved", r.additional.length === 5 && r.additional.some((w) => w.type === "INFORMATIONAL"));
  check("multi: provider-labelled extras only", d.extras.length === 3 && d.extras[0] === "Early Entry: 8:30 AM–9:00 AM" && !d.extras.some((x) => x.includes("Fireworks")));
  check("multi: unlabelled TICKETED_EVENT not guessed", !d.extras.some((x) => x.includes("11:00 PM–11:30 PM")));
  r = normalizeParkHours("mk", { primary: ok(sched([extra("2026-10-01", "TICKETED_EVENT", "Early Entry", "08:30", "09:00"), op("2026-10-01", "09:00", "17:00")]), NOW.getTime()) }, NOW);
  check("multi: Early Entry never becomes the headline", describeParkHours(r).headline === "Park hours: 9:00 AM–5:00 PM");
  r = normalizeParkHours("mk", { primary: ok(sched([op("2026-10-01", "09:00", "13:00"), op("2026-10-01", "17:00", "22:00"), op("2026-10-01", "09:00", "13:00")]), NOW.getTime()) }, NOW);
  check("multi: two OPERATING windows both shown, duplicates collapsed", describeParkHours(r).headline === "Park hours: 9:00 AM–1:00 PM, 5:00 PM–10:00 PM");
  r = normalizeParkHours("mk", { primary: ok(sched([op("2026-10-01", "09:00", "23:00", "-04:00", "2026-10-02")]), NOW.getTime()) }, NOW);
  check("past-midnight close keeps its own date", r.operating[0].closes === "11:00 PM");

  // ---- closed: needs bracket (month) data. Today Oct 15 has no entries, Oct 14 and 16 do.
  const CN = T("2026-10-15T15:00:00Z");
  const winOct = sched([op("2026-10-16", "09:00", "22:00"), op("2026-10-17", "09:00", "22:00")]);
  const monthOct = sched([op("2026-10-13", "09:00", "22:00"), op("2026-10-14", "09:00", "22:00"), op("2026-10-16", "09:00", "22:00")]);
  check("candidate: today absent → follow-up needed", isClosureCandidate("mk", ok(winOct, CN.getTime()), CN));
  check("candidate: today present → none", !isClosureCandidate("mk", ok(sched([op("2026-10-15", "09:00", "22:00")]), CN.getTime()), CN));
  r = normalizeParkHours("mk", { primary: ok(winOct, CN.getTime()), currentMonth: ok(monthOct, CN.getTime()) }, CN);
  check("closed: bracketed gap", r.status === "closed" && describeParkHours(r).headline === "Park hours: Closed");
  check("closed + next day → Tomorrow:", describeParkHours(r).nextLine === "Tomorrow: 9:00 AM–10:00 PM");
  // later-only case (no Oct 16/17 entries):
  const monthLater = sched([op("2026-10-13", "09:00", "22:00"), op("2026-10-18", "09:00", "22:00")]);
  r = normalizeParkHours("mk", { primary: ok(sched([op("2026-10-18", "09:00", "22:00")]), CN.getTime()), currentMonth: ok(monthLater, CN.getTime()) }, CN);
  check("closed + later → Next opening: Sun, Oct 18", describeParkHours(r).nextLine === "Next opening: Sun, Oct 18 · 9:00 AM–10:00 PM");
  check("closed: relation later", r.nextOpening?.relation === "later");

  // ---- closed without any trustworthy future window shows only Closed
  // nothing after today anywhere → closure can't be bracketed, so it is NOT claimed:
  const noFuture = sched([op("2026-10-13", "09:00", "22:00"), op("2026-10-14", "09:00", "22:00")]);
  r = normalizeParkHours("mk", { primary: ok(sched([]), CN.getTime()), currentMonth: ok(noFuture, CN.getTime()) }, CN);
  check("no future + no bracket after → NOT closed (unknown)", r.status === "unknown" && r.unknownReason === "closure_unverified");

  // ---- month boundary: Oct 31 closed, next opening Nov 1 (tomorrow) / Nov 3 (later); Dec → Jan year roll
  const M = T("2026-10-31T15:00:00Z");
  const octEnd = sched([op("2026-10-29", "09:00", "22:00"), op("2026-10-30", "09:00", "22:00")]);
  const nov = sched([op("2026-11-01", "09:00", "22:00", "-05:00"), op("2026-11-02", "09:00", "22:00", "-05:00")], "America/New_York");
  // Need an after-today OPERATING to bracket: provided by the next-month result.
  r = normalizeParkHours("mk", { primary: ok(sched([]), M.getTime()), currentMonth: ok(octEnd, M.getTime()), nextMonth: ok(nov, M.getTime()) }, M);
  check("month boundary: Oct 31 closed → Tomorrow: (Nov 1)", r.status === "closed" && r.nextOpening?.date === "2026-11-01" && describeParkHours(r).nextLine === "Tomorrow: 9:00 AM–10:00 PM");
  r = normalizeParkHours("mk", { primary: ok(sched([]), M.getTime()), currentMonth: ok(octEnd, M.getTime()), nextMonth: ok(sched([op("2026-11-03", "09:00", "22:00", "-05:00")]), M.getTime()) }, M);
  check("month boundary: later across months → Next opening: Tue, Nov 3", describeParkHours(r).nextLine === "Next opening: Tue, Nov 3 · 9:00 AM–10:00 PM");
  r = normalizeParkHours("mk", { primary: ok(sched([]), M.getTime()), currentMonth: ok(octEnd, M.getTime()), nextMonth: fail }, M);
  check("month boundary: next-month failure → closure not claimed (no bracket after)", r.status === "unknown");
  check("nextResortMonth: Oct→Nov, Dec→Jan next year", nextResortMonth("2026-10-31").month === 11 && nextResortMonth("2026-12-31").year === 2027 && nextResortMonth("2026-12-31").month === 1);
  check("addDays: Dec 31 → Jan 1", addDaysToLocalDate("2026-12-31", 1) === "2027-01-01" && addDaysToLocalDate("2028-02-28", 1) === "2028-02-29");
  const DEC = T("2026-12-31T15:00:00Z");
  r = normalizeParkHours("mk", { primary: ok(sched([]), DEC.getTime()), currentMonth: ok(sched([op("2026-12-30", "09:00", "22:00")], "America/New_York"), DEC.getTime()), nextMonth: ok(sched([op("2027-01-01", "09:00", "22:00")]), DEC.getTime()) }, DEC);
  check("year boundary: Dec 31 closed → Tomorrow: Jan 1", r.nextOpening?.relation === "tomorrow" && r.nextOpening.date === "2027-01-01");
  // closed + next-month lookup failed after a bracket from earlier data → closed w/o next, flagged
  r = normalizeParkHours("mk", { primary: ok(sched([op("2026-11-02", "09:00", "22:00", "-05:00")]), M.getTime()), currentMonth: ok(octEnd, M.getTime()), nextMonth: fail }, M);
  check("closed, nextMonth failed but later window known", r.status === "closed" && r.nextOpening?.date === "2026-11-02");
  r = normalizeParkHours("mk", { primary: ok(sched([op("2026-11-05", "09:00", "22:00", "-05:00")]), M.getTime()), currentMonth: ok(octEnd, M.getTime()) }, M);
  check("closed without next lookup keeps Closed + next from data", describeParkHours(r).nextLine === "Next opening: Thu, Nov 5 · 9:00 AM–10:00 PM");
  check("closed always carries a next window (bracketing needs a later OPERATING entry)", r.status === "closed" && r.nextOpening !== null);

  // ---- unknown vs closed vs unavailable; no false Closed inference
  r = normalizeParkHours("mk", { primary: ok(sched([]), NOW.getTime()) }, NOW);
  check("valid-empty → unknown/empty_schedule, not Closed", r.status === "unknown" && r.unknownReason === "empty_schedule" && describeParkHours(r).headline === "Park hours: Unavailable");
  r = normalizeParkHours("mk", { primary: ok(sched([extra("2026-10-01", "TICKETED_EVENT", "Early Entry", "08:30", "09:00")]), NOW.getTime()) }, NOW);
  check("only non-OPERATING today → unknown, not Closed", r.status === "unknown" && r.unknownReason === "only_non_operating" && r.additional.length === 1);
  r = normalizeParkHours("mk", { primary: ok(sched([op("2026-10-02", "09:00", "22:00")]), NOW.getTime()) }, NOW);
  check("today absent, no bracket → unknown (absence ≠ closed)", r.status === "unknown" && r.unknownReason === "closure_unverified");
  r = normalizeParkHours("mk", { primary: ok(winOct, CN.getTime()), currentMonth: fail }, CN);
  check("month follow-up failure → unknown, not Closed", r.status === "unknown");
  r = normalizeParkHours("mk", { primary: ok(winOct, CN.getTime()), currentMonth: ok(monthOct, CN.getTime(), "stale") }, CN);
  check("stale data never establishes Closed", r.status === "unknown" && r.stale);
  r = normalizeParkHours("mk", { primary: ok(winOct, CN.getTime()), currentMonth: ok(sched(monthOct.entries, "America/New_York", 1), CN.getTime()) }, CN);
  check("dropped malformed entries block Closed", r.status === "unknown");
  r = normalizeParkHours("mk", { primary: ok(winOct, CN.getTime() - 24 * 3600_000), currentMonth: ok(monthOct, CN.getTime()) }, CN);
  check("payload fetched on a previous local day cannot establish Closed", r.status === "unknown");
  r = normalizeParkHours("mk", { primary: ok(sched(winOct.entries, "Europe/London"), CN.getTime()), currentMonth: ok(monthOct, CN.getTime()) }, CN);
  check("zone mismatch → unknown/timezone_mismatch", r.status === "unknown" && r.unknownReason === "timezone_mismatch");
  // past-midnight window from yesterday containing now ⇒ park is open, never Closed
  const AM = T("2026-10-15T04:30:00Z"); // 12:30 AM EDT Oct 15
  r = normalizeParkHours("mk", {
    primary: ok(sched([op("2026-10-16", "09:00", "22:00")]), AM.getTime()),
    currentMonth: ok(sched([op("2026-10-14", "09:00", "02:00", "-04:00", "2026-10-15"), op("2026-10-16", "09:00", "22:00")]), AM.getTime()),
  }, AM);
  check("open past midnight from yesterday's window ≠ Closed", r.status === "unknown");
  r = normalizeParkHours("mk", { primary: fail }, NOW);
  check("failure → unavailable + typed error", r.status === "unavailable" && r.error?.kind === "timeout" && describeParkHours(r).headline === "Park hours: Unavailable" && !describeParkHours(r).presentsProviderData);

  // ---- stale (hours still shown, flagged; lastUpdated not a trust test)
  r = normalizeParkHours("mk", { primary: ok(sched([{ ...op("2026-10-01", "09:00", "22:00"), lastUpdated: "2020-01-01T00:00:00Z" }]), NOW.getTime(), "stale") }, NOW);
  check("stale: hours flagged, not hidden", r.status === "hours" && r.stale && r.meta?.origin === "stale" && describeParkHours(r).stale);
  r = normalizeParkHours("mk", { primary: ok(sched([{ ...op("2026-10-01", "09:00", "22:00"), lastUpdated: "2020-01-01T00:00:00Z" }]), NOW.getTime()) }, NOW);
  check("old lastUpdated alone does not make data stale/untrusted", r.status === "hours" && !r.stale);

  // ---- display guards
  const fresh = normalizeParkHours("mk", { primary: ok(sched([op("2026-10-01", "09:00", "22:00")]), NOW.getTime()) }, NOW);
  check("display: same day passes through", parkHoursForDisplay(fresh, T("2026-10-01T20:00:00Z")) === fresh);
  check("display: next resort-local day degrades to unavailable", parkHoursForDisplay(fresh, T("2026-10-02T05:00:00Z"))?.status === "unavailable");
  check("display: DLR same instant still same day", parkHoursForDisplay(normalizeParkHours("disneyland", { primary: ok(sched([op("2026-10-01", "08:00", "23:00", "-07:00")], "America/Los_Angeles", 0, DL_ID), DL_NOW.getTime()) }, DL_NOW), T("2026-10-02T05:00:00Z"))?.status === "hours");
  check("resolve: null body → unavailable", resolveParkHoursResponse("mk", null).status === "unavailable");
  check("resolve: wrong park → unavailable", resolveParkHoursResponse("epcot", JSON.parse(JSON.stringify(fresh))).status === "unavailable");
  check("resolve: garbage shape → unavailable", resolveParkHoursResponse("mk", { parkId: "mk", localDate: "2026-10-01", status: "weird", operating: [], additional: [] }).status === "unavailable");
  check("resolve: valid round-trips", resolveParkHoursResponse("mk", JSON.parse(JSON.stringify(fresh))).status === "hours");
  check("display: invalid date label → no Next opening", formatLocalDateLabel("2026-02-30") === null);

  return failures;
}

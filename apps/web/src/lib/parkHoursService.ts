/**
 * parkHoursService.ts — server-side fetch for Phase 12.4 park hours. Calls the
 * shared ThemeParks client's getSchedule() for the park's configured UUID and
 * hands the result to the pure normalizer in parkHours.ts. Server-only (the
 * ThemeParks client is); the browser reaches it via /api/park-hours.
 *
 * Provider calls (all through the shared client, whose 15 min schedule cache
 * absorbs repeats): exactly ONE default-window request in the normal case.
 * Follow-up monthly requests happen only when the park has no entry of any
 * type dated today (a potential closure, which needs the provider calendar
 * to bracket the date): the current resort-local month, and — only if that
 * still shows no later OPERATING window — the following month. Month and year
 * boundaries come from the resort-local date, never the server clock zone.
 */

import type { ParkId } from "@disney-wait-planner/shared";
import { PARK_TO_RESORT } from "./parkMetadata";
import { getResortLocalDate } from "./resortTime";
import {
  currentResortMonth,
  isClosureCandidate,
  nextResortMonth,
  normalizeParkHours,
  normalizeParkHoursForDate,
  applyStoredOvernight,
  needsStoredOvernight,
  parkDateFollowUps,
  parkDateRequestIssue,
  previousResortMonth,
  type ParkDateHours,
  type ParkDateSources,
  type ParkHours,
  type ParkHoursSources,
  type StoredDayHours,
} from "./parkHours";
import { themeParks, type ThemeParksResult, type ThemeParksSchedule } from "./themeParksApi";
import { THEMEPARKS_PARKS } from "./themeParksProviders";
import { waitUntil } from "@vercel/functions";
import { persistParkRegularHours, readStoredPreviousDayHours, type PersistableScheduleResponse } from "./parkHoursStore";
import { addDaysToLocalDate } from "./resortTime";
import type { ResortId } from "@disney-wait-planner/shared";

/**
 * Phase 12.10.2A: hand the provider responses this request ALREADY fetched to
 * the durable store (no extra provider calls). FIRE-AND-FORGET w.r.t. the
 * response — it never waits for persistence — but the work is registered with
 * the serverless request lifetime so Vercel keeps the function alive until the
 * (bounded) write settles. Next 14.2 has no `after()`; `waitUntil` from
 * `@vercel/functions` is Vercel's supported API for Node route handlers (it
 * reads the platform's request context, and is a no-op off-Vercel/local, where
 * the process simply keeps running). The store owns the write's deadline,
 * abort, cooldown and single-flight bounds; `BACKGROUND_PERSIST_MAX_MS` is an
 * outer cap so the registered lifetime can never be unbounded. No throw, no
 * unhandled rejection. Skipped when a test injects `getSchedule` without `persist`.
 */
type PersistHours = (parkId: ParkId, responses: PersistableScheduleResponse[], instant: Date) => Promise<unknown> | void;
type KeepAlive = (work: Promise<unknown>) => void;

/** Outer cap on how long a response's persistence may hold the function alive. */
export const BACKGROUND_PERSIST_MAX_MS = 5000;

function persistFetched(
  parkId: ParkId,
  opts: { getSchedule?: unknown; persist?: PersistHours; keepAlive?: KeepAlive },
  instant: Date,
  responses: PersistableScheduleResponse[],
): void {
  const persist = opts.persist ?? (opts.getSchedule ? null : (p, r, i) => persistParkRegularHours(p, r, { instant: i }));
  if (!persist) return;
  try {
    // Invoked synchronously (so its start is deterministic) but never awaited.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.race([
      Promise.resolve(persist(parkId, responses, instant)),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, BACKGROUND_PERSIST_MAX_MS); }),
    ]).then(() => {}, () => { /* DB trouble never affects park hours */ }).finally(() => { if (timer) clearTimeout(timer); });
    try { (opts.keepAlive ?? waitUntil)(work); } catch { /* no request context: work still runs */ }
  } catch { /* synchronous failure: same */ }
}

/**
 * Phase 12.10.2C: bounded read of yesterday's Neon-retained verified hours.
 * Resolves null on any problem. Injected in tests; `null` option disables.
 */
type ReadStoredPreviousDay = (parkId: ParkId, date: string) => Promise<StoredDayHours | null>;

type GetSchedule = (
  id: string,
  month?: { year: number; month: number },
) => Promise<ThemeParksResult<ThemeParksSchedule>>;

export async function getParkHours(
  parkId: ParkId,
  opts: { instant?: Date; getSchedule?: GetSchedule; persist?: PersistHours; keepAlive?: KeepAlive; readStored?: ReadStoredPreviousDay } = {},
): Promise<ParkHours> {
  const getSchedule: GetSchedule = opts.getSchedule ?? ((id, month) => themeParks.getSchedule(id, month));
  const resort = PARK_TO_RESORT[parkId] as ResortId;
  const id = THEMEPARKS_PARKS[parkId].entityId;
  // `now` is taken after the fetches so the result reflects delivery time.
  const now = () => opts.instant ?? new Date();

  const src: ParkHoursSources = { primary: await getSchedule(id) };
  if (isClosureCandidate(parkId, src.primary, now())) {
    const localDate = getResortLocalDate(resort, now());
    src.currentMonth = await getSchedule(id, currentResortMonth(localDate));
    if (src.currentMonth.ok && normalizeParkHours(parkId, src, now()).nextOpening === null) {
      src.nextMonth = await getSchedule(id, nextResortMonth(localDate));
    }
  }
  let result = normalizeParkHours(parkId, src, now());
  // Phase 12.10.2C: today's provider response stays authoritative; Neon is read
  // only when overnight is unverified AND it could change the outcome, and any
  // failure leaves the provider-derived result untouched.
  if (needsStoredOvernight(result, now())) {
    const readStored = opts.readStored ?? (opts.getSchedule ? null : (p, d) => readStoredPreviousDayHours(p, d));
    const yesterday = addDaysToLocalDate(result.localDate, -1);
    if (readStored && yesterday) {
      try { result = applyStoredOvernight(result, await readStored(parkId, yesterday), now()); } catch { /* DB trouble never affects park hours */ }
    }
  }
  persistFetched(parkId, opts, now(), [
    { coverage: "default_window", result: src.primary },
    ...(src.currentMonth ? [{ coverage: "month" as const, result: src.currentMonth }] : []),
    ...(src.nextMonth ? [{ coverage: "month" as const, result: src.nextMonth }] : []),
  ]);
  return result;
}

/**
 * Phase 12.6 — exact resort-local date. One monthly request for the date's own
 * month in the normal case; the previous/next month only when nothing is dated
 * `date` and the month lacks OPERATING entries before/after it (Closed vs. Not
 * yet available needs the provider calendar to bracket or not cover the date).
 * Past/invalid dates make no provider call. Never uses the "upcoming" window.
 */
export async function getParkHoursForDate(
  parkId: ParkId,
  date: string,
  opts: { instant?: Date; getSchedule?: GetSchedule; persist?: PersistHours; keepAlive?: KeepAlive } = {},
): Promise<ParkDateHours> {
  const getSchedule: GetSchedule = opts.getSchedule ?? ((id, month) => themeParks.getSchedule(id, month));
  const id = THEMEPARKS_PARKS[parkId].entityId;
  const now = () => opts.instant ?? new Date();
  if (parkDateRequestIssue(parkId, date, now())) return normalizeParkHoursForDate(parkId, date, { month: { ok: false, error: { kind: "invalid_request", message: "date not requestable" } } }, now());

  const [y, m] = date.split("-").map(Number);
  const src: ParkDateSources = { month: await getSchedule(id, { year: y, month: m }) };
  const need = parkDateFollowUps(date, src.month);
  if (need.next) src.nextMonth = await getSchedule(id, nextResortMonth(date));
  // The previous month only matters for Closed, which needs something later.
  const laterKnown = [src.month, src.nextMonth].some(
    (r) => r && r.ok && r.data.entries.some((e) => e.type === "OPERATING" && e.date > date),
  );
  if (need.prev && laterKnown) src.prevMonth = await getSchedule(id, previousResortMonth(date));
  const result = normalizeParkHoursForDate(parkId, date, src, now());
  persistFetched(parkId, opts, now(), (["month", "nextMonth", "prevMonth"] as const).flatMap((k) => (src[k] ? [{ coverage: "month" as const, result: src[k]! }] : [])));
  return result;
}

/** DEV check (run manually; returns failing labels): provider UUID, call economy, month boundaries. */
export async function runDevParkHoursServiceCases(): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const ID = THEMEPARKS_PARKS.mk.entityId;
  const op = (date: string) => ({ date, type: "OPERATING", openingTime: `${date}T09:00:00-04:00`, closingTime: `${date}T22:00:00-04:00`, description: null, lastUpdated: null });
  const res = (entries: ReturnType<typeof op>[], at: number): ThemeParksResult<ThemeParksSchedule> =>
    ({ ok: true, data: { entityId: ID, name: "MK", timeZone: "America/New_York", entries, parks: [], droppedEntries: 0 }, meta: { origin: "network", fetchedAt: at, etag: null } });
  const run = async (now: string, data: Record<string, ReturnType<typeof op>[]>) => {
    const instant = new Date(now);
    const asked: string[] = [];
    const r = await getParkHours("mk", {
      instant,
      getSchedule: async (id, month) => {
        const key = month ? `${month.year}-${String(month.month).padStart(2, "0")}` : "default";
        asked.push(`${id === ID ? "mk" : id}:${key}`);
        return data[key] ? res(data[key], instant.getTime()) : { ok: false, error: { kind: "timeout", message: "t" } };
      },
    });
    return { r, asked };
  };

  let o = await run("2026-10-15T15:00:00Z", { default: [op("2026-10-15"), op("2026-10-16")] });
  check("service: normal day = one default-window call with the park UUID", o.asked.join() === "mk:default" && o.r.status === "hours");

  o = await run("2026-10-15T15:00:00Z", { default: [op("2026-10-16")], "2026-10": [op("2026-10-14"), op("2026-10-16")] });
  check("service: potential closure adds only the current month", o.asked.join() === "mk:default,mk:2026-10" && o.r.status === "closed");

  o = await run("2026-10-31T15:00:00Z", { default: [], "2026-10": [op("2026-10-30")], "2026-11": [op("2026-11-02")] });
  check("service: month end fetches next month only when no later window", o.asked.join() === "mk:default,mk:2026-10,mk:2026-11" && o.r.status === "closed" && o.r.nextOpening?.date === "2026-11-02");

  o = await run("2026-12-31T15:00:00Z", { default: [], "2026-12": [op("2026-12-30")], "2027-01": [op("2027-01-01")] });
  check("service: December rolls to January next year", o.asked[2] === "mk:2027-01" && o.r.nextOpening?.relation === "tomorrow");

  o = await run("2026-10-15T15:00:00Z", { default: [op("2026-10-16")] });
  check("service: month follow-up failure → unknown, not Closed", o.r.status === "unknown");

  // Provider-request boundary: pre-open Today overnight checks add NO monthly lookups.
  o = await run("2026-10-15T04:30:00Z", { default: [op("2026-10-15"), op("2026-10-16")], "2026-10": [op("2026-10-14")] });
  check("service: pre-open normal day stays one default-window call", o.asked.join() === "mk:default" && o.r.overnight?.state === "unverified");
  o = await run("2026-10-01T04:30:00Z", { default: [op("2026-10-01")], "2026-09": [op("2026-09-30")] });
  check("service: first of month pre-open adds no previous-month call", o.asked.join() === "mk:default");
  o = await run("2026-10-15T15:00:00Z", { default: [op("2026-10-16")], "2026-10": [op("2026-10-14"), op("2026-10-16")] });
  check("service: closure follow-up month is reused as overnight evidence (no extra call)", o.asked.join() === "mk:default,mk:2026-10" && o.r.overnight?.state === "none");

  o = await run("2026-10-15T15:00:00Z", {});
  check("service: primary failure → unavailable, no follow-ups", o.r.status === "unavailable" && o.asked.length === 1);

  // Resort-local date, not server date: 03:00Z Oct 16 is still Oct 15 in Orlando.
  o = await run("2026-10-16T03:00:00Z", { default: [op("2026-10-15"), op("2026-10-16")] });
  check("service: uses the resort-local date", o.r.localDate === "2026-10-15" && o.r.status === "hours");

  // Phase 12.10.2A: persistence reuses fetched responses; its failure is invisible.
  {
    const instant = new Date("2026-10-15T15:00:00Z");
    const asked: string[] = [];
    const seen: string[] = [];
    const getSchedule: GetSchedule = async (id, month) => { asked.push(month ? "m" : "d"); return res(month ? [op("2026-10-14"), op("2026-10-16")] : [op("2026-10-16")], instant.getTime()); };
    const r = await getParkHours("mk", { instant, getSchedule, persist: async (_p, rs) => { seen.push(rs.map((x) => x.coverage).join("+")); } });
    check("service: persist receives the fetched responses, no extra provider calls", asked.join() === "d,m" && seen.join() === "default_window+month" && r.status === "closed");
    const r2 = await getParkHours("mk", { instant, getSchedule, persist: async () => { throw new Error("db down"); } });
    check("service: persist failure does not affect park hours", r2.status === "closed");
    const d = await getParkHoursForDate("mk", "2026-10-20", { instant, getSchedule, persist: async (_p, rs) => { seen.push("date:" + rs.length); } });
    check("service: exact-date path persists its month response", seen.some((x) => x.startsWith("date:")) && d.status !== "unavailable");

    // Stalled / failing persistence never delays or alters either result, and never leaks a rejection.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const stall = () => new Promise<void>(() => {});
      // A regression (awaiting persistence) would hang forever; race a sentinel so it FAILS instead.
      const within = <T,>(p: Promise<T>) => Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 250))]);
      const rs = await within(getParkHours("mk", { instant, getSchedule, persist: stall }));
      const rd = await within(getParkHoursForDate("mk", "2026-10-20", { instant, getSchedule, persist: stall }));
      check("service: stalled persistence does not delay today's hours", rs !== "timeout" && rs.status === "closed");
      check("service: stalled persistence does not delay exact-date hours", rd !== "timeout" && rd.status === d.status);
      const rej = await getParkHours("mk", { instant, getSchedule, persist: () => Promise.reject(new Error("db down")) });
      const thr = await getParkHoursForDate("mk", "2026-10-20", { instant, getSchedule, persist: () => { throw new Error("sync boom"); } });
      await new Promise((r) => setTimeout(r, 20));
      check("service: rejecting/throwing persistence leaves results intact with no unhandled rejection", rej.status === "closed" && thr.status === d.status && unhandled.length === 0);
      // Request-lifetime registration: the bounded persistence promise is handed to keepAlive,
      // and the response does not wait for it.
      const kept: Promise<unknown>[] = [];
      let release: (() => void) | undefined;
      const gate = new Promise<void>((r) => { release = r; });
      const rk = await within(getParkHours("mk", { instant, getSchedule, persist: () => gate, keepAlive: (w) => { kept.push(w); } }));
      const rkd = await within(getParkHoursForDate("mk", "2026-10-20", { instant, getSchedule, persist: () => gate, keepAlive: (w) => { kept.push(w); } }));
      check("service: both paths register persistence with the request lifetime without awaiting it", kept.length === 2 && rk !== "timeout" && rkd !== "timeout");
      let settled = 0; kept.forEach((w) => void w.then(() => { settled++; }));
      await new Promise((r) => setTimeout(r, 20));
      check("service: registered work stays pending while persistence is in flight", settled === 0);
      release?.();
      await Promise.all(kept);
      check("service: registered work settles once persistence completes", settled === 2);
      const rejKept: Promise<unknown>[] = [];
      await getParkHours("mk", { instant, getSchedule, persist: () => Promise.reject(new Error("x")), keepAlive: (w) => { rejKept.push(w); } });
      let rejected = false;
      await rejKept[0].catch(() => { rejected = true; });
      check("service: registered work never rejects", !rejected);
      await getParkHours("mk", { instant, getSchedule, persist: async () => {}, keepAlive: () => { throw new Error("no context"); } });
      check("service: a throwing keepAlive does not affect the result", true);
      // Default keepAlive = @vercel/functions waitUntil, driven through the platform's request-context symbol.
      const ctxKey = Symbol.for("@vercel/request-context");
      const g = globalThis as unknown as Record<symbol, unknown>;
      const prevCtx = g[ctxKey];
      const registered: Promise<unknown>[] = [];
      g[ctxKey] = { get: () => ({ waitUntil: (p: Promise<unknown>) => { registered.push(p); } }) };
      try {
        await getParkHours("mk", { instant, getSchedule, persist: async () => {} });
        await getParkHoursForDate("mk", "2026-10-20", { instant, getSchedule, persist: async () => {} });
      } finally { if (prevCtx === undefined) delete g[ctxKey]; else g[ctxKey] = prevCtx; }
      check("service: default path registers with Vercel's request context (waitUntil) on both paths", registered.length === 2);
      await getParkHours("mk", { instant, getSchedule, persist: async () => {} });
      check("service: no request context (local/dev) is a safe no-op", true);
      const started: string[] = [];
      await within(getParkHours("mk", { instant, getSchedule, persist: (_p, r) => { started.push(String(r.length)); return stall(); } }));
      check("service: persistence is still started for every request (before returning)", started.length === 1);
    } finally { process.off("unhandledRejection", onUnhandled); }
  }
  return failures;
}

/** DEV check (run manually; returns failing labels): exact-date call economy, month/year boundaries. */
export async function runDevParkHoursForDateServiceCases(): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const ID = THEMEPARKS_PARKS.mk.entityId;
  const op = (date: string) => ({ date, type: "OPERATING", openingTime: `${date}T09:00:00-04:00`, closingTime: `${date}T22:00:00-04:00`, description: null, lastUpdated: null });
  const run = async (now: string, date: string, data: Record<string, ReturnType<typeof op>[]>) => {
    const instant = new Date(now);
    const asked: string[] = [];
    const r = await getParkHoursForDate("mk", date, {
      instant,
      getSchedule: async (id, month) => {
        const key = month ? `${month.year}-${String(month.month).padStart(2, "0")}` : "default";
        asked.push(`${id === ID ? "mk" : id}:${key}`);
        return data[key]
          ? { ok: true, data: { entityId: ID, name: "MK", timeZone: "America/New_York", entries: data[key], parks: [], droppedEntries: 0 }, meta: { origin: "network", fetchedAt: instant.getTime(), etag: null } }
          : { ok: false, error: { kind: "timeout", message: "t" } };
      },
    });
    return { r, asked };
  };
  const N = "2026-10-15T15:00:00Z";
  let o = await run(N, "2026-10-20", { "2026-10": [op("2026-10-20")] });
  check("date service: published date = one monthly call for that month, park UUID", o.asked.join() === "mk:2026-10" && o.r.status === "hours");
  o = await run(N, "2026-10-20", { "2026-10": [op("2026-10-19"), op("2026-10-21")] });
  check("date service: bracketed gap needs no extra month", o.asked.join() === "mk:2026-10" && o.r.status === "closed");
  o = await run(N, "2026-11-20", { "2026-11": [], "2026-12": [] });
  check("date service: empty future month checks only the next month → Not yet available", o.asked.join() === "mk:2026-11,mk:2026-12" && o.r.status === "not_yet_available");
  o = await run(N, "2026-12-31", { "2026-12": [op("2026-12-30")], "2027-01": [op("2027-01-02")] });
  check("date service: December 31 follows into January next year", o.asked.join() === "mk:2026-12,mk:2027-01" && o.r.status === "closed");
  o = await run(N, "2027-01-01", { "2027-01": [op("2027-01-02")], "2026-12": [op("2026-12-31")] });
  check("date service: January 1 looks back into December prior year", o.asked.includes("mk:2026-12") && o.r.status === "closed");
  o = await run(N, "2026-10-20", {});
  check("date service: month failure → unavailable, no follow-ups", o.r.status === "unavailable" && o.asked.length === 1);
  o = await run(N, "2026-10-14", { "2026-10": [op("2026-10-14")] });
  check("date service: past date makes no provider call", o.asked.length === 0 && o.r.unavailableReason === "past_date");
  o = await run(N, "2026-02-30", {});
  check("date service: invalid date makes no provider call", o.asked.length === 0 && o.r.unavailableReason === "invalid_date");
  return failures;
}

/** DEV check (run manually; returns failing labels): Phase 12.10.2C stored overnight supplement. */
export async function runDevStoredOvernightCases(): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const ID = THEMEPARKS_PARKS.mk.entityId;
  type E = { date: string; type: string; openingTime: string; closingTime: string; description: null; lastUpdated: null };
  const op = (date: string, open = "09:00:00", close = "22:00:00", off = "-04:00"): E => ({ date, type: "OPERATING", openingTime: `${date}T${open}${off}`, closingTime: `${date}T${close}${off}`, description: null, lastUpdated: null });
  const res = (entries: E[], at: number): ThemeParksResult<ThemeParksSchedule> =>
    ({ ok: true, data: { entityId: ID, name: "MK", timeZone: "America/New_York", entries, parks: [], droppedEntries: 0 }, meta: { origin: "network", fetchedAt: at, etag: null } });
  const win = (opens: string, closes: string) => ({ opens: new Date(opens).toISOString(), closes: new Date(closes).toISOString() });
  const stored = (date: string, windows: Array<{ opens: string; closes: string }>, fetchedAt: string): StoredDayHours => ({ date, windows, sourceFetchedAt: Date.parse(fetchedAt) });

  // Today's provider data: default window starting today (yesterday unverified) — the case Neon supplements.
  const run = async (now: string, entries: E[], readStored: ((p: ParkId, d: string) => Promise<StoredDayHours | null>) | undefined, origin?: "stale") => {
    const instant = new Date(now);
    let reads = 0; const dates: string[] = [];
    const r = await getParkHours("mk", {
      instant,
      getSchedule: async () => { const x = res(entries, instant.getTime()); if (origin && x.ok) x.meta.origin = "stale"; return x; },
      readStored: readStored ? async (p, d) => { reads++; dates.push(d); return readStored(p, d); } : undefined,
    });
    return { r, reads, dates };
  };
  const today = [op("2026-10-15")];
  const NOW_PRE = "2026-10-15T04:30:00Z"; // 12:30 AM EDT Oct 15
  const NOW_AFTER = "2026-10-15T06:30:00Z"; // 2:30 AM EDT
  const yWin = win("2026-10-14T09:00:00-04:00", "2026-10-15T01:00:00-04:00"); // closes 1 AM Oct 15
  const fetched = "2026-10-14T15:00:00Z";

  // --- confirmed overnight open / closed
  let o = await run(NOW_PRE, today, async () => stored("2026-10-14", [yWin], fetched));
  check("stored: running overnight window → in_progress (source stored)", o.r.overnight?.state === "in_progress" && o.r.overnight.source === "stored" && o.r.overnight.windows[0].closes === "1:00 AM" && o.dates.join() === "2026-10-14");
  o = await run(NOW_AFTER, today, async () => stored("2026-10-14", [yWin], fetched));
  check("stored: ended overnight window → none (verified)", o.r.overnight?.state === "none" && o.r.overnight.source === "stored");
  check("stored: exactly at close is ended", (await run("2026-10-15T05:00:00Z", today, async () => stored("2026-10-14", [yWin], fetched))).r.overnight?.state === "none");
  // End-to-end through the Today status
  const { describeParkOperatingStatus } = await import("./todayDashboard");
  let s = describeParkOperatingStatus((await run(NOW_PRE, today, async () => stored("2026-10-14", [yWin], fetched))).r, new Date(NOW_PRE));
  check("status: stored running overnight → green Open · closes 1:00 AM", s.kind === "open" && s.tone === "green" && s.text === "Open · closes 1:00 AM");
  s = describeParkOperatingStatus((await run(NOW_AFTER, today, async () => stored("2026-10-14", [yWin], fetched))).r, new Date(NOW_AFTER));
  check("status: stored verified-ended → amber Closed · opens 9:00 AM", s.kind === "before_open" && s.tone === "amber" && s.confirmedClosed && s.text === "Closed · opens 9:00 AM");

  // --- missing / stale / invalid Neon → gray fallback, never closed
  const grayCheck = async (label: string, reader: ((p: ParkId, d: string) => Promise<StoredDayHours | null>) | undefined, origin?: "stale") => {
    const x = await run(NOW_AFTER, today, reader, origin);
    const st = describeParkOperatingStatus(x.r, new Date(NOW_AFTER));
    check(label, x.r.overnight?.state === "unverified" && st.kind === "unknown" && st.tone === "gray" && st.text === "Scheduled to open at 9:00 AM" && !st.confirmedClosed);
  };
  await grayCheck("missing record → gray scheduled", async () => null);
  await grayCheck("stale record (older than 48h) → gray scheduled", async () => stored("2026-10-14", [yWin], "2026-10-12T20:00:00Z"));
  await grayCheck("record fetched in the future → gray scheduled", async () => stored("2026-10-14", [yWin], "2026-10-16T00:00:00Z"));
  await grayCheck("wrong date → gray scheduled", async () => stored("2026-10-13", [yWin], fetched));
  await grayCheck("invalid window (close ≤ open) → gray scheduled", async () => stored("2026-10-14", [{ opens: yWin.closes, closes: yWin.opens }], fetched));
  await grayCheck("unparseable window → gray scheduled", async () => stored("2026-10-14", [{ opens: "bad", closes: "bad" }], fetched));
  await grayCheck("window not opening on yesterday → gray scheduled", async () => stored("2026-10-14", [win("2026-10-15T09:00:00-04:00", "2026-10-15T22:00:00-04:00")], fetched));
  await grayCheck("window > 24h → gray scheduled", async () => stored("2026-10-14", [win("2026-10-14T09:00:00-04:00", "2026-10-15T10:00:00-04:00")], fetched));
  await grayCheck("empty windows → gray scheduled", async () => stored("2026-10-14", [], fetched));
  await grayCheck("overlapping windows → gray scheduled", async () => stored("2026-10-14", [win("2026-10-14T09:00:00-04:00", "2026-10-14T15:00:00-04:00"), win("2026-10-14T14:00:00-04:00", "2026-10-14T22:00:00-04:00")], fetched));
  await grayCheck("DB read throws → gray scheduled, hours intact", async () => { throw new Error("db down"); });
  await grayCheck("no reader / DB unconfigured → gray scheduled", undefined);
  await grayCheck("stale provider data never takes the Neon supplement", async () => stored("2026-10-14", [yWin], fetched), "stale");

  // --- no opening time → Status unavailable retained
  {
    const x = await run(NOW_AFTER, [], async () => stored("2026-10-14", [yWin], fetched));
    check("no today hours: unknown stays Status unavailable", describeParkOperatingStatus(x.r, new Date(NOW_AFTER)).text === "Status unavailable");
  }

  // --- provider stays authoritative / avoid unnecessary reads
  o = await run(NOW_PRE, [op("2026-10-14", "09:00:00", "22:00:00"), op("2026-10-15")], async () => stored("2026-10-14", [], fetched));
  check("provider-verified overnight is never read from Neon", o.reads === 0 && o.r.overnight?.state === "none" && o.r.overnight.source === undefined);
  o = await run("2026-10-15T16:00:00Z", today, async () => stored("2026-10-14", [yWin], fetched));
  check("after today's opening: no DB read", o.reads === 0);

  // --- multiple windows (split yesterday; the later one runs past midnight)
  const w1 = win("2026-10-14T09:00:00-04:00", "2026-10-14T13:00:00-04:00");
  const w2 = win("2026-10-14T18:00:00-04:00", "2026-10-15T01:00:00-04:00");
  o = await run(NOW_PRE, today, async () => stored("2026-10-14", [w2, w1], fetched));
  check("multiple windows: only the one still running is carried", o.r.overnight?.state === "in_progress" && o.r.overnight.windows.length === 1 && o.r.overnight.windows[0].opens === "6:00 PM");
  o = await run(NOW_AFTER, today, async () => stored("2026-10-14", [w2, w1], fetched));
  check("multiple windows: all ended → none", o.r.overnight?.state === "none");

  // --- DST. Fall back Nov 1 2026 (EDT→EST at 2 AM): yesterday's 9 PM–3 AM window is 6 h long on the clock.
  {
    const dstWin = win("2026-10-31T21:00:00-04:00", "2026-11-01T03:00:00-05:00");
    const dstToday = [op("2026-11-01", "09:00:00", "22:00:00", "-05:00")];
    const at = (iso: string) => run(iso, dstToday, async () => stored("2026-10-31", [dstWin], "2026-10-31T15:00:00Z"));
    check("DST fall-back: 1:30 AM EST (second 1:30) still running", (await at("2026-11-01T06:30:00Z")).r.overnight?.state === "in_progress");
    check("DST fall-back: after 3 AM EST → none", (await at("2026-11-01T08:30:00Z")).r.overnight?.state === "none");
    // Spring forward Mar 8 2026 (2 AM→3 AM): yesterday's 9 PM–3 AM EDT window (5 h elapsed).
    const sprWin = win("2026-03-07T21:00:00-05:00", "2026-03-08T03:00:00-04:00");
    const sprToday = [op("2026-03-08", "09:00:00", "22:00:00", "-04:00")];
    const sp = (iso: string) => run(iso, sprToday, async () => stored("2026-03-07", [sprWin], "2026-03-07T15:00:00Z"));
    check("DST spring-forward: 3:30 AM EDT is past close → none", (await sp("2026-03-08T07:30:00Z")).r.overnight?.state === "none");
    check("DST spring-forward: 2:30 AM-equivalent (06:30Z=1:30 EST) still running", (await sp("2026-03-08T06:30:00Z")).r.overnight?.state === "in_progress");
  }

  // --- resort-local midnight: 03:59Z is 11:59 PM EDT Oct 14 (yesterday = Oct 13); 04:00Z is midnight Oct 15 (yesterday = Oct 14).
  {
    const asks: string[] = [];
    await run("2026-10-15T03:59:00Z", [op("2026-10-14")], async (_p, d) => { asks.push(d); return null; });
    await run("2026-10-15T04:00:00Z", [op("2026-10-15")], async (_p, d) => { asks.push(d); return null; });
    check("midnight: 11:59 PM local needs no read; 12:00 AM local asks for the resort-local previous day (not UTC)", asks.join() === "2026-10-14");
  }

  // --- DB failure never breaks the response (covered by the throwing-reader case above).
  // Real store reader: deadline + cooldown + failure isolation (fake executors).
  {
    const { readStoredPreviousDayHours, resetParkHoursReadState } = await import("./parkHoursStore");
    resetParkHoursReadState();
    let aborted = 0; let calls = 0;
    const stall = { run: () => { calls++; return new Promise<never>(() => {}); }, abort() { aborted++; } };
    let clock = 1000;
    const t = await readStoredPreviousDayHours("mk", "2026-10-14", { executor: stall as never, deadlineMs: 30, clock: () => clock });
    check("store read: stalled DB → null at the deadline, connection aborted", t === null && aborted === 1 && calls === 1);
    const again = await readStoredPreviousDayHours("mk", "2026-10-14", { executor: stall as never, deadlineMs: 30, clock: () => clock });
    check("store read: cooldown after timeout makes no new DB attempt", again === null && calls === 1);
    clock += 61_000;
    const failing = { run: async () => { throw new Error("boom"); }, abort() {} };
    check("store read: DB error → null (never throws)", (await readStoredPreviousDayHours("mk", "2026-10-14", { executor: failing as never, clock: () => clock })) === null);
    resetParkHoursReadState();
    const okDb = { query: async () => ({ rowCount: 1, rows: [{ park_id: "mk", d: "2026-10-14", windows: [yWin], coverage: "month", f: Date.parse(fetched) }] }) };
    const row = await readStoredPreviousDayHours("mk", "2026-10-14", { db: okDb });
    check("store read: returns the stored row for the date", row?.date === "2026-10-14" && row.windows.length === 1);
    check("store read: invalid date makes no query", (await readStoredPreviousDayHours("mk", "nope", { db: { query: async () => { throw new Error("x"); } } })) === null);
  }
  return failures;
}

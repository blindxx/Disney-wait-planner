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
  parkDateFollowUps,
  parkDateRequestIssue,
  previousResortMonth,
  type ParkDateHours,
  type ParkDateSources,
  type ParkHours,
  type ParkHoursSources,
} from "./parkHours";
import { themeParks, type ThemeParksResult, type ThemeParksSchedule } from "./themeParksApi";
import { THEMEPARKS_PARKS } from "./themeParksProviders";
import { waitUntil } from "@vercel/functions";
import { persistParkRegularHours, type PersistableScheduleResponse } from "./parkHoursStore";
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

type GetSchedule = (
  id: string,
  month?: { year: number; month: number },
) => Promise<ThemeParksResult<ThemeParksSchedule>>;

export async function getParkHours(
  parkId: ParkId,
  opts: { instant?: Date; getSchedule?: GetSchedule; persist?: PersistHours; keepAlive?: KeepAlive } = {},
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
  const result = normalizeParkHours(parkId, src, now());
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

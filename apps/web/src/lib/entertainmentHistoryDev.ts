/**
 * entertainmentHistoryDev.ts — Phase 14.4.2 DEV regression cases that exercise
 * history-assisted inactivity end to end (history → showtimes/All Entertainment
 * → seasonal visibility) and the party-meet hours consistency fix. Not wired
 * into any runtime path or CI; run manually (returns failing labels):
 *
 *   runDevHistoryAssistedFilteringCases()   // sync: evidence thresholds + visibility
 *   runDevPartyMeetHoursConsistencyCases()  // async: All Entertainment vs Waits & Shows
 *
 * Phase 14.4.2 authenticated expansion: runDevHistoryAccessChainCases() (async, service
 * fetch chain), runDevHistoryLongWindowFilteringCases() (async, 30-day end to end).
 *
 * Pure evidence-reliability cases live beside the logic: runDevEntertainmentHistoryCases()
 * and runDevEntertainmentHistoryLongWindowCases() (entertainmentHistory.ts); provider-client history cases: runDevThemeParksApiCases().
 */

import type { ParkId } from "@disney-wait-planner/shared";
import { buildParkAllEntertainment, allEntryViewAt } from "./entertainmentAll";
import { devHistoryFixture } from "./entertainmentHistory";
import { getParkAllEntertainment } from "./entertainmentAllService";
import { normalizeParkEntertainmentShowtimes, type EntertainmentShowtimeEntry } from "./entertainmentShowtimes";
import { buildParkEventMeets, describeEventMeet } from "./eventExclusiveMeets";
import { applyAllEntertainmentSeasonalVisibility, isEntertainmentHiddenToday } from "./seasonalVisibility";
import { ENTERTAINMENT_PLACES } from "./entertainmentSuggestions";
import { THEMEPARKS_PARKS } from "./themeParksProviders";
import type { ThemeParksHistoryDaily, ThemeParksLive, ThemeParksResult, ThemeParksShowtime } from "./themeParksApi";

const HEA = "22b78ed9-a692-47cb-b6a4-6d1224ff67e3";
const STARLIGHT = "d69261dc-62b8-434c-83bd-93649b43c408";
const MINNIE_FW = "bb28947d-a747-44f0-ac71-1fa8188f4cee"; // party-associated curated show (MVMCP)
const BLUEY_SHOW = "95a9cde3-ff1f-40a3-8276-2477ded688f8";
const BLUEY_ATTR = "888525b0-5a6f-4b8e-9f07-b6a32812b04d";
const JOIN_SANTA = "418c2111-36d4-4f07-86b2-8058014a263c"; // registered party meet (no Queue-Times record)
const MK_NOW = new Date("2026-11-13T16:30:00Z"); // 11:30 AM EST Fri Nov 13 — confirmed MVMCP night
const MK_TODAY = "2026-11-13";

type LiveEntry = ThemeParksLive["entries"][number];
const st = (startTime: string, type: string | null = "Performance Time", endTime: string | null = null): ThemeParksShowtime => ({ type, startTime, endTime });
const entry = (entityId: string, showtimes: ThemeParksShowtime[], name = "x", status = "CLOSED", droppedShowtimes = 0): LiveEntry =>
  ({ entityId, name, entityType: "SHOW", parkId: null, externalId: null, status, lastUpdated: null, showtimes, droppedShowtimes });
const liveOf = (entries: LiveEntry[], at: Date, over: { fetchedAt?: number; origin?: "network" | "stale" } = {}): ThemeParksResult<ThemeParksLive> => ({
  ok: true,
  data: { entityId: "p", name: "p", timeZone: null, entries, droppedEntries: 0, droppedShowtimes: 0 },
  meta: { origin: over.origin ?? "network", fetchedAt: over.fetchedAt ?? at.getTime(), etag: null, ...(over.origin === "stale" ? { staleReason: { kind: "http" as const, message: "503", httpStatus: 503 } } : {}) },
});
/** Three unrelated shows already performing today at Magic Kingdom: "today's schedules have posted". */
const quorum = (): LiveEntry[] => ["a", "b", "c"].map((k, i) => entry(`0000000${i}-0000-4000-8000-00000000000${i}`, [st("2026-11-13T20:00:00-05:00")], k, "OPERATING"));

export function runDevHistoryAssistedFilteringCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const find = (r: { entries: EntertainmentShowtimeEntry[] }, name: string) => r.entries.find((e) => e.dwpName === name)!;
  const hiddenBy = (e: EntertainmentShowtimeEntry) => e.confirmedNoActivityToday === true;
  const mk = (entries: LiveEntry[], hist: ThemeParksResult<ThemeParksHistoryDaily> | null, at = MK_NOW, over = {}) =>
    find(normalizeParkEntertainmentShowtimes("mk", liveOf([...quorum(), ...entries], at, over), at, hist), "Happily Ever After");
  // Window Nov 7..13 (cols: 7,8,9,10,11,12,13). MVMCP party nights: 8, 9, 12, 13. Nov 10 = Magic Kingdom's real anomalous zero day.
  const HEA_ROWS: Array<number | "-"> = [1, 0, "-", 1, 1, 0, "-"];
  const hist = (specs: Record<string, Array<number | "-">> = { [HEA]: HEA_ROWS }, o = {}) => devHistoryFixture(MK_TODAY, specs, o);
  const tomorrow = st("2026-11-14T21:00:00-05:00");

  // Learned party-night suppression (no hardcoded HEA/Starlight)
  const learned = mk([entry(HEA, [])], hist());
  check("HEA on a party night: learned party-dark pattern + clean empty live + quorum → confirmed (history_party)", hiddenBy(learned) && learned.inactivityBasis === "history_party");
  check("…and the entry's status/message are unchanged ('No showtimes posted')", learned.status === "none_posted" && learned.performances.length === 0);
  check("Starlight is judged only by its OWN history (no shared exception): unrelated pattern → visible", !hiddenBy(find(normalizeParkEntertainmentShowtimes("mk", liveOf([...quorum(), entry(STARLIGHT, [])], MK_NOW), MK_NOW, hist({ [STARLIGHT]: [1, 1, 1, 1, 1, 1, "-"] })), "Disney Starlight: Dream the Night Away")));
  check("Starlight with its own learned party-dark history → confirmed", hiddenBy(find(normalizeParkEntertainmentShowtimes("mk", liveOf([...quorum(), entry(STARLIGHT, [])], MK_NOW), MK_NOW, hist({ [STARLIGHT]: HEA_ROWS })), "Disney Starlight: Dream the Night Away")));
  check("a show that performed on a party night in the window is never party-suppressed", !hiddenBy(mk([entry(HEA, [])], hist({ [HEA]: [1, 1, 1, 1, 1, 0, "-"] }))));
  check("only one party-dark night → not enough observed party nights", !hiddenBy(mk([entry(HEA, [])], hist({ [HEA]: [1, 0, "-", 1, 1, 1, "-"] }))));
  check("regular daily performer with an empty live day → visible (likely lag)", !hiddenBy(mk([entry(HEA, [])], hist({ [HEA]: [2, 2, 2, 2, 2, 2, "-"] }))));
  check("missing rows / sparse history → visible", !hiddenBy(mk([entry(HEA, [])], hist({ [HEA]: ["-", 0, "-", "-", 1, "-", "-"] }))));
  check("entity absent from history → visible", !hiddenBy(mk([entry(HEA, [])], hist({ other: HEA_ROWS }))));
  // Non-party date: party-explained darkness says it SHOULD perform → visible
  const D14 = new Date("2026-11-14T16:30:00Z");
  const q14 = quorum().map((q) => ({ ...q, showtimes: [st("2026-11-14T20:00:00-05:00")] }));
  const nonParty = find(normalizeParkEntertainmentShowtimes("mk", liveOf([...q14, entry(HEA, [])], D14), D14, devHistoryFixture("2026-11-14", { [HEA]: [1, 0, "-", 1, 1, 0, 0] })), "Happily Ever After");
  check("non-party date: dark days were party-explained, empty live is unexplained → visible", !hiddenBy(nonParty));

  // Live always wins / veto
  check("verified live performance today beats supportive history", !hiddenBy(mk([entry(HEA, [st("2026-11-13T21:00:00-05:00")])], hist())));
  check("verified live operating window today beats supportive history", !hiddenBy(mk([entry(HEA, [st("2026-11-13T09:00:00-05:00", "Operating", "2026-11-13T17:00:00-05:00")])], hist())));
  check("today's history row shows activity → vetoes (even with supportive past)", !hiddenBy(mk([entry(HEA, [])], hist({ [HEA]: [1, 0, "-", 1, 1, 0, 1] }))));
  check("today's history activity also vetoes the forward-horizon route", !hiddenBy(mk([entry(HEA, [tomorrow])], hist({ [HEA]: [1, 0, "-", 1, 1, 0, 1] }))));
  check("provider OPERATING with no times → ambiguous even with history", !hiddenBy(mk([{ ...entry(HEA, []), status: "OPERATING" }], hist())));
  check("dropped live showtimes → incomplete → visible", !hiddenBy(mk([entry(HEA, [], "x", "CLOSED", 1)], hist())));
  check("unrecognized live record today → visible", !hiddenBy(mk([entry(HEA, [st("2026-11-13T21:00:00-05:00", "Mystery")])], hist())));
  check("live ref absent from an ok payload → visible", !hiddenBy(mk([], hist())));
  check("no published-today quorum (schedules may not have posted) → visible", !hiddenBy(find(normalizeParkEntertainmentShowtimes("mk", liveOf([entry(HEA, [])], MK_NOW), MK_NOW, hist()), "Happily Ever After")));
  check("quorum counts distinct ACTIVE entities (two active is not enough)", !hiddenBy(find(normalizeParkEntertainmentShowtimes("mk", liveOf([...quorum().slice(0, 2), entry(HEA, [])], MK_NOW), MK_NOW, hist()), "Happily Ever After")));

  // Forward-horizon fallback preserved; provider failures
  check("forward-horizon route unchanged without any history", hiddenBy(mk([entry(HEA, [tomorrow])], null)) && mk([entry(HEA, [tomorrow])], null).inactivityBasis === "forward_horizon");
  check("history failure (rate limited) leaves the forward-horizon route working", hiddenBy(mk([entry(HEA, [tomorrow])], { ok: false, error: { kind: "rate_limited", message: "x" } })));
  check("history failure → no history-based hiding", !hiddenBy(mk([entry(HEA, [])], { ok: false, error: { kind: "timeout", message: "x" } })) && !hiddenBy(mk([entry(HEA, [])], null)));
  check("candidate flag set when history could decide, absent when forward horizon proves it", mk([entry(HEA, [])], null).historyCandidate === true && mk([entry(HEA, [tomorrow])], null).historyCandidate !== true);
  check("stale-if-error history never hides", !hiddenBy(mk([entry(HEA, [])], hist(undefined, { origin: "stale" }))));
  check("incomplete (continuation) history never hides", !hiddenBy(mk([entry(HEA, [])], hist(undefined, { hasMore: true }))));
  check("stale live payload never hides, even with good history", !hiddenBy(mk([entry(HEA, [])], hist(), MK_NOW, { origin: "stale" })));

  // Midnight / resort-local day
  const AFTER_MIDNIGHT = new Date("2026-11-14T05:30:00Z"); // 12:30 AM EST Nov 14
  check("just after resort-local midnight: yesterday's history window is rejected", !hiddenBy(find(normalizeParkEntertainmentShowtimes("mk", liveOf([...q14, entry(HEA, [])], AFTER_MIDNIGHT), AFTER_MIDNIGHT, devHistoryFixture(MK_TODAY, { [HEA]: HEA_ROWS })), "Happily Ever After")));
  check("history fetched before local midnight is rejected after it", !hiddenBy(mk([entry(HEA, [])], hist(undefined, { fetchedAt: Date.parse("2026-11-13T04:00:00Z") }))));
  check("history 'today' follows resort-local date, not UTC (11:30 PM EST is still Nov 13)", (() => {
    const late = new Date("2026-11-14T04:30:00Z");
    const q = quorum().map((x) => ({ ...x, showtimes: [st("2026-11-13T23:00:00-05:00")] }));
    return hiddenBy(find(normalizeParkEntertainmentShowtimes("mk", liveOf([...q, entry(HEA, [])], late, { fetchedAt: late.getTime() }), late, devHistoryFixture(MK_TODAY, { [HEA]: HEA_ROWS }, { fetchedAt: late.getTime() })), "Happily Ever After"));
  })());

  // Multi-ref safety (Bluey = show + attraction at DLR; not a party park → generic route)
  {
    const D = new Date("2026-11-13T19:00:00Z");
    const dq = ["a", "b", "c"].map((k, i) => entry(`0000000${i}-0000-4000-8000-00000000000${i}`, [st("2026-11-13T15:00:00-08:00")], k, "OPERATING"));
    const dh = (specs: Record<string, Array<number | "-">>) => devHistoryFixture("2026-11-13", specs);
    const pattern: Array<number | "-"> = [2, 0, 2, 0, 2, 2, "-"];
    const f = (liveEntries: LiveEntry[], h: ThemeParksResult<ThemeParksHistoryDaily>) =>
      find(normalizeParkEntertainmentShowtimes("disneyland", liveOf([...dq, ...liveEntries], D), D, h), "Bluey's Best Day Ever!");
    const both = [entry(BLUEY_SHOW, []), entry(BLUEY_ATTR, [])];
    check("multi-ref: both refs support (generic route) → confirmed", hiddenBy(f(both, dh({ [BLUEY_SHOW]: pattern, [BLUEY_ATTR]: pattern }))) && f(both, dh({ [BLUEY_SHOW]: pattern, [BLUEY_ATTR]: pattern })).inactivityBasis === "history");
    check("multi-ref: one ref lacks support → visible", !hiddenBy(f(both, dh({ [BLUEY_SHOW]: pattern, [BLUEY_ATTR]: [2, 2, 2, 2, 2, 2, "-"] }))));
    check("multi-ref: one ref missing from history → visible", !hiddenBy(f(both, dh({ [BLUEY_SHOW]: pattern }))));
    check("multi-ref: one ref active today in history → visible", !hiddenBy(f(both, dh({ [BLUEY_SHOW]: pattern, [BLUEY_ATTR]: [2, 0, 2, 0, 2, 2, 1] }))));
    check("multi-ref: one ref absent from live → visible", !hiddenBy(f([entry(BLUEY_SHOW, [])], dh({ [BLUEY_SHOW]: pattern, [BLUEY_ATTR]: pattern }))));
    check("multi-ref: mixed forward-horizon + history support is accepted per ref", hiddenBy(f([entry(BLUEY_SHOW, [st("2026-11-14T11:00:00-08:00")]), entry(BLUEY_ATTR, [])], dh({ [BLUEY_ATTR]: pattern }))));
  }

  // Seasonal rules, provider-only entries, party-rank override, event browsing
  {
    const place = ENTERTAINMENT_PLACES.find((p) => p.name === "Minnie's Wonderful Christmastime Fireworks")!;
    const r = normalizeParkEntertainmentShowtimes("mk", liveOf([...quorum(), entry(MINNIE_FW, [])], MK_NOW), MK_NOW, hist({ [MINNIE_FW]: HEA_ROWS }));
    const e = find(r, place.name);
    check("registry-confirmed party-night show stays visible even with supportive history", hiddenBy(e) && !isEntertainmentHiddenToday(place, "WDW", MK_TODAY, r.entries, MK_NOW));
    const heaPlace = ENTERTAINMENT_PLACES.find((p) => p.name === "Happily Ever After")!;
    const rh = normalizeParkEntertainmentShowtimes("mk", liveOf([...quorum(), entry(HEA, [])], MK_NOW), MK_NOW, hist());
    check("Waits & Shows hides the learned-dark show via the shared flag", isEntertainmentHiddenToday(heaPlace, "WDW", MK_TODAY, rh.entries, MK_NOW));
    check("an older body without the evidence fields is unconfirmed (visible)", !isEntertainmentHiddenToday(heaPlace, "WDW", MK_TODAY, rh.entries.map(({ confirmedNoActivityToday: _c, inactivityBasis: _b, ...rest }) => rest), MK_NOW));
    // All Entertainment: curated + provider-only share the evidence
    const PROVIDER_ONLY = "11111111-2222-4333-8444-555555555555";
    const all = buildParkAllEntertainment("mk", liveOf([...quorum(), { ...entry(HEA, []) }, { ...entry(PROVIDER_ONLY, []), name: "Some Unlisted Show" }], MK_NOW), MK_NOW, hist({ [HEA]: HEA_ROWS, [PROVIDER_ONLY]: HEA_ROWS }));
    const shown = applyAllEntertainmentSeasonalVisibility(all.entries, "mk", "WDW", MK_TODAY, false, MK_NOW);
    check("All Entertainment: curated learned-dark entry hidden", !shown.some((x) => x.name === "Happily Ever After") && all.entries.some((x) => x.name === "Happily Ever After"));
    check("All Entertainment: unclassified provider-only entry follows the same evidence (history-confirmed → hidden)", !shown.some((x) => x.name === "Some Unlisted Show"));
    const allNoHist = buildParkAllEntertainment("mk", liveOf([...quorum(), entry(HEA, []), { ...entry(PROVIDER_ONLY, []), name: "Some Unlisted Show" }], MK_NOW), MK_NOW, null);
    check("All Entertainment without history keeps both visible", applyAllEntertainmentSeasonalVisibility(allNoHist.entries, "mk", "WDW", MK_TODAY, false, MK_NOW).filter((x) => x.name === "Happily Ever After" || x.name === "Some Unlisted Show").length === 2);
    check("All Entertainment: an entry with verified operating hours stays visible", (() => {
      const o = buildParkAllEntertainment("mk", liveOf([...quorum(), { ...entry(PROVIDER_ONLY, [st("2026-11-13T09:00:00-05:00", "Operating", "2026-11-13T17:00:00-05:00")]), name: "Some Unlisted Show" }], MK_NOW), MK_NOW, hist({ [PROVIDER_ONLY]: HEA_ROWS }));
      return applyAllEntertainmentSeasonalVisibility(o.entries, "mk", "WDW", MK_TODAY, false, MK_NOW).some((x) => x.name === "Some Unlisted Show");
    })());
    // Event browsing (14.4D) bypasses the not-performing rule by never routing through this filter: the flag is data, not a filter.
    check("evidence is additive data: the entry itself (browsable by event) is retained in the inventory", all.entries.some((x) => x.name === "Happily Ever After" && x.showtime.confirmedNoActivityToday === true));
  }
  return failures;
}

/** All Entertainment and Waits & Shows read a registered party meet's window identically (Join Santa 6:00 PM–12:00 AM). */
export async function runDevPartyMeetHoursConsistencyCases(): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const at = new Date("2026-11-13T22:00:00Z"); // 5:00 PM EST Nov 13 (MVMCP night)
  const win = st("2026-11-13T18:00:00-05:00", "Special Ticketed Event", "2026-11-14T00:00:00-05:00");
  const name = "Join Santa Claus at Mickey's Very Merry Christmas Party";
  const payload = (santa: ThemeParksShowtime[], other: ThemeParksShowtime[] = []) =>
    liveOf([{ ...entry(JOIN_SANTA, santa, name, "OPERATING") }, { ...entry("22222222-3333-4444-8555-666666666666", other, "Party Stage Show", "OPERATING") }], at);
  const run = async (r: ThemeParksResult<ThemeParksLive>) => ({
    all: await getParkAllEntertainment("mk" as ParkId, { instant: at, getLive: async () => r, getHistory: async () => ({ ok: false, error: { kind: "network", message: "h" } }) }),
    meets: buildParkEventMeets("mk", r, null, at),
  });
  const a = await run(payload([win]));
  const allSanta = a.all.entries.find((e) => e.id === `provider:${JOIN_SANTA}`)!;
  const view = allEntryViewAt(allSanta, at);
  check("All Entertainment: registered party-meet window shows as operating hours", view.hoursText === "Operating hours: 6:00 PM–12:00 AM" && allSanta.showtime.performances.length === 0);
  check("All Entertainment: the window is NOT a '6:00 PM' performance time", view.collapsedText === null && view.times.length === 0);
  const meetView = describeEventMeet(a.meets.entries[0], at);
  check("Waits & Shows shows the same window text", meetView.scheduleText === "Operating hours: 6:00 PM–12:00 AM");
  check("both pages render the identical schedule text", meetView.scheduleText === view.hoursText);
  const disc = await run(payload([st("2026-11-13T19:00:00-05:00", "Special Ticketed Event", "2026-11-13T19:00:00-05:00")]));
  const dv = allEntryViewAt(disc.all.entries.find((e) => e.id === `provider:${JOIN_SANTA}`)!, at);
  check("registered meet: start==end is a genuine discrete performance on both pages", dv.collapsedText === "7:00 PM" && describeEventMeet(disc.meets.entries[0], at).scheduleText === "7:00 PM");
  const unreg = await run(payload([win], [st("2026-11-13T19:00:00-05:00", "Special Ticketed Event", "2026-11-13T20:00:00-05:00")]));
  const other = unreg.all.entries.find((e) => e.name === "Party Stage Show")!;
  check("unregistered Special Ticketed Event is never reclassified (still a performance)", allEntryViewAt(other, at).collapsedText === "7:00 PM" && (other.operatingHours?.length ?? 0) === 0);
  const bad = await run(payload([st("2026-11-13T18:00:00-05:00", "Special Ticketed Event", null)]));
  const bv = allEntryViewAt(bad.all.entries.find((e) => e.id === `provider:${JOIN_SANTA}`)!, at);
  check("ambiguous registered window (no end) is dropped, never shown as a time, schedule incomplete", bv.collapsedText !== "6:00 PM" && bad.all.entries.find((e) => e.id === `provider:${JOIN_SANTA}`)!.showtime.incomplete);
  check("Queue-Times behavior untouched: no-record meet shows no wait and no status text", meetView.waitText === null && meetView.statusText === null);
  return failures;
}

// ============================================
// Phase 14.4.2 (authenticated 30-day expansion) DEV cases
// ============================================

const FANTASMIC_DLR = "8c36ff0b-3a32-4d7b-9388-0516c19277db";
const DLR_NOW = new Date("2026-11-13T19:00:00Z"); // 11:00 AM PST Fri Nov 13
const DLR_TODAY = "2026-11-13";
const wdOf = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
/** Dark every Friday, performing otherwise (a weekly pattern generated from dates, not from a show name). */
const weeklyFriDark = (d: string): number | "-" => (d === DLR_TODAY ? "-" : wdOf(d) === 5 ? 0 : 2);

/** Service chain: one bounded request, a 7-day retry only for access/shape failures. */
export async function runDevHistoryAccessChainCases(): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const { fetchParkHistory } = await import("./entertainmentHistoryService");
  const span = (r: { from: string; to: string }) => Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000) + 1;
  const run = async (maxDays: number, answers: Array<ThemeParksResult<ThemeParksHistoryDaily> | "throw">) => {
    const asked: number[] = [];
    let i = 0;
    const res = await fetchParkHistory("disneyland", DLR_NOW, async (_id, r) => {
      asked.push(span(r));
      const a = answers[Math.min(i++, answers.length - 1)];
      if (a === "throw") throw new Error("boom");
      return a;
    }, () => ({ maxDays }));
    return { asked, res };
  };
  const good = (days: number, over: { hasMore?: boolean } = {}) => devHistoryFixture(DLR_TODAY, { x: () => 2 }, { days, ...over });
  const err = (kind: "unauthorized" | "history_window" | "rate_limited" | "timeout" | "network"): ThemeParksResult<ThemeParksHistoryDaily> => ({ ok: false, error: { kind, message: "x" } });

  let r = await run(30, [good(30)]);
  check("authenticated: ONE 30-day request when it works", r.asked.join() === "30" && r.res.ok);
  r = await run(7, [good(7)]);
  check("anonymous: ONE 7-day request", r.asked.join() === "7" && r.res.ok);
  r = await run(30, [err("history_window"), good(7)]);
  check("30-day refused (key not honored) → exactly one 7-day retry", r.asked.join() === "30,7" && r.res.ok && r.res.data.to === DLR_TODAY);
  r = await run(30, [err("unauthorized"), good(7)]);
  check("401/403 credential failure → one 7-day retry", r.asked.join() === "30,7" && r.res.ok);
  r = await run(30, [good(30, { hasMore: true }), good(7)]);
  check("paged 30-day answer (hasMore) → one 7-day retry", r.asked.join() === "30,7" && r.res.ok && !r.res.data.hasMore);
  for (const k of ["rate_limited", "timeout", "network"] as const) {
    r = await run(30, [err(k), good(7)]);
    check(`${k} on the 30-day request → no retry storm`, r.asked.join() === "30" && !r.res.ok && r.res.error.kind === k);
  }
  r = await run(30, ["throw"]);
  check("a throwing provider call never throws out of the service", !r.res.ok && r.res.error.kind === "network" && r.asked.join() === "30");
  r = await run(30, [err("history_window"), err("rate_limited")]);
  check("retry failure surfaces the last typed error", !r.res.ok && r.res.error.kind === "rate_limited" && r.asked.join() === "30,7");
  r = await run(7, [err("history_window"), good(7)]);
  check("anonymous 7-day failure is never retried", r.asked.join() === "7" && !r.res.ok);
  r = await run(5, [good(7)]);
  check("a tier reporting <7 days still asks the 7-day minimum once", r.asked.join() === "7");

  // Stale-if-error masking an access failure (review finding): the client serves the cached 30-day
  // payload as ok/stale with the refusal in staleReason — that must still reach the 7-day retry.
  const staleWith = (kind: "unauthorized" | "history_window" | "rate_limited" | "timeout"): ThemeParksResult<ThemeParksHistoryDaily> => {
    const g = good(30);
    return g.ok ? { ...g, meta: { ...g.meta, origin: "stale", staleReason: { kind, message: "x" } } } : g;
  };
  r = await run(30, [staleWith("unauthorized"), good(7)]);
  check("stale 30-day payload whose refresh was refused (401/403) → 7-day anonymous retry", r.asked.join() === "30,7" && r.res.ok && r.res.meta.origin !== "stale");
  r = await run(30, [staleWith("history_window"), good(7)]);
  check("stale payload with a window refusal → 7-day retry", r.asked.join() === "30,7");
  for (const k of ["rate_limited", "timeout"] as const) {
    r = await run(30, [staleWith(k), good(7)]);
    check(`stale payload from ${k} → no retry (it would not help)`, r.asked.join() === "30");
  }
  {
    // Real client: a cached good 30-day answer, expired, refresh refused with 403 → stale ok → retried anonymously.
    const { createThemeParksClient } = await import("./themeParksApi");
    let now = DLR_NOW.getTime(); let refuse = false; const keys: Array<string | undefined> = [];
    const client = createThemeParksClient({ apiKey: "chain-secret-key", now: () => now, fetchImpl: (async (u: unknown, init?: RequestInit) => {
      keys.push((init?.headers as Record<string, string> | undefined)?.["x-api-key"]);
      const m = /from=([\d-]+)&to=([\d-]+)/.exec(String(u))!;
      if (refuse && keys[keys.length - 1]) return new Response(JSON.stringify({ error: { type: "HISTORY_WINDOW_EXCEEDED" } }), { status: 403 });
      const d = Math.round((Date.parse(`${m[2]}T00:00:00Z`) - Date.parse(`${m[1]}T00:00:00Z`)) / 86_400_000) + 1;
      const f = devHistoryFixture(DLR_TODAY, { x: () => 2 }, { days: d });
      if (!f.ok) throw new Error("fixture");
      return new Response(JSON.stringify({ id: THEMEPARKS_PARKS.disneyland.entityId, name: "p", timezone: "America/Los_Angeles", range: { from: f.data.from, to: f.data.to }, next: null,
        entities: f.data.entities.map((e, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, entityType: "SHOW", days: e.days.map((x) => ({ date: x.date, showCount: x.showCount, operatingMinutes: x.operatingMinutes, inParkHours: { scheduledMinutes: x.scheduledMinutes } })) })) }), { status: 200 });
    }) as typeof fetch });
    const go = () => fetchParkHistory("disneyland", new Date(now), (id, rg) => client.getHistoryDaily(id, rg), () => client.historyAccess());
    const warm = await go();
    check("real client: warm 30-day fetch", warm.ok && warm.data.from === "2026-10-15");
    now += 2 * 3_600_000 - 1; refuse = true; // still the same local day? 11:00 AM PST + 2h
    const after = await go();
    check("real client: expired 30-day cache + refused refresh → falls back to a fresh anonymous 7-day answer", after.ok && after.meta.origin !== "stale" && after.data.from === "2026-11-07" && keys[keys.length - 1] === undefined);
  }
  return failures;
}

/** 30-day evidence through showtimes/All Entertainment: live wins, multi-ref, midnight, fallback, no leakage. */
export async function runDevHistoryLongWindowFilteringCases(): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const { createThemeParksClient } = await import("./themeParksApi");
  const { getParkEntertainmentShowtimes } = await import("./entertainmentShowtimesService");
  const find = (r: { entries: EntertainmentShowtimeEntry[] }, name: string) => r.entries.find((e) => e.dwpName === name)!;
  const hid = (e: EntertainmentShowtimeEntry) => e.confirmedNoActivityToday === true;
  const dq = (): LiveEntry[] => ["a", "b", "c"].map((k, i) => entry(`0000000${i}-0000-4000-8000-00000000000${i}`, [st("2026-11-13T15:00:00-08:00")], k, "OPERATING"));
  const fan = (liveEntries: LiveEntry[], hist: ThemeParksResult<ThemeParksHistoryDaily> | null, at = DLR_NOW, over = {}) =>
    find(normalizeParkEntertainmentShowtimes("disneyland", liveOf([...dq(), ...liveEntries], at, over), at, hist), "Fantasmic!");
  const h30 = (spec: Parameters<typeof devHistoryFixture>[1] = { [FANTASMIC_DLR]: weeklyFriDark }, o = {}) => devHistoryFixture(DLR_TODAY, spec, { days: 30, ...o });
  const h7 = (spec: Parameters<typeof devHistoryFixture>[1]) => devHistoryFixture(DLR_TODAY, spec, { days: 7 });

  const w = fan([entry(FANTASMIC_DLR, [])], h30());
  check("30-day weekly pattern + clean empty live + quorum → confirmed (history_weekly)", hid(w) && w.inactivityBasis === "history_weekly" && w.status === "none_posted");
  check("same entry without a published-today quorum → visible", !hid(find(normalizeParkEntertainmentShowtimes("disneyland", liveOf([entry(FANTASMIC_DLR, [])], DLR_NOW), DLR_NOW, h30()), "Fantasmic!")));
  check("live performance today beats the 30-day weekly pattern", !hid(fan([entry(FANTASMIC_DLR, [st("2026-11-13T21:30:00-08:00")])], h30())));
  check("live operating window today beats history", !hid(fan([entry(FANTASMIC_DLR, [st("2026-11-13T09:00:00-08:00", "Operating", "2026-11-13T22:00:00-08:00")])], h30())));
  check("today's history row active vetoes the 30-day pattern", !hid(fan([entry(FANTASMIC_DLR, [])], h30({ [FANTASMIC_DLR]: (d) => (d === DLR_TODAY ? 1 : weeklyFriDark(d)) }))));
  check("history failure / null → visible (no history route), forward horizon still works", !hid(fan([entry(FANTASMIC_DLR, [])], null)) && !hid(fan([entry(FANTASMIC_DLR, [])], { ok: false, error: { kind: "unauthorized", message: "x" } })) && hid(fan([entry(FANTASMIC_DLR, [st("2026-11-14T21:30:00-08:00")])], null)));
  check("paged/stale/lagging 30-day history → visible", !hid(fan([entry(FANTASMIC_DLR, [])], h30(undefined, { hasMore: true }))) && !hid(fan([entry(FANTASMIC_DLR, [])], h30(undefined, { origin: "stale" }))));
  check("schedule changed (performed the last two Fridays) → visible", !hid(fan([entry(FANTASMIC_DLR, [])], h30({ [FANTASMIC_DLR]: (d) => (d === DLR_TODAY ? "-" : wdOf(d) === 5 && d < "2026-10-30" ? 0 : 2) }))));
  check("30 days of daily performances then an empty live day → visible", !hid(fan([entry(FANTASMIC_DLR, [])], h30({ [FANTASMIC_DLR]: (d) => (d === DLR_TODAY ? "-" : 2) }))));
  check("anonymous 7-day fallback keeps the short rules (≥3 performed, ≥2 unexplained dark, ≥5 classified)", hid(fan([entry(FANTASMIC_DLR, [])], h7({ [FANTASMIC_DLR]: [2, 0, 2, 0, 2, 2, "-"] }))) && fan([entry(FANTASMIC_DLR, [])], h7({ [FANTASMIC_DLR]: [2, 0, 2, 0, 2, 2, "-"] })).inactivityBasis === "history");
  check("a Friday-dark weekly show is NOT hidden by the 7-day window alone (one dark day)", !hid(fan([entry(FANTASMIC_DLR, [])], h7({ [FANTASMIC_DLR]: [2, 2, 2, 2, 2, 0, "-"] }))));

  // Multi-ref (Bluey show + attraction): every ref needs the same evidence.
  {
    const both = [entry(BLUEY_SHOW, []), entry(BLUEY_ATTR, [])];
    const f = (hist: ThemeParksResult<ThemeParksHistoryDaily>, live: LiveEntry[] = both) =>
      find(normalizeParkEntertainmentShowtimes("disneyland", liveOf([...dq(), ...live], DLR_NOW), DLR_NOW, hist), "Bluey's Best Day Ever!");
    check("multi-ref 30-day: both refs weekly-dark → confirmed", hid(f(h30({ [BLUEY_SHOW]: weeklyFriDark, [BLUEY_ATTR]: weeklyFriDark }))));
    check("multi-ref 30-day: one ref performing daily → visible", !hid(f(h30({ [BLUEY_SHOW]: weeklyFriDark, [BLUEY_ATTR]: (d) => (d === DLR_TODAY ? "-" : 2) }))));
    check("multi-ref 30-day: one ref absent from history → visible", !hid(f(h30({ [BLUEY_SHOW]: weeklyFriDark }))));
    check("multi-ref 30-day: one ref absent from live → visible", !hid(f(h30({ [BLUEY_SHOW]: weeklyFriDark, [BLUEY_ATTR]: weeklyFriDark }), [entry(BLUEY_SHOW, [])])));
  }

  // Resort-local midnight.
  const AFTER_MIDNIGHT = new Date("2026-11-14T08:30:00Z"); // 12:30 AM PST Nov 14
  check("just after local midnight: yesterday's 30-day window is rejected", !hid(fan([entry(FANTASMIC_DLR, [])], h30(), AFTER_MIDNIGHT)));
  check("evening: 11:30 PM PST is still Nov 13 although UTC is Nov 14", (() => {
    const late = new Date("2026-11-14T07:30:00Z");
    const q = dq().map((x) => ({ ...x, showtimes: [st("2026-11-13T22:00:00-08:00")] }));
    return hid(find(normalizeParkEntertainmentShowtimes("disneyland", liveOf([...q, entry(FANTASMIC_DLR, [])], late, { fetchedAt: late.getTime() }), late, devHistoryFixture(DLR_TODAY, { [FANTASMIC_DLR]: weeklyFriDark }, { days: 30, fetchedAt: late.getTime() })), "Fantasmic!"));
  })());

  // All Entertainment shares the evidence (curated + provider-only) and honors seasonal/party rules.
  {
    const PO = "11111111-2222-4333-8444-555555555555";
    const all = buildParkAllEntertainment("disneyland", liveOf([...dq(), entry(FANTASMIC_DLR, []), { ...entry(PO, []), name: "Some Unlisted Show" }], DLR_NOW), DLR_NOW, h30({ [FANTASMIC_DLR]: weeklyFriDark, [PO]: weeklyFriDark }));
    const shown = applyAllEntertainmentSeasonalVisibility(all.entries, "disneyland", "DLR", DLR_TODAY, false, DLR_NOW);
    check("All Entertainment: curated and provider-only entries hidden on the same 30-day evidence", !shown.some((x) => x.name === "Fantasmic!" || x.name === "Some Unlisted Show") && all.entries.some((x) => x.name === "Fantasmic!"));
    check("All Entertainment without history keeps them visible", applyAllEntertainmentSeasonalVisibility(buildParkAllEntertainment("disneyland", liveOf([...dq(), entry(FANTASMIC_DLR, [])], DLR_NOW), DLR_NOW, null).entries, "disneyland", "DLR", DLR_TODAY, false, DLR_NOW).some((x) => x.name === "Fantasmic!"));
  }

  // End to end through the real client (mock transport): key tiers, fallback, no secret leakage.
  {
    const KEY = "e2e-secret-key-9876543210";
    const body = (hist: ThemeParksResult<ThemeParksHistoryDaily>) => {
      if (!hist.ok) return {};
      const d = hist.data;
      return { id: THEMEPARKS_PARKS_DLR(), name: "DLR", timezone: "America/Los_Angeles", range: { from: d.from, to: d.to }, next: null,
        entities: d.entities.map((e) => ({ id: e.entityId.length === 36 ? e.entityId : `00000000-0000-4000-8000-${String(Math.abs([...e.entityId].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 1e12).padStart(12, "0")}`, name: e.entityId, entityType: e.entityType, days: e.days.map((x) => ({ date: x.date, showCount: x.showCount, operatingMinutes: x.operatingMinutes, inParkHours: { scheduledMinutes: x.scheduledMinutes } })) })) };
    };
    const mkClient = (mode: "ok" | "badkey", apiKey: string | null) => {
      const calls: Array<{ url: string; key: string | undefined }> = [];
      const client = createThemeParksClient({
        apiKey,
        now: () => DLR_NOW.getTime(),
        fetchImpl: (async (u: unknown, init?: RequestInit) => {
          const url = String(u); const k = (init?.headers as Record<string, string> | undefined)?.["x-api-key"];
          calls.push({ url, key: k });
          const m = /from=([\d-]+)&to=([\d-]+)/.exec(url)!;
          const days = Math.round((Date.parse(`${m[2]}T00:00:00Z`) - Date.parse(`${m[1]}T00:00:00Z`)) / 86_400_000) + 1;
          if (mode === "badkey" && days > 7) return new Response(JSON.stringify({ error: { type: "HISTORY_WINDOW_EXCEEDED" } }), { status: 403 });
          return new Response(JSON.stringify(body(devHistoryFixture(DLR_TODAY, { [FANTASMIC_DLR]: weeklyFriDark }, { days }))), { status: 200 });
        }) as typeof fetch,
      });
      return { client, calls };
    };
    const liveOk = async () => liveOf([...dq(), entry(FANTASMIC_DLR, [])], DLR_NOW);
    const run = async (client: ReturnType<typeof createThemeParksClient>) =>
      getParkEntertainmentShowtimes("disneyland", { instant: DLR_NOW, getLive: liveOk, getHistory: (id, r) => client.getHistoryDaily(id, r), getHistoryAccess: () => client.historyAccess() });
    const a = mkClient("ok", KEY); const ra = await run(a.client);
    check("e2e authenticated: one 30-day request carrying the key; entry confirmed (history_weekly)", a.calls.length === 1 && a.calls[0].key === KEY && /from=2026-10-15&to=2026-11-13/.test(a.calls[0].url) && find(ra, "Fantasmic!").inactivityBasis === "history_weekly");
    const b = mkClient("badkey", KEY); const rb = await run(b.client);
    check("e2e bad key: 30-day refused → one anonymous 7-day retry without the key (short rules apply, weekly pattern alone not enough)", b.calls.length === 2 && b.calls[0].key === KEY && b.calls[1].key === undefined && /from=2026-11-07/.test(b.calls[1].url) && !hid(find(rb, "Fantasmic!")));
    const c = mkClient("ok", null); const rc = await run(c.client);
    check("e2e no key: one anonymous 7-day request, no key header", c.calls.length === 1 && c.calls[0].key === undefined && /from=2026-11-07/.test(c.calls[0].url) && !hid(find(rc, "Fantasmic!")));
    check("e2e: no secret in service responses or request URLs", ![ra, rb, rc].some((x) => JSON.stringify(x).includes(KEY)) && ![...a.calls, ...b.calls, ...c.calls].some((x) => x.url.includes(KEY)));
    const d = mkClient("ok", KEY); await run(d.client); await run(d.client);
    check("e2e: second request within the hour is served from cache (no extra provider call)", d.calls.length === 1);
  }

  // Bounded enrichment: a slow/hung history request never withholds the live result.
  {
    const { fetchParkHistoryWithin } = await import("./entertainmentHistoryService");
    const { getParkAllEntertainment } = await import("./entertainmentAllService");
    const never = () => new Promise<ThemeParksResult<ThemeParksHistoryDaily>>(() => {});
    const t0 = Date.now();
    const timed = await fetchParkHistoryWithin(25, "disneyland", DLR_NOW, never, () => ({ maxDays: 30 }));
    check("history deadline: a hung request resolves to a typed timeout at the deadline", !timed.ok && timed.error.kind === "timeout" && Date.now() - t0 < 1_000);
    const live = liveOf([...dq(), entry(FANTASMIC_DLR, [])], DLR_NOW);
    const t1 = Date.now();
    const sv = await getParkEntertainmentShowtimes("disneyland", { instant: DLR_NOW, getLive: async () => live, getHistory: never, getHistoryAccess: () => ({ maxDays: 30 }), historyDeadlineMs: 25 });
    check("showtimes: hung history → live showtimes returned promptly, entry unconfirmed", !sv.error && sv.entries.length > 0 && !hid(find(sv, "Fantasmic!")) && Date.now() - t1 < 1_000);
    const al = await getParkAllEntertainment("disneyland", { instant: DLR_NOW, getLive: async () => live, getHistory: never, getHistoryAccess: () => ({ maxDays: 30 }), historyDeadlineMs: 25 });
    check("All Entertainment: hung history → inventory returned promptly", al.entries.some((x) => x.name === "Fantasmic!") && !al.entries.find((x) => x.name === "Fantasmic!")!.showtime.confirmedNoActivityToday);
    let calls = 0;
    const sk = await getParkEntertainmentShowtimes("disneyland", { instant: DLR_NOW, getLive: async () => live, skipHistory: true, getHistory: async () => { calls++; return h30(); }, getHistoryAccess: () => ({ maxDays: 30 }) });
    check("skipHistory (Tom callers): no history request, first pass returned", calls === 0 && !hid(find(sk, "Fantasmic!")));
    const ok = await getParkEntertainmentShowtimes("disneyland", { instant: DLR_NOW, getLive: async () => live, getHistory: async () => h30(), getHistoryAccess: () => ({ maxDays: 30 }) });
    check("history inside the deadline still applies", hid(find(ok, "Fantasmic!")));
  }
  return failures;
}

function THEMEPARKS_PARKS_DLR(): string {
  return THEMEPARKS_PARKS.disneyland.entityId;
}

// ============================================
// Phase 14.4.2 Vercel-Preview history diagnostics (temporary) — DEV cases
// ============================================

/** Diagnostics: Preview-only gating, aggregate/safe output, dedupe, no extra requests, no secret leakage. */
export async function runDevHistoryDiagnosticsCases(): Promise<string[]> {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const diag = await import("./historyDiagnostics");
  const { getPartyNightEventIds } = await import("./seasonalEvents");
  const { getParkEntertainmentShowtimes } = await import("./entertainmentShowtimesService");
  const { getParkAllEntertainment } = await import("./entertainmentAllService");
  const { createThemeParksClient } = await import("./themeParksApi");
  const SECRET = "diag-secret-key-5566778899";
  const preview = { VERCEL_ENV: "preview" };
  const quorumMk = (): LiveEntry[] => ["a", "b", "c"].map((k, i) => entry(`0000000${i}-0000-4000-8000-00000000000${i}`, [st("2026-11-13T20:00:00-05:00")], k, "OPERATING"));
  const mvmcp = (d: string) => getPartyNightEventIds("mk", d).includes("mvmcp");
  // HEA-like: dark on MVMCP nights it has rows for; the 11-09 row is MISSING (a change log) → only 2 observed party-dark nights.
  const hea = (d: string): number | "-" => (d === MK_TODAY || d === "2026-11-09" ? "-" : mvmcp(d) ? 0 : 2);
  const hist = (days: number, o: Record<string, unknown> = {}) => devHistoryFixture(MK_TODAY, { [HEA]: hea }, { days, ...o });
  const liveMk = () => liveOf([...quorumMk(), entry(HEA, [])], MK_NOW);
  type S = import("./historyDiagnostics").HistoryDiagnosticSummary;
  const run = async (getHistory: GetHistoryFn, access: { maxDays: number; keyStatus?: "none" | "active" | "cooldown" }, env: Record<string, string | undefined>, sink: (t: string, s: S) => void) =>
    getParkEntertainmentShowtimes("mk", { instant: MK_NOW, getLive: async () => liveMk(), getHistory, getHistoryAccess: () => access, diagEnv: env, diagSink: sink });
  type GetHistoryFn = NonNullable<Parameters<typeof getParkEntertainmentShowtimes>[1]>["getHistory"] & object;
  const ok7 = async () => hist(7); const ok30 = async (_i: string, r: { from: string; to: string }) => hist(Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000) + 1);

  // Gating
  check("enabled only when VERCEL_ENV === 'preview'", diag.isHistoryDiagnosticsEnabled({ VERCEL_ENV: "preview" }) && ![{ VERCEL_ENV: "production" }, { VERCEL_ENV: "development" }, { VERCEL_ENV: "Preview" }, { VERCEL_ENV: "" }, {}, { NODE_ENV: "development" }, { NEXT_PUBLIC_VERCEL_ENV: "preview" }].some((e) => diag.isHistoryDiagnosticsEnabled(e as Record<string, string>)));
  for (const env of [{ VERCEL_ENV: "production" }, {}, { VERCEL_ENV: "development" }]) {
    diag._resetHistoryDiagnosticsDedupe(); const lines: S[] = [];
    await run(ok30, { maxDays: 30, keyStatus: "active" }, env, (_t, s) => lines.push(s));
    check(`no output when VERCEL_ENV=${(env as { VERCEL_ENV?: string }).VERCEL_ENV ?? "(unset)"}`, lines.length === 0);
  }
  { // default (no injected env): this process is not a Vercel Preview → silent, never throws
    diag._resetHistoryDiagnosticsDedupe(); const orig = console.info; let called = 0; console.info = () => { called++; };
    const saved = process.env.VERCEL_ENV; delete process.env.VERCEL_ENV;
    try { await getParkEntertainmentShowtimes("mk", { instant: MK_NOW, getLive: async () => liveMk(), getHistory: ok30, getHistoryAccess: () => ({ maxDays: 30 }) }); } finally { console.info = orig; if (saved !== undefined) process.env.VERCEL_ENV = saved; }
    check("default env: nothing logged", called === 0);
  }

  // Authenticated 30-day: HEA has only 2 observed MVMCP dark nights → long rule (needs 3) keeps it visible; summary says why.
  diag._resetHistoryDiagnosticsDedupe();
  let lines: S[] = []; let historyCalls = 0;
  const counting = (g: typeof ok30) => async (i: string, r: { from: string; to: string }) => { historyCalls++; return g(i, r); };
  const trace30 = await (async () => {
    const { fetchParkHistory } = await import("./entertainmentHistoryService");
    const t: import("./entertainmentHistoryService").HistoryFetchTrace = { keyStatus: "unknown", attempts: [] };
    await fetchParkHistory("mk", MK_NOW, ok30, () => ({ maxDays: 30, keyStatus: "active" }), t);
    return t;
  })();
  check("trace: tier/window/outcome recorded without issuing extra requests", trace30.attempts.length === 1 && trace30.attempts[0].days === 30 && trace30.attempts[0].tier === "authenticated" && trace30.attempts[0].outcome === "ok" && trace30.keyStatus === "active");
  const r1 = await run(counting(ok30), { maxDays: 30, keyStatus: "active" }, preview, (_t, s) => lines.push(s));
  const s1 = lines[0];
  check("preview: exactly one summary and exactly one history request", lines.length === 1 && historyCalls === 1 && r1.entries.length > 0);
  check("30-day summary: tier, windows, outcome, coverage", !!s1 && s1.tier === "authenticated" && s1.keyStatus === "active" && s1.requestedDays.join() === "30" && s1.receivedDays === 30 && s1.outcome === "ok" && s1.windowComplete === true && s1.coverage.mode === "long" && s1.evidence === "accepted" && s1.park === "mk" && s1.date === MK_TODAY && s1.partyState === "party");
  check("30-day summary: HEA kept visible with the aggregate code party_dark_insufficient, nothing hidden by history", !!s1 && s1.candidates >= 1 && (s1.keptVisible.party_dark_insufficient ?? 0) >= 1 && s1.hiddenByHistory.party === 0 && s1.hiddenByHistory.generic === 0);
  // Same data on the anonymous 7-day tier: the short party rule (≥2) hides it.
  diag._resetHistoryDiagnosticsDedupe(); lines = [];
  const r2 = await run(ok7, { maxDays: 7, keyStatus: "none" }, preview, (_t, s) => lines.push(s));
  const s2 = lines[0];
  check("7-day anonymous summary: HEA hidden by history_party; tier anonymous, key none", !!s2 && s2.tier === "anonymous" && s2.keyStatus === "none" && s2.receivedDays === 7 && s2.coverage.mode === "short" && s2.hiddenByHistory.party >= 1 && r2.entries.some((e) => e.dwpName === "Happily Ever After" && e.inactivityBasis === "history_party"));
  // Fallback, stale, paged, failure outcomes
  diag._resetHistoryDiagnosticsDedupe(); lines = [];
  const refusedThen7 = async (_i: string, r: { from: string; to: string }): Promise<ThemeParksResult<ThemeParksHistoryDaily>> => (Date.parse(r.to) - Date.parse(r.from) > 7 * 86_400_000 ? { ok: false, error: { kind: "history_window", message: SECRET } } : hist(7));
  let accessCalls = 0;
  await getParkEntertainmentShowtimes("mk", { instant: MK_NOW, getLive: async () => liveMk(), getHistory: refusedThen7, getHistoryAccess: () => ({ maxDays: ++accessCalls <= 2 ? 30 : 7, keyStatus: accessCalls <= 2 ? "active" : "cooldown" }), diagEnv: preview, diagSink: (_t, s) => lines.push(s) });
  check("fallback summary: 30 then 7 requested, outcome fallback_7d", lines.length === 1 && lines[0].requestedDays.join() === "30,7" && lines[0].outcome === "fallback_7d" && lines[0].receivedDays === 7 && lines[0].tier === "authenticated");
  const outcomeOf = async (h: ThemeParksResult<ThemeParksHistoryDaily>) => { diag._resetHistoryDiagnosticsDedupe(); const l: S[] = []; await run(async () => h, { maxDays: 7 }, preview, (_t, s) => l.push(s)); return l[0]; };
  const stale = await outcomeOf(hist(7, { origin: "stale" }));
  check("stale summary: outcome stale, evidence code stale, nothing hidden", stale.outcome === "stale" && stale.evidence === "stale" && stale.hiddenByHistory.party === 0 && (stale.keptVisible.no_evidence ?? 0) >= 1);
  const paged = await outcomeOf(hist(30, { hasMore: true }));
  check("paged summary: windowComplete false, evidence paged", paged.windowComplete === false && paged.outcome === "paged" && paged.evidence === "paged");
  const failed = await outcomeOf({ ok: false, error: { kind: "rate_limited", message: SECRET } });
  check("failure summary: failed:<kind>, evidence unavailable, no payload", failed.outcome === "failed:rate_limited" && failed.evidence === "unavailable" && failed.receivedDays === null && failed.windowComplete === null);
  const thin = await outcomeOf(devHistoryFixture(MK_TODAY, { [HEA]: hea }, { days: 30, filler: false }));
  check("thin coverage summary carries an aggregate reject code, not text", typeof thin.evidence === "string" && thin.evidence !== "accepted" && /^[a-z_]+$/.test(thin.evidence));

  // Not needed: no candidate → no request, still one concise summary
  diag._resetHistoryDiagnosticsDedupe(); lines = []; historyCalls = 0;
  await getParkEntertainmentShowtimes("mk", { instant: MK_NOW, getLive: async () => liveOf([...quorumMk(), entry(HEA, [st("2026-11-13T21:00:00-05:00")])], MK_NOW), getHistory: counting(ok30), getHistoryAccess: () => ({ maxDays: 30 }), diagEnv: preview, diagSink: (_t, s) => lines.push(s) });
  check("no candidate: zero history requests, one 'not_needed' summary", historyCalls === 0 && lines.length === 1 && lines[0].outcome === "not_needed" && lines[0].historyAttempted === false);
  // skipHistory (Tom): nothing logged, nothing requested
  diag._resetHistoryDiagnosticsDedupe(); lines = []; historyCalls = 0;
  await getParkEntertainmentShowtimes("mk", { instant: MK_NOW, getLive: async () => liveMk(), getHistory: counting(ok30), skipHistory: true, diagEnv: preview, diagSink: (_t, s) => lines.push(s) });
  check("skipHistory: no request and no diagnostics", historyCalls === 0 && lines.length === 0);

  // Dedupe + volume
  diag._resetHistoryDiagnosticsDedupe(); lines = []; historyCalls = 0;
  for (let i = 0; i < 5; i++) await run(counting(ok30), { maxDays: 30, keyStatus: "active" }, preview, (_t, s) => lines.push(s));
  check("identical decisions log once (deduped); requests are not added by diagnostics", lines.length === 1 && historyCalls === 5);
  const input = { parkId: "mk" as const, instant: MK_NOW, live: liveMk(), history: hist(30), entries: [] as EntertainmentShowtimeEntry[] };
  diag._resetHistoryDiagnosticsDedupe(); let n = 0;
  const sink = () => { n++; };
  diag.logHistoryDiagnostics(input, { env: preview, sink, nowMs: 1_000 });
  diag.logHistoryDiagnostics(input, { env: preview, sink, nowMs: 1_000 + diag.HISTORY_DIAG_DEDUPE_MS - 1 });
  diag.logHistoryDiagnostics(input, { env: preview, sink, nowMs: 1_000 + diag.HISTORY_DIAG_DEDUPE_MS });
  check("dedupe window: suppressed inside, logged again after", n === 2);
  check("a throwing sink never throws out of logging (responses unaffected)", diag.logHistoryDiagnostics(input, { env: preview, sink: () => { throw new Error("sink"); }, nowMs: 99_000_000 }) === false);
  const all = await getParkAllEntertainment("mk", { instant: MK_NOW, getLive: async () => liveMk(), getHistory: ok7, getHistoryAccess: () => ({ maxDays: 7 }), diagEnv: preview, diagSink: (() => { n += 100; }) });
  check("All Entertainment path also logs (once) and still returns the inventory", n >= 102 && all.entries.length > 0);

  // Safe output / no secret leakage
  diag._resetHistoryDiagnosticsDedupe(); lines = [];
  const SHOW_NAME = "Secret Show Name " + SECRET;
  const leakyLive = liveOf([...quorumMk(), { ...entry(HEA, []), name: SHOW_NAME, externalId: SECRET }], MK_NOW);
  await getParkEntertainmentShowtimes("mk", { instant: MK_NOW, getLive: async () => leakyLive, getHistory: async () => ({ ok: false, error: { kind: "unauthorized", message: `bad header x-api-key: ${SECRET}`, httpStatus: 403 } }), getHistoryAccess: () => ({ maxDays: 30, keyStatus: "active" }), diagEnv: preview, diagSink: (_t, s) => lines.push(s) });
  const out = JSON.stringify(lines);
  const WHITELIST = ["park", "date", "partyState", "historyAttempted", "tier", "keyStatus", "requestedDays", "receivedDays", "outcome", "windowComplete", "coverage", "evidence", "entries", "candidates", "hiddenByHistory", "hiddenByForwardHorizon", "keptVisible"].sort().join();
  check("output carries no secret, header text, provider message or entity name/id", lines.length === 1 && !out.includes(SECRET) && !/x-api-key|bearer|authorization/i.test(out) && !out.includes(HEA) && !/Secret Show/.test(out));
  check("summary fields are the fixed whitelist of primitives/aggregates", lines.length === 1 && Object.keys(lines[0]).sort().join() === WHITELIST);
  // Real client with a configured key: the logged line never contains it.
  {
    const lines2: string[] = [];
    const client = createThemeParksClient({ apiKey: SECRET, now: () => MK_NOW.getTime(), fetchImpl: (async () => new Response(JSON.stringify({ error: { type: "HISTORY_WINDOW_EXCEEDED" } }), { status: 403 })) as typeof fetch });
    diag._resetHistoryDiagnosticsDedupe();
    const { fetchParkHistoryWithin } = await import("./entertainmentHistoryService");
    const t: import("./entertainmentHistoryService").HistoryFetchTrace = { keyStatus: "unknown", attempts: [] };
    const h = await fetchParkHistoryWithin(2_000, "mk", MK_NOW, (id, r) => client.getHistoryDaily(id, r), () => client.historyAccess(), t);
    diag.logHistoryDiagnostics({ parkId: "mk", instant: MK_NOW, live: liveMk(), history: h, trace: t, entries: [] }, { env: preview, sink: (tag, s) => lines2.push(tag + JSON.stringify(s)) });
    check("real client: key refused → logged as keyStatus cooldown / fallback attempts, never the key", lines2.length === 1 && !lines2[0].includes(SECRET) && /"keyStatus":"cooldown"|"keyStatus":"active"/.test(lines2[0]) && t.attempts[0].tier === "authenticated");
    check("client.historyAccess() reports key status without exposing the key", JSON.stringify(client.historyAccess()) === JSON.stringify({ tier: "anonymous", maxDays: 7, keyStatus: "cooldown" }) && !JSON.stringify(client.historyAccess()).includes(SECRET));
    const none = createThemeParksClient({ apiKey: null });
    check("no configured key → keyStatus none", none.historyAccess().keyStatus === "none" && createThemeParksClient({ apiKey: SECRET }).historyAccess().keyStatus === "active");
  }
  return failures;
}

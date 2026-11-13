/**
 * entertainmentHistoryDev.ts — Phase 14.4.2 DEV regression cases that exercise
 * history-assisted inactivity end to end (history → showtimes/All Entertainment
 * → seasonal visibility) and the party-meet hours consistency fix. Not wired
 * into any runtime path or CI; run manually (returns failing labels):
 *
 *   runDevHistoryAssistedFilteringCases()   // sync: evidence thresholds + visibility
 *   runDevPartyMeetHoursConsistencyCases()  // async: All Entertainment vs Waits & Shows
 *
 * Pure evidence-reliability cases live beside the logic: runDevEntertainmentHistoryCases()
 * (entertainmentHistory.ts); provider-client history cases: runDevThemeParksApiCases().
 */

import type { ParkId } from "@disney-wait-planner/shared";
import { buildParkAllEntertainment, allEntryViewAt } from "./entertainmentAll";
import { devHistoryFixture } from "./entertainmentHistory";
import { getParkAllEntertainment } from "./entertainmentAllService";
import { normalizeParkEntertainmentShowtimes, type EntertainmentShowtimeEntry } from "./entertainmentShowtimes";
import { buildParkEventMeets, describeEventMeet } from "./eventExclusiveMeets";
import { applyAllEntertainmentSeasonalVisibility, isEntertainmentHiddenToday } from "./seasonalVisibility";
import { ENTERTAINMENT_PLACES } from "./entertainmentSuggestions";
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

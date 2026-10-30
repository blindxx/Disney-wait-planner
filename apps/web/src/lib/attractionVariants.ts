/**
 * attractionVariants.ts — Phase 14.3.1 reusable attraction VARIANT handling.
 *
 * Some physical attractions are published by Queue-Times as several
 * simultaneous rows, one per operating variant (Guardians of the Galaxy –
 * Mission: BREAKOUT! = QT 329 by day, Monsters After Dark = QT 5146 in the
 * evening). Wait Times / Today show ONE card for the one canonical identity;
 * this module decides which variant's provider record supplies that card, and
 * keeps every variant's own record available so planners never substitute one
 * variant's wait for another's.
 *
 * Registry is keyed by Queue-Times provider ids (names are display-only here).
 * Unregistered attractions never touch this module. Pure and client-safe.
 *
 * Live selection (selectVariantRow) — per usable row (see isUsableVariantRow):
 *   exactly one variant open  → that variant
 *   several open              → the regular variant, unless the regular row is
 *                               unusable (stale/future/malformed), which is the
 *                               provider evidence that lets another open variant win
 *   none open / no usable data→ null; caller keeps the regular row exactly as the
 *                               pre-variant code did (existing status/wait/fallback)
 * No hardcoded transition time exists; park hours never change status/wait.
 *
 * Park hours (applyVariantParkHours) only revert the DISPLAY NAME of a
 * non-regular selection back to the canonical name, and only when the existing
 * normalized `ParkHours` confirms every applicable session (regular OPERATING,
 * extended / early-entry / ticketed-event windows, a running overnight window)
 * has ended. Unknown / stale / partial hours never revert and never imply closed.
 *
 * Seasonal display names themselves still come from the Phase 14.3 overlay
 * registry (seasonalAttractionOverlays.ts); this module only supplies which
 * provider row is "selected".
 *
 * DEV checks: `runDevAttractionVariantCases()` (run manually).
 */

import { mockAttractionWaits } from "@disney-wait-planner/shared";
import type { AttractionVariantWait, AttractionWait, ParkId, ResortId } from "@disney-wait-planner/shared";
import type { ParkHours, ParkHoursWindow } from "./parkHours";
import { getResortLocalDate } from "./resortTime";

// ============================================
// REGISTRY
// ============================================

export type AttractionVariant = {
  /** Stable id within the group. */
  id: string;
  role: "regular" | "alternate";
  /** Queue-Times ride id — the registry key. */
  providerId: number;
  /** Planner-facing name (alternate variants; ≥1, first is primary). */
  plannerNames?: string[];
};

export type AttractionVariantGroup = {
  /** `AttractionWait.id` of the ONE canonical attraction. */
  canonicalId: string;
  resort: ResortId;
  parkId: ParkId;
  variants: AttractionVariant[];
};

export const ATTRACTION_VARIANT_GROUPS: AttractionVariantGroup[] = [
  {
    canonicalId: "dca-guardians", resort: "DLR", parkId: "dca",
    variants: [
      { id: "regular", role: "regular", providerId: 329 },
      {
        id: "monsters-after-dark", role: "alternate", providerId: 5146,
        plannerNames: ["Guardians of the Galaxy – Monsters After Dark", "Guardians Monsters After Dark"],
      },
    ],
  },
];

export function findVariantGroup(canonicalId: string): AttractionVariantGroup | undefined {
  return ATTRACTION_VARIANT_GROUPS.find((g) => g.canonicalId === canonicalId);
}

/** Registry lookup by provider id (resort + park scoped, so ids never collide across parks). */
export function findVariantByProviderId(
  resort: ResortId,
  parkId: ParkId,
  providerId: number,
): { group: AttractionVariantGroup; variant: AttractionVariant } | undefined {
  for (const group of ATTRACTION_VARIANT_GROUPS) {
    if (group.resort !== resort || group.parkId !== parkId) continue;
    const variant = group.variants.find((v) => v.providerId === providerId);
    if (variant) return { group, variant };
  }
  return undefined;
}

/** Planner-facing names of alternate variants for a resort (autocomplete). */
export function getVariantSuggestionNames(resort: ResortId): string[] {
  return ATTRACTION_VARIANT_GROUPS.filter((g) => g.resort === resort).flatMap((g) =>
    g.variants.filter((v) => v.role === "alternate" && v.plannerNames?.length).map((v) => v.plannerNames![0]),
  );
}

/** Every planner spelling of every alternate variant → that variant's primary planner name. */
export function findAlternateVariantByPlannerName(
  normalize: (s: string) => string,
  plannerName: string,
): { group: AttractionVariantGroup; variant: AttractionVariant; primaryName: string } | undefined {
  const key = normalize(plannerName);
  // Same supported prefix handling as lookupWait's alias stage: a leading
  // "the " is optional, so "the Guardians Monsters After Dark" is the variant too.
  const bare = key.startsWith("the ") ? key.slice(4) : key;
  for (const group of ATTRACTION_VARIANT_GROUPS) {
    for (const variant of group.variants) {
      if (variant.role !== "alternate" || !variant.plannerNames) continue;
      if (variant.plannerNames.some((n) => { const nk = normalize(n); return nk === key || nk === bare; })) {
        return { group, variant, primaryName: variant.plannerNames[0] };
      }
    }
  }
  return undefined;
}

// ============================================
// LIVE SELECTION
// ============================================

/** Minimal Queue-Times row shape (structurally identical to liveWaitApi's QTRide). */
export type VariantProviderRow = {
  id: number;
  name: string;
  is_open: boolean;
  wait_time: number;
  last_updated: string;
};

/** An open row older than this is not trusted as current (Queue-Times refreshes open rides far more often). */
export const VARIANT_ROW_MAX_AGE_MS = 30 * 60_000;
/** Clock-skew tolerance for a `last_updated` slightly ahead of `now`. */
export const VARIANT_ROW_FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Well-formed and fresh: boolean status, finite non-negative wait, parseable timestamp within bounds of `now`. */
export function isUsableVariantRow(row: VariantProviderRow | undefined, now: Date): row is VariantProviderRow {
  if (!row || typeof row.is_open !== "boolean") return false;
  if (typeof row.wait_time !== "number" || !Number.isFinite(row.wait_time) || row.wait_time < 0) return false;
  const t = Date.parse(row.last_updated);
  if (Number.isNaN(t)) return false;
  const age = now.getTime() - t;
  return age <= VARIANT_ROW_MAX_AGE_MS && age >= -VARIANT_ROW_FUTURE_TOLERANCE_MS;
}

/**
 * The variant whose provider row should supply the card, or null to keep the
 * pre-variant behavior (regular row as-is). `rows` maps variant id → its own
 * provider row; rows are never merged or freshness-deduped across variants.
 */
export function selectVariantRow(
  group: AttractionVariantGroup,
  rows: ReadonlyMap<string, VariantProviderRow>,
  now: Date,
): { variantId: string; row: VariantProviderRow } | null {
  const open = group.variants
    .map((v) => ({ v, row: rows.get(v.id) }))
    .filter((x): x is { v: AttractionVariant; row: VariantProviderRow } => isUsableVariantRow(x.row, now) && x.row.is_open);
  if (open.length === 0) return null;
  const pick = open.find((x) => x.v.role === "regular") ?? open.sort((a, b) => Date.parse(b.row.last_updated) - Date.parse(a.row.last_updated))[0];
  return { variantId: pick.v.id, row: pick.row };
}

/**
 * Each variant's OWN provider record for planners. Regular: whenever a row
 * exists (mirrors pre-variant behavior). Alternates: only when usable AND open,
 * so a closed/stale/missing alternate yields no entry (→ no badge).
 */
export function buildVariantWaits(
  group: AttractionVariantGroup,
  canonicalName: string,
  rows: ReadonlyMap<string, VariantProviderRow>,
  now: Date,
): AttractionVariantWait[] {
  const out: AttractionVariantWait[] = [];
  for (const v of group.variants) {
    const row = rows.get(v.id);
    if (!row) continue;
    if (v.role === "regular") {
      out.push({
        variantId: v.id, role: "regular", name: canonicalName,
        status: row.is_open ? "OPERATING" : "DOWN", waitMins: row.is_open ? row.wait_time : null, updatedAt: row.last_updated,
      });
    } else if (isUsableVariantRow(row, now) && row.is_open) {
      out.push({
        variantId: v.id, role: "alternate", name: v.plannerNames?.[0] ?? row.name,
        status: "OPERATING", waitMins: row.wait_time, updatedAt: row.last_updated,
      });
    }
  }
  return out;
}

// ============================================
// PLANNER EXPANSION
// ============================================

/**
 * One planner wait row per variant, each carrying ONLY its own provider data.
 * Non-variant attractions pass through untouched. The regular row keeps the
 * card as-is unless an alternate supplied it, in which case the regular
 * variant's own record (or, absent that, the mock fallback) is used — never the
 * alternate's wait.
 */
export function expandVariantWaitRows(source: AttractionWait[]): AttractionWait[] {
  const out: AttractionWait[] = [];
  for (const a of source) {
    if (!a.variantWaits || !findVariantGroup(a.id)) { out.push(a); continue; }
    const regular = a.variantWaits.find((w) => w.role === "regular");
    if (!a.selectedVariantId || a.selectedVariantId === regular?.variantId) {
      out.push(a);
    } else if (regular) {
      out.push({ ...a, status: regular.status, waitMins: regular.waitMins, updatedAt: regular.updatedAt, waitSource: "live", selectedVariantId: undefined, variantWaits: undefined });
    } else {
      const mock = mockAttractionWaits.find((m) => m.id === a.id);
      if (mock) out.push({ ...a, status: mock.status, waitMins: mock.waitMins, updatedAt: mock.updatedAt, waitSource: "fallback", selectedVariantId: undefined, variantWaits: undefined });
    }
    for (const w of a.variantWaits) {
      if (w.role !== "alternate") continue;
      out.push({ ...a, id: `${a.id}:${w.variantId}`, name: w.name, displayName: undefined, status: w.status, waitMins: w.waitMins, updatedAt: w.updatedAt, waitSource: "live", selectedVariantId: undefined, variantWaits: undefined });
    }
  }
  return out;
}

// ============================================
// PARK-HOURS DISPLAY REVERT
// ============================================

function windowBounds(w: ParkHoursWindow): { open: number; close: number } | null {
  const open = Date.parse(w.openingTime);
  const close = Date.parse(w.closingTime);
  return Number.isFinite(open) && Number.isFinite(close) && close > open ? { open, close } : null;
}

/**
 * True only when the existing normalized ParkHours CONFIRMS that no applicable
 * session is running and none has yet to end today: every regular OPERATING,
 * additional (extended / early-entry / ticketed-event) and carried-over
 * overnight window has closed (or, before the first opening, yesterday is
 * verified not to run on). Unavailable / unknown / stale / partially-dropped
 * data, a prior-day payload, or being between sessions → false (never assume closed).
 */
export function confirmsAllSessionsEnded(data: ParkHours | null, instant: Date): boolean {
  if (!data || data.stale || data.droppedEntries > 0) return false;
  if (data.status !== "hours" && data.status !== "closed") return false;
  if (data.localDate !== getResortLocalDate(data.resort, instant)) return false;
  const nowMs = instant.getTime();
  const overnight = data.overnight ?? { state: "unverified" as const, windows: [] };

  let overnightClear = overnight.state === "none";
  if (overnight.state === "in_progress") {
    const bounds = overnight.windows.map(windowBounds);
    if (bounds.some((b) => !b)) return false;
    if (bounds.some((b) => b!.close > nowMs)) return false; // still running
    overnightClear = true; // fetched carry-over has since ended
  }

  if (data.status === "closed") return overnightClear;

  const all = [...data.operating, ...data.additional].map(windowBounds);
  if (all.length === 0 || all.some((b) => !b)) return false;
  const wins = all as { open: number; close: number }[];
  if (wins.some((b) => b.open <= nowMs && nowMs < b.close)) return false;
  if (nowMs >= Math.max(...wins.map((b) => b.close))) return true;
  if (nowMs < Math.min(...wins.map((b) => b.open))) return overnightClear;
  return false; // between sessions
}

/**
 * Display-only: when a non-regular variant supplied the card but the park's
 * sessions are confirmed over, drop `displayName` so the canonical (regular)
 * name shows. Status / wait / timestamp are never touched.
 */
export function applyVariantParkHours(
  attractions: AttractionWait[],
  parkHours: ParkHours | null,
  instant: Date,
): AttractionWait[] {
  if (!attractions.some((a) => a.selectedVariantId && a.displayName)) return attractions;
  if (!confirmsAllSessionsEnded(parkHours, instant)) return attractions;
  return attractions.map((a) => {
    const group = findVariantGroup(a.id);
    const selected = group?.variants.find((v) => v.id === a.selectedVariantId);
    return selected && selected.role !== "regular" && a.displayName ? { ...a, displayName: undefined } : a;
  });
}

// ============================================
// DEV CASES
// ============================================

/**
 * DEV checks (not wired into CI; run manually from Node, e.g. via tsx):
 *   console.log(runDevAttractionVariantCases()); // [] when everything passes
 * Normalization integration cases live in `DEV_VARIANT_NORMALIZATION_CASES`
 * (liveWaitApi.ts); planner lookup cases in `DEV_VARIANT_PLANNER_CASES`
 * (plansMatching.ts).
 */
export type DevAttractionVariantCase = { label: string; ok: () => boolean };

const NOW = new Date("2026-10-30T04:00:00Z"); // 21:00 PDT on 2026-10-29
const iso = (minsAgo: number) => new Date(NOW.getTime() - minsAgo * 60_000).toISOString();
const row = (id: number, open: boolean, wait: number, minsAgo = 1): VariantProviderRow => ({ id, name: `r${id}`, is_open: open, wait_time: wait, last_updated: iso(minsAgo) });
const G = ATTRACTION_VARIANT_GROUPS[0];
const rows = (reg?: VariantProviderRow, alt?: VariantProviderRow) => {
  const m = new Map<string, VariantProviderRow>();
  if (reg) m.set("regular", reg);
  if (alt) m.set("monsters-after-dark", alt);
  return m;
};
const sel = (reg?: VariantProviderRow, alt?: VariantProviderRow) => selectVariantRow(G, rows(reg, alt), NOW)?.variantId ?? null;

const win = (open: string, close: string, type = "OPERATING"): ParkHoursWindow => ({
  date: open.slice(0, 10), type, description: null, openingTime: open, closingTime: close, opens: "", closes: "", lastUpdated: null,
});
const hoursAt = (over: Partial<ParkHours>): ParkHours => ({
  parkId: "dca", resort: "DLR", localDate: "2026-10-29", asOf: NOW.toISOString(), status: "hours", unknownReason: null,
  operating: [win("2026-10-29T08:00:00-07:00", "2026-10-29T22:00:00-07:00")], additional: [], nextOpening: null,
  overnight: { state: "none", windows: [] }, stale: false, meta: null, error: null, droppedEntries: 0, ...over,
});
const at = (isoStr: string) => new Date(isoStr);
const card = (over: Partial<AttractionWait> = {}): AttractionWait => ({
  ...mockAttractionWaits.find((m) => m.id === "dca-guardians")!, selectedVariantId: "monsters-after-dark",
  displayName: "Guardians of the Galaxy – Monsters After Dark", status: "OPERATING", waitMins: 25, ...over,
});

export const DEV_ATTRACTION_VARIANT_CASES: DevAttractionVariantCase[] = [
  { label: "registry: provider ids resolve, scoped by park", ok: () => findVariantByProviderId("DLR", "dca", 5146)?.variant.id === "monsters-after-dark" && findVariantByProviderId("DLR", "dca", 329)?.variant.role === "regular" && !findVariantByProviderId("DLR", "disneyland", 329) && !findVariantByProviderId("WDW", "dca", 329) },
  // Open/closed combinations
  { label: "regular open, alt closed → regular", ok: () => sel(row(329, true, 40), row(5146, false, 0)) === "regular" },
  { label: "regular closed, alt open → alt", ok: () => sel(row(329, false, 0), row(5146, true, 25)) === "monsters-after-dark" },
  { label: "both open → regular", ok: () => sel(row(329, true, 40), row(5146, true, 25)) === "regular" },
  { label: "both open, regular stale (provider evidence) → alt", ok: () => sel(row(329, true, 40, 120), row(5146, true, 25)) === "monsters-after-dark" },
  { label: "both open, alt stale → regular", ok: () => sel(row(329, true, 40), row(5146, true, 25, 120)) === "regular" },
  { label: "neither open → null (existing regular behavior)", ok: () => sel(row(329, false, 0), row(5146, false, 0)) === null },
  // Missing / unusable
  { label: "alt missing, regular open → regular", ok: () => sel(row(329, true, 40)) === "regular" },
  { label: "regular missing, alt open → alt", ok: () => sel(undefined, row(5146, true, 25)) === "monsters-after-dark" },
  { label: "both missing → null", ok: () => sel() === null },
  { label: "stale-only open alt, regular closed → null (existing fallback)", ok: () => sel(row(329, false, 0), row(5146, true, 25, 120)) === null },
  { label: "malformed timestamp / wait → unusable", ok: () => sel(row(329, false, 0), { ...row(5146, true, 25), last_updated: "nope" }) === null && sel(undefined, { ...row(5146, true, 25), wait_time: NaN }) === null },
  { label: "future timestamp beyond skew → unusable; small skew ok", ok: () => sel(undefined, row(5146, true, 25, -60)) === null && sel(undefined, row(5146, true, 25, -2)) === "monsters-after-dark" },
  // Wait isolation
  { label: "variantWaits: alt only when usable AND open; regular whenever a row exists", ok: () => {
    const both = buildVariantWaits(G, "X", rows(row(329, true, 40), row(5146, true, 25)), NOW);
    const closedAlt = buildVariantWaits(G, "X", rows(row(329, true, 40), row(5146, false, 0)), NOW);
    const staleAlt = buildVariantWaits(G, "X", rows(row(329, true, 40), row(5146, true, 25, 120)), NOW);
    const closedReg = buildVariantWaits(G, "X", rows(row(329, false, 0)), NOW);
    return both.length === 2 && both[0].waitMins === 40 && both[1].waitMins === 25 && closedAlt.length === 1 && staleAlt.length === 1 && closedReg[0].status === "DOWN" && closedReg[0].waitMins === null;
  } },
  { label: "expand: non-variant passes through unchanged", ok: () => { const a = mockAttractionWaits[0]; const r = expandVariantWaitRows([a]); return r.length === 1 && r[0] === a; } },
  { label: "expand: regular selected → card + alt row with its own wait", ok: () => {
    const a = card({ selectedVariantId: "regular", displayName: undefined, status: "OPERATING", waitMins: 40, variantWaits: [
      { variantId: "regular", role: "regular", name: "R", status: "OPERATING", waitMins: 40, updatedAt: iso(1) },
      { variantId: "monsters-after-dark", role: "alternate", name: "M", status: "OPERATING", waitMins: 25, updatedAt: iso(1) },
    ] });
    const r = expandVariantWaitRows([a]);
    return r.length === 2 && r[0].name === a.name && r[0].waitMins === 40 && r[1].name === "M" && r[1].waitMins === 25;
  } },
  { label: "expand: alt selected → regular row keeps ITS record, never the alt's wait", ok: () => {
    const a = card({ waitMins: 25, variantWaits: [
      { variantId: "regular", role: "regular", name: "R", status: "DOWN", waitMins: null, updatedAt: iso(2) },
      { variantId: "monsters-after-dark", role: "alternate", name: "M", status: "OPERATING", waitMins: 25, updatedAt: iso(1) },
    ] });
    const r = expandVariantWaitRows([a]);
    return r[0].name === a.name && r[0].status === "DOWN" && r[0].waitMins === null && r[1].waitMins === 25;
  } },
  { label: "expand: alt selected, regular row missing → mock fallback, not alt wait; no alt entry if alt absent", ok: () => {
    const a = card({ waitMins: 25, variantWaits: [{ variantId: "monsters-after-dark", role: "alternate", name: "M", status: "OPERATING", waitMins: 25, updatedAt: iso(1) }] });
    const r = expandVariantWaitRows([a]);
    const mock = mockAttractionWaits.find((m) => m.id === "dca-guardians")!;
    const none = expandVariantWaitRows([card({ selectedVariantId: undefined, variantWaits: [{ variantId: "regular", role: "regular", name: "R", status: "OPERATING", waitMins: 40, updatedAt: iso(1) }] })]);
    return r[0].waitMins === mock.waitMins && r[0].waitSource === "fallback" && r.length === 2 && none.length === 1;
  } },
  // Park-hours reset
  { label: "hours: after regular close → reverts display name only", ok: () => {
    const out = applyVariantParkHours([card()], hoursAt({}), at("2026-10-30T06:00:00Z"));
    return out[0].displayName === undefined && out[0].status === "OPERATING" && out[0].waitMins === 25 && out[0].selectedVariantId === "monsters-after-dark";
  } },
  { label: "hours: park open → no revert", ok: () => applyVariantParkHours([card()], hoursAt({}), NOW)[0].displayName !== undefined },
  { label: "hours: extended session still running after regular close → no revert; after it ends → revert", ok: () => {
    const h = hoursAt({ additional: [win("2026-10-29T22:00:00-07:00", "2026-10-29T23:45:00-07:00", "TICKETED_EVENT")] });
    return applyVariantParkHours([card()], h, at("2026-10-30T06:00:00Z"))[0].displayName !== undefined && applyVariantParkHours([card()], h, at("2026-10-30T06:50:00Z"))[0].displayName === undefined;
  } },
  { label: "hours: overnight (past-midnight) window running → no revert; ended → revert", ok: () => {
    const h = hoursAt({ localDate: "2026-10-30", operating: [win("2026-10-30T08:00:00-07:00", "2026-10-30T22:00:00-07:00")], overnight: { state: "in_progress", windows: [win("2026-10-29T08:00:00-07:00", "2026-10-30T01:00:00-07:00")] } });
    return applyVariantParkHours([card()], h, at("2026-10-30T07:30:00Z"))[0].displayName !== undefined && applyVariantParkHours([card()], h, at("2026-10-30T09:00:00Z"))[0].displayName === undefined;
  } },
  { label: "hours: between sessions → no revert", ok: () => {
    const h = hoursAt({ operating: [win("2026-10-29T08:00:00-07:00", "2026-10-29T14:00:00-07:00"), win("2026-10-29T18:00:00-07:00", "2026-10-29T23:00:00-07:00")] });
    return applyVariantParkHours([card()], h, at("2026-10-29T23:00:00Z"))[0].displayName !== undefined;
  } },
  { label: "hours: unknown / unavailable / stale / null / dropped / prior-day / unverified-overnight-before-open → no revert", ok: () => {
    const t = at("2026-10-30T06:00:00Z");
    const keep = (h: ParkHours | null, when = t) => applyVariantParkHours([card()], h, when)[0].displayName !== undefined;
    return keep(null) && keep(hoursAt({ status: "unknown", unknownReason: "closure_unverified", operating: [] })) && keep(hoursAt({ status: "unavailable", operating: [] })) && keep(hoursAt({ stale: true })) && keep(hoursAt({ droppedEntries: 1 })) && keep(hoursAt({ localDate: "2026-10-28" })) &&
      keep(hoursAt({ localDate: "2026-10-30", operating: [win("2026-10-30T08:00:00-07:00", "2026-10-30T22:00:00-07:00")], overnight: { state: "unverified", windows: [] } }), at("2026-10-30T10:00:00Z"));
  } },
  { label: "hours: confirmed closed today / before opening with verified overnight → revert", ok: () => applyVariantParkHours([card()], hoursAt({ status: "closed", operating: [] }), NOW)[0].displayName === undefined && applyVariantParkHours([card()], hoursAt({ localDate: "2026-10-30", operating: [win("2026-10-30T08:00:00-07:00", "2026-10-30T22:00:00-07:00")] }), at("2026-10-30T10:00:00Z"))[0].displayName === undefined },
  { label: "hours: regular selection and other attractions are never altered", ok: () => {
    const reg = card({ selectedVariantId: "regular", displayName: undefined });
    const other = { ...mockAttractionWaits[0], displayName: "Seasonal" };
    const out = applyVariantParkHours([reg, other], hoursAt({}), at("2026-10-30T06:00:00Z"));
    return out[0] === reg && out[1] === other;
  } },
];

export function runDevAttractionVariantCases(): string[] {
  return DEV_ATTRACTION_VARIANT_CASES.filter((c) => {
    try { return !c.ok(); } catch { return true; }
  }).map((c) => c.label);
}

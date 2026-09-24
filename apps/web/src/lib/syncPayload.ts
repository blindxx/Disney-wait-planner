/**
 * syncPayload.ts — Phase 7.6 Sync Scope Expansion
 *
 * Types and helpers for the combined planner sync payload.
 * The synced payload bundles both plans and lightning data
 * for a single signed-in user + active profile.
 *
 * Payload shape:
 *   { version: 1, plans: { version, items[] }, lightning: { version, items[] }, days?: string[] }
 *
 * Phase 11.2 Codex fix — `days` (the profile's ordered day list) is an
 * optional addition to this same version-1 shape, not a version bump: the
 * outer `version` stays 1 so existing stored rows and any code still
 * reading the pre-days shape remain valid. Older/legacy payloads omit
 * `days` entirely — callers must treat its absence as "no synced order",
 * not as an error, and fall back to their existing local reconstruction
 * (see plans/page.tsx and lightning/page.tsx pull handling).
 */

// ===== TYPES =====

export interface SyncedPlannerPayload {
  version: 1;
  plans: {
    version: number;
    items: unknown[];
  };
  lightning: {
    version: number;
    items: unknown[];
  };
  /**
   * Phase 11.2 Codex fix — the profile's ordered days[] (stable dayIds in
   * their persisted display order), when the pushing device had a valid
   * local order to send. Optional and omitted when absent — see the
   * module doc above.
   */
  days?: string[];
  /**
   * SH.3.2 — per-day custom label/date annotations (dayId -> {label?, date?}),
   * promoted from SH.3.1's local-only durable storage into a synced domain.
   * Optional and OMITTED when the pushing device has no opinion (a legacy
   * client, or a device that has never touched dayMeta locally) — see
   * sanitizeDayMeta()'s own doc for why this is never conflated with a
   * present-but-empty `{}`, which is an INTENTIONAL clear and always
   * included verbatim.
   */
  dayMeta?: Record<string, { label?: string; date?: string }>;
  /**
   * SH.3.3 — per-day explicit park assignment (dayId -> ParkId string),
   * promoted from SH.3.1's local-only durable storage into a synced domain,
   * mirroring dayMeta's own SH.3.2 promotion exactly. Optional and OMITTED
   * when the pushing device has no opinion (a legacy client, or a device
   * that has never touched dayParks locally) — see sanitizeDayParks()'s own
   * doc for why this is never conflated with a present-but-empty `{}`,
   * which is an INTENTIONAL clear and always included verbatim.
   */
  dayParks?: Record<string, string>;
}

// Canonical day ID shape, matching plans/page.tsx's VALID_DAY_ID_RE.
const DAY_ID_RE = /^day-[1-9]\d*$/;
// SH.3.2 — matches plans/page.tsx's isValidIsoCalendarDate() structural
// shape (full calendar rollover strictness is that local write path's own
// job; this sanitizer only needs to reject grossly malformed cloud content).
const DAY_META_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// SH.3.3 — the single maintained source of truth for valid park IDs is
// PARK_TO_RESORT (crossDayChecks.ts). It cannot be imported here directly:
// crossDayChecks.ts itself imports from this module (capturePreFetchDomainSnapshot,
// resolvePostFetchDomainBaseline, etc.), so importing it back would create a
// circular dependency. This literal list duplicates PARK_TO_RESORT's keys for
// the same reason DAY_ID_RE above duplicates plans/page.tsx's VALID_DAY_ID_RE —
// keep in sync with PARK_TO_RESORT if the supported park set ever changes.
const VALID_PARK_IDS: ReadonlySet<string> = new Set([
  "disneyland",
  "dca",
  "mk",
  "epcot",
  "hs",
  "ak",
]);

/**
 * Normalize a raw value down to a valid ordered days[] array (preserving
 * first-occurrence order), or undefined if it isn't an array at all — a
 * missing/non-array `days` stays absent rather than manufacturing one, so
 * legacy payloads that never supplied the field are untouched. Shared by
 * the builder (push), the parser (pull and, via parseSyncedPlannerPayload,
 * the server's legacy-writer preservation) so every path that can produce
 * or accept a synced days[] applies the exact same rules.
 *
 * Phase 11.2 Codex fix — matches loadDays() (plans/page.tsx) and
 * loadKnownDays() (lightning/page.tsx) exactly, rather than merely
 * filtering: each raw entry is normalized in place (a malformed entry
 * becomes "day-1" in its own slot, same as normalizeDayId's fallback),
 * then "day-1" is appended if it still never appeared. Filtering alone
 * (the previous behavior) could produce a valid-but-day-1-less order —
 * e.g. ["bad","day-2"] sanitized to ["day-2"] — silently violating the
 * planner's permanent baseline-day invariant that every page loader
 * already enforces on read. Normalizing instead of dropping also means an
 * array that is present but contains no genuinely valid entries at all
 * (e.g. ["not-a-real-day", 123]) now sanitizes to ["day-1"], matching
 * what loadDays()/loadKnownDays() would themselves produce from that same
 * raw array (they treat any non-empty array as "there is a days list
 * here", never as "absent") — it is only a fully missing/non-array value
 * that stays absent.
 */
function sanitizeDaysOrder(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const d of raw) {
    const id = typeof d === "string" && DAY_ID_RE.test(d) ? d : "day-1";
    if (!seen.has(id)) {
      seen.add(id);
      valid.push(id);
    }
  }
  // Defensive baseline, same as the loaders' own fallback: appended (never
  // unshifted) so it never overrides a genuinely persisted order — this
  // only triggers when every raw entry was a distinct, genuinely valid
  // non-day-1 ID (the normalize loop above already backfills day-1 for
  // anything else, including a fully empty raw array).
  if (!seen.has("day-1")) valid.push("day-1");
  return valid.length > 0 ? valid : undefined;
}

/**
 * SH.3.2 — sanitizes a single raw dayMeta entry down to `{label?, date?}` or
 * `null` when neither field survives validation. Mirrors plans/page.tsx's
 * parseDayMetaRaw() entry-level rules: label is a trimmed string, date must
 * structurally look like YYYY-MM-DD (see DAY_META_DATE_RE's own doc for why
 * full calendar-rollover strictness is left to the local write path), and an
 * entry with neither survives as `null` rather than an empty `{}` object —
 * matching the local sanitizer's own "drop empty entries" rule.
 */
function sanitizeDayMetaEntry(raw: unknown): { label?: string; date?: string } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const label = typeof entry.label === "string" ? entry.label.trim() : "";
  const rawDate = typeof entry.date === "string" ? entry.date.trim() : "";
  const date = DAY_META_DATE_RE.test(rawDate) ? rawDate : "";
  if (!label && !date) return null;
  return { ...(label ? { label } : {}), ...(date ? { date } : {}) };
}

/**
 * SH.3.2 — sanitizes a raw dayMeta record (dayId -> entry), or `undefined`
 * when `raw` isn't a plain object at all (an array, `null`, or a primitive) —
 * the object-shaped analogue of sanitizeDaysOrder() above, with one
 * deliberate difference: unlike days[] (which always backfills a "day-1"
 * baseline), dayMeta has no such invariant — a genuinely empty `{}` is a
 * valid, meaningful value (an INTENTIONAL clear — see the module doc and
 * SyncedPlannerPayload.dayMeta's own doc), so this returns `{}` rather than
 * `undefined` whenever `raw` is structurally a plain object, even if every
 * entry inside it gets filtered out. Only a structurally-wrong `raw` (never
 * a merely-empty one) degrades to `undefined` ("no opinion" — preserve
 * whatever cloud/existing storage already holds), exactly mirroring
 * sanitizeDaysOrder()'s own non-array-degrades-to-absent rule.
 */
export function sanitizeDayMeta(
  raw: unknown
): Record<string, { label?: string; date?: string }> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, { label?: string; date?: string }> = {};
  for (const [dayId, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!DAY_ID_RE.test(dayId)) continue;
    const entry = sanitizeDayMetaEntry(entryRaw);
    if (entry) result[dayId] = entry;
  }
  return result;
}

/**
 * SH.3.3 — sanitizes a raw dayParks record (dayId -> ParkId string), or
 * `undefined` when `raw` isn't a plain object at all — mirrors
 * sanitizeDayMeta() exactly, one level simpler (each entry is a validated
 * ParkId string rather than a nested {label?,date?} object): only a
 * structurally-wrong `raw` degrades to `undefined` ("no opinion" — preserve
 * whatever cloud/existing storage already holds); a genuinely empty `{}` is
 * a valid, meaningful INTENTIONAL clear (see SyncedPlannerPayload.dayParks'
 * own doc) and is always returned as a real empty record. Entries keyed by
 * an invalid day ID, or whose value isn't a known park ID (VALID_PARK_IDS —
 * see its own doc for why the supported-park-ID list is duplicated here),
 * are dropped rather than rejecting the whole record — same "sanitize, don't
 * reject" treatment sanitizeDayMeta() gives a malformed entry.
 */
export function sanitizeDayParks(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, string> = {};
  for (const [dayId, valueRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!DAY_ID_RE.test(dayId)) continue;
    if (typeof valueRaw === "string" && VALID_PARK_IDS.has(valueRaw)) {
      result[dayId] = valueRaw;
    }
  }
  return result;
}

// ===== BUILDERS =====

export function buildSyncedPlannerPayload(
  plans: { version: number; items: unknown[] },
  lightning: { version: number; items: unknown[] },
  // Accepts unknown[] (not just string[]) since sanitizeDaysOrder() below
  // filters/validates at runtime anyway — callers can pass a raw parsed
  // localStorage value without pre-validating it themselves.
  days?: unknown[],
  // SH.3.2 — accepts unknown (not the validated record shape) for the same
  // reason `days` does: sanitizeDayMeta() below validates at runtime.
  // `undefined` (the caller has no opinion — e.g. it never read a local
  // dayMeta key at all) is DELIBERATELY DISTINCT from a present `{}` — see
  // sanitizeDayMeta()'s own doc for why only the former is ever omitted.
  dayMeta?: unknown,
  // SH.3.3 — same contract as `dayMeta` above, for the newly synced
  // dayParks domain: `undefined` (no opinion) vs. a present `{}`
  // (intentional clear) — see sanitizeDayParks()'s own doc.
  dayParks?: unknown
): SyncedPlannerPayload {
  const sanitizedDays = sanitizeDaysOrder(days);
  const sanitizedDayMeta = dayMeta === undefined ? undefined : sanitizeDayMeta(dayMeta);
  const sanitizedDayParks = dayParks === undefined ? undefined : sanitizeDayParks(dayParks);
  return {
    version: 1,
    plans,
    lightning,
    ...(sanitizedDays ? { days: sanitizedDays } : {}),
    ...(sanitizedDayMeta !== undefined ? { dayMeta: sanitizedDayMeta } : {}),
    ...(sanitizedDayParks !== undefined ? { dayParks: sanitizedDayParks } : {}),
  };
}

// ===== PARSERS / VALIDATORS =====

/**
 * Parse and validate a raw unknown value as a SyncedPlannerPayload.
 * Returns null if the shape is missing or invalid — callers treat null as
 * "no data" and fall through to local-only mode.
 *
 * `days`, when present, is sanitized rather than treated as all-or-nothing
 * like plans/lightning: a non-array (or entirely missing) `days` degrades
 * to "absent" (undefined) instead of rejecting an otherwise-valid payload —
 * plans/lightning data must never be discarded over a corrupted `days` tag
 * on an incidental field older clients never wrote. A present array is
 * always normalized (never dropped) — see sanitizeDaysOrder — so it never
 * comes back missing the planner's permanent "day-1" baseline day.
 */
export function parseSyncedPlannerPayload(raw: unknown): SyncedPlannerPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return null;

  // Validate plans sub-object
  if (!r.plans || typeof r.plans !== "object" || Array.isArray(r.plans)) return null;
  const plans = r.plans as Record<string, unknown>;
  if (typeof plans.version !== "number" || !Array.isArray(plans.items)) return null;

  // Validate lightning sub-object
  if (!r.lightning || typeof r.lightning !== "object" || Array.isArray(r.lightning)) return null;
  const lightning = r.lightning as Record<string, unknown>;
  if (typeof lightning.version !== "number" || !Array.isArray(lightning.items)) return null;

  const days = sanitizeDaysOrder(r.days);
  // SH.3.2 — same "degrade to absent, never reject the whole payload" rule
  // `days` gets: a present-but-malformed r.dayMeta (not a plain object) is
  // simply treated as "this payload has no opinion on dayMeta", never as a
  // reason to reject an otherwise-valid plans/lightning payload. A present
  // r.dayMeta that IS structurally a plain object always sanitizes to a real
  // (possibly empty) record — see sanitizeDayMeta()'s own doc.
  const dayMeta = r.dayMeta !== undefined ? sanitizeDayMeta(r.dayMeta) : undefined;
  // SH.3.3 — same "degrade to absent, never reject the whole payload" rule
  // as dayMeta above, applied to the newly synced dayParks domain.
  const dayParks = r.dayParks !== undefined ? sanitizeDayParks(r.dayParks) : undefined;

  return {
    version: 1,
    plans: { version: plans.version as number, items: plans.items as unknown[] },
    lightning: { version: lightning.version as number, items: lightning.items as unknown[] },
    ...(days ? { days } : {}),
    ...(dayMeta !== undefined ? { dayMeta } : {}),
    ...(dayParks !== undefined ? { dayParks } : {}),
  };
}

// ===== PER-DOMAIN CONFIRMED STATE (SH.2, Codex P1 11th round) =====

/**
 * SH.2 architecture (Codex P1, 11th round) — REPLACES the single mixed-
 * domain `ConfirmedPlannerSnapshot { revision; snapshot }` (one global
 * revision covering plans+lightning+days together). Codex found this
 * unsound: disjoint pulls/pushes can confirm DIFFERENT domains at
 * DIFFERENT server revisions (e.g. a Days-only cloud win at revision 7,
 * while Plans is still only confirmed as of revision 5 from an earlier,
 * separate commit) — assigning the WHOLE mixed snapshot a single "newest"
 * revision makes the OLDER domain look newer than it genuinely is,
 * silently blocking a later, perfectly legitimate update to that domain
 * (its real revision is lower than the mixed snapshot's borrowed one, so a
 * correct future commit at, say, revision 6 for Plans would be wrongly
 * rejected as "stale" against the borrowed revision 7).
 *
 * The fix: confirmed state is tracked PER DOMAIN. Each of plans/lightning/
 * days independently carries its OWN `{ revision, value }` fact — see
 * `ConfirmedPlannerState` below. A confirmation at revision R may advance
 * ONLY the domain(s) actually accepted at R; every other domain retains
 * its own prior revision/value completely untouched. A later response
 * with a LOWER revision than some OTHER domain's confirmed revision may
 * still legitimately advance a domain whose OWN confirmed revision is
 * lower — there is no "reject the whole mixed commit" step anymore,
 * because there is no whole mixed commit to reject: each domain's fate is
 * decided independently, using ONLY that domain's own revision history.
 */
export interface ConfirmedDomainFact<T> {
  revision: number;
  value: T;
}

/**
 * Codex P1 fix (16th round) — every field is now a REQUIRED
 * ConfirmedDomainResult (see its own doc below), never merely an optional
 * fact. The old `plans?: ConfirmedDomainFact<...>` shape could only ever
 * say "here's the fact" or "absent" — it had no way to represent "the
 * newest revision exists but is CONFLICTED", so getConfirmedState()
 * (syncHelper.ts) silently collapsed that case into either the fact from
 * an older, stale revision or nothing at all, discarding the one signal
 * a caller most needed. Every consumer (captureConfirmedSnapshotForPull in
 * plans/page.tsx and lightning/page.tsx) now must handle all three
 * statuses explicitly.
 */
export interface ConfirmedPlannerState {
  plans: ConfirmedDomainResult<{ version: number; items: unknown[] }>;
  lightning: ConfirmedDomainResult<{ version: number; items: unknown[] }>;
  days: ConfirmedDomainResult<string[]>;
  // SH.3.2 — dayMeta participates in confirmed-state tracking exactly like
  // every other domain (see ConfirmedDomainName in syncHelper.ts).
  dayMeta: ConfirmedDomainResult<Record<string, { label?: string; date?: string }>>;
  // SH.3.3 — dayParks participates identically, one level simpler in value
  // shape (a plain dayId -> ParkId string record, no nested entry object).
  dayParks: ConfirmedDomainResult<Record<string, string>>;
}

function isPlannerDomainValue(v: unknown): v is { version: number; items: unknown[] } {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).version === "number" &&
    Array.isArray((v as Record<string, unknown>).items)
  );
}

function isDaysValue(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((id) => typeof id === "string");
}

// SH.3.2 — the dayMeta domain's own confirmed-fact value shape: a plain
// object keyed by day id, never an array. Deliberately lenient about entry
// shape here (this only gates whether a FACT is even eligible to be
// considered — the entries themselves are already sanitized on the way in
// by sanitizeDayMeta(), so a fact recorded from THIS codebase's own writers
// can never contain anything this check would need to reject more strictly).
function isDayMetaValue(v: unknown): v is Record<string, { label?: string; date?: string }> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// SH.3.3 — the dayParks domain's own confirmed-fact value shape: same
// lenient "plain object, never an array" gate as isDayMetaValue() above, for
// the same reason (entries are already sanitized on the way in by
// sanitizeDayParks()).
function isDayParksValue(v: unknown): v is Record<string, string> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parse and validate a raw unknown value as a plans/lightning
 * ConfirmedDomainFact (both domains share the identical
 * `{ version, items[] }` value shape). Returns null if the shape is
 * missing or invalid — callers (syncHelper.ts's getConfirmedState) treat
 * null as "no confirmed fact here", never as an error. A non-finite/non-
 * numeric `revision` is rejected outright (never coerced to 0) since
 * resolveConfirmedDomainState()'s whole revision comparison depends on
 * genuine server-issued revisions — treating a corrupted fact as revision
 * 0 would make it look OLDER than everything, silently discarding it
 * instead of just refusing to trust it (it is simply excluded from the
 * candidate set resolveConfirmedDomainState() reduces over).
 */
export function parseConfirmedPlannerDomainFact(
  raw: unknown
): ConfirmedDomainFact<{ version: number; items: unknown[] }> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.revision !== "number" || !Number.isFinite(r.revision)) return null;
  if (!isPlannerDomainValue(r.value)) return null;
  return { revision: r.revision, value: r.value };
}

/**
 * Parse and validate a raw unknown value as a `days` ConfirmedDomainFact —
 * same contract as parseConfirmedPlannerDomainFact(), just for the `days`
 * domain's own value shape (a plain string array).
 */
export function parseConfirmedDaysFact(raw: unknown): ConfirmedDomainFact<string[]> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.revision !== "number" || !Number.isFinite(r.revision)) return null;
  if (!isDaysValue(r.value)) return null;
  return { revision: r.revision, value: r.value };
}

/**
 * SH.3.2 — same contract as parseConfirmedPlannerDomainFact()/
 * parseConfirmedDaysFact(), for the dayMeta domain's own value shape (a
 * plain object keyed by day id).
 */
export function parseConfirmedDayMetaFact(
  raw: unknown
): ConfirmedDomainFact<Record<string, { label?: string; date?: string }>> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.revision !== "number" || !Number.isFinite(r.revision)) return null;
  if (!isDayMetaValue(r.value)) return null;
  return { revision: r.revision, value: r.value };
}

/**
 * SH.3.3 — same contract as parseConfirmedPlannerDomainFact()/
 * parseConfirmedDaysFact()/parseConfirmedDayMetaFact(), for the dayParks
 * domain's own value shape (a plain object keyed by day id, string values).
 */
export function parseConfirmedDayParksFact(
  raw: unknown
): ConfirmedDomainFact<Record<string, string>> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.revision !== "number" || !Number.isFinite(r.revision)) return null;
  if (!isDayParksValue(r.value)) return null;
  return { revision: r.revision, value: r.value };
}

/**
 * Reference cases for parseConfirmedPlannerDomainFact()/parseConfirmedDaysFact()/
 * parseConfirmedDayMetaFact()/parseConfirmedDayParksFact(). Run from Node:
 *   import { DEV_PARSE_CONFIRMED_FACT_CASES, parseConfirmedPlannerDomainFact, parseConfirmedDaysFact, parseConfirmedDayMetaFact, parseConfirmedDayParksFact } from "@/lib/syncPayload";
 *   DEV_PARSE_CONFIRMED_FACT_CASES.forEach(c => {
 *     const parse = c.domain === "days" ? parseConfirmedDaysFact : c.domain === "dayMeta" ? parseConfirmedDayMetaFact : c.domain === "dayParks" ? parseConfirmedDayParksFact : parseConfirmedPlannerDomainFact;
 *     const got = parse(c.raw);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_PARSE_CONFIRMED_FACT_CASES: Array<{
  name: string;
  domain: "plannerDomain" | "days" | "dayMeta" | "dayParks";
  raw: unknown;
  expected: ConfirmedDomainFact<unknown> | null;
}> = [
  {
    name: "valid plans/lightning fact — parses as-is",
    domain: "plannerDomain",
    raw: { revision: 12, value: { version: 1, items: ["p"] } },
    expected: { revision: 12, value: { version: 1, items: ["p"] } },
  },
  {
    name: "revision 0 is a legitimate value, not treated as missing",
    domain: "plannerDomain",
    raw: { revision: 0, value: { version: 1, items: [] } },
    expected: { revision: 0, value: { version: 1, items: [] } },
  },
  {
    name: "missing revision — rejected, never coerced to 0",
    domain: "plannerDomain",
    raw: { value: { version: 1, items: [] } },
    expected: null,
  },
  {
    name: "non-numeric revision — rejected",
    domain: "plannerDomain",
    raw: { revision: "6", value: { version: 1, items: [] } },
    expected: null,
  },
  {
    name: "non-finite revision (NaN) — rejected",
    domain: "plannerDomain",
    raw: { revision: NaN, value: { version: 1, items: [] } },
    expected: null,
  },
  {
    name: "revision valid but value shape invalid — whole fact rejected",
    domain: "plannerDomain",
    raw: { revision: 3, value: { items: "not-an-array" } },
    expected: null,
  },
  {
    name: "non-object raw — rejected",
    domain: "plannerDomain",
    raw: "not an object",
    expected: null,
  },
  {
    name: "array raw — rejected",
    domain: "plannerDomain",
    raw: [1, 2, 3],
    expected: null,
  },
  {
    name: "valid days fact — parses as-is",
    domain: "days",
    raw: { revision: 7, value: ["day-1", "day-2"] },
    expected: { revision: 7, value: ["day-1", "day-2"] },
  },
  {
    name: "days value not a string array — rejected",
    domain: "days",
    raw: { revision: 7, value: [1, 2, 3] },
    expected: null,
  },
  {
    name: "valid dayMeta fact — parses as-is",
    domain: "dayMeta",
    raw: { revision: 4, value: { "day-1": { label: "Arrival" }, "day-2": { date: "2025-05-12" } } },
    expected: { revision: 4, value: { "day-1": { label: "Arrival" }, "day-2": { date: "2025-05-12" } } },
  },
  {
    name: "valid dayMeta fact — an intentional empty clear parses as-is",
    domain: "dayMeta",
    raw: { revision: 5, value: {} },
    expected: { revision: 5, value: {} },
  },
  {
    name: "dayMeta value is an array, not a plain object — rejected",
    domain: "dayMeta",
    raw: { revision: 4, value: ["day-1"] },
    expected: null,
  },
  {
    name: "SH.3.3 — valid dayParks fact — parses as-is",
    domain: "dayParks",
    raw: { revision: 4, value: { "day-1": "mk", "day-2": "epcot" } },
    expected: { revision: 4, value: { "day-1": "mk", "day-2": "epcot" } },
  },
  {
    name: "SH.3.3 — valid dayParks fact — an intentional empty clear parses as-is",
    domain: "dayParks",
    raw: { revision: 5, value: {} },
    expected: { revision: 5, value: {} },
  },
  {
    name: "SH.3.3 — dayParks value is an array, not a plain object — rejected",
    domain: "dayParks",
    raw: { revision: 4, value: ["day-1"] },
    expected: null,
  },
];

/**
 * SH.2 architecture (Codex P1, 15th round; STATUS MODEL REPLACED 16th
 * round) — the 15th round's reduceConfirmedFactRecords() (removed) walked
 * revisions highest-first and, on finding a CONFLICTED one, silently fell
 * back to the next-lower UNAMBIGUOUS revision as "confirmed". Codex's
 * 16th-round finding: that fallback is wrong. A conflict at the NEWEST
 * revision means the domain's true current state is UNKNOWN — falling back
 * to an older revision presents a STALE value as if it were a trustworthy
 * current baseline, which a pull's winner-selection logic (captureConfirmed-
 * SnapshotForPull, plans/lightning page.tsx) would then treat as genuine
 * confirmed truth, potentially misclassifying newer local/cloud state as an
 * unsynced edit and overwriting it. "A conflict at the newest confirmed
 * revision is NOT equivalent to using the next older revision."
 *
 * resolveConfirmedDomainState() is the replacement: it looks ONLY at the
 * HIGHEST revision recorded for a domain (never falling back), and returns
 * one of exactly three statuses — the CONFIRMED-STATE CONTRACT's own
 * required distinction:
 *   • "none"      — no facts recorded for this domain at all.
 *   • "confirmed" — the highest revision's recorded fact(s) all canonically
 *     agree (canonicalizeJSON() above) — this domain has a valid,
 *     trustworthy confirmed value.
 *   • "conflict"  — the highest revision's recorded facts DISAGREE. The
 *     domain's confirmed state is presently UNKNOWABLE — callers must fail
 *     closed for this domain (no winner selection, no push, sync gated)
 *     rather than substitute ANY older revision, however unambiguous that
 *     older one might individually be.
 * A conflict is always temporary: the moment a NEWER, unambiguous revision
 * is recorded (e.g. a later successful push or pull resolves the
 * inconsistency going forward), it becomes the new highest revision and
 * resolveConfirmedDomainState() reports "confirmed" again — the stale
 * conflicted revision is simply no longer the one being looked at. See
 * confirmedFactKey's own doc in syncHelper.ts for why facts are physically
 * append-only (so this function never needs to worry about a fact changing
 * out from under it mid-computation), and this round's own report for how
 * the "conflict" status propagates through the actual pull/baseline
 * consumers instead of being silently dropped.
 */
export type ConfirmedDomainResult<T> =
  | { status: "confirmed"; fact: ConfirmedDomainFact<T> }
  | { status: "none" }
  | { status: "conflict"; revision: number };

export function resolveConfirmedDomainState<T>(
  facts: Array<ConfirmedDomainFact<T>>
): ConfirmedDomainResult<T> {
  if (facts.length === 0) return { status: "none" };
  let topRevision = facts[0].revision;
  for (const fact of facts) {
    if (fact.revision > topRevision) topRevision = fact.revision;
  }
  const topGroup = facts.filter((fact) => fact.revision === topRevision);
  const canonicalValues = new Set(topGroup.map((fact) => canonicalizeJSON(fact.value)));
  if (canonicalValues.size > 1) {
    return { status: "conflict", revision: topRevision };
  }
  return { status: "confirmed", fact: topGroup[0] };
}

/**
 * True if every fact recorded for `revision` within `facts` shares the SAME
 * canonical value (including the trivial case of exactly one fact, or none
 * — absence is never itself a conflict). Used by recordConfirmedFact()
 * (syncHelper.ts) to decide, immediately after writing its own new fact,
 * whether THIS SPECIFIC revision is durably confirmed as unambiguous — the
 * per-call success signal reconcilePendingOperations() depends on to decide
 * whether it is safe to retire a pending op's evidence. Deliberately
 * independent of reduceConfirmedFactRecords()'s "stop at the first
 * unambiguous revision" search: a revision below the domain's current
 * overall max can still be perfectly unambiguous on its own terms (e.g. a
 * legitimately delayed lower-revision response — see this round's own
 * report), and this function must say so correctly regardless of what a
 * HIGHER revision's group looks like.
 */
export function confirmedFactRevisionIsUnambiguous<T>(
  facts: Array<ConfirmedDomainFact<T>>,
  revision: number
): boolean {
  const group = facts.filter((f) => f.revision === revision);
  if (group.length === 0) return false;
  const canonicalValues = new Set(group.map((f) => canonicalizeJSON(f.value)));
  return canonicalValues.size === 1;
}

/**
 * IDENTITY comparison over TWO ConfirmedDomainResult<T> snapshots — SH.2.2
 * (Codex P1 third follow-up round). "A hydration winner is valid only while
 * the confirmed authority used to select it remains unchanged" (this
 * round's required invariant): `a` and `b` are equal only when they
 * represent the EXACT SAME authoritative fact — same status, and for
 * "confirmed" the same revision AND canonically-equal value, and for
 * "conflict" the same revision. Two "none" results are always equal (both
 * mean "nothing confirmed yet"). Any difference in status, revision, or
 * value — in either direction, newer OR older, ambiguous OR not — is NOT
 * equal.
 *
 * Root cause this closes: the FIRST SH.2.2 follow-up round's commit-time
 * `isAuthorityStillValid` check re-derived resolvePostFetchDomainBaseline()
 * fresh and asked only "is the CURRENT confirmed state still USABLE
 * relative to this pull's own cloudRevision" (i.e. not "gated"/
 * "stale-response"/"unusable-response"). That question has a real gap: if
 * confirmed authority advances from revision 5 to revision 6 WHILE this
 * pull's cloudRevision is 7, resolvePostFetchDomainBaseline() reports the
 * NEW revision-6 fact as perfectly "confirmed" (6 <= 7) — not unusable at
 * all — so the OLD check reported "still valid" even though the winner
 * this pull already selected was chosen against revision 5's value, never
 * recomputed against revision 6's. Asking "is CURRENT state usable" is the
 * wrong question at commit time; the right one is "is CURRENT state
 * IDENTICAL to what winner selection actually used" — this function
 * answers exactly that, generically, over the SAME ConfirmedDomainResult<T>
 * type every other confirmed-authority decision in this codebase already
 * uses (no parallel authority model introduced).
 *
 * Note this is a STRICT superset of the old usability check, not a
 * replacement decision competing with it: a domain whose confirmed
 * authority is UNCHANGED from what winner selection used is, by
 * construction, exactly as usable as it was proven to be at the ORIGINAL
 * baseline check (that pull's own cloudRevision never changes mid-pull) —
 * so callers no longer need resolvePostFetchDomainBaseline() at all for
 * this SPECIFIC "did anything move" question; see each page's
 * revalidateAuthorityBeforeCommit() for the call site.
 */
export function confirmedDomainResultsEqual<T>(
  a: ConfirmedDomainResult<T>,
  b: ConfirmedDomainResult<T>
): boolean {
  if (a.status === "none") return b.status === "none";
  if (a.status === "conflict") {
    return b.status === "conflict" && a.revision === b.revision;
  }
  return b.status === "confirmed" && a.fact.revision === b.fact.revision && canonicalizeJSON(a.fact.value) === canonicalizeJSON(b.fact.value);
}

/**
 * Reference cases for confirmedDomainResultsEqual() — the REQUIRED cases
 * from the SH.2.2 (Codex P1 third follow-up round) architectural contract.
 * Run from Node:
 *   import { DEV_CONFIRMED_DOMAIN_RESULTS_EQUAL_CASES, confirmedDomainResultsEqual } from "@/lib/syncPayload";
 *   DEV_CONFIRMED_DOMAIN_RESULTS_EQUAL_CASES.forEach(c => {
 *     const got = confirmedDomainResultsEqual(c.a, c.b);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_CONFIRMED_DOMAIN_RESULTS_EQUAL_CASES: Array<{
  name: string;
  a: ConfirmedDomainResult<unknown>;
  b: ConfirmedDomainResult<unknown>;
  expected: boolean;
}> = [
  {
    name: "both 'none' — nothing confirmed yet either time — equal",
    a: { status: "none" },
    b: { status: "none" },
    expected: true,
  },
  {
    name: "required case 3 — identical confirmed revision AND value — unchanged, equal",
    a: { status: "confirmed", fact: { revision: 5, value: "V5" } },
    b: { status: "confirmed", fact: { revision: 5, value: "V5" } },
    expected: true,
  },
  {
    name: "required case 1 — winner selected at rev5, confirmed authority advances to rev6 while waiting: NOT equal, even though rev6 could itself be perfectly usable against a later cloudRevision",
    a: { status: "confirmed", fact: { revision: 5, value: "V5" } },
    b: { status: "confirmed", fact: { revision: 6, value: "V6" } },
    expected: false,
  },
  {
    name: "required case 2 — SAME revision but the relevant confirmed value changed (e.g. resolved differently by a concurrent conflict repair): NOT equal",
    a: { status: "confirmed", fact: { revision: 5, value: "V5-ORIGINAL" } },
    b: { status: "confirmed", fact: { revision: 5, value: "V5-DIFFERENT" } },
    expected: false,
  },
  {
    name: "confirmed revision goes BACKWARD (should not happen in practice, but the comparison is symmetric about direction) — still NOT equal",
    a: { status: "confirmed", fact: { revision: 6, value: "V6" } },
    b: { status: "confirmed", fact: { revision: 5, value: "V5" } },
    expected: false,
  },
  {
    name: "'none' at selection time, a confirmed fact now exists (e.g. a reconciled pending op or concurrent push just recorded one): NOT equal — a fallback-ref-based winner must not be trusted once real confirmed authority appears",
    a: { status: "none" },
    b: { status: "confirmed", fact: { revision: 1, value: "V1" } },
    expected: false,
  },
  {
    name: "a genuine conflict at the SAME revision the original 'recovered' plan was based on, still unresolved: equal — the existing conflict-recovery plan (preFetch.diskValue) remains valid",
    a: { status: "conflict", revision: 6 },
    b: { status: "conflict", revision: 6 },
    expected: true,
  },
  {
    name: "a conflict resolves (unambiguously) to a confirmed fact while waiting: NOT equal — the 'recovered' plan was based on an assumption that no longer holds",
    a: { status: "conflict", revision: 6 },
    b: { status: "confirmed", fact: { revision: 7, value: "V7" } },
    expected: false,
  },
  {
    name: "a conflict's OWN top revision advances (a newer, still-ambiguous revision) while waiting: NOT equal",
    a: { status: "conflict", revision: 6 },
    b: { status: "conflict", revision: 7 },
    expected: false,
  },
  {
    name: "value equality is CANONICAL, not literal reference/shape identity — the SAME object with differently-ordered keys at the same revision still compares equal (reuses the SAME canonicalizeJSON() every other confirmed-fact comparison in this module already uses)",
    a: { status: "confirmed", fact: { revision: 5, value: { items: [1, 2], version: 1 } } },
    b: { status: "confirmed", fact: { revision: 5, value: { version: 1, items: [1, 2] } } },
    expected: true,
  },
];

/**
 * SH.2.2 (Codex P1 "authority vs. hydration-provenance" round) — root cause:
 * a domain being "cloud-won" at the DOMAIN level (`!itemsChangedLocally &&
 * cloudItems !== null`) says nothing about whether the WINNING VALUE this
 * pull actually persists is byte-for-byte the server's own value. Cross-
 * domain reconciliation (reconcilePlannerSnapshot in crossDayChecks.ts) can
 * ALTER a cloud-won domain's winning value — filtering a sibling's items
 * that reference a day the winning days[] removed, or extending days[]
 * itself with a day a cloud-won item newly references — so "cloud won this
 * domain" and "this domain's winning value literally equals what the server
 * returned for it" are DIFFERENT questions. Recording the ALTERED value as
 * a confirmed fact under the server's own revision asserts something false:
 * "the server's canonical value for this domain at this revision was X",
 * when the server actually held Y. A concrete instance (this round's own
 * task): GET rev7 returns Plans={A,B}; this device's local Days already
 * lacks the day B belongs to; reconciliation locally, correctly, filters B
 * out of winningPlanItems — but the server's OWN Plans@rev7 is still
 * {A,B}, not {A}. Two tabs (or devices) with DIFFERENT local Days state
 * reconciling the SAME GET response would derive DIFFERENT "winning" Plans
 * values and, under the old (pre-this-round) code, both record THEIR OWN
 * value as if it were "the" confirmed Plans@rev7 — a spurious, entirely
 * artificial conflict for a domain the server itself has no ambiguity
 * about at all.
 *
 * isExactCloudValue() is the gate: a candidate winning value is eligible to
 * be recorded as CONFIRMED SERVER AUTHORITY (commitConfirmedBaseline, see
 * syncHelper.ts) only when it canonically equals the literal cloud value
 * this pull actually fetched for that domain — never merely "cloud won the
 * domain-level decision". `cloudValue` of `null`/`undefined` (no cloud
 * payload for this domain at all) can never make a candidate "the exact
 * cloud value" — there is nothing to be exactly equal to — so it always
 * returns false in that case, correctly routing such a domain to hydration
 * provenance instead (see recordHydrationProvenance()'s own doc in
 * syncHelper.ts for that separate, non-authoritative channel).
 */
export function isExactCloudValue(candidateValue: unknown, cloudValue: unknown): boolean {
  if (cloudValue === null || cloudValue === undefined) return false;
  return canonicalizeJSON(candidateValue) === canonicalizeJSON(cloudValue);
}

/**
 * Reference cases for isExactCloudValue() — the REQUIRED cases from the
 * SH.2.2 "authority vs. hydration-provenance" round. Run from Node:
 *   import { DEV_IS_EXACT_CLOUD_VALUE_CASES, isExactCloudValue } from "@/lib/syncPayload";
 *   DEV_IS_EXACT_CLOUD_VALUE_CASES.forEach(c => {
 *     const got = isExactCloudValue(c.candidateValue, c.cloudValue);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_IS_EXACT_CLOUD_VALUE_CASES: Array<{
  name: string;
  candidateValue: unknown;
  cloudValue: unknown;
  expected: boolean;
}> = [
  {
    name: "pure cloud winner — candidate IS the literal cloud value — eligible for confirmed authority",
    candidateValue: { version: 1, items: ["A", "B"] },
    cloudValue: { version: 1, items: ["A", "B"] },
    expected: true,
  },
  {
    name: "canonical equality — differently-ordered keys still count as the exact cloud value",
    candidateValue: { items: ["A", "B"], version: 1 },
    cloudValue: { version: 1, items: ["A", "B"] },
    expected: true,
  },
  {
    name: "root example — reconciliation filtered B out locally (Days removed B's day): candidate {A} != cloud {A,B} — NOT the exact cloud value, must not become a confirmed fact",
    candidateValue: { version: 1, items: ["A"] },
    cloudValue: { version: 1, items: ["A", "B"] },
    expected: false,
  },
  {
    name: "reconciliation EXTENDED a domain beyond cloud's own value (e.g. days[] gained a day from a newly cloud-won item) — still NOT the exact cloud value",
    candidateValue: ["day1", "day2", "day3"],
    cloudValue: ["day1", "day2"],
    expected: false,
  },
  {
    name: "no cloud payload for this domain at all (null) — never eligible, regardless of what the candidate is",
    candidateValue: { version: 1, items: [] },
    cloudValue: null,
    expected: false,
  },
  {
    name: "no cloud payload for this domain at all (undefined) — never eligible",
    candidateValue: [],
    cloudValue: undefined,
    expected: false,
  },
];

/**
 * SH.2.2 (Codex P1 "consolidated hydration commit boundary" round) —
 * CRASH/RELOAD SAFETY for the gap between a domain's canonical-key mutation
 * and its confirmed-authority/hydration-provenance fact write. Even inside
 * commitDomainHydration()'s single held Web Lock (syncHelper.ts), those are
 * still two separate `localStorage.setItem` calls — ordinary localStorage
 * writes are not transactional, so a genuine process-level interruption
 * (crash, kill, power loss) landing between them is possible in principle,
 * however small the window. Before that write pair begins,
 * commitDomainHydration() durably records a `HydrationApplyIntent` — the
 * canonical key, the revision, and the exact bytes about to be written —
 * under a per-(userId, profileId, domain) key, and clears it once the fact
 * write (or the decision not to attempt one) has been recorded. A reload
 * that finds a LEFTOVER intent means this device cannot prove which side of
 * that gap the interruption landed on.
 *
 * resolveHydrationApplyIntentDisposition() is the pure decision a caller
 * (e.g. the pull effect, before ever trusting canonical bytes as pushable
 * local intent) makes from that leftover evidence:
 *   • `intent === null` — nothing was ever left mid-flight — "resolved".
 *   • `canonicalRaw !== intent.nextRaw` — something newer already
 *     superseded whatever this intent described (the write never landed at
 *     all, or a later genuine edit/commit has since moved past it) — the
 *     intent is simply moot — "stale".
 *   • `canonicalRaw === intent.nextRaw` (the write DID land) and a
 *     surviving local-edit fact exists for this key that postdates this
 *     intent's own `baselineEditFactIds` frontier — a genuine, newer user
 *     edit happens to byte-for-byte coincide with the hydration write; the
 *     local-edit-fact priority rule (see hasSurvivingEditFact's own doc in
 *     syncHelper.ts) already makes this content trustworthy on its own
 *     terms, regardless of hydration provenance — "resolved".
 *   • `canonicalRaw === intent.nextRaw` and a confirmed-authority or
 *     hydration-provenance fact already exists at `intent.revision` — the
 *     fact write DID complete (or a later pull already re-established
 *     equivalent provenance); only the intent marker's own clear step was
 *     lost — harmless — "resolved".
 *   • Otherwise — canonical bytes match exactly what this device was in the
 *     middle of hydrating, with no PROVEN-newer local edit and no fact to
 *     explain them — the fact write may never have landed, OR the only
 *     surviving edit fact(s) are pre-hydration baseline evidence this
 *     intent already knows about — "incomplete" either way: the caller must
 *     not treat this content as safe, pushable local intent until a fresh
 *     pull re-establishes real provenance for it, or a genuinely newer edit
 *     actually appears.
 *
 * SH.2.4.1 (Codex P1 "hydration-intent crash-recovery frontier" round) —
 * BASELINE vs. NEWER EDIT FACTS. A crash landing after
 * commitLocalDomainRaw()'s canonical `setItem` but before its own
 * `baselineEditFactIds` retirement loop (see that function's own doc in
 * syncHelper.ts) leaves exactly the facts THAT SAME HYDRATION ATTEMPT
 * already knew about — its own pre-write baseline — still durably present.
 * Before this round, `resolveHydrationApplyIntentDisposition()` took a
 * plain `hasSurvivingEditFact: boolean` and treated ANY surviving fact as
 * proof of a newer user edit, exactly the invariant `hasSurvivingEditFact`
 * itself documents as holding ONLY after a hydration commit has run to
 * completion (baseline retired). Recovering from THIS specific crash window
 * violates that precondition: the surviving fact is the same stale
 * pre-hydration evidence the hydration attempt was already superseding, not
 * a newer edit — yet the old boolean could not tell the difference, so
 * recovery could clear the intent and let a later readLatestDurableValue()
 * (syncHelper.ts) prefer that stale fact over the cloud winner this
 * hydration just wrote.
 *
 * The fix: `HydrationApplyIntent` now durably captures
 * `baselineEditFactIds` — the EXACT same pre-write edit-fact-key frontier
 * commitDomainHydration() hands to commitLocalDomainRaw() to retire on
 * success (see commitDomainHydration's own doc in syncHelper.ts) — snapshot
 * identity, not merely a count. `hasNewerEditFact` (replacing the old
 * `hasSurvivingEditFact` parameter) must now be TRUE only when a currently-
 * surviving edit-fact key for `intent.key` is NOT a member of
 * `intent.baselineEditFactIds` — i.e. it was published strictly after this
 * hydration attempt's own decision point, so it could only be a genuinely
 * newer post-baseline user edit (see hasNewerEditFactBeyondHydrationBaseline()
 * in syncHelper.ts, the caller-side function that performs this diff against
 * live storage — this function stays pure and takes the already-computed
 * boolean, unchanged in shape).
 *
 * FAIL CLOSED ON UNKNOWN BASELINE — `intent.baselineEditFactIds === null`
 * means this intent predates this round (a leftover marker written by
 * pre-fix code, surviving a crash across a deploy boundary) and therefore
 * carries no frontier to diff against at all. The caller
 * (hasNewerEditFactBeyondHydrationBaseline()) always reports `false` in that
 * case — NOT "every surviving fact counts as newer" (that would silently
 * reinstate the exact bug this round closes) and NOT "resolved outright"
 * either (this function never inspects `baselineEditFactIds` itself; a
 * `null` baseline simply cannot produce `hasNewerEditFact = true`). With no
 * provable newer edit and no matching durable fact, such an intent falls
 * through to "incomplete" — safe, self-healing (a fresh pull's own matching
 * provenance, or the user's next edit moving canonical bytes off
 * `intent.nextRaw` entirely, each independently clears it — see their own
 * cases below), never a silent reversion to trusting stale evidence.
 */
export interface HydrationApplyIntent {
  key: string;
  revision: number;
  nextRaw: string;
  /**
   * The local-edit-fact keys for `key` that already existed immediately
   * before this hydration attempt's own CAS commit was requested — the
   * SAME snapshot commitLocalDomainRaw() itself retires on a successful
   * "committed" write (see its own `baselineEditFactIds` doc in
   * syncHelper.ts). `null` only for an intent written before this field
   * existed — see FAIL CLOSED ON UNKNOWN BASELINE above.
   */
  baselineEditFactIds: string[] | null;
}

export type HydrationApplyIntentDisposition = "resolved" | "incomplete" | "stale";

export function resolveHydrationApplyIntentDisposition(
  intent: HydrationApplyIntent | null,
  canonicalRaw: string | null,
  hasNewerEditFact: boolean,
  hasMatchingDurableFact: boolean
): HydrationApplyIntentDisposition {
  if (intent === null) return "resolved";
  if (canonicalRaw !== intent.nextRaw) return "stale";
  if (hasNewerEditFact || hasMatchingDurableFact) return "resolved";
  return "incomplete";
}

/**
 * Reference cases for resolveHydrationApplyIntentDisposition(). Run from Node:
 *   import { DEV_RESOLVE_HYDRATION_APPLY_INTENT_DISPOSITION_CASES, resolveHydrationApplyIntentDisposition } from "@/lib/syncPayload";
 *   DEV_RESOLVE_HYDRATION_APPLY_INTENT_DISPOSITION_CASES.forEach(c => {
 *     const got = resolveHydrationApplyIntentDisposition(c.intent, c.canonicalRaw, c.hasNewerEditFact, c.hasMatchingDurableFact);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 *
 * SH.2.4.1 — cases below use `hasNewerEditFact` (the already-diffed "a
 * surviving edit fact exists that postdates intent.baselineEditFactIds"
 * verdict a caller like hasNewerEditFactBeyondHydrationBaseline() in
 * syncHelper.ts computes) rather than the pre-round "any fact survives"
 * boolean — see this function's own doc above for the crash-recovery root
 * cause this distinction closes.
 */
export const DEV_RESOLVE_HYDRATION_APPLY_INTENT_DISPOSITION_CASES: Array<{
  name: string;
  intent: HydrationApplyIntent | null;
  canonicalRaw: string | null;
  hasNewerEditFact: boolean;
  hasMatchingDurableFact: boolean;
  expected: HydrationApplyIntentDisposition;
}> = [
  {
    name: "no leftover intent — nothing to reconcile",
    intent: null,
    canonicalRaw: '{"version":1,"items":[]}',
    hasNewerEditFact: false,
    hasMatchingDurableFact: false,
    expected: "resolved",
  },
  {
    name: "canonical bytes no longer match the intent — superseded by something newer, moot",
    intent: { key: "k", revision: 5, nextRaw: '{"a":1}', baselineEditFactIds: [] },
    canonicalRaw: '{"a":2}',
    hasNewerEditFact: false,
    hasMatchingDurableFact: false,
    expected: "stale",
  },
  {
    name: "write landed, no fact recorded yet, no local edit either — the genuine gap this exists to catch",
    intent: { key: "k", revision: 5, nextRaw: '{"a":1}', baselineEditFactIds: [] },
    canonicalRaw: '{"a":1}',
    hasNewerEditFact: false,
    hasMatchingDurableFact: false,
    expected: "incomplete",
  },
  {
    name: "write landed, a surviving edit fact postdates the baseline — a genuine newer edit, trust it on its own terms",
    intent: { key: "k", revision: 5, nextRaw: '{"a":1}', baselineEditFactIds: ["dwp:localEditFact:k:old"] },
    canonicalRaw: '{"a":1}',
    hasNewerEditFact: true,
    hasMatchingDurableFact: false,
    expected: "resolved",
  },
  {
    name: "write landed, a durable confirmed/hydration fact already exists for it — only the marker's own clear was lost, harmless",
    intent: { key: "k", revision: 5, nextRaw: '{"a":1}', baselineEditFactIds: [] },
    canonicalRaw: '{"a":1}',
    hasNewerEditFact: false,
    hasMatchingDurableFact: true,
    expected: "resolved",
  },
  {
    name: "canonical key missing entirely (null) while intent expected real bytes — never confused with a match",
    intent: { key: "k", revision: 5, nextRaw: '{"a":1}', baselineEditFactIds: [] },
    canonicalRaw: null,
    hasNewerEditFact: false,
    hasMatchingDurableFact: false,
    expected: "stale",
  },
  {
    name: "REQUIRED (SH.2.4.1) — crash after canonical write but before baseline-fact retirement: the only surviving fact IS the recorded baseline (hasNewerEditFact computed false by the caller-side diff) — must stay incomplete, never resolved off stale pre-hydration evidence",
    intent: { key: "k", revision: 5, nextRaw: '{"a":1}', baselineEditFactIds: ["dwp:localEditFact:k:pre-hydration"] },
    canonicalRaw: '{"a":1}',
    hasNewerEditFact: false,
    hasMatchingDurableFact: false,
    expected: "incomplete",
  },
  {
    name: "REQUIRED (SH.2.4.1) — same crash window, but a genuinely newer post-baseline edit ALSO exists (hasNewerEditFact true) — the newer edit still wins and resolves the intent",
    intent: { key: "k", revision: 5, nextRaw: '{"a":1}', baselineEditFactIds: ["dwp:localEditFact:k:pre-hydration"] },
    canonicalRaw: '{"a":1}',
    hasNewerEditFact: true,
    hasMatchingDurableFact: false,
    expected: "resolved",
  },
  {
    name: "REQUIRED (SH.2.4.1) — same crash window, but matching hydration provenance already exists at intent.revision — resolves via existing proof, independent of the stale baseline fact",
    intent: { key: "k", revision: 5, nextRaw: '{"a":1}', baselineEditFactIds: ["dwp:localEditFact:k:pre-hydration"] },
    canonicalRaw: '{"a":1}',
    hasNewerEditFact: false,
    hasMatchingDurableFact: true,
    expected: "resolved",
  },
  {
    name: "REQUIRED (SH.2.4.1) — unknown baseline (null; a leftover intent from before this round) with a surviving fact the caller cannot prove is newer — fails closed to incomplete, never silently resolved",
    intent: { key: "k", revision: 5, nextRaw: '{"a":1}', baselineEditFactIds: null },
    canonicalRaw: '{"a":1}',
    hasNewerEditFact: false,
    hasMatchingDurableFact: false,
    expected: "incomplete",
  },
  {
    name: "REQUIRED (SH.2.4.1) — replacement pull: a second hydration attempt's own baseline snapshot correctly re-absorbed the first attempt's still-unretired stale fact as ITS OWN baseline too — that fact is still not 'newer', still incomplete",
    intent: {
      key: "k",
      revision: 6,
      nextRaw: '{"a":2}',
      baselineEditFactIds: ["dwp:localEditFact:k:pre-hydration", "dwp:localEditFact:k:still-stale-from-first-attempt"],
    },
    canonicalRaw: '{"a":2}',
    hasNewerEditFact: false,
    hasMatchingDurableFact: false,
    expected: "incomplete",
  },
];

/**
 * Reference cases for resolveConfirmedDomainState() — the REQUIRED cases
 * from the 16th round's architectural contract. Run from Node:
 *   import { DEV_RESOLVE_CONFIRMED_DOMAIN_STATE_CASES, resolveConfirmedDomainState } from "@/lib/syncPayload";
 *   DEV_RESOLVE_CONFIRMED_DOMAIN_STATE_CASES.forEach(c => {
 *     const got = resolveConfirmedDomainState(c.facts);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_RESOLVE_CONFIRMED_DOMAIN_STATE_CASES: Array<{
  name: string;
  facts: Array<ConfirmedDomainFact<unknown>>;
  expected: ConfirmedDomainResult<unknown>;
}> = [
  {
    name: "empty set — no confirmed state for this domain yet",
    facts: [],
    expected: { status: "none" },
  },
  {
    name: "single fact — confirmed trivially",
    facts: [{ revision: 5, value: "A" }],
    expected: { status: "confirmed", fact: { revision: 5, value: "A" } },
  },
  {
    name: "two tabs record IDENTICAL rev5 value (as separate physical facts) — one equivalent confirmed result",
    facts: [
      { revision: 5, value: { version: 1, items: ["a"] } },
      { revision: 5, value: { version: 1, items: ["a"] } },
    ],
    expected: { status: "confirmed", fact: { revision: 5, value: { version: 1, items: ["a"] } } },
  },
  {
    name: "two tabs record DIFFERENT rev5 values — conflict, neither wins",
    facts: [
      { revision: 5, value: "A" },
      { revision: 5, value: "B" },
    ],
    expected: { status: "conflict", revision: 5 },
  },
  {
    name: "required — rev5=A confirmed, rev6 has conflicting facts: reports conflict at rev6, NEVER falls back to rev5 as a usable baseline",
    facts: [
      { revision: 5, value: "A" },
      { revision: 6, value: "B" },
      { revision: 6, value: "C" },
    ],
    expected: { status: "conflict", revision: 6 },
  },
  {
    name: "required — later unambiguous rev7 arrives after rev6's conflict: rev6's conflict is superseded, normal confirmed state resumes from rev7",
    facts: [
      { revision: 5, value: "A" },
      { revision: 6, value: "B" },
      { revision: 6, value: "C" },
      { revision: 7, value: "D" },
    ],
    expected: { status: "confirmed", fact: { revision: 7, value: "D" } },
  },
  {
    name: "different revisions recorded concurrently — highest revision's own status determines the result",
    facts: [
      { revision: 6, value: "B" },
      { revision: 9, value: "D" },
      { revision: 3, value: "A" },
    ],
    expected: { status: "confirmed", fact: { revision: 9, value: "D" } },
  },
  {
    name: "delayed lower revision arriving after a higher unambiguous one remains harmless — still resolves to the higher revision",
    facts: [
      { revision: 7, value: "C" },
      { revision: 6, value: "B-delayed" },
    ],
    expected: { status: "confirmed", fact: { revision: 7, value: "C" } },
  },
  {
    name: "only the newest revision is conflicted, with no older revision at all — still 'conflict', never fabricates a fallback",
    facts: [
      { revision: 5, value: "A" },
      { revision: 5, value: "B" },
    ],
    expected: { status: "conflict", revision: 5 },
  },
];

/**
 * Reference cases for confirmedFactRevisionIsUnambiguous(). Run from Node:
 *   import { DEV_CONFIRMED_FACT_REVISION_IS_UNAMBIGUOUS_CASES, confirmedFactRevisionIsUnambiguous } from "@/lib/syncPayload";
 *   DEV_CONFIRMED_FACT_REVISION_IS_UNAMBIGUOUS_CASES.forEach(c => {
 *     const got = confirmedFactRevisionIsUnambiguous(c.facts, c.revision);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_CONFIRMED_FACT_REVISION_IS_UNAMBIGUOUS_CASES: Array<{
  name: string;
  facts: Array<ConfirmedDomainFact<unknown>>;
  revision: number;
  expected: boolean;
}> = [
  {
    name: "no facts at all for this revision — not unambiguous (nothing to confirm)",
    facts: [{ revision: 9, value: "X" }],
    revision: 5,
    expected: false,
  },
  {
    name: "exactly one fact for this revision — unambiguous",
    facts: [{ revision: 5, value: "A" }],
    revision: 5,
    expected: true,
  },
  {
    name: "multiple facts, same canonical value — unambiguous",
    facts: [
      { revision: 5, value: { b: 2, a: 1 } },
      { revision: 5, value: { a: 1, b: 2 } },
    ],
    revision: 5,
    expected: true,
  },
  {
    name: "multiple facts, different values — NOT unambiguous, regardless of a higher revision existing elsewhere",
    facts: [
      { revision: 5, value: "A" },
      { revision: 5, value: "B" },
      { revision: 9, value: "Z" },
    ],
    revision: 5,
    expected: false,
  },
  {
    name: "a lower revision is unambiguous on its own terms even though a HIGHER revision is the domain's overall confirmed max",
    facts: [
      { revision: 5, value: "A" },
      { revision: 9, value: "Z" },
    ],
    revision: 5,
    expected: true,
  },
];

// ===== CONFIRMED-CONFLICT RECOVERY (SH.2, Codex P1, 17th round) =====

/**
 * CONFIRMED-CONFLICT RECOVERY CONTRACT — a conflicted newest-confirmed
 * revision (resolveConfirmedDomainState() above returning "conflict") must
 * fail closed, but must not permanently deadlock. Codex P1, 17th round:
 * the 16th round's own fix made this deadlock structurally guaranteed —
 * the pull unconditionally bails out the instant ANY domain is conflicted,
 * but the ONLY way a conflict is ever superseded is a NEW, higher-revision
 * fact getting recorded, which only happens via the winner-selection/commit
 * code path the bail-out itself prevents from ever running. A conflict
 * could never resolve.
 *
 * The fix: a conflict at `conflictRevision` is REPAIRABLE by a given pull
 * if and only if that pull's own authoritative server response carries a
 * STRICTLY NEWER revision than the conflict itself — never an equal or
 * older one ("Do not recover from an equal/older response"; "Do not
 * silently fall back to an older confirmed revision" — both from the 17th
 * round's own directive). `candidateRevision` is `null` for a response with
 * no usable revision at all (a 204, or an unparseable GET) — never
 * repairable, since there is no authoritative newer fact to repair with.
 *
 * This is a PURE, per-domain decision only — see each page's
 * captureConfirmedSnapshotForPull() for how a "repairable" domain is then
 * treated exactly like "none" (falls through to the ordinary baseline-ref/
 * ownership-mismatch path), letting the EXISTING winner-selection/
 * reconciliation/commit machinery record a new fact at the (higher)
 * candidate revision with zero special-casing — that new fact is what
 * actually supersedes the conflict, via resolveConfirmedDomainState()'s own
 * existing "only the highest revision matters" rule, not any special
 * recovery code path here. A domain that is NOT repairable by this pull's
 * response still fails closed exactly as the 16th round already ensured.
 */
export function isConflictRepairableByRevision(
  conflictRevision: number,
  candidateRevision: number | null
): boolean {
  return candidateRevision !== null && candidateRevision > conflictRevision;
}

/**
 * Reference cases for isConflictRepairableByRevision() — the REQUIRED
 * cases 3 and 4 from the 17th round's architectural contract (conflicted
 * rev6 + authoritative rev7 repairs; conflicted rev6 + rev6/rev5 stays
 * fail-closed), plus the surrounding edge cases. Run from Node:
 *   import { DEV_IS_CONFLICT_REPAIRABLE_BY_REVISION_CASES, isConflictRepairableByRevision } from "@/lib/syncPayload";
 *   DEV_IS_CONFLICT_REPAIRABLE_BY_REVISION_CASES.forEach(c => {
 *     const got = isConflictRepairableByRevision(c.conflictRevision, c.candidateRevision);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_IS_CONFLICT_REPAIRABLE_BY_REVISION_CASES: Array<{
  name: string;
  conflictRevision: number;
  candidateRevision: number | null;
  expected: boolean;
}> = [
  {
    name: "required — conflicted rev6 + authoritative GET rev7 — strictly newer, repairs the conflict",
    conflictRevision: 6,
    candidateRevision: 7,
    expected: true,
  },
  {
    name: "required — conflicted rev6 + GET rev6 (equal) — never recovers from an equal response",
    conflictRevision: 6,
    candidateRevision: 6,
    expected: false,
  },
  {
    name: "required — conflicted rev6 + GET rev5 (older) — never falls back to an older confirmed revision",
    conflictRevision: 6,
    candidateRevision: 5,
    expected: false,
  },
  {
    name: "no usable candidate revision at all (204 / unparseable GET) — never repairable",
    conflictRevision: 6,
    candidateRevision: null,
    expected: false,
  },
  {
    name: "candidate far newer — still repairs (any strictly-newer revision suffices)",
    conflictRevision: 3,
    candidateRevision: 100,
    expected: true,
  },
];

/**
 * SH.2 architecture (Codex P1, 11th round) — the per-domain accepted-facts
 * a caller should record, given a set of domain values all confirmed
 * together at ONE server revision (a single push's response, or a single
 * pull's GET response). This replaces the old `nextConfirmedBaseline()`
 * merge function: there is no "current state" input anymore, and no
 * accept/reject decision to make here at all — recording an immutable fact
 * is ALWAYS valid (it is simply a true historical record of what revision
 * R produced), and whether it ends up being the domain's CURRENT confirmed
 * value is entirely up to resolveConfirmedDomainState() at READ time. This
 * function exists only to describe, per domain, WHAT to record — never
 * whether it's "allowed".
 */
export interface AcceptedPlannerDomains {
  plans?: { version: number; items: unknown[] };
  lightning?: { version: number; items: unknown[] };
  days?: string[];
  dayMeta?: Record<string, { label?: string; date?: string }>;
  dayParks?: Record<string, string>;
}

/**
 * SH.2 architecture (Codex P1, 7th round; generalized 11th) — REPLACES the
 * 6th round's content-comparison beacon resolution (formerly
 * SyncIdentityState / resolveSyncIdentityStateAfterPull, both removed).
 * That approach compared a pendingBeacon's PAYLOAD against a subsequent
 * GET's current snapshot and treated a mismatch as "the beacon failed".
 * This is unsound: `user_planner` (see db-schema.sql) stores only the
 * LATEST state per (user, profile) — no history — so "beacon B failed" and
 * "beacon B succeeded, then a newer write C superseded it" are
 * OBSERVATIONALLY IDENTICAL from a single GET's content alone. Both cases
 * show up as "current cloud content differs from what B sent". No amount
 * of client-side heuristics (timing, retry counts, event ordering) can
 * distinguish them, because the information needed — "was B specifically
 * ever accepted" — simply does not exist in a content-only GET response.
 * Closing this required a SERVER-VERIFIABLE write-acknowledgment: see
 * user_planner_writes (db-schema.sql) and lastOpId/clientOpId
 * (api/sync/planner/route.ts) for the minimal additive mechanism — an
 * append-only table recording, per client-generated opaque opId, whether
 * that specific write was ever accepted, independent of whatever the row
 * looks like now.
 *
 * This function is the pure decision core for that resolved contract,
 * given the GET response's own `opStatus.found` (a direct, deterministic
 * server fact — never inferred from timing or content comparison):
 *   • `beaconAccepted` true (server confirms opId was recorded): the
 *     beacon's contribution is, by definition, already reflected in
 *     whatever `cloudSnapshot`/`cloudRevision` this SAME GET response
 *     returned (accepted-then-possibly-superseded is still "this pull's
 *     cloud state already accounts for it") — returns the per-domain facts
 *     to record at `cloudRevision`, bundled with that revision. This
 *     correctly resolves BOTH "accepted, not yet superseded" and
 *     "accepted, then superseded by C" identically and correctly: either
 *     way, `cloudSnapshot` IS the accurate current truth to record.
 *   • `beaconAccepted` false (server confirms opId was never recorded, or
 *     no opId was pending at all), or `cloudRevision`/`cloudSnapshot` null
 *     (a 204): returns `null` — nothing to record. The caller's ORDINARY
 *     pickWinningItems/pickWinningDays comparison decides the rest, exactly
 *     as it would for any other unresolved local edit.
 * Never fabricates a revision (always uses this GET's own live
 * `cloudRevision`) and never consults arrival order or timing.
 *
 * Codex P1 fix (11th round) — no longer routes through a "current state"
 * merge/rejection step (the old nextConfirmedBaseline()): recording a fact
 * is always valid regardless of what's currently confirmed for any domain,
 * per-domain OR mixed together — see resolveConfirmedDomainState()'s own doc
 * for why this is what removes the Web-Locks dependency for confirmed state.
 */
export function acceptedDomainFactsFromBeacon(
  beaconAccepted: boolean,
  cloudRevision: number | null,
  cloudSnapshot: SyncedPlannerPayload | null
): { revision: number; accepted: AcceptedPlannerDomains } | null {
  if (!beaconAccepted || cloudRevision === null || cloudSnapshot === null) {
    return null;
  }
  return {
    revision: cloudRevision,
    accepted: {
      plans: cloudSnapshot.plans,
      lightning: cloudSnapshot.lightning,
      days: cloudSnapshot.days,
      dayMeta: cloudSnapshot.dayMeta,
      dayParks: cloudSnapshot.dayParks,
    },
  };
}

/**
 * Reference cases for acceptedDomainFactsFromBeacon() — the two REQUIRED
 * beacon-resolution cases per the round-7 directive (accepted, accepted-
 * then-superseded, failed, failed-while-newer-C-exists), plus the
 * surrounding edge cases, re-pinned against the round-11 per-domain
 * contract (no more "current confirmed" input/rejection — see the
 * function's own doc for why). Run from Node:
 *   import { DEV_ACCEPTED_DOMAIN_FACTS_FROM_BEACON_CASES, acceptedDomainFactsFromBeacon } from "@/lib/syncPayload";
 *   DEV_ACCEPTED_DOMAIN_FACTS_FROM_BEACON_CASES.forEach(c => {
 *     const got = acceptedDomainFactsFromBeacon(c.beaconAccepted, c.cloudRevision, c.cloudSnapshot);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_ACCEPTED_DOMAIN_FACTS_FROM_BEACON_CASES: Array<{
  name: string;
  beaconAccepted: boolean;
  cloudRevision: number | null;
  cloudSnapshot: SyncedPlannerPayload | null;
  expected: { revision: number; accepted: AcceptedPlannerDomains } | null;
}> = [
  {
    name: "required — beacon accepted, not yet superseded: records the GET's own snapshot/revision",
    beaconAccepted: true,
    cloudRevision: 5,
    cloudSnapshot: { version: 1, plans: { version: 1, items: ["S2"] }, lightning: { version: 1, items: [] } },
    expected: {
      revision: 5,
      accepted: { plans: { version: 1, items: ["S2"] }, lightning: { version: 1, items: [] }, days: undefined },
    },
  },
  {
    name: "required — beacon accepted, then SUPERSEDED by a newer cloud write C: still records CURRENT cloud (C), the accurate accounting of the beacon's contribution",
    beaconAccepted: true,
    cloudRevision: 7,
    cloudSnapshot: { version: 1, plans: { version: 1, items: ["C-from-another-device"] }, lightning: { version: 1, items: [] } },
    expected: {
      revision: 7,
      accepted: { plans: { version: 1, items: ["C-from-another-device"] }, lightning: { version: 1, items: [] }, days: undefined },
    },
  },
  {
    name: "required — beacon failed (opId never recorded): nothing to record",
    beaconAccepted: false,
    cloudRevision: 4,
    cloudSnapshot: { version: 1, plans: { version: 1, items: ["old"] }, lightning: { version: 1, items: [] } },
    expected: null,
  },
  {
    name: "required — beacon failed WHILE a newer cloud write C exists (from another device): still nothing to record HERE — ordinary pull logic (commitConfirmedBaseline) handles C separately",
    beaconAccepted: false,
    cloudRevision: 9,
    cloudSnapshot: { version: 1, plans: { version: 1, items: ["C-unrelated"] }, lightning: { version: 1, items: [] } },
    expected: null,
  },
  {
    name: "no beacon was pending at all (beaconAccepted false) — nothing to record",
    beaconAccepted: false,
    cloudRevision: 3,
    cloudSnapshot: { version: 1, plans: { version: 1, items: ["p"] }, lightning: { version: 1, items: [] } },
    expected: null,
  },
  {
    name: "definitive 204 (cloudRevision/cloudSnapshot both null) even though beaconAccepted somehow true (defensive) — nothing to record",
    beaconAccepted: true,
    cloudRevision: null,
    cloudSnapshot: null,
    expected: null,
  },
  {
    name: "accepted, with a days[] present — days included in the recorded facts",
    beaconAccepted: true,
    cloudRevision: 1,
    cloudSnapshot: { version: 1, plans: { version: 1, items: ["first"] }, lightning: { version: 1, items: [] }, days: ["day-1"] },
    expected: {
      revision: 1,
      accepted: { plans: { version: 1, items: ["first"] }, lightning: { version: 1, items: [] }, days: ["day-1"] },
    },
  },
  {
    name: "SH.3.2 — accepted, with dayMeta present (including an intentional empty clear) — dayMeta included in the recorded facts",
    beaconAccepted: true,
    cloudRevision: 8,
    cloudSnapshot: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayMeta: {},
    },
    expected: {
      revision: 8,
      accepted: { plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, days: ["day-1"], dayMeta: {} },
    },
  },
  {
    name: "SH.3.3 — accepted, with dayParks present (including an intentional empty clear) — dayParks included in the recorded facts",
    beaconAccepted: true,
    cloudRevision: 9,
    cloudSnapshot: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayParks: {},
    },
    expected: {
      revision: 9,
      accepted: { plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, days: ["day-1"], dayParks: {} },
    },
  },
];

// ===== Stale first-delivery operation rejection (SH.2.5.1) =================
//
// Codex P1 finding: operation idempotency (the `user_planner_writes` ledger
// keyed by `client_op_id` — see this file's module doc and
// api/sync/planner/route.ts) only ever protects a SECOND delivery of an
// opId already recorded as accepted. It does nothing for the FIRST delivery
// of a delayed unload/beacon operation, because a delayed operation has no
// ledger row yet, so it sails straight past the duplicate check. Scenario:
// a beacon is built from this device's known base state (server revision A),
// stays queued (network delay, backgrounded tab, a slow/retried request),
// and only reaches the server AFTER some other write (this tab, another
// tab, or another device) has already advanced the row to revision B. The
// merge-on-write at that point has no way to tell "a legitimately current
// write" apart from "a stale write that never knew B existed" — both look
// like an ordinary first delivery — so the stale payload gets merged
// straight over B, silently reverting it.
//
// The fix binds each TAGGED operation (one carrying `clientOpId`) to the
// minimal evidence needed to detect this: `baseRevision`, the single
// server-issued `revision` (see this file's/route.ts's own revision-
// ordering doc) this device believed was current for this (user, profile)
// row at the moment the operation was built — 0 is the sentinel for "no
// row has ever been observed yet" (mirrors `currentRevision` below, which
// route.ts derives identically from "no user_planner row exists"). Because
// `user_planner` is a SINGLE row per (user, profile) — every domain in one
// write shares one `revision`, assigned fresh via `nextval()` on every
// write regardless of which domains changed — one number is sufficient
// evidence; there is no per-domain base to track, and no new ordering
// system is introduced. `evaluateOperationBaseRevision()` below is the pure
// decision core route.ts's handleWrite() calls, under the SAME
// per-(user,profile) advisory-lock transaction it already uses for
// duplicate detection, so the comparison against the row's CURRENT revision
// is exactly as serialized/deterministic as idempotency itself:
//   • `baseRevision` absent (an old, pre-SH.2.5.1 client, or any write that
//     doesn't opt in) — "no-evidence": the staleness check is skipped
//     entirely, preserving old-client safety and every existing DEV_*
//     operation/revision case unchanged.
//   • `baseRevision === currentRevision` — "current": this operation was
//     built from exactly today's row state; the ordinary merge/upsert
//     proceeds normally.
//   • any other value (lower, e.g. a genuinely stale build; OR higher, e.g.
//     a malformed/impossible client claim) — "stale": route.ts must reject
//     the write outright, WITHOUT touching `user_planner`, and durably
//     record the rejection (not merely decline to write) so a later
//     `lastOpId` GET lookup — see this file's `acceptedDomainFactsFromBeacon`
//     doc above for why an unlocked/un-recorded outcome is unobservable —
//     can report a THIRD, DETERMINISTIC status distinct from the existing
//     ambiguous `found: false` ("not accepted as of this instant, but might
//     still be in flight"): `rejected: true` ("this exact operation will
//     NEVER be accepted, full stop — safe to retire without further
//     checking"). This is sound forever, not just at the instant of
//     rejection, because `revision` only ever increases for a given (user,
//     profile) row (nextval() never rewinds) — a `baseRevision` that
//     mismatches `currentRevision` once can never later match it again, so
//     a duplicate delivery of the SAME rejected operation is safe to
//     reject identically without re-deriving anything (route.ts's duplicate
//     check, extended to branch on the ledger row's `status`, handles this
//     directly — see its own doc).
//
// This intentionally treats "baseRevision higher than currentRevision" as
// stale rather than accepting it: a genuinely current client can never
// observe a revision that doesn't exist yet, so such a value is either
// malformed evidence or a corrupted/impossible claim — "fail closed" means
// never merging on the strength of a base this server cannot verify,
// exactly like the genuinely-lower case.
export type BaseRevisionOutcome =
  | { outcome: "no-evidence" }
  | { outcome: "current"; baseRevision: number }
  | { outcome: "stale"; baseRevision: number; currentRevision: number };

export function evaluateOperationBaseRevision(
  baseRevision: number | null,
  currentRevision: number
): BaseRevisionOutcome {
  if (baseRevision === null) return { outcome: "no-evidence" };
  if (baseRevision === currentRevision) return { outcome: "current", baseRevision };
  return { outcome: "stale", baseRevision, currentRevision };
}

/**
 * Reference cases for evaluateOperationBaseRevision() — run from Node:
 *   import { DEV_EVALUATE_OPERATION_BASE_REVISION_CASES, evaluateOperationBaseRevision } from "@/lib/syncPayload";
 *   DEV_EVALUATE_OPERATION_BASE_REVISION_CASES.forEach(c => {
 *     const got = evaluateOperationBaseRevision(c.baseRevision, c.currentRevision);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_EVALUATE_OPERATION_BASE_REVISION_CASES: Array<{
  name: string;
  baseRevision: number | null;
  currentRevision: number;
  expected: BaseRevisionOutcome;
}> = [
  {
    name: "no evidence supplied (old client / untagged write) — skip check regardless of current revision",
    baseRevision: null,
    currentRevision: 42,
    expected: { outcome: "no-evidence" },
  },
  {
    name: "required — fresh device, no row ever existed, base 0 matches current 0 — accepted normally",
    baseRevision: 0,
    currentRevision: 0,
    expected: { outcome: "current", baseRevision: 0 },
  },
  {
    name: "required — current-base first delivery: base matches today's row revision — accepted normally",
    baseRevision: 5,
    currentRevision: 5,
    expected: { outcome: "current", baseRevision: 5 },
  },
  {
    name: "required — operation created at revision A(3), newer write B(7) already landed — stale, rejected",
    baseRevision: 3,
    currentRevision: 7,
    expected: { outcome: "stale", baseRevision: 3, currentRevision: 7 },
  },
  {
    name: "client believes no row exists (base 0) but a row already exists at revision 5 — stale, rejected",
    baseRevision: 0,
    currentRevision: 5,
    expected: { outcome: "stale", baseRevision: 0, currentRevision: 5 },
  },
  {
    name: "impossible claim — base HIGHER than current revision — fails closed as stale, never accepted",
    baseRevision: 9,
    currentRevision: 4,
    expected: { outcome: "stale", baseRevision: 9, currentRevision: 4 },
  },
];

/**
 * Reduces a client's per-domain confirmed state (see "Per-domain confirmed
 * state" above) down to the single best-known `baseRevision` to tag an
 * outgoing tagged operation with — see this section's own doc for why one
 * number is sufficient evidence for a single-row (user, profile) write.
 * Every domain confirmed/conflicted from the SAME push or pull shares one
 * server revision (the row is written as a whole), so the MAXIMUM revision
 * across whatever domains this device has ever observed a fact for is
 * exactly this device's best knowledge of the row's current revision — 0
 * ("no evidence of any prior state") when nothing has ever been confirmed
 * for any domain. A "conflict" result still carries a real revision (the
 * highest one recorded, even though its value is ambiguous) and is
 * included in the max for the same reason: it is still proof that AT LEAST
 * that revision was, at some point, the row's revision — a lower bound
 * that remains valid regardless of which conflicting value was genuinely
 * current at that revision.
 */
export function knownBaseRevisionFromConfirmedState(state: ConfirmedPlannerState): number {
  let max = 0;
  const results: Array<ConfirmedDomainResult<unknown>> = [
    state.plans,
    state.lightning,
    state.days,
    state.dayMeta,
    state.dayParks,
  ];
  for (const result of results) {
    if (result.status === "confirmed" && result.fact.revision > max) max = result.fact.revision;
    else if (result.status === "conflict" && result.revision > max) max = result.revision;
  }
  return max;
}

/**
 * Reference cases for knownBaseRevisionFromConfirmedState() — run from Node:
 *   import { DEV_KNOWN_BASE_REVISION_CASES, knownBaseRevisionFromConfirmedState } from "@/lib/syncPayload";
 *   DEV_KNOWN_BASE_REVISION_CASES.forEach(c => {
 *     const got = knownBaseRevisionFromConfirmedState(c.state);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_KNOWN_BASE_REVISION_CASES: Array<{
  name: string;
  state: ConfirmedPlannerState;
  expected: number;
}> = [
  {
    name: "nothing ever confirmed for any domain — 0 (no evidence)",
    state: {
      plans: { status: "none" },
      lightning: { status: "none" },
      days: { status: "none" },
      dayMeta: { status: "none" },
      dayParks: { status: "none" },
    },
    expected: 0,
  },
  {
    name: "all five domains confirmed at the same revision (an ordinary push/pull) — that revision",
    state: {
      plans: { status: "confirmed", fact: { revision: 5, value: { version: 1, items: [] } } },
      lightning: { status: "confirmed", fact: { revision: 5, value: { version: 1, items: [] } } },
      days: { status: "confirmed", fact: { revision: 5, value: ["day-1"] } },
      dayMeta: { status: "confirmed", fact: { revision: 5, value: {} } },
      dayParks: { status: "confirmed", fact: { revision: 5, value: {} } },
    },
    expected: 5,
  },
  {
    name: "disjoint per-domain revisions (e.g. a dayParks-only cloud win at 7, plans still at 5) — the max",
    state: {
      plans: { status: "confirmed", fact: { revision: 5, value: { version: 1, items: [] } } },
      lightning: { status: "none" },
      days: { status: "confirmed", fact: { revision: 5, value: ["day-1"] } },
      dayMeta: { status: "none" },
      dayParks: { status: "confirmed", fact: { revision: 7, value: { "day-1": "mk" } } },
    },
    expected: 7,
  },
  {
    name: "a conflicted domain's revision still counts toward the max (it is a valid lower bound)",
    state: {
      plans: { status: "conflict", revision: 9 },
      lightning: { status: "confirmed", fact: { revision: 5, value: { version: 1, items: [] } } },
      days: { status: "none" },
      dayMeta: { status: "none" },
      dayParks: { status: "none" },
    },
    expected: 9,
  },
];

// ===== Observed server revision (SH.2.5.1 Codex P1 follow-up) ==============
//
// Codex P1 finding (problem 1): knownBaseRevisionFromConfirmedState() above
// derives `baseRevision` ENTIRELY from per-domain CONFIRMED facts — facts
// only ever recorded for a domain the CLOUD won (see the module doc's
// "Cloud-confirmed local snapshot contract" and commitConfirmedBaseline's
// own doc in syncHelper.ts). A perfectly usable pull can legitimately
// return server revision R while EVERY domain's own local edit wins the
// per-domain comparison (the user has genuinely newer local changes in
// every domain) — nothing is ever recorded as "confirmed" for that pull, on
// purpose, because none of it is true: the cloud's own R-revision VALUES
// were never adopted. But R itself — "this (user, profile) row's server
// revision was AT LEAST R as of this GET" — is a plain, unconditional fact
// about the ROW, independent of which VALUES won. Without a place to record
// that fact, a device whose local edits keep winning never advances its
// `baseRevision` past whatever it last happened to get from a push/cloud-won
// pull, and every later tagged operation keeps getting rejected as stale
// against a server revision the device has, in fact, already seen.
//
// The fix is a SECOND, deliberately separate ratchet — "observed server
// revision" — recorded independently of any domain's value, extending the
// SAME per-(user,profile), physically-immutable-fact architecture
// confirmedFactKey() already established (see its own doc in
// syncHelper.ts), rather than inventing a different sync-state mechanism:
//   • Every fact is just `{ revision }` — no value, so there is no
//     canonical-value conflict to ever detect or fail closed on: two tabs
//     recording the SAME revision cannot disagree, unlike a domain's
//     content. This is strictly simpler than confirmedFactKey's contract.
//   • resolveObservedServerRevision() below reduces any set of these facts
//     to a single number: the maximum `revision` among them, 0 when there
//     are none — mirroring knownBaseRevisionFromConfirmedState()'s own "max
//     across whatever has been recorded" reduction, just over a single flat
//     fact store instead of three per-domain ones.
//   • Because taking a max is commutative and a fact can never be "wrong"
//     (a revision that was genuinely observed stays genuinely observed
//     forever), recordObservedServerRevision() (syncHelper.ts) can prune
//     every fact strictly below the new max immediately after recording a
//     higher one, with NO Web Locks and no read-modify-write hazard: unlike
//     a domain value (where two racing writers could disagree and need a
//     lock-free-but-conflict-aware design), two racing writers here can
//     only ever converge — whichever recorded the higher revision is simply
//     correct, and the reduction at read time is safe regardless of which
//     write's prune pass ran first or was interleaved with the other's scan.
//   • Called from each page's pull effect for EVERY usable pull response
//     (any response carrying a definite numeric `revision`, whether or not
//     it hydrates any domain) — see resolveObservedServerRevisionAdvance()
//     below for the pure "should this call actually write" decision, which
//     is what makes the monotonic guarantee ("never move backward") hold
//     for a genuinely older/delayed pull response landing after a newer one
//     already advanced this device's knowledge.
//   • getKnownBaseRevision() (syncHelper.ts) — the value doPush()/
//     registerUnloadSync() actually attach as `baseRevision` — is now
//     `max(knownBaseRevisionFromConfirmedState(...), getObservedServerRevision(...))`,
//     so a device whose local edits keep winning still advances its
//     baseRevision from the OBSERVED row revision alone, without ever
//     falsely recording any domain's local value as server-confirmed.
export interface ObservedRevisionFact {
  revision: number;
}

export function parseObservedRevisionFact(raw: unknown): ObservedRevisionFact | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.revision !== "number" || !Number.isFinite(r.revision)) return null;
  return { revision: r.revision };
}

/**
 * Reduces any set of recorded observed-revision facts to the single
 * "highest server revision this device has ever observed for this (user,
 * profile) pair" — 0 (the same "nothing known yet" sentinel used
 * everywhere else in this protocol) when `facts` is empty.
 */
export function resolveObservedServerRevision(facts: ObservedRevisionFact[]): number {
  let max = 0;
  for (const fact of facts) {
    if (fact.revision > max) max = fact.revision;
  }
  return max;
}

/**
 * Pure decision core for recordObservedServerRevision() (syncHelper.ts):
 * should recording `candidateRevision`, given the CURRENT max already
 * durably recorded (`currentMax`), actually write anything? Returns `true`
 * only when `candidateRevision` is a genuine advance (strictly greater than
 * `currentMax`) — this is what makes the ratchet MONOTONIC: a stale/older
 * pull response (candidateRevision <= currentMax) is a no-op, never
 * regressing what a later, already-processed response already established,
 * regardless of arrival order.
 */
export function resolveObservedServerRevisionAdvance(candidateRevision: number, currentMax: number): boolean {
  return candidateRevision > currentMax;
}

/**
 * Reference cases for resolveObservedServerRevision()/
 * resolveObservedServerRevisionAdvance() — run from Node:
 *   import { DEV_OBSERVED_SERVER_REVISION_CASES, resolveObservedServerRevision, resolveObservedServerRevisionAdvance } from "@/lib/syncPayload";
 *   DEV_OBSERVED_SERVER_REVISION_CASES.forEach(c => {
 *     const gotMax = resolveObservedServerRevision(c.facts);
 *     const gotAdvance = resolveObservedServerRevisionAdvance(c.candidateRevision, gotMax);
 *     console.log(gotMax === c.expectedMax && gotAdvance === c.expectedAdvance ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_OBSERVED_SERVER_REVISION_CASES: Array<{
  name: string;
  facts: ObservedRevisionFact[];
  candidateRevision: number;
  expectedMax: number;
  expectedAdvance: boolean;
}> = [
  {
    name: "nothing ever observed — max 0, a genuinely first observation advances",
    facts: [],
    candidateRevision: 5,
    expectedMax: 0,
    expectedAdvance: true,
  },
  {
    name: "required — a usable pull observed R while every domain stayed a local winner — still advances",
    facts: [],
    candidateRevision: 7,
    expectedMax: 0,
    expectedAdvance: true,
  },
  {
    name: "required — a genuinely NEWER observation (R+1) after an earlier one (R) — advances",
    facts: [{ revision: 7 }],
    candidateRevision: 8,
    expectedMax: 7,
    expectedAdvance: true,
  },
  {
    name: "required — a stale/older/delayed response (R) arriving after a newer one (R+1) was already recorded — never regresses",
    facts: [{ revision: 8 }],
    candidateRevision: 7,
    expectedMax: 8,
    expectedAdvance: false,
  },
  {
    name: "an exact repeat of the current max is a no-op (redundant, not an advance)",
    facts: [{ revision: 5 }],
    candidateRevision: 5,
    expectedMax: 5,
    expectedAdvance: false,
  },
  {
    name: "multiple recorded facts (e.g. a transient race between two tabs) — max is taken, not the latest write",
    facts: [{ revision: 3 }, { revision: 9 }, { revision: 6 }],
    candidateRevision: 9,
    expectedMax: 9,
    expectedAdvance: false,
  },
];

// ===== Pending-operation domain evidence (SH.2.3 — Unresolved Write
// Provenance & Operation Recovery) =====================================
//
// SH.2.2 left ordinary PUT pushes and unload beacons as two superficially
// similar but structurally different recovery paths: a beacon always
// registered a pending opId (syncHelper.ts's addPendingOp) before this
// device lost the ability to observe its outcome, but an ordinary PUT
// (doPush() in syncHelper.ts) only registered its opId AFTER fetch()
// resolved — a connection drop between the server committing the write and
// the response arriving lost the evidence entirely, even though the server
// itself has a durable, server-verifiable record (see
// acceptedDomainFactsFromBeacon()'s own doc above) that this device could
// have reconciled on its next pull.
//
// A second, subtler gap survived even once BOTH paths register before
// sending: reconcilePendingOperations() (syncHelper.ts) already resolves an
// accepted op against THIS PULL'S OWN CURRENT cloud snapshot/revision —
// never the operation's own stale payload — so an accepted op that cloud
// has since moved past (op A accepted, then device Y pushes B) correctly
// promotes the CONFIRMED baseline to B, not back to A. But confirmed-
// baseline promotion alone does not explain why THIS device's own canonical
// storage still holds A's bytes: a pull's winner-selection compares fresh
// disk content against that baseline, and A's own edit-fact (created when
// the local edit that produced A was made — see LOCAL-EDIT FACT LIFECYCLE
// in syncHelper.ts) is still "surviving" (no local write has retired it —
// only a hydration COMMIT does that, and none has run yet), which is an
// ABSOLUTE VETO against treating A as anything but a fresh, unresolved
// local edit. Without a way to recognize "A is this operation's own,
// now-resolved content — not a still-pending user intent", winner selection
// would treat A as a genuine edit and push it right back over B, silently
// reverting the change B represents.
//
// isPendingOpDomainEvidenceCurrent() is the pure decision this closes: an
// operation's own per-domain evidence, captured at send time (a COMPACT
// FINGERPRINT of its own value — see canonicalDigest() below, Codex P1
// "bound unresolved-operation storage" round — plus the SNAPSHOT of
// local-edit-fact keys that existed for that domain's canonical key at that
// moment, its "edit-fact frontier"), is still the CURRENT explanation for a
// domain's local content only when BOTH:
//   • no edit-fact key exists right now that wasn't already in that
//     frontier (mirrors commitLocalDomainRaw's own baselineEditFactIds
//     re-validation) — a NEWER key means a genuine local edit happened
//     since this operation was sent, and that edit must remain local-first,
//     full stop, regardless of what its bytes happen to be (a revert to
//     the exact same content is still a genuine, newer edit — see
//     hasSurvivingEditFact's own doc in syncHelper.ts for why value-only
//     matching can never stand in for this causal check); AND
//   • the domain's current value's own digest still equals the operation's
//     own recorded digest — belt-and-suspenders: closes the case where some
//     OTHER writer (a hydration commit) already retired the frontier AND
//     moved the canonical key on to a third value, which would otherwise
//     look "frontier-intact" (nothing newer landed FROM AN EDIT) but is not
//     this operation's content anymore.
// When both hold, the caller (reconcilePendingOperations()) may safely
// retire that domain's edit-fact(s) — the same LOCAL-EDIT FACT LIFECYCLE
// retirement a hydration commit performs — and record the domain's CURRENT
// value (already in hand, freshly read to compute the digest above — never
// re-derived from the compact evidence, which no longer carries the full
// value at all) as hydration-provenance-equivalent evidence
// (recordHydrationProvenance() in syncHelper.ts — the SAME non-authoritative
// provenance store SH.2.2 built for reconciled-but-not-pure-cloud hydration
// winners; reused here rather than inventing a parallel one, per this
// phase's "one operation-lifecycle model" requirement), so a subsequent
// pull's hydration-provenance check recognizes A as explained and lets
// whatever the CURRENT confirmed baseline is (B, if cloud has advanced) win
// normally, instead of misreading stale-but-accepted A as fresh intent. See
// reconcilePendingOperations()'s own doc in syncHelper.ts for the ORDERING
// this enables — provenance recorded durably BEFORE either the edit-fact or
// the pending-op itself is retired (Codex P1 "provenance before retirement"
// round).
//
// Codex P1 fix ("bound unresolved-operation storage" round) — the ORIGINAL
// SH.2.3 design stored each pending operation's own FULL per-domain value
// (the entire Plans/Lightning/Days dataset) inside the pending-op record,
// once per unresolved operation. A device that accumulates several
// unresolved operations (e.g. a flaky connection producing repeated lost
// responses — precisely the scenario this phase exists to make recoverable)
// would then durably duplicate the ENTIRE planner dataset once per
// unresolved op, working directly against the LOCAL-FIRST DURABILITY
// CONTRACT this codebase treats as a hard invariant (unbounded local
// storage growth can itself cause localStorage writes — ordinary edits
// included — to start failing on quota). A bare retention cap (e.g. "keep
// only the N most recent pending ops") was rejected: an operation dropped
// under such a cap is UNRESOLVED CORRECTNESS EVIDENCE, not disposable
// cache — discarding it reopens exactly the "server accepted it, this
// device can no longer prove what it resolved into" gap this phase closes.
//
// canonicalDigest() is the fix: pending-op evidence now stores a small,
// FIXED-SIZE fingerprint of each domain's value (16 hex characters,
// regardless of how large the underlying Plans/Lightning/Days dataset is)
// instead of the value itself. This is sufficient for
// isPendingOpDomainEvidenceCurrent()'s only actual need — "does the domain's
// CURRENT value still canonically equal what this operation sent" — a
// boolean equality check that a digest answers exactly as well as the full
// value would, at O(1) storage instead of O(dataset size) PER PENDING
// OPERATION. The full value is never needed again once digested: at
// reconciliation time, the domain's CURRENT durable value is read fresh
// anyway (to compute its own digest for comparison) — that SAME freshly-read
// value is what gets passed to recordHydrationProvenance() on a match, so no
// caller ever needs the operation's own original value bytes back out of
// this store. A 16-hex-character fingerprint is not collision-proof in the
// cryptographic sense, but this is a LOCAL, single-device reconciliation
// heuristic, not a security boundary — see canonicalDigest()'s own doc for
// why an accidental collision here is not a realistic concern, and note
// that even a hypothetical collision could only ever cause a MISSED
// retire+provenance opportunity or a spurious one on byte-identical
// content, never data loss (the edit-fact frontier check above is the
// structural protection against a genuine edit being mistaken for resolved
// operation content — digest equality alone was never that protection).
export interface PendingOpDomainEvidence {
  digest: string;
  editFactKeys: string[];
}

export interface PendingOpRecord {
  opId: string;
  domains: Partial<Record<"plans" | "lightning" | "days" | "dayMeta" | "dayParks", PendingOpDomainEvidence>>;
}

/**
 * A compact, fixed-size (16 hex chars = 64 bits), deterministic fingerprint
 * of an arbitrary JSON-serializable value, computed over its CANONICAL form
 * (canonicalizeJSON() above) so key order never affects the result — two
 * differently-ordered-but-equal objects always digest identically, matching
 * every OTHER equality check in this codebase (isExactCloudValue,
 * confirmedDomainResultsEqual, etc.), all of which already compare via
 * canonicalizeJSON() rather than raw JSON.stringify().
 *
 * Two independent 32-bit rolling hashes (different seeds/mixing, FNV-1a and
 * a DJB2 variant) run over the same canonical string and are concatenated —
 * cheap enough to compute synchronously on every write, including from a
 * beforeunload handler (registerUnloadSync()'s beacon path), which cannot
 * reliably await an async Web Crypto digest. A 64-bit keyspace makes an
 * accidental collision between two genuinely different planner payloads not
 * a realistic concern for this use: a LOCAL, single-device reconciliation
 * heuristic, never a security or integrity boundary (see this section's own
 * module doc above for what a hypothetical collision could and could not
 * cause).
 */
export function canonicalDigest(value: unknown): string {
  const canonical = canonicalizeJSON(value);
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 = Math.imul(h2, 33) ^ c;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/**
 * Reference cases for canonicalDigest(). Run from Node:
 *   import { DEV_CANONICAL_DIGEST_CASES, canonicalDigest } from "@/lib/syncPayload";
 *   DEV_CANONICAL_DIGEST_CASES.forEach(c => {
 *     const got = canonicalDigest(c.value);
 *     const ok = c.equalTo !== undefined ? got === canonicalDigest(c.equalTo) : got !== canonicalDigest(c.differentFrom);
 *     console.log(ok ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_CANONICAL_DIGEST_CASES: Array<{
  name: string;
  value: unknown;
  equalTo?: unknown;
  differentFrom?: unknown;
}> = [
  {
    name: "required — deterministic: the same value digests identically across calls",
    value: { version: 1, items: ["A", "B"] },
    equalTo: { version: 1, items: ["A", "B"] },
  },
  {
    name: "required — canonical: differently-ordered keys digest identically",
    value: { items: ["A", "B"], version: 1 },
    equalTo: { version: 1, items: ["A", "B"] },
  },
  {
    name: "required — a genuinely different value digests differently",
    value: { version: 1, items: ["A"] },
    differentFrom: { version: 1, items: ["A", "B"] },
  },
  {
    name: "different value shape (array vs object) digests differently",
    value: ["day-1", "day-2"],
    differentFrom: { version: 1, items: [] },
  },
  {
    name: "empty vs non-empty digests differently",
    value: { version: 1, items: [] },
    differentFrom: { version: 1, items: ["A"] },
  },
];

export function isPendingOpDomainEvidenceCurrent(
  currentEditFactKeys: string[],
  frontierEditFactKeys: string[],
  currentDigest: string,
  operationDigest: string
): boolean {
  const frontier = new Set(frontierEditFactKeys);
  const frontierIntact = currentEditFactKeys.every((key) => frontier.has(key));
  if (!frontierIntact) return false;
  return currentDigest === operationDigest;
}

/**
 * Reference cases for isPendingOpDomainEvidenceCurrent(). Run from Node:
 *   import { DEV_PENDING_OP_DOMAIN_EVIDENCE_CASES, isPendingOpDomainEvidenceCurrent, canonicalDigest } from "@/lib/syncPayload";
 *   DEV_PENDING_OP_DOMAIN_EVIDENCE_CASES.forEach(c => {
 *     const got = isPendingOpDomainEvidenceCurrent(c.currentEditFactKeys, c.frontierEditFactKeys, canonicalDigest(c.currentValue), canonicalDigest(c.operationValue));
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_PENDING_OP_DOMAIN_EVIDENCE_CASES: Array<{
  name: string;
  currentEditFactKeys: string[];
  frontierEditFactKeys: string[];
  currentValue: unknown;
  operationValue: unknown;
  expected: boolean;
}> = [
  {
    name: "required — no edit since send, content still matches: evidence current, safe to retire+record",
    currentEditFactKeys: ["dwp:localEditFact:k:e1"],
    frontierEditFactKeys: ["dwp:localEditFact:k:e1"],
    currentValue: { version: 1, items: ["A"] },
    operationValue: { version: 1, items: ["A"] },
    expected: true,
  },
  {
    name: "required — both empty frontiers (no edit fact ever existed) and content matches: still current",
    currentEditFactKeys: [],
    frontierEditFactKeys: [],
    currentValue: ["day-1"],
    operationValue: ["day-1"],
    expected: true,
  },
  {
    name: "required — a NEWER edit-fact key exists beyond the frontier: genuine local edit, never treated as resolved even if bytes happen to match (revert case)",
    currentEditFactKeys: ["dwp:localEditFact:k:e1", "dwp:localEditFact:k:e2-newer"],
    frontierEditFactKeys: ["dwp:localEditFact:k:e1"],
    currentValue: { version: 1, items: ["A"] },
    operationValue: { version: 1, items: ["A"] },
    expected: false,
  },
  {
    name: "required — frontier's own key was already retired by something else (e.g. a hydration commit) and canonical moved on to a third value: not this operation's content anymore",
    currentEditFactKeys: [],
    frontierEditFactKeys: ["dwp:localEditFact:k:e1"],
    currentValue: { version: 1, items: ["C-from-elsewhere"] },
    operationValue: { version: 1, items: ["A"] },
    expected: false,
  },
  {
    name: "frontier intact but content diverges (defensive belt-and-suspenders case): not current",
    currentEditFactKeys: ["dwp:localEditFact:k:e1"],
    frontierEditFactKeys: ["dwp:localEditFact:k:e1"],
    currentValue: { version: 1, items: ["B"] },
    operationValue: { version: 1, items: ["A"] },
    expected: false,
  },
];

// ===== ACCEPTED-OPERATION MATERIALIZATION (SH.2.5.2, Codex review
// "accepted-operation reconciliation" finding) =====
//
// ROOT CAUSE: once isPendingOpDomainEvidenceCurrent() (above) confirmed an
// accepted operation's evidence is still current, reconcilePendingOperations()
// (syncHelper.ts) recorded replacement hydration-provenance and then retired
// this domain's `currentEditFactKeys` directly — but it never checked
// whether CANONICAL STORAGE ITSELF already held the accepted value.
// `currentRaw` (the value evidence matched) comes from
// readLatestDurableValue(), which can be authoritative via a SURVIVING
// FACT while canonical underneath stays stale (e.g. SH.2.4's own
// "committed-unprotected" persist outcome — the fact leg of an edit
// landed, the canonical leg did not). Retiring that fact the moment its
// operation is accepted, without first writing the accepted value into
// canonical, deletes the ONLY durable evidence for it: the very next
// readLatestDurableValue() call for this key resolves to stale canonical
// bytes, which a later pull can then treat as this device's own current
// state and push right back over the server.
//
// THE FIX (reconcilePendingOperations()'s own doc in syncHelper.ts has the
// full rationale): before retiring `currentEditFactKeys`, first check
// whether canonical already holds `currentRaw`. If so, retirement is
// already safe exactly as before. If not, materialize `currentRaw` into
// canonical via commitLocalDomainRaw() — the SAME CAS/authority-protected
// primitive every other durable local-domain write uses — passing
// `currentEditFactKeys` as that commit's own baseline, so retirement stays
// scoped to EXACTLY the frontier this decision observed (never a fact
// outside it — see commitLocalDomainRaw's own LOCAL-EDIT FACT LIFECYCLE
// doc). Only a "committed" or "noop" outcome (canonical durably holds the
// value, by this call or a concurrent one) permits retirement; any other
// outcome — most importantly "superseded", when a genuinely newer/
// concurrent fact landed after this decision's own snapshot — leaves the
// fact(s) and the pending-op record fully intact for a later pull to
// retry, never deleting or overwriting the newer evidence.
//
// The cases below model that exact decision purely, composing the SAME
// real resolveEffectiveDurableRaw() production primitive the fix itself
// calls (to derive `currentRaw` from canonical + the observed fact
// frontier) plus a `newerFactLanded` flag standing in for
// commitLocalDomainRaw()'s own re-scan (modeled the SAME way
// DEV_HYDRATION_NOOP_SAFETY_CASES' `liveFactKeysGrew` and
// DEV_COMMIT_TIME_AUTHORITY_GATE_CASES' `editFactGrew` already do) —
// reduced to this decision's actual inputs/outputs, not a reimplementation.
export type AcceptedOperationMaterializationOutcome = "retired-noop" | "materialized-and-retired" | "retained";

/**
 * Reference cases for reconcilePendingOperations()'s materialize-before-
 * retire decision — the REQUIRED cases from the SH.2.5.2 architectural
 * contract. Run from Node:
 *   import { DEV_ACCEPTED_OPERATION_MATERIALIZATION_CASES, resolveEffectiveDurableRaw } from "@/lib/syncPayload";
 *   DEV_ACCEPTED_OPERATION_MATERIALIZATION_CASES.forEach(c => {
 *     const currentRaw = resolveEffectiveDurableRaw(c.canonicalRawAtDecision, c.factRawValues);
 *     let got: string;
 *     if (c.canonicalRawAtDecision === currentRaw) got = "retired-noop";
 *     else if (c.newerFactLanded) got = "retained";
 *     else got = "materialized-and-retired";
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_ACCEPTED_OPERATION_MATERIALIZATION_CASES: Array<{
  name: string;
  canonicalRawAtDecision: string | null;
  factRawValues: string[];
  newerFactLanded: boolean;
  expected: AcceptedOperationMaterializationOutcome;
}> = [
  {
    name: "SH.2.5.2 required — canonical B + authoritative fact A + accepted operation A: reconciliation must NOT retire A while canonical still holds stale B — materializes A into canonical first, then retires",
    canonicalRawAtDecision: "B",
    factRawValues: ["A"],
    newerFactLanded: false,
    expected: "materialized-and-retired",
  },
  {
    name: "already-materialized happy path — canonical already holds the accepted value (the common case, both legs of the original edit landed): retire directly, no write needed",
    canonicalRawAtDecision: "A",
    factRawValues: ["A"],
    newerFactLanded: false,
    expected: "retired-noop",
  },
  {
    name: "SH.2.5.2 required — a newer/concurrent fact appears during materialization: must never be deleted or overwritten — the whole domain is retained (left untouched) for a later pull to retry",
    canonicalRawAtDecision: "B",
    factRawValues: ["A"],
    newerFactLanded: true,
    expected: "retained",
  },
  {
    name: "SH.2.5.2 — unanimous multi-fact agreement protecting a stale canonical value materializes exactly like a single fact would",
    canonicalRawAtDecision: "B",
    factRawValues: ["A", "A"],
    newerFactLanded: false,
    expected: "materialized-and-retired",
  },
  {
    name: "no facts at all, canonical alone already carries the accepted value (evidence matched via canonical, not a fact): retire (trivially empty) directly",
    canonicalRawAtDecision: "A",
    factRawValues: [],
    newerFactLanded: false,
    expected: "retired-noop",
  },
];

// ===== Hydration-provenance dedup/pruning (SH.2.3 — Codex P1 "deduplicate
// same-revision hydration provenance facts" round) =========================
//
// ROOT ISSUE: recordHydrationProvenance() (syncHelper.ts) writes a new,
// permanently-unique-keyed full-value record on EVERY call, and previously
// self-pruned only STRICTLY OLDER revisions (`r < revision`) — deliberately,
// so a genuinely concurrent OTHER tab's own same-revision-but-different
// hydration result would never be discarded (see pruneHydrationProvenanceFacts's
// own doc above for why `<` there and `<=` at recordConfirmedFact's cross-
// store call site are DIFFERENT, both-correct semantics). But "preserve
// same-revision siblings" was never meant to mean "preserve same-revision
// DUPLICATES": repeated reconciliation at an UNCHANGED server revision —
// ordinary, expected behavior, not an edge case (every reload's mount pull
// while nothing has changed cloud-side, and SH.2.3's own accepted-operation
// reconciliation loop, both call recordHydrationProvenance() again and again
// at the SAME revision with the SAME value once nothing new has happened) —
// had no mechanism to recognize "this exact value at this exact revision is
// already durably recorded" and kept accumulating canonically-identical
// full-value records indefinitely, working directly against the very
// storage-boundedness canonicalDigest() (above) was built to establish for
// pending-op evidence.
//
// planHydrationProvenanceDedup() is the pure decision this closes, factored
// out from the actual localStorage scan (which stays in
// recordHydrationProvenance(), syncHelper.ts — this function only reasons
// over already-parsed `{key, revision, value}` records) so it can be
// exercised directly via the DEV_* cases below, matching this codebase's
// established "pure decision here, I/O wrapper in syncHelper.ts" pattern
// (decideLocalDomainCommit, resolveConfirmedDomainState, etc.). Given the
// full CURRENT set of recorded facts for one (userId, profileId, domain) and
// the `{revision, value}` about to be recorded:
//   • Any fact strictly OLDER than `revision` is marked for deletion —
//     UNCHANGED from the previous self-pruning behavior; see
//     pruneHydrationProvenanceFacts's own doc for why this is safe (a later
//     write proves the canonical key has moved on, so no older record can
//     ever again explain current disk content).
//   • Among facts at EXACTLY `revision`, grouped by their OWN canonical
//     value: the FIRST fact encountered per distinct canonical value is kept
//     as that value's sole survivor; any FURTHER fact whose value canonically
//     matches an already-kept survivor is ALSO marked for deletion — this is
//     the actual dedup (collapses however many duplicate records have
//     already accumulated for one distinct value down to one, self-healing
//     even a keyspace that grew before this fix shipped). A fact at
//     `revision` whose value canonically DIFFERS from every other same-
//     revision fact seen so far is always kept as its own group's survivor —
//     genuinely different same-revision siblings from a real concurrent
//     writer race are never touched, exactly preserving the existing
//     "same-revision siblings coexist" guarantee this round must not
//     regress.
//   • A fact at any revision STRICTLY NEWER than `revision` is never
//     inspected or touched by this call at all — unchanged from before;
//     each write only ever reasons about revisions up to its own.
//   • `writeNew` is `false` exactly when an EXISTING fact at `revision`
//     already canonically equals the value about to be recorded — the
//     durable invariant ("this value at this revision is recorded") already
//     holds, so writing yet another physically-unique duplicate key would
//     only grow storage for zero informational gain. `true` otherwise: no
//     existing same-revision fact matches (either none exist yet at this
//     revision, or every one present is a genuinely different sibling), so a
//     new key is needed to preserve that distinct value.
export interface HydrationProvenanceFactRecord {
  key: string;
  revision: number;
  value: unknown;
}

export interface HydrationProvenanceDedupPlan {
  writeNew: boolean;
  keysToDelete: string[];
}

export function planHydrationProvenanceDedup(
  existing: HydrationProvenanceFactRecord[],
  revision: number,
  value: unknown
): HydrationProvenanceDedupPlan {
  const targetCanonical = canonicalizeJSON(value);
  const keysToDelete: string[] = [];
  let alreadyPresent = false;
  const survivorForCanonical = new Map<string, string>();
  for (const fact of existing) {
    if (fact.revision < revision) {
      keysToDelete.push(fact.key);
      continue;
    }
    if (fact.revision !== revision) continue;
    const factCanonical = canonicalizeJSON(fact.value);
    if (factCanonical === targetCanonical) alreadyPresent = true;
    const survivorKey = survivorForCanonical.get(factCanonical);
    if (survivorKey === undefined) {
      survivorForCanonical.set(factCanonical, fact.key);
    } else {
      keysToDelete.push(fact.key);
    }
  }
  return { writeNew: !alreadyPresent, keysToDelete };
}

/**
 * Reference cases for planHydrationProvenanceDedup(). Run from Node:
 *   import { DEV_HYDRATION_PROVENANCE_DEDUP_CASES, planHydrationProvenanceDedup } from "@/lib/syncPayload";
 *   DEV_HYDRATION_PROVENANCE_DEDUP_CASES.forEach(c => {
 *     const got = planHydrationProvenanceDedup(c.existing, c.revision, c.value);
 *     const ok = got.writeNew === c.expected.writeNew && JSON.stringify([...got.keysToDelete].sort()) === JSON.stringify([...c.expected.keysToDelete].sort());
 *     console.log(ok ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_HYDRATION_PROVENANCE_DEDUP_CASES: Array<{
  name: string;
  existing: HydrationProvenanceFactRecord[];
  revision: number;
  value: unknown;
  expected: HydrationProvenanceDedupPlan;
}> = [
  {
    name: "required — repeated identical value at the same revision: no new write, nothing to delete",
    existing: [{ key: "k1", revision: 5, value: { version: 1, items: ["A"] } }],
    revision: 5,
    value: { version: 1, items: ["A"] },
    expected: { writeNew: false, keysToDelete: [] },
  },
  {
    name: "required — no existing fact yet at this revision: write needed, nothing to delete",
    existing: [],
    revision: 5,
    value: { version: 1, items: ["A"] },
    expected: { writeNew: true, keysToDelete: [] },
  },
  {
    name: "required — a genuinely DIFFERENT value at the same revision (concurrent writer): both must coexist — write needed, the differing sibling is NOT deleted",
    existing: [{ key: "k1", revision: 5, value: { version: 1, items: ["OTHER-TAB"] } }],
    revision: 5,
    value: { version: 1, items: ["A"] },
    expected: { writeNew: true, keysToDelete: [] },
  },
  {
    name: "required — newer revision prunes obsolete strictly-older facts",
    existing: [
      { key: "old1", revision: 3, value: { version: 1, items: ["stale"] } },
      { key: "old2", revision: 4, value: { version: 1, items: ["also-stale"] } },
    ],
    revision: 5,
    value: { version: 1, items: ["A"] },
    expected: { writeNew: true, keysToDelete: ["old1", "old2"] },
  },
  {
    name: "a revision STRICTLY NEWER than this write is never touched",
    existing: [{ key: "future", revision: 9, value: { version: 1, items: ["from-the-future"] } }],
    revision: 5,
    value: { version: 1, items: ["A"] },
    expected: { writeNew: true, keysToDelete: [] },
  },
  {
    name: "self-healing — collapses pre-existing same-revision duplicates of the SAME value down to one survivor, even though no new write is needed",
    existing: [
      { key: "dup1", revision: 5, value: { version: 1, items: ["A"] } },
      { key: "dup2", revision: 5, value: { version: 1, items: ["A"] } },
      { key: "dup3", revision: 5, value: { version: 1, items: ["A"] } },
    ],
    revision: 5,
    value: { version: 1, items: ["A"] },
    expected: { writeNew: false, keysToDelete: ["dup2", "dup3"] },
  },
  {
    name: "mixed — one duplicate of the target value collapsed, one genuinely different sibling preserved, one older revision pruned",
    existing: [
      { key: "dup", revision: 5, value: { version: 1, items: ["A"] } },
      { key: "sibling", revision: 5, value: { version: 1, items: ["B-from-other-tab"] } },
      { key: "old", revision: 2, value: { version: 1, items: ["ancient"] } },
    ],
    revision: 5,
    value: { version: 1, items: ["A"] },
    expected: { writeNew: false, keysToDelete: ["old"] },
  },
  {
    name: "canonical equality — differently-ordered keys count as the same value for dedup purposes too",
    existing: [{ key: "k1", revision: 5, value: { items: ["A"], version: 1 } }],
    revision: 5,
    value: { version: 1, items: ["A"] },
    expected: { writeNew: false, keysToDelete: [] },
  },
];

// ===== Cross-store hydration-provenance pruning (SH.2.3 — Codex P1
// "preserve hydration provenance that still describes canonical local
// storage" round) ============================================================
//
// ROOT ISSUE: recordConfirmedFactBody() (syncHelper.ts) — the shared core
// behind BOTH commitDomainHydration()'s pure-cloud-value branch AND
// commitConfirmedBaseline() (called by doPush()'s synchronous confirmation
// AND by SH.2.3's own reconcilePendingOperations()) — cross-store-prunes
// EVERY hydration-provenance fact for a domain at `<= revision` the moment
// it records ANY confirmed fact for that domain at that revision, on the
// stated assumption that "this call's own [...] commit already proved the
// canonical key holds exactly what this write recorded" (see
// pruneHydrationProvenanceFacts's own doc above).
//
// That assumption is TRUE for commitDomainHydration()'s call: it happens
// immediately after commitLocalDomainRaw() has ALREADY CAS-written
// `nextRaw` to the SAME canonical key, inside the SAME held lock — canonical
// storage genuinely does hold exactly the confirmed value at that instant.
// It is FALSE for doPush()'s (and reconcilePendingOperations()'s) call:
// commitConfirmedBaseline() never writes canonical storage at all — it
// merely records, as a confirmed fact, whatever a domain's canonical value
// ALREADY WAS at some earlier moment (payload-build time for doPush(), or
// "whatever this pull's own cloud snapshot reported" for
// reconcilePendingOperations()). A pull may previously have persisted a
// NON-PURE reconciled local value (recorded only as hydration provenance,
// per isExactCloudValue()'s own doc — never as confirmed authority, since it
// is not byte-for-byte the literal cloud value) for some OTHER domain in the
// SAME combined payload. A later, unrelated push (or accepted-operation
// reconciliation) that confirms a DIFFERENT domain's edit still calls
// commitConfirmedBaseline() for ALL THREE domains (the combined payload
// always includes plans+lightning), advancing confirmed authority's
// revision ceiling for the untouched domain too — even though canonical
// local storage for THAT domain was never touched, is still the earlier
// non-pure reconciled value, and is NOT reliably what the newly-recorded
// confirmed fact's own value says (a stale doPush() snapshot, or a
// genuinely conflicted same-revision write, can each record a confirmed
// fact whose value does not match current canonical bytes). The blind
// `<= revision` sweep deletes that domain's ONLY hydration-provenance
// explanation regardless, leaving canonical local storage's still-present,
// still-unexplained bytes to be misread as a fresh local edit by whichever
// pull looks next — and pushed right back over newer cloud data.
//
// isHydrationProvenanceFactObsoleteAfterConfirm() is the pure fix: a
// hydration-provenance fact is safe to prune ONLY when it is PROVEN no
// longer necessary to explain canonical local content — never merely
// because SOME confirmed fact was recorded at or above its revision. Given
// one fact's own `{revision, value}`, the revision of the confirm that just
// happened, and the domain's CURRENT canonical/durable value (read fresh,
// right now, by the caller — see recordConfirmedFactBody's own doc for how):
//   • a fact strictly NEWER than the confirmed revision is never touched —
//     unchanged from the original bound; this call has no basis to reason
//     about a revision it hasn't reached yet.
//   • a fact at or below the confirmed revision is obsolete — safe to
//     delete — ONLY when its OWN value no longer canonically matches
//     CURRENT canonical content. If it STILL matches, canonical storage has
//     not moved on from what this record explains — regardless of whether a
//     newly-recorded confirmed fact's VALUE happens to agree or disagree,
//     deleting the only surviving explanation for bytes that are still
//     sitting on disk right now is never safe.
// This generalizes rather than replaces the original "commitDomainHydration
// just wrote this value" reasoning: when that assumption holds (the
// hydration path), current canonical content trivially equals the
// newly-confirmed value, so every OTHER, genuinely different, older record
// is still correctly judged obsolete — behavior is unchanged for that path.
// When it doesn't hold (the push/reconciliation path), reading current
// canonical content fresh is what makes the decision correct instead of
// merely convenient.
export function isHydrationProvenanceFactObsoleteAfterConfirm(
  factRevision: number,
  factValue: unknown,
  confirmedRevision: number,
  currentCanonicalValue: unknown
): boolean {
  if (factRevision > confirmedRevision) return false;
  return canonicalizeJSON(factValue) !== canonicalizeJSON(currentCanonicalValue);
}

/**
 * Reference cases for isHydrationProvenanceFactObsoleteAfterConfirm(). Run
 * from Node:
 *   import { DEV_HYDRATION_PROVENANCE_OBSOLETE_AFTER_CONFIRM_CASES, isHydrationProvenanceFactObsoleteAfterConfirm } from "@/lib/syncPayload";
 *   DEV_HYDRATION_PROVENANCE_OBSOLETE_AFTER_CONFIRM_CASES.forEach(c => {
 *     const got = isHydrationProvenanceFactObsoleteAfterConfirm(c.factRevision, c.factValue, c.confirmedRevision, c.currentCanonicalValue);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_HYDRATION_PROVENANCE_OBSOLETE_AFTER_CONFIRM_CASES: Array<{
  name: string;
  factRevision: number;
  factValue: unknown;
  confirmedRevision: number;
  currentCanonicalValue: unknown;
  expected: boolean;
}> = [
  {
    name: "required — the core fix: a non-pure hydration value STILL on canonical storage survives a confirm of an unrelated domain at a higher revision",
    factRevision: 5,
    factValue: { version: 1, items: ["non-pure-reconciled-A"] },
    confirmedRevision: 9,
    currentCanonicalValue: { version: 1, items: ["non-pure-reconciled-A"] },
    expected: false,
  },
  {
    name: "required — a genuinely superseded older value (canonical has moved on) is obsolete",
    factRevision: 5,
    factValue: { version: 1, items: ["stale-A"] },
    confirmedRevision: 9,
    currentCanonicalValue: { version: 1, items: ["newer-B"] },
    expected: true,
  },
  {
    name: "required — a fact strictly newer than the confirmed revision is never touched, even if its value differs from current canonical content",
    factRevision: 10,
    factValue: { version: 1, items: ["from-the-future"] },
    confirmedRevision: 9,
    currentCanonicalValue: { version: 1, items: ["something-else"] },
    expected: false,
  },
  {
    name: "fact revision equals confirmed revision, value matches current canonical: survives (redundant with confirmed authority, but never destructively pruned merely for being redundant)",
    factRevision: 9,
    factValue: { version: 1, items: ["A"] },
    confirmedRevision: 9,
    currentCanonicalValue: { version: 1, items: ["A"] },
    expected: false,
  },
  {
    name: "canonical equality — differently-ordered keys still count as matching current canonical content",
    factRevision: 5,
    factValue: { items: ["A"], version: 1 },
    confirmedRevision: 9,
    currentCanonicalValue: { version: 1, items: ["A"] },
    expected: false,
  },
  {
    name: "days domain — plain array values compare correctly too",
    factRevision: 5,
    factValue: ["day-1", "day-2"],
    confirmedRevision: 9,
    currentCanonicalValue: ["day-1", "day-3"],
    expected: true,
  },
];

// ===== SERVER-SIDE MERGE-ON-WRITE (SH.1 — Authoritative Planner Sync Core) =====

/**
 * Optional domain keys: MAY be absent from an incoming write without that
 * being an intentional clear (unlike `plans`/`lightning`, which
 * parseSyncedPlannerPayload requires on every valid payload and which
 * mergePlannerDomains() below therefore always takes from the incoming
 * write, present-empty included — Clear All must actually clear the cloud
 * copy, not be treated as "no opinion").
 *
 * SH.3.2 — "dayMeta" is appended here (plus its own parseSyncedPlannerPayload
 * extraction, already added above) to make it a synced domain — no other
 * change to mergePlannerDomains() was needed to support that, exactly as
 * this doc predicted. SH.3.3 appends "dayParks" the same way. A future SH.3
 * slice may append "dayAutoFallbacks" identically, if it too becomes a
 * synced domain (currently out of scope — it stays local-only/derived).
 */
const OPTIONAL_DOMAIN_KEYS = ["days", "dayMeta", "dayParks"] as const;

/**
 * Every top-level key a SH.1 server build recognizes: the `version`
 * control field plus every domain (required or optional). Used only by
 * findUnknownDomainKeys() below — mergePlannerDomains() itself never
 * consults this, since it only ever reads specific named keys off
 * `incomingRaw` and was therefore never at risk of leaking an unknown key
 * into storage; the risk was the opposite (see findUnknownDomainKeys doc).
 */
const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set<string>([
  "version",
  "plans",
  "lightning",
  ...OPTIONAL_DOMAIN_KEYS,
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Codex P2 fix — returns the top-level keys in `incomingRaw` that this
 * server build does not recognize as any known domain or control field.
 *
 * mergePlannerDomains() correctly preserves an unknown domain ALREADY
 * present in a stored row (its merge base is the existing row, spread
 * as-is), but that is a different direction from this check: a domain
 * arriving for the FIRST TIME in the current write, under a key this
 * server build has never heard of, has no schema to validate against and
 * is never copied into `merged` by mergePlannerDomains() (which only ever
 * reads specific known keys off `incomingRaw`) — so before this fix, such
 * a write validated successfully (parseSyncedPlannerPayload only checks
 * version/plans/lightning/days) and was silently persisted MINUS that
 * key, while still returning 200. A write must never succeed while
 * discarding part of what it was asked to persist.
 *
 * The caller rejects the whole write (400) when this returns any keys,
 * rather than guessing at how to safely store an unvalidated shape under
 * an unrecognized name — there is no schema for this server build to
 * check it against, so silently accepting it would reopen the same
 * "store anything JSON-parseable" gap SH.1 closed for the payload as a
 * whole, just scoped to unknown keys instead. Once a later phase adds a
 * domain to KNOWN_TOP_LEVEL_KEYS (and OPTIONAL_DOMAIN_KEYS), the
 * identical write is recognized and persisted normally — no client-side
 * change required.
 */
export function findUnknownDomainKeys(incomingRaw: Record<string, unknown>): string[] {
  return Object.keys(incomingRaw).filter((k) => !KNOWN_TOP_LEVEL_KEYS.has(k));
}

/**
 * Compute the JSON-serializable object to persist for a validated planner
 * write, given whatever is currently stored for this (user, profile).
 *
 * This is the generalized replacement for the old bespoke "if incoming
 * lacks `days`, read existing `days` and splice it in" block that used to
 * live in the PUT route. It is intentionally NOT built by starting from the
 * incoming payload and splicing in known-preservable fields — that shape
 * only protects domains this exact server build already knows the name of.
 * Instead it starts from the EXISTING stored object (`existingRaw`, spread
 * as-is, unknown keys included) and overlays only the domains the
 * INCOMING payload actually validates for:
 *
 *   - `plans` / `lightning` — always overlaid unconditionally from
 *     `incomingRaw` (parseSyncedPlannerPayload already guarantees both are
 *     present and valid on any non-null `incomingParsed`), so a genuinely
 *     empty push (e.g. Clear All) still clears the cloud copy — present
 *     empty is a real, intentional value, never conflated with absent.
 *   - Each key in OPTIONAL_DOMAIN_KEYS — overlaid from `incomingRaw` only
 *     when `incomingParsed` has a defined value for it (present AND
 *     valid); otherwise `base`'s existing value for that key (if any) is
 *     left completely untouched by this function, simply because nothing
 *     ever writes over it.
 *   - Every other key already present in `base` — including a domain this
 *     server build has never heard of (e.g. a future SH.3 `dayAutoFallbacks`
 *     domain written by a newer client, then this same profile receiving a
 *     write from an old client whose payload structurally has no
 *     `dayAutoFallbacks` field at all) — survives untouched via the initial
 *     object spread.
 *     This is what makes future-domain preservation NOT require a new
 *     per-field branch here: the mechanism doesn't need to know a
 *     domain's name to protect it, only the domains it's actively
 *     overlaying need to be named.
 *
 * Pure and DB-agnostic — callers own reading `existingRaw` (already
 * `JSON.parse`d, or null when no row exists / it failed to parse) under
 * whatever locking they use; this function makes no I/O decisions.
 */
export function mergePlannerDomains(
  existingRaw: unknown,
  incomingRaw: Record<string, unknown>,
  incomingParsed: SyncedPlannerPayload
): Record<string, unknown> {
  const base = isPlainObject(existingRaw) ? existingRaw : {};
  const merged: Record<string, unknown> = { ...base, version: 1 };
  merged.plans = incomingRaw.plans;
  merged.lightning = incomingRaw.lightning;
  for (const key of OPTIONAL_DOMAIN_KEYS) {
    if (incomingParsed[key] !== undefined) {
      merged[key] = incomingRaw[key];
    }
    // else: leave whatever `base` already had (or didn't have) for this
    // key completely untouched — this is the "absent = preserve" rule,
    // achieved by never writing the key rather than by looking up and
    // re-splicing a preserved value.
  }
  return merged;
}

// ===== Dev-only validation (SH.1) =====

/**
 * Reference cases for mergePlannerDomains()'s absent/present/unknown-domain
 * semantics — most importantly the "unknown future domain" case, which is
 * the exact GET -> old-client -> PUT protection SH.1 exists to guarantee
 * structurally rather than per-field.
 *
 * Run from Node (mirrors the DEV_PLAN_ALIAS_CASES convention in
 * plansMatching.ts):
 *   import { DEV_MERGE_CASES, mergePlannerDomains } from "@/lib/syncPayload";
 *   DEV_MERGE_CASES.forEach(c => {
 *     const got = mergePlannerDomains(c.existingRaw, c.incomingRaw, c.incomingParsed);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_MERGE_CASES: Array<{
  name: string;
  existingRaw: unknown;
  incomingRaw: Record<string, unknown>;
  incomingParsed: SyncedPlannerPayload;
  expected: Record<string, unknown>;
}> = [
  {
    name: "no existing row — fresh insert, days present",
    existingRaw: null,
    incomingRaw: { version: 1, plans: { version: 1, items: ["p"] }, lightning: { version: 1, items: [] }, days: ["day-1"] },
    incomingParsed: { version: 1, plans: { version: 1, items: ["p"] }, lightning: { version: 1, items: [] }, days: ["day-1"] },
    expected: { version: 1, plans: { version: 1, items: ["p"] }, lightning: { version: 1, items: [] }, days: ["day-1"] },
  },
  {
    name: "days absent from incoming — preserved from existing",
    existingRaw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, days: ["day-2", "day-1"] },
    incomingRaw: { version: 1, plans: { version: 1, items: ["new"] }, lightning: { version: 1, items: [] } },
    incomingParsed: { version: 1, plans: { version: 1, items: ["new"] }, lightning: { version: 1, items: [] } },
    expected: { version: 1, plans: { version: 1, items: ["new"] }, lightning: { version: 1, items: [] }, days: ["day-2", "day-1"] },
  },
  {
    name: "days present in incoming — replaces existing (intentional overwrite)",
    existingRaw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, days: ["day-2", "day-1"] },
    incomingRaw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, days: ["day-1"] },
    incomingParsed: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, days: ["day-1"] },
    expected: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, days: ["day-1"] },
  },
  {
    name: "SH.3.2 — dayMeta absent from an old-client write survives untouched (now a KNOWN optional domain, same absent-preserves treatment as days)",
    existingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayMeta: { "day-1": { label: "Arrival" } },
    },
    incomingRaw: { version: 1, plans: { version: 1, items: ["x"] }, lightning: { version: 1, items: [] }, days: ["day-1"] },
    incomingParsed: { version: 1, plans: { version: 1, items: ["x"] }, lightning: { version: 1, items: [] }, days: ["day-1"] },
    expected: {
      version: 1,
      plans: { version: 1, items: ["x"] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayMeta: { "day-1": { label: "Arrival" } },
    },
  },
  {
    name: "SH.3.2 — dayMeta present in incoming replaces existing (intentional overwrite)",
    existingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayMeta: { "day-1": { label: "Old label" } },
    },
    incomingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayMeta: { "day-1": { label: "New label" } },
    },
    incomingParsed: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayMeta: { "day-1": { label: "New label" } },
    },
    expected: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayMeta: { "day-1": { label: "New label" } },
    },
  },
  {
    name: "SH.3.2 — dayMeta present-empty in incoming is an INTENTIONAL clear, not preserved (mirrors plans/lightning's own present-empty rule)",
    existingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayMeta: { "day-1": { label: "Old label" } },
    },
    incomingRaw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, days: ["day-1"], dayMeta: {} },
    incomingParsed: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayMeta: {},
    },
    expected: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, days: ["day-1"], dayMeta: {} },
  },
  {
    name: "SH.3.3 — dayParks absent from an old-client write survives untouched (now a KNOWN optional domain, same absent-preserves treatment as days/dayMeta)",
    existingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayParks: { "day-1": "mk" },
    },
    incomingRaw: { version: 1, plans: { version: 1, items: ["x"] }, lightning: { version: 1, items: [] }, days: ["day-1"] },
    incomingParsed: { version: 1, plans: { version: 1, items: ["x"] }, lightning: { version: 1, items: [] }, days: ["day-1"] },
    expected: {
      version: 1,
      plans: { version: 1, items: ["x"] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayParks: { "day-1": "mk" },
    },
  },
  {
    name: "SH.3.3 — dayParks present in incoming replaces existing (intentional overwrite)",
    existingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayParks: { "day-1": "mk" },
    },
    incomingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayParks: { "day-1": "epcot" },
    },
    incomingParsed: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayParks: { "day-1": "epcot" },
    },
    expected: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayParks: { "day-1": "epcot" },
    },
  },
  {
    name: "SH.3.3 — dayParks present-empty in incoming is an INTENTIONAL clear, not preserved (mirrors dayMeta's own present-empty rule)",
    existingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayParks: { "day-1": "mk" },
    },
    incomingRaw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, days: ["day-1"], dayParks: {} },
    incomingParsed: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayParks: {},
    },
    expected: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, days: ["day-1"], dayParks: {} },
  },
  {
    name: "still-unknown future domain (dayAutoFallbacks) in existing row survives an old-client write that omits it entirely",
    existingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayAutoFallbacks: { "day-1": "mk" },
    },
    incomingRaw: { version: 1, plans: { version: 1, items: ["x"] }, lightning: { version: 1, items: [] }, days: ["day-1"] },
    incomingParsed: { version: 1, plans: { version: 1, items: ["x"] }, lightning: { version: 1, items: [] }, days: ["day-1"] },
    expected: {
      version: 1,
      plans: { version: 1, items: ["x"] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayAutoFallbacks: { "day-1": "mk" },
    },
  },
  {
    name: "plans/lightning present-empty is an intentional clear, not preserved",
    existingRaw: { version: 1, plans: { version: 1, items: ["old"] }, lightning: { version: 1, items: ["old"] } },
    incomingRaw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
    incomingParsed: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
    expected: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
  },
  {
    name: "corrupted/malformed existing row treated as no base — no crash, no preserved data (nothing recoverable)",
    existingRaw: [1, 2, 3],
    incomingRaw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
    incomingParsed: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
    expected: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
  },
];

/**
 * Reference cases for findUnknownDomainKeys() — the Codex P2 fix. These
 * exercise the opposite direction from DEV_MERGE_CASES' "unknown future
 * domain" case: here the unrecognized domain arrives in THIS write (a
 * newer client talking to an older/current server build) rather than
 * already sitting in a previously-stored row. The route rejects (400)
 * whenever this returns a non-empty list, before mergePlannerDomains() is
 * ever called — so a payload that reaches mergePlannerDomains() in
 * production is always already known to contain zero unknown top-level
 * keys, which is why DEV_MERGE_CASES doesn't need its own "reject" cases.
 *
 * Run from Node:
 *   import { DEV_UNKNOWN_DOMAIN_CASES, findUnknownDomainKeys } from "@/lib/syncPayload";
 *   DEV_UNKNOWN_DOMAIN_CASES.forEach(c => {
 *     const got = findUnknownDomainKeys(c.incomingRaw);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expectedUnknown) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_UNKNOWN_DOMAIN_CASES: Array<{
  name: string;
  incomingRaw: Record<string, unknown>;
  expectedUnknown: string[];
}> = [
  {
    name: "known-only payload (version + plans + lightning + days + dayMeta + dayParks) — nothing unknown",
    incomingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayMeta: { "day-1": { label: "Arrival" } },
      dayParks: { "day-1": "mk" },
    },
    expectedUnknown: [],
  },
  {
    name: "known-only payload without optional days/dayMeta/dayParks — still nothing unknown",
    incomingRaw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
    expectedUnknown: [],
  },
  {
    name: "SH.3.3 — newer-client payload carrying a STILL-unrecognized extension domain (dayAutoFallbacks) — must be flagged, never silently dropped",
    incomingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayMeta: { "day-1": { label: "Arrival" } },
      dayParks: { "day-1": "mk" },
      dayAutoFallbacks: { "day-1": "mk" },
    },
    expectedUnknown: ["dayAutoFallbacks"],
  },
  {
    name: "multiple unrecognized domains in one write — all flagged",
    incomingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      dayAutoFallbacks: {},
      dayNotes: {},
    },
    expectedUnknown: ["dayAutoFallbacks", "dayNotes"],
  },
];

/**
 * Reference cases for parseSyncedPlannerPayload() — SH.2's cloud-confirmed
 * snapshot contract (see syncHelper.ts's getConfirmedSnapshot) now depends
 * on this function to validate the stored confirmedSnapshot value before
 * any page trusts it as a baseline, so its accept/reject/sanitize behavior
 * is pinned here explicitly. Run from Node:
 *   import { DEV_PARSE_SYNCED_PAYLOAD_CASES, parseSyncedPlannerPayload } from "@/lib/syncPayload";
 *   DEV_PARSE_SYNCED_PAYLOAD_CASES.forEach(c => {
 *     const got = parseSyncedPlannerPayload(c.raw);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_PARSE_SYNCED_PAYLOAD_CASES: Array<{
  name: string;
  raw: unknown;
  expected: SyncedPlannerPayload | null;
}> = [
  {
    name: "valid full payload with days — parses as-is",
    raw: { version: 1, plans: { version: 1, items: ["p"] }, lightning: { version: 1, items: ["l"] }, days: ["day-1", "day-2"] },
    expected: { version: 1, plans: { version: 1, items: ["p"] }, lightning: { version: 1, items: ["l"] }, days: ["day-1", "day-2"] },
  },
  {
    name: "valid payload without days — days omitted from result",
    raw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
    expected: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
  },
  {
    name: "wrong version — rejected",
    raw: { version: 2, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
    expected: null,
  },
  {
    name: "missing plans — rejected",
    raw: { version: 1, lightning: { version: 1, items: [] } },
    expected: null,
  },
  {
    name: "lightning.items not an array — rejected",
    raw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: "nope" } },
    expected: null,
  },
  {
    name: "non-object raw — rejected",
    raw: "not an object",
    expected: null,
  },
  {
    name: "array raw — rejected",
    raw: [1, 2, 3],
    expected: null,
  },
  {
    name: "malformed days entries — sanitized, not rejected (plans/lightning still valid)",
    raw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, days: ["not-a-day", "day-2"] },
    expected: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, days: ["day-1", "day-2"] },
  },
  {
    name: "SH.3.2 — valid payload with dayMeta — parses as-is, including label+date round-trip",
    raw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayMeta: { "day-1": { label: "Arrival Day", date: "2025-05-12" } },
    },
    expected: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayMeta: { "day-1": { label: "Arrival Day", date: "2025-05-12" } },
    },
  },
  {
    name: "SH.3.2 — valid payload without dayMeta — dayMeta omitted from result (legacy/non-participating, NOT a clear)",
    raw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
    expected: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
  },
  {
    name: "SH.3.2 — present-empty dayMeta ({}) is an INTENTIONAL clear, parses as a real empty record, never omitted",
    raw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, dayMeta: {} },
    expected: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, dayMeta: {} },
  },
  {
    name: "SH.3.2 — malformed dayMeta entries sanitized, not rejected (plans/lightning still valid); invalid day-id key and invalid date both dropped",
    raw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      dayMeta: { "day-1": { label: "Keep me", date: "not-a-date" }, "not-a-day": { label: "Drop me" } },
    },
    expected: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      dayMeta: { "day-1": { label: "Keep me" } },
    },
  },
  {
    name: "SH.3.2 — dayMeta structurally invalid (an array, not an object) — degrades to absent, never rejects the whole payload",
    raw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, dayMeta: ["day-1"] },
    expected: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
  },
  {
    name: "SH.3.3 — valid payload with dayParks — parses as-is",
    raw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayParks: { "day-1": "mk" },
    },
    expected: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayParks: { "day-1": "mk" },
    },
  },
  {
    name: "SH.3.3 — valid payload without dayParks — dayParks omitted from result (legacy/non-participating, NOT a clear)",
    raw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
    expected: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
  },
  {
    name: "SH.3.3 — present-empty dayParks ({}) is an INTENTIONAL clear, parses as a real empty record, never omitted",
    raw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, dayParks: {} },
    expected: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, dayParks: {} },
  },
  {
    name: "SH.3.3 — malformed dayParks entries sanitized, not rejected (plans/lightning still valid); invalid day-id key and unrecognized park value both dropped",
    raw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      dayParks: { "day-1": "mk", "day-2": "not-a-real-park", "not-a-day": "epcot" },
    },
    expected: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      dayParks: { "day-1": "mk" },
    },
  },
  {
    name: "SH.3.3 — dayParks structurally invalid (an array, not an object) — degrades to absent, never rejects the whole payload",
    raw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] }, dayParks: ["day-1"] },
    expected: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
  },
];

// ===== LOCAL-DOMAIN COMMIT DECISION (SH.2, 12th round) =====
//
// Codex found two P1s in local persistence after pull reconciliation: (1)
// hydration's read-current → choose-winner → later setItem() sequence left
// a window in which another tab's newer same-domain write could land in
// between and get silently clobbered by the pull's now-stale winner; (2)
// some persistence-retry checks compared the winning value against REACT
// STATE (e.g. itemsRef.current) instead of the actual durable localStorage
// value — if a prior direct write AND its persistence effect had both
// failed, React state could already equal the winner while disk stayed
// stale, so the check wrongly concluded "already persisted" and skipped
// the write, letting sync/ownership gates reopen over unpersisted data.
//
// This function is the PURE decision core both bugs are fixed through: it
// takes the durable value actually on disk right now (`currentRaw`), the
// durable value that was on disk when the winner was decided
// (`expectedPreviousRaw`), and the value a caller wants to commit
// (`nextRaw`) — never React state, never a timestamp, never arrival order —
// and returns which of three things must happen:
//   "noop"       — `currentRaw` already equals `nextRaw`; nothing to write,
//                  and this is a SUCCESS (the durable value already is the
//                  winner, however it got there).
//   "superseded" — `currentRaw` no longer equals `expectedPreviousRaw`: a
//                  write this caller didn't know about landed since the
//                  decision was made. That write is NEWER by construction
//                  (it happened after the observation the caller's own
//                  decision was based on) and must never be overwritten —
//                  the caller MUST NOT write `nextRaw` in this case.
//   "write"      — `currentRaw` still matches the caller's own baseline;
//                  safe to persist `nextRaw`.
// See commitLocalDomainRaw()/commitLocalDomainRawSync() in syncHelper.ts
// for the actual localStorage I/O built on this decision — commitLocalDomainRaw()
// (pull hydration's CAS policy) uses per-key Web Locks serialization when
// available and fails closed otherwise; commitLocalDomainRawSync() (ordinary
// user edits, 16th round) is a synchronous, lock-free `write`-or-`noop`
// application of this SAME decision (its own baseline is always the current
// value itself, so it can never observe "superseded").
export type LocalDomainCommitDecision = "write" | "noop" | "superseded";

export function decideLocalDomainCommit(
  currentRaw: string | null,
  expectedPreviousRaw: string | null,
  nextRaw: string
): LocalDomainCommitDecision {
  if (currentRaw === nextRaw) return "noop";
  if (currentRaw !== expectedPreviousRaw) return "superseded";
  return "write";
}

/**
 * Reference cases for decideLocalDomainCommit() — the REQUIRED cases from
 * the 12th round's architectural contract, reduced to this function's pure
 * inputs/outputs. Run from Node:
 *   import { DEV_DECIDE_LOCAL_DOMAIN_COMMIT_CASES, decideLocalDomainCommit } from "@/lib/syncPayload";
 *   DEV_DECIDE_LOCAL_DOMAIN_COMMIT_CASES.forEach(c => {
 *     const got = decideLocalDomainCommit(c.currentRaw, c.expectedPreviousRaw, c.nextRaw);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_DECIDE_LOCAL_DOMAIN_COMMIT_CASES: Array<{
  name: string;
  currentRaw: string | null;
  expectedPreviousRaw: string | null;
  nextRaw: string;
  expected: LocalDomainCommitDecision;
}> = [
  {
    name: "required — durable value unchanged since decision: safe to write",
    currentRaw: "A",
    expectedPreviousRaw: "A",
    nextRaw: "B",
    expected: "write",
  },
  {
    name: "required — a newer write already landed (current diverged from the decision baseline): superseded, must not overwrite",
    currentRaw: "C",
    expectedPreviousRaw: "A",
    nextRaw: "B",
    expected: "superseded",
  },
  {
    name: "required — durable value already equals the winner: successful no-op, regardless of what the stale baseline was",
    currentRaw: "B",
    expectedPreviousRaw: "A",
    nextRaw: "B",
    expected: "noop",
  },
  {
    name: "force-commit policy (expectedPrevious == currentRaw always): never superseded, writes whenever different",
    currentRaw: "A",
    expectedPreviousRaw: "A",
    nextRaw: "A",
    expected: "noop",
  },
  {
    name: "key never previously existed (null baseline) and still doesn't: safe to write",
    currentRaw: null,
    expectedPreviousRaw: null,
    nextRaw: "B",
    expected: "write",
  },
  {
    name: "key never previously existed per the decision baseline, but now does (a concurrent first-write raced in): superseded",
    currentRaw: "C",
    expectedPreviousRaw: null,
    nextRaw: "B",
    expected: "superseded",
  },
];

// ===== PULL EXECUTION CONTEXT (SH.2, 13th round) =====
//
// Codex found two P1s that are both instances of one failure class: a
// durable write or gate transition executing under an execution context
// that is no longer the one the operation started under — (1) an
// authenticated identity switch (A -> B) that NextAuth can report without
// `sessionStatus` ever leaving "authenticated", so nothing told the page's
// effect to re-run and retarget; (2) an awaited local-domain commit that
// resumes after cancellation/identity change and keeps performing further
// writes/ownership transfer/confirmation/syncReady updates regardless.
//
// The fix is one immutable per-pull context — { epoch, userId, profileId }
// (see PullContext/beginPullContext()/isPullContextCurrent() in
// syncHelper.ts) — captured exactly once at pull start and re-validated
// after every awaited boundary before any further durable step. This
// function is the PURE comparison both the outer per-await check and the
// commit primitive's own last-instant-before-write check reduce to: is the
// epoch a pull captured still the current one?
export function isPullEpochCurrent(capturedEpoch: number, currentEpoch: number): boolean {
  return capturedEpoch === currentEpoch;
}

/**
 * Reference cases for isPullEpochCurrent() — the REQUIRED cases from the
 * 13th round's architectural contract, reduced to this function's pure
 * inputs/outputs (a real identity/profile switch is exactly "the epoch
 * counter has advanced since this pull captured it"). Run from Node:
 *   import { DEV_IS_PULL_EPOCH_CURRENT_CASES, isPullEpochCurrent } from "@/lib/syncPayload";
 *   DEV_IS_PULL_EPOCH_CURRENT_CASES.forEach(c => {
 *     const got = isPullEpochCurrent(c.capturedEpoch, c.currentEpoch);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_IS_PULL_EPOCH_CURRENT_CASES: Array<{
  name: string;
  capturedEpoch: number;
  currentEpoch: number;
  expected: boolean;
}> = [
  {
    name: "required — no transition happened since capture: still current",
    capturedEpoch: 3,
    currentEpoch: 3,
    expected: true,
  },
  {
    name: "required — one identity switch (A -> B) happened since capture: stale",
    capturedEpoch: 3,
    currentEpoch: 4,
    expected: false,
  },
  {
    name: "required — a profile switch AND an identity switch both happened since capture: stale",
    capturedEpoch: 3,
    currentEpoch: 5,
    expected: false,
  },
  {
    name: "the very first pull of a session: epoch 0 captured, nothing has changed",
    capturedEpoch: 0,
    currentEpoch: 0,
    expected: true,
  },
];

// ===== CONFIRMED-FACT CANONICALIZATION (SH.2, 14th round; storage model
// replaced 15th round; status model replaced 16th round) =====
//
// The 14th round gave every fact's value ONE deterministic canonical
// serialization (canonicalizeJSON() below) so two code paths constructing
// logically-identical content never manufacture a false conflict merely
// from incidental object-key-order differences — that part still holds and
// is unchanged. What the 14th round got WRONG was HOW it used
// canonicalization: recordConfirmedFact() read whatever existed at the
// (user, profile, domain, revision) key, canonically compared it against
// the new value, and only THEN decided whether to write
// (decideConfirmedFactWrite() — REMOVED this round). That read-then-decide-
// then-write sequence is exactly the un-atomic check-then-act pattern round
// 13 already established localStorage cannot safely provide without a
// lock: two tabs can both read the key as absent, both independently decide
// "write", and the later setItem() silently replaces the earlier fact —
// Codex's 15th-round finding. See resolveConfirmedDomainState() (16th round;
// the 15th round's own reduceConfirmedFactRecords() has since been replaced —
// see that function's own doc) and confirmedFactRevisionIsUnambiguous()
// below, and confirmedFactKey()'s own
// doc in syncHelper.ts, for the replacement: every recorded fact now gets
// its own permanently-unique physical key (an append-only representation),
// so the write side is a single unconditional setItem with no read-before-
// write at all — genuinely un-raceable — and canonical-value reconciliation
// happens entirely at READ time instead, over however many facts a
// revision ends up with.

/**
 * Deterministic, canonical JSON serialization: object keys are recursively
 * sorted so any two JS values with the same LOGICAL content — regardless of
 * which code path constructed them, or in what order their keys happened to
 * be assigned — always serialize identically. Array element ORDER is
 * preserved exactly: order is semantically significant for every value this
 * module canonicalizes (a days[] sequence, an items[] display order), so it
 * is never reordered, only recursed into.
 */
export function canonicalizeJSON(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Reference cases for canonicalizeJSON(). Run from Node:
 *   import { DEV_CANONICALIZE_JSON_CASES, canonicalizeJSON } from "@/lib/syncPayload";
 *   DEV_CANONICALIZE_JSON_CASES.forEach(c => {
 *     const got = canonicalizeJSON(c.value);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_CANONICALIZE_JSON_CASES: Array<{
  name: string;
  value: unknown;
  expected: string;
}> = [
  {
    name: "flat object — keys sorted regardless of construction order",
    value: { b: 2, a: 1 },
    expected: '{"a":1,"b":2}',
  },
  {
    name: "two objects with same content, different key order, canonicalize identically",
    value: { version: 1, items: [] },
    expected: '{"items":[],"version":1}',
  },
  {
    name: "nested objects inside an array — array order preserved, each element's keys sorted",
    value: { version: 1, items: [{ name: "b", id: "1" }, { id: "2", name: "a" }] },
    expected: '{"items":[{"id":"1","name":"b"},{"id":"2","name":"a"}],"version":1}',
  },
  {
    name: "days[] array order is NEVER reordered — it is semantically the display sequence",
    value: ["day-2", "day-1", "day-3"],
    expected: '["day-2","day-1","day-3"]',
  },
  {
    name: "primitives pass through unchanged",
    value: null,
    expected: "null",
  },
];

// ===== PULL BASELINE AUTHORITY (SH.2.1) =====

/**
 * SH.2.1 — a full SH.2 architecture audit traced the latest P1 (SH.2, 18th
 * round's own conflict-recovery mechanism) to an abstraction failure, not a
 * one-off conditional bug: plans/page.tsx's and lightning/page.tsx's
 * (identical) `captureConfirmedSnapshotForPull()` tried to serve TWO
 * structurally different causal moments — before a pull's own fetch has
 * even been issued (no authoritative server revision exists yet) and after
 * it resolves (this pull's own `revision` is now known) — through ONE
 * function whose behavior depended on an OPTIONAL `preFetchSnapshot`
 * parameter and a `cloudRevision` argument that defaulted to `null`.
 *
 * Because isConflictRepairableByRevision() can only ever return true for a
 * non-null, strictly-newer candidate revision, and the pre-fetch call site
 * always passed `cloudRevision: null` (there being no response yet), the
 * branch meant to freshly capture this domain's on-disk bytes for later
 * recovery (`items = preFetchSnapshot ? preFetchSnapshot.items :
 * loadFromStorage(...)`) was gated behind a "this conflict is already
 * repairable" condition that could NEVER be true on the one call that was
 * actually supposed to execute it. The fresh capture never ran; a later
 * repair silently reused whatever the stale itemsBaselineRef/daysBaselineRef/
 * lightningRawBaselineRef fallback ref happened to hold instead of a
 * genuine frozen pre-fetch snapshot — undermining the exact guarantee the
 * 18th round believed it had added ("pre-existing uncertain local bytes
 * must not overwrite newer cloud state; genuine local edits after the
 * frozen snapshot remain protected"). The previous DEV_* harness never
 * caught this because it exercised the INTENDED behavior directly, never
 * the two real call sites in their real sequence.
 *
 * The fix splits the old dual-purpose function into two causal stages so
 * neither stage's behavior can ever again be inferred from an optional
 * parameter or a condition that happens to be unreachable:
 *
 *   • capturePreFetchDomainSnapshot() — STAGE 1. A trivial, pure passthrough
 *     that freezes this domain's real on-disk value BEFORE any network/async
 *     work begins — see its own doc for why it makes NO baseline decision at
 *     all (a deliberate simplification over this abstraction's first
 *     revision — see the SH.2.1 P2 doc immediately below for why).
 *
 *   • resolvePostFetchDomainBaseline() — STAGE 2. The ONE place a baseline/
 *     conflict/recovery/staleness decision is ever made, once this pull's
 *     authoritative server response is known. Takes the frozen stage-1
 *     snapshot as a REQUIRED parameter (never optional) for its "recovered"
 *     case, and a freshly-read ConfirmedDomainResult — see its own doc for
 *     the full authority rule.
 *
 * Both funnel through the SAME `DomainBaselineOutcome<T>` discriminated
 * union, so an unusable domain's absent `value` field is enforced by the
 * type system: a caller cannot accidentally read `.value` off a "gated" or
 * "stale-response" outcome and consume it as a real baseline — TypeScript
 * refuses to narrow it without an explicit `kind` check first. See this
 * section's own DEV_* cases below, and plans/page.tsx's/lightning/
 * page.tsx's pull effect, for the per-domain narrowing every consumer must
 * perform before any outcome's `.value` is used.
 *
 * SH.2.1 P2 (Codex) — REVISION-BOUNDED AUTHORITY. A second-round audit found
 * that resolvePostFetchDomainBaseline()'s original "confirmed" branch
 * returned a confirmed fact's value UNCONDITIONALLY, never checking it
 * against `cloudRevision` at all. Concretely: this pull's own fetch resolves
 * at server revision 7; while that fetch was in flight (or even before this
 * pull started at all), a DIFFERENT push/pull already durably confirmed
 * revision 8 (and, being local-first, already wrote revision 8's bytes to
 * local disk). The old "confirmed" branch would use revision 8's value as
 * this pull's baseline; a fresh disk read (taken later, downstream in the
 * page) would find disk STILL equal to that revision-8 value (nothing
 * genuinely new happened locally) — "unchanged" — so THIS pull's own stale
 * revision-7 cloud payload would be selected as the winner and PERSISTED,
 * silently regressing local (and eventually server) state from 8 back to 7.
 * This is the exact class of bug the SH.2 2nd round's "freeze baseline
 * before the fetch" fix was meant to close, resurfacing because the
 * post-fetch resolver never bounded a CONFIRMED fact's revision against the
 * pull's OWN response revision — only the CONFLICT branch (via
 * isConflictRepairableByRevision) had ever been revision-bounded.
 *
 * STANDING RULE — a pull must never use authority from the future to
 * justify hydrating an older server response. A pull's authority window is
 * bounded by the server revision its OWN response carries:
 *   • confirmed revision < cloud revision → normal progression: the
 *     confirmed fact predates this response and remains valid (this
 *     response may still advance it further, via ordinary winner
 *     selection).
 *   • confirmed revision == cloud revision → valid same-revision authority:
 *     this response IS (or matches) that confirmation.
 *   • confirmed revision > cloud revision, OR `cloudRevision` is `null`
 *     (this response carries no revision at all — a 204/unparseable GET,
 *     which establishes no bound whatsoever) → this pull is STALE relative
 *     to already-confirmed server state. It must NOT use that newer (or
 *     unbounded) fact as a baseline and then hydrate its own older
 *     response over it.
 *
 * The fail-safe chosen for the stale case is a NEW, explicit
 * `"stale-response"` outcome — never silently downgraded to "fallback" (a
 * stale-response domain has a well-known, just-unusable-by-THIS-pull
 * confirmed value; "fallback" means no confirmed fact exists AT ALL, a
 * different situation) and never folded into "gated" (a stale-response
 * domain is not ambiguous/conflicted — its confirmed truth is perfectly
 * well-defined, just newer than what this pull can safely act on). Both
 * "gated" and "stale-response" are, identically, unusable-this-pull
 * outcomes from the caller's point of view: plans/page.tsx's and
 * lightning/page.tsx's collectGatedDomains() treats them the same way
 * (whole-pull bail-out — see its own doc for why "whole pull" rather than
 * per-domain), while still detecting and reporting each PER DOMAIN,
 * independently, using only that domain's own confirmed revision — one
 * domain being stale relative to this pull's response never misclassifies
 * an unrelated, genuinely-current domain as stale too (see this section's
 * own DEV_* per-domain-independence case, and required case 5).
 *
 * SH.2.1 (Codex, stale-response retry round) — UNUSABLE-RESPONSE SPLIT.
 * A later round added automatic recovery for "stale-response": rejecting a
 * pull that is genuinely older than confirmed authority is correct, but
 * leaving syncReady closed forever with nothing scheduled to reopen it was
 * not — see decideStaleResponseRecovery()'s own doc further down. That
 * retry mechanism's contract requires a RETRYABLE stale response to
 * represent a REAL, usable server snapshot whose KNOWN revision is simply
 * older than already-confirmed authority: retrying is safe there because a
 * fresh GET will see the newer state. The original "stale-response" kind
 * above bundled TWO structurally different situations under one label —
 * `cloudRevision === null` (this pull's OWN response carries no usable
 * revision at all: a 204, an unparseable/malformed payload, or any other
 * shape pullPlanner() could not turn into a real revision) treated
 * identically to `confirmed.fact.revision > cloudRevision` (a REAL, known,
 * strictly-older revision). Retrying the FIRST case cannot help — the next
 * GET is exactly as likely to be empty/malformed again, since nothing about
 * why this response was unusable is revision-related at all — so folding it
 * into "stale-response" let the retry mechanism repeat that same unusable
 * GET indefinitely while sync stayed gated the whole time.
 *
 * `"unusable-response"` is the new, separate outcome for exactly the
 * `cloudRevision === null` case (with a confirmed fact present — the ONLY
 * situation this branch is reached at all; see the "none"/`"fallback"`
 * branch below for when no confirmed fact exists yet, which never needed
 * bounding in the first place). `"stale-response"` now ONLY ever carries a
 * non-null `cloudRevision` — a real, known, older revision — enforced by
 * the type itself (`cloudRevision: number`, no longer `number | null`) so
 * a caller can never "invent" a revision for a response that didn't carry
 * one. Both kinds remain identically unusable-this-pull for hydration
 * purposes (same whole-pull bail-out, same "never read .value" contract);
 * they diverge ONLY in whether the automatic retry mechanism may act on
 * them — see decideStaleResponseRecovery()'s own updated doc.
 *
 * Because this bound now lives entirely inside resolvePostFetchDomainBaseline
 * and is checked on EVERY call, it is now safe — indeed necessary, to catch
 * a race landing between pre-fetch and post-fetch (required case 4) — for
 * callers to invoke stage 2 UNCONDITIONALLY on every pull, with a freshly
 * read ConfirmedDomainResult, rather than only when some other signal
 * (a just-accepted beacon, or a pre-fetch-time conflict) suggested it might
 * be needed. That conditional "should we even re-check" heuristic (the
 * SH.2.1 P1 fix's own `shouldRederiveBaseline`) is exactly what let this P2
 * go undetected in one of its two forms (required case 4): it could skip
 * stage 2 entirely, in which case NO revision bound was ever checked at
 * all for that pull. Stage 1 no longer produces a baseline "decision" for
 * this same reason — its only remaining job, and the only thing that must
 * happen strictly BEFORE the fetch, is freezing the disk read a "recovered"
 * outcome might need later.
 */
export type DomainBaselineOutcome<T> =
  | { kind: "confirmed"; value: T }
  | { kind: "recovered"; value: T; revision: number }
  | { kind: "gated"; revision: number }
  | { kind: "stale-response"; confirmedRevision: number; cloudRevision: number }
  | { kind: "unusable-response"; confirmedRevision: number }
  | { kind: "unusable-content"; cloudRevision: number | null }
  | { kind: "fallback"; value: T };

/**
 * STAGE 1 output for one domain — this pull's frozen pre-fetch snapshot.
 * `diskValue` is the real on-disk value at the moment this was captured
 * (always a genuine read the caller took just before calling this
 * function, never a ref, never a placeholder). Consumed ONLY by
 * resolvePostFetchDomainBaseline()'s "recovered" case — stage 1 makes no
 * baseline decision of its own (see this section's own module doc).
 */
export interface DomainPreFetchSnapshot<T> {
  diskValue: T;
}

/**
 * STAGE 1 (pre-fetch) — see this section's own module doc above. Called
 * once per domain, synchronously, before a pull's fetch is even issued.
 * `diskValue` must be a fresh read taken by the caller right before this
 * call — this function never reads storage itself, keeping it pure and
 * trivially testable. A plain passthrough by design: whether this snapshot
 * ends up being NEEDED (a later repair) cannot be known until stage 2 runs,
 * so it is captured unconditionally rather than gated on any status this
 * function would otherwise have to read confirmed state to determine.
 */
export function capturePreFetchDomainSnapshot<T>(diskValue: T): DomainPreFetchSnapshot<T> {
  return { diskValue };
}

/**
 * STAGE 2 (post-fetch) — see this section's own module doc above for the
 * full authority rule. The ONE place a baseline/conflict/recovery/staleness
 * decision is made for this domain. Called once this pull's authoritative
 * server response is known: `cloudRevision` is that response's own
 * `revision`, or `null` for a 204/unparseable response (which, per the
 * revision-bounded authority rule, establishes no bound at all). `preFetch`
 * MUST be this SAME pull's own stage-1 result for this SAME domain — never
 * re-derived, never borrowed from a different pull or a different domain.
 * `confirmed` MUST be read fresh (or at least no older than) at this call —
 * see plans/page.tsx's/lightning/page.tsx's own doc for why callers now
 * invoke this unconditionally, every pull, rather than only when some other
 * signal suggested it might be needed.
 *
 * SH.2.6 P1 (Codex) — CONTENT-USABILITY GATE. `contentUsable` (optional,
 * defaults to `true` so every pre-existing caller/DEV case is unaffected)
 * is a SEPARATE question from `cloudRevision`'s presence: pullPlanner() can
 * now return a non-null envelope for an HTTP 200 whose `plannerJson` was
 * unusable (malformed/unexpected shape — e.g. the server's `null`/`{}`
 * no-further-validation legacy-fallback path) while STILL carrying a
 * perfectly valid `revision` — see PulledPlannerEnvelope's own doc in
 * syncHelper.ts. Before this gate, `confirmed.status === "none"` (a fresh
 * browser/no-confirmed-facts device — the REQUIRED case) fell straight
 * through to `"fallback"` below WITHOUT ever inspecting content usability
 * at all, because that branch never looked at `cloudRevision` in the first
 * place: a fresh device could hydrate "successfully" from local
 * fallback/noop content against a response whose actual cloud bytes it
 * never interpreted, open syncReady, and push that local/empty state
 * tagged with the response's own (real, valid) revision — silently
 * overwriting cloud data this client could not read. `contentUsable ===
 * false` is checked FIRST, before `confirmed.status` is even inspected,
 * and unconditionally overrides EVERY other branch ("confirmed",
 * "conflict", "none") with `"unusable-content"`: an unusable response must
 * never establish a baseline for hydration, regardless of what else is
 * true about this domain's confirmed state. This is DELIBERATELY separate
 * from `"unusable-response"` (which means "no revision at all" — a 204 or
 * an unparseable-to-pullPlanner() response) since the two are different
 * failure classes with a different implication for a device with NO
 * confirmed fact yet: a null `cloudRevision` with no confirmed fact is
 * genuinely "nothing here yet, safe to fall back" (unchanged, still
 * "fallback" below), while `contentUsable === false` means "the server DID
 * answer with real revision-bearing state this device simply could not
 * interpret" — never safe to treat as an empty/fallback-eligible pull, with
 * or without a confirmed fact already on record. `cloudRevision` is
 * preserved on the returned outcome (not merely a confirmedRevision, which
 * may not exist for a "none" confirmed status) so callers/logging still
 * have it, but establishes no baseline VALUE of any kind — this outcome
 * carries no `.value` field, exactly like "gated"/"stale-response"/
 * "unusable-response".
 */
export function resolvePostFetchDomainBaseline<Raw, T>(
  confirmed: ConfirmedDomainResult<Raw>,
  cloudRevision: number | null,
  mapConfirmedValue: (raw: Raw) => T,
  preFetch: DomainPreFetchSnapshot<T>,
  fallbackValue: T,
  contentUsable = true
): DomainBaselineOutcome<T> {
  if (!contentUsable) {
    return { kind: "unusable-content", cloudRevision };
  }
  if (confirmed.status === "confirmed") {
    // REVISION-BOUNDED AUTHORITY (SH.2.1 P2) — a confirmed fact is usable
    // as THIS pull's baseline only within this pull's own authority window:
    // its revision must be no newer than `cloudRevision`, and `cloudRevision`
    // must actually exist (a null response establishes no bound at all, so
    // nothing can be proven "within" it). Equal revisions are explicitly
    // fine (required case 2: this response IS/matches that confirmation).
    //
    // UNUSABLE-RESPONSE SPLIT (this round) — `cloudRevision === null` is
    // checked FIRST and separately: this pull's own response carries no
    // usable revision at all (204, unparseable/malformed payload), so
    // there is nothing to compare `confirmed.fact.revision` against —
    // "stale" would claim knowledge (a real, older revision) this pull
    // does not have. See UNUSABLE-RESPONSE SPLIT in this section's own
    // module doc above for the full rationale (this is what stops the
    // automatic stale-response retry mechanism from repeating the SAME
    // unusable GET indefinitely).
    if (cloudRevision === null) {
      return { kind: "unusable-response", confirmedRevision: confirmed.fact.revision };
    }
    if (confirmed.fact.revision > cloudRevision) {
      return { kind: "stale-response", confirmedRevision: confirmed.fact.revision, cloudRevision };
    }
    return { kind: "confirmed", value: mapConfirmedValue(confirmed.fact.value) };
  }
  if (confirmed.status === "conflict") {
    if (isConflictRepairableByRevision(confirmed.revision, cloudRevision)) {
      // Guaranteed non-null: isConflictRepairableByRevision only ever
      // returns true for a non-null, strictly-newer candidate revision.
      return { kind: "recovered", value: preFetch.diskValue, revision: cloudRevision as number };
    }
    return { kind: "gated", revision: confirmed.revision };
  }
  return { kind: "fallback", value: fallbackValue };
}

/**
 * Reference cases for capturePreFetchDomainSnapshot() — run from Node:
 *   import { DEV_CAPTURE_PRE_FETCH_DOMAIN_SNAPSHOT_CASES, capturePreFetchDomainSnapshot } from "@/lib/syncPayload";
 *   DEV_CAPTURE_PRE_FETCH_DOMAIN_SNAPSHOT_CASES.forEach(c => {
 *     const got = capturePreFetchDomainSnapshot(c.diskValue);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_CAPTURE_PRE_FETCH_DOMAIN_SNAPSHOT_CASES: Array<{
  name: string;
  diskValue: string | null;
  expected: DomainPreFetchSnapshot<string | null>;
}> = [
  {
    name: "captures whatever disk value the caller took, unconditionally",
    diskValue: "DISK-BYTES",
    expected: { diskValue: "DISK-BYTES" },
  },
  {
    name: "a null disk read (e.g. Lightning's raw key absent at mount) passes through unchanged",
    diskValue: null,
    expected: { diskValue: null },
  },
];

/**
 * Reference cases for resolvePostFetchDomainBaseline() — the REQUIRED cases
 * from the SH.2.1 P1 fix (conflict/recovery), the P2 fix (revision-bounded
 * confirmed authority), and the SH.2.6 P1 fix (content-usability gate). Run
 * from Node:
 *   import { DEV_RESOLVE_POST_FETCH_DOMAIN_BASELINE_CASES, resolvePostFetchDomainBaseline } from "@/lib/syncPayload";
 *   DEV_RESOLVE_POST_FETCH_DOMAIN_BASELINE_CASES.forEach(c => {
 *     const got = resolvePostFetchDomainBaseline(c.confirmed, c.cloudRevision, (raw) => raw, c.preFetch, c.fallbackValue, c.contentUsable ?? true);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_RESOLVE_POST_FETCH_DOMAIN_BASELINE_CASES: Array<{
  name: string;
  confirmed: ConfirmedDomainResult<string>;
  cloudRevision: number | null;
  preFetch: DomainPreFetchSnapshot<string>;
  fallbackValue: string;
  contentUsable?: boolean;
  expected: DomainBaselineOutcome<string>;
}> = [
  {
    name: "required case 1 — confirmed rev6 + GET rev7: normal progression, confirmed value used",
    confirmed: { status: "confirmed", fact: { revision: 6, value: "CLOUD-V6" } },
    cloudRevision: 7,
    preFetch: { diskValue: "DISK-BYTES" },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "confirmed", value: "CLOUD-V6" },
  },
  {
    name: "required case 2 — confirmed rev7 + GET rev7: valid same-revision authority, confirmed value used",
    confirmed: { status: "confirmed", fact: { revision: 7, value: "CLOUD-V7" } },
    cloudRevision: 7,
    preFetch: { diskValue: "DISK-BYTES" },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "confirmed", value: "CLOUD-V7" },
  },
  {
    name: "required case 3 — confirmed rev8 + GET rev7: rev7 cannot hydrate over rev8, fails safe as stale-response",
    confirmed: { status: "confirmed", fact: { revision: 8, value: "CLOUD-V8" } },
    cloudRevision: 7,
    preFetch: { diskValue: "DISK-BYTES" },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "stale-response", confirmedRevision: 8, cloudRevision: 7 },
  },
  {
    name: "revision 0 boundary — confirmed rev0 + GET rev0 is valid same-revision authority, not misread as \"no revision\"",
    confirmed: { status: "confirmed", fact: { revision: 0, value: "CLOUD-V0" } },
    cloudRevision: 0,
    preFetch: { diskValue: "DISK-BYTES" },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "confirmed", value: "CLOUD-V0" },
  },
  {
    name: "unusable-response round, required cases 3 & 4 — a null cloudRevision establishes no authority bound at all: fails safe as unusable-response, NOT stale-response (this pull's own response carries no known revision to claim as 'older'; a confirmed fact being present is exactly what makes this branch reachable at all)",
    confirmed: { status: "confirmed", fact: { revision: 1, value: "CLOUD-V1" } },
    cloudRevision: null,
    preFetch: { diskValue: "DISK-BYTES" },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "unusable-response", confirmedRevision: 1 },
  },
  {
    name: "no confirmed baseline — falls back to the caller's own fallback value, no revision bound applies (nothing confirmed to bound)",
    confirmed: { status: "none" },
    cloudRevision: 7,
    preFetch: { diskValue: "DISK-BYTES" },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "fallback", value: "FALLBACK-REF" },
  },
  {
    name: "unusable-response round — a structurally unusable ({} / 204) response with NO confirmed baseline at all is unaffected by the unusable-response split: nothing was ever confirmed to bound, so this stays plain fallback, exactly as before",
    confirmed: { status: "none" },
    cloudRevision: null,
    preFetch: { diskValue: "DISK-BYTES" },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "fallback", value: "FALLBACK-REF" },
  },
  {
    name: "required case 6 — conflict rev6 + GET rev7: existing recovery unaffected by the revision-bound fix",
    confirmed: { status: "conflict", revision: 6 },
    cloudRevision: 7,
    preFetch: { diskValue: "FROZEN-PRE-FETCH-BYTES" },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "recovered", value: "FROZEN-PRE-FETCH-BYTES", revision: 7 },
  },
  {
    name: "conflict + equal revision — never recovers from an equal response, stays gated",
    confirmed: { status: "conflict", revision: 6 },
    cloudRevision: 6,
    preFetch: { diskValue: "FROZEN-PRE-FETCH-BYTES" },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "gated", revision: 6 },
  },
  {
    name: "conflict + older revision — never falls back to an older confirmed revision, stays gated",
    confirmed: { status: "conflict", revision: 6 },
    cloudRevision: 5,
    preFetch: { diskValue: "FROZEN-PRE-FETCH-BYTES" },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "gated", revision: 6 },
  },
  {
    name: "conflict + no usable candidate revision (204/unparseable) — stays gated, not stale-response (conflict has its own, already-bounded, rule)",
    confirmed: { status: "conflict", revision: 6 },
    cloudRevision: null,
    preFetch: { diskValue: "FROZEN-PRE-FETCH-BYTES" },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "gated", revision: 6 },
  },
  {
    name: "SH.2.6 P1 required — fresh browser/no confirmed facts at all + unusable content (valid revision): must NOT fall through to fallback and open the gate, even though confirmed.status is \"none\"",
    confirmed: { status: "none" },
    cloudRevision: 5,
    preFetch: { diskValue: "DISK-BYTES" },
    fallbackValue: "FALLBACK-REF",
    contentUsable: false,
    expected: { kind: "unusable-content", cloudRevision: 5 },
  },
  {
    name: "SH.2.6 P1 required — unusable content AND a missing/malformed revision together: still unusable-content, cloudRevision preserved as null rather than fabricated",
    confirmed: { status: "none" },
    cloudRevision: null,
    preFetch: { diskValue: "DISK-BYTES" },
    fallbackValue: "FALLBACK-REF",
    contentUsable: false,
    expected: { kind: "unusable-content", cloudRevision: null },
  },
  {
    name: "SH.2.6 P1 — unusable content overrides an EXISTING confirmed fact too: a device with prior confirmed state must not use it to \"successfully\" hydrate from this pull's unreadable content",
    confirmed: { status: "confirmed", fact: { revision: 4, value: "CLOUD-V4" } },
    cloudRevision: 5,
    preFetch: { diskValue: "DISK-BYTES" },
    fallbackValue: "FALLBACK-REF",
    contentUsable: false,
    expected: { kind: "unusable-content", cloudRevision: 5 },
  },
  {
    name: "SH.2.6 P1 — unusable content overrides a conflicted domain too: never silently resolves a genuine conflict via unreadable content",
    confirmed: { status: "conflict", revision: 6 },
    cloudRevision: 7,
    preFetch: { diskValue: "FROZEN-PRE-FETCH-BYTES" },
    fallbackValue: "FALLBACK-REF",
    contentUsable: false,
    expected: { kind: "unusable-content", cloudRevision: 7 },
  },
  {
    name: "SH.2.6 P1 — contentUsable defaults to true when omitted: every pre-existing caller/case is unaffected by this gate",
    confirmed: { status: "none" },
    cloudRevision: 7,
    preFetch: { diskValue: "DISK-BYTES" },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "fallback", value: "FALLBACK-REF" },
  },
];

/**
 * Required case 5 — per-domain independence: one domain's confirmed
 * revision being newer than this pull's own cloudRevision must NOT cause an
 * UNRELATED domain (a genuinely different confirmed revision, independently
 * bounded) to be misclassified. Modeled here as two independent calls
 * sharing the SAME cloudRevision, exactly as plans/page.tsx's and
 * lightning/page.tsx's pull effect calls resolvePostFetchDomainBaseline
 * once per domain. Run from Node:
 *   import { DEV_PER_DOMAIN_REVISION_BOUND_INDEPENDENCE_CASE, resolvePostFetchDomainBaseline } from "@/lib/syncPayload";
 *   const c = DEV_PER_DOMAIN_REVISION_BOUND_INDEPENDENCE_CASE;
 *   const stale = resolvePostFetchDomainBaseline(c.staleDomainConfirmed, c.cloudRevision, (r) => r, c.preFetch, c.fallbackValue);
 *   const healthy = resolvePostFetchDomainBaseline(c.healthyDomainConfirmed, c.cloudRevision, (r) => r, c.preFetch, c.fallbackValue);
 *   console.log(stale.kind === "stale-response" && healthy.kind === "confirmed" ? "✓" : "✗ FAIL", c.name);
 */
export const DEV_PER_DOMAIN_REVISION_BOUND_INDEPENDENCE_CASE: {
  name: string;
  cloudRevision: number;
  staleDomainConfirmed: ConfirmedDomainResult<string>;
  healthyDomainConfirmed: ConfirmedDomainResult<string>;
  preFetch: DomainPreFetchSnapshot<string>;
  fallbackValue: string;
} = {
  name: "rev8 on one domain (Plans) while another domain (Days) is only rev6, GET rev7 — Plans fails safe, Days proceeds normally",
  cloudRevision: 7,
  staleDomainConfirmed: { status: "confirmed", fact: { revision: 8, value: "PLANS-V8" } },
  healthyDomainConfirmed: { status: "confirmed", fact: { revision: 6, value: "DAYS-V6" } },
  preFetch: { diskValue: "DISK-BYTES" },
  fallbackValue: "FALLBACK-REF",
};

/**
 * SH.2.2 — PARTIAL-APPLY PROVENANCE (Codex P1 follow-up round). Root cause:
 * a multi-domain pull used to batch its commitConfirmedBaseline() call until
 * every domain had attempted its own commit. If domain A's hydration commit
 * succeeded but a LATER domain's authority check then aborted the rest of
 * that pull, A's already-durable write never got a matching confirmed fact.
 * On the REPLACEMENT pull, resolvePostFetchDomainBaseline() (above) then
 * resolves A's baseline from whatever OLDER confirmed fact already existed
 * (if any) — NOT from A's own just-applied hydration — because a genuine
 * "confirmed" status always takes precedence over the caller's in-memory
 * fallback ref (see this function's own doc: fallback is used ONLY when
 * `confirmed.status === "none"`). That older baseline value can diverge
 * from what's genuinely on disk (A's abandoned-pull hydration bytes),
 * misreading durably-applied cloud content as an unsynced local edit —
 * eligible to be pushed back over cloud state newer than A itself ever saw.
 *
 * The fix (plans/page.tsx, lightning/page.tsx) calls commitConfirmedBaseline()
 * PER DOMAIN, immediately once that domain's own eligibility is known,
 * instead of batching until the whole pull finishes — see each page's own
 * "PARTIAL-APPLY PROVENANCE" doc near its `supersededDomains` declaration.
 * These cases prove the effect on resolvePostFetchDomainBaseline() itself —
 * the REAL production primitive every replacement pull's baseline goes
 * through — using the SAME `abandonedPullDiskValue` disk read both "before"
 * and "after" cases compare against: without the fix, the resolved baseline
 * diverges from disk (the bug); with the fix (the confirmed fact now
 * recorded at the abandoned pull's own revision/value), it matches (the
 * pull is symmetric across Plans/Lightning/Days — this primitive is
 * domain-agnostic, so one generic case proves all three). Run from Node:
 *   import { DEV_PARTIAL_PULL_PROVENANCE_CASES, resolvePostFetchDomainBaseline } from "@/lib/syncPayload";
 *   DEV_PARTIAL_PULL_PROVENANCE_CASES.forEach(c => {
 *     const got = resolvePostFetchDomainBaseline(c.confirmed, c.cloudRevision, (raw) => raw, c.preFetch, c.fallbackValue);
 *     const matchesDisk = got.kind === "confirmed" && got.value === c.abandonedPullDiskValue;
 *     const ok = JSON.stringify(got) === JSON.stringify(c.expected) && matchesDisk === c.expectMatchesDisk;
 *     console.log(ok ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_PARTIAL_PULL_PROVENANCE_CASES: Array<{
  name: string;
  abandonedPullDiskValue: string;
  confirmed: ConfirmedDomainResult<string>;
  cloudRevision: number;
  preFetch: DomainPreFetchSnapshot<string>;
  fallbackValue: string;
  expected: DomainBaselineOutcome<string>;
  expectMatchesDisk: boolean;
}> = [
  {
    name: "WITHOUT the fix (bug) — batched commit never ran for the aborted domain, so confirmed authority is still the OLDER pre-pull fact (rev5); the replacement pull's own baseline (rev5's value) diverges from what the abandoned pull already durably wrote to disk (rev7's value) — exactly the misclassification the fix closes",
    abandonedPullDiskValue: "CLOUD-V7",
    confirmed: { status: "confirmed", fact: { revision: 5, value: "CLOUD-V5" } },
    cloudRevision: 9,
    preFetch: { diskValue: "PRE-FETCH-UNUSED" },
    fallbackValue: "FALLBACK-REF-UNUSED",
    expected: { kind: "confirmed", value: "CLOUD-V5" },
    expectMatchesDisk: false,
  },
  {
    name: "WITH the fix — commitConfirmedBaseline() ran immediately after the abandoned pull's own domain commit, recording confirmed authority at rev7 (exactly the value it wrote); the replacement pull's own baseline now matches disk, so no misclassification",
    abandonedPullDiskValue: "CLOUD-V7",
    confirmed: { status: "confirmed", fact: { revision: 7, value: "CLOUD-V7" } },
    cloudRevision: 9,
    preFetch: { diskValue: "PRE-FETCH-UNUSED" },
    fallbackValue: "FALLBACK-REF-UNUSED",
    expected: { kind: "confirmed", value: "CLOUD-V7" },
    expectMatchesDisk: true,
  },
  {
    name: "required case 5 — authority unchanged (no OTHER pull ever advanced it) is the SAME shape as the fixed case: this pull's own recorded fact IS the current confirmed authority, so the very next pull (or this same one, re-entered) resolves it normally",
    abandonedPullDiskValue: "CLOUD-V3",
    confirmed: { status: "confirmed", fact: { revision: 3, value: "CLOUD-V3" } },
    cloudRevision: 3,
    preFetch: { diskValue: "PRE-FETCH-UNUSED" },
    fallbackValue: "FALLBACK-REF-UNUSED",
    expected: { kind: "confirmed", value: "CLOUD-V3" },
    expectMatchesDisk: true,
  },
];

// ===== DURABLE LOCAL AUTHORITY (SH.2.1 P3) =====

/**
 * SH.2.1 P3 (Codex) — a third audit found that pull winner selection
 * (plans/page.tsx's and lightning/page.tsx's pull effect) still read the
 * canonical plans/lightning/days keys DIRECTLY (`localStorage.getItem`/
 * `loadFromStorage`/`loadDays`) for every sync/conflict decision: the
 * pre-fetch frozen snapshot (stage 1), the post-fetch "current" candidate
 * compared against baseline (stage 2 / winner selection), and therefore
 * `changedLocally` itself. This is a DIFFERENT interpretation of "current
 * local state" than the one syncHelper.ts's own readLatestDurableValue()
 * already uses for the unload/push payload path (buildPayloadFromStorage):
 * that function — see its own doc in syncHelper.ts — prefers a surviving
 * local-edit-fact over the canonical key, specifically because the
 * documented cross-tab hydration race (a genuinely concurrent OTHER tab's
 * plain, unlocked write landing inside pull hydration's own synchronous
 * lock callback) can leave the canonical key transiently — or, if a PRIOR
 * pull's hydration incorrectly trusted it, durably — stale relative to an
 * edit the local-edit-fact log still records faithfully (the log is never
 * touched by hydration except on a write that actually, provably,
 * incorporates the exact fact being retired — see
 * commitLocalDomainRaw()'s own doc).
 *
 * Root cause: TWO different "what is local state right now" answers
 * coexisted in the same sync state machine. The unload/push path asked
 * readLatestDurableValue() and got the edit-aware answer; pull winner
 * selection asked the canonical key directly and could get the stale one.
 * A pull that reads the stale answer can conclude "local unchanged"
 * (canonical == baseline) even though the true durable local value (the
 * surviving edit fact) genuinely differs from both baseline AND cloud —
 * letting cloud win, and — because the write that follows durably matches
 * what winner selection decided — legitimately (by commitLocalDomainRaw's
 * OWN rules) retiring the very edit fact that should have won instead.
 * This is not a bug in commitLocalDomainRaw's CAS or edit-fact retirement
 * (untouched by this fix, still correct on its own terms — see below); the
 * bug is entirely in what value winner selection FED it as the decision.
 *
 * STANDING RULE (this round) — every sync/conflict decision must use the
 * SAME definition of local authority: canonical value + unresolved
 * local-edit facts → effective durable local value, via ONE shared
 * resolver, consistently, everywhere the pull lifecycle reasons about
 * "current local state": pre-fetch frozen snapshots, post-fetch current
 * candidates, changed-locally comparisons, conflict recovery, and winner
 * selection (unload/push construction already complied — see above).
 *
 * resolveEffectiveDurableRaw() below is the PURE core of
 * readLatestDurableValue() — extracted (not reimplemented: read-
 * LatestDurableValue() is now a thin I/O wrapper around this exact
 * function, so every production caller of either gets the identical
 * decision) so it can carry real DEV_* coverage the way every other pure
 * decision in this module does. `factRawValues` is the raw string content
 * of every currently-recorded local-edit-fact key for this domain's
 * canonical key (0, 1, or — rarely, a genuine same-instant multi-tab
 * tie — more); one OR MORE surviving facts that all agree on the same raw
 * value outrank the canonical value (durable unresolved intent, by
 * construction more authoritative than whatever the canonical key happens
 * to contain right now — this holds whether it is a single fact or several
 * peers who all independently recorded the identical value); zero facts,
 * or two-or-more that genuinely DISAGREE, fall back to the canonical value
 * itself (nothing recorded yet, or an ambiguous tie with no ordering
 * information — "last write wins among peers", same tie-break every other
 * concurrent write to one value gets).
 *
 * SH.2.5.2 (Codex review, "unanimous edit facts" finding) — a same-instant
 * multi-tab tie where every surviving fact happens to carry the SAME
 * value (e.g. two tabs each independently record an edit fact for an
 * identical user action, or a fact written by an in-flight
 * commitLocalDomainRawSync() survives alongside a copy already published
 * by another tab) is not genuinely ambiguous: there is only one candidate
 * winner, so it must win, exactly as a lone surviving fact already does.
 * Falling back to canonical in that case (the pre-fix behavior, which only
 * ever special-cased `factRawValues.length === 1`) could resurrect a
 * stale canonical value even though every recorded fact agreed on
 * something newer. Only a fact set that genuinely disagrees (two or more
 * DISTINCT values) is a real ambiguous tie with no ordering information —
 * that case is unchanged: it still defers to canonical, the same
 * conservative "last write wins among peers" fallback as before.
 *
 * WHY commitLocalDomainRaw()'s OWN CAS is intentionally left untouched —
 * its `expectedPreviousRaw`/internal re-read must both stay the LITERAL
 * canonical key's bytes, not this effective value: that CAS exists purely
 * to detect "did the CANONICAL KEY change since I decided what to write
 * it" (a write-safety concern), which is orthogonal to "what should this
 * pull have treated as authoritative for ITS OWN decision" (this fix's
 * concern). A caller now takes TWO separate reads at decision time — the
 * effective durable value (via this resolver, for the decision itself)
 * and the literal canonical raw bytes (for commitLocalDomainRaw's CAS
 * argument) — never conflating them. The write that follows, when local's
 * effective-durable value wins, naturally carries that exact value as
 * `nextRaw`; commitLocalDomainRaw's own untouched `baselineEditFactIds`
 * re-scan (see its own doc) already guarantees the write is abandoned
 * ("superseded") if a genuinely NEWER edit fact appears between decision
 * and write — required case 4 needs no change here, it was already
 * correct, independent of which raw value winner selection compared.
 */
export function resolveEffectiveDurableRaw(canonicalRaw: string | null, factRawValues: string[]): string | null {
  if (factRawValues.length === 0) return canonicalRaw;
  const [first, ...rest] = factRawValues;
  return rest.every((raw) => raw === first) ? first : canonicalRaw;
}

/**
 * Reference cases for resolveEffectiveDurableRaw() — the REQUIRED cases
 * from the SH.2.1 P3 architectural contract. Run from Node:
 *   import { DEV_RESOLVE_EFFECTIVE_DURABLE_RAW_CASES, resolveEffectiveDurableRaw } from "@/lib/syncPayload";
 *   DEV_RESOLVE_EFFECTIVE_DURABLE_RAW_CASES.forEach(c => {
 *     const got = resolveEffectiveDurableRaw(c.canonicalRaw, c.factRawValues);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_RESOLVE_EFFECTIVE_DURABLE_RAW_CASES: Array<{
  name: string;
  canonicalRaw: string | null;
  factRawValues: string[];
  expected: string | null;
}> = [
  {
    name: "required case 5 — normal case, no edit facts: durable read equals canonical value",
    canonicalRaw: "CANONICAL-B",
    factRawValues: [],
    expected: "CANONICAL-B",
  },
  {
    name: "required cases 1/6 — exactly one surviving edit fact outranks a stale canonical value",
    canonicalRaw: "STALE-CANONICAL-B",
    factRawValues: ["EDIT-FACT-C"],
    expected: "EDIT-FACT-C",
  },
  {
    name: "no canonical value yet, one edit fact — fact still wins (a fresh domain's very first edit)",
    canonicalRaw: null,
    factRawValues: ["EDIT-FACT-C"],
    expected: "EDIT-FACT-C",
  },
  {
    name: "zero edit facts, canonical absent too — null, same as a plain canonical-only read would give",
    canonicalRaw: null,
    factRawValues: [],
    expected: null,
  },
  {
    name: "genuinely disagreeing tie — two facts recorded with no ordering information and DIFFERENT values: falls back to canonical rather than guessing which wins (commitLocalDomainRaw's own edit-fact re-scan is the mechanism that actually protects a genuinely newer one — see this function's own doc)",
    canonicalRaw: "CANONICAL-B",
    factRawValues: ["EDIT-FACT-C", "EDIT-FACT-E"],
    expected: "CANONICAL-B",
  },
  {
    name: "one fact whose content happens to already equal canonical — still resolves via the fact (harmless: same value either way, but proves the rule is purely structural (fact count/agreement), never a value comparison against canonical)",
    canonicalRaw: "SAME-VALUE",
    factRawValues: ["SAME-VALUE"],
    expected: "SAME-VALUE",
  },
  {
    name: "SH.2.5.2 required — UNANIMOUS multi-fact tie: two distinct surviving fact keys that both recorded the SAME value are not ambiguous — the shared value wins over a stale canonical value, exactly as a lone fact would",
    canonicalRaw: "STALE-CANONICAL-B",
    factRawValues: ["EDIT-FACT-A", "EDIT-FACT-A"],
    expected: "EDIT-FACT-A",
  },
  {
    name: "SH.2.5.2 — unanimous tie among three or more surviving facts still resolves to the shared value",
    canonicalRaw: "STALE-CANONICAL-B",
    factRawValues: ["EDIT-FACT-A", "EDIT-FACT-A", "EDIT-FACT-A"],
    expected: "EDIT-FACT-A",
  },
  {
    name: "SH.2.5.2 — three facts where only two agree is still a genuine disagreement (not unanimous): falls back to canonical",
    canonicalRaw: "CANONICAL-B",
    factRawValues: ["EDIT-FACT-A", "EDIT-FACT-A", "EDIT-FACT-C"],
    expected: "CANONICAL-B",
  },
];

// ===== ORDINARY-EDIT NOOP DECISION (SH.2.1 P1, this round) =====
//
// Codex found a second violation of the SH.2.1 P3 standing rule:
// commitLocalDomainRawSync() (syncHelper.ts) — the primitive EVERY ordinary
// user edit across Plans/Lightning/days routes through — decided "noop"
// (nothing to write) by comparing the caller's requested `nextRaw` against
// the canonical key's raw bytes ALONE, via decideLocalDomainCommit(
// currentRaw, currentRaw, nextRaw) with `currentRaw` a plain
// localStorage.getItem(key). If canonical held a stale value B while an
// unresolved edit fact C was the true durable authority (the same
// documented cross-tab hydration race SH.2.1 P3 already covers for pull
// winner selection), a user who deliberately edited the field back to B —
// a genuine, fresh user action — would see `nextRaw === currentRaw` (both
// B) and get "noop": no new edit fact published, canonical left untouched,
// and the OLDER, unrelated fact C left standing as durable authority
// forever, even though the user's own newest intent was actually B.
//
// The fix (in commitLocalDomainRawSync() itself — see its own doc in
// syncHelper.ts) reuses exactly the two existing shared primitives SH.2.1
// P3 already established, composed the SAME way readLatestDurableValue()
// already composes them: resolveEffectiveDurableRaw() (canonical + edit
// facts -> effective durable value) feeds decideLocalDomainCommit() (the
// noop/write/superseded decision) as BOTH its `currentRaw` and
// `expectedPreviousRaw` — a force-commit, so the outcome can only be
// "write" or "noop", never "superseded". No new interpretation of local
// authority is introduced; this is the identical resolver, reused. The
// cases below exercise that exact composition of the two real,
// already-covered production functions — not a reimplementation.
//
/**
 * Reference cases for the ORDINARY-EDIT noop decision commitLocalDomainRawSync()
 * now makes — the REQUIRED cases from the SH.2.1 P1 (this round)
 * architectural contract. Run from Node:
 *   import { DEV_ORDINARY_EDIT_COMMIT_CASES, resolveEffectiveDurableRaw, decideLocalDomainCommit } from "@/lib/syncPayload";
 *   DEV_ORDINARY_EDIT_COMMIT_CASES.forEach(c => {
 *     const durable = resolveEffectiveDurableRaw(c.canonicalRaw, c.factRawValues);
 *     const got = decideLocalDomainCommit(durable, durable, c.nextRaw);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_ORDINARY_EDIT_COMMIT_CASES: Array<{
  name: string;
  canonicalRaw: string | null;
  factRawValues: string[];
  nextRaw: string;
  expected: LocalDomainCommitDecision;
}> = [
  {
    name: "required case 3 — canonical B + durable fact C + user deliberately chooses B: must WRITE (publish B as the newest durable intent), never a silent noop against stale canonical bytes",
    canonicalRaw: "B",
    factRawValues: ["C"],
    nextRaw: "B",
    expected: "write",
  },
  {
    name: "required case 4 — requested value already equals the effective durable value (the surviving fact itself): true noop",
    canonicalRaw: "B",
    factRawValues: ["C"],
    nextRaw: "C",
    expected: "noop",
  },
  {
    name: "required case 5 — normal case, no edit facts: noop rule reduces to plain canonical comparison, unchanged from before this fix",
    canonicalRaw: "B",
    factRawValues: [],
    nextRaw: "B",
    expected: "noop",
  },
  {
    name: "required case 5 (companion) — normal case, no edit facts, genuinely new value: still writes exactly as before this fix",
    canonicalRaw: "B",
    factRawValues: [],
    nextRaw: "D",
    expected: "write",
  },
  {
    name: "no canonical yet, no facts yet (first-ever edit for this key): writes",
    canonicalRaw: null,
    factRawValues: [],
    nextRaw: "B",
    expected: "write",
  },
  {
    name: "genuinely disagreeing 2-fact tie falls back to canonical for the noop decision too — same tie-break resolveEffectiveDurableRaw always applies, never a special case here",
    canonicalRaw: "B",
    factRawValues: ["C", "E"],
    nextRaw: "B",
    expected: "noop",
  },
];

// ===== ORDINARY-EDIT NOOP CANONICAL REPAIR (SH.2.5.2, Codex review
// "effective-value local-write noops" finding) =====
//
// ROOT CAUSE: the noop decision above (DEV_ORDINARY_EDIT_COMMIT_CASES,
// required case 4) correctly recognizes `nextRaw === effectiveDurableRaw`
// as "nothing NEW to record", but commitLocalDomainRawSync() (syncHelper.ts)
// then returned immediately on ANY "noop" without ever checking whether
// CANONICAL STORAGE ITSELF already held those bytes. When the effective
// durable value came from a surviving fact outranking a stale canonical
// key (e.g. a prior edit whose canonical leg failed near quota — SH.2.4's
// own "committed-unprotected" outcome), a later ordinary edit that
// deliberately reproduces that exact value looked like a true no-op and
// left canonical permanently stale, with only the fact protecting it —
// forever, unless something else independently repaired or retired it.
//
// THE FIX (commitLocalDomainRawSync()'s own doc in syncHelper.ts has the
// full rationale): a noop still reports "noop", but first repairs
// canonical with a plain, unconditional overwrite whenever canonical does
// not already hold `nextRaw`'s bytes — always safe, since `nextRaw` is
// already durable authority by construction the moment `decision` says
// "noop". The protecting fact is left completely untouched by this repair
// either way — this is a canonical-storage materialization step, never a
// fact retirement decision (that stays owned by planOrdinaryEditFactCommit
// above / accepted-operation reconciliation's own materialize-then-retire,
// never duplicated here).
//
// The cases below model that exact decision purely, composing the SAME
// real resolveEffectiveDurableRaw()/decideLocalDomainCommit() production
// primitives the fix itself calls — reduced to whether a canonical repair
// write is needed, not a reimplementation.
export type OrdinaryEditNoopOutcome = "unchanged" | "repaired" | "write";

/**
 * Reference cases for commitLocalDomainRawSync()'s noop-canonical-repair
 * decision — the REQUIRED cases from the SH.2.5.2 architectural contract.
 * Deliberately NOT a new production function, matching the SAME
 * "fix centrally in the existing primitive" precedent DEV_HYDRATION_NOOP_SAFETY_CASES
 * and DEV_COMMIT_TIME_AUTHORITY_GATE_CASES already established. Run from Node:
 *   import { DEV_ORDINARY_EDIT_NOOP_REPAIR_CASES, resolveEffectiveDurableRaw, decideLocalDomainCommit } from "@/lib/syncPayload";
 *   DEV_ORDINARY_EDIT_NOOP_REPAIR_CASES.forEach(c => {
 *     const durable = resolveEffectiveDurableRaw(c.canonicalRaw, c.factRawValues);
 *     const decision = decideLocalDomainCommit(durable, durable, c.nextRaw);
 *     const got = decision === "write" ? "write" : (c.canonicalRaw !== c.nextRaw ? "repaired" : "unchanged");
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_ORDINARY_EDIT_NOOP_REPAIR_CASES: Array<{
  name: string;
  canonicalRaw: string | null;
  factRawValues: string[];
  nextRaw: string;
  expected: OrdinaryEditNoopOutcome;
}> = [
  {
    name: "SH.2.5.2 required — canonical B + fact A + ordinary save A: NOT a false durable noop, canonical is repaired to A even though nothing new is recorded",
    canonicalRaw: "B",
    factRawValues: ["A"],
    nextRaw: "A",
    expected: "repaired",
  },
  {
    name: "true noop — canonical already holds nextRaw, no facts at all: nothing to repair",
    canonicalRaw: "B",
    factRawValues: [],
    nextRaw: "B",
    expected: "unchanged",
  },
  {
    name: "true noop — canonical already holds nextRaw AND a fact also agrees (fully steady state): nothing to repair",
    canonicalRaw: "B",
    factRawValues: ["B"],
    nextRaw: "B",
    expected: "unchanged",
  },
  {
    name: "unanimous multi-fact agreement (SH.2.5.2) protecting a stale canonical value: still repaired, same as the single-fact case",
    canonicalRaw: "B",
    factRawValues: ["A", "A"],
    nextRaw: "A",
    expected: "repaired",
  },
  {
    name: "genuinely new value (not a noop at all): writes exactly as before, no repair logic involved",
    canonicalRaw: "B",
    factRawValues: [],
    nextRaw: "D",
    expected: "write",
  },
];

// ===== ORDINARY-EDIT FACT RETIREMENT (SH.2.4 — Concurrent Local Edit Fact
// Safety) =====================================================================
//
// ROOT CAUSE: commitLocalDomainRawSync() (syncHelper.ts) published its own
// edit fact, then "pruned" the key's local-edit-fact keyspace by RE-SCANNING
// it AFTER that write and deleting every key that was not its own —
// `for (const oldKey of snapshotKeysWithPrefix(...)) if (oldKey !== editFactKey)
// removeItem(oldKey)`. Ordinary edits are deliberately unlocked and
// synchronous (16th round, above) so a genuinely concurrent OTHER tab's own
// commitLocalDomainRawSync() call can publish ITS fact at any point relative
// to this one's own statements — including strictly BETWEEN this call's own
// fact/canonical writes and this exact prune loop. That re-scan-after-write
// re-scan has no way to distinguish "a fact I already knew about and am
// superseding" from "a fact a different writer just published a moment ago,
// completely unrelated to my own decision" — it deletes both identically.
// Two tabs each publishing a fact and then pruning "everything but mine" can
// therefore each delete the OTHER's still-unresolved fact, leaving
// readLatestDurableValue() with no surviving evidence for either edit — the
// exact failure this phase exists to close (see the 17th round's own
// "DEFERRED — SH.2.3/SH.2.4" note above).
//
// THE FIX: never re-derive "what to delete" from a POST-write re-scan. Take
// the local-edit-fact keyspace SNAPSHOT BEFORE this call's own writes (this
// writer's OWN observed baseline — the exact same "frontier, captured once,
// consumed once" discipline commitLocalDomainRaw() already applies for
// hydration's `baselineEditFactIds` above) and retire ONLY keys that were
// members of THAT snapshot. A fact that is not in the baseline — because it
// did not exist yet when this call captured it — is structurally
// unreachable by this decision: `planOrdinaryEditFactCommit()` below only
// ever receives the baseline array as its universe of retirement candidates,
// so it cannot name a key outside it no matter how it reasons. This is what
// makes "never delete another writer's unresolved fact" hold BY
// CONSTRUCTION, not by a runtime check that could itself race: retiring the
// baseline is safe for the SAME reason hydration's retirement of
// `baselineEditFactIds` is safe (see commitLocalDomainRaw's own "LOCAL-EDIT
// FACT LIFECYCLE" doc) — every fact in it was already OBSERVED by this
// decision (folded into the effective-durable-value read that `nextRaw` is
// this writer's fresh response to), so this writer's own newer publish
// genuinely supersedes it; a fact NOT in it was never observed, so this
// writer has no basis — and, with this fix, no ABILITY — to declare it
// obsolete.
//
// SAME-VALUE DEDUP (avoids unnecessary growth without any additional
// deletion risk): if some baseline fact's raw content already equals
// `nextRaw` byte-for-byte, that fact already durably records this exact
// intent — publishing a second, physically-unique duplicate key would only
// grow storage for zero informational gain (mirrors
// planHydrationProvenanceDedup()'s own "already present, no new write
// needed" rule above, applied here to the ordinary-edit fact log instead of
// the hydration-provenance log). The matching fact is reused as `ownFactKey`
// (kept, never retired) precisely because it is not obsolete: it already
// carries the value this decision needed published, whether that fact
// happens to be this writer's own earlier publish or a genuinely different
// concurrent writer's. Every OTHER baseline fact (necessarily a different,
// now-superseded value) is still retired exactly as the no-match case
// retires the whole baseline.
export interface LocalEditFactRecord {
  key: string;
  raw: string;
}

export interface OrdinaryEditFactCommitPlan {
  /** Whether a NEW fact key needs to be written at `ownFactKey`. False when
   * an existing baseline fact already carries `nextRaw`'s exact bytes. */
  writeNew: boolean;
  /** The fact key that durably represents `nextRaw` after this commit —
   * either the freshly-generated `candidateFactKey`, or a reused baseline
   * fact whose content already matched. Never retired by this same plan. */
  ownFactKey: string;
  /** Baseline fact keys to remove — always a SUBSET of `baselineFacts`,
   * never a key outside it (see this section's own module doc for why that
   * containment is the entire safety property this function exists to
   * provide). */
  keysToRetire: string[];
}

export function planOrdinaryEditFactCommit(
  baselineFacts: LocalEditFactRecord[],
  nextRaw: string,
  candidateFactKey: string
): OrdinaryEditFactCommitPlan {
  const matching = baselineFacts.find((fact) => fact.raw === nextRaw);
  const ownFactKey = matching ? matching.key : candidateFactKey;
  const keysToRetire = baselineFacts.filter((fact) => fact.key !== ownFactKey).map((fact) => fact.key);
  return { writeNew: !matching, ownFactKey, keysToRetire };
}

/**
 * Reference cases for planOrdinaryEditFactCommit() — the REQUIRED cases from
 * the SH.2.4 architectural contract. Run from Node:
 *   import { DEV_ORDINARY_EDIT_FACT_COMMIT_CASES, planOrdinaryEditFactCommit } from "@/lib/syncPayload";
 *   DEV_ORDINARY_EDIT_FACT_COMMIT_CASES.forEach(c => {
 *     const got = planOrdinaryEditFactCommit(c.baselineFacts, c.nextRaw, c.candidateFactKey);
 *     const ok = got.writeNew === c.expected.writeNew && got.ownFactKey === c.expected.ownFactKey &&
 *       JSON.stringify([...got.keysToRetire].sort()) === JSON.stringify([...c.expected.keysToRetire].sort());
 *     console.log(ok ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_ORDINARY_EDIT_FACT_COMMIT_CASES: Array<{
  name: string;
  baselineFacts: LocalEditFactRecord[];
  nextRaw: string;
  candidateFactKey: string;
  expected: OrdinaryEditFactCommitPlan;
}> = [
  {
    name: "required — first-ever edit for this key: no baseline, writes a new fact, retires nothing",
    baselineFacts: [],
    nextRaw: "A",
    candidateFactKey: "candidate",
    expected: { writeNew: true, ownFactKey: "candidate", keysToRetire: [] },
  },
  {
    name: "required — ordinary sequential edit: this writer's own prior fact is in its baseline and is genuinely superseded",
    baselineFacts: [{ key: "F1", raw: "OLD" }],
    nextRaw: "NEW",
    candidateFactKey: "candidate",
    expected: { writeNew: true, ownFactKey: "candidate", keysToRetire: ["F1"] },
  },
  {
    name: "required — SH.2.4 root cause: two concurrent writers' facts, BOTH observed in this decision's own baseline, are legitimately superseded together by a genuinely newer third value",
    baselineFacts: [
      { key: "F1", raw: "TAB-A" },
      { key: "F2", raw: "TAB-B" },
    ],
    nextRaw: "TAB-C",
    candidateFactKey: "candidate",
    expected: { writeNew: true, ownFactKey: "candidate", keysToRetire: ["F1", "F2"] },
  },
  {
    name: "required — a fact NOT in the baseline can never appear in keysToRetire: an empty baseline retires nothing no matter what nextRaw is, even though a concurrent OTHER tab may have just published a fact this call never observed",
    baselineFacts: [],
    nextRaw: "WHATEVER",
    candidateFactKey: "candidate",
    expected: { writeNew: true, ownFactKey: "candidate", keysToRetire: [] },
  },
  {
    name: "required — same-value concurrent edit: an already-surviving baseline fact exactly matches nextRaw, so it is reused (not retired) and no duplicate fact is written",
    baselineFacts: [{ key: "F1", raw: "SAME" }],
    nextRaw: "SAME",
    candidateFactKey: "candidate",
    expected: { writeNew: false, ownFactKey: "F1", keysToRetire: [] },
  },
  {
    name: "same-value dedup among an ambiguous multi-fact baseline: the matching sibling is kept, the genuinely different one is still retired as obsolete",
    baselineFacts: [
      { key: "F1", raw: "MATCH" },
      { key: "F2", raw: "OTHER" },
    ],
    nextRaw: "MATCH",
    candidateFactKey: "candidate",
    expected: { writeNew: false, ownFactKey: "F1", keysToRetire: ["F2"] },
  },
];

// ===== ORDINARY-EDIT PERSIST OUTCOME (SH.2.4 Codex P1 follow-up round —
// "fact allocation near quota must not block a best-effort canonical
// write") ====================================================================
//
// ROOT CAUSE: commitLocalDomainRawSync() published the new local-edit-fact
// key (`plan.ownFactKey`, when `plan.writeNew`) BEFORE writing the canonical
// key. A brand-new key can fail near localStorage quota (`QuotaExceededError`)
// in a case where overwriting the EXISTING canonical key with the same or
// smaller value would still succeed — a new key needs genuinely additional
// storage, while overwriting an existing one usually does not. The previous
// code returned "failed" the instant the fact `setItem` threw, WITHOUT ever
// attempting the canonical write — so a user's edit that could have been
// preserved was instead left only in React state, and lost on reload.
//
// THE FIX: attempt BOTH writes unconditionally (never let one leg's failure
// skip the other), then classify the outcome from what actually landed.
// decideOrdinaryEditPersistOutcome() is the pure decision, given only
// whether each leg durably succeeded:
//   • neither leg landed — "failed". Fail safely: nothing changed on disk,
//     so the baseline facts this decision observed are left completely
//     untouched (the caller must not retire anything in this case — see
//     commitLocalDomainRawSync's own doc for how this return value gates
//     that).
//   • BOTH legs landed — "committed", exactly the pre-existing full-success
//     outcome. Every SH.2.4 concurrent-fact guarantee applies unchanged:
//     the new fact durably backs this exact edit, so this case must never
//     be weakened by this round.
//   • exactly ONE leg landed — "committed-unprotected": the requested value
//     IS durably recoverable (readLatestDurableValue() will still resolve
//     to it — via the surviving fact, when only the fact leg landed and it
//     is the sole surviving fact for this key; via canonical directly,
//     when only the canonical leg landed), but this write no longer carries
//     the FULL SH.2.4 protection a genuine fact+canonical pair provides —
//     see isLocalDomainCommitSuccess()'s own doc for why this is still
//     treated as a durable success for gating purposes (the overriding
//     LOCAL-FIRST DURABILITY CONTRACT is "never lose the user's edit to
//     React state alone", which this outcome satisfies) while remaining
//     distinctly reported so it is never confused with the fully-protected
//     case. This is the SAME class of already-accepted, narrower-window
//     residual risk documented for the no-Web-Locks case generally — never
//     a new correctness gap, only an honest name for an unavoidable
//     degraded outcome.
// Retirement of this decision's own observed baseline facts (`keysToRetire`
// from planOrdinaryEditFactCommit() above) is safe whenever this function
// does NOT return "failed" — i.e. whenever nextRaw is durably held by
// EITHER leg — for the identical reason the fully-successful path was
// already safe: those facts are proven-stale evidence the moment ANY
// surviving representation (fact or canonical) of the newer value exists,
// regardless of which leg happened to be the one that landed.
export type OrdinaryEditPersistOutcome = "committed" | "committed-unprotected" | "failed";

export function decideOrdinaryEditPersistOutcome(
  factPublished: boolean,
  canonicalWritten: boolean
): OrdinaryEditPersistOutcome {
  if (!factPublished && !canonicalWritten) return "failed";
  if (factPublished && canonicalWritten) return "committed";
  return "committed-unprotected";
}

/**
 * Reference cases for decideOrdinaryEditPersistOutcome() — the REQUIRED
 * cases from the SH.2.4 Codex P1 follow-up round. Run from Node:
 *   import { DEV_ORDINARY_EDIT_PERSIST_OUTCOME_CASES, decideOrdinaryEditPersistOutcome } from "@/lib/syncPayload";
 *   DEV_ORDINARY_EDIT_PERSIST_OUTCOME_CASES.forEach(c => {
 *     const got = decideOrdinaryEditPersistOutcome(c.factPublished, c.canonicalWritten);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_ORDINARY_EDIT_PERSIST_OUTCOME_CASES: Array<{
  name: string;
  factPublished: boolean;
  canonicalWritten: boolean;
  expected: OrdinaryEditPersistOutcome;
}> = [
  {
    name: "required case 1 — fact allocation fails near quota, canonical overwrite still succeeds: durably preserved, but reported distinctly from a fully-protected commit",
    factPublished: false,
    canonicalWritten: true,
    expected: "committed-unprotected",
  },
  {
    name: "required case 2 — both fact allocation and the canonical write fail: fail safely, nothing durable changed",
    factPublished: false,
    canonicalWritten: false,
    expected: "failed",
  },
  {
    name: "required case 3 — normal successful fact publication: full SH.2.4 protection, unweakened",
    factPublished: true,
    canonicalWritten: true,
    expected: "committed",
  },
  {
    name: "symmetric case — canonical write fails but the new fact still lands: still durably recoverable via the surviving fact, reported as unprotected rather than a full commit",
    factPublished: true,
    canonicalWritten: false,
    expected: "committed-unprotected",
  },
];

// ===== PROFILE-OWNED SYNC STATE (SH.2.1 P1, this round) =====
//
// Codex found a second architectural gap: deleteProfile() (profileStorage.ts)
// removes a deleted profile's plain `dwp:{profileId}:{baseKey}` canonical
// keys, but every OTHER per-profile key shape this module's sync layer
// owns — local-edit facts, confirmed facts, pending pushes, the local-
// content-owner marker — lives under a DIFFERENT prefix
// (`dwp:localEditFact:...` / `dwp:sync:...`) that deleteProfile()'s own
// simple `dwp:{profileId}:` prefix scan never matches. Left behind, these
// are DURABLE, profile-owned sync state: recreating a profile with the
// SAME normalized id (trivial — normalizeId() is deterministic) can
// resurrect them. A leftover local-edit fact in particular can outrank the
// new profile's own (empty) canonical value the moment ANY sync/conflict
// decision reads durable local authority for that key (mount hydration,
// pull winner selection, or an ordinary edit's own noop check — see
// resolveEffectiveDurableRaw()'s standing rule above), letting deleted
// planner content silently reappear under a profile the user believes is
// brand new.
//
// isProfileOwnedSyncKey() is the ONE shared predicate for "does this
// localStorage KEY belong to this profileId's sync-layer state" — covering
// every shape syncHelper.ts's own key-builders produce for a profile:
//   - local-edit facts:    dwp:localEditFact:dwp:{profileId}:{baseKey}:{editId}
//   - local content owner: dwp:sync:{profileId}:localContentOwner
//   - sync status:         dwp:sync:{profileId}:status
//   - last-synced time:    dwp:sync:{profileId}:lastSyncedAt
//   - last sync error:     dwp:sync:{profileId}:lastError
//   - confirmed facts:     dwp:sync:{userId}:{profileId}:confirmedFact:{domain}:{revision}:{instanceId}
//   - hydration provenance: dwp:sync:{userId}:{profileId}:hydrationFact:{domain}:{revision}:{instanceId}
//   - pending ops:         dwp:sync:{userId}:{profileId}:pendingOp:{opId}
//   - pending op cursor:   dwp:sync:{userId}:{profileId}:pendingOpCursor
// `userId` is unknown to a profile-deletion caller (profileStorage.ts has
// no auth context, by design — profiles are device-local), so the
// confirmedFact/hydrationFact/pendingOp/pendingOpCursor family — all
// namespaced `dwp:sync:{userId}:{profileId}:...` — is matched
// STRUCTURALLY: profileId must appear as the exact 4th colon-delimited
// segment (0-indexed 3), wherever `userId` actually is, rather than
// requiring the caller to enumerate every identity that may ever have
// synced this profile.
//
// Codex P2 (SH.2.2 cleanup round) — the profile-level status/lastSyncedAt/
// lastError keys are NOT userId-scoped (`dwp:sync:{profileId}:status`, a
// 4-segment key — the structural `parts.length >= 5` branch above never
// matches them, exactly like localContentOwner needed its own explicit
// check) and were missing from this predicate entirely: deleting a profile
// left them behind, so recreating the same normalized profile ID inherited
// a stale sync status ("error"/"syncing"), a stale lastSyncedAt timestamp,
// and a stale lastError message from the profile that used to occupy that
// ID — never reflecting the fact that this is now a brand-new profile that
// has never synced.
//
// This is a PURE string predicate deliberately kept in this module (not
// syncHelper.ts) so it carries real DEV_* coverage the same way every
// other decision in this file does; syncHelper.ts's purgeProfileSyncState()
// (the I/O wrapper profileStorage.ts's deleteProfile() calls) is a thin
// scan-and-remove loop built directly on this exact predicate — see its
// own doc there.
export function isProfileOwnedSyncKey(key: string, profileId: string): boolean {
  if (key.startsWith(`dwp:localEditFact:dwp:${profileId}:`)) return true;
  if (key === `dwp:sync:${profileId}:localContentOwner`) return true;
  if (key === `dwp:sync:${profileId}:status`) return true;
  if (key === `dwp:sync:${profileId}:lastSyncedAt`) return true;
  if (key === `dwp:sync:${profileId}:lastError`) return true;
  if (key.startsWith("dwp:sync:")) {
    const parts = key.split(":");
    // ["dwp", "sync", userId, profileId, domainKind, ...] — profileId is
    // always the 4th segment (index 3) in every userId-scoped shape.
    if (parts.length >= 5 && parts[3] === profileId) return true;
  }
  return false;
}

/**
 * Reference cases for isProfileOwnedSyncKey() — the REQUIRED cases from the
 * SH.2.1 P1 (this round) architectural contract. Run from Node:
 *   import { DEV_IS_PROFILE_OWNED_SYNC_KEY_CASES, isProfileOwnedSyncKey } from "@/lib/syncPayload";
 *   DEV_IS_PROFILE_OWNED_SYNC_KEY_CASES.forEach(c => {
 *     const got = isProfileOwnedSyncKey(c.key, c.profileId);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_IS_PROFILE_OWNED_SYNC_KEY_CASES: Array<{
  name: string;
  key: string;
  profileId: string;
  expected: boolean;
}> = [
  {
    name: "required case 1 — a plans local-edit fact for this profile is matched",
    key: "dwp:localEditFact:dwp:my-family:plans:op-123",
    profileId: "my-family",
    expected: true,
  },
  {
    name: "required case 1 — a lightning local-edit fact for this profile is matched",
    key: "dwp:localEditFact:dwp:my-family:lightning:op-456",
    profileId: "my-family",
    expected: true,
  },
  {
    name: "required case 1 — a days local-edit fact for this profile is matched",
    key: "dwp:localEditFact:dwp:my-family:days:op-789",
    profileId: "my-family",
    expected: true,
  },
  {
    name: "required case 1 — the local-content-owner marker for this profile is matched",
    key: "dwp:sync:my-family:localContentOwner",
    profileId: "my-family",
    expected: true,
  },
  {
    name: "Codex P2 (SH.2.2 cleanup round) — the profile-level sync status key is matched",
    key: "dwp:sync:my-family:status",
    profileId: "my-family",
    expected: true,
  },
  {
    name: "Codex P2 (SH.2.2 cleanup round) — the profile-level lastSyncedAt key is matched",
    key: "dwp:sync:my-family:lastSyncedAt",
    profileId: "my-family",
    expected: true,
  },
  {
    name: "Codex P2 (SH.2.2 cleanup round) — the profile-level lastError key is matched",
    key: "dwp:sync:my-family:lastError",
    profileId: "my-family",
    expected: true,
  },
  {
    name: "required case 1 — a confirmed fact for this profile, under some userId, is matched without knowing the userId in advance",
    key: "dwp:sync:user-abc123:my-family:confirmedFact:plans:7:op-999",
    profileId: "my-family",
    expected: true,
  },
  {
    name: "SH.2.2 authority-vs-provenance round — a hydration-provenance fact for this profile, under some userId, is matched without knowing the userId in advance (SAME structural shape as a confirmed fact, so deletion coverage is automatic)",
    key: "dwp:sync:user-abc123:my-family:hydrationFact:plans:7:op-999",
    profileId: "my-family",
    expected: true,
  },
  {
    name: "required case 1 — a pending op for this profile, under some userId, is matched",
    key: "dwp:sync:user-abc123:my-family:pendingOp:op-321",
    profileId: "my-family",
    expected: true,
  },
  {
    name: "required case 1 — the pending-op cursor for this profile, under some userId, is matched",
    key: "dwp:sync:user-abc123:my-family:pendingOpCursor",
    profileId: "my-family",
    expected: true,
  },
  {
    name: "required case 2 — a DIFFERENT profile's local-edit fact must never be matched (no cross-profile resurrection risk introduced by this purge)",
    key: "dwp:localEditFact:dwp:other-profile:plans:op-123",
    profileId: "my-family",
    expected: false,
  },
  {
    name: "required case 2 — a different profile's confirmed fact, even under the SAME userId, must never be matched",
    key: "dwp:sync:user-abc123:other-profile:confirmedFact:plans:7:op-999",
    profileId: "my-family",
    expected: false,
  },
  {
    name: "Codex P2 (SH.2.2 cleanup round) — a different profile's sync status key must never be matched",
    key: "dwp:sync:other-profile:status",
    profileId: "my-family",
    expected: false,
  },
  {
    name: "SH.2.2 authority-vs-provenance round — a different profile's hydration-provenance fact must never be matched",
    key: "dwp:sync:user-abc123:other-profile:hydrationFact:plans:7:op-999",
    profileId: "my-family",
    expected: false,
  },
  {
    name: "a profile's own plain canonical key is NOT matched here — deleteProfile()'s existing dwp:{id}: prefix scan already owns that shape; this predicate only covers the sync-layer shapes it misses",
    key: "dwp:my-family:plans",
    profileId: "my-family",
    expected: false,
  },
  {
    name: "an unrelated global key is never matched",
    key: "dwp.activeProfile",
    profileId: "my-family",
    expected: false,
  },
];

// ===== STALE-RESPONSE PULL RECOVERY (SH.2.1, this round) =====
//
// Codex found that a pull correctly REJECTING a stale response (a confirmed
// revision newer than this pull's own GET, per SH.2.1 P2's revision bound —
// see UnusableDomain's own doc in each page) had no RECOVERY: the pull
// effect simply returned, leaving syncReady false and scheduling nothing
// further. The page could then sit indefinitely with cloud sync disabled
// until an unrelated auth cycle or reload happened to re-run the pull
// effect for some other reason.
//
// Root cause: "gated" (an ambiguous/conflicted confirmed revision this
// pull's response could not repair) and "stale-response" (this pull's OWN
// response is simply OLDER than already-confirmed authority) were both
// treated as identical, permanent-until-something-else-changes bail-out
// conditions — correct for "gated" (a real conflict needs a genuinely NEW
// server state to resolve, which nothing here can force), but wrong for
// "stale-response": that domain's true current state is now KNOWN to this
// tab (the confirmed fact that made the response stale IS a real, already-
// durable answer) — there is no reason to wait for an unrelated event; a
// fresh GET will simply see it.
//
// decideStaleResponseRecovery() is the ONE shared, pure decision: a
// replacement pull is warranted if and only if EVERY unusable domain this
// pull bailed out on is "stale-response" — never when ANY domain is
// "gated" (required case 6: a real conflict must not silently reuse retry
// behavior it never asked for; recovering a conflict already has its own,
// separate contract — a later pull's own confirmed-state read repairing it
// via isConflictRepairableByRevision, untouched by this round) and never
// when ANY domain is "unusable-response" (this round's Codex finding —
// required cases 3 & 4: a pull whose OWN response carried no usable
// revision at all — a 204, or an unparseable/malformed payload, the kind
// of response `{}` or similar structurally-broken JSON produces — is not
// "a real snapshot that is merely older"; retrying it is not safe, since
// the very next GET is exactly as likely to be unusable again for the SAME
// reason, and nothing about that reason is revision-related — repeating it
// automatically would recreate an unbounded GET loop while sync stays
// gated the whole time). An empty input is "no-retry" — defensively
// correct (there is nothing to recover from), though the pull effect only
// ever calls this once it has already confirmed
// `unusableDomains.length > 0`.
//
// ===== COMMIT-TIME AUTHORITY & RECONCILIATION RECOVERY (SH.2.2) =====
//
// SH.2.1 P2's revision bound (resolvePostFetchDomainBaseline, above) is only
// checked ONCE per pull, at the moment this pull's GET response is known.
// Codex found the architectural gap this left: winner selection and the
// actual local write (commitLocalDomainRaw, syncHelper.ts) happen LATER,
// separated from that one check — and from EACH OTHER — by real awaited
// boundaries (reconcilePendingOperations, then one commitLocalDomainRaw
// call per domain, sequentially). Two DIFFERENT kinds of authority can move
// during those gaps, and neither was re-checked before the write that
// finally lands on disk:
//   (1) CONFIRMED AUTHORITY can advance — e.g. an already-in-flight push
//       (started before this pull, never aborted by cancelScheduledSync()
//       per its own contract — see syncHelper.ts's module doc — since that
//       only clears a PENDING timer, never an in-flight fetch) resolves
//       and calls commitConfirmedBaseline() for a NEWER revision, in the
//       window between this pull's one-time baseline check and its own
//       commitLocalDomainRaw() write. That push never touches the
//       canonical plans/lightning/days storage key itself (it only reads
//       and uploads it), so commitLocalDomainRaw()'s own CAS — which
//       compares literal canonical bytes — cannot detect this: the bytes
//       genuinely have not changed, yet the WINNER this pull already
//       decided is now a strictly older, already-superseded value.
//       Required case: GET rev7 resolves; before this pull's hydration
//       commit runs, a concurrent push confirms rev8 for the same domain.
//       This pull's rev7-based winner must never land — the domain must be
//       treated exactly as "stale-response" would have been treated had
//       this been visible at the ORIGINAL baseline check.
//   (2) LOCAL AUTHORITY can advance — an ordinary user edit
//       (commitLocalDomainRawSync) lands between winner selection's fresh
//       "current" read and this pull's own commitLocalDomainRaw() write.
//       commitLocalDomainRaw()'s CAS already detects this correctly and
//       reports "superseded" (never overwriting the edit — this protection
//       is untouched by SH.2.2), but nothing previously told the pull
//       EFFECT to do anything about it: syncReady stayed false (correctly
//       — this pull's own hydration did not durably land) but no
//       replacement pull was ever scheduled, so the page could sit with
//       cloud sync permanently disabled after a single benign local-edit
//       race, since the scheduleSync()-triggering effect is itself gated
//       on syncReady.
//
// Both are, architecturally, THE SAME problem: "a winner selected earlier
// must remain provisional until the instant it is actually committed."
// Both are RECOVERABLE the same way "stale-response" already is: the true
// current state (confirmed authority for (1), the surviving local edit for
// (2)) is already durably known to this device; there is no reason to wait
// for an unrelated event before trying again. Neither is ever safe to
// retry when mixed with a genuine "conflict" or "unusable-response" — see
// decideStaleResponseRecovery()'s own established rule above, extended
// (not replaced) below to also treat a local-edit CAS supersession as an
// always-safe-to-retry reason, exactly like "stale-response".
//
// `"local-edit-superseded"` is used ONLY for case (2) above — a
// commitLocalDomainRaw() "superseded" outcome — and carries no revision
// (there is none to carry: this is a local CAS decision, not a confirmed
// fact comparison). Case (1) reuses the EXISTING "stale-response"/
// "conflict"/"unusable-response" reasons unchanged: a commit-time
// revalidation is just resolvePostFetchDomainBaseline()/
// collectUnusableDomains() called again, fresh, immediately before each
// hydration commit — the SAME primitives the original once-per-pull check
// already uses, not a duplicated decision. See each page's pull effect
// (`revalidateAuthorityBeforeCommit()`/`handlePullDeferral()`) for the
// wiring: never a new polling loop or arbitrary delay — a revalidation
// check is one synchronous, already-in-memory read (getConfirmedState()),
// not a fetch, and a scheduled retry is the SAME ordinary React
// effect-dependency re-run (`staleRetryTick`) SH.2.1 already established,
// deduplicated by the SAME `staleRetryPendingRef` guard so multiple
// domains superseding within one pull (either kind, or a mix) still
// schedule at most one replacement pull.
//
// CODEX P1 FOLLOW-UP ROUND — case (1) above, as originally implemented,
// only ran the page-level revalidateAuthorityBeforeCommit() re-check
// BEFORE calling commitLocalDomainRaw() — but that function can then
// itself wait on the Web Lock if another writer currently holds this key's
// lock, and confirmed authority can advance DURING that wait without
// tripping either the canonical CAS (never touches this key) or
// `isStillValid` (confirmed-state changes never advance the pull epoch).
// Fixed by moving the authoritative re-check INSIDE commitLocalDomainRaw()
// itself, as a new `isAuthorityStillValid` parameter checked as the LAST
// gate, still inside the lock, immediately before the write and edit-fact
// retirement — see that function's own doc in syncHelper.ts and the
// "COMMIT-TIME AUTHORITY GATE ORDER" DEV_* section below for the full
// gate-ordering contract this establishes (a distinct "authority-superseded"
// LocalDomainCommitStatus, never conflated with "superseded"). Each page's
// pull effect now passes a `checkAuthorityStillValid` closure — built from
// the SAME `revalidateAuthorityBeforeCommit()` this section already
// established — to every domain's commitLocalDomainRaw() call, and maps an
// "authority-superseded" result back through the SAME `handlePullDeferral()`
// recovery path used everywhere else, using the FRESH unusable-domain list
// that closure itself just captured.
//
// CODEX P1 THIRD FOLLOW-UP ROUND — "Reject any changed confirmed baseline
// before commit." The check above (and the first follow-up round's
// `revalidateAuthorityBeforeCommit()`) asked "is the CURRENT confirmed
// state still USABLE relative to this pull's own cloudRevision" — reusing
// resolvePostFetchDomainBaseline()/collectUnusableDomains(), and therefore
// the "stale-response"/"conflict"/"unusable-response" reasons. That
// question has a real gap: winner selection was made against a SPECIFIC
// confirmed authority X (captured once, right when the pull's baseline was
// first computed). If confirmed authority changes to Y WHILE hydration
// waits for the lock, and Y is NEWER but still perfectly usable relative
// to this pull's own cloudRevision (e.g. X=revision 5, Y=revision 6,
// cloudRevision=7 — 6 <= 7 is a completely normal "confirmed" outcome),
// the old check reported "still valid" — even though the winner already
// selected was never recomputed against Y at all. "Usable" and "unchanged
// from what was actually used" are different questions; only the second
// one is safe to gate a commit on.
//
// `revalidateAuthorityBeforeCommit()` (each page) is now built on
// confirmedDomainResultsEqual() (above) instead: it compares a FRESH
// getConfirmedState() read against `winnerSelectionAuthority` — the EXACT
// ConfirmedPlannerState this pull's baseline check captured (via
// buildPostFetchPullBaseline()'s own `confirmed` return field) the ONE
// time winner selection actually ran. ANY difference — revision advanced
// OR regressed, the value at an unchanged revision differs, "none"
// becoming "confirmed", a "conflict" resolving or advancing — produces a
// NEW reason, `"authority-changed"`, for that domain. This SUBSUMES the
// old usability question rather than running alongside it: a domain whose
// confirmed authority is IDENTICAL to what winner selection used is, by
// construction, exactly as usable as it was already proven to be at the
// original baseline check (cloudRevision is fixed for the whole pull), so
// no separate usability re-derivation is needed at commit time anymore —
// see confirmedDomainResultsEqual()'s own doc above for the full
// rationale. The OLD "stale-response"/"conflict"/"unusable-response"
// reasons remain exactly as they were for the INITIAL, once-per-pull
// baseline-stage check (collectUnusableDomains(baselineOutcomes), BEFORE
// winner selection even runs) — untouched by this round; only the LATER,
// commit-time re-checks now produce "authority-changed" instead of
// reusing them.
//
// CODEX P1 "MAKE CONFIRMED-AUTHORITY SCANS ATOMIC" ROUND — the commit-time
// re-check above (`revalidateAuthorityBeforeCommit()`/`checkAuthorityStillValid()`)
// used getConfirmedState()'s plain scan, which captures `localStorage.length`
// then enumerates by index — NOT an atomic snapshot against a DIFFERENT
// tab's concurrent confirmed-fact write (see confirmedAuthorityLockName's
// own doc in syncHelper.ts for the full root-cause). Both pages' commit-time
// checks now call the NEW getConfirmedStateAtomic() (syncHelper.ts) instead
// — the SAME scan, serialized via a dedicated Web Lock against every
// recordConfirmedFact() write for this identity, so a torn read is
// impossible. `"authority-unavailable"` is the new reason for when that
// atomic read itself cannot be performed (Web Locks unavailable) — FAIL
// CLOSED, per this round's explicit requirement, rather than silently
// falling back to the non-atomic scan. Unlike "authority-changed"/
// "local-edit-superseded", this is NEVER auto-retried below: it reflects a
// permanent environment limitation (this browser lacks Web Locks), not a
// transient race a fresh pull could resolve — mirrors
// commitLocalDomainRaw()'s own "unavailable" status, which
// isLocalDomainCommitSuccess() also never treats as retryable.
//
// CODEX P1 "AUTHORITY VS. HYDRATION-PROVENANCE" ROUND — two DISTINCT durable
// records can now be written after a domain's own hydration commit succeeds
// (see isExactCloudValue()'s own doc above and recordHydrationProvenance()'s
// in syncHelper.ts): commitConfirmedBaseline() for a PURE cloud winner, or
// recordHydrationProvenance() for a locally-reconciled one. EITHER write can
// fail (a real I/O exception, or — for the confirmed-fact path only — a
// genuine cross-tab ambiguity at that exact domain/revision). Required this
// round: "on persistence failure/conflict, fail closed before authority
// ratchet, ownership transfer, syncReady, or push." `"provenance-write-failed"`
// is the ONE new reason covering BOTH writers — the caller (each page)
// checks the SAME boolean return either write already produced and, on
// `false`, defers the whole pull via this reason before EVER reaching the
// ratchet/ownership/syncReady/push steps that follow it in the same
// sequence, exactly as this round requires. Never auto-retried below —
// same treatment as "authority-unavailable": a fresh pull cannot itself
// resolve a write-time conflict or a genuine storage failure, so retrying
// blindly would just repeat it.
export type UnusableDomainReason =
  | "conflict"
  | "stale-response"
  | "unusable-response"
  | "unusable-content"
  | "local-edit-superseded"
  | "authority-changed"
  | "authority-unavailable"
  | "provenance-write-failed";

export function decideStaleResponseRecovery(
  unusableDomains: Array<{ reason: UnusableDomainReason }>
): "retry" | "no-retry" {
  if (unusableDomains.length === 0) return "no-retry";
  // SH.2.6 P1 — "unusable-content" (a 200 response with a valid revision
  // but unreadable/unexpected plannerJson — see resolvePostFetchDomainBaseline's
  // own doc) is DELIBERATELY EXCLUDED from the always-safe retry set below,
  // for the same reason "unusable-response" already is: nothing about why
  // the content was unusable is revision-related, so blindly retrying this
  // same pull is not guaranteed to produce a readable response either — it
  // falls through to the default "no-retry" (fail closed) just like
  // "unusable-response" already does.
  // SH.2.2 — "local-edit-superseded" (a commit-time CAS supersession by a
  // genuine local edit) and "authority-changed" (a commit-time confirmed-
  // authority identity mismatch — see this section's own "CODEX P1 THIRD
  // FOLLOW-UP ROUND" doc above) are, like "stale-response", always safe to
  // retry on their own: the true current state is already durably known to
  // this device. Mixed with any of these three alone, or with each other,
  // the whole set stays retry-eligible; mixed with a "conflict" or
  // "unusable-response" anywhere in the set, it stays fail-closed —
  // unchanged from SH.2.1's own rule, just widened to recognize each new
  // always-safe reason as it was added. "authority-unavailable" (this
  // round's "make confirmed-authority scans atomic" fix) is deliberately
  // EXCLUDED from the always-safe set above — falls through to the default
  // "no-retry" below — since it reflects a permanent environment limitation
  // (no Web Locks), which a fresh pull cannot fix. "provenance-write-failed"
  // (the "authority vs. hydration-provenance" round) is EXCLUDED for the
  // same reason: a real I/O exception or a genuine cross-tab confirmed-fact
  // conflict is not something blindly retrying this same pull can resolve.
  return unusableDomains.every(
    (d) => d.reason === "stale-response" || d.reason === "local-edit-superseded" || d.reason === "authority-changed"
  )
    ? "retry"
    : "no-retry";
}

/**
 * Reference cases for decideStaleResponseRecovery() — the REQUIRED cases
 * from the SH.2.1 (this round, and the stale-response-retry round before
 * it) architectural contract. Run from Node:
 *   import { DEV_DECIDE_STALE_RESPONSE_RECOVERY_CASES, decideStaleResponseRecovery } from "@/lib/syncPayload";
 *   DEV_DECIDE_STALE_RESPONSE_RECOVERY_CASES.forEach(c => {
 *     const got = decideStaleResponseRecovery(c.unusableDomains);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_DECIDE_STALE_RESPONSE_RECOVERY_CASES: Array<{
  name: string;
  unusableDomains: Array<{ reason: UnusableDomainReason }>;
  expected: "retry" | "no-retry";
}> = [
  {
    name: "required case 1 — a single stale-response domain (rev7 rejected in favor of confirmed rev8): retry",
    unusableDomains: [{ reason: "stale-response" }],
    expected: "retry",
  },
  {
    name: "all unusable domains stale-response (plans+lightning+days all stale together): retry",
    unusableDomains: [{ reason: "stale-response" }, { reason: "stale-response" }, { reason: "stale-response" }],
    expected: "retry",
  },
  {
    name: "required case 6 — a conflicted ('gated') domain must NEVER auto-retry via this mechanism, even alone",
    unusableDomains: [{ reason: "conflict" }],
    expected: "no-retry",
  },
  {
    name: "required case 6 — ANY conflicted domain blocks retry even when every other domain is merely stale-response — conflict recovery has its own separate contract, never silently inherited",
    unusableDomains: [{ reason: "stale-response" }, { reason: "conflict" }],
    expected: "no-retry",
  },
  {
    name: "required case 3 — a structurally unusable response (this pull's own GET carried no usable revision at all) must NEVER auto-retry, even alone: retrying cannot help and would repeat the same unusable GET indefinitely",
    unusableDomains: [{ reason: "unusable-response" }],
    expected: "no-retry",
  },
  {
    name: "required case 4 — an unusable-response domain blocks retry even when every other domain is merely stale-response (confirmed facts present elsewhere does not make THIS domain's unusable response safe to retry)",
    unusableDomains: [{ reason: "stale-response" }, { reason: "unusable-response" }],
    expected: "no-retry",
  },
  {
    name: "no unusable domains — nothing to recover from",
    unusableDomains: [],
    expected: "no-retry",
  },
  {
    name: "SH.2.2 required case — a single local-edit-superseded domain (commit-time CAS lost to a genuine local edit): retry",
    unusableDomains: [{ reason: "local-edit-superseded" }],
    expected: "retry",
  },
  {
    name: "SH.2.2 — multiple domains all local-edit-superseded (items+days+lightning all raced a local edit in one pull): retry",
    unusableDomains: [
      { reason: "local-edit-superseded" },
      { reason: "local-edit-superseded" },
      { reason: "local-edit-superseded" },
    ],
    expected: "retry",
  },
  {
    name: "SH.2.2 — mixed stale-response (confirmed authority advanced) + local-edit-superseded (a different domain raced a local edit) in the SAME pull: still retry, both reasons are independently always-safe",
    unusableDomains: [{ reason: "stale-response" }, { reason: "local-edit-superseded" }],
    expected: "retry",
  },
  {
    name: "SH.2.2 — a local-edit-superseded domain must NEVER make an unrelated conflict retry-eligible: a real conflict elsewhere still blocks the whole pull",
    unusableDomains: [{ reason: "local-edit-superseded" }, { reason: "conflict" }],
    expected: "no-retry",
  },
  {
    name: "SH.2.2 — a local-edit-superseded domain must NEVER make an unrelated unusable-response retry-eligible",
    unusableDomains: [{ reason: "local-edit-superseded" }, { reason: "unusable-response" }],
    expected: "no-retry",
  },
  {
    name: "SH.2.2 third follow-up required case — a single authority-changed domain (winner selected against rev5, confirmed authority moved to rev6 during the lock wait): retry",
    unusableDomains: [{ reason: "authority-changed" }],
    expected: "retry",
  },
  {
    name: "SH.2.2 third follow-up — multiple domains all authority-changed in one pull: retry",
    unusableDomains: [{ reason: "authority-changed" }, { reason: "authority-changed" }, { reason: "authority-changed" }],
    expected: "retry",
  },
  {
    name: "SH.2.2 third follow-up — mixed authority-changed + local-edit-superseded + stale-response in the SAME pull: still retry, all three reasons are independently always-safe",
    unusableDomains: [{ reason: "authority-changed" }, { reason: "local-edit-superseded" }, { reason: "stale-response" }],
    expected: "retry",
  },
  {
    name: "SH.2.2 third follow-up — an authority-changed domain must NEVER make an unrelated conflict retry-eligible",
    unusableDomains: [{ reason: "authority-changed" }, { reason: "conflict" }],
    expected: "no-retry",
  },
  {
    name: "SH.2.2 third follow-up — an authority-changed domain must NEVER make an unrelated unusable-response retry-eligible",
    unusableDomains: [{ reason: "authority-changed" }, { reason: "unusable-response" }],
    expected: "no-retry",
  },
  {
    name: "SH.2.2 'make confirmed-authority scans atomic' round — a single authority-unavailable domain (Web Locks absent, atomic read could not be performed) must NEVER auto-retry, even alone: this is a permanent environment limitation, not a transient race",
    unusableDomains: [{ reason: "authority-unavailable" }],
    expected: "no-retry",
  },
  {
    name: "SH.2.2 atomic-scans round — an authority-unavailable domain blocks retry even when every other domain is merely authority-changed/stale-response/local-edit-superseded (all otherwise-safe reasons)",
    unusableDomains: [
      { reason: "authority-unavailable" },
      { reason: "authority-changed" },
      { reason: "stale-response" },
      { reason: "local-edit-superseded" },
    ],
    expected: "no-retry",
  },
  {
    name: "SH.2.2 authority-vs-provenance round — a single provenance-write-failed domain (confirmed-fact or hydration-provenance write did not durably succeed) must NEVER auto-retry, even alone",
    unusableDomains: [{ reason: "provenance-write-failed" }],
    expected: "no-retry",
  },
  {
    name: "SH.2.2 authority-vs-provenance round — a provenance-write-failed domain blocks retry even when every other domain is merely authority-changed/stale-response/local-edit-superseded",
    unusableDomains: [
      { reason: "provenance-write-failed" },
      { reason: "authority-changed" },
      { reason: "stale-response" },
      { reason: "local-edit-superseded" },
    ],
    expected: "no-retry",
  },
  {
    name: "SH.2.6 P1 required — a single unusable-content domain (200 with a valid revision but unreadable plannerJson) must NEVER auto-retry, even alone: nothing about why the content was unusable is revision-related",
    unusableDomains: [{ reason: "unusable-content" }],
    expected: "no-retry",
  },
  {
    name: "SH.2.6 P1 — an unusable-content domain blocks retry even when every other domain is merely stale-response/local-edit-superseded/authority-changed (all otherwise-safe reasons)",
    unusableDomains: [
      { reason: "unusable-content" },
      { reason: "stale-response" },
      { reason: "local-edit-superseded" },
      { reason: "authority-changed" },
    ],
    expected: "no-retry",
  },
];

// ===== HYDRATION NOOP SAFETY (SH.2.1, this round) =====
//
// Codex found that commitLocalDomainRaw() (syncHelper.ts) — the CAS/lock
// primitive every pull's hydration commit uses — could report "noop"
// whenever canonical bytes already equalled the hydration winner, even
// when a surviving, unresolved local-edit fact still held a genuinely
// DIFFERENT value. `decideLocalDomainCommit()`'s own "noop" branch only
// ever proved a byte-level fact (canonical === nextRaw); it was never
// asked whether DURABLE AUTHORITY (canonical + facts) also agreed.
// Reporting that byte-level coincidence as a safe "noop" let hydration
// count as successful (isLocalDomainCommitSuccess treats noop and
// committed identically) while leaving the stale fact fully intact and
// unretired — durably authoritative for the next readLatestDurableValue()
// read, and capable of later being pushed back over the very cloud state
// this pull just recorded as confirmed.
//
// The fix (commitLocalDomainRaw()'s own doc in syncHelper.ts has the full
// rationale) adds ONE more check, reached only on a byte-level "noop": ask
// resolveEffectiveDurableRaw() — the SAME shared resolver every other
// durable-authority decision in this codebase uses, never a competing
// interpretation — whether canonical + this decision's OWN
// baselineEditFactIds frontier already agrees with nextRaw. Agreement
// keeps the fast "noop" path; disagreement falls through to the EXACT
// SAME write-and-retire path a genuine "write" decision already took
// (including its own re-scan for a fact that lands AFTER the snapshot,
// which still reports "superseded" — untouched by this fix).
//
// The cases below model that exact two-step decision purely — real
// resolveEffectiveDurableRaw() calls, plus the same frontier-membership
// check commitLocalDomainRaw()'s own re-scan performs — reduced to
// commitLocalDomainRaw()'s actual inputs/outputs, not a reimplementation.
export type HydrationNoopSafetyOutcome = "noop" | "committed" | "superseded";

/**
 * Reference cases for commitLocalDomainRaw()'s hydration-noop-safety
 * decision — the REQUIRED cases from the SH.2.1 (this round) architectural
 * contract. Deliberately NOT a new production function: the real decision
 * stays inline in commitLocalDomainRaw() (syncHelper.ts) per this round's
 * "fix centrally in the existing primitive" instruction. This composes the
 * SAME real resolveEffectiveDurableRaw() production primitive the fix
 * itself calls, plus the same frontier-membership condition
 * commitLocalDomainRaw()'s own re-scan already checks — reduced to that
 * function's actual inputs/outputs, not a reimplementation. Run from Node:
 *   import { DEV_HYDRATION_NOOP_SAFETY_CASES, resolveEffectiveDurableRaw } from "@/lib/syncPayload";
 *   DEV_HYDRATION_NOOP_SAFETY_CASES.forEach(c => {
 *     const effectiveDurableRaw = resolveEffectiveDurableRaw(c.canonicalRaw, c.baselineFactRawValues);
 *     const got = effectiveDurableRaw === c.nextRaw ? "noop" : (c.liveFactKeysGrew ? "superseded" : "committed");
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_HYDRATION_NOOP_SAFETY_CASES: Array<{
  name: string;
  canonicalRaw: string | null;
  baselineFactRawValues: string[];
  nextRaw: string;
  liveFactKeysGrew: boolean;
  expected: HydrationNoopSafetyOutcome;
}> = [
  {
    name: "required case 4 — canonical=A, no surviving facts, hydration wants A: durable authority already agrees, safe noop",
    canonicalRaw: "A",
    baselineFactRawValues: [],
    nextRaw: "A",
    liveFactKeysGrew: false,
    expected: "noop",
  },
  {
    name: "required case 5 — canonical=A, surviving fact=B, hydration wants A: durable authority (B) disagrees — must NOT report a safe noop that leaves B authoritative; commits (idempotent canonical rewrite) and retires B",
    canonicalRaw: "A",
    baselineFactRawValues: ["B"],
    nextRaw: "A",
    liveFactKeysGrew: false,
    expected: "committed",
  },
  {
    name: "required case 6 — same as required case 5, but a NEW conflicting fact (C) lands after this commit's own baseline snapshot: the conflicting frontier is NOT safe to retire — reports superseded, exactly like a genuine 'write' decision would, so C is never touched",
    canonicalRaw: "A",
    baselineFactRawValues: ["B"],
    nextRaw: "A",
    liveFactKeysGrew: true,
    expected: "superseded",
  },
  {
    name: "fact exactly matches the hydration winner already — genuinely redundant, safe noop (structural rule, not a value comparison coincidence)",
    canonicalRaw: "A",
    baselineFactRawValues: ["A"],
    nextRaw: "A",
    liveFactKeysGrew: false,
    expected: "noop",
  },
  {
    name: "ambiguous 2-fact tie falls back to canonical for this decision too — ANY conflicting fact resolution defers to the established resolveEffectiveDurableRaw() tie-break, never a special case here",
    canonicalRaw: "A",
    baselineFactRawValues: ["B", "C"],
    nextRaw: "A",
    liveFactKeysGrew: false,
    expected: "noop",
  },
  {
    name: "required case 7 (Plans/Lightning/days symmetry) — a days[]-shaped payload (JSON array raw string) goes through the identical decision: surviving fact disagrees, commits and retires, same as the Plans/Lightning-shaped cases above",
    canonicalRaw: JSON.stringify(["day-1", "day-2"]),
    baselineFactRawValues: [JSON.stringify(["day-1", "day-2", "day-3"])],
    nextRaw: JSON.stringify(["day-1", "day-2"]),
    liveFactKeysGrew: false,
    expected: "committed",
  },
];

// ===== COMMIT-TIME AUTHORITY GATE ORDER (SH.2.2, Codex P1 follow-up +
// second follow-up rounds) =====
//
// Codex found that SH.2.2's original commit-time revalidation ran ONLY at
// the page level, BEFORE calling commitLocalDomainRaw() — but that
// function can then itself wait on the Web Lock (navigator.locks.request())
// if another writer (this tab's own concurrent commit, or another tab's)
// currently holds this key's lock. Confirmed authority can advance DURING
// that wait (an already-in-flight push resolves and confirms a newer
// revision) without ever touching this key's canonical bytes — so the
// raw-value CAS still passes — and without advancing the pull epoch — so a
// caller's own `isStillValid` (isPullContextCurrent) still passes too.
// Neither existing gate can observe a page-level-only pre-check's own blind
// spot: the LOCK WAIT ITSELF, which only commitLocalDomainRaw() can see.
//
// The FIRST follow-up round added `isAuthorityStillValid` as a FIFTH
// commitLocalDomainRaw() parameter, checked INSIDE the lock — but only on
// the path to a "committed" return; a "noop" (canonical bytes already
// equal `nextRaw`) still returned immediately, bypassing `isStillValid`,
// the edit-fact re-scan, AND `isAuthorityStillValid` entirely. Since
// isLocalDomainCommitSuccess() treats "noop" and "committed" identically,
// this let a stale pull be reported successful — reopening syncReady and
// continuing from an obsolete server revision — purely because the bytes
// it wanted to write already happened to already be on disk.
//
// The SECOND follow-up round (modeled below) closes this: a "noop"
// verdict (`decideLocalDomainCommit()` says "noop" AND
// resolveEffectiveDurableRaw() agrees with `nextRaw`) now only sets a flag
// (`isSafeNoop`) — it does NOT return early. The corrected gate order,
// evaluated UNCONDITIONALLY on the path to ANY success return ("noop" OR
// "committed"): canonical CAS ("superseded") -> compute `isSafeNoop` (never
// returns) -> `isStillValid` ("aborted") -> edit-fact re-scan
// ("superseded") -> `isAuthorityStillValid` ("authority-superseded") ->
// `isSafeNoop`? ("noop") : write + retire ("committed"). A genuine local
// edit or a stale pull/auth/profile context still wins over a commit-time
// authority regression, and BOTH still win over a would-be noop being
// reported as success (required cases 1, 3, 4) — never the reverse.
// "authority-superseded" is a DISTINCT status from "superseded" (see
// LocalDomainCommitStatus in syncHelper.ts) — never conflated — so a
// caller can still log/report which kind of commit-time race actually
// happened, even though both route through the SAME SH.2.2 one-shot
// recovery decision once resolved back at the page level (a fresh
// revalidateAuthorityBeforeCommit() re-scan for "authority-superseded",
// reusing the already-established "stale-response"/"conflict"/
// "unusable-response" reasons; decideStaleResponseRecovery()'s
// "local-edit-superseded" reason above for a genuine CAS "superseded").
// Retirement of edit facts happens ONLY on the actual "committed" write —
// never on "noop" (genuine or otherwise unaffected by this round), and the
// authority check itself never reads/writes/retires any edit fact — it is
// a pure boolean gate, identical in shape to `isStillValid`.
//
// The cases below model the EXACT gate sequence commitLocalDomainRaw()
// evaluates — composing the SAME real decideLocalDomainCommit()/
// resolveEffectiveDurableRaw() production primitives for the canonical-CAS
// and noop-safety gates (unchanged, untouched by this round), plus the
// THREE caller-supplied boolean predicates
// (isStillValid/editFactGrew/isAuthorityStillValid) commitLocalDomainRaw()
// itself receives as closures — reduced to the exact order that function
// evaluates them in, never a reimplementation of the decision. Deliberately
// NOT a new production function, matching the SAME "fix centrally in the
// existing primitive" precedent the HYDRATION NOOP SAFETY cases above
// already established.
export type CommitTimeGateOutcome = "noop" | "committed" | "superseded" | "authority-superseded" | "aborted";

/**
 * Reference cases for commitLocalDomainRaw()'s full gate sequence,
 * INCLUDING the SH.2.2 Codex P1 follow-up round's `isAuthorityStillValid`
 * gate and the second follow-up round's fix (a "noop" verdict is no longer
 * an early exit that bypasses it) — the REQUIRED cases from both rounds'
 * architectural contract. Run from Node:
 *   import { DEV_COMMIT_TIME_AUTHORITY_GATE_CASES, decideLocalDomainCommit, resolveEffectiveDurableRaw } from "@/lib/syncPayload";
 *   DEV_COMMIT_TIME_AUTHORITY_GATE_CASES.forEach(c => {
 *     let got;
 *     const decision = decideLocalDomainCommit(c.currentRaw, c.expectedPreviousRaw, c.nextRaw);
 *     if (decision === "superseded") {
 *       got = "superseded";
 *     } else {
 *       const isSafeNoop =
 *         decision === "noop" && resolveEffectiveDurableRaw(c.currentRaw, c.baselineFactRawValues) === c.nextRaw;
 *       if (!c.isStillValid) got = "aborted";
 *       else if (c.editFactGrew) got = "superseded";
 *       else if (!c.isAuthorityStillValid) got = "authority-superseded";
 *       else got = isSafeNoop ? "noop" : "committed";
 *     }
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_COMMIT_TIME_AUTHORITY_GATE_CASES: Array<{
  name: string;
  currentRaw: string | null;
  expectedPreviousRaw: string | null;
  nextRaw: string;
  baselineFactRawValues: string[];
  isStillValid: boolean;
  editFactGrew: boolean;
  isAuthorityStillValid: boolean;
  expected: CommitTimeGateOutcome;
}> = [
  {
    name: "required case 1 — bytes already on disk are noop-eligible (rev7 winner), but confirmed rev8 lands while this commit waits for the lock: NOT reported as noop — authority-superseded instead, so the caller's page-level pull effect schedules exactly one fresh replacement pull",
    currentRaw: "REV7-WINNER",
    expectedPreviousRaw: "REV7-WINNER",
    nextRaw: "REV7-WINNER",
    baselineFactRawValues: [],
    isStillValid: true,
    editFactGrew: false,
    isAuthorityStillValid: false,
    expected: "authority-superseded",
  },
  {
    name: "required case 2 — authority unchanged while waiting for the lock, effective durable value already equals nextRaw: safe noop",
    currentRaw: "REV7-WINNER",
    expectedPreviousRaw: "REV7-WINNER",
    nextRaw: "REV7-WINNER",
    baselineFactRawValues: [],
    isStillValid: true,
    editFactGrew: false,
    isAuthorityStillValid: true,
    expected: "noop",
  },
  {
    name: "required case 3 — a genuine local edit lands while waiting for the lock (edit-fact keyspace grew) for what would otherwise be a safe noop, AND authority also went stale in the SAME window: the existing local-edit supersession still takes precedence — reported as 'superseded', never 'noop' or 'authority-superseded', and the edit itself survives untouched (this gate only compares key sets, it never retires anything)",
    currentRaw: "REV7-WINNER",
    expectedPreviousRaw: "REV7-WINNER",
    nextRaw: "REV7-WINNER",
    baselineFactRawValues: [],
    isStillValid: true,
    editFactGrew: true,
    isAuthorityStillValid: false,
    expected: "superseded",
  },
  {
    name: "required case 4 — auth/profile/pull context goes stale while waiting for the lock, for what would otherwise be a safe noop: aborted — no success and no retry scheduled from the old context (isStillValid is checked before isAuthorityStillValid is ever consulted)",
    currentRaw: "REV7-WINNER",
    expectedPreviousRaw: "REV7-WINNER",
    nextRaw: "REV7-WINNER",
    baselineFactRawValues: [],
    isStillValid: false,
    editFactGrew: false,
    isAuthorityStillValid: false,
    expected: "aborted",
  },
  {
    name: "canonical CAS still takes absolute priority over a would-be noop — a genuinely different canonical value already on disk reports 'superseded' before isStillValid/editFactGrew/isAuthorityStillValid are ever consulted, exactly as before this round",
    currentRaw: "SOMEONE-ELSES-NEWER-VALUE",
    expectedPreviousRaw: "REV7-WINNER",
    nextRaw: "REV7-WINNER",
    baselineFactRawValues: [],
    isStillValid: true,
    editFactGrew: false,
    isAuthorityStillValid: false,
    expected: "superseded",
  },
  {
    name: "required case 5 — actual persistence failure behavior unaffected by this round: a genuine WRITE decision (canonical bytes differ from nextRaw) with authority stale reports authority-superseded, symmetric with the noop case above — this was already correct in the first follow-up round",
    currentRaw: "DISK-BYTES",
    expectedPreviousRaw: "DISK-BYTES",
    nextRaw: "REV7-WINNER",
    baselineFactRawValues: [],
    isStillValid: true,
    editFactGrew: false,
    isAuthorityStillValid: false,
    expected: "authority-superseded",
  },
  {
    name: "no authority change + a genuine WRITE decision: normal commit succeeds, unchanged from before this round",
    currentRaw: "DISK-BYTES",
    expectedPreviousRaw: "DISK-BYTES",
    nextRaw: "REV7-WINNER",
    baselineFactRawValues: [],
    isStillValid: true,
    editFactGrew: false,
    isAuthorityStillValid: true,
    expected: "committed",
  },
  {
    name: "HYDRATION NOOP MUST NOT OUTRANK A SURVIVING FACT still holds, unaffected by this round — a byte-level noop with a genuinely disagreeing surviving fact falls through to the write-and-retire path (idempotent canonical rewrite + fact retirement) even with authority valid, since it was never a SAFE noop to begin with",
    currentRaw: "A",
    expectedPreviousRaw: "A",
    nextRaw: "A",
    baselineFactRawValues: ["B"],
    isStillValid: true,
    editFactGrew: false,
    isAuthorityStillValid: true,
    expected: "committed",
  },
  {
    name: "required case 6 (Plans/Lightning/days symmetry) — a days[]-shaped noop-eligible payload goes through the identical corrected gate order: authority regression at the last gate still reports authority-superseded, never a stale noop",
    currentRaw: JSON.stringify(["day-1", "day-2"]),
    expectedPreviousRaw: JSON.stringify(["day-1", "day-2"]),
    nextRaw: JSON.stringify(["day-1", "day-2"]),
    baselineFactRawValues: [],
    isStillValid: true,
    editFactGrew: false,
    isAuthorityStillValid: false,
    expected: "authority-superseded",
  },
  {
    name: "required case 6 (Plans/Lightning/days symmetry) — the SAME days[]-shaped payload with authority still valid: safe noop, exactly like the Plans/Lightning-shaped case above",
    currentRaw: JSON.stringify(["day-1", "day-2"]),
    expectedPreviousRaw: JSON.stringify(["day-1", "day-2"]),
    nextRaw: JSON.stringify(["day-1", "day-2"]),
    baselineFactRawValues: [],
    isStillValid: true,
    editFactGrew: false,
    isAuthorityStillValid: true,
    expected: "noop",
  },
];


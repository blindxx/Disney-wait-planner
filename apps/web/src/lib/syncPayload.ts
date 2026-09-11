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
}

// Canonical day ID shape, matching plans/page.tsx's VALID_DAY_ID_RE.
const DAY_ID_RE = /^day-[1-9]\d*$/;

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

// ===== BUILDERS =====

export function buildSyncedPlannerPayload(
  plans: { version: number; items: unknown[] },
  lightning: { version: number; items: unknown[] },
  // Accepts unknown[] (not just string[]) since sanitizeDaysOrder() below
  // filters/validates at runtime anyway — callers can pass a raw parsed
  // localStorage value without pre-validating it themselves.
  days?: unknown[]
): SyncedPlannerPayload {
  const sanitizedDays = sanitizeDaysOrder(days);
  return sanitizedDays
    ? { version: 1, plans, lightning, days: sanitizedDays }
    : { version: 1, plans, lightning };
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

  return {
    version: 1,
    plans: { version: plans.version as number, items: plans.items as unknown[] },
    lightning: { version: lightning.version as number, items: lightning.items as unknown[] },
    ...(days ? { days } : {}),
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
 * Reference cases for parseConfirmedPlannerDomainFact()/parseConfirmedDaysFact().
 * Run from Node:
 *   import { DEV_PARSE_CONFIRMED_FACT_CASES, parseConfirmedPlannerDomainFact, parseConfirmedDaysFact } from "@/lib/syncPayload";
 *   DEV_PARSE_CONFIRMED_FACT_CASES.forEach(c => {
 *     const parse = c.domain === "days" ? parseConfirmedDaysFact : parseConfirmedPlannerDomainFact;
 *     const got = parse(c.raw);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_PARSE_CONFIRMED_FACT_CASES: Array<{
  name: string;
  domain: "plannerDomain" | "days";
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
 * SH.3 appends "dayMeta" | "dayParks" | "dayAutoFallbacks" here (plus a
 * matching parseSyncedPlannerPayload extraction for each) to make them
 * synced domains — no other change to mergePlannerDomains() is needed to
 * support that: see the function's own doc for why.
 */
const OPTIONAL_DOMAIN_KEYS = ["days"] as const;

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
 *     server build has never heard of (e.g. a future SH.3 `dayMeta` domain
 *     written by a newer client, then this same profile receiving a write
 *     from an old client whose payload structurally has no `dayMeta`
 *     field at all) — survives untouched via the initial object spread.
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
    name: "unknown future domain (dayMeta) in existing row survives an old-client write that omits it entirely",
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
    name: "known-only payload (version + plans + lightning + days) — nothing unknown",
    incomingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
    },
    expectedUnknown: [],
  },
  {
    name: "known-only payload without optional days — still nothing unknown",
    incomingRaw: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
    expectedUnknown: [],
  },
  {
    name: "newer-client payload carrying an unrecognized extension domain — must be flagged, never silently dropped",
    incomingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      days: ["day-1"],
      dayMeta: { "day-1": { label: "Arrival" } },
    },
    expectedUnknown: ["dayMeta"],
  },
  {
    name: "multiple unrecognized domains in one write — all flagged",
    incomingRaw: {
      version: 1,
      plans: { version: 1, items: [] },
      lightning: { version: 1, items: [] },
      dayParks: { "day-1": "DISNEYLAND_PARK" },
      dayAutoFallbacks: {},
    },
    expectedUnknown: ["dayParks", "dayAutoFallbacks"],
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
 * The fix replaces that single dual-purpose function with two separate,
 * explicitly-named, pure functions — one per causal stage — so neither
 * stage's behavior can ever again be inferred from an optional parameter or
 * a condition that happens to be unreachable:
 *
 *   • resolvePreFetchDomainBaseline() — STAGE 1. Takes NO cloudRevision
 *     parameter at all — there structurally isn't one yet. A conflicted
 *     domain can only ever resolve to "gated" here, never "recovered": this
 *     is a property of the function's own signature, not a value that
 *     merely happens to be null. `diskValue` is supplied by the caller as a
 *     plain, already-taken read — captured UNCONDITIONALLY, regardless of
 *     this domain's confirmed status, because whether it will be NEEDED (a
 *     later repair) cannot be known until stage 2 runs.
 *
 *   • resolvePostFetchDomainBaseline() — STAGE 2. Takes the now-known
 *     `cloudRevision` and this SAME pull's stage-1 `DomainPreFetchSnapshot`
 *     as a REQUIRED parameter — never optional, because stage 1 always runs
 *     first, synchronously, for every pull, so a stage-2 call always has
 *     exactly one to pass. A conflicted domain repairable by `cloudRevision`
 *     resolves to "recovered", reusing the FROZEN `diskValue` from stage 1 —
 *     never a fresh disk read taken at this point, which would already have
 *     absorbed any edit that landed DURING the fetch, erasing the very
 *     signal recovery needs to tell "pre-existing uncertain bytes" apart
 *     from "a genuine local edit made mid-recovery".
 *
 * Both stages funnel through the SAME `DomainBaselineOutcome<T>`
 * discriminated union, so a "gated" domain's absence of a `value` field is
 * enforced by the type system: a caller cannot accidentally read `.value`
 * off a gated outcome and consume it as a real baseline — TypeScript
 * refuses to narrow it without an explicit `kind` check first. See this
 * section's own DEV_* cases below, and plans/page.tsx's/lightning/
 * page.tsx's pull effect, for the per-domain narrowing every consumer must
 * perform before any outcome's `.value` is used.
 */
export type DomainBaselineOutcome<T> =
  | { kind: "confirmed"; value: T }
  | { kind: "recovered"; value: T; revision: number }
  | { kind: "gated"; revision: number }
  | { kind: "fallback"; value: T };

/**
 * STAGE 1 output for one domain — this pull's frozen pre-fetch snapshot.
 * `diskValue` is the real on-disk value at the moment this was captured
 * (always a genuine read the caller took just before calling this
 * function, never a ref, never a placeholder). `outcome` is this domain's
 * stage-1 baseline decision — see resolvePreFetchDomainBaseline()'s own
 * doc for why it can only ever be "confirmed", "gated", or "fallback", and
 * never "recovered", at this stage.
 */
export interface DomainPreFetchSnapshot<T> {
  diskValue: T;
  outcome: DomainBaselineOutcome<T>;
}

/**
 * STAGE 1 (pre-fetch) — see this section's own module doc above. Called
 * once per domain, synchronously, before a pull's fetch is even issued.
 * `diskValue` must be a fresh read taken by the caller right before this
 * call — this function never reads storage itself, keeping it pure and
 * trivially testable. `fallbackValue` is the domain's own baseline-ref
 * value (or a neutral value under a content-ownership mismatch — the
 * caller's own decision, unrelated to conflict/recovery authority), used
 * only when there is no confirmed fact for this domain yet.
 */
export function resolvePreFetchDomainBaseline<Raw, T>(
  confirmed: ConfirmedDomainResult<Raw>,
  mapConfirmedValue: (raw: Raw) => T,
  diskValue: T,
  fallbackValue: T
): DomainPreFetchSnapshot<T> {
  if (confirmed.status === "confirmed") {
    return { diskValue, outcome: { kind: "confirmed", value: mapConfirmedValue(confirmed.fact.value) } };
  }
  if (confirmed.status === "conflict") {
    return { diskValue, outcome: { kind: "gated", revision: confirmed.revision } };
  }
  return { diskValue, outcome: { kind: "fallback", value: fallbackValue } };
}

/**
 * STAGE 2 (post-fetch) — see this section's own module doc above. Called
 * once this pull's authoritative server response is known: `cloudRevision`
 * is that response's own `revision`, or `null` for a 204/unparseable
 * response — never repairable either way (isConflictRepairableByRevision's
 * own contract). `preFetch` MUST be this SAME pull's own stage-1 result for
 * this SAME domain — never re-derived, never borrowed from a different
 * pull or a different domain. `confirmed` is a fresh (or reused, at the
 * caller's discretion) ConfirmedDomainResult read for this domain —
 * whether to re-read it fresh at this point vs. reuse stage 1's own read is
 * a pull-level policy decision that belongs to the caller (see
 * plans/page.tsx's/lightning/page.tsx's own doc on why an unrelated race
 * elsewhere must not silently override this pull's own frozen view).
 */
export function resolvePostFetchDomainBaseline<Raw, T>(
  confirmed: ConfirmedDomainResult<Raw>,
  cloudRevision: number | null,
  mapConfirmedValue: (raw: Raw) => T,
  preFetch: DomainPreFetchSnapshot<T>,
  fallbackValue: T
): DomainBaselineOutcome<T> {
  if (confirmed.status === "confirmed") {
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
 * Reference cases for resolvePreFetchDomainBaseline() — run from Node:
 *   import { DEV_RESOLVE_PRE_FETCH_DOMAIN_BASELINE_CASES, resolvePreFetchDomainBaseline } from "@/lib/syncPayload";
 *   DEV_RESOLVE_PRE_FETCH_DOMAIN_BASELINE_CASES.forEach(c => {
 *     const got = resolvePreFetchDomainBaseline(c.confirmed, (raw) => raw, c.diskValue, c.fallbackValue);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_RESOLVE_PRE_FETCH_DOMAIN_BASELINE_CASES: Array<{
  name: string;
  confirmed: ConfirmedDomainResult<string>;
  diskValue: string;
  fallbackValue: string;
  expected: DomainPreFetchSnapshot<string>;
}> = [
  {
    name: "normal confirmed baseline — confirmed value used, disk still captured untouched",
    confirmed: { status: "confirmed", fact: { revision: 5, value: "CLOUD-V5" } },
    diskValue: "DISK-BYTES",
    fallbackValue: "FALLBACK-REF",
    expected: { diskValue: "DISK-BYTES", outcome: { kind: "confirmed", value: "CLOUD-V5" } },
  },
  {
    name: "no confirmed baseline yet — falls back to the caller's own fallback value",
    confirmed: { status: "none" },
    diskValue: "DISK-BYTES",
    fallbackValue: "FALLBACK-REF",
    expected: { diskValue: "DISK-BYTES", outcome: { kind: "fallback", value: "FALLBACK-REF" } },
  },
  {
    name: "required — conflicted domain pre-fetch always gates (no cloudRevision parameter exists at this stage to repair with)",
    confirmed: { status: "conflict", revision: 6 },
    diskValue: "DISK-BYTES",
    fallbackValue: "FALLBACK-REF",
    expected: { diskValue: "DISK-BYTES", outcome: { kind: "gated", revision: 6 } },
  },
  {
    name: "required — diskValue is captured UNCONDITIONALLY even while gated (this is the actual P1 fix: stage 1 never skips the fresh disk read merely because repair isn't attemptable yet)",
    confirmed: { status: "conflict", revision: 9 },
    diskValue: "FROZEN-PRE-FETCH-BYTES",
    fallbackValue: "FALLBACK-REF",
    expected: { diskValue: "FROZEN-PRE-FETCH-BYTES", outcome: { kind: "gated", revision: 9 } },
  },
];

/**
 * Reference cases for resolvePostFetchDomainBaseline() — run from Node:
 *   import { DEV_RESOLVE_POST_FETCH_DOMAIN_BASELINE_CASES, resolvePostFetchDomainBaseline } from "@/lib/syncPayload";
 *   DEV_RESOLVE_POST_FETCH_DOMAIN_BASELINE_CASES.forEach(c => {
 *     const got = resolvePostFetchDomainBaseline(c.confirmed, c.cloudRevision, (raw) => raw, c.preFetch, c.fallbackValue);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_RESOLVE_POST_FETCH_DOMAIN_BASELINE_CASES: Array<{
  name: string;
  confirmed: ConfirmedDomainResult<string>;
  cloudRevision: number | null;
  preFetch: DomainPreFetchSnapshot<string>;
  fallbackValue: string;
  expected: DomainBaselineOutcome<string>;
}> = [
  {
    name: "normal confirmed baseline — confirmed value wins outright, cloudRevision irrelevant",
    confirmed: { status: "confirmed", fact: { revision: 5, value: "CLOUD-V5" } },
    cloudRevision: 5,
    preFetch: { diskValue: "DISK-BYTES", outcome: { kind: "confirmed", value: "CLOUD-V5" } },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "confirmed", value: "CLOUD-V5" },
  },
  {
    name: "no confirmed baseline — falls back exactly as stage 1 did",
    confirmed: { status: "none" },
    cloudRevision: 7,
    preFetch: { diskValue: "DISK-BYTES", outcome: { kind: "fallback", value: "FALLBACK-REF" } },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "fallback", value: "FALLBACK-REF" },
  },
  {
    name: "required — conflict + equal revision — never recovers from an equal response, stays gated",
    confirmed: { status: "conflict", revision: 6 },
    cloudRevision: 6,
    preFetch: { diskValue: "FROZEN-PRE-FETCH-BYTES", outcome: { kind: "gated", revision: 6 } },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "gated", revision: 6 },
  },
  {
    name: "required — conflict + older revision — never falls back to an older confirmed revision, stays gated",
    confirmed: { status: "conflict", revision: 6 },
    cloudRevision: 5,
    preFetch: { diskValue: "FROZEN-PRE-FETCH-BYTES", outcome: { kind: "gated", revision: 6 } },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "gated", revision: 6 },
  },
  {
    name: "conflict + no usable candidate revision (204/unparseable) — stays gated",
    confirmed: { status: "conflict", revision: 6 },
    cloudRevision: null,
    preFetch: { diskValue: "FROZEN-PRE-FETCH-BYTES", outcome: { kind: "gated", revision: 6 } },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "gated", revision: 6 },
  },
  {
    name: "required — conflict + strictly newer revision recovers, reusing the FROZEN stage-1 disk snapshot, never a value from anywhere else (the actual P1 regression test: prior code reused a stale fallback ref here instead)",
    confirmed: { status: "conflict", revision: 6 },
    cloudRevision: 7,
    preFetch: { diskValue: "FROZEN-PRE-FETCH-BYTES", outcome: { kind: "gated", revision: 6 } },
    fallbackValue: "FALLBACK-REF",
    expected: { kind: "recovered", value: "FROZEN-PRE-FETCH-BYTES", revision: 7 },
  },
];


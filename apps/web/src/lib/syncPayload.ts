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

export interface ConfirmedPlannerState {
  plans?: ConfirmedDomainFact<{ version: number; items: unknown[] }>;
  lightning?: ConfirmedDomainFact<{ version: number; items: unknown[] }>;
  days?: ConfirmedDomainFact<string[]>;
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
 * reduceConfirmedFacts()'s whole max-revision comparison depends on
 * genuine server-issued revisions — treating a corrupted fact as revision
 * 0 would make it look OLDER than everything, silently discarding it
 * instead of just refusing to trust it (it is simply excluded from the
 * candidate set reduceConfirmedFacts() reduces over).
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
 * SH.2 architecture (Codex P1, 11th round) — the PURE reduction at the
 * heart of the no-Web-Locks-dependent design: given a set of independently
 * recorded, immutable `ConfirmedDomainFact`s for ONE domain (each an
 * objective historical record — "revision R produced value V" — never
 * mutated once written), returns the one with the MAX revision, or `null`
 * if the set is empty.
 *
 * This is what lets syncHelper.ts's confirmed-state storage do away with
 * Web Locks entirely for THIS mechanism: because facts are immutable and
 * keyed by their own revision (see syncHelper.ts's confirmedFactKey), two
 * tabs recording DIFFERENT facts for the same domain at "the same moment"
 * can never race destructively — there is no shared mutable slot to
 * corrupt, only more facts for this pure function to reduce over. The
 * reduction itself is order-independent (a `.forEach` accumulator that
 * only ever keeps the running max), so it produces the SAME correct answer
 * regardless of which order the facts happen to be enumerated in — which
 * in turn is why WRITE order (racy, unlocked) never matters: only the
 * VALUES of the facts that exist matter, and the read-time reduction sees
 * them all.
 */
export function reduceConfirmedFacts<T>(facts: Array<ConfirmedDomainFact<T>>): ConfirmedDomainFact<T> | null {
  let best: ConfirmedDomainFact<T> | null = null;
  for (const fact of facts) {
    if (!best || fact.revision > best.revision) {
      best = fact;
    }
  }
  return best;
}

/**
 * Reference cases for reduceConfirmedFacts() — pinning the max-revision
 * reduction rule the whole no-Web-Locks confirmed-state design depends on.
 * Run from Node:
 *   import { DEV_REDUCE_CONFIRMED_FACTS_CASES, reduceConfirmedFacts } from "@/lib/syncPayload";
 *   DEV_REDUCE_CONFIRMED_FACTS_CASES.forEach(c => {
 *     const got = reduceConfirmedFacts(c.facts);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_REDUCE_CONFIRMED_FACTS_CASES: Array<{
  name: string;
  facts: Array<ConfirmedDomainFact<unknown>>;
  expected: ConfirmedDomainFact<unknown> | null;
}> = [
  {
    name: "empty set — nothing confirmed for this domain yet",
    facts: [],
    expected: null,
  },
  {
    name: "single fact — that one wins trivially",
    facts: [{ revision: 5, value: "A" }],
    expected: { revision: 5, value: "A" },
  },
  {
    name: "facts in ASCENDING revision order — max (last) wins",
    facts: [
      { revision: 5, value: "A" },
      { revision: 6, value: "B" },
    ],
    expected: { revision: 6, value: "B" },
  },
  {
    name: "facts in DESCENDING revision order (e.g. a delayed older response recorded AFTER a newer one) — max (first) still wins, insertion/arrival order is irrelevant",
    facts: [
      { revision: 7, value: "C" },
      { revision: 6, value: "B-delayed" },
    ],
    expected: { revision: 7, value: "C" },
  },
  {
    name: "three facts, max in the middle — order-independent",
    facts: [
      { revision: 3, value: "A" },
      { revision: 9, value: "C" },
      { revision: 6, value: "B" },
    ],
    expected: { revision: 9, value: "C" },
  },
  {
    name: "duplicate max revision (should not happen server-side — a revision is assigned once per accepted write — but handled gracefully: first-seen wins, never a crash)",
    facts: [
      { revision: 5, value: "first" },
      { revision: 5, value: "second" },
    ],
    expected: { revision: 5, value: "first" },
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
 * value is entirely up to reduceConfirmedFacts() at READ time. This
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
 * per-domain OR mixed together — see reduceConfirmedFacts()'s own doc for
 * why this is what removes the Web-Locks dependency for confirmed state.
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
// See commitLocalDomainRaw()/forceCommitLocalDomainRaw() in syncHelper.ts
// for the actual localStorage I/O built on this decision (including the
// per-key Web Locks serialization used when available, and the fail-safe
// behavior — this same decision, just without a lock — when it isn't).
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

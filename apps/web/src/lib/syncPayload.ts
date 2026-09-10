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

// ===== CLIENT-SIDE CONFIRMED-BASELINE COMMIT (SH.2) =====

/**
 * SH.2 architecture — the durably-stored record of "the exact planner
 * state most recently acknowledged by the server for this authenticated
 * user + profile, ordered by server-authoritative revision" (see
 * syncHelper.ts's confirmedSnapshotKeyForIdentity/getConfirmedSnapshot/
 * commitConfirmedBaseline). `revision` is the server's
 * `user_planner.revision` value (see api/sync/planner/route.ts) that
 * produced `snapshot` — a monotonically increasing integer, NEVER a
 * client timestamp or response-arrival-order proxy. Comparing two
 * ConfirmedPlannerSnapshots' `revision` values is always meaningful for
 * the SAME (user, profile) pair: strictly higher always means "the server
 * accepted this write/read later", regardless of which tab or request
 * observed it first (Codex P1, 3rd round).
 */
export interface ConfirmedPlannerSnapshot {
  revision: number;
  snapshot: SyncedPlannerPayload;
}

/**
 * Parse and validate a raw unknown value as a ConfirmedPlannerSnapshot.
 * Returns null if the shape is missing or invalid — callers treat null as
 * "nothing confirmed yet", not as an error. A non-finite/non-numeric
 * `revision` is rejected outright (never coerced to 0 or any other
 * sentinel) since a malformed revision can never be safely compared.
 */
export function parseConfirmedPlannerSnapshot(raw: unknown): ConfirmedPlannerSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.revision !== "number" || !Number.isFinite(r.revision)) return null;
  const snapshot = parseSyncedPlannerPayload(r.snapshot);
  if (!snapshot) return null;
  return { revision: r.revision, snapshot };
}

/**
 * Reference cases for parseConfirmedPlannerSnapshot() — the gate every page
 * consumer (getConfirmedSnapshot in syncHelper.ts) goes through before
 * trusting a stored confirmedSnapshot localStorage value as a pull baseline
 * or as nextConfirmedBaseline()'s `currentConfirmed` input. A malformed
 * `revision` must be rejected outright (never coerced to 0) since
 * nextConfirmedBaseline()'s whole ordering guarantee depends on comparing
 * two genuine server-issued revisions — treating a corrupted record as
 * revision 0 would make it look OLDER than everything, silently discarding
 * a real confirmation instead of just refusing to trust the corrupted one.
 * Run from Node:
 *   import { DEV_PARSE_CONFIRMED_SNAPSHOT_CASES, parseConfirmedPlannerSnapshot } from "@/lib/syncPayload";
 *   DEV_PARSE_CONFIRMED_SNAPSHOT_CASES.forEach(c => {
 *     const got = parseConfirmedPlannerSnapshot(c.raw);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_PARSE_CONFIRMED_SNAPSHOT_CASES: Array<{
  name: string;
  raw: unknown;
  expected: ConfirmedPlannerSnapshot | null;
}> = [
  {
    name: "valid confirmed snapshot — parses as-is",
    raw: {
      revision: 12,
      snapshot: { version: 1, plans: { version: 1, items: ["p"] }, lightning: { version: 1, items: [] } },
    },
    expected: {
      revision: 12,
      snapshot: { version: 1, plans: { version: 1, items: ["p"] }, lightning: { version: 1, items: [] } },
    },
  },
  {
    name: "revision 0 is a legitimate value, not treated as missing",
    raw: {
      revision: 0,
      snapshot: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
    },
    expected: {
      revision: 0,
      snapshot: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
    },
  },
  {
    name: "missing revision — rejected, never coerced to 0",
    raw: { snapshot: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } } },
    expected: null,
  },
  {
    name: "non-numeric revision — rejected",
    raw: {
      revision: "6",
      snapshot: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
    },
    expected: null,
  },
  {
    name: "non-finite revision (NaN) — rejected",
    raw: {
      revision: NaN,
      snapshot: { version: 1, plans: { version: 1, items: [] }, lightning: { version: 1, items: [] } },
    },
    expected: null,
  },
  {
    name: "revision valid but embedded snapshot invalid — whole record rejected",
    raw: { revision: 3, snapshot: { version: 2, plans: {}, lightning: {} } },
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
];

/**
 * SH.2 architecture — a domain's confirmed baseline represents "the state
 * currently accepted as synchronized for this domain", not merely "the
 * last successful PUT payload". A PUSH is one way a domain becomes
 * accepted; a PULL that hydrates cloud data into local storage (because
 * local hadn't changed) is another, equally valid way — both must be able
 * to advance the same confirmed record, per-domain, independently.
 *
 * Computes the new confirmed snapshot to commit, merging forward from
 * `currentConfirmed` (read FRESH at commit time by the caller — never a
 * frozen pull-start snapshot, so this can never revert a domain some
 * OTHER concurrent commit already advanced further than this one knows
 * about). Only the domains present in `accepted` are replaced; every
 * domain NOT present keeps whatever `currentConfirmed` already has for it,
 * completely untouched — this is what lets a caller commit just the
 * domain(s) it actually determined were cloud-won AND successfully
 * persisted this pull, while a locally-won domain's prior confirmation
 * status is left exactly as it was (see the pull effects in
 * plans/page.tsx and lightning/page.tsx for the per-domain conditions).
 *
 * Codex P1 fix (3rd round) — `revision` is the server-authoritative
 * ordering signal for the response this `accepted` data came from (a
 * push's PUT response, or a pull's GET response). Returns `null` — a
 * REJECTION, applying nothing — whenever `currentConfirmed` already exists
 * AND its `revision` is `>= revision`: an older (or duplicate) server
 * write/read can never regress or redundantly re-apply a snapshot the
 * confirmed record has already moved past, REGARDLESS of which order two
 * concurrent responses happen to arrive in on the client (this is what
 * makes the final confirmed state deterministic from server commit order
 * alone, never response arrival order). The whole candidate commit is
 * rejected atomically when stale — never partially applied — since
 * `accepted`'s domains all describe ONE specific server response; a stale
 * response teaches nothing new about ANY domain.
 *
 * `currentConfirmed` null (nothing confirmed yet for this profile) always
 * accepts — a profile's first-ever confirmation can originate from a
 * pull's cloud-hydration just as validly as from a push.
 */
export function nextConfirmedBaseline(
  currentConfirmed: ConfirmedPlannerSnapshot | null,
  revision: number,
  accepted: {
    plans?: { version: number; items: unknown[] };
    lightning?: { version: number; items: unknown[] };
    days?: string[];
  }
): ConfirmedPlannerSnapshot | null {
  if (currentConfirmed && revision <= currentConfirmed.revision) {
    return null;
  }
  const baseSnapshot: SyncedPlannerPayload = currentConfirmed?.snapshot ?? {
    version: 1,
    plans: { version: 1, items: [] },
    lightning: { version: 1, items: [] },
  };
  const days = accepted.days ?? baseSnapshot.days;
  return {
    revision,
    snapshot: {
      version: 1,
      plans: accepted.plans ?? baseSnapshot.plans,
      lightning: accepted.lightning ?? baseSnapshot.lightning,
      ...(days ? { days } : {}),
    },
  };
}

/**
 * Reference cases for nextConfirmedBaseline() — the per-domain,
 * revision-gated merge rule that closes two Codex P1 findings: (1) a
 * pull-accepted domain must durably advance the SAME confirmed record a
 * push would, without ever touching a domain it didn't itself resolve
 * this pull; (2) an older server write's response arriving after a newer
 * one must never regress the confirmed record, regardless of arrival
 * order. Run from Node:
 *   import { DEV_NEXT_CONFIRMED_BASELINE_CASES, nextConfirmedBaseline } from "@/lib/syncPayload";
 *   DEV_NEXT_CONFIRMED_BASELINE_CASES.forEach(c => {
 *     const got = nextConfirmedBaseline(c.currentConfirmed, c.revision, c.accepted);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_NEXT_CONFIRMED_BASELINE_CASES: Array<{
  name: string;
  currentConfirmed: ConfirmedPlannerSnapshot | null;
  revision: number;
  accepted: {
    plans?: { version: number; items: unknown[] };
    lightning?: { version: number; items: unknown[] };
    days?: string[];
  };
  expected: ConfirmedPlannerSnapshot | null;
}> = [
  {
    name: "nothing confirmed yet, plans accepted from a pull — starts a fresh confirmed record at that revision",
    currentConfirmed: null,
    revision: 1,
    accepted: { plans: { version: 1, items: ["p1"] } },
    expected: {
      revision: 1,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["p1"] },
        lightning: { version: 1, items: [] },
      },
    },
  },
  {
    name: "plans accepted at a newer revision — lightning and days untouched, keep whatever was already confirmed",
    currentConfirmed: {
      revision: 5,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["old"] },
        lightning: { version: 1, items: ["ll1"] },
        days: ["day-1", "day-2"],
      },
    },
    revision: 6,
    accepted: { plans: { version: 1, items: ["new"] } },
    expected: {
      revision: 6,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["new"] },
        lightning: { version: 1, items: ["ll1"] },
        days: ["day-1", "day-2"],
      },
    },
  },
  {
    name: "Codex P1 (3rd round) — an OLDER revision arriving after a newer one is confirmed is rejected outright (null), regardless of accepted content",
    currentConfirmed: {
      revision: 6,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["new-B"] },
        lightning: { version: 1, items: [] },
      },
    },
    revision: 5,
    accepted: { plans: { version: 1, items: ["stale-A"] } },
    expected: null,
  },
  {
    name: "Codex P1 (3rd round) — a DUPLICATE (equal) revision is also rejected, never re-applied",
    currentConfirmed: {
      revision: 6,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["B"] },
        lightning: { version: 1, items: [] },
      },
    },
    revision: 6,
    accepted: { plans: { version: 1, items: ["B-again"] } },
    expected: null,
  },
  {
    name: "Codex P1 (3rd round) — responses arriving A(rev5) then B(rev6): B commits cleanly over A",
    currentConfirmed: {
      revision: 5,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["A"] },
        lightning: { version: 1, items: [] },
      },
    },
    revision: 6,
    accepted: { plans: { version: 1, items: ["B"] } },
    expected: {
      revision: 6,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["B"] },
        lightning: { version: 1, items: [] },
      },
    },
  },
  {
    name: "days accepted alone at a newer revision (e.g. days-only cloud win) — plans/lightning untouched",
    currentConfirmed: {
      revision: 2,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["p1"] },
        lightning: { version: 1, items: ["ll1"] },
        days: ["day-1"],
      },
    },
    revision: 3,
    accepted: { days: ["day-1", "day-2"] },
    expected: {
      revision: 3,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["p1"] },
        lightning: { version: 1, items: ["ll1"] },
        days: ["day-1", "day-2"],
      },
    },
  },
  {
    name: "lightning accepted via the OPPOSITE page's own hydration write (Plans committing Lightning's baseline)",
    currentConfirmed: {
      revision: 4,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["p1"] },
        lightning: { version: 1, items: ["stale"] },
      },
    },
    revision: 7,
    accepted: { lightning: { version: 1, items: ["fresh"] } },
    expected: {
      revision: 7,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["p1"] },
        lightning: { version: 1, items: ["fresh"] },
      },
    },
  },
  {
    name: "all three accepted together at a newer revision (a clean, fully cloud-sourced pull) — whole record replaced",
    currentConfirmed: {
      revision: 1,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["old"] },
        lightning: { version: 1, items: ["old"] },
        days: ["day-1"],
      },
    },
    revision: 9,
    accepted: {
      plans: { version: 1, items: ["new"] },
      lightning: { version: 1, items: ["new"] },
      days: ["day-1", "day-2"],
    },
    expected: {
      revision: 9,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["new"] },
        lightning: { version: 1, items: ["new"] },
        days: ["day-1", "day-2"],
      },
    },
  },
  {
    name: "empty accepted at a newer revision — snapshot passes through byte-identical, only revision advances (callers normally skip this call entirely; pinned here for the pure function's own behavior)",
    currentConfirmed: {
      revision: 1,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["p1"] },
        lightning: { version: 1, items: ["ll1"] },
        days: ["day-1"],
      },
    },
    revision: 2,
    accepted: {},
    expected: {
      revision: 2,
      snapshot: {
        version: 1,
        plans: { version: 1, items: ["p1"] },
        lightning: { version: 1, items: ["ll1"] },
        days: ["day-1"],
      },
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

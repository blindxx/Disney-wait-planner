/**
 * entertainmentLifecycleRegistry.ts — Phase 14.5A Entertainment Lifecycle
 * Registry: types, validation and DEV cases for the Git-tracked maintenance
 * file `src/data/entertainmentLifecycleRegistry.json`.
 *
 * What this is
 * - MAINTENANCE METADATA for the recurring Data Audit: a durable, reviewable
 *   record of "this entry looks inactive/suspended/returning, here is the
 *   evidence and what to do next". It is NOT a second catalog: it never names,
 *   locates, adds, removes or retires anything. `ENTERTAINMENT_PLACES`
 *   (entertainmentSuggestions.ts) stays the only identity/metadata authority;
 *   a record only POINTS at an active catalog entry by (parkId, canonical name).
 * - NOT consumed at runtime in 14.5A: nothing imports the JSON outside this
 *   module (no hiding, no UI, no Smart Entry/My Plans effect, no detector).
 *
 * Identity
 * - Key = `entertainmentMappingKey(parkId, name)` — the same park-qualified
 *   normalized key the ThemeParks mapping uses (names repeat across parks).
 *   Duplicate keys are rejected; the name must be the exact canonical name of
 *   an entry in that park in the ACTIVE catalog (ENTERTAINMENT_PLACES) or the
 *   LEGACY catalog (retired/replaced identities). Unknown names are rejected.
 *   Legacy records are retained for AUDIT HISTORY ONLY (so retiring a confirmed
 *   discontinued show never invalidates its record): they get the same
 *   validation, but `isEligibleForInactivityDetection` is false for them —
 *   future automatic detection and any runtime resurfacing must skip them.
 *
 * Invariants enforced by `validateEntertainmentLifecycleRegistry`
 * - `category` ("regular" | "limited") only guides audits and must equal the
 *   catalog's availabilityType; both categories use identical inactivity rules.
 * - Seasonal/holiday/festival/party offerings are EXEMPT: catalog
 *   availabilityType "seasonal", any availabilityTheme, or any
 *   SEASONAL_ENTERTAINMENT_EVENTS association cannot have a record.
 * - Provider evidence (ThemeParks/Queue-Times/DWP runtime) is never
 *   confirmation: `confirmation: "confirmed"` needs ≥ 1 verification source
 *   flagged `independent: true` (independent of those providers), and
 *   assessment "discontinued" requires confirmed. "returning" needs a
 *   recorded future return; "hidden" needs a non-active assessment.
 * - Provisional records must carry a next review action (≠ "none"). Records
 *   with a non-"none" action are the audit's UNRESOLVED set.
 * - Provider evidence must list coverage limitations: missing history, empty
 *   schedules or an absent entity never prove inactivity on their own.
 * - Records are strict (unknown keys rejected); dates are real YYYY-MM-DD.
 *
 * Audit reading contract and the planned runtime-detection path are in
 * AGENTS.md ("Entertainment lifecycle registry"). Pure module (no I/O).
 * DEV checks (run manually, return failing labels):
 * `runDevEntertainmentLifecycleRegistryCases()`.
 */

import type { ParkId } from "@disney-wait-planner/shared";
import registryJson from "../data/entertainmentLifecycleRegistry.json";
import { ENTERTAINMENT_PLACES, getLegacyEntertainmentPlaces } from "./entertainmentSuggestions";
import { entertainmentMappingKey } from "./themeParksEntertainmentMapping";
import { SEASONAL_ENTERTAINMENT_EVENTS } from "./seasonalEntertainment";

// ============================================
// TYPES
// ============================================

export const LIFECYCLE_CATEGORIES = ["regular", "limited"] as const;
export type LifecycleCategory = (typeof LIFECYCLE_CATEGORIES)[number];

export const LIFECYCLE_ASSESSMENTS = ["unknown", "active", "inactive", "suspended", "discontinued", "returning"] as const;
export type LifecycleAssessment = (typeof LIFECYCLE_ASSESSMENTS)[number];

/** Recorded decision only — 14.5A applies none of these at runtime. */
export const LIFECYCLE_VISIBILITY_DECISIONS = ["undecided", "visible", "hidden"] as const;
export type LifecycleVisibilityDecision = (typeof LIFECYCLE_VISIBILITY_DECISIONS)[number];

export const LIFECYCLE_CONFIRMATIONS = ["provisional", "confirmed"] as const;
export type LifecycleConfirmation = (typeof LIFECYCLE_CONFIRMATIONS)[number];

export const LIFECYCLE_EVIDENCE_SOURCES = ["themeparks", "queue-times", "dwp-runtime"] as const;
export const LIFECYCLE_EVIDENCE_KINDS = [
  "live_empty", "history_inactive", "schedule_absent", "entity_missing", "status_closed", "other",
] as const;
export const LIFECYCLE_NEXT_ACTIONS = [
  "none", "verify_independently", "monitor", "re_review_on_date", "propose_catalog_retirement",
] as const;

/**
 * One provider/runtime observation. Same shape a future runtime detector would
 * emit, so promoting a candidate into the registry is a copy, not a mapping.
 */
export interface LifecycleProviderEvidence {
  source: (typeof LIFECYCLE_EVIDENCE_SOURCES)[number];
  kind: (typeof LIFECYCLE_EVIDENCE_KINDS)[number];
  /** YYYY-MM-DD the observation was made. */
  observedOn: string;
  summary: string;
  /** Provider entity id: lowercase UUID for ThemeParks, numeric ride id string for Queue-Times. */
  entityId?: string;
}

export interface LifecycleVerificationSource {
  url: string;
  title?: string;
  /** YYYY-MM-DD the source was read. */
  retrievedOn: string;
  /** What the source establishes. */
  claim: string;
  /** true only when independent of ThemeParks/Queue-Times/DWP runtime data (e.g. official Disney notice). */
  independent: boolean;
}

export interface LifecycleFutureReturn {
  description: string;
  /** YYYY-MM-DD when known to the day; otherwise omit and describe in `description`. */
  expectedDate?: string;
  sourceUrl?: string;
  confirmed: boolean;
}

export interface LifecycleNextReviewAction {
  action: (typeof LIFECYCLE_NEXT_ACTIONS)[number];
  /** YYYY-MM-DD; required for "re_review_on_date". */
  dueBy?: string;
  note?: string;
}

export interface EntertainmentLifecycleRecord {
  parkId: ParkId;
  /** Exact canonical name of an active ENTERTAINMENT_PLACES entry in `parkId`. */
  name: string;
  category: LifecycleCategory;
  assessment: LifecycleAssessment;
  visibility: { decision: LifecycleVisibilityDecision; reason: string };
  firstFlagged: string;
  lastReviewed: string;
  providerEvidence: LifecycleProviderEvidence[];
  /** Why the provider evidence above cannot stand alone. Required whenever providerEvidence is non-empty. */
  coverageLimitations: string[];
  verificationSources: LifecycleVerificationSource[];
  futureReturns: LifecycleFutureReturn[];
  confirmation: LifecycleConfirmation;
  nextReviewAction: LifecycleNextReviewAction;
}

export interface EntertainmentLifecycleRegistry {
  schemaVersion: 1;
  records: EntertainmentLifecycleRecord[];
}

export type LifecycleFindingKind =
  | "bad_shape" | "unknown_field" | "bad_enum" | "bad_date" | "date_order" | "bad_url" | "bad_uuid"
  | "duplicate_identity" | "unknown_identity" | "category_mismatch" | "seasonal_exempt"
  | "missing_reason" | "missing_coverage" | "confirmation_unsupported" | "discontinued_unconfirmed"
  | "returning_without_return" | "hidden_while_active" | "provisional_without_action" | "missing_due_date";

export interface LifecycleFinding {
  kind: LifecycleFindingKind;
  /** Record key (`park:normalized-name`) or "registry" for top-level problems. */
  key: string;
  message: string;
}

// ============================================
// DATA
// ============================================

/** The Git-tracked registry. Initially empty: findings are never invented. */
export const ENTERTAINMENT_LIFECYCLE_REGISTRY = registryJson as unknown as EntertainmentLifecycleRegistry;

export function lifecycleRecordKey(r: Pick<EntertainmentLifecycleRecord, "parkId" | "name">): string {
  return entertainmentMappingKey(r.parkId, r.name);
}

// ============================================
// IDENTITY RESOLUTION (active vs legacy)
// ============================================

export type LifecycleCatalogState = "active" | "legacy";

type CatalogPlace = (typeof ENTERTAINMENT_PLACES)[number];

/** Exact (parkId, canonical name) lookup; active catalog first, then legacy. */
function resolveLifecycleIdentity(parkId: unknown, name: unknown): { place: CatalogPlace; state: LifecycleCatalogState } | null {
  const active = ENTERTAINMENT_PLACES.find((p) => p.parkId === parkId && p.name === name);
  if (active) return { place: active, state: "active" };
  const legacy = getLegacyEntertainmentPlaces().find((p) => p.parkId === parkId && p.name === name);
  return legacy ? { place: legacy, state: "legacy" } : null;
}

/** Which catalog the record's identity currently lives in (null = unknown identity). */
export function getLifecycleCatalogState(r: Pick<EntertainmentLifecycleRecord, "parkId" | "name">): LifecycleCatalogState | null {
  return resolveLifecycleIdentity(r.parkId, r.name)?.state ?? null;
}

/**
 * Only ACTIVE catalog identities may ever be considered by future automatic
 * inactivity detection. Legacy records are audit history only.
 */
export function isEligibleForInactivityDetection(r: Pick<EntertainmentLifecycleRecord, "parkId" | "name">): boolean {
  return getLifecycleCatalogState(r) === "active";
}

// ============================================
// VALIDATION
// ============================================

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Queue-Times ride ids are numeric (see `queueTimes.rideId` in eventExclusiveMeets.ts). */
const QT_RIDE_ID_RE = /^[1-9]\d*$/;

/** Provider-specific identifier shape: ThemeParks UUID, Queue-Times numeric ride id; dwp-runtime may carry either. */
function isValidEvidenceEntityId(source: unknown, id: unknown): boolean {
  if (typeof id !== "string") return false;
  if (source === "themeparks") return UUID_RE.test(id);
  if (source === "queue-times") return QT_RIDE_ID_RE.test(id);
  return UUID_RE.test(id) || QT_RIDE_ID_RE.test(id);
}

function isRealDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function isHttpUrl(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try { const u = new URL(v); return u.protocol === "https:" || u.protocol === "http:"; } catch { return false; }
}

/** Catalog exemption: seasonal/holiday/festival/party offerings never get lifecycle records. */
function seasonalExemptionReason(place: CatalogPlace): string | null {
  if (place.availabilityType === "seasonal") return 'availabilityType "seasonal"';
  if (place.availabilityTheme) return `availabilityTheme "${place.availabilityTheme}"`;
  if (SEASONAL_ENTERTAINMENT_EVENTS[place.name]?.length) return "seasonal event association";
  return null;
}

export function validateEntertainmentLifecycleRegistry(
  registry: unknown = ENTERTAINMENT_LIFECYCLE_REGISTRY,
): LifecycleFinding[] {
  const findings: LifecycleFinding[] = [];
  const add = (kind: LifecycleFindingKind, key: string, message: string) => findings.push({ kind, key, message });

  if (!isObj(registry)) { add("bad_shape", "registry", "registry must be an object"); return findings; }
  const topExtra = Object.keys(registry).filter((k) => k !== "schemaVersion" && k !== "records");
  if (topExtra.length) add("unknown_field", "registry", `unknown top-level field(s): ${topExtra.join(", ")}`);
  if (registry.schemaVersion !== 1) add("bad_shape", "registry", "schemaVersion must be 1");
  if (!Array.isArray(registry.records)) { add("bad_shape", "registry", "records must be an array"); return findings; }

  const seen = new Set<string>();
  registry.records.forEach((raw: unknown, i: number) => {
    const at = `records[${i}]`;
    if (!isObj(raw)) { add("bad_shape", at, "record must be an object"); return; }
    const r = raw;
    const key = nonEmpty(r.parkId) && nonEmpty(r.name) ? entertainmentMappingKey(r.parkId as ParkId, r.name) : at;
    const extra = (obj: Record<string, unknown>, allowed: string[], where: string) => {
      const bad = Object.keys(obj).filter((k) => !allowed.includes(k));
      if (bad.length) add("unknown_field", key, `${where}: unknown field(s) ${bad.join(", ")}`);
    };
    const oneOf = <T extends string>(v: unknown, set: readonly T[], where: string): v is T => {
      if (typeof v === "string" && (set as readonly string[]).includes(v)) return true;
      add("bad_enum", key, `${where} must be one of ${set.join(" | ")}`);
      return false;
    };
    const date = (v: unknown, where: string) => {
      if (isRealDate(v)) return true;
      add("bad_date", key, `${where} must be a real YYYY-MM-DD date`);
      return false;
    };

    extra(r, ["parkId", "name", "category", "assessment", "visibility", "firstFlagged", "lastReviewed",
      "providerEvidence", "coverageLimitations", "verificationSources", "futureReturns", "confirmation", "nextReviewAction"], "record");

    // ---- identity ----
    if (!nonEmpty(r.parkId) || !nonEmpty(r.name)) { add("bad_shape", key, "parkId and name are required strings"); return; }
    if (seen.has(key)) add("duplicate_identity", key, "duplicate (park, name) identity");
    seen.add(key);
    const resolved = resolveLifecycleIdentity(r.parkId, r.name);
    const place = resolved?.place;
    if (!place) add("unknown_identity", key, "name is not the exact canonical name of an active or legacy catalog entry in this park");

    // ---- category / seasonal exemption ----
    const categoryOk = oneOf(r.category, LIFECYCLE_CATEGORIES, "category");
    if (place) {
      const exempt = seasonalExemptionReason(place);
      if (exempt) add("seasonal_exempt", key, `seasonal/holiday/festival/party offerings are exempt (${exempt})`);
      else if (categoryOk && r.category !== (place.availabilityType ?? "regular")) {
        add("category_mismatch", key, `category must equal the catalog availabilityType (${place.availabilityType ?? "regular"})`);
      }
    }

    // ---- enums ----
    const assessmentOk = oneOf(r.assessment, LIFECYCLE_ASSESSMENTS, "assessment");
    const confirmationOk = oneOf(r.confirmation, LIFECYCLE_CONFIRMATIONS, "confirmation");

    // ---- visibility ----
    let decision: unknown;
    if (!isObj(r.visibility)) add("bad_shape", key, "visibility must be { decision, reason }");
    else {
      extra(r.visibility, ["decision", "reason"], "visibility");
      decision = r.visibility.decision;
      oneOf(decision, LIFECYCLE_VISIBILITY_DECISIONS, "visibility.decision");
      if (!nonEmpty(r.visibility.reason)) add("missing_reason", key, "visibility.reason is required (non-empty)");
    }
    if (decision === "hidden" && assessmentOk && (r.assessment === "active" || r.assessment === "unknown")) {
      add("hidden_while_active", key, `visibility "hidden" is not allowed while assessment is ${String(r.assessment)}`);
    }

    // ---- dates ----
    const ff = date(r.firstFlagged, "firstFlagged");
    const lr = date(r.lastReviewed, "lastReviewed");
    if (ff && lr && (r.lastReviewed as string) < (r.firstFlagged as string)) add("date_order", key, "lastReviewed is before firstFlagged");

    // ---- provider evidence + coverage ----
    const evidence = Array.isArray(r.providerEvidence) ? r.providerEvidence : (add("bad_shape", key, "providerEvidence must be an array"), []);
    evidence.forEach((e: unknown, j: number) => {
      if (!isObj(e)) { add("bad_shape", key, `providerEvidence[${j}] must be an object`); return; }
      extra(e, ["source", "kind", "observedOn", "summary", "entityId"], `providerEvidence[${j}]`);
      oneOf(e.source, LIFECYCLE_EVIDENCE_SOURCES, `providerEvidence[${j}].source`);
      oneOf(e.kind, LIFECYCLE_EVIDENCE_KINDS, `providerEvidence[${j}].kind`);
      date(e.observedOn, `providerEvidence[${j}].observedOn`);
      if (!nonEmpty(e.summary)) add("bad_shape", key, `providerEvidence[${j}].summary is required`);
      if (e.entityId !== undefined && !isValidEvidenceEntityId(e.source, e.entityId)) {
        add("bad_uuid", key, `providerEvidence[${j}].entityId must be a lowercase UUID (themeparks) or numeric ride id (queue-times)`);
      }
    });
    const limits = Array.isArray(r.coverageLimitations) ? r.coverageLimitations : (add("bad_shape", key, "coverageLimitations must be an array"), []);
    if (limits.some((l: unknown) => !nonEmpty(l))) add("bad_shape", key, "coverageLimitations entries must be non-empty strings");
    if (evidence.length > 0 && limits.length === 0) {
      add("missing_coverage", key, "provider evidence requires at least one coverage limitation (missing history/empty schedules alone never prove inactivity)");
    }

    // ---- verification sources ----
    const sources = Array.isArray(r.verificationSources) ? r.verificationSources : (add("bad_shape", key, "verificationSources must be an array"), []);
    let independentCount = 0;
    sources.forEach((s: unknown, j: number) => {
      if (!isObj(s)) { add("bad_shape", key, `verificationSources[${j}] must be an object`); return; }
      extra(s, ["url", "title", "retrievedOn", "claim", "independent"], `verificationSources[${j}]`);
      if (!isHttpUrl(s.url)) add("bad_url", key, `verificationSources[${j}].url must be an http(s) URL`);
      date(s.retrievedOn, `verificationSources[${j}].retrievedOn`);
      if (!nonEmpty(s.claim)) add("bad_shape", key, `verificationSources[${j}].claim is required`);
      if (typeof s.independent !== "boolean") add("bad_shape", key, `verificationSources[${j}].independent must be boolean`);
      else if (s.independent) independentCount++;
    });

    // ---- future returns ----
    const returns = Array.isArray(r.futureReturns) ? r.futureReturns : (add("bad_shape", key, "futureReturns must be an array"), []);
    returns.forEach((f: unknown, j: number) => {
      if (!isObj(f)) { add("bad_shape", key, `futureReturns[${j}] must be an object`); return; }
      extra(f, ["description", "expectedDate", "sourceUrl", "confirmed"], `futureReturns[${j}]`);
      if (!nonEmpty(f.description)) add("bad_shape", key, `futureReturns[${j}].description is required`);
      if (f.expectedDate !== undefined) date(f.expectedDate, `futureReturns[${j}].expectedDate`);
      if (f.sourceUrl !== undefined && !isHttpUrl(f.sourceUrl)) add("bad_url", key, `futureReturns[${j}].sourceUrl must be an http(s) URL`);
      if (typeof f.confirmed !== "boolean") add("bad_shape", key, `futureReturns[${j}].confirmed must be boolean`);
    });

    // ---- next review action ----
    let action: unknown;
    if (!isObj(r.nextReviewAction)) add("bad_shape", key, "nextReviewAction must be { action, dueBy?, note? }");
    else {
      extra(r.nextReviewAction, ["action", "dueBy", "note"], "nextReviewAction");
      action = r.nextReviewAction.action;
      oneOf(action, LIFECYCLE_NEXT_ACTIONS, "nextReviewAction.action");
      if (r.nextReviewAction.dueBy !== undefined) date(r.nextReviewAction.dueBy, "nextReviewAction.dueBy");
      if (action === "re_review_on_date" && r.nextReviewAction.dueBy === undefined) add("missing_due_date", key, 'action "re_review_on_date" requires dueBy');
    }

    // ---- confirmation rules ----
    if (confirmationOk && assessmentOk) {
      if (r.confirmation === "confirmed" && independentCount === 0) {
        add("confirmation_unsupported", key, "confirmed status requires at least one independent verification source (provider evidence alone is never confirmation)");
      }
      if (r.confirmation === "confirmed" && r.assessment === "unknown") {
        add("confirmation_unsupported", key, 'assessment "unknown" cannot be confirmed');
      }
      if (r.assessment === "discontinued" && r.confirmation !== "confirmed") {
        add("discontinued_unconfirmed", key, 'assessment "discontinued" requires confirmed status with independent evidence');
      }
      if (r.confirmation === "provisional" && action === "none") {
        add("provisional_without_action", key, 'provisional records need a next review action other than "none"');
      }
    }
    if (assessmentOk && r.assessment === "returning" && returns.length === 0) {
      add("returning_without_return", key, 'assessment "returning" requires at least one futureReturns entry');
    }
  });

  return findings;
}

/**
 * Records the recurring audit must still act on (next review action ≠ "none"),
 * oldest `lastReviewed` first. Pure read helper — the audit may equally read
 * the JSON directly; both apply the same rule.
 */
export function getUnresolvedLifecycleRecords(
  registry: EntertainmentLifecycleRegistry = ENTERTAINMENT_LIFECYCLE_REGISTRY,
): EntertainmentLifecycleRecord[] {
  return registry.records
    .filter((r) => r.nextReviewAction.action !== "none")
    .sort((a, b) => a.lastReviewed.localeCompare(b.lastReviewed));
}

// ============================================
// DEV CASES (run manually; return failing labels)
// ============================================

export function runDevEntertainmentLifecycleRegistryCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const kinds = (reg: unknown) => validateEntertainmentLifecycleRegistry(reg).map((f) => f.kind);
  const wrap = (...records: unknown[]) => ({ schemaVersion: 1, records });

  // A valid, fully provisional "regular" record against a real active catalog entry.
  const base = (over: Record<string, unknown> = {}) => ({
    parkId: "disneyland", name: "Wondrous Journeys", category: "regular", assessment: "inactive",
    visibility: { decision: "undecided", reason: "Awaiting independent verification" },
    firstFlagged: "2026-11-01", lastReviewed: "2026-11-10",
    providerEvidence: [{ source: "themeparks", kind: "history_inactive", observedOn: "2026-11-10", summary: "No performances in window" }],
    coverageLimitations: ["History is a change log; missing rows prove nothing"],
    verificationSources: [], futureReturns: [], confirmation: "provisional",
    nextReviewAction: { action: "verify_independently" },
    ...over,
  });
  const limited = base({ name: "Paint the Night", category: "limited" });

  // Shipped registry
  check("shipped: registry validates", validateEntertainmentLifecycleRegistry().length === 0);
  check("shipped: schemaVersion 1", ENTERTAINMENT_LIFECYCLE_REGISTRY.schemaVersion === 1);
  check("shipped: unresolved records are a subset of the maintained records",
    getUnresolvedLifecycleRecords().every((r) => ENTERTAINMENT_LIFECYCLE_REGISTRY.records.includes(r)));
  // Empty-state behavior is asserted on an explicit fixture so adding real records never breaks the suite.
  const empty = { schemaVersion: 1, records: [] } as EntertainmentLifecycleRegistry;
  check("empty fixture: validates", validateEntertainmentLifecycleRegistry(empty).length === 0);
  check("empty fixture: unresolved set empty", getUnresolvedLifecycleRecords(empty).length === 0);

  // Schema
  check("schema: valid regular provisional record passes", kinds(wrap(base())).length === 0);
  check("schema: valid limited record passes (same rules)", kinds(wrap(limited)).length === 0);
  check("schema: non-object registry rejected", kinds(null).includes("bad_shape"));
  check("schema: wrong schemaVersion rejected", kinds({ schemaVersion: 2, records: [] }).includes("bad_shape"));
  check("schema: unknown top-level field rejected", kinds({ schemaVersion: 1, records: [], extra: 1 }).includes("unknown_field"));
  check("schema: unknown record field rejected", kinds(wrap(base({ surprise: true }))).includes("unknown_field"));
  check("schema: assessment 'seasonal' rejected", kinds(wrap(base({ assessment: "seasonal" }))).includes("bad_enum"));
  check("schema: category 'seasonal' rejected", kinds(wrap(base({ category: "seasonal" }))).includes("bad_enum"));
  check("schema: all six assessments accepted as enum values",
    LIFECYCLE_ASSESSMENTS.length === 6 && ["unknown", "active", "inactive", "suspended", "discontinued", "returning"].every((a) => (LIFECYCLE_ASSESSMENTS as readonly string[]).includes(a)));
  check("schema: impossible date rejected", kinds(wrap(base({ firstFlagged: "2026-02-30" }))).includes("bad_date"));
  check("schema: lastReviewed before firstFlagged rejected", kinds(wrap(base({ lastReviewed: "2026-10-01" }))).includes("date_order"));
  check("schema: missing visibility reason rejected", kinds(wrap(base({ visibility: { decision: "undecided", reason: " " } }))).includes("missing_reason"));
  check("schema: bad evidence entityId rejected",
    kinds(wrap(base({ providerEvidence: [{ source: "themeparks", kind: "entity_missing", observedOn: "2026-11-10", summary: "x", entityId: "nope" }] }))).includes("bad_uuid"));
  const ev = (source: string, entityId: string) =>
    kinds(wrap(base({ providerEvidence: [{ source, kind: "entity_missing", observedOn: "2026-11-10", summary: "x", entityId }] })));
  check("schema: queue-times numeric ride id accepted", ev("queue-times", "1234").length === 0);
  check("schema: queue-times UUID / non-numeric id rejected", ev("queue-times", "8c36ff0b-3a32-4d7b-9388-0516c19277db").includes("bad_uuid") && ev("queue-times", "12ab").includes("bad_uuid") && ev("queue-times", "0").includes("bad_uuid"));
  check("schema: themeparks UUID accepted, numeric id rejected",
    ev("themeparks", "8c36ff0b-3a32-4d7b-9388-0516c19277db").length === 0 && ev("themeparks", "1234").includes("bad_uuid"));
  check("schema: dwp-runtime accepts either id form, rejects junk",
    ev("dwp-runtime", "1234").length === 0 && ev("dwp-runtime", "8c36ff0b-3a32-4d7b-9388-0516c19277db").length === 0 && ev("dwp-runtime", "nope").includes("bad_uuid"));
  check("schema: non-http verification url rejected",
    kinds(wrap(base({ verificationSources: [{ url: "javascript:alert(1)", retrievedOn: "2026-11-10", claim: "x", independent: true }] }))).includes("bad_url"));

  // Identity
  check("identity: duplicate (park, name) rejected", kinds(wrap(base(), base())).includes("duplicate_identity"));
  check("identity: duplicate detected through normalization (case/punctuation)",
    kinds(wrap(base(), base({ name: "wondrous journeys" }))).includes("duplicate_identity"));
  check("identity: same name in different parks is distinct (Fantasmic!)",
    !kinds(wrap(base({ name: "Fantasmic!" }), base({ parkId: "hs", name: "Fantasmic!" }))).includes("duplicate_identity"));
  check("identity: unknown name rejected", kinds(wrap(base({ name: "Not A Real Show" }))).includes("unknown_identity"));
  check("identity: wrong park rejected", kinds(wrap(base({ parkId: "mk" }))).includes("unknown_identity"));
  // Legacy retention (14.5A fix): legacy identities stay valid as audit history.
  const legacyPlaces = getLegacyEntertainmentPlaces();
  const LEG = "Together Forever — A Pixar Nighttime Spectacular";
  const legacyBase = (over: Record<string, unknown> = {}) => base({ name: LEG, category: "limited", ...over });
  const indepL = [{ url: "https://example.com/notice", retrievedOn: "2026-11-10", claim: "Official end notice", independent: true }];
  check("legacy: catalog has legacy entries to exercise", legacyPlaces.length > 0 && legacyPlaces.some((p) => p.name === LEG && p.parkId === "disneyland"));
  check("legacy: every legacy identity resolves and is not active",
    legacyPlaces.every((p) => getLifecycleCatalogState({ parkId: p.parkId as ParkId, name: p.name }) === "legacy"));
  check("legacy: valid provisional legacy record retained", kinds(wrap(legacyBase())).length === 0);
  check("legacy: confirmed discontinued legacy record stays valid",
    kinds(wrap(legacyBase({ assessment: "discontinued", confirmation: "confirmed", verificationSources: indepL, nextReviewAction: { action: "none" } }))).length === 0);
  check("legacy: confirmed discontinued still needs independent evidence",
    kinds(wrap(legacyBase({ assessment: "discontinued", confirmation: "confirmed", nextReviewAction: { action: "none" } }))).includes("confirmation_unsupported"));
  check("legacy: discontinued while provisional still rejected",
    kinds(wrap(legacyBase({ assessment: "discontinued" }))).includes("discontinued_unconfirmed"));
  check("legacy: evidence rules unchanged (coverage required, per-source ids)",
    kinds(wrap(legacyBase({ coverageLimitations: [] }))).includes("missing_coverage") &&
    kinds(wrap(legacyBase({ providerEvidence: [{ source: "queue-times", kind: "other", observedOn: "2026-11-10", summary: "x", entityId: "abc" }] }))).includes("bad_uuid"));
  check("legacy: park-qualified (wrong park rejected)", kinds(wrap(legacyBase({ parkId: "dca" }))).includes("unknown_identity"));
  check("legacy: category must still match catalog availabilityType", kinds(wrap(legacyBase({ category: "regular" }))).includes("category_mismatch"));
  check("legacy: duplicate legacy identity rejected (incl. normalization)",
    kinds(wrap(legacyBase(), legacyBase({ name: LEG.toLowerCase() }))).includes("duplicate_identity"));
  check("legacy: unknown near-miss name still rejected", kinds(wrap(legacyBase({ name: "Together Forever" }))).includes("unknown_identity"));
  const activeKeys = new Set(ENTERTAINMENT_PLACES.map((p) => entertainmentMappingKey(p.parkId as ParkId, p.name)));
  check("identity uniqueness: no identity exists in both active and legacy catalogs",
    legacyPlaces.every((p) => !activeKeys.has(entertainmentMappingKey(p.parkId as ParkId, p.name))));
  check("legacy: same record cannot be registered under both catalog states (one key, one record)",
    kinds(wrap(base(), legacyBase())).length === 0 && kinds(wrap(legacyBase(), legacyBase())).includes("duplicate_identity"));
  check("legacy: catalog state reported; only active eligible for inactivity detection",
    getLifecycleCatalogState({ parkId: "disneyland", name: LEG }) === "legacy" &&
    getLifecycleCatalogState({ parkId: "disneyland", name: "Wondrous Journeys" }) === "active" &&
    getLifecycleCatalogState({ parkId: "disneyland", name: "Nope" }) === null &&
    !isEligibleForInactivityDetection({ parkId: "disneyland", name: LEG }) &&
    isEligibleForInactivityDetection({ parkId: "disneyland", name: "Wondrous Journeys" }) &&
    !isEligibleForInactivityDetection({ parkId: "disneyland", name: "Nope" }));
  check("legacy: seasonal exemption applies to any seasonal/themed legacy identity (vacuous while none exist; active cases above cover the rule)",
    legacyPlaces.filter((p) => p.availabilityType === "seasonal" || p.availabilityTheme).every((p) =>
      kinds(wrap(base({ parkId: p.parkId, name: p.name, category: p.availabilityType ?? "regular" }))).includes("seasonal_exempt")));
  check("identity: category must match catalog availabilityType",
    kinds(wrap(base({ category: "limited" }))).includes("category_mismatch") && kinds(wrap(base({ name: "Paint the Night" }))).includes("category_mismatch"));

  // Seasonal exclusions (derived from the maintained catalog/seasonal sources — never a copied list)
  const seasonalPlaces = ENTERTAINMENT_PLACES.filter((p) => p.availabilityType === "seasonal");
  check("seasonal: catalog has seasonal entries to exercise", seasonalPlaces.length > 0);
  check("seasonal: EVERY catalog-seasonal entry is rejected",
    seasonalPlaces.every((p) => kinds(wrap(base({ parkId: p.parkId, name: p.name }))).includes("seasonal_exempt")));
  const themed = ENTERTAINMENT_PLACES.filter((p) => p.availabilityTheme);
  check("seasonal: every themed (holiday) entry is rejected",
    themed.length > 0 && themed.every((p) => kinds(wrap(base({ parkId: p.parkId, name: p.name }))).includes("seasonal_exempt")));
  const partyNames = Object.keys(SEASONAL_ENTERTAINMENT_EVENTS);
  check("seasonal: every party/season-associated entry is rejected",
    partyNames.length > 0 && partyNames.every((n) => {
      const p = ENTERTAINMENT_PLACES.find((x) => x.name === n);
      return !p || kinds(wrap(base({ parkId: p.parkId, name: n }))).includes("seasonal_exempt");
    }));
  check("seasonal: exempt entry flagged even with category 'limited'",
    kinds(wrap(base({ parkId: "disneyland", name: "Halloween Screams", category: "limited" }))).includes("seasonal_exempt"));
  check("seasonal: non-exempt regular & limited entries are not flagged",
    !kinds(wrap(base(), limited)).includes("seasonal_exempt"));

  // Evidence / confirmation rules
  check("rules: provider evidence without coverage limitations rejected", kinds(wrap(base({ coverageLimitations: [] }))).includes("missing_coverage"));
  check("rules: confirmed with only provider evidence rejected",
    kinds(wrap(base({ confirmation: "confirmed", nextReviewAction: { action: "none" } }))).includes("confirmation_unsupported"));
  check("rules: confirmed with non-independent source rejected",
    kinds(wrap(base({ confirmation: "confirmed", nextReviewAction: { action: "none" },
      verificationSources: [{ url: "https://example.com/a", retrievedOn: "2026-11-10", claim: "x", independent: false }] }))).includes("confirmation_unsupported"));
  const indep = [{ url: "https://example.com/notice", retrievedOn: "2026-11-10", claim: "Official closing notice", independent: true }];
  check("rules: confirmed discontinued with independent source passes",
    kinds(wrap(base({ assessment: "discontinued", confirmation: "confirmed", nextReviewAction: { action: "propose_catalog_retirement" }, verificationSources: indep }))).length === 0);
  check("rules: discontinued while provisional rejected",
    kinds(wrap(base({ assessment: "discontinued" }))).includes("discontinued_unconfirmed"));
  check("rules: discontinued, provider-evidence-only 'confirmed' rejected",
    kinds(wrap(base({ assessment: "discontinued", confirmation: "confirmed" }))).includes("confirmation_unsupported"));
  check("rules: 'unknown' cannot be confirmed",
    kinds(wrap(base({ assessment: "unknown", confirmation: "confirmed", verificationSources: indep }))).includes("confirmation_unsupported"));
  check("rules: provisional with action 'none' rejected",
    kinds(wrap(base({ nextReviewAction: { action: "none" } }))).includes("provisional_without_action"));
  check("rules: re_review_on_date requires dueBy",
    kinds(wrap(base({ nextReviewAction: { action: "re_review_on_date" } }))).includes("missing_due_date"));
  check("rules: returning requires a futureReturns entry",
    kinds(wrap(base({ assessment: "returning" }))).includes("returning_without_return"));
  check("rules: returning with future return passes",
    kinds(wrap(base({ name: "Magic Happens Parade", category: "limited", assessment: "returning",
      futureReturns: [{ description: "Announced return", expectedDate: "2027-06-01", confirmed: true }] }))).length === 0);
  check("rules: hidden decision rejected while assessment active/unknown",
    kinds(wrap(base({ assessment: "active", visibility: { decision: "hidden", reason: "x" } }))).includes("hidden_while_active") &&
    kinds(wrap(base({ assessment: "unknown", visibility: { decision: "hidden", reason: "x" } }))).includes("hidden_while_active"));
  check("rules: hidden decision allowed for provisional inactive (recorded only)",
    !kinds(wrap(base({ visibility: { decision: "hidden", reason: "Pending verification" } }))).includes("hidden_while_active"));

  // Unresolved read helper
  const reg = wrap(
    base({ lastReviewed: "2026-11-10" }),
    base({ name: "Tapestry of Happiness", lastReviewed: "2026-11-02" }),
    base({ name: "Fire of the Rising Moons", assessment: "active", confirmation: "confirmed", providerEvidence: [], coverageLimitations: [],
      verificationSources: indep, nextReviewAction: { action: "none" } }),
  ) as unknown as EntertainmentLifecycleRegistry;
  check("unresolved: fixture validates", validateEntertainmentLifecycleRegistry(reg).length === 0);
  check("unresolved: only action≠none records, oldest review first",
    getUnresolvedLifecycleRecords(reg).map((r) => r.name).join("|") === "Tapestry of Happiness|Wondrous Journeys");

  return failures;
}

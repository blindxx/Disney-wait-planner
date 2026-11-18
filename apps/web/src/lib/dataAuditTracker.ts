/**
 * dataAuditTracker.ts — Phase 14.5E-A Data Audit maintenance tracker: types,
 * validation, read helpers and DEV cases for the Git-tracked file
 * `src/data/dataAuditTracker.json`.
 *
 * What this is
 * - The ONE persistent MAINTENANCE ledger for recurring Data Audit findings
 *   across Attractions, Dining, Entertainment and Experiences items, with the
 *   finding topic (identity / status / refurbishment / seasonal / lifecycle /
 *   metadata) recorded per episode. It is NOT a catalog, NOT a runtime input
 *   and has no UI, database table or endpoint: nothing imports the JSON
 *   outside this module. Catalogs stay the identity/metadata authority.
 * - Entertainment lifecycle assessment, provider evidence, verification sources
 *   and visibility decisions stay AUTHORITATIVE in
 *   `entertainmentLifecycleRegistry.json`. A tracker item merely points at a
 *   registry record (`lifecycleRegistry: true`; same park-qualified identity)
 *   and never copies its assessment/evidence fields.
 *
 * Identity
 * - `trackerId` ("DA-0001", ...) is OPAQUE and permanent: one per canonical
 *   catalog item (type + resort/park + name). It is never derived from the
 *   name, so renames and Active↔Legacy movement keep it. Reuse it for every
 *   later finding, resolution and reopening of that item (a new `episode`),
 *   never mint a second ID for the same item.
 * - Identity key = `type:(parkId|resort):normalizeKey(name)`. Current and
 *   former names of ALL items must be globally unique, so a rename can never
 *   collide with another item and a retired name cannot be re-claimed.
 * - The name must resolve exactly (not via alias/containment) in the owning
 *   domain's maintained catalogs, active or legacy (entertainment: the same
 *   `getLifecycleCatalogState`). Catalog/lifecycle state is DERIVED
 *   (`getTrackerCatalogState`), never stored on the item: audit status and
 *   catalog status are separate concepts.
 *
 * Audit status (per item): open | monitoring | deferred | pending_implementation
 * | resolved. Resolved items keep their full history but are excluded from
 * `getOutstandingTrackerItems`.
 *
 * History is append-only and holds only SIGNIFICANT events (opened, reviewed
 * with evidence/decision, status_changed, resolved, reopened, renamed,
 * catalog_state_changed); routine daily observations never create records or
 * entries. `validateDataAuditTracker` replays the history (status/episode
 * transitions, reopen needs genuinely newer evidence); a single snapshot cannot
 * prove nothing was deleted, so `checkTrackerAppendOnly(previous, next)` compares
 * two versions (PR verification: previous = `git show origin/main:<file>`).
 *
 * Pure module (no I/O). DEV checks (run manually, return failing labels):
 * `runDevDataAuditTrackerCases()`. Maintenance procedure: AGENTS.md
 * ("Data Audit maintenance tracker").
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { mockAttractionWaits } from "@disney-wait-planner/shared";
import trackerJson from "../data/dataAuditTracker.json";
import { DINING_PLACES, resolveDiningKey } from "./diningSuggestions";
import { EXPERIENCE_PLACES, resolveExperienceKey } from "./experienceSuggestions";
import { resolveAttractionIdentityKey } from "./legacyAttractions";
import { PARK_TO_RESORT, isValidParkId } from "./parkMetadata";
import { normalizeKey } from "./plansMatching";
import type { PlannerItemType } from "./plansTransfer";
import {
  ENTERTAINMENT_LIFECYCLE_REGISTRY,
  getLifecycleCatalogState,
  getUnresolvedLifecycleRecords,
  lifecycleRecordKey,
} from "./entertainmentLifecycleRegistry";
import { entertainmentMappingKey } from "./themeParksEntertainmentMapping";

// ============================================
// TYPES
// ============================================

export const TRACKER_ITEM_TYPES = ["attraction", "dining", "entertainment", "experience"] as const satisfies readonly PlannerItemType[];
export const TRACKER_RESORTS = ["DLR", "WDW"] as const satisfies readonly ResortId[];
export const AUDIT_STATUSES = ["open", "monitoring", "deferred", "pending_implementation", "resolved"] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];
export const FINDING_TOPICS = ["identity", "status", "refurbishment", "seasonal", "lifecycle", "metadata"] as const;
export const HISTORY_KINDS = ["opened", "reviewed", "status_changed", "resolved", "reopened", "renamed", "catalog_state_changed"] as const;
export const REOPEN_REASONS = ["new_evidence", "new_lifecycle_episode"] as const;
export const CATALOG_STATES = ["active", "legacy"] as const;
export type TrackerCatalogState = (typeof CATALOG_STATES)[number];

/** A dated, sourced fact. Needs a public `url` or a repository `ref` (path[#anchor]) — never free-floating claims. */
export interface TrackerEvidence {
  /** YYYY-MM-DD the evidence was observed/retrieved. */
  date: string;
  note: string;
  url?: string;
  ref?: string;
}

export interface TrackerHistoryEntry {
  date: string;
  kind: (typeof HISTORY_KINDS)[number];
  /** Audit status AFTER this entry. */
  status: AuditStatus;
  /** Episode AFTER this entry (1 = first; +1 only on `reopened`). */
  episode: number;
  /** Required on `opened` / `reopened`. */
  topic?: (typeof FINDING_TOPICS)[number];
  summary: string;
  decision?: string;
  evidence: TrackerEvidence[];
  /** `owner/repo#123` references. */
  relatedPrs?: string[];
  /** `reopened` only. */
  reopenReason?: (typeof REOPEN_REASONS)[number];
  /** `renamed`: previous/new canonical name. `catalog_state_changed`: previous/new state (active|legacy). */
  from?: string;
  to?: string;
}

export interface TrackerNextReview {
  date?: string;
  condition?: string;
}

export interface TrackerAudit {
  status: AuditStatus;
  episode: number;
  /** Required while not resolved. */
  action?: string;
  /** Latest review date; may be newer than the last significant history entry. */
  lastReviewed: string;
  nextReview?: TrackerNextReview;
  /** Required exactly when resolved: date of the resolving history entry. */
  resolvedOn?: string;
}

export interface TrackerItem {
  trackerId: string;
  type: PlannerItemType;
  resort: ResortId;
  /** Required for entertainment; optional for non-park dining/experiences. */
  parkId?: ParkId;
  /** Current canonical catalog name. */
  name: string;
  /** Earlier canonical names, oldest first (append-only; each matches a `renamed` entry's `from`). */
  formerNames?: string[];
  /** Entertainment only: a record with this identity exists in the lifecycle registry (authoritative for assessment/evidence). */
  lifecycleRegistry?: true;
  /** Topic of the CURRENT episode. */
  topic: (typeof FINDING_TOPICS)[number];
  audit: TrackerAudit;
  history: TrackerHistoryEntry[];
}

export interface DataAuditTracker {
  schemaVersion: 1;
  items: TrackerItem[];
}

export type TrackerFindingKind =
  | "bad_shape" | "unknown_field" | "bad_enum" | "bad_date" | "bad_url" | "bad_id" | "duplicate_id"
  | "duplicate_identity" | "unknown_identity" | "bad_park" | "history_order" | "bad_transition"
  | "audit_mismatch" | "missing_field" | "unexpected_field" | "evidence_unsourced" | "reopen_without_new_evidence"
  | "bad_pr_ref" | "rename_mismatch" | "registry_missing" | "registry_untracked" | "registry_conflict";

export interface TrackerFinding {
  kind: TrackerFindingKind;
  /** `trackerId` (or `items[i]` / "tracker"). */
  key: string;
  message: string;
}

// ============================================
// DATA
// ============================================

/** The Git-tracked tracker. Seeded only with findings verifiable from existing audit records. */
export const DATA_AUDIT_TRACKER = trackerJson as unknown as DataAuditTracker;

/**
 * Identity key shared by uniqueness checks: type + scope + normalized name.
 * Entertainment names repeat across parks, so its scope is the park; every other
 * type's catalog keys are unique per resort, so its scope is the resort and an
 * optional/omitted `parkId` can never split one catalog item across two IDs.
 */
export function trackerIdentityKey(i: Pick<TrackerItem, "type" | "resort" | "parkId">, name: string): string {
  const scope = i.type === "entertainment" ? (i.parkId ?? i.resort) : i.resort;
  return `${i.type}:${scope}:${normalizeKey(name)}`;
}

// ============================================
// CATALOG STATE (derived, never stored)
// ============================================

/**
 * Resolve an item's identity against the maintained catalogs. "active" =
 * exact canonical name in the active catalog (park must match when both are
 * known); "legacy" = exact canonical name only the legacy catalog knows
 * (legacy catalogs are not enumerable, so resolver-only); null = unknown.
 */
export function getTrackerCatalogState(
  i: Pick<TrackerItem, "type" | "resort" | "parkId">, name: string,
): TrackerCatalogState | null {
  const key = normalizeKey(name);
  const exactLegacy = (resolved: string | null) => (resolved === key ? "legacy" as const : null);
  switch (i.type) {
    case "entertainment":
      return i.parkId ? getLifecycleCatalogState({ parkId: i.parkId, name }) : null;
    case "attraction": {
      const active = mockAttractionWaits.find((a) => a.resortId === i.resort && normalizeKey(a.name) === key);
      // Park qualification must match the catalog exactly (an omitted parkId is not a valid alternative spelling).
      if (active) return active.parkId !== i.parkId ? null : "active";
      return exactLegacy(resolveAttractionIdentityKey(name, i.resort));
    }
    case "dining":
    case "experience": {
      const places = i.type === "dining" ? DINING_PLACES : EXPERIENCE_PLACES;
      const active = places.find((p) => p.resort === i.resort && normalizeKey(p.name) === key);
      if (active) return active.parkId !== i.parkId ? null : "active";
      return exactLegacy((i.type === "dining" ? resolveDiningKey : resolveExperienceKey)(name, i.resort));
    }
    default:
      return null;
  }
}

// ============================================
// VALIDATION
// ============================================

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const TRACKER_ID_RE = /^DA-\d{4,}$/;
const PR_REF_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/;

function isRealDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function isHttpUrl(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try { const u = new URL(v); return u.protocol === "https:" || u.protocol === "http:"; } catch { return false; }
}

export function validateDataAuditTracker(tracker: unknown = DATA_AUDIT_TRACKER): TrackerFinding[] {
  const findings: TrackerFinding[] = [];
  const add = (kind: TrackerFindingKind, key: string, message: string) => findings.push({ kind, key, message });

  if (!isObj(tracker)) { add("bad_shape", "tracker", "tracker must be an object"); return findings; }
  const topExtra = Object.keys(tracker).filter((k) => k !== "schemaVersion" && k !== "items");
  if (topExtra.length) add("unknown_field", "tracker", `unknown top-level field(s): ${topExtra.join(", ")}`);
  if (tracker.schemaVersion !== 1) add("bad_shape", "tracker", "schemaVersion must be 1");
  if (!Array.isArray(tracker.items)) { add("bad_shape", "tracker", "items must be an array"); return findings; }

  const ids = new Set<string>();
  const claimed = new Map<string, string>(); // identity key -> trackerId
  const registryKeysTracked = new Set<string>();

  tracker.items.forEach((raw: unknown, idx: number) => {
    const at = `items[${idx}]`;
    if (!isObj(raw)) { add("bad_shape", at, "item must be an object"); return; }
    const r = raw;
    const key = typeof r.trackerId === "string" && r.trackerId ? r.trackerId : at;
    const extra = (obj: Record<string, unknown>, allowed: string[], where: string) => {
      const bad = Object.keys(obj).filter((k) => !allowed.includes(k));
      if (bad.length) add("unknown_field", key, `${where}: unknown field(s) ${bad.join(", ")}`);
    };
    const oneOf = <T extends string>(v: unknown, set: readonly T[], where: string): v is T => {
      if (typeof v === "string" && (set as readonly string[]).includes(v)) return true;
      add("bad_enum", key, `${where} must be one of ${set.join(" | ")}`);
      return false;
    };
    const date = (v: unknown, where: string): v is string => {
      if (isRealDate(v)) return true;
      add("bad_date", key, `${where} must be a real YYYY-MM-DD date`);
      return false;
    };

    extra(r, ["trackerId", "type", "resort", "parkId", "name", "formerNames", "lifecycleRegistry", "topic", "audit", "history"], "item");

    // ---- tracker id ----
    if (typeof r.trackerId !== "string" || !TRACKER_ID_RE.test(r.trackerId)) add("bad_id", key, "trackerId must look like DA-0001 (opaque, permanent)");
    else if (ids.has(r.trackerId)) add("duplicate_id", key, "duplicate trackerId");
    else ids.add(r.trackerId);

    // ---- identity ----
    const typeOk = oneOf(r.type, TRACKER_ITEM_TYPES, "type");
    const resortOk = oneOf(r.resort, TRACKER_RESORTS, "resort");
    oneOf(r.topic, FINDING_TOPICS, "topic");
    let parkOk = true;
    if (r.parkId !== undefined) {
      if (typeof r.parkId !== "string" || !isValidParkId(r.parkId)) { add("bad_park", key, "parkId must be a known ParkId"); parkOk = false; }
      else if (resortOk && PARK_TO_RESORT[r.parkId] !== r.resort) { add("bad_park", key, "parkId does not belong to resort"); parkOk = false; }
    } else if (r.type === "entertainment") { add("missing_field", key, "entertainment items require parkId"); parkOk = false; }
    if (!nonEmpty(r.name)) { add("bad_shape", key, "name is required"); return; }
    const former = Array.isArray(r.formerNames) ? r.formerNames : r.formerNames === undefined ? [] : (add("bad_shape", key, "formerNames must be an array"), []);
    if (former.some((n: unknown) => !nonEmpty(n))) add("bad_shape", key, "formerNames entries must be non-empty strings");
    const idLike = { type: r.type as PlannerItemType, resort: r.resort as ResortId, parkId: (parkOk ? r.parkId : undefined) as ParkId | undefined };
    if (typeOk && resortOk) {
      const names = [r.name, ...former.filter(nonEmpty)];
      names.forEach((n) => {
        const ik = trackerIdentityKey(idLike, n);
        const owner = claimed.get(ik);
        if (owner !== undefined) add("duplicate_identity", key, `identity "${n}" is already claimed by ${owner}`);
        else claimed.set(ik, key);
      });
      if (parkOk && getTrackerCatalogState(idLike, r.name) === null) {
        add("unknown_identity", key, "name is not the exact canonical name of an active or legacy catalog entry for this type/resort/park");
      }
    }

    // ---- lifecycle registry reference (entertainment only; never duplicated) ----
    if (r.lifecycleRegistry !== undefined) {
      if (r.lifecycleRegistry !== true) add("bad_shape", key, "lifecycleRegistry must be true when present");
      else if (r.type !== "entertainment") add("unexpected_field", key, "lifecycleRegistry applies to entertainment items only");
      else if (parkOk && r.parkId) {
        const rk = entertainmentMappingKey(r.parkId as ParkId, r.name);
        registryKeysTracked.add(rk);
        const rec = ENTERTAINMENT_LIFECYCLE_REGISTRY.records.find((x) => lifecycleRecordKey(x) === rk);
        if (!rec) add("registry_missing", key, "no lifecycle registry record has this identity");
        else if (rec.nextReviewAction.action !== "none" && isObj(r.audit) && r.audit.status === "resolved") {
          add("registry_conflict", key, "item is resolved but its lifecycle registry record still has an unresolved review action");
        }
      }
    }

    // ---- audit ----
    let status: unknown, episode: unknown, lastReviewed: unknown;
    if (!isObj(r.audit)) add("bad_shape", key, "audit must be an object");
    else {
      const a = r.audit;
      extra(a, ["status", "episode", "action", "lastReviewed", "nextReview", "resolvedOn"], "audit");
      status = a.status; episode = a.episode;
      oneOf(status, AUDIT_STATUSES, "audit.status");
      if (!Number.isInteger(episode) || (episode as number) < 1) add("bad_shape", key, "audit.episode must be an integer ≥ 1");
      date(a.lastReviewed, "audit.lastReviewed") && (lastReviewed = a.lastReviewed);
      let nr: Record<string, unknown> | undefined;
      if (a.nextReview !== undefined) {
        if (!isObj(a.nextReview)) add("bad_shape", key, "audit.nextReview must be { date?, condition? }");
        else {
          nr = a.nextReview;
          extra(nr, ["date", "condition"], "audit.nextReview");
          if (nr.date === undefined && nr.condition === undefined) add("missing_field", key, "audit.nextReview needs a date and/or condition");
          if (nr.date !== undefined && date(nr.date, "audit.nextReview.date") && lastReviewed && nr.date < (lastReviewed as string)) add("history_order", key, "audit.nextReview.date is before lastReviewed");
          if (nr.condition !== undefined && !nonEmpty(nr.condition)) add("bad_shape", key, "audit.nextReview.condition must be non-empty");
        }
      }
      if (status === "resolved") {
        if (a.action !== undefined) add("unexpected_field", key, "resolved items carry no current action");
        if (a.nextReview !== undefined) add("unexpected_field", key, "resolved items carry no nextReview (reopen with new evidence instead)");
        if (a.resolvedOn === undefined) add("missing_field", key, "resolved items require audit.resolvedOn");
        else date(a.resolvedOn, "audit.resolvedOn");
      } else if (typeof status === "string" && (AUDIT_STATUSES as readonly string[]).includes(status)) {
        if (!nonEmpty(a.action)) add("missing_field", key, "non-resolved items require a current audit.action");
        if (a.resolvedOn !== undefined) add("unexpected_field", key, "audit.resolvedOn only applies to resolved items");
        if ((status === "monitoring" || status === "deferred") && a.nextReview === undefined) {
          add("missing_field", key, `${status} items require a nextReview date or condition`);
        }
      }
    }

    // ---- history replay ----
    if (!Array.isArray(r.history) || r.history.length === 0) { add("bad_shape", key, "history must be a non-empty array"); return; }
    let prev: { status: AuditStatus; episode: number; date: string } | null = null;
    let lastResolvedDate: string | undefined;
    let topicNow: unknown;
    const renames: Array<{ from: string; to: string }> = [];
    r.history.forEach((hRaw: unknown, j: number) => {
      const where = `history[${j}]`;
      if (!isObj(hRaw)) { add("bad_shape", key, `${where} must be an object`); prev = null; return; }
      const h = hRaw;
      extra(h, ["date", "kind", "status", "episode", "topic", "summary", "decision", "evidence", "relatedPrs", "reopenReason", "from", "to"], where);
      const dOk = date(h.date, `${where}.date`);
      const kOk = oneOf(h.kind, HISTORY_KINDS, `${where}.kind`);
      const sOk = oneOf(h.status, AUDIT_STATUSES, `${where}.status`);
      if (!Number.isInteger(h.episode) || (h.episode as number) < 1) add("bad_shape", key, `${where}.episode must be an integer ≥ 1`);
      if (!nonEmpty(h.summary)) add("bad_shape", key, `${where}.summary is required`);
      if (h.decision !== undefined && !nonEmpty(h.decision)) add("bad_shape", key, `${where}.decision must be non-empty`);

      // evidence + PR refs
      const evidence = Array.isArray(h.evidence) ? h.evidence : (add("bad_shape", key, `${where}.evidence must be an array`), []);
      evidence.forEach((e: unknown, k: number) => {
        if (!isObj(e)) { add("bad_shape", key, `${where}.evidence[${k}] must be an object`); return; }
        extra(e, ["date", "note", "url", "ref"], `${where}.evidence[${k}]`);
        date(e.date, `${where}.evidence[${k}].date`);
        if (!nonEmpty(e.note)) add("bad_shape", key, `${where}.evidence[${k}].note is required`);
        if (e.url !== undefined && !isHttpUrl(e.url)) add("bad_url", key, `${where}.evidence[${k}].url must be an http(s) URL`);
        if (e.ref !== undefined && !nonEmpty(e.ref)) add("bad_shape", key, `${where}.evidence[${k}].ref must be non-empty`);
        if (e.url === undefined && e.ref === undefined) add("evidence_unsourced", key, `${where}.evidence[${k}] needs a url or a repository ref`);
      });
      if (h.relatedPrs !== undefined) {
        if (!Array.isArray(h.relatedPrs)) add("bad_pr_ref", key, `${where}.relatedPrs must be an array`);
        else {
          h.relatedPrs.forEach((p: unknown) => { if (typeof p !== "string" || !PR_REF_RE.test(p)) add("bad_pr_ref", key, `${where}.relatedPrs entries must look like owner/repo#123`); });
          if (new Set(h.relatedPrs).size !== h.relatedPrs.length) add("bad_pr_ref", key, `${where}.relatedPrs has duplicates`);
        }
      }
      if (!dOk || !kOk || !sOk || !Number.isInteger(h.episode)) { prev = null; return; }

      const kind = h.kind as TrackerHistoryEntry["kind"];
      const st = h.status as AuditStatus;
      const ep = h.episode as number;
      const hd = h.date as string;
      const bad = (m: string) => add("bad_transition", key, `${where} (${kind}): ${m}`);
      // topic / reopenReason / from-to field applicability
      if (kind === "opened" || kind === "reopened") oneOf(h.topic, FINDING_TOPICS, `${where}.topic`);
      else if (h.topic !== undefined) add("unexpected_field", key, `${where}.topic only applies to opened/reopened`);
      if (kind === "reopened") oneOf(h.reopenReason, REOPEN_REASONS, `${where}.reopenReason`);
      else if (h.reopenReason !== undefined) add("unexpected_field", key, `${where}.reopenReason only applies to reopened`);
      if (kind === "renamed" || kind === "catalog_state_changed") {
        if (!nonEmpty(h.from) || !nonEmpty(h.to)) add("missing_field", key, `${where} (${kind}) requires from and to`);
        else if (h.from === h.to) bad("from and to must differ");
        else if (kind === "catalog_state_changed" && !((CATALOG_STATES as readonly string[]).includes(h.from as string) && (CATALOG_STATES as readonly string[]).includes(h.to as string))) {
          add("bad_enum", key, `${where} from/to must be one of ${CATALOG_STATES.join(" | ")}`);
        } else if (kind === "renamed") renames.push({ from: h.from as string, to: h.to as string });
      } else if (h.from !== undefined || h.to !== undefined) add("unexpected_field", key, `${where}.from/to only apply to renamed/catalog_state_changed`);

      if (prev === null && j === 0) {
        if (kind !== "opened") bad("first entry must be opened");
        if (ep !== 1) bad("first entry must be episode 1");
        if (st === "resolved") bad("a finding cannot open as resolved");
        topicNow = h.topic;
      } else if (prev !== null) {
        if (hd < prev.date) add("history_order", key, `${where}.date is before the previous entry (history is chronological)`);
        const wasResolved = prev.status === "resolved";
        switch (kind) {
          case "opened": bad("only the first entry may be opened (use reopened after resolution)"); break;
          case "reopened":
            if (!wasResolved) bad("only a resolved finding can be reopened");
            if (st === "resolved") bad("reopened must leave a non-resolved status");
            if (ep !== prev.episode + 1) bad("reopening starts a new episode (previous + 1)");
            if (!evidence.some((e: unknown) => isObj(e) && isRealDate(e.date) && lastResolvedDate !== undefined && e.date > lastResolvedDate)) {
              add("reopen_without_new_evidence", key, `${where}: reopening needs evidence dated after the resolution (${lastResolvedDate ?? "n/a"}) — new evidence or a new lifecycle episode, never a routine observation`);
            }
            topicNow = h.topic;
            break;
          case "resolved":
            if (wasResolved) bad("already resolved");
            if (st !== "resolved") bad("resolved entry must have status resolved");
            if (ep !== prev.episode) bad("episode must not change");
            if (evidence.length === 0) add("evidence_unsourced", key, `${where}: resolution requires sourced evidence`);
            if (!nonEmpty(h.decision)) add("missing_field", key, `${where}: resolution requires a decision stating the outcome`);
            lastResolvedDate = hd;
            break;
          case "status_changed":
            if (wasResolved) bad("a resolved finding cannot change status (reopen it)");
            if (st === "resolved") bad("use kind resolved to resolve");
            if (st === prev.status) bad("status did not change");
            if (ep !== prev.episode) bad("episode must not change");
            break;
          case "reviewed":
            if (wasResolved) bad("a resolved finding is not reviewed (reopen with new evidence)");
            if (st !== prev.status) bad("a review does not change status (use status_changed)");
            if (ep !== prev.episode) bad("episode must not change");
            if (evidence.length === 0 && !nonEmpty(h.decision)) bad("reviews are significant history only: they need evidence or a decision");
            break;
          case "renamed":
          case "catalog_state_changed":
            if (st !== prev.status) bad("identity/catalog events do not change audit status");
            if (ep !== prev.episode) bad("episode must not change");
            break;
        }
      }
      prev = { status: st, episode: ep, date: hd };
    });

    // ---- history ↔ audit / identity consistency ----
    const last = r.history[r.history.length - 1];
    if (isObj(last) && prev !== null) {
      const p = prev as { status: AuditStatus; episode: number; date: string };
      if (isObj(r.audit)) {
        if (status !== p.status) add("audit_mismatch", key, "audit.status must equal the latest history entry's status");
        if (episode !== p.episode) add("audit_mismatch", key, "audit.episode must equal the latest history entry's episode");
        if (typeof lastReviewed === "string" && lastReviewed < p.date) add("audit_mismatch", key, "audit.lastReviewed is older than the latest history entry");
        if (status === "resolved" && isRealDate(r.audit.resolvedOn) && r.audit.resolvedOn !== lastResolvedDate) {
          add("audit_mismatch", key, "audit.resolvedOn must equal the date of the resolving history entry");
        }
      }
      if (r.topic !== topicNow && topicNow !== undefined) add("audit_mismatch", key, "topic must equal the latest opened/reopened entry's topic");
    }
    const formerExpected = renames.map((x) => x.from);
    if (renames.some((x, n) => n > 0 && x.from !== renames[n - 1].to)) add("rename_mismatch", key, "renamed entries must chain (each `from` = previous `to`)");
    if (JSON.stringify(former) !== JSON.stringify(formerExpected)) add("rename_mismatch", key, "formerNames must equal the `from` values of the renamed history entries, in order");
    if (renames.length && renames[renames.length - 1].to !== r.name) add("rename_mismatch", key, "name must equal the latest renamed entry's `to`");
    if (!renames.length && former.length) add("rename_mismatch", key, "formerNames requires matching renamed history entries");
  });

  // Every lifecycle registry identity must be tracked (the registry is authoritative; the tracker is the ledger).
  for (const rec of ENTERTAINMENT_LIFECYCLE_REGISTRY.records) {
    if (!registryKeysTracked.has(lifecycleRecordKey(rec))) {
      add("registry_untracked", lifecycleRecordKey(rec), "lifecycle registry record has no tracker item with lifecycleRegistry: true");
    }
  }
  return findings;
}

// ============================================
// READ HELPERS
// ============================================

/**
 * Items the audit still owes work on: every status except `resolved`. Items with
 * a due nextReview date first (earliest first), then others oldest `lastReviewed`
 * first; ties by trackerId. Resolved findings stay in history only.
 */
export function getOutstandingTrackerItems(tracker: DataAuditTracker = DATA_AUDIT_TRACKER): TrackerItem[] {
  return tracker.items
    .filter((i) => i.audit.status !== "resolved")
    .sort((a, b) => {
      const da = a.audit.nextReview?.date, db = b.audit.nextReview?.date;
      if (da && db && da !== db) return da.localeCompare(db);
      if (da && !db) return -1;
      if (!da && db) return 1;
      return a.audit.lastReviewed.localeCompare(b.audit.lastReviewed) || a.trackerId.localeCompare(b.trackerId);
    });
}

/** The next free tracker id (max numeric + 1, zero-padded to ≥ 4 digits) for a brand-new canonical item. */
export function nextTrackerId(tracker: DataAuditTracker = DATA_AUDIT_TRACKER): string {
  const max = tracker.items.reduce((m, i) => {
    const n = TRACKER_ID_RE.test(i.trackerId) ? Number(i.trackerId.slice(3)) : 0;
    return Math.max(m, n);
  }, 0);
  return `DA-${String(max + 1).padStart(4, "0")}`;
}

/**
 * Append-only comparison of two tracker versions (PR verification: `previous`
 * = the file on origin/main). Returns violations; empty = only additions.
 * Items may not be removed or re-identified; history entries and formerNames
 * may only be appended (existing entries deep-equal); `audit`/`topic`/`name`
 * are free to move, validated separately against history.
 */
export function checkTrackerAppendOnly(previous: unknown, next: unknown): string[] {
  const out: string[] = [];
  const items = (v: unknown): TrackerItem[] => (isObj(v) && Array.isArray(v.items) ? (v.items as TrackerItem[]) : []);
  const nextById = new Map(items(next).map((i) => [i?.trackerId, i]));
  const prefix = (a: unknown[], b: unknown[]) => a.length <= b.length && a.every((x, n) => JSON.stringify(x) === JSON.stringify(b[n]));
  for (const p of items(previous)) {
    const n = nextById.get(p.trackerId);
    if (!n) { out.push(`${p.trackerId}: item removed`); continue; }
    if (n.type !== p.type || n.resort !== p.resort || n.parkId !== p.parkId) out.push(`${p.trackerId}: type/resort/parkId changed (identity is permanent)`);
    if (n.name !== p.name) {
      // A name change must be fully explained by newly appended renamed entries chaining from the previous name.
      const added = (n.history ?? []).slice((p.history ?? []).length).filter((h) => h?.kind === "renamed");
      let cur = p.name, chained = added.length > 0;
      for (const h of added) { if (h.from !== cur) { chained = false; break; } cur = h.to as string; }
      if (!chained || cur !== n.name) out.push(`${p.trackerId}: name changed from "${p.name}" to "${n.name}" without appended renamed entries chaining from the previous name`);
    }
    // Existing entries are immutable except that `relatedPrs` may gain trailing references (post-merge PR links).
    const frozen = (h: TrackerHistoryEntry) => JSON.stringify({ ...h, relatedPrs: undefined });
    const prsOk = (a?: string[], b?: string[]) => prefix(a ?? [], b ?? []);
    const ph = p.history ?? [], nh = n.history ?? [];
    if (ph.length > nh.length || ph.some((h, k) => frozen(h) !== frozen(nh[k]) || !prsOk(h.relatedPrs, nh[k].relatedPrs))) {
      out.push(`${p.trackerId}: existing history entries were edited or removed`);
    }
    if (!prefix(p.formerNames ?? [], n.formerNames ?? [])) out.push(`${p.trackerId}: formerNames were edited or removed`);
  }
  return out;
}

// ============================================
// DEV CASES (run manually; return failing labels)
// ============================================

export function runDevDataAuditTrackerCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const kindsAll = (t: unknown) => validateDataAuditTracker(t).map((f) => f.kind);
  // Fixtures omit the registry-backed items, so exclude the (separately tested) registry coverage rule.
  const kinds = (t: unknown) => kindsAll(t).filter((k) => k !== "registry_untracked");
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  const wrap = (...items: unknown[]) => ({ schemaVersion: 1, items });

  const ev = (date: string, over: Record<string, unknown> = {}) => ({ date, note: "Sourced fact", url: "https://example.com/notice", ...over });
  // Attraction fixtures (NOT in the shipped file, so shipped data edits never break them).
  const hist0 = () => ({ date: "2026-11-01", kind: "opened", status: "open", episode: 1, topic: "refurbishment", summary: "Opened", evidence: [ev("2026-11-01")], relatedPrs: ["blindxx/Disney-wait-planner#1"] });
  const item = (over: Record<string, unknown> = {}) => ({
    trackerId: "DA-0900", type: "attraction", resort: "WDW", parkId: "mk", name: "Space Mountain", topic: "refurbishment",
    audit: { status: "open", episode: 1, action: "Verify reopening date", lastReviewed: "2026-11-01" },
    history: [hist0()],
    ...over,
  });
  const resolvedItem = (over: Record<string, unknown> = {}) => item({
    audit: { status: "resolved", episode: 1, lastReviewed: "2026-11-10", resolvedOn: "2026-11-10" },
    history: [hist0(), { date: "2026-11-10", kind: "resolved", status: "resolved", episode: 1, summary: "Reopened", decision: "Closed: attraction reopened", evidence: [ev("2026-11-10")] }],
    ...over,
  });
  const reopenEntry = (over: Record<string, unknown> = {}) => ({
    date: "2026-12-01", kind: "reopened", status: "open", episode: 2, topic: "status", reopenReason: "new_evidence",
    summary: "Closed again", evidence: [ev("2026-11-30")], ...over,
  });
  const reopened = (entryOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => {
    const r = resolvedItem();
    return item({
      topic: "status",
      audit: { status: "open", episode: 2, action: "Investigate new closure", lastReviewed: "2026-12-01" },
      history: [...r.history, reopenEntry(entryOver)],
      ...over,
    });
  };

  // ---- shipped file ----
  check("shipped: tracker validates", validateDataAuditTracker().length === 0);
  const shipped = DATA_AUDIT_TRACKER.items;
  check("shipped: schemaVersion 1", DATA_AUDIT_TRACKER.schemaVersion === 1);
  check("shipped: unique trackerIds and identity keys",
    new Set(shipped.map((i) => i.trackerId)).size === shipped.length &&
    new Set(shipped.map((i) => trackerIdentityKey(i, i.name))).size === shipped.length);
  check("shipped: every lifecycle registry record is tracked exactly once",
    ENTERTAINMENT_LIFECYCLE_REGISTRY.records.every((rec) =>
      shipped.filter((i) => i.lifecycleRegistry && i.parkId && entertainmentMappingKey(i.parkId, i.name) === lifecycleRecordKey(rec)).length === 1));
  check("shipped: lifecycle-registry-backed items are entertainment and never copy lifecycle fields (other items may be added later)",
    shipped.filter((i) => i.lifecycleRegistry).every((i) => i.type === "entertainment"));
  check("shipped: tracker does not copy lifecycle assessment/evidence fields",
    shipped.every((i) => !("assessment" in i) && !("providerEvidence" in i) && !("verificationSources" in i)));
  check("shipped: audit statuses mirror the registry's unresolved set (none resolved while registry action ≠ none)",
    getUnresolvedLifecycleRecords().every((rec) =>
      shipped.find((i) => i.parkId && entertainmentMappingKey(i.parkId, i.name) === lifecycleRecordKey(rec))?.audit.status !== "resolved"));
  check("shipped: outstanding set excludes resolved only", getOutstandingTrackerItems().length === shipped.filter((i) => i.audit.status !== "resolved").length);
  check("shipped: nextTrackerId is unused", !shipped.some((i) => i.trackerId === nextTrackerId()));
  check("shipped: append-only against itself", checkTrackerAppendOnly(DATA_AUDIT_TRACKER, DATA_AUDIT_TRACKER).length === 0);

  // ---- schema ----
  check("schema: valid open attraction item passes", kinds(wrap(item())).length === 0);
  check("schema: a tracker missing registry-backed items is flagged (empty fixture)",
    ENTERTAINMENT_LIFECYCLE_REGISTRY.records.length === 0 || kindsAll(wrap()).includes("registry_untracked"));
  check("schema: non-object rejected", kinds(null).includes("bad_shape"));
  check("schema: wrong schemaVersion rejected", kinds({ schemaVersion: 2, items: [] }).includes("bad_shape"));
  check("schema: unknown top-level field rejected", kinds({ schemaVersion: 1, items: [], x: 1 }).includes("unknown_field"));
  check("schema: unknown item field rejected", kinds(wrap(item({ surprise: 1 }))).includes("unknown_field"));
  check("schema: bad trackerId format rejected", kinds(wrap(item({ trackerId: "mk-space-mountain" }))).includes("bad_id"));
  check("schema: bad status / type / topic rejected",
    kinds(wrap(item({ audit: { status: "done", episode: 1, action: "x", lastReviewed: "2026-11-01" } }))).includes("bad_enum") &&
    kinds(wrap(item({ type: "show" }))).includes("bad_enum") && kinds(wrap(item({ topic: "vibes" }))).includes("bad_enum"));
  check("schema: impossible date rejected", kinds(wrap(item({ audit: { status: "open", episode: 1, action: "x", lastReviewed: "2026-02-30" } }))).includes("bad_date"));
  check("schema: evidence without url/ref rejected",
    kinds(wrap(item({ history: [{ ...hist0(), evidence: [{ date: "2026-11-01", note: "trust me" }] }] }))).includes("evidence_unsourced"));
  check("schema: repository ref evidence accepted",
    kinds(wrap(item({ history: [{ ...hist0(), evidence: [{ date: "2026-11-01", note: "In repo", ref: "apps/web/src/data/x.json#a" }] }] }))).length === 0);
  check("schema: bad PR reference rejected", kinds(wrap(item({ history: [{ ...hist0(), relatedPrs: ["#12"] }] }))).includes("bad_pr_ref"));
  check("schema: non-http evidence url rejected", kinds(wrap(item({ history: [{ ...hist0(), evidence: [ev("2026-11-01", { url: "javascript:alert(1)" })] }] }))).includes("bad_url"));

  // ---- identity ----
  check("identity: duplicate trackerId rejected", kinds(wrap(item(), item({ name: "Big Thunder Mountain Railroad" }))).includes("duplicate_id"));
  check("identity: duplicate canonical identity under another id rejected (even via normalization)",
    kinds(wrap(item(), item({ trackerId: "DA-0901", name: "space mountain" }))).includes("duplicate_identity"));
  check("identity: same name in different parks/types is distinct",
    !kinds(wrap(item(), item({ trackerId: "DA-0901", resort: "DLR", parkId: "disneyland", name: "Space Mountain" }))).includes("duplicate_identity"));
  check("identity: unknown name rejected", kinds(wrap(item({ name: "Not A Real Ride" }))).includes("unknown_identity"));
  check("identity: alias/near-miss is not canonical", kinds(wrap(item({ name: "Space Mountain Ride Extra" }))).includes("unknown_identity"));
  check("identity: omitting parkId for a park-qualified catalog item is rejected, and cannot split the ID",
    kinds(wrap(item({ parkId: undefined }))).includes("unknown_identity") &&
    kinds(wrap(item(), item({ trackerId: "DA-0901", parkId: undefined }))).includes("duplicate_identity"));
  check("identity: non-entertainment identity ignores park scope (legacy item with/without parkId collides)",
    kinds(wrap(item({ name: "Splash Mountain", parkId: undefined }), item({ trackerId: "DA-0901", name: "Splash Mountain", parkId: "mk" }))).includes("duplicate_identity"));
  check("identity: wrong park rejected", kinds(wrap(item({ parkId: "epcot" }))).includes("unknown_identity"));
  check("identity: park must belong to resort", kinds(wrap(item({ resort: "DLR" }))).includes("bad_park"));
  check("identity: entertainment requires parkId", kinds(wrap(item({ type: "entertainment", parkId: undefined, name: "Wondrous Journeys" }))).includes("missing_field"));
  check("identity: catalog state derived, not stored (active attraction + entertainment, unknown → null)",
    getTrackerCatalogState({ type: "attraction", resort: "WDW", parkId: "mk" }, "Space Mountain") === "active" &&
    getTrackerCatalogState({ type: "entertainment", resort: "DLR", parkId: "disneyland" }, "Wondrous Journeys") === "active" &&
    getTrackerCatalogState({ type: "entertainment", resort: "DLR", parkId: "disneyland" }, "Together Forever — A Pixar Nighttime Spectacular") === "legacy" &&
    getTrackerCatalogState({ type: "attraction", resort: "WDW" }, "Splash Mountain") === "legacy" &&
    getTrackerCatalogState({ type: "attraction", resort: "WDW" }, "Nope") === null);
  check("identity: legacy identity is valid (Active→Legacy keeps the same tracker item)",
    !kinds(wrap(item({ name: "Splash Mountain", parkId: undefined }))).includes("unknown_identity"));
  check("identity: lifecycleRegistry applies to entertainment only",
    kinds(wrap(item({ lifecycleRegistry: true }))).includes("unexpected_field"));
  check("identity: lifecycleRegistry pointing at no registry record rejected (Fantasmic! at HS is active, not in the registry)",
    kinds(wrap(item({ type: "entertainment", resort: "WDW", parkId: "hs", name: "Fantasmic!", lifecycleRegistry: true }))).includes("registry_missing"));

  // ---- renames (identity preserved) ----
  const renamed = () => item({
    name: "Big Thunder Mountain Railroad", formerNames: ["Space Mountain"],
    history: [hist0(), { date: "2026-11-05", kind: "renamed", status: "open", episode: 1, summary: "Canonical rename", from: "Space Mountain", to: "Big Thunder Mountain Railroad", evidence: [ev("2026-11-05")] }],
    audit: { status: "open", episode: 1, action: "Verify reopening date", lastReviewed: "2026-11-05" },
  });
  check("rename: rename keeps trackerId and validates", kinds(wrap(renamed())).length === 0);
  check("rename: another item cannot claim the former name",
    kinds(wrap(renamed(), item({ trackerId: "DA-0901" }))).includes("duplicate_identity"));
  check("rename: formerNames without renamed entry rejected", kinds(wrap(item({ formerNames: ["X Ride"] }))).includes("rename_mismatch"));
  check("rename: name must match latest renamed.to", kinds(wrap(item({ ...renamed(), name: "Space Mountain" }))).includes("rename_mismatch"));
  check("rename: renamed entry cannot change audit status",
    kinds(wrap({ ...renamed(), history: [hist0(), { ...renamed().history[1], status: "monitoring" }] })).includes("bad_transition"));

  // ---- statuses ----
  check("status: monitoring requires nextReview", kinds(wrap(item({ audit: { status: "monitoring", episode: 1, action: "Watch", lastReviewed: "2026-11-01" }, history: [{ ...hist0(), status: "monitoring" }] }))).includes("missing_field"));
  check("status: deferred with condition-only nextReview passes",
    kinds(wrap(item({ audit: { status: "deferred", episode: 1, action: "Wait", lastReviewed: "2026-11-01", nextReview: { condition: "Official 2027 announcement" } }, history: [{ ...hist0(), status: "deferred" }] }))).length === 0);
  check("status: pending_implementation passes without nextReview",
    kinds(wrap(item({ audit: { status: "pending_implementation", episode: 1, action: "Land catalog change", lastReviewed: "2026-11-01" }, history: [{ ...hist0(), status: "pending_implementation" }] }))).length === 0);
  check("status: non-resolved requires an action", kinds(wrap(item({ audit: { status: "open", episode: 1, lastReviewed: "2026-11-01" } }))).includes("missing_field"));
  check("status: empty nextReview rejected", kinds(wrap(item({ audit: { status: "open", episode: 1, action: "x", lastReviewed: "2026-11-01", nextReview: {} } }))).includes("missing_field"));
  check("status: nextReview date before lastReviewed rejected", kinds(wrap(item({ audit: { status: "open", episode: 1, action: "x", lastReviewed: "2026-11-01", nextReview: { date: "2026-10-01" } } }))).includes("history_order"));
  check("status: audit.status must equal latest history status",
    kinds(wrap(item({ audit: { status: "monitoring", episode: 1, action: "x", lastReviewed: "2026-11-01", nextReview: { condition: "c" } } }))).includes("audit_mismatch"));
  check("status: lastReviewed older than latest history rejected",
    kinds(wrap(item({ audit: { status: "open", episode: 1, action: "x", lastReviewed: "2026-10-01" } }))).includes("audit_mismatch"));
  check("status: lastReviewed may be newer than latest significant entry (routine review, no history entry)",
    kinds(wrap(item({ audit: { status: "open", episode: 1, action: "x", lastReviewed: "2026-11-20" } }))).length === 0);

  // ---- history transitions / resolution / reopening ----
  check("history: resolved item validates and is excluded from outstanding",
    kinds(wrap(resolvedItem())).length === 0 &&
    getOutstandingTrackerItems(wrap(resolvedItem(), item({ trackerId: "DA-0901", name: "Big Thunder Mountain Railroad" })) as unknown as DataAuditTracker).map((i) => i.trackerId).join() === "DA-0901");
  check("history: resolved item keeps its full history", resolvedItem().history.length === 2);
  check("history: resolved must not carry action/nextReview", kinds(wrap(resolvedItem({ audit: { status: "resolved", episode: 1, lastReviewed: "2026-11-10", resolvedOn: "2026-11-10", action: "x" } }))).includes("unexpected_field"));
  check("history: resolution requires evidence and a decision",
    kinds(wrap(resolvedItem({ history: [hist0(), { date: "2026-11-10", kind: "resolved", status: "resolved", episode: 1, summary: "Done", evidence: [] }] }))).includes("evidence_unsourced") &&
    kinds(wrap(resolvedItem({ history: [hist0(), { date: "2026-11-10", kind: "resolved", status: "resolved", episode: 1, summary: "Done", evidence: [ev("2026-11-10")] }] }))).includes("missing_field"));
  check("history: resolvedOn must match resolving entry", kinds(wrap(resolvedItem({ audit: { status: "resolved", episode: 1, lastReviewed: "2026-11-10", resolvedOn: "2026-11-09" } }))).includes("audit_mismatch"));
  check("history: first entry must be opened, episode 1", kinds(wrap(item({ history: [{ ...hist0(), kind: "reviewed" }] }))).includes("bad_transition") && kinds(wrap(item({ history: [{ ...hist0(), episode: 2 }] }))).includes("bad_transition"));
  check("history: chronological order enforced",
    kinds(wrap(item({ history: [hist0(), { date: "2026-10-01", kind: "reviewed", status: "open", episode: 1, summary: "Back-dated", decision: "d", evidence: [] }] }))).includes("history_order"));
  check("history: routine review without evidence/decision rejected (no routine observations)",
    kinds(wrap(item({ history: [hist0(), { date: "2026-11-02", kind: "reviewed", status: "open", episode: 1, summary: "Still same", evidence: [] }] }))).includes("bad_transition"));
  check("history: review with evidence is accepted",
    kinds(wrap(item({ history: [hist0(), { date: "2026-11-02", kind: "reviewed", status: "open", episode: 1, summary: "New notice", evidence: [ev("2026-11-02")] }], audit: { status: "open", episode: 1, action: "x", lastReviewed: "2026-11-02" } }))).length === 0);
  check("history: status change recorded and replayed",
    kinds(wrap(item({ history: [hist0(), { date: "2026-11-02", kind: "status_changed", status: "monitoring", episode: 1, summary: "Watching", decision: "Monitor", evidence: [] }], audit: { status: "monitoring", episode: 1, action: "Watch", lastReviewed: "2026-11-02", nextReview: { condition: "c" } } }))).length === 0);
  check("history: reviewed cannot silently change status", kinds(wrap(item({ history: [hist0(), { date: "2026-11-02", kind: "reviewed", status: "monitoring", episode: 1, summary: "s", decision: "d", evidence: [] }], audit: { status: "monitoring", episode: 1, action: "x", lastReviewed: "2026-11-02", nextReview: { condition: "c" } } }))).includes("bad_transition"));
  check("reopen: valid reopening (new episode, newer evidence) passes", kinds(wrap(reopened())).length === 0);
  check("reopen: reuses the same trackerId (no second record)", reopened().trackerId === resolvedItem().trackerId);
  check("reopen: new_lifecycle_episode reason accepted", kinds(wrap(reopened({ reopenReason: "new_lifecycle_episode" }))).length === 0);
  check("reopen: evidence not newer than the resolution rejected", kinds(wrap(reopened({ evidence: [ev("2026-11-10")] }))).includes("reopen_without_new_evidence"));
  check("reopen: no evidence rejected", kinds(wrap(reopened({ evidence: [] }))).includes("reopen_without_new_evidence"));
  check("reopen: episode must increment", kinds(wrap(reopened({ episode: 1 }))).includes("bad_transition"));
  check("reopen: unresolved finding cannot be 'reopened'",
    kinds(wrap(item({ history: [hist0(), reopenEntry({ date: "2026-11-02", evidence: [ev("2026-11-02")] })], audit: { status: "open", episode: 2, action: "x", lastReviewed: "2026-11-02" }, topic: "status" }))).includes("bad_transition"));
  check("reopen: status change on a resolved finding without reopening rejected",
    kinds(wrap(item({ audit: { status: "open", episode: 1, action: "x", lastReviewed: "2026-12-01" }, history: [...resolvedItem().history, { date: "2026-12-01", kind: "status_changed", status: "open", episode: 1, summary: "s", decision: "d", evidence: [ev("2026-12-01")] }] }))).includes("bad_transition"));
  check("reopen: reopened requires reopenReason and topic", kinds(wrap(reopened({ reopenReason: undefined }))).includes("bad_enum") && kinds(wrap(reopened({ topic: undefined }))).includes("bad_enum"));
  check("reopen: item topic must follow the reopening topic", kinds(wrap(reopened({}, { topic: "refurbishment" }))).includes("audit_mismatch"));
  check("reopen: audit episode must match", kinds(wrap(reopened({}, { audit: { status: "open", episode: 1, action: "x", lastReviewed: "2026-12-01" } }))).includes("audit_mismatch"));
  check("reopen: catalog_state_changed on a resolved item keeps it resolved (no reopen)",
    kinds(wrap(resolvedItem({ history: [...resolvedItem().history, { date: "2026-11-12", kind: "catalog_state_changed", status: "resolved", episode: 1, summary: "Moved to legacy", from: "active", to: "legacy", evidence: [ev("2026-11-12")] }], audit: { status: "resolved", episode: 1, lastReviewed: "2026-11-12", resolvedOn: "2026-11-10" } }))).length === 0);
  check("reopen: catalog_state_changed needs active|legacy and differing values",
    kinds(wrap(item({ history: [hist0(), { date: "2026-11-02", kind: "catalog_state_changed", status: "open", episode: 1, summary: "s", from: "active", to: "gone", evidence: [] }] }))).includes("bad_enum") &&
    kinds(wrap(item({ history: [hist0(), { date: "2026-11-02", kind: "catalog_state_changed", status: "open", episode: 1, summary: "s", from: "legacy", to: "legacy", evidence: [] }] }))).includes("bad_transition"));

  // ---- lifecycle registry linkage ----
  check("registry: shipped registry-backed items track real records (validator-enforced)", ENTERTAINMENT_LIFECYCLE_REGISTRY.records.length === 0 || shipped.some((i) => i.lifecycleRegistry === true));
  const missingOne = clone(DATA_AUDIT_TRACKER);
  { const at = missingOne.items.findIndex((i) => i.lifecycleRegistry === true); if (at >= 0) missingOne.items.splice(at, 1); }
  check("registry: dropping a registry-backed item is flagged", ENTERTAINMENT_LIFECYCLE_REGISTRY.records.length === 0 || kindsAll(missingOne).includes("registry_untracked"));
  const rec0 = ENTERTAINMENT_LIFECYCLE_REGISTRY.records.find((r) => r.nextReviewAction.action !== "none");
  const conflictT = clone(DATA_AUDIT_TRACKER);
  const ci = conflictT.items.find((i) => rec0 && i.parkId === rec0.parkId && normalizeKey(i.name) === normalizeKey(rec0.name));
  if (ci) {
    ci.audit = { status: "resolved", episode: ci.audit.episode, lastReviewed: ci.audit.lastReviewed, resolvedOn: ci.audit.lastReviewed };
  }
  check("registry: resolving an item whose registry record is still unresolved is flagged", !ci || kinds(conflictT).includes("registry_conflict"));

  // ---- append-only comparison ----
  const base = wrap(item(), resolvedItem({ trackerId: "DA-0901", name: "Big Thunder Mountain Railroad" }));
  const appended = clone(base); (appended.items[0] as TrackerItem).history.push({ date: "2026-11-02", kind: "reviewed", status: "open", episode: 1, summary: "s", decision: "d", evidence: [] });
  check("append-only: appending history is allowed", checkTrackerAppendOnly(base, appended).length === 0);
  const removed = clone(base); removed.items.pop();
  check("append-only: removing an item is rejected", checkTrackerAppendOnly(base, removed).length === 1);
  const edited = clone(base); (edited.items[1] as TrackerItem).history[0].summary = "Rewritten";
  check("append-only: editing past history is rejected", checkTrackerAppendOnly(base, edited).some((m) => m.includes("history")));
  const dropped = clone(base); (dropped.items[1] as TrackerItem).history.pop();
  check("append-only: deleting history is rejected", checkTrackerAppendOnly(base, dropped).some((m) => m.includes("history")));
  const reid = clone(base); (reid.items[0] as TrackerItem).parkId = "ak"; (reid.items[0] as TrackerItem).resort = "WDW";
  check("append-only: re-identifying an item is rejected", checkTrackerAppendOnly(base, reid).some((m) => m.includes("permanent")));
  const renameOk = clone(base); { const t = renameOk.items[0] as TrackerItem; t.name = "Big Thunder Mountain Railroad"; t.formerNames = ["Space Mountain"];
    t.history.push({ date: "2026-11-02", kind: "renamed", status: "open", episode: 1, summary: "s", from: "Space Mountain", to: "Big Thunder Mountain Railroad", evidence: [ev("2026-11-02")] }); }
  check("append-only: a rename with an appended chained renamed entry is allowed", checkTrackerAppendOnly(base, renameOk).length === 0);
  const silentRename = clone(base); (silentRename.items[0] as TrackerItem).name = "Big Thunder Mountain Railroad";
  check("append-only: changing name without a renamed entry is rejected", checkTrackerAppendOnly(base, silentRename).some((m) => m.includes("name changed")));
  const badChain = clone(renameOk); ((badChain.items[0] as TrackerItem).history[1] as TrackerHistoryEntry).from = "Pirates of the Caribbean";
  check("append-only: renamed entry not chaining from the previous name is rejected", checkTrackerAppendOnly(base, badChain).some((m) => m.includes("name changed")));
  const prAppend = clone(base); { const h = (prAppend.items[0] as TrackerItem).history[0]; h.relatedPrs = [...(h.relatedPrs ?? []), "blindxx/Disney-wait-planner#999"]; }
  check("append-only: appending a PR reference to an existing entry is allowed (and validates)",
    checkTrackerAppendOnly(base, prAppend).length === 0 && kinds(prAppend).length === 0);
  const prDrop = clone(prAppend); (prDrop.items[0] as TrackerItem).history[0].relatedPrs = ["blindxx/Disney-wait-planner#999"];
  check("append-only: removing/replacing an existing PR reference is rejected", checkTrackerAppendOnly(prAppend, prDrop).some((m) => m.includes("history")));
  const prEdit = clone(base); (prEdit.items[0] as TrackerItem).history[0].relatedPrs = ["blindxx/Disney-wait-planner#2"];
  check("append-only: rewriting an existing PR reference is rejected", checkTrackerAppendOnly(base, prEdit).some((m) => m.includes("history")));
  const futureItem = clone(DATA_AUDIT_TRACKER); futureItem.items.push(item({ trackerId: nextTrackerId() }) as TrackerItem);
  check("shipped-ledger growth: a valid non-entertainment item added to the shipped ledger leaves every ledger-dependent check applicable",
    validateDataAuditTracker(futureItem).length === 0 && futureItem.items.length === shipped.length + 1);
  check("append-only: adding a new item is allowed", checkTrackerAppendOnly(base, { ...base, items: [...base.items, item({ trackerId: "DA-0902", name: "Pirates of the Caribbean" })] }).length === 0);
  check("nextTrackerId: max + 1", nextTrackerId(base as unknown as DataAuditTracker) === "DA-0902");

  return failures;
}

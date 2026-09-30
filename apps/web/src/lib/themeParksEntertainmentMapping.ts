/**
 * themeParksEntertainmentMapping.ts — explicit DWP Entertainment → ThemeParks.wiki
 * entity UUID mapping (Phase 12.2).
 *
 * Integration metadata ONLY. DWP's curated `ENTERTAINMENT_PLACES`
 * (entertainmentSuggestions.ts) stays the canonical identity/name/type/
 * location/lifecycle authority; a provider UUID just says "this DWP entry is
 * that provider entity" so later phases can attach provider showtimes. This
 * module never renames, re-parks, or adds/removes DWP catalog entries.
 *
 * Model
 * - One explicit disposition per ACTIVE DWP entertainment entry, keyed by
 *   (park, name) — never by name alone: "Fantasmic!", "Enchanted Tiki Room",
 *   "Turtle Talk with Crush" and "Disney Jr. Mickey Mouse Clubhouse Live!"
 *   each exist in two parks/resorts and stay distinct.
 *   - "mapped":   one or more provider refs (a DWP offering can be presented
 *                 as more than one provider entity, e.g. Halloween Screams
 *                 "with Fireworks"/"with Projections", or Bluey as both a
 *                 SHOW and an ATTRACTION record).
 *   - "unmapped": intentionally no provider entity, with a reason (dormant /
 *                 seasonal / not present in the provider's park children).
 * - Legacy-only entertainment (LEGACY_ENTERTAINMENT_PLACES) is out of scope.
 * - No runtime fuzzy/name-based remapping: lookups are exact-key against this
 *   table. Provider drift (entity gone, moved park, changed type, renamed)
 *   surfaces as a finding from `verifyEntertainmentMapping`; it never
 *   silently remaps.
 *
 * Provider-only entertainment
 * - Provider SHOW entities with no DWP mapping (character meets, street bands,
 *   party-only shows, ...) are NOT errors and are NOT discarded: the verifier
 *   returns them, normalized, per park in `providerOnly`. They are not added
 *   to DWP Entertainment or Smart Entry — a later phase may consume them.
 *
 * Pure module (types-only import from themeParksApi.ts; no I/O) so the DEV
 * cases run offline. Provider snapshot verified 2026-09-30 against
 * `GET /v1/entity/{park}/children`.
 */

import type { ParkId } from "@disney-wait-planner/shared";
import { ENTERTAINMENT_PLACES } from "./entertainmentSuggestions";
import { normalizeKey } from "./plansMatching";
import { THEMEPARKS_PARKS } from "./themeParksProviders";
import type { ThemeParksChild, ThemeParksChildren } from "./themeParksApi";

// ============================================
// TYPES
// ============================================

export type ProviderEntertainmentType = "SHOW" | "ATTRACTION";

export interface ProviderEntityRef {
  /** Provider entity UUID (lowercase-canonical). */
  entityId: string;
  /** Provider entityType expected for this entity (drift is reported). */
  entityType: ProviderEntertainmentType;
  /** Provider's display name when verified — informational; drift is reported, never remapped. */
  providerName: string;
}

export type EntertainmentProviderMapping =
  | { dwpName: string; parkId: ParkId; disposition: "mapped"; provider: ProviderEntityRef[] }
  | { dwpName: string; parkId: ParkId; disposition: "unmapped"; reason: string };

export type MappingFindingKind =
  // structural (offline)
  | "missing_disposition"
  | "orphan_mapping"
  | "duplicate_mapping"
  | "invalid_uuid"
  | "duplicate_provider_id"
  | "empty_provider_refs"
  // provider verification
  | "park_payload_missing"
  | "entity_missing"
  | "wrong_park"
  | "parent_mismatch"
  | "type_mismatch"
  | "name_drift";

export interface MappingFinding {
  kind: MappingFindingKind;
  /** error fails the audit; warning (name_drift) is surfaced but does not. */
  severity: "error" | "warning";
  /** `${parkId}:${normalizeKey(dwpName)}` or a provider id for provider-level findings. */
  key: string;
  detail: string;
}

export interface EntertainmentMappingReport {
  /** True iff there are no error-severity findings. */
  ok: boolean;
  findings: MappingFinding[];
  /** DWP entries whose every provider ref verified (key → refs). */
  verified: Array<{ key: string; dwpName: string; parkId: ParkId; provider: ProviderEntityRef[] }>;
  /** Intentionally unmapped DWP entries (with reasons). */
  unmapped: Array<{ key: string; dwpName: string; parkId: ParkId; reason: string }>;
  /**
   * Provider SHOW entities not mapped to any DWP entry, per park. Preserved,
   * normalized; not errors; never added to the DWP catalog.
   */
  providerOnly: Partial<Record<ParkId, ThemeParksChild[]>>;
  /** Malformed child records dropped by validation, per park. */
  droppedChildren: Partial<Record<ParkId, number>>;
}

// ============================================
// MAPPING DATA
// ============================================

export function entertainmentMappingKey(parkId: ParkId, dwpName: string): string {
  return `${parkId}:${normalizeKey(dwpName)}`;
}

const show = (entityId: string, providerName: string): ProviderEntityRef => ({ entityId, entityType: "SHOW", providerName });
const attraction = (entityId: string, providerName: string): ProviderEntityRef => ({ entityId, entityType: "ATTRACTION", providerName });
const mapped = (dwpName: string, parkId: ParkId, ...provider: ProviderEntityRef[]): EntertainmentProviderMapping =>
  ({ dwpName, parkId, disposition: "mapped", provider });
const unmapped = (dwpName: string, parkId: ParkId, reason: string): EntertainmentProviderMapping =>
  ({ dwpName, parkId, disposition: "unmapped", reason });

const NOT_IN_PROVIDER = "No matching entity in the provider's park children (dormant/not currently listed)";

export const THEMEPARKS_ENTERTAINMENT_MAPPING: EntertainmentProviderMapping[] = [
  // ---- Disneyland Park ----
  mapped("Fantasmic!", "disneyland", show("8c36ff0b-3a32-4d7b-9388-0516c19277db", "Fantasmic!")),
  unmapped("Wondrous Journeys", "disneyland", NOT_IN_PROVIDER),
  unmapped("Magic Happens Parade", "disneyland", `${NOT_IN_PROVIDER}; returns summer 2027`),
  mapped("Enchanted Tiki Room", "disneyland", attraction("106c1e5a-a5e7-42d7-96ab-bc100d8faf71", "Walt Disney's Enchanted Tiki Room")),
  unmapped("Paint the Night", "disneyland", NOT_IN_PROVIDER),
  mapped(
    "Halloween Screams", "disneyland",
    show("0bd8e001-83f8-4c9e-9e14-df5a2d6400c3", "Halloween Screams with Fireworks"),
    show("7bedcc70-2443-4b54-9815-b41d3a3a59f2", "Halloween Screams with Projections"),
  ),
  unmapped("Believe... in Holiday Magic", "disneyland", `${NOT_IN_PROVIDER} (Christmas seasonal)`),
  unmapped("A Christmas Fantasy Parade", "disneyland", `${NOT_IN_PROVIDER} (Christmas seasonal)`),
  unmapped("Main Street Electrical Parade", "disneyland", NOT_IN_PROVIDER),
  unmapped("Royal Princess Cavalcade", "disneyland", NOT_IN_PROVIDER),
  unmapped("Mickey's Mix Magic", "disneyland", NOT_IN_PROVIDER),
  mapped(
    "Bluey's Best Day Ever!", "disneyland",
    show("95a9cde3-ff1f-40a3-8276-2477ded688f8", "Bluey's Best Day Ever!"),
    attraction("888525b0-5a6f-4b8e-9f07-b6a32812b04d", "Bluey’s Best Day Ever! at Fantasyland Theatre"),
  ),
  mapped("Mickey & Friends Halloween Cavalcade", "disneyland", show("e1cb16d6-ac90-44e6-9711-6729650623a1", "Mickey and Friends Halloween Cavalcade")),

  // ---- Disney California Adventure ----
  mapped("World of Color", "dca", show("e46d8982-4991-4b9e-8e4a-b519d3ca6060", "World of Color – ONE")),
  mapped("Turtle Talk with Crush", "dca", attraction("7561bcd8-18ea-4e3f-89d5-c905b7ba3d42", "Turtle Talk with Crush")),
  unmapped("Frightfully Fun Parade", "dca", `${NOT_IN_PROVIDER}; replaced for 2026 by Madame Leota's Swinging Wake`),
  unmapped("Disney Jr. Mickey Mouse Clubhouse Live!", "dca", NOT_IN_PROVIDER),
  mapped(
    "Madame Leota's Swinging Wake – A Haunted Mansion Street Party", "dca",
    show("26468072-7cdf-4d3b-a5fb-b110d51b177f", "Madame Leota's Swinging Wake – A Haunted Mansion Street Party at Oogie Boogie Bash"),
  ),

  // ---- Magic Kingdom ----
  mapped("Happily Ever After", "mk", show("22b78ed9-a692-47cb-b6a4-6d1224ff67e3", "Happily Ever After")),
  mapped("Disney Starlight: Dream the Night Away", "mk", show("d69261dc-62b8-434c-83bd-93649b43c408", "Disney Starlight: Dream the Night Away")),
  mapped("Festival of Fantasy Parade", "mk", show("ee56b2f3-fd49-4a29-ae1a-2d321549a633", "Disney Festival of Fantasy Parade")),
  mapped("Mickey's PhilharMagic", "mk", attraction("7c5e1e02-3a44-4151-9005-44066d5ba1da", "Mickey's PhilharMagic")),
  mapped("Enchanted Tiki Room", "mk", attraction("6fd1e225-53a0-4a80-a577-4bbc9a471075", "Walt Disney's Enchanted Tiki Room")),
  mapped("Country Bear Musical Jamboree", "mk", attraction("0f57cecf-5502-4503-8bc3-ba84d3708ace", "Country Bear Musical Jamboree")),
  mapped("Disney Adventure Friends Cavalcade", "mk", show("f819079e-644e-4fce-bda3-26b899ac7027", "Disney Adventure Friends Cavalcade")),
  mapped("Mickey's Boo-To-You Halloween Parade", "mk", show("5c00cd7c-b207-4d9d-9c8c-a8d418fc5425", "Mickey’s Boo-To-You Halloween Parade at Mickey's Not-So-Scary Halloween Party")),
  unmapped("Mickey's Once Upon a Christmastime Parade", "mk", `${NOT_IN_PROVIDER} (Christmas seasonal)`),
  mapped("Disney's Not-So-Spooky Spectacular", "mk", show("05ca3e51-580b-44ca-8046-7d3e57a6d248", "Disney’s Not-So-Spooky Spectacular at Mickey's Not-So-Scary Halloween Party")),
  mapped("Hocus Pocus Villain Spelltacular", "mk", show("6d74b3d9-f977-4c9b-8114-93969b51b105", "Hocus Pocus Villain Spelltacular")),
  unmapped("Minnie's Wonderful Christmastime Fireworks", "mk", `${NOT_IN_PROVIDER} (Christmas seasonal)`),
  unmapped("Mickey's Most Merriest Celebration", "mk", `${NOT_IN_PROVIDER} (Christmas seasonal)`),

  // ---- EPCOT ----
  mapped("Turtle Talk with Crush", "epcot", attraction("57acb522-a6fc-4aa4-a80e-21f21f317250", "Turtle Talk With Crush")),
  mapped("Luminous The Symphony of Us", "epcot", show("3dbf1ff2-eee0-44a9-8cd9-22bf920e81e9", "Luminous The Symphony of Us")),

  // ---- Hollywood Studios ----
  mapped("Fantasmic!", "hs", show("42328c39-76ab-4f03-b862-4206c8d9f7bb", "Fantasmic!")),
  mapped("Beauty and the Beast Live on Stage", "hs", show("375197ac-27ac-41f7-bd93-f4e9b9fc4d5d", "Beauty and the Beast – Live on Stage")),
  mapped("For the First Time in Forever: A Frozen Sing-Along Celebration", "hs", show("d91a0e9a-8652-4036-822f-e7b12b381273", "For the First Time in Forever: A Frozen Sing-Along Celebration")),
  mapped("Indiana Jones Epic Stunt Spectacular", "hs", show("7357772c-6b11-4a8d-af97-05a1bb45f001", "Indiana Jones™ Epic Stunt Spectacular!")),
  mapped("Wonderful World of Animation", "hs", show("b1ed574f-40f2-4132-a1ee-893a276633c8", "Wonderful World of Animation")),
  mapped("Disney Movie Magic", "hs", show("90ab2c64-e05c-4783-bde5-fddf41f78402", "Disney Movie Magic")),
  mapped("Disney Villains: Unfairly Ever After", "hs", show("69cb35f2-c58e-4b44-88c9-ea0cc720e075", "Disney Villains: Unfairly Ever After")),
  mapped("The Little Mermaid – A Musical Adventure", "hs", show("a7763ca6-bca3-4e78-b75c-22886aa06bec", "The Little Mermaid – A Musical Adventure")),
  mapped("Disney Jr. Mickey Mouse Clubhouse Live!", "hs", show("1bbce25c-36eb-4d16-9216-4a1bbd46932b", "Disney Jr. Mickey Mouse Clubhouse Live!")),
  unmapped("Once Upon a Studio Theater", "hs", `${NOT_IN_PROVIDER}; no distinct provider entity (venue-hosted)`),

  // ---- Animal Kingdom ----
  mapped("Festival of the Lion King", "ak", show("3a4e0f49-f9ff-4481-a95b-d4952cdf6097", "Festival of the Lion King")),
  mapped("Finding Nemo: The Big Blue... and Beyond!", "ak", show("95712b31-ceed-4f7d-be3e-3d5e6badac5c", "Finding Nemo: The Big Blue... and Beyond!")),
  mapped("Zootopia: Better Zoogether!", "ak", attraction("1b15c77b-0311-4171-8e59-7f38e6d60754", "Zootopia: Better Zoogether!")),
];

const MAPPING_BY_KEY: Map<string, EntertainmentProviderMapping> = new Map();
const DWP_BY_PROVIDER_ID: Map<string, { dwpName: string; parkId: ParkId }> = new Map();
for (const m of THEMEPARKS_ENTERTAINMENT_MAPPING) {
  const key = entertainmentMappingKey(m.parkId, m.dwpName);
  if (!MAPPING_BY_KEY.has(key)) MAPPING_BY_KEY.set(key, m);
  if (m.disposition === "mapped") {
    for (const ref of m.provider) {
      if (!DWP_BY_PROVIDER_ID.has(ref.entityId)) DWP_BY_PROVIDER_ID.set(ref.entityId, { dwpName: m.dwpName, parkId: m.parkId });
    }
  }
}

// ============================================
// LOOKUPS (exact key only — never name-based remapping)
// ============================================

/** Explicit disposition for an active DWP entertainment entry, or undefined. */
export function getEntertainmentProviderMapping(dwpName: string, parkId: ParkId): EntertainmentProviderMapping | undefined {
  return MAPPING_BY_KEY.get(entertainmentMappingKey(parkId, dwpName));
}

/** Provider refs for a DWP entry; empty when unmapped/unknown. Park is required (names repeat across parks). */
export function getThemeParksEntertainmentRefs(dwpName: string, parkId: ParkId): ProviderEntityRef[] {
  const m = getEntertainmentProviderMapping(dwpName, parkId);
  return m && m.disposition === "mapped" ? m.provider : [];
}

/** Provider UUID (any case) → the DWP entry it is explicitly mapped to, else null (e.g. provider-only). */
export function resolveDwpEntertainmentFromThemeParksId(entityId: string): { dwpName: string; parkId: ParkId } | null {
  return DWP_BY_PROVIDER_ID.get(entityId.toLowerCase()) ?? null;
}

// ============================================
// VERIFICATION (pure)
// ============================================

const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ActivePlace = { name: string; parkId: ParkId };

function activePlaces(places: typeof ENTERTAINMENT_PLACES): { active: ActivePlace[]; missingPark: string[] } {
  const active: ActivePlace[] = [];
  const missingPark: string[] = [];
  for (const p of places) {
    if (p.parkId) active.push({ name: p.name, parkId: p.parkId });
    else missingPark.push(p.name);
  }
  return { active, missingPark };
}

/**
 * Offline structural audit: every active DWP entertainment entry has exactly
 * one explicit disposition; no mapping refers to a non-active entry; provider
 * UUIDs are canonical (lowercase) and globally unique; mapped entries carry
 * at least one ref.
 */
export function validateEntertainmentMappingStructure(
  mapping: EntertainmentProviderMapping[] = THEMEPARKS_ENTERTAINMENT_MAPPING,
  places: typeof ENTERTAINMENT_PLACES = ENTERTAINMENT_PLACES,
): MappingFinding[] {
  const findings: MappingFinding[] = [];
  const add = (kind: MappingFindingKind, key: string, detail: string) =>
    findings.push({ kind, severity: "error", key, detail });
  const { active, missingPark } = activePlaces(places);
  for (const name of missingPark) add("missing_disposition", name, "Active DWP entertainment entry has no parkId, so it cannot be keyed/mapped");

  const activeKeys = new Set(active.map((a) => entertainmentMappingKey(a.parkId, a.name)));
  const seen = new Set<string>();
  const idOwner = new Map<string, string>();
  for (const m of mapping) {
    const key = entertainmentMappingKey(m.parkId, m.dwpName);
    if (seen.has(key)) add("duplicate_mapping", key, "More than one mapping entry for the same (park, name)");
    seen.add(key);
    if (!activeKeys.has(key)) add("orphan_mapping", key, "Mapping does not correspond to an active DWP entertainment entry (legacy/renamed/removed)");
    if (m.disposition !== "mapped") continue;
    if (m.provider.length === 0) add("empty_provider_refs", key, "Mapped entry has no provider refs");
    for (const ref of m.provider) {
      if (!CANONICAL_UUID_RE.test(ref.entityId)) add("invalid_uuid", key, `Provider id ${ref.entityId} is not a lowercase canonical UUID`);
      const owner = idOwner.get(ref.entityId);
      if (owner !== undefined) add("duplicate_provider_id", key, `Provider id ${ref.entityId} already mapped by ${owner}`);
      else idOwner.set(ref.entityId, key);
    }
  }
  for (const a of active) {
    const key = entertainmentMappingKey(a.parkId, a.name);
    if (!seen.has(key)) add("missing_disposition", key, "Active DWP entertainment entry is neither mapped nor intentionally unmapped");
  }
  return findings;
}

/**
 * Audits the mapping against provider park children (already normalized by
 * `getChildren`). Reports drift as findings; never changes the mapping.
 * Provider-only SHOW entities (no DWP mapping) are preserved in `providerOnly`.
 */
export function verifyEntertainmentMapping(
  childrenByPark: Partial<Record<ParkId, ThemeParksChildren>>,
  mapping: EntertainmentProviderMapping[] = THEMEPARKS_ENTERTAINMENT_MAPPING,
  places: typeof ENTERTAINMENT_PLACES = ENTERTAINMENT_PLACES,
): EntertainmentMappingReport {
  const findings = validateEntertainmentMappingStructure(mapping, places);
  const verified: EntertainmentMappingReport["verified"] = [];
  const unmappedOut: EntertainmentMappingReport["unmapped"] = [];
  const droppedChildren: EntertainmentMappingReport["droppedChildren"] = {};

  const parkIds = Object.keys(THEMEPARKS_PARKS) as ParkId[];
  const indexByPark = new Map<ParkId, Map<string, ThemeParksChild>>();
  const ownerPark = new Map<string, ParkId>();
  for (const parkId of parkIds) {
    const payload = childrenByPark[parkId];
    if (!payload) continue;
    const idx = new Map<string, ThemeParksChild>();
    for (const c of payload.children) { idx.set(c.entityId, c); ownerPark.set(c.entityId, parkId); }
    indexByPark.set(parkId, idx);
    droppedChildren[parkId] = payload.droppedEntries;
  }

  const mappedIds = new Set<string>();
  const parkPayloadReported = new Set<ParkId>();
  for (const m of mapping) {
    const key = entertainmentMappingKey(m.parkId, m.dwpName);
    if (m.disposition === "unmapped") {
      unmappedOut.push({ key, dwpName: m.dwpName, parkId: m.parkId, reason: m.reason });
      continue;
    }
    let entryOk = true;
    const err = (kind: MappingFindingKind, detail: string, severity: "error" | "warning" = "error") => {
      findings.push({ kind, severity, key, detail });
      if (severity === "error") entryOk = false;
    };
    const idx = indexByPark.get(m.parkId);
    const expectedParkUuid = THEMEPARKS_PARKS[m.parkId].entityId;
    for (const ref of m.provider) {
      mappedIds.add(ref.entityId);
      if (!idx) {
        if (!parkPayloadReported.has(m.parkId)) {
          parkPayloadReported.add(m.parkId);
          findings.push({ kind: "park_payload_missing", severity: "error", key: m.parkId, detail: `No provider children supplied for park ${m.parkId}; its mappings are unverified` });
        }
        entryOk = false;
        continue;
      }
      const child = idx.get(ref.entityId);
      if (!child) {
        const elsewhere = ownerPark.get(ref.entityId);
        if (elsewhere) err("wrong_park", `Provider entity ${ref.entityId} is listed under park ${elsewhere}, expected ${m.parkId}`);
        else err("entity_missing", `Provider entity ${ref.entityId} ("${ref.providerName}") not in ${m.parkId} children`);
        continue;
      }
      if (child.parentId !== null && child.parentId !== expectedParkUuid) {
        err("parent_mismatch", `Provider entity ${ref.entityId} has parent ${child.parentId}, expected park ${expectedParkUuid}`);
      }
      if (child.entityType !== ref.entityType) {
        err("type_mismatch", `Provider entity ${ref.entityId} is ${child.entityType}, expected ${ref.entityType}`);
      }
      if (child.name !== ref.providerName) {
        err("name_drift", `Provider name changed: "${ref.providerName}" → "${child.name}" (mapping kept; review)`, "warning");
      }
    }
    if (entryOk) verified.push({ key, dwpName: m.dwpName, parkId: m.parkId, provider: m.provider });
  }

  // Provider-only entertainment: SHOW entities with no explicit DWP mapping. Preserved for future consumers.
  const providerOnly: EntertainmentMappingReport["providerOnly"] = {};
  for (const [parkId, idx] of indexByPark) {
    const extra = [...idx.values()].filter((c) => c.entityType === "SHOW" && !mappedIds.has(c.entityId));
    if (extra.length > 0) providerOnly[parkId] = extra;
  }

  return { ok: findings.every((f) => f.severity !== "error"), findings, verified, unmapped: unmappedOut, providerOnly, droppedChildren };
}

// ============================================
// DEV VERIFICATION (AGENTS.md convention — manual, not CI)
// ============================================

/**
 * Offline cases (no network). Run manually, e.g. via tsx:
 *   import { runDevThemeParksEntertainmentMappingCases } from "@/lib/themeParksEntertainmentMapping";
 *   console.log(runDevThemeParksEntertainmentMappingCases()); // [] when everything passes
 * Returns the labels of failing cases.
 */
const child = (entityId: string, name: string, entityType: string, parkId: ParkId): ThemeParksChild => ({
  entityId, name, entityType, parentId: THEMEPARKS_PARKS[parkId].entityId, externalId: null, slug: null, location: null,
});

/** Synthetic provider payload that exactly satisfies the mapping (+ one provider-only show per park). */
function devPerfectChildren(): Partial<Record<ParkId, ThemeParksChildren>> {
  const out: Partial<Record<ParkId, ThemeParksChildren>> = {};
  (Object.keys(THEMEPARKS_PARKS) as ParkId[]).forEach((parkId, i) => {
    out[parkId] = {
      entityId: THEMEPARKS_PARKS[parkId].entityId, name: parkId, entityType: "PARK", timeZone: null, droppedEntries: 0,
      children: [child(`00000000-0000-4000-8000-00000000000${i}`, `Provider-only ${parkId}`, "SHOW", parkId)],
    };
  });
  for (const m of THEMEPARKS_ENTERTAINMENT_MAPPING) {
    if (m.disposition !== "mapped") continue;
    for (const r of m.provider) out[m.parkId]!.children.push(child(r.entityId, r.providerName, r.entityType, m.parkId));
  }
  return out;
}

export function runDevThemeParksEntertainmentMappingCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const kinds = (r: EntertainmentMappingReport, sev?: "error" | "warning") =>
    r.findings.filter((f) => !sev || f.severity === sev).map((f) => f.kind);

  // Completeness / disposition
  check("structure: no findings on shipped mapping", validateEntertainmentMappingStructure().length === 0);
  check("completeness: every active DWP entry has exactly one disposition",
    ENTERTAINMENT_PLACES.every((p) => p.parkId && getEntertainmentProviderMapping(p.name, p.parkId)) &&
    THEMEPARKS_ENTERTAINMENT_MAPPING.length === ENTERTAINMENT_PLACES.length);
  check("completeness: missing disposition detected",
    validateEntertainmentMappingStructure(THEMEPARKS_ENTERTAINMENT_MAPPING.slice(1)).some((f) => f.kind === "missing_disposition"));
  check("completeness: orphan (non-active/legacy) mapping detected",
    validateEntertainmentMappingStructure([...THEMEPARKS_ENTERTAINMENT_MAPPING, unmapped("Together Forever — A Pixar Nighttime Spectacular", "disneyland", "legacy")])
      .some((f) => f.kind === "orphan_mapping"));
  check("completeness: duplicate mapping entry detected",
    validateEntertainmentMappingStructure([...THEMEPARKS_ENTERTAINMENT_MAPPING, THEMEPARKS_ENTERTAINMENT_MAPPING[0]]).some((f) => f.kind === "duplicate_mapping"));
  check("completeness: active entry without parkId is a finding",
    validateEntertainmentMappingStructure(THEMEPARKS_ENTERTAINMENT_MAPPING, [{ name: "X", resort: "WDW", location: "?" }]).some((f) => f.kind === "missing_disposition"));
  check("every unmapped entry carries a reason",
    THEMEPARKS_ENTERTAINMENT_MAPPING.every((m) => m.disposition === "mapped" || m.reason.trim() !== ""));

  // UUID validity / uniqueness
  const allIds = THEMEPARKS_ENTERTAINMENT_MAPPING.flatMap((m) => (m.disposition === "mapped" ? m.provider.map((r) => r.entityId) : []));
  check("uuids: canonical lowercase and globally unique", allIds.every((i) => CANONICAL_UUID_RE.test(i)) && new Set(allIds).size === allIds.length);
  check("uuids: uppercase id flagged",
    validateEntertainmentMappingStructure([mapped("Fantasmic!", "hs", show(allIds[0].toUpperCase(), "x")), ...THEMEPARKS_ENTERTAINMENT_MAPPING.filter((m) => !(m.parkId === "hs" && m.dwpName === "Fantasmic!"))])
      .some((f) => f.kind === "invalid_uuid"));
  check("uuids: duplicate provider id across entries flagged",
    validateEntertainmentMappingStructure([...THEMEPARKS_ENTERTAINMENT_MAPPING.filter((m) => !(m.parkId === "hs" && m.dwpName === "Fantasmic!")), mapped("Fantasmic!", "hs", show(allIds[0], "x"))])
      .some((f) => f.kind === "duplicate_provider_id"));
  check("uuids: empty provider refs flagged",
    validateEntertainmentMappingStructure([...THEMEPARKS_ENTERTAINMENT_MAPPING.filter((m) => !(m.parkId === "hs" && m.dwpName === "Fantasmic!")), mapped("Fantasmic!", "hs")])
      .some((f) => f.kind === "empty_provider_refs"));

  // Duplicate-name isolation
  const dupe = (name: string) => ENTERTAINMENT_PLACES.filter((p) => p.name === name).map((p) => p.parkId!);
  for (const name of ["Fantasmic!", "Enchanted Tiki Room", "Turtle Talk with Crush", "Disney Jr. Mickey Mouse Clubhouse Live!"]) {
    const parks = dupe(name);
    const refs = parks.flatMap((p) => getThemeParksEntertainmentRefs(name, p).map((r) => r.entityId));
    check(`duplicate names: "${name}" keyed per park (${parks.join("/")}) with no shared ref`,
      parks.length === 2 && new Set(parks).size === 2 && new Set(refs).size === refs.length);
  }
  check("duplicate names: Fantasmic! DLR vs WDW UUIDs differ",
    getThemeParksEntertainmentRefs("Fantasmic!", "disneyland")[0].entityId !== getThemeParksEntertainmentRefs("Fantasmic!", "hs")[0].entityId);
  check("duplicate names: no name-only lookup (wrong park → no refs)", getThemeParksEntertainmentRefs("Happily Ever After", "disneyland").length === 0);
  check("reverse lookup: case-insensitive, park-qualified, null for unknown/provider-only",
    resolveDwpEntertainmentFromThemeParksId("3A4E0F49-F9FF-4481-A95B-D4952CDF6097")?.parkId === "ak" &&
    resolveDwpEntertainmentFromThemeParksId("00000000-0000-4000-8000-000000000000") === null);

  // Park/entity verification + provider-only preservation on a perfect payload
  const perfect = devPerfectChildren();
  const base = verifyEntertainmentMapping(perfect);
  check("verify: perfect provider payload is ok with no findings", base.ok && base.findings.length === 0);
  check("verify: every mapped entry verified, unmapped carried with reasons",
    base.verified.length + base.unmapped.length === THEMEPARKS_ENTERTAINMENT_MAPPING.length && base.unmapped.every((u) => u.reason !== ""));
  check("verify: provider-only show preserved, normalized, per park, not an error",
    (Object.keys(THEMEPARKS_PARKS) as ParkId[]).every((p) => base.providerOnly[p]?.length === 1 && base.providerOnly[p]![0].name === `Provider-only ${p}`));
  check("provider-only: not added to DWP catalog/mapping",
    !ENTERTAINMENT_PLACES.some((p) => p.name.startsWith("Provider-only")) && base.providerOnly.mk![0].entityId.length === 36);

  const clone = () => JSON.parse(JSON.stringify(perfect)) as typeof perfect;
  const fantasmicHs = getThemeParksEntertainmentRefs("Fantasmic!", "hs")[0];
  // entity missing
  { const p = clone(); p.hs!.children = p.hs!.children.filter((c) => c.entityId !== fantasmicHs.entityId);
    const r = verifyEntertainmentMapping(p);
    check("drift: entity removed → entity_missing error (no remap)", !r.ok && kinds(r, "error").includes("entity_missing") && !r.verified.some((v) => v.dwpName === "Fantasmic!" && v.parkId === "hs")); }
  // wrong park
  { const p = clone(); const c = p.hs!.children.find((x) => x.entityId === fantasmicHs.entityId)!;
    p.hs!.children = p.hs!.children.filter((x) => x !== c); p.mk!.children.push({ ...c, parentId: THEMEPARKS_PARKS.mk.entityId });
    const r = verifyEntertainmentMapping(p);
    check("drift: entity moved to another park → wrong_park", !r.ok && kinds(r, "error").includes("wrong_park")); }
  // parent mismatch
  { const p = clone(); p.hs!.children.find((x) => x.entityId === fantasmicHs.entityId)!.parentId = THEMEPARKS_PARKS.mk.entityId;
    check("drift: parentId ≠ expected park → parent_mismatch", kinds(verifyEntertainmentMapping(p), "error").includes("parent_mismatch")); }
  // type mismatch
  { const p = clone(); p.hs!.children.find((x) => x.entityId === fantasmicHs.entityId)!.entityType = "ATTRACTION";
    check("drift: entityType changed → type_mismatch", kinds(verifyEntertainmentMapping(p), "error").includes("type_mismatch")); }
  // name drift: warning only, mapping retained
  { const p = clone(); p.hs!.children.find((x) => x.entityId === fantasmicHs.entityId)!.name = "Fantasmic! (Renamed)";
    const r = verifyEntertainmentMapping(p);
    check("drift: provider rename → name_drift warning, still ok and still mapped (never remapped)",
      r.ok && kinds(r, "warning").includes("name_drift") && r.verified.some((v) => v.dwpName === "Fantasmic!" && v.parkId === "hs") &&
      getThemeParksEntertainmentRefs("Fantasmic!", "hs")[0].entityId === fantasmicHs.entityId); }
  // same-name provider entity with a different id must NOT be adopted
  { const p = clone(); p.hs!.children = p.hs!.children.filter((c) => c.entityId !== fantasmicHs.entityId);
    p.hs!.children.push(child("11111111-1111-4111-8111-111111111111", "Fantasmic!", "SHOW", "hs"));
    const r = verifyEntertainmentMapping(p);
    check("drift: same-named replacement entity is not silently adopted; surfaces as missing + provider-only",
      !r.ok && kinds(r, "error").includes("entity_missing") && r.providerOnly.hs!.some((c) => c.entityId === "11111111-1111-4111-8111-111111111111")); }
  // missing park payload
  { const p = clone(); delete p.dca;
    const r = verifyEntertainmentMapping(p);
    check("verify: missing park payload → park_payload_missing, its mappings not verified",
      !r.ok && kinds(r, "error").includes("park_payload_missing") && !r.verified.some((v) => v.parkId === "dca")); }
  // duplicate names stay distinct under verification: breaking the DLR Fantasmic! must not affect HS
  { const dl = getThemeParksEntertainmentRefs("Fantasmic!", "disneyland")[0];
    const p = clone(); p.disneyland!.children = p.disneyland!.children.filter((c) => c.entityId !== dl.entityId);
    const r = verifyEntertainmentMapping(p);
    check("verify: DLR Fantasmic! drift leaves HS Fantasmic! verified",
      r.findings.some((f) => f.key === entertainmentMappingKey("disneyland", "Fantasmic!")) &&
      r.verified.some((v) => v.parkId === "hs" && v.dwpName === "Fantasmic!")); }
  // partially-present multi-ref entry fails as a whole
  { const refs = getThemeParksEntertainmentRefs("Halloween Screams", "disneyland");
    const p = clone(); p.disneyland!.children = p.disneyland!.children.filter((c) => c.entityId !== refs[1].entityId);
    const r = verifyEntertainmentMapping(p);
    check("verify: multi-ref entry with one ref missing is not verified", refs.length === 2 && !r.verified.some((v) => v.dwpName === "Halloween Screams")); }
  // provider-only is not flagged when a same-park non-SHOW unmapped entity exists
  { const p = clone(); p.mk!.children.push(child("22222222-2222-4222-8222-222222222222", "Some Ride", "ATTRACTION", "mk"), child("33333333-3333-4333-8333-333333333333", "Some Cafe", "RESTAURANT", "mk"));
    const r = verifyEntertainmentMapping(p);
    check("provider-only: only unmapped SHOW entities (attractions/restaurants out of scope)", r.ok && r.providerOnly.mk!.length === 1); }

  return failures;
}

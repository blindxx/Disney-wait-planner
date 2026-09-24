/**
 * profileRegistrySync.ts — SH.4.1 Account Profile Registry
 *
 * Client-side reconciliation between the device-local profile list
 * (profileStorage.ts's `dwp.profiles`) and the durable, account-wide
 * registry (`user_profiles` table, via /api/sync/profiles).
 *
 * Deliberately NOT part of syncHelper.ts and never imported by it: this
 * reconciles profile IDENTITY METADATA (id + display name) only, never
 * planner content, and has no revision/pending-op/confirmed-baseline
 * machinery of its own. Registry reconciliation and planner sync
 * (SH.2/SH.3) run completely independently — neither calls into the
 * other — even though they share the same profileId as an addressing key.
 * See the SH.4 architecture audit for the full rationale.
 *
 * SH.4.1 scope — additive legacy adoption only:
 *   - Local profiles unknown to the server are pushed up (registered).
 *   - Server profiles unknown locally, and not tombstoned, are pulled down
 *     (discovered) — see profileStorage.ts's mergeProfilesAdditive/
 *     adoptServerProfiles for the local-merge half of this.
 *   - A server-known id (active OR tombstoned) is never overwritten by a
 *     stale local copy: the server enforces this with a conflict-free
 *     `ON CONFLICT DO NOTHING` insert, and this module mirrors it by never
 *     including an already-known id (computeProfilesToAdopt) in the
 *     adopt-push list in the first place.
 *   - A tombstoned (deletedAt set) server profile is never pulled into the
 *     local list (selectActiveServerProfiles drops it) — this is the one
 *     piece of tombstone handling SH.4.1 needs, purely to stop adoption
 *     from resurrecting a deleted profile on a device that never saw the
 *     delete. Full delete lifecycle/UI (soft-delete from Settings, learning
 *     "this profile was deleted" beyond silently not-discovering it again)
 *     is SH.4.3 scope.
 *   - Renaming an id already known to the server is NOT propagated in
 *     either direction yet — SH.4.2 owns that policy. An id already present
 *     both locally and on the server keeps its LOCAL name untouched here.
 *   - `dwp.activeProfile` is never read or written anywhere in this module
 *     — it stays entirely device-local, exactly as it does today.
 *   - New-profile id generation (collision-resistant ids independent of
 *     name) is SH.4.2 scope; this module only ever adopts ids the device
 *     already has under today's name-derived scheme.
 */

import { type Profile, getProfiles, adoptServerProfiles } from "./profileStorage";

// ===== TYPES =====

/** One row as returned by GET /api/sync/profiles. */
export type ServerProfileRecord = {
  profileId: string;
  name: string;
  updatedAt: string;
  deletedAt: string | null;
};

// ===== PURE RECONCILIATION LOGIC =====

/**
 * Given the full server registry (including tombstones) and this device's
 * current local profile list, compute the local profiles that should be
 * PUSHED to the server because it does not yet know about their id — by id
 * alone, regardless of tombstone state. A tombstoned id is already "known"
 * to the server and must never be re-adopted/resurrected via this path;
 * only an explicit, deliberate un-delete (not implemented in SH.4.1) may
 * ever clear a tombstone. A local id whose name differs from what the
 * server already has under the same id is likewise excluded — this
 * function only ever proposes ids the server has NEVER seen, never a
 * "correction" to one it has.
 *
 * Run from Node:
 *   import { DEV_COMPUTE_PROFILES_TO_ADOPT_CASES, computeProfilesToAdopt } from "@/lib/profileRegistrySync";
 *   DEV_COMPUTE_PROFILES_TO_ADOPT_CASES.forEach(c => {
 *     const got = computeProfilesToAdopt(c.serverProfiles, c.localProfiles);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function computeProfilesToAdopt(
  serverProfiles: ServerProfileRecord[],
  localProfiles: Profile[]
): Profile[] {
  const known = new Set(serverProfiles.map((p) => p.profileId));
  return localProfiles.filter((p) => !known.has(p.id));
}

export const DEV_COMPUTE_PROFILES_TO_ADOPT_CASES: Array<{
  name: string;
  serverProfiles: ServerProfileRecord[];
  localProfiles: Profile[];
  expected: Profile[];
}> = [
  {
    name: "empty server + existing local custom profiles — additive adoption of everything",
    serverProfiles: [],
    localProfiles: [
      { id: "default", name: "Default" },
      { id: "mom", name: "Mom" },
    ],
    expected: [
      { id: "default", name: "Default" },
      { id: "mom", name: "Mom" },
    ],
  },
  {
    name: "grandfathered custom id preserved exactly in the push list — no id/name rewriting",
    serverProfiles: [],
    localProfiles: [{ id: "lindsay-2", name: "Lindsay" }],
    expected: [{ id: "lindsay-2", name: "Lindsay" }],
  },
  {
    name: "same id already server-known (active) — local stale name never re-pushed/overwritten",
    serverProfiles: [
      { profileId: "mom", name: "Mom", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    localProfiles: [{ id: "mom", name: "Mommy (stale local copy)" }],
    expected: [],
  },
  {
    name: "tombstoned server id — local stale copy never re-pushed/resurrected via adoption",
    serverProfiles: [
      {
        profileId: "mom",
        name: "Mom",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-02-01T00:00:00.000Z",
      },
    ],
    localProfiles: [{ id: "mom", name: "Mom" }],
    expected: [],
  },
  {
    name: "mixed — only the genuinely unknown local id is proposed for adoption",
    serverProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
    ],
    localProfiles: [
      { id: "default", name: "Default" },
      { id: "lindsay", name: "Lindsay" },
    ],
    expected: [{ id: "lindsay", name: "Lindsay" }],
  },
];

/**
 * Given the server registry, return the ACTIVE (non-tombstoned) profiles in
 * the plain {id,name} shape profileStorage.ts's local list uses — dropping
 * every tombstoned row so it can never reach a device's local list via
 * discovery. Pass the result to profileStorage.ts's adoptServerProfiles to
 * actually merge it in.
 *
 * Run from Node:
 *   import { DEV_SELECT_ACTIVE_SERVER_PROFILES_CASES, selectActiveServerProfiles } from "@/lib/profileRegistrySync";
 *   DEV_SELECT_ACTIVE_SERVER_PROFILES_CASES.forEach(c => {
 *     const got = selectActiveServerProfiles(c.serverProfiles);
 *     console.log(JSON.stringify(got) === JSON.stringify(c.expected) ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export function selectActiveServerProfiles(serverProfiles: ServerProfileRecord[]): Profile[] {
  return serverProfiles
    .filter((p) => !p.deletedAt)
    .map((p) => ({ id: p.profileId, name: p.name }));
}

export const DEV_SELECT_ACTIVE_SERVER_PROFILES_CASES: Array<{
  name: string;
  serverProfiles: ServerProfileRecord[];
  expected: Profile[];
}> = [
  {
    name: "server profiles + fresh device containing only local Default — active profiles surfaced for discovery",
    serverProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
      { profileId: "mom", name: "Mom", updatedAt: "2026-01-02T00:00:00.000Z", deletedAt: null },
    ],
    expected: [
      { id: "default", name: "Default" },
      { id: "mom", name: "Mom" },
    ],
  },
  {
    name: "tombstoned server profile excluded from discovery entirely",
    serverProfiles: [
      { profileId: "default", name: "Default", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null },
      {
        profileId: "mom",
        name: "Mom",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-02-01T00:00:00.000Z",
      },
    ],
    expected: [{ id: "default", name: "Default" }],
  },
  {
    name: "empty server registry — nothing to discover",
    serverProfiles: [],
    expected: [],
  },
];

// ===== NETWORK ORCHESTRATION =====
//
// Everything below is a thin, best-effort I/O wrapper around the pure
// functions above. It is deliberately NOT exercised by DEV_* cases (it has
// no interesting branching of its own — every actual decision lives in the
// pure functions, which the cases above cover directly) and never throws:
// exactly like syncHelper.ts's scheduleSync()/doPush(), a failed/absent
// network response degrades to a silent no-op rather than surfacing an
// error to the page, since the local-first profile list already works
// fully offline.

type ProfilesGetResponse = { profiles: ServerProfileRecord[] };

function isServerProfileRecord(value: unknown): value is ServerProfileRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.profileId === "string" &&
    typeof v.name === "string" &&
    typeof v.updatedAt === "string" &&
    (v.deletedAt === null || typeof v.deletedAt === "string")
  );
}

async function fetchServerProfiles(): Promise<ServerProfileRecord[] | null> {
  try {
    const res = await fetch("/api/sync/profiles", { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<ProfilesGetResponse> | null;
    if (!data || !Array.isArray(data.profiles) || !data.profiles.every(isServerProfileRecord)) {
      return null;
    }
    return data.profiles;
  } catch {
    return null;
  }
}

async function pushProfilesToAdopt(toAdopt: Profile[]): Promise<void> {
  if (toAdopt.length === 0) return;
  try {
    await fetch("/api/sync/profiles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profiles: toAdopt.map((p) => ({ profileId: p.id, name: p.name })),
      }),
    });
  } catch {
    // Best-effort — a failed push just means these ids stay local-only
    // until the next reconciliation round picks them up again.
  }
}

/**
 * Runs one round of registry reconciliation: pulls the account's durable
 * profile registry, additively pushes any local-only profiles up (legacy
 * adoption), and additively merges any server-only ACTIVE profiles down
 * into the local list (discovery). Silently no-ops on any auth/network
 * failure — never throws, never blocks page rendering, and never touches
 * planner content or `dwp.activeProfile`.
 *
 * Call this only when authenticated (a 401 from the GET is treated the
 * same as any other failure: a no-op) — mirrors how scheduleSync() already
 * expects its caller to gate on sign-in state rather than gating itself.
 */
export async function reconcileProfileRegistry(): Promise<void> {
  if (typeof window === "undefined") return;
  const serverProfiles = await fetchServerProfiles();
  if (serverProfiles === null) return;

  const localProfiles = getProfiles();
  const toAdopt = computeProfilesToAdopt(serverProfiles, localProfiles);
  await pushProfilesToAdopt(toAdopt);

  adoptServerProfiles(selectActiveServerProfiles(serverProfiles));
}

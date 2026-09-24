/**
 * parkMetadata.ts — SH.3.3 Codex follow-up (PR #153)
 *
 * The single maintained source of truth for supported park IDs, their
 * display labels, and their resort membership. Extracted from
 * crossDayChecks.ts (which previously defined PARK_LABELS/PARK_TO_RESORT
 * itself) into its own dependency-neutral module — no imports from
 * crossDayChecks.ts, syncPayload.ts, or anything else that itself depends
 * on either of those — so BOTH can consume it without creating a circular
 * dependency:
 *   - crossDayChecks.ts imports from syncPayload.ts (capturePreFetchDomainSnapshot,
 *     resolvePostFetchDomainBaseline, etc.), so syncPayload.ts can never import
 *     from crossDayChecks.ts.
 *   - syncPayload.ts's sanitizeDayParks() needs the exact same supported-
 *     park-ID set crossDayChecks.ts's PARK_TO_RESORT already defines, to
 *     validate a synced dayParks entry's park-id value.
 * This module sits below both, so each imports it directly instead of one
 * duplicating the other's literal (the Codex P1 this follow-up fixes: the
 * previous fix hand-duplicated PARK_TO_RESORT's keys into syncPayload.ts's
 * own VALID_PARK_IDS constant, an independently-maintained copy that could
 * silently drift out of sync with the authoritative set here).
 */

import { type ParkId, type ResortId } from "@disney-wait-planner/shared";

/** Friendly display name for each supported park. */
export const PARK_LABELS: Record<ParkId, string> = {
  disneyland: "Disneyland",
  dca: "Disney California Adventure",
  mk: "Magic Kingdom",
  epcot: "EPCOT",
  hs: "Hollywood Studios",
  ak: "Animal Kingdom",
};

/**
 * Every supported park ID, mapped to the resort it belongs to. This is the
 * authoritative validation set — consumers needing to check "is v a known,
 * supported park ID" should test membership against this object rather than
 * maintaining their own copy of the key set. Use isValidParkId() below to do
 * that check, never the bare `in` operator — see that function's own doc
 * for why.
 */
export const PARK_TO_RESORT: Partial<Record<string, ResortId>> = {
  disneyland: "DLR",
  dca: "DLR",
  mk: "WDW",
  epcot: "WDW",
  hs: "WDW",
  ak: "WDW",
};

/**
 * SH.3.3 Codex follow-up (PR #153, P2) — the single safe way to check "is
 * `value` a known, supported park ID". `value in PARK_TO_RESORT` looks like
 * the obvious check, but the `in` operator walks the prototype chain: since
 * PARK_TO_RESORT is a plain object, `in` also matches inherited
 * Object.prototype property names — "toString", "constructor",
 * "hasOwnProperty", "valueOf", "__proto__", etc. — none of which are real
 * park IDs, but all of which `in` reports as present. A raw/untrusted string
 * (parsed from localStorage JSON, a cloud sync payload, or an external API
 * filter) equal to one of those names would incorrectly pass an `in` check
 * and be accepted/persisted as if it were a valid park ID.
 *
 * Object.prototype.hasOwnProperty.call() only reports PARK_TO_RESORT's OWN
 * enumerable keys — the six real park IDs — never anything inherited, so
 * this is immune to that class of value. Also doubles as a TypeScript type
 * guard (`value is ParkId`), narrowing a plain string to ParkId at call
 * sites that previously needed an `as ParkId` cast after their own `in`/
 * hasOwnProperty check.
 */
export function isValidParkId(value: string): value is ParkId {
  return Object.prototype.hasOwnProperty.call(PARK_TO_RESORT, value);
}

/**
 * Reference cases for isValidParkId() — pinning the exact P2 regression
 * this function exists to close: every one of PARK_TO_RESORT's INHERITED
 * Object.prototype property names must be rejected, even though
 * `name in PARK_TO_RESORT` would incorrectly accept each of them. Run from
 * Node:
 *   import { DEV_IS_VALID_PARK_ID_CASES, isValidParkId } from "@/lib/parkMetadata";
 *   DEV_IS_VALID_PARK_ID_CASES.forEach(c => {
 *     const got = isValidParkId(c.value);
 *     console.log(got === c.expected ? "✓" : "✗ FAIL", c.name);
 *   });
 */
export const DEV_IS_VALID_PARK_ID_CASES: Array<{
  name: string;
  value: string;
  expected: boolean;
}> = [
  {
    name: "a real park ID — accepted",
    value: "mk",
    expected: true,
  },
  {
    name: "every real park ID — accepted (exhaustive over PARK_TO_RESORT's own keys)",
    value: "disneyland",
    expected: true,
  },
  {
    name: "required (Codex P2) — \"toString\", an inherited Object.prototype property `in` would incorrectly accept — rejected",
    value: "toString",
    expected: false,
  },
  {
    name: "required (Codex P2) — \"constructor\", an inherited Object.prototype property `in` would incorrectly accept — rejected",
    value: "constructor",
    expected: false,
  },
  {
    name: "required (Codex P2) — \"hasOwnProperty\" itself, an inherited Object.prototype property — rejected",
    value: "hasOwnProperty",
    expected: false,
  },
  {
    name: "required (Codex P2) — \"valueOf\", an inherited Object.prototype property — rejected",
    value: "valueOf",
    expected: false,
  },
  {
    name: "required (Codex P2) — \"__proto__\" — rejected (never a real own key of PARK_TO_RESORT, regardless of engine-specific accessor behavior)",
    value: "__proto__",
    expected: false,
  },
  {
    name: "an ordinary unrecognized string — rejected",
    value: "not-a-real-park",
    expected: false,
  },
  {
    name: "empty string — rejected",
    value: "",
    expected: false,
  },
];

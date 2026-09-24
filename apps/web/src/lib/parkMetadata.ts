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
 * authoritative validation set: `v in PARK_TO_RESORT` (or
 * `Object.prototype.hasOwnProperty.call(PARK_TO_RESORT, v)`) is this
 * codebase's standard idiom for "is v a known, supported park ID" —
 * consumers needing that check (dayParks local read/write validation,
 * dayParks sync payload validation, resort inference, etc.) should test
 * membership against this object directly rather than maintaining their
 * own copy of the key set.
 */
export const PARK_TO_RESORT: Partial<Record<string, ResortId>> = {
  disneyland: "DLR",
  dca: "DLR",
  mk: "WDW",
  epcot: "WDW",
  hs: "WDW",
  ak: "WDW",
};

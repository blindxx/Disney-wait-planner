/**
 * themeParksProviders.ts — ThemeParks.wiki provider identity + attribution.
 *
 * Integration metadata ONLY. ThemeParks.wiki UUIDs identify the provider's
 * destinations/parks so the provider client (`themeParksApi.ts`) knows what
 * to request. They are NOT DWP identity: canonical attraction/entertainment
 * identity, names, and park/land metadata stay owned by the DWP catalog
 * (`parkMetadata.ts`, `plannerItemMetadata.ts`, the per-domain catalogs).
 * This module deliberately maps nothing below the park level — no
 * individual attraction/show/dining mapping lives here (later phases).
 *
 * Park membership reuses `PARK_TO_RESORT` / `PARK_LABELS` (parkMetadata.ts)
 * and the resort zone reuses `RESORT_TIME_ZONES` (resortTime.ts); nothing is
 * re-declared. Pure module (no I/O, no server-only imports) so the
 * attribution constants can also be consumed by client components.
 *
 * IDs verified against `GET /v1/destinations` on 2026-09-30. Provider IDs
 * can change upstream; `verifyThemeParksProviderIdentity()` in
 * `themeParksApi.ts` detects drift against live discovery.
 */

import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { PARK_TO_RESORT } from "./parkMetadata";
import { RESORT_TIME_ZONES } from "./resortTime";

export const THEMEPARKS_API_BASE_URL = "https://api.themeparks.wiki/v1";

/** Free-tier attribution: linked "Powered by ThemeParks.wiki". */
export const THEMEPARKS_ATTRIBUTION_TEXT = "Powered by ThemeParks.wiki";
export const THEMEPARKS_ATTRIBUTION_URL = "https://themeparks.wiki";

export interface ThemeParksDestinationConfig {
  /** ThemeParks.wiki destination entity UUID. */
  entityId: string;
  /** ThemeParks.wiki destination slug (informational). */
  slug: string;
  /** Provider's display name (informational; not DWP naming). */
  providerName: string;
}

export interface ThemeParksParkConfig {
  /** ThemeParks.wiki park entity UUID. */
  entityId: string;
  /** Provider's display name (informational; not DWP naming). */
  providerName: string;
}

export const THEMEPARKS_DESTINATIONS: Record<
  ResortId,
  ThemeParksDestinationConfig
> = {
  WDW: {
    entityId: "e957da41-3552-4cf6-b636-5babc5cbc4e5",
    slug: "waltdisneyworldresort",
    providerName: "Walt Disney World® Resort",
  },
  DLR: {
    entityId: "bfc89fd6-314d-44b4-b89e-df1a89cf991e",
    slug: "disneylandresort",
    providerName: "Disneyland Resort",
  },
};

/** Keyed by DWP park id — the same ids `PARK_TO_RESORT` validates. */
export const THEMEPARKS_PARKS: Record<ParkId, ThemeParksParkConfig> = {
  mk: {
    entityId: "75ea578a-adc8-4116-a54d-dccb60765ef9",
    providerName: "Magic Kingdom Park",
  },
  epcot: {
    entityId: "47f90d2c-e191-4239-a466-5892ef59a88b",
    providerName: "EPCOT",
  },
  hs: {
    entityId: "288747d1-8b4f-4a64-867e-ea7c9b27bad8",
    providerName: "Disney's Hollywood Studios",
  },
  ak: {
    entityId: "1c84a229-8862-4648-9c71-378ddd2c7693",
    providerName: "Disney's Animal Kingdom Theme Park",
  },
  disneyland: {
    entityId: "7340550b-c14d-4def-80bb-acdb51d49a66",
    providerName: "Disneyland Park",
  },
  dca: {
    entityId: "832fcd51-ea19-4e77-85c7-75d5843b127c",
    providerName: "Disney California Adventure Park",
  },
};

export function getThemeParksDestination(
  resort: ResortId,
): ThemeParksDestinationConfig {
  return THEMEPARKS_DESTINATIONS[resort];
}

export function getThemeParksPark(parkId: ParkId): ThemeParksParkConfig {
  return THEMEPARKS_PARKS[parkId];
}

/** Provider park UUID → DWP park id, or null when not a configured park. */
export function resolveDwpParkFromThemeParksId(entityId: string): ParkId | null {
  for (const [parkId, cfg] of Object.entries(THEMEPARKS_PARKS)) {
    if (cfg.entityId === entityId) return parkId as ParkId;
  }
  return null;
}

/** Provider destination UUID → DWP resort id, or null. */
export function resolveDwpResortFromThemeParksId(
  entityId: string,
): ResortId | null {
  for (const resort of Object.keys(THEMEPARKS_DESTINATIONS) as ResortId[]) {
    if (THEMEPARKS_DESTINATIONS[resort].entityId === entityId) return resort;
  }
  return null;
}

/** Configured provider park UUIDs for a resort (from DWP park membership). */
export function getThemeParksParkIdsForResort(resort: ResortId): ParkId[] {
  return (Object.keys(THEMEPARKS_PARKS) as ParkId[]).filter(
    (p) => PARK_TO_RESORT[p] === resort,
  );
}

/**
 * DEV reference cases (AGENTS.md convention — run manually from Node, e.g.
 * via tsx; not wired into CI):
 *   import { DEV_THEMEPARKS_PROVIDER_CASES, runDevThemeParksProviderCases } from "@/lib/themeParksProviders";
 *   console.log(runDevThemeParksProviderCases()); // [] when everything passes
 */
export const DEV_THEMEPARKS_PROVIDER_CASES: Array<{
  label: string;
  check: () => boolean;
}> = [
  {
    label: "WDW/DLR destination ids present and distinct",
    check: () =>
      THEMEPARKS_DESTINATIONS.WDW.entityId !== THEMEPARKS_DESTINATIONS.DLR.entityId &&
      /^[0-9a-f-]{36}$/.test(THEMEPARKS_DESTINATIONS.WDW.entityId) &&
      /^[0-9a-f-]{36}$/.test(THEMEPARKS_DESTINATIONS.DLR.entityId),
  },
  {
    label: "every DWP park (PARK_TO_RESORT) has a provider park; no extras",
    check: () => {
      const dwp = Object.keys(PARK_TO_RESORT).sort().join(",");
      const tp = Object.keys(THEMEPARKS_PARKS).sort().join(",");
      return dwp === tp;
    },
  },
  {
    label: "provider park UUIDs are unique and well-formed",
    check: () => {
      const ids = Object.values(THEMEPARKS_PARKS).map((p) => p.entityId);
      return new Set(ids).size === ids.length && ids.every((i) => /^[0-9a-f-]{36}$/.test(i));
    },
  },
  {
    label: "WDW resort has mk/epcot/hs/ak; DLR has disneyland/dca",
    check: () =>
      getThemeParksParkIdsForResort("WDW").sort().join(",") === "ak,epcot,hs,mk" &&
      getThemeParksParkIdsForResort("DLR").sort().join(",") === "dca,disneyland",
  },
  {
    label: "reverse resolution round-trips parks and destinations",
    check: () =>
      (Object.keys(THEMEPARKS_PARKS) as ParkId[]).every(
        (p) => resolveDwpParkFromThemeParksId(THEMEPARKS_PARKS[p].entityId) === p,
      ) &&
      resolveDwpResortFromThemeParksId(THEMEPARKS_DESTINATIONS.WDW.entityId) === "WDW" &&
      resolveDwpResortFromThemeParksId(THEMEPARKS_DESTINATIONS.DLR.entityId) === "DLR" &&
      resolveDwpParkFromThemeParksId("nope") === null,
  },
  {
    label: "resort zones come from RESORT_TIME_ZONES (WDW ET / DLR PT)",
    check: () =>
      RESORT_TIME_ZONES.WDW === "America/New_York" &&
      RESORT_TIME_ZONES.DLR === "America/Los_Angeles",
  },
  {
    label: "attribution text + https URL",
    check: () =>
      THEMEPARKS_ATTRIBUTION_TEXT === "Powered by ThemeParks.wiki" &&
      THEMEPARKS_ATTRIBUTION_URL.startsWith("https://"),
  },
];

export function runDevThemeParksProviderCases(): string[] {
  return DEV_THEMEPARKS_PROVIDER_CASES.filter((c) => !c.check()).map(
    (c) => c.label,
  );
}

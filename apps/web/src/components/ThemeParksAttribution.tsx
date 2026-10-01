/**
 * ThemeParksAttribution — reusable Free-tier attribution link
 * ("Powered by ThemeParks.wiki"). Text/URL come from
 * `lib/themeParksProviders.ts`. Mounted on Wait Times Entertainment (Phase 12.3); any surface that
 * displays ThemeParks.wiki-sourced data (later Phase 12 work) renders this.
 * No hooks/state, so it works from server or client components.
 */

import {
  THEMEPARKS_ATTRIBUTION_TEXT,
  THEMEPARKS_ATTRIBUTION_URL,
} from "../lib/themeParksProviders";

export default function ThemeParksAttribution({
  style,
}: {
  style?: React.CSSProperties;
}) {
  return (
    <a
      href={THEMEPARKS_ATTRIBUTION_URL}
      target="_blank"
      rel="noopener noreferrer"
      style={{ fontSize: 12, color: "inherit", opacity: 0.7, ...style }}
    >
      {THEMEPARKS_ATTRIBUTION_TEXT}
    </a>
  );
}

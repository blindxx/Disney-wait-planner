/**
 * ParkHoursLine — compact selected-park hours (Wait Times, Phase 12.4).
 * Presentational only: all interpretation lives in lib/parkHours.ts
 * (`describeParkHours`). No "Open" badge/status by design. ThemeParks.wiki
 * attribution for this data is rendered by the page's attribution footer
 * whenever `describeParkHours(...).presentsProviderData` is true.
 */

import { describeParkHours, type ParkHours } from "../lib/parkHours";

export default function ParkHoursLine({ data }: { data: ParkHours | null }) {
  // Reserve the line's height while loading so layout doesn't jump.
  if (!data) return <div style={{ minHeight: 20, marginBottom: 12 }} aria-hidden />;
  const d = describeParkHours(data);
  return (
    <div aria-label="Park hours" style={{ marginBottom: 12, lineHeight: 1.4, fontSize: "14px", color: "#4b5563" }}>
      <div style={{ fontWeight: 500 }}>
        {d.headline}
        {d.stale && <span title="Park hours may be out of date" style={{ fontWeight: 400, color: "#9ca3af" }}> (may be outdated)</span>}
      </div>
      {d.nextLine && <div>{d.nextLine}</div>}
      {d.extras.length > 0 && (
        <div style={{ fontSize: "12px", color: "#6b7280" }}>{d.extras.join(" · ")}</div>
      )}
    </div>
  );
}

/**
 * PlannerPublishedSchedule — Phase 14.6C date-specific official performance info for the active My Plans day.
 * Presentational only: the caller supplies the day's already-resolved `date` + effective `parkId` and its own
 * items (read-only); all resolution lives in lib/plannerPublishedSchedule.ts over the Phase 14.6B resolver.
 * No network, no writes, no effect on saved selections or itinerary order. Renders nothing when there is
 * nothing date-specific to say. Official (Disney-owned) data only, so no ThemeParks attribution applies.
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import { getPlannerPublishedScheduleRows, type PlannerScheduleItemInput } from "../lib/plannerPublishedSchedule";

export default function PlannerPublishedSchedule({
  date,
  parkId,
  resort,
  items,
}: {
  date: string | null;
  parkId: ParkId | null;
  resort: ResortId;
  items: readonly PlannerScheduleItemInput[];
}) {
  // Display clock only (resort-local past/today/future); same cadence as PlannerParkHours.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible") setNow(new Date()); }, 15_000);
    return () => clearInterval(id);
  }, []);
  const rows = useMemo(
    () => getPlannerPublishedScheduleRows(date, parkId, resort, items, now),
    [date, parkId, resort, items, now],
  );
  if (rows.length === 0) return null;
  return (
    <div aria-label="Official entertainment schedule for this day" style={{ lineHeight: 1.4, fontSize: "14px", color: "var(--text-mid)", margin: "4px 0 8px" }}>
      <div style={{ fontWeight: 500 }}>Official entertainment schedule</div>
      {rows.map((r) => (
        <div key={`${r.parkId}:${r.name}`} style={{ fontSize: "13px", color: "var(--text-muted)", marginTop: 2 }}>
          <span style={{ color: "var(--text-mid)" }}>{r.name}</span>
          {r.lines.map((l, i) => <div key={i}>{l}</div>)}
          {r.sourceUrl && (
            <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: "12px" }}>Official source</a>
          )}
        </div>
      ))}
    </div>
  );
}

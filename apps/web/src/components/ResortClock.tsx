"use client";

/**
 * ResortClock — shared resort-local clock (Today + Wait Times).
 *
 * Time, zone abbreviation (EST/EDT/PST/PDT) and date logic come from
 * `lib/resortTime.ts`; the selected resort — never the browser timezone —
 * decides the zone. The tick lives in this component's own state, so a tick
 * re-renders only the clock and never touches page data/refresh/profile state.
 *
 * `now` starts null and is set on mount, so server render and first client
 * render match (no incorrect-time flash). Pages should still mount it only
 * after their resort selection has hydrated.
 */

import { useEffect, useState } from "react";
import type { ResortId } from "@disney-wait-planner/shared";
import {
  formatResortLocalTime,
  getResortTimeZoneAbbreviation,
} from "../lib/resortTime";

/** User-facing subtext (presentation only; ResortId/timezone contracts unchanged). */
export const RESORT_CLOCK_LABELS: Record<ResortId, string> = {
  WDW: "Disney World local time",
  DLR: "Disneyland local time",
};

export default function ResortClock({
  resort,
  marginBottom = 12,
}: {
  resort: ResortId;
  marginBottom?: number;
}) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  return (
    <div
      aria-label={RESORT_CLOCK_LABELS[resort]}
      style={{ marginBottom, lineHeight: 1.3 }}
    >
      <div style={{ fontSize: "15px", fontWeight: 500, color: "#4b5563", minHeight: "20px" }}>
        {now
          ? `${formatResortLocalTime(resort, now)} ${getResortTimeZoneAbbreviation(resort, now)}`
          : " "}
      </div>
      <div style={{ fontSize: "12px", color: "#9ca3af" }}>
        {RESORT_CLOCK_LABELS[resort]}
      </div>
    </div>
  );
}

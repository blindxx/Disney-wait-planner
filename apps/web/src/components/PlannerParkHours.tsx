/**
 * PlannerParkHours — compact exact-date park hours for the active My Plans day
 * (Phase 12.6). Presentational + request lifecycle only: the caller supplies the
 * day's already-resolved `date` + effective `parkId` (My Plans' own manual/Auto
 * resolution — no park authority here); all interpretation lives in
 * lib/parkHours.ts (`describeParkDateHours`). Renders nothing without both.
 * Latest-request-wins: a response for a previous day/date/park is dropped, and
 * stored results are re-checked against the current park/date at render.
 */

"use client";

import { useEffect, useState } from "react";
import type { ParkId, ResortId } from "@disney-wait-planner/shared";
import {
  describeParkDateHours,
  parkDateHoursForDisplay,
  parkDateRequestIssue,
  resolveParkDateHoursResponse,
  type ParkDateHours,
} from "../lib/parkHours";
import { getResortLocalDate } from "../lib/resortTime";
import { PARK_TO_RESORT } from "../lib/parkMetadata";
import ThemeParksAttribution from "./ThemeParksAttribution";

export default function PlannerParkHours({
  dayId,
  date,
  parkId,
}: {
  dayId: string;
  date: string | null;
  parkId: ParkId | null;
}) {
  const [raw, setRaw] = useState<ParkDateHours | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Display clock, same 15 s cadence as ResortClock (visible tab only). Display-only:
  // it never polls the provider; it only makes the resort-local day rollover observable.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") setNow(new Date()); };
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, []);
  // Resort-local today: crossing midnight changes it, which refetches once (below).
  const resortToday = parkId ? getResortLocalDate(PARK_TO_RESORT[parkId] as ResortId, now) : null;

  useEffect(() => {
    setRaw(null);
    // Past/invalid dates have no schedule state to show (and need no request).
    if (!date || !parkId || parkDateRequestIssue(parkId, date)) return;
    let cancelled = false;
    let latest = 0;
    const load = () => {
      const token = ++latest;
      const url = `/api/park-hours?parkId=${encodeURIComponent(parkId)}&date=${encodeURIComponent(date)}`;
      fetch(url, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((body) => {
          if (!cancelled && token === latest) setRaw(resolveParkDateHoursResponse(parkId, date, body));
        });
    };
    load();
    // Re-evaluate on return to the tab (resort-local day rollover) and refetch then.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setNow(new Date());
      load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayId, date, parkId, resortToday]);

  const data = parkDateHoursForDisplay(raw, parkId, date, now);
  // Reserve the line while loading so layout doesn't jump.
  if (!date || !parkId || parkDateRequestIssue(parkId, date, now)) return null;
  if (!data) return <div style={{ minHeight: 20 }} aria-hidden />;
  const d = describeParkDateHours(data);
  return (
    <div aria-label="Park hours for this day" style={{ lineHeight: 1.4, fontSize: "14px", color: "#4b5563", margin: "4px 0 8px" }}>
      <div style={{ fontWeight: 500 }}>
        {d.headline}
        {d.stale && <span title="Park hours may be out of date" style={{ fontWeight: 400, color: "#9ca3af" }}> (may be outdated)</span>}
      </div>
      {d.extras.length > 0 && <div style={{ fontSize: "12px", color: "#6b7280" }}>{d.extras.join(" • ")}</div>}
      {d.presentsProviderData && (
        <div style={{ fontSize: "12px", color: "#6b7280" }}>
          Park hours powered by{" "}
          <ThemeParksAttribution linkOnly style={{ fontSize: "inherit", color: "#6b7280", opacity: 1, textDecoration: "underline" }} />
        </div>
      )}
    </div>
  );
}

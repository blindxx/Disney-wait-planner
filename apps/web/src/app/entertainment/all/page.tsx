"use client";

/*
Async Fetch Safety Notes
Hidden All Entertainment page (route: /entertainment/all, no navigation link).
Same lifecycle as the Waits & Shows showtimes/park-hours requests:
• Latest-request-wins per park; responses for a park that is no longer
  selected are dropped (`cancelled`), and a failure never keeps old data.
• The 15 s display clock only re-evaluates passed times / date rollover and
  never fetches; provider requests stay on the visibility + 120 s poll.
• Expansion state is keyed by stable entry ids, so refreshes and clock ticks
  never collapse an expanded card.
*/

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { type ParkId, type ResortId } from "@disney-wait-planner/shared";
import ResortClock from "../../../components/ResortClock";
import ThemeParksAttribution from "../../../components/ThemeParksAttribution";
import ParkHoursLine from "../../../components/ParkHoursLine";
import {
  describeParkHours,
  parkHoursForDisplay,
  resolveParkHoursResponse,
  type ParkHours,
} from "../../../lib/parkHours";
import {
  allEntertainmentForDisplay,
  allEntertainmentLands,
  allEntertainmentEmptyState,
  allEntertainmentIsIncomplete,
  allEntertainmentPresentsProviderData,
  INVENTORY_INCOMPLETE_NOTE,
  allEntryLayout,
  allEntryLocationLabel,
  allEntryProviderStatus,
  allEntryViewAt,
  filterAllEntertainment,
  resolveAllEntertainmentResponse,
  showtimesRegionId,
  sortAllEntertainment,
  toggleExpanded,
  type AllEntertainmentEntry,
  type ParkAllEntertainment,
} from "../../../lib/entertainmentAll";
import { PARTIAL_SHOWTIMES_NOTE } from "../../../lib/entertainmentShowtimes";
import { getSettingsDefaults } from "../../../lib/settingsDefaults";
import { isValidParkId, PARK_TO_RESORT } from "../../../lib/parkMetadata";

const RESORT_PARKS: Record<ResortId, ParkId[]> = {
  DLR: ["disneyland", "dca"],
  WDW: ["mk", "epcot", "hs", "ak"],
};
const RESORT_LABELS: Record<ResortId, string> = { DLR: "Disneyland Resort", WDW: "Walt Disney World" };
const PARK_TAB_LABELS: Record<ParkId, string> = {
  disneyland: "Disneyland",
  dca: "California Adventure",
  mk: "Magic Kingdom",
  epcot: "EPCOT",
  hs: "Hollywood Studios",
  ak: "Animal Kingdom",
};

// Same tab/grid/card model as Waits & Shows (mobile bordered list → 2 → 3 columns).
const RESPONSIVE_CSS = `
  .all-page { max-width: 800px; margin: 0 auto; padding: 16px; overflow-x: hidden; }
  .resort-tab {
    flex: 1 1 0%; padding: 8px 6px; border-radius: 8px; border: 1px solid #d1d5db; cursor: pointer;
    font-weight: 600; font-size: 13px; line-height: 1.2; text-align: center;
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }
  .park-tab {
    flex: 1 1 0%; padding: 10px 8px; border-radius: 8px; border: none; cursor: pointer;
    font-weight: 600; font-size: 14px; line-height: 1.2; text-align: center;
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .entertainment-grid { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  .entertainment-card { padding: 12px 16px; min-height: 56px; border-bottom: 1px solid #e5e7eb; background-color: #fff; }
  .entertainment-card:last-child { border-bottom: none; }
  .all-empty { padding: 48px 20px; text-align: center; color: #6b7280; font-size: 15px; background-color: #fff; }
  .all-toggle { background: none; border: none; padding: 4px 0; margin-top: 2px; font-size: 12px; color: #2563eb; cursor: pointer; }
  @media (min-width: 768px) {
    .all-page { padding: 20px; }
    .resort-tab { flex: 0 1 auto; padding: 8px 16px; }
    .park-tab { flex: 0 1 auto; padding: 10px 20px; }
    .entertainment-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; border: none; border-radius: 0; overflow: visible; }
    .entertainment-card { border: 1px solid #e5e7eb; border-radius: 8px; }
    .entertainment-card:last-child { border: 1px solid #e5e7eb; }
    .all-empty { grid-column: 1 / -1; border: 1px solid #e5e7eb; border-radius: 8px; }
  }
  @media (min-width: 1024px) {
    .all-page { max-width: 1100px; padding: 24px; }
    .entertainment-grid { grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .entertainment-card { padding: 10px 14px; min-height: 52px; }
  }
`;

const selectStyle = {
  padding: "6px 10px",
  borderRadius: "6px",
  border: "1px solid #d1d5db",
  backgroundColor: "#fff",
  fontSize: "14px",
  cursor: "pointer",
} as const;

function humanizeStatus(s: string): string {
  const t = s.toLowerCase().replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * One card. Collapsed: exactly the Waits & Shows showtime line (upcoming /
 * in-progress times, or the status message). Expanded: the full daily schedule
 * with passed times muted.
 */
function AllEntertainmentCard({
  entry,
  stale,
  now,
  expanded,
  onToggle,
}: {
  entry: AllEntertainmentEntry;
  stale: boolean;
  now: Date;
  expanded: boolean;
  onToggle: () => void;
}) {
  const view = allEntryViewAt(entry, now);
  const isUpcoming = view.status === "upcoming";
  const providerStatus = allEntryProviderStatus(entry);
  const nonOperating = providerStatus && providerStatus !== "OPERATING" ? humanizeStatus(providerStatus) : null;
  const locationLabel = allEntryLocationLabel(entry);
  const { showFull, showShowtimes, showtimesStale, hoursStale, staleScope } = allEntryLayout(view, expanded, stale);
  const timesId = showtimesRegionId(entry.id);

  return (
    <div className="entertainment-card">
      <div
        title={entry.name}
        style={{
          fontWeight: 600,
          fontSize: "15px",
          lineHeight: "1.3",
          color: "#111827",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical" as const,
          overflow: "hidden",
          overflowWrap: "anywhere",
        }}
      >
        {entry.name}
      </div>
      {(locationLabel || nonOperating) && (
        <div style={{ fontSize: "13px", lineHeight: "1.3", color: "#6b7280", marginTop: "2px" }}>
          {locationLabel}
          {locationLabel && nonOperating && <> &bull; </>}
          {nonOperating}
        </div>
      )}
      {showShowtimes && (
        <div
          id={timesId}
          style={{ fontSize: "13px", lineHeight: "1.3", color: isUpcoming ? "#374151" : "#9ca3af", marginTop: "4px" }}
        >
          {showFull ? (
            <>
              {view.times.map((t, i) => (
                <span key={i} style={{ color: t.passed ? "#9ca3af" : "#374151" }}>
                  {i > 0 && <span style={{ color: "#9ca3af" }}> • </span>}
                  {t.localTime}
                </span>
              ))}
              {view.incomplete && <span style={{ color: "#9ca3af", fontSize: "12px" }}> ({PARTIAL_SHOWTIMES_NOTE})</span>}
            </>
          ) : (
            <>
              {view.collapsedText}
              {view.partial && <span style={{ color: "#9ca3af", fontSize: "12px" }}> ({PARTIAL_SHOWTIMES_NOTE})</span>}
            </>
          )}
          {showtimesStale && <span title="Showtimes may be out of date"> (may be outdated)</span>}
        </div>
      )}
      {view.hoursText && (
        <div style={{ fontSize: "13px", lineHeight: "1.3", color: "#6b7280", marginTop: showShowtimes ? "2px" : "4px" }}>
          {view.hoursText}
          {hoursStale && (
            <span title={staleScope === "both" ? "Showtimes and hours may be out of date" : "Hours may be out of date"}>
              {staleScope === "both" ? " (showtimes and hours may be outdated)" : " (may be outdated)"}
            </span>
          )}
        </div>
      )}
      {view.expandable && (
        <button type="button" className="all-toggle" onClick={onToggle} aria-expanded={expanded} aria-controls={timesId}>
          {expanded ? "Show fewer" : "Show all times"}
        </button>
      )}
    </div>
  );
}

export default function AllEntertainmentPage() {
  // Server-safe defaults; the real selection is applied on mount (no hydration mismatch).
  const [selectedPark, setSelectedPark] = useState<ParkId>("disneyland");
  const [ready, setReady] = useState(false);
  const [operatingOnly, setOperatingOnly] = useState(false);
  const [selectedLand, setSelectedLand] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const selectedResort = PARK_TO_RESORT[selectedPark] as ResortId;

  // Initial park: ?park= (from the Waits & Shows link), else the Settings default park.
  useEffect(() => {
    let park: ParkId = getSettingsDefaults().defaultPark;
    try {
      const q = new URLSearchParams(window.location.search).get("park");
      if (q && isValidParkId(q)) park = q;
    } catch {}
    setSelectedPark(park);
    setReady(true);
  }, []);

  function selectPark(parkId: ParkId) {
    setSelectedPark(parkId);
    setSelectedLand("");
    setExpanded(new Set());
  }

  const [allRaw, setAll] = useState<ParkAllEntertainment | null>(null);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let latestRequest = 0;
    const load = () => {
      const token = ++latestRequest;
      fetch(`/api/entertainment/all?parkId=${encodeURIComponent(selectedPark)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((body) => { if (!cancelled && token === latestRequest) setAll(resolveAllEntertainmentResponse(selectedPark, body)); });
    };
    setAll(null);
    load();
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 120_000);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, selectedPark]);

  const [parkHoursRaw, setParkHours] = useState<ParkHours | null>(null);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let latestRequest = 0;
    const load = () => {
      const token = ++latestRequest;
      fetch(`/api/park-hours?parkId=${encodeURIComponent(selectedPark)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((body) => { if (!cancelled && token === latestRequest) setParkHours(resolveParkHoursResponse(selectedPark, body)); });
    };
    setParkHours(null);
    load();
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 120_000);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, selectedPark]);

  // Display clock: advances upcoming/in-progress times, sort order and date rollover. Never fetches.
  const [displayNow, setDisplayNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setDisplayNow(new Date());
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    tick();
    const id = setInterval(() => { if (document.visibilityState === "visible") tick(); }, 15_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  // Never use retained state from a previously selected park or resort-local day.
  const allCurrent = allEntertainmentForDisplay(allRaw, displayNow);
  const all = allCurrent && allCurrent.parkId === selectedPark ? allCurrent : null;
  const parkHoursCurrent = parkHoursForDisplay(parkHoursRaw, displayNow);
  const parkHours = parkHoursCurrent && parkHoursCurrent.parkId === selectedPark ? parkHoursCurrent : null;
  const parkHoursPresented = !!parkHours && describeParkHours(parkHours).presentsProviderData;
  const inventoryPresented = allEntertainmentPresentsProviderData(all);

  const lands = useMemo(() => allEntertainmentLands(all?.entries ?? []), [all]);
  // A land that no longer exists in the refreshed inventory must not silently hide everything.
  const effectiveLand = lands.includes(selectedLand) ? selectedLand : "";
  const visible = useMemo(
    () => sortAllEntertainment(filterAllEntertainment(all?.entries ?? [], { land: effectiveLand, operatingOnly }), displayNow),
    [all, effectiveLand, operatingOnly, displayNow],
  );

  return (
    <>
      <style>{RESPONSIVE_CSS}</style>
      <div className="all-page">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "4px", marginBottom: "16px" }}>
          <h1 style={{ fontSize: "22px", fontWeight: 700, color: "#111827", margin: 0 }}>All Entertainment</h1>
          <Link href="/wait-times" style={{ fontSize: "13px", color: "#2563eb" }}>&larr; Waits &amp; Shows</Link>
        </div>

        {ready ? (
          <>
            <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
              {(Object.keys(RESORT_LABELS) as ResortId[]).map((resortId) => (
                <button
                  key={resortId}
                  className="resort-tab"
                  onClick={() => { if (resortId !== selectedResort) selectPark(RESORT_PARKS[resortId][0]); }}
                  style={{
                    backgroundColor: selectedResort === resortId ? "#1e3a5f" : "#f9fafb",
                    color: selectedResort === resortId ? "#fff" : "#374151",
                    borderColor: selectedResort === resortId ? "#1e3a5f" : "#d1d5db",
                  }}
                >
                  {RESORT_LABELS[resortId]}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
              {RESORT_PARKS[selectedResort].map((parkId) => (
                <button
                  key={parkId}
                  className="park-tab"
                  onClick={() => { if (parkId !== selectedPark) selectPark(parkId); }}
                  style={{
                    backgroundColor: selectedPark === parkId ? "#2563eb" : "#f3f4f6",
                    color: selectedPark === parkId ? "#fff" : "#374151",
                  }}
                >
                  {PARK_TAB_LABELS[parkId]}
                </button>
              ))}
            </div>
            <ResortClock resort={selectedResort} marginBottom={4} />
            <ParkHoursLine data={parkHours} />
          </>
        ) : (
          <>
            <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
              <div style={{ flex: 1, height: 36, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
              <div style={{ flex: 1, height: 36, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
            </div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
              <div style={{ flex: 1, height: 32, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
              <div style={{ flex: 1, height: 32, borderRadius: 8, backgroundColor: "#f3f4f6" }} />
            </div>
            <div style={{ height: 55, marginBottom: "12px" }} />
          </>
        )}

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "10px",
            marginBottom: "12px",
            padding: "10px 12px",
            backgroundColor: "#f9fafb",
            borderRadius: "8px",
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "14px", color: "#374151", minHeight: "32px" }}>
            <input
              type="checkbox"
              checked={operatingOnly}
              onChange={(e) => setOperatingOnly(e.target.checked)}
              style={{ width: "18px", height: "18px", cursor: "pointer" }}
            />
            Operating only
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "13px", color: "#6b7280" }}>Land:</span>
            <select value={effectiveLand} onChange={(e) => setSelectedLand(e.target.value)} style={selectStyle}>
              <option value="">All Lands</option>
              {lands.map((land) => (
                <option key={land} value={land}>{land}</option>
              ))}
            </select>
          </div>
        </div>

        <p style={{ fontSize: "12px", color: "#9ca3af", marginTop: 0, marginBottom: "10px" }}>
          Explore today&apos;s entertainment and showtimes throughout the park.
        </p>

        <div className="entertainment-grid">
          {!all ? (
            <div className="all-empty">Loading entertainment&hellip;</div>
          ) : all.error ? (
            <div className="all-empty">Entertainment is unavailable right now. Try again shortly.</div>
          ) : all.entries.length === 0 ? (
            <div className="all-empty">
              {allEntertainmentEmptyState(all)?.message}
              {all.stale && <span title="Showtimes may be out of date"> (may be outdated)</span>}
            </div>
          ) : visible.length === 0 ? (
            <div className="all-empty">No entertainment matches your filters.</div>
          ) : (
            visible.map((entry) => (
              <AllEntertainmentCard
                key={entry.id}
                entry={entry}
                stale={all.stale}
                now={displayNow}
                expanded={expanded.has(entry.id)}
                onToggle={() => setExpanded((prev) => toggleExpanded(prev, entry.id))}
              />
            ))
          )}
        </div>

        {all && !all.error && all.entries.length > 0 && (
          <div style={{ marginTop: "10px", fontSize: "13px", color: "#9ca3af" }}>
            Showing {visible.length} entertainment {visible.length === 1 ? "experience" : "experiences"}
          </div>
        )}
        {allEntertainmentIsIncomplete(all) && all!.entries.length > 0 && (
          <div role="note" style={{ marginTop: "6px", fontSize: "12px", color: "#9ca3af" }}>{INVENTORY_INCOMPLETE_NOTE}</div>
        )}
      </div>

      {(inventoryPresented || parkHoursPresented) && (
        <div style={{ textAlign: "center", padding: "16px", fontSize: "12px", color: "#9ca3af" }}>
          {inventoryPresented && parkHoursPresented ? "Park hours and showtimes" : parkHoursPresented ? "Park hours" : "Showtimes"} powered by{" "}
          <ThemeParksAttribution linkOnly />
        </div>
      )}
    </>
  );
}

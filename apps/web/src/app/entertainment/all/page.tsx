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
import { getResortLocalDate } from "../../../lib/resortTime";
import { applyAllEntertainmentSeasonalVisibility, getOffSeasonCuratedEntertainment, makeOffSeasonEntry } from "../../../lib/seasonalVisibility";
import {
  describeAllEntertainmentEvent,
  EVENT_BROWSE_NOTE,
  EVENT_DATES_NOTE,
  EVENT_NIGHTS_PREVIEW,
  EVENT_NO_ENTERTAINMENT_MESSAGE,
  getAllEntertainmentEventEntries,
  getAllEntertainmentEventOptions,
  effectiveEventBrowseFilters,
  resolveEventSelection,
  showOperatingOnlyToggle,
  showOutOfSeasonToggle,
} from "../../../lib/allEntertainmentEventFilter";

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
    flex: 1 1 0%; padding: 8px 6px; border-radius: 8px; border: 1px solid var(--border); cursor: pointer;
    font-weight: 600; font-size: 13px; line-height: 1.2; text-align: center;
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }
  .park-tab {
    flex: 1 1 0%; padding: 10px 8px; border-radius: 8px; border: none; cursor: pointer;
    font-weight: 600; font-size: 14px; line-height: 1.2; text-align: center;
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .entertainment-grid { border: 1px solid var(--border-soft); border-radius: 8px; overflow: hidden; }
  .entertainment-card { padding: 12px 16px; min-height: 56px; border-bottom: 1px solid var(--border-soft); background-color: var(--surface); }
  .entertainment-card:last-child { border-bottom: none; }
  .all-empty { padding: 48px 20px; text-align: center; color: var(--text-muted); font-size: 15px; background-color: var(--surface); }
  .all-toggle { background: none; border: none; padding: 4px 0; margin-top: 2px; font-size: 12px; color: var(--status-info); cursor: pointer; }
  .all-select-field { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
  .all-select-field > label { flex: 0 0 44px; font-size: 13px; color: var(--text-muted); }
  .all-event-select { width: 250px; max-width: 100%; min-width: 0; text-overflow: ellipsis; padding-right: 32px !important; }
  .all-land-select { max-width: 100%; min-width: 0; }
  .all-event-info { max-width: 650px; margin-bottom: 12px; padding: 10px 12px; border: 1px solid var(--border-soft); border-radius: 8px; background-color: var(--surface); font-size: 13px; line-height: 1.4; color: var(--text); overflow-wrap: anywhere; }
  @media (max-width: 520px) {
    .all-select-field { flex: 1 1 100%; }
    .all-event-select, .all-land-select { flex: 1 1 0%; width: auto; }
  }
  @media (min-width: 768px) {
    .all-page { padding: 20px; }
    .resort-tab { flex: 0 1 auto; padding: 8px 16px; }
    .park-tab { flex: 0 1 auto; padding: 10px 20px; }
    .entertainment-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; border: none; border-radius: 0; overflow: visible; }
    .entertainment-card { border: 1px solid var(--border-soft); border-radius: 8px; }
    .entertainment-card:last-child { border: 1px solid var(--border-soft); }
    .all-empty { grid-column: 1 / -1; border: 1px solid var(--border-soft); border-radius: 8px; }
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
  border: "1px solid var(--border)",
  backgroundColor: "var(--surface)",
  color: "var(--text-strong)",
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
          color: "var(--text-strong)",
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
        <div style={{ fontSize: "13px", lineHeight: "1.3", color: "var(--text-muted)", marginTop: "2px" }}>
          {locationLabel}
          {locationLabel && nonOperating && <> &bull; </>}
          {nonOperating}
        </div>
      )}
      {showShowtimes && (
        <div
          id={timesId}
          style={{ fontSize: "13px", lineHeight: "1.3", color: isUpcoming ? "var(--text)" : "var(--text-faint)", marginTop: "4px" }}
        >
          {showFull ? (
            <>
              {view.times.map((t, i) => (
                <span key={i} style={{ color: t.passed ? "var(--text-faint)" : "var(--text)" }}>
                  {i > 0 && <span style={{ color: "var(--text-faint)" }}> • </span>}
                  {t.localTime}
                </span>
              ))}
              {view.incomplete && <span style={{ color: "var(--text-faint)", fontSize: "12px" }}> ({PARTIAL_SHOWTIMES_NOTE})</span>}
            </>
          ) : (
            <>
              {view.collapsedText}
              {view.partial && <span style={{ color: "var(--text-faint)", fontSize: "12px" }}> ({PARTIAL_SHOWTIMES_NOTE})</span>}
            </>
          )}
          {showtimesStale && <span title="Showtimes may be out of date"> (may be outdated)</span>}
        </div>
      )}
      {view.hoursText && (
        <div style={{ fontSize: "13px", lineHeight: "1.3", color: "var(--text-muted)", marginTop: showShowtimes ? "2px" : "4px" }}>
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
  const [showOutOfSeason, setShowOutOfSeason] = useState(false);
  const [selectedLand, setSelectedLand] = useState("");
  const [selectedEvent, setSelectedEvent] = useState("");
  const [nightsExpanded, setNightsExpanded] = useState(false);
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
    setSelectedEvent("");
    setNightsExpanded(false);
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

  // When "Show out-of-season entertainment" is ON, synthesize entries for curated
  // shows that are confirmed out-of-season and not already in the live inventory.
  const offSeasonEntries = useMemo<AllEntertainmentEntry[]>(() => {
    if (!showOutOfSeason) return [];
    const today = getResortLocalDate(selectedResort, displayNow);
    const existingIds = new Set((all?.entries ?? []).map((e) => e.id));
    return getOffSeasonCuratedEntertainment(selectedPark, today, existingIds, displayNow).map((place) =>
      makeOffSeasonEntry(place, selectedPark),
    );
  }, [showOutOfSeason, selectedPark, selectedResort, displayNow, all]);

  const today = getResortLocalDate(selectedResort, displayNow);
  // Event options are static per park (registry + associations + confirmed current/upcoming dates); selecting never fetches.
  const eventOptions = useMemo(() => getAllEntertainmentEventOptions(selectedPark, displayNow), [selectedPark, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const effectiveEvent = resolveEventSelection(selectedPark, selectedEvent, displayNow);
  const eventInfo = useMemo(
    () => describeAllEntertainmentEvent(selectedPark, effectiveEvent, displayNow),
    [selectedPark, effectiveEvent, today], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Specific event: catalog browsing of everything associated (live + synthesized curated), ignoring seasonal hiding.
  const eventPool = useMemo<AllEntertainmentEntry[] | null>(
    () => (effectiveEvent ? getAllEntertainmentEventEntries(all?.entries ?? [], selectedPark, effectiveEvent, displayNow) : null),
    [all, selectedPark, effectiveEvent, today], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Include lands from synthesized off-season entries so the land filter works for them too.
  const lands = useMemo(
    () => allEntertainmentLands(eventPool ?? [...(all?.entries ?? []), ...offSeasonEntries]),
    [all, offSeasonEntries, eventPool],
  );
  // A land that no longer exists in the refreshed inventory must not silently hide everything.
  const effectiveLand = lands.includes(selectedLand) ? selectedLand : "";

  const visible = useMemo(() => {
    if (eventPool) {
      return sortAllEntertainment(filterAllEntertainment(eventPool, effectiveEventBrowseFilters(effectiveEvent, { land: effectiveLand, operatingOnly })), displayNow);
    }
    const sourceEntries = all?.entries ?? [];
    // When toggle is OFF, hide confirmed out-of-season entries (curated, and explicitly party-classified provider-only) even if
    // they are present in the provider inventory. Toggle ON restores them.
    const seasonalBase = applyAllEntertainmentSeasonalVisibility(sourceEntries, selectedPark, selectedResort, today, showOutOfSeason, displayNow);
    const base = filterAllEntertainment(seasonalBase, { land: effectiveLand, operatingOnly });
    // Synthesized off-season entries have no provider status so they never satisfy
    // "Operating only"; exclude them when that filter is active.
    const extra =
      showOutOfSeason && !operatingOnly
        ? offSeasonEntries.filter((e) => !effectiveLand || e.land === effectiveLand)
        : [];
    return sortAllEntertainment([...base, ...extra], displayNow);
  }, [all, eventPool, effectiveLand, operatingOnly, displayNow, showOutOfSeason, offSeasonEntries, selectedPark, selectedResort, today]);

  return (
    <>
      <style>{RESPONSIVE_CSS}</style>
      <div className="all-page">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "4px", marginBottom: "16px" }}>
          <h1 style={{ fontSize: "22px", fontWeight: 700, color: "var(--text-strong)", margin: 0 }}>All Entertainment</h1>
          <Link href="/wait-times" style={{ fontSize: "13px", color: "var(--status-info)" }}>&larr; Waits &amp; Shows</Link>
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
                    backgroundColor: selectedResort === resortId ? "var(--control-selected-bg)" : "var(--surface-subtle)",
                    color: selectedResort === resortId ? "var(--control-selected-fg)" : "var(--text)",
                    borderColor: selectedResort === resortId ? "var(--control-selected-bg)" : "var(--border)",
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
                    backgroundColor: selectedPark === parkId ? "var(--accent-selected-bg)" : "var(--surface-muted)",
                    color: selectedPark === parkId ? "var(--control-selected-fg)" : "var(--text)",
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
              <div style={{ flex: 1, height: 36, borderRadius: 8, backgroundColor: "var(--surface-muted)" }} />
              <div style={{ flex: 1, height: 36, borderRadius: 8, backgroundColor: "var(--surface-muted)" }} />
            </div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
              <div style={{ flex: 1, height: 32, borderRadius: 8, backgroundColor: "var(--surface-muted)" }} />
              <div style={{ flex: 1, height: 32, borderRadius: 8, backgroundColor: "var(--surface-muted)" }} />
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
            backgroundColor: "var(--surface-subtle)",
            borderRadius: "8px",
          }}
        >
          {showOperatingOnlyToggle(effectiveEvent) && (
          <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "14px", color: "var(--text)", minHeight: "32px" }}>
            <input
              type="checkbox"
              checked={operatingOnly}
              onChange={(e) => setOperatingOnly(e.target.checked)}
              style={{ width: "18px", height: "18px", cursor: "pointer" }}
            />
            Operating only
          </label>
          )}
          {showOutOfSeasonToggle(effectiveEvent) && (
          <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "14px", color: "var(--text)", minHeight: "32px" }}>
            <input
              type="checkbox"
              checked={showOutOfSeason}
              onChange={(e) => setShowOutOfSeason(e.target.checked)}
              style={{ width: "18px", height: "18px", cursor: "pointer" }}
            />
            Show out-of-season entertainment
          </label>
          )}
          <div className="all-select-field">
            <label htmlFor="all-ent-event">Event:</label>
            <select
              id="all-ent-event"
              className="all-event-select"
              value={effectiveEvent}
              title={eventOptions.find((o) => o.value === effectiveEvent)?.label}
              onChange={(e) => { setSelectedEvent(e.target.value); setNightsExpanded(false); }}
              style={selectStyle}
            >
              {eventOptions.map((o) => (
                <option key={o.value} value={o.value} title={o.label}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="all-select-field">
            <label htmlFor="all-ent-land">Land:</label>
            <select id="all-ent-land" className="all-land-select" value={effectiveLand} onChange={(e) => setSelectedLand(e.target.value)} style={selectStyle}>
              <option value="">All Lands</option>
              {lands.map((land) => (
                <option key={land} value={land}>{land}</option>
              ))}
            </select>
          </div>
        </div>

        {eventInfo && (
          <section className="all-event-info" aria-label={`${eventInfo.name} event information`}>
            <div style={{ fontWeight: 600, color: "var(--text-strong)" }}>{eventInfo.name}</div>
            <div style={{ color: "var(--text-muted)" }}>
              {[eventInfo.admission, eventInfo.seasonLabel, eventInfo.statusLabel].filter(Boolean).join(" · ")}
            </div>
            {eventInfo.unannouncedText && <div>{eventInfo.unannouncedText}</div>}
            {eventInfo.rangeText && (
              <div>{eventInfo.nights ? "Event window: " : "Dates: "}{eventInfo.rangeText}</div>
            )}
            {eventInfo.nights && eventInfo.nights.length > 0 && (
              <div>
                <span>Select nights{eventInfo.nights.length > 1 ? ` (${eventInfo.nights.length} remaining)` : ""}: </span>
                <span id="all-ent-event-nights">
                  {(nightsExpanded ? eventInfo.nights : eventInfo.nights.slice(0, EVENT_NIGHTS_PREVIEW)).join(", ")}
                  {!nightsExpanded && eventInfo.nights.length > EVENT_NIGHTS_PREVIEW && "…"}
                </span>
                {eventInfo.nights.length > EVENT_NIGHTS_PREVIEW && (
                  <button type="button" className="all-toggle" style={{ marginLeft: "6px" }} onClick={() => setNightsExpanded((v) => !v)} aria-expanded={nightsExpanded} aria-controls="all-ent-event-nights">
                    {nightsExpanded ? "Show fewer" : `Show all ${eventInfo.nights.length}`}
                  </button>
                )}
              </div>
            )}
            {eventInfo.offerings.map((o) => <div key={o}>{o}</div>)}
            {eventInfo.seasonLabel && <div style={{ color: "var(--text-faint)", fontSize: "12px", marginTop: "2px" }}>{EVENT_DATES_NOTE}</div>}
            <div style={{ color: "var(--text-faint)", fontSize: "12px", marginTop: "2px" }}>{EVENT_BROWSE_NOTE}</div>
          </section>
        )}

        <p style={{ fontSize: "12px", color: "var(--text-faint)", marginTop: 0, marginBottom: "10px" }}>
          Explore today&apos;s entertainment and showtimes throughout the park.
        </p>

        <div className="entertainment-grid">
          {!all ? (
            <div className="all-empty">Loading entertainment&hellip;</div>
          ) : all.error ? (
            <div className="all-empty">Entertainment is unavailable right now. Try again shortly.</div>
          ) : eventPool && eventPool.length === 0 ? (
            <div className="all-empty">{EVENT_NO_ENTERTAINMENT_MESSAGE}</div>
          ) : all.entries.length === 0 && visible.length === 0 && !eventPool ? (
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

        {all && !all.error && (all.entries.length > 0 || (eventPool?.length ?? 0) > 0) && (
          <div style={{ marginTop: "10px", fontSize: "13px", color: "var(--text-faint)" }}>
            Showing {visible.length} entertainment {visible.length === 1 ? "experience" : "experiences"}
          </div>
        )}
        {allEntertainmentIsIncomplete(all) && all!.entries.length > 0 && (
          <div role="note" style={{ marginTop: "6px", fontSize: "12px", color: "var(--text-faint)" }}>{INVENTORY_INCOMPLETE_NOTE}</div>
        )}
      </div>

      {(inventoryPresented || parkHoursPresented) && (
        <div style={{ textAlign: "center", padding: "16px", fontSize: "12px", color: "var(--text-faint)" }}>
          {inventoryPresented && parkHoursPresented ? "Park hours and showtimes" : parkHoursPresented ? "Park hours" : "Showtimes"} powered by{" "}
          <ThemeParksAttribution linkOnly />
        </div>
      )}
    </>
  );
}

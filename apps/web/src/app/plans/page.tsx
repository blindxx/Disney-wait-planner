"use client";

import { useState, useEffect, useMemo } from "react";
import { mockAttractionWaits } from "@disney-wait-planner/shared";

type PlanItem = {
  id: string;
  name: string;
  timeLabel: string;
};

type Mode = "view" | "add" | "edit" | "import";

let nextId = 1;
function makeId() {
  return String(nextId++);
}

// ===== TIME PARSING UTILITIES =====

/** Strip internal whitespace and lowercase for AM/PM token comparison */
function normalizeAmPmStr(str: string): string {
  return str.replace(/\s+/g, "").toLowerCase();
}

/**
 * Parse an AM/PM time token (e.g. "10am", "10 pm", "10:00am", "10:0am").
 * Returns internal 24h string "H:MM" or null if invalid.
 * Hours must be 1-12. Single-digit minutes => treated as 00 (strict).
 */
function parseAmPmToken(raw: string): string | null {
  const s = normalizeAmPmStr(raw);
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?([ap]m)$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const rawMin = m[2];
  const meridiem = m[3];

  // AM/PM hours must be 1-12
  if (h < 1 || h > 12) return null;

  let min = 0;
  if (rawMin !== undefined) {
    // Single-digit minute is treated strictly as 00
    min = rawMin.length === 1 ? 0 : parseInt(rawMin, 10);
    if (min < 0 || min > 59) return null;
  }

  if (meridiem === "am") {
    if (h === 12) h = 0; // 12am => 0
  } else {
    if (h !== 12) h += 12; // 1-11 pm => +12; 12pm stays 12
  }
  return `${h}:${String(min).padStart(2, "0")}`;
}

/**
 * Parse a strict 24h time token "H:MM" or "HH:MM" (must have exactly 2 digit minutes).
 * Returns "H:MM" string or null if invalid.
 */
function parse24hToken(str: string): string | null {
  const m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${h}:${m[2]}`;
}

/**
 * Parse a 4-digit military time token e.g. "1500" => "15:00", "0730" => "7:30".
 * First two digits = hours (00–23), last two = minutes (00–59).
 * Returns canonical "H:MM" (no leading zero on hour) or null if invalid.
 */
function parseMilToken(str: string): string | null {
  if (!/^\d{4}$/.test(str)) return null;
  const h = parseInt(str.slice(0, 2), 10);
  const min = parseInt(str.slice(2), 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${h}:${String(min).padStart(2, "0")}`;
}

/** True if the string contains at least one alphanumeric character. */
function hasValidName(s: string): boolean {
  return /[a-zA-Z0-9]/.test(s);
}

/**
 * Strip trailing valid time tokens from the end of a name string, up to
 * `maxPasses` times. Recognised tokens per pass (tried in order):
 *   1. AM/PM  — e.g. "10am", "10 pm", "10:00pm"
 *   2. 24h    — strict "H:MM" with exactly 2 minute digits
 *   3. Military — exactly 4 digits "HHMM" (e.g. "1500", "0730")
 * Each pass keeps the stripped result only if the remainder still passes
 * hasValidName. Stops early when nothing strippable is at the end.
 *
 * Test cases (maxPasses=2):
 *   "Space Mountain 22:00"          => "Space Mountain"
 *   "Space Mountain 10pm"           => "Space Mountain"
 *   "Space Mountain 10pm 22:00"     => "Space Mountain"    (2 passes)
 *   "Space Mountain 0730 1500"      => "Space Mountain"    (2 passes, military)
 *   "Space Mountain 22:00 blah"     => unchanged            (token not at end)
 *   "Space Mountain 10pm blah"      => unchanged            (token not at end)
 *   "Space Mountain"                => unchanged            (no trailing token)
 */
function stripTrailingTimeTokens(name: string, maxPasses = 2): string {
  let current = name;
  for (let pass = 0; pass < maxPasses; pass++) {
    // Try trailing AM/PM token (greedy: picks rightmost match)
    const ampmMatch = current.match(/^(.*)\s+(\d{1,2}(?::\d{1,2})?\s*[ap]m)$/i);
    if (ampmMatch) {
      const candidate = ampmMatch[1].trim();
      if (parseAmPmToken(ampmMatch[2]) !== null && hasValidName(candidate)) {
        current = candidate;
        continue;
      }
    }
    // Try trailing strict 24h token H:MM (2-digit minutes required)
    const h24Match = current.match(/^(.*)\s+(\d{1,2}:\d{2})$/);
    if (h24Match) {
      const candidate = h24Match[1].trim();
      if (parse24hToken(h24Match[2]) !== null && hasValidName(candidate)) {
        current = candidate;
        continue;
      }
    }
    // Try trailing 4-digit military token HHMM
    const milMatch = current.match(/^(.*)\s+(\d{4})$/);
    if (milMatch) {
      const candidate = milMatch[1].trim();
      if (parseMilToken(milMatch[2]) !== null && hasValidName(candidate)) {
        current = candidate;
        continue;
      }
    }
    // No strippable token at end — stop early
    break;
  }
  return current;
}

/**
 * Validate and normalize a raw time string entered in the edit/add modal.
 * Returns:
 *   ""    — input was empty (no time label)
 *   "H:MM" or "H:MM-H:MM" — normalized canonical 24h label
 *   null  — input was non-empty but invalid (caller should show an error)
 *
 * Accepted forms:
 *   "H:MM"          strict 24h single  (H 0–23, MM 00–59, exactly 2 min digits)
 *   "H:MM-H:MM"     strict 24h range   (spaces around "-" are tolerated)
 *   "H:MM - H:MM"   same range with spaces
 *   "HHMM"          4-digit military   "1500"=>"15:00", "0730"=>"7:30"
 *
 * Rejected: "8:5", "8:60", "26:00", "24:00", "abc", "8:60-9:00", ...
 */
function normalizeEditTimeLabel(raw: string): string | null {
  // Normalize Unicode en/em dashes to ASCII hyphen before validation
  const s = raw.trim().replace(/[\u2013\u2014]/g, "-");
  if (!s) return "";

  // 4-digit military shorthand: "HHMM"
  const mil = s.match(/^(\d{2})(\d{2})$/);
  if (mil) {
    const h = parseInt(mil[1], 10);
    const min = parseInt(mil[2], 10);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return `${h}:${String(min).padStart(2, "0")}`;
    }
    return null;
  }

  // Range: "H:MM - H:MM" or "H:MM-H:MM"
  const rng = s.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (rng) {
    const start = parse24hToken(rng[1]);
    const end = parse24hToken(rng[2]);
    if (start && end) return `${start}-${end}`;
    return null;
  }

  // Single H:MM
  const single = parse24hToken(s);
  if (single !== null) return single;

  // Everything else is invalid
  return null;
}

/**
 * Parse a single import line into { timeLabel, name } or null (ignored).
 *
 * Priority order:
 *   Leading (time at start, locks in; invalid single falls through):
 *    1. Leading AM/PM range    (both sides explicit am/pm — atomic, no fall-through)
 *    2. Leading AM/PM single   (invalid token => fall through)
 *    3. Leading AM/PM time-only => null
 *    4. Leading military range  (HHMM-HHMM — atomic, no fall-through)
 *    5. Leading military single (invalid token => fall through)
 *    6. Leading military time-only => null
 *    7. Leading 24h range      (permissive detection — atomic, no fall-through)
 *    8. Leading 24h single     (invalid token => fall through)
 *    9. Leading 24h time-only  => null
 *   Trailing (only reached if no leading time found):
 *   10. Trailing AM/PM range
 *   11. Trailing 24h range
 *   12. Trailing military range
 *   13. Trailing AM/PM single
 *   14. Trailing 24h single
 *   15. Trailing military single
 *   16. Name-only (timeLabel = "")
 *
 * After any successful leading-time parse, stripTrailingTimeTokens(rest, 2)
 * is applied to the remainder so duplicate trailing tokens are cleaned.
 * After any successful trailing-time parse, stripTrailingTimeTokens(namePart, 2)
 * is applied so tokens left of the matched time are also cleaned.
 *
 * "time-only" lines (valid time, no name) are returned as null (ignored).
 * Punctuation-only lines are returned as null.
 */
function parseLine(rawLine: string): { timeLabel: string; name: string } | null {
  const line = rawLine.trim();
  if (!line || !hasValidName(line)) return null;

  // ---- LEADING AM/PM RANGE: AMPM-AMPM [name] ----
  // Atomic: both sides must have valid am/pm; if either fails => name-only.
  let m = line.match(
    /^(\d{1,2}(?::\d{1,2})?\s*[ap]m)\s*-\s*(\d{1,2}(?::\d{1,2})?\s*[ap]m)\s*(.*)/i
  );
  if (m) {
    const start = parseAmPmToken(m[1]);
    const end = parseAmPmToken(m[2]);
    const rest = m[3].trim();
    if (start && end) {
      if (!rest || !hasValidName(rest)) return null;
      return { timeLabel: `${start}-${end}`, name: stripTrailingTimeTokens(rest) };
    }
    return { timeLabel: "", name: line };
  }

  // ---- LEADING AM/PM SINGLE: AMPM <space> name ----
  // Invalid token => name-only (am/pm context is unambiguous, no fall-through).
  m = line.match(/^(\d{1,2}(?::\d{1,2})?\s*[ap]m)\s+(.*)/i);
  if (m) {
    const time = parseAmPmToken(m[1]);
    const rest = m[2].trim();
    if (time) {
      if (!rest || !hasValidName(rest)) return null;
      return { timeLabel: time, name: stripTrailingTimeTokens(rest) };
    }
    return { timeLabel: "", name: line };
  }

  // ---- LEADING AM/PM TIME-ONLY ----
  m = line.match(/^(\d{1,2}(?::\d{1,2})?\s*[ap]m)$/i);
  if (m && parseAmPmToken(m[1])) return null;

  // ---- LEADING MILITARY RANGE: HHMM-HHMM [name] ----
  // Atomic: both sides must be valid military times; if either fails => name-only.
  m = line.match(/^(\d{4})\s*-\s*(\d{4})\s*(.*)/);
  if (m) {
    const start = parseMilToken(m[1]);
    const end = parseMilToken(m[2]);
    const rest = m[3].trim();
    if (start && end) {
      if (!rest || !hasValidName(rest)) return null;
      return { timeLabel: `${start}-${end}`, name: stripTrailingTimeTokens(rest) };
    }
    return { timeLabel: "", name: line };
  }

  // ---- LEADING MILITARY SINGLE: HHMM <space> name ----
  // Invalid token (e.g. "9999") => fall through to trailing patterns.
  m = line.match(/^(\d{4})\s+(.*)/);
  if (m) {
    const time = parseMilToken(m[1]);
    const rest = m[2].trim();
    if (time) {
      if (!rest || !hasValidName(rest)) return null;
      return { timeLabel: time, name: stripTrailingTimeTokens(rest) };
    }
    // Invalid military token — fall through to trailing patterns
  }

  // ---- LEADING MILITARY TIME-ONLY ----
  m = line.match(/^(\d{4})$/);
  if (m && parseMilToken(m[1])) return null;

  // ---- LEADING 24H RANGE (permissive detection for atomicity) ----
  // Uses \d{1,2}:\d{1,2} to catch malformed ends (e.g. "8:5"); validates
  // strictly with parse24hToken. Atomic: if either side invalid => name-only.
  m = line.match(/^(\d{1,2}:\d{1,2})\s*-\s*(\d{1,2}:\d{1,2})\s*(.*)/);
  if (m) {
    const start = parse24hToken(m[1]);
    const end = parse24hToken(m[2]);
    const rest = m[3].trim();
    if (start && end) {
      if (!rest || !hasValidName(rest)) return null;
      return { timeLabel: `${start}-${end}`, name: stripTrailingTimeTokens(rest) };
    }
    return { timeLabel: "", name: line };
  }

  // ---- LEADING 24H SINGLE: H:MM <space> name ----
  // Invalid token (e.g. "26:00") => fall through to trailing patterns so a
  // valid trailing time on the same line (e.g. "22:00") can still be salvaged.
  m = line.match(/^(\d{1,2}:\d{2})\s+(.*)/);
  if (m) {
    const time = parse24hToken(m[1]);
    const rest = m[2].trim();
    if (time) {
      if (!rest || !hasValidName(rest)) return null;
      return { timeLabel: time, name: stripTrailingTimeTokens(rest) };
    }
    // Invalid 24h token — fall through to trailing patterns
  }

  // ---- LEADING 24H TIME-ONLY ----
  m = line.match(/^(\d{1,2}:\d{2})$/);
  if (m && parse24hToken(m[1])) return null;

  // ---- TRAILING PATTERNS ----
  // Only reached when no valid leading time was found.
  // Each success path applies stripTrailingTimeTokens(namePart, 2) so any
  // extra time tokens left of the matched trailing token are also cleaned.

  // Trailing AM/PM range: name <space> AMPM-AMPM
  m = line.match(
    /^(.*)\s+(\d{1,2}(?::\d{1,2})?\s*[ap]m)\s*-\s*(\d{1,2}(?::\d{1,2})?\s*[ap]m)$/i
  );
  if (m) {
    const namePart = m[1].trim();
    const start = parseAmPmToken(m[2]);
    const end = parseAmPmToken(m[3]);
    if (start && end && hasValidName(namePart)) {
      return { timeLabel: `${start}-${end}`, name: stripTrailingTimeTokens(namePart) };
    }
    if (!hasValidName(namePart)) return null;
    return { timeLabel: "", name: line };
  }

  // Trailing 24h range: name <space> H:MM-H:MM
  m = line.match(/^(.*)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (m) {
    const namePart = m[1].trim();
    const start = parse24hToken(m[2]);
    const end = parse24hToken(m[3]);
    if (start && end && hasValidName(namePart)) {
      return { timeLabel: `${start}-${end}`, name: stripTrailingTimeTokens(namePart) };
    }
    if (!hasValidName(namePart)) return null;
    return { timeLabel: "", name: line };
  }

  // Trailing military range: name <space> HHMM-HHMM
  m = line.match(/^(.*)\s+(\d{4})\s*-\s*(\d{4})$/);
  if (m) {
    const namePart = m[1].trim();
    const start = parseMilToken(m[2]);
    const end = parseMilToken(m[3]);
    if (start && end && hasValidName(namePart)) {
      return { timeLabel: `${start}-${end}`, name: stripTrailingTimeTokens(namePart) };
    }
    if (!hasValidName(namePart)) return null;
    return { timeLabel: "", name: line };
  }

  // Trailing AM/PM single: name <space> AMPM
  m = line.match(/^(.*)\s+(\d{1,2}(?::\d{1,2})?\s*[ap]m)$/i);
  if (m) {
    const namePart = m[1].trim();
    const time = parseAmPmToken(m[2]);
    if (time && hasValidName(namePart)) {
      return { timeLabel: time, name: stripTrailingTimeTokens(namePart) };
    }
    if (!hasValidName(namePart)) return null;
    return { timeLabel: "", name: line };
  }

  // Trailing 24h single: name <space> H:MM
  m = line.match(/^(.*)\s+(\d{1,2}:\d{2})$/);
  if (m) {
    const namePart = m[1].trim();
    const time = parse24hToken(m[2]);
    if (time && hasValidName(namePart)) {
      return { timeLabel: time, name: stripTrailingTimeTokens(namePart) };
    }
    if (!hasValidName(namePart)) return null;
    return { timeLabel: "", name: line };
  }

  // Trailing military single: name <space> HHMM
  m = line.match(/^(.*)\s+(\d{4})$/);
  if (m) {
    const namePart = m[1].trim();
    const time = parseMilToken(m[2]);
    if (time && hasValidName(namePart)) {
      return { timeLabel: time, name: stripTrailingTimeTokens(namePart) };
    }
    if (!hasValidName(namePart)) return null;
    return { timeLabel: "", name: line };
  }

  // ---- NAME-ONLY: no time found ----
  return { timeLabel: "", name: line };
}

// ===== 12-HOUR DISPLAY FORMATTER =====

/** Format a single internal "H:MM" value to "h:MM AM/PM". */
function formatSingleTime(t: string): string {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t; // fallback: return as-is
  let h = parseInt(m[1], 10);
  const min = m[2];
  const meridiem = h < 12 ? "AM" : "PM";
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${min} ${meridiem}`;
}

/**
 * Format an internal timeLabel ("H:MM" or "H:MM-H:MM") to display format.
 * Non-standard labels (free-text from the edit form) are returned as-is.
 */
function formatTimeLabel(timeLabel: string): string {
  if (!timeLabel) return "";
  // Range: contains exactly one dash between two time-like tokens
  const rangeMatch = timeLabel.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (rangeMatch) {
    return `${formatSingleTime(rangeMatch[1])}\u2013${formatSingleTime(rangeMatch[2])}`;
  }
  // Single time
  if (/^\d{1,2}:\d{2}$/.test(timeLabel)) {
    return formatSingleTime(timeLabel);
  }
  // Free-text label from manual entry: display as-is
  return timeLabel;
}

// ===== NAME POLISH HELPERS =====

/**
 * Strip a trailing "(en dash)" debug marker from an activity name, then trim.
 * "Snack / Rest (en dash)" → "Snack / Rest"
 * "Lunch (Plaza Inn)"      → unchanged
 * "Blah (en dash) extra"   → unchanged (not at end)
 */
function stripEnDashSuffix(name: string): string {
  return name.replace(/\s*\(en dash\)$/, "").trim();
}

/**
 * Minimal CSV row splitter that handles double-quoted fields with embedded
 * commas and escaped quotes (""). Returns an array of trimmed cell strings.
 * Malformed input (e.g. unterminated quote) returns whatever was parsed so far.
 */
function parseCSVRow(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) {
      // trailing comma produced an empty last cell — push and stop
      if (cells.length > 0) cells.push("");
      break;
    }
    if (line[i] === '"') {
      // Quoted field
      i++; // skip opening quote
      let cell = "";
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            cell += '"'; // escaped quote
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          cell += line[i++];
        }
      }
      cells.push(cell.trim());
      if (line[i] === ",") i++; // skip comma after quoted field
    } else {
      // Unquoted field
      const end = line.indexOf(",", i);
      if (end === -1) {
        cells.push(line.slice(i).trim());
        break;
      } else {
        cells.push(line.slice(i, end).trim());
        i = end + 1;
      }
    }
  }
  return cells;
}

// ===== LOCALSTORAGE PERSISTENCE =====

const STORAGE_KEY = "dwp.myPlans";
const SCHEMA_VERSION = 1;

function loadFromStorage(): PlanItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // v1 shape: { version: 1, items: [...] }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof parsed.version === "number" &&
      Array.isArray(parsed.items)
    ) {
      if (parsed.version === 1) {
        return parsed.items as PlanItem[];
      }
      // Unknown future version — start empty
      return [];
    }
    // v0 shape: raw array (unversioned legacy)
    if (Array.isArray(parsed)) {
      const migrated = { version: SCHEMA_VERSION, items: parsed };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      } catch {
        // best-effort migration write — ignore quota errors
      }
      return parsed as PlanItem[];
    }
    // Corrupt or unrecognised — start empty
    return [];
  } catch {
    return [];
  }
}

function saveToStorage(items: PlanItem[]): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, items })
    );
  } catch {
    // Quota or security errors must not crash the app
  }
}

// ===== AUTO-SORT =====

const SORT_KEY = "dwp.autoSort";

function loadSortPref(): boolean {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (!raw) return false;
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

/**
 * Extract the sort key (minutes from midnight) for a timeLabel.
 * Ranges use the start time. Untimed / free-text items sink to the bottom.
 */
function sortKey(timeLabel: string): number {
  if (!timeLabel) return Infinity;
  // Range "H:MM-H:MM" → sort by start
  const rangeMatch = timeLabel.match(/^(\d{1,2}:\d{2})-\d{1,2}:\d{2}$/);
  const token = rangeMatch ? rangeMatch[1] : timeLabel;
  const m = token.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return Infinity;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** Return a new array sorted earliest → latest. Stable for equal start times. */
function sortPlanItems(items: PlanItem[]): PlanItem[] {
  return items.slice().sort((a, b) => sortKey(a.timeLabel) - sortKey(b.timeLabel));
}

// ===== WAIT OVERLAY HELPERS =====

/** Resort scope for the wait overlay (DLR = Disneyland Resort). */
const RESORT_SCOPE = "DLR";
const DLR_PARK_IDS = new Set(["disneyland", "dca"]);

/**
 * Normalize an attraction or plan item name to a stable lookup key.
 * - Lowercase + trim
 * - Remove apostrophes (typographic and ASCII) so "Tiana's" → "tianas"
 * - Replace all remaining non-alphanumeric characters with a space
 * - Collapse duplicate spaces
 */
function normalizeKey(str: string): string {
  return str
    .trim()
    .toLowerCase()
    .replace(/['\u2019\u2018]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set(["the", "of", "and", "a", "an", "to", "at"]);

/** Tokens from a normalized key with stop words removed. */
function tokenize(key: string): string[] {
  return key.split(" ").filter((t) => t && !STOP_WORDS.has(t));
}

/**
 * Stage 2 containment check.
 * True when planTokens appear as a whole-word sequence inside the
 * stop-word-filtered version of attrKey (prefix or interior match).
 * Caller must ensure planTokens.length >= 2.
 */
function containsWholeWordSequence(
  attrKey: string,
  planTokens: string[],
): boolean {
  const planStr = planTokens.join(" ");
  const attrFiltered = attrKey
    .split(" ")
    .filter((t) => t && !STOP_WORDS.has(t))
    .join(" ");
  return (" " + attrFiltered + " ").includes(" " + planStr + " ");
}

/**
 * Manual alias map for DLR — acronyms and common shorthands.
 * Keys: normalized alias string. Values: normalized full attraction name.
 * These map exactly to the normalizeKey() output of the mock data names.
 */
const ALIASES_DLR: Record<string, string> = {
  // Acronyms
  rotr:  "star wars rise of the resistance",
  mmrr:  "mickey minnies runaway railway",
  btmrr: "big thunder mountain railroad",
  btmr:  "big thunder mountain railroad",
  potc:  "pirates of the caribbean",
  iasw:  "its a small world",
  mfsr:  "millennium falcon smugglers run",
  hm:    "haunted mansion",
  jc:    "jungle cruise",
  sm:    "space mountain",
  gotg:  "guardians of the galaxy mission breakout",
  tsmm:  "toy story midway mania",
  rac:   "radiator springs racers",
  web:   "web slingers a spider man adventure",
  grr:   "grizzly river run",
  // Common shorthands
  "pirates":          "pirates of the caribbean",
  "guardians":        "guardians of the galaxy mission breakout",
  "big thunder":      "big thunder mountain railroad",
  "thunder mountain": "big thunder mountain railroad",
  "runaway railway":  "mickey minnies runaway railway",
  // Guardians variants (dash/colon/annotation forms normalize to these keys)
  "guardians mission breakout": "guardians of the galaxy mission breakout",
  "guardians breakout":         "guardians of the galaxy mission breakout",
  // Rise of the Resistance shorthands
  "rise":             "star wars rise of the resistance",
  // Smugglers Run shorthands
  "smuggler":         "millennium falcon smugglers run",
  "smugglers":        "millennium falcon smugglers run",
  "smugglers run":    "millennium falcon smugglers run",
};

// Placeholder for future WDW scope expansion
const ALIASES_WDW: Record<string, string> = {};
void ALIASES_WDW; // reserved, unused until WDW data is added

/**
 * When true, a matched plan item displays the official attraction name
 * (from the wait dataset) as a secondary line below the plan title.
 * Stored plan data is never mutated or persisted.
 */
const DISPLAY_CANONICAL_RIDE_NAME = true;

/**
 * Strip parenthetical and bracket annotations before matching.
 * Applied only to the plan item key — never to displayed content.
 * "Haunted Mansion (flex window)"  → "Haunted Mansion"
 * "[rope drop] Space Mountain"     → "Space Mountain"
 */
function stripAnnotations(str: string): string {
  return str
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Badge colors matching the Wait Times page exactly.
 * DOWN → amber | CLOSED/null → grey
 * ≤20 min → green | ≤45 min → yellow | >45 min → red
 */
function getWaitBadgeStyle(
  status: string,
  waitMins: number | null,
): { backgroundColor: string; color: string } {
  if (status === "DOWN")   return { backgroundColor: "#fef3c7", color: "#92400e" };
  if (status === "CLOSED") return { backgroundColor: "#f3f4f6", color: "#6b7280" };
  if (waitMins == null)    return { backgroundColor: "#f3f4f6", color: "#6b7280" };
  if (waitMins <= 20) return { backgroundColor: "#dcfce7", color: "#166534" };
  if (waitMins <= 45) return { backgroundColor: "#fef9c3", color: "#854d0e" };
  return { backgroundColor: "#fee2e2", color: "#991b1b" };
}

/**
 * 3-stage deterministic wait lookup for a plan item name.
 * Order: Stage 1 (exact) → Stage 3 (alias) → Stage 2 (containment).
 * Parenthetical/bracket annotations are stripped before matching.
 * Returns null on no match or ambiguous containment.
 */
function lookupWait(
  planName: string,
  waitMap: Map<string, { status: string; waitMins: number | null; canonicalName: string }>,
  aliases: Record<string, string>,
): { status: string; waitMins: number | null; canonicalName: string } | null {
  // Strip annotations (flex windows, labels, etc.) before normalizing
  const planKey = normalizeKey(stripAnnotations(planName));

  // Stage 1: exact normalized match
  const exact = waitMap.get(planKey);
  if (exact) return exact;

  // Stage 3: manual alias lookup
  const aliasTarget = aliases[planKey];
  if (aliasTarget) {
    const aliasResult = waitMap.get(aliasTarget);
    if (aliasResult) return aliasResult;
  }

  // Stage 2: whole-word containment (≥2 meaningful tokens required)
  const planTokens = tokenize(planKey);
  if (planTokens.length < 2) return null;

  const matches: Array<{ status: string; waitMins: number | null; canonicalName: string }> = [];
  for (const [attrKey, info] of waitMap) {
    if (containsWholeWordSequence(attrKey, planTokens)) {
      matches.push(info);
    }
  }

  // Ambiguous → fail silently
  if (matches.length !== 1) return null;
  return matches[0];
}

// ===== COMPONENT =====

export default function PlansPage() {
  const [items, setItems] = useState<PlanItem[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [autoSortEnabled, setAutoSortEnabled] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [mode, setMode] = useState<Mode>("view");
  const [editTarget, setEditTarget] = useState<PlanItem | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formTime, setFormTime] = useState("");
  const [formError, setFormError] = useState("");
  const [formTimeError, setFormTimeError] = useState("");
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");

  // Build a deterministic wait lookup map scoped to RESORT_SCOPE (DLR).
  // Keyed by normalizeKey(name); values carry status + waitMins.
  // Memoized because mock data is static — never recomputes after mount.
  const waitMap = useMemo(() => {
    const map = new Map<string, { status: string; waitMins: number | null; canonicalName: string }>();
    for (const a of mockAttractionWaits) {
      if (!DLR_PARK_IDS.has(a.parkId)) continue; // resort scope guard
      map.set(normalizeKey(a.name), {
        status: a.status,
        waitMins: a.waitMins,
        canonicalName: a.name,
      });
    }
    return map;
  }, []);

  // Load saved plan and preferences from localStorage once on mount (client-side only)
  useEffect(() => {
    setItems(loadFromStorage());
    setAutoSortEnabled(loadSortPref());
    setInitialized(true);
  }, []);

  // Persist plan to localStorage on every mutation (after initial load)
  useEffect(() => {
    if (!initialized) return;
    saveToStorage(items);
  }, [items, initialized]);

  function openAdd() {
    setFormName("");
    setFormTime("");
    setFormError("");
    setFormTimeError("");
    setEditTarget(null);
    setMode("add");
  }

  function openEdit(item: PlanItem) {
    setFormName(item.name);
    setFormTime(item.timeLabel);
    setFormError("");
    setFormTimeError("");
    setEditTarget(item);
    setMode("edit");
  }

  function openImport() {
    setImportText("");
    setImportError("");
    setMode("import");
  }

  function closeModal() {
    setMode("view");
    setEditTarget(null);
    setFormError("");
    setFormTimeError("");
    setImportError("");
  }

  function handleSave() {
    let trimmed = formName.trim();
    if (!trimmed) {
      setFormError("Activity name is required.");
      return;
    }

    // Validate and normalize the time window field.
    // normalizeEditTimeLabel returns:
    //   ""    → no time (field was empty or cleared)
    //   "H:MM" / "H:MM-H:MM" → canonical 24h label
    //   null  → invalid input
    const rawTime = formTime.trim();
    let timeWindow = "";
    if (rawTime) {
      const normalized = normalizeEditTimeLabel(rawTime);
      if (normalized === null) {
        setFormTimeError("Enter a valid 24h time (e.g. 15:00 or 15:00-16:00).");
        return;
      }
      timeWindow = normalized;
    }

    // When saving with a time window, strip up to 2 trailing time tokens from
    // the name so accidental leftovers (e.g. "Space Mountain 10pm 22:00") are
    // cleaned. Guard: do not strip if it would empty the name.
    if (timeWindow) {
      const stripped = stripTrailingTimeTokens(trimmed, 2);
      if (stripped) trimmed = stripped;
    }

    // Strip trailing "(en dash)" debug marker if present, then re-validate.
    trimmed = stripEnDashSuffix(trimmed);
    if (!trimmed) {
      setFormError("Activity name is required.");
      return;
    }

    if (mode === "add") {
      setItems((prev) => {
        const next = [...prev, { id: makeId(), name: trimmed, timeLabel: timeWindow }];
        return autoSortEnabled ? sortPlanItems(next) : next;
      });
    } else if (mode === "edit" && editTarget) {
      setItems((prev) => {
        const next = prev.map((it) =>
          it.id === editTarget.id
            ? { ...it, name: trimmed, timeLabel: timeWindow }
            : it
        );
        return autoSortEnabled ? sortPlanItems(next) : next;
      });
    }
    closeModal();
  }

  // Shared pipeline for both paste and file import.
  // Normalizes Unicode dashes per-line before calling parseLine.
  function processImportText(text: string) {
    const lines = text.split("\n");
    const newItems: PlanItem[] = [];
    for (const line of lines) {
      const normalized = line.replace(/[\u2013\u2014]/g, "-");
      const parsed = parseLine(normalized);
      if (parsed) {
        newItems.push({
          id: makeId(),
          name: stripEnDashSuffix(parsed.name),
          timeLabel: parsed.timeLabel,
        });
      }
    }
    if (newItems.length === 0) {
      setImportError("No valid activities found. Check your text and try again.");
      return;
    }
    setItems((prev) => {
      const next = [...prev, ...newItems];
      return autoSortEnabled ? sortPlanItems(next) : next;
    });
    setImportText("");
    setMode("view");
  }

  function handleImport() {
    processImportText(importText);
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = (ev.target?.result as string) ?? "";
      processImportText(text);
    };
    reader.readAsText(file);
    // Reset so selecting the same file again triggers onChange
    e.target.value = "";
  }

  // Convert CSV rows into TXT-like lines and feed into the shared import pipeline.
  // Format A (2+ cols): "<timeLabel> <name>" constructed from first two cells.
  // Format B (1 col):   treat the single cell as a plain TXT line.
  function processCSVText(text: string) {
    const rows = text.split("\n");
    const txtLines: string[] = [];
    for (const row of rows) {
      const trimmedRow = row.trim();
      if (!trimmedRow) continue;
      try {
        const cells = parseCSVRow(trimmedRow);
        if (cells.length === 0) continue;
        // Skip exact CSV header rows (case-insensitive, trimmed comparison)
        const c0 = cells[0].toLowerCase();
        const c1 = cells.length >= 2 ? cells[1].toLowerCase() : "";
        if (cells.length >= 2 && c0 === "timelabel" && c1 === "name") continue;
        if (cells.length === 1 && c0 === "line") continue;
        if (cells.length >= 2 && cells[1]) {
          // Two-column: time + name → assemble TXT-style line
          const timeCell = cells[0];
          const nameCell = cells[1];
          txtLines.push(timeCell ? `${timeCell} ${nameCell}` : nameCell);
        } else if (cells[0]) {
          // Single column: treat as plain TXT line
          txtLines.push(cells[0]);
        }
      } catch {
        // Skip malformed rows without crashing
      }
    }
    // Delegate to existing pipeline (handles empty-result error, sort, persist)
    processImportText(txtLines.join("\n"));
  }

  function handleCSVFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = (ev.target?.result as string) ?? "";
      processCSVText(text);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function handleDelete(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
    setDeleteConfirmId(null);
  }

  function moveUp(index: number) {
    if (index === 0) return;
    setItems((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }

  function moveDown(index: number) {
    if (index === items.length - 1) return;
    setItems((prev) => {
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }

  function handleClearAll() {
    setItems([]);
    setDeleteConfirmId(null);
    setClearConfirm(false);
  }

  function handleToggleSort(checked: boolean) {
    setAutoSortEnabled(checked);
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(checked));
    } catch {
      // quota / security errors must not crash the app
    }
    // If enabling, re-sort the current list immediately
    if (checked) {
      setItems((prev) => sortPlanItems(prev));
    }
  }

  return (
    <>
      <style>{`
        .plans-container {
          max-width: 480px;
          margin: 0 auto;
          padding: 0 0 4rem 0;
        }
        .plans-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 1.5rem;
        }
        .plans-title {
          font-size: 1.75rem;
          font-weight: 700;
          color: #1a1a2e;
        }
        .plans-header-actions {
          display: flex;
          gap: 0.5rem;
        }
        .btn-add {
          background-color: #2563eb;
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 1rem;
          font-weight: 600;
          padding: 0.6rem 1.25rem;
          cursor: pointer;
          min-height: 44px;
          min-width: 44px;
          white-space: nowrap;
        }
        .btn-add:active {
          background-color: #1d4ed8;
        }
        .btn-import {
          background-color: #fff;
          color: #2563eb;
          border: 1px solid #2563eb;
          border-radius: 8px;
          font-size: 1rem;
          font-weight: 600;
          padding: 0.6rem 1.25rem;
          cursor: pointer;
          min-height: 44px;
          min-width: 44px;
          white-space: nowrap;
        }
        .btn-import:active {
          background-color: #eff6ff;
        }
        .btn-clear {
          background-color: #fff;
          color: #dc2626;
          border: 1px solid #fca5a5;
          border-radius: 8px;
          font-size: 1rem;
          font-weight: 600;
          padding: 0.6rem 1.25rem;
          cursor: pointer;
          min-height: 44px;
          min-width: 44px;
          white-space: nowrap;
        }
        .btn-clear:active {
          background-color: #fef2f2;
        }
        .btn-clear:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        .clear-confirm-row {
          margin-bottom: 1rem;
        }
        .sort-toggle-row {
          display: flex;
          align-items: center;
          margin-bottom: 1rem;
        }
        .sort-toggle-label {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.875rem;
          color: #374151;
          cursor: pointer;
          min-height: 44px;
          user-select: none;
        }
        .sort-toggle-label input[type="checkbox"] {
          width: 18px;
          height: 18px;
          cursor: pointer;
          accent-color: #2563eb;
          flex-shrink: 0;
        }
        .empty-state {
          text-align: center;
          padding: 3rem 1rem;
          color: #6b7280;
        }
        .empty-icon {
          font-size: 3rem;
          margin-bottom: 0.75rem;
        }
        .empty-text {
          font-size: 1.1rem;
          margin-bottom: 0.5rem;
        }
        .empty-hint {
          font-size: 0.9rem;
          color: #9ca3af;
        }
        .timeline {
          list-style: none;
          position: relative;
        }
        .timeline::before {
          content: "";
          position: absolute;
          left: 20px;
          top: 0;
          bottom: 0;
          width: 2px;
          background-color: #e5e7eb;
          z-index: 0;
        }
        .timeline-item {
          position: relative;
          display: flex;
          flex-direction: column;
          padding-left: 52px;
          margin-bottom: 0.75rem;
          z-index: 1;
        }
        .step-circle {
          position: absolute;
          left: 0;
          top: 14px;
          width: 42px;
          height: 42px;
          border-radius: 50%;
          background-color: #2563eb;
          color: #fff;
          font-size: 0.875rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 2;
          flex-shrink: 0;
        }
        .item-card {
          background: #fff;
          border-radius: 10px;
          padding: 0.75rem 1rem;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
          border: 1px solid #e5e7eb;
          min-height: 72px;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }
        .item-top {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 0.5rem;
        }
        .item-name {
          font-size: 1rem;
          font-weight: 600;
          color: #111827;
          flex: 1;
          word-break: break-word;
        }
        .item-time {
          font-size: 0.8rem;
          color: #6b7280;
          margin-top: 0.1rem;
        }
        .item-actions {
          display: flex;
          gap: 0.25rem;
          flex-shrink: 0;
          margin-top: -0.1rem;
        }
        .icon-btn {
          background: none;
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          min-width: 36px;
          min-height: 36px;
          font-size: 1rem;
          color: #6b7280;
          padding: 0;
          transition: background-color 0.15s;
        }
        .icon-btn:active {
          background-color: #f3f4f6;
        }
        .icon-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        .icon-btn.danger {
          color: #dc2626;
          border-color: #fca5a5;
        }
        .reorder-group {
          display: flex;
          gap: 0.25rem;
          margin-top: 0.5rem;
          border-top: 1px solid #f3f4f6;
          padding-top: 0.5rem;
        }
        .confirm-row {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-top: 0.5rem;
          padding: 0.5rem 0.75rem;
          background-color: #fef2f2;
          border-radius: 6px;
          border: 1px solid #fca5a5;
        }
        .confirm-text {
          font-size: 0.85rem;
          color: #dc2626;
          flex: 1;
        }
        .btn-confirm-delete {
          background-color: #dc2626;
          color: #fff;
          border: none;
          border-radius: 6px;
          font-size: 0.8rem;
          font-weight: 600;
          padding: 0.4rem 0.75rem;
          cursor: pointer;
          min-height: 36px;
          white-space: nowrap;
        }
        .btn-confirm-delete:active {
          background-color: #b91c1c;
        }
        .btn-cancel-delete {
          background: none;
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          font-size: 0.8rem;
          padding: 0.4rem 0.75rem;
          cursor: pointer;
          min-height: 36px;
          color: #6b7280;
        }
        .backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.45);
          z-index: 100;
          display: flex;
          align-items: flex-end;
          justify-content: center;
        }
        @media (min-width: 480px) {
          .backdrop {
            align-items: center;
          }
        }
        .modal {
          background: #fff;
          border-radius: 16px 16px 0 0;
          width: 100%;
          max-width: 480px;
          box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.15);
          /* Constrain to visible viewport so keyboard doesn't bury the sheet.
             dvh (dynamic viewport height) shrinks when the soft keyboard opens;
             vh fallback for browsers that don't support dvh yet. */
          max-height: 85vh;
          max-height: 85dvh;
          /* Flex column so title, scrollable body, and actions stack cleanly */
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        @media (min-width: 480px) {
          .modal {
            border-radius: 16px;
          }
        }
        .modal-title {
          font-size: 1.25rem;
          font-weight: 700;
          color: #1a1a2e;
          padding: 1.5rem 1.25rem 0;
          flex-shrink: 0;
          margin-bottom: 1.25rem;
        }
        /* Scrollable body — grows to fill available space between title and actions */
        .modal-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          padding: 0 1.25rem;
          /* scroll-padding keeps the focused input clear of the title bar */
          scroll-padding-top: 0.5rem;
        }
        .form-field {
          margin-bottom: 1rem;
        }
        .form-label {
          display: block;
          font-size: 0.875rem;
          font-weight: 600;
          color: #374151;
          margin-bottom: 0.4rem;
        }
        .form-input {
          width: 100%;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          padding: 0.7rem 0.875rem;
          font-size: 1rem;
          color: #111827;
          background: #fff;
          outline: none;
          min-height: 48px;
          font-family: inherit;
          box-sizing: border-box;
        }
        .form-input:focus {
          border-color: #2563eb;
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
        }
        .form-input.error {
          border-color: #dc2626;
        }
        .form-textarea {
          width: 100%;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          padding: 0.7rem 0.875rem;
          font-size: 0.9rem;
          color: #111827;
          background: #fff;
          outline: none;
          font-family: inherit;
          resize: vertical;
          min-height: 160px;
          box-sizing: border-box;
          line-height: 1.5;
        }
        .form-textarea:focus {
          border-color: #2563eb;
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
        }
        .form-error {
          font-size: 0.8rem;
          color: #dc2626;
          margin-top: 0.3rem;
        }
        .form-hint {
          font-size: 0.78rem;
          color: #9ca3af;
          margin-top: 0.25rem;
        }
        .modal-actions {
          display: flex;
          gap: 0.75rem;
          flex-shrink: 0;
          padding: 1rem 1.25rem;
          /* Keep safe distance from the home indicator on notched devices */
          padding-bottom: max(1rem, env(safe-area-inset-bottom));
          border-top: 1px solid #f3f4f6;
        }
        .btn-save {
          flex: 1;
          background-color: #2563eb;
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 1rem;
          font-weight: 600;
          padding: 0.75rem;
          cursor: pointer;
          min-height: 48px;
        }
        .btn-save:active {
          background-color: #1d4ed8;
        }
        .btn-cancel {
          flex: 1;
          background: none;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          font-size: 1rem;
          color: #374151;
          padding: 0.75rem;
          cursor: pointer;
          min-height: 48px;
        }
        .btn-cancel:active {
          background-color: #f3f4f6;
        }
        .file-input-hidden {
          display: none;
        }
        .btn-file-label {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          background-color: #fff;
          color: #374151;
          border: 1px solid #d1d5db;
          border-radius: 8px;
          font-size: 0.9rem;
          font-weight: 500;
          padding: 0.6rem 1rem;
          cursor: pointer;
          min-height: 44px;
          white-space: nowrap;
        }
        .btn-file-label:active {
          background-color: #f3f4f6;
        }
        .item-name-row {
          display: flex;
          align-items: baseline;
          flex-wrap: wrap;
          gap: 0.35rem;
        }
        /* Structural properties only — colors applied via inline style
           to stay in exact parity with the Wait Times page WaitBadge. */
        .wait-badge {
          display: inline-flex;
          align-items: center;
          font-size: 0.7rem;
          font-weight: 600;
          padding: 0.15rem 0.45rem;
          border-radius: 4px;
          white-space: nowrap;
          line-height: 1.4;
          flex-shrink: 0;
        }
        .wait-scope-label {
          font-size: 0.7rem;
          color: #9ca3af;
          margin: -0.4rem 0 0.75rem;
        }
      `}</style>

      <div className="plans-container">
        <div className="plans-header">
          <h1 className="plans-title">My Plans</h1>
          <div className="plans-header-actions">
            <button
              className="btn-clear"
              disabled={items.length === 0}
              onClick={() => setClearConfirm(true)}
            >
              Clear all
            </button>
            <button className="btn-import" onClick={openImport}>
              Import
            </button>
            <button className="btn-add" onClick={openAdd}>
              + Add
            </button>
          </div>
        </div>

        <div className="sort-toggle-row">
          <label className="sort-toggle-label">
            <input
              type="checkbox"
              checked={autoSortEnabled}
              onChange={(e) => handleToggleSort(e.target.checked)}
            />
            Auto-sort by time
          </label>
        </div>

        <p className="wait-scope-label">Wait overlay: {RESORT_SCOPE}</p>

        {clearConfirm && (
          <div className="clear-confirm-row">
            <div className="confirm-row">
              <span className="confirm-text">Clear all activities?</span>
              <button
                className="btn-cancel-delete"
                onClick={() => setClearConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="btn-confirm-delete"
                onClick={handleClearAll}
              >
                Yes, clear all
              </button>
            </div>
          </div>
        )}

        {items.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🗓</div>
            <p className="empty-text">No activities planned yet.</p>
            <p className="empty-hint">Tap &ldquo;+ Add&rdquo; to build your day.</p>
          </div>
        ) : (
          <ul className="timeline">
            {items.map((item, index) => (
              <li key={item.id} className="timeline-item">
                <div className="step-circle">{index + 1}</div>
                <div className="item-card">
                  <div className="item-top">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="item-name-row">
                        <span className="item-name">{item.name}</span>
                        {(() => {
                          const w = lookupWait(item.name, waitMap, ALIASES_DLR);
                          if (!w) return null;
                          const label =
                            w.status === "DOWN"   ? "Down"  :
                            w.status === "CLOSED" ? "Closed" :
                            w.waitMins != null    ? `${w.waitMins} min` : null;
                          if (!label) return null;
                          return (
                            <>
                              <span
                                className="wait-badge"
                                style={getWaitBadgeStyle(w.status, w.waitMins)}
                              >
                                {label}
                              </span>
                              {DISPLAY_CANONICAL_RIDE_NAME && w.canonicalName !== item.name && (
                                <span style={{
                                  display: "block",
                                  fontSize: "0.7rem",
                                  color: "#9ca3af",
                                  fontStyle: "italic",
                                  lineHeight: 1.3,
                                }}>
                                  {w.canonicalName}
                                </span>
                              )}
                            </>
                          );
                        })()}
                      </div>
                      {item.timeLabel && (
                        <div className="item-time">
                          {formatTimeLabel(item.timeLabel)}
                        </div>
                      )}
                    </div>
                    <div className="item-actions">
                      <button
                        className="icon-btn"
                        aria-label="Edit"
                        onClick={() => {
                          setDeleteConfirmId(null);
                          openEdit(item);
                        }}
                      >
                        ✏️
                      </button>
                      <button
                        className="icon-btn danger"
                        aria-label="Delete"
                        onClick={() =>
                          setDeleteConfirmId(
                            deleteConfirmId === item.id ? null : item.id
                          )
                        }
                      >
                        🗑
                      </button>
                    </div>
                  </div>

                  {deleteConfirmId === item.id && (
                    <div className="confirm-row">
                      <span className="confirm-text">Remove this activity?</span>
                      <button
                        className="btn-cancel-delete"
                        onClick={() => setDeleteConfirmId(null)}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn-confirm-delete"
                        onClick={() => handleDelete(item.id)}
                      >
                        Yes, delete
                      </button>
                    </div>
                  )}

                  <div className="reorder-group">
                    <button
                      className="icon-btn"
                      aria-label="Move up"
                      disabled={index === 0}
                      onClick={() => moveUp(index)}
                    >
                      ↑
                    </button>
                    <button
                      className="icon-btn"
                      aria-label="Move down"
                      disabled={index === items.length - 1}
                      onClick={() => moveDown(index)}
                    >
                      ↓
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {mode !== "view" && (
        <div className="backdrop" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">
              {mode === "add"
                ? "Add activity"
                : mode === "edit"
                ? "Edit activity"
                : "Import activities"}
            </h2>

            <div className="modal-body">
              {mode === "import" ? (
                <div className="form-field">
                  <label className="form-label" htmlFor="import-text">
                    Paste your schedule
                  </label>
                  <textarea
                    id="import-text"
                    className="form-textarea"
                    placeholder={
                      "One activity per line. Examples:\n" +
                      "Space Mountain 10am\n" +
                      "10:30 Haunted Mansion\n" +
                      "Fantasmic! 7:00pm-8:00pm\n" +
                      "10am-11am Morning Block"
                    }
                    value={importText}
                    onChange={(e) => {
                      setImportText(e.target.value);
                      if (importError) setImportError("");
                    }}
                    autoFocus
                  />
                  {importError && (
                    <p className="form-error">{importError}</p>
                  )}
                  <p className="form-hint" style={{ marginBottom: "0.75rem" }}>
                    Supports leading or trailing times in 24h (10:00) or AM/PM (10am, 10:00pm).
                    Ranges like 10am&ndash;11am or 10:00&ndash;11:00 are also supported.
                    En/em dashes are handled automatically.
                    Punctuation-only and time-only lines are skipped.
                  </p>
                  <p className="form-hint" style={{ marginBottom: "0.4rem" }}>
                    — or upload a file —
                  </p>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <label className="btn-file-label" htmlFor="file-import">
                      📂 .txt file
                      <input
                        id="file-import"
                        type="file"
                        accept=".txt"
                        className="file-input-hidden"
                        onChange={handleFile}
                      />
                    </label>
                    <label className="btn-file-label" htmlFor="csv-import">
                      📊 .csv file
                      <input
                        id="csv-import"
                        type="file"
                        accept=".csv,text/csv"
                        className="file-input-hidden"
                        onChange={handleCSVFile}
                      />
                    </label>
                  </div>
                </div>
              ) : (
                <>
                  <div className="form-field">
                    <label className="form-label" htmlFor="plan-name">
                      Activity name{" "}
                      <span style={{ color: "#dc2626" }}>*</span>
                    </label>
                    <input
                      id="plan-name"
                      className={`form-input${formError ? " error" : ""}`}
                      type="text"
                      placeholder="e.g. Space Mountain"
                      value={formName}
                      onChange={(e) => {
                        setFormName(e.target.value);
                        if (formError) setFormError("");
                      }}
                      autoFocus
                    />
                    {formError && <p className="form-error">{formError}</p>}
                  </div>

                  <div className="form-field">
                    <label className="form-label" htmlFor="plan-time">
                      Time window{" "}
                      <span style={{ color: "#9ca3af", fontWeight: 400 }}>
                        (optional)
                      </span>
                    </label>
                    <input
                      id="plan-time"
                      className={`form-input${formTimeError ? " error" : ""}`}
                      type="text"
                      placeholder="e.g. 15:00 or 15:00-16:00"
                      value={formTime}
                      onChange={(e) => {
                        setFormTime(e.target.value);
                        if (formTimeError) setFormTimeError("");
                      }}
                    />
                    {formTimeError ? (
                      <p className="form-error">{formTimeError}</p>
                    ) : (
                      <p className="form-hint">
                        24h format. Single time (15:00) or range (15:00-16:00). Also accepts 4-digit shorthand (1500).
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn-cancel" onClick={closeModal}>
                Cancel
              </button>
              <button
                className="btn-save"
                onClick={mode === "import" ? handleImport : handleSave}
              >
                {mode === "import" ? "Parse & Add" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Shared time parsing and normalization utilities.
 *
 * Used by: My Plans (Manual Add, Edit Modal, TXT Import, CSV Import)
 *          and Lightning Lane page.
 *
 * Internal canonical format: "H:MM"  (24h, no leading zero on hour)
 * Range format:               "H:MM-H:MM"
 * Display is always 12-hour via formatSingleTime / formatTimeLabel.
 */

// ---------------------------------------------------------------------------
// Low-level token parsers
// ---------------------------------------------------------------------------

/** Strip internal whitespace and lowercase for AM/PM token comparison. */
export function normalizeAmPmStr(str: string): string {
  return str.replace(/\s+/g, "").toLowerCase();
}

/**
 * Parse an AM/PM time token (e.g. "10am", "10 pm", "10:00am", "1:00 PM").
 * Returns internal 24h string "H:MM" or null if invalid.
 * Hours must be 1–12. Single-digit minutes => treated as 00 (strict).
 */
export function parseAmPmToken(raw: string): string | null {
  const s = normalizeAmPmStr(raw);
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?([ap]m)$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const rawMin = m[2];
  const meridiem = m[3];

  // AM/PM hours must be 1–12
  if (h < 1 || h > 12) return null;

  let min = 0;
  if (rawMin !== undefined) {
    // Single-digit minute is treated strictly as 00
    min = rawMin.length === 1 ? 0 : parseInt(rawMin, 10);
    if (min < 0 || min > 59) return null;
  }

  if (meridiem === "am") {
    if (h === 12) h = 0; // 12am => midnight
  } else {
    if (h !== 12) h += 12; // 1–11pm => +12; 12pm stays 12
  }
  return `${h}:${String(min).padStart(2, "0")}`;
}

/**
 * Parse a strict 24h time token "H:MM" or "HH:MM" (exactly 2 digit minutes).
 * Accepts hours 0–23, minutes 00–59.
 * Returns "H:MM" string (no leading zero on hour) or null if invalid.
 */
export function parse24hToken(str: string): string | null {
  const m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${h}:${m[2]}`;
}

/**
 * Parse a 4-digit military time token e.g. "1500" => "15:00", "0730" => "7:30",
 * "0000" => "0:00".
 * First two digits = hours (00–23), last two = minutes (00–59).
 * Returns canonical "H:MM" (no leading zero on hour) or null if invalid.
 * Rejects: 2460 (h=24), 0860 (min=60), 2400 (h=24), non-4-digit strings.
 */
export function parseMilToken(str: string): string | null {
  if (!/^\d{4}$/.test(str)) return null;
  const h = parseInt(str.slice(0, 2), 10);
  const min = parseInt(str.slice(2), 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${h}:${String(min).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Name validity
// ---------------------------------------------------------------------------

/** True if the string contains at least one alphanumeric character. */
export function hasValidName(s: string): boolean {
  return /[a-zA-Z0-9]/.test(s);
}

// ---------------------------------------------------------------------------
// Trailing-token stripping
// ---------------------------------------------------------------------------

/**
 * Strip trailing valid time tokens from the end of a name string, up to
 * `maxPasses` times. Recognised tokens per pass (tried in order):
 *   1. AM/PM  — e.g. "10am", "10 pm", "10:00pm"
 *   2. 24h    — strict "H:MM" with exactly 2 minute digits
 *   3. Military — exactly 4 digits "HHMM" (e.g. "1500", "0730")
 * Each pass keeps the stripped result only if the remainder still passes
 * hasValidName. Stops early when nothing strippable is at the end.
 *
 * Examples (maxPasses=2):
 *   "Space Mountain 22:00"        => "Space Mountain"
 *   "Space Mountain 10pm"         => "Space Mountain"
 *   "Space Mountain 10pm 22:00"   => "Space Mountain"   (2 passes)
 *   "Space Mountain 0730 1500"    => "Space Mountain"   (2 passes, military)
 *   "Space Mountain 22:00 blah"   => unchanged           (token not at end)
 */
export function stripTrailingTimeTokens(name: string, maxPasses = 2): string {
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

// ---------------------------------------------------------------------------
// Edit / Add modal normalizer
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a raw time string entered in the edit/add modal.
 * Normalizes en/em dashes to ASCII hyphen before processing.
 * Returns:
 *   ""    — input was empty (no time label)
 *   "H:MM" or "H:MM-H:MM" — normalized canonical 24h label
 *   null  — input was non-empty but invalid (caller should show an error)
 *
 * Accepted forms:
 *   "H:MM"          strict 24h single  (H 0–23, MM 00–59, exactly 2 min digits)
 *   "H:MM-H:MM"     strict 24h range   (spaces around "-" are tolerated)
 *   "H:MM - H:MM"   same range with spaces
 *   "HHMM"          4-digit military   "1500"=>"15:00", "0730"=>"7:30", "0000"=>"0:00"
 *   "Xpm" / "X:XXpm" / "X:XX PM"   AM/PM single  (via parseAmPmToken)
 *   "Xpm-Ypm"        AM/PM range   (via parseAmPmToken on each side)
 *
 * Rejected: "8:5", "8:60", "26:00", "24:00", "2400", "2460", "abc", "8:60-9:00"
 */
export function normalizeEditTimeLabel(raw: string): string | null {
  const s = raw.trim().replace(/[\u2013\u2014]/g, "-");
  if (!s) return "";

  // 4-digit military shorthand: "HHMM"
  const milResult = parseMilToken(s);
  if (milResult !== null) return milResult;
  // Explicitly reject 4-digit strings that failed parseMilToken (e.g. "2460", "2400")
  if (/^\d{4}$/.test(s)) return null;

  // AM/PM range: "Xpm-Yam" or "X:XXpm - Y:XXam" (en/em dashes already normalized)
  // Matches two am/pm tokens separated by a dash with optional surrounding spaces.
  const ampmRng = s.match(
    /^(\d{1,2}(?::\d{1,2})?\s*[ap]m)\s*-\s*(\d{1,2}(?::\d{1,2})?\s*[ap]m)$/i
  );
  if (ampmRng) {
    const start = parseAmPmToken(ampmRng[1]);
    const end = parseAmPmToken(ampmRng[2]);
    if (start && end) return `${start}-${end}`;
    return null;
  }

  // AM/PM single: "1pm", "10:15pm", "1:00 PM", etc.
  const ampmSingle = parseAmPmToken(s);
  if (ampmSingle !== null) return ampmSingle;

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

// ---------------------------------------------------------------------------
// TXT import line parser
// ---------------------------------------------------------------------------

/**
 * Parse a single import line into { timeLabel, name } or null (ignored).
 *
 * Caller must normalize Unicode dashes (–/—) to ASCII "-" before calling.
 * Mobile keyboard "-" is treated identically to en dash / em dash.
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
 * "time-only" lines (valid time, no name) are returned as null (ignored).
 * Punctuation-only lines are returned as null.
 */
export function parseLine(rawLine: string): { timeLabel: string; name: string } | null {
  const line = rawLine.trim();
  if (!line || !hasValidName(line)) return null;

  // ---- LEADING AM/PM RANGE: AMPM-AMPM [name] ----
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

// ---------------------------------------------------------------------------
// 12-hour display formatters
// ---------------------------------------------------------------------------

/** Format a single internal "H:MM" (24h) value to "h:MM AM/PM" for display. */
export function formatSingleTime(t: string): string {
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
export function formatTimeLabel(timeLabel: string): string {
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

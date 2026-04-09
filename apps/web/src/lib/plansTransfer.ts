// Phase 8.2 — Backup / Restore + Day Import / Export helpers
//
// Two completely separate systems with no shared payload structure or logic:
//   SYSTEM 1 — PLANNER BACKUP / RESTORE  (type: "planner-backup")
//   SYSTEM 2 — DAY PLAN EXPORT / IMPORT  (type: "day-plan-export")
//
// No side effects. No storage reads/writes. No React dependencies.

/** Maximum file size accepted for any import (1 MB). Shared with page.tsx UI guards. */
export const MAX_IMPORT_BYTES = 1_048_576;

// ===== SHARED PRIMITIVE TYPES =====

export type PlanItem = {
  id: string;
  name: string;
  timeLabel: string;
  dayId?: string; // optional — absent in day exports, present in backups
};

/** Day-export items intentionally omit dayId (per spec). */
export type DayExportItem = {
  id: string;
  name: string;
  timeLabel: string;
};

// ===== INTERNAL HELPERS =====

const VALID_DAY_ID_RE = /^day-([1-9]\d*)$/;

function isPlanItem(v: unknown): v is PlanItem {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).id === "string" &&
    typeof (v as Record<string, unknown>).name === "string" &&
    typeof (v as Record<string, unknown>).timeLabel === "string"
  );
}

function isDayExportItem(v: unknown): v is DayExportItem {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).id === "string" &&
    typeof (v as Record<string, unknown>).name === "string" &&
    typeof (v as Record<string, unknown>).timeLabel === "string"
  );
}

// ===== SYSTEM 1: PLANNER BACKUP / RESTORE =====
// Payload type: "planner-backup"
// Contains full planner state: days, plans, activeDayId, and optional dayMeta.

/**
 * Plan item as it appears in a backup — dayId is required (validated at parse time).
 * Narrower than PlanItem where dayId is optional.
 */
export type BackupPlanItem = PlanItem & { dayId: string };

export type PlannerBackupPayload = {
  version: 1;
  type: "planner-backup";
  exportedAt: string;
  data: {
    days: string[];
    plans: BackupPlanItem[];
    activeDayId: string;
    dayMeta?: Record<string, { label?: string; date?: string }>;
  };
};

/** Build the full planner backup payload from current in-memory state. */
export function buildPlannerBackupPayload(state: {
  days: string[];
  plans: PlanItem[];
  activeDayId: string;
  dayMeta?: Record<string, { label?: string; date?: string }>;
}): PlannerBackupPayload {
  return {
    version: 1,
    type: "planner-backup",
    exportedAt: new Date().toISOString(),
    data: {
      days: state.days,
      // Cast accepted: at export time all in-memory items have a valid dayId assigned.
      plans: state.plans as BackupPlanItem[],
      activeDayId: state.activeDayId,
      ...(state.dayMeta && Object.keys(state.dayMeta).length > 0
        ? { dayMeta: state.dayMeta }
        : {}),
    },
  };
}

/**
 * Validate a parsed JSON value against the planner-backup schema.
 * Returns the typed payload on success.
 * Throws a descriptive Error on any validation failure.
 */
export function validatePlannerBackupPayload(raw: unknown): PlannerBackupPayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid backup: expected a JSON object.");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.version !== 1) {
    throw new Error(
      `Invalid backup: unsupported version ${String(obj.version)}. Expected 1.`
    );
  }
  if (obj.type !== "planner-backup") {
    throw new Error(
      `Invalid backup: wrong type "${String(obj.type)}". Expected "planner-backup".`
    );
  }
  // exportedAt is required and must be a string
  if (typeof obj.exportedAt !== "string") {
    throw new Error("Invalid backup: exportedAt is required and must be a string.");
  }

  const data = obj.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Invalid backup: missing or malformed data field.");
  }
  const d = data as Record<string, unknown>;

  // Validate days array — must be non-empty with canonical IDs.
  if (!Array.isArray(d.days) || d.days.length === 0) {
    throw new Error("Invalid backup: data.days must be a non-empty array.");
  }
  const daysSet = new Set<string>();
  for (const dayId of d.days as unknown[]) {
    if (typeof dayId !== "string" || !VALID_DAY_ID_RE.test(dayId)) {
      throw new Error(`Invalid backup: invalid day ID "${String(dayId)}".`);
    }
    if (daysSet.has(dayId)) {
      throw new Error(`Invalid backup: duplicate day ID "${dayId}" in data.days.`);
    }
    daysSet.add(dayId);
  }

  // Validate plans array — shape, canonical dayId, dayId in days, no duplicate IDs.
  if (!Array.isArray(d.plans)) {
    throw new Error("Invalid backup: data.plans must be an array.");
  }
  const seenPlanIds = new Set<string>();
  for (let i = 0; i < (d.plans as unknown[]).length; i++) {
    const item = (d.plans as unknown[])[i];
    if (!isPlanItem(item)) {
      throw new Error(
        `Invalid backup: plan item at index ${i} has unexpected shape (expected {id, name, timeLabel} strings).`
      );
    }
    const planItem = item as PlanItem;
    if (
      typeof planItem.dayId !== "string" ||
      !VALID_DAY_ID_RE.test(planItem.dayId)
    ) {
      throw new Error(
        `Invalid backup: plan item at index ${i} has missing or invalid dayId "${String(planItem.dayId)}".`
      );
    }
    if (!daysSet.has(planItem.dayId)) {
      throw new Error(
        `Invalid backup: plan item at index ${i} has dayId "${planItem.dayId}" not found in data.days.`
      );
    }
    if (seenPlanIds.has(planItem.id)) {
      throw new Error(
        `Invalid backup: duplicate plan id "${planItem.id}" detected.`
      );
    }
    seenPlanIds.add(planItem.id);
  }

  // Validate activeDayId — must be canonical and present in days.
  if (
    typeof d.activeDayId !== "string" ||
    !VALID_DAY_ID_RE.test(d.activeDayId)
  ) {
    throw new Error(
      `Invalid backup: invalid activeDayId "${String(d.activeDayId)}".`
    );
  }
  if (!daysSet.has(d.activeDayId as string)) {
    throw new Error(
      `Invalid backup: activeDayId "${String(d.activeDayId)}" not found in data.days.`
    );
  }

  // dayMeta must be a plain object when present; each entry must have valid shape
  if ("dayMeta" in d && d.dayMeta !== undefined) {
    if (
      typeof d.dayMeta !== "object" ||
      d.dayMeta === null ||
      Array.isArray(d.dayMeta)
    ) {
      throw new Error("Invalid backup: dayMeta must be a plain object when present.");
    }
    for (const [key, entry] of Object.entries(d.dayMeta as Record<string, unknown>)) {
      if (!VALID_DAY_ID_RE.test(key)) continue;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`Invalid backup: dayMeta["${key}"] must be a plain object.`);
      }
      const e = entry as Record<string, unknown>;
      if ("label" in e && typeof e.label !== "string") {
        throw new Error(`Invalid backup: dayMeta["${key}"].label must be a string when present.`);
      }
      if ("date" in e && typeof e.date !== "string") {
        throw new Error(`Invalid backup: dayMeta["${key}"].date must be a string when present.`);
      }
    }
  }

  return raw as PlannerBackupPayload;
}

/**
 * Safe parse: returns a validated PlannerBackupPayload or null.
 * Never throws.
 */
export function parsePlannerBackupPayload(
  raw: unknown
): PlannerBackupPayload | null {
  try {
    return validatePlannerBackupPayload(raw);
  } catch {
    return null;
  }
}

/**
 * Parse raw file text from an uploaded backup .json file.
 * Enforces size guard, JSON validity, and payload schema.
 * Returns the payload or null. Never throws.
 */
export function parsePlannerBackupFile(
  text: string
): PlannerBackupPayload | null {
  try {
    const byteLength = new TextEncoder().encode(text).length;
    if (byteLength > MAX_IMPORT_BYTES) return null;
    const parsed = JSON.parse(text);
    return parsePlannerBackupPayload(parsed);
  } catch {
    return null;
  }
}

// ===== SYSTEM 2: DAY PLAN EXPORT / IMPORT =====
// Payload type: "day-plan-export"
// Contains ONLY plan items for a single day.
// MUST NOT include dayId, day label, day date, or planner metadata.

export type DayPlanExportPayload = {
  version: 1;
  type: "day-plan-export";
  exportedAt: string;
  items: DayExportItem[];
};

/** Build the day plan export payload from active-day items only. dayId is stripped. */
export function buildDayPlanExportPayload(
  activeDayPlans: PlanItem[]
): DayPlanExportPayload {
  return {
    version: 1,
    type: "day-plan-export",
    exportedAt: new Date().toISOString(),
    items: activeDayPlans.map(({ id, name, timeLabel }) => ({
      id,
      name,
      timeLabel,
    })),
  };
}

/**
 * Validate a parsed JSON value against the day-plan-export schema.
 * Returns the validated item array on success.
 * Throws a descriptive Error on any validation failure.
 */
export function validateDayPlanImportPayload(raw: unknown): DayExportItem[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid day plan: expected a JSON object.");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.version !== 1) {
    throw new Error(
      `Invalid day plan: unsupported version ${String(obj.version)}. Expected 1.`
    );
  }
  if (obj.type !== "day-plan-export") {
    throw new Error(
      `Invalid day plan: wrong type "${String(obj.type)}". Expected "day-plan-export".`
    );
  }
  // exportedAt is required and must be a string
  if (typeof obj.exportedAt !== "string") {
    throw new Error("Invalid day plan: exportedAt is required and must be a string.");
  }
  if (!Array.isArray(obj.items)) {
    throw new Error("Invalid day plan: items must be an array.");
  }
  for (let i = 0; i < (obj.items as unknown[]).length; i++) {
    const item = (obj.items as unknown[])[i];
    if (!isDayExportItem(item)) {
      throw new Error(
        `Invalid day plan: item at index ${i} has unexpected shape (expected {id, name, timeLabel} strings).`
      );
    }
    // Reject planner-only fields — dayId must not appear in day-plan export items
    if (
      "dayId" in (item as Record<string, unknown>) &&
      (item as Record<string, unknown>).dayId !== undefined
    ) {
      throw new Error(
        `Invalid day plan: item at index ${i} contains dayId which is not allowed in day-plan exports.`
      );
    }
  }
  return obj.items as DayExportItem[];
}

/**
 * Safe parse: returns validated DayExportItem[] or null.
 * Never throws.
 */
export function parseDayPlanImportPayload(
  raw: unknown
): DayExportItem[] | null {
  try {
    return validateDayPlanImportPayload(raw);
  } catch {
    return null;
  }
}

/**
 * Parse raw file text from an uploaded day plan .json file.
 * Enforces size guard, JSON validity, and payload schema.
 * Returns validated items or null. Never throws.
 */
export function parseDayPlanImportFile(text: string): DayExportItem[] | null {
  try {
    const byteLength = new TextEncoder().encode(text).length;
    if (byteLength > MAX_IMPORT_BYTES) return null;
    const parsed = JSON.parse(text);
    return parseDayPlanImportPayload(parsed);
  } catch {
    return null;
  }
}

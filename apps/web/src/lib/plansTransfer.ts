// Phase 7.4 — Plans portable export / import helpers
// Single responsibility: build, validate, and parse the dwp-plans-export format.
// No side effects. No storage reads/writes. No React dependencies.

export type PlanItem = {
  id: string;
  name: string;
  timeLabel: string;
  dayId?: string; // Phase 8.0 — optional for backward compat with stored/imported data
};

export type PlansExportPayload = {
  version: 1;
  type: "dwp-plans-export";
  exportedAt: string;
  plans: {
    version: 1;
    items: PlanItem[];
  };
};

/** Reject payloads larger than 1 MB before parsing. */
const MAX_IMPORT_BYTES = 1_048_576;

/** Build the top-level export payload from current in-memory items. */
export function buildPlansExportPayload(items: PlanItem[]): PlansExportPayload {
  return {
    version: 1,
    type: "dwp-plans-export",
    exportedAt: new Date().toISOString(),
    plans: {
      version: 1,
      items,
    },
  };
}

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

/**
 * Validate a parsed (but unknown-typed) JSON value against the dwp-plans-export schema.
 * Returns the validated PlanItem array on success.
 * Throws a descriptive Error on any validation failure.
 */
export function validatePlansImportPayload(input: unknown): PlanItem[] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid file: expected a JSON object.");
  }
  const obj = input as Record<string, unknown>;

  if (!("version" in obj) || !("type" in obj) || !("plans" in obj)) {
    throw new Error("Invalid file: missing required fields (version, type, plans).");
  }
  if (obj.version !== 1) {
    throw new Error(`Unsupported version: ${String(obj.version)}. Expected 1.`);
  }
  if (obj.type !== "dwp-plans-export") {
    throw new Error(`Invalid type: "${String(obj.type)}". Expected "dwp-plans-export".`);
  }

  const plans = obj.plans;
  if (typeof plans !== "object" || plans === null || Array.isArray(plans)) {
    throw new Error("Invalid file: plans field must be an object.");
  }
  const plansObj = plans as Record<string, unknown>;
  if (!Array.isArray(plansObj.items)) {
    throw new Error("Invalid file: plans.items must be an array.");
  }

  const raw = plansObj.items as unknown[];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    if (!isPlanItem(raw[i])) {
      throw new Error(
        `Invalid file: item at index ${i} has unexpected shape (expected {id, name, timeLabel} strings).`
      );
    }
    const id = (raw[i] as PlanItem).id;
    if (seenIds.has(id)) {
      throw new Error(`Invalid file: duplicate plan id "${id}" detected.`);
    }
    seenIds.add(id);
  }
  return raw as PlanItem[];
}

/**
 * Parse raw file text from an uploaded .json file.
 * Enforces size guard, JSON validity, and payload schema.
 * Returns validated PlanItem[] on success or throws a descriptive Error.
 */
export function parseImportedPlansFile(text: string): PlanItem[] {
  const byteLength = new TextEncoder().encode(text).length;
  if (byteLength > MAX_IMPORT_BYTES) {
    throw new Error("File is too large to import (maximum: 1 MB).");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Invalid file: could not parse as JSON.");
  }
  return validatePlansImportPayload(parsed);
}

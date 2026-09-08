/**
 * syncPayload.ts — Phase 7.6 Sync Scope Expansion
 *
 * Types and helpers for the combined planner sync payload.
 * The synced payload bundles both plans and lightning data
 * for a single signed-in user + active profile.
 *
 * Payload shape:
 *   { version: 1, plans: { version, items[] }, lightning: { version, items[] }, days?: string[] }
 *
 * Phase 11.2 Codex fix — `days` (the profile's ordered day list) is an
 * optional addition to this same version-1 shape, not a version bump: the
 * outer `version` stays 1 so existing stored rows and any code still
 * reading the pre-days shape remain valid. Older/legacy payloads omit
 * `days` entirely — callers must treat its absence as "no synced order",
 * not as an error, and fall back to their existing local reconstruction
 * (see plans/page.tsx and lightning/page.tsx pull handling).
 */

// ===== TYPES =====

export interface SyncedPlannerPayload {
  version: 1;
  plans: {
    version: number;
    items: unknown[];
  };
  lightning: {
    version: number;
    items: unknown[];
  };
  /**
   * Phase 11.2 Codex fix — the profile's ordered days[] (stable dayIds in
   * their persisted display order), when the pushing device had a valid
   * local order to send. Optional and omitted when absent — see the
   * module doc above.
   */
  days?: string[];
}

// Canonical day ID shape, matching plans/page.tsx's VALID_DAY_ID_RE.
const DAY_ID_RE = /^day-[1-9]\d*$/;

/**
 * Filter+dedupe a raw value down to a valid ordered days[] array (preserving
 * first-occurrence order), or undefined if it isn't a non-empty array of
 * canonical day ID strings. Shared by the builder (so a malformed local
 * days[] is simply omitted rather than corrupting the push) and the parser
 * (so a malformed/legacy cloud value degrades to "no synced order" instead
 * of invalidating the whole payload).
 */
function sanitizeDaysOrder(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const d of raw) {
    if (typeof d === "string" && DAY_ID_RE.test(d) && !seen.has(d)) {
      seen.add(d);
      valid.push(d);
    }
  }
  return valid.length > 0 ? valid : undefined;
}

// ===== BUILDERS =====

export function buildSyncedPlannerPayload(
  plans: { version: number; items: unknown[] },
  lightning: { version: number; items: unknown[] },
  // Accepts unknown[] (not just string[]) since sanitizeDaysOrder() below
  // filters/validates at runtime anyway — callers can pass a raw parsed
  // localStorage value without pre-validating it themselves.
  days?: unknown[]
): SyncedPlannerPayload {
  const sanitizedDays = sanitizeDaysOrder(days);
  return sanitizedDays
    ? { version: 1, plans, lightning, days: sanitizedDays }
    : { version: 1, plans, lightning };
}

// ===== PARSERS / VALIDATORS =====

/**
 * Parse and validate a raw unknown value as a SyncedPlannerPayload.
 * Returns null if the shape is missing or invalid — callers treat null as
 * "no data" and fall through to local-only mode.
 *
 * `days`, when present, is sanitized rather than treated as all-or-nothing
 * like plans/lightning: a malformed or empty `days` value degrades to
 * "absent" (undefined) instead of rejecting an otherwise-valid payload —
 * plans/lightning data must never be discarded over a corrupted `days` tag
 * on an incidental field older clients never wrote.
 */
export function parseSyncedPlannerPayload(raw: unknown): SyncedPlannerPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return null;

  // Validate plans sub-object
  if (!r.plans || typeof r.plans !== "object" || Array.isArray(r.plans)) return null;
  const plans = r.plans as Record<string, unknown>;
  if (typeof plans.version !== "number" || !Array.isArray(plans.items)) return null;

  // Validate lightning sub-object
  if (!r.lightning || typeof r.lightning !== "object" || Array.isArray(r.lightning)) return null;
  const lightning = r.lightning as Record<string, unknown>;
  if (typeof lightning.version !== "number" || !Array.isArray(lightning.items)) return null;

  const days = sanitizeDaysOrder(r.days);

  return {
    version: 1,
    plans: { version: plans.version as number, items: plans.items as unknown[] },
    lightning: { version: lightning.version as number, items: lightning.items as unknown[] },
    ...(days ? { days } : {}),
  };
}

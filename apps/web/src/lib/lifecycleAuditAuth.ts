/**
 * lifecycleAuditAuth.ts — authorization for GET /api/catalog/lifecycle-audit.
 *
 * Accepts the dedicated `DWP_LIFECYCLE_AUDIT_API_KEY` and, for backward
 * compatibility, the legacy `DWP_CATALOG_API_KEY`, both presented in the
 * existing `x-dwp-catalog-api-key` header. Only this endpoint accepts the
 * dedicated key; every other catalog route and Ask Tom keep their own checks.
 *
 * Fail-closed: unset, empty or whitespace-only configured keys never count as
 * credentials (a missing/blank provided key can therefore never match one), and
 * if neither key is configured the result is "not_configured". Comparison is
 * timing-safe over SHA-256 digests (no length leak) and always evaluates both
 * keys (no short-circuit). Pure: no I/O, never logs or returns key material.
 */

import { createHash, timingSafeEqual } from "crypto";

export type LifecycleAuditAuthResult = "ok" | "unauthorized" | "not_configured";

function usable(key: string | undefined | null): key is string {
  return typeof key === "string" && key.trim().length > 0;
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

function matches(provided: string, expected: string | undefined): boolean {
  if (!usable(expected)) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

export function authorizeLifecycleAudit(
  providedKey: string | null | undefined,
  env: { DWP_LIFECYCLE_AUDIT_API_KEY?: string; DWP_CATALOG_API_KEY?: string },
): LifecycleAuditAuthResult {
  const dedicated = env.DWP_LIFECYCLE_AUDIT_API_KEY;
  const legacy = env.DWP_CATALOG_API_KEY;
  if (!usable(dedicated) && !usable(legacy)) return "not_configured";
  if (!usable(providedKey)) return "unauthorized";
  const okDedicated = matches(providedKey, dedicated);
  const okLegacy = matches(providedKey, legacy);
  return okDedicated || okLegacy ? "ok" : "unauthorized";
}

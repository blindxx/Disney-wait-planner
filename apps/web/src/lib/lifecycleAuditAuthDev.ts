/**
 * lifecycleAuditAuthDev.ts — DEV checks for lifecycleAuditAuth.ts (run manually
 * from Node; returns failing labels, [] = all pass). Not imported by app code.
 *   runDevLifecycleAuditAuthCases()
 */

import { authorizeLifecycleAudit as auth } from "./lifecycleAuditAuth";

export function runDevLifecycleAuditAuthCases(): string[] {
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const both = { DWP_LIFECYCLE_AUDIT_API_KEY: "audit-key-1", DWP_CATALOG_API_KEY: "catalog-key-1" };

  check("dedicated key accepted", auth("audit-key-1", both) === "ok");
  check("legacy catalog key still accepted (backward compatible)", auth("catalog-key-1", both) === "ok");
  check("legacy key accepted when dedicated key is not configured", auth("catalog-key-1", { DWP_CATALOG_API_KEY: "catalog-key-1" }) === "ok");
  check("dedicated key accepted when legacy key is not configured", auth("audit-key-1", { DWP_LIFECYCLE_AUDIT_API_KEY: "audit-key-1" }) === "ok");
  check("wrong key rejected", auth("nope", both) === "unauthorized");
  check("prefix / extension of a valid key rejected", auth("audit-key", both) === "unauthorized" && auth("audit-key-12", both) === "unauthorized");
  check("case difference rejected", auth("AUDIT-KEY-1", both) === "unauthorized");
  check("missing header rejected", auth(null, both) === "unauthorized" && auth(undefined, both) === "unauthorized");
  check("empty provided key rejected", auth("", both) === "unauthorized");
  check("whitespace provided key rejected", auth("   ", both) === "unauthorized");
  check("neither key configured -> not_configured (fail closed)", auth("audit-key-1", {}) === "not_configured" && auth(null, {}) === "not_configured");
  check("empty-string configured keys are not credentials", auth("", { DWP_LIFECYCLE_AUDIT_API_KEY: "", DWP_CATALOG_API_KEY: "" }) === "not_configured");
  check("whitespace-only configured keys are not credentials", auth("  ", { DWP_LIFECYCLE_AUDIT_API_KEY: "  ", DWP_CATALOG_API_KEY: "\t" }) === "not_configured");
  check("empty dedicated key never matches an empty provided key while legacy is set", auth("", { DWP_LIFECYCLE_AUDIT_API_KEY: "", DWP_CATALOG_API_KEY: "catalog-key-1" }) === "unauthorized");
  check("blank dedicated key does not disable the legacy key", auth("catalog-key-1", { DWP_LIFECYCLE_AUDIT_API_KEY: "", DWP_CATALOG_API_KEY: "catalog-key-1" }) === "ok");
  check("undefined configured values handled", auth("x", { DWP_LIFECYCLE_AUDIT_API_KEY: undefined, DWP_CATALOG_API_KEY: undefined }) === "not_configured");
  check("identical dedicated/legacy values still work", auth("same", { DWP_LIFECYCLE_AUDIT_API_KEY: "same", DWP_CATALOG_API_KEY: "same" }) === "ok");
  check("unicode keys compared exactly", auth("kéy-✓", { DWP_LIFECYCLE_AUDIT_API_KEY: "kéy-✓" }) === "ok" && auth("key-✓", { DWP_LIFECYCLE_AUDIT_API_KEY: "kéy-✓" }) === "unauthorized");
  return failures;
}

/**
 * Appearance (Phase 13.0) — device-local Light / Dark / System preference.
 *
 * Deliberately NOT profile-scoped, account-scoped, cloud-synced, or part of
 * planner export/backup: appearance belongs to the device/browser. The key
 * uses the `dwp.` dot form (like `dwp.activeProfile`), which none of the
 * `dwp:{profileId}:` profile cleanup / sync-key prefix scans match.
 *
 * The resolved theme is exposed as `data-theme="light|dark"` on <html>, which
 * globals.css keys its semantic variables off. APPEARANCE_INIT_SCRIPT runs
 * before first paint (inline in <head>) and must stay behaviorally identical
 * to readPreference() + resolveTheme() + applyTheme() below.
 */

export type AppearancePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const APPEARANCE_STORAGE_KEY = "dwp.appearance";
export const APPEARANCE_CHANGED_EVENT = "dwp:appearance-changed";
export const DEFAULT_APPEARANCE: AppearancePreference = "system";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isAppearancePreference(v: unknown): v is AppearancePreference {
  return v === "light" || v === "dark" || v === "system";
}

/** In-memory fallback so a choice still applies this session when storage throws. */
let memoryPreference: AppearancePreference | null = null;

/** Never throws; invalid/missing/unreadable storage resolves to the default. */
export function readPreference(): AppearancePreference {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (isAppearancePreference(raw)) return raw;
    // Storage readable but empty/invalid: a failed earlier write may still
    // have left a session-only choice.
    return memoryPreference ?? DEFAULT_APPEARANCE;
  } catch {
    return memoryPreference ?? DEFAULT_APPEARANCE;
  }
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

export function resolveTheme(pref: AppearancePreference): ResolvedTheme {
  if (pref === "system") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

export function applyTheme(theme: ResolvedTheme): void {
  const el = document.documentElement;
  if (el.getAttribute("data-theme") !== theme) el.setAttribute("data-theme", theme);
  el.style.colorScheme = theme;
}

/** Persists (best effort), applies immediately, and notifies same-tab listeners. */
export function setPreference(pref: AppearancePreference): void {
  memoryPreference = pref;
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, pref);
  } catch {}
  applyTheme(resolveTheme(pref));
  window.dispatchEvent(new Event(APPEARANCE_CHANGED_EVENT));
}

/**
 * useSyncExternalStore-compatible subscription to preference changes from
 * this tab (custom event) and other tabs (`storage`; key === null is a
 * clear()).
 */
export function subscribePreference(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === APPEARANCE_STORAGE_KEY) onChange();
  };
  window.addEventListener(APPEARANCE_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(APPEARANCE_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Pre-paint initializer; keep in sync with the functions above. */
export const APPEARANCE_INIT_SCRIPT = `(function(){var p="${DEFAULT_APPEARANCE}";try{var v=localStorage.getItem("${APPEARANCE_STORAGE_KEY}");if(v==="light"||v==="dark"||v==="system")p=v}catch(e){}var d=p==="dark";if(p==="system"){try{d=window.matchMedia("${DARK_QUERY}").matches}catch(e){}}var t=d?"dark":"light";var r=document.documentElement;r.setAttribute("data-theme",t);r.style.colorScheme=t})();`;

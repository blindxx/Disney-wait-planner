/**
 * Appearance (Phase 13.0) — device-local Light / Dark / System preference.
 *
 * Deliberately NOT profile-scoped, account-scoped, cloud-synced, or part of
 * planner export/backup: appearance belongs to the device/browser. The key
 * uses the `dwp.` dot form (like `dwp.activeProfile`), which none of the
 * `dwp:{profileId}:` profile cleanup / sync-key prefix scans match.
 *
 * The resolved theme is exposed as `data-theme="light|dark"` on <html>, which
 * globals.css keys its semantic variables off. Until every route is converted
 * (Phases 13.1-13.3), the page surface/text/native-control dark values apply
 * only on THEMED_ROUTES (`data-themed-route` on <html>); unconverted routes
 * keep their light page surface so their hardcoded dark text stays readable.
 * Navigation themes everywhere. APPEARANCE_INIT_SCRIPT runs
 * before first paint (inline in <head>) and must stay behaviorally identical
 * to readPreference() + resolveTheme() + applyTheme() below.
 */

export type AppearancePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const APPEARANCE_STORAGE_KEY = "dwp.appearance";
export const APPEARANCE_CHANGED_EVENT = "dwp:appearance-changed";
/**
 * Routes whose page content is fully themed. Extend as 13.1-13.3 convert pages.
 * "/" (Today) matches exactly only: the `r + "/"` prefix test can't match "//".
 */
export const THEMED_ROUTES: readonly string[] = ["/", "/settings", "/wait-times", "/entertainment/all", "/plans", "/lightning"];

export function isThemedRoute(pathname: string): boolean {
  return THEMED_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"));
}

export function applyThemedRoute(pathname: string): void {
  const el = document.documentElement;
  if (isThemedRoute(pathname)) {
    if (!el.hasAttribute("data-themed-route")) el.setAttribute("data-themed-route", "");
  } else if (el.hasAttribute("data-themed-route")) {
    el.removeAttribute("data-themed-route");
  }
}

export const DEFAULT_APPEARANCE: AppearancePreference = "system";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isAppearancePreference(v: unknown): v is AppearancePreference {
  return v === "light" || v === "dark" || v === "system";
}

/**
 * Session-only choice, set ONLY when persisting it failed. While set it wins
 * over whatever storage still holds (a stale valid value would otherwise
 * mask the new choice). Cleared on a successful write or when another tab
 * writes the key.
 */
let unpersistedPreference: AppearancePreference | null = null;

/** Never throws; invalid/missing/unreadable storage resolves to the default. */
export function readPreference(): AppearancePreference {
  try {
    if (unpersistedPreference) return unpersistedPreference;
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return isAppearancePreference(raw) ? raw : DEFAULT_APPEARANCE;
  } catch {
    return unpersistedPreference ?? DEFAULT_APPEARANCE;
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
}

/** Persists (best effort), applies immediately, and notifies same-tab listeners. */
export function setPreference(pref: AppearancePreference): void {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, pref);
    unpersistedPreference = null;
  } catch {
    unpersistedPreference = pref;
  }
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
    if (e.key === null || e.key === APPEARANCE_STORAGE_KEY) {
      // Another tab wrote (or cleared) the key: that is newer than any
      // session-only choice made here after a failed write.
      unpersistedPreference = null;
      onChange();
    }
  };
  window.addEventListener(APPEARANCE_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(APPEARANCE_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Pre-paint initializer; keep in sync with the functions above. */
export const APPEARANCE_INIT_SCRIPT = `(function(){var p="${DEFAULT_APPEARANCE}";try{var v=localStorage.getItem("${APPEARANCE_STORAGE_KEY}");if(v==="light"||v==="dark"||v==="system")p=v}catch(e){}var d=p==="dark";if(p==="system"){try{d=window.matchMedia("${DARK_QUERY}").matches}catch(e){}}var t=d?"dark":"light";var r=document.documentElement;r.setAttribute("data-theme",t);var T=${JSON.stringify(THEMED_ROUTES)},n=location.pathname;for(var i=0;i<T.length;i++){if(n===T[i]||n.indexOf(T[i]+"/")===0){r.setAttribute("data-themed-route","");break}}})();`;

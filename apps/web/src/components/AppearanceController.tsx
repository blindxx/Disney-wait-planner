"use client";

import { useEffect } from "react";
import {
  applyTheme,
  readPreference,
  resolveTheme,
  subscribePreference,
  systemPrefersDark,
} from "@/lib/appearance";

/**
 * Keeps <html data-theme> in sync after the pre-paint script ran: re-applies
 * on mount (covers a missing/blocked script), follows live OS changes while
 * the preference is "system", and reacts to preference changes made in this
 * or another tab. Renders nothing; independent of auth/profile lifecycle.
 */
export default function AppearanceController() {
  useEffect(() => {
    const sync = () => applyTheme(resolveTheme(readPreference()));
    sync();

    const unsubscribe = subscribePreference(sync);

    let mql: MediaQueryList | null = null;
    try {
      mql = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {}
    // Only "system" follows the OS; explicit light/dark ignore it.
    const onSystemChange = () => {
      if (readPreference() === "system") applyTheme(systemPrefersDark() ? "dark" : "light");
    };
    if (mql) {
      if (mql.addEventListener) mql.addEventListener("change", onSystemChange);
      else mql.addListener(onSystemChange); // older Safari
    }

    return () => {
      unsubscribe();
      if (mql) {
        if (mql.removeEventListener) mql.removeEventListener("change", onSystemChange);
        else mql.removeListener(onSystemChange);
      }
    };
  }, []);

  return null;
}

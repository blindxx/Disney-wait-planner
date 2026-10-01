"use client";

/**
 * Floating "Back to Top" button (Tom help + Waits & Shows) — appears once the page has scrolled past
 * SHOW_AFTER_PX, smooth-scrolls to the top on click. Styling (.tomhg-back-to-top)
 * is defined by each host page (/tom/help, /wait-times).
 */

import { useEffect, useState } from "react";

const SHOW_AFTER_PX = 400;

export default function BackToTopButton() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    function handleScroll() {
      setVisible(window.scrollY > SHOW_AFTER_PX);
    }
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      className="tomhg-back-to-top"
      onClick={() => {
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
      }}
      aria-label="Back to top"
    >
      ↑ Top
    </button>
  );
}

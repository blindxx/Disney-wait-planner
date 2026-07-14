"use client";

/**
 * Floating "Back to Top" button — appears once the page has scrolled past
 * SHOW_AFTER_PX, smooth-scrolls to the top on click. Styling (.tomhg-back-to-top)
 * lives alongside the rest of /tom/help's CSS in that page's server component.
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
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Back to top"
    >
      ↑ Top
    </button>
  );
}

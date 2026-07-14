// Developer Note: This page is the living reference for Tom's capabilities.
// Any phase that adds, removes, or changes user-facing functionality should
// update this guide accordingly.

/**
 * /tom/help — Phase 10.4.4 Tom Full Help Guide
 *
 * Comprehensive, living documentation of Tom's current user-facing
 * capabilities. This is a reference page, not onboarding, and is
 * intentionally not linked from main navigation — it's reachable from the
 * "View Full Help Guide" link in the Ask Tom Help modal (see
 * app/tom/page.tsx) or by direct URL.
 *
 * Section content lives in lib/tomHelpContent.ts as plain data, so adding a
 * section or updating a description/example list doesn't require touching
 * this layout.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { TOM_HELP_SECTIONS } from "@/lib/tomHelpContent";

export const metadata: Metadata = {
  title: "Tom Help Guide | Disney Wait Planner",
  description: "The full reference for what Tom, Disney Wait Planner's AI assistant, can currently do.",
};

const GUIDE_CSS = `
  .tomhg-page {
    max-width: 760px;
    margin: 0 auto;
  }
  .tomhg-back {
    display: inline-block;
    margin-bottom: 16px;
    color: #1e3a5f;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
  }
  .tomhg-back:hover {
    text-decoration: underline;
  }
  .tomhg-title {
    font-size: 28px;
    font-weight: 700;
    color: #111827;
    margin: 0 0 8px;
  }
  .tomhg-intro {
    font-size: 15px;
    line-height: 1.6;
    color: #374151;
    margin: 0 0 24px;
  }

  .tomhg-toc {
    border: 1px solid #e5e7eb;
    background-color: #f9fafb;
    border-radius: 12px;
    padding: 16px 18px;
    margin-bottom: 32px;
  }
  .tomhg-toc h2 {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #6b7280;
  }
  .tomhg-toc-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px 20px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .tomhg-toc-list a {
    display: block;
    padding: 4px 0;
    color: #1e3a5f;
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
  }
  .tomhg-toc-list a:hover {
    text-decoration: underline;
  }

  .tomhg-section {
    padding: 20px 0;
    border-top: 1px solid #e5e7eb;
    scroll-margin-top: 16px;
  }
  .tomhg-section:first-of-type {
    border-top: none;
  }
  .tomhg-section h2 {
    margin: 0 0 8px;
    font-size: 19px;
    font-weight: 700;
    color: #111827;
  }
  .tomhg-section p {
    margin: 0 0 10px;
    font-size: 14px;
    line-height: 1.6;
    color: #374151;
  }
  .tomhg-section ul {
    margin: 0 0 10px;
    padding-left: 20px;
    font-size: 14px;
    line-height: 1.7;
    color: #374151;
  }

  .tomhg-examples-label {
    display: block;
    margin: 4px 0 8px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #6b7280;
  }
  .tomhg-examples {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .tomhg-example-chip {
    padding: 7px 12px;
    border-radius: 999px;
    border: 1px solid #d1d5db;
    background-color: #fff;
    color: #1e3a5f;
    font-size: 13px;
    font-weight: 500;
  }

  @media (max-width: 480px) {
    .tomhg-title {
      font-size: 22px;
    }
    .tomhg-toc-list {
      grid-template-columns: 1fr;
    }
  }
`;

export default function TomHelpGuidePage() {
  return (
    <div className="tomhg-page">
      <style>{GUIDE_CSS}</style>
      <Link href="/tom" className="tomhg-back">
        &larr; Back to Ask Tom
      </Link>
      <h1 className="tomhg-title">Tom Help Guide</h1>
      <p className="tomhg-intro">
        The full reference for what Tom, Disney Wait Planner&rsquo;s AI assistant, can currently do. Example
        questions throughout are representative — ask naturally, in your own words.
      </p>

      <nav className="tomhg-toc" aria-label="Table of contents">
        <h2>On this page</h2>
        <ul className="tomhg-toc-list">
          {TOM_HELP_SECTIONS.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{section.title}</a>
            </li>
          ))}
        </ul>
      </nav>

      {TOM_HELP_SECTIONS.map((section) => (
        <section key={section.id} id={section.id} className="tomhg-section">
          <h2>{section.title}</h2>
          {section.paragraphs?.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
          {section.bullets && (
            <ul>
              {section.bullets.map((bullet, i) => (
                <li key={i}>{bullet}</li>
              ))}
            </ul>
          )}
          {section.examples && section.examples.length > 0 && (
            <>
              <span className="tomhg-examples-label">Example questions</span>
              <ul className="tomhg-examples">
                {section.examples.map((example) => (
                  <li key={example} className="tomhg-example-chip">
                    {example}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
    </div>
  );
}

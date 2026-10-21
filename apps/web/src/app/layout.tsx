import type { Metadata } from "next";
import Link from "next/link";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import SessionProviderWrapper from "@/components/SessionProviderWrapper";
import AppearanceController from "@/components/AppearanceController";
import { APPEARANCE_INIT_SCRIPT } from "@/lib/appearance";

export const metadata: Metadata = {
  title: "Disney Wait Planner",
  description: "Plan your Disney park visit",
};

const navLinks = [
  { href: "/", label: "Today" },
  { href: "/plans", label: "My Plans" },
  { href: "/wait-times", label: "Waits & Shows" },
  { href: "/lightning", label: "Lightning" },
  { href: "/tom", label: "Ask Tom" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // suppressHydrationWarning: the pre-paint script sets data-theme and
  // style.colorScheme on <html> before React hydrates.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_INIT_SCRIPT }} />
      </head>
      <body>
        <AppearanceController />
        <nav className="nav">
          <ul className="nav-list">
            {navLinks.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="nav-link">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main className="main">
          <SessionProviderWrapper>{children}</SessionProviderWrapper>
        </main>
        <Analytics />
      </body>
    </html>
  );
}

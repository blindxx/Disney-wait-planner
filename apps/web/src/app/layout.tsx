import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Disney Wait Planner",
  description: "Plan your Disney park visit",
};

const navLinks = [
  { href: "/", label: "Today" },
  { href: "/plans", label: "My Plans" },
  { href: "/wait-times", label: "Wait Times" },
  { href: "/lightning", label: "Lightning" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
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
        <main className="main">{children}</main>
      </body>
    </html>
  );
}

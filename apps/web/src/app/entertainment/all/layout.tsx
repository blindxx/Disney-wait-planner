import type { Metadata } from "next";

// Hidden page (no navigation link): keep it out of search indexes too.
export const metadata: Metadata = {
  title: "All Entertainment — Disney Wait Planner",
  robots: { index: false, follow: false },
};

export default function AllEntertainmentLayout({ children }: { children: React.ReactNode }) {
  return children;
}

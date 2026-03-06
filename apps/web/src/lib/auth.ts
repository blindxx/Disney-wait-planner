/**
 * NextAuth.js v4 configuration — Magic Link (Email provider)
 *
 * Required environment variables (names only — never commit values):
 *   DATABASE_URL     — PostgreSQL connection string (Neon / Vercel Postgres)
 *   NEXTAUTH_URL     — Canonical app URL, e.g. https://your-app.vercel.app
 *   NEXTAUTH_SECRET  — Random secret: openssl rand -base64 32
 *   EMAIL_SERVER     — SMTP URI, e.g. smtp://user:pass@smtp.example.com:587
 *   EMAIL_FROM       — Sender address, e.g. "Disney Wait Planner <noreply@example.com>"
 *
 * Database tables required (run once in your Postgres instance):
 *   See apps/web/src/lib/db-schema.sql
 */

import { type NextAuthOptions } from "next-auth";
import EmailProvider from "next-auth/providers/email";
import PostgresAdapter from "@auth/pg-adapter";
import { getPool } from "./db";

export const authOptions: NextAuthOptions = {
  // @auth/pg-adapter is compatible with both next-auth v4 and auth.js v5
  // getPool() is called lazily so the build step does not require DATABASE_URL.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get adapter() { return PostgresAdapter(getPool()) as any; },

  providers: [
    EmailProvider({
      server: process.env.EMAIL_SERVER,
      from: process.env.EMAIL_FROM,
    }),
  ],

  // Use database sessions (stored in the `sessions` table).
  // This keeps the client session cookie small and allows server-side revocation.
  session: { strategy: "database" },

  // Redirect back to Settings after magic-link sign-in / on error.
  pages: {
    signIn: "/settings",
    error: "/settings",
  },

  callbacks: {
    // Expose the numeric user id in the client-accessible session object.
    session({ session, user }) {
      if (session.user) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (session.user as any).id = String(user.id);
      }
      return session;
    },
  },
};

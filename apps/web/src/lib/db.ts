import { Pool } from "pg";

// Lazily-created singleton pool.
// The pool is not instantiated until the first getPool() call,
// so the build step (which imports this module) does not fail when
// DATABASE_URL is not set in the build environment.
//
// Required env var at runtime:
//   DATABASE_URL — PostgreSQL connection string (Neon / Vercel Postgres)

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

export function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL env var is not set");
  }
  // Single Pool instance reused in BOTH development and production.
  // globalThis persists across HMR cycles in dev and across warm invocations
  // in production serverless runtimes, preventing connection accumulation.
  if (!global.__pgPool) {
    global.__pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return global.__pgPool;
}

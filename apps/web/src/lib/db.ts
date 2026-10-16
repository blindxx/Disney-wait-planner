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
  // eslint-disable-next-line no-var
  var __pgParkHoursPool: Pool | undefined;
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

/**
 * Dedicated, deliberately tiny pool for best-effort park-hours persistence
 * (parkHoursStore.ts). Kept separate from getPool() so a slow or hung
 * persistence write can never occupy connections that auth / planner sync
 * need: at most ONE connection per server instance, bounded connect and query
 * time, and an idle timeout so it does not hold a Neon connection open.
 */
export function getParkHoursPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL env var is not set");
  }
  if (!global.__pgParkHoursPool) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10_000,
      query_timeout: 5000,
    });
    // An idle-client error must not become an unhandled 'error' event.
    pool.on("error", () => {});
    global.__pgParkHoursPool = pool;
  }
  return global.__pgParkHoursPool;
}

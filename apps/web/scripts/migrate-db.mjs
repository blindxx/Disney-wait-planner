#!/usr/bin/env node
// ============================================================
// SH.2.5 — Sync Schema Migration & Deployment Safety
//
// Applies apps/web/src/lib/db-schema.sql against DATABASE_URL, then
// verifies the objects the SH.2 sync endpoints (/api/sync/planner)
// require at runtime actually exist.
//
// db-schema.sql is itself written to be safely rerunnable — every
// statement uses CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS,
// so running this script against an already-migrated database (fresh
// or previously migrated) is a no-op that preserves existing rows.
// Running it against a pre-SH.2 database with a populated
// `user_planner` table adds the new `revision` column with
// `DEFAULT 0` (an instant, metadata-only change on Postgres 11+ — no
// table rewrite, no long lock) and creates the new
// `user_planner_revision_seq` sequence and `user_planner_writes`
// ledger alongside the untouched existing rows.
//
// This is the ONLY sanctioned way to bring an existing database's
// schema up to date for SH.2 — do not hand-run partial ALTER
// statements against production; always run this script (or the full
// db-schema.sql it applies) so fresh-database setup and
// existing-database migration can never drift apart.
//
// Usage:
//   DATABASE_URL=postgres://... node apps/web/scripts/migrate-db.mjs
// or, from the repo root:
//   DATABASE_URL=postgres://... pnpm --filter web run db:migrate
//
// Exits non-zero (and prints a FATAL line) on any failure — including
// a database left in a partial state — so a deploy pipeline invoking
// this fails the build/deploy step instead of silently proceeding to
// serve SH.2 application code against an incompatible schema.
// ============================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "..", "src", "lib", "db-schema.sql");

// Objects /api/sync/planner's queries (route.ts) require to exist.
// Verified explicitly after applying db-schema.sql so a partial
// failure (e.g. a permissions error partway through the script, or a
// hand-edited schema file missing something) is caught here, loudly,
// rather than surfacing later as an opaque Postgres error under
// production traffic.
const REQUIRED_CHECKS = [
  {
    label: "user_planner_revision_seq sequence exists",
    sql: `SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'user_planner_revision_seq'`,
  },
  {
    label: "user_planner.revision column exists",
    sql: `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'user_planner' AND column_name = 'revision'`,
  },
  {
    label: "user_planner_writes table exists",
    sql: `SELECT 1 FROM information_schema.tables WHERE table_name = 'user_planner_writes'`,
  },
  {
    label: "user_planner_writes has required columns",
    sql: `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'user_planner_writes'
            AND column_name IN ('user_id', 'profile_id', 'client_op_id', 'revision', 'updated_at', 'created_at', 'status')`,
    expectedRowCount: 7,
  },
  {
    label: "user_planner_writes primary key is (user_id, profile_id, client_op_id)",
    sql: `SELECT 1
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
          WHERE tc.table_name = 'user_planner_writes'
            AND tc.constraint_type = 'PRIMARY KEY'
          GROUP BY tc.constraint_name
          HAVING array_agg(kcu.column_name::text ORDER BY kcu.ordinal_position)
                 = ARRAY['user_id', 'profile_id', 'client_op_id']`,
  },
];

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("FATAL: DATABASE_URL is not set. Refusing to run migration blind.");
    process.exitCode = 1;
    return;
  }

  let schemaSql;
  try {
    schemaSql = readFileSync(SCHEMA_PATH, "utf8");
  } catch (err) {
    console.error(`FATAL: could not read ${SCHEMA_PATH} —`, err.message);
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (err) {
    console.error("FATAL: could not connect to DATABASE_URL —", err.message);
    process.exitCode = 1;
    return;
  }

  try {
    console.log(`Applying ${path.relative(process.cwd(), SCHEMA_PATH)} ...`);
    // db-schema.sql's statements are all transactional DDL (CREATE
    // TABLE/SEQUENCE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS) — wrapping
    // the whole file in one transaction means a failure partway through
    // leaves the schema exactly as it was before this run, never a
    // half-applied state.
    try {
      await client.query("BEGIN");
      await client.query(schemaSql);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("FATAL: applying db-schema.sql failed —", err.message);
      console.error(
        "No schema changes from this run were committed; existing data (including user_planner) was not modified. " +
          "Do NOT deploy SH.2 application code against this database until this script succeeds."
      );
      process.exitCode = 1;
      return;
    }
    console.log("Schema statements applied (columns/tables/sequences already present were left untouched).");

    console.log("Verifying schema satisfies the SH.2 sync contract...");
    try {
      for (const check of REQUIRED_CHECKS) {
        const { rows } = await client.query(check.sql);
        const ok = check.expectedRowCount != null
          ? rows.length === check.expectedRowCount
          : rows.length > 0;
        if (!ok) {
          console.error(`FATAL: post-migration verification failed — ${check.label}`);
          console.error(
            "db-schema.sql was applied and committed, but the resulting schema still does not satisfy the SH.2 " +
              "sync contract used by /api/sync/planner. Do NOT deploy SH.2 application code against this " +
              "database until this is resolved — investigate db-schema.sql and this database's current schema."
          );
          process.exitCode = 1;
          return;
        }
        console.log(`  ok — ${check.label}`);
      }
    } catch (err) {
      console.error("FATAL: post-migration verification query failed —", err.message);
      console.error(
        "db-schema.sql was applied and committed, but this script could not confirm the resulting schema " +
          "satisfies the SH.2 sync contract. Do NOT deploy SH.2 application code against this database " +
          "until this is resolved."
      );
      process.exitCode = 1;
      return;
    }

    console.log("Migration complete: schema is compatible with SH.2 sync endpoints (/api/sync/planner).");
  } finally {
    await client.end();
  }
}

await main();

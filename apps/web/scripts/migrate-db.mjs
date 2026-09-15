#!/usr/bin/env node
// ============================================================
// SH.2.5 — Sync Schema Migration & Deployment Safety
//
// SH.2.5 (Migration Verification Hardening) — post-migration
// verification checks actual column TYPES, nullability, defaults, and
// primary keys — not just column names — and resolves every object
// the same way an unqualified query in route.ts would (via
// `to_regclass`, which follows this connection's `search_path`), so a
// same-named object sitting in some other, non-visible schema can
// never produce a false pass. See the Codex P1 finding this responds
// to: a `user_planner_writes.status INTEGER` column would have
// satisfied the old name-only check while rejecting every
// `'accepted'`/`'rejected'` write /api/sync/planner actually issues.
//
// Applies apps/web/src/lib/db-schema.sql against DATABASE_URL, then
// verifies the objects the SH.2 sync endpoints (/api/sync/planner)
// require at runtime actually exist AND actually match the shape
// those endpoints' queries depend on.
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
// This script never attempts to destructively repair an incompatible
// table (e.g. ALTER ... TYPE to coerce a wrong column type) — that
// could silently corrupt or truncate existing production data
// (`status INTEGER` -> `TEXT` is not a lossless conversion in
// general). An incompatible pre-existing object is reported as a
// FATAL verification failure for a human to resolve, never
// auto-converted.
//
// The one exception is `user_planner_revision_seq`'s POSITION (never
// its shape/configuration): if it's behind the highest `revision`
// already stored in `user_planner` — e.g. it was reset, recreated, or
// restored independently of that table's data — this script advances
// it (via `setval`) so every future `nextval()` is guaranteed strictly
// greater than every stored revision. This is safe and deterministic
// (computed fresh from the actual stored data, every run) and never
// touches a single row of planner data; it only ever moves the
// sequence FORWARD, never backward, and only when it's provably
// behind. See verifySequenceAheadOfStoredRevisions below.
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

class SchemaVerificationError extends Error {}

// The exact schema contract /api/sync/planner's queries (route.ts)
// and db-schema.sql together establish. Every column route.ts reads,
// writes, or relies on a DEFAULT/NOT NULL for is listed — not just
// the columns' names, but the type, nullability, and (where the app
// depends on it) default Postgres must actually enforce.
//
//   - user_planner: ON CONFLICT (user_id, profile_id) requires that
//     exact PRIMARY KEY; `revision` is read/compared as a number and
//     is never supplied on the legacy-migration INSERT path, so it
//     needs its own DEFAULT 0 for that backfill to be well-defined.
//   - user_planner_writes: ON CONFLICT (user_id, profile_id,
//     client_op_id) requires that exact PRIMARY KEY; `status` is
//     compared with `=== "rejected"` (route.ts) so must be TEXT, and
//     every accepted-write INSERT omits `created_at`, so it must
//     default (see db-schema.sql's own ALTER TABLE comments for why
//     `status`'s DEFAULT 'accepted' is what makes a pre-SH.2.5.1 row
//     correctly backfill as accepted).
const TABLE_CONTRACTS = {
  user_planner: {
    columns: [
      { name: "user_id", dataType: "text", notNull: true },
      { name: "profile_id", dataType: "text", notNull: true },
      { name: "planner_json", dataType: "text", notNull: true },
      { name: "updated_at", dataType: "timestamp with time zone", notNull: true, hasDefault: true },
      { name: "revision", dataType: "bigint", notNull: true, hasDefault: true, defaultIncludes: "0" },
    ],
    primaryKey: ["user_id", "profile_id"],
  },
  user_planner_writes: {
    columns: [
      { name: "user_id", dataType: "text", notNull: true },
      { name: "profile_id", dataType: "text", notNull: true },
      { name: "client_op_id", dataType: "text", notNull: true },
      { name: "revision", dataType: "bigint", notNull: true },
      { name: "updated_at", dataType: "timestamp with time zone", notNull: true, hasDefault: true },
      { name: "created_at", dataType: "timestamp with time zone", notNull: true, hasDefault: true },
      { name: "status", dataType: "text", notNull: true, hasDefault: true, defaultIncludes: "accepted" },
    ],
    primaryKey: ["user_id", "profile_id", "client_op_id"],
  },
};

// `guards` ties a sequence to the (table, column) whose stored values
// it must always stay strictly ahead of — see
// verifySequenceAheadOfStoredRevisions below for why name/type/PK
// checks alone can't catch a sequence that's simply behind the data.
const SEQUENCE_CONTRACTS = [
  {
    name: "user_planner_revision_seq",
    guards: { table: "user_planner", column: "revision" },
  },
];

function quoteIdent(id) {
  return `"${String(id).replace(/"/g, '""')}"`;
}

// Resolves `name` exactly the way an UNQUALIFIED reference in
// route.ts (a bare `user_planner`, or `nextval('user_planner_revision_seq')`)
// would resolve on THIS connection — i.e. via `search_path`, using
// Postgres's own `to_regclass`. A same-named table/sequence sitting in
// a schema that isn't on this connection's search_path is invisible
// to `to_regclass`, exactly as it would be invisible to the
// application's own queries, so it can never produce a false pass
// here.
async function resolveRelation(client, name) {
  const { rows } = await client.query(
    `SELECT c.oid::text AS oid, n.nspname AS schema_name, c.relkind AS relkind
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid = to_regclass($1)::oid`,
    [name]
  );
  return rows[0] ?? null;
}

async function verifySequence(client, name) {
  const relation = await resolveRelation(client, name);
  if (!relation) {
    throw new SchemaVerificationError(
      `${name}: not visible on this connection's search_path (to_regclass found nothing) — ` +
        `nextval('${name}') as used by /api/sync/planner would fail`
    );
  }
  if (relation.relkind !== "S") {
    throw new SchemaVerificationError(
      `${name}: resolved to a non-sequence relation (relkind='${relation.relkind}') in schema "${relation.schema_name}" — ` +
        `nextval('${name}') as used by /api/sync/planner would target the wrong object`
    );
  }
  return relation.schema_name;
}

async function verifyTable(client, name, contract) {
  const relation = await resolveRelation(client, name);
  if (!relation) {
    throw new SchemaVerificationError(
      `${name}: not visible on this connection's search_path (to_regclass found nothing) — ` +
        `queries against "${name}" in /api/sync/planner would fail`
    );
  }
  if (relation.relkind !== "r") {
    throw new SchemaVerificationError(
      `${name}: resolved to a non-table relation (relkind='${relation.relkind}') in schema "${relation.schema_name}"`
    );
  }

  const { rows: columnRows } = await client.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2`,
    [relation.schema_name, name]
  );
  const columnsByName = new Map(columnRows.map((row) => [row.column_name, row]));

  for (const col of contract.columns) {
    const actual = columnsByName.get(col.name);
    if (!actual) {
      throw new SchemaVerificationError(
        `${name}.${col.name}: column missing in schema "${relation.schema_name}"`
      );
    }
    if (actual.data_type !== col.dataType) {
      throw new SchemaVerificationError(
        `${name}.${col.name}: expected type "${col.dataType}", found "${actual.data_type}" ` +
          `in schema "${relation.schema_name}"`
      );
    }
    const expectedNullable = col.notNull ? "NO" : "YES";
    if (actual.is_nullable !== expectedNullable) {
      throw new SchemaVerificationError(
        `${name}.${col.name}: expected ${col.notNull ? "NOT NULL" : "nullable"}, ` +
          `found is_nullable="${actual.is_nullable}" in schema "${relation.schema_name}"`
      );
    }
    if (col.hasDefault && actual.column_default == null) {
      throw new SchemaVerificationError(
        `${name}.${col.name}: expected a DEFAULT, found none in schema "${relation.schema_name}"`
      );
    }
    if (col.defaultIncludes && !String(actual.column_default ?? "").includes(col.defaultIncludes)) {
      throw new SchemaVerificationError(
        `${name}.${col.name}: expected DEFAULT to produce '${col.defaultIncludes}', ` +
          `found default "${actual.column_default}" in schema "${relation.schema_name}"`
      );
    }
  }

  if (contract.primaryKey) {
    const { rows: pkRows } = await client.query(
      `SELECT kcu.column_name::text AS column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position`,
      [relation.schema_name, name]
    );
    const actualPk = pkRows.map((row) => row.column_name);
    const expectedPk = contract.primaryKey;
    const matches =
      actualPk.length === expectedPk.length && actualPk.every((col, i) => col === expectedPk[i]);
    if (!matches) {
      throw new SchemaVerificationError(
        `${name}: expected PRIMARY KEY (${expectedPk.join(", ")}), ` +
          `found (${actualPk.join(", ") || "none"}) in schema "${relation.schema_name}" — ` +
          `ON CONFLICT (${expectedPk.join(", ")}) as used by /api/sync/planner would fail`
      );
    }
  }

  return relation.schema_name;
}

// SH.2.5 (Migration Verification Hardening, Codex P1 follow-up) —
// column/type/PK checks alone cannot catch a sequence whose POSITION
// is simply behind the data it's meant to order: `user_planner_writes`
// having the exact right shape says nothing about whether
// `nextval('user_planner_revision_seq')` will return a value greater
// than a `revision` already sitting in `user_planner` — e.g. after the
// sequence (but not the table) was reset, recreated, or restored from
// an older backup. Undetected, the very next accepted write after a
// "successful" migration could assign a LOWER revision than data
// already committed, silently breaking SH.2's monotonic ordering
// contract that /api/sync/planner and syncHelper.ts's
// commitConfirmedBaseline both depend on.
//
// SH.2.5 (Codex P1 follow-up #2) — "next value" is not just
// `last_value + increment`: a non-cycling sequence that has already
// reached its configured MAXVALUE will have Postgres RAISE on the next
// nextval() call rather than return anything. `last_value == seqmax`
// with `is_called == true` looks numerically fine to a naive
// `last_value + increment` calculation but is actually EXHAUSTED — and
// ratcheting toward a stored max revision that itself leaves no
// headroom below seqmax has the exact same failure mode one call
// later. Both are checked against `seqmax` (read once, alongside
// increment/cycle, from the same pg_sequence row) before this function
// ever reports success or attempts a ratchet.
//
// SH.2.5 (Codex P1 follow-up #3) — `CACHE N` (N > 1) lets a Postgres
// BACKEND pre-allocate a whole block of N sequence values locally on
// its first nextval() call, advancing the shared counter by N at once
// but then handing out the REST of that block from local memory on
// later calls from that SAME connection, without consulting the
// shared state again. Because /api/sync/planner runs behind connection
// pooling (route.ts's getPool()), consecutive writes to the SAME
// (user_id, profile_id) — themselves fully serialized by
// pg_advisory_xact_lock, one at a time — can still land on DIFFERENT
// backend connections. If connection A caches [1..10] and returns 1,
// then connection B (a different, later transaction, still for the
// same profile, still strictly after A's commit released the lock)
// caches [11..20] and returns 11, a LATER write that happens to reuse
// connection A can return 2 from its leftover cache — a revision LOWER
// than 11, even though it's chronologically and lock-order AFTER it.
// This is a real monotonicity violation, not a theoretical one, so
// `CACHE 1` (db-schema.sql's own CREATE SEQUENCE never specifies
// CACHE, so it defaults to 1) is required exactly like a positive
// increment or non-cycling — fail loud rather than accept or silently
// alter an unexpected CACHE on an existing production sequence.
//
// `schemaName` is the single schema every SH.2 object already resolved
// to (the caller only reaches this after that ambiguity check passes),
// so both objects are addressed directly rather than re-resolved
// through search_path a second time.
async function verifySequenceAheadOfStoredRevisions(client, schemaName, sequenceName, tableName, columnName) {
  const qualifiedSeq = `${quoteIdent(schemaName)}.${quoteIdent(sequenceName)}`;
  const qualifiedTable = `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;

  // Sequence CONFIGURATION (not position) — read from pg_sequence via
  // the already-resolved oid. A non-positive increment, CYCLE, or a
  // CACHE greater than 1 all mean no amount of ratcheting forward right
  // now can guarantee monotonicity going forward (see the doc above for
  // why CACHE > 1 is unsafe across pooled connections), so those fail
  // outright rather than being "fixed" by setval. `seqmax` is this
  // sequence's hard ceiling — see the function's own doc above for why
  // it must gate both the current position AND any ratchet.
  const { rows: configRows } = await client.query(
    `SELECT seqincrement, seqcycle, seqmax, seqcache
     FROM pg_sequence
     WHERE seqrelid = to_regclass($1)::oid`,
    [`${schemaName}.${sequenceName}`]
  );
  const config = configRows[0];
  if (!config) {
    throw new SchemaVerificationError(
      `${sequenceName}: could not read sequence configuration from pg_sequence in schema "${schemaName}"`
    );
  }
  const increment = BigInt(config.seqincrement);
  if (increment <= 0n) {
    throw new SchemaVerificationError(
      `${sequenceName}: INCREMENT BY ${config.seqincrement} is not a positive step — nextval() would not ` +
        "produce strictly increasing revisions as /api/sync/planner's ordering contract requires"
    );
  }
  if (config.seqcycle) {
    throw new SchemaVerificationError(
      `${sequenceName}: is CYCLE — it can wrap back to a low value after reaching its MAXVALUE, which would ` +
        "eventually violate the monotonic revision contract no matter where it's currently positioned"
    );
  }
  const cache = BigInt(config.seqcache);
  if (cache !== 1n) {
    throw new SchemaVerificationError(
      `${sequenceName}: CACHE is ${config.seqcache}, not 1 — a backend connection can pre-allocate and hand out ` +
        "a whole block of values from local memory without consulting the shared sequence state, which lets a " +
        "later write on a different pooled connection return a LOWER revision than one already committed for " +
        "the same (user_id, profile_id), even though pg_advisory_xact_lock fully serialized them; it must be " +
        "recreated with CACHE 1 (a manual, data-preserving operation — see db-schema.sql) before this database " +
        "can be migrated"
    );
  }
  const seqMax = BigInt(config.seqmax);

  // SH.2.5 (Codex P1 follow-up #4) — everything from here on (reading
  // the CURRENT max stored revision, reading the sequence's CURRENT
  // position, deciding whether to ratchet, and the ratchet itself)
  // must be serialized against every live application writer that
  // could allocate a new revision via nextval() in between — otherwise
  // a writer's INSERT can land between our reads and our setval(),
  // and setval() would then move the sequence BACKWARD relative to a
  // revision that writer just committed (exactly the P1 this responds
  // to).
  //
  // route.ts's writers only take a PER-(user_id, profile_id)
  // pg_advisory_xact_lock — that can't serialize against this
  // function, since a migration run isn't scoped to one profile and
  // `user_planner_revision_seq` is GLOBAL, shared across every
  // profile (see its own doc in db-schema.sql). Inventing a new,
  // separate lock class that route.ts doesn't also take would do
  // nothing — a writer that never acquires it could still race us.
  //
  // Instead this reuses Postgres's own relation locking, which route.ts
  // ALREADY participates in on every write, with zero app-code changes
  // needed: route.ts's only three nextval() calls (route.ts's GET
  // legacy-migration fallback, PUT/POST retry-after-conflict fallback,
  // and the main PUT/POST path) are all inline inside an
  // `INSERT INTO user_planner ... VALUES (..., nextval(...))
  // ON CONFLICT DO UPDATE` statement — and Postgres acquires the
  // ROW EXCLUSIVE lock that statement needs on `user_planner` at
  // executor startup, BEFORE it evaluates the VALUES list (so before
  // nextval() is ever called), not after. Holding `EXCLUSIVE` mode
  // here — which conflicts with ROW EXCLUSIVE but NOT with the plain
  // ACCESS SHARE a read-only `SELECT` takes, so GET /api/sync/planner
  // keeps working — therefore blocks every possible nextval() call on
  // this sequence for as long as we hold it. Under that lock,
  // MAX(user_planner.revision) and the sequence's position are both
  // FROZEN from every other backend's point of view, so the decision
  // computed from them here can never be invalidated by a writer that
  // raced in after we read but before we called setval() — there is no
  // such writer until we commit and release the lock.
  //
  // A writer transaction blocked on this lock is expected to be brief
  // (a single upsert), but this still uses a bounded `lock_timeout`
  // rather than waiting forever: if it can't acquire the lock quickly,
  // that means a writer transaction is unexpectedly long-running or
  // stuck, and this fails loud with a clear FATAL — proposing a
  // drained migration window (no live traffic) as the fallback —
  // rather than hanging the deploy pipeline or, worse, silently
  // skipping the safety check this function exists to provide.
  await client.query("BEGIN");
  try {
    try {
      await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query(`LOCK TABLE ${qualifiedTable} IN EXCLUSIVE MODE`);
    } catch (err) {
      throw new SchemaVerificationError(
        `${sequenceName}: could not acquire an EXCLUSIVE lock on ${tableName} within 15s (${err.message}) — ` +
          "a live writer transaction appears to be long-running or stuck, so this run cannot safely verify " +
          "the sequence's position against concurrent writes; retry once traffic is quiet, or run this " +
          "migration during a drained window (no live application traffic) if that keeps recurring"
      );
    }

    // Effective NEXT value: what nextval() would actually return right
    // now, without consuming it — or `null` if the sequence is
    // EXHAUSTED (nextval() would raise rather than return anything).
    // `is_called = false` is the state right after CREATE SEQUENCE,
    // before its first-ever nextval() — in that state the sequence's
    // own `last_value` (its configured START value) IS the next value
    // nextval() will hand out, and Postgres already guaranteed it's
    // within [MINVALUE, MAXVALUE] at CREATE/setval time, so no bounds
    // check is needed on that branch. Only once `is_called = true`
    // does the NEXT call add `increment` on top of `last_value` — and
    // THAT result must be checked against `seqmax`, since a
    // non-cycling sequence errors instead of wrapping once it would
    // exceed it.
    async function readEffectiveNext() {
      const { rows } = await client.query(`SELECT last_value, is_called FROM ${qualifiedSeq}`);
      const lastValue = BigInt(rows[0].last_value);
      if (!rows[0].is_called) {
        return lastValue;
      }
      const next = lastValue + increment;
      return next > seqMax ? null : next;
    }

    const { rows: maxRows } = await client.query(
      `SELECT COALESCE(MAX(${quoteIdent(columnName)}), 0) AS max_value FROM ${qualifiedTable}`
    );
    const maxStoredRevision = BigInt(maxRows[0].max_value);

    const effectiveNext = await readEffectiveNext();
    if (effectiveNext === null) {
      throw new SchemaVerificationError(
        `${sequenceName}: is exhausted — it has reached its MAXVALUE (${seqMax}) and is not CYCLE, so the next ` +
          "nextval() (as /api/sync/planner issues on every accepted write) would raise an error instead of " +
          "returning a usable revision; it must be recreated with a higher MAXVALUE (a manual, data-preserving " +
          "operation — see db-schema.sql) before this database can be migrated"
      );
    }
    if (effectiveNext > maxStoredRevision) {
      await client.query("COMMIT");
      return { ratcheted: false, effectiveNext, maxStoredRevision };
    }

    // Behind (or equal to) the stored max — ratchet forward, but only
    // if there's still enough headroom below `seqmax` for BOTH the
    // ratchet itself (setval rejects a target outside [seqmin,
    // seqmax]) and the very next nextval() afterward to succeed.
    // Without this check, setval(seq, maxStoredRevision, true) could
    // "succeed" while leaving the sequence exhausted for the next
    // call — relocating exactly the failure this function exists to
    // catch, one call later.
    if (maxStoredRevision + increment > seqMax) {
      throw new SchemaVerificationError(
        `${sequenceName}: cannot be ratcheted to stay ahead of the stored max revision (${maxStoredRevision}) — ` +
          `doing so would leave no headroom below its MAXVALUE (${seqMax}) for the next nextval() to succeed; ` +
          "it must be recreated with a higher MAXVALUE (a manual, data-preserving operation — see db-schema.sql) " +
          "before this database can be migrated"
      );
    }

    // This is deterministic (computed fresh, in this same run, under
    // the EXCLUSIVE lock above, from the actual stored data), touches
    // only the sequence's own internal counter (never a row of
    // `user_planner`), and can only move the sequence FORWARD here:
    // this branch is only reached when effectiveNext <=
    // maxStoredRevision, so setting it to maxStoredRevision is always
    // a forward-or-equal move, never a regression — the guard above
    // already returned early for any sequence that was ahead, and the
    // lock guarantees no concurrent writer could have advanced the
    // sequence or the stored max since we read them.
    await client.query(`SELECT setval($1::regclass, $2, true)`, [
      `${schemaName}.${sequenceName}`,
      maxStoredRevision.toString(),
    ]);

    const postRatchetNext = await readEffectiveNext();
    if (postRatchetNext === null || postRatchetNext <= maxStoredRevision) {
      // Should be unreachable given the headroom check and setval()
      // above — never report success on an unverified assumption.
      throw new SchemaVerificationError(
        `${sequenceName}: ratcheted toward the stored max revision (${maxStoredRevision}) but the next ` +
          (postRatchetNext === null
            ? "nextval() would raise an error (sequence exhausted)"
            : `nextval() would still return ${postRatchetNext}, which is not strictly greater`)
      );
    }

    await client.query("COMMIT");
    return { ratcheted: true, effectiveNext: postRatchetNext, maxStoredRevision };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

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
      const resolvedSchemas = new Map();

      for (const { name: sequenceName } of SEQUENCE_CONTRACTS) {
        const schemaName = await verifySequence(client, sequenceName);
        resolvedSchemas.set(sequenceName, schemaName);
        console.log(`  ok — ${sequenceName} (sequence, schema "${schemaName}")`);
      }

      for (const [tableName, contract] of Object.entries(TABLE_CONTRACTS)) {
        const schemaName = await verifyTable(client, tableName, contract);
        resolvedSchemas.set(tableName, schemaName);
        console.log(`  ok — ${tableName} (${contract.columns.length} columns, PRIMARY KEY (${contract.primaryKey.join(", ")}), schema "${schemaName}")`);
      }

      // Every resolved object should live in the SAME schema — if
      // search_path somehow resolves different SH.2 objects to
      // different schemas, that's exactly the kind of ambiguous setup
      // this script must not silently pass.
      const distinctSchemas = new Set(resolvedSchemas.values());
      if (distinctSchemas.size > 1) {
        const detail = [...resolvedSchemas.entries()].map(([n, s]) => `${n} -> "${s}"`).join(", ");
        throw new SchemaVerificationError(
          `SH.2 objects resolved to more than one schema via this connection's search_path (${detail}) — ` +
            "this is ambiguous and must be resolved before deploying application code"
        );
      }
      const [resolvedSchema] = distinctSchemas;

      // Shape is confirmed — now confirm POSITION: every guarded
      // sequence must be strictly ahead of the stored data it orders.
      // See verifySequenceAheadOfStoredRevisions's own doc for why this
      // is a distinct check from everything above.
      for (const { name: sequenceName, guards } of SEQUENCE_CONTRACTS) {
        if (!guards) continue;
        const result = await verifySequenceAheadOfStoredRevisions(
          client,
          resolvedSchema,
          sequenceName,
          guards.table,
          guards.column
        );
        if (result.ratcheted) {
          console.log(
            `  ratcheted — ${sequenceName} was behind ${guards.table}.${guards.column}'s stored max ` +
              `(${result.maxStoredRevision}); advanced so the next nextval() will return ${result.effectiveNext}`
          );
        } else {
          console.log(
            `  ok — ${sequenceName}'s next value (${result.effectiveNext}) is already greater than ` +
              `${guards.table}.${guards.column}'s stored max (${result.maxStoredRevision})`
          );
        }
      }
    } catch (err) {
      if (err instanceof SchemaVerificationError) {
        console.error(`FATAL: post-migration verification failed — ${err.message}`);
      } else {
        console.error("FATAL: post-migration verification query failed —", err.message);
      }
      console.error(
        "db-schema.sql was applied and committed, but the resulting schema still does not satisfy the SH.2 " +
          "sync contract used by /api/sync/planner. Do NOT deploy SH.2 application code against this " +
          "database until this is resolved — investigate db-schema.sql and this database's current schema. " +
          "This script never destructively alters an incompatible column/constraint to \"fix\" it automatically."
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

-- ============================================================
-- Phase 7.2 — Magic Link Sync: Required database schema
--
-- Fresh database: run this file once against your Neon / Vercel
-- Postgres database.
--
-- Existing (already-deployed) database: do NOT hand-run this file
-- directly against production. Every statement below is written to be
-- safely rerunnable (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT
-- EXISTS) so it never drops or overwrites existing rows, but running
-- it is a schema *migration* against a live database and must go
-- through the SH.2.5 migration entrypoint instead, so fresh setup and
-- existing-database migration can never drift apart:
--
--   DATABASE_URL=... pnpm --filter web run db:migrate
--
-- See apps/web/scripts/migrate-db.mjs for what that runs (this file,
-- inside one transaction, followed by a verification pass) and
-- AGENTS.md's Deployment section for the required production
-- ordering relative to deploying application code.
-- ============================================================

-- NextAuth.js v4 tables (required by @auth/pg-adapter)
CREATE TABLE IF NOT EXISTS verification_token (
  identifier TEXT        NOT NULL,
  expires    TIMESTAMPTZ NOT NULL,
  token      TEXT        NOT NULL,
  PRIMARY KEY (identifier, token)
);

CREATE TABLE IF NOT EXISTS accounts (
  id                  SERIAL PRIMARY KEY,
  "userId"            INTEGER      NOT NULL,
  type                VARCHAR(255) NOT NULL,
  provider            VARCHAR(255) NOT NULL,
  "providerAccountId" VARCHAR(255) NOT NULL,
  refresh_token       TEXT,
  access_token        TEXT,
  expires_at          BIGINT,
  id_token            TEXT,
  scope               TEXT,
  session_state       TEXT,
  token_type          TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id             SERIAL PRIMARY KEY,
  "userId"       INTEGER      NOT NULL,
  expires        TIMESTAMPTZ  NOT NULL,
  "sessionToken" VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255),
  email           VARCHAR(255) UNIQUE,
  "emailVerified" TIMESTAMPTZ,
  image           TEXT
);

-- Custom table: per-user Plans sync blob (Phase 7.2)
CREATE TABLE IF NOT EXISTS user_plans (
  user_id    TEXT        PRIMARY KEY,
  plans_json TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- SH.2 — single global sequence backing the monotonic `revision` column
-- below. A shared sequence across ALL (user_id, profile_id) rows is
-- sufficient: revisions are only ever compared WITHIN one (user,profile)
-- pair, so global uniqueness (a strict superset of what's needed) is fine,
-- and it avoids any per-row counter bookkeeping. `NOW()`/`updated_at`
-- reflects TRANSACTION START time in Postgres, not actual write-execution
-- order, so two writes serialized by the advisory lock in
-- api/sync/planner/route.ts can still commit with a non-monotonic
-- `updated_at` under contention — `revision` (assigned via nextval() at
-- the moment each write actually executes) is what the client uses as the
-- authoritative ordering signal instead (see syncHelper.ts's
-- commitConfirmedBaseline / nextConfirmedBaseline).
CREATE SEQUENCE IF NOT EXISTS user_planner_revision_seq;

-- Custom table: per-user, per-profile planner sync blob (Phase 7.6)
-- Stores the combined Plans + Lightning payload for each (user, profile) pair.
CREATE TABLE IF NOT EXISTS user_planner (
  user_id     TEXT        NOT NULL,
  profile_id  TEXT        NOT NULL,
  planner_json TEXT       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revision    BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, profile_id)
);

-- Idempotent — self-heals a `user_planner` table created before `revision`
-- existed (CREATE TABLE IF NOT EXISTS above is a no-op against an
-- already-deployed table, so this re-runnable ALTER is what actually picks
-- up the new column on an existing database).
ALTER TABLE user_planner ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0;

-- SH.2 (Codex P1, 7th round) — append-only record of accepted writes,
-- keyed by the CLIENT-SUPPLIED opaque operation id (see syncPayload.ts's
-- module doc on server-verifiable write acknowledgment). `user_planner`
-- above stores only the LATEST state per (user, profile) — no history — so
-- a later query against it alone can never distinguish "this write never
-- reached the server" from "this write reached the server, then a newer
-- write superseded it": both look identical (the current row simply
-- doesn't match what was sent). This table exists purely to answer "was
-- client operation X ever accepted", independent of whatever the row looks
-- like now. Populated only when a PUT/POST supplies an optional
-- `clientOpId` query parameter (ordinary pushes that don't pass one are
-- completely unaffected); queried only when a GET supplies a matching
-- `lastOpId` query parameter. `client_op_id` is a client-generated random
-- UUID (crypto.randomUUID() — see registerUnloadSync in syncHelper.ts),
-- NEVER a timestamp and never used for ordering — `revision` (copied from
-- the write that produced it) remains the only ordering signal. ON
-- CONFLICT DO NOTHING at the insert site makes a retried write with the
-- same opId idempotent. Deliberately unbounded/unpruned — see this
-- feature's own round-7 report for the accepted operational tradeoff.
-- Codex P1 fix (8th round) — `updated_at` stores the EXACT `updated_at` the
-- original accepted write produced (copied from user_planner's own
-- RETURNING clause at insert time), NOT a re-read of user_planner's
-- CURRENT value. This is what lets a duplicate delivery of the same
-- client_op_id (handleWrite in route.ts, checked under the SAME
-- per-(user,profile) advisory lock as the write itself, BEFORE any merge/
-- upsert runs) return the ORIGINAL accepted {updatedAt, revision} result
-- without touching user_planner again — by the time a duplicate arrives,
-- user_planner may already reflect a newer write, so re-reading it would
-- return the WRONG (newer, unrelated) result for what is supposed to be a
-- pure idempotent replay of THIS specific operation.
CREATE TABLE IF NOT EXISTS user_planner_writes (
  user_id       TEXT        NOT NULL,
  profile_id    TEXT        NOT NULL,
  client_op_id  TEXT        NOT NULL,
  revision      BIGINT      NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, profile_id, client_op_id)
);

-- Idempotent self-heal — same rationale as user_planner's own `revision`
-- backfill above: picks up `updated_at` on a table created by round 7,
-- before this column existed, on an already-deployed database.
ALTER TABLE user_planner_writes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- SH.2.5.1 — Stale First-Delivery Operation Rejection: distinguishes an
-- ACCEPTED write (the only outcome this table recorded before this column
-- existed — every pre-existing row is correctly backfilled 'accepted' by
-- the DEFAULT below) from a durably-recorded STALE REJECTION, where a
-- first-delivery operation's own `baseRevision` did not match this
-- (user_id, profile_id) row's actual revision at the moment it was
-- evaluated (see api/sync/planner/route.ts's handleWrite and
-- evaluateOperationBaseRevision in syncPayload.ts for the full contract).
-- For a 'rejected' row, `revision` holds the CURRENT row revision as
-- observed at rejection time (informational — never this operation's own
-- base, which was rejected precisely because it did NOT match), not a
-- revision this operation produced. This is the minimal additive column
-- that lets a later `lastOpId` GET lookup answer "was this exact operation
-- ever accepted OR definitively, permanently rejected" — the third,
-- deterministic status a client needs to retire a stale operation without
-- treating it as an unresolved/uncertain outcome (see lookupOpStatus's own
-- doc) — without introducing a second ledger table or a new ordering
-- system alongside the existing `revision` sequence.
ALTER TABLE user_planner_writes ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'accepted';

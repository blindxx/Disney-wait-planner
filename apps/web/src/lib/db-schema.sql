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

-- SH.4.1 — durable, account-wide profile registry (see AGENTS.md's Sync
-- Hardening section and the SH.4 architecture audit it references).
-- Deliberately independent of user_planner/user_planner_writes above: this
-- table stores profile IDENTITY METADATA ONLY (id + display name), never
-- planner content, and carries no revision/pending-op ledger of its own —
-- see api/sync/profiles/route.ts's own doc for why a plain per-row
-- last-write-wins (`updated_at`, server-assigned via NOW(), never a
-- client-supplied timestamp) is sufficient here and a planner-grade
-- conflict system would be the wrong tool. `profile_id` values are the
-- SAME ids `user_planner`/`user_planner_writes` key planner content by
-- (validated with the identical PROFILE_ID_RE — see syncIdentity.ts) but
-- this table has no foreign key to them: a profile row here is pure
-- metadata about an id that may or may not have planner content yet.
-- `deleted_at` is a soft-delete tombstone — SH.4.1 only ever reads it (to
-- stop legacy adoption from resurrecting a deleted id); no code path in
-- SH.4.1 sets it yet (that lifecycle is SH.4.3 scope).
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id     TEXT        NOT NULL,
  profile_id  TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  PRIMARY KEY (user_id, profile_id)
);

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

-- Phase 12.10.2A — durable ThemeParks.wiki REGULAR (OPERATING) park hours.
-- Server-side cache of verified provider hours that survives redeploys and
-- serverless instance recycling (see lib/parkHoursStore.ts for the write
-- contract). One row per park + resort-local calendar date; `windows` holds
-- every verified OPERATING window for that date (a date can have several, and
-- an overnight window closes after midnight but stays dated by its opening
-- day) as [{"opens": <UTC ISO>, "closes": <UTC ISO>}], ascending.
-- Only dates the provider positively listed are stored: a missing date is
-- never recorded as closed, and the CHECK below makes an empty window set
-- impossible. `coverage` records how the date's complete entry set was
-- obtained ('default_window' = the provider's upcoming window, 'month' = a
-- monthly request). `source_fetched_at` is when the provider response was
-- fetched; the writer only ever replaces a row with a strictly newer fetch.
-- `windows_hash` lets the writer skip no-op rewrites. `verified_at` is when
-- DWP last wrote the row. Rolling 7-day history is enforced by the writer
-- deleting rows dated before (resort-local today - 7 days). Not user data;
-- no user_id and no relation to planner/profile tables.
CREATE TABLE IF NOT EXISTS park_regular_hours (
  park_id               TEXT        NOT NULL,
  hours_date            DATE        NOT NULL,
  windows               JSONB       NOT NULL,
  windows_hash          TEXT        NOT NULL,
  coverage              TEXT        NOT NULL,
  source_fetched_at     TIMESTAMPTZ NOT NULL,
  provider_last_updated TIMESTAMPTZ,
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (park_id, hours_date),
  CONSTRAINT park_regular_hours_windows_nonempty
    CHECK (jsonb_typeof(windows) = 'array' AND jsonb_array_length(windows) > 0)
);

CREATE INDEX IF NOT EXISTS park_regular_hours_hours_date_idx ON park_regular_hours (hours_date);

-- ============================================================
-- Phase 14.5C — Active Entertainment Lifecycle (lib/entertainmentLifecycleStore.ts)
--
-- Server-side automated hiding/resurfacing of active regular/limited
-- entertainment. Written ONLY by the scheduled monitor
-- (/api/cron/entertainment-lifecycle); read by /api/entertainment/{showtimes,all}
-- and /api/catalog/lifecycle-audit. Failure to read them NEVER hides anything
-- (readers fail open); there is no other fallback, so migrate before deploy.
--
-- show_key = entertainmentMappingKey(park, CANONICAL name) — one row per canonical
-- show, so provider edition renames (e.g. World of Color – ONE) never fork identity.
-- ============================================================

-- One row per (show, resort-local date): the strongest class observed that day.
-- day_class: active | inactive | dormant | silent | unknown. class_rank (unknown 0 <
-- silent 1 < dormant 2 < inactive 3 < active 4) plus is_final makes upserts
-- order-independent and idempotent: active never gets replaced; a final row
-- replaces a provisional one; otherwise the stronger class wins. is_final = a
-- negative class observed in the resort-local end-of-day window (or active).
CREATE TABLE IF NOT EXISTS entertainment_lifecycle_evidence (
  park_id           TEXT        NOT NULL,
  show_key          TEXT        NOT NULL,
  local_date        DATE        NOT NULL,
  show_name         TEXT        NOT NULL,
  day_class         TEXT        NOT NULL,
  class_rank        SMALLINT    NOT NULL,
  is_final          BOOLEAN     NOT NULL DEFAULT TRUE,
  basis             TEXT,
  performance_count INTEGER     NOT NULL DEFAULT 0,
  source            TEXT        NOT NULL,
  limitations       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observation_count INTEGER     NOT NULL DEFAULT 1,
  PRIMARY KEY (park_id, show_key, local_date),
  CONSTRAINT entertainment_lifecycle_evidence_class_chk
    CHECK (day_class IN ('active', 'inactive', 'dormant', 'silent', 'unknown'))
);

-- Idempotent upgrades for a database that applied the first 14.5C revision.
ALTER TABLE entertainment_lifecycle_evidence ADD COLUMN IF NOT EXISTS is_final BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE entertainment_lifecycle_evidence DROP CONSTRAINT IF EXISTS entertainment_lifecycle_evidence_class_chk;
ALTER TABLE entertainment_lifecycle_evidence ADD CONSTRAINT entertainment_lifecycle_evidence_class_chk
  CHECK (day_class IN ('active', 'inactive', 'dormant', 'silent', 'unknown'));

CREATE INDEX IF NOT EXISTS entertainment_lifecycle_evidence_date_idx
  ON entertainment_lifecycle_evidence (local_date);

-- Current lifecycle state per canonical show (visibility + active-cycle reset + audit flag).
CREATE TABLE IF NOT EXISTS entertainment_lifecycle_state (
  park_id                TEXT        NOT NULL,
  show_key               TEXT        NOT NULL,
  show_name              TEXT        NOT NULL,
  status                 TEXT        NOT NULL DEFAULT 'visible',
  cycle_reset_date       DATE,
  last_active_date       DATE,
  hidden_local_date      DATE,
  hidden_at              TIMESTAMPTZ,
  restored_at            TIMESTAMPTZ,
  hide_count             INTEGER     NOT NULL DEFAULT 0,
  restore_count          INTEGER     NOT NULL DEFAULT 0,
  inactive_days          INTEGER     NOT NULL DEFAULT 0,
  dormant_days           INTEGER     NOT NULL DEFAULT 0,
  silent_days            INTEGER     NOT NULL DEFAULT 0,
  silence_flagged_at     TIMESTAMPTZ,
  registry_restored_at   TIMESTAMPTZ,
  secondary_evaluated_on DATE,
  audit_flag             TEXT,
  evaluated_local_date   DATE,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (park_id, show_key),
  CONSTRAINT entertainment_lifecycle_state_status_chk
    CHECK (status IN ('visible', 'auto_hidden', 'legacy_comeback', 'legacy_hidden'))
);

ALTER TABLE entertainment_lifecycle_state ADD COLUMN IF NOT EXISTS dormant_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entertainment_lifecycle_state ADD COLUMN IF NOT EXISTS registry_restored_at TIMESTAMPTZ;
-- Phase 14.5D: legacy comeback statuses (idempotent widening of the status check).
ALTER TABLE entertainment_lifecycle_state DROP CONSTRAINT IF EXISTS entertainment_lifecycle_state_status_chk;
ALTER TABLE entertainment_lifecycle_state ADD CONSTRAINT entertainment_lifecycle_state_status_chk
  CHECK (status IN ('visible', 'auto_hidden', 'legacy_comeback', 'legacy_hidden'));

-- Append-only decisions for the later research audit: auto_hide, auto_restore,
-- silence_flag, registry_restore, registry_conflict, legacy_comeback, legacy_rehide, legacy_identity_discovered/_change/_candidate (14.5D). The natural key makes a duplicated cron
-- delivery a no-op. audit_status is advanced only by the audit (never here).
CREATE TABLE IF NOT EXISTS entertainment_lifecycle_events (
  park_id             TEXT        NOT NULL,
  show_key            TEXT        NOT NULL,
  event_type          TEXT        NOT NULL,
  local_date          DATE        NOT NULL,
  show_name           TEXT        NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence            JSONB       NOT NULL,
  coverage_limitations JSONB      NOT NULL DEFAULT '[]'::jsonb,
  audit_status        TEXT        NOT NULL DEFAULT 'unreviewed',
  PRIMARY KEY (park_id, show_key, event_type, local_date)
);

CREATE INDEX IF NOT EXISTS entertainment_lifecycle_events_audit_idx
  ON entertainment_lifecycle_events (audit_status, occurred_at);

-- Phase 14.5D follow-up: provider SHOW identities automatically discovered for LEGACY catalog shows
-- (validated by exact normalized canonical name/approved alias + park + SHOW type + ownership checks).
-- One validated row per (park, show) and per (park, entity); a replaced identity is kept as 'superseded'.
CREATE TABLE IF NOT EXISTS entertainment_legacy_identity (
  park_id              TEXT        NOT NULL,
  show_key             TEXT        NOT NULL,
  show_name            TEXT        NOT NULL,
  entity_id            TEXT        NOT NULL,
  entity_type          TEXT        NOT NULL DEFAULT 'SHOW',
  provider_name        TEXT        NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'validated',
  first_validated_date DATE        NOT NULL,
  validated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at        TIMESTAMPTZ,
  PRIMARY KEY (park_id, show_key, entity_id),
  CONSTRAINT entertainment_legacy_identity_status_chk CHECK (status IN ('validated', 'superseded')),
  CONSTRAINT entertainment_legacy_identity_type_chk CHECK (entity_type = 'SHOW')
);

CREATE UNIQUE INDEX IF NOT EXISTS entertainment_legacy_identity_show_uidx
  ON entertainment_legacy_identity (park_id, show_key) WHERE status = 'validated';
CREATE UNIQUE INDEX IF NOT EXISTS entertainment_legacy_identity_entity_uidx
  ON entertainment_legacy_identity (park_id, entity_id) WHERE status = 'validated';


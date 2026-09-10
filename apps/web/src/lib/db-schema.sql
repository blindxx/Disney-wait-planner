-- ============================================================
-- Phase 7.2 — Magic Link Sync: Required database schema
-- Run this once against your Neon / Vercel Postgres database.
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

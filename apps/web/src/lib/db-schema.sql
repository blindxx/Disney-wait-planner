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

-- Custom table: per-user, per-profile planner sync blob (Phase 7.6)
-- Stores the combined Plans + Lightning payload for each (user, profile) pair.
-- Run: ALTER TABLE user_planner ... if migrating an existing deployment.
CREATE TABLE IF NOT EXISTS user_planner (
  user_id     TEXT        NOT NULL,
  profile_id  TEXT        NOT NULL,
  planner_json TEXT       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, profile_id)
);

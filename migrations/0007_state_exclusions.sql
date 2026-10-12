-- State Medicaid exclusion lists — added 2026-09-15.
--
-- Deliberately a SEPARATE table from `exclusions`, not new rows in it.
-- v1's buildCandidateQuery/classify only ever reference `exclusions`, so v1
-- responses cannot see a state row by construction — no runtime filter to
-- remember, no clause to forget (see docs/SOURCES.md's own incident history
-- on exactly that failure shape). Only the v2-only code path in index.ts
-- queries this table.
--
-- Column shape mirrors `exclusions` closely on purpose, so state rows can be
-- classified by the SAME classify() in match.ts without a translation layer:
-- state records carry no npi/dob (verified against the source — CFAI's own
-- G1 measurement confirmed 0% NPI/DOB fill across all 17 state lists), and
-- have no first/last split (the export ships one already-assembled `name`
-- field), so those columns are simply empty rather than absent.

CREATE TABLE IF NOT EXISTS state_exclusions (
  id              TEXT PRIMARY KEY,       -- "{source}:{cfai_record_id}"
  source          TEXT NOT NULL,          -- e.g. 'ca_medicaid_exclusion'
  state           TEXT NOT NULL,          -- which state's OWN list this is
  name            TEXT NOT NULL,          -- already-assembled: org name, or
                                           -- "FIRST MIDDLE LAST" for a person
  is_person       INTEGER NOT NULL,       -- 0/1
  npi             TEXT NOT NULL DEFAULT '', -- always '' today; column kept
                                           -- for classify()'s ExclusionRow
                                           -- shape and in case a state ever
                                           -- publishes one
  excl_date       TEXT,
  source_url      TEXT,
  as_of           TEXT NOT NULL,          -- this SOURCE's own list date, from
                                           -- the export manifest
  refresh         TEXT NOT NULL,          -- 'daily' | 'manual' — drives the
                                           -- "not currently refreshing" wording
  -- normalized search keys, computed at import time exactly like `exclusions`
  n_name          TEXT NOT NULL,          -- normalizeName() for a person
  n_bus           TEXT NOT NULL,          -- normalizeBusiness() for an org
  gen             TEXT NOT NULL,          -- generation token, see state_import.ts
  loaded_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_excl_n_name ON state_exclusions(n_name) WHERE n_name <> '';
CREATE INDEX IF NOT EXISTS idx_state_excl_n_bus  ON state_exclusions(n_bus)  WHERE n_bus <> '';
CREATE INDEX IF NOT EXISTS idx_state_excl_state  ON state_exclusions(state);
CREATE INDEX IF NOT EXISTS idx_state_excl_gen    ON state_exclusions(gen);

-- Per-source coverage, read by the honesty surface (the sources page / MCP
-- sources tool) — never derived from COUNT(*) on state_exclusions itself.
CREATE TABLE IF NOT EXISTS state_source_meta (
  source    TEXT PRIMARY KEY,
  state     TEXT NOT NULL,
  as_of     TEXT NOT NULL,
  refresh   TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  gen       TEXT NOT NULL
);

-- Generation bookkeeping for the resumable importer, same shape as booth #3's
-- `imports` table.
CREATE TABLE IF NOT EXISTS state_imports (
  gen         TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  sha256      TEXT NOT NULL,
  records     INTEGER NOT NULL,
  ticks       INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL,              -- 'running' | 'done' | 'failed'
  note        TEXT
);

-- Small key/value bookkeeping for the resumable importer's in-flight state
-- (pending_gen, pending_offset, active_sha, ...). Same shape and purpose as
-- booth #3's `meta` table; named separately here since this is a distinct
-- table in a distinct D1 database, not a shared one.
CREATE TABLE IF NOT EXISTS state_import_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

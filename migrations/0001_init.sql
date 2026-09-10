-- CF Exclusion Check — initial schema.
--
-- Column names mirror the LEIE CSV header read from the live file on
-- 2026-09-10 (LASTNAME,FIRSTNAME,MIDNAME,BUSNAME,GENERAL,SPECIALTY,UPIN,NPI,
-- DOB,ADDRESS,CITY,STATE,ZIP,EXCLTYPE,EXCLDATE,REINDATE,WAIVERDATE,WVRSTATE)
-- rather than being assumed.
--
-- Normalized columns are stored, not computed at query time, so lookups hit an
-- index. The D1 free plan allows 100 bound parameters per query, so inserts are
-- batched a few rows at a time.

CREATE TABLE IF NOT EXISTS exclusions (
  id              TEXT PRIMARY KEY,       -- deterministic hash of the source row
  source          TEXT NOT NULL,          -- 'leie' | 'sam'
  last_name       TEXT,
  first_name      TEXT,
  mid_name        TEXT,
  bus_name        TEXT,
  general         TEXT,
  specialty       TEXT,
  upin            TEXT,
  npi             TEXT,                   -- '' when absent; LEIE writes 0000000000
  dob             TEXT,                   -- YYYYMMDD or ''
  address         TEXT,
  city            TEXT,
  state           TEXT,
  zip             TEXT,
  excl_type       TEXT,
  excl_date       TEXT,                   -- YYYYMMDD
  reinstate_date  TEXT,                   -- YYYYMMDD, '' when none
  waiver_date     TEXT,
  waiver_state    TEXT,
  -- normalized search keys
  n_last          TEXT,
  n_first         TEXT,
  n_full          TEXT,                   -- "LAST FIRST"
  n_bus           TEXT,
  load_id         TEXT NOT NULL,          -- mark-and-sweep token
  raw_json        TEXT,
  loaded_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_excl_n_last  ON exclusions(n_last);
CREATE INDEX IF NOT EXISTS idx_excl_n_full  ON exclusions(n_full);
CREATE INDEX IF NOT EXISTS idx_excl_n_bus   ON exclusions(n_bus);
CREATE INDEX IF NOT EXISTS idx_excl_npi     ON exclusions(npi) WHERE npi <> '' AND npi <> '0000000000';
CREATE INDEX IF NOT EXISTS idx_excl_state   ON exclusions(state);
CREATE INDEX IF NOT EXISTS idx_excl_load    ON exclusions(source, load_id);

-- One row per completed load, so /v1/health can report provenance.
CREATE TABLE IF NOT EXISTS loads (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  loaded_at   TEXT NOT NULL,
  row_count   INTEGER NOT NULL,
  sha256      TEXT,
  status      TEXT NOT NULL,              -- 'in_progress' | 'complete' | 'failed'
  note        TEXT
);

-- Cursor for the chunked loader. The free plan cannot load 78k rows in one
-- invocation, so a load advances a byte offset across many invocations.
CREATE TABLE IF NOT EXISTS load_cursor (
  source        TEXT PRIMARY KEY,
  load_id       TEXT NOT NULL,
  byte_offset   INTEGER NOT NULL,
  rows_done     INTEGER NOT NULL,
  total_bytes   INTEGER,
  carry         TEXT,                     -- partial trailing line from the last chunk
  started_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  status        TEXT NOT NULL             -- 'running' | 'done' | 'failed'
);

-- Audit log. IPs are hashed with a secret salt; raw IPs are never stored.
CREATE TABLE IF NOT EXISTS requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  path        TEXT NOT NULL,
  ip_hash     TEXT,
  ua          TEXT,
  query_hash  TEXT,
  paid        INTEGER NOT NULL DEFAULT 0,
  price       TEXT,
  tx_ref      TEXT,
  status      INTEGER,
  ms          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_req_ts   ON requests(ts);
CREATE INDEX IF NOT EXISTS idx_req_ip   ON requests(ip_hash, ts);

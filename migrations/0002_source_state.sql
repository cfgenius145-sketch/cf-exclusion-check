-- Replace the byte-offset cursor with a freshness-probe table.
--
-- load_cursor was designed for a chunked loader that would walk UPDATED.csv a
-- byte range at a time across many cron invocations. That design is dead:
-- oig.hhs.gov does NOT honour Range requests (a `Range: bytes=1000000-1010239`
-- request returns HTTP 200 with all 15,608,468 bytes and no accept-ranges or
-- content-range header), so every invocation would have to download the whole
-- 15.6MB file — which alone exceeds the free plan's 10ms CPU per invocation.
--
-- Keeping an unused cursor table would imply a refresh capability this
-- deployment does not have, so it is dropped. What the cron CAN do on the free
-- plan is the small monthly supplements plus a cheap HEAD freshness probe;
-- source_state records the probe so /v1/health can report honestly when a bulk
-- reseed is due.

DROP TABLE IF EXISTS load_cursor;

CREATE TABLE IF NOT EXISTS source_state (
  source                  TEXT PRIMARY KEY,
  upstream_last_modified  TEXT,     -- Last-Modified header seen upstream
  upstream_bytes          INTEGER,  -- Content-Length seen upstream
  seeded_last_modified    TEXT,     -- what the loaded generation was built from
  checked_at              TEXT NOT NULL,
  reseed_due              INTEGER NOT NULL DEFAULT 0,
  note                    TEXT
);

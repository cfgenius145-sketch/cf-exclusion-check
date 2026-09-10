-- Per-file progress for the monthly supplement merge.
--
-- Why a cursor is needed here when it was useless for the active list: the
-- 200-row exclusion supplement needs 67 D1 queries to write (27 columns means
-- at most 3 rows per query under D1's 100-bound-parameter limit), which is past
-- the 50-queries-per-invocation ceiling. A row-offset cursor solves it because
-- the supplement is only ~38KB, so re-fetching it on each invocation is cheap.
-- The same trick could not rescue UPDATED.csv: that file is 15.6MB and
-- oig.hhs.gov ignores Range requests, so each invocation would have to download
-- all of it.
--
-- status: 'running' — partially merged, more rows to go
--         'done'    — fully merged
--         'absent'  — 404 upstream; a month's supplement is published during
--                     the following month, so this is normal and retried

CREATE TABLE IF NOT EXISTS supplement_progress (
  url         TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  rows_done   INTEGER NOT NULL DEFAULT 0,
  total_rows  INTEGER,
  status      TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  note        TEXT
);

-- Make NPI lookups use an index.
--
-- 0001 created:
--   CREATE INDEX idx_excl_npi ON exclusions(npi)
--     WHERE npi <> '' AND npi <> '0000000000';
--
-- SQLite only uses a PARTIAL index when the query's WHERE clause provably
-- implies the index predicate. `WHERE npi = ?` with a bound parameter does not,
-- so every NPI lookup fell back to a full table scan:
--
--   EXPLAIN QUERY PLAN SELECT id FROM exclusions WHERE npi = '1477537496'
--   -> SCAN exclusions                       (83,975 rows)
--   vs the name lookups, which were already fine:
--   -> SEARCH exclusions USING INDEX idx_excl_n_full (n_full=?)
--
-- This was not merely slow. D1's free plan allows 5,000,000 row reads per day,
-- so at ~84k rows per NPI query the service could serve roughly 59 paid calls a
-- day before D1 began refusing reads with:
--   "Your account has exceeded D1's free tier daily row read limit."
-- which surfaced as a 500 on a request whose payment had already succeeded —
-- the worst possible failure mode, since the caller pays and gets nothing.
--
-- The partial predicate was also pointless: the loader normalizes absent NPIs
-- to '' before insert (see normalizeNpi), so '0000000000' never reaches the
-- column, and rows with '' simply cluster harmlessly at one end of a full index.

DROP INDEX IF EXISTS idx_excl_npi;

CREATE INDEX IF NOT EXISTS idx_excl_npi ON exclusions(npi);

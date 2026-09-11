-- SAM.gov exclusions as a second source.
--
-- SAM records carry identifiers LEIE does not: a 12-character UEI (ueiSAM) and
-- a 5-character CAGE code. Each is a registry-assigned unique identifier, so an
-- equality hit on one is as strong a signal for an organisation as an NPI hit is
-- for a person. They get indexed columns rather than being buried in raw_json,
-- where they could not be matched on.
--
-- DUNS is stored but NOT indexed. The extract was measured before deciding:
-- dnbOpenData is populated on 0 of 168,452 records (0.0%). An index over a
-- column that is empty in every row is pure write cost for zero lookups.
--
-- SAM also distinguishes things LEIE has no equivalent for, all of which change
-- what an answer means:
--   classification  Individual | Firm | Vessel | Special Entity Designation
--   exclusion_type  e.g. "Ineligible (Proceedings Complete)"
--   program         Reciprocal | NonProcurement | Procurement
--   agency          the excluding agency (code and name)
--   record_status   Active | Inactive
--
-- Dates arrive as MM-DD-YYYY and are normalized to YYYYMMDD to match the LEIE
-- columns, so one comparison works across both sources.
--
-- Columns are added to the existing table rather than given a second table,
-- because a query has to search both sources at once and a UNION across two
-- tables would reintroduce the compound-SELECT ceiling (D1 caps a compound
-- SELECT at 5 terms) that migration 0004 exists to avoid.

ALTER TABLE exclusions ADD COLUMN uei            TEXT;
ALTER TABLE exclusions ADD COLUMN cage           TEXT;
ALTER TABLE exclusions ADD COLUMN duns           TEXT;
ALTER TABLE exclusions ADD COLUMN classification TEXT;
ALTER TABLE exclusions ADD COLUMN program        TEXT;
ALTER TABLE exclusions ADD COLUMN agency_code    TEXT;
ALTER TABLE exclusions ADD COLUMN agency_name    TEXT;
ALTER TABLE exclusions ADD COLUMN record_status  TEXT;
-- SAM's terminationDate is NOT LEIE's reinstatement date and must not share a
-- column with it. LEIE's reinstate_date means "this person was reinstated";
-- SAM's terminationDate is when the exclusion is scheduled to end, frequently a
-- far-future placeholder (year 2227 is used for indefinite). Folding the two
-- together would make indefinitely excluded entities look reinstated.
ALTER TABLE exclusions ADD COLUMN termination_date TEXT;
ALTER TABLE exclusions ADD COLUMN country        TEXT;

-- PARTIAL indexes on the sparse identifier columns, and the queries in
-- src/match.ts carry the matching predicate explicitly.
--
-- Migration 0004 dropped a partial index because `WHERE npi = ?` with a bound
-- parameter does not imply the index predicate, so SQLite ignored it and
-- full-scanned. The missing half of that story is that adding the predicate to
-- the QUERY restores it. Verified:
--
--   WHERE npi = ?                    -> SCAN t
--   WHERE npi = ? AND npi <> ''      -> SEARCH t USING INDEX ... (npi=?)
--   ...and it composes inside MULTI-INDEX OR.
--
-- This matters for more than tidiness. On the free plan every index entry is a
-- separate row write against a 100,000/day ceiling, and a partial index writes
-- no entry for a row that fails its predicate. Across the 168,452 SAM records
-- these identifiers are populated on 28.3% (uei), 11.7% (npi) and 0.3% (cage),
-- so partial indexes avoid roughly 420,000 pointless index writes.
DROP INDEX IF EXISTS idx_excl_npi;
CREATE INDEX IF NOT EXISTS idx_excl_npi  ON exclusions(npi)  WHERE npi  <> '';
CREATE INDEX IF NOT EXISTS idx_excl_uei  ON exclusions(uei)  WHERE uei  <> '';
CREATE INDEX IF NOT EXISTS idx_excl_cage ON exclusions(cage) WHERE cage <> '';

-- The name indexes become partial for the same reason: a SAM individual has no
-- business name and a SAM firm has no surname, so roughly one in five rows
-- would otherwise write a useless empty-string entry into each name index.
DROP INDEX IF EXISTS idx_excl_n_last;
DROP INDEX IF EXISTS idx_excl_n_full;
DROP INDEX IF EXISTS idx_excl_n_bus;
CREATE INDEX IF NOT EXISTS idx_excl_n_last ON exclusions(n_last) WHERE n_last <> '';
CREATE INDEX IF NOT EXISTS idx_excl_n_full ON exclusions(n_full) WHERE n_full <> '';
CREATE INDEX IF NOT EXISTS idx_excl_n_bus  ON exclusions(n_bus)  WHERE n_bus  <> '';

-- Never queried, and each one costs a row write on every insert.
-- state is applied in classify() after the rows come back, not in SQL.
DROP INDEX IF EXISTS idx_excl_state;

-- Tracks a multi-day load. The full SAM extract is 168,452 rows; with index
-- writes that is far more than the free plan's 100,000 row writes per day, so
-- the load is resumable and advances a slice at a time. Until it completes,
-- /v1/health and every screening response must say so: a "no match" against a
-- partially loaded exclusion source is not a clearance.
CREATE TABLE IF NOT EXISTS source_load_progress (
  source        TEXT PRIMARY KEY,
  rows_done     INTEGER NOT NULL DEFAULT 0,
  rows_expected INTEGER,
  status        TEXT NOT NULL,          -- 'partial' | 'complete'
  updated_at    TEXT NOT NULL,
  note          TEXT
);

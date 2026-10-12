-- State delisting signal columns — added 2026-09-18.
--
-- CFAI's state_delisting_signal (entities_master.db) records when a
-- previously-held state Medicaid exclusion url stops appearing in a daily
-- fetch. It is a durable archive on the CFAI side, not something this
-- booth deletes or edits rows over — these two columns just carry the
-- OPEN-signal fields (reappeared_at IS NULL) through the export so
-- state_match.ts can apply its own confidence threshold before treating an
-- absence as a possible-reinstatement signal. See state_match.ts's
-- toExclusionRow() and match.ts's ExclusionRow.possible_reinstatement.
--
-- Never used to clear a match: state_exclusions rows are never deleted for
-- this reason, and classify()/isCurrentlyExcluded() are untouched by this
-- migration. A state hit is still always reported.

ALTER TABLE state_exclusions ADD COLUMN delist_first_missing TEXT NOT NULL DEFAULT '';
ALTER TABLE state_exclusions ADD COLUMN delist_times_missing INTEGER NOT NULL DEFAULT 0;

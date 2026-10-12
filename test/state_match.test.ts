import { describe, expect, it } from "vitest";
import { isCurrentlyExcluded } from "../src/match";
import { toExclusionRow, type StateExclusionRow } from "../src/state_match";

/** Fixture: a real state-list row shape (person, no NPI/DOB). */
const baseRow: StateExclusionRow = {
  id: "nd_medicaid_exclusion:1",
  source: "nd_medicaid_exclusion",
  state: "ND",
  name: "Aaker, Debhanna",
  is_person: 1,
  npi: "",
  excl_date: "2024-03-07",
  source_url: "https://www.hhs.nd.gov/...#si=abc",
  as_of: "2026-09-18",
  refresh: "daily",
  delist_first_missing: "",
  delist_times_missing: 0,
};

describe("toExclusionRow — state delisting tier", () => {
  it("carries no possible_reinstatement when the record has never gone missing", () => {
    const row = toExclusionRow(baseRow);
    expect(row.possible_reinstatement).toBeNull();
  });

  it("stays null below the 3-consecutive-miss threshold (1 and 2 misses)", () => {
    for (const times of [1, 2]) {
      const row = toExclusionRow({
        ...baseRow,
        delist_first_missing: "2026-09-18 00:14:08",
        delist_times_missing: times,
      });
      expect(row.possible_reinstatement).toBeNull();
    }
  });

  it("sets possible_reinstatement once times_missing reaches the threshold", () => {
    const row = toExclusionRow({
      ...baseRow,
      delist_first_missing: "2026-09-15 05:15:03",
      delist_times_missing: 3,
    });
    expect(row.possible_reinstatement).toEqual({
      first_missing_at: "2026-09-15 05:15:03",
      times_missing: 3,
    });
  });

  it("never flips reinstate_date, so isCurrentlyExcluded() still reports true", () => {
    const row = toExclusionRow({
      ...baseRow,
      delist_first_missing: "2026-09-01 05:15:00",
      delist_times_missing: 17,
    });
    expect(row.reinstate_date).toBeNull();
    expect(row.possible_reinstatement).not.toBeNull();
    // The core guarantee: a heavily-missing state record is annotated, but
    // the match is never auto-cleared.
    expect(isCurrentlyExcluded(row)).toBe(true);
  });
});

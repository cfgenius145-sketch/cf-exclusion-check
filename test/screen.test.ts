import { describe, expect, it } from "vitest";
import { classify, type ExclusionRow } from "../src/match";
import { verdictOf } from "../src/screen";

const active: ExclusionRow = {
  id: "a1", source: "leie",
  last_name: "SMITH", first_name: "JOHN", mid_name: "A", bus_name: "",
  general: "NURSE", specialty: "REGISTERED NURSE",
  npi: "1234567893", dob: "19700115",
  city: "AUSTIN", state: "TX", zip: "78701",
  excl_type: "1128a1", excl_date: "20180501",
  reinstate_date: "", waiver_date: "", waiver_state: "",
};

/** A reinstatement-supplement row: matched, but no longer excluded. */
const reinstated: ExclusionRow = {
  ...active,
  id: "r1", source: "leie_rein",
  last_name: "ALLEN", first_name: "TAMEKA", mid_name: "BENAY",
  npi: "", dob: "19790919", state: "FL",
  excl_date: "20110620", reinstate_date: "20260811",
};

describe("verdicts", () => {
  it("no match at all is no_match", () => {
    expect(verdictOf([])).toBe("no_match");
  });

  it("a confident match on an active record is excluded", () => {
    expect(verdictOf(classify([active], { name: "John Smith" }))).toBe("excluded");
  });

  it("a confident match on a reinstated record is reinstated_only, not excluded", () => {
    const m = classify([reinstated], { name: "Tameka Allen" });
    expect(m[0].confidence).toBe("match");
    expect(verdictOf(m)).toBe("reinstated_only");
  });

  it("a weak match alone is only possible_match, never excluded", () => {
    const m = classify([active], { name: "Jared Smith" });
    expect(m[0].confidence).toBe("weak");
    expect(verdictOf(m)).toBe("possible_match");
  });

  it("an active record outranks a reinstated one in the same result set", () => {
    const both = classify([reinstated, active], { name: "Smith, John" });
    expect(verdictOf(both)).toBe("excluded");
  });

  it("reinstated_only is reported rather than hidden as no_match", () => {
    // The distinction that matters: the person WAS excluded. Collapsing this
    // into "no_match" would conceal history the caller may need.
    expect(verdictOf(classify([reinstated], { name: "Tameka Allen" })))
      .not.toBe("no_match");
  });

  it("state agreement never turns a first-initial hit into an exclusion", () => {
    // Regression: "Jared Abadi" in NY once returned verdict=excluded against a
    // record for Jamsheed Abadi, because state agreement lifted the weak match
    // to "match" confidence. Sharing a state with 19 million people is not
    // identification, and "excluded" is a verdict someone can lose a job over.
    const abadi: ExclusionRow = {
      ...active, id: "n1", last_name: "ABADI", first_name: "JAMSHEED",
      npi: "1477537496", state: "NY",
    };
    const m = classify([abadi], { name: "Jared Abadi", state: "NY" });
    expect(m[0].confidence).toBe("match");     // confidence is raised
    expect(m[0].basis).toBe("surname_initial"); // basis is not
    expect(verdictOf(m)).toBe("possible_match");
  });

  it("a full-name match still yields excluded when the state agrees", () => {
    const m = classify([active], { name: "John Smith", state: "TX" });
    expect(m[0].basis).toBe("full_name");
    expect(verdictOf(m)).toBe("excluded");
  });

  it("an NPI match is an identifying basis", () => {
    const m = classify([active], { npi: "1234567893" });
    expect(m[0].basis).toBe("npi");
    expect(verdictOf(m)).toBe("excluded");
  });

  it("a weak match on a reinstated record does not claim exclusion", () => {
    const m = classify([reinstated], { name: "Tanya Allen" });
    expect(m[0].confidence).toBe("weak");
    expect(verdictOf(m)).toBe("reinstated_only");
  });

  it("counts one person recorded twice as one subject", () => {
    // LEIE near-duplicates: same person, different address. Both rows are kept,
    // so match_count is 2 while subject_count must stay 1.
    const a: ExclusionRow = { ...active, id: "d1", city: "AUSTIN" };
    const b: ExclusionRow = { ...active, id: "d2", city: "DALLAS" };
    const m = classify([a, b], { name: "John Smith" });
    expect(m).toHaveLength(2);
    expect(subjectCountFor(m)).toBe(1);
  });

  it("counts a same-name pair with different DOBs as two subjects", () => {
    // This is the real LEIE case: VIVANCO CARIDAD appears with dob 19391106 and
    // 19401106, and VAZQUEZ DE LLADO YAMILA with 19660717 and 19660712. Both
    // rows are kept precisely because the DOBs differ, so they must count as
    // two subjects rather than being folded into one.
    const a: ExclusionRow = { ...active, id: "d3", dob: "19391106" };
    const b: ExclusionRow = { ...active, id: "d4", dob: "19401106" };
    const m = classify([a, b], { name: "John Smith" });
    expect(m).toHaveLength(2);
    expect(subjectCountFor(m)).toBe(2);
  });
});

/**
 * subjectCount is internal to screen(); this mirrors it so the counting rule is
 * pinned by a test. If the two ever diverge, the mirror is the bug.
 */
function subjectCountFor(matches: ReturnType<typeof classify>): number {
  const keys = new Set<string>();
  for (const m of matches) {
    const r = m.row;
    const bus = (r.bus_name ?? "").trim();
    keys.add(bus
      ? `b:${bus.toUpperCase()}`
      : `p:${(r.last_name ?? "").toUpperCase()}|${(r.first_name ?? "").toUpperCase()}|${r.dob ?? ""}`);
  }
  return keys.size;
}

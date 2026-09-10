import { describe, expect, it } from "vitest";
import {
  candidateNamePairs,
  fullKey,
  normalizeBusiness,
  normalizeDate,
  normalizeName,
  normalizeNpi,
  normalizeState,
} from "../src/normalize";
import {
  classify,
  isCurrentlyExcluded,
  overallConfidence,
  validateQuery,
  type ExclusionRow,
} from "../src/match";

/** Fixture: a real LEIE row shape (business, no NPI). */
const busRow: ExclusionRow = {
  id: "fx1", source: "leie",
  last_name: "", first_name: "", mid_name: "",
  bus_name: "#1 MARKETING SERVICE, INC",
  general: "OTHER BUSINESS", specialty: "SOBER HOME",
  npi: "0000000000", dob: "",
  city: "BROOKLYN", state: "NY", zip: "11235",
  excl_type: "1128a1", excl_date: "20200319",
  reinstate_date: "00000000", waiver_date: "00000000", waiver_state: "",
};

/** Fixture: a person with an NPI. */
const personRow: ExclusionRow = {
  id: "fx2", source: "leie",
  last_name: "SMITH", first_name: "JOHN", mid_name: "A",
  bus_name: "",
  general: "NURSE", specialty: "REGISTERED NURSE",
  npi: "1234567893", dob: "19700115",
  city: "AUSTIN", state: "TX", zip: "78701",
  excl_type: "1128a1", excl_date: "20180501",
  reinstate_date: "00000000", waiver_date: "00000000", waiver_state: "",
};

/** Fixture: reinstated person — matched, but no longer excluded. */
const reinstatedRow: ExclusionRow = {
  ...personRow,
  id: "fx3", first_name: "JANE", npi: "", dob: "19800220",
  reinstate_date: "20220401",
};

describe("normalization", () => {
  it("uppercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeName("  o'brien,  patrick ")).toBe("OBRIEN PATRICK");
  });

  it("drops generational suffixes from personal names", () => {
    expect(normalizeName("John Smith Jr.")).toBe("JOHN SMITH");
    expect(normalizeName("Henry Ford III")).toBe("HENRY FORD");
  });

  it("preserves corporate suffixes, which distinguish legal entities", () => {
    expect(normalizeBusiness("Smith Care, LLC")).toBe("SMITH CARE LLC");
    expect(normalizeBusiness("Smith Care Inc.")).toBe("SMITH CARE INC");
    expect(normalizeBusiness("Smith Care, LLC")).not.toBe(normalizeBusiness("Smith Care Inc."));
  });

  it("treats LEIE's 0000000000 NPI placeholder as absent", () => {
    expect(normalizeNpi("0000000000")).toBe("");
    expect(normalizeNpi("1234567893")).toBe("1234567893");
    expect(normalizeNpi("123")).toBe("");
  });

  it("treats 00000000 dates as absent", () => {
    expect(normalizeDate("00000000")).toBe("");
    expect(normalizeDate("20200319")).toBe("20200319");
  });

  it("normalizes states to two letters or nothing", () => {
    expect(normalizeState("tx")).toBe("TX");
    expect(normalizeState("Texas")).toBe("");
  });

  it("builds a LAST FIRST key", () => {
    expect(fullKey("Smith", "John")).toBe("SMITH JOHN");
  });

  it("offers both orderings for a free-text name", () => {
    const pairs = candidateNamePairs("John Smith");
    expect(pairs).toEqual(
      expect.arrayContaining([{ last: "SMITH", first: "JOHN" }]),
    );
  });

  it("honours an explicit comma ordering", () => {
    expect(candidateNamePairs("Smith, John")).toEqual([{ last: "SMITH", first: "JOHN" }]);
  });
});

describe("query validation", () => {
  it("requires a name or an npi", () => {
    expect(validateQuery({})).toMatchObject({ ok: false });
  });

  it("rejects wildcards", () => {
    expect(validateQuery({ name: "*" })).toMatchObject({ ok: false });
    expect(validateQuery({ name: "smi%" })).toMatchObject({ ok: false });
  });

  it("rejects names that are too short to screen", () => {
    expect(validateQuery({ name: "ab" })).toMatchObject({ ok: false });
  });

  it("rejects a malformed npi, naming the real problem", () => {
    expect(validateQuery({ npi: "12345" }))
      .toEqual({ ok: false, error: "npi must be exactly 10 digits" });
  });

  it("accepts a real name", () => {
    expect(validateQuery({ name: "John Smith" })).toEqual({ ok: true });
  });
});

describe("matching", () => {
  it("NPI equality is strong", () => {
    const m = classify([personRow], { npi: "1234567893" });
    expect(m).toHaveLength(1);
    expect(m[0].confidence).toBe("strong");
    expect(m[0].matched_on).toContain("npi equals");
  });

  it("last+first equality is a match", () => {
    const m = classify([personRow], { name: "John Smith" });
    expect(m[0].confidence).toBe("match");
    expect(m[0].matched_on).toContain("last+first");
  });

  it("business name equality is a match", () => {
    const m = classify([busRow], { name: "#1 Marketing Service, Inc" });
    expect(m[0].confidence).toBe("match");
    expect(m[0].matched_on).toContain("business name");
  });

  it("surname plus first initial is only weak", () => {
    const m = classify([personRow], { name: "Jared Smith" });
    expect(m[0].confidence).toBe("weak");
  });

  it("state corroboration promotes weak to match", () => {
    const m = classify([personRow], { name: "Jared Smith", state: "TX" });
    expect(m[0].confidence).toBe("match");
    expect(m[0].matched_on).toContain("state TX agrees");
  });

  it("a disagreeing state never demotes or excludes", () => {
    const m = classify([personRow], { name: "John Smith", state: "CA" });
    expect(m[0].confidence).toBe("match");
  });

  it("a clean control returns nothing", () => {
    const m = classify([personRow, busRow], { name: "Zebediah Quatermain" });
    expect(m).toHaveLength(0);
    expect(overallConfidence(m)).toBe("none");
  });

  it("does not match on the 0000000000 NPI placeholder", () => {
    const m = classify([busRow], { npi: "0000000000" });
    expect(m).toHaveLength(0);
  });

  it("reports the strongest confidence overall", () => {
    const m = classify([personRow, busRow], { name: "John Smith", npi: "1234567893" });
    expect(overallConfidence(m)).toBe("strong");
  });

  it("distinguishes matched from currently excluded", () => {
    const m = classify([reinstatedRow], { name: "Jane Smith" });
    expect(m[0].confidence).toBe("match");
    expect(isCurrentlyExcluded(reinstatedRow)).toBe(false);
    expect(isCurrentlyExcluded(personRow)).toBe(true);
  });
});

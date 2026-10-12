import { describe, expect, it } from "vitest";
import { assertEnvelope } from "../src/envelope";
import {
  buildExclusionEnvelope, buildLimits, EXCLUSION_VERDICTS, toEnvelopeSources, topBasis,
} from "../src/envelope-adapter";
import type { SourceInfo } from "../src/screen";

const SOURCES: SourceInfo[] = [
  { source: "leie", rows: 83975, loaded_at: "2026-09-10T21:21:05.202Z", sha256: "abc", complete: true, rows_expected: 83975 },
  { source: "sam", rows: 162547, loaded_at: "2026-09-11T18:00:00.000Z", sha256: "def", complete: true, rows_expected: 162547 },
];

describe("toEnvelopeSources", () => {
  it("maps source/loaded_at to name/as_of and adds a public-record url per source", () => {
    const env = toEnvelopeSources(SOURCES);
    expect(env[0]).toMatchObject({ name: "leie", as_of: "2026-09-10T21:21:05.202Z", url: "https://exclusions.oig.hhs.gov" });
    expect(env[1]).toMatchObject({ name: "sam", as_of: "2026-09-11T18:00:00.000Z", url: "https://sam.gov/search" });
  });

  it("carries every existing field through additively", () => {
    const env = toEnvelopeSources(SOURCES);
    expect(env[0].rows).toBe(83975);
    expect(env[0].sha256).toBe("abc");
    expect(env[0].complete).toBe(true);
  });
});

describe("buildLimits", () => {
  it("always includes the two static disclosures", () => {
    const limits = buildLimits({ coverageComplete: true, coverageNote: "", stateSupplied: false, verdict: "no_match" });
    expect(limits.length).toBeGreaterThanOrEqual(2);
    expect(limits.some((l) => l.includes("not an identity determination"))).toBe(true);
  });

  it("adds the coverage note only when incomplete", () => {
    const complete = buildLimits({ coverageComplete: true, coverageNote: "INCOMPLETE: x", stateSupplied: false, verdict: "no_match" });
    expect(complete.some((l) => l.includes("INCOMPLETE"))).toBe(false);

    const incomplete = buildLimits({ coverageComplete: false, coverageNote: "INCOMPLETE: x", stateSupplied: false, verdict: "no_match" });
    expect(incomplete.some((l) => l.includes("INCOMPLETE"))).toBe(true);
  });

  it("adds the state-corroboration note only when state was supplied (ENVELOPE.md §1.2.1)", () => {
    const noState = buildLimits({ coverageComplete: true, coverageNote: "", stateSupplied: false, verdict: "no_match" });
    expect(noState.some((l) => l.includes("state corroborates"))).toBe(false);

    const withState = buildLimits({ coverageComplete: true, coverageNote: "", stateSupplied: true, verdict: "no_match" });
    expect(withState.some((l) => l.includes("state corroborates"))).toBe(true);
  });

  it("adds a reinstatement pointer only for reinstated_only, per the G1 decision not to collapse the verdict", () => {
    const excluded = buildLimits({ coverageComplete: true, coverageNote: "", stateSupplied: false, verdict: "excluded" });
    expect(excluded.some((l) => l.includes("reinstated"))).toBe(false);

    const reinstated = buildLimits({ coverageComplete: true, coverageNote: "", stateSupplied: false, verdict: "reinstated_only" });
    expect(reinstated.some((l) => l.includes("reinstated"))).toBe(true);
  });
});

describe("topBasis", () => {
  it("returns the first (strongest, per classify()'s sort) match's basis", () => {
    expect(topBasis([{ confidence: "strong", basis: "npi", matched_on: "x", record: {} }])).toBe("npi");
  });

  it("returns null for an empty match list", () => {
    expect(topBasis([])).toBeNull();
  });

  it("survives truncation — the shown slice keeps index 0 as the strongest", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      confidence: "match", basis: `basis${i}`, matched_on: "x", record: {},
    }));
    const shown = many.slice(0, 5); // what screen() would hand this after capping
    expect(topBasis(shown)).toBe("basis0");
  });
});

describe("buildExclusionEnvelope + assertEnvelope, end to end", () => {
  it("produces a valid v2 envelope for an excluded verdict", () => {
    const env = buildExclusionEnvelope({
      query: { name: "Smith, John", npi: null, dob: null, state: "TX", uei: null, cage: null },
      verdict: "excluded", confidence: "strong",
      matchCount: 1, subjectCount: 1,
      matches: [{ confidence: "strong", basis: "npi", matched_on: "npi equals 1477537496", record: { npi: "1477537496" } }],
      sources: SOURCES, coverageComplete: true, coverageNote: "All sources fully loaded.",
      stateSupplied: true,
    });

    const result = assertEnvelope(env, EXCLUSION_VERDICTS);
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(env.service).toBe("exclusion-check");
    expect(env.basis).toBe("npi");
    expect(env.counts).toEqual({ records: 1, subjects: 1 });
    // as_of is the EARLIEST source, not the latest
    expect(env.as_of).toBe("2026-09-10T21:21:05.202Z");
    expect(env.limits.some((l) => l.includes("state corroborates"))).toBe(true);
  });

  it("produces a valid v2 envelope for a no_match verdict (empty matches, null basis)", () => {
    const env = buildExclusionEnvelope({
      query: { name: "Zebediah Quatermain", npi: null, dob: null, state: null, uei: null, cage: null },
      verdict: "no_match", confidence: "none",
      matchCount: 0, subjectCount: 0, matches: [],
      sources: SOURCES, coverageComplete: true, coverageNote: "All sources fully loaded.",
      stateSupplied: false,
    });

    expect(assertEnvelope(env, EXCLUSION_VERDICTS).ok).toBe(true);
    expect(env.basis).toBeNull();
    expect(env.counts).toEqual({ records: 0, subjects: 0 });
  });

  it("reinstated_only keeps its own verdict word — no collapse to a generic tri-state (G1 decision)", () => {
    const env = buildExclusionEnvelope({
      query: { name: "Tameka Allen", npi: null, dob: null, state: null, uei: null, cage: null },
      verdict: "reinstated_only", confidence: "match",
      matchCount: 1, subjectCount: 1,
      matches: [{ confidence: "match", basis: "full_name", matched_on: "x", record: {} }],
      sources: SOURCES, coverageComplete: true, coverageNote: "", stateSupplied: false,
    });
    expect(env.verdict).toBe("reinstated_only");
    expect(assertEnvelope(env, EXCLUSION_VERDICTS).ok).toBe(true);
    expect(env.limits.some((l) => l.includes("reinstated"))).toBe(true);
  });

  it("rejects against a foreign verdict vocabulary, proving the SHAPE is shared but not the WORDS", () => {
    const env = buildExclusionEnvelope({
      query: {}, verdict: "excluded", confidence: "strong", matchCount: 0, subjectCount: 0,
      matches: [], sources: SOURCES, coverageComplete: true, coverageNote: "", stateSupplied: false,
    });
    const packageVerdicts = ["active", "stale", "abandoned", "deprecated", "closed", "not_found"];
    expect(assertEnvelope(env, packageVerdicts).ok).toBe(false);
    expect(assertEnvelope(env, EXCLUSION_VERDICTS).ok).toBe(true);
  });
});

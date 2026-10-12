/**
 * Booth-specific glue between exclusion-check's existing internal shapes
 * (ScreenResult, SourceInfo[]) and the vendored envelope.ts. This file is
 * NOT part of the shared module — it's exactly the "booth-specific
 * matching/adaptation logic stays in the booth" half of ENVELOPE.md §1.5.
 *
 * Verdict vocabulary is exclusion-check's own, unchanged from v1, per the
 * G1 decision that the envelope shares the SHAPE, not the WORDS a verdict
 * takes (ENVELOPE.md §1.3).
 */
import { EXCLUSION_LIMITATIONS } from "./discovery";
import type { Verdict } from "./screen";
import type { SourceInfo } from "./screen";
import { buildEnvelope, type EnvelopeSource, type EnvelopeResponse } from "./envelope";

export type ExclusionVerdict = Verdict; // "excluded" | "possible_match" | "reinstated_only" | "no_match"

export const EXCLUSION_VERDICTS: readonly ExclusionVerdict[] =
  ["excluded", "possible_match", "reinstated_only", "no_match"];

/** Public-record URL per source, named once here rather than scattered. */
function sourceUrl(source: string): string {
  if (source === "sam") return "https://sam.gov/search";
  return "https://exclusions.oig.hhs.gov"; // leie, leie_rein
}

/** Convert exclusion-check's SourceInfo[] into the envelope's required
 * name/as_of/url shape, keeping every existing field additively. */
export function toEnvelopeSources(sources: SourceInfo[]): EnvelopeSource[] {
  return sources.map((s) => ({
    name: s.source,
    as_of: s.loaded_at ?? new Date(0).toISOString(),
    url: sourceUrl(s.source),
    rows: s.rows,
    sha256: s.sha256,
    reseed_due: s.reseed_due,
    upstream_last_modified: s.upstream_last_modified,
    complete: s.complete,
    rows_expected: s.rows_expected,
  }));
}

/**
 * Build the `limits[]` array for one answer.
 *
 * Always carries the two static disclosures (what this booth does not
 * screen; a match is not an identity determination). Adds a coverage note
 * when a source is still mid-load, a state-qualifier note per ENVELOPE.md
 * §1.2.1 whenever the caller supplied `state`, and a reinstatement pointer
 * when the verdict collapsed a history detail the caller should know to
 * look for in `records`.
 */
export function buildLimits(opts: {
  coverageComplete: boolean;
  coverageNote: string;
  stateSupplied: boolean;
  verdict: ExclusionVerdict;
}): string[] {
  const limits = [...EXCLUSION_LIMITATIONS];
  if (!opts.coverageComplete) limits.push(opts.coverageNote);
  if (opts.stateSupplied) {
    limits.push("state corroborates a match; it does not identify or exclude one");
  }
  if (opts.verdict === "reinstated_only") {
    limits.push("a prior exclusion was reinstated; see records for history");
  }
  return limits;
}

interface MatchLike {
  confidence: string;
  basis: string;
  matched_on: string;
  record: unknown;
}

/** The strongest match's basis, or null when there are none. Safe even
 * under truncation: classify() sorts by confidence before screen() caps
 * the shown list, so the first shown match is always the strongest. */
export function topBasis(matches: unknown[]): string | null {
  const first = matches[0] as MatchLike | undefined;
  return first?.basis ?? null;
}

export interface BuildExclusionEnvelopeParams {
  query: Record<string, unknown>;
  verdict: ExclusionVerdict;
  confidence: string;
  matchCount: number;
  subjectCount: number;
  matches: unknown[];
  sources: SourceInfo[];
  coverageComplete: boolean;
  coverageNote: string;
  stateSupplied: boolean;
}

/** Assemble one v2 envelope for /v1/check, /v1/report, or one batch item. */
export function buildExclusionEnvelope(
  p: BuildExclusionEnvelopeParams,
): EnvelopeResponse<ExclusionVerdict, MatchLike> {
  return buildEnvelope<ExclusionVerdict, MatchLike>({
    service: "exclusion-check",
    query: p.query,
    verdict: p.verdict,
    confidence: p.confidence as never,
    basis: topBasis(p.matches),
    records: p.matches as MatchLike[],
    subjectCount: p.subjectCount,
    sources: toEnvelopeSources(p.sources),
    limits: buildLimits({
      coverageComplete: p.coverageComplete,
      coverageNote: p.coverageNote,
      stateSupplied: p.stateSupplied,
      verdict: p.verdict,
    }),
  });
}

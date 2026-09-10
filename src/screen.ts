/**
 * Screening: turn a query into an answer, with the reasoning attached.
 *
 * The verdict vocabulary is deliberately narrow and each value means one thing:
 *
 *   excluded          a record matched on an IDENTIFYING basis (NPI, full
 *                     personal name, or business name) at "match" confidence or
 *                     better, AND that record carries no reinstatement date.
 *   possible_match    something matched, but only on surname plus first
 *                     initial. A lead to verify, not a finding — and it stays a
 *                     lead even if a supplied state agrees.
 *   reinstated_only   matched only records that carry a reinstatement date. The
 *                     person was excluded and no longer is. Reported explicitly
 *                     rather than as "no match", because "no match" would hide
 *                     history the caller may need.
 *   no_match          nothing matched.
 *
 * "excluded" is never returned on weak evidence alone, and a match is never
 * suppressed for disagreeing on state.
 */
import type { Env } from "./env";
import {
  buildCandidateQuery, classify, isCurrentlyExcluded, overallConfidence,
  type Confidence, type ExclusionRow, type MatchedRow, type Query,
} from "./match";

export type Verdict = "excluded" | "possible_match" | "reinstated_only" | "no_match";

const RANK: Record<Confidence, number> = { strong: 3, match: 2, weak: 1, none: 0 };

export interface SourceInfo {
  source: string;
  rows: number;
  loaded_at: string | null;
  sha256: string | null;
  reseed_due?: boolean;
  upstream_last_modified?: string | null;
}

export const DISCLAIMER =
  "Name-based screening against the HHS-OIG LEIE generation identified under " +
  "`sources`. A match is not an identity determination and a non-match is not " +
  "a clearance. Confirm any result against the official record at " +
  "https://exclusions.oig.hhs.gov before taking action against a person.";

/**
 * Decide the verdict from classified matches.
 *
 * "excluded" requires BOTH enough confidence AND a basis that can actually
 * identify someone: an NPI, a complete personal name, or a business name. A
 * surname-plus-first-initial hit is never enough, even when a supplied state
 * agrees and lifts its confidence to "match" — otherwise a query for "Jared
 * Abadi" in NY would return "excluded" on a record for Jamsheed Abadi, and a
 * caller could act on that against the wrong person.
 */
export function verdictOf(matches: MatchedRow[]): Verdict {
  if (!matches.length) return "no_match";

  const identifying = matches.filter(
    (m) => RANK[m.confidence] >= RANK.match && m.basis !== "surname_initial",
  );
  if (identifying.some((m) => isCurrentlyExcluded(m.row))) return "excluded";
  if (identifying.length) return "reinstated_only";

  // What is left cannot identify a person. If every remaining match is a
  // reinstated record, report that; otherwise it is an unverified lead.
  if (matches.every((m) => !isCurrentlyExcluded(m.row))) return "reinstated_only";
  return "possible_match";
}

/** Public record shape for /v1/check — no street address. */
function briefRecord(row: ExclusionRow) {
  return {
    source: row.source,
    last_name: row.last_name || null,
    first_name: row.first_name || null,
    middle_name: row.mid_name || null,
    business_name: row.bus_name || null,
    npi: row.npi || null,
    state: row.state || null,
    exclusion_type: row.excl_type || null,
    exclusion_date: row.excl_date || null,
    reinstatement_date: row.reinstate_date || null,
    currently_excluded: isCurrentlyExcluded(row),
  };
}

/** Full record shape for /v1/report. */
function fullRecord(row: ExclusionRow) {
  return {
    ...briefRecord(row),
    record_id: row.id,
    general_category: row.general || null,
    specialty: row.specialty || null,
    upin: row.upin || null,
    date_of_birth: row.dob || null,
    city: row.city || null,
    zip: row.zip || null,
    waiver_date: row.waiver_date || null,
    waiver_state: row.waiver_state || null,
  };
}

/** Read per-source provenance so an answer can state what it screened. */
export async function sourceInfo(env: Env): Promise<SourceInfo[]> {
  // One query, not one per source: the free plan allows 50 D1 queries per
  // invocation and a paid call should spend as few as possible.
  //
  // Correlated subqueries rather than MAX() over a join, because MAX(loaded_at)
  // and MAX(sha256) can come from different `loads` rows and would report a
  // digest that never belonged to that load. The digest is taken from the most
  // recent load that HAS one: the cron supplement writes no digest (it merges a
  // small file rather than replacing a generation), so the reported digest stays
  // the one identifying the bulk generation actually in the table.
  const { results } = await env.DB.prepare(
    `SELECT e.source AS source,
            COUNT(*) AS n_rows,
            (SELECT l.loaded_at FROM loads l
               WHERE l.source = e.source
               ORDER BY l.loaded_at DESC LIMIT 1)              AS loaded_at,
            (SELECT l.sha256 FROM loads l
               WHERE l.source = e.source AND l.sha256 IS NOT NULL
               ORDER BY l.loaded_at DESC LIMIT 1)              AS sha256,
            (SELECT s.reseed_due FROM source_state s
               WHERE s.source = e.source)                     AS reseed_due,
            (SELECT s.upstream_last_modified FROM source_state s
               WHERE s.source = e.source)                     AS upstream_last_modified
       FROM exclusions e
      GROUP BY e.source
      ORDER BY e.source`,
  ).all<{
    source: string; n_rows: number; loaded_at: string | null; sha256: string | null;
    reseed_due: number | null; upstream_last_modified: string | null;
  }>();

  return (results ?? []).map((r) => ({
    source: r.source,
    rows: r.n_rows,
    loaded_at: r.loaded_at,
    sha256: r.sha256,
    reseed_due: Boolean(r.reseed_due),
    upstream_last_modified: r.upstream_last_modified,
  }));
}

export interface ScreenResult {
  verdict: Verdict;
  confidence: Confidence;
  match_count: number;
  subject_count: number;
  matches: unknown[];
  truncated: boolean;
}

/**
 * Distinct subjects behind a set of matching records.
 *
 * LEIE carries more than one row for the same subject: 19 groups in the active
 * list are the same person or business differing only on address, specialty,
 * UPIN or date of birth, and those rows are kept deliberately rather than
 * collapsed (collapsing them would discard a date of birth a caller may screen
 * against). The consequence is that match_count can read as "three separate
 * exclusions" when it is one person recorded three times, so the subject count
 * is reported alongside it instead of leaving the caller to infer it.
 */
function subjectCount(matches: MatchedRow[]): number {
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

/** Run one screening. `detail` controls how much of each record is returned. */
export async function screen(
  env: Env, q: Query, detail: "brief" | "full",
): Promise<ScreenResult> {
  const { sql, params } = buildCandidateQuery(q);
  const { results } = await env.DB.prepare(sql).bind(...params).all<ExclusionRow>();
  const matches = classify(results ?? [], q);

  // /v1/check returns the strongest handful; /v1/report returns everything.
  // The cap is disclosed via `truncated` and `match_count` so a caller is never
  // led to believe they have seen every match when they have not.
  const cap = detail === "full" ? matches.length : 5;
  const shown = matches.slice(0, cap);

  return {
    verdict: verdictOf(matches),
    confidence: overallConfidence(matches),
    match_count: matches.length,
    subject_count: subjectCount(matches),
    truncated: shown.length < matches.length,
    matches: shown.map((m) => ({
      confidence: m.confidence,
      basis: m.basis,
      matched_on: m.matched_on,
      record: detail === "full" ? fullRecord(m.row) : briefRecord(m.row),
    })),
  };
}

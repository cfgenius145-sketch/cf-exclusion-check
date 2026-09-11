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
  /** False while a multi-day load is still in progress. */
  complete?: boolean;
  rows_expected?: number | null;
}

/**
 * Is every source fully loaded?
 *
 * This governs how a non-match may be described. SAM.gov is 162,547 rows and
 * D1's free plan allows 100,000 row writes per day (index entries included), so
 * the load spans several days. While it is in progress a "no match" means "not
 * found in what has been loaded so far", which is emphatically not a clearance,
 * and every response has to say so.
 */
export function coverageOf(sources: SourceInfo[]): {
  complete: boolean;
  note: string;
  incomplete_sources: string[];
} {
  const partial = sources.filter((s) => s.complete === false);
  if (!partial.length) {
    return {
      complete: true,
      note: "All sources fully loaded.",
      incomplete_sources: [],
    };
  }
  const names = partial.map((s) => s.source);
  const detail = partial
    .map((s) => `${s.source} ${s.rows.toLocaleString()}/` +
                `${(s.rows_expected ?? 0).toLocaleString()}`)
    .join(", ");
  return {
    complete: false,
    note:
      `INCOMPLETE: ${detail} rows loaded. A non-match against a partially ` +
      `loaded source is NOT a clearance — the record may simply not be loaded ` +
      `yet. Matches that are returned remain valid.`,
    incomplete_sources: names,
  };
}

export const DISCLAIMER =
  "Screening against the HHS-OIG LEIE and SAM.gov exclusion data generations " +
  "identified under `sources`. A name match is not an identity determination " +
  "and a non-match is not a clearance. Confirm any result against the official " +
  "record at https://exclusions.oig.hhs.gov (LEIE) or https://sam.gov/search " +
  "(SAM) before taking action against a person or business.";

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
    classification: row.classification || null,
    excluding_agency: row.agency_name || row.agency_code || null,
    uei: row.uei || null,
    cage: row.cage || null,
    termination_date: row.termination_date || null,
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
    program: row.program || null,
    agency_code: row.agency_code || null,
    record_status: row.record_status || null,
    country: row.country || null,
    date_of_birth: row.dob || null,
    city: row.city || null,
    zip: row.zip || null,
    waiver_date: row.waiver_date || null,
    waiver_state: row.waiver_state || null,
  };
}

/**
 * Read per-source provenance so an answer can state what it screened.
 *
 * Reads the tiny bookkeeping tables ONLY. It must never count rows in
 * `exclusions`.
 *
 * The previous version did `SELECT source, COUNT(*) ... FROM exclusions GROUP BY
 * source`, whose plan is `SCAN e USING COVERING INDEX idx_excl_load` — a pass
 * over every row in the table. Because this runs on every screening request and
 * every health check, at 247,583 rows it spent ~247k of D1's 5,000,000 daily
 * row reads PER CALL, capping the whole service at roughly 20 requests a day.
 * That is what exhausted the read budget and made /v1/health return 500.
 *
 * `source_load_progress` already holds the authoritative row count per source
 * (it is what tracks load completeness), so the count is read from there: three
 * rows instead of a quarter of a million.
 */
export async function sourceInfo(env: Env): Promise<SourceInfo[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.source                                          AS source,
            p.rows_done                                       AS n_rows,
            p.rows_expected                                   AS rows_expected,
            p.status                                          AS load_status,
            (SELECT l.loaded_at FROM loads l
               WHERE l.source = p.source
               ORDER BY l.loaded_at DESC LIMIT 1)             AS loaded_at,
            (SELECT l.sha256 FROM loads l
               WHERE l.source = p.source AND l.sha256 IS NOT NULL
               ORDER BY l.loaded_at DESC LIMIT 1)             AS sha256,
            (SELECT s.reseed_due FROM source_state s
               WHERE s.source = p.source)                     AS reseed_due,
            (SELECT s.upstream_last_modified FROM source_state s
               WHERE s.source = p.source)                     AS upstream_last_modified
       FROM source_load_progress p
      ORDER BY p.source`,
  ).all<{
    source: string; n_rows: number; rows_expected: number | null;
    load_status: string | null; loaded_at: string | null; sha256: string | null;
    reseed_due: number | null; upstream_last_modified: string | null;
  }>();

  return (results ?? []).map((r) => ({
    source: r.source,
    rows: r.n_rows,
    loaded_at: r.loaded_at,
    sha256: r.sha256,
    reseed_due: Boolean(r.reseed_due),
    upstream_last_modified: r.upstream_last_modified,
    complete: r.load_status !== "partial",
    rows_expected: r.rows_expected,
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

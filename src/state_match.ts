/**
 * State-exclusions matching — v2 only. Reuses match.ts's classify()
 * unmodified: state rows are shaped into the same ExclusionRow interface
 * federal rows already use, so confidence and basis mean identically the
 * same thing across federal and state, per the approved design.
 *
 * v1 never imports this file. `exclusions` and `state_exclusions` are
 * separate tables queried by separate functions — there is no shared query
 * for a missing WHERE clause to ever silently widen.
 */
import type { Env } from "./env";
import { candidateNamePairs, fullKey, normalizeBusiness } from "./normalize";
import { classify, type ExclusionRow, type MatchedRow, type Query } from "./match";

/** A record stops counting as an open delisting signal below this many
 * consecutive daily misses. A state that publishes weekly, or a two-day
 * weekend outage on the source site, must not trip this — the daily parse
 * runs at 05:15 UTC, so 3 consecutive misses is >=3 real days absent, not
 * one bad fetch. The extra lag costs nothing: a state match is never
 * auto-cleared either way (see toExclusionRow() below), so raising this
 * only delays when the softer wording appears, never whether the record is
 * reported. */
const DELIST_THRESHOLD = 3;

export interface StateExclusionRow {
  id: string;
  source: string;
  state: string;
  name: string;
  is_person: number;
  npi: string;
  excl_date: string | null;
  source_url: string | null;
  as_of: string;
  refresh: string;
  /** "" unless CFAI currently has an OPEN delisting signal for this url. */
  delist_first_missing: string;
  delist_times_missing: number;
}

/** Same OR/IN-not-UNION shape as buildCandidateQuery, for the same reason
 * (D1's 5-term compound-SELECT cap) — targets state_exclusions's n_name/
 * n_bus instead of exclusions's n_last/n_full/n_bus. Not filtered by the
 * list's own `state` column: a caller need not know which state's list a
 * name is on, and state is corroboration-only in classify(), never
 * exclusionary — same rule as federal. */
export function buildStateCandidateQuery(q: Query): { sql: string; params: string[] } {
  const cols = `id, source, state, name, is_person, npi, excl_date, source_url, as_of, refresh,
    delist_first_missing, delist_times_missing`;
  const terms: string[] = [];
  const params: string[] = [];

  const name = (q.name ?? "").trim();
  if (!name) {
    return { sql: `SELECT ${cols} FROM state_exclusions WHERE 0 LIMIT 0`, params: [] };
  }

  const bus = normalizeBusiness(name);
  if (bus) {
    terms.push("(n_bus = ? AND n_bus <> '')");
    params.push(bus);
  }

  const nameKeys: string[] = [];
  for (const pair of candidateNamePairs(name)) {
    const key = fullKey(pair.last, pair.first);
    if (key && !nameKeys.includes(key)) nameKeys.push(key);
  }
  const capped = nameKeys.slice(0, 8);
  if (capped.length) {
    terms.push(`(n_name IN (${capped.map(() => "?").join(",")}) AND n_name <> '')`);
    params.push(...capped);
  }

  if (!terms.length) {
    return { sql: `SELECT ${cols} FROM state_exclusions WHERE 0 LIMIT 0`, params: [] };
  }

  return { sql: `SELECT ${cols} FROM state_exclusions WHERE ${terms.join(" OR ")} LIMIT 200`, params };
}

/** Split "FIRST MIDDLE LAST" (how CFAI's state parsers assemble the name)
 * into (last, first) so classify()'s fullKey/surname-initial logic works
 * unmodified. Approximate by construction — see candidateNamePairs, which
 * already tries this same split as one of several candidates when parsing
 * the QUERY side, so a query in either common ordering still resolves. */
function splitPersonName(name: string): { last: string; first: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { last: parts[0] ?? "", first: "" };
  return { last: parts[parts.length - 1], first: parts.slice(0, -1).join(" ") };
}

export function toExclusionRow(r: StateExclusionRow): ExclusionRow {
  const isPerson = Boolean(r.is_person);
  const { last, first } = isPerson ? splitPersonName(r.name) : { last: "", first: "" };
  return {
    id: r.id,
    source: r.source,
    last_name: isPerson ? last : null,
    first_name: isPerson ? first : null,
    mid_name: null,
    bus_name: isPerson ? null : r.name,
    general: null,
    specialty: null,
    npi: r.npi || null,
    dob: null,
    city: null,
    state: r.state,
    zip: null,
    excl_type: null,
    excl_date: r.excl_date,
    // No state publishes an authoritative reinstatement date the way LEIE's
    // REINDATE does, so reinstate_date stays null and isCurrentlyExcluded()
    // always treats a state match as still in force -- that boolean is
    // never flipped for a state record, on purpose (see possible_reinstatement
    // below and DELIST_THRESHOLD's comment for why).
    //
    // As of 2026-09-18, CFAI DOES carry an inferred signal for this --
    // state_delisting_signal, fed by the daily state parse noticing a
    // previously-held record's url absent from a fresh fetch. It is
    // inference, not a source-asserted fact (a parser hiccup or a one-day
    // site outage looks the same as a real reinstatement for one day),
    // which is why it surfaces as a separate annotation rather than
    // reusing reinstate_date's auto-clear semantics.
    reinstate_date: null,
    possible_reinstatement:
      r.delist_times_missing >= DELIST_THRESHOLD
        ? { first_missing_at: r.delist_first_missing, times_missing: r.delist_times_missing }
        : null,
    waiver_date: null,
    waiver_state: null,
  };
}

export interface StateMatch {
  matched: MatchedRow;
  list_state: string;
  source: string;
  as_of: string;
  refresh: string;
  source_url: string | null;
}

export interface StateSourceInfo {
  state: string;
  source: string;
  rows: number;
  as_of: string;
  refresh: string;
}

/** Cheap per-state coverage summary for /v1/health — reads the bookkeeping
 * table only (16 rows), never COUNT(*) on state_exclusions itself. Mirrors
 * screen.ts's sourceInfo() for the federal side. */
export async function stateSourceInfo(env: Env): Promise<StateSourceInfo[]> {
  const { results } = await env.DB.prepare(
    `SELECT state, source, row_count AS rows, as_of, refresh
       FROM state_source_meta
      ORDER BY state`,
  ).all<StateSourceInfo>();
  return results ?? [];
}

export async function screenState(env: Env, q: Query): Promise<StateMatch[]> {
  const { sql, params } = buildStateCandidateQuery(q);
  if (!params.length) return [];
  const { results } = await env.DB.prepare(sql).bind(...params).all<StateExclusionRow>();
  const rows = (results ?? []).map(toExclusionRow);
  const byId = new Map((results ?? []).map((r) => [r.id, r]));
  const matches = classify(rows, q);
  return matches.map((m) => {
    const src = byId.get(m.row.id)!;
    return {
      matched: m,
      list_state: src.state,
      source: src.source,
      as_of: src.as_of,
      refresh: src.refresh,
      source_url: src.source_url,
    };
  });
}

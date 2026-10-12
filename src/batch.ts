/**
 * Batch screening: one paid call answers 2-200 items.
 *
 * The design constraint is D1's 100-bound-parameter ceiling per query (see
 * src/match.ts). A batch cannot run buildCandidateQuery() once per item — that
 * is a query inside a loop, capped at ~14 items before the query count gets
 * silly and unbounded before it gets dangerous. Instead every item's candidate
 * identifiers (npi, uei, cage, business name, full-name keys, last-name keys)
 * are gathered into six deduplicated column-keyed sets across the WHOLE batch,
 * then packed greedily into as few queries as fit under the 100-param cap —
 * each query is a single OR/IN SELECT, never a compound (UNION) SELECT, so
 * SQLite's per-disjunct index lookups still apply (MULTI-INDEX OR, verified in
 * test/sql.test.ts and test/batch.test.ts).
 *
 * The fetched rows are a superset covering every item. classify() from
 * match.ts — unmodified — is then run once per item against that superset in
 * memory; this is filtering, not a query, so it costs no additional D1 round
 * trip.
 */
import {
  classify,
  overallBasis,
  overallConfidence,
  validateQuery,
  type ExclusionRow,
  type MatchedRow,
  type Query,
} from "./match";
import {
  candidateNamePairs,
  fullKey,
  normalizeBusiness,
  normalizeCage,
  normalizeNpi,
  normalizeUei,
} from "./normalize";
import { briefRecord, subjectCount, verdictOf } from "./screen";
import type { Env } from "./env";

export const MIN_BATCH_ITEMS = 2;
/**
 * Ceiling on items per call.
 *
 * Set from measurement (see docs/BATCH-MEASUREMENT.md / the G1 report), not
 * assumed from the spec's upper bound. Lower this and update the report if a
 * future measurement shows 200 items no longer fits the CPU budget.
 */
export const MAX_BATCH_ITEMS = 200;

/** Every SELECT this module emits caps rows so one adversarial value (a common
 * surname shared by thousands of rows) cannot make a batch query unbounded.
 * Chosen well above any realistic match count per chunk; measured, not guessed
 * — see the G1 report. */
const ROWS_PER_QUERY_CAP = 1000;

export type BatchTier = "small" | "medium" | "large";

export interface TierInfo {
  tier: BatchTier;
  price: string;
}

/** Tiered pricing, charged once per call from the submitted item count. */
export function tierFor(itemCount: number): TierInfo | null {
  if (itemCount >= 2 && itemCount <= 10) return { tier: "small", price: "$0.30" };
  if (itemCount >= 11 && itemCount <= 50) return { tier: "medium", price: "$1.00" };
  if (itemCount >= 51 && itemCount <= 200) return { tier: "large", price: "$3.00" };
  return null;
}

export interface BatchItem extends Query {
  /** The caller's own id for this item, round-tripped verbatim. */
  ref?: string;
}

/** Parse the batch body into a raw item array, or null if the shape is wrong. */
export function parseBatchItems(body: unknown): BatchItem[] | null {
  if (!body || typeof body !== "object") return null;
  const items = (body as Record<string, unknown>).items;
  if (!Array.isArray(items)) return null;
  return items.map((raw): BatchItem => {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return {
      ref: typeof o.ref === "string" ? o.ref : undefined,
      name: typeof o.name === "string" ? o.name : undefined,
      npi: o.npi != null ? String(o.npi) : undefined,
      dob: o.dob != null ? String(o.dob) : undefined,
      state: typeof o.state === "string" ? o.state : undefined,
      uei: o.uei != null ? String(o.uei) : undefined,
      cage: o.cage != null ? String(o.cage) : undefined,
    };
  });
}

export interface ValidatedItem {
  item: BatchItem;
  ok: boolean;
  error?: string;
}

/** Validate every item with the exact same rules /v1/check uses. */
export function validateBatchItems(items: BatchItem[]): ValidatedItem[] {
  return items.map((item) => {
    const check = validateQuery(item);
    return check.ok ? { item, ok: true } : { item, ok: false, error: check.error };
  });
}

const CANDIDATE_COLS = `id, source, last_name, first_name, mid_name, bus_name, general,
    specialty, upin, npi, dob, city, state, zip, excl_type, excl_date,
    reinstate_date, waiver_date, waiver_state, uei, cage, duns, classification,
    program, agency_code, agency_name, record_status, termination_date,
    country`;

export interface BatchQuery {
  sql: string;
  params: string[];
}

/**
 * Build the whole batch's D1 lookups.
 *
 * Six column-keyed value sets are gathered across every valid item, then
 * packed greedily into queries of at most 100 bound parameters each. Packing
 * is greedy and column-agnostic — a query mixes columns freely, e.g.
 * `(npi IN (...) AND npi <> '') OR (n_last IN (...) AND n_last <> '')` — so the
 * query count is the theoretical minimum, ceil(total distinct values / 100),
 * not one query per column.
 *
 * Every term keeps the `<> ''` predicate the partial indexes require (see
 * migration 0005 and match.ts); dropping it silently full-scans.
 */
export function buildBatchQueries(items: Query[]): BatchQuery[] {
  const npi = new Set<string>();
  const uei = new Set<string>();
  const cage = new Set<string>();
  const bus = new Set<string>();
  const full = new Set<string>();
  const last = new Set<string>();

  for (const q of items) {
    const n = normalizeNpi(q.npi);
    if (n) npi.add(n);
    const u = normalizeUei(q.uei);
    if (u) uei.add(u);
    const c = normalizeCage(q.cage);
    if (c) cage.add(c);

    const name = (q.name ?? "").trim();
    if (!name) continue;

    const b = normalizeBusiness(name);
    if (b) bus.add(b);

    for (const pair of candidateNamePairs(name)) {
      const key = fullKey(pair.last, pair.first);
      if (key) full.add(key);
      if (pair.last) last.add(pair.last);
    }
  }

  const groups: Array<{ column: string; values: string[] }> = [
    { column: "npi", values: [...npi] },
    { column: "uei", values: [...uei] },
    { column: "cage", values: [...cage] },
    { column: "n_bus", values: [...bus] },
    { column: "n_full", values: [...full] },
    { column: "n_last", values: [...last] },
  ].filter((g) => g.values.length > 0);

  const MAX_PARAMS = 100;
  const queries: BatchQuery[] = [];
  let terms: string[] = [];
  let params: string[] = [];

  const flush = () => {
    if (!terms.length) return;
    queries.push({
      sql: `SELECT ${CANDIDATE_COLS} FROM exclusions WHERE ${terms.join(" OR ")} LIMIT ${ROWS_PER_QUERY_CAP}`,
      params,
    });
    terms = [];
    params = [];
  };

  for (const g of groups) {
    let remaining = g.values;
    while (remaining.length) {
      if (params.length >= MAX_PARAMS) flush();
      const budget = MAX_PARAMS - params.length;
      const chunk = remaining.slice(0, budget);
      remaining = remaining.slice(budget);
      terms.push(`(${g.column} IN (${chunk.map(() => "?").join(",")}) AND ${g.column} <> '')`);
      params.push(...chunk);
    }
  }
  flush();

  return queries;
}

/**
 * Run the whole batch's queries and return the deduplicated row superset.
 *
 * Fired concurrently, not awaited one at a time: they are independent
 * SELECTs, and a sequential loop was measured to stack D1 round-trip latency
 * (342ms for the worst-case 14-query batch) where Promise.all measured 82ms
 * for the same batch — see the G1 report. Shared by the HTTP handler and the
 * MCP tool so the fan-out/dedup logic exists once.
 */
export async function runBatchQueries(
  db: Env["DB"], queries: BatchQuery[],
): Promise<ExclusionRow[]> {
  const chunkResults = await Promise.all(
    queries.map((q) => db.prepare(q.sql).bind(...q.params).all<ExclusionRow>()),
  );
  const seen = new Map<string, ExclusionRow>();
  for (const { results } of chunkResults) {
    for (const r of results ?? []) seen.set(r.id, r);
  }
  return [...seen.values()];
}

export interface BatchResultItem {
  ref: string | null;
  query: {
    name: string | null; npi: string | null; dob: string | null;
    state: string | null; uei: string | null; cage: string | null;
  };
  error?: string;
  verdict?: string;
  confidence?: string;
  basis?: string | null;
  match_count?: number;
  subject_count?: number;
  truncated?: boolean;
  matches?: unknown[];
}

function queryEcho(item: BatchItem) {
  return {
    name: item.name ?? null, npi: item.npi ?? null, dob: item.dob ?? null,
    state: item.state ?? null, uei: item.uei ?? null, cage: item.cage ?? null,
  };
}

/** Cap mirrors /v1/check's brief detail level, per the spec's "same shape". */
const MATCHES_SHOWN = 5;

/**
 * Assemble one result per input item, in input order, from the shared row
 * superset. classify() is the same function /v1/check uses — reused, not
 * reimplemented — run once per item over rows already in memory.
 */
export function assembleResults(
  validated: ValidatedItem[], rows: ExclusionRow[],
): BatchResultItem[] {
  return validated.map(({ item, ok, error }) => {
    const ref = item.ref ?? null;
    if (!ok) return { ref, query: queryEcho(item), error };

    const matches: MatchedRow[] = classify(rows, item);
    const cap = MATCHES_SHOWN;
    const shown = matches.slice(0, cap);

    return {
      ref,
      query: queryEcho(item),
      verdict: verdictOf(matches),
      confidence: overallConfidence(matches),
      basis: overallBasis(matches),
      match_count: matches.length,
      subject_count: subjectCount(matches),
      truncated: shown.length < matches.length,
      matches: shown.map((m) => ({
        confidence: m.confidence,
        basis: m.basis,
        matched_on: m.matched_on,
        record: briefRecord(m.row),
      })),
    };
  });
}

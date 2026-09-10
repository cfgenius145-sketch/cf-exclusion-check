/**
 * Matching.
 *
 * Every result carries the reason it matched. A screening answer that cannot be
 * explained is worse than no answer, because the caller may act on it.
 *
 * Confidence ladder, strongest first:
 *   strong  NPI equality. An NPI is a unique federal identifier.
 *   match   normalized last + first equal, or normalized business name equal.
 *   weak    normalized last equal AND first initial equal. Common surnames make
 *           this a lead, not a finding.
 *   none    nothing.
 *
 * State, when supplied, never creates a match; it only raises weak -> match by
 * corroborating. It is not used to exclude, because a person can be excluded in
 * one state and living in another.
 */
import {
  candidateNamePairs,
  fullKey,
  normalizeBusiness,
  normalizeNpi,
  normalizeState,
  normalizeName,
} from "./normalize";

export type Confidence = "strong" | "match" | "weak" | "none";

export interface ExclusionRow {
  id: string;
  source: string;
  last_name: string | null;
  first_name: string | null;
  mid_name: string | null;
  bus_name: string | null;
  general: string | null;
  /** Optional: only /v1/report selects it, so fixtures may omit it. */
  upin?: string | null;
  specialty: string | null;
  npi: string | null;
  dob: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  excl_type: string | null;
  excl_date: string | null;
  reinstate_date: string | null;
  waiver_date: string | null;
  waiver_state: string | null;
}

/**
 * What the match was actually built on.
 *
 * Recorded separately from `confidence` because the two answer different
 * questions. Confidence says how strong the evidence is; basis says what KIND
 * of evidence it is, and only a complete identifier — an NPI, a full personal
 * name, or a business name — can support a verdict of "excluded". A surname
 * plus a first initial cannot, however much other context agrees with it.
 */
export type MatchBasis = "npi" | "business_name" | "full_name" | "surname_initial";

export interface MatchedRow {
  row: ExclusionRow;
  confidence: Confidence;
  basis: MatchBasis;
  matched_on: string;
}

export interface Query {
  name?: string;
  npi?: string;
  dob?: string;
  state?: string;
}

const RANK: Record<Confidence, number> = { strong: 3, match: 2, weak: 1, none: 0 };

/** Reject queries that are really attempts to enumerate the dataset. */
export function validateQuery(q: Query): { ok: true } | { ok: false; error: string } {
  const name = (q.name ?? "").trim();
  const npi = normalizeNpi(q.npi);

  // Checked before the "nothing supplied" case: a caller who sent npi=12345
  // did supply something, and telling them to supply an npi hides the actual
  // problem with the one they sent.
  if (q.npi && !npi) {
    return { ok: false, error: "npi must be exactly 10 digits" };
  }
  if (!name && !npi) {
    return { ok: false, error: "provide name, or npi, or both" };
  }
  if (name && /[*%_?]/.test(name)) {
    return { ok: false, error: "wildcards are not supported; supply a specific name" };
  }
  if (name && normalizeName(name).replace(/ /g, "").length < 3) {
    return { ok: false, error: "name must contain at least 3 letters" };
  }
  return { ok: true };
}

/**
 * Build the candidate SQL and parameters.
 *
 * Kept as a single UNION so one D1 query covers every strategy — the free plan
 * allows only 50 D1 queries per Worker invocation, so a query per strategy
 * would be wasteful.
 */
export function buildCandidateQuery(q: Query): { sql: string; params: string[] } {
  // Street address is deliberately NOT selected. It is never returned by any
  // endpoint, and not fetching it keeps it out of logs and error dumps.
  const cols = `id, source, last_name, first_name, mid_name, bus_name, general,
    specialty, upin, npi, dob, city, state, zip, excl_type, excl_date,
    reinstate_date, waiver_date, waiver_state`;

  const clauses: string[] = [];
  const params: string[] = [];

  const npi = normalizeNpi(q.npi);
  if (npi) {
    clauses.push(`SELECT ${cols} FROM exclusions WHERE npi = ?`);
    params.push(npi);
  }

  const name = (q.name ?? "").trim();
  if (name) {
    const bus = normalizeBusiness(name);
    if (bus) {
      clauses.push(`SELECT ${cols} FROM exclusions WHERE n_bus = ?`);
      params.push(bus);
    }
    for (const pair of candidateNamePairs(name)) {
      const key = fullKey(pair.last, pair.first);
      if (key) {
        clauses.push(`SELECT ${cols} FROM exclusions WHERE n_full = ?`);
        params.push(key);
      }
      if (pair.last) {
        clauses.push(`SELECT ${cols} FROM exclusions WHERE n_last = ?`);
        params.push(pair.last);
      }
    }
  }

  // Bound-parameter ceiling on the free plan is 100; we are far below it, but
  // cap the strategy count so a pathological query cannot blow past it.
  const capped = clauses.slice(0, 12);
  const cappedParams = params.slice(0, 12);

  return {
    sql: `${capped.join("\nUNION\n")}\nLIMIT 200`,
    params: cappedParams,
  };
}

/** Classify each candidate row against the query, discarding non-matches. */
export function classify(rows: ExclusionRow[], q: Query): MatchedRow[] {
  const qNpi = normalizeNpi(q.npi);
  const qState = normalizeState(q.state);
  const name = (q.name ?? "").trim();
  const qBus = normalizeBusiness(name);
  const pairs = candidateNamePairs(name);

  const out: MatchedRow[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.id)) continue;

    let best: Confidence = "none";
    let basis: MatchBasis = "surname_initial";
    let why = "";

    const rowNpi = normalizeNpi(row.npi);
    if (qNpi && rowNpi && qNpi === rowNpi) {
      best = "strong";
      basis = "npi";
      why = `npi equals ${rowNpi}`;
    }

    if (RANK[best] < RANK.match && qBus && normalizeBusiness(row.bus_name) === qBus) {
      best = "match";
      basis = "business_name";
      why = "business name equals query";
    }

    if (RANK[best] < RANK.match) {
      const rowFull = fullKey(row.last_name, row.first_name);
      for (const p of pairs) {
        const key = fullKey(p.last, p.first);
        if (key && rowFull && key === rowFull) {
          best = "match";
          basis = "full_name";
          why = `last+first equals "${key}" (read as last="${p.last}", first="${p.first}")`;
          break;
        }
      }
    }

    if (RANK[best] < RANK.weak) {
      const rowLast = normalizeName(row.last_name);
      const rowFirstInitial = normalizeName(row.first_name).charAt(0);
      for (const p of pairs) {
        if (p.last && rowLast && p.last === rowLast) {
          const qInitial = p.first.charAt(0);
          if (qInitial && rowFirstInitial && qInitial === rowFirstInitial) {
            best = "weak";
            basis = "surname_initial";
            why = `last name equals "${rowLast}" and first initial "${qInitial}" agrees`;
            break;
          }
        }
      }
    }

    if (best === "none") continue;

    // State corroboration raises confidence but never changes the basis, so a
    // surname+initial hit can reach "match" confidence yet still cannot produce
    // an "excluded" verdict. Agreeing on a state shared by millions of people
    // is corroboration, not identification. State never demotes or excludes,
    // because a person excluded in one state may live in another.
    if (best === "weak" && qState && normalizeState(row.state) === qState) {
      best = "match";
      why += `; state ${qState} agrees (corroborating only — the name match is ` +
             `still surname plus first initial)`;
    }

    seen.add(row.id);
    out.push({ row, confidence: best, basis, matched_on: why });
  }

  out.sort((a, b) => RANK[b.confidence] - RANK[a.confidence]);
  return out;
}

/** Highest confidence present in a result set. */
export function overallConfidence(matches: MatchedRow[]): Confidence {
  let best: Confidence = "none";
  for (const m of matches) if (RANK[m.confidence] > RANK[best]) best = m.confidence;
  return best;
}

/** A row is currently excluded when it has no reinstatement date. */
export function isCurrentlyExcluded(row: ExclusionRow): boolean {
  const rein = (row.reinstate_date ?? "").replace(/\D/g, "");
  return !(rein.length === 8 && rein !== "00000000");
}

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
  normalizeCage,
  normalizeNpi,
  normalizeState,
  normalizeName,
  normalizeUei,
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
  /** SAM.gov identifiers and metadata; absent on LEIE rows. */
  uei?: string | null;
  cage?: string | null;
  duns?: string | null;
  classification?: string | null;
  program?: string | null;
  agency_code?: string | null;
  agency_name?: string | null;
  record_status?: string | null;
  termination_date?: string | null;
  country?: string | null;
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
export type MatchBasis =
  | "npi" | "uei" | "cage" | "business_name" | "full_name" | "surname_initial";

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
  /** SAM.gov organisation identifiers. */
  uei?: string;
  cage?: string;
}

const RANK: Record<Confidence, number> = { strong: 3, match: 2, weak: 1, none: 0 };

/** Reject queries that are really attempts to enumerate the dataset. */
export function validateQuery(q: Query): { ok: true } | { ok: false; error: string } {
  const name = (q.name ?? "").trim();
  const npi = normalizeNpi(q.npi);
  const uei = normalizeUei(q.uei);
  const cage = normalizeCage(q.cage);

  // Malformed identifiers are reported before the "nothing supplied" case: a
  // caller who sent npi=12345 did supply something, and telling them to supply
  // an npi hides the actual problem with the one they sent.
  if (q.npi && !npi) {
    return { ok: false, error: "npi must be exactly 10 digits" };
  }
  if (q.uei && !uei) {
    return { ok: false, error: "uei must be exactly 12 alphanumeric characters" };
  }
  if (q.cage && !cage) {
    return { ok: false, error: "cage must be exactly 5 alphanumeric characters" };
  }
  if (!name && !npi && !uei && !cage) {
    return { ok: false, error: "provide name, npi, uei, or cage" };
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
 * ONE SELECT with OR/IN, not a UNION of per-strategy SELECTs.
 *
 * The UNION form looked tidier but was unshippable: D1 caps a compound SELECT
 * at 5 terms, and the clause count grows with the name. "Jamsheed Abadi"
 * produced exactly 5 and worked, which is why it survived every early test —
 * but "Mary Jane Smith" produces 7, and a two-part name plus an NPI produces 6.
 * Both failed outright with "too many terms in compound SELECT: SQLITE_ERROR".
 * Ordinary three-part names are not an edge case.
 *
 * OR/IN has no term ceiling, and SQLite still uses the indexes: each disjunct is
 * a separate index lookup combined with OR-by-union-of-rowids. Only one D1 query
 * is spent either way, which matters because the free plan allows 50 per
 * invocation.
 *
 * An empty value is never bound. Binding '' for a missing NPI would match every
 * row whose NPI is absent — about 75,000 of them — which is both wrong and the
 * kind of thing that silently burns the daily row-read budget.
 */
export function buildCandidateQuery(q: Query): { sql: string; params: string[] } {
  const cols = `id, source, last_name, first_name, mid_name, bus_name, general,
    specialty, upin, npi, dob, city, state, zip, excl_type, excl_date,
    reinstate_date, waiver_date, waiver_state, uei, cage, duns, classification,
    program, agency_code, agency_name, record_status, termination_date,
    country`;

  const terms: string[] = [];
  const params: string[] = [];

  // Each identifier term carries its `<> ''` predicate explicitly. The columns
  // are indexed by PARTIAL indexes, and SQLite only uses one when the query
  // provably implies its predicate — a bare `npi = ?` with a bound parameter
  // does not, and silently full-scans (that was the 0004 bug).
  const npi = normalizeNpi(q.npi);
  if (npi) {
    terms.push("(npi = ? AND npi <> '')");
    params.push(npi);
  }

  const uei = normalizeUei(q.uei);
  if (uei) {
    terms.push("(uei = ? AND uei <> '')");
    params.push(uei);
  }

  const cage = normalizeCage(q.cage);
  if (cage) {
    terms.push("(cage = ? AND cage <> '')");
    params.push(cage);
  }

  const name = (q.name ?? "").trim();
  if (name) {
    const bus = normalizeBusiness(name);
    if (bus) {
      terms.push("(n_bus = ? AND n_bus <> '')");
      params.push(bus);
    }

    const fullKeys: string[] = [];
    const lastKeys: string[] = [];
    for (const pair of candidateNamePairs(name)) {
      const key = fullKey(pair.last, pair.first);
      if (key && !fullKeys.includes(key)) fullKeys.push(key);
      if (pair.last && !lastKeys.includes(pair.last)) lastKeys.push(pair.last);
    }

    // Bound so a pathological query cannot inflate the parameter count; D1
    // allows 100 bound parameters per query and we stay far below it.
    const cappedFull = fullKeys.slice(0, 8);
    const cappedLast = lastKeys.slice(0, 8);

    if (cappedFull.length) {
      terms.push(`(n_full IN (${cappedFull.map(() => "?").join(",")}) AND n_full <> '')`);
      params.push(...cappedFull);
    }
    if (cappedLast.length) {
      terms.push(`(n_last IN (${cappedLast.map(() => "?").join(",")}) AND n_last <> '')`);
      params.push(...cappedLast);
    }
  }

  // validateQuery guarantees at least one term, but never emit a bare WHERE
  // that would select the whole table if that ever stopped being true.
  if (!terms.length) {
    return { sql: `SELECT ${cols} FROM exclusions WHERE 0 LIMIT 0`, params: [] };
  }

  return {
    sql: `SELECT ${cols} FROM exclusions WHERE ${terms.join(" OR ")} LIMIT 200`,
    params,
  };
}

/** Classify each candidate row against the query, discarding non-matches. */
export function classify(rows: ExclusionRow[], q: Query): MatchedRow[] {
  const qNpi = normalizeNpi(q.npi);
  const qUei = normalizeUei(q.uei);
  const qCage = normalizeCage(q.cage);
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

    // UEI and CAGE are registry-assigned unique identifiers for an
    // organisation, so an equality hit is as strong as an NPI hit is for a
    // person. Checked before names, because an identifier beats a string.
    if (RANK[best] < RANK.strong) {
      const rowUei = normalizeUei(row.uei);
      if (qUei && rowUei && qUei === rowUei) {
        best = "strong";
        basis = "uei";
        why = `uei equals ${rowUei}`;
      }
    }
    if (RANK[best] < RANK.strong) {
      const rowCage = normalizeCage(row.cage);
      if (qCage && rowCage && qCage === rowCage) {
        best = "strong";
        basis = "cage";
        why = `cage equals ${rowCage}`;
      }
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

/**
 * Is this record an exclusion that is still in force?
 *
 * The two sources say "no longer excluded" in different ways, and neither
 * answer can be derived from the other:
 *
 *   LEIE  carries a reinstatement date. Present => reinstated => not excluded.
 *   SAM   carries a record status and a termination date. The termination date
 *         is when the exclusion is scheduled to END, and is usually absent
 *         (indefinite) or far in the future — year 2227 is used as an
 *         indefinite placeholder. Of 168,452 records only 12 have a
 *         termination date in the past.
 *
 * Anything not positively known to have ended is treated as still in force.
 * Erring the other way would report an excluded party as clear.
 */
export function isCurrentlyExcluded(row: ExclusionRow, today?: string): boolean {
  const rein = (row.reinstate_date ?? "").replace(/\D/g, "");
  if (rein.length === 8 && rein !== "00000000") return false;

  // Absent on LEIE rows, so only SAM rows are affected by these two checks.
  const status = (row.record_status ?? "").trim().toUpperCase();
  if (status && status !== "ACTIVE") return false;

  const term = (row.termination_date ?? "").replace(/\D/g, "");
  if (term.length === 8 && term !== "00000000") {
    const now = today ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
    if (term < now) return false;
  }

  return true;
}

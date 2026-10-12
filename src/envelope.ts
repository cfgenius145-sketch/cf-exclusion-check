/**
 * The CF Soft envelope — shared v2 response shape, query normalisers, and
 * identifier-shape validators. See ../docs/ENVELOPE.md for the spec this
 * implements and the reasoning behind every rule below.
 *
 * DISTRIBUTION: this file is vendored, not published as a package. Each
 * booth keeps its own copy under its own src/. There is no private
 * registry for this account, and standing one up was judged out of scope
 * for a same-day retrofit (ENVELOPE.md §1.5). Changes here must be
 * re-copied into every booth by hand.
 */

// ---------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------

/**
 * The one genuinely shared enum. Every booth's confidence values mean
 * this, identically. Unlike `verdict` (booth-declared, see EnvelopeResponse
 * below), this is not customisable — ENVELOPE.md §1.3 explains why.
 */
export type Confidence = "strong" | "match" | "weak" | "none";

export const CONFIDENCE_VALUES: readonly Confidence[] = ["strong", "match", "weak", "none"];

/**
 * The fixed table of named identifier types from ENVELOPE.md §1.2. A booth
 * declares which of these it supports; an identifier concept not in this
 * table yet uses the `id_type`/`id` escape hatch rather than inventing a
 * new top-level query parameter name.
 */
export type IdentifierType =
  | "npi" | "uei" | "cage" | "cik" | "ein" | "license" | "vin" | "address" | "package";

export const IDENTIFIER_TYPES: readonly IdentifierType[] =
  ["npi", "uei", "cage", "cik", "ein", "license", "vin", "address", "package"];

// ---------------------------------------------------------------------
// Query grammar
// ---------------------------------------------------------------------

/**
 * Every subject field and qualifier a caller might send, per ENVELOPE.md
 * §1.2. A booth accepts whichever subset applies to its domain; unused
 * fields are simply absent, never forced to null on the *request* side
 * (the *response*'s echoed `query` object is where absent fields become
 * explicit nulls — see buildEnvelope).
 */
export interface EnvelopeQuery {
  // subject fields
  name?: string;
  org?: string;
  npi?: string;
  uei?: string;
  cage?: string;
  cik?: string;
  ein?: string;
  license?: string;
  vin?: string;
  address?: string;
  package?: string;
  id_type?: string;
  id?: string;

  // qualifiers
  state?: string;
  dob?: string;
  county?: string;
  ecosystem?: string;

  // controls
  limit?: number;
  as_of?: string;
}

// ---------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------

export interface EnvelopeSource {
  name: string;
  as_of: string;
  url: string;
  /** Booth-specific extras (row counts, load completeness, staleness
   * flags, …) are additive and appear alongside these three. */
  [extra: string]: unknown;
}

/**
 * The v2 response shape. `TVerdict` is a generic parameter, not a fixed
 * union — per ENVELOPE.md's G1 decision, what's shared across booths is
 * the SHAPE (there is always a verdict/confidence/basis/sources/limits/
 * as_of), not the WORDS a verdict may take. Each booth instantiates this
 * with its own literal-string union, e.g.
 *   EnvelopeResponse<"excluded" | "possible_match" | "reinstated_only" | "no_match", ExclusionRecord>
 */
export interface EnvelopeResponse<TVerdict extends string = string, TRecord = unknown> {
  service: string;
  version: "2";
  query: Record<string, unknown>;
  verdict: TVerdict;
  confidence: Confidence;
  basis: string | null;
  counts: { records: number; subjects: number };
  records: TRecord[];
  sources: EnvelopeSource[];
  limits: string[];
  as_of: string;
  /** Booth-specific aggregate figures that describe the QUERY rather than
   * any one record (e.g. enforcement-check's last_90_days/last_12_months
   * activity counts). Optional; omit when there is nothing of the kind. */
  stats?: Record<string, unknown>;
}

export interface ErrorBody {
  error: string;
  message: string;
  field?: string;
  [extra: string]: unknown;
}

function earliestAsOf(sources: EnvelopeSource[]): string {
  if (!sources.length) return new Date().toISOString();
  return sources
    .map((s) => s.as_of)
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .sort()[0] ?? new Date().toISOString();
}

/**
 * Assemble a v2 envelope from named parts. Computes `version` and the
 * top-level `as_of` (earliest of the given sources' `as_of`) so no booth
 * has to reimplement that rule by hand.
 */
export function buildEnvelope<TVerdict extends string, TRecord>(parts: {
  service: string;
  query: Record<string, unknown>;
  verdict: TVerdict;
  confidence: Confidence;
  basis: string | null;
  records: TRecord[];
  subjectCount: number;
  sources: EnvelopeSource[];
  limits: string[];
  stats?: Record<string, unknown>;
}): EnvelopeResponse<TVerdict, TRecord> {
  return {
    service: parts.service,
    version: "2",
    query: parts.query,
    verdict: parts.verdict,
    confidence: parts.confidence,
    basis: parts.basis,
    counts: { records: parts.records.length, subjects: parts.subjectCount },
    records: parts.records,
    sources: parts.sources,
    limits: parts.limits,
    as_of: earliestAsOf(parts.sources),
    ...(parts.stats ? { stats: parts.stats } : {}),
  };
}

export interface EnvelopeValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Assert a candidate response conforms to the v2 shape. Every booth's own
 * test suite calls this on its own v2 output, passing its own verdict
 * vocabulary — this function does not know or care what words a booth
 * uses for `verdict`, only that the value supplied is one of them.
 */
export function assertEnvelope(obj: unknown, allowedVerdicts: readonly string[]): EnvelopeValidation {
  const errors: string[] = [];
  const push = (msg: string) => errors.push(msg);

  if (!obj || typeof obj !== "object") {
    return { ok: false, errors: ["response is not an object"] };
  }
  const r = obj as Record<string, unknown>;

  if (typeof r.service !== "string" || !r.service) push("service must be a non-empty string");
  if (r.version !== "2") push('version must be exactly "2"');
  if (!r.query || typeof r.query !== "object") push("query must be an object");

  if (typeof r.verdict !== "string" || !allowedVerdicts.includes(r.verdict)) {
    push(`verdict must be one of ${JSON.stringify(allowedVerdicts)}, got ${JSON.stringify(r.verdict)}`);
  }
  if (typeof r.confidence !== "string" || !CONFIDENCE_VALUES.includes(r.confidence as Confidence)) {
    push(`confidence must be one of ${JSON.stringify(CONFIDENCE_VALUES)}, got ${JSON.stringify(r.confidence)}`);
  }
  if (r.basis !== null && typeof r.basis !== "string") push("basis must be a string or null");

  const counts = r.counts as Record<string, unknown> | undefined;
  if (!counts || typeof counts !== "object") {
    push("counts must be an object");
  } else {
    if (typeof counts.records !== "number" || counts.records < 0) push("counts.records must be a non-negative number");
    if (typeof counts.subjects !== "number" || counts.subjects < 0) push("counts.subjects must be a non-negative number");
  }

  if (!Array.isArray(r.records)) push("records must be an array");

  if (!Array.isArray(r.sources) || r.sources.length === 0) {
    push("sources must be a non-empty array");
  } else {
    r.sources.forEach((s, i) => {
      const src = s as Record<string, unknown>;
      if (!src || typeof src !== "object") { push(`sources[${i}] must be an object`); return; }
      if (typeof src.name !== "string" || !src.name) push(`sources[${i}].name must be a non-empty string`);
      if (typeof src.as_of !== "string" || !src.as_of) push(`sources[${i}].as_of must be a non-empty string`);
      if (typeof src.url !== "string" || !src.url) push(`sources[${i}].url must be a non-empty string`);
    });
  }

  if (!Array.isArray(r.limits) || r.limits.some((l) => typeof l !== "string")) {
    push("limits must be an array of strings");
  }

  if (typeof r.as_of !== "string" || !r.as_of) push("as_of must be a non-empty string");

  if (r.stats !== undefined && (typeof r.stats !== "object" || r.stats === null || Array.isArray(r.stats))) {
    push("stats, when present, must be an object");
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------
// Normalisers — genuinely domain-general, not booth-specific matching
// logic (which stays in each booth per ENVELOPE.md §1.5).
// ---------------------------------------------------------------------

/** Generational suffixes dropped from personal names. */
const NAME_SUFFIXES = new Set(["JR", "SR", "II", "III", "IV", "V", "VI"]);

/** Uppercase, remove punctuation, collapse whitespace. Shared base for
 * both normalizeName and normalizeBusiness. */
export function normalizeBase(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .toUpperCase()
    .replace(/[.,'"`’]/g, "")
    .replace(/[^A-Z0-9&\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalize a personal name and drop generational suffixes. */
export function normalizeName(input: string | null | undefined): string {
  const base = normalizeBase(input);
  if (!base) return "";
  return base.split(" ").filter((p) => p && !NAME_SUFFIXES.has(p)).join(" ");
}

/** Normalize a business/organization name. Corporate suffixes (LLC, INC,
 * …) are deliberately NOT stripped — "X CARE LLC" and "X CARE INC" are
 * different legal entities and collapsing them would invent matches. */
export function normalizeBusiness(input: string | null | undefined): string {
  return normalizeBase(input);
}

/** Two-letter US state code, or '' if not exactly that shape. */
export function normalizeState(input: string | null | undefined): string {
  const s = normalizeBase(input).replace(/[^A-Z]/g, "");
  return s.length === 2 ? s : "";
}

/** YYYYMMDD, or '' if not exactly that shape (all-zero treated as absent). */
export function normalizeDob(input: string | null | undefined): string {
  const d = (input ?? "").replace(/\D/g, "");
  if (d.length !== 8 || d === "00000000") return "";
  return d;
}

/** 10-digit National Provider Identifier, or '' (all-zero is the LEIE
 * placeholder for "no NPI" and must never be treated as a real value). */
export function normalizeNpi(input: string | null | undefined): string {
  const d = (input ?? "").replace(/\D/g, "");
  if (d.length !== 10 || /^0+$/.test(d)) return "";
  return d;
}

/** SAM.gov Unique Entity Identifier: exactly 12 alphanumeric characters. */
export function normalizeUei(input: string | null | undefined): string {
  const s = (input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 12 ? s : "";
}

/** CAGE code: exactly 5 alphanumeric characters. */
export function normalizeCage(input: string | null | undefined): string {
  const s = (input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 5 ? s : "";
}

/** SEC Central Index Key: 1-10 digits. Not zero-padded here — a booth may
 * canonicalize further (e.g. left-pad to 10) if its own source data does. */
export function normalizeCik(input: string | null | undefined): string {
  const d = (input ?? "").replace(/\D/g, "");
  return d.length >= 1 && d.length <= 10 ? d : "";
}

/** Employer Identification Number: 9 digits (conventionally NN-NNNNNNN). */
export function normalizeEin(input: string | null | undefined): string {
  const d = (input ?? "").replace(/\D/g, "");
  return d.length === 9 ? d : "";
}

/** Vehicle Identification Number: exactly 17 alphanumeric characters. This
 * does not enforce the VIN check-digit or the I/O/Q exclusion — a booth
 * screening against a specific registry should apply that registry's own
 * stricter rule if it needs one. */
export function normalizeVin(input: string | null | undefined): string {
  const s = (input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 17 ? s : "";
}

/** A license/registration number. Shape varies enormously by issuing
 * authority and license type, so this only trims and uppercases — a booth
 * with a specific license format validates it further itself. */
export function normalizeLicense(input: string | null | undefined): string {
  return (input ?? "").trim().toUpperCase();
}

/** A street address. Free text; only whitespace-collapsed. */
export function normalizeAddress(input: string | null | undefined): string {
  return (input ?? "").trim().replace(/\s+/g, " ");
}

/** A software package name. Only trims — ecosystem-specific rules (npm
 * scoped names, PyPI PEP 503 normalization, WordPress.org slugs) differ
 * enough that they stay in the booth that needs them. */
export function normalizePackageName(input: string | null | undefined): string {
  return (input ?? "").trim();
}

/**
 * Name normalization.
 *
 * Deliberately conservative and explainable: uppercase, strip punctuation,
 * drop generational suffixes, collapse whitespace. No phonetic algorithms and
 * no edit distance — a screening result has to be defensible to the person it
 * is about, and "sounds a bit like" is not defensible.
 */

/** Generational suffixes dropped from personal names. */
const SUFFIXES = new Set([
  "JR", "SR", "II", "III", "IV", "V", "VI",
]);

/**
 * Corporate suffixes are NOT stripped. "SMITH CARE LLC" and "SMITH CARE INC"
 * are different legal entities and collapsing them would invent matches.
 */

/** Uppercase, remove punctuation, collapse whitespace. */
export function normalizeBase(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .toUpperCase()
    .replace(/[.,'"`’]/g, "")
    .replace(/[^A-Z0-9&\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalize a personal name part and drop generational suffixes. */
export function normalizeName(input: string | null | undefined): string {
  const base = normalizeBase(input);
  if (!base) return "";
  const parts = base.split(" ").filter((p) => p && !SUFFIXES.has(p));
  return parts.join(" ");
}

/** Normalize a business name. Corporate suffixes are preserved. */
export function normalizeBusiness(input: string | null | undefined): string {
  return normalizeBase(input);
}

/** "LAST FIRST" key used for the strongest name match. */
export function fullKey(
  last: string | null | undefined,
  first: string | null | undefined,
): string {
  const l = normalizeName(last);
  const f = normalizeName(first);
  if (!l && !f) return "";
  return `${l} ${f}`.trim();
}

/**
 * Digits only. LEIE writes 0000000000 for "no NPI", which must never match a
 * caller's query, so it is treated as absent.
 */
export function normalizeNpi(input: string | null | undefined): string {
  const d = (input ?? "").replace(/\D/g, "");
  if (d.length !== 10) return "";
  if (/^0+$/.test(d)) return "";
  return d;
}

/** YYYYMMDD or ''. LEIE uses 00000000 for "none". */
export function normalizeDate(input: string | null | undefined): string {
  const d = (input ?? "").replace(/\D/g, "");
  if (d.length !== 8) return "";
  if (d === "00000000") return "";
  return d;
}

/** Two-letter state code or ''. */
export function normalizeState(input: string | null | undefined): string {
  const s = normalizeBase(input).replace(/[^A-Z]/g, "");
  return s.length === 2 ? s : "";
}

/**
 * Split a free-text query name into candidate (last, first) pairs.
 *
 * Callers send "John Smith" or "Smith, John" or a business name. Rather than
 * guess, both personal orderings are produced and tried; whichever matches is
 * reported, and the ordering used is included in the evidence.
 */
export function candidateNamePairs(query: string): Array<{ last: string; first: string }> {
  const n = normalizeName(query);
  if (!n) return [];

  if (query.includes(",")) {
    const [a, b] = query.split(",", 2);
    const last = normalizeName(a);
    const first = normalizeName(b);
    if (last) return [{ last, first }];
  }

  const parts = n.split(" ").filter(Boolean);
  if (parts.length === 1) return [{ last: parts[0], first: "" }];

  const first = parts[0];
  const last = parts[parts.length - 1];
  const firstAlt = parts.slice(0, -1).join(" ");

  return [
    { last, first },                                   // "John Smith"
    { last: parts[0], first: parts.slice(1).join(" ") }, // "Smith John"
    { last, first: firstAlt },                          // multi-part given name
  ].filter((p, i, arr) =>
    arr.findIndex((q) => q.last === p.last && q.first === p.first) === i,
  );
}

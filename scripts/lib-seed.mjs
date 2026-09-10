/**
 * Shared seed-building helpers.
 *
 * Used by build-seed.mjs (the full LEIE active list) and build-rein-seed.mjs
 * (the monthly reinstatement supplements). Both files carry the identical
 * 18-column LEIE schema, so they share one row mapper — keeping them in step
 * matters, because a normalization difference between the two would make a
 * reinstated person fail to match a query that finds their exclusion.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Minimal RFC4180 CSV parser: handles quoted fields and embedded commas. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// --- normalization: must stay in step with src/normalize.ts -----------------
const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV", "V", "VI"]);

export const normBase = (s) =>
  (s ?? "").toUpperCase()
    .replace(/[.,'"`’]/g, "")
    .replace(/[^A-Z0-9&\- ]/g, " ")
    .replace(/\s+/g, " ").trim();

export const normName = (s) =>
  normBase(s).split(" ").filter((p) => p && !SUFFIXES.has(p)).join(" ");

export const normNpi = (s) => {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length === 10 && !/^0+$/.test(d) ? d : "";
};

export const normDate = (s) => {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length === 8 && d !== "00000000" ? d : "";
};

/** SQL string literal. */
export const q = (v) => `'${String(v ?? "").replace(/'/g, "''")}'`;

export const COLS =
  `id,source,last_name,first_name,mid_name,bus_name,general,specialty,upin,npi,` +
  `dob,address,city,state,zip,excl_type,excl_date,reinstate_date,waiver_date,` +
  `waiver_state,n_last,n_first,n_full,n_bus,load_id,raw_json,loaded_at`;

export const REQUIRED_COLUMNS =
  ["LASTNAME", "FIRSTNAME", "BUSNAME", "NPI", "EXCLTYPE", "EXCLDATE"];

/** Build a column-name -> index map from the header actually present. */
export function indexHeader(headerRow) {
  const header = headerRow.map((h) => h.trim().toUpperCase());
  const ix = {};
  header.forEach((h, i) => { ix[h] = i; });
  for (const r of REQUIRED_COLUMNS) {
    if (!(r in ix)) throw new Error(`LEIE header is missing expected column ${r}`);
  }
  return { header, ix };
}

/**
 * Map one CSV row to a VALUES tuple.
 *
 * The row id hashes the ENTIRE source line rather than a chosen subset of
 * fields. A narrower key (name+npi+excltype+excldate+zip) collapsed 45 rows of
 * the active list, and 19 of those groups were NOT identical lines: LEIE
 * carries near-duplicates differing on address, general, specialty, UPIN or
 * DOB. Two differed on DOB alone (VAZQUEZ DE LLADO 19660717/19660712, VIVANCO
 * 19391106/19401106). Dropping one of a pair would silently discard a date of
 * birth a caller may screen against. Hashing the whole line gives one row per
 * distinct source line and collapses only byte-identical repeats.
 */
export function rowToValues(r, { ix, source, loadId, loadedAt }) {
  const get = (name) => (name in ix ? (r[ix[name]] ?? "") : "");

  const last = get("LASTNAME");
  const first = get("FIRSTNAME");
  const bus = get("BUSNAME");
  if (!last && !first && !bus) return null;

  const nLast = normName(last);
  const nFirst = normName(first);
  const nFull = `${nLast} ${nFirst}`.trim();
  const nBus = normBase(bus);
  const npi = normNpi(get("NPI"));

  const id = createHash("sha256")
    .update(source + "\u0001" + r.join("\u0001"))
    .digest("hex").slice(0, 32);

  const tuple = "(" + [
    q(id), q(source), q(last), q(first), q(get("MIDNAME")), q(bus),
    q(get("GENERAL")), q(get("SPECIALTY")), q(get("UPIN")), q(npi),
    q(normDate(get("DOB"))), q(get("ADDRESS")), q(get("CITY")),
    q(get("STATE")), q(get("ZIP")), q(get("EXCLTYPE")),
    q(normDate(get("EXCLDATE"))), q(normDate(get("REINDATE"))),
    q(normDate(get("WAIVERDATE"))), q(get("WVRSTATE")),
    q(nLast), q(nFirst), q(nFull), q(nBus), q(loadId), "NULL", q(loadedAt),
  ].join(",") + ")";

  return { id, tuple };
}

/** Wrap VALUES tuples into multi-row INSERT statements. */
export function inserts(vals, rowsPerInsert) {
  const out = [];
  for (let i = 0; i < vals.length; i += rowsPerInsert) {
    out.push(
      `INSERT OR REPLACE INTO exclusions (${COLS}) VALUES\n` +
      vals.slice(i, i + rowsPerInsert).join(",\n") + ";",
    );
  }
  return out;
}

/**
 * Write ordered part files.
 *
 * A single 24MB file made `wrangler d1 execute --remote` fail in its
 * post-upload ingest poll ("fetch failed"), so the seed is emitted as ordered
 * parts of a size that applies reliably. Part 00 clears the previous
 * generation for the source; the loads row lands in the final part, so a
 * partial apply shows up in /v1/health rather than being silently accepted.
 */
export function writeParts({
  outDir, prefix, source, loadId, loadedAt, sha256, values,
  sourceLines, dupLines, skipped, rowsPerInsert, rowsPerPart, note,
}) {
  mkdirSync(outDir, { recursive: true });

  const parts = [];
  parts.push([
    `-- CF Exclusion Check seed. source=${source} load_id=${loadId}`,
    `-- csv sha256=${sha256}`,
    `-- source_lines=${sourceLines} stored_rows=${values.length} ` +
      `identical_repeats_collapsed=${dupLines} skipped_blank=${skipped}`,
    `-- part 00: clear previous generation`,
    `DELETE FROM exclusions WHERE source=${q(source)};`,
  ]);

  for (let i = 0; i < values.length; i += rowsPerPart) {
    const n = parts.length;
    const slice = values.slice(i, i + rowsPerPart);
    parts.push([
      `-- ${loadId} part ${String(n).padStart(2, "0")}: rows ${i + 1}-${i + slice.length}`,
      ...inserts(slice, rowsPerInsert),
    ]);
  }

  parts[parts.length - 1].push(
    `INSERT OR REPLACE INTO loads (id,source,loaded_at,row_count,sha256,status,note) ` +
    `VALUES (${q(loadId)},${q(source)},${q(loadedAt)},${values.length},` +
    `${q(sha256)},'complete',${q(note)});`,
  );

  let maxStmt = 0;
  let totalBytes = 0;
  const written = [];

  parts.forEach((lines, n) => {
    const body = lines.join("\n") + "\n";
    const file = join(outDir, `${prefix}.${String(n).padStart(2, "0")}.sql`);
    writeFileSync(file, body);
    written.push(file);
    totalBytes += body.length;
    for (const l of lines) if (l.length > maxStmt) maxStmt = l.length;
  });

  writeFileSync(join(outDir, `${prefix}.MANIFEST.txt`),
    [`load_id=${loadId}`, `source=${source}`, `csv_sha256=${sha256}`,
     `source_lines=${sourceLines}`, `stored_rows=${values.length}`,
     `parts=${written.length}`, ...written].join("\n") + "\n");

  if (maxStmt > 95000) throw new Error("a statement is too close to D1's 100KB cap");
  return { written, maxStmt, totalBytes };
}

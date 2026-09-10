#!/usr/bin/env node
/**
 * Build a D1 seed from the live OIG LEIE active-exclusions list (UPDATED.csv).
 *
 * Why this runs on a workstation rather than inside the Worker: the Workers
 * FREE plan allows 10ms CPU per invocation — cron triggers included — plus 50
 * D1 queries per invocation. Parsing a 15.6MB / 84k-row CSV and writing it to
 * D1 is orders of magnitude past that. The Worker cron handles the small
 * monthly supplements; the bulk generation is built here.
 *
 * Emits SQL with literal values rather than bound parameters, because D1 caps
 * bound parameters at 100 per query and this table has 27 columns.
 *
 * Usage:
 *   node scripts/build-seed.mjs                 # download + build
 *   node scripts/build-seed.mjs --csv path.csv  # build from a local copy
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { indexHeader, parseCsv, rowToValues, writeParts } from "./lib-seed.mjs";

const LEIE_URL = "https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv";
const SOURCE = "leie";
const OUT_DIR = "seed";
const ROWS_PER_INSERT = 50;   // ~16KB per statement, well under D1's 100KB cap
const ROWS_PER_PART = 5000;   // ~1.4MB per file; see writeParts() for why

const argCsv = process.argv.indexOf("--csv");
let csvText;

if (argCsv !== -1 && process.argv[argCsv + 1]) {
  csvText = readFileSync(process.argv[argCsv + 1], "utf8");
  console.log(`  read local CSV: ${process.argv[argCsv + 1]}`);
} else {
  console.log(`  downloading ${LEIE_URL} ...`);
  const res = await fetch(LEIE_URL);
  if (!res.ok) throw new Error(`LEIE fetch failed: ${res.status}`);
  csvText = await res.text();
  console.log(`  downloaded ${csvText.length.toLocaleString()} bytes`);
}

const sha256 = createHash("sha256").update(csvText).digest("hex");
const rows = parseCsv(csvText);
const { header, ix } = indexHeader(rows[0]);
const body = rows.slice(1);

console.log(`  header (${header.length} cols): ${header.join(",")}`);
console.log(`  data rows: ${body.length.toLocaleString()}`);

const loadId = `${SOURCE}-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "")}`;
const loadedAt = new Date().toISOString();

const values = [];
const seenIds = new Set();
let skipped = 0;
let dupLines = 0;

for (const r of body) {
  const mapped = rowToValues(r, { ix, source: SOURCE, loadId, loadedAt });
  if (!mapped) { skipped++; continue; }
  // Byte-identical repeat lines are collapsed here rather than left to
  // INSERT OR REPLACE, so loads.row_count records what the table actually
  // holds. /v1/health reports that number and it must not overstate.
  if (seenIds.has(mapped.id)) { dupLines++; continue; }
  seenIds.add(mapped.id);
  values.push(mapped.tuple);
}

const { written, maxStmt, totalBytes } = writeParts({
  outDir: OUT_DIR, prefix: "leie-seed", source: SOURCE, loadId, loadedAt,
  sha256, values, sourceLines: body.length, dupLines, skipped,
  rowsPerInsert: ROWS_PER_INSERT, rowsPerPart: ROWS_PER_PART,
  note: `bulk seed via scripts/build-seed.mjs; ${body.length} source lines, ` +
        `${dupLines} identical repeats collapsed`,
});

console.log(`  wrote ${written.length} parts to ${OUT_DIR}/ (${(totalBytes / 1e6).toFixed(1)} MB total)`);
console.log(`  source lines : ${body.length.toLocaleString()}`);
console.log(`  stored rows  : ${values.length.toLocaleString()} (${dupLines} identical repeats collapsed, ${skipped} blank skipped)`);
console.log(`  largest stmt : ${maxStmt.toLocaleString()} bytes (D1 cap 100,000)`);
console.log(`  csv sha256   : ${sha256}`);
console.log(`  load_id      : ${loadId}`);

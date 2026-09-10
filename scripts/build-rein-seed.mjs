#!/usr/bin/env node
/**
 * Build a D1 seed from the OIG LEIE monthly REINSTATEMENT supplements.
 *
 * Why these matter for a screening product: UPDATED.csv contains only people
 * and businesses that are CURRENTLY excluded. Someone who has been reinstated
 * simply vanishes from it, so a bare "no match" is technically correct but
 * tells a caller nothing. Loading the reinstatement supplements lets the same
 * query answer the more useful and more defensible thing: "matched — excluded
 * 2011-06-20, reinstated 2026-08-11, NOT currently excluded."
 *
 * File naming was read off the live supplement-downloads page rather than
 * guessed. The obvious guess (/downloadables/0826REIN.csv) 404s; the real
 * pattern is /downloadables/<YYYY>/<YYMM>rein.csv, and the page is the
 * authority on which months actually exist.
 *
 * Usage:
 *   node scripts/build-rein-seed.mjs            # discover + download all
 *   node scripts/build-rein-seed.mjs --limit 6  # only the newest N months
 */
import { createHash } from "node:crypto";
import { indexHeader, parseCsv, rowToValues, writeParts } from "./lib-seed.mjs";

const SUPPLEMENT_PAGE =
  "https://oig.hhs.gov/exclusions/leie-database-supplement-downloads/";
const SOURCE = "leie_rein";
const OUT_DIR = "seed";
const ROWS_PER_INSERT = 50;
const ROWS_PER_PART = 5000;

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : Infinity;

console.log(`  discovering supplements from ${SUPPLEMENT_PAGE} ...`);
const pageRes = await fetch(SUPPLEMENT_PAGE);
if (!pageRes.ok) throw new Error(`supplement page fetch failed: ${pageRes.status}`);
const page = await pageRes.text();

// Only *rein* files; the *excl* supplements are already covered by UPDATED.csv.
const urls = [...new Set(
  [...page.matchAll(/href="(https:\/\/oig\.hhs\.gov\/exclusions\/downloadables\/\d{4}\/\d{4}rein\.csv)"/gi)]
    .map((m) => m[1]),
)].sort();

if (!urls.length) {
  throw new Error(
    "no rein.csv links found on the supplement page — the page layout or the " +
    "URL pattern has changed; re-read the page before assuming a pattern",
  );
}

const chosen = urls.slice(-Math.min(urls.length, limit));
console.log(`  found ${urls.length} reinstatement files, using ${chosen.length}`);
console.log(`  oldest: ${chosen[0].split("/").pop()}  newest: ${chosen[chosen.length - 1].split("/").pop()}`);

const loadId = `${SOURCE}-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "")}`;
const loadedAt = new Date().toISOString();

const values = [];
const seenIds = new Set();
let sourceLines = 0;
let skipped = 0;
let dupLines = 0;
const hashParts = [];
const perFile = [];

for (const url of chosen) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const text = await res.text();
  hashParts.push(`${url} ${createHash("sha256").update(text).digest("hex")}`);

  const rows = parseCsv(text);
  const { ix } = indexHeader(rows[0]);
  const body = rows.slice(1);
  sourceLines += body.length;

  let kept = 0;
  for (const r of body) {
    const mapped = rowToValues(r, { ix, source: SOURCE, loadId, loadedAt });
    if (!mapped) { skipped++; continue; }
    // The same person can appear in more than one monthly file; collapse only
    // byte-identical lines, exactly as the active-list builder does.
    if (seenIds.has(mapped.id)) { dupLines++; continue; }
    seenIds.add(mapped.id);
    values.push(mapped.tuple);
    kept++;
  }
  perFile.push(`${url.split("/").pop()}: ${body.length} lines, ${kept} kept`);
}

// One digest over the concatenated per-file digests, so a change in any month
// changes the recorded sha256 that /v1/health reports.
const sha256 = createHash("sha256").update(hashParts.join("\n")).digest("hex");

const { written, maxStmt, totalBytes } = writeParts({
  outDir: OUT_DIR, prefix: "leie-rein-seed", source: SOURCE, loadId, loadedAt,
  sha256, values, sourceLines, dupLines, skipped,
  rowsPerInsert: ROWS_PER_INSERT, rowsPerPart: ROWS_PER_PART,
  note: `reinstatement supplements via scripts/build-rein-seed.mjs; ` +
        `${chosen.length} monthly files, ${sourceLines} source lines, ` +
        `${dupLines} identical repeats collapsed`,
});

for (const line of perFile) console.log(`    ${line}`);
console.log(`  wrote ${written.length} parts to ${OUT_DIR}/ (${(totalBytes / 1e6).toFixed(2)} MB total)`);
console.log(`  files        : ${chosen.length}`);
console.log(`  source lines : ${sourceLines.toLocaleString()}`);
console.log(`  stored rows  : ${values.length.toLocaleString()} (${dupLines} identical repeats collapsed, ${skipped} blank skipped)`);
console.log(`  largest stmt : ${maxStmt.toLocaleString()} bytes (D1 cap 100,000)`);
console.log(`  digest       : ${sha256}`);
console.log(`  load_id      : ${loadId}`);

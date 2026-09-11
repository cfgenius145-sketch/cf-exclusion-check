#!/usr/bin/env node
/**
 * Build a D1 seed from the SAM.gov Exclusions extract.
 *
 * Why the extract and not the API: the Exclusions API caps `size` at 10 records
 * per page, so 168,452 records would need ~16,846 requests. The published rate
 * limits are 10 requests/day for a personal key with no role and 1,000/day
 * otherwise, so paging is not merely slow — it is impossible. The asynchronous
 * extract returns the whole set in one download.
 *
 * Extract flow (two calls):
 *   GET /entity-information/v4/exclusions?api_key=..&format=json  -> a token
 *   GET /entity-information/v4/download-exclusions?api_key=..&token=..
 * The download is gzip despite the .json naming, and its `totalRecords` field
 * reads 10000 while the file actually contains all 168,452 — the field is wrong,
 * so the record array is counted rather than trusted.
 *
 * Usage:
 *   node scripts/build-sam-seed.mjs                 # use cached extract
 *   node scripts/build-sam-seed.mjs --refresh       # request a new extract
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { normBase, normName, normNpi, writeParts } from "./lib-seed.mjs";

const SOURCE = "sam";
const OUT_DIR = "seed";
const RAW = ".secrets/sam-exclusions.raw";
const GZ = ".secrets/sam-exclusions.json";
const ROWS_PER_INSERT = 40;
const ROWS_PER_PART = 5000;

const q = (v) => `'${String(v ?? "").replace(/'/g, "''")}'`;

/** SAM dates are MM-DD-YYYY; LEIE columns are YYYYMMDD. */
function samDate(v) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(v ?? "").trim());
  if (m) return `${m[3]}${m[1]}${m[2]}`;
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length === 8 && d !== "00000000" ? d : "";
}

const uei = (v) => {
  const s = String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 12 ? s : "";
};
const cage = (v) => {
  const s = String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 5 ? s : "";
};

// --- load the extract -------------------------------------------------------
if (process.argv.includes("--refresh") || (!existsSync(RAW) && !existsSync(GZ))) {
  throw new Error(
    "No cached extract. Request one with:\n" +
    "  curl -s \"https://api.sam.gov/entity-information/v4/exclusions?api_key=$SAM_API_KEY&format=json\"\n" +
    "then download the returned token URL to " + GZ,
  );
}

let text;
if (existsSync(RAW)) {
  text = readFileSync(RAW, "utf8");
  console.log(`  read cached extract: ${RAW}`);
} else {
  console.log(`  decompressing ${GZ} ...`);
  text = gunzipSync(readFileSync(GZ)).toString("utf8");
  writeFileSync(RAW, text);
}

const sha256 = createHash("sha256").update(text).digest("hex");
const parsed = JSON.parse(text);
const records = parsed.excludedEntity ?? [];

console.log(`  declared totalRecords : ${parsed.totalRecords} (WRONG — field is unreliable)`);
console.log(`  actual records        : ${records.length.toLocaleString()}`);

const loadId = `${SOURCE}-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "")}`;
const loadedAt = new Date().toISOString();

const values = [];
const seenIds = new Set();
let dupLines = 0;
let skipped = 0;
const stats = { individual: 0, org: 0, withUei: 0, withCage: 0, withNpi: 0 };

for (const e of records) {
  const det = e.exclusionDetails ?? {};
  const ident = e.exclusionIdentification ?? {};
  const addr = e.exclusionPrimaryAddress ?? {};
  const act = (e.exclusionActions?.listOfActions ?? [])[0] ?? {};

  const classification = det.classificationType ?? "";
  const entityName = (ident.entityName ?? "").trim();
  const last = (ident.lastName ?? "").trim();
  const first = (ident.firstName ?? "").trim();
  const mid = (ident.middleName ?? "").trim();

  if (!entityName && !last && !first) { skipped++; continue; }

  // An individual's name goes in the person columns; an organisation's goes in
  // the business column. Putting a person's name in BOTH would double-count the
  // same subject and inflate match_count, and putting an organisation into the
  // person columns would let a surname+initial rule fire on a company.
  const isIndividual = classification === "Individual";
  let nLast = "", nFirst = "", nFull = "", nBus = "";
  if (isIndividual) {
    nLast = normName(last);
    nFirst = normName(first);
    nFull = `${nLast} ${nFirst}`.trim();
    stats.individual++;
  } else {
    nBus = normBase(entityName);
    stats.org++;
  }
  // A SAM individual whose name only appears in entityName still needs to be
  // findable, so fall back rather than storing an unsearchable row.
  if (isIndividual && !nLast && !nFirst && entityName) {
    nBus = normBase(entityName);
  }

  const u = uei(ident.ueiSAM);
  const c = cage(ident.cageCode);
  const n = normNpi(ident.npi);
  if (u) stats.withUei++;
  if (c) stats.withCage++;
  if (n) stats.withNpi++;

  // Hash the identity-bearing fields of the record. SAM has no single stable
  // record id in the extract, and hashing the whole object would make the id
  // churn on every unrelated field SAM adds.
  const id = createHash("sha256").update([
    SOURCE, classification, entityName, last, first, mid, u, c, n,
    det.exclusionType ?? "", det.excludingAgencyCode ?? "",
    samDate(act.activateDate), addr.zipCode ?? "",
  ].join("")).digest("hex").slice(0, 32);

  if (seenIds.has(id)) { dupLines++; continue; }
  seenIds.add(id);

  values.push("(" + [
    q(id), q(SOURCE), q(last), q(first), q(mid), q(isIndividual ? "" : entityName),
    q(det.exclusionProgram ?? ""), q(det.exclusionType ?? ""), q(""), q(n),
    q(""), q(addr.addressLine1 ?? ""), q(addr.city ?? ""),
    q(addr.stateOrProvinceCode ?? ""), q(addr.zipCode ?? ""),
    q(det.exclusionType ?? ""), q(samDate(act.activateDate)), q(""),
    q(""), q(""),
    q(nLast), q(nFirst), q(nFull), q(nBus), q(loadId), "NULL", q(loadedAt),
    // SAM-specific columns
    q(u), q(c), q(""), q(classification), q(det.exclusionProgram ?? ""),
    q(det.excludingAgencyCode ?? ""), q(det.excludingAgencyName ?? ""),
    q(act.recordStatus ?? ""), q(samDate(act.terminationDate)),
    q(addr.countryCode ?? ""),
  ].join(",") + ")");
}

const COLS =
  "id,source,last_name,first_name,mid_name,bus_name,general,specialty,upin,npi," +
  "dob,address,city,state,zip,excl_type,excl_date,reinstate_date,waiver_date," +
  "waiver_state,n_last,n_first,n_full,n_bus,load_id,raw_json,loaded_at," +
  "uei,cage,duns,classification,program,agency_code,agency_name,record_status," +
  "termination_date,country";

const { written, maxStmt, totalBytes } = writeParts({
  outDir: OUT_DIR, prefix: "sam-seed", source: SOURCE, loadId, loadedAt,
  sha256, values, sourceLines: records.length, dupLines, skipped,
  rowsPerInsert: ROWS_PER_INSERT, rowsPerPart: ROWS_PER_PART,
  note: `SAM.gov exclusions extract via scripts/build-sam-seed.mjs; ` +
        `${records.length} records, ${dupLines} duplicates collapsed`,
  cols: COLS,
});

console.log(`  wrote ${written.length} parts to ${OUT_DIR}/ (${(totalBytes / 1e6).toFixed(1)} MB)`);
console.log(`  stored rows  : ${values.length.toLocaleString()} (${dupLines} dupes, ${skipped} unnamed skipped)`);
console.log(`  individuals  : ${stats.individual.toLocaleString()}  organisations: ${stats.org.toLocaleString()}`);
console.log(`  with uei     : ${stats.withUei.toLocaleString()}  cage: ${stats.withCage.toLocaleString()}  npi: ${stats.withNpi.toLocaleString()}`);
console.log(`  largest stmt : ${maxStmt.toLocaleString()} bytes (D1 cap 100,000)`);
console.log(`  load_id      : ${loadId}`);

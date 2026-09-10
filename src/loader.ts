/**
 * Cron-driven loading.
 *
 * WHAT IS AND IS NOT POSSIBLE HERE, measured rather than assumed:
 *
 * The Workers free plan gives 10ms CPU per invocation (cron triggers included),
 * 50 D1 queries per invocation, and 100 bound parameters per query. The
 * exclusions table has 27 columns, so a write batches at most 3 rows per query
 * (81 params) and ~150 rows per invocation.
 *
 * The full active list (UPDATED.csv) is 15.6MB / 84,001 rows. It cannot be
 * loaded here:
 *   - oig.hhs.gov does not honour Range requests. `Range: bytes=1000000-1010239`
 *     returns HTTP 200 with all 15,608,468 bytes, no accept-ranges, no
 *     content-range. So the file cannot be walked in slices; every invocation
 *     would download all of it.
 *   - Parsing 15.6MB alone is far past 10ms of CPU.
 * The bulk generation is therefore built by scripts/build-seed.mjs and applied
 * with `wrangler d1 execute`. See docs/SOURCES.md.
 *
 * What the cron DOES do, and what genuinely fits the limits:
 *   1. monthlySupplement() — pulls that month's reinstatement supplement
 *      (~8KB, ~41 rows) and exclusion supplement (~38KB, ~200 rows) and merges
 *      them. Small enough to parse and write inside the limits.
 *   2. freshnessProbe() — a HEAD against UPDATED.csv, recording Last-Modified
 *      and Content-Length. No body, negligible CPU. When upstream has moved
 *      past the generation we loaded, reseed_due is set so /v1/health says so
 *      instead of implying the data is current.
 *
 * The supplements add new exclusions and record reinstatements. They do NOT
 * catch a record removed from the list for any other reason — only a full
 * reconcile does, and that needs a reseed.
 */
import type { Env } from "./env";
import { supplementUrl } from "./env";
import { normalizeBase, normalizeDate, normalizeName, normalizeNpi } from "./normalize";

const REQUIRED_COLUMNS = ["LASTNAME", "FIRSTNAME", "BUSNAME", "NPI", "EXCLTYPE", "EXCLDATE"];

/**
 * oig.hhs.gov returns 403 to any request with no User-Agent — verified: a HEAD
 * with an empty UA gets 403 while the identical HEAD with any UA gets 200. The
 * runtime sends no UA by default, so every request here must set one.
 */
const UA = "cf-exclusion-check/1.0 (+https://github.com/cfgenius145-sketch/cf-exclusion-check)";

/** Rows per INSERT: 27 columns x 3 rows = 81 bound params, under D1's 100. */
const ROWS_PER_INSERT = 3;

/**
 * Insert queries spent on rows in one invocation.
 *
 * The free plan allows 50 D1 queries per invocation. Budget: 30 row inserts,
 * plus one progress upsert, plus one `loads` insert on completion, plus up to
 * three cheap progress writes for months that 404, plus two for the freshness
 * probe = 37 worst case. Deliberately not tuned to the ceiling.
 */
const MAX_INSERT_QUERIES_PER_RUN = 30;
const MAX_ROWS_PER_RUN = MAX_INSERT_QUERIES_PER_RUN * ROWS_PER_INSERT; // 90

/** Minimal RFC4180 CSV parser: handles quoted fields and embedded commas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
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

/** sha256 hex of a string, truncated — used for deterministic row ids. */
async function rowId(source: string, cells: string[]): Promise<string> {
  const data = new TextEncoder().encode(source + "\u0001" + cells.join("\u0001"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export interface LoadReport {
  source: string;
  url: string;
  status: "loaded" | "partial" | "done" | "absent" | "failed";
  source_lines: number;
  written: number;
  rows_done: number;
  note: string;
}

/**
 * Merge one monthly supplement file, resuming from wherever the last
 * invocation stopped.
 *
 * Uses INSERT OR REPLACE on the whole-line row id, so re-running a month — or
 * re-processing an overlapping slice after an interrupted run — is idempotent
 * and never duplicates. Unlike the bulk seed this does NOT clear the source
 * first: a supplement is additive by definition, and clearing would discard
 * every earlier month.
 */
export async function loadSupplement(
  env: Env, source: string, url: string,
): Promise<LoadReport> {
  const base: LoadReport = {
    source, url, status: "failed", source_lines: 0, written: 0, rows_done: 0, note: "",
  };

  const prior = await env.DB.prepare(
    `SELECT rows_done, status FROM supplement_progress WHERE url = ?`,
  ).bind(url).first<{ rows_done: number; status: string }>();

  if (prior?.status === "done") {
    return { ...base, status: "done", rows_done: prior.rows_done, note: "already merged" };
  }
  const offset = prior?.rows_done ?? 0;

  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": UA } });
  } catch (e) {
    return { ...base, rows_done: offset, note: `fetch threw: ${String(e)}` };
  }

  if (res.status === 404) {
    // Expected: a month's supplement is published during the following month,
    // so a 404 is normal rather than an error. Recorded so the next invocation
    // can skip past it quickly instead of re-deciding.
    await setProgress(env, url, source, offset, null, "absent", "404 upstream");
    return { ...base, status: "absent", rows_done: offset, note: "not published yet (404)" };
  }
  if (!res.ok) return { ...base, rows_done: offset, note: `HTTP ${res.status}` };

  const text = await res.text();
  const rows = parseCsv(text);
  if (rows.length < 2) return { ...base, rows_done: offset, note: "no data rows" };

  const header = rows[0].map((h) => h.trim().toUpperCase());
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) {
      return { ...base, rows_done: offset, note: `header missing ${col}; upstream format changed` };
    }
  }
  const ix: Record<string, number> = {};
  header.forEach((h, i) => { ix[h] = i; });
  const get = (r: string[], name: string) => (name in ix ? (r[ix[name]] ?? "") : "");

  const body = rows.slice(1);
  const slice = body.slice(offset, offset + MAX_ROWS_PER_RUN);

  if (!slice.length) {
    await setProgress(env, url, source, body.length, body.length, "done", "no rows remaining");
    return {
      ...base, status: "done", source_lines: body.length, rows_done: body.length,
      note: "already at end of file",
    };
  }

  const loadId = `${source}-cron-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "")}`;
  const loadedAt = new Date().toISOString();

  const tuples: unknown[][] = [];
  for (const r of slice) {
    const last = get(r, "LASTNAME");
    const first = get(r, "FIRSTNAME");
    const bus = get(r, "BUSNAME");
    if (!last && !first && !bus) continue;

    const nLast = normalizeName(last);
    const nFirst = normalizeName(first);
    tuples.push([
      await rowId(source, r), source, last, first, get(r, "MIDNAME"), bus,
      get(r, "GENERAL"), get(r, "SPECIALTY"), get(r, "UPIN"),
      normalizeNpi(get(r, "NPI")), normalizeDate(get(r, "DOB")),
      get(r, "ADDRESS"), get(r, "CITY"), get(r, "STATE"), get(r, "ZIP"),
      get(r, "EXCLTYPE"), normalizeDate(get(r, "EXCLDATE")),
      normalizeDate(get(r, "REINDATE")), normalizeDate(get(r, "WAIVERDATE")),
      get(r, "WVRSTATE"), nLast, nFirst, `${nLast} ${nFirst}`.trim(),
      normalizeBase(bus), loadId, null, loadedAt,
    ]);
  }

  const COLS =
    "id,source,last_name,first_name,mid_name,bus_name,general,specialty,upin,npi," +
    "dob,address,city,state,zip,excl_type,excl_date,reinstate_date,waiver_date," +
    "waiver_state,n_last,n_first,n_full,n_bus,load_id,raw_json,loaded_at";

  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < tuples.length; i += ROWS_PER_INSERT) {
    const chunk = tuples.slice(i, i + ROWS_PER_INSERT);
    const placeholders = chunk.map(() => `(${new Array(27).fill("?").join(",")})`).join(",");
    stmts.push(
      env.DB.prepare(`INSERT OR REPLACE INTO exclusions (${COLS}) VALUES ${placeholders}`)
        .bind(...chunk.flat()),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);

  const done = offset + slice.length;
  const complete = done >= body.length;

  await setProgress(
    env, url, source, done, body.length,
    complete ? "done" : "running",
    complete ? "fully merged" : `${done}/${body.length} rows merged so far`,
  );

  // The loads row is written only on completion, so /v1/health never reports a
  // partially merged file as a finished load.
  if (complete) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO loads (id,source,loaded_at,row_count,sha256,status,note)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(loadId, source, loadedAt, body.length, null, "complete",
           `cron supplement ${url}`).run();
  }

  return {
    ...base,
    status: complete ? "loaded" : "partial",
    source_lines: body.length,
    written: tuples.length,
    rows_done: done,
    note: complete
      ? `merged ${tuples.length} rows in ${stmts.length} queries; file complete`
      : `merged ${tuples.length} rows in ${stmts.length} queries; ` +
        `${body.length - done} rows remain for the next run`,
  };
}

async function setProgress(
  env: Env, url: string, source: string,
  rowsDone: number, totalRows: number | null, status: string, note: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO supplement_progress (url, source, rows_done, total_rows, status, updated_at, note)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(url) DO UPDATE SET
       rows_done  = excluded.rows_done,
       total_rows = excluded.total_rows,
       status     = excluded.status,
       updated_at = excluded.updated_at,
       note       = excluded.note`,
  ).bind(url, source, rowsDone, totalRows, status, new Date().toISOString(), note).run();
}

/**
 * Advance the supplement merge by one file per invocation.
 *
 * One file, not all four, because each file can cost up to 30 insert queries
 * and the free plan allows 50 D1 queries per invocation in total. Files that
 * 404 cost almost nothing, so the loop skips past them and still reaches a file
 * with work in the same run. The daily cron means a multi-run file converges
 * within a few days, which is well inside the monthly publication cadence.
 *
 * Both the current and previous month are candidates because OIG publishes a
 * month's supplement during the following month: on most days the current month
 * is still a 404 while the previous month has just appeared.
 */
export async function monthlySupplement(env: Env): Promise<LoadReport[]> {
  const now = new Date();
  const months = [
    { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1 },
    now.getUTCMonth() === 0
      ? { y: now.getUTCFullYear() - 1, m: 12 }
      : { y: now.getUTCFullYear(), m: now.getUTCMonth() },
  ];

  const candidates: Array<{ source: string; url: string }> = [];
  for (const { y, m } of months) {
    candidates.push({ source: "leie_rein", url: supplementUrl("rein", y, m) });
    candidates.push({ source: "leie", url: supplementUrl("excl", y, m) });
  }

  const out: LoadReport[] = [];
  for (const c of candidates) {
    const report = await loadSupplement(env, c.source, c.url);
    out.push(report);
    // Stop as soon as one file actually consumed the row budget.
    if (report.status === "loaded" || report.status === "partial") break;
  }
  return out;
}

/**
 * HEAD the active list and record whether upstream has moved on.
 *
 * This is the only affordable way to speak truthfully about freshness on the
 * free plan: we cannot re-download 15.6MB, but we can cheaply detect that the
 * generation in D1 is behind and say so.
 */
export async function freshnessProbe(env: Env): Promise<{ ok: boolean; note: string }> {
  let res: Response;
  try {
    res = await fetch(env.LEIE_CSV_URL, { method: "HEAD", headers: { "user-agent": UA } });
  } catch (e) {
    return { ok: false, note: `HEAD threw: ${String(e)}` };
  }
  if (!res.ok) return { ok: false, note: `HEAD ${res.status}` };

  const lastModified = res.headers.get("last-modified") ?? "";
  const bytes = Number(res.headers.get("content-length") ?? 0);
  const checkedAt = new Date().toISOString();

  const prior = await env.DB.prepare(
    `SELECT seeded_last_modified FROM source_state WHERE source='leie'`,
  ).first<{ seeded_last_modified: string | null }>();

  // First probe adopts what is upstream now as the seeded baseline: the bulk
  // seed was built from this same file, verified by sha256 in docs/SOURCES.md.
  const seeded = prior?.seeded_last_modified || lastModified;
  const reseedDue = seeded !== lastModified ? 1 : 0;

  await env.DB.prepare(
    `INSERT INTO source_state
       (source, upstream_last_modified, upstream_bytes, seeded_last_modified,
        checked_at, reseed_due, note)
     VALUES ('leie', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       upstream_last_modified = excluded.upstream_last_modified,
       upstream_bytes         = excluded.upstream_bytes,
       checked_at             = excluded.checked_at,
       reseed_due             = excluded.reseed_due,
       note                   = excluded.note`,
  ).bind(lastModified, bytes, seeded, checkedAt, reseedDue,
         reseedDue
           ? "upstream newer than the loaded generation; bulk reseed required " +
             "(free plan cannot refresh 15.6MB in-Worker)"
           : "loaded generation matches upstream").run();

  return {
    ok: true,
    note: reseedDue ? `reseed due (upstream ${lastModified})` : `current (${lastModified})`,
  };
}

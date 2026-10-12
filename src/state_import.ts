/**
 * Resumable import of CFAI's state-exclusion export into `state_exclusions`.
 *
 * Same pattern as CourtPulse's export / enforcement-check's importer.ts (see
 * that file's comment for the full reasoning): the free plan's 10ms CPU per
 * invocation and D1's ~50-queries-per-invocation ceiling mean a whole-file
 * import cannot fit in one tick, so this is spread over many, reading a
 * byte-windowed slice of the gzipped NDJSON per tick (lines before the
 * window are skipped by counting newline bytes in the raw stream, never
 * decoded) and finalizing only once a COUNT(*) confirms the new generation
 * really holds every record the manifest promised.
 *
 * An interrupted import leaves the previous generation serving reads,
 * untouched, and simply resumes on the next tick — this table is separate
 * from `exclusions`, so a partial or failed state import can never affect
 * federal screening either way.
 */
import type { Env } from "./env";
import { normalizeBusiness, normalizeName } from "./normalize";

/** The actual INSERT column list is id, source, state, name, is_person,
 * npi, excl_date, source_url, as_of, refresh, delist_first_missing,
 * delist_times_missing, n_name, n_bus, gen, loaded_at -- 16 columns, not 14
 * (RECORD_COLS names the export-derived subset; the two bookkeeping columns
 * gen/loaded_at are added separately below). 16 x 7 = 112 would exceed D1's
 * 100-bound-param cap the same way 14 x 8 = 112 did before (see the
 * 2026-09-15 incident this comment used to describe): RECORDS_PER_INSERT
 * has to shrink every time a column is added, not stay fixed. 16 x 6 = 96,
 * added 2026-09-18 for the two delist_* columns.
 */
const RECORD_COLS = 14;
const RECORDS_PER_INSERT = 6;
// 45 inserts + 1 meta write = 46, under D1's ~50/invocation (same margin
// philosophy as enforcement-check's importer).
const MAX_INSERTS_PER_TICK = 45;
const MAX_RECORDS_PER_TICK = 400;

export interface StateSourceMeta {
  state: string;
  as_of: string;
  refresh: "daily" | "manual";
  count: number;
}

export interface StateExportManifest {
  export_version: number;
  built_at: string;
  records: number;
  sha256: string;
  bytes_gz: number;
  sources: Record<string, StateSourceMeta>;
}

export interface StateExportRecord {
  id: number;
  state: string;
  source: string;
  name: string;
  is_person: boolean;
  npi: string;
  excl_date: string;
  url: string;
  /** "" unless CFAI has an OPEN delisting signal for this record's url. */
  delist_first_missing: string;
  delist_times_missing: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const USER_AGENT = "cf-exclusion-check/1.0 (state-exclusions importer)";

export interface ImportDeps {
  fetch: FetchLike;
  now: () => Date;
}

export interface TickResult {
  status: "started" | "progress" | "done" | "failed" | "unchanged";
  gen?: string;
  offset?: number;
  records?: number;
  note: string;
}

// ---------------------------------------------------------------------------
// meta helpers (state_import_meta — same shape as booth #3's `meta`)
// ---------------------------------------------------------------------------

async function readMeta(env: Env, keys: string[]): Promise<Record<string, string>> {
  if (!keys.length) return {};
  const { results } = await env.DB.prepare(
    `SELECT k, v FROM state_import_meta WHERE k IN (${keys.map(() => "?").join(",")})`,
  ).bind(...keys).all<{ k: string; v: string }>();
  const out: Record<string, string> = {};
  for (const r of results ?? []) out[r.k] = r.v;
  return out;
}

function setMetaStatement(env: Env, entries: Record<string, string | number>) {
  const keys = Object.keys(entries);
  const sql =
    `INSERT INTO state_import_meta (k, v) VALUES ${keys.map(() => "(?,?)").join(",")} ` +
    `ON CONFLICT(k) DO UPDATE SET v = excluded.v`;
  const params: string[] = [];
  for (const k of keys) params.push(k, String(entries[k]));
  return env.DB.prepare(sql).bind(...params);
}

// ---------------------------------------------------------------------------
// reading the export
// ---------------------------------------------------------------------------

export async function fetchManifest(url: string, deps: ImportDeps): Promise<StateExportManifest> {
  const res = await deps.fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  const m = (await res.json()) as StateExportManifest;
  if (!m || typeof m.sha256 !== "string" || typeof m.records !== "number") {
    throw new Error("manifest is missing sha256 or records");
  }
  return m;
}

/** Same technique as enforcement-check's readWindow: count newline bytes to
 * skip whole lines before the offset without ever decoding them, and cancel
 * the stream the moment the window is full so the tail is never inflated. */
export async function readWindow(
  url: string, offset: number, limit: number, deps: ImportDeps,
): Promise<{ records: StateExportRecord[]; eof: boolean }> {
  const res = await deps.fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok || !res.body) throw new Error(`records ${res.status}`);

  // nginx serves this as a plain body with no Content-Encoding (see
  // state_exclusions_export.py on CFAI), so the gzip container is ours to
  // open here, same as enforcement-check's importer.
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const records: StateExportRecord[] = [];
  let seen = 0;
  let tail = "";
  let eof = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        eof = true;
        if (tail.trim()) pushLine(records, tail);
        break;
      }
      let chunk = value;

      if (seen < offset) {
        let i = 0;
        while (seen < offset && i < chunk.length) {
          const nl = chunk.indexOf(0x0a, i);
          if (nl === -1) {
            i = chunk.length;
            break;
          }
          seen++;
          i = nl + 1;
        }
        if (seen < offset) continue;
        chunk = chunk.subarray(i);
      }

      tail += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = tail.indexOf("\n")) !== -1) {
        const line = tail.slice(0, nl);
        tail = tail.slice(nl + 1);
        if (line.trim()) pushLine(records, line);
        if (records.length >= limit) break;
      }
      if (records.length >= limit) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return { records, eof };
}

function pushLine(out: StateExportRecord[], line: string): void {
  try {
    const r = JSON.parse(line) as StateExportRecord;
    if (r && typeof r.id === "number" && typeof r.name === "string") out.push(r);
  } catch {
    // A single malformed line must not abort an import; the finalize count
    // check catches a systematically broken file.
  }
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/** 14 export-derived columns + gen + loaded_at = 16 bound params per row. */
export function buildInserts(
  env: Env, gen: string, batch: StateExportRecord[],
  sourcesMeta: Record<string, StateSourceMeta>, now: () => Date,
): { statements: D1PreparedStatement[] } {
  const statements: D1PreparedStatement[] = [];

  for (let i = 0; i < batch.length; i += RECORDS_PER_INSERT) {
    const slice = batch.slice(i, i + RECORDS_PER_INSERT);
    const sql =
      `INSERT OR REPLACE INTO state_exclusions
        (id, source, state, name, is_person, npi, excl_date, source_url,
         as_of, refresh, delist_first_missing, delist_times_missing,
         n_name, n_bus, gen, loaded_at)
       VALUES ` + slice.map(() => `(${new Array(RECORD_COLS + 2).fill("?").join(",")})`).join(",");
    const params: (string | number)[] = [];
    const nowIso = now().toISOString();
    for (const r of slice) {
      const isPerson = Boolean(r.is_person);
      const sm = sourcesMeta[r.source];
      params.push(
        `${r.source}:${r.id}`, r.source, r.state, r.name, isPerson ? 1 : 0,
        r.npi || "", r.excl_date || "", r.url || "",
        sm?.as_of ?? "", sm?.refresh ?? "daily",
        r.delist_first_missing || "", r.delist_times_missing || 0,
        isPerson ? normalizeName(r.name) : "",
        isPerson ? "" : normalizeBusiness(r.name),
        gen, nowIso,
      );
    }
    statements.push(env.DB.prepare(sql).bind(...params));
  }

  return { statements };
}

export function windowLimit(): number {
  return MAX_RECORDS_PER_TICK;
}

export function trimToBudget(batch: StateExportRecord[]): StateExportRecord[] {
  const maxRecords = MAX_INSERTS_PER_TICK * RECORDS_PER_INSERT;
  return batch.length > maxRecords ? batch.slice(0, maxRecords) : batch;
}

// ---------------------------------------------------------------------------
// the tick
// ---------------------------------------------------------------------------

export async function stateImportTick(env: Env, deps: ImportDeps): Promise<TickResult> {
  const meta = await readMeta(env, [
    "pending_gen", "pending_sha", "pending_offset", "pending_total",
    "pending_started", "pending_ticks", "active_sha", "pending_manifest",
  ]);

  const gen = meta.pending_gen;
  let offset = Number(meta.pending_offset ?? 0);
  const total = Number(meta.pending_total ?? 0);
  const ticks = Number(meta.pending_ticks ?? 0) + 1;
  const started = meta.pending_started;

  if (!gen) {
    let manifest: StateExportManifest;
    try {
      manifest = await fetchManifest(env.STATE_MANIFEST_URL, deps);
    } catch (e) {
      console.error("state manifest fetch failed", String(e));
      return { status: "failed", note: `manifest unavailable: ${String(e)}` };
    }
    if (manifest.sha256 === meta.active_sha) {
      await setMetaStatement(env, {
        last_checked_at: deps.now().toISOString(),
        last_checked_sha: manifest.sha256,
      }).run();
      return { status: "unchanged", note: "published sha256 matches the loaded generation" };
    }
    const newGen = `${manifest.built_at}-${manifest.sha256.slice(0, 8)}`;
    const startedAt = deps.now().toISOString();
    await env.DB.batch([
      setMetaStatement(env, {
        pending_gen: newGen, pending_sha: manifest.sha256, pending_offset: 0,
        pending_total: manifest.records, pending_started: startedAt, pending_ticks: 0,
        pending_manifest: JSON.stringify(manifest.sources),
        last_checked_at: startedAt, last_checked_sha: manifest.sha256,
      }),
      env.DB.prepare(
        `INSERT INTO state_imports (gen, started_at, sha256, records, ticks, status, note)
         VALUES (?,?,?,?,0,'running',?)`,
      ).bind(newGen, startedAt, manifest.sha256, manifest.records,
             `built_at ${manifest.built_at}`),
      env.DB.prepare(`DELETE FROM state_exclusions WHERE gen = ?`).bind(newGen),
    ]);
    return {
      status: "started", gen: newGen, offset: 0,
      note: `new generation ${newGen}, ${manifest.records} records to load`,
    };
  }

  let window: { records: StateExportRecord[]; eof: boolean };
  try {
    window = await readWindow(env.STATE_RECORDS_URL, offset, windowLimit(), deps);
  } catch (e) {
    console.error("state records fetch failed", String(e));
    return { status: "failed", gen, offset, note: `records unavailable: ${String(e)}` };
  }

  const batch = trimToBudget(window.records);
  if (batch.length) {
    const sourcesMeta: Record<string, StateSourceMeta> =
      JSON.parse(meta.pending_manifest || "{}");
    const { statements } = buildInserts(env, gen, batch, sourcesMeta, deps.now);

    offset += batch.length;
    statements.push(setMetaStatement(env, { pending_offset: offset, pending_ticks: ticks }));
    await env.DB.batch(statements);
  }

  const complete = offset >= total || (window.eof && batch.length === window.records.length);
  if (!complete) {
    return { status: "progress", gen, offset, records: batch.length, note: `${offset}/${total} records loaded` };
  }
  return finalize(env, deps, gen, meta.pending_sha ?? "", offset, total, ticks,
                  started ?? deps.now().toISOString(), JSON.parse(meta.pending_manifest || "{}"));
}

async function finalize(
  env: Env, deps: ImportDeps, gen: string, sha: string, offset: number,
  total: number, ticks: number, started: string,
  sourcesMeta: Record<string, StateSourceMeta>,
): Promise<TickResult> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS n FROM state_exclusions WHERE gen = ?`,
  ).bind(gen).first<{ n: number }>();
  const loaded = row?.n ?? 0;

  if (loaded !== total) {
    const note = `loaded ${loaded} of ${total}; not published, will resume`;
    console.error("state import short", gen, note);
    await setMetaStatement(env, { pending_offset: Math.min(offset, loaded) }).run();
    return { status: "failed", gen, offset: loaded, note };
  }

  const now = deps.now().toISOString();
  const metaWrites = Object.entries(sourcesMeta).map(([source, sm]) =>
    env.DB.prepare(
      `INSERT INTO state_source_meta (source, state, as_of, refresh, row_count, gen)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(source) DO UPDATE SET state=excluded.state, as_of=excluded.as_of,
         refresh=excluded.refresh, row_count=excluded.row_count, gen=excluded.gen`,
    ).bind(source, sm.state, sm.as_of, sm.refresh, sm.count, gen),
  );

  await env.DB.batch([
    setMetaStatement(env, {
      active_gen: gen, active_sha: sha, active_records: loaded, active_loaded_at: now,
      pending_gen: "", pending_sha: "", pending_offset: "0", pending_total: "0",
      pending_ticks: "0", pending_started: "", pending_manifest: "",
    }),
    env.DB.prepare(
      `UPDATE state_imports SET ended_at = ?, records = ?, ticks = ?, status = 'done'
       WHERE gen = ? AND status = 'running'`,
    ).bind(now, loaded, ticks, gen),
    env.DB.prepare(`DELETE FROM state_exclusions WHERE gen <> ?`).bind(gen),
    ...metaWrites,
  ]);

  return {
    status: "done", gen, offset: loaded, records: loaded,
    note: `published ${loaded} records in ${ticks} ticks (started ${started})`,
  };
}

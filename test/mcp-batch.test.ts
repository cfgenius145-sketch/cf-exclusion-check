/**
 * The batch MCP tool (exclusion_batch_check), run against a real SQLite DB
 * built from the real migrations — same convention as batch.test.ts, and for
 * the same reason: the chunking/index behaviour is a SQL property, not just a
 * matching one.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PAID_TOOL_BATCH, handleMcp } from "../src/mcp";
import type { Env } from "../src/env";

let db: DatabaseSync;

function applyMigrations(database: DatabaseSync) {
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(dir, f), "utf8"));
  }
}

const COLS =
  "id,source,last_name,first_name,mid_name,bus_name,general,specialty,upin,npi," +
  "dob,address,city,state,zip,excl_type,excl_date,reinstate_date,waiver_date," +
  "waiver_state,n_last,n_first,n_full,n_bus,load_id,raw_json,loaded_at," +
  "uei,cage,duns,classification,program,agency_code,agency_name,record_status," +
  "termination_date,country";

function insert(row: Record<string, string | null>) {
  const names = COLS.split(",");
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO exclusions (${COLS}) VALUES (${names.map(() => "?").join(",")})`,
  );
  stmt.run(...names.map((n) => (row[n] ?? "") as string));
}

/** The minimal slice of the D1 interface batch.ts's runBatchQueries AND
 * screen.ts's sourceInfo() call — the latter calls .prepare(sql).all()
 * directly with no .bind(), since its query takes no parameters. */
function d1From(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return {
        async all<T>() {
          return { results: database.prepare(sql).all() as T[] };
        },
        bind(...args: unknown[]) {
          return {
            async all<T>() {
              return { results: database.prepare(sql).all(...(args as never[])) as T[] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function envWith(db: D1Database): Env {
  return {
    DB: db, NETWORK: "eip155:8453", FACILITATOR_URL: "", LEIE_CSV_URL: "",
    PRICE_CHECK: "$0.05", PRICE_REPORT: "$0.50", SERVICE_NAME: "CF Exclusion Check",
  } as unknown as Env;
}

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  applyMigrations(db);
  insert({
    id: "l1", source: "leie", last_name: "ABADI", first_name: "JAMSHEED",
    npi: "1477537496", state: "NY", excl_date: "20140520",
    n_last: "ABADI", n_first: "JAMSHEED", n_full: "ABADI JAMSHEED",
    load_id: "t", loaded_at: "t",
  });
});

describe("exclusion_batch_check MCP tool", () => {
  it("screens a mix of valid items and reports tier/billed_items", async () => {
    const env = envWith(d1From(db));
    const out = await handleMcp(env, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: PAID_TOOL_BATCH, arguments: { items: [
        { ref: "a", npi: "1477537496" },
        { ref: "b", name: "Zebediah Quatermain" },
      ] } },
    });
    const structured = (out?.payload as any).result.structuredContent;
    expect(structured.billed_items).toBe(2);
    expect(structured.tier).toBe("small");
    expect(structured.price).toBe("$0.30");
    expect(structured.results.map((r: any) => r.ref)).toEqual(["a", "b"]);
    expect(structured.results[0].verdict).toBe("excluded");
    expect(structured.results[1].verdict).toBe("no_match");

    // v2 envelope nested under its own key (ENVELOPE.md §1.6) — v1 fields
    // above are untouched, this is purely additive.
    const env2 = structured.envelope;
    expect(env2.service).toBe("exclusion-check");
    expect(env2.version).toBe("2");
    expect(env2.results.map((r: any) => r.ref)).toEqual(["a", "b"]);
    expect(env2.results[0].verdict).toBe("excluded");
    expect(env2.results[0].basis).toBe("npi");
    expect(env2.results[0].counts).toEqual({ records: 1, subjects: 1 });
    expect(env2.results[1].verdict).toBe("no_match");
    expect(Array.isArray(env2.sources)).toBe(true);
    expect(Array.isArray(env2.limits)).toBe(true);
  });

  it("rejects an out-of-range item count without touching the database", async () => {
    const throwingEnv = envWith({
      prepare() { throw new Error("must not query for an out-of-range batch"); },
    } as unknown as D1Database);
    const out = await handleMcp(throwingEnv, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: PAID_TOOL_BATCH, arguments: { items: [{ name: "Solo Item" }] } },
    });
    const r = (out?.payload as any).result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("2-200");
  });

  it("rejects an all-invalid batch without touching the database", async () => {
    const throwingEnv = envWith({
      prepare() { throw new Error("must not query an all-invalid batch"); },
    } as unknown as D1Database);
    const out = await handleMcp(throwingEnv, {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: PAID_TOOL_BATCH, arguments: { items: [
        { npi: "12345" }, { uei: "short" },
      ] } },
    });
    const r = (out?.payload as any).result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("every item failed validation");
  });
});

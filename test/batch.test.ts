/**
 * Batch query builder and result assembly — tested against the real schema,
 * same pattern as test/sql.test.ts and for the same reason: a matching bug
 * shows up in classify() fixtures, but a chunking or index bug only shows up
 * by actually running the generated SQL.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  assembleResults,
  buildBatchQueries,
  MAX_BATCH_ITEMS,
  MIN_BATCH_ITEMS,
  parseBatchItems,
  tierFor,
  validateBatchItems,
  type BatchItem,
} from "../src/batch";
import type { ExclusionRow, Query } from "../src/match";

let db: DatabaseSync;

function applyMigrations(database: DatabaseSync) {
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n: string) => n.endsWith(".sql")).sort()) {
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

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  applyMigrations(db);

  insert({
    id: "l1", source: "leie", last_name: "ABADI", first_name: "JAMSHEED",
    npi: "1477537496", state: "NY", excl_type: "1128a1", excl_date: "20140520",
    n_last: "ABADI", n_first: "JAMSHEED", n_full: "ABADI JAMSHEED",
    load_id: "t", loaded_at: "t",
  });
  insert({
    id: "s1", source: "sam", bus_name: "ACME HEALTH LLC", n_bus: "ACME HEALTH LLC",
    uei: "ABC123DEF456", cage: "1A2B3", classification: "Firm",
    agency_code: "HHS", agency_name: "HEALTH AND HUMAN SERVICES",
    record_status: "Active", termination_date: "", excl_date: "20230101",
    load_id: "t", loaded_at: "t",
  });
  insert({
    id: "l2", source: "leie", last_name: "SMITH", first_name: "JOHN",
    npi: "1234567893", state: "TX", excl_type: "1128a1", excl_date: "20180501",
    n_last: "SMITH", n_first: "JOHN", n_full: "SMITH JOHN",
    load_id: "t", loaded_at: "t",
  });
  // A reinstated record: matched, but not currently excluded.
  insert({
    id: "l3", source: "leie", last_name: "ALLEN", first_name: "TAMEKA",
    n_last: "ALLEN", n_first: "TAMEKA", n_full: "ALLEN TAMEKA",
    excl_date: "20110620", reinstate_date: "20260811",
    load_id: "t", loaded_at: "t",
  });
  for (let i = 0; i < 50; i++) {
    insert({
      id: `pad${i}`, source: "sam", bus_name: `PADDING ${i}`,
      n_bus: `PADDING ${i}`, classification: "Firm", record_status: "Active",
      load_id: "t", loaded_at: "t",
    });
  }
});

function runQueries(items: Query[]): { rows: ExclusionRow[]; queryCount: number; maxParams: number } {
  const queries = buildBatchQueries(items);
  const seen = new Map<string, ExclusionRow>();
  let maxParams = 0;
  for (const q of queries) {
    maxParams = Math.max(maxParams, q.params.length);
    const rows = db.prepare(q.sql).all(...q.params) as unknown as ExclusionRow[];
    for (const r of rows) seen.set(r.id, r);
  }
  return { rows: [...seen.values()], queryCount: queries.length, maxParams };
}

describe("tier pricing", () => {
  it("prices the three tiers at their boundaries", () => {
    expect(tierFor(2)).toEqual({ tier: "small", price: "$0.30" });
    expect(tierFor(10)).toEqual({ tier: "small", price: "$0.30" });
    expect(tierFor(11)).toEqual({ tier: "medium", price: "$1.00" });
    expect(tierFor(50)).toEqual({ tier: "medium", price: "$1.00" });
    expect(tierFor(51)).toEqual({ tier: "large", price: "$3.00" });
    expect(tierFor(200)).toEqual({ tier: "large", price: "$3.00" });
  });

  it("rejects counts outside the batch range", () => {
    expect(tierFor(0)).toBeNull();
    expect(tierFor(1)).toBeNull();
    expect(tierFor(201)).toBeNull();
  });
});

describe("item count validation", () => {
  const counts = [0, 1, 2, 10, 11, 50, 51, 200, 201];
  for (const n of counts) {
    const items = Array.from({ length: n }, (_, i) => ({ name: `Person ${i}` }));
    it(`n=${n}: ${n >= MIN_BATCH_ITEMS && n <= MAX_BATCH_ITEMS ? "accepted" : "rejected"} by tierFor`, () => {
      const inRange = n >= MIN_BATCH_ITEMS && n <= MAX_BATCH_ITEMS;
      expect(tierFor(items.length) !== null).toBe(inRange);
    });
  }
});

describe("buildBatchQueries: chunking never exceeds 100 bound params", () => {
  it("packs a small batch into one query", () => {
    const items: Query[] = [{ npi: "1477537496" }, { uei: "ABC123DEF456" }];
    const { queryCount, maxParams } = runQueries(items);
    expect(queryCount).toBe(1);
    expect(maxParams).toBeLessThanOrEqual(100);
  });

  it("splits 200 distinct identifiers across multiple ≤100-param queries", () => {
    // Worst case: 200 items, each contributing a unique NPI. No name overlap
    // to dedupe against, so this is close to the maximum column-value count
    // a single-identifier-per-item batch can produce.
    const items: Query[] = Array.from({ length: 200 }, (_, i) => ({
      npi: String(1000000000 + i).padStart(10, "0"),
    }));
    const { queryCount, maxParams } = runQueries(items);
    expect(maxParams).toBeLessThanOrEqual(100);
    // 200 distinct values / 100 per query = exactly 2.
    expect(queryCount).toBe(2);
  });

  it("200 distinct three-part names: still respects the param cap per query", () => {
    const items: Query[] = Array.from({ length: 200 }, (_, i) => ({
      name: `First${i} Middle${i} Last${i}`,
    }));
    const { queryCount, maxParams } = runQueries(items);
    expect(maxParams).toBeLessThanOrEqual(100);
    expect(queryCount).toBeGreaterThan(1);
    // Sanity ceiling so a future change can't silently blow this up without a
    // test noticing: 200 names should not need more than ~20 queries.
    expect(queryCount).toBeLessThanOrEqual(20);
  });

  it("never emits a compound (UNION) SELECT", () => {
    const items: Query[] = Array.from({ length: 200 }, (_, i) => ({ name: `X${i} Y${i}` }));
    for (const q of buildBatchQueries(items)) {
      expect(q.sql.toUpperCase()).not.toContain("UNION");
    }
  });
});

describe("buildBatchQueries: query plans use indexes, never a full scan", () => {
  it("no SCAN appears for a mixed-identifier 50-item batch", () => {
    const items: Query[] = Array.from({ length: 50 }, (_, i) =>
      i % 2 === 0 ? { npi: String(2000000000 + i).padStart(10, "0") } : { name: `Person${i} Surname${i}` },
    );
    for (const q of buildBatchQueries(items)) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as any[])
        .map((r) => String(r.detail));
      expect(plan.filter((d) => d.startsWith("SCAN"))).toEqual([]);
      expect(plan.some((d) => d.includes("USING INDEX"))).toBe(true);
    }
  });
});

describe("buildBatchQueries: correctness against fixtures", () => {
  it("finds the right row for each of several items in one pass", () => {
    const items: Query[] = [
      { npi: "1477537496" }, { uei: "ABC123DEF456" }, { name: "John Smith" },
    ];
    const { rows } = runQueries(items);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("l1");
    expect(ids).toContain("s1");
    expect(ids).toContain("l2");
    // The 50 padding rows must never surface for identifier/name lookups that
    // don't match them.
    expect(ids.filter((id) => id.startsWith("pad"))).toHaveLength(0);
  });

  it("an all-empty batch (no identifiers resolve) produces zero queries", () => {
    expect(buildBatchQueries([{ npi: "0000000000" }])).toEqual([]);
  });
});

describe("parseBatchItems", () => {
  it("rejects a non-array items field", () => {
    expect(parseBatchItems({ items: "nope" })).toBeNull();
    expect(parseBatchItems({})).toBeNull();
    expect(parseBatchItems(null)).toBeNull();
  });

  it("round-trips ref and coerces identifier fields to strings", () => {
    const items = parseBatchItems({ items: [{ ref: "row-1", npi: 1477537496 }] });
    expect(items).toEqual([{
      ref: "row-1", name: undefined, npi: "1477537496", dob: undefined,
      state: undefined, uei: undefined, cage: undefined,
    }]);
  });
});

describe("validateBatchItems: same rules as /v1/check, per item", () => {
  it("flags a malformed npi without failing sibling items", () => {
    const items: BatchItem[] = [{ npi: "12345" }, { name: "John Smith" }];
    const results = validateBatchItems(items);
    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(true);
  });

  it("all-invalid batch: every item fails", () => {
    const items: BatchItem[] = [{ npi: "12345" }, { uei: "short" }];
    const results = validateBatchItems(items);
    expect(results.every((r) => !r.ok)).toBe(true);
  });
});

describe("assembleResults: ordering, ref round-trip, mixed valid/invalid", () => {
  it("preserves input order and carries ref through", () => {
    const items: BatchItem[] = [
      { ref: "a", npi: "1477537496" },
      { ref: "b", npi: "99999" }, // invalid
      { ref: "c", uei: "ABC123DEF456" },
    ];
    const validated = validateBatchItems(items);
    const { rows } = runQueries(validated.filter((v) => v.ok).map((v) => v.item));
    const results = assembleResults(validated, rows);

    expect(results.map((r) => r.ref)).toEqual(["a", "b", "c"]);
    expect(results[0].verdict).toBe("excluded");
    expect(results[1].error).toBeTruthy();
    expect(results[1].verdict).toBeUndefined();
    expect(results[2].verdict).toBe("excluded");
    expect(results[2].basis).toBe("uei");
  });

  it("a reinstated-only match reports reinstated_only, not excluded", () => {
    const items: BatchItem[] = [{ ref: "x", name: "Tameka Allen" }];
    const validated = validateBatchItems(items);
    const { rows } = runQueries(items);
    const results = assembleResults(validated, rows);
    expect(results[0].verdict).toBe("reinstated_only");
  });

  it("a clean name with no match returns no_match and empty matches", () => {
    const items: BatchItem[] = [{ ref: "clean", name: "Zebediah Quatermain" }];
    const validated = validateBatchItems(items);
    const { rows } = runQueries(items);
    const results = assembleResults(validated, rows);
    expect(results[0].verdict).toBe("no_match");
    expect(results[0].matches).toEqual([]);
  });
});

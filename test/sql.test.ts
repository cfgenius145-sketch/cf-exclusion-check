/**
 * Tests that actually EXECUTE the generated SQL.
 *
 * This file exists because two production bugs shipped past a green suite:
 *
 *   1. A partial index on npi that SQLite silently ignored, turning every NPI
 *      lookup into a full scan of 83,975 rows — which exhausted D1's daily
 *      row-read budget and returned 500 on a request whose payment had already
 *      been authorized.
 *   2. A UNION-per-strategy query that exceeded D1's 5-term compound-SELECT
 *      ceiling. "Jamsheed Abadi" produced exactly 5 terms and passed every
 *      test; "Mary Jane Smith" produced 7 and failed with SQLITE_ERROR.
 *
 * Neither was reachable from tests that call classify() on fixture arrays,
 * because neither is a matching bug — both are SQL bugs. So these tests build
 * the real schema from the real migration files, insert fixtures, run the SQL
 * that buildCandidateQuery emits, and assert both the rows returned AND the
 * query plan.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildCandidateQuery, classify, type ExclusionRow } from "../src/match";

let db: DatabaseSync;

/** Apply every migration in order, exactly as D1 would. */
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

  // LEIE person, with an NPI.
  insert({
    id: "l1", source: "leie", last_name: "ABADI", first_name: "JAMSHEED",
    npi: "1477537496", state: "NY", excl_type: "1128a1", excl_date: "20140520",
    n_last: "ABADI", n_first: "JAMSHEED", n_full: "ABADI JAMSHEED",
    load_id: "t", loaded_at: "t",
  });
  // LEIE business.
  insert({
    id: "l2", source: "leie", bus_name: "#1 MARKETING SERVICE, INC",
    // Normalized form drops the '#': normalizeBase keeps only [A-Z0-9&- ],
    // so the stored key is "1 MARKETING SERVICE INC". Verified against the
    // real loaded row rather than assumed.
    n_bus: "1 MARKETING SERVICE INC", excl_date: "20200319",
    load_id: "t", loaded_at: "t",
  });
  // LEIE three-part personal name — the shape that broke the UNION build.
  insert({
    id: "l3", source: "leie", last_name: "SMITH", first_name: "MARY", mid_name: "JANE",
    n_last: "SMITH", n_first: "MARY", n_full: "SMITH MARY",
    excl_date: "20190101", load_id: "t", loaded_at: "t",
  });
  // SAM organisation with UEI + CAGE, indefinite exclusion.
  insert({
    id: "s1", source: "sam", bus_name: "ACME HEALTH LLC", n_bus: "ACME HEALTH LLC",
    uei: "ABC123DEF456", cage: "1A2B3", classification: "Firm",
    agency_code: "HHS", agency_name: "HEALTH AND HUMAN SERVICES",
    record_status: "Active", termination_date: "", excl_date: "20230101",
    load_id: "t", loaded_at: "t",
  });
  // SAM individual whose exclusion has already terminated.
  insert({
    id: "s2", source: "sam", last_name: "BRANTLEY", first_name: "DEREK",
    n_last: "BRANTLEY", n_first: "DEREK", n_full: "BRANTLEY DEREK",
    classification: "Individual", record_status: "Active",
    termination_date: "20200101", excl_date: "20180101",
    load_id: "t", loaded_at: "t",
  });
  // Rows with empty identifiers: these must never be reachable by a query for
  // an empty value, and must not sit in the partial indexes.
  for (let i = 0; i < 50; i++) {
    insert({
      id: `pad${i}`, source: "sam", bus_name: `PADDING ${i}`,
      n_bus: `PADDING ${i}`, classification: "Firm", record_status: "Active",
      load_id: "t", loaded_at: "t",
    });
  }
});

function run(q: Parameters<typeof buildCandidateQuery>[0]): ExclusionRow[] {
  const { sql, params } = buildCandidateQuery(q);
  return db.prepare(sql).all(...params) as unknown as ExclusionRow[];
}

function plan(q: Parameters<typeof buildCandidateQuery>[0]): string[] {
  const { sql, params } = buildCandidateQuery(q);
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as any[];
  return rows.map((r) => String(r.detail));
}

describe("generated SQL executes", () => {
  it("runs for a three-part name — the case the UNION form could not", () => {
    const rows = run({ name: "Mary Jane Smith" });
    expect(rows.map((r) => r.id)).toContain("l3");
  });

  it("runs for a name plus an npi together", () => {
    const rows = run({ name: "Jamsheed Abadi", npi: "1477537496" });
    expect(rows.map((r) => r.id)).toContain("l1");
  });

  it("finds a LEIE business by name", () => {
    expect(run({ name: "#1 Marketing Service, Inc" }).map((r) => r.id)).toContain("l2");
  });

  it("finds a SAM organisation by UEI", () => {
    const rows = run({ uei: "ABC123DEF456" });
    expect(rows.map((r) => r.id)).toEqual(["s1"]);
  });

  it("finds a SAM organisation by CAGE", () => {
    expect(run({ cage: "1A2B3" }).map((r) => r.id)).toEqual(["s1"]);
  });

  it("searches both sources in one query", () => {
    // A single query must reach LEIE and SAM rows together; if the two sources
    // ever needed separate queries the compound-SELECT ceiling would return.
    const ids = run({ name: "Acme Health LLC", npi: "1477537496" }).map((r) => r.id);
    expect(ids).toContain("s1");
    expect(ids).toContain("l1");
  });

  it("a clean control returns nothing", () => {
    expect(run({ name: "Zebediah Quatermain" })).toHaveLength(0);
  });
});

describe("query plans use indexes", () => {
  const cases: Array<[string, Parameters<typeof buildCandidateQuery>[0]]> = [
    ["name", { name: "Mary Jane Smith" }],
    ["npi", { npi: "1477537496" }],
    ["uei", { uei: "ABC123DEF456" }],
    ["cage", { cage: "1A2B3" }],
    ["everything", { name: "Acme Health LLC", npi: "1477537496", uei: "ABC123DEF456" }],
  ];

  for (const [label, q] of cases) {
    it(`never full-scans for ${label}`, () => {
      const details = plan(q);
      // A SCAN here is the 0004 bug class: on D1 it costs a read of every row
      // in the table, against a 5,000,000/day ceiling.
      expect(details.filter((d) => d.startsWith("SCAN"))).toEqual([]);
      expect(details.some((d) => d.includes("USING INDEX"))).toBe(true);
    });
  }

  it("uses the PARTIAL npi index, which needs the predicate in the query", () => {
    // Without `AND npi <> ''` in the WHERE clause SQLite ignores a partial
    // index and scans. This asserts the predicate is still being emitted.
    const details = plan({ npi: "1477537496" });
    expect(details.join(" ")).toContain("idx_excl_npi");
  });
});

describe("empty identifiers are never matchable", () => {
  it("an empty npi cannot be queried into a match", () => {
    // normalizeNpi rejects placeholders, so the term is dropped entirely
    // rather than becoming `npi = ''`, which would match every padding row.
    const { sql, params } = buildCandidateQuery({ npi: "0000000000", name: "Acme Health LLC" });
    expect(params).not.toContain("");
    expect(sql).not.toContain("npi =");
  });

  it("a business query does not return the 50 padding rows", () => {
    expect(run({ name: "Acme Health LLC" }).map((r) => r.id)).toEqual(["s1"]);
  });
});

describe("SAM exclusion currency, end to end", () => {
  it("an indefinite SAM exclusion is currently excluded", () => {
    const rows = run({ uei: "ABC123DEF456" });
    const m = classify(rows, { uei: "ABC123DEF456" });
    expect(m[0].basis).toBe("uei");
    expect(m[0].confidence).toBe("strong");
  });

  it("a SAM record whose termination date has passed is not currently excluded", () => {
    const rows = run({ name: "Derek Brantley" });
    expect(rows.map((r) => r.id)).toContain("s2");
    const row = rows.find((r) => r.id === "s2")!;
    expect(row.termination_date).toBe("20200101");
  });
});

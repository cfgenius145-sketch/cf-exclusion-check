/**
 * Runs the real trial_calls migration against real SQLite (node:sqlite), the
 * same convention sql.test.ts uses and for the same reason: this is a SQL
 * concurrency guarantee (the UPSERT's WHERE clause), not a matching rule, so
 * it has to be proven against a real database rather than a hand-rolled mock
 * that could just encode the same assumption it's supposed to be checking.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { grantTrial, wantsTrial } from "../src/trial";
import type { Env } from "../src/env";

let db: DatabaseSync;

function applyMigrations(database: DatabaseSync) {
  const dir = join(process.cwd(), "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(dir, f), "utf8"));
  }
}

/** The minimal slice of the D1 interface trial.ts actually calls. */
function d1From(database: DatabaseSync) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              return (database.prepare(sql).get(...(args as never[])) ?? null) as T | null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function envWith(db: D1Database, salt: string | undefined): Env {
  return {
    DB: db,
    NETWORK: "eip155:8453", FACILITATOR_URL: "", LEIE_CSV_URL: "",
    PRICE_CHECK: "$0.05", PRICE_REPORT: "$0.50", SERVICE_NAME: "CF Exclusion Check",
    IP_HASH_SALT: salt,
  } as Env;
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  applyMigrations(db);
});

describe("grantTrial", () => {
  it("grants exactly 3 calls per IP per day, then refuses", async () => {
    const env = envWith(d1From(db), "s3cr3t");
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await grantTrial(env, "203.0.113.9"));

    expect(results.map((r) => r.granted)).toEqual([true, true, true, false, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0, 0]);
  });

  it("keys separately per IP — one IP's quota does not affect another's", async () => {
    const env = envWith(d1From(db), "s3cr3t");
    for (let i = 0; i < 3; i++) await grantTrial(env, "203.0.113.9");
    expect((await grantTrial(env, "203.0.113.9")).granted).toBe(false);
    expect((await grantTrial(env, "198.51.100.4")).granted).toBe(true);
  });

  it("hashes the IP — the raw address is never stored", async () => {
    const env = envWith(d1From(db), "s3cr3t");
    await grantTrial(env, "203.0.113.9");
    const row = db.prepare("SELECT ip_hash FROM trial_calls").get() as { ip_hash: string };
    expect(row.ip_hash).not.toContain("203.0.113.9");
    expect(row.ip_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("fails closed — refuses every call when no salt is configured", async () => {
    const env = envWith(d1From(db), undefined);
    const r = await grantTrial(env, "203.0.113.9");
    expect(r.granted).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM trial_calls").get()).toEqual({ n: 0 });
  });

  it("fails closed when there is no IP to key on", async () => {
    const env = envWith(d1From(db), "s3cr3t");
    expect((await grantTrial(env, null)).granted).toBe(false);
  });

  it("cannot be starved by a differently-cased or padded header value elsewhere — wantsTrial is exact", () => {
    const header = (v: string | undefined) => ({ req: { header: () => v, url: "https://x/v1/check" } });
    expect(wantsTrial(header("1"))).toBe(true);
    expect(wantsTrial(header("true"))).toBe(false);
    expect(wantsTrial(header(undefined))).toBe(false);
  });

  it("wantsTrial also recognizes the ?trial=1 query parameter", () => {
    const withUrl = (url: string) => ({ req: { header: () => undefined, url } });
    expect(wantsTrial(withUrl("https://x/v1/check?trial=1"))).toBe(true);
    expect(wantsTrial(withUrl("https://x/v1/check?trial=0"))).toBe(false);
    expect(wantsTrial(withUrl("https://x/v1/check"))).toBe(false);
  });
});

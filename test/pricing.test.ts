import { describe, expect, it } from "vitest";
import { discoveryDocument, endpoints } from "../src/discovery";
import type { Env } from "../src/env";

/**
 * Pricing is the one place where an off-by-a-factor-of-ten is both easy and
 * expensive: `amount` is atomic USDC (6 decimals), so "$0.05" must become
 * "50000" and not "5000" or "500000". The dollar strings live in wrangler.jsonc
 * and the atomic conversion happens in src/discovery.ts, so nothing in the type
 * system connects them — only a test does.
 */
function envFor(check: string, report: string, network = "eip155:8453"): Env {
  return {
    NETWORK: network,
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
    PAY_TO: "0xCa28eb92657F8a81aFb5493b3a04A740B204d816",
    PRICE_CHECK: check,
    PRICE_REPORT: report,
    SERVICE_NAME: "CF Exclusion Check",
  } as unknown as Env;
}

const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function accepts(env: Env) {
  const doc = discoveryDocument(env, "https://example.test") as any;
  return doc.accepts as Array<Record<string, string>>;
}

describe("price to atomic USDC", () => {
  it("converts the live prices correctly", () => {
    const [check, report] = accepts(envFor("$0.05", "$0.50"));
    expect(check.amount).toBe("50000");
    expect(report.amount).toBe("500000");
  });

  it("holds across a range of values", () => {
    for (const [dollars, atomic] of [
      ["$0.01", "10000"],
      ["$0.05", "50000"],
      ["$0.25", "250000"],
      ["$0.50", "500000"],
      ["$1.00", "1000000"],
    ] as const) {
      const [check] = accepts(envFor(dollars, "$1.00"));
      expect(check.amount, `${dollars} should be ${atomic}`).toBe(atomic);
    }
  });

  it("advertises the mainnet USDC contract on mainnet", () => {
    const [check] = accepts(envFor("$0.05", "$0.50", "eip155:8453"));
    expect(check.asset).toBe(BASE_MAINNET_USDC);
  });

  it("advertises the Sepolia USDC contract on testnet", () => {
    // A flip back to testnet must not keep pointing at the mainnet contract.
    const [check] = accepts(envFor("$0.05", "$0.50", "eip155:84532"));
    expect(check.asset).toBe(BASE_SEPOLIA_USDC);
  });

  it("never charges the check price for the report endpoint", () => {
    const [check, report] = accepts(envFor("$0.05", "$0.50"));
    expect(check.resource).toContain("/v1/check");
    expect(report.resource).toContain("/v1/report");
    expect(check.amount).not.toBe(report.amount);
  });

  it("the advertised endpoint list carries the same dollar prices", () => {
    const env = envFor("$0.05", "$0.50");
    const eps = endpoints(env);
    expect(eps.find((e) => e.path === "/v1/check")?.price).toBe("$0.05");
    expect(eps.find((e) => e.path === "/v1/report")?.price).toBe("$0.50");
    // Free endpoints must stay free after a price change.
    expect(eps.filter((e) => e.free).map((e) => e.price)).toEqual(["$0.00", "$0.00"]);
  });
});

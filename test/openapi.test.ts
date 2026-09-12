import { describe, expect, it } from "vitest";
import { openApiDocument } from "../src/openapi";
import type { Env } from "../src/env";

const env = {
  PRICE_CHECK: "$0.05", PRICE_REPORT: "$0.50", SERVICE_NAME: "CF Exclusion Check",
} as Env;

describe("openApiDocument", () => {
  const doc = openApiDocument(env, "https://exclusions.example.com") as any;

  it("prices in decimal USD, never the atomic units the payment middleware uses", () => {
    expect(doc.paths["/v1/check"].get["x-payment-info"].price.amount).toBe(0.05);
    expect(doc.paths["/v1/report"].get["x-payment-info"].price.amount).toBe(0.5);
  });

  it("advertises every priced path as x402", () => {
    for (const p of ["/v1/check", "/v1/report"]) {
      expect(doc.paths[p].get["x-payment-info"].protocols).toEqual(["x402"]);
      expect(doc.paths[p].get.responses["402"]).toBeDefined();
    }
  });

  it("derives the server URL from the request origin, not a hardcoded host", () => {
    expect(doc.servers).toEqual([{ url: "https://exclusions.example.com" }]);
  });

  it("lists the free paths without payment metadata", () => {
    expect(doc.paths["/v1/health"].get["x-payment-info"]).toBeUndefined();
    expect(doc.paths["/.well-known/x402"].get["x-payment-info"]).toBeUndefined();
  });

  it("carries a contact email for ownership verification", () => {
    expect(doc.info.contact.email).toBe("info@cfaisolutions.com");
  });
});

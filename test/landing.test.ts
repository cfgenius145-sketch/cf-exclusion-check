import { describe, expect, it } from "vitest";
import { landingPage } from "../src/landing";
import type { Env } from "../src/env";

const env = {
  PRICE_CHECK: "$0.05", PRICE_REPORT: "$0.50", SERVICE_NAME: "CF Exclusion Check",
} as Env;

describe("landingPage", () => {
  const html = landingPage(env, "https://exclusions.example.com");

  it("has no JavaScript at all", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\bon(click|load|error)=/i);
  });

  it("shows the live prices, not hardcoded ones", () => {
    expect(html).toContain("$0.05");
    expect(html).toContain("$0.50");
  });

  it("documents the free trial", () => {
    expect(html).toMatch(/3 calls a day/);
    expect(html).toContain("trial=1");
    expect(html).toContain("X-Trial: 1");
  });

  it("gives both the Claude Desktop bridge form and the direct-URL form", () => {
    expect(html).toContain('"command": "npx"');
    expect(html).toContain('"args": ["mcp-remote", "https://exclusions.example.com/mcp"]');
    expect(html).toContain('"type": "http"');
    expect(html).toContain('"url": "https://exclusions.example.com/mcp"');
  });

  it("links the repo and the contact address", () => {
    expect(html).toContain("github.com/cfgenius145-sketch/cf-exclusion-check");
    expect(html).toContain("mailto:info@cfaisolutions.com");
  });

  it("states the limitations plainly", () => {
    expect(html).toMatch(/not an identity determination/);
  });

  it("does not hardcode a row count that would go stale", () => {
    expect(html).not.toMatch(/247,?583/);
  });
});

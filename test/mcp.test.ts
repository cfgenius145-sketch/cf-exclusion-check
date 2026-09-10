import { describe, expect, it } from "vitest";
import { PAID_METHODS, PAID_TOOL, PROTOCOL_VERSION, handleMcp } from "../src/mcp";
import type { Env } from "../src/env";

/**
 * Env stub. Only the methods exercised here are covered — initialize, ping,
 * tools/list, notifications and error paths never touch D1, so DB is a thrower
 * to make any accidental query a loud test failure rather than a silent pass.
 */
const env = {
  SERVICE_NAME: "CF Exclusion Check",
  PRICE_CHECK: "$0.01",
  PRICE_REPORT: "$0.25",
  NETWORK: "eip155:84532",
  get DB(): D1Database {
    throw new Error("a free MCP method must not touch D1");
  },
} as unknown as Env;

describe("mcp protocol", () => {
  it("initialize reports the protocol version and server info", async () => {
    const out = await handleMcp(env, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(out?.status).toBe(200);
    const r = (out?.payload as any).result;
    expect(r.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(r.serverInfo.name).toBe("CF Exclusion Check");
  });

  it("initialize states the price, so an agent learns the cost before paying", () => {
    return handleMcp(env, { jsonrpc: "2.0", id: 1, method: "initialize" })
      .then((out) => {
        expect((out?.payload as any).result.instructions).toContain("$0.01");
      });
  });

  it("lists both tools with the paid one first", async () => {
    const out = await handleMcp(env, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (out?.payload as any).result.tools;
    expect(tools.map((t: any) => t.name)).toEqual([PAID_TOOL, "exclusion_sources"]);
  });

  it("the paid tool advertises its price in its description", async () => {
    const out = await handleMcp(env, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const paid = (out?.payload as any).result.tools[0];
    expect(paid.description).toContain("$0.01");
    expect(paid.inputSchema.additionalProperties).toBe(false);
  });

  it("ping answers", async () => {
    const out = await handleMcp(env, { jsonrpc: "2.0", id: 3, method: "ping" });
    expect((out?.payload as any).result).toEqual({});
  });

  it("notifications get no response at all", async () => {
    expect(await handleMcp(env, { jsonrpc: "2.0", method: "notifications/initialized" }))
      .toBeNull();
  });

  it("an unknown method is a JSON-RPC method-not-found", async () => {
    const out = await handleMcp(env, { jsonrpc: "2.0", id: 4, method: "no/such" });
    expect((out?.payload as any).error.code).toBe(-32601);
  });

  it("a missing method is a malformed request", async () => {
    const out = await handleMcp(env, { jsonrpc: "2.0", id: 5 });
    expect(out?.status).toBe(400);
    expect((out?.payload as any).error.code).toBe(-32600);
  });

  it("an unknown tool is reported without touching the database", async () => {
    const out = await handleMcp(env, {
      jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" },
    });
    expect((out?.payload as any).error.message).toContain("unknown tool");
  });

  it("bad arguments are a tool error, not a protocol error", async () => {
    // The agent should be able to correct and retry, so this must not look like
    // a broken server. It also must not reach D1 — validation comes first.
    const out = await handleMcp(env, {
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: PAID_TOOL, arguments: { name: "*" } },
    });
    const r = (out?.payload as any).result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("wildcards");
  });

  it("only tools/call is treated as payable", () => {
    // If initialize or tools/list were payable the tool would be
    // undiscoverable: an agent cannot learn the price without reading them.
    expect(PAID_METHODS.has("tools/call")).toBe(true);
    expect(PAID_METHODS.has("initialize")).toBe(false);
    expect(PAID_METHODS.has("tools/list")).toBe(false);
  });
});

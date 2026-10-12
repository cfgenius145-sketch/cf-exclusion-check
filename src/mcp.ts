/**
 * MCP endpoint — the same screening exposed as a tool for agents.
 *
 * Implemented as a stateless JSON-RPC handler over the Streamable HTTP
 * transport rather than with `McpAgent` from the `agents` package. That choice
 * is forced by the deployment target: `McpAgent` keeps session state in a
 * Durable Object, and this service is committed to the Workers free tier. Every
 * MCP method used here — initialize, tools/list, tools/call — is a pure
 * request/response exchange, so no session state is actually required.
 *
 * Payment: `tools/call` for the paid tool goes through exactly the same x402
 * gate as POST /v1/check, applied in src/index.ts by inspecting the JSON-RPC
 * method before the payment middleware runs. `initialize` and `tools/list` stay
 * free so an agent can discover the tool and its price before paying for it —
 * charging for discovery would make the tool undiscoverable in practice.
 */
import type { Env } from "./env";
import {
  assembleResults, buildBatchQueries, MAX_BATCH_ITEMS, MIN_BATCH_ITEMS,
  parseBatchItems, runBatchQueries, tierFor, validateBatchItems,
} from "./batch";
import { validateQuery, type Query } from "./match";
import { buildExclusionEnvelope, buildLimits, toEnvelopeSources } from "./envelope-adapter";
import { DISCLAIMER, coverageOf, screen, sourceInfo } from "./screen";

export const PROTOCOL_VERSION = "2025-06-18";

/** JSON-RPC methods whose handling requires payment. */
export const PAID_METHODS = new Set(["tools/call"]);

/** Tool name that costs money; the free tools are listed alongside it. */
export const PAID_TOOL = "exclusion_check";

/** Batch tool name; priced by tier via src/batch.ts's tierFor(). */
export const PAID_TOOL_BATCH = "exclusion_batch_check";

/** Every tool that requires payment — both entries here, not a single string,
 * so index.ts's pre-payment gate recognises the batch tool too. */
export const PAID_TOOLS = new Set([PAID_TOOL, PAID_TOOL_BATCH]);

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const err = (id: unknown, code: number, message: string) =>
  ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

function toolDefinitions(env: Env) {
  return [
    {
      name: PAID_TOOL,
      title: "Check a healthcare exclusion",
      description:
        `Screen a person or business against the HHS-OIG List of Excluded ` +
        `Individuals and Entities (LEIE) AND the SAM.gov exclusions list. ` +
        `Costs ${env.PRICE_CHECK} per call via x402. Returns a verdict, a ` +
        `confidence level, the basis of each match, and the reason it matched. ` +
        `A match is a name match unless it was made on an identifier (npi, ` +
        `uei, cage); it is not an identity determination.`,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              'Person or business name. "John Smith", "Smith, John" and a ' +
              'business name are all accepted. Wildcards are rejected.',
          },
          npi: { type: "string", description: "10-digit National Provider Identifier." },
          dob: { type: "string", description: "Date of birth, YYYYMMDD." },
          state: { type: "string", description: "Two-letter state code. Corroborates only." },
          uei: {
            type: "string",
            description:
              "SAM.gov Unique Entity Identifier, exactly 12 alphanumeric " +
              "characters. An exact match is a strong identifier.",
          },
          cage: {
            type: "string",
            description:
              "CAGE code, exactly 5 alphanumeric characters. An exact match is " +
              "a strong identifier. Present on only ~0.3% of SAM records.",
          },
        },
        additionalProperties: false,
      },
      // A screening lookup reads the loaded exclusion data and nothing else:
      // no writes, no side effects, safe to call speculatively.
      annotations: { readOnlyHint: true },
    },
    {
      name: PAID_TOOL_BATCH,
      title: "Batch-screen 2-200 exclusions in one call",
      description:
        `Screen ${MIN_BATCH_ITEMS}-${MAX_BATCH_ITEMS} people/businesses against ` +
        `the same sources as ${PAID_TOOL} in one call. Tiered price by item ` +
        `count: $0.30 (2-10), $1.00 (11-50), $3.00 (51-200), charged once via ` +
        `x402. An invalid item is reported in place, not a failure; all-invalid ` +
        `is refused before charging.`,
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            minItems: MIN_BATCH_ITEMS,
            maxItems: MAX_BATCH_ITEMS,
            items: {
              type: "object",
              properties: {
                ref: { type: "string", description: "Your own id for this item, round-tripped." },
                name: { type: "string" },
                npi: { type: "string" },
                dob: { type: "string" },
                state: { type: "string" },
                uei: { type: "string" },
                cage: { type: "string" },
              },
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "exclusion_sources",
      title: "Data sources and freshness",
      description:
        "List the loaded exclusion sources (OIG LEIE and SAM.gov), their row " +
        "counts, load dates, load completeness and whether a bulk reseed is " +
        "due. Free. Screening itself is paid: exclusion_check per name, or " +
        `${PAID_TOOL_BATCH} for 2-200 at once ($0.30/$1.00/$3.00 by size).`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
  ];
}

/** Read a screening query out of MCP tool arguments. */
function queryFromArgs(args: Record<string, unknown>): Query {
  return {
    name: typeof args.name === "string" ? args.name : undefined,
    npi: args.npi != null ? String(args.npi) : undefined,
    dob: args.dob != null ? String(args.dob) : undefined,
    state: typeof args.state === "string" ? args.state : undefined,
    uei: args.uei != null ? String(args.uei) : undefined,
    cage: args.cage != null ? String(args.cage) : undefined,
  };
}

/**
 * Handle one JSON-RPC message.
 *
 * Returns `null` for notifications, which by JSON-RPC have no response and must
 * be answered with 202 and an empty body rather than a result object.
 */
export async function handleMcp(
  env: Env, body: JsonRpcRequest,
): Promise<{ status: number; payload: unknown } | null> {
  const { id, method } = body;

  if (!method) return { status: 400, payload: err(id, -32600, "missing method") };

  // Notifications carry no id and expect no reply.
  if (method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize":
      return {
        status: 200,
        payload: ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: env.SERVICE_NAME, version: "1.0.0" },
          instructions:
            `${PAID_TOOL} costs ${env.PRICE_CHECK} per call; ${PAID_TOOL_BATCH} ` +
            `screens 2-200 at once for $0.30/$1.00/$3.00 by size. Both are paid ` +
            `with x402 on ${env.NETWORK}. An unpaid call returns a 402 whose ` +
            `payment-required header carries the payment requirements. ` +
            `exclusion_sources is free.`,
        }),
      };

    case "ping":
      return { status: 200, payload: ok(id, {}) };

    case "tools/list":
      return { status: 200, payload: ok(id, { tools: toolDefinitions(env) }) };

    case "tools/call": {
      const params = body.params ?? {};
      const toolName = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments ?? {}) as Record<string, unknown>;

      if (toolName === "exclusion_sources") {
        const sources = await sourceInfo(env);
        return {
          status: 200,
          payload: ok(id, {
            content: [{ type: "text", text: JSON.stringify({ sources }, null, 2) }],
            structuredContent: { sources },
          }),
        };
      }

      if (toolName === PAID_TOOL_BATCH) {
        // Item-count range is already enforced pre-payment in index.ts's /mcp
        // gate; re-checked here too, same defensive-depth style as the HTTP
        // handler, in case this tool is ever reached another way.
        const items = parseBatchItems(args) ?? [];
        if (items.length < MIN_BATCH_ITEMS || items.length > MAX_BATCH_ITEMS) {
          return {
            status: 200,
            payload: ok(id, {
              isError: true,
              content: [{ type: "text",
                text: `items must be an array of ${MIN_BATCH_ITEMS}-${MAX_BATCH_ITEMS} entries` }],
            }),
          };
        }

        const validated = validateBatchItems(items);
        if (validated.every((v) => !v.ok)) {
          return {
            status: 200,
            payload: ok(id, { isError: true,
              content: [{ type: "text", text: "every item failed validation" }] }),
          };
        }

        const tier = tierFor(items.length);
        const queries = buildBatchQueries(validated.filter((v) => v.ok).map((v) => v.item));
        const rows = await runBatchQueries(env.DB, queries);
        const results = assembleResults(validated, rows);
        const sources = await sourceInfo(env);
        const coverage = coverageOf(sources);
        const stateSupplied = validated.some((v) => Boolean(v.item.state));
        // v2 envelope nested under its own key — see ENVELOPE.md §1.6 for
        // why this isn't flattened into the same object as the v1 fields.
        const envelope = {
          service: "exclusion-check", version: "2",
          billed_items: items.length,
          tier: tier?.tier ?? null,
          price: tier?.price ?? null,
          sources: toEnvelopeSources(sources),
          limits: buildLimits({
            coverageComplete: coverage.complete, coverageNote: coverage.note,
            stateSupplied, verdict: "no_match",
          }),
          as_of: sources.map((s) => s.loaded_at).filter(Boolean).sort()[0] ?? new Date().toISOString(),
          results: results.map((r) => ({
            ref: r.ref, query: r.query,
            ...(r.error
              ? { error: r.error }
              : {
                  verdict: r.verdict, confidence: r.confidence, basis: r.basis,
                  counts: { records: r.match_count, subjects: r.subject_count },
                  records: r.matches, truncated: r.truncated,
                }),
          })),
        };
        const structured = {
          billed_items: items.length,
          tier: tier?.tier ?? null,
          price: tier?.price ?? null,
          as_of: new Date().toISOString(),
          results,
          envelope,
        };

        return {
          status: 200,
          payload: ok(id, {
            content: [{
              type: "text",
              text:
                `${items.length} items screened, tier ${tier?.tier ?? "?"} ` +
                `(${tier?.price ?? "?"})\n\n` + JSON.stringify(structured, null, 2),
            }],
            structuredContent: structured,
          }),
        };
      }

      if (toolName !== PAID_TOOL) {
        return { status: 200, payload: err(id, -32602, `unknown tool: ${toolName}`) };
      }

      const q = queryFromArgs(args);
      const check = validateQuery(q);
      if (!check.ok) {
        // A bad argument is the caller's mistake, reported as a tool error
        // rather than a protocol error so the agent can correct and retry.
        return {
          status: 200,
          payload: ok(id, {
            isError: true,
            content: [{ type: "text", text: check.error }],
          }),
        };
      }

      const [result, sources] = await Promise.all([
        screen(env, q, "brief"),
        sourceInfo(env),
      ]);

      const mcpQueryEcho = {
        name: q.name ?? null, npi: q.npi ?? null,
        dob: q.dob ?? null, state: q.state ?? null,
        uei: q.uei ?? null, cage: q.cage ?? null,
      };
      const coverage = coverageOf(sources);
      const structured = {
        query: mcpQueryEcho,
        verdict: result.verdict,
        confidence: result.confidence,
        match_count: result.match_count,
        subject_count: result.subject_count,
        truncated: result.truncated,
        matches: result.matches,
        sources,
        coverage,
        disclaimer: DISCLAIMER,
        checked_at: new Date().toISOString(),
        // v2 envelope nested under its own key — see ENVELOPE.md §1.6.
        envelope: buildExclusionEnvelope({
          query: mcpQueryEcho,
          verdict: result.verdict,
          confidence: result.confidence,
          matchCount: result.match_count,
          subjectCount: result.subject_count,
          matches: result.matches,
          sources,
          coverageComplete: coverage.complete,
          coverageNote: coverage.note,
          stateSupplied: Boolean(q.state),
        }),
      };

      return {
        status: 200,
        payload: ok(id, {
          // Both forms: `content` for agents that read text, and
          // `structuredContent` for those that consume the schema. The verdict
          // leads the text so a model summarising it cannot lose the answer.
          content: [{
            type: "text",
            text:
              `verdict: ${result.verdict} (confidence ${result.confidence})\n` +
              `${result.match_count} matching record(s) across ` +
              `${result.subject_count} subject(s)\n\n` +
              JSON.stringify(structured, null, 2),
          }],
          structuredContent: structured,
        }),
      };
    }

    default:
      return { status: 200, payload: err(id, -32601, `method not found: ${method}`) };
  }
}

/**
 * x402 payment middleware.
 *
 * Built lazily on the first request rather than at module scope, for two
 * reasons specific to Workers:
 *   - `env` is not available during module evaluation, and the price, network
 *     and payTo all come from env so that flipping to mainnet is a config
 *     change rather than a code change.
 *   - Workers forbid I/O during module initialisation. `paymentMiddleware`
 *     accepts `syncFacilitatorOnStart`, which defaults to TRUE and would try to
 *     reach the facilitator as the middleware is constructed. It is passed
 *     `false` here and the facilitator is contacted per request instead.
 *
 * The built middleware is memoised per configuration signature, so a warm
 * isolate does the setup once but a config change still takes effect.
 *
 * API shape verified against the installed package rather than the README:
 *   paymentMiddleware(routes, server, paywallConfig?, paywall?, syncFacilitatorOnStart?)
 *   RouteConfig.accepts: { scheme, payTo, price, network, maxTimeoutSeconds?, extra? }
 */
import { paymentMiddleware } from "@x402/hono";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";
import type { MiddlewareHandler } from "hono";
import { cdpAuthHeaders } from "./cdp";
import type { Env } from "./env";

let cached: { key: string; handler: MiddlewareHandler } | null = null;

/**
 * Body returned on an unpaid request.
 *
 * A bare 402 with an empty body tells a caller nothing about what to do, so the
 * response names the price, the network and where the machine-readable terms
 * are. The free health endpoint is included because a caller who cannot pay yet
 * should still be able to confirm the service is alive and see what data it
 * holds.
 */
function unpaidBody(env: Env, path: string, price: string) {
  return {
    contentType: "application/json",
    body: {
      error: "payment required",
      endpoint: path,
      price,
      network: env.NETWORK,
      asset: "USDC",
      pay_with: "x402",
      discovery: "/.well-known/x402",
      free_endpoints: ["/v1/health", "/.well-known/x402"],
      note:
        "Send the x402 payment header to access this endpoint. The discovery " +
        "document lists the exact payment requirements.",
    },
  };
}

/** Routes that require payment, priced from env so mainnet is a config flip. */
function routesFor(env: Env, payTo: string) {
  const common = {
    network: env.NETWORK as never,
    payTo,
    scheme: "exact",
    maxTimeoutSeconds: 60,
    // Settle AFTER the handler succeeds, so a request that cannot be served is
    // never charged for.
    //
    // This is already the default for exact/eip3009 — the scheme reports
    // paymentFlows.eip3009 = { supported: ["authorization","upfront"],
    // default: "authorization" }, and resolvePaymentFlowPhases("authorization")
    // gives { verifyBeforeHandler: true, settleBeforeHandler: false,
    // settleAfterHandler: true }. Confirmed empirically too: when a screening
    // query failed with a 500 during an index bug, the payer's balance did not
    // move.
    //
    // It is pinned explicitly anyway. The alternative, "upfront", settles before
    // the handler runs, so if the library default ever changed, every failed
    // request would start taking money and nothing here would flag it.
    extra: { paymentFlow: "authorization" },
  };

  // Bazaar discovery. The CDP facilitator catalogs a resource when it settles a
  // payment on a route that declares this extension, so the declaration is what
  // makes the service discoverable — there is no submission form. Indexing
  // happens on the first paid hit.
  // `method` is deliberately not declared: bazaarResourceServerExtension fills
  // it in from the route during enrichment. Query and body forms are declared
  // separately because the body form additionally requires bodyType.
  const QUERY_INPUT = {
    name: "string", npi: "string", uei: "string", cage: "string", state: "string",
  };
  const CHECK_OUTPUT = {
    example: {
      verdict: "excluded",
      confidence: "match",
      basis: "business_name",
      match_count: 2,
      subject_count: 1,
    },
  };

  const checkDiscoveryGet = declareDiscoveryExtension({
    input: QUERY_INPUT, output: CHECK_OUTPUT,
  });
  const checkDiscoveryPost = declareDiscoveryExtension({
    bodyType: "json", input: QUERY_INPUT, output: CHECK_OUTPUT,
  });
  const reportDiscoveryGet = declareDiscoveryExtension({
    input: QUERY_INPUT,
    output: { example: { verdict: "excluded", matches: [{ record: {} }] } },
  });
  const reportDiscoveryPost = declareDiscoveryExtension({
    bodyType: "json", input: QUERY_INPUT,
    output: { example: { verdict: "excluded", matches: [{ record: {} }] } },
  });

  const check = {
    accepts: { ...common, price: env.PRICE_CHECK },
    description:
      "Screen one name (optionally with NPI, date of birth, or state) against " +
      "the HHS-OIG List of Excluded Individuals and Entities.",
    mimeType: "application/json",
    serviceName: env.SERVICE_NAME,
    tags: ["healthcare", "compliance", "screening", "exclusions"],
    unpaidResponseBody: () => unpaidBody(env, "/v1/check", env.PRICE_CHECK),
  };

  const report = {
    accepts: { ...common, price: env.PRICE_REPORT },
    description:
      "Full screening report: every matching record with complete source " +
      "fields, exclusion and reinstatement dates, and load provenance.",
    mimeType: "application/json",
    serviceName: env.SERVICE_NAME,
    tags: ["healthcare", "compliance", "screening", "exclusions"],
    unpaidResponseBody: () => unpaidBody(env, "/v1/report", env.PRICE_REPORT),
  };

  // The MCP endpoint must be registered here too, priced like /v1/check.
  //
  // The middleware only gates paths it finds in this config; anything else
  // falls through to next(). Omitting "POST /mcp" therefore did NOT leave MCP
  // unprotected-but-obvious — it silently served paid screening results for
  // free over JSON-RPC, verified as a live 200 with real data. src/index.ts
  // only delegates to this middleware for `tools/call` on the paid tool, so
  // registering the path here does not put initialize or tools/list behind the
  // paywall.
  const mcp = {
    ...check,
    description:
      `MCP tool call: ${check.description} Charged per tools/call of the paid ` +
      `tool; initialize and tools/list are free.`,
    unpaidResponseBody: () => unpaidBody(env, "/mcp", env.PRICE_CHECK),
  };

  // Both HTTP methods are registered because both are served; leaving GET
  // unpriced would be a trivially exploitable bypass of the paid POST.
  return {
    "POST /v1/check": { ...check, extensions: checkDiscoveryPost },
    "GET /v1/check": { ...check, extensions: checkDiscoveryGet },
    "POST /v1/report": { ...report, extensions: reportDiscoveryPost },
    "GET /v1/report": { ...report, extensions: reportDiscoveryGet },
    "POST /mcp": mcp,
  };
}

/**
 * Return the payment middleware, or null when payment is not configured.
 *
 * Null means the paid endpoints stay open, which is the pre-payment behaviour
 * and is reported honestly as `payment_configured: false` by /v1/health and the
 * discovery document. Failing closed would be worse here: an unset PAY_TO is a
 * deployment that has not been configured yet, not an attack.
 *
 * Initialisation is the subtle part. `x402ResourceServer` will not build payment
 * requirements until it has asked the facilitator which scheme/network kinds it
 * supports — without that it throws "Facilitator does not support exact on
 * eip155:84532". That fetch cannot happen at module scope (Workers forbid I/O
 * during module evaluation) and it must not be repeated per request, so
 * `initialize()` is kicked off once and every request awaits the same promise.
 *
 * If initialisation fails — facilitator down, network blip — the promise is
 * cleared so the next request retries instead of an isolate being poisoned for
 * its lifetime.
 */
export function getPaymentMiddleware(env: Env): MiddlewareHandler | null {
  const payTo = (env.PAY_TO ?? "").trim();
  if (!payTo) return null;

  const key = [payTo, env.NETWORK, env.PRICE_CHECK, env.PRICE_REPORT,
               env.FACILITATOR_URL].join("|");

  if (cached?.key !== key) {
    // CDP credentials, when present, authenticate every facilitator call. The
    // header factory is path-keyed because @x402/core rejects a flat headers
    // object rather than silently dropping auth. Without credentials the client
    // is unauthenticated, which is correct for the public testnet facilitator.
    const facilitator = new HTTPFacilitatorClient({
      url: env.FACILITATOR_URL,
      createAuthHeaders: cdpAuthHeaders(
        env.FACILITATOR_URL, env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET,
      ),
    });
    const server = new x402ResourceServer(facilitator)
      .register(env.NETWORK as never, new ExactEvmScheme())
      .registerExtension(bazaarResourceServerExtension);

    const inner = paymentMiddleware(
      routesFor(env, payTo) as never,
      server,
      undefined,
      undefined,
      false, // never contact the facilitator during construction
    );

    let ready: Promise<void> | null = null;
    const handler: MiddlewareHandler = async (c, next) => {
      if (!ready) {
        ready = server.initialize().catch((e) => {
          ready = null; // let the next request retry
          throw e;
        });
      }
      await ready;
      return inner(c, next);
    };

    cached = { key, handler };
  }

  return cached.handler;
}

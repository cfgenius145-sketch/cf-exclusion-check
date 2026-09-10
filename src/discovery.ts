/**
 * x402 discovery document.
 *
 * Served free at both /.well-known/x402 and /.well-known/x402.json so a client
 * that guesses either path finds it. The advertised shape is kept in step with
 * what the payment middleware actually puts in the `payment-required` header
 * (x402 v2: accepts[] with scheme/network/amount/asset/payTo/extra), not with
 * the v1 field names, so a client can pay from what it reads here.
 *
 * Prices are declared here from the same env vars the payment middleware uses,
 * so the advertised price cannot drift from the charged price.
 */
import type { Env } from "./env";

export interface DiscoveryEndpoint {
  path: string;
  method: string;
  price: string;
  description: string;
  free: boolean;
}

export function endpoints(env: Env): DiscoveryEndpoint[] {
  return [
    {
      path: "/v1/check", method: "POST",
      price: env.PRICE_CHECK,
      description:
        "Screen one name (optionally with NPI, date of birth, or state) against " +
        "the HHS-OIG List of Excluded Individuals and Entities. Returns a verdict, " +
        "a confidence level, and the reason each record matched.",
      free: false,
    },
    {
      path: "/v1/report", method: "POST",
      price: env.PRICE_REPORT,
      description:
        "Full screening report: every matching record with complete source " +
        "fields, exclusion and reinstatement dates, exclusion authority, and " +
        "load provenance for the data it was screened against.",
      free: false,
    },
    {
      path: "/v1/health", method: "GET", price: "$0.00",
      description: "Row counts, load dates and source freshness. No payment required.",
      free: true,
    },
    {
      path: "/.well-known/x402", method: "GET", price: "$0.00",
      description: "This document. No payment required.",
      free: true,
    },
  ];
}

/** USDC contract for the configured network. */
function asset(network: string): { address: string; symbol: string; decimals: number } | null {
  switch (network) {
    case "eip155:84532": // Base Sepolia testnet
      return { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6 };
    case "eip155:8453":  // Base mainnet
      return { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 };
    default:
      return null;
  }
}

/** "$0.01" -> "10000" (USDC has 6 decimals). */
function atomicAmount(price: string, decimals: number): string {
  const dollars = Number(String(price).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(dollars)) return "0";
  return BigInt(Math.round(dollars * 10 ** decimals)).toString();
}

export function discoveryDocument(env: Env, origin: string): unknown {
  const network = env.NETWORK;
  const tok = asset(network);
  const payTo = env.PAY_TO ?? null;

  // Field names and version mirror what the payment middleware actually emits
  // in the `payment-required` header, verified by decoding a live 402:
  //   {"x402Version":2, "accepts":[{"scheme","network","amount","asset",
  //    "payTo","maxTimeoutSeconds","extra":{"name","version"}}]}
  // Advertising v1's `maxAmountRequired` here while the server speaks v2 would
  // lead a client to build a payment the server rejects, which is worse than
  // publishing no discovery document at all.
  const accepts = endpoints(env)
    .filter((e) => !e.free)
    .map((e) => ({
      scheme: "exact",
      network,
      amount: tok ? atomicAmount(e.price, tok.decimals) : null,
      asset: tok?.address ?? null,
      payTo,
      maxTimeoutSeconds: 60,
      extra: tok ? { name: tok.symbol, version: "2" } : null,
      resource: `${origin}${e.path}`,
      description: e.description,
      mimeType: "application/json",
    }));

  return {
    x402Version: 2,
    resource: origin,
    name: env.SERVICE_NAME,
    description:
      "Pay-per-call screening against the HHS-OIG List of Excluded Individuals " +
      "and Entities (LEIE). Every result states why it matched.",
    // Declared plainly rather than implied: the service is only as current as
    // its last load, and a name match is not an identity determination.
    limitations: [
      "Screens the HHS-OIG LEIE only. It does not screen SAM.gov, state " +
      "Medicaid exclusion lists, or any licensure board action.",
      "A match is a name match, not an identity determination. Confirm against " +
      "the official record at https://exclusions.oig.hhs.gov before acting.",
      "Results reflect the loaded data generation reported by /v1/health, not " +
      "a live query against OIG.",
    ],
    accepts,
    endpoints: endpoints(env),
    facilitator: env.FACILITATOR_URL,
    network,
    payment_configured: Boolean(payTo),
    mcp: { endpoint: `${origin}/mcp`, tools: ["exclusion_check"] },
    terms: `${origin}/v1/health`,
  };
}

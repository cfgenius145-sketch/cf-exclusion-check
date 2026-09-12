/**
 * OpenAPI 3.1 document at /openapi.json.
 *
 * This exists for one reason: x402scan's discovery spec treats OpenAPI as the
 * canonical description of a paid resource (it takes precedence over a bare
 * 402 response), and requires `x-payment-info` on every priced path. Without
 * this file, a paid route registers there with no metadata at all.
 *
 * Prices are read from the same env vars the payment middleware uses (see
 * payment.ts), so this document cannot advertise a price the server does not
 * actually charge — the same discipline discovery.ts already follows for
 * /.well-known/x402.
 */
import type { Env } from "./env";

/** "$0.05" -> 0.05. x-payment-info wants decimal USD, not atomic units. */
function dollars(price: string): number {
  const n = Number(String(price).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

const QUERY_PARAMS = [
  { name: "name", in: "query", schema: { type: "string" },
    description: 'Person or business name. "John Smith" or "Smith, John".' },
  { name: "npi", in: "query", schema: { type: "string" },
    description: "10-digit National Provider Identifier." },
  { name: "dob", in: "query", schema: { type: "string" }, description: "Date of birth, YYYYMMDD." },
  { name: "state", in: "query", schema: { type: "string" }, description: "Two-letter state code. Corroborates only." },
  { name: "uei", in: "query", schema: { type: "string" },
    description: "SAM.gov Unique Entity Identifier, 12 alphanumeric characters." },
  { name: "cage", in: "query", schema: { type: "string" }, description: "CAGE code, 5 alphanumeric characters." },
];

export function openApiDocument(env: Env, origin: string): unknown {
  const paidGet = (summary: string, price: string) => ({
    summary,
    parameters: QUERY_PARAMS,
    "x-payment-info": {
      protocols: ["x402"],
      price: { mode: "fixed", currency: "USD", amount: dollars(price) },
    },
    responses: {
      "200": { description: "Screening result." },
      "402": { description: "Payment required. See the `payment-required` header." },
    },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: env.SERVICE_NAME,
      version: "1.0.0",
      description:
        "Pay-per-call screening against the HHS-OIG LEIE and SAM.gov exclusion lists.",
      "x-guidance":
        "Call GET /v1/health first (free) to confirm the service is live and see " +
        "loaded row counts. GET /.well-known/x402 carries the exact x402 v2 payment " +
        "requirements. A bare unpaid call to /v1/check or /v1/report returns 402, " +
        "not a validation error, even with no query parameters.",
      contact: { email: "info@cfaisolutions.com" },
    },
    servers: [{ url: origin }],
    paths: {
      "/v1/check": { get: paidGet("Screen a name or identifier (brief).", env.PRICE_CHECK) },
      "/v1/report": { get: paidGet("Full screening report.", env.PRICE_REPORT) },
      "/v1/health": {
        get: {
          summary: "Row counts, load dates and source freshness. Free.",
          responses: { "200": { description: "Health status." } },
        },
      },
      "/.well-known/x402": {
        get: {
          summary: "x402 v2 discovery document. Free.",
          responses: { "200": { description: "Discovery document." } },
        },
      },
    },
  };
}

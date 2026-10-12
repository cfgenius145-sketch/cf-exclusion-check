/**
 * A2A Agent Card — https://a2a-protocol.org/latest/specification/ v1.0.0.
 *
 * Served at /.well-known/agent-card.json, the spec's own well-known path
 * (verified against the spec's raw source directly, not a summary — an
 * earlier draft of this file nearly used a wrong path/field set from a
 * secondhand description). Content-type application/a2a+json per §8.6.
 *
 * Deliberately does NOT declare the a2a-x402 extension
 * (https://github.com/google-a2a/a2a-x402/v0.1): that extension wraps
 * payment in A2A's own Task/message lifecycle (payment-required /
 * payment-submitted / payment-completed as A2A messages). This service
 * speaks plain HTTP x402 — a bare 402 challenge — which is a different
 * mechanism. Declaring the extension would claim protocol support that
 * isn't implemented; pricing is stated in prose instead.
 *
 * Real counts are read live (same cheap bookkeeping-table pattern as
 * /v1/health, never a COUNT(*) on the big tables) rather than hardcoded,
 * so this document can't go stale the way a static number would.
 */
import type { Env } from "./env";
import { sourceInfo } from "./screen";
import { stateSourceInfo } from "./state_match";

const STATE_LIST =
  "AZ, CA, KS, MD, MI, MO, MT, NC, ND, NJ, NY, OH, PA, SC, TX, WA";

export async function agentCard(env: Env, origin: string): Promise<unknown> {
  const [federal, state] = await Promise.all([sourceInfo(env), stateSourceInfo(env)]);
  const federalRows = federal.reduce((n, s) => n + s.rows, 0);
  const stateRows = state.reduce((n, s) => n + s.rows, 0);
  const federalAsOf = federal.map((s) => s.loaded_at).filter(Boolean).sort().pop() ?? null;
  const stateAsOf = state.map((s) => s.as_of).filter(Boolean).sort().pop() ?? null;

  return {
    name: env.SERVICE_NAME,
    description:
      `Pay-per-call screening against the HHS-OIG List of Excluded Individuals ` +
      `and Entities (LEIE) and the SAM.gov exclusions list (${federalRows} ` +
      `federal records, most recently loaded ${federalAsOf}), plus Medicaid ` +
      `exclusion lists from 16 states (${STATE_LIST}) — ${stateRows} state ` +
      `records, most recently refreshed ${stateAsOf}. Does NOT screen the ` +
      `other 34 states or licensure board actions. Every result states why ` +
      `it matched. Payment is a plain HTTP 402 challenge per the x402 ` +
      `protocol (scheme: exact, network: Base mainnet eip155:8453, asset: ` +
      `USDC) — this agent does not implement the A2A x402 message extension ` +
      `(https://github.com/google-a2a/a2a-x402/v0.1); a client must speak raw ` +
      `HTTP x402, not A2A payment messages, to pay it. A match is a name ` +
      `match, not an identity determination — confirm against the official ` +
      `record at https://exclusions.oig.hhs.gov or https://sam.gov/search ` +
      `before acting.`,
    version: "2.0.0",
    provider: { name: "CFAISolutions LLC", url: origin },
    documentationUrl: `${origin}/openapi.json`,
    supportedInterfaces: [
      { url: `${origin}/v1/check`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
    ],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "exclusion-check",
        name: "Federal + State Exclusion Screen",
        description:
          `Screen one person or business by name, NPI, UEI, DOB, CAGE, or ` +
          `state against LEIE + SAM.gov + 16 state Medicaid exclusion lists ` +
          `(${STATE_LIST}). $0.05 USDC per call via x402 (HTTP 402, not A2A ` +
          `payment messages). Returns verdict, confidence, and the exact ` +
          `basis of any match. Does not cover the other 34 states or ` +
          `licensure board actions.`,
        tags: ["healthcare", "compliance", "screening", "exclusions", "sam-gov", "leie"],
        examples: ["Screen Jane Doe, NPI 1234567890, for federal and California exclusion"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "exclusion-report",
        name: "Full Exclusion Report",
        description:
          "Everything in exclusion-check plus every matching federal and " +
          "state record's full source fields, exclusion/reinstatement/" +
          "termination dates, excluding agency, and load provenance. " +
          "$0.50 USDC per call via x402.",
        tags: ["healthcare", "compliance", "screening", "exclusions", "sam-gov", "leie", "audit"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
  };
}

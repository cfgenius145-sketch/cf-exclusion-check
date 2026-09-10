#!/usr/bin/env node
/**
 * x402 paying client — Phase A testnet verification.
 *
 * Drives a real payment against the deployed Worker so the whole round trip is
 * exercised, not just the 402 challenge:
 *   1. request without payment  -> expect 402 + `payment-required` header
 *   2. request through the x402 fetch wrapper -> the wrapper signs an EIP-3009
 *      authorization, retries with the payment header, and the facilitator
 *      settles on Base Sepolia
 *   3. print the settlement response header so the transaction is auditable
 *
 * The PAYER is a separate testnet key from PAY_TO: PAY_TO receives, this one
 * spends, and mixing the two would prove nothing about a real payer's path.
 * Both are testnet-only and neither should ever be reused on mainnet.
 *
 * Usage:
 *   node scripts/x402-client.mjs                      # /v1/check
 *   node scripts/x402-client.mjs /v1/report "Name"    # any paid endpoint
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const BASE = process.env.BASE_URL
  ?? "https://cf-exclusion-check.cf-exclusion-check.workers.dev";
const PATH = process.argv[2] ?? "/v1/check";
const NAME = process.argv[3] ?? "Jamsheed Abadi";
const KEYFILE = ".secrets/testnet-payer.json";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC

// --- payer key -------------------------------------------------------------
mkdirSync(".secrets", { recursive: true });
if (!existsSync(KEYFILE)) {
  const privateKey = generatePrivateKey();
  const acct = privateKeyToAccount(privateKey);
  writeFileSync(KEYFILE, JSON.stringify({
    role: "payer", network: "eip155:84532", network_name: "Base Sepolia (testnet)",
    address: acct.address, privateKey, testnet_only: true,
    created: new Date().toISOString(),
    warning: "Testnet only. Never fund or reuse on mainnet.",
  }, null, 2) + "\n");
  chmodSync(KEYFILE, 0o600);
  console.log(`  minted payer key -> ${KEYFILE}`);
}

const payer = JSON.parse(readFileSync(KEYFILE, "utf8"));
const account = privateKeyToAccount(payer.privateKey);

// --- balances --------------------------------------------------------------
const pub = createPublicClient({ chain: baseSepolia, transport: http() });
const balanceOf = [{
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }],
}];
const usdcBal = await pub.readContract({
  address: USDC, abi: balanceOf, functionName: "balanceOf", args: [account.address],
});

console.log(`  payer address : ${account.address}`);
console.log(`  payer USDC    : ${formatUnits(usdcBal, 6)} USDC (Base Sepolia)`);
console.log(`  target        : ${BASE}${PATH}`);
console.log("");

// --- step 1: unpaid ---------------------------------------------------------
const url = `${BASE}${PATH}?name=${encodeURIComponent(NAME)}`;
const unpaid = await fetch(url);
console.log(`  [1] unpaid request        -> HTTP ${unpaid.status}`);
const challenge = unpaid.headers.get("payment-required");
if (challenge) {
  const decoded = JSON.parse(Buffer.from(challenge, "base64").toString("utf8"));
  const a = decoded.accepts?.[0] ?? {};
  console.log(`      x402Version ${decoded.x402Version}, ${a.scheme} on ${a.network}`);
  console.log(`      amount ${a.amount} atomic of ${a.asset}`);
  console.log(`      payTo  ${a.payTo}`);
} else {
  console.log("      no payment-required header — endpoint is not gated");
}
console.log("");

if (usdcBal === 0n) {
  console.log("  [2] SKIPPED — payer holds 0 testnet USDC, so no payment can be signed.");
  console.log("");
  console.log("      Fund this address with Base Sepolia USDC to complete the round trip:");
  console.log(`        ${account.address}`);
  console.log("      Faucets: https://faucet.circle.com (select Base Sepolia)");
  console.log("      Gas is paid by the facilitator under EIP-3009, so USDC alone is enough.");
  process.exit(2);
}

// --- step 2: paid -----------------------------------------------------------
const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }],
});

console.log("  [2] paying request ...");
const paid = await paidFetch(url);
console.log(`      -> HTTP ${paid.status}`);

const settle = paid.headers.get("payment-response");
if (settle) {
  try {
    console.log("      settlement:", JSON.stringify(decodePaymentResponseHeader(settle), null, 2)
      .split("\n").join("\n      "));
  } catch {
    console.log("      settlement header (raw):", settle.slice(0, 200));
  }
}

const body = await paid.json();
console.log("");
console.log("  [3] response body:");
console.log(JSON.stringify(body, null, 2).split("\n").slice(0, 40).join("\n"));

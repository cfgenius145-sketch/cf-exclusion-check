#!/usr/bin/env node
/**
 * x402 paying client.
 *
 * Drives a real payment against the deployed Worker so the whole round trip is
 * exercised, not just the 402 challenge:
 *   1. request without payment  -> expect 402 + `payment-required` header
 *   2. request through the x402 fetch wrapper -> the wrapper signs an EIP-3009
 *      authorization, retries with the payment header, and the facilitator
 *      settles on chain
 *   3. print the settlement response header so the transaction is auditable
 *
 * The network is read from the service's own discovery document, so the client
 * follows a mainnet/testnet flip instead of having to be edited alongside it.
 * ON MAINNET THIS SPENDS REAL MONEY.
 *
 * The PAYER is a separate key from PAY_TO: PAY_TO receives, this one spends, and
 * mixing the two would prove nothing about a real payer's path. The mainnet
 * payer is a build-script key — keep only a few cents in it.
 *
 * Usage:
 *   node scripts/x402-client.mjs                      # /v1/check
 *   node scripts/x402-client.mjs /v1/report "Name"    # any paid endpoint
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, formatUnits } from "viem";
import { base, baseSepolia } from "viem/chains";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

const BASE = process.env.BASE_URL
  ?? "https://cf-exclusion-check.cf-exclusion-check.workers.dev";
const PATH = process.argv[2] ?? "/v1/check";
const NAME = process.argv[3] ?? "Jamsheed Abadi";

/**
 * Network is taken from the service's own discovery document, not hardcoded, so
 * the client cannot sign a testnet payment against a mainnet paywall (or the
 * reverse) after a config flip.
 */
const NETWORKS = {
  "eip155:8453": {
    name: "Base mainnet",
    chain: base,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    keyfile: ".secrets/mainnet-payer.json",
    real: true,
  },
  "eip155:84532": {
    name: "Base Sepolia testnet",
    chain: baseSepolia,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    keyfile: ".secrets/testnet-payer.json",
    real: false,
  },
};

const disco = await fetch(`${BASE}/.well-known/x402`).then((r) => r.json());
const netId = disco.network;
const NET = NETWORKS[netId];
if (!NET) throw new Error(`service advertises unknown network ${netId}`);

const KEYFILE = NET.keyfile;
const USDC = NET.usdc;

// --- payer key -------------------------------------------------------------
mkdirSync(".secrets", { recursive: true });
if (!existsSync(KEYFILE)) {
  const privateKey = generatePrivateKey();
  const acct = privateKeyToAccount(privateKey);
  writeFileSync(KEYFILE, JSON.stringify({
    role: "payer", network: netId, network_name: NET.name,
    address: acct.address, privateKey, testnet_only: !NET.real,
    created: new Date().toISOString(),
    warning: NET.real
      ? "HOLDS REAL FUNDS. Keep the balance to a few cents; this is a " +
        "build-script key, not a treasury."
      : "Testnet only. Never fund or reuse on mainnet.",
  }, null, 2) + "\n");
  chmodSync(KEYFILE, 0o600);
  console.log(`  minted payer key -> ${KEYFILE}`);
}

const payer = JSON.parse(readFileSync(KEYFILE, "utf8"));
const account = privateKeyToAccount(payer.privateKey);

// --- balances --------------------------------------------------------------
const pub = createPublicClient({ chain: NET.chain, transport: http() });
const balanceOf = [{
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }],
}];
const usdcBal = await pub.readContract({
  address: USDC, abi: balanceOf, functionName: "balanceOf", args: [account.address],
});

console.log(`  network       : ${netId} (${NET.name})${NET.real ? "  *** REAL FUNDS ***" : ""}`);
console.log(`  payer address : ${account.address}`);
console.log(`  payer USDC    : ${formatUnits(usdcBal, 6)} USDC`);
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
  console.log("  [2] SKIPPED — payer holds 0 USDC, so no payment can be signed.");
  console.log("");
  console.log(`      Fund this address with USDC on ${NET.name}:`);
  console.log(`        ${account.address}`);
  if (NET.real) {
    console.log("      Send on the **Base** network, not Ethereum — Coinbase");
    console.log("      defaults USDC to Ethereum and a wrong-network send may be");
    console.log("      unrecoverable. A dollar is far more than enough.");
  } else {
    console.log("      Faucet: https://faucet.circle.com (select Base Sepolia)");
  }
  console.log("      Gas is paid by the facilitator under EIP-3009, so USDC alone is enough.");
  process.exit(2);
}

// --- step 2: paid -----------------------------------------------------------
const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: netId, client: new ExactEvmScheme(account) }],
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

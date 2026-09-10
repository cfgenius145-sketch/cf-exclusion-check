#!/usr/bin/env node
/**
 * Generate a TESTNET-ONLY receiving key for x402 Phase A.
 *
 * This key exists to receive Base Sepolia test USDC, which has no monetary
 * value. It is generated on this workstation, written to .secrets/ (mode 600,
 * gitignored) and never placed in wrangler config, because only the ADDRESS is
 * needed by the Worker — the private key is required solely to move funds out,
 * which Phase A never does.
 *
 * Do NOT reuse this key on mainnet. A mainnet payout address should be created
 * in a wallet the operator controls, not minted by a build script.
 */
import { existsSync, writeFileSync, chmodSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const OUT = ".secrets/testnet-payto.json";

if (existsSync(OUT)) {
  const { address } = JSON.parse(await import("node:fs").then(m => m.readFileSync(OUT, "utf8")));
  console.log(`  existing key kept: ${address}`);
  console.log(`  (delete ${OUT} to mint a new one)`);
  process.exit(0);
}

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

writeFileSync(OUT, JSON.stringify({
  network: "eip155:84532",
  network_name: "Base Sepolia (testnet)",
  address: account.address,
  privateKey,
  testnet_only: true,
  created: new Date().toISOString(),
  warning: "Testnet only. Never fund or reuse on mainnet.",
}, null, 2) + "\n");
chmodSync(OUT, 0o600);

console.log(`  address     : ${account.address}`);
console.log(`  network     : eip155:84532 (Base Sepolia testnet)`);
console.log(`  private key : written to ${OUT} (mode 600, gitignored)`);

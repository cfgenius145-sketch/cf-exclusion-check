# Going to mainnet

Everything here is verified. Nothing in this file has been applied — the service
is still on Base Sepolia testnet, because three things are required that the
operator must supply.

## Why it is not already done

### 1. No receiving address was supplied

The instruction read `PAY_TO = [YOUR COINBASE BASE USDC ADDRESS]` — a literal
placeholder. On mainnet `payTo` is where real USDC lands. An address that is
wrong, or that nobody holds the keys to, loses every payment irreversibly. It is
not a value to guess, infer, or substitute.

### 2. The configured facilitator does not support mainnet

`https://x402.org/facilitator` is testnet-only. Its `/supported` endpoint,
queried live:

```
algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe   exact
aptos:2                                     exact
base-sepolia                                exact
eip155:84532                                batch-settlement, exact, upto
hedera:testnet                              exact
solana-devnet                               exact
stellar:testnet                             exact
xrpl:1                                      exact
```

**`eip155:8453` is absent.** Changing `NETWORK` while leaving this facilitator in
place makes every paid request fail with
`Facilitator does not support exact on eip155:8453` — the same failure mode seen
in Phase A when `initialize()` was skipped. Mainnet needs Coinbase's CDP
facilitator, which requires a CDP API key and secret.

### 3. The testnet balance cannot become mainnet funds

Base Sepolia USDC is test script with no value and **no bridge to mainnet**. The
19.94 test USDC held by the payer key can never fund a real payment. A mainnet
`$0.01` check requires real USDC bought or transferred on Base mainnet.

## What is already correct

- The Base mainnet USDC contract in `src/discovery.ts` is verified on-chain:
  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, chainId **8453**, `USD Coin`,
  symbol `USDC`, **6 decimals**. So `$0.01` → `10000` atomic is right.
- Prices, network and `payTo` are all read from config, so the flip is a config
  change with no code change.

## Exact steps

### Step 1 — get a Base mainnet USDC address you control

In the Coinbase app or on coinbase.com:

1. **Search for USDC** and open the asset page.
2. **Receive** → choose **USDC**.
3. **Set the network to `Base`.** This is the step that matters. Coinbase
   defaults to Ethereum for USDC; an Ethereum-network address will not receive
   Base payments, and funds sent to the wrong network may be unrecoverable.
4. Copy the `0x…` address. That is `PAY_TO`.

A self-custody wallet (Coinbase Wallet, Rainbow, Foundry-generated key) works
equally well — the only requirement is that you hold the keys and the address is
on Base.

> Do not reuse `0x3416DD0D9182cd5D806Ac21112dd24f87e1E84ac`. That is the
> testnet key minted by `scripts/gen-testnet-key.mjs`; its private key sits in
> `.secrets/` on a workstation, which is not where a revenue address belongs.

### Step 2 — get CDP facilitator credentials

1. Sign in at <https://portal.cdp.coinbase.com>.
2. Create an API key (key id + secret).
3. Set them as Worker secrets:

```bash
npx wrangler secret put CDP_API_KEY_ID
npx wrangler secret put CDP_API_KEY_SECRET
```

`src/payment.ts` builds its `HTTPFacilitatorClient` from `FACILITATOR_URL`; the
CDP facilitator additionally needs auth headers, which is a small code change to
pass `createAuthHeaders` into the client. That change is not made here because it
cannot be tested without the credentials.

### Step 3 — flip the config

In `wrangler.jsonc`:

```jsonc
"NETWORK": "eip155:8453",
"PAY_TO":  "0xYOUR_BASE_ADDRESS",
"FACILITATOR_URL": "https://api.cdp.coinbase.com/platform/v2/x402",
```

Then `npx wrangler deploy`.

### Step 4 — verify before taking money

```bash
curl -s https://cf-exclusion-check.cf-exclusion-check.workers.dev/v1/health \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['network'],d['payment_configured'])"
```

Expect `eip155:8453 True`. Then confirm the 402 challenge advertises mainnet:

```bash
curl -s -D - -o /dev/null \
  "https://cf-exclusion-check.cf-exclusion-check.workers.dev/v1/check?name=Test" \
  | grep -i payment-required
```

Decode it and check `network` is `eip155:8453`, `asset` is
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, and `payTo` is **your** address.
Verify `payTo` character by character before any payment is made.

### Step 5 — one real $0.01 check

Fund a payer wallet with a small amount of USDC **on Base**, put its key in
`.secrets/mainnet-payer.json`, and run:

```bash
node scripts/x402-client.mjs /v1/check "USA Remediation Services, Inc"
```

Confirm receipt on-chain rather than trusting the response:

```bash
node -e "
const {createPublicClient,http,formatUnits}=require('viem');
const abi=[{name:'balanceOf',type:'function',stateMutability:'view',
  inputs:[{name:'a',type:'address'}],outputs:[{type:'uint256'}]}];
(async()=>{const c=createPublicClient({transport:http('https://mainnet.base.org')});
console.log(formatUnits(await c.readContract({
  address:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',abi,
  functionName:'balanceOf',args:['0xYOUR_BASE_ADDRESS']}),6),'USDC');})();"
```

## Bazaar / x402scan indexing

Indexing is **not** a submission form. Verified against the live discovery API
(<https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources>, which needs
no API key): it returns real mainnet resources on `eip155:8453`, and this service
is absent from it.

Three conditions have to hold before it appears:

1. **Payments run through the CDP facilitator.** The Bazaar is populated by the
   CDP facilitator as it settles payments. A resource paid through
   `x402.org/facilitator` is never seen by it, regardless of what the discovery
   document says.
2. **The route declares the bazaar extension** with `discoverable: true`.
3. **At least one real payment settles** on that route. Indexing happens on first
   paid hit; a `$0.01` call is enough.

So the ordering is forced: address → CDP credentials → mainnet flip → one paid
call → indexing. There is nothing to submit and nothing to wait on beyond that
first settled payment.

Check for the listing afterwards with:

```bash
curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100" \
  | grep -o "cf-exclusion-check" | head -1
```

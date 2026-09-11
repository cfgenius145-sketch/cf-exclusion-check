# Mainnet

**Live on Base mainnet (`eip155:8453`).** Payments are real USDC.

| setting | value |
|---|---|
| network | `eip155:8453` |
| `PAY_TO` | `0xCa28eb92657F8a81aFb5493b3a04A740B204d816` |
| facilitator | `https://api.cdp.coinbase.com/platform/v2/x402` |
| asset | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (USD Coin, 6 decimals, verified on-chain) |
| payment flow | `authorization` — settle **after** the handler succeeds |

## The three things that made this non-trivial

### The public facilitator is testnet-only

`https://x402.org/facilitator` does not support mainnet. Its `/supported`
endpoint returns `eip155:84532`, `base-sepolia`, `solana-devnet`,
`hedera:testnet`, `stellar:testnet`, `xrpl:1`, `aptos:2` and an Algorand
devnet — **no `eip155:8453`**. Pointing `FACILITATOR_URL` back at it makes every
paid request fail with `Facilitator does not support exact on eip155:8453`.

The CDP facilitator does support it: `exact`, `upto` and `batch-settlement` on
`eip155:8453`, plus Polygon, Arbitrum, World Chain and Solana.

### CDP auth is a signed JWT per request

`/supported` requires auth (401 without it), while `/discovery/resources` does
not. Implemented in `src/cdp.ts`:

- The secret is base64 of **64 bytes**: a 32-byte Ed25519 seed followed by the
  32-byte public key.
- WebCrypto imports an Ed25519 private key only as **PKCS8**, so the seed is
  wrapped in the fixed RFC 8410 prefix
  (`302e020100300506032b657004220420`). No Node-only crypto API is used, because
  this has to run inside a Worker.
- Header `{ alg: "EdDSA", kid, typ: "JWT", nonce }`; payload
  `{ sub, iss: "cdp", aud: [host], nbf, exp, uris: ["<METHOD> <host><path>"] }`.
- `uris` pins a token to one method and path, so a **separate token is minted
  per endpoint**.
- `createAuthHeaders` must return headers **keyed by path**
  (`verify`/`settle`/`supported`/`bazaar`). Returning a flat
  `{ Authorization }` object throws — by design, since it would otherwise
  silently drop auth on every request.

### Settlement order is what makes failures safe

`extra.paymentFlow` selects the flow. `authorization` resolves to
`verifyBeforeHandler: true, settleBeforeHandler: false, settleAfterHandler:
true` — the payment is verified up front and settled only after the handler
returns successfully, so a 5xx or 503 costs the caller nothing. It is already
the default for `exact`/`eip3009`, and it is pinned explicitly anyway: the
alternative, `upfront`, settles before the handler, so a change in the library
default would start charging for failed requests with nothing flagging it.

Confirmed empirically on testnet: when a screening query failed with a 500
during an index bug, the payer's balance did not move.

## Reverting to testnet

`NETWORK` → `eip155:84532`. CDP supports both, so the facilitator and
credentials stay as they are. `scripts/x402-client.mjs` reads the network from
the discovery document and switches payer keys automatically.

## Keys

| file | role | note |
|---|---|---|
| `.secrets/mainnet-payer.json` | spends, for verification calls | holds **real** funds; keep a few cents only |
| `.secrets/testnet-payer.json` | spends, testnet | valueless |
| `.secrets/testnet-payto.json` | old testnet receiver | superseded by the Coinbase address |

`PAY_TO` is a var rather than a secret: a receiving address is public by nature
— it is published in every 402 challenge — and keeping it in config makes a
change of payout destination reviewable in a diff instead of invisible in a
secret store.

## Bazaar indexing

Indexing is not a submission form. Verified against the live discovery API
(<https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources>, no key
required): it returns real `eip155:8453` resources.

Three conditions must hold:

1. Payments settle through the **CDP facilitator** — a resource paid via
   `x402.org/facilitator` is never seen by the catalog, whatever its discovery
   document says.
2. The route declares the bazaar extension. Done: `routesFor()` in
   `src/payment.ts` attaches `declareDiscoveryExtension(...)` to each paid route,
   and `bazaarResourceServerExtension` is registered on the resource server. The
   live 402 carries `extensions: ["bazaar"]`.
3. **At least one real payment settles.** The catalog indexes on first paid hit.

Check with:

```bash
curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100" \
  | grep -o "cf-exclusion-check"
```

# CF Exclusion Check — source research (TASK 1)

Read 2026-09-10. x402 tooling moves fast; everything below is what the current
docs actually say, not recalled from memory. Where two authoritative sources
disagree, that is recorded rather than smoothed over.

## Documents read

| # | URL | what it gave |
|---|---|---|
| 1 | https://developers.cloudflare.com/agents/agentic-payments/x402 | package list, facilitator URL, `paidTool` mention |
| 2 | https://developers.cloudflare.com/agents/tools/payments/x402/charge-for-http-content/ | full HTTP gating example + wrangler `vars` shape |
| 3 | https://github.com/cloudflare/agents/blob/main/examples/x402/README.md | HTTP gating with the `@x402/*` generation |
| 4 | https://raw.githubusercontent.com/cloudflare/agents/main/examples/x402-mcp/README.md | paid MCP tool signature |
| 5 | https://github.com/xpaysh/awesome-x402 (via search) | Bazaar / discovery-document context |

Cloudflare's `charge-for-mcp-tools` page timed out on fetch (60s); the
`examples/x402-mcp` README above covers the same ground.

## RESOLVED: which HTTP middleware generation is current

Settled against the npm registry on 2026-09-10:

| package | latest | last modified | verdict |
|---|---|---|---|
| **`@x402/hono`** | **2.25.0** | **2026-09-04** | **CURRENT** |
| `x402-hono` | 1.2.0 | 2026-04-16 | legacy, 5 months stale |
| `@x402/fetch` | 2.25.0 | 2026-09-04 | current (client side) |
| `@x402/evm` | 2.25.0 | 2026-09-04 | current (scheme) |
| `x402` | 1.2.0 | 2026-04-16 | legacy |

The scoped `@x402/*` v2 line is current. **Cloudflare's own docs page
(`charge-for-http-content`) is five months out of date** — it shows
`x402-hono` with `network: "base-sepolia"`.

The real v2.25.0 API matches **neither** doc I had read. Taken verbatim from
the published package README, this is the authoritative pattern:

```typescript
import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const facilitatorClient = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme());

app.use(
  paymentMiddleware(
    {
      "GET /protected-route": {
        accepts: {
          scheme: "exact",
          price: "$0.10",
          network: "eip155:84532",
          payTo: "0xYourAddress",
        },
        description: "Access to premium content",
      },
    },
    resourceServer,
  ),
);
```

Signature, from `dist/cjs/index.d.ts`:

```
paymentMiddleware(routes: RoutesConfig, server: x402ResourceServer,
                  paywallConfig?, paywall?, syncFacilitatorOnStart?)
```

Note the ordering: **routes first, then the server instance.** The Cloudflare
docs page has payTo first; the agents-repo README omits the server argument
entirely. Both would fail to compile against 2.25.0.

Also exported: `paymentMiddlewareFromConfig(routes, facilitatorClients?, schemes?, ...)`
for the case where you want the middleware to build the resource server itself,
and `paymentMiddlewareFromHTTPServer(httpServer, ...)` when you need HTTP-level
hooks.

Dependencies to install: `@x402/hono@^2.25.0`, `@x402/evm@^2.25.0`,
`@x402/core` (transitive but imported directly), plus peers `hono@^4.0.0` and
`@x402/paywall@^2.25.0`.

Networks confirmed CAIP-2: `eip155:84532` = Base Sepolia, `eip155:8453` = Base
mainnet. Phase A → Phase B is one string plus `PAY_TO_ADDRESS`.

## Settled facts

**Facilitator.** One public endpoint in all Cloudflare examples:
`https://x402.org/facilitator`, operated by Coinbase. The docs give **no
separate testnet/mainnet facilitator URLs** — the network is selected per-route,
not per-facilitator. So Phase A → Phase B is a network-string change plus
`PAY_TO_ADDRESS`, exactly as the brief assumes.

**Networks.** Base Sepolia = `eip155:84532` (Gen B) or `"base-sepolia"` (Gen A).
Base mainnet = `eip155:8453` / `"base"`. Test USDC comes from the Circle faucet.

**Paid MCP tool**, verbatim from source 4:

```typescript
server.paidTool(
  "square",
  "Squares a number",
  0.01,
  { number: z.number() },
  {},
  async ({ number }) => ({
    content: [{ type: "text", text: String(number ** 2) }]
  })
);
```

- provided by `agents/x402`, which also exports `withX402`, `withX402Client`,
  `X402Config`
- price is a **bare number in USD** (`0.01`), not a `"$0.01"` string as in the
  HTTP middleware — a real inconsistency between the two APIs, worth noting so
  the MCP tool is not priced 100× wrong
- input schema must be a **raw Zod shape** (`{ number: z.number() }`), not an
  AI-SDK flexible schema
- facilitator config: `facilitator: { url: "https://x402.org/facilitator" }`
- the served path is **not documented**; the brief specifies `/mcp`, which we
  will set explicitly

**Discovery document.** Served at **both** `/.well-known/x402` and
`/.well-known/x402.json` with identical JSON — sources describe the Bazaar
manifest as `.well-known/x402.json` while the brief specifies the extensionless
path, and serving both costs nothing. No formal JSON schema was found, so the
acceptance criterion is **"matches the documented field set"** rather than
schema validation (agreed with Christian, 2026-09-10).

## Decisions

| decision | choice | why |
|---|---|---|
| framework | **Hono** | it is what every Cloudflare x402 example uses; the middleware ships as Hono middleware, so anything else means hand-rolling the 402 flow |
| x402 HTTP | **`@x402/hono` 2.25.0** | resolved against npm; the `x402-hono` v1 line is 5 months stale |
| MCP | **`agents/x402` `paidTool`** on `/mcp` | it is the only documented paid-MCP path on Workers, and it reuses the same facilitator |
| DB | **D1** | free tier, SQLite, per the brief |
| price format | `"$0.01"` / `"$0.25"` for HTTP, `0.01` / `0.25` for `paidTool` | the two APIs genuinely differ; see the note above |

## Not yet read

- Stripe x402 seller docs — deferred until `STRIPE_*` vars exist; the brief
  makes that conditional and no Stripe vars have been supplied.
- A formal discovery-document JSON schema, if one exists.

---

## Data sources, verified live 2026-09-10

### LEIE active exclusions list

- `https://oig.hhs.gov/exclusions/downloadables/UPDATED.csv`
- `content-length: 15608468`, `content-type: text/csv`,
  `last-modified: Thu, 10 Sep 2026 12:13:06 GMT`
- `sha256 175352046e438bc477fe0f8985c645c3eb492114b449e13a5700b30e00d27417`
- Header read from the file, not assumed (18 columns):
  `LASTNAME,FIRSTNAME,MIDNAME,BUSNAME,GENERAL,SPECIALTY,UPIN,NPI,DOB,ADDRESS,CITY,STATE,ZIP,EXCLTYPE,EXCLDATE,REINDATE,WAIVERDATE,WVRSTATE`
- Placeholders: NPI `0000000000`, dates `00000000`. Dates are `YYYYMMDD`.
- 84,001 data rows -> **83,975 stored** (26 byte-identical repeat lines collapsed).
- Contains **only currently-excluded** subjects: `REINDATE` is `00000000` on every
  one of the 84,001 rows. A reinstated person simply disappears from this file.

### LEIE monthly supplements

The obvious URL guess is wrong and 404s (`/downloadables/0826REIN.csv`). The real
pattern, read off the live supplement-downloads page, is:

- `https://oig.hhs.gov/exclusions/leie-database-supplement-downloads/` - the
  authority on which months exist
- `https://oig.hhs.gov/exclusions/downloadables/<YYYY>/<YYMM>rein.csv`
- `https://oig.hhs.gov/exclusions/downloadables/<YYYY>/<YYMM>excl.csv`
- 20 reinstatement files published (2501-2608), 1,061 rows total, same 18-column
  schema, and here `REINDATE` is populated on every row.
- Sizes: `2608rein.csv` 7,885 bytes / 41 rows; `2608excl.csv` 37,821 bytes / 200 rows.
- A month's supplement appears during the *following* month, so the current
  month is normally a 404. That is expected, not an error.

Loading the reinstatement supplements is what lets a query answer "matched -
excluded 2011-06-20, reinstated 2026-08-11, not currently excluded" instead of a
bare "no match" that hides the history.

### Two upstream behaviours that constrain the design

**1. No Range support.** `Range: bytes=1000000-1010239` against `UPDATED.csv`
returns **HTTP 200 with all 15,608,468 bytes**, with no `accept-ranges` and no
`content-range`. The file cannot be walked in slices.

**2. A missing User-Agent is rejected.** Verified by direct comparison:

| request | result |
|---|---|
| `HEAD` with `curl/*` UA | 200 |
| `HEAD` with **empty** UA | **403** |
| `HEAD` with `cf-exclusion-check/1.0` | 200 |
| `HEAD` with `Mozilla/5.0` | 200 |

The Workers runtime sends no UA by default, so every request in `src/loader.ts`
sets one explicitly. The first freshness probe failed with `HEAD 403` for exactly
this reason.

## Why the loader is split between a script and the cron

Free-plan limits, all verified: **10 ms CPU per invocation including cron
triggers**, 50 subrequests/request, **100 bound parameters per query**, **50 D1
queries per invocation**, 500 MB per database.

The `exclusions` table has 27 columns, so a bound-parameter write carries at most
**3 rows per query** and roughly 90-150 rows per invocation.

**The full list cannot be loaded in-Worker at any cadence.** No Range support
means every invocation would download all 15.6 MB, and parsing 15.6 MB alone is
far past 10 ms of CPU. A byte-offset cursor cannot rescue it; `load_cursor` was
designed for that approach and is dropped in migration `0002`.

So:

| work | where | why |
|---|---|---|
| bulk generation (83,975 rows) | `scripts/build-seed.mjs` + `wrangler d1 execute` | needs CPU and query volume the free plan does not give |
| monthly supplements (41-200 rows) | Worker cron | small enough to fetch, parse and write within the limits |
| freshness of the bulk generation | Worker cron (`HEAD`) | cheap, and the only affordable way to speak truthfully about staleness |

The supplements add new exclusions and record reinstatements. They do **not**
catch a record removed for any other reason - only a full reconcile does, and
that needs a reseed. `/v1/health` reports `freshness.reseed_due` from the probe
rather than implying the data is current.

The 200-row exclusion supplement needs 67 queries to write, past the
50-per-invocation ceiling, so `supplement_progress` (migration `0003`) carries a
row offset and the merge resumes across invocations. A row cursor works here
where a byte cursor could not, because a 38 KB file is cheap to re-fetch.
Verified converging 90 -> 180 -> 200 -> done.

### Applying the seed

A single 24 MB file makes `wrangler d1 execute --remote` fail in its post-upload
ingest poll (`fetch failed`), so the seed is emitted as ordered ~1.4 MB parts.
Individual parts also fail transiently with the same error and succeed on retry;
apply them in order with a retry loop. `wrangler d1 import` does not exist in
4.131.0. `wrangler d1 migrations apply --remote` has no `-y` flag and needs
`CI=true` to run unattended.

### Row identity

The row id is `sha256(source + U+0001 + <entire source line>)[:32]`.

A narrower key (name + npi + excltype + excldate + zip) collapsed 45 rows, and
**19 of those groups were not identical lines** - LEIE carries near-duplicates
differing on address, general, specialty, UPIN or DOB. Two differed on **DOB
alone**: `VAZQUEZ DE LLADO YAMILA` (19660717 / 19660712) and `VIVANCO CARIDAD`
(19391106 / 19401106). Collapsing those would silently discard a date of birth a
caller may screen against, so the whole line is hashed and only byte-identical
repeats collapse.

The consequence is that one subject can hold several rows - `JERMAINE DOLEMAN`
has 3. Responses therefore report `match_count` (matching rows) **and**
`subject_count` (distinct subjects) so the count cannot be read as three separate
exclusions.

This also makes the cron idempotent against the bulk seed: merging `2608excl.csv`
(200 rows already present in `UPDATED.csv`) left the `leie` count at exactly
83,975, because each supplement line hashed to a row id already in the table.

---

## x402 Phase A (testnet), verified 2026-09-10

Installed: `@x402/hono` `@x402/evm` `@x402/core` `@x402/paywall` all **2.25.0**,
`viem` 2.56.3, `@x402/fetch` 2.25.0 (dev, client only).

API confirmed against the installed `.d.ts`, not the README:

- `paymentMiddleware(routes, server, paywallConfig?, paywall?, syncFacilitatorOnStart?)`
- `RoutesConfig = Record<string, RouteConfig> | RouteConfig`, keyed `"POST /v1/check"`
- `RouteConfig.accepts: PaymentOption | PaymentOption[]` where
  `PaymentOption = { scheme, payTo, price, network, maxTimeoutSeconds?, extra? }`
- `RouteConfig.unpaidResponseBody?` returns `{ contentType, body }`
- `x402ResourceServer.initialize(): Promise<void>`
- client: `wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network, client }] })`
  with `new ExactEvmScheme(account)` from `@x402/evm/exact/client`

### Two Workers-specific traps

**1. `initialize()` is mandatory and cannot run at module scope.**
`paymentMiddleware`'s `syncFacilitatorOnStart` defaults to true, which would do
network I/O while the module is evaluating — forbidden in Workers. Passing
`false` avoids that, but then the server has never asked the facilitator which
kinds it supports and every request fails with:

```
Facilitator does not support exact on eip155:84532.
Make sure to call initialize() to fetch supported kinds from facilitators.
```

Fix: pass `false`, then `await server.initialize()` once on the first request
with the promise memoised, clearing it on failure so the next request retries
rather than poisoning the isolate for its lifetime. See `src/payment.ts`.

**2. Both HTTP methods must be priced.** Registering only `POST /v1/check`
leaves `GET /v1/check` free, which is a one-line bypass of the paywall. All four
route/method pairs are registered.

### The 402 challenge lives in a header, not the body

x402 v2 puts the machine-readable challenge in the **`payment-required`**
response header as base64 JSON. Overriding `unpaidResponseBody` therefore does
not break protocol compliance — clients read the header. A live decode:

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": { "url": ".../v1/check?name=...", "serviceName": "CF Exclusion Check", ... },
  "accepts": [{
    "scheme": "exact", "network": "eip155:84532",
    "amount": "10000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x3416DD0D9182cd5D806Ac21112dd24f87e1E84ac",
    "maxTimeoutSeconds": 60,
    "extra": { "name": "USDC", "version": "2" }
  }]
}
```

`amount` is atomic USDC (6 decimals): `10000` = $0.01, `250000` = $0.25.

**This corrected a real bug in our discovery document**, which had declared
`x402Version: 1` and the v1 field name `maxAmountRequired`. A client trusting it
would have built a v1 payment the server rejects. `src/discovery.ts` now mirrors
the v2 wire shape (`amount`, `x402Version: 2`).

### Header names

| direction | header | note |
|---|---|---|
| request | `payment-signature` | v2 |
| request | `x-payment` | v1, still accepted by the adapter |
| response | `payment-required` | the 402 challenge |
| response | `payment-response` | settlement result |

The request log derives `paid` from "a payment header was present **and** the
response was < 400", so a 402 or a forged header is recorded as an attempt, not
as revenue. Verified: three forged-header requests all returned 402 and the
`paid=1` count stayed at 0.

### Keys

Two separate testnet-only keys, both in `.secrets/` (mode 600, gitignored):

| file | role | address |
|---|---|---|
| `testnet-payto.json` | receives (`PAY_TO`) | `0x3416DD0D9182cd5D806Ac21112dd24f87e1E84ac` |
| `testnet-payer.json` | spends (test client) | `0xD4FdE74c47fF2AB01cF8A8daf65E78C38dE32650` |

Kept distinct deliberately: paying yourself proves nothing about a real payer's
path. Neither may be reused on mainnet; a mainnet payout address should come
from a wallet the operator controls, not from a build script.

### Flipping to mainnet

Change exactly two vars in `wrangler.jsonc`: `NETWORK` to `eip155:8453` and
`PAY_TO` to a mainnet address. The mainnet USDC contract is already mapped in
`src/discovery.ts` (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). No code change.

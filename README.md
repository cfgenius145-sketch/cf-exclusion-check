# CF Exclusion Check

Pay-per-call screening against the **HHS-OIG List of Excluded Individuals and
Entities (LEIE)**, on Cloudflare Workers. Charged per request with
[x402](https://x402.org), and exposed to agents as an MCP tool.

Every result states *why* it matched. A screening answer that cannot be
explained is worse than no answer, because someone may act on it.

**Live:** `https://cf-exclusion-check.cf-exclusion-check.workers.dev`
**Network:** Base Sepolia testnet (`eip155:84532`) — not yet on mainnet.

---

## What it screens

| source | rows | what it is |
|---|---|---|
| `leie` | 83,975 | the LEIE active exclusions list |
| `leie_rein` | 1,061 | 20 months of LEIE reinstatement supplements |

The reinstatement supplements matter. `UPDATED.csv` holds **only currently
excluded** subjects, so a reinstated person simply disappears from it and a bare
"no match" hides their history. With the supplements loaded, the same query
answers the more useful thing:

> matched — excluded 2020-01-20, reinstated 2025-01-22, **not currently excluded**

### What it does *not* screen

- SAM.gov exclusions
- state Medicaid exclusion lists
- licensure board actions

A match here is a **name match, not an identity determination**, and a non-match
is not a clearance. Confirm against the official record at
<https://exclusions.oig.hhs.gov> before acting against a person.

---

## Endpoints

| endpoint | price | notes |
|---|---|---|
| `POST\|GET /v1/check` | **$0.01** | verdict, confidence, basis, reason per match |
| `POST\|GET /v1/report` | **$0.25** | every match with full source fields |
| `GET /v1/health` | free | row counts, load dates, freshness |
| `GET /.well-known/x402` | free | discovery document (also at `…/x402.json`) |
| `POST /mcp` | $0.01 per paid tool call | JSON-RPC; discovery is free |
| `POST /admin/reload` | — | `ADMIN_TOKEN` required |

### Query fields

| field | notes |
|---|---|
| `name` | `"John Smith"`, `"Smith, John"` or a business name. Wildcards rejected. |
| `npi` | 10 digits. The strongest signal. |
| `dob` | `YYYYMMDD`. |
| `state` | Two letters. **Corroborates only** — never creates or suppresses a match. |

### Verdicts

| verdict | meaning |
|---|---|
| `excluded` | matched on an **identifying** basis and the record carries no reinstatement date |
| `possible_match` | matched only on surname + first initial. A lead, not a finding. |
| `reinstated_only` | matched, but every match has been reinstated |
| `no_match` | nothing matched |

`excluded` requires an *identifying* basis — an NPI, a full personal name, or a
business name. A surname plus a first initial never produces it, **even when a
supplied state agrees**. Sharing a state with millions of people is
corroboration, not identification, and "excluded" is a verdict someone can lose
a job over.

Each match also reports `basis`: `npi`, `business_name`, `full_name` or
`surname_initial`.

### Two counts, deliberately

`match_count` is matching **rows**; `subject_count` is distinct **subjects**.
LEIE records some subjects more than once — one person in the list has three
rows differing only by address — so reporting a single number would read as
three separate exclusions.

---

## Paying

An unpaid call returns **402** with the machine-readable challenge in the
`payment-required` header (base64 JSON, x402 v2):

```json
{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532",
  "amount":"10000","asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "payTo":"0x…","maxTimeoutSeconds":60,"extra":{"name":"USDC","version":"2"}}]}
```

`amount` is atomic USDC (6 decimals): `10000` = $0.01.

```bash
node scripts/x402-client.mjs               # /v1/check
node scripts/x402-client.mjs /v1/report "Some Name"
```

Gas is paid by the facilitator under EIP-3009, so a payer needs USDC only.

## MCP

```bash
curl -X POST $BASE/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

| tool | price |
|---|---|
| `exclusion_check` | $0.01 per call |
| `exclusion_sources` | free |

`initialize`, `ping` and `tools/list` are free so an agent can discover the tool
and its price before paying — charging for discovery would make it
undiscoverable. Only `tools/call` on the paid tool is charged.

Implemented as stateless JSON-RPC rather than with `McpAgent`, which keeps
session state in a Durable Object; every method used here is a pure
request/response exchange, so no session state is needed and the service stays
on the free tier.

## Rate limits

| bucket | limit |
|---|---|
| free | 10 / min |
| paid (request carries a payment header) | 60 / min |

Keyed on a salted hash of the client IP. `/v1/health` and the discovery document
are **never** limited — they are how a caller checks whether the service is
alive, and throttling them would make an outage indistinguishable from a limit.

---

## Architecture, and one honest constraint

The loader is split, because the full list **cannot** be loaded inside a Worker
on the free plan:

- `oig.hhs.gov` ignores `Range` requests — a byte-range request returns HTTP 200
  with all 15,608,468 bytes — so the file cannot be walked in slices.
- The free plan gives 10 ms CPU per invocation, cron triggers included. Parsing
  15.6 MB is far past that.

| work | where |
|---|---|
| bulk generation (83,975 rows) | `scripts/build-seed.mjs` + `wrangler d1 execute` |
| monthly supplements (41–200 rows) | Worker cron |
| freshness of the bulk generation | Worker cron, `HEAD` only |

Supplements add new exclusions and record reinstatements. They do **not** catch
a record removed for any other reason — only a full reconcile does, and that
needs a reseed. So `/v1/health` reports `freshness.reseed_due` from a daily HEAD
probe rather than implying the data is current.

`docs/SOURCES.md` records every measurement behind these claims.

## Local development

```bash
npm install
npm test                       # 47 tests
npm run typecheck

npm run migrate:local
npm run seed:build             # downloads UPDATED.csv, emits seed/ parts
node scripts/build-rein-seed.mjs
npx wrangler d1 execute cf_exclusions --local --file=seed/leie-seed.00.sql   # …and each part in order

printf 'ADMIN_TOKEN=dev\nIP_HASH_SALT=dev\n' > .dev.vars
npx wrangler dev
```

Apply seed parts **in order** with a retry loop: a single 24 MB file makes
`wrangler d1 execute --remote` fail in its post-upload ingest poll, and
individual parts fail transiently and succeed on retry. `wrangler d1 import`
does not exist in wrangler 4.131.0, and `migrations apply --remote` needs
`CI=true` to run unattended.

## Deploying

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put IP_HASH_SALT
npx wrangler deploy
```

### Going to mainnet

Change exactly two vars in `wrangler.jsonc`:

```jsonc
"NETWORK": "eip155:8453",
"PAY_TO":  "0x…"          // from a wallet you control
```

Mainnet USDC is already mapped in `src/discovery.ts`. No code change.

**The current `PAY_TO` is a testnet-only key** minted by
`scripts/gen-testnet-key.mjs`, with its private key in `.secrets/` (gitignored).
Never reuse it on mainnet — a payout address should come from a wallet you
control, not from a build script.

## Privacy

- Raw client IPs are never stored. They are HMAC'd with `IP_HASH_SALT`; without
  a salt no hash is written at all, because an unsalted SHA-256 of an IPv4
  address is trivially reversible across the whole 2^32 space.
- Queried names are never stored, only a salted hash, so the log cannot become a
  list of who was screened.
- Street addresses are in the source data but are never selected and never
  returned by any endpoint.

## Licence

MIT. LEIE data is published by the HHS Office of Inspector General and is in the
public domain; this project is not affiliated with or endorsed by HHS-OIG.

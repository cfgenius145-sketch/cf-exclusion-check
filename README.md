# CF Exclusion Check

Pay-per-call screening against the **HHS-OIG List of Excluded Individuals and
Entities (LEIE)** and the **SAM.gov exclusions list**, on Cloudflare Workers.
Charged per request with [x402](https://x402.org), and exposed to agents as an
MCP tool.

Every result states *why* it matched. A screening answer that cannot be
explained is worse than no answer, because someone may act on it.

**Live:** `https://cf-exclusion-check.cf-exclusion-check.workers.dev`
**Network:** Base mainnet (`eip155:8453`) via the Coinbase CDP facilitator.
Payments are real. Settlement is after-handler, so a request that cannot be
served is not charged.

---

## What it screens

| source | rows | what it is |
|---|---|---|
| `leie` | 83,975 | the LEIE active exclusions list |
| `leie_rein` | 1,061 | 20 months of LEIE reinstatement supplements |
| `sam` | 162,547 | the SAM.gov government-wide exclusions list |
| **total** | **247,583** | |

SAM.gov is government-wide rather than healthcare-specific, and it is **not**
mostly businesses: 79.1% of its records are individuals, 15.2% are "Special
Entity Designation", 4.9% firms and 0.8% vessels. The largest excluding agencies
are HHS (69,978), OFAC (41,712) and OPM (40,595).

The reinstatement supplements matter. `UPDATED.csv` holds **only currently
excluded** subjects, so a reinstated person simply disappears from it and a bare
"no match" hides their history. With the supplements loaded, the same query
answers the more useful thing:

> matched — excluded 2020-01-20, reinstated 2025-01-22, **not currently excluded**

### What it does *not* screen

- state Medicaid exclusion lists
- licensure board actions

A match here is a **name match, not an identity determination** (unless it was
made on an identifier), and a non-match is not a clearance. Confirm against the
official record at <https://exclusions.oig.hhs.gov> (LEIE) or
<https://sam.gov/search> (SAM) before acting against a person or business.

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
| `npi` | 10 digits. A strong identifier. |
| `uei` | SAM Unique Entity Identifier, exactly 12 alphanumeric chars. Strong. |
| `cage` | CAGE code, exactly 5 alphanumeric chars. Strong, but on only 0.3% of SAM rows. |
| `dob` | `YYYYMMDD`. |
| `state` | Two letters. **Corroborates only** — never creates or suppresses a match. |

### Verdicts

| verdict | meaning |
|---|---|
| `excluded` | matched on an **identifying** basis and the record carries no reinstatement date |
| `possible_match` | matched only on surname + first initial. A lead, not a finding. |
| `reinstated_only` | matched, but every match has been reinstated |
| `no_match` | nothing matched |

`excluded` requires an *identifying* basis — an NPI, UEI or CAGE, a full
personal name, or a business name. A surname plus a first initial never produces it, **even when a
supplied state agrees**. Sharing a state with millions of people is
corroboration, not identification, and "excluded" is a verdict someone can lose
a job over.

Each match also reports `basis`: `npi`, `uei`, `cage`, `business_name`,
`full_name` or `surname_initial`.

### Is the exclusion still in force?

The two sources say "no longer excluded" differently, so neither answer is
derived from the other. LEIE carries a **reinstatement date** — present means
reinstated. SAM carries a **record status** and a **termination date**, the date
the exclusion is scheduled to end; it is usually absent (indefinite) or far in
the future, with year 2227 used as an indefinite placeholder. Of 168,452 SAM
records only 12 have a termination date in the past. Anything not positively
known to have ended is treated as still in force.

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
| LEIE bulk generation (83,975 rows) | `scripts/build-seed.mjs` + `wrangler d1 execute` |
| SAM bulk generation (162,547 rows) | `scripts/build-sam-seed.mjs` + `wrangler d1 execute` |
| monthly LEIE supplements (41–200 rows) | Worker cron |
| freshness of the bulk generation | Worker cron, `HEAD` only |

SAM has the same problem for a different reason: its Exclusions API caps `size`
at **10 records per page**, so 168,452 records would need ~16,846 requests
against a published limit of 10–1,000 requests per day. Paging is not slow, it is
impossible. The asynchronous extract returns the whole set in one download.

Supplements add new exclusions and record reinstatements. They do **not** catch
a record removed for any other reason — only a full reconcile does, and that
needs a reseed. So `/v1/health` reports `freshness.reseed_due` from a daily HEAD
probe rather than implying the data is current.

`docs/SOURCES.md` records every measurement behind these claims.

### Free-tier caveats

This runs on the Cloudflare free plan deliberately. Four limits shape it, and
two of them bite in ways the documentation does not prepare you for.

| limit | documented | what actually happened |
|---|---|---|
| D1 rows read | 5,000,000 / day | exceeded, then refused **inconsistently across query shapes** — a one-row probe can succeed while a larger query fails |
| D1 rows written | 100,000 / day | reached **1,698,310** before writes were refused |
| D1 database size | 500 MB | currently 110 MB at 247,583 rows |
| Worker CPU | 10 ms / invocation, cron included | hard; it is why bulk loading cannot run in-Worker |

**Bulk reloads are local-only, by design.** Every bulk generation is built on a
workstation with `scripts/build-*-seed.mjs` and applied with
`wrangler d1 execute`. Nothing reloads a full source from inside the Worker. The
cron only merges the small monthly LEIE supplements and runs a `HEAD` freshness
probe.

**Do not design against either number as if it were hard.** The documented
ceilings are not enforced strictly, and the observed slack is not a guarantee.
Two consequences seen in practice:

- A single full-table scan per request (one missing index) burned the daily read
  budget after roughly 59 paid calls, and surfaced as a `500` on a request whose
  payment had already been authorised — the caller pays and gets nothing. Hence
  the index discipline in `migrations/0004` and `0005`, and the query-plan
  assertions in `test/sql.test.ts`.
- When the write budget ran out, request-log inserts began failing. They had been
  wrapped in an empty `catch`, so settled payments silently went unlogged. The
  write is now awaited and failures are surfaced.

A bulk reload spends roughly **5.15 row writes per row** (one table write plus
~4.15 partial-index entries), so reloading SAM costs ~837,000 writes. Schedule
reloads accordingly, and expect the audit log to degrade while one is running.

**Never count rows at request time.** The sharpest lesson here: a single
`SELECT source, COUNT(*) FROM exclusions GROUP BY source` in the provenance
lookup ran on every screening request and every health check. Its plan is
`SCAN ... USING COVERING INDEX` — a pass over all 247,583 rows — so each call
spent ~247k of the daily read budget and capped the service near **20 requests a
day**. Row counts now come from `source_load_progress`, which already tracks
them. `test/sql.test.ts` asserts that neither the provenance lookup nor
`/v1/health` references the `exclusions` table, because this is an easy mistake
to reintroduce and its cost is invisible until the budget is gone.

## Local development

```bash
npm install
npm test                       # 71 tests, 17 of them executing real SQL
npm run typecheck

npm run migrate:local
npm run seed:build             # downloads UPDATED.csv, emits seed/ parts
node scripts/build-rein-seed.mjs
node scripts/build-sam-seed.mjs   # needs .secrets/sam-exclusions.raw
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

See **[docs/MAINNET.md](docs/MAINNET.md)** for the verified procedure. In short,
it is not a two-line change: the configured facilitator
(`https://x402.org/facilitator`) is **testnet-only** — its `/supported` endpoint
does not list `eip155:8453` — so mainnet also requires Coinbase CDP facilitator
credentials. Flipping `NETWORK` alone makes every paid request fail.

The Base mainnet USDC contract is already mapped and verified on-chain
(`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, chainId 8453, 6 decimals).

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

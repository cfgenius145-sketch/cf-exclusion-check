# Listing copy

Copy for the x402 Bazaar / directory listings. Every factual claim here is
verified in `docs/SOURCES.md`; nothing is rounded up for marketing.

---

## Name

CF Exclusion Check

## One line

Screen any name against the federal healthcare exclusion list for $0.01, and get
told why it matched.

## Short description (≤ 280 chars)

Pay-per-call screening against the HHS-OIG List of Excluded Individuals and
Entities. 85,036 records including reinstatement history. Every result states
its confidence and the exact basis it matched on. $0.01 per check, $0.25 for a
full report. MCP tool included.

## Long description

CF Exclusion Check answers one question well: **is this person or business
excluded from federal healthcare programs?**

It screens the HHS-OIG LEIE — 83,975 active exclusion records — plus 1,061
reinstatement records covering 20 months of supplements. That second source is
what makes the answer useful. The official active list contains only currently
excluded subjects, so anyone reinstated silently vanishes from it, and a plain
"no match" hides their history. This service tells you instead: *matched,
excluded 2020-01-20, reinstated 2025-01-22, not currently excluded.*

Every result is explainable. You get a verdict, a confidence level, and the
basis the match was built on — an NPI, a full name, a business name, or merely a
surname plus a first initial. The verdict `excluded` is only ever returned on an
identifying basis; a surname-and-initial hit is reported as `possible_match`
even when a supplied state agrees with the record, because sharing a state with
millions of people is corroboration, not identification.

Results also carry two counts, not one: matching rows *and* distinct subjects.
The source list records some subjects several times, so a single count would
read as several separate exclusions when it is one person recorded three times.

Free endpoints let you check the service and its data freshness before you spend
anything: `/v1/health` reports row counts, load dates and whether the loaded
generation has fallen behind the upstream file.

### Pricing

| endpoint | price |
|---|---|
| `/v1/check` | $0.01 |
| `/v1/report` — every match, full source fields | $0.25 |
| `/v1/health`, `/.well-known/x402` | free |
| MCP `exclusion_check` | $0.01 per call |
| MCP `exclusion_sources` | free |

Paid in USDC over x402. Currently on **Base Sepolia testnet**.

### For agents

An MCP endpoint at `/mcp` exposes `exclusion_check` as a tool. `initialize` and
`tools/list` are free, so an agent can discover the tool and its price before
committing to a paid call.

## Tags

`healthcare` `compliance` `screening` `exclusions` `oig` `leie` `mcp`
`background-check` `credentialing`

## Who it is for

- credentialing and provider-enrolment teams
- healthcare staffing and locum agencies
- compliance vendors building screening into their own products
- agents doing due diligence on healthcare counterparties

## What it is not

State this plainly wherever the service is listed:

- It screens the **HHS-OIG LEIE only** — not SAM.gov, not state Medicaid
  exclusion lists, not licensure board actions.
- A match is a **name match, not an identity determination**. A non-match is not
  a clearance.
- Results reflect the loaded data generation reported by `/v1/health`, not a
  live query against OIG.
- Anyone acting on a result should confirm it against the official record at
  <https://exclusions.oig.hhs.gov>.

## Example

Request:

```bash
curl "$BASE/v1/check?name=Smith,%20John&state=TX"
```

Response shape:

```json
{
  "verdict": "excluded",
  "confidence": "match",
  "match_count": 1,
  "subject_count": 1,
  "matches": [{
    "confidence": "match",
    "basis": "full_name",
    "matched_on": "last+first equals \"SMITH JOHN\" (read as last=\"SMITH\", first=\"JOHN\")",
    "record": {
      "source": "leie",
      "last_name": "SMITH", "first_name": "JOHN",
      "npi": null, "state": "TX",
      "exclusion_type": "1128a1",
      "exclusion_date": "20180501",
      "reinstatement_date": null,
      "currently_excluded": true
    }
  }],
  "sources": [{ "source": "leie", "rows": 83975, "loaded_at": "…", "reseed_due": false }],
  "disclaimer": "Name-based screening against the HHS-OIG LEIE generation identified under `sources`. …"
}
```

## Attribution

LEIE data is published by the HHS Office of Inspector General and is in the
public domain. This service is not affiliated with, endorsed by, or operated on
behalf of HHS-OIG.

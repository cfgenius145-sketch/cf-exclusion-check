# The CF Soft Envelope

One query grammar and one response shape, shared by every booth. Written
once so wiring in booth #4 through #30 costs nothing extra, and so a
cross-booth query becomes possible later without a rewrite.

**Status: approved at G1 (2026-09-12), revised per that review. This
version reflects the actual decisions made, not the original draft.**

---

## Part 0 — the one rule everything else follows

**v1 and v2 are two separate response bodies, not one merged object.**

A request without `?v=2` gets exactly what it gets today — same fields,
same names, same types, forever. A request with `?v=2` gets the envelope
shape described below, as a **complete replacement** response for that
request only. They are never mixed into one object. This is what makes
"additive only" actually true: there is no field-collision to resolve
between one booth's existing field and this spec's field of the same
name, because a v1 caller never sees the v2 body and a v2 caller never
sees the v1 body.

**Exception, decided at G1: a booth with no live callers ships v2 only.**
CF Enforcement Check has never been deployed — there is no v1 to protect.
It gets the envelope shape unconditionally, with no `?v=2` gate at all,
before its first deployment. This is the only such exception among the
three existing booths; any future booth built after this spec exists
should default to shipping v2-only from day one, the same way.

---

## Part 1 — the spec

### 1.1 Version opt-in

`?v=2` on the query string, for a booth that has existing v1 callers to
protect. Chosen over an `Accept` header for one reason: it works
identically on `GET` and `POST`, needs no header gymnastics from a `curl`
one-liner or a browser address bar, and does not interact with HTTP
caching the way `Vary: Accept` would.

A booth with no v1 to protect (§Part 0 exception) skips this entirely and
always returns the envelope shape.

MCP has no equivalent request-level query string — see §1.6.

### 1.2 Query grammar

Two kinds of caller-supplied fields: **subject fields** (identify who or
what is being asked about) and **qualifiers** (narrow or corroborate,
never identify alone). Every field name below means the same thing at
every booth that supports it — a booth need not support all of them, and
each booth's own docs state which subset it accepts (§2 has today's
answer per booth).

**Subject fields:**

| field | meaning |
|---|---|
| `name` | a **person's** name. `"Last, First"` or `"First Last"`. |
| `org` | a **business or organization** name. |
| `npi` | 10-digit National Provider Identifier. |
| `uei` | SAM.gov Unique Entity Identifier, 12 alphanumeric characters. |
| `cage` | CAGE code, 5 alphanumeric characters. |
| `cik` | SEC Central Index Key. |
| `ein` | Employer Identification Number. |
| `license` | a license/registration number. |
| `vin` | Vehicle Identification Number. |
| `address` | a street address. |
| `package` | a software package name (paired with the `ecosystem` qualifier). |

A booth whose one identifying concept is not in this table yet uses the
escape hatch rather than inventing a new top-level name:

```
?id_type=<name-not-yet-in-this-table>&id=<value>
```

This is deliberately the only extension point. Adding a ninth named
identifier type to the table above is a one-line spec change and a grep
across booths for anything that already used the escape hatch for that
concept; it is not a breaking change to anyone.

**Qualifiers:**

| field | meaning |
|---|---|
| `state` | two-letter US state code. **Deliberately not uniform in behavior across booths — see §1.2.1.** |
| `dob` | date of birth, `YYYYMMDD`. |
| `county` | county name or FIPS code. |
| `ecosystem` | `npm` \| `pypi` \| `wordpress`, paired with `package`. |

**Controls:**

| field | meaning |
|---|---|
| `limit` | maximum records returned. Optional; omitting it preserves today's existing hardcoded cap for that booth exactly. A supplied `limit` may only narrow, never raise, a booth's existing ceiling. |
| `as_of` | reserved for a future point-in-time/history product. Every booth accepts it today without erroring; none can honor it yet, so every booth that receives it adds a `limits[]` entry stating history is not available and the answer reflects the current data generation only. Echoed back in `query.as_of`. |

**Validation rule:** a field name outside what a booth declares support
for is a `400` naming the field (`unsupported_identifier`,
`field: "cik"`), never silently dropped — **except** where a booth's
existing, working Bazaar-indexing behavior depends on an unauthenticated
bare probe getting a `402` before any validation runs (package-check has
exactly this constraint — see §2.2). This spec never overrides an
existing booth's validation-vs-payment order.

#### 1.2.1 `state`: two meanings, kept both, decided at G1

`state` **corroborates** at some booths (raises confidence, never
identifies or excludes on its own) and **filters** at others (removes
non-matching records outright). Both are legitimately "a state qualifying
the query" — this spec does not force one behavior, and does not rename
either usage to disambiguate.

What it does require: **whenever a caller supplies `state`, the response's
`limits[]` must say, in plain words, which one just happened** — e.g.
`"state corroborates a match; it does not identify or exclude one"` versus
`"state filtered results to records with a matching court; N without one
were dropped"`. A caller reading only `limits[]` should never have to
guess which behavior a given booth just applied.

### 1.3 Response envelope (v2)

```jsonc
{
  "service": "<booth id>",      // "exclusion-check" | "package-check" | "enforcement-check" | ...
  "version": "2",
  "query": { /* every subject field and qualifier the caller could have
                sent for this booth, present and normalised, absent ones
                as null */ },
  "verdict": "<string, from THIS BOOTH'S OWN declared vocabulary>",
  "confidence": "strong" | "match" | "weak" | "none",
  "basis": "<what matched, e.g. npi | full_name | business_name | cik | package_name>", // or null
  "counts": { "records": 0, "subjects": 0 },
  "records": [ /* booth-specific; documented per booth */ ],
  "sources": [
    { "name": "...", "as_of": "...", "url": "...", /* + booth-specific extra fields, additive */ }
  ],
  "limits": [ "short, honest strings" ],
  "as_of": "<the EARLIEST as_of among sources consulted>"

  // A booth MAY add further top-level fields beyond this list — e.g.
  // `stats` for booth-specific aggregate figures that don't belong on any
  // one record (see §2.3). The reserved names above never change meaning;
  // anything else is fair game, additive, and documented per booth.
}
```

**Decided at G1 — `verdict` is booth-declared vocabulary, not a shared
enum.** The original draft proposed forcing every booth's verdict into a
shared `"found" | "clear" | "uncertain"` tri-state. That was wrong: it
either loses real information (collapsing exclusion-check's four states
into three) or forces an unnatural fit (package-check has no
match/no-match concept at all). The actual rule, going forward for this
booth and every one after it (including the notice and property booths
already planned):

> **What's identical across every booth is the SHAPE — there is always a
> `verdict`, always a `confidence`, always a `basis`, always
> `sources`/`limits`/`as_of`. What's NOT identical is the WORDS `verdict`
> is allowed to take — each booth declares its own fixed vocabulary, in
> its own `openapi.json` and docs.**

`confidence` stays the one genuinely shared vocabulary
(`strong`/`match`/`weak`/`none`) — it was already right in the original
draft and nothing here changes that. A booth whose domain has no graded
confidence (package-check: a name either exists in a registry or it
doesn't) still populates it honestly from that reduced set (`strong` or
`none`, never fabricating `match`/`weak` cases that can't occur) rather
than omitting the field.

Notes on the remaining fields:

- **`as_of`** (top level) is the data generation timestamp, not the
  request timestamp. Where a booth's v1 already has a `checked_at`
  (request time) distinct from a per-source `as_of` (data generation
  time), v2 keeps **both** — `as_of` at top level is generation time,
  `checked_at` continues to exist as a booth-specific additive field
  wherever it already did.
- **`sources[].name`/`as_of`/`url`** are the only fields this spec
  requires on a source entry; anything else (row counts, load
  completeness, staleness flags) is additive and booth-specific.
- **`stats`** (new, decided at G1): the named, official place for
  booth-specific aggregate figures that describe the *query* rather than
  any one record — enforcement-check's `last_90_days`/`last_12_months`
  activity counts are the motivating case (§2.3). Optional; absent when a
  booth has nothing of the kind to report.

### 1.4 Error shape

```json
{ "error": "<machine code>", "message": "<human, today's existing string, unchanged>", "field": "<only if applicable>" }
```

Applies to `400`/`429`/`503` responses only, and only under `?v=2` (or
unconditionally, for a v2-only booth). `402` is explicitly out of scope
for this whole spec — its body stays exactly what each booth already
returns, v1 or v2, unconditionally. Booth-specific extra fields on an
error body are additive, appended after the three required fields.

HTTP status codes already match across booths (400/402/429/503) — this
was true before this spec and stays true.

### 1.5 The shared module

`_shared/src/envelope.ts`:

- **Types**: `EnvelopeQuery`, `IdentifierType`, `Confidence`,
  `EnvelopeResponse<TVerdict extends string, TRecord>` (verdict is a
  generic type parameter, not a fixed union — each booth instantiates it
  with its own literal-string union), `EnvelopeSource`, `ErrorBody`.
- **`buildEnvelope(parts)`**: assembles the object above from named parts;
  computes `version: "2"` and the top-level `as_of` (earliest of
  `sources[].as_of`).
- **`assertEnvelope(obj, verdicts)`**: throws (or returns `{ok, errors}`)
  if a candidate response doesn't conform — required fields present,
  `verdict` in the booth's own supplied enum, `confidence` in the shared
  enum, `sources` non-empty with the three required fields. Every booth's
  test suite calls this on its own v2 output, passing its own verdict
  list.
- **Normalisers that are genuinely domain-general**: name normalisation
  (uppercase, strip punctuation, drop generational suffixes —
  exclusion-check's `normalizeName`/`normalizeBase`, not booth-specific
  logic) and identifier-shape validators for the full table in §1.2
  (`npi`/`uei`/`cage` exist today; `cik`/`ein`/`license`/`vin`/`address`/
  `package` are defined now even though only one or two booths need them
  yet).

**Distribution: vendored copy, not a package.** Each booth gets its own
checked-in copy of `envelope.ts` under its own `src/`, sourced from
`_shared/src/envelope.ts`. No private npm registry exists for this
account, and standing one up is out of scope for what's otherwise a
same-day retrofit. The cost is manual sync discipline; this document
states the canonical source location so that discipline has one obvious
place to start from.

### 1.6 MCP

Every paid tool's `structuredContent` gains the v2 envelope **nested under
a new `envelope` key, alongside the existing v1 fields untouched at the
top level** — not flattened into the same object. Flattening turned out
not to work: v1's `sources`, `matches`, and `match_count`/`subject_count`
already occupy the names the envelope spec uses for different shapes
(`sources[].name` vs. `sources[].source`, `records` vs. `matches`,
`counts.{records,subjects}` vs. two separate fields) — merging them would
either collide or silently shadow one shape with the other. Nesting avoids
every collision: `structuredContent.verdict`/`.confidence` keep meaning
exactly what they mean today, and `structuredContent.envelope` is the
complete, independently-valid v2 object (the same one `assertEnvelope`
checks) sitting next to them. This is my reading of "MCP tools return the
v2 envelope in their structured content" in light of the overriding rule
that existing fields must keep working. **Flagged at G1, not explicitly
confirmed or redirected — proceeding with this default since it's the
conservative, never-breaks-anything choice, revisiting per booth at each
G2 if you want it changed.**

A v2-only booth's MCP tool simply returns the envelope shape as its whole
`structuredContent`, same as its HTTP body — no additive concern, since
there's no v1 shape to preserve there either.

### 1.7 What is explicitly out of scope

Per the task: new booths, new datasets, price changes, the cross-booth
aggregate query itself (this spec is written so that stays possible later
— a client that knows the shared grammar and envelope shape could fan a
query out to every booth and merge `records[]`, but building that is not
part of this work), courtpls.com, the plugins.

---

## Part 2 — mapping table, booth by booth

### 2.1 CF Exclusion Check

| v1 field | → v2 |
|---|---|
| `query.{name,npi,dob,state,uei,cage}` | unchanged, already this grammar |
| `verdict` | **unchanged vocabulary**: `"excluded" \| "possible_match" \| "reinstated_only" \| "no_match"`, declared as this booth's own verdict enum. No collapse — the earlier draft's found/clear/uncertain mapping is withdrawn per G1. |
| `confidence` | unchanged, identical vocabulary already |
| (per-match `basis`, strongest shown) | top-level `basis` = the strongest match's basis (`overallBasis()`, already built for the batch endpoint) |
| `match_count` / `subject_count` | `counts.records` / `counts.subjects` |
| `matches[]` | `records[]`, same per-item shape (`confidence`, `basis`, `matched_on`, `record`) |
| `sources[].source` / `.loaded_at` | `sources[].name` / `.as_of`, plus new `.url` (the OIG/SAM.gov public-record URLs already named in the existing `DISCLAIMER` text); everything else on that entry carried over additively |
| `disclaimer` + `coverage.note` + the two static `limitations[]` strings in `discovery.ts` | merged into `limits[]` |
| — (new, per §1.2.1) | when `query.state` is supplied, `limits[]` gains: `"state corroborates a match; it does not identify or exclude one"` |
| `checked_at` | kept, additive, alongside the new top-level `as_of` |
| — | `service: "exclusion-check"`, `version: "2"` |

Batch (`/v1/batch`) maps the same way per item; `billed_items`/`tier`/
`price` stay exactly as-is, additive alongside the v2 shape (payment
bookkeeping, not part of the screening domain).

### 2.2 CF Package Check

**Decided at G1: do not stretch this into found/clear/uncertain.**
Package-check declares its own verdict vocabulary, taken directly from
its existing `status` values plus one addition for the not-found case:

```
"active" | "stale" | "abandoned" | "deprecated" | "closed" | "not_found"
```

| package-check today | → v2 |
|---|---|
| `status: "active"\|"stale"\|"abandoned"\|"deprecated"\|"closed"` | `verdict` = the same string, unchanged |
| `status: null` (i.e. `exists: false`) | `verdict: "not_found"` |
| (implicit — an exact registry hit is unambiguous, there is no fuzzy case) | `confidence: "strong"` whenever `exists: true`; `confidence: "none"` when `exists: false`. `"match"`/`"weak"` are never emitted by this booth — there is no partial-match case in this domain. |
| (implicit — package name is the only way anything is identified here) | `basis: "package_name"` whenever `exists: true`, else `null` |
| `score`, `months_since_update`, `last_release`, `signals[]`, `score_breakdown`, `registry`, `github`, `versions`, `support` (report only) | all into `records[0]` (or `records: []` when `exists: false`) — one record, one subject |
| `name` | maps to the shared `package` identifier; v1's `?name=` keeps working forever, v2 additionally accepts `?package=` |
| `sources[]` (already exists in `reportBody`) | reshaped to the required `name`/`as_of`/`url` plus whatever it already carries |
| `disclaimer` (fixed string) | folded into `limits[]` |
| `as_of` (registry-read time) / `checked_at` (request time) | kept exactly as today, both additive alongside the new top-level `as_of` |

**Operational constraint that must survive this retrofit untouched:**
package-check's `docs/SOURCES.md` documents a real incident — validating
the query *before* the paywall made a bare, unauthenticated
Bazaar-indexing probe get `400` instead of the required `402`, and the
booth silently failed to index until validation was moved to *after* the
paywall. The retrofit adds `?v=2` handling without touching that order.

### 2.3 CF Enforcement Check

**Decided at G1: ships v2-only, before its first deployment.** No live
callers, no Bazaar listing, no backward-compatibility obligation exists
yet. It gets the envelope shape unconditionally — no `?v=2` gate, no
legacy shape to preserve. `/v1/check` and `/v1/report` keep their URL
paths (consistent with every other booth's URL convention — the `v1` in
the path is the stable routing namespace, independent of the `version:
"2"` field inside the body every booth eventually exposes), but the body
they return is the envelope, always.

The code already independently converged on booth #1's vocabulary before
this spec existed — its own comments say "as in booth #1," "structure
copied from booths #1 and #2."

| enforcement-check today | → v2 (its only shape) |
|---|---|
| `verdict: "records_found"\|"no_records"` | own vocabulary, unchanged: `"records_found" \| "no_records"` |
| `confidence` | unchanged, identical vocabulary |
| `matched: {confidence, basis, ...}` per record | into `records[]`, same idea as exclusion-check |
| `matches` (number) / `leads` (number) | `counts.records` = `matches + leads`; `counts.subjects` = `subjects.length` |
| `company` | maps to the shared `org` — this domain has no individual-person concept. Since this booth ships v2-only, `company` simply becomes `org` in the query grammar (no legacy alias needed — there is no legacy caller to preserve `?company=` for). |
| `cik` | unchanged, already shared vocabulary |
| `agencies[]`, `has_criminal`/`has_criminal_note`, `by_month`, `by_case_type`, `criminal_flagged[]`, `latest_date`/`earliest_date`, `lead_subjects`, `lead_records` | into `records[]` entries or alongside them, booth-specific |
| **`counts: {last_90_days, last_12_months}`** | **decided at G1**: does NOT become the envelope's `counts` (that's now reserved for `{records, subjects}`, per this booth's own row above). Moves to a new top-level `stats: {last_90_days, last_12_months}` field — the officially-sanctioned extension point from §1.3 for exactly this situation. |
| `sources` (today only inside `/v1/health`) | added to the check/report body itself: `{name: "courtpulse", as_of: dataset.built_at, url: ...}` |
| — (new, per §1.2.1) | when `query.state` is supplied, `limits[]` gains: `"state filtered results to records with a matching court; N without one were dropped"` (using the dropped-count this booth already computes for `state_filter`) |

**In scope, decided at G1: `docs/SOURCES.md` and `openapi.json` for this
booth, written before or alongside the retrofit.** `SOURCES.md` at
minimum carries the shared lessons already learned the hard way at
booths #1/#2 — oversized route metadata breaking CDP payment verification,
never `COUNT(*)` a large table at request time, D1's 100-bound-parameter
and 5-term-compound-SELECT caps, and readiness probes that report healthy
while a real query fails — checked against what this booth's actual code
does today (confirming which lessons are already applied versus which are
still a latent risk), not assumed.

---

## Decisions made at G1 review (2026-09-12)

1. Package-check keeps its own verdict words (`active`/`stale`/
   `abandoned`/`deprecated`/`closed`/`not_found`) rather than being forced
   into a shared tri-state. This is now the general rule (§1.3), not a
   one-off exception, and applies to every future booth too.
2. `state`'s dual meaning (corroborate vs. filter) is kept as-is at both
   booths; each booth must say which one happened in `limits[]` whenever
   `state` was supplied (§1.2.1).
3. The `counts` collision at enforcement-check is resolved by the v1/v2
   split plus a new `stats` extension field for booth-specific aggregate
   figures (§1.3, §2.3).
4. Enforcement-check ships v2-only, before deployment — no v1 shape, no
   back-compat burden (§2.3).
5. `docs/SOURCES.md` and `openapi.json` for enforcement-check are in
   scope for this task (§2.3).

**Still open, proceeding with a stated default rather than blocking on
it:** MCP `structuredContent` as an additive superset (§1.6) — not
explicitly confirmed or redirected. Proceeding with the conservative
default; will flag again at each booth's G2 if you want it done
differently.

/**
 * CF Exclusion Check — pay-per-call HHS-OIG exclusion screening.
 *
 * /v1/health and /.well-known/x402 are always free. /v1/check and /v1/report
 * are charged via x402 when PAY_TO is configured, and stay open when it is not
 * — reported either way as `payment_configured` by /v1/health and the discovery
 * document, so the state is never left implicit. The MCP tool is added in a
 * later task.
 */
import { Hono } from "hono";
import type { Env } from "./env";
import { discoveryDocument } from "./discovery";
import { agentCard } from "./agent-card";
import { openApiDocument } from "./openapi";
import { landingPage } from "./landing";
import { validateQuery, type ExclusionRow, type Query } from "./match";
import {
  assembleResults, buildBatchQueries, MAX_BATCH_ITEMS, MIN_BATCH_ITEMS,
  parseBatchItems, runBatchQueries, tierFor, validateBatchItems,
} from "./batch";
import { buildExclusionEnvelope, buildLimits, toEnvelopeSources } from "./envelope-adapter";
import { writeLog } from "./log";
import { DISCLAIMER, coverageOf, screen, sourceInfo } from "./screen";
import { freshnessProbe, monthlySupplement } from "./loader";
import { screenState, stateSourceInfo, type StateMatch } from "./state_match";
import { stateImportTick } from "./state_import";
import { getPaymentMiddleware } from "./payment";
import { checkRateLimit } from "./ratelimit";
import { grantTrial, wantsTrial } from "./trial";
import { PAID_METHODS, PAID_TOOL, PAID_TOOL_BATCH, PAID_TOOLS, handleMcp } from "./mcp";

type Vars = { screenQuery?: string; billedPrice?: string | null };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * Extract the settled transaction reference from an x402 response header.
 *
 * Best-effort: a log line must never be the reason a paid request fails, so any
 * decode problem yields null rather than throwing.
 */
function txRefFrom(header: string | undefined): string | null {
  if (!header) return null;
  try {
    const json = JSON.parse(atob(header));
    const tx = json?.transaction ?? json?.txHash ?? json?.payment?.transaction;
    return typeof tx === "string" ? tx : null;
  } catch {
    return null;
  }
}

/** Log every request without adding latency to the response. */
app.use("*", async (c, next) => {
  const started = Date.now();
  await next();

  const path = new URL(c.req.url).pathname;
  // x402 v2 sends `payment-signature`; v1 sent `x-payment`. Both are accepted
  // by the middleware, so both count as a payment attempt here.
  const attempted = Boolean(
    c.req.header("payment-signature") ?? c.req.header("x-payment"),
  );
  // `paid` means money actually changed hands: a payment was presented AND the
  // request was served. A 402 or a rejected payment is an attempt, not a
  // payment, and recording it as paid would overstate revenue.
  const paid = attempted && c.res.status < 400;
  // /v1/batch (and /mcp calling its tool) set `billedPrice` themselves, since
  // the actual charge is tiered rather than one of the two fixed env prices.
  const price = paid
    ? (c.get("billedPrice") ?? (path === "/v1/report" ? c.env.PRICE_REPORT : c.env.PRICE_CHECK))
    : null;

  const q = c.get("screenQuery");
  await writeLog(c.env, {
    path,
    ip: c.req.header("cf-connecting-ip") ?? null,
    ua: c.req.header("user-agent") ?? null,
    query: q ?? null,
    paid,
    price,
    txRef: txRefFrom(c.res.headers.get("payment-response") ?? undefined),
    status: c.res.status,
    ms: Date.now() - started,
  });
});

/** True when the request presents an x402 payment header (v2 or v1). */
function hasPaymentHeader(c: { req: { header(n: string): string | undefined } }): boolean {
  return Boolean(c.req.header("payment-signature") ?? c.req.header("x-payment"));
}

/**
 * Rate limit.
 *
 * Applied to everything except /v1/health and the discovery document, which
 * stay unlimited: they are how a caller checks whether the service is alive and
 * what it costs, and throttling them would make an outage indistinguishable
 * from a limit.
 */
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  // /admin/* is already gated by ADMIN_TOKEN (checked in each handler);
  // rate-limiting it the same as anonymous public traffic adds no safety
  // and only gets in the way of legitimate ops use (confirmed the hard way
  // testing state-import-tick: 10/min made a multi-hundred-tick manual test
  // impossible, added 2026-09-15).
  if (path === "/v1/health" || path === "/openapi.json" || path.startsWith("/.well-known/")
      || path.startsWith("/admin/")) return next();

  // /v1/batch gets its own, lower paid bucket (RL_BATCH, 20/min) — it can fan
  // out to far more D1 queries per call than /v1/check's single query.
  // Unpaid attempts at any path still share the one RL_FREE bucket.
  const decision = await checkRateLimit(
    c.env, c.req.header("cf-connecting-ip") ?? null, hasPaymentHeader(c),
    path === "/v1/batch" ? { paidLimiterKey: "RL_BATCH", paidLimit: 20 } : undefined,
  );
  if (decision.allowed) return next();

  return c.json({
    error: "rate limit exceeded",
    bucket: decision.bucket,
    limit: `${decision.limit} requests per minute`,
    note: decision.bucket === "free"
      ? "Paid requests are limited at 60/min (20/min for /v1/batch). " +
        "/v1/health and /.well-known/x402 are never rate limited."
      : "Slow down and retry.",
  }, 429, { "retry-after": "60" });
});

/**
 * Can the data layer actually serve a screening right now?
 *
 * Checked BEFORE payment, because the alternative is charging for a request
 * that then fails — the caller pays and gets nothing. That is not hypothetical:
 * a bulk load exhausted D1's daily row-read budget and every screening query
 * began returning
 *   D1_ERROR: Your account has exceeded D1's free tier daily row read limit
 * while the paywall happily kept taking payments.
 *
 * The probe reads ONE row. `SELECT 1` is useless here — it succeeds at zero
 * rows read even while the quota is refusing real reads, verified directly. Any
 * readiness probe that does not touch a row is a probe that cannot fail.
 */
async function dataLayerReady(env: Env): Promise<boolean> {
  try {
    await env.DB.prepare("SELECT id FROM exclusions LIMIT 1").first();
    return true;
  } catch (e) {
    console.error("data layer unavailable", String(e));
    return false;
  }
}

/** 503 body for a request refused before any payment was taken. */
const unavailable = {
  error: "service temporarily unavailable",
  reason:
    "The exclusion data layer is not currently readable, so a screening " +
    "cannot be answered. No payment was requested or taken for this request.",
  retry: "See /v1/health. Quota-based outages clear at 00:00 UTC.",
};

/**
 * Payment gate.
 *
 * Applied only to the paid paths, and only when PAY_TO is configured. Mounted
 * as a wrapper rather than via app.use on a path so that the middleware can be
 * built from `env`, which is not available at module scope in Workers.
 *
 * Readiness is checked first, and a failure short-circuits to 503 WITHOUT
 * invoking the payment middleware, so an unservable request is never charged.
 */
app.use("/v1/check", async (c, next) => {
  if (!(await dataLayerReady(c.env))) return c.json(unavailable, 503);

  // Free trial. Only when unpaid, explicitly requested, and well-formed — see
  // trial.ts. Anything else (no opt-in, malformed query, quota exhausted, no
  // salt configured) falls straight through to the paywall below unchanged,
  // so a bare probe still gets exactly the 402 it always has.
  if (!hasPaymentHeader(c) && wantsTrial(c) && c.env.IP_HASH_SALT) {
    const q = await readQuery(c);
    const check = validateQuery(q);
    if (check.ok) {
      const ip = c.req.header("cf-connecting-ip") ?? null;
      const trial = await grantTrial(c.env, ip);
      if (trial.granted) {
        c.set("screenQuery",
          `${q.name ?? ""}|${q.npi ?? ""}|${q.dob ?? ""}|${q.state ?? ""}` +
          `|${q.uei ?? ""}|${q.cage ?? ""}`);
        c.header("X-Trial-Remaining", String(trial.remaining));
        return handleScreen(c, "brief");
      }
    }
  }

  const mw = getPaymentMiddleware(c.env);
  return mw ? mw(c, next) : next();
});
app.use("/v1/report", async (c, next) => {
  if (!(await dataLayerReady(c.env))) return c.json(unavailable, 503);
  const mw = getPaymentMiddleware(c.env);
  return mw ? mw(c, next) : next();
});

/** Read a query from a JSON body or from the query string. */
async function readQuery(c: any): Promise<Query> {
  if (c.req.method === "POST") {
    try {
      const body = await c.req.json();
      return {
        name: typeof body?.name === "string" ? body.name : undefined,
        npi: body?.npi != null ? String(body.npi) : undefined,
        dob: body?.dob != null ? String(body.dob) : undefined,
        state: typeof body?.state === "string" ? body.state : undefined,
        uei: body?.uei != null ? String(body.uei) : undefined,
        cage: body?.cage != null ? String(body.cage) : undefined,
      };
    } catch {
      return {};
    }
  }
  const u = new URL(c.req.url);
  const g = (k: string) => u.searchParams.get(k) ?? undefined;
  return {
    name: g("name"), npi: g("npi"), dob: g("dob"), state: g("state"),
    uei: g("uei"), cage: g("cage"),
  };
}

async function handleScreen(c: any, detail: "brief" | "full") {
  const q = await readQuery(c);

  const check = validateQuery(q);
  if (!check.ok) {
    return c.json({ error: check.error, query: q }, 400);
  }

  // Hashed for the request log; the raw name is never logged.
  c.set("screenQuery",
    `${q.name ?? ""}|${q.npi ?? ""}|${q.dob ?? ""}|${q.state ?? ""}` +
    `|${q.uei ?? ""}|${q.cage ?? ""}`);

  let result, sources;
  try {
    [result, sources] = await Promise.all([
      screen(c.env, q, detail),
      sourceInfo(c.env),
    ]);
  } catch (e) {
    // Returning a non-2xx matters for more than tidiness: the payment flow is
    // `authorization`, which settles only AFTER a successful handler, so
    // failing here means the caller is not charged.
    console.error("screen failed", String(e));
    return c.json(unavailable, 503);
  }

  const queryEcho = {
    name: q.name ?? null, npi: q.npi ?? null,
    dob: q.dob ?? null, state: q.state ?? null,
    uei: q.uei ?? null, cage: q.cage ?? null,
  };
  const coverage = coverageOf(sources);

  // v2: the envelope, per ENVELOPE.md — a COMPLETE alternate response body,
  // never merged with the v1 shape below it. v1 callers (no ?v=2) never see
  // this branch; nothing about it can break them.
  if (new URL(c.req.url).searchParams.get("v") === "2") {
    const envelope = buildExclusionEnvelope({
      query: queryEcho,
      verdict: result.verdict,
      confidence: result.confidence,
      matchCount: result.match_count,
      subjectCount: result.subject_count,
      matches: result.matches,
      sources,
      coverageComplete: coverage.complete,
      coverageNote: coverage.note,
      stateSupplied: Boolean(q.state),
    });

    // State Medicaid exclusion lists (added 2026-09-15) — v2 only, additive
    // top-level field, never merged into `records`. Federal and state
    // verdicts are NOT combined into one overall verdict: a state hit alone
    // is corroboration-shaped evidence from lists that carry no NPI/DOB.
    // Unlike LEIE, no state publishes an authoritative reinstatement date,
    // so a state match is never auto-cleared (updated 2026-09-18: this used
    // to say state carries no reinstatement signal at all -- CFAI's
    // state_delisting_signal now infers one from a record's url going
    // missing from a fresh daily fetch, surfaced below as
    // `possible_reinstatement` once it has persisted >=3 consecutive days.
    // It is inference, not a source-asserted fact, so it only ever softens
    // the wording -- the match is still returned, still counted, still
    // reported).
    let stateMatches: StateMatch[] = [];
    try {
      stateMatches = await screenState(c.env, q);
    } catch (e) {
      console.error("state screen failed", String(e));
      // A state-side failure must never take down the federal v2 response;
      // it degrades to "no state data returned" rather than a 503.
    }

    return c.json({
      ...envelope,
      // Additive, booth-specific top-level field (ENVELOPE.md §1.3 permits
      // this): whether `records` was capped below the true match count.
      truncated: result.truncated,
      state_matches: stateMatches.slice(0, 20).map((sm) => ({
        confidence: sm.matched.confidence,
        basis: sm.matched.basis,
        matched_on: sm.matched.matched_on,
        list_state: sm.list_state,
        source: sm.source,
        as_of: sm.as_of,
        refresh: sm.refresh,
        source_url: sm.source_url,
        name: sm.matched.row.bus_name ||
          [sm.matched.row.first_name, sm.matched.row.last_name].filter(Boolean).join(" "),
        excl_date: sm.matched.row.excl_date,
        // Present only once a record has been absent from >=3 consecutive
        // daily fetches (see state_match.ts's DELIST_THRESHOLD). This NEVER
        // clears the match — it is still returned above as a state hit —
        // it only adds a caveat that the record's current status on the
        // state's own list has not been re-confirmed.
        possible_reinstatement: sm.matched.row.possible_reinstatement
          ? {
              first_missing_at: sm.matched.row.possible_reinstatement.first_missing_at,
              times_missing: sm.matched.row.possible_reinstatement.times_missing,
              note:
                "This person is still being reported as a match. The record has not " +
                "appeared on the state's own current exclusion list since " +
                `${sm.matched.row.possible_reinstatement.first_missing_at} — possible ` +
                "reinstatement, not independently confirmed. Verify current status " +
                "directly with the state Medicaid agency before relying on this for " +
                "an enrollment decision.",
            }
          : null,
      })),
      state_match_count: stateMatches.length,
    });
  }

  return c.json({
    query: queryEcho,
    verdict: result.verdict,
    confidence: result.confidence,
    // Two counts, not one: match_count is matching source ROWS, subject_count
    // is the distinct people/businesses behind them. LEIE records some subjects
    // more than once, so the two differ and conflating them would overstate.
    match_count: result.match_count,
    subject_count: result.subject_count,
    truncated: result.truncated,
    matches: result.matches,
    sources,
    // Surfaced on every screening response, not just /v1/health: a caller
    // acting on a non-match needs to know whether the sources were complete
    // when the answer was produced.
    coverage,
    disclaimer: DISCLAIMER,
    checked_at: new Date().toISOString(),
  });
}

app.post("/v1/check", (c) => handleScreen(c, "brief"));
app.get("/v1/check", (c) => handleScreen(c, "brief"));
app.post("/v1/report", (c) => handleScreen(c, "full"));
app.get("/v1/report", (c) => handleScreen(c, "full"));

/**
 * Batch payment gate.
 *
 * Mirrors /v1/check's and /mcp's pattern: readiness is checked before any
 * payment attempt, and — specific to batch — the item count and per-item
 * shape are validated BEFORE the paywall too, so a malformed request is
 * rejected at 400 with no payment ever requested (rule: a malformed batch
 * costs the caller nothing). Only once at least one item is valid does this
 * hand off to the payment middleware, whose price for this route is resolved
 * dynamically from the same request body (see payment.ts's batchPrice()).
 */
app.use("/v1/batch", async (c, next) => {
  if (!(await dataLayerReady(c.env))) return c.json(unavailable, 503);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const items = parseBatchItems(body);
  if (!items || items.length < MIN_BATCH_ITEMS || items.length > MAX_BATCH_ITEMS) {
    return c.json({
      error: `items must be an array of ${MIN_BATCH_ITEMS}-${MAX_BATCH_ITEMS} entries`,
    }, 400);
  }

  const validated = validateBatchItems(items);
  if (validated.every((v) => !v.ok)) {
    return c.json({
      error: "every item failed validation",
      results: validated.map((v) => ({ ref: v.item.ref ?? null, error: v.error })),
    }, 400);
  }

  const mw = getPaymentMiddleware(c.env);
  return mw ? mw(c, next) : next();
});

app.post("/v1/batch", async (c) => {
  // Re-parsed rather than threaded through from the gate above: c.req.json()
  // is cached by Hono, so this costs no extra read, and it keeps this handler
  // independent of the gate the same way handleScreen() re-derives its own
  // query rather than trusting shared state — one less thing that can drift.
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  const items = parseBatchItems(body) ?? [];
  const validated = validateBatchItems(items);
  const tier = tierFor(items.length);

  // Logged as item count and outcome only — never the submitted names.
  c.set("screenQuery", `batch:${items.length}:${tier?.tier ?? "?"}`);
  c.set("billedPrice", tier?.price ?? null);

  const queries = buildBatchQueries(validated.filter((v) => v.ok).map((v) => v.item));
  let rows: ExclusionRow[];
  try {
    rows = await runBatchQueries(c.env.DB, queries);
  } catch (e) {
    // Same discipline as handleScreen: a non-2xx here means the authorization
    // payment flow never settles, so a query failure costs the caller nothing.
    console.error("batch screen failed", String(e));
    return c.json(unavailable, 503);
  }

  const results = assembleResults(validated, rows);

  // v2: a batch has many subjects, not one, so there is no single top-level
  // verdict/confidence/basis to report — those live per item instead.
  // service/sources/limits/as_of don't vary by item and are hoisted to the
  // outer object once rather than repeated per result (documented in
  // README.md's batch section). billed_items/tier/price are payment
  // bookkeeping, unrelated to the screening domain, and carried over as-is.
  if (new URL(c.req.url).searchParams.get("v") === "2") {
    let sources, coverage;
    try {
      sources = await sourceInfo(c.env);
      coverage = coverageOf(sources);
    } catch (e) {
      console.error("batch v2 sourceInfo failed", String(e));
      return c.json(unavailable, 503);
    }
    const stateSupplied = validated.some((v) => Boolean(v.item.state));
    const limits = buildLimits({
      coverageComplete: coverage.complete, coverageNote: coverage.note,
      stateSupplied, verdict: "no_match", // verdict param only drives the
      // reinstated_only note, which is per-item here, not batch-wide.
    });

    return c.json({
      service: "exclusion-check",
      version: "2",
      billed_items: items.length,
      tier: tier?.tier ?? null,
      price: tier?.price ?? null,
      sources: toEnvelopeSources(sources),
      limits,
      as_of: sources.map((s) => s.loaded_at).filter(Boolean).sort()[0] ?? new Date().toISOString(),
      results: results.map((r) => ({
        ref: r.ref,
        query: r.query,
        ...(r.error
          ? { error: r.error }
          : {
              verdict: r.verdict,
              confidence: r.confidence,
              basis: r.basis,
              counts: { records: r.match_count, subjects: r.subject_count },
              records: r.matches,
              truncated: r.truncated,
            }),
      })),
    });
  }

  return c.json({
    billed_items: items.length,
    tier: tier?.tier ?? null,
    price: tier?.price ?? null,
    as_of: new Date().toISOString(),
    results,
  });
});

app.get("/v1/health", async (c) => {
  // Health must answer even when the data layer cannot, otherwise the one
  // endpoint a caller uses to distinguish an outage from a bad query is the
  // endpoint that 500s during an outage.
  if (!(await dataLayerReady(c.env))) {
    return c.json({
      service: c.env.SERVICE_NAME,
      status: "degraded",
      reason: unavailable.reason,
      retry: unavailable.retry,
      payment_configured: Boolean(c.env.PAY_TO),
      network: c.env.NETWORK,
      prices: { "/v1/check": c.env.PRICE_CHECK, "/v1/report": c.env.PRICE_REPORT },
      now: new Date().toISOString(),
    }, 503);
  }

  let sources;
  try {
    sources = await sourceInfo(c.env);
  } catch (e) {
    // Degrade rather than 500. The readiness probe above reads a single row,
    // which D1 can allow while refusing a larger query, so health must also
    // survive its own query failing.
    console.error("health: sourceInfo failed", String(e));
    return c.json({
      service: c.env.SERVICE_NAME,
      status: "degraded",
      reason: unavailable.reason,
      retry: unavailable.retry,
      payment_configured: Boolean(c.env.PAY_TO),
      network: c.env.NETWORK,
      now: new Date().toISOString(),
    }, 503);
  }

  // Row totals are summed from the per-source bookkeeping, never counted in
  // `exclusions`. A COUNT(*) over the table reads all 247,583 rows and, running
  // on every health check, is what drained D1's daily read budget.
  const totalRows = sources.reduce((n, s) => n + s.rows, 0);
  const reseedDue = sources.some((s) => s.reseed_due);
  const coverage = coverageOf(sources);

  // State coverage (added 2026-09-18: this was already real and already
  // screened by v2 responses, but /v1/health never reported it, which read
  // as "federal only" by omission). Same cheap bookkeeping-table read as
  // `sources` above (16 rows) — degrades to an empty list rather than
  // failing the whole health check if it errors.
  let stateSources: Awaited<ReturnType<typeof stateSourceInfo>> = [];
  try {
    stateSources = await stateSourceInfo(c.env);
  } catch (e) {
    console.error("health: stateSourceInfo failed", String(e));
  }
  const stateRows = stateSources.reduce((n, s) => n + s.rows, 0);

  return c.json({
    service: c.env.SERVICE_NAME,
    status: totalRows > 0 ? "ok" : "no_data",
    rows: totalRows,
    sources,
    state_sources: stateSources,
    state_rows: stateRows,
    coverage,
    // Stated rather than implied. The free plan cannot re-download a 15.6MB
    // source list in-Worker, so freshness is asserted only as far as the
    // freshness probe can prove it.
    freshness: {
      reseed_due: reseedDue,
      note: reseedDue
        ? "Upstream LEIE is newer than the loaded generation. A bulk reseed is " +
          "required; the monthly supplement cron cannot substitute for it."
        : "Loaded generation matches the last upstream check, or no probe has " +
          "run yet (see sources[].upstream_last_modified).",
    },
    payment_configured: Boolean(c.env.PAY_TO),
    network: c.env.NETWORK,
    prices: { "/v1/check": c.env.PRICE_CHECK, "/v1/report": c.env.PRICE_REPORT },
    now: new Date().toISOString(),
  });
});

// Served at both paths so a client guessing either one finds it.
const discovery = (c: any) => {
  const u = new URL(c.req.url);
  return c.json(discoveryDocument(c.env, `${u.protocol}//${u.host}`));
};
app.get("/.well-known/x402", discovery);
app.get("/.well-known/x402.json", discovery);

// A2A Agent Card (added 2026-09-18) — see agent-card.ts for why it doesn't
// declare the a2a-x402 extension. Cache-Control per spec §8.6.1; ETag isn't
// set because the card's numbers change daily (state cron) and a stale ETag
// would be worse than none.
app.get("/.well-known/agent-card.json", async (c) => {
  const u = new URL(c.req.url);
  const card = await agentCard(c.env, `${u.protocol}//${u.host}`);
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(JSON.stringify(card), 200, { "content-type": "application/a2a+json" });
});

// x402scan treats OpenAPI as the canonical discovery format; see openapi.ts.
app.get("/openapi.json", (c) => {
  const u = new URL(c.req.url);
  return c.json(openApiDocument(c.env, `${u.protocol}//${u.host}`) as never);
});

/** Admin: run the cron work on demand. Guarded by ADMIN_TOKEN. */
app.post("/admin/reload", async (c) => {
  const expected = c.env.ADMIN_TOKEN;
  const got = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  // Refuse when unset rather than defaulting open: an admin route with no
  // configured token must not be world-writable.
  if (!expected || got !== expected) return c.json({ error: "unauthorized" }, 401);

  const supplements = await monthlySupplement(c.env);
  const freshness = await freshnessProbe(c.env);
  return c.json({ supplements, freshness, ran_at: new Date().toISOString() });
});

/** Manual trigger for one state-exclusions import tick — same function the
 * "* 7-11 * * *" cron calls. Added 2026-09-15 for testing the real per-tick
 * throughput before trusting the cron window's sizing, and kept afterward
 * as the same manual-trigger safety valve /admin/reload already is. */
app.post("/admin/state-import-tick", async (c) => {
  const expected = c.env.ADMIN_TOKEN;
  const got = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!expected || got !== expected) return c.json({ error: "unauthorized" }, 401);

  const t0 = Date.now();
  const result = await stateImportTick(c.env, { fetch: (u: RequestInfo, i?: RequestInit) => fetch(u, i), now: () => new Date() });
  return c.json({ ...result, ms: Date.now() - t0 });
});

/**
 * MCP payment gate.
 *
 * MCP clients post every method to the same path, so a path-based paywall would
 * either charge for `initialize`/`tools/list` (making the tool undiscoverable)
 * or charge for nothing. The JSON-RPC method is therefore read first, and the
 * payment middleware is applied only to `tools/call` for the paid tool. The
 * body is read via c.req.json(), which Hono caches, so the handler still sees it.
 */
app.use("/mcp", async (c, next) => {
  if (c.req.method !== "POST") return next();

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    return next(); // malformed JSON is the handler's problem to report
  }

  const method = typeof body.method === "string" ? body.method : "";
  const params = (body.params ?? {}) as Record<string, unknown>;
  const tool = typeof params.name === "string" ? params.name : "";

  if (!PAID_METHODS.has(method) || !PAID_TOOLS.has(tool)) return next();

  if (!(await dataLayerReady(c.env))) {
    return c.json({
      jsonrpc: "2.0", id: body.id ?? null,
      error: { code: -32000, message: unavailable.reason },
    }, 503);
  }

  if (tool === PAID_TOOL_BATCH) {
    // Same rule as POST /v1/batch: item-count and per-item validation happen
    // BEFORE payment, so a malformed batch tool call is refused with no
    // payment ever requested.
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const items = parseBatchItems(args);
    if (!items || items.length < MIN_BATCH_ITEMS || items.length > MAX_BATCH_ITEMS) {
      return c.json({
        jsonrpc: "2.0", id: body.id ?? null,
        result: { isError: true, content: [{ type: "text",
          text: `items must be an array of ${MIN_BATCH_ITEMS}-${MAX_BATCH_ITEMS} entries` }] },
      }, 200);
    }
    const validated = validateBatchItems(items);
    if (validated.every((v) => !v.ok)) {
      return c.json({
        jsonrpc: "2.0", id: body.id ?? null,
        result: { isError: true, content: [{ type: "text", text: "every item failed validation" }] },
      }, 200);
    }
    const tier = tierFor(items.length);
    // Logged as item count and outcome only — never the submitted names.
    c.set("screenQuery", `batch:${items.length}:${tier?.tier ?? "?"}`);
    c.set("billedPrice", tier?.price ?? null);
  }

  const mw = getPaymentMiddleware(c.env);
  return mw ? mw(c, next) : next();
});

app.post("/mcp", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null,
      error: { code: -32700, message: "parse error" } }, 400);
  }

  if (Array.isArray(body)) {
    return c.json({ jsonrpc: "2.0", id: null,
      error: { code: -32600, message: "batch requests are not supported" } }, 400);
  }

  const out = await handleMcp(c.env, body);
  // Notifications get 202 with no body, per JSON-RPC.
  if (!out) return c.body(null, 202);
  return c.json(out.payload as never, out.status as never);
});

/** GET /mcp advertises the endpoint without requiring a POST to discover it. */
app.get("/mcp", (c) => c.json({
  transport: "streamable-http",
  note: "POST JSON-RPC 2.0 to this path.",
  free_methods: ["initialize", "ping", "tools/list"],
  paid_methods: [
    `tools/call name=${PAID_TOOL} (${c.env.PRICE_CHECK} via x402)`,
    `tools/call name=${PAID_TOOL_BATCH} (tiered $0.30/$1.00/$3.00 via x402)`,
  ],
  free_tools: ["exclusion_sources"],
}));

// A browser navigating here gets the human landing page; anything that isn't
// asking for HTML (curl's default Accept: */*, or an explicit application/json)
// keeps getting the original small JSON index, so nothing that already
// depends on GET / returning JSON breaks.
app.get("/", (c) => {
  const accept = c.req.header("accept") ?? "";
  if (accept.includes("text/html")) {
    const u = new URL(c.req.url);
    return c.html(landingPage(c.env, `${u.protocol}//${u.host}`));
  }
  return c.json({
    service: c.env.SERVICE_NAME,
    discovery: "/.well-known/x402",
    health: "/v1/health",
    mcp: "/mcp",
    endpoints: ["/v1/check", "/v1/report", "/v1/health", "/mcp"],
  });
});

app.notFound((c) => c.json({ error: "not found", see: "/.well-known/x402" }, 404));

app.onError((err, c) => {
  console.error("unhandled", err);
  return c.json({ error: "internal error" }, 500);
});

export default {
  fetch: app.fetch,

  /**
   * Cron.
   *
   * "0 6 15 * *" — monthly supplement merge (new exclusions + reinstatements).
   * "0 7 * * *"  — daily HEAD freshness probe against the active list.
   *
   * There is deliberately no full-list refresh here; see src/loader.ts for why
   * it is not achievable within the free plan's limits.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === "* 7-11 * * *") {
      const result = await stateImportTick(env, { fetch: (u: RequestInfo, i?: RequestInit) => fetch(u, i), now: () => new Date() });
      console.log("state import tick", JSON.stringify(result));
      return;
    }
    if (event.cron === "0 6 15 * *") {
      const reports = await monthlySupplement(env);
      console.log("supplement run", JSON.stringify(reports));
    }
    const probe = await freshnessProbe(env);
    console.log("freshness probe", JSON.stringify(probe));
  },
};

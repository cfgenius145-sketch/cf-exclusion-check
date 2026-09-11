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
import { validateQuery, type Query } from "./match";
import { writeLog } from "./log";
import { DISCLAIMER, coverageOf, screen, sourceInfo } from "./screen";
import { freshnessProbe, monthlySupplement } from "./loader";
import { getPaymentMiddleware } from "./payment";
import { checkRateLimit } from "./ratelimit";
import { PAID_METHODS, PAID_TOOL, handleMcp } from "./mcp";

type Vars = { screenQuery?: string };
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
  const price = paid
    ? (path === "/v1/report" ? c.env.PRICE_REPORT : c.env.PRICE_CHECK)
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
  if (path === "/v1/health" || path.startsWith("/.well-known/")) return next();

  const decision = await checkRateLimit(
    c.env, c.req.header("cf-connecting-ip") ?? null, hasPaymentHeader(c),
  );
  if (decision.allowed) return next();

  return c.json({
    error: "rate limit exceeded",
    bucket: decision.bucket,
    limit: `${decision.limit} requests per minute`,
    note: decision.bucket === "free"
      ? "Paid requests are limited at 60/min. /v1/health and " +
        "/.well-known/x402 are never rate limited."
      : "Slow down and retry.",
  }, 429, { "retry-after": "60" });
});

/**
 * Payment gate.
 *
 * Applied only to the paid paths, and only when PAY_TO is configured. Mounted
 * as a wrapper rather than via app.use on a path so that the middleware can be
 * built from `env`, which is not available at module scope in Workers.
 */
app.use("/v1/check", async (c, next) => {
  const mw = getPaymentMiddleware(c.env);
  return mw ? mw(c, next) : next();
});
app.use("/v1/report", async (c, next) => {
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

  const [result, sources] = await Promise.all([
    screen(c.env, q, detail),
    sourceInfo(c.env),
  ]);

  return c.json({
    query: {
      name: q.name ?? null, npi: q.npi ?? null,
      dob: q.dob ?? null, state: q.state ?? null,
      uei: q.uei ?? null, cage: q.cage ?? null,
    },
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
    coverage: coverageOf(sources),
    disclaimer: DISCLAIMER,
    checked_at: new Date().toISOString(),
  });
}

app.post("/v1/check", (c) => handleScreen(c, "brief"));
app.get("/v1/check", (c) => handleScreen(c, "brief"));
app.post("/v1/report", (c) => handleScreen(c, "full"));
app.get("/v1/report", (c) => handleScreen(c, "full"));

app.get("/v1/health", async (c) => {
  const sources = await sourceInfo(c.env);
  const totals = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM exclusions) AS n_rows,
            (SELECT COUNT(*) FROM requests)   AS logged_requests`,
  ).first<{ n_rows: number; logged_requests: number }>();

  const reseedDue = sources.some((s) => s.reseed_due);
  const coverage = coverageOf(sources);

  return c.json({
    service: c.env.SERVICE_NAME,
    status: totals && totals.n_rows > 0 ? "ok" : "no_data",
    rows: totals?.n_rows ?? 0,
    logged_requests: totals?.logged_requests ?? 0,
    sources,
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

  if (!PAID_METHODS.has(method) || tool !== PAID_TOOL) return next();

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
  paid_methods: [`tools/call name=${PAID_TOOL} (${c.env.PRICE_CHECK} via x402)`],
  free_tools: ["exclusion_sources"],
}));

app.get("/", (c) => c.json({
  service: c.env.SERVICE_NAME,
  discovery: "/.well-known/x402",
  health: "/v1/health",
  mcp: "/mcp",
  endpoints: ["/v1/check", "/v1/report", "/v1/health", "/mcp"],
}));

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
    if (event.cron === "0 6 15 * *") {
      const reports = await monthlySupplement(env);
      console.log("supplement run", JSON.stringify(reports));
    }
    const probe = await freshnessProbe(env);
    console.log("freshness probe", JSON.stringify(probe));
  },
};

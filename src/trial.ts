/**
 * Free trial: 3 unauthenticated calls per IP per day on GET/POST /v1/check.
 *
 * This exists so a human or an evaluating developer can see a real result
 * before wiring up payment. It must never become a way to bulk-screen the
 * loaded data for free, so it is deliberately narrow:
 *
 *   - Only /v1/check (never /v1/report, never MCP).
 *   - Only when the caller explicitly opts in (a header or query param).
 *     A bare, unadorned request is completely unaffected by this file and
 *     gets the same 402 it always did — this matters because CDP's Bazaar
 *     validator and x402scan's registration probe both send exactly that
 *     bare request and require a 402, not a 200.
 *   - Only when the query is well-formed. A malformed trial request is not
 *     charged against the quota; it just falls through to the normal paywall.
 *   - Only when IP_HASH_SALT is configured. No salt means no way to key the
 *     counter without persisting a raw IP, so the trial fails closed to the
 *     ordinary payment gate rather than ever storing one.
 *   - Hard cap of 3 per (hashed IP, UTC day), enforced by a single atomic
 *     UPSERT — safe under concurrent requests from the same IP without a
 *     transaction, because the whole read-check-write happens in one
 *     SQLite statement.
 */
import { hmacHex } from "./log";
import type { Env } from "./env";

export interface TrialDecision {
  granted: boolean;
  remaining: number;
}

const DAILY_LIMIT = 3;

/** True when the caller explicitly asked for the free trial. */
export function wantsTrial(c: { req: { header(n: string): string | undefined; url: string } }): boolean {
  if (c.req.header("x-trial") === "1") return true;
  try {
    return new URL(c.req.url).searchParams.get("trial") === "1";
  } catch {
    return false;
  }
}

/**
 * Grant or refuse one trial call. Returns granted=false on any ambiguity —
 * no salt, no IP, or a D1 error — so a failure here always falls back to the
 * ordinary paywall rather than ever serving for free by accident.
 */
export async function grantTrial(env: Env, ip: string | null): Promise<TrialDecision> {
  const salt = env.IP_HASH_SALT;
  if (!salt || !ip) return { granted: false, remaining: 0 };

  const ipHash = await hmacHex(salt, ip);
  const day = new Date().toISOString().slice(0, 10); // UTC calendar day

  try {
    // The WHERE clause on DO UPDATE is what makes this atomic and safe under
    // concurrency: if the row is already at the limit, the update (and the
    // RETURNING row) simply do not happen — there is no read-then-write race
    // window for two simultaneous requests from the same IP to both squeeze
    // through as call #3.
    const row = await env.DB.prepare(
      `INSERT INTO trial_calls (ip_hash, day, count) VALUES (?, ?, 1)
       ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1
       WHERE trial_calls.count < ?
       RETURNING count`,
    ).bind(ipHash, day, DAILY_LIMIT).first<{ count: number }>();

    if (!row) return { granted: false, remaining: 0 };
    return { granted: true, remaining: DAILY_LIMIT - row.count };
  } catch (e) {
    console.error("trial grant failed", String(e));
    return { granted: false, remaining: 0 };
  }
}

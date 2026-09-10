/**
 * Rate limiting.
 *
 * Two buckets, as specified: 10/min for free callers, 60/min for paid ones.
 *
 * A caller counts as "paid" when the request carries an x402 payment header.
 * Presence is checked, not validity: validity is the payment middleware's job
 * and it runs after this, since rate limiting has to happen before any work.
 *
 * So a forged header does reach the 60/min bucket. That is the right trade. The
 * forged payment is still rejected downstream, so the attacker buys 60 rather
 * than 10 rejections per minute — bounded, served without touching D1, and
 * granting no data access. The alternative I first wrote, charging the free
 * bucket on every request as well, would have capped genuine paying callers at
 * 10/min and silently defeated the 60/min limit they are paying for.
 *
 * Keyed on a salted hash of the client IP, never the raw IP, matching the
 * request log. When no salt is configured the raw IP is used as the key: the
 * key never leaves the rate-limiter and is not persisted, and losing rate
 * limiting entirely would be the worse trade.
 */
import type { Env } from "./env";

export interface RateLimitDecision {
  allowed: boolean;
  bucket: "free" | "paid";
  limit: number;
}

/** Cloudflare's rate-limit binding surface. */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface RateLimitEnv {
  RL_FREE?: RateLimiter;
  RL_PAID?: RateLimiter;
}

async function keyFor(env: Env, ip: string): Promise<string> {
  const salt = env.IP_HASH_SALT;
  if (!salt) return ip;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(salt),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/**
 * Apply both buckets and return the decision.
 *
 * Returns allowed=true when the bindings are absent (local `wrangler dev`
 * without the unsafe bindings, or a preview), because failing closed there
 * would make the service untestable while adding no protection in production.
 */
export async function checkRateLimit(
  env: Env, ip: string | null, hasPaymentHeader: boolean,
): Promise<RateLimitDecision> {
  const e = env as unknown as RateLimitEnv;
  const paid = hasPaymentHeader;
  const bucket = paid ? "paid" : "free";
  const limit = paid ? 60 : 10;

  if (!e.RL_FREE && !e.RL_PAID) return { allowed: true, bucket, limit };

  // Anonymous callers with no IP share one key rather than bypassing limits.
  const key = await keyFor(env, ip ?? "no-ip");

  // Exactly one bucket is charged, so the two ceilings stay independent.
  const limiter = paid ? e.RL_PAID : e.RL_FREE;
  const result = limiter ? await limiter.limit({ key }) : { success: true };
  return { allowed: result.success, bucket, limit };
}

/**
 * Request logging.
 *
 * Every request is logged, as the brief requires, but never the raw client IP
 * and never the queried name. Both are personal data about someone who did not
 * ask to be in our logs — the caller, and the person being screened.
 *
 *   - IPs are HMAC'd with IP_HASH_SALT. Without the salt the hash is not
 *     written at all, because an unsalted sha256 of an IPv4 address is
 *     trivially reversible by brute force over the whole 2^32 space.
 *   - The query is hashed the same way, so repeat lookups can be counted and
 *     abuse spotted without the log becoming a list of who was screened.
 *
 * The write is AWAITED rather than deferred through waitUntil, and a failure is
 * reported to the console rather than swallowed.
 *
 * Both changes came out of settled payments going unrecorded. The first
 * explanation — that waitUntil was dropping the write once the payment path
 * ended the invocation — was wrong. The actual cause was D1 refusing the insert:
 *
 *   D1_ERROR: Your account has exceeded D1's free tier daily row write limit.
 *
 * The SAM.gov bulk load had spent 1,327,771 row writes against a documented
 * 100,000/day, so every subsequent insert failed. An empty catch block turned
 * that into silence, and the audit log simply had no row for requests that had
 * demonstrably been paid for. Awaiting the write does not fix a quota failure,
 * but it keeps the audit row on the same footing as the response, and the
 * console.error means the next such fault is visible in one tail rather than
 * needing to be inferred from missing rows.
 */
import type { Env } from "./env";

// Exported so trial.ts hashes IPs with the exact same scheme as the audit log.
export async function hmacHex(salt: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(salt),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export interface LogEntry {
  path: string;
  ip?: string | null;
  ua?: string | null;
  query?: string | null;
  paid?: boolean;
  price?: string | null;
  txRef?: string | null;
  status: number;
  ms: number;
}

export async function writeLog(env: Env, e: LogEntry): Promise<void> {
  const salt = env.IP_HASH_SALT;
  const ipHash = salt && e.ip ? await hmacHex(salt, e.ip) : null;
  const queryHash = salt && e.query ? await hmacHex(salt, e.query) : null;

  try {
    await env.DB.prepare(
      `INSERT INTO requests (ts, path, ip_hash, ua, query_hash, paid, price, tx_ref, status, ms)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      new Date().toISOString(), e.path, ipHash,
      (e.ua ?? "").slice(0, 200) || null, queryHash,
      e.paid ? 1 : 0, e.price ?? null, e.txRef ?? null, e.status, e.ms,
    ).run();
  } catch (e) {
    // A logging failure must never fail the caller's request, but it must not
    // be invisible either — an empty catch here is what hid the dropped writes.
    console.error("request log write failed", String(e));
  }
}

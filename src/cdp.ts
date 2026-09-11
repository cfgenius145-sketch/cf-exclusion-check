/**
 * Coinbase CDP facilitator authentication.
 *
 * Mainnet settlement runs through the CDP facilitator, which requires a signed
 * JWT per request. The credentials never appear in code — they arrive as the
 * Worker secrets CDP_API_KEY_ID and CDP_API_KEY_SECRET.
 *
 * The key is CDP's Ed25519 format: base64 of 64 bytes, being a 32-byte seed
 * followed by the 32-byte public key. WebCrypto will only import an Ed25519
 * private key as PKCS8, so the seed is wrapped in the fixed PKCS8 prefix below
 * rather than pulled in via a Node-only crypto API — this has to run inside a
 * Worker.
 *
 * The JWT shape CDP expects:
 *   header  { alg: "EdDSA", kid: <key id>, typ: "JWT", nonce: <random hex> }
 *   payload { sub: <key id>, iss: "cdp", aud: [<host>], nbf, exp,
 *             uris: ["<METHOD> <host><path>"] }
 *
 * `uris` is bound to one method and path, so a separate token is minted per
 * facilitator endpoint. That is also why `createAuthHeaders` must return headers
 * KEYED BY PATH — returning a flat `{ Authorization }` object throws inside
 * @x402/core rather than silently dropping auth.
 */

/** DER prefix for a PKCS8-wrapped Ed25519 private key (RFC 8410). */
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64url(bytes: Uint8Array | string): string {
  const bin = typeof bytes === "string"
    ? bytes
    : Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Import the CDP secret as an Ed25519 signing key.
 *
 * Accepts the 64-byte seed+public form CDP issues, and also a bare 32-byte
 * seed, since only the seed is used for signing.
 */
async function importSigningKey(secret: string): Promise<CryptoKey> {
  const raw = b64ToBytes(secret.trim());
  if (raw.length !== 64 && raw.length !== 32) {
    throw new Error(
      `CDP_API_KEY_SECRET decodes to ${raw.length} bytes; expected 64 ` +
      `(Ed25519 seed + public key) or 32 (seed only)`,
    );
  }
  const seed = raw.slice(0, 32);
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);

  return crypto.subtle.importKey(
    "pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"],
  );
}

/** Mint one CDP bearer token bound to a single method and path. */
export async function cdpJwt(
  keyId: string, secret: string, method: string, host: string, path: string,
): Promise<string> {
  const key = await importSigningKey(secret);
  const now = Math.floor(Date.now() / 1000);

  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const header = { alg: "EdDSA", kid: keyId, typ: "JWT", nonce };
  const payload = {
    sub: keyId,
    iss: "cdp",
    aud: [host],
    nbf: now,
    // Deliberately short-lived. A token is minted per request, so there is no
    // reason to leave a long-valid bearer credential in flight.
    exp: now + 120,
    uris: [`${method} ${host}${path}`],
  };

  const signingInput =
    `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    "Ed25519", key, new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

/**
 * Build the path-keyed auth-header factory for HTTPFacilitatorClient.
 *
 * Returns null when credentials are absent, so a deployment without CDP keys
 * keeps working against an unauthenticated facilitator instead of failing in a
 * way that looks like a payment bug.
 */
export function cdpAuthHeaders(
  facilitatorUrl: string, keyId?: string, secret?: string,
): (() => Promise<{
  verify?: Record<string, string>;
  settle?: Record<string, string>;
  supported?: Record<string, string>;
  bazaar?: Record<string, string>;
}>) | undefined {
  if (!keyId || !secret) return undefined;

  const url = new URL(facilitatorUrl);
  const host = url.host;
  const base = url.pathname.replace(/\/$/, "");

  return async () => {
    const token = async (method: string, suffix: string) => ({
      Authorization: `Bearer ${await cdpJwt(keyId, secret, method, host, `${base}${suffix}`)}`,
    });
    // One token per endpoint, because the `uris` claim pins each to its own
    // method and path.
    const [verify, settle, supported, bazaar] = await Promise.all([
      token("POST", "/verify"),
      token("POST", "/settle"),
      token("GET", "/supported"),
      token("GET", "/discovery/resources"),
    ]);
    return { verify, settle, supported, bazaar };
  };
}

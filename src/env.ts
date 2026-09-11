/** Worker bindings and configuration. */
export interface Env {
  DB: D1Database;

  // vars (wrangler.jsonc)
  NETWORK: string;            // CAIP-2, e.g. eip155:84532 (Base Sepolia)
  FACILITATOR_URL: string;
  LEIE_CSV_URL: string;
  PRICE_CHECK: string;        // "$0.01"
  PRICE_REPORT: string;       // "$0.25"
  SERVICE_NAME: string;

  // secrets (wrangler secret put)
  PAY_TO?: string;            // receiving address; unset => payment disabled
  ADMIN_TOKEN?: string;       // guards POST /admin/*
  IP_HASH_SALT?: string;      // salt for request-log IP hashing
  SAM_API_KEY?: string;       // optional SAM.gov exclusions source
  CDP_API_KEY_ID?: string;    // Coinbase CDP facilitator (mainnet settlement)
  CDP_API_KEY_SECRET?: string;
}

/** Monthly LEIE supplements, e.g. .../downloadables/2026/2608rein.csv */
export function supplementUrl(kind: "rein" | "excl", year: number, month: number): string {
  const yy = String(year % 100).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  return `https://oig.hhs.gov/exclusions/downloadables/${year}/${yy}${mm}${kind}.csv`;
}

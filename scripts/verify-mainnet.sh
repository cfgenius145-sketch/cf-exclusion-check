#!/usr/bin/env bash
#
# End-to-end mainnet verification: one real paid call, on-chain receipt check,
# audit-row check, Bazaar lookup.
#
# Safe to run at any time. It refuses to spend money unless the service is
# demonstrably serving, so a run during a D1 quota outage costs nothing and
# simply reports "not ready".
#
# Why it insists on SUSTAINED health: under D1 quota pressure the service
# answers intermittently. Every cheap readiness proxy tried during development
# reported ready while a screening still failed —
#   - `SELECT 1`                    succeeds at 0 rows read
#   - `SELECT id ... LIMIT 1`       succeeds while a larger query fails
#   - a single `/v1/health` 200     was followed immediately by a 503
# so the gate is N consecutive full health checks, and it re-checks immediately
# before paying.
#
#   ./scripts/verify-mainnet.sh                # one attempt, exits 2 if not ready
#   ./scripts/verify-mainnet.sh --wait         # poll until ready, then verify
#   ./scripts/verify-mainnet.sh --bazaar-only  # Bazaar lookup only; never pays
#
#   BASE_URL=https://cf-package-check.cf-exclusion-check.workers.dev \
#     ./scripts/verify-mainnet.sh --bazaar-only   # same lookup for booth #2
#
set -uo pipefail

BASE="${BASE_URL:-https://cf-exclusion-check.cf-exclusion-check.workers.dev}"
PAYTO="0xCa28eb92657F8a81aFb5493b3a04A740B204d816"
PAYER_KEYFILE=".secrets/mainnet-payer.json"
USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
NEEDED_OK=4
WAIT=0
BAZAAR_ONLY=0
[ "${1:-}" = "--wait" ] && WAIT=1
[ "${1:-}" = "--bazaar-only" ] && BAZAAR_ONLY=1

bal () {
  node -e "
const { createPublicClient, http, formatUnits } = require('viem');
const abi=[{name:'balanceOf',type:'function',stateMutability:'view',
  inputs:[{name:'a',type:'address'}],outputs:[{type:'uint256'}]}];
(async()=>{const c=createPublicClient({transport:http('https://mainnet.base.org')});
console.log(formatUnits(await c.readContract({address:'$USDC',abi,
  functionName:'balanceOf',args:['$1']}),6));})();" 2>/dev/null
}

healthy () {
  local body code
  body=$(curl -s -m 20 -w '\n%{http_code}' "$BASE/v1/health")
  code=$(printf '%s' "$body" | tail -1)
  [ "$code" = "200" ] || return 1
  printf '%s' "$body" | sed '$d' | python3 -c "
import sys,json
d=json.load(sys.stdin)
raise SystemExit(0 if d.get('status')=='ok' and d.get('rows',0)>0 else 1)" 2>/dev/null
}

# Bazaar lookup. Two bugs lived here:
#   1. Lowercasing. ${VAR,,} is bash 4+ and macOS ships bash 3.2, where it is a
#      "bad substitution". The 2>/dev/null that used to be here swallowed that
#      error and left $hit empty, so the check silently reported nothing instead
#      of failing loudly. Lowercasing now happens in Python, with the values
#      passed as arguments rather than interpolated into code.
#   2. Paging. It fetched one page (?limit=100) of a catalog that held 14,280
#      resources on 2026-09-11, so even a listed service would almost never be
#      on it and the answer was "no" regardless. The whole catalog is now paged.
# YES requires a catalog resource URL on THIS host. PAYTO is shared with
# booth #2, so a match on the payout address alone proves nothing about this
# booth: those resources are reported separately, never as YES. (The first
# version of this fix counted them, and reported booth #2 listed on the
# strength of booth #1's entry.)
bazaar_check () {
  local attempts="$1" attempt hit
  for attempt in $(seq 1 "$attempts"); do
    hit=$(python3 - "$PAYTO" "${BASE#https://}" <<'PYEOF'
import json, sys, urllib.request
payto, host = sys.argv[1].lower(), sys.argv[2].lower().rstrip("/")
url = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources"
offset, total, own, same_payto = 0, None, [], []
try:
    while total is None or offset < total:
        req = urllib.request.Request(f"{url}?limit=1000&offset={offset}",
                                     headers={"user-agent": "cf-verify-mainnet/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            page = json.load(r)
        items = page.get("items", [])
        total = page.get("pagination", {}).get("total", 0)
        for it in items:
            resource = it.get("resource") or ""
            if f"//{host}/" in resource.lower() or resource.lower().endswith(f"//{host}"):
                own.append(resource)
            elif payto in json.dumps(it).lower():
                same_payto.append(resource or "?")
        if not items:
            break
        offset += len(items)
except Exception as e:
    print(f"ERROR ({type(e).__name__}: {e})")
    raise SystemExit(0)
line = ("YES" if own else "no") + f" (scanned {offset} of {total})"
if own:
    line += ": " + ", ".join(own[:10])
if same_payto:
    line += " | same payTo, other host: " + ", ".join(same_payto[:5])
print(line)
PYEOF
)
    echo "  attempt $attempt: listed=$hit"
    [ "${hit%% *}" = "YES" ] && return 0
    [ "$attempt" -lt "$attempts" ] && sleep 120
  done
  return 1
}

echo "=== mainnet verification $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
echo "  target: $BASE"

if [ "$BAZAAR_ONLY" = "1" ]; then
  echo
  echo "--- Bazaar only (no health gate, no payment) ---"
  bazaar_check 1
  exit $?
fi

streak=0
attempts=$([ "$WAIT" = "1" ] && echo 400 || echo "$NEEDED_OK")
for i in $(seq 1 "$attempts"); do
  if healthy; then
    streak=$((streak+1))
    echo "  healthy ($streak/$NEEDED_OK)"
    [ "$streak" -ge "$NEEDED_OK" ] && break
    sleep 20
  else
    [ "$streak" -gt 0 ] && echo "  streak broken — service went unhealthy again"
    streak=0
    [ "$WAIT" = "1" ] || break
    [ $((i % 12)) -eq 1 ] && echo "  [$(date -u '+%H:%M:%SZ')] not ready, waiting"
    sleep 300
  fi
done

if [ "$streak" -lt "$NEEDED_OK" ]; then
  echo
  echo "  NOT READY — service is not serving screenings (D1 read quota resets 00:00 UTC)."
  echo "  No payment attempted. Re-run later, or use --wait."
  exit 2
fi

echo
echo "--- health ---"
curl -s "$BASE/v1/health" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('  status',d['status'],'| rows',f\"{d['rows']:,}\",'| network',d['network'])
for s in d['sources']: print(f\"   {s['source']:10s} {s['rows']:>8,} complete={s['complete']}\")"

echo
echo "--- advertised price ---"
curl -s "$BASE/.well-known/x402" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for a in d['accepts']:
    print(f\"  {a['resource'].rsplit('/',1)[-1]:8s} {a['amount']:>8s} atomic = \${int(a['amount'])/1e6:.2f}  payTo={a['payTo']}\")"

PAYER=$(python3 -c "import json;print(json.load(open('$PAYER_KEYFILE'))['address'])" 2>/dev/null)
[ -z "$PAYER" ] && { echo "  no payer key at $PAYER_KEYFILE"; exit 1; }

BEFORE_PAYER=$(bal "$PAYER"); BEFORE_PAYTO=$(bal "$PAYTO")
echo
echo "--- balances before ---"
echo "  payer  $PAYER  $BEFORE_PAYER USDC"
echo "  payTo  $PAYTO  $BEFORE_PAYTO USDC"

# Re-check immediately before spending: the streak above proves sustained
# health, not health *now*.
if ! healthy; then
  echo
  echo "  ABORTED — health degraded between the readiness streak and the payment."
  echo "  No payment attempted."
  exit 2
fi

echo
echo "--- real paid call ---"
node scripts/x402-client.mjs /v1/check "USA Remediation Services, Inc"
RC=$?

echo
echo "--- balances after ---"
sleep 25
AFTER_PAYER=$(bal "$PAYER"); AFTER_PAYTO=$(bal "$PAYTO")
echo "  payer  $AFTER_PAYER USDC (was $BEFORE_PAYER)"
echo "  payTo  $AFTER_PAYTO USDC (was $BEFORE_PAYTO)"
python3 -c "
b,a=float('$BEFORE_PAYTO'),float('$AFTER_PAYTO')
d=round(a-b,6)
print(f'  receipt at payTo: {d:+.6f} USDC', '<-- CONFIRMED' if d>0 else '<-- NOTHING RECEIVED')"

echo
echo "--- audit row ---"
npx wrangler d1 execute cf_exclusions --remote -y \
  --command="SELECT ts,path,status,paid,price,tx_ref FROM requests WHERE paid=1 ORDER BY id DESC LIMIT 3" \
  --json 2>/dev/null | python3 -c "
import sys,json
t=sys.stdin.read()
try:
    rs=json.loads(t[t.index('['):])[0]['results']
    print('  paid rows:', len(rs))
    for r in rs:
        print(f\"   {r['ts'][11:19]} {r['path']} status={r['status']} price={r['price']} tx={r['tx_ref']}\")
except Exception:
    print('  (audit log unreadable — likely D1 quota)')"

echo
echo "--- Bazaar (indexes on first paid hit; may lag) ---"
bazaar_check 5

echo "=== done $(date -u '+%H:%M:%SZ') (client rc=$RC) ==="

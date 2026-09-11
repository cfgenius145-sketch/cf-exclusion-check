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
#   ./scripts/verify-mainnet.sh            # one attempt, exits 2 if not ready
#   ./scripts/verify-mainnet.sh --wait     # poll until ready, then verify
#
set -uo pipefail

BASE="${BASE_URL:-https://cf-exclusion-check.cf-exclusion-check.workers.dev}"
PAYTO="0xCa28eb92657F8a81aFb5493b3a04A740B204d816"
PAYER_KEYFILE=".secrets/mainnet-payer.json"
USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
NEEDED_OK=4
WAIT=0
[ "${1:-}" = "--wait" ] && WAIT=1

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

echo "=== mainnet verification $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
echo "  target: $BASE"

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
for attempt in 1 2 3 4 5; do
  curl -s -m 25 "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100" -o /tmp/bz_check.json
  hit=$(python3 -c "
import json
b=json.dumps(json.load(open('/tmp/bz_check.json'))).lower()
print('YES' if 'cf-exclusion-check' in b or '${PAYTO,,}' in b else 'no')" 2>/dev/null)
  echo "  attempt $attempt: listed=$hit"
  [ "$hit" = "YES" ] && break
  [ "$attempt" -lt 5 ] && sleep 120
done

echo "=== done $(date -u '+%H:%M:%SZ') (client rc=$RC) ==="

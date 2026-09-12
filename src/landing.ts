/**
 * Human-facing landing page at GET /. Plain HTML, no JavaScript, no
 * render-blocking requests — everything is inlined.
 *
 * Prices and network come from env, the same values the payment middleware
 * and /.well-known/x402 use, so this page cannot advertise a stale price the
 * way an external directory's cached copy can (see the Glama incident this
 * page exists partly to hedge against). Row counts are deliberately NOT
 * hardcoded here — they would go stale the same way. /v1/health carries the
 * live figures and this page links to it instead of repeating a number.
 *
 * Content negotiation lives in index.ts: a request that does not prefer
 * text/html still gets the original small JSON index, so nothing that
 * depended on `GET /` returning JSON breaks.
 */
import type { Env } from "./env";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function landingPage(env: Env, origin: string): string {
  const mcp = `${origin}/mcp`;
  const check = `${origin}/v1/check`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(env.SERVICE_NAME)}</title>
<meta name="description" content="Pay-per-call screening against the HHS-OIG LEIE and SAM.gov federal exclusion lists.">
<style>
  :root { color-scheme: light dark; --ink:#1a1a1a; --bg:#fdfcfa; --line:#ddd; --accent:#8b2e2e; }
  * { box-sizing: border-box; }
  body { font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         color: var(--ink); background: var(--bg); margin: 0; padding: 0 20px 60px; }
  main { max-width: 760px; margin: 0 auto; }
  header { padding: 40px 0 20px; border-bottom: 1px solid var(--line); }
  h1 { font-size: 1.7rem; margin: 0 0 6px; }
  .tagline { font-size: 1.05rem; color: #555; margin: 0; }
  h2 { font-size: 1.15rem; margin: 40px 0 12px; border-top: 1px solid var(--line); padding-top: 28px; }
  section:first-of-type h2 { border-top: none; padding-top: 0; }
  pre { background: #10100e; color: #e8e6df; padding: 14px 16px; border-radius: 6px; overflow-x: auto;
        font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  code { font: 0.92em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); }
  th { font-weight: 600; }
  .trial { background: #fff8ec; border: 1px solid #e8d8b0; border-radius: 8px; padding: 16px 18px; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e8e6df; --bg:#15140f; --line:#333; }
    .trial { background: #262112; border-color: #4a3f1e; }
  }
  ul { padding-left: 22px; }
  footer { margin-top: 50px; padding-top: 20px; border-top: 1px solid var(--line); color: #666; font-size: 0.9rem; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>

<header>
  <h1>${esc(env.SERVICE_NAME)}</h1>
  <p class="tagline">Is this person or business excluded from federal healthcare or government programs?</p>
</header>

<section>
<h2>What this answers</h2>
<p>Screens a name or identifier against two federal sources: the HHS-OIG List of Excluded
Individuals and Entities (LEIE) and the SAM.gov exclusions list. Match by name, NPI, UEI or
CAGE. Every result states a confidence level and the exact basis it matched on — an NPI hit,
a full-name hit, or a weaker surname-plus-initial hit — and, when a subject was later
reinstated, says so instead of just reporting "no match."</p>
</section>

<section>
<h2>Example</h2>
<pre>curl "${check}?name=Smith,%20John&amp;state=TX"</pre>
<pre>{
  "verdict": "excluded",
  "confidence": "match",
  "match_count": 1,
  "subject_count": 1,
  "matches": [{
    "confidence": "match",
    "basis": "full_name",
    "record": {
      "source": "leie", "last_name": "SMITH", "first_name": "JOHN",
      "state": "TX", "exclusion_type": "1128a1",
      "exclusion_date": "20180501", "currently_excluded": true
    }
  }],
  "coverage": { "complete": true }
}</pre>
</section>

<section>
<h2>Pricing</h2>
<table>
<tr><th>Endpoint</th><th>Price</th><th>Notes</th></tr>
<tr><td><code>/v1/check</code></td><td>${esc(env.PRICE_CHECK)}</td><td>verdict, confidence, basis, reason per match</td></tr>
<tr><td><code>/v1/report</code></td><td>${esc(env.PRICE_REPORT)}</td><td>every match with full source fields</td></tr>
<tr><td><code>/v1/health</code>, <code>/.well-known/x402</code></td><td>free</td><td>row counts, load dates, payment terms</td></tr>
<tr><td>MCP <code>exclusion_check</code></td><td>${esc(env.PRICE_CHECK)}</td><td>per call</td></tr>
<tr><td>MCP <code>exclusion_sources</code></td><td>free</td><td>&nbsp;</td></tr>
</table>
<p>Paid in USDC over x402 on Base mainnet. See <a href="/v1/health">/v1/health</a> for current
row counts and load freshness.</p>
</section>

<section>
<div class="trial">
<h2 style="margin-top:0; border-top:none; padding-top:0;">Try it free — 3 calls a day</h2>
<p>Add <code>?trial=1</code> to a <code>GET /v1/check</code> request (or send header
<code>X-Trial: 1</code>). The first 3 calls per day from your IP return a real result with no
payment challenge; the response carries <code>X-Trial-Remaining</code>. The 4th call that day
gets the normal 402.</p>
<pre>curl "${check}?name=Smith,%20John&amp;state=TX&amp;trial=1"</pre>
</div>
</section>

<section>
<h2>curl (paid)</h2>
<pre>curl -i "${check}?name=Smith,%20John&amp;state=TX"
# -&gt; 402 Payment Required; the payment-required header carries the exact terms.
# An x402-aware HTTP client retries the same request with a signed payment header.</pre>
</section>

<section>
<h2>MCP</h2>
<p><strong>Claude Desktop</strong> validates only local (stdio) servers in its config, so a
remote server goes through the <code>mcp-remote</code> bridge:</p>
<pre>{
  "mcpServers": {
    "cf-exclusion-check": {
      "command": "npx",
      "args": ["mcp-remote", "${mcp}"]
    }
  }
}</pre>
<p><strong>Claude Code, and other clients that speak remote HTTP directly</strong> (a bare
URL, no bridge process):</p>
<pre>{
  "mcpServers": {
    "cf-exclusion-check": {
      "type": "http",
      "url": "${mcp}"
    }
  }
}</pre>
<p><code>initialize</code> and <code>tools/list</code> are free, so an agent can see the tool
and its price before paying. Try it: <code>exclusion_sources</code> is a free tool.</p>
</section>

<section>
<h2>x402 client (pay per call)</h2>
<p>Any x402-aware HTTP client works. The repo's own verification client:</p>
<pre>git clone https://github.com/cfgenius145-sketch/cf-exclusion-check
cd cf-exclusion-check &amp;&amp; npm install
node scripts/x402-client.mjs                    # pays ${esc(env.PRICE_CHECK)} for /v1/check
node scripts/x402-client.mjs /v1/report "Name"  # pays ${esc(env.PRICE_REPORT)}</pre>
</section>

<section>
<h2>Data sources and refresh</h2>
<ul>
<li><strong>HHS-OIG LEIE</strong> — the federal healthcare exclusion list, plus reinstatement
records so a "no match" reflects history, not just the current active list.</li>
<li><strong>SAM.gov exclusions</strong> — the government-wide exclusions list (most of it is
individuals, not businesses, despite the common assumption).</li>
<li>Checked daily for freshness; see <a href="/v1/health">/v1/health</a> for the loaded
generation date and whether a bulk reseed is due.</li>
</ul>
</section>

<section>
<h2>Limits and disclaimer</h2>
<ul>
<li>Screens the HHS-OIG LEIE and SAM.gov exclusions only — not state Medicaid exclusion lists
or licensure board actions.</li>
<li>A match is a <strong>name match, not an identity determination</strong>. A non-match is not
a clearance. Confirm against the official record at
<a href="https://exclusions.oig.hhs.gov">exclusions.oig.hhs.gov</a> (LEIE) or
<a href="https://sam.gov/search">sam.gov/search</a> (SAM) before acting.</li>
<li>Results reflect the loaded data generation reported by <code>/v1/health</code>, not a
live query against OIG or SAM.gov.</li>
</ul>
</section>

<footer>
Repo: <a href="https://github.com/cfgenius145-sketch/cf-exclusion-check">github.com/cfgenius145-sketch/cf-exclusion-check</a>
&middot; Discovery: <a href="/.well-known/x402">/.well-known/x402</a>
&middot; Contact: <a href="mailto:info@cfaisolutions.com">info@cfaisolutions.com</a>
</footer>

</main>
</body>
</html>
`;
}

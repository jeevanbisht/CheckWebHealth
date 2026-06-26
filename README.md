# CheckWebHealth

Diagnose whether a network egress path — especially **Microsoft Global Secure Access (GSA)** —
is being blocked by CDN / WAF **bot-detection** (Akamai Bot Manager, Cloudflare, Imperva, AWS
CloudFront/WAF, and others), and produce a shareable, evidence-grade report.

Born from a real case: `automobiles.honda.com` returned an **Akamai Bot Manager 403 "Access
Denied"** for GSA-tunneled users. This kit answers the follow-up question objectively — **where
else does this reproduce, and is the network actually the cause?** — across 2,500 sites.

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/playwright-Edge%20%2F%20Chromium-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Why this is defensible

A bare `403` from one vantage point proves nothing. This kit is built around the two signals that
*do* hold up when escalated to a CDN/WAF vendor:

1. **`NETWORK-CAUSED`** — the site loads `OK` on a **direct** connection but fails through **GSA**.
   Run the same probe twice (off-tunnel baseline + on-tunnel test); the report diffs the two arms.
   These are the only rows that prove the network path is the cause.
2. **`IP_REPUTATION`** — the Akamai bot sensor cookie (`_abck`) is **passed** (browser fingerprint
   accepted), yet the request is still denied ⇒ the block is driven by **egress-IP/ASN reputation**,
   not the browser. Paired with the captured **egress IP + ASN** and the CDN **`Reference #`**, this
   is a traceable hand-off the vendor can look up in their logs.

---

## How it works

Drives a **real browser — Microsoft Edge (`channel:msedge`) by default** with light anti-automation
stealth (to remove the "headless = bot" confound) to each site, and records per site:

| Captured | Detail |
|----------|--------|
| **Verdict** | `OK` · `AUTH_REQUIRED` · `IP_REPUTATION` · `BLOCKED` · `HUMAN_CHALLENGE` · `BOT_CHALLENGE` · `ERROR` |
| **Vendor** | Akamai / Cloudflare / Imperva / AWS CloudFront-WAF / Fastly / F5 BIG-IP / Vercel / Netlify / … |
| **`_abck` state** | `passed` (`~-1~`) vs `challenged` (`~0~`) — the key Akamai Bot-Manager signal |
| **HTTP status + WAF headers** | `server`, `akamai-grn`, `retry-after`, and vendor headers |
| **Reference ID** | Akamai `Reference #` / Cloudflare `cf-ray` / AWS `x-amz-cf-id` — for vendor escalation |
| **CDN edge IP / failure layer** | `edge:` IP that served the response; for errors, the failed `layer:` (DNS/TCP/TLS/TIMEOUT/HTTP) |
| **Egress IP + ASN/org** | The public IP and ASN the request exited from (per arm) |
| **Screenshot** | Captured at the moment of the block for every non-`OK` row (evidence that survives a retry) |
| **Specific reason** | Machine-readable cause alongside the verdict — `DNS_FAILURE` · `TCP_FAILURE` · `TLS_FAILURE` · `TIMEOUT` · `RESET_CONNECTION` · `HTTP_403/404/429/5XX` · `WAF_BLOCK` · `IP_REPUTATION` · `AUTH_REQUIRED` |
| **Attempt history** | Every attempt is logged (`attemptLog`) and rolled up to `PASS` · `RECOVERED` · `FAILED_ONCE` · `FAILED_TWICE` · `FAILED_ALL` — a failure is never decided from a single try |
| **Failure evidence** | On non-`OK` rows only: a per-host network log + browser console log (and a true `.har` on the evidence pass with `HAR=1`). Successful runs stay lightweight. |

> **Authentication is not a block.** A `401`, or a redirect to a known identity provider
> (Microsoft Entra/Azure AD, Okta, Ping, Duo, ADFS), is classified as `AUTH_REQUIRED` — never as a
> `BLOCKED` or `NETWORK-CAUSED` failure.

The output is a **single self-contained HTML report**, tabbed by category, with per-category and
overall summaries, an egress banner, a **top-failure-reasons** bar, combinable
**verdict / vendor / status filters**, **click-to-sort** columns, and an **Excel export** of the
filtered view.

---

## Quick start

```bash
npm install
npm run setup          # installs Microsoft Edge + Chromium browser binaries
```

Then run the **A/B method** — the same probe off-GSA (baseline) and on-GSA (test):

```powershell
$env:PROBE_ARM="direct"; npm run probe   # GSA OFF — baseline
$env:PROBE_ARM="gsa";    npm run probe   # GSA ON  — test
npm run report                           # merges both arms into the report
Start-Process .\akamai-probe-results\catalog\report-catalog.html
```

With only one arm present the report renders single-arm (no delta). For a fast smoke test, run
`npm run sample` (10 categories).

> **Concurrency defaults to `4` on purpose.** Hammering many CDN-fronted sites from one egress IP
> itself trips rate/reputation limits and manufactures false blocks. Override with `CONC` only if you
> understand the tradeoff: `$env:CONC=2; npm run probe`.

Full setup: **[INSTALL.md](INSTALL.md)** · usage, env vars & interpreting results:
**[GSA-Catalog-Probe-Runbook.md](GSA-Catalog-Probe-Runbook.md)**

---

## npm scripts

| Script | Action |
|--------|--------|
| `npm run setup` | Install the Microsoft Edge + Chromium browser binaries |
| `npm test` | Run the unit tests for the classification helpers (Node's built-in runner — no extra deps) |
| `npm run sample` | Run a 10-category sample probe (with screenshots) |
| `npm run probe` | Run the full 2,500-site catalog probe (tag the arm via `PROBE_ARM`) |
| `npm run evidence` | Re-screenshot the non-`OK` rows of an existing run (add `HAR=1` for per-host `.har`) |
| `npm run report` | Build the tabbed HTML report from results |
| `npm run all` | Probe + report |

---

## Project layout

| File | Purpose |
|------|---------|
| `sites-catalog.mjs` | The 50×50 site catalog (`CATALOG` export). Edit to change sites. |
| `probe-core.mjs` | Shared probe engine: Edge launch + stealth, egress IP/ASN capture, classify, auth-vs-block detection, specific-reason taxonomy, retries + attempt log, failure evidence, redirect-chain timing, header capture/diff, confidence scoring. |
| `config.mjs` | Single source of run config. Merges built-in `DEFAULTS` ← `probe.config.json` ← environment variables (`loadConfig()`). |
| `probe-catalog.mjs` | Full 2,500-site probe. Writes `results-<arm>.json` (+ legacy `results-catalog.json`). |
| `probe-sample.mjs` | Quick 10-category sample probe (same engine) for spot checks. |
| `probe-evidence.mjs` | Re-screenshots the non-`OK` rows of an existing run (resilient + resumable); `HAR=1` adds per-host `.har`. |
| `render-catalog-html.mjs` | Renders the tabbed, interactive HTML report; merges arms into a delta, a **Comparison Matrix** of per-path verdicts, a **Confidence** column, redirect chains and per-row header diffs. |
| `tests/` | Unit tests for the pure helpers — classification, config precedence, header diff, confidence scoring (`npm test`). |

### Configuration file (`probe.config.json`)

All run settings have built-in defaults and can be overridden by an optional `probe.config.json`
in the repo root, which is in turn overridden by environment variables (env wins). Example:

```json
{
  "retries": 3,
  "concurrency": 6,
  "navTimeout": 30000,
  "settleMs": 3000,
  "paths": [
    { "id": "direct", "label": "Direct Internet" },
    { "id": "gsa", "label": "Microsoft GSA" }
  ]
}
```

Each `paths` entry maps to a `results-<id>.json` output file; the report lines every path up
into the Comparison Matrix automatically (add a 3rd path, e.g. `azure-vm`, and it appears).

Key environment variables (full list in the Runbook):

| Var | Default | Purpose |
|-----|---------|---------|
| `PROBE_ARM` | `gsa` | Tags the run + output file (`direct` / `gsa` / any path id). |
| `CONC` | `4` | Parallel browser contexts. Keep modest. |
| `PROBE_RETRIES` | `2` | Max attempts per site. Transient `429/503` are retried; the full attempt history is recorded. |
| `NAV_TIMEOUT` | `25000` | Per-navigation timeout (ms). |
| `SETTLE_MS` | `2500` | Time to let the page settle before reading state (ms). |
| `OUT_DIR` | `akamai-probe-results/catalog` | Output directory for results, screenshots and evidence. |
| `PROBE_CHANNEL` | `msedge` | Browser channel (`msedge` / `chrome` / `chromium`). |
| `PROBE_HEADED` | unset | Set `1` for a headed (visible) run — best forensic fidelity. |
| `SHOTS` | unset | Set `1` to screenshot every site (heavy for 2,500 sites). |
| `HAR` | unset | On `npm run evidence`, set `1` to export a true per-host `.har` for each failed row. |

### Report: matrix, confidence, redirects & header diff

- **Comparison Matrix** tab — for every site whose verdict is **not** identical across all probed
  paths, a `Site | Direct | GSA | … | Confidence` grid. This is where a path-specific (e.g.
  GSA-only) block stands out at a glance.
- **Confidence** column — a 5–99% score with the contributing factors on hover (e.g. *direct loads
  OK but GSA fails*, *same result across 3 attempts*, *Akamai `_abck` passed yet denied*). Single
  path / timeout / DNS flakes score low; corroborated, consistent, strong-signal failures score high.
- **Redirect chain** — each hop's status, `Location`, protocol and per-hop timing, so you can see
  *where* in the chain a failure occurred (not just the final URL).
- **Header diff** — on dual-arm runs, the headers that changed between the `direct` baseline and the
  path under test (Server, Via, cache, HSTS, CDN trace IDs). Only header **names** are stored for
  cookies — never values — so the report stays shareable.

---

## Security & privacy

- Probe output (`results-*.json`) can contain cookies, edge IPs, and tokens. `.gitignore` excludes
  `akamai-probe-results/`, `har/` / `*.har`, and `node_modules/` so they are **never committed**.
- The report is self-contained and safe to email/share, but treat the raw `results-*.json` as
  sensitive if it leaves the machine.

---

## License

[MIT](LICENSE) © Microsoft / contributors.

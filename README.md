# CheckWebHealth

Test whether a network egress path — especially **Microsoft Global Secure Access (GSA)** —
is blocked by CDN / WAF **bot-detection** (Akamai Bot Manager, Cloudflare, Imperva, etc.)
across the web, then produce a shareable report.

Born from a real case: `automobiles.honda.com` returned an **Akamai Bot Manager 403 "Access
Denied"** for GSA-tunneled users. This kit lets you check **where else** that reproduces.

---

## What's inside

| Area | Files |
|------|-------|
| **Breadth probe** (2,500 sites, 50 categories) | `sites-catalog.mjs`, `probe-catalog.mjs`, `render-catalog-html.mjs` |
| **Single-run probe** (small list + screenshots) | `probe-akamai-browser.mjs`, `render-akamai-html.mjs` |
| **HAR deep-dive** (one transaction) | `capture-har.js`, `analyze-har.mjs` |
| **Docs** | `INSTALL.md`, `GSA-Catalog-Probe-Runbook.md`, `GSA-Blocked-Site-Investigation-Playbook.md`, `GSA-Investigation-Note-honda-akamai-403.md` |

---

## How it works

Drives **real Chromium** (JS enabled, genuine desktop fingerprint — no emulation) to each site
and records, per site:

- **Verdict** — `OK` · `BLOCKED` (403/429/444/503 / "Access Denied" body) · `CHALLENGE`
  (`_abck` `~0~` or JS interstitial) · `ERROR`
- **Vendor** — Akamai / Cloudflare / Imperva / AWS CloudFront-WAF / Fastly / F5 / Sucuri / …
- **`_abck` state** — `passed` (`~-1~`) vs `challenged` (`~0~`)

> 🔑 Key signal: a site whose `_abck` is **passed** but still **BLOCKED** ⇒ the block is driven by
> **egress-IP reputation**, not browser fingerprint (the Honda root cause).

Output is a **self-contained HTML report**, tabbed by category, with per-category + overall
summaries (block rate, vendor mix, Akamai count).

---

## Quick start

```bash
npm install
npm run setup          # downloads Chromium (playwright install chromium)
npm run all            # probe 2,500 sites, then build the report (~20–40 min)
```

Open `akamai-probe-results/catalog/report-catalog.html`.

Adjust concurrency with the `CONC` env var (default 20):

```bash
CONC=30 npm run probe   # macOS/Linux
```
```powershell
$env:CONC=10; npm run probe   # PowerShell
```

Full setup details: **[INSTALL.md](INSTALL.md)** · usage & interpretation:
**[GSA-Catalog-Probe-Runbook.md](GSA-Catalog-Probe-Runbook.md)**

---

## npm scripts

| Script | Action |
|--------|--------|
| `npm run setup` | Download the Chromium browser binary |
| `npm run probe` | Run the 2,500-site catalog probe |
| `npm run report` | Build the tabbed HTML report from results |
| `npm run all` | Probe + report |
| `npm run capture` | Capture a single HAR (deep-dive) |

---

## Tips for a forensic match

- Use real Edge instead of bundled Chromium: add `channel: "msedge"` to `chromium.launch(...)`.
- Run **off-GSA** once as a baseline, then **on-GSA**; any site `OK` off-GSA but `BLOCKED` on-GSA
  is a true positive.
- For a single deep dive, a **HAR** is the gold standard — see the Playbook.

---

## Security

Probe output and HAR captures can contain cookies / tokens. `.gitignore` excludes
`har/`, `akamai-probe-results/`, and `node_modules/` so they are **never committed**.

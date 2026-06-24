# GSA × CDN / Bot-Manager — 50-Category Site Probe (Runbook)

A portable runbook to test, **from any machine (e.g., behind GSA)**, whether a SaaS/network
path is blocked by CDN/WAF bot-detection (Akamai Bot Manager, Cloudflare, Imperva, etc.)
across **2,500 sites in 50 categories**.

> Origin: extends the `automobiles.honda.com` → Akamai Bot Manager 403 investigation.
> See `GSA-Investigation-Note-honda-akamai-403.md` and `GSA-Blocked-Site-Investigation-Playbook.md`.

---

## What it does

Drives **real Chromium** (JS enabled, genuine desktop fingerprint — *no emulation*) to each
site, then records per site:

- **Verdict** — `OK` · `BLOCKED` (403/429/444/503 or "Access Denied" body) · `CHALLENGE`
  (`_abck` stuck at `~0~`, or a JS interstitial) · `ERROR` (navigation failed/timeout)
- **HTTP status**, `server` header, `akamai-grn`
- **Detected vendor** — Akamai / Cloudflare / Imperva / AWS CloudFront-WAF / Fastly / F5 BIG-IP /
  Sucuri / Vercel / Netlify / Google / Microsoft-Azure / Other / Unknown
- **`_abck` state** — `passed` (`~-1~`) vs `challenged` (`~0~`) — the key Akamai Bot-Manager signal

Output is a **single self-contained HTML report**, tabbed by category, with a **per-category
summary** (block rate, vendor mix, Akamai count) and an **overall summary**.

> 🔑 The strongest finding to look for: a site whose `_abck` shows **passed** but still returns
> **BLOCKED** → the block is **egress-IP reputation**, not browser fingerprint (the Honda root cause).

---

## Files in this kit

| File | Purpose |
|------|---------|
| `sites-catalog.mjs` | The 50×50 site catalog (`CATALOG` export). Edit to change sites. |
| `probe-catalog.mjs` | The probe. Writes `akamai-probe-results/catalog/results-catalog.json`. |
| `render-catalog-html.mjs` | Renders the tabbed HTML report from that JSON. |

Copy all three to the target machine (keep them in the **same folder**).

---

## Prerequisites

- **Node.js 18+** (uses built-in `fetch`/ESM). Check: `node --version`
- **Playwright + Chromium** browser binary.

```powershell
# in the kit folder
npm init -y                      # only if no package.json yet
npm install playwright
npx playwright install chromium  # downloads the browser binary (~150 MB)
```

> The scripts are ESM (`.mjs`) — run them directly with `node`, no build step.

---

## Run it

### 1) Probe (the long step)

```powershell
node probe-catalog.mjs
```

- Default concurrency = **20** parallel browser contexts. Override with the `CONC` env var:

```powershell
# PowerShell
$env:CONC=10; node probe-catalog.mjs
```
```bash
# macOS/Linux
CONC=30 node probe-catalog.mjs
```

- Expect **~20–40 min** for 2,500 sites at concurrency 20 (depends on network/CPU).
- Progress prints every 50 sites; results are **checkpointed to JSON** as it goes, so a crash
  mid-run still leaves partial data you can render.
- Output: `akamai-probe-results/catalog/results-catalog.json`

> **Run it behind GSA** to get the test result. Optionally run once **off-GSA** first and rename
> the JSON (e.g., `results-baseline.json`) to compare — any site `OK` off-GSA but `BLOCKED`
> on-GSA is a true positive.

### 2) Render the report

```powershell
node render-catalog-html.mjs
```

- Output: `akamai-probe-results/catalog/report-catalog.html`
- Open it in any browser (double-click). It's fully self-contained — safe to email/share.

```powershell
# open on Windows
Start-Process .\akamai-probe-results\catalog\report-catalog.html
```

---

## Tuning

| Setting | Where | Notes |
|---------|-------|-------|
| Concurrency | `CONC` env var | Lower (8–10) on limited RAM; higher (30) on a strong box. |
| Per-site timeout | `NAV_TIMEOUT` in `probe-catalog.mjs` | Default 25 s. |
| Settle delay | `SETTLE_MS` | Default 1.5 s — lets Akamai's sensor set `_abck`. |
| Sites / categories | `sites-catalog.mjs` | Edit the `CATALOG` object freely. |
| Headed (watch live) | `chromium.launch({ headless: true })` → `false` | For debugging only. |
| Use real Edge | add `channel: "msedge"` to `chromium.launch(...)` | Matches an Edge-based repro. |

---

## Interpreting results

1. **Overall block rate** + the **vendor bar** at the top → how much of the web your egress trips.
2. Per category tab → which verticals are worst (e.g., Airlines/Hotels often Akamai-heavy).
3. Filter your attention to **`vendor = Akamai` + `verdict = BLOCKED`**, especially where
   **`_abck = passed`** → proves IP-reputation blocking (escalate the GSA egress IP/ASN to Akamai).
4. `CHALLENGE` rows (Cloudflare "Just a moment" / Akamai `~0~`) → degraded, looping, or
   challenge-walled — also worth flagging.
5. `ERROR` rows → DNS/timeout; re-run that subset before drawing conclusions.

### Re-run a subset
Edit `sites-catalog.mjs` down to the categories/hosts of interest, or temporarily filter in
`probe-catalog.mjs` where the `tasks` array is built.

---

## Notes & caveats

- Catalog domains are **best-effort curated**; a few niche entries may 404/redirect — they show as
  `ERROR`/`OTHER`, not false blocks.
- Headless Chromium has a slightly different fingerprint than headed Edge; for a forensic match
  with a specific manual repro, use `channel: "msedge"` + `headless: false`.
- A **HAR is still the gold standard** for a single deep-dive (see the Playbook). This kit is for
  **breadth** — finding *where else* the block reproduces.
- A HAR/JSON can contain cookies/tokens — treat `results-catalog.json` as sensitive if shared.

# GSA × CDN / Bot-Manager — 50-Category Site Probe (Runbook)

A portable runbook to test, **from any machine (e.g., behind GSA)**, whether a SaaS/network
path is blocked by CDN/WAF bot-detection (Akamai Bot Manager, Cloudflare, Imperva, etc.)
across **2,500 sites in 50 categories**.

---

## What it does

Drives a **real browser — Microsoft Edge (`channel:msedge`) by default**, with light
anti-automation stealth — to each site, then records per site:

- **Verdict** — `OK` · `IP_REPUTATION` (bot sensor passed `_abck`, yet still denied ⇒ egress-IP/ASN
  block) · `BLOCKED` (401/403/429/444/451/503 or "Access Denied" body) · `HUMAN_CHALLENGE`
  (captcha/interstitial) · `BOT_CHALLENGE` (`_abck` `~0~` / Cloudflare cf-chl) · `ERROR` (nav failed)
- **HTTP status**, `server` header, `akamai-grn`, **`retry-after`**, and key **WAF headers**
- **CDN edge IP** that served the response (`edge:`) and, for errors, the **failed network layer**
  (`layer:` DNS / TCP / TLS / TIMEOUT / HTTP)
- **Detected vendor** — Akamai / Cloudflare / Imperva / AWS CloudFront-WAF / Fastly / F5 BIG-IP /
  Sucuri / Vercel / Netlify / Google / Microsoft-Azure / Other / Unknown
- **`_abck` state** — `passed` (`~-1~`) vs `challenged` (`~0~`) — the key Akamai Bot-Manager signal

Each run is tagged with an **arm** (`direct` or `gsa`) and records the **egress public IP + ASN/org**.
Run both arms and the report computes a per-site **delta**, surfacing **`NETWORK-CAUSED`** rows —
sites that load on a direct connection but fail through GSA. **Those are the only rows that prove the
network is the cause** and are the actionable hand-off to experts.

Output is a **single self-contained HTML report**, tabbed by category, with a **per-category
summary** (block rate, vendor mix), an **overall summary**, and an **egress banner**. The report is
interactive: combinable verdict/vendor/status filters, click-to-sort columns, and an Excel export of
the filtered view.

> 🔑 The strongest single finding: a site whose `_abck` shows **passed** but is still denied →
> the report labels this **`IP_REPUTATION`** — the block is **egress-IP reputation**, not browser
> fingerprint (the Honda root cause). Cross-referenced with **`NETWORK-CAUSED`** (OK direct / fail
> GSA), that is a defensible, actionable escalation.

---

## Files in this kit

| File | Purpose |
|------|---------|
| `src/core/sites-catalog.mjs` | The 50×50 site catalog (`CATALOG` export). Edit to change sites. |
| `src/core/probe-core.mjs` | Shared probe engine (Edge launch, stealth, egress capture, classify). |
| `src/core/config.mjs` | Resolved run config (DEFAULTS ← file ← env ← CLI flags). |
| `src/probe/probe-catalog.mjs` | Full 2,500-site probe. Writes `results-<arm>.json` + `results-catalog.json`. |
| `src/probe/probe-sample.mjs` | Quick 10-category sample probe (same engine) for spot checks. |
| `src/report/render-catalog-html.mjs` | Renders the tabbed HTML report; merges arms into a delta. |
| `src/probe/probe-evidence.mjs` | Re-screenshots the non-OK rows of an existing run (for runs done without shots). |

Clone the repo onto the target machine (the files resolve each other by relative path).

> **Screenshots = evidence.** The catalog probe captures a screenshot of every **non-OK** result
> at the moment of the block (including *before* a transient 429/503 retry, so a retry that clears
> the block cannot erase the proof). Shots are organised as
> `shots/<category>/<verdict>/<host>.png`. Set `SHOTS=1` to screenshot every site (heavy).

---

## Prerequisites

- **Node.js 18+** (uses built-in `fetch`/ESM). Check: `node --version`
- **Playwright + Chromium** browser binary.

```powershell
# in the kit folder
npm init -y                          # only if no package.json yet
npm install playwright
npx playwright install msedge        # installs Microsoft Edge channel (default browser)
npx playwright install chromium      # fallback browser binary (~150 MB)
```

> The scripts are ESM (`.mjs`) — run them directly with `node`, no build step.

---

## Run it — the A/B method (do both arms)

The whole point is to **compare the same probe with GSA off vs on**. A bare 403 from one vantage
point proves nothing; only `OK direct → fail on GSA` is evidence.

### 1) Baseline arm — **GSA disabled** (direct internet)

```powershell
checkwebhealth probe --arm direct
```
Writes `results-direct.json` (tagged with the direct egress IP/ASN).

### 2) Test arm — **GSA enabled** (through the tunnel)

```powershell
checkwebhealth probe --arm gsa
```
Writes `results-gsa.json` (tagged with the GSA egress IP/ASN).

> Run both arms from the **same machine, back-to-back**, so the only variable is the network path.
> Concurrency defaults to **4** on purpose — hammering many CDN-fronted sites from one egress IP
> itself trips rate/reputation limits and manufactures false blocks. Override with `CONC` only if
> you understand the tradeoff. Expect longer wall-clock than the old cc=20 default; that is intended.

### Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `PROBE_ARM` | `gsa` | Tags the run + output file (`direct` / `gsa`). |
| `CONC` | `4` | Parallel contexts (catalog probe). Keep modest. |
| `PROBE_CHANNEL` | `msedge` | Browser channel (`msedge` / `chrome` / `chromium`). Falls back to bundled Chromium. |
| `PROBE_HEADED` | unset | Set `1` for a headed (visible) run — best forensic fidelity. |
| `SHOTS` | unset | Set `1` to capture per-site screenshots (heavy for 2,500 sites). |

### 3) Render the report (merges both arms)

```powershell
checkwebhealth report --open
```

The report auto-detects `results-direct.json` + `results-gsa.json`, adds a **Direct vs GSA** column,
and a **NETWORK-CAUSED** KPI/filter. With only one arm present it renders single-arm (no delta).
Fully self-contained — safe to email/share.

### Quick sample (10 categories) for a smoke test

```powershell
checkwebhealth sample --arm gsa; checkwebhealth report
```

---

## Tuning

| Setting | Where | Notes |
|---------|-------|-------|
| Arm label | `PROBE_ARM` env | `direct` (baseline) vs `gsa` (test). |
| Concurrency | `CONC` env var | Default 4. Keep modest to avoid self-induced throttling. |
| Browser channel | `PROBE_CHANNEL` env | `msedge` (default) / `chrome` / `chromium`. |
| Headed run | `PROBE_HEADED=1` | Visible browser — best forensic fidelity, rules out headless confound. |
| Per-site timeout | `--nav-timeout` / `NAV_TIMEOUT` | Default 25 s. |
| Settle delay | `--settle` / `SETTLE_MS` | Default 2.5 s — lets the bot sensor set `_abck` / a challenge resolve. |
| Retry | `--retries` / `PROBE_RETRIES` | Transient 429/503 retried before being recorded. |
| Sites / categories | `src/core/sites-catalog.mjs` | Edit the `CATALOG` object freely. |

---

## Interpreting results

1. **`NETWORK-CAUSED` first.** Click the KPI to see sites that are `OK` direct but fail on GSA. This
   is your evidence list — everything else is context. If this count is 0, GSA is not the cause.
2. **`IP_REPUTATION`** rows (`_abck = passed` but denied) → the browser fingerprint was accepted yet
   the request was still blocked ⇒ **egress IP/ASN reputation**. Escalate the **GSA egress IP + ASN**
   (shown in the egress banner) and the **Akamai `Reference #`** to Akamai — that pair lets them trace
   the deny in their logs.
3. **Overall block rate** + **vendor bar** → how much of the web your egress trips, and via whom.
4. **Per-category tabs** → which verticals are worst (Airlines/Hotels are often Akamai-heavy).
5. **`HUMAN_CHALLENGE` / `BOT_CHALLENGE`** → challenge-walled or looping; degraded but not hard-blocked.
6. **`ERROR`** rows → check the `layer:` tag. `DNS`/`TLS`/`TCP` failures are network-path issues
   (often the SASE proxy), *not* WAF blocks — triage them separately from 403s.

### Re-run a subset
Edit `src/core/sites-catalog.mjs` down to the categories/hosts of interest, or temporarily filter in
`src/probe/probe-catalog.mjs` where the `tasks` array is built.

---

## Notes & caveats

- Catalog domains are **best-effort curated**; a few niche entries may 404/redirect — they show as
  `ERROR`/`OTHER`, not false blocks.
- The probe defaults to **real Edge + light stealth** to reduce the "headless = bot" confound. For
  the highest fidelity on a contested case, add `PROBE_HEADED=1` (visible browser).
- A **HAR is still the gold standard** for a single deep-dive. This kit is for **breadth** —
  finding *where else* the block reproduces — and for the **direct-vs-GSA delta**.
- `results-*.json` can contain cookies/edge IPs — treat as sensitive if shared.

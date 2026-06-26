# INSTALL — GSA Catalog Probe

Setup instructions to run the 50-category / 2,500-site CDN & Bot-Manager probe on a
**fresh machine** (e.g., a workstation behind GSA). For *what it does* and *how to interpret
results*, see `GSA-Catalog-Probe-Runbook.md`.

> **Which terminal?** Every command in this guide works the same in **Windows Command Prompt (`cmd`)** and **PowerShell** — the examples pass flags (e.g. `--arm gsa`) instead of shell-specific environment variables, so you don't need `set` or `$env:`. If you prefer the `npm run` scripts (which read env vars), set them per shell — PowerShell: `$env:PROBE_ARM='gsa'`; `cmd`: `set PROBE_ARM=gsa`. **When in doubt, open PowerShell** (Start → *Terminal*, or *Windows PowerShell*) and follow along.

---

## 1. Get the files

The project ships as a single tree (npm package or git clone) — keep it together; the
scripts resolve each other by relative path under `src/`.

```powershell
git clone https://github.com/jeevanbisht/CheckWebHealth.git
cd CheckWebHealth
```

Key paths:

```
package.json
bin/checkwebhealth.mjs          # CLI entry point
src/core/                       # probe-core.mjs, diagnosis.mjs, browser-parity.mjs, config.mjs, sites-catalog.mjs (engine)
src/probe/                      # probe-catalog.mjs, probe-sample.mjs, probe-validate.mjs, probe-evidence.mjs
src/report/                     # render-catalog-html.mjs (HTML report)
src/cli/                        # CLI parser + commands
```

---

## 2. Install Node.js 18+ (required)

Check if you already have it:

```powershell
node --version    # need v18.0.0 or newer
npm --version
```

If missing or too old, install:

### Windows
```powershell
winget install OpenJS.NodeJS.LTS
```
(or download the LTS MSI from https://nodejs.org and run it). **Reopen the terminal** afterward.

### macOS
```bash
brew install node           # Homebrew
# or download the LTS .pkg from https://nodejs.org
```

### Linux (Debian/Ubuntu)
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## 3. Install dependencies (Playwright + Chromium)

From the kit folder:

```powershell
npm install
npm run setup        # installs Microsoft Edge + Chromium browser binaries
```

- `npm install` pulls the `playwright` package (from `package.json`).
- `npm run setup` runs `playwright install chromium msedge` to fetch the browsers. The probe uses
  **Microsoft Edge** (`channel:msedge`) by default and falls back to bundled Chromium.

### Linux only — system libraries
Chromium needs shared libs. If `npm run setup` warns about missing deps:

```bash
sudo npx playwright install-deps chromium
```

---

## 4. Verify the install

These commands are identical in **Windows Command Prompt (`cmd`)** and **PowerShell** — run them from the kit folder:

```
node --version
npm ls playwright
node -e "import('./src/core/sites-catalog.mjs').then(m=>console.log('catalog OK:', Object.keys(m.CATALOG).length,'categories,', Object.values(m.CATALOG).flat().length,'sites'))"
```

Expected: `catalog OK: 50 categories, 2500 sites`

Quick smoke test (10-category sample, ~1 min) — optional. Use the `--arm` flag so it works the same in `cmd` and PowerShell (no `set` / `$env:` needed):

```
node bin/checkwebhealth.mjs sample --arm gsa
```
Confirms the browser launches, captures the egress IP, and writes results.

---

## 5. Run — A/B (direct baseline vs GSA)

Run the **same probe twice**, once off-GSA and once on-GSA; the report diffs them. These commands work the same in `cmd` and PowerShell:

```
node bin/checkwebhealth.mjs probe --arm direct   # GSA OFF — baseline
node bin/checkwebhealth.mjs probe --arm gsa      # GSA ON  — test
node bin/checkwebhealth.mjs report               # merges both arms, builds HTML
```

> **Invoking commands (cmd or PowerShell):** this guide uses `node bin/checkwebhealth.mjs <cmd>` with flags like `--arm gsa`, which behaves identically in **Windows `cmd`** and **PowerShell**. You can also install globally (`npm i -g .`) and call `checkwebhealth <cmd>`, or use the npm scripts `npm run probe|sample|report` — but those read **env vars**, which differ per shell: PowerShell `$env:PROBE_ARM='gsa'`, cmd `set PROBE_ARM=gsa`.

Concurrency defaults to **4** (keep it modest — high concurrency from one egress IP manufactures
false rate-limit blocks). A quick 10-category smoke test: `node bin/checkwebhealth.mjs sample --arm gsa`.

Outputs land in:

```
checkwebhealth-results/catalog/results-direct.json    # baseline arm
checkwebhealth-results/catalog/results-gsa.json       # test arm
checkwebhealth-results/catalog/results-catalog.json   # last arm (legacy single-arm view)
checkwebhealth-results/catalog/report-catalog.html    # open in a browser
```

Open the report (or just double-click `report-catalog.html` in File Explorer):

- **Windows `cmd`:** `start "" .\checkwebhealth-results\catalog\report-catalog.html`
- **Windows PowerShell:** `Invoke-Item .\checkwebhealth-results\catalog\report-catalog.html`
- **macOS:** `open ./checkwebhealth-results/catalog/report-catalog.html`
- **Linux:** `xdg-open ./checkwebhealth-results/catalog/report-catalog.html`

### Adjust concurrency (keep it low)
High concurrency from one egress IP looks like a scraper and triggers false rate-limit blocks. The
default is 4 for trustworthy results.
```
node bin/checkwebhealth.mjs probe --arm gsa --concurrency 2
```

## 6. Validate the browser environment (strip false positives)

A **headless** probe can't tell egress-IP reputation apart from headless-bot detection — Akamai/Cloudflare/PerimeterX
block headless browsers on **any** IP. Before escalating, re-probe the automation-suspect rows **headed** so the
report's diagnostic pipeline (browser trust → path validity → root cause) can separate a real network block from the
diagnostic browser being blocked:

```powershell
# (no npm script for validate — use the CLI entry point)
node bin/checkwebhealth.mjs validate --arm gsa                    # re-probe IP_REPUTATION rows headed
node bin/checkwebhealth.mjs validate --arm gsa --include-blocked  # also BLOCKED / challenge rows
npm run report                                                    # refresh verdicts + diagnoses
```

Suspects that load fine headed are promoted to `OK` (`automationFalsePositive`); those still denied headed are kept
(`headedConfirmed`). The report shows a per-arm **Browser Environment + Trust Score** panel and a per-row **Diagnosis**
block. When the browser isn't trusted (e.g. a headless run), sites that fail on **every** path are reported as
`AUTOMATION_OR_BROWSER_POSTURE` / `TOOL_BROWSER_BLOCKED` — never `IP_REPUTATION`.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `node: command not found` | Reopen terminal after install; ensure Node is on `PATH`. |
| `Cannot find module 'playwright'` | Run `npm install` in the kit folder. |
| `browserType.launch: Executable doesn't exist` | Run `npm run setup` (`playwright install chromium msedge`). |
| Linux: launch fails on missing `.so` libs | `sudo npx playwright install-deps`. |
| Corporate proxy blocks the browser download | Set `HTTPS_PROXY`/`HTTP_PROXY` env vars, or pre-stage the Playwright browsers cache. |
| Many `ERROR` rows | Check the `layer:` tag in the report (DNS/TLS/TCP = network path, not WAF). Raise the per-navigation timeout (`--nav-timeout 40000` or `$env:NAV_TIMEOUT=40000`), re-run. |
| High RAM / machine struggles | Lower concurrency: `CONC=2`. |
| Edge not found | `npm run setup`, or set `PROBE_CHANNEL=chromium` to use bundled Chromium. |

---

## Uninstall / cleanup

```powershell
# remove fetched browser binaries + node modules
Remove-Item -Recurse -Force node_modules
npx playwright uninstall --all   # optional: remove cached browsers
```

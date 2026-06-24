# INSTALL — GSA Catalog Probe

Setup instructions to run the 50-category / 2,500-site CDN & Bot-Manager probe on a
**fresh machine** (e.g., a workstation behind GSA). For *what it does* and *how to interpret
results*, see `GSA-Catalog-Probe-Runbook.md`.

---

## 1. Files to copy

Put these in **one folder** on the target machine:

```
package.json
sites-catalog.mjs          # the 50×50 site catalog
probe-core.mjs             # shared probe engine
probe-catalog.mjs          # the full 2,500-site probe
probe-sample.mjs           # 10-category sample probe
probe-evidence.mjs         # re-screenshot pass for non-OK rows
render-catalog-html.mjs    # the HTML report generator
GSA-Catalog-Probe-Runbook.md
INSTALL.md                 # this file
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

```powershell
node --version
npm ls playwright
node -e "import('./sites-catalog.mjs').then(m=>console.log('catalog OK:', Object.keys(m.CATALOG).length,'categories,', Object.values(m.CATALOG).flat().length,'sites'))"
```

Expected: `catalog OK: 50 categories, 2500 sites`

Quick smoke test (10-category sample, ~1 min) — optional:

```powershell
$env:PROBE_ARM="gsa"; npm run sample
```
Confirms the browser launches, captures the egress IP, and writes results.

---

## 5. Run — A/B (direct baseline vs GSA)

Run the **same probe twice**, once off-GSA and once on-GSA; the report diffs them.

```powershell
$env:PROBE_ARM="direct"; npm run probe   # GSA OFF — baseline
$env:PROBE_ARM="gsa";    npm run probe   # GSA ON  — test
npm run report                           # merges both arms, builds HTML
```

Concurrency defaults to **4** (keep it modest — high concurrency from one egress IP manufactures
false rate-limit blocks). A quick 10-category smoke test: `npm run sample`.

Outputs land in:

```
akamai-probe-results/catalog/results-direct.json    # baseline arm
akamai-probe-results/catalog/results-gsa.json       # test arm
akamai-probe-results/catalog/results-catalog.json   # last arm (legacy single-arm view)
akamai-probe-results/catalog/report-catalog.html    # open in a browser
```

Open the report:

```powershell
# Windows
Start-Process .\akamai-probe-results\catalog\report-catalog.html
# macOS
open ./akamai-probe-results/catalog/report-catalog.html
# Linux
xdg-open ./akamai-probe-results/catalog/report-catalog.html
```

### Adjust concurrency (keep it low)
High concurrency from one egress IP looks like a scraper and triggers false rate-limit blocks. The
default is 4 for trustworthy results.
```powershell
# PowerShell
$env:CONC=2; npm run probe
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `node: command not found` | Reopen terminal after install; ensure Node is on `PATH`. |
| `Cannot find module 'playwright'` | Run `npm install` in the kit folder. |
| `browserType.launch: Executable doesn't exist` | Run `npm run setup` (`playwright install chromium msedge`). |
| Linux: launch fails on missing `.so` libs | `sudo npx playwright install-deps`. |
| Corporate proxy blocks the browser download | Set `HTTPS_PROXY`/`HTTP_PROXY` env vars, or pre-stage the Playwright browsers cache. |
| Many `ERROR` rows | Check the `layer:` tag in the report (DNS/TLS/TCP = network path, not WAF). Raise `navTimeout` in `probe-core.mjs`, re-run. |
| High RAM / machine struggles | Lower concurrency: `CONC=2`. |
| Edge not found | `npm run setup`, or set `PROBE_CHANNEL=chromium` to use bundled Chromium. |

---

## Uninstall / cleanup

```powershell
# remove fetched browser binaries + node modules
Remove-Item -Recurse -Force node_modules
npx playwright uninstall --all   # optional: remove cached browsers
```

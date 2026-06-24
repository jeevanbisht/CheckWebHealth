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
probe-catalog.mjs          # the probe
render-catalog-html.mjs    # the HTML report generator
GSA-Catalog-Probe-Runbook.md
INSTALL.md                 # this file
```

(`probe-akamai-browser.mjs` / `render-akamai-html.mjs` are the small single-run variants —
optional.)

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
npm run setup        # downloads the Chromium browser binary (~150 MB)
```

- `npm install` pulls the `playwright` package (from `package.json`).
- `npm run setup` runs `playwright install chromium` to fetch the actual browser.

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

Quick smoke test (probes just a few sites, ~30 s) — optional:

```powershell
node -e "process.env.CONC=4" ; node probe-catalog.mjs
```
(Ctrl+C after the first progress line confirms it launches Chromium and navigates.)

---

## 5. Run

```powershell
npm run probe        # ~20–40 min for 2,500 sites @ concurrency 20
npm run report       # builds the tabbed HTML report
```

Or both at once:

```powershell
npm run all
```

Outputs land in:

```
akamai-probe-results/catalog/results-catalog.json   # raw data
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

### Adjust concurrency
```powershell
# PowerShell
$env:CONC=10; npm run probe
```
```bash
# macOS/Linux
CONC=30 npm run probe
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `node: command not found` | Reopen terminal after install; ensure Node is on `PATH`. |
| `Cannot find module 'playwright'` | Run `npm install` in the kit folder. |
| `browserType.launch: Executable doesn't exist` | Run `npm run setup` (i.e. `playwright install chromium`). |
| Linux: launch fails on missing `.so` libs | `sudo npx playwright install-deps chromium`. |
| Corporate proxy blocks the browser download | Set `HTTPS_PROXY`/`HTTP_PROXY` env vars, or pre-stage the Playwright browsers cache. |
| Many `ERROR` rows | Network/DNS or timeout — raise `NAV_TIMEOUT` in `probe-catalog.mjs`, re-run. |
| High RAM / machine struggles | Lower concurrency: `CONC=8`. |

---

## Uninstall / cleanup

```powershell
# remove fetched browser binaries + node modules
Remove-Item -Recurse -Force node_modules
npx playwright uninstall --all   # optional: remove cached browsers
```

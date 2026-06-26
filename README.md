# CheckWebHealth

> Diagnose whether a network egress path — especially **Microsoft Global Secure Access (GSA)** — is being blocked by CDN / WAF **bot-detection** (Akamai Bot Manager, Cloudflare, Imperva, AWS CloudFront/WAF, and others), and produce a shareable, evidence-grade HTML report.

Born from a real case: `automobiles.honda.com` returned an **Akamai Bot Manager 403 "Access Denied"** for GSA-tunneled users. This tool answers the follow-up question objectively — **where else does this reproduce, and is the network actually the cause?** — across a 2,500-site catalog.

[![CI](https://github.com/jeevanbisht/CheckWebHealth/actions/workflows/ci.yml/badge.svg)](https://github.com/jeevanbisht/CheckWebHealth/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/playwright-Edge%20%2F%20Chromium-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Table of contents

- [Why this is defensible](#why-this-is-defensible)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Install](#install)
- [Quick start (A/B: direct vs GSA)](#quick-start-ab-direct-vs-gsa)
- [CLI reference](#cli-reference)
- [Manual Browser Parity Mode](#manual-browser-parity-mode)
- [Two machines (GSA on one, off on the other)](#two-machines-gsa-on-one-off-on-the-other)
- [Configuration](#configuration)
- [Interpreting results](#interpreting-results)
- [JSON output schema](#json-output-schema)
- [The report](#the-report)
- [Supported environments](#supported-environments)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Security & privacy](#security--privacy)
- [Contributing](#contributing)
- [License](#license)

---

## Why this is defensible

A bare `403` from one vantage point proves nothing. This tool is built around the two signals that *do* hold up when escalated to a CDN/WAF vendor:

1. **`NETWORK-CAUSED`** — the site loads `OK` on a **direct** connection but fails through **GSA**. Run the same probe twice (off-tunnel baseline + on-tunnel test); the report diffs the two arms. These are the only rows that prove the *network path* is the cause.
2. **`IP_REPUTATION`** — the bot sensor cookie (`_abck`) is **passed** yet the request is still denied with a hard status (`403`/`451`). **Confirm it headed first** (`checkwebhealth validate`): a *headless* probe can't separate egress-IP reputation from headless-bot detection, so only a **headed-confirmed** denial is defensible. Once confirmed, pair it with the captured **egress IP + ASN** and the CDN **`Reference #`** for a traceable vendor hand-off. (`429`/`503` throttle and interactive slider challenges are **not** `IP_REPUTATION`.)

> **Authentication is not a block.** A `401`, or a redirect to a known identity provider (Microsoft Entra/Azure AD, Okta, Ping, Duo, ADFS), is classified as `AUTH_REQUIRED` — never as a `BLOCKED` or `NETWORK-CAUSED` failure.

---

## How it works

Drives a **real browser — Microsoft Edge (`channel:msedge`) by default** with light anti-automation stealth (to remove the "headless = bot" confound) to each site, and records per site:

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
| **Specific reason** | Machine-readable cause alongside the verdict — `DNS_FAILURE` · `TLS_FAILURE` · `TIMEOUT` · `HTTP_403/404/429/5XX` · `WAF_BLOCK` · `IP_REPUTATION` · `AUTH_REQUIRED` |
| **Attempt history** | Every attempt is logged and rolled up to `PASS` · `RECOVERED` · `FAILED_ONCE/TWICE/ALL` — a failure is never decided from a single try |
| **Failure evidence** | On non-`OK` rows only: a per-host network log + browser console log (and a true `.har` on the evidence pass with `--har`). Successful runs stay lightweight. |

The output is a **single self-contained HTML report**, tabbed by category, with per-category and overall summaries, an egress banner, a top-failure-reasons bar, combinable verdict / vendor / status filters, click-to-sort columns, and an Excel export of the filtered view.

---

## Architecture

```
        bin/checkwebhealth.mjs                 ← CLI entry (shebang)
                  │
        src/cli/ (args · spec · help)          ← parse flags, dispatch
          │                 │
   native commands     env-bridge (run.mjs)
   doctor/init/config   maps flags → env vars
          │                 │
          ▼                 ▼
   src/core/config.mjs   src/probe/{probe-catalog,probe-sample,probe-evidence}.mjs
   (DEFAULTS←file←env←flags)   src/report/render-catalog-html.mjs
                  │                                 │
                  ▼                                 ▼
        src/core/probe-core.mjs            report-catalog.html
   (launch · classify · verdict · retry · evidence)
                  │
        src/core/sites-catalog.mjs (50 × 50 = 2,500 hosts)
```

- **`src/core/probe-core.mjs`** is the detection engine: browser launch + stealth, egress IP/ASN capture, vendor detection, the verdict taxonomy (`classify`), specific-reason mapping (`deriveReason`), retry/attempt logging, redirect-chain timing, header capture/diff and confidence scoring. **This is the logic you should not redesign** — bug fixes welcome, behavioural changes need an issue first.
- **`src/core/config.mjs`** is the single source of run config: built-in `DEFAULTS` ← `probe.config.json` ← environment variables ← explicit overrides (CLI flags), all validated and clamped.
- The **CLI** is a thin, cross-platform front end. Its flags map onto the same env vars the scripts already read, so the `npm run probe` / `PROBE_ARM=gsa` workflow keeps working unchanged.

---

## Install

```bash
# one-off, no install:
npx checkwebhealth doctor

# or install globally:
npm install -g checkwebhealth
checkwebhealth doctor
```

The first probe needs browser binaries. `doctor` tells you if any are missing:

```bash
checkwebhealth doctor                     # ✓ Node ✓ Playwright ✓ Browser ✓ Network
npx playwright install chromium msedge    # run this if doctor reports a missing browser
```

Working from a clone instead of the published package? See **[INSTALL.md](INSTALL.md)**.

---

## Quick start (A/B: direct vs GSA)

Run the same probe twice — once **off** the GSA tunnel (baseline) and once **on** it (test) — then build the report:

```bash
checkwebhealth probe --arm direct     # GSA OFF — baseline  -> results-direct.json
checkwebhealth probe --arm gsa        # GSA ON  — test      -> results-gsa.json
checkwebhealth report --open          # merge both arms, open the HTML report
```

With only one arm present the report renders single-arm (no delta). For a fast smoke test (10 random categories): `checkwebhealth sample`.

> **Concurrency defaults to `4` on purpose.** Hammering many CDN-fronted sites from one egress IP itself trips rate/reputation limits and manufactures false blocks. Raise it only if you understand the tradeoff: `checkwebhealth probe --concurrency 2`.

---

## CLI reference

| Command | Purpose |
|---------|---------|
| `checkwebhealth doctor` | Check Node, Playwright, a launchable browser and outbound network. |
| `checkwebhealth init` | Write a starter `probe.config.json`. |
| `checkwebhealth probe` | Full catalog probe (tag the arm with `--arm`). |
| `checkwebhealth sample` | Quick sample probe (`--seed` for cross-machine parity). |
| `checkwebhealth report` | Build the HTML report (`--open` to launch it). |
| `checkwebhealth evidence` | Re-screenshot the non-`OK` rows of a run (`--har`). |
| `checkwebhealth validate` | **Headed re-validation**: re-probe automation-suspect rows headed to strip headless/challenge false positives (`--include-blocked`). |
| `checkwebhealth parity <url>` | **Manual Browser Parity**: compare your real Edge profile against a temporary automated profile (`--open`). |
| `checkwebhealth config` | Print the effective, resolved configuration. |
| `checkwebhealth version` | Print the installed version. |
| `checkwebhealth help [cmd]` | Show help for the CLI or a command. |

Common flags (run `checkwebhealth help <command>` for the full list):

| Flag | Applies to | Purpose |
|------|------------|---------|
| `--arm <id>` | probe · sample · evidence · validate | Path id this run exercises (`direct`, `gsa`, …). |
| `-c, --concurrency <n>` | probe | Parallel browser contexts (default `4`). |
| `--retries <n>` | probe · sample · validate | Max attempts per site (transient `429/503` retried). |
| `--nav-timeout <ms>` | probe · sample · validate | Per-navigation timeout. |
| `--settle <ms>` | probe · sample · validate | Settle time before reading page state. |
| `--channel <ch>` | probe · sample · evidence · parity · validate | `msedge` / `chrome` / `chromium`. |
| `--headed` | probe · sample · evidence | Visible (headed) browser. |
| `--shots <mode>` | probe | `all` / `fail` / `none`. |
| `--parity` | probe · sample | Run this arm through **manual-parity Edge** (your real profile via a safe copy; no stealth). |
| `--seed <n>` | sample | Fix the RNG so two machines pick the same sites. |
| `--har` | evidence | Export a per-host `.har` for each failed row. |
| `--include-blocked` | validate | Re-validate `BLOCKED`/challenge rows too, not just `IP_REPUTATION`. |
| `--url <url>` | parity | Target URL to compare (default `https://www.bing.com`). |
| `--mode <m>` | parity | `manual-parity` (real profile) or `automated` (temp profile). |
| `--profile-directory <p>` | parity · doctor | Edge profile: `Default`, `"Profile 1"`, … |
| `--user-data-dir <dir>` | parity · doctor | Edge *User Data* dir (default: the OS default). |
| `--manual-fails` | parity | Record that manual Edge also fails (real network/site failure). |
| `-o, --output <dir>` | all | Output directory for results, screenshots and the report. |
| `--open` | report · parity | Open the report when done. |
| `--json` | doctor · config · version | Machine-readable output (great for CI). |

> The classic `npm run probe` / `PROBE_ARM=gsa` workflow still works (see [Configuration](#configuration)); the CLI flags are just a friendlier, cross-platform front end over the same engine.

---

## Manual Browser Parity Mode

Sometimes a site loads fine in your **normal Microsoft Edge** but fails under the automated diagnostic browser. That gap is not a network failure — it is the *diagnostic browser environment* (a throwaway profile, headless mode, no cookies, the automation flag). **Manual Browser Parity Mode** makes the automated browser match your normal Edge as closely as possible so CheckWebHealth can tell those two cases apart.

> **This is browser parity, not stealth.** Parity mode does **not** implement anti-bot bypass, CAPTCHA bypass, or deception. Nothing is hidden or spoofed — `navigator.webdriver` is left at its honest value and reported as-is. The goal is accurate troubleshooting, not bypassing a site's protections.

```bash
checkwebhealth parity https://automobiles.honda.com --open
```

It runs the target through **two** automated browsers and compares them:

1. **Automated Edge — temporary profile** (the classic automation baseline: fresh profile, headless, no cookies).
2. **Manual-parity Edge** — real Edge (`channel:msedge`), **headed**, your **real persistent profile**, so cookies, local/session storage, language, timezone, certificates, proxy and preferences are *your* real ones.

The console (and the `parity-report.html`) then shows the three-way result and a classification:

```
Manual Edge                       : works
Automated Edge temporary profile  : FAILS
Automated Edge manual-parity      : works

Classification: AUTOMATION_OR_BROWSER_POSTURE
Sub-reasons: TEMP_PROFILE_USED, MISSING_COOKIES, HEADLESS_MODE
```

If manual/real-profile Edge works but the temporary-profile automation fails, the verdict is **`AUTOMATION_OR_BROWSER_POSTURE`** (the failure is the diagnostic browser, not the network) with one or more sub-reasons: `TEMP_PROFILE_USED`, `MISSING_COOKIES`, `BROWSER_VERSION_MISMATCH`, `HEADLESS_MODE`, `PROFILE_NOT_LOADED`, `SCRIPT_OR_RESOURCE_FAILURE`, `CLIENT_POSTURE_POLICY`, `SITE_REJECTS_AUTOMATED_BROWSER`. If the target also fails manually (`--manual-fails`), it is a **`NETWORK_OR_SITE_FAILURE`** instead.

**Choosing a profile.** Edge keeps multiple profiles under one *User Data* dir. Pick one with `--profile-directory`:

```bash
checkwebhealth parity https://site.example --profile-directory "Profile 1"
checkwebhealth parity https://site.example --user-data-dir "D:\\EdgeProfiles\\diag" --profile-directory Default
```

**Safety:**

- Parity mode opens your **real** Edge profile — **close all Edge windows first**. If the profile is **locked** (Edge is running), CheckWebHealth automatically falls back to a **safe copied diagnostic profile** (caches and lock files excluded) and clearly reports that the copied profile was used.
- Cookie/token **values are never printed, stored, or written to the report** — only cookie *names* and counts.
- Exported `.har` files are sanitised (cookie/authorization headers and request/response bodies stripped).

Run `checkwebhealth doctor` for a parity preflight: Edge installed + version, selected profile found, profile lock status, headless status, system proxy, whether automation is detectable, cookies available, and recommended fixes.

### Parity mode for the A/B probe arms

By default `checkwebhealth probe`/`sample` use a **temporary-profile** Edge with light stealth and a fixed fingerprint (the legacy A/B engine — unchanged). Add **`--parity`** to run an arm through **manual-parity Edge** instead — your **real** profile's cookies/session, **no stealth**, `navigator.webdriver` honest:

```bash
# direct baseline, but using your real Edge profile (cookies/session)
checkwebhealth probe --arm direct --parity
checkwebhealth probe --arm gsa    --parity
checkwebhealth report --open
```

This combines **both** diagnostic dimensions — the **network path** (`--arm direct` vs `gsa`) *and* the **browser posture** (real profile vs temp). To protect your real browser, parity-probe always runs through a **safe copied** diagnostic profile (real cookies at copy time, but writes never go back to your real profile), so a 2,500-site run won't pollute your history. The report's per-arm line shows `mode=manual-parity profile=copied` so viewers know real state was used. Keep `--concurrency` modest in parity mode.

### Headed re-validation (strip headless / challenge false positives)

A *headless* probe **can't tell egress-IP reputation apart from headless-bot detection** — Akamai / Cloudflare / PerimeterX deny or challenge a headless browser on **any** IP, so a fast catalog run mislabels those rows `IP_REPUTATION`. `checkwebhealth validate` re-probes the automation-suspect rows of an existing run with a **headed** real-Edge profile (matching a human) and rewrites the verdict:

```bash
checkwebhealth validate --arm gsa                   # IP_REPUTATION rows (default)
checkwebhealth validate --arm gsa --include-blocked # + BLOCKED / challenges
checkwebhealth report                               # refresh verdicts + NETWORK-CAUSED
```

- A suspect that loads **OK headed** is promoted to `OK` (`automationFalsePositive: true`) — it was a headless/timing artifact.
- A suspect **still denied headed** is kept and marked `headedConfirmed: true` — only these `IP_REPUTATION`/`BLOCKED` verdicts are escalation-grade.
- Rows record `headlessVerdict` / `headedVerdict` / `headedStatus` for provenance; re-render with `report` to refresh the delta.

Headed runs open a visible Edge window and go one site at a time, so `validate` targets the suspect rows (the default `IP_REPUTATION` set), not the whole catalog.

---

## Two machines (GSA on one, off on the other)

You can run each arm on a **separate machine** — one inside the GSA tunnel, one on plain internet — then copy the JSON onto one box to render. The report scans the output directory for every `results-<arm>.json` and lines arms up **per `category|host`**, so both machines must probe the **same hosts**:

```bash
# Machine A — NO GSA (baseline)
checkwebhealth probe --arm direct        # -> results-direct.json

# Machine B — WITH GSA (test)
checkwebhealth probe --arm gsa           # -> results-gsa.json

# Copy both files into one machine's output dir, then:
checkwebhealth report --open
```

`probe` is deterministic (every catalog host), so the two arms always line up. If you'd rather smoke-test with `sample` (10 **random** sites), pass the **same `--seed`** on both machines so each arm picks identical sites — otherwise the delta is empty:

```bash
checkwebhealth sample --arm direct --seed 42   # Machine A -> results-direct.json
checkwebhealth sample --arm gsa    --seed 42   # Machine B -> results-gsa.json
```

---

## Configuration

Settings resolve with the precedence **built-in defaults → `probe.config.json` → environment variables → CLI flags** (later wins). Generate a starter file with `checkwebhealth init`:

```json
{
  "retries": 2,
  "concurrency": 4,
  "navTimeout": 25000,
  "settleMs": 2500,
  "channel": "msedge",
  "shots": "fail",
  "paths": [
    { "id": "direct", "label": "Direct Internet" },
    { "id": "gsa", "label": "Microsoft GSA" }
  ]
}
```

Each `paths` entry maps to a `results-<id>.json` output file; the report lines every path up into the Comparison Matrix automatically (add a 3rd path, e.g. `azure-vm`, and it appears). Inspect the resolved config any time with `checkwebhealth config` (add `--json` for machine output).

### Browser parity block

[Manual Browser Parity Mode](#manual-browser-parity-mode) is configured under a nested `browser` object (all fields optional; shown with their defaults):

```json
{
  "browser": {
    "mode": "manual-parity",
    "channel": "msedge",
    "headless": false,
    "usePersistentProfile": true,
    "userDataDir": "C:\\Users\\<user>\\AppData\\Local\\Microsoft\\Edge\\User Data",
    "profileDirectory": "Default",
    "viewport": null,
    "locale": "system",
    "timezone": "system",
    "useSystemProxy": true
  }
}
```

`userDataDir: null` (omit it) resolves the OS-default Edge *User Data* dir. `viewport: null` uses the real window size; `locale`/`timezone` of `"system"` leave the OS/profile values untouched — together these maximise parity with your normal Edge.

Environment variables (equivalent to the flags, for the `npm run *` workflow):

| Var | Flag | Default | Purpose |
|-----|------|---------|---------|
| `PROBE_ARM` | `--arm` | `gsa` | Tags the run + output file. |
| `SEED` | `--seed` | unset | Fixed RNG seed for `sample`. |
| `CONC` | `--concurrency` | `4` | Parallel browser contexts. |
| `PROBE_RETRIES` | `--retries` | `2` | Max attempts per site. |
| `NAV_TIMEOUT` | `--nav-timeout` | `25000` | Per-navigation timeout (ms). |
| `SETTLE_MS` | `--settle` | `2500` | Settle time before reading state (ms). |
| `PROBE_CHANNEL` | `--channel` | `msedge` | Browser channel. |
| `PROBE_HEADED` | `--headed` | unset | `1` for a headed run. |
| `SHOTS_MODE` | `--shots` | `fail` | `all` / `fail` / `none`. |
| `HAR` | `--har` | unset | `1` to export per-host `.har` on the evidence pass. |
| `PROBE_PARITY` | `--parity` | unset | `1` to run the probe arm through manual-parity Edge (real profile via a safe copy). |
| `OUT_DIR` | `--output` | `checkwebhealth-results/catalog` | Output directory. |
| `BROWSER_MODE` | `--mode` | `manual-parity` | Parity browser mode (`manual-parity`/`automated`). |
| `BROWSER_HEADLESS` | — | `0` | `1` to run parity headless (headed by default). |
| `PROFILE_DIRECTORY` | `--profile-directory` | `Default` | Edge profile dir for parity/doctor. |
| `USER_DATA_DIR` | `--user-data-dir` | OS default | Edge *User Data* dir for parity/doctor. |
| `USE_SYSTEM_PROXY` | — | `1` | `0` to ignore the OS/Edge proxy in parity mode. |

---

## Interpreting results

| Verdict | Meaning |
|---------|---------|
| `NETWORK-CAUSED` | Loads `OK` on the **direct** baseline but fails through **GSA** — the actionable, network-attributable failures. |
| `IP_REPUTATION` | `_abck passed` yet a hard `403`/`451` denial ⇒ candidate egress-IP/ASN block. **Re-validate headed** (`checkwebhealth validate`) — a headless probe can't prove this; only `headedConfirmed` rows are escalation-grade. |
| `BLOCKED` | HTTP 403/429/444/451/503 or an access-denied block page (a real block; `429`/`503` are throttle/overload). |
| `AUTH_REQUIRED` | Expected authentication — a `401` or a redirect to a known IdP. Deliberately **not** a block. |
| `HUMAN_CHALLENGE` | Visible captcha or an interactive slider / "press & hold" wall (Cloudflare, hCaptcha, PerimeterX/HUMAN, DataDome). Solvable by a human ⇒ degraded UX, not a hard block. |
| `BOT_CHALLENGE` | JS/sensor challenge state (`_abck challenged` / Cloudflare `cf-chl`). |
| `OK` | 2xx/3xx. |
| `ERROR` | Navigation failed — see the `layer:` (DNS/TCP/TLS/TIMEOUT/HTTP). |

The **Confidence** column (5–99%) rates how trustworthy each diagnosis is: corroborated across paths, consistent across attempts, and strong-signal failures score high; single-path, timeout or DNS flakes score low. Hover any score for its contributing factors.

---

## JSON output schema

Each arm writes `results-<arm>.json`:

```jsonc
{
  "meta": {
    "arm": "gsa",                       // path id this run exercised
    "paths": [{ "id": "direct", "label": "Direct Internet" }, …],
    "seed": 1782438800595,              // sample only
    "browser": { "channel": "msedge", "headless": true, "stealth": true },
    "egress": { "ip": "…", "asn": "AS8075", "org": "…", "country": "US", "source": "ipinfo.io" },
    "startedAt": "2026-06-25T…Z",
    "finishedAt": "2026-06-25T…Z"
  },
  "results": [
    {
      "arm": "gsa",
      "category": "Automotive — OEM",
      "host": "automobiles.honda.com",
      "url": "https://automobiles.honda.com",
      "finalUrl": "https://automobiles.honda.com",
      "status": 403,
      "vendor": "Akamai",
      "abck": "passed",                 // no-_abck | passed | challenged | present
      "edgeIp": "23.x.x.x",
      "reference": "Reference #18.…",   // CDN trace id (failed rows)
      "wafHeaders": { "akamai-grn": "…" },
      "headers": { "server": "AkamaiGHost", … },   // curated; cookie NAMES only
      "redirectChain": [{ "url": "…", "status": 301, "ms": 42 }, …],
      "attempts": 1,
      "attemptLog": [{ "n": 1, "status": 403, "verdict": "IP_REPUTATION", "reason": "IP_REPUTATION", "ms": null }],
      "passSummary": "FAILED_ONCE",
      "errorLayer": "",
      "reason": "IP_REPUTATION",
      "verdict": "IP_REPUTATION",
      "screenshot": "shots/automotive-oem/IP_REPUTATION/automobiles-honda-com.png"
    }
  ]
}
```

`results-catalog.json` is a legacy flat array of `results` (last arm written); the report ignores it when `results-<arm>.json` files exist.

---

## The report

- **Comparison Matrix** tab — for every site whose verdict is **not** identical across all probed paths, a `Site | Direct | GSA | … | Confidence` grid. Path-specific (e.g. GSA-only) blocks stand out at a glance.
- **Confidence** column — a 5–99% score with the contributing factors on hover.
- **Redirect chain** — each hop's status, `Location`, protocol and per-hop timing, so you can see *where* in the chain a failure occurred.
- **Header diff** — on dual-arm runs, the headers that changed between the `direct` baseline and the path under test. Only header **names** are stored for cookies — never values — so the report stays shareable.
- **Filters & export** — combinable verdict / vendor / status filters, click-to-sort columns, and an Excel export of the filtered view.

---

## Supported environments

| | |
|---|---|
| **Node.js** | 18, 20, 22 (CI-tested) |
| **OS** | Windows, macOS, Linux |
| **Browsers** | Microsoft Edge (`msedge`, default), Chrome, or bundled Chromium |
| **Network** | Outbound 443 (the egress IP/ASN capture calls `ipinfo.io`, falling back to `ipify.org`) |

---

## Limitations

- Results reflect **the egress IP/ASN you ran from at that moment**. CDN reputation is dynamic; re-run to confirm a finding.
- The catalog is a **best-effort** curated list of real domains; some entries may move, redirect, or retire over time.
- A high `--concurrency` from a single IP can **manufacture** rate-limit blocks. The default of 4 is deliberate.
- This tool detects and *attributes* blocks; it does **not** attempt to bypass bot defenses.
- Headless detection is mitigated with stealth + real Edge, but cannot be guaranteed against every vendor.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `checkwebhealth: command not found` | Use `npx checkwebhealth …`, or `npm install -g checkwebhealth`. |
| `Cannot find module 'playwright'` | `npm install` (from a clone) — then `checkwebhealth doctor`. |
| `browserType.launch: Executable doesn't exist` | `npx playwright install chromium msedge`. |
| Linux: launch fails on missing `.so` libs | `sudo npx playwright install-deps chromium`. |
| Many `ERROR` rows | Check the `layer:` tag (DNS/TLS/TCP = network path, not WAF). Raise `--nav-timeout`, re-run. |
| Corporate proxy blocks the browser download | Set `HTTPS_PROXY`/`HTTP_PROXY`, or pre-stage the Playwright browser cache. |

Run `checkwebhealth doctor` first — it pinpoints which prerequisite is missing.

---

## FAQ

**Is a `403` proof that GSA is broken?**
No — that's the whole point. Only `NETWORK-CAUSED` (OK direct, fails on GSA) and a **headed-confirmed** `IP_REPUTATION` (`_abck` passed but a `403`/`451` denial that survives `checkwebhealth validate`) are defensible. A `403` on *both* arms is the site blocking everyone, not the network — and a headless-only block is often just the automation being detected (run `validate` to rule it out).

**A site shows a "slide to verify" / "press & hold" challenge over GSA — is that an IP block?**
Usually not a *hard* block. It's an interactive challenge (PerimeterX/HUMAN, DataDome, Cloudflare) classified as `HUMAN_CHALLENGE`. On shared GSA egress IPs it often cites *"a robot on the same network (IP …) as you"* — i.e. **shared egress-IP reputation**. A human solves the slider and proceeds; the right escalation is the egress IP/ASN reputation, not a hard-block claim.

**Why is a `401`/login redirect not a block?**
That's expected authentication. It's classified as `AUTH_REQUIRED` and never counted as a network/WAF failure.

**Do I have to probe all 2,500 sites?**
No — `checkwebhealth sample` hits 10 random categories for a quick read. Use `--seed` to make a sample reproducible across machines.

**Does it bypass bot protection?**
No. It diagnoses and attributes blocks; it does not defeat them.

**Can I add more network paths than direct/gsa?**
Yes — add a `paths` entry (e.g. `azure-vm`), probe with `--arm azure-vm`, and it appears in the Comparison Matrix automatically.

---

## Security & privacy

- Probe output (`results-*.json`, `.har`) can contain cookies, edge IPs and tokens. `.gitignore` excludes `checkwebhealth-results/`, `har/` / `*.har`, and `node_modules/` so they are **never committed**.
- The HTML report is self-contained and safe to email/share (cookie *values* are never stored — only names). Treat the raw `results-*.json` as sensitive if it leaves the machine.
- **Manual Browser Parity** never reads or records cookie/token **values** — only names and counts. The `parity-report.json` / `.html` are safe to share. Exported `.har` files are **sanitised** (cookie/authorization headers and request/response bodies stripped). When the real Edge profile is locked, a **copied** diagnostic profile is used (caches excluded) and removed after the run.
- Parity mode is a diagnostics aid (browser parity), **not** stealth or anti-bot bypass: it does not hide automation or attempt to defeat a site's protections.
- See [SECURITY.md](SECURITY.md) to report a vulnerability.

---

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). The detection logic in `probe-core.mjs` and the A/B Direct-vs-GSA methodology are intentionally stable; bug fixes are welcome, redesigns need an issue first. Run `npm test` before pushing.

---

## License

[MIT](LICENSE) © Microsoft / contributors.

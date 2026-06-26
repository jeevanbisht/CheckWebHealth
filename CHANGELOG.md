# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [Unreleased] - 2026-06-25

### Added

- Added a **`checkwebhealth validate`** command (headed re-validation pass): re-probes the automation-suspect rows of an existing run (`IP_REPUTATION` by default; add `--include-blocked` for `BLOCKED`/challenges) using a **headed** real-Edge profile. A headless probe cannot tell egress-IP/ASN reputation apart from headless-bot detection (Akamai/Cloudflare block headless on any IP), so suspects that load fine headed are promoted to `OK` (`automationFalsePositive: true`) while those still denied headed are kept and marked `headedConfirmed: true` — making the surviving `IP_REPUTATION` verdicts defensible. Rows record `headlessVerdict`/`headedVerdict`/`headedStatus`. Re-render with `report` to refresh the verdicts and NETWORK-CAUSED delta.
- Added a **`--parity`** flag for `probe`/`sample` (env `PROBE_PARITY`): runs the A/B arm through **manual-parity Edge** (your real profile's cookies/session via a safe **copied** diagnostic profile, no stealth, honest `navigator.webdriver`) instead of the default temp-profile stealth engine. This combines the network-path dimension (`--arm direct`/`gsa`) with the browser-posture dimension. Opt-in only — the default A/B behaviour is unchanged. The catalog report's per-arm line shows `mode=manual-parity profile=copied`.
- Added **Manual Browser Parity Mode** (`checkwebhealth parity <url>`): runs a target through a temporary-profile automated Edge and a headed real-profile (persistent) Edge to distinguish a real network/site failure from a failure caused by the diagnostic browser environment. Emits `parity-report.json` + `parity-report.html`.
- Added the `AUTOMATION_OR_BROWSER_POSTURE` classification with sub-reasons `TEMP_PROFILE_USED`, `MISSING_COOKIES`, `BROWSER_VERSION_MISMATCH`, `HEADLESS_MODE`, `PROFILE_NOT_LOADED`, `SCRIPT_OR_RESOURCE_FAILURE`, `CLIENT_POSTURE_POLICY`, and `SITE_REJECTS_AUTOMATED_BROWSER` (plus `NETWORK_OR_SITE_FAILURE` / `NO_FAILURE_REPRODUCED`).
- Added a nested `browser` config block (`mode`, `channel`, `headless`, `usePersistentProfile`, `userDataDir`, `profileDirectory`, `viewport`, `locale`, `timezone`, `useSystemProxy`) with `--mode`, `--url`, `--profile-directory`, `--user-data-dir`, and `--manual-fails` flags.
- Extended `checkwebhealth doctor` with a browser-parity preflight: Edge installed + version, selected profile found, profile lock status, headless status, system proxy, automation detectability, cookies available, and recommended fixes.
- Added a safe **copied diagnostic profile** fallback when the real Edge profile is locked (caches/lock files excluded; cleaned up after the run), plus HAR sanitisation that strips cookie/authorization headers and request/response bodies. Parity mode never records cookie/token values (names/counts only) and is **not** stealth/anti-bot bypass.
- Added the `checkwebhealth` CLI entry point with `probe`, `sample`, `report`, `evidence`, `doctor`, `init`, `config`, and `version` subcommands.
- Added CLI flags including `--arm`, `--concurrency`, `--headed`, `--output`, and `--json` for scriptable local and CI usage.
- Added npm-publish packaging metadata for the package `bin`, ESM `exports`, and published `files` surface.
- Added community health files for contributing, security reporting, code of conduct, issue forms, pull request template, funding metadata, and changelog tracking.
- Added a release-driven npm publish workflow for tagged GitHub Releases.
- Added a report **Diagnostics** panel summarizing failed network layers (DNS/TCP/TLS/TIMEOUT/HTTP) and median response time.

### Changed

- Reorganized the source tree into `src/{core,probe,report,cli,utils}` for clearer separation; the engine and A/B detection logic are unchanged.
- Renamed the default output directory from `akamai-probe-results/` to `checkwebhealth-results/` (override with `--output` / `OUT_DIR`).

### Fixed

- `classify()` no longer labels a **`200`** response `IP_REPUTATION` when only the body contains denial text ("Access Denied"/"Reference #"): the `IP_REPUTATION` verdict is now gated on an actual blocking HTTP status (401/403/429/…), so a soft/edge `200` page falls through to `BLOCKED`. Combined with the new headed `validate` pass, this stops headless-automation blocks from being mis-attributed to egress-IP reputation.
- Ensured report and evidence steps honor `OUT_DIR` so generated reports, screenshots, and HAR evidence stay in the configured output directory.
- The `report` command now prints a clear, actionable message (instead of a stack trace) when run before any probe has produced results.

## [1.0.0] - 2026-06-25

### Added

- Initial probe engine for driving Microsoft Edge or Chromium with Playwright across the site catalog.
- A/B Direct-vs-GSA methodology for identifying network-caused CDN/WAF blocking.
- Verdict and reason taxonomy for OK, authentication-required, bot challenge, human challenge, IP reputation, blocked, and error outcomes.
- Self-contained HTML report with category tabs, summaries, filters, evidence links, and export-friendly output.
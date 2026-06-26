# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [Unreleased] - 2026-06-25

### Added

- Added the `checkwebhealth` CLI entry point with `probe`, `sample`, `report`, `evidence`, `doctor`, `init`, `config`, and `version` subcommands.
- Added CLI flags including `--arm`, `--concurrency`, `--headed`, `--output`, and `--json` for scriptable local and CI usage.
- Added npm-publish packaging metadata for the package `bin`, ESM `exports`, and published `files` surface.
- Added community health files for contributing, security reporting, code of conduct, issue forms, pull request template, funding metadata, and changelog tracking.
- Added a release-driven npm publish workflow for tagged GitHub Releases.

### Fixed

- Ensured report and evidence steps honor `OUT_DIR` so generated reports, screenshots, and HAR evidence stay in the configured output directory.

## [1.0.0] - 2026-06-25

### Added

- Initial probe engine for driving Microsoft Edge or Chromium with Playwright across the site catalog.
- A/B Direct-vs-GSA methodology for identifying network-caused CDN/WAF blocking.
- Verdict and reason taxonomy for OK, authentication-required, bot challenge, human challenge, IP reputation, blocked, and error outcomes.
- Self-contained HTML report with category tabs, summaries, filters, evidence links, and export-friendly output.
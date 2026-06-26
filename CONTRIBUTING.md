# Contributing to CheckWebHealth

Thanks for helping improve CheckWebHealth. This project is an enterprise-oriented CLI for probing real websites with a real browser and comparing direct internet behavior against Microsoft Global Secure Access (GSA).

## Development setup

Requirements:

- Node.js 18 or newer
- npm
- Microsoft Edge or Playwright-managed browser binaries

Install dependencies and browsers:

```bash
npm install
npx playwright install chromium msedge
```

## Running tests

Run the unit tests before opening a pull request:

```bash
npm test
```

## Running the CLI locally

Use the local CLI entry point while developing:

```bash
node bin/checkwebhealth.mjs <command>
```

Common commands include `probe`, `sample`, `report`, `evidence`, `doctor`, `init`, `config`, and `version`. Keep probe concurrency modest unless you are intentionally testing rate limits; excessive parallelism can create false positives from CDN/WAF reputation systems.

## Coding conventions

- Use ESM and `.mjs` modules.
- Prefer small, pure functions for classification, parsing, and report transforms.
- Keep side effects at the CLI, filesystem, or Playwright boundary.
- Do not add new runtime dependencies without opening an issue or discussion first.
- Preserve the existing detection/verdict logic and output taxonomy unless the change is a clearly scoped bug fix.
- Never commit raw probe output, screenshots, HAR files, cookies, tokens, or other customer/site evidence.

The detection logic in `src/core/probe-core.mjs` - especially `classify`, `deriveReason`, and the verdict taxonomy - is central to the tool's defensibility. The A/B Direct-vs-GSA methodology must also be preserved: run the same probe through a direct baseline and a GSA arm, then compare them to identify `NETWORK-CAUSED` blocks. Bug fixes are welcome; redesigns to this logic need an issue first with rationale and examples.

## Commit messages

Use Conventional Commits:

- `feat: add config doctor command`
- `fix: preserve OUT_DIR for evidence capture`
- `docs: clarify A/B probe workflow`
- `test: cover Cloudflare challenge detection`

## Branch naming

Use short, lowercase branch names with a type prefix, for example:

- `feature/add-probe-flag`
- `fix/out-dir-report`
- `docs/community-health`
- `test/verdict-taxonomy`

## Pull request process

1. Open or reference an issue for user-visible behavior changes, detection changes, or larger redesigns.
2. Keep the PR focused and explain how it affects the Direct-vs-GSA workflow.
3. Add or update tests when behavior changes.
4. Update documentation and `CHANGELOG.md` for user-facing changes.
5. Confirm `npm test` passes.
6. Confirm no sensitive probe artifacts are committed.

A maintainer will review for correctness, detection fidelity, security/privacy handling, and compatibility with the CLI packaging model.
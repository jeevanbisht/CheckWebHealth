// cli.test.mjs — unit tests for the CLI surface: arg parsing, input validation
// and config resolution. Pure functions only; no browser or network.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../src/cli/args.mjs";
import { isValidHost, normalizeHost, oneOf } from "../src/utils/validate.mjs";
import { applyEnv } from "../src/cli/run.mjs";
import { loadConfig, DEFAULTS } from "../src/core/config.mjs";

// ---- arg parser ------------------------------------------------------------
test("parseArgs reads a bare command", () => {
  const { command, errors } = parseArgs(["doctor"]);
  assert.equal(command, "doctor");
  assert.deepEqual(errors, []);
});

test("parseArgs: --flag value, --flag=value and -alias all work", () => {
  const a = parseArgs(["probe", "--arm", "gsa", "--concurrency", "8"]);
  assert.equal(a.options.arm, "gsa");
  assert.equal(a.options.concurrency, 8);
  const b = parseArgs(["probe", "--arm=direct", "-c=2"]);
  assert.equal(b.options.arm, "direct");
  assert.equal(b.options.concurrency, 2);
  const c = parseArgs(["probe", "-c", "4"]);
  assert.equal(c.options.concurrency, 4);
});

test("parseArgs: boolean flags and --no- negation", () => {
  assert.equal(parseArgs(["sample", "--headed"]).options.headed, true);
  assert.equal(parseArgs(["sample", "--no-headed"]).options.headed, false);
  assert.equal(parseArgs(["sample", "--headed=false"]).options.headed, false);
});

test("parseArgs: numeric flag with non-number is an error", () => {
  const { errors } = parseArgs(["probe", "--concurrency", "abc"]);
  assert.ok(errors.some((e) => /number/.test(e)));
});

test("parseArgs: unknown option is an error", () => {
  const { errors } = parseArgs(["probe", "--nope"]);
  assert.ok(errors.some((e) => /Unknown option/.test(e)));
});

test("parseArgs: value flag missing its value is an error", () => {
  const { errors } = parseArgs(["probe", "--arm"]);
  assert.ok(errors.some((e) => /expects a value/.test(e)));
});

test("parseArgs: option used with the wrong command is rejected", () => {
  const { errors } = parseArgs(["report", "--arm", "gsa"]);
  assert.ok(errors.some((e) => /not valid for "report"/.test(e)));
});

test("parseArgs: unknown command is an error", () => {
  const { errors } = parseArgs(["frobnicate"]);
  assert.ok(errors.some((e) => /Unknown command/.test(e)));
});

test("parseArgs: --help / --version normalise to a command when bare", () => {
  assert.equal(parseArgs(["--help"]).command, "help");
  assert.equal(parseArgs(["--version"]).command, "version");
});

// ---- host validation -------------------------------------------------------
test("normalizeHost strips scheme, path, query, port and case", () => {
  assert.equal(normalizeHost("HTTPS://Example.com/foo?bar=1"), "example.com");
  assert.equal(normalizeHost("http://user:pass@sub.example.co.uk:8443/x"), "sub.example.co.uk");
  assert.equal(normalizeHost("  Honda.com  "), "honda.com");
});

test("isValidHost accepts real domains and rejects junk", () => {
  for (const h of ["honda.com", "automobiles.honda.com", "toyota.co.jp", "a-b.example.com"]) {
    assert.equal(isValidHost(h), true, h);
  }
  for (const h of ["", "localhost", "no-tld", "-bad.com", "bad_underscore.com", "http://", "exa mple.com"]) {
    assert.equal(isValidHost(h), false, h);
  }
});

test("oneOf returns the value when allowed, else the fallback", () => {
  assert.equal(oneOf("chromium", ["msedge", "chromium"], "msedge"), "chromium");
  assert.equal(oneOf("nope", ["msedge", "chromium"], "msedge"), "msedge");
});

// ---- env bridge ------------------------------------------------------------
test("applyEnv maps resolved options onto the proven env var names", () => {
  const env = {};
  applyEnv({ arm: "gsa", concurrency: 8, headed: true, seed: 42 }, env);
  assert.equal(env.PROBE_ARM, "gsa");
  assert.equal(env.CONC, "8");
  assert.equal(env.PROBE_HEADED, "1");
  assert.equal(env.SEED, "42");
});

// ---- config resolution -----------------------------------------------------
test("loadConfig: explicit overrides win over env", () => {
  const cfg = loadConfig({ PROBE_ARM: "gsa", CONC: "4" }, "does-not-exist.json", { arm: "direct", concurrency: 9 });
  assert.equal(cfg.arm, "direct");
  assert.equal(cfg.concurrency, 9);
});

test("loadConfig clamps navTimeout and settleMs to sane minimums", () => {
  const cfg = loadConfig({ NAV_TIMEOUT: "10", SETTLE_MS: "-5" }, "does-not-exist.json");
  assert.equal(cfg.navTimeout, 1000);
  assert.equal(cfg.settleMs, 0);
});

test("loadConfig constrains channel and shots to known values", () => {
  const cfg = loadConfig({ PROBE_CHANNEL: "lynx", SHOTS_MODE: "everything" }, "does-not-exist.json");
  assert.equal(cfg.channel, DEFAULTS.channel);
  assert.equal(cfg.shots, DEFAULTS.shots);
});

test("loadConfig: SHOTS_MODE sets a valid screenshot mode", () => {
  assert.equal(loadConfig({ SHOTS_MODE: "all" }, "does-not-exist.json").shots, "all");
  assert.equal(loadConfig({ SHOTS_MODE: "none" }, "does-not-exist.json").shots, "none");
});

test("loadConfig: empty arm falls back to the default", () => {
  assert.equal(loadConfig({ PROBE_ARM: "" }, "does-not-exist.json").arm, DEFAULTS.arm);
});

test("loadConfig: parityProbe defaults off and is opt-in via PROBE_PARITY/flag", () => {
  assert.equal(loadConfig({}, "does-not-exist.json").parityProbe, false);
  assert.equal(loadConfig({ PROBE_PARITY: "1" }, "does-not-exist.json").parityProbe, true);
  // explicit override (resolved --parity flag) wins
  assert.equal(loadConfig({}, "does-not-exist.json", { parityProbe: true }).parityProbe, true);
  // a loosely-typed file value is coerced
  assert.equal(loadConfig({}, "does-not-exist.json", { parityProbe: "0" }).parityProbe, false);
});

test("applyEnv maps --parity onto PROBE_PARITY", () => {
  const env = {};
  applyEnv({ parity: true }, env);
  assert.equal(env.PROBE_PARITY, "1");
});

// config.mjs — single source of truth for run configuration.
// Precedence (lowest → highest): built-in DEFAULTS → probe.config.json (if present)
// → environment variables. Everything the orchestrators need lives here so the
// per-script `process.env` reads stay in one place and are easy to test.
//
// loadConfig() is pure: pass an explicit env object and/or config file path to
// exercise it deterministically from unit tests.
import { readFileSync, existsSync } from "node:fs";

export const DEFAULTS = {
  // Declarative list of network paths to compare. Each entry tags an output
  // file results-<id>.json. The run's own arm is config.arm; the rest are the
  // paths the report will line up into a comparison matrix.
  paths: [
    { id: "direct", label: "Direct Internet" },
    { id: "gsa", label: "Microsoft GSA" },
  ],
  arm: "gsa", // which path THIS run is exercising (PROBE_ARM)
  seed: null, // fixed RNG seed for the sample probe (SEED); null => Date.now(). Share a seed across machines so each arm probes the SAME random sites and the A/B delta lines up.
  concurrency: 4, // parallel browser contexts
  retries: 2, // max attempts per site
  navTimeout: 25000, // ms per navigation
  settleMs: 2500, // ms to let the page settle before reading state
  channel: "msedge", // browser channel (msedge|chrome|chromium)
  headed: false, // headed (visible) run
  shots: "fail", // screenshot mode: all|fail|none
  har: false, // export a true per-host .har on the evidence pass
  evidence: true, // capture console + network log on failures
  outDir: "akamai-probe-results/catalog",
};

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Merge DEFAULTS ← config file ← environment. `env` and `file` are injectable
// for testing. Returns a fully-populated config object.
export function loadConfig(env = process.env, file = "probe.config.json") {
  let fileCfg = {};
  if (file && existsSync(file)) {
    try { fileCfg = JSON.parse(readFileSync(file, "utf8")); } catch { fileCfg = {}; }
  }
  const cfg = { ...DEFAULTS, ...fileCfg };
  // Environment variables win (operational overrides).
  if (env.PROBE_ARM) cfg.arm = env.PROBE_ARM;
  if (env.SEED != null && env.SEED !== "") cfg.seed = num(env.SEED, cfg.seed);
  if (env.CONC != null) cfg.concurrency = num(env.CONC, cfg.concurrency);
  if (env.PROBE_RETRIES != null) cfg.retries = num(env.PROBE_RETRIES, cfg.retries);
  if (env.NAV_TIMEOUT != null) cfg.navTimeout = num(env.NAV_TIMEOUT, cfg.navTimeout);
  if (env.SETTLE_MS != null) cfg.settleMs = num(env.SETTLE_MS, cfg.settleMs);
  if (env.PROBE_CHANNEL) cfg.channel = env.PROBE_CHANNEL;
  if (env.PROBE_HEADED === "1") cfg.headed = true;
  if (env.SHOTS === "1") cfg.shots = "all";
  if (env.HAR === "1") cfg.har = true;
  if (env.OUT_DIR) cfg.outDir = env.OUT_DIR;
  // Normalise: clamp obviously bad values.
  cfg.concurrency = Math.max(1, cfg.concurrency);
  cfg.retries = Math.max(1, cfg.retries);
  return cfg;
}

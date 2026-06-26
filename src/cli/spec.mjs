// spec.mjs — declarative CLI surface (commands + options).
// Kept data-only so the parser, the help text and the env-bridge all read from
// one source of truth. `env` is the existing process.env name a flag maps to,
// so CLI flags reuse the proven config.mjs precedence (env > file > defaults).

export const COMMANDS = {
  probe: "Run the full catalog probe (tag the arm with --arm).",
  sample: "Run a quick sample probe (random categories; --seed for parity).",
  report: "Build the HTML report from existing results.",
  evidence: "Re-screenshot the non-OK rows of an existing run.",
  parity: "Manual Browser Parity: compare real-Edge profile vs a temp automated profile.",
  doctor: "Check the environment is ready (Node, Playwright, browser, network).",
  init: "Write a starter probe.config.json.",
  config: "Print the effective, resolved configuration.",
  version: "Print the installed version.",
  help: "Show help for the CLI or a command.",
};

// type: string | number | boolean
// env:  the process.env key this flag maps onto (consumed by config.mjs)
// only: restrict an option to specific commands (omit = global)
export const OPTIONS = {
  arm: { type: "string", env: "PROBE_ARM", only: ["probe", "sample", "evidence"], desc: "Path id this run exercises (e.g. direct, gsa)." },
  concurrency: { type: "number", alias: "c", env: "CONC", only: ["probe"], desc: "Parallel browser contexts (kept modest on purpose)." },
  retries: { type: "number", env: "PROBE_RETRIES", only: ["probe", "sample"], desc: "Max attempts per site (transient 429/503 are retried)." },
  "nav-timeout": { type: "number", env: "NAV_TIMEOUT", only: ["probe", "sample"], desc: "Per-navigation timeout in ms." },
  settle: { type: "number", env: "SETTLE_MS", only: ["probe", "sample"], desc: "Settle time before reading page state, in ms." },
  channel: { type: "string", env: "PROBE_CHANNEL", only: ["probe", "sample", "evidence", "parity"], desc: "Browser channel: msedge | chrome | chromium." },
  headed: { type: "boolean", env: "PROBE_HEADED", only: ["probe", "sample", "evidence", "parity"], desc: "Run headed (visible) for best forensic fidelity." },
  "parity": { type: "boolean", env: "PROBE_PARITY", only: ["probe", "sample"], desc: "Run this arm through manual-parity Edge (your real profile via a safe copy; no stealth)." },
  shots: { type: "string", env: "SHOTS_MODE", only: ["probe"], desc: "Screenshot mode: all | fail | none." },
  seed: { type: "number", env: "SEED", only: ["sample"], desc: "Fixed RNG seed so two machines pick the same sites." },
  har: { type: "boolean", env: "HAR", only: ["evidence"], desc: "Export a per-host .har for each failed row." },
  // Manual Browser Parity Mode
  url: { type: "string", only: ["parity"], desc: "Target URL to compare (default https://www.bing.com)." },
  mode: { type: "string", env: "BROWSER_MODE", only: ["parity"], desc: "Browser mode: manual-parity | automated." },
  "profile-directory": { type: "string", env: "PROFILE_DIRECTORY", only: ["parity", "doctor"], desc: "Edge profile dir: Default | \"Profile 1\" | custom." },
  "user-data-dir": { type: "string", env: "USER_DATA_DIR", only: ["parity", "doctor"], desc: "Edge User Data dir (default: the OS default)." },
  "manual-fails": { type: "boolean", only: ["parity"], desc: "Record that manual Edge also fails (real network/site failure)." },
  output: { type: "string", alias: "o", env: "OUT_DIR", desc: "Output directory for results, screenshots and the report." },
  open: { type: "boolean", only: ["report", "parity"], desc: "Open the report in the default browser when done." },
  json: { type: "boolean", desc: "Emit machine-readable JSON instead of human text." },
  verbose: { type: "boolean", alias: "v", desc: "Verbose output." },
  help: { type: "boolean", alias: "h", desc: "Show help." },
  version: { type: "boolean", desc: "Print version." },
};

// Build alias -> canonical-name and a quick type lookup once.
export const ALIASES = Object.fromEntries(
  Object.entries(OPTIONS).filter(([, o]) => o.alias).map(([name, o]) => [o.alias, name])
);

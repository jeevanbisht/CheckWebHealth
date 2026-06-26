// run.mjs — bridge from parsed CLI options to the proven probe/report scripts.
// Rather than fork the battle-tested entry scripts, the CLI maps flags onto the
// exact env vars config.mjs already understands, then imports the script in-
// process. This keeps the detection logic and A/B methodology untouched while
// giving a clean, cross-platform flag UX (no PowerShell $env: gymnastics).
import { OPTIONS } from "./spec.mjs";

const SCRIPTS = {
  probe: "../probe/probe-catalog.mjs",
  sample: "../probe/probe-sample.mjs",
  report: "../report/render-catalog-html.mjs",
  evidence: "../probe/probe-evidence.mjs",
  validate: "../probe/probe-validate.mjs",
};

// Translate resolved CLI options to process.env keys (mutates `env`).
export function applyEnv(options, env = process.env) {
  for (const [name, val] of Object.entries(options)) {
    const spec = OPTIONS[name];
    if (!spec || !spec.env || val === undefined) continue;
    env[spec.env] = spec.type === "boolean" ? (val ? "1" : "0") : String(val);
  }
  return env;
}

// Apply flags, then run the script for `command` in-process.
export async function runScript(command, options = {}) {
  const rel = SCRIPTS[command];
  if (!rel) throw new Error(`No script bound to command "${command}"`);
  applyEnv(options);
  await import(new URL(rel, import.meta.url));
}

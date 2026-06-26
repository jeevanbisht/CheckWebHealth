// index.mjs — CLI entry point: parse argv, dispatch to a command, return an
// exit code. Kept thin; each command lives in ./commands or is bridged to a
// proven probe/report script via ./run.mjs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "./args.mjs";
import { topHelp, commandHelp } from "./help.mjs";
import { COMMANDS } from "./spec.mjs";
import { runScript } from "./run.mjs";
import { doctor } from "./commands/doctor.mjs";
import { init } from "./commands/init.mjs";
import { showConfig } from "./commands/config.mjs";
import { parity } from "./commands/parity.mjs";
import { loadConfig } from "../core/config.mjs";

function pkgVersion() {
  try { return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version; }
  catch { return "0.0.0"; }
}

// Resolved CLI flags -> canonical config keys (for config/report/open).
const OVERRIDE_MAP = {
  concurrency: "concurrency", retries: "retries", "nav-timeout": "navTimeout",
  settle: "settleMs", channel: "channel", headed: "headed", shots: "shots",
  seed: "seed", arm: "arm", output: "outDir",
};
function toOverrides(options) {
  const out = {};
  for (const [flag, key] of Object.entries(OVERRIDE_MAP)) if (options[flag] !== undefined) out[key] = options[flag];
  return out;
}

function openPath(target) {
  const platform = process.platform;
  const [cmd, args] = platform === "win32" ? ["cmd", ["/c", "start", "", target]]
    : platform === "darwin" ? ["open", [target]]
    : ["xdg-open", [target]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* best effort */ }
}

export async function main(argv = []) {
  const { command, options, positionals, errors } = parseArgs(argv);

  // version (flag or command) short-circuits everything.
  if (options.version || command === "version") {
    process.stdout.write(options.json ? JSON.stringify({ version: pkgVersion() }) + "\n" : pkgVersion() + "\n");
    return 0;
  }

  // Parse errors are fatal and actionable.
  if (errors.length) {
    for (const e of errors) process.stderr.write(`error: ${e}\n`);
    process.stderr.write(`\nRun "checkwebhealth help" for usage.\n`);
    return 2;
  }

  // help / no command.
  if (!command || command === "help") {
    const sub = positionals[0];
    process.stdout.write((sub && COMMANDS[sub] ? commandHelp(sub) : topHelp()) + "\n");
    return 0;
  }
  if (options.help) { process.stdout.write(commandHelp(command) + "\n"); return 0; }

  switch (command) {
    case "doctor": return doctor(options);
    case "init": return init(options);
    case "config": return showConfig(options, toOverrides(options));
    case "parity": {
      try {
        return await parity(options, positionals);
      } catch (e) {
        process.stderr.write(`\nerror: parity failed: ${(e.message || e).toString().split("\n")[0]}\n`);
        process.stderr.write(`hint: run "checkwebhealth doctor" to check Edge, the profile and automation posture.\n`);
        return 1;
      }
    }
    case "probe":
    case "sample":
    case "evidence":
    case "report": {
      try {
        await runScript(command, options);
      } catch (e) {
        process.stderr.write(`\nerror: ${command} failed: ${(e.message || e).toString().split("\n")[0]}\n`);
        process.stderr.write(`hint: run "checkwebhealth doctor" to check Node, Playwright, browser and network.\n`);
        return 1;
      }
      if (command === "report" && options.open) {
        const cfg = loadConfig(process.env, "probe.config.json", toOverrides(options));
        openPath(join(cfg.outDir, "report-catalog.html"));
      }
      return 0;
    }
    default:
      process.stderr.write(`error: unknown command "${command}".\n`);
      return 2;
  }
}

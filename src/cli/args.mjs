// args.mjs — a tiny, dependency-free argument parser for the CLI.
// Pure and deterministic so it can be unit-tested without spawning a process.
// Supports:  command  --flag value  --flag=value  -a value  -a=value  --bool
//            --no-bool  (sets a boolean false)
import { OPTIONS, ALIASES, COMMANDS } from "./spec.mjs";

function coerce(name, raw, errors) {
  const spec = OPTIONS[name];
  if (spec.type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) { errors.push(`--${name} expects a number (got "${raw}")`); return undefined; }
    return n;
  }
  return raw;
}

// Parse argv (already sliced past `node script`). Returns:
//   { command, options, positionals, errors }
export function parseArgs(argv = []) {
  const options = {};
  const positionals = [];
  const errors = [];
  let command = null;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];

    if (tok === "--") { positionals.push(...argv.slice(i + 1)); break; }

    if (tok.startsWith("--") || tok.startsWith("-")) {
      const dbl = tok.startsWith("--");
      let body = tok.slice(dbl ? 2 : 1);
      let inlineVal;
      const eq = body.indexOf("=");
      if (eq !== -1) { inlineVal = body.slice(eq + 1); body = body.slice(0, eq); }

      // --no-foo => boolean false
      let negate = false;
      if (dbl && body.startsWith("no-")) { negate = true; body = body.slice(3); }

      const name = dbl ? body : (ALIASES[body] || body);
      const spec = OPTIONS[name];
      if (!spec) { errors.push(`Unknown option: ${tok}`); continue; }

      if (spec.type === "boolean") {
        if (inlineVal !== undefined) options[name] = inlineVal !== "false" && inlineVal !== "0";
        else options[name] = !negate;
        continue;
      }

      // value option
      let raw = inlineVal;
      if (raw === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith("-") && next !== "-")) {
          errors.push(`--${name} expects a value`);
          continue;
        }
        raw = next; i++;
      }
      const val = coerce(name, raw, errors);
      if (val !== undefined) options[name] = val;
      continue;
    }

    // positional
    if (command === null) command = tok;
    else positionals.push(tok);
  }

  // Normalise help/version flags into the command.
  if (options.help && !command) command = "help";
  if (options.version && !command) command = "version";

  if (command && !COMMANDS[command]) {
    errors.push(`Unknown command: ${command}. Run "checkwebhealth help".`);
  }

  // Flag/command compatibility: warn-as-error when an option is used with a
  // command it does not apply to (catches typos like `report --arm gsa`).
  // `config` and `help` are introspection commands and accept any option.
  const checkCompat = command && COMMANDS[command] && command !== "config" && command !== "help";
  if (checkCompat) {
    for (const name of Object.keys(options)) {
      const only = OPTIONS[name].only;
      if (only && !only.includes(command)) {
        errors.push(`--${name} is not valid for "${command}" (only: ${only.join(", ")})`);
      }
    }
  }

  return { command, options, positionals, errors };
}

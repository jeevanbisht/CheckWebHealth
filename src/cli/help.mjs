// help.mjs — renders top-level and per-command help from the spec.
import { COMMANDS, OPTIONS } from "./spec.mjs";

const BIN = "checkwebhealth";

function optLine(name) {
  const o = OPTIONS[name];
  const flag = (o.alias ? `-${o.alias}, ` : "    ") + `--${name}` + (o.type === "boolean" ? "" : ` <${o.type}>`);
  return `  ${flag.padEnd(26)} ${o.desc || ""}`;
}

function optionsFor(command) {
  return Object.keys(OPTIONS).filter((name) => {
    const only = OPTIONS[name].only;
    if (name === "version") return false;
    return !only || (command && only.includes(command));
  });
}

export function commandHelp(command) {
  const lines = [];
  lines.push(`${BIN} ${command} — ${COMMANDS[command] || ""}`.trim());
  lines.push("");
  lines.push(`Usage: ${BIN} ${command} [options]`);
  const opts = optionsFor(command);
  if (opts.length) {
    lines.push("");
    lines.push("Options:");
    for (const name of opts) lines.push(optLine(name));
  }
  return lines.join("\n");
}

export function topHelp() {
  const lines = [];
  lines.push(`${BIN} — diagnose CDN/WAF bot-blocking across a catalog of sites,`);
  lines.push(`               comparing a direct path against Microsoft GSA (A/B).`);
  lines.push("");
  lines.push(`Usage: ${BIN} <command> [options]`);
  lines.push("");
  lines.push("Commands:");
  for (const [name, desc] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(10)} ${desc}`);
  }
  lines.push("");
  lines.push("Global options:");
  for (const name of ["output", "json", "verbose", "help"]) lines.push(optLine(name));
  lines.push("");
  lines.push("Examples:");
  lines.push(`  ${BIN} doctor`);
  lines.push(`  ${BIN} sample --arm direct --seed 42`);
  lines.push(`  ${BIN} probe --arm gsa --concurrency 4`);
  lines.push(`  ${BIN} report --open`);
  lines.push("");
  lines.push(`Run "${BIN} help <command>" for command-specific options.`);
  return lines.join("\n");
}

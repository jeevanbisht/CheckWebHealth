// init.mjs — scaffold a probe.config.json in the current directory.
import { writeFileSync, existsSync } from "node:fs";

const TEMPLATE = {
  retries: 2,
  concurrency: 4,
  navTimeout: 25000,
  settleMs: 2500,
  channel: "msedge",
  shots: "fail",
  paths: [
    { id: "direct", label: "Direct Internet" },
    { id: "gsa", label: "Microsoft GSA" },
  ],
};

export function init(options = {}) {
  const file = "probe.config.json";
  if (existsSync(file)) {
    process.stdout.write(`${file} already exists — not overwriting.\n`);
    return 1;
  }
  writeFileSync(file, JSON.stringify(TEMPLATE, null, 2) + "\n");
  if (options.json) process.stdout.write(JSON.stringify({ created: file }, null, 2) + "\n");
  else process.stdout.write(`Wrote ${file}. Edit it, then run "checkwebhealth doctor".\n`);
  return 0;
}

// config.mjs (command) — print the effective, resolved configuration so users
// can see exactly what env vars / config file / flags produced.
import { loadConfig } from "../../core/config.mjs";

export function showConfig(options = {}, overrides = {}) {
  const cfg = loadConfig(process.env, "probe.config.json", overrides);
  if (options.json) {
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
  } else {
    process.stdout.write("Effective configuration:\n");
    for (const [k, v] of Object.entries(cfg)) {
      process.stdout.write(`  ${k.padEnd(13)} ${JSON.stringify(v)}\n`);
    }
  }
  return 0;
}

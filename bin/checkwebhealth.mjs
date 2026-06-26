#!/usr/bin/env node
// checkwebhealth — CLI entry point. Thin shim that delegates to src/cli/index.
import { main } from "../src/cli/index.mjs";

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code || 0; })
  .catch((err) => {
    process.stderr.write(`fatal: ${(err && err.stack) || err}\n`);
    process.exitCode = 1;
  });

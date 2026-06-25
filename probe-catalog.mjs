// probe-catalog.mjs — real-browser probe across the full 50-category catalog.
// Uses the shared probe-core engine (real Edge + stealth, egress IP/ASN capture,
// edge-IP + WAF-header capture, retry, IP_REPUTATION verdict, failure-layer).
//
// Run as two arms and diff in the report:
//   PROBE_ARM=direct node probe-catalog.mjs   (off the GSA tunnel = baseline)
//   PROBE_ARM=gsa    node probe-catalog.mjs   (through GSA, default)
//
// Concurrency defaults LOW (4) on purpose: hammering many CDN-fronted sites from
// one egress IP itself trips rate/reputation limits and manufactures false
// blocks. Override with CONC=, but keep it modest for trustworthy results.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG } from "./sites-catalog.mjs";
import { launchBrowser, makeContext, captureEgress, probeOne } from "./probe-core.mjs";

const ARM = process.env.PROBE_ARM || "gsa";
const CONCURRENCY = Number(process.env.CONC || 4);
const OUT_DIR = join("akamai-probe-results", "catalog");
const SHOT_DIR = join(OUT_DIR, "shots");
mkdirSync(SHOT_DIR, { recursive: true });

const SHOTS = process.env.SHOTS === "1"; // "1" = screenshot every site; default = only failures
const SHOT_MODE = SHOTS ? "all" : "fail";

const tasks = [];
for (const [category, hosts] of Object.entries(CATALOG))
  for (const host of hosts) tasks.push({ category, host });

console.log(`Catalog probe arm="${ARM}": ${tasks.length} sites, concurrency ${CONCURRENCY}`);
const t0 = Date.now();
const { browser, meta } = await launchBrowser();
console.log(`Browser: ${meta.channel} headless=${meta.headless} stealth=${meta.stealth}`);

// one stealth context per worker (cookies are domain-scoped so reuse is fine)
const contexts = await Promise.all(
  Array.from({ length: CONCURRENCY }, () => makeContext(browser))
);

const egress = await captureEgress(contexts[0]);
console.log(`Egress: ${egress.ip || "?"} ${egress.org || ""} (${egress.source})`);

function writeOut() {
  const present = results.filter(Boolean);
  const payload = { meta: { arm: ARM, browser: meta, egress, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString() }, results: present };
  writeFileSync(join(OUT_DIR, `results-${ARM}.json`), JSON.stringify(payload, null, 0));
  writeFileSync(join(OUT_DIR, "results-catalog.json"), JSON.stringify(present, null, 0));
}

const results = new Array(tasks.length);
let next = 0, done = 0;
async function worker(wi) {
  const ctx = contexts[wi];
  while (true) {
    const i = next++;
    if (i >= tasks.length) break;
    results[i] = await probeOne(ctx, tasks[i], { arm: ARM, shotMode: SHOT_MODE, outDir: OUT_DIR, shotDir: SHOT_DIR, evidence: true });
    done++;
    await new Promise((res) => setTimeout(res, 200 + Math.floor(Math.random() * 300))); // jitter spacing
    if (done % 25 === 0 || done === tasks.length) {
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  ${done}/${tasks.length}  (${secs}s)  last: ${results[i].verdict} ${results[i].vendor} ${results[i].host}`);
      writeOut();
    }
  }
}
await Promise.all(contexts.map((_, i) => worker(i)));

await Promise.all(contexts.map((c) => c.close().catch(() => {})));
await browser.close();
writeOut();
console.log(`Done. Wrote results-${ARM}.json and results-catalog.json (${tasks.length} sites)`);

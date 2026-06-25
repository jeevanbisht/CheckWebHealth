// probe-sample.mjs — quick A/B-aware sample probe (10 random categories).
// Tags each run with an "arm" (PROBE_ARM=direct|gsa) and records the egress
// IP/ASN, so a direct run and a GSA run can be diffed in the report.
//   PROBE_ARM=direct node probe-sample.mjs   (run off the GSA tunnel)
//   PROBE_ARM=gsa    node probe-sample.mjs   (run through GSA, default)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG } from "./sites-catalog.mjs";
import { launchBrowser, makeContext, captureEgress, probeOne } from "./probe-core.mjs";

const ARM = process.env.PROBE_ARM || "gsa";
const OUT_DIR = join("akamai-probe-results", "catalog");
const SHOT_DIR = join(OUT_DIR, "shots");
mkdirSync(SHOT_DIR, { recursive: true });

const seed = Date.now();
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);
const shuffledCats = Object.keys(CATALOG)
  .map((category) => ({ category, sort: rand() }))
  .sort((a, b) => a.sort - b.sort)
  .map((x) => x.category)
  .slice(0, 10);
const tasks = shuffledCats.map((category) => {
  const sites = CATALOG[category];
  const host = sites[Math.floor(rand() * sites.length)];
  return { category, host };
});

console.log(`Sample probe arm="${ARM}" seed ${seed} — 10 sites / 10 categories`);
for (const t of tasks) console.log(`- ${t.category}: ${t.host}`);

const { browser, meta } = await launchBrowser();
console.log(`Browser: ${meta.channel} headless=${meta.headless} stealth=${meta.stealth}`);
const ctx = await makeContext(browser);

const egress = await captureEgress(ctx);
console.log(`Egress: ${egress.ip || "?"} ${egress.org || ""} (${egress.source})`);

const results = [];
for (const task of tasks) {
  const r = await probeOne(ctx, task, { arm: ARM, shotMode: "all", outDir: OUT_DIR, shotDir: SHOT_DIR, evidence: true });
  results.push(r);
  console.log(`${r.verdict.padEnd(14)} ${String(r.status).padEnd(5)} ${r.vendor.padEnd(18)} ${r.edgeIp.padEnd(15)} ${r.url}`);
  await new Promise((res) => setTimeout(res, 300 + Math.floor(rand() * 400)));
}

await ctx.close();
await browser.close();

const payload = { meta: { arm: ARM, seed, browser: meta, egress, startedAt: new Date(seed).toISOString(), finishedAt: new Date().toISOString() }, results };
writeFileSync(join(OUT_DIR, `results-${ARM}.json`), JSON.stringify(payload, null, 2));
writeFileSync(join(OUT_DIR, "results-catalog.json"), JSON.stringify(results, null, 2));
console.log(`Wrote results-${ARM}.json and results-catalog.json (${results.length} sites)`);

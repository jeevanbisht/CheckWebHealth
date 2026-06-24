// probe-evidence.mjs — capture screenshots for the non-OK rows of an existing
// run that was probed without screenshots. Re-probes only the failed hosts,
// stores the screenshot under shots/<category>/<verdict>/, and records the
// recheck status/verdict WITHOUT overwriting the original block-time verdict.
//
// Resilient + resumable: saves progress incrementally, relaunches the browser if
// it crashes, and skips rows already captured (re-run to resume).
//   PROBE_ARM=gsa node probe-evidence.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, makeContext, captureEgress, probeOne } from "./probe-core.mjs";

const ARM = process.env.PROBE_ARM || "gsa";
const OUT_DIR = join("akamai-probe-results", "catalog");
const SHOT_DIR = join(OUT_DIR, "shots");
const file = join(OUT_DIR, `results-${ARM}.json`);

const data = JSON.parse(readFileSync(file, "utf8"));
const results = data.results || data;
const todo = results.filter((r) => r.verdict !== "OK" && !r.recheckAt); // resume: skip done
const totalFailed = results.filter((r) => r.verdict !== "OK").length;
console.log(`Evidence pass arm="${ARM}": ${todo.length} of ${totalFailed} non-OK hosts remaining`);

function save() {
  data.meta = data.meta || { arm: ARM };
  data.meta.evidencePass = { at: new Date().toISOString(), count: totalFailed };
  writeFileSync(file, JSON.stringify(data, null, 2));
  writeFileSync(join(OUT_DIR, "results-catalog.json"), JSON.stringify(results, null, 2));
}

let browser, ctx;
async function fresh() {
  try { if (ctx) await ctx.close().catch(() => {}); } catch {}
  try { if (browser) await browser.close().catch(() => {}); } catch {}
  const launched = await launchBrowser();
  browser = launched.browser;
  ctx = await makeContext(browser);
  return launched.meta;
}
const meta = await fresh();
console.log(`Browser: ${meta.channel} headless=${meta.headless}`);
const egress = await captureEgress(ctx);
console.log(`Egress now: ${egress.ip || "?"} ${egress.org || ""}`);

async function probe(row) {
  return probeOne(ctx, { category: row.category, host: row.host }, {
    arm: ARM, shotMode: "all", outDir: OUT_DIR, shotDir: SHOT_DIR,
  });
}

let done = 0;
for (const row of todo) {
  let res;
  try { res = await probe(row); } catch { res = { browserDead: true }; }
  // Browser crashed — relaunch and retry this host once.
  if (res.browserDead || !browser.isConnected()) {
    console.log(`  ! browser died — relaunching at ${row.host}`);
    await fresh();
    try { res = await probe(row); }
    catch { res = { status: "ERR", verdict: "ERROR", screenshot: "", edgeIp: "-", reference: "" }; }
  }
  row.screenshot = res.screenshot || row.screenshot;
  if (res.evidenceShots && res.evidenceShots.length) row.evidenceShots = res.evidenceShots;
  row.recheckStatus = res.status ?? "ERR";
  row.recheckVerdict = res.verdict ?? "ERROR";
  row.recheckAt = new Date().toISOString();
  if (!row.reference && res.reference) row.reference = res.reference;
  if ((!row.edgeIp || row.edgeIp === "-") && res.edgeIp && res.edgeIp !== "-") row.edgeIp = res.edgeIp;
  done++;
  const note = row.recheckVerdict === row.verdict ? "still " + row.verdict : row.verdict + "→" + row.recheckVerdict;
  console.log(`  ${done}/${todo.length}  ${row.host}  (${note})`);
  if (done % 10 === 0) save();
  await new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 350)));
}

await ctx.close().catch(() => {});
await browser.close().catch(() => {});
save();
console.log(`Done. ${done} hosts captured this pass (${totalFailed} total non-OK).`);

// probe-akamai-browser.mjs
// Real-browser Akamai Bot Manager probe (apples-to-apples with a manual repro).
//
// Drives REAL Chromium (genuine desktop fingerprint, JS enabled) so Akamai
// challenges can actually solve. Compares clean baseline (off-GSA) vs. GSA.
//
// USAGE:
//   node probe-akamai-browser.mjs --label baseline      # run OFF-GSA first
//   node probe-akamai-browser.mjs --label gsa           # run ON the GSA machine
//   node probe-akamai-browser.mjs --label gsa --headed  # watch it live
//   node probe-akamai-browser.mjs --label gsa --sites homedepot.com,marriott.com
//
// OUTPUT (per run, under ./akamai-probe-results/<label>/):
//   - results-<label>.json / results-<label>.csv
//   - <host>.png  (screenshot of the final page)
// Then diff baseline vs gsa: any site OK in baseline but BLOCKED in gsa is a
// true Honda-style positive (block tracks the GSA egress IP, not fingerprint).

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---- candidate sites (Akamai-fronted; add your own) ----
const DEFAULT_SITES = [
  "https://automobiles.honda.com/",          // reference case
  "https://automobiles.honda.com/tools/build-and-price",
  "https://www.homedepot.com/",
  "https://www.marriott.com/",
  "https://www.hilton.com/en/",
  "https://www.delta.com/",
  "https://www.southwest.com/",
  "https://www.costco.com/",
  "https://www.nissanusa.com/",
  "https://www.chevrolet.com/",
  "https://www.att.com/",
  "https://www.verizon.com/",
];

// ---- args ----
const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const LABEL = getArg("label", "baseline");
const HEADED = args.includes("--headed");
const sitesArg = getArg("sites", "");
const SITES = sitesArg
  ? sitesArg.split(",").map((s) => (s.startsWith("http") ? s : "https://" + s.trim()))
  : DEFAULT_SITES;

const OUT_DIR = join("akamai-probe-results", LABEL);
mkdirSync(OUT_DIR, { recursive: true });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Akamai _abck heuristic: a "~0~" segment => still under challenge / not validated;
// "~-1~" => sensor accepted (passed). Best-effort, documented as heuristic.
function abckState(value) {
  if (!value) return "no-_abck";
  if (/~-1~/.test(value)) return "passed (~-1~)";
  if (/~0~/.test(value)) return "challenged (~0~)";
  return "present";
}

function classify(status, bodyText, abck) {
  const denied =
    /access denied|don't have permission|reference #\d|errors\.edgesuite\.net/i.test(
      bodyText || ""
    );
  if (status === 403 || denied) return "BLOCKED";
  if (abck.startsWith("challenged")) return "CHALLENGE";
  if (status >= 200 && status < 400) return "OK";
  return "OTHER(" + status + ")";
}

async function probe(context, url) {
  const host = new URL(url).host + (new URL(url).pathname.replace(/\//g, "_").replace(/_$/, ""));
  const page = await context.newPage();
  const r = { url, status: null, server: "-", akamaiGrn: "-", abck: "no-_abck", verdict: "-", title: "-" };
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // give Akamai's sensor a moment to post & set cookies
    await page.waitForTimeout(3500);
    r.status = resp ? resp.status() : null;
    if (resp) {
      const h = resp.headers();
      r.server = h["server"] || "-";
      r.akamaiGrn = h["akamai-grn"] || "-";
    }
    const cookies = await context.cookies(url);
    const abck = cookies.find((c) => c.name === "_abck");
    r.abck = abckState(abck && abck.value);
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 4000) : "");
    r.title = (await page.title()).slice(0, 80);
    r.verdict = classify(r.status, bodyText, r.abck);
    await page.screenshot({ path: join(OUT_DIR, host.replace(/[^\w.-]/g, "_") + ".png"), fullPage: false });
  } catch (e) {
    r.status = "ERR";
    r.verdict = "ERROR";
    r.title = (e.message || "").slice(0, 80);
  } finally {
    await page.close();
  }
  return r;
}

console.log(`\n=== Akamai real-browser probe — label="${LABEL}" — ${SITES.length} sites ===`);
const browser = await chromium.launch({ headless: !HEADED });
const context = await browser.newContext({
  userAgent: UA,
  viewport: { width: 1366, height: 850 },
  locale: "en-US",
});

const results = [];
for (const url of SITES) {
  const r = await probe(context, url);
  results.push(r);
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(
    `${pad(r.verdict, 10)} ${pad(r.status, 5)} ${pad(r.server, 14)} ${pad(r.abck, 16)} ${r.url}`
  );
}

await browser.close();

// write reports
writeFileSync(join(OUT_DIR, `results-${LABEL}.json`), JSON.stringify(results, null, 2));
const csv = [
  "verdict,status,server,akamai_grn,abck,title,url",
  ...results.map((r) =>
    [r.verdict, r.status, r.server, r.akamaiGrn, r.abck, JSON.stringify(r.title), r.url]
      .map((x) => `"${String(x).replace(/"/g, '""')}"`)
      .join(",")
  ),
].join("\n");
writeFileSync(join(OUT_DIR, `results-${LABEL}.csv`), csv);

const blocked = results.filter((r) => r.verdict === "BLOCKED" || r.verdict === "CHALLENGE");
console.log(`\nBlocked/challenged: ${blocked.length}/${results.length}`);
if (blocked.length) console.log("  →", blocked.map((r) => new URL(r.url).host).join(", "));
console.log(`Reports + screenshots saved under: ${OUT_DIR}\\`);
console.log(
  `\nNext: run this on BOTH networks (--label baseline off-GSA, --label gsa on-GSA),\n` +
  `then any site that is OK in baseline but BLOCKED/CHALLENGE in gsa is a true Honda-style hit.`
);

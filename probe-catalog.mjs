// probe-catalog.mjs — real-browser probe across the 50-category catalog.
// Concurrency pool of real Chromium contexts. Detects CDN/WAF vendor + verdict.
// Writes incremental + final JSON to akamai-probe-results/catalog/results-catalog.json
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG } from "./sites-catalog.mjs";

const CONCURRENCY = Number(process.env.CONC || 20);
const NAV_TIMEOUT = 25000;
const SETTLE_MS = 1500;
const OUT_DIR = join("akamai-probe-results", "catalog");
mkdirSync(OUT_DIR, { recursive: true });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// build task list
const tasks = [];
for (const [category, hosts] of Object.entries(CATALOG))
  for (const host of hosts) tasks.push({ category, host });

function detectVendor(headers, cookieStr, server) {
  const h = (n) => headers[n] || "";
  const s = (server || "").toLowerCase();
  if (/akamai/.test(s) || h("akamai-grn") || /x-akam/i.test(Object.keys(headers).join(",")) ||
      /\b(_abck|bm_sz|ak_bmsc|bm_mi|bm_sv)=/.test(cookieStr)) return "Akamai";
  if (/cloudflare/.test(s) || h("cf-ray") || h("cf-mitigated") || /__cf_bm=/.test(cookieStr)) return "Cloudflare";
  if (h("x-iinfo") || /\b(incap_ses|visid_incap|nlbi_)/.test(cookieStr)) return "Imperva";
  if (/cloudfront/.test(s) || h("x-amz-cf-id") || /x-amzn-waf/i.test(Object.keys(headers).join(","))) return "AWS CloudFront/WAF";
  if (/fastly/.test(s) || /fastly/i.test(h("x-served-by")) || h("x-fastly-request-id")) return "Fastly";
  if (/(bigip|big-ip)/.test(s) || /\bTS[0-9a-f]{6,}=/.test(cookieStr)) return "F5 BIG-IP";
  if (h("x-sucuri-id") || h("x-sucuri-cache")) return "Sucuri";
  if (/vercel/.test(s) || h("x-vercel-id")) return "Vercel";
  if (/netlify/.test(s) || h("x-nf-request-id")) return "Netlify";
  if (/(gws|sffe|esf)/.test(s)) return "Google";
  if (/microsoft|iis|azure/.test(s) || h("x-azure-ref")) return "Microsoft/Azure";
  if (/(varnish|atsec|ats)/.test(s)) return "Varnish/ATS";
  if (s && s !== "-") return "Other(" + (server.split("/")[0] || server).slice(0, 18) + ")";
  return "Unknown";
}

function abckState(value) {
  if (!value) return "no-_abck";
  if (/~-1~/.test(value)) return "passed";
  if (/~0~/.test(value)) return "challenged";
  return "present";
}

function classify(status, vendor, bodyText, abck) {
  const denied = /access denied|don't have permission|reference #\d|errors\.edgesuite\.net|attention required|request unsuccessful|requested url was rejected/i.test(bodyText || "");
  if ([403, 429, 444, 503, 401].includes(status) || denied) return "BLOCKED";
  if (abck === "challenged") return "CHALLENGE";
  if (/just a moment|checking your browser|verifying you are human/i.test(bodyText || "")) return "CHALLENGE";
  if (typeof status === "number" && status >= 200 && status < 400) return "OK";
  return "OTHER";
}

async function probeOne(ctx, task) {
  const r = { category: task.category, host: task.host, url: "https://" + task.host,
    status: null, server: "-", vendor: "-", abck: "no-_abck", grn: "-", verdict: "ERROR", title: "" };
  const page = await ctx.newPage();
  try {
    let resp;
    try {
      resp = await page.goto(r.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    } catch (e) {
      if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(e.message) && !task.host.startsWith("www.")) {
        r.url = "https://www." + task.host;
        resp = await page.goto(r.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      } else throw e;
    }
    await page.waitForTimeout(SETTLE_MS);
    const headers = resp ? resp.headers() : {};
    r.status = resp ? resp.status() : null;
    r.server = headers["server"] || "-";
    r.grn = headers["akamai-grn"] || "-";
    const cookies = await ctx.cookies(r.url);
    const cookieStr = cookies.map((c) => c.name + "=" + c.value).join("; ");
    r.abck = abckState((cookies.find((c) => c.name === "_abck") || {}).value);
    r.vendor = detectVendor(headers, cookieStr, r.server);
    let body = "";
    try { body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : ""); } catch {}
    try { r.title = (await page.title()).slice(0, 80); } catch {}
    r.verdict = classify(r.status, r.vendor, body, r.abck);
  } catch (e) {
    r.status = "ERR";
    r.verdict = "ERROR";
    r.title = (e.message || "").split("\n")[0].slice(0, 80);
  } finally {
    await page.close().catch(() => {});
  }
  return r;
}

console.log(`Catalog probe: ${tasks.length} sites, concurrency ${CONCURRENCY}`);
const t0 = Date.now();
const browser = await chromium.launch({ headless: true });

// one context per worker, reused (cookies are domain-scoped so reuse is fine)
const contexts = await Promise.all(
  Array.from({ length: CONCURRENCY }, () =>
    browser.newContext({ userAgent: UA, viewport: { width: 1366, height: 850 }, locale: "en-US" })
  )
);

const results = new Array(tasks.length);
let next = 0, done = 0;
async function worker(wi) {
  const ctx = contexts[wi];
  while (true) {
    const i = next++;
    if (i >= tasks.length) break;
    results[i] = await probeOne(ctx, tasks[i]);
    done++;
    if (done % 50 === 0 || done === tasks.length) {
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  ${done}/${tasks.length}  (${secs}s)  last: ${results[i].verdict} ${results[i].vendor} ${results[i].host}`);
      writeFileSync(join(OUT_DIR, "results-catalog.json"), JSON.stringify(results.filter(Boolean), null, 0));
    }
  }
}
await Promise.all(contexts.map((_, i) => worker(i)));

await browser.close();
writeFileSync(join(OUT_DIR, "results-catalog.json"), JSON.stringify(results, null, 0));
const secs = ((Date.now() - t0) / 1000).toFixed(0);
const tally = results.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] || 0) + 1), a), {});
const vend = results.reduce((a, r) => ((a[r.vendor] = (a[r.vendor] || 0) + 1), a), {});
console.log(`\nDONE in ${secs}s. Verdicts:`, tally);
console.log("Vendors:", Object.entries(vend).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([k,v])=>k+"="+v).join(", "));
console.log("Saved:", join(OUT_DIR, "results-catalog.json"));

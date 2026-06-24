// probe-core.mjs — shared probe engine for sample + catalog probes.
// Goals (per SASE/networking expert review):
//   * Use real Edge (channel:msedge) where available + stealth, to remove the
//     "headless = bot" confound; record browser/stealth meta so reviewers can
//     rule it out.
//   * Capture the egress public IP + ASN (the single most actionable datum for
//     an IP-reputation escalation) and the CDN edge IP that served the request.
//   * Distinguish the failure layer (DNS / TCP / TLS / HTTP) instead of lumping
//     everything into ERROR.
//   * Promote IP_REPUTATION (fingerprint passed but still denied) to a
//     first-class verdict — that is the headline finding for Akamai.
//   * Retry transient 429/503 once so rate-limits do not masquerade as hard
//     blocks; keep concurrency low to avoid self-induced throttling.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const BLOCK_STATUS = [401, 403, 429, 444, 451, 503];
export const TRANSIENT_STATUS = [429, 503];

export function detectVendor(headers, cookieStr, server) {
  const h = (n) => headers[n] || "";
  const s = (server || "").toLowerCase();
  const hk = Object.keys(headers).join(",");
  if (/akamai/.test(s) || h("akamai-grn") || /x-akam/i.test(hk) ||
      /\b(_abck|bm_sz|ak_bmsc|bm_mi|bm_sv)=/.test(cookieStr)) return "Akamai";
  if (/cloudflare/.test(s) || h("cf-ray") || h("cf-mitigated") || /__cf_bm=/.test(cookieStr)) return "Cloudflare";
  if (h("x-iinfo") || /\b(incap_ses|visid_incap|nlbi_)/.test(cookieStr)) return "Imperva";
  if (/cloudfront/.test(s) || h("x-amz-cf-id") || /x-amzn-waf/i.test(hk)) return "AWS CloudFront/WAF";
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

export function abckState(value) {
  if (!value) return "no-_abck";
  if (/~-1~/.test(value)) return "passed";
  if (/~0~/.test(value)) return "challenged";
  return "present";
}

// Verdict taxonomy. Order matters: visible challenge text > sensor-challenged >
// bot-check body > IP-reputation (fingerprint OK but denied) > hard block.
export function classify(status, bodyText, abck, vendor) {
  const text = bodyText || "";
  const botCheck = /bot or not|bot check|bot-check|suspicious activity|verify you are human|checking your browser|cf-chl/i.test(text);
  const challenge = /just a moment|checking your browser|verifying you are human|complete the security check|captcha|recaptcha|hcaptcha|cf-chl/i.test(text);
  const denied = /access denied|don't have permission|reference #\d|errors\.edgesuite\.net|request unsuccessful|requested url was rejected|you have been blocked/i.test(text);
  const blockedStatus = BLOCK_STATUS.includes(status);
  if (challenge) return "HUMAN_CHALLENGE";
  if (abck === "challenged") return "BOT_CHALLENGE";
  if (botCheck && [403, 429].includes(status)) return "BOT_CHALLENGE";
  // Fingerprint validated by the bot sensor but the request is still denied =>
  // the block is keyed on egress IP/ASN reputation, not the browser.
  if (abck === "passed" && (blockedStatus || denied)) return "IP_REPUTATION";
  if (blockedStatus || denied) return "BLOCKED";
  if (/attention required/i.test(text) && status >= 400) return "BLOCKED";
  if (typeof status === "number" && status >= 200 && status < 400) return "OK";
  return "OTHER";
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function extractReference(bodyText) {
  const text = bodyText || "";
  const refMatch = text.match(/Reference\s*#([^\s<]+)/i);
  const urlMatch = text.match(/https:\/\/errors\.edgesuite\.net\/([^\s<]+)/i);
  const parts = [];
  if (refMatch) parts.push("Reference #" + refMatch[1]);
  if (urlMatch) parts.push("errors.edgesuite.net/" + urlMatch[1]);
  return parts.join(" | ");
}

// Map a navigation error message to the network layer that failed, so reviewers
// can tell DNS/TCP/TLS problems apart from HTTP-layer (WAF) blocks.
export function errorLayer(message) {
  const m = message || "";
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i.test(m)) return "DNS";
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ECONNREFUSED|ECONNRESET|ERR_CONNECTION_CLOSED/i.test(m)) return "TCP";
  if (/ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|Timeout.*exceeded|ERR_TIMED_OUT/i.test(m)) return "TIMEOUT";
  if (/ERR_CERT|ERR_SSL|SSL_|TLS|handshake|ERR_BAD_SSL/i.test(m)) return "TLS";
  if (/ERR_HTTP2|ERR_QUIC|ERR_EMPTY_RESPONSE/i.test(m)) return "HTTP";
  return "OTHER";
}

const WAF_HEADERS = [
  "akamai-grn", "x-akamai-request-id", "cf-ray", "cf-mitigated", "x-iinfo",
  "x-amzn-waf-action", "x-amz-cf-id", "retry-after", "x-served-by", "x-cache",
];

export function pickWafHeaders(headers) {
  const out = {};
  for (const k of WAF_HEADERS) if (headers[k]) out[k] = headers[k];
  return out;
}

// Launch a browser. Prefers real Edge (channel:msedge) to match the production
// client and reduce automation fingerprints; falls back to bundled Chromium.
// Env: PROBE_CHANNEL (msedge|chrome|chromium), PROBE_HEADED=1 for headed runs.
export async function launchBrowser() {
  const headless = process.env.PROBE_HEADED !== "1";
  const wanted = process.env.PROBE_CHANNEL || "msedge";
  const meta = { headless, stealth: true };
  if (wanted !== "chromium") {
    try {
      const b = await chromium.launch({ channel: wanted, headless });
      meta.channel = wanted;
      return { browser: b, meta };
    } catch {
      // fall through to bundled chromium
    }
  }
  const b = await chromium.launch({ headless });
  meta.channel = "chromium";
  return { browser: b, meta };
}

const STEALTH = () => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  if (!window.chrome) window.chrome = { runtime: {} };
};

export async function makeContext(browser) {
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 850 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  });
  await ctx.addInitScript(STEALTH);
  return ctx;
}

// Capture the public egress IP + ASN/org as seen from this network path.
// Tries ipinfo.io (gives ASN/org/geo), falls back to ipify (IP only).
export async function captureEgress(ctx) {
  const out = { ip: "", asn: "", org: "", city: "", country: "", source: "" };
  const page = await ctx.newPage();
  try {
    try {
      await page.goto("https://ipinfo.io/json", { waitUntil: "domcontentloaded", timeout: 15000 });
      const txt = await page.evaluate(() => document.body ? document.body.innerText : "");
      const j = JSON.parse(txt);
      out.ip = j.ip || "";
      out.org = j.org || "";
      out.city = j.city || "";
      out.country = j.country || "";
      const m = (j.org || "").match(/^(AS\d+)/i);
      out.asn = m ? m[1] : "";
      out.source = "ipinfo.io";
    } catch {
      await page.goto("https://api.ipify.org?format=json", { waitUntil: "domcontentloaded", timeout: 15000 });
      const txt = await page.evaluate(() => document.body ? document.body.innerText : "");
      out.ip = (JSON.parse(txt).ip) || "";
      out.source = "ipify.org";
    }
  } catch {
    out.source = "unavailable";
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

function buildRedirectChain(resp) {
  const chain = [];
  try {
    let req = resp.request().redirectedFrom();
    const seen = [];
    while (req) {
      const rr = req.redirectedFrom();
      const r = req.response && req.response();
      seen.unshift(req.url());
      req = rr;
      if (seen.length > 12) break;
    }
    return seen;
  } catch {
    return chain;
  }
}

// Probe a single host.
// opts: { settleMs, navTimeout, shotMode ("all"|"fail"|"none"), screenshot(bool, legacy=all),
//         shotDir, outDir, arm }
// Screenshots are written to <outDir>/shots/<category>/<verdict>/<host>.png so the
// catalog is organised by category + state. A block screenshot is captured even
// before a transient (429/503) retry, so a retry that clears the block cannot
// erase the evidence.
export async function probeOne(ctx, task, opts = {}) {
  const settleMs = opts.settleMs ?? 2500;
  const navTimeout = opts.navTimeout ?? 25000;
  const shotMode = opts.shotMode || (opts.screenshot ? "all" : "none");
  const r = {
    arm: opts.arm || "gsa",
    category: task.category,
    host: task.host,
    url: "https://" + task.host,
    probeUrl: "https://" + task.host,
    finalUrl: "https://" + task.host,
    status: null,
    firstStatus: null,
    server: "-",
    vendor: "-",
    abck: "no-_abck",
    grn: "-",
    edgeIp: "-",
    reference: "",
    wafHeaders: {},
    redirectChain: [],
    retryAfter: "",
    attempts: 0,
    retryRecovered: false,
    errorLayer: "",
    verdict: "ERROR",
    title: "",
    screenshot: "",
    evidenceShots: [],
    redirected: false,
  };
  let page;
  try {
    page = await ctx.newPage();
  } catch (e) {
    // Context/browser is dead — surface a typed error so the caller can relaunch.
    r.status = "ERR";
    r.verdict = "ERROR";
    r.errorLayer = "BROWSER";
    r.title = (e.message || "").split("\n")[0].slice(0, 80);
    r.browserDead = true;
    return r;
  }
  // Save a screenshot under shots/<category>/<state>/<host><suffix>.png; returns rel path.
  async function takeShot(state, suffix) {
    if (!opts.outDir) return "";
    const rel = join("shots", slugify(task.category), state, slugify(task.host) + (suffix || "") + ".png");
    try {
      mkdirSync(dirname(join(opts.outDir, rel)), { recursive: true });
      await page.screenshot({ path: join(opts.outDir, rel), fullPage: false });
      return rel;
    } catch {
      return "";
    }
  }
  try {
    let resp = null;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      r.attempts = attempt;
      try {
        resp = await page.goto(r.url, { waitUntil: "domcontentloaded", timeout: navTimeout });
      } catch (e) {
        const msg = e.message || "";
        if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION/i.test(msg) && !task.host.startsWith("www.")) {
          r.url = "https://www." + task.host;
          try {
            resp = await page.goto(r.url, { waitUntil: "domcontentloaded", timeout: navTimeout });
          } catch (e2) {
            if (attempt === maxAttempts) { r.errorLayer = errorLayer(e2.message); throw e2; }
            await page.waitForTimeout(800 * attempt);
            continue;
          }
        } else {
          if (attempt === maxAttempts) { r.errorLayer = errorLayer(msg); throw e; }
          await page.waitForTimeout(800 * attempt);
          continue;
        }
      }
      // Retry only transient throttling responses; hard blocks are not retried.
      const st = resp ? resp.status() : null;
      if (r.firstStatus === null) r.firstStatus = st;
      if (TRANSIENT_STATUS.includes(st) && attempt < maxAttempts) {
        // Capture the block NOW — before the retry potentially makes it vanish.
        if (shotMode !== "none") {
          await page.waitForTimeout(400);
          const shot = await takeShot("BLOCKED", "-attempt" + attempt + "-" + st);
          if (shot) r.evidenceShots.push(shot);
        }
        await page.waitForTimeout(1200 * attempt);
        continue;
      }
      break;
    }

    await page.waitForTimeout(settleMs);
    const headers = resp ? resp.headers() : {};
    r.status = resp ? resp.status() : null;
    if (r.firstStatus === null) r.firstStatus = r.status;
    r.server = headers["server"] || "-";
    r.grn = headers["akamai-grn"] || "-";
    r.retryAfter = headers["retry-after"] || "";
    r.wafHeaders = pickWafHeaders(headers);
    try { const sa = resp ? await resp.serverAddr() : null; if (sa && sa.ipAddress) r.edgeIp = sa.ipAddress; } catch {}
    r.redirectChain = resp ? buildRedirectChain(resp) : [];
    const cookies = await ctx.cookies(r.url);
    const cookieStr = cookies.map((c) => c.name + "=" + c.value).join("; ");
    r.abck = abckState((cookies.find((c) => c.name === "_abck") || {}).value);
    r.vendor = detectVendor(headers, cookieStr, r.server);
    let body = "";
    try { body = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 2000) : "")); } catch {}
    try { r.title = (await page.title()).slice(0, 80); } catch {}
    try { r.finalUrl = page.url(); } catch {}
    r.redirected = r.finalUrl !== r.probeUrl;
    r.reference = extractReference(body);
    r.verdict = classify(r.status, body, r.abck, r.vendor);
    r.retryRecovered = r.evidenceShots.length > 0 && r.verdict === "OK";
    // Final screenshot: all rows in "all" mode; only non-OK rows in "fail" mode.
    if (shotMode === "all" || (shotMode === "fail" && r.verdict !== "OK")) {
      r.screenshot = await takeShot(r.verdict, "");
    } else if (r.evidenceShots.length) {
      // Recovered after a transient block — keep the block image as the row's shot.
      r.screenshot = r.evidenceShots[0];
    }
  } catch (e) {
    r.status = "ERR";
    r.verdict = "ERROR";
    if (!r.errorLayer) r.errorLayer = errorLayer(e.message);
    r.title = (e.message || "").split("\n")[0].slice(0, 80);
    if (shotMode !== "none") r.screenshot = await takeShot("ERROR", "");
  } finally {
    await page.close().catch(() => {});
  }
  return r;
}

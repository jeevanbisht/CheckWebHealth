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
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// 401 is intentionally NOT here: it is expected authentication, not a block.
// It is handled by authState()/classify() and surfaces as AUTH_REQUIRED.
export const BLOCK_STATUS = [403, 429, 444, 451, 503];
export const TRANSIENT_STATUS = [429, 503];

// Known identity providers. A navigation that ends on one of these (or a 401)
// is *expected authentication*, not a network/WAF block — never classify it as
// NETWORK-CAUSED. Covers Azure AD/Entra, Okta, Ping, Duo, ADFS, Google, Auth0.
export const IDP_HOSTS =
  /login\.microsoftonline\.com|login\.microsoft\.com|sts\.|adfs|\/adfs\/ls|okta(?:preview)?\.com|pingidentity|pingone|duosecurity|accounts\.google\.com|auth0\.com|onelogin\.com|login\.salesforce\.com/i;

// Known CDN/WAF vendors — a 403 from one of these is a WAF_BLOCK (more specific
// than a bare HTTP_403). Mirrors detectVendor()'s vendor names.
const WAF_VENDORS = /Akamai|Cloudflare|Imperva|CloudFront|Fastly|F5|Sucuri|Azure Front Door|Barracuda|Radware|Incapsula/i;

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

// Detect *expected authentication* (vs. a real block). Returns an auth marker
// string or null. A 401, or a navigation that landed on a known IdP login host,
// is authentication — it must not be reported as a network/WAF failure.
export function authState(status, finalUrl, redirectChain = []) {
  if (status === 401) return "AUTH_401";
  const hops = (redirectChain || []).map((h) => (typeof h === "string" ? h : h && h.url) || "");
  if (IDP_HOSTS.test(finalUrl || "")) return "AUTH_REDIRECT";
  if (hops.some((u) => IDP_HOSTS.test(u))) return "AUTH_REDIRECT";
  return null;
}

// Verdict taxonomy. Order matters: visible challenge text > sensor-challenged >
// bot-check body > expected authentication > IP-reputation (fingerprint OK but
// denied) > hard block.
// finalUrl + redirectChain are optional (additive): when supplied they let an
// IdP-login redirect be recognised as AUTH_REQUIRED instead of a block.
export function classify(status, bodyText, abck, vendor, finalUrl, redirectChain) {
  const text = bodyText || "";
  const botCheck = /bot or not|bot check|bot-check|suspicious activity|verify you are human|checking your browser|cf-chl/i.test(text);
  // Interactive, human-solvable challenges: Cloudflare Turnstile, hCaptcha/reCAPTCHA,
  // and slider / press-and-hold walls from PerimeterX/HUMAN & DataDome. These are
  // challenge-walled (degraded UX) — NOT a hard egress block. The PerimeterX/HUMAN
  // slider says e.g. "Show us your human side" / "Slide right to secure your access".
  const challenge = /just a moment|checking your browser|verifying you are human|complete the security check|captcha|recaptcha|hcaptcha|cf-chl|slide (right|left)\b|show us your human side|we can'?t tell if you'?re (a |an )?human|press (and|&) hold|px-captcha|perimeterx|datadome|human challenge/i.test(text);
  const denied = /access denied|don't have permission|reference #\d|errors\.edgesuite\.net|request unsuccessful|requested url was rejected|you have been blocked/i.test(text);
  const blockedStatus = BLOCK_STATUS.includes(status);
  // Hard denials only: 429/503/444 are throttle/overload/challenge, NOT IP reputation.
  const denyStatus = [403, 451].includes(status);
  if (challenge) return "HUMAN_CHALLENGE";
  if (abck === "challenged") return "BOT_CHALLENGE";
  if (botCheck && [403, 429].includes(status)) return "BOT_CHALLENGE";
  // Expected authentication (401 / redirect to a known IdP) is not a block.
  if (authState(status, finalUrl, redirectChain)) return "AUTH_REQUIRED";
  // Bot sensor present (_abck passed) yet a HARD denial status (403/451) => candidate
  // egress-IP/ASN reputation block. NOT 429/503 (throttle/challenge — often a shared-
  // egress interactive challenge), and NOT a denial *body* on a 200 (soft/edge page).
  // A headless probe still can't prove IP reputation — the `validate` pass re-probes
  // these headed and promotes false positives to OK.
  if (abck === "passed" && denyStatus) return "IP_REPUTATION";
  if (blockedStatus || denied) return "BLOCKED";
  if (/attention required/i.test(text) && status >= 400) return "BLOCKED";
  if (typeof status === "number" && status >= 200 && status < 400) return "OK";
  return "OTHER";
}

// Specific, machine-readable failure reason (the "what exactly broke") that sits
// alongside the high-level verdict category. Network-layer errors win over the
// HTTP layer because if DNS/TCP/TLS failed there is no meaningful HTTP status.
//   layer  — from errorLayer() (DNS/TCP/TLS/TIMEOUT/HTTP/BROWSER/"")
//   status — HTTP status (number) or "ERR"
export function deriveReason(verdict, status, layer, vendor) {
  switch (layer) {
    case "DNS": return "DNS_FAILURE";
    case "TCP": return "TCP_FAILURE";
    case "TLS": return "TLS_FAILURE";
    case "TIMEOUT": return "TIMEOUT";
    case "HTTP": return "RESET_CONNECTION";
    case "BROWSER": return "UNKNOWN";
    default: break;
  }
  if (verdict === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  if (verdict === "BOT_CHALLENGE" || verdict === "HUMAN_CHALLENGE") return "BOT_CHALLENGE";
  if (verdict === "IP_REPUTATION") return "IP_REPUTATION";
  const code = Number(status);
  if (verdict === "BLOCKED") {
    if (code === 403) return WAF_VENDORS.test(vendor || "") ? "WAF_BLOCK" : "HTTP_403";
    if (code === 429) return "HTTP_429";
    if (code === 451) return "WAF_BLOCK";
    if (code >= 500) return "HTTP_5XX";
    return "WAF_BLOCK";
  }
  if (verdict === "OK") return "OK";
  if (code === 404) return "HTTP_404";
  if (code === 401) return "AUTH_REQUIRED";
  if (code >= 500) return "HTTP_5XX";
  if (code >= 400) return "APPLICATION_ERROR";
  return "UNKNOWN";
}

// Roll up the attempt history into a human label for the report:
//   PASS         — succeeded on the first try
//   RECOVERED    — failed at least once, then succeeded (e.g. transient 429→200)
//   FAILED_ONCE  — one attempt, failed
//   FAILED_TWICE — two attempts, all failed
//   FAILED_ALL   — three or more attempts, all failed
export function summarizePasses({ verdict, attempts } = {}) {
  const n = Number(attempts) || 1;
  if (verdict === "OK") return n > 1 ? "RECOVERED" : "PASS";
  if (n <= 1) return "FAILED_ONCE";
  if (n === 2) return "FAILED_TWICE";
  return "FAILED_ALL";
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

// Build the per-row trace reference handed to CDN/WAF support.
//   * Akamai  — "Reference #..." / errors.edgesuite.net token from the block body
//   * Cloudflare — cf-ray header (e.g. cf-ray=a10975bdb8a9efe7-IAD)
//   * AWS CloudFront/WAF — x-amz-cf-id header
// Header IDs are included only when requested (failed rows), so OK rows stay clean.
export function extractReference(bodyText, headers = {}, includeHeaderIds = false) {
  const text = bodyText || "";
  const refMatch = text.match(/Reference\s*#([^\s<]+)/i);
  const urlMatch = text.match(/https:\/\/errors\.edgesuite\.net\/([^\s<]+)/i);
  const parts = [];
  if (refMatch) parts.push("Reference #" + refMatch[1]);
  if (urlMatch) parts.push("errors.edgesuite.net/" + urlMatch[1]);
  if (includeHeaderIds) {
    if (headers["cf-ray"]) parts.push("cf-ray=" + headers["cf-ray"]);
    if (headers["x-amz-cf-id"]) parts.push("x-amz-cf-id=" + headers["x-amz-cf-id"]);
  }
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

// Curated header set captured per path for the direct-vs-GSA header diff. Values
// are recorded as-is except cookies, where only the cookie *names* are kept
// (never the values) so the report can be shared without leaking secrets.
export const DIFF_HEADERS = [
  "server", "via", "x-cache", "x-served-by", "age", "vary", "content-type", "x-powered-by",
  "cache-control", "strict-transport-security", "content-security-policy", "x-frame-options",
  "x-content-type-options", "referrer-policy", "permissions-policy",
  "cf-ray", "cf-cache-status", "x-amz-cf-id", "x-azure-ref", "akamai-grn", "x-akamai-request-id",
];

export function pickDiffHeaders(headers = {}, headersArray = []) {
  const out = {};
  for (const k of DIFF_HEADERS) if (headers[k]) out[k] = String(headers[k]).slice(0, 200);
  const names = [];
  for (const h of headersArray) {
    if ((h.name || "").toLowerCase() === "set-cookie") {
      const n = String(h.value || "").split("=")[0].trim();
      if (n) names.push(n);
    }
  }
  if (names.length) out["set-cookie-names"] = Array.from(new Set(names)).sort().join(",");
  return out;
}

// Pure header diff: returns [{key, a, b}] for every header that differs between
// two captured header maps (missing on one side shows as null). Used by the
// report to highlight what the network path changed (Server, Via, cache, HSTS…).
export function diffHeaders(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const diffs = [];
  for (const k of [...keys].sort()) {
    const av = a && a[k] != null ? a[k] : null;
    const bv = b && b[k] != null ? b[k] : null;
    if (av !== bv) diffs.push({ key: k, a: av, b: bv });
  }
  return diffs;
}

// Confidence score (0–99) + human factors for a per-host diagnosis, computed
// across all available paths. High confidence = corroborated, consistent,
// strong-signal failure (e.g. direct OK, GSA fails, Akamai _abck passed, same
// verdict across attempts). Low confidence = single path, timeout, or DNS flake.
//   perPath  — { [pathId]: result }
//   primary  — the path under test (default "gsa")
//   baseline — the reference path (default "direct")
export function scoreConfidence(perPath = {}, primary = "gsa", baseline = "direct") {
  const factors = [];
  const get = (id) => perPath[id];
  const verdictOf = (id) => (get(id) || {}).verdict;
  const p = get(primary) || {};
  const pOk = verdictOf(primary) === "OK";
  let s = 50;

  if (verdictOf(primary) === "AUTH_REQUIRED") {
    return { score: 90, factors: ["expected authentication (not a network/WAF block)"] };
  }
  if (get(baseline) && verdictOf(baseline) === "OK" && !pOk) { s += 30; factors.push(`${baseline} loads OK but ${primary} fails (network-attributable)`); }
  if (get(baseline) && verdictOf(baseline) === "OK" && pOk) { s += 5; factors.push("both paths OK"); }
  const others = Object.keys(perPath).filter((id) => id !== primary && id !== baseline);
  if (others.length && !pOk && others.every((id) => verdictOf(id) === "OK")) { s += 15; factors.push(`other path(s) OK: ${others.join(", ")}`); }

  const log = Array.isArray(p.attemptLog) ? p.attemptLog : [];
  if (log.length >= 2 && new Set(log.map((a) => a.verdict)).size === 1) { s += 10; factors.push(`same result across ${log.length} attempts`); }

  if (p.vendor === "Akamai" && p.abck === "passed" && !pOk) { s += 10; factors.push("Akamai _abck passed yet denied ⇒ IP/ASN reputation"); }
  if (p.reason === "WAF_BLOCK" || p.reason === "IP_REPUTATION") { s += 5; factors.push(`specific reason: ${p.reason}`); }

  if (p.reason === "TIMEOUT") { s -= 25; factors.push("timeout — often intermittent"); }
  if (p.reason === "DNS_FAILURE") { s -= 10; factors.push("DNS failure — may be transient"); }
  if (!get(baseline) && others.length === 0) { s -= 15; factors.push("single path — no corroborating baseline"); }

  return { score: Math.max(5, Math.min(99, Math.round(s))), factors };
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

// opts.recordHar = { path, mode? } enables a true HAR capture for this context
// (used by the evidence pass to export per-host .har on failures). Omitted by
// default so normal probe contexts stay lightweight.
export async function makeContext(browser, opts = {}) {
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 850 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    ...(opts.recordHar ? { recordHar: opts.recordHar } : {}),
  });
  await ctx.addInitScript(STEALTH);
  return ctx;
}

// True when this run is configured to probe through Manual Browser Parity Edge
// (real profile, no stealth) instead of the default temp-profile stealth engine.
// Opt-in only (cfg.parityProbe / PROBE_PARITY=1 / --parity) so the default A/B
// methodology is never silently changed.
export function isParityProbe(cfg = {}) {
  return cfg.parityProbe === true;
}

// Launch the browsing environment for a probe arm and return a uniform handle so
// the orchestrators don't branch on the engine:
//   { meta, contexts:[ctx…], egressContext, close() }
// Two engines:
//   * default  — bundled launchBrowser() + N stealth temp-profile contexts
//                (unchanged A/B behaviour; fixed UA/viewport/locale/tz).
//   * parity   — ONE real-Edge persistent context using a *copied* diagnostic
//                profile (real cookies/session, no stealth, no write-back to the
//                user's real profile). The single context is shared across the
//                requested worker slots (cookies are domain-scoped, so sharing
//                is correct and desirable for parity). probe's --headed controls
//                visibility (headless by default, like a normal probe).
export async function launchProbeEnvironment(cfg = {}, { concurrency = 1 } = {}) {
  const n = Math.max(1, Number(concurrency) || 1);

  if (isParityProbe(cfg)) {
    const { launchParityContext, cleanupCopiedProfile } = await import("./browser-parity.mjs");
    const browserCfg = { ...(cfg.browser || {}), headless: !cfg.headed };
    const pc = await launchParityContext(browserCfg, { forceCopy: true });
    const ctx = pc.context;
    const meta = {
      channel: pc.channel,
      headless: pc.headless,
      stealth: false,
      mode: "manual-parity",
      profileType: pc.profileType,
      copiedProfileUsed: pc.copiedProfileUsed,
      profileDirectory: browserCfg.profileDirectory || "Default",
    };
    return {
      meta,
      contexts: Array.from({ length: n }, () => ctx), // shared real-profile context
      egressContext: ctx,
      close: async () => {
        try { await ctx.close().catch(() => {}); } finally {
          if (pc.copiedProfileUsed) cleanupCopiedProfile(pc.userDataDir);
        }
      },
    };
  }

  // Default temp-profile stealth engine — unchanged behaviour.
  const { browser, meta } = await launchBrowser();
  const contexts = await Promise.all(Array.from({ length: n }, () => makeContext(browser)));
  return {
    meta: { ...meta, mode: "automated", profileType: "temporary" },
    contexts,
    egressContext: contexts[0],
    close: async () => {
      await Promise.all(contexts.map((c) => c.close().catch(() => {})));
      await browser.close().catch(() => {});
    },
  };
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

// Capture the run/arm browser ENVIRONMENT for trust scoring (diagnosis.mjs):
// navigator-level signals (webdriver, engine, Edge version, client hints, UA)
// plus the context's cookie count. Origin-specific storage is intentionally not
// sampled here (it's a weak run-level signal); cookies present in the context is
// the meaningful "real session" signal. jsOk=false means the page script failed.
export async function captureEnvironment(ctx) {
  const out = { webdriver: null, engine: "", edgeVersion: "", clientHintsPresent: null, userAgent: "", cookiesPresent: 0, jsOk: true };
  try {
    const { collectSnapshot } = await import("./browser-parity.mjs");
    const page = await ctx.newPage();
    try {
      await page.goto("about:blank").catch(() => {});
      const snap = await collectSnapshot(page);
      out.webdriver = snap.webdriver;
      out.engine = snap.engine;
      out.edgeVersion = snap.edgeVersion;
      out.clientHintsPresent = snap.clientHintsPresent;
      out.userAgent = snap.userAgent;
    } finally { await page.close().catch(() => {}); }
    try { out.cookiesPresent = (await ctx.cookies()).length; } catch { /* keep 0 */ }
  } catch { out.jsOk = false; }
  return out;
}

// Build the full redirect chain with per-hop detail: each hop records the URL,
// HTTP status (3xx for the redirects, final status for the landing response),
// the Location header, the scheme/protocol, and the hop's response time (ms).
// The final entry is the landed response. This pinpoints *where* in a redirect
// sequence a failure occurred (e.g. URL A 301 → B 302 → C 403).
function buildRedirectChain(resp) {
  const chain = [];
  try {
    if (!resp) return chain;
    const redirects = [];
    let req = resp.request().redirectedFrom();
    let guard = 0;
    while (req && guard++ < 12) {
      redirects.unshift(req);
      req = req.redirectedFrom();
    }
    const hopOf = (rq, fallbackStatus) => {
      const url = rq.url();
      let status = fallbackStatus ?? null, location = "", ms = null;
      try { const rp = rq.response(); if (rp) { status = rp.status(); location = rp.headers()["location"] || ""; } } catch {}
      try { const t = rq.timing(); if (t && t.responseEnd >= 0) ms = Math.round(t.responseEnd - t.startTime); } catch {}
      return { url, status, location, protocol: url.startsWith("https") ? "https" : "http", ms };
    };
    for (const rq of redirects) chain.push(hopOf(rq));
    // final landed response
    const furl = resp.url();
    let fms = null;
    try { const t = resp.request().timing(); if (t && t.responseEnd >= 0) fms = Math.round(t.responseEnd - t.startTime); } catch {}
    chain.push({ url: furl, status: resp.status(), location: "", protocol: furl.startsWith("https") ? "https" : "http", ms: fms });
  } catch { /* best-effort */ }
  return chain;
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
    headers: {},        // curated header set for the direct-vs-GSA header diff
    redirectChain: [],
    retryAfter: "",
    attempts: 0,        // numeric count (back-compat)
    attemptLog: [],     // [{n, status, verdict, reason, ms}] — every attempt, in order
    passSummary: "",    // "PASS" | "FAILED_ONCE" | "FAILED_TWICE" | "FAILED_ALL"
    retryRecovered: false,
    errorLayer: "",
    reason: "UNKNOWN",  // specific machine-readable reason (deriveReason)
    verdict: "ERROR",
    title: "",
    screenshot: "",
    evidenceShots: [],
    evidence: {},       // {console, netlog} — rel paths, written only on failure
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
  // Lightweight forensic capture: collect console messages + a per-request
  // network log (status, timing, redirects, failures) in memory. Cheap on
  // success; only persisted to disk when the row fails (verdict !== OK), so
  // successful runs stay lightweight. Gated by opts.evidence.
  const captureEvidence = opts.evidence === true && !!opts.outDir;
  const consoleLog = [];
  const netLog = [];
  if (captureEvidence) {
    page.on("console", (m) => {
      if (consoleLog.length < 200) consoleLog.push(`[${m.type()}] ${m.text()}`.slice(0, 500));
    });
    page.on("requestfailed", (req) => {
      if (netLog.length < 400)
        netLog.push({ url: req.url(), method: req.method(), failed: true, error: (req.failure() || {}).errorText || "" });
    });
    page.on("requestfinished", (req) => {
      if (netLog.length >= 400) return;
      let status = null, ms = null, type = "";
      try { const rp = req.response(); if (rp) status = rp.status(); } catch {}
      try { const t = req.timing(); if (t && t.responseEnd >= 0) ms = Math.round(t.responseEnd - t.startTime); } catch {}
      try { type = req.resourceType(); } catch {}
      netLog.push({ url: req.url(), method: req.method(), status, ms, type, redirect: status >= 300 && status < 400 });
    });
  }
  // Persist console + network log next to the screenshots, under evidence/.
  function writeEvidence() {
    if (!captureEvidence) return;
    try {
      const dir = join("evidence", slugify(task.category));
      mkdirSync(join(opts.outDir, dir), { recursive: true });
      const base = slugify(task.host);
      if (consoleLog.length) {
        const rel = join(dir, base + ".console.log");
        writeFileSync(join(opts.outDir, rel), consoleLog.join("\n"));
        r.evidence.console = rel;
      }
      const rel = join(dir, base + ".netlog.json");
      writeFileSync(join(opts.outDir, rel), JSON.stringify(netLog, null, 0));
      r.evidence.netlog = rel;
    } catch {}
  }
  try {
    let resp = null;
    const maxAttempts = Math.max(1, Number(opts.retries ?? process.env.PROBE_RETRIES ?? 2));
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      r.attempts = attempt;
      const attemptT0 = Date.now();
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
            r.attemptLog.push({ n: attempt, status: "ERR", verdict: "ERROR", reason: deriveReason("ERROR", "ERR", errorLayer(e2.message)), ms: Date.now() - attemptT0 });
            await page.waitForTimeout(800 * attempt);
            continue;
          }
        } else {
          if (attempt === maxAttempts) { r.errorLayer = errorLayer(msg); throw e; }
          r.attemptLog.push({ n: attempt, status: "ERR", verdict: "ERROR", reason: deriveReason("ERROR", "ERR", errorLayer(msg)), ms: Date.now() - attemptT0 });
          await page.waitForTimeout(800 * attempt);
          continue;
        }
      }
      // Retry only transient throttling responses; hard blocks are not retried.
      const st = resp ? resp.status() : null;
      if (r.firstStatus === null) r.firstStatus = st;
      if (TRANSIENT_STATUS.includes(st) && attempt < maxAttempts) {
        r.attemptLog.push({ n: attempt, status: st, verdict: "BLOCKED", reason: deriveReason("BLOCKED", st, ""), ms: Date.now() - attemptT0 });
        // Capture the block NOW — before the retry potentially makes it vanish.
        if (shotMode !== "none") {
          await page.waitForTimeout(400);
          const shot = await takeShot("BLOCKED", "-attempt" + attempt + "-" + st);
          if (shot) r.evidenceShots.push(shot);
        }
        // Back off before retrying a transient 429/503. Honour Retry-After when
        // present (capped) rather than hammering — re-hitting a throttled tenant
        // from one shared egress only deepens the throttle/challenge.
        const ra = parseInt((resp && resp.headers()["retry-after"]) || "", 10);
        const backoff = Number.isFinite(ra) ? Math.min(Math.max(ra * 1000, 1200), 15000) : 1500 * attempt;
        await page.waitForTimeout(backoff);
        continue;
      }
      break;
    }

    // Let async bot sensors / interactive challenges settle before reading state:
    // wait for the network to go idle (capped). A short-dwell read can catch a
    // page mid-challenge and mis-record a transient 403/429 (observed: a 403 that
    // resolves to 200 once given time + network idle on slower WAFs).
    try { await page.waitForLoadState("networkidle", { timeout: Math.min(navTimeout, 8000) }); } catch { /* idle never reached — proceed */ }
    await page.waitForTimeout(settleMs);
    const headers = resp ? resp.headers() : {};
    r.status = resp ? resp.status() : null;
    if (r.firstStatus === null) r.firstStatus = r.status;
    r.server = headers["server"] || "-";
    r.grn = headers["akamai-grn"] || "-";
    r.retryAfter = headers["retry-after"] || "";
    r.wafHeaders = pickWafHeaders(headers);
    let headersArray = [];
    try { headersArray = resp ? await resp.headersArray() : []; } catch {}
    r.headers = pickDiffHeaders(headers, headersArray);
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
    r.verdict = classify(r.status, body, r.abck, r.vendor, r.finalUrl, r.redirectChain);
    r.reason = deriveReason(r.verdict, r.status, r.errorLayer, r.vendor);
    r.attemptLog.push({ n: r.attempts, status: r.status, verdict: r.verdict, reason: r.reason, ms: null });
    r.passSummary = summarizePasses(r);
    r.reference = extractReference(body, headers, r.verdict !== "OK");
    r.retryRecovered = r.evidenceShots.length > 0 && r.verdict === "OK";
    if (r.verdict !== "OK") writeEvidence();
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
    r.reason = deriveReason("ERROR", "ERR", r.errorLayer);
    r.attemptLog.push({ n: r.attempts, status: "ERR", verdict: "ERROR", reason: r.reason, ms: null });
    r.passSummary = summarizePasses(r);
    r.title = (e.message || "").split("\n")[0].slice(0, 80);
    writeEvidence();
    if (shotMode !== "none") r.screenshot = await takeShot("ERROR", "");
  } finally {
    await page.close().catch(() => {});
  }
  return r;
}

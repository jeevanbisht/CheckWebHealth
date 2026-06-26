// Unit tests for the pure classification helpers in probe-core.mjs.
// Run with `npm test` (Node's built-in test runner — no extra dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify, authState, deriveReason, summarizePasses,
  detectVendor, abckState, errorLayer, extractReference, slugify,
  BLOCK_STATUS, diffHeaders, scoreConfidence, pickDiffHeaders,
} from "../probe-core.mjs";
import { loadConfig, DEFAULTS } from "../config.mjs";

// ---- BLOCK_STATUS no longer treats 401 as a block ------------------------
test("401 is not in BLOCK_STATUS (auth, not block)", () => {
  assert.ok(!BLOCK_STATUS.includes(401));
  assert.ok(BLOCK_STATUS.includes(403));
});

// ---- authState -----------------------------------------------------------
test("authState flags a 401 as authentication", () => {
  assert.equal(authState(401, "https://app.example.com", []), "AUTH_401");
});

test("authState flags an Entra/Azure AD login redirect", () => {
  assert.equal(
    authState(200, "https://login.microsoftonline.com/common/oauth2/authorize", []),
    "AUTH_REDIRECT"
  );
});

test("authState flags an IdP seen mid redirect chain (Okta)", () => {
  const chain = ["https://app.example.com", "https://example.okta.com/login", "https://app.example.com/home"];
  assert.equal(authState(200, "https://app.example.com/home", chain), "AUTH_REDIRECT");
});

test("authState returns null for a normal 200 page", () => {
  assert.equal(authState(200, "https://www.example.com", []), null);
});

// ---- classify: AUTH must win over BLOCKED --------------------------------
test("classify maps 401 to AUTH_REQUIRED, not BLOCKED", () => {
  assert.equal(classify(401, "", "no-_abck", "-"), "AUTH_REQUIRED");
});

test("classify maps an IdP redirect to AUTH_REQUIRED", () => {
  assert.equal(
    classify(200, "Sign in", "no-_abck", "Microsoft/Azure", "https://login.microsoftonline.com/x", []),
    "AUTH_REQUIRED"
  );
});

test("classify keeps 403 as BLOCKED", () => {
  assert.equal(classify(403, "Access Denied", "no-_abck", "Akamai"), "BLOCKED");
});

test("classify keeps IP_REPUTATION (abck passed but denied)", () => {
  assert.equal(classify(403, "Access Denied Reference #1.2", "passed", "Akamai"), "IP_REPUTATION");
});

test("classify keeps BOT_CHALLENGE (abck challenged)", () => {
  assert.equal(classify(403, "", "challenged", "Akamai"), "BOT_CHALLENGE");
});

test("classify keeps HUMAN_CHALLENGE on captcha text", () => {
  assert.equal(classify(200, "Please complete the security check captcha", "no-_abck", "Cloudflare"), "HUMAN_CHALLENGE");
});

test("classify returns OK for a normal 200", () => {
  assert.equal(classify(200, "Welcome", "no-_abck", "-"), "OK");
});

// ---- deriveReason --------------------------------------------------------
test("deriveReason prefers network layer over HTTP", () => {
  assert.equal(deriveReason("ERROR", "ERR", "DNS"), "DNS_FAILURE");
  assert.equal(deriveReason("ERROR", "ERR", "TLS"), "TLS_FAILURE");
  assert.equal(deriveReason("ERROR", "ERR", "TIMEOUT"), "TIMEOUT");
  assert.equal(deriveReason("ERROR", "ERR", "TCP"), "TCP_FAILURE");
});

test("deriveReason maps WAF 403 vs generic 403", () => {
  assert.equal(deriveReason("BLOCKED", 403, "", "Akamai"), "WAF_BLOCK");
  assert.equal(deriveReason("BLOCKED", 403, "", "Other(nginx)"), "HTTP_403");
});

test("deriveReason maps verdicts and codes", () => {
  assert.equal(deriveReason("AUTH_REQUIRED", 401, ""), "AUTH_REQUIRED");
  assert.equal(deriveReason("IP_REPUTATION", 403, "", "Akamai"), "IP_REPUTATION");
  assert.equal(deriveReason("BOT_CHALLENGE", 403, ""), "BOT_CHALLENGE");
  assert.equal(deriveReason("BLOCKED", 429, ""), "HTTP_429");
  assert.equal(deriveReason("BLOCKED", 503, ""), "HTTP_5XX");
  assert.equal(deriveReason("OK", 200, ""), "OK");
});

// ---- summarizePasses -----------------------------------------------------
test("summarizePasses labels attempt history", () => {
  assert.equal(summarizePasses({ verdict: "OK", attempts: 1 }), "PASS");
  assert.equal(summarizePasses({ verdict: "OK", attempts: 2 }), "RECOVERED");
  assert.equal(summarizePasses({ verdict: "BLOCKED", attempts: 1 }), "FAILED_ONCE");
  assert.equal(summarizePasses({ verdict: "BLOCKED", attempts: 2 }), "FAILED_TWICE");
  assert.equal(summarizePasses({ verdict: "ERROR", attempts: 3 }), "FAILED_ALL");
});

// ---- regression coverage for existing helpers ----------------------------
test("detectVendor recognises Akamai by cookie", () => {
  assert.equal(detectVendor({}, "_abck=1~-1~; bm_sz=x", "AkamaiGHost"), "Akamai");
});

test("detectVendor recognises Cloudflare by header", () => {
  assert.equal(detectVendor({ "cf-ray": "abc-IAD" }, "", "cloudflare"), "Cloudflare");
});

// ---- config: precedence DEFAULTS < file < env ----------------------------
test("loadConfig returns DEFAULTS when no file and empty env", () => {
  const cfg = loadConfig({}, "does-not-exist.json");
  assert.equal(cfg.retries, DEFAULTS.retries);
  assert.equal(cfg.arm, DEFAULTS.arm);
  assert.deepEqual(cfg.paths.map((p) => p.id), ["direct", "gsa"]);
});

test("loadConfig: env overrides DEFAULTS and coerces numbers", () => {
  const cfg = loadConfig({ PROBE_ARM: "direct", PROBE_RETRIES: "5", NAV_TIMEOUT: "9000", CONC: "8" }, "does-not-exist.json");
  assert.equal(cfg.arm, "direct");
  assert.equal(cfg.retries, 5);
  assert.equal(cfg.navTimeout, 9000);
  assert.equal(cfg.concurrency, 8);
});

test("loadConfig clamps retries/concurrency to a sane minimum", () => {
  const cfg = loadConfig({ PROBE_RETRIES: "0", CONC: "0" }, "does-not-exist.json");
  assert.equal(cfg.retries, 1);
  assert.equal(cfg.concurrency, 1);
});

test("loadConfig ignores non-numeric env and keeps the default", () => {
  const cfg = loadConfig({ NAV_TIMEOUT: "abc" }, "does-not-exist.json");
  assert.equal(cfg.navTimeout, DEFAULTS.navTimeout);
});

test("loadConfig defaults seed to null (sample uses Date.now())", () => {
  const cfg = loadConfig({}, "does-not-exist.json");
  assert.equal(cfg.seed, null);
});

test("loadConfig: SEED env sets a fixed numeric seed for A/B sample parity", () => {
  const cfg = loadConfig({ SEED: "12345" }, "does-not-exist.json");
  assert.equal(cfg.seed, 12345);
});

test("loadConfig ignores empty/non-numeric SEED and keeps null", () => {
  assert.equal(loadConfig({ SEED: "" }, "does-not-exist.json").seed, null);
  assert.equal(loadConfig({ SEED: "abc" }, "does-not-exist.json").seed, null);
});

// ---- header diff ----------------------------------------------------------
test("diffHeaders reports added, removed and changed headers", () => {
  const d = diffHeaders(
    { server: "nginx", via: "1.1 direct", age: "1" },
    { server: "AkamaiGHost", via: "1.1 direct", "x-cache": "TCP_HIT" },
  );
  const byKey = Object.fromEntries(d.map((x) => [x.key, x]));
  assert.deepEqual(byKey.server, { key: "server", a: "nginx", b: "AkamaiGHost" });
  assert.deepEqual(byKey.age, { key: "age", a: "1", b: null });
  assert.deepEqual(byKey["x-cache"], { key: "x-cache", a: null, b: "TCP_HIT" });
  assert.equal(byKey.via, undefined); // identical → not reported
});

test("diffHeaders on identical maps returns empty", () => {
  assert.deepEqual(diffHeaders({ a: "1" }, { a: "1" }), []);
});

// ---- pickDiffHeaders: whitelist + cookie names only -----------------------
test("pickDiffHeaders keeps only whitelisted headers and cookie NAMES", () => {
  const out = pickDiffHeaders(
    { server: "AkamaiGHost", "set-cookie": "secret=value", "x-secret": "nope" },
    [{ name: "set-cookie", value: "_abck=AAA=BBB; Path=/" }, { name: "set-cookie", value: "bm_sz=ZZZ" }],
  );
  assert.equal(out.server, "AkamaiGHost");
  assert.equal(out["x-secret"], undefined); // not whitelisted
  assert.equal(out["set-cookie-names"], "_abck,bm_sz"); // names only, no values
  assert.ok(!JSON.stringify(out).includes("value")); // never leak cookie values
});

// ---- confidence scoring ---------------------------------------------------
test("scoreConfidence: direct OK + GSA blocked + Akamai abck passed = high", () => {
  const { score, factors } = scoreConfidence({
    direct: { verdict: "OK" },
    gsa: { verdict: "IP_REPUTATION", vendor: "Akamai", abck: "passed", reason: "IP_REPUTATION",
           attemptLog: [{ verdict: "IP_REPUTATION" }, { verdict: "IP_REPUTATION" }] },
  }, "gsa", "direct");
  assert.ok(score >= 90, `expected high confidence, got ${score}`);
  assert.ok(factors.length >= 2);
});

test("scoreConfidence: AUTH_REQUIRED short-circuits to 90 (not a block)", () => {
  const { score } = scoreConfidence({ gsa: { verdict: "AUTH_REQUIRED" } }, "gsa", "direct");
  assert.equal(score, 90);
});

test("scoreConfidence: single path with timeout is low", () => {
  const { score } = scoreConfidence({ gsa: { verdict: "ERROR", reason: "TIMEOUT" } }, "gsa", "direct");
  assert.ok(score <= 30, `expected low confidence, got ${score}`);
});

test("scoreConfidence is clamped to the 5–99 range", () => {
  const lo = scoreConfidence({ gsa: { verdict: "ERROR", reason: "TIMEOUT" } }, "gsa", "direct").score;
  const hi = scoreConfidence({
    direct: { verdict: "OK" },
    azure: { verdict: "OK" },
    gsa: { verdict: "IP_REPUTATION", vendor: "Akamai", abck: "passed", reason: "IP_REPUTATION",
           attemptLog: [{ verdict: "IP_REPUTATION" }, { verdict: "IP_REPUTATION" }, { verdict: "IP_REPUTATION" }] },
  }, "gsa", "direct").score;
  assert.ok(lo >= 5 && hi <= 99);
});

test("abckState reads sensor state", () => {
  assert.equal(abckState("xxx~-1~yyy"), "passed");
  assert.equal(abckState("xxx~0~yyy"), "challenged");
  assert.equal(abckState(""), "no-_abck");
});

test("errorLayer maps Chromium net errors", () => {
  assert.equal(errorLayer("net::ERR_NAME_NOT_RESOLVED"), "DNS");
  assert.equal(errorLayer("net::ERR_CONNECTION_REFUSED"), "TCP");
  assert.equal(errorLayer("net::ERR_CONNECTION_TIMED_OUT"), "TIMEOUT");
  assert.equal(errorLayer("net::ERR_CERT_DATE_INVALID"), "TLS");
});

test("extractReference pulls Akamai reference and header IDs", () => {
  const ref = extractReference("Reference #18.abcd", { "cf-ray": "zzz-IAD" }, true);
  assert.match(ref, /Reference #18\.abcd/);
  assert.match(ref, /cf-ray=zzz-IAD/);
});

test("slugify normalises hosts", () => {
  assert.equal(slugify("https://Foo.Bar.com/x"), "foo-bar-com-x");
});

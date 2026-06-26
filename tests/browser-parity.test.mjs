// browser-parity.test.mjs — pure-function tests for Manual Browser Parity Mode.
// No browser/network: profile resolution, version parsing, sanitisation,
// classification and config normalisation are all platform-injectable.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultUserDataDir, resolveUserDataDir, parseEdgeVersion, engineOf, majorVersion,
  sanitizeProxyUrl, redactCookies, sanitizeHar, classifyParity, parityComparisonRows,
  recommendedFixes, sanitizeUrlForReport,
} from "../src/core/browser-parity.mjs";
import { loadConfig, normalizeBrowser, DEFAULTS } from "../src/core/config.mjs";

// ---- profile / path resolution (platform injected) -------------------------
test("defaultUserDataDir resolves per platform", () => {
  const win = defaultUserDataDir("win32", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "C:\\Users\\x");
  assert.ok(win.includes("Microsoft") && win.includes("Edge") && win.includes("User Data"));
  const mac = defaultUserDataDir("darwin", {}, "/Users/x");
  assert.ok(mac.includes("Microsoft Edge"));
  const lin = defaultUserDataDir("linux", {}, "/home/x");
  assert.ok(lin.includes(".config") && lin.includes("microsoft-edge"));
});

test("resolveUserDataDir prefers explicit config, else platform default", () => {
  assert.equal(resolveUserDataDir({ userDataDir: "/custom/dir" }), "/custom/dir");
  const def = resolveUserDataDir({}, { platform: "linux", env: {}, home: "/home/x" });
  assert.ok(def.includes("microsoft-edge"));
});

// ---- version / engine parsing ---------------------------------------------
test("parseEdgeVersion extracts the Edg/ version, engineOf identifies the engine", () => {
  const edgeUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.4022.96";
  assert.equal(parseEdgeVersion(edgeUa), "149.0.4022.96");
  assert.equal(engineOf(edgeUa), "Edge");
  const chromeUa = "Mozilla/5.0 ... Chrome/126.0.0.0 Safari/537.36";
  assert.equal(parseEdgeVersion(chromeUa), "");
  assert.equal(engineOf(chromeUa), "Chromium");
  assert.equal(majorVersion("149.0.4022.96"), "149");
});

// ---- sanitisation: never leak secrets -------------------------------------
test("sanitizeProxyUrl strips embedded credentials", () => {
  assert.equal(sanitizeProxyUrl("http://user:pass@proxy:8080"), "http://proxy:8080");
  assert.equal(sanitizeProxyUrl("proxy:8080"), "proxy:8080");
  assert.equal(sanitizeProxyUrl("user:pass@proxy:8080"), "proxy:8080");
});

test("sanitizeUrlForReport redacts secret query params and token fragments", () => {
  assert.equal(
    sanitizeUrlForReport("https://app.example.com/cb?code=ABC123&state=ok"),
    "https://app.example.com/cb?code=%5Bredacted%5D&state=ok"
  );
  assert.equal(
    sanitizeUrlForReport("https://app.example.com/#access_token=SECRET&expires=3600"),
    "https://app.example.com/#access_token=[redacted]&expires=3600"
  );
  // non-secret URLs are preserved
  assert.equal(sanitizeUrlForReport("https://www.bing.com/search?q=hi"), "https://www.bing.com/search?q=hi");
  // unparseable input drops query/fragment
  assert.equal(sanitizeUrlForReport("not a url?token=x"), "not a url");
});

test("redactCookies keeps names/flags but drops values", () => {
  const out = redactCookies([{ name: "_abck", value: "SECRET~-1~", domain: "x.com", path: "/", secure: true, httpOnly: false, sameSite: "Lax" }]);
  assert.equal(out[0].name, "_abck");
  assert.equal(out[0].hasValue, true);
  assert.ok(!("value" in out[0]));
});

test("sanitizeHar strips sensitive headers, cookies, urls, query and bodies", () => {
  const har = {
    log: {
      entries: [{
        request: {
          url: "https://api.example.com/x?access_token=SECRET&q=ok",
          queryString: [{ name: "access_token", value: "SECRET" }, { name: "q", value: "ok" }],
          headers: [{ name: "Cookie", value: "a=b" }, { name: "Accept", value: "*/*" }, { name: "Authorization", value: "Bearer x" }, { name: "X-CSRF-Token", value: "tok" }, { name: "Ocp-Apim-Subscription-Key", value: "k" }],
          cookies: [{ name: "sid", value: "secret" }],
          postData: { text: "password=hunter2", params: [{ name: "password", value: "hunter2" }] },
        },
        response: {
          redirectURL: "https://app.example.com/cb?code=ABC",
          headers: [{ name: "Set-Cookie", value: "sid=secret" }, { name: "Content-Type", value: "text/html" }],
          cookies: [{ name: "sid", value: "secret" }],
          content: { mimeType: "text/html", size: 10, text: "<html>token</html>" },
        },
      }],
    },
  };
  sanitizeHar(har);
  const e = har.log.entries[0];
  assert.deepEqual(e.request.headers.map((h) => h.name), ["Accept"]); // Cookie/Authorization/X-CSRF-Token/Ocp-Apim-* removed
  assert.deepEqual(e.response.headers.map((h) => h.name), ["Content-Type"]);
  assert.ok(!e.request.url.includes("SECRET"));
  assert.ok(e.request.url.includes("q=ok"));
  assert.equal(e.request.queryString.find((q) => q.name === "access_token").value, "[redacted]");
  assert.ok(!e.response.redirectURL.includes("ABC"));
  assert.equal(e.request.cookies[0].redacted, true);
  assert.ok(!("value" in e.request.cookies[0]));
  assert.equal(e.request.postData.text, "[redacted]");
  assert.equal(e.request.postData.params[0].value, "[redacted]");
  assert.ok(!("text" in e.response.content));
  assert.equal(e.response.content.size, 10);
});

// ---- classification --------------------------------------------------------
const tempFail = { works: false, profileType: "temporary", headless: true, cookiesPresent: 0, edgeVersion: "149.0.4022.96", engine: "Edge", webdriver: true, clientHintsPresent: true, consoleErrors: 0, failedRequests: 0, verdict: "BLOCKED" };
const parityOk = { works: true, profileType: "persistent", headless: false, cookiesPresent: 12, edgeVersion: "149.0.4022.96", engine: "Edge", webdriver: false, clientHintsPresent: true, consoleErrors: 0, failedRequests: 0, verdict: "OK", profileFound: true };

test("classifyParity: manual works + temp fails + parity works => AUTOMATION_OR_BROWSER_POSTURE", () => {
  const r = classifyParity({ manual: { works: true }, temp: tempFail, parity: parityOk, installedEdgeVersion: "149.0.4022.96" });
  assert.equal(r.classification, "AUTOMATION_OR_BROWSER_POSTURE");
  const codes = r.subReasons.map((s) => s.code);
  assert.ok(codes.includes("TEMP_PROFILE_USED"));
  assert.ok(codes.includes("MISSING_COOKIES"));
  assert.ok(codes.includes("HEADLESS_MODE"));
});

test("classifyParity: temp-only block (parity works) does NOT emit SITE_REJECTS_AUTOMATED_BROWSER", () => {
  const r = classifyParity({ manual: { works: true }, temp: tempFail, parity: parityOk, installedEdgeVersion: "149.0.4022.96" });
  const codes = r.subReasons.map((s) => s.code);
  assert.ok(!codes.includes("SITE_REJECTS_AUTOMATED_BROWSER"), "should not blame the site when an automated browser (parity) worked");
});

test("classifyParity: manual works but mixed automated results => INCONCLUSIVE only when manual fails+mixed", () => {
  // manual fails, parity works, temp fails => INCONCLUSIVE (not NO_FAILURE_REPRODUCED)
  const r = classifyParity({ manual: { works: false }, temp: { ...tempFail }, parity: { ...parityOk, works: true }, installedEdgeVersion: "149" });
  assert.equal(r.classification, "INCONCLUSIVE");
});

test("classifyParity: parity also blocked while manual works => SITE_REJECTS_AUTOMATED_BROWSER", () => {
  const parityBlocked = { ...parityOk, works: false, verdict: "BOT_CHALLENGE", webdriver: true };
  const r = classifyParity({ manual: { works: true }, temp: tempFail, parity: parityBlocked, installedEdgeVersion: "149.0.4022.96" });
  assert.equal(r.classification, "AUTOMATION_OR_BROWSER_POSTURE");
  const codes = r.subReasons.map((s) => s.code);
  assert.ok(codes.includes("SITE_REJECTS_AUTOMATED_BROWSER"));
  assert.ok(codes.includes("CLIENT_POSTURE_POLICY"));
});

test("classifyParity: manual fails too => NETWORK_OR_SITE_FAILURE", () => {
  const r = classifyParity({ manual: { works: false }, temp: tempFail, parity: { ...parityOk, works: false }, installedEdgeVersion: "149" });
  assert.equal(r.classification, "NETWORK_OR_SITE_FAILURE");
  assert.deepEqual(r.subReasons, []);
});

test("classifyParity: everything works => NO_FAILURE_REPRODUCED", () => {
  const r = classifyParity({ manual: { works: true }, temp: { ...tempFail, works: true, verdict: "OK" }, parity: parityOk });
  assert.equal(r.classification, "NO_FAILURE_REPRODUCED");
});

test("classifyParity: Chromium fallback => BROWSER_VERSION_MISMATCH", () => {
  const tempChromium = { ...tempFail, engine: "Chromium", edgeVersion: "" };
  const r = classifyParity({ manual: { works: true }, temp: tempChromium, parity: parityOk, installedEdgeVersion: "149.0.4022.96" });
  assert.ok(r.subReasons.some((s) => s.code === "BROWSER_VERSION_MISMATCH"));
});

test("classifyParity: copied profile + parity fail => PROFILE_NOT_LOADED", () => {
  const parityCopied = { ...parityOk, works: false, copiedProfileUsed: true, verdict: "ERROR" };
  const r = classifyParity({ manual: { works: true }, temp: { ...tempFail, works: true }, parity: parityCopied, installedEdgeVersion: "149" });
  assert.ok(r.subReasons.some((s) => s.code === "PROFILE_NOT_LOADED"));
});

// ---- comparison rows + fixes ----------------------------------------------
test("parityComparisonRows produces the full field set", () => {
  const report = {
    installedEdge: { version: "149.0.4022.96" },
    systemProxy: { enabled: false },
    cookiesAvailable: true,
    temp: { profileType: "temporary", headless: true, cookiesPresent: 0, snapshot: { userAgent: "ua", edgeVersion: "149.0.4022.96", platform: "Win32", timezone: "America/Los_Angeles", language: "en-US", languages: ["en-US"], webdriver: true, clientHintsPresent: true, screen: { width: 1920, height: 1080 }, viewport: { width: 1280, height: 720 }, localStoragePresent: false } },
    parity: { profileType: "persistent", headless: false, cookiesPresent: 12, snapshot: { userAgent: "ua2", edgeVersion: "149.0.4022.96", platform: "Win32", timezone: "America/Los_Angeles", language: "en-US", languages: ["en-US"], webdriver: false, clientHintsPresent: true, screen: { width: 1920, height: 1080 }, viewport: { width: 1536, height: 864 }, localStoragePresent: true } },
  };
  const rows = parityComparisonRows(report);
  const fields = rows.map((r) => r.field);
  for (const f of ["Normal Edge version", "Automated Edge version", "User agent", "Client hints", "OS / platform", "Timezone", "Language", "Viewport / screen", "Proxy settings", "Profile type", "Cookies present", "Local storage present", "navigator.webdriver", "Headless"]) {
    assert.ok(fields.includes(f), `missing field ${f}`);
  }
  const wd = rows.find((r) => r.field === "navigator.webdriver");
  assert.equal(wd.automatedTemp, "true");
  assert.equal(wd.automatedParity, "false");
});

test("recommendedFixes maps sub-reasons to actionable guidance", () => {
  const fixes = recommendedFixes({ classification: "AUTOMATION_OR_BROWSER_POSTURE", subReasons: [{ code: "HEADLESS_MODE" }, { code: "MISSING_COOKIES" }] });
  assert.ok(fixes.some((f) => /headed/i.test(f)));
  assert.ok(fixes.some((f) => /persistent profile|cookies/i.test(f)));
});

// ---- config: browser block normalisation ----------------------------------
test("loadConfig exposes a normalised browser block with parity defaults", () => {
  const cfg = loadConfig({}, "does-not-exist.json");
  assert.equal(cfg.browser.mode, "manual-parity");
  assert.equal(cfg.browser.channel, "msedge");
  assert.equal(cfg.browser.headless, false);
  assert.equal(cfg.browser.usePersistentProfile, true);
  assert.equal(cfg.browser.profileDirectory, "Default");
  assert.equal(cfg.browser.useSystemProxy, true);
  assert.equal(cfg.browser.viewport, null);
});

test("normalizeBrowser constrains enums and coerces booleans", () => {
  const b = normalizeBrowser({ mode: "bogus", channel: "lynx", headless: "true", usePersistentProfile: "0", viewport: { width: "100", height: "200" } }, {});
  assert.equal(b.mode, DEFAULTS.browser.mode);
  assert.equal(b.channel, DEFAULTS.browser.channel);
  assert.equal(b.headless, true);
  assert.equal(b.usePersistentProfile, false);
  assert.deepEqual(b.viewport, { width: 100, height: 200 });
});

test("normalizeBrowser applies env overrides", () => {
  const b = normalizeBrowser({}, { BROWSER_MODE: "automated", BROWSER_HEADLESS: "1", PROFILE_DIRECTORY: "Profile 1", USE_SYSTEM_PROXY: "false" });
  assert.equal(b.mode, "automated");
  assert.equal(b.headless, true);
  assert.equal(b.profileDirectory, "Profile 1");
  assert.equal(b.useSystemProxy, false);
});

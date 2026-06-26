// diagnosis.test.mjs — unit tests for the staged diagnostic pipeline. Pure
// functions only; no browser or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreBrowserTrust, trustBand, browserEnvironmentStatus,
  assessPathValidity, rootCause, diagnoseHost, ipReputationAllowed,
  scoreConfidences, envFromMeta,
  BROWSER_ENV, PATH_VALIDITY, PRIMARY, DIAG_VERDICT, SECONDARY, RELIABILITY,
} from "../src/core/diagnosis.mjs";

// Reusable environments.
const HEADED_PERSISTENT = { headless: false, profileType: "persistent", webdriver: false, cookiesPresent: 10, localStoragePresent: true, engine: "Edge", edgeVersion: "149", installedEdgeVersion: "149", clientHintsPresent: true };
const HEADED_PARITY_COPIED = { headless: false, profileType: "copied", webdriver: true, cookiesPresent: 5, localStoragePresent: true, engine: "Edge", edgeVersion: "149", installedEdgeVersion: "149", clientHintsPresent: true };
const HEADLESS_PARITY_COPIED = { ...HEADED_PARITY_COPIED, headless: true };
const HEADLESS_TEMP_STEALTH = { headless: true, profileType: "temporary", webdriver: true, cookiesPresent: 0, localStoragePresent: false, sessionStoragePresent: false, engine: "Edge" };

// ---- Stage 1: trust score + bands ----------------------------------------
test("trustBand maps scores to bands at the boundaries", () => {
  assert.equal(trustBand(100), "Trusted");
  assert.equal(trustBand(95), "Trusted");
  assert.equal(trustBand(94), "Mostly Trusted");
  assert.equal(trustBand(70), "Mostly Trusted");
  assert.equal(trustBand(69), "Questionable");
  assert.equal(trustBand(40), "Questionable");
  assert.equal(trustBand(39), "Untrusted");
  assert.equal(trustBand(0), "Untrusted");
});

test("scoreBrowserTrust: headed persistent real Edge is Trusted (PASS)", () => {
  const t = scoreBrowserTrust(HEADED_PERSISTENT);
  assert.equal(t.score, 100);
  assert.equal(t.band, "Trusted");
  assert.equal(browserEnvironmentStatus(HEADED_PERSISTENT, t), BROWSER_ENV.PASS);
});

test("scoreBrowserTrust: headed parity (copied, webdriver) is Mostly Trusted (PASS)", () => {
  const t = scoreBrowserTrust(HEADED_PARITY_COPIED); // -5 copied -10 webdriver
  assert.equal(t.score, 85);
  assert.equal(browserEnvironmentStatus(HEADED_PARITY_COPIED, t), BROWSER_ENV.PASS);
});

test("scoreBrowserTrust: headless parity is Questionable (WARNING)", () => {
  const t = scoreBrowserTrust(HEADLESS_PARITY_COPIED); // -35 -5 -10 = 50
  assert.equal(t.score, 50);
  assert.equal(browserEnvironmentStatus(HEADLESS_PARITY_COPIED, t), BROWSER_ENV.WARNING);
});

test("scoreBrowserTrust: headless temp stealth is Untrusted (FAILED)", () => {
  const t = scoreBrowserTrust(HEADLESS_TEMP_STEALTH); // -35 -25 -15 -8 -10 = 7
  assert.equal(t.band, "Untrusted");
  assert.equal(browserEnvironmentStatus(HEADLESS_TEMP_STEALTH, t), BROWSER_ENV.FAILED);
});

// ---- Stage 2: path validity ----------------------------------------------
test("assessPathValidity: one control OK + one fail => VALID", () => {
  const perPath = { direct: { verdict: "OK", status: 200 }, gsa: { verdict: "IP_REPUTATION", status: 403 } };
  assert.equal(assessPathValidity({ perPath, browserStatus: BROWSER_ENV.WARNING }), PATH_VALIDITY.VALID);
});

test("assessPathValidity: BOTH fail (block) + untrusted browser => TOOL_BROWSER_BLOCKED", () => {
  const perPath = { direct: { verdict: "BLOCKED", status: 403 }, gsa: { verdict: "BLOCKED", status: 403 } };
  assert.equal(assessPathValidity({ perPath, browserStatus: BROWSER_ENV.FAILED }), PATH_VALIDITY.TOOL_BLOCKED);
});

test("assessPathValidity: BOTH fail (block) + manual works => TOOL_BROWSER_BLOCKED (not network)", () => {
  const perPath = { direct: { verdict: "IP_REPUTATION", status: 403, vendor: "Akamai" }, gsa: { verdict: "IP_REPUTATION", status: 403, vendor: "Akamai" } };
  assert.equal(assessPathValidity({ perPath, browserStatus: BROWSER_ENV.WARNING, manualWorks: true }), PATH_VALIDITY.TOOL_BLOCKED);
});

test("assessPathValidity: BOTH error at network layer => INCONCLUSIVE", () => {
  const perPath = { direct: { verdict: "ERROR" }, gsa: { verdict: "ERROR" } };
  assert.equal(assessPathValidity({ perPath, browserStatus: BROWSER_ENV.PASS }), PATH_VALIDITY.BOTH_FAILED);
});

test("assessPathValidity: AUTH short-circuits", () => {
  const perPath = { gsa: { verdict: "AUTH_REQUIRED", status: 401 } };
  assert.equal(assessPathValidity({ perPath, browserStatus: BROWSER_ENV.PASS }), PATH_VALIDITY.AUTH);
});

// ---- The user's reported bug: BOTH-FAIL must NOT be IP_REPUTATION ----------
test("diagnoseHost: manual works, Direct 403, GSA 403, same Akamai => AUTOMATION_OR_BROWSER_POSTURE / TOOL_BROWSER_BLOCKED", () => {
  const perPath = {
    direct: { verdict: "IP_REPUTATION", status: 403, vendor: "Akamai", abck: "passed", reference: "#18.4e10" },
    gsa: { verdict: "IP_REPUTATION", status: 403, vendor: "Akamai", abck: "passed", reference: "#18.67c8" },
  };
  const d = diagnoseHost({ perPath, env: HEADLESS_PARITY_COPIED, manualWorks: true });
  assert.equal(d.primaryDiagnosis, PRIMARY.BROWSER_POSTURE);
  assert.equal(d.verdict, DIAG_VERDICT.TOOL_BROWSER_BLOCKED);
  assert.equal(d.pathValidity, PATH_VALIDITY.TOOL_BLOCKED);
  assert.notEqual(d.primaryDiagnosis, PRIMARY.IP_REPUTATION);
  assert.equal(d.secondaryReason, SECONDARY.HEADLESS_MODE);
  assert.ok(d.recommendation.length > 0);
});

// ---- IP_REPUTATION is allowed only when trusted + valid + control OK -------
test("diagnoseHost: OK direct + GSA 403 on a TRUSTED browser => IP_REPUTATION / NETWORK_CAUSED", () => {
  const perPath = {
    direct: { verdict: "OK", status: 200 },
    gsa: { verdict: "IP_REPUTATION", status: 403, vendor: "Akamai", abck: "passed" },
  };
  const d = diagnoseHost({ perPath, env: HEADED_PERSISTENT });
  assert.equal(d.pathValidity, PATH_VALIDITY.VALID);
  assert.equal(d.primaryDiagnosis, PRIMARY.IP_REPUTATION);
  assert.equal(d.verdict, DIAG_VERDICT.NETWORK_CAUSED);
  assert.equal(d.reliability, RELIABILITY.HIGH);
});

test("diagnoseHost: OK direct + GSA 403 on a HEADLESS browser => IP_REPUTATION downgraded to WAF", () => {
  const perPath = {
    direct: { verdict: "OK", status: 200 },
    gsa: { verdict: "IP_REPUTATION", status: 403, vendor: "Akamai", abck: "passed" },
  };
  const d = diagnoseHost({ perPath, env: HEADLESS_PARITY_COPIED });
  assert.equal(d.pathValidity, PATH_VALIDITY.VALID);
  assert.equal(d.primaryDiagnosis, PRIMARY.WAF); // not IP_REPUTATION — browser not PASS
});

test("ipReputationAllowed: requires PASS + control OK + hard deny + sensor passed", () => {
  const perPath = { direct: { verdict: "OK" }, gsa: { verdict: "IP_REPUTATION", status: 403, abck: "passed" } };
  assert.equal(ipReputationAllowed({ trust: { score: 100 }, browserEnvironment: BROWSER_ENV.PASS, perPath }), true);
  assert.equal(ipReputationAllowed({ trust: { score: 100 }, browserEnvironment: BROWSER_ENV.WARNING, perPath }), false);
  const noControl = { gsa: { verdict: "IP_REPUTATION", status: 403, abck: "passed" } };
  assert.equal(ipReputationAllowed({ trust: { score: 100 }, browserEnvironment: BROWSER_ENV.PASS, perPath: noControl }), false);
  const soft = { direct: { verdict: "OK" }, gsa: { verdict: "IP_REPUTATION", status: 200, abck: "passed" } };
  assert.equal(ipReputationAllowed({ trust: { score: 100 }, browserEnvironment: BROWSER_ENV.PASS, perPath: soft }), false);
});

// ---- Root cause mapping ---------------------------------------------------
test("rootCause maps transport + WAF reasons", () => {
  assert.equal(rootCause({ gsa: { verdict: "ERROR", reason: "DNS_FAILURE" } }), PRIMARY.DNS);
  assert.equal(rootCause({ gsa: { verdict: "ERROR", reason: "TLS_FAILURE" } }), PRIMARY.TLS);
  assert.equal(rootCause({ gsa: { verdict: "BLOCKED", reason: "WAF_BLOCK" } }), PRIMARY.WAF);
  assert.equal(rootCause({ direct: { verdict: "OK" }, gsa: { verdict: "BLOCKED", reason: "HTTP_403" } }), PRIMARY.NETWORK);
});

// ---- Confidence separation ------------------------------------------------
test("scoreConfidences: untrusted browser caps network diagnosis but floors a tool-blocked call", () => {
  const perPath = { direct: { verdict: "BLOCKED", status: 403 }, gsa: { verdict: "BLOCKED", status: 403 } };
  const c = scoreConfidences({ trust: { score: 10 }, browserStatus: BROWSER_ENV.FAILED, pathValidity: PATH_VALIDITY.TOOL_BLOCKED, perPath });
  assert.equal(c.browserTrust, 10);
  assert.ok(c.diagnosis >= 75, `tool-blocked diagnosis should be confident, got ${c.diagnosis}`);

  const cNet = scoreConfidences({ trust: { score: 10 }, browserStatus: BROWSER_ENV.FAILED, pathValidity: PATH_VALIDITY.VALID, perPath: { direct: { verdict: "OK" }, gsa: { verdict: "BLOCKED" } } });
  assert.ok(cNet.diagnosis <= 35, `untrusted network diagnosis should be capped, got ${cNet.diagnosis}`);
});

// ---- Meta bridge ----------------------------------------------------------
test("envFromMeta merges launch meta + environment snapshot", () => {
  const meta = {
    browser: { headless: true, profileType: "copied", channel: "msedge", mode: "manual-parity" },
    environment: { webdriver: true, engine: "Edge", edgeVersion: "149.0.1", localStoragePresent: true, clientHintsPresent: true },
    installedEdgeVersion: "149.0.1", cookiesPresent: 7,
  };
  const env = envFromMeta(meta);
  assert.equal(env.headless, true);
  assert.equal(env.profileType, "copied");
  assert.equal(env.webdriver, true);
  assert.equal(env.cookiesPresent, 7);
  assert.equal(env.installedEdgeVersion, "149.0.1");
});

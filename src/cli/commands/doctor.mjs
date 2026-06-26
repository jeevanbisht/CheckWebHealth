// doctor.mjs — preflight environment check: Node, Playwright, a launchable
// browser, and outbound network. Prints a friendly checklist (or --json) and
// exits non-zero when a required check fails, so it works in CI gates too.
//
// Also reports Manual Browser Parity posture (real Edge, profile, lock, proxy,
// automation detectability, cookies) so users can see whether the diagnostic
// browser matches their normal Edge.
import { loadConfig, normalizeBrowser } from "../../core/config.mjs";
import {
  detectEdge, detectProfileLock, detectSystemProxy, resolveUserDataDir,
  cookiesAvailable, profileExists,
} from "../../core/browser-parity.mjs";

const checks = [];
function add(name, ok, detail, fatal = true) { checks.push({ name, ok, detail, fatal }); }

async function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(t); }
}

export async function doctor(options = {}) {
  checks.length = 0;
  // 1. Node version
  const major = Number(process.versions.node.split(".")[0]);
  add(`Node.js ${process.versions.node}`, major >= 18, major >= 18 ? "" : "need >= 18 — upgrade from https://nodejs.org");

  // 2. Playwright package
  let playwrightOk = false;
  try { await import("playwright"); playwrightOk = true; add("Playwright package", true, ""); }
  catch { add("Playwright package", false, "run: npm install"); }

  // 3. A launchable browser (only if Playwright imported)
  if (playwrightOk) {
    try {
      const { launchBrowser } = await import("../../core/probe-core.mjs");
      const { browser, meta } = await withTimeout(launchBrowser(), 30000);
      await browser.close().catch(() => {});
      add(`Browser (${meta.channel})`, true, "");
    } catch (e) {
      add("Browser", false, `run: npx playwright install chromium msedge  (${(e.message || "").split("\n")[0]})`);
    }
  } else {
    add("Browser", false, "skipped — Playwright not installed", false);
  }

  // 4. Outbound network (used for the egress IP/ASN capture)
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch("https://ipinfo.io/json", { signal: ctrl.signal });
    clearTimeout(t);
    add("Network (outbound 443)", res.ok, res.ok ? "" : `HTTP ${res.status}`, false);
  } catch (e) {
    add("Network (outbound 443)", false, `unreachable (${(e.message || "").split("\n")[0]})`, false);
  }

  // 5. Manual Browser Parity posture (informational — never fatal).
  const parity = await parityChecks(options);

  const fatalFail = checks.some((c) => c.fatal && !c.ok);
  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: !fatalFail, checks, parity }, null, 2) + "\n");
  } else {
    for (const c of checks) {
      const mark = c.ok ? "\u2713" : (c.fatal ? "\u2717" : "!");
      process.stdout.write(`  ${mark} ${c.name}${c.detail ? "  — " + c.detail : ""}\n`);
    }
    process.stdout.write("\nBrowser parity (manual-parity mode):\n");
    for (const c of parity.checks) {
      const mark = c.ok ? "\u2713" : "!";
      process.stdout.write(`  ${mark} ${c.name}${c.detail ? "  — " + c.detail : ""}\n`);
    }
    if (parity.fixes.length) {
      process.stdout.write("\nRecommended fixes:\n");
      for (const f of parity.fixes) process.stdout.write(`  * ${f}\n`);
    }
    process.stdout.write(fatalFail ? "\nNot ready. Resolve the \u2717 items above.\n" : "\nReady.\n");
  }
  return fatalFail ? 1 : 0;
}

// Build the Manual Browser Parity section of the doctor report. Every item is
// informational (non-fatal): it tells the user whether the diagnostic browser
// will match their normal Edge. Recommended fixes are derived from the findings.
async function parityChecks(options = {}) {
  const out = [];
  const fixes = [];
  const pc = (name, ok, detail) => out.push({ name, ok, detail: detail || "" });
  try {
    const cfg = loadConfig();
    const o = {};
    if (options["profile-directory"] !== undefined) o.profileDirectory = options["profile-directory"];
    if (options["user-data-dir"] !== undefined) o.userDataDir = options["user-data-dir"];
    const browserCfg = normalizeBrowser({ ...cfg.browser, ...o }, {});
    const userDataDir = resolveUserDataDir(browserCfg, {});

    const [edge, lock, proxy] = await Promise.all([
      detectEdge({}), detectProfileLock(userDataDir, {}), detectSystemProxy({}),
    ]);

    // Edge installed + version
    pc("Edge installed", edge.installed, edge.installed ? edge.path : "install Microsoft Edge for full parity (channel:msedge)");
    if (!edge.installed) fixes.push("Install Microsoft Edge so parity mode can use real Edge instead of bundled Chromium.");
    pc(`Edge version ${edge.version || "(unknown)"}`, !!edge.version, edge.version ? "" : "version not detected");

    // Selected profile found
    const found = profileExists(userDataDir, browserCfg.profileDirectory);
    pc(`Profile "${browserCfg.profileDirectory}" found`, found, found ? userDataDir : `not found under ${userDataDir}`);
    if (!found) fixes.push(`Profile "${browserCfg.profileDirectory}" not found — pick one with --profile-directory (e.g. "Profile 1").`);

    // Profile lock status
    pc("Profile lock status", !lock.locked, lock.locked ? lock.reason : "free");
    if (lock.locked) fixes.push("Close all Edge windows before running parity, or a copied diagnostic profile will be used.");

    // Headless status
    pc(`Headless: ${browserCfg.headless ? "yes" : "no (headed)"}`, !browserCfg.headless, browserCfg.headless ? "set headless:false to match your normal Edge window" : "");
    if (browserCfg.headless) fixes.push("Run headed (headless:false) so the diagnostic browser matches your visible Edge.");

    // System proxy detected
    pc("System proxy detected", true, proxy.enabled ? `${proxy.server} (${proxy.source})` : "none / direct");

    // Browser automation detectable (honest: parity does NOT hide webdriver)
    pc("Browser automation detectable", true, "navigator.webdriver is reported honestly (no stealth); some sites/policies may treat automation differently");

    // Cookies available
    const cookies = cookiesAvailable(userDataDir, browserCfg.profileDirectory);
    pc("Cookies available", cookies.available, cookies.available ? "profile has a cookie store" : "no cookie store found for this profile");
    if (!cookies.available) fixes.push("Selected profile has no cookies — confirm it is the profile you normally browse with.");
  } catch (e) {
    pc("Parity checks", false, (e.message || e).toString().split("\n")[0]);
  }
  return { checks: out, fixes };
}

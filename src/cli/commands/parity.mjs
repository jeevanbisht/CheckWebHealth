// parity.mjs (command) — Manual Browser Parity Mode.
//
// Runs the target URL through two automated browsers and compares them so the
// user can tell a real network/site failure apart from a failure caused by the
// diagnostic browser environment:
//
//   1. Automated Edge, *temporary profile* (the classic automation baseline).
//   2. Manual-parity Edge: real Edge, headed, the user's *real* persistent
//      profile (cookies/storage/language/timezone/proxy/preferences) — no
//      stealth, navigator.webdriver left honest.
//
// Writes parity-report.json, renders parity-report.html, and prints a verdict.
// This is diagnostics, not anti-bot bypass: nothing is hidden or spoofed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, normalizeBrowser } from "../../core/config.mjs";
import { classify, deriveReason, errorLayer } from "../../core/probe-core.mjs";
import {
  detectEdge, detectProfileLock, detectSystemProxy, resolveUserDataDir,
  cookiesAvailable, launchTempContext, launchParityContext, collectSnapshot,
  cleanupCopiedProfile, classifyParity, recommendedFixes, redactCookies, sanitizeUrlForReport,
} from "../../core/browser-parity.mjs";

const DEFAULT_TARGET = "https://www.bing.com";

function normalizeTargetUrl(input) {
  let s = String(input || "").trim();
  if (!s) return DEFAULT_TARGET;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  try { return new URL(s).toString(); } catch { return DEFAULT_TARGET; }
}

// Overlay resolved CLI flags onto the config's browser block.
function applyParityFlags(browserCfg, options) {
  const o = {};
  if (options["profile-directory"] !== undefined) o.profileDirectory = options["profile-directory"];
  if (options["user-data-dir"] !== undefined) o.userDataDir = options["user-data-dir"];
  if (options.mode !== undefined) o.mode = options.mode;
  if (options.channel !== undefined) o.channel = options.channel;
  if (options.headed !== undefined) o.headless = !options.headed;
  return normalizeBrowser({ ...browserCfg, ...o }, {});
}

// Navigate one context to the target and assess it. Reuses probe-core's proven
// classifier for the OK/BLOCKED/AUTH verdict, and collects an honest parity
// snapshot. Never reads cookie values — only counts cookies for the origin.
async function runPass(context, url, opts = {}) {
  const settleMs = opts.settleMs ?? 2000;
  const navTimeout = opts.navTimeout ?? 25000;
  const page = await context.newPage();
  let consoleErrors = 0, failedRequests = 0;
  page.on("console", (m) => { if (m.type() === "error") consoleErrors++; });
  page.on("requestfailed", () => { failedRequests++; });

  let status = null, verdict = "ERROR", reason = "UNKNOWN", finalUrl = url, title = "";
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeout });
    await page.waitForTimeout(settleMs);
    status = resp ? resp.status() : null;
    let body = "";
    try { body = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 2000) : "")); } catch { /* ignore */ }
    try { finalUrl = page.url(); } catch { /* ignore */ }
    try { title = (await page.title()).slice(0, 120); } catch { /* ignore */ }
    verdict = classify(status, body, "no-_abck", "-", finalUrl, []);
    reason = deriveReason(verdict, status, "", "-");
  } catch (e) {
    status = "ERR";
    verdict = "ERROR";
    reason = deriveReason("ERROR", "ERR", errorLayer(e.message));
  }

  let snapshot = {};
  try { snapshot = await collectSnapshot(page); } catch { /* page may be gone */ }
  let cookiesPresent = 0, cookieMeta = [];
  try { const cks = await context.cookies(url); cookiesPresent = cks.length; cookieMeta = redactCookies(cks); } catch { /* ignore */ }
  await page.close().catch(() => {});

  const works = verdict === "OK" || verdict === "AUTH_REQUIRED";
  return {
    status, verdict, reason, finalUrl: sanitizeUrlForReport(finalUrl), title, works,
    snapshot,
    cookiesPresent, cookieMeta,
    consoleErrors, failedRequests,
    // posture fields surfaced to the classifier:
    webdriver: snapshot.webdriver === true,
    clientHintsPresent: snapshot.clientHintsPresent !== false,
    edgeVersion: snapshot.edgeVersion || "",
    engine: snapshot.engine || "",
  };
}

function warn(line) { process.stderr.write(`  ! ${line}\n`); }

export async function parity(options = {}, positionals = []) {
  const cfg = loadConfig(process.env, "probe.config.json", options.output ? { outDir: options.output } : {});
  const browserCfg = applyParityFlags(cfg.browser, options);
  const url = normalizeTargetUrl(options.url || positionals[0] || DEFAULT_TARGET);
  const safeTarget = sanitizeUrlForReport(url);
  const outDir = cfg.outDir;
  mkdirSync(outDir, { recursive: true });

  const userDataDir = resolveUserDataDir(browserCfg, {});
  const [installedEdge, lock, systemProxy] = await Promise.all([
    detectEdge({}), detectProfileLock(userDataDir, {}), detectSystemProxy({}),
  ]);
  const cookieAvail = cookiesAvailable(userDataDir, browserCfg.profileDirectory);

  if (!options.json) {
    process.stdout.write(`Manual Browser Parity — target ${safeTarget}\n`);
    process.stdout.write(`  Edge: ${installedEdge.installed ? installedEdge.version || "installed" : "NOT FOUND"}  profile: ${browserCfg.profileDirectory}\n`);
  }

  // ---- Safety warnings (req #10) -----------------------------------------
  if (browserCfg.usePersistentProfile && !browserCfg.userDataDir) {
    warn("Parity mode opens your REAL Edge profile. Close all Edge windows first, or a copied diagnostic profile will be used.");
  }
  if (lock.locked) warn(`Edge profile appears locked: ${lock.reason}`);
  warn("Cookie/token VALUES are never printed, stored or put in the report — only names/counts.");

  // ---- Pass 1: automated temporary profile (headless baseline) -----------
  let temp = { works: false, profileType: "temporary", headless: true, snapshot: {}, verdict: "ERROR" };
  let tempBrowser;
  try {
    const t = await launchTempContext(browserCfg, { headless: true });
    tempBrowser = t.browser;
    const r = await runPass(t.context, url, { settleMs: 2000, navTimeout: cfg.navTimeout });
    temp = { ...r, profileType: t.profileType, headless: t.headless, copiedProfileUsed: false };
    await t.context.close().catch(() => {});
  } catch (e) {
    temp.error = (e.message || e).toString().split("\n")[0];
  } finally {
    if (tempBrowser) await tempBrowser.close().catch(() => {});
  }
  if (!options.json) process.stdout.write(`  [1] temp profile (headless)   : ${temp.works ? "works" : "FAILS"}  (${temp.verdict} ${temp.status ?? ""})\n`);

  // ---- Pass 2: manual-parity (real profile, headed) ----------------------
  let parityRes = { works: false, profileType: "persistent", headless: browserCfg.headless, snapshot: {}, verdict: "ERROR" };
  let pc = null, copiedCleanup = null;
  try {
    pc = await launchParityContext(browserCfg, {});
    if (pc.copiedProfileUsed) { copiedCleanup = pc.userDataDir; warn("Real profile was locked — using a safe COPIED diagnostic profile for this run."); }
    const r = await runPass(pc.context, url, { settleMs: cfg.settleMs, navTimeout: cfg.navTimeout });
    parityRes = {
      ...r,
      profileType: pc.profileType,
      headless: pc.headless,
      copiedProfileUsed: pc.copiedProfileUsed,
      profileFound: pc.profileFound,
    };
  } catch (e) {
    parityRes.error = (e.message || e).toString().split("\n")[0];
  } finally {
    // Always close the context BEFORE removing the copied profile (so files are
    // unlocked), and always remove the copied profile so no cookies linger.
    if (pc && pc.context) await pc.context.close().catch(() => {});
    if (copiedCleanup) cleanupCopiedProfile(copiedCleanup);
  }
  if (!options.json) {
    const head = parityRes.headless ? "headless" : "headed";
    const label = parityRes.copiedProfileUsed ? `copied profile (${head})` : `real profile  (${head})`;
    process.stdout.write(`  [2] ${label}  : ${parityRes.works ? "works" : "FAILS"}  (${parityRes.verdict} ${parityRes.status ?? ""})\n`);
  }

  // ---- Classify ----------------------------------------------------------
  const manualWorks = !options["manual-fails"];
  const classification = classifyParity({
    manual: { works: manualWorks, source: options["manual-fails"] ? "reported-fails" : "assumed-works" },
    temp, parity: parityRes,
    installedEdgeVersion: installedEdge.version,
  });
  const fixes = recommendedFixes(classification, { profileLocked: lock.locked });

  // ---- Assemble + persist (sanitised: no cookie values) ------------------
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      target: safeTarget,
      browserConfig: browserCfg,
      userDataDir,
      note: "Manual Browser Parity diagnostics — no stealth/anti-bot bypass. Cookie/token values are never stored.",
    },
    installedEdge,
    profileLock: lock,
    systemProxy,
    cookiesAvailable: cookieAvail.available,
    manual: { works: manualWorks, source: options["manual-fails"] ? "user-reported-fails" : "assumed-works" },
    temp: stripSnapshotValues(temp),
    parity: stripSnapshotValues(parityRes),
    classification,
    recommendedFixes: fixes,
  };
  const jsonPath = join(outDir, "parity-report.json");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  // ---- Render HTML -------------------------------------------------------
  let htmlPath = "";
  try {
    const { renderParityReport } = await import("../../report/render-parity-html.mjs");
    htmlPath = renderParityReport(report, outDir);
  } catch (e) {
    warn(`HTML report skipped: ${(e.message || e).toString().split("\n")[0]}`);
  }

  // ---- Output ------------------------------------------------------------
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`\n  Manual Edge                       : ${manualWorks ? "works (assumed/observed)" : "FAILS (reported)"}\n`);
    process.stdout.write(`  Automated Edge temporary profile  : ${temp.works ? "works" : "FAILS"}\n`);
    process.stdout.write(`  Automated Edge manual-parity      : ${parityRes.works ? "works" : "FAILS"}${parityRes.copiedProfileUsed ? " (copied profile)" : ""}\n`);
    process.stdout.write(`\n  Classification: ${classification.classification}\n`);
    process.stdout.write(`  ${classification.summary}\n`);
    if (classification.subReasons.length) {
      process.stdout.write("  Sub-reasons:\n");
      for (const s of classification.subReasons) process.stdout.write(`    - ${s.code}: ${s.detail}\n`);
    }
    process.stdout.write("  Recommended fixes:\n");
    for (const f of fixes) process.stdout.write(`    * ${f}\n`);
    process.stdout.write(`\n  Wrote ${jsonPath}\n`);
    if (htmlPath) process.stdout.write(`  Wrote ${htmlPath}\n`);
  }

  if (options.open && htmlPath) openPath(htmlPath);
  return 0;
}

// Remove the verbose clientHints object's any-value-ish fields are safe (brands,
// platform), but drop the raw cookieMeta from the persisted pass to keep the
// report compact; keep only counts + redacted names.
function stripSnapshotValues(pass = {}) {
  const out = { ...pass };
  if (out.cookieMeta) out.cookieNames = out.cookieMeta.map((c) => c.name);
  delete out.cookieMeta;
  return out;
}

function openPath(target) {
  const platform = process.platform;
  const [cmd, args] = platform === "win32" ? ["cmd", ["/c", "start", "", target]]
    : platform === "darwin" ? ["open", [target]]
      : ["xdg-open", [target]];
  try {
    import("node:child_process").then(({ spawn }) => spawn(cmd, args, { stdio: "ignore", detached: true }).unref());
  } catch { /* best effort */ }
}

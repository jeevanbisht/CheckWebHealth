// doctor.mjs — preflight environment check: Node, Playwright, a launchable
// browser, and outbound network. Prints a friendly checklist (or --json) and
// exits non-zero when a required check fails, so it works in CI gates too.
const checks = [];
function add(name, ok, detail, fatal = true) { checks.push({ name, ok, detail, fatal }); }

async function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(t); }
}

export async function doctor(options = {}) {
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

  const fatalFail = checks.some((c) => c.fatal && !c.ok);
  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: !fatalFail, checks }, null, 2) + "\n");
  } else {
    for (const c of checks) {
      const mark = c.ok ? "\u2713" : (c.fatal ? "\u2717" : "!");
      process.stdout.write(`  ${mark} ${c.name}${c.detail ? "  — " + c.detail : ""}\n`);
    }
    process.stdout.write(fatalFail ? "\nNot ready. Resolve the \u2717 items above.\n" : "\nReady.\n");
  }
  return fatalFail ? 1 : 0;
}

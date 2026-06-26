// render-parity-html.mjs — render the Browser Parity Report as a shareable HTML
// page. Exported renderParityReport(report, outDir) writes parity-report.html
// and returns its path. Can also run standalone: it loads parity-report.json
// from the configured outDir.
//
// The report contains NO cookie/token values — only names, counts and honest
// browser facts — so it is safe to share when escalating.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parityComparisonRows } from "../core/browser-parity.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const CLASS_TONE = {
  AUTOMATION_OR_BROWSER_POSTURE: "warn",
  NETWORK_OR_SITE_FAILURE: "bad",
  NO_FAILURE_REPRODUCED: "ok",
  INCONCLUSIVE: "warn",
};

function workCell(works, extra = "") {
  return works
    ? `<span class="pill ok">works</span>${extra ? " " + esc(extra) : ""}`
    : `<span class="pill bad">fails</span>${extra ? " " + esc(extra) : ""}`;
}

export function renderParityReportHtml(report = {}) {
  const c = report.classification || {};
  const tone = CLASS_TONE[c.classification] || "warn";
  const rows = parityComparisonRows(report);
  const temp = report.temp || {}, parity = report.parity || {};
  const manualWorks = report.manual ? report.manual.works !== false : true;

  const threeRows = `
    <table class="cmp">
      <thead><tr><th>Browser</th><th>Result</th><th>Detail</th></tr></thead>
      <tbody>
        <tr><td>Manual Edge <span class="muted">(your normal browsing)</span></td>
            <td>${workCell(manualWorks)}</td>
            <td>${esc(report.manual && report.manual.source === "user-reported-fails" ? "reported as failing" : "assumed/observed working")}</td></tr>
        <tr><td>Automated Edge — temporary profile</td>
            <td>${workCell(temp.works)}</td>
            <td>${esc(temp.verdict || "")} ${esc(String(temp.status ?? ""))} · ${esc(temp.profileType || "temporary")} · headless=${esc(String(temp.headless === true))}</td></tr>
        <tr><td>Automated Edge — manual-parity profile</td>
            <td>${workCell(parity.works, parity.copiedProfileUsed ? "(copied profile)" : "")}</td>
            <td>${esc(parity.verdict || "")} ${esc(String(parity.status ?? ""))} · ${esc(parity.profileType || "persistent")} · headless=${esc(String(parity.headless === true))}</td></tr>
      </tbody>
    </table>`;

  const cmpRows = rows.map((r) => `
        <tr><td class="f">${esc(r.field)}</td><td>${esc(r.normal)}</td><td>${esc(r.automatedTemp)}</td><td>${esc(r.automatedParity)}</td></tr>`).join("");

  const subReasons = (c.subReasons || []).map((s) => `<li><code>${esc(s.code)}</code> — ${esc(s.detail)}</li>`).join("") || "<li class='muted'>none</li>";
  const fixes = (report.recommendedFixes || []).map((f) => `<li>${esc(f)}</li>`).join("");

  const proxy = report.systemProxy || {};
  const proxyStr = proxy.enabled ? `${esc(proxy.server || "configured")} (${esc(proxy.source)})` : "direct / none";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Browser Parity Report — CheckWebHealth</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 24px; background:#0d1117; color:#e6edf3; }
  .wrap { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; color:#9da7b3; text-transform: uppercase; letter-spacing:.04em; }
  .sub { color:#8b949e; margin:0 0 18px; }
  .banner { padding:14px 16px; border-radius:8px; margin: 12px 0 4px; border:1px solid; }
  .banner.warn { background:#3a2d00; border-color:#9e7b00; }
  .banner.bad  { background:#3a1416; border-color:#a23; }
  .banner.ok   { background:#0f2e1a; border-color:#2a7; }
  .banner b { font-size:15px; }
  table { width:100%; border-collapse: collapse; margin: 6px 0 8px; background:#161b22; border:1px solid #30363d; border-radius:8px; overflow:hidden; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #21262d; vertical-align: top; word-break: break-word; }
  th { background:#1b2129; color:#9da7b3; font-weight:600; }
  td.f, td.f { color:#9da7b3; white-space: nowrap; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-weight:600; font-size:12px; }
  .pill.ok { background:#133a22; color:#3fb950; border:1px solid #214; }
  .pill.bad { background:#3a1416; color:#f85149; }
  .muted { color:#6e7681; }
  code { background:#21262d; padding:1px 5px; border-radius:4px; font-size:12px; }
  ul { margin:6px 0; padding-left: 20px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit,minmax(200px,1fr)); gap:8px; }
  .kv { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:10px 12px; }
  .kv .k { color:#8b949e; font-size:12px; }
  .kv .v { font-weight:600; }
  footer { color:#6e7681; margin-top:24px; font-size:12px; }
</style></head>
<body><div class="wrap">
  <h1>Browser Parity Report</h1>
  <p class="sub">Target <code>${esc(report.meta && report.meta.target)}</code> · generated ${esc(report.meta && report.meta.generatedAt)}</p>

  <div class="banner ${tone}">
    <b>${esc(c.classification || "—")}</b><br>${esc(c.summary || "")}
  </div>

  <h2>Manual vs automated</h2>
  ${threeRows}

  <h2>Why (sub-reasons)</h2>
  <ul>${subReasons}</ul>

  <h2>Recommended fixes</h2>
  <ul>${fixes}</ul>

  <h2>Browser parity — field by field</h2>
  <table>
    <thead><tr><th>Field</th><th>Normal Edge</th><th>Automated · temp</th><th>Automated · parity</th></tr></thead>
    <tbody>${cmpRows}</tbody>
  </table>

  <h2>Environment</h2>
  <div class="grid">
    <div class="kv"><div class="k">Edge installed</div><div class="v">${esc(report.installedEdge && report.installedEdge.installed ? "yes" : "no")} ${esc((report.installedEdge && report.installedEdge.version) || "")}</div></div>
    <div class="kv"><div class="k">Profile</div><div class="v">${esc(report.meta && report.meta.browserConfig && report.meta.browserConfig.profileDirectory)}</div></div>
    <div class="kv"><div class="k">Profile lock</div><div class="v">${esc(report.profileLock && report.profileLock.locked ? "locked" : "free")}</div></div>
    <div class="kv"><div class="k">System proxy</div><div class="v">${proxyStr}</div></div>
    <div class="kv"><div class="k">Cookies on disk</div><div class="v">${esc(report.cookiesAvailable ? "available" : "unknown")}</div></div>
    <div class="kv"><div class="k">Copied profile used</div><div class="v">${esc(parity.copiedProfileUsed ? "yes" : "no")}</div></div>
  </div>

  <footer>
    No cookie or token values are included in this report — only names, counts and honest browser facts.
    Manual Browser Parity is a diagnostics aid (browser parity), not stealth or anti-bot bypass.
  </footer>
</div></body></html>`;
}

// Write the HTML next to the JSON; returns the path.
export function renderParityReport(report, outDir) {
  const html = renderParityReportHtml(report);
  const path = join(outDir, "parity-report.html");
  writeFileSync(path, html);
  return path;
}

// Standalone: load parity-report.json from the configured outDir and render.
if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && process.argv[1].endsWith("render-parity-html.mjs"))) {
  const { loadConfig } = await import("../core/config.mjs");
  const dir = loadConfig().outDir;
  const jsonPath = join(dir, "parity-report.json");
  if (!existsSync(jsonPath)) {
    console.error(`No parity-report.json at "${jsonPath}". Run "checkwebhealth parity <url>" first.`);
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(jsonPath, "utf8"));
  const out = renderParityReport(report, dir);
  console.log(`Wrote ${out}`);
}

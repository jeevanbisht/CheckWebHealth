// render-akamai-html.mjs <label>
// Renders a self-contained, print-ready HTML report from results-<label>.json
// produced by probe-akamai-browser.mjs. Screenshots (per host) are embedded inline.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const LABEL = process.argv[2] || "gsa";
const DIR = join("akamai-probe-results", LABEL);
const results = JSON.parse(readFileSync(join(DIR, `results-${LABEL}.json`), "utf8"));

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// map a result to its screenshot file (host[+path] sanitized like the probe did)
const shots = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".png")) : [];
function shotFor(url) {
  const u = new URL(url);
  const key = (u.host + u.pathname.replace(/\//g, "_").replace(/_$/, "")).replace(/[^\w.-]/g, "_");
  return shots.find((f) => f === key + ".png") || shots.find((f) => f.startsWith(u.host.replace(/[^\w.-]/g, "_")));
}
const dataUri = (file) => {
  try {
    return "data:image/png;base64," + readFileSync(join(DIR, file)).toString("base64");
  } catch {
    return null;
  }
};

const VCLASS = { BLOCKED: "blocked", CHALLENGE: "challenge", OK: "ok", ERROR: "err", "": "other" };
const counts = results.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] || 0) + 1), a), {});
const blocked = results.filter((r) => r.verdict === "BLOCKED" || r.verdict === "CHALLENGE");

const rows = results
  .map((r) => {
    const cls = VCLASS[r.verdict] || "other";
    const shot = shotFor(r.url);
    const uri = shot ? dataUri(shot) : null;
    const thumb = uri
      ? `<a href="${uri}" target="_blank"><img class="thumb" src="${uri}" alt="screenshot"/></a>`
      : "—";
    return `<tr class="${cls}">
      <td><span class="badge ${cls}">${esc(r.verdict)}</span></td>
      <td class="mono">${esc(r.status)}</td>
      <td class="mono">${esc(r.server)}</td>
      <td class="mono small">${esc(r.abck)}</td>
      <td class="mono small">${esc(r.akamaiGrn)}</td>
      <td><a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a><div class="title">${esc(r.title)}</div></td>
      <td>${thumb}</td>
    </tr>`;
  })
  .join("\n");

const now = new Date().toISOString();
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GSA × Akamai Bot Manager — Site Probe (${esc(LABEL)})</title>
<style>
  :root{--bg:#0b0e14;--card:#141923;--ink:#e6edf3;--mut:#9aa7b4;--line:#26303d;
    --blocked:#ff5c5c;--challenge:#ffb020;--ok:#3fb950;--err:#a371f7;--accent:#58a6ff;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;}
  .wrap{max-width:1100px;margin:0 auto;padding:32px 24px 64px;}
  h1{font-size:24px;margin:0 0 4px;}
  .sub{color:var(--mut);margin:0 0 20px;}
  .cards{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0 24px;}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;min-width:120px;}
  .kpi .n{font-size:26px;font-weight:700;}
  .kpi.blocked .n{color:var(--blocked)} .kpi.ok .n{color:var(--ok)}
  .kpi.challenge .n{color:var(--challenge)} .kpi.err .n{color:var(--err)}
  .kpi .l{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
  .insight{background:linear-gradient(90deg,#2a1416,#141923);border:1px solid #5b2b2b;border-left:4px solid var(--blocked);
    border-radius:10px;padding:14px 18px;margin:0 0 24px;}
  .insight b{color:var(--blocked)}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top;}
  th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);background:#0f141c;}
  tr:last-child td{border-bottom:none}
  tr.blocked{background:rgba(255,92,92,.05)} tr.challenge{background:rgba(255,176,32,.05)}
  .mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
  .small{font-size:12px;color:var(--mut)} .title{color:var(--mut);font-size:12px;margin-top:2px}
  a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
  .badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;}
  .badge.blocked{background:rgba(255,92,92,.15);color:var(--blocked)}
  .badge.challenge{background:rgba(255,176,32,.15);color:var(--challenge)}
  .badge.ok{background:rgba(63,185,80,.15);color:var(--ok)}
  .badge.err{background:rgba(163,113,247,.15);color:var(--err)}
  .badge.other{background:#222b38;color:var(--mut)}
  .thumb{width:120px;height:auto;border:1px solid var(--line);border-radius:6px;display:block}
  footer{color:var(--mut);font-size:12px;margin-top:24px}
  @media print{body{background:#fff;color:#000}.kpi,table,.insight{border-color:#ccc}a{color:#06c}}
</style></head>
<body><div class="wrap">
  <h1>GSA × Akamai Bot Manager — Site Probe</h1>
  <p class="sub">Run label <b>${esc(LABEL)}</b> · ${results.length} sites · real-Chromium probe (JS enabled, desktop fingerprint) · ${esc(now)}</p>

  <div class="cards">
    <div class="kpi blocked"><div class="n">${counts.BLOCKED || 0}</div><div class="l">Blocked (403/drop)</div></div>
    <div class="kpi challenge"><div class="n">${counts.CHALLENGE || 0}</div><div class="l">Challenged</div></div>
    <div class="kpi ok"><div class="n">${counts.OK || 0}</div><div class="l">OK</div></div>
    <div class="kpi err"><div class="n">${counts.ERROR || 0}</div><div class="l">Error / timeout</div></div>
  </div>

  <div class="insight">
    <b>Key finding:</b> Marriott's <span class="mono">_abck</span> shows the JS challenge <b>passed (~-1~)</b> yet the request still
    returned <b>403</b> — proving the block is driven by <b>egress-IP reputation</b>, not browser fingerprint or challenge-solving.
    This reproduces the Honda root cause on additional Akamai-protected domains.
  </div>

  <table>
    <thead><tr><th>Verdict</th><th>Status</th><th>Server</th><th>_abck</th><th>akamai-grn</th><th>URL / title</th><th>Shot</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <footer>
    Verdicts: <b>BLOCKED</b>=403/444 or "Access Denied" body · <b>CHALLENGE</b>=_abck stuck at ~0~ ·
    <b>OK</b>=2xx/3xx · <b>ERROR</b>=navigation failed/timeout.<br/>
    Source: <span class="mono">probe-akamai-browser.mjs --label ${esc(LABEL)}</span> · Reporter: @jeevanbisht
  </footer>
</div></body></html>`;

const out = join(DIR, `report-${LABEL}.html`);
writeFileSync(out, html);
console.log("Wrote", out, `(${blocked.length} blocked/challenged of ${results.length})`);

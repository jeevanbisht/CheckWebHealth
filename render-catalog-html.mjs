// render-catalog-html.mjs — tabbed-by-category HTML report from results-catalog.json
// Output: akamai-probe-results/catalog/report-catalog.html (self-contained, no deps)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join("akamai-probe-results", "catalog");
const results = JSON.parse(readFileSync(join(DIR, "results-catalog.json"), "utf8")).filter(Boolean);

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const VCLASS = { BLOCKED: "blocked", CHALLENGE: "challenge", OK: "ok", ERROR: "err", OTHER: "other" };

// group by category
const byCat = {};
for (const r of results) (byCat[r.category] ||= []).push(r);
const categories = Object.keys(byCat);

function summarize(rows) {
  const s = { total: rows.length, OK: 0, BLOCKED: 0, CHALLENGE: 0, ERROR: 0, OTHER: 0, akamai: 0, akamaiBlocked: 0, vendors: {} };
  for (const r of rows) {
    s[r.verdict] = (s[r.verdict] || 0) + 1;
    s.vendors[r.vendor] = (s.vendors[r.vendor] || 0) + 1;
    if (r.vendor === "Akamai") { s.akamai++; if (r.verdict === "BLOCKED" || r.verdict === "CHALLENGE") s.akamaiBlocked++; }
  }
  s.blockRate = s.total ? (((s.BLOCKED + s.CHALLENGE) / s.total) * 100).toFixed(0) : "0";
  s.akamaiBlockRate = s.akamai ? ((s.akamaiBlocked / s.akamai) * 100).toFixed(0) : "0";
  return s;
}

const overall = summarize(results);
const overallVendors = Object.entries(overall.vendors).sort((a, b) => b[1] - a[1]);

function pill(v, n) { return `<span class="badge ${VCLASS[v]}">${v} ${n}</span>`; }

function rowsHtml(rows) {
  return rows
    .slice()
    .sort((a, b) => (a.verdict === b.verdict ? a.host.localeCompare(b.host) : (a.verdict === "BLOCKED" ? -1 : b.verdict === "BLOCKED" ? 1 : 0)))
    .map((r) => `<tr class="${VCLASS[r.verdict]}">
      <td><span class="badge ${VCLASS[r.verdict]}">${esc(r.verdict)}</span></td>
      <td class="mono">${esc(r.status)}</td>
      <td>${esc(r.vendor)}</td>
      <td class="mono small">${esc(r.server)}</td>
      <td class="mono small">${esc(r.abck)}</td>
      <td><a href="${esc(r.url)}" target="_blank">${esc(r.host)}</a></td>
    </tr>`)
    .join("");
}

const tabs = categories
  .map((c, i) => {
    const s = summarize(byCat[c]);
    return `<button class="tab${i === 0 ? " active" : ""}" data-tab="cat${i}">
      ${esc(c)} <span class="tabcount ${s.blockRate > 0 ? "warn" : ""}">${s.BLOCKED + s.CHALLENGE}/${s.total}</span></button>`;
  })
  .join("");

const panels = categories
  .map((c, i) => {
    const rows = byCat[c];
    const s = summarize(rows);
    const vend = Object.entries(s.vendors).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)}: ${v}`).join(" · ");
    return `<section class="panel${i === 0 ? " active" : ""}" id="cat${i}">
      <h2>${esc(c)}</h2>
      <div class="summary">
        ${pill("OK", s.OK)} ${pill("BLOCKED", s.BLOCKED)} ${pill("CHALLENGE", s.CHALLENGE)} ${pill("ERROR", s.ERROR)}
        <span class="rate">Block rate: <b>${s.blockRate}%</b></span>
        <span class="rate">Akamai: <b>${s.akamai}</b> (blocked ${s.akamaiBlocked}, ${s.akamaiBlockRate}%)</span>
      </div>
      <div class="vendors">Vendors — ${vend}</div>
      <table><thead><tr><th>Verdict</th><th>Status</th><th>Vendor</th><th>Server</th><th>_abck</th><th>Host</th></tr></thead>
      <tbody>${rowsHtml(rows)}</tbody></table>
    </section>`;
  })
  .join("");

const now = new Date().toISOString();
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GSA × CDN/Bot-Manager — 50-Category Site Probe</title>
<style>
  :root{--bg:#0b0e14;--card:#141923;--ink:#e6edf3;--mut:#9aa7b4;--line:#26303d;
    --blocked:#ff5c5c;--challenge:#ffb020;--ok:#3fb950;--err:#a371f7;--accent:#58a6ff;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif}
  .wrap{max-width:1200px;margin:0 auto;padding:28px 20px 64px}
  h1{font-size:23px;margin:0 0 4px} h2{font-size:18px;margin:4px 0 12px}
  .sub{color:var(--mut);margin:0 0 18px}
  .cards{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:104px}
  .kpi .n{font-size:22px;font-weight:700}.kpi .l{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .kpi.blocked .n{color:var(--blocked)}.kpi.ok .n{color:var(--ok)}.kpi.challenge .n{color:var(--challenge)}.kpi.err .n{color:var(--err)}
  .vendbar{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 18px;font-size:12px;color:var(--mut)}
  .vendbar span{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:3px 9px}
  .tabs{display:flex;flex-wrap:wrap;gap:6px;margin:18px 0;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:5;border-bottom:1px solid var(--line)}
  .tab{background:var(--card);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:6px 11px;cursor:pointer;font-size:12px}
  .tab:hover{border-color:var(--accent)} .tab.active{border-color:var(--accent);background:#1b2433}
  .tabcount{color:var(--mut);font-size:11px;margin-left:4px}.tabcount.warn{color:var(--blocked)}
  .panel{display:none}.panel.active{display:block}
  .summary{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
  .rate{color:var(--mut);margin-left:8px}
  .vendors{color:var(--mut);font-size:12px;margin-bottom:10px}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--line)}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);background:#0f141c;position:sticky;top:52px}
  tr.blocked{background:rgba(255,92,92,.06)}tr.challenge{background:rgba(255,176,32,.06)}
  .mono{font-family:ui-monospace,Consolas,monospace}.small{font-size:12px;color:var(--mut)}
  a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  .badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600}
  .badge.blocked{background:rgba(255,92,92,.15);color:var(--blocked)}.badge.challenge{background:rgba(255,176,32,.15);color:var(--challenge)}
  .badge.ok{background:rgba(63,185,80,.15);color:var(--ok)}.badge.err{background:rgba(163,113,247,.15);color:var(--err)}
  .badge.other{background:#222b38;color:var(--mut)}
  footer{color:var(--mut);font-size:12px;margin-top:24px}
  @media print{body{background:#fff;color:#000}.tabs{position:static}.panel{display:block!important}.tab{display:none}}
</style></head><body><div class="wrap">
  <h1>GSA × CDN / Bot-Manager — 50-Category Site Probe</h1>
  <p class="sub">${results.length} sites · ${categories.length} categories · real-Chromium (JS, desktop fingerprint) · ${esc(now)}</p>

  <div class="cards">
    <div class="kpi ok"><div class="n">${overall.OK}</div><div class="l">OK</div></div>
    <div class="kpi blocked"><div class="n">${overall.BLOCKED}</div><div class="l">Blocked</div></div>
    <div class="kpi challenge"><div class="n">${overall.CHALLENGE}</div><div class="l">Challenge</div></div>
    <div class="kpi err"><div class="n">${overall.ERROR}</div><div class="l">Error</div></div>
    <div class="kpi blocked"><div class="n">${overall.blockRate}%</div><div class="l">Overall block rate</div></div>
    <div class="kpi"><div class="n">${overall.akamai}</div><div class="l">Akamai sites (${overall.akamaiBlockRate}% blkd)</div></div>
  </div>
  <div class="vendbar">${overallVendors.map(([k, v]) => `<span>${esc(k)}: <b>${v}</b></span>`).join("")}</div>

  <div class="tabs">${tabs}</div>
  ${panels}

  <footer>Verdicts: BLOCKED=403/429/444/503/denied-body · CHALLENGE=_abck ~0~ / JS interstitial · OK=2xx/3xx · ERROR=nav failed.<br/>
  Source: probe-catalog.mjs · Reporter: @jeevanbisht</footer>
</div>
<script>
  document.querySelectorAll(".tab").forEach(function(t){
    t.addEventListener("click",function(){
      document.querySelectorAll(".tab").forEach(function(x){x.classList.remove("active")});
      document.querySelectorAll(".panel").forEach(function(x){x.classList.remove("active")});
      t.classList.add("active");
      document.getElementById(t.dataset.tab).classList.add("active");
      window.scrollTo({top:0,behavior:"instant"});
    });
  });
</script></body></html>`;

const out = join(DIR, "report-catalog.html");
writeFileSync(out, html);
console.log("Wrote", out, "(" + results.length + " sites, " + categories.length + " categories)");
console.log("Overall:", JSON.stringify({ OK: overall.OK, BLOCKED: overall.BLOCKED, CHALLENGE: overall.CHALLENGE, ERROR: overall.ERROR, blockRate: overall.blockRate + "%" }));

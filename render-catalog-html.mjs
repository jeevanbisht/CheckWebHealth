// render-catalog-html.mjs — tabbed report with direct-vs-GSA delta.
// Loads results-<arm>.json files ({meta,results}); falls back to the legacy
// results-catalog.json array (single arm). When both a "direct" baseline and a
// "gsa" arm exist it computes a per-site delta and surfaces NETWORK-CAUSED
// blocks (OK direct -> not OK on GSA) — the only rows that prove the network is
// the cause. Output: akamai-probe-results/catalog/report-catalog.html
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join("akamai-probe-results", "catalog");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const VCLASS = { BLOCKED: "blocked", IP_REPUTATION: "iprep", HUMAN_CHALLENGE: "challenge", BOT_CHALLENGE: "challenge", AUTH_REQUIRED: "auth", AUTH: "auth", OK: "ok", ERROR: "err", OTHER: "other" };
const BLOCKish = ["BLOCKED", "IP_REPUTATION", "HUMAN_CHALLENGE", "BOT_CHALLENGE"];

// ---- load arms -------------------------------------------------------------
const arms = {}; // arm -> { meta, results }
for (const f of readdirSync(DIR)) {
  const m = f.match(/^results-([a-z0-9_-]+)\.json$/i);
  if (!m || m[1] === "catalog") continue;
  try {
    const obj = JSON.parse(readFileSync(join(DIR, f), "utf8"));
    if (obj && Array.isArray(obj.results)) arms[m[1]] = { meta: obj.meta || { arm: m[1] }, results: obj.results.filter(Boolean) };
  } catch {}
}
// legacy fallback
if (Object.keys(arms).length === 0 && existsSync(join(DIR, "results-catalog.json"))) {
  arms["gsa"] = { meta: { arm: "gsa" }, results: JSON.parse(readFileSync(join(DIR, "results-catalog.json"), "utf8")).filter(Boolean) };
}
const armNames = Object.keys(arms);
const dual = arms["direct"] && arms["gsa"];
const primaryArm = arms["gsa"] ? "gsa" : armNames[0];
const baselineArm = "direct";
const results = arms[primaryArm].results;

// index baseline by category|host for delta lookup
const baseIdx = {};
if (dual) for (const r of arms[baselineArm].results) baseIdx[r.category + "|" + r.host] = r;

function deltaFor(r) {
  if (!dual) return null;
  const b = baseIdx[r.category + "|" + r.host];
  if (!b) return "NO-BASELINE";
  const baseOk = b.verdict === "OK";
  const gsaOk = r.verdict === "OK";
  if (baseOk && !gsaOk) return "NETWORK-CAUSED";
  if (!baseOk && !gsaOk) return "BOTH-FAIL";
  if (!baseOk && gsaOk) return "GSA-BETTER";
  return "BOTH-OK";
}
const DCLASS = { "NETWORK-CAUSED": "blocked", "BOTH-FAIL": "challenge", "GSA-BETTER": "ok", "BOTH-OK": "ok", "NO-BASELINE": "other" };

// ---- summaries -------------------------------------------------------------
const byCat = {};
for (const r of results) (byCat[r.category] ||= []).push(r);
const categories = Object.keys(byCat);

function summarize(rows) {
  const s = { total: rows.length, OK: 0, BLOCKED: 0, IP_REPUTATION: 0, HUMAN_CHALLENGE: 0, BOT_CHALLENGE: 0, AUTH_REQUIRED: 0, ERROR: 0, OTHER: 0, akamai: 0, akamaiBlocked: 0, networkCaused: 0, vendors: {}, reasons: {} };
  for (const r of rows) {
    s[r.verdict] = (s[r.verdict] || 0) + 1;
    s.vendors[r.vendor] = (s.vendors[r.vendor] || 0) + 1;
    if (r.reason) s.reasons[r.reason] = (s.reasons[r.reason] || 0) + 1;
    if (r.vendor === "Akamai") { s.akamai++; if (BLOCKish.includes(r.verdict)) s.akamaiBlocked++; }
    if (dual && deltaFor(r) === "NETWORK-CAUSED") s.networkCaused++;
  }
  s.blockRate = s.total ? ((BLOCKish.reduce((a, v) => a + (s[v] || 0), 0) / s.total) * 100).toFixed(0) : "0";
  s.akamaiBlockRate = s.akamai ? ((s.akamaiBlocked / s.akamai) * 100).toFixed(0) : "0";
  return s;
}
const overall = summarize(results);

function pill(v, n) { return `<span class="badge ${VCLASS[v] || "other"}">${v} ${n}</span>`; }

function detailCell(r) {
  const probeMark = r.redirected || r.verdict === "OK" ? "✓" : "X";
  const finalMark = r.verdict === "OK" ? "✓" : "X";
  const waf = r.wafHeaders && Object.keys(r.wafHeaders).length
    ? Object.entries(r.wafHeaders).map(([k, v]) => esc(k) + "=" + esc(String(v).slice(0, 40))).join(" · ") : "";
  const layer = r.errorLayer ? ` <span class="tag">layer:${esc(r.errorLayer)}</span>` : "";
  const edge = r.edgeIp && r.edgeIp !== "-" ? ` <span class="tag">edge:${esc(r.edgeIp)}</span>` : "";
  const retry = r.retryAfter ? ` <span class="tag">retry-after:${esc(r.retryAfter)}</span>` : "";
  const recovered = r.retryRecovered ? ` <span class="tag" style="color:var(--challenge)">transient: ${esc(r.firstStatus)}→${esc(r.status)} (recovered on retry — see evidence shot)</span>` : "";
  const recheck = r.recheckVerdict && r.recheckVerdict !== r.verdict ? ` <span class="tag">re-checked: ${esc(r.recheckVerdict)} (${esc(r.recheckStatus)})</span>` : "";
  const reason = r.reason && r.reason !== "OK" ? ` <span class="tag" style="color:var(--accent)">reason:${esc(r.reason)}</span>` : "";
  const pass = r.passSummary && r.passSummary !== "PASS" ? ` <span class="tag">${esc(r.passSummary)}${Array.isArray(r.attemptLog) && r.attemptLog.length > 1 ? " (" + r.attemptLog.map((a) => esc(a.status)).join("→") + ")" : ""}</span>` : "";
  const ev = [];
  if (r.evidence && r.evidence.netlog) ev.push(`<a href="${esc(r.evidence.netlog)}" target="_blank">netlog</a>`);
  if (r.evidence && r.evidence.console) ev.push(`<a href="${esc(r.evidence.console)}" target="_blank">console</a>`);
  if (r.har) ev.push(`<a href="${esc(r.har)}" target="_blank">har</a>`);
  const evLinks = ev.length ? `<div class="small">evidence: ${ev.join(" · ")}</div>` : "";
  return `<a href="${esc(r.url)}" target="_blank">${esc(r.host)}</a>${edge}${layer}${reason}${pass}${retry}${recovered}${recheck}
    <div class="small">probe <b>${probeMark}</b>: <span class="mono">${esc(r.probeUrl || r.url)}</span></div>
    <div class="small">final <b>${finalMark}</b>: <span class="mono">${esc(r.finalUrl || r.url)}</span>${r.redirected ? " <b>(redirected)</b>" : ""}</div>
    ${waf ? `<div class="small mono">${waf}</div>` : ""}
    ${evLinks}
    <div class="small">${esc(r.title || "")}</div>`;
}

function thumb(r) {
  const shotPath = r.screenshot ? join(DIR, r.screenshot) : "";
  return shotPath && existsSync(shotPath)
    ? `<a href="${esc(r.screenshot)}" target="_blank"><img class="thumb" src="${esc(r.screenshot)}" alt="screenshot of ${esc(r.host)}"/></a>`
    : "—";
}

function deltaCell(r) {
  if (!dual) return "";
  const d = deltaFor(r);
  return `<td><span class="badge ${DCLASS[d]}">${esc(d)}</span></td>`;
}

function rowTr(r, withCategory) {
  const d = dual ? deltaFor(r) : "";
  return `<tr class="${VCLASS[r.verdict] || "other"}" data-verdict="${esc(r.verdict)}" data-vendor="${esc(r.vendor)}" data-status="${esc(r.status)}" data-delta="${esc(d)}">
    ${withCategory ? `<td class="small">${esc(r.category)}</td>` : ""}
    <td><span class="badge ${VCLASS[r.verdict] || "other"}">${esc(r.verdict)}</span></td>
    <td class="mono">${esc(r.status)}</td>
    <td>${esc(r.vendor)}</td>
    <td class="mono small">${esc(r.abck)}</td>
    <td class="refcell mono small">${esc(r.reference || "—")}</td>
    <td class="detailcell">${detailCell(r)}</td>
    ${deltaCell(r)}
    <td>${thumb(r)}</td>
  </tr>`;
}

function sortRows(rows, withCategory) {
  return rows.slice().sort((a, b) => {
    if (withCategory && a.category !== b.category) return a.category.localeCompare(b.category);
    const rank = (v) => (v === "NETWORK-CAUSED" ? 0 : BLOCKish.includes(v) ? 1 : 2);
    const ra = dual ? rank(deltaFor(a)) : rank(a.verdict);
    const rb = dual ? rank(deltaFor(b)) : rank(b.verdict);
    if (ra !== rb) return ra - rb;
    return a.host.localeCompare(b.host);
  });
}

const colspan = dual ? 8 : 7;
function tableHead(withCategory) {
  return `<thead><tr>${withCategory ? `<th class="sortable">Category</th>` : ""}<th class="sortable">Verdict</th><th class="sortable">Status</th><th class="sortable">Vendor</th><th class="sortable">_abck</th><th class="sortable">Reference</th><th class="sortable">URL details / signals</th>${dual ? `<th class="sortable">Direct vs GSA</th>` : ""}<th>Image</th></tr></thead>`;
}

function kpiBar(s) {
  const netKpi = dual ? `<button class="kpi kpi-filter blocked" data-filter="delta:NETWORK-CAUSED"><span class="badge blocked">NETWORK-CAUSED ${s.networkCaused}</span></button>` : "";
  return `<div class="summary">
    ${netKpi}
    <button class="kpi kpi-filter ok" data-filter="verdict:OK">${pill("OK", s.OK)}</button>
    <button class="kpi kpi-filter iprep" data-filter="verdict:IP_REPUTATION">${pill("IP_REPUTATION", s.IP_REPUTATION)}</button>
    <button class="kpi kpi-filter blocked" data-filter="verdict:BLOCKED">${pill("BLOCKED", s.BLOCKED)}</button>
    <button class="kpi kpi-filter challenge" data-filter="verdict:HUMAN_CHALLENGE">${pill("HUMAN", s.HUMAN_CHALLENGE)}</button>
    <button class="kpi kpi-filter challenge" data-filter="verdict:BOT_CHALLENGE">${pill("BOT", s.BOT_CHALLENGE)}</button>
    <button class="kpi kpi-filter auth" data-filter="verdict:AUTH_REQUIRED">${pill("AUTH", s.AUTH_REQUIRED)}</button>
    <button class="kpi kpi-filter err" data-filter="verdict:ERROR">${pill("ERROR", s.ERROR)}</button>
    <span class="rate">Block rate: <b>${s.blockRate}%</b></span>
    <span class="rate">Akamai: <b>${s.akamai}</b> (blocked ${s.akamaiBlocked}, ${s.akamaiBlockRate}%)</span>
  </div>`;
}

const allPanel = `<section class="panel active" id="all">
  <h2>All Categories</h2>
  ${kpiBar(overall)}
  <table>${tableHead(true)}<tbody>${sortRows(results, true).map((r) => rowTr(r, true)).join("")}</tbody></table>
</section>`;

const panels = categories.map((c, i) => {
  const rows = byCat[c];
  const s = summarize(rows);
  return `<section class="panel" id="cat${i}">
    <h2>${esc(c)}</h2>
    ${kpiBar(s)}
    <table>${tableHead(false)}<tbody>${sortRows(rows, false).map((r) => rowTr(r, false)).join("")}</tbody></table>
  </section>`;
}).join("");

const categoryTabs = categories.map((c, i) => {
  const s = summarize(byCat[c]);
  const warn = dual ? s.networkCaused : BLOCKish.reduce((a, v) => a + (s[v] || 0), 0);
  return `<button class="tab" data-tab="cat${i}">${esc(c)} <span class="tabcount ${warn > 0 ? "warn" : ""}">${dual ? s.networkCaused : BLOCKish.reduce((a, v) => a + (s[v] || 0), 0)}/${s.total}</span></button>`;
}).join("");

const allVendors = Object.entries(overall.vendors).sort((a, b) => b[1] - a[1]);
const statusCounts = {};
for (const r of results) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
const allStatuses = Object.keys(statusCounts).sort((a, b) => {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  const aNum = !isNaN(na), bNum = !isNaN(nb);
  if (aNum && bNum) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return String(a).localeCompare(String(b));
});

function egressLine(arm) {
  const m = arms[arm].meta || {};
  const e = m.egress || {};
  const b = m.browser || {};
  return `<div class="egress"><b>${esc(arm)}</b> · egress <span class="mono">${esc(e.ip || "?")}</span> ${esc(e.org || "")} ${esc(e.country || "")} · browser ${esc(b.channel || "?")} headless=${esc(String(b.headless))} stealth=${esc(String(b.stealth))} · ${esc(m.finishedAt || "")}</div>`;
}

const now = new Date().toISOString();
const headline = dual
  ? `${overall.networkCaused} NETWORK-CAUSED block(s) — sites that load on a direct connection but fail through GSA.`
  : `Single-arm run (${esc(primaryArm)}). Add a PROBE_ARM=direct baseline run to prove network causation.`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GSA × CDN/Bot-Manager — Site Probe</title>
<style>
  :root{--bg:#0b0e14;--card:#141923;--ink:#e6edf3;--mut:#9aa7b4;--line:#26303d;
    --blocked:#ff5c5c;--challenge:#ffb020;--ok:#3fb950;--err:#a371f7;--iprep:#ff8c42;--auth:#2dd4bf;--accent:#58a6ff;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif}
  .wrap{max-width:1280px;margin:0 auto;padding:28px 20px 64px}
  h1{font-size:23px;margin:0 0 4px} h2{font-size:18px;margin:4px 0 12px}
  .sub{color:var(--mut);margin:0 0 8px}
  .headline{background:#1b2433;border:1px solid var(--line);border-left:3px solid var(--blocked);border-radius:8px;padding:10px 14px;margin:8px 0 14px;font-weight:600}
  .egressbar{display:flex;flex-direction:column;gap:3px;margin:6px 0 14px;font-size:12px;color:var(--mut)}
  .egress .mono{color:var(--ink)}
  .cards{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:104px}
  .kpi .n{font-size:22px;font-weight:700}.kpi .l{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .kpi.blocked .n{color:var(--blocked)}.kpi.ok .n{color:var(--ok)}.kpi.challenge .n{color:var(--challenge)}.kpi.err .n{color:var(--err)}.kpi.iprep .n{color:var(--iprep)}.kpi.auth .n{color:var(--auth)}
  .kpi-filter{cursor:pointer;text-align:left;appearance:none;-webkit-appearance:none;font:inherit;color:inherit}
  .kpi-filter.active,.vendor-chip.active{outline:2px solid var(--accent);outline-offset:1px}
  .vendbar{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 18px;font-size:12px;color:var(--mut)}
  .statusbar{display:flex;align-items:center;gap:8px;margin:8px 0;font-size:12px;color:var(--mut)}
  .statusbar select{background:var(--card);border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:4px 8px;font:inherit;font-size:12px;cursor:pointer}
  .statusbar select:hover{border-color:var(--accent)}
  .export-btn{background:var(--card);border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:4px 11px;font:inherit;font-size:12px;cursor:pointer;margin-left:8px}
  .export-btn:hover{border-color:var(--accent);background:#1b2433}
  .vendor-chip{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:3px 9px;color:var(--ink);cursor:pointer;font-size:12px;appearance:none;-webkit-appearance:none;font:inherit}
  .tabs{display:flex;flex-wrap:wrap;gap:6px;margin:18px 0;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:5;border-bottom:1px solid var(--line)}
  .tab{background:var(--card);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:6px 11px;cursor:pointer;font-size:12px}
  .tab:hover{border-color:var(--accent)} .tab.active{border-color:var(--accent);background:#1b2433}
  .tabcount{color:var(--mut);font-size:11px;margin-left:4px}.tabcount.warn{color:var(--blocked)}
  .panel{display:none}.panel.active{display:block}
  .summary{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
  .rate{color:var(--mut);margin-left:8px}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:12px}
  th,td{padding:7px 10px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);background:#0f141c}
  th.sortable{cursor:pointer;user-select:none;white-space:nowrap}
  th.sortable:hover{color:var(--ink)}
  th.sortable::after{content:"\\2195";opacity:.35;margin-left:5px;font-size:10px}
  th.sortable.asc::after{content:"\\2191";opacity:1}
  th.sortable.desc::after{content:"\\2193";opacity:1}
  td.refcell{max-width:210px;overflow-wrap:anywhere;word-break:break-all}
  td.detailcell{max-width:420px;overflow-wrap:anywhere}
  td.detailcell .mono{overflow-wrap:anywhere;word-break:break-all}
  tr.blocked{background:rgba(255,92,92,.06)}tr.challenge{background:rgba(255,176,32,.06)}tr.iprep{background:rgba(255,140,66,.08)}
  .mono{font-family:ui-monospace,Consolas,monospace}.small{font-size:12px;color:var(--mut)}
  .tag{display:inline-block;background:#111723;border:1px solid var(--line);border-radius:4px;padding:0 5px;font-size:11px;color:var(--mut);font-family:ui-monospace,Consolas,monospace}
  a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  .badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600}
  .badge.blocked{background:rgba(255,92,92,.15);color:var(--blocked)}.badge.challenge{background:rgba(255,176,32,.15);color:var(--challenge)}
  .badge.ok{background:rgba(63,185,80,.15);color:var(--ok)}.badge.err{background:rgba(163,113,247,.15);color:var(--err)}
  .badge.iprep{background:rgba(255,140,66,.18);color:var(--iprep)}
  .badge.auth{background:rgba(45,212,191,.16);color:var(--auth)}
  .badge.other{background:#222b38;color:var(--mut)}
  .thumb{width:160px;height:auto;border:1px solid var(--line);border-radius:6px;display:block}
  .filter-state{margin:8px 0 4px;color:var(--mut);font-size:12px}.filter-state b{color:var(--ink)}
  .legend{margin:10px 0 0;color:var(--mut);font-size:12px;line-height:1.5}
  .legend code{background:#111723;border:1px solid var(--line);border-radius:4px;padding:0 5px;color:var(--ink)}
  footer{color:var(--mut);font-size:12px;margin-top:24px}
  @media print{body{background:#fff;color:#000}.tabs{position:static}.panel{display:block!important}.tab{display:none}}
</style></head><body><div class="wrap">
  <h1>GSA × CDN / Bot-Manager — Site Probe</h1>
  <p class="sub">${results.length} sites · ${categories.length} categories · arms: ${esc(armNames.join(", "))} · ${esc(now)}</p>
  <div class="headline">${esc(headline)}</div>
  <div class="egressbar">${armNames.map(egressLine).join("")}</div>

  <div class="cards">
    ${dual ? `<button class="kpi kpi-filter blocked" data-filter="delta:NETWORK-CAUSED"><div class="n">${overall.networkCaused}</div><div class="l">Network-caused</div></button>` : ""}
    <button class="kpi kpi-filter ok" data-filter="verdict:OK"><div class="n">${overall.OK}</div><div class="l">OK</div></button>
    <button class="kpi kpi-filter iprep" data-filter="verdict:IP_REPUTATION"><div class="n">${overall.IP_REPUTATION}</div><div class="l">IP reputation</div></button>
    <button class="kpi kpi-filter blocked" data-filter="verdict:BLOCKED"><div class="n">${overall.BLOCKED}</div><div class="l">Blocked</div></button>
    <button class="kpi kpi-filter challenge" data-filter="verdict:HUMAN_CHALLENGE"><div class="n">${overall.HUMAN_CHALLENGE}</div><div class="l">Human challenge</div></button>
    <button class="kpi kpi-filter challenge" data-filter="verdict:BOT_CHALLENGE"><div class="n">${overall.BOT_CHALLENGE}</div><div class="l">Bot challenge</div></button>
    <button class="kpi kpi-filter auth" data-filter="verdict:AUTH_REQUIRED"><div class="n">${overall.AUTH_REQUIRED}</div><div class="l">Auth required</div></button>
    <button class="kpi kpi-filter err" data-filter="verdict:ERROR"><div class="n">${overall.ERROR}</div><div class="l">Error</div></button>
  </div>
  <div class="vendbar">${allVendors.map(([k, v]) => `<button class="vendor-chip" data-filter="vendor:${esc(k)}">${esc(k)}: ${v}</button>`).join(" ")}</div>
  ${Object.keys(overall.reasons).length ? `<div class="vendbar"><span style="align-self:center">Top reasons:</span> ${Object.entries(overall.reasons).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `<span class="vendor-chip" style="cursor:default">${esc(k)}: ${v}</span>`).join(" ")}</div>` : ""}
  <div class="statusbar">
    <label for="statusFilter">Status:</label>
    <select id="statusFilter">
      <option value="">All (${results.length})</option>
      ${allStatuses.map((s) => `<option value="${esc(s)}">${esc(s)} (${statusCounts[s]})</option>`).join("")}
    </select>
    <button id="exportXls" class="export-btn" type="button">⤓ Export filtered (.xls)</button>
  </div>
  <div class="filter-state" id="filterState">Showing <b>all rows</b>. Click a verdict card and/or a vendor chip — they combine (e.g. OK + Akamai).</div>
  <div class="legend">
    <div><code>NETWORK-CAUSED</code> = loads OK on the <b>direct</b> baseline but fails through <b>GSA</b> — the actionable, network-attributable failures.</div>
    <div><code>IP_REPUTATION</code> = bot sensor validated the browser (<code>_abck passed</code>) yet the request was still denied ⇒ block is keyed on egress IP/ASN, not the browser. Strongest single signal for a CDN escalation.</div>
    <div><code>BLOCKED</code> = HTTP 403/429/444/451/503 or an access-denied block page (a real block).</div>
    <div><code>AUTH_REQUIRED</code> = expected authentication — a <code>401</code> or a redirect to a known identity provider (Entra/Azure AD, Okta, Ping, Duo, ADFS). Deliberately <b>not</b> counted as a block or network failure.</div>
    <div><code>HUMAN_CHALLENGE</code> = visible captcha / “verify you are human” interstitial.</div>
    <div><code>BOT_CHALLENGE</code> = JS/sensor challenge state (<code>_abck challenged</code> / Cloudflare cf-chl).</div>
    <div><code>reason:</code> = specific machine-readable cause (e.g. <code>DNS_FAILURE</code>, <code>TLS_FAILURE</code>, <code>TIMEOUT</code>, <code>HTTP_403</code>, <code>WAF_BLOCK</code>, <code>IP_REPUTATION</code>) · <code>FAILED_ONCE/TWICE/ALL</code> / <code>RECOVERED</code> = attempt history · <code>evidence:</code> = per-host network log / console / HAR for failed rows.</div>
    <div><code>edge:</code> = CDN edge IP that served the response · <code>layer:</code> = failed network layer (DNS/TCP/TLS/TIMEOUT/HTTP) for errors · <code>retry-after:</code> = throttle hint.</div>
    <div><code>Reference</code> = CDN/WAF trace ID to hand to support — Akamai <code>Reference #</code>/<code>errors.edgesuite.net</code>, Cloudflare <code>cf-ray</code>, or AWS CloudFront <code>x-amz-cf-id</code> (shown on failed rows).</div>
  </div>

  <div class="tabs"><button class="tab active" data-tab="all">All Categories <span class="tabcount ${(dual ? overall.networkCaused : 0) > 0 ? "warn" : ""}">${dual ? overall.networkCaused : BLOCKish.reduce((a, v) => a + (overall[v] || 0), 0)}/${overall.total}</span></button>${categoryTabs}</div>
  ${allPanel}
  ${panels}

  <footer>Verdicts: NETWORK-CAUSED=OK direct/fail GSA · IP_REPUTATION=abck passed but denied · BLOCKED=401/403/429/444/451/503/denied · HUMAN_CHALLENGE=captcha · BOT_CHALLENGE=sensor challenge · OK=2xx/3xx · ERROR=nav failed (see layer).<br/>
  Source: probe-core.mjs · Reporter: @jeevanbisht</footer>
</div>
<script>
  const activeFilters = { verdict: null, vendor: null, delta: null, status: null };
  const filterState = document.getElementById("filterState");
  const statusSelect = document.getElementById("statusFilter");
  function setActiveButtons() {
    document.querySelectorAll(".kpi-filter,.vendor-chip").forEach(function(el){
      const parts = el.dataset.filter.split(":");
      const type = parts[0], value = parts.slice(1).join(":");
      el.classList.toggle("active", activeFilters[type] === value);
    });
    if (statusSelect) statusSelect.value = activeFilters.status || "";
  }
  function rowMatches(row) {
    if (activeFilters.verdict !== null) {
      var ok = activeFilters.verdict.split(",").map(function(v){return v.trim();}).includes(row.dataset.verdict);
      if (!ok) return false;
    }
    if (activeFilters.vendor !== null && row.dataset.vendor !== activeFilters.vendor) return false;
    if (activeFilters.status !== null && row.dataset.status !== activeFilters.status) return false;
    if (activeFilters.delta !== null && row.dataset.delta !== activeFilters.delta) return false;
    return true;
  }
  function applyFilter() {
    const active = Object.keys(activeFilters).filter(function(k){ return activeFilters[k] !== null; })
      .map(function(k){ return k + ": " + activeFilters[k]; });
    const filterText = active.length ? active.join(" + ") : "all rows";
    filterState.innerHTML = "Showing <b>" + filterText + "</b>. Click a card/chip to toggle; click again to clear.";
    document.querySelectorAll("tbody tr").forEach(function(row){
      row.style.display = rowMatches(row) ? "" : "none";
    });
    setActiveButtons();
  }
  function setFilter(type, value) {
    if (activeFilters[type] === value) { activeFilters[type] = null; }
    else { activeFilters[type] = value; }
    applyFilter();
  }
  document.querySelectorAll(".tab").forEach(function(t){
    t.addEventListener("click",function(){
      document.querySelectorAll(".tab").forEach(function(x){x.classList.remove("active")});
      document.querySelectorAll(".panel").forEach(function(x){x.classList.remove("active")});
      t.classList.add("active");
      document.getElementById(t.dataset.tab).classList.add("active");
      applyFilter();
      window.scrollTo({top:0,behavior:"instant"});
    });
  });
  document.querySelectorAll(".kpi-filter,.vendor-chip").forEach(function(el){
    el.addEventListener("click", function(e){
      e.preventDefault();
      const parts = el.dataset.filter.split(":");
      setFilter(parts[0], parts.slice(1).join(":"));
    });
  });
  if (statusSelect) {
    statusSelect.addEventListener("change", function(){
      activeFilters.status = statusSelect.value || null;
      applyFilter();
    });
  }
  document.querySelectorAll("table thead th.sortable").forEach(function(th){
    th.addEventListener("click", function(){
      const table = th.closest("table");
      const headRow = th.parentNode;
      const idx = Array.prototype.indexOf.call(headRow.children, th);
      const asc = !th.classList.contains("asc");
      headRow.querySelectorAll("th").forEach(function(h){ h.classList.remove("asc","desc"); });
      th.classList.add(asc ? "asc" : "desc");
      const tbody = table.querySelector("tbody");
      const rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
      function cellVal(row){ const cell = row.children[idx]; return cell ? cell.textContent.trim() : ""; }
      const numeric = rows.every(function(r){ var v = cellVal(r).replace(/[^0-9.\\-]/g,""); return v === "" || !isNaN(parseFloat(v)); });
      rows.sort(function(a,b){
        var va = cellVal(a), vb = cellVal(b);
        if (numeric) {
          var na = parseFloat(va.replace(/[^0-9.\\-]/g,"")); var nb = parseFloat(vb.replace(/[^0-9.\\-]/g,""));
          if (isNaN(na)) na = -Infinity; if (isNaN(nb)) nb = -Infinity;
          return asc ? na - nb : nb - na;
        }
        return asc ? va.localeCompare(vb) : vb.localeCompare(va);
      });
      rows.forEach(function(r){ tbody.appendChild(r); });
    });
  });
  const exportBtn = document.getElementById("exportXls");
  if (exportBtn) {
    exportBtn.addEventListener("click", function(){
      const panel = document.querySelector(".panel.active");
      if (!panel) return;
      const table = panel.querySelector("table");
      if (!table) return;
      const heads = Array.prototype.slice.call(table.querySelectorAll("thead th"));
      const imgIdx = heads.findIndex(function(h){ return h.textContent.trim().toLowerCase() === "image"; });
      function keep(i){ return i !== imgIdx; }
      function xesc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
      var thtml = "<tr>";
      heads.forEach(function(h,i){ if (keep(i)) thtml += "<th>" + xesc(h.textContent.trim()) + "</th>"; });
      thtml += "</tr>";
      var bodyHtml = "";
      Array.prototype.slice.call(table.querySelectorAll("tbody tr")).forEach(function(row){
        if (row.style.display === "none") return;
        bodyHtml += "<tr>";
        Array.prototype.slice.call(row.children).forEach(function(cell,i){
          if (!keep(i)) return;
          var txt = cell.textContent.replace(/\\s+/g," ").trim();
          bodyHtml += "<td>" + xesc(txt) + "</td>";
        });
        bodyHtml += "</tr>";
      });
      const panelTitle = (panel.querySelector("h2") ? panel.querySelector("h2").textContent.trim() : "report");
      const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
      const html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">' +
        '<head><meta charset="utf-8"/><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>' +
        xesc(panelTitle.slice(0,31)) + '</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>' +
        '<body><table border="1">' + thtml + bodyHtml + "</table></body></html>";
      const blob = new Blob(["\\ufeff", html], { type: "application/vnd.ms-excel" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "webhealth-" + panelTitle.replace(/[^A-Za-z0-9]+/g,"_").replace(/^_|_$/g,"") + "-" + stamp + ".xls";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
    });
  }
  applyFilter();
</script></body></html>`;

const out = join(DIR, "report-catalog.html");
writeFileSync(out, html);
console.log("Wrote", out, "(" + results.length + " sites, " + categories.length + " categories, arms: " + armNames.join("+") + ")");
console.log("Overall:", JSON.stringify({ OK: overall.OK, IP_REPUTATION: overall.IP_REPUTATION, BLOCKED: overall.BLOCKED, HUMAN_CHALLENGE: overall.HUMAN_CHALLENGE, BOT_CHALLENGE: overall.BOT_CHALLENGE, ERROR: overall.ERROR, networkCaused: overall.networkCaused, blockRate: overall.blockRate + "%" }));

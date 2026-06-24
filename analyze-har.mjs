// analyze-har.mjs — diagnose blocked/failed requests in a HAR for GSA investigations.
//
// Usage:  node analyze-har.mjs <path-to.har>
//
// Reports: failing requests (>=400 or 0), the blocking vendor (Akamai/Cloudflare/
// Imperva/AWS WAF/F5), vendor incident IDs, the destination IP (to spot GSA synthetic
// tunnel IPs), bot-detection artifacts, and an overall status tally.

import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node analyze-har.mjs <path-to.har>");
  process.exit(1);
}

let har;
try {
  har = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`Could not read/parse HAR: ${e.message}`);
  process.exit(1);
}

const entries = har.log?.entries ?? [];
const hv = (headers, name) =>
  (headers.find((h) => h.name.toLowerCase() === name.toLowerCase()) || {}).value;

// Known public CDN ranges (rough prefixes) to contrast against GSA synthetic IPs.
const PUBLIC_CDN_PREFIXES = ["23.", "104.", "2.16.", "172.64.", "151.101.", "13.", "18.", "52."];

function detectVendor(h, bodyText) {
  const server = (hv(h, "server") || "").toLowerCase();
  const ids = {};
  let vendor = null;

  if (server.includes("akamaighost") || hv(h, "akamai-grn") || /edgesuite\.net/i.test(bodyText)) {
    vendor = "Akamai";
    if (hv(h, "akamai-grn")) ids["akamai-grn"] = hv(h, "akamai-grn");
    const ref = bodyText.match(/Reference\s*#?\s*([0-9a-f.]+)/i);
    if (ref) ids["reference#"] = ref[1];
  } else if (server.includes("cloudflare") || hv(h, "cf-ray")) {
    vendor = "Cloudflare";
    if (hv(h, "cf-ray")) ids["cf-ray"] = hv(h, "cf-ray");
    if (hv(h, "cf-mitigated")) ids["cf-mitigated"] = hv(h, "cf-mitigated");
  } else if (hv(h, "x-iinfo") || /Incapsula incident/i.test(bodyText)) {
    vendor = "Imperva/Incapsula";
    if (hv(h, "x-iinfo")) ids["x-iinfo"] = hv(h, "x-iinfo");
    const inc = bodyText.match(/incident ID:?\s*([0-9-]+)/i);
    if (inc) ids["incident-id"] = inc[1];
  } else if (server.includes("cloudfront") || hv(h, "x-amz-cf-id") || hv(h, "x-amzn-waf-action")) {
    vendor = "AWS CloudFront/WAF";
    if (hv(h, "x-amz-cf-id")) ids["x-amz-cf-id"] = hv(h, "x-amz-cf-id");
  } else if (server.includes("bigip") || server.includes("big-ip")) {
    vendor = "F5 BIG-IP";
    const sid = bodyText.match(/support ID[:\s]*([0-9]+)/i);
    if (sid) ids["support-id"] = sid[1];
  } else if (server) {
    vendor = `Other (server: ${hv(h, "server")})`;
  }
  return { vendor, ids };
}

function botArtifacts(entry, h) {
  const hits = [];
  if (hv(h, "x-akam-sw-version")) hits.push("akamai service-worker");
  if (/akam-sw-policy\.json/.test(entry.request.url)) hits.push("akam-sw-policy.json");
  if (/go-mpulse\.net|boomerang/.test(entry.request.url)) hits.push("mPulse/boomerang beacon");
  if (/__cf_bm|cf-chl/.test(JSON.stringify(h))) hits.push("cloudflare bot/challenge");
  if (entry.response.status === 0) hits.push("request cancelled (status 0)");
  return hits;
}

const codes = {};
const vendors = new Set();
const allIds = {};
const failures = [];

for (const e of entries) {
  const s = e.response?.status ?? 0;
  codes[s] = (codes[s] || 0) + 1;
  const h = e.response?.headers ?? [];
  const body = e.response?.content?.text || "";
  if (s >= 400 || s === 0) {
    const { vendor, ids } = detectVendor(h, body);
    if (vendor) vendors.add(vendor);
    Object.assign(allIds, ids);
    failures.push({
      status: s,
      method: e.request?.method,
      url: e.request?.url,
      serverIP: e.serverIPAddress || "(none)",
      server: hv(h, "server") || "(none)",
      vendor: vendor || "(unknown)",
      ids,
      bot: botArtifacts(e, h),
      date: hv(h, "date") || "",
    });
  }
}

console.log("=".repeat(72));
console.log("GSA HAR Analysis:", file);
console.log("=".repeat(72));
console.log("Total entries:", entries.length);
console.log("Status tally :", JSON.stringify(codes));
console.log("Blocking vendor(s):", [...vendors].join(", ") || "(none detected)");
console.log("Failing/blocked requests:", failures.length);

for (const f of failures) {
  console.log("\n" + "-".repeat(72));
  console.log(`${f.status}  ${f.method}  ${f.url}`);
  console.log("   server        :", f.server, "  → vendor:", f.vendor);
  console.log("   destination IP:", f.serverIP, looksSyntheticTag(f.serverIP));
  if (Object.keys(f.ids).length) console.log("   incident IDs  :", JSON.stringify(f.ids));
  if (f.bot.length) console.log("   bot artifacts :", f.bot.join(", "));
  if (f.date) console.log("   date          :", f.date);
}

if (Object.keys(allIds).length) {
  console.log("\n" + "=".repeat(72));
  console.log("Identifiers for support tickets:");
  for (const [k, v] of Object.entries(allIds)) console.log(`   ${k}: ${v}`);
}

console.log("\nNext: confirm whether the destination IP is a GSA synthetic/tunnel IP");
console.log("(compare with `nslookup <host>` off-GSA), then follow the playbook.");

function looksSyntheticTag(ip) {
  if (ip === "(none)") return "";
  const isCdn = PUBLIC_CDN_PREFIXES.some((p) => ip.startsWith(p));
  return isCdn ? "(looks like real CDN IP)" : "(NOT a known CDN range — possible GSA synthetic/tunnel IP)";
}

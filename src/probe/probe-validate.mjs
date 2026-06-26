// probe-validate.mjs — HEADED re-validation pass.
//
// Why this exists: a *headless* probe cannot tell egress-IP/ASN reputation apart
// from headless-bot detection. Akamai/Cloudflare/etc. block headless Chromium &
// Edge on ANY IP, so a headless 403 with `_abck` "passed" gets mislabelled
// IP_REPUTATION even when a real (headed) user on the same egress loads the site
// fine. Empirically the single decisive signal is headless vs headed — not
// navigator.webdriver, not stealth.
//
// This pass re-probes the automation-suspect rows of an existing run with a
// HEADED real-Edge profile (a safe copied diagnostic profile, no stealth — the
// honest no-spoofing posture) and rewrites the verdict:
//   * suspect flips to OK headed   => headless automation false-positive => OK
//                                     (verdict=OK, automationFalsePositive=true)
//   * suspect still blocked headed  => credible block, kept (headedConfirmed=true)
// Only after this pass is an IP_REPUTATION verdict defensible (a real headed
// browser with a valid sensor is still denied on this egress => escalate).
//
// Default scope: IP_REPUTATION rows. Add BLOCKED + challenges with --include-blocked.
//   PROBE_ARM=gsa node probe-validate.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { probeOne, captureEgress } from "../core/probe-core.mjs";
import { launchParityContext, cleanupCopiedProfile } from "../core/browser-parity.mjs";
import { loadConfig } from "../core/config.mjs";

const cfg = loadConfig();
const ARM = cfg.arm;
const OUT_DIR = cfg.outDir;
const SHOT_DIR = join(OUT_DIR, "shots");
mkdirSync(SHOT_DIR, { recursive: true });
const file = join(OUT_DIR, `results-${ARM}.json`);

const SUSPECT_DEFAULT = new Set(["IP_REPUTATION"]);
const SUSPECT_WIDE = new Set(["IP_REPUTATION", "BLOCKED", "BOT_CHALLENGE", "HUMAN_CHALLENGE"]);
const includeBlocked = process.env.VALIDATE_INCLUDE_BLOCKED === "1";
const suspectSet = includeBlocked ? SUSPECT_WIDE : SUSPECT_DEFAULT;

let data;
try { data = JSON.parse(readFileSync(file, "utf8")); }
catch { console.error(`No results to validate: ${file} not found. Run a probe first.`); process.exit(1); }
const results = data.results || data;
const todo = results.filter((r) => suspectSet.has(r.verdict) && !r.headedAt); // resume: skip done
const totalSuspect = results.filter((r) => suspectSet.has(r.verdict)).length;
console.log(`Headed re-validation arm="${ARM}": ${todo.length} of ${totalSuspect} suspect rows [${[...suspectSet].join(", ")}]`);
if (todo.length === 0) { console.log("Nothing to re-validate."); process.exit(0); }

// Headed real-Edge parity context: copied real profile (real cookies/session, no
// write-back), HEADED, NO stealth — config D proved headed alone is sufficient,
// so we keep the honest no-spoofing posture.
const browserCfg = { ...(cfg.browser || {}), headless: false };
const pc = await launchParityContext(browserCfg, { forceCopy: true });
let ctx = pc.context;
console.log(`Browser: ${pc.channel} headed profile=${pc.profileType} (headed real-profile control; no stealth)`);
const egress = await captureEgress(ctx);
console.log(`Egress now: ${egress.ip || "?"} ${egress.org || ""}`);

function save() {
  data.meta = data.meta || { arm: ARM };
  data.meta.headedValidation = { at: new Date().toISOString(), egress, scope: [...suspectSet], count: totalSuspect };
  writeFileSync(file, JSON.stringify(data, null, 2));
  writeFileSync(join(OUT_DIR, "results-catalog.json"), JSON.stringify(results, null, 2));
}

let done = 0, promoted = 0, confirmed = 0;
for (const row of todo) {
  let res;
  try {
    res = await probeOne(ctx, { category: row.category, host: row.host }, {
      arm: ARM, shotMode: "fail", outDir: OUT_DIR, shotDir: SHOT_DIR, evidence: false,
      retries: cfg.retries, navTimeout: cfg.navTimeout, settleMs: Math.max(cfg.settleMs, 3500),
    });
  } catch (e) {
    res = { verdict: "ERROR", status: "ERR", title: (e.message || "").split("\n")[0].slice(0, 80) };
  }
  const headedVerdict = res.verdict || "ERROR";
  row.headlessVerdict = row.headlessVerdict || row.verdict; // preserve the original
  row.headedVerdict = headedVerdict;
  row.headedStatus = res.status ?? "ERR";
  row.headedAbck = res.abck || row.abck;
  row.headedAt = new Date().toISOString();
  if (headedVerdict === "OK") {
    // A real headed browser loads it => the headless run produced a bot false-positive.
    row.verdict = "OK";
    row.reason = "OK_HEADED";
    row.automationFalsePositive = true;
    row.headedConfirmed = false;
    if (res.edgeIp && res.edgeIp !== "-") row.edgeIp = res.edgeIp;
    promoted++;
  } else {
    // Still blocked for a real headed browser => credible. Keep the (possibly
    // shifted) verdict and mark it headed-confirmed.
    row.verdict = headedVerdict;
    row.headedConfirmed = true;
    if (res.reference && !row.reference) row.reference = res.reference;
    if (res.screenshot) row.screenshot = res.screenshot;
    confirmed++;
  }
  done++;
  const note = row.headlessVerdict === headedVerdict ? `still ${headedVerdict}` : `${row.headlessVerdict} -> ${headedVerdict}`;
  console.log(`  ${done}/${todo.length}  ${row.host.padEnd(22)} headed=${String(row.headedStatus).padEnd(5)} ${headedVerdict.padEnd(14)} (${note})`);
  if (done % 5 === 0) save();
  await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 400)));
}

try { await ctx.close().catch(() => {}); } finally { if (pc.copiedProfileUsed) cleanupCopiedProfile(pc.userDataDir); }
save();
console.log(`Done. Re-validated ${done} row(s): ${promoted} promoted to OK (automation false-positives), ${confirmed} confirmed blocked headed.`);
console.log(`Re-render with "checkwebhealth report" to refresh verdicts and the NETWORK-CAUSED delta.`);

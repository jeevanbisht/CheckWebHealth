// diagnosis.mjs — staged diagnostic pipeline (pure, deterministic, unit-tested).
//
// The catalog probe + classify() produce a per-row *evidence* verdict (the HTTP
// reality: OK / BLOCKED / IP_REPUTATION / HUMAN_CHALLENGE / ERROR …). This module
// sits ON TOP of that evidence and answers the questions an enterprise operator
// actually cares about, IN ORDER:
//
//   1. Can the diagnostic browser itself be trusted?      (Stage 1 — trust)
//   2. Is the Direct-vs-GSA comparison even valid?         (Stage 2 — validity)
//   3. If valid, what is the most likely root cause?       (Stage 3 — root cause)
//   4. How reliable is this conclusion?                    (reliability)
//   5. What evidence supports it?                          (evidence)
//   6. What should the user do next?                       (recommendation)
//
// The cardinal rule: NEVER emit a strong network-path diagnosis (e.g.
// IP_REPUTATION) when the diagnostic browser is untrusted or when every
// automated path failed. A site that fails on BOTH Direct and GSA while the
// user's manual browser works is the *tool browser* being blocked — not the
// network. That case yields TOOL_BROWSER_BLOCKED / AUTOMATION_OR_BROWSER_POSTURE.
//
// Pure: every function takes its inputs as parameters and returns plain data, so
// the whole pipeline is testable without a browser or network.

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

// Stage 1 — browser environment gate.
export const BROWSER_ENV = { PASS: "PASS", WARNING: "WARNING", FAILED: "FAILED" };

// Stage 2 — is a Direct-vs-GSA comparison meaningful?
export const PATH_VALIDITY = {
  VALID: "VALID_PATH_COMPARISON",
  BOTH_FAILED: "INCONCLUSIVE_BOTH_PATHS_FAILED",
  TOOL_BLOCKED: "TOOL_BROWSER_BLOCKED",
  MANUAL_REQUIRED: "MANUAL_BROWSER_REQUIRED",
  AUTH: "AUTH_REQUIRED",
  CLIENT_POSTURE: "CLIENT_POSTURE_REQUIRED",
};

// Primary diagnosis (the headline). When the comparison is invalid the diagnosis
// is about the *browser*, not the network.
export const PRIMARY = {
  BROWSER_POSTURE: "AUTOMATION_OR_BROWSER_POSTURE",
  IP_REPUTATION: "IP_REPUTATION",
  NETWORK: "NETWORK",
  DNS: "DNS",
  TLS: "TLS",
  APPLICATION: "APPLICATION",
  WAF: "WAF",
  CDN: "CDN",
  AUTHENTICATION: "AUTHENTICATION",
  NONE: "NO_FAULT",
};

// Cross-path verdict.
export const DIAG_VERDICT = {
  TOOL_BROWSER_BLOCKED: "TOOL_BROWSER_BLOCKED",
  NETWORK_CAUSED: "NETWORK_CAUSED",
  SITE_OR_ACCOUNT: "SITE_OR_ACCOUNT",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  INCONCLUSIVE: "INCONCLUSIVE",
  OK: "OK",
};

// Secondary reasons (why the tool browser is distrusted/blocked).
export const SECONDARY = {
  TEMP_PROFILE: "TEMP_PROFILE",
  AUTOMATED_BROWSER_DETECTED: "AUTOMATED_BROWSER_DETECTED",
  CLIENT_POSTURE_POLICY: "CLIENT_POSTURE_POLICY",
  COOKIE_OR_SESSION_REQUIRED: "COOKIE_OR_SESSION_REQUIRED",
  SITE_REJECTS_DIAGNOSTIC_BROWSER: "SITE_REJECTS_DIAGNOSTIC_BROWSER",
  PROFILE_NOT_LOADED: "PROFILE_NOT_LOADED",
  MANUAL_BROWSER_PARITY_FAILED: "MANUAL_BROWSER_PARITY_FAILED",
  HEADLESS_MODE: "HEADLESS_MODE",
  BROWSER_VERSION_MISMATCH: "BROWSER_VERSION_MISMATCH",
};

export const RELIABILITY = { HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW", INCONCLUSIVE: "INCONCLUSIVE" };

// Verdicts that mean the *site actively rejected* the request (vs a transport error).
const BLOCKISH = new Set(["BLOCKED", "IP_REPUTATION", "BOT_CHALLENGE", "HUMAN_CHALLENGE"]);
const isOK = (v) => v === "OK";
const isErr = (v) => v === "ERROR";

// ---------------------------------------------------------------------------
// Stage 1 — Browser Trust Score + environment status
// ---------------------------------------------------------------------------

// Trust bands (inclusive lower bounds).
export const TRUST_BANDS = [
  { min: 95, band: "Trusted" },
  { min: 70, band: "Mostly Trusted" },
  { min: 40, band: "Questionable" },
  { min: 0, band: "Untrusted" },
];

export function trustBand(score) {
  const s = clamp(score, 0, 100);
  for (const b of TRUST_BANDS) if (s >= b.min) return b.band;
  return "Untrusted";
}

// Score how closely the diagnostic browser matches a real, trusted user browser.
// Penalty model from 100. `env` is the merged run/arm environment:
//   { headless, profileType ("persistent"|"copied"|"temporary"|"ephemeral"),
//     mode ("manual-parity"|"automated"), channel, engine ("Edge"|"Chromium"),
//     webdriver, edgeVersion, installedEdgeVersion, cookiesPresent (count|bool),
//     localStoragePresent, sessionStoragePresent, clientHintsPresent, jsOk }
export function scoreBrowserTrust(env = {}) {
  const factors = [];
  let score = 100;
  const hit = (delta, label) => { score += delta; factors.push({ delta, label, sign: delta >= 0 ? "+" : "-" }); };

  // Headless is the single strongest "this is automation" signal (empirically the
  // decisive one for Akamai/PerimeterX), so it dominates.
  if (env.headless === true) hit(-35, "Headless browser (no visible window)");
  else factors.push({ delta: 0, label: "Headed (visible) browser", sign: "+" });

  // Profile state: a throwaway temp profile carries none of the user's session;
  // a copied real profile carries cookies but no write-back; persistent is best.
  if (env.profileType === "temporary" || env.profileType === "ephemeral") hit(-25, "Temporary profile (no real session/cookies)");
  else if (env.profileType === "copied") hit(-5, "Copied diagnostic profile (real cookies, no write-back)");
  else if (env.profileType === "persistent") factors.push({ delta: 0, label: "Persistent real profile", sign: "+" });

  // Cookies / storage presence for the origin/profile.
  const cookies = typeof env.cookiesPresent === "number" ? env.cookiesPresent : env.cookiesPresent ? 1 : 0;
  if (cookies === 0) hit(-15, "No cookies (likely needs an existing session)");
  const storage = env.localStoragePresent || env.sessionStoragePresent;
  if (env.localStoragePresent !== undefined && !storage) hit(-8, "No local/session storage");

  // Automation marker. (Empirically minor for some WAFs, but a real ZTNA/CA
  // policy can key on it, so it carries a modest penalty.)
  if (env.webdriver === true) hit(-10, "navigator.webdriver = true");

  // Engine / version parity with the user's installed Edge.
  if (env.engine && env.engine !== "Edge") hit(-15, `Non-Edge engine (${env.engine}) — Edge channel unavailable`);
  else if (env.edgeVersion && env.installedEdgeVersion && majorOf(env.edgeVersion) !== majorOf(env.installedEdgeVersion)) {
    hit(-8, `Edge version mismatch (${env.edgeVersion} vs installed ${env.installedEdgeVersion})`);
  }

  // Reduced client hints look like a stripped automation client to some policies.
  if (env.clientHintsPresent === false) hit(-8, "Reduced/absent client hints");

  // JavaScript failing to execute breaks bot sensors and the page itself.
  if (env.jsOk === false) hit(-15, "JavaScript did not execute cleanly");

  score = clamp(score, 0, 100);
  return { score, band: trustBand(score), factors };
}

// Stage 1 gate. PASS (>=70 — Trusted/Mostly Trusted), WARNING (40-69 —
// Questionable), FAILED (<40 — Untrusted). Below PASS, the engine must not issue
// a high-confidence network-path diagnosis.
export function browserEnvironmentStatus(env = {}, trust = null) {
  const t = trust || scoreBrowserTrust(env);
  if (t.score >= 70) return BROWSER_ENV.PASS;
  if (t.score >= 40) return BROWSER_ENV.WARNING;
  return BROWSER_ENV.FAILED;
}

// ---------------------------------------------------------------------------
// Stage 2 — Path comparison validity
// ---------------------------------------------------------------------------

// Decide whether a Direct-vs-GSA comparison is meaningful BEFORE attributing a
// root cause. `perPath` = { direct: row, gsa: row, … }. `manualWorks` is the
// human-observed premise (defaults true — the whole reason we are diagnosing).
export function assessPathValidity({ perPath = {}, primaryArm = "gsa", baselineArm = "direct", browserStatus = BROWSER_ENV.PASS, manualWorks = true } = {}) {
  const arms = Object.keys(perPath);
  const verdicts = arms.map((a) => (perPath[a] || {}).verdict).filter(Boolean);
  const primary = perPath[primaryArm] || {};

  if (!verdicts.length) return PATH_VALIDITY.BOTH_FAILED;

  // Expected authentication is never a block — short-circuit.
  if (verdicts.length && verdicts.every((v) => v === "AUTH_REQUIRED")) return PATH_VALIDITY.AUTH;
  if (primary.verdict === "AUTH_REQUIRED") return PATH_VALIDITY.AUTH;

  const anyOK = verdicts.some(isOK);
  const allFail = verdicts.every((v) => !isOK(v));

  // A successful control path PROVES the browser can load the target, so a fail on
  // another path is genuinely path-attributable — valid regardless of trust band.
  if (anyOK) return PATH_VALIDITY.VALID;

  // Every automated path failed. The network can NOT be blamed yet.
  if (allFail) {
    const blockish = verdicts.some((v) => BLOCKISH.has(v));
    const clientPosture = clientPostureSuspected(primary);

    // Untrusted browser + everything fails => it's the tool browser.
    if (browserStatus === BROWSER_ENV.FAILED) return PATH_VALIDITY.TOOL_BLOCKED;

    // A bot/WAF rejection on every path while manual works => the diagnostic
    // browser is being blocked, not the network (the user's reported case).
    if (blockish && manualWorks) {
      if (clientPosture) return PATH_VALIDITY.CLIENT_POSTURE;
      return PATH_VALIDITY.TOOL_BLOCKED;
    }

    // Block on every path and we cannot assume manual works => ask for a manual run.
    if (blockish && !manualWorks) return PATH_VALIDITY.MANUAL_REQUIRED;

    // Both paths errored at the network layer (DNS/TLS/TCP) — could be a real
    // path/site failure, but two failing paths alone don't prove it.
    return PATH_VALIDITY.BOTH_FAILED;
  }

  return PATH_VALIDITY.VALID;
}

// Automation markers a Zero-Trust / conditional-access policy can key on.
function clientPostureSuspected(row = {}) {
  return row.webdriver === true || row.clientHintsPresent === false;
}

// ---------------------------------------------------------------------------
// Stage 3 — Root cause (ONLY when the comparison is VALID)
// ---------------------------------------------------------------------------

// Map a valid comparison to a network/site root cause using the existing verdict
// + reason + the Direct-vs-GSA delta. IP_REPUTATION is gated by the caller.
export function rootCause(perPath = {}, primaryArm = "gsa", baselineArm = "direct") {
  const p = perPath[primaryArm] || {};
  const base = perPath[baselineArm];
  const baseOK = base && isOK(base.verdict);
  const reason = p.reason || "";

  // Transport-layer failures first.
  switch (reason) {
    case "DNS_FAILURE": return PRIMARY.DNS;
    case "TLS_FAILURE": return PRIMARY.TLS;
    case "TCP_FAILURE":
    case "TIMEOUT":
    case "RESET_CONNECTION": return PRIMARY.NETWORK;
    default: break;
  }
  if (p.verdict === "AUTH_REQUIRED") return PRIMARY.AUTHENTICATION;
  if (p.verdict === "IP_REPUTATION") return PRIMARY.IP_REPUTATION; // gating applied by caller
  if (p.verdict === "HUMAN_CHALLENGE" || p.verdict === "BOT_CHALLENGE") return PRIMARY.WAF;
  if (p.verdict === "BLOCKED") {
    if (reason === "WAF_BLOCK") return PRIMARY.WAF;
    if (reason === "HTTP_404") return PRIMARY.APPLICATION;
    // OK on the baseline but blocked on the primary => network-path attributable.
    return baseOK ? PRIMARY.NETWORK : PRIMARY.CDN;
  }
  if (isOK(p.verdict)) return PRIMARY.NONE;
  if (isErr(p.verdict)) return PRIMARY.NETWORK;
  return PRIMARY.CDN;
}

// ---------------------------------------------------------------------------
// Secondary reason — why the diagnostic browser is distrusted / blocked
// ---------------------------------------------------------------------------

export function secondaryReason(env = {}, primary = {}) {
  // Site explicitly rejected even a (near-)real browser while manual works.
  if (BLOCKISH.has(primary.verdict) && (env.profileType === "persistent" || env.profileType === "copied") && env.headless === false) {
    return SECONDARY.SITE_REJECTS_DIAGNOSTIC_BROWSER;
  }
  if (env.profileType === "temporary" || env.profileType === "ephemeral") return SECONDARY.TEMP_PROFILE;
  if (env.headless === true) return SECONDARY.HEADLESS_MODE;
  const cookies = typeof env.cookiesPresent === "number" ? env.cookiesPresent : env.cookiesPresent ? 1 : 0;
  if (cookies === 0) return SECONDARY.COOKIE_OR_SESSION_REQUIRED;
  if (env.copiedProfileUsed === true && env.profileFound === false) return SECONDARY.PROFILE_NOT_LOADED;
  if (env.webdriver === true || env.clientHintsPresent === false) return SECONDARY.CLIENT_POSTURE_POLICY;
  if (env.engine && env.engine !== "Edge") return SECONDARY.BROWSER_VERSION_MISMATCH;
  if (BLOCKISH.has(primary.verdict)) return SECONDARY.AUTOMATED_BROWSER_DETECTED;
  return SECONDARY.MANUAL_BROWSER_PARITY_FAILED;
}

// ---------------------------------------------------------------------------
// Reliability + the four separated confidences
// ---------------------------------------------------------------------------

export function diagnosticReliability(browserStatus, pathValidity, perPath = {}, primaryArm = "gsa", baselineArm = "direct") {
  if (pathValidity === PATH_VALIDITY.BOTH_FAILED) return RELIABILITY.INCONCLUSIVE;
  if (pathValidity === PATH_VALIDITY.AUTH) return RELIABILITY.HIGH; // auth is a clean, certain call
  // Browser-attributable conclusions are reliable when trust is clearly bad.
  if (pathValidity === PATH_VALIDITY.TOOL_BLOCKED || pathValidity === PATH_VALIDITY.CLIENT_POSTURE || pathValidity === PATH_VALIDITY.MANUAL_REQUIRED) {
    return browserStatus === BROWSER_ENV.FAILED ? RELIABILITY.HIGH : RELIABILITY.MEDIUM;
  }
  // VALID comparison: corroboration + trust drive reliability.
  const base = perPath[baselineArm];
  const corroborated = base && isOK(base.verdict); // a working control path
  if (browserStatus === BROWSER_ENV.PASS && corroborated) return RELIABILITY.HIGH;
  if (browserStatus === BROWSER_ENV.PASS) return RELIABILITY.MEDIUM;
  if (browserStatus === BROWSER_ENV.WARNING) return RELIABILITY.MEDIUM;
  return RELIABILITY.LOW; // browser FAILED but somehow VALID (a control path OK) — still hedge
}

// The four confidences, separated so the report never presents misleading certainty.
//   browserTrust  — Stage 1 score (0-100)
//   pathReliability — how meaningful the comparison is (0-100)
//   evidence      — how strong the raw evidence is (corroboration/signal)
//   diagnosis     — overall, CAPPED by browserTrust when the browser is distrusted
export function scoreConfidences({ trust, browserStatus, pathValidity, perPath = {}, primaryArm = "gsa", baselineArm = "direct" }) {
  const browserTrust = trust.score;

  const pathReliability = {
    [PATH_VALIDITY.VALID]: 90,
    [PATH_VALIDITY.AUTH]: 90,
    [PATH_VALIDITY.TOOL_BLOCKED]: 80,
    [PATH_VALIDITY.CLIENT_POSTURE]: 70,
    [PATH_VALIDITY.MANUAL_REQUIRED]: 55,
    [PATH_VALIDITY.BOTH_FAILED]: 25,
  }[pathValidity] ?? 40;

  // Evidence strength: corroboration across attempts + paths + a strong WAF signal.
  const p = perPath[primaryArm] || {};
  let evidence = 45;
  const log = Array.isArray(p.attemptLog) ? p.attemptLog : [];
  if (log.length >= 2 && new Set(log.map((a) => a.verdict)).size === 1) evidence += 15;
  const base = perPath[baselineArm];
  if (base) evidence += 15; // a baseline exists to compare against
  if (p.vendor === "Akamai" && p.abck === "passed") evidence += 10;
  if (p.reference) evidence += 10;
  if (p.reason === "TIMEOUT" || p.reason === "DNS_FAILURE") evidence -= 15;
  evidence = clamp(evidence, 5, 99);

  // Overall diagnosis confidence: blend path reliability + evidence, then CAP by
  // browser trust — an untrusted browser can never yield a high-confidence
  // network diagnosis.
  let diagnosis = Math.round(0.5 * pathReliability + 0.5 * evidence);
  if (browserStatus === BROWSER_ENV.FAILED) diagnosis = Math.min(diagnosis, 35);
  else if (browserStatus === BROWSER_ENV.WARNING) diagnosis = Math.min(diagnosis, 65);
  // Browser-attributable conclusions (tool blocked) are themselves confident when
  // trust is low — the low trust IS the evidence — so floor them.
  if (pathValidity === PATH_VALIDITY.TOOL_BLOCKED && browserStatus !== BROWSER_ENV.PASS) diagnosis = Math.max(diagnosis, 75);

  return {
    diagnosis: clamp(diagnosis, 5, 99),
    evidence,
    browserTrust: clamp(browserTrust, 0, 100),
    pathReliability,
  };
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

export function recommendation(pathValidity, secondary, browserStatus) {
  switch (pathValidity) {
    case PATH_VALIDITY.AUTH:
      return "Expected authentication — not a block. Complete sign-in (or supply a session) and re-test.";
    case PATH_VALIDITY.TOOL_BLOCKED:
    case PATH_VALIDITY.MANUAL_REQUIRED:
      if (secondary === SECONDARY.SITE_REJECTS_DIAGNOSTIC_BROWSER)
        return "The site rejects automated browsers by policy; treat as 'works manually' and escalate with evidence rather than bypassing protections.";
      if (secondary === SECONDARY.HEADLESS_MODE)
        return "Re-run headed (checkwebhealth validate / --headed) so the diagnostic browser matches a real user before drawing any network conclusion.";
      if (secondary === SECONDARY.TEMP_PROFILE || secondary === SECONDARY.COOKIE_OR_SESSION_REQUIRED)
        return "Run Manual Browser Parity with a persistent Edge profile (real cookies/session) before evaluating Direct vs GSA.";
      return "Run Manual Browser Parity Mode with a persistent Edge profile, headed, before evaluating Direct vs GSA differences.";
    case PATH_VALIDITY.CLIENT_POSTURE:
      return "Automation markers (navigator.webdriver / reduced client hints) may trip a Zero-Trust/CA policy — validate from a managed compliant session; do not bypass the policy.";
    case PATH_VALIDITY.BOTH_FAILED:
      return "Both paths failed and the browser isn't validated — confirm the site loads in your normal Edge, then re-run headed parity before escalating.";
    case PATH_VALIDITY.VALID:
      if (browserStatus !== BROWSER_ENV.PASS)
        return "Comparison is valid but the browser is only partially trusted — corroborate the failing path headed before escalating.";
      return "Comparison is valid — escalate the failing path with the egress IP/ASN and CDN Reference # as supporting evidence.";
    default:
      return "Re-run the probe with a validated (headed, real-profile) browser.";
  }
}

// ---------------------------------------------------------------------------
// Orchestrator — the full staged diagnosis for one host
// ---------------------------------------------------------------------------

// `env` is the merged run/arm browser environment (see scoreBrowserTrust). The
// per-path rows may also carry webdriver/clientHintsPresent for posture checks.
export function diagnoseHost({ perPath = {}, env = {}, primaryArm = "gsa", baselineArm = "direct", manualWorks = true } = {}) {
  const primary = perPath[primaryArm] || {};

  // Stage 1
  const trust = scoreBrowserTrust(env);
  const browserEnvironment = browserEnvironmentStatus(env, trust);

  // Stage 2
  const pathValidity = assessPathValidity({ perPath, primaryArm, baselineArm, browserStatus: browserEnvironment, manualWorks });

  // Stage 3 (+ assembly)
  let primaryDiagnosis, verdict, secondary = null;
  const valid = pathValidity === PATH_VALIDITY.VALID;

  if (pathValidity === PATH_VALIDITY.AUTH) {
    primaryDiagnosis = PRIMARY.AUTHENTICATION;
    verdict = DIAG_VERDICT.AUTH_REQUIRED;
  } else if (valid) {
    let rc = rootCause(perPath, primaryArm, baselineArm);
    // IP_REPUTATION gate: trusted browser + valid comparison + >=1 control OK + WAF evidence.
    if (rc === PRIMARY.IP_REPUTATION && !ipReputationAllowed({ trust, browserEnvironment, perPath, primaryArm, baselineArm })) {
      rc = PRIMARY.WAF; // downgrade to a WAF/CDN-side denial we can't pin to the IP
    }
    primaryDiagnosis = rc;
    const base = perPath[baselineArm];
    if (rc === PRIMARY.NONE) verdict = DIAG_VERDICT.OK;
    else if (base && isOK(base.verdict) && !isOK(primary.verdict)) verdict = DIAG_VERDICT.NETWORK_CAUSED;
    else verdict = DIAG_VERDICT.SITE_OR_ACCOUNT;
  } else {
    // Comparison invalid. A transport ERROR (DNS/TLS/TCP/timeout) with no valid
    // comparison is a network/site fault we surface at reduced reliability — NOT
    // browser posture. Only block/challenge failures implicate the tool browser.
    if (pathValidity === PATH_VALIDITY.BOTH_FAILED && isErr(primary.verdict)) {
      primaryDiagnosis = rootCause(perPath, primaryArm, baselineArm); // NETWORK / DNS / TLS
      verdict = DIAG_VERDICT.INCONCLUSIVE;
    } else {
      primaryDiagnosis = PRIMARY.BROWSER_POSTURE;
      secondary = secondaryReason(env, primary);
      verdict = pathValidity === PATH_VALIDITY.BOTH_FAILED ? DIAG_VERDICT.INCONCLUSIVE : DIAG_VERDICT.TOOL_BROWSER_BLOCKED;
    }
  }

  const reliability = diagnosticReliability(browserEnvironment, pathValidity, perPath, primaryArm, baselineArm);
  const confidence = scoreConfidences({ trust, browserStatus: browserEnvironment, pathValidity, perPath, primaryArm, baselineArm });

  return {
    browserTrust: { score: trust.score, band: trust.band, factors: trust.factors },
    browserEnvironment,
    pathValidity,
    primaryDiagnosis,
    secondaryReason: secondary,
    verdict,
    rootCause: valid ? primaryDiagnosis : null,
    evidence: collectEvidence(perPath, primaryArm, baselineArm, manualWorks),
    reliability,
    confidence,
    recommendation: recommendation(pathValidity, secondary, browserEnvironment),
  };
}

// IP_REPUTATION is only defensible when: browser trusted (PASS), comparison valid,
// at least one control path OK, and the evidence supports a hard WAF/IP denial.
export function ipReputationAllowed({ trust, browserEnvironment, perPath = {}, primaryArm = "gsa", baselineArm = "direct" } = {}) {
  if (browserEnvironment !== BROWSER_ENV.PASS) return false;
  const p = perPath[primaryArm] || {};
  const controlOK = Object.keys(perPath).some((a) => a !== primaryArm && isOK((perPath[a] || {}).verdict));
  if (!controlOK) return false;
  const hardDeny = [403, 451].includes(Number(p.status));
  const sensorOK = p.abck === "passed";
  return hardDeny && sensorOK;
}

// Gather the supporting evidence (separated from the diagnosis itself).
function collectEvidence(perPath = {}, primaryArm = "gsa", baselineArm = "direct", manualWorks = true) {
  const p = perPath[primaryArm] || {};
  const base = perPath[baselineArm] || null;
  const ev = [];
  if (p.status != null) ev.push({ label: "HTTP status", value: String(p.status) });
  if (p.vendor && p.vendor !== "-") ev.push({ label: "Vendor", value: p.vendor });
  if (p.reference) ev.push({ label: "Reference #", value: String(p.reference) });
  if (p.abck && p.abck !== "no-_abck") ev.push({ label: "_abck", value: p.abck });
  if (p.verdict) ev.push({ label: "Evidence verdict", value: p.verdict });
  if (base && base.verdict) ev.push({ label: `${baselineArm} verdict`, value: base.verdict });
  ev.push({ label: "Manual browser", value: manualWorks ? "works (assumed)" : "fails" });
  return ev;
}

// ---------------------------------------------------------------------------
// Run-level helper: merge launch meta + environment snapshot into a trust env.
// ---------------------------------------------------------------------------

// Build the `env` object scoreBrowserTrust/diagnoseHost expect from a results
// meta block ({ browser:{…}, environment:{…}, installedEdgeVersion }).
export function envFromMeta(meta = {}) {
  const b = meta.browser || {};
  const s = meta.environment || {};
  return {
    headless: b.headless,
    profileType: b.profileType,
    mode: b.mode,
    channel: b.channel,
    engine: s.engine,
    webdriver: s.webdriver,
    edgeVersion: s.edgeVersion,
    installedEdgeVersion: meta.installedEdgeVersion || s.installedEdgeVersion,
    cookiesPresent: meta.cookiesPresent ?? s.cookiesPresent,
    localStoragePresent: s.localStoragePresent,
    sessionStoragePresent: s.sessionStoragePresent,
    clientHintsPresent: s.clientHintsPresent,
    copiedProfileUsed: b.copiedProfileUsed,
    profileFound: b.profileFound,
    jsOk: s.jsOk,
  };
}

// ---------------------------------------------------------------------------
function clamp(n, lo, hi) { const x = Number(n); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : lo; }
function majorOf(v) { const m = String(v || "").match(/^(\d+)/); return m ? m[1] : ""; }

// browser-parity.mjs — Manual Browser Parity Mode.
//
// Goal: make the automated browser match the user's *normal* Microsoft Edge as
// closely as possible for legitimate diagnostics, so CheckWebHealth can tell a
// real network failure apart from a failure caused by the diagnostic browser
// environment.
//
// This is explicitly NOT stealth, anti-bot bypass, CAPTCHA bypass or deception.
// Nothing is hidden or spoofed:
//   * We launch *real Edge* (channel:msedge), headed, with the user's own
//     persistent profile, so cookies / storage / language / timezone /
//     certificates / proxy / preferences are the user's real ones.
//   * navigator.webdriver is left at its honest value and reported as-is. We do
//     NOT inject a stealth init-script here (unlike the legacy A/B probe).
//
// Pure helpers (classification, sanitisation, profile resolution, version
// parsing) take their environment as parameters so they unit-test deterministically
// on any OS. The async launch/detect helpers touch the real machine.
import { chromium } from "playwright";
import {
  existsSync, lstatSync, mkdirSync, copyFileSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync,
} from "node:fs";
import { join, basename } from "node:path";
import { tmpdir, homedir } from "node:os";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Profile / Edge location (pure given platform + env)
// ---------------------------------------------------------------------------

// The default Edge "User Data" directory per platform. Edge stores Local State
// at the root and one folder per profile (Default, "Profile 1", …) beneath it.
export function defaultUserDataDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(local, "Microsoft", "Edge", "User Data");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Microsoft Edge");
  }
  // linux + others
  return join(home, ".config", "microsoft-edge");
}

// Resolve the effective User Data dir from the browser config, falling back to
// the platform default when unset.
export function resolveUserDataDir(browserCfg = {}, ctx = {}) {
  if (browserCfg.userDataDir) return String(browserCfg.userDataDir);
  return defaultUserDataDir(ctx.platform, ctx.env, ctx.home);
}

// Known Edge executable locations per platform (best effort; first hit wins).
function edgeCandidatePaths(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const pf = env["ProgramFiles"] || "C:\\Program Files";
    const pfx86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
      join(pfx86, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }
  if (platform === "darwin") {
    return ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  }
  return ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/microsoft-edge"];
}

// Parse an Edge/Chromium version (1.2.3.4) out of a user-agent string. Returns
// the full version string or "" when the UA is not an Edge UA.
export function parseEdgeVersion(ua = "") {
  const m = String(ua).match(/Edg(?:A|iOS)?\/(\d+(?:\.\d+){0,3})/i);
  return m ? m[1] : "";
}

// True when a UA looks like real Edge (has an Edg/ token) vs bare Chrome/Chromium.
export function engineOf(ua = "") {
  if (/Edg(?:A|iOS)?\//i.test(ua)) return "Edge";
  if (/Chrome\//i.test(ua)) return "Chromium";
  return "Unknown";
}

export function majorVersion(v = "") {
  const m = String(v).match(/^(\d+)/);
  return m ? m[1] : "";
}

// ---------------------------------------------------------------------------
// Detection (async — touches the real machine)
// ---------------------------------------------------------------------------

// Detect whether Edge is installed and at what version. On Windows we read the
// version from the per-version sub-folder Edge creates under Application/ (no
// GUI launch needed); elsewhere we run `--version`.
export async function detectEdge(ctx = {}) {
  const platform = ctx.platform || process.platform;
  const env = ctx.env || process.env;
  const out = { installed: false, path: "", version: "" };
  for (const p of edgeCandidatePaths(platform, env)) {
    if (!existsSync(p)) continue;
    out.installed = true;
    out.path = p;
    try {
      if (platform === "win32") {
        // Application/<version>/ — the highest version folder is the install.
        const appDir = join(p, "..");
        const versions = readdirSync(appDir)
          .filter((n) => /^\d+(\.\d+){2,3}$/.test(n))
          .sort((a, b) => cmpVersion(b, a));
        if (versions.length) out.version = versions[0];
      } else {
        out.version = (execFileSync(p, ["--version"], { timeout: 5000 }).toString().match(/(\d+(\.\d+){2,3})/) || [])[1] || "";
      }
    } catch { /* version best-effort */ }
    break;
  }
  return out;
}

function cmpVersion(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (d) return d;
  }
  return 0;
}

// Does the selected profile directory exist under the User Data dir?
export function profileExists(userDataDir, profileDirectory = "Default") {
  try { return existsSync(join(userDataDir, profileDirectory)); } catch { return false; }
}

// Best-effort cookie availability: Edge stores cookies in
// <profile>/Network/Cookies (newer) or <profile>/Cookies (older). We only check
// for presence/size — never read or print cookie values.
export function cookiesAvailable(userDataDir, profileDirectory = "Default") {
  const candidates = [
    join(userDataDir, profileDirectory, "Network", "Cookies"),
    join(userDataDir, profileDirectory, "Cookies"),
  ];
  for (const c of candidates) {
    try { if (existsSync(c) && statSync(c).size > 0) return { available: true, path: c }; } catch { /* ignore */ }
  }
  return { available: false, path: "" };
}

// Profile lock status. Chromium uses a process-singleton so a profile cannot be
// opened twice at once.
//   * POSIX: a `SingletonLock` symlink in the User Data dir means an instance is
//     running.
//   * Windows: there is no reliable lock file (a named mutex is used), so we fall
//     back to checking whether an msedge process is running.
// Returns { locked, reason }.
export async function detectProfileLock(userDataDir, ctx = {}) {
  const platform = ctx.platform || process.platform;
  // POSIX singleton symlink. Use lstat (not exists): a SingletonLock is a symlink
  // whose target (hostname-pid) usually does NOT exist, so existsSync follows the
  // dangling link and returns false even though the lock artefact is present.
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { lstatSync(join(userDataDir, name)); return { locked: true, reason: `${name} present (Edge appears to be running)` }; } catch { /* not present */ }
  }
  if (platform === "win32") {
    try {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq msedge.exe", "/NH"], { timeout: 5000 }).toString();
      if (/msedge\.exe/i.test(out)) return { locked: true, reason: "msedge.exe is running — close Edge or a copied profile will be used" };
    } catch { /* tasklist may be unavailable */ }
  }
  return { locked: false, reason: "" };
}

// Detect a system/OS proxy. Env proxy vars are honoured on every platform; on
// Windows we additionally read the WinINET registry settings. Best effort.
export async function detectSystemProxy(ctx = {}) {
  const env = ctx.env || process.env;
  const platform = ctx.platform || process.platform;
  const envServer = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (envServer) return { enabled: true, server: sanitizeProxyUrl(envServer), source: "environment" };
  if (platform === "win32") {
    try {
      const ps = "$s=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';"
        + "if($s.ProxyEnable -eq 1){\"$($s.ProxyServer)\"}else{''}";
      const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 6000 }).toString().trim();
      if (out) return { enabled: true, server: sanitizeProxyUrl(out), source: "windows-internet-settings" };
    } catch { /* registry read best-effort */ }
  }
  return { enabled: false, server: "", source: "" };
}

// Strip any embedded credentials (user:pass@) from a proxy string before it is
// recorded or printed — with or without a scheme (e.g. "user:pass@host:8080").
export function sanitizeProxyUrl(url = "") {
  return String(url)
    .replace(/\/\/[^/@]*@/, "//")        // scheme://user:pass@host
    .replace(/(^|[;\s])[^;\s/@]+@/g, "$1"); // bare user:pass@host (per-protocol/semicolon lists)
}

// ---------------------------------------------------------------------------
// Copied diagnostic profile (fallback when the real profile is locked)
// ---------------------------------------------------------------------------

// Sub-directories we never copy: large/transient caches that are irrelevant to
// parity and slow to copy. Also skip the singleton lock artefacts.
const COPY_SKIP_DIRS = new Set([
  "Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache", "DawnCache",
  "DawnGraphiteCache", "DawnWebGPUCache", "Service Worker", "CacheStorage",
  "Crashpad", "Crash Reports", "component_crx_cache", "extensions_crx_cache",
]);
const COPY_SKIP_PREFIX = ["Singleton", "lockfile"];

function copyFilter(src) {
  const name = basename(src);
  if (COPY_SKIP_DIRS.has(name)) return false;
  if (COPY_SKIP_PREFIX.some((p) => name.startsWith(p))) return false;
  return true;
}

// Resilient recursive copy: skips the denylist and — crucially — skips any
// individual file that can't be read (Edge keeps Cookies/Login Data open while
// running, and on Windows that copy can fail). A single locked file must not
// abort the whole fallback, so per-file errors are swallowed. Returns the number
// of files skipped due to errors.
function copyTreeResilient(src, dest) {
  let skipped = 0;
  let entries = [];
  try { entries = readdirSync(src, { withFileTypes: true }); } catch { return skipped; }
  mkdirSync(dest, { recursive: true });
  for (const ent of entries) {
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (!copyFilter(s)) continue;
    try {
      if (ent.isDirectory()) {
        skipped += copyTreeResilient(s, d);
      } else if (ent.isSymbolicLink()) {
        // skip symlinks (Singleton* on POSIX) to avoid copying live sockets
      } else {
        copyFileSync(s, d);
      }
    } catch { skipped++; /* locked/unreadable — skip, keep going */ }
  }
  return skipped;
}

// Create a safe, copied diagnostic profile so a *locked* real profile can still
// be used without disturbing the live browser. Copies Local State plus the
// selected profile folder, minus caches and lock files, tolerating files that
// the running browser holds open. Returns the new User Data dir path. The caller
// must clean it up (cleanupCopiedProfile).
export function copyDiagnosticProfile(userDataDir, profileDirectory = "Default", destRoot) {
  const root = destRoot || join(tmpdir(), `cwh-parity-profile-${Date.now()}`);
  const destUserData = join(root, "User Data");
  mkdirSync(destUserData, { recursive: true });
  const localState = join(userDataDir, "Local State");
  if (existsSync(localState)) {
    try { copyFileSync(localState, join(destUserData, "Local State")); } catch { /* optional */ }
  }
  const srcProfile = join(userDataDir, profileDirectory);
  if (existsSync(srcProfile)) {
    copyTreeResilient(srcProfile, join(destUserData, profileDirectory));
  }
  return destUserData;
}

export function cleanupCopiedProfile(destUserData) {
  if (!destUserData) return;
  try { rmSync(join(destUserData, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Launchers
// ---------------------------------------------------------------------------

// Common Chromium context options shared by both passes. Honours locale/timezone
// only when explicitly overridden ("system" => leave the OS/profile value).
function commonContextOptions(browserCfg) {
  const opts = {
    // viewport:null => use the real window size (no fixed automation viewport).
    viewport: browserCfg.viewport || null,
  };
  if (browserCfg.locale && browserCfg.locale !== "system") opts.locale = browserCfg.locale;
  if (browserCfg.timezone && browserCfg.timezone !== "system") opts.timezoneId = browserCfg.timezone;
  return opts;
}

// Launch the AUTOMATED baseline: real Edge channel but a *fresh temporary
// profile* (no cookies/storage), headless by default. This is the classic
// automation posture we compare the parity profile against.
export async function launchTempContext(browserCfg = {}, opts = {}) {
  const headless = opts.headless ?? true;
  const channel = browserCfg.channel || "msedge";
  let usedChannel = channel, browser;
  try {
    browser = await chromium.launch({ channel, headless });
  } catch {
    browser = await chromium.launch({ headless }); // fall back to bundled Chromium
    usedChannel = "chromium";
  }
  const context = await browser.newContext(commonContextOptions(browserCfg));
  return { browser, context, channel: usedChannel, headless, profileType: "temporary", copiedProfileUsed: false };
}

// Launch the MANUAL-PARITY context: real Edge, headed, persistent *real* profile
// so all of the user's normal state is loaded. If the real profile is locked we
// transparently fall back to a safe copied diagnostic profile and flag it.
// No stealth/init-script is injected — navigator.webdriver stays honest.
export async function launchParityContext(browserCfg = {}, opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const channel = browserCfg.channel || "msedge";
  const headless = browserCfg.headless === true; // headed by default in parity mode
  const realUserData = resolveUserDataDir(browserCfg, { platform, env });
  const profileDirectory = browserCfg.profileDirectory || "Default";
  const found = profileExists(realUserData, profileDirectory);

  const args = [];
  // Edge selects a profile via --profile-directory. "Default" is the default.
  if (profileDirectory && profileDirectory !== "Default") args.push(`--profile-directory=${profileDirectory}`);

  const launchOpts = {
    channel,
    headless,
    args,
    ...commonContextOptions(browserCfg),
    // useSystemProxy: leave proxy unset so Chromium uses the OS/Edge proxy.
    // (Setting a proxy here would override the user's real settings.)
  };

  const tryLaunch = async (userDataDir) => chromium.launchPersistentContext(userDataDir, launchOpts);

  // First attempt: the real profile (best parity).
  if (browserCfg.usePersistentProfile !== false) {
    try {
      const context = await tryLaunch(realUserData);
      return { context, channel, headless, profileType: "persistent", copiedProfileUsed: false, userDataDir: realUserData, profileFound: found };
    } catch (e) {
      // Locked / in use → fall back to a copied diagnostic profile.
      if (isProfileLockError(e)) {
        let copied;
        try {
          copied = copyDiagnosticProfile(realUserData, profileDirectory);
          const context = await tryLaunch(copied);
          return { context, channel, headless, profileType: "copied", copiedProfileUsed: true, userDataDir: copied, copiedFrom: realUserData, profileFound: found, lockReason: (e.message || "").split("\n")[0] };
        } catch (e2) {
          // Never leave the copied profile (with cookies/storage) on disk.
          if (copied) cleanupCopiedProfile(copied);
          throw new Error(`parity launch failed (real profile locked, copy fallback also failed): ${(e2.message || e2).toString().split("\n")[0]}`);
        }
      }
      throw e;
    }
  }
  // Persistent disabled by config → fresh temp persistent dir (still real Edge).
  const ephemeral = join(tmpdir(), `cwh-parity-ephemeral-${Date.now()}`, "User Data");
  mkdirSync(ephemeral, { recursive: true });
  const context = await tryLaunch(ephemeral);
  return { context, channel, headless, profileType: "ephemeral", copiedProfileUsed: false, userDataDir: ephemeral, profileFound: found };
}

export function isProfileLockError(e) {
  const m = (e && (e.message || e.toString())) || "";
  // When Edge is already running on the same User Data dir, its ProcessSingleton
  // hands the launch off to the live instance and the spawned process exits, so
  // Playwright reports a generic "closed" error. In the narrow context of a
  // persistent-profile launch, these all mean "profile is in use".
  return /ProcessSingleton|process singleton|profile (?:is|appears).*in use|already running|cannot create.*lock|SingletonLock|The browser is already running|failed to create a process singleton|browser has been closed|closed unexpectedly|Target (?:page, context or browser has been closed|closed)/i.test(m);
}

// ---------------------------------------------------------------------------
// Snapshot collection (in-page; honest values, never cookie/token contents)
// ---------------------------------------------------------------------------

// Collect a browser-parity snapshot from a live page. Reports navigator/Intl
// facts and the *presence* (not contents) of storage. Cookie values are never
// read here.
export async function collectSnapshot(page) {
  const snap = await page.evaluate(async () => {
    const nav = navigator;
    let clientHints = null;
    try {
      if (nav.userAgentData) {
        const base = { brands: nav.userAgentData.brands, mobile: nav.userAgentData.mobile, platform: nav.userAgentData.platform };
        try {
          const hi = await nav.userAgentData.getHighEntropyValues(["platform", "platformVersion", "architecture", "uaFullVersion", "fullVersionList"]);
          clientHints = { ...base, ...hi };
        } catch { clientHints = base; }
      }
    } catch { clientHints = null; }
    let localStoragePresent = false, sessionStoragePresent = false;
    try { localStoragePresent = !!window.localStorage && window.localStorage.length > 0; } catch { /* blocked */ }
    try { sessionStoragePresent = !!window.sessionStorage && window.sessionStorage.length > 0; } catch { /* blocked */ }
    let tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { /* ignore */ }
    return {
      userAgent: nav.userAgent || "",
      platform: nav.platform || "",
      language: nav.language || "",
      languages: nav.languages || [],
      timezone: tz,
      webdriver: nav.webdriver === true,
      clientHints,
      clientHintsPresent: !!clientHints,
      screen: { width: (window.screen || {}).width || 0, height: (window.screen || {}).height || 0 },
      viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 },
      devicePixelRatio: window.devicePixelRatio || 1,
      localStoragePresent,
      sessionStoragePresent,
    };
  });
  snap.edgeVersion = parseEdgeVersion(snap.userAgent);
  snap.engine = engineOf(snap.userAgent);
  return snap;
}

// ---------------------------------------------------------------------------
// Sanitisation — never expose secrets in reports, logs or HAR files
// ---------------------------------------------------------------------------

const SENSITIVE_HEADER = /(^|-)(set-)?cookie$|authorization|proxy-authorization|x-api-?key|api-?key|x-auth|auth-?token|access-?token|id-?token|refresh-?token|x-csrf|x-xsrf|session|bearer|secret|credential|ocp-apim-subscription-key|x-amz-security-token/i;

// Query/fragment parameter NAMES that commonly carry secrets (OAuth/SSO/signed
// URLs). Matched case-insensitively as a substring of the parameter name.
const SENSITIVE_PARAM = /(token|secret|password|passwd|pwd|auth|sig|signature|code|session|sid|api[-_]?key|access[-_]?token|id[-_]?token|refresh[-_]?token|client[-_]?secret|key|credential|assertion|saml)/i;

// Redact sensitive values in a `name=value&...` query/fragment string, keeping
// the parameter names so the URL shape is still legible.
function redactQueryString(qs = "") {
  return String(qs).split("&").map((pair) => {
    const i = pair.indexOf("=");
    if (i === -1) return pair;
    const k = pair.slice(0, i);
    let name = k; try { name = decodeURIComponent(k); } catch { /* keep raw */ }
    return SENSITIVE_PARAM.test(name) ? `${k}=[redacted]` : pair;
  }).join("&");
}

// Make a URL safe to store/print in a report: redact secret-bearing query params
// and any token-bearing fragment (implicit-flow tokens live in the #fragment),
// while preserving host + path. On parse failure, drop the query/fragment.
export function sanitizeUrlForReport(url) {
  const s = String(url || "");
  if (!s) return s;
  try {
    const u = new URL(s);
    for (const k of [...u.searchParams.keys()]) if (SENSITIVE_PARAM.test(k)) u.searchParams.set(k, "[redacted]");
    if (u.hash && u.hash.length > 1) u.hash = "#" + redactQueryString(u.hash.slice(1));
    return u.toString();
  } catch {
    return s.split(/[?#]/)[0];
  }
}

// Reduce a Playwright cookie array to safe metadata: names + domain/path/flags
// only. Cookie *values* are dropped entirely.
export function redactCookies(cookies = []) {
  return (cookies || []).map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite,
    hasValue: typeof c.value === "string" && c.value.length > 0,
  }));
}

// Sanitise a parsed HAR object in place-ish: drop sensitive headers, redact
// cookie arrays, scrub secret query params from request/redirect URLs, and
// remove request/response bodies that can carry tokens.
export function sanitizeHar(har) {
  try {
    const entries = (har && har.log && har.log.entries) || [];
    for (const e of entries) {
      for (const side of ["request", "response"]) {
        const msg = e[side];
        if (!msg) continue;
        if (Array.isArray(msg.headers)) msg.headers = msg.headers.filter((h) => !SENSITIVE_HEADER.test(h.name || ""));
        if (Array.isArray(msg.cookies)) msg.cookies = msg.cookies.map((c) => ({ name: c.name, redacted: true }));
        if (Array.isArray(msg.queryString)) msg.queryString = msg.queryString.map((q) => (SENSITIVE_PARAM.test(q.name || "") ? { name: q.name, value: "[redacted]" } : q));
      }
      if (e.request && e.request.url) e.request.url = sanitizeUrlForReport(e.request.url);
      if (e.response && e.response.redirectURL) e.response.redirectURL = sanitizeUrlForReport(e.response.redirectURL);
      if (e.request && e.request.postData) {
        if ("text" in e.request.postData) e.request.postData.text = "[redacted]";
        if (Array.isArray(e.request.postData.params)) {
          e.request.postData.params = e.request.postData.params.map((p) => ({ name: p.name, value: "[redacted]" }));
        }
      }
      if (e.response && e.response.content && "text" in e.response.content) {
        // Bodies may embed tokens; keep size/mimeType, drop the text.
        delete e.response.content.text;
      }
    }
  } catch { /* best effort */ }
  return har;
}

// Read a .har from disk, sanitise it, and write it back. No-op if absent/unparseable.
export function sanitizeHarFile(path) {
  try {
    if (!existsSync(path)) return false;
    const har = JSON.parse(readFileSync(path, "utf8"));
    sanitizeHar(har);
    writeFileSync(path, JSON.stringify(har));
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Classification — the diagnostic verdict (pure)
// ---------------------------------------------------------------------------

// Verdicts that mean the *site* actively rejected the request (vs a transport
// error). Mirrors probe-core's block-ish set.
const BLOCK_VERDICTS = new Set(["BLOCKED", "IP_REPUTATION", "BOT_CHALLENGE", "HUMAN_CHALLENGE"]);

// Stable ordering for sub-reasons so report output is deterministic.
const SUBREASON_ORDER = [
  "SITE_REJECTS_AUTOMATED_BROWSER",
  "TEMP_PROFILE_USED",
  "MISSING_COOKIES",
  "PROFILE_NOT_LOADED",
  "HEADLESS_MODE",
  "BROWSER_VERSION_MISMATCH",
  "CLIENT_POSTURE_POLICY",
  "SCRIPT_OR_RESOURCE_FAILURE",
];

// Classify a parity run.
//   input = {
//     manual: { works? },                       // human-observed (default works)
//     temp:   pass,                              // automated temp-profile pass
//     parity: pass,                              // manual-parity pass
//     installedEdgeVersion: "149.0.x",
//   }
//   pass = { works, headless, profileType, cookiesPresent, copiedProfileUsed,
//            profileFound, edgeVersion, engine, webdriver, clientHintsPresent,
//            consoleErrors, failedRequests, verdict }
// Returns { classification, subReasons:[{code,detail}], summary, manualWorks,
//           tempWorks, parityWorks }.
export function classifyParity(input = {}) {
  const manual = input.manual || {};
  const temp = input.temp || {};
  const parity = input.parity || {};
  const installed = input.installedEdgeVersion || "";

  const manualWorks = manual.works !== false; // default: the diagnostic premise
  const tempWorks = !!temp.works;
  const parityWorks = !!parity.works;

  let classification, summary;
  if (manualWorks && (!tempWorks || !parityWorks)) {
    classification = "AUTOMATION_OR_BROWSER_POSTURE";
    summary = parityWorks
      ? "Manual/real-profile browsing works but the automated temporary-profile browser fails — the failure is the diagnostic browser environment, not the network."
      : "Manual browsing works but the automated browser fails even with the real profile — the failure is tied to the automated browser posture, not a plain network outage.";
  } else if (!manualWorks && !parityWorks) {
    classification = "NETWORK_OR_SITE_FAILURE";
    summary = "The target fails manually and with your real profile — this looks like a real network or site failure, not the diagnostic browser.";
  } else if (tempWorks && parityWorks) {
    classification = "NO_FAILURE_REPRODUCED";
    summary = "Both the automated temporary profile and the manual-parity profile loaded the target — no browser-environment failure reproduced.";
  } else {
    classification = "INCONCLUSIVE";
    summary = "Mixed results — close all Edge windows and re-run, and confirm whether the target loads in your normal Edge.";
  }

  const subReasons = [];
  const add = (code, detail) => { if (!subReasons.some((s) => s.code === code)) subReasons.push({ code, detail }); };

  if (classification === "AUTOMATION_OR_BROWSER_POSTURE") {
    const failing = [];
    if (!tempWorks) failing.push(temp);
    if (!parityWorks) failing.push(parity);

    // SITE_REJECTS_AUTOMATED_BROWSER — only when even the real-profile run (≈ the
    // user's manual browser) is blocked/challenged while manual works: the sole
    // remaining differentiator is "automated". A temp-only block is NOT this —
    // an automated browser (parity) did work, so it is a profile/posture gap.
    if (!parityWorks && BLOCK_VERDICTS.has(parity.verdict)) {
      add("SITE_REJECTS_AUTOMATED_BROWSER", `The real-profile automated run was ${parity.verdict} while manual browsing works — the site appears to reject automated browsers regardless of profile.`);
    }

    // TEMP_PROFILE_USED — the failing automated run used a throwaway profile.
    if (!tempWorks && temp.profileType === "temporary") {
      add("TEMP_PROFILE_USED", "The failing automated run used a fresh temporary profile with none of your normal browser state (cookies, storage, preferences).");
    }

    // MISSING_COOKIES — failing temp run had no cookies while parity had some.
    if (!tempWorks && (temp.cookiesPresent || 0) === 0 && parityWorks && (parity.cookiesPresent || 0) > 0) {
      add("MISSING_COOKIES", `The temporary-profile run sent 0 cookies for the origin; the real profile sent ${parity.cookiesPresent}. The site likely needs an existing session.`);
    }

    // PROFILE_NOT_LOADED — parity pass didn't actually carry the real state.
    if (!parityWorks) {
      if (parity.copiedProfileUsed) add("PROFILE_NOT_LOADED", "The real profile was locked, so a copied diagnostic profile was used — it may lack live session state. Close Edge and re-run for full parity.");
      else if (parity.profileFound === false) add("PROFILE_NOT_LOADED", "The selected profile directory was not found under the Edge User Data dir.");
      else if ((parity.cookiesPresent || 0) === 0) add("PROFILE_NOT_LOADED", "The persistent profile loaded 0 cookies for the origin — it may not be the profile you normally browse with.");
    }

    // HEADLESS_MODE — a failing run was headless.
    for (const f of failing) if (f.headless) { add("HEADLESS_MODE", "A failing run was headless; some sites and conditional-access policies treat headless browsers differently from a visible window."); break; }

    // BROWSER_VERSION_MISMATCH — automated browser != installed Edge.
    for (const f of failing) {
      if (f.engine && f.engine !== "Edge") { add("BROWSER_VERSION_MISMATCH", `A failing run used ${f.engine}, not Edge (Edge channel unavailable → fell back to bundled Chromium).`); break; }
      if (f.edgeVersion && installed && majorVersion(f.edgeVersion) !== majorVersion(installed)) {
        add("BROWSER_VERSION_MISMATCH", `Automated Edge ${f.edgeVersion} differs from your installed Edge ${installed}.`); break;
      }
    }

    // CLIENT_POSTURE_POLICY — automation markers a ZTNA/CA policy can key on.
    for (const f of failing) {
      if (f.webdriver === true || f.clientHintsPresent === false) {
        add("CLIENT_POSTURE_POLICY", "Automation markers were present on a failing run (navigator.webdriver=true and/or reduced client hints) that a Zero-Trust or conditional-access policy can block.");
        break;
      }
    }

    // SCRIPT_OR_RESOURCE_FAILURE — console errors / failed sub-resources.
    for (const f of failing) {
      if ((f.consoleErrors || 0) > 0 || (f.failedRequests || 0) > 0) {
        add("SCRIPT_OR_RESOURCE_FAILURE", `A failing run logged ${f.consoleErrors || 0} console error(s) and ${f.failedRequests || 0} failed request(s) — a script or resource may not have loaded.`);
        break;
      }
    }
  }

  subReasons.sort((a, b) => SUBREASON_ORDER.indexOf(a.code) - SUBREASON_ORDER.indexOf(b.code));
  return { classification, subReasons, summary, manualWorks, tempWorks, parityWorks };
}

// Build the field-by-field Browser Parity Report rows (pure). `report` is the
// assembled parity-report.json object. Returns [{ field, normal, automatedTemp,
// automatedParity }] for the comparison table.
export function parityComparisonRows(report = {}) {
  const installed = report.installedEdge || {};
  const t = (report.temp && report.temp.snapshot) || {};
  const p = (report.parity && report.parity.snapshot) || {};
  const tp = report.temp || {}, pp = report.parity || {};
  const ch = (s) => {
    if (!s || !s.clientHints) return s && s.clientHintsPresent === false ? "absent" : "—";
    const b = (s.clientHints.brands || []).map((x) => `${x.brand} ${x.version}`).join(", ");
    return b || "present";
  };
  const dims = (s) => (s && s.screen ? `${s.viewport.width}x${s.viewport.height} (screen ${s.screen.width}x${s.screen.height})` : "—");
  const proxy = report.systemProxy || {};
  const proxyStr = proxy.enabled ? `${proxy.server || "configured"} (${proxy.source})` : "direct / none";
  return [
    { field: "Normal Edge version", normal: installed.version || "unknown", automatedTemp: "—", automatedParity: "—" },
    { field: "Automated Edge version", normal: "—", automatedTemp: t.edgeVersion || `(${t.engine || "?"})`, automatedParity: p.edgeVersion || `(${p.engine || "?"})` },
    { field: "User agent", normal: "—", automatedTemp: t.userAgent || "—", automatedParity: p.userAgent || "—" },
    { field: "Client hints", normal: "—", automatedTemp: ch(t), automatedParity: ch(p) },
    { field: "OS / platform", normal: "—", automatedTemp: t.platform || "—", automatedParity: p.platform || "—" },
    { field: "Timezone", normal: "—", automatedTemp: t.timezone || "—", automatedParity: p.timezone || "—" },
    { field: "Language", normal: "—", automatedTemp: (t.languages || []).join(",") || t.language || "—", automatedParity: (p.languages || []).join(",") || p.language || "—" },
    { field: "Viewport / screen", normal: "—", automatedTemp: dims(t), automatedParity: dims(p) },
    { field: "Proxy settings", normal: proxyStr, automatedTemp: proxyStr, automatedParity: proxyStr },
    { field: "Profile type", normal: "real (your Edge profile)", automatedTemp: tp.profileType || "temporary", automatedParity: pp.profileType || "persistent" },
    { field: "Cookies present", normal: report.cookiesAvailable ? "yes" : "unknown", automatedTemp: String(tp.cookiesPresent ?? 0), automatedParity: String(pp.cookiesPresent ?? 0) },
    { field: "Local storage present", normal: "—", automatedTemp: t.localStoragePresent ? "yes" : "no", automatedParity: p.localStoragePresent ? "yes" : "no" },
    { field: "navigator.webdriver", normal: "false", automatedTemp: String(t.webdriver === true), automatedParity: String(p.webdriver === true) },
    { field: "Headless", normal: "no", automatedTemp: String(tp.headless === true), automatedParity: String(pp.headless === true) },
  ];
}

// Human-friendly recommended fixes derived from a classification result.
export function recommendedFixes(classification = {}, ctx = {}) {
  const fixes = [];
  const codes = new Set((classification.subReasons || []).map((s) => s.code));
  if (codes.has("PROFILE_NOT_LOADED") || ctx.profileLocked) fixes.push("Close all Microsoft Edge windows so the diagnostic can open your real profile (or it will use a copied profile).");
  if (codes.has("MISSING_COOKIES") || codes.has("TEMP_PROFILE_USED")) fixes.push("Run in manual-parity mode (usePersistentProfile:true) so your existing cookies/session are used.");
  if (codes.has("HEADLESS_MODE")) fixes.push("Run headed (headless:false) to match your normal Edge window.");
  if (codes.has("BROWSER_VERSION_MISMATCH")) fixes.push("Install/select the Edge channel (channel:msedge) so the automated and normal Edge versions match.");
  if (codes.has("CLIENT_POSTURE_POLICY")) fixes.push("If a Zero-Trust/conditional-access policy blocks automation, validate from a managed, compliant manual session — do not attempt to bypass the policy.");
  if (codes.has("SITE_REJECTS_AUTOMATED_BROWSER")) fixes.push("The site rejects automated browsers by policy; treat results as 'works manually' and escalate with the parity report rather than bypassing protections.");
  if (codes.has("SCRIPT_OR_RESOURCE_FAILURE")) fixes.push("Review the captured console/network log for the failed script or resource.");
  if (classification.classification === "NETWORK_OR_SITE_FAILURE") fixes.push("The target also fails manually — investigate the network path/egress IP or the site itself, not the browser.");
  if (!fixes.length) fixes.push("No browser-environment fix required.");
  return fixes;
}

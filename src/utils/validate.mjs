// validate.mjs — small, pure input validators. No dependencies so they are
// trivially unit-testable and safe to reuse from the CLI and config layers.

const HOST_RE = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/i;

// Strip a scheme, path, query, fragment, port and surrounding noise from a
// user-supplied target, returning a bare lowercase hostname. Returns "" when
// nothing host-like remains.
export function normalizeHost(input) {
  let s = String(input ?? "").trim();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // scheme://
  s = s.replace(/^[^@/]*@/, "");                 // user:pass@
  s = s.split(/[/?#]/)[0];                        // path/query/fragment
  s = s.split(":")[0];                            // :port
  return s.trim().toLowerCase();
}

// True when `host` is a syntactically valid DNS hostname (one or more labels
// plus a TLD). Does not perform DNS resolution.
export function isValidHost(host) {
  const h = normalizeHost(host);
  if (!h || h.length > 253) return false;
  return HOST_RE.test(h);
}

// Validate a value against a fixed set, returning the value when valid or the
// supplied fallback otherwise. Used to keep enum-style config (channel, shots)
// from ever holding an unexpected value.
export function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export const CHANNELS = ["msedge", "chrome", "chromium"];
export const SHOT_MODES = ["all", "fail", "none"];

// Browser modes for the Manual Browser Parity feature:
//   manual-parity — real Edge, headed, persistent real profile (match the user)
//   automated     — fresh temporary profile (the classic automation baseline)
export const BROWSER_MODES = ["manual-parity", "automated"];

// Coerce a loosely-typed value (string "1"/"true"/etc, number, boolean) to a
// boolean. Used to normalise config-file/env values for the browser block.
export function toBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value == null) return fallback;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

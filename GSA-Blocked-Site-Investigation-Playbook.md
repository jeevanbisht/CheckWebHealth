# GSA Blocked-Website Investigation Playbook

A repeatable method for diagnosing why a website is blocked / returns an error for users
on **Global Secure Access (GSA)** Internet Access. Use this to determine whether the block
comes from **GSA**, the **destination CDN/origin (e.g., Akamai, Cloudflare, Imperva)**, or a
**bot-detection / IP-reputation** system.

> Reference example: `automobiles.honda.com` → Akamai Bot Manager 403. See
> `GSA-Investigation-Note-honda-akamai-403.md` for a completed instance of this playbook.

---

## 0. Before you start — capture cleanly

A good capture is everything. Bad captures produce wrong conclusions.

1. Reproduce in the **real browser** (Edge/Chrome) with the **GSA client running** — not a proxy or emulator.
2. **Turn OFF DevTools device emulation** (no mobile/tablet toolbar). An emulated User-Agent over a
   desktop TLS fingerprint is itself a bot-detection trigger and will pollute your findings.
3. Open **DevTools → Network** tab, then enable:
   - ☑ **Preserve log** (keeps entries across the redirect to the error page)
   - ☑ **Disable cache**
4. Clear the list, then perform the action that triggers the block.
5. **Export HAR** (download-arrow → "Export HAR (with sensitive data)").
6. Optionally capture a **control HAR off-GSA** (split tunnel / GSA paused) to compare.

> ⚠️ A HAR contains cookies, auth headers, and tokens. Treat it as sensitive; share only with support.

---

## 1. Triage questions (answer these from the HAR)

| Question | How to find it |
|----------|----------------|
| Which request(s) actually failed? | Filter Network by status `403/401/429/503` or sort by status. |
| What HTTP status + body? | Open the failing entry → Response. Look for "Access Denied", "Attention Required", "challenge". |
| **Who** served the block? | Response header `server:` (`AkamaiGHost`, `cloudflare`, `imperva`, origin name). |
| Did it reach the origin or stop at the edge? | CDN headers, cache hit on the error, edge reference IDs. |
| Was the traffic GSA-tunneled? | `serverIPAddress` on the entry — synthetic GSA IP vs. real public CDN IP. |
| Off-GSA control differs? | Compare against the control HAR (if captured). |

---

## 2. Identify the blocking party

### 2.1 Is it GSA itself?
GSA-side blocks look different from CDN blocks:
- Connection **fails/resets** or returns a **GSA/Entra block/notification page**, not a CDN error page.
- DNS resolution fails, or the request never leaves the tunnel.
- `serverIPAddress` is a **GSA synthetic IP** AND there is **no upstream CDN response**.

### 2.2 Is it the destination CDN / origin? (most common)
Identify the vendor from `server:` and signature headers:

| Vendor | `server:` | Tell-tale headers / artifacts | Block page signature |
|--------|-----------|-------------------------------|----------------------|
| **Akamai** | `AkamaiGHost` | `akamai-grn`, `x-akam-sw-*`, `akam-sw-policy.json`, `errors.edgesuite.net`, mPulse `go-mpulse.net` beacon | "Access Denied … Reference #…" |
| **Cloudflare** | `cloudflare` | `cf-ray`, `cf-mitigated`, `cf-chl-*`, `__cf_bm` cookie | "Attention Required", "Just a moment…", challenge |
| **Imperva/Incapsula** | (varies) | `x-iinfo`, `incap_ses`, `visid_incap` cookies | "Request unsuccessful. Incapsula incident ID" |
| **AWS WAF / CloudFront** | `CloudFront` | `x-amz-cf-id`, `x-amzn-waf-*` | 403 "Request blocked" |
| **F5 / BIG-IP ASM** | `BigIP`/`BIG-IP` | `TS…` cookies, support ID page | "The requested URL was rejected. … support ID" |

### 2.3 Is it bot-detection vs. a hard policy/geo block?
- **Bot-detection** (most GSA-related): JS/service-worker challenge scripts present
  (`akam-sw-policy.json`, `cf-chl`, mPulse/boomerang), telemetry beacons cancelled (status 0),
  block served from **cache HIT**. Trigger = **egress-IP reputation + TLS/HTTP2 fingerprint**.
- **Geo / hard ACL block**: consistent 403 with no challenge scripts; often `cf-mitigated: block`
  or explicit country messaging.
- **Rate limiting**: `429`, `Retry-After` header.

---

## 3. Confirm the traffic path (GSA tunnel evidence)

- Note the `serverIPAddress` for the blocked host.
- Compare to the host's **real public IP** (`nslookup <host>` off-GSA, or known CDN ranges:
  Akamai 23.x/104.x/2.16.x, Cloudflare 104.16.x/172.64.x).
- A **non-public / synthetic IP** (e.g., `6.6.x.x` seen with GSA) ⇒ the FQDN was **intercepted and
  tunneled** by the GSA client. Document the path:

```
Browser  →  GSA client (synthetic IP)  →  GSA egress IP  →  CDN/origin  →  <status>
```

---

## 4. Root-cause reasoning

Ask: *what changed because GSA is in the path?* Usually one of:
1. **Egress IP reputation** — GSA shared cloud egress IPs scored as datacenter/bot by the CDN.
2. **TLS/HTTP2 fingerprint** — GSA's handling alters the client fingerprint the CDN expects.
3. **Geo shift** — GSA egress region differs from the user's expected country.
4. **Header/SNI handling** — modified or missing headers trip a WAF rule.
5. **Local variable (not GSA)** — emulated UA, extensions, stale cookies (rule these out first).

---

## 5. Collect the identifiers support will need

Always extract the vendor's **incident/reference IDs** — support cannot find the block without them:

| Vendor | ID to grab |
|--------|-----------|
| Akamai | `akamai-grn` header + on-page Reference # (`errors.edgesuite.net/<id>`) |
| Cloudflare | `cf-ray` |
| Imperva | "Incapsula incident ID" from the block page |
| AWS | `x-amz-cf-id` / WAF request ID |
| F5 | "support ID" from the rejection page |

Plus: affected host + paths, timestamp (from response `date:` header), GSA egress IP/region.

---

## 6. Recommended remediation paths

| Owner | Action |
|-------|--------|
| Reporter | Re-capture with emulation OFF / extensions disabled to rule out local variables. Capture an off-GSA control HAR. |
| GSA Eng | Identify GSA egress IP/ASN for the session; check against the CDN's bot/datacenter reputation lists. |
| GSA Eng | Consider dedicated/static egress IP, or **bypass/exclude** the FQDN from the Internet Access forwarding profile. |
| GSA Eng | Assess TLS/HTTP2 fingerprint impact. |
| Site/CDN support | Provide the vendor incident ID + GSA egress IP/ASN and request an **allowlist** in the WAF/Bot Manager. |

---

## 7. Quick HAR analysis snippet

Parse any HAR for failures, the blocking vendor, and the tunnel IP:

```js
// node analyze-har.mjs <path-to.har>
import { readFileSync } from "node:fs";
const har = JSON.parse(readFileSync(process.argv[2], "utf8"));
const pick = (hs, n) => (hs.find(h => h.name.toLowerCase() === n) || {}).value;
const codes = {};
for (const e of har.log.entries) {
  const s = e.response.status; codes[s] = (codes[s] || 0) + 1;
  if (s >= 400 || s === 0) {
    const h = e.response.headers;
    console.log(`\n${s}  ${e.request.method} ${e.request.url}`);
    console.log("   serverIP :", e.serverIPAddress || "(none)");
    console.log("   server   :", pick(h, "server"));
    console.log("   ids      :", [
      pick(h, "akamai-grn") && "akamai-grn=" + pick(h, "akamai-grn"),
      pick(h, "cf-ray") && "cf-ray=" + pick(h, "cf-ray"),
      pick(h, "x-iinfo") && "x-iinfo=" + pick(h, "x-iinfo"),
      pick(h, "x-amz-cf-id") && "x-amz-cf-id=" + pick(h, "x-amz-cf-id"),
    ].filter(Boolean).join("  ") || "(none)");
  }
}
console.log("\nStatus tally:", codes);
```

---

## 8. Deliverable: the investigation note

Produce a note with these sections (template):

1. **Summary** — who blocks, where (edge vs origin), GSA-related or not.
2. **Evidence from the HAR** — failing requests table, vendor headers, bot/challenge artifacts, tunnel IP proof.
3. **Contributing factors to rule out** — local/emulation variables.
4. **Root-cause hypothesis** — which GSA-path change is responsible.
5. **Recommended actions** — owner/action table.
6. **Key identifiers** — vendor incident IDs, egress IP, host/paths, timestamp.

Output formats used in the reference case: `.md`, self-contained `.html` (print-ready).

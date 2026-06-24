# Investigation Note — GSA Engineering Team

**Subject:** Akamai "Access Denied" (HTTP 403) on `automobiles.honda.com` for GSA-tunneled users
**Date:** 2026-06-23
**Reporter:** @jeevanbisht
**Artifact:** `c:\temp10\automobiles.honda.com.har` (HAR captured in Microsoft Edge DevTools)
**Severity:** Medium — site partially unusable behind GSA (Build & Price / homepage blocked)

---

## 1. Summary

Users on **Global Secure Access (GSA) Internet Access** receive an **Akamai "Access Denied" (HTTP 403)** page when browsing `https://automobiles.honda.com` (reproduced on the homepage `/` and the **Build & Price** flow `/tools/build-and-price`).

**The block originates at Akamai's edge (CDN/origin side), not at the GSA tunnel.** GSA successfully forwards the request; Akamai **Bot Manager** rejects it. This is therefore a **bot-detection / egress-reputation** interaction, not a GSA policy drop.

---

## 2. Evidence from the HAR

### 2.1 Blocked requests
| Status | Method | URL | Server |
|--------|--------|-----|--------|
| 403 | GET | `https://automobiles.honda.com/` | `AkamaiGHost` |
| 403 | GET | `https://automobiles.honda.com/akam-sw-policy.json` | `AkamaiGHost` |

Response body = standard Akamai denial:
> Access Denied — You don't have permission to access "http://automobiles.honda.com/" on this server.
> Reference #18.d90c0317.1782244550.7f5af303
> https://errors.edgesuite.net/18.d90c0317.1782244550.7f5af303

### 2.2 Block served by Akamai (not GSA)
- `server: AkamaiGHost`
- `akamai-grn: 0.d90c0317.1782244550.7f5af303`  ← Akamai Global Request Number (use this with Akamai/Honda support)
- `server-timing: cdn-cache; desc=HIT`  ← the denial itself was served from Akamai cache

### 2.3 Mechanism = Akamai Bot Manager
- Request to `akam-sw-policy.json` + response header `x-akam-sw-version: 0.5.0` → Akamai bot-detection **service worker**.
- mPulse telemetry beacon `s.go-mpulse.net/boomerang/88DDH-BYYGC-UBBFU-YMMLJ-K2WHX` returned **status 0** (cancelled/blocked) → bot telemetry never completed.

### 2.4 Confirmation the traffic was GSA-tunneled
- `serverIPAddress` for `automobiles.honda.com` = **`6.6.5.88`** (and `6.6.5.89` for `cdn.fonts.net`).
- These are **not** real Akamai public IPs (Akamai uses 23.x / 104.x / 2.16.x). `6.6.5.x` is a **GSA synthetic/tunnel destination IP**, confirming the FQDN was intercepted and tunneled by the GSA client.
- **Path:** Browser → GSA client (synthetic IP 6.6.5.88) → GSA egress → Akamai edge → **403**.

---

## 3. Contributing factor observed in capture (to rule out)

The captured request used a **mobile/emulated User-Agent** while running on a Windows desktop:
```
user-agent: Mozilla/5.0 (Linux; Android 15; Pixel 9) ... Chrome/149 Mobile Safari/537.36
sec-ch-ua-mobile: ?1
sec-ch-ua-platform: "Android"
```
This indicates **DevTools device emulation was ON** during capture. A mobile UA over a desktop TLS/HTTP2 fingerprint is an inconsistent-signal pattern that Akamai Bot Manager independently scores as bot-like. **This must be eliminated as a variable** before attributing the block solely to GSA (see Action 1).

---

## 4. Root-cause hypothesis

Akamai Bot Manager scores requests on **egress-IP reputation + TLS/HTTP2 client fingerprint + client-signal consistency**. When users egress via GSA's **shared cloud egress IPs**, Akamai is likely classifying the traffic as **datacenter/bot** origin and returning 403. This is consistent with the site working off-GSA but failing behind it.

---

## 5. Recommended actions

| # | Owner | Action |
|---|-------|--------|
| 1 | Reporter | Re-capture with **DevTools emulation OFF** (genuine desktop Edge UA) to confirm the block persists independent of the spoofed mobile UA. |
| 2 | GSA Eng | Identify the **GSA egress IP/ASN** used for this session and check it against Akamai bot/datacenter reputation lists. |
| 3 | GSA Eng | Evaluate **dedicated/static egress IP** (better reputation) or **bypass/exclude `*.honda.com`** from the Internet Access forwarding profile as a mitigation. |
| 4 | Honda/Akamai support | Using **akamai-grn `0.d90c0317.1782244550.7f5af303`** / Reference **#18.d90c0317.1782244550.7f5af303**, request an **allowlist** for the GSA egress IP/ASN in Akamai Bot Manager. |
| 5 | GSA Eng | Assess whether GSA's TLS/HTTP2 handling alters the client fingerprint in a way that increases bot scoring. |

---

## 6. Key identifiers (for support tickets)

- **Akamai GRN:** `0.d90c0317.1782244550.7f5af303`
- **Edge reference #:** `18.d90c0317.1782244550.7f5af303`
- **GSA synthetic dest IP observed:** `6.6.5.88`
- **Timestamp:** Tue, 23 Jun 2026 19:55:50 GMT
- **Affected host:** `automobiles.honda.com` (paths `/`, `/tools/build-and-price`)

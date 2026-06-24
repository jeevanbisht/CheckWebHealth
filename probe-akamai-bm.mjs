// node probe-akamai-bm.mjs
// Probes candidate sites for Akamai Bot Manager signatures.
// Strong signals: server: AkamaiGHost, akamai-grn header,
//   Set-Cookie _abck / bm_sz / ak_bmsc (Bot Manager sensor cookies).

const SITES = [
  // Automotive (peers of honda)
  "https://automobiles.honda.com/",
  "https://www.toyota.com/",
  "https://www.ford.com/",
  "https://www.chevrolet.com/",
  "https://www.bmwusa.com/",
  "https://www.mbusa.com/",
  "https://www.nissanusa.com/",
  "https://www.hyundaiusa.com/",
  "https://www.kia.com/us/en.html",
  "https://www.subaru.com/",
  // Airlines
  "https://www.united.com/",
  "https://www.delta.com/",
  "https://www.southwest.com/",
  "https://www.aa.com/",
  "https://www.lufthansa.com/us/en/homepage",
  // Retail
  "https://www.walmart.com/",
  "https://www.bestbuy.com/",
  "https://www.target.com/",
  "https://www.homedepot.com/",
  "https://www.costco.com/",
  "https://www.nike.com/",
  // Ticketing / hospitality
  "https://www.ticketmaster.com/",
  "https://www.marriott.com/",
  "https://www.hilton.com/en/",
  // Telco / finance
  "https://www.att.com/",
  "https://www.verizon.com/",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const BM_COOKIES = ["_abck", "bm_sz", "ak_bmsc", "bm_mi", "bm_sv"];

async function probe(url) {
  const res = { url, status: "-", server: "-", grn: false, bmCookies: [], akamai: false };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    const r = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent": UA,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(t);
    res.status = r.status;
    const server = r.headers.get("server") || "-";
    res.server = server;
    if (/akamai/i.test(server)) res.akamai = true;
    if (r.headers.get("akamai-grn")) res.grn = true;
    if (r.headers.has("x-akamai-transformed") || r.headers.get("akamai-grn"))
      res.akamai = true;
    // Node fetch merges set-cookie via getSetCookie()
    const cookies = (r.headers.getSetCookie && r.headers.getSetCookie()) || [];
    const cookieStr = cookies.join("; ");
    for (const c of BM_COOKIES) {
      if (new RegExp("\\b" + c + "=").test(cookieStr)) res.bmCookies.push(c);
    }
    if (res.bmCookies.length) res.akamai = true;
  } catch (e) {
    res.status = "ERR:" + (e.code || e.name || e.message);
  }
  return res;
}

const results = await Promise.all(SITES.map(probe));
results.sort((a, b) => Number(b.bmCookies.length) - Number(a.bmCookies.length));

console.log(
  "BOTMGR  STATUS  SERVER".padEnd(40) + "BM-COOKIES                URL"
);
for (const r of results) {
  const bm = r.bmCookies.length ? "✔ BM " : r.akamai ? "~AKA " : "  -  ";
  const line =
    bm.padEnd(6) +
    String(r.status).padEnd(7) +
    String(r.server).slice(0, 14).padEnd(15) +
    (r.bmCookies.join(",") || "-").padEnd(26) +
    r.url;
  console.log(line);
}
const bmSites = results.filter((r) => r.bmCookies.length);
console.log(
  `\n${bmSites.length}/${results.length} sites show Akamai Bot Manager sensor cookies.`
);
console.log("Bot Manager confirmed:", bmSites.map((r) => new URL(r.url).host).join(", "));

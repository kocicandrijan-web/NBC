// NBC scheduled search. Runs on GitHub Actions every 3 hours (see .github/workflows/search.yml).
// Reads the owner's wishes, target prices and tracked links from the NBC server, visits shop pages,
// reads the product data shops publish for search engines, and sends the result back to the server.
// Then it sends push notifications for anything worth knowing.
import { readFile } from "node:fs/promises";
import webpush from "web-push";
import { extractProduct, extractLinks, matchesQuery, robotsAllows, hostOf, offerId, canonicalUrl, guessCategory } from "../public/lib/extract.js";

const BASE = (process.env.NBC_URL || "").replace(/\/+$/, "");
const KEY = process.env.NBC_KEY || "";
const DRY = process.argv.includes("--dry");
const ALLOW_HTTP = process.env.NBC_ALLOW_HTTP === "1"; // only for local tests
const LIMITS = {
  pages: Number(process.env.NBC_MAX_PAGES || 160), // all page reads in one run
  recheck: 40, // existing offers re-read per run
  wishShops: 8, wishLinks: 5, wishMatches: 3,
  dealShops: 8, dealLinks: 8, newOffers: 30,
  keepDays: 14, maxOffers: 1500,
};
const MIN_DISCOUNT = 0.05;
if (!BASE || !KEY) { console.error("Manjka NBC_URL ali NBC_KEY."); process.exit(1); }

const now = new Date();
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const ljub = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Ljubljana", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
const part = (t) => ljub.find((p) => p.type === t).value;
const RUN_ID = `${part("year")}${part("month")}${part("day")}-${part("hour")}${part("minute")}`;
const UA = `NBC-pregled-cen/1.0 (+${BASE}/)`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------- server ---------- */
async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { authorization: "Bearer " + KEY, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${(data && data.error) || text.slice(0, 200)}`);
  return data;
}

/* ---------- polite fetching ---------- */
const stats = new Map(); // host -> {fetched, products, errors, blocked, robots}
const stat = (h) => { if (!stats.has(h)) stats.set(h, { fetched: 0, products: 0, errors: 0, blocked: 0, robots: 0, lastError: "" }); return stats.get(h); };
const robots = new Map();
const lastHit = new Map();
let pagesLeft = LIMITS.pages;

async function getRobots(origin) {
  if (robots.has(origin)) return robots.get(origin);
  const p = (async () => {
    try {
      const r = await fetch(origin + "/robots.txt", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
      return r.ok ? (await r.text()).slice(0, 200_000) : "";
    } catch { return ""; }
  })();
  robots.set(origin, p);
  return p;
}

async function page(url) {
  const u = new URL(url);
  if (u.protocol !== "https:" && !(ALLOW_HTTP && u.protocol === "http:")) throw new Error("ni https");
  const h = hostOf(url), s = stat(h);
  if (pagesLeft <= 0) throw new Error("omejitev branj");
  if (!robotsAllows(await getRobots(u.origin), url, "nbc")) { s.robots++; throw Object.assign(new Error("robots.txt ne dovoli"), { robots: true }); }
  const wait = (lastHit.get(h) || 0) + 1200 - Date.now(); // at most one request per 1.2 s per shop
  lastHit.set(h, Date.now() + Math.max(0, wait));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  pagesLeft--;
  s.fetched++;
  let r;
  try {
    r = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "accept-language": "sl-SI,sl;q=0.9,en;q=0.6" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { s.errors++; s.lastError = "ni odziva"; throw e; }
  if (r.status === 403 || r.status === 429 || r.status === 503) { s.blocked++; s.lastError = "HTTP " + r.status; throw Object.assign(new Error("HTTP " + r.status), { blocked: true }); }
  if (!r.ok) { s.errors++; s.lastError = "HTTP " + r.status; throw Object.assign(new Error("HTTP " + r.status), { gone: r.status === 404 || r.status === 410 }); }
  let html = await r.text();
  if (html.length > 3_000_000) html = html.slice(0, 3_000_000);
  if (/captcha|cf-chl-|are you a robot|access denied/i.test(html.slice(0, 20000)) && !/application\/ld\+json/i.test(html)) {
    s.blocked++; s.lastError = "zaščita pred roboti";
    throw Object.assign(new Error("zaščita pred roboti"), { blocked: true });
  }
  return { html, finalUrl: r.url || url };
}

async function pool(items, size, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(size, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}

/* ---------- data ---------- */
log(`NBC iskanje ${RUN_ID} → ${BASE}${DRY ? " (poskus, brez zapisa)" : ""}`);
const [catalog, radar] = await Promise.all([api("/api/catalog"), api("/api/radar")]);
const shippedSources = JSON.parse(await readFile(new URL("../public/data/sources.json", import.meta.url), "utf8"));
const sources = new Map();
for (const s of shippedSources) sources.set(s.id, { ...s });
for (const s of catalog.sources || []) sources.set(s.id, { ...(sources.get(s.id) || {}), ...s, search: (sources.get(s.id) || {}).search ?? s.search ?? null, deals: (sources.get(s.id) || {}).deals ?? s.deals ?? [] });
// Local tests only: NBC_ONLY_HOSTS=127.0.0.1 keeps the run on a test shop.
const ONLY = (process.env.NBC_ONLY_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean);
const activeSources = () => [...sources.values()].filter((s) => !ONLY.length || ONLY.includes(hostOf(s.url)));
const storeOf = (host) => sources.get(host) || [...sources.values()].find((s) => hostOf(s.url) === host) || null;

const offers = new Map((catalog.offers || []).map((o) => [o.id, o]));
const inScope = (o) => !ONLY.length || ONLY.includes(hostOf(o.url));
const targets = radar.targets || [];
const watch = radar.watch || [];
const tracked = radar.tracked || [];
const run = { id: RUN_ID, kind: "auto", status: "running", startedAt: nowIso() };
if (!DRY) await api("/api/run", { method: "PUT", body: run }).catch((e) => log("run start:", e.message));

const counters = { rechecked: 0, updated: 0, added: 0, priceDrops: 0, outOfStock: 0, targetHits: 0, watchMatches: 0 };
const news = { hits: [], matches: [], drops: [], fresh: [] };
const radarUpdates = { watch: [], targets: [], tracked: [] };

/** Merge one freshly read product into the catalog. */
function upsert(p, extra = {}) {
  const id = offerId(p.url);
  const prev = offers.get(id);
  const host = hostOf(p.url);
  const src = storeOf(host);
  const t = nowIso();
  const history = Array.isArray(prev?.history) ? [...prev.history] : [];
  if (!history.length || history[history.length - 1].price !== p.price) history.push({ price: p.price, at: t });
  while (history.length > 60) history.shift();
  const o = {
    ...(prev || {}),
    id, url: p.url, name: p.name || prev?.name || "Izdelek", brand: p.brand || prev?.brand || "",
    category: p.category || prev?.category || guessCategory(p.name) || (src && src.category && src.category.split(",")[0].trim()) || "Ostalo",
    store: src?.name || prev?.store || host, country: src?.country || prev?.country || null,
    currency: "EUR", price: p.price, referencePrice: p.referencePrice, referenceLabel: p.referenceLabel,
    shipping: p.shipping ?? prev?.shipping ?? null, shippingCountries: p.shippingCountries ?? prev?.shippingCountries ?? null,
    variant: p.variant || prev?.variant || "", gtin: p.gtin || prev?.gtin || null, availability: p.availability,
    checkedAt: t, firstSeenAt: prev?.firstSeenAt || t, history, sourceHost: host, image: p.image || null,
    evidence: describe(p), watchMatch: extra.watchMatch ?? prev?.watchMatch ?? null,
  };
  // When the shop shows no earlier price, use the highest price NBC itself saw in the last 30 days.
  if (!o.referencePrice) {
    const since = Date.now() - 30 * 864e5;
    const seen = history.filter((h) => Date.parse(h.at) >= since).map((h) => h.price);
    const max = seen.length > 1 ? Math.max(...seen) : null;
    if (max && max > o.price * 1.01) { o.referencePrice = max; o.referenceLabel = "Najvišja cena, ki jo je NBC zabeležil v zadnjih 30 dneh"; }
  }
  if (prev) {
    counters.updated++;
    if (prev.price && p.price < prev.price && p.availability === "in_stock") { counters.priceDrops++; news.drops.push(o); }
    if (p.availability === "out_of_stock" && prev.availability !== "out_of_stock") counters.outOfStock++;
  } else counters.added++;
  offers.set(id, o);
  if (src) src.status = src.status === "candidate" || src.status === "discovered" || src.status === "blocked" ? "readable" : src.status;
  stat(host).products++;
  return { o, isNew: !prev };
}

function describe(p) {
  const bits = [`Stran prikazuje ceno ${p.price.toFixed(2).replace(".", ",")} EUR`];
  if (p.referencePrice) bits.push(`${p.referenceLabel === "Najnižja cena v zadnjih 30 dneh pred znižanjem" ? "najnižjo ceno v zadnjih 30 dneh" : "prejšnjo ceno"} ${p.referencePrice.toFixed(2).replace(".", ",")} EUR`);
  bits.push(p.availability === "in_stock" ? "izdelek je na zalogi" : p.availability === "out_of_stock" ? "izdelek ni na zalogi" : "zaloga ni navedena");
  if (p.shipping != null) bits.push(p.shipping === 0 ? "brezplačna dostava" : `dostava ${p.shipping.toFixed(2).replace(".", ",")} EUR`);
  return bits.join(", ") + ".";
}

const isDeal = (o) => o.availability === "in_stock" && o.referencePrice && o.referencePrice > o.price * (1 + MIN_DISCOUNT) && o.referenceLabel !== "Najvišja cena, ki jo je NBC zabeležil v zadnjih 30 dneh";
const pctOf = (o) => (o.referencePrice ? Math.round((1 - o.price / o.referencePrice) * 100) : 0);

async function readProduct(url) {
  const { html, finalUrl } = await page(url);
  const p = extractProduct(html, finalUrl);
  if (p) p.url = canonicalUrl(finalUrl) || p.url;
  return p;
}

/* 1. Target prices and tracked links */
const targetOffers = targets.map((t) => ({ t, o: offers.get(t.offerId || t.id) })).filter((x) => x.o);
await pool(targetOffers, 4, async ({ t, o }) => {
  try {
    const p = await readProduct(o.url);
    counters.rechecked++;
    if (!p) return;
    const { o: cur } = upsert(p);
    if (cur.availability === "in_stock" && cur.price <= t.target && !t.hitAt) {
      counters.targetHits++;
      news.hits.push({ o: cur, target: t.target });
      radarUpdates.targets.push({ id: t.id, hitAt: nowIso(), hitPrice: cur.price });
    } else if (cur.price > t.target && t.hitAt) radarUpdates.targets.push({ id: t.id, hitAt: null, hitPrice: null });
  } catch (e) { if (e.gone) o.availability = "out_of_stock"; }
});
await pool(tracked, 4, async (t) => {
  try {
    const p = await readProduct(t.url);
    if (!p) { radarUpdates.tracked.push({ id: t.id, lastCheckedAt: nowIso(), lastError: "cene ni bilo mogoče prebrati" }); return; }
    const { o } = upsert(p);
    const before = t.lastPrice;
    radarUpdates.tracked.push({ id: t.id, lastCheckedAt: nowIso(), lastPrice: o.price, offerId: o.id, name: o.name, store: o.store, lastError: null });
    const hitTarget = t.target != null && o.price <= t.target && (before == null || before > t.target);
    const dropped = before != null && o.price < before;
    if (o.availability === "in_stock" && (hitTarget || dropped)) news.hits.push({ o, target: t.target ?? before, tracked: true });
  } catch (e) { radarUpdates.tracked.push({ id: t.id, lastCheckedAt: nowIso(), lastError: e.robots ? "trgovina branja ne dovoli" : e.blocked ? "trgovina je zavrnila dostop" : "stran ni dosegljiva" }); }
});
log("ciljne cene in spremljani izdelki: " + (targetOffers.length + tracked.length));

/* 2. Wishes, through the shops' own search */
const searchShops = activeSources().filter((s) => s.search && s.status !== "blocked");
const wishes = [...watch].sort((a, b) => String(a.lastMatchAt || "").localeCompare(String(b.lastMatchAt || ""))).slice(0, 10);
for (const w of wishes) {
  const found = [];
  const shops = [...searchShops].sort(() => Math.random() - 0.5).slice(0, LIMITS.wishShops);
  await pool(shops, 3, async (shop) => {
    if (found.length >= LIMITS.wishMatches * 2) return;
    try {
      const res = await page(shop.search.replace("{q}", encodeURIComponent(w.term)));
      const links = extractLinks(res.html, res.finalUrl, LIMITS.wishLinks);
      for (const link of links) {
        try {
          const p = await readProduct(link);
          if (!p || !matchesQuery(p, w.term)) continue;
          if (w.maxPrice != null && p.price > w.maxPrice) continue;
          if (w.category && p.category && p.category !== w.category) continue;
          const { o } = upsert(p);
          if (isDeal(o)) found.push(o);
        } catch {}
      }
    } catch {}
  });
  found.sort((a, b) => a.price - b.price);
  const best = found.slice(0, LIMITS.wishMatches);
  for (const o of best) { o.watchMatch = w.id; offers.set(o.id, o); }
  if (best.length) {
    counters.watchMatches += best.length;
    news.matches.push({ term: w.term, o: best[0], n: best.length });
    radarUpdates.watch.push({ id: w.id, lastMatchAt: nowIso(), lastMatchOfferId: best[0].id });
  }
  log(`želja »${w.term}«: ${best.length} ujemanj`);
}

/* 3. Recheck the oldest offers */
const old = [...offers.values()].filter((o) => inScope(o) && !targets.some((t) => (t.offerId || t.id) === o.id))
  .sort((a, b) => String(a.checkedAt).localeCompare(String(b.checkedAt))).slice(0, LIMITS.recheck);
await pool(old, 5, async (o) => {
  try {
    const p = await readProduct(o.url);
    counters.rechecked++;
    if (p) upsert(p);
  } catch (e) {
    if (e.gone) { o.availability = "out_of_stock"; counters.outOfStock++; }
    // On any other failure the old price and time stay as they were.
  }
});
log(`ponovno preverjenih: ${counters.rechecked}`);

/* 4. Discover new deals on the shops' sale pages */
const lastCrawl = (s) => String(s.lastCheckedAt || "");
const dealShops = activeSources().filter((s) => (s.deals || []).length && s.status !== "blocked")
  .sort((a, b) => lastCrawl(a).localeCompare(lastCrawl(b))).slice(0, LIMITS.dealShops);
let discovered = 0;
await pool(dealShops, 3, async (shop) => {
  shop.lastCheckedAt = nowIso();
  for (const dealUrl of shop.deals.slice(0, 2)) {
    if (discovered >= LIMITS.newOffers) return;
    try {
      const res = await page(dealUrl);
      const links = extractLinks(res.html, res.finalUrl, LIMITS.dealLinks).filter((l) => !offers.has(offerId(canonicalUrl(l))));
      for (const link of links) {
        if (discovered >= LIMITS.newOffers) break;
        try {
          const p = await readProduct(link);
          if (!p || !(p.availability === "in_stock" && p.referencePrice && p.referencePrice > p.price * (1 + MIN_DISCOUNT))) continue;
          const { o, isNew } = upsert(p);
          if (isNew) { discovered++; news.fresh.push(o); }
        } catch {}
      }
    } catch {}
  }
});
log(`novih popustov: ${discovered}`);

/* 5. Source health */
const blockedNames = [];
for (const [host, s] of stats) {
  const src = storeOf(host);
  if (!src) continue;
  src.lastCheckedAt = nowIso();
  if (s.products) { src.status = "readable"; src.note = null; }
  else if (s.blocked && !s.products) { src.status = "blocked"; src.note = "Trgovina je zavrnila samodejno branje (" + s.lastError + ")."; blockedNames.push(src.name); }
  else if (s.robots && !s.products) { src.note = "Pravila trgovine (robots.txt) ne dovolijo branja teh strani."; }
}

/* 6. Prune and save */
const keepIds = new Set([...targets.map((t) => t.offerId || t.id), ...watch.map((w) => w.lastMatchOfferId).filter(Boolean), ...tracked.map((t) => t.offerId).filter(Boolean)]);
const cutoff = Date.now() - LIMITS.keepDays * 864e5;
let list = [...offers.values()].filter((o) => keepIds.has(o.id) || Date.parse(o.checkedAt) >= cutoff);
list.sort((a, b) => String(b.checkedAt).localeCompare(String(a.checkedAt)));
list = list.slice(0, LIMITS.maxOffers);

const deals = list.filter(isDeal);
const top = [...news.fresh, ...news.drops].filter(isDeal).sort((a, b) => pctOf(b) - pctOf(a)).slice(0, 5);
const summaryParts = [];
if (news.hits.length) summaryParts.push(`Doseženih ciljnih cen: ${news.hits.length}.`);
if (news.matches.length) summaryParts.push(`Ujemanja z željami: ${news.matches.map((m) => "»" + m.term + "«").join(", ")}.`);
const pl = (n, f) => { const m = Math.abs(n) % 100; return `${n} ${f[m === 1 ? 0 : m === 2 ? 1 : m === 3 || m === 4 ? 2 : 3]}`; };
summaryParts.push(`${pl(counters.added, ["nova ponudba", "novi ponudbi", "nove ponudbe", "novih ponudb"])}, ${pl(counters.rechecked, ["preverjena", "preverjeni", "preverjene", "preverjenih"])}, ${pl(counters.priceDrops, ["pocenitev", "pocenitvi", "pocenitve", "pocenitev"])}. Svežih popustov skupaj: ${deals.length}.`);
if (blockedNames.length) summaryParts.push(`Omejen dostop: ${blockedNames.join(", ")}.`);
Object.assign(run, {
  status: "done", finishedAt: nowIso(), ...counters, newSources: 0, blockedSources: blockedNames,
  top: top.map((o) => o.id), summary: summaryParts.join(" ").slice(0, 400),
  shops: [...stats].map(([host, s]) => ({ host, ...s })),
});

if (DRY) {
  log("POSKUS: zapis preskočen.", JSON.stringify({ run, offers: list.length }, null, 1));
} else {
  await api("/api/catalog", { method: "PUT", body: { offers: list, sources: [...sources.values()], run } });
  if (radarUpdates.watch.length + radarUpdates.targets.length + radarUpdates.tracked.length) await api("/api/radar/state", { method: "PUT", body: radarUpdates });
  log(`shranjeno: ${list.length} ponudb`);
}

/* 7. Push notifications: only when there is something worth a buzz */
const money = (n) => n.toFixed(2).replace(".", ",") + " €";
let note = null;
if (news.hits.length) {
  const h = news.hits[0];
  note = { title: `Cena je padla: ${h.o.name}`.slice(0, 80), body: `Zdaj ${money(h.o.price)} pri ${h.o.store}${h.target ? ` (cilj ${money(h.target)})` : ""}.` + (news.hits.length > 1 ? ` In še ${news.hits.length - 1}.` : ""), tag: "nbc-hit" };
} else if (news.matches.length) {
  const m = news.matches[0];
  note = { title: `Najdeno za »${m.term}«`.slice(0, 80), body: `${m.o.name}: ${money(m.o.price)} (−${pctOf(m.o)} %) pri ${m.o.store}.`, tag: "nbc-wish" };
} else if (top.length && pctOf(top[0]) >= 20) {
  note = { title: `${top.length} ${top.length === 1 ? "nov popust" : top.length === 2 ? "nova popusta" : top.length <= 4 ? "novi popusti" : "novih popustov"}`, body: top.slice(0, 3).map((o) => `${o.name.slice(0, 40)} ${money(o.price)} (−${pctOf(o)} %)`).join(" · "), tag: "nbc-deals" };
}
if (note && !DRY) {
  const { subs, vapid } = await api("/api/push/all");
  if (subs.length) {
    webpush.setVapidDetails(BASE.startsWith("https://") ? BASE : "mailto:nbc@example.invalid", vapid.publicKey, vapid.privateKey);
    const gone = [];
    await pool(subs, 5, async (sub) => {
      try { await webpush.sendNotification(sub, JSON.stringify({ ...note, url: "/#ponudbe" }), { TTL: 6 * 3600, urgency: news.hits.length ? "high" : "normal" }); }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) gone.push(sub.endpoint); else log("push:", e.statusCode || e.message); }
    });
    if (gone.length) await api("/api/push/prune", { method: "POST", body: { endpoints: gone } });
    log(`obvestila poslana na ${subs.length - gone.length} naprav`);
  }
}
log("konec. " + run.summary);

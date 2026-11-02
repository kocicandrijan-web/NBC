// NBC web app. Data comes from the NBC server (/api); live searches read shop pages in the browser.
import { extractProduct, extractLinks, matchesQuery, CATEGORIES, hostOf, offerId } from "/lib/extract.js";

const TZ = "Europe/Ljubljana";
const FRESH_MS = 72 * 3600e3;
const NEW_MS = 24 * 3600e3;
const SLOTS = [[7, 41], [10, 41], [13, 41], [16, 41], [19, 41], [22, 41]];
const VIEWS = ["ponudbe", "radar", "viri"];
const SRC = { readable: ["Berljiv", "good", "Berljivi"], blocked: ["Omejen dostop", "bad", "Omejen dostop"], discovered: ["Najden", "mute", "Najdeni"], candidate: ["Kandidat", "warn", "Kandidati"] };
const F = {
  offer: ["ponudba", "ponudbi", "ponudbe", "ponudb"],
  newSource: ["nov vir", "nova vira", "novi viri", "novih virov"],
  wish: ["želja", "želji", "želje", "želj"],
  target: ["ciljna cena", "ciljni ceni", "ciljne cene", "ciljnih cen"],
  tracked: ["izdelek", "izdelka", "izdelki", "izdelkov"],
  added: ["nova", "novi", "nove", "novih"],
  checked: ["preverjena", "preverjeni", "preverjene", "preverjenih"],
  drop: ["pocenitev", "pocenitvi", "pocenitve", "pocenitev"],
};

const $ = (s) => document.querySelector(s);
const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const ms = (iso) => { const v = Date.parse(iso); return Number.isFinite(v) ? v : NaN; };
const eurFmt = new Intl.NumberFormat("sl-SI", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => eurFmt.format(n);
const pad2 = (n) => String(n).padStart(2, "0");
const pl = (n, f) => { const m = Math.abs(n) % 100; return f[m === 1 ? 0 : m === 2 ? 1 : m === 3 || m === 4 ? 2 : 3]; };
const nOf = (n, f) => n + " " + pl(n, f);
const safeHref = (u) => { try { const x = new URL(u); return x.protocol === "https:" ? x.href : null; } catch { return null; } };
let regionNames = null;
try { regionNames = new Intl.DisplayNames(["sl"], { type: "region" }); } catch {}
const countryName = (c) => { if (!c) return ""; try { return (regionNames && regionNames.of(c)) || c; } catch { return c; } };
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hmFmt = new Intl.DateTimeFormat("sl-SI", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dmFmt = new Intl.DateTimeFormat("sl-SI", { timeZone: TZ, day: "numeric", month: "numeric" });
function when(iso) {
  const v = ms(iso);
  if (!Number.isFinite(v)) return "—";
  const now = Date.now(), k = dayFmt.format(v);
  const day = k === dayFmt.format(now) ? "danes" : k === dayFmt.format(now - 864e5) ? "včeraj" : dmFmt.format(v);
  return day + " ob " + hmFmt.format(v);
}
function nextRun() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const cur = get("hour") * 60 + get("minute");
  const next = SLOTS.find(([h, m]) => h * 60 + m > cur);
  const [h, m] = next || SLOTS[0];
  return (next ? "danes" : "jutri") + " okoli " + pad2(h) + ":" + pad2(m);
}
const parseEur = (s) => {
  const t = String(s || "").trim().replace(/[\s€]/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n < 1e7 ? n : null;
};

/* ---------------- state ---------------- */
const S = {
  key: null, loaded: false, error: null,
  offers: [], sources: [], runs: [], watch: [], targets: new Map(), tracked: [],
  view: "ponudbe", cat: "", q: "", store: "", country: "", sort: "rec", onlySaved: false, srcQ: "",
  saved: new Set(), live: null, installEvent: null, pushOn: false,
  pushSupported: "serviceWorker" in navigator && "PushManager" in window,
};
try { S.key = localStorage.getItem("nbc-key") || null; } catch {}
try { const a = JSON.parse(localStorage.getItem("nbc-saved") || "[]"); if (Array.isArray(a)) S.saved = new Set(a.filter((x) => typeof x === "string")); } catch {}
const persistSaved = () => { try { localStorage.setItem("nbc-saved", JSON.stringify([...S.saved])); } catch {} };

/* ---------------- server ---------------- */
async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (S.key) headers.authorization = "Bearer " + S.key;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const err = new Error((data && data.error) || "Napaka strežnika (" + r.status + ")");
    err.status = r.status;
    throw err;
  }
  return data;
}

async function loadCatalog() {
  try {
    const d = await api("/api/catalog");
    S.offers = d.offers || [];
    S.sources = d.sources || [];
    S.runs = (d.runs || []).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    S.loaded = true;
    S.error = null;
  } catch (e) {
    S.error = navigator.onLine === false ? "Ni povezave. Prikazani so zadnji shranjeni podatki." : "Podatkov ni bilo mogoče naložiti. Poskusi znova čez nekaj minut.";
  }
  render();
}
async function loadRadar() {
  if (!S.key) { S.watch = []; S.targets = new Map(); S.tracked = []; render(); return; }
  try {
    const d = await api("/api/radar");
    S.watch = d.watch || [];
    S.targets = new Map((d.targets || []).map((t) => [t.id, t]));
    S.tracked = d.tracked || [];
  } catch (e) {
    if (e.status === 401) { setKey(null); toast("Ključ ni več veljaven. Prijavi se znova."); }
  }
  render();
}
function setKey(k) {
  S.key = k;
  try { if (k) localStorage.setItem("nbc-key", k); else localStorage.removeItem("nbc-key"); } catch {}
}

/* ---------------- offer helpers ---------------- */
const fresh = (o) => o.availability === "in_stock" && num(o.price) !== null && Date.now() - ms(o.checkedAt) < FRESH_MS;
const pct = (o) => { const p = num(o.price), r = num(o.referencePrice); return p !== null && r !== null && r > p ? Math.round((1 - p / r) * 100) : null; };
const lastDrop = (o) => {
  const h = Array.isArray(o.history) ? o.history : [];
  if (h.length < 2) return null;
  const a = num(h[h.length - 2]?.price), b = num(h[h.length - 1]?.price);
  return a !== null && b !== null && b < a ? a - b : null;
};
const isNew = (o) => Date.now() - ms(o.firstSeenAt) < NEW_MS;
const targetOf = (o) => { const t = S.targets.get(o.id); return t && num(t.target) !== null ? t : null; };
const isHit = (o) => { const t = targetOf(o); return !!t && fresh(o) && o.price <= t.target; };
const watchOf = (o) => (o.watchMatch ? S.watch.find((w) => w.id === o.watchMatch) || null : null);
const freshOffers = () => S.offers.filter(fresh);
const offerById = (id) => S.offers.find((o) => o.id === id) || null;

function shown() {
  const q = S.q.trim().toLowerCase();
  const list = freshOffers().filter((o) =>
    (!S.cat || o.category === S.cat) && (!S.store || o.store === S.store) && (!S.country || o.country === S.country) &&
    (!S.onlySaved || S.saved.has(o.id)) &&
    (!q || [o.name, o.brand, o.variant, o.store, o.category].join(" ").toLowerCase().includes(q)));
  const score = (o) => (isHit(o) ? 1000 : 0) + (watchOf(o) ? 500 : 0) + (isNew(o) ? 100 : 0) + (pct(o) || 0);
  const by = {
    rec: (a, b) => score(b) - score(a),
    disc: (a, b) => (pct(b) ?? -1) - (pct(a) ?? -1),
    price: (a, b) => a.price - b.price,
    new: (a, b) => (ms(b.firstSeenAt) || 0) - (ms(a.firstSeenAt) || 0),
  }[S.sort] || (() => 0);
  return list.sort((a, b) => by(a, b) || (ms(b.checkedAt) || 0) - (ms(a.checkedAt) || 0));
}

/* ---------------- rendering ---------------- */
let queued = false;
function render() { if (queued) return; queued = true; queueMicrotask(() => { queued = false; draw(); }); }
function draw() {
  for (const v of VIEWS) {
    const on = v === S.view;
    $("#view-" + v).hidden = !on;
    const t = $("#tab-" + v);
    if (on) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
  }
  $("#nOffers").textContent = S.loaded ? String(freshOffers().length) : "";
  const nr = S.watch.length + S.targets.size + S.tracked.length;
  $("#nRadar").textContent = nr ? String(nr) : "";
  $("#nSources").textContent = S.sources.length ? String(S.sources.length) : "";
  $("#banner").hidden = !S.error;
  $("#banner").textContent = S.error || "";
  $("#installBtn").hidden = !S.installEvent;
  if (S.view === "ponudbe") { drawStatus(); drawLive(); drawToolbar(); drawGrid(); }
  else if (S.view === "radar") drawRadar();
  else drawSources();
}

const kindLabel = (r) => (r.kind === "import" ? "Uvoz iz prejšnje različice" : r.kind === "manual" ? "Ročno iskanje" : "Samodejno iskanje");
const isRunning = (r) => r && r.status === "running" && Date.now() - ms(r.startedAt) < 2 * 3600e3;

function drawStatus() {
  const r = S.runs[0] || null, running = isRunning(r), nf = freshOffers().length;
  let head, sub = "";
  if (!r) {
    if (!S.loaded) head = "Nalagam …";
    else { head = "Še ni iskanj"; sub = "Prvo samodejno iskanje bo " + nextRun() + "."; }
  } else if (running) { head = "Iskanje poteka"; sub = "Začeto " + when(r.startedAt) + "."; }
  else { head = when(r.finishedAt || r.startedAt); sub = kindLabel(r) + (r.status === "running" ? " · ni bilo dokončano" : ""); }
  const done = r && !running;
  const stat = (label, v) => `<div><dt>${label}</dt><dd>${v}</dd></div>`;
  $("#status").innerHTML =
    `<p class="k">${running ? "Zdaj" : "Zadnje iskanje"}</p><p class="when">${esc(head)}</p>` +
    (sub ? `<p class="kind">${esc(sub)}</p>` : "") +
    `<dl class="stats">${stat("Na voljo", nf)}${stat("Novih", done ? (num(r.added) ?? 0) : "–")}${stat("Pocenitev", done ? (num(r.priceDrops) ?? 0) : "–")}</dl>` +
    (done && r.summary ? `<p class="sum">${esc(r.summary)}</p>` : "") +
    `<p class="next"><span class="pulse" aria-hidden="true"></span><span>Naslednje iskanje <b>${esc(nextRun())}</b></span></p>`;
}

let chipSig = "", optSig = "";
function drawToolbar() {
  const all = freshOffers();
  const counts = new Map();
  for (const o of all) counts.set(o.category || "Ostalo", (counts.get(o.category || "Ostalo") || 0) + 1);
  const cats = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "sl"));
  if (S.cat && !counts.has(S.cat)) S.cat = "";
  const nSaved = all.filter((o) => S.saved.has(o.id)).length;
  if (!nSaved) S.onlySaved = false;
  const sig = JSON.stringify([cats, all.length, nSaved]);
  if (sig !== chipSig) {
    chipSig = sig;
    $("#chips").innerHTML =
      `<button type="button" class="chip" data-act="cat" data-cat="">Vse <span class="c">${all.length}</span></button>` +
      cats.map(([c, n]) => `<button type="button" class="chip" data-act="cat" data-cat="${esc(c)}">${esc(c)} <span class="c">${n}</span></button>`).join("") +
      (nSaved ? `<button type="button" class="chip" data-act="saved-only">♥ Shranjeno <span class="c">${nSaved}</span></button>` : "");
  }
  for (const b of document.querySelectorAll("#chips .chip")) {
    b.setAttribute("aria-pressed", String(b.dataset.act === "saved-only" ? S.onlySaved : b.dataset.cat === S.cat));
  }
  const stores = [...new Set(all.map((o) => o.store).filter(Boolean))].sort((a, b) => a.localeCompare(b, "sl"));
  const countries = [...new Set(all.map((o) => o.country).filter(Boolean))].sort();
  if (S.store && !stores.includes(S.store)) S.store = "";
  if (S.country && !countries.includes(S.country)) S.country = "";
  const os = JSON.stringify([stores, countries]);
  if (os !== optSig) {
    optSig = os;
    $("#fStore").innerHTML = `<option value="">Vse</option>` + stores.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    $("#fCountry").innerHTML = `<option value="">Vse</option>` + countries.map((c) => `<option value="${esc(c)}">${esc(countryName(c))}</option>`).join("");
  }
  $("#fStore").value = S.store;
  $("#fCountry").value = S.country;
  $("#fSort").value = S.sort;
}

const emptyHTML = (title, text, extra = "") => `<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${extra}</div>`;
const skeletons = (n = 4) => Array.from({ length: n }, () => `<div class="skel" aria-hidden="true"></div>`).join("");

function drawGrid() {
  const g = $("#grid"), all = freshOffers(), list = shown();
  const staleN = S.offers.filter((o) => o.availability === "in_stock" && !fresh(o)).length;
  let count = "";
  if (S.loaded) {
    count = list.length === all.length ? nOf(all.length, F.offer) : "Prikazano " + list.length + " od " + all.length;
    if (staleN) count += " · starejših od 72 ur: " + staleN;
  }
  $("#count").textContent = count;
  if (!S.loaded) { g.innerHTML = S.error ? emptyHTML("Ponudb ni bilo mogoče naložiti", S.error) : skeletons(); return; }
  if (!all.length) { g.innerHTML = emptyHTML("Še ni svežih ponudb", "Naslednje iskanje bo " + nextRun() + ". Medtem lahko zgoraj vpišeš, kaj iščeš, in NBC takoj preveri trgovine."); return; }
  if (!list.length) { g.innerHTML = emptyHTML("Za ta izbor ni ponudb", "Spremeni iskalni niz ali filtre. Za iskanje po trgovinah pritisni »Išči«.", `<button type="button" class="btn ghost" data-act="clear">Počisti filtre</button>`); return; }
  g.innerHTML = list.map((o) => cardHTML(o)).join("");
}

function shippingText(o) {
  const ship = num(o.shipping);
  const cs = Array.isArray(o.shippingCountries) && o.shippingCountries.length ? o.shippingCountries.join(", ") : "";
  return (ship === null ? "ni znana" : ship === 0 ? "brezplačna" : money(ship)) + (cs ? " · " + cs : "");
}

function cardHTML(o, live = false) {
  const p = pct(o), drop = live ? null : lastDrop(o), tg = live ? null : targetOf(o), hit = live ? false : isHit(o), wm = live ? null : watchOf(o);
  const saved = S.saved.has(o.id), href = safeHref(o.url), ship = num(o.shipping);
  const flags = [
    hit ? `<span class="flag hit">Cilj dosežen</span>` : "",
    wm ? `<span class="flag">Tvoja želja</span>` : "",
    drop ? `<span class="flag drop">↓ ${money(drop)}</span>` : "",
    !live && isNew(o) ? `<span class="flag">Novo</span>` : "",
    live && o.availability === "out_of_stock" ? `<span class="flag drop">Ni na zalogi</span>` : "",
  ].join("");
  const actions = live
    ? `<button type="button" class="btn ghost" data-act="track-live" data-url="${esc(o.url)}" data-name="${esc(o.name)}" data-store="${esc(o.store)}">Spremljaj ceno</button>`
    : `<button type="button" class="btn ghost" data-act="open" data-id="${esc(o.id)}">Podrobnosti</button>`;
  return `<article class="card${hit ? " is-hit" : ""}${live ? " live-card" : ""}">
    <div class="card-top">${p !== null ? `<span class="pct">−${p} %</span>` : `<span class="pct none">${live ? "Brez potrjenega popusta" : "Popust ni potrjen"}</span>`}<div class="flags">${flags}</div>
      ${live ? "" : `<button type="button" class="heart" data-act="save" data-id="${esc(o.id)}" aria-pressed="${saved}" aria-label="${saved ? "Odstrani iz shranjenih" : "Shrani"}: ${esc(o.name)}">${saved ? "♥" : "♡"}</button>`}</div>
    <div class="card-body">
      <p class="brand">${esc(o.brand || o.store)}${o.category ? " · " + esc(o.category) : ""}</p>
      <h3>${esc(o.name)}</h3>
      ${o.variant ? `<p class="variant">${esc(o.variant)}</p>` : ""}
      <div class="price-row"><strong class="price">${money(o.price)}</strong>${p !== null ? `<del>${money(o.referencePrice)}</del>` : ""}</div>
      ${p !== null ? `<p class="ref">${esc(o.referenceLabel || "Referenčna cena trgovca")}</p>` : ""}
      <dl class="meta">
        <div><dt>Trgovina</dt><dd>${esc(o.store)}${o.country ? " · " + esc(o.country) : ""}</dd></div>
        <div><dt>Dostava</dt><dd>${esc(shippingText(o))}</dd></div>
        ${ship !== null ? `<div><dt>Skupaj</dt><dd><b>${money(o.price + ship)}</b></dd></div>` : ""}
        ${tg ? `<div><dt>Tvoj cilj</dt><dd>${money(tg.target)}</dd></div>` : ""}
        <div><dt>Prebrano</dt><dd class="mono">${esc(live ? "pravkar" : when(o.checkedAt))}</dd></div>
      </dl>
      <div class="actions">${actions}${href ? `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Pri trgovcu ↗</a>` : ""}</div>
    </div>
  </article>`;
}

/* ---------------- live search ---------------- */
async function shopPage(url, signal) {
  const r = await fetch("/api/fetch?url=" + encodeURIComponent(url), { headers: { "x-nbc": "1" }, signal });
  if (!r.ok) {
    let d = null;
    try { d = await r.json(); } catch {}
    const e = new Error((d && d.error) || "Napaka " + r.status);
    e.status = r.status;
    throw e;
  }
  return { html: await r.text(), finalUrl: r.headers.get("x-final-url") || url };
}
async function pool(items, size, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => { while (queue.length) await fn(queue.shift()); });
  await Promise.all(workers);
}

async function liveSearch(query) {
  if (S.live && S.live.ctrl) S.live.ctrl.abort();
  const shops = S.sources.filter((s) => s.search && s.status !== "blocked");
  const ctrl = new AbortController();
  S.live = { query, ctrl, results: [], shops: Object.fromEntries(shops.map((s) => [s.id, { name: s.name, state: "wait", n: 0 }])), done: false };
  render();
  $("#live").scrollIntoView({ behavior: "smooth", block: "start" });
  const seen = new Set();
  await pool(shops, 4, async (shop) => {
    const st = S.live.shops[shop.id];
    if (ctrl.signal.aborted) return;
    st.state = "busy"; render();
    try {
      const page = await shopPage(shop.search.replace("{q}", encodeURIComponent(query)), ctrl.signal);
      const links = extractLinks(page.html, page.finalUrl, 6);
      await pool(links, 3, async (link) => {
        if (ctrl.signal.aborted) return;
        try {
          const pp = await shopPage(link, ctrl.signal);
          const p = extractProduct(pp.html, pp.finalUrl);
          if (!p || !matchesQuery(p, query) || seen.has(p.url)) return;
          seen.add(p.url);
          S.live.results.push({ ...p, id: offerId(p.url), store: shop.name, country: shop.country, category: p.category || null });
          st.n++;
          render();
        } catch {}
      });
      st.state = st.n ? "ok" : "none";
    } catch (e) {
      st.state = "err";
      st.error = e.status === 451 ? "branje ni dovoljeno" : e.status === 502 || e.status === 403 ? "zavrnjeno" : "ni odziva";
    }
    render();
  });
  if (S.live && S.live.ctrl === ctrl) { S.live.done = true; render(); }
}

function drawLive() {
  const L = S.live;
  $("#live").hidden = !L;
  if (!L) return;
  $("#h-live").textContent = (L.done ? "Rezultati za »" : "Iščem »") + L.query + "«";
  $("#saveWishBtn").hidden = !S.key;
  $("#liveShops").innerHTML = Object.values(L.shops).map((s) => {
    const cls = s.state === "busy" ? "busy" : s.state === "ok" ? "ok" : s.state === "err" ? "err" : "";
    const txt = s.state === "ok" ? `${s.n}` : s.state === "none" ? "0" : s.state === "err" ? s.error : s.state === "busy" ? "…" : "";
    return `<span class="shop ${cls}">${esc(s.name)}${txt ? " · " + esc(txt) : ""}</span>`;
  }).join("") || `<span class="shop err">Ni trgovin z iskalnikom. Dodaj jih na seznam virov.</span>`;
  const sorted = [...L.results].sort((a, b) => (pct(b) ?? -1) - (pct(a) ?? -1) || a.price - b.price);
  $("#liveGrid").innerHTML = sorted.length ? sorted.map((o) => cardHTML(o, true)).join("")
    : L.done ? emptyHTML("Ni zadetkov", "Trgovine na seznamu za ta izraz niso vrnile izdelkov s ceno. Poskusi z drugačnim opisom ali shrani željo, da NBC išče še naprej.")
    : skeletons(3);
}

/* ---------------- radar ---------------- */
function drawRadar() {
  const authed = !!S.key;
  $("#loginPanel").hidden = authed;
  $("#radarBody").hidden = !authed;
  if (!authed) return;
  const wl = [...S.watch].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  $("#watchCount").hidden = !wl.length;
  $("#watchCount").textContent = nOf(wl.length, F.wish);
  $("#watchList").innerHTML = !wl.length
    ? `<li class="none">Še nimaš želja. NBC jih ob vsakem iskanju preveri najprej in te obvesti, ko najde popust.</li>`
    : wl.map((w) => {
        const off = w.lastMatchOfferId ? offerById(w.lastMatchOfferId) : null;
        const meta = [num(w.maxPrice) !== null ? "do " + money(w.maxPrice) : "", w.category || "", w.lastMatchAt ? "zadnje ujemanje " + when(w.lastMatchAt) : "še brez ujemanja"].filter(Boolean);
        return `<li><div class="li-main"><span class="li-title">${esc(w.term)}</span><span class="li-meta">${esc(meta.join(" · "))}</span>${off && fresh(off) ? `<button type="button" class="linkish" data-act="open" data-id="${esc(off.id)}">${esc(off.name)} · ${money(off.price)}</button>` : ""}</div><button type="button" class="x" data-act="search-term" data-term="${esc(w.term)}">Išči zdaj</button><button type="button" class="x" data-act="del-watch" data-id="${esc(w.id)}" aria-label="Odstrani željo ${esc(w.term)}">Odstrani</button></li>`;
      }).join("");

  $("#trackedCount").hidden = !S.tracked.length;
  $("#trackedCount").textContent = nOf(S.tracked.length, F.tracked);
  $("#trackedList").innerHTML = !S.tracked.length
    ? `<li class="none">Prilepi povezavo do izdelka v katerikoli trgovini. NBC bo spremljal ceno in te obvestil, ko pade.</li>`
    : S.tracked.map((t) => {
        const label = t.name || hostOf(t.url);
        const meta = [t.store || hostOf(t.url), num(t.lastPrice) !== null ? "zdaj " + money(t.lastPrice) : "cena še ni prebrana", num(t.target) !== null ? "cilj " + money(t.target) : "", t.lastError || ""].filter(Boolean);
        const href = safeHref(t.url);
        return `<li><div class="li-main">${href ? `<a class="li-title" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>` : `<span class="li-title">${esc(label)}</span>`}<span class="li-meta">${esc(meta.join(" · "))}</span></div><button type="button" class="x" data-act="del-tracked" data-id="${esc(t.id)}" aria-label="Nehaj spremljati ${esc(label)}">Odstrani</button></li>`;
      }).join("");

  const tl = [...S.targets.values()].filter((t) => num(t.target) !== null);
  $("#targetCount").hidden = !tl.length;
  $("#targetCount").textContent = nOf(tl.length, F.target);
  $("#targetList").innerHTML = !tl.length
    ? `<li class="none">Še ni ciljnih cen.</li>`
    : tl.map((t) => {
        const o = offerById(t.offerId || t.id);
        const cur = o && fresh(o) ? o.price : null;
        const pill = cur === null ? `<span class="pill mute">Ni sveže cene</span>` : cur <= t.target ? `<span class="pill good">Dosežena</span>` : `<span class="pill warn">še ${money(cur - t.target)}</span>`;
        const name = (o && o.name) || t.name || "Izdelek";
        return `<li><div class="li-main">${o ? `<button type="button" class="linkish li-title" data-act="open" data-id="${esc(o.id)}">${esc(name)}</button>` : `<span class="li-title">${esc(name)}</span>`}<span class="li-meta">${esc([(o && o.store) || t.store, "cilj " + money(t.target), cur !== null ? "zdaj " + money(cur) : ""].filter(Boolean).join(" · "))}</span></div>${pill}<button type="button" class="x" data-act="del-target" data-id="${esc(t.id)}" aria-label="Odstrani ciljno ceno za ${esc(name)}">Odstrani</button></li>`;
      }).join("");

  drawPush();
  $("#nextLine").textContent = "Naslednje: " + nextRun();
  $("#runList").innerHTML = !S.runs.length
    ? `<li class="none">Še ni iskanj. Prvo bo ${esc(nextRun())}.</li>`
    : S.runs.slice(0, 20).map((r) => {
        const running = isRunning(r);
        const parts = running ? ["poteka …"] : [nOf(num(r.added) ?? 0, F.added), nOf(num(r.rechecked) ?? 0, F.checked), nOf(num(r.priceDrops) ?? 0, F.drop)];
        if (num(r.targetHits)) parts.push("dosežene ciljne cene: " + r.targetHits);
        if (num(r.watchMatches)) parts.push("ujemanja z željami: " + r.watchMatches);
        if (num(r.newSources)) parts.push(nOf(r.newSources, F.newSource));
        const blocked = Array.isArray(r.blockedSources) ? r.blockedSources.filter((x) => typeof x === "string").join(", ") : "";
        return `<li><span class="run-when mono">${esc(when(r.finishedAt || r.startedAt))}</span><div class="li-main"><span class="li-title">${esc(kindLabel(r))}${r.status === "running" && !running ? " · ni bilo dokončano" : ""}</span><span class="li-meta">${esc(parts.join(" · "))}</span>${r.summary ? `<p class="run-sum">${esc(r.summary)}</p>` : ""}${blocked ? `<span class="li-meta">Omejen dostop: ${esc(blocked)}</span>` : ""}</div></li>`;
      }).join("");
}

function drawSources() {
  const q = S.srcQ.trim().toLowerCase();
  const perHost = new Map();
  for (const o of freshOffers()) { const h = o.sourceHost || hostOf(o.url); perHost.set(h, (perHost.get(h) || 0) + 1); }
  const key = (s) => s.id || hostOf(s.url);
  const st = { readable: 0, blocked: 0, discovered: 0, candidate: 0 };
  for (const s of S.sources) if (s.status in st) st[s.status]++;
  $("#srcLegend").innerHTML = S.sources.length ? Object.entries(SRC).map(([k, v]) => `<span class="pill ${v[1]}">${v[2]}: ${st[k]}</span>`).join("") : "";
  const rank = { readable: 0, candidate: 1, discovered: 2, blocked: 3 };
  const list = S.sources
    .filter((s) => !q || [s.name, s.category, s.country, countryName(s.country), s.url].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (perHost.get(key(b)) || 0) - (perHost.get(key(a)) || 0) || (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || String(a.name).localeCompare(String(b.name), "sl"));
  const grid = $("#srcGrid");
  if (!S.sources.length) { grid.innerHTML = S.loaded ? emptyHTML("Imenik virov je prazen", "Viri se dodajo ob naslednjem iskanju.") : skeletons(3); return; }
  grid.innerHTML = !list.length ? `<p class="none">Noben vir ne ustreza iskanju.</p>` : list.map((s) => {
    const n = perHost.get(key(s)) || 0, href = safeHref(s.url), lab = SRC[s.status] || [String(s.status || "neznano"), "mute"];
    return `<article class="src">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(s.name)} ↗</a>` : `<b>${esc(s.name)}</b>`}<span class="li-meta">${esc(s.category)} · ${esc(countryName(s.country))}</span><div class="src-foot"><span class="pill ${lab[1]}">${esc(lab[0])}</span>${s.search ? `<span class="pill mute">Iskalnik</span>` : ""}${n ? `<span class="pill good">${nOf(n, F.offer)}</span>` : ""}</div>${s.note ? `<span class="li-meta">${esc(s.note)}</span>` : ""}</article>`;
  }).join("");
}

/* ---------------- detail dialog ---------------- */
function sparkHTML(h) {
  const W = 520, H = 96, P = 10, ps = h.map((x) => x.price), lo = Math.min(...ps), hi = Math.max(...ps);
  const x = (i) => P + (i * (W - 2 * P)) / (h.length - 1);
  const y = (v) => (hi === lo ? H / 2 : H - P - ((v - lo) / (hi - lo)) * (H - 2 * P));
  const pts = h.map((p, i) => x(i).toFixed(1) + "," + y(p.price).toFixed(1)).join(" ");
  const last = h[h.length - 1];
  return `<figure class="spark"><figcaption class="k">Zgodovina cene · ${h.length} meritev</figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cena med ${money(lo)} in ${money(hi)}">
      <line x1="${P}" x2="${W - P}" y1="${y(lo).toFixed(1)}" y2="${y(lo).toFixed(1)}" stroke="var(--line)" stroke-dasharray="4 4"/>
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(h.length - 1).toFixed(1)}" cy="${y(last.price).toFixed(1)}" r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>
    </svg>
    <div class="spark-legend"><span>najnižja ${money(lo)}</span><span>${esc(when(h[0].at))} – ${esc(when(last.at))}</span><span>najvišja ${money(hi)}</span></div></figure>`;
}

function openOffer(id) {
  const o = offerById(id);
  if (!o) { toast("Ta ponudba ni več na voljo."); return; }
  const p = pct(o), tg = targetOf(o), wm = watchOf(o), href = safeHref(o.url), ship = num(o.shipping);
  const hist = (Array.isArray(o.history) ? o.history : []).filter((h) => h && num(h.price) !== null && Number.isFinite(ms(h.at)));
  const avail = { in_stock: "Na zalogi", out_of_stock: "Ni na zalogi", unknown: "Ni znana" }[o.availability] || "Ni znana";
  const row = (k, v) => (v ? `<div><dt>${k}</dt><dd>${v}</dd></div>` : "");
  const canEdit = !!S.key;
  const suggest = tg ? tg.target : Math.max(0.01, o.price >= 2 ? Math.floor(o.price * 0.9) : Math.round(o.price * 90) / 100);
  const m = $("#modal");
  m.innerHTML = `<div class="m">
    <div class="m-head"><div><p class="brand">${esc(o.brand || o.store)}${o.category ? " · " + esc(o.category) : ""}</p><h2 id="mTitle">${esc(o.name)}</h2>${o.variant ? `<p class="variant">${esc(o.variant)}</p>` : ""}</div>
      <button type="button" class="close" data-close aria-label="Zapri">×</button></div>
    <div class="price-row"><strong class="price">${money(o.price)}</strong>${p !== null ? `<del>${money(o.referencePrice)}</del><span class="pct sm">−${p} %</span>` : `<span class="pct none">Popust ni potrjen</span>`}</div>
    ${p !== null ? `<p class="ref">${esc(o.referenceLabel || "Referenčna cena trgovca")}</p>` : ""}
    ${o.evidence ? `<div class="evidence"><p class="k">Na strani izdelka</p><p>${esc(o.evidence)}</p></div>` : ""}
    ${hist.length > 1 ? sparkHTML(hist) : ""}
    <dl class="meta">
      ${row("Trgovina", esc(o.store) + (o.country ? " · " + esc(countryName(o.country)) : ""))}
      ${row("Zaloga", esc(avail))}
      ${row("Dostava", esc(shippingText(o)))}
      ${ship !== null ? row("Skupaj z dostavo", "<b>" + money(o.price + ship) + "</b>") : ""}
      ${o.gtin ? row("EAN", `<span class="mono">${esc(o.gtin)}</span>`) : ""}
      ${wm ? row("Tvoja želja", esc(wm.term)) : ""}
      ${row("Prebrano", `<span class="mono">${esc(when(o.checkedAt))}</span>`)}
      ${row("Prvič najdeno", `<span class="mono">${esc(when(o.firstSeenAt))}</span>`)}
    </dl>
    <form class="tform" id="tForm" novalidate>
      <h3>Ciljna cena</h3>
      <p class="sub">Ko cena pade na tvoj cilj ali pod njega, dobiš obvestilo na telefon.</p>
      <div class="t-row"><div class="field"><label for="tVal">Obvesti me pri ceni (€)</label><input id="tVal" inputmode="decimal" autocomplete="off" value="${esc(String(suggest).replace(".", ","))}"${canEdit ? "" : " disabled"}></div>
        <button class="btn" type="submit" id="tSave"${canEdit ? "" : " disabled"}>${tg ? "Posodobi cilj" : "Shrani cilj"}</button>
        ${tg && canEdit ? `<button class="btn ghost" type="button" data-act="del-target" data-id="${esc(o.id)}">Odstrani</button>` : ""}</div>
      <p class="form-err" id="tErr2" role="alert"></p>
      ${canEdit ? "" : `<p class="note">Za ciljne cene se prijavi v zavihku Moj radar.</p>`}
    </form>
    ${href ? `<a class="btn wide-btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Odpri pri trgovcu ↗</a>` : ""}
  </div>`;
  $("#tForm").addEventListener("submit", (e) => saveTarget(e, o.id));
  if (!m.open) m.showModal();
}

async function saveTarget(e, id) {
  e.preventDefault();
  const o = offerById(id), err = $("#tErr2"), inp = $("#tVal"), btn = $("#tSave");
  if (!o) { $("#modal").close(); return; }
  err.textContent = "";
  const v = parseEur(inp.value);
  if (v === null) { err.textContent = "Vpiši ceno v evrih, na primer 19,99."; inp.focus(); return; }
  if (v >= o.price) { err.textContent = "Ciljna cena mora biti nižja od trenutne cene " + money(o.price) + "."; inp.focus(); return; }
  btn.disabled = true;
  try {
    await api("/api/targets/" + o.id, { method: "PUT", body: { target: v, name: o.name, url: o.url, store: o.store, priceAtSet: o.price } });
    toast("Ciljna cena " + money(v) + " je shranjena.");
    $("#modal").close();
    loadRadar();
  } catch (x) { err.textContent = x.message; }
  btn.disabled = false;
}

/* ---------------- notifications and install ---------------- */
const b64ToBytes = (s) => { const p = "=".repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

async function refreshPushState() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) { S.pushOn = false; S.pushSupported = false; return; }
  S.pushSupported = true;
  try { const reg = await navigator.serviceWorker.ready; S.pushOn = !!(await reg.pushManager.getSubscription()); } catch { S.pushOn = false; }
}
function drawPush() {
  const state = $("#pushState");
  if (!S.pushSupported) {
    state.textContent = isIos() && !isStandalone() ? "Na iPhonu najprej dodaj NBC na začetni zaslon (Deli → Dodaj na začetni zaslon), nato odpri aplikacijo in vklopi obvestila." : "Ta brskalnik potisnih obvestil ne podpira.";
  } else state.textContent = S.pushOn ? "Obvestila so vklopljena na tej napravi." : "Obvestila so izklopljena na tej napravi.";
  $("#pushOn").hidden = !S.pushSupported || S.pushOn;
  $("#pushOff").hidden = !S.pushOn;
  $("#installHint").textContent = isStandalone() ? "" : S.installEvent ? "NBC lahko namestiš kot aplikacijo z gumbom zgoraj." : isIos() ? "Namestitev na iPhonu: Deli → Dodaj na začetni zaslon." : "Namestitev: v meniju brskalnika izberi »Namesti aplikacijo« ali »Dodaj na začetni zaslon«.";
}
async function pushOn() {
  if (!S.key) { toast("Najprej se prijavi."); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Obvestila niso dovoljena. Dovoli jih v nastavitvah brskalnika."); return; }
    const reg = await navigator.serviceWorker.ready;
    const { vapidPublicKey } = await api("/api/config");
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapidPublicKey) });
    await api("/api/push", { method: "POST", body: { subscription: sub.toJSON(), device: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "" } });
    S.pushOn = true;
    toast("Obvestila so vklopljena.");
  } catch (e) { toast("Obvestil ni bilo mogoče vklopiti: " + e.message); }
  render();
}
async function pushOff() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { try { await api("/api/push", { method: "DELETE", body: { endpoint: sub.endpoint } }); } catch {} await sub.unsubscribe(); }
    S.pushOn = false;
    toast("Obvestila so izklopljena na tej napravi.");
  } catch (e) { toast(e.message); }
  render();
}

/* ---------------- actions ---------------- */
let toastTimer = 0;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}
function setView(v) { S.view = VIEWS.includes(v) ? v : "ponudbe"; render(); }
function needKey() { toast("Za to se prijavi v zavihku Moj radar."); location.hash = "radar"; }

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act],[data-close]");
  if (!b) return;
  if (b.hasAttribute("data-close")) { $("#modal").close(); return; }
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case "view": setView(b.dataset.view); if (location.hash.slice(1) !== S.view) location.hash = S.view; window.scrollTo(0, 0); break;
    case "save": if (S.saved.has(id)) S.saved.delete(id); else S.saved.add(id); persistSaved(); render(); break;
    case "open": openOffer(id); break;
    case "cat": S.cat = b.dataset.cat || ""; render(); break;
    case "saved-only": S.onlySaved = !S.onlySaved; render(); break;
    case "clear": Object.assign(S, { cat: "", q: "", store: "", country: "", onlySaved: false }); $("#q").value = ""; render(); break;
    case "close-live": if (S.live && S.live.ctrl) S.live.ctrl.abort(); S.live = null; render(); break;
    case "search-term": $("#q").value = b.dataset.term; S.q = ""; setView("ponudbe"); location.hash = "ponudbe"; liveSearch(b.dataset.term); break;
    case "install":
      if (S.installEvent) { S.installEvent.prompt(); try { await S.installEvent.userChoice; } catch {} S.installEvent = null; render(); }
      break;
    case "push-on": pushOn(); break;
    case "push-off": pushOff(); break;
    case "logout": setKey(null); S.watch = []; S.targets = new Map(); S.tracked = []; render(); toast("Odjavljen na tej napravi."); break;
    case "save-wish": {
      if (!S.key) return needKey();
      if (!S.live) return;
      try { await api("/api/watch", { method: "POST", body: { term: S.live.query, maxPrice: null, category: null } }); toast("Želja »" + S.live.query + "« je shranjena. NBC jo bo preverjal vsake 3 ure."); loadRadar(); }
      catch (x) { toast(x.message); }
      break;
    }
    case "track-live": {
      if (!S.key) return needKey();
      b.disabled = true;
      try { await api("/api/tracked", { method: "POST", body: { url: b.dataset.url, name: b.dataset.name, store: b.dataset.store } }); toast("Izdelek spremljaš. Obvestilo dobiš, ko se poceni."); b.textContent = "Spremljaš ✓"; loadRadar(); }
      catch (x) { toast(x.message); b.disabled = false; }
      break;
    }
    case "del-watch": case "del-target": case "del-tracked": {
      const path = { "del-watch": "/api/watch/", "del-target": "/api/targets/", "del-tracked": "/api/tracked/" }[b.dataset.act] + id;
      b.disabled = true;
      try { await api(path, { method: "DELETE" }); toast("Odstranjeno."); if ($("#modal").open) $("#modal").close(); loadRadar(); }
      catch (x) { toast(x.message); b.disabled = false; }
      break;
    }
  }
});

$("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) $("#modal").close(); });
$("#searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#q").value.trim();
  $("#q").blur();
  if (q.length < 2) { toast("Vpiši vsaj dve črki."); return; }
  S.q = "";
  liveSearch(q);
});
$("#q").addEventListener("input", () => { S.q = $("#q").value; render(); });
$("#fStore").addEventListener("change", (e) => { S.store = e.target.value; render(); });
$("#fCountry").addEventListener("change", (e) => { S.country = e.target.value; render(); });
$("#fSort").addEventListener("change", (e) => { S.sort = e.target.value; render(); });
$("#srcQ").addEventListener("input", (e) => { S.srcQ = e.target.value; render(); });
window.addEventListener("hashchange", () => { setView(location.hash.slice(1)); window.scrollTo(0, 0); });

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const k = $("#keyInput").value.trim(), err = $("#loginErr");
  err.textContent = "";
  if (!k) { err.textContent = "Vpiši ključ."; return; }
  $("#loginBtn").disabled = true;
  setKey(k);
  try { await api("/api/me"); $("#keyInput").value = ""; toast("Prijavljen."); await loadRadar(); }
  catch (x) { setKey(null); err.textContent = x.status === 401 ? "Ključ ni pravilen." : x.message; }
  $("#loginBtn").disabled = false;
  render();
});

$("#watchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#wErr"), btn = $("#wBtn");
  err.textContent = "";
  const term = $("#wTerm").value.trim().replace(/\s+/g, " ");
  const maxRaw = $("#wMax").value.trim();
  const max = maxRaw ? parseEur(maxRaw) : null;
  if (term.length < 2) { err.textContent = "Vpiši vsaj dve črki."; return; }
  if (maxRaw && max === null) { err.textContent = "Najvišjo ceno vpiši kot število, na primer 400."; return; }
  btn.disabled = true;
  try {
    await api("/api/watch", { method: "POST", body: { term, maxPrice: max, category: $("#wCat").value || null } });
    $("#watchForm").reset();
    toast("Želja »" + term + "« je dodana. Iščem takoj.");
    await loadRadar();
    $("#q").value = term; setView("ponudbe"); location.hash = "ponudbe"; liveSearch(term);
  } catch (x) { err.textContent = x.message; }
  btn.disabled = false;
});

$("#trackForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#tErr"), btn = $("#tBtn");
  err.textContent = "";
  const url = $("#tUrl").value.trim();
  const tRaw = $("#tTarget").value.trim();
  const target = tRaw ? parseEur(tRaw) : null;
  if (!/^https:\/\/\S+\.\S+/.test(url)) { err.textContent = "Prilepi celoten naslov izdelka, ki se začne s https://"; return; }
  if (tRaw && target === null) { err.textContent = "Ciljno ceno vpiši kot število, na primer 199,99."; return; }
  btn.disabled = true;
  try {
    let name = null, store = null;
    try { const page = await shopPage(url); const p = extractProduct(page.html, page.finalUrl); if (p) { name = p.name; toast(p.name + ": zdaj " + money(p.price) + "."); } } catch {}
    await api("/api/tracked", { method: "POST", body: { url, target, name, store } });
    $("#trackForm").reset();
    if (!name) toast("Izdelek spremljaš. Ceno prebere naslednje iskanje.");
    loadRadar();
  } catch (x) { err.textContent = x.message; }
  btn.disabled = false;
});

window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.installEvent = e; render(); });
window.addEventListener("appinstalled", () => { S.installEvent = null; toast("NBC je nameščen."); render(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadCatalog(); loadRadar(); } });

/* ---------------- start ---------------- */
$("#wCat").innerHTML = `<option value="">Katerakoli</option>` + CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
setView(location.hash.slice(1));
draw();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").then(refreshPushState).then(render).catch(() => {});
loadCatalog();
loadRadar();
setInterval(() => { if (!document.hidden) loadCatalog(); }, 3 * 60e3);

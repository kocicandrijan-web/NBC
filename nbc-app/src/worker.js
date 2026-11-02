// NBC: Cloudflare Worker. Serves the app (static files in /public), keeps the data in one
// Durable Object (SQLite), and passes the app's live shop searches through a polite fetcher.
import { DurableObject } from "cloudflare:workers";
import { robotsAllows } from "../public/lib/extract.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: JSON_HEADERS });
const fail = (error, status = 400) => json({ error }, status);
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const clean = (x, max = 200) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, max) : "");
const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let TEST_MODE = false; // local tests only (NBC_TEST=1): lets http://127.0.0.1 test shops through
function httpsUrl(raw) {
  try {
    const u = new URL(raw);
    if (TEST_MODE && u.protocol === "http:" && u.hostname === "127.0.0.1") { u.hash = ""; return u.href; }
    if (u.protocol !== "https:" || u.username || u.password || u.port || !u.hostname.includes(".") || /^[\d.]+$/.test(u.hostname) || u.hostname === "localhost") return null;
    u.hash = "";
    return u.href;
  } catch { return null; }
}
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const randomId = () => b64url(crypto.getRandomValues(new Uint8Array(9)));

/* ------------------------------------------------------------------ */
/* Data: one Durable Object holds everything.                          */
/* ------------------------------------------------------------------ */
export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    TEST_MODE = env.NBC_TEST === "1";
    this.sql = ctx.storage.sql;
    for (const q of [
      "CREATE TABLE IF NOT EXISTS offers (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started TEXT NOT NULL, data TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS radar (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id))",
      "CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, data TEXT NOT NULL, created TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
    ]) this.sql.exec(q);
  }

  getMeta(k) { const r = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]; return r ? r.v : null; }
  setMeta(k, v) { this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v)); }
  rows(q, ...b) { return this.sql.exec(q, ...b).toArray().map((r) => JSON.parse(r.data)); }

  /** First start: import the offers and sources shipped with the app. */
  seed(seedText, sourcesText) {
    if (this.getMeta("seeded")) return false;
    const seed = JSON.parse(seedText || "{}");
    const sources = JSON.parse(sourcesText || "[]");
    this.ctx.storage.transactionSync(() => {
      for (const o of seed.offers || []) this.sql.exec("INSERT OR REPLACE INTO offers (id, data) VALUES (?, ?)", o.id, JSON.stringify(o));
      for (const s of sources) this.sql.exec("INSERT OR REPLACE INTO sources (id, data) VALUES (?, ?)", s.id, JSON.stringify(s));
      for (const r of seed.runs || []) this.sql.exec("INSERT OR REPLACE INTO runs (id, started, data) VALUES (?, ?, ?)", r.id, r.startedAt, JSON.stringify(r));
      this.setMeta("updatedAt", seed.updatedAt || nowIso());
      this.setMeta("seeded", nowIso());
    });
    return true;
  }
  isSeeded() { return !!this.getMeta("seeded"); }

  catalog() {
    return {
      updatedAt: this.getMeta("updatedAt"),
      offers: this.rows("SELECT data FROM offers"),
      sources: this.rows("SELECT data FROM sources ORDER BY id"),
      runs: this.rows("SELECT data FROM runs ORDER BY started DESC LIMIT 40"),
    };
  }

  /** The scheduled search sends the full offer and source lists plus one run record. */
  putCatalog(body) {
    const offers = Array.isArray(body.offers) ? body.offers : null;
    const sources = Array.isArray(body.sources) ? body.sources : null;
    if (!offers || offers.length > 3000) throw new Error("offers: največ 3000");
    if (sources && sources.length > 500) throw new Error("sources: največ 500");
    for (const o of offers) {
      if (!o || typeof o.id !== "string" || !/^[\w-]{6,64}$/.test(o.id) || !httpsUrl(o.url) || !num(o.price) || o.currency !== "EUR") throw new Error("Neveljavna ponudba: " + (o && o.id));
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM offers");
      for (const o of offers) this.sql.exec("INSERT INTO offers (id, data) VALUES (?, ?)", o.id, JSON.stringify(o));
      if (sources) {
        this.sql.exec("DELETE FROM sources");
        for (const s of sources) if (s && typeof s.id === "string") this.sql.exec("INSERT INTO sources (id, data) VALUES (?, ?)", s.id, JSON.stringify(s));
      }
      if (body.run && typeof body.run.id === "string") {
        this.sql.exec("INSERT OR REPLACE INTO runs (id, started, data) VALUES (?, ?, ?)", body.run.id, String(body.run.startedAt || nowIso()), JSON.stringify(body.run));
        this.sql.exec("DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY started DESC LIMIT 120)");
      }
      this.setMeta("updatedAt", nowIso());
    });
    return { ok: true, offers: offers.length, updatedAt: this.getMeta("updatedAt") };
  }

  /** A run record on its own, so the app can show "searching now". */
  putRun(run) {
    if (!run || typeof run.id !== "string") throw new Error("run.id manjka");
    this.sql.exec("INSERT OR REPLACE INTO runs (id, started, data) VALUES (?, ?, ?)", run.id, String(run.startedAt || nowIso()), JSON.stringify(run));
    return { ok: true };
  }

  radar() {
    const all = this.sql.exec("SELECT kind, data FROM radar").toArray();
    const by = (k) => all.filter((r) => r.kind === k).map((r) => JSON.parse(r.data));
    return { watch: by("watch"), targets: by("targets"), tracked: by("tracked") };
  }
  radarPut(kind, id, data) {
    const n = this.sql.exec("SELECT COUNT(*) AS n FROM radar WHERE kind = ?", kind).one().n;
    const exists = this.sql.exec("SELECT 1 FROM radar WHERE kind = ? AND id = ?", kind, id).toArray().length;
    if (!exists && n >= 200) throw new Error("Doseženo je največje število vnosov.");
    this.sql.exec("INSERT INTO radar (kind, id, data) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data", kind, id, JSON.stringify({ ...data, id }));
    return { ...data, id };
  }
  radarDelete(kind, id) { this.sql.exec("DELETE FROM radar WHERE kind = ? AND id = ?", kind, id); return { ok: true }; }
  /** The scheduled search updates match and hit fields; other fields stay as the owner set them. */
  radarState(updates) {
    let n = 0;
    for (const kind of ["watch", "targets", "tracked"]) {
      for (const u of [].concat(updates?.[kind] || [])) {
        if (!u || typeof u.id !== "string") continue;
        const row = this.sql.exec("SELECT data FROM radar WHERE kind = ? AND id = ?", kind, u.id).toArray()[0];
        if (!row) continue;
        const cur = JSON.parse(row.data);
        const allowed = ["lastMatchAt", "lastMatchOfferId", "hitAt", "hitPrice", "offerId", "lastCheckedAt", "lastPrice", "lastError", "name", "store"];
        for (const k of allowed) if (k in u) cur[k] = u[k];
        this.sql.exec("UPDATE radar SET data = ? WHERE kind = ? AND id = ?", JSON.stringify(cur), kind, u.id);
        n++;
      }
    }
    return { ok: true, updated: n };
  }

  addSub(sub, device) {
    if (!sub || !httpsUrl(sub.endpoint) || !sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") throw new Error("Neveljavna naročnina");
    const n = this.sql.exec("SELECT COUNT(*) AS n FROM subs").one().n;
    if (n >= 50) throw new Error("Preveč naprav. Odjavi kakšno.");
    this.sql.exec("INSERT INTO subs (endpoint, data, created) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET data = excluded.data",
      sub.endpoint, JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, device: clean(device, 120) }), nowIso());
    return { ok: true };
  }
  removeSubs(endpoints) { for (const e of [].concat(endpoints || [])) this.sql.exec("DELETE FROM subs WHERE endpoint = ?", String(e)); return { ok: true }; }
  listSubs() { return this.rows("SELECT data FROM subs"); }
  countSubs() { return this.sql.exec("SELECT COUNT(*) AS n FROM subs").one().n; }

  /** VAPID keys for web push, created once and kept here, so nobody has to generate them by hand. */
  async vapid() {
    const have = this.getMeta("vapid");
    if (have) return JSON.parse(have);
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
    const v = { publicKey: b64url(raw), privateKey: jwk.d };
    this.setMeta("vapid", JSON.stringify(v));
    return v;
  }

  allowedHosts() {
    const hosts = new Set();
    for (const s of this.rows("SELECT data FROM sources")) { const h = hostOf(s.url); if (h) hosts.add(h); for (const d of s.deals || []) hosts.add(hostOf(d)); }
    for (const t of this.rows("SELECT data FROM radar WHERE kind = 'tracked'")) { const h = hostOf(t.url); if (h) hosts.add(h); }
    return [...hosts].filter(Boolean);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
const store = (env) => env.STORE.get(env.STORE.idFromName("main"));

async function sameSecret(a, b) {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}
async function isOwner(req, env) {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") && (await sameSecret(h.slice(7).trim(), env.NBC_KEY));
}

async function readJson(req, max = 4_000_000) {
  if (!(req.headers.get("content-type") || "").includes("application/json")) throw new Error("Pričakujem JSON.");
  const text = await req.text();
  if (text.length > max) throw new Error("Prevelik zahtevek.");
  return JSON.parse(text);
}

async function ensureSeed(env, req) {
  const s = store(env);
  if (await s.isSeeded()) return s;
  const [seed, sources] = await Promise.all([
    env.ASSETS.fetch(new Request(new URL("/data/seed.json", req.url))).then((r) => (r.ok ? r.text() : "{}")),
    env.ASSETS.fetch(new Request(new URL("/data/sources.json", req.url))).then((r) => (r.ok ? r.text() : "[]")),
  ]);
  await s.seed(seed, sources);
  return s;
}

/* Live search from the app: fetch a shop page for the visitor's browser to read. */
const hits = new Map();
function rateLimited(ip) {
  const minute = Math.floor(Date.now() / 60000);
  const key = ip + ":" + minute;
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 5000) for (const k of hits.keys()) if (!k.endsWith(":" + minute)) hits.delete(k);
  return n > 90;
}
let hostCache = { at: 0, hosts: new Set() };
async function allowedHost(env, host) {
  if (Date.now() - hostCache.at > 120000) hostCache = { at: Date.now(), hosts: new Set(await store(env).allowedHosts()) };
  return hostCache.hosts.has(host.replace(/^www\./, ""));
}
const UA = (origin) => `NBC-pregled-cen/1.0 (+${origin}/)`;

async function robotsOk(target, origin, ctx) {
  const robotsUrl = new URL("/robots.txt", target).href;
  const cache = caches.default;
  const key = new Request("https://nbc-cache.internal/robots?u=" + encodeURIComponent(robotsUrl));
  let txt = null;
  const hit = await cache.match(key);
  if (hit) txt = await hit.text();
  else {
    try {
      const r = await fetch(robotsUrl, { headers: { "user-agent": UA(origin) }, signal: AbortSignal.timeout(6000) });
      txt = r.ok ? (await r.text()).slice(0, 200_000) : "";
    } catch { txt = ""; }
    ctx.waitUntil(cache.put(key, new Response(txt, { headers: { "cache-control": "public, max-age=86400" } })));
  }
  return robotsAllows(txt, target, "nbc");
}

async function shopFetch(req, env, ctx, url) {
  if (req.headers.get("x-nbc") !== "1") return fail("Dostop ni dovoljen.", 403);
  const ip = req.headers.get("cf-connecting-ip") || "x";
  if (rateLimited(ip)) return fail("Preveč iskanj naenkrat. Počakaj minuto.", 429);
  const target = httpsUrl(url.searchParams.get("url") || "");
  if (!target) return fail("Neveljaven naslov.");
  if (!(await allowedHost(env, hostOf(target)))) return fail("Trgovina ni na seznamu virov.", 403);
  if (!(await robotsOk(target, url.origin, ctx))) return json({ error: "Trgovina samodejnega branja te strani ne dovoli.", robots: true }, 451);
  const cache = caches.default;
  const key = new Request("https://nbc-cache.internal/page?u=" + encodeURIComponent(target));
  const cached = await cache.match(key);
  if (cached) return cached;
  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { "user-agent": UA(url.origin), accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "accept-language": "sl-SI,sl;q=0.9,en;q=0.6" },
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    return json({ error: "Trgovina se ni odzvala.", upstream: 0 }, 504);
  }
  const finalUrl = upstream.url || target;
  if (!(await allowedHost(env, hostOf(finalUrl)))) return fail("Trgovina preusmerja drugam.", 403);
  if (!upstream.ok) return json({ error: "Trgovina je zavrnila dostop.", upstream: upstream.status }, 502);
  const type = upstream.headers.get("content-type") || "";
  if (!/html|xml|text|json/i.test(type)) return fail("Stran ni besedilo.", 415);
  let text = await upstream.text();
  if (text.length > 3_000_000) text = text.slice(0, 3_000_000);
  const res = new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "x-final-url": finalUrl, "cache-control": "public, max-age=900", "x-content-type-options": "nosniff" } });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

async function api(req, env, ctx, url) {
  const p = url.pathname;
  const m = req.method;
  if (p === "/api/config" && m === "GET") {
    const v = await store(env).vapid();
    return json({ vapidPublicKey: v.publicKey, configured: !!env.NBC_KEY });
  }
  if (p === "/api/catalog" && m === "GET") {
    const s = await ensureSeed(env, req);
    return json(await s.catalog());
  }
  if (p === "/api/fetch" && m === "GET") return shopFetch(req, env, ctx, url);

  /* everything below needs the owner's key */
  if (!env.NBC_KEY) return fail("Na strežniku ni nastavljen NBC_KEY.", 503);
  if (!(await isOwner(req, env))) return fail("Ključ ni pravilen.", 401);
  const s = await ensureSeed(env, req);

  if (p === "/api/me" && m === "GET") return json({ ok: true, devices: await s.countSubs() });
  if (p === "/api/catalog" && m === "PUT") return json(await s.putCatalog(await readJson(req)));
  if (p === "/api/run" && m === "PUT") return json(await s.putRun(await readJson(req, 100_000)));
  if (p === "/api/radar" && m === "GET") return json(await s.radar());
  if (p === "/api/radar/state" && m === "PUT") return json(await s.radarState(await readJson(req, 500_000)));

  if (p === "/api/watch" && m === "POST") {
    const b = await readJson(req, 10_000);
    const term = clean(b.term, 80);
    if (term.length < 2) return fail("Vpiši vsaj dve črki.");
    const maxPrice = b.maxPrice == null ? null : num(b.maxPrice);
    if (b.maxPrice != null && !(maxPrice > 0 && maxPrice < 1e7)) return fail("Najvišja cena ni veljavna.");
    const existing = (await s.radar()).watch;
    if (existing.some((w) => w.term.toLowerCase() === term.toLowerCase())) return fail("To željo že spremljaš.", 409);
    return json(await s.radarPut("watch", randomId(), { term, maxPrice, category: clean(b.category, 60) || null, createdAt: nowIso(), lastMatchAt: null, lastMatchOfferId: null }), 201);
  }
  if (p === "/api/tracked" && m === "POST") {
    const b = await readJson(req, 10_000);
    const link = httpsUrl(clean(b.url, 1000));
    if (!link) return fail("Prilepi celoten naslov izdelka (https://…).");
    const target = b.target == null ? null : num(b.target);
    return json(await s.radarPut("tracked", randomId(), { url: link, target, name: clean(b.name, 200) || null, store: clean(b.store, 100) || null, createdAt: nowIso(), lastCheckedAt: null, lastPrice: null, offerId: null }), 201);
  }
  let mm = p.match(/^\/api\/(watch|tracked)\/([\w-]{4,40})$/);
  if (mm && m === "DELETE") return json(await s.radarDelete(mm[1], mm[2]));
  mm = p.match(/^\/api\/targets\/([\w-]{6,64})$/);
  if (mm && m === "PUT") {
    const b = await readJson(req, 10_000);
    const target = num(b.target);
    if (!(target > 0 && target < 1e7)) return fail("Ciljna cena ni veljavna.");
    return json(await s.radarPut("targets", mm[1], { offerId: mm[1], target, name: clean(b.name, 200), url: httpsUrl(b.url) || null, store: clean(b.store, 100), priceAtSet: num(b.priceAtSet), createdAt: nowIso(), hitAt: null, hitPrice: null }));
  }
  if (mm && m === "DELETE") return json(await s.radarDelete("targets", mm[1]));

  if (p === "/api/push" && m === "POST") { const b = await readJson(req, 20_000); return json(await s.addSub(b.subscription, b.device)); }
  if (p === "/api/push" && m === "DELETE") { const b = await readJson(req, 20_000); return json(await s.removeSubs([b.endpoint])); }
  if (p === "/api/push/all" && m === "GET") return json({ subs: await s.listSubs(), vapid: await s.vapid() });
  if (p === "/api/push/prune" && m === "POST") { const b = await readJson(req, 200_000); return json(await s.removeSubs(b.endpoints)); }

  return fail("Ni najdeno.", 404);
}

export default {
  async fetch(req, env, ctx) {
    TEST_MODE = env.NBC_TEST === "1";
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, ctx, url);
    } catch (e) {
      return fail(String((e && e.message) || e).slice(0, 300), 400);
    }
  },
};

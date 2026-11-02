// NBC: reading product data from shop pages.
// Shared by the web app (browser) and the scheduled search (Node). No dependencies, no DOM:
// shops publish product data for search engines (schema.org JSON-LD, microdata, Open Graph),
// and that is what this module reads. Everything read from a page is treated as data.

export const CATEGORIES = ["Obutev", "Oblačila", "Elektronika", "Računalništvo", "Telefonija", "Bela tehnika", "Mali gospodinjski aparati", "Ogrevanje in hlajenje", "Pohištvo", "Dom", "Šport", "Vrt in orodje", "Kovine in gradnja", "Lepota in zdravje", "Otroci in igrače", "Avto in moto", "Za živali", "Živila", "Rože in rastline", "Knjige", "Pisarna in šola", "Nakit in ure", "Ostalo"];

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€", shy: "", ndash: "–", mdash: "—", hellip: "…", scaron: "š", Scaron: "Š", zcaron: "ž", Zcaron: "Ž", ccaron: "č", Ccaron: "Č", raquo: "»", laquo: "«" };

export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function htmlToText(html) {
  return decodeEntities(String(html || "")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const round2 = (n) => Math.round(n * 100) / 100;

/** A price as shops print it: "1.299,99 €", "1 299,99", "23,99", "1299.99", "1.299 €". */
export function parsePrice(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 && v < 1e7 ? round2(v) : null;
  if (typeof v !== "string") return null;
  const m = v.replace(/[  \s']/g, "").match(/\d[\d.,]*/);
  if (!m) return null;
  let s = m[0].replace(/[.,]+$/, "");
  const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
  if (lc > -1 && ld > -1) {
    s = lc > ld ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lc > -1) {
    const decimals = s.length - lc - 1, commas = (s.match(/,/g) || []).length;
    s = commas === 1 && decimals <= 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (ld > -1) {
    const decimals = s.length - ld - 1, dots = (s.match(/\./g) || []).length;
    if (dots > 1 || (decimals === 3 && !/^0\./.test(s))) s = s.replace(/\./g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n < 1e7 ? round2(n) : null;
}

/** Prices inside structured data use a dot as the decimal separator. */
function parseDataPrice(v) {
  if (typeof v === "number") return parsePrice(v);
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s/g, "");
  if (/^\d+(\.\d+)?$/.test(t)) return parsePrice(Number(t));
  return parsePrice(t);
}

export function canonicalUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|msclkid|mc_|_ga|ref$|ref_|srsltid|yclid|igshid|spm|trk|sc_)/i.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.toLowerCase();
    return u.href;
  } catch { return null; }
}

export const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

export function fold(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/ß/g, "ss");
}

/* ---------- structured data ---------- */

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let t = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/^<!--|-->$/g, "").trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); continue; } catch {}
    try { out.push(JSON.parse(t.replace(/[\u0000-\u001f]+/g, " "))); } catch {}
  }
  return out;
}

function* walk(node, depth = 0) {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) { for (const n of node) yield* walk(n, depth + 1); return; }
  if (typeof node !== "object") return;
  yield node;
  for (const k of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item", "hasVariant"]) {
    if (node[k] && typeof node[k] === "object") yield* walk(node[k], depth + 1);
  }
}

const typesOf = (n) => [].concat(n && n["@type"] || []).map((t) => String(t).replace(/^.*[/#]/, ""));
const first = (v) => (Array.isArray(v) ? v[0] : v);
const str = (v) => {
  v = first(v);
  if (v == null) return "";
  if (typeof v === "object") return str(v.name ?? v["@value"] ?? v.url ?? "");
  return decodeEntities(String(v)).replace(/\s+/g, " ").trim();
};

function normAvailability(v) {
  const s = fold(str(v)).replace(/^.*[/#]/, "");
  if (!s) return "unknown";
  if (/(instock|in_stock|in stock|limitedavailability|instoreonly|onlineonly|na zalogi|available)/.test(s)) return "in_stock";
  if (/(outofstock|out_of_stock|soldout|discontinued|oos|out of stock|ni na zalogi|razprodano)/.test(s)) return "out_of_stock";
  return "unknown";
}

function offerFields(offers) {
  const list = [];
  for (const o of [].concat(offers || [])) {
    if (!o || typeof o !== "object") continue;
    if (typesOf(o).includes("AggregateOffer") && o.offers) list.push(...[].concat(o.offers));
    list.push(o);
  }
  let best = null;
  for (const o of list) {
    const cur = str(o.priceCurrency || (o.priceSpecification && first(o.priceSpecification).priceCurrency)).toUpperCase();
    if (cur && cur !== "EUR") continue;
    let price = parseDataPrice(first(o.price) ?? o.lowPrice);
    let ref = null, refType = "";
    for (const ps of [].concat(o.priceSpecification || [])) {
      if (!ps || typeof ps !== "object") continue;
      const p = parseDataPrice(ps.price ?? ps.minPrice);
      const t = str(ps.priceType).replace(/^.*[/#]/, "");
      if (!p) continue;
      if (/Strikethrough|ListPrice|SRP|MSRP|RegularPrice|InvoicePrice/i.test(t)) { if (!ref || p > ref) { ref = p; refType = t; } }
      else if (!price) price = p;
    }
    if (!price) continue;
    const cand = {
      price, currency: "EUR", referencePrice: ref && ref > price ? ref : null,
      referenceType: refType,
      availability: normAvailability(o.availability),
      shipping: (() => {
        const sd = first(o.shippingDetails);
        const rate = sd && first(sd.shippingRate);
        const v = rate && parseDataPrice(rate.value ?? rate.price);
        return v == null && rate && String(rate.value) === "0" ? 0 : v ?? null;
      })(),
      shippingCountries: (() => {
        const sd = first(o.shippingDetails);
        const dest = sd && sd.shippingDestination;
        const cs = [].concat(dest || []).map((d) => str(d && (d.addressCountry ?? d))).filter((c) => /^[A-Z]{2}$/.test(c));
        return cs.length ? [...new Set(cs)] : null;
      })(),
      gtin: str(o.gtin13 || o.gtin || o.gtin12 || o.gtin14 || o.gtin8).replace(/\D/g, ""),
      sku: str(o.sku),
      url: str(o.url),
    };
    if (!best || (cand.availability === "in_stock" && best.availability !== "in_stock") || (cand.availability === best.availability && cand.price < best.price)) best = cand;
  }
  return best;
}

function fromJsonLd(blocks, pageUrl) {
  const products = [];
  let crumbs = [];
  for (const b of blocks) {
    for (const n of walk(b)) {
      const t = typesOf(n);
      if (t.includes("BreadcrumbList")) crumbs = [].concat(n.itemListElement || []).map((e) => str(e && (e.name ?? (e.item && (e.item.name ?? e.item))))).filter(Boolean);
      if (t.includes("Product") || t.includes("ProductGroup") || t.includes("IndividualProduct") || t.includes("ProductModel")) {
        let offers = n.offers;
        let variant = null;
        if (!offers && n.hasVariant) {
          variant = [].concat(n.hasVariant).find((v) => v && v.offers);
          offers = variant && variant.offers;
        }
        const o = offerFields(offers);
        if (!o) continue;
        products.push({ node: n, variant, offer: o });
      }
    }
  }
  if (!products.length) return null;
  const canon = canonicalUrl(pageUrl);
  const pick = products.find((p) => canonicalUrl(str(p.node.url || p.offer.url), pageUrl) === canon) || products[0];
  const n = pick.node, v = pick.variant || {};
  const gtin = (str(v.gtin13 || v.gtin || n.gtin13 || n.gtin || n.gtin12 || n.gtin14 || n.gtin8) || pick.offer.gtin || "").replace(/\D/g, "");
  return {
    ...pick.offer,
    name: str(v.name || n.name),
    brand: str(n.brand ?? n.manufacturer),
    gtin: /^\d{8,14}$/.test(gtin) ? gtin : null,
    sku: str(v.sku || n.sku || n.mpn || pick.offer.sku),
    image: str(v.image || n.image),
    category: str(n.category) || crumbs.slice(1, -1).join(" > "),
  };
}

function metaTags(html) {
  const out = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const val = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (key && val != null && !(key.toLowerCase() in out)) out[key.toLowerCase()] = decodeEntities(val).trim();
  }
  return out;
}

function fromMicrodata(html) {
  if (!/itemtype\s*=\s*["'][^"']*schema\.org\/Product/i.test(html)) return null;
  const grab = (prop) => {
    const re = new RegExp(`<[^>]+itemprop\\s*=\\s*["']${prop}["'][^>]*>`, "i");
    const m = html.match(re);
    if (!m) return "";
    const c = m[0].match(/\b(?:content|href|value)\s*=\s*["']([^"']*)["']/i);
    if (c) return decodeEntities(c[1]).trim();
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 300);
    return htmlToText(after.split(/<\//)[0]);
  };
  const price = parseDataPrice(grab("price")) ?? parsePrice(grab("price"));
  if (!price) return null;
  const cur = grab("priceCurrency").toUpperCase();
  if (cur && cur !== "EUR") return null;
  return { name: grab("name"), brand: grab("brand"), price, currency: "EUR", availability: normAvailability(grab("availability")), gtin: (grab("gtin13") || grab("gtin")).replace(/\D/g, "") || null, sku: grab("sku"), referencePrice: null };
}

function fromMeta(meta) {
  const price = parseDataPrice(meta["product:price:amount"] || meta["og:price:amount"] || meta["product:sale_price:amount"]);
  if (!price) return null;
  const cur = String(meta["product:price:currency"] || meta["og:price:currency"] || "EUR").toUpperCase();
  if (cur !== "EUR") return null;
  const orig = parseDataPrice(meta["product:original_price:amount"] || meta["og:original_price:amount"]);
  return {
    name: meta["og:title"] || meta["twitter:title"] || "",
    brand: meta["product:brand"] || meta["og:brand"] || "",
    price, currency: "EUR",
    referencePrice: orig && orig > price ? orig : null,
    referenceType: orig ? "ListPrice" : "",
    availability: normAvailability(meta["product:availability"] || meta["og:availability"]),
    gtin: (meta["product:gtin"] || meta["product:ean"] || "").replace(/\D/g, "") || null,
    sku: meta["product:retailer_item_id"] || "",
    image: meta["og:image"] || "",
  };
}

/* ---------- reference (pre-discount) price from the visible page ---------- */

const OMNIBUS = /(najni[žz]j[ai] cena v (?:zadnjih|preteklih) 30 dneh|najni[žz]ja cena v 30 dneh|30-dnevna najni[žz]ja cena|najni[žz]a cijena u (?:zadnjih|posljednjih) 30 dana|niedrigster preis (?:der letzten|in den letzten) 30 tage|lowest price (?:in|of|during) the (?:last|past|previous) 30 days|prix le plus bas (?:des|au cours des) 30 derniers jours|laagste prijs (?:van de|in de) (?:afgelopen|laatste) 30 dagen)/i;
const MONEY = /(\d{1,3}(?:[.\s ]\d{3})+(?:,\d{2}|,-)?|\d+(?:[.,]\d{2}|,-)?)\s*(?:€|eur\b)|(?:€|eur)\s*(\d{1,3}(?:[.\s ]\d{3})+(?:,\d{2})?|\d+(?:[.,]\d{2})?)/gi;

function moneyIn(text) {
  const out = [];
  let m;
  MONEY.lastIndex = 0;
  while ((m = MONEY.exec(text))) { const p = parsePrice(m[1] || m[2]); if (p) out.push(p); }
  return out;
}

function nearPrice(html, price) {
  // The part of the page around the first place the current price is printed: avoids
  // picking up old prices from recommended products further down.
  const [i, d] = price.toFixed(2).split(".");
  const intFmt = i.replace(/\B(?=(\d{3})+(?!\d))/g, "[.\\s\\u00a0]?");
  const re = new RegExp(d === "00" ? `(?<![\\d.,])${intFmt}(?:[,.]00?|,-|(?![\\d.,]))` : `(?<![\\d.,])${intFmt}[,.]${d}`);
  const body = html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ");
  const m = re.exec(body);
  if (!m) return "";
  return body.slice(Math.max(0, m.index - 2500), m.index + 2500);
}

function visibleReference(html, price) {
  const zone = nearPrice(html, price);
  if (!zone) return null;
  const text = htmlToText(zone);
  const om = OMNIBUS.exec(text);
  if (om) {
    const after = moneyIn(text.slice(om.index, om.index + om[0].length + 60));
    const p = after.find((x) => x !== price) ?? after[0];
    if (p && p > price) return { referencePrice: p, referenceLabel: "Najnižja cena v zadnjih 30 dneh pred znižanjem" };
    if (p && p <= price) return { referencePrice: null, referenceLabel: null, lowest30: p };
  }
  const cands = [];
  const strike = /<(del|s|strike)\b[^>]*>([\s\S]{0,300}?)<\/\1>/gi;
  let m;
  while ((m = strike.exec(zone))) cands.push(...moneyIn(htmlToText(m[2])));
  const cls = /<[^>]+(?:class|id|data-price-type)\s*=\s*["'][^"']*(?:old|regular|was|strike|before|prej|stara|redna|original|list-?price|compare|crossed|rrp|uvp)[^"']*["'][^>]*>([\s\S]{0,400}?)<\/(?:span|div|p|del|s|small|strong|b|em|li|bdi)>/gi;
  while ((m = cls.exec(zone))) cands.push(...moneyIn(htmlToText(m[1])));
  const ok = cands.filter((p) => p > price * 1.01 && p < price * 4);
  if (!ok.length) return null;
  ok.sort((a, b) => a - b);
  return { referencePrice: ok[0], referenceLabel: "Prečrtana cena trgovca" };
}

/* ---------- categories ---------- */

const CAT_WORDS = [
  ["Telefonija", /\b(telefon|smartphone|pametni telefon|iphone|galaxy s|mobitel|gsm)/],
  ["Računalništvo", /\b(prenosnik|laptop|notebook|racunalnik|monitor|tipkovnica|miska|ssd|tiskalnik|tablica|tablet|graficna|procesor|router|usmerjevalnik)/],
  ["Bela tehnika", /\b(pralni stroj|susilni stroj|hladilnik|zamrzovalnik|pomivalni stroj|stedilnik|stedilnika|pecica|napa)/],
  ["Mali gospodinjski aparati", /\b(kavni aparat|kuhalnik|mesalnik|blender|sesalnik|robotski sesalnik|aparat za kavo|cvrtnik|air fryer|toaster|likalnik|multipraktik)/],
  ["Ogrevanje in hlajenje", /\b(kalorifer|grelnik|radiator|klima|klimatska|ventilator|termoventilator|razvlazilnik|vlazilnik)/],
  ["Elektronika", /\b(televizor|tv |slusalke|zvocnik|kamera|fotoaparat|konzola|playstation|xbox|nintendo|soundbar|projektor|ura pametna|smartwatch)/],
  ["Pohištvo", /\b(kavc|sedezna|postelja|omara|miza|stol|regal|predalnik|vzmetnica|garnitura|fotelj|komoda)/],
  ["Obutev", /\b(cevlji|superge|copati|skornji|sandali|obutev|sneakers)/],
  ["Oblačila", /\b(jakna|majica|hlace|puli|obleka|plasc|bunda|kavbojke|trenirka|perilo|nogavice)/],
  ["Šport", /\b(kolo|kolesa|fitnes|tekaski|smuci|rolka|sotor|kamping|zoga|utezi)/],
  ["Vrt in orodje", /\b(vrtalnik|kosilnica|zaga|brusilnik|orodje|izvijac|kompresor|visokotlacni|trimer|akumulatorski)/],
  ["Kovine in gradnja", /\b(profil|plocevina|cev |jeklo|aluminij|cement|ploscice|gradbeni|izolacija|vijaki)/],
  ["Lepota in zdravje", /\b(parfum|krema|sampon|kozmetika|losjon|britvica|zobna scetka|serum)/],
  ["Otroci in igrače", /\b(igraca|igrace|lego|otroski|vozicek|plenice|dojencek)/],
  ["Avto in moto", /\b(pnevmatike|pnevmatika|avto|motorno olje|akumulator za avto|platisca)/],
  ["Za živali", /\b(hrana za pse|hrana za macke|pasja|macja|ljubljencek|steljo)/],
  ["Živila", /\b(kava |caj |olje |testenine|cokolada|zivila|pijaca)/],
  ["Rože in rastline", /\b(sopek|roze|vrtnice|rastlina|cvetlica|loncnica|orhideja)/],
  ["Knjige", /\b(knjiga|roman|slikanica)/],
  ["Pisarna in šola", /\b(sola|solska|zvezek|nahrbtnik solski|pisarniski|papir a4)/],
  ["Nakit in ure", /\b(ura |zapestnica|ogrlica|prstan|uhani|nakit)/],
  ["Dom", /\b(svetilka|posoda|ponev|preproga|zavesa|odeja|blazina|kopalnica|kuhinjski)/],
];

export function guessCategory(...texts) {
  const t = " " + fold(texts.filter(Boolean).join(" ")) + " ";
  for (const [cat, re] of CAT_WORDS) if (re.test(t)) return cat;
  return null;
}

/* ---------- public: product page ---------- */

/**
 * Read one product from a product page. Returns null when the page has no EUR price.
 * referencePrice is only set when the page itself shows a higher earlier price.
 */
export function extractProduct(html, pageUrl) {
  if (!html || typeof html !== "string") return null;
  const meta = metaTags(html);
  let p = fromJsonLd(jsonLdBlocks(html), pageUrl) || fromMicrodata(html) || fromMeta(meta);
  if (!p || !p.price) return null;
  if (!p.name) p.name = meta["og:title"] || htmlToText((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "") || htmlToText((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "");
  p.name = p.name.replace(/\s*[|–-]\s*[^|–-]{2,40}$/, (m) => (p.name.length > 40 ? "" : m)).slice(0, 200);
  if (!p.image) p.image = meta["og:image"] || "";
  let referenceLabel = null, lowest30 = null;
  if (p.referencePrice) referenceLabel = /Strikethrough/i.test(p.referenceType || "") ? "Prečrtana cena trgovca" : "Redna cena trgovca";
  const vis = visibleReference(html, p.price);
  if (vis && vis.lowest30) lowest30 = vis.lowest30;
  if (vis && vis.referenceLabel === "Najnižja cena v zadnjih 30 dneh pred znižanjem") ({ referencePrice: p.referencePrice, referenceLabel } = vis);
  else if (!p.referencePrice && vis && vis.referencePrice) ({ referencePrice: p.referencePrice, referenceLabel } = vis);
  if (lowest30 && p.referencePrice && referenceLabel !== "Najnižja cena v zadnjih 30 dneh pred znižanjem") {
    // The shop's own 30-day lowest price beats a crossed-out "regular" price.
    if (lowest30 > p.price) { p.referencePrice = lowest30; referenceLabel = "Najnižja cena v zadnjih 30 dneh pred znižanjem"; }
    else { p.referencePrice = null; referenceLabel = null; }
  }
  const url = canonicalUrl(pageUrl);
  const variant = [p.sku && `Šifra ${p.sku}`, p.gtin && `EAN ${p.gtin}`].filter(Boolean).join(" · ");
  return {
    url,
    name: p.name,
    brand: p.brand || "",
    category: CATEGORIES.includes(p.category) ? p.category : guessCategory(p.category, p.name) || null,
    price: p.price,
    currency: "EUR",
    referencePrice: p.referencePrice && p.referencePrice > p.price ? p.referencePrice : null,
    referenceLabel: p.referencePrice && p.referencePrice > p.price ? referenceLabel : null,
    availability: p.availability || "unknown",
    shipping: p.shipping ?? null,
    shippingCountries: p.shippingCountries || null,
    gtin: p.gtin || null,
    variant,
    image: /^https:\/\//.test(p.image || "") ? p.image : null,
    sourceHost: hostOf(url),
  };
}

/* ---------- public: listing and search pages ---------- */

const NOT_PRODUCT = /(\/(kosarica|cart|basket|checkout|blagajna|login|prijava|registracija|register|account|moj-racun|racun|wishlist|zelje|primerjava|compare|kontakt|contact|pomoc|help|faq|pogoji|terms|zasebnost|privacy|piskotki|cookies|blog|novice|news|trgovine|stores|poslovalnice|kariera|o-nas|about|search|iskanje|catalogsearch|brand|blagovne-znamke|znamke|newsletter|cdn-cgi)(\/|$|\?))|\.(jpe?g|png|gif|webp|svg|pdf|css|js|xml|zip)(\?|$)/i;

export function productScore(href) {
  let u;
  try { u = new URL(href); } catch { return -9; }
  const p = u.pathname.toLowerCase();
  if (NOT_PRODUCT.test(p + (u.search || ""))) return -9;
  const segs = p.split("/").filter(Boolean);
  if (!segs.length) return -9;
  const slug = segs[segs.length - 1];
  let s = 0;
  if (/\/(p|pd|dp|izdelek|izdelki|product|produkt|products|artikel|artikl|item|proizvod|proizvodi|prod)\//.test(p + "/")) s += 3;
  if (/\d{4,}/.test(p)) s += 2;
  if (/\.html?$/.test(p)) s += 1;
  if ((slug.match(/-/g) || []).length >= 3) s += 2;
  if (segs.length === 1 && !/\d/.test(slug) && (slug.match(/-/g) || []).length < 3) s -= 3;
  if (/[?&](page|p|sort|order|filter|stran)=/i.test(u.search)) s -= 4;
  return s;
}

/** Product links on a listing or search results page, best guesses first. */
export function extractLinks(html, pageUrl, limit = 8) {
  const host = hostOf(pageUrl);
  const self = canonicalUrl(pageUrl);
  const seen = new Map();
  const add = (href, bonus) => {
    const c = canonicalUrl(decodeEntities(href), pageUrl);
    if (!c || c === self || hostOf(c) !== host) return;
    const e = seen.get(c) || { url: c, n: 0, order: seen.size, bonus: 0 };
    e.n++;
    e.bonus = Math.max(e.bonus, bonus);
    seen.set(c, e);
  };
  for (const b of jsonLdBlocks(html)) {
    for (const n of walk(b)) {
      if (typesOf(n).includes("ItemList")) {
        for (const el of [].concat(n.itemListElement || [])) {
          const u = el && (el.url || (el.item && (el.item.url || el.item["@id"] || (typeof el.item === "string" ? el.item : ""))));
          if (u) add(String(u), 5);
        }
      }
    }
  }
  const re = /<a\b[^>]*?\bhref\s*=\s*["']([^"'#][^"']*)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) add(m[1], 0);
  return [...seen.values()]
    .map((e) => ({ ...e, score: productScore(e.url) + e.bonus + Math.min(e.n, 3) - 1 }))
    .filter((e) => e.score >= 2)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((e) => e.url);
}

/* ---------- matching a wish ---------- */

const STOP = new Set(["za", "in", "na", "z", "s", "v", "do", "od", "the", "a", "ali", "ki", "je"]);
export function queryTokens(q) {
  return fold(q).replace(/(\d)\s+(kg|l|w|cm|mm|m|gb|tb|v|mah|inch|")/g, "$1$2").split(/[^a-z0-9.]+/).filter((t) => t.length > 1 && !STOP.has(t));
}
export function matchesQuery(product, q) {
  const toks = queryTokens(q);
  if (!toks.length) return false;
  const hay = fold([product.name, product.brand, product.variant, product.category].join(" ")).replace(/(\d)\s+(kg|l|w|cm|mm|m|gb|tb|v|mah|inch|")/g, "$1$2");
  const stem = (t) => (t.length > 5 ? t.slice(0, t.length - 2) : t);
  const hits = toks.filter((t) => hay.includes(t) || hay.includes(stem(t))).length;
  return toks.length <= 2 ? hits === toks.length : hits >= toks.length - 1;
}

/* ---------- robots.txt ---------- */

export function robotsAllows(robotsTxt, url, agent = "nbc") {
  if (!robotsTxt) return true;
  let path;
  try { const u = new URL(url); path = u.pathname + (u.search || ""); } catch { return false; }
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(robotsTxt).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (k === "allow" || k === "disallow")) cur.rules.push({ allow: k === "allow", path: v });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.toLowerCase().includes(a)));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  let best = null;
  for (const r of rules) {
    if (!r.path) continue;
    const re = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

export function offerId(url) {
  // Short stable id from the canonical URL, identical in the browser and in the scheduled search.
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < url.length; i++) { const c = url.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

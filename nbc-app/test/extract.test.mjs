import test from "node:test";
import assert from "node:assert/strict";
import { parsePrice, extractProduct, extractLinks, matchesQuery, robotsAllows, canonicalUrl, guessCategory, offerId } from "../public/lib/extract.js";

test("parsePrice reads the formats shops print", () => {
  assert.equal(parsePrice("1.299,99 €"), 1299.99);
  assert.equal(parsePrice("1 299,99 EUR"), 1299.99);
  assert.equal(parsePrice("23,99"), 23.99);
  assert.equal(parsePrice("€ 1,299.50"), 1299.5);
  assert.equal(parsePrice("1.299 €"), 1299);
  assert.equal(parsePrice("0,99 €"), 0.99);
  assert.equal(parsePrice("49.90"), 49.9);
  assert.equal(parsePrice(""), null);
  assert.equal(parsePrice("brezplačno"), null);
});

test("JSON-LD product with a strikethrough price", () => {
  const html = `<html><head><title>Iskra PTC-905B | Trgovina</title>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Iskra PTC-905B električni kalorifer","brand":{"@type":"Brand","name":"Iskra"},"gtin13":"3830012345678","sku":"PTC-905B",
  "offers":{"@type":"Offer","price":"23.99","priceCurrency":"EUR","availability":"https://schema.org/InStock",
  "priceSpecification":[{"@type":"UnitPriceSpecification","price":35.99,"priceCurrency":"EUR","priceType":"https://schema.org/StrikethroughPrice"}]}}</script></head>
  <body><h1>Iskra PTC-905B</h1><span class="price">23,99 €</span></body></html>`;
  const p = extractProduct(html, "https://www.trgovina.si/izdelek/iskra-ptc-905b?utm_source=x#top");
  assert.equal(p.name, "Iskra PTC-905B električni kalorifer");
  assert.equal(p.brand, "Iskra");
  assert.equal(p.price, 23.99);
  assert.equal(p.referencePrice, 35.99);
  assert.equal(p.referenceLabel, "Prečrtana cena trgovca");
  assert.equal(p.availability, "in_stock");
  assert.equal(p.gtin, "3830012345678");
  assert.equal(p.url, "https://www.trgovina.si/izdelek/iskra-ptc-905b");
  assert.equal(p.category, "Ogrevanje in hlajenje");
  assert.equal(p.sourceHost, "trgovina.si");
});

test("Slovenian 30-day lowest price beats a crossed-out price", () => {
  const html = `<script type="application/ld+json">[{"@type":"BreadcrumbList","itemListElement":[{"name":"Domov"},{"name":"Prenosniki"},{"name":"Acer"}]},
  {"@type":"Product","name":"Acer Aspire Lite","offers":{"@type":"Offer","price":499.99,"priceCurrency":"EUR","availability":"InStock"}}]</script>
  <div class="product-price"><del>649,99 €</del> <strong>499,99 €</strong>
  <p class="omnibus">Najnižja cena v zadnjih 30 dneh: 535,29 €</p></div>
  <section class="related"><del>99,99 €</del> 79,99 €</section>`;
  const p = extractProduct(html, "https://shop.si/p/acer-aspire-lite-12345");
  assert.equal(p.price, 499.99);
  assert.equal(p.referencePrice, 535.29);
  assert.equal(p.referenceLabel, "Najnižja cena v zadnjih 30 dneh pred znižanjem");
  assert.equal(p.category, "Računalništvo");
});

test("no discount when the 30-day lowest price is the current price", () => {
  const html = `<script type="application/ld+json">{"@type":"Product","name":"Šopek","offers":{"price":"44.50","priceCurrency":"EUR"}}</script>
  <div><s>52,00 €</s> 44,50 € <small>Najnižja cena v zadnjih 30 dneh: 44,50 €</small></div>`;
  const p = extractProduct(html, "https://cvet.si/sopek-v-stekleni-posodi");
  assert.equal(p.price, 44.5);
  assert.equal(p.referencePrice, null);
});

test("microdata and Open Graph fallbacks", () => {
  const micro = `<div itemscope itemtype="https://schema.org/Product"><h1 itemprop="name">Robotski sesalnik X</h1>
  <meta itemprop="priceCurrency" content="EUR"><span itemprop="price" content="199.00">199,00 €</span>
  <link itemprop="availability" href="https://schema.org/OutOfStock"><span class="old-price">249,00 €</span></div>`;
  const a = extractProduct(micro, "https://www.bela.si/robotski-sesalnik-x-889911");
  assert.equal(a.price, 199);
  assert.equal(a.availability, "out_of_stock");
  assert.equal(a.referencePrice, 249);
  assert.equal(a.category, "Mali gospodinjski aparati");

  const og = `<meta property="og:title" content="Superge Nova 42"><meta property="product:price:amount" content="59.90">
  <meta property="product:price:currency" content="EUR"><meta property="product:availability" content="in stock">`;
  const b = extractProduct(og, "https://obutev.si/superge-nova-42");
  assert.equal(b.price, 59.9);
  assert.equal(b.availability, "in_stock");
  assert.equal(b.referencePrice, null);
});

test("non-EUR prices are ignored", () => {
  const html = `<script type="application/ld+json">{"@type":"Product","name":"X","offers":{"price":"999","priceCurrency":"CZK"}}</script>`;
  assert.equal(extractProduct(html, "https://alza.cz/x"), null);
});

test("product links from a search results page", () => {
  const html = `<a href="/kosarica">Košarica</a><a href="/iskanje?q=pralni">Iskanje</a>
  <a href="/pralni-stroji">Pralni stroji</a>
  <div class="card"><a href="/izdelek/pralni-stroj-beko-wue-8622-123456"><img></a><a href="/izdelek/pralni-stroj-beko-wue-8622-123456">Beko WUE 8622</a></div>
  <div class="card"><a href="https://www.shop.si/p/gorenje-wnei84aps-987654?utm_source=a">Gorenje</a></div>
  <a href="https://drug.si/izdelek/tuji-123456">Tuji</a><a href="/izdelek/pralni-stroj-beko-wue-8622-123456?page=2">stran 2</a>`;
  const links = extractLinks(html, "https://www.shop.si/iskanje?q=pralni+stroj");
  assert.deepEqual(links.slice(0, 2), ["https://www.shop.si/izdelek/pralni-stroj-beko-wue-8622-123456", "https://www.shop.si/p/gorenje-wnei84aps-987654"]);
  assert.ok(!links.some((l) => l.includes("drug.si") || l.includes("kosarica") || l.endsWith("/pralni-stroji")));
});

test("wish matching", () => {
  assert.ok(matchesQuery({ name: "Pralni stroj Beko WUE 8622, 8 kg" }, "pralni stroj 8 kg"));
  assert.ok(matchesQuery({ name: "Robotski sesalnik Roborock Q7" }, "robotski sesalnik"));
  assert.ok(!matchesQuery({ name: "Sušilni stroj Beko 8 kg" }, "pralni stroj"));
  assert.ok(matchesQuery({ name: "Zimske pnevmatike Michelin Alpin 205/55 R16" }, "zimske pnevmatike 205/55 R16"));
});

test("robots.txt", () => {
  const r = "User-agent: *\nDisallow: /iskanje\nDisallow: /*?q=\nAllow: /iskanje/izdelki\n\nUser-agent: badbot\nDisallow: /";
  assert.equal(robotsAllows(r, "https://s.si/iskanje?s=x"), false);
  assert.equal(robotsAllows(r, "https://s.si/catalog?q=x"), false);
  assert.equal(robotsAllows(r, "https://s.si/iskanje/izdelki/a"), true);
  assert.equal(robotsAllows(r, "https://s.si/izdelek/a-1234"), true);
  assert.equal(robotsAllows("", "https://s.si/a"), true);
});

test("helpers", () => {
  assert.equal(canonicalUrl("https://A.si/x?utm_medium=e&id=3#f"), "https://a.si/x?id=3");
  assert.equal(guessCategory("Hladilnik Gorenje"), "Bela tehnika");
  assert.equal(offerId("https://a.si/x"), offerId("https://a.si/x"));
  assert.notEqual(offerId("https://a.si/x"), offerId("https://a.si/y"));
  assert.match(offerId("https://a.si/x"), /^[0-9a-f]{16}$/);
});

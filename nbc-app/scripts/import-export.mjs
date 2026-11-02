// One-off: turn the exported data of the first NBC version into public/data/seed.json and merge new shops into sources.json.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { offerId, canonicalUrl } from "../public/lib/extract.js";
const dir = process.argv[2];
const readAll = async (sub) => { try { const fs = await readdir(join(dir, sub)); return Promise.all(fs.map(async (f) => JSON.parse(await readFile(join(dir, sub, f), "utf8")))); } catch { return []; } };
const strip = (d) => (d && d.data ? d.data : d);
const offers = (await readAll("offers")).map(strip).map((o) => {
  const url = canonicalUrl(o.url);
  const { watchMatch, ...rest } = o;
  return { ...rest, url, id: offerId(url), watchMatch: null, image: null };
});
const runs = [{ id: "uvoz", kind: "import", status: "done", startedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), finishedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), added: offers.length, rechecked: 0, priceDrops: 0, summary: `Uvoz iz prve različice NBC: ${offers.length} preverjenih ponudb.` }];
await writeFile("public/data/seed.json", JSON.stringify({ updatedAt: runs[0].startedAt, offers, runs }, null, 1));
const sources = JSON.parse(await readFile("public/data/sources.json", "utf8"));
const have = new Set(sources.map((s) => s.id));
for (const s of (await readAll("sources")).map(strip)) {
  const id = new URL(s.url).hostname.replace(/^www\./, "");
  const cur = sources.find((x) => x.id === id);
  if (cur) { if (s.status === "blocked") { cur.status = "blocked"; cur.note = s.note || cur.note; } continue; }
  sources.push({ id, name: s.name, url: s.url, category: s.category, country: s.country, status: s.status === "readable" ? "readable" : s.status || "discovered", search: null, deals: [s.url], note: s.note || null });
  have.add(id);
}
await writeFile("public/data/sources.json", JSON.stringify(sources, null, 1));
console.log(`seed: ${offers.length} ponudb · viri: ${sources.length}`);
for (const o of offers) console.log(" -", o.store, "|", o.name, "|", o.price, "|", o.checkedAt);

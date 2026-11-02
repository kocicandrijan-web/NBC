# NBC – Dobra stvar. Še boljša cena.

NBC je samostojna spletna aplikacija za popuste. Ponudbe kaže čez cel zaslon, deluje kot aplikacija na telefonu in pošilja potisna obvestila.

- **Takojšnje iskanje:** vpišeš, kaj iščeš, in NBC v nekaj sekundah preveri iskalnike trgovin s seznama.
- **Samodejno iskanje vsake 3 ure** (7:41–22:41): preveri tvoje želje, ciljne cene in spremljane izdelke, pregleda strani z akcijami in poišče nove popuste.
- **Moj radar:** želje (npr. »pralni stroj do 400 €«), ciljne cene in spremljanje izdelka po povezavi iz katerekoli trgovine.
- **Obvestila na telefon**, ko cena pade pod tvoj cilj, ko je najdena tvoja želja ali ko se pojavi velik nov popust.

NBC bere podatke, ki jih trgovine objavljajo za iskalnike (schema.org: ime, cena, zaloga, stara cena), in upošteva pravila trgovin za samodejno branje (`robots.txt`). Popust pokaže samo, če stran sama prikazuje višjo prejšnjo ceno; pri slovenskih trgovinah ima prednost »najnižja cena v zadnjih 30 dneh«.

## Kako je sestavljen

| Del | Kje teče | Kaj dela |
|---|---|---|
| `public/` | Cloudflare (statične datoteke) | Aplikacija: `index.html`, `styles.css`, `app.js`, `sw.js`, ikone |
| `src/worker.js` | Cloudflare Worker + Durable Object | Shranjuje ponudbe, želje, ciljne cene, naprave za obvestila; posreduje takojšnje iskanje |
| `crawler/crawl.mjs` | GitHub Actions, vsake 3 ure | Samodejno iskanje in pošiljanje obvestil |
| `public/lib/extract.js` | v brskalniku in v iskalniku | Branje podatkov o izdelku s strani trgovine |
| `public/data/sources.json` | | Seznam trgovin: iskalnik (`search` z `{q}`) in strani z akcijami (`deals`) |

Vse je brezplačno v okviru brezplačnih paketov Cloudflare in GitHub. Edina skrivnost je **ključ NBC** (`NBC_KEY`), ki ga nastaviš na dveh mestih.

## Namestitev (približno 15 minut)

### 1. Ključ NBC
Izmisli si dolg naključen ključ (vsaj 24 znakov, npr. iz upravitelja gesel). Z njim se prijaviš v aplikacijo in z njim iskalnik piše podatke. Nikomur ga ne pošiljaj.

### 2. GitHub
1. Ustvari repozitorij `nbc` (lahko zaseben).
2. Naloži vse datoteke iz tega projekta (brez mape `node_modules`).

### 3. Cloudflare
1. **Workers & Pages → Create → Import a repository →** poveži GitHub in izberi `nbc`.
2. Build command pusti prazen, Deploy command: `npx wrangler deploy`. Klikni **Deploy**.
3. Ko se objavi, odpri Worker **nbc → Settings → Variables and Secrets → Add**: tip **Secret**, ime `NBC_KEY`, vrednost tvoj ključ. Shrani in objavi.
4. Zapiši si naslov aplikacije, npr. `https://nbc.tvoje-ime.workers.dev`. Lastno domeno lahko dodaš pod **Settings → Domains & Routes**.

Vsaka sprememba v repozitoriju se na Cloudflare objavi sama.

### 4. Samodejno iskanje na GitHubu
1. V repozitoriju odpri **Settings → Secrets and variables → Actions**.
2. Zavihek **Secrets → New repository secret**: ime `NBC_KEY`, vrednost isti ključ.
3. Zavihek **Variables → New repository variable**: ime `NBC_URL`, vrednost naslov iz koraka 3.4 (brez poševnice na koncu).
4. Odpri **Actions → NBC iskanje → Run workflow** za prvo iskanje. Naprej teče samo vsake 3 ure.

### 5. Telefon
1. Odpri naslov aplikacije.
2. **Android:** v brskalniku Chrome izberi »Namesti aplikacijo« (ali gumb *Namesti aplikacijo* na strani).
   **iPhone:** v Safariju **Deli → Dodaj na začetni zaslon**, nato NBC odpri z začetnega zaslona.
3. V zavihku **Moj radar** vpiši ključ NBC in klikni **Vklopi obvestila**.

## Uporaba

- **Takojšnje iskanje:** vpiši izdelek in pritisni *Išči*. Zadetke lahko spremljaš ali iskanje shraniš kot željo.
- **Ciljna cena:** pri ponudbi izberi *Podrobnosti* in vpiši ceno.
- **Spremljanje po povezavi:** v *Moj radar* prilepi povezavo do izdelka in po želji ciljno ceno.
- **Nove trgovine:** v `public/data/sources.json` dodaj vnos z naslovom iskalnika (`search`, kjer `{q}` zamenja iskalni izraz) in strani z akcijami (`deals`). Po prvih iskanjih zavihek *Viri* pokaže, katere trgovine delujejo.

## Omejitve
- Nekatere trgovine samodejno branje zavrnejo ali ga v `robots.txt` ne dovolijo. NBC jih spoštuje in jih označi kot *Omejen dostop*.
- Iskalniki trgovin v seznamu so nastavljeni po najboljši vednosti. Če trgovina v *Viri* ne vrača zadetkov, popravi njen naslov `search`.
- V javnem repozitoriju GitHub po 60 dneh brez sprememb ustavi načrtovana opravila. Ponovno jih vklopiš v zavihku **Actions**.
- Pri zasebnem repozitoriju iskanje porabi okoli 500–900 minut GitHub Actions na mesec; brezplačni paket jih ima 2000.

## Razvoj
```
npm install
npm test                       # testi branja strani
npx wrangler dev               # aplikacija lokalno na http://localhost:8787 (ključ v .dev.vars: NBC_KEY=...)
NBC_URL=http://localhost:8787 NBC_KEY=... npm run search:dry   # iskanje brez zapisa
```

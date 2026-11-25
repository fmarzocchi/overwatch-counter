// Collaudo della PWA in Chromium con viewport da telefono (390×844).
// Uso: node tests/e2e.mjs [cartella-screenshot]   (serve il pacchetto "playwright")
// Le richieste esterne sono bloccate (icone remote e api.github.com simulate), quindi gira offline.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require(path.join(process.env.NODE_PATH ?? "", "playwright")));
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.resolve(process.argv[2] ?? path.join(ROOT, "tests", "screenshots"));
mkdirSync(SHOTS, { recursive: true });
const PORT = 8765 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}/`;
const data = JSON.parse(readFileSync(path.join(ROOT, "app", "data.json")));
// nomi italiani del gioco (app/names_it.json): la pagina mostra "Soldato-76", i dati dicono "Soldier: 76"
let namesFile = {};
try { namesFile = JSON.parse(readFileSync(path.join(ROOT, "app", "names_it.json"))); } catch { /* facoltativo */ }
const namesIt = namesFile.heroes ?? {};
const shownIt = Object.fromEntries(Object.entries(namesIt).filter(([en, it]) => it && en.toLowerCase() !== it.toLowerCase()));
const itn = (en) => shownIt[en] ?? en; // nome dei dati → nome mostrato
const ILIOS = namesFile.maps?.Ilios ?? "Ilios"; // nome della mappa come appare (in italiano: Ilio)
const toEn = (n) => Object.keys(shownIt).find((en) => shownIt[en] === n) ?? n; // nome mostrato → nome dei dati

const results = [];
const check = (name, cond, info = "") => {
  results.push(!!cond);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : `\n     ${info}`}`);
};

// copia dell'app da servire, con un file di divisione (Oro) simulato: counter di tutti +3%
const SITE = mkdtempSync(path.join(tmpdir(), "owc-site-"));
cpSync(path.join(ROOT, "app"), SITE, { recursive: true });
const goldDiv = {
  division: "gold", checked: new Date().toISOString(), overall: data.overall, synergies: data.synergies, maps: {},
  counters: Object.fromEntries(Object.entries(data.counters).map(([h, row]) =>
    [h, Object.fromEntries(Object.entries(row).map(([o, v]) => [o, Math.min(0.8, v + 0.03)]))])),
};
mkdirSync(path.join(SITE, "divisions"), { recursive: true });
writeFileSync(path.join(SITE, "divisions", "gold.json"), JSON.stringify(goldDiv));
writeFileSync(path.join(SITE, "data.json"), JSON.stringify({ ...data, divisions: { gold: { file: "divisions/gold.json", checked: goldDiv.checked } } }));
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", SITE], { stdio: "ignore" });
const browser = await chromium.launch();
const errors = [];
let lastPage = null; // per lo screenshot in caso di errore

async function newPage(ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "it-IT", ...ctxOpts });
  await ctx.route((url) => !url.href.startsWith(BASE), (r) => r.abort());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e) + (process.env.STACK ? `\n${e.stack}` : "")));
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
// testo come lo si legge, ma senza il MAIUSCOLO del CSS (titoli e nomi nell'aspetto «Tabellone» sono in maiuscolo)
const text = async (page, sel) => {
  await page.locator(sel).first().waitFor({ state: "attached" });
  return page.evaluate((s) => {
    const st = document.createElement("style");
    st.textContent = "* { text-transform: none !important }";
    document.head.append(st);
    const t = document.querySelector(s).innerText;
    st.remove();
    return t;
  }, sel);
};
// tacche della griglia (1–5, al posto delle stelline): {nome mostrato: {n, shown, cls, color, role}}
const starsOf = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#grid .hero")].map((b) => {
  const st = b.querySelector(".stars");
  const cs = st && getComputedStyle(st);
  return [b.querySelector(".nm").textContent, { n: Number(b.dataset.stars), shown: st ? st.querySelectorAll("i.on").length : 0,
    cls: st?.className ?? "", color: cs?.color, role: b.closest("[data-block]")?.dataset.block }];
})));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// tessera di un eroe nella griglia: una scheda di ruolo alla volta, quindi prima si apre la scheda del suo ruolo
const heroBtn = (page, name) => {
  const loc = page.locator("#grid .hero", { has: page.locator(".nm", { hasText: new RegExp(`^${esc(name)}$`) }) });
  const tab = async () => {
    const r = await loc.evaluate((b) => b.closest("[data-block]").dataset.block);
    const t = page.locator(`#role-tabs [data-tab="${r}"]`);
    if ((await t.getAttribute("aria-pressed")) !== "true") await t.click();
  };
  return { locator: loc, tab, click: async () => { await tab(); await loc.click(); },
    getAttribute: (a) => loc.getAttribute(a), evaluate: (f, a) => loc.evaluate(f, a), count: () => loc.count() };
};
// in cima alla pagina le fasce sono in vista
const toTop = async (page) => { await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(50); };
const nameOfId = (x) => (x ? itn(data.heroes.find((h) => String(h.id) === String(x))?.name ?? "") : null);
// eroe in evidenza in ogni fascia: quello preso (ritratto grande) o, se non ha scelto, quello proposto («PRENDI»)
const pickNames = async (page) => (await page.evaluate(() => window.owcBands())).map((b) => nameOfId(b.has ?? b.move) ?? "");
const CARD = "#picks .band"; // fasce pronte
const band = (page, k) => page.locator("#picks .band").nth(k);
// scelte proposte in una fascia prima della scelta: la mossa («PRENDI», evidenziata) e le 2 alternative
const favRows = (page, k) => band(page, k).evaluate((b) => {
  const rows = [];
  const stars = (x) => "★".repeat(Number(x.querySelector(".tac").dataset.stars));
  const go = b.querySelector(".move:not(.stay) .go");
  if (go) rows.push({ name: go.querySelector(".nm").textContent, stars: stars(go), rec: true, id: b.dataset.move, label: go.getAttribute("aria-label") });
  for (const a of b.querySelectorAll(".alts .alt")) rows.push({ name: a.querySelector(".nm").textContent, stars: stars(a), rec: false, id: a.dataset.id, label: a.getAttribute("aria-label") });
  return rows;
});
const heroId = (name) => String(data.heroes.find((h) => h.name === toEn(name)).id);
const matchState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("owc.match")));
// foglio del giocatore (tocco sul ritratto grande o sul posto vuoto della sua fascia; le compatte prima si aprono)
async function openPlayer(page, i) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const b = page.locator(`#picks .band[data-player="${i}"]`);
  if (await b.locator(".cmp").count()) await b.locator(".cmp").click();
  await page.locator(`#picks .band[data-player="${i}"] .has`).click();
  await page.locator("#choose-dialog[open]").waitFor();
}
// «l'eroe preso da X lo tocco nella griglia»: foglio del giocatore → «Un altro eroe: toccalo nella griglia»
async function pickFromGrid(page, i) {
  await openPlayer(page, i);
  await page.click("#choose-body .choose-grid");
  await page.locator("#pick-banner").waitFor();
}
// la scelta di un giocatore si annulla dal suo foglio: «Non l'ho preso»
async function unpick(page, i) {
  await openPlayer(page, i);
  await page.click("#menu-unpick");
}
// «Come giocarla» dell'eroe in evidenza nella fascia: quello preso (dal foglio) o quello proposto (striscia della mossa)
async function openGuideOf(page, k) {
  await toTop(page);
  const b = band(page, k);
  if (await b.getAttribute("data-has")) {
    await openPlayer(page, Number(await b.getAttribute("data-player")));
    await page.click("#menu-guide");
  } else await b.locator(".move .go").click();
  await page.locator("#guide-dialog[open]").waitFor();
}
// bersagli visibili della Partita sotto i 48 px di altezza (testata, fasce, selettore, posti, schede, griglia, barra)
const smallTargets = (page) => page.evaluate(() => [...document.querySelectorAll("#view-match button, #view-match input, .dock button")]
  .filter((e) => { const r = e.getBoundingClientRect(); return e.offsetParent && r.width > 0 && r.bottom > 0 && r.top < innerHeight; })
  .map((e) => [e.id || e.className, (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 24), Math.round(e.getBoundingClientRect().height)])
  .filter(([, , h]) => h < 48));
// ritratto grande di ogni fascia aperta: l'eroe preso (match.picked) o il posto vuoto, mai il consigliato
const portraitsOk = (page) => page.evaluate(() => {
  const m = JSON.parse(localStorage.getItem("owc.match"));
  const out = [];
  for (const b of document.querySelectorAll("#picks .band")) {
    const i = Number(b.dataset.player);
    const want = m.picked[i] ? String(m.picked[i]) : "";
    const f = b.querySelector(".has .hface, .cmp > .hface");
    const empty = f?.classList.contains("none");
    const ok = b.dataset.has === want && !!f && (want ? !empty && !!f.querySelector(".face") : empty)
      && (!want || b.dataset.move !== want);
    if (!ok) out.push({ i, want, has: b.dataset.has, move: b.dataset.move, empty });
  }
  return out;
});
// la Partita sta nello schermo senza scorrere?
const overflowY = (page) => page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
try {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  // ---------- primo avvio ----------
  const { ctx, page } = await newPage();
  lastPage = page;
  await page.goto(BASE);
  await page.locator(CARD).first().waitFor();
  await toTop(page);
  check("primo avvio: due fasce (Io e Lei)", (await page.locator(CARD).count()) === 2
    && (await text(page, "#picks")).includes("Io") && (await text(page, "#picks")).includes("Lei"));
  check("primo avvio: 53 eroi in griglia (una scheda di ruolo alla volta)", (await page.locator("#grid .hero").count()) === data.heroes.length
    && (await page.locator("#grid [data-block]:not([hidden])").count()) === 1);
  if (Object.keys(shownIt).length) {
    const gridNames = await page.locator("#grid .hero .nm").evaluateAll((xs) => xs.map((x) => x.textContent));
    check("nomi degli eroi come nel gioco in italiano (es. Soldato-76)", Object.values(shownIt).every((n) => gridNames.includes(n))
      && Object.keys(shownIt).every((n) => !gridNames.includes(n)), JSON.stringify(shownIt));
  }
  const initialsOk = await page.waitForFunction(() => [...document.querySelectorAll("#grid .face")].every((f) => f.querySelector("img") || f.textContent.trim()), null, { timeout: 10000 }).then(() => true, () => false);
  check("icone non raggiungibili: iniziali al loro posto", initialsOk);
  const fresh0 = await text(page, "#fresh-short");
  check("freschezza visibile in testata, in forma corta (accanto alla modalità)", await page.locator("#fresh-short").isVisible()
    && /^dati (di .+ fa|del \d+ \w+|controllati adesso)$/.test(fresh0) || (await page.locator("#warn").isVisible() && /dati/.test(await text(page, "#warn"))), fresh0);
  check("freschezza completa nel Profilo", /Dati counterwatch del .*controllati/.test(await page.locator("#fresh").textContent()), await page.locator("#fresh").textContent());
  const small0 = await smallTargets(page);
  check("bersagli tattili della Partita: tutti almeno 48 px di altezza", small0.length === 0, JSON.stringify(small0));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("niente scorrimento orizzontale", overflow <= 0, `overflow ${overflow}px`);
  check("prima della scelta: il ritratto grande è il posto vuoto (mai il consigliato)", (await portraitsOk(page)).length === 0, JSON.stringify(await portraitsOk(page)));
  await shot(page, "01-avvio");

  // ---------- profilo ----------
  await page.click(".tabs [data-view=profile]");
  await page.fill("#p0-name", "Fabio");
  await page.locator("#p0-name").press("Tab");
  await page.fill("#p1-name", "Giulia");
  await page.locator("#p1-name").press("Tab");
  await page.selectOption("#p0-rank", "Diamante");
  await page.selectOption("#p1-rank", "Oro");
  // Giulia: Supporto + Danni
  await page.locator("section.card").nth(1).locator(".toggle", { hasText: "Danni" }).click();
  await page.locator("section.card").nth(1).getByRole("button", { name: "Scegli preferiti" }).click();
  await page.locator("#fav-grid .hero", { has: page.locator(".nm", { hasText: /^Mercy$/ }) }).click();
  await page.locator("#fav-grid .hero", { has: page.locator(".nm", { hasText: /^Juno$/ }) }).click();
  await shot(page, "02-preferiti");
  await page.click("#fav-dialog [data-close]");
  const favOk = await page.waitForFunction(() => document.querySelectorAll("section.card")[1].textContent.includes("Eroi preferiti (2)"), null, { timeout: 5000 }).then(() => true, () => false);
  check("profilo: preferiti salvati", favOk, await page.locator("section.card").nth(1).textContent());
  await shot(page, "03-profilo");
  await page.click(".tabs [data-view=match]");
  await toTop(page);
  check("profilo: nomi nelle fasce", (await text(page, "#picks")).includes("Fabio") && (await text(page, "#picks")).includes("Giulia"));

  // ---------- inizio partita: mappa, lato, ban ----------
  await page.click("#map-btn");
  await shot(page, "04-mappe");
  await page.locator("#map-list .map-opt", { hasText: "King's Row" }).click();
  check("mappa scelta e finestra chiusa", (await text(page, "#map-name")).includes("King's Row")
    && !(await page.locator("#map-dialog").evaluate((d) => d.open)));
  check("testata: modalità e freschezza dei dati (niente elenco dei ban)", /^Ibrida$/.test(await text(page, "#map-sub"))
    && !/ban/.test(await text(page, ".map-sub")), await text(page, ".map-sub"));
  check("Hybrid: attacco/difesa visibile", await page.locator("#side").isVisible());
  await page.click("#side [data-side=defense]");
  check("difesa selezionata", (await page.getAttribute("#side [data-side=defense]", "aria-pressed")) === "true");
  // ban consigliati per la mappa: «BAN?» nella griglia, solo con il selettore su «Ban»; 3 per ruolo (anche i preferiti, mai gli eroi già scelti)
  const suggNames = () => page.locator("#grid .hero.sugg .nm").evaluateAll((xs) => xs.map((x) => x.textContent));
  check("ban consigliati: nascosti fuori dalla sezione «Ban»", (await matchState(page)).group !== "bans" && (await page.locator("#grid .hero.sugg").count()) === 0);
  await page.click("#groups [data-group=bans]");
  const brNames = await suggNames();
  const br = { heroes: brNames, legend: await text(page, "#legend").catch(() => "") };
  const roleOf = (n) => data.heroes.find((h) => h.name === toEn(n))?.role;
  check("mappa scelta, sezione «Ban»: «BAN?» su 3 eroi per ruolo, con la legenda", await page.locator("#legend").isVisible()
    && /quanto conviene bannarlo/.test(br.legend) && /BAN\? = consigliato/.test(br.legend)
    && br.heroes.length === 9 && ["Tank", "Damage", "Support"].every((r) => br.heroes.filter((n) => roleOf(n) === r).length === 3), JSON.stringify(br));
  check("ban consigliati: si vedono nella scheda aperta (Tank), con la bandierina «BAN?»", await page.locator("#grid .hero.sugg").first().isVisible()
    && await page.locator("#grid .hero.sugg").first().evaluate((b) => getComputedStyle(b, "::after").content.includes("BAN?")));
  // i preferiti si possono proporre: con «solo statistiche» su King's Row i ban sono i più forti del ruolo, preferiti o no
  const strongest = (role) => data.heroes.filter((h) => h.role === role).map((h) => [itn(h.name), (data.maps.find((m) => m.slug === "kings-row").winRates[String(h.id)] ?? data.overall[String(h.id)])])
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
  check("ban consigliati: nessuno ha scelto → solo la mappa (anche i preferiti, se sono tra i più forti)",
    ["Tank", "Damage", "Support"].every((r) => strongest(r).every((n) => br.heroes.includes(n))), br.heroes.join());
  // cambia il consiglio di Fabio (altro ruolo): i ban non cambiano, perché non ha ancora scelto
  await band(page, 0).locator(".role-btn").click();
  const brTank = await suggNames();
  while ((await band(page, 0).locator(".role-btn").textContent()) !== "Danni") await band(page, 0).locator(".role-btn").click();
  check("ban consigliati: non dipendono dai consigli di chi non ha scelto", brTank.join() === br.heroes.join(), `${br.heroes.join()} → ${brTank.join()}`);
  await shot(page, "04b-ban-consigliati");
  await heroBtn(page, br.heroes[0]).click();
  await toTop(page);
  check("ban consigliato: un tocco lo segna (contato, barrato, nei posti, fuori dai consigli)", (await text(page, "[data-count=bans]")) === "1/5"
    && (await heroBtn(page, br.heroes[0]).getAttribute("aria-pressed")) === "true"
    && (await heroBtn(page, br.heroes[0]).evaluate((b) => b.classList.contains("in-bans")))
    && (await page.locator(`#slots .slot.full[data-id="${heroId(br.heroes[0])}"]`).count()) === 1
    && !(await pickNames(page)).includes(br.heroes[0]));
  check("ban consigliati: l'elenco resta lo stesso mentre si segnano", (await suggNames()).join() === br.heroes.join());
  await heroBtn(page, br.heroes[0]).click();
  check("ban consigliato ritoccato: tolto", (await text(page, "[data-count=bans]")) === "0/5");
  await heroBtn(page, "Ana").click();
  await heroBtn(page, "Kiriko").click();
  check("2 ban contati (2/5) e nei posti «Ban»", (await text(page, "[data-count=bans]")) === "2/5" && (await page.locator("#slots .slot.full").count()) === 2
    && (await page.locator("#slots .slot.empty").count()) === 3);
  await page.locator(`#slots .slot.full[data-id="${heroId("Kiriko")}"]`).click();
  check("posto pieno: un tocco lo toglie", (await text(page, "[data-count=bans]")) === "1/5");
  await heroBtn(page, "Kiriko").click();
  const sb = await starsOf(page);
  const sbv = Object.values(sb);
  check("tacche Ban: bianche, da 1 a 5 su tutta la griglia", sbv.every((x) => x.n >= 1 && x.n <= 5
    && x.cls.includes("st-bans") && x.color === "rgb(255, 255, 255)") && sbv.some((x) => x.n === 5), JSON.stringify(sbv.find((x) => x.n !== 5)));
  const roleTop = (role) => Math.max(...Object.entries(sb).filter(([n]) => roleOf(n) === role && !br.heroes.includes(n)).map(([, x]) => x.n));
  check("tacche Ban: i ban consigliati hanno almeno tante tacche quanto gli altri del ruolo",
    br.heroes.every((n) => sb[n].n >= roleTop(roleOf(n))), br.heroes.map((n) => `${n}:${sb[n]?.n}`).join());
  await shot(page, "04c-stelline-ban");
  check("tacche: mai un eroe senza tacche, numero e tacche accese coincidono (1–5)", sbv.every((x) => x.n >= 1 && x.n <= 5 && x.shown === x.n));
  await toTop(page);
  const afterBans = await pickNames(page);
  check("consigli senza eroi bannati", !afterBans.includes("Ana") && !afterBans.includes("Kiriko"), afterBans.join());
  check("consigli: Fabio e Giulia hanno eroi diversi", afterBans[0] !== afterBans[1], afterBans.join());
  const cardNums = await page.locator(CARD).evaluateAll((cs) => cs.map((c) => (c.textContent.match(/\d+%/g) ?? []).length));
  check("prima degli avversari: un solo numero per fascia (la stima del proposto)", cardNums.every((k) => k === 1), JSON.stringify(cardNums));
  // prima della scelta: la mossa «PRENDI» (evidenziata) e 2 alternative; nessun eroe «scelto»
  const lists0 = [await favRows(page, 0), await favRows(page, 1)];
  check("prima della scelta: «PRENDI» con il consigliato e al massimo 2 alternative, nessun eroe «scelto»",
    lists0.every((l) => l.length >= 1 && l.length <= 3 && l[0].rec && l.slice(1).every((r) => !r.rec))
    && (await page.evaluate(() => window.owcBands().every((b) => !b.has))) && (await page.locator("#picks .move .verb").allTextContents()).every((t) => t === "Prendi"),
    JSON.stringify(lists0));
  // «Suggerisci solo eroi preferiti» spento (predefinito): i più adatti del ruolo tra TUTTI gli eroi, i preferiti segnati nel foglio
  const favs0 = ["Mercy", "Juno"];
  await openPlayer(page, 1);
  const sheet0 = await page.locator("#choose-body .fav-row").evaluateAll((rs) => rs.map((r) => [r.querySelector(".fr-name").textContent, r.querySelector(".fr-note")?.textContent ?? ""]));
  const sub0 = await text(page, "#choose-body .choose-sub");
  await page.click("#choose-dialog [data-close]");
  check("interruttore «solo preferiti» spento: i più adatti tra tutti gli eroi, non solo i preferiti",
    /tra tutti gli eroi/.test(sub0) && sheet0.some(([n]) => !favs0.includes(n)) && lists0[1].some((r) => !favs0.includes(r.name)), JSON.stringify({ sub0, sheet0 }));
  check("interruttore spento: i preferiti nel foglio sono segnati «Preferito»", sheet0.every(([n, note]) => !favs0.includes(n) || /Preferito/.test(note))
    && sheet0.some(([n]) => favs0.includes(n)), JSON.stringify(sheet0));
  const giuliaBest = await favRows(page, 1);
  check("interruttore spento: le alternative di Giulia in ordine di adattezza (tacche non crescenti)",
    giuliaBest.slice(1).every((r, k, xs) => !k || r.stars.length <= xs[k - 1].stars.length), giuliaBest.map((r) => r.name).join());
  check("fasce: tacche da 1 a 5, accese quante dice il valore", await page.locator("#picks .tac").evaluateAll((xs) => xs.length > 0 && xs.every((x) => {
    const n = Number(x.dataset.stars);
    return n >= 1 && n <= 5 && x.querySelectorAll("i.on").length === n && x.querySelectorAll("i").length === 5;
  })));
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "05-inizio-partita");

  // ---------- durante: avversari e alleati ----------
  await page.click("#groups [data-group=enemies]");
  const se = await starsOf(page);
  const sev = Object.values(se);
  check("tacche Avversari: rosse, da 1 a 5 su ogni eroe (anche i bannati)", sev.every((x) => x.n >= 1 && x.n <= 5
    && x.cls.includes("st-enemies") && x.color === "rgb(236, 74, 80)") && se.Ana.n >= 1 && se.Kiriko.n >= 1, JSON.stringify(sev.find((x) => !x.n)));
  check("tacche Avversari: almeno 4 in ogni ruolo e qualcuno a 1",
    ["tank", "damage", "support"].every((r) => sev.some((x) => x.n >= 4 && (x.role ?? "").toLowerCase().startsWith(r))) && sev.some((x) => x.n <= 2),
    JSON.stringify(sev.map((x) => `${x.role}:${x.n}`)));
  await page.click("#side [data-side=attack]");
  const se2 = await starsOf(page);
  await page.click("#side [data-side=defense]");
  check("tacche Avversari: cambiano col lato (il loro è l'opposto del vostro)", Object.keys(se).some((n) => se[n].n !== se2[n].n));
  await page.click("#map-btn");
  await page.locator("#map-list .map-opt", { hasText: ILIOS }).click();
  const se3 = await starsOf(page);
  await page.click("#map-btn");
  await page.locator("#map-list .map-opt", { hasText: "King's Row" }).click();
  await page.click("#side [data-side=defense]");
  check("tacche Avversari: cambiano con la mappa", Object.keys(se).filter((n) => se[n].n !== se3[n].n).length >= 5);
  await shot(page, "05d-stelline-avversari");
  // posti per ruolo: T D D S S; la scheda iniziale è quella del primo posto vuoto
  check("Avversari: 5 posti T D D S S, il primo vuoto evidenziato, scheda Tank aperta",
    (await page.locator("#slots .slot.empty").evaluateAll((s) => s.map((x) => x.dataset.role).join())) === "Tank,Damage,Damage,Support,Support"
    && (await page.locator("#slots .slot.target").getAttribute("data-role")) === "Tank"
    && (await page.locator("#role-tabs .tab[aria-pressed=true]").getAttribute("data-tab")) === "Tank");
  await page.locator("#slots .slot.empty[data-role=Support]").first().click();
  check("posto vuoto: un tocco apre la scheda di quel ruolo", (await page.locator("#role-tabs .tab[aria-pressed=true]").getAttribute("data-tab")) === "Support"
    && await page.locator("#grid [data-block=Support]").isVisible() && await page.locator("#grid [data-block=Tank]").isHidden());
  for (const n of ["Pharah", "Winston", "Reinhardt"]) await heroBtn(page, n).click();
  check("3 avversari contati (3/5), nei posti del loro ruolo", (await text(page, "[data-count=enemies]")) === "3/5"
    && (await page.locator("#slots .slot.full").count()) === 3 && (await text(page, "#role-tabs [data-tab=Tank]")).includes("2/1"));
  check("sezione «Avversari»: niente «BAN?»", (await page.locator("#grid .hero.sugg").count()) === 0);
  check("«Chi soffrite di più» (nomi rossi): nascosto finché nessuno ha scelto e non ci sono alleati",
    (await page.locator("#grid .hero.top3").count()) === 0 && await page.locator("#legend").isHidden());
  await page.click("#groups [data-group=bans]");
  check("…i «BAN?» tornano toccando «Ban»", (await page.locator("#grid .hero.sugg").count()) === 9 && (await page.locator("#grid .hero.top3").count()) === 0);
  await page.click("#groups [data-group=enemies]");
  await toTop(page);
  const ENEMIES = ["Pharah", "Winston", "Reinhardt"];
  // nomi dopo «batte»/«teme» nelle frasi a parole (al massimo 2, «A e B»)
  const vsNames = (t) => [...t.matchAll(/(?:batte|teme) (.+?)(?=;|·|,|$)/g)].flatMap((g) => g[1].split(/ e /).map((x) => x.trim()));
  const whys = await page.locator("#picks .why:not(.warn-note)").allTextContents();
  const heads = await pickNames(page);
  check("con avversari: la riga del motivo dice a parole chi batte e chi teme, solo tra gli avversari segnati",
    whys.length >= 1 && whys.every((t) => vsNames(t).length && vsNames(t).every((n) => ENEMIES.includes(n))), JSON.stringify(whys));
  const subj = await page.locator("#picks .band").evaluateAll((bs) => bs.map((b) => {
    const w = (b.querySelector(".why:not(.warn-note)")?.textContent ?? "").replace(/^(Dati|Teoria): /, "");
    const names = [b.querySelector(".cur"), b.querySelector(".move .nm")].filter(Boolean).map((x) => x.textContent);
    return { w, names, ok: !w || names.some((n) => w.startsWith(`${n} `)) };
  }));
  check("riga del motivo: mai senza soggetto (comincia col nome dell'eroe di cui parla)", subj.every((x) => x.ok), JSON.stringify(subj));
  check("riga del motivo: dati ■ o teoria ▨ distinti per forma", await page.locator("#picks .why .mk").evaluateAll((ms) => ms.length > 0
    && ms.every((m) => m.classList.contains("data") || m.classList.contains("theory"))));
  const nums2 = await page.locator(CARD).evaluateAll((cs) => cs.map((c) => (c.textContent.match(/\d+%/g) ?? []).length));
  check("con avversari: sempre un solo numero per fascia (i dettagli sono a un tocco)", nums2.every((k) => k === 1), JSON.stringify(nums2));
  check("il proposto ha «Come giocarla» anche prima di sceglierlo (tocco sulla striscia)", (await page.locator("#picks .move .go").count()) === 2
    && (await page.locator("#picks .move .go").first().getAttribute("aria-label")).includes("come giocarla"));
  const order = await favRows(page, 1);
  check("alternative ordinate dalla più adatta (tacche non crescenti)", order.slice(1).every((r, k, xs) => !k || r.stars.length <= xs[k - 1].stars.length),
    JSON.stringify(order.map((r) => `${r.name}:${r.stars}`)));
  await shot(page, "05e-lista-preferiti");

  // «✓ PRESO» sulla striscia = scelto → la fascia mostra quell'eroe nel ritratto grande
  const recF = (await favRows(page, 0))[0].name;
  const recStars = (await favRows(page, 0))[0].stars;
  await band(page, 0).locator(".move .done").click();
  await toTop(page);
  const chosenSt = await band(page, 0).locator(".curmeta .tac").getAttribute("data-stars").catch(() => null);
  check("eroe scelto: tacche (1–5) sotto il nome, le stesse della striscia", chosenSt && "★".repeat(Number(chosenSt)) === recStars, `${chosenSt} / ${recStars}`);
  const swapSt = await page.locator("#picks .band.took .move .tac").evaluateAll((xs) => xs.map((x) => x.dataset.stars));
  check("«Passa a» / «Resta su»: con le tacche (1–5) come ogni altro eroe", swapSt.length === (await page.locator("#picks .band.took .move").count())
    && swapSt.every((t) => /^[1-5]$/.test(t)), JSON.stringify(swapSt));
  check("un tocco su «✓ PRESO»: scelto, ritratto grande e nome dell'eroe preso («ha scelto»)",
    (await band(page, 0).locator(".cur").textContent()) === recF && (await band(page, 0).getAttribute("data-has")) === heroId(recF)
    && /ha scelto/.test(await band(page, 0).locator(".who").textContent())
    && String((await matchState(page)).picked[0]) === heroId(recF) && (await text(page, "#toast")).includes("ha scelto"), recF);
  check("dopo la scelta: ritratto grande = eroe preso; il consigliato solo nella striscia", (await portraitsOk(page)).length === 0, JSON.stringify(await portraitsOk(page)));
  const mv0 = await band(page, 0).evaluate((b) => ({ verb: b.querySelector(".move .verb")?.textContent, move: b.dataset.move, has: b.dataset.has,
    big: b.querySelector(".has .hface img")?.src ?? "", stay: !!b.querySelector(".move.stay") }));
  check("dopo la scelta: striscia «Passa a» (con ✓ CAMBIATO) o «Resta su» (senza pulsante)",
    (mv0.stay && mv0.verb === "Resta su" && !mv0.move && !(await band(page, 0).locator(".move .done").count()))
    || (mv0.verb === "Passa a" && mv0.move && mv0.move !== mv0.has && (await band(page, 0).locator(".move .done").textContent()).includes("Cambiato")), JSON.stringify(mv0));
  // «Chi soffrite di più» (nomi rossi + legenda): con un eroe scelto compare (solo su «Avversari»), 3 per ruolo, mai i bannati
  const th = await page.locator("#grid .hero.top3").evaluateAll((bs) => bs.map((b) => ({
    name: b.querySelector(".nm").textContent, n: Number(b.dataset.stars), color: getComputedStyle(b.querySelector(".nm")).color })));
  const gridSt = await starsOf(page);
  check("«Chi soffrite di più»: con un eroe scelto i 3 per ruolo hanno il nome rosso, tacche rosse come la griglia, senza bannati",
    await page.locator("#legend").isVisible() && /quanto è pericoloso/.test(await text(page, "#legend")) && th.length === 9
    && ["Tank", "Damage", "Support"].every((r) => th.filter((t) => roleOf(t.name) === r).length === 3)
    && th.every((t) => t.color === "rgb(236, 74, 80)" && gridSt[t.name]?.n === t.n && !["Ana", "Kiriko"].includes(t.name)), JSON.stringify(th));
  check("«Chi soffrite di più»: i più pericolosi del ruolo (nessuno fuori elenco ha più tacche)", th.every((t) =>
    Object.entries(gridSt).every(([n, x]) => roleOf(n) !== roleOf(t.name) || ["Ana", "Kiriko"].includes(n) || th.some((u) => u.name === n) || x.n <= t.n)));
  await shot(page, "05h-chi-soffrite");
  await page.click("#groups [data-group=bans]");
  check("«Chi soffrite di più»: solo nella sezione «Avversari»", (await page.locator("#grid .hero.top3").count()) === 0 && (await page.locator("#grid .hero.sugg").count()) === 9);
  await page.click("#groups [data-group=enemies]");
  // foglio del giocatore (tocco sul ritratto grande): Come giocarla, Non l'ho preso, «Scegline un altro»
  await openPlayer(page, 0);
  const sheet = await page.locator("#choose-body .fav-row").evaluateAll((rs) => rs.map((r) => ({ name: r.querySelector(".fr-name").textContent,
    n: Number(r.querySelector(".fr-stars").dataset.stars), tag: r.querySelector(".fr-tag")?.textContent ?? "", mu: r.querySelector(".fr-mu")?.textContent ?? "" })));
  check("foglio del giocatore: «Come giocarla», «Non l'ho preso» e «Scegline un altro» con l'eroe preso segnato «Scelto»",
    await page.locator("#menu-guide").isVisible() && await page.locator("#menu-unpick").isVisible() && /Scegline un altro/.test(await text(page, "#choose-body"))
    && sheet.filter((r) => r.tag === "Scelto").map((r) => r.name).join() === recF, JSON.stringify(sheet));
  check("foglio: ogni eroe con le tacche (1–5) e chi batte/teme a parole, solo tra gli avversari segnati", sheet.length >= 3
    && sheet.every((r) => r.n >= 1 && r.n <= 5 && vsNames(r.mu).every((n) => ENEMIES.includes(n))) && sheet.some((r) => r.mu)
    && (await page.locator("#choose-body .choose-grid").isVisible()), JSON.stringify(sheet));
  await shot(page, "05g-foglio-preferiti");
  const other = sheet.find((r) => r.name !== recF).name;
  await page.locator("#choose-body .fav-row", { has: page.locator(".fr-name", { hasText: new RegExp(`^${esc(other)}$`) }) }).click();
  await toTop(page);
  check("«Scegline un altro»: un tocco sceglie quell'eroe e chiude il foglio", !(await page.locator("#choose-dialog").evaluate((d) => d.open))
    && (await band(page, 0).locator(".cur").textContent()) === other && String((await matchState(page)).picked[0]) === heroId(other), other);
  await shot(page, "05f-scelto");
  await unpick(page, 0);
  await toTop(page);
  check("«Non l'ho preso»: torna «PRENDI» e il posto vuoto, niente scelto", (await matchState(page)).picked[0] === null
    && !(await band(page, 0).getAttribute("data-has")) && (await band(page, 0).locator(".move .verb").textContent()) === "Prendi" && (await portraitsOk(page)).length === 0);
  check("«Chi soffrite di più»: sparisce di nuovo senza eroi scelti né alleati", (await page.locator("#grid .hero.top3").count()) === 0);
  // «Come giocarla» del proposto, poi «Perché»
  const altName = (await favRows(page, 0))[0].name;
  await band(page, 0).locator(".move .go").click();
  await page.locator("#guide-dialog[open]").waitFor();
  check("«Come giocarla» del proposto (prima della scelta)", (await text(page, "#t-guide")).includes(altName), await text(page, "#t-guide"));
  await page.click("#guide-body .why-btn");
  await page.locator("#why-dialog[open]").waitFor();
  const det = await text(page, "#why-body");
  check("«Perché»: riepilogo mappa e comp avversaria (i numeri tolti dalla fascia)", /Mappa [+−]\d/.test(det) && /Avversari [+−]\d/.test(det), det.slice(0, 300));
  check("tocco su un consiglio: dettaglio per ogni avversario", ["contro Pharah", "contro Winston", "contro Reinhardt", "King's Row"].every((t) => det.includes(t)), det);
  await shot(page, "05b-perche");
  check("scheda eroe di Fabio (senza rank): dati Ranked di tutte le divisioni", det.includes("Ranked, tutte le divisioni"), det);
  for (const t of ["Forte contro", "In difficoltà contro", "Mappe migliori", "Funziona bene con"]) {
    check(`scheda eroe: sezione «${t}» con eroi/mappe e percentuali`, await page.locator(".prof-sec", { hasText: t }).locator("li").count() > 0);
  }
  const firstList = await page.locator("#why-body .prof-sec").first().locator("li").count();
  const innerScroll = await page.evaluate(() => [...document.querySelectorAll("#why-body *")]
    .filter((x) => ["auto", "scroll"].includes(getComputedStyle(x).overflowY) && x.scrollHeight > x.clientHeight + 1).length);
  check("statistiche nella scheda: lista completa (più di 5) e nessuno scroll interno ai riquadri", firstList > 5 && innerScroll === 0,
    `${firstList} voci, ${innerScroll} riquadri con scroll interno`);
  check("teoria nella scheda: stile Rush/Dive/Poke e tre riquadri «Teoria»", (await page.locator("#why-body .theory-style").count()) === 1
    && (await page.locator("#why-body .theory-sec").count()) >= 3
    && (await page.locator("#why-body .theory-sec .theory-badge").count()) === (await page.locator("#why-body .theory-sec").count())
    && (await page.locator("#why-body .theory-sec", { hasText: "Sinergizza con" }).count()) === 1);
  check("riquadri teoria a righe (▨), distinti dalle statistiche (■) per forma", await page.evaluate(() => {
    const a = getComputedStyle(document.querySelector("#why-body .theory-sec")).borderImageSource;
    const b = getComputedStyle(document.querySelector("#why-body .prof-sec:not(.theory-sec)")).borderImageSource;
    const badge = getComputedStyle(document.querySelector("#why-body .theory-badge"), "::before").backgroundImage;
    return /repeating-linear-gradient/.test(a) && !/gradient/.test(b) && /repeating-linear-gradient/.test(badge);
  }));
  await page.locator("#why-body .theory-sec").first().scrollIntoViewIfNeeded();
  await shot(page, "05d-teoria");
  await page.click("#why-body .guide-btn");
  await page.locator("#guide-dialog[open]").waitFor();
  const guideShort = await text(page, "#guide-body");
  const briefRows = await page.locator("#guide-body .brief-row").count();
  check("come giocarla: in testa «In breve» (al massimo 7 righe), il resto chiuso", briefRows >= 3 && briefRows <= 7
    && (await page.locator("#guide-body .guide-more").evaluate((d) => d.hidden)) && !guideShort.includes("Come muoverti")
    && !(await page.locator("#why-dialog").evaluate((d) => d.open)), `${briefRows} righe`);
  check("come giocarla: i bersagli con i volti", (await page.locator("#guide-body .brief-row.k-target .hchip").count()) >= 1);
  const threatTxt = await page.locator("#guide-body .brief-row.k-threat").allTextContents();
  check("in breve: «Attento» dice anche cosa fare (a chi lasciarlo o evitare l'1 contro 1)",
    threatTxt.length === 0 || threatTxt.every((t) => /lascia .+ a |evita l'1 contro 1/.test(t)), threatTxt.join(" | "));
  await shot(page, "05e-come-giocarla");
  check("come giocarla: legenda teoria/dati a parole accanto a «In breve»", /teoria/.test(await text(page, "#guide-body .guide-summary h3"))
    && /dati/.test(await text(page, "#guide-body .guide-summary h3")));
  await page.click("#guide-body .more-btn");
  const guide = await text(page, "#guide-body");
  const guideHero = toEn((await text(page, "#t-guide")).replace(/^Come giocare /, ""));
  const itAbilities = Object.values(namesFile.abilities?.[guideHero] ?? {});
  if (itAbilities.length) check("come giocarla: abilità col nome italiano del gioco", itAbilities.some((n) => guide.includes(n)), `${guideHero}: ${itAbilities.join(", ")}`);
  check("come giocarla: «Tutti i consigli» apre le sezioni (mappa, lato, come muoverti)",
    guide.includes("Mappa: King's Row") && guide.includes("Come muoverti")
    && (await page.locator("#guide-body .guide-sec").count()) >= 3 && (await page.locator("#guide-body .theory-badge").count()) > 0, guide.slice(0, 400));

  check("schede senza testi «null»/«undefined»", !/\b(null|undefined|NaN)\b/.test(guide + det), (guide + det).match(/.{0,40}\b(null|undefined|NaN)\b.{0,20}/)?.[0]);
  await page.click("#guide-dialog [data-close]");
  await toTop(page);
  // dettaglio di un eroe: fascia → Come giocarla → Perché
  const openWhy = async (k) => {
    await openGuideOf(page, k);
    await page.click("#guide-body .why-btn");
    await page.locator("#why-dialog[open]").waitFor();
    return text(page, "#why-body");
  };
  const closeAll = async () => {
    for (const d of ["#why-dialog", "#guide-dialog"]) if (await page.locator(d).evaluate((x) => x.open)) await page.click(`${d} [data-close]`);
  };
  const detG = await openWhy(1);
  check("scheda eroe di Giulia (rank Oro): usa i dati della divisione", detG.includes("dati: Ranked Oro"), detG);
  await page.evaluate(() => document.querySelector("#why-body").scrollIntoView());
  await shot(page, "05c-scheda-eroe");
  await closeAll();
  const sumF = await openWhy(0).then(() => text(page, "#why-body .why-sum"));
  await closeAll();
  const cardsTxt0 = await page.locator(CARD).allTextContents();
  check("nessuno ha scelto: i consigli non dipendono dal compagno (niente «Con Giulia», niente «Bene con …»)",
    !/Alleati [+−]/.test(sumF) && !/Con Giulia/.test(sumF) && cardsTxt0.every((t) => !/Bene con (Fabio|Giulia)/.test(t)), sumF);
  // Giulia sceglie: da lì il suo eroe conta per Fabio («Con Giulia» nei perché)
  await toTop(page);
  const recG = (await favRows(page, 1))[0].name;
  await band(page, 1).locator(".move .done").click();
  const sumF2 = await openWhy(0).then(() => text(page, "#why-body .why-sum"));
  await closeAll();
  check("dopo la scelta di Giulia: la sinergia con il suo eroe è «Con Giulia»", /Con Giulia [+−]/.test(sumF2), `${recG}: ${sumF2}`);
  await unpick(page, 1);
  await page.click("#groups [data-group=allies]");
  const sa = Object.values(await starsOf(page));
  check("tacche Alleati: azzurre da 1 a 5 (buona scelta per voi)", sa.some((x) => x.n === 5)
    && sa.every((x) => x.n >= 1 && x.n <= 5 && x.cls.includes("st-allies") && x.color === "rgb(79, 193, 233)"), JSON.stringify(sa.find((x) => !x.n)));
  check("Alleati: posti che restano dopo i due giocatori (Tank, Danni, Supporto)",
    (await page.locator("#slots .slot.empty").evaluateAll((s) => s.map((x) => x.dataset.role).join())) === "Tank,Damage,Support"
    && (await text(page, "[data-count=allies]")) === "0/3");
  await heroBtn(page, "Lúcio").click();
  await toTop(page);
  const sumA = await openWhy(0).then(() => text(page, "#why-body .why-sum"));
  await closeAll();
  check("con alleati: riga Alleati nei perché", /Alleati [+−]\d/.test(sumA), sumA);
  await toTop(page);
  const picks = await pickNames(page);
  check("alleato non consigliato", !picks.includes("Lúcio"), picks.join());
  await page.click("#groups [data-group=enemies]");
  for (const n of ["Genji", "Mercy", "Tracer"]) await heroBtn(page, n).click();
  check("max 5 avversari, avviso chiaro", (await text(page, "[data-count=enemies]")) === "5/5"
    && (await text(page, "#toast")).includes("Al massimo 5"));
  // un avversario toccato tra gli Alleati: lo hanno tutte e due le squadre (mirror, regola di Overwatch 2)
  await page.click("#groups [data-group=allies]");
  await heroBtn(page, "Mercy").click();
  check("avversario toccato tra gli Alleati: in tutte e due le squadre (mirror)", (await text(page, "[data-count=enemies]")) === "5/5"
    && (await text(page, "[data-count=allies]")) === "2/3");
  // ruolo cambiato al volo
  await toTop(page);
  const fabioBefore = (await pickNames(page))[0];
  await band(page, 1).locator(".role-btn").click();
  await toTop(page);
  check("ruolo di Giulia cambiato al volo (Supporto → Danni)", (await band(page, 1).locator(".role-btn").textContent()) === "Danni");
  const duo = await pickNames(page);
  const role = (n) => data.heroes.find((h) => h.name === toEn(n))?.role;
  check("con lo stesso ruolo eroi diversi", duo[0] !== duo[1] && role(duo[0]) === "Damage" && role(duo[1]) === "Damage", duo.join());
  check("il consiglio di Fabio non cambia per il ruolo di Giulia (salvo che serva un eroe diverso)", duo[0] === fabioBefore || duo[1] === fabioBefore,
    `${fabioBefore} → ${duo.join()}`);
  await band(page, 1).locator(".role-btn").click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "06-durante-partita");

  // ---------- solo preferiti ----------
  await page.click(".tabs [data-view=profile]");
  await page.getByRole("button", { name: /Suggerisci solo eroi preferiti/ }).click();
  await page.click(".tabs [data-view=match]");
  await toTop(page);
  const giulia = (await favRows(page, 1)).map((r) => r.name);
  check("solo preferiti: Giulia vede solo Mercy/Juno (Mercy è alleata → solo Juno)", giulia.join() === "Juno", giulia.join());
  await openPlayer(page, 1);
  const subFav = await text(page, "#choose-body .choose-sub");
  await page.click("#choose-dialog [data-close]");
  check("solo preferiti acceso: nel foglio di Giulia «I tuoi preferiti, dal più adatto»", /I tuoi preferiti, dal più adatto/.test(subFav), subFav);
  await toTop(page);
  const fabio = await text(page, "#picks .band:nth-child(1)");
  check("solo preferiti: Fabio senza preferiti → i più adatti, con avviso", fabio.includes("nessun preferito disponibile")
    && (await favRows(page, 0)).length >= 2, fabio);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "06b-solo-preferiti");
  // Giulia ha preso un eroe non preferito: «Passa a» (fascia e guida) propone solo preferiti
  await pickFromGrid(page, 1);
  const sp = Object.values(await starsOf(page));
  check("tacche durante la scelta dell'eroe di Giulia: col suo colore, da 1 a 5", sp.some((x) => x.n === 5)
    && sp.every((x) => x.n >= 1 && x.n <= 5 && x.cls.includes("st-picked") && x.color === "rgb(255, 111, 207)"), JSON.stringify(sp.find((x) => !x.n)));
  check("«Tocca l'eroe preso da Giulia»: la scheda aperta è quella del suo ruolo (Supporto)",
    (await page.locator("#role-tabs .tab[aria-pressed=true]").getAttribute("data-tab")) === "Support");
  await shot(page, "06c-stelline-scelta");
  await heroBtn(page, "Brigitte").click();
  await toTop(page);
  const swapCard = await band(page, 1).evaluate((b) => (b.dataset.move ? [b.querySelector(".move .nm").textContent] : []));
  await openGuideOf(page, 1);
  const swapGuide = await page.locator("#guide-body .brief-row.k-swap .hchip").evaluateAll((cs) => cs.map((c) => c.lastChild.textContent));
  await page.click("#guide-dialog [data-close]");
  check("solo preferiti: dopo la scelta «Passa a» propone solo preferiti (Juno)", [...swapCard, ...swapGuide].every((n) => n.trim() === "Juno")
    && swapCard.length === 1 && swapGuide.length === 1,
    `fascia ${swapCard.join()} · guida ${swapGuide.join()}`);
  check("con «Passa a»: il ritratto grande resta Brigitte (l'eroe preso), Juno solo nella striscia",
    (await band(page, 1).getAttribute("data-has")) === heroId("Brigitte") && (await portraitsOk(page)).length === 0);
  await unpick(page, 1); // scelta tolta: il resto del collaudo come prima
  await page.click(".tabs [data-view=profile]");
  await page.getByRole("button", { name: /Suggerisci solo eroi preferiti/ }).click();
  await page.click(".tabs [data-view=match]");

  // Control: niente lato
  await page.click("#map-btn");
  await page.locator("#map-list .map-opt", { hasText: ILIOS }).click();
  check("Control: attacco/difesa nascosto", !(await page.locator("#side").isVisible()));

  // ---------- memoria e nuova partita ----------
  await page.reload();
  await page.locator(CARD).first().waitFor();
  check("dopo ricarica: partita e profilo ricordati", (await text(page, "[data-count=enemies]")) === "5/5"
    && (await text(page, "#picks")).includes("Giulia") && (await text(page, "#map-name")).includes(ILIOS));
  await page.click("#new-match");
  check("nuova partita: azzera tutto tranne il profilo", (await text(page, "[data-count=enemies]")) === "0/5"
    && (await text(page, "[data-count=bans]")) === "0/5" && (await text(page, "#map-name")).includes("Scegli mappa")
    && (await text(page, "#picks")).includes("Giulia"));
  check("messaggi in alto, sotto la testata (mai sopra il selettore)", await page.evaluate(() => {
    const t = document.querySelector("#toast").getBoundingClientRect();
    return t.top >= document.querySelector(".head").getBoundingClientRect().bottom - 1 && t.bottom < document.querySelector("#groups").getBoundingClientRect().top;
  }));
  await page.click("#toast .toast-btn");
  check("nuova partita: «Annulla» nel messaggio ripristina la partita", (await text(page, "[data-count=enemies]")) === "5/5"
    && (await text(page, "#map-name")).includes(ILIOS));
  await page.click("#new-match");

  // ---------- aggiorna senza token (Profilo) ----------
  await page.click(".tabs [data-view=profile]");
  await page.click("#refresh");
  await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
  check("aggiorna senza token: spiega come attivarlo", (await text(page, "#toast")).includes("token"));
  await page.click(".tabs [data-view=match]");

  // ---------- tutte le selezioni fatte: ogni eroe resta toccabile (schermo piccolo e normale) ----------
  // schermi: piccolo di riferimento, Xiaomi 14T (407×905 meno barre di sistema), Nothing Phone (3) (≈420×933 meno barre)
  // nomi in un posto su una riga (fitText «whole»): mai tagliati, mai a capo
  const fitAll = (pg, sel) => pg.evaluate((s) => {
    const names = [...document.querySelectorAll("#grid .hero .nm")].map((x) => x.textContent);
    const broken = [];
    const orig = document.querySelector(s);
    if (!orig) return [`${s} assente`];
    const clone = orig.cloneNode(false);
    orig.after(clone);
    orig.style.display = "none";
    for (const n of names) {
      clone.textContent = n;
      window.owcFitText(clone, { whole: true });
      const r = document.createRange();
      r.selectNodeContents(clone);
      const lines = new Set([...r.getClientRects()].map((q) => Math.round(q.top))).size;
      if (lines > 1 || clone.scrollWidth > clone.clientWidth + 1) broken.push(n);
    }
    clone.remove();
    orig.style.display = "";
    return broken;
  }, sel);
  for (const vp of [{ width: 360, height: 640 }, { width: 390, height: 844 }, { width: 407, height: 833, name: "Xiaomi 14T" },
    { width: 420, height: 860, name: "Nothing Phone (3)" }]) {
    const { ctx: c7, page: p7 } = await newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 3, serviceWorkers: "block" });
    const label = vp.name ? `${vp.name} (${vp.width}×${vp.height})` : `${vp.width}×${vp.height}`;
    await p7.addInitScript(() => localStorage.setItem("owc.profile", JSON.stringify({ useTheory: true,
      players: [{ name: "Fabio", rank: "", roles: ["Damage"], favorites: [] }, { name: "Giulia", rank: "", roles: ["Support"], favorites: [] }] })));
    await p7.goto(BASE);
    await p7.locator(CARD).first().waitFor();
    await p7.evaluate(() => document.fonts.ready);
    const hb = (n) => heroBtn(p7, n);
    // ogni nome dei 53 eroi, nel posto del consiglio («PRENDI») e delle alternative: mai spezzato né tagliato
    const slots = [...await fitAll(p7, "#picks .move .nm"), ...(await fitAll(p7, "#picks .alt .nm")).map((n) => `${n} (alternativa)`)];
    if (vp.name || vp.width >= 390) check(`${label}: nelle fasce nessun nome spezzato né tagliato (53 eroi)`, slots.length === 0, slots.join(", "));
    await p7.click("#map-btn");
    await p7.locator("#map-list .map-opt", { hasText: "King's Row" }).click();
    await p7.click("#side [data-side=attack]");
    if (vp.width === 390) {
      await p7.click("#groups [data-group=bans]");
      check("statistiche + teoria: «BAN?» su 3 eroi per ruolo", (await p7.locator("#grid .hero.sugg").count()) === 9);
    }
    for (const [g, names] of [["bans", ["Ana", "Kiriko", "Widowmaker", "Tracer"]], ["enemies", ["Reinhardt", "Genji", "Pharah", "Mercy", "Lúcio"]], ["allies", ["Winston", "Sojourn", "Baptiste"]]]) {
      await toTop(p7);
      await p7.click(`#groups [data-group=${g}]`);
      for (const n of names) await hb(n).click();
    }
    // e gli eroi presi da Fabio e Giulia (in 5: 3 alleati + i due giocatori), dal foglio di ciascuno → griglia
    await pickFromGrid(p7, 0);
    await hb("Cassidy").click();
    await pickFromGrid(p7, 1);
    await hb("Moira").click();
    // dopo la scelta, il nome dell'eroe preso: mai spezzato né tagliato
    const slots2 = await fitAll(p7, "#picks .cur");
    if (vp.name || vp.width >= 390) check(`${label}: nome dell'eroe preso nella fascia, mai spezzato né tagliato (53 eroi)`, slots2.length === 0, slots2.join(", "));
    check(`${label}: dopo le scelte il ritratto grande è l'eroe preso`, (await portraitsOk(p7)).length === 0, JSON.stringify(await portraitsOk(p7)));
    await p7.waitForTimeout(2600); // il messaggio sparisce
    const res = await p7.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const bad = [];
      let maxMini = 0;
      for (const tab of document.querySelectorAll("#role-tabs .tab")) {
        tab.click();
        await frame();
        for (const btn of document.querySelectorAll("#grid [data-block]:not([hidden]) .hero")) {
          btn.scrollIntoView({ block: "center" });
          await frame();
          const mini = document.querySelector("#mini");
          if (!mini.hidden) maxMini = Math.max(maxMini, mini.getBoundingClientRect().bottom);
          const r = btn.getBoundingClientRect();
          const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (!btn.contains(el)) bad.push(btn.querySelector(".nm").textContent);
        }
      }
      return { bad, maxMini: Math.round(maxMini) };
    });
    check(`${label}, tutte le selezioni: ogni eroe toccabile (in ogni scheda di ruolo)`, res.bad.length === 0, res.bad.join(", "));
    check(`${label}: barra minima in alto bassa (≤ 140 px)`, res.maxMini <= 140, `${res.maxMini}px`);
    // nessun nome di eroe troncato nella griglia (tutte le schede) e niente scorrimento orizzontale
    const fit = await p7.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      window.scrollTo(0, 0);
      const cut = [];
      for (const tab of document.querySelectorAll("#role-tabs .tab")) {
        tab.click();
        await frame();
        for (const x of document.querySelectorAll("#grid [data-block]:not([hidden]) .hero .nm")) {
          const r = document.createRange();
          r.selectNodeContents(x);
          const lines = new Set([...r.getClientRects()].map((q) => Math.round(q.top))).size;
          if (x.scrollWidth > x.clientWidth + 1 || lines > 1) cut.push(x.textContent);
        }
      }
      return { cut, overflow: document.documentElement.scrollWidth - window.innerWidth };
    });
    check(`${label}: nomi nella griglia interi, su una riga (tutte le schede)`, fit.cut.length === 0, fit.cut.join(", "));
    check(`${label}: niente scorrimento orizzontale`, fit.overflow <= 0, `${fit.overflow}px`);
    const smallV = await smallTargets(p7);
    check(`${label}: bersagli visibili della Partita ≥ 48 px`, smallV.length === 0, JSON.stringify(smallV));
    if (vp.name) await shot(p7, `12-${vp.name.replace(/\W+/g, "-")}`);
    await p7.evaluate(() => window.scrollTo(0, 900));
    await p7.waitForTimeout(150);
    if (vp.height === 640) {
      check("360×640 scorsa: compare la barra minima (quello che hanno → la mossa)", await p7.locator("#mini").isVisible()
        && (await p7.locator("#mini .mini-pick").count()) === 2, await p7.evaluate(() => JSON.stringify({ y: scrollY, h: document.scrollingElement.scrollHeight,
        r: document.querySelector("#picks").getBoundingClientRect().top, mini: document.querySelector("#mini").hidden, n: document.querySelectorAll("#mini .mini-pick").length })));
      await shot(p7, "11-tutte-le-selezioni-scorso");
    }
    await toTop(p7);
    if (vp.height === 640) await shot(p7, "11-tutte-le-selezioni-in-cima");
    await c7.close();
  }

  // ---------- con 2 giocatori la Partita sta nello schermo, senza scorrere (390×844 e i telefoni dell'utente) ----------
  {
    const P = { players: [{ name: "Fabio", rank: "", roles: ["Damage"], favorites: [] }, { name: "Giulia", rank: "", roles: ["Support"], favorites: [] }] };
    const fresh = { ...data, checked: new Date().toISOString(), problems: [] };
    const M = (o) => ({ roles: ["Damage", "Support"], picked: [null, null], pickFor: 0, mapSlug: "kings-row", side: "attack", bans: [], enemies: [], allies: [], group: "enemies", ...o });
    const W = [heroId("Widowmaker"), heroId("Sombra")];
    const STATES = [
      ["prima della scelta", M({ bans: W }), null],
      ["dopo la scelta (Passa a)", M({ bans: W, enemies: ["Winston", "Tracer", "Ana"].map(heroId), picked: [heroId("Cassidy"), null] }), null],
      ["Ban, scheda Danni", M({ bans: [heroId("Reinhardt")], group: "bans" }), "Damage"],
      ["Avversari, nessuno ha scelto, scheda Danni (4 righe)", M({ bans: W, enemies: ["Winston", "Tracer", "Ana"].map(heroId) }), "Damage"],
      ["Avversari con un eroe scelto (nomi rossi), scheda Danni", M({ enemies: [heroId("Winston")], picked: [heroId("Cassidy"), heroId("Ana")] }), "Damage"],
      ["Alleati", M({ enemies: ["Winston", "Tracer"].map(heroId), picked: [heroId("Cassidy"), null], allies: [heroId("Zarya")], group: "allies" }), null],
      ["«Tocca l'eroe preso da Giulia»", M({ enemies: ["Winston", "Tracer", "Ana"].map(heroId), picked: [heroId("Cassidy"), null], group: "picked", pickFor: 1 }), null],
    ];
    for (const [w, h] of [[390, 844], [407, 833], [420, 860]]) {
      for (const [name, m, tab] of STATES) {
        const { ctx: cn, page: pn } = await newPage({ viewport: { width: w, height: h }, serviceWorkers: "block" });
        await cn.route("**/data.json*", (r) => r.fulfill({ json: fresh }));
        await pn.addInitScript(([p, mm]) => { if (!sessionStorage.getItem("s")) { sessionStorage.setItem("s", "1"); localStorage.setItem("owc.profile", JSON.stringify(p)); localStorage.setItem("owc.match", JSON.stringify(mm)); } }, [P, m]);
        await pn.goto(BASE);
        await pn.locator(CARD).first().waitFor();
        await pn.evaluate(() => document.fonts.ready);
        if (tab) await pn.click(`#role-tabs [data-tab=${tab}]`);
        await pn.waitForTimeout(100);
        const over = await overflowY(pn);
        const small = await smallTargets(pn);
        const portraits = await portraitsOk(pn);
        check(`${w}×${h}, 2 giocatori, ${name}: tutto in vista senza scorrere, bersagli ≥ 48 px, ritratti = eroi presi`,
          over <= 0 && !small.length && !portraits.length, JSON.stringify({ over, small, portraits }));
        if (w === 390) await shot(pn, `21-senza-scorrere-${name.replace(/\W+/g, "-").slice(0, 30)}`);
        await cn.close();
      }
    }
  }

  // ---------- carattere di sistema ingrandito (Xiaomi al 130%): nomi interi, mai spezzati né tagliati ----------
  {
    const { ctx: c11, page: p11 } = await newPage({ viewport: { width: 407, height: 833 }, deviceScaleFactor: 3, serviceWorkers: "block" });
    lastPage = p11;
    await p11.addInitScript((m) => localStorage.setItem("owc.match", JSON.stringify(m)),
      { roles: ["Damage", "Support"], picked: [heroId("Cassidy"), null], pickFor: 0, mapSlug: "kings-row", side: "attack", bans: [], enemies: ["Winston", "Tracer"].map(heroId), allies: [], group: "enemies" });
    await p11.goto(BASE);
    await p11.locator(CARD).first().waitFor();
    // la WebView ingrandisce tutto il testo del 30%: qui lo si imita moltiplicando ogni dimensione dei caratteri
    await p11.evaluate(() => {
      const up = (v) => v.replace(/(\d+(?:\.\d+)?)px/g, (m, n) => `${(Number(n) * 1.3).toFixed(2)}px`);
      for (const sh of document.styleSheets) for (const r of sh.cssRules) {
        if (!r.style) continue;
        if (r.style.fontSize) r.style.fontSize = up(r.style.fontSize);
        else if (r.style.font) r.style.setProperty("font", r.style.getPropertyValue("font").replace(/^(.*?)(\d+(?:\.\d+)?px|calc\([^)]*\))/, (m, a, sz) => a + up(sz)));
      }
      document.querySelector("#grid").dataset.fitW = "";
      window.dispatchEvent(new Event("resize"));
    });
    await p11.waitForTimeout(200);
    const broken = await p11.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out = [];
      const test = (x) => {
        const r = document.createRange();
        r.selectNodeContents(x);
        const lines = new Set([...r.getClientRects()].map((q) => Math.round(q.top))).size;
        if (lines > 1 || x.scrollWidth > x.clientWidth + 1) out.push(x.textContent);
      };
      for (const tab of document.querySelectorAll("#role-tabs .tab")) {
        tab.click();
        await frame();
        document.querySelectorAll("#grid [data-block]:not([hidden]) .hero .nm").forEach(test);
      }
      document.querySelectorAll("#picks .cur, #picks .move .nm, #picks .alt .nm, #slots .nm, #map-name").forEach(test);
      return { out, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    check("carattere al 130%: nomi di griglia, fasce, posti e mappa interi, mai spezzati né tagliati", broken.out.length === 0 && broken.overflow <= 0, JSON.stringify(broken));
    await shot(p11, "15-carattere-130");
    await c11.close();
  }

  // ---------- da 1 a 5 giocatori, ognuno col suo colore; "Chi ha preso cosa" ----------
  {
    const QUEUE = [["Fabio", "Damage"], ["Giulia", "Support"], ["Marco", "Tank"], ["Sara", "Support"], ["Luca", "Damage"]];
    // eroe preso da ciascuno (scelto apposta diverso dal n. 1 consigliato, se possibile)
    const TAKE = { Damage: [itn("Soldier: 76"), "Sojourn"], Support: ["Ana", "Kiriko"], Tank: ["Reinhardt"] };
    for (const n of [1, 2, 3, 4, 5]) {
      for (const vp of n === 5 ? [{ width: 360, height: 640 }, { width: 407, height: 833, name: "Xiaomi 14T" }, { width: 420, height: 860, name: "Nothing Phone (3)" }]
        : [{ width: 407, height: 833, name: "Xiaomi 14T" }, { width: 420, height: 860, name: "Nothing Phone (3)" }]) {
        const { ctx: c9, page: p9 } = await newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 3, serviceWorkers: "block" });
        lastPage = p9;
        const label = `${n} giocator${n === 1 ? "e" : "i"}, ${vp.name ?? `${vp.width}×${vp.height}`}`;
        const players = QUEUE.slice(0, n).map(([name, role]) => ({ name, rank: "", roles: [role], favorites: [] }));
        await p9.addInitScript((pl) => localStorage.setItem("owc.profile", JSON.stringify({ players: pl })), players);
        await p9.goto(BASE);
        await p9.locator(CARD).first().waitFor();
        const hb = (name) => heroBtn(p9, name);
        await p9.click("#map-btn");
        await p9.locator("#map-list .map-opt", { hasText: ILIOS }).click();
        await p9.click("#groups [data-group=enemies]");
        for (const e of ["Winston", "Genji", "Pharah"]) await hb(e).click();
        await toTop(p9);

        const st = await p9.evaluate(() => ({
          cards: document.querySelectorAll("#picks .band").length,
          compact: document.querySelectorAll("#picks .band.compact").length,
          moves: window.owcBands().map((b) => b.move),
          firsts: [...document.querySelectorAll("#picks .band")].map((b) => (b.querySelector(".move .nm") ?? b.querySelector(".cmp .nm"))?.textContent ?? ""),
          colors: [...document.querySelectorAll("#picks .band")].map((x) => getComputedStyle(x, "::before").backgroundColor),
          recs: [...document.querySelectorAll("#grid .hero.rec")].map((b) => [b.querySelector(".nm").textContent, getComputedStyle(b, "::before").borderTopColor]),
          alliesHidden: document.querySelector("#groups [data-group=allies]").hidden,
        }));
        check(`${label}: una fascia per giocatore, ognuna con «PRENDI» e il consigliato`, st.cards === n && st.moves.every(Boolean), JSON.stringify(st));
        check(`${label}: consigli tutti diversi, del ruolo di ciascuno`,
          new Set(st.firsts).size === n && st.firsts.every((h, i) => data.heroes.find((x) => x.name === toEn(h))?.role === QUEUE[i][1]), st.firsts.join(", "));
        check(`${label}: un colore diverso per giocatore (fasce e griglia)`,
          new Set(st.colors).size === n && st.recs.length === n && new Set(st.recs.map((r) => r[1])).size === n, JSON.stringify(st.recs));
        check(`${label}: «Alleati» solo se c'è posto in squadra (5 − giocatori)`, st.alliesHidden === (n === 5));
        check(`${label}: prima della scelta il ritratto grande è il posto vuoto`, (await portraitsOk(p9)).length === 0, JSON.stringify(await portraitsOk(p9)));
        if (n <= 2) {
          // la striscia della mossa e le alternative larghe quanto la fascia
          const widths = await p9.evaluate(() => [...document.querySelectorAll("#picks .band")].map((b) =>
            [b.querySelector(".has-row"), b.querySelector(".move"), b.querySelector(".alts")].filter(Boolean).map((x) => Math.round(x.getBoundingClientRect().width))));
          check(`${label}: riga del giocatore, striscia e alternative della stessa larghezza`, widths.every((w) => w.every((x) => Math.abs(x - w[0]) <= 1)), JSON.stringify(widths));
          check(`${label}: niente fasce compatte`, st.compact === 0);
        } else {
          // da 3 giocatori: fasce compatte di una riga, se ne apre una alla volta
          check(`${label}: tutte le fasce compatte (una riga)`, st.compact === n
            && (await p9.locator("#picks .band.compact").evaluateAll((bs) => bs.every((b) => b.getBoundingClientRect().height <= 60))));
          await p9.locator("#picks .band").nth(1).locator(".cmp").click();
          const open1 = await p9.evaluate(() => [...document.querySelectorAll("#picks .band:not(.compact)")].map((b) => b.dataset.player));
          await p9.locator("#picks .band").nth(2).locator(".cmp").click();
          const open2 = await p9.evaluate(() => [...document.querySelectorAll("#picks .band:not(.compact)")].map((b) => b.dataset.player));
          check(`${label}: un tocco apre una fascia, aprirne un'altra chiude la prima`, open1.join() === "1" && open2.join() === "2", JSON.stringify([open1, open2]));
          await p9.locator("#picks .band:not(.compact) .fold").click();
          check(`${label}: la freccia richiude la fascia aperta`, (await p9.locator("#picks .band.compact").count()) === n);
        }
        if (n <= 2 || n === 5) await shot(p9, `13-squadra-${n}-${(vp.name ?? `${vp.width}`).replace(/\W+/g, "-")}-consigli`);

        // ognuno segna l'eroe che ha preso (diverso dal consigliato): dal suo foglio «Un altro eroe», poi l'eroe nella griglia
        const used = { Damage: 0, Support: 0, Tank: 0 };
        const taken = [];
        for (let i = 0; i < n; i++) {
          const role = QUEUE[i][1];
          const h = TAKE[role][used[role]++];
          taken.push(h);
          await pickFromGrid(p9, i);
          check(`${label}: «Tocca l'eroe preso da ${QUEUE[i][0]}» al posto del selettore`, (await p9.locator("#pick-banner").isVisible())
            && (await text(p9, "#pick-banner-txt")).includes(QUEUE[i][0]) && !(await p9.locator("#groups").isVisible()));
          await hb(h).click();
        }
        await p9.waitForTimeout(150);
        await toTop(p9);
        const after = await p9.evaluate(() => ({
          bands: window.owcBands(),
          took: [...document.querySelectorAll("#grid .hero.took")].map((b) => [b.querySelector(".nm").textContent, b.querySelector(".tag")?.textContent]),
          rec: document.querySelectorAll("#grid .hero.rec").length,
          group: JSON.parse(localStorage.getItem("owc.match")).group,
        }));
        const hasNames = after.bands.map((b) => nameOfId(b.has));
        check(`${label}: ogni fascia ha nel ritratto grande l'eroe preso`, hasNames.join() === taken.join() && (await portraitsOk(p9)).length === 0, JSON.stringify(after.bands));
        check(`${label}: griglia: eroi presi segnati col ✓ e l'iniziale di chi li ha presi`,
          after.took.length === n && taken.every((h, i) => after.took.some(([nm, tag]) => nm === h && tag === `${QUEUE[i][0][0]}✓`)) && after.rec === 0,
          JSON.stringify(after.took));
        check(`${label}: dopo la scelta un eventuale cambio («Passa a») non propone eroi presi dagli altri`,
          after.bands.every((b) => !b.move || !taken.includes(nameOfId(b.move))), JSON.stringify(after.bands));
        check(`${label}: dopo ogni scelta si torna agli avversari`, after.group === "enemies", after.group);
        // barra minima (con la ricerca aperta c'è sempre): tutti visibili, ognuno col suo eroe preso, non troppo alta
        await p9.click("#hero-q");
        const bar = await p9.evaluate(() => {
          const mini = document.querySelector("#mini");
          const m = JSON.parse(localStorage.getItem("owc.match"));
          return { shown: !mini.hidden, count: mini.querySelectorAll(".mini-pick").length,
            has: [...mini.querySelectorAll(".mini-pick")].every((b) => b.dataset.has === String(m.picked[Number(b.dataset.player)])),
            bottom: Math.round(mini.getBoundingClientRect().bottom),
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            cut: [...mini.querySelectorAll(".nm")].filter((b) => b.offsetParent && b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent) };
        });
        check(`${label}: barra minima con tutti i ${n}, l'eroe che hanno al posto del ritratto, bassa (≤ 140 px)`,
          bar.shown && bar.count === n && bar.has && bar.bottom <= 140 && !bar.cut.length, JSON.stringify(bar));
        check(`${label}: niente scorrimento orizzontale`, bar.overflow <= 0, `${bar.overflow}px`);
        if (n === 2 || n === 5) await shot(p9, `13-squadra-${n}-${(vp.name ?? `${vp.width}`).replace(/\W+/g, "-")}-ricerca`);
        await p9.evaluate(() => document.activeElement.blur());
        await p9.waitForTimeout(100);
        // «Come giocarla» del primo giocatore: parla del suo eroe preso
        await openGuideOf(p9, 0);
        check(`${label}: «Come giocarla» sull'eroe preso`, (await text(p9, "#t-guide")).includes(taken[0]), await text(p9, "#t-guide"));
        await p9.locator("#guide-dialog [data-close]").click();
        await c9.close();
      }
    }

    // segnare un eroe preso: resta tra gli avversari (mirror); toglierlo dal foglio; scegliere dalla striscia; annullare
    const { ctx: c10, page: p10 } = await newPage({ serviceWorkers: "block" });
    lastPage = p10;
    await p10.goto(BASE);
    await p10.locator(CARD).first().waitFor();
    await p10.click("#groups [data-group=enemies]");
    await heroBtn(p10, "Mercy").click();
    await pickFromGrid(p10, 1);
    await heroBtn(p10, "Mercy").click();
    const m1 = await matchState(p10);
    check("«Un altro eroe»: eroe preso assegnato al giocatore, resta avversario (mirror)", m1.enemies.map(String).includes(heroId("Mercy")) && String(m1.picked[1]) === heroId("Mercy") && m1.picked[0] === null, JSON.stringify(m1));
    await unpick(p10, 1);
    check("«Non l'ho preso»: l'eroe non è più segnato", (await matchState(p10)).picked[1] === null);
    await toTop(p10);
    const rec0 = (await favRows(p10, 0))[0].name;
    await band(p10, 0).locator(".move .done").click();
    await toTop(p10);
    check("un tocco su «✓ PRESO» e l'eroe è segnato come scelto", String((await matchState(p10)).picked[0]) === heroId(rec0)
      && (await band(p10, 0).getAttribute("data-has")) === heroId(rec0), rec0);
    await pickFromGrid(p10, 1);
    await p10.click("#pick-cancel");
    check("«Annulla» nel banner: torna il selettore, niente segnato", (await p10.locator("#groups").isVisible())
      && !(await p10.locator("#pick-banner").isVisible()) && (await matchState(p10)).picked[1] === null);
    await toTop(p10);
    await band(p10, 1).locator(".move .go").click();
    await p10.locator("#guide-body .took-btn").click();
    check("dalla guida: «Segna: Lei l'ha preso»", (await matchState(p10)).picked[1] !== null
      && (await p10.locator("#guide-body .took-btn").getAttribute("aria-pressed")) === "true");
    await p10.click("#guide-dialog [data-close]");

    // Profilo: si aggiungono giocatori fino a 5 e si tolgono; la partita si adegua
    await p10.click(".tabs [data-view=profile]");
    for (let k = 0; k < 3; k++) await p10.click("#add-player");
    const prof5 = await p10.evaluate(() => ({ cards: document.querySelectorAll("#players section.card [id$=-title]").length,
      add: !!document.querySelector("#add-player"), roles: JSON.parse(localStorage.getItem("owc.profile")).players.map((p) => p.roles[0]) }));
    check("profilo: si arriva a 5 giocatori, poi niente «Aggiungi»", prof5.cards === 5 && !prof5.add, JSON.stringify(prof5));
    check("profilo: i nuovi prendono i ruoli che mancano (1 tank, 2 danni, 2 supporti)",
      [...prof5.roles].sort().join() === ["Damage", "Damage", "Support", "Support", "Tank"].sort().join(), prof5.roles.join());
    await shot(p10, "14-profilo-5-giocatori");
    await p10.locator("#players [aria-label^='Rimuovi']").nth(1).click();
    check("profilo: «Rimuovi» chiede conferma (dopo un tocco sono ancora 5)",
      (await p10.locator("#players section.card [id$=-title]").count()) === 5
      && /conferma/i.test(await p10.locator("#players [aria-label^='Rimuovi']").nth(1).textContent()));
    await p10.locator("#players [aria-label^='Rimuovi']").nth(1).click();
    await p10.click(".tabs [data-view=match]");
    const four = await p10.evaluate(() => ({ cards: document.querySelectorAll("#picks .band").length,
      m: JSON.parse(localStorage.getItem("owc.match")) }));
    check("rimosso un giocatore: 4 fasce, partita adeguata", four.cards === 4 && four.m.roles.length === 4 && four.m.picked.length === 4, JSON.stringify(four));
    await c10.close();
  }

  // ---------- ricerca: eroi (Partita, in ogni stato, e preferiti) e mappe; nomi italiani ufficiali (names_it.json) ----------
  {
    const { ctx: c12, page: p12 } = await newPage({ serviceWorkers: "block" });
    lastPage = p12;
    // nomi italiani simulati: un eroe, una mappa e tutte le abilità (marcate «IT …» per riconoscerle)
    const theory = JSON.parse(readFileSync(path.join(ROOT, "app", "theory.json")));
    const abilities = Object.fromEntries(Object.entries(theory).filter(([k, t]) => !k.startsWith("_") && Array.isArray(t.abilities))
      .map(([k, t]) => [k, Object.fromEntries(t.abilities.map((a) => [a.name, `«IT ${a.name}»`]))]));
    await c12.route("**/names_it.json", (r) => r.fulfill({ json: {
      heroes: { "Soldier: 76": "Soldato-76" }, maps: { "Watchpoint: Gibraltar": "Osservatorio: Gibilterra" }, abilities } }));
    await p12.goto(BASE);
    await p12.locator("#grid .hero").first().waitFor();
    const shown = (sel) => p12.$$eval(sel, (bs) => bs.filter((b) => b.offsetParent).map((b) => (b.querySelector(".nm") ?? b).textContent));
    const results = () => shown("#results-list .hero");
    const search = async (q) => { await p12.fill("#hero-q", q); return results(); };
    await p12.click("#hero-q");
    check("ricerca: un tocco sul campo apre la ricerca (fasce nascoste, barra minima, selettore e posti in vista, barra in basso nascosta)",
      await p12.evaluate(() => window.owcSearching()) && await p12.locator("#picks").isHidden() && await p12.locator("#mini").isVisible()
      && await p12.locator("#groups").isVisible() && await p12.locator("#slots").isVisible() && await p12.locator(".dock").isHidden()
      && await p12.locator("#search-hint").isVisible());
    check("ricerca eroi: senza accenti («lucio» → Lúcio)", (await search("lucio")).join() === "Lúcio", (await search("lucio")).join());
    check("ricerca eroi: per iniziali («jq» → Junker Queen)", (await search("jq")).join() === "Junker Queen", (await search("jq")).join());
    check("ricerca eroi: nome italiano mostrato e trovato anche in inglese e senza simboli",
      (await search("soldier76")).join() === "Soldato-76" && (await search("soldato")).join() === "Soldato-76", (await search("soldier76")).join());
    const an = await search("an");
    check("ricerca eroi: risultati di tutti i ruoli, prima chi comincia con la ricerca, al massimo 8, il primo con «INVIO»",
      an.length >= 3 && an.length <= 8 && an.slice(0, 2).every((n) => /^an/i.test(n)) && new Set(an.map((n) => data.heroes.find((h) => itn(h.name) === n)?.role)).size >= 2
      && await p12.locator("#results-list .hero:not([hidden])").first().evaluate((b) => b.classList.contains("first"))
      && /risultat. per «an» in tutti i ruoli · un tocco = avversario/.test(await text(p12, "#results-hd")), an.join());
    const none = await search("zzz");
    check("ricerca eroi: nessun risultato → messaggio", none.length === 0 && (await p12.locator("[data-none=results]").isVisible()));
    await shot(p12, "16-ricerca-eroi");
    await p12.fill("#hero-q", "phar");
    await p12.press("#hero-q", "Enter");
    const afterEnter = await p12.evaluate(() => ({ q: document.querySelector("#hero-q").value, focus: document.activeElement?.id, searching: window.owcSearching(),
      shown: [...document.querySelectorAll("#results-list .hero")].filter((b) => b.offsetParent).length,
      enemies: JSON.parse(localStorage.getItem("owc.match")).enemies.length }));
    check("ricerca eroi: Invio segna il primo risultato, il campo si svuota e resta attivo (tastiera aperta)",
      afterEnter.enemies === 1 && afterEnter.q === "" && afterEnter.focus === "hero-q" && afterEnter.searching && afterEnter.shown === 0, JSON.stringify(afterEnter));
    await p12.fill("#hero-q", "phar");
    check("ricerca: un eroe già segnato è «Già segnato» (un tocco lo toglie)", await p12.locator("#results-list .hero.marked .on-lab").isVisible());
    await p12.fill("#hero-q", "win");
    await p12.locator("#results-list .hero", { has: p12.locator(".nm", { hasText: /^Winston$/ }) }).click();
    const afterTap = await p12.evaluate(() => ({ q: document.querySelector("#hero-q").value, focus: document.activeElement?.id,
      enemies: JSON.parse(localStorage.getItem("owc.match")).enemies.length }));
    check("ricerca eroi: tocco su un risultato → segnato, campo vuoto e ancora attivo", afterTap.enemies === 2 && afterTap.q === "" && afterTap.focus === "hero-q", JSON.stringify(afterTap));
    // tastiera aperta: la finestra si accorcia (adjustResize) → i risultati stanno subito sopra, dentro l'area visibile
    await p12.setViewportSize({ width: 390, height: 554 });
    await p12.fill("#hero-q", "me");
    await p12.waitForTimeout(150);
    const kb = await p12.evaluate(() => { const r = document.querySelector("#results").getBoundingClientRect();
      const tiles = [...document.querySelectorAll("#results-list .hero:not([hidden])")].map((b) => b.getBoundingClientRect());
      return { bottom: Math.round(r.bottom), top: Math.round(r.top), h: innerHeight, n: tiles.length, inside: tiles.every((t) => t.top >= 0 && t.bottom <= innerHeight + 0.5),
        input: document.querySelector("#hero-q").getBoundingClientRect().bottom, tall: tiles.every((t) => t.height >= 48) }; });
    check("ricerca con la tastiera (finestra di 554 px): risultati ancorati sopra la tastiera, tutti in vista, sotto il campo",
      kb.n >= 1 && Math.abs(kb.bottom - kb.h) <= 1 && kb.inside && kb.top >= kb.input && kb.tall, JSON.stringify(kb));
    await shot(p12, "16b-ricerca-tastiera");
    await p12.setViewportSize({ width: 390, height: 844 });
    await p12.goBack();
    await p12.waitForTimeout(200);
    check("ricerca: «indietro» la chiude (e non chiude l'app)", !(await p12.evaluate(() => window.owcSearching())) && await p12.locator("#picks").isVisible()
      && await p12.locator(".dock").isVisible() && (await p12.inputValue("#hero-q")) === "");
    // raggiungibile con un tocco in ogni stato: Ban, Avversari, Alleati e «Tocca l'eroe preso da X»; trova eroi di un altro ruolo
    for (const [g, q, want, what] of [["bans", "mer", "Mercy", "bannato"], ["enemies", "rein", "Reinhardt", "avversario"], ["allies", "lucio", "Lúcio", "alleato"], ["picked", "zen", "Zenyatta", "eroe preso da"]]) {
      await toTop(p12);
      if (g === "picked") await pickFromGrid(p12, 0);
      else await p12.click(`#groups [data-group=${g}]`);
      const tabBefore = await p12.locator("#role-tabs .tab[aria-pressed=true]").getAttribute("data-tab");
      const visibleField = await p12.locator("#hero-q").isVisible();
      await p12.click("#hero-q");
      await p12.keyboard.type(q);
      await p12.waitForTimeout(80);
      const r = await results();
      const otherRole = data.heroes.find((h) => itn(h.name) === want).role !== tabBefore;
      const hd = await text(p12, "#results-hd");
      await p12.press("#hero-q", "Enter");
      const m = await matchState(p12);
      const done = g === "picked" ? String(m.picked[0]) === heroId(want) : m[g].map(String).includes(heroId(want));
      check(`ricerca in «${g}»: campo in vista e un tocco lo apre, trova ${want} anche fuori dalla scheda aperta (${tabBefore}), Invio lo segna`,
        visibleField && r[0] === want && done && new RegExp(`un tocco = ${what}`).test(hd), JSON.stringify({ r, otherRole, hd, m: m[g] ?? m.picked }));
      await p12.evaluate(() => document.activeElement.blur());
      await p12.waitForTimeout(80);
    }
    check("ricerca: un tocco fuori la chiude", !(await p12.evaluate(() => window.owcSearching())));

    await p12.click("#map-btn");
    await p12.fill("#map-q", "kings");
    check("ricerca mappe: «kings» → King's Row", (await shown("#map-list .map-opt")).join() === "King's Row", (await shown("#map-list .map-opt")).join());
    await p12.fill("#map-q", "gibraltar");
    check("ricerca mappe: nome italiano mostrato, trovato anche in inglese",
      (await shown("#map-list .map-opt")).join() === "Osservatorio: Gibilterra", (await shown("#map-list .map-opt")).join());
    check("ricerca mappe: campo fermo in cima al foglio", await p12.locator("#map-dialog .search").evaluate((s) => getComputedStyle(s).position === "sticky"));
    await p12.fill("#map-q", "kings");
    await p12.press("#map-q", "Enter");
    check("ricerca mappe: Invio sceglie la mappa e chiude", !(await p12.locator("#map-dialog").evaluate((d) => d.open))
      && (await text(p12, "#map-name")).includes("King's Row"));
    await p12.click("#map-btn");
    check("ricerca mappe: riaprendo la finestra il campo è vuoto", (await p12.inputValue("#map-q")) === ""
      && (await shown("#map-list .map-opt")).length === data.maps.length + 1);
    await p12.click("#map-dialog [data-close]");

    await p12.click(".tabs [data-view=profile]");
    await p12.locator("#players .btn", { hasText: "Scegli preferiti" }).first().click();
    await p12.fill("#fav-q", "mer");
    const favShown = await shown("#fav-grid .hero");
    check("ricerca preferiti: «mer» → Mercy", favShown.join() === "Mercy", favShown.join());
    await p12.locator("#fav-grid .hero", { hasText: "Mercy" }).click();
    check("ricerca preferiti: tocco → preferito aggiunto e campo vuoto", (await p12.inputValue("#fav-q")) === ""
      && JSON.parse(await p12.evaluate(() => localStorage.getItem("owc.profile"))).players[0].favorites.map(String).includes(heroId("Mercy")));
    await p12.click("#fav-dialog [data-close]");
    await p12.click(".tabs [data-view=match]");

    await p12.click("#new-match");
    await p12.click("#groups [data-group=bans]");
    for (const n of ["Ana", "Kiriko", "Widowmaker", "Tracer", "Genji", "Moira"]) await heroBtn(p12, n).click();
    check("ban: al massimo 5 (il sesto non entra, con avviso)", (await text(p12, "[data-count=bans]")) === "5/5"
      && (await text(p12, "#toast")).includes("Al massimo 5 ban"), await text(p12, "#toast"));
    await p12.click("#groups [data-group=enemies]");

    // abilità: nel «Come giocarla» i nomi ufficiali italiani (anche dentro i consigli scritti), non quelli inglesi
    await openGuideOf(p12, 0);
    await p12.click("#guide-body .more-btn");
    const hero = (await text(p12, "#t-guide")).replace(/^Come giocare /, "");
    const guide = await text(p12, "#guide-body");
    // nessun nome inglese, né delle abilità dell'eroe né di quelle degli altri citate nei consigli (es. Dragonblade di Genji)
    const allEn = [...new Set(Object.values(abilities).flatMap((m) => Object.keys(m)))];
    const rest = guide.replace(/«IT [^»]+»/g, "");
    const left = allEn.filter((n) => new RegExp(`(^|[^\\w])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`).test(rest));
    check("abilità col nome italiano del gioco (names_it.json), anche quelle degli altri eroi nei consigli", guide.includes("«IT ") && left.length === 0,
      `${hero}: ancora in inglese ${left.join(", ")}`);
    await p12.click("#guide-dialog [data-close]");
    await c12.close();
  }

  // ---------- tasto/gesto «indietro» di Android: chiude il livello in cima, non l'app ----------
  {
    const { ctx: c14, page: p14 } = await newPage({ serviceWorkers: "block" });
    lastPage = p14;
    await p14.goto(BASE);
    await p14.locator("#picks .move .go").first().waitFor();
    const depth = () => p14.evaluate(() => history.state?.owc ?? 0);
    const d0 = await depth();
    await p14.locator("#picks .move .go").first().click();
    await p14.locator("#guide-dialog[open]").waitFor();
    await p14.click("#guide-body .why-btn");
    await p14.locator("#why-dialog[open]").waitFor();
    await p14.goBack();
    await p14.waitForTimeout(150);
    const s1 = await p14.evaluate(() => [document.querySelector("#why-dialog").open, document.querySelector("#guide-dialog").open]);
    await p14.goBack();
    await p14.waitForTimeout(150);
    const s2 = await p14.evaluate(() => [document.querySelector("#why-dialog").open, document.querySelector("#guide-dialog").open]);
    check("indietro: chiude prima «Perché», poi «Come giocarla»", s1.join() === "false,true" && s2.join() === "false,false", JSON.stringify([s1, s2]));
    await p14.click(".tabs [data-view=profile]");
    await p14.goBack();
    await p14.waitForTimeout(150);
    check("indietro dal Profilo: torna alla Partita", await p14.locator("#view-match").isVisible());
    await p14.click("#map-btn");
    await p14.click("#map-dialog [data-close]");
    await p14.waitForTimeout(150);
    check("foglio chiuso col pulsante: nessun passo in più nella cronologia", (await depth()) === d0, `${await depth()} vs ${d0}`);
    await openPlayer(p14, 0);
    await p14.goBack();
    await p14.waitForTimeout(150);
    check("indietro: chiude il foglio del giocatore", !(await p14.locator("#choose-dialog").evaluate((d) => d.open)));
    await pickFromGrid(p14, 0);
    await p14.goBack();
    await p14.waitForTimeout(150);
    check("indietro durante «Tocca l'eroe preso»: annulla, torna il selettore", await p14.locator("#groups").isVisible());
    await p14.click("#hero-q");
    await p14.goBack();
    await p14.waitForTimeout(150);
    check("indietro con la ricerca aperta: la chiude, l'app resta", !(await p14.evaluate(() => window.owcSearching())) && await p14.locator("#picks").isVisible()
      && (await depth()) === d0, String(await depth()));
    await c14.close();
  }

  // ---------- «Consigli solo da guide e pro»: niente statistiche di counterwatch ----------
  {
    const { ctx: c13, page: p13 } = await newPage({ viewport: { width: 407, height: 833 }, serviceWorkers: "block" });
    lastPage = p13;
    await p13.addInitScript(() => localStorage.setItem("owc.profile", JSON.stringify({
      players: [{ name: "Fabio", rank: "", roles: ["Damage"], favorites: [] }, { name: "Giulia", rank: "", roles: ["Support"], favorites: [] }] })));
    await p13.goto(BASE);
    await p13.locator(CARD).first().waitFor();
    await p13.click(".tabs [data-view=profile]");
    await p13.click("#guide-only");
    check("profilo: «Consigli solo da guide e pro» attivo, l'altra opzione sulla teoria nascosta",
      (await p13.getAttribute("#guide-only", "aria-pressed")) === "true"
      && (await p13.getByRole("button", { name: /Usa anche la teoria/ }).count()) === 0);
    await p13.click(".tabs [data-view=match]");
    await p13.click("#map-btn");
    await p13.locator("#map-list .map-opt", { hasText: "King's Row" }).click();
    await toTop(p13);
    const cardsTxt = await p13.locator(CARD).evaluateAll((cs) => cs.map((c) => [c.textContent, c.querySelectorAll(".tac").length]));
    check("solo guide: nelle fasce tacche, nessuna percentuale", cardsTxt.every(([t, n]) => n > 0 && !/\d+%/.test(t)), JSON.stringify(cardsTxt));
    await p13.click("#groups [data-group=bans]");
    check("solo guide: ban consigliati dalle guide («BAN?» su 3 per ruolo)", (await p13.locator("#grid .hero.sugg").count()) === 9);
    await shot(p13, "17-solo-guide");
    await p13.click("#groups [data-group=enemies]");
    for (const n of ["Pharah", "Winston"]) await heroBtn(p13, n).click();
    await openGuideOf(p13, 0);
    await p13.click("#guide-body .more-btn");
    const g = await text(p13, "#guide-body");
    check("solo guide: «Come giocarla» senza righe dalle statistiche", (await p13.locator("#guide-body .data-badge, #guide-body .brief-row.is-data").count()) === 0
      && !/vince [+−]\d/.test(g), g.slice(0, 200));
    await p13.click("#guide-body .why-btn");
    await p13.locator("#why-dialog[open]").waitFor();
    const w = await text(p13, "#why-body");
    check("solo guide: «Perché» senza statistiche Ranked né percentuali", !w.includes("Statistiche Ranked") && !/[+−]\d+[.,]\d%/.test(w), w.slice(0, 300));
    await shot(p13, "17b-solo-guide-perche");
    await p13.click("#why-dialog [data-close]");
    await p13.click("#guide-dialog [data-close]").catch(() => {});
    await toTop(p13);
    check("solo guide: con avversari la riga del motivo è teoria (▨)", (await p13.locator("#picks .why .mk.data").count()) === 0);
    const gStars = (await favRows(p13, 0))[0].stars;
    await band(p13, 0).locator(".move .done").click();
    await toTop(p13);
    const gCard = await band(p13, 0).evaluate((c) => ({ n: Number(c.querySelector(".curmeta .tac")?.dataset.stars ?? 0), text: c.querySelector(".has").textContent }));
    check("solo guide: eroe scelto con le tacche (le stesse della striscia), senza percentuali",
      "★".repeat(gCard.n) === gStars && gCard.n >= 1 && !/\d+%/.test(gCard.text), JSON.stringify(gCard).slice(0, 300));
    await c13.close();
  }

  // ---------- dati riletti ogni 30 minuti, solo con l'app aperta (niente timer) ----------
  {
    const { ctx: c6, page: p6 } = await newPage({ serviceWorkers: "block" });
    let hits = 0, version = data.checked;
    await c6.route("**/data.json*", (r) => { hits++; return r.fulfill({ json: { ...data, checked: version } }); });
    await p6.clock.install();
    await p6.goto(BASE);
    await p6.locator(CARD).first().waitFor();
    const h0 = hits;
    await p6.clock.runFor(2 * 3600e3);              // 2 ore senza toccare niente
    check("app lasciata lì: nessuna richiesta di dati senza interazione (niente timer)", hits === h0, `${hits - h0} richieste`);
    await p6.click("#groups [data-group=bans]");     // primo tocco dopo 2 ore: i dati vanno riletti
    await p6.waitForTimeout(300);
    const h1 = hits;
    check("tocco dopo più di 30 minuti: dati riletti", h1 === h0 + 1, `${h1 - h0} richieste`);
    await p6.click("#groups [data-group=enemies]");
    await p6.waitForTimeout(300);
    check("altro tocco subito dopo: nessuna nuova richiesta", hits === h1, `${hits - h1}`);
    version = new Date().toISOString();
    await p6.clock.runFor(31 * 60e3);
    await p6.click("#groups [data-group=allies]");
    await p6.waitForFunction(() => document.querySelector("#toast")?.innerText.includes("Dati aggiornati"), null, { timeout: 5000 });
    check("dati nuovi trovati al tocco: avviso «Dati aggiornati»", hits === h1 + 1);
    await c6.close();
  }

  // ---------- cambio di ruolo con l'app aperta (es. Sombra da Danni a Supporto) ----------
  {
    const { ctx: c5, page: p5 } = await newPage({ serviceWorkers: "block" });
    let swapped = false;
    await c5.route("**/data.json*", (r) => r.fulfill({ json: swapped
      ? { ...data, heroes: data.heroes.map((h) => (h.name === "Sombra" ? { ...h, role: "Support" } : h)) } : data }));
    await p5.goto(BASE);
    await p5.locator(CARD).first().waitFor();
    const roleOf = () => p5.evaluate(() => {
      const b = [...document.querySelectorAll("#grid .hero")].find((x) => x.querySelector(".nm").textContent === "Sombra");
      let el = b.closest(".grid").previousElementSibling;
      return el.textContent;
    });
    const before = await roleOf();
    swapped = true;
    await p5.click(".tabs [data-view=profile]");
    await p5.click("#refresh");
    await p5.waitForFunction(() => !document.querySelector("#refresh").disabled);
    const after = await roleOf();
    check("ruolo cambiato nei dati: la griglia si aggiorna senza riaprire l'app", before === "Danni" && after === "Supporto", `${before} → ${after}`);
    await c5.close();
  }

  // ---------- offline ----------
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.locator(CARD).first().waitFor();
  await ctx.setOffline(true);
  await page.reload();
  const offlineOk = await page.locator(CARD).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
  check("offline: l'app parte con i dati salvati", offlineOk);
  await shot(page, "08-offline");
  await ctx.setOffline(false);
  await ctx.close();

  // ---------- dati vecchi e con problemi ----------
  {
    // service worker bloccato: con skipWaiting/claim prenderebbe la pagina e scaricherebbe data.json da sé,
    // scavalcando i dati "vecchi" simulati qui (page.route non vede le sue richieste) → controllo instabile
    const { ctx: c2, page: p2 } = await newPage({ serviceWorkers: "block" });
    const old = { ...data, checked: new Date(Date.now() - 3 * 86400e3).toISOString(), problems: ["mappa x: rotta"] };
    await p2.route("**/data.json*", (r) => r.fulfill({ json: old }));
    await p2.goto(BASE);
    await p2.locator(CARD).first().waitFor();
    const w = await text(p2, "#warn");
    const wf = await p2.locator("#warn-full").textContent();
    check("dati vecchi/parziali: in testata la riga gialla al posto della freschezza, spiegazione completa nel foglio delle mappe, app funzionante",
      (await p2.locator("#warn").isVisible()) && /dati vecchi: 3 giorni/.test(w) && await p2.locator("#fresh-short").isHidden()
      && (await p2.locator("#warn").evaluate((x) => getComputedStyle(x).color)) === "rgb(255, 209, 102)"
      && wf.includes("non vengono aggiornati") && wf.includes("dati precedenti") && (await p2.locator(CARD).count()) === 2, `${w} | ${wf}`);
    await p2.click("#map-btn");
    check("dati vecchi: la spiegazione completa è in cima al foglio delle mappe", await p2.locator("#warn-full").isVisible());
    await p2.click("#map-dialog [data-close]");
    await shot(p2, "09-dati-vecchi");
    await c2.close();
  }

  // ---------- freschezza in testata: si aggiorna anche senza ridisegnare ----------
  {
    const { ctx: cf, page: pf } = await newPage({ serviceWorkers: "block" });
    let checked = new Date(Date.now() - 3 * 3600e3).toISOString();
    await cf.route("**/data.json*", (r) => r.fulfill({ json: { ...data, checked, problems: [] } }));
    await pf.clock.install();
    await pf.goto(BASE);
    await pf.locator(CARD).first().waitFor();
    const f1 = await text(pf, "#fresh-short");
    check("freschezza in testata: «Ibrida/… · dati di 3 h fa» quando i dati sono freschi", await pf.locator("#fresh-short").isVisible() && f1 === "dati di 3 h fa"
      && await pf.locator("#warn").isHidden(), f1);
    await pf.clock.runFor(31 * 60e3);
    checked = new Date(await pf.evaluate(() => Date.now())).toISOString(); // l'orologio della pagina è finto
    await pf.click("#groups [data-group=bans]");
    await pf.waitForFunction(() => /adesso/.test(document.querySelector("#fresh-short").textContent), null, { timeout: 5000 }).catch(() => {});
    check("freschezza in testata: aggiornata al primo tocco dopo 30 minuti", /controllati adesso/.test(await text(pf, "#fresh-short")), await text(pf, "#fresh-short"));
    await cf.close();
  }

  // ---------- dati irraggiungibili al primo avvio ----------
  {
    const { ctx: c3, page: p3 } = await newPage({ serviceWorkers: "block" });
    await p3.route("**/data.json*", (r) => r.fulfill({ status: 500, body: "x" }));
    await p3.goto(BASE);
    await p3.locator("#warn").waitFor();
    check("dati irraggiungibili: messaggio chiaro", (await text(p3, "#warn")).includes("Impossibile caricare"));
    await c3.close();
  }

  // ---------- aggiorna con token (GitHub simulato) ----------
  {
    const { ctx: c4, page: p4 } = await newPage({ serviceWorkers: "block" });
    let dispatched = null, auth = null;
    await c4.route("https://api.github.com/**", async (r) => {
      const req = r.request();
      if (req.method() === "POST") {
        dispatched = JSON.parse(req.postData());
        auth = req.headers()["authorization"];
        return r.fulfill({ status: 204, body: "" });
      }
      return r.fulfill({ json: { workflow_runs: [{ created_at: new Date().toISOString(), status: "completed", conclusion: "success" }] } });
    });
    await p4.goto(BASE);
    await p4.locator(CARD).first().waitFor();
    await p4.click(".tabs [data-view=profile]");
    await p4.fill("#token", "github_pat_PROVA");
    await p4.click("#token-save");
    check("token salvato e non mostrato", (await p4.inputValue("#token")) === "" && (await p4.getAttribute("#token", "placeholder")).includes("salvato"));
    await p4.click("#refresh");
    await p4.waitForTimeout(1000);
    check("aggiorna con token: avanzamento visibile", (await text(p4, "#refresh")).includes("in corso"), await text(p4, "#refresh"));
    await shot(p4, "10-aggiornamento");
    await p4.waitForFunction(() => document.querySelector("#toast")?.innerText.includes("aggiornati"), null, { timeout: 30000 });
    check("aggiorna con token: workflow avviato su main con il token", dispatched?.ref === "main" && auth === "Bearer github_pat_PROVA");
    await p4.click("#refresh");
    check("aggiorna con token: max 1 richiesta ogni 10 min", (await p4.locator("#toast").innerText({ timeout: 5000 }).catch(() => "")) !== "" &&
      await p4.waitForFunction(() => document.querySelector("#toast").innerText.includes("già chiesto"), null, { timeout: 5000 }).then(() => true, () => false));
    await c4.close();
  }

  // ---------- stati incrociati: eroe scelto / avversari / alleati / ban (regole di Overwatch 2) ----------
  // un ban vale per tutte e due le squadre; nella vostra squadra un eroe c'è una volta; gli avversari possono avere
  // lo stesso eroe vostro (mirror). Segnalazione dell'utente: Sigma scelto, toccato in «Chi soffrite di più» → si deselezionava.
  {
    const { ctx: cx, page: px } = await newPage({ serviceWorkers: "block" });
    lastPage = px;
    const ids = (...ns) => ns.map(heroId);
    const PROF = { players: [
      { name: "Fabio", rank: "Diamante", roles: ["Tank"], favorites: ids("Sigma", "Reinhardt", "Winston") },
      { name: "Giulia", rank: "Oro", roles: ["Support"], favorites: ids("Ana", "Kiriko") }], useTheory: false, guideOnly: false };
    const M0 = { roles: ["Tank", "Support"], picked: [null, null], pickFor: 0, mapSlug: "kings-row", side: "defense",
      bans: [], enemies: [], allies: [], group: "enemies" };
    const seed = async (m) => {
      await px.evaluate(([p, mm]) => { localStorage.setItem("owc.profile", JSON.stringify(p)); localStorage.setItem("owc.match", JSON.stringify(mm)); }, [PROF, m]);
      await px.reload();
      await px.locator(CARD).first().waitFor();
    };
    await px.goto(BASE);
    await px.locator(CARD).first().waitFor();
    await seed(M0);
    const st = () => matchState(px);
    const has = (arr, n) => (arr ?? []).map(String).includes(heroId(n));
    // «Chi soffrite di più» = i nomi rossi (3 per ruolo) nella griglia degli Avversari
    const threatNames = () => px.locator("#grid .hero.top3 .nm").evaluateAll((xs) => xs.map((x) => x.textContent));
    const gridCls = (n) => heroBtn(px, n).evaluate((b) => [...b.classList]);
    const cardName = (k) => band(px, k).locator(".cur").textContent().catch(() => "");
    const choices = async (k) => {
      const inBand = (await favRows(px, k)).map((r) => r.name);
      await openPlayer(px, k);
      const inSheet = await px.locator("#choose-body .fav-row .fr-name").evaluateAll((xs) => xs.map((x) => x.textContent));
      await px.click("#choose-dialog [data-close]");
      return [...inBand, ...inSheet];
    };
    const chooseInSheet = async (k, n) => {
      await openPlayer(px, k);
      await px.locator("#choose-body .fav-row", { has: px.locator(".fr-name", { hasText: new RegExp(`^${esc(n)}$`) }) }).first().click();
    };

    check("incroci: «Chi soffrite di più» (nomi rossi) nascosto senza eroi scelti né alleati", (await threatNames()).length === 0);

    // un tank scelto da Fabio che compare anche tra i più pericolosi (il caso segnalato: Sigma)
    const tanks = data.heroes.filter((h) => h.role === "Tank").map((h) => itn(h.name));
    let X = null;
    for (const n of ["Sigma", ...tanks.filter((t) => t !== "Sigma")]) {
      await seed({ ...M0, picked: [heroId(n), null] });
      if ((await threatNames()).includes(n)) { X = n; break; }
    }
    check("incroci: c'è un eroe scelto che è anche tra «Chi soffrite di più»", !!X, "nessun tank scelto compare tra i pericoli");
    if (X) {
      check(`incroci: ${X} scelto → nomi rossi in vista, ${X} non ancora avversario`, (await threatNames()).length === 9
        && (await heroBtn(px, X).getAttribute("aria-pressed")) === "false");
      await heroBtn(px, X).click();
      let s = await st();
      check(`incroci: tocco su ${X} (nome rosso) → avversario E resta scelto da Fabio (mirror)`,
        has(s.enemies, X) && String(s.picked[0]) === heroId(X) && (await cardName(0)) === X
        && (await heroBtn(px, X).getAttribute("aria-pressed")) === "true" && (await text(px, "[data-count=enemies]")) === "1/5", JSON.stringify(s));
      const cls = await gridCls(X);
      check(`incroci: in griglia ${X} è sia «preso da Fabio» sia avversario`, cls.includes("took") && cls.includes("in-enemies"), cls.join(" "));
      await shot(px, "05i-mirror");
      check(`incroci: ${X} avversario non sparisce dalla fascia di Fabio (è ancora il suo eroe)`, (await pickNames(px))[0] === X);
      await heroBtn(px, X).click();
      s = await st();
      check(`incroci: secondo tocco → ${X} non più avversario, sempre scelto`, !has(s.enemies, X) && String(s.picked[0]) === heroId(X), JSON.stringify(s));
      await heroBtn(px, X).click();
      await px.reload();
      await px.locator(CARD).first().waitFor();
      s = await st();
      check("incroci: dopo il riavvio scelto e avversario restano entrambi", has(s.enemies, X) && String(s.picked[0]) === heroId(X), JSON.stringify(s));
    }

    // avversario già segnato → lo scelgo io (foglio del giocatore): resta avversario
    await seed({ ...M0, enemies: ids("Reinhardt") });
    await chooseInSheet(0, "Reinhardt");
    let s = await st();
    check("incroci: scelgo un eroe già avversario → scelto e ancora avversario", String(s.picked[0]) === heroId("Reinhardt") && has(s.enemies, "Reinhardt"), JSON.stringify(s));
    await px.locator("#toast button", { hasText: "Annulla" }).click();
    s = await st();
    check("incroci: «Annulla» la scelta → non scelto, l'avversario resta", s.picked[0] === null && has(s.enemies, "Reinhardt"), JSON.stringify(s));
    // dalla guida: «Segna: Fabio l'ha scelto»
    await chooseInSheet(0, "Reinhardt");
    await openGuideOf(px, 0);
    await px.click("#guide-body .took-btn");
    s = await st();
    check("incroci: dalla guida tolgo la scelta → l'avversario resta", s.picked[0] === null && has(s.enemies, "Reinhardt"), JSON.stringify(s));
    await px.click("#guide-body .took-btn");
    s = await st();
    check("incroci: dalla guida la segno di nuovo → scelto e avversario", String(s.picked[0]) === heroId("Reinhardt") && has(s.enemies, "Reinhardt"), JSON.stringify(s));
    await px.keyboard.press("Escape");
    await px.locator("#guide-dialog").evaluate((d) => d.open && d.close());

    // alleato e avversario insieme; alleato poi scelto da Fabio; poi bannato
    await seed({ ...M0, group: "allies" });
    await heroBtn(px, "Winston").click();
    await px.click("#groups [data-group=enemies]");
    await heroBtn(px, "Winston").click();
    s = await st();
    check("incroci: lo stesso eroe alleato e avversario (mirror)", has(s.allies, "Winston") && has(s.enemies, "Winston"), JSON.stringify(s));
    check("incroci: con un alleato «Chi soffrite di più» compare", (await threatNames()).length === 9);
    check("incroci: un alleato non compare tra le scelte di Fabio (è già di un compagno)", !(await choices(0)).includes("Winston"));
    await pickFromGrid(px, 0);
    await heroBtn(px, "Winston").click();
    s = await st();
    check("incroci: Fabio sceglie l'eroe dell'alleato → esce dagli alleati, resta avversario", String(s.picked[0]) === heroId("Winston")
      && !has(s.allies, "Winston") && has(s.enemies, "Winston") && s.group === "enemies", JSON.stringify(s));
    await px.click("#groups [data-group=allies]");
    await heroBtn(px, "Winston").click();
    s = await st();
    check("incroci: l'eroe di Fabio toccato tra gli Alleati → diventa alleato, Fabio senza scelta (una volta per squadra)",
      has(s.allies, "Winston") && s.picked[0] === null && has(s.enemies, "Winston"), JSON.stringify(s));
    await px.click("#groups [data-group=bans]");
    await heroBtn(px, "Winston").click();
    s = await st();
    check("incroci: bannato → fuori da alleati e avversari", has(s.bans, "Winston") && !has(s.allies, "Winston") && !has(s.enemies, "Winston"), JSON.stringify(s));
    check("incroci: bannato → fuori dai consigli e dalle liste", !(await pickNames(px)).includes("Winston") && !(await choices(0)).includes("Winston"));
    await px.click("#groups [data-group=enemies]");
    await heroBtn(px, "Winston").click();
    s = await st();
    check("incroci: bannato toccato tra gli Avversari → non più bannato, avversario", !has(s.bans, "Winston") && has(s.enemies, "Winston"), JSON.stringify(s));

    // scelto e bannato: il ban toglie la scelta; dai ban consigliati («BAN?») lo stesso
    await seed({ ...M0, picked: [heroId("Sigma"), null], enemies: ids("Sigma", "Ana") });
    await px.click("#groups [data-group=bans]");
    await heroBtn(px, "Sigma").click();
    s = await st();
    check("incroci: l'eroe scelto e avversario viene bannato → né scelto né avversario", has(s.bans, "Sigma") && s.picked[0] === null
      && !has(s.enemies, "Sigma") && has(s.enemies, "Ana"), JSON.stringify(s));
    const recBan = (await px.locator("#grid .hero.sugg:not(.in-bans) .nm").evaluateAll((xs) => xs.map((x) => x.textContent)))[0];
    await px.click("#groups [data-group=enemies]");
    await heroBtn(px, recBan).click();
    await px.click("#groups [data-group=bans]");
    check(`incroci: ${recBan} avversario resta tra i «BAN?»`, (await heroBtn(px, recBan).evaluate((b) => b.classList.contains("sugg"))));
    await heroBtn(px, recBan).click();
    s = await st();
    check(`incroci: avversario bannato dai ban consigliati (${recBan}) → esce dagli avversari`, has(s.bans, recBan) && !has(s.enemies, recBan), JSON.stringify(s));
    // i ban consigliati non propongono mai eroi scelti né alleati (anche se forti sulla mappa)
    for (const [tank, sup] of [["Sigma", "Mizuki"], ["Reinhardt", "Wuyang"], ["Winston", "Zenyatta"]]) {
      await seed({ ...M0, picked: [heroId(tank), null], allies: ids(sup), group: "bans" });
      const recs = await px.locator("#grid .hero.sugg .nm").evaluateAll((xs) => xs.map((x) => x.textContent));
      check(`incroci: «BAN?» mai su ${tank} (scelto) né ${sup} (alleato)`, recs.length === 9 && !recs.includes(tank) && !recs.includes(sup), recs.join());
    }
    // bannato poi scelto da Fabio dalla griglia
    await seed({ ...M0, bans: ids("Reinhardt") });
    check("incroci: un bannato non compare tra le scelte", !(await choices(0)).includes("Reinhardt"));
    await pickFromGrid(px, 0);
    await heroBtn(px, "Reinhardt").click();
    s = await st();
    check("incroci: scelgo un bannato dalla griglia → non più bannato, scelto", String(s.picked[0]) === heroId("Reinhardt") && !has(s.bans, "Reinhardt"), JSON.stringify(s));

    // un eroe preso da Giulia passa a Fabio
    await seed({ ...M0, roles: ["Tank", "Tank"], picked: [null, heroId("Sigma")] });
    await pickFromGrid(px, 0);
    await heroBtn(px, "Sigma").click();
    s = await st();
    check("incroci: l'eroe di Giulia scelto da Fabio → passa a Fabio (una volta per squadra)", String(s.picked[0]) === heroId("Sigma") && s.picked[1] === null, JSON.stringify(s));

    // limiti: 5 avversari (anche col vostro eroe tra loro), 5 ban
    await seed({ ...M0, picked: [heroId("Sigma"), null], enemies: ids("Sigma", "Ana", "Genji", "Tracer", "Lúcio") });
    await heroBtn(px, "Mercy").click();
    s = await st();
    check("incroci: 5 avversari (uno è il vostro Sigma) → il sesto è rifiutato, Sigma resta scelto", s.enemies.length === 5 && !has(s.enemies, "Mercy")
      && String(s.picked[0]) === heroId("Sigma") && (await text(px, "#toast")).includes("Al massimo 5"), JSON.stringify(s));
    await px.locator(`#slots .slot.full[data-id="${heroId("Sigma")}"]`).click();
    const s2 = await st();
    check("incroci: con 5 avversari si toglie Sigma dal suo posto → resta scelto", !has(s2.enemies, "Sigma") && String(s2.picked[0]) === heroId("Sigma"), JSON.stringify(s2));
    await seed({ ...M0, bans: ids("Ana", "Genji", "Tracer", "Lúcio", "Mercy"), group: "bans" });
    await heroBtn(px, "Kiriko").click();
    s = await st();
    check("incroci: 5 ban → il sesto è rifiutato", s.bans.length === 5 && !has(s.bans, "Kiriko"), JSON.stringify(s));

    // partita salvata da una versione precedente con stati impossibili: si sistema
    await seed({ ...M0, picked: [heroId("Sigma"), heroId("Sigma")], bans: ids("Ana", "Ana"), enemies: ids("Ana", "Genji", "Genji"), allies: ids("Sigma", "Ana", "Mercy") });
    s = await st();
    check("incroci: partita salvata incoerente → sistemata (bannato fuori da tutto, un eroe una volta per squadra)",
      String(s.picked[0]) === heroId("Sigma") && s.picked[1] === null && s.bans.length === 1 && s.enemies.length === 1 && has(s.enemies, "Genji")
      && s.allies.length === 1 && has(s.allies, "Mercy"), JSON.stringify(s));

    // «Nuova partita» azzera tutto, «Annulla» ripristina anche il mirror
    await seed({ ...M0, picked: [heroId("Sigma"), null], enemies: ids("Sigma"), allies: ids("Mercy") });
    await px.click("#new-match");
    s = await st();
    check("incroci: «Nuova partita» azzera scelte, avversari, alleati e ban", s.picked.every((x) => x === null) && !s.enemies.length && !s.allies.length && !s.bans.length);
    check("incroci: dopo «Nuova partita» niente «Chi soffrite di più»", (await threatNames()).length === 0);
    await px.locator("#toast button", { hasText: "Annulla" }).click();
    s = await st();
    check("incroci: «Annulla» ripristina Sigma scelto e avversario", String(s.picked[0]) === heroId("Sigma") && has(s.enemies, "Sigma") && has(s.allies, "Mercy"), JSON.stringify(s));
    await cx.close();
    lastPage = page;
  }

  // ---------- Stagione 5: ruolo ufficiale sopra counterwatch (Sombra Supporto mentre counterwatch la tiene nei Danni) ----------
  {
    const { ctx: cs, page: ps } = await newPage({ serviceWorkers: "block" });
    lastPage = ps;
    const fixed = { ...data, heroes: data.heroes.map((h) => (h.name === "Sombra" ? { ...h, role: "Support" } : h)),
      roleFix: [{ name: "Sombra", from: "Damage", to: "Support" }], officialOnly: ["Doctrine"],
      checked: new Date().toISOString(), sourceUpdated: new Date().toISOString() };
    await cs.route((u) => u.href.startsWith(`${BASE}data.json`), (r) => r.fulfill({ json: fixed }));
    await cs.route((u) => u.href.startsWith(`${BASE}patches.json`), (r) => r.fulfill({ json: { latest: { date: "2026-10-06", heroes: ["Sombra", "Cassidy", "Genji"] } } }));
    await ps.addInitScript(([prof, m]) => {
      if (!localStorage.getItem("owc.profile")) { localStorage.setItem("owc.profile", JSON.stringify(prof)); localStorage.setItem("owc.match", JSON.stringify(m)); }
    }, [{ players: [{ name: "Giulia", rank: "", roles: ["Support"], favorites: [heroId("Sombra"), heroId("Ana")] }], useTheory: true, guideOnly: false, onlyFavorites: true },
      { roles: ["Support"], picked: [null], pickFor: 0, mapSlug: "kings-row", side: "attack", bans: [], enemies: [], allies: [], group: "enemies" }]);
    await ps.goto(BASE);
    await ps.locator(CARD).first().waitFor();
    const blocks = await ps.evaluate(() => Object.fromEntries([...document.querySelectorAll("#grid [data-block]")].map((b) =>
      [b.dataset.block, [...b.querySelectorAll(".nm")].map((n) => n.textContent)])));
    check("Stagione 5: Sombra nella griglia dei Supporti, non più tra i Danni", blocks.Support?.includes("Sombra") && !blocks.Damage?.includes("Sombra"),
      JSON.stringify({ s: blocks.Support, d: blocks.Damage?.length }));
    check("Stagione 5: sotto la griglia, Doctrine arriverà con i dati di counterwatch",
      /Doctrine: nuovo, comparirà qui quando counterwatch avrà le statistiche/.test(await text(ps, "#grid-note")), await text(ps, "#grid-note").catch(() => ""));
    check("Stagione 5: Sombra tra i preferiti di Giulia (Supporto)", (await favRows(ps, 0)).some((r) => r.name === "Sombra"));
    await band(ps, 0).locator(`[data-id="${heroId("Sombra")}"]`).first().click();
    await openGuideOf(ps, 0);
    await ps.click("#guide-body .more-btn").catch(() => {});
    const note = await ps.locator("#guide-body [data-rolefix]").innerText().catch(() => "");
    const gtxt = await text(ps, "#guide-body");
    check("Stagione 5: «Come giocarla» avvisa che le statistiche sono del vecchio kit, teoria del kit nuovo (Hotfix)",
      /ora è Supporto \(prima Danni\)/.test(note) && /vecchio kit/.test(note) && !/Teoria da rivedere/.test(gtxt) && /Hotfix|Cyberspace/.test(gtxt),
      `${note} | ${gtxt.slice(0, 300)}`);
    await shot(ps, "18-sombra-supporto");
    await cs.close();
    lastPage = page;
  }

  // ---------- foto del tabellone: pulsante, impostazioni, Claude (simulato), foglio da confermare e correggere ----------
  {
    const { ctx: cp, page: pp } = await newPage({ serviceWorkers: "block" });
    lastPage = pp;
    const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
    const okResp = (obj) => ({ id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(obj) }], usage: { input_tokens: 3000, output_tokens: 420, cache_read_input_tokens: 2600, cache_creation_input_tokens: 0 } });
    const slot = (nickname, role, hero, sure = true, alternatives = []) => ({ nickname, role, hero, sure, alternatives });
    const ban = (hero, sure = true, alternatives = []) => ({ hero, sure, alternatives });
    const readA = { scoreboard: true, map: "King's Row", side: "attack",
      bans: [ban("Widowmaker"), ban("Zarya"), ban("Brigitte", false, ["Lifeweaver", "Baptiste"]), ban("Hanzo")],
      allies: [slot("FABIO", "Damage", "Cassidy"), slot("Giuly", "Support", "Ana", false, ["Kiriko", "Baptiste"]), slot("xXtank", "Tank", null),
        slot("Pippo", "Support", "Lúcio"), slot("Zed", "Damage", "Genji")],
      enemies: [slot("Uno", "Tank", "Winston"), slot("Due", "Damage", "Tracer", false, ["Genji"]), { ...slot("Tre", "Damage", "Cassidy"), dead: true },
        slot("Quattro", "Support", "Mercy"), slot("Cinque", "Support", null)] };
    const calls = [];
    let reply = () => ({ status: 200, json: okResp(readA) });
    await cp.route("https://api.anthropic.com/**", async (r) => {
      const req = r.request();
      if (req.method() === "OPTIONS") { await r.fulfill({ status: 204, headers: CORS }); return; }
      calls.push({ headers: req.headers(), body: req.postDataJSON() });
      const rep = await reply(calls.length);
      if (rep.delay) await new Promise((res) => setTimeout(res, rep.delay));
      if (rep.abort) { await r.abort().catch(() => {}); return; }
      await r.fulfill({ status: rep.status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(rep.json) }).catch(() => {});
    });
    // ritratti ufficiali (copiati dal workflow, qui assenti): un'immagine qualsiasi, così si costruisce il foglio di riferimento
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
    await cp.route((u) => u.href.startsWith(`${BASE}heroes/`), (r) => r.fulfill({ status: 200, contentType: "image/png", body: png }));
    await pp.addInitScript((prof) => {
      if (!localStorage.getItem("owc.profile")) localStorage.setItem("owc.profile", JSON.stringify(prof));
    }, { players: [{ name: "Fabio", rank: "", roles: ["Damage"], favorites: [] }, { name: "Giulia", rank: "", roles: ["Support"], favorites: [] }] });
    await pp.goto(BASE);
    await pp.locator(CARD).first().waitFor();
    const shotBuf = await pp.screenshot(); // la "foto" del tabellone: 780×1688, viene ridotta a 1600 di lato lungo

    // pulsante grande, esattamente al centro della barra in basso
    const dock = await pp.evaluate(() => {
      const b = document.querySelector("#photo-btn").getBoundingClientRect();
      const tabs = [...document.querySelectorAll(".dock button:not(#photo-btn)")].map((x) => x.getBoundingClientRect());
      return { w: b.width, h: b.height, left: b.left, right: b.right, vw: window.innerWidth, bottom: b.bottom, vh: window.innerHeight,
        bg: getComputedStyle(document.querySelector("#photo-btn")).backgroundColor, text: document.querySelector("#photo-btn").textContent.trim(),
        overlap: tabs.some((t) => t.right > b.left + 1 && t.left < b.right - 1), maxTab: Math.max(...tabs.map((t) => t.width)) };
    });
    check("foto: «FOTO» arancione nella barra in basso, il pulsante più largo, sopra il centro dello schermo", dock.h >= 48 && dock.w > dock.maxTab
      && dock.left < dock.vw / 2 && dock.right > dock.vw / 2 && Math.abs(dock.bottom - dock.vh) <= 1 && !dock.overlap && dock.text === "Foto"
      && dock.bg === "rgb(249, 158, 26)", JSON.stringify(dock));
    await shot(pp, "19a-foto-pulsante");

    // prima volta: chiave e nomi nel gioco, poi subito la fotocamera
    await pp.click("#photo-btn");
    await pp.locator("#photo-setup[open]").waitFor();
    check("foto: la prima volta chiede la chiave e il nome nel gioco di ciascuno",
      await pp.locator("#ps-key").isVisible() && await pp.locator("#ps-nick0").isVisible() && await pp.locator("#ps-nick1").isVisible()
      && /Fabio/.test(await text(pp, "#photo-setup-body")) && /Giulia/.test(await text(pp, "#photo-setup-body")));
    await pp.fill("#ps-key", "sk-ant-test-123");
    await pp.fill("#ps-nick0", "Fabio");
    await pp.fill("#ps-nick1", "Giuly");
    await shot(pp, "19b-foto-impostazioni");
    let [fc] = await Promise.all([pp.waitForEvent("filechooser"), pp.click("#ps-go")]);
    check("foto: «Salva e scatta» apre la fotocamera", !!fc && await fc.element().evaluate((i) => i.id === "photo-input" && i.getAttribute("capture") === "environment"));
    const saved = await pp.evaluate(() => ({ key: JSON.parse(localStorage.getItem("owc.claudeKey")), prof: JSON.parse(localStorage.getItem("owc.profile")) }));
    check("foto: chiave e nomi salvati solo sul telefono", saved.key === "sk-ant-test-123" && saved.prof.players[1].nick === "Giuly" && saved.prof.photoSetupSeen);
    reply = () => ({ status: 200, json: okResp(readA), delay: 700 });
    await fc.setFiles({ name: "tabellone.png", mimeType: "image/png", buffer: shotBuf });
    await pp.locator("#photo-dialog[open] .ph-spin").waitFor();
    const matchBeforePhoto = JSON.stringify(await matchState(pp));
    await shot(pp, "19c-foto-lettura");
    await pp.locator("#ph-confirm").waitFor();

    const c0 = calls[0];
    const imgs = c0.body.messages[0].content.filter((b) => b.type === "image");
    const nickTxt = c0.body.messages[0].content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    check("foto: richiesta a Claude Sonnet 5.5 con chiave, versione e accesso dal browser",
      c0.headers["x-api-key"] === "sk-ant-test-123" && c0.headers["anthropic-version"] === "2026-10-21"
      && c0.headers["anthropic-dangerous-direct-browser-access"] === "true" && c0.headers["anthropic-beta"] === "server-side-fallback-2026-07-01"
      && c0.body.model === "claude-sonnet-5-5" && c0.body.fallbacks === "default" && c0.body.output_config.format.type === "json_schema",
      JSON.stringify({ h: c0.headers, m: c0.body.model }));
    const photoDims = await pp.evaluate((b64) => new Promise((ok) => { const i = new Image(); i.onload = () => ok([i.naturalWidth, i.naturalHeight]); i.src = `data:image/jpeg;base64,${b64}`; }), imgs[1].source.data);
    check("foto: foglio dei ritratti + foto ridotta (lato lungo 1600) + vostri nomi", imgs.length === 2 && imgs[0].cache_control
      && Math.max(...photoDims) === 1600 && /Fabio, Giuly/.test(nickTxt), JSON.stringify({ n: imgs.length, photoDims, nickTxt }));
    check("foto: mappe nell'elenco dello schema col nome dei dati", c0.body.output_config.format.schema.properties.map.anyOf[0].enum.includes("King's Row"));

    // riepilogo a colpo d'occhio (primo foglio): come il tabellone, nell'ordine della foto, tutto in vista senza scorrere
    const sbRows = (key) => pp.locator(`#photo-body .sb-${key} .sb-row`).evaluateAll((rs) => rs.map((r) => ({
      hero: r.querySelector(".sb-hero").textContent, nick: r.querySelector(".sb-nick").textContent,
      who: r.querySelector(".sb-who")?.textContent ?? null, doubt: !!r.querySelector(".ph-badge"), role: r.querySelector(".sb-role").className })));
    let sbo = await sbRows("ours");
    let sbe = await sbRows("enemies");
    check("riepilogo: le due squadre nell'ordine della foto, con chi è chi", sbo.map((r) => r.nick).join() === "FABIO,Giuly,xXtank,Pippo,Zed"
      && sbe.map((r) => r.nick).join() === "Uno,Due,Tre,Quattro,Cinque" && sbo.map((r) => r.hero).join() === "Cassidy,Ana,Non scelto,Lúcio,Genji"
      && sbe.map((r) => r.hero).join() === "Winston,Tracer,Cassidy,Mercy,Non scelto"
      && sbo[0].who === "Fabio" && sbo[1].who === "Giulia" && sbo[3].who === null, JSON.stringify(sbo));
    check("riepilogo: incerti con «?» (Ana, Tracer, un ban)", sbo[1].doubt && sbe[1].doubt && !sbo[0].doubt
      && (await pp.locator("#photo-body .sb-ban .ph-badge").count()) === 1 && /3 incerti \(\?\)/.test(await text(pp, "#photo-body")));
    check("riepilogo: icona del ruolo anche per chi non ha scelto (Tank)", /r-Tank/.test(sbo[2].role) && /r-Damage/.test(sbo[0].role));
    check("riepilogo: chi è morto (ritratto grigio nella foto) ha il volto grigio, non scurito, come sullo schermo",
      await pp.locator("#photo-body .sb-enemies .sb-row").nth(2).evaluate((r) => r.classList.contains("dead") && getComputedStyle(r.querySelector(".face")).filter === "grayscale(1)")
      && (await pp.locator("#photo-body .sb-row.dead").count()) === 1);
    check("riepilogo: in alto mappa, Attacco/Difesa e i 4 ban", /king's row/i.test(await text(pp, "#ph-map")) && /Letta dalla foto/.test(await text(pp, "#ph-map-note"))
      && await pp.locator("#photo-body .sb-side [data-side=attack]").getAttribute("aria-pressed") === "true"
      && (await pp.locator("#photo-body .sb-ban").count()) === 4);
    const fitsSb = await pp.evaluate(() => { const d = document.querySelector("#photo-dialog"); return [d.scrollHeight, d.clientHeight]; });
    check("riepilogo: tutto in vista senza scorrere (390×844)", fitsSb[0] <= fitsSb[1] + 1, JSON.stringify(fitsSb));
    const planShown = await pp.locator("#photo-body .sc .sc-row").evaluateAll((rs) => rs.map((r) => r.dataset.player));
    check("riepilogo: «Se confermi», una riga per giocatore in partita (ritratto di chi ha → mossa)", planShown.join() === "0,1"
      && /Se confermi/.test(await text(pp, "#photo-body .sc")), JSON.stringify(planShown));
    check("riepilogo: «Se confermi» non tocca la partita finché non si conferma", JSON.stringify(await matchState(pp)) === matchBeforePhoto);
    await shot(pp, "19c2-foto-riepilogo");
    // un tocco su una riga del riepilogo la cambia subito (solita lista), senza passare da «Modifica»
    await pp.locator("#photo-body .sb-enemies .sb-row").nth(3).click();
    await pp.locator("#photo-hero[open]").waitFor();
    await pp.fill("#photo-q", "moira");
    await pp.press("#photo-q", "Enter");
    await pp.locator("#photo-hero").waitFor({ state: "hidden" });
    check("riepilogo: tocco su una riga → Moira al posto di Mercy, sempre nel riepilogo", (await sbRows("enemies"))[3].hero === "Moira" && await pp.locator("#ph-edit").isVisible());
    await pp.locator("#photo-body .sb-enemies .sb-row").nth(3).click();
    await pp.fill("#photo-q", "mercy");
    await pp.press("#photo-q", "Enter");
    await pp.locator("#photo-hero").waitFor({ state: "hidden" });
    // telefoni dell'utente: Xiaomi 14T (~407×833) e Nothing Phone (3) (~420×860), sempre senza scorrere
    for (const [w, h] of [[407, 833], [420, 860]]) {
      await pp.setViewportSize({ width: w, height: h });
      await pp.waitForTimeout(100);
      const f = await pp.evaluate(() => { const d = document.querySelector("#photo-dialog"); return [d.scrollHeight, d.clientHeight, document.documentElement.scrollWidth - innerWidth]; });
      check(`riepilogo: tutto in vista anche su ${w}×${h}`, f[0] <= f[1] + 1 && f[2] <= 0, JSON.stringify(f));
    }
    await pp.setViewportSize({ width: 390, height: 844 });
    await pp.click("#ph-edit");
    check("«Modifica» apre il foglio completo (con «‹ Riepilogo»)", await pp.locator("#photo-body .ph-ours .ph-row").count() === 5 && await pp.locator("#ph-back").isVisible());
    // il foglio: mappa letta, lato, le due squadre con i giocatori dell'app riconosciuti
    const rowsOf = (key) => pp.locator(`#photo-body .ph-${key} .ph-row`).evaluateAll((rs) => rs.map((r) => ({
      hero: r.querySelector(".ph-hname").textContent, nick: r.querySelector(".ph-nick").textContent, owner: r.querySelector(".ph-owner")?.textContent ?? null,
      doubt: !!r.querySelector(".ph-hero.doubt"), alts: [...r.querySelectorAll(".ph-alt")].map((a) => a.textContent) })));
    let ours = await rowsOf("ours");
    let foes = await rowsOf("enemies");
    check("foto: mappa letta (King's Row, «Letta dalla foto») e Attacco segnato",
      /King's Row/.test(await text(pp, "#ph-map")) && /Letta dalla foto/.test(await text(pp, "#ph-map-note"))
      && await pp.locator("#photo-body .ph-side [data-side=attack]").getAttribute("aria-pressed") === "true");
    check("foto: 5 alleati e 5 avversari; Fabio e Giulia riconosciuti dai nomi nel gioco (FABIO, Giuly)",
      ours.length === 5 && foes.length === 5 && ours[0].owner.includes("Fabio") && ours[1].owner.includes("Giulia") && ours[3].owner === "Alleato", JSON.stringify(ours));
    check("foto: eroe incerto con «?» e gli altri possibili accanto (Ana → Kiriko, Baptiste)",
      ours[1].doubt && ours[1].alts.join() === "Kiriko,Baptiste" && !ours[0].doubt && foes[1].doubt && foes[1].alts.join() === "Genji", JSON.stringify([ours[1], foes[1]]));
    check("foto: chi non ha ancora scelto resta «Non scelto»", ours[2].hero === "Non scelto" && foes[4].hero === "Non scelto");
    // ban: in alto a destra sotto la mappa → fila di 4 nel foglio, l'incerto con le alternative
    const bansOf = () => pp.locator("#photo-body .ph-ban").evaluateAll((bs) => bs.map((b) => ({
      hero: b.querySelector(".ph-hname").textContent, doubt: b.classList.contains("doubt") })));
    let bans = await bansOf();
    check("foto: ban letti dalla foto (Widowmaker, Zarya, Brigitte incerta, Hanzo)",
      bans.map((b) => b.hero).join() === "Widowmaker,Zarya,Brigitte,Hanzo" && bans[2].doubt && !bans[0].doubt
      && /Letti dalla foto/.test(await text(pp, "#ph-ban-note")) && /Lifeweaver/.test(await text(pp, "#photo-body .ph-ban-alts")), JSON.stringify(bans));
    await shot(pp, "19d-foto-risultato");
    // nomi nei riquadrini mai spezzati a metà parola, anche col carattere di sistema al 130% (WebView)
    const broken = await pp.evaluate(() => {
      document.documentElement.style.fontSize = "130%";
      const out = [];
      for (const t of document.querySelectorAll("#photo-body .ph-hname")) {
        t.style.fontSize = "calc(15px * var(--fit, 1))"; // 11.5 px × 130%
        window.owcFitText(t);
        const words = t.textContent.split(/\s+/).length;
        const lines = Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight));
        if (lines > words || t.scrollWidth > t.clientWidth + 1) out.push(t.textContent);
        t.style.fontSize = "";
        window.owcFitText(t);
      }
      document.documentElement.style.fontSize = "";
      return out;
    });
    check("foto: nomi dei riquadrini mai spezzati (anche al 130%)", broken.length === 0, broken.join(", "));
    await pp.locator("#photo-body .ph-ban-alts .ph-alt", { hasText: "Lifeweaver" }).click();
    bans = await bansOf();
    check("foto: tocco sull'alternativa del ban → Lifeweaver al posto di Brigitte", bans[2].hero === "Lifeweaver" && !bans[2].doubt, JSON.stringify(bans));
    await pp.locator("#photo-body .ph-ban").nth(0).click();
    await pp.locator("#photo-hero[open]").waitFor();
    check("foto: ban da correggere con la solita lista (titolo «Ban 1», i ban segnati)", await text(pp, "#t-photo-hero") === "Ban 1"
      && (await pp.locator("#photo-grid .hero.in-bans").count()) === 4);
    await pp.locator("#photo-grid .hero", { has: pp.locator(".nm", { hasText: /^Cassidy$/ }) }).click();
    check("foto: un ban che è in campo viene segnalato", /Cassidy è in campo: non lo segno tra i ban/.test(await text(pp, "#photo-body .ph-bans")));
    await pp.locator("#photo-body .ph-ban").nth(0).click();
    await pp.fill("#photo-q", "widow");
    await pp.press("#photo-q", "Enter");
    await pp.locator("#photo-hero").waitFor({ state: "hidden" });
    check("foto: e si rimette Widowmaker", (await bansOf())[0].hero === "Widowmaker" && !/in campo/.test(await text(pp, "#photo-body .ph-bans")));

    // un tocco su un'alternativa la mette al posto dell'incerto (che resta tra le alternative)
    await pp.locator("#photo-body .ph-ours .ph-row").nth(1).locator(".ph-alt", { hasText: "Kiriko" }).click();
    ours = await rowsOf("ours");
    check("foto: tocco su «Kiriko» → Kiriko al posto di Ana, Ana tra le alternative, niente più «?»",
      ours[1].hero === "Kiriko" && ours[1].alts.includes("Ana") && !ours[1].doubt, JSON.stringify(ours[1]));
    // correggere un eroe: la solita lista per ruolo + ricerca
    await pp.locator("#photo-body .ph-enemies .ph-hero").nth(0).click();
    await pp.locator("#photo-hero[open]").waitFor();
    const blocks = await pp.locator("#photo-grid [data-block]").evaluateAll((bs) => bs.map((b) => b.dataset.block));
    check("foto: correzione con la lista divisa per ruolo e la ricerca", blocks.join() === "Tank,Damage,Support"
      && (await pp.locator("#photo-grid .hero").count()) === data.heroes.length && /Uno/.test(await text(pp, "#t-photo-hero")));
    check("foto: nella lista l'eroe attuale è premuto e quelli già in squadra segnati",
      await pp.locator("#photo-grid .hero[aria-pressed=true] .nm").textContent() === "Winston" && (await pp.locator("#photo-grid .hero.in-enemies").count()) === 4);
    await pp.fill("#photo-q", "rein");
    check("foto: la ricerca filtra la lista", (await pp.locator("#photo-grid .hero:not([hidden])").count()) === 1);
    await shot(pp, "19e-foto-scegli-eroe");
    await pp.press("#photo-q", "Enter");
    await pp.locator("#photo-hero").waitFor({ state: "hidden" });
    foes = await rowsOf("enemies");
    check("foto: Invio sceglie Reinhardt al posto di Winston", foes[0].hero === "Reinhardt", JSON.stringify(foes[0]));
    // stesso eroe due volte nella stessa squadra: chi lo aveva prende quello di prima
    await pp.locator("#photo-body .ph-ours .ph-hero").nth(4).click();
    await pp.locator("#photo-hero[open]").waitFor();
    await pp.locator("#photo-grid .hero", { has: pp.locator(".nm", { hasText: /^Cassidy$/ }) }).click();
    ours = await rowsOf("ours");
    check("foto: un eroe una volta per squadra (Cassidy a Zed, Genji passa a FABIO)", ours[4].hero === "Cassidy" && ours[0].hero === "Genji", JSON.stringify(ours.map((r) => r.hero)));
    await pp.locator("#photo-body .ph-ours .ph-hero").nth(0).click();
    await pp.locator("#photo-hero[open]").waitFor();
    await pp.locator("#photo-grid .hero", { has: pp.locator(".nm", { hasText: /^Cassidy$/ }) }).click();
    ours = await rowsOf("ours");
    check("foto: e si torna indietro allo stesso modo", ours[0].hero === "Cassidy" && ours[4].hero === "Genji");
    // "Nessun eroe": la riga torna «Non scelto»
    await pp.locator("#photo-body .ph-enemies .ph-hero").nth(2).click();
    await pp.locator("#photo-hero[open]").waitFor();
    await pp.click("#photo-none");
    foes = await rowsOf("enemies");
    check("foto: «Nessun eroe» svuota la riga", foes[2].hero === "Non scelto");
    // chi è chi: il tocco sul nome cambia giocatore (uno per riga)
    await pp.locator("#photo-body .ph-ours .ph-owner").nth(3).click();
    ours = await rowsOf("ours");
    check("foto: tocco su «Alleato» → la riga diventa di Fabio (e la sua di prima torna alleato)", ours[3].owner.includes("Fabio") && ours[0].owner === "Alleato", JSON.stringify(ours.map((r) => r.owner)));
    await pp.locator("#photo-body .ph-ours .ph-owner").nth(3).click();
    await pp.locator("#photo-body .ph-ours .ph-owner").nth(3).click();
    ours = await rowsOf("ours");
    check("foto: un altro tocco passa a Giulia, poi di nuovo Alleato", ours.every((r) => r.owner === "Alleato"), JSON.stringify(ours.map((r) => r.owner)));
    await pp.locator("#photo-body .ph-ours .ph-owner").nth(1).click();
    await pp.locator("#photo-body .ph-ours .ph-owner").nth(1).click();
    await pp.locator("#photo-body .ph-ours .ph-owner").nth(0).click();
    ours = await rowsOf("ours");
    check("foto: e indietro (Fabio, Giulia, alleati)", ours[0].owner.includes("Fabio") && ours[1].owner.includes("Giulia") && ours[3].owner === "Alleato", JSON.stringify(ours.map((r) => r.owner)));
    // la mappa letta si cambia; si può anche togliere
    await pp.click("#ph-map");
    await pp.locator("#map-dialog[open]").waitFor();
    check("foto: la scelta mappa parte da quella letta", await pp.locator("#map-list [data-map=kings-row]").getAttribute("aria-pressed") === "true");
    await pp.click("#map-list [data-map=lijiang-tower]");
    check("foto: mappa cambiata (Lijiang, «Scelta da te»), lato nascosto per il Controllo, il foglio resta aperto",
      /Lijiang/.test(await text(pp, "#ph-map")) && /Scelta da te/.test(await text(pp, "#ph-map-note")) && !(await pp.locator("#photo-body .ph-side").count())
      && await pp.locator("#photo-dialog").evaluate((d) => d.open) && (await matchState(pp)).mapSlug == null);
    await pp.click("#ph-map");
    await pp.click("#map-list [data-map=kings-row]");
    await pp.locator("#photo-body .ph-side [data-side=defense]").click();
    check("foto: lato cambiato a mano", await pp.locator("#photo-body .ph-side [data-side=defense]").getAttribute("aria-pressed") === "true"
      && /scelto da te/.test(await text(pp, "#photo-body .ph-head")));
    const noScroll = await pp.evaluate(() => document.querySelector("#photo-dialog").scrollWidth <= document.querySelector("#photo-dialog").clientWidth);
    const confirmVisible = await pp.locator("#ph-confirm").evaluate((b) => { const r = b.getBoundingClientRect(); return r.bottom <= window.innerHeight && r.top >= 0; });
    check("foto: «Conferma» sempre in vista, niente scorrimento orizzontale", noScroll && confirmVisible);
    // conferma: la partita si compila; le fasce dicono quello che diceva «Se confermi»
    const plan = await pp.evaluate(() => window.owcPhotoPlan());
    await pp.click("#ph-confirm");
    await pp.locator("#photo-dialog").waitFor({ state: "hidden" });
    let st = await matchState(pp);
    check("foto: confermata → mappa, lato, eroi presi da Fabio e Giulia, alleati e avversari",
      st.mapSlug === "kings-row" && st.side === "defense" && String(st.picked[0]) === heroId("Cassidy") && String(st.picked[1]) === heroId("Kiriko")
      && st.allies.map(String).join() === [heroId("Lúcio"), heroId("Genji")].join() && st.enemies.map(String).join() === [heroId("Reinhardt"), heroId("Tracer"), heroId("Mercy")].join()
      && st.bans.map(String).join() === ["Widowmaker", "Zarya", "Lifeweaver", "Hanzo"].map(heroId).join(),
      JSON.stringify(st));
    check("foto: messaggio con «Annulla»", /compilata dalla foto/.test(await text(pp, "#toast")) && await pp.locator("#toast button", { hasText: "Annulla" }).isVisible());
    check("foto: le fasce mostrano nel ritratto grande gli eroi presi (Cassidy, Kiriko)", (await pickNames(pp)).join() === "Cassidy,Kiriko"
      && (await portraitsOk(pp)).length === 0, (await pickNames(pp)).join());
    const bandsNow = await pp.evaluate(() => window.owcBands());
    check("foto: «Se confermi» coerente con le fasce dopo la conferma (chi ha cosa, e la mossa)",
      plan && plan.length === bandsNow.length && plan.every((x, k) => x.player === bandsNow[k].player && x.has === bandsNow[k].has && x.move === bandsNow[k].move),
      JSON.stringify({ plan, bandsNow }));
    await toTop(pp);
    await shot(pp, "19f-foto-confermata");
    await pp.locator("#toast button", { hasText: "Annulla" }).click();
    st = await matchState(pp);
    check("foto: «Annulla» ripristina la partita di prima", !st.mapSlug && !st.enemies.length && st.picked.every((x) => !x), JSON.stringify(st));

    // mappa non riconosciuta (e nessuna scelta prima): lo dice, e si conferma anche senza
    reply = () => ({ status: 200, json: okResp({ ...readA, map: null, side: null }) });
    [fc] = await Promise.all([pp.waitForEvent("filechooser"), pp.click("#photo-btn")]);
    await fc.setFiles({ name: "t2.png", mimeType: "image/png", buffer: shotBuf });
    await pp.locator("#ph-confirm").waitFor();
    check("foto: la seconda volta niente impostazioni, subito la fotocamera", calls.length === 2);
    check("foto: mappa non riconosciuta → lo dice, «Nessuna mappa»", /Mappa non riconosciuta/.test(await text(pp, "#ph-map-note")) && /nessuna/i.test(await text(pp, "#ph-map")));
    await shot(pp, "19g-foto-senza-mappa");
    await pp.click("#ph-confirm");
    st = await matchState(pp);
    check("foto: confermata senza mappa", st.mapSlug === null && st.enemies.length === 4, JSON.stringify(st));
    // chi gioca lo dice la foto: Giulia (Giuly) non c'è → fuori da questa partita, le altre righe sono alleati
    const readNoG = { ...readA, allies: readA.allies.map((r, k) => (k === 1 ? { ...r, nickname: "Pluto", sure: true, alternatives: [] } : r)),
      // un avversario morto che Claude non riesce a riconoscere: al suo posto la sua ipotesi più probabile, mai «Non scelto»
      enemies: readA.enemies.map((r, k) => (k === 4 ? { ...r, hero: null, dead: true, sure: true, alternatives: ["Zenyatta", "Mercy"] } : r)) };
    const snap = async (read, name) => {
      reply = () => ({ status: 200, json: okResp(read) });
      [fc] = await Promise.all([pp.waitForEvent("filechooser"), pp.click("#photo-btn")]);
      await fc.setFiles({ name, mimeType: "image/png", buffer: shotBuf });
      await pp.locator("#ph-confirm").waitFor();
    };
    await snap(readNoG, "g1.png");
    check("presenza: Giulia non è nella foto → lo dice il riepilogo", /Giulia non è nella foto: fuori da questa partita/.test(await text(pp, "#photo-body"))
      && (await sbRows("ours"))[1].who === null);
    const fits2 = await pp.evaluate(() => { const d = document.querySelector("#photo-dialog"); return [d.scrollHeight, d.clientHeight]; });
    check("riepilogo con più avvisi: sempre tutto in vista (390×844)", fits2[0] <= fits2[1] + 1, JSON.stringify(fits2));
    const deadRow = (await sbRows("enemies"))[4];
    check("morto non riconosciuto: al suo posto l'ipotesi più probabile (Zenyatta) col «?»", deadRow.hero === "Zenyatta" && deadRow.doubt
      && !/Chi è|Non riconosciuto/.test(await text(pp, "#photo-body")), JSON.stringify(deadRow));
    await pp.click("#ph-edit");
    const deadAlts = await pp.locator("#photo-body .ph-enemies .ph-row").nth(4).locator(".ph-alt").allInnerTexts();
    check("…e nel foglio completo le altre ipotesi come alternative (Mercy)", deadAlts.join() === "Mercy", deadAlts.join());
    await pp.click("#ph-back");
    await shot(pp, "19j-foto-senza-giulia");
    await pp.click("#ph-confirm");
    st = await matchState(pp);
    check("presenza: confermata → una sola fascia (Fabio), Giulia fuori, 3 alleati (Ana compresa)", (await pp.locator(CARD).count()) === 1
      && st.away.join() === "false,true" && st.picked[1] === null && st.allies.map(String).includes(heroId("Ana")) && st.allies.length === 3
      && /Giulia non in partita/.test(await text(pp, "#toast")), JSON.stringify(st));
    check("presenza: «Non in questa partita: Giulia», un tocco per rimetterla", await pp.locator("#away .away-chip", { hasText: "Giulia" }).isVisible());
    await toTop(pp);
    await shot(pp, "19k-giulia-fuori");
    await pp.locator("#away .away-chip").click();
    check("presenza: un tocco la rimette (due fasce)", (await pp.locator(CARD).count()) === 2 && (await matchState(pp)).away.join() === "false,false"
      && await pp.locator("#away").isHidden());
    await snap(readNoG, "g2.png");
    await pp.click("#ph-confirm");
    check("presenza: di nuovo fuori con la foto", (await pp.locator(CARD).count()) === 1);
    await pp.click("#new-match");
    check("presenza: «Nuova partita» non la rimette (lo decide la prossima foto)", (await pp.locator(CARD).count()) === 1);
    await snap(readA, "g3.png");
    check("presenza: nella foto dopo c'è di nuovo → riconosciuta", (await sbRows("ours"))[1].who === "Giulia");
    await pp.click("#ph-confirm");
    st = await matchState(pp);
    check("presenza: e rientra da sola (due fasce, il suo eroe preso)", (await pp.locator(CARD).count()) === 2 && st.away.join() === "false,false"
      && String(st.picked[1]) === heroId("Ana") && /Giulia di nuovo in partita/.test(await text(pp, "#toast")), JSON.stringify(st));
    // con la mappa già scelta nella partita: la foto senza mappa la lascia com'è
    await pp.click("#map-btn");
    await pp.click("#map-list [data-map=kings-row]");
    reply = () => ({ status: 200, json: okResp({ ...readA, map: null, side: null }) });
    [fc] = await Promise.all([pp.waitForEvent("filechooser"), pp.click("#photo-btn")]);
    await fc.setFiles({ name: "t3.png", mimeType: "image/png", buffer: shotBuf });
    await pp.locator("#ph-confirm").waitFor();
    check("foto: mappa non letta ma già scelta → resta quella e lo dice", /king's row/i.test(await text(pp, "#ph-map"))
      && /resta quella scelta prima/.test(await text(pp, "#ph-map-note")));
    await pp.click("#photo-body .sb-ours .sb-row >> nth=0");
    await pp.locator("#photo-hero[open]").waitFor();
    await pp.press("#photo-hero", "Escape");
    await pp.locator("#photo-hero").waitFor({ state: "hidden" });
    check("foto: chiudere la lista non chiude il foglio", await pp.locator("#photo-dialog").evaluate((d) => d.open));
    await pp.click("#photo-dialog .dlg-head .close");
    await pp.locator("#photo-dialog").waitFor({ state: "hidden" });
    st = await matchState(pp);
    check("foto: chiuso con ×, la partita non cambia", st.mapSlug === "kings-row" && st.enemies.length === 4, JSON.stringify(st));

    // nessun tabellone nella foto
    reply = () => ({ status: 200, json: okResp({ scoreboard: false, map: null, side: null, allies: [], enemies: [] }) });
    [fc] = await Promise.all([pp.waitForEvent("filechooser"), pp.click("#photo-btn")]);
    await fc.setFiles({ name: "t4.png", mimeType: "image/png", buffer: shotBuf });
    await pp.locator("#ph-confirm").waitFor();
    check("foto senza tabellone: lo dice e lascia compilare a mano", /non vedo il tabellone/.test(await text(pp, "#photo-body"))
      && (await pp.locator("#photo-body .sb-row").count()) === 10);
    check("foto senza ban (partita rapida): restano i ban già segnati e lo dice",
      /già segnati/.test(await text(pp, "#photo-body .sb-bans")) && (await pp.locator("#photo-body .sb-ban").count()) === 4);
    await pp.click("#ph-edit");
    check("…e nel foglio completo", /restano quelli segnati prima/.test(await text(pp, "#ph-ban-note"))
      && (await bansOf()).map((b) => b.hero).join() === "Widowmaker,Zarya,Brigitte,Hanzo", JSON.stringify(await bansOf()));
    await pp.click("#ph-back");

    // errori: chiave non valida, rete assente, poi «Riprova»
    reply = () => ({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } });
    [fc] = await Promise.all([pp.waitForEvent("filechooser"), pp.click("#ph-retake")]);
    await fc.setFiles({ name: "t5.png", mimeType: "image/png", buffer: shotBuf });
    await pp.locator("#photo-body .ph-warn[role=alert]").waitFor();
    check("foto: chiave rifiutata → messaggio chiaro e «Cambia chiave»", /chiave API non è valida/.test(await text(pp, "#photo-body"))
      && await pp.locator("#photo-body button", { hasText: "Cambia chiave" }).isVisible());
    await shot(pp, "19h-foto-errore");
    reply = () => ({ abort: true });
    await pp.locator("#photo-body button", { hasText: "Cambia chiave" }).click();
    await pp.locator("#photo-setup[open]").waitFor();
    await pp.fill("#ps-key", "sk-ant-nuova");
    await pp.click("#ps-go");
    await pp.locator("#photo-body .ph-warn[role=alert]").waitFor();
    check("foto: chiave nuova e «Salva e riprova» rimanda la stessa foto; senza rete lo dice",
      calls[calls.length - 1].headers["x-api-key"] === "sk-ant-nuova" && /Nessuna connessione/.test(await text(pp, "#photo-body")));
    reply = () => ({ status: 200, json: okResp(readA) });
    await pp.locator("#photo-body button", { hasText: "Riprova" }).click();
    await pp.locator("#ph-confirm").waitFor();
    check("foto: «Riprova» funziona", (await sbRows("ours"))[0].hero === "Cassidy");

    // ripiego su un altro modello non attivo per la chiave: si riprova una volta senza
    const before = calls.length;
    reply = (n) => (n === before + 1 ? { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "fallbacks: beta not enabled" } } } : { status: 200, json: okResp(readA) });
    [fc] = await Promise.all([pp.waitForEvent("filechooser"), pp.click("#ph-retake")]);
    await fc.setFiles({ name: "t6.png", mimeType: "image/png", buffer: shotBuf });
    for (let i = 0; i < 50 && calls.length < before + 2; i++) await pp.waitForTimeout(100);
    await pp.locator("#ph-confirm").waitFor();
    const last = calls[calls.length - 1];
    check("foto: fallback rifiutato → seconda richiesta senza fallback, risultato mostrato", calls.length === before + 2 && !last.body.fallbacks && !last.headers["anthropic-beta"]);

    // chiudere durante la lettura annulla
    reply = () => ({ status: 200, json: okResp(readA), delay: 1500 });
    const stBefore = JSON.stringify(await matchState(pp));
    [fc] = await Promise.all([pp.waitForEvent("filechooser"), pp.click("#ph-retake")]);
    await fc.setFiles({ name: "t7.png", mimeType: "image/png", buffer: shotBuf });
    await pp.locator("#photo-dialog .ph-spin").waitFor();
    await pp.locator("#photo-body button", { hasText: "Annulla" }).click();
    await pp.waitForTimeout(1900);
    check("foto: «Annulla» durante la lettura chiude e non cambia nulla", !(await pp.locator("#photo-dialog").evaluate((d) => d.open))
      && JSON.stringify(await matchState(pp)) === stBefore);

    // al massimo 5 foto in memoria
    check("foto: al massimo 5 foto tenute in memoria (scattate più di 5)", await pp.evaluate(() => window.owcPhotos()) === 5, String(await pp.evaluate(() => window.owcPhotos())));

    // Profilo: nome nel gioco per ciascuno e la chiave
    await pp.click(".tabs [data-view=profile]");
    check("foto: nel Profilo il nome nel gioco di ognuno e la chiave salvata",
      await pp.inputValue("#p0-nick") === "Fabio" && await pp.inputValue("#p1-nick") === "Giuly"
      && /salvata/.test(await pp.getAttribute("#claude-key", "placeholder")) && await pp.inputValue("#claude-key") === "");
    await pp.locator("#photo-card").scrollIntoViewIfNeeded();
    await shot(pp, "19i-foto-profilo");
    await pp.click("#claude-clear");
    check("foto: «Rimuovi» cancella la chiave", await pp.evaluate(() => localStorage.getItem("owc.claudeKey")) === null);
    await pp.click(".tabs [data-view=match]");
    await pp.click("#photo-btn");
    check("foto: senza chiave il pulsante richiede la chiave (cursore già nel campo)", await pp.locator("#photo-setup[open]").isVisible()
      && await pp.evaluate(() => document.activeElement && document.activeElement.id === "ps-key"));
    // con la tastiera: Invio passa al campo dopo, dall'ultimo al pulsante, e un altro Invio scatta (come sull'emulatore)
    await pp.keyboard.type("sk-ant-tastiera");
    await pp.keyboard.press("Enter");
    const after1 = await pp.evaluate(() => document.activeElement.id);
    await pp.keyboard.press("Enter");
    await pp.keyboard.press("Enter");
    const after3 = await pp.evaluate(() => document.activeElement.id);
    // (il selettore file simulato di Playwright non si apre da tastiera dopo il primo uso: qui si controlla che il
    // pulsante venga premuto; l'apertura della fotocamera dai tocchi è provata sopra, quella da Invio sull'emulatore)
    [fc] = await Promise.all([pp.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null), pp.keyboard.press("Enter")]);
    check("foto: con Invio dalla chiave ai nomi, al pulsante e poi «Salva e scatta»", after1 === "ps-nick0" && after3 === "ps-go"
      && !(await pp.locator("#photo-setup").evaluate((d) => d.open))
      && await pp.evaluate(() => JSON.parse(localStorage.getItem("owc.claudeKey"))) === "sk-ant-tastiera", `${after1} ${after3}`);
    if (fc) await fc.setFiles([]);
    await cp.close();
    lastPage = page;
  }

  // ---------- revisione del 2026-11-25: tocchi persi, versione nuova, ban della foto, indietro, stato vecchio, … ----------
  {
    const P2 = [{ name: "Fabio", nick: "FABIO", rank: "", roles: ["Damage"], favorites: [] },
      { name: "Giulia", nick: "Giuly", rank: "", roles: ["Support"], favorites: [] }];
    // profilo (e partita) salvati solo al primo caricamento: i ricaricamenti del collaudo li tengono
    const seed = (prof, m = null, key = "sk-ant-x") => ({ fn: ([p, mm, k]) => {
      if (sessionStorage.getItem("seed")) return;
      sessionStorage.setItem("seed", "1");
      localStorage.setItem("owc.profile", JSON.stringify(Array.isArray(p) ? { players: p } : p));
      if (mm) localStorage.setItem("owc.match", JSON.stringify(mm));
      if (k) localStorage.setItem("owc.claudeKey", JSON.stringify(k));
    }, arg: [prof, m, key] });
    const open = async (opts, s) => { const r = await newPage(opts); if (s) await r.page.addInitScript(s.fn, s.arg); return r; };
    const nameOf = (x) => (x ? itn(data.heroes.find((h) => String(h.id) === String(x)).name) : null);
    const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
    const okResp = (obj) => ({ id: "m", type: "message", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify(obj) }], usage: { input_tokens: 1, output_tokens: 1 } });
    const slot = (nickname, role, hero) => ({ nickname, role, hero, sure: true, alternatives: [], dead: false });
    const mockClaude = (cx, read, delay = 0) => cx.route("https://api.anthropic.com/**", async (r) => {
      if (r.request().method() === "OPTIONS") { await r.fulfill({ status: 204, headers: CORS }); return; }
      if (delay) await new Promise((res) => setTimeout(res, delay));
      await r.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(okResp(read)) }).catch(() => {});
    });
    const sendPhoto = async (pg) => {
      const fc = pg.waitForEvent("filechooser");
      await pg.click("#photo-btn");
      await (await fc).setFiles({ name: "t.png", mimeType: "image/png", buffer: await pg.screenshot() });
    };
    const readNoBans = { scoreboard: true, map: "King's Row", side: "attack", bans: [],
      allies: [slot("FABIO", "Damage", "Cassidy"), slot("Giuly", "Support", "Ana")], enemies: [slot("x", "Tank", "Reinhardt")] };

    // 1. primo tocco dopo 30 minuti con dati nuovi in arrivo: il tocco vale, i dati si vedono dopo
    {
      const { ctx: cx, page: pg } = await open({ hasTouch: false, isMobile: false, serviceWorkers: "block" }, seed(P2));
      let n = 0;
      await cx.route("**/data.json*", (r) => { n++; return r.fulfill({ json: n > 1
        ? { ...data, checked: new Date().toISOString(), heroes: data.heroes.map((h) => (h.name === "Ana" ? { ...h, name: "Ana Amari" } : h)) }
        : data }); });
      await pg.clock.install();
      await pg.goto(BASE);
      await pg.locator(CARD).first().waitFor();
      await pg.clock.runFor(31 * 60e3);
      const row = band(pg, 0).locator(".alts .alt").first();
      const want = await row.getAttribute("data-id");
      const b = await row.boundingBox();
      await pg.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await pg.mouse.down();
      await new Promise((r) => setTimeout(r, 60)); // i dati nuovi arrivano mentre il dito è giù
      await pg.mouse.up();
      await pg.waitForFunction(() => [...document.querySelectorAll("#grid .hero .nm")].some((x) => x.textContent === "Ana Amari"), null, { timeout: 5000 });
      const m = await matchState(pg);
      check("primo tocco dopo 30 minuti con dati nuovi in arrivo: la scelta vale (prima il tocco si perdeva)",
        n === 2 && m.picked[0] === want, `richieste ${n}, scelto ${nameOf(m.picked[0])} invece di ${nameOf(want)}`);
      check("… e i dati nuovi arrivano a tocco finito, senza coprire il messaggio con «Annulla»",
        /Annulla/.test(await text(pg, "#toast")), await text(pg, "#toast"));
      // Profilo: un campo in cui si scrive non viene ricostruito (prima chiave e token sparivano)
      await pg.click('.tabs [data-view="profile"]');
      n = 1; // il prossimo data.json è di nuovo "nuovo"
      await pg.clock.runFor(31 * 60e3);
      await pg.locator("#claude-key").click();
      await pg.keyboard.type("sk-ant-NUOVA");
      await pg.waitForTimeout(1200);
      check("Profilo: dati nuovi mentre si scrive la chiave → testo e tastiera restano",
        await pg.locator("#claude-key").inputValue() === "sk-ant-NUOVA" && await pg.evaluate(() => document.activeElement?.id) === "claude-key"
        && n === 2, `${await pg.locator("#claude-key").inputValue()} ${n}`);
      await cx.close();
    }

    // 2. versione nuova dell'app: si ricarica solo quando si può (mai durante la lettura della foto o col foglio aperto)
    {
      const { ctx: cx, page: pg } = await open({ serviceWorkers: "allow" }, seed(P2));
      await mockClaude(cx, readNoBans, 2500);
      await pg.goto(BASE);
      await pg.locator(CARD).first().waitFor();
      await pg.evaluate(() => navigator.serviceWorker.ready);
      await pg.reload();
      await pg.locator(CARD).first().waitFor();
      const swPath = path.join(SITE, "sw.js");
      const swOrig = readFileSync(swPath, "utf8");
      const bump = (v) => writeFileSync(swPath, swOrig.replace(/const VERSION = "[^"]+"/, `const VERSION = "${v}"`));
      const mark = () => pg.evaluate(() => { window.__owcMark = 1; });
      const alive = () => pg.evaluate(() => window.__owcMark === 1).catch(() => false);
      await mark();
      bump("collaudo-1");
      await sendPhoto(pg);
      await pg.locator("#photo-dialog[open] .ph-spin").waitFor();
      await pg.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
      await pg.waitForTimeout(1200);
      const during = await alive();
      await pg.locator("#ph-confirm").waitFor();
      const sheet = await alive();
      await pg.click("#ph-confirm");
      await pg.waitForTimeout(500);
      const withUndo = await alive();
      check("versione nuova durante la foto: niente ricarica né con la lettura in corso, né col foglio, né con «Annulla» in vista",
        during && sheet && withUndo, `${during} ${sheet} ${withUndo}`);
      await pg.waitForFunction(() => window.__owcMark !== 1, null, { timeout: 25000 }).catch(() => {});
      // in caso di errore: perché non ha ricaricato (versione nuova vista? cosa lo impedisce? stato del service worker)
      const why = (await alive()) ? await pg.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration();
        return JSON.stringify({ ...window.owcReloadState(), toast: document.querySelector("#toast").hidden ? "nascosto" : document.querySelector("#toast").innerText,
          dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => d.id), focus: document.activeElement && document.activeElement.id,
          sw: { installing: !!(r && r.installing), waiting: !!(r && r.waiting), active: r && r.active && r.active.state } });
      }).catch((e) => String(e)) : "";
      check("… e appena tutto è chiuso la versione nuova prende il posto (ricarica)", !(await alive()), why);
      await pg.locator(CARD).first().waitFor();
      await mark();
      bump("collaudo-2");
      await pg.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
      await pg.waitForFunction(() => window.__owcMark !== 1, null, { timeout: 8000 }).catch(() => {});
      check("versione nuova con l'app ferma sulla partita: ricarica subito", !(await alive()));
      writeFileSync(swPath, swOrig);
      await cx.close();
    }

    // 3. ban nel foglio della foto: il foglio è l'unica fonte (anche vuoto), 5 ban di prima → 5 riquadri e «5/5»
    {
      const five = ["Widowmaker", "Zarya", "Hanzo", "Sojourn", "Mercy"].map((nm) => heroId(nm));
      const m0 = { roles: ["Damage", "Support"], picked: [null, null], pickFor: 0, mapSlug: null, side: null, bans: five, enemies: [], allies: [], group: "enemies" };
      const { ctx: cx, page: pg } = await open({ serviceWorkers: "block" }, seed(P2, m0));
      let read = readNoBans;
      await cx.route("https://api.anthropic.com/**", async (r) => {
        if (r.request().method() === "OPTIONS") { await r.fulfill({ status: 204, headers: CORS }); return; }
        await r.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(okResp(read)) });
      });
      await pg.goto(BASE);
      await pg.locator(CARD).first().waitFor();
      await sendPhoto(pg);
      await pg.locator("#ph-confirm").waitFor();
      await pg.click("#ph-edit");
      check("foto senza ban, 5 già segnati: 5 riquadri e contatore «5/5» (prima «5/4»)",
        await pg.locator(".ph-ban.has").count() === 5 && (await text(pg, ".ph-bans .ph-count")) === "5/5", await text(pg, ".ph-bans .ph-count"));
      for (let k = 0; k < 5; k++) { await pg.locator(".ph-ban.has").first().click(); await pg.click("#photo-none"); }
      await pg.click("#ph-confirm");
      check("ban tolti tutti nel foglio → nessun ban nella partita (prima tornavano quelli vecchi)", (await matchState(pg)).bans.length === 0,
        JSON.stringify((await matchState(pg)).bans.map(nameOf)));
      // ban letti dalla foto, tolti nel foglio: non tornano quelli della partita di prima
      await pg.evaluate((b) => { const m = JSON.parse(localStorage.getItem("owc.match")); m.bans = b; localStorage.setItem("owc.match", JSON.stringify(m)); }, [heroId("Hanzo")]);
      await pg.reload();
      await pg.locator(CARD).first().waitFor();
      read = { ...readNoBans, bans: [{ hero: "Tracer", sure: true, alternatives: [] }, { hero: "Sojourn", sure: true, alternatives: [] }] };
      await sendPhoto(pg);
      await pg.locator("#ph-confirm").waitFor();
      await pg.click("#ph-edit");
      for (let k = 0; k < 2; k++) { await pg.locator(".ph-ban.has").first().click(); await pg.click("#photo-none"); }
      await pg.click("#ph-confirm");
      check("ban letti e poi tolti nel foglio → nessun ban (prima tornava Hanzo)", (await matchState(pg)).bans.length === 0,
        JSON.stringify((await matchState(pg)).bans.map(nameOf)));
      await shot(pg, "20a-ban-foglio");
      await cx.close();
    }

    // 4. indietro dopo una ricarica con Profilo e "Tocca l'eroe preso da…" aperti: un livello per passo, poi si esce
    {
      const { ctx: cx, page: pg } = await open({ serviceWorkers: "block" }, seed(P2));
      await pg.goto(BASE);
      await pg.locator(CARD).first().waitFor();
      await pickFromGrid(pg, 0);
      await pg.click('.tabs [data-view="profile"]');
      await pg.locator("#players .btn", { hasText: "Scegli preferiti" }).first().click();
      await pg.reload();
      await pg.locator("#view-profile:not([hidden])").waitFor();
      await pg.waitForTimeout(400);
      const layers = () => pg.evaluate(() => ({ owc: history.state?.owc, profile: !document.querySelector("#view-profile").hidden,
        picking: JSON.parse(localStorage.getItem("owc.match")).group === "picked" }));
      const l0 = await layers();
      await pg.goBack();
      await pg.waitForTimeout(300);
      const l1 = await layers();
      await pg.goBack();
      await pg.waitForTimeout(300);
      const l2 = pg.url().startsWith(BASE) ? await layers() : null;
      check("indietro dopo una ricarica: prima la scelta dalla griglia, poi il Profilo, l'app resta aperta (prima si chiudeva)",
        l0.owc === 2 && l0.profile && l0.picking && l1.owc === 1 && l1.profile && !l1.picking && l2 && l2.owc === 0 && !l2.profile,
        JSON.stringify([l0, l1, l2]));
      await cx.close();
    }

    // 5. stato salvato da versioni vecchie o rovinato: l'app parte lo stesso, i dati buoni restano
    for (const [label, prof, m] of [
      ["partita senza ban (formato vecchio)", P2, { mapSlug: "kings-row", enemies: [heroId("Tracer")], allies: [], role: "Damage" }],
      ["giocatore senza preferiti", [{ name: "Io", rank: "", roles: ["Damage"] }], null],
      ["giocatore col ruolo singolo di una volta", [{ name: "Io", rank: "Oro", role: "Tank", favorites: [heroId("Winston")] }], null],
      ["valori rovinati", { players: "x" }, "rotto"],
    ]) {
      const { ctx: cx, page: pg } = await newPage({ serviceWorkers: "block" });
      const errs = [];
      pg.on("pageerror", (e) => errs.push(String(e)));
      await pg.addInitScript(([p, mm]) => {
        if (sessionStorage.getItem("seed")) return;
        sessionStorage.setItem("seed", "1");
        localStorage.setItem("owc.profile", JSON.stringify(Array.isArray(p) ? { players: p } : p));
        if (mm) localStorage.setItem("owc.match", JSON.stringify(mm));
      }, [prof, m]);
      await pg.goto(BASE);
      await pg.locator(CARD).first().waitFor({ timeout: 8000 }).catch(() => {});
      const st = await matchState(pg);
      const ok = errs.length === 0 && await pg.locator(CARD).count() >= 1
        && (label !== "partita senza ban (formato vecchio)" || (st.mapSlug === "kings-row" && st.enemies.includes(heroId("Tracer"))))
        && (label !== "giocatore col ruolo singolo di una volta" || (await pg.locator("#picks .role-btn").first().textContent()).trim() === "Tank");
      check(`stato salvato vecchio o rovinato (${label}): l'app parte e tiene i dati buoni`, ok, errs.join(" | "));
      errors.splice(0, errors.length, ...errors.filter((e) => !errs.includes(e)));
      await cx.close();
    }

    // 6. eroe sparito per un momento dai dati (elenco incompleto): preferito, avversario e scelta tornano con lui
    {
      const gone = data.heroes.find((h) => h.name === "Tracer");
      const m0 = { roles: ["Damage", "Support"], picked: [String(gone.id), null], pickFor: 0, mapSlug: null, side: null, bans: [],
        enemies: [String(gone.id), heroId("Winston")], allies: [], group: "enemies" };
      const prof = [{ ...P2[0], favorites: [String(gone.id), heroId("Genji")] }, P2[1]];
      const { ctx: cx, page: pg } = await open({ serviceWorkers: "block" }, seed(prof, m0));
      let partial = true;
      await cx.route("**/data.json*", (r) => r.fulfill({ json: partial ? { ...data, heroes: data.heroes.filter((h) => h.id !== gone.id) } : data }));
      const errs = [];
      pg.on("pageerror", (e) => errs.push(String(e)));
      await pg.goto(BASE);
      await pg.locator(CARD).first().waitFor();
      await pg.click('.tabs [data-view="profile"]');
      const favTxt = await pg.locator("#players .card").first().locator(".fav-list").innerText();
      const during = await matchState(pg);
      partial = false;
      await pg.reload();
      await pg.locator("#view-profile:not([hidden])").waitFor();
      const after = await matchState(pg);
      const favs = await pg.evaluate(() => JSON.parse(localStorage.getItem("owc.profile")).players[0].favorites);
      check("eroe sparito per un momento dai dati: niente errori, fuori dalla partita e dal Profilo",
        errs.length === 0 && !favTxt.includes("Tracer") && favTxt.includes("Genji") && !during.enemies.includes(String(gone.id)) && !during.picked[0],
        `${errs} ${favTxt}`);
      check("… e quando ricompare tornano preferito, avversario e scelta (prima si perdevano)",
        favs.includes(String(gone.id)) && after.enemies.includes(String(gone.id)) && after.picked[0] === String(gone.id),
        JSON.stringify({ favs, after: [after.picked, after.enemies] }));
      await cx.close();
    }

    // 7. un giocatore torna in partita ("＋") e un alleato non ci sta più: il messaggio dice quale
    // 8. "Annulla" dopo che è cambiato l'elenco dei giocatori: non sposta le scelte, lo dice
    {
      const P3 = [...P2, { name: "Terzo", nick: "Tre3", rank: "", roles: ["Tank"], favorites: [] }];
      const read = { scoreboard: true, map: "King's Row", side: "attack", bans: [],
        allies: [slot("Giuly", "Support", "Ana"), slot("a", "Tank", "Winston"), slot("b", "Support", "Lúcio"), slot("c", "Damage", "Genji"), slot("d", "Damage", "Tracer")],
        enemies: [slot("x", "Tank", "Reinhardt")] };
      const { ctx: cx, page: pg } = await open({ serviceWorkers: "block" }, seed(P3));
      await mockClaude(cx, read);
      await pg.goto(BASE);
      await pg.locator(CARD).first().waitFor();
      await sendPhoto(pg);
      await pg.locator("#ph-confirm").waitFor();
      await pg.click("#ph-confirm");
      await pg.locator("#away .away-chip").first().click();
      const msg = await text(pg, "#toast");
      check("giocatore di nuovo in partita: il messaggio dice quale alleato non ci sta più", msg.includes("Fabio di nuovo in partita") && msg.includes(itn("Tracer")), msg);
      // scelta di Fabio, poi si toglie Terzo dal Profilo, poi "Annulla" della scelta
      await pg.evaluate(() => window.scrollTo(0, 0));
      await band(pg, 0).locator(".move .done").click();
      const before = await matchState(pg);
      await pg.click('.tabs [data-view="profile"]');
      const rm = pg.locator("#players .card").nth(2).locator(".card-head button");
      await rm.click();
      await rm.click();
      await pg.click('.tabs [data-view="match"]');
      await pg.locator("#new-match").click(); // "Nuova partita": il suo Annulla è di dopo, vale
      await pg.click("#toast .toast-btn");
      const restored = await matchState(pg);
      check("«Annulla» di Nuova partita (stesso elenco di giocatori): ripristina", restored.picked[0] === before.picked[0], JSON.stringify(restored.picked));
      // un Annulla vecchio: si toglie Fabio (il primo) dopo "Nuova partita". Il messaggio "rimosso" copre quello con
      // "Annulla", quindi dall'interfaccia non ci si arriva più: si preme il vecchio pulsante (difesa in più)
      await pg.locator("#new-match").click();
      const oldUndo = await pg.locator("#toast .toast-btn").elementHandle();
      await pg.click('.tabs [data-view="profile"]');
      await pg.locator("#players .card").nth(0).locator(".card-head button").click();
      await pg.locator("#players .card").nth(0).locator(".card-head button").click();
      const mid = await matchState(pg);
      await oldUndo.evaluate((b) => b.click());
      const after = await matchState(pg);
      check("«Annulla» dopo aver tolto un giocatore: non sposta le scelte e lo dice",
        JSON.stringify(after.picked) === JSON.stringify(mid.picked) && /Non posso annullare/.test(await text(pg, "#toast")),
        `${JSON.stringify([mid.picked, after.picked])} ${await text(pg, "#toast")}`);
      await cx.close();
    }

    // 9. "solo guide" senza theory.json: non diventa un ordine alfabetico, si usano le statistiche e lo si dice
    {
      const { ctx: cx, page: pg } = await open({ serviceWorkers: "block" }, seed({ guideOnly: true, players: P2 }));
      await cx.route("**/theory.json*", (r) => r.fulfill({ status: 404, body: "" }));
      await pg.goto(BASE);
      await pg.locator(CARD).first().waitFor();
      const rec = await band(pg, 0).locator(".move .nums").textContent();
      const wf = await pg.locator("#warn-full").textContent();
      check("«solo guide» senza le guide caricate: consigli dalle statistiche (stima in %) e avviso giallo",
        /%/.test(rec) && await pg.locator("#warn").isVisible() && /guide non sono state caricate/.test(wf), `${rec} | ${wf}`);
      await cx.close();
    }

    // 10. ban consigliati e stelline dei ban: cambiano col lato anche con le sole statistiche (dal lato degli avversari)
    {
      const m0 = { roles: ["Damage", "Support"], picked: [null, null], pickFor: 0, mapSlug: "kings-row", side: null, bans: [], enemies: [], allies: [], group: "bans" };
      const { ctx: cx, page: pg } = await open({ serviceWorkers: "block" }, seed(P2, m0));
      await pg.goto(BASE);
      await pg.locator(CARD).first().waitFor();
      const recs = () => pg.locator("#grid .hero.sugg").evaluateAll((bs) => bs.map((b) => `${b.dataset.id}:${b.dataset.stars}`).join());
      await pg.click("#side [data-side=attack]");
      const sa = await starsOf(pg), ra = await recs();
      await pg.click("#side [data-side=defense]");
      const sd = await starsOf(pg), rd = await recs();
      check("ban (sole statistiche): tacche e ban consigliati («BAN?») cambiano tra attacco e difesa",
        Object.keys(sa).some((n) => sa[n].n !== sd[n].n) && ra !== rd);
      await cx.close();
    }
    lastPage = page;
  }

  check("nessun errore JavaScript", errors.length === 0, errors.join("\n"));
} catch (e) {
  if (lastPage) {
    await lastPage.screenshot({ path: path.join(SHOTS, "zz-errore.png") }).catch(() => {});
    console.log("finestre aperte:", await lastPage.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.id)).catch(() => "?"));
  }
  check("collaudo completato senza eccezioni", false, e.stack);
} finally {
  await browser.close();
  server.kill();
  rmSync(SITE, { recursive: true, force: true });
}
console.log(`\n${results.filter(Boolean).length}/${results.length} controlli superati · screenshot in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);

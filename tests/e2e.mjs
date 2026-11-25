// Collaudo della PWA in Chromium con viewport da telefono (390×844).
// Uso: node tests/e2e.mjs [cartella-screenshot]   (serve il pacchetto "playwright")
// Le richieste esterne sono bloccate (icone remote e api.github.com simulate), quindi gira offline.
// Struttura v4 (2026-11-25): «Inizio partita» (mappa, la vostra squadra, ban consigliati, «Avanti»), Partita con le card dei
// giocatori, due strisce di posti (la vostra squadra, avversari) e «Come giocarla» in vista; la lista degli eroi è un foglio
// che si apre toccando un posto o la card di un giocatore e si chiude dopo ogni tocco.
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
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CARD = "#picks .band"; // card dei giocatori
const band = (page, k) => page.locator("#picks .band").nth(k);
const heroId = (name) => String(data.heroes.find((h) => h.name === toEn(name)).id);
const roleOf = (n) => data.heroes.find((h) => h.name === toEn(n))?.role;
const nameOfId = (x) => (x ? itn(data.heroes.find((h) => String(h.id) === String(x))?.name ?? "") : null);
const matchState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("owc.match")));
const toTop = async (page) => { await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(50); };
// app pronta: al primo avvio (o con una partita mai cominciata) c'è l'Inizio partita → «Avanti»
async function ready(page, { next = true } = {}) {
  await page.waitForFunction(() => (window.owcStart && window.owcStart()) || document.querySelector("#picks .band")?.offsetParent, null, { timeout: 15000 });
  if (next && await page.evaluate(() => !!window.owcStart())) {
    await page.click("#start-next");
    await page.locator(CARD).first().waitFor();
  }
}
// eroe in evidenza in ogni card: quello preso (ritratto grande) o, se non ha scelto, quello proposto («PRENDI»)
const pickNames = async (page) => (await page.evaluate(() => window.owcBands())).map((b) => nameOfId(b.has ?? b.move) ?? "");
// scelte proposte in una card prima della scelta: la proposta («PRENDI») e le 2 alternative («oppure»)
const favRows = (page, k) => band(page, k).evaluate((b) => {
  const rows = [];
  const go = b.querySelector(".go");
  if (go) rows.push({ name: go.querySelector(".nm").textContent, n: Number(go.dataset.stars), rec: true, id: b.dataset.move });
  for (const a of b.querySelectorAll(".oalts .alt3")) rows.push({ name: a.querySelector(".nm").textContent, n: Number(a.dataset.stars), rec: false, id: a.dataset.id });
  return rows;
});
// ---- foglio «lista eroi» (#hero-sheet): una scheda di ruolo alla volta, si chiude dopo ogni tocco ----
const sheetInfo = (page) => page.evaluate(() => window.owcSheet());
const sheetTile = (page, name) => page.locator("#hs-grid .hero", { has: page.locator(".nm", { hasText: new RegExp(`^${esc(name)}$`) }) });
async function tapSheet(page, name) {
  const loc = sheetTile(page, name);
  const r = await loc.evaluate((b) => b.closest("[data-block]").dataset.block);
  const t = page.locator(`#hs-tabs [data-tab="${r}"]`);
  if ((await t.getAttribute("aria-pressed")) !== "true") await t.click();
  await loc.click();
}
// tacche del foglio aperto (tutte le schede): {nome mostrato: {n, shown, cls, color, role, cl}}
const sheetStars = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#hs-grid .hero")].map((b) => {
  const st = b.querySelector(".stars");
  return [b.querySelector(".nm").textContent, { n: Number(b.dataset.stars), shown: st ? st.querySelectorAll("i.on").length : 0, cls: st?.className ?? "",
    color: st ? getComputedStyle(st).color : null, role: b.closest("[data-block]").dataset.block, cl: [...b.classList], why: b.dataset.why ?? "" }];
})));
const closeSheet = async (page) => { if (await page.evaluate(() => document.querySelector("#hero-sheet").open)) await page.click("#hero-sheet [data-close]"); };
// un posto vuoto della striscia (del ruolo dell'eroe, se c'è) → foglio → eroe
async function addTo(page, g, name) {
  const [strip, kind] = g === "enemies" ? ["#them-strip", "enemy"] : ["#us-strip", "ally"];
  let s = page.locator(`${strip} .slot.${kind}.empty[data-role="${roleOf(name)}"]`);
  if (!(await s.count())) s = page.locator(`${strip} .slot.${kind}.empty`);
  await s.first().click();
  await page.locator("#hero-sheet[open]").waitFor();
  await tapSheet(page, name);
}
const slotOf = (page, g, name) => page.locator(`${g === "enemies" ? "#them-strip .slot.enemy" : "#us-strip .slot.ally"}[data-id="${heroId(name)}"]`);
async function removeFrom(page, g, name) {
  await slotOf(page, g, name).click();
  await page.click("#hs-remove");
}
// card del giocatore: tocco sul ritratto (o sul posto vuoto) → lista eroi del giocatore (le compatte prima si aprono)
async function openPlayer(page, i) {
  await toTop(page);
  const b = page.locator(`#picks .band[data-player="${i}"]`);
  if (await b.locator(".cmp").count()) await b.locator(".cmp").click();
  await page.locator(`#picks .band[data-player="${i}"] .has`).click();
  await page.locator("#hero-sheet[open]").waitFor();
}
async function choosePlayer(page, i, name) { await openPlayer(page, i); await tapSheet(page, name); }
async function unpick(page, i) { await openPlayer(page, i); await page.click("#menu-unpick"); }
// «Come giocarla» dell'eroe in evidenza nella card: quello preso (dal foglio) o quello proposto (tocco sulla proposta)
async function openGuideOf(page, k) {
  await toTop(page);
  const b = band(page, k);
  if (await b.getAttribute("data-has")) {
    await openPlayer(page, Number(await b.getAttribute("data-player")));
    await page.click("#menu-guide");
  } else await b.locator(".go").click();
  await page.locator("#guide-dialog[open]").waitFor();
}
// ---- Inizio partita ----
const startNames = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("#start-bans .banrole[data-role]")].map((r) =>
  [r.dataset.role, [...r.querySelectorAll(".bt")].map((b) => ({ id: b.dataset.id, n: Number(b.dataset.stars), on: b.classList.contains("on"), lv: b.querySelectorAll(".lv i.on").length }))])));
async function openEdit(page) { await toTop(page); await page.click("#bans-btn"); await page.locator("#start-view:not([hidden])").waitFor(); }
async function startMap(page, name) {
  await page.click("#start-map");
  await page.locator("#map-list .map-opt", { hasText: name }).click();
}
// mappa dalla Partita: la testata porta all'Inizio partita («Fatto» riporta alla Partita)
async function setMap(page, name) {
  await toTop(page);
  await page.click("#map-btn");
  await startMap(page, name);
  await page.click("#start-next");
}
async function banStart(page, name) {
  const t = page.locator(`#start-bans .bt[data-id="${heroId(name)}"]`);
  if (await t.count()) { await t.first().click(); return; }
  await page.click("#start-ban-search");
  await page.keyboard.type(name.toLowerCase());
  await page.keyboard.press("Enter");
}
// bersagli visibili sotto i 48 px di altezza (Partita o Inizio partita e barra in basso)
const smallTargets = (page) => page.evaluate(() => [...document.querySelectorAll("#view-match button, #view-match input, #start-view button, .dock button")]
  .filter((e) => { const r = e.getBoundingClientRect(); return e.offsetParent && r.width > 0 && r.bottom > 0 && r.top < innerHeight; })
  .map((e) => [e.id || e.className, (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 24), Math.round(e.getBoundingClientRect().height)])
  .filter(([, , h]) => h < 48));
// ritratto grande di ogni card aperta: l'eroe preso (match.picked) o il posto vuoto, mai il consigliato
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
// volti batte/teme di ogni card: quelli disegnati e quelli attesi da matchups() (window.owcFaces); forma quadrata (raggio ≤ 6 px)
const facesState = (page) => page.evaluate(() => {
  const want = window.owcFaces();
  const ids = (b, sel) => [...b.querySelectorAll(sel)].map((f) => f.dataset.id);
  const rad = (e) => parseFloat(getComputedStyle(e).borderTopLeftRadius) || 0;
  return [...document.querySelectorAll("#picks .band:not(.compact)")].map((b, k) => ({
    want: want[k],
    got: { hasBad: ids(b, ".hcol .mu.bad .mf"), propGood: ids(b, ".pcol .mu.good .mf"), propBad: ids(b, ".pcol .mu.bad .mf"), stayGood: ids(b, ".staybox .mu.good .mf") },
    labeled: [...b.querySelectorAll(".mf")].every((f) => /^(batte|teme) /.test(f.getAttribute("aria-label") || "") && f.title === f.getAttribute("aria-label")),
    // nessun elemento tondo tra i volti (ritratti, proposta, alternative, batte/teme)
    square: [...b.querySelectorAll(".hface, .mf, .alt3, .mf::after")].every((e) => rad(e) <= 6),
    colors: [...b.querySelectorAll(".mu.good .mf")].every((f) => /111, 208, 140/.test(getComputedStyle(f, "::after").boxShadow))
      && [...b.querySelectorAll(".mu.bad .mf")].every((f) => /255, 122, 127/.test(getComputedStyle(f, "::after").boxShadow)),
    words: [...b.querySelectorAll(".mu")].every((m) => /^(batte|teme)$/.test(m.querySelector(".mul").textContent)),
  }));
});
const facesOk = (fs, enemies) => fs.every((f) => ["hasBad", "propGood", "propBad", "stayGood"].every((k) => f.got[k].join() === f.want[k].join()
  && f.got[k].every((id) => enemies.includes(id))) && f.labeled && f.square && f.colors && f.words);
// sezioni ben separate (≥ 12 px): testata · card · la vostra squadra · avversari · come giocarla · barra in basso
const sectionGaps = (page) => page.evaluate(() => {
  const vis = (s) => { const e = document.querySelector(s); return e && !e.hidden && e.getClientRects().length ? e.getBoundingClientRect() : null; };
  const seq = ["#hstatus", "#picks", "#us-strip", "#them-strip", "#tips"].map((s) => [s, vis(s)]).filter(([, r]) => r);
  const gaps = {};
  for (let k = 1; k < seq.length; k++) gaps[`${seq[k - 1][0]}→${seq[k][0]}`] = Math.round(seq[k][1].top - seq[k - 1][1].bottom);
  if (document.scrollingElement.scrollHeight <= innerHeight) gaps["→dock"] = Math.round(document.querySelector(".dock").getBoundingClientRect().top - seq[seq.length - 1][1].bottom);
  return gaps;
});
const overflowY = (page) => page.evaluate(() => document.scrollingElement.scrollHeight - innerHeight);
// nessuna lista di eroi nella pagina se non è aperto il foglio
const gridInPage = (page) => page.evaluate(() => [...document.querySelectorAll(".hero")].filter((b) => b.offsetParent && !b.closest("dialog")).length);
const P2 = { players: [{ name: "Fabio", rank: "", roles: ["Damage"], favorites: [] }, { name: "Giulia", rank: "", roles: ["Support"], favorites: [] }] };
const M = (o = {}) => ({ roles: ["Damage", "Support"], picked: [null, null], mapSlug: "kings-row", side: "attack", bans: [], enemies: [], allies: [], started: true, ...o });
const seeded = async (opts, prof, m) => {
  const o = await newPage({ serviceWorkers: "block", ...opts });
  await o.page.addInitScript(([p, mm]) => {
    if (sessionStorage.getItem("seeded")) return;
    localStorage.setItem("owc.profile", JSON.stringify(p));
    if (mm) localStorage.setItem("owc.match", JSON.stringify(mm));
    sessionStorage.setItem("seeded", "1");
  }, [prof, m]);
  return o;
};

try {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  // ---------- primo avvio: si apre l'Inizio partita ----------
  const { ctx, page } = await newPage();
  lastPage = page;
  await page.goto(BASE);
  await ready(page, { next: false });
  check("primo avvio: si apre l'Inizio partita («Nuova partita», «Avanti», niente «Annulla», niente barra in basso)",
    (await page.evaluate(() => window.owcStart())) === "first" && /^Nuova partita$/i.test(await text(page, "#t-start"))
    && /Avanti/i.test(await text(page, "#start-next")) && await page.locator("#start-cancel").isHidden() && await page.locator(".dock").isHidden()
    && await page.locator("#view-match").isHidden());
  check("Inizio partita: «Riempi tutto dalla foto», mappa, la vostra squadra (Io e Lei) e i ban consigliati",
    await page.locator("#start-photo").isVisible() && await page.locator("#start-map").isVisible()
    && /Io/.test(await text(page, "#start-team")) && /Lei/.test(await text(page, "#start-team")) && await page.locator("#start-bans").isVisible());
  const sb0 = await startNames(page);
  check("Inizio partita senza mappa: 4 ban consigliati per ruolo, ognuno col livello (tacche 1–5)",
    ["Tank", "Damage", "Support"].every((r) => sb0[r]?.length === 4 && sb0[r].every((x) => x.n >= 1 && x.n <= 5 && x.lv === x.n))
    && /tutte le mappe/.test(await text(page, "#start-bans h2")), JSON.stringify(sb0));
  const small00 = await smallTargets(page);
  check("Inizio partita: bersagli ≥ 48 px, niente scorrimento", small00.length === 0 && (await overflowY(page)) <= 0, JSON.stringify(small00));
  await shot(page, "00-inizio-partita");
  await page.click("#start-next");
  await page.locator(CARD).first().waitFor();
  const m00 = await matchState(page);
  check("«Avanti» senza aver messo niente: si arriva alla Partita, salvato solo ciò che c'è (niente mappa, niente ban)",
    m00.started === true && m00.mapSlug === null && !m00.bans.length && !m00.enemies.length && await page.locator("#view-match").isVisible()
    && await page.locator(".dock").isVisible(), JSON.stringify(m00));
  await toTop(page);
  check("primo avvio: due card (Io e Lei)", (await page.locator(CARD).count()) === 2
    && (await text(page, "#picks")).includes("Io") && (await text(page, "#picks")).includes("Lei"));
  check("Partita: nessuna lista di eroi nella pagina (solo nel foglio)", (await gridInPage(page)) === 0 && !(await page.evaluate(() => document.querySelector("#hero-sheet").open)));
  check("Partita: due strisce di posti (la vostra squadra, avversari T D D S S), niente selettore Ban/Avversari/Alleati",
    await page.locator("#us-strip").isVisible() && await page.locator("#them-strip").isVisible()
    && (await page.locator("#them-strip .slot.empty").evaluateAll((s) => s.map((x) => x.dataset.role).join())) === "Tank,Damage,Damage,Support,Support"
    && (await page.locator("#groups, #slots, #role-tabs, #pick-banner, #legend, #choose-dialog").count()) === 0);
  const fresh0 = await text(page, "#fresh-short");
  check("freschezza visibile in testata, in forma corta (accanto alla modalità)", await page.locator("#fresh-short").isVisible()
    && /^dati (di .+ fa|del \d+ \w+|controllati adesso)$/.test(fresh0) || (await page.locator("#warn").isVisible() && /dati/.test(await text(page, "#warn"))), fresh0);
  check("freschezza completa nel Profilo", /Dati counterwatch del .*controllati/.test(await page.locator("#fresh").textContent()), await page.locator("#fresh").textContent());
  const small0 = await smallTargets(page);
  check("bersagli tattili della Partita: tutti almeno 48 px di altezza", small0.length === 0, JSON.stringify(small0));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("niente scorrimento orizzontale", overflow <= 0, `overflow ${overflow}px`);
  const mapLook0 = await page.evaluate(() => { const b = document.querySelector("#map-btn"); const cs = getComputedStyle(b);
    return { empty: b.classList.contains("empty"), ring: cs.boxShadow, chg: getComputedStyle(document.querySelector(".map-chg-t")).display, color: getComputedStyle(document.querySelector("#map-name")).color }; });
  check("mappa non scelta: invito arancione (bordo e scritta), senza «cambia»", mapLook0.empty && /249, 158, 26/.test(mapLook0.ring) && mapLook0.chg === "none"
    && mapLook0.color === "rgb(249, 158, 26)", JSON.stringify(mapLook0));
  check("prima della scelta: il ritratto grande è il posto vuoto (mai il consigliato)", (await portraitsOk(page)).length === 0, JSON.stringify(await portraitsOk(page)));
  await shot(page, "01-avvio");
  // lista eroi: nomi italiani, iniziali se le icone non arrivano
  await page.locator("#them-strip .slot.empty").first().click();
  await page.locator("#hero-sheet[open]").waitFor();
  check("foglio della lista eroi: tutti i 53 eroi (una scheda di ruolo alla volta)", (await page.locator("#hs-grid .hero").count()) === data.heroes.length
    && (await page.locator("#hs-grid [data-block]:not([hidden])").count()) === 1);
  if (Object.keys(shownIt).length) {
    const gridNames = await page.locator("#hs-grid .hero .nm").evaluateAll((xs) => xs.map((x) => x.textContent));
    check("nomi degli eroi come nel gioco in italiano (es. Soldato-76)", Object.values(shownIt).every((n) => gridNames.includes(n))
      && Object.keys(shownIt).every((n) => !gridNames.includes(n)), JSON.stringify(shownIt));
  }
  const initialsOk = await page.waitForFunction(() => [...document.querySelectorAll("#hs-grid .face")].every((f) => f.querySelector("img") || f.textContent.trim()), null, { timeout: 10000 }).then(() => true, () => false);
  check("icone non raggiungibili: iniziali al loro posto", initialsOk);
  await closeSheet(page);

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
  check("profilo: nomi nelle card", (await text(page, "#picks")).includes("Fabio") && (await text(page, "#picks")).includes("Giulia"));

  // ---------- Inizio partita (modifica, dalla mappa della testata): mappa, lato, ban consigliati ----------
  await page.click("#map-btn");
  await page.locator("#start-view:not([hidden])").waitFor();
  check("tocco sulla mappa della testata: Inizio partita in modo «modifica» («Fatto», niente «Annulla»)",
    (await page.evaluate(() => window.owcStart())) === "edit" && /^Inizio partita$/i.test(await text(page, "#t-start"))
    && /Fatto/i.test(await text(page, "#start-next")) && await page.locator("#start-cancel").isHidden());
  await page.click("#start-map");
  await shot(page, "04-mappe");
  await page.locator("#map-list .map-opt", { hasText: "King's Row" }).click();
  check("mappa scelta e finestra chiusa", (await text(page, "#start-map")).includes("King's Row") && !(await page.locator("#map-dialog").evaluate((d) => d.open)));
  check("Hybrid: attacco/difesa visibile", await page.locator("#start-side").isVisible());
  await page.click("#start-side [data-side=defense]");
  check("difesa selezionata", (await page.getAttribute("#start-side [data-side=defense]", "aria-pressed")) === "true");
  const sbK = await startNames(page);
  const br = { heroes: ["Tank", "Damage", "Support"].flatMap((r) => sbK[r].map((x) => nameOfId(x.id))) };
  check("ban consigliati con la mappa: 4 per ruolo, col livello 1–5 (tacche bianche), nessuno bannato",
    ["Tank", "Damage", "Support"].every((r) => sbK[r].length === 4 && sbK[r].every((x) => roleOf(nameOfId(x.id)) === r && x.n >= 1 && x.n <= 5 && x.lv === x.n && !x.on))
    && await page.locator("#start-bans .bt .lv.st-bans").first().evaluate((x) => getComputedStyle(x).color === "rgb(255, 255, 255)"), JSON.stringify(sbK));
  check("ban consigliati: cambiano con la mappa (rispetto a «tutte le mappe»)", JSON.stringify(sbK) !== JSON.stringify(sb0));
  // nessuno ha scelto → contano solo mappa e lato: i più forti del ruolo sulla mappa ci sono
  const strongest = (role) => data.heroes.filter((h) => h.role === role).map((h) => [itn(h.name), (data.maps.find((m) => m.slug === "kings-row").winRates[String(h.id)] ?? data.overall[String(h.id)])])
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
  check("ban consigliati: nessuno ha scelto → solo la mappa (anche i preferiti, se sono tra i più forti)",
    ["Tank", "Damage", "Support"].every((r) => strongest(r).every((n) => br.heroes.includes(n))), br.heroes.join());
  await page.click("#start-side [data-side=attack]");
  const sbA = await startNames(page);
  await page.click("#start-side [data-side=defense]");
  check("ban consigliati: cambiano col lato (si valutano dal lato degli avversari)", JSON.stringify(sbA) !== JSON.stringify(sbK));
  await shot(page, "04b-ban-consigliati");
  await page.locator(`#start-bans .bt[data-id="${heroId(br.heroes[0])}"]`).click();
  check("ban consigliato: un tocco lo segna (BANNATO, contato), l'elenco resta lo stesso",
    (await matchState(page)).bans.map(String).includes(heroId(br.heroes[0])) && /1\/5/.test(await text(page, "#start-bans h2"))
    && (await page.locator(`#start-bans .bt.on[data-id="${heroId(br.heroes[0])}"]`).count()) === 1
    && JSON.stringify((await startNames(page)).Tank.map((x) => x.id)) === JSON.stringify(sbK.Tank.map((x) => x.id)));
  await page.locator(`#start-bans .bt[data-id="${heroId(br.heroes[0])}"]`).click();
  check("ban consigliato ritoccato: tolto", (await matchState(page)).bans.length === 0 && /0\/5/.test(await text(page, "#start-bans h2")));
  // un eroe non consigliato: «Banna un altro eroe» = un tocco + qualche lettera (ricerca in tutti i ruoli)
  const notRec = ["Ana", "Kiriko", "Lúcio", "Mercy"].find((n) => !br.heroes.includes(n));
  await page.click("#start-ban-search");
  await page.locator("#hero-sheet[open]").waitFor();
  const focused = await page.evaluate(() => document.activeElement?.id);
  await page.keyboard.type(notRec.toLowerCase());
  await page.keyboard.press("Enter");
  check(`ban di un eroe non consigliato (${notRec}): un tocco + qualche lettera + Invio; foglio chiuso, in «altri»`,
    focused === "hero-q" && (await matchState(page)).bans.map(String).includes(heroId(notRec))
    && !(await page.evaluate(() => document.querySelector("#hero-sheet").open))
    && (await page.locator(`#start-bans .banrole.others .bt[data-id="${heroId(notRec)}"]`).count()) === 1, focused);
  const others5 = ["Ana", "Kiriko", "Lúcio", "Mercy", "Moira", "Genji"].filter((n) => n !== notRec);
  for (const n of others5) await banStart(page, n);
  check("ban: al massimo 5 (il sesto non entra, con avviso)", (await matchState(page)).bans.length === 5
    && /Al massimo 5 ban/.test(await page.locator("#toast").textContent()), await page.locator("#toast").textContent());
  check("il messaggio nell'Inizio partita sta nella sua riga di stato (non copre nulla)", (await page.evaluate(() => window.owcToastHost())) === "sstatus");
  const smallS = await smallTargets(page);
  check("Inizio partita compilata: bersagli ≥ 48 px, niente scorrimento", smallS.length === 0 && (await overflowY(page)) <= 0, JSON.stringify(smallS));
  await shot(page, "04c-inizio-compilato");
  // tolgo l'ultimo: ne restano 4 (tra cui Ana e Kiriko)
  const lastBan = nameOfId((await matchState(page)).bans.at(-1));
  await banStart(page, lastBan);
  await page.click("#start-next");
  await page.locator(CARD).first().waitFor();
  const mB = await matchState(page);
  check("«Fatto»: si torna alla Partita con mappa, lato e ban; i ban in testata (volti spenti)", mB.mapSlug === "kings-row" && mB.side === "defense"
    && mB.bans.length === 4 && (await page.locator("#bans-btn .bf").count()) === 4 && (await text(page, "#map-name")).includes("King's Row")
    && /Ibrida/.test(await page.locator("#map-sub").textContent()), JSON.stringify({ mB, bf: await page.locator("#bans-btn .bf").count(), n: await text(page, "#map-name"), s: await text(page, "#map-sub") }));
  const BANS = mB.bans.map(nameOfId);
  const afterBans = await pickNames(page);
  check("consigli senza eroi bannati", afterBans.every((n) => !BANS.includes(n)), afterBans.join());
  check("consigli: Fabio e Giulia hanno eroi diversi", afterBans[0] !== afterBans[1], afterBans.join());
  const cardNums = await page.locator(CARD).evaluateAll((cs) => cs.map((c) => (c.textContent.match(/\d+%/g) ?? []).length));
  check("prima della scelta: un numero solo per card (la stima della proposta)", cardNums.every((k) => k <= 1), JSON.stringify(cardNums));
  check("prima degli avversari: nessun volto batte/teme, niente «Come giocarla» in vista", (await page.locator("#picks .mf").count()) === 0
    && await page.locator("#tips").isHidden());
  const lists0 = [await favRows(page, 0), await favRows(page, 1)];
  check("prima della scelta: [posto vuoto] › [proposta, bordo arancione] ✓ PRESO e «oppure» 2 alternative, nessun eroe «scelto»",
    lists0.every((l) => l.length >= 1 && l.length <= 3 && l[0].rec && l.slice(1).every((r) => !r.rec))
    && (await page.evaluate(() => window.owcBands().every((b) => !b.has))) && (await page.locator("#picks .go .hface.prop").count()) === 2
    && (await page.locator("#picks .go .hface.prop").evaluateAll((fs) => fs.every((f) => /249, 158, 26/.test(getComputedStyle(f, "::after").boxShadow))))
    && (await page.locator("#picks .done").count()) === 2 && (await page.locator("#picks .oalts .o").allTextContents()).every((t) => t === "oppure"),
    JSON.stringify(lists0));
  check("card: parole minime (nome del giocatore, PRENDI, PRESO, oppure)", (await page.locator("#picks .chead .pn").allTextContents()).join() === "Fabio,Giulia"
    && (await page.locator("#picks .chead .verb").allTextContents()).every((t) => t === "Prendi")
    && (await page.locator("#picks .done .dl").allTextContents()).every((t) => t === "Preso"));
  check("alternative ordinate dalla più adatta (tacche non crescenti)", lists0.every((l) => l.slice(1).every((r, k, xs) => !k || r.n <= xs[k - 1].n)));
  check("card: la valutazione 1–5 resta nei dati (data-stars) di proposta e alternative", await page.locator("#picks .go, #picks .alt3").evaluateAll((xs) =>
    xs.length > 0 && xs.every((x) => { const n = Number(x.dataset.stars); return n >= 1 && n <= 5; })));
  // lista eroi del giocatore (interruttore «solo preferiti» spento): tutti gli eroi, la scheda del suo ruolo, il consigliato col bordo arancione
  await openPlayer(page, 1);
  const ps0 = await sheetInfo(page);
  const recTile = await page.locator("#hs-grid .hero.rec").evaluateAll((bs) => bs.map((b) => b.dataset.id));
  check("lista eroi di Giulia: si apre sulla scheda del suo ruolo (Supporto), il consigliato col bordo arancione, tacche col suo colore",
    ps0?.kind === "player" && ps0.i === 1 && ps0.tab === "Support" && recTile.join() === (await band(page, 1).getAttribute("data-move"))
    && await page.locator("#hs-grid .hero .stars.st-player").first().evaluate((x) => getComputedStyle(x).color === "rgb(255, 111, 207)"), JSON.stringify({ ps0, recTile }));
  const spo = await sheetStars(page);
  const favMarks = await page.evaluate(() => [...document.querySelectorAll("#hs-grid .hero")].filter((b) => b.querySelector(".favmark"))
    .map((b) => [b.querySelector(".nm").textContent, /preferito/.test(b.getAttribute("aria-label")), getComputedStyle(b.querySelector(".favmark")).right,
      getComputedStyle(b.querySelector(".favmark")).color]));
  check("interruttore «solo preferiti» spento: nella lista di Giulia i suoi preferiti (Mercy, Juno) segnati con la stellina del suo colore e «preferito», niente gruppi",
    favMarks.map((x) => x[0]).sort().join() === "Juno,Mercy" && favMarks.every((x) => x[1] && x[2] === "3px" && x[3] === "rgb(255, 111, 207)")
    && (await page.locator("#hs-grid .sg-h").count()) === 0, JSON.stringify(favMarks));
  check("lista eroi del giocatore: tacche da 1 a 5 su ogni eroe, i bannati spenti con «Bannato»", Object.values(spo).every((x) => x.n >= 1 && x.n <= 5 && x.shown === x.n)
    && BANS.every((n) => spo[n]?.cl.includes("off") && spo[n].why === "Bannato"), JSON.stringify(BANS.map((n) => spo[n])));
  await closeSheet(page);
  await shot(page, "05-inizio-partita");

  // ---------- durante: avversari (striscia), lista eroi per ruolo ----------
  await page.locator("#them-strip .slot.empty[data-role=Damage]").first().click();
  await page.locator("#hero-sheet[open]").waitFor();
  const es = await sheetInfo(page);
  check("posto vuoto Danni degli avversari: il foglio si apre sulla scheda Danni", es?.kind === "enemies" && es.tab === "Damage"
    && /Avversario/i.test(await text(page, "#t-hs")) && /Danni/i.test(await text(page, "#t-hs")), JSON.stringify(es));
  const se = await sheetStars(page);
  const sev = Object.values(se);
  check("tacche Avversari: rosse, da 1 a 5 su ogni eroe (anche i bannati)", sev.every((x) => x.n >= 1 && x.n <= 5
    && x.cls.includes("st-enemies") && x.color === "rgb(236, 74, 80)"), JSON.stringify(sev.find((x) => !x.n)));
  check("lista eroi: i bannati restano visibili ma spenti, con «Bannato»", BANS.every((n) => se[n]?.cl.includes("off") && se[n].why === "Bannato"), JSON.stringify(BANS.map((n) => se[n])));
  check("tacche Avversari: almeno 4 in ogni ruolo e qualcuno a 1–2", ["Tank", "Damage", "Support"].every((r) => sev.some((x) => x.n >= 4 && x.role === r)) && sev.some((x) => x.n <= 2));
  check("«Chi soffrite di più» (punto rosso): nascosto finché nessuno ha scelto e non ci sono alleati", (await page.locator("#hs-grid .hero.top3").count()) === 0);
  await shot(page, "05a-foglio-avversario");
  await tapSheet(page, "Pharah");
  check("dopo il tocco su un eroe il foglio si chiude e il posto è pieno", !(await page.evaluate(() => document.querySelector("#hero-sheet").open))
    && (await slotOf(page, "enemies", "Pharah").count()) === 1 && /1\/5/.test(await text(page, "#them-strip h3")));
  await page.locator("#them-strip .slot.empty[data-role=Tank]").click();
  check("posto vuoto Tank: scheda Tank", (await sheetInfo(page)).tab === "Tank");
  await tapSheet(page, "Winston");
  await addTo(page, "enemies", "Reinhardt");
  const mE = await matchState(page);
  check("3 avversari: nei posti, il secondo tank nel primo posto libero (il ruolo del posto aiuta, non vincola)", mE.enemies.length === 3
    && (await page.locator("#them-strip .slot.full").count()) === 3 && /3\/5/.test(await text(page, "#them-strip h3")), JSON.stringify(mE.enemies));
  // posto pieno: un tocco → la lista con «Togli»
  await slotOf(page, "enemies", "Reinhardt").click();
  check("posto pieno: il foglio ha «Togli»", await page.locator("#hs-remove").isVisible());
  await page.click("#hs-remove");
  check("«Togli»: posto di nuovo vuoto", !(await matchState(page)).enemies.map(String).includes(heroId("Reinhardt")) && (await page.locator("#them-strip .slot.full").count()) === 2);
  await addTo(page, "enemies", "Reinhardt");
  // posto pieno: un altro eroe al suo posto (cambio)
  await slotOf(page, "enemies", "Reinhardt").click();
  await tapSheet(page, "Sigma");
  const mS = await matchState(page);
  check("posto pieno + altro eroe: lo sostituisce", mS.enemies.map(String).includes(heroId("Sigma")) && !mS.enemies.map(String).includes(heroId("Reinhardt")) && mS.enemies.length === 3);
  await slotOf(page, "enemies", "Sigma").click();
  await tapSheet(page, "Reinhardt");
  const ENEMIES = ["Pharah", "Winston", "Reinhardt"];
  const enemyIds = ENEMIES.map(heroId);
  await toTop(page);
  const fs1 = await facesState(page);
  check("con avversari: volti quadrati (raggio ≤ 6 px), verdi = batte e rossi = teme come da matchups(), solo tra gli avversari segnati, con l'etichetta",
    facesOk(fs1, enemyIds) && fs1.some((f) => f.got.propGood.length + f.got.propBad.length), JSON.stringify(fs1));
  const tips1 = await page.evaluate(() => ({ tips: window.owcTips(), rows: [...document.querySelectorAll("#tips .tip")].map((t) => ({
    w: t.scrollWidth - t.clientWidth, h: Math.round(t.getBoundingClientRect().height), dots: /…/.test(t.textContent) })) }));
  check("«Come giocarla» in vista: per ogni giocatore al massimo 2 righe (attento/punta) con i volti, una riga sola ciascuna, mai «…»",
    await page.locator("#tips").isVisible() && [0, 1].every((i) => { const r = tips1.tips.filter((t) => t.player === i); return r.length >= 1 && r.length <= 2 && r.every((t) => t.ids.length >= 1 && t.ids.every((id) => enemyIds.includes(id))); })
    && tips1.rows.every((r) => r.w <= 1 && r.h <= 30 && !r.dots), JSON.stringify(tips1));
  check("«Come giocarla» in vista: segno ■ dati / ▨ teoria su ogni riga", (await page.locator("#tips .tip .mk").count()) === tips1.tips.length
    && (await page.locator("#tips .tip .mk").evaluateAll((ms) => ms.every((m) => /\b(theory|data)\b/.test(m.className)))));
  await page.locator("#tips .tipgrp").first().click();
  await page.locator("#guide-dialog[open]").waitFor();
  const tg = await text(page, "#t-guide");
  check("tocco su «Come giocarla» in vista: si apre la guida completa di quel giocatore", tg.includes(nameOfId((await page.evaluate(() => window.owcBands()))[0].move)), tg);
  await page.click("#guide-dialog [data-close]");
  await shot(page, "05e-avversari");

  // «✓ PRESO» = scelto → la card mostra quell'eroe nel ritratto grande
  const recF = (await favRows(page, 0))[0].name;
  const recStars = (await favRows(page, 0))[0].n;
  await band(page, 0).locator(".done").click();
  await toTop(page);
  const chosenSt = Number(await band(page, 0).locator(".has").getAttribute("data-stars"));
  check("eroe scelto: la stessa valutazione (1–5) della proposta", chosenSt === recStars, `${chosenSt} / ${recStars}`);
  check("un tocco su «✓ PRESO»: scelto, nel ritratto grande l'eroe preso",
    (await band(page, 0).getAttribute("data-has")) === heroId(recF) && / ha /.test(await band(page, 0).locator(".has").getAttribute("aria-label"))
    && String((await matchState(page)).picked[0]) === heroId(recF) && (await text(page, "#toast")).includes("ha scelto"), recF);
  check("dopo la scelta: ritratto grande = eroe preso; il consigliato solo a destra della freccia", (await portraitsOk(page)).length === 0, JSON.stringify(await portraitsOk(page)));
  const mv0 = await band(page, 0).evaluate((b) => ({ stay: b.querySelector(".stay3")?.textContent ?? null, move: b.dataset.move, has: b.dataset.has,
    plus: b.querySelector(".plus")?.textContent ?? null, done: !!b.querySelector(".done"), doneLabel: b.querySelector(".done")?.getAttribute("aria-label") ?? "",
    verb: b.querySelector(".verb")?.textContent ?? "", dl: b.querySelector(".done .dl")?.textContent ?? "", hn: b.querySelector(".hn")?.textContent ?? "" }));
  check("dopo la scelta: [preso, «NOME 46%»] › PASSA A [cambio] +x% ✓ CAMBIO, oppure «resta» senza pulsante",
    mv0.hn === recF && ((mv0.stay === "resta" && !mv0.move && !mv0.done)
    || (mv0.move && mv0.move !== mv0.has && mv0.done && /passato a/.test(mv0.doneLabel) && mv0.verb === "Passa a" && mv0.dl === "Cambio"
      && (!mv0.plus || /^\+\d+,\d%$/.test(mv0.plus)))), JSON.stringify(mv0));
  const fs2 = await facesState(page);
  check("dopo la scelta: volti rossi sotto l'eroe preso e verdi sotto il cambio (o sotto «resta»), come da matchups()", facesOk(fs2, enemyIds), JSON.stringify(fs2));
  // «Chi soffrite di più»: con un eroe scelto compare nella lista degli avversari, 3 per ruolo, mai i bannati
  await page.locator("#them-strip .slot.empty").first().click();
  const th = await page.locator("#hs-grid .hero.top3").evaluateAll((bs) => bs.map((b) => ({ name: b.querySelector(".nm").textContent, n: Number(b.dataset.stars) })));
  const gridSt = await sheetStars(page);
  check("«Chi soffrite di più»: con un eroe scelto i 3 per ruolo hanno il punto rosso, tacche come la lista, senza bannati",
    th.length === 9 && ["Tank", "Damage", "Support"].every((r) => th.filter((t) => roleOf(t.name) === r).length === 3)
    && th.every((t) => gridSt[t.name]?.n === t.n && !BANS.includes(t.name)), JSON.stringify(th));
  check("«Chi soffrite di più»: i più pericolosi del ruolo (nessuno fuori elenco ha più tacche)", th.every((t) =>
    Object.entries(gridSt).every(([n, x]) => roleOf(n) !== roleOf(t.name) || BANS.includes(n) || th.some((u) => u.name === n) || x.n <= t.n)));
  await shot(page, "05h-chi-soffrite");
  await closeSheet(page);
  // lista eroi del giocatore che ha già scelto: «Come giocare X», «Non l'ho preso», scheda del ruolo del suo eroe
  await openPlayer(page, 0);
  const p0 = await sheetInfo(page);
  check("lista eroi di Fabio (ha scelto): «Come giocare …», «Non l'ho preso», scheda del ruolo del suo eroe, il suo eroe segnato",
    await page.locator("#menu-guide").isVisible() && await page.locator("#menu-unpick").isVisible() && p0.tab === roleOf(recF)
    && (await sheetTile(page, recF).getAttribute("aria-pressed")) === "true", JSON.stringify(p0));
  await shot(page, "05g-foglio-giocatore");
  const other = Object.entries(await sheetStars(page)).find(([n, x]) => x.role === p0.tab && n !== recF && !x.cl.includes("off") && !ENEMIES.includes(n))[0];
  await tapSheet(page, other);
  await toTop(page);
  check("lista eroi del giocatore: un tocco sceglie quell'eroe e chiude il foglio", !(await page.evaluate(() => document.querySelector("#hero-sheet").open))
    && (await band(page, 0).getAttribute("data-has")) === heroId(other) && String((await matchState(page)).picked[0]) === heroId(other), other);
  await shot(page, "05f-scelto");
  await unpick(page, 0);
  await toTop(page);
  check("«Non l'ho preso»: torna «PRENDI» e il posto vuoto, niente scelto", (await matchState(page)).picked[0] === null
    && !(await band(page, 0).getAttribute("data-has")) && (await band(page, 0).locator(".go").count()) === 1 && (await portraitsOk(page)).length === 0);
  await page.locator("#them-strip .slot.empty").first().click();
  check("«Chi soffrite di più»: sparisce di nuovo senza eroi scelti né alleati", (await page.locator("#hs-grid .hero.top3").count()) === 0);
  await closeSheet(page);
  // «Come giocarla» del proposto, poi «Perché»
  const altName = (await favRows(page, 0))[0].name;
  await band(page, 0).locator(".go").click();
  await page.locator("#guide-dialog[open]").waitFor();
  check("«Come giocarla» del proposto (prima della scelta)", (await text(page, "#t-guide")).includes(altName), await text(page, "#t-guide"));
  await page.click("#guide-body .why-btn");
  await page.locator("#why-dialog[open]").waitFor();
  const det = await text(page, "#why-body");
  check("«Perché»: riepilogo mappa e comp avversaria (i numeri tolti dalla card)", /Mappa [+−]\d/.test(det) && /Avversari [+−]\d/.test(det), det.slice(0, 300));
  check("tocco su un consiglio: dettaglio per ogni avversario", ["contro Pharah", "contro Winston", "contro Reinhardt", "King's Row"].every((t) => det.includes(t)), det);
  await shot(page, "05b-perche");
  check("scheda eroe di Fabio (rank Diamante): dati Ranked", /Ranked/.test(det), det.slice(0, 200));
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
  check("scheda eroe di Giulia (rank Oro): usa i dati della divisione", detG.includes("dati: Ranked Oro"), detG.slice(0, 300));
  await closeAll();
  const sumF = await openWhy(0).then(() => text(page, "#why-body .why-sum"));
  await closeAll();
  const cardsTxt0 = await page.locator(CARD).allTextContents();
  check("nessuno ha scelto: i consigli non dipendono dal compagno (niente «Con Giulia», niente «Bene con …»)",
    !/Alleati [+−]/.test(sumF) && !/Con Giulia/.test(sumF) && cardsTxt0.every((t) => !/Bene con (Fabio|Giulia)/.test(t)), sumF);
  await toTop(page);
  const recG = (await favRows(page, 1))[0].name;
  await band(page, 1).locator(".done").click();
  const sumF2 = await openWhy(0).then(() => text(page, "#why-body .why-sum"));
  await closeAll();
  check("dopo la scelta di Giulia: la sinergia con il suo eroe è «Con Giulia»", /Con Giulia [+−]/.test(sumF2), `${recG}: ${sumF2}`);
  check("la vostra squadra: Giulia nel posto del suo ruolo, col suo eroe", (await page.locator(`#us-strip .slot.player[data-player="1"][data-id="${heroId(recG)}"]`).count()) === 1);
  await unpick(page, 1);
  // alleati: posti che restano dopo i due giocatori; lista sul ruolo del posto, tacche azzurre
  check("la vostra squadra: 3 posti alleati che restano dopo i due giocatori (Tank, Danni, Supporto)",
    (await page.locator("#us-strip .slot.ally.empty").evaluateAll((s) => s.map((x) => x.dataset.role).join())) === "Tank,Damage,Support"
    && /0\/3 alleati/.test(await text(page, "#us-strip h3")));
  await page.locator("#us-strip .slot.ally.empty[data-role=Support]").click();
  const as = await sheetInfo(page);
  const sa = Object.values(await sheetStars(page));
  check("posto alleato Supporto: foglio sulla scheda Supporto, tacche azzurre da 1 a 5", as.kind === "allies" && as.tab === "Support" && sa.some((x) => x.n === 5)
    && sa.every((x) => x.n >= 1 && x.n <= 5 && x.cls.includes("st-allies") && x.color === "rgb(79, 193, 233)"), JSON.stringify(as));
  await tapSheet(page, "Lúcio");
  await toTop(page);
  const sumA = await openWhy(0).then(() => text(page, "#why-body .why-sum"));
  await closeAll();
  check("con alleati: riga Alleati nei perché", /Alleati [+−]\d/.test(sumA), sumA);
  const picks = await pickNames(page);
  check("alleato non consigliato", !picks.includes("Lúcio"), picks.join());
  for (const n of ["Genji", "Mercy"]) await addTo(page, "enemies", n);
  check("5 avversari: niente più posti vuoti", (await matchState(page)).enemies.length === 5 && (await page.locator("#them-strip .slot.empty").count()) === 0
    && /5\/5/.test(await text(page, "#them-strip h3")));
  // l'avversario Mercy anche come alleato: lo hanno tutte e due le squadre (mirror)
  await addTo(page, "allies", "Mercy");
  check("avversario scelto come alleato: in tutte e due le squadre (mirror)", (await matchState(page)).enemies.length === 5
    && (await matchState(page)).allies.length === 2 && /2\/3 alleati/.test(await text(page, "#us-strip h3")));
  // ruolo cambiato al volo
  await toTop(page);
  const fabioBefore = (await pickNames(page))[0];
  await band(page, 1).locator(".role-btn").click();
  await toTop(page);
  check("ruolo di Giulia cambiato al volo (Supporto → Danni)", (await band(page, 1).locator(".role-btn").textContent()) === "Danni");
  const duo = await pickNames(page);
  check("con lo stesso ruolo eroi diversi", duo[0] !== duo[1] && roleOf(duo[0]) === "Damage" && roleOf(duo[1]) === "Damage", duo.join());
  check("il consiglio di Fabio non cambia per il ruolo di Giulia (salvo che serva un eroe diverso)", duo[0] === fabioBefore || duo[1] === fabioBefore,
    `${fabioBefore} → ${duo.join()}`);
  await band(page, 1).locator(".role-btn").click();
  await toTop(page);
  await shot(page, "06-durante-partita");

  // ---------- solo preferiti ----------
  await page.click(".tabs [data-view=profile]");
  await page.getByRole("button", { name: /Suggerisci solo eroi preferiti/ }).click();
  await page.click(".tabs [data-view=match]");
  await toTop(page);
  const giulia = (await favRows(page, 1)).map((r) => r.name);
  check("solo preferiti: Giulia vede solo Mercy/Juno (Mercy è alleata → solo Juno)", giulia.join() === "Juno", giulia.join());
  const fabio = await text(page, "#picks .band:nth-child(1)");
  check("solo preferiti: Fabio senza preferiti → i più adatti, con avviso", fabio.includes("nessun preferito disponibile")
    && (await favRows(page, 0)).length >= 2, fabio);
  await shot(page, "06b-solo-preferiti");
  // Giulia ha preso un eroe non preferito: «Passa a» (card e guida) propone solo preferiti
  await openPlayer(page, 1);
  const grp = await page.evaluate(() => {
    const blk = document.querySelector('#hs-grid [data-block="Support"]');
    const items = [...blk.children].filter((x) => x.getClientRects().length).map((x) => ({ t: x.textContent, h: x.classList.contains("sg-h"),
      fav: !!x.querySelector?.(".favmark"), y: Math.round(x.getBoundingClientRect().top), x: Math.round(x.getBoundingClientRect().left) }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    return items.map((x) => (x.h ? `#${x.t}` : x.fav ? "F" : "o")).join(" ");
  });
  check("solo preferiti acceso: nella lista di Giulia prima «I tuoi preferiti» (Juno, Mercy), poi «Tutti gli eroi»",
    /^#I tuoi preferiti F F #Tutti gli eroi( o)+$/.test(grp), grp);
  await tapSheet(page, "Brigitte");
  await toTop(page);
  const swapCard = await band(page, 1).evaluate((b) => (b.dataset.move ? [b.querySelector(".gcol .nm").textContent] : []));
  await openGuideOf(page, 1);
  const swapGuide = await page.locator("#guide-body .brief-row.k-swap .hchip").evaluateAll((cs) => cs.map((c) => c.lastChild.textContent));
  await page.click("#guide-dialog [data-close]");
  check("solo preferiti: dopo la scelta «Passa a» propone solo preferiti (Juno)", [...swapCard, ...swapGuide].every((n) => n.trim() === "Juno")
    && swapCard.length === 1 && swapGuide.length === 1, `card ${swapCard.join()} · guida ${swapGuide.join()}`);
  check("con «Passa a»: il ritratto grande resta Brigitte (l'eroe preso), Juno solo dopo la freccia",
    (await band(page, 1).getAttribute("data-has")) === heroId("Brigitte") && (await portraitsOk(page)).length === 0);
  await unpick(page, 1);
  await page.click(".tabs [data-view=profile]");
  await page.getByRole("button", { name: /Suggerisci solo eroi preferiti/ }).click();
  await page.click(".tabs [data-view=match]");

  // Control: niente lato
  await setMap(page, ILIOS);
  check("Control: attacco/difesa nascosto", !(await page.locator("#side").isVisible()));

  // ---------- memoria, «Nuova» (Inizio partita) e «Annulla» ----------
  await page.reload();
  await page.locator(CARD).first().waitFor();
  check("dopo ricarica: partita e profilo ricordati (si riapre sulla Partita)", (await matchState(page)).enemies.length === 5
    && (await text(page, "#picks")).includes("Giulia") && (await text(page, "#map-name")).includes(ILIOS) && !(await page.evaluate(() => window.owcStart())));
  const before = await matchState(page);
  await page.click("#new-match");
  await page.locator("#start-view:not([hidden])").waitFor();
  const mN = await matchState(page);
  check("«Nuova»: si apre l'Inizio partita («Nuova partita», «Annulla», «Avanti»), partita vuota tranne il profilo",
    (await page.evaluate(() => window.owcStart())) === "new" && await page.locator("#start-cancel").isVisible() && /Avanti/i.test(await text(page, "#start-next"))
    && !mN.enemies.length && !mN.bans.length && !mN.allies.length && mN.mapSlug === null && mN.started === false && /Giulia/.test(await text(page, "#start-team")), JSON.stringify(mN));
  await page.click("#start-cancel");
  await page.locator(CARD).first().waitFor();
  const mR = await matchState(page);
  check("Inizio partita → «Annulla»: la partita di prima torna intatta", JSON.stringify(mR) === JSON.stringify(before), `${JSON.stringify(before)}\n${JSON.stringify(mR)}`);
  await page.click("#new-match");
  await startMap(page, "King's Row");
  await page.click("#start-next");
  await page.locator(CARD).first().waitFor();
  const mA = await matchState(page);
  check("«Nuova» → solo la mappa → «Avanti»: Partita con la sola mappa (salvato solo ciò che è stato messo)", mA.started === true && mA.mapSlug === "kings-row"
    && !mA.enemies.length && !mA.bans.length && !mA.allies.length && mA.picked.every((x) => x === null), JSON.stringify(mA));
  check("messaggio «Nuova partita» con «Annulla» nella riga di stato della testata (non copre nulla)", await page.evaluate(() =>
    window.owcToastHost() === "hstatus" && getComputedStyle(document.querySelector("#hstatus .map-sub")).visibility === "hidden"
    && document.querySelector("#toast").getBoundingClientRect().bottom <= document.querySelector("#hstatus").getBoundingClientRect().bottom + 0.5)
    && /Annulla/.test(await text(page, "#toast")));
  await page.click("#toast .toast-btn");
  check("«Annulla» nel messaggio dopo «Avanti»: ripristina la partita di prima", JSON.stringify(await matchState(page)) === JSON.stringify(before));
  // indietro di Android nell'Inizio partita = «Avanti»
  await page.click("#new-match");
  await page.locator("#start-view:not([hidden])").waitFor();
  await page.goBack();
  await page.locator(CARD).first().waitFor();
  check("«indietro» nell'Inizio partita = «Avanti» (Partita, cominciata, l'app resta aperta)", (await matchState(page)).started === true
    && !(await page.evaluate(() => window.owcStart())) && await page.locator("#view-match").isVisible());

  // ---------- aggiorna senza token (Profilo) ----------
  await page.click(".tabs [data-view=profile]");
  await page.click("#refresh");
  await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
  check("aggiorna senza token: spiega come attivarlo", (await text(page, "#toast")).includes("token"));
  await page.click(".tabs [data-view=match]");

  // ---------- con 2 giocatori la Partita e l'Inizio partita stanno nello schermo, senza scorrere (390×844 e i telefoni dell'utente) ----------
  {
    const ids = (...ns) => ns.map(heroId);
    const STATES = {
      vuota: M({ mapSlug: null, side: null }),
      prima: M({ bans: ids("Widowmaker", "Sombra") }),
      avversari: M({ bans: ids("Widowmaker", "Sombra"), enemies: ids("Winston", "Tracer", "Ana"), picked: [heroId("Cassidy"), null] }),
      resta: M({ enemies: ids("Mercy"), picked: [heroId("Ashe"), null] }),
      piena: M({ bans: ids("Widowmaker"), enemies: ids("Winston", "Tracer", "Reaper", "Ana", "Mercy"), picked: ids("Cassidy", "Ana"), allies: ids("Zarya") }),
      inizio: M({ started: false, bans: ids("Widowmaker"), picked: [heroId("Cassidy"), null], allies: ids("Zarya") }),
      // riga di stato piena: 5 ban, modalità lunga, avviso dei dati vecchi
      ban5: M({ mapSlug: "new-junk-city", side: null, bans: ids("Widowmaker", "Sombra", "Ana", "Genji", "Kiriko"), enemies: ids("Winston") }),
    };
    for (const [w, h, nm] of [[390, 844, "390×844"], [407, 833, "Xiaomi 14T"], [420, 860, "Nothing Phone (3)"]]) {
      for (const [k, m] of Object.entries(STATES)) {
        const { ctx: cl, page: pl } = await seeded({ viewport: { width: w, height: h } }, P2, m);
        lastPage = pl;
        await pl.goto(BASE);
        await ready(pl, { next: false });
        await pl.waitForTimeout(150);
        const r = await pl.evaluate(() => {
          // la freschezza (o l'avviso giallo) sempre intera nella riga di stato, accanto a modalità e ban
          const f = [...document.querySelectorAll("#fresh-short, #warn")].find((x) => !x.hidden && x.offsetParent);
          const box = document.querySelector(".map-sub");
          return { over: document.scrollingElement.scrollHeight - innerHeight, hOver: document.documentElement.scrollWidth - innerWidth,
            fresh: !document.querySelector("#start-view").hidden || (!!f && f.getBoundingClientRect().right <= box.getBoundingClientRect().right + 0.5 && box.scrollWidth <= box.clientWidth + 1) };
        });
        const small = await smallTargets(pl);
        const gaps = k === "inizio" ? {} : await sectionGaps(pl);
        check(`${nm}, ${k}: tutto in vista senza scorrere, freschezza intera, bersagli ≥ 48 px, sezioni separate (≥ 12 px)`, r.over <= 0 && r.hOver <= 0 && r.fresh && !small.length
          && Object.values(gaps).every((g) => g >= 12), JSON.stringify({ r, small, gaps }));
        if (k !== "inizio") {
          const bo = await portraitsOk(pl);
          const fs = await facesState(pl);
          check(`${nm}, ${k}: ritratto grande = eroe preso o posto vuoto; volti quadrati e coerenti con matchups()`, !bo.length
            && facesOk(fs, (m.enemies ?? []).map(String)), JSON.stringify({ bo, fs }));
          if (m.enemies.length) {
            const tr = await pl.evaluate(() => [...document.querySelectorAll("#tips .tip")].map((t) => [t.scrollWidth - t.clientWidth, Math.round(t.getBoundingClientRect().height), /…/.test(t.textContent)]));
            check(`${nm}, ${k}: «Come giocarla» in vista, righe su una riga sola e mai «…»`, tr.length >= 1 && tr.every(([o, hh, d]) => o <= 1 && hh <= 30 && !d), JSON.stringify(tr));
          }
        }
        if (w === 390) await shot(pl, `07-${k}`);
        await cl.close();
      }
    }
    // messaggio con «Annulla»: nella riga di stato, mai sopra qualcosa di toccabile
    const { ctx: cm, page: pm } = await seeded({}, P2, STATES.avversari);
    await pm.goto(BASE);
    await ready(pm);
    await band(pm, 1).locator(".done").click();
    const cover = await pm.evaluate(() => {
      const t = document.querySelector("#toast").getBoundingClientRect();
      const hits = [...document.querySelectorAll("#view-match button, .dock button")].filter((b) => !b.closest("#toast") && b.offsetParent
        && getComputedStyle(b).visibility !== "hidden").filter((b) => {
        const r = b.getBoundingClientRect();
        return r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top;
      }).map((b) => b.id || b.className);
      return { host: window.owcToastHost(), hits };
    });
    check("messaggio con «Annulla»: nella riga di stato della testata, non copre nulla di toccabile", cover.host === "hstatus" && !cover.hits.length, JSON.stringify(cover));
    await cm.close();
  }

  // ---------- messaggio: due azioni di fila → un messaggio solo, «Annulla» vale per l'ultima; a pagina scorsa nella barra minima ----------
  {
    const { ctx: cm, page: pm } = await newPage({ serviceWorkers: "block" });
    await pm.goto(BASE);
    await ready(pm);
    await band(pm, 0).locator(".done").click();
    const first = (await matchState(pm)).picked[0];
    await band(pm, 1).locator(".done").click();
    const two = await pm.evaluate(() => ({ n: document.querySelectorAll("#toast").length, shown: [...document.querySelectorAll("#toast")].filter((t) => !t.hidden).length }));
    const msg = await text(pm, "#toast");
    await pm.locator("#toast .toast-btn").click();
    const m = await matchState(pm);
    check("due azioni di fila: un solo messaggio (l'ultimo), «Annulla» annulla solo l'ultima", two.n === 1 && two.shown === 1 && /Lei ha scelto/.test(msg)
      && m.picked[1] === null && m.picked[0] === first && first, JSON.stringify({ two, msg, m: m.picked }));
    check("dopo «Annulla» il messaggio sparisce e torna la riga di stato", await pm.locator("#toast").isHidden()
      && await pm.evaluate(() => getComputedStyle(document.querySelector("#hstatus .map-sub")).visibility) === "visible");
    await cm.close();
    const { ctx: cs2, page: ps2 } = await seeded({ viewport: { width: 360, height: 640 } }, P2, M({ enemies: ["Winston", "Tracer"].map(heroId), picked: [heroId("Cassidy"), null] }));
    await ps2.goto(BASE);
    await ready(ps2);
    await ps2.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    await ps2.waitForTimeout(150);
    const miniOn = await ps2.evaluate(() => !document.querySelector("#mini").hidden);
    await ps2.locator("#them-strip .slot.empty").first().click();
    await tapSheet(ps2, "Mercy");
    await ps2.waitForTimeout(100);
    // il tocco nel foglio non dà messaggi: ne serve uno → «✓» della barra minima non c'è, si usa «✓ PRESO» della seconda card dopo averla scorsa
    await band(ps2, 1).locator(".done").scrollIntoViewIfNeeded();
    await band(ps2, 1).locator(".done").click();
    await ps2.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    await ps2.waitForTimeout(150);
    const sm = await ps2.evaluate(() => { const t = document.querySelector("#toast").getBoundingClientRect(); const mini = document.querySelector("#mini").getBoundingClientRect();
      return { host: window.owcToastHost(), inside: t.top >= mini.top - 0.5 && t.bottom <= mini.bottom + 0.5, miniShown: !document.querySelector("#mini").hidden,
        cut: /…/.test(document.querySelector("#toast").textContent) }; });
    check("360×640 scorsa: la barra minima c'è quando la testata è fuori vista", miniOn);
    check("pagina scorsa (360×640): il messaggio prende il posto della barra minima, mai sopra altro; niente «…»", sm.host === "mini" && sm.inside && sm.miniShown && !sm.cut,
      JSON.stringify(sm));
    await shot(ps2, "21c-messaggio-barra-minima");
    await cs2.close();
  }

  // ---------- carattere di sistema ingrandito (Xiaomi al 130%): nomi interi, mai spezzati né tagliati ----------
  {
    const { ctx: c11, page: p11 } = await seeded({ viewport: { width: 407, height: 833 }, deviceScaleFactor: 3 }, P2,
      M({ picked: [heroId("Cassidy"), null], enemies: ["Winston", "Tracer"].map(heroId), allies: [heroId("Zarya")], bans: [heroId("Widowmaker")] }));
    lastPage = p11;
    await p11.goto(BASE);
    await ready(p11);
    // la WebView ingrandisce tutto il testo del 30%: qui lo si imita moltiplicando ogni dimensione dei caratteri
    await p11.evaluate(() => {
      const up = (v) => v.replace(/(\d+(?:\.\d+)?)px/g, (m, n) => `${(Number(n) * 1.3).toFixed(2)}px`);
      for (const sh of document.styleSheets) for (const r of sh.cssRules) {
        if (!r.style) continue;
        if (r.style.fontSize) r.style.fontSize = up(r.style.fontSize);
        else if (r.style.font) r.style.setProperty("font", r.style.getPropertyValue("font").replace(/^(.*?)(\d+(?:\.\d+)?px|calc\([^)]*\))/, (m, a, sz) => a + up(sz)));
      }
      window.dispatchEvent(new Event("resize"));
    });
    await p11.waitForTimeout(250);
    const test = () => p11.evaluate(async (sel) => {
      const out = [];
      for (const x of document.querySelectorAll(sel)) {
        if (!x.offsetParent) continue;
        const r = document.createRange();
        r.selectNodeContents(x);
        const lines = new Set([...r.getClientRects()].map((q) => Math.round(q.top))).size;
        if (lines > 1 || x.scrollWidth > x.clientWidth + 1) out.push(x.textContent);
      }
      return { out, overflow: document.documentElement.scrollWidth - innerWidth };
    }, "#picks .gcol .nm, #picks .alt3 .nm, #picks .hn, .strip .plate, .strip .slot .rl, #map-name");
    const b1 = await test();
    b1.tips = await p11.evaluate(() => [...document.querySelectorAll("#tips .tip")].filter((t) => t.scrollWidth > t.clientWidth + 1 || t.getBoundingClientRect().height > 40
      || /…/.test(t.textContent)).map((t) => t.textContent));
    b1.out.push(...b1.tips);
    check("carattere al 130%: nomi di card, posti, «Come giocarla» e mappa interi, mai spezzati né tagliati", b1.out.length === 0 && b1.overflow <= 0, JSON.stringify(b1));
    await shot(p11, "15-carattere-130");
    // lista eroi al 130%: tutte le schede
    await p11.locator("#them-strip .slot.empty").first().click();
    const sheetCut = await p11.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out = [];
      for (const tab of document.querySelectorAll("#hs-tabs .tab")) {
        tab.click();
        await frame();
        for (const x of document.querySelectorAll("#hs-grid [data-block]:not([hidden]) .hero .nm")) if (x.scrollWidth > x.clientWidth + 1) out.push(x.textContent);
      }
      return out;
    });
    check("carattere al 130%: nella lista eroi i nomi dei 53 eroi interi", !sheetCut.length, sheetCut.join());
    await c11.close();
  }

  // ---------- da 1 a 5 giocatori, ognuno col suo colore ----------
  {
    const QUEUE = [["Fabio", "Damage"], ["Giulia", "Support"], ["Marco", "Tank"], ["Sara", "Support"], ["Luca", "Damage"]];
    // eroe preso da ciascuno (scelto apposta diverso dal n. 1 consigliato, se possibile)
    const TAKE = { Damage: [itn("Soldier: 76"), "Sojourn"], Support: ["Ana", "Kiriko"], Tank: ["Reinhardt"] };
    for (const n of [1, 2, 3, 4, 5]) {
      for (const vp of n === 5 ? [{ width: 360, height: 640 }, { width: 407, height: 833, name: "Xiaomi 14T" }, { width: 420, height: 860, name: "Nothing Phone (3)" }]
        : [{ width: 407, height: 833, name: "Xiaomi 14T" }, { width: 420, height: 860, name: "Nothing Phone (3)" }]) {
        const players = QUEUE.slice(0, n).map(([name, role]) => ({ name, rank: "", roles: [role], favorites: [] }));
        const { ctx: c9, page: p9 } = await seeded({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 3 }, { players },
          { roles: players.map((p) => p.roles[0]), picked: players.map(() => null), mapSlug: "ilios", side: null, bans: [], enemies: ["Winston", "Genji", "Pharah"].map(heroId), allies: [], started: true });
        lastPage = p9;
        const label = `${n} giocator${n === 1 ? "e" : "i"}, ${vp.name ?? `${vp.width}×${vp.height}`}`;
        await p9.goto(BASE);
        await ready(p9);
        await toTop(p9);
        const st = await p9.evaluate(() => ({
          cards: document.querySelectorAll("#picks .band").length,
          compact: document.querySelectorAll("#picks .band.compact").length,
          moves: window.owcBands().map((b) => b.move),
          firsts: [...document.querySelectorAll("#picks .band")].map((b) => (b.querySelector(".gcol .nm") ?? b.querySelector(".cmp .nm"))?.textContent ?? ""),
          colors: [...document.querySelectorAll("#picks .band")].map((x) => getComputedStyle(x, "::before").backgroundColor),
          us: !document.querySelector("#us-strip").hidden,
          usPlayers: [...document.querySelectorAll("#us-strip .slot.player")].map((s) => getComputedStyle(s, "::after").boxShadow),
          allySlots: document.querySelectorAll("#us-strip .slot.ally").length,
        }));
        check(`${label}: una card per giocatore, ognuna con la proposta («PRENDI»)`, st.cards === n && st.moves.every(Boolean), JSON.stringify(st));
        check(`${label}: consigli tutti diversi, del ruolo di ciascuno`,
          new Set(st.firsts).size === n && st.firsts.every((h, i) => roleOf(h) === QUEUE[i][1]), st.firsts.join(", "));
        check(`${label}: un colore diverso per giocatore (card e posti della squadra)`, new Set(st.colors).size === n
          && (n === 5 || (st.usPlayers.length === n && new Set(st.usPlayers).size === n)), JSON.stringify(st.usPlayers));
        check(`${label}: «La vostra squadra» solo se ci sono posti alleati (${5 - n})`, st.us === (n < 5) && (n === 5 || st.allySlots === 5 - n), JSON.stringify(st));
        check(`${label}: prima della scelta il ritratto grande è il posto vuoto`, (await portraitsOk(p9)).length === 0, JSON.stringify(await portraitsOk(p9)));
        if (n <= 2) check(`${label}: niente card compatte`, st.compact === 0);
        else {
          check(`${label}: tutte le card compatte (una riga)`, st.compact === n
            && (await p9.locator("#picks .band.compact").evaluateAll((bs) => bs.every((b) => b.getBoundingClientRect().height <= 64))));
          await p9.locator("#picks .band").nth(1).locator(".cmp").click();
          const open1 = await p9.evaluate(() => [...document.querySelectorAll("#picks .band:not(.compact)")].map((b) => b.dataset.player));
          await p9.locator("#picks .band").nth(2).locator(".cmp").click();
          const open2 = await p9.evaluate(() => [...document.querySelectorAll("#picks .band:not(.compact)")].map((b) => b.dataset.player));
          check(`${label}: un tocco apre una card, aprirne un'altra chiude la prima`, open1.join() === "1" && open2.join() === "2", JSON.stringify([open1, open2]));
          await p9.locator("#picks .band:not(.compact) .fold").click();
          check(`${label}: la freccia richiude la card aperta`, (await p9.locator("#picks .band.compact").count()) === n);
        }
        if (n <= 2 || n === 5) await shot(p9, `13-squadra-${n}-${(vp.name ?? `${vp.width}`).replace(/\W+/g, "-")}-consigli`);
        // ognuno segna l'eroe che ha preso dalla sua lista eroi
        const used = { Damage: 0, Support: 0, Tank: 0 };
        const taken = [];
        const clash = [];
        for (let i = 0; i < n; i++) {
          const role = QUEUE[i][1];
          const h = TAKE[role][used[role]++];
          taken.push(h);
          await openPlayer(p9, i);
          const si = await sheetInfo(p9);
          check(`${label}: lista eroi di ${QUEUE[i][0]} sulla scheda del suo ruolo`, si.kind === "player" && si.i === i && si.tab === role, JSON.stringify(si));
          await tapSheet(p9, h);
          const pr = await p9.evaluate(() => window.owcBands());
          const moves = pr.filter((b) => b.move).map((b) => b.move);
          const hasIds = pr.filter((b) => b.has).map((b) => b.has);
          if (new Set(moves).size !== moves.length || moves.some((m) => hasIds.includes(m))) clash.push(JSON.stringify(pr));
        }
        check(`${label}: a ogni scelta le proposte in vista («Prendi»/«Passa a») sono tutte diverse tra loro e dagli eroi presi`, !clash.length, clash.join(" | "));
        await p9.waitForTimeout(150);
        await toTop(p9);
        const after = await p9.evaluate(() => ({ bands: window.owcBands() }));
        check(`${label}: ogni card ha nel ritratto grande l'eroe preso`, after.bands.map((b) => nameOfId(b.has)).join() === taken.join() && (await portraitsOk(p9)).length === 0,
          JSON.stringify(after.bands));
        check(`${label}: dopo la scelta un eventuale cambio («Passa a») non propone eroi presi dagli altri`,
          after.bands.every((b) => !b.move || !taken.includes(nameOfId(b.move))), JSON.stringify(after.bands));
        // barra minima (pagina scorsa o lista eroi aperta): tutti visibili, ognuno col suo eroe preso, non troppo alta
        await p9.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
        await p9.waitForTimeout(150);
        const bar = await p9.evaluate(() => {
          const mini = document.querySelector("#mini");
          const m = JSON.parse(localStorage.getItem("owc.match"));
          return { shown: !mini.hidden, count: mini.querySelectorAll(".mini-pick").length, scroll: document.querySelector("#hstatus").getBoundingClientRect().bottom < 0,
            has: [...mini.querySelectorAll(".mini-pick")].every((b) => b.dataset.has === String(m.picked[Number(b.dataset.player)])),
            bottom: Math.round(mini.getBoundingClientRect().bottom), overflow: document.documentElement.scrollWidth - window.innerWidth,
            cut: [...mini.querySelectorAll(".nm")].filter((b) => b.offsetParent && b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent) };
        });
        check(`${label}: barra minima (se la testata è fuori vista) con tutti i ${n}, l'eroe che hanno, bassa (≤ 140 px)`,
          !bar.scroll || (bar.shown && bar.count === n && bar.has && bar.bottom <= 140 && !bar.cut.length), JSON.stringify(bar));
        check(`${label}: niente scorrimento orizzontale`, bar.overflow <= 0, `${bar.overflow}px`);
        if (n === 5) await shot(p9, `13-squadra-5-${(vp.name ?? `${vp.width}`).replace(/\W+/g, "-")}-scorsa`);
        await openGuideOf(p9, 0);
        check(`${label}: «Come giocarla» sull'eroe preso`, (await text(p9, "#t-guide")).includes(taken[0]), await text(p9, "#t-guide"));
        await p9.locator("#guide-dialog [data-close]").click();
        await c9.close();
      }
    }

    // segnare un eroe preso che è anche avversario (mirror); «Non l'ho preso»; scegliere dalla proposta; dalla guida
    const { ctx: c10, page: p10 } = await newPage({ serviceWorkers: "block" });
    lastPage = p10;
    await p10.goto(BASE);
    await ready(p10);
    await addTo(p10, "enemies", "Mercy");
    await openPlayer(p10, 1);
    const mir = await sheetTile(p10, "Mercy").evaluate((b) => ({ cl: [...b.classList], why: b.dataset.why ?? "", label: b.getAttribute("aria-label"),
      after: getComputedStyle(b, "::after").content, h: Math.round(parseFloat(getComputedStyle(b, "::after").height)) }));
    check("lista del giocatore: un avversario resta selezionabile (mirror), segnato solo con «avv.» piccolo, non spento",
      mir.cl.includes("vs") && !mir.cl.includes("off") && !mir.why && /anche avversario/.test(mir.label) && /avv/.test(mir.after) && mir.h <= 16, JSON.stringify(mir));
    await tapSheet(p10, "Mercy");
    const m1 = await matchState(p10);
    check("eroe preso dalla lista del giocatore: assegnato, resta avversario (mirror)", m1.enemies.map(String).includes(heroId("Mercy")) && String(m1.picked[1]) === heroId("Mercy") && m1.picked[0] === null, JSON.stringify(m1));
    await unpick(p10, 1);
    check("«Non l'ho preso»: l'eroe non è più segnato", (await matchState(p10)).picked[1] === null);
    await toTop(p10);
    const rec0 = (await favRows(p10, 0))[0].name;
    await band(p10, 0).locator(".done").click();
    await toTop(p10);
    check("un tocco su «✓ PRESO» e l'eroe è segnato come scelto", String((await matchState(p10)).picked[0]) === heroId(rec0)
      && (await band(p10, 0).getAttribute("data-has")) === heroId(rec0), rec0);
    await openPlayer(p10, 1);
    await closeSheet(p10);
    check("lista eroi chiusa con ×: niente segnato", (await matchState(p10)).picked[1] === null);
    await band(p10, 1).locator(".go").click();
    await p10.locator("#guide-body .took-btn").click();
    check("dalla guida: «Segna: Lei l'ha preso»", (await matchState(p10)).picked[1] !== null
      && (await p10.locator("#guide-body .took-btn").getAttribute("aria-pressed")) === "true");
    await p10.click("#guide-dialog [data-close]");
    // un'alternativa («oppure»): un tocco la sceglie
    await unpick(p10, 1);
    await toTop(p10);
    const alt = (await favRows(p10, 1))[1];
    await band(p10, 1).locator(`.alt3[data-id="${alt.id}"]`).click();
    check("«oppure»: un tocco sull'alternativa la sceglie", String((await matchState(p10)).picked[1]) === alt.id, JSON.stringify(alt));

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
    const four = await p10.evaluate(() => ({ cards: document.querySelectorAll("#picks .band").length, m: JSON.parse(localStorage.getItem("owc.match")) }));
    check("rimosso un giocatore: 4 card, partita adeguata", four.cards === 4 && four.m.roles.length === 4 && four.m.picked.length === 4, JSON.stringify(four));
    await c10.close();
  }

  // ---------- ricerca nella lista eroi (un tocco + poche lettere, tutti i ruoli) e mappe; nomi italiani ufficiali (names_it.json) ----------
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
    await ready(p12);
    const shown = (sel) => p12.$$eval(sel, (bs) => bs.filter((b) => b.offsetParent).map((b) => (b.querySelector(".nm") ?? b).textContent));
    const results = () => shown("#results-list .hero");
    const search = async (q) => { await p12.fill("#hero-q", q); return results(); };
    await p12.locator("#them-strip .slot.empty[data-role=Tank]").click();
    const tabBefore = (await sheetInfo(p12)).tab;
    await p12.click("#hero-q");
    check("ricerca: il campo è in cima alla lista eroi; un tocco apre la ricerca (schede e griglia nascoste, suggerimento)",
      await p12.evaluate(() => window.owcSearching()) && await p12.locator("#hs-grid").isHidden() && await p12.locator("#hs-tabs").isHidden()
      && await p12.locator("#hs-hint").isVisible() && tabBefore === "Tank");
    check("ricerca eroi: senza accenti («lucio» → Lúcio)", (await search("lucio")).join() === "Lúcio", (await search("lucio")).join());
    check("ricerca eroi: per iniziali («jq» → Junker Queen)", (await search("jq")).join() === "Junker Queen", (await search("jq")).join());
    check("ricerca eroi: nome italiano mostrato e trovato anche in inglese e senza simboli",
      (await search("soldier76")).join() === "Soldato-76" && (await search("soldato")).join() === "Soldato-76", (await search("soldier76")).join());
    const an = await search("an");
    check("ricerca eroi: risultati di tutti i ruoli (anche fuori dalla scheda Tank), prima chi comincia con la ricerca, al massimo 8, il primo con «INVIO»",
      an.length >= 3 && an.length <= 8 && an.slice(0, 2).every((x) => /^an/i.test(x)) && new Set(an.map((x) => roleOf(x))).size >= 2
      && await p12.locator("#results-list .hero:not([hidden])").first().evaluate((b) => b.classList.contains("first"))
      && /risultat. per «an» in tutti i ruoli/.test(await text(p12, "#results-hd")), an.join());
    const none = await search("zzz");
    check("ricerca eroi: nessun risultato → messaggio", none.length === 0 && (await p12.locator("[data-none=hs-results]").isVisible()));
    // tastiera aperta: la finestra si accorcia (adjustResize) → i risultati stanno subito sopra, dentro l'area visibile
    await p12.setViewportSize({ width: 390, height: 554 });
    await p12.fill("#hero-q", "me");
    await p12.waitForTimeout(150);
    const kb = await p12.evaluate(() => { const r = document.querySelector("#hs-results").getBoundingClientRect();
      const tiles = [...document.querySelectorAll("#results-list .hero:not([hidden])")].map((b) => b.getBoundingClientRect());
      return { bottom: Math.round(r.bottom), top: Math.round(r.top), h: innerHeight, n: tiles.length, inside: tiles.every((t) => t.top >= 0 && t.bottom <= innerHeight + 0.5),
        input: document.querySelector("#hero-q").getBoundingClientRect().bottom, tall: tiles.every((t) => t.height >= 48) }; });
    check("ricerca con la tastiera (finestra di 554 px): risultati ancorati sopra la tastiera, tutti in vista, sotto il campo",
      kb.n >= 1 && Math.abs(kb.bottom - kb.h) <= 1 && kb.inside && kb.top >= kb.input && kb.tall, JSON.stringify(kb));
    await shot(p12, "16b-ricerca-tastiera");
    await p12.setViewportSize({ width: 390, height: 844 });
    await p12.fill("#hero-q", "phar");
    await p12.press("#hero-q", "Enter");
    const afterEnter = await p12.evaluate(() => ({ open: document.querySelector("#hero-sheet").open, enemies: JSON.parse(localStorage.getItem("owc.match")).enemies.length }));
    check("ricerca: Invio segna il primo risultato (Pharah, Danni, dal posto Tank) e chiude la lista", !afterEnter.open && afterEnter.enemies === 1
      && (await slotOf(p12, "enemies", "Pharah").count()) === 1, JSON.stringify(afterEnter));
    // in ogni lista: ban (Inizio partita), alleati, giocatore
    await p12.locator("#us-strip .slot.ally.empty").first().click();
    await p12.click("#hero-q");
    await p12.keyboard.type("luc");
    await p12.locator("#results-list .hero", { has: p12.locator(".nm", { hasText: /^Lúcio$/ }) }).click();
    check("ricerca tra gli alleati: un tocco sul risultato lo segna e chiude", (await matchState(p12)).allies.map(String).includes(heroId("Lúcio"))
      && !(await p12.evaluate(() => document.querySelector("#hero-sheet").open)));
    await openPlayer(p12, 0);
    await p12.click("#hero-q");
    await p12.keyboard.type("zen");
    await p12.keyboard.press("Enter");
    check("ricerca nella lista del giocatore: trova un eroe di un altro ruolo (Zenyatta per Danni), Invio lo segna preso",
      String((await matchState(p12)).picked[0]) === heroId("Zenyatta"));
    await openPlayer(p12, 1);
    await p12.click("#hero-q");
    await p12.keyboard.type("pha");
    check("ricerca: un eroe già segnato altrove ha il suo segno («Avversario» = mirror possibile per un giocatore)",
      (await results()).includes("Pharah"));
    await p12.goBack();
    await p12.waitForTimeout(200);
    check("ricerca: «indietro» la chiude (e non chiude l'app)", !(await p12.evaluate(() => window.owcSearching())) && (await p12.inputValue("#hero-q")) === "");
    await closeSheet(p12);

    await p12.click("#map-btn");
    await p12.click("#start-map");
    await p12.fill("#map-q", "kings");
    check("ricerca mappe: «kings» → King's Row", (await shown("#map-list .map-opt")).join() === "King's Row", (await shown("#map-list .map-opt")).join());
    await p12.fill("#map-q", "gibraltar");
    check("ricerca mappe: nome italiano mostrato, trovato anche in inglese",
      (await shown("#map-list .map-opt")).join() === "Osservatorio: Gibilterra", (await shown("#map-list .map-opt")).join());
    check("ricerca mappe: campo fermo in cima al foglio", await p12.locator("#map-dialog .search").evaluate((s) => getComputedStyle(s).position === "sticky"));
    await p12.fill("#map-q", "kings");
    await p12.press("#map-q", "Enter");
    check("ricerca mappe: Invio sceglie la mappa e chiude", !(await p12.locator("#map-dialog").evaluate((d) => d.open))
      && (await text(p12, "#start-map")).includes("King's Row"));
    await p12.click("#start-map");
    check("ricerca mappe: riaprendo la finestra il campo è vuoto", (await p12.inputValue("#map-q")) === ""
      && (await shown("#map-list .map-opt")).length === data.maps.length + 1);
    await p12.click("#map-dialog [data-close]");
    await p12.click("#start-next");

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

    // abilità: nel «Come giocarla» i nomi ufficiali italiani (anche dentro i consigli scritti), non quelli inglesi
    await unpick(p12, 0);
    await openGuideOf(p12, 0);
    await p12.click("#guide-body .more-btn");
    const hero = (await text(p12, "#t-guide")).replace(/^Come giocare /, "");
    const guide = await text(p12, "#guide-body");
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
    await ready(p14);
    const depth = () => p14.evaluate(() => history.state?.owc ?? 0);
    const d0 = await depth();
    await p14.locator("#picks .go").first().click();
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
    await p14.locator("#them-strip .slot.empty").first().click();
    await p14.click("#hero-sheet [data-close]");
    await p14.waitForTimeout(150);
    check("foglio chiuso col pulsante: nessun passo in più nella cronologia", (await depth()) === d0, `${await depth()} vs ${d0}`);
    await openPlayer(p14, 0);
    await p14.goBack();
    await p14.waitForTimeout(150);
    check("indietro: chiude la lista eroi del giocatore", !(await p14.locator("#hero-sheet").evaluate((d) => d.open)));
    await p14.locator("#them-strip .slot.empty").first().click();
    await p14.click("#hero-q");
    await p14.goBack();
    await p14.waitForTimeout(150);
    const s3 = await p14.evaluate(() => ({ searching: window.owcSearching(), open: document.querySelector("#hero-sheet").open }));
    await p14.goBack();
    await p14.waitForTimeout(150);
    check("indietro con la ricerca aperta: prima la ricerca, poi la lista; l'app resta", !s3.searching && s3.open
      && !(await p14.locator("#hero-sheet").evaluate((d) => d.open)) && await p14.locator("#picks").isVisible() && (await depth()) === d0, JSON.stringify(s3));
    await c14.close();
  }

  // ---------- partita salvata da una versione precedente (senza «started»): si apre sulla Partita ----------
  {
    const { ctx: co, page: po } = await seeded({}, P2, { roles: ["Damage", "Support"], picked: [null, null], pickFor: 0, mapSlug: "kings-row", side: "attack",
      bans: [heroId("Ana")], enemies: [heroId("Winston")], allies: [], group: "enemies" });
    await po.goto(BASE);
    await ready(po, { next: false });
    const mo = await matchState(po);
    check("partita salvata senza «started» (versione precedente): si apre sulla Partita, già cominciata, dati intatti",
      !(await po.evaluate(() => window.owcStart())) && await po.locator(CARD).first().isVisible() && mo.started === true
      && mo.bans.map(String).join() === heroId("Ana") && mo.enemies.map(String).join() === heroId("Winston"), JSON.stringify(mo));
    await co.close();
  }

  // ---------- «Consigli solo da guide e pro»: niente statistiche di counterwatch ----------
  {
    const { ctx: c13, page: p13 } = await newPage({ viewport: { width: 407, height: 833 }, serviceWorkers: "block" });
    lastPage = p13;
    await p13.addInitScript(() => localStorage.setItem("owc.profile", JSON.stringify({
      players: [{ name: "Fabio", rank: "", roles: ["Damage"], favorites: [] }, { name: "Giulia", rank: "", roles: ["Support"], favorites: [] }] })));
    await p13.goto(BASE);
    await ready(p13);
    await p13.click(".tabs [data-view=profile]");
    await p13.click("#guide-only");
    check("profilo: «Consigli solo da guide e pro» attivo, l'altra opzione sulla teoria nascosta",
      (await p13.getAttribute("#guide-only", "aria-pressed")) === "true"
      && (await p13.getByRole("button", { name: /Usa anche la teoria/ }).count()) === 0);
    await p13.click(".tabs [data-view=match]");
    await setMap(p13, "King's Row");
    await toTop(p13);
    const cardsTxt = await p13.locator(CARD).evaluateAll((cs) => cs.map((c) => [c.textContent + (c.querySelector(".go")?.getAttribute("aria-label") ?? ""),
      c.querySelectorAll("[data-stars]").length]));
    check("solo guide: nelle carte nessuna percentuale (neanche nelle etichette), valutazioni 1–5 presenti", cardsTxt.every(([t, n]) => n > 0 && !/\d+[.,]?\d*%/.test(t)), JSON.stringify(cardsTxt));
    await openEdit(p13);
    const gb = await startNames(p13);
    check("solo guide: ban consigliati dalle guide (4 per ruolo, col livello)", ["Tank", "Damage", "Support"].every((r) => gb[r].length === 4 && gb[r].every((x) => x.n >= 1 && x.n <= 5)));
    await shot(p13, "17-solo-guide");
    await p13.click("#start-next");
    for (const n of ["Pharah", "Winston"]) await addTo(p13, "enemies", n);
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
    const fsG = await facesState(p13);
    check("solo guide: i volti batte/teme vengono dalla teoria (matchups), solo tra gli avversari segnati", facesOk(fsG, ["Pharah", "Winston"].map(heroId)), JSON.stringify(fsG));
    const gStars = (await favRows(p13, 0))[0].n;
    await band(p13, 0).locator(".done").click();
    await toTop(p13);
    const gCard = await band(p13, 0).evaluate((c) => ({ n: Number(c.querySelector(".has")?.dataset.stars ?? 0), text: c.textContent }));
    check("solo guide: eroe scelto con le tacche (le stesse della striscia), senza percentuali",
      gCard.n === gStars && gCard.n >= 1 && !/\d+%/.test(gCard.text), JSON.stringify(gCard).slice(0, 300));
    await c13.close();
  }

  // ---------- dati riletti ogni 30 minuti, solo con l'app aperta (niente timer) ----------
  {
    const { ctx: c6, page: p6 } = await newPage({ serviceWorkers: "block" });
    let hits = 0, version = data.checked;
    await c6.route("**/data.json*", (r) => { hits++; return r.fulfill({ json: { ...data, checked: version } }); });
    await p6.clock.install();
    await p6.goto(BASE);
    await ready(p6);
    const h0 = hits;
    await p6.clock.runFor(2 * 3600e3);              // 2 ore senza toccare niente
    check("app lasciata lì: nessuna richiesta di dati senza interazione (niente timer)", hits === h0, `${hits - h0} richieste`);
    await p6.click("#them-strip h3");                // primo tocco dopo 2 ore: i dati vanno riletti
    await p6.waitForTimeout(300);
    const h1 = hits;
    check("tocco dopo più di 30 minuti: dati riletti", h1 === h0 + 1, `${h1 - h0} richieste`);
    await p6.click("#them-strip h3");
    await p6.waitForTimeout(300);
    check("altro tocco subito dopo: nessuna nuova richiesta", hits === h1, `${hits - h1}`);
    version = new Date().toISOString();
    await p6.clock.runFor(31 * 60e3);
    await p6.click("#us-strip h3");
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
    await ready(p5);
    const roleOf = () => p5.evaluate(() => {
      const b = [...document.querySelectorAll("#hs-grid .hero")].find((x) => x.querySelector(".nm").textContent === "Sombra");
      return { Damage: "Danni", Support: "Supporto", Tank: "Tank" }[b.closest("[data-block]").dataset.block];
    });
    const before = await roleOf();
    swapped = true;
    await p5.click(".tabs [data-view=profile]");
    await p5.click("#refresh");
    await p5.waitForFunction(() => !document.querySelector("#refresh").disabled);
    const after = await roleOf();
    check("ruolo cambiato nei dati: la lista eroi si aggiorna senza riaprire l'app", before === "Danni" && after === "Supporto", `${before} → ${after}`);
    await c5.close();
  }

  // ---------- offline ----------
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await ready(page);
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
    await ready(p2);
    const w = await text(p2, "#warn");
    const wf = await p2.locator("#warn-full").textContent();
    check("dati vecchi/parziali: in testata la riga gialla al posto della freschezza, spiegazione completa nel foglio delle mappe, app funzionante",
      (await p2.locator("#warn").isVisible()) && /dati vecchi: 3 giorni/.test(w) && await p2.locator("#fresh-short").isHidden()
      && (await p2.locator("#warn").evaluate((x) => getComputedStyle(x).color)) === "rgb(255, 209, 102)"
      && wf.includes("non vengono aggiornati") && wf.includes("dati precedenti") && (await p2.locator(CARD).count()) === 2, `${w} | ${wf}`);
    await p2.click("#map-btn");
    await p2.click("#start-map");
    check("dati vecchi: la spiegazione completa è in cima al foglio delle mappe", await p2.locator("#warn-full").isVisible());
    await p2.click("#map-dialog [data-close]");
    await p2.click("#start-next");
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
    await ready(pf);
    const f1 = await text(pf, "#fresh-short");
    check("freschezza in testata: «Ibrida/… · dati di 3 h fa» quando i dati sono freschi", await pf.locator("#fresh-short").isVisible() && f1 === "dati di 3 h fa"
      && await pf.locator("#warn").isHidden(), f1);
    await pf.clock.runFor(31 * 60e3);
    checked = new Date(await pf.evaluate(() => Date.now())).toISOString(); // l'orologio della pagina è finto
    await pf.click("#them-strip h3");
    await pf.waitForFunction(() => /adesso/.test(document.querySelector("#fresh-short").textContent), null, { timeout: 5000 }).catch(() => {});
    // (il messaggio «Dati aggiornati» copre per qualche secondo la riga di stato: si legge il testo sotto)
    const f2 = await pf.locator("#fresh-short").textContent();
    check("freschezza in testata: aggiornata al primo tocco dopo 30 minuti", /controllati adesso/.test(f2), f2);
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
    await ready(p4);
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
    const M0 = { roles: ["Tank", "Support"], picked: [null, null], mapSlug: "kings-row", side: "defense", bans: [], enemies: [], allies: [], started: true };
    const seed = async (m) => {
      await px.evaluate(([p, mm]) => { localStorage.setItem("owc.profile", JSON.stringify(p)); localStorage.setItem("owc.match", JSON.stringify(mm)); }, [PROF, m]);
      await px.reload();
      await ready(px);
    };
    await px.goto(BASE);
    await ready(px);
    await seed(M0);
    const st = () => matchState(px);
    const has = (arr, n) => (arr ?? []).map(String).includes(heroId(n));
    // «Chi soffrite di più» = il punto rosso (3 per ruolo) nella lista eroi degli avversari
    const threatNames = async () => {
      await px.locator("#them-strip .slot").first().click();
      const r = await px.locator("#hs-grid .hero.top3 .nm").evaluateAll((xs) => xs.map((x) => x.textContent));
      await closeSheet(px);
      return r;
    };
    const cardName = async (k) => nameOfId(await band(px, k).getAttribute("data-has"));
    // eroi che il giocatore k può prendere: proposta e alternative della card + quelli non spenti nella sua lista
    const choices = async (k) => {
      const inBand = (await favRows(px, k)).map((r) => r.name);
      await openPlayer(px, k);
      const inSheet = Object.entries(await sheetStars(px)).filter(([, x]) => !x.cl.includes("off")).map(([n]) => n);
      await closeSheet(px);
      return [...inBand, ...inSheet];
    };
    const recBans = async () => { await openEdit(px); const r = await startNames(px); await px.click("#start-next"); await ready(px);
      return ["Tank", "Damage", "Support"].flatMap((x) => r[x].map((y) => nameOfId(y.id))); };
    const banIt = async (n) => { await openEdit(px); await banStart(px, n); await px.click("#start-next"); await ready(px); };

    check("incroci: «Chi soffrite di più» nascosto senza eroi scelti né alleati", (await threatNames()).length === 0);

    // un tank scelto da Fabio che compare anche tra i più pericolosi (il caso segnalato: Sigma)
    const tanks = data.heroes.filter((h) => h.role === "Tank").map((h) => itn(h.name));
    let X = null;
    for (const n of ["Sigma", ...tanks.filter((t) => t !== "Sigma")]) {
      await seed({ ...M0, picked: [heroId(n), null] });
      if ((await threatNames()).includes(n)) { X = n; break; }
    }
    check("incroci: c'è un eroe scelto che è anche tra «Chi soffrite di più»", !!X, "nessun tank scelto compare tra i pericoli");
    if (X) {
      check(`incroci: ${X} scelto → punti rossi in vista, ${X} non ancora avversario`, (await threatNames()).length === 9 && !has((await st()).enemies, X));
      await addTo(px, "enemies", X);
      let s = await st();
      check(`incroci: ${X} (punto rosso) segnato avversario → avversario E resta scelto da Fabio (mirror)`,
        has(s.enemies, X) && String(s.picked[0]) === heroId(X) && (await cardName(0)) === X && (await slotOf(px, "enemies", X).count()) === 1
        && /1\/5/.test(await text(px, "#them-strip h3")), JSON.stringify(s));
      check(`incroci: ${X} è sia nel posto di Fabio (la vostra squadra) sia tra gli avversari`,
        (await px.locator(`#us-strip .slot.player[data-player="0"][data-id="${heroId(X)}"]`).count()) === 1);
      await shot(px, "05i-mirror");
      check(`incroci: ${X} avversario non sparisce dalla card di Fabio (è ancora il suo eroe)`, (await pickNames(px))[0] === X);
      await removeFrom(px, "enemies", X);
      s = await st();
      check(`incroci: «Togli» dal posto → ${X} non più avversario, sempre scelto`, !has(s.enemies, X) && String(s.picked[0]) === heroId(X), JSON.stringify(s));
      await addTo(px, "enemies", X);
      await px.reload();
      await ready(px);
      s = await st();
      check("incroci: dopo il riavvio scelto e avversario restano entrambi", has(s.enemies, X) && String(s.picked[0]) === heroId(X), JSON.stringify(s));
    }

    // avversario già segnato → lo scelgo io (lista del giocatore): resta avversario
    await seed({ ...M0, enemies: ids("Reinhardt") });
    await choosePlayer(px, 0, "Reinhardt");
    let s = await st();
    check("incroci: scelgo un eroe già avversario → scelto e ancora avversario", String(s.picked[0]) === heroId("Reinhardt") && has(s.enemies, "Reinhardt"), JSON.stringify(s));
    await px.locator("#toast button", { hasText: "Annulla" }).click();
    s = await st();
    check("incroci: «Annulla» la scelta → non scelto, l'avversario resta", s.picked[0] === null && has(s.enemies, "Reinhardt"), JSON.stringify(s));
    await choosePlayer(px, 0, "Reinhardt");
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
    await seed(M0);
    await addTo(px, "allies", "Winston");
    await addTo(px, "enemies", "Winston");
    s = await st();
    check("incroci: lo stesso eroe alleato e avversario (mirror)", has(s.allies, "Winston") && has(s.enemies, "Winston"), JSON.stringify(s));
    check("incroci: con un alleato «Chi soffrite di più» compare", (await threatNames()).length === 9);
    check("incroci: un alleato non è tra le scelte di Fabio (spento, «Alleato»)", !(await choices(0)).includes("Winston"));
    await choosePlayer(px, 0, "Winston");
    s = await st();
    check("incroci: Fabio sceglie l'eroe dell'alleato → esce dagli alleati, resta avversario", String(s.picked[0]) === heroId("Winston")
      && !has(s.allies, "Winston") && has(s.enemies, "Winston"), JSON.stringify(s));
    await addTo(px, "allies", "Winston");
    s = await st();
    check("incroci: l'eroe di Fabio scelto tra gli alleati → diventa alleato, Fabio senza scelta (una volta per squadra)",
      has(s.allies, "Winston") && s.picked[0] === null && has(s.enemies, "Winston"), JSON.stringify(s));
    await banIt("Winston");
    s = await st();
    check("incroci: bannato → fuori da alleati e avversari", has(s.bans, "Winston") && !has(s.allies, "Winston") && !has(s.enemies, "Winston"), JSON.stringify(s));
    check("incroci: bannato → fuori dai consigli e dalle liste", !(await pickNames(px)).includes("Winston") && !(await choices(0)).includes("Winston"));
    await addTo(px, "enemies", "Winston");
    s = await st();
    check("incroci: bannato segnato tra gli avversari → non più bannato, avversario", !has(s.bans, "Winston") && has(s.enemies, "Winston"), JSON.stringify(s));

    // scelto e bannato: il ban toglie la scelta; dai ban consigliati lo stesso
    await seed({ ...M0, picked: [heroId("Sigma"), null], enemies: ids("Sigma", "Ana") });
    await banIt("Sigma");
    s = await st();
    check("incroci: l'eroe scelto e avversario viene bannato → né scelto né avversario", has(s.bans, "Sigma") && s.picked[0] === null
      && !has(s.enemies, "Sigma") && has(s.enemies, "Ana"), JSON.stringify(s));
    const recBan = (await recBans()).find((n) => !has(s.bans, n) && !has(s.enemies, n));
    await addTo(px, "enemies", recBan);
    check(`incroci: ${recBan} avversario resta tra i ban consigliati`, (await recBans()).includes(recBan));
    await banIt(recBan);
    s = await st();
    check(`incroci: avversario bannato dai ban consigliati (${recBan}) → esce dagli avversari`, has(s.bans, recBan) && !has(s.enemies, recBan), JSON.stringify(s));
    // i ban consigliati non propongono mai eroi scelti né alleati (anche se forti sulla mappa)
    for (const [tank, sup] of [["Sigma", "Mizuki"], ["Reinhardt", "Wuyang"], ["Winston", "Zenyatta"]]) {
      await seed({ ...M0, picked: [heroId(tank), null], allies: ids(sup) });
      const recs = await recBans();
      check(`incroci: ban consigliati mai su ${tank} (scelto) né ${sup} (alleato)`, recs.length === 12 && !recs.includes(tank) && !recs.includes(sup), recs.join());
    }
    // bannato poi scelto da Fabio dalla sua lista
    await seed({ ...M0, bans: ids("Reinhardt") });
    check("incroci: un bannato non è tra le scelte", !(await choices(0)).includes("Reinhardt"));
    await choosePlayer(px, 0, "Reinhardt");
    s = await st();
    check("incroci: scelgo un bannato dalla lista → non più bannato, scelto", String(s.picked[0]) === heroId("Reinhardt") && !has(s.bans, "Reinhardt"), JSON.stringify(s));

    // un eroe preso da Giulia passa a Fabio
    await seed({ ...M0, roles: ["Tank", "Tank"], picked: [null, heroId("Sigma")] });
    await choosePlayer(px, 0, "Sigma");
    s = await st();
    check("incroci: l'eroe di Giulia scelto da Fabio → passa a Fabio (una volta per squadra)", String(s.picked[0]) === heroId("Sigma") && s.picked[1] === null, JSON.stringify(s));

    // limiti: 5 avversari (anche col vostro eroe tra loro), 5 ban
    await seed({ ...M0, picked: [heroId("Sigma"), null], enemies: ids("Sigma", "Ana", "Genji", "Tracer", "Lúcio") });
    check("incroci: 5 avversari (uno è il vostro Sigma) → nessun posto vuoto", (await px.locator("#them-strip .slot.empty").count()) === 0);
    await slotOf(px, "enemies", "Ana").click();
    await tapSheet(px, "Mercy");
    s = await st();
    check("incroci: con 5 avversari un posto pieno si cambia (Ana → Mercy), sempre 5, Sigma resta scelto", s.enemies.length === 5 && has(s.enemies, "Mercy")
      && !has(s.enemies, "Ana") && String(s.picked[0]) === heroId("Sigma"), JSON.stringify(s));
    await removeFrom(px, "enemies", "Sigma");
    const s2 = await st();
    check("incroci: con 5 avversari si toglie Sigma dal suo posto → resta scelto", !has(s2.enemies, "Sigma") && String(s2.picked[0]) === heroId("Sigma"), JSON.stringify(s2));
    await seed({ ...M0, bans: ids("Ana", "Genji", "Tracer", "Lúcio", "Mercy") });
    await openEdit(px);
    await banStart(px, "Kiriko");
    s = await st();
    check("incroci: 5 ban → il sesto è rifiutato", s.bans.length === 5 && !has(s.bans, "Kiriko"), JSON.stringify(s));
    await px.click("#start-next");

    // partita salvata da una versione precedente con stati impossibili: si sistema
    await seed({ ...M0, picked: [heroId("Sigma"), heroId("Sigma")], bans: ids("Ana", "Ana"), enemies: ids("Ana", "Genji", "Genji"), allies: ids("Sigma", "Ana", "Mercy") });
    s = await st();
    check("incroci: partita salvata incoerente → sistemata (bannato fuori da tutto, un eroe una volta per squadra)",
      String(s.picked[0]) === heroId("Sigma") && s.picked[1] === null && s.bans.length === 1 && s.enemies.length === 1 && has(s.enemies, "Genji")
      && s.allies.length === 1 && has(s.allies, "Mercy"), JSON.stringify(s));

    // «Nuova» azzera tutto (Inizio partita), «Annulla» ripristina anche il mirror
    await seed({ ...M0, picked: [heroId("Sigma"), null], enemies: ids("Sigma"), allies: ids("Mercy") });
    await px.click("#new-match");
    s = await st();
    check("incroci: «Nuova» azzera scelte, avversari, alleati e ban", s.picked.every((x) => x === null) && !s.enemies.length && !s.allies.length && !s.bans.length);
    await px.click("#start-cancel");
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
      { roles: ["Support"], picked: [null], mapSlug: "kings-row", side: "attack", bans: [], enemies: [], allies: [], started: true }]);
    await ps.goto(BASE);
    await ready(ps);
    const blocks = await ps.evaluate(() => Object.fromEntries([...document.querySelectorAll("#hs-grid [data-block]")].map((b) =>
      [b.dataset.block, [...b.querySelectorAll(".nm")].map((n) => n.textContent)])));
    check("Stagione 5: Sombra nella lista eroi tra i Supporti, non più tra i Danni", blocks.Support?.includes("Sombra") && !blocks.Damage?.includes("Sombra"),
      JSON.stringify({ s: blocks.Support, d: blocks.Damage?.length }));
    check("Stagione 5: in fondo alla Partita, Doctrine arriverà con i dati di counterwatch",
      /Doctrine: nuovo, comparirà tra gli eroi quando counterwatch avrà le statistiche/.test(await text(ps, "#grid-note")), await text(ps, "#grid-note").catch(() => ""));
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
    await ready(pp);
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
    await pp.click("#start-next");
    check("presenza: «Nuova partita» non la rimette (lo decide la prossima foto)", (await pp.locator(CARD).count()) === 1);
    await snap(readA, "g3.png");
    check("presenza: nella foto dopo c'è di nuovo → riconosciuta", (await sbRows("ours"))[1].who === "Giulia");
    await pp.click("#ph-confirm");
    st = await matchState(pp);
    check("presenza: e rientra da sola (due fasce, il suo eroe preso)", (await pp.locator(CARD).count()) === 2 && st.away.join() === "false,false"
      && String(st.picked[1]) === heroId("Ana") && /Giulia di nuovo in partita/.test(await text(pp, "#toast")), JSON.stringify(st));
    // con la mappa già scelta nella partita: la foto senza mappa la lascia com'è
    await pp.click("#map-btn");
    await pp.click("#start-map");
    await pp.click("#map-list [data-map=kings-row]");
    await pp.click("#start-next");
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
      await ready(pg);
      await pg.clock.runFor(31 * 60e3);
      const row = band(pg, 0).locator(".oalts .alt3").first();
      const want = await row.getAttribute("data-id");
      const b = await row.boundingBox();
      await pg.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await pg.mouse.down();
      await new Promise((r) => setTimeout(r, 60)); // i dati nuovi arrivano mentre il dito è giù
      await pg.mouse.up();
      await pg.waitForFunction(() => [...document.querySelectorAll("#hs-grid .hero .nm")].some((x) => x.textContent === "Ana Amari"), null, { timeout: 5000 });
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
      await ready(pg);
      await pg.evaluate(() => navigator.serviceWorker.ready);
      await pg.reload();
      await ready(pg);
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
      const whyAlive = async () => ((await alive()) ? pg.evaluate(async () => {
        const r = await navigator.serviceWorker.getRegistration();
        return JSON.stringify({ ...window.owcReloadState(), toast: document.querySelector("#toast").hidden ? "nascosto" : document.querySelector("#toast").innerText,
          dialogs: [...document.querySelectorAll("dialog[open]")].map((d) => d.id), focus: document.activeElement && document.activeElement.id,
          sw: { installing: !!(r && r.installing), waiting: !!(r && r.waiting), active: r && r.active && r.active.state } });
      }).catch((e) => String(e)) : "");
      const why = await whyAlive();
      check("… e appena tutto è chiuso la versione nuova prende il posto (ricarica)", !(await alive()), why);
      await ready(pg);
      await mark();
      bump("collaudo-2");
      await pg.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
      // su GitHub il service worker nuovo si attiva anche dopo vari secondi (quello vecchio ha richieste in corso):
      // la pagina lo sollecita più volte (nudgeWaiting), quindi si aspetta fino a 25 s e in caso di errore si stampa perché
      await pg.waitForFunction(() => window.__owcMark !== 1, null, { timeout: 25000 }).catch(() => {});
      check("versione nuova con l'app ferma sulla partita: ricarica da sola, senza tocchi", !(await alive()), await whyAlive());
      writeFileSync(swPath, swOrig);
      await cx.close();
    }

    // 3. ban nel foglio della foto: il foglio è l'unica fonte (anche vuoto), 5 ban di prima → 5 riquadri e «5/5»
    {
      const five = ["Widowmaker", "Zarya", "Hanzo", "Sojourn", "Mercy"].map((nm) => heroId(nm));
      const m0 = { roles: ["Damage", "Support"], picked: [null, null], mapSlug: null, side: null, bans: five, enemies: [], allies: [], started: true };
      const { ctx: cx, page: pg } = await open({ serviceWorkers: "block" }, seed(P2, m0));
      let read = readNoBans;
      await cx.route("https://api.anthropic.com/**", async (r) => {
        if (r.request().method() === "OPTIONS") { await r.fulfill({ status: 204, headers: CORS }); return; }
        await r.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(okResp(read)) });
      });
      await pg.goto(BASE);
      await ready(pg);
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
      await ready(pg);
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

    // 4. indietro dopo una ricarica (Profilo aperto; Inizio partita aperta): un livello per passo, l'app resta aperta
    {
      const { ctx: cx, page: pg } = await open({ serviceWorkers: "block" }, seed(P2));
      await pg.goto(BASE);
      await ready(pg);
      await pg.click('.tabs [data-view="profile"]');
      await pg.reload();
      await pg.locator("#view-profile:not([hidden])").waitFor();
      await pg.waitForTimeout(400);
      const layers = () => pg.evaluate(() => ({ owc: history.state?.owc ?? 0, profile: !document.querySelector("#view-profile").hidden, start: window.owcStart() }));
      const l0 = await layers();
      await pg.goBack();
      await pg.waitForTimeout(300);
      const l1 = pg.url().startsWith(BASE) ? await layers() : null;
      check("indietro dopo una ricarica col Profilo aperto: torna alla Partita, l'app resta aperta",
        l0.owc === 1 && l0.profile && l1 && l1.owc === 0 && !l1.profile, JSON.stringify([l0, l1]));
      await pg.click("#new-match");
      await pg.reload();
      await pg.locator("#start-view:not([hidden])").waitFor();
      await pg.waitForTimeout(400);
      const l2 = await layers();
      await pg.goBack();
      await pg.waitForTimeout(300);
      const l3 = pg.url().startsWith(BASE) ? await layers() : null;
      check("indietro dopo una ricarica con l'Inizio partita aperto: «Avanti», l'app resta aperta",
        l2.owc === 1 && l2.start && l3 && l3.owc === 0 && !l3.start && (await matchState(pg)).started === true, JSON.stringify([l2, l3]));
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
      const m0 = { roles: ["Damage", "Support"], picked: [String(gone.id), null], mapSlug: null, side: null, bans: [],
        enemies: [String(gone.id), heroId("Winston")], allies: [], started: true };
      const prof = [{ ...P2[0], favorites: [String(gone.id), heroId("Genji")] }, P2[1]];
      const { ctx: cx, page: pg } = await open({ serviceWorkers: "block" }, seed(prof, m0));
      let partial = true;
      await cx.route("**/data.json*", (r) => r.fulfill({ json: partial ? { ...data, heroes: data.heroes.filter((h) => h.id !== gone.id) } : data }));
      const errs = [];
      pg.on("pageerror", (e) => errs.push(String(e)));
      await pg.goto(BASE);
      await ready(pg);
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
      await ready(pg);
      await sendPhoto(pg);
      await pg.locator("#ph-confirm").waitFor();
      await pg.click("#ph-confirm");
      await pg.locator("#away .away-chip").first().click();
      const msg = await text(pg, "#toast");
      check("giocatore di nuovo in partita: il messaggio dice quale alleato non ci sta più", msg.includes("Fabio di nuovo in partita") && msg.includes(itn("Tracer")), msg);
      // scelta di Fabio, poi si toglie Terzo dal Profilo, poi "Annulla" della scelta
      await pg.evaluate(() => window.scrollTo(0, 0));
      await band(pg, 0).locator(".done").click();
      const before = await matchState(pg);
      await pg.click('.tabs [data-view="profile"]');
      const rm = pg.locator("#players .card").nth(2).locator(".card-head button");
      await rm.click();
      await rm.click();
      await pg.click('.tabs [data-view="match"]');
      await pg.locator("#new-match").click(); // "Nuova partita": il suo Annulla è di dopo, vale
      await pg.click("#start-next"); // (si apre l'Inizio partita: «Avanti» → messaggio con «Annulla»)
      await pg.click("#toast .toast-btn");
      const restored = await matchState(pg);
      check("«Annulla» di Nuova partita (stesso elenco di giocatori): ripristina", restored.picked[0] === before.picked[0], JSON.stringify(restored.picked));
      // un Annulla vecchio: si toglie Fabio (il primo) dopo "Nuova partita". Il messaggio "rimosso" copre quello con
      // "Annulla", quindi dall'interfaccia non ci si arriva più: si preme il vecchio pulsante (difesa in più)
      await pg.locator("#new-match").click();
      await pg.click("#start-next");
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
      await ready(pg);
      const rec = (await band(pg, 0).locator(".go").getAttribute("aria-label")) + (await pg.locator("#picks .go").count());
      const wf = await pg.locator("#warn-full").textContent();
      check("«solo guide» senza le guide caricate: consigli dalle statistiche (stima in %) e avviso giallo",
        /%/.test(rec) && await pg.locator("#warn").isVisible() && /guide non sono state caricate/.test(wf), `${rec} | ${wf}`);
      await cx.close();
    }

    // 10. ban consigliati e livelli dei ban: cambiano col lato anche con le sole statistiche (dal lato degli avversari)
    {
      const m0 = { roles: ["Damage", "Support"], picked: [null, null], mapSlug: "kings-row", side: null, bans: [], enemies: [], allies: [], started: false };
      const { ctx: cx, page: pg } = await open({ serviceWorkers: "block" }, seed(P2, m0));
      await pg.goto(BASE);
      await ready(pg, { next: false });
      await pg.click("#start-side [data-side=attack]");
      const ra = JSON.stringify(await startNames(pg));
      await pg.click("#start-side [data-side=defense]");
      const rd = JSON.stringify(await startNames(pg));
      check("ban (sole statistiche): ban consigliati e livelli cambiano tra attacco e difesa", ra !== rd);
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

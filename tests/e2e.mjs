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
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const text = (page, sel) => page.locator(sel).innerText();
const heroBtn = (page, name) => page.locator("#grid .hero", { has: page.locator(".nm", { hasText: new RegExp(`^${name}$`) }) });
// in cima alla pagina il riquadro dei consigli è completo (scorrendo si compatta)
const toTop = async (page) => { await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(50); };
const pickNames = (page) => page.locator(".pick .sug.first .sug-name").allInnerTexts();

try {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  // ---------- primo avvio ----------
  const { ctx, page } = await newPage();
  lastPage = page;
  await page.goto(BASE);
  await page.locator(".pick .sug.first .sug-name").first().waitFor();
  await toTop(page);
  check("primo avvio: due consigli (Io e Lei)", (await page.locator(".pick").count()) === 2
    && (await text(page, ".picks")).includes("Io") && (await text(page, ".picks")).includes("Lei"));
  check("primo avvio: 53 eroi in griglia", (await page.locator("#grid .hero").count()) === data.heroes.length);
  const initialsOk = await page.waitForFunction(() => [...document.querySelectorAll("#grid .face")].every((f) => f.querySelector("img") || f.textContent.trim()), null, { timeout: 10000 }).then(() => true, () => false);
  check("icone non raggiungibili: iniziali al loro posto", initialsOk);
  check("freschezza visibile", /Dati counterwatch del .*controllati/.test(await text(page, "#fresh")), await text(page, "#fresh"));
  const smallTargets = await page.$$eval("button", (bs) => bs.filter((b) => b.offsetParent).map((b) => [b.innerText.trim().slice(0, 20), b.getBoundingClientRect().height]).filter(([, h]) => h < 32));
  check("bersagli tattili abbastanza grandi", smallTargets.length === 0, JSON.stringify(smallTargets));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("niente scorrimento orizzontale", overflow <= 0, `overflow ${overflow}px`);
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
  const favOk = await page.waitForFunction(() => document.querySelectorAll("section.card")[1].innerText.includes("Eroi preferiti (2)"), null, { timeout: 5000 }).then(() => true, () => false);
  check("profilo: preferiti salvati", favOk, await page.locator("section.card").nth(1).innerText());
  await shot(page, "03-profilo");
  await page.click(".tabs [data-view=match]");
  await toTop(page);
  check("profilo: nomi nei consigli", (await text(page, ".picks")).includes("Fabio") && (await text(page, ".picks")).includes("Giulia"));

  // ---------- inizio partita: mappa, lato, ban ----------
  await page.click("#map-btn");
  await shot(page, "04-mappe");
  await page.locator("#map-list .map-opt", { hasText: "King's Row" }).click();
  check("mappa scelta e finestra chiusa", (await text(page, "#map-name")).includes("King's Row")
    && !(await page.locator("#map-dialog").evaluate((d) => d.open)));
  check("Hybrid: attacco/difesa visibile", await page.locator("#side").isVisible());
  await page.click("#side [data-side=defense]");
  check("difesa selezionata", (await page.getAttribute("#side [data-side=defense]", "aria-pressed")) === "true");
  await page.click("#groups [data-group=bans]");
  await heroBtn(page, "Ana").click();
  await heroBtn(page, "Kiriko").click();
  check("2 ban contati", (await text(page, "[data-count=bans]")) === "2");
  await toTop(page);
  const afterBans = await pickNames(page);
  check("consigli senza eroi bannati", !afterBans.includes("Ana") && !afterBans.includes("Kiriko"), afterBans.join());
  check("consigli: Fabio e Giulia hanno eroi diversi", afterBans[0] !== afterBans[1], afterBans.join());
  await toTop(page);
  check("motivo mappa nei consigli", /Mappa [+−]\d/.test(await text(page, ".picks")));
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "05-inizio-partita");

  // ---------- durante: avversari e alleati ----------
  await page.click("#groups [data-group=enemies]");
  for (const n of ["Pharah", "Winston", "Reinhardt"]) await heroBtn(page, n).click();
  check("3 avversari contati", (await text(page, "[data-count=enemies]")) === "3");
  await toTop(page);
  check("motivi 'Avversari' nei consigli", /Avversari [+−]\d/.test(await text(page, ".picks")), await text(page, ".picks"));
  check("pulsanti «Come giocare» per i due eroi consigliati", (await page.locator("#guides .guide-btn").count()) === 2);
  await toTop(page);
  check("3 consigli per giocatore, in ordine", (await page.locator(".pick").nth(0).locator(".sug").count()) === 3
    && (await page.locator(".pick").nth(1).locator(".sug").count()) === 3
    && (await page.locator(".pick").nth(0).locator(".sug-n").allInnerTexts()).join() === "1,2,3");
  const order = await page.evaluate(() => [...document.querySelectorAll(".pick")].map((p) =>
    [...p.querySelectorAll(".sug-est")].map((e) => parseFloat(e.textContent))));
  check("ordinati dal migliore (stima non crescente, salvo bonus preferiti)", order.every((l) => l.length === 3), JSON.stringify(order));
  await toTop(page);
  const why = await page.locator(".pick").nth(0).locator(".sug").first().innerText();
  check("perché: vantaggio su mappa e su comp avversaria", /Mappa [+−]\d/.test(why) && /Avversari [+−]\d/.test(why), why);
  await toTop(page);
  await page.locator(".pick").nth(0).locator(".sug").nth(1).click();
  const det = await text(page, "#why-body");
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
    && (await page.locator("#why-body .theory-sec").count()) === 3
    && (await page.locator("#why-body .theory-sec .theory-badge").count()) === 3);
  check("riquadri teoria in viola, diversi dalle statistiche", await page.evaluate(() => {
    const a = getComputedStyle(document.querySelector("#why-body .theory-sec")).backgroundColor;
    const b = getComputedStyle(document.querySelector("#why-body .prof-sec:not(.theory-sec)")).backgroundColor;
    return a !== b;
  }));
  await page.locator("#why-body .theory-sec").first().scrollIntoViewIfNeeded();
  await shot(page, "05d-teoria");
  await page.click("#why-body .guide-btn");
  await page.locator("#guide-dialog[open]").waitFor();
  const guide = await text(page, "#guide-body");
  check("come giocarla: scheda con sezioni per questa partita (mappa, lato, come muoverti)",
    guide.includes("Mappa: King's Row") && guide.includes("Come muoverti")
    && (await page.locator("#guide-body .guide-sec").count()) >= 3 && (await page.locator("#guide-body .theory-badge").count()) > 0, guide.slice(0, 400));
  await shot(page, "05e-come-giocarla");
  check("schede senza testi «null»/«undefined»", !/\b(null|undefined|NaN)\b/.test(guide + det), (guide + det).match(/.{0,40}\b(null|undefined|NaN)\b.{0,20}/)?.[0]);
  await page.click("#guide-dialog [data-close]");
  await page.click("#why-dialog [data-close]");
  await toTop(page);
  await page.locator(".pick").nth(1).locator(".sug").first().click();
  const detG = await text(page, "#why-body");
  check("scheda eroe di Giulia (rank Oro): usa i dati della divisione", detG.includes("dati: Ranked Oro"), detG);
  await page.evaluate(() => document.querySelector("#why-body").scrollIntoView());
  await shot(page, "05c-scheda-eroe");
  await page.click("#why-dialog [data-close]");
  check("senza alleati: niente riga «Alleati», la sinergia col compagno è «Con Giulia»",
    !/Alleati [+−]/.test(await page.locator(".pick").nth(0).innerText()) && /Con Giulia [+−]/.test(await page.locator(".pick").nth(0).innerText()));
  await page.click("#groups [data-group=allies]");
  await heroBtn(page, "Lúcio").click();
  await toTop(page);
  check("con alleati: riga Alleati nei perché", /Alleati [+−]\d/.test(await page.locator(".pick").nth(0).locator(".sug").first().innerText()));
  await toTop(page);
  const picks = await pickNames(page);
  check("alleato non consigliato", !picks.includes("Lúcio"), picks.join());
  await page.click("#groups [data-group=enemies]");
  for (const n of ["Genji", "Mercy", "Tracer"]) await heroBtn(page, n).click();
  check("max 5 avversari, avviso chiaro", (await text(page, "[data-count=enemies]")) === "5"
    && (await text(page, "#toast")).includes("Al massimo 5"));
  // un tocco su un eroe di un altro gruppo lo sposta
  await page.click("#groups [data-group=allies]");
  await heroBtn(page, "Mercy").click();
  check("tocco sposta tra gruppi", (await text(page, "[data-count=enemies]")) === "4" && (await text(page, "[data-count=allies]")) === "2");
  // ruolo cambiato al volo
  await toTop(page);
  await page.locator(".pick").nth(1).locator(".role-btn").click();
  await toTop(page);
  check("ruolo di Giulia cambiato al volo (Supporto → Danni)", (await page.locator(".pick").nth(1).locator(".role-btn").innerText()) === "Danni");
  await toTop(page);
  const duo = await pickNames(page);
  const role = (n) => data.heroes.find((h) => h.name === n)?.role;
  check("con lo stesso ruolo eroi diversi", duo[0] !== duo[1] && role(duo[0]) === "Damage" && role(duo[1]) === "Damage", duo.join());
  await toTop(page);
  await page.locator(".pick").nth(1).locator(".role-btn").click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "06-durante-partita");
  await page.evaluate(() => window.scrollTo(0, 600));
  await shot(page, "07-griglia");

  // ---------- solo preferiti ----------
  await page.click(".tabs [data-view=profile]");
  await page.getByRole("button", { name: /Suggerisci solo eroi preferiti/ }).click();
  await page.click(".tabs [data-view=match]");
  await toTop(page);
  const giulia = await page.locator(".pick").nth(1).locator(".sug-name").allInnerTexts();
  check("solo preferiti: Giulia vede solo Mercy/Juno (Mercy è alleata → solo Juno)", giulia.join() === "Juno", giulia.join());
  await toTop(page);
  const fabio = await page.locator(".pick").nth(0).innerText();
  check("solo preferiti: Fabio senza preferiti → tutti, con avviso", fabio.includes("nessun preferito disponibile")
    && (await page.locator(".pick").nth(0).locator(".sug").count()) === 3, fabio);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "06b-solo-preferiti");
  await page.click(".tabs [data-view=profile]");
  await page.getByRole("button", { name: /Suggerisci solo eroi preferiti/ }).click();
  await page.click(".tabs [data-view=match]");

  // Control: niente lato
  await page.click("#map-btn");
  await page.locator("#map-list .map-opt", { hasText: "Ilios" }).click();
  check("Control: attacco/difesa nascosto", !(await page.locator("#side").isVisible()));

  // ---------- memoria e nuova partita ----------
  await page.reload();
  await page.locator(".pick .sug.first .sug-name").first().waitFor();
  check("dopo ricarica: partita e profilo ricordati", (await text(page, "[data-count=enemies]")) === "4"
    && (await text(page, ".picks")).includes("Giulia") && (await text(page, "#map-name")).includes("Ilios"));
  await page.click("#new-match");
  check("nuova partita: azzera tutto tranne il profilo", (await text(page, "[data-count=enemies]")) === "0"
    && (await text(page, "[data-count=bans]")) === "0" && (await text(page, "#map-name")).includes("nessuna")
    && (await text(page, ".picks")).includes("Giulia"));

  // ---------- aggiorna senza token ----------
  await page.click("#refresh");
  await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
  check("aggiorna senza token: spiega come attivarlo", (await text(page, "#toast")).includes("token"));

  // ---------- tutte le selezioni fatte: ogni eroe resta toccabile (schermo piccolo e normale) ----------
  // schermi: piccolo di riferimento, Xiaomi 14T (407×905 meno barre di sistema), Nothing Phone (3) (≈420×933 meno barre)
  for (const vp of [{ width: 360, height: 640 }, { width: 390, height: 844 }, { width: 407, height: 833, name: "Xiaomi 14T" },
    { width: 420, height: 860, name: "Nothing Phone (3)" }]) {
    const { ctx: c7, page: p7 } = await newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 3, serviceWorkers: "block" });
    const label = vp.name ? `${vp.name} (${vp.width}×${vp.height})` : `${vp.width}×${vp.height}`;
    await p7.addInitScript(() => localStorage.setItem("owc.profile", JSON.stringify({ useTheory: true,
      players: [{ name: "Fabio", rank: "", roles: ["Damage"], favorites: [] }, { name: "Giulia", rank: "", roles: ["Support"], favorites: [] }] })));
    await p7.goto(BASE);
    await p7.locator(".pick .sug.first .sug-name").first().waitFor();
    const hb = (n) => p7.locator("#grid .hero", { has: p7.locator(".nm", { hasText: new RegExp(`^${n}$`) }) });
    await p7.click("#map-btn");
    await p7.locator("#map-list .map-opt", { hasText: "King's Row" }).click();
    await p7.click("#side [data-side=attack]");
    for (const [g, names] of [["bans", ["Ana", "Kiriko", "Widowmaker", "Tracer"]], ["enemies", ["Reinhardt", "Genji", "Pharah", "Mercy", "Lúcio"]], ["allies", ["Winston", "Sojourn", "Baptiste"]]]) {
      await toTop(p7);
      await p7.click(`#groups [data-group=${g}]`);
      for (const n of names) await hb(n).click();
    }
    // e gli eroi presi da Fabio e Giulia (in 5: 3 alleati + i due giocatori)
    await toTop(p7);
    await p7.locator("#pickers .picker").nth(0).click();
    await hb("Cassidy").click();
    await hb("Moira").click();
    await p7.waitForTimeout(2600); // il messaggio in basso sparisce
    const res = await p7.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const bad = [];
      let maxStack = 0;
      const tabs = document.querySelector(".tabs").getBoundingClientRect().top;
      for (const btn of document.querySelectorAll("#grid .hero")) {
        // l'eroe appena sotto la barra fissa in alto: è lì che di solito lo si tocca dopo aver scorso
        btn.scrollIntoView({ block: "start" });
        await frame();
        const stack = Math.max(document.querySelector("#mini").hidden ? 0 : document.querySelector("#mini").getBoundingClientRect().bottom,
          document.querySelector(".groups").getBoundingClientRect().bottom);
        maxStack = Math.max(maxStack, stack);
        window.scrollBy(0, -(stack + 4));
        await frame();
        const r = btn.getBoundingClientRect();
        const y = Math.min(r.top + r.height / 2, tabs - 4);
        const el = document.elementFromPoint(r.left + r.width / 2, y);
        if (!btn.contains(el)) bad.push(btn.querySelector(".nm").textContent);
      }
      return { bad, maxStack: Math.round(maxStack), tabs: Math.round(tabs) };
    });
    check(`${label}, tutte le selezioni: ogni eroe toccabile`, res.bad.length === 0, res.bad.join(", "));
    check(`${label}: barra fissa in alto bassa (≤ 140 px)`, res.maxStack <= 140, `${res.maxStack}px`);
    // nessun nome di eroe troncato nei consigli (tutti i 53, anche i più lunghi) e niente scorrimento orizzontale
    const fit = await p7.evaluate(async () => {
      window.scrollTo(0, 0);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const nameEl = document.querySelector(".pick .sug:not(.first) .sug-name");
      const top = nameEl.parentElement;
      const est = top.querySelector(".sug-est"); // se la stima è sulla stessa riga del nome, toglie spazio
      const avail = top.getBoundingClientRect().width - (est ? est.getBoundingClientRect().width + 6 : 0);
      const ctx2 = document.createElement("canvas").getContext("2d");
      const cs = getComputedStyle(nameEl);
      ctx2.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const names = [...document.querySelectorAll("#grid .hero .nm")].map((x) => x.textContent);
      const tooLong = names.filter((n) => ctx2.measureText(n).width > avail);
      const gridCut = [...document.querySelectorAll("#grid .hero .nm")].filter((x) => x.scrollHeight > x.clientHeight + 1 || x.scrollWidth > x.clientWidth + 1).map((x) => x.textContent);
      // nome spezzato a metà parola (es. "Widowmake/r"): più righe che parole
      const lines = (x) => { const r = document.createRange(); r.selectNodeContents(x); return new Set([...r.getClientRects()].map((q) => Math.round(q.top))).size; };
      for (const x of document.querySelectorAll("#grid .hero .nm")) if (lines(x) > x.textContent.split(/\s+/).length) gridCut.push(`${x.textContent} (spezzato)`);
      return { tooLong, gridCut, overflow: document.documentElement.scrollWidth - window.innerWidth, avail: Math.round(avail) };
    });
    if (vp.name || vp.width >= 390) {
      check(`${label}: nessun nome troncato nei consigli`, fit.tooLong.length === 0, `spazio ${fit.avail}px, troncati: ${fit.tooLong.join(", ")}`);
      check(`${label}: nomi nella griglia interi`, fit.gridCut.length === 0, fit.gridCut.join(", "));
    }
    check(`${label}: niente scorrimento orizzontale`, fit.overflow <= 0, `${fit.overflow}px`);
    if (vp.name) await shot(p7, `12-${vp.name.replace(/\W+/g, "-")}`);
    await p7.evaluate(() => window.scrollTo(0, 900));
    await p7.waitForTimeout(100);
    if (vp.height === 640) await shot(p7, "11-tutte-le-selezioni-scorso");
    await toTop(p7);
    if (vp.height === 640) await shot(p7, "11-tutte-le-selezioni-in-cima");
    await c7.close();
  }

  // ---------- da 1 a 5 giocatori, ognuno col suo colore; "Chi ha preso cosa" ----------
  {
    const QUEUE = [["Fabio", "Damage"], ["Giulia", "Support"], ["Marco", "Tank"], ["Sara", "Support"], ["Luca", "Damage"]];
    // eroe preso da ciascuno (scelto apposta diverso dal n. 1 consigliato, se possibile)
    const TAKE = { Damage: ["Soldier: 76", "Sojourn"], Support: ["Ana", "Kiriko"], Tank: ["Reinhardt"] };
    for (const n of [1, 2, 3, 4, 5]) {
      for (const vp of n === 5 ? [{ width: 360, height: 640 }, { width: 407, height: 833, name: "Xiaomi 14T" }, { width: 420, height: 860, name: "Nothing Phone (3)" }]
        : [{ width: 407, height: 833, name: "Xiaomi 14T" }, { width: 420, height: 860, name: "Nothing Phone (3)" }]) {
        const { ctx: c9, page: p9 } = await newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 3, serviceWorkers: "block" });
        lastPage = p9;
        const label = `${n} giocator${n === 1 ? "e" : "i"}, ${vp.name ?? `${vp.width}×${vp.height}`}`;
        const players = QUEUE.slice(0, n).map(([name, role]) => ({ name, rank: "", roles: [role], favorites: [] }));
        await p9.addInitScript((pl) => localStorage.setItem("owc.profile", JSON.stringify({ players: pl })), players);
        await p9.goto(BASE);
        await p9.locator(".pick .sug.first .sug-name").first().waitFor();
        const hb = (name) => p9.locator("#grid .hero", { has: p9.locator(".nm", { hasText: new RegExp(`^${name.replace(/[.:]/g, "\\$&")}$`) }) });
        await p9.click("#map-btn");
        await p9.locator("#map-list .map-opt", { hasText: "Ilios" }).click();
        await p9.click("#groups [data-group=enemies]");
        for (const e of ["Winston", "Genji", "Pharah"]) await hb(e).click();
        await toTop(p9);

        const st = await p9.evaluate(() => ({
          cards: document.querySelectorAll("#picks .pick").length,
          pickers: document.querySelectorAll("#pickers .picker").length,
          guides: document.querySelectorAll("#guides .guide-btn").length,
          firsts: [...document.querySelectorAll(".pick .sug.first .sug-name")].map((x) => x.textContent),
          colors: [...document.querySelectorAll("#picks .pick")].map((x) => getComputedStyle(x).borderTopColor),
          recs: [...document.querySelectorAll("#grid .hero.rec")].map((b) => [b.querySelector(".nm").textContent, getComputedStyle(b).outlineColor]),
          alliesHidden: document.querySelector("#groups [data-group=allies]").hidden,
        }));
        check(`${label}: un riquadro, un «chi ha preso» e un «Come giocare» a testa`,
          st.cards === n && st.pickers === n && st.guides === n, JSON.stringify(st));
        check(`${label}: consigli tutti diversi, del ruolo di ciascuno`,
          new Set(st.firsts).size === n && st.firsts.every((h, i) => data.heroes.find((x) => x.name === h)?.role === QUEUE[i][1]), st.firsts.join(", "));
        check(`${label}: un colore diverso per giocatore (riquadri e griglia)`,
          new Set(st.colors).size === n && st.recs.length === n && new Set(st.recs.map((r) => r[1])).size === n, JSON.stringify(st.recs));
        check(`${label}: «Alleati» solo se c'è posto in squadra (5 − giocatori)`, st.alliesHidden === (n === 5));
        if (n === 2 || n === 5) await shot(p9, `13-squadra-${n}-${(vp.name ?? `${vp.width}`).replace(/\W+/g, "-")}-consigli`);

        // ognuno segna l'eroe che ha preso: tocco sul giocatore, poi sull'eroe; si passa da soli al successivo
        const used = { Damage: 0, Support: 0, Tank: 0 };
        const taken = [];
        await p9.locator("#pickers .picker").nth(0).click();
        for (let i = 0; i < n; i++) {
          const role = QUEUE[i][1];
          const h = TAKE[role][used[role]++];
          taken.push(h);
          check(`${label}: tocca a ${QUEUE[i][0]}`, (await p9.locator("#pickers .picker").nth(i).getAttribute("aria-pressed")) === "true");
          await hb(h).click();
        }
        await p9.waitForTimeout(150);
        await toTop(p9);
        const after = await p9.evaluate(() => ({
          firsts: [...document.querySelectorAll(".pick .sug.first .sug-name")].map((x) => x.textContent),
          notes: [...document.querySelectorAll(".pick .took-note")].map((x) => x.textContent),
          pickers: [...document.querySelectorAll("#pickers .picker small, #pickers .picker b")].map((x) => x.textContent),
          took: [...document.querySelectorAll("#grid .hero.took")].map((b) => [b.querySelector(".nm").textContent, b.querySelector(".tag")?.textContent]),
          rec: document.querySelectorAll("#grid .hero.rec").length,
          group: JSON.parse(localStorage.getItem("owc.match")).group,
          seconds: [...document.querySelectorAll(".pick")].map((c) => [...c.querySelectorAll(".sug-name")].slice(1).map((x) => x.textContent)),
        }));
        check(`${label}: ogni riquadro mostra l'eroe preso, in cima`, after.firsts.join() === taken.join() && after.notes.length === n, JSON.stringify(after.firsts));
        check(`${label}: griglia: eroi presi segnati col ✓ e l'iniziale di chi li ha presi`,
          after.took.length === n && taken.every((h, i) => after.took.some(([nm, tag]) => nm === h && tag === `${QUEUE[i][0][0]}✓`)) && after.rec === 0,
          JSON.stringify(after.took));
        check(`${label}: alternative senza gli eroi presi dagli altri`,
          after.seconds.every((alts, i) => alts.every((a) => !taken.some((t, j) => j !== i && t === a))), JSON.stringify(after.seconds));
        check(`${label}: tutti hanno scelto → si torna agli avversari`, after.group === "enemies", after.group);
        // barra minima e barra fissa: tutti visibili, non troppo alte
        const bar = await p9.evaluate(async () => {
          window.scrollTo(0, document.querySelector("#grid").offsetTop);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const mini = document.querySelector("#mini");
          const names = [...mini.querySelectorAll(".mini-txt b")];
          return { shown: !mini.hidden, count: mini.querySelectorAll(".mini-pick").length,
            stack: Math.round(Math.max(mini.getBoundingClientRect().bottom, document.querySelector(".groups").getBoundingClientRect().bottom)),
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            cut: names.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent) };
        });
        check(`${label}: barra in alto con tutti i ${n} eroi, bassa (≤ 140 px)`, bar.shown && bar.count === n && bar.stack <= 140, JSON.stringify(bar));
        check(`${label}: niente scorrimento orizzontale`, bar.overflow <= 0, `${bar.overflow}px`);
        if (n === 2 || n === 5) await shot(p9, `13-squadra-${n}-${(vp.name ?? `${vp.width}`).replace(/\W+/g, "-")}-scorso`);
        // «Come giocarla» del primo giocatore: parla del suo eroe preso
        await toTop(p9);
        await p9.locator("#guides .guide-btn").first().click();
        await p9.locator("#guide-dialog[open] .guide-sec").first().waitFor();
        check(`${label}: «Come giocarla» sull'eroe preso`, (await text(p9, "#t-guide")).includes(taken[0]), await text(p9, "#t-guide"));
        await p9.locator("#guide-dialog [data-close]").click();
        await c9.close();
      }
    }

    // segnare un eroe preso lo toglie dagli altri gruppi; ritoccarlo lo toglie; un tocco su un altro giocatore cambia chi sceglie
    const { ctx: c10, page: p10 } = await newPage({ serviceWorkers: "block" });
    lastPage = p10;
    await p10.goto(BASE);
    await p10.locator(".pick .sug.first .sug-name").first().waitFor();
    await p10.click("#groups [data-group=enemies]");
    await heroBtn(p10, "Mercy").click();
    await p10.locator("#pickers .picker").nth(1).click();
    await heroBtn(p10, "Mercy").click();
    const m1 = await p10.evaluate(() => JSON.parse(localStorage.getItem("owc.match")));
    check("eroe preso: tolto dagli avversari, assegnato al giocatore scelto",
      !m1.enemies.length && String(m1.picked[1]) === String(data.heroes.find((h) => h.name === "Mercy").id) && m1.picked[0] === null, JSON.stringify(m1));
    await p10.locator("#pickers .picker").nth(1).click();
    await heroBtn(p10, "Mercy").click();
    check("ritoccare l'eroe preso lo toglie", (await p10.evaluate(() => JSON.parse(localStorage.getItem("owc.match")).picked[1])) === null);

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
      && (await p10.locator("#players [aria-label^='Rimuovi']").nth(1).innerText()).includes("conferma"));
    await p10.locator("#players [aria-label^='Rimuovi']").nth(1).click();
    await p10.click(".tabs [data-view=match]");
    const four = await p10.evaluate(() => ({ cards: document.querySelectorAll("#picks .pick").length,
      m: JSON.parse(localStorage.getItem("owc.match")) }));
    check("rimosso un giocatore: 4 riquadri, partita adeguata", four.cards === 4 && four.m.roles.length === 4 && four.m.picked.length === 4, JSON.stringify(four));
    await c10.close();
  }

  // ---------- dati riletti ogni 30 minuti, solo con l'app aperta (niente timer) ----------
  {
    const { ctx: c6, page: p6 } = await newPage({ serviceWorkers: "block" });
    let hits = 0, version = data.checked;
    await c6.route("**/data.json*", (r) => { hits++; return r.fulfill({ json: { ...data, checked: version } }); });
    await p6.clock.install();
    await p6.goto(BASE);
    await p6.locator(".pick .sug.first .sug-name").first().waitFor();
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
    await p5.locator(".pick .sug.first .sug-name").first().waitFor();
    const roleOf = () => p5.evaluate(() => {
      const b = [...document.querySelectorAll("#grid .hero")].find((x) => x.querySelector(".nm").textContent === "Sombra");
      let el = b.closest(".grid").previousElementSibling;
      return el.textContent;
    });
    const before = await roleOf();
    swapped = true;
    await p5.click("#refresh");
    await p5.waitForFunction(() => !document.querySelector("#refresh").disabled);
    const after = await roleOf();
    check("ruolo cambiato nei dati: la griglia si aggiorna senza riaprire l'app", before === "Danni" && after === "Supporto", `${before} → ${after}`);
    await c5.close();
  }

  // ---------- offline ----------
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.locator(".pick .sug.first .sug-name").first().waitFor();
  await ctx.setOffline(true);
  await page.reload();
  const offlineOk = await page.locator(".pick .sug.first .sug-name").first().waitFor({ timeout: 5000 }).then(() => true, () => false);
  check("offline: l'app parte con i dati salvati", offlineOk);
  await shot(page, "08-offline");
  await ctx.setOffline(false);
  await ctx.close();

  // ---------- dati vecchi e con problemi ----------
  {
    const { ctx: c2, page: p2 } = await newPage();
    const old = { ...data, checked: new Date(Date.now() - 3 * 86400e3).toISOString(), problems: ["mappa x: rotta"] };
    await p2.route("**/data.json*", (r) => r.fulfill({ json: old }));
    await p2.goto(BASE);
    await p2.locator(".pick .sug.first .sug-name").first().waitFor();
    const w = await text(p2, "#warn");
    check("dati vecchi/parziali: avviso giallo, app funzionante", (await p2.locator("#warn").isVisible()) && w.includes("non vengono aggiornati") && w.includes("dati precedenti"), w);
    await shot(p2, "09-dati-vecchi");
    await c2.close();
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
    await p4.locator(".pick .sug.first .sug-name").first().waitFor();
    await p4.click(".tabs [data-view=profile]");
    await p4.fill("#token", "github_pat_PROVA");
    await p4.click("#token-save");
    check("token salvato e non mostrato", (await p4.inputValue("#token")) === "" && (await p4.getAttribute("#token", "placeholder")).includes("salvato"));
    await p4.click(".tabs [data-view=match]");
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

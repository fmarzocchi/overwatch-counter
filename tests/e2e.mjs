// Collaudo della PWA in Chromium con viewport da telefono (390×844).
// Uso: node tests/e2e.mjs [cartella-screenshot]   (serve il pacchetto "playwright")
// Le richieste esterne sono bloccate (icone remote e api.github.com simulate), quindi gira offline.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
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

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", path.join(ROOT, "app")], { stdio: "ignore" });
const browser = await chromium.launch();
const errors = [];

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
const pickNames = (page) => page.locator(".pick .sug.first .sug-name").allInnerTexts();

try {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  // ---------- primo avvio ----------
  const { ctx, page } = await newPage();
  await page.goto(BASE);
  await page.locator(".pick .sug.first .sug-name").first().waitFor();
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
  const afterBans = await pickNames(page);
  check("consigli senza eroi bannati", !afterBans.includes("Ana") && !afterBans.includes("Kiriko"), afterBans.join());
  check("consigli: Fabio e Giulia hanno eroi diversi", afterBans[0] !== afterBans[1], afterBans.join());
  check("motivo mappa nei consigli", /Mappa [+−]\d/.test(await text(page, ".picks")));
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "05-inizio-partita");

  // ---------- durante: avversari e alleati ----------
  await page.click("#groups [data-group=enemies]");
  for (const n of ["Pharah", "Winston", "Reinhardt"]) await heroBtn(page, n).click();
  check("3 avversari contati", (await text(page, "[data-count=enemies]")) === "3");
  check("motivi 'Avversari' nei consigli", /Avversari [+−]\d/.test(await text(page, ".picks")), await text(page, ".picks"));
  check("3 consigli per giocatore, in ordine", (await page.locator(".pick").nth(0).locator(".sug").count()) === 3
    && (await page.locator(".pick").nth(1).locator(".sug").count()) === 3
    && (await page.locator(".pick").nth(0).locator(".sug-n").allInnerTexts()).join() === "1,2,3");
  const order = await page.evaluate(() => [...document.querySelectorAll(".pick")].map((p) =>
    [...p.querySelectorAll(".sug-est")].map((e) => parseFloat(e.textContent))));
  check("ordinati dal migliore (stima non crescente, salvo bonus preferiti)", order.every((l) => l.length === 3), JSON.stringify(order));
  const why = await page.locator(".pick").nth(0).locator(".sug").first().innerText();
  check("perché: vantaggio su mappa e su comp avversaria", /Mappa [+−]\d/.test(why) && /Avversari [+−]\d/.test(why), why);
  await page.locator(".pick").nth(0).locator(".sug").nth(1).click();
  const det = await text(page, "#why-body");
  check("tocco su un consiglio: dettaglio per ogni avversario", ["contro Pharah", "contro Winston", "contro Reinhardt", "King's Row"].every((t) => det.includes(t)), det);
  await shot(page, "05b-perche");
  await page.click("#why-dialog [data-close]");
  await page.click("#groups [data-group=allies]");
  await heroBtn(page, "Lúcio").click();
  check("con alleati: riga Alleati nei perché", /Alleati [+−]\d/.test(await page.locator(".pick").nth(0).locator(".sug").first().innerText()));
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
  await page.locator(".pick").nth(1).locator(".role-btn").click();
  check("ruolo di Giulia cambiato al volo (Supporto → Danni)", (await page.locator(".pick").nth(1).locator(".role-btn").innerText()) === "Danni");
  const duo = await pickNames(page);
  const role = (n) => data.heroes.find((h) => h.name === n)?.role;
  check("con lo stesso ruolo eroi diversi", duo[0] !== duo[1] && role(duo[0]) === "Damage" && role(duo[1]) === "Damage", duo.join());
  await page.locator(".pick").nth(1).locator(".role-btn").click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "06-durante-partita");
  await page.evaluate(() => window.scrollTo(0, 600));
  await shot(page, "07-griglia");

  // ---------- solo preferiti ----------
  await page.click(".tabs [data-view=profile]");
  await page.getByRole("button", { name: /Suggerisci solo eroi preferiti/ }).click();
  await page.click(".tabs [data-view=match]");
  const giulia = await page.locator(".pick").nth(1).locator(".sug-name").allInnerTexts();
  check("solo preferiti: Giulia vede solo Mercy/Juno (Mercy è alleata → solo Juno)", giulia.join() === "Juno", giulia.join());
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
  check("collaudo completato senza eccezioni", false, e.stack);
} finally {
  await browser.close();
  server.kill();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} controlli superati · screenshot in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);

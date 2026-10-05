import { recommendTeam, breakdown, details, hasSides, withDivision, heroProfile, matchups, headline } from "./recommend.js";
import { buildTheory, heroTheory, playGuide, theoryStatus, swapAdvice, STYLE_IT, STYLE_DESC } from "./theory.js";

// WebView Android meno recenti (Chrome < 86) non hanno replaceChildren
if (!Element.prototype.replaceChildren) {
  Element.prototype.replaceChildren = function replaceChildren(...nodes) {
    while (this.firstChild) this.removeChild(this.firstChild);
    this.append(...nodes);
  };
}

const REPO = "fmarzocchi/overwatch-counter";
const WORKFLOW = "update-data.yml";
const LIMITS = { bans: 4, enemies: 5, allies: 5 };
const MAX_PLAYERS = 5;
// gli alleati sono gli ALTRI della squadra: in 5 con i giocatori del profilo
const limitOf = (g) => (g === "allies" ? Math.max(0, MAX_PLAYERS - profile.players.length) : LIMITS[g]);
const ROLE_QUOTA = { Tank: 1, Damage: 2, Support: 2 }; // coda a ruoli 5v5
const GROUP_WORD = { bans: "ban", enemies: "avversari", allies: "alleati" };
const GROUP_ONE = { bans: "bannato", enemies: "avversario", allies: "alleato" };
const GROUP_HINT = {
  bans: "Tocca gli eroi bannati in questa partita.",
  enemies: "Tocca gli eroi avversari: ne basta anche uno.",
  allies: "Facoltativo: i vostri compagni di squadra.",
};
const ROLES = [["Tank", "Tank"], ["Damage", "Danni"], ["Support", "Supporto"]];
const ROLE_IT = Object.fromEntries(ROLES);
const RANKS = ["", "Bronzo", "Argento", "Oro", "Platino", "Smeraldo", "Diamante", "Master", "Grandmaster", "Campione"];
// rank del profilo → file dei dati di quella divisione (Grandmaster e Campione condividono i dati, come sul sito)
const RANK_DIV = { Bronzo: "bronze", Argento: "silver", Oro: "gold", Platino: "platinum", Smeraldo: "emerald",
  Diamante: "diamond", Master: "master", Grandmaster: "gm", Campione: "gm" };
const MODES = [["Control", "Controllo"], ["Escort", "Scorta"], ["Hybrid", "Ibrida"], ["Push", "Spinta"], ["Flashpoint", "Flashpoint"]];
const MODE_IT = Object.fromEntries(MODES);
const STALE_MS = 24 * 3600e3;
// Dati riletti dal sito al massimo ogni 30 minuti, SOLO con l'app aperta: il controllo parte quando si
// tocca lo schermo o l'app torna in primo piano. Nessun timer: in sottofondo l'app non fa niente.
const AUTO_REFRESH_MS = 30 * 60e3;
let lastLoad = 0;
let refreshing = false;
const DISPATCH_GAP_MS = 10 * 60e3;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const sid = (x) => String(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// localStorage può mancare o lanciare errori (navigazione privata): l'app deve funzionare comunque
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* niente */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* niente */ } },
};

const defaultProfile = () => ({
  players: [
    { name: "Io", rank: "", roles: ["Damage"], favorites: [] },
    { name: "Lei", rank: "", roles: ["Support"], favorites: [] },
  ],
});
const defaultName = (i) => (i === 0 ? "Io" : i === 1 ? "Lei" : `Giocatore ${i + 1}`);
// picked[i]: eroe già preso dal giocatore i (null = ancora da scegliere); pickFor: chi sta segnando la sua scelta
const emptyMatch = () => ({
  roles: profile.players.map((p) => p.roles[0] ?? null),
  picked: profile.players.map(() => null),
  pickFor: 0,
  mapSlug: null, side: null, bans: [], enemies: [], allies: [], group: "enemies",
});
// partita salvata da una versione precedente o con un numero di giocatori diverso: si sistema senza perdere nulla
function fitMatch() {
  const n = profile.players.length;
  const fit = (arr, fill) => Array.from({ length: n }, (_, i) => (arr && i < arr.length ? arr[i] : fill(i)));
  match.roles = fit(match.roles, (i) => profile.players[i].roles[0] ?? null);
  match.picked = fit(match.picked, () => null);
  if (!(match.pickFor >= 0 && match.pickFor < n)) match.pickFor = 0;
  if (!["bans", "enemies", "allies", "picked"].includes(match.group)) match.group = "enemies";
  if (match.allies.length > limitOf("allies")) match.allies = match.allies.slice(0, limitOf("allies"));
  if (match.group === "allies" && !limitOf("allies")) match.group = "enemies";
}

let data = null;
let byId = {};
let profile = store.get("owc.profile", null) ?? defaultProfile();
let match = store.get("owc.match", null) ?? emptyMatch();
fitMatch();
let lastDuo = null;
let theoryRaw = {}; // app/theory.json: sinergie, counter e modo di giocare raccolti da fonti di Overwatch
let T = null; // teoria pronta all'uso (resa simmetrica, con i nomi dei dati attuali)
let patches = null; // app/patches.json: ultima patch Blizzard (per capire quando la teoria è vecchia)
const divFiles = {}; // chiave divisione → contenuto del file (o null se non disponibile)
const divData = {}; // chiave divisione → dati generali uniti a quelli della divisione

const saveProfile = () => store.set("owc.profile", profile);
const saveMatch = () => store.set("owc.match", match);

// ---------- volti degli eroi ----------

function initials(name) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

// icona copiata sul sito (heroes/<slug>.webp) → icona originale → iniziali su colore del ruolo.
// Si ricorda quale fonte ha funzionato, così i consigli (ridisegnati a ogni tocco) non riprovano.
const iconSrc = new Map(); // slug → url buono, oppure null = nessuna icona
function face(h) {
  const s = document.createElement("span");
  s.className = `face r-${h.role}`;
  const tries = [`heroes/${h.slug}.webp`, h.img].filter(Boolean);
  const known = iconSrc.get(h.slug);
  if (known === null) {
    s.textContent = initials(h.name);
    return s;
  }
  let k = known ? tries.indexOf(known) : 0;
  const img = new Image();
  img.alt = "";
  img.decoding = "async";
  img.onload = () => iconSrc.set(h.slug, img.src.endsWith(tries[k]) ? tries[k] : img.src);
  img.onerror = () => {
    if (++k < tries.length) { img.src = tries[k]; return; }
    iconSrc.set(h.slug, null);
    img.remove();
    s.textContent = initials(h.name);
  };
  img.src = tries[Math.max(k, 0)];
  s.append(img);
  return s;
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  return e;
}

// come replaceChildren, ma salta le parti facoltative assenti (null/undefined/false): altrimenti diventano testo "null"
function fill(box, ...kids) {
  box.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
}

// action: {label, run} → pulsante nel messaggio (es. "Annulla" dopo "Nuova partita")
function toast(msg, ms = 4500, action = null) {
  const t = $("#toast");
  fill(t, el("span", {}, msg), action ? el("button", {
    type: "button", class: "toast-btn",
    onclick: () => { t.hidden = true; clearTimeout(toast.timer); action.run(); },
  }, action.label) : null);
  t.classList.toggle("with-action", !!action);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- dati ----------

async function loadData() {
  lastLoad = Date.now();
  try {
    const r = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (!Array.isArray(d.heroes) || !d.heroes.length) throw new Error("dati vuoti");
    // elenco eroi cambiato (eroe nuovo o cambio di ruolo): la griglia va ridisegnata
    const heroSig = (x) => (x ? x.heroes.map((h) => `${h.id}:${h.role}:${h.name}`).join("|") : "");
    if (heroSig(d) !== heroSig(data)) $("#grid").replaceChildren();
    data = d;
    T = buildTheory(data, theoryRaw, patches);
    byId = Object.fromEntries(data.heroes.map((h) => [sid(h.id), h]));
    for (const k of Object.keys(divData)) delete divData[k];
    for (const k of Object.keys(divFiles)) delete divFiles[k];
    cleanSelections();
    await loadDivisions();
    return true;
  } catch (e) {
    console.warn("data.json", e);
    return false;
  }
}

// dati della divisione di ciascun giocatore (se ha scelto il rank e il file esiste)
async function loadDivisions() {
  const keys = new Set(profile.players.map((p) => RANK_DIV[p.rank]).filter(Boolean));
  await Promise.all([...keys].filter((k) => !(k in divFiles)).map(async (k) => {
    const info = data?.divisions?.[k];
    divFiles[k] = null;
    if (!info?.file) return;
    try {
      const r = await fetch(`${info.file}?t=${encodeURIComponent(info.checked ?? "")}`);
      if (r.ok) divFiles[k] = await r.json();
    } catch { /* offline senza copia: si usano i dati Ranked generali */ }
  }));
}

function playerData(i) {
  const k = RANK_DIV[profile.players[i].rank];
  if (!k || !divFiles[k]) return data;
  if (!divData[k]) divData[k] = withDivision(data, divFiles[k]); // niente "??=": WebView vecchie non lo conoscono
  return divData[k];
}

function dataLabel(i) {
  const p = profile.players[i];
  if (data?.filter?.gameType !== "Ranked") return "tutte le partite";
  if (!p.rank) return "Ranked, tutte le divisioni";
  return playerData(i) === data ? `Ranked, tutte le divisioni (dati ${p.rank} non disponibili)`
    : `Ranked ${["Grandmaster", "Campione"].includes(p.rank) ? "Grandmaster+" : p.rank}`;
}

// eroi spariti dai dati (rimossi dal gioco): via da partita e preferiti
function cleanSelections() {
  for (const g of Object.keys(LIMITS)) match[g] = match[g].filter((x) => byId[sid(x)]);
  match.picked = match.picked.map((x) => (x && byId[sid(x)] ? x : null));
  for (const p of profile.players) p.favorites = p.favorites.filter((x) => byId[sid(x)]);
  if (match.mapSlug && !data.maps.some((m) => m.slug === match.mapSlug)) match.mapSlug = null;
}

const fmtDay = (d) => d.toLocaleDateString("it-IT", { day: "numeric", month: "short" });
function ago(d) {
  const min = Math.round((Date.now() - d.getTime()) / 60e3);
  if (min < 2) return "adesso";
  if (min < 60) return `${min} min fa`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h fa` : `${Math.round(h / 24)} giorni fa`;
}
const filterText = () => (data?.filter?.gameType === "Ranked" ? "solo Ranked" : "tutte le partite (filtro Ranked non trovato)");

function renderFresh() {
  const warn = $("#warn");
  if (!data) {
    $("#fresh").textContent = "";
    warn.hidden = false;
    warn.textContent = "Impossibile caricare i dati. Controlla la connessione e premi «Aggiorna dati».";
    return;
  }
  const checked = new Date(data.checked);
  const src = new Date(data.sourceUpdated || data.checked);
  $("#fresh").textContent = `Dati counterwatch del ${fmtDay(src)}, controllati ${ago(checked)} · ${filterText()}`;
  const msgs = [];
  if (Date.now() - checked.getTime() > STALE_MS) msgs.push(`I dati non vengono aggiornati da ${ago(checked).replace(" fa", "")}.`);
  if (data.problems?.length) msgs.push("Counterwatch è cambiato in parte: alcune sezioni usano i dati precedenti.");
  warn.hidden = !msgs.length;
  warn.textContent = msgs.length ? `⚠ ${msgs.join(" ")} I consigli funzionano comunque.` : "";
  $("#data-info").textContent =
    `${data.heroes.length} eroi, ${data.maps.length} mappe, ${filterText()}. ` +
    `Fonte aggiornata il ${src.toLocaleString("it-IT")}; ultimo controllo ${ago(checked)}.` +
    (data.problems?.length ? ` Problemi: ${data.problems.join("; ")}.` : "");
}

// ---------- consigli ----------

function compute() {
  const players = profile.players.map((p, i) => ({
    role: match.roles[i], favorites: p.favorites, onlyFavorites: !!profile.onlyFavorites, data: playerData(i),
    picked: match.picked[i],
  }));
  return recommendTeam(data, {
    players, mapSlug: match.mapSlug, side: match.side, bans: match.bans, enemies: match.enemies, allies: match.allies,
    theory: T, useTheory: !!profile.useTheory,
  });
}

function nextRole(i) {
  const own = profile.players[i].roles;
  const cycle = own.length >= 2 ? own : ROLES.map(([k]) => k);
  const k = cycle.indexOf(match.roles[i]);
  match.roles[i] = cycle[(k + 1) % cycle.length];
  saveMatch();
  render();
}

const SHOWN = 3;
const est = (r) => `${(r.estimate * 100).toFixed(1)}%`;

const pctTxt = (d) => `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)}%`;

function profileSection(title, items, kind) {
  if (!items.length) return null;
  return el("section", { class: "prof-sec" },
    el("h3", {}, title, el("small", { class: "prof-count" }, ` ${items.length}`)),
    el("ul", { class: "prof-list" }, items.map((x) => el("li", {},
      kind === "map"
        ? el("span", { class: "prof-map" }, el("b", {}, x.subject.name), el("small", {}, MODE_IT[x.subject.mode] ?? x.subject.mode))
        : el("span", { class: "prof-hero" }, face(x.subject), x.subject.name),
      el("span", { class: x.delta >= 0 ? "good" : "bad" }, pctTxt(x.delta))))));
}

const theoryBadge = () => el("span", { class: "theory-badge" }, "Teoria");
function staleBanner(hero) {
  const st = theoryStatus(T, hero);
  return st.stale ? el("p", { class: "stale-note" }, `⚠ Teoria da rivedere per ${hero.name}: ${st.reasons.join("; ")}. `
    + "Le statistiche sono aggiornate; i consigli di teoria potrebbero non valere più.") : null;
}

function theorySection(title, items) {
  return el("section", { class: "prof-sec theory-sec" },
    el("h3", {}, theoryBadge(), " ", title, el("small", { class: "prof-count" }, ` ${items.length}`)),
    items.length
      ? el("ul", { class: "prof-list theory-list" }, items.map((x) => {
        const h = data.heroes.find((y) => y.name === x.name);
        return el("li", {},
          el("span", { class: "prof-hero" }, h ? face(h) : null, el("span", {}, el("b", {}, x.name), el("small", {}, x.why))));
      }))
      : el("p", { class: "muted small" }, "Nessuna indicazione dalle fonti."));
}

// eroi (presi o consigliati) degli altri giocatori, col nome di chi li gioca
function partnersOf(i) {
  return (lastDuo?.team ?? []).map((h, j) => (h && j !== i ? { id: h.id, name: profile.players[j].name, hero: h } : null)).filter(Boolean);
}

// Tre livelli, dal più immediato al più approfondito:
// 1. riquadro (colpo d'occhio): chi prendere, chi batte e chi teme (volti), "Segna come preso", alternative;
// 2. "Come giocarla" (un tocco sull'eroe): riepilogo di poche righe, il resto dei consigli chiuso sotto;
// 3. "Perché" (dalla guida): numeri, statistiche Ranked e teoria completa.

function rowFor(i, hero) {
  return (lastDuo?.lists?.[i] ?? []).find((r) => sid(r.hero.id) === sid(hero.id)) ?? null;
}

function openDetails(i, row) {
  const p = profile.players[i];
  const prof = heroProfile(playerData(i), row.hero.id, Infinity);
  const th = heroTheory(playerData(i), T, row.hero);
  const sum = breakdown(row, partnersOf(i));
  $("#t-why").textContent = `Perché ${row.hero.name}`;
  fill($("#why-body"),
    el("div", { class: "why-head" }, face(row.hero),
      el("div", {}, el("div", { class: "pick-name" }, row.hero.name),
        el("div", { class: "muted" }, `per ${p.name} · stima ${est(row)}`),
        el("div", { class: "muted small" }, `dati: ${dataLabel(i)}`))),
    el("p", { class: "why-sum" }, sum.map((b, k) => [k ? " · " : null, el("span", { class: b.good ? "good" : "bad" }, b.text)])),
    el("div", { class: "guide-row" }, el("button", { type: "button", class: "btn guide-btn", onclick: () => openGuide(i, row.hero) },
      "🎯 Come giocarla in questa partita")),
    el("h3", { class: "why-title" }, "Perché in questa partita"),
    el("ul", { class: "why-list" }, details(row).map((d) =>
      el("li", { class: `${d.good ? "good" : "bad"}${d.kind === "teoria" ? " is-theory" : ""}` }, d.kind === "teoria" ? [theoryBadge(), " "] : null, d.text))),
    el("h3", { class: "why-title" }, "Statistiche Ranked"),
    el("div", { class: "prof-grid" },
      profileSection("Forte contro", prof.strongVs, "hero"),
      profileSection("In difficoltà contro", prof.weakVs, "hero"),
      profileSection("Mappe migliori", prof.bestMaps, "map"),
      profileSection("Funziona bene con", prof.bestWith, "hero")),
    el("h3", { class: "why-title theory-title" }, theoryBadge(), " Come si incastra (guide e siti di Overwatch)"),
    staleBanner(row.hero),
    th.style ? el("p", { class: "theory-style" },
      el("b", {}, `Stile ${STYLE_IT[th.style]}`), `: ${STYLE_DESC[th.style]} (classificazione di counterwatch).`) : null,
    el("div", { class: "prof-grid theory-grid" },
      theorySection("Sinergizza con", th.synergies),
      theorySection("Countera bene", th.counters),
      theorySection("Viene counterato da", th.counteredBy)),
    th.uncertain ? el("p", { class: "muted small theory-note" },
      "Eroe recente o con poche fonti: la teoria è parziale, vale soprattutto lo stile.") : null,
    th.sources.length ? el("details", { class: "sources" }, el("summary", {}, `Fonti (${th.sources.length})`),
      el("ul", {}, th.sources.map((u) => el("li", {}, el("a", { href: u, rel: "noopener" }, u.replace(/^https?:\/\//, "")))))) : null,
    el("p", { class: "muted small" },
      "Statistiche: scarto dal 50% di vittorie (dati counterwatch). Teoria: indicazioni di guide e siti, non numeri."),
  );
  if (!$("#why-dialog").open) $("#why-dialog").showModal();
  $("#why-body").scrollTop = 0;
}

const BRIEF_ICON = { swap: "🔁", target: "🎯", threat: "⚠️", ability: "⚡", position: "🧭", protect: "🛡️", map: "🗺️" };
// volto + nome, per le righe del riepilogo che parlano di eroi
const heroChip = (h) => el("span", { class: "hchip" }, face(h), h.name);

function briefList(items) {
  return el("ul", { class: "brief" }, items.map((it) => el("li", {
    class: `brief-row k-${it.key} ${it.kind === "teoria" ? "is-theory" : "is-data"}`,
    "aria-label": `${it.text} (${it.kind === "teoria" ? "teoria" : "dati"})`,
  },
  el("span", { class: "brief-ico", "aria-hidden": "true" }, BRIEF_ICON[it.key] ?? "•"),
  el("span", { class: "brief-lab", "aria-hidden": "true" }, it.label),
  el("span", { class: "brief-txt", "aria-hidden": "true" },
    it.heroes?.length ? it.heroes.map(heroChip) : null,
    it.short ? el("span", { class: it.heroes?.length ? "brief-after" : null }, it.short) : it.heroes?.length ? null : it.text))));
}

function openGuide(i, hero) {
  const p = profile.players[i];
  const rows = lastDuo?.lists?.[i] ?? null;
  const g = playGuide(playerData(i), T, {
    hero, mapSlug: match.mapSlug, side: match.side, enemies: match.enemies, allies: match.allies,
    partners: partnersOf(i).map((x) => x.hero).filter((h) => sid(h.id) !== sid(hero.id)),
    rows,
  });
  const brief = g.sections.find((s) => s.summary);
  const rest = g.sections.filter((s) => !s.summary);
  const isPicked = !!match.picked[i] && sid(match.picked[i]) === sid(hero.id);
  const row = rowFor(i, hero);
  $("#t-guide").textContent = `Come giocare ${hero.name}`;
  fill($("#guide-body"),
    el("div", { class: "why-head" }, face(hero),
      el("div", {}, el("div", { class: "pick-name" }, hero.name),
        el("div", { class: "muted small" }, `${p.name} · ${currentMap()?.name ?? "nessuna mappa"}` +
          `${match.side ? ` · ${match.side === "attack" ? "attacco" : "difesa"}` : ""} · ${match.enemies.length} avversari`))),
    el("div", { class: "guide-actions", style: `--pc: var(--p${i})` },
      el("button", {
        type: "button", class: "took-btn", "aria-pressed": String(isPicked),
        onclick: () => { togglePicked(i, hero); openGuide(i, hero); },
      }, isPicked ? `✓ Preso da ${p.name}` : `Segna: ${p.name} l'ha preso`)),
    staleBanner(hero),
    brief ? el("section", { class: "guide-sec guide-summary" },
      el("h3", {}, "📋 In breve"),
      briefList(brief.items),
      el("p", { class: "legend" }, el("span", { class: "dot theory" }), " guide e siti  ", el("span", { class: "dot data" }), " statistiche Ranked")) : null,
    rest.length ? el("details", { class: "guide-more" },
      el("summary", {}, `Tutti i consigli (${rest.length} sezioni)`),
      rest.map((sec) => el("section", { class: "guide-sec" },
        el("h3", {}, sec.title),
        el("ul", {}, sec.items.map((it) => el("li", {},
          el("span", { class: it.kind === "teoria" ? "theory-badge" : "data-badge" }, it.kind === "teoria" ? "Teoria" : "Dati"), " ", it.text)))))) : null,
    row ? el("div", { class: "guide-row" }, el("button", { type: "button", class: "btn why-btn", onclick: () => openDetails(i, row) },
      "📊 Perché? Numeri e teoria")) : null,
    g.uncertain ? el("p", { class: "muted small theory-note" }, "Per questo eroe le fonti sono poche: i consigli di teoria sono parziali.") : null,
    el("p", { class: "muted small" }, "Consigli da guide e siti di Overwatch e da statistiche Ranked di counterwatch: aiuti, non certezze."),
  );
  if ($("#why-dialog").open) $("#why-dialog").close();
  if (!$("#guide-dialog").open) $("#guide-dialog").showModal();
  $("#guide-body").scrollTop = 0;
}

// Il riquadro completo dei consigli scorre con la pagina; quando è uscito dallo schermo compare in alto
// la barra minima (n. 1 di ciascuno, toccabile) e il selettore Ban/Avversari/Alleati si ferma sotto di lei.
// Se il consiglio di un giocatore cambia mentre si segnano gli avversari, il suo riquadrino lampeggia una volta.
let miniTops = [];
function renderMini() {
  const box = $("#mini");
  box.replaceChildren();
  if (!lastDuo) return;
  box.className = `mini n${Math.min(profile.players.length, 5)}`;
  const tops = profile.players.map((p, i) => lastDuo.lists[i]?.[0]?.hero?.id ?? null);
  profile.players.forEach((p, i) => {
    const r = lastDuo.lists[i]?.[0];
    if (!r) return;
    const changed = miniTops[i] !== undefined && miniTops[i] !== tops[i];
    box.append(el("button", { type: "button", class: `mini-pick${r.picked ? " took" : ""}${changed ? " pulse" : ""}`, style: `--pc: var(--p${i})`,
      onclick: () => openGuide(i, r.hero),
      "aria-label": `${p.name}: ${r.picked ? "ha preso " : ""}${r.hero.name}, stima ${est(r)}. Tocca per come giocarla` },
    face(r.hero), el("span", { class: "mini-txt" }, el("b", {}, r.hero.name), el("small", {}, `${r.picked ? "✓ " : ""}${p.name} · ${est(r)}`))));
  });
  miniTops = tops;
}
function updateMini() {
  if ($("#view-match").hidden) return;
  const mini = $("#mini");
  const show = $("#picks").getBoundingClientRect().bottom < 0;
  if (mini.hidden === show) mini.hidden = !show;
  document.documentElement.style.setProperty("--picks-h", show ? `${Math.round(mini.getBoundingClientRect().height)}px` : "0px");
}

// avversari che l'eroe batte (verde) e da cui deve guardarsi (rosso): solo volti, il dettaglio è nella guida
function matchupRow(top) {
  const m = matchups(top);
  if (!m.strong.length && !m.weak.length) return el("p", { class: "pick-why" }, "Nessun vantaggio netto");
  const grp = (cls, label, xs) => (xs.length ? el("span", {
    class: `mu-grp ${cls}`, role: "img", "aria-label": `${label} ${xs.map((x) => x.hero.name).join(", ")}`,
  }, el("span", { class: "mu-lab", "aria-hidden": "true" }, label), xs.map((x) => face(x.hero))) : null);
  return el("div", { class: "mu" }, grp("good", "Batte", m.strong), grp("bad", "Teme", m.weak));
}

function pickCard(p, i) {
  const rows = lastDuo.lists[i] ?? [];
  const top = rows[0];
  const took = !!top?.picked;
  const role = took ? top.hero.role : match.roles[i];
  const head = el("div", { class: "pick-head" },
    el("span", { class: "pick-player", title: dataLabel(i) }, p.name),
    took ? el("span", { class: "role-tag" }, ROLE_IT[role] ?? "")
      : el("button", {
        type: "button", class: "role-btn",
        "aria-label": `Ruolo di ${p.name}: ${role ? ROLE_IT[role] : "qualsiasi"}. Tocca per cambiare`,
        onclick: () => nextRole(i),
      }, role ? ROLE_IT[role] : "Qualsiasi"));
  const style = `--pc: var(--p${i})`;
  if (!top) return el("article", { class: "pick empty", style }, head, el("p", { class: "pick-why" }, "Nessun eroe disponibile"));
  const note = lastDuo.notes?.[i];
  const why = match.enemies.length ? null : headline(top, partnersOf(i));
  const sw = took ? swapAdvice(playerData(i), T, { hero: top.hero, rows, enemies: match.enemies }) : null;
  const alts = took ? [] : rows.slice(1, SHOWN);
  return el("article", { class: `pick${took ? " took" : ""}`, style, "aria-label": `${p.name}: ${took ? "ha preso" : "consigliato"} ${top.hero.name}` },
    head,
    note ? el("div", { class: "pick-note warn-note" }, note)
      : profile.onlyFavorites && !took ? el("div", { class: "pick-note" }, "★ solo preferiti") : null,
    el("button", {
      type: "button", class: "pick-main", onclick: () => openGuide(i, top.hero),
      "aria-label": `${took ? `${p.name} ha preso` : `Per ${p.name}:`} ${top.hero.name}, stima ${est(top)}. Tocca per come giocarla`,
    },
    face(top.hero),
    el("span", { class: "pm-txt" },
      el("span", { class: "pick-name" }, top.hero.name),
      el("span", { class: "pick-est" }, `${est(top)}${top.favorite ? " · ★" : ""}`)),
    el("span", { class: "pick-cta" }, "🎯 Come giocarla ›")),
    match.enemies.length ? matchupRow(top) : why ? el("p", { class: "pick-why" }, why) : null,
    sw ? el("button", {
      type: "button", class: "swap", onclick: () => openGuide(i, sw.hero),
      "aria-label": `Meglio passare a ${sw.hero.name}: ${sw.why}. Tocca per come giocarla`,
    }, el("span", { class: "swap-lab" }, "🔁 Passa a"), el("span", { class: "swap-hero" }, face(sw.hero), el("b", {}, sw.hero.name))) : null,
    el("button", {
      type: "button", class: "took-btn", "aria-pressed": String(took),
      "aria-label": took ? `${p.name} ha preso ${top.hero.name}: tocca per annullare` : `Segna che ${p.name} ha preso ${top.hero.name}`,
      onclick: () => togglePicked(i, top.hero),
    }, took ? "✓ Preso" : "Segna come preso"),
    took ? null : el("div", { class: "alts" },
      el("span", { class: "alts-lab" }, alts.length ? "Oppure" : "Ha preso un altro eroe?"),
      alts.map((r) => el("button", {
        type: "button", class: "alt", onclick: () => openGuide(i, r.hero),
        "aria-label": `In alternativa ${r.hero.name}, stima ${est(r)}. Tocca per come giocarla`,
      }, face(r.hero), el("span", { class: "alt-nm" }, r.hero.name))),
      el("button", {
        type: "button", class: "alt alt-other", onclick: () => choosePicker(i),
        "aria-label": `${p.name} ha preso un altro eroe: toccalo nella griglia`,
      }, el("span", { class: "face alt-plus", "aria-hidden": "true" }, "＋"), el("span", { class: "alt-nm" }, "Altro"))),
  );
}

function renderPicks() {
  const box = $("#picks");
  box.replaceChildren();
  if (!data) return;
  lastDuo = compute();
  box.className = `picks n${profile.players.length}`;
  profile.players.forEach((p, i) => box.append(pickCard(p, i)));
  for (const t of $$(".pick-name, .alt-nm", box)) fitText(t);
  renderMini();
  updateMini();
}

// ---------- mappa e lato ----------

function currentMap() {
  return data?.maps.find((m) => m.slug === match.mapSlug) ?? null;
}

function renderControls() {
  const map = currentMap();
  $("#map-name").textContent = map ? `${map.name} · ${MODE_IT[map.mode] ?? map.mode}` : "nessuna (dati generali)";
  const side = $("#side");
  side.hidden = !hasSides(map);
  $$("button", side).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.side === match.side)));
}

function buildMapDialog() {
  const list = $("#map-list");
  list.replaceChildren();
  list.append(el("div", { class: "maps" },
    el("button", { type: "button", class: "map-opt none", "data-map": "", "aria-pressed": String(!match.mapSlug) }, "Nessuna mappa (dati generali)")));
  for (const [mode, label] of MODES) {
    const maps = data.maps.filter((m) => m.mode === mode).sort((a, b) => a.name.localeCompare(b.name));
    if (!maps.length) continue;
    list.append(el("h3", { class: "mode-title" }, label + (hasSides({ mode }) ? " · attacco/difesa" : "")),
      el("div", { class: "maps" }, maps.map((m) =>
        el("button", { type: "button", class: "map-opt", "data-map": m.slug, "aria-pressed": String(m.slug === match.mapSlug) }, m.name))));
  }
}

// ---------- griglia eroi ----------

function buildHeroGrid(container, onTap) {
  container.replaceChildren();
  delete container.dataset.fitW;
  for (const [role, label] of ROLES) {
    const heroes = data.heroes.filter((h) => h.role === role).sort((a, b) => a.name.localeCompare(b.name));
    container.append(
      el("h2", { class: `role-title r-${role}` }, label),
      el("div", { class: "grid" }, heroes.map((h) =>
        el("button", { type: "button", class: "hero", "data-id": sid(h.id), "aria-pressed": "false", onclick: () => onTap(sid(h.id)) },
          face(h), el("span", { class: `nm${h.name.length >= 10 ? " long" : ""}` }, h.name)))),
    );
  }
}

// Nomi mai spezzati a metà parola: se la parola più lunga non ci sta nello spazio disponibile, il carattere si
// rimpicciolisce quanto basta. Si misura il testo VERO sulla pagina (con il carattere del telefono e il suo
// ingrandimento di sistema, es. 130% su Xiaomi) e si cambia solo un fattore (--fit): una dimensione in px
// verrebbe ingrandita una seconda volta dalla WebView. Vale per la griglia, i riquadri e le alternative.
function fitText(t) {
  t.style.removeProperty("--fit");
  const box = t.parentElement;
  if (!box || !box.clientWidth) return;
  const cs = getComputedStyle(box);
  const avail = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
  const probe = el("span", { class: "nm-probe", "aria-hidden": "true" });
  t.append(probe);
  let w = 0;
  for (const word of (t.firstChild?.textContent ?? "").split(/\s+/)) {
    probe.textContent = word;
    w = Math.max(w, probe.getBoundingClientRect().width);
  }
  probe.remove();
  if (w > avail) t.style.setProperty("--fit", String(Math.max(0.55, Math.floor((avail / w) * 100) / 100)));
}
window.owcFitText = fitText; // per il collaudo

function fitNames(container) {
  const nms = $$(".hero .nm", container);
  const width = nms[0]?.parentElement.clientWidth ?? 0;
  if (!width || container.dataset.fitW === String(width)) return;
  container.dataset.fitW = String(width);
  for (const nm of nms) fitText(nm);
}

function groupOf(id) {
  return Object.keys(LIMITS).find((g) => match[g].map(sid).includes(id)) ?? null;
}
const pickerOf = (id) => match.picked.findIndex((x) => x && sid(x) === id);

function tapHero(id) {
  const g = match.group;
  if (g === "picked") { tapPicked(id); return; }
  const cur = groupOf(id);
  if (cur === g) {
    match[g] = match[g].filter((x) => sid(x) !== id);
  } else {
    if (match[g].length >= limitOf(g)) {
      toast(g === "allies" && !limitOf(g) ? `Siete già in ${MAX_PLAYERS}: segnate gli eroi presi con «Chi ha preso».`
        : `Al massimo ${limitOf(g)} ${GROUP_WORD[g]}: togline uno toccandolo.`);
      return;
    }
    if (cur) match[cur] = match[cur].filter((x) => sid(x) !== id);
    const who = pickerOf(id);
    if (who >= 0) match.picked[who] = null;
    match[g] = [...match[g], id];
  }
  saveMatch();
  render();
}

// Eroe preso da un giocatore: "Segna come preso" nel riquadro (o nella guida) per l'eroe consigliato,
// "Altro" nel riquadro per un eroe diverso (si tocca nella griglia). Un eroe preso esce da ban/avversari/alleati.
function setPicked(i, id) {
  const who = pickerOf(id);
  if (who >= 0) match.picked[who] = null;
  for (const g of Object.keys(LIMITS)) match[g] = match[g].filter((x) => sid(x) !== id);
  match.picked[i] = id;
}

function togglePicked(i, hero) {
  const id = sid(hero.id);
  const was = !!match.picked[i] && sid(match.picked[i]) === id;
  if (was) match.picked[i] = null;
  else setPicked(i, id);
  saveMatch();
  render();
  toast(was ? `${profile.players[i].name}: ${hero.name} tolto` : `${profile.players[i].name} ha preso ${hero.name} ✓`, 1800);
}

// "Altro": il prossimo tocco nella griglia è l'eroe preso da quel giocatore (poi si torna agli avversari)
function choosePicker(i) {
  match.group = "picked";
  match.pickFor = i;
  saveMatch();
  render();
  const top = $("#grid").getBoundingClientRect().top + window.scrollY;
  window.scrollTo(0, Math.max(0, top - 170));
}

function tapPicked(id) {
  const i = match.pickFor;
  setPicked(i, id);
  match.group = "enemies";
  saveMatch();
  render();
  toast(`${profile.players[i].name} ha preso ${byId[id].name} ✓`, 2000);
}

function renderGrid() {
  const recs = (lastDuo?.lists ?? []).map((rows) => (rows[0] && !rows[0].picked ? sid(rows[0].hero.id) : null));
  const favs = new Set(profile.players.flatMap((p) => p.favorites.map(sid)));
  for (const b of $$("#grid .hero")) {
    const id = b.dataset.id;
    const g = groupOf(id);
    const took = pickerOf(id);
    const rec = took >= 0 ? -1 : recs.indexOf(id);
    const who = took >= 0 ? took : rec;
    b.classList.toggle("in-bans", g === "bans");
    b.classList.toggle("in-enemies", g === "enemies");
    b.classList.toggle("in-allies", g === "allies");
    b.classList.toggle("fav", favs.has(id));
    b.classList.toggle("took", took >= 0);
    b.classList.toggle("rec", rec >= 0);
    if (who >= 0) b.style.setProperty("--pc", `var(--p${who})`);
    else b.style.removeProperty("--pc");
    const inGroup = match.group === "picked" ? took === match.pickFor : g === match.group;
    b.setAttribute("aria-pressed", String(inGroup));
    const whoName = who >= 0 ? profile.players[who].name : "";
    b.setAttribute("aria-label", `${byId[id].name}${g ? `, ${GROUP_ONE[g]}` : ""}` +
      `${took >= 0 ? `, preso da ${whoName}` : rec >= 0 ? `, consigliato a ${whoName}` : ""}`);
    $(".tag", b)?.remove();
    if (who >= 0) {
      b.append(el("span", { class: `tag${took >= 0 ? " tag-took" : ""}`, "aria-hidden": "true" },
        `${initials(whoName).slice(0, 1)}${took >= 0 ? "✓" : ""}`));
    }
  }
}

function renderGroups() {
  for (const b of $$("#groups button")) {
    const g = b.dataset.group;
    b.setAttribute("aria-pressed", String(g === match.group));
    $(`[data-count="${g}"]`).textContent = match[g].length;
    if (g === "allies") b.hidden = !limitOf("allies");
  }
  // mentre si segna l'eroe preso da un giocatore, al posto del selettore c'è un avviso col suo colore
  const picking = match.group === "picked";
  $("#groups").hidden = picking;
  const banner = $("#pick-banner");
  banner.hidden = !picking;
  const box = $("#chosen");
  box.replaceChildren();
  box.hidden = picking;
  if (picking) {
    banner.style.setProperty("--pc", `var(--p${match.pickFor})`);
    $("#pick-banner-txt").textContent = `Tocca l'eroe preso da ${profile.players[match.pickFor].name}`;
    return;
  }
  const ids = match[match.group];
  if (!ids.length) {
    box.append(el("span", { class: "hint" }, GROUP_HINT[match.group]));
    return;
  }
  for (const id of ids) {
    const h = byId[sid(id)];
    box.append(el("button", { type: "button", class: `chip ${match.group}`, "aria-label": `Togli ${h.name}`, onclick: () => tapHero(sid(id)) },
      face(h), h.name, " ✕"));
  }
}

// ---------- profilo ----------

function renderProfile() {
  const box = $("#players");
  box.replaceChildren();
  profile.players.forEach((p, i) => {
    const nameId = `p${i}-name`, rankId = `p${i}-rank`;
    box.append(el("section", { class: "card", "aria-labelledby": `p${i}-title` },
      el("div", { class: "card-head" },
        el("h2", { id: `p${i}-title`, style: `--pc: var(--p${i})` }, el("span", { class: "p-dot", "aria-hidden": "true" }), `Giocatore ${i + 1}`),
        profile.players.length > 1 ? el("button", { type: "button", class: "btn ghost small-btn", "aria-label": `Rimuovi ${p.name}`,
          onclick: (e) => {
            // due tocchi: un tocco per sbaglio non cancella rank e preferiti
            const b = e.currentTarget;
            if (b.dataset.armed) { removePlayer(i); return; }
            b.dataset.armed = "1";
            b.textContent = "Tocca per confermare";
            b.classList.add("danger");
            setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = "Rimuovi"; b.classList.remove("danger"); } }, 3000);
          } }, "Rimuovi") : null),
      el("label", { for: nameId }, "Nome"),
      el("input", { id: nameId, value: p.name, maxlength: "16", autocomplete: "off",
        onchange: (e) => { p.name = e.target.value.trim() || defaultName(i); saveProfile(); render(); } }),
      el("label", { for: rankId }, "Rank"),
      (() => {
        const s = el("select", { id: rankId, onchange: async (e) => { p.rank = e.target.value; saveProfile(); await loadDivisions(); render(); } },
          RANKS.map((r) => el("option", { value: r }, r || "—")));
        s.value = p.rank ?? "";
        return s;
      })(),
      el("label", {}, "Ruoli (il primo è quello proposto a inizio partita)"),
      el("div", { class: "toggles", role: "group", "aria-label": `Ruoli di ${p.name}` }, ROLES.map(([k, label]) =>
        el("button", { type: "button", class: "toggle", "aria-pressed": String(p.roles.includes(k)),
          onclick: () => {
            p.roles = p.roles.includes(k) ? p.roles.filter((r) => r !== k) : [...p.roles, k];
            if (!p.roles.includes(match.roles[i])) { match.roles[i] = p.roles[0] ?? null; saveMatch(); }
            saveProfile(); render();
          } }, label))),
      el("label", {}, `Eroi preferiti (${p.favorites.length})`),
      p.favorites.length ? null : el("p", { class: "muted small" }, "Nessun preferito: con «solo preferiti» si consiglia tra tutti."),
      el("div", { class: "fav-list" }, p.favorites.map((id) => el("span", { class: "chip" }, face(byId[sid(id)]), byId[sid(id)].name))),
      el("div", { class: "row" }, el("button", { type: "button", class: "btn", onclick: () => openFavorites(i) }, "Scegli preferiti")),
    ));
  });
  box.append(el("div", { class: "row add-row" }, profile.players.length < MAX_PLAYERS
    ? el("button", { type: "button", id: "add-player", class: "btn", onclick: addPlayer }, `＋ Aggiungi giocatore (${profile.players.length}/${MAX_PLAYERS})`)
    : el("p", { class: "muted small" }, `Siete in ${MAX_PLAYERS}: squadra completa.`)));
  box.append(el("section", { class: "card" },
    el("h2", {}, "Consigli"),
    el("button", {
      type: "button", class: "toggle wide", "aria-pressed": String(!!profile.onlyFavorites),
      onclick: () => { profile.onlyFavorites = !profile.onlyFavorites; saveProfile(); render(); },
    }, profile.onlyFavorites ? "✓ Suggerisci solo eroi preferiti" : "Suggerisci solo eroi preferiti"),
    el("button", {
      type: "button", class: "toggle wide", "aria-pressed": String(!!profile.useTheory),
      onclick: () => { profile.useTheory = !profile.useTheory; saveProfile(); render(); },
    }, profile.useTheory ? "✓ Usa anche la teoria nei consigli" : "Usa anche la teoria nei consigli"),
    el("p", { class: "muted small" },
      "Teoria: stili Rush/Dive/Poke e counter noti da guide e siti. Spenta si vede ma non cambia la classifica; " +
      "accesa aggiunge un piccolo peso (±0,5% per indicazione). " +
      "Solo preferiti: vale per tutti, a ognuno si consiglia solo tra i suoi preferiti del ruolo scelto. " +
      "Se non ne resta nessuno (ruolo, ban, alleati) si consiglia tra tutti e lo vedi scritto."),
  ));
  box.append(el("p", { class: "muted small", style: "margin:0 16px" },
    "Il rank sceglie i dati Ranked della vostra divisione (Grandmaster e Campione usano gli stessi, come su counterwatch). " +
    "I preferiti ricevono un piccolo vantaggio (+1%) nei consigli."));
  const tok = store.get("owc.token", "");
  $("#token").value = "";
  $("#token").placeholder = tok ? "token salvato ✓ (inseriscine uno nuovo per sostituirlo)" : "github_pat_…";
}

// da 1 a 5 giocatori: chi si aggiunge prende il ruolo che manca nella coda 1 tank, 2 danni, 2 supporti
function addPlayer() {
  if (profile.players.length >= MAX_PLAYERS) return;
  const used = { Tank: 0, Damage: 0, Support: 0 };
  for (const p of profile.players) if (p.roles[0]) used[p.roles[0]]++;
  const role = ROLES.map(([k]) => k).sort((a, b) => (ROLE_QUOTA[b] - used[b]) - (ROLE_QUOTA[a] - used[a]))[0];
  const i = profile.players.length;
  profile.players.push({ name: defaultName(i), rank: "", roles: [role], favorites: [] });
  match.roles.push(role);
  match.picked.push(null);
  fitMatch();
  saveProfile(); saveMatch();
  render();
  toast(`Aggiunto ${defaultName(i)} (${ROLE_IT[role]}): cambia nome e ruolo qui sotto.`);
}
function removePlayer(i) {
  if (profile.players.length <= 1) return;
  const [gone] = profile.players.splice(i, 1);
  match.roles.splice(i, 1);
  match.picked.splice(i, 1);
  if (match.pickFor >= profile.players.length || match.pickFor === i) match.pickFor = 0;
  else if (match.pickFor > i) match.pickFor--;
  fitMatch();
  saveProfile(); saveMatch();
  loadDivisions().then(render);
  toast(`${gone.name} rimosso.`);
}

let favPlayer = 0;
function openFavorites(i) {
  favPlayer = i;
  $("#t-fav").textContent = `Preferiti di ${profile.players[i].name}`;
  const grid = $("#fav-grid");
  buildHeroGrid(grid, (id) => {
    const p = profile.players[favPlayer];
    p.favorites = p.favorites.map(sid).includes(id) ? p.favorites.filter((x) => sid(x) !== id) : [...p.favorites, id];
    saveProfile();
    paintFavorites();
  });
  paintFavorites();
  $("#fav-dialog").showModal();
  fitNames(grid);
}
function paintFavorites() {
  const favs = new Set(profile.players[favPlayer].favorites.map(sid));
  for (const b of $$("#fav-grid .hero")) {
    b.classList.toggle("in-allies", favs.has(b.dataset.id));
    b.setAttribute("aria-pressed", String(favs.has(b.dataset.id)));
  }
}

// ---------- aggiornamento ----------

async function refresh() {
  const btn = $("#refresh");
  const label = (t) => { btn.textContent = t; };
  const token = store.get("owc.token", "");
  btn.disabled = true;
  refreshing = true;
  try {
    if (!token) {
      const ok = await loadData();
      render();
      toast(ok ? "Ricaricati gli ultimi dati pubblicati. Per scaricarli subito da counterwatch, aggiungi il token in Profilo."
        : "Nessuna connessione: uso i dati salvati.", 6500);
      return;
    }
    const wait = DISPATCH_GAP_MS - (Date.now() - store.get("owc.lastDispatch", 0));
    if (wait > 0) {
      await loadData();
      render();
      toast(`Aggiornamento già chiesto da poco: puoi richiederlo tra ${Math.ceil(wait / 60e3)} min. Ricaricati gli ultimi dati.`, 6500);
      return;
    }
    const api = (path, opt = {}) => fetch(`https://api.github.com/repos/${REPO}${path}`, {
      ...opt,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    label("Avvio…");
    const started = Date.now();
    const r = await api(`/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main" }) });
    if (r.status !== 204) {
      toast([401, 403, 404].includes(r.status)
        ? "Il token non è valido o non ha il permesso Actions (lettura e scrittura) su overwatch-counter."
        : `GitHub ha risposto ${r.status}: riprova più tardi.`, 7000);
      return;
    }
    store.set("owc.lastDispatch", started);
    const deadline = started + 15 * 60e3;
    while (Date.now() < deadline) {
      label(`Aggiornamento in corso… ${Math.floor((Date.now() - started) / 60e3)}/~3 min`);
      await sleep(15000);
      let run;
      try {
        const rr = await api(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=1`);
        if (!rr.ok) continue;
        run = (await rr.json()).workflow_runs?.[0];
      } catch { continue; }
      if (!run || new Date(run.created_at).getTime() < started - 60e3) continue;
      if (run.status !== "completed") continue;
      await loadData();
      render();
      toast(run.conclusion === "success" ? "Dati aggiornati ✓"
        : "Aggiornamento finito con problemi: se ci sono avvisi li vedi in giallo. I consigli funzionano comunque.", 6500);
      return;
    }
    toast("L'aggiornamento ci mette troppo: riprova più tardi.");
  } catch {
    toast("Nessuna connessione: uso i dati salvati.");
  } finally {
    refreshing = false;
    btn.disabled = false;
    label("Aggiorna dati");
  }
}

// ---------- tutto insieme ----------

function render() {
  renderFresh();
  if (!data) return;
  if (!$("#grid .hero")) buildHeroGrid($("#grid"), tapHero);
  renderControls();
  renderPicks();
  renderGroups();
  renderGrid();
  fitNames($("#grid"));
  if (!$("#view-profile").hidden) renderProfile();
}

function showView(name) {
  $("#view-match").hidden = name !== "match";
  $("#view-profile").hidden = name !== "profile";
  $$(".tabs [data-view]").forEach((b) => (b.dataset.view === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  if (name === "profile" && data) renderProfile();
  store.set("owc.view", name);
  window.scrollTo(0, 0);
  // i nomi si misurano solo a vista (nascosti hanno larghezza 0)
  if (name === "match" && data) { renderPicks(); fitNames($("#grid")); }
}

function wire() {
  $$(".tabs [data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  $$("#groups button").forEach((b) => b.addEventListener("click", () => { match.group = b.dataset.group; saveMatch(); render(); }));
  $$("#side button").forEach((b) => b.addEventListener("click", () => {
    match.side = match.side === b.dataset.side ? null : b.dataset.side;
    saveMatch(); render();
  }));
  $("#map-btn").addEventListener("click", () => { buildMapDialog(); $("#map-dialog").showModal(); });
  $("#map-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-map]");
    if (!b) return;
    match.mapSlug = b.dataset.map || null;
    if (!hasSides(currentMap())) match.side = null;
    saveMatch();
    $("#map-dialog").close();
    render();
  });
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  $("#fav-dialog").addEventListener("close", () => render());
  // Nuova partita: un tocco, sempre a portata di pollice; per un tocco sbagliato c'è "Annulla"
  $("#new-match").addEventListener("click", () => {
    const before = JSON.stringify(match);
    match = emptyMatch();
    saveMatch();
    showView("match");
    render();
    toast("Nuova partita: scegli mappa e ban.", 6000, {
      label: "Annulla",
      run: () => { match = JSON.parse(before); fitMatch(); saveMatch(); render(); toast("Partita ripristinata.", 2000); },
    });
  });
  $("#pick-cancel").addEventListener("click", () => { match.group = "enemies"; saveMatch(); render(); });
  $("#refresh").addEventListener("click", refresh);
  $("#token-save").addEventListener("click", () => {
    const v = $("#token").value.trim();
    if (!v) { toast("Incolla prima il token."); return; }
    store.set("owc.token", v);
    renderProfile();
    toast("Token salvato su questo telefono.");
  });
  $("#token-clear").addEventListener("click", () => { store.del("owc.token"); renderProfile(); toast("Token rimosso."); });
}

async function autoRefresh() {
  if (document.visibilityState === "hidden" || refreshing || !lastLoad) return;
  if (Date.now() - lastLoad < AUTO_REFRESH_MS) return;
  const before = data?.checked;
  if (await loadData()) {
    render();
    if (data.checked !== before) toast("Dati aggiornati ✓", 2500);
  }
}

async function start() {
  wire();
  document.addEventListener("pointerdown", autoRefresh, { capture: true, passive: true });
  window.addEventListener("scroll", updateMini, { passive: true });
  window.addEventListener("resize", () => {
    if (!data || $("#view-match").hidden) return;
    fitNames($("#grid"));
    for (const t of $$("#picks .pick-name, #picks .alt-nm")) fitText(t);
  });
  document.addEventListener("visibilitychange", autoRefresh);
  window.addEventListener("focus", autoRefresh);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  try {
    const r = await fetch("theory.json");
    if (r.ok) theoryRaw = await r.json();
  } catch { /* senza teoria: restano gli stili Rush/Dive/Poke dei dati */ }
  try {
    const r = await fetch(`patches.json?t=${Date.now()}`);
    if (r.ok) patches = await r.json();
  } catch { /* facoltativo */ }
  const ok = await loadData();
  if (ok) saveMatch();
  render();
  showView(store.get("owc.view", "match") === "profile" ? "profile" : "match");
}

start();

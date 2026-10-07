import { recommend, recommendTeam, breakdown, details, hasSides, withDivision, heroProfile, matchups, headline, banSuggestions, BAN_ROLES,
  BANS_PER_ROLE, guideBanSuggestions, blendedBanSuggestions, guideDetails, threatScores, rankStars, STAR_MIN_SD, matchupSign } from "./recommend.js";
import { buildTheory, heroTheory, playGuide, theoryStatus, swapAdvice, STYLE_IT, STYLE_DESC } from "./theory.js";
import { icon, fillIcons } from "./icons.js";

// WebView Android meno recenti (Chrome < 86) non hanno replaceChildren
if (!Element.prototype.replaceChildren) {
  Element.prototype.replaceChildren = function replaceChildren(...nodes) {
    while (this.firstChild) this.removeChild(this.firstChild);
    this.append(...nodes);
  };
}

const REPO = "fmarzocchi/overwatch-counter";
const WORKFLOW = "update-data.yml";
const LIMITS = { bans: 5, enemies: 5, allies: 5 };
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
  // regole di gioco anche sulle partite salvate prima: bannato = né giocato né avversario; un eroe una volta per squadra
  const banned = new Set(match.bans.map(sid));
  const uniq = (xs) => xs.filter((x, k) => xs.findIndex((y) => sid(y) === sid(x)) === k);
  match.picked = match.picked.map((x, k) => (x && !banned.has(sid(x)) && match.picked.findIndex((y) => y && sid(y) === sid(x)) === k ? x : null));
  const ours = new Set(match.picked.filter(Boolean).map(sid));
  match.bans = uniq(match.bans);
  match.enemies = uniq(match.enemies).filter((x) => !banned.has(sid(x)));
  match.allies = uniq(match.allies).filter((x) => !banned.has(sid(x)) && !ours.has(sid(x)));
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
// app/names_it.json (facoltativo): nomi ufficiali italiani del gioco, dall'inglese (la lingua di counterwatch e della teoria)
let IT = { heroes: {}, maps: {}, abilities: {} };
// Eroi col nome del gioco dove è diverso (Soldier: 76 → Soldato-76, Junker Queen → Regina dei Junker): solo nei
// testi mostrati (el/fill e titoli), perché dati e teoria li cercano per nome inglese. D.VA ≈ D.Va: resta com'è.
let heroRe = null;
let heroIt = {};
function setHeroNames() {
  // anche le mappe (Ilios → Ilio) citate nei testi della teoria
  heroIt = Object.fromEntries(Object.entries({ ...(IT.heroes ?? {}), ...(IT.maps ?? {}) })
    .filter(([en, it]) => it && en.toLowerCase() !== it.toLowerCase()));
  const keys = Object.keys(heroIt).sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  heroRe = keys.length ? new RegExp(keys.join("|"), "g") : null;
}
const tr = (t) => (heroRe && typeof t === "string" ? t.replace(heroRe, (m) => heroIt[m]) : t);
const heroName = (h) => tr(h.name);
const divFiles = {}; // chiave divisione → contenuto del file (o null se non disponibile)
const divData = {}; // chiave divisione → dati generali uniti a quelli della divisione

const saveProfile = () => store.set("owc.profile", profile);
// "Solo guide e pro": consigli e ban senza le statistiche di counterwatch (servono la teoria e le mappe studiate)
const guideMode = () => !!profile.guideOnly && !!T;
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
    else e.setAttribute(k, v === true ? "" : tr(v));
  }
  e.append(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false).map(tr));
  return e;
}

// come replaceChildren, ma salta le parti facoltative assenti (null/undefined/false): altrimenti diventano testo "null"
function fill(box, ...kids) {
  box.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false).map(tr));
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
    for (const m of data.maps) { m.en = m.name; m.name = IT.maps?.[m.name] || m.name; }
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

// Abilità col nome ufficiale italiano del gioco (names_it.json, confronto per posizione tra le pagine ufficiali
// inglesi e italiane): cambia il nome e lo stesso nome dentro i consigli scritti. Senza il file restano il nome
// inglese e la traduzione tra parentesi.
function localizeTheory(raw) {
  if (!raw || raw._localized) return;
  const key = (t) => norm(t).replace(/\s+/g, "");
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const SKIP = new Set(["name", "en", "hero", "targets", "avoidTargets", "sources", "tags", "role"]);
  const swapIn = (x, swaps) => {
    if (typeof x === "string") return swaps.reduce((t, [re, it]) => t.replace(re, it), x);
    if (Array.isArray(x)) return x.map((v) => swapIn(v, swaps));
    if (x && typeof x === "object") for (const k of Object.keys(x)) if (!SKIP.has(k)) x[k] = swapIn(x[k], swaps);
    return x;
  };
  const toRe = (pairs) => pairs.filter(([en, it]) => en !== it).sort((a, b) => b[0].length - a[0].length)
    .map(([en, it]) => [new RegExp(`(^|[^\\w])${esc(en)}(?![\\w])`, "g"), `$1${it}`]);
  // abilità di TUTTI gli eroi (nei consigli di Ana c'è la Dragonblade di Genji): solo i nomi senza ambiguità
  const all = new Map();
  for (const names of Object.values(IT.abilities ?? {})) {
    for (const [en, it] of Object.entries(names)) all.set(en, all.has(en) && all.get(en) !== it ? null : it);
  }
  const global = [...all].filter(([, it]) => it);
  for (const [hero, t] of Object.entries(raw)) {
    if (!t || typeof t !== "object") continue;
    const names = hero.startsWith("_") ? null : IT.abilities?.[hero];
    const own = [];
    if (names && Array.isArray(t.abilities)) {
      const byKey = Object.fromEntries(Object.entries(names).map(([en, it]) => [key(en), it]));
      for (const a of t.abilities) {
        const it = byKey[key(a.name ?? "")];
        if (!it) continue;
        own.push([a.name, it]);
        a.en = a.name;
        a.name = it;
        a.it = null;
      }
      if (t.priority?.ability && byKey[key(t.priority.ability)]) t.priority.ability = byKey[key(t.priority.ability)];
    }
    // prima i nomi dell'eroe stesso (come scritti nella teoria), poi quelli degli altri
    const ownEn = new Set(own.map(([en]) => en));
    swapIn(t, [...toRe(own), ...toRe(global.filter(([en]) => !ownEn.has(en)))]);
  }
  raw._localized = true;
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
  if (guideMode()) return "solo guide e giocatori forti (niente statistiche)";
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
    theory: T, useTheory: !!profile.useTheory, guideOnly: guideMode(),
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

// stima in percentuale; in modalità guide le stelline (1–5) di quell'eroe per quel giocatore (niente numeri delle statistiche)
const est = (r, i) => (r.estimate == null ? `guide ${"★".repeat(choiceStars(i).get(sid(r.hero.id)) ?? 3)}` : `${(r.estimate * 100).toFixed(1)}%`);

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
  // ruolo cambiato da Blizzard ma non ancora da counterwatch (Sombra, Stagione 5): statistiche del vecchio kit
  const fix = (data?.roleFix ?? []).find((f) => f.name === hero.name);
  const statsNote = fix ? el("p", { class: "stale-note", "data-rolefix": "1" },
    `⚠ ${hero.name} ora è ${ROLE_IT[fix.to]} (prima ${ROLE_IT[fix.from]}): counterwatch non si è ancora `
    + "aggiornato e le sue statistiche sono del vecchio kit. Fidati di più della teoria finché non arrivano i dati nuovi.") : null;
  const theoryNote = st.stale ? el("p", { class: "stale-note" }, `⚠ Teoria da rivedere per ${hero.name}: ${st.reasons.join("; ")}. `
    + "Le statistiche sono aggiornate; i consigli di teoria potrebbero non valere più.") : null;
  return statsNote || theoryNote ? el("div", {}, statsNote, theoryNote) : null;
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
// solo eroi GIÀ PRESI: il consiglio fatto a chi non ha ancora scelto non influenza gli altri (richiesta del 2026-10-06)
function partnersOf(i) {
  return match.picked.map((x, j) => (x && j !== i && byId[sid(x)] ? { id: byId[sid(x)].id, name: profile.players[j].name, hero: byId[sid(x)] } : null))
    .filter(Boolean);
}

// Tre livelli, dal più immediato al più approfondito:
// 1. riquadro (colpo d'occhio): prima della scelta la lista dei preferiti col consigliato evidenziato; dopo, l'eroe scelto
//    con chi batte e chi teme (volti) e "Scegline un altro";
// 2. "Come giocarla" (un tocco sull'eroe): riepilogo di poche righe, il resto dei consigli chiuso sotto;
// 3. "Perché" (dalla guida): numeri, statistiche Ranked e teoria completa.

function rowFor(i, hero) {
  return (lastDuo?.lists?.[i] ?? []).find((r) => sid(r.hero.id) === sid(hero.id)) ?? null;
}

function openDetails(i, row) {
  const p = profile.players[i];
  const prof = heroProfile(playerData(i), row.hero.id, Infinity);
  const th = heroTheory(playerData(i), T, row.hero);
  const guide = !!row.guide;
  const sum = guide ? [] : breakdown(row, partnersOf(i));
  // mappe dove le guide lo consigliano o lo sconsigliano (theory.json → _maps)
  const onMaps = (key) => data.maps.flatMap((m) => {
    const t = T?.maps?.[m.slug];
    const x = key === "strong" ? (t?.strong?.[row.hero.role] ?? []).find((y) => y.hero === row.hero.name)
      : (t?.avoid ?? []).find((y) => y.hero === row.hero.name);
    return x ? [{ name: m.name, why: x.why + (x.side ? ` (${x.side === "attack" ? "attacco" : "difesa"})` : "") }] : [];
  });
  $("#t-why").textContent = tr(`Perché ${row.hero.name}`);
  fill($("#why-body"),
    el("div", { class: "why-head" }, face(row.hero),
      el("div", {}, el("div", { class: "pick-name" }, row.hero.name),
        el("div", { class: "muted" }, `per ${p.name} · ${guide ? "valutazione" : "stima"} ${est(row, i)}`),
        el("div", { class: "muted small" }, `dati: ${dataLabel(i)}`))),
    sum.length ? el("p", { class: "why-sum" }, sum.map((b, k) => [k ? " · " : null, el("span", { class: b.good ? "good" : "bad" }, b.text)])) : null,
    el("div", { class: "guide-row" }, el("button", { type: "button", class: "btn guide-btn", onclick: () => openGuide(i, row.hero) },
      icon("target"), "Come giocarla in questa partita")),
    el("h3", { class: "why-title" }, "Perché in questa partita"),
    el("ul", { class: "why-list" }, (guide ? guideDetails(row) : details(row)).map((d) =>
      el("li", { class: `${d.good ? "good" : "bad"}${d.kind === "teoria" ? " is-theory" : ""}` }, d.kind === "teoria" ? [theoryBadge(), " "] : null, d.text))),
    // modalità "solo guide": niente statistiche di counterwatch
    guide ? null : el("h3", { class: "why-title" }, "Statistiche Ranked"),
    guide ? null : el("div", { class: "prof-grid" },
      profileSection("Forte contro", prof.strongVs, "hero"),
      profileSection("In difficoltà contro", prof.weakVs, "hero"),
      profileSection("Mappe migliori", prof.bestMaps, "map"),
      profileSection("Funziona bene con", prof.bestWith, "hero")),
    el("h3", { class: "why-title theory-title" }, theoryBadge(), " Come si incastra (guide e siti di Overwatch)"),
    staleBanner(row.hero),
    th.style ? el("p", { class: "theory-style" },
      el("b", {}, `Stile ${STYLE_IT[th.style]}`), `: ${STYLE_DESC[th.style]} (classificazione di counterwatch).`) : null,
    el("div", { class: "prof-grid theory-grid" },
      onMaps("strong").length ? theorySection("Consigliato dalle guide su", onMaps("strong")) : null,
      onMaps("avoid").length ? theorySection("Sconsigliato su", onMaps("avoid")) : null,
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
  $("#why-dialog").scrollTop = 0;
}

const BRIEF_ICON = { swap: "swap", target: "target", threat: "warn", ability: "bolt", position: "move", protect: "shield", map: "map",
  combo: "plus", ult: "bolt" };
// volto + nome, per le righe del riepilogo che parlano di eroi
const heroChip = (h) => el("span", { class: "hchip" }, face(h), h.name);

// ogni riga: icona tonda, etichetta (con "teoria"/"dati"), testo breve o volti degli eroi
function briefList(items) {
  return el("ul", { class: "brief" }, items.map((it) => el("li", {
    class: `brief-row k-${it.key} ${it.kind === "teoria" ? "is-theory" : "is-data"}`,
    "aria-label": `${it.text} (${it.kind === "teoria" ? "teoria" : "dati"})`,
  },
  el("span", { class: "brief-ico", "aria-hidden": "true" }, icon(BRIEF_ICON[it.key] ?? "list")),
  el("span", { class: "brief-body", "aria-hidden": "true" },
    el("span", { class: "brief-lab" }, it.label),
    el("span", { class: "brief-txt" },
      it.heroes?.length ? it.heroes.map(heroChip) : null,
      it.short ? el("span", { class: it.heroes?.length ? "brief-after" : null }, it.short) : it.heroes?.length ? null : it.text)))));
}

function openGuide(i, hero) {
  const p = profile.players[i];
  const rows = lastDuo?.lists?.[i] ?? null;
  const g = playGuide(playerData(i), T, {
    hero, mapSlug: match.mapSlug, side: match.side, enemies: match.enemies, allies: match.allies,
    partners: partnersOf(i).map((x) => x.hero).filter((h) => sid(h.id) !== sid(hero.id)),
    rows, guide: guideMode(),
  });
  const brief = g.sections.find((s) => s.summary);
  const rest = g.sections.filter((s) => !s.summary);
  const isPicked = !!match.picked[i] && sid(match.picked[i]) === sid(hero.id);
  const row = rowFor(i, hero);
  $("#t-guide").textContent = tr(`Come giocare ${hero.name}`);
  fill($("#guide-body"),
    el("div", { class: "why-head" }, face(hero),
      el("div", {}, el("div", { class: "pick-name" }, hero.name),
        el("div", { class: "muted small" }, `${p.name} · ${currentMap()?.name ?? "nessuna mappa"}` +
          `${match.side ? ` · ${match.side === "attack" ? "attacco" : "difesa"}` : ""} · ${match.enemies.length} avversari`))),
    el("div", { class: "guide-actions", style: `--pc: var(--p${i})` },
      el("button", {
        type: "button", class: "took-btn", "aria-pressed": String(isPicked),
        onclick: () => { togglePicked(i, hero); openGuide(i, hero); },
      }, icon("check"), isPicked ? `Scelto da ${p.name}` : `Segna: ${p.name} l'ha scelto`)),
    staleBanner(hero),
    brief ? el("section", { class: "guide-sec guide-summary" },
      el("h3", {}, "In breve", el("span", { class: "legend", "aria-hidden": "true" },
        el("span", { class: "dot theory" }), "teoria", el("span", { class: "dot data" }), "dati")),
      briefList(brief.items)) : null,
    el("div", { class: "guide-btns" },
      rest.length ? el("button", {
        type: "button", class: "btn more-btn", "aria-expanded": "false", "aria-controls": "guide-more",
        onclick: (e) => {
          const b = e.currentTarget, open = b.getAttribute("aria-expanded") !== "true";
          b.setAttribute("aria-expanded", String(open));
          $("#guide-more").hidden = !open;
          if (open) $("#guide-more").scrollIntoView({ block: "start", behavior: "smooth" });
        },
      }, icon("list"), "Tutti i consigli") : null,
      row ? el("button", { type: "button", class: "btn why-btn", onclick: () => openDetails(i, row) }, icon("chart"), "Perché?") : null),
    rest.length ? el("div", { id: "guide-more", class: "guide-more", hidden: true },
      rest.map((sec) => el("section", { class: "guide-sec" },
        el("h3", {}, sec.title),
        el("ul", {}, sec.items.map((it) => el("li", {},
          el("span", { class: it.kind === "teoria" ? "theory-badge" : "data-badge" }, it.kind === "teoria" ? "Teoria" : "Dati"), " ", it.text)))))) : null,
    g.uncertain ? el("p", { class: "muted small theory-note" }, "Per questo eroe le fonti sono poche: i consigli di teoria sono parziali.") : null,
    el("p", { class: "muted small foot-note" }, "Consigli da guide e siti di Overwatch e da statistiche Ranked di counterwatch: aiuti, non certezze."),
  );
  if ($("#why-dialog").open) $("#why-dialog").close();
  if (!$("#guide-dialog").open) $("#guide-dialog").showModal();
  $("#guide-dialog").scrollTop = 0;
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
      "aria-label": `${p.name}: ${r.picked ? `ha scelto ${r.hero.name}, ${guideMode() ? "valutazione" : "stima"} ${est(r, i)}` : `consigliato ${r.hero.name}, ancora da scegliere`}. Tocca per come giocarla` },
    face(r.hero), el("span", { class: "mini-txt" }, el("b", {}, r.hero.name),
      el("small", {}, r.picked ? `✓ ${p.name} · ${est(r, i)}` : `${p.name} · consigliato`))));
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

// Con gli avversari segnati: volti piccoli di chi l'eroe batte (bordo verde) e di chi teme (bordo rosso), senza
// scritte (come «Batte/Teme» del riquadro). Restituisce i nodi e il testo per i lettori di schermo.
function miniMatchups(r) {
  const m = match.enemies.length && r ? matchups(r) : { strong: [], weak: [] };
  const names = (xs) => xs.map((x) => x.hero.name).join(", ");
  const mini = (cls, xs) => (xs.length ? el("span", { class: `alt-mu ${cls}`, "aria-hidden": "true" }, xs.map((x) => face(x.hero))) : null);
  return {
    nodes: [mini("good", m.strong), mini("bad", m.weak)].filter(Boolean),
    label: `${m.strong.length ? `, batte ${names(m.strong)}` : ""}${m.weak.length ? `, teme ${names(m.weak)}` : ""}`,
  };
}
const starsTxt = (n) => "★".repeat(n);
const starsLabel = (n) => `${n} stell${n > 1 ? "e" : "a"} su 5`;

// Eroi che il giocatore i può ancora prendere: non bannati, non presi da un compagno (giocatore o alleato segnato).
function takenBy(i) {
  return new Set([...match.picked.filter((x, j) => x && j !== i), ...match.allies, ...match.bans].map(sid));
}
// Preferiti del giocatore i per quel ruolo (tutti, se il ruolo è libero), dal più adatto a questa partita.
function favoritesFor(i, role) {
  const rows = choiceRows(i);
  const off = takenBy(i);
  return [...new Set(profile.players[i].favorites.map(sid))]
    .filter((id) => rows.has(id) && !off.has(id) && (!role || byId[id].role === role))
    .sort((a, b) => rows.get(b).score - rows.get(a).score || byId[a].name.localeCompare(byId[b].name));
}

// "scegli": l'eroe preso da quel giocatore (dalla lista dei preferiti, da "Scegline un altro" o dal foglio "＋")
function choose(i, id) {
  const was = match.picked[i] ? sid(match.picked[i]) : null;
  setPicked(i, id);
  saveMatch();
  render();
  toast(`${profile.players[i].name} ha scelto ${byId[id].name} ✓`, 2500, {
    label: "Annulla",
    run: () => { if (was) setPicked(i, was); else match.picked[i] = null; saveMatch(); render(); },
  });
}

// Una riga della lista dei preferiti: volto, nome, stelline bianche (1–5) e chi batte/teme. Un tocco = scelto.
// rec: etichetta del consigliato (evidenziato); tag: {text, color} es. "per Lei" (consigliato a un compagno).
function favRow(i, id, { rec = null, note = null, tag = null, after = null } = {}) {
  const h = byId[id];
  const r = choiceRows(i).get(id);
  const n = choiceStars(i).get(id) ?? 3;
  const mu = miniMatchups(r);
  return el("button", {
    type: "button", class: `fav-row${rec ? " is-rec" : ""}`, "data-id": id,
    onclick: () => { choose(i, id); if (after) after(); },
    "aria-label": `${rec ? `${rec}: ` : ""}${h.name}, ${starsLabel(n)}${mu.label}${tag ? `, ${tag.text}` : ""}. Tocca per sceglierlo`,
  },
  face(h),
  el("span", { class: "fr-body", "aria-hidden": "true" },
    rec ? el("span", { class: "fr-tag" }, rec) : tag ? el("span", { class: "fr-tag other", style: `color: ${tag.color}` }, tag.text) : null,
    el("span", { class: "fr-name" }, h.name),
    el("span", { class: "fr-stars" }, starsTxt(n)),
    note ? el("span", { class: "fr-note" }, note) : null,
    mu.nodes.length ? el("span", { class: "fr-mu" }, mu.nodes) : null));
}

// "Scegline un altro" (dopo la scelta): volto con stelline bianche e, sotto, chi batte e chi teme. Un tocco = scelto.
function altButton(i, id) {
  const h = byId[id];
  const n = choiceStars(i).get(id) ?? 3;
  const mu = miniMatchups(choiceRows(i).get(id));
  return el("button", {
    type: "button", class: "alt", "data-id": id, onclick: () => choose(i, id),
    "aria-label": `Scegli invece ${h.name}, ${starsLabel(n)}${mu.label}`,
  },
  el("span", { class: "alt-face" }, face(h), el("span", { class: "alt-stars", "aria-hidden": "true" }, starsTxt(n))),
  mu.nodes);
}

// Foglio "＋": tutti i preferiti del giocatore (prima quelli del ruolo), dal più adatto, e un eroe qualsiasi dalla griglia.
function openChooser(i) {
  const p = profile.players[i];
  const cur = match.picked[i] ? sid(match.picked[i]) : null;
  const role = cur ? byId[cur].role : match.roles[i];
  const close = () => $("#choose-dialog").close();
  const mine = favoritesFor(i, role);
  const otherRoles = favoritesFor(i, null).filter((id) => !mine.includes(id));
  const fallback = mine.length || otherRoles.length ? [] : (lastDuo?.lists?.[i] ?? []).map((r) => sid(r.hero.id))
    .filter((id) => !takenBy(i).has(id)).slice(0, 8);
  const row = (id) => (id === cur
    ? favRow(i, id, { rec: "Scelto", after: close })
    : favRow(i, id, { after: close }));
  $("#t-choose").textContent = `Scegli l'eroe di ${p.name}`;
  fill($("#choose-body"),
    el("p", { class: "muted small choose-sub" }, mine.length || otherRoles.length
      ? "I tuoi preferiti, dal più adatto a questa partita. Un tocco per sceglierlo."
      : "Nessun preferito nel Profilo: i più adatti per il ruolo."),
    mine.length || fallback.length ? el("div", { class: "fav-list" }, [...mine, ...fallback].map(row)) : null,
    otherRoles.length ? el("h3", { class: "choose-h" }, "Altri ruoli") : null,
    otherRoles.length ? el("div", { class: "fav-list" }, otherRoles.map(row)) : null,
    el("button", {
      type: "button", class: "btn choose-grid", onclick: () => { close(); choosePicker(i); },
    }, icon("grid"), "Un altro eroe: toccalo nella griglia"));
  if (!$("#choose-dialog").open) $("#choose-dialog").showModal();
  $("#choose-dialog").scrollTop = 0;
}

// Riquadro del giocatore, in due momenti:
// - prima della scelta: SOLO la lista dei suoi preferiti (del ruolo), dal più adatto, con il consigliato evidenziato
//   (in cima; se non è tra i preferiti lo si dice). Un tocco su una riga = scelto. Nessun eroe sembra già preso.
// - dopo la scelta: il riquadro dedicato a quell'eroe (volto grande, stima, Come giocarla, Batte/Teme, "Passa a") e sotto
//   "Scegline un altro" con gli altri preferiti (quelli che ci stanno) e "＋" per il foglio con tutti.
const MAX_ROWS = 4;
function pickCard(p, i) {
  const rows = lastDuo.lists[i] ?? [];
  const top = rows[0];
  const took = !!top?.picked;
  const role = took ? top.hero.role : match.roles[i];
  const style = `--pc: var(--p${i}); --pca: var(--p${i}a)`;
  const head = el("div", { class: "pick-head" },
    el("span", { class: "pick-player", title: dataLabel(i) }, p.name),
    took ? el("button", {
      type: "button", class: "chosen-chip", onclick: () => togglePicked(i, top.hero),
      "aria-label": `${p.name} ha scelto ${top.hero.name}: tocca per annullare la scelta`,
    }, icon("check"), "Scelto", icon("xmark", "ic chip-x"))
      : el("button", {
        type: "button", class: "role-btn",
        "aria-label": `Ruolo di ${p.name}: ${role ? ROLE_IT[role] : "qualsiasi"}. Tocca per cambiare`,
        onclick: () => nextRole(i),
      }, role ? ROLE_IT[role] : "Qualsiasi"));
  if (!top) return el("article", { class: "pick empty", style }, head, el("p", { class: "pick-why" }, "Nessun eroe disponibile"));
  const note = lastDuo.notes?.[i];
  const noteEl = note ? el("div", { class: "pick-note warn-note" }, note) : null;
  const favs = favoritesFor(i, role);
  const favSet = new Set(p.favorites.map(sid));

  if (!took) {
    const recId = sid(top.hero.id);
    const pool = favs.length ? favs : rows.map((r) => sid(r.hero.id)).filter((id) => !takenBy(i).has(id));
    const list = [recId, ...pool.filter((id) => id !== recId)];
    const shown = list.slice(0, MAX_ROWS);
    const more = favs.length ? list.length - shown.length : 0; // preferiti che non ci stanno (senza preferiti: "Altri eroi")
    // eroi consigliati a un compagno (non ancora presi): si possono scegliere, ma lo si segnala
    const forMate = new Map((lastDuo.team ?? []).map((h, j) => (h && j !== i && !match.picked[j] ? [sid(h.id), j] : null)).filter(Boolean));
    const why = match.enemies.length ? null : headline(top, partnersOf(i));
    return el("article", { class: "pick glass choosing", style, "aria-label": `${p.name}: da scegliere` },
      head, noteEl,
      el("p", { class: "pick-ask" }, favs.length ? "Scegli tra i preferiti" : `Nessun preferito${role ? ` ${ROLE_IT[role]}` : ""}: i più adatti`),
      el("div", { class: "fav-list" }, shown.map((id) => (id === recId
        // il consigliato, evidenziato, con "Come giocarla" (anche prima di sceglierlo)
        ? el("div", { class: "rec-box" },
          favRow(i, id, {
            rec: `Consigliato${top.estimate != null ? ` · ${est(top, i)}` : ""}`,
            note: [favs.length && !favSet.has(id) ? "Non è tra i preferiti" : null, why].filter(Boolean).join(" · ") || null,
          }),
          el("button", {
            type: "button", class: "pick-cta rec-cta", onclick: () => openGuide(i, top.hero),
            "aria-label": `Come giocare ${top.hero.name} in questa partita`,
          }, icon("target"), "Come giocarla", icon("chevron", "ic chev")))
        : favRow(i, id, forMate.has(id) ? { tag: { text: `per ${profile.players[forMate.get(id)].name}`, color: `var(--p${forMate.get(id)})` } } : {})))),
      el("button", {
        type: "button", class: "fav-more",
        onclick: () => (more || !favs.length ? openChooser(i) : choosePicker(i)),
        "aria-label": more ? `Altri ${more} preferiti di ${p.name}` : favs.length ? `${p.name} ha preso un altro eroe: toccalo nella griglia`
          : `Altri eroi per ${p.name}`,
      }, icon("plus"), more ? `${more} ${more === 1 ? "altro" : "altri"}` : favs.length ? "Un altro eroe" : "Altri eroi"));
  }

  const sw = swapAdvice(playerData(i), T, { hero: top.hero, rows, enemies: match.enemies, guide: guideMode() });
  const chosen = sid(top.hero.id);
  const others = (favs.length ? favs : rows.slice(1).map((r) => sid(r.hero.id))).filter((id) => id !== chosen && !takenBy(i).has(id));
  // stelline bianche anche sull'eroe scelto e su "Passa a" (richiesta del 2026-10-06), le stesse della lista
  const nStars = (id) => choiceStars(i).get(id) ?? 3;
  return el("article", { class: "pick glass took", style, "aria-label": `${p.name} ha scelto ${top.hero.name}` },
    head, noteEl,
    // eroe grande con alone nel colore del giocatore: un tocco → Come giocarla
    el("button", {
      type: "button", class: "pick-main", onclick: () => openGuide(i, top.hero),
      "aria-label": `${p.name} ha scelto ${top.hero.name}, ${starsLabel(nStars(chosen))}`
        + `${top.estimate == null ? "" : `, stima ${est(top, i)}`}. Tocca per come giocarla`,
    },
    el("span", { class: "halo" }, face(top.hero)),
    el("span", { class: "pick-name" }, top.hero.name),
    el("span", { class: "pick-stars", "aria-hidden": "true" }, starsTxt(nStars(chosen))),
    // in "solo guide" la valutazione è già nelle stelline: niente pillola
    top.estimate == null ? null : el("span", { class: "pick-est" }, est(top, i)),
    el("span", { class: "pick-cta" }, icon("target"), "Come giocarla", icon("chevron", "ic chev"))),
    match.enemies.length ? matchupRow(top) : null,
    sw ? el("button", {
      type: "button", class: "swap", onclick: () => openGuide(i, sw.hero),
      "aria-label": `Meglio passare a ${sw.hero.name}, ${starsLabel(nStars(sid(sw.hero.id)))}: ${sw.why}. Tocca per come giocarla`,
    }, el("span", { class: "swap-lab" }, icon("swap"), "Passa a"), el("span", { class: "swap-hero" }, face(sw.hero),
      el("span", { class: "swap-txt" }, el("b", {}, sw.hero.name),
        el("span", { class: "swap-stars", "aria-hidden": "true" }, starsTxt(nStars(sid(sw.hero.id))))))) : null,
    el("div", { class: "others" },
      el("span", { class: "others-lab" }, "Scegline un altro"),
      el("div", { class: "alts" },
        others.map((id) => altButton(i, id)),
        el("button", {
          type: "button", class: "alt alt-other", onclick: () => openChooser(i),
          "aria-label": `Tutti i preferiti di ${p.name}`,
        }, icon("plus")))));
}

// "Scegline un altro": restano i volti che ci stanno in una riga (il "＋" sempre); gli altri sono nel foglio
function fitAlts(box) {
  for (const row of $$(".others .alts", box)) {
    const items = $$(".alt:not(.alt-other)", row);
    for (const b of items) b.hidden = false;
    const plus = $(".alt-other", row);
    const room = row.clientWidth;
    if (!room) continue;
    const w = (b) => b.getBoundingClientRect().width + 4; // + margini
    let used = plus ? w(plus) : 0;
    for (const b of items) {
      used += w(b);
      if (used > room + 0.5) b.hidden = true;
    }
  }
}

function renderPicks() {
  const box = $("#picks");
  box.replaceChildren();
  if (!data) return;
  lastDuo = compute();
  starCache = new Map();
  box.className = `picks n${profile.players.length}`;
  profile.players.forEach((p, i) => box.append(pickCard(p, i)));
  for (const t of $$(".pick-name, .fr-name", box)) fitText(t);
  fitAlts(box);
  renderMini();
  updateMini();
}

// ---------- ban consigliati (inizio partita) ----------
// Con la mappa scelta, prima di segnare gli avversari o col selettore su "Ban": 3 per ruolo (banSuggestions), eroi forti su quella mappa e
// contro i vostri (già scelti o alleati segnati). Si propongono anche i preferiti; mai gli eroi già scelti né gli alleati
// (un ban vale per tutte e due le squadre). L'elenco non cambia mentre si segnano i ban: si vedono barrati.
// punteggi dei ban (stesso calcolo per il riquadro e per le stelline della griglia): {Tank: [righe ordinate], …}
// "Vostri eroi" = solo quelli GIÀ SCELTI e gli alleati segnati (richiesta del 2026-10-06): senza scelte i ban dipendono
// dalla mappa (e dal lato), mai dagli eroi solo consigliati.
const ourHeroes = () => [...new Set([...match.picked.filter(Boolean), ...match.allies].map(sid))];
function banScores(perRole) {
  const guide = guideMode();
  const opts = {
    mapSlug: match.mapSlug, side: match.side, perRole,
    ours: ourHeroes(),
    // si possono proporre anche i preferiti (richiesta del 2026-10-06): niente ban solo per eroi già scelti e alleati
    keep: [...match.picked.filter(Boolean), ...match.allies],
  };
  const sets = [...new Set(profile.players.map((p, i) => playerData(i)))];
  return guide ? guideBanSuggestions(data, T, opts)
    : profile.useTheory && T ? blendedBanSuggestions(sets, T, opts) : banSuggestions(sets, opts);
}

// ---------- chi soffrite di più (selettore su "Avversari") ----------
// I 3 eroi per ruolo più pericolosi per voi (le stelline rosse: threatScores), e accanto i vostri eroi — scelti e
// alleati segnati — col bordo verde se li battono, rosso se li temono, niente se alla pari. Senza eroi scelti né
// alleati il riquadro non c'è. Un tocco li segna come avversari.
const THREATS_PER_ROLE = 3;
// vostra squadra per "Chi soffrite di più": solo eroi presi e alleati segnati, mai i consigliati
function ourComp() {
  const heroes = profile.players.map((p, i) => {
    const id = match.picked[i];
    return id != null && byId[sid(id)] ? { hero: byId[sid(id)], i } : null;
  }).filter(Boolean);
  for (const a of match.allies) if (byId[sid(a)]) heroes.push({ hero: byId[sid(a)], i: -1 });
  return heroes;
}
function renderThreats() {
  const box = $("#threats");
  // solo su "Avversari" e solo se c'è una squadra da confrontare (richiesta del 2026-10-06)
  const comp = data && match.group === "enemies" ? ourComp() : [];
  box.hidden = !comp.length;
  if (box.hidden) return;
  const map = currentMap();
  const sets = [...new Set(profile.players.map((p, i) => playerData(i)))];
  const banned = new Set(match.bans.map(sid));
  const rows = threatScores(sets, T, {
    mapSlug: match.mapSlug, side: match.side, ours: match.picked.filter(Boolean), mates: match.allies, mode: starMode(),
  });
  const st = rankStars(rows, starOpts());
  const enemies = new Set(match.enemies.map(sid));
  $("#threats-sub").textContent = `${map ? `I più pericolosi su ${map.name}` : "I più pericolosi"}. Accanto, i vostri eroi:`
    + " verde = li battono, rosso = li temono.";
  fill($("#threats-list"), BAN_ROLES.map((role) => el("div", { class: "br-role" },
    el("span", { class: `br-role-lab r-${role}` }, ROLE_IT[role]),
    el("div", { class: "br-heroes" }, rows.filter((r) => r.hero.role === role && !banned.has(sid(r.hero.id)))
      .sort((a, b) => b.score - a.score).slice(0, THREATS_PER_ROLE).map((r) => {
        const id = sid(r.hero.id);
        const n = st.get(id) ?? 3;
        const vs = comp.map((c) => ({ ...c, s: matchupSign(c.i >= 0 ? playerData(c.i) : data, T, c.hero, r.hero, { guide: guideMode() }) }))
          .filter((c) => c.s !== 0);
        const names = (s) => vs.filter((c) => c.s === s).map((c) => c.hero.name).join(", ");
        return el("button", {
          type: "button", class: `hero threat${enemies.has(id) ? " in-enemies" : ""}`, "data-id": id, "data-stars": String(n),
          "aria-pressed": String(enemies.has(id)), onclick: () => toggleIn("enemies", id),
          "aria-label": `${r.hero.name}, pericolo ${starsLabel(n)}${names(1) ? `; lo battono ${names(1)}` : ""}${names(-1) ? `; lo temono ${names(-1)}` : ""}. Tocca per segnarlo avversario`,
        }, face(r.hero), el("span", { class: "stars st-enemies", "aria-hidden": "true" }, starsTxt(n)),
        el("span", { class: `nm${heroName(r.hero).length >= 10 ? " long" : ""}` }, heroName(r.hero)),
        vs.length ? el("span", { class: "th-ours", "aria-hidden": "true" }, vs.map((c) => el("span", { class: `th-o ${c.s > 0 ? "good" : "bad"}` }, face(c.hero)))) : null);
      })))));
  delete box.dataset.fitW;
  fitNames(box);
}

function renderBanRecs() {
  const box = $("#ban-recs");
  const map = currentMap();
  // solo col selettore su "Ban" (richiesta del 2026-10-06), sotto il selettore; senza mappa sui dati generali
  const show = !!data && match.group === "bans";
  box.hidden = !show;
  if (!show) return;
  const guide = guideMode();
  const rec = banScores(BANS_PER_ROLE);
  // "contro i vostri eroi" solo se ce ne sono (scelti o alleati segnati)
  const vs = ourHeroes().length ? " e contro i vostri eroi" : "";
  const place = map ? "su questa mappa" : "in generale";
  $(".br-sub", box).textContent = guide ? `Forti ${place} per guide e giocatori forti${vs}`
    : profile.useTheory && T ? `Forti ${place}${vs} (statistiche e guide)` : `Forti ${place}${vs}`;
  const banned = new Set(match.bans.map(sid));
  $("#t-ban-recs").textContent = map ? `Ban consigliati per ${map.name}` : "Ban consigliati";
  const bst = banStars();
  fill($("#ban-recs-list"), BAN_ROLES.map((role) => el("div", { class: "br-role" },
    el("span", { class: `br-role-lab r-${role}` }, ROLE_IT[role]),
    el("div", { class: "br-heroes" }, rec[role].map((r) => {
      const id = sid(r.hero.id);
      const on = banned.has(id);
      const where = map ? `su ${map.name}` : "in generale";
      const why = r.why ?? ([r.strength >= 0.003 ? `forte ${where}` : null,
        r.beats.length ? `batte ${r.beats.map((h) => h.name).join(" e ")}` : null].filter(Boolean).join(", ") || `tra i migliori ${where}`);
      const n = bst.get(id) ?? 3;
      return el("button", {
        type: "button", class: `hero${on ? " in-bans" : ""}`, "data-id": id, "data-stars": String(n), "aria-pressed": String(on), title: why,
        "aria-label": `${on ? "Bannato" : "Banna"} ${r.hero.name}: ${why}, da bannare ${starsLabel(n)}`, onclick: () => toggleIn("bans", id),
      }, face(r.hero), el("span", { class: "stars st-bans", "aria-hidden": "true" }, starsTxt(n)),
      el("span", { class: `nm${heroName(r.hero).length >= 10 ? " long" : ""}` }, heroName(r.hero)));
    })))));
  fitBanRecs();
}
function fitBanRecs() {
  const box = $("#ban-recs");
  if (box.hidden) return;
  delete box.dataset.fitW;
  fitNames(box);
}

// ---------- mappa e lato ----------

function currentMap() {
  return data?.maps.find((m) => m.slug === match.mapSlug) ?? null;
}

function renderControls() {
  const map = currentMap();
  $("#map-btn").classList.toggle("empty", !map);
  fill($("#map-name"), map ? [map.name, el("span", { class: "map-mode" }, ` · ${MODE_IT[map.mode] ?? map.mode}`)] : "Scegli mappa");
  const side = $("#side");
  side.hidden = !hasSides(map);
  $$("button", side).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.side === match.side)));
}

function buildMapDialog() {
  const list = $("#map-list");
  list.replaceChildren();
  list.append(el("div", { class: "maps", "data-block": "none" },
    el("button", { type: "button", class: "map-opt none", "data-map": "", "data-q": searchKeys(["nessuna", "dati generali"]),
      "aria-pressed": String(!match.mapSlug) }, "Nessuna mappa (dati generali)")));
  for (const [mode, label] of MODES) {
    const maps = data.maps.filter((m) => m.mode === mode).sort((a, b) => a.name.localeCompare(b.name));
    if (!maps.length) continue;
    list.append(el("div", { "data-block": mode },
      el("h3", { class: "mode-title" }, label + (hasSides({ mode }) ? " · attacco/difesa" : "")),
      el("div", { class: "maps" }, maps.map((m) =>
        el("button", { type: "button", class: "map-opt", "data-map": m.slug, "data-q": searchKeys([m.en, m.name, label]),
          "aria-pressed": String(m.slug === match.mapSlug) }, m.name)))));
  }
}

// ---------- ricerca (eroi e mappe) ----------
// Senza accenti né simboli e anche per iniziali: "lucio" trova Lúcio, "soldier76" Soldier: 76, "jq" Junker Queen.
// Cerca sia il nome inglese (quello di counterwatch) sia quello italiano del gioco, se diverso.
const norm = (t) => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
function searchKeys(names) {
  const keys = new Set();
  for (const n of names.filter(Boolean)) {
    const words = norm(n).split(/\s+/).filter(Boolean);
    keys.add(words.join(""));
    for (const w of words) keys.add(w);
    if (words.length > 1) keys.add(words.map((w) => w[0]).join(""));
  }
  return [...keys].join("|");
}
function applySearch(input) {
  const target = document.getElementById(input.getAttribute("aria-controls"));
  if (!target) return;
  const q = norm(input.value).replace(/\s+/g, "");
  let shown = 0;
  for (const item of target.querySelectorAll("[data-q]")) {
    const ok = !q || item.dataset.q.split("|").some((k) => k.includes(q));
    item.hidden = !ok;
    if (ok) shown++;
  }
  // titoli di ruolo o modalità senza risultati: via anche loro
  for (const block of target.querySelectorAll("[data-block]")) block.hidden = !block.querySelector("[data-q]:not([hidden])");
  const none = document.querySelector(`[data-none="${target.id}"]`);
  if (none) none.hidden = shown > 0;
  const clear = input.parentElement.querySelector(".search-clear");
  if (clear) clear.hidden = !input.value;
}
function resetSearch(id) {
  const input = document.getElementById(id);
  if (!input || !input.value) return;
  input.value = "";
  applySearch(input);
}
// dopo un tocco su un risultato: campo vuoto ma tastiera ancora aperta, pronto per il prossimo eroe
function afterSearchTap(id) {
  const input = document.getElementById(id);
  if (input && input.value) { input.value = ""; applySearch(input); }
}
function wireSearch(id) {
  const input = document.getElementById(id);
  const target = document.getElementById(input.getAttribute("aria-controls"));
  input.addEventListener("input", () => applySearch(input));
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const first = target.querySelector(".hero:not([hidden]), .map-opt:not([hidden])");
    if (first && input.value) { e.preventDefault(); first.click(); }
  });
  // toccando un risultato la tastiera resta aperta (il campo non perde il fuoco)
  target.addEventListener("mousedown", (e) => { if (document.activeElement === input && e.target.closest("[data-q]")) e.preventDefault(); });
  input.parentElement.querySelector(".search-clear")?.addEventListener("click", () => { input.value = ""; applySearch(input); input.focus(); });
}

// ---------- griglia eroi ----------

function buildHeroGrid(container, onTap) {
  container.replaceChildren();
  delete container.dataset.fitW;
  for (const [role, label] of ROLES) {
    const heroes = data.heroes.filter((h) => h.role === role).sort((a, b) => heroName(a).localeCompare(heroName(b)));
    container.append(el("div", { "data-block": role },
      el("h2", { class: `role-title r-${role}` }, label),
      el("div", { class: "grid" }, heroes.map((h) =>
        el("button", { type: "button", class: "hero", "data-id": sid(h.id), "data-q": searchKeys([h.name, heroName(h)]), "aria-pressed": "false",
          onclick: () => onTap(sid(h.id)) },
        face(h), el("span", { class: `nm${heroName(h).length >= 10 ? " long" : ""}` }, heroName(h)))))));
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

// Regole di Overwatch 2: un ban vale per tutte e due le squadre; nella vostra squadra (eroi presi + alleati) un eroe
// c'è una volta sola; gli avversari possono avere gli STESSI eroi vostri (mirror). Quindi un eroe può essere insieme
// vostro e avversario, mai bannato e giocato.
const inGroup = (g, id) => match[g].some((x) => sid(x) === id);
const groupsOf = (id) => Object.keys(LIMITS).filter((g) => inGroup(g, id));
const OUR_SIDE = ["allies"]; // con match.picked: la vostra squadra
const pickerOf = (id) => match.picked.findIndex((x) => x && sid(x) === id);

function tapHero(id) {
  if (match.group === "picked") { tapPicked(id); return; }
  toggleIn(match.group, id);
}

// un tocco mette l'eroe nel gruppo (ban, avversari, alleati) o ve lo toglie
const dropFrom = (g, id) => { match[g] = match[g].filter((x) => sid(x) !== id); };
function toggleIn(g, id) {
  if (inGroup(g, id)) {
    dropFrom(g, id);
  } else {
    if (match[g].length >= limitOf(g)) {
      toast(g === "allies" && !limitOf(g) ? `Siete già in ${MAX_PLAYERS}: segnate gli eroi presi nei vostri riquadri.`
        : `Al massimo ${limitOf(g)} ${GROUP_WORD[g]}: togline uno toccandolo.`);
      return;
    }
    // ban: esce da tutto; alleato: esce dai ban e dagli eroi presi (nella vostra squadra una volta sola);
    // avversario: esce solo dai ban (può essere anche vostro: mirror)
    const off = g === "bans" ? ["enemies", ...OUR_SIDE] : ["bans"];
    for (const o of off) dropFrom(o, id);
    if (g !== "enemies") {
      const who = pickerOf(id);
      if (who >= 0) match.picked[who] = null;
    }
    match[g] = [...match[g], id];
  }
  saveMatch();
  render();
}

// Eroe scelto da un giocatore: un tocco su una riga della lista dei preferiti, su "Scegline un altro", nel foglio "＋",
// nella guida ("Segna: X l'ha scelto") o nella griglia ("Un altro eroe"). Un eroe scelto esce dai ban e dagli alleati
// (e da un altro giocatore), NON dagli avversari: anche loro possono averlo (mirror).
function setPicked(i, id) {
  const who = pickerOf(id);
  if (who >= 0) match.picked[who] = null;
  for (const g of ["bans", ...OUR_SIDE]) dropFrom(g, id);
  match.picked[i] = id;
}

function togglePicked(i, hero) {
  const id = sid(hero.id);
  const was = !!match.picked[i] && sid(match.picked[i]) === id;
  if (was) match.picked[i] = null;
  else setPicked(i, id);
  saveMatch();
  render();
  toast(was ? `${profile.players[i].name}: scelta di ${hero.name} annullata` : `${profile.players[i].name} ha scelto ${hero.name} ✓`, 1800);
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
  toast(`${profile.players[i].name} ha scelto ${byId[id].name} ✓`, 2000);
}

// ---------- stelline (1–5) ----------
// In tutta l'app da 1 a 5, ruolo per ruolo (rankStars), mai un eroe senza stelle. Cambiano con ogni scelta (mappa,
// lato, ban, avversari, alleati, eroi presi) e seguono la modalità del Profilo (statistiche, + teoria, solo guide).
// Griglia, secondo il selettore:
//   Avversari (rosse) = quanto è pericoloso quel nemico: forte sulla mappa dal suo lato + quanto batte la vostra squadra,
//     soprattutto i vostri eroi (threatScores); Ban (bianche) = stesso calcolo dei ban consigliati (i vostri eroi,
//     eroi già scelti e alleati non si bannano: 1 stella); Alleati / eroe preso da un giocatore (dorate o col colore del
//     giocatore) = quanto è una buona scelta per voi. Riquadri dei giocatori: stelline bianche, stessa "buona scelta".
const STAR_WHAT = { enemies: "pericolo", bans: "da bannare", allies: "buona scelta", picked: "buona scelta" };
const starMode = () => (guideMode() ? "guide" : profile.useTheory && T ? "blend" : "stat");
const starOpts = (extra = {}) => ({ minSd: STAR_MIN_SD[starMode()], ...extra });
let starCache = new Map(); // calcoli di questo giro: si svuota a ogni nuovo consiglio (renderPicks)
// stelline dei ban (griglia e riquadro "Ban consigliati"): quanto conviene bannarlo, 1–5 dal punteggio vero (anche tra i
// consigliati si vede chi è più urgente); eroi già scelti e alleati: 1 = non bannarlo
function banStars() {
  if (!starCache.has("bans")) {
    const rec = banScores(999);
    const st = rankStars(BAN_ROLES.flatMap((r) => rec[r]), starOpts());
    for (const h of data.heroes) if (!st.has(sid(h.id))) st.set(sid(h.id), 1);
    starCache.set("bans", st);
  }
  return starCache.get("bans");
}
function gridStars() {
  const g = match.group;
  if (g === "bans") return banStars();
  if (g === "enemies") {
    const sets = [...new Set(profile.players.map((p, i) => playerData(i)))];
    return rankStars(threatScores(sets, T, {
      mapSlug: match.mapSlug, side: match.side, ours: match.picked.filter(Boolean), mates: match.allies, mode: starMode(),
    }), starOpts());
  }
  return choiceStars(g === "picked" ? match.pickFor : -1);
}
// quanto ogni eroe (tutti, anche bannati o già presi) è una buona scelta per il giocatore i (-1 = per la squadra): gli
// eroi GIÀ PRESI dagli altri contano come alleati (non i loro consigli). Righe di recommend() per id; usate da griglia, riquadri e foglio "＋".
function choiceRows(i) {
  const key = `rows${i}`;
  if (!starCache.has(key)) {
    const allies = [...new Set([...match.picked.filter((x, j) => x && j !== i).map(sid), ...match.allies.map(sid)])];
    const rows = recommend(i >= 0 ? playerData(i) : data, {
      role: null, mapSlug: match.mapSlug, side: match.side, enemies: match.enemies, allies, bans: match.bans, scoreAll: true,
      favorites: i >= 0 ? profile.players[i].favorites : [], theory: T, useTheory: !!profile.useTheory, guideOnly: guideMode(),
    });
    starCache.set(key, new Map(rows.map((r) => [sid(r.hero.id), r])));
  }
  return starCache.get(key);
}
function choiceStars(i) {
  const key = `stars${i}`;
  if (!starCache.has(key)) starCache.set(key, rankStars([...choiceRows(i).values()], starOpts()));
  return starCache.get(key);
}

function renderGrid() {
  // eroi già ufficiali ma non ancora su counterwatch (es. Doctrine, Stagione 5): arrivano con i loro dati
  const soon = data?.officialOnly ?? [];
  $("#grid-note").hidden = !soon.length;
  $("#grid-note").textContent = soon.length ? `${soon.join(", ")}: ${soon.length > 1 ? "nuovi, compariranno" : "nuovo, comparirà"} `
    + "qui quando counterwatch avrà le statistiche." : "";
  const recs = (lastDuo?.lists ?? []).map((rows) => (rows[0] && !rows[0].picked ? sid(rows[0].hero.id) : null));
  const favs = new Set(profile.players.flatMap((p) => p.favorites.map(sid)));
  const stars = gridStars();
  const grid = $("#grid");
  grid.dataset.stars = match.group;
  if (match.group === "picked") grid.style.setProperty("--sc", `var(--p${match.pickFor})`);
  else grid.style.removeProperty("--sc");
  for (const b of $$("#grid .hero")) {
    const id = b.dataset.id;
    const gs = groupsOf(id);
    const took = pickerOf(id);
    const rec = took >= 0 ? -1 : recs.indexOf(id);
    const who = took >= 0 ? took : rec;
    b.classList.toggle("in-bans", gs.includes("bans"));
    b.classList.toggle("in-enemies", gs.includes("enemies"));
    b.classList.toggle("in-allies", gs.includes("allies"));
    b.classList.toggle("fav", favs.has(id));
    b.classList.toggle("took", took >= 0);
    b.classList.toggle("rec", rec >= 0);
    if (who >= 0) b.style.setProperty("--pc", `var(--p${who})`);
    else b.style.removeProperty("--pc");
    const pressed = match.group === "picked" ? took === match.pickFor : gs.includes(match.group);
    b.setAttribute("aria-pressed", String(pressed));
    const whoName = who >= 0 ? profile.players[who].name : "";
    const n = stars.get(id) ?? 3;
    b.setAttribute("aria-label", `${byId[id].name}${gs.map((g) => `, ${GROUP_ONE[g]}`).join("")}` +
      `${took >= 0 ? `, preso da ${whoName}` : rec >= 0 ? `, consigliato a ${whoName}` : ""}` +
      `, ${STAR_WHAT[match.group]} ${starsLabel(n)}`);
    let st = $(".stars", b);
    if (!st) {
      st = el("span", { class: "stars", "aria-hidden": "true" });
      b.append(st);
    }
    st.className = `stars st-${match.group}`;
    st.textContent = "★".repeat(n);
    st.hidden = !n;
    b.dataset.stars = String(n);
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
      face(h), h.name, icon("xmark", "ic chip-x")));
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
    }, "Suggerisci solo eroi preferiti"),
    el("button", {
      type: "button", class: "toggle wide", id: "guide-only", "aria-pressed": String(!!profile.guideOnly),
      onclick: () => { profile.guideOnly = !profile.guideOnly; saveProfile(); render(); },
    }, "Consigli solo da guide e pro (senza statistiche)"),
    profile.guideOnly ? null : el("button", {
      type: "button", class: "toggle wide", "aria-pressed": String(!!profile.useTheory),
      onclick: () => { profile.useTheory = !profile.useTheory; saveProfile(); render(); },
    }, "Usa anche la teoria nei consigli"),
    el("p", { class: "muted small" },
      "Solo guide e pro: eroi e ban scelti senza le statistiche di counterwatch, da ciò che dicono guide, coach e giocatori " +
      "forti su mappe, counter e sinergie; al posto della percentuale vedi una valutazione a stelle. " +
      "Usa anche la teoria: consigli, ban e cambi nascono da statistiche e guide insieme, con un po' più di peso alle " +
      "guide (55% contro 45%); la stima in percentuale resta quella delle statistiche. Spenta, la teoria si vede ma " +
      "non cambia la classifica. " +
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
    afterSearchTap("fav-q");
  });
  resetSearch("fav-q");
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
  syncBack();
  renderFresh();
  if (!data) return;
  if (!$("#grid .hero")) {
    buildHeroGrid($("#grid"), (id) => { tapHero(id); afterSearchTap("hero-q"); });
    applySearch($("#hero-q"));
  }
  renderControls();
  starCache = new Map(); // stelline ricalcolate a ogni giro (anche quelle del riquadro dei ban)
  renderPicks();
  renderBanRecs();
  renderThreats();
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
  syncBack();
  window.scrollTo(0, 0);
  // i nomi si misurano solo a vista (nascosti hanno larghezza 0)
  if (name === "match" && data) { renderPicks(); fitNames($("#grid")); fitBanRecs(); }
}

function wire() {
  fillIcons(document);
  for (const id of ["hero-q", "fav-q", "map-q"]) wireSearch(id);
  $$(".tabs [data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  $$("#groups button").forEach((b) => b.addEventListener("click", () => { match.group = b.dataset.group; saveMatch(); render(); }));
  $$("#side button").forEach((b) => b.addEventListener("click", () => {
    match.side = match.side === b.dataset.side ? null : b.dataset.side;
    saveMatch(); render();
  }));
  $("#map-btn").addEventListener("click", () => { buildMapDialog(); resetSearch("map-q"); $("#map-dialog").showModal(); });
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

// ---------- tasto/gesto "indietro" di Android ----------
// L'APK torna indietro nella cronologia della pagina (e chiude l'app solo quando non c'è niente prima): ogni "livello"
// aperto — un foglio (mappa, preferiti, Come giocarla, Perché), il Profilo, "Tocca l'eroe preso da…" — è un passo
// nella cronologia. Indietro chiude il livello in cima; chiuso con un pulsante, il passo si toglie da solo.
let backDepth = 0; // passi aggiunti alla cronologia
let ownBack = false; // history.go chiamato dall'app (non dall'utente)
const dialogOrder = []; // fogli aperti, l'ultimo in cima
function wantedDepth() {
  return dialogOrder.length + ($("#view-profile").hidden ? 0 : 1) + (match.group === "picked" ? 1 : 0);
}
function syncBack() {
  const want = wantedDepth();
  while (backDepth < want) { history.pushState({ owc: ++backDepth }, ""); }
  if (backDepth > want) {
    const n = backDepth - want;
    backDepth = want;
    ownBack = true;
    history.go(-n);
  }
}
function wireBack() {
  // pagina ricaricata (es. versione nuova) con passi già in cronologia: si riparte da lì e syncBack li toglie
  if (typeof history.state?.owc === "number") backDepth = history.state.owc;
  else history.replaceState({ owc: 0 }, "");
  for (const d of $$("dialog")) {
    new MutationObserver(() => {
      const k = dialogOrder.indexOf(d);
      if (d.open && k < 0) dialogOrder.push(d);
      if (!d.open && k >= 0) dialogOrder.splice(k, 1);
      syncBack();
    }).observe(d, { attributes: true, attributeFilter: ["open"] });
  }
  window.addEventListener("popstate", () => {
    if (ownBack) { ownBack = false; return; }
    backDepth = Math.max(0, backDepth - 1);
    const top = dialogOrder[dialogOrder.length - 1];
    if (top) top.close();
    else if (match.group === "picked") { match.group = "enemies"; saveMatch(); render(); }
    else if (!$("#view-profile").hidden) showView("match");
  });
}

async function autoRefresh() {
  if (document.visibilityState === "hidden" || refreshing || !lastLoad) return;
  if (Date.now() - lastLoad < AUTO_REFRESH_MS) return;
  // anche l'app stessa: se è uscita una versione nuova, il service worker la installa e la pagina si ricarica
  navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
  const before = data?.checked;
  if (await loadData()) {
    render();
    if (data.checked !== before) toast("Dati aggiornati ✓", 2500);
  }
}

async function start() {
  wire();
  wireBack();
  document.addEventListener("pointerdown", autoRefresh, { capture: true, passive: true });
  window.addEventListener("scroll", updateMini, { passive: true });
  const refit = () => {
    if (!data || $("#view-match").hidden) return;
    delete $("#grid").dataset.fitW;
    fitNames($("#grid"));
    for (const t of $$("#picks .pick-name, #picks .fr-name")) fitText(t);
    fitAlts($("#picks"));
    fitBanRecs();
  };
  window.addEventListener("resize", refit);
  if (document.fonts?.ready) document.fonts.ready.then(refit);
  document.addEventListener("visibilitychange", autoRefresh);
  window.addEventListener("focus", autoRefresh);
  if ("serviceWorker" in navigator) {
    // versione nuova pubblicata: il nuovo service worker prende la pagina e la si ricarica una volta,
    // così non resta aperta (magari per ore nella WebView dell'APK) la versione vecchia
    const updating = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (updating && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  try {
    const r = await fetch("names_it.json");
    if (r.ok) IT = { heroes: {}, maps: {}, abilities: {}, ...(await r.json()) };
    setHeroNames();
  } catch { /* senza nomi italiani: restano quelli inglesi */ }
  try {
    const r = await fetch("theory.json");
    if (r.ok) theoryRaw = await r.json();
  } catch { /* senza teoria: restano gli stili Rush/Dive/Poke dei dati */ }
  localizeTheory(theoryRaw);
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

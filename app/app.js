import { recommend, recommendTeam, breakdown, details, hasSides, withDivision, heroProfile, matchups, headline, banSuggestions, BAN_ROLES,
  BANS_PER_ROLE, guideBanSuggestions, blendedBanSuggestions, guideDetails, threatScores, rankStars, STAR_MIN_SD, matchupSign } from "./recommend.js";
import { buildTheory, heroTheory, playGuide, theoryStatus, swapAdvice, STYLE_IT, STYLE_DESC } from "./theory.js";
import { icon, fillIcons } from "./icons.js";
import { sanitizeProfile, sanitizeMatch, parkMissing } from "./state.js";
import { API_URL, MAX_PHOTOS, MAX_BANS, photoRequest, photoHeaders, isFallbackRejection, photoError, readPhotoResponse, matchOwners, applyPhoto } from "./photo.js";

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
const limitOf = (g) => (g === "allies" ? Math.max(0, MAX_PLAYERS - present().length) : LIMITS[g]);
// giocatori dell'app IN QUESTA PARTITA: chi non è nella foto del tabellone resta fuori (match.away, richiesta del 2026-10-24)
const present = () => profile.players.map((_, i) => i).filter((i) => !match.away?.[i]);
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
let dataSig = ""; // data.json com'era all'ultima lettura: se non cambia, niente da ridisegnare
let dataChanged = false; // l'ultima loadData ha portato qualcosa di nuovo (dati o file di una divisione)
let gridStale = false; // elenco eroi cambiato: la griglia si ricostruisce al prossimo render (mai sotto il dito)
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
// picked[i]: eroe già preso dal giocatore i (null = ancora da scegliere); started: dopo «Avanti» dell'Inizio partita
const emptyMatch = () => ({
  roles: profile.players.map((p) => p.roles[0] ?? null),
  picked: profile.players.map(() => null),
  mapSlug: null, side: null, bans: [], enemies: [], allies: [], started: false,
});
// partita salvata da una versione precedente o con un numero di giocatori diverso: si sistema senza perdere nulla
function fitMatch() {
  const n = profile.players.length;
  const fit = (arr, fill) => Array.from({ length: n }, (_, i) => (arr && i < arr.length ? arr[i] : fill(i)));
  match.roles = fit(match.roles, (i) => profile.players[i].roles[0] ?? null);
  match.picked = fit(match.picked, () => null);
  match.away = fit(match.away, () => false).map(Boolean);
  if (match.away.every(Boolean)) match.away = match.away.map(() => false);
  match.picked = match.picked.map((x, i) => (match.away[i] ? null : x)); // chi non gioca non ha un eroe preso
  delete match.pickFor; // (versioni vecchie: «Tocca l'eroe preso da…» e il selettore non ci sono più)
  delete match.group;
  if (match.allies.length > limitOf("allies")) match.allies = match.allies.slice(0, limitOf("allies"));
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
// profilo e partita salvati: un campo mancante o rovinato (versione vecchia) torna al predefinito, mai un errore all'avvio
let profile = sanitizeProfile(store.get("owc.profile", null), { fallback: defaultProfile, ranks: RANKS, defaultName, maxPlayers: MAX_PLAYERS });
let match = sanitizeMatch(store.get("owc.match", null), emptyMatch);
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
// senza theory.json (non caricato) i consigli "solo guide" sarebbero tutti alla pari (in ordine alfabetico): si torna alle
// statistiche e l'avviso in giallo lo dice (renderFresh)
const theoryLoaded = () => Object.keys(theoryRaw).some((k) => !k.startsWith("_"));
const guideMode = () => !!profile.guideOnly && !!T && theoryLoaded();
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

// c'è in vista un messaggio con un'azione (es. "Annulla")?
const toastAction = () => !$("#toast").hidden && $("#toast").classList.contains("with-action");
window.owcToastHost = () => ($("#toast").hidden ? null : $("#toast").parentElement.id); // per il collaudo
// "Annulla" di qualcosa fatto prima di aggiungere o togliere un giocatore: le scelte sono salvate per posizione e
// finirebbero alle persone sbagliate, quindi non si annulla e lo si dice
let roster = 0; // cresce a ogni giocatore aggiunto o tolto
function undoable(run) {
  const r = roster;
  return () => {
    if (r !== roster) { toast("Non posso annullare: nel frattempo è cambiato l'elenco dei giocatori.", 3500); return; }
    run();
  };
}
// action: {label, run} → pulsante nel messaggio (es. "Annulla" dopo "Nuova partita")
// Il messaggio prende il posto di una riga che c'è già (stessa altezza, non copre né blocca nulla di toccabile): la riga di
// stato sotto la mappa; a pagina scorsa o con la ricerca aperta il contenuto della barra minima; nel Profilo la riga sotto il
// titolo. Un messaggio nuovo sostituisce il vecchio (stesso posto, tempo da capo): «Annulla» vale per l'ultima azione.
function toast(msg, ms = 6000, action = null) {
  const t = $("#toast");
  const hide = () => { t.hidden = true; clearTimeout(toast.timer); placeToast(); };
  fill(t, el("span", { class: "tmsg" }, msg), action ? el("button", {
    type: "button", class: "toast-btn",
    onclick: () => { hide(); action.run(); maybeReload(); },
  }, action.label) : null);
  t.classList.toggle("with-action", !!action);
  t.hidden = false;
  placeToast();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { hide(); maybeReload(); }, ms);
}
function placeToast() {
  const t = $("#toast");
  const mini = $("#mini");
  const host = startOpen() ? $("#sstatus") : !$("#view-profile").hidden ? $("#pstatus") : !mini.hidden ? mini : $("#hstatus");
  if (!t.hidden && t.parentElement !== host) host.append(t);
  for (const h of [$("#hstatus"), mini, $("#pstatus"), $("#sstatus")]) h.classList.toggle("msg", !t.hidden && h === host);
  // mai «…»: un testo lungo va su due righe più piccole, sempre dentro i 48 px
  t.classList.remove("two");
  if (!t.hidden) { const m = $(".tmsg", t); if (m && m.scrollHeight > 20) t.classList.add("two"); }
}

// ---------- dati ----------

async function loadData() {
  lastLoad = Date.now();
  try {
    const r = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (!Array.isArray(d.heroes) || !d.heroes.length) throw new Error("dati vuoti");
    const sig = JSON.stringify(d);
    if (data && sig === dataSig) {
      // stessi dati: si riprovano solo i file delle divisioni che prima non erano arrivati (es. offline)
      const retry = Object.keys(divFiles).filter((k) => divFiles[k] === null);
      for (const k of retry) delete divFiles[k];
      await loadDivisions();
      dataChanged = retry.some((k) => divFiles[k]);
      if (dataChanged) for (const k of Object.keys(divData)) delete divData[k];
      return true;
    }
    dataSig = sig;
    dataChanged = true;
    // elenco eroi cambiato (eroe nuovo o cambio di ruolo): la griglia va ridisegnata
    const heroSig = (x) => (x ? x.heroes.map((h) => `${h.id}:${h.role}:${h.name}`).join("|") : "");
    if (heroSig(d) !== heroSig(data)) gridStale = true;
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

// eroi (o mappe) spariti dai dati, magari solo per un momento (elenco di counterwatch incompleto): escono dalla partita
// ma restano da parte (match.missing) e tornano quando ricompaiono. I preferiti restano nel profilo: chi li legge salta gli
// eroi che i dati non hanno (knownFavorites, favoritesFor, recommend).
function cleanSelections() {
  if (parkMissing(match, { known: (id) => !!byId[id], knownMap: (slug) => data.maps.some((m) => m.slug === slug), limitOf })) {
    fitMatch();
    saveMatch();
  }
}
const knownFavorites = (p) => p.favorites.filter((x) => byId[sid(x)]);

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
    $("#fresh-short").hidden = true;
    warn.hidden = false;
    warn.textContent = "Impossibile caricare i dati: controlla la connessione (Profilo → Aggiorna dati).";
    return;
  }
  const checked = new Date(data.checked);
  const src = new Date(data.sourceUpdated || data.checked);
  $("#fresh").textContent = `Dati counterwatch del ${fmtDay(src)}, controllati ${ago(checked)} · ${filterText()}`;
  const msgs = [];
  if (Date.now() - checked.getTime() > STALE_MS) msgs.push(`I dati non vengono aggiornati da ${ago(checked).replace(" fa", "")}.`);
  if (data.problems?.length) msgs.push("Counterwatch è cambiato in parte: alcune sezioni usano i dati precedenti.");
  if (profile.guideOnly && !theoryLoaded()) msgs.push("Le guide non sono state caricate: «solo guide e pro» è sospeso, consigli dalle statistiche.");
  warn.hidden = !msgs.length;
  const old = Date.now() - checked.getTime() > STALE_MS;
  warn.textContent = !msgs.length ? "" : old ? `dati vecchi: ${ago(checked).replace(" fa", "")}`
    : data.problems?.length ? "dati in parte vecchi" : "guide non caricate";
  // freschezza corta nella testata della Partita (requisito: sempre visibile); vecchi o con problemi → in giallo (#warn)
  const fs = $("#fresh-short");
  fs.hidden = !warn.hidden;
  const a = ago(checked);
  fs.textContent = a === "adesso" ? "dati controllati adesso" : /giorni/.test(a) ? `dati del ${fmtDay(checked)}` : `dati di ${a}`;
  fs.title = $("#fresh").textContent;
  warn.title = msgs.join(" ");
  const full = $("#warn-full");
  full.hidden = !msgs.length;
  full.textContent = msgs.length ? `${msgs.join(" ")} I consigli funzionano comunque.` : "";
  $("#data-info").textContent =
    `${data.heroes.length} eroi, ${data.maps.length} mappe, ${filterText()}. ` +
    `Fonte aggiornata il ${src.toLocaleString("it-IT")}; ultimo controllo ${ago(checked)}.` +
    (data.problems?.length ? ` Problemi: ${data.problems.join("; ")}.` : "");
}

// ---------- consigli ----------

function compute() {
  const act = present();
  const players = act.map((i) => ({
    role: match.roles[i], favorites: profile.players[i].favorites, onlyFavorites: !!profile.onlyFavorites, data: playerData(i),
    picked: match.picked[i],
  }));
  const res = recommendTeam(data, {
    players, mapSlug: match.mapSlug, side: match.side, bans: match.bans, enemies: match.enemies, allies: match.allies,
    theory: T, useTheory: !!profile.useTheory, guideOnly: guideMode(),
  });
  // di nuovo agli indici del profilo (chi non gioca: niente consigli)
  const back = (arr, none) => profile.players.map((_, i) => (act.includes(i) ? arr[act.indexOf(i)] : none));
  const lists = back(res.lists, []);
  // chi ha già scelto: il «Passa a» non può essere l'eroe proposto in questo momento a un compagno (né a chi non ha ancora
  // scelto, né il «Passa a» di un compagno venuto prima): due persone non prendono lo stesso eroe. L'eroe si toglie dalle sue
  // righe e vale il migliore successivo (moveOf richiama swapAdvice sulle stesse righe: stesso risultato).
  const proposed = new Set(lists.filter((l) => l[0] && !l[0].picked).map((l) => sid(l[0].hero.id)));
  for (const i of act) {
    const l = lists[i];
    if (!l[0]?.picked) continue;
    l.splice(1, l.length, ...l.slice(1).filter((r) => !proposed.has(sid(r.hero.id))));
    const sw = swapAdvice(playerData(i), T, { hero: l[0].hero, rows: l, enemies: match.enemies, guide: guideMode() });
    if (sw) proposed.add(sid(sw.hero.id));
  }
  return { ...res, lists, team: back(res.team ?? [], null), notes: back(res.notes ?? [], null), picked: back(res.picked ?? [], false) };
}
// dati delle divisioni dei giocatori in partita (ban, minacce, stelline)
const presentSets = () => [...new Set(present().map((i) => playerData(i)))];

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

// ---------- tacche (al posto delle stelline: stessi valori di rankStars, 1–5) ----------
const tac = (n, cls = "") => el("span", { class: `tac${cls ? ` ${cls}` : ""}`, "data-stars": String(n), "aria-hidden": "true" },
  [1, 2, 3, 4, 5].map((k) => el("i", { class: k <= n ? "on" : null })));
const starsLabel = (n) => `${n} tacc${n > 1 ? "he" : "a"} su 5`;
const pctShort = (r) => (r && typeof r.estimate === "number" ? `${Math.round(r.estimate * 100)}%` : null);
// quanto rende in più il cambio (solo statistiche: in "solo guide" niente numeri)
function gainTxt(from, to) {
  if (!from || !to || typeof from.estimate !== "number" || typeof to.estimate !== "number") return null;
  const d = to.estimate - from.estimate;
  return d >= 0.0005 ? `+${(d * 100).toFixed(1).replace(".", ",")}%` : null;
}
// posto vuoto: tratteggio con l'icona del ruolo
const emptyFace = (role, cls = "") => el("span", { class: `hface none${cls ? ` ${cls}` : ""}`, "aria-hidden": "true" }, icon(ROLE_ICON[role] ?? "plus"));
const heroFace = (h, cls = "") => el("span", { class: `hface${cls ? ` ${cls}` : ""}`, "aria-hidden": "true" }, face(h));

// La mossa proposta al giocatore i: «Prendi» (non ha scelto), «Passa a» (ha scelto, c'è di meglio), «Resta su».
// Il ritratto grande della fascia è SEMPRE l'eroe che ha (match.picked); la proposta sta solo qui (striscia arancione).
function moveOf(i) {
  const rows = lastDuo?.lists?.[i] ?? [];
  const top = rows[0];
  if (!top) return null;
  if (!top.picked) return { verb: "Prendi", hero: top.hero, row: top, from: null };
  const sw = swapAdvice(playerData(i), T, { hero: top.hero, rows, enemies: match.enemies, guide: guideMode() });
  if (!sw) return { stay: true, verb: "Resta su", hero: top.hero, row: top, from: top };
  return { verb: "Passa a", hero: sw.hero, row: rowFor(i, sw.hero) ?? choiceRows(i).get(sid(sw.hero.id)), from: top, sw };
}

// Barra minima (testata fuori vista): per ciascuno quello che HA → la proposta (volto + NOME in arancione).
let miniTops = [];
function renderMini() {
  const box = $("#mini-row");
  box.replaceChildren();
  if (!lastDuo) return;
  const act = present();
  const mini = $("#mini");
  mini.className = `mini n${Math.min(act.length, 5)}${mini.classList.contains("msg") ? " msg" : ""}`;
  const tops = profile.players.map((p, i) => moveOf(i)?.hero?.id ?? null);
  for (const i of act) {
    const p = profile.players[i];
    const mv = moveOf(i);
    const has = match.picked[i] && byId[sid(match.picked[i])];
    const changed = miniTops[i] !== undefined && miniTops[i] !== tops[i];
    const target = mv && !mv.stay ? mv.hero : has || mv?.hero;
    box.append(el("button", {
      type: "button", class: `mini-pick${changed ? " pulse" : ""}`, style: `--pc: var(--p${i})`, "data-player": String(i),
      "data-has": has ? sid(has.id) : "", onclick: () => (target ? openGuide(i, target) : openSheet({ kind: "player", i })),
      "aria-label": `${p.name}: ${has ? `ha ${has.name}` : "non ha ancora scelto"}${mv && !mv.stay ? `, proposta ${mv.hero.name}` : ""}. Tocca per come giocarla`,
    },
    has ? heroFace(has) : emptyFace(match.roles[i]),
    mv && !mv.stay ? [icon("chevron", "ic ar"), heroFace(mv.hero, "sm prop"), el("b", { class: "nm" }, mv.hero.name)]
      : el("span", { class: "ok", "aria-hidden": "true" }, icon("check"))));
  }
  miniTops = tops;
  for (const t of $$(".nm", box)) fitText(t, { whole: true });
}
function updateMini() {
  if ($("#view-match").hidden) { $("#mini").hidden = true; placeToast(); return; }
  const mini = $("#mini");
  // la testata (mappa e riga di stato) è uscita dallo schermo: in alto chi ha cosa (e lì va il messaggio)
  const r = $("#hstatus").getBoundingClientRect();
  const show = r.height > 0 && r.bottom < 0;
  if (mini.hidden === show) mini.hidden = !show;
  placeToast();
}

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

// "scegli": l'eroe preso da quel giocatore (pulsante «✓ PRESO/CAMBIO», alternative, lista eroi del giocatore)
function choose(i, id) {
  const was = match.picked[i] ? sid(match.picked[i]) : null;
  setPicked(i, id);
  saveMatch();
  render();
  toast(`${profile.players[i].name} ha scelto ${byId[id].name} ✓`, 6000, {
    label: "Annulla",
    run: undoable(() => { if (was) setPicked(i, was); else match.picked[i] = null; saveMatch(); render(); }),
  });
}

// ---------- card del giocatore (v4) ----------
// [eroe che HA (o posto vuoto)] › [proposta, bordo arancione] NOME +x% / 55% [✓ CAMBIO/PRESO]; «✓ resta su X».
// Volti tutti quadrati (raggio 4) con il bordo di stato interno: verde = batte, rosso = teme (solo avversari SEGNATI,
// da matchups()), arancione = proposta. Parole minime: nome, verbo, «CASSIDY 46%», teme, batte, oppure.
// Da 3 giocatori in su: card compatte di una riga, una aperta alla volta.
let expanded = -1;
const muFaces = (xs, cls) => (xs.length ? el("span", { class: `mu ${cls}` }, el("span", { class: "mul", "aria-hidden": "true" }, cls === "good" ? "batte" : "teme"), xs.map((x) => {
  const t = `${cls === "good" ? "batte" : "teme"} ${x.hero.name}`;
  return el("span", { class: `mf ${cls}`, role: "img", "aria-label": t, title: t, "data-id": sid(x.hero.id) }, face(x.hero));
})) : null);
const muLabel = (m) => `${m.strong.length ? `, batte ${m.strong.map((x) => x.hero.name).join(", ")}` : ""}${m.weak.length ? `, teme ${m.weak.map((x) => x.hero.name).join(", ")}` : ""}`;
// volti della card (solo tra gli avversari SEGNATI, da matchups()): sotto l'eroe preso chi teme (max 2); sotto la proposta chi
// batte (max 2) e, prima della scelta, anche chi teme; con «resta» chi batte già. Senza avversari nessun volto.
function facesOf(i) {
  const none = { hasBad: [], propGood: [], propBad: [], stayGood: [] };
  const top = lastDuo?.lists?.[i]?.[0];
  const mv = moveOf(i);
  if (!top || !mv || !match.enemies.length) return none;
  if (!top.picked) { const m = matchups(top, 2); return { ...none, propGood: m.strong, propBad: m.weak }; }
  if (mv.stay) return { ...none, stayGood: matchups(top, 3).strong };
  return { ...none, hasBad: matchups(top, 2).weak, propGood: mv.row ? matchups(mv.row, 3).strong : [] };
}
// per il collaudo: per ogni giocatore in partita gli id attesi dei volti (verdi e rossi)
window.owcFaces = () => present().map((i) => Object.fromEntries(Object.entries(facesOf(i)).map(([k, xs]) => [k, xs.map((x) => sid(x.hero.id))])));
function band(p, i, compact) {
  const rows = lastDuo.lists[i] ?? [];
  const top = rows[0];
  const took = !!top?.picked;
  const has = took ? top.hero : null; // = match.picked[i]
  const role = took ? top.hero.role : match.roles[i];
  const mv = moveOf(i);
  const style = `--pc: var(--p${i})`;
  const attrs = (cls, label) => ({ class: `band${cls}`, style, "data-player": String(i), "data-has": has ? sid(has.id) : "",
    "data-move": mv && !mv.stay ? sid(mv.hero.id) : "", "aria-label": label });
  const F = facesOf(i);
  const nStars = (h) => choiceStars(i).get(sid(h.id)) ?? 3;
  const plus = mv?.sw ? gainTxt(mv.from, mv.row) : null;
  const doneBtn = (small) => el("button", {
    type: "button", class: `done${small ? " sm" : ""}`, "data-id": sid(mv.hero.id), onclick: () => choose(i, sid(mv.hero.id)),
    "aria-label": `${p.name} ${took ? "è passato a" : "ha preso"} ${mv.hero.name}`,
  }, icon("check"), small ? null : el("span", { class: "dl", "aria-hidden": "true" }, took ? "Cambio" : "Preso"));
  const hasFace = has ? heroFace(has, "pc") : el("span", { class: "hface none", "aria-hidden": "true" }, icon("plus"));
  if (compact) {
    return el("section", attrs(" compact", `${p.name}${has ? `, ha ${has.name}` : ", non ha ancora scelto"}`),
      el("button", {
        type: "button", class: "cmp", onclick: () => { expanded = i; renderPicks(); },
        "aria-label": `${p.name}: ${has ? `ha ${has.name}` : "non ha ancora scelto"}${mv && !mv.stay ? `, proposta ${mv.hero.name}` : ""}. Tocca per aprire`,
      },
      el("span", { class: "pn", "aria-hidden": "true" }, p.name), hasFace,
      mv && !mv.stay ? [icon("chevron", "ic ar"), heroFace(mv.hero, "prop sm"), el("span", { class: "nm", "aria-hidden": "true" }, mv.hero.name)]
        : el("span", { class: "ok", "aria-hidden": "true" }, icon("check"), "resta")),
      mv && !mv.stay ? doneBtn(true) : null);
  }
  const fold = compact === false && present().length >= 3
    ? el("button", { type: "button", class: "fold", "aria-label": `Chiudi la card di ${p.name}`, onclick: () => { expanded = -1; renderPicks(); } }, icon("chevron", "ic up"))
    : null;
  const roleBtn = !took ? el("button", { type: "button", class: "role-btn", onclick: () => nextRole(i), "aria-label": `Ruolo di ${p.name}: ${role ? ROLE_IT[role] : "qualsiasi"}. Tocca per cambiare` },
    icon(role ? ROLE_ICON[role] : "plus"), el("span", {}, role ? ROLE_IT[role] : "Tutti")) : null;
  const verb = !mv ? null : mv.stay ? null : took ? "Passa a" : "Prendi";
  const head = el("div", { class: "chead", "aria-hidden": "true" }, el("span", { class: "pn" }, p.name), verb ? el("span", { class: "verb" }, verb) : null);
  if (!top) {
    return el("section", attrs(" empty", `${p.name}: nessun eroe disponibile`), fold, head,
      el("div", { class: "crow" }, el("div", { class: "hcol" }, hasFace), el("span", { class: "none-msg" }, "Nessun eroe disponibile")));
  }
  const hasBtn = el("button", {
    type: "button", class: `has${has ? "" : " none"}`, onclick: () => openSheet({ kind: "player", i }), "data-stars": has ? String(nStars(has)) : null,
    "aria-label": has ? `${p.name} ha ${has.name}${pctShort(top) ? ` (${pctShort(top)})` : ""}${F.hasBad.length ? `, teme ${F.hasBad.map((x) => x.hero.name).join(", ")}` : ""}. Tocca per come giocarla, annullare o cambiarlo`
      : `${p.name} non ha ancora scelto: tocca per scegliere`,
  }, hasFace);
  // colonna sinistra: ritratto, «CASSIDY 46%», «teme» + volti; prima della scelta «oppure» + 2 alternative
  let alts = [];
  if (!took) {
    const favs = profile.onlyFavorites ? favoritesFor(i, role) : [];
    const best = rows.map((r) => sid(r.hero.id)).filter((id) => !takenBy(i).has(id));
    alts = (favs.length ? favs : best).filter((id) => id !== sid(top.hero.id)).slice(0, 2);
  }
  const hcol = el("div", { class: "hcol" }, hasBtn,
    has ? el("span", { class: "hname", "aria-hidden": "true" }, el("b", { class: "hn" }, has.name), pctShort(top) ? el("small", {}, pctShort(top)) : null) : null,
    muFaces(F.hasBad, "bad"),
    alts.length ? el("div", { class: "oalts" }, el("span", { class: "o", "aria-hidden": "true" }, "oppure"), el("div", { class: "orow" }, alts.map((id) => el("button", {
      type: "button", class: "alt3", "data-id": id, onclick: () => choose(i, id), "data-stars": String(choiceStars(i).get(id) ?? 3),
      "aria-label": `Oppure ${byId[id].name}. Tocca: l'ha preso ${p.name}`,
    }, face(byId[id]), el("span", { class: "nm", "aria-hidden": "true" }, byId[id].name))))) : null);
  let right;
  if (mv?.stay) {
    right = el("div", { class: "staybox" }, el("span", { class: "stay3", "aria-label": `Resta su ${has.name}` }, icon("check"), "resta"), muFaces(F.stayGood, "good"));
  } else if (mv) {
    const num = plus ? el("span", { class: "plus", "aria-hidden": "true" }, plus) : !took && pctShort(mv.row) ? el("span", { class: "pct", "aria-hidden": "true" }, pctShort(mv.row)) : null;
    right = [icon("chevron", "ic ar"),
      el("div", { class: "pcol" },
        el("button", {
          type: "button", class: "go", onclick: () => openGuide(i, mv.hero), "data-stars": String(nStars(mv.hero)),
          "aria-label": `Proposta: ${mv.hero.name}${mv.row && mv.row.estimate != null ? `, stima ${est(mv.row, i)}` : ""}${plus ? `, ${plus}` : ""}${muLabel({ strong: F.propGood, weak: F.propBad })}. Tocca per come giocarla`,
        }, heroFace(mv.hero, "prop"), el("span", { class: "gcol" }, el("span", { class: "nm", "aria-hidden": "true" }, mv.hero.name), num)),
        el("div", { class: "mus" }, muFaces(F.propGood, "good"), muFaces(F.propBad, "bad"))),
      el("div", { class: "rcol" }, doneBtn(false), roleBtn)];
  }
  const note = lastDuo.notes?.[i];
  return el("section", attrs(`${took ? " took" : " choosing"}${fold ? " open" : ""}`, `${p.name}${has ? ` ha ${has.name}` : ": da scegliere"}`),
    fold, head, el("div", { class: "crow" }, hcol, right),
    note ? el("p", { class: "why warn-note" }, note) : null);
}
// per il collaudo: per ogni card l'eroe che ha (ritratto grande) e la proposta
window.owcBands = () => $$("#picks .band").map((b) => ({ player: Number(b.dataset.player), has: b.dataset.has || null, move: b.dataset.move || null }));

function renderPicks() {
  const box = $("#picks");
  box.replaceChildren();
  if (!data) return;
  lastDuo = compute();
  starCache = new Map();
  const act = present();
  if (act.length < 3 || !act.includes(expanded)) expanded = -1;
  box.className = `picks n${act.length}`;
  act.forEach((i) => box.append(band(profile.players[i], i, act.length >= 3 ? i !== expanded : null)));
  // chi la foto ha lasciato fuori: si rimette in partita con un tocco
  const out = profile.players.map((p, i) => (match.away[i] ? i : -1)).filter((i) => i >= 0);
  const away = $("#away");
  away.hidden = !out.length;
  fill(away, out.length ? [el("span", { class: "away-lab" }, "Non in questa partita:"),
    out.map((i) => el("button", { type: "button", class: "away-chip", style: `--pc: var(--p${i})`, "aria-label": `Rimetti ${profile.players[i].name} in partita`,
      onclick: () => {
        match.away[i] = false;
        const allies = match.allies.slice();
        fitMatch(); saveMatch(); render();
        // un giocatore in più = un alleato in meno: si dice quale non ci sta più
        const out = allies.filter((x) => !match.allies.some((y) => sid(y) === sid(x))).map((x) => byId[sid(x)]?.name).filter(Boolean);
        toast(`${profile.players[i].name} di nuovo in partita.${out.length ? ` Tolt${out.length > 1 ? "i" : "o"} dagli alleati: ${out.join(", ")}.` : ""}`,
          out.length ? 4500 : 2000);
      } }, el("span", { class: "p-dot", "aria-hidden": "true" }), profile.players[i].name, icon("plus")))] : null);
  fitBands();
  renderStrips();
  renderTips();
  renderMini();
  updateMini();
}
function fitBands() {
  for (const t of $$("#picks .gcol .nm, #picks .alt3 .nm, #picks .hn, #picks .cmp .nm, #picks .cmp .pn, #us-strip .plate, #them-strip .plate, #start-team .plate, #start-bans .plate, .strip .slot .rl"))
    fitText(t, { whole: true });
}

// eroi già ufficiali ma non ancora su counterwatch (es. Doctrine, Stagione 5): arrivano con i loro dati
function renderGridNote() {
  const soon = data?.officialOnly ?? [];
  $("#grid-note").hidden = !soon.length;
  $("#grid-note").textContent = soon.length ? `${soon.join(", ")}: ${soon.length > 1 ? "nuovi, compariranno" : "nuovo, comparirà"} `
    + "tra gli eroi quando counterwatch avrà le statistiche." : "";
}

// ---------- strisce di posti: «La vostra squadra» e «Avversari» ----------
// 5 posti T D D S S (coda a ruoli). Nella vostra squadra i giocatori in partita prendono il posto del loro ruolo (eroe preso,
// altrimenti il ruolo di questa partita: match.roles); con ruolo libero il primo posto libero; i posti rimasti sono gli
// alleati. Un tocco apre la lista degli eroi già sul ruolo del posto (il ruolo aiuta, non vincola).
const QUEUE = ["Tank", "Damage", "Damage", "Support", "Support"];
function teamCells() {
  const cells = QUEUE.map((role) => ({ role, i: -1, id: null }));
  for (const i of present()) {
    const h = match.picked[i] ? byId[sid(match.picked[i])] : null;
    const r = h ? h.role : match.roles[i];
    const c = cells.find((x) => x.i < 0 && !x.taken && x.role === r) ?? cells.find((x) => x.i < 0 && !x.taken);
    if (c) { c.i = i; c.taken = true; c.id = h ? sid(h.id) : null; }
  }
  const free = cells.filter((c) => c.i < 0);
  const rest = [];
  for (const id of match.allies.map(sid).filter((x) => byId[x])) {
    const c = free.find((x) => !x.id && x.role === byId[id].role);
    if (c) c.id = id; else rest.push(id);
  }
  for (const id of rest) { const c = free.find((x) => !x.id); if (c) c.id = id; }
  return cells;
}
function slotCells(g) {
  if (g === "allies") return teamCells().filter((c) => c.i < 0).map(({ role, id }) => ({ role, id }));
  const ids = match[g].map(sid).filter((id) => byId[id]);
  if (g === "bans") return Array.from({ length: LIMITS.bans }, (_, k) => ({ role: null, id: ids[k] ?? null }));
  const cells = QUEUE.map((role) => ({ role, id: null }));
  const rest = [];
  for (const id of ids) {
    const c = cells.find((x) => !x.id && x.role === byId[id].role);
    if (c) c.id = id; else rest.push(id);
  }
  for (const id of rest) { const c = cells.find((x) => !x.id); if (c) c.id = id; }
  return cells;
}
const plate = (t, cls = "") => el("span", { class: `plate${cls ? ` ${cls}` : ""}`, "aria-hidden": "true" }, t);
function emptyCell(role) {
  return [icon(ROLE_ICON[role] ?? "plus"), el("span", { class: "rl", "aria-hidden": "true" }, ROLE_IT[role] ?? "")];
}
function teamStrip(box, { start = false } = {}) {
  const cells = teamCells();
  const lim = limitOf("allies");
  const allies = cells.filter((c) => c.i < 0);
  fill(box, el("h3", {}, "La vostra squadra", el("small", {}, start ? "facoltativo" : `${match.allies.length}/${lim} alleati`)),
    el("div", { class: "cells" }, cells.map((c) => {
      if (c.i >= 0) {
        const p = profile.players[c.i];
        const h = c.id ? byId[c.id] : null;
        return el("button", {
          type: "button", class: `slot player${h ? " full" : " empty"}`, style: `--pc: var(--p${c.i})`, "data-player": String(c.i), "data-id": c.id ?? "",
          "aria-label": `${p.name}${h ? `: ${h.name}` : ": non ha ancora scelto"}. Tocca per scegliere`, onclick: () => openSheet({ kind: "player", i: c.i }),
        }, h ? face(h) : icon("plus"), plate(p.name, "pcn"));
      }
      const h = c.id ? byId[c.id] : null;
      const k = allies.indexOf(c);
      return el("button", {
        type: "button", class: `slot ally${h ? " full" : " empty"}`, "data-role": c.role, "data-id": c.id ?? "",
        "aria-label": h ? `Alleato ${h.name}: tocca per cambiarlo o toglierlo` : `Alleato (${ROLE_IT[c.role]}): tocca per sceglierlo`,
        onclick: () => openSheet({ kind: "allies", role: h ? h.role : c.role, current: c.id, slot: k }),
      }, h ? [face(h), plate(heroName(h))] : emptyCell(c.role));
    })));
}
function renderStrips() {
  const us = $("#us-strip");
  const n = present().length;
  us.hidden = !data || n >= 5;
  if (!us.hidden) teamStrip(us);
  const them = $("#them-strip");
  const cells = slotCells("enemies");
  const first = cells.findIndex((c) => !c.id);
  const stars = enemyStars();
  fill(them, el("h3", {}, "Avversari", el("small", {}, `${match.enemies.length}/5`)),
    el("div", { class: "cells" }, cells.map((c, k) => {
      const h = c.id ? byId[c.id] : null;
      return el("button", {
        type: "button", class: `slot enemy${h ? " full" : " empty"}${k === first ? " next" : ""}`, "data-role": c.role, "data-id": c.id ?? "",
        "aria-label": h ? `Avversario ${h.name}: tocca per cambiarlo o toglierlo` : `Avversario (${ROLE_IT[c.role]}): tocca per sceglierlo`,
        onclick: () => openSheet({ kind: "enemies", role: h ? h.role : c.role, current: c.id, slot: k }),
      }, h ? [face(h), tac(stars.get(c.id) ?? 3, "lv st-enemies"), plate(heroName(h))] : emptyCell(c.role));
    })));
}

// ---------- «Come giocarla» in vista: per ogni giocatore «attento» e «punta», volti + poche parole ----------
// Dalle righe di playGuide («Attento», «Punta»), in forma corta costruita qui; una riga che non sta in una riga si accorcia
// togliendo le parole (restano i volti), mai «…». Senza avversari segnati il blocco non c'è. Un tocco = guida completa.
function tipsFor(i) {
  const mv = moveOf(i);
  const has = match.picked[i] && byId[sid(match.picked[i])];
  const hero = has || mv?.hero;
  if (!hero) return null;
  const g = playGuide(playerData(i), T, {
    hero, mapSlug: match.mapSlug, side: match.side, enemies: match.enemies, allies: match.allies,
    partners: partnersOf(i).map((x) => x.hero).filter((h) => sid(h.id) !== sid(hero.id)), rows: lastDuo?.lists?.[i] ?? null, guide: guideMode(),
  });
  const brief = g.sections.find((s) => s.summary)?.items ?? [];
  const out = [];
  const th = brief.find((x) => x.key === "threat");
  if (th?.heroes?.length) {
    const how = String(th.short ?? "").split(" — ").pop().split(", ")[0];
    const m = /^lascia (.+?) a (.+)$/.exec(how);
    const hs = th.heroes.slice(0, 2);
    // forma breve fatta apposta (mai «…»); «alt» = ripiego più corto se la riga non ci sta
    out.push({ key: "threat", label: "attento", cls: "bad", heroes: hs, kind: th.kind,
      text: m ? `lascia${hs.length > 1 ? "li" : "lo"} a ${m[2]}` : /^evita l'1 contro 1/.test(how) ? "evita l'1 contro 1" : hs.length > 1 ? "ti battono" : "ti batte",
      alt: hs.length > 1 ? "ti battono" : "ti batte" });
  }
  const tg = brief.find((x) => x.key === "target");
  if (tg?.heroes?.length) {
    const reason = String(tg.short ?? "").split(" · ")[0];
    const hs = tg.heroes.slice(0, 2);
    const alt = hs.length > 1 ? "li batti" : "lo batti";
    out.push({ key: "target", label: "punta", cls: "good", heroes: hs, kind: tg.kind, text: !reason || /^ignora /.test(reason) || reason.length > 30 ? alt : reason, alt });
  }
  return { hero, rows: out };
}
function renderTips() {
  const box = $("#tips");
  const act = present();
  box.hidden = !data || !match.enemies.length;
  if (box.hidden) { box.replaceChildren(); return; }
  fill(box, el("h3", {}, "Come giocarla"), act.map((i) => {
    const t = tipsFor(i);
    if (!t || !t.rows.length) return null;
    // un blocco per giocatore = un pulsante (≥ 48 px): il tocco apre il suo «Come giocarla»
    const say = t.rows.map((r) => `${r.label} ${r.heroes.map((h) => h.name).join(" e ")}${r.text ? `, ${r.text}` : ""} (${r.kind === "teoria" ? "teoria" : "dati"})`).join("; ");
    return el("button", { type: "button", class: "tipgrp", style: `--pc: var(--p${i})`, "data-player": String(i), onclick: () => openGuide(i, t.hero),
      "aria-label": `${profile.players[i].name}: ${say}. Tocca per come giocarla` }, t.rows.map((r, k) => el("span", {
      class: `tip k-${r.key}`, "data-player": String(i),
    },
    el("span", { class: "tpn", "aria-hidden": "true" }, k ? "" : profile.players[i].name),
    el("span", { class: `tl ${r.cls}`, "aria-hidden": "true" }, r.label),
    r.heroes.map((h) => el("span", { class: `mf ${r.cls}`, "aria-hidden": "true", "data-id": sid(h.id) }, face(h))),
    el("span", { class: "tx", "aria-hidden": "true", "data-alt": r.alt }, el("span", { class: `mk ${r.kind === "teoria" ? "theory" : "data"}` }), r.text))));
  }));
  fitTips();
}
// una riga sola, mai «…»: se le parole non ci stanno si tolgono (restano etichetta e volti)
function fitTips() {
  for (const t of $$("#tips .tip")) {
    const tx = $(".tx", t);
    if (!tx || t.scrollWidth <= t.clientWidth + 1) continue;
    tx.lastChild.textContent = tx.dataset.alt; // ripiego corto
    if (t.scrollWidth > t.clientWidth + 1) t.remove(); // nemmeno così: la riga non si mostra (mai tagliata)
  }
  for (const g of $$("#tips .tipgrp")) if (!$(".tip", g)) g.remove();
  for (const g of $$("#tips .tipgrp")) { const f = $(".tip .tpn", g); if (f && !f.textContent) f.textContent = profile.players[Number(g.dataset.player)].name; }
}
window.owcTips = () => $$("#tips .tip").map((t) => ({ player: Number(t.dataset.player), key: t.classList.contains("k-threat") ? "threat" : "target",
  ids: $$(".mf", t).map((f) => f.dataset.id), text: $(".tx", t)?.textContent ?? "" }));

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
  const sets = presentSets();
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
  const heroes = present().map((i) => {
    const id = match.picked[i];
    return id != null && byId[sid(id)] ? { hero: byId[sid(id)], i } : null;
  }).filter(Boolean);
  for (const a of match.allies) if (byId[sid(a)]) heroes.push({ hero: byId[sid(a)], i: -1 });
  return heroes;
}
// minacce (tacche rosse e nome rosso dei 3 peggiori per ruolo nella griglia): forza sulla mappa dal LORO lato + quanto
// battono la vostra squadra (eroi presi e alleati segnati)
function threatRows() {
  if (!starCache.has("threat")) {
    starCache.set("threat", threatScores(presentSets(), T, {
      mapSlug: match.mapSlug, side: match.side, ours: match.picked.filter(Boolean), mates: match.allies, mode: starMode(),
    }));
  }
  return starCache.get("threat");
}
// I 3 più pericolosi per ruolo (non bannati): solo con «Avversari» e se c'è una vostra squadra da confrontare
function topThreats() {
  if (!ourComp().length) return new Set();
  const banned = new Set(match.bans.map(sid));
  const rows = threatRows().filter((r) => !banned.has(sid(r.hero.id)));
  return new Set(BAN_ROLES.flatMap((role) => rows.filter((r) => r.hero.role === role).sort((a, b) => b.score - a.score)
    .slice(0, THREATS_PER_ROLE).map((r) => sid(r.hero.id))));
}
// Ban consigliati (bandierina «BAN?» nella griglia): 3 per ruolo, l'elenco non cambia mentre si segnano (si vedono barrati)
function banSuggested() {
  if (!starCache.has("bansugg")) {
    const rec = banScores(BANS_PER_ROLE);
    starCache.set("bansugg", new Set(BAN_ROLES.flatMap((r) => (rec[r] ?? []).map((x) => sid(x.hero.id)))));
  }
  return starCache.get("bansugg");
}

// ---------- mappa e lato ----------

const currentMapOf = (slug) => data?.maps.find((m) => m.slug === slug) ?? null;
function currentMap() {
  return currentMapOf(match.mapSlug);
}

// testata: mappa (tocco = foglio delle mappe) con «modalità · ban …» sotto, ATT/DIF a destra (solo Scorta/Ibrida)
function renderControls() {
  const map = currentMap();
  $("#map-btn").classList.toggle("empty", !map);
  $("#map-name").textContent = map ? map.name : "Scegli mappa";
  // riga di stato: modalità · ban (volti grigi; un tocco = Inizio partita) · freschezza dei dati (renderFresh)
  $("#map-sub").textContent = map ? MODE_IT[map.mode] ?? map.mode : ""; // senza mappa lo dice già il pulsante («Scegli mappa»)
  $("#map-btn").setAttribute("aria-label", `Mappa: ${map ? `${map.name}, ${MODE_IT[map.mode] ?? map.mode}` : "nessuna"}. Tocca per cambiarla (inizio partita)`);
  const bans = match.bans.map((x) => byId[sid(x)]).filter(Boolean);
  // i volti spenti e barrati bastano (accostati, per lasciare spazio alla freschezza); senza ban lo si scrive
  fill($("#bans-btn"), bans.length ? null : el("span", { class: "bl" }, "nessun ban"), bans.map((h) => el("span", { class: "bf" }, face(h))));
  $("#bans-btn").setAttribute("aria-label", `${bans.length ? `Ban: ${bans.map((h) => h.name).join(", ")}` : "Nessun ban"}. Tocca per cambiarli (inizio partita)`);
  const side = $("#side");
  side.hidden = !hasSides(map);
  $$("button", side).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.side === match.side)));
  fitText($("#map-name"), { whole: true });
}

function buildMapDialog(selected = match.mapSlug) {
  const list = $("#map-list");
  list.replaceChildren();
  list.append(el("div", { class: "maps", "data-block": "none" },
    el("button", { type: "button", class: "map-opt none", "data-map": "", "data-q": searchKeys(["nessuna", "dati generali"]),
      "aria-pressed": String(!selected) }, "Nessuna mappa (dati generali)")));
  for (const [mode, label] of MODES) {
    const maps = data.maps.filter((m) => m.mode === mode).sort((a, b) => a.name.localeCompare(b.name));
    if (!maps.length) continue;
    list.append(el("div", { "data-block": mode },
      el("h3", { class: "mode-title" }, label + (hasSides({ mode }) ? " · attacco/difesa" : "")),
      el("div", { class: "maps" }, maps.map((m) =>
        el("button", { type: "button", class: "map-opt", "data-map": m.slug, "data-q": searchKeys([m.en, m.name, label]),
          "aria-pressed": String(m.slug === selected) }, m.name)))));
  }
}

// ---------- ricerca (eroi e mappe) ----------
// Senza accenti né simboli e anche per iniziali: "lucio" trova Lúcio, "soldier76" Soldier: 76, "jq" Junker Queen.
// Cerca sia il nome inglese (quello di counterwatch) sia quello italiano del gioco, se diverso.
const norm = (t) => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
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
  if (input.id === "hero-q") { arrangeResults(); return; }
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
  if (target.closest("dialog")) { delete target.dataset.fitW; fitNames(target); }
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
  const clear = input.parentElement.querySelector(".search-clear");
  if (clear) {
    clear.addEventListener("mousedown", (e) => { if (document.activeElement === input) e.preventDefault(); });
    clear.addEventListener("click", () => { input.value = ""; applySearch(input); input.focus(); });
  }
}

// Ricerca nella lista degli eroi (campo in cima, sempre): col fuoco i risultati vengono da TUTTI i ruoli e stanno subito
// sopra la tastiera (visualViewport); un tocco (o Invio sul primo) fa come un tocco nella lista.
const RES_MAX = 8; // 4 per riga, al massimo 2 righe
function buildResults() {
  const list = $("#results-list");
  list.replaceChildren();
  const order = (h) => ROLES.findIndex(([r]) => r === h.role);
  const heroes = [...data.heroes].sort((a, b) => order(a) - order(b) || heroName(a).localeCompare(heroName(b)));
  heroes.forEach((h, k) => list.append(el("button", {
    type: "button", class: "hero res-tile", "data-id": sid(h.id), "data-q": searchKeys([h.name, heroName(h)]), "data-order": String(k), hidden: true,
    onclick: () => sheetTap(sid(h.id)),
  }, face(h), el("span", { class: "role", "aria-hidden": "true" }, icon(ROLE_ICON[h.role])), el("span", { class: "nm" }, heroName(h)))));
}
function arrangeResults() {
  const input = $("#hero-q");
  const raw = input.value.trim();
  const q = norm(raw).replace(/\s+/g, "");
  const list = $("#results-list");
  const items = $$(".hero", list);
  const keysOf = (b) => b.dataset.q.split("|");
  // prima chi inizia con la ricerca, poi gli altri; a parità, l'ordine della griglia
  const hits = q ? items.filter((b) => keysOf(b).some((k) => k.includes(q)))
    .sort((a, b) => (keysOf(a).some((k) => k.startsWith(q)) ? 0 : 1) - (keysOf(b).some((k) => k.startsWith(q)) ? 0 : 1)
      || Number(a.dataset.order) - Number(b.dataset.order)) : [];
  for (const b of items) b.hidden = true;
  hits.forEach((b, k) => { list.append(b); b.hidden = k >= RES_MAX; b.classList.toggle("row-end", k % 4 === 3); });
  $("#results-hd").textContent = q ? `${hits.length} risultat${hits.length === 1 ? "o" : "i"} per «${raw}» in tutti i ruoli${hits.length > RES_MAX ? ` (i primi ${RES_MAX})` : ""}` : "";
  $("#results-hd").hidden = !q || !hits.length;
  $("[data-none=\"hs-results\"]").hidden = !q || hits.length > 0;
  $("#hs-results").classList.toggle("has", !!q);
  const clear = input.parentElement.querySelector(".search-clear");
  if (clear) clear.hidden = !input.value;
  paintResults();
}
// tacche del contesto, «INVIO» sul primo, «GIÀ SEGNATO» (un tocco lo toglie)
function paintResults() {
  if (!data || !sheetCtx) return;
  const shown = $$("#results-list .hero:not([hidden])");
  shown.forEach((b, k) => {
    const id = b.dataset.id;
    const on = sheetOn(id);
    b.classList.toggle("first", k === 0);
    b.classList.toggle("marked", on);
    b.className = b.className.replace(/\bg-\w+/g, "").trim() + ` g-${sheetCtx.kind}`;
    b.setAttribute("aria-pressed", String(on));
    const n = sheetStars().get(id) ?? 3;
    b.dataset.stars = String(n);
    $(".tac", b)?.remove();
    $(".on-lab", b)?.remove();
    b.append(tac(n, `stars st-${sheetCtx.kind}`));
    if (on) b.append(el("span", { class: "on-lab", "aria-hidden": "true" }, "Già segnato"));
    b.setAttribute("aria-label", `${byId[id].name}${on ? ", già segnato: tocca per toglierlo" : ""}${k === 0 ? " (Invio)" : ""}, ${STAR_WHAT[sheetCtx.kind]} ${starsLabel(n)}`);
  });
  delete $("#hs-results").dataset.fitW;
  fitNames($("#hs-results"));
}
// la fascia dei risultati sta subito sopra la tastiera: con adjustResize la finestra si accorcia (innerHeight), altrimenti
// lo dice visualViewport
function placeResults() {
  const vv = window.visualViewport;
  const bottom = vv ? Math.max(0, window.innerHeight - (vv.offsetTop + vv.height)) : 0;
  $("#hs-results").style.bottom = `${Math.round(bottom)}px`;
}
let searching = false;
function openSearch() {
  if (searching || !sheetCtx) return;
  searching = true;
  $("#hero-sheet").classList.add("searching");
  arrangeResults();
  placeResults();
  syncBack();
}
function closeSearch() {
  if (!searching) return;
  searching = false;
  $("#hero-sheet").classList.remove("searching");
  const input = $("#hero-q");
  input.value = "";
  arrangeResults();
  if (document.activeElement === input) input.blur();
  syncBack();
}
window.owcSearching = () => searching; // per il collaudo
function wireHeroSearch() {
  const input = $("#hero-q");
  input.addEventListener("focus", openSearch);
  // un tocco fuori (il campo perde il fuoco) chiude la ricerca; i risultati e la × non tolgono il fuoco
  input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) closeSearch(); }, 0));
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", placeResults);
    window.visualViewport.addEventListener("scroll", placeResults);
  }
  window.addEventListener("resize", placeResults);
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

// Nomi mai spezzati né tagliati: se il testo non ci sta nello spazio disponibile, il carattere si rimpicciolisce quanto
// basta. Si misura il testo VERO sulla pagina (con il carattere del telefono e il suo ingrandimento di sistema, es. 130% su
// Xiaomi) e si cambia solo un fattore (--fit): una dimensione in px verrebbe ingrandita una seconda volta dalla WebView.
// whole: il nome sta su una riga sola (tessere, fasce, barra minima); altrimenti conta la parola più lunga.
function fitText(t, { whole = false } = {}) {
  t.style.removeProperty("--fit");
  const box = t.parentElement;
  if (!box || !box.clientWidth) return;
  const cs = getComputedStyle(box);
  const own = getComputedStyle(t);
  const avail = (whole ? t.clientWidth || box.clientWidth : box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))
    - (whole ? parseFloat(own.paddingLeft) + parseFloat(own.paddingRight) : 0) - 2;
  const text = ((whole ? t.textContent : t.firstChild?.textContent) ?? "").trim();
  const probe = el("span", { class: "nm-probe", "aria-hidden": "true" });
  t.append(probe);
  let w = 0;
  for (const word of whole ? [text] : text.split(/\s+/)) {
    probe.textContent = word;
    w = Math.max(w, probe.getBoundingClientRect().width);
  }
  probe.remove();
  if (w > avail && avail > 0) t.style.setProperty("--fit", String(Math.max(0.55, Math.floor((avail / w) * 100) / 100)));
}
window.owcFitText = fitText; // per il collaudo

function fitNames(container) {
  const nms = $$(".hero .nm", container).filter((n) => n.offsetParent);
  const width = nms[0]?.parentElement.clientWidth ?? 0;
  const key = `${width}|${container.dataset.tab ?? ""}`;
  if (!width || container.dataset.fitW === key) return;
  container.dataset.fitW = key;
  for (const nm of nms) fitText(nm, { whole: true });
}

// Regole di Overwatch 2: un ban vale per tutte e due le squadre; nella vostra squadra (eroi presi + alleati) un eroe
// c'è una volta sola; gli avversari possono avere gli STESSI eroi vostri (mirror). Quindi un eroe può essere insieme
// vostro e avversario, mai bannato e giocato.
const inGroup = (g, id) => match[g].some((x) => sid(x) === id);
const groupsOf = (id) => Object.keys(LIMITS).filter((g) => inGroup(g, id));
const OUR_SIDE = ["allies"]; // con match.picked: la vostra squadra
const pickerOf = (id) => match.picked.findIndex((x) => x && sid(x) === id);

// un tocco mette l'eroe nel gruppo (ban, avversari, alleati) o ve lo toglie
const dropFrom = (g, id) => { match[g] = match[g].filter((x) => sid(x) !== id); };
function toggleIn(g, id) {
  if (inGroup(g, id)) {
    dropFrom(g, id);
  } else {
    if (match[g].length >= limitOf(g)) {
      toast(g === "allies" && !limitOf(g) ? `Siete già in ${MAX_PLAYERS}: segnate gli eroi presi nelle vostre carte.`
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

// Eroe scelto da un giocatore (striscia della mossa, alternative, foglio di scelta, guida, griglia con «Tocca l'eroe preso
// da X»). Un eroe scelto esce dai ban e dagli alleati (e da un altro giocatore), NON dagli avversari (mirror).
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

// ---------- tacche (1–5) ----------
// In tutta l'app da 1 a 5, ruolo per ruolo (rankStars), mai un eroe senza tacche. Cambiano con ogni scelta (mappa,
// lato, ban, avversari, alleati, eroi presi) e seguono la modalità del Profilo (statistiche, + teoria, solo guide).
// Griglia, secondo il selettore:
//   Avversari (rosse) = quanto è pericoloso quel nemico: forte sulla mappa dal suo lato + quanto batte la vostra squadra,
//     soprattutto i vostri eroi (threatScores); Ban (bianche) = stesso calcolo dei ban consigliati (i vostri eroi,
//     eroi già scelti e alleati non si bannano: 1); Alleati / eroe preso da un giocatore (azzurre o col colore del
//     giocatore) = quanto è una buona scelta per voi. Fasce dei giocatori: tacche bianche, stessa "buona scelta".
const STAR_WHAT = { enemies: "pericolo", bans: "da bannare", allies: "buona scelta", player: "buona scelta" };
const starMode = () => (guideMode() ? "guide" : profile.useTheory && T ? "blend" : "stat");
const starOpts = (extra = {}) => ({ minSd: STAR_MIN_SD[starMode()], ...extra });
let starCache = new Map(); // calcoli di questo giro: si svuota a ogni nuovo consiglio (renderPicks)
function banStars() {
  if (!starCache.has("bans")) {
    const rec = banScores(999);
    const st = rankStars(BAN_ROLES.flatMap((r) => rec[r]), starOpts());
    for (const h of data.heroes) if (!st.has(sid(h.id))) st.set(sid(h.id), 1);
    starCache.set("bans", st);
  }
  return starCache.get("bans");
}
// tacche rosse degli avversari (pericolo)
function enemyStars() {
  if (!starCache.has("tstars")) starCache.set("tstars", rankStars(threatRows(), starOpts()));
  return starCache.get("tstars");
}
// tacche della lista eroi, secondo il contesto: avversari = pericolo, ban = da bannare, alleati e giocatore = buona scelta
function sheetStars() {
  const k = sheetCtx?.kind;
  if (k === "bans") return banStars();
  if (k === "enemies") return enemyStars();
  return choiceStars(k === "player" ? sheetCtx.i : -1);
}
// quanto ogni eroe (tutti, anche bannati o già presi) è una buona scelta per il giocatore i (-1 = per la squadra): gli
// eroi GIÀ PRESI dagli altri contano come alleati (non i loro consigli). Righe di recommend() per id.
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

// ---------- lista eroi (foglio): posto di una striscia, scelta di un giocatore, ban da cercare ----------
// Contesti: {kind: "enemies"|"allies", role, current, slot} · {kind: "player", i} · {kind: "bans"}. Si apre sulla scheda del
// ruolo del posto (o del giocatore); un tocco su un eroe fa l'azione e CHIUDE il foglio (decisione dell'utente). Le regole di
// Overwatch 2 restano quelle di toggleIn/setPicked: il ruolo del posto aiuta, non vincola (schede e ricerca).
let sheetCtx = null;
let sheetTab = null;
const SHEET_TITLE = { enemies: "Avversario", allies: "Alleato", bans: "Ban" };
const sheetOn = (id) => (sheetCtx.kind === "player" ? pickerOf(id) === sheetCtx.i : sheetCtx.current ? sheetCtx.current === id : inGroup(sheetCtx.kind, id));
function buildSheetGrid() {
  const box = $("#hs-grid");
  box.replaceChildren();
  delete box.dataset.fitW;
  for (const [role] of ROLES) {
    const heroes = data.heroes.filter((h) => h.role === role).sort((a, b) => heroName(a).localeCompare(heroName(b)));
    box.append(el("div", { class: "sgrid", "data-block": role }, heroes.map((h) => el("button", {
      type: "button", class: "hero", "data-id": sid(h.id), "aria-pressed": "false", onclick: () => sheetTap(sid(h.id)),
    }, face(h), el("span", { class: "nm" }, heroName(h))))));
  }
}
function openSheet(ctx) {
  if (!data) return;
  sheetCtx = { current: null, slot: null, ...ctx };
  if (sheetCtx.kind === "player") {
    const cur = match.picked[sheetCtx.i] ? byId[sid(match.picked[sheetCtx.i])] : null;
    sheetCtx.role = cur ? cur.role : match.roles[sheetCtx.i] || "Damage";
  }
  sheetTab = sheetCtx.role ?? "Tank";
  if (!$("#hs-grid .hero")) buildSheetGrid();
  resetSearch("hero-q");
  renderSheet();
  if (!$("#hero-sheet").open) $("#hero-sheet").showModal();
  $("#hero-sheet").scrollTop = 0;
  fitNames($("#hs-grid"));
}
window.owcSheet = () => (sheetCtx && $("#hero-sheet").open ? { kind: sheetCtx.kind, tab: sheetTab, i: sheetCtx.i ?? null, current: sheetCtx.current } : null);
function renderSheet() {
  const c = sheetCtx;
  if (!c) return;
  const p = c.kind === "player" ? profile.players[c.i] : null;
  const cur = c.kind === "player" ? (match.picked[c.i] ? sid(match.picked[c.i]) : null) : c.current;
  // titolo: chi e per cosa
  const n = c.kind === "enemies" ? `${(c.slot ?? 0) + 1}° di 5` : null;
  fill($("#t-hs"), p ? [el("span", { class: "who", style: `color: var(--p${c.i})` }, p.name), el("span", { class: "sl" }, cur ? " · cambia eroe" : " · sceglie")]
    : [el("span", { class: `who k-${c.kind}` }, SHEET_TITLE[c.kind]), c.role && c.kind !== "bans" ? el("span", { class: "sl" }, ` · ${ROLE_IT[c.role]}${n ? ` · ${n}` : ""}`) : null]);
  // in cima, per chi ha già scelto: Come giocarla e Non l'ho preso
  fill($("#hs-menu"), p && cur ? [
    el("button", { type: "button", id: "menu-guide", class: "btn", onclick: () => { $("#hero-sheet").close(); openGuide(c.i, byId[cur]); } },
      icon("target"), `Come giocare ${byId[cur].name}`),
    el("button", { type: "button", id: "menu-unpick", class: "btn", onclick: () => { $("#hero-sheet").close(); togglePicked(c.i, byId[cur]); } },
      icon("xmark"), "Non l'ho preso")] : null);
  $("#hs-menu").hidden = !(p && cur);
  // schede di ruolo (con il contatore del gruppo)
  const cells = c.kind === "enemies" || c.kind === "allies" ? slotCells(c.kind) : null;
  fill($("#hs-tabs"), ROLES.map(([r, label]) => {
    const quota = cells ? cells.filter((x) => x.role === r).length : 0;
    const got = cells ? match[c.kind].filter((x) => byId[sid(x)]?.role === r).length : 0;
    return el("button", {
      type: "button", class: `tab${r === sheetTab ? " on" : ""}`, "data-tab": r, "aria-pressed": String(r === sheetTab),
      "aria-label": `${label}${cells ? `: ${got} su ${quota}` : ""}`, onclick: () => { sheetTab = r; renderSheet(); fitNames($("#hs-grid")); },
    }, icon(ROLE_ICON[r]), r === "Support" ? "Supp." : label, cells && (quota || got) ? el("small", {}, `${got}/${quota}`) : null);
  }));
  const top3 = c.kind === "enemies" ? topThreats() : new Set();
  const sugg = c.kind === "bans" ? banSuggested() : new Set();
  fill($("#hs-legend"), c.kind === "enemies" ? [tac(5, "st-enemies"), " quanto è pericoloso", top3.size ? [" · ", el("span", { class: "ldot" }), " i 3 peggiori"] : null]
    : c.kind === "bans" ? [tac(5, "st-bans"), " quanto conviene bannarlo · ", el("span", { class: "ldot ow" }), " consigliato"]
      : [tac(5, `st-${c.kind}`), " quanto conviene", c.kind === "player" ? " · bordo arancione = consigliato" : null]);
  // griglia della scheda aperta: tacche, punto, stato (con il motivo scritto se non è disponibile)
  const grid = $("#hs-grid");
  grid.dataset.stars = c.kind;
  grid.dataset.tab = sheetTab;
  grid.style.setProperty("--sc", c.kind === "player" ? `var(--p${c.i})` : "");
  for (const b of $$("[data-block]", grid)) b.hidden = b.dataset.block !== sheetTab;
  const stars = sheetStars();
  const rec = c.kind === "player" ? moveOf(c.i) : null;
  const recId = rec && !rec.stay ? sid(rec.hero.id) : null;
  // lista del giocatore: i suoi preferiti segnati (stellina col suo colore); con «Suggerisci solo eroi preferiti» acceso
  // stanno per primi sotto «I tuoi preferiti», poi «Tutti gli eroi» (si può comunque prendere un eroe non preferito)
  const favs = p ? new Set(p.favorites.map(sid)) : new Set();
  const group = !!(p && profile.onlyFavorites && favs.size);
  for (const blk of $$("[data-block]", grid)) {
    $$(".sg-h", blk).forEach((x) => x.remove());
    if (group && $$(".hero", blk).some((b) => favs.has(b.dataset.id))) {
      blk.prepend(el("div", { class: "sg-h", style: "order: 0" }, "I tuoi preferiti"), el("div", { class: "sg-h", style: "order: 2" }, "Tutti gli eroi"));
    }
  }
  for (const b of $$(".hero", grid)) {
    const id = b.dataset.id;
    const gs = groupsOf(id);
    b.style.order = group ? (favs.has(id) ? "1" : "3") : "";
    $(".favmark", b)?.remove();
    if (favs.has(id)) b.append(el("span", { class: "favmark", "aria-hidden": "true" }, icon("star")));
    const took = pickerOf(id);
    const on = sheetOn(id);
    // il motivo per cui non è disponibile (o perché è già lì): bannato, avversario, alleato, preso da un giocatore
    const why = on ? null : gs.includes("bans") && c.kind !== "bans" ? "Bannato"
      : took >= 0 && (c.kind !== "player" || took !== c.i) && c.kind !== "enemies" ? `Preso da ${profile.players[took].name}`
        : gs.includes("allies") && c.kind !== "allies" && c.kind !== "enemies" ? "Alleato"
          : null;
    // anche avversario (mirror ammesso): solo un segno leggero, l'eroe resta pienamente selezionabile
    const vs = !on && !why && gs.includes("enemies") && c.kind !== "enemies";
    b.classList.toggle("vs", vs);
    b.classList.toggle("sel", on);
    b.classList.toggle("rec", id === recId);
    b.classList.toggle("off", !!why && why !== "Avversario");
    b.classList.toggle("sugg", sugg.has(id));
    b.classList.toggle("top3", top3.has(id));
    if (why) b.dataset.why = why; else delete b.dataset.why;
    b.setAttribute("aria-pressed", String(on));
    const nS = stars.get(id) ?? 3;
    b.dataset.stars = String(nS);
    $(".stars", b)?.remove();
    b.append(tac(nS, `stars st-${c.kind}`));
    b.setAttribute("aria-label", `${byId[id].name}${favs.has(id) ? ", preferito" : ""}${on ? ", segnato qui" : ""}${why ? `, ${why.toLowerCase()}` : ""}${vs ? ", anche avversario" : ""}${id === recId ? ", consigliato" : ""}`
      + `${top3.has(id) ? ", tra i più pericolosi" : ""}${sugg.has(id) ? ", ban consigliato" : ""}, ${STAR_WHAT[c.kind]} ${starsLabel(nS)}`);
  }
  // piede: togliere l'eroe dal posto (o la scelta del giocatore)
  fill($("#hs-foot"), cur && c.kind !== "player" ? el("button", { type: "button", id: "hs-remove", class: "btn", onclick: () => {
    $("#hero-sheet").close(); dropFrom(c.kind, cur); saveMatch(); render(); } }, icon("xmark"), "Togli") : null);
  $("#hs-foot").hidden = !(cur && c.kind !== "player");
  paintResults();
}
function sheetTap(id) {
  const c = sheetCtx;
  if (!c) return;
  closeSearch();
  $("#hero-sheet").close();
  if (c.kind === "player") { choose(c.i, id); return; }
  if (c.current) {
    if (c.current === id) return;
    dropFrom(c.kind, c.current);
  }
  toggleIn(c.kind, id);
}

// ---------- Inizio partita: mappa, la vostra squadra, ban consigliati (con il livello), «Avanti» ----------
// Si apre con «Nuova» (la partita di prima resta da parte: «Annulla» la rimette), al primo avvio, e dalla mappa o dai ban
// della testata in modo «modifica» («Fatto»). «Indietro» di Android = «Avanti». Si salva solo ciò che è stato messo.
const BANS_SHOWN = 4; // ban consigliati per ruolo
let startMode = null; // "new" | "edit" | null (chiusa)
let prevMatch = null; // la partita di prima, finché non si preme «Avanti»
const startOpen = () => !!startMode;
window.owcStart = () => startMode;
function openStart(mode) {
  if (mode === "new") {
    prevMatch = JSON.stringify(match);
    match = { ...emptyMatch(), away: match.away.slice() }; // chi gioca non cambia (lo decide la prossima foto)
    expanded = -1;
    fitMatch();
    saveMatch();
  }
  startMode = mode;
  $("#view-match").hidden = true;
  $("#view-profile").hidden = true;
  $("#start-view").hidden = false;
  document.body.classList.add("nodock");
  $$(".tabs [data-view]").forEach((b) => b.removeAttribute("aria-current"));
  window.scrollTo(0, 0);
  renderStart();
  syncBack();
}
function closeStart() {
  startMode = null;
  $("#start-view").hidden = true;
  document.body.classList.remove("nodock");
}
function startNext() {
  const undo = startMode === "new" && prevMatch ? prevMatch : null;
  match.started = true;
  saveMatch();
  prevMatch = null;
  closeStart();
  showView("match");
  render();
  if (undo) {
    toast("Nuova partita", 6000, { label: "Annulla", run: undoable(() => { match = JSON.parse(undo); fitMatch(); saveMatch(); render(); toast("Partita ripristinata.", 2000); }) });
  }
}
function startCancel() {
  if (prevMatch) { match = JSON.parse(prevMatch); fitMatch(); saveMatch(); }
  prevMatch = null;
  closeStart();
  showView("match");
  render();
}
function renderStart() {
  if (!startOpen() || !data) return;
  starCache = new Map();
  lastDuo = compute();
  const edit = startMode === "edit";
  $("#t-start").textContent = edit ? "Inizio partita" : "Nuova partita";
  $("#start-cancel").hidden = edit || !prevMatch;
  fill($("#start-next"), edit ? "Fatto" : "Avanti", icon("chevron"));
  const map = currentMap();
  const mb = $("#start-map");
  mb.classList.toggle("empty", !map);
  $(".map-name", mb).textContent = map ? map.name : "Scegli mappa";
  mb.setAttribute("aria-label", `Mappa: ${map ? map.name : "nessuna"}. Tocca per sceglierla`);
  $("#start-side").hidden = !hasSides(map);
  $$("#start-side button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.side === match.side)));
  teamStrip($("#start-team"), { start: true });
  // ban consigliati: una riga per ruolo, 4 tessere col livello (tacche bianche); l'elenco non cambia mentre si banna
  const rec = banScores(BANS_SHOWN);
  const lv = banStars();
  const banned = new Set(match.bans.map(sid));
  const shown = new Set(BAN_ROLES.flatMap((r) => (rec[r] ?? []).map((x) => sid(x.hero.id))));
  const others = match.bans.map(sid).filter((id) => !shown.has(id) && byId[id]);
  const tile = (id) => el("button", {
    type: "button", class: `bt${banned.has(id) ? " on" : ""}`, "data-id": id, "data-stars": String(lv.get(id) ?? 3), "aria-pressed": String(banned.has(id)),
    "aria-label": `${banned.has(id) ? "Bannato" : "Banna"} ${byId[id].name}, da bannare ${starsLabel(lv.get(id) ?? 3)}`,
    onclick: () => { toggleIn("bans", id); },
  }, face(byId[id]), tac(lv.get(id) ?? 3, "lv st-bans"), plate(heroName(byId[id])));
  fill($("#start-bans"),
    el("h2", { id: "t-sbans" }, "Ban consigliati", el("small", {}, `${map ? "" : "tutte le mappe · "}${match.bans.length}/5 · tocca = bannato`)),
    BAN_ROLES.map((role) => el("div", { class: "banrole", "data-role": role }, el("span", { class: "rl", "aria-hidden": "true" }, icon(ROLE_ICON[role])),
      (rec[role] ?? []).map((x) => tile(sid(x.hero.id))))),
    others.length ? el("div", { class: "banrole others" }, el("span", { class: "rl small" }, "altri"), others.map(tile)) : null,
    el("button", { type: "button", id: "start-ban-search", class: "photo-row", onclick: () => { openSheet({ kind: "bans" }); $("#hero-q").focus(); } },
      icon("search"), "Banna un altro eroe", el("small", {}, "cerca in tutti i ruoli")));
  fitBands();
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
      el("label", { for: `p${i}-nick` }, "Nome nel gioco (per la foto del tabellone)"),
      el("input", { id: `p${i}-nick`, value: p.nick || "", maxlength: "32", autocomplete: "off", autocapitalize: "off", spellcheck: "false",
        placeholder: "come appare nel tabellone", onchange: (e) => { p.nick = e.target.value.trim(); saveProfile(); } }),
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
      // solo gli eroi che i dati hanno (gli altri restano salvati e ricompaiono con loro)
      el("label", {}, `Eroi preferiti (${knownFavorites(p).length})`),
      knownFavorites(p).length ? null : el("p", { class: "muted small" }, "Nessun preferito: con «solo preferiti» si consiglia tra tutti."),
      el("div", { class: "fav-list" }, knownFavorites(p).map((id) => el("span", { class: "chip" }, face(byId[sid(id)]), byId[sid(id)].name))),
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
  $("#claude-key").value = "";
  $("#claude-key").placeholder = claudeKey() ? "chiave salvata ✓" : "sk-ant-…";
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
  roster++;
  match.roles.push(role);
  match.picked.push(null);
  fitMatch();
  saveProfile(); saveMatch();
  render();
  toast(`Aggiunto ${defaultName(i)} (${ROLE_IT[role]}): nome e ruolo qui sotto.`);
}
function removePlayer(i) {
  if (profile.players.length <= 1) return;
  const [gone] = profile.players.splice(i, 1);
  roster++;
  match.roles.splice(i, 1);
  match.picked.splice(i, 1);
  match.away.splice(i, 1);
  if (match.missing && Array.isArray(match.missing.picked)) match.missing.picked.splice(i, 1);
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
      toast(ok ? "Ricaricati gli ultimi dati. Per scaricarli subito da counterwatch serve il token (qui sotto)."
        : "Nessuna connessione: uso i dati salvati.", 6500);
      return;
    }
    const wait = DISPATCH_GAP_MS - (Date.now() - store.get("owc.lastDispatch", 0));
    if (wait > 0) {
      await loadData();
      render();
      toast(`Aggiornamento già chiesto: riprova tra ${Math.ceil(wait / 60e3)} min. Ricaricati gli ultimi dati.`, 6500);
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
        ? "Token non valido o senza il permesso Actions (lettura e scrittura)."
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
        : "Aggiornamento finito con problemi: vedi gli avvisi in giallo.", 6500);
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

// keepProfile: il Profilo non si ricostruisce (aggiornamento in sottofondo mentre si scrive in un suo campo)
function render({ keepProfile = false } = {}) {
  syncBack();
  renderFresh();
  if (!data) return;
  if (gridStale || !$("#results-list .hero")) {
    gridStale = false;
    buildSheetGrid();
    buildResults();
    applySearch($("#hero-q"));
  }
  renderControls();
  starCache = new Map(); // tacche ricalcolate a ogni giro
  renderPicks();
  renderGridNote();
  if (startOpen()) renderStart();
  if ($("#hero-sheet").open) renderSheet();
  if (!$("#view-profile").hidden && !keepProfile) renderProfile();
}

function showView(name) {
  if (startOpen()) closeStart();
  $("#view-match").hidden = name !== "match";
  $("#view-profile").hidden = name !== "profile";
  $$(".tabs [data-view]").forEach((b) => (b.dataset.view === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  if (name === "profile" && data) renderProfile();
  store.set("owc.view", name);
  syncBack();
  window.scrollTo(0, 0);
  // i nomi si misurano solo a vista (nascosti hanno larghezza 0)
  if (name === "match" && data) { renderPicks(); renderControls(); }
  updateMini();
}

function wire() {
  fillIcons(document);
  for (const id of ["hero-q", "fav-q", "map-q", "photo-q"]) wireSearch(id);
  wireHeroSearch();
  wirePhoto();
  $$(".tabs [data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  $$("#side button, #start-side button").forEach((b) => b.addEventListener("click", () => {
    match.side = match.side === b.dataset.side ? null : b.dataset.side;
    saveMatch(); render();
  }));
  // la mappa e i ban della testata portano all'Inizio partita (modo «modifica»); da lì si sceglie la mappa
  $("#map-btn").addEventListener("click", () => openStart("edit"));
  $("#bans-btn").addEventListener("click", () => openStart("edit"));
  $("#start-map").addEventListener("click", () => { buildMapDialog(); resetSearch("map-q"); $("#map-dialog").showModal(); });
  $("#start-next").addEventListener("click", startNext);
  $("#start-cancel").addEventListener("click", startCancel);
  $("#start-photo").addEventListener("click", onPhotoButton);
  $("#map-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-map]");
    if (!b) return;
    if (mapFor === "photo" && ph) { // dal foglio della foto: cambia la mappa letta, la partita solo alla conferma
      ph.mapSlug = b.dataset.map || null;
      ph.mapChosen = true;
      if (!hasSides(currentMapOf(ph.mapSlug))) ph.side = null;
      $("#map-dialog").close();
      renderPhoto();
      return;
    }
    match.mapSlug = b.dataset.map || null;
    if (!hasSides(currentMap())) match.side = null;
    saveMatch();
    $("#map-dialog").close();
    render();
  });
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  $("#fav-dialog").addEventListener("close", () => render());
  // Nuova partita: si apre l'Inizio partita; la partita di prima resta da parte («Annulla» lì, o nel messaggio dopo «Avanti»)
  $("#new-match").addEventListener("click", () => openStart("new"));
  $("#hero-sheet").addEventListener("close", () => { closeSearch(); sheetCtx = null; });
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

// ---------- foto del tabellone (Claude) ----------
// Pulsante grande al centro della barra: foto del tabellone → Claude Sonnet 5.5 legge mappa, lato ed eroi (photo.js) →
// foglio da confermare o correggere (ogni eroe, la mappa e il lato si cambiano con un tocco; dove Claude non è sicuro
// propone accanto altri eroi) → la partita si compila da sola. Le foto restano solo in memoria, al massimo MAX_PHOTOS
// (servono per "Riprova"), poi si scartano; la chiave API resta in localStorage, mai nel codice.
const KEY_STORE = "owc.claudeKey";
const PHOTO_TIMEOUT_MS = 60e3;
const PHOTO_EDGE = 1600; // lato lungo della foto inviata (px): i nomi dei giocatori restano leggibili
const photos = []; // [{b64, thumb}], le ultime MAX_PHOTOS
window.owcPhotos = () => photos.length; // per il collaudo
let ph = null; // foglio della foto: {photo, state: "loading" | "error" | "result", ...}
let photoAbort = null;
let photoTimer = null;
let sheet = { sig: "", promise: null };
let phPick = null; // riga che si sta correggendo: {key: "ours" | "enemies", k}
let mapFor = null; // "photo": la mappa scelta va al foglio della foto, non alla partita

const claudeKey = () => store.get(KEY_STORE, "");
const nickOf = (i) => String(profile.players[i].nick || "").trim();
const photoNeedsSetup = () => !claudeKey() || (!profile.photoSetupSeen && profile.players.some((_, i) => !nickOf(i)));
const takePhoto = () => $("#photo-input").click();
const galleryLink = () => el("button", { type: "button", class: "link-btn", onclick: () => $("#photo-gallery").click() },
  icon("photo"), "Scegli una foto dalla galleria");
// nel foglio le mappe vanno col nome inglese dei dati (quello che Claude conosce), con l'italiano del gioco accanto
const photoMaps = () => ({
  maps: data.maps.map((m) => ({ slug: m.slug, name: m.en || m.name, mode: m.mode })),
  it: Object.fromEntries(data.maps.map((m) => [m.en || m.name, m.name])),
});

function onPhotoButton() {
  if (!data) return;
  if (photoNeedsSetup()) openPhotoSetup();
  else takePhoto();
}

// Prima volta (o chiave rifiutata): chiave API e nome nel gioco di ciascuno, poi subito la fotocamera.
function openPhotoSetup(reason = "", then = takePhoto) {
  const hasKey = !!claudeKey();
  fill($("#photo-setup-body"),
    el("p", { class: "ph-intro" }, "Fotografa il tabellone (durante la partita, o alla scelta degli eroi): Claude legge mappa, " +
      "attacco/difesa ed eroi delle due squadre, tu confermi o correggi con un tocco."),
    reason ? el("p", { class: "ph-warn", role: "alert" }, reason) : null,
    el("label", { for: "ps-key" }, hasKey ? "Chiave API di Claude (salvata ✓)" : "Chiave API di Claude"),
    el("input", { id: "ps-key", type: "password", autocomplete: "off", spellcheck: "false", enterkeyhint: "next", autofocus: !hasKey,
      placeholder: hasKey ? "salvata ✓ (incollane una nuova per sostituirla)" : "sk-ant-…" }),
    el("p", { class: "muted small" }, "Si crea su console.anthropic.com → API Keys. Resta solo su questo telefono."),
    el("h3", { class: "ph-sub" }, profile.players.length > 1 ? "I vostri nomi nel gioco" : "Il tuo nome nel gioco"),
    el("p", { class: "muted small" }, "Come appaiono nel tabellone: servono a capire quale riga è di chi."),
    profile.players.map((p, i) => [
      el("label", { for: `ps-nick${i}`, style: `--pc: var(--p${i})` }, el("span", { class: "p-dot", "aria-hidden": "true" }), p.name),
      el("input", { id: `ps-nick${i}`, value: p.nick || "", maxlength: "32", autocomplete: "off", autocapitalize: "off",
        spellcheck: "false", placeholder: "Nome nel gioco", enterkeyhint: i === profile.players.length - 1 ? "done" : "next" }),
    ]),
    el("div", { class: "ph-actions" },
      el("button", { type: "button", id: "ps-go", class: "btn primary", onclick: () => {
        const k = $("#ps-key").value.trim();
        if (k) store.set(KEY_STORE, k);
        profile.players.forEach((p, i) => { p.nick = $(`#ps-nick${i}`).value.trim(); });
        profile.photoSetupSeen = true;
        saveProfile();
        if (!claudeKey()) { toast("Incolla prima la chiave API di Claude."); $("#ps-key").focus(); return; }
        $("#photo-setup").close();
        then(); // ancora dentro il tocco: il telefono apre la fotocamera
      } }, icon(then === takePhoto ? "camera" : "check"), then === takePhoto ? "Salva e scatta" : "Salva e riprova")),
  );
  // Invio sulla tastiera: al campo dopo, e dall'ultimo sul pulsante "Salva e scatta" (un altro Invio lo preme)
  const fields = $$("#photo-setup-body input");
  fields.forEach((f, k) => f.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    (k < fields.length - 1 ? fields[k + 1] : $("#ps-go")).focus();
  }));
  $("#photo-setup").showModal();
}

const loadImage = (src) => new Promise((ok, ko) => {
  const img = new Image();
  img.onload = () => ok(img);
  img.onerror = ko;
  img.src = src;
});

// foto → JPEG ridotto (base64, per Claude) + miniatura (per il foglio); l'originale non si tiene
async function preparePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const draw = (w, h, q) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      return c.toDataURL("image/jpeg", q);
    };
    const s = Math.min(1, PHOTO_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
    const full = draw(w, h, 0.85);
    const t = Math.min(1, 480 / Math.max(w, h));
    return { b64: full.slice(full.indexOf(",") + 1), thumb: draw(Math.round(w * t), Math.round(h * t), 0.7) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function onPhotoFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // la stessa foto si può scegliere di nuovo
  if (!file || !data) return;
  let photo;
  try { photo = await preparePhoto(file); } catch { toast("Non riesco ad aprire questa foto: riprova."); return; }
  photos.push(photo);
  while (photos.length > MAX_PHOTOS) photos.shift();
  recognize(photo);
}

// Foglio di riferimento: i ritratti ufficiali (heroes/<slug>.webp, stessa origine) con il nome sotto, per gli eroi che
// Claude conosce meno (i più nuovi). Si costruisce una volta; uguale a ogni foto, resta nella cache dei prompt.
const SHEET_COLS = 9, SHEET_CELL = 112, SHEET_LABEL = 22;
function buildSheet() {
  const sig = data.heroes.map((h) => h.slug).join("|");
  if (sheet.sig === sig) return sheet.promise;
  const order = (h) => ROLES.findIndex(([r]) => r === h.role);
  const heroes = [...data.heroes].sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  const promise = Promise.all(heroes.map((h) => loadImage(`heroes/${h.slug}.webp`).catch(() => null))).then((imgs) => {
    if (imgs.filter(Boolean).length < heroes.length / 2) return null; // icone non copiate: meglio niente
    const c = document.createElement("canvas");
    c.width = SHEET_COLS * SHEET_CELL;
    c.height = Math.ceil(heroes.length / SHEET_COLS) * (SHEET_CELL + SHEET_LABEL);
    const g = c.getContext("2d");
    g.fillStyle = "#14161f";
    g.fillRect(0, 0, c.width, c.height);
    g.font = "600 15px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#fff";
    heroes.forEach((h, k) => {
      const x = (k % SHEET_COLS) * SHEET_CELL, y = Math.floor(k / SHEET_COLS) * (SHEET_CELL + SHEET_LABEL);
      if (imgs[k]) g.drawImage(imgs[k], x + 4, y + 4, SHEET_CELL - 8, SHEET_CELL - 8);
      g.fillText(h.name, x + SHEET_CELL / 2, y + SHEET_CELL + SHEET_LABEL / 2 - 2, SHEET_CELL - 6);
    });
    const url = c.toDataURL("image/jpeg", 0.85);
    return url.slice(url.indexOf(",") + 1);
  }).catch(() => null);
  sheet = { sig, promise };
  return promise;
}

// prezzi di Sonnet 5.5 in $ per milione di token: ingresso 2, scrittura in cache 2,5, lettura dalla cache 0,2, uscita 10
function photoCost(u) {
  if (!u) return null;
  return ((u.input_tokens || 0) * 2 + (u.cache_creation_input_tokens || 0) * 2.5
    + (u.cache_read_input_tokens || 0) * 0.2 + (u.output_tokens || 0) * 10) / 1e6;
}

async function recognize(photo) {
  if (photoAbort) photoAbort.abort();
  const ctl = new AbortController();
  photoAbort = ctl;
  const t0 = Date.now();
  ph = { photo, state: "loading" };
  renderPhoto();
  if (!$("#photo-dialog").open) $("#photo-dialog").showModal();
  clearInterval(photoTimer);
  photoTimer = setInterval(() => {
    const s = $("#ph-secs");
    if (s) s.textContent = `${Math.round((Date.now() - t0) / 1000)} s`;
  }, 1000);
  const timeout = setTimeout(() => ctl.abort(), PHOTO_TIMEOUT_MS);
  const pm = photoMaps();
  let res;
  try {
    const ref = await buildSheet();
    const ask = async (fallback) => {
      const body = photoRequest({ heroes: data.heroes, maps: pm.maps, mapsIt: pm.it, photo: photo.b64, sheet: ref, fallback,
        nicknames: profile.players.map((_, i) => nickOf(i)) });
      const r = await fetch(API_URL, { method: "POST", headers: photoHeaders(claudeKey(), { fallback }), body: JSON.stringify(body), signal: ctl.signal });
      let j = null;
      try { j = await r.json(); } catch { /* risposta non JSON */ }
      return { status: r.status, ok: r.ok, body: j };
    };
    res = await ask(true);
    // il ripiego su un altro modello non è attivo per questa chiave: si riprova una volta senza
    if (isFallbackRejection(res.status, res.body)) res = await ask(false);
  } catch {
    res = { status: 0, ok: false, timedOut: ctl.signal.aborted };
  } finally {
    clearTimeout(timeout);
    clearInterval(photoTimer);
  }
  if (photoAbort !== ctl) return; // foglio chiuso o un'altra foto nel frattempo
  photoAbort = null; // (il foglio resta aperto col risultato: la versione nuova aspetta che si chiuda)
  if (!res.ok) {
    ph = { photo, state: "error", status: res.status,
      msg: res.timedOut ? "Claude non ha risposto entro un minuto: riprova." : photoError(res.status, res.body) };
    renderPhoto();
    return;
  }
  const read = readPhotoResponse(res.body, { heroes: data.heroes, maps: pm.maps });
  if (read.error) { ph = { photo, state: "error", status: res.status, msg: read.error }; renderPhoto(); return; }
  ph = resultState(photo, read.result, { secs: (Date.now() - t0) / 1000, cost: photoCost(read.usage) });
  renderPhoto();
}

// Risultato di Claude → foglio da modificare: 5 righe per squadra (quelle non lette restano da riempire a mano).
function resultState(photo, r, meta) {
  const rows = (list) => {
    const out = list.slice(0, 5).map((x) => ({ ...x, doubt: !x.sure, fixed: false, empty: false }));
    while (out.length < 5) out.push({ nickname: "", heroId: null, sure: true, alts: [], doubt: false, fixed: false, empty: true });
    return out;
  };
  const ours = rows(r.ours);
  const owners = matchOwners(ours, profile.players.map((_, i) => nickOf(i)));
  ours.forEach((row, k) => { row.owner = owners[k]; });
  // mappa non letta: resta quella già scelta nella partita (se c'è), altrimenti nessuna
  const mapSlug = r.mapSlug || match.mapSlug || null;
  // ban: quelli letti (in alto a destra, sotto la mappa); se la foto non ne ha (partita rapida) quelli già segnati
  const kept = r.bans.length ? [] : match.bans.map(sid);
  const bans = (r.bans.length ? r.bans.map((b) => ({ ...b, doubt: !b.sure })) : kept.map((id) => ({ heroId: id, sure: true, alts: [], doubt: false })))
    .map((b) => ({ ...b, fixed: false, empty: false }));
  while (bans.length < MAX_BANS) bans.push({ heroId: null, sure: true, alts: [], doubt: false, fixed: false, empty: true });
  return {
    photo, state: "result", view: "summary", scoreboard: r.scoreboard, ours, enemies: rows(r.enemies), ...meta,
    bans, bansRead: r.bans.length, bansKept: kept.length,
    mapSlug, mapRead: !!r.mapSlug, mapKept: !r.mapSlug && !!mapSlug, mapChosen: false,
    side: r.side || (mapSlug === match.mapSlug ? match.side : null), sideRead: !!r.side,
  };
}

function renderPhoto() {
  const body = $("#photo-body");
  if (!ph) { body.replaceChildren(); return; }
  const thumb = el("img", { class: "ph-thumb", alt: "La foto scattata" });
  thumb.src = ph.photo.thumb; // fuori da el(): il testo base64 non passa dalla traduzione dei nomi
  if (ph.state === "loading") {
    $("#t-photo").textContent = "Lettura della foto";
    fill(body,
      el("div", { class: "ph-loading" }, thumb, el("div", { class: "ph-spin", "aria-hidden": "true" }),
        el("p", { role: "status" }, "Claude sta leggendo il tabellone… ", el("b", { id: "ph-secs" }, "0 s")),
        el("p", { class: "muted small" }, "Di solito bastano pochi secondi.")),
      el("div", { class: "ph-actions" }, el("button", { type: "button", class: "btn", onclick: () => $("#photo-dialog").close() }, "Annulla")));
    return;
  }
  if (ph.state === "error") {
    $("#t-photo").textContent = "Foto non letta";
    const keyIssue = ph.status === 401 || ph.status === 403;
    fill(body,
      el("div", { class: "ph-loading" }, thumb, el("p", { class: "ph-warn", role: "alert" }, ph.msg)),
      el("div", { class: "ph-actions" },
        keyIssue
          ? el("button", { type: "button", class: "btn", onclick: () => openPhotoSetup(ph.msg, () => recognize(ph.photo)) }, "Cambia chiave")
          : el("button", { type: "button", class: "btn", onclick: () => recognize(ph.photo) }, "Riprova"),
        el("button", { type: "button", class: "btn primary", onclick: takePhoto }, icon("camera"), "Scatta di nuovo")),
      galleryLink());
    return;
  }
  $("#t-photo").textContent = "Dalla foto";
  const map = data.maps.find((m) => m.slug === ph.mapSlug) ?? null;
  const sides = hasSides(map);
  const mapNote = ph.mapChosen ? (map ? "Scelta da te" : "Senza mappa: consigli sui dati generali")
    : ph.mapRead ? "Letta dalla foto"
      : ph.mapKept ? "Non letta nella foto: resta quella scelta prima (tocca per cambiarla)"
        : "Mappa non riconosciuta: sceglila tu, oppure conferma senza";
  const noteEl = () => el("p", { id: "ph-map-note", class: `ph-note ${ph.mapRead || (ph.mapChosen && map) ? "n-ok" : "n-warn"}` }, mapNote);
  const sideSeg = (cls) => el("div", { class: `seg ph-side ${cls}`, role: "group", "aria-label": "Lato" },
    [["attack", "Attacco"], ["defense", "Difesa"]].map(([k, label]) => el("button", {
      type: "button", "data-side": k, "aria-pressed": String(ph.side === k), "aria-label": label,
      onclick: () => { ph.side = ph.side === k ? null : k; ph.sideRead = false; renderPhoto(); },
    }, cls === "sb-side" ? (k === "attack" ? "ATT" : "DIF") : label)));
  if (ph.view !== "edit") { renderSummary(body, map, sides, noteEl, sideSeg); return; }
  const head = el("div", { class: "ph-head" },
    el("button", { type: "button", class: "ph-thumb-btn", "aria-label": "Ingrandisci la foto", onclick: () => head.classList.toggle("big") }, thumb),
    el("div", { class: "ph-head-main" },
      el("button", { type: "button", id: "ph-map", class: `map-btn ph-map${map ? "" : " empty"}`, "aria-haspopup": "dialog", onclick: openPhotoMap },
        el("span", { class: "map-label" }, "Mappa: "),
        el("span", { class: "map-name" }, map ? [map.name, el("span", { class: "map-mode" }, ` · ${MODE_IT[map.mode] ?? map.mode}`)] : "Nessuna mappa"),
        el("span", { class: "ic-slot chev" }, icon("chevron"))),
      noteEl(),
      sides ? sideSeg("") : null,
      sides ? el("p", { class: `ph-note${ph.side ? "" : " n-warn"}` },
        ph.side ? (ph.sideRead ? "Lato letto dalla foto" : "Lato scelto da te") : "Attacco o difesa non letti: toccalo tu (facoltativo)") : null));
  // alleati possibili: 5 − giocatori in partita (quelli trovati nella foto, o chi gioca già se la foto non ne trova)
  const owned = new Set(ph.ours.map((r) => r.owner).filter((o) => o >= 0));
  const freeAllies = ph.ours.filter((r) => r.owner < 0 && r.heroId).length;
  const lim = MAX_PLAYERS - (owned.size || present().length);
  fill(body,
    ph.scoreboard ? null : el("p", { class: "ph-warn" }, "In questa foto non vedo il tabellone: scattane un'altra, oppure compila a mano qui sotto."),
    head,
    banSection(),
    teamSection("ours"),
    freeAllies > lim ? el("p", { class: "ph-warn" }, `Al massimo ${lim} alleati: gli altri non verranno segnati. Tocca «Alleato» sulle vostre righe per dire chi è chi.`) : null,
    teamSection("enemies"),
    el("div", { class: "ph-actions sticky" },
      el("button", { type: "button", id: "ph-back", class: "btn", onclick: () => { ph.view = "summary"; renderPhoto(); $("#photo-dialog").scrollTop = 0; } }, "‹ Riepilogo"),
      el("button", { type: "button", id: "ph-confirm", class: "btn primary", onclick: confirmPhoto }, icon("check"), "Conferma")),
    el("button", { type: "button", id: "ph-retake-edit", class: "link-btn", onclick: takePhoto }, icon("camera"), "Scatta di nuovo"),
    galleryLink(),
    el("p", { class: "muted small ph-meta" }, `Letta in ${Math.max(1, Math.round(ph.secs))} s da Claude Sonnet 5.5` +
      (ph.cost != null ? ` · circa ${(ph.cost * 100).toFixed(1).replace(".", ",")} centesimi` : "") +
      `. La foto resta solo in memoria (le ultime ${MAX_PHOTOS}).`),
  );
  for (const t of $$(".ph-hname", body)) fitText(t); // nomi mai spezzati a metà parola (come nella griglia)
}

// Riepilogo (il foglio che si apre dopo la foto; richiesta del 2026-10-24): tutto a colpo d'occhio, senza scorrere, per
// confrontarlo con lo schermo mentre si gioca. In alto mappa (+ Attacco/Difesa) e ban; sotto le due squadre come nel
// tabellone di Overwatch: righe blu (voi) e rosse (avversari) nello stesso ordine della foto, ruolo, volto, eroe, nome.
// Un tocco su una riga o un ban lo cambia (solita lista); "Modifica" apre il foglio completo; "Conferma" e via.
const ROLE_ICON = { Tank: "tank", Damage: "damage", Support: "support" };
function renderSummary(body, map, sides, noteEl, sideSeg) {
  const owned = new Set(ph.ours.map((r) => r.owner).filter((o) => o >= 0));
  const missing = owned.size ? profile.players.map((_, i) => i).filter((i) => !owned.has(i)) : [];
  const named = profile.players.some((_, i) => nickOf(i));
  const doubts = [...ph.bans, ...ph.ours, ...ph.enemies].filter((r) => r.doubt && !r.fixed).length;
  const bans = ph.bans.map((b, k) => ({ b, k })).filter(({ b }) => b.heroId);
  const notes = [
    ph.scoreboard ? null : "In questa foto non vedo il tabellone: scattane un'altra, oppure tocca Modifica.",
    missing.length ? `${missing.map((i) => profile.players[i].name).join(" e ")} non ${missing.length > 1 ? "sono" : "è"} nella foto: fuori da questa partita.` : null,
    !owned.size && named && ph.scoreboard ? "Non vi ho trovato nella foto: tocca Modifica e poi «Alleato» sulla vostra riga." : null,
    doubts ? `${doubts} ${doubts > 1 ? "incerti" : "incerto"} (?): toccal${doubts > 1 ? "i" : "o"} per cambiarl${doubts > 1 ? "i" : "o"}.` : null,
  ].filter(Boolean);
  fill(body,
    el("div", { class: "sb-top" },
      el("div", { class: "sb-top-row" },
        el("button", { type: "button", id: "ph-map", class: `sb-map${map ? "" : " empty"}`, "aria-haspopup": "dialog", onclick: openPhotoMap },
          el("span", { class: "sb-mode" }, map ? (MODE_IT[map.mode] ?? map.mode) : "Mappa"),
          el("span", { class: "sb-mapname" }, map ? map.name : "Nessuna"),
          el("span", { class: "ic-slot chev" }, icon("chevron"))),
        sides ? sideSeg("sb-side") : null),
      noteEl(),
      el("div", { class: "sb-bans" }, el("span", { class: "sb-lab" }, "Ban"),
        bans.length ? bans.map(({ b, k }) => el("button", {
          type: "button", class: `sb-ban${b.doubt && !b.fixed ? " doubt" : ""}`, "data-row": `bans-${k}`,
          "aria-label": `Ban: ${heroName(byId[b.heroId])}${b.doubt && !b.fixed ? " (incerto)" : ""}, tocca per cambiarlo`,
          onclick: () => openPhotoHero("bans", k),
        }, face(byId[b.heroId]), b.doubt && !b.fixed ? el("span", { class: "ph-badge", "aria-hidden": "true" }, "?") : null))
          : el("span", { class: "sb-none" }, "nessuno (partita rapida?)"),
        bans.length && !ph.bansRead && ph.bansKept ? el("span", { class: "sb-none sb-kept" }, "già segnati (non nella foto)") : null)),
    sbTeam("ours"),
    el("div", { class: "sb-vs", "aria-hidden": "true" }, el("span", {}, "VS")),
    sbTeam("enemies"),
    notes.length ? el("p", { class: "sb-note" }, notes.join(" ")) : null, // un solo paragrafo: tutto resta in vista
    ifConfirmed(),
    el("div", { class: "ph-actions sticky sb-actions" },
      el("button", { type: "button", id: "ph-retake", class: "btn sb-icon", "aria-label": "Scatta di nuovo", onclick: takePhoto }, icon("camera")),
      el("button", { type: "button", id: "ph-edit", class: "btn", onclick: () => { ph.view = "edit"; renderPhoto(); $("#photo-dialog").scrollTop = 0; } }, "Modifica"),
      el("button", { type: "button", id: "ph-confirm", class: "btn primary", onclick: confirmPhoto }, icon("check"), "Conferma")));
  for (const t of $$(".sb-hero", body)) fitText(t);
}
// «Se confermi»: cosa direbbero le fasce dopo la conferma (ritratto di chi HA → mossa in arancione). Calcolato con
// compute() su una copia provvisoria della partita (applyPhoto su un clone), senza toccare quella vera.
function photoPlan() {
  const map = data.maps.find((m) => m.slug === ph.mapSlug) ?? null;
  const saved = match;
  try {
    match = applyPhoto(JSON.parse(JSON.stringify(saved)), {
      mapSlug: ph.mapSlug, side: ph.side, sides: hasSides(map),
      ours: ph.ours.map((r) => ({ heroId: r.heroId, owner: r.owner })),
      enemies: ph.enemies.map((r) => ({ heroId: r.heroId })),
      bans: ph.bans.map((r) => ({ heroId: r.heroId })),
    }, { players: profile.players.length }).match;
    match.missing = null;
    fitMatch();
    const res = compute();
    return present().map((i) => {
      const rows = res.lists[i] ?? [];
      const top = rows[0];
      if (!top) return { i, has: null, role: match.roles[i] };
      if (!top.picked) return { i, has: null, role: match.roles[i], verb: "prendi", hero: top.hero, row: top };
      const sw = swapAdvice(playerData(i), T, { hero: top.hero, rows, enemies: match.enemies, guide: guideMode() });
      const to = sw ? rows.find((r) => sid(r.hero.id) === sid(sw.hero.id)) : null;
      return { i, has: top.hero, hasRow: top, role: top.hero.role, verb: sw ? "passa a" : null, hero: sw ? sw.hero : null, row: to, plus: sw ? gainTxt(top, to) : null };
    });
  } catch (e) {
    console.warn("anteprima della foto", e);
    return [];
  } finally {
    match = saved;
  }
}
window.owcPhotoPlan = () => (ph && ph.state === "result" ? photoPlan().map((x) => ({ player: x.i, has: x.has ? sid(x.has.id) : null, move: x.hero ? sid(x.hero.id) : null })) : null);
function ifConfirmed() {
  const plan = photoPlan();
  if (!plan.length) return null;
  return el("section", { class: "sc", "aria-label": "Se confermi" }, el("h3", { class: "sc-h" }, "Se confermi"),
    plan.map((x) => el("div", { class: "sc-row", style: `--pc: var(--p${x.i})`, "data-player": String(x.i) },
      el("b", { class: "sc-name" }, profile.players[x.i].name),
      x.has ? heroFace(x.has) : emptyFace(x.role),
      x.hero ? [el("span", { class: "ar", "aria-hidden": "true" }, "→"), heroFace(x.hero, "prop sm"), el("b", { class: "sc-hero" }, x.hero.name),
        x.plus ? el("span", { class: "plus" }, x.plus) : null]
        : el("span", { class: "stay3 sm" }, icon("check"), x.has ? "resta" : "nessun consiglio"))));
}

function sbTeam(key) {
  const ours = key === "ours";
  return el("section", { class: `sb-team ${ours ? "sb-ours" : "sb-enemies"}`, "aria-label": ours ? "La vostra squadra" : "Avversari" },
    ph[key].map((r, k) => {
      const h = r.heroId ? byId[r.heroId] : null;
      const role = h ? h.role : r.role;
      const unsure = r.doubt && !r.fixed;
      const mine = ours && r.owner >= 0;
      return el("button", {
        type: "button", class: `sb-row${mine ? " mine" : ""}${h || unsure ? "" : " empty"}${r.dead ? " dead" : ""}`, "data-row": `${key}-${k}`, style: mine ? `--pc: var(--p${r.owner})` : null,
        "aria-label": `${h ? heroName(h) : "nessun eroe"}${r.nickname ? `, ${r.nickname}` : ""}${mine ? ` (${profile.players[r.owner].name})` : ""}${r.dead ? ", morto" : ""}${unsure ? ", incerto" : ""}: tocca per cambiarlo`,
        onclick: () => openPhotoHero(key, k),
      },
      el("span", { class: `sb-role${role ? ` r-${role}` : ""}`, "aria-hidden": "true" }, role ? icon(ROLE_ICON[role]) : null),
      el("span", { class: "sb-face" }, h ? face(h) : el("span", { class: "face" }, r.empty ? "" : "?"),
        unsure ? el("span", { class: "ph-badge", "aria-hidden": "true" }, "?") : null),
      el("span", { class: "sb-hero" }, h ? heroName(h) : r.empty ? "—" : unsure ? "Non riconosciuto" : "Non scelto"),
      el("span", { class: "sb-nick" }, r.nickname || ""),
      mine ? el("span", { class: "sb-who" }, profile.players[r.owner].name) : null);
    }));
}

// Ban: una fila di riquadri (4 in Ranked); incerti con "?" e le alternative sotto; un tocco apre la lista per cambiarlo
function banSection() {
  const inPlay = new Set([...ph.ours, ...ph.enemies].map((r) => r.heroId).filter(Boolean));
  const clash = ph.bans.filter((b) => b.heroId && inPlay.has(b.heroId)).map((b) => heroName(byId[b.heroId]));
  const note = ph.bansRead ? ["n-ok", "Letti dalla foto"]
    : ph.bansKept ? ["n-warn", "Non visti nella foto: restano quelli segnati prima"]
      : ["", "Nessun ban nella foto (partita rapida?): tocca + per aggiungerne"];
  return el("section", { class: "ph-team ph-bans", "aria-label": "Ban" },
    // tanti riquadri quanti ban (4, o 5 se ne erano segnati 5 prima): il contatore dice quanti ce ne sono davvero
    el("h3", { class: "ph-team-title" }, "Ban", el("span", { class: "ph-count" }, `${ph.bans.filter((b) => b.heroId).length}/${ph.bans.length}`)),
    el("p", { id: "ph-ban-note", class: `ph-note ${note[0]}` }, note[1]),
    el("div", { class: `ph-ban-strip n${ph.bans.length}` }, ph.bans.map((b, k) => {
      const h = b.heroId ? byId[b.heroId] : null;
      const unsure = b.doubt && !b.fixed;
      return el("button", {
        type: "button", class: `ph-hero ph-ban${h ? " has" : " none"}${unsure ? " doubt" : ""}`, "data-row": `bans-${k}`,
        "aria-label": h ? `Ban: ${heroName(h)}${unsure ? " (incerto)" : ""}, tocca per cambiarlo` : "Aggiungi un ban",
        onclick: () => openPhotoHero("bans", k),
      }, h ? face(h) : el("span", { class: "face" }, "+"), el("span", { class: "ph-hname" }, h ? heroName(h) : "Aggiungi"),
      unsure ? el("span", { class: "ph-badge", "aria-hidden": "true" }, "?") : null);
    })),
    ph.bans.map((b, k) => (b.doubt && b.alts.length ? el("div", { class: "ph-alts ph-ban-alts" },
      el("span", { class: "ph-alts-lab" }, `Ban ${k + 1}, ${b.fixed ? "oppure" : "forse"}:`),
      b.alts.map((id) => el("button", { type: "button", class: "ph-alt", "data-alt": id, "aria-label": `Ban ${k + 1}: metti ${heroName(byId[id])}`,
        onclick: () => swapAlt("bans", k, id) }, face(byId[id]), heroName(byId[id])))) : null)),
    clash.length ? el("p", { class: "ph-warn" }, `${clash.join(" e ")} ${clash.length > 1 ? "sono" : "è"} in campo: non ${clash.length > 1 ? "li" : "lo"} segno tra i ban.`) : null);
}

function ownerHint() {
  const named = profile.players.map((p, i) => ({ p, i })).filter(({ i }) => nickOf(i));
  if (!named.length) return "Tocca «Alleato» sulla tua riga per dire che sei tu (o scrivi il tuo nome nel gioco nel Profilo).";
  const missing = profile.players.filter((_, i) => !ph.ours.some((r) => r.owner === i)).map((p) => p.name);
  if (missing.length && ph.ours.some((r) => r.owner >= 0)) {
    return `Non nella foto: ${missing.join(" e ")} → fuori da questa partita. Se c'è, tocca «Alleato» sulla sua riga.`;
  }
  if (missing.length) return "Non vi ho trovato: tocca «Alleato» sulla vostra riga per dire chi siete.";
  return "Tocca il nome a destra per cambiare chi è chi.";
}

function teamSection(key) {
  const ours = key === "ours";
  const rows = ph[key];
  return el("section", { class: `ph-team ${ours ? "ph-ours" : "ph-enemies"}`, "aria-label": ours ? "La vostra squadra" : "Avversari" },
    el("h3", { class: "ph-team-title" }, ours ? "La vostra squadra" : "Avversari",
      el("span", { class: "ph-count" }, `${rows.filter((r) => r.heroId).length}/5 eroi`)),
    ours ? el("p", { class: "muted small ph-hint" }, ownerHint()) : null,
    rows.map((r, k) => photoRow(key, r, k)));
}

function photoRow(key, r, k) {
  const h = r.heroId ? byId[r.heroId] : null;
  const unsure = r.doubt && !r.fixed;
  const tile = el("button", {
    type: "button", class: `ph-hero${h ? "" : " none"}${unsure ? " doubt" : ""}`, "data-row": `${key}-${k}`,
    "aria-label": h ? `${heroName(h)}${unsure ? " (incerto)" : ""}: tocca per cambiarlo` : "Nessun eroe: tocca per sceglierlo",
    onclick: () => openPhotoHero(key, k),
  }, h ? face(h) : el("span", { class: "face" }, r.empty ? "+" : "?"),
  el("span", { class: "ph-hname" }, h ? heroName(h) : r.empty ? "Aggiungi" : unsure ? "Non riconosciuto" : "Non scelto"),
  unsure ? el("span", { class: "ph-badge", "aria-hidden": "true" }, "?") : null);
  const alts = r.doubt && r.alts.length ? el("div", { class: "ph-alts" },
    el("span", { class: "ph-alts-lab" }, unsure ? "Forse:" : "Oppure:"),
    r.alts.map((id) => el("button", { type: "button", class: "ph-alt", "data-alt": id, "aria-label": `Metti ${heroName(byId[id])}`,
      onclick: () => swapAlt(key, k, id) }, face(byId[id]), heroName(byId[id])))) : null;
  return el("div", { class: `ph-row${key === "ours" && r.owner >= 0 ? " mine" : ""}${r.dead ? " dead" : ""}`, style: key === "ours" && r.owner >= 0 ? `--pc: var(--p${r.owner})` : null },
    tile,
    el("div", { class: "ph-mid" },
      el("div", { class: "ph-who" },
        el("span", { class: `ph-nick${r.nickname ? "" : " faint"}` }, r.nickname || (r.empty ? "riga non letta" : "nome non letto")),
        key === "ours" ? ownerChip(r, k) : null),
      alts));
}

// di chi è la riga: Alleato → giocatore 1 → … → Alleato; ogni giocatore su una riga sola
function ownerChip(r, k) {
  const label = r.owner >= 0 ? profile.players[r.owner].name : "Alleato";
  return el("button", {
    type: "button", class: `ph-owner${r.owner >= 0 ? " is-player" : ""}`, style: r.owner >= 0 ? `--pc: var(--p${r.owner})` : null,
    "aria-label": `Riga di: ${label}. Tocca per cambiare`, onclick: () => {
      let next = r.owner + 1;
      if (next >= profile.players.length) next = -1;
      if (next >= 0) for (const o of ph.ours) if (o !== r && o.owner === next) o.owner = -1;
      r.owner = next;
      renderPhoto();
    },
  }, r.owner >= 0 ? el("span", { class: "p-dot", "aria-hidden": "true" }) : null, label);
}

// eroe della riga cambiato a mano; nella stessa squadra un eroe una volta sola: chi lo aveva prende quello di prima
function setPhotoHero(key, k, id) {
  const rows = ph[key];
  const r = rows[k];
  const prev = r.heroId;
  if (id) {
    const other = rows.find((o, j) => j !== k && o.heroId === id);
    if (other) { other.heroId = prev; other.fixed = true; }
  }
  r.heroId = id;
  r.fixed = true;
  r.empty = false;
}
function swapAlt(key, k, id) {
  const r = ph[key][k];
  const prev = r.heroId;
  setPhotoHero(key, k, id);
  r.alts = r.alts.map((a) => (a === id ? prev : a)).filter(Boolean); // quello di prima resta tra le alternative
  renderPhoto();
}

function openPhotoHero(key, k) {
  phPick = { key, k };
  const r = ph[key][k];
  $("#t-photo-hero").textContent = key === "bans" ? `Ban ${k + 1}` : r.nickname ? `Eroe di ${r.nickname}` : key === "ours" ? "Eroe della vostra squadra" : "Eroe avversario";
  const grid = $("#photo-grid");
  buildHeroGrid(grid, (id) => {
    setPhotoHero(phPick.key, phPick.k, id);
    $("#photo-hero").close();
    renderPhoto();
  });
  const team = new Set(ph[key].map((o) => o.heroId).filter(Boolean));
  for (const b of $$(".hero", grid)) {
    b.setAttribute("aria-pressed", String(b.dataset.id === r.heroId));
    b.classList.toggle(key === "ours" ? "in-allies" : key === "bans" ? "in-bans" : "in-enemies", team.has(b.dataset.id));
  }
  resetSearch("photo-q");
  $("#photo-hero").showModal();
  fitNames(grid);
}

function openPhotoMap() {
  mapFor = "photo";
  buildMapDialog(ph.mapSlug);
  resetSearch("map-q");
  $("#map-dialog").showModal();
}

function confirmPhoto() {
  const before = JSON.stringify(match);
  const map = data.maps.find((m) => m.slug === ph.mapSlug) ?? null;
  const { match: next, dropped, gone, back } = applyPhoto(match, {
    mapSlug: ph.mapSlug, side: ph.side, sides: hasSides(map),
    ours: ph.ours.map((r) => ({ heroId: r.heroId, owner: r.owner })),
    enemies: ph.enemies.map((r) => ({ heroId: r.heroId })),
    bans: ph.bans.map((r) => ({ heroId: r.heroId })),
  }, { players: profile.players.length });
  match = next;
  match.missing = null; // la foto dice com'è la partita adesso: niente da rimettere di quella di prima
  match.started = true; // dalla foto si va alla Partita (anche se la foto è partita dall'Inizio partita)
  prevMatch = null;
  fitMatch();
  saveMatch();
  $("#photo-dialog").close();
  showView("match");
  render();
  const names = (ix) => ix.map((i) => profile.players[i].name).join(" e ");
  toast(`Partita compilata dalla foto ✓${dropped.length ? ` (${dropped.length} alleat${dropped.length > 1 ? "i" : "o"} in più non segnat${dropped.length > 1 ? "i" : "o"})` : ""}`
    + `${gone.length ? ` · ${names(gone)} non in partita` : ""}${back.length ? ` · ${names(back)} di nuovo in partita` : ""}`, 6000, {
    label: "Annulla",
    run: undoable(() => { match = JSON.parse(before); fitMatch(); saveMatch(); render(); toast("Partita ripristinata.", 2000); }),
  });
}

function wirePhoto() {
  $("#photo-btn").addEventListener("click", onPhotoButton);
  $("#photo-input").addEventListener("change", onPhotoFile);
  $("#photo-gallery").addEventListener("change", onPhotoFile);
  $("#photo-none").addEventListener("click", () => {
    setPhotoHero(phPick.key, phPick.k, null);
    $("#photo-hero").close();
    renderPhoto();
  });
  // chiuso il foglio (anche col tasto indietro): la richiesta in corso si annulla e il risultato si scarta
  $("#photo-dialog").addEventListener("close", () => {
    const c = photoAbort;
    photoAbort = null;
    if (c) c.abort();
    clearInterval(photoTimer);
    ph = null;
    $("#photo-body").replaceChildren();
  });
  $("#map-dialog").addEventListener("close", () => { mapFor = null; });
  $("#claude-save").addEventListener("click", () => {
    const v = $("#claude-key").value.trim();
    if (!v) { toast("Incolla prima la chiave API."); return; }
    store.set(KEY_STORE, v);
    renderProfile();
    toast(v.startsWith("sk-ant-") ? "Chiave salvata su questo telefono." : "Chiave salvata (di solito inizia con sk-ant-: controllala).");
  });
  $("#claude-clear").addEventListener("click", () => { store.del(KEY_STORE); renderProfile(); toast("Chiave rimossa."); });
}

// ---------- tasto/gesto "indietro" di Android ----------
// L'APK torna indietro nella cronologia della pagina (e chiude l'app solo quando non c'è niente prima): ogni "livello"
// aperto — un foglio (mappa, preferiti, Come giocarla, Perché), il Profilo, "Tocca l'eroe preso da…" — è un passo
// nella cronologia. Indietro chiude il livello in cima; chiuso con un pulsante, il passo si toglie da solo.
let backDepth = 0; // passi aggiunti alla cronologia
let ownBack = false; // history.go chiamato dall'app (non dall'utente)
const dialogOrder = []; // fogli aperti, l'ultimo in cima
function wantedDepth() {
  return dialogOrder.length + ($("#view-profile").hidden ? 0 : 1) + (startOpen() ? 1 : 0) + (searching ? 1 : 0);
}
// history.go è asincrono: un pushState fatto prima che arrivi si perderebbe nel salto (visto dopo un ricaricamento con
// Profilo e "Tocca l'eroe preso da…" aperti: un livello senza il suo passo, e "indietro" chiudeva l'app). Finché il salto
// non è arrivato (popstate) non si tocca la cronologia; poi si ricontrolla.
let backTimer = null;
function syncBack() {
  if (ownBack) return;
  const want = wantedDepth();
  while (backDepth < want) { history.pushState({ owc: ++backDepth }, ""); }
  if (backDepth > want) {
    const n = backDepth - want;
    backDepth = want;
    ownBack = true;
    history.go(-n);
    // se il popstate non arrivasse, la cronologia non resta bloccata
    clearTimeout(backTimer);
    backTimer = setTimeout(() => { if (ownBack) { ownBack = false; syncBack(); } }, 1000);
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
      if (!d.open) setTimeout(maybeReload, 0);
    }).observe(d, { attributes: true, attributeFilter: ["open"] });
  }
  window.addEventListener("popstate", () => {
    if (ownBack) { ownBack = false; clearTimeout(backTimer); syncBack(); return; }
    backDepth = Math.max(0, backDepth - 1);
    const top = dialogOrder[dialogOrder.length - 1];
    if (searching) closeSearch(); // la ricerca aperta nella lista eroi è un passo a sé
    else if (top) top.close();
    else if (startOpen()) startNext(); // «indietro» nell'Inizio partita = «Avanti» (si tiene ciò che è stato messo)
    else if (!$("#view-profile").hidden) showView("match");
  });
}

// Un aggiornamento in sottofondo non ridisegna mai sotto il dito: parte da un tocco (pointerdown) e, se i dati arrivano
// prima che il dito si alzi, ricostruire i pulsanti farebbe perdere proprio quel tocco. Si ridisegna solo se i dati sono
// cambiati, a tocco finito; il Profilo non si ricostruisce mentre si scrive in un suo campo (si perderebbe il testo).
// dita (o mouse) appoggiate adesso: id → quando. Un dito "perso" (il sistema non manda mai pointerup: gesto di sistema,
// notifica sopra l'app) dopo 10 s non conta più, così non blocca per sempre ridisegno e ricarica.
const pointers = new Map();
const fingersDown = () => {
  const now = Date.now();
  for (const [id, t] of pointers) if (now - t > 10e3) pointers.delete(id);
  return pointers.size;
};
let refreshRender = null; // {before}: ridisegno in attesa che il tocco finisca
let refreshTimer = null;
const profileBusy = () => !$("#view-profile").hidden && $$("#view-profile input, #view-profile select")
  .some((e) => e === document.activeElement || (e.tagName === "INPUT" && e.value !== e.defaultValue));
function applyRefresh() {
  clearTimeout(refreshTimer);
  if (!refreshRender || fingersDown()) return; // con un dito giù si riprova quando si alza
  const { before } = refreshRender;
  refreshRender = null;
  render({ keepProfile: profileBusy() });
  // senza coprire un messaggio con "Annulla" ancora in vista (es. la scelta appena fatta con quel tocco)
  if (data.checked !== before && !toastAction()) toast("Dati aggiornati ✓", 2500);
}
function wirePointers() {
  document.addEventListener("pointerdown", (e) => { pointers.set(e.pointerId, Date.now()); }, { capture: true, passive: true });
  const up = (e) => {
    pointers.delete(e.pointerId);
    // dopo il "click" che segue il dito alzato
    if (refreshRender && !fingersDown()) { clearTimeout(refreshTimer); refreshTimer = setTimeout(applyRefresh, 350); }
    if (reloadWanted && !fingersDown()) setTimeout(maybeReload, 350);
  };
  document.addEventListener("pointerup", up, { capture: true, passive: true });
  document.addEventListener("pointercancel", up, { capture: true, passive: true });
  // un dito "perso" (gesto di sistema, app in sottofondo) non deve bloccare per sempre il ridisegno
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") pointers.clear();
    maybeReload();
  });
  document.addEventListener("focusout", () => setTimeout(maybeReload, 0));
}

// Versione nuova dell'app (service worker): ricaricare cancella fogli aperti, foto in lettura (già pagata), testo scritto
// e l'"Annulla" in vista. Si aspetta il primo momento libero: controllato a ogni foglio chiuso, messaggio sparito, campo
// lasciato, dito alzato, foto letta; con l'app in sottofondo basta che non ci sia una foto in lettura o da confermare.
let reloadWanted = false;
let reloading = false;
const typing = () => {
  const a = document.activeElement;
  return (!!a && ["INPUT", "SELECT", "TEXTAREA"].includes(a.tagName) && a.type !== "file") || profileBusy() || searching;
};
const photoPending = () => !!photoAbort || $("#photo-dialog").open;
function reloadSafe() {
  if (document.visibilityState === "hidden") return !photoPending();
  return !$$("dialog").some((d) => d.open) && !photoAbort && !toastAction() && !typing() && !fingersDown() && !refreshing;
}
// Il service worker nuovo è installato ma non ha ancora preso la pagina (vedi sw.js, "owc-skip"): glielo si richiede
// subito, poche volte a distanza di secondi, e a ogni momento libero (foglio chiuso, campo lasciato…).
let waitingSW = null;
function nudgeWaiting() {
  if (!waitingSW || waitingSW.state !== "installed") return;
  try { waitingSW.postMessage("owc-skip"); } catch { /* già attivo o scartato */ }
}
function watchWorker(w) {
  if (!w) return;
  const seen = () => {
    if (w.state !== "installed" || !navigator.serviceWorker.controller) return;
    waitingSW = w;
    [0, 500, 1500, 3000, 5000, 8000, 12000, 20000].forEach((ms) => setTimeout(nudgeWaiting, ms));
  };
  w.addEventListener("statechange", seen);
  seen();
}
function maybeReload() {
  if (!reloadWanted) nudgeWaiting();
  if (!reloadWanted || reloading || !reloadSafe()) return;
  reloading = true;
  location.reload();
}
// per il collaudo: se non ricarica, cosa lo impedisce
window.owcReloadState = () => ({ wanted: reloadWanted, waitingSW: waitingSW ? waitingSW.state : null, safe: reloadSafe(), photo: !!photoAbort, toast: toastAction(), typing: typing(),
  fingers: fingersDown(), refreshing });

async function autoRefresh() {
  if (document.visibilityState === "hidden" || refreshing || !lastLoad) return;
  if (Date.now() - lastLoad < AUTO_REFRESH_MS) return;
  // anche l'app stessa: se è uscita una versione nuova, il service worker la installa e la pagina si ricarica (quando si può)
  navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
  const before = data?.checked;
  if (await loadData()) {
    renderFresh(); // solo testi ("controllati … fa"): niente pulsanti sotto il dito
    if (dataChanged) {
      refreshRender = { before: refreshRender ? refreshRender.before : before };
      applyRefresh();
    }
  }
}

async function start() {
  wire();
  wireBack();
  wirePointers();
  document.addEventListener("pointerdown", autoRefresh, { capture: true, passive: true });
  window.addEventListener("scroll", updateMini, { passive: true });
  const refit = () => {
    if (!data) return;
    fitBands();
    fitTips();
    renderMini();
    renderControls();
    if ($("#hero-sheet").open) { delete $("#hs-grid").dataset.fitW; fitNames($("#hs-grid")); }
  };
  window.addEventListener("resize", refit);
  if (document.fonts?.ready) document.fonts.ready.then(refit);
  document.addEventListener("visibilitychange", autoRefresh);
  window.addEventListener("focus", autoRefresh);
  if ("serviceWorker" in navigator) {
    // versione nuova pubblicata: il nuovo service worker prende la pagina e la si ricarica una volta,
    // così non resta aperta (magari per ore nella WebView dell'APK) la versione vecchia
    // ...ma solo quando si può (maybeReload): mai con un foglio aperto, una foto in lettura, un campo in cui si scrive o un
    // messaggio con "Annulla" in vista; appena tutto è chiuso (o l'app va in sottofondo) si ricarica.
    const updating = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!updating) return;
      reloadWanted = true;
      maybeReload();
    });
    navigator.serviceWorker.register("sw.js").then((reg) => {
      watchWorker(reg.waiting);
      watchWorker(reg.installing);
      reg.addEventListener("updatefound", () => watchWorker(reg.installing));
    }).catch(() => {});
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
  // partita mai iniziata (primo avvio, o dopo «Nuova» senza «Avanti»): si apre l'Inizio partita
  if (data && !match.started) openStart("first");
}

start();

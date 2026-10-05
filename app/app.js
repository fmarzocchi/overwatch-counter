import { recommendDuo, breakdown, details, hasSides, withDivision, heroProfile } from "./recommend.js";

const REPO = "fmarzocchi/overwatch-counter";
const WORKFLOW = "update-data.yml";
const LIMITS = { bans: 4, enemies: 5, allies: 5 };
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
const emptyMatch = () => ({
  roles: profile.players.map((p) => p.roles[0] ?? null),
  mapSlug: null, side: null, bans: [], enemies: [], allies: [], group: "enemies",
});

let data = null;
let byId = {};
let profile = store.get("owc.profile", null) ?? defaultProfile();
let match = store.get("owc.match", null) ?? emptyMatch();
let lastDuo = null;
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
  e.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  return e;
}

function toast(msg, ms = 4500) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- dati ----------

async function loadData() {
  try {
    const r = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (!Array.isArray(d.heroes) || !d.heroes.length) throw new Error("dati vuoti");
    data = d;
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
  return (divData[k] ??= withDivision(data, divFiles[k]));
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
  }));
  return recommendDuo(data, {
    players, mapSlug: match.mapSlug, side: match.side, bans: match.bans, enemies: match.enemies, allies: match.allies,
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
    el("h3", {}, title),
    el("ul", { class: "prof-list" }, items.map((x) => el("li", {},
      kind === "map"
        ? el("span", { class: "prof-map" }, el("b", {}, x.subject.name), el("small", {}, MODE_IT[x.subject.mode] ?? x.subject.mode))
        : el("span", { class: "prof-hero" }, face(x.subject), x.subject.name),
      el("span", { class: x.delta >= 0 ? "good" : "bad" }, pctTxt(x.delta))))));
}

function openDetails(i, row) {
  const p = profile.players[i];
  const prof = heroProfile(playerData(i), row.hero.id);
  $("#t-why").textContent = row.hero.name;
  $("#why-body").replaceChildren(
    el("div", { class: "why-head" }, face(row.hero),
      el("div", {}, el("div", { class: "pick-name" }, row.hero.name),
        el("div", { class: "muted" }, `per ${p.name} · stima ${est(row)}`),
        el("div", { class: "muted small" }, `dati: ${dataLabel(i)}`))),
    el("h3", { class: "why-title" }, "Perché in questa partita"),
    el("ul", { class: "why-list" }, details(row).map((d) => el("li", { class: d.good ? "good" : "bad" }, d.text))),
    el("div", { class: "prof-grid" },
      profileSection("Forte contro", prof.strongVs, "hero"),
      profileSection("In difficoltà contro", prof.weakVs, "hero"),
      profileSection("Mappe migliori", prof.bestMaps, "map"),
      profileSection("Funziona bene con", prof.bestWith, "hero")),
    el("p", { class: "muted small" },
      "Ogni valore è lo scarto dal 50% di vittorie (dati counterwatch). La stima li somma: serve a ordinare, non è una certezza."),
  );
  $("#why-dialog").showModal();
  $("#why-body").scrollTop = 0;
}

function renderPicks() {
  const box = $("#picks");
  box.replaceChildren();
  if (!data) return;
  lastDuo = compute();
  profile.players.forEach((p, i) => {
    const rows = lastDuo.lists[i] ?? [];
    const role = match.roles[i];
    const roleBtn = el("button", {
      type: "button", class: "role-btn",
      "aria-label": `Ruolo di ${p.name}: ${role ? ROLE_IT[role] : "qualsiasi"}. Tocca per cambiare`,
      onclick: () => nextRole(i),
    }, role ? ROLE_IT[role] : "Qualsiasi");
    const head = el("div", { class: "pick-head" },
      el("span", { class: "pick-player", title: dataLabel(i) }, p.name, p.rank ? el("small", { class: "pick-rank" }, p.rank) : null),
      roleBtn);
    const top = rows[0];
    if (!top) {
      box.append(el("article", { class: "pick empty" }, head, "Nessun eroe disponibile"));
      return;
    }
    const note = lastDuo.notes?.[i];
    box.append(el("article", { class: "pick", "aria-label": `Consigli per ${p.name}` },
      head,
      profile.onlyFavorites && !note ? el("div", { class: "pick-note" }, "★ solo preferiti") : null,
      note ? el("div", { class: "pick-note warn-note" }, note) : null,
      el("ol", { class: "sugs" }, rows.slice(0, SHOWN).map((r, k) =>
        el("li", {},
          el("button", {
            type: "button", class: `sug${k === 0 ? " first" : ""}`,
            "aria-label": `${k + 1}°: ${r.hero.name}, stima ${est(r)}, ${breakdown(r).map((b) => b.text).join(", ")}. Tocca per i dettagli`,
            onclick: () => openDetails(i, r),
          },
          el("span", { class: "sug-face" }, face(r.hero), el("span", { class: "sug-n", "aria-hidden": "true" }, String(k + 1))),
          el("span", { class: "sug-body" },
            el("span", { class: "sug-top" }, el("span", { class: "sug-name" }, r.hero.name), el("span", { class: "sug-est" }, est(r))),
            breakdown(r).map((b) => el("span", { class: `sug-why ${b.good ? "good" : "bad"}` }, b.text))),
          )))),
    ));
  });
  const h = box.getBoundingClientRect().height;
  document.documentElement.style.setProperty("--picks-h", `${Math.round(h)}px`);
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
  for (const [role, label] of ROLES) {
    const heroes = data.heroes.filter((h) => h.role === role).sort((a, b) => a.name.localeCompare(b.name));
    container.append(
      el("h2", { class: `role-title r-${role}` }, label),
      el("div", { class: "grid" }, heroes.map((h) =>
        el("button", { type: "button", class: "hero", "data-id": sid(h.id), "aria-pressed": "false", onclick: () => onTap(sid(h.id)) },
          face(h), el("span", { class: "nm" }, h.name)))),
    );
  }
}

function groupOf(id) {
  return Object.keys(LIMITS).find((g) => match[g].map(sid).includes(id)) ?? null;
}

function tapHero(id) {
  const g = match.group;
  const cur = groupOf(id);
  if (cur === g) {
    match[g] = match[g].filter((x) => sid(x) !== id);
  } else {
    if (match[g].length >= LIMITS[g]) {
      toast(`Al massimo ${LIMITS[g]} ${GROUP_WORD[g]}: togline uno toccandolo.`);
      return;
    }
    if (cur) match[cur] = match[cur].filter((x) => sid(x) !== id);
    match[g] = [...match[g], id];
  }
  saveMatch();
  render();
}

function renderGrid() {
  const picks = (lastDuo?.lists ?? []).map((rows) => rows[0]?.hero && sid(rows[0].hero.id));
  const favs = new Set(profile.players.flatMap((p) => p.favorites.map(sid)));
  for (const b of $$("#grid .hero")) {
    const id = b.dataset.id;
    const g = groupOf(id);
    b.classList.toggle("in-bans", g === "bans");
    b.classList.toggle("in-enemies", g === "enemies");
    b.classList.toggle("in-allies", g === "allies");
    b.classList.toggle("fav", favs.has(id));
    b.setAttribute("aria-pressed", String(g === match.group));
    b.setAttribute("aria-label", `${byId[id].name}${g ? `, ${GROUP_ONE[g]}` : ""}`);
    $(".tag", b)?.remove();
    const who = picks.indexOf(id);
    b.classList.toggle("pick-0", who === 0);
    b.classList.toggle("pick-1", who === 1);
    if (who >= 0) b.append(el("span", { class: "tag", "aria-hidden": "true" }, initials(profile.players[who].name).slice(0, 1)));
  }
}

function renderGroups() {
  for (const b of $$("#groups button")) {
    const g = b.dataset.group;
    b.setAttribute("aria-pressed", String(g === match.group));
    $(`[data-count="${g}"]`).textContent = match[g].length;
  }
  const box = $("#chosen");
  box.replaceChildren();
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
      el("h2", { id: `p${i}-title` }, i === 0 ? "Giocatore 1" : "Giocatore 2"),
      el("label", { for: nameId }, "Nome"),
      el("input", { id: nameId, value: p.name, maxlength: "16", autocomplete: "off",
        onchange: (e) => { p.name = e.target.value.trim() || (i ? "Lei" : "Io"); saveProfile(); render(); } }),
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
  box.append(el("section", { class: "card" },
    el("h2", {}, "Consigli"),
    el("button", {
      type: "button", class: "toggle wide", "aria-pressed": String(!!profile.onlyFavorites),
      onclick: () => { profile.onlyFavorites = !profile.onlyFavorites; saveProfile(); render(); },
    }, profile.onlyFavorites ? "✓ Suggerisci solo eroi preferiti" : "Suggerisci solo eroi preferiti"),
    el("p", { class: "muted small" },
      "Vale per entrambi: a ognuno si consiglia solo tra i suoi preferiti del ruolo scelto. " +
      "Se non ne resta nessuno (ruolo, ban, alleati) si consiglia tra tutti e lo vedi scritto."),
  ));
  box.append(el("p", { class: "muted small", style: "margin:0 16px" },
    "Il rank sceglie i dati Ranked della vostra divisione (Grandmaster e Campione usano gli stessi, come su counterwatch). " +
    "I preferiti ricevono un piccolo vantaggio (+1%) nei consigli."));
  const tok = store.get("owc.token", "");
  $("#token").value = "";
  $("#token").placeholder = tok ? "token salvato ✓ (inseriscine uno nuovo per sostituirlo)" : "github_pat_…";
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
  if (!$("#view-profile").hidden) renderProfile();
}

function showView(name) {
  $("#view-match").hidden = name !== "match";
  $("#view-profile").hidden = name !== "profile";
  $$(".tabs button").forEach((b) => (b.dataset.view === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  if (name === "profile" && data) renderProfile();
  store.set("owc.view", name);
  window.scrollTo(0, 0);
}

function wire() {
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
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
  $("#new-match").addEventListener("click", () => {
    match = emptyMatch();
    saveMatch();
    render();
    window.scrollTo(0, 0);
    toast("Nuova partita: scegli mappa e ban.");
  });
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

async function start() {
  wire();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const ok = await loadData();
  if (ok) saveMatch();
  render();
  showView(store.get("owc.view", "match") === "profile" ? "profile" : "match");
}

start();

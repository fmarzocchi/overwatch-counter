// Riconoscimento del tabellone da una foto (pulsante "Foto"): la parte pura, senza pagina.
// Una foto del tabellone di Overwatch (fatta col telefono allo schermo della Switch) va a Claude Sonnet 5.5, che
// risponde con un JSON vincolato da uno schema: mappa, lato, i 5 eroi della vostra squadra e i 5 avversari, con il
// nome di ogni giocatore e, quando non è sicuro, fino a 3 alternative. L'app mostra tutto in un foglio da
// confermare o correggere: qui ci sono richiesta, lettura della risposta, abbinamento dei nomi e applicazione
// alla partita, testati in tests/photo.test.js.
//
// Chiamata diretta dal telefono (fetch): l'app è una pagina statica senza build che deve girare anche nella WebView
// di Android 11 (Chrome 83), dove l'SDK ufficiale non funziona senza una compilazione apposta. L'API accetta le
// chiamate dal browser con l'intestazione anthropic-dangerous-direct-browser-access (verificato: CORS aperto).
// La chiave la inserisce l'utente nel Profilo e resta solo sul suo telefono.

export const PHOTO_MODEL = "claude-sonnet-5-5"; // la velocità conta: è il modello veloce scelto dall'utente
export const API_URL = "https://api.anthropic.com/v1/messages";
export const API_VERSION = "2026-10-21";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const MAX_PHOTOS = 5; // foto tenute in memoria (per "Riprova"); le altre si scartano
export const MAX_ALTS = 3;
export const TEAM_SIZE = 5;
export const MAX_BANS = 4; // in Ranked 2 per squadra (le partite rapide non ne hanno)
export const BAN_LIMIT = 5; // ban che l'app tiene per partita (come nella scheda Partita)

const sid = (x) => String(x);
// "SEPHYROT", "Sephyrot ", "sephyr0t" → confrontabili; accenti e simboli via
export const nameKey = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]/g, "");

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });

// Schema della risposta: i nomi di eroi e mappe sono vincolati agli elenchi dei dati (niente nomi inventati).
export function photoSchema(heroNames, mapNames) {
  const hero = { type: "string", enum: heroNames };
  const slot = {
    type: "object",
    additionalProperties: false,
    required: ["nickname", "role", "hero", "sure", "alternatives"],
    properties: {
      nickname: { type: "string", description: "Player name as written in the row" },
      role: nullable({ type: "string", enum: ["Tank", "Damage", "Support"] }),
      hero: nullable(hero),
      sure: { type: "boolean" },
      alternatives: { type: "array", items: hero },
    },
  };
  const ban = {
    type: "object",
    additionalProperties: false,
    required: ["hero", "sure", "alternatives"],
    properties: { hero: nullable(hero), sure: { type: "boolean" }, alternatives: { type: "array", items: hero } },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["scoreboard", "map", "side", "bans", "allies", "enemies"],
    properties: {
      scoreboard: { type: "boolean" },
      map: nullable({ type: "string", enum: mapNames }),
      side: nullable({ type: "string", enum: ["attack", "defense"] }),
      bans: { type: "array", items: ban },
      allies: { type: "array", items: slot },
      enemies: { type: "array", items: slot },
    },
  };
}

const MODE_IT = { Control: "Controllo", Escort: "Scorta", Hybrid: "Ibrida", Push: "Spinta", Flashpoint: "Conquista" };

// Istruzioni fisse (uguali per ogni foto: restano nella cache dei prompt). I nomi dei giocatori vanno nel
// messaggio, perché cambiano.
export function photoSystem(heroes, maps, mapsIt = {}) {
  const heroLines = heroes.map((h) => `${h.name} (${h.role})`).join(", ");
  const mapLines = maps.map((m) => {
    const it = mapsIt[m.name];
    return `${m.name} (${m.mode}${it && it !== m.name ? `; in Italian: ${it}` : ""})`;
  }).join(", ");
  return [
    "You read phone photos of the Overwatch in-game scoreboard (Nintendo Switch 2, game in Italian) and report what it shows.",
    "Layout: the photographer's team is on top (blue rows), the enemy team below (red rows), separated by \"VS\". Each row has a role icon on the left (shield = Tank, three bars = Damage, plus sign = Support), the hero portrait, the player name (sometimes with a title underneath) and stats.",
    "A grey silhouette with a \"?\" instead of a portrait means that player has not picked a hero yet: hero null, sure true. Use the row's role icon to narrow the candidates to that role. The panel on the right, when present, names the hero of the highlighted row: use it.",
    "Heroes: compare face, hair, skin, helmet or mask with the reference sheet (official portraits). Players often use skins, so rely on the overall silhouette and the distinctive features, not only on colors. If you are not certain, set sure false and list up to 3 other likely heroes of the same role in alternatives, best first; if you are certain, alternatives may be empty.",
    "Map: read it only from the header at the top right (\"MODE | MAP\", e.g. \"IBRIDA | PARAÍSO\") and return the matching name from the list; if the header is not readable return null. Never guess the map from the background.",
    "Bans: in competitive matches the banned heroes are shown as small portraits at the top right, right under the map header (usually 4, often greyed out or crossed). List them left to right, at most 4, with the same sure/alternatives rules (alternatives may be of any role). Quick Play has no bans: if no banned portraits are visible, return an empty list. Never take bans from the team rows.",
    "Side: \"attack\" if the objective text says to escort or push the payload or capture the objective (e.g. \"SCORTA IL CARICO\", \"CATTURA L'OBIETTIVO\"), \"defense\" if it says to defend or stop it (\"DIFENDI\", \"FERMA IL CARICO\"); null if no such text is visible.",
    "Player names: copy them as written. If a name is the same as, or almost the same as, one of the app users' names given in the message, write exactly that app user's name.",
    "Rows top to bottom, at most 5 per team. If the photo shows no scoreboard, set scoreboard false and return empty lists.",
    `Heroes: ${heroLines}.`,
    `Maps: ${mapLines}.`,
  ].join("\n");
}

// Corpo e intestazioni della richiesta. photo/sheet: immagini JPEG in base64 (senza "data:"); sheet facoltativo.
export function photoRequest({ heroes, maps, mapsIt, nicknames = [], photo, sheet = null, fallback = true }) {
  const names = nicknames.map((n) => String(n || "").trim()).filter(Boolean);
  const content = [];
  if (sheet) {
    content.push({ type: "text", text: "Reference sheet: official portrait of every hero, labeled with its name." });
    // foglio di riferimento: identico a ogni foto, chiude il prefisso che resta in cache
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: sheet }, cache_control: { type: "ephemeral" } });
  }
  content.push({ type: "text", text: "Scoreboard photo:" });
  content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: photo } });
  content.push({ type: "text", text: names.length
    ? `App users' names in the game: ${names.join(", ")}.`
    : "No app user names are known." });
  const body = {
    model: PHOTO_MODEL,
    max_tokens: 4000,
    // il riconoscimento non ha bisogno di ragionare a lungo: niente pensiero esteso, risposta subito
    thinking: { type: "between_tools" },
    output_config: { effort: "medium", format: { type: "json_schema", schema: photoSchema(heroes.map((h) => h.name), maps.map((m) => m.name)) } },
    system: [{ type: "text", text: photoSystem(heroes, maps, mapsIt), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
  };
  // se un controllo di sicurezza rifiuta, la richiesta passa da sola a un altro modello (vedi isFallbackRejection)
  if (fallback) body.fallbacks = "default";
  return body;
}

export function photoHeaders(key, { fallback = true } = {}) {
  const h = {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": API_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (fallback) h["anthropic-beta"] = FALLBACK_BETA;
  return h;
}

// Un 400 che parla del fallback (beta non attiva per l'account, ecc.): si riprova una volta senza.
export function isFallbackRejection(status, body) {
  const msg = String(body && body.error && body.error.message || "");
  return status === 400 && /fallback|server-side-fallback|anthropic-beta/i.test(msg);
}

// Errori dell'API → frase per l'utente.
export function photoError(status, body) {
  const msg = String(body && body.error && body.error.message || "");
  if (status === 0) return "Nessuna connessione: la foto non è arrivata a Claude. Riprova quando c'è rete.";
  if (status === 401) return "La chiave API non è valida: controllala nel Profilo.";
  if (status === 403) return "La chiave API non può usare questo modello: controlla i permessi nella Console.";
  if (/credit|balance|billing/i.test(msg)) return "Crediti API esauriti: riprova quando arrivano quelli del mese (o controlla la Console).";
  if (status === 429) return "Troppe richieste in poco tempo: riprova tra qualche secondo.";
  if (status === 413) return "Foto troppo grande: riprova.";
  if (status === 529 || status >= 500) return "Claude è sovraccarico in questo momento: riprova tra poco.";
  if (status === 400) return `Richiesta non accettata${msg ? `: ${msg}` : ""}.`;
  return `Errore ${status}${msg ? `: ${msg}` : ""}.`;
}

// Risposta dell'API → {result} oppure {error}. data: i dati dell'app (eroi e mappe validi).
export function readPhotoResponse(resp, data) {
  if (!resp || !Array.isArray(resp.content)) return { error: "Risposta di Claude non leggibile: riprova." };
  if (resp.stop_reason === "refusal") return { error: "Claude non ha voluto leggere questa foto: scattane un'altra." };
  if (resp.stop_reason === "max_tokens") return { error: "Risposta di Claude incompleta: riprova." };
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { error: "Risposta di Claude non leggibile: riprova." }; }
  return { result: normalizeResult(raw, data), usage: resp.usage || null };
}

// JSON del modello → eroi e mappe dei dati (id), al massimo 5 per squadra, alternative valide e diverse.
export function normalizeResult(raw, data) {
  const byName = new Map(data.heroes.map((h) => [nameKey(h.name), h]));
  const mapByName = new Map(data.maps.map((m) => [nameKey(m.name), m]));
  const team = (rows) => {
    const seen = new Set();
    return (Array.isArray(rows) ? rows : []).slice(0, TEAM_SIZE).map((r) => {
      const h = r && r.hero != null ? byName.get(nameKey(r.hero)) : null;
      let sure = !!(r && r.sure);
      let heroId = h ? sid(h.id) : null;
      if (r && r.hero != null && !h) sure = false; // nome sconosciuto: da scegliere
      if (h && r.role && r.role !== h.role) sure = false; // icona del ruolo e ritratto non tornano
      if (heroId && seen.has(heroId)) sure = false; // stesso eroe due volte nella stessa squadra: impossibile
      if (heroId) seen.add(heroId);
      const alts = [];
      for (const a of (r && Array.isArray(r.alternatives) ? r.alternatives : [])) {
        const ah = byName.get(nameKey(a));
        const id = ah ? sid(ah.id) : null;
        if (id && id !== heroId && !alts.includes(id)) alts.push(id);
        if (alts.length >= MAX_ALTS) break;
      }
      // senza eroe: "?" (non ancora scelto) è certo; un nome che non esiste nei dati no
      const none = !r || r.hero == null;
      return { nickname: String(r && r.nickname || "").trim(), heroId, sure: heroId ? sure : none && !!(r && r.sure), alts };
    });
  };
  // ban: stessi criteri degli eroi in campo, al massimo MAX_BANS, senza doppioni
  const bans = [];
  for (const b of (raw && Array.isArray(raw.bans) ? raw.bans : [])) {
    if (bans.length >= MAX_BANS) break;
    const h = b && b.hero != null ? byName.get(nameKey(b.hero)) : null;
    const heroId = h ? sid(h.id) : null;
    if (!heroId && !(b && b.alternatives && b.alternatives.length)) continue; // ritratto illeggibile senza ipotesi
    if (heroId && bans.some((x) => x.heroId === heroId)) continue;
    const alts = [];
    for (const a of (b && Array.isArray(b.alternatives) ? b.alternatives : [])) {
      const ah = byName.get(nameKey(a));
      const aid = ah ? sid(ah.id) : null;
      if (aid && aid !== heroId && !alts.includes(aid)) alts.push(aid);
      if (alts.length >= MAX_ALTS) break;
    }
    bans.push({ heroId, sure: !!(heroId && b.sure), alts });
  }
  const m = raw && raw.map != null ? mapByName.get(nameKey(raw.map)) : null;
  const side = raw && (raw.side === "attack" || raw.side === "defense") ? raw.side : null;
  return {
    scoreboard: !!(raw && raw.scoreboard),
    mapSlug: m ? m.slug : null,
    side,
    bans,
    ours: team(raw && raw.allies),
    enemies: team(raw && raw.enemies),
  };
}

function distance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

// A quale giocatore dell'app appartiene ogni riga della vostra squadra (-1 = alleato). Uguale o quasi uguale
// (una lettera sbagliata, due nei nomi lunghi: la foto può confondere O/0, I/L…); ogni giocatore al massimo una riga.
export function matchOwners(rows, nicknames) {
  const owners = rows.map(() => -1);
  const keys = rows.map((r) => nameKey(r.nickname));
  const pairs = [];
  nicknames.forEach((n, i) => {
    const k = nameKey(n);
    if (!k) return;
    keys.forEach((rk, j) => {
      if (!rk) return;
      const dist = distance(k, rk);
      if (dist <= (k.length <= 5 ? 1 : 2)) pairs.push({ i, j, dist });
    });
  });
  pairs.sort((a, b) => a.dist - b.dist);
  const usedP = new Set();
  for (const p of pairs) {
    if (usedP.has(p.i) || owners[p.j] !== -1) continue;
    owners[p.j] = p.i;
    usedP.add(p.i);
  }
  return owners;
}

// Il foglio confermato → nuova partita. state: {mapSlug, side, sides (la mappa ha attacco/difesa), ours: [{heroId, owner}],
// enemies: [{heroId}], bans: [{heroId}]}. Regole di Overwatch: nella vostra squadra un eroe una volta; gli avversari possono
// avere gli stessi eroi (mirror); un eroe in campo non è bannato. Ban nel foglio → sono i ban della partita (il tabellone li
// mostra tutti); nessun ban nel foglio (partita rapida) → restano quelli segnati prima. Restituisce {match, dropped: [id]}
// (alleati oltre il limite).
export function applyPhoto(match, state, { players, alliesLimit }) {
  const next = JSON.parse(JSON.stringify(match));
  next.mapSlug = state.mapSlug || null;
  next.side = state.sides ? (state.side || null) : null;
  const picked = next.picked.slice(0, players);
  while (picked.length < players) picked.push(null);
  const ours = new Set();
  for (const r of state.ours) {
    if (r.owner >= 0 && r.owner < players) {
      picked[r.owner] = r.heroId && !ours.has(r.heroId) ? r.heroId : null;
      if (picked[r.owner]) ours.add(picked[r.owner]);
    }
  }
  const allies = [];
  const dropped = [];
  for (const r of state.ours) {
    if (r.owner >= 0 || !r.heroId || ours.has(r.heroId)) continue;
    ours.add(r.heroId);
    if (allies.length < alliesLimit) allies.push(r.heroId);
    else dropped.push(r.heroId);
  }
  const enemies = [];
  for (const r of state.enemies) if (r.heroId && !enemies.includes(r.heroId) && enemies.length < TEAM_SIZE) enemies.push(r.heroId);
  const inPlay = new Set([...ours, ...enemies]);
  next.picked = picked;
  next.allies = allies;
  next.enemies = enemies;
  const read = [];
  for (const b of state.bans || []) if (b.heroId && !read.includes(b.heroId) && read.length < BAN_LIMIT) read.push(b.heroId);
  next.bans = (read.length ? read : (next.bans || []).map(sid)).filter((b) => !inPlay.has(b));
  return { match: next, dropped };
}

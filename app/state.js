// Stato salvato sul telefono (localStorage): profilo e partita. Parte pura, senza pagina, testata in tests/state.test.js.
// - sanitizeProfile / sanitizeMatch: un valore salvato da una versione vecchia, rovinato o con un campo mancante non deve
//   mai bloccare l'avvio dell'app; ogni campo sbagliato torna al suo valore predefinito, i dati buoni restano.
// - parkMissing: un eroe (o una mappa) che sparisce per un momento dai dati (elenco di counterwatch incompleto) esce dalla
//   partita ma non si perde: resta da parte in match.missing e torna al suo posto quando ricompare nei dati.

const ROLE_KEYS = ["Tank", "Damage", "Support"];
const GROUPS = ["bans", "enemies", "allies"];
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const isId = (x) => (typeof x === "string" && x !== "") || (typeof x === "number" && Number.isFinite(x));
const ids = (xs) => (Array.isArray(xs) ? xs.filter(isId).map(String) : []);

// fallback(): il profilo predefinito; ranks: i rank validi; defaultName(i): nome predefinito del giocatore i
export function sanitizeProfile(raw, { fallback, ranks = [], defaultName = (i) => `Giocatore ${i + 1}`, maxPlayers = 5 }) {
  if (!isObj(raw) || !Array.isArray(raw.players) || !raw.players.length) return fallback();
  const def = fallback().players;
  const players = raw.players.slice(0, maxPlayers).map((x, i) => {
    const p = isObj(x) ? x : {};
    // ruoli: elenco valido; versione con un solo ruolo ("role"); altrimenti quelli predefiniti
    const roles = Array.isArray(p.roles) ? p.roles.filter((r, k, all) => ROLE_KEYS.includes(r) && all.indexOf(r) === k)
      : ROLE_KEYS.includes(p.role) ? [p.role] : (def[i]?.roles ?? []).slice();
    return {
      ...p,
      name: typeof p.name === "string" && p.name.trim() ? p.name : defaultName(i),
      rank: ranks.includes(p.rank) ? p.rank : "",
      roles,
      favorites: ids(p.favorites),
      nick: typeof p.nick === "string" ? p.nick : "",
    };
  });
  return { ...raw, players };
}

// empty(): una partita nuova per il profilo attuale. Le lunghezze per giocatore le sistema fitMatch (app.js).
export function sanitizeMatch(raw, empty) {
  const e = empty();
  if (!isObj(raw)) return e;
  const m = { ...raw };
  for (const g of GROUPS) m[g] = ids(raw[g]);
  m.mapSlug = typeof raw.mapSlug === "string" && raw.mapSlug ? raw.mapSlug : null;
  m.side = raw.side === "attack" || raw.side === "defense" ? raw.side : null;
  m.roles = Array.isArray(raw.roles) ? raw.roles.map((r) => (ROLE_KEYS.includes(r) ? r : null)) : e.roles;
  m.picked = Array.isArray(raw.picked) ? raw.picked.map((x) => (isId(x) ? String(x) : null)) : e.picked;
  m.away = Array.isArray(raw.away) ? raw.away.map(Boolean) : e.picked.map(() => false);
  m.pickFor = Number.isInteger(raw.pickFor) ? raw.pickFor : 0;
  m.group = typeof raw.group === "string" ? raw.group : e.group;
  const ms = isObj(raw.missing) ? raw.missing : {};
  m.missing = {
    ...Object.fromEntries(GROUPS.map((g) => [g, ids(ms[g])])),
    picked: Array.isArray(ms.picked) ? ms.picked.map((x) => (isId(x) ? String(x) : null)) : [],
    mapSlug: typeof ms.mapSlug === "string" && ms.mapSlug ? ms.mapSlug : null,
  };
  return m;
}

// known(id): l'eroe c'è nei dati; knownMap(slug): la mappa c'è; limitOf(g): quanti ne può avere il gruppo.
// Sposta in match.missing ciò che i dati non hanno più e rimette al suo posto ciò che è tornato (se c'è ancora posto e il
// posto è libero: un giocatore che nel frattempo ha scelto un altro eroe lo tiene). Le regole di gioco (ban, un eroe una
// volta per squadra) le riapplica fitMatch dopo. Restituisce true se ha cambiato qualcosa.
export function parkMissing(match, { known, knownMap, limitOf }) {
  const ms = match.missing && typeof match.missing === "object" ? match.missing : {};
  const miss = {
    ...Object.fromEntries(GROUPS.map((g) => [g, ids(ms[g])])),
    picked: Array.isArray(ms.picked) ? ms.picked.slice() : [],
    mapSlug: ms.mapSlug ?? null,
  };
  let changed = false;
  for (const g of GROUPS) {
    const gone = match[g].filter((x) => !known(String(x)));
    if (gone.length) {
      match[g] = match[g].filter((x) => known(String(x)));
      miss[g] = [...miss[g], ...gone.map(String).filter((x) => !miss[g].includes(x))];
      changed = true;
    }
    const back = miss[g].filter((x) => known(x));
    for (const x of back) {
      if (!match[g].some((y) => String(y) === x) && match[g].length < limitOf(g)) match[g] = [...match[g], x];
    }
    if (back.length) { miss[g] = miss[g].filter((x) => !back.includes(x)); changed = true; }
  }
  match.picked = match.picked.map((x, i) => {
    if (x && !known(String(x))) { miss.picked[i] = String(x); changed = true; return null; }
    const p = miss.picked[i];
    if (p && known(p)) { miss.picked[i] = null; changed = true; return x || p; }
    return x;
  });
  if (match.mapSlug && !knownMap(match.mapSlug)) { miss.mapSlug = match.mapSlug; match.mapSlug = null; changed = true; }
  if (miss.mapSlug && knownMap(miss.mapSlug)) { if (!match.mapSlug) match.mapSlug = miss.mapSlug; miss.mapSlug = null; changed = true; }
  miss.picked = miss.picked.map((x) => x || null);
  while (miss.picked.length && !miss.picked[miss.picked.length - 1]) miss.picked.pop();
  match.missing = miss;
  return changed;
}

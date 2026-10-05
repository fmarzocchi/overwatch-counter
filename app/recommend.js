// Logica dei suggerimenti: pura, senza DOM, così si collauda anche in Node.
//
// Il punteggio di un eroe candidato è la somma dei suoi scarti dal 50%:
//   base   = win rate sulla mappa scelta (o generale se nessuna mappa) - 0.5
//   contro = per ogni avversario, win rate del candidato contro di lui - 0.5
//   con    = per ogni alleato, win rate della coppia - 0.5 (pesato a metà)
//   lato   = attacco/difesa: piccola REGOLA sullo stile dell'eroe (counterwatch non ha dati per lato)
//   pref   = piccolo bonus se l'eroe è tra i preferiti del giocatore
// "stima" = 50% + punteggio (senza il bonus preferiti): non è una probabilità esatta, serve a ordinare.
//
// In due (recommendDuo) si sceglie la COPPIA con la somma più alta, contando anche
// la sinergia tra i due eroi scelti; i due eroi sono sempre diversi.
// onlyFavorites: si consiglia solo tra i preferiti del giocatore; se nessun preferito è
// disponibile (ruolo, ban, alleati) si torna a tutti gli eroi e lo si segnala in notes.

export const SYNERGY_WEIGHT = 0.5;
export const FAVORITE_BONUS = 0.01;
export const SIDE_WEIGHT = 0.01;
export const SIDE_MODES = ["Escort", "Hybrid"]; // solo qui esistono attacco e difesa

const sid = (x) => String(x);

export function pairValue(matrix, a, b) {
  const v = matrix?.[sid(a)]?.[sid(b)] ?? matrix?.[sid(b)]?.[sid(a)];
  return typeof v === "number" ? v : null;
}

export function hasSides(map) {
  return !!map && SIDE_MODES.includes(map.mode);
}

// Regola dichiarata, non statistica: in difesa conta tenere la posizione (stile POKE),
// in attacco entrare (stile DIVE o RUSH). Vale al massimo ±0.5%.
export function sideBonus(hero, side) {
  const s = hero?.style;
  if (!s || (side !== "attack" && side !== "defense")) return 0;
  const fit = side === "defense" ? s.POKE ?? 0.5 : Math.max(s.DIVE ?? 0, s.RUSH ?? 0);
  return (fit - 0.5) * SIDE_WEIGHT;
}

export function recommend(
  data,
  {
    role = null, mapSlug = null, side = null, enemies = [], allies = [], bans = [], favorites = [], onlyFavorites = false,
  } = {},
) {
  const map = mapSlug ? data.maps.find((m) => m.slug === mapSlug) : null;
  const useSide = hasSides(map) ? side : null;
  const byId = Object.fromEntries(data.heroes.map((h) => [sid(h.id), h]));
  const excluded = new Set([...allies, ...bans].map(sid));
  const fav = new Set(favorites.map(sid));

  const rows = data.heroes
    .filter((h) => (!role || h.role === role) && !excluded.has(sid(h.id)) && (!onlyFavorites || fav.has(sid(h.id))))
    .map((h) => {
      const id = sid(h.id);
      const baseWr = map?.winRates?.[id] ?? data.overall?.[id] ?? 0.5;
      const base = baseWr - 0.5;

      const vs = enemies
        .map((e) => {
          const v = data.counters?.[id]?.[sid(e)];
          return typeof v === "number" ? { hero: byId[sid(e)], delta: v - 0.5 } : null;
        })
        .filter(Boolean);

      const withAllies = allies
        .map((a) => {
          const v = pairValue(data.synergies, id, a);
          return v === null ? null : { hero: byId[sid(a)], delta: (v - 0.5) * SYNERGY_WEIGHT };
        })
        .filter(Boolean);

      const contro = vs.reduce((s, x) => s + x.delta, 0);
      const con = withAllies.reduce((s, x) => s + x.delta, 0);
      const lato = useSide ? sideBonus(h, useSide) : 0;
      const pref = fav.has(id) ? FAVORITE_BONUS : 0;
      const score = base + contro + con + lato + pref;
      return {
        hero: h,
        score,
        estimate: Math.min(0.99, Math.max(0.01, 0.5 + score - pref)),
        parts: { base, contro, con, lato, pref },
        baseLabel: map ? map.name : "generale",
        side: useSide,
        favorite: pref > 0,
        baseWr,
        vs: vs.sort((a, b) => b.delta - a.delta),
        withAllies: withAllies.sort((a, b) => b.delta - a.delta),
      };
    })
    .sort((a, b) => b.score - a.score || a.hero.name.localeCompare(b.hero.name));

  return rows;
}

// players: [{role, favorites, onlyFavorites, data?}, …]; il resto come recommend().
// data del giocatore (es. dati della sua divisione, vedi withDivision) se presente, altrimenti quelli generali.
// Restituisce, per ogni giocatore, le alternative ordinate (la prima è la scelta consigliata)
// già calcolate tenendo conto dell'eroe consigliato all'altro.
export function recommendDuo(data, { players = [], ...ctx } = {}) {
  const notes = players.map(() => null);
  const fallbackNote = "nessun preferito disponibile: consiglio tra tutti";
  // con "solo preferiti" un giocatore senza preferiti utilizzabili torna a tutti gli eroi
  const opts = players.map((p, i) => {
    if (p.onlyFavorites && !recommend(p.data ?? data, { ...ctx, ...p }).length) {
      notes[i] = fallbackNote;
      return { ...p, onlyFavorites: false };
    }
    return p;
  });
  if (players.length !== 2) {
    return { lists: opts.map((p) => recommend(p.data ?? data, { ...ctx, ...p })), pair: null, notes };
  }
  const bestPair = () => {
    const [r0, r1] = opts.map((p) => recommend(p.data ?? data, { ...ctx, ...p }));
    let best = null;
    for (const a of r0) {
      for (const b of r1) {
        if (sid(a.hero.id) === sid(b.hero.id)) continue;
        const syn = pairValue(data.synergies, a.hero.id, b.hero.id);
        const total = a.score + b.score + (syn === null ? 0 : (syn - 0.5) * SYNERGY_WEIGHT);
        if (!best || total > best.total) best = { total, a, b, syn };
      }
    }
    return { best, r0, r1 };
  };
  let { best, r0, r1 } = bestPair();
  if (!best && opts[1].onlyFavorites) {
    // es. stesso ruolo e un solo preferito in comune: il secondo giocatore sceglie tra tutti
    opts[1] = { ...opts[1], onlyFavorites: false };
    notes[1] = fallbackNote;
    ({ best, r0, r1 } = bestPair());
  }
  if (!best) return { lists: [r0, r1], pair: null, notes };
  const allies = ctx.allies ?? [];
  const lists = [
    recommend(opts[0].data ?? data, { ...ctx, ...opts[0], allies: [...allies, best.b.hero.id] }),
    recommend(opts[1].data ?? data, { ...ctx, ...opts[1], allies: [...allies, best.a.hero.id] }),
  ];
  // la scelta congiunta va in cima anche se, a pari merito, l'ordine fosse diverso
  for (const [i, h] of [[0, best.a.hero], [1, best.b.hero]]) {
    const k = lists[i].findIndex((r) => sid(r.hero.id) === sid(h.id));
    if (k > 0) lists[i].unshift(...lists[i].splice(k, 1));
  }
  return { lists, pair: { a: best.a.hero, b: best.b.hero, synergy: best.syn }, notes };
}

// Frasi brevi da mostrare sotto ogni suggerimento: i punti a favore più forti
// e, se c'è, il matchup peggiore (in rosso).
export function reasons(row, max = 3) {
  const pct = (d) => `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)}%`;
  const all = [];
  if (Math.abs(row.parts.base) >= 0.005) {
    all.push({ good: row.parts.base > 0, delta: row.parts.base, text: `${row.baseLabel} ${pct(row.parts.base)}` });
  }
  for (const v of row.vs) {
    if (Math.abs(v.delta) >= 0.01) all.push({ good: v.delta > 0, delta: v.delta, text: `vs ${v.hero?.name ?? "?"} ${pct(v.delta)}` });
  }
  for (const a of row.withAllies) {
    if (Math.abs(a.delta) >= 0.005) all.push({ good: a.delta > 0, delta: a.delta, text: `con ${a.hero?.name ?? "?"} ${pct(a.delta)}` });
  }
  if (Math.abs(row.parts.lato ?? 0) >= 0.002) {
    const lato = row.side === "defense" ? "difesa" : "attacco";
    all.push({ good: row.parts.lato > 0, delta: row.parts.lato, text: `${lato} (regola) ${pct(row.parts.lato)}` });
  }
  const good = all.filter((r) => r.good).sort((a, b) => b.delta - a.delta);
  const bad = all.filter((r) => !r.good).sort((a, b) => a.delta - b.delta);
  const out = good.slice(0, bad.length ? max - 1 : max);
  if (bad.length) out.push(bad[0]);
  if (row.favorite) out.unshift({ good: true, delta: row.parts.pref, text: "★ preferito" });
  return out.map(({ good, text }) => ({ good, text }));
}

const pct = (d) => `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)}%`;

// Riepilogo in 1–3 righe brevi per i consigli: vantaggio sulla mappa, contro la comp avversaria
// (somma su tutti gli avversari segnati) e con gli alleati.
export function breakdown(row) {
  const out = [{ key: "map", label: row.baseLabel === "generale" ? "Generale" : "Mappa", delta: row.parts.base }];
  if (row.vs.length) out.push({ key: "enemies", label: "Avversari", delta: row.parts.contro });
  if (row.withAllies.length) out.push({ key: "allies", label: "Alleati", delta: row.parts.con });
  return out.map((x) => ({ ...x, good: x.delta >= 0, text: `${x.label} ${pct(x.delta)}` }));
}

// Tutti i perché, uno per riga: mappa, ogni avversario, ogni alleato, lato, preferito.
export function details(row) {
  const out = [{ good: row.parts.base >= 0, text: `${row.baseLabel === "generale" ? "Win rate generale" : row.baseLabel} ${pct(row.parts.base)}` }];
  for (const v of row.vs) out.push({ good: v.delta >= 0, text: `contro ${v.hero?.name ?? "?"} ${pct(v.delta)}` });
  for (const a of row.withAllies) out.push({ good: a.delta >= 0, text: `con ${a.hero?.name ?? "?"} ${pct(a.delta)}` });
  if (row.side) out.push({ good: row.parts.lato >= 0, text: `${row.side === "defense" ? "difesa" : "attacco"} (regola sullo stile) ${pct(row.parts.lato)}` });
  if (row.favorite) out.push({ good: true, text: `preferito (solo per ordinare) ${pct(row.parts.pref)}` });
  return out;
}

// Dati generali + file di una divisione (app/divisions/<chiave>.json): counter, sinergie, win rate
// generali e per mappa della divisione; le mappe assenti nel file restano quelle generali.
export function withDivision(data, div) {
  if (!div?.counters) return data;
  return {
    ...data,
    division: div.division,
    counters: div.counters,
    synergies: div.synergies ?? data.synergies,
    overall: { ...data.overall, ...div.overall },
    maps: data.maps.map((m) => (div.maps?.[m.slug] ? { ...m, winRates: { ...m.winRates, ...div.maps[m.slug] } } : m)),
  };
}

// Scheda di un eroe: contro chi va meglio e peggio, le mappe migliori, con chi si trova meglio.
export function heroProfile(data, heroId, n = 5) {
  const id = sid(heroId);
  const byId = Object.fromEntries(data.heroes.map((h) => [sid(h.id), h]));
  const top = (items, dir = -1) => items.filter((x) => x.subject).sort((a, b) => dir * (a.delta - b.delta)).slice(0, n);
  const others = data.heroes.filter((h) => sid(h.id) !== id);
  const vs = others
    .map((h) => ({ subject: h, delta: (data.counters?.[id]?.[sid(h.id)] ?? NaN) - 0.5 }))
    .filter((x) => Number.isFinite(x.delta));
  const withHeroes = others
    .map((h) => ({ subject: h, delta: (pairValue(data.synergies, id, h.id) ?? NaN) - 0.5 }))
    .filter((x) => Number.isFinite(x.delta));
  const maps = data.maps
    .map((m) => ({ subject: m, delta: (m.winRates?.[id] ?? NaN) - 0.5 }))
    .filter((x) => Number.isFinite(x.delta));
  return {
    hero: byId[id],
    strongVs: top(vs.filter((x) => x.delta > 0)),
    weakVs: top(vs.filter((x) => x.delta < 0), 1),
    bestMaps: top(maps.filter((x) => x.delta > 0)),
    bestWith: top(withHeroes.filter((x) => x.delta > 0)),
  };
}

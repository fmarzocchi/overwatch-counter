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
// In squadra (recommendTeam, 1–5 giocatori) si sceglie la COMBINAZIONE con la somma più alta, contando anche
// la sinergia tra gli eroi scelti; gli eroi sono sempre diversi e quelli già presi restano fissi.
// onlyFavorites: si consiglia solo tra i preferiti del giocatore; se nessun preferito è
// disponibile (ruolo, ban, alleati) si torna a tutti gli eroi e lo si segnala in notes.

import { theoryForPick } from "./theory.js";

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
    theory = null, useTheory = false,
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
      // teoria (stile di squadra, counter noti): sempre calcolata per mostrarla, nel punteggio solo se attivata
      const th = theory ? theoryForPick(data, theory, h, { enemies, mates: allies }) : null;
      const teoria = useTheory && th ? th.score : 0;
      const score = base + contro + con + lato + pref + teoria;
      return {
        hero: h,
        score,
        estimate: Math.min(0.99, Math.max(0.01, 0.5 + score - pref - teoria)),
        parts: { base, contro, con, lato, pref, teoria },
        theory: th,
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

// Squadra di 1–5 giocatori. players: [{role, favorites, onlyFavorites, data?, picked?}, …]; il resto come recommend().
// data del giocatore (es. dati della sua divisione, vedi withDivision) se presente, altrimenti quelli generali.
// picked: eroe GIÀ PRESO da quel giocatore → resta fisso, conta come alleato per gli altri e la sua lista
// ha in cima l'eroe preso (row.picked = true) seguito dalle alternative del suo ruolo.
// Per gli altri si cerca la COMBINAZIONE migliore (eroi tutti diversi): somma dei punteggi + sinergia
// tra ogni coppia di eroi consigliati. Fino a 2 giocatori liberi la ricerca è completa; con di più si
// considerano i migliori TEAM_BEAM eroi di ciascuno (differenza trascurabile, calcolo istantaneo).
// Restituisce {lists, team, picked, pair, notes}: lists[i] = alternative ordinate (la prima è quella consigliata
// o presa), già calcolate con gli eroi degli altri come alleati; team[i] = eroe di ciascuno.
export const TEAM_BEAM = 12;
export function recommendTeam(data, { players = [], ...ctx } = {}) {
  const notes = players.map(() => null);
  const fallbackNote = "nessun preferito disponibile: consiglio tra tutti";
  const allies = (ctx.allies ?? []).map(sid);
  const pickedIds = players.map((p) => (p.picked != null && p.picked !== "" ? sid(p.picked) : null));
  const fixed = pickedIds.filter(Boolean);
  const dataOf = (p) => p.data ?? data;
  const byId = Object.fromEntries(data.heroes.map((h) => [sid(h.id), h]));
  const free = players.map((_, i) => i).filter((i) => !pickedIds[i]);
  // con "solo preferiti" un giocatore senza preferiti utilizzabili torna a tutti gli eroi
  const opts = players.map((p, i) => {
    if (!pickedIds[i] && p.onlyFavorites && !recommend(dataOf(p), { ...ctx, ...p, allies: [...allies, ...fixed] }).length) {
      notes[i] = fallbackNote;
      return { ...p, onlyFavorites: false };
    }
    return p;
  });
  const synOf = (a, b) => {
    const v = pairValue(data.synergies, a, b);
    return v === null ? 0 : (v - 0.5) * SYNERGY_WEIGHT;
  };
  const search = () => {
    const cands = free.map((i) => {
      const rows = recommend(dataOf(opts[i]), { ...ctx, ...opts[i], allies: [...allies, ...fixed] });
      return free.length > 2 ? rows.slice(0, TEAM_BEAM) : rows;
    });
    // indici numerici e tabella delle sinergie: con 5 giocatori le combinazioni sono centinaia di migliaia
    const ids = [...new Set(cands.flat().map((r) => sid(r.hero.id)))];
    const at = new Map(ids.map((x, k) => [x, k]));
    const n = ids.length;
    const syn = new Float64Array(n * n);
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) syn[a * n + b] = syn[b * n + a] = synOf(ids[a], ids[b]);
    const idx = cands.map((rows) => rows.map((r) => at.get(sid(r.hero.id))));
    const used = new Uint8Array(n);
    const pick = new Int32Array(free.length);
    const cur = new Int32Array(free.length);
    let best = null;
    let bestTotal = -Infinity;
    const dfs = (k, total) => {
      if (k === free.length) {
        if (total > bestTotal) { bestTotal = total; pick.set(cur); best = true; }
        return;
      }
      const rows = cands[k];
      for (let j = 0; j < rows.length; j++) {
        const h = idx[k][j];
        if (used[h]) continue;
        let t = total + rows[j].score;
        for (let q = 0; q < k; q++) t += syn[h * n + idx[q][cur[q]]];
        used[h] = 1;
        cur[k] = j;
        dfs(k + 1, t);
        used[h] = 0;
      }
    };
    dfs(0, 0);
    return best ? { total: bestTotal, rows: [...pick].map((j, k) => cands[k][j]) } : null;
  };
  let best = search();
  // es. stesso ruolo e un solo preferito in comune: gli ultimi giocatori scelgono tra tutti
  for (let k = free.length - 1; !best && k >= 0; k--) {
    const i = free[k];
    if (!opts[i].onlyFavorites) continue;
    opts[i] = { ...opts[i], onlyFavorites: false };
    notes[i] = fallbackNote;
    best = search();
  }
  const team = players.map((_, i) => (pickedIds[i] ? byId[pickedIds[i]] ?? null : null));
  if (best) free.forEach((i, k) => { team[i] = best.rows[k].hero; });
  const lists = players.map((p, i) => {
    const others = team.filter((h, j) => h && j !== i).map((h) => sid(h.id));
    if (pickedIds[i]) {
      const h = byId[pickedIds[i]];
      const o = { ...ctx, ...opts[i], role: h?.role ?? null, onlyFavorites: false, allies: [...allies, ...others] };
      let rows = recommend(dataOf(p), o);
      if (!rows.some((r) => sid(r.hero.id) === pickedIds[i])) {
        // preso anche se segnato tra i ban: lo si mostra lo stesso
        rows = [...recommend(dataOf(p), { ...o, bans: [] }).filter((r) => sid(r.hero.id) === pickedIds[i]), ...rows];
      }
      const k = rows.findIndex((r) => sid(r.hero.id) === pickedIds[i]);
      if (k < 0) return rows;
      const [row] = rows.splice(k, 1);
      return [{ ...row, picked: true }, ...rows];
    }
    const rows = recommend(dataOf(opts[i]), { ...ctx, ...opts[i], allies: [...allies, ...others] });
    // la scelta congiunta va in cima anche se, a pari merito, l'ordine fosse diverso
    const k = team[i] ? rows.findIndex((r) => sid(r.hero.id) === sid(team[i].id)) : -1;
    if (k > 0) rows.unshift(...rows.splice(k, 1));
    return rows;
  });
  const pair = players.length === 2 && team[0] && team[1]
    ? { a: team[0], b: team[1], synergy: pairValue(data.synergies, team[0].id, team[1].id) } : null;
  return { lists, team, picked: pickedIds.map(Boolean), pair, notes };
}

// compatibilità: la coppia è una squadra di due
export const recommendDuo = recommendTeam;

// Frasi brevi da mostrare sotto ogni suggerimento: i punti a favore più forti
// e, se c'è, il matchup peggiore (in rosso).
export function reasons(row, max = 3) {
  const pct = (d) => (Math.abs(d) < 0.0005 ? "±0.0%" : `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)}%`);
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

const pct = (d) => (Math.abs(d) < 0.0005 ? "±0.0%" : `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)}%`);

// Riepilogo in 1–3 righe brevi per i consigli: vantaggio sulla mappa, contro la comp avversaria
// (somma su tutti gli avversari segnati) e con gli alleati.
// partners: [{id, name}] degli altri giocatori (o uno solo, come oggetto): la sinergia con loro è mostrata a parte,
// "Con Lei" se è uno solo, "Con voi" (somma) se sono di più.
export function breakdown(row, partners = null) {
  const list = (Array.isArray(partners) ? partners : partners ? [partners] : []).filter(Boolean);
  const out = [{ key: "map", label: row.baseLabel === "generale" ? "Generale" : "Mappa", delta: row.parts.base }];
  if (row.vs.length) out.push({ key: "enemies", label: "Avversari", delta: row.parts.contro });
  const mateOf = (a) => list.find((p) => String(a.hero?.id) === String(p.id));
  const others = row.withAllies.filter((a) => !mateOf(a));
  const mates = row.withAllies.filter(mateOf);
  if (others.length) out.push({ key: "allies", label: "Alleati", delta: others.reduce((s, a) => s + a.delta, 0) });
  if (mates.length) {
    out.push({ key: "partner", label: mates.length === 1 ? `Con ${mateOf(mates[0]).name}` : "Con voi",
      delta: mates.reduce((s, a) => s + a.delta, 0) });
  }
  return out.map((x) => ({ ...x, good: x.delta > -0.0005, text: `${x.label} ${pct(x.delta)}` }));
}

// Tutti i perché, uno per riga: mappa, ogni avversario, ogni alleato, lato, preferito.
export function details(row) {
  const out = [{ good: row.parts.base >= 0, text: `${row.baseLabel === "generale" ? "Win rate generale" : row.baseLabel} ${pct(row.parts.base)}` }];
  for (const v of row.vs) out.push({ good: v.delta >= 0, text: `contro ${v.hero?.name ?? "?"} ${pct(v.delta)}` });
  for (const a of row.withAllies) out.push({ good: a.delta >= 0, text: `con ${a.hero?.name ?? "?"} ${pct(a.delta)}` });
  if (row.side) out.push({ good: row.parts.lato >= 0, text: `${row.side === "defense" ? "difesa" : "attacco"} (regola sullo stile) ${pct(row.parts.lato)}` });
  if (row.favorite) out.push({ good: true, text: `preferito (solo per ordinare) ${pct(row.parts.pref)}` });
  const th = row.theory;
  if (th) {
    for (const b of th.beats) out.push({ good: true, kind: "teoria", text: `batte ${b.name}: ${b.why}` });
    for (const b of th.beatenBy) out.push({ good: false, kind: "teoria", text: `soffre ${b.name}: ${b.why}` });
    for (const w of th.withMates) out.push({ good: true, kind: "teoria", text: `con ${w.name}: ${w.why}` });
    if (th.fit) out.push({ good: true, kind: "teoria", text: `stesso stile della squadra: ${th.fit === "RUSH" ? "Rush" : th.fit === "DIVE" ? "Dive" : "Poke"}` });
  }
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

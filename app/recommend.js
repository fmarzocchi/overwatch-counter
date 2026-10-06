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

import { theoryForPick, mapFit, GUIDE_POINTS, FEATURE_IT } from "./theory.js";

export const SYNERGY_WEIGHT = 0.5;
export const FAVORITE_BONUS = 0.01;
export const SIDE_WEIGHT = 0.01;
export const SIDE_MODES = ["Escort", "Hybrid"]; // solo qui esistono attacco e difesa
// Statistiche + teoria insieme ("Usa anche la teoria nei consigli"): concorrono entrambe, la teoria un po' di più.
// I punti delle guide si portano sulla scala dei win rate con GUIDE_TO_WR (misurato sui dati: la dispersione di
// 1 punto delle guide ≈ 2% di win rate, sia per le mappe sia per i counter), poi 45% statistiche + 55% teoria
// (×2, così il punteggio resta sulla scala delle statistiche). La "stima" in percentuale resta solo statistica.
export const GUIDE_TO_WR = 0.02;
export const THEORY_SHARE = 0.55;
const W_STAT = 2 * (1 - THEORY_SHARE);
const W_THEORY = 2 * THEORY_SHARE * GUIDE_TO_WR;

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
    theory = null, useTheory = false, guideOnly = false, scoreAll = false,
  } = {},
) {
  const map = mapSlug ? data.maps.find((m) => m.slug === mapSlug) : null;
  const useSide = hasSides(map) ? side : null;
  const byId = Object.fromEntries(data.heroes.map((h) => [sid(h.id), h]));
  // scoreAll: una riga per OGNI eroe (anche alleati e bannati), es. per le stelline di tutta la griglia
  const excluded = new Set(scoreAll ? [] : [...allies, ...bans].map(sid));
  const fav = new Set(favorites.map(sid));
  const allEnemies = enemies;
  const allAllies = allies;

  const rows = data.heroes
    .filter((h) => (!role || h.role === role) && !excluded.has(sid(h.id)) && (!onlyFavorites || fav.has(sid(h.id))))
    .map((h) => {
      const id = sid(h.id);
      // un eroe non fa coppia con se stesso (con scoreAll può essere tra gli alleati)
      const enemies = allEnemies.filter((e) => sid(e) !== id);
      const allies = allAllies.filter((a) => sid(a) !== id);
      if (guideOnly) return guideRow(data, theory, h, { map, useSide, enemies, allies, fav, byId });
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
      // teoria (stile di squadra, counter noti): sempre calcolata per mostrarla; se attivata concorre al punteggio (55%)
      const th = theory ? theoryForPick(data, theory, h, { enemies, mates: allies }) : null;
      const stat = base + contro + con + lato;
      const g = useTheory && theory ? guideRow(data, theory, h, { map, useSide, enemies, allies, fav: new Set(), byId }) : null;
      const blended = g ? W_STAT * stat + W_THEORY * g.score : stat;
      const teoria = blended - stat; // parte dovuta alla teoria (la stima la esclude)
      const score = blended + pref;
      return {
        hero: h,
        score,
        estimate: Math.min(0.99, Math.max(0.01, 0.5 + score - pref - teoria)),
        parts: { base, contro, con, lato, pref, teoria },
        theory: th,
        mapGuide: theory ? mapFit(theory, map?.slug, h, useSide) : null, // consigliato/sconsigliato su questa mappa dalle guide
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

// Ban consigliati per la mappa: i migliori BANS_PER_ROLE di ogni ruolo. Un ban vale per entrambe le squadre, quindi
// si propongono eroi forti su quella mappa e contro gli eroi che giocherete voi, mai quelli che volete giocare.
//   forza    = win rate sulla mappa (o generale, senza mappa) − 0.5
//   minaccia = media, sui vostri eroi (ours), del win rate del candidato contro ciascuno − 0.5
//   punteggio = forza + minaccia
// datasets: uno o più dati (es. quelli della divisione di ogni giocatore): si fa la media.
// keep: id da non proporre (preferiti, eroi presi, alleati); anche ours non si propone.
// Restituisce {Tank: [righe], Damage: [...], Support: [...]}, riga = {hero, score, strength, threat, beats: [eroi vostri battuti]}.
export const BANS_PER_ROLE = 2;
export const BAN_ROLES = ["Tank", "Damage", "Support"];
export function banSuggestions(datasets, { mapSlug = null, ours = [], keep = [], perRole = BANS_PER_ROLE } = {}) {
  const sets = (Array.isArray(datasets) ? datasets : [datasets]).filter(Boolean);
  if (!sets.length) return Object.fromEntries(BAN_ROLES.map((r) => [r, []]));
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const byId = Object.fromEntries(sets[0].heroes.map((h) => [sid(h.id), h]));
  const mine = [...new Set(ours.map(sid))].filter((o) => byId[o]);
  const skip = new Set([...keep.map(sid), ...mine]);
  const rows = sets[0].heroes.filter((h) => !skip.has(sid(h.id))).map((h) => {
    const id = sid(h.id);
    const strength = avg(sets.map((d) => {
      const map = mapSlug ? d.maps.find((m) => m.slug === mapSlug) : null;
      return (map?.winRates?.[id] ?? d.overall?.[id] ?? 0.5) - 0.5;
    }));
    const vs = mine.map((o) => {
      const v = avg(sets.map((d) => d.counters?.[id]?.[o]).filter((x) => typeof x === "number"));
      return v === null ? null : { hero: byId[o], delta: v - 0.5 };
    }).filter(Boolean);
    const threat = avg(vs.map((x) => x.delta)) ?? 0;
    return { hero: h, score: strength + threat, strength, threat,
      beats: vs.filter((x) => x.delta >= 0.01).sort((a, b) => b.delta - a.delta).map((x) => x.hero) };
  });
  return Object.fromEntries(BAN_ROLES.map((role) => [role, rows.filter((r) => r.hero.role === role)
    .sort((a, b) => b.score - a.score || a.hero.name.localeCompare(b.hero.name)).slice(0, perRole)]));
}

// Modalità "solo guide e pro" (guideOnly): nessuna statistica di counterwatch. Punti (non percentuali):
//   mappa    = mapFit(): consigliato +2 / sconsigliato −2 dalle guide, stile e caratteristiche della mappa
//   contro   = +1 per ogni avversario che l'eroe batte in teoria, −1 per chi lo batte
//   con      = +0.5 per ogni alleato con cui sinergizza in teoria
//   lato     = la stessa regola su attacco/difesa (±0.5), pref = preferito +0.5
// estimate = null: il riquadro mostra le stelline (rankStars, 1–5) invece della percentuale.
function guideRow(data, theory, h, { map, useSide, enemies, allies, fav, byId }) {
  const id = sid(h.id);
  const fit = mapFit(theory, map?.slug, h, useSide);
  const th = theory ? theoryForPick(data, theory, h, { enemies, mates: allies }) : null;
  const mappa = map ? fit.points : 0;
  const contro = th ? GUIDE_POINTS.beats * (th.beats.length - th.beatenBy.length) : 0;
  const con = th ? GUIDE_POINTS.synergy * th.withMates.length : 0;
  const lato = useSide ? sideBonus(h, useSide) / SIDE_WEIGHT : 0;
  const pref = fav.has(id) ? GUIDE_POINTS.favorite : 0;
  const score = mappa + contro + con + lato + pref;
  return {
    hero: h, score, estimate: null, guide: { mappa, contro, con, lato, map: fit, score: score - pref },
    parts: { base: mappa, contro, con, lato, pref, teoria: 0 }, theory: th, baseLabel: map ? map.name : "generale",
    side: useSide, favorite: pref > 0, baseWr: null,
    // avversari senza numeri: "Batte/Teme" del riquadro si basa solo sulla teoria
    vs: enemies.map((e) => (byId[sid(e)] ? { hero: byId[sid(e)], delta: 0 } : null)).filter(Boolean),
    withAllies: [],
  };
}

const hookText = (a) => `${a.name} vicino ai bordi: butta giù i nemici (mappa con burroni)`;

// perché, in modalità guide: le stesse righe di details() ma solo dalle guide
export function guideDetails(row) {
  const g = row.guide;
  if (!g) return [];
  const out = [];
  if (g.map.strong) out.push({ good: true, kind: "teoria", text: `consigliato su ${row.baseLabel}: ${g.map.strong.why}` });
  if (g.map.avoid) out.push({ good: false, kind: "teoria", text: `sconsigliato su ${row.baseLabel}: ${g.map.avoid.why}` });
  if (g.map.hook) out.push({ good: true, kind: "teoria", text: hookText(g.map.hook) });
  if (g.map.style) out.push({ good: true, kind: "teoria", text: `stile adatto a ${row.baseLabel}` });
  if (g.map.likes.length) out.push({ good: true, kind: "teoria", text: `la mappa lo favorisce (${g.map.likes.map((f) => FEATURE_IT[f] ?? f).join(", ")})` });
  if (g.map.dislikes.length) out.push({ good: false, kind: "teoria", text: `la mappa lo sfavorisce (${g.map.dislikes.map((f) => FEATURE_IT[f] ?? f).join(", ")})` });
  for (const b of row.theory?.beats ?? []) out.push({ good: true, kind: "teoria", text: `batte ${b.name}: ${b.why}` });
  for (const b of row.theory?.beatenBy ?? []) out.push({ good: false, kind: "teoria", text: `soffre ${b.name}: ${b.why}` });
  for (const w of row.theory?.withMates ?? []) out.push({ good: true, kind: "teoria", text: `con ${w.name}: ${w.why}` });
  if (g.lato) out.push({ good: g.lato > 0, kind: "teoria", text: `${row.side === "attack" ? "attacco" : "difesa"} (regola sullo stile)` });
  return out;
}

// Ban consigliati in modalità guide: forti sulla mappa per le guide (mapFit) + quanti dei vostri eroi battono in teoria.
export function guideBanSuggestions(data, theory, { mapSlug = null, side = null, ours = [], keep = [], perRole = BANS_PER_ROLE } = {}) {
  const byId = Object.fromEntries(data.heroes.map((h) => [sid(h.id), h]));
  const mine = [...new Set(ours.map(sid))].map((o) => byId[o]).filter(Boolean);
  const skip = new Set([...keep.map(sid), ...mine.map((h) => sid(h.id))]);
  const rows = data.heroes.filter((h) => !skip.has(sid(h.id))).map((h) => {
    const fit = mapFit(theory, mapSlug, h, side);
    const t = theory?.idx?.[h.name];
    const beats = t ? mine.filter((m) => t.counters.has(m.name)) : [];
    const strength = fit.points;
    const threat = GUIDE_POINTS.beats * beats.length;
    const why = [fit.strong ? `per le guide è forte qui: ${fit.strong.why}` : null, fit.hook && !fit.strong ? hookText(fit.hook) : null,
      beats.length ? `batte ${beats.map((x) => x.name).join(" e ")}` : null].filter(Boolean).join("; ");
    return { hero: h, score: strength + threat, strength, threat, beats, why };
  });
  return Object.fromEntries(BAN_ROLES.map((role) => [role, rows.filter((r) => r.hero.role === role)
    .sort((a, b) => b.score - a.score || a.hero.name.localeCompare(b.hero.name)).slice(0, perRole)]));
}

// Ban con statistiche + teoria: stesso miscuglio dei consigli (45% statistiche, 55% guide).
export function blendedBanSuggestions(datasets, theory, opts = {}) {
  const perRole = opts.perRole ?? BANS_PER_ROLE;
  const st = banSuggestions(datasets, { ...opts, perRole: 999 });
  const gd = guideBanSuggestions((Array.isArray(datasets) ? datasets[0] : datasets), theory, { ...opts, perRole: 999 });
  return Object.fromEntries(BAN_ROLES.map((role) => {
    const g = new Map(gd[role].map((r) => [sid(r.hero.id), r]));
    const rows = st[role].map((r) => {
      const x = g.get(sid(r.hero.id));
      const beats = [...new Set([...r.beats, ...(x?.beats ?? [])])];
      const why = [r.strength >= 0.003 || x?.strength >= 1.5 ? "forte su questa mappa (statistiche e guide)" : null,
        beats.length ? `batte ${beats.map((h) => h.name).join(" e ")}` : null].filter(Boolean).join(", ") || null;
      return { ...r, beats, why, score: W_STAT * r.score + W_THEORY * (x?.score ?? 0) };
    });
    return [role, rows.sort((a, b) => b.score - a.score || a.hero.name.localeCompare(b.hero.name)).slice(0, perRole)];
  }));
}

// ---------- stelline sotto gli eroi della griglia ----------
// Pericolo di un eroe NEMICO: forte sulla mappa (e sul suo lato, che è l'opposto del vostro) e quanto batte la vostra
// squadra — i vostri eroi (ours) contano il doppio degli altri compagni (mates). Stessa scala dei ban; con la teoria
// attiva si mescola come nei consigli (45/55), in modalità guide solo teoria.
export function threatScores(datasets, theory, { mapSlug = null, side = null, ours = [], mates = [], mode = "stat" } = {}) {
  const sets = (Array.isArray(datasets) ? datasets : [datasets]).filter(Boolean);
  const base = sets[0];
  const byId = Object.fromEntries(base.heroes.map((h) => [sid(h.id), h]));
  const enemySide = side === "attack" ? "defense" : side === "defense" ? "attack" : null;
  const map = mapSlug ? base.maps.find((m) => m.slug === mapSlug) : null;
  const team = [...ours.map((x) => [sid(x), 2]), ...mates.map((x) => [sid(x), 1])].filter(([x]) => byId[x]);
  const wsum = team.reduce((a, [, w]) => a + w, 0) || 1;
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return base.heroes.map((h) => {
    const id = sid(h.id);
    let stat = 0, guide = 0;
    if (mode !== "guide") {
      const strength = avg(sets.map((d) => {
        const m = mapSlug ? d.maps.find((x) => x.slug === mapSlug) : null;
        return (m?.winRates?.[id] ?? d.overall?.[id] ?? 0.5) - 0.5;
      })) + (enemySide && hasSides(map) ? sideBonus(h, enemySide) : 0);
      const threat = team.reduce((a, [o, w]) => {
        const v = avg(sets.map((d) => d.counters?.[id]?.[o]).filter((x) => typeof x === "number"));
        return a + w * (v ? v - 0.5 : 0);
      }, 0) / wsum;
      stat = strength + threat;
    }
    if (mode !== "stat" && theory) {
      const fit = mapFit(theory, mapSlug, h, enemySide);
      const t = theory.idx?.[h.name];
      const beats = team.reduce((a, [o, w]) => a + (t?.counters.has(byId[o].name) ? w : 0) - (t?.counteredBy.has(byId[o].name) ? w : 0), 0) / wsum;
      guide = fit.points + GUIDE_POINTS.beats * beats * Math.min(team.length, 3);
    }
    const score = mode === "guide" ? guide : mode === "blend" ? W_STAT * stat + W_THEORY * guide : stat;
    return { hero: h, score };
  });
}

// Da punteggi a stelle da 1 a 5, ruolo per ruolo come la griglia, mai senza stelle: conta la distanza dalla media del
// ruolo in deviazioni standard (z). Soglie STAR_Z: 5 stelle sopra +1.25 (circa il 10% migliore), 4 sopra +0.45, 3 nella
// fascia centrale, 2 sotto −0.45, 1 sotto −1.25. minSd: dispersione minima (nella scala dei punteggi), così eroi quasi
// alla pari restano tutti attorno a 3 invece di essere sparpagliati da differenze minime; tutti uguali → tutti 3.
// top: i primi `top` di ogni ruolo hanno comunque 5 stelle (es. i ban consigliati).
export const STAR_Z = [1.25, 0.45, -0.45, -1.25];
export function rankStars(rows, { byRole = true, top = 0, minSd = 0 } = {}) {
  const out = new Map();
  const groups = new Map();
  for (const r of rows) {
    const k = byRole ? r.hero.role : "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const g of groups.values()) {
    const n = g.length;
    const mean = g.reduce((a, r) => a + r.score, 0) / n;
    const sd = Math.max(minSd, Math.sqrt(g.reduce((a, r) => a + (r.score - mean) ** 2, 0) / n));
    const sorted = [...g].sort((a, b) => b.score - a.score || a.hero.name.localeCompare(b.hero.name));
    sorted.forEach((r, k) => {
      const z = sd > 1e-12 ? (r.score - mean) / sd : 0;
      const stars = k < top ? 5 : z >= STAR_Z[0] ? 5 : z >= STAR_Z[1] ? 4 : z > STAR_Z[2] ? 3 : z > STAR_Z[3] ? 2 : 1;
      out.set(sid(r.hero.id), stars);
    });
  }
  return out;
}
// dispersione minima per rankStars, nella scala di ciascuna modalità: 1% di win rate, oppure mezzo punto delle guide
export const STAR_MIN_SD = { stat: 0.01, blend: 0.01, guide: 0.5 };

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
    if (ctx.guideOnly) {
      const ha = byId[sid(a)], hb = byId[sid(b)];
      const ta = ctx.theory?.idx?.[ha?.name];
      return ha && hb && ta?.synergies.has(hb.name) ? GUIDE_POINTS.synergy : 0;
    }
    const v = pairValue(data.synergies, a, b);
    const stat = v === null ? 0 : (v - 0.5) * SYNERGY_WEIGHT;
    if (!ctx.useTheory || !ctx.theory) return stat;
    const ha = byId[sid(a)], hb = byId[sid(b)];
    const t = ha && hb && ctx.theory.idx?.[ha.name]?.synergies.has(hb.name) ? GUIDE_POINTS.synergy : 0;
    return W_STAT * stat + W_THEORY * t;
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
      const row = k < 0 ? null : rows.splice(k, 1)[0];
      // con "solo preferiti" anche le alternative, e quindi il cambio eroe ("Passa a"), restano tra i preferiti:
      // se nessuno è utilizzabile non c'è alternativa (l'eroe preso resta, anche se non è un preferito)
      const fav = new Set((p.favorites ?? []).map(sid));
      const alts = p.onlyFavorites ? rows.filter((r) => fav.has(sid(r.hero.id))) : rows;
      return row ? [{ ...row, picked: true }, ...alts] : alts;
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

// Per il riquadro (colpo d'occhio): contro quali avversari l'eroe va forte e da quali deve guardarsi.
// Unisce statistica (scarto contro quell'avversario) e teoria (counter noti, che valgono +/-1,5%).
// Un counter "da manuale" si mostra sempre, salvo che i numeri lo smentiscano nettamente (segnale oltre l'1%
// nel verso opposto): così il riquadro dice la stessa cosa delle righe "Punta"/"Attento" di Come giocarla.
export const MATCHUP_MIN = 0.01;
export const MATCHUP_THEORY = 0.015;
export function matchups(row, max = 3) {
  const beats = new Set((row?.theory?.beats ?? []).map((b) => b.name));
  const beaten = new Set((row?.theory?.beatenBy ?? []).map((b) => b.name));
  const all = (row?.vs ?? []).filter((v) => v.hero).map((v) => {
    const t = beats.has(v.hero.name) ? 1 : beaten.has(v.hero.name) ? -1 : 0;
    return { hero: v.hero, delta: v.delta, theory: t, signal: v.delta + t * MATCHUP_THEORY };
  });
  const strong = (x) => x.signal >= MATCHUP_MIN || (x.theory === 1 && x.signal > -MATCHUP_MIN);
  const weak = (x) => !strong(x) && (x.signal <= -MATCHUP_MIN || (x.theory === -1 && x.signal < MATCHUP_MIN));
  return {
    strong: all.filter(strong).sort((a, b) => b.signal - a.signal).slice(0, max),
    weak: all.filter(weak).sort((a, b) => a.signal - b.signal).slice(0, max),
  };
}

// Un solo motivo, in parole e senza numeri, per il riquadro prima di conoscere gli avversari
// (i numeri restano nel dettaglio). null se non c'è un motivo netto.
export function headline(row, partners = []) {
  if (!row) return null;
  if (row.guide) {
    if (row.guide.map.strong) return `Consigliato su ${row.baseLabel}`;
    const mate = (row.theory?.withMates ?? [])[0];
    if (mate) return `Bene con ${mate.name}`;
    if (row.guide.map.style || row.guide.map.likes.length) return `Adatto a ${row.baseLabel}`;
    return row.favorite ? "Tra i tuoi preferiti" : null;
  }
  if (row.parts.base >= 0.01) return row.baseLabel === "generale" ? "Tra i più forti in generale" : `Forte su ${row.baseLabel}`;
  const mates = (Array.isArray(partners) ? partners : [partners]).filter(Boolean);
  const best = row.withAllies
    .map((a) => ({ a, p: mates.find((m) => String(m.id) === String(a.hero?.id)) }))
    .filter((x) => x.p)
    .sort((x, y) => y.a.delta - x.a.delta)[0];
  if (best && best.a.delta >= 0.004) return `Bene con ${best.p.name}`;
  if (row.favorite) return "Tra i tuoi preferiti";
  return null;
}

// Tutti i perché, uno per riga: mappa, ogni avversario, ogni alleato, lato, preferito.
export function details(row) {
  const g = row.mapGuide;
  const lines = [];
  if (g?.strong) lines.push({ good: true, kind: "teoria", text: `consigliato dalle guide su ${row.baseLabel}: ${g.strong.why}` });
  if (g?.avoid) lines.push({ good: false, kind: "teoria", text: `sconsigliato dalle guide su ${row.baseLabel}: ${g.avoid.why}` });
  if (g?.hook) lines.push({ good: true, kind: "teoria", text: hookText(g.hook) });
  return [...lines, ...statDetails(row)];
}
function statDetails(row) {
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

// Logica dei suggerimenti: pura, senza DOM, così si collauda anche in Node.
//
// Il punteggio di un eroe candidato è la somma dei suoi scarti dal 50%:
//   base   = win rate sulla mappa scelta (o generale se nessuna mappa) - 0.5
//   contro = per ogni avversario, win rate del candidato contro di lui - 0.5
//   con    = per ogni alleato, win rate della coppia - 0.5 (pesato a metà)
// "stima" = 50% + punteggio: non è una probabilità esatta, serve a ordinare.

export const SYNERGY_WEIGHT = 0.5;

const sid = (x) => String(x);

export function pairValue(matrix, a, b) {
  const v = matrix?.[sid(a)]?.[sid(b)] ?? matrix?.[sid(b)]?.[sid(a)];
  return typeof v === "number" ? v : null;
}

export function recommend(data, { role, mapSlug = null, enemies = [], allies = [] } = {}) {
  const map = mapSlug ? data.maps.find((m) => m.slug === mapSlug) : null;
  const byId = Object.fromEntries(data.heroes.map((h) => [sid(h.id), h]));
  const taken = new Set(allies.map(sid));

  const rows = data.heroes
    .filter((h) => (!role || h.role === role) && !taken.has(sid(h.id)))
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
      const score = base + contro + con;
      return {
        hero: h,
        score,
        estimate: Math.min(0.99, Math.max(0.01, 0.5 + score)),
        parts: { base, contro, con },
        baseLabel: map ? map.name : "generale",
        baseWr,
        vs: vs.sort((a, b) => b.delta - a.delta),
        withAllies: withAllies.sort((a, b) => b.delta - a.delta),
      };
    })
    .sort((a, b) => b.score - a.score || a.hero.name.localeCompare(b.hero.name));

  return rows;
}

// Frasi brevi da mostrare sotto ogni suggerimento.
export function reasons(row, max = 3) {
  const pct = (d) => `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)}%`;
  const out = [];
  if (Math.abs(row.parts.base) >= 0.005) {
    out.push({ good: row.parts.base > 0, text: `${row.baseLabel} ${pct(row.parts.base)}` });
  }
  for (const v of row.vs) {
    if (Math.abs(v.delta) >= 0.01) out.push({ good: v.delta > 0, text: `vs ${v.hero?.name ?? "?"} ${pct(v.delta)}` });
  }
  for (const a of row.withAllies) {
    if (Math.abs(a.delta) >= 0.005) out.push({ good: a.delta > 0, text: `con ${a.hero?.name ?? "?"} ${pct(a.delta)}` });
  }
  return out.sort((a, b) => Number(b.good) - Number(a.good)).slice(0, max)
    .concat(out.filter((r) => !r.good).slice(0, 1))
    .filter((r, i, arr) => arr.indexOf(r) === i)
    .slice(0, max + 1);
}

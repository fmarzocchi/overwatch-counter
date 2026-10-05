// "Teoria" di gioco: separata dalle statistiche, sempre etichettata come tale nell'app.
//
// Due fonti:
//  1. stili di composizione di counterwatch (hero.style = {POKE, RUSH, DIVE}, 0–1): eroi dello stesso stile
//     si incastrano (es. Junker Queen, Lúcio e Juno sono tutti "Rush");
//  2. app/theory.json: sinergie, counter e modo di giocare raccolti da fonti di Overwatch (guide, wiki,
//     siti e giocatori noti), con le fonti per ogni eroe. Chiave = nome dell'eroe.
// Le liste sono rese simmetriche: se A "batte" B, allora B "è battuto da" A (e le sinergie valgono nei due sensi).

export const STYLES = ["RUSH", "DIVE", "POKE"];
export const STYLE_IT = { RUSH: "Rush", DIVE: "Dive", POKE: "Poke" };
export const STYLE_DESC = {
  RUSH: "si avanza insieme e si combatte da vicino",
  DIVE: "si salta insieme sui bersagli in retrovia",
  POKE: "si colpisce da lontano tenendo la posizione",
};
export const THEORY_WEIGHT = 0.005; // peso piccolo e dichiarato, solo se l'utente lo attiva
const SAME_STYLE_MIN = 0.8; // somiglianza minima (oltre allo stesso stile dominante) per dire "stesso stile"

const sid = (x) => String(x);
const vec = (h) => STYLES.map((k) => Number(h?.style?.[k] ?? 0));

export function dominantStyle(hero) {
  const v = vec(hero);
  if (!v.some((x) => x > 0)) return null;
  return STYLES[v.indexOf(Math.max(...v))];
}

// somiglianza di stile 0–1 (coseno tra i vettori Rush/Dive/Poke)
export function styleSimilarity(a, b) {
  const x = vec(a), y = vec(b);
  const dot = x.reduce((s, v, i) => s + v * y[i], 0);
  const n = Math.hypot(...x) * Math.hypot(...y);
  return n ? dot / n : 0;
}

export function teamStyle(heroes) {
  const hs = heroes.filter((h) => h?.style);
  if (!hs.length) return null;
  const style = Object.fromEntries(STYLES.map((k, i) => [k, hs.reduce((s, h) => s + vec(h)[i], 0) / hs.length]));
  return { style, dominant: dominantStyle({ style }) };
}

// Indice per eroe: {synergies, counters, counteredBy} con why, resi simmetrici, + tags e play.
export function buildTheory(data, raw = {}) {
  const byName = Object.fromEntries(data.heroes.map((h) => [h.name, h]));
  const idx = {};
  const get = (name) => {
    if (!idx[name]) idx[name] = { synergies: new Map(), counters: new Map(), counteredBy: new Map(), tags: [], play: null, uncertain: false, sources: [] };
    return idx[name];
  };
  const add = (map, name, why) => { if (byName[name] && !map.has(name)) map.set(name, why); };
  for (const [name, t] of Object.entries(raw)) {
    if (!byName[name] || !t) continue;
    const e = get(name);
    e.tags = Array.isArray(t.tags) ? t.tags : [];
    e.play = t.play ?? null;
    e.uncertain = !!t.uncertain;
    e.sources = Array.isArray(t.sources) ? t.sources : [];
    for (const s of t.synergies ?? []) { add(e.synergies, s.hero, s.why); if (byName[s.hero]) add(get(s.hero).synergies, name, s.why); }
    for (const c of t.counters ?? []) { add(e.counters, c.hero, c.why); if (byName[c.hero]) add(get(c.hero).counteredBy, name, c.why); }
    for (const c of t.counteredBy ?? []) { add(e.counteredBy, c.hero, c.why); if (byName[c.hero]) add(get(c.hero).counters, name, c.why); }
  }
  return { byName, idx };
}

const list = (map) => [...map].map(([name, why]) => ({ name, why }));

// Scheda teoria di un eroe: sinergie (ricerca + stesso stile), batte, battuto da.
export function heroTheory(data, theory, hero) {
  const e = theory?.idx?.[hero.name];
  const dom = dominantStyle(hero);
  const synergies = e ? list(e.synergies) : [];
  const seen = new Set([hero.name, ...synergies.map((s) => s.name)]);
  // compagni dello stesso stile (dai dati di counterwatch), dopo quelli della ricerca
  const mates = data.heroes
    .filter((h) => !seen.has(h.name) && dominantStyle(h) === dom && styleSimilarity(hero, h) >= SAME_STYLE_MIN)
    .sort((a, b) => styleSimilarity(hero, b) - styleSimilarity(hero, a) || a.name.localeCompare(b.name))
    .map((h) => ({ name: h.name, why: `stesso stile: ${STYLE_IT[dom]}`, style: true }));
  return {
    style: dom,
    synergies: [...synergies, ...mates],
    counters: e ? list(e.counters) : [],
    counteredBy: e ? list(e.counteredBy) : [],
    tags: e?.tags ?? [],
    play: e?.play ?? null,
    uncertain: e?.uncertain ?? !e,
    sources: e?.sources ?? [],
  };
}

// Teoria per una riga di consiglio: incastro di stile con la squadra e counter verso gli avversari segnati.
export function theoryForPick(data, theory, hero, { enemies = [], mates = [] } = {}) {
  const byId = Object.fromEntries(data.heroes.map((h) => [sid(h.id), h]));
  const e = theory?.idx?.[hero.name];
  const enemyHeroes = enemies.map((x) => byId[sid(x)]).filter(Boolean);
  const mateHeroes = mates.map((x) => byId[sid(x)]).filter(Boolean);
  const beats = e ? enemyHeroes.filter((h) => e.counters.has(h.name)).map((h) => ({ name: h.name, why: e.counters.get(h.name) })) : [];
  const beatenBy = e ? enemyHeroes.filter((h) => e.counteredBy.has(h.name)).map((h) => ({ name: h.name, why: e.counteredBy.get(h.name) })) : [];
  const withMates = e ? mateHeroes.filter((h) => e.synergies.has(h.name)).map((h) => ({ name: h.name, why: e.synergies.get(h.name) })) : [];
  const team = teamStyle(mateHeroes);
  const fit = team && dominantStyle(hero) === team.dominant && styleSimilarity(hero, { style: team.style }) >= 0.85
    ? team.dominant : null;
  const score = THEORY_WEIGHT * (beats.length - beatenBy.length + withMates.length + (fit ? 1 : 0));
  return { beats, beatenBy, withMates, fit, score };
}

// ---------- "Come giocarla": consigli dinamici per eroe, mappa, lato, avversari e alleati ----------

const POSITION_IT = {
  "frontline": "Stai in prima linea: crea spazio e assorbi i danni per la squadra.",
  "near-tank": "Stai vicino al tuo tank: avanza e ritirati con lui, non restare isolato.",
  "flank": "Gioca di lato o alle spalle: colpisci le retrovie e torna dalla squadra prima di essere scoperto.",
  "backline": "Stai dietro la squadra, coperto: hai bisogno di linea libera sui compagni.",
  "high-ground": "Prendi le posizioni in alto e le linee lunghe, ma sempre con una via di fuga.",
};
const STYLE_POS = {
  RUSH: "Squadra da Rush: restate compatti e combattete da vicino, entrate insieme.",
  DIVE: "Squadra da Dive: entrate tutti sullo stesso bersaglio nello stesso momento.",
  POKE: "Squadra da Poke: logorate da lontano e non entrate finché non avete un vantaggio.",
};
const TAG_IT = {
  "squishy": "fragile", "flyer": "vola", "sniper": "cecchino", "main-healer": "cura principale", "tanky": "molto resistente",
  "shield": "scudo", "immortality": "rende immortali", "sustain": "si cura da solo", "dive": "salta addosso",
  "mobile": "molto mobile", "stealth": "invisibile", "deployable": "torrette/oggetti", "pocket": "segue un compagno",
};
const MODE_SIDE = {
  attack: "In attacco: raggruppatevi prima di entrare e combattete insieme; non arrivate uno alla volta.",
  defense: "In difesa: tenete il punto forte, sfruttate il tempo e ritiratevi al punto successivo se perdete il primo scontro.",
};
const pct = (d) => `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)}%`;
const names = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} e ${xs[xs.length - 1]}`);

// ctx: {hero, data, mapSlug, side, enemies, allies, partner} (partner = eroe consigliato all'altro giocatore)
// Restituisce sezioni [{title, items:[{text, kind: "teoria"|"statistica"}]}].
export function playGuide(data, theory, { hero, mapSlug = null, side = null, enemies = [], allies = [], partner = null } = {}) {
  const byId = Object.fromEntries(data.heroes.map((h) => [sid(h.id), h]));
  const T = (name) => theory?.idx?.[name];
  const me = T(hero.name);
  const tagsOf = (h) => T(h.name)?.tags ?? [];
  const enemyH = enemies.map((x) => byId[sid(x)]).filter(Boolean);
  const allyH = [...allies.map((x) => byId[sid(x)]), partner].filter(Boolean).filter((h) => sid(h.id) !== sid(hero.id));
  const stat = (a, b) => { const v = data.counters?.[sid(a.id)]?.[sid(b.id)]; return typeof v === "number" ? v - 0.5 : 0; };
  const sections = [];
  const push = (title, items) => { if (items.length) sections.push({ title, items }); };

  // 1. bersagli: chi batti in teoria, chi batti nei numeri, e i bersagli adatti al tuo eroe
  const targets = [];
  const wantTags = me?.play?.targets ?? [];
  const avoidTags = me?.play?.avoidTargets ?? [];
  for (const h of enemyH) {
    const why = me?.counters.get(h.name);
    const d = stat(hero, h);
    const tag = tagsOf(h).find((t) => wantTags.includes(t));
    // priorità: batterlo in teoria, essere un bersaglio adatto all'eroe, i numeri; tank/scudi da evitare in fondo
    const w = (why ? 2 : 0) + (tag ? 1.5 : 0) + d * 20 - (tagsOf(h).some((t) => avoidTags.includes(t)) ? 2.5 : 0);
    if (why) targets.push({ h, text: `${h.name}: ${why}`, kind: "teoria", w });
    else if (d >= 0.015) targets.push({ h, text: `${h.name}: nei dati lo batti (${pct(d)})`, kind: "statistica", w });
    else if (tag) targets.push({ h, text: `${h.name}: è un bersaglio adatto a te (${TAG_IT[tag] ?? tag})`, kind: "teoria", w });
  }
  // in testa solo bersagli "buoni": un tank da evitare non va mai tra i primi
  const isGood = (t) => t.w > 0;
  targets.sort((a, b) => b.w - a.w);
  const good = targets.filter(isGood);
  if (good.length) {
    push("Bersagli", [
      { text: `Punta a ${names(good.slice(0, 3).map((t) => t.h.name))}.`, kind: good[0].kind },
      ...good.slice(0, 4).map(({ text, kind }) => ({ text, kind })),
    ]);
  }

  // 2. su chi non sprecare colpi
  const ignore = enemyH.filter((h) => !good.slice(0, 3).some((t) => t.h === h)
    && (tagsOf(h).some((t) => avoidTags.includes(t)) || (stat(hero, h) <= -0.02 && h.role === "Tank")));
  if (ignore.length) {
    push("Lascia stare", ignore.slice(0, 2).map((h) => {
      const t = tagsOf(h).find((x) => avoidTags.includes(x));
      return { text: `Ignora ${h.name}${t ? ` (${TAG_IT[t] ?? t})` : ""}: non sprecare colpi, cerca altri bersagli.`, kind: t ? "teoria" : "statistica" };
    }));
  }

  // 3. attenzione a chi ti batte
  const danger = [];
  for (const h of enemyH) {
    const why = me?.counteredBy.get(h.name);
    const d = stat(hero, h);
    if (why) danger.push({ text: `${h.name}: ${why}`, kind: "teoria", w: 2 - d });
    else if (d <= -0.015) danger.push({ text: `${h.name}: nei dati ti batte (${pct(d)}), evita l'1 contro 1`, kind: "statistica", w: 1 - d });
  }
  push("Attenzione a", danger.sort((a, b) => b.w - a.w).slice(0, 3).map(({ text, kind }) => ({ text, kind })));

  // 4. proteggi i compagni da chi li batte (soprattutto se tu batti quel nemico)
  const protect = [];
  for (const a of allyH) {
    for (const h of enemyH) {
      const why = T(a.name)?.counteredBy.get(h.name);
      if (!why && stat(a, h) > -0.025) continue;
      const iBeat = me?.counters.has(h.name) || stat(hero, h) >= 0.01;
      protect.push({ text: `Proteggi ${a === partner ? "il tuo compagno con " : "il tuo "}${a.name} da ${h.name}${why ? `: ${why}` : ""}${iBeat ? " — tu lo batti" : ""}.`,
        kind: why ? "teoria" : "statistica", w: (iBeat ? 2 : 1) + (a === partner ? 0.5 : 0) });
    }
  }
  push("Proteggi", protect.sort((a, b) => b.w - a.w).slice(0, 2).map(({ text, kind }) => ({ text, kind })));

  // 5. posizione e stile di squadra
  const pos = [];
  if (me?.play?.position && POSITION_IT[me.play.position]) pos.push({ text: POSITION_IT[me.play.position], kind: "teoria" });
  const team = teamStyle([hero, ...allyH]);
  if (team?.dominant && allyH.length) pos.push({ text: STYLE_POS[team.dominant], kind: "teoria" });
  for (const tip of (me?.play?.tips ?? []).slice(0, 2)) pos.push({ text: tip, kind: "teoria" });
  push("Come muoverti", pos);

  // 6. compagno e alleati con cui ti incastri
  const withYou = allyH.map((a) => ({ a, why: me?.synergies.get(a.name) })).filter((x) => x.why);
  push("Gioca con", withYou.slice(0, 3).map(({ a, why }) => ({ text: `${a.name}: ${why}`, kind: "teoria" })));

  // 7. mappa e lato
  const map = mapSlug ? data.maps.find((m) => m.slug === mapSlug) : null;
  const mapItems = [];
  if (map) {
    const wr = map.winRates?.[sid(hero.id)];
    if (typeof wr === "number") mapItems.push({ text: `Su ${map.name} ${hero.name} vince ${pct(wr - 0.5)} rispetto alla media.`, kind: "statistica" });
  }
  if (side && (map?.mode === "Escort" || map?.mode === "Hybrid")) {
    const own = side === "attack" ? me?.play?.attack : me?.play?.defense;
    mapItems.push({ text: own || MODE_SIDE[side], kind: "teoria" });
  }
  push(map ? `Mappa: ${map.name}` : "Mappa", mapItems);

  if (!sections.length) {
    sections.push({ title: "Consigli", items: [{ text: "Segna mappa e avversari per avere consigli su misura.", kind: "teoria" }] });
  }
  return { sections, uncertain: me ? me.uncertain : true, sources: me?.sources ?? [] };
}

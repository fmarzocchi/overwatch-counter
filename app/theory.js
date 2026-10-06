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
export const THEORY_WEIGHT = 0.005;
const ROLE_IT = { Tank: "Tank", Damage: "Danni", Support: "Supporto" };
export const FEATURE_IT = {
  "env-kills": "baratri per le uccisioni ambientali", "long-sightlines": "linee di tiro lunghe", "close-quarters": "spazi stretti",
  "high-ground": "molte alture", "flank-routes": "vie di fianco", "open-spaces": "spazi aperti", "chokepoints": "strettoie",
}; // peso piccolo e dichiarato, solo se l'utente lo attiva
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
// raw: contenuto di theory.json (eroi + "_maps" + "_researched"); patches: app/patches.json (ultima patch Blizzard)
export function buildTheory(data, raw = {}, patches = null) {
  const byName = Object.fromEntries(data.heroes.map((h) => [h.name, h]));
  const idx = {};
  const get = (name) => {
    if (!idx[name]) {
      idx[name] = { synergies: new Map(), counters: new Map(), counteredBy: new Map(), tags: [], play: null, uncertain: false,
        sources: [], abilities: [], priority: null, mapFeatures: null, role: null };
    }
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
    e.abilities = Array.isArray(t.abilities) ? t.abilities.filter((a) => a && a.name) : [];
    e.priority = t.priority ?? null;
    e.mapFeatures = t.mapFeatures ?? null;
    e.role = t.role ?? null;
    for (const s of t.synergies ?? []) { add(e.synergies, s.hero, s.why); if (byName[s.hero]) add(get(s.hero).synergies, name, s.why); }
    for (const c of t.counters ?? []) { add(e.counters, c.hero, c.why); if (byName[c.hero]) add(get(c.hero).counteredBy, name, c.why); }
    for (const c of t.counteredBy ?? []) { add(e.counteredBy, c.hero, c.why); if (byName[c.hero]) add(get(c.hero).counters, name, c.why); }
  }
  return { byName, idx, maps: raw._maps ?? {}, researched: raw._researched ?? null, patches };
}

// La teoria di un eroe è ancora valida? Si accorge da sola di cambi di ruolo, eroi nuovi e patch successive.
export function theoryStatus(theory, hero) {
  const e = theory?.idx?.[hero.name];
  const reasons = [];
  if (!e) reasons.push("eroe senza teoria (forse nuovo)");
  else {
    if (e.role && e.role !== hero.role) reasons.push(`ha cambiato ruolo (ora ${ROLE_IT[hero.role] ?? hero.role})`);
    const p = theory.patches?.latest;
    if (p?.date && theory.researched && p.date > theory.researched && (p.heroes ?? []).includes(hero.name)) {
      reasons.push(`modificato nella patch del ${p.date}`);
    }
  }
  return { stale: reasons.length > 0, reasons };
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
const lower = (t) => String(t).replace(/\.$/, "").replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase());

// ctx: {hero, data, mapSlug, side, enemies, allies, partners} (partners = eroi presi o consigliati agli altri giocatori;
// partner, un solo eroe, resta accettato)
// Restituisce sezioni [{title, items:[{text, kind: "teoria"|"statistica"}]}].
// rows: consigli ordinati per quel giocatore (per il consiglio di cambio eroe)
// abilità che si usano sui COMPAGNI: effetti di aiuto e nessun effetto contro i nemici.
// "armor" no (Fortify, Kinetic Grasp sono per sé); un campo "on": "allies"|"enemies" in theory.json decide a mano
// (es. Orb of Discord: amplifica i danni ma si lancia su un nemico).
const ALLY_TAGS = ["heal", "damage-amp", "speed", "immortality", "revive", "cleanse"];
const ENEMY_TAGS = ["cc", "stun", "sleep", "hook", "hack", "boop", "knockback", "burst", "anti-heal", "zone", "environmental-kill", "engage"];
export function allyDirected(a) {
  if (a?.on === "allies" || a?.on === "enemies") return a.on === "allies";
  const t = a?.tags ?? [];
  return t.some((x) => ALLY_TAGS.includes(x)) && !t.some((x) => ENEMY_TAGS.includes(x));
}

// Cambio eroe: solo verso un eroe che conviene DAVVERO con questi avversari.
// - nei numeri rende almeno +1,5% in più, oppure
// - in teoria l'eroe attuale è counterato da 2+ avversari e l'alternativa ne soffre meno, senza rendere meno
//   nel punteggio (che con "Usa anche la teoria" comprende già la teoria).
// Così il primo della lista non riceve mai il consiglio di cambiare: l'app non si contraddice.
// rows: alternative ordinate per quel giocatore (recommend). Restituisce {hero, gain, why, kind, countered} o null.
// ---------- modalità "solo guide e pro" (senza statistiche) ----------
// Quanto un eroe è adatto alla mappa secondo guide, coach e giocatori forti (theory.json → _maps[slug]):
//   strong (consigliato, eventualmente solo in attacco o in difesa) +2, avoid (sconsigliato) −2,
//   stile adatto alla mappa (goodStyles) +0.5, caratteristiche della mappa che l'eroe ama/odia (mapFeatures) ±0.25 l'una (max ±1).
export const GUIDE_POINTS = { strong: 2, avoid: 2, style: 0.5, feature: 0.25, beats: 1, synergy: 0.5, favorite: 0.5 };
export function mapFit(theory, mapSlug, hero, side = null) {
  const m = mapSlug ? theory?.maps?.[mapSlug] : null;
  const none = { strong: null, avoid: null, style: false, likes: [], dislikes: [], points: 0 };
  if (!m || !hero) return none;
  const strong = (m.strong?.[hero.role] ?? []).find((x) => x.hero === hero.name && (!x.side || !side || x.side === side)) ?? null;
  const avoid = (m.avoid ?? []).find((x) => x.hero === hero.name) ?? null;
  const dom = dominantStyle(hero);
  const style = !!dom && (m.goodStyles ?? []).includes(dom);
  const mf = theory?.idx?.[hero.name]?.mapFeatures;
  const feats = new Set(m.features ?? []);
  const likes = (mf?.likes ?? []).filter((f) => feats.has(f));
  const dislikes = (mf?.dislikes ?? []).filter((f) => feats.has(f));
  const P = GUIDE_POINTS;
  const featPts = Math.max(-1, Math.min(1, P.feature * (likes.length - dislikes.length)));
  const points = (strong ? P.strong : 0) - (avoid ? P.avoid : 0) + (style ? P.style : 0) + featPts;
  return { strong, avoid, style, likes, dislikes, points };
}

export const SWAP_GAIN = 0.015;
export const SWAP_GAIN_GUIDE = 1.5; // in modalità guide: almeno un motivo pieno in più (es. forte sulla mappa, o batte un avversario e mezzo)
export function swapAdvice(data, theory, { hero, rows = null, enemies = [], guide = false } = {}) {
  if (!hero || !rows || rows.length < 2 || !enemies.length) return null;
  const byId = Object.fromEntries(data.heroes.map((h) => [sid(h.id), h]));
  const enemyH = enemies.map((x) => byId[sid(x)]).filter(Boolean);
  const cur = rows.find((r) => sid(r.hero.id) === sid(hero.id));
  if (!cur) return null;
  const vsTheory = (h) => {
    const t = theory?.idx?.[h.name];
    return { beats: t ? enemyH.filter((e) => t.counters.has(e.name)) : [], beatenBy: t ? enemyH.filter((e) => t.counteredBy.has(e.name)) : [] };
  };
  const countered = vsTheory(hero).beatenBy;
  let best = null;
  for (const r of rows) {
    if (sid(r.hero.id) === sid(hero.id)) continue;
    const gain = r.score - cur.score;
    const th = vsTheory(r.hero);
    const byData = gain >= (guide ? SWAP_GAIN_GUIDE : SWAP_GAIN);
    const byTheory = countered.length >= 2 && th.beatenBy.length < countered.length && gain >= 0;
    if (!byData && !byTheory) continue;
    const value = gain + 0.01 * (th.beats.length - th.beatenBy.length);
    if (!best || value > best.value) best = { r, gain, th, value };
  }
  if (!best) return null;
  const beats = best.th.beats.map((h) => h.name);
  if (guide) {
    const why = beats.length ? `in teoria batte ${names(beats)}` : best.r.guide?.map?.strong ? `per le guide è forte su questa mappa: ${lower(best.r.guide.map.strong.why)}`
      : `per le guide è più adatto a questa partita (${names(countered.map((h) => h.name)) || "mappa e avversari"})`;
    return { hero: best.r.hero, gain: best.gain, why, kind: "teoria", countered };
  }
  // "nei dati": solo la parte statistica (la stima), anche quando il punteggio mescola statistiche e teoria
  const dataGain = typeof best.r.estimate === "number" && typeof cur.estimate === "number" ? best.r.estimate - cur.estimate : best.gain;
  const why = beats.length
    ? `in teoria batte ${names(beats)}${dataGain >= 0.005 ? ` e nei dati rende ${pct(dataGain)} in più` : ""}`
    : dataGain >= 0.005 ? `nei dati rende ${pct(dataGain)} in più con questi avversari`
      : `soffre meno questi avversari (${names(countered.map((h) => h.name))} counterano ${hero.name})`;
  return { hero: best.r.hero, gain: best.gain, why, kind: beats.length || dataGain < 0.005 ? "teoria" : "statistica", countered };
}

export function playGuide(data, theory, { hero, mapSlug = null, side = null, enemies = [], allies = [], partner = null, partners = null, rows = null, guide = false } = {}) {
  const mates = new Set([...(partners ?? []), partner].filter(Boolean).map((h) => sid(h.id)));
  const byId = Object.fromEntries(data.heroes.map((h) => [sid(h.id), h]));
  const T = (name) => theory?.idx?.[name];
  const me = T(hero.name);
  const tagsOf = (h) => T(h.name)?.tags ?? [];
  const enemyH = enemies.map((x) => byId[sid(x)]).filter(Boolean);
  const allyH = [...new Map([...allies.map((x) => byId[sid(x)]), ...(partners ?? []), partner].filter(Boolean)
    .map((h) => [sid(h.id), h])).values()].filter((h) => sid(h.id) !== sid(hero.id));
  // in modalità guide le statistiche non contano
  const stat = (a, b) => { const v = guide ? null : data.counters?.[sid(a.id)]?.[sid(b.id)]; return typeof v === "number" ? v - 0.5 : 0; };
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
    if (why) danger.push({ h, text: `${h.name}: ${why}`, kind: "teoria", w: 2 - d });
    else if (d <= -0.015) danger.push({ h, text: `${h.name}: nei dati ti batte (${pct(d)}), evita l'1 contro 1`, kind: "statistica", w: 1 - d });
  }
  push("Attenzione a", danger.sort((a, b) => b.w - a.w).slice(0, 3).map(({ text, kind }) => ({ text, kind })));

  // 4. proteggi i compagni da chi li batte (soprattutto se tu batti quel nemico)
  const protect = [];
  for (const a of allyH) {
    for (const h of enemyH) {
      const why = T(a.name)?.counteredBy.get(h.name);
      if (!why && stat(a, h) > -0.025) continue;
      const iBeat = me?.counters.has(h.name) || stat(hero, h) >= 0.01;
      protect.push({ text: `Proteggi ${mates.has(sid(a.id)) ? `il tuo compagno (${a.name})` : a.name} da ${h.name}${why ? `: ${why}` : ""}${iBeat ? " — tu lo batti" : ""}.`,
        kind: why ? "teoria" : "statistica", w: (iBeat ? 2 : 1) + (mates.has(sid(a.id)) ? 0.5 : 0) });
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

  // 7. abilità: quale curare, su chi, quando, cosa tenere da parte (in base ad avversari e mappa)
  const map = mapSlug ? data.maps.find((m) => m.slug === mapSlug) : null;
  const mapT = map ? theory?.maps?.[map.slug] : null;
  const enemyNames = new Set(enemyH.map((h) => h.name));
  const allyNames = new Set(allyH.map((h) => h.name));
  const abil = [];
  const keyLines = []; // per il riepilogo
  for (const a of me?.abilities ?? []) {
    const label = `${a.name}${a.it ? ` (${a.it})` : ""}${a.ult ? " — ultimate" : ""}`;
    // abilità da dare ai compagni (Nano Boost, Guardian Angel…): i "targets" sono alleati, non nemici
    if (allyDirected(a)) {
      const mates = (a.targets ?? []).filter((n) => allyNames.has(n));
      if (mates.length) {
        abil.push({ text: `${label}: dalla a ${names(mates)} (squadra tua). ${a.use ?? ""}${a.when ? ` Quando: ${a.when}` : ""}`.trim(), kind: "teoria", w: 2.5 + mates.length });
        keyLines.push({ text: `${a.name} su ${names(mates)}${a.when ? ` (${a.when.replace(/\.$/, "")})` : ""}.`, kind: "teoria", w: 2.5 + mates.length,
          short: `${a.name} su ${names(mates)}${a.when ? ` — ${lower(a.when)}` : ""}` });
      }
    }
    const on = allyDirected(a) ? [] : (a.targets ?? []).filter((n) => enemyNames.has(n));
    if (on.length) {
      const t = `${label}: usala su ${names(on)}. ${a.use ?? ""}${a.when ? ` Quando: ${a.when}` : ""}`.trim();
      abil.push({ text: t, kind: "teoria", w: 3 + on.length });
      keyLines.push({ text: `Usa ${a.name} su ${names(on)}${a.when ? ` (${a.when.replace(/\.$/, "")})` : ""}.`, kind: "teoria", w: 3 + on.length,
        short: `${a.name} su ${names(on)}${a.when ? ` — ${lower(a.when)}` : ""}` });
    }
    for (const sv of (a.saveFor ?? []).filter((x) => enemyNames.has(x.hero))) {
      abil.push({ text: `Tieni ${a.name} per ${sv.hero}: ${sv.why}`, kind: "teoria", w: 4 });
      keyLines.push({ text: `Tieni ${a.name} per ${sv.hero}.`, kind: "teoria", w: 4, short: `Tieni ${a.name} per ${sv.hero}` });
    }
    for (const av of (a.avoidOn ?? []).filter((x) => enemyNames.has(x.hero))) {
      abil.push({ text: `Non sprecare ${a.name} su ${av.hero}: ${av.why}`, kind: "teoria", w: 2.5 });
    }
    const envTag = (a.tags ?? []).some((t) => ["boop", "knockback", "environmental-kill", "hook"].includes(t));
    if (envTag && mapT?.features?.includes("env-kills")) {
      const where = mapT.envKills ? ` (${mapT.envKills})` : "";
      abil.push({ text: `Su ${map.name} usa ${a.name} per spingere nei baratri${where}.`, kind: "teoria", w: 3.5 });
      keyLines.push({ text: `Su ${map.name} cerca le uccisioni ambientali con ${a.name}.`, kind: "teoria", w: 3.5,
        short: `${a.name} per buttare giù dai bordi` });
    }
  }
  const pr = me?.priority?.ability ? (me.abilities ?? []).find((a) => a.name === me.priority.ability) : null;
  if (me?.priority?.ability) {
    abil.push({ text: `Abilità chiave: ${me.priority.ability}${pr?.it ? ` (${pr.it})` : ""} — ${me.priority.why ?? ""}`.trim(), kind: "teoria", w: 5 });
  }
  if (!abil.length) for (const a of (me?.abilities ?? []).slice(0, 3)) {
    abil.push({ text: `${a.name}${a.it ? ` (${a.it})` : ""}: ${a.use ?? ""}${a.when ? ` Quando: ${a.when}` : ""}`, kind: "teoria", w: 1 });
  }
  push("Abilità", abil.sort((a, b) => b.w - a.w).slice(0, 6).map(({ text, kind }) => ({ text, kind })));

  // 8. mappa e lato
  const mapItems = [];
  if (map) {
    const wr = map.winRates?.[sid(hero.id)];
    if (typeof wr === "number") mapItems.push({ text: `Su ${map.name} ${hero.name} vince ${pct(wr - 0.5)} rispetto alla media.`, kind: "statistica" });
    // guide e giocatori forti: eroe consigliato o sconsigliato su questa mappa
    const fit = mapFit(theory, map.slug, hero, side);
    if (fit.strong) mapItems.push({ text: `Le guide lo consigliano su ${map.name}: ${lower(fit.strong.why)}.`, kind: "teoria" });
    if (fit.avoid) mapItems.push({ text: `Le guide lo sconsigliano su ${map.name}: ${lower(fit.avoid.why)}.`, kind: "teoria" });
    const feats = mapT?.features ?? [];
    const likes = (me?.mapFeatures?.likes ?? []).filter((f) => feats.includes(f));
    const dislikes = (me?.mapFeatures?.dislikes ?? []).filter((f) => feats.includes(f));
    if (likes.length) mapItems.push({ text: `La mappa ti favorisce: ${likes.map((f) => FEATURE_IT[f] ?? f).join(", ")}.`, kind: "teoria" });
    if (dislikes.length) mapItems.push({ text: `La mappa ti sfavorisce: ${dislikes.map((f) => FEATURE_IT[f] ?? f).join(", ")}${me?.mapFeatures?.why ? ` — ${me.mapFeatures.why.replace(/[.\s]+$/, "")}` : ""}.`, kind: "teoria" });
    for (const tip of (mapT?.tips ?? []).slice(0, 2)) mapItems.push({ text: tip, kind: "teoria" });
  }
  if (side && (map?.mode === "Escort" || map?.mode === "Hybrid")) {
    const own = side === "attack" ? me?.play?.attack : me?.play?.defense;
    const mapSide = side === "attack" ? mapT?.attack : mapT?.defense;
    mapItems.push({ text: own || MODE_SIDE[side], kind: "teoria" });
    if (mapSide) mapItems.push({ text: `${map.name}, ${side === "attack" ? "attacco" : "difesa"}: ${mapSide}`, kind: "teoria" });
  }
  push(map ? `Mappa: ${map.name}` : "Mappa", mapItems);

  // 9. cambio eroe se la composizione avversaria è sfavorevole (solo verso un eroe che conviene davvero)
  const sw = swapAdvice(data, theory, { hero, rows, enemies, guide });
  let switchLine = null;
  if (sw) {
    switchLine = { text: `Se la partita va male, passa a ${sw.hero.name}: ${sw.why}.`, kind: sw.kind };
    push("Cambio eroe", [switchLine,
      ...(sw.countered.length >= 2 ? [{ text: `${names(sw.countered.map((h) => h.name))} ti mettono in difficoltà.`, kind: "teoria" }] : [])]);
  }

  // 10. riepilogo in testa: poche righe, ognuna con un'etichetta (Punta, Attento, Abilità…) e, dove serve, i volti.
  // text = frase completa (lettori di schermo, test); short = ciò che si legge accanto all'etichetta.
  const summary = [];
  const line = (key, label, text, kind, extra = {}) => summary.push({ key, label, text, kind, short: extra.short ?? null, heroes: extra.heroes ?? null });
  if (sw) line("swap", "Cambia", switchLine.text, sw.kind, { heroes: [sw.hero], short: sw.why });
  // un avversario sta in una sola riga: "Punta" se nel complesso lo batti (numeri + teoria), altrimenti "Attento".
  // Ogni riga dice PERCHÉ e COSA FARE, non solo il nome.
  const signal = (h) => stat(hero, h) + (me?.counters.has(h.name) ? 0.015 : 0) - (me?.counteredBy.has(h.name) ? 0.015 : 0);
  // minuscola iniziale solo se la frase non comincia con un nome (eroe o abilità: "Sleep Dart ferma…")
  const proper = new Set([...data.heroes.map((h) => h.name.split(" ")[0]),
    ...Object.values(theory?.idx ?? {}).flatMap((e) => (e.abilities ?? []).map((a) => String(a.name).split(" ")[0]))]);
  const lowerP = (t) => (proper.has(String(t).trim().split(/[\s,:]/)[0]) ? String(t).replace(/\.$/, "") : lower(t));
  const cut = (t, n = 95) => { const x = String(t).replace(/\s+/g, " ").trim().replace(/\.$/, ""); return x.length <= n ? x : `${x.slice(0, n).replace(/\s+\S*$/, "")}…`; };
  const myAbilityFor = (h) => (me?.abilities ?? []).find((a) => !allyDirected(a)
    && ((a.saveFor ?? []).some((x) => x.hero === h.name) || (a.targets ?? []).includes(h.name)));
  const top3 = good.filter((t) => signal(t.h) > -0.01).slice(0, 3).map((t) => t.h);
  const dangerTop = danger.filter((d) => !top3.includes(d.h) && signal(d.h) < 0.01).sort((a, b) => b.w - a.w).slice(0, 2);
  if (dangerTop.length) {
    const h = dangerTop[0].h;
    const why = me?.counteredBy.get(h.name);
    // chi della tua squadra lo batte, e la tua abilità per gestirlo
    const handler = allyH.find((a) => T(a.name)?.counters.has(h.name));
    const ab0 = myAbilityFor(h);
    // non proporre proprio l'abilità che quell'avversario ti neutralizza ("il Dardo soporifero interrompe Charge")
    const ab = ab0 && why && [ab0.name, ab0.en, ab0.it].filter(Boolean).some((n) => why.includes(n)) ? null : ab0;
    const how = [handler ? `lascia ${h.name} a ${handler.name}` : `evita l'1 contro 1 con ${h.name}`, ab ? `tieni ${ab.name} contro ${h.name}` : null].filter(Boolean).join(", ");
    const hs = dangerTop.map((d) => d.h);
    line("threat", "Attento", `Attento a ${names(hs.map((x) => x.name))}${why ? `: ${cut(why, 140)}` : ""} — ${how}.`, dangerTop[0].kind,
      { heroes: hs, short: `${why ? `${cut(lowerP(why), 80)} — ` : ""}${how}` });
  }
  if (top3.length) {
    const t0 = good.find((t) => t.h === top3[0]);
    const why = me?.counters.get(top3[0].name);
    const ign = ignore.filter((h) => !dangerTop.some((d) => d.h === h)).slice(0, 2).map((h) => h.name);
    const reason = why ? cut(lowerP(why), 80) : t0?.kind === "teoria" ? cut(lowerP(t0.text.replace(/^[^:]+:\s*/, "")), 80) : null;
    line("target", "Punta", `Punta a ${names(top3.map((h) => h.name))}${reason ? `: ${reason}` : ""}${ign.length ? `; ignora ${names(ign)}` : ""}.`,
      good[0].kind, { heroes: top3, short: [reason, ign.length ? `ignora ${names(ign)}` : null].filter(Boolean).join(" · ") || null });
  }
  const keyTop = keyLines.sort((a, b) => b.w - a.w).slice(0, 2);
  for (const k of keyTop) line("ability", "Abilità", k.text, k.kind, { short: k.short });
  if (!keyTop.length && me?.priority?.ability) {
    line("ability", "Abilità", `Abilità su cui puntare: ${me.priority.ability}.`, "teoria", { short: `${me.priority.ability}: ${cut(lowerP(me.priority.why ?? "la più importante"), 80)}` });
  }
  // combo con il compagno (o un alleato): cosa fare insieme
  const combo = allyH.map((a) => ({ a, why: me?.synergies.get(a.name) ?? T(a.name)?.synergies.get(hero.name) })).filter((x) => x.why)
    .sort((x, y) => (mates.has(sid(y.a.id)) ? 1 : 0) - (mates.has(sid(x.a.id)) ? 1 : 0))[0];
  if (combo) line("combo", "Combo", `Con ${combo.a.name}: ${cut(combo.why, 140)}.`, "teoria", { heroes: [combo.a], short: cut(lowerP(combo.why), 90) });
  // ultimate: quando usarla (se non è già in una riga sopra)
  const ult = (me?.abilities ?? []).find((a) => a.ult && a.when);
  if (ult && !keyTop.some((k) => k.text.includes(ult.name))) {
    line("ult", "Ultimate", `${ult.name}: ${cut(ult.when, 140)}.`, "teoria", { short: `${ult.name}: ${cut(lowerP(ult.when), 80)}` });
  }
  // piano per la mappa: prima il lato (attacco/difesa), poi cosa dicono le guide di questo eroe qui, poi la mappa
  if (map) {
    const fit = mapFit(theory, map.slug, hero, side);
    const sideTxt = side ? (side === "attack" ? mapT?.attack : mapT?.defense) : null;
    const plan = fit.avoid ? { t: `le guide lo sconsigliano qui: ${lowerP(fit.avoid.why)}`, k: "teoria" }
      : sideTxt ? { t: `${side === "attack" ? "in attacco" : "in difesa"}: ${lowerP(sideTxt)}`, k: "teoria" }
        : fit.strong ? { t: `qui è consigliato: ${lowerP(fit.strong.why)}`, k: "teoria" }
          : (() => { const m = mapItems.find((x) => x.kind === "teoria" && /favorisce|sfavorisce|baratri/.test(x.text)) ?? mapItems.find((x) => !guide || x.kind === "teoria");
            return m ? { t: m.text.replace(/^La mappa /, "").replace(/\.$/, ""), k: m.kind } : null; })();
    if (plan) line("map", "Piano", `${map.name}, ${plan.t}.`, plan.k, { short: cut(plan.t, 110).replace(/^\p{Ll}/u, (c) => c.toUpperCase()) });
  }
  const pz = protect.sort((a, b) => b.w - a.w)[0];
  if (pz) {
    const t = pz.text.replace(/ — tu lo batti\.?$/, "").replace(/\.$/, "");
    line("protect", "Proteggi", `${t}.`, pz.kind, { short: cut(t.replace(/^Proteggi /, ""), 90) });
  }
  // posizione generica solo se resta spazio
  if (summary.length < 5 && me?.play?.position && POSITION_IT[me.play.position]) line("position", "Posizione", POSITION_IT[me.play.position], "teoria");
  // ordine d'importanza (al massimo 7 righe): cambio, minaccia, bersagli, abilità chiave, combo, piano, ultimate,
  // poi la seconda abilità, chi proteggere e la posizione
  const PRIO = { swap: 0, threat: 1, target: 2, ability: 3, combo: 4, map: 5, ult: 6, protect: 8, position: 9 };
  let abilSeen = 0;
  const ranked = summary.map((it, k) => ({ it, k, p: it.key === "ability" && abilSeen++ ? 7 : PRIO[it.key] ?? 10 }))
    .sort((a, b) => a.p - b.p || a.k - b.k).map((x) => x.it);
  summary.splice(0, summary.length, ...ranked);
  if (summary.length) sections.unshift({ title: "In breve", summary: true, items: summary.slice(0, 7) });

  // modalità guide: niente righe tratte dalle statistiche
  if (guide) {
    for (const sec of sections) sec.items = sec.items.filter((it) => it.kind !== "statistica");
    sections.splice(0, sections.length, ...sections.filter((sec) => sec.items.length));
  }
  if (!sections.length) {
    sections.push({ title: "Consigli", items: [{ text: "Segna mappa e avversari per avere consigli su misura.", kind: "teoria" }] });
  }
  return { sections, uncertain: me ? me.uncertain : true, sources: me?.sources ?? [] };
}

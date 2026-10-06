// Test della "teoria": stili di counterwatch, unione simmetrica dei dati di ricerca, consigli "Come giocarla".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  dominantStyle, styleSimilarity, teamStyle, buildTheory, heroTheory, theoryForPick, playGuide, theoryStatus, THEORY_WEIGHT, allyDirected, swapAdvice,
  mapFit, GUIDE_POINTS,
} from "../app/theory.js";
import { recommend, recommendDuo, recommendTeam, details, guideBanSuggestions, guideDetails, guideStars, headline, THEORY_SHARE, GUIDE_TO_WR,
  blendedBanSuggestions, banSuggestions } from "../app/recommend.js";

const data = JSON.parse(readFileSync(new URL("../app/data.json", import.meta.url)));
const hero = (name) => data.heroes.find((h) => h.name === name) ?? assert.fail(`eroe mancante: ${name}`);
const id = (name) => hero(name).id;

// teoria di prova (quella vera è in app/theory.json, raccolta da fonti)
const RAW = {
  "Junker Queen": {
    tags: ["tanky", "short-range", "sustain"],
    synergies: [{ hero: "Lúcio", why: "velocità per entrare insieme" }],
    counters: [{ hero: "Zenyatta", why: "lo raggiunge e lo finisce da vicino" }],
    counteredBy: [{ hero: "Ana", why: "anti-nade blocca le sue cure" }],
    play: { position: "frontline", targets: ["squishy"], avoidTargets: ["shield"], tips: ["Entra quando i supporti hanno usato le abilità"],
      attack: "Entra per prima sul punto con Lúcio", defense: "Tieni lo stretto e punisci chi entra" },
    sources: ["https://example.org/jq"],
  },
  Cassidy: { tags: ["hitscan"], counters: [{ hero: "Pharah", why: "hitscan contro chi vola" }], play: { position: "backline", targets: ["flyer", "squishy"] } },
  Pharah: { tags: ["flyer", "squishy", "spam"] },
  Zenyatta: { tags: ["squishy", "main-healer"], counteredBy: [{ hero: "Reaper", why: "da vicino Zenyatta non scappa" }] },
  Orisa: { tags: ["tanky", "shield"] },
  Inventato: { synergies: [{ hero: "Ana", why: "non esiste" }] },
};
const T = buildTheory(data, RAW);

test("stili di counterwatch: Junker Queen, Lúcio e Juno sono Rush, Mercy no", () => {
  for (const n of ["Junker Queen", "Lúcio", "Juno"]) assert.equal(dominantStyle(hero(n)), "RUSH", n);
  assert.notEqual(dominantStyle(hero("Mercy")), "RUSH");
  assert.ok(styleSimilarity(hero("Junker Queen"), hero("Lúcio")) > styleSimilarity(hero("Junker Queen"), hero("Mercy")));
  assert.equal(teamStyle([hero("Junker Queen"), hero("Lúcio"), hero("Reinhardt")]).dominant, "RUSH");
});

test("teoria resa simmetrica: se A batte B, B è battuto da A (e le sinergie valgono nei due sensi)", () => {
  assert.equal(T.idx.Zenyatta.counteredBy.get("Junker Queen"), "lo raggiunge e lo finisce da vicino");
  assert.equal(T.idx.Ana.counters.get("Junker Queen"), "anti-nade blocca le sue cure");
  assert.equal(T.idx["Lúcio"].synergies.get("Junker Queen"), "velocità per entrare insieme");
  assert.equal(T.idx.Pharah.counteredBy.get("Cassidy"), "hitscan contro chi vola");
  assert.ok(!T.idx.Inventato, "eroi inesistenti ignorati");
});

test("scheda teoria: sinergie della ricerca prima, poi tutti gli eroi dello stesso stile", () => {
  const jq = heroTheory(data, T, hero("Junker Queen"));
  assert.equal(jq.style, "RUSH");
  assert.equal(jq.synergies[0].name, "Lúcio");
  assert.ok(jq.synergies.some((s) => s.name === "Juno" && s.style), "Juno per stile");
  assert.ok(!jq.synergies.some((s) => s.name === "Mercy"), "Mercy non è Rush");
  assert.equal(new Set(jq.synergies.map((s) => s.name)).size, jq.synergies.length, "niente doppioni");
  assert.deepEqual(jq.counters.map((c) => c.name), ["Zenyatta"]);
  assert.deepEqual(jq.counteredBy.map((c) => c.name), ["Ana"]);
  const unknown = heroTheory(data, T, hero("Mei"));
  assert.ok(unknown.uncertain && unknown.counters.length === 0, "senza ricerca: solo lo stile, segnato come incerto");
});

test("teoria nei consigli: vista sempre, nel punteggio solo se attivata", () => {
  const ctx = { role: "Damage", enemies: [id("Pharah")], theory: T };
  const off = recommend(data, ctx).find((r) => r.hero.name === "Cassidy");
  const on = recommend(data, { ...ctx, useTheory: true }).find((r) => r.hero.name === "Cassidy");
  assert.equal(off.theory.beats[0].name, "Pharah");
  assert.equal(off.parts.teoria, 0);
  // statistiche 45% + teoria 55% (punti delle guide portati sulla scala dei win rate)
  const stat = off.score - off.parts.pref;
  const guide = recommend(data, { ...ctx, guideOnly: true }).find((r) => r.hero.name === "Cassidy");
  const expected = 2 * (1 - THEORY_SHARE) * stat + 2 * THEORY_SHARE * GUIDE_TO_WR * (guide.score - guide.parts.pref);
  assert.ok(Math.abs(on.score - on.parts.pref - expected) < 1e-12, `${on.score} vs ${expected}`);
  assert.ok(Math.abs(on.parts.teoria - (expected - stat)) < 1e-12);
  assert.ok(Math.abs(on.estimate - off.estimate) < 1e-12, "la stima resta statistica");
  assert.ok(details(off).some((d) => d.kind === "teoria" && d.text.startsWith("batte Pharah")));
  const fit = theoryForPick(data, T, hero("Junker Queen"), { mates: [id("Lúcio"), id("Juno")] });
  assert.equal(fit.fit, "RUSH");
  // in due la teoria passa ai giocatori
  const duo = recommendDuo(data, { theory: T, enemies: [id("Pharah")], players: [{ role: "Damage" }, { role: "Support" }] });
  assert.ok(duo.lists[0].every((r) => r.theory));
});

test("come giocarla: bersagli, attenzione, proteggi, posizione, mappa e lato", () => {
  const g = playGuide(data, T, {
    hero: hero("Junker Queen"), mapSlug: "kings-row", side: "attack",
    enemies: [id("Zenyatta"), id("Ana"), id("Orisa"), id("Reaper")], allies: [], partner: hero("Zenyatta"),
  });
  const text = (title) => (g.sections.find((s) => s.title.startsWith(title))?.items ?? []).map((i) => i.text).join(" | ");
  assert.match(text("Bersagli"), /Punta a Zenyatta/);
  assert.match(text("Lascia stare"), /Ignora Orisa/);
  assert.match(text("Attenzione a"), /Ana: anti-nade/);
  assert.match(text("Proteggi"), /Proteggi il tuo compagno \(Zenyatta\) da Reaper/);
  assert.match(text("Come muoverti"), /prima linea/);
  assert.match(text("Mappa"), /King's Row/);
  assert.match(text("Mappa"), /Entra per prima sul punto con Lúcio/);
  assert.ok(g.sections.every((s) => s.items.every((i) => ["teoria", "statistica"].includes(i.kind))));
  // su Controllo niente consiglio di lato
  const ctl = playGuide(data, T, { hero: hero("Junker Queen"), mapSlug: "ilios", side: "attack", enemies: [id("Zenyatta")] });
  assert.doesNotMatch(ctl.sections.map((s) => s.items.map((i) => i.text).join(" ")).join(" "), /Entra per prima/);
  // senza nulla segnato: invito a segnare mappa e avversari
  const empty = playGuide(data, {}, { hero: hero("Mei") });
  assert.match(empty.sections[0].items[0].text, /Segna mappa e avversari/);
});

// abilità e mappe di prova (quelle vere arrivano dalla ricerca in theory.json)
const RAW2 = {
  ...RAW,
  _researched: "2026-10-05",
  _maps: {
    ilios: { features: ["env-kills", "close-quarters"], envKills: "il pozzo al centro", tips: ["Controlla il pozzo"] },
    "kings-row": { features: ["chokepoints", "high-ground"], attack: "Sfondate la prima strettoia insieme", defense: "Tenete il primo punto dall'alto" },
  },
  "Junker Queen": {
    ...RAW["Junker Queen"], role: "Tank",
    abilities: [
      { name: "Jagged Blade", it: "lama", tags: ["hook"], use: "Tira a te un bersaglio fragile", when: "quando è lontano dai compagni", targets: ["Zenyatta", "Ana"] },
      { name: "Commanding Shout", it: "grido", tags: ["speed"], use: "Velocità e salute alla squadra", saveFor: [{ hero: "Ana", why: "per salvarti dall'anti-nade" }] },
      { name: "Rampage", it: "ultimate", ult: true, tags: ["anti-heal"], use: "Ferite che bloccano le cure", avoidOn: [{ hero: "Kiriko", why: "Suzu la annulla" }] },
    ],
    priority: { ability: "Commanding Shout", why: "decide se sopravvivi negli scontri ravvicinati" },
    mapFeatures: { likes: ["close-quarters"], dislikes: ["long-sightlines"], why: "devi arrivare addosso" },
  },
  Kiriko: { role: "Support" },
};
const T2 = buildTheory(data, RAW2, { latest: { date: "2026-10-20", heroes: ["Cassidy"] } });

test("come giocarla: abilità su chi, quando, cosa tenere e cosa non sprecare", () => {
  const g = playGuide(data, T2, { hero: hero("Junker Queen"), mapSlug: "ilios", enemies: [id("Zenyatta"), id("Ana"), id("Kiriko")] });
  const ab = g.sections.find((s) => s.title === "Abilità").items.map((i) => i.text).join(" | ");
  assert.match(ab, /Jagged Blade \(lama\): usala su Zenyatta e Ana/);
  assert.match(ab, /Tieni Commanding Shout per Ana: per salvarti dall'anti-nade/);
  assert.match(ab, /Non sprecare Rampage su Kiriko: Suzu la annulla/);
  assert.match(ab, /Abilità chiave: Commanding Shout/);
  assert.match(ab, /Su Ilios usa Jagged Blade per spingere nei baratri \(il pozzo al centro\)/);
  const mp = g.sections.find((s) => s.title.startsWith("Mappa")).items.map((i) => i.text).join(" | ");
  assert.match(mp, /La mappa ti favorisce: spazi stretti/);
  assert.match(mp, /Controlla il pozzo/);
});

test("come giocarla: riepilogo «In breve» in testa con bersagli, abilità, mappa e cambio eroe", () => {
  const ctx = { mapSlug: "kings-row", side: "defense", enemies: [id("Zenyatta"), id("Ana"), id("Kiriko"), id("Mei")] };
  const rows = recommend(data, { role: "Tank", ...ctx, theory: T2 });
  const g = playGuide(data, T2, { hero: hero("Junker Queen"), ...ctx, rows });
  assert.equal(g.sections[0].title, "In breve");
  const brief = g.sections[0].items.map((i) => i.text).join(" | ");
  assert.match(brief, /Punta a/);
  assert.match(brief, /Usa Jagged Blade su Zenyatta e Ana|Tieni Commanding Shout per Ana/);
  assert.match(brief, /La mappa ti sfavorisce|King's Row/);
  // ogni riga del riepilogo ha etichetta e testo breve o volti
  assert.ok(g.sections[0].items.every((i) => i.label && (i.short || i.heroes?.length || i.text)), JSON.stringify(g.sections[0].items));
  assert.match(g.sections.find((s) => s.title.startsWith("Mappa")).items.map((i) => i.text).join(" "), /King's Row, difesa: Tenete il primo punto dall'alto/);
  // l'eroe peggiore della lista riceve il consiglio di cambiare (verso uno migliore), anche nel riepilogo
  const worst = rows[rows.length - 1];
  const gw = playGuide(data, T2, { hero: worst.hero, ...ctx, rows });
  const sw = gw.sections.find((s) => s.title === "Cambio eroe");
  assert.ok(sw && /Se la partita va male, passa a /.test(sw.items[0].text), JSON.stringify(sw));
  assert.ok(!sw.items[0].text.includes(`passa a ${worst.hero.name}`));
  assert.equal(gw.sections[0].items[0].key, "swap", "il cambio eroe è la prima riga del riepilogo");
});

test("cambio eroe: mai verso un eroe che rende meno, mai per il primo della lista", () => {
  const raw = JSON.parse(readFileSync(new URL("../app/theory.json", import.meta.url)));
  const TT = buildTheory(data, raw, null);
  for (const enemies of [["Winston", "Genji", "Pharah"], ["Reinhardt", "Ana", "Kiriko", "Mei"], ["D.Va", "Tracer", "Sombra", "Lúcio", "Moira"]]) {
    const ids = enemies.map(id);
    for (const role of ["Tank", "Damage", "Support"]) {
      for (const useTheory of [false, true]) {
        const rows = recommend(data, { role, mapSlug: "kings-row", enemies: ids, theory: TT, useTheory });
        assert.equal(swapAdvice(data, TT, { hero: rows[0].hero, rows, enemies: ids }), null, `${role}: il n.1 non deve cambiare`);
        for (const r of rows) {
          const sw = swapAdvice(data, TT, { hero: r.hero, rows, enemies: ids });
          if (!sw) continue;
          assert.ok(sw.gain >= 0, `${r.hero.name} → ${sw.hero.name}: ${sw.gain}`);
          assert.notEqual(sw.hero.name, r.hero.name);
          assert.ok(sw.why && !/−/.test(sw.why), sw.why);
        }
      }
    }
  }
  // senza avversari o senza alternative: niente consiglio
  const rows = recommend(data, { role: "Tank" });
  assert.equal(swapAdvice(data, TT, { hero: rows[3].hero, rows, enemies: [] }), null);
});

test("cambio eroe con «solo preferiti»: solo verso un preferito (o nessun cambio)", () => {
  const raw = JSON.parse(readFileSync(new URL("../app/theory.json", import.meta.url)));
  const TT = buildTheory(data, raw, null);
  let nonFavWithout = 0;
  for (const enemies of [["Winston", "Genji", "Pharah"], ["Reinhardt", "Ana", "Kiriko", "Mei"], ["D.Va", "Tracer", "Sombra", "Lúcio", "Moira"]]) {
    const ids = enemies.map(id);
    for (const role of ["Tank", "Damage", "Support"]) {
      const all = recommend(data, { role, mapSlug: "kings-row", enemies: ids }).filter((r) => !ids.includes(r.hero.id));
      const picked = all[all.length - 1].hero; // preso un eroe debole, non preferito
      const favs = [all[3].hero.id, all[5].hero.id];
      for (const onlyFavorites of [false, true]) {
        const { lists } = recommendTeam(data, {
          players: [{ role, favorites: favs, onlyFavorites, picked: picked.id }], mapSlug: "kings-row", enemies: ids, theory: TT,
        });
        const rows = lists[0];
        assert.ok(rows[0].picked && rows[0].hero.id === picked.id, "l'eroe preso resta in cima");
        const sw = swapAdvice(data, TT, { hero: picked, rows, enemies: ids });
        if (onlyFavorites) {
          assert.ok(rows.slice(1).every((r) => favs.includes(r.hero.id)), `${role}: alternative solo tra i preferiti`);
          if (sw) assert.ok(favs.includes(sw.hero.id), `${role}: ${sw.hero.name} non è tra i preferiti`);
        } else if (sw && !favs.includes(sw.hero.id)) nonFavWithout++;
      }
    }
  }
  assert.ok(nonFavWithout > 0, "senza l'opzione il cambio può proporre eroi non preferiti: il test misura qualcosa");
  // nessun preferito utilizzabile nel ruolo: nessuna alternativa, quindi nessun cambio
  const { lists } = recommendTeam(data, { players: [{ role: "Tank", favorites: [id("Ana")], onlyFavorites: true, picked: id("Reinhardt") }],
    enemies: [id("Pharah")] });
  assert.equal(lists[0].length, 1);
  assert.equal(swapAdvice(data, TT, { hero: hero("Reinhardt"), rows: lists[0], enemies: [id("Pharah")] }), null);
});

test("riepilogo: un avversario sta in una sola riga (Punta o Attento), coerente con il riquadro", () => {
  const raw = JSON.parse(readFileSync(new URL("../app/theory.json", import.meta.url)));
  const TT = buildTheory(data, raw, null);
  for (const role of ["Tank", "Damage", "Support"]) {
    const enemies = ["Winston", "Genji", "Pharah", "Ana", "Reinhardt"].map(id);
    const rows = recommend(data, { role, mapSlug: "kings-row", enemies, theory: TT });
    for (const r of rows.slice(0, 6)) {
      const g = playGuide(data, TT, { hero: r.hero, mapSlug: "kings-row", enemies, rows });
      const items = g.sections[0].items;
      const target = items.find((i) => i.key === "target")?.heroes ?? [];
      const threat = items.find((i) => i.key === "threat")?.heroes ?? [];
      assert.ok(target.every((h) => !threat.includes(h)), `${r.hero.name}: ${target.map((h) => h.name)} / ${threat.map((h) => h.name)}`);
      assert.ok(items.length <= 7);
    }
  }
});

test("teoria che invecchia: cambio di ruolo, patch successiva, eroe senza teoria", () => {
  const sombra = { ...hero("Sombra"), role: "Support" };
  const T3 = buildTheory({ ...data, heroes: data.heroes.map((h) => (h.name === "Sombra" ? sombra : h)) },
    { ...RAW2, Sombra: { role: "Damage" } }, { latest: { date: "2026-10-20", heroes: ["Junker Queen"] } });
  assert.match(theoryStatus(T3, sombra).reasons.join(), /ha cambiato ruolo \(ora Supporto\)/);
  assert.match(theoryStatus(T3, hero("Junker Queen")).reasons.join(), /modificato nella patch del 2026-10-20/);
  assert.equal(theoryStatus(T3, hero("Kiriko")).stale, false);
  assert.match(theoryStatus(T3, hero("Mei")).reasons.join(), /senza teoria/);
});

test("come giocarla: le abilità per i compagni puntano agli alleati, quelle offensive ai nemici", () => {
  const raw = JSON.parse(readFileSync(new URL("../app/theory.json", import.meta.url)));
  const T = buildTheory(data, raw, null);
  const hid = (n) => data.heroes.find((h) => h.name === n).id;
  const ana = data.heroes.find((h) => h.name === "Ana");
  const g = playGuide(data, T, { hero: ana, enemies: ["Winston", "Genji"].map(hid), allies: [hid("Reinhardt")] });
  const all = g.sections.flatMap((s) => s.items.map((i) => i.text)).join("\n");
  assert.ok(!/Nano Boost[^\n]*Winston/.test(all), "Nano Boost non va dato a un nemico");
  assert.match(all, /Nano Boost[^\n]*Reinhardt/);
  assert.match(all, /Sleep Dart[^\n]*Winston/);
  assert.ok(!/\.\./.test(all), "niente doppi punti");
  // Kinetic Grasp (per sé) e Orb of Discord (sui nemici) non sono abilità "per i compagni"
  const abil = (h, n) => raw[h].abilities.find((a) => a.name === n);
  assert.equal(allyDirected(abil("Sigma", "Kinetic Grasp")), false);
  assert.equal(allyDirected(abil("Zenyatta", "Orb of Discord")), false);
  assert.equal(allyDirected(abil("Mercy", "Caduceus Staff")), true);
});

// ---------- modalità "solo guide e pro" ----------
const GUIDE_RAW = {
  _maps: {
    "kings-row": {
      features: ["close-quarters", "chokepoints"], goodStyles: ["RUSH"],
      strong: { Tank: [{ hero: "Reinhardt", why: "Spazi stretti, scudo e martello", side: null }],
        Damage: [{ hero: "Mei", why: "Muro sulle strettoie", side: "defense" }], Support: [{ hero: "Lúcio", why: "Velocità per il rush", side: null }] },
      avoid: [{ hero: "Widowmaker", why: "Poche linee lunghe" }, { hero: "Pharah", why: "Tetti bassi" }],
    },
  },
  Reinhardt: { counters: [{ hero: "Genji", why: "lo schiaccia da vicino" }] },
  Winston: { counteredBy: [{ hero: "Reaper", why: "danni ravvicinati" }] },
};

test("guide: mapFit premia i consigliati, penalizza gli sconsigliati, rispetta il lato", () => {
  const TT = buildTheory(data, GUIDE_RAW, null);
  const rein = mapFit(TT, "kings-row", hero("Reinhardt"));
  assert.ok(rein.strong && rein.points >= GUIDE_POINTS.strong, JSON.stringify(rein));
  const widow = mapFit(TT, "kings-row", hero("Widowmaker"));
  assert.ok(widow.avoid && widow.points <= -GUIDE_POINTS.avoid + 1, JSON.stringify(widow));
  assert.ok(mapFit(TT, "kings-row", hero("Mei"), "defense").strong);
  assert.equal(mapFit(TT, "kings-row", hero("Mei"), "attack").strong, null, "consigliato solo in difesa");
  assert.equal(mapFit(TT, null, hero("Mei")).points, 0);
});

test("guide: i consigli non dipendono dalle statistiche (stesse scelte con numeri stravolti)", () => {
  const TT = buildTheory(data, GUIDE_RAW, null);
  const scrambled = {
    ...data,
    overall: Object.fromEntries(Object.keys(data.overall).map((k, i) => [k, 0.3 + ((i * 37) % 40) / 100])),
    counters: Object.fromEntries(Object.entries(data.counters).map(([h, row]) => [h, Object.fromEntries(Object.keys(row).map((o, i) => [o, 0.2 + ((i * 13) % 60) / 100]))])),
    maps: data.maps.map((m) => ({ ...m, winRates: Object.fromEntries(Object.keys(m.winRates).map((k, i) => [k, 0.35 + ((i * 7) % 30) / 100])) })),
  };
  const ctx = { mapSlug: "kings-row", enemies: [id("Genji")], theory: TT, guideOnly: true };
  for (const role of ["Tank", "Damage", "Support"]) {
    const a = recommend(data, { ...ctx, role }).map((r) => r.hero.name);
    const b = recommend(scrambled, { ...ctx, role }).map((r) => r.hero.name);
    assert.deepEqual(a, b, role);
  }
  const tanks = recommend(data, { ...ctx, role: "Tank" });
  assert.equal(tanks[0].hero.name, "Reinhardt", "consigliato sulla mappa e batte Genji");
  assert.equal(tanks[0].estimate, null, "niente percentuale");
  assert.equal(guideStars(tanks[0]), 3);
  assert.equal(headline(tanks[0]), "Consigliato su King's Row");
  assert.ok(guideDetails(tanks[0]).every((d) => d.kind === "teoria") && guideDetails(tanks[0]).some((d) => /batte Genji/.test(d.text)));
  const dmg = recommend(data, { ...ctx, role: "Damage" }).map((r) => r.hero.name);
  assert.ok(dmg.indexOf("Widowmaker") > dmg.length - 3 && dmg.indexOf("Pharah") > dmg.length - 3, "gli sconsigliati in fondo");
});

test("guide: ban consigliati dalle guide (forti sulla mappa e contro i vostri eroi), mai i vostri", () => {
  const TT = buildTheory(data, GUIDE_RAW, null);
  const rec = guideBanSuggestions(data, TT, { mapSlug: "kings-row", ours: [id("Winston")], keep: [id("Lúcio")] });
  assert.equal(rec.Tank[0].hero.name, "Reinhardt");
  assert.ok(rec.Damage.some((r) => r.hero.name === "Reaper" || r.hero.name === "Mei"), JSON.stringify(rec.Damage.map((r) => r.hero.name)));
  assert.ok(Object.values(rec).flat().every((r) => !["Winston", "Lúcio"].includes(r.hero.name)));
  assert.ok(Object.values(rec).every((rows) => rows.length === 2));
});

test("guide: nella guida nessuna riga tratta dalle statistiche", () => {
  const raw = JSON.parse(readFileSync(new URL("../app/theory.json", import.meta.url)));
  const TT = buildTheory(data, raw, null);
  const rows = recommend(data, { role: "Damage", mapSlug: "kings-row", enemies: [id("Pharah"), id("Winston")], theory: TT, guideOnly: true });
  const g = playGuide(data, TT, { hero: rows[0].hero, mapSlug: "kings-row", enemies: [id("Pharah"), id("Winston")], rows, guide: true });
  assert.ok(g.sections.flatMap((s) => s.items).every((it) => it.kind !== "statistica"));
});

test("statistiche + teoria: concorrono entrambe, la teoria pesa di più (55%)", () => {
  const TT = buildTheory(data, GUIDE_RAW, null);
  const ctx = { role: "Damage", mapSlug: "kings-row", theory: TT };
  const stat = recommend(data, ctx);
  const both = recommend(data, { ...ctx, useTheory: true });
  const pos = (rows, n) => rows.findIndex((r) => r.hero.name === n);
  // consigliato dalle guide sulla mappa: sale; sconsigliato: scende
  assert.ok(pos(both, "Mei") <= pos(stat, "Mei") || pos(stat, "Mei") === 0, "Mei sale");
  assert.ok(pos(both, "Widowmaker") >= pos(stat, "Widowmaker"), "Widowmaker scende");
  // un motivo pieno delle guide (2 punti) pesa più di 2 punti di win rate... ma meno dello stesso scarto in entrambi
  assert.ok(2 * THEORY_SHARE * GUIDE_TO_WR > 2 * (1 - THEORY_SHARE) * GUIDE_TO_WR, "teoria leggermente più pesante");
  // stima invariata
  for (const r of both) assert.ok(Math.abs(r.estimate - stat.find((x) => x.hero.id === r.hero.id).estimate) < 1e-12);
  // ban: mescolati, consigliati dalle guide in alto
  const bans = blendedBanSuggestions(data, TT, { mapSlug: "kings-row" });
  const plain = banSuggestions(data, { mapSlug: "kings-row", perRole: 99 });
  assert.ok(Object.values(bans).every((rows) => rows.length === 2));
  const reinStat = plain.Tank.findIndex((r) => r.hero.name === "Reinhardt");
  assert.ok(bans.Tank.some((r) => r.hero.name === "Reinhardt") || reinStat > 6, "Reinhardt (consigliato dalle guide) tra i ban se non è in fondo nei numeri");
});

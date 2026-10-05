// Test della "teoria": stili di counterwatch, unione simmetrica dei dati di ricerca, consigli "Come giocarla".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  dominantStyle, styleSimilarity, teamStyle, buildTheory, heroTheory, theoryForPick, playGuide, theoryStatus, THEORY_WEIGHT, allyDirected,
} from "../app/theory.js";
import { recommend, recommendDuo, details } from "../app/recommend.js";

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
  assert.ok(Math.abs(on.parts.teoria - THEORY_WEIGHT) < 1e-12);
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
  // Ana, Kiriko e Mei la battono in teoria (Ana nei dati di prova + Kiriko/Mei se presenti): cambio eroe consigliato
  const sw = g.sections.find((s) => s.title === "Cambio eroe");
  assert.ok(sw && /Se la partita va male, passa a /.test(sw.items[0].text), JSON.stringify(sw));
  assert.ok(!sw.items[0].text.includes("passa a Junker Queen"));
  assert.match(brief, /Se la partita va male, passa a/);
  assert.match(g.sections.find((s) => s.title.startsWith("Mappa")).items.map((i) => i.text).join(" "), /King's Row, difesa: Tenete il primo punto dall'alto/);
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

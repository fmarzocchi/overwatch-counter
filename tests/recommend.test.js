// Test della logica dei suggerimenti sui dati reali di app/data.json.  Uso: node --test tests/*.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  recommend, recommendDuo, recommendTeam, matchups, headline, MATCHUP_MIN, reasons, breakdown, details, withDivision, heroProfile, sideBonus, hasSides, FAVORITE_BONUS, SYNERGY_WEIGHT, pairValue,
} from "../app/recommend.js";

const data = JSON.parse(readFileSync(new URL("../app/data.json", import.meta.url)));
const hero = (name) => data.heroes.find((h) => h.name === name) ?? assert.fail(`eroe mancante: ${name}`);
const id = (name) => hero(name).id;
const names = (rows, k = rows.length) => rows.slice(0, k).map((r) => r.hero.name);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
const mapOf = (mode) => data.maps.find((m) => m.mode === mode);

test("senza selezioni: tutti gli eroi del ruolo, ordinati per win rate generale", () => {
  const rows = recommend(data, { role: "Support" });
  assert.equal(rows.length, data.heroes.filter((h) => h.role === "Support").length);
  assert.ok(rows.every((r) => r.hero.role === "Support"));
  for (const r of rows) close(r.parts.base, data.overall[String(r.hero.id)] - 0.5, r.hero.name);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].score >= rows[i].score);
});

test("il punteggio è la somma delle parti e la stima esclude il bonus preferiti", () => {
  const rows = recommend(data, {
    role: "Damage", mapSlug: "kings-row", side: "attack",
    enemies: [id("Pharah"), id("Winston")], allies: [id("Ana")], favorites: [id("Tracer")],
  });
  for (const r of rows) {
    const p = r.parts;
    close(r.score, p.base + p.contro + p.con + p.lato + p.pref, r.hero.name);
    close(r.estimate, 0.5 + r.score - p.pref, r.hero.name);
  }
});

test("mappa: la base è il win rate su quella mappa", () => {
  const map = data.maps.find((m) => m.slug === "kings-row");
  const rows = recommend(data, { role: "Tank", mapSlug: "kings-row" });
  for (const r of rows) close(r.parts.base, map.winRates[String(r.hero.id)] - 0.5, r.hero.name);
  assert.equal(rows[0].baseLabel, "King's Row");
});

test("avversari: un counter forte sale in classifica", () => {
  // il Danni con il win rate più alto contro Pharah deve salire (o restare) quando Pharah è avversaria
  const dmg = data.heroes.filter((h) => h.role === "Damage");
  const best = dmg.reduce((a, b) => (data.counters[String(a.id)][String(id("Pharah"))] >
    data.counters[String(b.id)][String(id("Pharah"))] ? a : b));
  const before = names(recommend(data, { role: "Damage" })).indexOf(best.name);
  const after = names(recommend(data, { role: "Damage", enemies: [id("Pharah")] })).indexOf(best.name);
  assert.ok(after <= before, `${best.name}: ${before} → ${after}`);
  const row = recommend(data, { role: "Damage", enemies: [id("Pharah")] }).find((r) => r.hero.id === best.id);
  close(row.parts.contro, data.counters[String(best.id)][String(id("Pharah"))] - 0.5, "contro");
});

test("da 1 a 5 avversari: ognuno conta una volta", () => {
  const five = ["Reinhardt", "Tracer", "Genji", "Ana", "Lúcio"].map(id);
  for (let n = 1; n <= 5; n++) {
    const r = recommend(data, { role: "Support", enemies: five.slice(0, n) })[0];
    assert.equal(r.vs.length, n);
  }
});

test("alleati e ban: esclusi dai candidati; avversari invece ammessi (mirror)", () => {
  const rows = recommend(data, {
    role: "Support", allies: [id("Ana")], bans: [id("Kiriko"), id("Mercy")], enemies: [id("Lúcio")],
  });
  const n = names(rows);
  assert.ok(!n.includes("Ana") && !n.includes("Kiriko") && !n.includes("Mercy"));
  assert.ok(n.includes("Lúcio"));
});

test("alleati: sinergia a metà peso, cercata nelle due direzioni", () => {
  const rows = recommend(data, { role: "Damage", allies: [id("Mercy")] });
  for (const r of rows) {
    const v = pairValue(data.synergies, r.hero.id, id("Mercy"));
    close(r.parts.con, v === null ? 0 : (v - 0.5) * SYNERGY_WEIGHT, r.hero.name);
  }
});

test("preferiti: piccolo bonus, mostrato tra i motivi", () => {
  const plain = recommend(data, { role: "Tank" });
  const last = plain[plain.length - 1].hero;
  const fav = recommend(data, { role: "Tank", favorites: [last.id] }).find((r) => r.hero.id === last.id);
  close(fav.score, plain[plain.length - 1].score + FAVORITE_BONUS, "bonus");
  assert.equal(reasons(fav)[0].text, "★ preferito");
});

test("attacco/difesa: solo su Escort e Hybrid, regola piccola sullo stile", () => {
  assert.ok(hasSides(mapOf("Escort")) && hasSides(mapOf("Hybrid")));
  assert.ok(!hasSides(mapOf("Control")) && !hasSides(mapOf("Push")) && !hasSides(mapOf("Flashpoint")));
  assert.ok(sideBonus(hero("Widowmaker"), "defense") > 0);
  assert.ok(sideBonus(hero("Winston"), "defense") < 0);
  assert.ok(sideBonus(hero("Winston"), "attack") > 0);
  assert.ok(data.heroes.every((h) => Math.abs(sideBonus(h, "attack")) <= 0.005 + 1e-12));
  const control = recommend(data, { role: "Damage", mapSlug: mapOf("Control").slug, side: "defense" });
  assert.ok(control.every((r) => r.parts.lato === 0 && r.side === null));
  const escort = recommend(data, { role: "Damage", mapSlug: mapOf("Escort").slug, side: "defense" });
  assert.ok(escort.some((r) => r.parts.lato !== 0));
});

test("in due: eroi diversi anche con lo stesso ruolo, scelta in cima alle liste", () => {
  const { lists, pair } = recommendDuo(data, { players: [{ role: "Damage" }, { role: "Damage" }] });
  assert.notEqual(pair.a.id, pair.b.id);
  assert.equal(lists[0][0].hero.id, pair.a.id);
  assert.equal(lists[1][0].hero.id, pair.b.id);
  assert.ok(!names(lists[0]).includes(pair.b.name), "l'eroe dell'altro non è tra le alternative");
  assert.ok(!names(lists[1]).includes(pair.a.name));
});

test("in due: la coppia scelta è la migliore tra tutte (sinergia tra i due compresa)", () => {
  const ctx = { mapSlug: "kings-row", enemies: [id("Pharah"), id("Reinhardt")], bans: [id("Ana")] };
  const players = [{ role: "Damage", favorites: [id("Tracer")] }, { role: "Support", favorites: [id("Mercy")] }];
  const { pair } = recommendDuo(data, { ...ctx, players });
  const [r0, r1] = players.map((p) => recommend(data, { ...ctx, ...p }));
  const total = (a, b) => {
    const s = pairValue(data.synergies, a.hero.id, b.hero.id);
    return a.score + b.score + (s === null ? 0 : (s - 0.5) * SYNERGY_WEIGHT);
  };
  const chosen = total(r0.find((r) => r.hero.id === pair.a.id), r1.find((r) => r.hero.id === pair.b.id));
  for (const a of r0) for (const b of r1) assert.ok(total(a, b) <= chosen + 1e-12, `${a.hero.name}+${b.hero.name}`);
  assert.ok(pair.a.id !== id("Ana") && pair.b.id !== id("Ana"), "ban rispettato");
});

test("motivi: al massimo 3 (+ preferito), il peggiore in rosso", () => {
  const rows = recommend(data, { role: "Tank", enemies: ["Reaper", "Mei", "Ana", "Zenyatta", "Sombra"].map(id) });
  for (const r of rows) {
    const rs = reasons(r);
    assert.ok(rs.length <= 3);
    const worst = Math.min(...r.vs.map((v) => v.delta));
    if (worst <= -0.01) assert.ok(rs.some((x) => !x.good), `${r.hero.name}: manca il matchup peggiore`);
  }
});

test("dati senza mappa o con eroe sconosciuto: nessun errore", () => {
  const rows = recommend(data, { role: "Tank", mapSlug: "non-esiste", enemies: ["999999"] });
  assert.ok(rows.length > 0 && rows.every((r) => r.vs.length === 0 && Number.isFinite(r.score)));
  assert.deepEqual(recommendDuo(data, { players: [] }).lists, []);
});

test("solo preferiti: si consiglia solo tra i preferiti, a entrambi", () => {
  const favA = ["Genji", "Tracer", "Sojourn", "Ana"].map(id); // Ana non è Danni: ignorata per il ruolo
  const favB = ["Mercy", "Juno"].map(id);
  const { lists, notes } = recommendDuo(data, {
    mapSlug: "kings-row", enemies: [id("Pharah")],
    players: [{ role: "Damage", favorites: favA, onlyFavorites: true }, { role: "Support", favorites: favB, onlyFavorites: true }],
  });
  assert.deepEqual(names(lists[0]).sort(), ["Genji", "Sojourn", "Tracer"]);
  assert.deepEqual(names(lists[1]).sort(), ["Juno", "Mercy"]);
  assert.deepEqual(notes, [null, null]);
});

test("solo preferiti: nessun preferito utilizzabile → tutti gli eroi, con avviso", () => {
  const { lists, notes } = recommendDuo(data, {
    bans: [id("Mercy")],
    players: [{ role: "Tank", favorites: [id("Mercy")], onlyFavorites: true }, { role: "Support", favorites: [id("Mercy")], onlyFavorites: true }],
  });
  assert.ok(lists[0].length > 5 && lists[1].length > 5 && notes[0] && notes[1]);
  assert.ok(!names(lists[1]).includes("Mercy"), "il ban vale sempre");
});

test("solo preferiti: stesso ruolo e un solo preferito → il secondo sceglie tra tutti", () => {
  const p = { role: "Support", favorites: [id("Ana")], onlyFavorites: true };
  const { lists, pair, notes } = recommendDuo(data, { players: [p, p] });
  assert.equal(pair.a.name, "Ana");
  assert.notEqual(pair.b.name, "Ana");
  assert.equal(lists[0].length, 1);
  assert.ok(notes[1] && !notes[0]);
});

test("perché: riepilogo mappa/avversari/alleati coerente con le parti", () => {
  const r = recommend(data, { role: "Damage", mapSlug: "kings-row", enemies: [id("Pharah"), id("Winston")], allies: [id("Ana")] })[0];
  const b = breakdown(r);
  assert.deepEqual(b.map((x) => x.key), ["map", "enemies", "allies"]);
  close(b[1].delta, r.parts.contro, "avversari");
  assert.match(b[0].text, /^Mappa [+−]\d+\.\d%$/);
  const plain = breakdown(recommend(data, { role: "Tank" })[0]);
  assert.deepEqual(plain.map((x) => x.text.split(" ")[0]), ["Generale"]);
  const d = details(r);
  assert.ok(d.some((x) => x.text.startsWith("contro Pharah")) && d.some((x) => x.text.startsWith("contro Winston")) && d.some((x) => x.text.startsWith("con Ana")));
});

test("divisione: i dati del giocatore sostituiscono quelli generali, il resto resta", () => {
  const h = String(id("Genji")), o = String(id("Pharah"));
  const div = { division: "gold", counters: { [h]: { [o]: 0.6 } }, overall: { [h]: 0.55 }, maps: { "kings-row": { [h]: 0.58 } } };
  const d2 = withDivision(data, div);
  assert.equal(d2.counters[h][o], 0.6);
  assert.equal(d2.maps.find((m) => m.slug === "kings-row").winRates[h], 0.58);
  assert.equal(d2.maps.find((m) => m.slug === "ilios").winRates[h], data.maps.find((m) => m.slug === "ilios").winRates[h]);
  assert.equal(d2.synergies, data.synergies);
  assert.equal(withDivision(data, null), data);
  // in due: ognuno con i suoi dati
  const { lists } = recommendDuo(data, {
    enemies: [id("Pharah")],
    players: [{ role: "Damage", data: d2 }, { role: "Support" }],
  });
  const genji = lists[0].find((r) => r.hero.name === "Genji");
  close(genji.parts.contro, 0.1, "Genji usa i counter della divisione");
});

test("scheda eroe: forte contro, debole contro, mappe migliori, coppie migliori", () => {
  const prof = heroProfile(data, id("Genji"));
  const g = String(id("Genji"));
  assert.equal(prof.hero.name, "Genji");
  for (const k of ["strongVs", "weakVs", "bestMaps", "bestWith"]) assert.ok(prof[k].length > 0 && prof[k].length <= 5, k);
  assert.ok(prof.strongVs.every((x) => x.delta > 0) && prof.weakVs.every((x) => x.delta < 0));
  for (let i = 1; i < prof.strongVs.length; i++) assert.ok(prof.strongVs[i - 1].delta >= prof.strongVs[i].delta);
  const best = Math.max(...Object.entries(data.counters[g]).map(([, v]) => v)) - 0.5;
  close(prof.strongVs[0].delta, best, "il migliore è davvero il migliore");
  assert.ok(prof.bestMaps.every((x) => x.subject.slug) && prof.bestWith.every((x) => x.subject.name !== "Genji"));
});

test("perché: la sinergia col compagno è mostrata a parte, non come «Alleati»", () => {
  const { lists, pair } = recommendDuo(data, { players: [{ role: "Damage" }, { role: "Support" }] });
  const b = breakdown(lists[0][0], { id: pair.b.id, name: "Lei" });
  assert.ok(!b.some((x) => x.key === "allies"), "nessun alleato segnato");
  assert.ok(b.some((x) => x.key === "partner" && x.text.startsWith("Con Lei")));
  const b2 = breakdown(recommend(data, { role: "Damage", allies: [id("Ana"), pair.b.id] })[0], { id: pair.b.id, name: "Lei" });
  assert.ok(b2.some((x) => x.key === "allies") && b2.some((x) => x.key === "partner"));
});

// ---------- squadra da 1 a 5 giocatori, eroi già presi ----------

const ROLE_QUEUE = ["Tank", "Damage", "Damage", "Support", "Support"];
const distinct = (heroes) => new Set(heroes.map((h) => String(h.id))).size === heroes.length;

for (const n of [1, 2, 3, 4, 5]) {
  test(`squadra di ${n}: un eroe a testa, tutti diversi, del ruolo di ciascuno`, () => {
    const players = ROLE_QUEUE.slice(0, n).map((role) => ({ role }));
    const ctx = { mapSlug: "kings-row", enemies: [id("Pharah"), id("Mercy")], bans: [id("Ana")] };
    const { lists, team, picked } = recommendTeam(data, { ...ctx, players });
    assert.equal(lists.length, n);
    assert.equal(team.length, n);
    assert.ok(team.every(Boolean), "ognuno ha un eroe");
    assert.ok(distinct(team), "eroi diversi");
    team.forEach((h, i) => {
      assert.equal(h.role, players[i].role);
      assert.equal(lists[i][0].hero.id, h.id, "la scelta è in cima alla lista");
      assert.notEqual(h.id, id("Ana"), "ban rispettato");
    });
    assert.deepEqual(picked, players.map(() => false));
    // ogni lista conta gli eroi degli altri come alleati
    team.forEach((h, i) => {
      const mates = team.filter((_, j) => j !== i).map((x) => String(x.id));
      assert.ok(lists[i].every((r) => !mates.includes(String(r.hero.id))), "gli eroi degli altri non sono tra le alternative");
    });
  });
}

test("squadra: la combinazione scelta è la migliore (controllo completo con 3 giocatori)", () => {
  const players = [{ role: "Tank" }, { role: "Support" }, { role: "Support" }];
  const ctx = { mapSlug: "ilios", enemies: [id("Genji"), id("Winston")] };
  const { team } = recommendTeam(data, { ...ctx, players });
  const syn = (a, b) => { const v = pairValue(data.synergies, a.hero.id, b.hero.id); return v === null ? 0 : (v - 0.5) * SYNERGY_WEIGHT; };
  const [r0, r1, r2] = players.map((p) => recommend(data, { ...ctx, ...p }));
  let best = -Infinity, bestIds = null;
  for (const a of r0) for (const b of r1) for (const c of r2) {
    if (b.hero.id === c.hero.id) continue;
    const t = a.score + b.score + c.score + syn(a, b) + syn(a, c) + syn(b, c);
    if (t > best) { best = t; bestIds = [a, b, c].map((r) => r.hero.id); }
  }
  assert.deepEqual(team.map((h) => h.id), bestIds);
});

test("eroe già preso: resta fisso, in cima con picked, e conta come alleato per gli altri", () => {
  const players = [{ role: "Damage" }, { role: "Support", picked: id("Mercy") }, { role: "Support" }];
  const { lists, team, picked } = recommendTeam(data, { enemies: [id("Pharah")], players });
  assert.deepEqual(picked, [false, true, false]);
  assert.equal(team[1].name, "Mercy");
  assert.equal(lists[1][0].hero.name, "Mercy");
  assert.equal(lists[1][0].picked, true);
  assert.ok(lists[1].slice(1).every((r) => r.hero.role === "Support" && !r.picked), "alternative dello stesso ruolo");
  assert.ok(lists[2].every((r) => r.hero.name !== "Mercy"), "nessuno riceve l'eroe già preso");
  assert.ok(lists[0][0].withAllies.some((a) => a.hero.name === "Mercy"), "sinergia con l'eroe preso");
  // il ruolo dell'eroe preso vale anche se il giocatore aveva un altro ruolo
  const r = recommendTeam(data, { players: [{ role: "Tank", picked: id("Ana") }] });
  assert.equal(r.lists[0][0].hero.name, "Ana");
});

test("tutti hanno già preso: niente ricerca, liste con l'eroe preso in cima", () => {
  const names5 = ["Reinhardt", "Tracer", "Genji", "Ana", "Lúcio"];
  const players = names5.map((n) => ({ role: hero(n).role, picked: id(n) }));
  const { lists, team } = recommendTeam(data, { mapSlug: "kings-row", players });
  assert.deepEqual(team.map((h) => h.name), names5);
  lists.forEach((rows, i) => {
    assert.equal(rows[0].hero.name, names5[i]);
    assert.equal(rows[0].withAllies.length, 4, "gli altri 4 come alleati");
  });
});

test("perché con più compagni: «Con voi» somma la sinergia con gli altri giocatori", () => {
  const players = [{ role: "Tank" }, { role: "Damage" }, { role: "Support" }];
  const { lists, team } = recommendTeam(data, { players });
  const partners = [{ id: team[1].id, name: "B" }, { id: team[2].id, name: "C" }];
  const row = lists[0][0];
  const b = breakdown(row, partners);
  const g = b.find((x) => x.key === "partner");
  assert.equal(g.label, "Con voi");
  close(g.delta, row.withAllies.reduce((s, a) => s + a.delta, 0), "somma");
  assert.ok(!b.some((x) => x.key === "allies"));
  assert.equal(breakdown(row, [partners[0]]).find((x) => x.key === "partner").label, "Con B");
});

test("squadra di 5 senza ruolo: risposta rapida", () => {
  const t0 = Date.now();
  const { team } = recommendTeam(data, { players: [{}, {}, {}, {}, {}], enemies: [id("Pharah")] });
  assert.ok(distinct(team) && team.length === 5);
  assert.ok(Date.now() - t0 < 1500, `troppo lento: ${Date.now() - t0} ms`);
});

test("riquadro: «Batte» e «Teme» dagli scarti contro gli avversari (+ teoria), soglia 1%", () => {
  const enemies = ["Pharah", "Winston", "Genji", "Mercy"].map(id);
  for (const row of recommend(data, { role: "Damage", enemies }).slice(0, 10)) {
    const m = matchups(row);
    assert.ok(m.strong.every((x) => x.signal >= MATCHUP_MIN) && m.weak.every((x) => x.signal <= -MATCHUP_MIN));
    assert.ok(m.strong.length <= 3 && m.weak.length <= 3);
    const ids = new Set(enemies.map(String));
    assert.ok([...m.strong, ...m.weak].every((x) => ids.has(String(x.hero.id))), "solo avversari segnati");
    assert.ok(!m.strong.some((x) => m.weak.includes(x)));
  }
  // la teoria sposta il segnale: un counter noto entra in «Batte» anche con numeri vicini al 50%
  const row = { vs: [{ hero: hero("Pharah"), delta: 0.001 }], theory: { beats: [{ name: "Pharah" }], beatenBy: [] } };
  assert.equal(matchups(row).strong[0].hero.name, "Pharah");
  assert.deepEqual(matchups({ vs: [{ hero: hero("Pharah"), delta: 0.005 }] }), { strong: [], weak: [] });
});

test("riquadro prima degli avversari: un solo motivo in parole, senza numeri", () => {
  const rows = recommend(data, { role: "Tank", mapSlug: "kings-row" });
  const top = rows.find((r) => r.parts.base >= 0.01);
  assert.equal(headline(top), "Forte su King's Row");
  const gen = recommend(data, { role: "Support" }).find((r) => r.parts.base >= 0.01);
  if (gen) assert.equal(headline(gen), "Tra i più forti in generale");
  const weak = rows.find((r) => r.parts.base < 0.01 && !r.withAllies.length && !r.favorite);
  if (weak) assert.equal(headline(weak), null);
  for (const r of rows) { const h = headline(r); assert.ok(h === null || !/\d/.test(h), h); }
});

// Test della logica dei suggerimenti sui dati reali di app/data.json.  Uso: node --test tests/*.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  recommend, recommendDuo, reasons, sideBonus, hasSides, FAVORITE_BONUS, SYNERGY_WEIGHT, pairValue,
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

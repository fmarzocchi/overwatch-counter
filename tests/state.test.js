// Test dello stato salvato (app/state.js): profili e partite vecchi o rovinati, eroi che spariscono e ricompaiono.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeProfile, sanitizeMatch, parkMissing } from "../app/state.js";

const RANKS = ["", "Oro", "Diamante"];
const defaultProfile = () => ({ players: [
  { name: "Io", rank: "", roles: ["Damage"], favorites: [] }, { name: "Lei", rank: "", roles: ["Support"], favorites: [] }] });
const opts = { fallback: defaultProfile, ranks: RANKS, defaultName: (i) => (i ? "Lei" : "Io"), maxPlayers: 5 };
const emptyMatch = () => ({ roles: ["Damage", "Support"], picked: [null, null], mapSlug: null, side: null,
  bans: [], enemies: [], allies: [], started: false });

test("profilo: valori inutilizzabili → profilo predefinito", () => {
  for (const raw of [null, 5, "x", [], {}, { players: [] }, { players: "a" }]) assert.deepEqual(sanitizeProfile(raw, opts), defaultProfile());
});

test("profilo: campo per campo torna al predefinito, i dati buoni restano", () => {
  const p = sanitizeProfile({ onlyFavorites: true, players: [
    { name: "Fabio", rank: "Oro", role: "Tank" }, // versione vecchia: un solo ruolo, niente preferiti
    { name: "", rank: "Bho", roles: ["Support", "Mago", "Support"], favorites: ["3", 7, null, {}], nick: 5 },
    "rotto",
  ] }, opts);
  assert.equal(p.onlyFavorites, true);
  assert.deepEqual(p.players[0], { name: "Fabio", rank: "Oro", role: "Tank", roles: ["Tank"], favorites: [], nick: "" });
  assert.deepEqual(p.players[1], { name: "Lei", rank: "", roles: ["Support"], favorites: ["3", "7"], nick: "" });
  assert.equal(p.players[2].name, "Lei");
  assert.deepEqual(p.players[2].roles, [], "terzo giocatore senza ruoli predefiniti");
  assert.deepEqual(sanitizeProfile({ players: [{ name: "A" }] }, opts).players[0].roles, ["Damage"], "senza ruoli: quelli predefiniti");
  assert.equal(sanitizeProfile({ players: Array.from({ length: 8 }, () => ({ name: "x" })) }, opts).players.length, 5);
});

test("partita: valori inutilizzabili → partita nuova; campi mancanti o sbagliati → predefiniti", () => {
  for (const raw of [null, 3, "x", []]) assert.deepEqual(sanitizeMatch(raw, emptyMatch), emptyMatch());
  // partita salvata prima dei ban e delle scelte
  const m = sanitizeMatch({ mapSlug: "kings-row", enemies: [12, "7", null], allies: "Ana", side: "boh", role: "Damage" }, emptyMatch);
  assert.deepEqual(m.bans, []);
  assert.deepEqual(m.enemies, ["12", "7"]);
  assert.deepEqual(m.allies, []);
  assert.equal(m.mapSlug, "kings-row");
  assert.equal(m.side, null);
  assert.deepEqual(m.roles, ["Damage", "Support"]);
  assert.deepEqual(m.picked, [null, null]);
  const k = sanitizeMatch({ ...emptyMatch(), roles: ["Tank", 4], picked: [9, {}], away: [1, 0] }, emptyMatch);
  assert.deepEqual(k.roles, ["Tank", null]);
  assert.deepEqual(k.picked, ["9", null]);
  assert.deepEqual(k.away, [true, false]);
});

test("partita: «started» (Inizio partita fatto) — una partita salvata vecchia senza il campo è già iniziata", () => {
  assert.equal(sanitizeMatch(null, emptyMatch).started, false, "partita nuova: si apre l'Inizio partita");
  assert.equal(sanitizeMatch({ mapSlug: "kings-row", enemies: ["7"] }, emptyMatch).started, true, "salvata da una versione vecchia");
  assert.equal(sanitizeMatch({ ...emptyMatch(), started: false }, emptyMatch).started, false);
  assert.equal(sanitizeMatch({ ...emptyMatch(), started: true }, emptyMatch).started, true);
  assert.equal(sanitizeMatch({ ...emptyMatch(), started: "sì" }, emptyMatch).started, true, "valore rovinato: come una partita vecchia");
});

test("eroe sparito per un momento dai dati: esce dalla partita, non si perde, torna quando ricompare", () => {
  const match = { ...emptyMatch(), picked: ["1", "2"], bans: ["3", "4"], enemies: ["5", "6"], allies: ["7"], mapSlug: "nuova" };
  let heroes = new Set(["2", "4", "6"]); // mancano 1, 3, 5, 7 e la mappa
  let maps = new Set();
  const ctx = { known: (id) => heroes.has(id), knownMap: (s) => maps.has(s), limitOf: () => 5 };
  assert.equal(parkMissing(match, ctx), true);
  assert.deepEqual([match.picked, match.bans, match.enemies, match.allies, match.mapSlug], [[null, "2"], ["4"], ["6"], [], null]);
  assert.equal(parkMissing(match, ctx), false, "niente di nuovo");
  // nel frattempo il giocatore 0 sceglie un altro eroe: lo tiene
  match.picked[0] = "8";
  heroes = new Set(["1", "2", "3", "4", "5", "6", "7", "8"]);
  maps = new Set(["nuova"]);
  assert.equal(parkMissing(match, ctx), true);
  assert.deepEqual([match.picked, match.bans, match.enemies, match.allies, match.mapSlug], [["8", "2"], ["4", "3"], ["6", "5"], ["7"], "nuova"]);
  assert.deepEqual(match.missing, { bans: [], enemies: [], allies: [], picked: [], mapSlug: null });
  // un gruppo pieno nel frattempo: non si supera il limite
  const full = { ...emptyMatch(), enemies: ["1"] };
  parkMissing(full, { known: () => false, knownMap: () => true, limitOf: () => 5 });
  full.enemies = ["a", "b", "c", "d", "e"];
  parkMissing(full, { known: () => true, knownMap: () => true, limitOf: () => 5 });
  assert.deepEqual(full.enemies, ["a", "b", "c", "d", "e"]);
});

// Test del riconoscimento dalla foto (parte pura): richiesta, lettura della risposta, nomi, applicazione alla partita.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  photoRequest, photoHeaders, photoSchema, readPhotoResponse, normalizeResult, matchOwners, applyPhoto, photoError,
  isFallbackRejection, nameKey, PHOTO_MODEL, API_VERSION, FALLBACK_BETA, MAX_ALTS, MAX_BANS,
} from "../app/photo.js";

const data = JSON.parse(readFileSync(new URL("../app/data.json", import.meta.url)));
const hero = (n) => data.heroes.find((h) => h.name === n) ?? assert.fail(`eroe mancante: ${n}`);
const id = (n) => String(hero(n).id);
const reply = (obj, extra = {}) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn", usage: { input_tokens: 5000, output_tokens: 300 }, ...extra });
const slot = (nickname, heroName, sure = true, alternatives = [], role = null) => ({ nickname, role, hero: heroName, sure, alternatives });

test("richiesta: Sonnet 5.5 senza pensiero esteso, JSON vincolato agli eroi e alle mappe dei dati, versione API e CORS", () => {
  const body = photoRequest({ heroes: data.heroes, maps: data.maps, mapsIt: { Ilios: "Ilio" }, nicknames: ["Sephyrot", ""], photo: "PHOTO", sheet: "SHEET" });
  assert.equal(body.model, PHOTO_MODEL);
  assert.equal(PHOTO_MODEL, "claude-sonnet-5-5");
  assert.deepEqual(body.thinking, { type: "between_tools" });
  assert.equal(body.output_config.effort, "medium");
  assert.equal(body.output_config.format.type, "json_schema");
  const schema = body.output_config.format.schema;
  const heroEnum = schema.properties.allies.items.properties.hero.anyOf[0].enum;
  assert.deepEqual(heroEnum, data.heroes.map((h) => h.name));
  assert.deepEqual(schema.properties.map.anyOf[0].enum, data.maps.map((m) => m.name));
  assert.equal(body.fallbacks, "default");
  assert.ok(!("temperature" in body) && !("top_p" in body) && !("top_k" in body), "niente parametri di campionamento (API 2026-10-21)");
  // ordine: foglio di riferimento (in cache) → foto → nomi dei giocatori; la foto è un'immagine JPEG in base64
  const c = body.messages[0].content;
  const images = c.filter((b) => b.type === "image");
  assert.equal(images.length, 2);
  assert.equal(images[0].source.data, "SHEET");
  assert.deepEqual(images[0].cache_control, { type: "ephemeral" });
  assert.equal(images[1].source.data, "PHOTO");
  assert.equal(images[1].source.media_type, "image/jpeg");
  assert.match(c[c.length - 1].text, /Sephyrot/);
  assert.ok(!/Sephyrot/.test(body.system[0].text), "i nomi non stanno nelle istruzioni fisse (cache)");
  assert.match(body.system[0].text, /Ilios \(Control; in Italian: Ilio\)/);
  assert.match(body.system[0].text, /Mizuki \(Support\)/);
  assert.match(body.system[0].text, /Bans: .*top right, right under the map header/, "dove sono i ban nel tabellone");
  // eroi morti (ritratto grigio): sono in partita, vanno riconosciuti; null solo per il "?" di chi non ha scelto
  assert.match(body.system[0].text, /DEAD player's portrait is shown greyed out/);
  assert.match(body.system[0].text, /Never return null for a greyed portrait/);
  assert.match(body.system[0].text, /hero null ONLY when the portrait slot shows the generic placeholder silhouette/);
  assert.match(body.system[0].text, /kill feed/, "il kill feed aiuta a riconoscere i morti e non è un ban");
  assert.ok(schema.properties.allies.items.required.includes("dead"));
  assert.deepEqual(schema.properties.bans.items.properties.hero.anyOf[0].enum, heroEnum, "ban vincolati agli eroi dei dati");
  assert.ok(schema.required.includes("bans"));
  // senza foglio: solo la foto
  assert.equal(photoRequest({ heroes: data.heroes, maps: data.maps, photo: "P" }).messages[0].content.filter((b) => b.type === "image").length, 1);
  // senza fallback: niente parametro né beta
  const nf = photoRequest({ heroes: data.heroes, maps: data.maps, photo: "P", fallback: false });
  assert.ok(!("fallbacks" in nf));
  const h = photoHeaders("sk-ant-x");
  assert.equal(h["x-api-key"], "sk-ant-x");
  assert.equal(h["anthropic-version"], API_VERSION);
  assert.equal(API_VERSION, "2026-10-21");
  assert.equal(h["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(h["anthropic-beta"], FALLBACK_BETA);
  assert.ok(!("anthropic-beta" in photoHeaders("k", { fallback: false })));
});

test("schema: ogni oggetto chiude le proprietà (vincolo delle risposte strutturate), nessun vincolo non supportato", () => {
  const s = photoSchema(["Ana"], ["Ilios"]);
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (o.type === "object") assert.equal(o.additionalProperties, false);
    for (const k of ["minimum", "maximum", "minLength", "maxLength", "maxItems", "minItems"]) assert.ok(!(k in o), k);
    Object.values(o).forEach(walk);
  };
  walk(s);
});

test("risposta: eroi e mappa dei dati, al massimo 5 per squadra, alternative valide (max 3), dubbi segnati", () => {
  const raw = {
    scoreboard: true, map: "Paraíso", side: "attack",
    allies: [slot("FRABLE", "Orisa"), slot("FRMBOYOO", "Ashe"), slot("SQUEAKYLEMON", "Emre", false, ["Emre", "Cassidy", "Reaper", "Soldier: 76", "Inventato"]),
      slot("SEPHYROT", "Mizuki"), slot("FOCALFORTUNE", "Doctrine", false, ["Illari"]), slot("SESTO", "Ana")],
    enemies: [slot("BREZELCHEN", "D.Va"), slot("LEMONTANK", "Widowmaker"), slot("WHISKERS", "Junkrat"), slot("CHUU!", null, true), slot("DONI", "Ana", false, ["Kiriko"])],
  };
  const { result } = readPhotoResponse(reply(raw), data);
  assert.equal(result.mapSlug, data.maps.find((m) => m.name === "Paraíso").slug);
  assert.equal(result.side, "attack");
  assert.equal(result.ours.length, 5, "al massimo 5");
  assert.equal(result.ours[0].heroId, id("Orisa"));
  const emre = result.ours[2];
  assert.equal(emre.sure, false);
  assert.ok(emre.alts.length <= MAX_ALTS && !emre.alts.includes(emre.heroId) && emre.alts.every((a) => data.heroes.some((h) => String(h.id) === a)));
  assert.deepEqual(emre.alts, [id("Cassidy"), id("Reaper"), id("Soldier: 76")]);
  assert.equal(result.enemies[3].heroId, null, "«?» = non ancora scelto");
  assert.equal(result.enemies[4].sure, false);
  assert.deepEqual(result.enemies[4].alts, [id("Kiriko")]);
});

test("ban: dal tabellone in alto a destra, al massimo 4, doppioni via, incerti con alternative; partita rapida = nessuno", () => {
  const ban = (h, sure = true, alternatives = []) => ({ hero: h, sure, alternatives });
  const raw = { scoreboard: true, map: null, side: null, allies: [], enemies: [],
    bans: [ban("Sombra"), ban("Widowmaker"), ban("Widowmaker"), ban("Brigitte", false, ["Baptiste", "Inventato", "Brigitte"]), ban(null, false, ["Hanzo"]), ban("Tracer")] };
  const r = normalizeResult(raw, data);
  assert.equal(r.bans.length, MAX_BANS);
  assert.deepEqual(r.bans.map((b) => b.heroId), [id("Sombra"), id("Widowmaker"), id("Brigitte"), null]);
  assert.equal(r.bans[2].sure, false);
  assert.deepEqual(r.bans[2].alts, [id("Baptiste")]);
  assert.deepEqual(r.bans[3].alts, [id("Hanzo")], "ritratto illeggibile ma con un'ipotesi: si propone");
  assert.equal(r.bans[3].sure, false);
  assert.deepEqual(normalizeResult({ ...raw, bans: [ban(null, true)] }, data).bans, [], "illeggibile senza ipotesi: niente");
  assert.deepEqual(normalizeResult({ ...raw, bans: undefined }, data).bans, [], "risposta senza ban: nessuno");
});

test("morti: ritratto grigio → in partita; senza eroe riconosciuto è da controllare, mai «non ancora scelto»", () => {
  const raw = { scoreboard: true, map: null, side: null, bans: [], allies: [],
    enemies: [{ ...slot("FLOOPY", null, true, ["Zenyatta", "Mercy"], "Support"), dead: true },
      { ...slot("DONI", "Ana", false, ["Kiriko"], "Support"), dead: true }, { ...slot("CHUU", null, true), dead: false }] };
  const r = normalizeResult(raw, data);
  assert.equal(r.enemies[0].dead, true);
  assert.equal(r.enemies[0].heroId, null);
  assert.equal(r.enemies[0].sure, false, "morto senza eroe: da controllare (con le alternative)");
  assert.deepEqual(r.enemies[0].alts, [id("Zenyatta"), id("Mercy")]);
  assert.equal(r.enemies[1].heroId, id("Ana"));
  assert.equal(r.enemies[1].dead, true);
  assert.equal(r.enemies[2].sure, true, "il «?» di chi non ha scelto resta certo");
  assert.equal(r.enemies[2].dead, false);
});

test("risposta: ruolo che non torna, eroe doppio o nome sconosciuto → da controllare; mappa assente → nessuna", () => {
  const raw = { scoreboard: true, map: null, side: "boh",
    allies: [slot("A", "Ana", true, [], "Tank"), slot("B", "Mercy"), slot("C", "Mercy"), slot("D", "Nessuno")], enemies: [] };
  const r = normalizeResult(raw, data);
  assert.equal(r.mapSlug, null);
  assert.equal(r.side, null);
  assert.equal(r.ours[0].sure, false, "icona Tank ma ritratto di Ana");
  assert.equal(r.ours[1].sure, true);
  assert.equal(r.ours[2].sure, false, "Mercy due volte");
  assert.equal(r.ours[3].heroId, null);
  assert.equal(r.ours[3].sure, false);
});

test("risposta: rifiuto, troncata o non JSON → messaggio chiaro, niente eccezioni", () => {
  assert.match(readPhotoResponse({ content: [], stop_reason: "refusal" }, data).error, /non ha voluto/);
  assert.match(readPhotoResponse({ content: [{ type: "text", text: "{" }], stop_reason: "max_tokens" }, data).error, /incompleta/);
  assert.match(readPhotoResponse({ content: [{ type: "text", text: "ciao" }], stop_reason: "end_turn" }, data).error, /non leggibile/);
  assert.match(readPhotoResponse(null, data).error, /non leggibile/);
  // blocchi "thinking" (vuoti) prima del testo: si legge solo il testo
  const ok = readPhotoResponse({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify({ scoreboard: false, map: null, side: null, allies: [], enemies: [] }) }], stop_reason: "end_turn" }, data);
  assert.equal(ok.result.scoreboard, false);
});

test("nomi nel gioco: uguali o quasi (O/0, una lettera), ogni giocatore una riga sola, gli altri alleati", () => {
  const rows = ["FRABLE", "FRMBOYOO", "SQUEAKYLEMON", "SEPHYR0T", "FOCALFORTUNE"].map((nickname) => ({ nickname }));
  assert.deepEqual(matchOwners(rows, ["Sephyrot", "focal fortune"]), [-1, -1, -1, 0, 1]);
  assert.deepEqual(matchOwners(rows, ["", "Nessuno"]), [-1, -1, -1, -1, -1]);
  assert.deepEqual(matchOwners([{ nickname: "ABC" }, { nickname: "ABD" }], ["ABC"]), [0, -1], "il più simile vince");
  assert.deepEqual(matchOwners([{ nickname: "FRABLE" }], ["FRABLE", "FRABLE"]), [0], "una riga a un solo giocatore");
  assert.equal(nameKey("Lúcio #1"), "lucio1");
});

test("conferma: mappa e lato, eroi presi dai giocatori, alleati fino al limite, avversari, mirror, ban liberati", () => {
  const match = { roles: ["Damage", "Support"], picked: [null, id("Ana")], pickFor: 0, mapSlug: "kings-row", side: "defense",
    bans: [id("Orisa"), id("Tracer"), id("Junkrat")], enemies: [id("Genji")], allies: [id("Lúcio")], group: "enemies" };
  const state = {
    mapSlug: "paraiso", side: "attack", sides: true,
    ours: [{ heroId: id("Orisa"), owner: -1 }, { heroId: id("Ashe"), owner: -1 }, { heroId: id("Cassidy"), owner: 0 },
      { heroId: id("Mizuki"), owner: 1 }, { heroId: id("Illari"), owner: -1 }],
    enemies: [{ heroId: id("D.Va") }, { heroId: id("Widowmaker") }, { heroId: id("Junkrat") }, { heroId: null }, { heroId: id("Cassidy") }],
  };
  const { match: m, dropped } = applyPhoto(match, state, { players: 2 });
  assert.equal(m.mapSlug, "paraiso");
  assert.equal(m.side, "attack");
  assert.deepEqual(m.picked, [id("Cassidy"), id("Mizuki")]);
  assert.deepEqual(m.allies, [id("Orisa"), id("Ashe"), id("Illari")]);
  assert.deepEqual(dropped, []);
  assert.deepEqual(m.enemies, [id("D.Va"), id("Widowmaker"), id("Junkrat"), id("Cassidy")], "Cassidy anche avversaria (mirror)");
  assert.deepEqual(m.bans, [id("Tracer")], "Orisa e Junkrat sono in campo: non più bannati");
  // ban letti dal tabellone: diventano i ban della partita (mai un eroe in campo); nessuno letto → restano quelli di prima
  const rb = applyPhoto(match, { ...state, bans: [{ heroId: id("Sombra") }, { heroId: null }, { heroId: id("Widowmaker") }, { heroId: id("Sombra") }, { heroId: id("Hanzo") }] },
    { players: 2 }).match;
  assert.deepEqual(rb.bans, [id("Sombra"), id("Hanzo")], "Widowmaker è avversaria nella foto: non bannata; Sombra una volta");
  assert.deepEqual(applyPhoto(match, { ...state, bans: [] }, { players: 2 }).match.bans, [id("Tracer")]);
  assert.equal(match.mapSlug, "kings-row", "la partita di partenza non cambia (si può annullare)");
  // senza mappa riconosciuta né scelta: si conferma lo stesso; mappa senza lati → niente lato
  const r2 = applyPhoto(match, { ...state, mapSlug: null, side: "attack", sides: false }, { players: 2 }).match;
  assert.equal(r2.mapSlug, null);
  assert.equal(r2.side, null);
  // alleati oltre il limite (5 − giocatori): scartati e segnalati
  const r3 = applyPhoto(match, { ...state, ours: state.ours.map((r) => ({ ...r, owner: -1 })) }, { players: 2 });
  assert.equal(r3.match.allies.length, 3);
  assert.equal(r3.dropped.length, 2);
  assert.deepEqual(r3.match.picked, [null, id("Ana")], "giocatori non riconosciuti: scelta di prima");
  assert.deepEqual(r3.match.away, [false, false], "nessuno di voi nella foto: chi gioca resta com'era");
});

test("chi gioca lo dice la foto: chi non c'è esce (niente riquadro), le altre righe sono alleati; chi ricompare rientra", () => {
  const match = { roles: ["Damage", "Support"], picked: [null, id("Ana")], pickFor: 1, mapSlug: null, side: null,
    bans: [], enemies: [], allies: [], group: "enemies" };
  const ours = [{ heroId: id("Orisa"), owner: -1 }, { heroId: id("Cassidy"), owner: 0 }, { heroId: id("Ana"), owner: -1 },
    { heroId: id("Mizuki"), owner: -1 }, { heroId: id("Illari"), owner: -1 }];
  const state = { mapSlug: null, side: null, sides: false, ours, enemies: [], bans: [] };
  const r = applyPhoto(match, state, { players: 2 });
  assert.deepEqual(r.match.away, [false, true], "Misaki (giocatore 2) non è nella foto");
  assert.deepEqual(r.match.picked, [id("Cassidy"), null], "chi non gioca non ha un eroe preso");
  assert.deepEqual(r.match.allies, [id("Orisa"), id("Ana"), id("Mizuki"), id("Illari")], "4 alleati: siete in 1");
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.gone, [1]);
  assert.equal(r.match.pickFor, 0, "chi segna la scelta passa a chi gioca");
  // foto dopo: c'è di nuovo → rientra
  const r2 = applyPhoto(r.match, { ...state, ours: ours.map((x, k) => (k === 2 ? { ...x, owner: 1 } : x)) }, { players: 2 });
  assert.deepEqual(r2.match.away, [false, false]);
  assert.deepEqual(r2.back, [1]);
  assert.deepEqual(r2.match.picked, [id("Cassidy"), id("Ana")]);
  assert.equal(r2.match.allies.length, 3);
  // nessuno di voi trovato: chi gioca resta com'era (qui: solo il giocatore 1)
  const r3 = applyPhoto(r.match, { ...state, ours: ours.map((x) => ({ ...x, owner: -1 })) }, { players: 2 });
  assert.deepEqual(r3.match.away, [false, true]);
  assert.equal(r3.match.allies.length, 4);
  assert.equal(r3.dropped.length, 1);
});

test("errori dell'API → frasi chiare; fallback rifiutato riconosciuto", () => {
  assert.match(photoError(401, { error: { message: "invalid x-api-key" } }), /chiave API non è valida/);
  assert.match(photoError(400, { error: { message: "Your credit balance is too low" } }), /Crediti API esauriti/);
  assert.match(photoError(429, {}), /Troppe richieste/);
  assert.match(photoError(529, {}), /sovraccarico/);
  assert.match(photoError(0, null), /Nessuna connessione/);
  assert.ok(isFallbackRejection(400, { error: { message: "fallbacks: unknown parameter" } }));
  assert.ok(!isFallbackRejection(400, { error: { message: "max_tokens too large" } }));
  assert.ok(!isFallbackRejection(401, { error: { message: "fallback" } }));
});

# Overwatch Counter — istruzioni per Claude

Leggi tutto prima di iniziare. Parla con l'utente in **italiano**.

## L'obiettivo

App per telefono Android che, durante una partita di **Overwatch 2 su Nintendo Switch 2**, suggerisce
quale eroe prendere in base a **mappa**, **squadra avversaria** e (facoltativo) **la propria squadra**.
I dati vengono da **counterwatch.gg**.

Requisiti dell'utente, in ordine di importanza:
1. **Pochissimi tocchi, velocissimi**: le selezioni si fanno mentre si gioca.
2. **Dati sempre freschi**: quando apre l'app deve trovare gli ultimi dati di counterwatch.
   Aggiornamento automatico **ogni 3 ore** + pulsante **"aggiorna ora"** nell'app.
3. **Resistente ai cambiamenti del sito**: se counterwatch cambia, l'app deve continuare a funzionare
   con gli ultimi dati buoni e dirlo chiaramente.
4. Prima una **PWA**, poi un **guscio APK** (TWA o WebView) **compilato e testato su GitHub Actions**
   con l'emulatore Android. Niente app nativa riscritta da zero.

L'utente ha budget limitato: lavora in modo mirato, niente esplorazioni inutili.
Su Switch 2 l'overlay PC di Counterwatch non esiste: per questo serve l'inserimento manuale.

## Stato al 2026-10-05 (sera)

Repository: **github.com/fmarzocchi/overwatch-counter** (pubblico). Sito: https://fmarzocchi.github.io/overwatch-counter/

FATTO e collaudato in locale:
- `tools/fetch_data.py` — scraper (Python 3 standard). Codici di uscita: 0 ok, 2 parziale, 1 niente salvato.
  Opzioni: `--out`, `--prev`, `--from-dir`. **Solo Ranked** dal database del sito (vedi "Dati Ranked").
- `tests/test_fetch.py` — 18 test verdi. Pagine salvate in `tests/fixtures.tar.gz`, dati Ranked in `tests/fixtures_rest.tar.gz`.
- `app/recommend.js` — `recommend()` per un giocatore e `recommendDuo()` per la coppia; ban, preferiti,
  attacco/difesa. `tests/recommend.test.js`: 13 test verdi (`node --test tests/*.test.js`).
- PWA in `app/` (index.html, style.css, app.js, sw.js, manifest, icone generate da `tools/make_icons.py`).
- `tests/e2e.mjs` — Playwright, 390×844: 34 controlli verdi (flusso completo, offline, dati vecchi/rotti,
  "Aggiorna dati" con GitHub simulato). Screenshot in `tests/screenshots/` (non versionati), guardati.
- `tools/fetch_icons.py` — copia le icone eroi in `app/heroes/` durante il workflow (non versionate).
- `.github/workflows/update-data.yml` (dati ogni 3 h + Pages + keepalive del cron) e `ci.yml` (tutti i test + screenshot).

VERIFICATO su GitHub (2026-10-05): Pages attivo (Source: GitHub Actions), sito online, `update-data.yml`
verde, icone 53/53, CI verde.

NON FATTO, deciso con l'utente: **perk (vantaggi) degli eroi** — counterwatch non ha dati sui perk (nessuna
pagina nella sitemap, nessuna menzione nella pagina eroe; diagnosi `tools/discover_perks.py`). L'utente ha
detto di lasciar perdere se troppo difficile. Servirebbe un'altra fonte di statistiche sui perk.

APK (FATTO, 2026-10-05): guscio **WebView** in Java (`android/`, nessuna dipendenza) che apre il sito di Pages:
grafica/logica/dati si aggiornano dal sito, una nuova APK serve solo se cambia il guscio. Firmato con
`android/debug.keystore` versionata (stessa firma → gli aggiornamenti si installano sopra). `android.yml` compila,
prova sull'emulatore API 30 (`android/test-on-emulator.sh`: fallisce se l'app si chiude o se nel log ci sono
"Uncaught" JS), pubblica l'APK nel ramo `apk` e screenshot/log nel ramo `apk-test`; gira anche dopo ogni
pubblicazione del sito dovuta a un push (workflow_run). Lezione: la WebView di API 30 è Chrome 83 →
niente ES2021 (`??=`) né API recenti; `ci.yml` controlla la sintassi con `es-check es2020`, `replaceChildren`
ha un sostituto in `app.js`.

DA FARE:
1. (nulla di aperto)
2.
3. Scheda eroe (tocco su un consiglio): perché in questa partita + "Forte contro", "In difficoltà contro",
   "Mappe migliori", "Funziona bene con" (`heroProfile()`), sui dati della divisione del giocatore. FATTO.

## Dati Ranked (risolto il 2026-10-05, con l'ok dell'utente)

L'utente vuole **solo Ranked 5v5** (niente Stadium/arena). Le pagine del sito hanno solo "tutte le partite"
(il parametro URL `type=Ranked` viene ignorato dal server). I dati Ranked il sito li legge nel browser dal suo
database **Supabase** (sola lettura, chiave pubblica). `fetch_data.py` fa lo stesso:
- a ogni giro legge **indirizzo e chiave dal JS del sito** (`extract_supabase()`; mai scritti nel codice o nei
  dati; prova le chiavi trovate finché una risponde: nel JS c'è anche quella di sviluppo);
- scarica `community_stats_counters_current`, `…_synergies_current`, `…_current` (eroe×mappa) con
  `game=eq.Overwatch&stat_category=eq.5V5&game_type=eq.Ranked&division=eq.All` (~7 richieste, pagine da 1000);
- applica la correzione del sito: `(win_rate*partite + 200)/(partite + 400)` (trovata nel JS, verificata sui dati);
- mappe: nomi del database ↔ elenco mappe con `map_key()` (accenti tolti); una mappa assente → pagina del
  sito (tutte le partite), annotata in `filter.mapsAll`; con Ranked non si scaricano le 30 pagine mappa.
- Se il database non risponde o i dati sono incompleti: tutte le partite (`filter.gameType = "All"`,
  `filter.why`); se prima era Ranked → `problems` (uscita 2, mail).
- Test offline: `tests/fixtures_rest.tar.gz` (copia reale Ranked). Diagnosi manuale: workflow "Diagnosi
  counterwatch" (`tools/discover_ranked.py`, salva una copia nuova nel ramo `fixtures-rest`).
- **Divisioni (rank del profilo)**: `update_divisions()` scrive `app/divisions/<chiave>.json` (bronze, silver,
  gold, platinum, emerald, diamond, master, gm = Grandmaster+Champion uniti come sul sito) con counter,
  sinergie, overall e mappe della divisione; indice in `data.json → divisions`. Rinnovati ogni **12 ore**: il
  workflow riscarica i file pubblicati (`--prev-divisions`) e li riusa se freschi (~60 richieste ogni 12 h).
  L'app carica solo i file dei rank dei due giocatori (`withDivision()`); ognuno ha i consigli sui suoi dati.

## I dati (formato di app/data.json)

```
checked        ISO UTC dell'ultimo controllo riuscito
sourceUpdated  ISO UTC di quando counterwatch ha rigenerato i dati (dateModified del team builder)
status         {heroes|counters|synergies|maps: ISO dell'ultimo aggiornamento riuscito di quella sezione}
problems       [frasi]: sezioni non aggiornate questa volta (vuoto = tutto ok)
heroes         [{id, slug, name, role: "Tank"|"Damage"|"Support", img (URL icona), style {POKE,RUSH,DIVE}}]
overall        {heroId: win rate medio sulle mappe}
counters       {heroId: {opponentId: win rate di heroId contro opponentId}}   (matrice completa)
synergies      {heroId: {allyId: win rate della coppia}}   (metà matrice: cercare in entrambe le direzioni)
counterScores  {heroId: {opponentId: punteggio counter di counterwatch}}   (non ancora usato)
maps           [{slug, name, mode: Control|Escort|Hybrid|Push|Flashpoint, winRates {heroId: wr}}]
filter         {gameType: "Ranked"|"All", why?: perché non Ranked, mapsAll?: [mappe prese dalle pagine]}
```
Le chiavi degli id sono **stringhe**. I win rate sono "shrunk" (corretti per i campioni piccoli), 0–1.
Le differenze sono piccole (±1–5%): è normale. Ad oggi: 53 eroi, 30 mappe, modalità 5v5.

Da dove vengono: counterwatch.gg è un sito Next.js **senza API pubblica**. Le pagine contengono i dati
nel flusso RSC (`self.__next_f.push`). `/stats/overwatch/team-builder` ha eroi, counter e sinergie;
`/stats/overwatch/maps` ha l'elenco mappe; `/stats/overwatch/maps/<slug>` il win rate per mappa.
Lo scraper riconosce i dati **dalla forma** (righe con eroe+avversario+win rate), non dai nomi dei campi.
Fa ~31 richieste con 1 s di pausa: **non abbassare la pausa e non aumentare la frequenza**.
Counterwatch sembra rigenerare i dati ~1 volta al giorno (visto una sola volta: 05:02 UTC).

## Requisiti aggiunti dall'utente (2026-10-05) — hanno la precedenza sotto

Giocano **in due** (l'utente e la sua ragazza) sulla stessa squadra, su Switch 2. L'app consiglia
**un eroe per ciascuno dei due**, in un colpo solo, senza che i due consigli si sovrappongano.

Due schede (tab in basso, grandi):
1. **Profilo** (si imposta una volta, salvato in localStorage): per ciascuno dei due giocatori
   nome, **rank**, **ruolo** (Tank/Danni/Supporto, anche più di uno), **eroi preferiti**
   (che ricevono un piccolo bonus nei consigli) ed eventuali altri parametri utili.
2. **Partita** (velocissima, chiarissima visivamente), in due momenti:
   - **Inizio partita / selezione eroi**: **mappa**, **ban** (eroi esclusi), e **Attacco/Difesa**
     — quest'ultimo solo per le modalità che lo prevedono (Escort, Hybrid); nascosto per
     Control, Push, Flashpoint. Consiglio basato solo su questi.
   - **Durante la partita**: **avversari** (da 1 a 5, non servono tutti) e, facoltativi,
     **alleati** (da 0 a 5) → consigli di counter aggiornati a ogni tocco.
   "Nuova partita" azzera la scheda Partita, mai il Profilo.

Come è stato risolto (dirlo all'utente, non spacciarlo per statistica):
- **Attacco/Difesa**: counterwatch non ha dati per lato. Regola dichiarata in `sideBonus()`: difesa premia lo
  stile POKE, attacco DIVE/RUSH, al massimo ±0.5%; nei motivi appare come "difesa (regola)".
- **Rank**: sceglie i dati Ranked della divisione del giocatore (vedi "Dati Ranked").
- Ban: max **5** (richiesta del 2026-10-05). Avversari: 1–5. Alleati: 0–5 (come chiesto). Preferiti: +1% (non entra nella "stima").
- **Ban consigliati per la mappa** (richiesta del 2026-10-05): riquadro "Ban consigliati per <mappa>" sotto mappa/lato,
  visibile con la mappa scelta finché non si segnano avversari, e sempre col selettore su "Ban"; **2 per ruolo**, un tocco li segna/toglie (`toggleIn`).
  `banSuggestions()` (recommend.js, testata): forza = win rate sulla mappa − 0.5 (media sulle divisioni dei giocatori)
  + minaccia = media del win rate del candidato contro i "vostri eroi" − 0.5. Vostri eroi = quelli consigliati SENZA
  ban (o già presi): non si propongono, né i preferiti né gli alleati (un ban vale per entrambe le squadre). L'elenco
  non cambia mentre si segnano i ban (si vedono barrati). e2e "ban consigliati …", "ban: al massimo 5".
- Coppia: `recommendDuo` prova tutte le coppie (eroi diversi) e somma anche la sinergia tra i due.
- **3 consigli per giocatore** (dal migliore): uno grande e 2 alternative (vedi "Design: tre livelli"); i perché in
  numeri ("Mappa ±x%", "Avversari ±x%", "Con <nome>", `breakdown()`; ogni avversario/alleato, `details()`) sono nel "Perché".
- **"Suggerisci solo eroi preferiti"** (Profilo, vale per entrambi): `onlyFavorites` in `recommend()`; se a un
  giocatore non resta nessun preferito utilizzabile si torna a tutti gli eroi e l'app lo scrive (`notes`).
  Vale anche dopo aver segnato l'eroe preso (richiesta del 2026-10-05): alternative e "Passa a"/"Cambia" solo tra i
  preferiti; se nessuno è utilizzabile, nessun cambio (l'eroe preso resta anche se non è un preferito).
- Icone: i volti degli eroi vengono copiati in `app/heroes/` dal workflow (verificato: 53/53 su GitHub).
- **Eroi nuovi / cambi di ruolo** (es. Sombra da Danni a Supporto): elenco eroi e ruoli vengono riletti dal
  sito a ogni giro, niente è scritto a mano. L'app ridisegna la griglia se l'elenco cambia anche con l'app
  aperta. Collaudato: `test_fetch.py` n. 14 e il controllo e2e "ruolo cambiato nei dati".

## Teoria (2026-10-05, richiesta dell'utente) — sempre separata dalle statistiche

- `app/theory.js` (puro, testato in `tests/theory.test.js`): stili **Rush/Dive/Poke** di counterwatch
  (`hero.style`), `buildTheory()` (rende simmetriche le liste: A batte B ⇒ B battuto da A), `heroTheory()`,
  `theoryForPick()` (incastro di stile con la squadra + counter verso gli avversari), `playGuide()` ("Come giocarla":
  Bersagli, Lascia stare, Attenzione a, Proteggi, Come muoverti, Gioca con, Mappa/lato; ogni riga è "teoria" o
  "statistica").
- `app/theory.json`: per eroe tags, synergies, counters, counteredBy, play {position, targets, avoidTargets, tips,
  attack, defense}, uncertain, sources. Raccolta da 3 ricercatori via WebSearch il 2026-10-05: **solo i riassunti
  dei risultati** (WebFetch bloccato dal proxy), voci solo-statistiche tolte. Incerti: D.Mon, Anran, Emre, Shion,
  Sierra, Sombra, Jetpack Cat, Mizuki, Wuyang. **Sombra diventa Supporto dal 6/10/2026 (Stagione 5)**: la sua
  teoria descrive il kit Danni e va rifatta.
- UI: colore viola + etichetta "Teoria" (`--theory`), "Dati" in blu; riquadri "Sinergizza con", "Countera bene",
  "Viene counterato da" nella scheda "Perché"; liste complete; "Come giocarla" dal riquadro (vedi "Design: tre livelli");
  interruttore nel Profilo "Usa anche la teoria nei consigli": dal 2026-10-06 (richiesta dell'utente) statistiche e
  teoria CONCORRONO entrambe, la teoria un po' di più: punteggio = 0.9·statistiche + 1.1·0.02·punti guide (45%/55%;
  `GUIDE_TO_WR` = 0.02 misurato: dispersione di 1 punto guide ≈ 2% di win rate su mappe e counter). Vale per consigli,
  combinazione di squadra (sinergie), ban (`blendedBanSuggestions`) e "Passa a"; la "stima" in % resta statistica.
- Riquadro consigli **in flusso** (scorre via con la pagina, non copre mai la griglia); quando è fuori schermo compare
  in alto la barra minima `#mini` (n. 1 di ciascuno, toccabile) e sotto si ferma il selettore Ban/Avversari/Alleati.
  **Niente scroll dentro i riquadri** (liste complete e distese; si scorre solo pagina o scheda). Collaudo e2e:
  "tutte le selezioni: ogni eroe toccabile" su 360×640 e 390×844 + "nessuno scroll interno" (falliscono sulla
  versione precedente, verificato). Schermi ≤ 380 px: layout compatto via media query.
- **Telefoni dell'utente**: Nothing Phone (3) (1260×2800, 460 ppi, ~420×860 CSS utili) e Xiaomi 14T della ragazza
  (1220×2712, 446 ppi, ~407×833 CSS utili). e2e li prova (tocchi, nomi non troncati per tutti i 53 eroi, griglia,
  niente scorrimento orizzontale); l'emulatore li imita con `wm size`/`wm density 480` + prova con carattere 130%.
  Stima sotto il volto (il nome ha tutta la riga), nomi della griglia su 2 righe.

- **Abilità e mappe (2026-10-05)**: in theory.json per eroe `abilities` [{name, it, ult, tags, use, when, targets, saveFor,
  avoidOn, on?}], `priority`, `mapFeatures`, `abilitiesNote`, `role` (ruolo al momento della ricerca: se cambia → "teoria da
  rivedere"); `_maps` (30 mappe: features, envKills, tips, attack, defense, goodStyles) e `_researched`. Ricerca di 4 agenti
  (solo riassunti WebSearch). `allyDirected()`: abilità da dare ai compagni (Nano Boost…) → targets = alleati; `on` in
  theory.json decide a mano (Orb of Discord = nemici). Sombra: kit Danni, da rifare dopo il 6/10. Roadhog: rework S5 incluso.
- `fill()` in app.js al posto di `replaceChildren` per le schede: le parti facoltative assenti non diventano testo "null"
  (e2e "schede senza testi «null»").

## "Consigli solo da guide e pro" (2026-10-06, richiesta dell'utente)

- Profilo → interruttore `#guide-only` (`profile.guideOnly`; con questo attivo "Usa anche la teoria" sparisce): consigli,
  ban e "Passa a" SENZA statistiche di counterwatch. `guideRow()`/`guideBanSuggestions()`/`guideDetails()`/`guideStars()`
  in recommend.js, `mapFit()` in theory.js (consigliato +2 / sconsigliato −2 dalle guide, stile +0.5, caratteristiche
  ±0.25; batte/soffre in teoria ±1, sinergia +0.5, preferito +0.5). Al posto della percentuale "guide ★★★"; "Perché"
  senza statistiche Ranked; playGuide(`guide: true`) toglie le righe "statistica". Test: unità (numeri stravolti →
  stessi consigli) ed e2e "solo guide …".
- `theory.json → _maps[slug].strong {Tank,Damage,Support: [{hero, why, side}]}`, `avoid [{hero, why}]`, `guideUncertain`:
  ricerca di 3 agenti il 2026-10-06 (solo riassunti WebSearch, fonti: guide Sportskeeda/Game8/TheGamer/Red Bull/Icy
  Veins/Liquipedia ecc., in buona parte 2022–2024, niente pro recenti; eroi nuovissimi mai citati). Incerte: Aatlis,
  Antarctic Peninsula, Blizzard World, Hollywood, Junkertown, King's Row, Lijiang, Midtown, Neon Junction (vuota),
  Nepal, New Junk City, New Queen Street, Rialto, Runasapi, Shambali. "Perché" mostra "Consigliato dalle guide su".
  Script di unione: rifare la ricerca e unirla (nomi eroi controllati sul ruolo).

## Più giocatori e "chi ha preso cosa" (2026-10-05, richiesta dell'utente)

- Profilo: **da 1 a 5 giocatori** (`MAX_PLAYERS`), "＋ Aggiungi giocatore" (il nuovo prende il ruolo che manca nella coda
  1 tank/2 danni/2 supporti) e "Rimuovi" a due tocchi. Ognuno ha un **colore** (`--p0`…`--p4`): riquadro, griglia, barra.
- Partita: eroe preso → `match.picked[i]`, da "Segna come preso" (riquadro o guida) o "Altro" + tocco nella griglia
  (poi si torna agli Avversari). Un eroe preso esce da ban/avversari/alleati. Griglia: **tratteggio** = consigliato a quel
  giocatore, **pieno + "F✓"** = preso. (La riga "Chi ha preso cosa" è stata tolta nel ridisegno: era un doppione.)
- Alleati = gli ALTRI della squadra: max `5 − giocatori` (il pulsante sparisce in 5).
- Logica: `recommendTeam()` (`recommendDuo` è lo stesso): eroi presi fissi (e alleati per gli altri; in cima alla loro lista
  con `picked: true`, sotto le alternative del ruolo); per gli altri la combinazione migliore (eroi diversi, sinergia tra
  ogni coppia), completa fino a 2 liberi, poi i migliori `TEAM_BEAM` = 12 a testa (5 giocatori: ~5 ms).
  `breakdown(row, partners[])`: "Con <nome>" o "Con voi". `playGuide` accetta `partners[]`.
- Collaudo: `recommend.test.js` (squadre da 1 a 5, combinazione ottima verificata a forza bruta con 3, eroi presi, tutti
  presi) ed e2e (1–5 giocatori su Xiaomi 14T e Nothing Phone (3), 5 anche su 360×640; aggiungi/rimuovi; screenshot 13-*, 14-*).
- Nomi della griglia: `fitNames()` misura la parola più lunga col testo VERO della pagina (span invisibile) e imposta solo
  il fattore `--fit` (CSS `calc(10px * var(--fit))`): una dimensione in px veniva ingrandita due volte dalla WebView col
  carattere di sistema al 130% (visto sull'emulatore). e2e "carattere al 130%" lo imita;
  l'e2e ora fallisce se un nome va a capo a metà parola (prima "Symmetra"/"Widowmaker" si spezzavano).

## Design: tre livelli (2026-10-05, richiesta dell'utente) — ha la precedenza su ciò che segue

L'app si usa DURANTE la partita: l'essenziale si coglie con uno sguardo, il resto è a un tocco o due.
1. **Riquadro del giocatore** (colpo d'occhio): l'eroe da prendere grande (volto + nome) con UNA sola cifra (la stima);
   prima degli avversari un solo motivo in parole (`headline()`, es. "Forte su King's Row"); con gli avversari
   **Batte/Teme** con i volti (`matchups()`: numeri + teoria, coerente con "Punta/Attento" della guida);
   "Segna come preso" (un tocco); 2 alternative (solo volti) + "＋" (eroe diverso → banner "Tocca l'eroe preso
   da X" al posto del selettore, `choosePicker`). Eroe preso: il riquadro resta fermo su quell'eroe; se conviene davvero
   compare "Passa a …" (`swapAdvice()`: +1,5% nei numeri, o counterato in teoria da 2+ avversari e l'alternativa non
   rende meno; mai per il n. 1 della lista). Niente percentuali "Mappa/Avversari/Con": sono nel livello 3.
2. **Come giocarla** (tocco sull'eroe, sul riquadrino in alto o su un'alternativa): "In breve" ≤ 7 righe con etichetta
   (Cambia, Punta, Attento, Abilità, Posizione, Proteggi, Mappa), volti per gli eroi, icona viola = teoria / azzurra = dati (legenda accanto a «In breve»);
   "Tutti i consigli" chiuso (`#guide-more` nascosto, pulsante `.more-btn`); "Segna: X l'ha preso"; "Perché?".
   Dal 2026-10-06 (richiesta: "consigli generici") ogni riga dice perché e cosa fare: **Attento** X: motivo — "lascia X a
   <alleato che lo batte in teoria>" o "evita l'1 contro 1" (+ "tieni <abilità> contro X", mai quella che X neutralizza);
   **Punta** con il motivo; **Combo** col compagno (sinergia); **Piano** (lato della mappa, poi consigliato/sconsigliato
   dalle guide); **Ultimate** (quando); Proteggi e Posizione solo se resta spazio. Ordine `PRIO` in playGuide, max 7.
3. **Perché** (dalla guida): riepilogo Mappa/Avversari/Con, ogni riga, statistiche Ranked complete, teoria completa.
- "↺ Nuova partita" nella barra in basso (sempre a portata di pollice) con "Annulla" nel messaggio.
- La barra minima in alto lampeggia una volta quando cambia il consiglio di un giocatore.
- Collaudo e2e: "un solo numero per riquadro", "In breve ≤ 7 righe e il resto chiuso", "Segna come preso: un tocco",
  "Annulla", nomi dei 53 eroi mai spezzati nel posto del consiglio (`window.owcFitText`).

## Stile "Vetro", ricerca e nomi italiani (2026-10-05, richiesta dell'utente) — ha la precedenza su ciò che segue

- **Stile scelto dall'utente tra 3 proposte: "Vetro"** (tipo iOS/visionOS): sfondo scuro con luci colorate ferme
  (`body::before`), pannelli di vetro (`.glass`; sfocato `.glass-blur` solo per ciò che sta sopra altro: barra in basso
  flottante `.dock`, barra minima, selettore fermo, messaggi; i fogli a tutto schermo sono pieni, senza sfocato), capsule, pulsante premuto bianco, fogli dal basso
  (`dialog`), interruttori sì/no disegnati come iOS (`.toggle.wide`), carattere **Inter** (`app/fonts/inter.woff2`, OFL,
  il più vicino a SF Pro), icone a tratto tipo SF Symbols in `app/icons.js` (`icon()`, `[data-ic]` + `fillIcons()`)
  al posto delle emoji. Colori per giocatore `--p0…--p4` (+ velati `--p0a…` per i bordi dei riquadri).
  Vincoli Chrome 83 (WebView API 30): niente gap nei flex, niente `inset`/`aspect-ratio`/`:is()`; `backdrop-filter` sì.
  Nel Chromium senza GPU dei test lo sfocato non si vede: le barre hanno comunque fondo all'86%.
  Mockup in scratchpad (non versionati). I nomi si rimisurano quando arriva il carattere (`document.fonts.ready`).
- **Ricerca** (griglia eroi, preferiti, mappe): `wireSearch()`; senza accenti né simboli, anche per iniziali ("jq"),
  nome inglese e italiano; Invio = primo risultato; dopo un tocco il campo si svuota e la tastiera resta aperta
  (`mousedown` senza focus). e2e "ricerca …".
- **Nomi ufficiali italiani** in `app/names_it.json` `{heroes:{en:it}, maps:{en:it}, abilities:{eroe:{en:it}}}`
  (facoltativo; chiavi = nomi inglesi di counterwatch/theory.json). Fonte: **OverFast API** (dati del sito ufficiale,
  en-us/it-it, abilità confrontate per posizione); rigenerare: workflow manuale "Pagine Blizzard (nomi italiani)"
  (`tools/fetch_blizzard.py` → ramo `fixtures-blizzard`), poi
  `git show origin/fixtures-blizzard:blizzard.tar.gz | tar xz -C /tmp && python3 tools/names_it.py /tmp/blizzard`
  (elenca le abilità della teoria senza nome ufficiale: Flashbang di Cassidy, Siphon Blaster di Emre, Jagged Blade,
  Flash Heal di Mercy, Nemesis Form, Trash Compactor del Roadhog S5 → restano in inglese con la traduzione).
  - **Abilità**: `localizeTheory()` mette il nome del gioco (es. Biostimolatore, Sovraccarico) anche dentro i consigli.
  - **Eroi**: diversi solo Soldato-76 e Regina dei Junker (D.MON/D.VA = solo maiuscole, ignorati): `tr()` li traduce
    nei testi mostrati (`el`/`fill`/titoli), dati e teoria restano in inglese. e2e: `itn()`/`toEn()`.
  - **Mappe**: OverFast non le traduce, la wiki inglese non ha collegamenti all'italiano. La wiki italiana (piccola,
    2017) conferma solo Ilio, Torre di Lijiang, Osservatorio: Gibilterra (`WIKI_IT` in names_it.py, accettati solo se la
    pagina esiste) + Penisola Antartica e Monastero Shambali (`OFFICIAL_IT`, notizie ufficiali Blizzard it-it, verificate
    il 2026-10-06). Le altre sono nomi propri, uguali nel gioco italiano (Neon Junction compreso). `tr()` traduce anche le
    mappe nei testi.
  - **Abilità degli altri eroi** citate nei consigli (es. Dragonblade di Genji nei consigli di Ana): tradotte anche loro
    (`localizeTheory()`, nomi globali senza ambiguità).
  - OverFast ha anche i **perk** (nomi e descrizioni in italiano, niente statistiche): non ancora usati.

## Tasto/gesto "indietro" di Android (2026-10-06)

L'APK fa già `web.goBack()` se la pagina ha cronologia, altrimenti chiude. L'app aggiunge un passo di cronologia per
ogni livello aperto (fogli, Profilo, "Tocca l'eroe preso da…"): `wireBack()`/`syncBack()` in app.js (MutationObserver
sull'attributo `open` dei dialog); indietro chiude il livello in cima, un livello chiuso con un pulsante toglie il suo
passo (`history.go`). e2e "indietro …"; sull'emulatore `KEYCODE_BACK` dal Profilo (l'app deve restare aperta).

## L'app (PWA) — come deve essere

Tema scuro, bersagli grandi (min 48 px), pensata per una mano sola.
- **In alto, fisso**: i 3 eroi consigliati per il ruolo scelto, con icona, stima e 2–3 motivi brevi
  (es. "vs Pharah +2.6%", "King's Row +1.4%", in rosso il matchup peggiore). Si aggiorna a ogni tocco.
- **Ruolo** (Tank / Danni / Supporto): si sceglie una volta, resta memorizzato (localStorage).
- **Mappa**: un pulsante apre una griglia delle 30 mappe raggruppate per modalità; un tocco sceglie e chiude.
  Facoltativa (senza mappa si usa `overall`).
- **Griglia eroi** (icone, divise per ruolo) + interruttore **Avversari / Alleati**: un tocco aggiunge
  l'eroe alla squadra attiva, un altro lo toglie. Max 5 avversari, 4 alleati. Ruolo-coda 5v5: 1 tank, 2 danni, 2 supporti.
- **Nuova partita**: azzera mappa e squadre, tiene il ruolo.
- **Freschezza dati** sempre visibile in piccolo: "dati counterwatch del 5 ott, controllati 2 h fa".
  Se `problems` non è vuoto o i dati hanno più di 24 h: avviso giallo chiaro, ma l'app funziona.
- **Aggiorna ora**: vedi sotto.
- Icone eroi: dagli URL `img` (supabase di counterwatch), messe in cache dal service worker;
  se non caricano, iniziali del nome su sfondo colorato per ruolo.
- Testi in italiano. Fonte citata ("dati: counterwatch.gg").

Service worker (dal 2026-10-05 sera, v6): guscio dell'app **network-first** (copia salvata solo offline: prima,
aggiornato in sottofondo, la prima apertura dopo un rilascio mostrava la versione vecchia e poteva mescolare file;
l'utente vedeva ban max 4 e niente ban consigliati); a ogni nuovo service worker la pagina si ricarica una volta
(`controllerchange`) e `autoRefresh` chiede anche `registration.update()`. Prima era: guscio cache-first; `data.json` **network-first** (con `?t=` per scavalcare la
cache CDN di Pages, ~10 min) e ripiego sulla copia in cache se offline; icone cache-first.
Manifest con icone 192/512 PNG (genera con Python/Pillow o canvas), `display: standalone`, tema scuro.

`app/recommend.js` esporta `recommend(data, {role, mapSlug, enemies, allies})` → righe ordinate
`{hero, score, estimate, parts:{base,contro,con}, vs, withAllies, ...}` e `reasons(row)`.
Formula: scarto dal 50% su mappa (o generale) + somma scarti contro ogni avversario
+ metà degli scarti di sinergia con ogni alleato. Esclude gli eroi già presi dagli alleati.
Sentiti libero di migliorarla (es. usare anche `counterScores`), ma con test.

## Aggiornamento automatico (GitHub Actions + Pages)

**Dal 2026-10-05 (richiesta dell'utente): ogni 30 minuti** (`cron "7,37 * * * *"`), ma leggero:
`tools/needs_update.py` fa 1 richiesta (team builder) e lancia l'aggiornamento completo solo se counterwatch
ha dati nuovi (`dateModified` diverso → anche `--force-divisions`) o se l'ultimo completo ha più di ~3 ore;
push e pulsante → sempre completo. Altrimenti niente scraping né pubblicazione. Keepalive del cron in un job a
parte, una volta al giorno (ore 03 UTC). **App**: rilegge `data.json` al massimo ogni 30 minuti, solo al
tocco dello schermo o al ritorno in primo piano (nessun timer: la WebView dell'APK non segnala in modo
affidabile il sottofondo; senza timer in sottofondo non succede nulla). Collaudato: test_fetch n. 15, e2e
"nessuna richiesta senza interazione" / "tocco dopo più di 30 minuti".

Repository **pubblico** (serve per Pages e per i minuti Actions gratuiti, emulatore compreso).
`update-data.yml`:
- `schedule: cron "17 */3 * * *"` (ogni 3 ore) + `workflow_dispatch` + push su main.
- Scarica il data.json **attualmente pubblicato** su Pages come `--prev` (se c'è), esegue
  `python3 tools/fetch_data.py --prev prev.json`; uscita 2 = pubblica comunque ma fai fallire il job
  alla fine (così GitHub manda la mail); uscita 1 = non pubblicare, job fallito.
- Esegue anche `python3 tests/test_fetch.py` e i test della logica prima di pubblicare.
- Pubblica la cartella `app/` su Pages con `actions/upload-pages-artifact` + `actions/deploy-pages`
  (**non** committare data.json a ogni giro: niente commit rumorosi).
- `concurrency` per evitare due pubblicazioni insieme.
Nota: i cron di GitHub possono ritardare di qualche minuto e si spengono dopo 60 giorni senza attività
nel repo: prevedi un modo semplice per riattivarli (o un keepalive) e dillo all'utente.

## Pulsante "aggiorna ora"

L'app chiama `POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/update-data.yml/dispatches`
con un **token fine-grained** dell'utente (solo questo repository, permesso **Actions: Read and write**),
salvato in localStorage del telefono (si inserisce una volta da un menu impostazioni). Poi controlla
lo stato della run (`GET .../actions/runs?event=workflow_dispatch&per_page=1`) e, finita la pubblicazione,
ricarica data.json. Mostra l'avanzamento ("aggiornamento in corso… ~2 min"). Limita a 1 richiesta ogni 10 min.
Senza token il pulsante ricarica solo data.json dal server e spiega come attivare l'aggiornamento forzato.
**Non** chiedere mai il token in chat e non scriverlo nel codice: lo crea e inserisce l'utente;
tu gli dai i passaggi esatti (github.com → Settings → Developer settings → Fine-grained tokens).

## Guscio APK

Preferito: **TWA con Bubblewrap** che punta all'URL di Pages (richiede `/.well-known/assetlinks.json`
servito dalla **radice** del dominio — con Pages di progetto non è possibile: valuta un repo
`<owner>.github.io` solo per quel file, oppure ripiega su un guscio **WebView** minimo in Kotlin che
carica l'URL di Pages). Scegli la via più semplice che funziona, spiega il compromesso all'utente.
`android.yml` su `ubuntu-latest`: JDK 17, build debug firmata con keystore di debug generato al volo
(niente segreti), test sull'emulatore con `reactivecircus/android-emulator-runner` (KVM attivo):
installa, avvia, attende il caricamento, screenshot (`adb exec-out screencap`) e un paio di tocchi;
carica APK e screenshot come artifact. Scarica gli screenshot e **guardali** prima di dire che va.

## Collaudo: regole

- Mai dire "funziona" senza averlo visto: test verdi + screenshot guardati.
- Lo scraper va sempre provato con `tests/test_fetch.py` dopo ogni modifica.
- La rete della sessione cloud potrebbe non raggiungere counterwatch.gg o Google Maven: usa le copie in
  `tests/fixtures.tar.gz` per i test; la build Android e lo scraping veri girano in GitHub Actions.
- Alla fine, verifica la run reale di `update-data.yml` su GitHub e che `https://<owner>.github.io/<repo>/data.json` risponda.

## Avvertenze per l'utente (riferiscile, non nasconderle)

- Nessuno scraper è eterno: se counterwatch rifà il sito, va corretto (l'app avvisa e intanto usa i dati vecchi).
- Il repo è pubblico: i dati estratti sono visibili a chi trova l'URL. Uso personale, fonte citata.
- I win rate sono statistiche aggregate: consigli, non certezze.

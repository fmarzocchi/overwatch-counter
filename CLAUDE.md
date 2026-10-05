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

## Stato al 2026-10-05

FATTO (sul Mac dell'utente, poi caricato qui):
- `tools/fetch_data.py` — scraper **funzionante e collaudato** (Python 3 standard, nessuna dipendenza).
  Scrive `app/data.json` (~90 KB). Codici di uscita: 0 ok, 2 dati salvati ma parziali, 1 niente salvato.
  Opzioni: `--out`, `--prev` (ultimo data.json buono, per il ripiego sezione per sezione), `--from-dir` (test offline).
- `tests/test_fetch.py` — 11 test, **tutti verdi**: pagine reali, campi rinominati, win rate in percentuale,
  team builder sparito, sito irriconoscibile, matrice troncata, una mappa rotta, valori assurdi.
  Usa le copie delle pagine in `tests/fixtures.tar.gz` (estratte da sole al primo avvio).
- `app/data.json` — dati reali del 2026-10-05.
- `app/recommend.js` — logica dei suggerimenti (modulo ES puro, **non ancora collaudato**).

DA FARE, in quest'ordine:
1. **Test della logica** `app/recommend.js` in Node (`node --test`), con casi concreti presi da data.json.
2. **La PWA** in `app/` (vedi "L'app" sotto). HTML/CSS/JS puri, niente framework né build.
3. **Workflow dati** `.github/workflows/update-data.yml` + pubblicazione su **GitHub Pages**.
4. **Pulsante "aggiorna ora"** (workflow_dispatch via API GitHub, vedi sotto).
5. **Collaudo della PWA** con Playwright (Chromium headless, viewport telefono 390×844): flusso completo,
   screenshot, offline, dati vecchi/rotti. Guarda tu gli screenshot.
6. **Guscio APK** + workflow `.github/workflows/android.yml` che compila e testa sull'emulatore.
7. Istruzioni finali all'utente: come installare la PWA o l'APK, come creare il token.

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

Punti aperti da verificare sui dati (dirli all'utente se non risolvibili):
- data.json non ha win rate per **lato** (attacco/difesa) né per **rank**: controllare se
  counterwatch li espone; se no, l'interruttore Attacco/Difesa e il rank vanno usati con una regola
  semplice e dichiarata (o solo memorizzati), non spacciati per statistica.

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

Service worker: guscio dell'app cache-first; `data.json` **network-first** (con `?t=` per scavalcare la
cache CDN di Pages, ~10 min) e ripiego sulla copia in cache se offline; icone cache-first.
Manifest con icone 192/512 PNG (genera con Python/Pillow o canvas), `display: standalone`, tema scuro.

`app/recommend.js` esporta `recommend(data, {role, mapSlug, enemies, allies})` → righe ordinate
`{hero, score, estimate, parts:{base,contro,con}, vs, withAllies, ...}` e `reasons(row)`.
Formula: scarto dal 50% su mappa (o generale) + somma scarti contro ogni avversario
+ metà degli scarti di sinergia con ogni alleato. Esclude gli eroi già presi dagli alleati.
Sentiti libero di migliorarla (es. usare anche `counterScores`), ma con test.

## Aggiornamento automatico (GitHub Actions + Pages)

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

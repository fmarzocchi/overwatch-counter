#!/usr/bin/env bash
# Collaudo dell'APK sull'emulatore (GitHub Actions): installa, avvia, screenshot, un paio di tocchi.
set -euo pipefail
PKG=io.github.fmarzocchi.owcounter
APK=android/app/build/outputs/apk/debug/app-debug.apk
OUT=android-shots
mkdir -p "$OUT"
shot() { adb exec-out screencap -p > "$OUT/$1.png"; echo "screenshot $1"; }

adb install -r "$APK"
adb shell am start -W -n "$PKG/.MainActivity"
# attende che la pagina sia disegnata: una schermata vuota (solo sfondo) è un PNG piccolo
loaded=""
for i in $(seq 1 24); do
  sleep 5
  shot 1-avvio
  if [ "$(stat -c %s "$OUT/1-avvio.png")" -gt 200000 ]; then loaded=1; break; fi
  if [ "$i" = 12 ]; then echo "pagina ancora vuota dopo 60 s: riavvio l'app"; adb shell am force-stop "$PKG"; adb shell am start -W -n "$PKG/.MainActivity"; fi
done
if [ -z "$loaded" ]; then echo "ERRORE: dopo 2 minuti l'app è ancora una schermata vuota"; exit 1; fi
sleep 10                                    # icone degli eroi
shot 1-avvio
size=$(adb shell wm size | grep -o '[0-9]*x[0-9]*' | tail -1); W=${size%x*}; H=${size#*x}
echo "schermo ${W}x${H}"
alive() { if [ -z "$(adb shell pidof "$PKG" || true)" ]; then echo "ERRORE: $1"; exit 1; fi; }
# Coordinate in % dello schermo intero (barra di stato e di navigazione comprese), ricavate dagli screenshot della v4 a
# 390×844 CSS e riportate a 1080×1920 (411×731 dp: 24 dp di stato + 48 di navigazione). Al primo avvio c'è l'Inizio
# partita: «Avanti» è la fascia arancione larga in fondo (56 px, 12 px dal bordo → 84–92% dell'altezza).
adb shell input tap $((W / 2)) $((H * 90 / 100))   # «Avanti» → Partita
sleep 3
shot 1b-partita
alive "dopo «Avanti» l'app si è chiusa"
adb shell input tap $((W * 89 / 100)) $((H * 92 / 100))   # scheda "Profilo" (barra in basso, a destra di FOTO)
sleep 4
shot 2-profilo
adb shell input keyevent KEYCODE_BACK                  # tasto indietro: dal Profilo torna alla Partita, l'app resta aperta
sleep 3
shot 2b-indietro
alive "il tasto indietro ha chiuso l'app"
# «Nuova» (seconda voce della barra) apre l'Inizio partita; il tasto indietro lì vale «Avanti»: torna alla Partita
adb shell input tap $((W * 33 / 100)) $((H * 92 / 100))
sleep 3
shot 2c-nuova
adb shell input keyevent KEYCODE_BACK
sleep 3
shot 2d-nuova-indietro
alive "il tasto indietro nell'Inizio partita ha chiuso l'app"
# «✓ PRESO» della prima card (a destra, in alto: 79–93% della larghezza, 23–31% dell'altezza): un tocco = eroe scelto.
# Nessuna lista di eroi nella pagina: si apre solo toccando un posto o un ritratto.
adb shell input tap $((W * 86 / 100)) $((H * 27 / 100))
sleep 3
shot 3-tocco-eroe
adb shell input swipe $((W / 2)) $((H * 70 / 100)) $((W / 2)) $((H * 40 / 100)) 300   # scorre (se la pagina è più alta dello schermo)
sleep 2
pid=$(adb shell pidof "$PKG" || true)
adb logcat -d | grep -E "chromium|CONSOLE|FATAL|AndroidRuntime: (FATAL|Process)" > "$OUT/logcat.txt" || true
if [ -z "$pid" ]; then echo "ERRORE: l'app non è più in esecuzione"; exit 1; fi
if grep -E "CONSOLE.*Uncaught" "$OUT/logcat.txt"; then echo "ERRORE: errori JavaScript nell'app (vedi sopra)"; exit 1; fi
echo "app in esecuzione (pid $pid)"

# Foto del tabellone: il pulsante grande al centro della barra apre (la prima volta) chiave e nomi nel gioco; con Invio
# si arriva a "Salva e scatta", che deve aprire la fotocamera del telefono. Indietro torna all'app (foto annullata):
# l'app deve restare aperta e senza errori JavaScript. La chiave è finta: qui non si chiama Claude.
resumed() { adb shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" | head -1 || true; }
# foto vecchie finte nella cache dell'app: al prossimo scatto ne devono restare al massimo 5 (MAX_PHOTOS)
adb shell run-as "$PKG" mkdir -p cache/photos || echo "AVVISO: run-as non disponibile"
adb shell run-as "$PKG" touch cache/photos/vecchia-1.jpg cache/photos/vecchia-2.jpg cache/photos/vecchia-3.jpg \
  cache/photos/vecchia-4.jpg cache/photos/vecchia-5.jpg cache/photos/vecchia-6.jpg cache/photos/vecchia-7.jpg || true
adb shell input tap $((W / 2)) $((H * 92 / 100))   # FOTO (al centro della barra in basso)
sleep 3
shot 7-foto-impostazioni
adb shell input text "sk-ant-prova-emulatore"
adb shell input keyevent KEYCODE_ENTER   # → nome nel gioco del primo giocatore
adb shell input text "Fabio"
adb shell input keyevent KEYCODE_ENTER   # → secondo giocatore
adb shell input keyevent KEYCODE_ENTER   # → pulsante "Salva e scatta"
adb shell input keyevent KEYCODE_ENTER   # lo preme
camera=""
for i in $(seq 1 10); do   # l'app della fotocamera (API 30: com.android.camera2/...CaptureActivity) ci mette qualche secondo
  sleep 2
  if resumed | grep -qi camera; then camera=1; break; fi
done
shot 7b-fotocamera
echo "in primo piano: $(resumed)"
if [ -z "$camera" ]; then echo "ERRORE: dopo «Salva e scatta» la fotocamera non si è aperta"; exit 1; fi
echo "fotocamera aperta: ok"
for i in 1 2 3; do
  if resumed | grep -q "$PKG"; then break; fi
  adb shell input keyevent KEYCODE_BACK
  sleep 3
done
shot 7c-ritorno
adb shell run-as "$PKG" ls -la cache/photos 2>/dev/null || true
photos=$(adb shell run-as "$PKG" ls -1 cache/photos 2>/dev/null | grep -c "\.jpg" || true)
echo "foto nella cache: $photos"
if [ "${photos:-0}" -gt 5 ]; then echo "ERRORE: nella cache ci sono più di 5 foto"; exit 1; fi
if ! resumed | grep -q "$PKG"; then echo "ERRORE: dopo la fotocamera non si torna all'app"; exit 1; fi
if [ -z "$(adb shell pidof "$PKG" || true)" ]; then echo "ERRORE: l'app si è chiusa dopo la fotocamera"; exit 1; fi

# Schermi dei telefoni dell'utente: stessa risoluzione e densità (≈ fattore 3 → 480 dpi logici).
# Nothing Phone (3): 1260×2800, 460 ppi. Xiaomi 14T: 1220×2712, 446 ppi. Più una prova con il carattere
# di sistema ingrandito (130%), che la WebView applica anche all'app.
device_shot() { # nome larghezza altezza scala_carattere
  adb shell wm size "$2x$3"
  adb shell wm density 480
  adb shell settings put system font_scale "$4"
  adb shell am force-stop "$PKG"
  adb shell am start -W -n "$PKG/.MainActivity" > /dev/null
  for i in $(seq 1 18); do
    sleep 5
    shot "$1"
    if [ "$(stat -c %s "$OUT/$1.png")" -gt 250000 ]; then break; fi
  done
  sleep 6
  shot "$1"
  adb shell input swipe $(($2 / 2)) $(($3 * 80 / 100)) $(($2 / 2)) $(($3 * 30 / 100)) 300
  sleep 2
  shot "$1-scorso"
}
device_shot 4-nothing-phone-3 1260 2800 1.0
device_shot 5-xiaomi-14t 1220 2712 1.0
device_shot 6-xiaomi-14t-carattere-130 1220 2712 1.3
adb shell wm size reset; adb shell wm density reset; adb shell settings put system font_scale 1.0
adb logcat -d | grep -E "chromium|CONSOLE|FATAL|AndroidRuntime: (FATAL|Process)" > "$OUT/logcat.txt" || true
if grep -E "CONSOLE.*Uncaught" "$OUT/logcat.txt"; then echo "ERRORE: errori JavaScript sugli schermi dei telefoni"; exit 1; fi
if [ -z "$(adb shell pidof "$PKG" || true)" ]; then echo "ERRORE: l'app si è chiusa"; exit 1; fi
echo "schermi dei telefoni: ok"

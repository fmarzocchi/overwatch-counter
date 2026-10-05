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
adb shell input tap $((W * 3 / 4)) $((H * 90 / 100))   # scheda "Profilo" (barra flottante in basso)
sleep 4
shot 2-profilo
adb shell input tap $((W / 4)) $((H * 90 / 100))       # scheda "Partita"
sleep 3
adb shell input swipe $((W / 2)) $((H * 80 / 100)) $((W / 2)) $((H * 35 / 100)) 300   # scorre alla griglia
sleep 2
adb shell input tap $((W * 12 / 100)) $((H * 60 / 100))  # tocca un eroe (avversario)
sleep 3
shot 3-tocco-eroe
pid=$(adb shell pidof "$PKG" || true)
adb logcat -d | grep -E "chromium|CONSOLE|FATAL|AndroidRuntime: (FATAL|Process)" > "$OUT/logcat.txt" || true
if [ -z "$pid" ]; then echo "ERRORE: l'app non è più in esecuzione"; exit 1; fi
if grep -E "CONSOLE.*Uncaught" "$OUT/logcat.txt"; then echo "ERRORE: errori JavaScript nell'app (vedi sopra)"; exit 1; fi
echo "app in esecuzione (pid $pid)"

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

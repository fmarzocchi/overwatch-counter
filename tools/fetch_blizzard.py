#!/usr/bin/env python3
"""Scarica dal sito ufficiale di Overwatch le pagine degli eroi e delle mappe, in inglese e in italiano.

Servono per i nomi ITALIANI ufficiali (quelli del gioco) di abilità, eroi e mappe: l'inglese fa da chiave,
perché è la lingua dei dati di counterwatch e di theory.json. Le pagine si confrontano per posizione.

Uso:  python3 tools/fetch_blizzard.py --out DIR     (gira su GitHub Actions: dalla sessione cloud il sito non si raggiunge)
Una richiesta al secondo; nessun dato personale.
"""
import argparse
import os
import re
import sys
import time
import urllib.request

BASE = "https://overwatch.blizzard.com"
LANGS = ("en-us", "it-it")
UA = "Mozilla/5.0 (compatibile; overwatch-counter; uso personale)"


def get(url, tries=3):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "it-IT,it;q=0.9,en;q=0.5"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # rete: si riprova con calma
            print(f"  {url}: {e} (tentativo {k + 1})", file=sys.stderr)
            time.sleep(3 * (k + 1))
    return None


def hero_slugs(html, lang):
    return sorted(set(re.findall(rf'href="/{lang}/heroes/([a-z0-9-]+)/?"', html or "")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--pause", type=float, default=1.0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    def save(name, html):
        with open(os.path.join(a.out, name), "w", encoding="utf-8") as f:
            f.write(html)

    slugs = set()
    for lang in LANGS:
        for page in ("heroes", "maps"):
            html = get(f"{BASE}/{lang}/{page}/")
            time.sleep(a.pause)
            if not html:
                print(f"ERRORE: {lang}/{page} non scaricata", file=sys.stderr)
                continue
            save(f"{lang}_{page}.html", html)
            if page == "heroes":
                slugs |= set(hero_slugs(html, lang))
    print(f"{len(slugs)} eroi trovati: {', '.join(sorted(slugs))}")
    ok = 0
    for slug in sorted(slugs):
        for lang in LANGS:
            html = get(f"{BASE}/{lang}/heroes/{slug}/")
            time.sleep(a.pause)
            if html:
                save(f"{lang}_hero_{slug}.html", html)
                ok += 1
    print(f"{ok} pagine eroe salvate in {a.out}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

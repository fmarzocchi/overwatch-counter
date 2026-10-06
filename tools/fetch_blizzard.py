#!/usr/bin/env python3
"""Scarica i nomi ufficiali di eroi, abilità e mappe, in inglese e in italiano.

Servono per i nomi ITALIANI del gioco: l'inglese fa da chiave, perché è la lingua dei dati di counterwatch e di
theory.json. Due fonti, salvate così come arrivano (il confronto si fa dopo, con tools/names_it.py):
  1. OverFast API (overfast-api.tekrop.fr): JSON ricavato dal sito ufficiale, con le lingue (locale=it-it);
  2. il sito ufficiale overwatch.blizzard.com (pagine HTML), se risponde;
  3. mappe: la wiki di Overwatch (overwatch.fandom.com) collega ogni pagina inglese a quella italiana (langlinks):
     il titolo italiano è il nome della mappa nel gioco. Una sola richiesta con i nomi di app/data.json.
Una fonte che non risponde (3 errori di fila) si salta; c'è un tempo massimo (--budget) e si salva comunque
quello che si è scaricato.

Uso:  python3 -u tools/fetch_blizzard.py --out DIR   (gira su GitHub Actions: dalla sessione cloud non si raggiungono)
Una richiesta al secondo; nessun dato personale.
"""
import argparse
import gzip
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

BLIZZARD = "https://overwatch.blizzard.com"
OVERFAST = "https://overfast-api.tekrop.fr"
LANGS = ("en-us", "it-it")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatibile; overwatch-counter; uso personale)",
    "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "it-IT,it;q=0.9,en;q=0.5",
    "Accept-Encoding": "gzip",
}
T0 = time.time()


def log(msg):
    print(f"[{time.time() - T0:6.1f}s] {msg}", flush=True)


class Source:
    """Una fonte: dopo 3 errori di fila si arrende (il sito non risponde da qui)."""

    def __init__(self, name, budget, pause):
        self.name, self.budget, self.pause, self.fails, self.ok = name, budget, pause, 0, 0

    @property
    def dead(self):
        return self.fails >= 3 or time.time() - T0 > self.budget

    def get(self, url):
        if self.dead:
            return None
        time.sleep(self.pause)
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
            self.fails = 0
            self.ok += 1
            return body.decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001 - qualsiasi errore di rete conta come un tentativo fallito
            self.fails += 1
            log(f"  {url}: {e}")
            if self.dead:
                log(f"{self.name}: troppi errori o tempo finito, la salto")
            return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--pause", type=float, default=1.0)
    ap.add_argument("--budget", type=float, default=1200, help="secondi massimi in tutto")
    ap.add_argument("--data", default="app/data.json", help="per l'elenco delle mappe")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    def save(name, text):
        with open(os.path.join(a.out, name), "w", encoding="utf-8") as f:
            f.write(text)

    # 1. OverFast API
    of = Source("OverFast", a.budget * 0.5, a.pause)
    keys = set()
    for lang in LANGS:
        for what in ("heroes", "maps"):
            txt = of.get(f"{OVERFAST}/{what}?locale={lang}")
            if txt:
                save(f"overfast_{lang}_{what}.json", txt)
                if what == "heroes":
                    try:
                        keys |= {h["key"] for h in json.loads(txt) if h.get("key")}
                    except (ValueError, TypeError, KeyError) as e:
                        log(f"  elenco eroi OverFast illeggibile: {e}")
    log(f"OverFast: {len(keys)} eroi")
    for key in sorted(keys):
        for lang in LANGS:
            txt = of.get(f"{OVERFAST}/heroes/{key}?locale={lang}")
            if txt:
                save(f"overfast_{lang}_hero_{key}.json", txt)
    log(f"OverFast: {of.ok} risposte")

    # 3. mappe: titoli italiani dalla wiki (langlinks)
    try:
        with open(a.data, encoding="utf-8") as f:
            maps = [m["name"] for m in json.load(f)["maps"]]
    except (OSError, ValueError, KeyError) as e:
        maps = []
        log(f"elenco mappe non letto: {e}")
    wiki = Source("Wiki", a.budget, a.pause)
    for _ in range(2):  # due tentativi
        if not maps:
            break
        q = urllib.parse.urlencode({"action": "query", "titles": "|".join(maps), "prop": "langlinks", "lllang": "it",
                                    "lllimit": "max", "redirects": "1", "format": "json"})
        txt = wiki.get(f"https://overwatch.fandom.com/api.php?{q}")
        if txt:
            save("wiki_maps_langlinks.json", txt)
            break
    # wiki italiana (se esiste): elenco delle pagine, per riconoscere i nomi italiani delle mappe
    q = urllib.parse.urlencode({"action": "query", "list": "allpages", "aplimit": "500", "format": "json"})
    txt = wiki.get(f"https://overwatch.fandom.com/it/api.php?{q}")
    if txt:
        save("wiki_it_allpages.json", txt)
    log(f"Wiki: {wiki.ok} risposte")

    # 2. sito ufficiale
    bz = Source("Blizzard", a.budget, a.pause)
    slugs = set()
    for lang in LANGS:
        for page in ("heroes", "maps"):
            html = bz.get(f"{BLIZZARD}/{lang}/{page}/")
            if html:
                save(f"{lang}_{page}.html", html)
                if page == "heroes":
                    slugs |= set(re.findall(rf'href="/{lang}/heroes/([a-z0-9-]+)/?"', html))
    log(f"Blizzard: {len(slugs)} eroi")
    for slug in sorted(slugs):
        for lang in LANGS:
            html = bz.get(f"{BLIZZARD}/{lang}/heroes/{slug}/")
            if html:
                save(f"{lang}_hero_{slug}.html", html)
    log(f"Blizzard: {bz.ok} risposte")

    return 0 if of.ok + bz.ok + wiki.ok else 1


if __name__ == "__main__":
    sys.exit(main())

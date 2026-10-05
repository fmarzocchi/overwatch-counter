#!/usr/bin/env python3
"""Diagnosi: counterwatch ha dati sui vantaggi (perk) degli eroi? Poche richieste. Non serve all'app."""
import re, time, urllib.request

BASE = "https://www.counterwatch.gg"
UA = {"User-Agent": "Mozilla/5.0 (personal counterpick helper)"}


def get(url):
    time.sleep(1.0)
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode("utf-8", "ignore")


urls = re.findall(r"<loc>([^<]+)</loc>", get(BASE + "/sitemap.xml"))
ow = [u for u in urls if "/overwatch" in u]
print(f"sitemap: {len(urls)} url, overwatch {len(ow)}")
print("con 'perk':", [u for u in urls if "perk" in u.lower()][:20])
kinds = sorted({re.sub(r"/[^/]+$", "/…", u) for u in ow})
print("tipi di pagina overwatch:", kinds[:40])
hero = next((u for u in ow if re.search(r"/heroes?/ana\b|/ana$", u)), None) or next((u for u in ow if "/heroes/" in u), None)
print("pagina eroe di prova:", hero)
if hero:
    html = get(hero)
    hits = [m.group(0) for m in re.finditer(r".{100}[Pp]erk.{160}", html)]
    print(f"'perk' nella pagina: {len(hits)}")
    for h in hits[:12]:
        print("  ", h.replace("\n", " ")[:260])

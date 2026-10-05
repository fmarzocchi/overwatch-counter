#!/usr/bin/env python3
"""Diagnosi: come counterwatch filtra Ranked/divisione? Legge il JS del sito e stampa i punti utili.
Gira in GitHub Actions (workflow "Diagnosi filtro Ranked"); non serve all'app."""
import re, time, urllib.request

BASE = "https://counterwatch.gg"
UA = {"User-Agent": "Mozilla/5.0 (personal counterpick helper)"}


def get(url):
    time.sleep(1.0)
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode("utf-8", "ignore")


html = get(BASE + "/stats/overwatch/team-builder")
chunks = sorted(set(re.findall(r'/_next/static/chunks/[^"\\ ]+?\.js', html)))
print(f"{len(chunks)} chunk JS")
pats = [r'searchParams\.(?:get|set|has|append)\(\s*"[^"]+"', r'[?&][a-zA-Z_]+=\$\{', r'"[?&]?[a-zA-Z_]+="',
        r'.{80}"Ranked".{120}', r'.{80}gameTypes?.{120}', r'.{60}division.{100}', r'.{60}statCategory.{100}',
        r'router\.(?:push|replace)\(.{0,160}', r'URLSearchParams.{0,160}']
for c in chunks:
    try:
        js = get(BASE + c)
    except Exception as e:
        print("!", c, e)
        continue
    hits = []
    for p in pats:
        hits += [m.group(0) for m in re.finditer(p, js)][:6]
    if hits:
        print(f"\n===== {c} ({len(js)} B)")
        for h in dict.fromkeys(hits):
            print("  ", h.replace("\n", " ")[:260])
try:
    sm = get(BASE + "/sitemap.xml")
    urls = re.findall(r"<loc>([^<]+)</loc>", sm)
    print(f"\nsitemap: {len(urls)} url; con '?' o 'rank':")
    for u in [u for u in urls if "?" in u or "rank" in u.lower()][:30]:
        print("  ", u)
except Exception as e:
    print("sitemap:", e)

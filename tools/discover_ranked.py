#!/usr/bin/env python3
"""Diagnosi: come counterwatch carica i dati Ranked/divisione. Gira in GitHub Actions; non serve all'app.
La chiave pubblica (anon) del database del sito viene usata solo per le prove e non viene stampata."""
import json, re, time, urllib.parse, urllib.request

BASE = "https://counterwatch.gg"
UA = {"User-Agent": "Mozilla/5.0 (personal counterpick helper)"}


def get(url, headers=None):
    time.sleep(1.0)
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "ignore"), dict(r.headers)


html, _ = get(BASE + "/stats/overwatch/team-builder?type=Ranked")
m = re.search(r'UsedAllFallback\\?":(true|false)', html)
print("SSR ?type=Ranked → UsedAllFallback:", m and m.group(1))
chunks = sorted(set(re.findall(r'/_next/static/chunks/[^"\\ ]+?\.js', html)))
url = key = None
queries = set()
for c in chunks:
    js, _ = get(BASE + c)
    for mm in re.finditer(r'https://[a-z0-9]+\.supabase\.co', js):
        url = url or mm.group(0)
    for mm in re.finditer(r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}', js):
        key = key or mm.group(0)
    if "rest/v1" in js or "community_stats" in js:
        print(f"\n===== {c}")
        for mm in re.finditer(r'.{120}(?:rest/v1|community_stats_[a-z_]+\?select).{260}', js):
            print("  ", mm.group(0)[:400])
        for mm in re.finditer(r'(community_stats_[a-z_]+)\?select=([^&`$]+)', js):
            queries.add((mm.group(1), mm.group(2)))
        for mm in re.finditer(r'.{40}[,;\s]v=\(?[a-z,]*\)?=>.{120}', js):
            print("   v():", mm.group(0)[:200])
print("\nsupabase url:", url, "| chiave anon trovata:", bool(key), len(key or ""))
print("tabelle:", sorted(queries))
if url and key:
    hdr = {"apikey": key, "Authorization": f"Bearer {key}", "Prefer": "count=exact"}
    for table, sel in sorted(queries):
        for gt in ["Ranked", "All"]:
            q = (f"{url}/rest/v1/{table}?select={sel}&game=eq.Overwatch&stat_category=eq.5V5"
                 f"&game_type=eq.{gt}&division=eq.All&limit=2")
            try:
                body, h = get(q, hdr)
                print(f"\n{table} [{gt}] count={h.get('Content-Range')} → {body[:300]}")
            except Exception as e:
                print(f"\n{table} [{gt}] ERRORE {e}")

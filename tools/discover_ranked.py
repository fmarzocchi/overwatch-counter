#!/usr/bin/env python3
"""Diagnosi: formula di shrinkage di counterwatch + copia dei dati Ranked per i test offline.
Sola lettura. Le chiavi non vengono mai stampate né salvate."""
import json, pathlib, re, statistics, sys, time, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import fetch_data as fd  # riusa estrazione delle pagine

BASE = "https://counterwatch.gg"
UA = {"User-Agent": "Mozilla/5.0 (personal counterpick helper)"}
OUT = pathlib.Path("tests/fixtures_rest")


def get(url, headers=None):
    time.sleep(1.0)
    with urllib.request.urlopen(urllib.request.Request(url, headers={**UA, **(headers or {})}), timeout=30) as r:
        return r.read().decode("utf-8", "ignore")


html = get(BASE + "/stats/overwatch/team-builder")
key = url = None
for c in sorted(set(re.findall(r'/_next/static/chunks/[^"\\ ]+?\.js', html))):
    js = get(BASE + c)
    if "shrinkWinRate" in js and '"shrinkWinRate",0,r' in js:
        i = js.index('"shrinkWinRate",0,r')
        print("DEFINIZIONE shrinkWinRate (prima del nome):\n", js[max(0, i - 900):i + 40], "\n")
    key = key or (re.search(r'sb_publishable_[\w-]+', js) or [None])[0]
    url = url or (re.search(r'https://[a-z0-9]+\.supabase\.co', js) or [None])[0]
print("url:", url, "chiave:", bool(key))
H = {"apikey": key, "Authorization": f"Bearer {key}"}


def rest_all(q):
    rows, off = [], 0
    while True:
        page = json.loads(get(f"{url}/rest/v1/{q}&limit=1000&offset={off}", H))
        rows += page
        if len(page) < 1000:
            return rows
        off += 1000


OUT.mkdir(parents=True, exist_ok=True)
common = "game=eq.Overwatch&stat_category=eq.5V5&division=eq.All"
data = {}
for gt in ["Ranked", "All"]:
    for name, sel in [("counters", "community_stats_counters_current?select=hero_id,opponent_hero_id,win_rate,total_matches"),
                      ("synergies", "community_stats_synergies_current?select=hero_id,ally_hero_id,win_rate,total_matches"),
                      ("current", "community_stats_current?select=hero_id,map_name,game_mode_name,win_rate,total_matches")]:
        rows = rest_all(f"{sel}&{common}&game_type=eq.{gt}")
        data[(gt, name)] = rows
        (OUT / f"{gt.lower()}_{name}.json").write_text(json.dumps(rows, separators=(",", ":")))
        print(f"{gt} {name}: {len(rows)} righe")

# confronto con i dati "shrunk" della pagina (All) per ricavare la forza k della correzione verso 50%
_, page_counters, _, _ = fd.extract_team_builder(fd.payload(html))
ks = []
for r in data[("All", "counters")]:
    s = page_counters.get(str(r["hero_id"]), {}).get(str(r["opponent_hero_id"]))
    n, w = r["total_matches"], r["win_rate"]
    if s is not None and abs(s - 0.5) > 0.003 and n > 0:
        ks.append(n * (w - s) / (s - 0.5))
print(f"stima k (verso 50%): {len(ks)} celle, mediana {statistics.median(ks):.1f}, "
      f"quartili {statistics.quantiles(ks, n=4)}" if ks else "nessuna cella confrontabile")
ex = [(r, page_counters.get(str(r["hero_id"]), {}).get(str(r["opponent_hero_id"]))) for r in data[("All", "counters")][:8]]
for r, s in ex:
    print("  esempio", r, "→ pagina", s)

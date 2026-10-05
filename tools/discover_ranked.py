#!/usr/bin/env python3
"""Diagnosi: dati Ranked dal database pubblico di counterwatch (sola lettura). Gira in GitHub Actions.
Le chiavi non vengono mai stampate (mascherate come <KEY>)."""
import json, re, time, urllib.request

BASE = "https://counterwatch.gg"
UA = {"User-Agent": "Mozilla/5.0 (personal counterpick helper)"}
mask = lambda s: re.sub(r'(sb_publishable_|eyJ)[\w.-]+', "<KEY>", s)


def get(url, headers=None):
    time.sleep(1.0)
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "ignore"), dict(r.headers)


html, _ = get(BASE + "/stats/overwatch/team-builder")
chunks = sorted(set(re.findall(r'/_next/static/chunks/[^"\\ ]+?\.js', html)))
keys, url = [], None
for c in chunks:
    js, _ = get(BASE + c)
    url = url or (re.search(r'https://[a-z0-9]+\.supabase\.co', js) or [None])[0]
    keys += re.findall(r'sb_publishable_[\w-]+', js) + re.findall(r'eyJ[\w-]{10,}\.[\w-]{20,}\.[\w-]{10,}', js)
    for w in ["supabasePublishableKey", "shrinkWinRate", "shrinkCounterRows", "expandDivisions"]:
        for m in list(re.finditer(r'.{150}' + w + r'.{350}', js))[:2]:
            print(f"[{c[-18:]}] {w}: {mask(m.group(0))[:500]}\n")
keys = list(dict.fromkeys(keys))
print("url:", url, "| chiavi trovate:", [("sb_publishable" if k.startswith("sb_") else "jwt", len(k)) for k in keys])


def rest(key, q):
    h = {"apikey": key, "Authorization": f"Bearer {key}", "Prefer": "count=exact"}
    return get(f"{url}/rest/v1/{q}", h)


for i, key in enumerate(keys):
    for game in ["overwatch", "Overwatch"]:
        q = (f"community_stats_counters_current?select=hero_id,opponent_hero_id,win_rate,total_matches"
             f"&game=eq.{game}&stat_category=eq.5V5&game_type=eq.Ranked&division=eq.All&limit=3")
        try:
            body, h = rest(key, q)
            print(f"chiave {i} game={game}: {h.get('Content-Range')} {body[:300]}")
        except Exception as e:
            print(f"chiave {i} game={game}: {e}")
            continue
        if not body.startswith("[") or body == "[]":
            continue
        for q2 in [f"community_stats_counters_current?select=game_type,division&game=eq.{game}&stat_category=eq.5V5&limit=1000",
                   f"community_stats_current?select=*&game=eq.{game}&stat_category=eq.5V5&game_type=eq.Ranked&division=eq.All&limit=1",
                   f"community_stats_synergies_current?select=hero_id,ally_hero_id,win_rate,total_matches&game=eq.{game}&stat_category=eq.5V5&game_type=eq.Ranked&division=eq.All&limit=2",
                   f"community_stats_counters_current?select=hero_id,opponent_hero_id,win_rate,total_matches&game=eq.{game}&stat_category=eq.5V5&game_type=eq.All&division=eq.All&limit=2"]:
            try:
                b, h = rest(key, q2)
                if "select=game_type,division" in q2:
                    rows = json.loads(b)
                    print("combinazioni game_type/division:", sorted({(r["game_type"], r["division"]) for r in rows}), h.get("Content-Range"))
                else:
                    print(q2.split("?")[0], h.get("Content-Range"), b[:400])
            except Exception as e:
                print(q2.split("?")[0], "ERRORE", e)
        raise SystemExit(0)

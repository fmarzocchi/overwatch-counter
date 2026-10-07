#!/usr/bin/env python3
"""Crea app/names_it.json (nomi ufficiali italiani di eroi e abilità) dalla copia scaricata da tools/fetch_blizzard.py.

Fonte: OverFast API (dati del sito ufficiale overwatch.blizzard.com), stesso eroe in en-us e it-it: le abilità si
confrontano per posizione. Le chiavi sono i nomi inglesi usati da counterwatch (data.json) e da theory.json.
Mappe: dalla wiki di Overwatch (wiki_maps_langlinks.json: titolo inglese → pagina italiana); senza, restano vuote.

Uso:  python3 tools/names_it.py DIR [--data app/data.json] [--theory app/theory.json] [--out app/names_it.json]
      (DIR = cartella "blizzard" estratta dal ramo fixtures-blizzard)
"""
import argparse
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timezone


def key(text):
    t = unicodedata.normalize("NFD", str(text))
    t = "".join(c for c in t if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]+", "", t)


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--data", default="app/data.json")
    ap.add_argument("--theory", default="app/theory.json")
    ap.add_argument("--out", default="app/names_it.json")
    a = ap.parse_args()

    theory = load(a.theory)
    data_names = {key(h["name"]): h["name"] for h in load(a.data)["heroes"]}
    # anche gli eroi della teoria non ancora su counterwatch (es. Doctrine, Stagione 5): nomi pronti per quando arrivano
    data_names.update({key(n): n for n in theory if not n.startswith("_") and key(n) not in data_names})
    try:
        prev_abilities = load(a.out).get("abilities", {})
    except (OSError, ValueError):
        prev_abilities = {}
    of = lambda name: os.path.join(a.dir, name)  # noqa: E731
    en_list = load(of("overfast_en-us_heroes.json"))
    it_names = {h["key"]: h["name"] for h in load(of("overfast_it-it_heroes.json"))}

    heroes, abilities, problems = {}, {}, []
    for h in en_list:
        ours = data_names.get(key(h["name"]))
        if not ours:
            problems.append(f"eroe {h['name']} non presente nei dati di counterwatch")
            continue
        if it_names.get(h["key"]):
            heroes[ours] = it_names[h["key"]]
        try:
            en = [x["name"] for x in load(of(f"overfast_en-us_hero_{h['key']}.json")).get("abilities", [])]
            it = [x["name"] for x in load(of(f"overfast_it-it_hero_{h['key']}.json")).get("abilities", [])]
        except (OSError, ValueError) as e:
            problems.append(f"{ours}: abilità non lette ({e})")
            continue
        if len(en) != len(it) or not en:
            # le due lingue non si allineano (es. una aggiornata prima dell'altra): si tengono i nomi precedenti
            problems.append(f"{ours}: abilità diverse tra inglese ({len(en)}) e italiano ({len(it)}), tengo i nomi precedenti")
            if prev_abilities.get(ours):
                abilities[ours] = prev_abilities[ours]
            continue
        abilities[ours] = dict(zip(en, it))
        # "Void Barrier (Omnic Form)" si trova anche come "Void Barrier"
        for x, y in zip(en, it):
            short = re.sub(r"\s*\([^)]*\)", "", x).strip()
            if short != x and short not in abilities[ours]:
                abilities[ours][short] = y
        # abilità della teoria che non hanno trovato il nome ufficiale (nome scritto diversamente nelle fonti)
        known = {key(x) for x in abilities[ours]}
        for ab in (theory.get(ours) or {}).get("abilities", []):
            if key(ab.get("name", "")) not in known:
                problems.append(f"{ours}: «{ab.get('name')}» della teoria non è tra le abilità ufficiali ({', '.join(en)})")
    missing = sorted(set(data_names.values()) - set(abilities))
    if missing:
        problems.append(f"senza nomi ufficiali: {', '.join(missing)}")

    maps = {}
    try:
        q = load(of("wiki_maps_langlinks.json"))["query"]
        alias = {}
        for kind in ("normalized", "redirects"):
            for x in q.get(kind, []):
                alias[x["to"]] = alias.get(x["from"], x["from"])
        for page in q.get("pages", {}).values():
            it = next((l.get("*") or l.get("title") for l in page.get("langlinks", []) if l.get("lang") == "it"), None)
            if it:
                en = page["title"]
                while en in alias and alias[en] != en:
                    en = alias.pop(en)
                maps[en] = it
        ours = {key(m["name"]): m["name"] for m in load(a.data)["maps"]}
        maps = {ours[key(en)]: it for en, it in maps.items() if key(en) in ours}
        missing_maps = sorted(set(ours.values()) - set(maps))
        if missing_maps:
            problems.append(f"mappe senza nome italiano: {', '.join(missing_maps)}")
    except (OSError, ValueError, KeyError) as e:
        problems.append(f"mappe non lette ({e})")

    # wiki italiana (piccola e del 2017, senza collegamenti): si accetta un nome solo se la sua pagina esiste lì.
    # Corrispondenze note dei nomi del gioco; le mappe nuove non ci sono e restano col nome di counterwatch.
    WIKI_IT = {"Ilios": "Ilio", "Lijiang Tower": "Torre di Lijiang", "Watchpoint: Gibraltar": "Osservatorio: Gibilterra",
               "Temple of Anubis": "Tempio di Anubi", "Volskaya Industries": "Industrie Volskaya"}
    # nomi usati da Blizzard nelle notizie ufficiali in italiano (verificati il 2026-10-06); le altre mappe sono nomi
    # propri e restano uguali nel gioco italiano (es. Neon Junction, Busan, Rialto, Suravasa)
    OFFICIAL_IT = {
        "Antarctic Peninsula": "Penisola Antartica",   # https://overwatch.blizzard.com/it-it/news/23912175
        "Shambali Monastery": "Monastero Shambali",    # https://overwatch.blizzard.com/it-it/news/23878812
    }
    try:
        for en, it in OFFICIAL_IT.items():
            if any(m["name"] == en for m in load(a.data)["maps"]):
                maps[en] = it
    except (OSError, ValueError, KeyError) as e:
        problems.append(f"elenco mappe non letto ({e})")
    try:
        pages = {x["title"] for x in load(of("wiki_it_allpages.json"))["query"]["allpages"]}
        ours = {m["name"] for m in load(a.data)["maps"]}
        for en, it in WIKI_IT.items():
            if en in ours and it in pages and en not in maps:
                maps[en] = it
    except (OSError, ValueError, KeyError) as e:
        problems.append(f"wiki italiana non letta ({e})")

    out = {
        "source": "OverFast API (overfast-api.tekrop.fr), dal sito ufficiale overwatch.blizzard.com (en-us / it-it)",
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "heroes": heroes,
        "maps": maps,
        "abilities": abilities,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    print(f"{a.out}: {len(heroes)} eroi, {len(maps)} mappe, {sum(len(v) for v in abilities.values())} abilità")
    for p in problems:
        print("  -", p)
    return 0 if abilities else 1


if __name__ == "__main__":
    sys.exit(main())

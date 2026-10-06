#!/usr/bin/env python3
"""Unisce in app/theory.json la ricerca "per eroe" sulle mappe (mappe buone/cattive di ogni eroe secondo le guide).

Ogni file di ricerca è un JSON {eroe: {good: [{map, why, side, source}], bad: [{map, why, source}],
mapTypes: {likes, dislikes, why, source} | null, sources: [...], notes}} (vedi CLAUDE.md, "Copertura delle guide").
Regole:
  - nomi degli eroi e delle mappe controllati sui dati (app/data.json); il ruolo viene dai dati;
  - good → _maps[slug].strong[ruolo], bad → _maps[slug].avoid (senza doppioni; si tiene la voce già presente);
  - eroe sia consigliato sia sconsigliato sulla stessa mappa (fonti in contrasto) → tolto da entrambe le liste;
  - mapTypes → mapFeatures dell'eroe (unione; una caratteristica sia amata sia odiata si toglie);
  - le fonti si aggiungono a sources dell'eroe.
Uso:  python3 tools/merge_map_research.py FILE.json [...] [--theory app/theory.json] [--data app/data.json] [--date AAAA-MM-GG]
"""
import argparse
import json
import sys
from datetime import date

VOCAB = {"env-kills", "long-sightlines", "close-quarters", "high-ground", "flank-routes", "open-spaces", "chokepoints"}
SIDES = {"attack", "defense"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--theory", default="app/theory.json")
    ap.add_argument("--data", default="app/data.json")
    ap.add_argument("--date", default=date.today().isoformat())
    a = ap.parse_args()

    with open(a.data, encoding="utf-8") as f:
        data = json.load(f)
    with open(a.theory, encoding="utf-8") as f:
        raw = f.read()
    theory = json.loads(raw)
    roles = {h["name"]: h["role"] for h in data["heroes"]}
    modes = {m["slug"]: m["mode"] for m in data["maps"]}
    maps = theory.setdefault("_maps", {})
    added = {"strong": 0, "avoid": 0, "features": 0, "sources": 0}
    skipped, conflicts = [], []

    for path in a.files:
        with open(path, encoding="utf-8") as f:
            res = json.load(f)
        for hero, r in res.items():
            if hero not in roles or not isinstance(r, dict):
                skipped.append(f"{path}: eroe sconosciuto {hero!r}")
                continue
            role = roles[hero]
            for g in r.get("good") or []:
                slug, why = g.get("map"), (g.get("why") or "").strip()
                if slug not in modes or not why:
                    skipped.append(f"{hero}: mappa {slug!r} o motivo mancante")
                    continue
                side = g.get("side") if g.get("side") in SIDES and modes[slug] in ("Escort", "Hybrid") else None
                lst = maps.setdefault(slug, {}).setdefault("strong", {}).setdefault(role, [])
                same = [x for x in lst if x.get("hero") == hero]
                if any(not x.get("side") or not side or x.get("side") == side for x in same):
                    continue
                lst.append({"hero": hero, "why": why, "side": side, "src": g.get("source") or None})
                added["strong"] += 1
            for b in r.get("bad") or []:
                slug, why = b.get("map"), (b.get("why") or "").strip()
                if slug not in modes or not why:
                    skipped.append(f"{hero}: mappa {slug!r} o motivo mancante")
                    continue
                lst = maps.setdefault(slug, {}).setdefault("avoid", [])
                if any(x.get("hero") == hero for x in lst):
                    continue
                lst.append({"hero": hero, "why": why, "src": b.get("source") or None})
                added["avoid"] += 1
            mt = r.get("mapTypes")
            if isinstance(mt, dict):
                e = theory.setdefault(hero, {})
                cur = e.get("mapFeatures") or {"likes": [], "dislikes": [], "why": None}
                likes = [x for x in dict.fromkeys((cur.get("likes") or []) + (mt.get("likes") or [])) if x in VOCAB]
                dislikes = [x for x in dict.fromkeys((cur.get("dislikes") or []) + (mt.get("dislikes") or [])) if x in VOCAB]
                both = set(likes) & set(dislikes)
                if both:
                    conflicts.append(f"{hero}: caratteristiche in contrasto tolte ({', '.join(sorted(both))})")
                new = {"likes": [x for x in likes if x not in both], "dislikes": [x for x in dislikes if x not in both],
                       "why": cur.get("why") or mt.get("why")}
                if new != {"likes": cur.get("likes") or [], "dislikes": cur.get("dislikes") or [], "why": cur.get("why")}:
                    e["mapFeatures"] = new
                    added["features"] += 1
            srcs = [s for s in (r.get("sources") or []) if isinstance(s, str) and s.startswith("http")]
            if srcs and isinstance(theory.get(hero), dict):
                cur = theory[hero].setdefault("sources", [])
                for s in srcs:
                    if s not in cur:
                        cur.append(s)
                        added["sources"] += 1

    # fonti in contrasto: consigliato e sconsigliato sulla stessa mappa → niente indicazione
    for slug, m in maps.items():
        if not isinstance(m, dict):
            continue
        strong = {x.get("hero") for lst in (m.get("strong") or {}).values() for x in lst}
        bad = {x.get("hero") for x in m.get("avoid") or []}
        for hero in sorted(strong & bad):
            conflicts.append(f"{slug}: {hero} consigliato e sconsigliato da fonti diverse → tolto da entrambe")
            for role, lst in (m.get("strong") or {}).items():
                m["strong"][role] = [x for x in lst if x.get("hero") != hero]
            m["avoid"] = [x for x in m.get("avoid") or [] if x.get("hero") != hero]

    theory["_heroMapsResearched"] = a.date
    with open(a.theory, "w", encoding="utf-8") as f:
        json.dump(theory, f, ensure_ascii=False, indent=1)
        if raw.endswith("\n"):
            f.write("\n")
    print(f"aggiunti: {added['strong']} consigliati, {added['avoid']} sconsigliati, {added['features']} caratteristiche, {added['sources']} fonti")
    for c in conflicts:
        print("  contrasto:", c)
    for s in skipped:
        print("  saltato:", s)
    return 0


if __name__ == "__main__":
    sys.exit(main())

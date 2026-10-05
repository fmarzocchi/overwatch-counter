#!/usr/bin/env python3
"""Scarica da counterwatch.gg i dati Overwatch (5v5) e li salva in app/data.json.

Robusto ai cambiamenti del sito:
- i dati vengono riconosciuti dalla loro FORMA (righe con eroe/avversario/win rate),
  non dal nome del campo o dalla posizione nella pagina;
- ogni sezione viene validata; se una sezione non passa si tiene quella dell'ultimo
  data.json buono (--prev) e lo si segnala in "problems";
- se non resta niente di usabile il file non viene scritto e lo script esce con 1.
Codici di uscita: 0 tutto ok, 2 dati salvati ma parziali, 1 nessun dato salvato.

Uso: python3 tools/fetch_data.py [--out PATH] [--prev PATH] [--from-dir DIR]
  --from-dir legge le pagine da file locali (per i test) invece che dalla rete.
"""
import argparse, datetime, json, pathlib, re, sys, time, urllib.request

BASES = ["https://counterwatch.gg/stats/overwatch", "https://www.counterwatch.gg/stats/overwatch"]
UA = {"User-Agent": "Mozilla/5.0 (personal counterpick helper)"}
ROOT = pathlib.Path(__file__).resolve().parent.parent
MIN_HEROES, MIN_MAPS = 35, 15


# ---------- lettura pagine ----------

class Source:
    def __init__(self, from_dir=None):
        self.from_dir = pathlib.Path(from_dir) if from_dir else None

    def html(self, path):
        if self.from_dir:
            f = self.from_dir / (path.strip("/").replace("/", "__") + ".html")
            return f.read_text(encoding="utf-8", errors="ignore") if f.exists() else ""
        last = None
        for base in BASES:
            for attempt in range(3):
                try:
                    req = urllib.request.Request(base + path, headers=UA)
                    return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "ignore")
                except Exception as e:  # rete, 5xx, ecc.
                    last = e
                    time.sleep(2 * (attempt + 1))
        print(f"  ! impossibile scaricare {path}: {last}", file=sys.stderr)
        return ""


def payload(html):
    """Testo dei dati incorporati nella pagina (flusso RSC di Next.js e JSON incorporati)."""
    out = []
    for c in re.findall(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)</script>', html, flags=re.S):
        try:
            out.append(json.loads('"' + c + '"'))
        except ValueError:
            pass
    out += re.findall(r'<script[^>]*type="application/(?:ld\+)?json"[^>]*>(.*?)</script>', html, flags=re.S)
    return "\n".join(out)


def norm(k):
    return re.sub(r"[^a-z]", "", k.lower())


def json_values(text, opener):
    """Tutti i valori JSON decodificabili che iniziano con `opener`."""
    dec = json.JSONDecoder()
    pos = 0
    while True:
        i = text.find(opener, pos)
        if i < 0:
            return
        try:
            val, end = dec.raw_decode(text, i)
            yield val
            pos = end if isinstance(val, list) else i + 1
        except ValueError:
            pos = i + 1


def row_lists(text):
    """Liste di oggetti, con chiavi normalizzate (hero_id, heroId → heroid)."""
    for val in json_values(text, '[{"'):
        if isinstance(val, list) and val and all(isinstance(r, dict) for r in val):
            yield [{norm(k): v for k, v in r.items()} for r in val]


def pick(row, *names):
    for n in names:
        if row.get(n) is not None:
            return row[n]
    return None


def win(row):
    v = pick(row, "shrunkwinrate", "winrate")
    if isinstance(v, (int, float)):
        return v / 100 if v > 1 else v
    return None


# ---------- estrazione per forma ----------

def extract_team_builder(text):
    heroes, counters, synergies, scores = {}, {}, {}, {}
    hid = lambda r: pick(r, "heroid", "hero")
    for rows in row_lists(text):
        keys = set(rows[0])
        has_win = any(win(r) is not None for r in rows[:5])
        if "opponentheroid" in keys and has_win:
            for r in rows:
                if win(r) is not None and r.get("opponentheroid") is not None:
                    counters.setdefault(str(hid(r)), {})[str(r["opponentheroid"])] = round(win(r), 4)
        elif {"opponentheroid", "counterscore"} <= keys:
            for r in rows:
                if r.get("opponentheroid") is not None and isinstance(r.get("counterscore"), (int, float)):
                    scores.setdefault(str(hid(r)), {})[str(r["opponentheroid"])] = r["counterscore"]
        elif "allyheroid" in keys and has_win:
            for r in rows:
                if win(r) is not None and r.get("allyheroid") is not None:
                    synergies.setdefault(str(hid(r)), {})[str(r["allyheroid"])] = round(win(r), 4)
        elif keys & {"rolename", "role"} and hid(rows[0]) is not None and len(rows) >= 20:
            for r in rows:
                if hid(r) is None:
                    continue
                h = heroes.setdefault(str(hid(r)), {"id": hid(r)})
                h["role"] = pick(r, "rolename", "role")
                raw = pick(r, "herorawname", "heroname", "name")
                if raw and "name" not in h:
                    h["name"] = str(raw).title()

    # schede eroe (nome visualizzato, icona, stile di gioco)
    for obj in json_values(text, '{"heroId":'):
        if isinstance(obj, dict) and "displayName" in obj:
            h = heroes.setdefault(str(obj["heroId"]), {"id": obj["heroId"]})
            h.update(name=obj["displayName"], slug=obj.get("canonicalId"),
                     img=obj.get("thumb") or obj.get("imageUrl"), style=obj.get("synergy"),
                     retired=bool(obj.get("retired")))
    heroes = {k: v for k, v in heroes.items() if v.get("role") and v.get("name") and not v.get("retired")}
    for h in heroes.values():
        h.pop("retired", None)
        if not h.get("slug"):
            h["slug"] = re.sub(r"[^a-z0-9]", "", h["name"].lower())
    return heroes, counters, synergies, scores


def extract_map_list(text):
    maps = {}
    for obj in json_values(text, '{"mapName":'):
        if isinstance(obj, dict) and obj.get("mapSlug"):
            maps[obj["mapSlug"]] = {"slug": obj["mapSlug"],
                                   "name": obj.get("cleanedMapName") or obj.get("mapName"),
                                   "mode": obj.get("gameModeName") or "?"}
    if not maps:  # ripiego: i link alle pagine delle mappe
        for slug in set(re.findall(r'/stats/overwatch/maps/([a-z0-9-]+)', text)):
            maps[slug] = {"slug": slug, "name": slug.replace("-", " ").title(), "mode": "?"}
    return maps


def extract_map_winrates(text):
    best = {}
    for rows in row_lists(text):
        if len(rows) >= 20 and all(pick(r, "heroid") is not None and win(r) is not None for r in rows[:5]):
            cand = {str(r["heroid"]): round(win(r), 4) for r in rows
                    if r.get("heroid") is not None and win(r) is not None}
            if len(cand) > len(best):
                best = cand
    return best


# ---------- validazione ----------

def coverage(matrix, ids):
    want = len(ids) * (len(ids) - 1)
    got = sum(1 for a in ids for b in ids if a != b and b in matrix.get(a, {}))
    return got / want if want else 0


def plausible(matrix):
    vals = [v for row in matrix.values() for v in row.values()]
    return bool(vals) and all(0.2 <= v <= 0.8 for v in vals)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "app" / "data.json"))
    ap.add_argument("--prev", help="ultimo data.json buono (default: --out se esiste)")
    ap.add_argument("--from-dir")
    args = ap.parse_args()
    out = pathlib.Path(args.out)
    prev_path = pathlib.Path(args.prev) if args.prev else out
    try:
        prev = json.loads(prev_path.read_text())
    except (OSError, ValueError):
        prev = {}
    src = Source(args.from_dir)
    status, problems = {}, []
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()

    def keep(section, ok, new, why):
        if ok:
            status[section] = now
            return new
        problems.append(f"{section}: {why}, tengo i dati precedenti")
        status[section] = (prev.get("status") or {}).get(section, "mai")
        return prev.get(section)

    tb_html = src.html("/team-builder")
    tb = payload(tb_html)
    heroes, counters, synergies, scores = extract_team_builder(tb)
    m = re.search(r'"dateModified":"([^"]+)"', tb_html)
    source_updated = m.group(1)[:19] + "Z" if m else prev.get("sourceUpdated")

    ok_heroes = len(heroes) >= MIN_HEROES and {"Tank", "Damage", "Support"} <= {h["role"] for h in heroes.values()}
    hero_list = keep("heroes", ok_heroes, sorted(heroes.values(), key=lambda h: (h["role"], h["name"])),
                     f"trovati {len(heroes)} eroi")
    if not hero_list:
        print("ERRORE: nessun elenco eroi valido, data.json non modificato", file=sys.stderr)
        sys.exit(1)
    ids = [str(h["id"]) for h in hero_list]
    idset = set(ids)
    trim = lambda mx: {a: {b: v for b, v in row.items() if b in idset and b != a}
                       for a, row in mx.items() if a in idset}
    counters, synergies, scores = trim(counters), trim(synergies), trim(scores)

    cc = coverage(counters, ids)
    counters = keep("counters", cc >= 0.9 and plausible(counters), counters, f"copertura {cc:.0%}")
    sc = coverage(synergies, ids)
    synergies = keep("synergies", sc >= 0.45 and plausible(synergies), synergies, f"copertura {sc:.0%}")
    if coverage(scores, ids) < 0.9:
        scores = prev.get("counterScores", {})

    map_meta = extract_map_list(payload(src.html("/maps")))
    prev_maps = {mp["slug"]: mp for mp in prev.get("maps") or []}
    maps = []
    for slug, meta in sorted(map_meta.items()):
        if not args.from_dir:
            time.sleep(1.0)
        wr = {k: v for k, v in extract_map_winrates(payload(src.html(f"/maps/{slug}"))).items() if k in idset}
        if len(wr) >= len(ids) * 0.8 and plausible({"x": wr}):
            maps.append({**meta, "winRates": wr})
        elif slug in prev_maps:
            maps.append(prev_maps[slug])
            problems.append(f"mappa {slug}: {len(wr)} eroi letti, tengo i dati precedenti")
        else:
            problems.append(f"mappa {slug}: {len(wr)} eroi letti, scartata")
    maps = keep("maps", len(maps) >= MIN_MAPS, maps, f"solo {len(maps)} mappe valide")

    if not (counters and maps):
        print("ERRORE: dati insufficienti, data.json non modificato\n  " + "\n  ".join(problems), file=sys.stderr)
        sys.exit(1)

    overall = {}
    for hid in ids:
        vals = [mp["winRates"][hid] for mp in maps if hid in mp["winRates"]]
        overall[hid] = round(sum(vals) / len(vals), 4) if vals else 0.5

    data = {
        "source": "counterwatch.gg", "checked": now, "sourceUpdated": source_updated,
        "status": status, "problems": problems,
        "heroes": hero_list, "overall": overall, "counters": counters,
        "synergies": synergies or {}, "counterScores": scores, "maps": maps,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print(f"OK: {len(hero_list)} eroi, counter {coverage(counters, ids):.0%}, {len(maps)} mappe, "
          f"fonte aggiornata {source_updated} → {out} ({out.stat().st_size // 1024} KB)")
    for p in problems:
        print("  ! " + p)
    sys.exit(2 if problems else 0)


if __name__ == "__main__":
    main()

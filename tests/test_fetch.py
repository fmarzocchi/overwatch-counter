#!/usr/bin/env python3
"""Collaudo dello scraper su copie locali delle pagine, anche "rotte" apposta.
Uso: python3 tests/test_fetch.py   (la prima volta scarica le pagine in tests/fixtures)"""
import json, pathlib, re, shutil, subprocess, sys, tempfile, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
BASE = "https://counterwatch.gg/stats/overwatch"
SCRIPT = ROOT / "tools" / "fetch_data.py"

def get(path):
    f = FIX / (path.strip("/").replace("/", "__") + ".html")
    if not f.exists():
        req = urllib.request.Request(BASE + path, headers={"User-Agent": "Mozilla/5.0"})
        f.write_bytes(urllib.request.urlopen(req, timeout=30).read()); time.sleep(1)
    return f.read_text(encoding="utf-8", errors="ignore")

def ensure_fixtures():
    archive = FIX.parent / "fixtures.tar.gz"  # copia salvata il 2026-10-05, versionata in git
    if not FIX.exists() and archive.exists():
        import tarfile
        with tarfile.open(archive) as t:
            t.extractall(FIX.parent)
    FIX.mkdir(parents=True, exist_ok=True)
    get("/team-builder")
    for slug in set(re.findall(r'"mapSlug\\?":\\?"([a-z0-9-]+)', get("/maps"))):
        get(f"/maps/{slug}")

def run(fix_dir, out, prev=None):
    cmd = [sys.executable, str(SCRIPT), "--from-dir", str(fix_dir), "--out", str(out)]
    if prev: cmd += ["--prev", str(prev)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr

def mutated(tmp, name, fn):
    d = tmp / name
    shutil.copytree(FIX, d)
    fn(d)
    return d

def edit(d, page, f):
    p = d / page
    p.write_text(f(p.read_text(encoding="utf-8", errors="ignore")), encoding="utf-8")

results = []
def check(name, cond, info=""):
    results.append(cond)
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"\n     {info[-600:]}"))

ensure_fixtures()
tmp = pathlib.Path(tempfile.mkdtemp())
good = tmp / "good.json"

# 1. pagine reali
code, log = run(FIX, good)
d = json.loads(good.read_text()) if good.exists() else {}
check("pagine reali: esce 0", code == 0, log)
check("pagine reali: >= 45 eroi, 3 ruoli", len(d.get("heroes", [])) >= 45 and
      {h["role"] for h in d["heroes"]} == {"Tank", "Damage", "Support"}, log)
check("pagine reali: >= 25 mappe con modo", len(d.get("maps", [])) >= 25 and
      all(m["mode"] != "?" for m in d["maps"]), log)
ids = [str(h["id"]) for h in d.get("heroes", [])]
check("pagine reali: matrice counter completa",
      all(len(d["counters"].get(a, {})) == len(ids) - 1 for a in ids), log)

# 2. il sito rinomina i campi (snake_case -> camelCase) e cambia l'ordine
def rename(t):
    for a, b in [("hero_id", "heroId"), ("opponent_hero_id", "opponentHeroId"), ("ally_hero_id", "allyHeroId"),
                 ("shrunk_win_rate", "shrunkWinRate"), ("win_rate", "winRate"), ("role_name", "roleName"),
                 ("counterScoreRows", "scoreRows"), ("heroList", "roster"), ("synergies", "pairs"), ("counters", "matchups")]:
        t = t.replace(f'\\"{a}\\"', f'\\"{b}\\"')
    return t
dr = mutated(tmp, "renamed", lambda d_: edit(d_, "team-builder.html", rename))
code, log = run(dr, tmp / "renamed.json")
r = json.loads((tmp / "renamed.json").read_text()) if (tmp / "renamed.json").exists() else {}
check("campi rinominati: dati identici", code == 0 and r.get("counters") == d.get("counters")
      and r.get("synergies") == d.get("synergies"), log)

# 3. win rate in percentuale (51.3 invece di 0.513)
def pct(t):
    return re.sub(r'(\\"(?:shrunk_win_rate|win_rate)\\":)(0\.\d+)', lambda m: m.group(1) + str(round(float(m.group(2)) * 100, 4)), t)
dp = mutated(tmp, "percent", lambda d_: edit(d_, "team-builder.html", pct))
code, log = run(dp, tmp / "pct.json")
p = json.loads((tmp / "pct.json").read_text()) if (tmp / "pct.json").exists() else {}
same = all(abs(p["counters"][a][b] - d["counters"][a][b]) < 1e-3 for a in d["counters"] for b in d["counters"][a]) if p else False
check("win rate in percentuale: convertiti", code == 0 and same, log)

# 4. team builder sparito: eroi/counter/sinergie dai dati precedenti, mappe nuove, esce 2
db = mutated(tmp, "notb", lambda d_: (d_ / "team-builder.html").write_text("<html>nuovo sito</html>"))
code, log = run(db, tmp / "notb.json", prev=good)
n = json.loads((tmp / "notb.json").read_text()) if (tmp / "notb.json").exists() else {}
check("team builder sparito: tiene i precedenti, mappe nuove", code == 2 and n.get("counters") == d.get("counters")
      and n.get("heroes") == d.get("heroes") and len(n.get("maps", [])) == len(d["maps"]), log)

# 4b. sito irriconoscibile e nessun dato precedente: esce 1 e non scrive niente
dx = mutated(tmp, "dead", lambda d_: [p.write_text("<html></html>") for p in d_.glob("*.html")])
code, log = run(dx, tmp / "dead.json", prev=tmp / "manca.json")
check("sito irriconoscibile: esce 1, nessun file", code == 1 and not (tmp / "dead.json").exists(), log)

# 5. matrice counter troncata a metà: usa la precedente, segnala, esce 2
def half(t):  # rompe la seconda metà delle righe counter
    i = t.find('opponent_hero_id'); j = t.find('ally_hero_id', i)
    k = (i + j) // 2
    return t[:k] + t[k:j].replace('opponent_hero_id', 'foe') + t[j:]
dh = mutated(tmp, "half", lambda d_: edit(d_, "team-builder.html", half))
code, log = run(dh, tmp / "half.json", prev=good)
h = json.loads((tmp / "half.json").read_text()) if (tmp / "half.json").exists() else {}
check("counter incompleti: tiene i precedenti ed esce 2", code == 2 and h.get("counters") == d.get("counters")
      and any("counters" in x for x in h.get("problems", [])), log)

# 6. una mappa rotta: quella mappa dai dati precedenti, le altre nuove
first = sorted(FIX.glob("maps__*.html"))[0]
dm = mutated(tmp, "onemap", lambda d_: (d_ / first.name).write_text("<html></html>"))
code, log = run(dm, tmp / "onemap.json", prev=good)
o = json.loads((tmp / "onemap.json").read_text()) if (tmp / "onemap.json").exists() else {}
check("una mappa rotta: tenuta dai dati precedenti", code == 2 and len(o.get("maps", [])) == len(d["maps"]), log)

# 7. valori assurdi (win rate 5%): rifiutati
dz = mutated(tmp, "absurd", lambda d_: edit(d_, "team-builder.html",
        lambda t: re.sub(r'(\\"shrunk_win_rate\\":)0\.\d+', r'\g<1>0.05', t)))
code, log = run(dz, tmp / "absurd.json", prev=good)
z = json.loads((tmp / "absurd.json").read_text()) if (tmp / "absurd.json").exists() else {}
check("valori assurdi: rifiutati", code == 2 and z.get("counters") == d.get("counters"), log)

# 8. filtro Ranked: il primo parametro che dà dati DIVERSI viene scelto, anche per le mappe
check("senza pagine Ranked: dati di tutte le partite, nessun problema",
      d.get("filter", {}).get("gameType") == "All" and not d.get("problems"), json.dumps(d.get("filter")))
Q = "type=Ranked"  # un candidato a metà elenco
def shift(t):  # dati "Ranked" finti: ogni win rate +0.01
    return re.sub(r'(\\"(?:shrunk_win_rate|win_rate|shrunkWinRate|winRate)\\":)(0\.\d+)', lambda m: m.group(1) + str(round(float(m.group(2)) + 0.01, 4)), t)
def ranked_pages(d_, transform):
    for f in list(d_.glob("*.html")):
        if f.name != "maps.html":
            (d_ / f.name.replace(".html", f"@{Q}.html")).write_text(transform(f.read_text(encoding="utf-8", errors="ignore")), encoding="utf-8")
drk = mutated(tmp, "ranked", lambda d_: ranked_pages(d_, shift))
code, log = run(drk, tmp / "ranked.json")
k = json.loads((tmp / "ranked.json").read_text()) if (tmp / "ranked.json").exists() else {}
a, b = ids[0], ids[1]
kr = next((m for m in k.get("maps", []) if m["slug"] == d["maps"][0]["slug"]), {})
check("filtro Ranked trovato: usato per counter e mappe", code == 0 and k.get("filter") == {"gameType": "Ranked", "query": Q}
      and abs(k["counters"][a][b] - d["counters"][a][b] - 0.01) < 1e-3
      and abs(kr["winRates"][a] - d["maps"][0]["winRates"][a] - 0.01) < 1e-3, log)

# 9. parametro ignorato dal sito (stessi dati): non va scambiato per Ranked
dig = mutated(tmp, "ignored", lambda d_: ranked_pages(d_, lambda t: t))
code, log = run(dig, tmp / "ignored.json")
g = json.loads((tmp / "ignored.json").read_text()) if (tmp / "ignored.json").exists() else {}
check("parametro ignorato: resta 'tutte le partite'", code == 0 and g.get("filter", {}).get("gameType") == "All", log)

# 10. filtro già noto che smette di funzionare: dati di tutte le partite, segnalato (esce 2)
code, log = run(FIX, tmp / "lost.json", prev=tmp / "ranked.json")
l = json.loads((tmp / "lost.json").read_text()) if (tmp / "lost.json").exists() else {}
check("filtro Ranked perso: segnalato", code == 2 and l.get("filter", {}).get("gameType") == "All"
      and any("Ranked" in x for x in l.get("problems", [])), log)

# 11. ricerca fallita da poco: non si riprova (niente richieste inutili)
code, log = run(drk, tmp / "skip.json", prev=good)
s = json.loads((tmp / "skip.json").read_text()) if (tmp / "skip.json").exists() else {}
check("ricerca fallita da < 24 h: non riprova", code == 0 and s.get("filter", {}).get("gameType") == "All", log)

shutil.rmtree(tmp)
print(f"\n{sum(results)}/{len(results)} test superati")
sys.exit(0 if all(results) else 1)

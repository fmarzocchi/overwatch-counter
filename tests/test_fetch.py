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

# 8. dati Ranked dal database del sito (copia reale in tests/fixtures_rest.tar.gz)
check("senza dati Ranked: tutte le partite, nessun problema",
      d.get("filter", {}).get("gameType") == "All" and not d.get("problems"), json.dumps(d.get("filter")))
REST = ROOT / "tests" / "fixtures_rest"
if not REST.exists():
    import tarfile
    with tarfile.open(ROOT / "tests" / "fixtures_rest.tar.gz") as t:
        t.extractall(REST.parent)
def with_ranked(d_, edit=lambda name, rows: rows):
    for name in ["counters", "synergies", "current"]:
        rows = json.loads((REST / f"ranked_{name}.json").read_text())
        (d_ / f"rest_ranked_{name}.json").write_text(json.dumps(edit(name, rows)))
shrink = lambda w, n: (w * n + 200) / (n + 400)
drk = mutated(tmp, "ranked", with_ranked)
code, log = run(drk, tmp / "ranked.json")
k = json.loads((tmp / "ranked.json").read_text()) if (tmp / "ranked.json").exists() else {}
row = next(r for r in json.loads((REST / "ranked_counters.json").read_text())
           if str(r["hero_id"]) in ids and str(r["opponent_hero_id"]) in ids and r["hero_id"] != r["opponent_hero_id"])
a, b = str(row["hero_id"]), str(row["opponent_hero_id"])
check("Ranked: counter dal database con la formula del sito", code == 0 and k.get("filter", {}).get("gameType") == "Ranked"
      and abs(k["counters"][a][b] - shrink(row["win_rate"], row["total_matches"])) < 1e-4
      and k["counters"] != d["counters"], log)
check("Ranked: tutte le mappe dai dati Ranked (anche con accenti)", len(k.get("maps", [])) == len(d["maps"])
      and "mapsAll" not in k.get("filter", {}) and all(m["winRates"] != dm["winRates"] for m, dm in zip(k["maps"], d["maps"])),
      json.dumps(k.get("filter")))

# 9. una mappa assente dai dati Ranked: solo quella dalla pagina (tutte le partite), annotata
first_map = d["maps"][0]
dmiss = mutated(tmp, "missmap", lambda d_: with_ranked(d_, lambda n, rows: [r for r in rows if n != "current"
        or re.sub(r"[^a-z]", "", r["map_name"].lower()) != re.sub(r"[^a-z]", "", first_map["name"].lower())]))
code, log = run(dmiss, tmp / "missmap.json")
mm = json.loads((tmp / "missmap.json").read_text()) if (tmp / "missmap.json").exists() else {}
check("Ranked senza una mappa: quella dalla pagina, le altre Ranked", code == 0
      and mm.get("filter", {}).get("mapsAll") == [first_map["slug"]] and len(mm.get("maps", [])) == len(d["maps"]), log)

# 10. dati Ranked troncati: rifiutati, tutte le partite; se prima era Ranked lo si segnala (esce 2)
dcut = mutated(tmp, "cut", lambda d_: with_ranked(d_, lambda n, rows: rows[:300] if n == "counters" else rows))
code, log = run(dcut, tmp / "cut.json", prev=tmp / "ranked.json")
c = json.loads((tmp / "cut.json").read_text()) if (tmp / "cut.json").exists() else {}
check("Ranked incompleti: tutte le partite, segnalato", code == 2 and c.get("filter", {}).get("gameType") == "All"
      and c.get("counters") == d.get("counters") and any("Ranked" in x for x in c.get("problems", [])), log)

# 11. database non raggiungibile (niente file): tutte le partite, segnalato perché prima era Ranked
code, log = run(FIX, tmp / "lost.json", prev=tmp / "ranked.json")
l = json.loads((tmp / "lost.json").read_text()) if (tmp / "lost.json").exists() else {}
check("Ranked non disponibili: segnalato", code == 2 and l.get("filter", {}).get("gameType") == "All"
      and any("Ranked" in x for x in l.get("problems", [])), log)

# 13. divisioni (rank): un file per divisione, Grandmaster+Champion uniti, riuso entro 12 ore
DIV_NAMES = ["Bronze", "Silver", "Gold", "Platinum", "Emerald", "Diamond", "Master", "Grandmaster", "Champion"]
def with_divisions(d_, shift=lambda name: 0.0, skip=()):
    with_ranked(d_)
    for dn in DIV_NAMES:
        if dn in skip:
            continue
        for name in ["counters", "synergies", "current"]:
            rows = json.loads((REST / f"ranked_{name}.json").read_text())
            rows = [{**r, "win_rate": min(0.95, r["win_rate"] + shift(dn))} for r in rows]
            (d_ / f"rest_ranked_{dn.lower()}_{name}.json").write_text(json.dumps(rows))
ddv = mutated(tmp, "div", lambda d_: with_divisions(d_, lambda dn: {"Gold": 0.05, "Grandmaster": 0.04, "Champion": 0.0}.get(dn, 0.0)))
code, log = run(ddv, tmp / "div" / "out.json")
v = json.loads((tmp / "div" / "out.json").read_text()) if (tmp / "div" / "out.json").exists() else {}
idx = v.get("divisions", {})
gold = json.loads((tmp / "div" / "divisions" / "gold.json").read_text()) if (tmp / "div" / "divisions" / "gold.json").exists() else {}
gm = json.loads((tmp / "div" / "divisions" / "gm.json").read_text()) if (tmp / "div" / "divisions" / "gm.json").exists() else {}
base = shrink(row["win_rate"], row["total_matches"])
check("divisioni: 8 file con counter, sinergie e mappe", code == 0 and len(idx) == 8
      and all(x.get("file") and not x.get("error") for x in idx.values()) and len(gold.get("maps", {})) == len(d["maps"]), log)
check("divisione Oro: dati suoi (diversi dal Ranked generale)",
      abs(gold["counters"][a][b] - shrink(row["win_rate"] + 0.05, row["total_matches"])) < 1e-4, f"{gold.get('counters', {}).get(a, {}).get(b)} vs {base}")
check("Grandmaster+: Grandmaster e Champion uniti pesando le partite",
      abs(gm["counters"][a][b] - shrink(row["win_rate"] + 0.02, 2 * row["total_matches"])) < 1e-4, str(gm.get("counters", {}).get(a, {}).get(b)))

# riuso: con i file del giro prima (freschi) non si riscarica nulla, anche se ora il database non ha divisioni
dnodiv = mutated(tmp, "nodiv", with_ranked)
code, log = run(dnodiv, tmp / "nodiv" / "out.json", prev=tmp / "div" / "out.json")
cmd = [sys.executable, str(SCRIPT), "--from-dir", str(dnodiv), "--out", str(tmp / "nodiv" / "out.json"),
       "--prev", str(tmp / "div" / "out.json"), "--prev-divisions", str(tmp / "div" / "divisions")]
pr = subprocess.run(cmd, capture_output=True, text=True)
n2 = json.loads((tmp / "nodiv" / "out.json").read_text())
check("divisioni fresche (< 12 h): riusate senza scaricare", pr.returncode == 0
      and n2["divisions"]["gold"]["checked"] == idx["gold"]["checked"] and not n2["divisions"]["gold"].get("error"), pr.stdout + pr.stderr)
# senza file precedenti e senza dati: segnata come non disponibile, ma niente "problems"
dmiss2 = mutated(tmp, "missdiv", lambda d_: with_divisions(d_, skip=("Silver",)))
code, log = run(dmiss2, tmp / "missdiv" / "out.json")
m2 = json.loads((tmp / "missdiv" / "out.json").read_text()) if (tmp / "missdiv" / "out.json").exists() else {}
check("divisione non scaricabile: annotata, il resto funziona", code == 0 and m2["divisions"]["silver"].get("error")
      and m2["divisions"]["gold"].get("file") and not m2.get("problems"), log)

# 14. il sito sposta un eroe di ruolo (es. Sombra da Danni a Supporto): lo prendiamo dal sito
drole = mutated(tmp, "role", lambda d_: edit(d_, "team-builder.html", lambda t: t.replace(
    '\\"hero_raw_name\\":\\"SOMBRA\\",\\"role_name\\":\\"Damage\\"', '\\"hero_raw_name\\":\\"SOMBRA\\",\\"role_name\\":\\"Support\\"')))
code, log = run(drole, tmp / "role.json")
ro = json.loads((tmp / "role.json").read_text()) if (tmp / "role.json").exists() else {}
check("cambio di ruolo sul sito: Sombra diventa Supporto", code == 0
      and next((h["role"] for h in ro.get("heroes", []) if h["name"] == "Sombra"), None) == "Support", log)

# 15. controllo leggero ogni 30 minuti: aggiornamento completo solo se serve
import datetime as _dt
sys.path.insert(0, str(ROOT / "tools"))
import needs_update as nu
page = (FIX / "team-builder.html").read_text(encoding="utf-8", errors="ignore")
src_upd = nu.source_updated(page)
now_ = _dt.datetime(2026, 10, 5, 12, 0, tzinfo=_dt.timezone.utc)
iso = lambda minutes: (now_ - _dt.timedelta(minutes=minutes)).isoformat()
base = {"heroes": [1], "sourceUpdated": src_upd, "checked": iso(30)}
check("controllo leggero: nessun dato nuovo da 30 min → salta", nu.decide(base, page, now_, "schedule")[0] is False, str(nu.decide(base, page, now_, "schedule")))
check("controllo leggero: counterwatch ha dati nuovi → completo + divisioni",
      nu.decide({**base, "sourceUpdated": "2026-10-04T05:00:00Z"}, page, now_, "schedule")[:2] == (True, True))
check("controllo leggero: ultimo completo 3 h fa → completo", nu.decide({**base, "checked": iso(175)}, page, now_, "schedule")[:2] == (True, False))
check("controllo leggero: pulsante/push → sempre completo", nu.decide(base, page, now_, "workflow_dispatch")[0] is True
      and nu.decide(base, page, now_, "push")[0] is True)
check("controllo leggero: pagina non leggibile → salta fino ai 3 h, poi completo",
      nu.decide(base, "", now_, "schedule")[0] is False and nu.decide({**base, "checked": iso(200)}, "", now_, "schedule")[0] is True)
check("controllo leggero: senza dati precedenti → completo", nu.decide({}, page, now_, "schedule")[0] is True)
# --force-divisions: riscarica anche se i file sono freschi
pr = subprocess.run([sys.executable, str(SCRIPT), "--from-dir", str(ddv), "--out", str(tmp / "div" / "out2.json"),
                     "--prev-divisions", str(tmp / "div" / "divisions"), "--force-divisions"], capture_output=True, text=True)
f2 = json.loads((tmp / "div" / "out2.json").read_text()) if (tmp / "div" / "out2.json").exists() else {}
check("dati nuovi: divisioni riscaricate anche se fresche", pr.returncode == 0
      and f2.get("divisions", {}).get("gold", {}).get("checked") != idx["gold"]["checked"], pr.stdout + pr.stderr)

# 16. note patch Blizzard: data e eroi della patch più recente (per capire quando la teoria è vecchia)
import check_patches as cp
fake = """<html><body><div class="PatchNotes-patch"><h3>Overwatch Retail Patch Notes &ndash; October 14, 2026</h3>
<p>Hero Updates</p><h4>Sombra</h4><p>Hack cooldown reduced.</p><h4>Junker Queen</h4><p>Rampage changes.</p>
<p>Soldier: 76 sprint speed.</p></div><div class="PatchNotes-patch"><h3>Overwatch Retail Patch Notes &ndash; September 30, 2026</h3>
<h4>Ana</h4><p>Sleep Dart.</p></div><script>var x = "Mercy";</script></body></html>"""
lp = cp.latest_patch(fake, [h["name"] for h in d["heroes"]])
check("note patch: data e solo gli eroi dell'ultima patch", lp == {"date": "2026-10-14", "heroes": ["Junker Queen", "Soldier: 76", "Sombra"]}, str(lp))
check("note patch: pagina irriconoscibile → nessun dato (si tengono i precedenti)", cp.latest_patch("<html>niente</html>", ["Ana"]) is None)

# 12. chiave e indirizzo letti dal JS del sito (mai scritti nel codice)
sys.path.insert(0, str(ROOT / "tools"))
import fetch_data as fd
js = 'e.s(["supabasePublishableKey",0,"local"===a?"eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiIsImV4cCI6MX0.abcdefghijk":"sb_publishable_TEST-key_1","supabaseUrl",0,"local"===a?"http://127.0.0.1:8000":"https://abcdef.supabase.co"])'
conn = fd.extract_supabase(js)
check("chiave e indirizzo dal JS del sito", conn and conn[0] == "https://abcdef.supabase.co"
      and conn[1][0] == "sb_publishable_TEST-key_1" and fd.extract_supabase("niente qui") is None, repr(conn))

# 17. ruoli ufficiali (Blizzard) sopra quelli di counterwatch: Stagione 5, Sombra Supporto mentre counterwatch la
# tiene nei Danni; eroe ufficiale non ancora su counterwatch (Doctrine) solo annotato
official = [{"key": h["slug"], "name": h["name"], "role": h["role"].lower()} for h in d["heroes"]]
official = [{**o, "role": "support"} if o["name"] == "Sombra" else o for o in official]
official.append({"key": "doctrine", "name": "Doctrine", "role": "support"})
dof = mutated(tmp, "official", lambda d_: (d_ / "official_heroes.json").write_text(json.dumps(official)))
code, log = run(dof, tmp / "official.json")
of = json.loads((tmp / "official.json").read_text()) if (tmp / "official.json").exists() else {}
check("ruolo ufficiale: Sombra Supporto anche se counterwatch dice Danni", code == 0
      and next((h["role"] for h in of.get("heroes", []) if h["name"] == "Sombra"), None) == "Support"
      and of.get("roleFix") == [{"name": "Sombra", "from": "Damage", "to": "Support"}] and "Sombra" in log and "Support" in log, log)
check("ruolo ufficiale: eroe nuovo non ancora su counterwatch annotato, non aggiunto", of.get("officialOnly") == ["Doctrine"]
      and not any(h["name"] == "Doctrine" for h in of.get("heroes", [])), str(of.get("officialOnly")))
# fonte ufficiale muta: si riapplica la correzione precedente finché counterwatch non cambia
code, log = run(FIX, tmp / "official2.json", prev=tmp / "official.json")
o2 = json.loads((tmp / "official2.json").read_text()) if (tmp / "official2.json").exists() else {}
check("ruolo ufficiale: fonte muta → correzione precedente riapplicata", code == 0
      and next((h["role"] for h in o2.get("heroes", []) if h["name"] == "Sombra"), None) == "Support"
      and o2.get("roleFix") == of.get("roleFix"), log)
# counterwatch si aggiorna (Sombra già Supporto): nessuna correzione
code, log = run(drole, tmp / "official3.json", prev=tmp / "official.json")
o3 = json.loads((tmp / "official3.json").read_text()) if (tmp / "official3.json").exists() else {}
check("ruolo ufficiale: counterwatch aggiornato → nessuna correzione", code == 0 and o3.get("roleFix") == []
      and next((h["role"] for h in o3.get("heroes", []) if h["name"] == "Sombra"), None) == "Support", log)
# pagina Blizzard (ripiego): ruolo e chiave dalle schede degli eroi; elenco troppo corto = non riconosciuto
cards = "".join(f'<a class="hero-card" data-role="{o["role"]}" data-subrole="x" href="/heroes/{o["key"]}" id="{o["key"]}"><b>{o["name"]}</b></a>' for o in official)
po = fd.parse_official("html", cards)
check("ruoli ufficiali dalla pagina Blizzard (schede eroe)", len(po) == len(official)
      and any("sombra" in k and r == "Support" for k, _, r in po) and fd.parse_official("html", cards[:400]) == [], str(po[:3]))
check("ruoli ufficiali: nomi confrontati senza accenti e simboli", fd.name_key("Soldier: 76") == fd.name_key("soldier-76")
      and fd.name_key("Lúcio") == "lucio" and fd.name_key("D.Va") == fd.name_key("dva") and fd.name_key("Torbjörn") == "torbjorn")

shutil.rmtree(tmp)
print(f"\n{sum(results)}/{len(results)} test superati")
sys.exit(0 if all(results) else 1)

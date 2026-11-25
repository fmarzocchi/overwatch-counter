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
    results.append(bool(cond))
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

# 15b. dopo un giro completo fallito si aspettano le ~3 ore (niente giri completi a ogni controllo leggero)
def ticks(prev, page_, sha=None, deployed=None, failed=False, n=6, fail=True):
    """Controlli ogni 30 min; ogni giro completo fallisce (fail) e il data.json ripubblicato annota il tentativo."""
    out = []
    for k in range(n):
        t_ = now_ + _dt.timedelta(minutes=30 * k)
        run_, force_, _, scrape_ = nu.decide(prev, page_, t_, "schedule", deployed, sha, failed)
        out.append((run_, scrape_, force_))
        if scrape_ and fail:
            prev = {**prev, "attempt": {"at": t_.isoformat(), "sourceUpdated": nu.source_updated(page_)}}
    return out
old = {**base, "sourceUpdated": "2026-10-04T05:00:00Z"}
storm = ticks(old, page)
check("tentativo fallito con dati nuovi: un giro completo, poi si aspettano le 3 ore",
      [s for _, s, _ in storm] == [True, False, False, False, False, False] and storm[0][2] is True, str(storm))
storm2 = ticks({**base, "checked": iso(240)}, "")
check("tentativo fallito, pagina non letta: un giro completo, poi si aspettano le 3 ore",
      [s for _, s, _ in storm2] == [True, False, False, False, False, False], str(storm2))
after3h = nu.decide({**old, "attempt": {"at": iso(175), "sourceUpdated": src_upd}}, page, now_, "schedule")
check("tentativo fallito più di 3 h fa: si riprova (con le divisioni)", after3h[0] and after3h[3] and after3h[1], str(after3h))
newer = nu.decide({**old, "attempt": {"at": iso(30), "sourceUpdated": "2026-10-04T23:00:00Z"}}, page, now_, "schedule")
check("dati ancora più nuovi dopo il tentativo: si riprova subito", newer[3] is True, str(newer))
# 15c. sito pubblicato da un'altra versione (push annullato): si ripubblica senza scaricare
rep = nu.decide(base, page, now_, "schedule", "a" * 40, "b" * 40, False)
check("versione pubblicata diversa: ripubblica senza scaricare", rep[0] is True and rep[3] is False, str(rep))
check("versione pubblicata diversa ma già fallita, o uguale, o sconosciuta: niente",
      not nu.decide(base, page, now_, "schedule", "a" * 40, "b" * 40, True)[0]
      and not nu.decide(base, page, now_, "schedule", "b" * 40, "b" * 40, False)[0]
      and not nu.decide(base, page, now_, "schedule", "", "b" * 40, False)[0])
mtmp = tmp / "mark.json"
mtmp.write_text(json.dumps({"heroes": [1], "checked": iso(240)}))
nu.mark_attempt(mtmp, src_upd, now_)
check("tentativo annotato nel data.json ripubblicato", json.loads(mtmp.read_text()).get("attempt") == {"at": now_.isoformat(), "sourceUpdated": src_upd})

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


# 18. molti eroi o mappe in meno dell'ultima volta (pagina incompleta): sezione rifiutata, si tengono i precedenti
def retire15(t_):
    return t_.replace('retired\\":false}', 'retired\\":true}', 15)
dhd = mutated(tmp, "herodrop", lambda d_: edit(d_, "team-builder.html", retire15))
code, log = run(dhd, tmp / "herodrop.json", prev=good)
code_hd = code
hd = json.loads((tmp / "herodrop.json").read_text()) if (tmp / "herodrop.json").exists() else {}
check("53 → 38 eroi: elenco precedente, segnalato (esce 2)", code == 2 and len(hd.get("heroes", [])) == len(d["heroes"])
      and any(x.startswith("heroes:") for x in hd.get("problems", [])), log)
def drop_maps(t_):
    for s in [m["slug"] for m in d["maps"][:5]]:
        t_ = t_.replace(f'\\"mapSlug\\":\\"{s}\\"', '\\"mapSlug\\":\\"\\"')
    return t_
dmd = mutated(tmp, "mapdrop", lambda d_: edit(d_, "maps.html", drop_maps))
code, log = run(dmd, tmp / "mapdrop.json", prev=good)
md = json.loads((tmp / "mapdrop.json").read_text()) if (tmp / "mapdrop.json").exists() else {}
check("30 → 25 mappe: mappe precedenti, segnalato (esce 2)", code == 2 and len(md.get("maps", [])) == len(d["maps"])
      and any(x.startswith("maps:") for x in md.get("problems", [])), log)

down = tmp / "down"  # cartella vuota = sito e database giù (anche per il test 19)
down.mkdir(exist_ok=True)
# 18b. lo STESSO elenco ridotto per 24 ore di fila è un cambio vero (mappe di stagione, eroi ritirati): accettato
def aged_drop(src_json, name, hours):
    body = json.loads(src_json.read_text())
    for mark in (body.get("drops") or {}).values():
        mark["since"] = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(hours=hours)).replace(microsecond=0).isoformat()
    (tmp / name).write_text(json.dumps(body))
    return tmp / name
since_of = lambda path: (json.loads(path.read_text()).get("drops") or {}).get("heroes", {}).get("since", "?")
hmark = hd.get("drops", {}).get("heroes", {})
check("calo di eroi visto la prima volta: rifiutato e annotato", code_hd == 2 and hmark.get("count") == 38
      and hmark.get("sig") and abs((_dt.datetime.now(_dt.timezone.utc) - fd.parse_time(hmark["since"])).total_seconds()) < 600,
      json.dumps(hd.get("drops")))
p23 = aged_drop(tmp / "herodrop.json", "hd23.json", 23)
code, log = run(dhd, tmp / "hd23out.json", prev=p23)
h23 = json.loads((tmp / "hd23out.json").read_text()) if (tmp / "hd23out.json").exists() else {}
check("stesso calo da 23 h: ancora rifiutato, «since» invariato", code == 2 and len(h23.get("heroes", [])) == len(d["heroes"])
      and h23.get("drops", {}).get("heroes", {}).get("since") == since_of(p23), log)
p25 = aged_drop(tmp / "herodrop.json", "hd25.json", 25)
code, log = run(dhd, tmp / "hd25out.json", prev=p25)
h25 = json.loads((tmp / "hd25out.json").read_text()) if (tmp / "hd25out.json").exists() else {}
check("stesso calo da 25 h: accettato (esce 0, 38 eroi, segno tolto)", code == 0 and len(h25.get("heroes", [])) == 38
      and "drops" not in h25 and not h25.get("problems"), log)
dhd16 = mutated(tmp, "herodrop16", lambda d_: edit(d_, "team-builder.html", lambda t_: t_.replace('retired\\":false}', 'retired\\":true}', 16)))
code, log = run(dhd16, tmp / "hd16out.json", prev=p25)
h16 = json.loads((tmp / "hd16out.json").read_text()) if (tmp / "hd16out.json").exists() else {}
m16 = h16.get("drops", {}).get("heroes", {})
check("calo cambiato (37 invece di 38): rifiutato, si ricomincia a contare", code == 2 and m16.get("count") == 37
      and m16.get("since") != since_of(p25), json.dumps(h16.get("drops")))
code, log = run(FIX, tmp / "hdback.json", prev=p23)
hb = json.loads((tmp / "hdback.json").read_text()) if (tmp / "hdback.json").exists() else {}
check("elenco tornato completo: accettato, segno tolto", code == 0 and len(hb.get("heroes", [])) == len(d["heroes"])
      and "drops" not in hb, log)
pr = subprocess.run([sys.executable, str(SCRIPT), "--from-dir", str(down), "--out", str(tmp / "hddown.json"), "--prev", str(p23)],
                    capture_output=True, text=True)
hdd = json.loads((tmp / "hddown.json").read_text()) if (tmp / "hddown.json").exists() else {}
check("sito giù durante il calo: il conteggio non si azzera", pr.returncode == 2
      and (hdd.get("drops") or {}).get("heroes", {}).get("since") == since_of(p23), pr.stdout + pr.stderr)
mmark = md.get("drops", {}).get("maps", {})
pm25 = aged_drop(tmp / "mapdrop.json", "md25.json", 25)
code, log = run(dmd, tmp / "md25out.json", prev=pm25)
m25 = json.loads((tmp / "md25out.json").read_text()) if (tmp / "md25out.json").exists() else {}
check("mappe: 25 invece di 30 di fila da 25 h (pool della stagione): accettate", mmark.get("count") == 25
      and code == 0 and len(m25.get("maps", [])) == 25 and "drops" not in m25, log)

# 19. sito e database giù: si tengono i dati Ranked precedenti con la loro etichetta e le divisioni
down = tmp / "down"
down.mkdir(exist_ok=True)
pr = subprocess.run([sys.executable, str(SCRIPT), "--from-dir", str(down), "--out", str(down / "out" / "data.json"),
                     "--prev", str(tmp / "div" / "out.json"), "--prev-divisions", str(tmp / "div" / "divisions")],
                    capture_output=True, text=True)
dw = json.loads((down / "out" / "data.json").read_text()) if (down / "out" / "data.json").exists() else {}
check("tutto giù: etichetta Ranked precedente, nessun «uso tutte le partite»", pr.returncode == 2
      and dw.get("filter", {}).get("gameType") == "Ranked" and dw.get("counters") == v.get("counters")
      and not any("uso tutte le partite" in x for x in dw.get("problems", [])), pr.stdout + pr.stderr)
check("tutto giù: divisioni precedenti ancora pubblicate", len(dw.get("divisions", {})) == 8
      and all((down / "out" / x["file"]).exists() for x in dw.get("divisions", {}).values() if x.get("file"))
      and all(x.get("file") for x in dw.get("divisions", {}).values()), json.dumps(dw.get("divisions")))
check("tutto giù: «checked» e «status» restano quelli di prima, il tentativo è annotato",
      dw.get("checked") == v.get("checked") and dw.get("status") == v.get("status")
      and dw.get("attempt", {}).get("at") and dw["attempt"]["at"] != v.get("checked"), json.dumps([dw.get("checked"), dw.get("status")]))

# 20. tutte le pagine mappa illeggibili: mappe precedenti, ma "status" delle mappe NON è "adesso"
dnm = mutated(tmp, "nomaps", lambda d_: [f.unlink() for f in d_.glob("maps__*.html")])
oldst = tmp / "oldstatus.json"
oldst.write_text(json.dumps({**d, "status": {k: "2026-01-01T00:00:00+00:00" for k in d["status"]}}))
code, log = run(dnm, tmp / "nomaps.json", prev=oldst)
nm = json.loads((tmp / "nomaps.json").read_text()) if (tmp / "nomaps.json").exists() else {}
check("mappe tutte dalla volta prima: status.maps resta quello di prima", code == 2
      and nm.get("status", {}).get("maps") == "2026-01-01T00:00:00+00:00" and nm.get("maps") == d["maps"]
      and nm.get("status", {}).get("counters") != "2026-01-01T00:00:00+00:00", json.dumps(nm.get("status")))

# 21. file di divisione riusati vecchi: oltre 48 h segnalati, oltre 7 giorni tolti
def aged_divisions(name, hours_by_key):
    dd = tmp / name
    shutil.copytree(tmp / "div" / "divisions", dd)
    for f in dd.glob("*.json"):
        body = json.loads(f.read_text())
        body["checked"] = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(hours=hours_by_key.get(f.stem, 1))).replace(microsecond=0).isoformat()
        f.write_text(json.dumps(body))
    return dd
old_div = aged_divisions("olddiv", {"gold": 72, "silver": 24 * 8})
pr = subprocess.run([sys.executable, str(SCRIPT), "--from-dir", str(dnodiv), "--out", str(tmp / "olddiv-out" / "data.json"),
                     "--prev", str(tmp / "div" / "out.json"), "--prev-divisions", str(old_div)], capture_output=True, text=True)
od = json.loads((tmp / "olddiv-out" / "data.json").read_text()) if (tmp / "olddiv-out" / "data.json").exists() else {}
odi = od.get("divisions", {})
check("divisione riusata con più di 48 h: segnalata (esce 2), ancora usata", pr.returncode == 2
      and odi.get("gold", {}).get("file") and any(x.startswith("divisione gold") for x in od.get("problems", [])), pr.stdout + pr.stderr)
check("divisione riusata con più di 7 giorni: tolta dall'indice", not odi.get("silver", {}).get("file")
      and odi.get("silver", {}).get("error") and odi.get("bronze", {}).get("file")
      and not any(x.startswith("divisione bronze") for x in od.get("problems", [])), json.dumps(odi.get("silver")))

# 22. correzione del ruolo ufficiale: resta anche dopo un giro con l'elenco eroi precedente e la fonte muta
dnr = mutated(tmp, "norole", lambda d_: edit(d_, "team-builder.html", lambda t_: t_.replace('\\"role_name\\"', '\\"xx_rn\\"')))
code, log = run(dnr, tmp / "rfB.json", prev=tmp / "official.json")
code2, log2 = run(FIX, tmp / "rfC.json", prev=tmp / "rfB.json")
rc_ = json.loads((tmp / "rfC.json").read_text()) if (tmp / "rfC.json").exists() else {}
check("ruolo ufficiale: correzione mantenuta dopo un giro con l'elenco eroi precedente", code == 2 and code2 == 0
      and next((h["role"] for h in rc_.get("heroes", []) if h["name"] == "Sombra"), None) == "Support"
      and rc_.get("roleFix") == of.get("roleFix"), log + log2)

# 23. database: ordine fisso delle righe (colonne selezionate) e niente troncamento silenzioso
order_ok = True
for name_, q in fd.RANKED_TABLES.items():
    sel = re.search(r"select=([^&]+)", q).group(1).split(",")
    order = re.search(r"order=([^&]+)", q)
    rows_ = json.loads((REST / f"ranked_{name_}.json").read_text())
    cols = [c.split(".")[0] for c in order.group(1).split(",")] if order else []
    order_ok &= bool(cols) and set(cols) <= set(sel) and set(cols) <= set(rows_[0]) \
        and len({tuple(r_[c] for c in cols) for r_ in rows_}) == len(rows_)
check("database: ordine fisso su colonne che identificano la riga", order_ok, str(fd.RANKED_TABLES))
class _Full:
    def read(self): return json.dumps([{"x": 1}] * 1000).encode()
_orig = (fd.urllib.request.urlopen, fd.time.sleep)
fd.urllib.request.urlopen, fd.time.sleep = (lambda *a, **k: _Full()), (lambda s: None)
try:
    fd.Source._rest_all("https://x", "k", "t?select=a")
    capped = False
except ValueError:
    capped = True
finally:
    fd.urllib.request.urlopen, fd.time.sleep = _orig
check("database: troppe pagine → errore, non dati troncati", capped)

# 24. file precedenti rovinati: ignorati (con una riga nel log), lo scraper non si ferma
broken = tmp / "broken"
broken.mkdir()
(broken / "prev.json").write_text("[]")
(broken / "pd").mkdir()
(broken / "pd" / "gold.json").write_text('{"checked": "2026-11-25T00:00:00"}')
(broken / "pd" / "silver.json").write_text("[1, 2]")
pr = subprocess.run([sys.executable, str(SCRIPT), "--from-dir", str(ddv), "--out", str(broken / "out.json"),
                     "--prev", str(broken / "prev.json"), "--prev-divisions", str(broken / "pd")], capture_output=True, text=True)
check("data.json e divisioni precedenti rovinati: ignorati, esce 0", pr.returncode == 0 and "ignorat" in pr.stderr
      and json.loads((broken / "out.json").read_text())["divisions"]["gold"].get("file"), pr.stdout + pr.stderr)

# 25. nomi italiani: file di un eroe mancanti → si tengono i nomi precedenti; risultato vuoto → file non toccato
bz = tmp / "bz"
bz.mkdir()
(bz / "overfast_en-us_heroes.json").write_text(json.dumps([{"key": "ana", "name": "Ana"}, {"key": "mercy", "name": "Mercy"}]))
(bz / "overfast_it-it_heroes.json").write_text(json.dumps([{"key": "ana", "name": "Ana"}, {"key": "mercy", "name": "Mercy"}]))
for loc, names in [("en-us", ["Caduceus Staff", "Guardian Angel"]), ("it-it", ["Bastone Caduceo", "Angelo Custode"])]:
    (bz / f"overfast_{loc}_hero_mercy.json").write_text(json.dumps({"abilities": [{"name": n} for n in names]}))
nit = tmp / "names_it.json"
prev_names = {"heroes": {}, "maps": {}, "abilities": {"Ana": {"Sleep Dart": "Dardo Soporifero"}}}
nit.write_text(json.dumps(prev_names))
NAMES = ROOT / "tools" / "names_it.py"
pr = subprocess.run([sys.executable, str(NAMES), str(bz), "--data", str(good), "--theory", str(ROOT / "app" / "theory.json"),
                     "--out", str(nit)], capture_output=True, text=True)
ni = json.loads(nit.read_text())
check("nomi italiani: abilità di un eroe non scaricate → nomi precedenti", pr.returncode == 0
      and ni["abilities"].get("Ana") == {"Sleep Dart": "Dardo Soporifero"} and ni["abilities"].get("Mercy", {}).get("Guardian Angel") == "Angelo Custode",
      pr.stdout + pr.stderr)
for f in bz.glob("overfast_*_hero_*.json"):
    f.unlink()
nit.write_text(json.dumps({"heroes": {}, "maps": {}, "abilities": {}}))
before_ = nit.read_text()
pr = subprocess.run([sys.executable, str(NAMES), str(bz), "--data", str(good), "--theory", str(ROOT / "app" / "theory.json"),
                     "--out", str(nit)], capture_output=True, text=True)
check("nomi italiani: nessuna abilità letta → file non sovrascritto, esce 1", pr.returncode == 1 and nit.read_text() == before_,
      pr.stdout + pr.stderr)

shutil.rmtree(tmp)
print(f"\n{sum(results)}/{len(results)} test superati")
sys.exit(0 if all(results) else 1)

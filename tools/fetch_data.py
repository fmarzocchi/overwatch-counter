#!/usr/bin/env python3
"""Scarica da counterwatch.gg i dati Overwatch (5v5) e li salva in app/data.json.

Robusto ai cambiamenti del sito:
- i dati vengono riconosciuti dalla loro FORMA (righe con eroe/avversario/win rate),
  non dal nome del campo o dalla posizione nella pagina;
- ogni sezione viene validata; se una sezione non passa si tiene quella dell'ultimo
  data.json buono (--prev) e lo si segnala in "problems";
- se non resta niente di usabile il file non viene scritto e lo script esce con 1.
Codici di uscita: 0 tutto ok, 2 dati salvati ma parziali, 1 nessun dato salvato.

Solo partite Ranked: le pagine del sito contengono i dati di tutte le partite; i dati Ranked il
sito li legge nel browser dal suo database pubblico (Supabase, sola lettura). Facciamo lo stesso:
indirizzo e chiave pubblica vengono letti A OGNI GIRO dal JavaScript del sito (mai salvati), poi
counter, sinergie e win rate per mappa Ranked vengono scaricati e corretti con la stessa formula
del sito (shrink). Se qualcosa non va si usano i dati di tutte le partite delle pagine; se prima
avevamo Ranked lo si segnala in "problems".

Uso: python3 tools/fetch_data.py [--out PATH] [--prev PATH] [--from-dir DIR]
  --from-dir legge le pagine da file locali (per i test) invece che dalla rete;
  i dati Ranked sono i file rest_ranked_{counters,synergies,current}.json.
"""
import argparse, datetime, hashlib, json, pathlib, re, sys, time, unicodedata, urllib.request

BASES = ["https://counterwatch.gg/stats/overwatch", "https://www.counterwatch.gg/stats/overwatch"]
UA = {"User-Agent": "Mozilla/5.0 (personal counterpick helper)"}
ROOT = pathlib.Path(__file__).resolve().parent.parent
MIN_HEROES, MIN_MAPS = 35, 15
SHRINK_PRIOR = 200  # formula del sito: (win_rate*partite + 200) / (partite + 400), cioè 400 partite al 50%
# Ordine fisso (order=): senza, le pagine da 1000 righe (offset) possono ripetere o saltare righe.
# Le colonne dell'ordine sono quelle selezionate e insieme identificano una riga (verificato su tests/fixtures_rest).
RANKED_TABLES = {  # tabella e colonne del database del sito (vedi il JS di counterwatch)
    "counters": "community_stats_counters_current?select=hero_id,opponent_hero_id,win_rate,total_matches"
                "&order=hero_id.asc,opponent_hero_id.asc",
    "synergies": "community_stats_synergies_current?select=hero_id,ally_hero_id,win_rate,total_matches"
                 "&order=hero_id.asc,ally_hero_id.asc",
    "current": "community_stats_current?select=hero_id,map_name,game_mode_name,win_rate,total_matches"
               "&order=hero_id.asc,map_name.asc,game_mode_name.asc",
}
RANKED_FILTER = "game=eq.Overwatch&stat_category=eq.5V5&game_type=eq.Ranked&division=eq.{division}"
# Dati per divisione (rank dei giocatori): file app/divisions/<chiave>.json, rinnovati ogni 12 ore.
# Grandmaster e Champion uniti come fa il sito ("Grandmaster+"): da soli hanno pochi dati.
DIVISIONS = [("bronze", ["Bronze"]), ("silver", ["Silver"]), ("gold", ["Gold"]), ("platinum", ["Platinum"]),
             ("emerald", ["Emerald"]), ("diamond", ["Diamond"]), ("master", ["Master"]),
             ("gm", ["Grandmaster", "Champion"])]
DIVISION_MAX_AGE_H = 12
DIVISION_WARN_AGE_H = 48        # file di divisione riusato più vecchio di così → "problems"
DIVISION_DROP_AGE_H = 7 * 24    # più vecchio di così → tolto dall'indice (l'app usa i dati generali e lo dice)
MAX_DROP = 3                    # eroi o mappe in meno rispetto all'ultima volta oltre cui la sezione è sospetta
DROP_ACCEPT_H = 24              # lo stesso elenco ridotto visto di fila per tanto così è la nuova realtà (es. mappe di stagione)


# ---------- ruoli ufficiali (Blizzard) ----------
# counterwatch può restare indietro quando un eroe cambia ruolo (Stagione 5: Sombra da Danni a Supporto).
# Il ruolo si prende dalla fonte ufficiale (OverFast = dati del sito Blizzard, poi la pagina Blizzard stessa);
# se nessuna risponde si tengono le correzioni dell'ultima volta. 1 richiesta per aggiornamento completo.
OFFICIAL_SOURCES = [("json", "https://overfast-api.tekrop.fr/heroes?locale=en-us"),
                    ("html", "https://overwatch.blizzard.com/en-us/heroes/")]
OFFICIAL_ROLE = {"tank": "Tank", "damage": "Damage", "support": "Support"}


def name_key(s):
    """'Soldier: 76' / 'soldier-76' → 'soldier76'; 'Lúcio' → 'lucio'; 'D.Va' / 'dva' → 'dva'."""
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]", "", s)


def parse_official(kind, text):
    """[(chiavi, nome, ruolo)] dalla risposta della fonte ufficiale ([] se non si riconosce)."""
    out = []
    if kind == "json":
        try:
            rows = json.loads(text)
        except ValueError:
            return []
        for r in rows if isinstance(rows, list) else []:
            role = OFFICIAL_ROLE.get(str(r.get("role", "")).lower())
            if role and (r.get("key") or r.get("name")):
                out.append(({name_key(r.get("key")), name_key(r.get("name"))} - {""}, r.get("name") or r["key"], role))
    else:
        for tag in re.findall(r'<a[^>]*class="hero-card"[^>]*>', text):
            role = re.search(r'data-role="([a-z]+)"', tag)
            slug = re.search(r'href="(?:/[a-z]{2}-[a-z]{2})?/heroes/([a-z0-9-]+)/?"', tag)
            if role and slug and OFFICIAL_ROLE.get(role.group(1)):
                out.append(({name_key(slug.group(1))}, slug.group(1), OFFICIAL_ROLE[role.group(1)]))
    return out if len(out) >= MIN_HEROES else []


def official_heroes(from_dir=None):
    """Elenco ufficiale [(chiavi, nome, ruolo)], o None se nessuna fonte risponde."""
    if from_dir:
        f = pathlib.Path(from_dir) / "official_heroes.json"
        return parse_official("json", f.read_text()) or None if f.exists() else None
    for kind, url in OFFICIAL_SOURCES:
        try:
            req = urllib.request.Request(url, headers=UA)
            got = parse_official(kind, urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "ignore"))
            if got:
                return got
        except Exception as e:
            print(f"  ! ruoli ufficiali da {url}: {e}", file=sys.stderr)
    return None


def apply_official_roles(hero_list, official, prev_fix, from_prev=False):
    """Corregge i ruoli di counterwatch con quelli ufficiali. Restituisce (correzioni, eroi solo ufficiali).
    from_prev: hero_list è l'elenco dell'ultima volta (già corretto)."""
    fixes, only = [], []
    if official is None:  # fonte ufficiale muta: si riapplicano le correzioni precedenti ancora valide
        for f in prev_fix or []:
            h = next((h for h in hero_list if h["name"] == f.get("name")), None)
            if h and (h["role"] == f.get("from") or (from_prev and h["role"] == f.get("to"))) \
                    and f.get("to") in OFFICIAL_ROLE.values():
                h["role"] = f["to"]  # nell'elenco precedente è già corretto: la correzione resta valida
                fixes.append(f)
        return fixes, only
    for h in hero_list:
        keys = {name_key(h["name"]), name_key(h.get("slug"))} - {""}
        o = next((o for o in official if o[0] & keys), None)
        if o and o[2] != h["role"]:
            fixes.append({"name": h["name"], "from": h["role"], "to": o[2]})
            h["role"] = o[2]
    known = set().union(*({name_key(h["name"]), name_key(h.get("slug"))} for h in hero_list))
    only = sorted(o[1] for o in official if not (o[0] & known))
    return fixes, only


# ---------- lettura pagine ----------

class Source:
    def __init__(self, from_dir=None):
        self.from_dir = pathlib.Path(from_dir) if from_dir else None
        self.conn = None  # (url, chiave) del database, letti dal JS del sito alla prima richiesta

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

    def ranked(self, tb_html, divisions=("All",)):
        """Righe Ranked {counters, synergies, current} dal database del sito (più divisioni = righe unite).
        Solleva un errore se non riesce."""
        if self.from_dir:
            out = {}
            for name in RANKED_TABLES:
                out[name] = []
                for d in divisions:
                    f = self.from_dir / (f"rest_ranked_{name}.json" if d == "All" else f"rest_ranked_{d.lower()}_{name}.json")
                    if not f.exists():
                        raise LookupError(f"manca {f.name}")
                    out[name] += json.loads(f.read_text())
            return out
        if not self.conn:
            self.conn = self._connect(tb_html)
        url, key = self.conn
        return {name: [r for d in divisions for r in self._rest_all(url, key, f"{q}&{RANKED_FILTER.format(division=d)}")]
                for name, q in RANKED_TABLES.items()}

    def _connect(self, tb_html):
        conn = None
        for c in sorted(set(re.findall(r'/_next/static/chunks/[^"\\ ]+?\.js', tb_html))):
            time.sleep(1.0)
            js = urllib.request.urlopen(urllib.request.Request(BASES[0].split("/stats")[0] + c, headers=UA),
                                        timeout=30).read().decode("utf-8", "ignore")
            conn = extract_supabase(js)
            if conn:
                break
        if not conn:
            raise LookupError("indirizzo/chiave del database non trovati nel JS del sito")
        url, keys = conn
        last = None
        for key in keys:  # la prima chiave che risponde (nel JS può esserci anche quella di sviluppo)
            try:
                self._rest_all(url, key, f"{RANKED_TABLES['synergies']}&{RANKED_FILTER.format(division='All')}", pages=1)
                return url, key
            except urllib.error.HTTPError as e:
                if e.code not in (401, 403):
                    raise
                last = e
        raise LookupError(f"nessuna chiave accettata dal database ({last})")

    @staticmethod
    def _rest_all(url, key, q, pages=99):
        rows, off = [], 0
        while True:
            time.sleep(1.0)
            req = urllib.request.Request(f"{url}/rest/v1/{q}&limit=1000&offset={off}",
                                         headers={**UA, "apikey": key, "Authorization": f"Bearer {key}"})
            page = json.loads(urllib.request.urlopen(req, timeout=30).read())
            if not isinstance(page, list):
                raise ValueError("risposta inattesa dal database")
            rows += page
            if len(page) < 1000 or len(rows) >= pages * 1000:
                return rows
            if off >= 20000:  # mai visto: meglio un errore chiaro che dati troncati in silenzio
                raise ValueError("troppe righe dal database (più di 21 pagine)")
            off += 1000


def extract_supabase(js):
    """(url, [chiavi pubbliche candidate]) dal JS del sito, oppure None."""
    url = re.search(r'https://[a-z0-9]+\.supabase\.co', js)
    keys = list(dict.fromkeys(re.findall(r'sb_publishable_[\w-]+', js)))
    keys += list(dict.fromkeys(re.findall(r'eyJ[\w-]{10,}\.[\w-]{20,}\.[\w-]{10,}', js)))
    return (url.group(0), keys) if url and keys else None


def shrink(win_rate, matches):
    return (win_rate * matches + SHRINK_PRIOR) / (matches + 2 * SHRINK_PRIOR)


def ranked_matrix(rows, other):
    """Righe {hero_id, <other>, win_rate, total_matches} → {eroe: {altro: win rate corretto}}.
    Righe ripetute per la stessa coppia (più divisioni) vengono unite pesando le partite."""
    acc = {}
    for r in rows:
        h, o, w, n = r.get("hero_id"), r.get(other), r.get("win_rate"), r.get("total_matches")
        if None in (h, o) or not isinstance(w, (int, float)) or not isinstance(n, (int, float)) or n < 0 or h == o:
            continue
        a = acc.setdefault(str(h), {}).setdefault(str(o), [0.0, 0.0])
        a[0] += w * n
        a[1] += n
    return {h: {o: round(shrink(s / n if n else 0.5, n), 4) for o, (s, n) in row.items()} for h, row in acc.items()}


def map_key(name):
    plain = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", plain.lower())


def ranked_maps(rows):
    """Righe eroe/mappa (anche più tratti per mappa) → {chiave mappa: {eroe: win rate corretto}}."""
    acc = {}
    for r in rows:
        h, m, w, n = r.get("hero_id"), r.get("map_name"), r.get("win_rate"), r.get("total_matches")
        if h is None or not m or not isinstance(w, (int, float)) or not isinstance(n, (int, float)) or n <= 0:
            continue
        a = acc.setdefault(map_key(m), {}).setdefault(str(h), [0.0, 0.0])
        a[0] += w * n
        a[1] += n
    return {m: {h: round(shrink(s / n, n), 4) for h, (s, n) in heroes.items()} for m, heroes in acc.items()}


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


def list_sig(keys):
    """Firma breve di un elenco (id eroi o slug mappe), indipendente dall'ordine."""
    return hashlib.sha1(",".join(sorted(map(str, keys))).encode()).hexdigest()[:12]


def parse_time(s):
    """ISO con fuso orario → datetime, altrimenti None."""
    try:
        t = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else None


def update_divisions(src, tb_html, out_dir, prev_dir, ids, idset, trim, map_meta, overall, now, force=False, download=True):
    """Scrive out_dir/<chiave>.json per ogni divisione; riusa i file precedenti se hanno meno di 12 ore
    (o se la divisione non si scarica; download=False: database non raggiungibile, solo riuso).
    Un file riusato con più di 48 ore va in "problems", con più di 7 giorni si toglie.
    Restituisce (indice {chiave: {checked, file} | {error}}, problemi)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    now_dt = datetime.datetime.fromisoformat(now)
    index, problems = {}, []
    for key, names in DIVISIONS:
        prev = None
        if prev_dir and (pathlib.Path(prev_dir) / f"{key}.json").exists():
            try:
                prev = json.loads((pathlib.Path(prev_dir) / f"{key}.json").read_text())
            except (OSError, ValueError):
                prev = None
            if not (isinstance(prev, dict) and parse_time(prev.get("checked"))):
                print(f"  ! divisione {key}: file precedente illeggibile, ignorato", file=sys.stderr)
                prev = None
        age = now_dt - parse_time(prev["checked"]) if prev else None
        fresh = prev and not force and age < datetime.timedelta(hours=DIVISION_MAX_AGE_H)
        body, why = (prev if fresh else None), ""
        if not body and not download:
            why, body = "database non raggiungibile", prev
        elif not body:
            try:
                rows = src.ranked(tb_html, names)
                c, sy = trim(ranked_matrix(rows["counters"], "opponent_hero_id")), trim(ranked_matrix(rows["synergies"], "ally_hero_id"))
                if not (coverage(c, ids) >= 0.8 and plausible(c) and coverage(sy, ids) >= 0.3 and plausible(sy)):
                    raise ValueError(f"dati incompleti (counter {coverage(c, ids):.0%})")
                rm = ranked_maps(rows["current"])
                maps = {}
                for slug, meta in map_meta.items():
                    wr = {h: v for h, v in (rm.get(map_key(meta["name"])) or rm.get(map_key(slug)) or {}).items() if h in idset}
                    if len(wr) >= len(ids) * 0.6 and plausible({"x": wr}):
                        maps[slug] = wr
                ov = {}
                for h in ids:
                    vals = [wr[h] for wr in maps.values() if h in wr]
                    ov[h] = round(sum(vals) / len(vals), 4) if vals else overall.get(h, 0.5)
                body = {"division": key, "names": names, "checked": now, "counters": c, "synergies": sy,
                        "overall": ov, "maps": maps}
            except Exception as e:
                why = str(e)[:120]
                body = prev  # meglio dati di qualche ora fa che niente
        if body is prev and prev and age > datetime.timedelta(hours=DIVISION_DROP_AGE_H):
            why, body = f"dati del {prev['checked'][:10]}, troppo vecchi ({why or 'non aggiornati'})", None
            problems.append(f"divisione {key}: {why}, tolta")
        elif body is prev and prev and age > datetime.timedelta(hours=DIVISION_WARN_AGE_H):
            problems.append(f"divisione {key}: dati del {prev['checked'][:10]} non aggiornati ({why or 'riusati'})")
        if body:
            (out_dir / f"{key}.json").write_text(json.dumps(body, ensure_ascii=False, separators=(",", ":")))
            index[key] = {"checked": body["checked"], "file": f"divisions/{key}.json", **({"error": why} if why else {})}
        else:
            index[key] = {"error": why or "non disponibile"}
            print(f"  ! divisione {key}: {why}", file=sys.stderr)
    return index, problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "app" / "data.json"))
    ap.add_argument("--prev", help="ultimo data.json buono (default: --out se esiste)")
    ap.add_argument("--from-dir")
    ap.add_argument("--prev-divisions", help="cartella con i file divisions/*.json pubblicati l'ultima volta")
    ap.add_argument("--force-divisions", action="store_true", help="riscarica le divisioni anche se fresche (dati nuovi)")
    args = ap.parse_args()
    out = pathlib.Path(args.out)
    prev_path = pathlib.Path(args.prev) if args.prev else out
    try:
        prev = json.loads(prev_path.read_text())
    except (OSError, ValueError):
        prev = {}
    if not isinstance(prev, dict):
        print(f"  ! {prev_path}: non è un data.json, ignorato", file=sys.stderr)
        prev = {}
    src = Source(args.from_dir)
    status, problems, fresh = {}, [], set()  # fresh: sezioni lette davvero in questo giro
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
    pause = (lambda: None) if args.from_dir else (lambda: time.sleep(1.0))

    def keep(section, ok, new, why):
        if ok:
            status[section] = now
            fresh.add(section)
            return new
        problems.append(f"{section}: {why}, tengo i dati precedenti")
        status[section] = (prev.get("status") or {}).get(section, "mai")
        return prev.get(section)

    tb_html = src.html("/team-builder")
    tb = payload(tb_html)
    heroes, counters, synergies, scores = extract_team_builder(tb)

    # Ranked dal database del sito; se non va si resta sui dati di tutte le partite delle pagine
    ranked, ranked_why = None, ""
    try:
        rows = src.ranked(tb_html)
        ranked = {"counters": ranked_matrix(rows["counters"], "opponent_hero_id"),
                  "synergies": ranked_matrix(rows["synergies"], "ally_hero_id"),
                  "maps": ranked_maps(rows["current"])}
    except Exception as e:  # rete, chiave cambiata, formato diverso…
        ranked_why = str(e)[:160]
    m = re.search(r'"dateModified":"([^"]+)"', tb_html)
    seen_updated = m.group(1)[:19] + "Z" if m else None
    source_updated = seen_updated or prev.get("sourceUpdated")

    # Calo sospetto: molti meno elementi dell'ultima volta (pagina incompleta?) → si tengono i precedenti.
    # Se però lo STESSO elenco ridotto torna di fila per 24 ore è un cambio vero (mappe tolte dalla stagione,
    # eroi ritirati): si accetta. "drops" in data.json ricorda da quando si vede {sezione: {since, sig, count}}.
    prev_drops = prev.get("drops") if isinstance(prev.get("drops"), dict) else {}
    drops, observed = {}, set()
    now_dt = datetime.datetime.fromisoformat(now)

    def dropped(section, keys, before):
        observed.add(section)
        n = len(keys)
        if not (before and (before - n > MAX_DROP or n < 0.9 * before)):
            return False
        sig, mark = list_sig(keys), prev_drops.get(section)
        since = mark.get("since") if isinstance(mark, dict) and mark.get("sig") == sig and parse_time(mark.get("since")) else now
        if now_dt - parse_time(since) >= datetime.timedelta(hours=DROP_ACCEPT_H):
            print(f"  {section}: {n} invece di {before} di fila dal {since[:16]}: accettato come nuovo elenco")
            return False
        drops[section] = {"since": since, "sig": sig, "count": n}
        return True

    def drop_note(section):
        d_ = drops.get(section)
        return f", calo visto dal {d_['since'][:16]} (accettato se resta uguale per {DROP_ACCEPT_H} h)" if d_ else ""

    n_prev_heroes = len(prev.get("heroes") or [])
    ok_heroes = (len(heroes) >= MIN_HEROES and {"Tank", "Damage", "Support"} <= {h["role"] for h in heroes.values()}
                 and not dropped("heroes", list(heroes), n_prev_heroes))
    hero_list = keep("heroes", ok_heroes, sorted(heroes.values(), key=lambda h: (h["role"], h["name"])),
                     f"trovati {len(heroes)} eroi" + (f" (prima {n_prev_heroes})" if n_prev_heroes else "") + drop_note("heroes"))
    if not hero_list:
        print("ERRORE: nessun elenco eroi valido, data.json non modificato", file=sys.stderr)
        sys.exit(1)
    # ruolo ufficiale sopra quello di counterwatch (Sombra Supporto dalla Stagione 5, finché counterwatch non si aggiorna)
    role_fix, official_only = apply_official_roles(hero_list, official_heroes(args.from_dir), prev.get("roleFix"),
                                                   from_prev=not ok_heroes)
    hero_list.sort(key=lambda h: (h["role"], h["name"]))
    ids = [str(h["id"]) for h in hero_list]
    idset = set(ids)
    trim = lambda mx: {a: {b: v for b, v in row.items() if b in idset and b != a}
                       for a, row in mx.items() if a in idset}
    counters, synergies, scores = trim(counters), trim(synergies), trim(scores)

    data_filter = {"gameType": "All"}
    if ranked:
        rc, rs = trim(ranked["counters"]), trim(ranked["synergies"])
        if coverage(rc, ids) >= 0.9 and plausible(rc) and coverage(rs, ids) >= 0.45 and plausible(rs):
            counters, synergies = rc, rs
            data_filter = {"gameType": "Ranked"}
        else:
            ranked_why = f"dati Ranked incompleti (counter {coverage(rc, ids):.0%}, sinergie {coverage(rs, ids):.0%})"
    prev_ranked = (prev.get("filter") or {}).get("gameType") == "Ranked"
    if data_filter["gameType"] != "Ranked":
        data_filter["why"] = ranked_why

    cc = coverage(counters, ids)
    counters_fresh = cc >= 0.9 and plausible(counters)
    counters = keep("counters", counters_fresh, counters, f"copertura {cc:.0%}")
    sc = coverage(synergies, ids)
    synergies = keep("synergies", sc >= 0.45 and plausible(synergies), synergies, f"copertura {sc:.0%}")
    if data_filter["gameType"] != "Ranked" and prev_ranked:
        problems.append(f"dati Ranked non disponibili ({ranked_why}): " +
                        ("uso tutte le partite" if counters_fresh else "tengo i dati Ranked precedenti"))
    if coverage(scores, ids) < 0.9:
        scores = prev.get("counterScores", {})

    map_meta = extract_map_list(payload(src.html("/maps")))
    prev_maps = {mp["slug"]: mp for mp in prev.get("maps") or []}
    maps, fresh_maps = [], 0
    ranked_maps_ok = data_filter["gameType"] == "Ranked"
    pages_used = []
    for slug, meta in sorted(map_meta.items()):
        wr = {}
        if ranked_maps_ok:
            wr = {k: v for k, v in (ranked["maps"].get(map_key(meta["name"])) or ranked["maps"].get(map_key(slug)) or {}).items()
                  if k in idset}
        if not (len(wr) >= len(ids) * 0.8 and plausible({"x": wr})):
            if ranked_maps_ok:
                pages_used.append(slug)  # mappa non trovata nei dati Ranked: pagina del sito (tutte le partite)
            pause()
            wr = {k: v for k, v in extract_map_winrates(payload(src.html(f"/maps/{slug}"))).items() if k in idset}
        if len(wr) >= len(ids) * 0.8 and plausible({"x": wr}):
            maps.append({**meta, "winRates": wr})
            fresh_maps += 1
        elif slug in prev_maps:
            maps.append(prev_maps[slug])
            problems.append(f"mappa {slug}: {len(wr)} eroi letti, tengo i dati precedenti")
        else:
            problems.append(f"mappa {slug}: {len(wr)} eroi letti, scartata")
    # sezione accettata se ci sono abbastanza mappe (anche riprese una per una dall'ultima volta) e non ne mancano
    # molte; "status" dice "adesso" solo se abbastanza mappe sono state lette davvero questa volta
    n_prev_maps = len(prev_maps)
    if len(maps) >= MIN_MAPS and not dropped("maps", [mp["slug"] for mp in maps], n_prev_maps):
        if fresh_maps >= MIN_MAPS:
            status["maps"] = now
            fresh.add("maps")
        else:
            status["maps"] = (prev.get("status") or {}).get("maps", "mai")
    else:
        maps = keep("maps", False, None, f"solo {len(maps)} mappe valide" + (f" (prima {n_prev_maps})" if n_prev_maps else "")
                    + drop_note("maps"))
    if pages_used:
        data_filter["mapsAll"] = pages_used
    if not counters_fresh and prev.get("filter"):
        data_filter = dict(prev["filter"])  # counter e sinergie sono quelli dell'ultima volta: stessa etichetta

    if not (counters and maps):
        print("ERRORE: dati insufficienti, data.json non modificato\n  " + "\n  ".join(problems), file=sys.stderr)
        sys.exit(1)

    overall = {}
    for hid in ids:
        vals = [mp["winRates"][hid] for mp in maps if hid in mp["winRates"]]
        overall[hid] = round(sum(vals) / len(vals), 4) if vals else 0.5

    divisions = {}
    if data_filter["gameType"] == "Ranked":  # Ranked di oggi, oppure quelli dell'ultima volta (sito o database giù)
        divisions, div_problems = update_divisions(src, tb_html, out.parent / "divisions", args.prev_divisions,
                                                   ids, idset, trim, map_meta, overall, now,
                                                   force=args.force_divisions, download=counters_fresh)
        problems += div_problems
    # "checked" = ultimo controllo riuscito: se nessuna sezione è stata letta adesso resta quello di prima;
    # "attempt" = ultimo tentativo (anche fallito), così il controllo leggero non riprova a ogni giro
    checked = now if fresh or not prev.get("checked") else prev["checked"]
    # sezione non letta in questo giro (sito giù, elenco illeggibile): il conteggio del calo non si azzera
    drops.update({s: m for s, m in prev_drops.items() if s not in observed and isinstance(m, dict)})

    data = {
        "divisions": divisions,
        "source": "counterwatch.gg", "checked": checked, "sourceUpdated": source_updated, "filter": data_filter,
        "attempt": {"at": now, "sourceUpdated": seen_updated},
        **({"drops": drops} if drops else {}),
        "status": status, "problems": problems,
        "heroes": hero_list, "overall": overall, "counters": counters,
        "synergies": synergies or {}, "counterScores": scores, "maps": maps,
        "roleFix": role_fix, "officialOnly": official_only,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print(f"OK [{data_filter['gameType']}]: {len(hero_list)} eroi, counter {coverage(counters, ids):.0%}, {len(maps)} mappe, "
          f"fonte aggiornata {source_updated} → {out} ({out.stat().st_size // 1024} KB)")
    # ruoli in chiaro nel log: un cambio di ruolo (es. Sombra Danni → Supporto) o un eroe nuovo si vede subito
    for role in ("Tank", "Damage", "Support"):
        print(f"  {role}: " + ", ".join(h["name"] for h in hero_list if h["role"] == role))
    print("  mappe: " + ", ".join(m["name"] for m in maps))
    for f in role_fix:
        print(f"  ruolo ufficiale: {f['name']} {f['from']} → {f['to']} (counterwatch non ancora aggiornato)")
    if official_only:
        print("  eroi ufficiali non ancora su counterwatch: " + ", ".join(official_only))
    if divisions:
        print("  divisioni: " + ", ".join(f"{k}{' (!)' if v.get('error') else ''}" for k, v in divisions.items()))
    for p in problems:
        print("  ! " + p)
    sys.exit(2 if problems else 0)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Ultima patch di Overwatch dalle note ufficiali Blizzard: data ed eroi citati → app/patches.json.

Serve a capire da soli quando la "teoria" (app/theory.json) di un eroe può essere vecchia: se un eroe compare
in una patch uscita dopo la ricerca, l'app lo segnala e il workflow apre una segnalazione su GitHub.
Se la pagina non si legge o cambia forma, si tengono i dati precedenti (non è un errore).
Uso: python3 tools/check_patches.py --out app/patches.json [--prev prev.json] [--from-file pagina.html]
Esce 0 sempre; scrive "new=true|false" e "heroes=..." in $GITHUB_OUTPUT se c'è una patch nuova.
"""
import argparse, datetime, html, json, os, pathlib, re, sys, urllib.request

URL = "https://overwatch.blizzard.com/en-us/news/patch-notes/"
ROOT = pathlib.Path(__file__).resolve().parent.parent
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]
DATE = re.compile(r"\b(" + "|".join(MONTHS) + r")\s+(\d{1,2}),\s+(\d{4})\b")


def text_of(page):
    page = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", page, flags=re.S | re.I)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", page)))


def latest_patch(page, hero_names):
    """{date: AAAA-MM-GG, heroes: [...]} della patch più recente (la prima data della pagina), o None."""
    t = text_of(page)
    dates = list(DATE.finditer(t))
    if not dates:
        return None
    first = dates[0]
    # la sezione della patch va dalla sua data alla data successiva diversa
    nxt = next((m for m in dates[1:] if m.group(0) != first.group(0)), None)
    section = t[first.start(): nxt.start() if nxt else len(t)]
    d = datetime.date(int(first.group(3)), MONTHS.index(first.group(1)) + 1, int(first.group(2)))
    heroes = sorted({n for n in hero_names if re.search(r"(?<![\w])" + re.escape(n) + r"(?![\w])", section)})
    return {"date": d.isoformat(), "heroes": heroes}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "app" / "patches.json"))
    ap.add_argument("--prev")
    ap.add_argument("--from-file")
    args = ap.parse_args()
    hero_names = [h["name"] for h in json.loads((ROOT / "app" / "data.json").read_text())["heroes"]]
    try:
        prev = json.loads(pathlib.Path(args.prev).read_text()) if args.prev else {}
    except (OSError, ValueError):
        prev = {}
    try:
        if args.from_file:
            page = pathlib.Path(args.from_file).read_text(encoding="utf-8", errors="ignore")
        else:
            req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0 (personal counterpick helper)"})
            page = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "ignore")
        latest = latest_patch(page, hero_names)
    except Exception as e:
        print(f"  ! note patch non lette: {e}", file=sys.stderr)
        latest = None
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
    out = {"checked": now, "latest": latest or prev.get("latest")}
    pathlib.Path(args.out).write_text(json.dumps(out, ensure_ascii=False))
    new = bool(latest and latest["date"] != (prev.get("latest") or {}).get("date"))
    print(f"patch: {out['latest']} {'(NUOVA)' if new else ''}")
    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a") as f:
            f.write(f"new={'true' if new else 'false'}\n")
            f.write(f"date={(latest or {}).get('date', '')}\n")
            f.write(f"heroes={', '.join((latest or {}).get('heroes', []))}\n")


if __name__ == "__main__":
    main()

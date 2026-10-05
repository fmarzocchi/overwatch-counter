#!/usr/bin/env python3
"""Controllo leggero (ogni 30 minuti): serve un aggiornamento completo dei dati?

Una sola richiesta a counterwatch (la pagina del team builder) per leggere quando il sito ha rigenerato
i dati. Aggiornamento completo se: avvio manuale o push; nessun dato precedente; counterwatch ha dati
nuovi (in quel caso si rinnovano anche le divisioni); l'ultimo controllo completo ha più di ~3 ore.
Scrive in $GITHUB_OUTPUT: run=true|false, force_divisions=true|false, reason=...

Uso: python3 tools/needs_update.py --prev prev.json --event <schedule|push|workflow_dispatch> [--from-dir DIR]
"""
import argparse, datetime, json, os, pathlib, re, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import fetch_data as fd  # noqa: E402

FULL_EVERY = datetime.timedelta(minutes=170)  # controllo completo comunque ogni ~3 ore


def source_updated(html):
    m = re.search(r'"dateModified":"([^"]+)"', html or "")
    return m.group(1)[:19] + "Z" if m else None


def decide(prev, page_html, now, event):
    """(run, force_divisions, reason)"""
    if event != "schedule":
        return True, False, f"avvio {event}"
    if not prev.get("heroes"):
        return True, False, "nessun dato precedente"
    site = source_updated(page_html)
    if site and site != prev.get("sourceUpdated"):
        return True, True, f"counterwatch ha dati nuovi ({prev.get('sourceUpdated')} → {site})"
    try:
        age = now - datetime.datetime.fromisoformat(prev["checked"].replace("Z", "+00:00"))
    except (KeyError, ValueError):
        return True, False, "data dell'ultimo controllo illeggibile"
    if age >= FULL_EVERY:
        return True, False, f"controllo periodico (ultimo {int(age.total_seconds() // 60)} min fa)"
    why = "pagina non letta" if not site else "nessun dato nuovo su counterwatch"
    return False, False, f"{why}, ultimo controllo {int(age.total_seconds() // 60)} min fa"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prev", required=True)
    ap.add_argument("--event", default="schedule")
    ap.add_argument("--from-dir")
    args = ap.parse_args()
    try:
        prev = json.loads(pathlib.Path(args.prev).read_text())
    except (OSError, ValueError):
        prev = {}
    html = fd.Source(args.from_dir).html("/team-builder") if args.event == "schedule" and prev.get("heroes") else ""
    now = datetime.datetime.now(datetime.timezone.utc)
    run, force, reason = decide(prev, html, now, args.event)
    print(("AGGIORNO: " if run else "SALTO: ") + reason)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"run={'true' if run else 'false'}\nforce_divisions={'true' if force else 'false'}\nreason={reason}\n")


if __name__ == "__main__":
    main()

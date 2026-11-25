#!/usr/bin/env python3
"""Controllo leggero (ogni 30 minuti): serve un aggiornamento completo dei dati?

Una sola richiesta a counterwatch (la pagina del team builder) per leggere quando il sito ha rigenerato
i dati. Aggiornamento completo se: avvio manuale o push; nessun dato precedente; counterwatch ha dati
nuovi (in quel caso si rinnovano anche le divisioni); l'ultimo controllo completo ha più di ~3 ore.
Dopo un tentativo fallito (data.json → "attempt") si aspettano comunque le ~3 ore, anche se counterwatch ha
dati nuovi: niente aggiornamenti completi a ogni giro mentre qualcosa non va.
Se il sito pubblicato viene da un'altra versione del repository (un push la cui pubblicazione è stata
annullata) si ripubblica la versione attuale con gli ultimi dati, senza scaricare da counterwatch.
Scrive in $GITHUB_OUTPUT: run=true|false, scrape=true|false, force_divisions=true|false, reason=..., site=...

Uso: python3 tools/needs_update.py --prev prev.json --event <schedule|push|workflow_dispatch> [--from-dir DIR]
         [--deployed-sha SHA --sha SHA [--sha-failed]]
     python3 tools/needs_update.py --mark-attempt app/data.json [--seen ISO]   (tentativo fallito: data.json ripubblicato)
"""
import argparse, datetime, json, os, pathlib, re, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import fetch_data as fd  # noqa: E402

FULL_EVERY = datetime.timedelta(minutes=170)  # controllo completo comunque ogni ~3 ore


def source_updated(html):
    m = re.search(r'"dateModified":"([^"]+)"', html or "")
    return m.group(1)[:19] + "Z" if m else None


def when(s):
    try:
        t = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else None


def decide(prev, page_html, now, event, deployed_sha=None, sha=None, sha_failed=False):
    """(run, force_divisions, reason, scrape): run = pubblicare, scrape = scaricare da counterwatch."""
    if event != "schedule":
        return True, False, f"avvio {event}", True
    if not prev.get("heroes"):
        return True, False, "nessun dato precedente", True
    site = source_updated(page_html)
    checked = when(prev.get("checked"))
    if not checked:
        return True, False, "data dell'ultimo controllo illeggibile", True
    attempt = prev.get("attempt") if isinstance(prev.get("attempt"), dict) else {}
    tried = when(attempt.get("at"))
    last = max(checked, tried) if tried else checked  # ultimo giro completo, riuscito o no
    age = now - last
    mins = int(age.total_seconds() // 60)
    if site and site != prev.get("sourceUpdated"):
        # dati nuovi già cercati dall'ultimo tentativo (fallito, o pagina non letta) da meno di ~3 ore: si aspetta
        if not (tried and now - tried < FULL_EVERY and attempt.get("sourceUpdated") in (site, None)):
            return True, True, f"counterwatch ha dati nuovi ({prev.get('sourceUpdated')} → {site})", True
    if age >= FULL_EVERY:
        return True, False, f"controllo periodico (ultimo {mins} min fa)", True
    if deployed_sha and sha and deployed_sha != sha and not sha_failed:
        return True, False, f"sito pubblicato da {deployed_sha[:7]}, ora {sha[:7]}: ripubblico gli ultimi dati", False
    why = "pagina non letta" if not site else "nessun dato nuovo su counterwatch"
    if site and site != prev.get("sourceUpdated"):
        why = "dati nuovi ma l'ultimo tentativo è fallito"
    return False, False, f"{why}, ultimo controllo {mins} min fa", False


def mark_attempt(path, seen, now):
    """data.json ripubblicato dopo un tentativo fallito: annota il tentativo (per non riprovare a ogni giro)."""
    p = pathlib.Path(path)
    data = json.loads(p.read_text())
    data["attempt"] = {"at": now.replace(microsecond=0).isoformat(), "sourceUpdated": seen or None}
    p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prev")
    ap.add_argument("--event", default="schedule")
    ap.add_argument("--from-dir")
    ap.add_argument("--deployed-sha", default="")
    ap.add_argument("--sha", default="")
    ap.add_argument("--sha-failed", action="store_true", help="una run per questa versione è già fallita")
    ap.add_argument("--mark-attempt", metavar="DATA_JSON")
    ap.add_argument("--seen", default="", help="dateModified letto dal controllo leggero")
    args = ap.parse_args()
    now = datetime.datetime.now(datetime.timezone.utc)
    if args.mark_attempt:
        mark_attempt(args.mark_attempt, args.seen, now)
        return
    if not args.prev:
        ap.error("--prev è obbligatorio")
    try:
        prev = json.loads(pathlib.Path(args.prev).read_text())
    except (OSError, ValueError):
        prev = {}
    if not isinstance(prev, dict):
        prev = {}
    html = fd.Source(args.from_dir).html("/team-builder") if args.event == "schedule" and prev.get("heroes") else ""
    run, force, reason, scrape = decide(prev, html, now, args.event, args.deployed_sha.strip(), args.sha.strip(),
                                        args.sha_failed)
    print(("AGGIORNO: " if scrape else "RIPUBBLICO: " if run else "SALTO: ") + reason)
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"run={'true' if run else 'false'}\nscrape={'true' if scrape else 'false'}\n"
                    f"force_divisions={'true' if force else 'false'}\nsite={''.join((source_updated(html) or '').split())}\n"
                    f"reason={' '.join(reason.split())}\n")


if __name__ == "__main__":
    main()

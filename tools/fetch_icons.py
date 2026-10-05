#!/usr/bin/env python3
"""Copia le icone degli eroi (URL "img" di data.json) in app/heroes/<slug>.webp.

Così l'app le carica dallo stesso sito (cache del service worker semplice, niente CORS).
Gira in GitHub Actions prima della pubblicazione; se un'icona non si scarica l'app usa
l'URL originale e poi le iniziali. Esce sempre 0: le icone non devono bloccare i dati.
"""
import json, pathlib, re, sys, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAX_BYTES = 400_000


def is_image(b):
    return (b[:4] == b"RIFF" and b[8:12] == b"WEBP") or b[:8] == b"\x89PNG\r\n\x1a\n" or b[:3] == b"\xff\xd8\xff"


def main():
    data = json.loads((ROOT / "app" / "data.json").read_text())
    out = ROOT / "app" / "heroes"
    out.mkdir(exist_ok=True)
    ok = bad = 0
    for h in data["heroes"]:
        slug, url = h.get("slug") or "", h.get("img") or ""
        if not re.fullmatch(r"[a-z0-9-]+", slug) or not url.startswith("https://"):
            bad += 1
            continue
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (personal counterpick helper)"})
            body = urllib.request.urlopen(req, timeout=20).read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES or not is_image(body):
                raise ValueError("non è un'immagine valida")
            (out / f"{slug}.webp").write_bytes(body)
            ok += 1
        except Exception as e:
            print(f"  ! {h.get('name')}: {e}", file=sys.stderr)
            bad += 1
        time.sleep(0.2)
    print(f"icone: {ok} scaricate, {bad} mancanti → {out}")


if __name__ == "__main__":
    main()

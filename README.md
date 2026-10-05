# Overwatch Counter

Consigli rapidi su quale eroe prendere in Overwatch 2 **in due** (pensato per giocare su Switch 2),
in base a mappa, ban, attacco/difesa, avversari e alleati. Dati **Ranked 5v5** di
[counterwatch.gg](https://counterwatch.gg), aggiornati ogni 3 ore.

App: https://fmarzocchi.github.io/overwatch-counter/ (da Chrome su Android: menu ⋮ → "Aggiungi a schermata Home").

- `app/` — l'app (PWA, HTML/CSS/JS senza build), pubblicata su GitHub Pages
- `tools/fetch_data.py` — scarica e valida i dati → `app/data.json`
- `tools/fetch_icons.py`, `tools/make_icons.py` — icone degli eroi e dell'app
- `tests/` — collaudo di scraper (`test_fetch.py`), logica (`*.test.js`) e app nel browser (`e2e.mjs`)
- `.github/workflows/` — `update-data.yml` (dati + pubblicazione), `ci.yml` (tutti i test)
- `CLAUDE.md` — stato del progetto e istruzioni complete per Claude

```bash
python3 tools/fetch_data.py          # aggiorna i dati a mano
python3 tests/test_fetch.py          # test dello scraper
node --test tests/*.test.js          # test della logica
node tests/e2e.mjs                   # test dell'app (serve il pacchetto playwright)
```

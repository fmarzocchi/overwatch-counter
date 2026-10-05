# Overwatch Counter

Consigli rapidi su quale eroe prendere in Overwatch 2 (pensato per giocare su Switch 2),
in base a mappa, avversari e squadra. Dati: [counterwatch.gg](https://counterwatch.gg).

- `tools/fetch_data.py` — scarica e valida i dati → `app/data.json`
- `tests/test_fetch.py` — collaudo dello scraper (anche con il sito "rotto")
- `app/` — l'app (PWA), pubblicata su GitHub Pages
- `CLAUDE.md` — stato del progetto e istruzioni complete per Claude

Aggiornare i dati a mano:

```bash
python3 tools/fetch_data.py
```

Lanciare i test:

```bash
python3 tests/test_fetch.py
```

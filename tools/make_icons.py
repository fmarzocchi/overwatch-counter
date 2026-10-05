#!/usr/bin/env python3
"""Genera app/icons/icon-192.png e icon-512.png (mirino arancione su fondo scuro) senza dipendenze."""
import math, pathlib, struct, zlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "app" / "icons"
BG, FG = (17, 20, 26), (249, 158, 26)


def pixel(x, y, n):
    c = n / 2
    d = math.hypot(x + 0.5 - c, y + 0.5 - c) / n
    on = 0.27 <= d <= 0.33 or d <= 0.06  # anello e punto centrale (dentro la zona sicura "maskable")
    on |= (abs(x + 0.5 - c) / n <= 0.025 or abs(y + 0.5 - c) / n <= 0.025) and 0.12 <= d <= 0.40  # croce
    return FG if on else BG


def png(n):
    raw = b"".join(b"\0" + bytes(v for x in range(n) for v in pixel(x, y, n)) for y in range(n))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for n in (192, 512):
        (OUT / f"icon-{n}.png").write_bytes(png(n))
        print(OUT / f"icon-{n}.png")

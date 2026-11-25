#!/usr/bin/env python3
"""Genera l'icona di Overwatch Counter (emblema originale, NON il logo di Overwatch) senza dipendenze:
anello arancione e due punte che si fronteggiano («contro»), su fondo scuro; tutto dentro il cerchio di sicurezza delle
icone «maskable» (l'anello arriva a 0,33 del lato, la zona sicura è 0,4). Stessa forma di scratchpad ux/v3/icon/icon.svg.

Scrive: app/icons/icon-192.png, icon-512.png (PWA) e il launcher Android
(android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png 144 px, mipmap-xxxhdpi/ic_launcher.png 192 px)."""
import pathlib, struct, zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
BG, RING, LEFT, RIGHT = (12, 17, 23), (249, 158, 26), (242, 245, 248), (249, 158, 26)
SS = 4  # campioni per lato di ogni pixel (bordi morbidi)

# forme in coordinate 0..1 (dall'SVG con viewBox 512: anello r 150 ± 20, punte (168,196)-(238,256)-(168,316) e speculare)
R_IN, R_OUT = 130 / 512, 170 / 512
LT = [(168 / 512, 196 / 512), (238 / 512, 256 / 512), (168 / 512, 316 / 512)]
RT = [(1 - x, y) for x, y in LT]


def inside(tri, x, y):
    (x1, y1), (x2, y2), (x3, y3) = tri
    d1 = (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2)
    d2 = (x - x3) * (y2 - y3) - (x2 - x3) * (y - y3)
    d3 = (x - x1) * (y3 - y1) - (x3 - x1) * (y - y1)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def color(x, y):
    d2 = (x - .5) ** 2 + (y - .5) ** 2
    if R_IN ** 2 <= d2 <= R_OUT ** 2:
        return RING
    if inside(LT, x, y):
        return LEFT
    if inside(RT, x, y):
        return RIGHT
    return BG


def pixel(px, py, n):
    acc = [0, 0, 0]
    for sy in range(SS):
        for sx in range(SS):
            c = color((px + (sx + .5) / SS) / n, (py + (sy + .5) / SS) / n)
            for k in range(3):
                acc[k] += c[k]
    return tuple(round(v / (SS * SS)) for v in acc)


def png(n):
    raw = b"".join(b"\0" + bytes(v for x in range(n) for v in pixel(x, y, n)) for y in range(n))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    res = ROOT / "android" / "app" / "src" / "main" / "res"
    for path, n in [(ROOT / "app" / "icons" / "icon-192.png", 192), (ROOT / "app" / "icons" / "icon-512.png", 512),
                    (res / "mipmap-xxhdpi" / "ic_launcher.png", 144), (res / "mipmap-xxxhdpi" / "ic_launcher.png", 192)]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(png(n))
        print(path)

#!/usr/bin/env python3
"""Generates the TOS Bodyguard shield icons (16/32/48/128 PNG) with no
third-party dependencies — a minimal RGBA PNG writer plus supersampled
polygon/line rasterization."""

import os
import struct
import zlib

SHIELD = [(0.50, 0.05), (0.88, 0.17), (0.88, 0.50), (0.50, 0.95), (0.12, 0.50), (0.12, 0.17)]
CHECK = [((0.30, 0.52), (0.45, 0.68)), ((0.45, 0.68), (0.73, 0.33))]
CHECK_THICKNESS = 0.075

INDIGO = (79, 70, 229)    # #4F46E5
WHITE = (255, 255, 255)


def point_in_poly(x, y, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def dist_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    t = 0.0 if length_sq == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    cx, cy = ax + t * dx, ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def render(size):
    ss = 4  # supersampling factor
    n = size * ss
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)  # PNG filter: none
        for x in range(size):
            shield_cov = check_cov = 0
            for sy in range(ss):
                for sx in range(ss):
                    u = (x + (sx + 0.5) / ss) / size
                    v = (y + (sy + 0.5) / ss) / size
                    if point_in_poly(u, v, SHIELD):
                        shield_cov += 1
                        if any(dist_to_segment(u, v, *a, *b) < CHECK_THICKNESS for a, b in CHECK):
                            check_cov += 1
            total = ss * ss
            sa = shield_cov / total
            ca = check_cov / total
            # composite white check over indigo shield over transparent bg
            r = int(WHITE[0] * ca + INDIGO[0] * (sa - ca))
            g = int(WHITE[1] * ca + INDIGO[1] * (sa - ca))
            b = int(WHITE[2] * ca + INDIGO[2] * (sa - ca))
            a = int(255 * sa)
            pixels += bytes((r, g, b, a))
    return bytes(pixels)


def write_png(path, size):
    raw = render(size)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({len(png)} bytes)")


if __name__ == "__main__":
    out_dir = os.path.join(os.path.dirname(__file__), "..", "icons")
    os.makedirs(out_dir, exist_ok=True)
    for s in (16, 32, 48, 128):
        write_png(os.path.join(out_dir, f"icon{s}.png"), s)

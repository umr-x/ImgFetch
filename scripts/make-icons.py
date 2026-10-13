#!/usr/bin/env python3
# ImgFetch - smart image downloader
# Copyright (C) 2026 ImgFetch Developer
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
"""Generate the original ImgFetch icon set (no external assets)."""
from PIL import Image, ImageDraw

SIZES = [16, 32, 48, 128]
TOP = (108, 99, 255)      # #6C63FF
BOTTOM = (34, 211, 238)   # #22D3EE


def rounded_gradient(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = int(size * 0.24)
    # Vertical gradient inside a rounded-rect mask.
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    grad = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
        g = int(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
        b = int(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
        gd.line([(0, y), (size, y)], fill=(r, g, b, 255))
    img.paste(grad, (0, 0), mask)
    return img


def draw_download_arrow(img: Image.Image) -> None:
    size = img.size[0]
    d = ImageDraw.Draw(img)
    w = max(2, size // 8)  # stroke width
    cx = size / 2
    # Arrow shaft: from 28% to 62% height.
    y1, y2 = size * 0.26, size * 0.60
    d.line([(cx, y1), (cx, y2)], fill="white", width=w)
    # Arrow head.
    head = size * 0.16
    d.line([(cx - head, y2 - head), (cx, y2)], fill="white", width=w)
    d.line([(cx + head, y2 - head), (cx, y2)], fill="white", width=w)
    # Tray baseline.
    ty = size * 0.76
    tx = size * 0.22
    d.line([(tx, ty), (size - tx, ty)], fill="white", width=w)


def main() -> None:
    import os
    outdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    os.makedirs(outdir, exist_ok=True)
    for size in SIZES:
        img = rounded_gradient(size)
        draw_download_arrow(img)
        img.save(os.path.join(outdir, f"icon-{size}.png"))
        print(f"icon-{size}.png")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Builds the app icons out of the default skin's own pixels.

The icon is a miniature Winamp window: the base skin's title bar, its body
bevel, and the bolt badge from the main window's corner, all lifted from the
sprites Webamp ships and enlarged without smoothing.

    python3 icons/make.py        # needs Pillow; rewrites icons/*.png
"""
import base64, io, re
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent
BUNDLE = HERE.parent / "vendor" / "webamp.bundle.min.mjs"
GRID = 64            # the icon, in skin pixels
BAR = 14             # title bar height


def sprite(src, selector):
    m = re.search(re.escape(selector) + r" ?\{background-image: url\(data:image/png;base64,([A-Za-z0-9+/=]+)\)", src)
    return Image.open(io.BytesIO(base64.b64decode(m.group(1)))).convert("RGB")


def bolt_badge(main):
    """The badge at the main window's bottom right, cut out of the body behind it."""
    box = main.crop((247, 87, 270, 110)).convert("RGBA")
    w, h = box.size
    px = box.load()
    # The body is dark and blue-tinted; the badge is light grey and orange.
    body = lambda p: max(p[:3]) < 0x68 and p[2] >= p[0]
    seen, todo = set(), [(x, y) for x in range(w) for y in (0, h - 1)] + [(x, y) for y in range(h) for x in (0, w - 1)]
    while todo:
        x, y = todo.pop()
        if (x, y) in seen or not (0 <= x < w and 0 <= y < h) or not body(px[x, y]):
            continue
        seen.add((x, y))
        px[x, y] = (0, 0, 0, 0)
        todo += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    return box.crop(box.getbbox())


def window(main, bar, grid=GRID, inset=0):
    """A grid-sized Winamp window: both ends of the title bar over an empty body."""
    size = grid - 2 * inset
    right = 37 if size >= 60 else 31   # the three buttons, plus the end of the stripes if they fit
    win = Image.new("RGB", (size, size))
    win.paste(bar.crop((0, 0, size - right, BAR)), (0, 0))
    win.paste(bar.crop((275 - right, 0, 275, BAR)), (size - right, 0))
    # The body: a clean stretch of the main window (right of the kHz readout),
    # framed with the window's own edge columns/rows.
    body_h = size - BAR
    patch = main.crop((195, 38, 265, 54)).resize((size, body_h), Image.BILINEAR)
    win.paste(patch, (0, BAR))
    win.paste(main.crop((0, 30, 3, 31)).resize((3, body_h)), (0, BAR))
    win.paste(main.crop((272, 30, 275, 31)).resize((3, body_h)), (size - 3, BAR))
    win.paste(main.crop((40, 113, 41, 116)).resize((size, 3)), (0, size - 3))
    win.paste(main.crop((0, 113, 3, 116)), (0, size - 3))
    win.paste(main.crop((272, 113, 275, 116)), (size - 3, size - 3))
    return win


def icon(main, bar, bolt, px, grid=GRID, inset=0, bolt_scale=2):
    # Full bleed in the body colour, so iOS's corner mask and Android's
    # maskable crop only ever cut into plain skin.
    art = Image.new("RGB", (grid, grid), main.getpixel((137, 60)))
    win = window(main, bar, grid, inset)
    art.paste(win, (inset, inset))
    big = bolt.resize((bolt.width * bolt_scale, bolt.height * bolt_scale), Image.NEAREST)
    body_mid = inset + BAR + (win.height - BAR - 3) // 2
    art.paste(big, ((grid - big.width) // 2, body_mid - big.height // 2), big)
    scale = px / grid
    if scale == int(scale):
        return art.resize((px, px), Image.NEAREST)
    # Not a whole multiple (180px): enlarge crisply first, then reduce.
    return art.resize((grid * 16, grid * 16), Image.NEAREST).resize((px, px), Image.LANCZOS)


def main():
    src = BUNDLE.read_text(encoding="utf-8")
    body = sprite(src, "#webamp #main-window")
    bar = sprite(src, "#webamp .selected #title-bar")
    bolt = bolt_badge(body)
    icon(body, bar, bolt, 512).save(HERE / "icon-512.png")
    icon(body, bar, bolt, 192).save(HERE / "icon-192.png")
    icon(body, bar, bolt, 180).save(HERE / "apple-touch-icon.png")
    # Maskable: launchers may crop to the middle 80%, so the window sits inside it.
    icon(body, bar, bolt, 512, inset=7, bolt_scale=1).save(HERE / "icon-maskable-512.png")


if __name__ == "__main__":
    main()

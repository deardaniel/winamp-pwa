#!/usr/bin/env python3
"""Builds the app icons out of the default skin's own pixels.

The icon is the bolt badge from the main window's corner, alone on a
brightened version of the window's body colour, lifted from the sprites Webamp ships and enlarged
without smoothing.

    python3 icons/make.py        # needs Pillow; rewrites icons/*.png
"""
import base64, io, re
from pathlib import Path
from PIL import Image, ImageEnhance

HERE = Path(__file__).resolve().parent
BUNDLE = HERE.parent / "vendor" / "webamp.bundle.min.mjs"
GRID = 32            # the icon, in skin pixels: 16x at 512, 6x at 192
BACK = (40, 72, 150) # a brighter take on the body's blue: the real one is murky as a home-screen icon


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
    box = box.crop(box.getbbox())
    # The skin's shading is muted for a 275px window; lift it so it glows at icon size.
    rgb = ImageEnhance.Color(ImageEnhance.Brightness(box.convert("RGB")).enhance(1.4)).enhance(1.6)
    rgb.putalpha(box.getchannel("A"))
    return rgb


def icon(main, bolt, px, grid=GRID):
    """The bolt badge alone on the skin's body colour. Full bleed, so
    iOS's corner mask and Android's maskable crop only ever cut into plain skin."""
    art = Image.new("RGB", (grid, grid), BACK)
    art.paste(bolt, ((grid - bolt.width) // 2, (grid - bolt.height) // 2), bolt)
    scale = px / grid
    if scale == int(scale):
        return art.resize((px, px), Image.NEAREST)
    # Not a whole multiple (180px): enlarge crisply first, then reduce.
    return art.resize((grid * 16, grid * 16), Image.NEAREST).resize((px, px), Image.LANCZOS)


def main():
    src = BUNDLE.read_text(encoding="utf-8")
    body = sprite(src, "#webamp #main-window")
    bolt = bolt_badge(body)
    icon(body, bolt, 512).save(HERE / "icon-512.png")
    icon(body, bolt, 192).save(HERE / "icon-192.png")
    icon(body, bolt, 180).save(HERE / "apple-touch-icon.png")
    # Maskable: launchers may crop to a circle in the middle 80%, so the
    # badge gets more room around it.
    icon(body, bolt, 512, grid=GRID * 5 // 4).save(HERE / "icon-maskable-512.png")


if __name__ == "__main__":
    main()

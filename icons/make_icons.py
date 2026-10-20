"""Draws the Studeck icon and saves every size the app needs.

    python icons/make_icons.py

studeck.png (1024 px, for README and the Mac), studeck.ico (Windows, 16-256 px),
studeck.icns (Mac app bundles) and tray.png (64 px, the tray / menu bar icon).
A deck of three cards on a blue-violet tile: the panel that drops down, with a
tick on the front card.
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
S = 1024           # drawn at this size
SS = 4             # ...times this, then scaled down for smooth edges

TOP_LEFT = (76, 160, 255)     # sky blue
BOTTOM_RIGHT = (124, 92, 246)  # violet
INK = (255, 255, 255)
TICK = (88, 120, 250)


def gradient(size):
    """Diagonal blue-to-violet."""
    small = Image.new("RGB", (2, 2))
    small.putpixel((0, 0), TOP_LEFT)
    small.putpixel((1, 1), BOTTOM_RIGHT)
    mid = tuple((a + b) // 2 for a, b in zip(TOP_LEFT, BOTTOM_RIGHT))
    small.putpixel((1, 0), mid)
    small.putpixel((0, 1), mid)
    return small.resize((size, size), Image.BILINEAR)


def draw(size=S):
    n = size * SS
    k = n / 1024  # design units are for a 1024 px tile

    def box(x0, y0, x1, y1):
        return [round(v * k) for v in (x0, y0, x1, y1)]

    # The tile: a rounded square with a soft gradient.
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box(40, 40, 984, 984), radius=round(220 * k), fill=255)
    tile = gradient(n).convert("RGBA")
    tile.putalpha(mask)

    # A soft light sheen towards the top.
    sheen = Image.new("L", (n, n), 0)
    ImageDraw.Draw(sheen).ellipse(box(-300, -700, 1324, 520), fill=40)
    sheen = ImageChops.multiply(sheen.filter(ImageFilter.GaussianBlur(120 * k)), mask)
    tile = Image.composite(Image.new("RGBA", (n, n), (255, 255, 255, 255)), tile, sheen)
    tile.putalpha(mask)

    def layer():
        return Image.new("RGBA", (n, n), (0, 0, 0, 0))

    # The deck: two cards peeking out behind the front one (see-through white).
    back = layer()
    d = ImageDraw.Draw(back)
    d.rounded_rectangle(box(300, 196, 724, 300), radius=round(44 * k), fill=INK + (120,))
    tile.alpha_composite(back)
    back = layer()
    d = ImageDraw.Draw(back)
    d.rounded_rectangle(box(244, 258, 780, 380), radius=round(52 * k), fill=INK + (185,))
    tile.alpha_composite(back)
    # A soft shadow under the front card.
    shadow = layer()
    ImageDraw.Draw(shadow).rounded_rectangle(box(188, 352, 836, 852), radius=round(76 * k), fill=(30, 20, 90, 90))
    tile.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(26 * k)))
    # The front card and its tick.
    front = layer()
    d = ImageDraw.Draw(front)
    d.rounded_rectangle(box(188, 330, 836, 830), radius=round(76 * k), fill=INK + (255,))
    w = round(84 * k)
    pts = [tuple(round(v * k) for v in p) for p in ((350, 586), (462, 692), (676, 470))]
    d.line(pts, fill=TICK + (255,), width=w, joint="curve")
    for x, y in (pts[0], pts[-1]):
        d.ellipse((x - w // 2, y - w // 2, x + w // 2, y + w // 2), fill=TICK + (255,))
    tile.alpha_composite(front)
    # Nothing outside the rounded tile.
    tile.putalpha(ImageChops.multiply(tile.getchannel("A"), mask))
    return tile.resize((size, size), Image.LANCZOS)


def main():
    big = draw(1024)
    big.save(HERE / "studeck.png")
    # Small sizes drawn directly so they stay crisp.
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [draw(s) for s in sizes]
    frames[-1].save(HERE / "studeck.ico", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    big.save(HERE / "studeck.icns")
    draw(64).save(HERE / "tray.png")
    print("saved", ", ".join(p.name for p in sorted(HERE.glob("studeck.*"))), "and tray.png")


if __name__ == "__main__":
    main()

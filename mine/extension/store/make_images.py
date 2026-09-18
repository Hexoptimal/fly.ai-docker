"""Chrome Web Store images for the fly.ai compute extension.

    python mine/extension/store/make_images.py [POPUP_SCREENSHOT.png]

Writes, next to this file (24-bit PNG, no alpha, as the store asks):
  screenshot-1280x800.png   store screenshot: the popup, the logo and what it does
  promo-small-440x280.png   small promo tile
  marquee-1400x560.png      marquee promo tile (optional in the store)
  icon-128.png              store icon: the logo's glowing fly on a dark rounded square, 96x96 art with 16 px of
                            transparent padding (Chrome's icon guidance); the one file here that keeps alpha
POPUP_SCREENSHOT defaults to popup.png here (a screenshot of the extension's popup).
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
LOGO = ROOT / "logo.webp"
FONTS = Path("C:/Windows/Fonts")
BG = (7, 9, 12)
TEXT, MUTED, RED, GREEN = (238, 241, 245), (149, 160, 174), (255, 91, 79), (61, 220, 132)


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), size)


def backdrop(w: int, h: int) -> Image.Image:
    """Near-black with a soft green glow behind the fly and a red one behind the popup."""
    img = Image.new("RGB", (w, h), BG)
    glow = Image.new("RGB", (w, h), (0, 0, 0))
    d = ImageDraw.Draw(glow)
    d.ellipse((-w * 0.15, h * 0.05, w * 0.55, h * 1.1), fill=(10, 60, 38))
    d.ellipse((w * 0.55, -h * 0.2, w * 1.2, h * 0.9), fill=(70, 18, 16))
    glow = glow.filter(ImageFilter.GaussianBlur(min(w, h) // 4))
    return ImageChops.add(img, glow)


def logo(width: int) -> Image.Image:
    """The fly.ai wordmark (white on black), trimmed to its letters."""
    im = Image.open(LOGO).convert("RGB")
    box = Image.eval(im.convert("L"), lambda v: 255 if v > 24 else 0).getbbox()
    im = im.crop(box)
    return im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)


def paste_light(canvas: Image.Image, im: Image.Image, xy: tuple[int, int]) -> None:
    """Paste a white-on-black image so its black disappears into the background (lighten)."""
    region = canvas.crop((xy[0], xy[1], xy[0] + im.width, xy[1] + im.height))
    canvas.paste(ImageChops.lighter(region, im), xy)


def framed(shot: Image.Image, height: int) -> tuple[Image.Image, Image.Image]:
    """The popup screenshot scaled to height, with rounded corners; returns (image, mask)."""
    shot = shot.convert("RGB")
    shot = shot.resize((round(shot.width * height / shot.height), height), Image.LANCZOS)
    mask = Image.new("L", shot.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, shot.width - 1, shot.height - 1), radius=max(10, height // 40), fill=255)
    return shot, mask


def drop(canvas: Image.Image, shot: Image.Image, mask: Image.Image, xy: tuple[int, int], border=(40, 48, 60)) -> None:
    """Shadow, a thin border, then the screenshot."""
    x, y = xy
    shadow = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle((x + 6, y + 18, x + shot.width + 6, y + shot.height + 18), radius=24, fill=190)
    shadow = shadow.filter(ImageFilter.GaussianBlur(28))
    canvas.paste((0, 0, 0), (0, 0), shadow)
    ImageDraw.Draw(canvas).rounded_rectangle((x - 2, y - 2, x + shot.width + 1, y + shot.height + 1),
                                             radius=max(12, shot.height // 38), fill=border)
    canvas.paste(shot, (x, y), mask)


def lines(draw: ImageDraw.ImageDraw, x: int, y: int, items: list[tuple[str, ImageFont.FreeTypeFont, tuple, int]]) -> int:
    for text, f, fill, gap in items:
        draw.text((x, y), text, font=f, fill=fill)
        y += gap
    return y


def bullets(draw: ImageDraw.ImageDraw, x: int, y: int, items: list[str], size: int, gap: int) -> int:
    f = font("segoeui.ttf", size)
    for text in items:
        r = size // 4
        cy = y + size * 0.62
        draw.ellipse((x, cy - r, x + 2 * r, cy + r), fill=GREEN)
        draw.text((x + size, y), text, font=f, fill=TEXT)
        y += gap
    return y


def screenshot(shot: Image.Image) -> Image.Image:
    W, H = 1280, 800
    img = backdrop(W, H)
    s, m = framed(shot, 680)
    drop(img, s, m, (W - s.width - 90, (H - s.height) // 2))
    paste_light(img, logo(300), (90, 110))
    d = ImageDraw.Draw(img)
    y = lines(d, 90, 270, [("Lend your GPU to", font("segoeuib.ttf", 54), TEXT, 66),
                           ("a fruit fly brain", font("segoeuib.ttf", 54), GREEN, 96)])
    y = bullets(d, 92, y, ["Runs fly-connectome simulations as you browse",
                           "Off until you turn it on",
                           "Pick GPU or CPU and how hard it works",
                           "Every result is checked; earn points"], 26, 46)
    d.text((92, H - 70), "flyaiworld.com/compute", font=font("consola.ttf", 22), fill=MUTED)
    return img


def promo_small(shot: Image.Image) -> Image.Image:
    """Logo, product name and tagline only: small tiles read best simple."""
    W, H = 440, 280
    img = backdrop(W, H)
    mark = logo(230)
    paste_light(img, mark, ((W - mark.width) // 2, 40))
    d = ImageDraw.Draw(img)

    def centre(y: int, text: str, f: ImageFont.FreeTypeFont, fill) -> None:
        d.text(((W - d.textlength(text, font=f)) / 2, y), text, font=f, fill=fill)

    centre(40 + mark.height + 10, "compute", font("segoeuib.ttf", 28), RED)
    centre(190, "Lend your GPU to a fruit fly brain", font("segoeuib.ttf", 21), TEXT)
    centre(226, "Off until you turn it on", font("segoeui.ttf", 16), MUTED)
    return img


def marquee(shot: Image.Image) -> Image.Image:
    W, H = 1400, 560
    img = backdrop(W, H)
    s, m = framed(shot, 500)
    drop(img, s, m, (W - s.width - 140, (H - s.height) // 2))
    paste_light(img, logo(280), (110, 90))
    d = ImageDraw.Draw(img)
    y = lines(d, 110, 240, [("Lend your GPU to", font("segoeuib.ttf", 56), TEXT, 68),
                            ("a fruit fly brain", font("segoeuib.ttf", 56), GREEN, 92)])
    d.text((112, y), "Real connectome simulations, in the background. Off until you turn it on.",
           font=font("segoeui.ttf", 24), fill=MUTED)
    return img


def icon() -> Image.Image:
    """128 x 128: a 96 x 96 dark rounded square holding the logo's fly, 16 px transparent padding all round."""
    size, pad = 128, 16
    art = size - 2 * pad
    src = Image.open(LOGO).convert("RGB")
    cx, cy, half = 937, 504, 88                       # the fly in logo.webp (its green glow, with room around it)
    fly = src.crop((cx - half, cy - half, cx + half, cy + half))
    # keep only the green fly and its glow: the white letters beside it ("y", "a") are grey-white, not green
    keep = Image.eval(ImageChops.subtract(fly.getchannel("G"), fly.getchannel("R")), lambda v: 255 if v > 18 else 0)
    fly = Image.composite(fly, Image.new("RGB", fly.size, (0, 0, 0)), keep.filter(ImageFilter.GaussianBlur(1)))
    fly = fly.resize((art - 14, art - 14), Image.LANCZOS)
    tile = Image.new("RGB", (art, art), (13, 17, 23))
    glow = Image.new("RGB", (art, art), (0, 0, 0))
    ImageDraw.Draw(glow).ellipse((12, 12, art - 12, art - 12), fill=(12, 70, 46))
    tile = ImageChops.add(tile, glow.filter(ImageFilter.GaussianBlur(14)))
    region = tile.crop((7, 7, 7 + fly.width, 7 + fly.height))
    tile.paste(ImageChops.lighter(region, fly), (7, 7))
    mask = Image.new("L", (art * 4, art * 4), 0)       # 4x for a smooth rounded edge
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, art * 4 - 1, art * 4 - 1), radius=22 * 4, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(tile, (pad, pad), mask.resize((art, art), Image.LANCZOS))
    return out


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "popup.png"
    shot = Image.open(src)
    for name, make in (("screenshot-1280x800.png", screenshot), ("promo-small-440x280.png", promo_small),
                       ("marquee-1400x560.png", marquee)):
        out = make(shot).convert("RGB")
        out.save(HERE / name, "PNG", optimize=True)
        print(f"{name}: {out.size[0]}x{out.size[1]} {out.mode}")
    icon().save(HERE / "icon-128.png", "PNG", optimize=True)
    print("icon-128.png: 128x128 RGBA")


if __name__ == "__main__":
    main()

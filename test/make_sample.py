#!/usr/bin/env python3
"""
Make a fake "phone photo" of handwriting on a blank sheet, for testing.

Writes the 62 characters (a-z A-Z 0-9, capitals first, or in pairs) in lines across a
plain sheet with an italic system font: several characters per line, uneven
spacing, a little wobble and turn per letter, dotted i and j, and a few
letters split into two strokes (T, 7, H, 5). Then lays the sheet on a table,
tilted in perspective, with uneven light, blur, noise and JPEG compression.

    python3 test/make_sample.py OUT_DIR [--seed N] [--order lower|upper|pairs|Pairs] [--tilt DEG] [--skip CHARS]

OUT_DIR gets photo.jpg and truth.json (where each character really is, in photo pixels).
Needs Pillow and numpy.
"""
import argparse
import json
import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = [
    '/usr/share/fonts/truetype/freefont/FreeSerifItalic.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf',
    '/Library/Fonts/Georgia Italic.ttf',
    'C:/Windows/Fonts/georgiai.ttf',
]
LOWER, UPPER, DIGITS = 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'
SPLIT = {'T': 0.2, '7': 0.18, 'H': 0.62, '5': 0.24}  # cut a gap this far down the letter: two strokes


def solve_h(src, dst):
    """3x3 homography (row-major, 9 values) mapping src points onto dst points."""
    A, b = [], []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    return list(np.linalg.solve(np.array(A, float), np.array(b, float))) + [1.0]


def apply_h(H, x, y):
    w = H[6] * x + H[7] * y + H[8]
    return ((H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--order', choices=['lower', 'upper', 'pairs', 'Pairs'], default='lower',
                    help='a-z A-Z, A-Z a-z, aA bB ..., or Aa Bb ...; numbers last')
    ap.add_argument('--tilt', type=float, default=4.0, help='rotation of the sheet in the photo, degrees')
    ap.add_argument('--warp', type=float, default=60.0, help='how far each corner is pushed for perspective, px')
    ap.add_argument('--skip', default='', help='characters to leave out')
    ap.add_argument('--ink', default='22,22,38', help='pen colour as R,G,B')
    ap.add_argument('--blur', type=float, default=1.1, help='camera blur radius, px')
    ap.add_argument('--font', default=None)
    args = ap.parse_args()
    rnd = random.Random(args.seed)
    os.makedirs(args.out, exist_ok=True)

    seq = {'lower': LOWER + UPPER, 'upper': UPPER + LOWER,
           'pairs': ''.join(a + b for a, b in zip(LOWER, UPPER)), 'Pairs': ''.join(a + b for a, b in zip(UPPER, LOWER))}[args.order] + DIGITS
    seq = [c for c in seq if c not in set(args.skip)]
    PW, PH = 2100, 2970  # an A4 sheet at 10 px per mm
    page = Image.new('RGB', (PW, PH), (250, 249, 244))
    font_path = args.font or next(p for p in FONTS if os.path.exists(p))
    em = 135  # capitals about 9 mm tall
    ink = tuple(int(v) for v in args.ink.split(','))

    placed = []
    margin, x, base = 170, 170, 330
    per_line, in_line, line = rnd.randint(9, 14), 0, 0
    for ch in seq:
        size = 3 * em
        layer = Image.new('L', (size, size), 0)
        f = ImageFont.truetype(font_path, int(em * rnd.uniform(0.93, 1.06)))
        ImageDraw.Draw(layer).text((size / 2, size / 2), ch, font=f, fill=255, anchor='ms', stroke_width=2, stroke_fill=255)
        layer = layer.rotate(rnd.uniform(-3, 3), resample=Image.BICUBIC, center=(size / 2, size / 2))
        bb = layer.getbbox()
        if ch in SPLIT:  # lift the pen: a clean gap across the letter
            y = int(bb[1] + SPLIT[ch] * (bb[3] - bb[1]))
            ImageDraw.Draw(layer).rectangle((0, y - 3, size, y + 3), fill=0)
            bb = layer.getbbox()
        w = bb[2] - bb[0]
        if in_line >= per_line or x + w > PW - margin:
            line += 1
            x, base, in_line, per_line = margin + rnd.randint(-20, 20), base + rnd.randint(250, 300), 0, rnd.randint(9, 14)
        wobble = rnd.uniform(-3, 3)
        ox = int(round(x - bb[0]))
        oy = int(round(base + wobble - size / 2))
        page.paste(Image.new('RGB', layer.size, ink), (ox, oy), layer)
        placed.append({'ch': ch, 'line': line, 'box': [ox + bb[0], oy + bb[1], ox + bb[2], oy + bb[3]],
                       'top': base - (oy + bb[1]), 'bottom': base - (oy + bb[3]), 'base': base})
        x += w + rnd.randint(28, 70)
        in_line += 1
    assert base + 150 < PH - margin, 'the writing does not fit on the sheet'

    # the photo: the sheet tilted in perspective on a table
    W, H = 3000, 4000
    th = math.radians(args.tilt)
    half_w, half_h = 1150, 1150 * PH / PW
    quad = []
    for (ux, uy) in [(-1, -1), (1, -1), (1, 1), (-1, 1)]:
        px, py = ux * half_w, uy * half_h
        px, py = px * math.cos(th) - py * math.sin(th), px * math.sin(th) + py * math.cos(th)
        quad.append((W / 2 + px + rnd.uniform(-args.warp, args.warp), H / 2 + py + rnd.uniform(-args.warp, args.warp)))
    assert all(20 < qx < W - 20 and 20 < qy < H - 20 for qx, qy in quad), 'the sheet does not fit in the photo'
    corners = [(0, 0), (PW, 0), (PW, PH), (0, PH)]
    fwd, inv = solve_h(corners, quad), solve_h(quad, corners)
    warped = page.transform((W, H), Image.PERSPECTIVE, inv[:8], Image.BICUBIC)
    mask = Image.new('L', page.size, 255).transform((W, H), Image.PERSPECTIVE, inv[:8], Image.BICUBIC)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    table = np.stack([np.full((H, W), c, np.float32) for c in (118, 100, 84)], -1)
    table += np.random.default_rng(args.seed).normal(0, 6, (H, W, 1)).astype(np.float32)
    photo = Image.composite(warped, Image.fromarray(np.clip(table, 0, 255).astype(np.uint8)), mask)
    arr = np.asarray(photo).astype(np.float32)
    light = 0.80 + 0.13 * (xx / W) + 0.13 * (1 - yy / H)  # brighter towards the top right
    light -= 0.10 * np.exp(-(((xx - W * 0.25) / 500) ** 2 + ((yy - H * 0.8) / 700) ** 2))  # a soft shadow
    arr *= light[..., None]
    arr[..., 2] *= 0.96
    arr += np.random.default_rng(args.seed + 1).normal(0, 3.5, arr.shape)
    photo = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(args.blur))
    photo.save(os.path.join(args.out, 'photo.jpg'), quality=86)

    for p in placed:
        x0, y0, x1, y1 = p['box']
        pts = [apply_h(fwd, x, y) for x, y in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]]
        p['photo'] = [min(q[0] for q in pts), min(q[1] for q in pts), max(q[0] for q in pts), max(q[1] for q in pts)]
        # top and bottom above the line's baseline as the camera sees them (perspective makes far letters smaller)
        cx, base = (x0 + x1) / 2, p.pop('base')
        b = apply_h(fwd, cx, base)
        for k in ('top', 'bottom'):
            q = apply_h(fwd, cx, base - p[k])
            p[k + '_photo'] = math.copysign(math.hypot(q[0] - b[0], q[1] - b[1]), p[k])
    json.dump({'width': W, 'height': H, 'order': args.order, 'skipped': args.skip, 'lines': line + 1, 'chars': placed,
               'font': font_path}, open(os.path.join(args.out, 'truth.json'), 'w'), indent=1)
    print('wrote', os.path.join(args.out, 'photo.jpg'), f'({len(placed)} characters in {line + 1} lines)')


if __name__ == '__main__':
    main()

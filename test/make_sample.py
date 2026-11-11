#!/usr/bin/env python3
"""
Make a fake "phone photo" of a filled-in template, for testing.

Writes every character into its box with an italic system font (jittered a
little per letter so it is less regular), then tilts the sheet in perspective,
lays it on a table, adds uneven light, blur, noise and JPEG compression.

    python3 test/make_sample.py OUT_DIR [--seed N] [--tilt DEGREES] [--warp PX]

OUT_DIR gets photo.jpg and truth.json (where the corner marks really are, in photo pixels).
Needs Pillow and numpy.
"""
import argparse
import json
import math
import os
import random
import re

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = [
    '/usr/share/fonts/truetype/freefont/FreeSerifItalic.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf',
    '/Library/Fonts/Georgia Italic.ttf',
    'C:/Windows/Fonts/georgiai.ttf',
]


def read_layout():
    """The few numbers we need from js/layout.js (kept in one place)."""
    src = open(os.path.join(ROOT, 'js', 'layout.js'), encoding='utf-8').read()
    num = lambda k: float(re.search(r'\b' + k + r':\s*([0-9.]+)', src).group(1))
    L = {k: num(k) for k in ['SPAN_W', 'SPAN_H', 'MARK', 'COLS', 'GRID_X', 'GRID_Y', 'PITCH_X', 'PITCH_Y', 'BOX_W', 'BOX_H', 'BASELINE', 'INSET']}
    chars = list('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') + ['.', ',', '!', '?', "'", '-', ':', ';', '(', ')']
    return L, chars


def solve_h(src, dst):
    """3x3 homography (row-major, 9 values) mapping src points onto dst points."""
    A, b = [], []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    h = np.linalg.solve(np.array(A, float), np.array(b, float))
    return list(h) + [1.0]


def apply_h(H, x, y):
    w = H[6] * x + H[7] * y + H[8]
    return ((H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--tilt', type=float, default=4.0, help='rotation of the sheet, degrees')
    ap.add_argument('--warp', type=float, default=110.0, help='how far each corner is pushed for perspective, px')
    ap.add_argument('--size', type=float, default=1050.0, help='half the sheet width in the photo, px (photo is 3000 x 4000)')
    ap.add_argument('--skip', default='', help='characters to leave empty')
    ap.add_argument('--font', default=None)
    ap.add_argument('--ink', default='22,22,38', help='pen colour as R,G,B')
    ap.add_argument('--blur', type=float, default=1.1, help='camera blur radius, px')
    args = ap.parse_args()
    rnd = random.Random(args.seed)
    os.makedirs(args.out, exist_ok=True)

    L, chars = read_layout()
    page = Image.open(os.path.join(ROOT, 'template', 'paper-hand-template.png')).convert('RGB')
    pw, ph = page.size
    sx, sy = pw / (L['SPAN_W'] + L['MARK']), ph / (L['SPAN_H'] + L['MARK'])  # px per mm
    pad = L['MARK'] / 2
    to_px = lambda x, y: ((x + pad) * sx, (y + pad) * sy)

    font_path = args.font or next(p for p in FONTS if os.path.exists(p))
    em = int(round(7.2 / 0.66 * sx))  # capitals about 7.2 mm tall
    font = ImageFont.truetype(font_path, em)
    ink = tuple(int(v) for v in args.ink.split(','))
    skip = set(args.skip)
    placed = {}
    for i, ch in enumerate(chars):
        col, row = i % int(L['COLS']), i // int(L['COLS'])
        bx = L['GRID_X'] + col * L['PITCH_X'] + (L['PITCH_X'] - L['BOX_W']) / 2
        by = L['GRID_Y'] + row * L['PITCH_Y']
        size = 3 * em
        layer = Image.new('L', (size, size), 0)
        d = ImageDraw.Draw(layer)
        scale = rnd.uniform(0.92, 1.06)
        f = ImageFont.truetype(font_path, int(em * scale))
        d.text((size / 2, size / 2), ch, font=f, fill=255, anchor='ms', stroke_width=2, stroke_fill=255)
        layer = layer.rotate(rnd.uniform(-4, 4), resample=Image.BICUBIC, center=(size / 2, size / 2))
        bb = layer.getbbox()
        if not bb:
            continue
        # place it: horizontally centred in the box (with a little wobble), sitting on the baseline
        cx_mm = bx + L['BOX_W'] / 2 + rnd.uniform(-0.8, 0.8)
        base_mm = by + L['BASELINE'] + rnd.uniform(-0.35, 0.35)
        cx, base = to_px(cx_mm, base_mm)
        ox = int(round(cx - (bb[0] + bb[2]) / 2))
        oy = int(round(base - size / 2))
        # keep every stroke inside the cut area of the box
        lo_x, lo_y = to_px(bx + L['INSET'] + 0.4, by + L['INSET'] + 0.4)
        hi_x, hi_y = to_px(bx + L['BOX_W'] - L['INSET'] - 0.4, by + L['BOX_H'] - L['INSET'] - 0.4)
        if ch in skip:
            continue
        assert ox + bb[0] >= lo_x and ox + bb[2] <= hi_x and oy + bb[1] >= lo_y and oy + bb[3] <= hi_y, f'{ch!r} does not fit its box'
        page.paste(Image.new('RGB', layer.size, ink), (ox, oy), layer)
        printed_base = to_px(0, by + L['BASELINE'])[1]
        # where the ink really is, in mm above the printed baseline (what the font should reproduce)
        placed[ch] = {'top': (printed_base - (oy + bb[1])) / sy, 'bottom': (printed_base - (oy + bb[3])) / sy, 'width': (bb[2] - bb[0]) / sx}

    # the photo: page tilted in perspective on a table
    W, H = 3000, 4000
    th = math.radians(args.tilt)
    cxp, cyp, half_w, half_h = W / 2, H / 2, args.size, args.size * ph / pw
    quad = []
    for (ux, uy) in [(-1, -1), (1, -1), (1, 1), (-1, 1)]:
        x, y = ux * half_w, uy * half_h
        x, y = x * math.cos(th) - y * math.sin(th), x * math.sin(th) + y * math.cos(th)
        quad.append((cxp + x + rnd.uniform(-args.warp, args.warp), cyp + y + rnd.uniform(-args.warp, args.warp)))
    assert all(40 < x < W - 40 and 40 < y < H - 40 for x, y in quad), 'the sheet does not fit in the photo; use a smaller --size or --warp'
    page_corners = [(0, 0), (pw, 0), (pw, ph), (0, ph)]
    fwd = solve_h(page_corners, quad)  # page px -> photo px
    inv = solve_h(quad, page_corners)  # photo px -> page px (what PIL wants)
    warped = page.transform((W, H), Image.PERSPECTIVE, inv[:8], Image.BICUBIC)
    mask = Image.new('L', page.size, 255).transform((W, H), Image.PERSPECTIVE, inv[:8], Image.BICUBIC)

    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    table = np.stack([np.full((H, W), c, np.float32) for c in (118, 100, 84)], -1)
    table += np.random.default_rng(args.seed).normal(0, 6, (H, W, 1)).astype(np.float32)
    photo = Image.composite(warped, Image.fromarray(np.clip(table, 0, 255).astype(np.uint8)), mask)
    arr = np.asarray(photo).astype(np.float32)
    light = 0.80 + 0.22 * (xx / W) * 0.6 + 0.22 * (1 - yy / H) * 0.6  # brighter towards the top right
    light -= 0.10 * np.exp(-(((xx - W * 0.25) / 500) ** 2 + ((yy - H * 0.8) / 700) ** 2))  # a soft shadow
    arr *= light[..., None]
    arr[..., 2] *= 0.96  # warm indoor light
    arr += np.random.default_rng(args.seed + 1).normal(0, 3.5, arr.shape)
    photo = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(args.blur))
    photo.save(os.path.join(args.out, 'photo.jpg'), quality=86)

    marks = [(0, 0), (L['SPAN_W'], 0), (L['SPAN_W'], L['SPAN_H']), (0, L['SPAN_H'])]
    truth = [apply_h(fwd, *to_px(*m)) for m in marks]
    json.dump({'width': W, 'height': H, 'marks': truth, 'px_per_mm': sx, 'font': font_path, 'skipped': sorted(skip), 'glyphs': placed},
              open(os.path.join(args.out, 'truth.json'), 'w'), indent=1)
    print('wrote', os.path.join(args.out, 'photo.jpg'))


if __name__ == '__main__':
    main()

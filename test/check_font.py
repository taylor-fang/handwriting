#!/usr/bin/env python3
"""
Checks a font made by Paper Hand, independently of the browser, with fontTools.

    python3 test/check_font.py FONT.woff PaperHand.css [PAPERS_OWN_PaperHand.css] [--missing CHARS]

With Paper's own app/assets/PaperHand.css as the third argument, the CSS is
compared with it directly; otherwise with the shape that file has.
"""
import base64
import io
import re
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont

REQUIRED = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
PAPER_SHAPE = '@font-face { font-family: "Paper Hand"; src: url(data:font/woff;base64,<DATA>) format("woff"); }\n'
failed = 0


def check(name, ok, detail=''):
    global failed
    failed += not ok
    print(('PASS' if ok else 'FAIL') + '  [fontTools] ' + name + (f'  ({detail})' if detail else ''))


def shape(css):
    return re.sub(r'base64,[A-Za-z0-9+/=]+\)', 'base64,<DATA>)', css)


def main():
    args = sys.argv[1:]
    missing = ''
    if '--missing' in args:
        i = args.index('--missing')
        missing = args[i + 1]
        del args[i:i + 2]
    woff_path, css_path = args[0], args[1]
    paper_css = args[2] if len(args) > 2 else None
    want = len(REQUIRED) - len(set(missing) & set(REQUIRED))

    raw = open(woff_path, 'rb').read()
    check('file is WOFF', raw[:4] == b'wOFF', raw[:4])
    font = TTFont(io.BytesIO(raw))
    check('fontTools reads it', font.flavor == 'woff', f'flavor {font.flavor}, tables {" ".join(sorted(font.keys()))}')
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    bounds = {}
    for ch in REQUIRED:
        name = cmap.get(ord(ch))
        if not name:
            continue
        pen = BoundsPen(gs)
        gs[name].draw(pen)
        if pen.bounds:
            bounds[ch] = pen.bounds
    check(f'{want} characters mapped, each with a non-empty outline', len(bounds) == want and not set(missing) & set(bounds),
          f'{len(bounds)}/62' + (f', left empty on purpose: {missing}' if missing else ''))
    check('space present', 32 in cmap, f'advance {font["hmtx"][cmap[32]][0]}' if 32 in cmap else '')
    head, hhea = font['head'], font['hhea']
    check('metrics match Paper Hand (1000 upm, 900 / -300)', head.unitsPerEm == 1000 and hhea.ascent == 900 and hhea.descent == -300,
          f'{head.unitsPerEm} upm, ascent {hhea.ascent}, descent {hhea.descent}')
    if len(bounds) == want:
        desc = {c: round(bounds[c][1]) for c in 'gjpqy' if c in bounds}
        check('descenders below the baseline', all(v < -120 for v in desc.values()), ', '.join(f'{c} {v}' for c, v in desc.items()))
        flat = {c: round(bounds[c][1]) for c in 'acemnorsuvwxz' if c in bounds}
        check('x-height letters on the baseline', all(abs(v) < 110 for v in flat.values()), ', '.join(f'{c} {v}' for c, v in flat.items()))
        caps = sorted(bounds[c][3] for c in 'EHLNT' if c in bounds)[2]
        xh = sorted(bounds[c][3] for c in 'nuvxz' if c in bounds)[2]
        check('capitals taller than x-height', caps > 1.25 * xh, f'cap {round(caps)}, x {round(xh)}')
    print(f'       family name in font: {font["name"].getDebugName(1)!r}')

    css = open(css_path, encoding='utf-8').read()
    want_css = shape(open(paper_css, encoding='utf-8').read()) if paper_css else PAPER_SHAPE
    check('CSS has the same shape as Paper\'s PaperHand.css' + (' (compared with the real file)' if paper_css else ''),
          shape(css) == want_css, repr(shape(css)[:60]) + '...')
    m = re.search(r'base64,([A-Za-z0-9+/=]+)\)', css)
    check('CSS data URI is exactly the .woff', m and base64.b64decode(m.group(1)) == raw, f'{len(css)} bytes of CSS')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()

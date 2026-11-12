/*
 * Paper Hand reader: a photo of handwriting on plain paper -> 62 characters.
 *
 *   1. find the ink, measured against the paper around it (uneven light is fine)
 *   2. measure how much the lines of writing slope, and straighten the photo
 *   3. group blobs of ink into lines, and join the parts of one character
 *      (the dot on an i or j, a crossbar written separately)
 *   4. read them left to right, top to bottom, as a to z, A to Z, 0 to 9,
 *      or A to Z first, or in pairs (whichever fits: capitals are taller)
 *   5. find each line's baseline from the letters that sit on it
 *
 * Needs PaperHandImaging. Works in the browser and in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./imaging.js'));
  else root.PaperHandReader = factory(root.PaperHandImaging);
})(typeof self !== 'undefined' ? self : this, function (IM) {
  'use strict';

  var LOWER = 'abcdefghijklmnopqrstuvwxyz', UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', DIGITS = '0123456789';
  function pairs(first, second) { return first.split('').map(function (c, i) { return c + second[i]; }).join(''); }
  // the orders people write the alphabet in: all small letters then all capitals, the other way
  // round, or in pairs (aA bB ... or Aa Bb ...); the numbers come last
  var ORDERS = {
    lower: LOWER + UPPER + DIGITS, upper: UPPER + LOWER + DIGITS,
    pairs: pairs(LOWER, UPPER) + DIGITS, Pairs: pairs(UPPER, LOWER) + DIGITS,
  };
  var COUNT = 62;
  var NAMES = { '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine' };
  var HANGS = 'fgjpqyJQ'; // may reach below the baseline, so they don't help find it
  var SMALL = 'acemnorsuvwxz'; // x-height letters

  function median(a) {
    if (!a.length) return NaN;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // Blobs of ink that could be (parts of) characters, plus the typical character height.
  function blobs(g, pl, threshold) {
    var mask = IM.inkMask(g, pl, threshold), cc = IM.components(mask, g.w, g.h, true);
    var side = Math.max(g.w, g.h), minArea = Math.max(6, Math.pow(side * 0.0018, 2));
    var list = cc.comps.filter(function (c) { return !c.edge && c.area >= minArea; });
    list.forEach(function (c) { c.h = c.y1 - c.y0; c.w = c.x1 - c.x0; c.cx = (c.x0 + c.x1) / 2; c.cy = (c.y0 + c.y1) / 2; });
    var h0 = median(list.map(function (c) { return c.h; }));
    var hMed = median(list.filter(function (c) { return c.h >= 0.4 * h0; }).map(function (c) { return c.h; })) || h0;
    // ruled lines, the sheet's edge, shadows: far bigger than any character
    list = list.filter(function (c) { return c.h < 4 * hMed && c.w < 6 * hMed; });
    return { mask: mask, labels: cc.labels, list: list, hMed: hMed };
  }

  // The slope of the lines of writing: the angle at which the blobs' centres line up best.
  function skew(list, hMed) {
    var big = list.filter(function (c) { return c.h >= 0.4 * hMed; });
    if (big.length < 5) return 0;
    var best = 0, bestScore = -1, bin = Math.max(2, hMed / 4);
    for (var deg = -20; deg <= 20.001; deg += 0.25) {
      var a = deg * Math.PI / 180, s = Math.sin(a), c = Math.cos(a), hist = {}, score = 0;
      big.forEach(function (b) {
        var k = Math.round((b.cy * c - b.cx * s) / bin);
        hist[k] = (hist[k] || 0) + 1;
      });
      for (var k in hist) score += hist[k] * hist[k];
      if (score > bestScore + 1e-9 || (score === bestScore && Math.abs(deg) < Math.abs(best))) { bestScore = score; best = deg; }
    }
    return best * Math.PI / 180;
  }

  function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

  // Lines of writing, top to bottom, each a list of characters (groups of blobs) left to right.
  function lines(list, hMed) {
    var big = list.filter(function (c) { return c.h >= 0.4 * hMed; }), small = list.filter(function (c) { return c.h < 0.4 * hMed; });
    big.sort(function (a, b) { return a.cy - b.cy; });
    // a new line starts where the centres jump; then each blob joins the nearest line centre
    var centres = [], cur = [];
    big.forEach(function (b) {
      if (cur.length && b.cy - median(cur) > 0.6 * hMed) { centres.push(median(cur)); cur = []; }
      cur.push(b.cy);
    });
    if (cur.length) centres.push(median(cur));
    var groups;
    for (var it = 0; it < 4; it++) {
      groups = centres.map(function () { return []; });
      big.forEach(function (b) {
        var k = 0;
        for (var i = 1; i < centres.length; i++) if (Math.abs(b.cy - centres[i]) < Math.abs(b.cy - centres[k])) k = i;
        groups[k].push(b);
      });
      groups = groups.filter(function (g) { return g.length; });
      centres = groups.map(function (g) { return median(g.map(function (b) { return b.cy; })); });
    }

    // parts of one character: blobs stacked above one another that share most of their width
    var out = groups.map(function (g) {
      var chars = g.map(function (b) { return { parts: [b] }; });
      var merged = true;
      while (merged) {
        merged = false;
        for (var i = 0; i < chars.length && !merged; i++) for (var j = i + 1; j < chars.length && !merged; j++) {
          var A = box(chars[i]), B = box(chars[j]);
          var xo = overlap(A.x0, A.x1, B.x0, B.x1) / Math.min(A.x1 - A.x0, B.x1 - B.x0);
          var yo = overlap(A.y0, A.y1, B.y0, B.y1) / Math.min(A.y1 - A.y0, B.y1 - B.y0);
          if (xo > 0.5 && yo < 0.3) { chars[i].parts = chars[i].parts.concat(chars[j].parts); chars.splice(j, 1); merged = true; }
        }
      }
      return chars;
    });

    // small blobs (dots, short strokes) join the nearest character above or below them; others are specks
    small.forEach(function (s) {
      var best = null, bestGap = Infinity;
      out.forEach(function (chars) {
        chars.forEach(function (ch) {
          var b = box(ch), pad = 0.15 * hMed;
          if (s.cx < b.x0 - pad || s.cx > b.x1 + pad) return;
          var gap = Math.max(0, b.y0 - s.y1, s.y0 - b.y1);
          if (gap < bestGap) { bestGap = gap; best = ch; }
        });
      });
      if (best && bestGap < 0.8 * hMed) best.parts.push(s);
    });

    return out.map(function (chars) {
      chars.forEach(function (ch) { var b = box(ch); for (var k in b) ch[k] = b[k]; });
      return chars.sort(function (a, b) { return (a.x0 + a.x1) - (b.x0 + b.x1); });
    });
  }

  function box(ch) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    ch.parts.forEach(function (p) { b.x0 = Math.min(b.x0, p.x0); b.y0 = Math.min(b.y0, p.y0); b.x1 = Math.max(b.x1, p.x1); b.y1 = Math.max(b.y1, p.y1); });
    return b;
  }

  // Which order was the alphabet written in? The capitals are the taller half.
  function order(chars) {
    var h = chars.map(function (c) { return c.y1 - c.y0; }), best = null;
    Object.keys(ORDERS).forEach(function (name) {
      var seq = ORDERS[name], caps = [], small = [];
      for (var i = 0; i < 52; i++) {
        if (/[A-Z]/.test(seq[i])) caps.push(h[i]);
        else if (SMALL.indexOf(seq[i]) >= 0) small.push(h[i]);
      }
      var fit = median(caps) / median(small);
      if (!best || fit > best.fit) best = { name: name, fit: fit };
    });
    return best;
  }

  // Each line's baseline, fitted through the bottoms of the characters that sit on it.
  function baselines(rows, hMed) {
    rows.forEach(function (row) {
      var pts = row.filter(function (c) { return HANGS.indexOf(c.ch) < 0; }).map(function (c) { return [(c.x0 + c.x1) / 2, c.y1]; });
      if (!pts.length) pts = row.map(function (c) { return [(c.x0 + c.x1) / 2, c.y1]; });
      var fit = fitLine(pts);
      var keep = pts.filter(function (p) { return Math.abs(p[1] - (fit.a + fit.b * p[0])) < 0.12 * hMed; });
      if (keep.length >= 2) fit = fitLine(keep);
      row.forEach(function (c) { c.baseline = fit.a + fit.b * (c.x0 + c.x1) / 2; });
    });
  }

  function fitLine(pts) {
    if (pts.length < 2) return { a: pts.length ? pts[0][1] : 0, b: 0 };
    var n = pts.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach(function (p) { sx += p[0]; sy += p[1]; sxx += p[0] * p[0]; sxy += p[0] * p[1]; });
    var d = n * sxx - sx * sx;
    if (Math.abs(d) < 1e-9) return { a: sy / n, b: 0 };
    var b = (n * sxy - sx * sy) / d;
    if (Math.abs(b) > 0.1) b = 0; // a sloped baseline this steep is a bad fit, not a tilt
    return { a: (sy - b * sx) / n, b: b };
  }

  // The ink of one character, cut out on its own (neighbours' strokes left out).
  function cutOut(ch, labels, w) {
    var pad = 2, x0 = ch.x0 - pad, y0 = ch.y0 - pad, cw = ch.x1 - ch.x0 + 2 * pad, chh = ch.y1 - ch.y0 + 2 * pad;
    var ids = {}, mask = new Uint8Array(cw * chh);
    ch.parts.forEach(function (p) { ids[p.id] = 1; });
    for (var y = 0; y < chh; y++) for (var x = 0; x < cw; x++) {
      var X = x + x0, Y = y + y0;
      if (X >= 0 && Y >= 0 && X < w && ids[labels[Y * w + X]]) mask[y * cw + x] = 1;
    }
    return { mask: mask, w: cw, h: chh, x0: x0, y0: y0 };
  }

  /*
   * Straighten once per photo: returns { gray, angle, paper } to pass to read().
   */
  function prepare(gray, threshold) {
    var soft = IM.blur(gray);
    var first = blobs(soft, IM.paperLevel(soft), threshold);
    var angle = skew(first.list, first.hMed);
    var straight = Math.abs(angle) > 0.002 ? IM.rotate(soft, angle) : soft;
    return { original: gray, gray: straight, angle: angle, paper: IM.paperLevel(straight) };
  }

  /*
   * Read the characters. Returns
   *   { count, expected: 62, order, fit, chars: [{ ch, name, x0, y0, x1, y1, baseline, cut }], hMed }
   * ch is null for every character when the count isn't 62, or when the order can't be told
   * (order is then null).
   */
  function read(prep, threshold) {
    var g = prep.gray, b = blobs(g, prep.paper, threshold);
    var rows = lines(b.list, b.hMed), chars = [];
    rows.forEach(function (row) { row.forEach(function (c) { chars.push(c); }); });
    var result = { count: chars.length, expected: COUNT, order: null, chars: chars, hMed: b.hMed, angle: prep.angle };
    chars.forEach(function (c) { c.cut = cutOut(c, b.labels, g.w); c.ch = null; });
    if (chars.length !== COUNT) return result;
    var o = order(chars);
    result.order = o.name; result.fit = o.fit;
    if (o.fit < 1.12) { result.order = null; return result; } // no order makes the capitals taller: can't tell which is which
    chars.forEach(function (c, i) { c.ch = ORDERS[result.order][i]; c.name = NAMES[c.ch] || c.ch; });
    baselines(rows, b.hMed);
    return result;
  }

  // Where a point of the straightened image is in the photo it came from.
  function toPhoto(prep, x, y) { return IM.unrotate(prep.gray, prep.angle, x, y); }

  return { prepare: prepare, read: read, toPhoto: toPhoto, COUNT: COUNT, ORDERS: ORDERS };
});

/*
 * Paper Hand imaging: straightening the photo and finding the ink.
 *
 *   homography()   4 point pairs -> 3x3 perspective transform
 *   sampleRect()   cut a straightened rectangle (in template millimetres) out of the photo
 *   findMarks()    look for the four black corner squares
 *   inkMask()      threshold one box, then clear specks, stray lines and pinholes
 *
 * A "gray" image is { w, h, data: Uint8ClampedArray } with one byte per pixel.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperHandImaging = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toGray(imageData) {
    var src = imageData.data, n = imageData.width * imageData.height;
    var out = new Uint8ClampedArray(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) out[i] = (src[j] * 77 + src[j + 1] * 150 + src[j + 2] * 29) >> 8;
    return { w: imageData.width, h: imageData.height, data: out };
  }

  // Solve A x = b (n x n) by Gaussian elimination with partial pivoting.
  function solve(A, b) {
    var n = b.length, i, j, k;
    var M = A.map(function (row, r) { return row.concat([b[r]]); });
    for (i = 0; i < n; i++) {
      var p = i;
      for (j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j;
      if (Math.abs(M[p][i]) < 1e-12) return null;
      var t = M[i]; M[i] = M[p]; M[p] = t;
      for (j = i + 1; j < n; j++) {
        var f = M[j][i] / M[i][i];
        for (k = i; k <= n; k++) M[j][k] -= f * M[i][k];
      }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      var s = M[i][n];
      for (j = i + 1; j < n; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return x;
  }

  // H maps each src[i] = [x, y] onto dst[i] = [u, v].
  function homography(src, dst) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = src[i][0], y = src[i][1], u = dst[i][0], v = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    var h = solve(A, b);
    return h ? h.concat([1]) : null;
  }

  function project(H, x, y) {
    var w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  // Straightened copy of rect (template mm) at k pixels per mm. Outside the photo reads as white.
  function sampleRect(gray, H, rect, k) {
    var w = Math.max(1, Math.round(rect.w * k)), h = Math.max(1, Math.round(rect.h * k));
    var out = new Float32Array(w * h), src = gray.data, gw = gray.w, gh = gray.h;
    for (var j = 0; j < h; j++) {
      var my = rect.y + (j + 0.5) / k;
      for (var i = 0; i < w; i++) {
        var mx = rect.x + (i + 0.5) / k;
        var d = H[6] * mx + H[7] * my + H[8];
        var sx = (H[0] * mx + H[1] * my + H[2]) / d - 0.5;
        var sy = (H[3] * mx + H[4] * my + H[5]) / d - 0.5;
        var x0 = Math.floor(sx), y0 = Math.floor(sy);
        if (x0 < 0 || y0 < 0 || x0 >= gw - 1 || y0 >= gh - 1) { out[j * w + i] = 255; continue; }
        var fx = sx - x0, fy = sy - y0, o = y0 * gw + x0;
        var a = src[o] + (src[o + 1] - src[o]) * fx;
        var c = src[o + gw] + (src[o + gw + 1] - src[o + gw]) * fx;
        out[j * w + i] = a + (c - a) * fy;
      }
    }
    return { w: w, h: h, data: out };
  }

  // Connected components of mask (non-zero = on). Returns labels (0 = none) and per-component stats.
  function components(mask, w, h, eight) {
    var labels = new Int32Array(w * h), stack = new Int32Array(w * h), comps = [];
    for (var start = 0; start < w * h; start++) {
      if (!mask[start] || labels[start]) continue;
      var id = comps.length + 1, sp = 0;
      var c = { id: id, area: 0, x0: w, y0: h, x1: -1, y1: -1, sx: 0, sy: 0, edge: false };
      labels[start] = id; stack[sp++] = start;
      while (sp) {
        var p = stack[--sp], x = p % w, y = (p - x) / w;
        c.area++; c.sx += x; c.sy += y;
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
        if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) c.edge = true;
        for (var dy = -1; dy <= 1; dy++) {
          var ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            if (!eight && dx && dy) continue;
            var nx = x + dx; if (nx < 0 || nx >= w) continue;
            var q = ny * w + nx;
            if (mask[q] && !labels[q]) { labels[q] = id; stack[sp++] = q; }
          }
        }
      }
      comps.push(c);
    }
    return { labels: labels, comps: comps };
  }

  function downscale(gray, maxSide) {
    var f = Math.max(1, Math.ceil(Math.max(gray.w, gray.h) / maxSide));
    var w = Math.floor(gray.w / f), h = Math.floor(gray.h / f), out = new Float32Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var s = 0;
      for (var j = 0; j < f; j++) { var row = (y * f + j) * gray.w + x * f; for (var i = 0; i < f; i++) s += gray.data[row + i]; }
      out[y * w + x] = s / (f * f);
    }
    return { w: w, h: h, data: out, f: f };
  }

  // Mean of a (2r+1)^2 window around every pixel, via an integral image.
  function localMean(img, r) {
    var w = img.w, h = img.h, I = new Float64Array((w + 1) * (h + 1)), out = new Float32Array(w * h);
    for (var y = 0; y < h; y++) {
      var run = 0;
      for (var x = 0; x < w; x++) { run += img.data[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + run; }
    }
    for (y = 0; y < h; y++) {
      var ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1);
      for (x = 0; x < w; x++) {
        var xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1);
        var s = I[yb * (w + 1) + xb] - I[ya * (w + 1) + xb] - I[yb * (w + 1) + xa] + I[ya * (w + 1) + xa];
        out[y * w + x] = s / ((yb - ya) * (xb - xa));
      }
    }
    return out;
  }

  // Order 4 points as top-left, top-right, bottom-right, bottom-left (clockwise on screen).
  // The top edge is the one that runs most nearly left to right, so a sheet tilted up to
  // about 45 degrees either way still comes out the right way up.
  function orderQuad(pts) {
    var cx = 0, cy = 0;
    pts.forEach(function (p) { cx += p[0] / 4; cy += p[1] / 4; });
    var s = pts.slice().sort(function (a, b) { return Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx); });
    var best = 0, bestAngle = Infinity;
    for (var i = 0; i < 4; i++) {
      var a = s[i], b = s[(i + 1) % 4], ang = Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0]));
      if (ang < bestAngle) { bestAngle = ang; best = i; }
    }
    return [s[best], s[(best + 1) % 4], s[(best + 2) % 4], s[(best + 3) % 4]];
  }

  function convex(q) {
    var sign = 0;
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      var z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (!z) return false;
      if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
    }
    return true;
  }

  // is p inside the clockwise (on screen) convex quad q?
  function inside(q, p) {
    for (var i = 0; i < 4; i++) {
      var a = q[i], b = q[(i + 1) % 4];
      if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0) return false;
    }
    return true;
  }

  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  /*
   * Look for the four solid squares. Returns { corners, score } in gray's pixels, or null.
   * spanW/spanH/mark are the template's measurements (centre to centre, and the square's side).
   */
  function findMarks(gray, spanW, spanH, mark) {
    var small = downscale(gray, 900), w = small.w, h = small.h;
    var mean = localMean(small, Math.round(Math.max(w, h) / 12));
    var mask = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) mask[i] = small.data[i] < mean[i] * 0.62 && small.data[i] < 150 ? 1 : 0;
    var cc = components(mask, w, h, false);
    var side = Math.max(w, h), minA = Math.pow(side * 0.009, 2), maxA = Math.pow(side * 0.1, 2);
    var cand = cc.comps.filter(function (c) {
      if (c.edge || c.area < minA || c.area > maxA) return false;
      var bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
      return c.area / (bw * bh) > 0.45 && Math.max(bw, bh) / Math.min(bw, bh) < 2.2; // a square turned 45 degrees fills half its box
    }).sort(function (a, b) { return b.area - a.area; }).slice(0, 14);
    if (cand.length < 4) return null;
    cand.forEach(function (c) { c.p = [c.sx / c.area + 0.5, c.sy / c.area + 0.5]; });

    var aspect = spanW / spanH, best = null, n = cand.length;
    for (var a = 0; a < n; a++) for (var b = a + 1; b < n; b++) for (var c = b + 1; c < n; c++) for (var d = c + 1; d < n; d++) {
      var set = [cand[a], cand[b], cand[c], cand[d]];
      var q = orderQuad(set.map(function (s) { return s.p; }));
      if (!convex(q)) continue;
      var top = dist(q[0], q[1]), bottom = dist(q[3], q[2]), left = dist(q[0], q[3]), right = dist(q[1], q[2]);
      var W = (top + bottom) / 2, Hh = (left + right) / 2;
      if (top / bottom > 1.8 || bottom / top > 1.8 || left / right > 1.8 || right / left > 1.8) continue;
      var eAspect = Math.abs(Math.log((W / Hh) / aspect));
      var expect = (mark / spanW * W + mark / spanH * Hh) / 2, eSize = 0, aMin = Infinity, aMax = 0;
      set.forEach(function (s) {
        eSize += Math.abs(Math.log(Math.sqrt(s.area) / expect)) / 4;
        aMin = Math.min(aMin, s.area); aMax = Math.max(aMax, s.area);
      });
      var eSpread = Math.log(aMax / aMin);
      if (eAspect > 0.4 || eSize > 0.55 || eSpread > 1.4) continue;
      // the marks are the outermost squares: a blob of their size outside them means these are something else
      var outside = false;
      for (var o = 0; o < n && !outside; o++) {
        var other = cand[o];
        if (set.indexOf(other) >= 0 || other.area < aMin * 0.5) continue;
        outside = !inside(q, other.p);
      }
      if (outside) continue;
      var score = eAspect + eSize + 0.4 * eSpread;
      if (!best || score < best.score) best = { score: score, set: set };
    }
    if (!best) return null;

    var f = small.f;
    var corners = orderQuad(best.set.map(function (s) {
      var coarse = [s.p[0] * f, s.p[1] * f];
      return refineMark(gray, coarse, Math.sqrt(s.area) * f) || coarse;
    }));
    return { corners: corners, score: best.score };
  }

  // Centre of the dark square near p, measured at full resolution.
  function refineMark(gray, p, side) {
    var r = Math.ceil(side * 1.1), x0 = Math.max(0, Math.round(p[0] - r)), y0 = Math.max(0, Math.round(p[1] - r));
    var x1 = Math.min(gray.w, Math.round(p[0] + r)), y1 = Math.min(gray.h, Math.round(p[1] + r));
    var w = x1 - x0, h = y1 - y0;
    if (w < 4 || h < 4) return null;
    var lo = 255, hi = 0, x, y;
    for (y = y0; y < y1; y++) for (x = x0; x < x1; x++) { var v = gray.data[y * gray.w + x]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < 40) return null;
    var t = (lo + hi) / 2, mask = new Uint8Array(w * h);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) mask[y * w + x] = gray.data[(y + y0) * gray.w + x + x0] < t ? 1 : 0;
    var cc = components(mask, w, h, false), cx = p[0] - x0, cy = p[1] - y0, pick = null, bestD = Infinity;
    cc.comps.forEach(function (c) {
      if (c.area < side * side * 0.3) return;
      var d = Math.hypot(c.sx / c.area - cx, c.sy / c.area - cy);
      if (d < bestD) { bestD = d; pick = c; }
    });
    if (!pick || pick.area > side * side * 3 || bestD > side * 0.6) return null;
    return [pick.sx / pick.area + 0.5 + x0, pick.sy / pick.area + 0.5 + y0];
  }

  function boxBlur(src, w, h) {
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y, i;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x;
      tmp[i] = (src[i] + src[y * w + Math.max(0, x - 1)] + src[y * w + Math.min(w - 1, x + 1)]) / 3;
    }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x;
      out[i] = (tmp[i] + tmp[Math.max(0, y - 1) * w + x] + tmp[Math.min(h - 1, y + 1) * w + x]) / 3;
    }
    return out;
  }

  /*
   * Ink in one straightened box.
   *   threshold: 0..1, how dark (relative to this box's paper) a pixel must be to count as ink
   *   speck:     components smaller than this many pixels are dropped
   * Returns { mask, w, h, box: {x0, y0, x1, y1} | null, area }.
   */
  function inkMask(sample, threshold, speck) {
    var w = sample.w, h = sample.h, n = w * h, src = sample.data;
    // soften sensor noise and JPEG blocks (two 3x3 box blurs, close to a small Gaussian)
    var x, y, i, blur = boxBlur(boxBlur(src, w, h), w, h);
    // the paper's brightness here: the 85th percentile of the box
    var hist = new Uint32Array(256);
    for (i = 0; i < n; i++) hist[Math.max(0, Math.min(255, blur[i] | 0))]++;
    var acc = 0, paper = 255;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.85) { paper = i; break; } }
    paper = Math.max(paper, 60);
    var t = threshold * paper, mask = new Uint8Array(n);
    for (i = 0; i < n; i++) mask[i] = blur[i] < t ? 1 : 0;

    var cc = components(mask, w, h, true), drop = new Uint8Array(cc.comps.length + 1);
    cc.comps.forEach(function (c) {
      var bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
      if (c.area < speck) drop[c.id] = 1;
      // printed lines: the baseline, or a bit of the box outline when the corners are slightly off
      else if ((bw > 0.7 * w && bh < 0.07 * h) || (bh > 0.7 * h && bw < 0.07 * w)) drop[c.id] = 1;
      else if (c.edge && (bw < 0.05 * w || bh < 0.05 * h)) drop[c.id] = 1;
    });
    for (i = 0; i < n; i++) if (mask[i] && drop[cc.labels[i]]) mask[i] = 0;

    // fill pinholes inside strokes
    var inv = new Uint8Array(n);
    for (i = 0; i < n; i++) inv[i] = mask[i] ? 0 : 1;
    var holes = components(inv, w, h, false), fill = new Uint8Array(holes.comps.length + 1), small = Math.max(4, speck * 0.6);
    holes.comps.forEach(function (c) { if (!c.edge && c.area < small) fill[c.id] = 1; });
    for (i = 0; i < n; i++) if (!mask[i] && fill[holes.labels[i]]) mask[i] = 1;

    var box = null, area = 0;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) if (mask[y * w + x]) {
      area++;
      if (!box) box = { x0: x, y0: y, x1: x + 1, y1: y + 1 };
      else {
        if (x < box.x0) box.x0 = x; if (x + 1 > box.x1) box.x1 = x + 1;
        if (y + 1 > box.y1) box.y1 = y + 1;
      }
    }
    return { mask: mask, w: w, h: h, box: box, area: area, paper: paper };
  }

  function sampleAt(gray, H, x, y) {
    var p = project(H, x, y), px = Math.round(p[0]), py = Math.round(p[1]);
    if (px < 0 || py < 0 || px >= gray.w || py >= gray.h) return 255;
    return gray.data[py * gray.w + px];
  }

  /*
   * How well the printed box outlines line up for these corners: how much darker the
   * paper is along the top and bottom edges of every box than 1.2 mm inside them.
   * Turned upside down the rows land 9 mm off, so this tells the right way up from the wrong.
   */
  function gridScore(gray, H, cells) {
    var on = 0, off = 0, n = 0;
    cells.forEach(function (c) {
      for (var x = c.x + 1.5; x < c.x + c.w - 1.5; x += 0.75) {
        on += sampleAt(gray, H, x, c.y) + sampleAt(gray, H, x, c.y + c.h);
        off += sampleAt(gray, H, x, c.y + 1.2) + sampleAt(gray, H, x, c.y + c.h - 1.2);
        n += 2;
      }
    });
    return (off - on) / n;
  }

  // The same gray image turned 90 degrees clockwise.
  function rotateGray(gray) {
    var w = gray.w, h = gray.h, out = new Uint8ClampedArray(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) out[x * h + (h - 1 - y)] = gray.data[y * w + x];
    return { w: h, h: w, data: out };
  }

  return {
    toGray: toGray, homography: homography, project: project, sampleRect: sampleRect,
    components: components, findMarks: findMarks, inkMask: inkMask, gridScore: gridScore, rotateGray: rotateGray,
  };
});

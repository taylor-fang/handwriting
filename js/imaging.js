/*
 * Paper Hand imaging: pixels in, ink out.
 *
 *   toGray()      canvas pixels -> one byte per pixel
 *   blur()        a light 3x3 blur against sensor noise and JPEG blocks
 *   rotate()      turn a gray image about its centre (used to straighten tilted writing)
 *   paperLevel()  how bright the paper is everywhere, and where the paper is at all
 *   inkMask()     pixels clearly darker than the paper around them
 *   components()  connected blobs of ink, with their sizes
 *
 * A gray image is { w, h, data } with one value per pixel (0 black, 255 white).
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

  function blur(g) {
    var w = g.w, h = g.h, src = g.data, tmp = new Float32Array(w * h), out = new Uint8ClampedArray(w * h), x, y, i;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x;
      tmp[i] = (src[i] + src[y * w + Math.max(0, x - 1)] + src[y * w + Math.min(w - 1, x + 1)]) / 3;
    }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x;
      out[i] = (tmp[i] + tmp[Math.max(0, y - 1) * w + x] + tmp[Math.min(h - 1, y + 1) * w + x]) / 3;
    }
    return { w: w, h: h, data: out };
  }

  // Straighten writing whose lines slope down to the right by `angle` radians (up for a negative
  // angle), turning about the centre and keeping the size. Pixel (x, y) of the result comes from
  // unrotate(x, y) of the original. Corners from outside the photo are black, so they are never paper.
  function rotate(g, angle) {
    var w = g.w, h = g.h, out = new Uint8ClampedArray(w * h), src = g.data;
    var c = Math.cos(angle), s = Math.sin(angle), cx = w / 2, cy = h / 2;
    for (var y = 0; y < h; y++) {
      var dy = y + 0.5 - cy;
      for (var x = 0; x < w; x++) {
        var dx = x + 0.5 - cx;
        var sx = cx + dx * c - dy * s - 0.5, sy = cy + dx * s + dy * c - 0.5;
        var x0 = Math.floor(sx), y0 = Math.floor(sy);
        if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
        var fx = sx - x0, fy = sy - y0, o = y0 * w + x0;
        var a = src[o] + (src[o + 1] - src[o]) * fx, b = src[o + w] + (src[o + w + 1] - src[o + w]) * fx;
        out[y * w + x] = a + (b - a) * fy;
      }
    }
    return { w: w, h: h, data: out };
  }

  // Where a point of rotate(g, angle) was in the original image (continuous pixel coordinates).
  function unrotate(g, angle, x, y) {
    var c = Math.cos(angle), s = Math.sin(angle), dx = x - g.w / 2, dy = y - g.h / 2;
    return [g.w / 2 + dx * c - dy * s, g.h / 2 + dx * s + dy * c];
  }

  /*
   * The paper's brightness, in blocks: the 90th percentile of each block, which ignores
   * the ink in it. Blocks much darker than the brightest paper (a table, a shadow beyond
   * the sheet) are not paper, and neither are blocks next to them (the sheet's edge).
   */
  function paperLevel(g) {
    var B = Math.max(16, Math.round(Math.max(g.w, g.h) / 40));
    var bw = Math.ceil(g.w / B), bh = Math.ceil(g.h / B), level = new Float32Array(bw * bh), hist = new Uint32Array(256);
    for (var by = 0; by < bh; by++) for (var bx = 0; bx < bw; bx++) {
      hist.fill(0);
      var n = 0;
      for (var y = by * B; y < Math.min(g.h, (by + 1) * B); y++) for (var x = bx * B; x < Math.min(g.w, (bx + 1) * B); x++) { hist[g.data[y * g.w + x]]++; n++; }
      var acc = 0, v = 0;
      for (v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.9) break; }
      level[by * bw + bx] = v;
    }
    var sorted = Array.prototype.slice.call(level).sort(function (a, b) { return a - b; });
    var bright = sorted[Math.floor(sorted.length * 0.95)], isPaper = new Uint8Array(bw * bh), paper = new Uint8Array(bw * bh);
    for (var i = 0; i < bw * bh; i++) isPaper[i] = level[i] > Math.max(50, bright * 0.6) ? 1 : 0;
    for (by = 0; by < bh; by++) for (bx = 0; bx < bw; bx++) {
      var ok = isPaper[by * bw + bx];
      for (var j = -1; j <= 1 && ok; j++) for (var k = -1; k <= 1 && ok; k++) {
        var yy = by + j, xx = bx + k;
        if (yy >= 0 && xx >= 0 && yy < bh && xx < bw && !isPaper[yy * bw + xx]) ok = 0;
      }
      paper[by * bw + bx] = ok;
    }
    return { B: B, bw: bw, bh: bh, level: level, paper: paper };
  }

  // Ink: darker than `threshold` times the paper around it (0..1; higher keeps fainter strokes).
  function inkMask(g, pl, threshold) {
    var w = g.w, h = g.h, mask = new Uint8Array(w * h), B = pl.B, bw = pl.bw, bh = pl.bh, L = pl.level;
    for (var y = 0; y < h; y++) {
      var fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5)), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
      var rowBlock = Math.min(bh - 1, Math.floor(y / B)) * bw;
      for (var x = 0; x < w; x++) {
        if (!pl.paper[rowBlock + Math.min(bw - 1, Math.floor(x / B))]) continue;
        var fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5)), x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
        var top = L[y0 * bw + x0] + (L[y0 * bw + x1] - L[y0 * bw + x0]) * tx;
        var bot = L[y1 * bw + x0] + (L[y1 * bw + x1] - L[y1 * bw + x0]) * tx;
        if (g.data[y * w + x] < threshold * (top + (bot - top) * ty)) mask[y * w + x] = 1;
      }
    }
    return mask;
  }

  // Connected components of mask (non-zero = on). Returns labels (0 = none) and per-component stats.
  function components(mask, w, h, eight) {
    var labels = new Int32Array(w * h), stack = new Int32Array(w * h), comps = [];
    for (var start = 0; start < w * h; start++) {
      if (!mask[start] || labels[start]) continue;
      var id = comps.length + 1, sp = 0;
      var c = { id: id, area: 0, x0: w, y0: h, x1: 0, y1: 0, edge: false };
      labels[start] = id; stack[sp++] = start;
      while (sp) {
        var p = stack[--sp], x = p % w, y = (p - x) / w;
        c.area++;
        if (x < c.x0) c.x0 = x; if (x + 1 > c.x1) c.x1 = x + 1;
        if (y < c.y0) c.y0 = y; if (y + 1 > c.y1) c.y1 = y + 1;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) c.edge = true;
        for (var dy = -1; dy <= 1; dy++) {
          var ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            if ((!dx && !dy) || (!eight && dx && dy)) continue;
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

  return { toGray: toGray, blur: blur, rotate: rotate, unrotate: unrotate, paperLevel: paperLevel, inkMask: inkMask, components: components };
});

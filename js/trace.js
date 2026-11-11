/*
 * Paper Hand tracing: a black-and-white box becomes smooth outlines.
 *
 *   1. walk the edges between ink and paper pixels into closed loops
 *      (outer edges run clockwise on screen, holes anticlockwise, so they fill correctly)
 *   2. smooth away the pixel staircase
 *   3. drop points that add nothing (Ramer-Douglas-Peucker)
 *   4. join what is left with cubic curves, keeping sharp corners sharp
 *
 * trace(mask, w, h) returns contours in pixel coordinates (y down):
 *   [{ start: [x, y], curves: [[c1x, c1y, c2x, c2y, x, y], ...] }, ...]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperHandTrace = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 1. pixel-edge loops
  function loops(mask, w, h) {
    var W = w + 1, from = [], to = [], dir = [];
    var out1 = new Int32Array(W * (h + 1)).fill(-1), out2 = new Int32Array(W * (h + 1)).fill(-1);
    function add(x0, y0, x1, y1, d) {
      var e = from.length, v = y0 * W + x0;
      from.push(v); to.push(y1 * W + x1); dir.push(d);
      if (out1[v] < 0) out1[v] = e; else out2[v] = e;
    }
    function ink(x, y) { return x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]; }
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!ink(x, y - 1)) add(x, y, x + 1, y, 0); // top, heading right
      if (!ink(x + 1, y)) add(x + 1, y, x + 1, y + 1, 1); // right, heading down
      if (!ink(x, y + 1)) add(x + 1, y + 1, x, y + 1, 2); // bottom, heading left
      if (!ink(x - 1, y)) add(x, y + 1, x, y, 3); // left, heading up
    }
    var used = new Uint8Array(from.length), result = [];
    for (var e0 = 0; e0 < from.length; e0++) {
      if (used[e0]) continue;
      var pts = [], e = e0;
      while (true) {
        used[e] = 1;
        var v = from[e];
        pts.push([v % W, (v - v % W) / W]);
        var end = to[e];
        if (end === from[e0]) break;
        var a = out1[end], b = out2[end], next;
        if (a >= 0 && !used[a] && b >= 0 && !used[b]) {
          // two ways on (pixels touching only at a corner): keep turning right, which keeps them apart
          next = dir[a] === (dir[e] + 1) % 4 ? a : b;
        } else next = a >= 0 && !used[a] ? a : b;
        if (next < 0 || used[next]) break;
        e = next;
      }
      if (pts.length >= 4) result.push(pts);
    }
    return result;
  }

  // 2. smooth a closed polyline with a binomial kernel (wraps around)
  var K9 = [1, 8, 28, 56, 70, 56, 28, 8, 1].map(function (v) { return v / 256; });
  var K3 = [0.25, 0.5, 0.25];
  function smooth(pts) {
    var n = pts.length, k = n >= 24 ? K9 : K3, r = (k.length - 1) / 2, out = new Array(n);
    for (var i = 0; i < n; i++) {
      var x = 0, y = 0;
      for (var j = -r; j <= r; j++) { var p = pts[(i + j + n) % n]; x += p[0] * k[j + r]; y += p[1] * k[j + r]; }
      out[i] = [x, y];
    }
    return out;
  }

  // 3. Ramer-Douglas-Peucker on an open run of points
  function rdp(pts, eps) {
    if (pts.length < 3) return pts.slice();
    var a = pts[0], b = pts[pts.length - 1], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1e-9;
    var idx = 0, max = 0;
    for (var i = 1; i < pts.length - 1; i++) {
      var d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / len;
      if (len < 1e-6) d = Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]);
      if (d > max) { max = d; idx = i; }
    }
    if (max <= eps) return [a, b];
    var l = rdp(pts.slice(0, idx + 1), eps), r = rdp(pts.slice(idx), eps);
    return l.slice(0, -1).concat(r);
  }

  function simplifyClosed(pts, eps) {
    var n = pts.length, far = 0, max = -1;
    for (var i = 1; i < n; i++) {
      var d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
      if (d > max) { max = d; far = i; }
    }
    var a = rdp(pts.slice(0, far + 1), eps), b = rdp(pts.slice(far).concat([pts[0]]), eps);
    var out = a.slice(0, -1).concat(b.slice(0, -1));
    if (out.length < 4) { // a tiny dot: keep a few evenly spaced points so it stays round
      out = [];
      for (var j = 0; j < 6; j++) out.push(pts[Math.floor(j * n / 6)]);
    }
    return out;
  }

  // 4. Catmull-Rom curves through the points; corners sharper than ~60 degrees stay corners
  function curves(pts) {
    var n = pts.length, corner = new Array(n), out = [];
    function P(i) { return pts[(i + n) % n]; }
    for (var i = 0; i < n; i++) {
      var a = P(i - 1), b = P(i), c = P(i + 1);
      var ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
      var cos = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1);
      corner[i] = cos < 0.5;
    }
    function handle(from, dx, dy, limit) {
      var l = Math.hypot(dx, dy);
      if (l > limit && l > 0) { dx *= limit / l; dy *= limit / l; }
      return [from[0] + dx, from[1] + dy];
    }
    for (i = 0; i < n; i++) {
      var p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      var seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), lim = seg * 0.45;
      var c1 = corner[i % n] ? p1 : handle(p1, (p2[0] - p0[0]) / 6, (p2[1] - p0[1]) / 6, lim);
      var c2 = corner[(i + 1) % n] ? p2 : handle(p2, -(p3[0] - p1[0]) / 6, -(p3[1] - p1[1]) / 6, lim);
      out.push([c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]]);
    }
    return { start: pts[0], curves: out };
  }

  function area(pts) {
    var s = 0;
    for (var i = 0, n = pts.length; i < n; i++) { var a = pts[i], b = pts[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; }
    return s / 2;
  }

  function trace(mask, w, h, opts) {
    var eps = (opts && opts.tolerance) || 0.7;
    return loops(mask, w, h).map(function (raw) {
      var soft = smooth(raw);
      if (raw.length >= 60) soft = smooth(soft); // longer edges can take a second pass
      var pts = simplifyClosed(soft, eps);
      var c = curves(pts);
      c.area = area(raw); // > 0: outer edge, < 0: hole (screen coordinates)
      return c;
    });
  }

  return { trace: trace, loops: loops, smooth: smooth, simplifyClosed: simplifyClosed, curves: curves, area: area };
});

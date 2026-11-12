/*
 * Paper Hand font building: traced characters become a font, a .woff and a PaperHand.css.
 *
 * Needs opentype.js (window.opentype). Vertical metrics match Paper's own
 * Paper Hand font: 1000 units per em, ascender 900, descender -300.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperHandFont = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var UPM = 1000, ASCENDER = 900, DESCENDER = -300, CAP_HEIGHT = 700, X_HEIGHT = 470;

  function median(a) {
    if (!a.length) return NaN;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /*
   * One scale for every glyph, so letters keep their real sizes relative to
   * each other: the median capital is made CAP_HEIGHT units tall.
   * glyphs: [{ ch, box: {x0,y0,x1,y1}, baseline }] in pixels.
   */
  function unitsPerPixel(glyphs) {
    var caps = [], smalls = [];
    glyphs.forEach(function (g) {
      if (!g.box) return;
      var tall = g.baseline - g.box.y0;
      if (/[A-Z]/.test(g.ch) && g.ch !== 'Q' && g.ch !== 'J') caps.push(tall);
      if (/[acemnorsuvwxz]/.test(g.ch)) smalls.push(tall);
    });
    if (caps.length >= 3) return CAP_HEIGHT / median(caps);
    if (smalls.length >= 3) return X_HEIGHT / median(smalls);
    return null;
  }

  /*
   * glyphs: [{ ch, name, contours, box, baseline }] (pixels, y down, from the tracer)
   * opts:   { familyName, spacing } spacing = side bearing in font units
   * Returns { font (opentype.Font), scale, metrics: {ch: {advance, yMin, yMax}} }
   */
  function build(opentype, glyphs, opts) {
    opts = opts || {};
    var sb = Math.round(opts.spacing == null ? 75 : opts.spacing);
    var s = unitsPerPixel(glyphs);
    if (!s) throw new Error('Not enough letters found to size the font.');
    var list = [], metrics = {}, advances = [];

    var notdef = new opentype.Path();
    notdef.moveTo(60, 0); notdef.lineTo(60, 700); notdef.lineTo(440, 700); notdef.lineTo(440, 0); notdef.close();
    notdef.moveTo(110, 50); notdef.lineTo(390, 50); notdef.lineTo(390, 650); notdef.lineTo(110, 650); notdef.close();
    list.push(new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 500, path: notdef }));
    var space = new opentype.Glyph({ name: 'space', unicode: 32, advanceWidth: 340, path: new opentype.Path() });
    list.push(space);

    glyphs.forEach(function (g) {
      if (!g.box || !g.contours || !g.contours.length) return;
      var x0 = g.box.x0, base = g.baseline;
      function X(x) { return Math.round((x - x0) * s + sb); }
      function Y(y) { return Math.round((base - y) * s); }
      var path = new opentype.Path();
      g.contours.forEach(function (c) {
        path.moveTo(X(c.start[0]), Y(c.start[1]));
        c.curves.forEach(function (k) { path.curveTo(X(k[0]), Y(k[1]), X(k[2]), Y(k[3]), X(k[4]), Y(k[5])); });
        path.close();
      });
      var adv = Math.round((g.box.x1 - g.box.x0) * s + 2 * sb);
      list.push(new opentype.Glyph({ name: g.name || g.ch, unicode: g.ch.charCodeAt(0), advanceWidth: adv, path: path }));
      metrics[g.ch] = { advance: adv, yMin: Math.round((base - g.box.y1) * s), yMax: Math.round((base - g.box.y0) * s) };
      if (/[a-z]/.test(g.ch)) advances.push(adv);
    });

    // a word space a little narrower than a typical small letter, like Paper's own font (340 next to an x of 454)
    if (advances.length) space.advanceWidth = Math.max(200, Math.min(480, Math.round(median(advances) * 0.72)));

    var family = (opts.familyName || 'Paper Hand').trim() || 'Paper Hand';
    var font = new opentype.Font({
      familyName: family,
      styleName: 'Regular',
      unitsPerEm: UPM,
      ascender: ASCENDER,
      descender: DESCENDER,
      weightClass: 400,
      designer: opts.designer || ' ',
      description: 'Made from handwriting with Paper Hand',
      version: 'Version 1.0',
      glyphs: list,
    });
    return { font: font, scale: s, metrics: metrics };
  }

  async function deflate(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function pad4(n) { return (n + 3) & ~3; }

  // Wrap an OpenType (sfnt) file as WOFF 1.0, compressing each table with zlib when that helps.
  async function sfntToWoff(buffer) {
    var dv = new DataView(buffer), flavor = dv.getUint32(0), num = dv.getUint16(4), tables = [];
    for (var i = 0; i < num; i++) {
      var o = 12 + 16 * i;
      tables.push({ tag: dv.getUint32(o), checksum: dv.getUint32(o + 4), offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) });
    }
    tables.sort(function (a, b) { return a.tag - b.tag; });
    var sfntSize = 12 + 16 * num, offset = 44 + 20 * num;
    for (i = 0; i < num; i++) {
      var t = tables[i], raw = new Uint8Array(buffer, t.offset, t.length);
      var z = await deflate(raw);
      t.data = z && z.length < raw.length ? z : raw;
      t.woffOffset = offset;
      offset += pad4(t.data.length);
      sfntSize += pad4(t.length);
    }
    var out = new Uint8Array(offset), w = new DataView(out.buffer);
    w.setUint32(0, 0x774F4646); // 'wOFF'
    w.setUint32(4, flavor);
    w.setUint32(8, offset);
    w.setUint16(12, num);
    w.setUint16(14, 0);
    w.setUint32(16, sfntSize);
    w.setUint16(20, 1); w.setUint16(22, 0); // font version 1.0
    // metadata and private blocks: none (bytes 24..43 stay 0)
    tables.forEach(function (t, k) {
      var o = 44 + 20 * k;
      w.setUint32(o, t.tag);
      w.setUint32(o + 4, t.woffOffset);
      w.setUint32(o + 8, t.data.length);
      w.setUint32(o + 12, t.length);
      w.setUint32(o + 16, t.checksum);
      out.set(t.data, t.woffOffset);
    });
    return out.buffer;
  }

  function base64(buffer) {
    var bytes = new Uint8Array(buffer), s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // Exactly the shape of Paper's app/assets/PaperHand.css.
  function css(woff, family) {
    return '@font-face { font-family: "' + (family || 'Paper Hand') + '"; src: url(data:font/woff;base64,' + base64(woff) + ') format("woff"); }\n';
  }

  return { build: build, sfntToWoff: sfntToWoff, css: css, base64: base64, UPM: UPM, ASCENDER: ASCENDER, DESCENDER: DESCENDER };
});

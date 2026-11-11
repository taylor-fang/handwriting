/*
 * Paper Hand template layout: the one place that says where every box is.
 *
 * All measurements are in millimetres, measured from the centre of the
 * top-left corner mark. The page (index.html), the template builder
 * (tools/build-template.js) and the tests all read from here, so the printed
 * template and the cutting code can never drift apart.
 *
 * Works as a plain browser script (window.PaperHandLayout) and in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperHandLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LOWER = 'abcdefghijklmnopqrstuvwxyz'.split('');
  var UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  var DIGITS = '0123456789'.split('');
  var EXTRAS = ['.', ',', '!', '?', "'", '-', ':', ';', '(', ')'];
  var CHARS = LOWER.concat(UPPER, DIGITS, EXTRAS);
  var REQUIRED = LOWER.concat(UPPER, DIGITS); // the 62 that Paper's own font has

  var L = {
    // centres of the four corner marks: (0,0) (SPAN_W,0) (SPAN_W,SPAN_H) (0,SPAN_H)
    SPAN_W: 176,
    SPAN_H: 240,
    MARK: 8, // side of each solid black square

    COLS: 8,
    ROWS: 9,
    GRID_X: 8, // left edge of the first column
    GRID_Y: 12, // top edge of the first row
    PITCH_X: 20,
    PITCH_Y: 25,

    BOX_W: 18.5,
    BOX_H: 20.5,
    BASELINE: 13.5, // from the top of a box
    XHEIGHT: 5.5, // dotted guide, this far above the baseline
    INSET: 0.8, // how far inside the box outline the cut starts
  };

  L.LOWER = LOWER;
  L.UPPER = UPPER;
  L.DIGITS = DIGITS;
  L.EXTRAS = EXTRAS;
  L.CHARS = CHARS;
  L.REQUIRED = REQUIRED;

  L.GLYPH_NAMES = {
    '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
    '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
    '.': 'period', ',': 'comma', '!': 'exclam', '?': 'question', "'": 'quotesingle',
    '-': 'hyphen', ':': 'colon', ';': 'semicolon', '(': 'parenleft', ')': 'parenright',
  };

  // marks in the order the page uses everywhere: top-left, top-right, bottom-right, bottom-left
  L.marks = function () {
    return [[0, 0], [L.SPAN_W, 0], [L.SPAN_W, L.SPAN_H], [0, L.SPAN_H]];
  };

  // box i: its character, outline, baseline, and the area that is cut out for tracing
  L.cell = function (i) {
    var col = i % L.COLS, row = Math.floor(i / L.COLS);
    var x = L.GRID_X + col * L.PITCH_X + (L.PITCH_X - L.BOX_W) / 2;
    var y = L.GRID_Y + row * L.PITCH_Y;
    return {
      index: i,
      ch: CHARS[i],
      required: i < REQUIRED.length,
      x: x, y: y, w: L.BOX_W, h: L.BOX_H,
      baseline: y + L.BASELINE,
      cut: { x: x + L.INSET, y: y + L.INSET, w: L.BOX_W - 2 * L.INSET, h: L.BOX_H - 2 * L.INSET },
    };
  };

  L.cells = function () {
    var out = [];
    for (var i = 0; i < CHARS.length; i++) out.push(L.cell(i));
    return out;
  };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  }

  // The printable template as an SVG string, sized in real millimetres.
  L.svg = function () {
    var pad = L.MARK / 2;
    var vw = L.SPAN_W + L.MARK, vh = L.SPAN_H + L.MARK;
    var font = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
    var o = [];
    o.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + vw + 'mm" height="' + vh + 'mm" viewBox="' + (-pad) + ' ' + (-pad) + ' ' + vw + ' ' + vh + '">');
    o.push('<title>Paper Hand handwriting template</title>');
    o.push('<rect x="' + (-pad) + '" y="' + (-pad) + '" width="' + vw + '" height="' + vh + '" fill="#fff"/>');
    L.marks().forEach(function (m) {
      o.push('<rect x="' + (m[0] - pad) + '" y="' + (m[1] - pad) + '" width="' + L.MARK + '" height="' + L.MARK + '" fill="#000"/>');
    });
    o.push('<text x="' + L.SPAN_W / 2 + '" y="3.4" text-anchor="middle" font-family="' + font + '" font-size="3.6" font-weight="600" fill="#8c6640">Paper Hand template</text>');
    o.push('<text x="' + L.SPAN_W / 2 + '" y="8.2" text-anchor="middle" font-family="' + font + '" font-size="2.5" fill="#9a8466">Dark pen, one character per box. Small letters reach the dotted line, g j p q y hang below the baseline.</text>');
    o.push('<g font-family="' + font + '" font-size="2.7" fill="#a68a68">');
    L.cells().forEach(function (c) {
      var r = function (n) { return Math.round(n * 100) / 100; };
      o.push('<rect x="' + r(c.x) + '" y="' + r(c.y) + '" width="' + c.w + '" height="' + c.h + '" rx="0.6" fill="none" stroke="#c4b49b" stroke-width="0.3"/>');
      o.push('<line x1="' + r(c.x + 0.6) + '" y1="' + r(c.baseline) + '" x2="' + r(c.x + c.w - 0.6) + '" y2="' + r(c.baseline) + '" stroke="#d2c3ab" stroke-width="0.3"/>');
      o.push('<line x1="' + r(c.x + 0.6) + '" y1="' + r(c.baseline - L.XHEIGHT) + '" x2="' + r(c.x + c.w - 0.6) + '" y2="' + r(c.baseline - L.XHEIGHT) + '" stroke="#e0d5c4" stroke-width="0.25" stroke-dasharray="0.8 0.8"/>');
      o.push('<text x="' + r(c.x + 0.5) + '" y="' + r(c.y + c.h + 2.75) + '"' + (c.required ? '' : ' font-style="italic"') + '>' + esc(c.ch) + (c.required ? '' : ' <tspan font-size="2">optional</tspan>') + '</text>');
    });
    o.push('</g>');
    o.push('<text x="' + L.SPAN_W / 2 + '" y="' + (L.SPAN_H + 1.4) + '" text-anchor="middle" font-family="' + font + '" font-size="2.5" fill="#9a8466">Keep all four black squares in the photo. Any print size works, as long as nothing is cut off.</text>');
    o.push('</svg>');
    return o.join('\n') + '\n';
  };

  return L;
});

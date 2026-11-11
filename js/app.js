/*
 * Paper Hand page: wires the five steps together.
 * State is on window.PaperHand.state, which also makes it easy to poke at from the console.
 */
(function () {
  'use strict';
  var L = window.PaperHandLayout, IM = window.PaperHandImaging, TR = window.PaperHandTrace, FB = window.PaperHandFont;
  var K = 12; // pixels per millimetre when cutting out a box
  var MAX_SIDE = 2800; // photos are scaled down to this before anything else
  var CELLS = L.cells();

  var state = {
    canvas: null, gray: null, scale: 1, turns: 0, corners: null, auto: false, H: null,
    samples: null, results: null,
    threshold: 0.55, speck: 0.15, spacing: 45, name: 'Paper Hand',
    built: null, otf: null, woff: null, css: null, face: null, seq: 0, want: 0, ready: false,
  };

  function $(id) { return document.getElementById(id); }
  function note(id, text, kind) { var el = $(id); el.textContent = text || ''; el.className = 'note' + (kind ? ' ' + kind : ''); }
  function unlock(id) { $(id).classList.remove('waiting'); }
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  /* ---------- step 3: the photo ---------- */

  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('This file could not be opened as an image.')); };
      img.src = url;
    });
  }

  async function loadFile(file) {
    if (!file) return;
    note('cornerNote', 'Opening the photo.');
    var src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) {
      try { src = await loadViaImg(file); }
      catch (err) { unlock('step3'); note('cornerNote', err.message + ' Try a JPEG or PNG.', 'warn'); return; }
    }
    var w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
    var s = Math.min(1, MAX_SIDE / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    state.turns = 0;
    setImage(c, s);
  }

  function setImage(c, scale, turns) {
    var photo = $('photo');
    photo.width = c.width; photo.height = c.height;
    photo.getContext('2d').drawImage(c, 0, 0);
    state.canvas = photo;
    state.scale = scale;
    state.gray = IM.toGray(photo.getContext('2d').getImageData(0, 0, c.width, c.height));
    $('overlay').setAttribute('viewBox', '0 0 ' + c.width + ' ' + c.height);
    unlock('step3');
    detect(turns || 0);
  }

  function rotate(turns) {
    if (!state.canvas) return;
    var src = state.canvas, c = document.createElement('canvas');
    c.width = src.height; c.height = src.width;
    var ctx = c.getContext('2d');
    ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2);
    ctx.drawImage(src, 0, 0);
    state.turns = (state.turns + 1) % 4; // quarter turns clockwise from the photo as uploaded
    setImage(c, state.scale, turns);
  }

  // Find the corner marks. A sideways photo is turned (once each way at most), and a sheet
  // that is upside down is read the right way round by checking where the box outlines fall.
  function detect(turns) {
    turns = turns || 0;
    var found = IM.findMarks(state.gray, L.SPAN_W, L.SPAN_H, L.MARK);
    if (!found && turns === 0 && IM.findMarks(IM.rotateGray(state.gray), L.SPAN_W, L.SPAN_H, L.MARK)) {
      rotate(1); // the sheet is sideways in the photo
      return;
    }
    if (found) {
      var q = found.corners, flipped = [q[2], q[3], q[0], q[1]];
      var up = IM.gridScore(state.gray, IM.homography(L.marks(), q), CELLS);
      var down = IM.gridScore(state.gray, IM.homography(L.marks(), flipped), CELLS);
      state.corners = down > up ? flipped : q;
      state.auto = true;
      note('cornerNote', 'Found the four corner squares. Check that each circle sits on the middle of its square.', 'ok');
    } else {
      var w = state.gray.w, h = state.gray.h, mx = w * 0.12, my = h * 0.12;
      state.corners = [[mx, my], [w - mx, my], [w - mx, h - my], [mx, h - my]];
      state.auto = false;
      note('cornerNote', "Couldn't find the corner squares by myself. Drag each circle onto the middle of its black square: the top-left circle goes on the top-left square of the sheet.", 'warn');
    }
    placeHandles();
    straighten();
  }

  function setCorners(corners) {
    state.corners = corners.map(function (p) { return [p[0], p[1]]; });
    placeHandles();
    straighten();
  }

  var handles = Array.prototype.slice.call(document.querySelectorAll('.handle'));

  function placeHandles() {
    var W = state.canvas.width, H = state.canvas.height;
    handles.forEach(function (el, i) {
      el.style.left = (state.corners[i][0] / W * 100) + '%';
      el.style.top = (state.corners[i][1] / H * 100) + '%';
    });
    drawOverlay();
  }

  // the corner quad, plus every box outline projected onto the photo
  function drawOverlay() {
    var svg = $('overlay'), q = state.corners;
    var Hm = IM.homography(L.marks(), q), parts = [];
    parts.push('<polygon points="' + q.map(function (p) { return p.join(','); }).join(' ') + '" fill="none" stroke="#8c6640" stroke-width="2" vector-effect="non-scaling-stroke"/>');
    if (Hm) {
      var d = '';
      CELLS.forEach(function (c) {
        var pts = [[c.x, c.y], [c.x + c.w, c.y], [c.x + c.w, c.y + c.h], [c.x, c.y + c.h]].map(function (p) { return IM.project(Hm, p[0], p[1]); });
        d += 'M' + pts.map(function (p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join('L') + 'Z';
      });
      parts.push('<path d="' + d + '" fill="rgba(140,102,64,.06)" stroke="#c0392b" stroke-opacity=".75" stroke-width="1" vector-effect="non-scaling-stroke"/>');
    }
    svg.innerHTML = parts.join('');
  }

  // dragging, with a magnifier so a fingertip doesn't hide the mark
  var drag = null;
  function pointerToImage(e) {
    var r = state.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * state.canvas.width, (e.clientY - r.top) / r.height * state.canvas.height];
  }
  function clampPoint(p) {
    return [Math.max(0, Math.min(state.canvas.width, p[0])), Math.max(0, Math.min(state.canvas.height, p[1]))];
  }
  handles.forEach(function (el) {
    var i = +el.dataset.i;
    el.addEventListener('pointerdown', function (e) {
      if (!state.canvas) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      var p = pointerToImage(e);
      drag = { i: i, dx: state.corners[i][0] - p[0], dy: state.corners[i][1] - p[1] };
      el.classList.add('dragging');
      showLoupe(i);
    });
    el.addEventListener('pointermove', function (e) {
      if (!drag || drag.i !== i) return;
      var p = pointerToImage(e);
      state.corners[i] = clampPoint([p[0] + drag.dx, p[1] + drag.dy]);
      placeHandles();
      showLoupe(i);
    });
    function end() {
      if (!drag || drag.i !== i) return;
      drag = null;
      el.classList.remove('dragging');
      $('loupe').style.display = 'none';
      state.auto = false;
      straighten();
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', function (e) {
      var keys = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }, k = keys[e.key];
      if (!k || !state.canvas) return;
      e.preventDefault();
      var r = state.canvas.getBoundingClientRect(), step = (e.shiftKey ? 10 : 1) * state.canvas.width / r.width;
      state.corners[i] = clampPoint([state.corners[i][0] + k[0] * step, state.corners[i][1] + k[1] * step]);
      placeHandles();
      straightenSoon();
    });
  });

  function showLoupe(i) {
    var loupe = $('loupe'), ctx = loupe.getContext('2d'), p = state.corners[i];
    var r = state.canvas.getBoundingClientRect(), zoom = 3, size = loupe.width;
    var span = size / zoom * state.canvas.width / r.width; // image pixels across the loupe
    var onLeft = p[0] / state.canvas.width < 0.5; // show the loupe on the other side
    loupe.style.left = onLeft ? 'auto' : '8px';
    loupe.style.right = onLeft ? '8px' : 'auto';
    loupe.style.display = 'block';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(state.canvas, p[0] - span / 2, p[1] - span / 2, span, span, 0, 0, size, size);
    ctx.strokeStyle = '#d33'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size); ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2); ctx.stroke();
  }

  /* ---------- step 4: cut, threshold, clean ---------- */

  var straightenSoon = debounce(straighten, 250);

  function straighten() {
    var Hm = IM.homography(L.marks(), state.corners);
    if (!Hm) { note('cornerNote', 'Those corners overlap. Spread them out over the four black squares.', 'warn'); return; }
    state.H = Hm;
    state.samples = CELLS.map(function (c) { return IM.sampleRect(state.gray, Hm, c.cut, K); });
    drawFlat();
    unlock('step4');
    processAll();
  }

  function drawFlat() {
    var k = 2.5, pad = L.MARK / 2;
    var s = IM.sampleRect(state.gray, state.H, { x: -pad, y: -pad, w: L.SPAN_W + L.MARK, h: L.SPAN_H + L.MARK }, k);
    var c = $('flat'), img = new ImageData(s.w, s.h);
    for (var i = 0; i < s.w * s.h; i++) { var v = s.data[i]; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
    c.width = s.w; c.height = s.h;
    c.getContext('2d').putImageData(img, 0, 0);
  }

  function processAll() {
    if (!state.samples) return;
    var speckPx = state.speck * K * K;
    state.results = state.samples.map(function (s) { return IM.inkMask(s, state.threshold, speckPx); });
    renderCells();
    rebuildSoon();
  }

  var cellEls = [];
  function renderCells() {
    var box = $('cells');
    if (!cellEls.length) {
      CELLS.forEach(function (c) {
        var d = document.createElement('div'), cv = document.createElement('canvas'), sp = document.createElement('span');
        d.className = 'cell' + (c.required ? '' : ' optional');
        sp.textContent = c.ch;
        d.appendChild(cv); d.appendChild(sp); box.appendChild(d);
        cellEls.push({ el: d, canvas: cv });
      });
    }
    var found = 0, extras = 0, missing = [];
    state.results.forEach(function (r, i) {
      var c = CELLS[i], ce = cellEls[i], cv = ce.canvas;
      if (cv.width !== r.w) { cv.width = r.w; cv.height = r.h; }
      var ctx = cv.getContext('2d'), img = ctx.createImageData(r.w, r.h), d = img.data;
      for (var p = 0; p < r.w * r.h; p++) {
        var on = r.mask[p];
        d[p * 4] = on ? 20 : 255; d[p * 4 + 1] = on ? 18 : 253; d[p * 4 + 2] = on ? 15 : 248; d[p * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      var by = (c.baseline - c.cut.y) * K;
      ctx.fillStyle = 'rgba(140,102,64,.45)';
      ctx.fillRect(0, Math.round(by), r.w, 1.5);
      ce.el.classList.toggle('missing', !r.box);
      if (r.box) { if (c.required) found++; else extras++; }
      else if (c.required) missing.push(c.ch);
    });
    var text = found + ' of 62 letters and numbers found, plus ' + extras + ' of ' + L.EXTRAS.length + ' optional marks.';
    if (missing.length) text += ' Empty: ' + missing.join(' ') + '. Those boxes will be left out of the font.';
    note('cellNote', text, missing.length ? 'warn' : 'ok');
  }

  /* ---------- step 5: the font ---------- */

  var buildSoon = debounce(function () { build(); }, 200);
  function rebuildSoon() { state.ready = false; state.want++; buildSoon(); }

  function glyphInputs() {
    return state.results.map(function (r, i) {
      var c = CELLS[i];
      if (!r.box) return { ch: c.ch, box: null };
      return {
        ch: c.ch,
        name: L.GLYPH_NAMES[c.ch] || c.ch,
        contours: TR.trace(r.mask, r.w, r.h),
        box: r.box,
        baseline: (c.baseline - c.cut.y) * K,
      };
    });
  }

  async function build() {
    if (!state.results) return;
    if (!window.opentype) { unlock('step5'); note('fontNote', 'The font builder (opentype.js) did not load. Check your internet connection and reload the page.', 'warn'); return; }
    var seq = ++state.seq, want = state.want;
    state.ready = false;
    setDownloads(false);
    var built, otf, woff;
    try {
      built = FB.build(window.opentype, glyphInputs(), { familyName: state.name, spacing: state.spacing });
      otf = built.font.toArrayBuffer();
      woff = await FB.sfntToWoff(otf);
    } catch (e) {
      unlock('step5');
      note('fontNote', 'Could not build the font: ' + e.message, 'warn');
      return;
    }
    if (seq !== state.seq) return; // a newer build has started
    var family = 'Paper Hand Preview ' + seq, face = new FontFace(family, woff);
    try { await face.load(); }
    catch (e) { note('fontNote', 'The browser could not read the new font: ' + e.message, 'warn'); return; }
    if (seq !== state.seq) return;
    document.fonts.add(face);
    if (state.face) document.fonts.delete(state.face);
    state.face = face;
    state.built = built; state.otf = otf; state.woff = woff; state.css = FB.css(woff, 'Paper Hand');
    var stack = '"' + family + '", Inter, sans-serif';
    $('try').style.fontFamily = stack;
    fitTextarea();
    document.querySelector('.paperbar').style.setProperty('--hand', stack);
    unlock('step5');
    setDownloads(true);
    var n = built.font.glyphs.length - 2;
    note('fontNote', 'Font ready: ' + n + ' characters. PaperHand.css is ' + Math.round(state.css.length / 1024) + ' KB.', 'ok');
    state.ready = want === state.want; // false if more changes came in meanwhile
    document.dispatchEvent(new CustomEvent('paperhand:built'));
  }

  function fitTextarea() {
    var t = $('try');
    t.style.height = 'auto';
    t.style.height = (t.scrollHeight + 4) + 'px';
  }

  function setDownloads(on) { ['getCss', 'getWoff', 'getOtf'].forEach(function (id) { $(id).disabled = !on; }); }

  function slug(name) {
    return (name || 'Paper Hand').trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'PaperHand';
  }

  function save(filename, data, type) {
    var url = URL.createObjectURL(new Blob([data], { type: type }));
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  /* ---------- wiring ---------- */

  $('file').addEventListener('change', function (e) { loadFile(e.target.files[0]); });
  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
  $('redetect').addEventListener('click', function () { if (state.gray) detect(1); });
  $('rotate').addEventListener('click', function () { rotate(1); }); // turn by hand: don't turn it back automatically

  $('threshold').addEventListener('input', function (e) {
    state.threshold = +e.target.value;
    $('thresholdOut').textContent = Math.round(state.threshold * 100) + '%';
    requestAnimationFrame(processAll);
  });
  $('speck').addEventListener('input', function (e) {
    state.speck = +e.target.value;
    $('speckOut').textContent = state.speck.toFixed(2);
    requestAnimationFrame(processAll);
  });
  $('spacing').addEventListener('input', function (e) {
    state.spacing = +e.target.value;
    $('spacingOut').textContent = state.spacing;
    rebuildSoon();
  });
  $('try').addEventListener('input', fitTextarea);
  window.addEventListener('resize', debounce(fitTextarea, 100));
  $('name').addEventListener('input', function (e) { state.name = e.target.value; rebuildSoon(); });

  $('getCss').addEventListener('click', function () { if (state.css) save('PaperHand.css', state.css, 'text/css'); });
  $('getWoff').addEventListener('click', function () { if (state.woff) save(slug(state.name) + '.woff', state.woff, 'font/woff'); });
  $('getOtf').addEventListener('click', function () { if (state.otf) save(slug(state.name) + '.otf', state.otf, 'font/otf'); });

  window.PaperHand = { state: state, setCorners: setCorners, detect: detect, build: build, K: K, cells: CELLS };
})();

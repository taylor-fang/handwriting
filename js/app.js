/*
 * Paper Hand page: upload a photo, download a font.
 * State is on window.PaperHand.state, which also makes it easy to poke at from the console.
 */
(function () {
  'use strict';
  var IM = window.PaperHandImaging, RD = window.PaperHandReader, TR = window.PaperHandTrace, FB = window.PaperHandFont;
  var MAX_SIDE = 2400; // photos are scaled down to this before anything else

  var state = {
    scale: 1, prep: null, reading: null,
    threshold: 0.6, spacing: 75, // side bearing in font units, as in Paper's own font
    built: null, otf: null, woff: null, css: null, face: null, seq: 0, want: 0, ready: false, busy: false,
  };

  function $(id) { return document.getElementById(id); }
  function say(text) { $('msg').textContent = text || ''; } // only for things that need the person's attention
  function debounce(fn, ms) { var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  /* ---------- the photo ---------- */

  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
      img.src = url;
    });
  }

  async function loadFile(file) {
    if (!file) return;
    say('');
    state.busy = true;
    var src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) {
      try { src = await loadViaImg(file); }
      catch (err) { state.busy = false; say('That file is not a photo this browser can open. Try a JPEG or PNG.'); return; }
    }
    var w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
    var s = Math.min(1, MAX_SIDE / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    var ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, c.width, c.height);
    state.scale = s;
    await new Promise(function (r) { setTimeout(r, 30); }); // let the page paint before the heavy lifting
    state.prep = RD.prepare(IM.toGray(ctx.getImageData(0, 0, c.width, c.height)), state.threshold);
    document.body.classList.add('loaded');
    readAll();
  }

  /* ---------- reading the characters ---------- */

  function readAll() {
    if (!state.prep) return;
    state.busy = true;
    var r = state.reading = RD.read(state.prep, state.threshold);
    renderCells();
    if (r.count !== r.expected) {
      say('Found ' + r.count + ' characters, expected ' + r.expected + '.');
      state.ready = false; state.want++; state.busy = false;
      setDownloads(false);
      document.body.classList.remove('ready');
      return;
    }
    if (!r.order) {
      say('Write a to z, then A to Z, then 0 to 9.');
      state.ready = false; state.want++; state.busy = false;
      setDownloads(false);
      document.body.classList.remove('ready');
      return;
    }
    say('');
    rebuildSoon();
  }

  // every shape that was found, drawn at one scale on its baseline, with what it was read as
  function renderCells() {
    var box = $('cells'), r = state.reading;
    box.textContent = '';
    var s = 50 / Math.max.apply(null, r.chars.map(function (c) { return c.y1 - c.y0; }).concat([1]));
    r.chars.forEach(function (c) {
      var d = document.createElement('div'), cv = document.createElement('canvas'), cut = c.cut;
      d.className = 'cell';
      cv.width = 64; cv.height = 84;
      var tmp = document.createElement('canvas');
      tmp.width = cut.w; tmp.height = cut.h;
      var tctx = tmp.getContext('2d'), img = tctx.createImageData(cut.w, cut.h);
      for (var p = 0; p < cut.w * cut.h; p++) if (cut.mask[p]) img.data[p * 4 + 3] = 255;
      tctx.putImageData(img, 0, 0);
      var base = c.baseline != null ? c.baseline : c.y1;
      var dw = cut.w * s, dh = cut.h * s, top = 62 - (base - cut.y0) * s;
      cv.getContext('2d').drawImage(tmp, (64 - dw) / 2, top, dw, dh);
      d.appendChild(cv);
      if (c.ch) { var sp = document.createElement('span'); sp.textContent = c.ch; d.appendChild(sp); }
      box.appendChild(d);
    });
  }

  /* ---------- the font ---------- */

  var buildSoon = debounce(function () { build(); }, 150);
  function rebuildSoon() { state.ready = false; state.want++; buildSoon(); }

  function glyphInputs() {
    return state.reading.chars.map(function (c) {
      var cut = c.cut;
      return {
        ch: c.ch,
        name: c.name,
        contours: TR.trace(cut.mask, cut.w, cut.h),
        box: { x0: c.x0 - cut.x0, y0: c.y0 - cut.y0, x1: c.x1 - cut.x0, y1: c.y1 - cut.y0 },
        baseline: c.baseline - cut.y0,
      };
    });
  }

  async function build() {
    if (!state.reading || !state.reading.order) return;
    if (!window.opentype) { state.busy = false; say('Could not load the font builder. Check the connection and reload.'); return; }
    var seq = ++state.seq, want = state.want;
    state.ready = false;
    setDownloads(false);
    var built, otf, woff;
    try {
      built = FB.build(window.opentype, glyphInputs(), { familyName: 'Paper Hand', spacing: state.spacing });
      otf = built.font.toArrayBuffer();
      woff = await FB.sfntToWoff(otf);
    } catch (e) {
      state.busy = false;
      say('Could not make a font from this photo. Try the Ink slider, or a clearer photo.');
      return;
    }
    if (seq !== state.seq) return; // a newer build has started
    var family = 'Paper Hand Preview ' + seq, face = new FontFace(family, woff);
    try { await face.load(); }
    catch (e) { state.busy = false; say('Could not make a font from this photo.'); return; }
    if (seq !== state.seq) return;
    document.fonts.add(face);
    if (state.face) document.fonts.delete(state.face);
    state.face = face;
    state.built = built; state.otf = otf; state.woff = woff; state.css = FB.css(woff, 'Paper Hand');
    $('try').style.fontFamily = '"' + family + '", Inter, sans-serif';
    document.body.classList.add('ready');
    setDownloads(true);
    state.ready = want === state.want; // false if more changes came in meanwhile
    state.busy = !state.ready;
  }

  function setDownloads(on) {
    $('getCss').disabled = !on;
    ['getWoff', 'getOtf'].forEach(function (id) { $(id).setAttribute('aria-disabled', on ? 'false' : 'true'); });
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
  // a photo dropped anywhere on the page works too
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

  var readSoon = debounce(readAll, 150);
  $('threshold').addEventListener('input', function (e) { state.threshold = +e.target.value; state.busy = true; readSoon(); });

  $('getCss').addEventListener('click', function () { if (state.css) save('PaperHand.css', state.css, 'text/css'); });
  $('getWoff').addEventListener('click', function (e) { e.preventDefault(); if (state.woff) save('PaperHand.woff', state.woff, 'font/woff'); });
  $('getOtf').addEventListener('click', function (e) { e.preventDefault(); if (state.otf) save('PaperHand.otf', state.otf, 'font/otf'); });

  window.PaperHand = {
    state: state,
    // a point of the straightened, scaled-down image, in the pixels of the photo as uploaded
    toPhoto: function (x, y) { var p = RD.toPhoto(state.prep, x, y); return [p[0] / state.scale, p[1] / state.scale]; },
  };
})();

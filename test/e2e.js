#!/usr/bin/env node
/*
 * End-to-end test: opens index.html from disk in headless Chromium, uploads a
 * synthetic photo (test/make_sample.py), checks the automatic corner finder,
 * drags the four corner handles onto the marks, waits for the font and checks it.
 *
 *   node test/e2e.js SAMPLE_DIR OUT_DIR            full run, downloads + screenshots into OUT_DIR
 *   node test/e2e.js SAMPLE_DIR OUT_DIR --detect   only check corner detection
 *
 * Needs Playwright with Chromium. opentype.js is served from a local copy
 * (fetched once from npm into test/.cache) in place of the CDN, byte for byte,
 * so the page's integrity hash is checked too.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) {
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
  }
}
const { chromium } = loadPlaywright();

const ROOT = path.join(__dirname, '..');
const OPENTYPE_URL = 'https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js';

function opentypeLocal() {
  const cache = path.join(__dirname, '.cache');
  const file = path.join(cache, 'package', 'dist', 'opentype.min.js');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(cache, { recursive: true });
    execSync('npm pack opentype.js@1.3.4 --silent', { cwd: cache });
    execSync('tar xzf opentype.js-1.3.4.tgz', { cwd: cache });
  }
  return fs.readFileSync(file);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  (' + detail + ')' : ''}`);
}

(async () => {
  const [sampleDir, outDir] = process.argv.slice(2);
  const detectOnly = process.argv.includes('--detect');
  if (!sampleDir || !outDir) { console.error('usage: node test/e2e.js SAMPLE_DIR OUT_DIR [--detect]'); process.exit(2); }
  fs.mkdirSync(outDir, { recursive: true });
  const truth = JSON.parse(fs.readFileSync(path.join(sampleDir, 'truth.json'), 'utf8'));
  const photoMmPx = Math.hypot(truth.marks[1][0] - truth.marks[0][0], truth.marks[1][1] - truth.marks[0][1]) / 176;

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const otjs = opentypeLocal();
  await page.route(OPENTYPE_URL, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: otjs, headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  await page.goto('file://' + path.join(ROOT, 'index.html'));
  check('opentype.js loaded (integrity hash matches)', await page.evaluate(() => !!window.opentype));

  // upload, then let the page look for the corners on its own
  await page.setInputFiles('#file', path.join(sampleDir, 'photo.jpg'));
  await page.waitForFunction(() => window.PaperHand.state.corners && window.PaperHand.state.results, null, { timeout: 30000 });
  const det = await page.evaluate(() => ({ auto: window.PaperHand.state.auto, corners: window.PaperHand.state.corners, scale: window.PaperHand.state.scale, turns: window.PaperHand.state.turns }));
  // if the page turned the photo, turn the true positions with it (quarter turns clockwise)
  for (let t = 0, w = truth.width, h = truth.height; t < det.turns; t++, [w, h] = [h, w]) truth.marks = truth.marks.map(([x, y]) => [h - y, x]);
  if (det.turns) console.log(`      (the page turned the photo ${det.turns * 90} degrees)`);
  const errsMm = det.corners.map((c, i) => Math.hypot(c[0] / det.scale - truth.marks[i][0], c[1] / det.scale - truth.marks[i][1]) / photoMmPx);
  const maxErr = Math.max(...errsMm);
  check('corner marks found automatically', det.auto && maxErr < 1, `max error ${maxErr.toFixed(2)} mm`);
  if (detectOnly) {
    await browser.close();
    fs.writeFileSync(path.join(outDir, 'detect.json'), JSON.stringify({ auto: det.auto, turns: det.turns, errorsMm: errsMm }, null, 1));
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }

  // drag each handle onto its mark, as a person would (first pull it well off, to test the drag itself)
  async function dragHandle(i, target) {
    const h = page.locator(`.handle[data-i="${i}"]`);
    await h.scrollIntoViewIfNeeded();
    const b = await h.boundingBox();
    const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const canvasBox = await page.locator('#photo').boundingBox();
    const size = await page.evaluate(() => [window.PaperHand.state.canvas.width, window.PaperHand.state.canvas.height]);
    const to = { x: canvasBox.x + target[0] / size[0] * canvasBox.width, y: canvasBox.y + target[1] / size[1] * canvasBox.height };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2 + 30, (from.y + to.y) / 2 + 30, { steps: 5 });
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
  }
  const offsets = [[60, 50], [-60, 50], [-60, -50], [60, -50]];
  for (let i = 0; i < 4; i++) {
    const c = det.corners[i];
    await dragHandle(i, [c[0] + offsets[i][0] * det.scale * 4, c[1] + offsets[i][1] * det.scale * 4]);
  }
  const off = await page.evaluate(() => window.PaperHand.state.corners);
  check('handles move when dragged', off.every((c, i) => Math.hypot(c[0] - det.corners[i][0], c[1] - det.corners[i][1]) > 100));
  for (let i = 0; i < 4; i++) await dragHandle(i, [truth.marks[i][0] * det.scale, truth.marks[i][1] * det.scale]);
  const manual = await page.evaluate(() => window.PaperHand.state.corners);
  const manErr = Math.max(...manual.map((c, i) => Math.hypot(c[0] / det.scale - truth.marks[i][0], c[1] / det.scale - truth.marks[i][1]) / photoMmPx));
  check('handles dragged onto the marks', manErr < 1, `max error ${manErr.toFixed(2)} mm`);

  await page.waitForFunction(() => window.PaperHand.state.ready, null, { timeout: 30000 });

  const info = await page.evaluate(async () => {
    const st = window.PaperHand.state, font = st.built.font;
    const req = window.PaperHandLayout.REQUIRED;
    const glyphs = {};
    for (const ch of req) {
      const index = font.charToGlyphIndex(ch), g = index ? font.glyphs.get(index) : null;
      const bb = g && g.path.commands.length ? g.getBoundingBox() : null;
      glyphs[ch] = { index, commands: g ? g.path.commands.length : 0, adv: g ? g.advanceWidth : 0, bb: bb && { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 } };
    }
    // does the woff load as a web font on its own?
    const face = new FontFace('E2E Check', st.woff);
    let status;
    try { await face.load(); status = face.status; } catch (e) { status = 'error: ' + e.message; }
    document.fonts.add(face);
    const span = document.createElement('span');
    span.textContent = 'Handwriting';
    span.style.cssText = 'position:absolute;white-space:nowrap;font:48px monospace';
    document.body.appendChild(span);
    const mono = span.getBoundingClientRect().width;
    span.style.fontFamily = '"E2E Check", monospace';
    const mine = span.getBoundingClientRect().width;
    span.remove();
    const expected = [...'Handwriting'].reduce((w, ch) => w + font.glyphs.get(font.charToGlyphIndex(ch)).advanceWidth, 0) * 48 / font.unitsPerEm;
    const cells = document.querySelectorAll('#cells .cell').length;
    const missing = document.querySelectorAll('#cells .cell.missing:not(.optional)').length;
    return { glyphs, status, mono, mine, expected, cells, missing, woffBytes: st.woff.byteLength, cssBytes: st.css.length, unitsPerMm: st.built.scale * window.PaperHand.K, note: document.getElementById('fontNote').textContent, count: font.glyphs.length };
  });
  const req = Object.keys(info.glyphs);
  const nonEmpty = req.filter((ch) => info.glyphs[ch].index > 0 && info.glyphs[ch].commands > 0);
  const skipped = (truth.skipped || []).filter((ch) => req.includes(ch));
  const wantGlyphs = 62 - skipped.length;
  check(`${wantGlyphs} required glyphs present with outlines`, nonEmpty.length === wantGlyphs && skipped.every((ch) => !nonEmpty.includes(ch)),
    `${nonEmpty.length}/62, font has ${info.count} glyphs incl. .notdef and space` + (skipped.length ? `, left empty on purpose: ${skipped.join(' ')}` : ''));
  check('72 preview cells shown, empty boxes flagged', info.cells === 72 && info.missing === skipped.length, `${info.cells} cells, ${info.missing} flagged as empty`);
  check('woff loads through FontFace', info.status === 'loaded', `${info.status}, ${info.woffBytes} bytes`);
  check('text renders in the new font', Math.abs(info.mine - info.expected) < 1, `"Handwriting" at 48px is ${info.mine.toFixed(1)}px wide, the font's advances add up to ${info.expected.toFixed(1)}px (monospace fallback ${info.mono.toFixed(1)}px)`);
  const has = (ch) => info.glyphs[ch] && info.glyphs[ch].bb;
  const desc = ['g', 'j', 'p', 'q', 'y'].filter(has).map((ch) => [ch, Math.round(info.glyphs[ch].bb.y1)]);
  check('descenders g j p q y go below the baseline', desc.every(([, y]) => y < -120), desc.map(([c, y]) => `${c} ${y}`).join(', '));
  const flat = ['a', 'c', 'e', 'm', 'n', 'o', 'r', 's', 'u', 'v', 'w', 'x', 'z'].filter(has).map((ch) => [ch, Math.round(info.glyphs[ch].bb.y1)]);
  check('x-height letters sit on the baseline (within the sample\'s own wobble)', flat.every(([, y]) => Math.abs(y) < 110), flat.map(([c, y]) => `${c} ${y}`).join(', '));
  // every glyph's top and bottom, against where make_sample.py really put the ink (mm from the printed baseline)
  let worst = { err: 0 }, sumErr = 0, n = 0;
  for (const ch of req) {
    const t = truth.glyphs && truth.glyphs[ch], bb = info.glyphs[ch].bb;
    if (!t || !bb) continue;
    for (const [got, want, edge] of [[bb.y2 / info.unitsPerMm, t.top, 'top'], [bb.y1 / info.unitsPerMm, t.bottom, 'bottom']]) {
      const err = Math.abs(got - want); sumErr += err; n++;
      if (err > worst.err) worst = { err, ch, edge };
    }
  }
  check('glyph tops and bottoms match the ink on the page', n === 2 * wantGlyphs && worst.err < 0.35,
    `${n} edges, mean error ${(sumErr / n).toFixed(3)} mm, worst ${worst.err.toFixed(3)} mm (${worst.ch} ${worst.edge}), ${info.unitsPerMm.toFixed(1)} units per mm`);
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const capH = med(['H', 'E', 'T', 'L', 'N'].filter(has).map((ch) => info.glyphs[ch].bb.y2));
  const xH = med(['x', 'z', 'n', 'u', 'v'].filter(has).map((ch) => info.glyphs[ch].bb.y2));
  check('capitals taller than small letters', capH > xH * 1.25, `cap height ${Math.round(capH)}, x-height ${Math.round(xH)}`);
  check('widths keep their proportions (m > n > i)', info.glyphs.m.adv > info.glyphs.n.adv && info.glyphs.n.adv > info.glyphs.i.adv, `m ${info.glyphs.m.adv}, n ${info.glyphs.n.adv}, i ${info.glyphs.i.adv}`);

  // try the controls: a different threshold should rebuild the font
  await page.locator('#threshold').fill('0.45');
  await page.waitForTimeout(200);
  await page.waitForFunction(() => window.PaperHand.state.ready, null, { timeout: 30000 });
  await page.locator('#threshold').fill('0.55');
  await page.waitForTimeout(200);
  await page.waitForFunction(() => window.PaperHand.state.ready, null, { timeout: 30000 });
  await page.locator('#name').fill('My Hand');
  await page.waitForTimeout(400);
  await page.waitForFunction(() => window.PaperHand.state.ready, null, { timeout: 30000 });

  // downloads
  async function download(sel) {
    const [d] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    const file = path.join(outDir, d.suggestedFilename());
    await d.saveAs(file);
    return file;
  }
  const cssFile = await download('#getCss');
  const woffFile = await download('#getWoff');
  const otfFile = await download('#getOtf');
  check('downloads named PaperHand.css, My-Hand.woff, My-Hand.otf',
    path.basename(cssFile) === 'PaperHand.css' && path.basename(woffFile) === 'My-Hand.woff' && path.basename(otfFile) === 'My-Hand.otf',
    [cssFile, woffFile, otfFile].map((f) => path.basename(f)).join(', '));

  // screenshots
  await page.locator('#try').fill('The quick brown fox jumps over the lazy dog\nPack my box with 5 dozen jugs\nJigsaw puzzles, quietly (0123456789)!');
  await page.waitForTimeout(300);
  await page.locator('#step5').screenshot({ path: path.join(outDir, 'step5-preview.png') });
  await page.locator('#step4').screenshot({ path: path.join(outDir, 'step4-cells.png') });
  await page.locator('#step3').screenshot({ path: path.join(outDir, 'step3-corners.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no sideways scrolling on a phone-sized screen', overflow <= 0, `${overflow}px overflow at 390px`);
  await page.screenshot({ path: path.join(outDir, 'phone-full.png'), fullPage: true });

  check('no errors in the page console', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();

  // the font file itself, checked independently with fontTools
  try {
    const out = execSync(`python3 "${path.join(__dirname, 'check_font.py')}" "${woffFile}" "${cssFile}" ${process.env.PAPER_CSS ? '"' + process.env.PAPER_CSS + '"' : ''}${skipped.length ? ` --missing "${skipped.join('')}"` : ''}`).toString();
    process.stdout.write(out);
    if (/^FAIL/m.test(out)) results.push({ name: 'fontTools checks', ok: false });
  } catch (e) {
    process.stdout.write(String(e.stdout || e));
    results.push({ name: 'fontTools checks', ok: false });
  }

  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ results, autoCornerErrorMm: errsMm, manualCornerErrorMm: manErr }, null, 1));
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\n${failed.length} check(s) failed` : '\nall checks passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

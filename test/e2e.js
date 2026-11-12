#!/usr/bin/env node
/*
 * End-to-end test: opens index.html from disk in headless Chromium, uploads a
 * synthetic photo (test/make_sample.py), and checks what the page read and built.
 *
 *   node test/e2e.js SAMPLE_DIR OUT_DIR
 *
 * A sample made with --skip checks the "wrong count" message instead.
 * Needs Playwright with Chromium. opentype.js is served from a local copy
 * (fetched once from npm into test/.cache) in place of the CDN, byte for byte,
 * so the page's integrity hash is checked too. Set PAPER_CSS to Paper's
 * app/assets/PaperHand.css to compare the CSS with the real file.
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
const median = (a) => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

(async () => {
  const [sampleDir, outDir] = process.argv.slice(2);
  if (!sampleDir || !outDir) { console.error('usage: node test/e2e.js SAMPLE_DIR OUT_DIR'); process.exit(2); }
  fs.mkdirSync(outDir, { recursive: true });
  const truth = JSON.parse(fs.readFileSync(path.join(sampleDir, 'truth.json'), 'utf8'));
  const byChar = Object.fromEntries(truth.chars.map((c) => [c.ch, c]));

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
  const title = await page.evaluate(async () => {
    const faces = await document.fonts.load('44px "Paper Hand"');
    return { faces: faces.length, family: getComputedStyle(document.querySelector('h1')).fontFamily, text: document.querySelector('h1').textContent };
  });
  check('title "Paper Hand" is set in Paper\'s own handwriting font', title.faces > 0 && /^"?Paper Hand/.test(title.family) && title.text === 'Paper Hand', `${title.faces} face loaded, font-family ${title.family}`);
  await page.screenshot({ path: path.join(outDir, 'desktop-start.png'), fullPage: true });

  const t0 = Date.now();
  await page.setInputFiles('#file', path.join(sampleDir, 'photo.jpg'));

  // a sheet with characters missing: one short message, no font
  if (truth.skipped) {
    const want = `Found ${truth.chars.length} characters, expected 62.`;
    await page.waitForFunction(() => document.getElementById('msg').textContent, null, { timeout: 60000 });
    const got = await page.evaluate(() => ({ msg: document.getElementById('msg').textContent, disabled: document.getElementById('getCss').disabled, cells: document.querySelectorAll('#cells .cell').length }));
    check('wrong count shows the message', got.msg === want, JSON.stringify(got.msg));
    check('and no font to download', got.disabled && got.cells === truth.chars.length, `download disabled: ${got.disabled}, ${got.cells} shapes shown`);
    await page.screenshot({ path: path.join(outDir, 'desktop-wrong-count.png'), fullPage: true });
    check('no errors in the page console', errors.length === 0, errors.slice(0, 3).join(' | '));
    await browser.close();
    const failed = results.filter((r) => !r.ok);
    console.log(failed.length ? `\n${failed.length} check(s) failed` : '\nall checks passed');
    process.exit(failed.length ? 1 : 0);
  }

  await page.waitForFunction(() => window.PaperHand.state.ready, null, { timeout: 60000 });
  const seconds = (Date.now() - t0) / 1000;

  // what was read where: each character's centre, back in the photo's pixels
  const reading = await page.evaluate(() => {
    const st = window.PaperHand.state, r = st.reading;
    return {
      count: r.count, order: r.order, angle: r.angle * 180 / Math.PI,
      chars: r.chars.map((c) => ({ ch: c.ch, at: window.PaperHand.toPhoto((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2) })),
    };
  });
  const wrong = reading.chars.filter((c) => {
    const t = byChar[c.ch];
    return !t || !(c.at[0] > t.photo[0] && c.at[0] < t.photo[2] && c.at[1] > t.photo[1] && c.at[1] < t.photo[3]);
  });
  check('62 characters found', reading.count === 62, `${reading.count} found in ${seconds.toFixed(1)} s, writing tilted ${reading.angle.toFixed(2)} degrees`);
  const orderNames = { lower: 'a-z, A-Z, 0-9', upper: 'A-Z, a-z, 0-9', pairs: 'aA bB ... 0-9', Pairs: 'Aa Bb ... 0-9' };
  check(`written order recognised (${orderNames[truth.order]})`, reading.order === truth.order, `read as ${reading.order}`);
  check('every character read as the one written there', reading.chars.length === 62 && wrong.length === 0, `${62 - wrong.length}/62 match the place they were drawn` + (wrong.length ? `, wrong: ${wrong.map((c) => c.ch).join(' ')}` : ''));

  const info = await page.evaluate(async () => {
    const st = window.PaperHand.state, font = st.built.font, glyphs = {};
    for (const ch of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
      const index = font.charToGlyphIndex(ch), g = index ? font.glyphs.get(index) : null;
      const bb = g && g.path.commands.length ? g.getBoundingBox() : null;
      glyphs[ch] = { index, commands: g ? g.path.commands.length : 0, adv: g ? g.advanceWidth : 0, bb: bb && { y1: bb.y1, y2: bb.y2 } };
    }
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
    return { glyphs, status, mono, mine, expected, woffBytes: st.woff.byteLength, count: font.glyphs.length };
  });
  const req = Object.keys(info.glyphs);
  const nonEmpty = req.filter((ch) => info.glyphs[ch].index > 0 && info.glyphs[ch].commands > 0);
  check('62 glyphs with outlines', nonEmpty.length === 62, `${nonEmpty.length}/62, font has ${info.count} glyphs incl. .notdef and space`);
  check('woff loads through FontFace', info.status === 'loaded', `${info.status}, ${info.woffBytes} bytes`);
  check('text renders in the new font', Math.abs(info.mine - info.expected) < 1, `"Handwriting" at 48px is ${info.mine.toFixed(1)}px wide, the font's advances add up to ${info.expected.toFixed(1)}px (monospace ${info.mono.toFixed(1)}px)`);
  const G = info.glyphs;
  const desc = ['g', 'j', 'p', 'q', 'y'].map((ch) => [ch, Math.round(G[ch].bb.y1)]);
  check('descenders g j p q y go below the baseline', desc.every(([, y]) => y < -120), desc.map(([c, y]) => `${c} ${y}`).join(', '));
  const flat = ['a', 'c', 'e', 'm', 'n', 'o', 'r', 's', 'u', 'v', 'w', 'x', 'z'].map((ch) => [ch, Math.round(G[ch].bb.y1)]);
  check('x-height letters sit on the baseline', flat.every(([, y]) => Math.abs(y) < 110), flat.map(([c, y]) => `${c} ${y}`).join(', '));
  const capH = median(['H', 'E', 'T', 'L', 'N'].map((ch) => G[ch].bb.y2)), xH = median(['x', 'z', 'n', 'u', 'v'].map((ch) => G[ch].bb.y2));
  check('capitals taller than small letters', capH > xH * 1.25, `cap height ${Math.round(capH)}, x-height ${Math.round(xH)}`);
  // every glyph's top and bottom, in capital heights from the baseline, against the sample's own.
  // Without printed lines the baseline is fitted through the letters' bottoms, which sits a hair below
  // a type designer's baseline (round letters overshoot it), so each line's common offset is reported
  // separately and the check is on what is left: one letter against its neighbours.
  const capUnits = median('ABCDEFGHIKLMNOPRSTUVWXYZ'.split('').map((ch) => G[ch].bb.y2));
  const capTruth = median('ABCDEFGHIKLMNOPRSTUVWXYZ'.split('').map((ch) => byChar[ch].top_photo));
  const lineOffset = {};
  for (let l = 0; l < truth.lines; l++) {
    const inLine = req.filter((ch) => byChar[ch].line === l);
    lineOffset[l] = median(inLine.map((ch) => G[ch].bb.y1 / capUnits - byChar[ch].bottom_photo / capTruth));
  }
  let worst = { err: 0 }, sum = 0, n = 0;
  for (const ch of req) {
    const off = lineOffset[byChar[ch].line];
    for (const [got, want, edge] of [[G[ch].bb.y2 / capUnits - off, byChar[ch].top_photo / capTruth, 'top'], [G[ch].bb.y1 / capUnits - off, byChar[ch].bottom_photo / capTruth, 'bottom']]) {
      const err = Math.abs(got - want); sum += err; n++;
      if (err > worst.err) worst = { err, ch, edge };
    }
  }
  const offs = Object.values(lineOffset);
  check('baseline found on every line', offs.every((o) => Math.abs(o) < 0.06), `line offsets ${offs.map((o) => (100 * o).toFixed(1) + '%').join(', ')} of a capital`);
  // the cut-out letters are about 55 px tall, so 1 px of ink spread is about 2% of a capital
  check('glyph tops and bottoms match the writing', sum / n < 0.035 && worst.err < 0.09,
    `${n} edges, mean error ${(100 * sum / n).toFixed(1)}% of a capital, worst ${(100 * worst.err).toFixed(1)}% (${worst.ch} ${worst.edge})`);

  // the one control: more or less ink rebuilds the font
  await page.locator('#threshold').fill('0.5');
  await page.waitForTimeout(400);
  await page.waitForFunction(() => window.PaperHand.state.ready, null, { timeout: 60000 });
  await page.locator('#threshold').fill('0.6');
  await page.waitForTimeout(400);
  await page.waitForFunction(() => window.PaperHand.state.ready, null, { timeout: 60000 });
  check('Ink slider rebuilds the font', await page.evaluate(() => window.PaperHand.state.reading.count === 62 && window.PaperHand.state.ready));

  async function download(sel) {
    const [d] = await Promise.all([page.waitForEvent('download'), page.click(sel)]);
    const file = path.join(outDir, d.suggestedFilename());
    await d.saveAs(file);
    return file;
  }
  const cssFile = await download('#getCss');
  const woffFile = await download('#getWoff');
  const otfFile = await download('#getOtf');
  check('downloads named PaperHand.css, PaperHand.woff, PaperHand.otf',
    [cssFile, woffFile, otfFile].map((f) => path.basename(f)).join() === 'PaperHand.css,PaperHand.woff,PaperHand.otf',
    [cssFile, woffFile, otfFile].map((f) => path.basename(f)).join(', '));

  const shown = await page.evaluate(() => ({
    preview: getComputedStyle(document.getElementById('try')).display !== 'none',
    cells: document.querySelectorAll('#cells .cell').length,
    labels: [...document.querySelectorAll('#cells .cell span')].map((s) => s.textContent).join(''),
  }));
  check('preview line and the 62 read shapes are shown', shown.preview && shown.cells === 62 && shown.labels.length === 62, `${shown.cells} shapes, labelled ${shown.labels.slice(0, 12)}...`);
  await page.locator('#try').fill('Jumpy foxes, 2024');
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(outDir, 'desktop-full.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no sideways scrolling on a phone-sized screen', overflow <= 0, `${overflow}px overflow at 390px`);
  await page.screenshot({ path: path.join(outDir, 'phone-full.png'), fullPage: true });

  check('no errors in the page console', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();

  // the font file itself, checked independently with fontTools
  try {
    const out = execSync(`python3 "${path.join(__dirname, 'check_font.py')}" "${woffFile}" "${cssFile}" ${process.env.PAPER_CSS ? '"' + process.env.PAPER_CSS + '"' : ''}`).toString();
    process.stdout.write(out);
    if (/^FAIL/m.test(out)) results.push({ name: 'fontTools checks', ok: false });
  } catch (e) {
    process.stdout.write(String(e.stdout || e));
    results.push({ name: 'fontTools checks', ok: false });
  }

  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ results }, null, 1));
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? `\n${failed.length} check(s) failed` : '\nall checks passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

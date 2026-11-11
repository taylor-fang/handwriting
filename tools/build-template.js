#!/usr/bin/env node
/*
 * Rebuilds the printable files in template/ from js/layout.js:
 *   paper-hand-template.svg, paper-hand-template.png (300 dpi),
 *   paper-hand-template-letter.pdf, paper-hand-template-a4.pdf
 *
 * Only needed if you change the layout. Requires Node and Playwright with Chromium:
 *   node tools/build-template.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const L = require('../js/layout.js');

const out = path.join(__dirname, '..', 'template');
const svg = L.svg();
const W = L.SPAN_W + L.MARK, H = L.SPAN_H + L.MARK; // mm

function pageHtml(size) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: ${size}; margin: 0; }
  html, body { margin: 0; height: 100%; }
  body { display: flex; align-items: center; justify-content: center; }
  svg { width: ${W}mm; height: ${H}mm; }
  </style></head><body>${svg}</body></html>`;
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'paper-hand-template.svg'), svg);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [name, format] of [['letter', 'Letter'], ['a4', 'A4']]) {
    await page.setContent(pageHtml(format === 'Letter' ? '8.5in 11in' : '210mm 297mm'));
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({ path: path.join(out, `paper-hand-template-${name}.pdf`), format, printBackground: true, preferCSSPageSize: true });
  }

  const dpi = 300, pxPerMm = dpi / 25.4;
  const pw = Math.round(W * pxPerMm), ph = Math.round(H * pxPerMm);
  await page.setViewportSize({ width: pw, height: ph });
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0}svg{display:block;width:${pw}px;height:${ph}px}</style></head><body>${svg}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(out, 'paper-hand-template.png'), clip: { x: 0, y: 0, width: pw, height: ph } });
  await browser.close();
  console.log(`template written to ${out} (${pw} x ${ph} px PNG at ${dpi} dpi)`);
})().catch((e) => { console.error(e); process.exit(1); });

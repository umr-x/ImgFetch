/*
 * ImgFetch - smart image downloader
 * Copyright (C) 2026 ImgFetch Developer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/**
 * ImgFetch scanner relevance tests — runs with plain Node, no dependencies:
 *   node tests/test-scanner.mjs
 *
 * Exercises the REAL relevanceOf() from content/scanner.js against stub DOM
 * elements (Node has no DOM). The scoring logic itself is unmodified — only
 * its inputs (getBoundingClientRect/getComputedStyle/closest/getAttribute)
 * are stubbed, which is what makes the assertions meaningful.
 */
import { strict as assert } from 'node:assert';

// ---- minimal browser globals so scanner.js loads ----
globalThis.window = {};
globalThis.chrome = { runtime: { sendMessage() {} } };
globalThis.getComputedStyle = (el) =>
  (el && el.__style) || { display: 'block', visibility: 'visible', opacity: '1' };

await import('../content/scanner.js');
const { relevanceOf } = globalThis.window.__imgfetch;
assert.ok(typeof relevanceOf === 'function', 'relevanceOf is exposed');

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; })
    .catch((err) => {
      failed += 1;
      failures.push(`${name}: ${err.message}`);
    });
}

/**
 * Fake element. opts:
 *  rect {w,h}, style, cls, id, alt,
 *  uiContainer: bool (closest(header/nav/...) matches),
 *  contentContainer: bool (closest(main/article/...) matches),
 *  inButton: bool
 */
function fakeEl(opts = {}) {
  const rect = opts.rect || { w: 100, h: 100 };
  return {
    __style: opts.style,
    getBoundingClientRect: () => ({ width: rect.w, height: rect.h }),
    getAttribute: (n) => {
      if (n === 'class') return opts.cls || '';
      if (n === 'id') return opts.id || '';
      if (n === 'alt') return opts.alt || '';
      return '';
    },
    closest: (sel) => {
      if (/header|nav|footer|banner|navigation|contentinfo|search/.test(sel)) {
        return opts.uiContainer ? {} : null;
      }
      if (/main|article|figure/.test(sel)) {
        return opts.contentContainer ? {} : null;
      }
      if (/button/.test(sel)) return opts.inButton ? {} : null;
      return null;
    },
  };
}

const occ1 = new Map();
function occ(url, n) {
  const m = new Map();
  m.set(String(url).toLowerCase(), n);
  return m;
}

// ---------- UI chrome must be filtered ----------

await test('16x16 nav icon is dropped', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 16, h: 16 }, uiContainer: true }),
    kind: 'img', url: 'https://cdn.x.com/icons/search-16.png',
    renderedW: 16, renderedH: 16, naturalW: 16, naturalH: 16, alt: '', format: 'png',
  }, occ1);
  assert.equal(r.keep, false);
});

await test('24x24 inline SVG icon is dropped (SVGs not banned as a class)', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 24, h: 24 }, uiContainer: true }),
    kind: 'svg', url: 'data:image/svg+xml,...',
    renderedW: 24, renderedH: 24, naturalW: 0, naturalH: 0, alt: '', format: 'svg',
  }, occ1);
  assert.equal(r.keep, false);
});

await test('site logo in header is dropped', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 120, h: 28 }, uiContainer: true, cls: 'site-logo' }),
    kind: 'img', url: 'https://www.x.com/static/logo.png',
    renderedW: 120, renderedH: 28, naturalW: 240, naturalH: 56, alt: 'X', format: 'png',
  }, occ1);
  assert.equal(r.keep, false);
});

await test('1x1 tracking pixel is dropped', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 1, h: 1 } }),
    kind: 'img', url: 'https://tracker.x.com/pixel.gif',
    renderedW: 1, renderedH: 1, naturalW: 1, naturalH: 1, alt: '', format: 'gif',
  }, occ1);
  assert.equal(r.keep, false);
});

await test('favicon link is dropped', () => {
  const r = relevanceOf({
    el: null, kind: 'favicon', url: 'https://x.com/favicon.ico',
    renderedW: 0, renderedH: 0, naturalW: 0, naturalH: 0, alt: '', format: 'ico',
  }, occ1);
  assert.equal(r.keep, false);
});

await test('input[type=image] button is dropped', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 80, h: 30 } }),
    kind: 'input', url: 'https://x.com/buttons/go.png',
    renderedW: 80, renderedH: 30, naturalW: 80, naturalH: 30, alt: 'Go', format: 'png',
  }, occ1);
  assert.equal(r.keep, false);
});

await test('display:none image is dropped', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 0, h: 0 }, style: { display: 'none', visibility: 'visible', opacity: '1' } }),
    kind: 'img', url: 'https://x.com/hidden.jpg',
    renderedW: 0, renderedH: 0, naturalW: 800, naturalH: 600, alt: '', format: 'jpg',
  }, occ1);
  assert.equal(r.keep, false);
});

await test('logo repeated 8x across page is dropped', () => {
  const url = 'https://x.com/assets/logo-small.png';
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 60, h: 60 } }),
    kind: 'img', url, renderedW: 60, renderedH: 60,
    naturalW: 120, naturalH: 120, alt: '', format: 'png',
  }, occ(url, 8));
  assert.equal(r.keep, false);
});

await test('comment avatar (avatar class, 40px) is dropped', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 40, h: 40 }, cls: 'comment-avatar' }),
    kind: 'img', url: 'https://x.com/avatars/u123.jpg',
    renderedW: 40, renderedH: 40, naturalW: 80, naturalH: 80, alt: '', format: 'jpg',
  }, occ1);
  assert.equal(r.keep, false);
});

// ---------- real content must survive ----------

await test('Pinterest-style pin photo is kept', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 236, h: 400 }, contentContainer: true }),
    kind: 'img', url: 'https://i.pinimg.com/236x/ab/12.jpg',
    renderedW: 236, renderedH: 400, naturalW: 736, naturalH: 1244,
    alt: 'Thomas Shelby', format: 'jpg',
  }, occ1);
  assert.equal(r.keep, true);
});

await test('blog hero image in <article> is kept', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 1200, h: 800 }, contentContainer: true }),
    kind: 'img', url: 'https://blog.x.com/media/hero-photo.jpg',
    renderedW: 1200, renderedH: 800, naturalW: 2400, naturalH: 1600,
    alt: 'Sunset over the valley', format: 'jpg',
  }, occ1);
  assert.equal(r.keep, true);
});

await test('og:image meta is kept', () => {
  const r = relevanceOf({
    el: null, kind: 'meta-image', url: 'https://x.com/og/cover.jpg',
    renderedW: 0, renderedH: 0, naturalW: 0, naturalH: 0, alt: '', format: 'jpg',
  }, occ1);
  assert.equal(r.keep, true);
});

await test('large inline SVG artwork is kept (no global SVG ban)', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 500, h: 300 }, contentContainer: true }),
    kind: 'svg', url: 'data:image/svg+xml,...',
    renderedW: 500, renderedH: 300, naturalW: 0, naturalH: 0, alt: '', format: 'svg',
  }, occ1);
  assert.equal(r.keep, true);
});

await test('80px product thumbnail is kept (no global small ban)', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 80, h: 80 }, contentContainer: true }),
    kind: 'img', url: 'https://shop.x.com/products/42/thumb.jpg',
    renderedW: 80, renderedH: 80, naturalW: 160, naturalH: 160,
    alt: 'Blue widget', format: 'jpg',
  }, occ1);
  assert.equal(r.keep, true);
});

await test('legit photo on a /tracking/ article path is kept', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 900, h: 600 }, contentContainer: true }),
    kind: 'img', url: 'https://blog.x.com/order-tracking/photo.jpg',
    renderedW: 900, renderedH: 600, naturalW: 1800, naturalH: 1200,
    alt: 'Parcel on doorstep', format: 'jpg',
  }, occ1);
  assert.equal(r.keep, true);
});

await test('video poster is kept like a photo', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 400, h: 300 }, contentContainer: true }),
    kind: 'poster', url: 'https://media.x.com/clips/1_poster.jpg',
    renderedW: 400, renderedH: 300, naturalW: 800, naturalH: 600,
    alt: 'Funny clip', format: 'jpg',
  }, occ1);
  assert.equal(r.keep, true);
});

await test('dimension-less lazy image is kept as unknown size (not invisible)', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 0, h: 0 }, contentContainer: true }),
    kind: 'img', url: 'https://cdn.x.com/photos/lazy-1.jpg',
    renderedW: 0, renderedH: 0, naturalW: 0, naturalH: 0,
    alt: 'Lazy loaded photo', format: 'jpg', fromLazy: true,
  }, occ1);
  assert.equal(r.keep, true);
});

await test('0x0 non-lazy image is dropped as invisible', () => {
  const r = relevanceOf({
    el: fakeEl({ rect: { w: 0, h: 0 } }),
    kind: 'img', url: 'https://cdn.x.com/photos/zero.jpg',
    renderedW: 0, renderedH: 0, naturalW: 0, naturalH: 0,
    alt: '', format: 'jpg', fromLazy: false,
  }, occ1);
  assert.equal(r.keep, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}

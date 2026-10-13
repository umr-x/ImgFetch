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
 * ImgFetch overlay picker tests — runs with plain Node, no dependencies:
 *   node tests/test-overlay.mjs
 *
 * Exercises the REAL pickHelpers from content/overlay.js (describeImg,
 * largestImg, backgroundUrlOf, resolveImage) against stub DOM elements.
 * Also verifies the descriptor shape feeds core/image-url.js correctly.
 */
import { strict as assert } from 'node:assert';
import { pickBestImageUrl } from '../core/image-url.js';

globalThis.window = {};
globalThis.location = { href: 'https://x.com/page' };
globalThis.getComputedStyle = (el) => ({ backgroundImage: (el && el.__bg) || 'none' });

await import('../content/overlay.js');
const { pickHelpers, pickElement } = globalThis.window.__imgfetch;
assert.ok(typeof pickElement === 'function', 'pickElement is exposed');
assert.ok(pickHelpers && typeof pickHelpers.resolveImage === 'function', 'pickHelpers exposed');

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

function fakeImg({ currentSrc = '', src = '', attrs = {}, rect = { w: 100, h: 100 }, natural = { w: 200, h: 200 } } = {}) {
  return {
    tagName: 'IMG',
    currentSrc,
    naturalWidth: natural.w,
    naturalHeight: natural.h,
    getAttribute: (n) => {
      if (n === 'src') return src;
      return attrs[n] || '';
    },
    closest: () => null,
    getBoundingClientRect: () => ({ width: rect.w, height: rect.h }),
  };
}

await test('resolveImage: <img> returns its descriptor', () => {
  const el = fakeImg({ currentSrc: 'https://cdn.x.com/a-800.jpg', src: 'https://cdn.x.com/a.jpg' });
  const r = pickHelpers.resolveImage(el);
  assert.ok(r.descriptor, 'has descriptor');
  assert.equal(r.descriptor.currentSrc, 'https://cdn.x.com/a-800.jpg');
  assert.equal(r.descriptor.srcAttr, 'https://cdn.x.com/a.jpg');
});

await test('resolveImage: descriptor feeds pickBestImageUrl (integration)', () => {
  const el = fakeImg({ currentSrc: 'https://cdn.x.com/a-800.jpg', src: 'https://cdn.x.com/a.jpg' });
  const r = pickHelpers.resolveImage(el);
  assert.equal(pickBestImageUrl(r.descriptor), 'https://cdn.x.com/a-800.jpg');
});

await test('resolveImage: container returns its largest <img>', () => {
  const small = fakeImg({ currentSrc: 'https://cdn.x.com/thumb.jpg', rect: { w: 40, h: 40 } });
  const big = fakeImg({ currentSrc: 'https://cdn.x.com/hero.jpg', rect: { w: 800, h: 400 } });
  const container = {
    tagName: 'DIV',
    querySelectorAll: () => [small, big],
    getAttribute: () => '',
  };
  const r = pickHelpers.resolveImage(container);
  assert.ok(r.descriptor, 'has descriptor');
  assert.equal(r.descriptor.currentSrc, 'https://cdn.x.com/hero.jpg');
});

await test('resolveImage: CSS background image is found', () => {
  const el = {
    tagName: 'DIV',
    __bg: 'url("https://cdn.x.com/bg-photo.jpg")',
    querySelectorAll: () => [],
    getAttribute: () => '',
  };
  const r = pickHelpers.resolveImage(el);
  assert.equal(r.backgroundUrl, 'https://cdn.x.com/bg-photo.jpg');
});

await test('resolveImage: data: background is ignored', () => {
  const el = {
    tagName: 'DIV',
    __bg: 'url("data:image/gif;base64,AAA")',
    querySelectorAll: () => [],
    getAttribute: () => '',
  };
  const r = pickHelpers.resolveImage(el);
  assert.deepEqual(r, { none: true });
});

await test('resolveImage: form controls are never inspected (no values read)', () => {
  let probed = false;
  const input = {
    tagName: 'INPUT',
    getAttribute: () => { probed = true; return ''; },
    querySelectorAll: () => [],
  };
  const r = pickHelpers.resolveImage(input);
  assert.deepEqual(r, { none: true });
  assert.equal(probed, false, 'no attribute was read on the input');
});

await test('resolveImage: plain text element -> none', () => {
  const el = { tagName: 'P', querySelectorAll: () => [], getAttribute: () => '' };
  assert.deepEqual(pickHelpers.resolveImage(el), { none: true });
});

await test('resolveImage: null -> none', () => {
  assert.deepEqual(pickHelpers.resolveImage(null), { none: true });
});

await test('resolveImage: lazy img descriptor keeps data-* for pickBestImageUrl', () => {
  const el = fakeImg({
    currentSrc: 'https://cdn.x.com/blank.gif',
    src: 'https://cdn.x.com/blank.gif',
    attrs: { 'data-src': 'https://cdn.x.com/real.jpg' },
    natural: { w: 1, h: 1 },
  });
  const r = pickHelpers.resolveImage(el);
  assert.equal(r.descriptor.lazy['data-src'], 'https://cdn.x.com/real.jpg');
  assert.equal(pickBestImageUrl(r.descriptor), 'https://cdn.x.com/real.jpg');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}

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
 * ImgFetch candidate-discovery regression tests — plain Node, no dependencies:
 *   node tests/test-candidates.mjs
 *
 * Regression for the missing-helper incident: candidatesForImg() and
 * rankMeasured() were referenced by content/scanner.js but never defined,
 * so Scan This Page silently produced `candidates: null` and bulk
 * downloads fell back to thumbnail resolution. These tests exercise the
 * REAL functions (stub DOM inputs only) plus the REAL queue-payload
 * builders in core/bulk-payload.js that carry scan-time candidates into
 * DOWNLOAD_MANY / DOWNLOAD_IMAGE payloads.
 */
import { strict as assert } from 'node:assert';

// ---- minimal browser globals so scanner.js loads ----
globalThis.window = {};
globalThis.chrome = { runtime: { sendMessage() {} } };
globalThis.getComputedStyle = (el) =>
  (el && el.__style) || { display: 'block', visibility: 'visible', opacity: '1' };
globalThis.document = { baseURI: 'https://site.test/page' };

await import('../content/scanner.js');
const { candidatesForImg, rankMeasured } = globalThis.window.__imgfetch;

const {
  sanitizeCandidates,
  bulkItemPayload,
  singleItemPayload,
  pickUpgrade,
} = await import('../core/bulk-payload.js');

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

/** Fake <img> element. attrs: { name: value }, parent: fake parent node. */
function fakeImg({ attrs = {}, currentSrc = '', src = '', parent = null } = {}) {
  return {
    currentSrc,
    src,
    loading: '',
    naturalWidth: 0,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    hasAttribute: (n) => n in attrs,
    parentElement: parent,
  };
}
function fakeSource(srcset) {
  return { getAttribute: (n) => (n === 'srcset' ? srcset : null) };
}
function fakePicture(srcsets) {
  return {
    tagName: 'PICTURE',
    querySelectorAll: (sel) => (sel === 'source' ? srcsets.map(fakeSource) : []),
  };
}
const urlsOf = (cands) => cands.map((c) => c.url);
const byKind = (cands, kind) => cands.filter((c) => c.kind === kind);

// 0. The regression itself: both helpers must exist.
await test('candidatesForImg and rankMeasured are defined', () => {
  assert.equal(typeof candidatesForImg, 'function');
  assert.equal(typeof rankMeasured, 'function');
});

// 1. Thumbnail URL with a larger srcset candidate.
await test('srcset: larger candidate collected with width hint', () => {
  const img = fakeImg({
    currentSrc: 'https://cdn.test/t.jpg',
    attrs: {
      src: 'https://cdn.test/t.jpg',
      srcset: 'https://cdn.test/t.jpg 236w, https://cdn.test/m.jpg 736w, https://cdn.test/l.jpg 1080w',
    },
  });
  const cands = candidatesForImg(img);
  assert.deepEqual(urlsOf(cands), [
    'https://cdn.test/t.jpg',
    'https://cdn.test/m.jpg',
    'https://cdn.test/l.jpg',
  ]);
  const large = cands.find((c) => c.url === 'https://cdn.test/l.jpg');
  assert.equal(large.kind, 'srcset');
  assert.equal(large.hintW, 1080);
  // After probing, the genuinely largest measured source wins.
  const ranked = rankMeasured([
    { url: 'https://cdn.test/t.jpg', width: 236, height: 400 },
    { url: 'https://cdn.test/m.jpg', width: 736, height: 1248 },
    { url: 'https://cdn.test/l.jpg', width: 1080, height: 1832 },
  ], 'https://cdn.test/t.jpg');
  assert.equal(ranked[0].url, 'https://cdn.test/l.jpg');
  assert.equal(ranked[0].width, 1080);
});

// 2. <picture> with higher-resolution sources.
await test('picture: source srcsets collected, same-format largest wins', () => {
  const img = fakeImg({
    currentSrc: 'https://cdn.test/small.jpg',
    attrs: { src: 'https://cdn.test/small.jpg' },
    parent: fakePicture([
      'https://cdn.test/big.webp 1600w, https://cdn.test/small.webp 800w',
      'https://cdn.test/big.jpg 1600w',
    ]),
  });
  const cands = candidatesForImg(img);
  const pic = byKind(cands, 'picture');
  assert.ok(pic.length >= 3, `expected picture candidates, got ${pic.length}`);
  assert.ok(pic.some((c) => c.url === 'https://cdn.test/big.webp' && c.hintW === 1600));
  // Format preservation: the clicked JPG prefers the larger JPG, not the larger WebP.
  const ranked = rankMeasured([
    { url: 'https://cdn.test/small.jpg', width: 800, height: 600 },
    { url: 'https://cdn.test/big.webp', width: 1600, height: 1200 },
    { url: 'https://cdn.test/big.jpg', width: 1400, height: 1050 },
  ], 'https://cdn.test/small.jpg');
  assert.equal(ranked[0].url, 'https://cdn.test/big.jpg');
  assert.equal(ranked[1].url, 'https://cdn.test/small.jpg');
  assert.equal(ranked[2].url, 'https://cdn.test/big.webp');
});

// 2b. Format preservation: a clicked GIF stays a GIF.
await test('rankMeasured: same-format preferred over larger other-format', () => {
  const ranked = rankMeasured([
    { url: 'https://cdn.test/a.webp', width: 1600, height: 1200 },
    { url: 'https://cdn.test/a.gif', width: 800, height: 600 },
  ], 'https://cdn.test/thumb.gif');
  assert.equal(ranked[0].url, 'https://cdn.test/a.gif');
  assert.equal(ranked[1].url, 'https://cdn.test/a.webp');
});

// 3. Lazy-loaded image with a supported high-resolution attribute.
await test('lazy: data-src / data-srcset high-res candidates collected', () => {
  const img = fakeImg({
    currentSrc: 'https://cdn.test/placeholder.jpg',
    attrs: {
      src: 'https://cdn.test/placeholder.jpg',
      'data-src': 'https://cdn.test/full.jpg',
      'data-srcset': 'https://cdn.test/full.jpg 2048w, https://cdn.test/med.jpg 1024w',
    },
  });
  const cands = candidatesForImg(img);
  assert.ok(cands.some((c) => c.url === 'https://cdn.test/full.jpg' && c.kind === 'lazy'));
  const lazySet = byKind(cands, 'lazy-srcset');
  assert.ok(lazySet.some((c) => c.url === 'https://cdn.test/med.jpg' && c.hintW === 1024));
});

// 4. Scan results -> bulk queue: candidates survive into the payload.
await test('bulkItemPayload preserves scan-time candidates', () => {
  const payload = bulkItemPayload(
    {
      srcUrl: 'https://cdn.test/t.jpg',
      mode: 'smart',
      format: 'as-is',
      candidates: [
        { u: 'https://cdn.test/t.jpg', k: 'current', w: 0 },
        { u: 'https://cdn.test/l.jpg', k: 'srcset', w: 1080 },
      ],
    },
    { mode: 'smart', format: 'as-is', pageUrl: 'https://site.test/', pageTitle: 'T', tabId: 7 },
  );
  assert.equal(payload.kind, 'bulk');
  assert.equal(payload.srcUrl, 'https://cdn.test/t.jpg');
  assert.equal(payload.tabId, 7);
  assert.deepEqual(payload.candidates, [
    { u: 'https://cdn.test/t.jpg', k: 'current', w: 0 },
    { u: 'https://cdn.test/l.jpg', k: 'srcset', w: 1080 },
  ]);
});

await test('bulkItemPayload: no candidates -> null (re-discovery fallback)', () => {
  const payload = bulkItemPayload(
    { srcUrl: 'https://cdn.test/t.jpg' },
    { mode: 'smart', pageUrl: 'https://site.test/' },
  );
  assert.equal(payload.candidates, null);
  assert.equal(payload.format, 'as-is');
});

// 5. Higher-resolution candidate fails to load -> safe fallback.
await test('rankMeasured: failed hi-res probe falls back to best available', () => {
  // The 1080w candidate failed probing, so it is absent from measured.
  const ranked = rankMeasured([
    { url: 'https://cdn.test/t.jpg', width: 236, height: 400 },
    { url: 'https://cdn.test/m.jpg', width: 736, height: 1248 },
  ], 'https://cdn.test/t.jpg');
  assert.equal(ranked[0].url, 'https://cdn.test/m.jpg');
  assert.ok(!ranked.some((r) => r.url === 'https://cdn.test/l.jpg'));
});

// 6. Page exposes only one resolution.
await test('rankMeasured: single available source is returned as-is', () => {
  const ranked = rankMeasured(
    [{ url: 'https://cdn.test/only.jpg', width: 640, height: 480 }],
    'https://cdn.test/only.jpg',
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].url, 'https://cdn.test/only.jpg');
});

// 7. Duplicates and invalid URLs.
await test('candidatesForImg: duplicates collapsed, invalid URLs skipped', () => {
  const img = fakeImg({
    currentSrc: 'https://cdn.test/a.jpg',
    attrs: {
      src: 'https://cdn.test/a.jpg', // duplicate of currentSrc
      srcset: 'https://cdn.test/a.jpg 500w, https://cdn.test/b.jpg 900w, https:// 100w',
      'data-src': 'javascript:alert(1)',
    },
  });
  const cands = candidatesForImg(img);
  assert.deepEqual(urlsOf(cands), ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg']);
});

await test('sanitizeCandidates: strips bad entries, dedupes, caps at 8', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ u: `https://cdn.test/${i}.jpg`, k: 'srcset', w: i }));
  const out = sanitizeCandidates([
    { u: 'https://cdn.test/a.jpg', k: 'srcset', w: 900 },
    { u: 'https://cdn.test/a.jpg', k: 'srcset', w: 900 }, // dupe
    { u: 'javascript:alert(1)', k: 'x', w: 1 }, // dangerous scheme
    { u: '', k: 'x', w: 1 },
    null,
    ...many,
  ]);
  assert.equal(out.length, 8);
  assert.equal(out[0].u, 'https://cdn.test/a.jpg');
  assert.ok(!out.some((c) => c.u.startsWith('javascript:')));
  assert.equal(sanitizeCandidates('nope'), null);
  assert.equal(sanitizeCandidates([]), null);
});

// 8. Existing single-image download behaviour is preserved.
await test('singleItemPayload: keeps single-download contract, carries candidates', () => {
  const payload = singleItemPayload(
    {
      srcUrl: 'https://cdn.test/t.jpg',
      mode: 'smart',
      format: 'png',
      customName: 'my pic',
      candidates: [{ u: 'https://cdn.test/l.jpg', k: 'srcset', w: 1080 }],
    },
    { mode: 'smart', pageUrl: 'https://site.test/', pageTitle: 'T', tabId: 3 },
  );
  assert.equal(payload.kind, 'single');
  assert.equal(payload.srcUrl, 'https://cdn.test/t.jpg');
  assert.equal(payload.format, 'png');
  assert.equal(payload.customName, 'my pic');
  assert.deepEqual(payload.candidates, [{ u: 'https://cdn.test/l.jpg', k: 'srcset', w: 1080 }]);
});

await test('rankMeasured: exact tie prefers the current source (no pointless swap)', () => {
  const ranked = rankMeasured([
    { url: 'https://cdn.test/alt.jpg', width: 800, height: 600 },
    { url: 'https://cdn.test/cur.jpg', width: 800, height: 600 },
  ], 'https://cdn.test/cur.jpg');
  assert.equal(ranked[0].url, 'https://cdn.test/cur.jpg');
});

// 9. Pinterest-like: displayed thumbnail is smaller than intrinsic dims.
await test('pinterest-like: measured intrinsic dims beat the displayed thumbnail', () => {
  // Grid shows a 236px thumbnail; the element exposes the original via a
  // lazy attribute. Selection must use probed (intrinsic) dimensions,
  // never the displayed size.
  const img = fakeImg({
    currentSrc: 'https://pin.test/236x/thumb.jpg',
    attrs: {
      src: 'https://pin.test/236x/thumb.jpg',
      'data-original-src': 'https://pin.test/originals/photo.jpg',
    },
  });
  const cands = candidatesForImg(img);
  assert.ok(cands.some((c) => c.url === 'https://pin.test/originals/photo.jpg'));
  const ranked = rankMeasured([
    { url: 'https://pin.test/236x/thumb.jpg', width: 236, height: 354 },
    { url: 'https://pin.test/originals/photo.jpg', width: 1200, height: 1800 },
  ], 'https://pin.test/236x/thumb.jpg');
  assert.equal(ranked[0].url, 'https://pin.test/originals/photo.jpg');
  assert.equal(ranked[0].width, 1200);
});

// Inline data: URLs are not shipped as alternate candidates.
await test('candidatesForImg: data: URL alternates are skipped', () => {
  const img = fakeImg({
    currentSrc: 'https://cdn.test/a.jpg',
    attrs: {
      src: 'https://cdn.test/a.jpg',
      'data-src': 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    },
  });
  const cands = candidatesForImg(img);
  assert.ok(!cands.some((c) => c.url.startsWith('data:')));
});

// Zero-area / garbage probe results never rank.
await test('rankMeasured: filters zero-area and malformed entries', () => {
  const ranked = rankMeasured([
    { url: 'https://cdn.test/a.jpg', width: 0, height: 0 },
    { url: 'https://cdn.test/b.jpg', width: 400, height: 300 },
    null,
    { url: 'https://cdn.test/b.jpg', width: 400, height: 300 }, // dupe
    { url: 42, width: 900, height: 900 },
  ], 'https://cdn.test/a.jpg');
  assert.deepEqual(ranked, [{ url: 'https://cdn.test/b.jpg', width: 400, height: 300 }]);
});

// 'normal' bulk path: upgrade decision from probed+ranked sources.
await test('pickUpgrade: upgrades to a genuinely bigger source', () => {
  const up = pickUpgrade('https://pin.test/236x/a.jpg', [
    { url: 'https://pin.test/474x/a.jpg', width: 474, height: 708 },
    { url: 'https://pin.test/236x/a.jpg', width: 236, height: 354 },
  ]);
  assert.equal(up.url, 'https://pin.test/474x/a.jpg');
});

await test('pickUpgrade: no upgrade when current is already the best', () => {
  assert.equal(pickUpgrade('https://cdn.test/a.jpg', [
    { url: 'https://cdn.test/a.jpg', width: 800, height: 600 },
    { url: 'https://cdn.test/b.jpg', width: 400, height: 300 },
  ]), null);
});

await test('pickUpgrade: never downgrades to a smaller source', () => {
  assert.equal(pickUpgrade('https://cdn.test/a.jpg', [
    { url: 'https://cdn.test/b.jpg', width: 100, height: 100 },
    { url: 'https://cdn.test/a.jpg', width: 800, height: 600 },
  ]), null);
});

await test('pickUpgrade: upgrades when the current URL failed to probe', () => {
  const up = pickUpgrade('https://cdn.test/a.jpg', [
    { url: 'https://cdn.test/b.jpg', width: 400, height: 300 },
  ]);
  assert.equal(up.url, 'https://cdn.test/b.jpg');
});

await test('pickUpgrade: null on empty/missing ranking', () => {
  assert.equal(pickUpgrade('https://cdn.test/a.jpg', []), null);
  assert.equal(pickUpgrade('https://cdn.test/a.jpg', null), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}

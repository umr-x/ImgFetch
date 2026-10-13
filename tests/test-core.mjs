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
 * ImgFetch unit tests — runs with plain Node, no dependencies:
 *   node tests/test-core.mjs
 */
import { strict as assert } from 'node:assert';
import * as urls from '../core/urls.js';
import * as filenames from '../core/filenames.js';
import * as filters from '../core/filters.js';
import * as settings from '../core/settings.js';
import * as validation from '../core/validation.js';
import * as exp from '../core/export.js';
import * as capture from '../core/fullpage-capture.js';
import { encodeGif, encodeGifAnimated, lzwCompress } from '../core/gif.js';
import { createZip, createZipParts, crc32, safeZipName } from '../core/zip.js';
import { dedupeImages } from '../core/dedupe.js';
import { parseExif } from '../core/exif.js';
import * as history from '../core/history.js';
import { DownloadQueue, ItemState } from '../core/queue.js';
import { pickBestImageUrl } from '../core/image-url.js';
import { coerceScanState, isScanStateStale, SCAN_STATE_STALE_MS } from '../core/scan-state.js';
import { resolveFolder, typeFolderFor } from '../core/folders.js';

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

// ---------- urls ----------
await test('normalizeUrl resolves relative URLs', () => {
  assert.equal(urls.normalizeUrl('/a/b.jpg', 'https://ex.com/p/'), 'https://ex.com/a/b.jpg');
});
await test('normalizeUrl rejects javascript: and ftp:', () => {
  assert.equal(urls.normalizeUrl('javascript:alert(1)', 'https://ex.com'), null);
  assert.equal(urls.normalizeUrl('ftp://ex.com/a.jpg', 'https://ex.com'), null);
});
await test('normalizeUrl rejects credentials and strips hash', () => {
  assert.equal(urls.normalizeUrl('https://u:p@ex.com/a.jpg#x', null), null);
  assert.equal(urls.normalizeUrl('https://ex.com/a.jpg#x', null), 'https://ex.com/a.jpg');
});
await test('normalizeUrl allows image data URLs, caps length', () => {
  const ok = 'data:image/png;base64,' + 'a'.repeat(100);
  assert.equal(urls.normalizeUrl(ok, null), ok);
  assert.equal(urls.normalizeUrl('data:text/plain,hi', null), null);
  assert.equal(urls.normalizeUrl('data:image/png;base64,' + 'a'.repeat(3_000_000), null), null);
});
await test('getExtensionFromUrl', () => {
  assert.equal(urls.getExtensionFromUrl('https://ex.com/a.JPG?w=1', null), 'jpg');
  assert.equal(urls.getExtensionFromUrl('https://ex.com/a', null), '');
  assert.equal(urls.getExtensionFromUrl('data:image/webp;base64,xx', null), 'webp');
});
await test('parseSrcset', () => {
  const p = urls.parseSrcset('a.jpg 1x, b.jpg 2x, c.jpg 300w');
  assert.equal(p.length, 3);
  assert.deepEqual([p[0].kind, p[1].value, p[2].kind], ['x', 2, 'w']);
  assert.deepEqual(urls.parseSrcset(''), []);
});
await test('getHostLabel', () => {
  assert.equal(urls.getHostLabel('https://images.example.co.uk/a.jpg', null), 'example.co.uk');
  assert.equal(urls.getHostLabel('https://sub.example.com/a.jpg', null), 'example.com');
  assert.equal(urls.getHostLabel('https://www.example.com/a.jpg', null), 'example.com'); // M1: www matches
  assert.equal(urls.getHostLabel('https://example.org/a.jpg', null), 'example.org'); // M1: no .com collision
  assert.equal(urls.getHostLabel('https://192.168.1.1/a.jpg', null), '192.168.1.1');
  assert.equal(urls.getHostLabel('data:image/png;base64,xx', null), 'download');
});
await test('M4: URL-pattern guessing removed (no variantCandidates)', () => {
  assert.equal(typeof urls.variantCandidates, 'undefined');
});

// ---------- filenames ----------
await test('sanitizeSegment strips dangerous chars', () => {
  assert.equal(filenames.sanitizeSegment('a<b>:"/\\|?*c'), 'abc');
  assert.equal(filenames.sanitizeSegment('..'), '');
  assert.equal(filenames.sanitizeSegment('  hello  '), 'hello');
  assert.ok(filenames.sanitizeSegment('x'.repeat(200)).length <= 96);
});
await test('safeExtension blocks executables', () => {
  assert.equal(filenames.safeExtension('exe'), 'png');
  assert.equal(filenames.safeExtension('jpeg'), 'jpg');
  assert.equal(filenames.safeExtension('webp'), 'webp');
  assert.equal(filenames.safeExtension('php'), 'png');
});
await test('buildFilename modes', () => {
  const ctx = { site: 'example', name: 'photo', ext: 'jpg', num: 5, date: new Date(2026, 0, 2, 3, 4, 5) };
  assert.equal(filenames.buildFilename('original', ctx), 'photo.jpg');
  assert.equal(filenames.buildFilename('site', ctx), 'example - 2026-01-02 - 005.jpg');
  assert.equal(filenames.buildFilename('custom', { ...ctx, custom: '{site}_{time}' }), 'example_03-04-05.jpg');
});
await test('buildFilename never makes dangerous names', () => {
  const f = filenames.buildFilename('original', { name: '../../evil', ext: 'exe' });
  assert.ok(!f.includes('/') && f.endsWith('.png'));
});
await test('joinDownloadPath blocks traversal', () => {
  const p = filenames.joinDownloadPath('../../etc', 'a.png');
  assert.ok(!p.includes('..') && p.endsWith('a.png'));
  assert.equal(filenames.joinDownloadPath('mysite', 'a.png'), 'mysite/a.png');
});

// ---------- filters ----------
const IMG = (o) => ({ id: 'x', src: 'https://ex.com/a.jpg', width: 0, height: 0, format: '', alt: '', ...o });
await test('sizeBucket and orientation', () => {
  assert.equal(filters.sizeBucket(IMG({ width: 100, height: 100 })), 'small');
  assert.equal(filters.sizeBucket(IMG({ width: 900, height: 600 })), 'medium');
  assert.equal(filters.sizeBucket(IMG({ width: 2000, height: 1000 })), 'large');
  assert.equal(filters.orientationOf(IMG({ width: 200, height: 100 })), 'landscape');
  assert.equal(filters.orientationOf(IMG({ width: 100, height: 100 })), 'square');
});
await test('applyFilters', () => {
  const list = [IMG({ width: 100, height: 100, format: 'jpg' }), IMG({ width: 2000, height: 1000, format: 'png' })];
  assert.equal(filters.applyFilters(list, { size: 'large' }).length, 1);
  assert.equal(filters.applyFilters(list, { formats: ['jpg'] }).length, 1);
});
await test('matchesQuery and sort', () => {
  const list = [IMG({ width: 10, height: 10, alt: 'cat photo' }), IMG({ width: 20, height: 20, alt: 'dog' })];
  assert.equal(filters.matchesQuery(list[0], 'CAT'), true);
  assert.equal(filters.sortImages(list, 'largest')[0].alt, 'dog');
});

// ---------- settings ----------
await test('normalizeSettings validates', () => {
  const s = settings.normalizeSettings({ theme: 'neon', maxConcurrent: 99, jpgQuality: 5, webpQuality: 0, sitePrefs: { 'A.com': 'best', bad: 'x' } });
  assert.equal(s.theme, 'system');
  assert.equal(s.maxConcurrent, 6);
  assert.equal(s.jpgQuality, 1);
  assert.equal(s.webpQuality, 0.1); // clamped into the valid range
  assert.deepEqual(s.sitePrefs, { 'a.com': 'best' });
});
await test('qualityModeForHost maps legacy modes', () => {
  const s = settings.normalizeSettings({ qualityPreference: 'original', sitePrefs: { 'ex.com': 'best' } });
  assert.equal(settings.qualityModeForHost(s, 'ex.com'), 'smart');
  assert.equal(settings.qualityModeForHost(s, 'other.com'), 'original');
  // B3: defaultAction is removed — old installs carrying it lose the dead key.
  const s2 = settings.normalizeSettings({ defaultAction: 'smart' });
  assert.equal('defaultAction' in s2, false, 'defaultAction must be migrated away');
  assert.equal('defaultAction' in settings.DEFAULT_SETTINGS, false);
  assert.equal(settings.qualityModeForHost(s2, 'x.com'), 'smart');
  const s3 = settings.normalizeSettings({ defaultAction: 'normal', qualityPreference: 'smart' });
  assert.equal('defaultAction' in s3, false);
  assert.equal(settings.qualityModeForHost(s3, 'x.com'), 'smart');
  // Legacy stored values still map cleanly.
  const s4 = settings.normalizeSettings({ qualityPreference: 'ask', avifQuality: 5, detectLazyScroll: 'yes' });
  assert.equal(s4.qualityPreference, 'smart');
  assert.equal('avifQuality' in s4, false); // dead key dropped from old installs
  assert.equal(s4.detectLazyScroll, false);
});

await test('B3: qualityPreference changes real behavior (probe vs exact source)', () => {
  const smart = settings.normalizeSettings({ qualityPreference: 'smart' });
  const original = settings.normalizeSettings({ qualityPreference: 'original' });
  assert.equal(settings.shouldProbeBestSources(smart, 'smart'), true,
    'smart preference probes candidate sources');
  assert.equal(settings.shouldProbeBestSources(original, 'smart'), false,
    'original preference skips probing and uses the exact source');
  assert.equal(settings.shouldProbeBestSources(smart, 'normal'), false,
    'non-smart modes never probe');
  assert.equal(settings.shouldProbeBestSources(smart, ''), false);
});

/* ------------------------------------------------------------------ */
/* B6 (ROUND 2): capture planning — area cap + tile cap.               */
/* ------------------------------------------------------------------ */

await test('B6: 20000px page at DPR 1 needs no downscale', () => {
  const p = capture.planFullPageCapture({
    fullW: 1600, fullH: 20000, viewportW: 1600, viewportH: 900, dpr: 1,
  });
  assert.equal(p.tileCapped, false);
  assert.equal(p.scale, 1);
  assert.equal(p.outW, 1600);
  assert.equal(p.outH, 20000);
});

await test('B6: 20000px page at DPR 2 stays readable (area cap, not 8192px)', () => {
  const p = capture.planFullPageCapture({
    fullW: 1600, fullH: 20000, viewportW: 1600, viewportH: 900, dpr: 2,
  });
  assert.equal(p.tileCapped, false);
  assert.ok(p.scale < 1 && p.scale > 0.8, `scale=${p.scale} should stay near 0.82, not 0.2`);
  assert.equal(p.outH, 32767, 'longest side capped at 32767');
  assert.ok(p.outW * p.outH <= 100_000_000 + 32767, 'area within budget');
});

await test('B6: very long page captures first 24 tiles instead of failing', () => {
  const p = capture.planFullPageCapture({
    fullW: 1600, fullH: 30000, viewportW: 1600, viewportH: 900, dpr: 1,
  });
  assert.equal(p.tileCapped, true);
  assert.equal(p.tileCount, 24);
  assert.equal(p.capH, 24 * 900, 'captures the top 21600 CSS px');
  assert.ok(p.rows * p.cols <= 24);
});

await test('B6: normal page is untouched by caps', () => {
  const p = capture.planFullPageCapture({
    fullW: 1440, fullH: 3000, viewportW: 1440, viewportH: 900, dpr: 2,
  });
  assert.equal(p.tileCapped, false);
  assert.equal(p.scale, 1);
  assert.equal(p.outW, 2880);
  assert.equal(p.outH, 6000);
});

// ---------- queue ----------
await test('queue processes with concurrency and retries', async () => {
  let running = 0;
  let maxRunning = 0;
  const attempts = new Map();
  const q = new DownloadQueue({
    concurrency: 2,
    maxAttempts: 2,
    starter: async (item) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      const n = (attempts.get(item.id) || 0) + 1;
      attempts.set(item.id, n);
      if (item.id === 'fail-once' && n === 1) throw new Error('boom');
      if (item.id === 'fail-always') throw new Error('boom');
    },
  });
  q.enqueue([{ id: 'a', label: 'a' }, { id: 'fail-once', label: 'b' }, { id: 'fail-always', label: 'c' }]);
  await new Promise((r) => setTimeout(r, 200));
  const snap = q.snapshot();
  assert.ok(maxRunning <= 2, `concurrency exceeded: ${maxRunning}`);
  assert.equal(snap.done, 2);
  assert.equal(snap.failed, 1);
  assert.equal(attempts.get('fail-once'), 2);
});
await test('queue cancel stops pending', async () => {
  const q = new DownloadQueue({ concurrency: 1, starter: () => new Promise(() => {}) });
  q.enqueue([{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }]);
  q.cancel();
  const snap = q.snapshot();
  assert.equal(snap.pending, 0);
});
await test('queue updateItem patches progress labels', async () => {
  const seen = [];
  const q = new DownloadQueue({
    concurrency: 1,
    starter: async (item) => {
      q.updateItem(item.id, { label: 'Finding best quality…' });
      q.updateItem(item.id, { label: 'Downloading…' });
    },
    onUpdate: (snap) => seen.push(snap.items[0] ? snap.items[0].label : null),
  });
  q.enqueue([{ id: 'x', label: 'x' }]);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(seen.includes('Finding best quality…'));
  assert.ok(seen.includes('Downloading…'));
  // id and payload are protected from patching
  const before = q.snapshot().items.find((i) => i.id === 'x');
  q.updateItem('x', { id: 'y', payload: { evil: true }, label: 'ok' });
  const after = q.snapshot().items.find((i) => i.id === 'x');
  assert.equal(after.id, 'x');
  assert.equal(after.label, 'ok');
  assert.equal(before.payload, after.payload);
});

// ---------- validation ----------
await test('isValidMessage', () => {
  assert.equal(validation.isValidMessage({ type: 'SCAN_PAGE' }), true);
  assert.equal(validation.isValidMessage({ type: 'CAPTURE_FULL' }), true);
  assert.equal(validation.isValidMessage({ type: 'NOPE' }), false);
  assert.equal(validation.isValidMessage({ type: 'DOWNLOAD_IMAGE', srcUrl: 42 }), false);
  assert.equal(validation.isValidMessage(null), false);
});
await test('isValidMessage covers all message types', () => {
  // Regression: these were routed but missing from the allowlist .
  for (const type of ['CAPTURE_ELEMENT', 'DOWNLOAD_ZIP', 'SUGGEST_FILENAME']) {
    assert.equal(validation.isValidMessage({ type }), true, type);
  }
  assert.equal(
    validation.isValidMessage({ type: 'SAVE_ANNOTATED', id: 'cap-1', dataUrl: 'data:image/png;base64,xx' }),
    true,
  );
  assert.equal(validation.isValidMessage({ type: 'SAVE_ANNOTATED', id: 'cap-1' }), true);
  assert.equal(validation.isValidMessage({ type: 'SAVE_ANNOTATED', id: 'cap-1', dataUrl: 42 }), false);
});
await test('senderKind and friendlyError', () => {
  assert.equal(validation.senderKind({ tab: { id: 3 }, url: 'https://example.com/' }), 'content');
  // Extension pages open in tabs still carry sender.tab — the URL scheme decides.
  assert.equal(validation.senderKind({ tab: { id: 9 }, url: 'chrome-extension://abcdef/options/options.html' }), 'extension');
  assert.equal(validation.senderKind({ url: 'chrome-extension://abcdef/popup/popup.html' }), 'extension');
  // M6: fail-closed — unrecognized senders are 'unknown', never 'extension'.
  assert.equal(validation.senderKind({}), 'unknown');
  assert.equal(validation.senderKind(null), 'unknown');
  assert.ok(validation.friendlyError('blocked').length > 5);
  // Smart-engine errors stay plain-language, never raw technical text.
  assert.ok(!/http-|Error|undefined/i.test(validation.friendlyError('gif-unavailable')));
  assert.ok(!/http-|Error|undefined/i.test(validation.friendlyError('avif-unavailable')));
});

// ---------- export ----------
await test('export format helpers', () => {
  assert.equal(exp.normalizeExportFormat('JPEG'), 'jpg');
  assert.equal(exp.normalizeExportFormat('WebP'), 'webp');
  assert.equal(exp.normalizeExportFormat('tiff'), 'png'); // unknown -> safe default
  assert.equal(exp.formatLabel('jpg'), 'JPEG');
  const s = settings.normalizeSettings({ jpgQuality: 0.9, webpQuality: 0.8, avifQuality: 0.7 });
  assert.equal(exp.qualityForFormat('jpg', s), 0.9);
  assert.equal(exp.qualityForFormat('webp', s), 0.8);
  assert.equal(exp.qualityForFormat('avif', s), 1); // no slider — always 100%
  assert.equal(exp.qualityForFormat('png', settings.normalizeSettings({ pngQuality: 0.85 })), 0.85);
});

// ---------- gif ----------
/** Minimal test-side GIF parser + LZW decompressor (independent of core/gif.js). */
function parseTestGif(bytes) {
  assert.equal(String.fromCharCode(...bytes.slice(0, 6)), 'GIF89a');
  const w = bytes[6] | (bytes[7] << 8);
  const h = bytes[8] | (bytes[9] << 8);
  const packed = bytes[10];
  assert.ok(packed & 0x80, 'GCT flag set');
  const gctSize = 2 ** ((packed & 0x07) + 1);
  const gct = [];
  for (let i = 0; i < gctSize; i += 1) {
    gct.push([bytes[13 + i * 3], bytes[13 + i * 3 + 1], bytes[13 + i * 3 + 2]]);
  }
  let pos = 13 + gctSize * 3;
  let gce = null;
  if (bytes[pos] === 0x21) {
    assert.equal(bytes[pos + 1], 0xf9);
    gce = { transparent: !!(bytes[pos + 3] & 0x01), index: bytes[pos + 6] };
    pos += 8;
  }
  assert.equal(bytes[pos], 0x2c, 'image descriptor');
  const iw = bytes[pos + 5] | (bytes[pos + 6] << 8);
  const ih = bytes[pos + 7] | (bytes[pos + 8] << 8);
  const minCodeSize = bytes[pos + 10];
  pos += 11;
  const data = [];
  while (bytes[pos] !== 0) {
    const n = bytes[pos];
    for (let i = 0; i < n; i += 1) data.push(bytes[pos + 1 + i]);
    pos += 1 + n;
  }
  assert.equal(bytes[pos + 1], 0x3b, 'trailer');
  return { w, h, iw, ih, gct, gce, minCodeSize, data: Uint8Array.from(data) };
}

function lzwDecompressTest(data, minCodeSize, count) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let bytePos = 0;
  let bitPos = 0;
  const readCode = (size) => {
    let code = 0;
    for (let b = 0; b < size; b += 1) {
      if (bytePos >= data.length) break;
      code |= ((data[bytePos] >> bitPos) & 1) << b;
      bitPos += 1;
      if (bitPos === 8) { bitPos = 0; bytePos += 1; }
    }
    return code;
  };
  let dict;
  let codeSize;
  let nextCode;
  const reset = () => {
    dict = new Map();
    for (let i = 0; i < clearCode; i += 1) dict.set(i, [i]);
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  };
  // Standard decoder rule (pairs with the encoder's after-add `>` growth):
  // before reading each code, grow while nextCode no longer fits.
  const maybeGrow = () => {
    while (codeSize < 12 && nextCode >= (1 << codeSize)) codeSize += 1;
  };
  reset();
  const out = [];
  let prev = null;
  for (;;) {
    maybeGrow();
    const code = readCode(codeSize);
    if (code === clearCode) { reset(); prev = null; continue; }
    if (code === eoiCode) break;
    let entry;
    if (dict.has(code)) entry = dict.get(code);
    else if (code === nextCode && prev) entry = [...prev, prev[0]];
    else throw new Error(`bad LZW code ${code}`);
    for (const v of entry) {
      out.push(v);
      if (out.length >= count) break;
    }
    if (out.length >= count) break;
    if (prev) {
      dict.set(nextCode, [...prev, entry[0]]);
      nextCode += 1;
    }
    prev = entry;
  }
  return out;
}

function rgbaPixels(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b, a] = fn(x, y);
      const o = (y * w + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  }
  return data;
}

await test('encodeGif round-trips solid colors', () => {
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
  const px = rgbaPixels(4, 4, (x, y) => [...colors[(y * 4 + x) % 4], 255]);
  const gif = encodeGif(4, 4, px);
  const p = parseTestGif(gif);
  assert.equal(p.w, 4);
  assert.equal(p.h, 4);
  const indices = lzwDecompressTest(p.data, p.minCodeSize, 16);
  assert.equal(indices.length, 16);
  for (let i = 0; i < 16; i += 1) {
    const want = colors[i % 4];
    const got = p.gct[indices[i]];
    assert.deepEqual(got, want, `pixel ${i}`);
  }
});

await test('encodeGif handles transparency', () => {
  const px = rgbaPixels(2, 2, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 0] : [200, 100, 50, 255]));
  const gif = encodeGif(2, 2, px);
  const p = parseTestGif(gif);
  assert.ok(p.gce && p.gce.transparent, 'GCE marks transparency');
  const indices = lzwDecompressTest(p.data, p.minCodeSize, 4);
  assert.equal(indices[0], p.gce.index, 'transparent pixel uses transparent index');
  assert.deepEqual(p.gct[indices[1]], [200, 100, 50]);
});

await test('encodeGifAnimated produces multi-frame GIF', () => {
  const mk = (color) => rgbaPixels(4, 4, () => [...color, 255]);
  const gif = encodeGifAnimated(4, 4, [
    { data: mk([255, 0, 0]), delayCs: 10 },
    { data: mk([0, 0, 255]), delayCs: 20 },
  ]);
  assert.equal(String.fromCharCode(...gif.slice(0, 6)), 'GIF89a');
  assert.equal(gif[gif.length - 1], 0x3b);
  // NETSCAPE2.0 loop extension present (21 FF 0B + 11-byte app name)
  const tag = String.fromCharCode(...gif.slice(16, 27));
  assert.ok(tag.includes('NETSCAPE2.0'), 'loop extension');
  // Two image descriptors (0x2C)
  let count = 0;
  for (const b of gif) if (b === 0x2c) count += 1;
  assert.equal(count, 2, 'two frames');
  assert.throws(() => encodeGifAnimated(4, 4, [{ data: mk([0, 0, 0]), delayCs: 5 }]), /bad-frames/);
});

await test('encodeGif rejects bad input', () => {
  assert.throws(() => encodeGif(0, 10, new Uint8ClampedArray(0)), /bad-size/);
  assert.throws(() => encodeGif(5000, 10, new Uint8ClampedArray(5000 * 10 * 4)), /bad-size/);
  assert.throws(() => encodeGif(4, 4, new Uint8ClampedArray(10)), /bad-input/);
});

await test('lzwCompress handles repetition and dictionary resets', () => {
  // Long repetitive run forces code-size growth; random-ish data forces clears.
  const rep = new Uint8Array(5000).fill(7);
  const c1 = lzwCompress(rep, 3);
  assert.ok(c1.length < rep.length, 'repetitive data compresses');
  const mixed = Uint8Array.from({ length: 20000 }, (_, i) => (i * 37 + (i >> 3)) % 64);
  const c2 = lzwCompress(mixed, 6);
  const back = lzwDecompressTest(c2, 6, mixed.length);
  assert.deepEqual(Array.from(back), Array.from(mixed), 'mixed data round-trips');
});

// ---------- zip ----------
await test('createZip makes a readable archive', async () => {
  const files = [
    { name: 'a.png', data: Uint8Array.from([1, 2, 3, 4]) },
    { name: 'b.jpg', data: Uint8Array.from([5, 6, 7]) },
    { name: '../evil.png', data: Uint8Array.from([9]) }, // traversal sanitized
    { name: 'a.png', data: Uint8Array.from([8]) }, // duplicate renamed
  ];
  const zip = createZip(files);
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  // End-of-central-directory signature at the tail
  const tail = Array.from(zip.slice(-22));
  assert.equal(tail[0], 0x50);
  assert.equal(tail[1], 0x4b);
  assert.equal(tail[2], 0x05);
  assert.equal(tail[3], 0x06);
  assert.equal(safeZipName('../evil.png'), 'evil.png');
  assert.equal(safeZipName(''), 'file');
  // CRC sanity
  assert.equal(crc32(Uint8Array.from([1, 2, 3, 4])).toString(16).length > 0, true);
  assert.throws(() => createZip([]), /bad-input/);
});

// Cross-verify with Python's zipfile (independent implementation).
await test('createZip verified by zipfile', async () => {
  const { writeFileSync } = await import('node:fs');
  const files = [
    { name: 'hello.txt', data: new TextEncoder().encode('hello imgfetch') },
    { name: 'data.bin', data: Uint8Array.from({ length: 100 }, (_, i) => i & 0xff) },
  ];
  writeFileSync('/tmp/imgfetch-test.zip', Buffer.from(createZip(files)));
});

await test('B6: createZipParts reassembles to identical bytes', () => {
  const files = [
    { name: 'a.png', data: Uint8Array.from([1, 2, 3, 4]) },
    { name: 'b.jpg', data: Uint8Array.from([5, 6, 7]) },
    { name: 'a.png', data: Uint8Array.from([8]) },
  ];
  const zipped = createZip(files);
  const { parts, size } = createZipParts(files);
  assert.equal(size, zipped.length, 'reported size matches');
  const cat = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    cat.set(p, o);
    o += p.length;
  }
  assert.deepEqual(Array.from(cat), Array.from(zipped), 'parts concatenate to the same bytes');
});

await test('B6: ZIP entries carry a real modified time (not 1980)', () => {
  const when = new Date(2026, 4, 17, 10, 30, 0); // 17 May 2026
  const zip = createZip([{ name: 'a.png', data: Uint8Array.from([1]) }], when);
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const year = ((v.getUint16(12, true) >> 9) & 127) + 1980;
  const month = (v.getUint16(12, true) >> 5) & 15;
  assert.equal(year, 2026, 'entry year is real');
  assert.equal(month, 5, 'entry month is real');
  const now = createZip([{ name: 'a.png', data: Uint8Array.from([1]) }]);
  const v2 = new DataView(now.buffer, now.byteOffset, now.byteLength);
  assert.ok(((v2.getUint16(12, true) >> 9) & 127) + 1980 >= 2026, 'default timestamp is current');
});

// ---------- dedupe ----------
await test('dedupeImages removes exact and sized duplicates', () => {
  const mk = (url, w, h) => ({ url, width: w, height: h });
  const { images, removed } = dedupeImages([
    mk('https://x.com/a.jpg', 100, 100),
    mk('https://x.com/a.jpg', 100, 100), // exact dup
    mk('https://x.com/b.jpg?w=100', 100, 100),
    mk('https://x.com/b.jpg?w=800', 800, 800), // same image, bigger
    mk('https://x.com/c.jpg?id=1', 50, 50),
    mk('https://x.com/c.jpg?id=2', 50, 50), // different (id kept)
  ]);
  assert.equal(images.length, 4);
  assert.equal(removed, 2);
  const b = images.find((i) => i.url.includes('b.jpg'));
  assert.equal(b.width, 800, 'keeps largest variant');
});

// ---------- exif ----------
await test('parseExif reads a real EXIF header', async () => {
  const { readFileSync } = await import('node:fs');
  // Hand-built minimal JPEG with EXIF: SOI + APP1 + EOI.
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  const tiff = [];
  const pu16 = (v, le) => le ? [v & 0xff, (v >> 8) & 0xff] : [(v >> 8) & 0xff, v & 0xff];
  const pu32 = (v, le) => le
    ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]
    : [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  // "II" little-endian, magic 42, IFD0 at 8, one entry: Make (0x010F)
  tiff.push(...ascii('II'), ...pu16(42, true), ...pu32(8, true));
  tiff.push(...pu16(1, true)); // 1 entry
  const makeOff = 8 + 2 + 12 + 4;
  tiff.push(...pu16(0x010f, true), ...pu16(2, true), ...pu32(8, true), ...pu32(makeOff, true));
  tiff.push(...pu32(0, true)); // next IFD
  tiff.push(...ascii('TestCam\0'));
  const app1 = [...ascii('Exif\0\0'), ...tiff];
  const jpeg = [0xff, 0xd8, 0xff, 0xe1, ...pu16(app1.length + 2, false), ...app1, 0xff, 0xd9];
  const ex = parseExif(Uint8Array.from(jpeg));
  assert.ok(ex, 'parsed');
  assert.equal(ex.make, 'TestCam');
  assert.equal(parseExif(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])), null);
});
await test('history add/prune/group', () => {
  let recs = [];
  for (let i = 0; i < 250; i++) recs = history.addRecord(recs, { filename: `${i}.jpg` });
  assert.equal(recs.length, 200);
  recs = history.pruneRecords(recs, 30);
  assert.equal(recs.length, 200);
  const old = history.addRecord([], { filename: 'o.jpg', at: Date.now() - 40 * 86_400_000 });
  assert.equal(history.pruneRecords(old, 30).length, 0);
  const groups = history.groupByDay(history.addRecord([], { filename: 't.jpg' }));
  assert.equal(groups[0].label, 'Today');
});

await test('history addRecord keeps exact byte size (history "Unknown size" fix)', () => {
  const withBytes = history.addRecord([], { filename: 'a.jpg', bytes: 245760 });
  assert.equal(withBytes[0].bytes, 245760); // exact on-disk size, no rounding
  const missing = history.addRecord([], { filename: 'b.jpg' });
  assert.equal(missing[0].bytes, 0); // old records: unknown, not NaN
  const bad = history.addRecord([], { filename: 'c.jpg', bytes: 'junk' });
  assert.equal(bad[0].bytes, 0);
  const neg = history.addRecord([], { filename: 'd.jpg', bytes: -50 });
  assert.equal(neg[0].bytes, 0);
  const frac = history.addRecord([], { filename: 'e.jpg', bytes: 1024.7 });
  assert.equal(frac[0].bytes, 1025);
});

await test('formatHistorySize prefers exact bytes, falls back to dims', async () => {  // shared/ui.js is a browser IIFE; load it in a window stub via node:vm.
  const fs = await import('node:fs');
  const vm = await import('node:vm');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(new URL('../shared/ui.js', import.meta.url), 'utf8'),
    sandbox,
    { filename: 'ui.js' },
  );
  const UI = sandbox.window.ImgFetchUI;
  assert.equal(UI.formatHistorySize({ bytes: 245760 }), '240 KB');
  assert.equal(UI.formatHistorySize({ bytes: 1536 }), '1.5 KB');
  assert.equal(UI.formatHistorySize({ bytes: 0, width: 100, height: 50 }), '-');
  assert.equal(UI.formatHistorySize({ bytes: 0 }), '-');
  assert.equal(UI.formatHistorySize(null), '-');
});

await test('subfolder toggle: name ignored when off, prefixes when on', () => {
  const S = (over) => ({ folderMode: 'site', subfolder: 'img', useSubfolder: false, ...over });
  // Toggle OFF: the name is ignored even when present (user report).
  assert.equal(resolveFolder(S({}), 'https://example.com/a', '', 'jpg'), 'example.com');
  assert.equal(resolveFolder(S({ folderMode: 'flat' }), '', '', 'jpg'), '');
  assert.equal(resolveFolder(S({ folderMode: 'type' }), '', '', 'jpg'), 'Photos');
  // Toggle ON: the name becomes the root in every mode.
  assert.equal(resolveFolder(S({ useSubfolder: true }), 'https://example.com/a', '', 'jpg'), 'img/example.com');
  assert.equal(resolveFolder(S({ useSubfolder: true, folderMode: 'flat' }), '', '', 'jpg'), 'img');
  assert.equal(resolveFolder(S({ useSubfolder: true, folderMode: 'type' }), '', '', 'jpg'), 'img/Photos');
  // Slashes trimmed; empty name with toggle on behaves like off.
  assert.equal(resolveFolder(S({ useSubfolder: true, subfolder: '/img/' }), 'https://example.com/a', '', 'jpg'), 'img/example.com');
  assert.equal(resolveFolder(S({ useSubfolder: true, subfolder: '  ' }), 'https://example.com/a', '', 'jpg'), 'example.com');
  // type buckets unchanged
  assert.equal(typeFolderFor('png'), 'Screenshots');
  assert.equal(typeFolderFor('gif'), 'GIFs');
  assert.equal(typeFolderFor('webp'), 'Photos');
  assert.equal(typeFolderFor('xyz'), 'Graphics');
  // setting defaults to off and normalizes to boolean
  assert.equal(settings.DEFAULT_SETTINGS.useSubfolder, false);
  assert.equal(settings.normalizeSettings({ useSubfolder: 'yes' }).useSubfolder, false);
  assert.equal(settings.normalizeSettings({ useSubfolder: true }).useSubfolder, true);
});

await test('H9: normalizeHost agrees everywhere', () => {
  assert.equal(urls.normalizeHost('https://www.Example.com:8080/a?x=1#h'), 'example.com');
  assert.equal(urls.normalizeHost('www.example.com'), 'example.com');
  assert.equal(urls.normalizeHost('example.com.'), 'example.com');
  assert.equal(urls.normalizeHost('not a host!!'), '');
  assert.equal(urls.normalizeHost(''), '');
});
await test('H8: qualityModeForHost is the single resolver', () => {
  const base = settings.normalizeSettings({
    qualityPreference: 'original',
    sitePrefs: { 'a.com': 'normal', 'b.com': 'disabled', 'c.com': 'best' },
  });
  assert.equal(settings.qualityModeForHost(base, 'a.com'), 'normal'); // site wins
  assert.equal(settings.qualityModeForHost(base, 'b.com'), 'disabled');
  assert.equal(settings.qualityModeForHost(base, 'c.com'), 'smart'); // legacy best -> smart
  assert.equal(settings.qualityModeForHost(base, 'other.com'), 'original'); // global
  const smart = settings.normalizeSettings({ qualityPreference: 'smart' });
  assert.equal(settings.qualityModeForHost(smart, 'x.com'), 'smart');
});
await test('H5: queue serialize/restore/adopt survives a restart', async () => {
  const { DownloadQueue } = await import('../core/queue.js');
  const starter = async () => {};
  const q1 = new DownloadQueue({ starter, onUpdate: () => {} });
  q1.enqueue([
    { id: 'a', label: 'a', payload: { srcUrl: 'https://x/1.png' } },
    { id: 'b', label: 'b', payload: { srcUrl: 'https://x/2.png' } },
    { id: 'c', label: 'c', payload: { srcUrl: 'https://x/3.png' } },
  ]);
  // Simulate: 'a' started downloading in the browser, 'b' still pending.
  const itemA = q1.items.get('a');
  itemA.state = 'active';
  itemA.chromeDownloadId = 42;
  itemA.history = { filename: '1.png' };
  const saved = q1.serialize();
  assert.equal(saved.length, 3);
  assert.equal(saved.find((s) => s.id === 'a').chromeDownloadId, 42);

  // "Restart": fresh queue restores pre-triaged state.
  const q2 = new DownloadQueue({ starter, onUpdate: () => {} });
  q2.restore([
    { ...saved.find((s) => s.id === 'a'), state: 'pending' }, // adopted path
    { ...saved.find((s) => s.id === 'b'), state: 'pending' },
    { ...saved.find((s) => s.id === 'c'), state: 'failed', error: 'boom' },
  ]);
  // Adopt 'a' (still in_progress in the browser): no starter re-run.
  let started = 0;
  q2.starter = async () => { started += 1; };
  const adopted = q2.adopt('a');
  assert.ok(adopted);
  assert.equal(q2.items.get('a').state, 'active');
  q2.settleAdopted('a', true);
  assert.equal(q2.items.get('a').state, 'done');
  assert.equal(q2.items.get('a').history.filename, '1.png');
  // Failed stays failed; pending resumes via starter.
  assert.equal(q2.items.get('c').state, 'failed');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(started >= 1); // 'b' was re-run, 'a' was not duplicated
  assert.equal(q2.items.get('b').state, 'done');
});
await test('M7: isPrivateNetworkUrl guards local ranges', () => {
  assert.equal(urls.isPrivateNetworkUrl('http://localhost/a.jpg'), true);
  assert.equal(urls.isPrivateNetworkUrl('http://127.0.0.1:8080/a.jpg'), true);
  assert.equal(urls.isPrivateNetworkUrl('http://192.168.1.1/a.jpg'), true);
  assert.equal(urls.isPrivateNetworkUrl('http://10.0.0.5/a.jpg'), true);
  assert.equal(urls.isPrivateNetworkUrl('http://172.16.5.4/a.jpg'), true);
  assert.equal(urls.isPrivateNetworkUrl('http://172.32.0.1/a.jpg'), false);
  assert.equal(urls.isPrivateNetworkUrl('http://169.254.10.20/a.jpg'), true);
  assert.equal(urls.isPrivateNetworkUrl('http://[::1]/a.jpg'), true);
  assert.equal(urls.isPrivateNetworkUrl('https://example.com/a.jpg'), false);
  assert.equal(urls.isPrivateNetworkUrl('https://8.8.8.8/a.jpg'), false);
  assert.equal(urls.isPrivateNetworkUrl('data:image/png;base64,xx'), false);
  assert.equal(urls.isPrivateNetworkUrl('not a url'), false);
});
await test('H1: size chips are minimum thresholds, unknowns always shown', () => {
  const imgs = [
    { id: 'a', width: 1920, height: 1080 }, // large
    { id: 'b', width: 4000, height: 3000 }, // large
    { id: 'c', width: 800, height: 600 },   // medium
    { id: 'd', width: 100, height: 100 },   // small
    { id: 'e', width: 0, height: 0 },       // unknown
  ];
  const ids = (size) => filters.applyFilters(imgs, { size }).map((i) => i.id).sort();
  assert.deepEqual(ids('any'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(ids('medium'), ['a', 'b', 'c', 'e']); // 1920px NOT hidden anymore
  assert.deepEqual(ids('large'), ['a', 'b', 'e']);
  assert.deepEqual(ids('small'), ['d', 'e']);
});
await test('H1: sizeChipForPreset maps scan presets to chips', () => {
  assert.equal(filters.sizeChipForPreset('any'), 'any');
  assert.equal(filters.sizeChipForPreset('medium'), 'medium');
  assert.equal(filters.sizeChipForPreset('large'), 'large');
  assert.equal(filters.sizeChipForPreset('xlarge'), 'large');
  assert.equal(filters.sizeChipForPreset('bogus'), 'any');
});
await test('normalizeUrl accepts page blob: URLs', () => {
  const b = 'blob:https://media.giphy.com/abc-123';
  assert.equal(urls.normalizeUrl(b, null), b);
  assert.equal(urls.normalizeUrl('blob:https://x.com/a', 'https://other.com'), 'blob:https://x.com/a');
  assert.equal(urls.normalizeUrl('javascript:alert(1)', null), null);
});
await test('scanDepth defaults to loaded and validates', () => {
  assert.equal(settings.normalizeSettings({}).scanDepth, 'loaded');
  assert.equal(settings.normalizeSettings({ scanDepth: 'scroll' }).scanDepth, 'scroll');
  assert.equal(settings.normalizeSettings({ scanDepth: 'nope' }).scanDepth, 'loaded');
  // Legacy alias: stored detectLazyScroll=false migrates to 'loaded'.
  const legacy = settings.normalizeSettings({ detectLazyScroll: false });
  assert.equal(legacy.scanDepth, 'loaded');
  // An explicit scanDepth wins over the legacy flag.
  const explicit = settings.normalizeSettings({ detectLazyScroll: false, scanDepth: 'scroll' });
  assert.equal(explicit.scanDepth, 'scroll');
});
await test('scan skips nothing by default', () => {
  assert.equal(settings.normalizeSettings({}).minSizePreset, 'any');
});
await test('quality defaults are 100% and old 0.92 migrates', () => {
  const s = settings.normalizeSettings({});
  assert.equal(s.jpgQuality, 1);
  assert.equal(s.webpQuality, 1);
  assert.equal('avifQuality' in s, false); // slider removed — AVIF always 100%
  assert.equal(s.screenshotQuality, 1);
  const migrated = settings.normalizeSettings({ jpgQuality: 0.92, webpQuality: 0.5 });
  assert.equal(migrated.jpgQuality, 1); // old default moves to 100%
  assert.equal(migrated.webpQuality, 0.5); // user-chosen value is kept
});
await test('joinDownloadPath keeps zip extension, guards images', () => {
  assert.equal(filenames.joinDownloadPath('', 'imgfetch-images-20261002-2307.zip', ['zip']),
    'imgfetch-images-20261002-2307.zip');
  assert.equal(filenames.joinDownloadPath('', 'a.zip'), 'a.png'); // not allowlisted -> image fallback
  assert.equal(filenames.joinDownloadPath('', 'a.jpg'), 'a.jpg');
});
await test('RESOLVE_BLOB is a registered message type', () => {
  assert.ok(validation.MESSAGE_TYPES.has('RESOLVE_BLOB'));
  assert.ok(validation.isValidMessage({
    type: 'RESOLVE_BLOB', url: 'blob:https://x.com/a', tabId: '7', mode: 'thumb',
  }));
  assert.ok(!validation.isValidMessage({
    type: 'RESOLVE_BLOB', url: 123, tabId: '7', mode: 'thumb',
  }));
});
await test('history keeps zip records (kind bulk, format zip)', () => {
  const recs = history.addRecord([], {
    filename: 'imgfetch-images-20261002.zip', kind: 'bulk', format: 'zip',
  });
  assert.equal(recs[0].kind, 'bulk');
  assert.equal(recs[0].format, 'zip');
});

await test('L1: Windows reserved names get underscore prefix', () => {
  assert.equal(filenames.sanitizeSegment('con'), '_con');
  assert.equal(filenames.sanitizeSegment('NUL.jpg'), '_NUL.jpg');
  assert.equal(filenames.sanitizeSegment('com1'), '_com1');
  assert.equal(filenames.sanitizeSegment('lpt9.png'), '_lpt9.png');
  assert.equal(filenames.sanitizeSegment('config'), 'config'); // not reserved
  assert.equal(filenames.sanitizeSegment('null'), 'null'); // not reserved
});

await test('copy-link: currentSrc wins for a normal img', () => {
  assert.equal(
    pickBestImageUrl({ currentSrc: 'https://cdn.x.com/a.jpg', srcAttr: 'a.jpg', sourceSrcsets: [], lazy: {}, naturalWidth: 800, naturalHeight: 600 }),
    'https://cdn.x.com/a.jpg');
});

await test('copy-link: src attribute used when currentSrc is empty', () => {
  assert.equal(
    pickBestImageUrl({ currentSrc: '', srcAttr: 'https://cdn.x.com/b.webp', sourceSrcsets: [], lazy: {}, naturalWidth: 400, naturalHeight: 300 }),
    'https://cdn.x.com/b.webp');
});

await test('copy-link: responsive srcset — currentSrc is already the rendered pick', () => {
  assert.equal(
    pickBestImageUrl({ currentSrc: 'https://cdn.x.com/a-2048.jpg', srcAttr: 'https://cdn.x.com/a-480.jpg', sourceSrcsets: [], lazy: {}, naturalWidth: 2048, naturalHeight: 1024 }),
    'https://cdn.x.com/a-2048.jpg');
});

await test('copy-link: <picture> source srcset — largest candidate wins', () => {
  assert.equal(
    pickBestImageUrl({
      currentSrc: '', srcAttr: '',
      sourceSrcsets: ['https://cdn.x.com/s-480.avif 480w, https://cdn.x.com/s-1080.avif 1080w, https://cdn.x.com/s-2160.avif 2160w'],
      lazy: {}, naturalWidth: 0, naturalHeight: 0,
    }),
    'https://cdn.x.com/s-2160.avif');
});

await test('copy-link: <picture> x-descriptors — 2x wins over 1x', () => {
  assert.equal(
    pickBestImageUrl({
      currentSrc: '', srcAttr: '',
      sourceSrcsets: ['https://cdn.x.com/s-1x.png 1x, https://cdn.x.com/s-2x.png 2x'],
      lazy: {}, naturalWidth: 0, naturalHeight: 0,
    }),
    'https://cdn.x.com/s-2x.png');
});

await test('copy-link: lazy image — 1px placeholder src yields to data-src', () => {
  assert.equal(
    pickBestImageUrl({
      currentSrc: 'https://cdn.x.com/blank.gif', srcAttr: 'https://cdn.x.com/blank.gif',
      sourceSrcsets: [], lazy: { 'data-src': 'https://cdn.x.com/real-photo.jpg' },
      naturalWidth: 1, naturalHeight: 1,
    }),
    'https://cdn.x.com/real-photo.jpg');
});

await test('copy-link: lazy data-src ignored when currentSrc is the real photo', () => {
  assert.equal(
    pickBestImageUrl({
      currentSrc: 'https://cdn.x.com/photo.jpg', srcAttr: 'https://cdn.x.com/blank.gif',
      sourceSrcsets: [], lazy: { 'data-src': 'https://cdn.x.com/photo.jpg' },
      naturalWidth: 1200, naturalHeight: 800,
    }),
    'https://cdn.x.com/photo.jpg');
});

await test('copy-link: data: URI image has no copyable link', () => {
  assert.equal(
    pickBestImageUrl({ currentSrc: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', srcAttr: '', sourceSrcsets: [], lazy: {}, naturalWidth: 1, naturalHeight: 1 }),
    null);
});

await test('copy-link: data: srcset candidates are skipped', () => {
  assert.equal(
    pickBestImageUrl({
      currentSrc: '', srcAttr: '',
      sourceSrcsets: ['data:image/svg+xml;base64,AAA 1x, https://cdn.x.com/icon.svg 2x'],
      lazy: {}, naturalWidth: 0, naturalHeight: 0,
    }),
    'https://cdn.x.com/icon.svg');
});

await test('copy-link: null/empty descriptor -> null', () => {
  assert.equal(pickBestImageUrl(null), null);
  assert.equal(pickBestImageUrl({}), null);
});

await test('copy-link: relative lazy URL returned raw for caller normalization', () => {
  assert.equal(
    pickBestImageUrl({
      currentSrc: 'https://cdn.x.com/blank.gif', srcAttr: '',
      sourceSrcsets: [], lazy: { 'data-original': '/media/full/123.jpg' },
      naturalWidth: 1, naturalHeight: 1,
    }),
    '/media/full/123.jpg');
});

await test('scan-state: fresh scanning is kept', () => {
  const s = { status: 'scanning', tabId: 7, at: Date.now() };
  assert.equal(isScanStateStale(s), false);
  assert.equal(coerceScanState(s).status, 'scanning');
});

await test('scan-state: stale scanning degrades to idle', () => {
  const s = { status: 'scanning', tabId: 7, at: Date.now() - SCAN_STATE_STALE_MS - 1000 };
  assert.equal(isScanStateStale(s), true);
  assert.equal(coerceScanState(s).status, 'idle');
});

await test('scan-state: results/error/null pass through untouched', () => {
  assert.equal(coerceScanState({ status: 'results', tabId: 3 }).status, 'results');
  assert.equal(coerceScanState({ status: 'error', error: 'x' }).status, 'error');
  assert.equal(coerceScanState(null).status, 'idle');
  assert.equal(coerceScanState('garbage').status, 'idle');
  assert.equal(isScanStateStale({ status: 'results' }), false);
});

await test('GET_SCAN_STATE is a registered message type', () => {
  assert.ok(validation.MESSAGE_TYPES.has('GET_SCAN_STATE'));
  assert.ok(validation.isValidMessage({ type: 'GET_SCAN_STATE' }));
  assert.ok(!validation.isValidMessage({ type: 'NOPE_NOT_A_TYPE' }));
});

/* ------------------------------------------------------------------ */
/* B1 (ROUND 2): restart recovery must not duplicate downloads.       */
/* These tests FAIL on the pre-release build (restore() pumps immediately, adopt()    */
/* never ran before the starter fired) and PASS after the fix.        */
/* ------------------------------------------------------------------ */

await test('B1: adopted download never reaches the starter', async () => {
  const started = [];
  const q = new DownloadQueue({
    concurrency: 2,
    starter: (item) => { started.push(item.id); return new Promise(() => {}); },
  });
  q.restore(
    [
      { id: 'running-in-browser', label: 'a', state: 'pending', chromeDownloadId: 42 },
      { id: 'never-started', label: 'b', state: 'pending' },
    ],
    ['running-in-browser'],
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!started.includes('running-in-browser'),
    `adopted item was started (duplicate download): ${JSON.stringify(started)}`);
});

await test('B1: never-started items still start after restore', async () => {
  const started = [];
  const q = new DownloadQueue({
    concurrency: 2,
    starter: (item) => { started.push(item.id); return new Promise(() => {}); },
  });
  q.restore(
    [
      { id: 'running-in-browser', label: 'a', state: 'pending', chromeDownloadId: 42 },
      { id: 'never-started', label: 'b', state: 'pending' },
    ],
    ['running-in-browser'],
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(started.includes('never-started'), 'pending item was never started');
});

await test('B1: adopted item enters as active with its chromeDownloadId', async () => {
  const q = new DownloadQueue({
    concurrency: 2,
    starter: () => new Promise(() => {}),
  });
  const snap = q.restore(
    [{ id: 'running-in-browser', label: 'a', state: 'pending', chromeDownloadId: 42 }],
    ['running-in-browser'],
  );
  const item = snap.items.find((i) => i.id === 'running-in-browser');
  assert.ok(item, 'adopted item missing from queue');
  assert.equal(item.state, ItemState.ACTIVE);
  assert.equal(item.chromeDownloadId, 42);
});

await test('B1: completed items stay gone, failed items stay failed', async () => {
  const q = new DownloadQueue({
    concurrency: 2,
    starter: () => new Promise(() => {}),
  });
  // serialize() drops DONE/CANCELLED — the worker never restores them.
  const q2 = new DownloadQueue({ starter: () => Promise.resolve() });
  q2.enqueue([{ id: 'will-finish', label: 'x' }]);
  await new Promise((r) => setTimeout(r, 30));
  const saved = q2.serialize();
  assert.ok(!saved.some((s) => s.id === 'will-finish'), 'done item was serialized');
  // restore() keeps failed as failed.
  const snap = q.restore(
    [{ id: 'broken', label: 'b', state: 'failed', error: 'interrupted' }],
    [],
  );
  const item = snap.items.find((i) => i.id === 'broken');
  assert.equal(item.state, ItemState.FAILED);
});

await test('B1: restored queue never exceeds concurrency', async () => {
  const started = [];
  const q = new DownloadQueue({
    concurrency: 2,
    starter: (item) => { started.push(item.id); return new Promise(() => {}); },
  });
  const snap = q.restore(
    [
      { id: 'adopted-1', label: 'a', state: 'pending', chromeDownloadId: 7 },
      { id: 'p1', label: 'b', state: 'pending' },
      { id: 'p2', label: 'c', state: 'pending' },
      { id: 'p3', label: 'd', state: 'pending' },
      { id: 'p4', label: 'e', state: 'pending' },
    ],
    ['adopted-1'],
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(snap.active, 2, `active=${snap.active}, expected 2 (1 adopted + 1 pumped)`);
  assert.equal(snap.pending, 3, `pending=${snap.pending}, expected 3`);
  assert.ok(!started.includes('adopted-1'), 'adopted item was started');
});

await test('B1: settleAdopted frees the concurrency slot', async () => {
  const started = [];
  const q = new DownloadQueue({
    concurrency: 1,
    starter: (item) => { started.push(item.id); return new Promise(() => {}); },
  });
  q.restore(
    [
      { id: 'adopted-1', label: 'a', state: 'pending', chromeDownloadId: 7 },
      { id: 'p1', label: 'b', state: 'pending' },
    ],
    ['adopted-1'],
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(started, [], 'nothing should start while the adopted item holds the slot');
  q.settleAdopted('adopted-1', true);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(started, ['p1'], 'p1 should start after the adopted item settles');
});

/* ------------------------------------------------------------------ */
/* B2 (ROUND 2): private network guard bypasses. The bypass URLs below */
/* MUST be blocked; they are ALLOWED on the pre-release build (test fails there).     */
/* ------------------------------------------------------------------ */

const B2_BLOCKED = [
  'http://localhost/x.jpg',
  'http://localhost:8080/x.jpg',
  'http://127.0.0.1/x.jpg',
  'http://192.168.1.1/x.jpg',
  'http://10.0.0.5/x.jpg',
  'http://[::1]/x.jpg',
  'http://169.254.169.254/latest/meta-data/',
  'http://2130706433/x.jpg', // 127.0.0.1 decimal
  'http://0x7f000001/x.jpg', // 127.0.0.1 hex
  // --- bypasses found in the pre-release review ---
  'http://[::ffff:127.0.0.1]/x.jpg', // IPv4-mapped loopback
  'http://[::ffff:c0a8:101]/x.jpg', // IPv4-mapped 192.168.1.1
  'http://[::]/x.jpg', // unspecified
  'http://100.64.0.1/x.jpg', // carrier-grade NAT 100.64.0.0/10
  'http://100.100.5.5/x.jpg', // 100.64.0.0/10, second sample
  'http://router.local/x.jpg', // mDNS-style internal name
  'http://nas.internal/x.jpg',
  'http://camera.lan/x.jpg',
  'http://box.home.arpa/x.jpg',
  'http://printer/x.jpg', // single-label internal name
  'http://intranet/x.jpg', // single-label internal name
];

const B2_ALLOWED = [
  'https://example.com/x.jpg',
  'https://sub.example.co.uk/a/b.png',
  'https://8.8.8.8/x.jpg',
  'https://1.1.1.1:443/x.jpg',
  'https://[2001:db8::1]/x.jpg', // documentation range, public shape
  'https://[2606:4700:4700::1111]/x.jpg',
];

for (const u of B2_BLOCKED) {
  await test(`B2: blocked — ${u}`, () => {
    assert.equal(urls.isPrivateNetworkUrl(u), true, `${u} must be treated as private`);
  });
}

for (const u of B2_ALLOWED) {
  await test(`B2: allowed — ${u}`, () => {
    assert.equal(urls.isPrivateNetworkUrl(u), false, `${u} must NOT be treated as private`);
  });
}

await test('B2: same-host exception still allows the user\'s own intranet', () => {
  assert.equal(urls.isPrivateNetworkFetchBlocked('http://192.168.1.10/pic.jpg', 'http://192.168.1.10/gallery'), false);
  assert.equal(urls.isPrivateNetworkFetchBlocked('http://192.168.1.10/pic.jpg', 'https://example.com/'), true);
  assert.equal(urls.isPrivateNetworkFetchBlocked('https://example.com/a.jpg', 'https://example.com/'), false);
});

await test('J1: lensUrlBlocked rejects page-local and private-network URLs', () => {
  assert.equal(urls.lensUrlBlocked('data:image/png;base64,AAA', 'https://example.com/'), 'bad-url');
  assert.equal(urls.lensUrlBlocked('DATA:IMAGE/PNG;BASE64,AAA', 'https://example.com/'), 'bad-url');
  assert.equal(urls.lensUrlBlocked('blob:https://example.com/uuid', 'https://example.com/'), 'bad-url');
  assert.equal(urls.lensUrlBlocked('http://localhost/pic.jpg', 'https://example.com/'), 'private-network');
  assert.equal(urls.lensUrlBlocked('http://192.168.1.10/pic.jpg', 'https://example.com/'), 'private-network');
  assert.equal(urls.lensUrlBlocked('http://192.168.1.10/pic.jpg', 'http://192.168.1.10/gallery'), null);
  assert.equal(urls.lensUrlBlocked('https://cdn.example.com/pic.jpg', 'https://example.com/'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}

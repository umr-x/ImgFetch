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
 * ImgFetch unit tests — PNG quality quantization (J2).
 * Runs with plain Node, no dependencies: node tests/test-png-quantize.mjs
 */
import { strict as assert } from 'node:assert';
import { quantizePngRgba, qualityToColorCount } from '../core/png-quantize.js';

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (e) {
    failed += 1;
    failures.push(`${name}: ${e.message}`);
  }
}

// Deterministic photographic fixture: smooth gradients + noise.
function makePhoto(w, h, seed) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      rgba[i] = Math.round(120 + 80 * Math.sin(x / 9) + 40 * rnd());
      rgba[i + 1] = Math.round(100 + 70 * Math.cos(y / 11) + 40 * rnd());
      rgba[i + 2] = Math.round(90 + 60 * Math.sin((x + y) / 13) + 40 * rnd());
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function distinctColors(rgba) {
  const set = new Set();
  for (let i = 0; i < rgba.length; i += 4) {
    set.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
  }
  return set.size;
}

function meanAbsError(a, b) {
  let sum = 0;
  const n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / (n * 3);
}

await test('J2: quality 100% returns pixels byte-identical (lossless)', () => {
  const rgba = makePhoto(48, 48, 7);
  const out = quantizePngRgba(rgba, 48, 48, 1);
  assert.deepEqual(Array.from(out), Array.from(rgba));
});

await test('J2: qualityToColorCount is monotonic in quality', () => {
  const qs = [1, 0.9, 0.7, 0.5, 0.4, 0.3, 0.1];
  const counts = qs.map(qualityToColorCount);
  for (let i = 1; i < counts.length; i += 1) {
    assert.ok(counts[i] <= counts[i - 1], `not monotonic at ${qs[i]}`);
  }
  assert.ok(counts[0] >= 200, '100% should allow a full palette');
  assert.ok(counts[counts.length - 1] <= 16, '10% should be heavily quantized');
});

await test('J2: distinct colors never increase as quality drops', () => {
  const rgba = makePhoto(64, 64, 42);
  let prev = Infinity;
  for (const q of [0.9, 0.7, 0.4, 0.1]) {
    const out = quantizePngRgba(rgba, 64, 64, q);
    const n = distinctColors(out);
    assert.ok(n <= prev, `quality ${q}: ${n} colors > previous ${prev}`);
    prev = n;
  }
});

await test('J2: output keeps dimensions and preserves alpha', () => {
  const w = 32;
  const h = 24;
  const rgba = makePhoto(w, h, 99);
  for (let i = 3; i < rgba.length; i += 8) rgba[i] = 128; // half alpha on some
  const out = quantizePngRgba(rgba, w, h, 0.4);
  assert.equal(out.length, rgba.length);
  for (let i = 3; i < rgba.length; i += 4) {
    assert.equal(out[i], rgba[i], `alpha changed at pixel ${i / 4}`);
  }
});

await test('J2: bounded mean error at 70%', () => {
  const rgba = makePhoto(64, 64, 5);
  const out = quantizePngRgba(rgba, 64, 64, 0.7);
  const err = meanAbsError(rgba, out);
  assert.ok(err < 14, `mean abs error ${err.toFixed(2)} exceeds bound 14`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}

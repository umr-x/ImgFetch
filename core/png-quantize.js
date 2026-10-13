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
 * ImgFetch, core/png-quantize.js
 * J2: makes the PNG quality slider real. The browser's PNG encoder is always
 * lossless, so below 100% we reduce the color count with median-cut first —
 * fewer distinct colors compress much better, so the file gets smaller.
 * 100% returns the pixels untouched (byte-identical to the old output).
 * Pure functions, no chrome.* APIs. Alpha is preserved per pixel.
 */

const SAMPLE_CAP = 200_000; // pixels sampled for palette building

function channelRange(pixels, channel) {
  let min = 255;
  let max = 0;
  for (let i = 0; i < pixels.length; i += 1) {
    const v = pixels[i][channel];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

/** Median-cut quantization into at most maxColors palette entries. */
function medianCut(pixels, maxColors) {
  if (!pixels.length) return [[0, 0, 0]];
  let boxes = [pixels];
  while (boxes.length < maxColors) {
    let bi = -1;
    let bestRange = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box.length < 2) continue;
      const range = Math.max(
        channelRange(box, 0),
        channelRange(box, 1),
        channelRange(box, 2),
      );
      if (range > bestRange) {
        bestRange = range;
        bi = i;
      }
    }
    if (bi < 0 || bestRange <= 0) break;
    const box = boxes[bi];
    const ranges = [channelRange(box, 0), channelRange(box, 1), channelRange(box, 2)];
    let channel = 0;
    if (ranges[1] >= ranges[0] && ranges[1] >= ranges[2]) channel = 1;
    else if (ranges[2] >= ranges[0] && ranges[2] >= ranges[1]) channel = 2;
    const sorted = box.slice().sort((a, b) => a[channel] - b[channel]);
    const mid = Math.max(1, Math.floor(sorted.length / 2));
    boxes = [
      ...boxes.slice(0, bi),
      ...boxes.slice(bi + 1),
      sorted.slice(0, mid),
      sorted.slice(mid),
    ];
  }
  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const p of box) {
      r += p[0];
      g += p[1];
      b += p[2];
    }
    const n = Math.max(1, box.length);
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

/**
 * Map a quality slider value (0.1–1) to a palette size. Monotonic:
 * higher quality always means at least as many colors.
 */
export function qualityToColorCount(quality) {
  const q = Math.min(1, Math.max(0.1, Number(quality) || 1));
  return Math.max(2, Math.round(2 + 254 * q * q));
}

/**
 * Quantize RGBA pixels for PNG output at the given quality.
 * quality >= 1 returns the input untouched (lossless, byte-identical).
 * Below 1, RGB is median-cut to qualityToColorCount(quality) colors;
 * each pixel keeps its original alpha.
 * Returns a new Uint8ClampedArray of the same length.
 */
export function quantizePngRgba(rgba, width, height, quality) {
  const q = Math.min(1, Math.max(0.1, Number(quality) || 1));
  if (q >= 1) return rgba;
  const total = width * height;
  const step = Math.max(1, Math.floor(total / SAMPLE_CAP));
  const samples = [];
  for (let p = 0; p < total; p += step) {
    const i = p * 4;
    samples.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  }
  const palette = medianCut(samples, qualityToColorCount(q));
  // Nearest-color lookup with a 15-bit cache.
  const cache = new Map();
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < palette.length; i += 1) {
      const p = palette[i];
      const dr = r - p[0];
      const dg = g - p[1];
      const db = b - p[2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
        if (dist === 0) break;
      }
    }
    cache.set(key, best);
    return best;
  };
  const out = new Uint8ClampedArray(rgba.length);
  for (let p = 0; p < total; p += 1) {
    const i = p * 4;
    const c = palette[nearest(rgba[i], rgba[i + 1], rgba[i + 2])];
    out[i] = c[0];
    out[i + 1] = c[1];
    out[i + 2] = c[2];
    out[i + 3] = rgba[i + 3]; // alpha preserved exactly
  }
  return out;
}

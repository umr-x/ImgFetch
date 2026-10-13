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
 * ImgFetch — core/gif.js
 * Minimal pure-JS GIF89a encoder (single frame). No DOM, no chrome.*
 * Lets ImgFetch genuinely encode GIF files instead of renaming other formats.
 *
 * Pipeline: transparency detection → median-cut palette (≤256 colors) →
 * nearest-color mapping (with a 15-bit color cache) → GIF LZW compression →
 * GIF89a byte assembly.
 */

const MAX_DIM = 4000;
const MAX_PIXELS = 16_000_000;
const PALETTE_SAMPLE_CAP = 500_000; // pixels sampled for palette building

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

/** Median-cut quantization of opaque pixels into ≤ maxColors palette entries. */
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
    // Split along the widest channel at the median.
    let channel = 0;
    const ranges = [channelRange(box, 0), channelRange(box, 1), channelRange(box, 2)];
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

function nearestIndex(r, g, b, palette, cache) {
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
}

/** GIF-variant LZW compression. Returns a Uint8Array of packed codes. */
export function lzwCompress(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const out = [];
  let acc = 0;
  let bits = 0;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = new Map();

  const emitRaw = (code) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>= 8;
      bits -= 8;
    }
  };
  const reset = () => {
    dict = new Map();
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  };

  emitRaw(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const byte = indices[i];
    const key = (prefix << 8) | byte;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
    } else {
      emitRaw(prefix);
      if (nextCode >= 4096) {
        // Dictionary full — clear and restart.
        emitRaw(clearCode);
        reset();
      } else {
        dict.set(key, nextCode);
        nextCode += 1;
        // Standard GIF rule (verified against real decoders): grow AFTER the
        // table write, and only when nextCode strictly exceeds the current
        // capacity. `>=` here desyncs with standard decoders.
        if (nextCode > (1 << codeSize) && codeSize < 12) codeSize += 1;
      }
      prefix = byte;
    }
  }
  emitRaw(prefix);
  emitRaw(eoiCode);
  if (bits > 0) out.push(acc & 0xff);
  return Uint8Array.from(out);
}

/**
 * Encode one frame's pixels: palette + indices + LZW. Shared by the
 * single-frame and animated encoders.
 */
function encodeFrame(w, h, rgba) {
  const total = w * h;
  let hasTransparent = false;
  const sample = [];
  const stride = Math.max(1, Math.ceil(total / PALETTE_SAMPLE_CAP));
  for (let p = 0; p < total; p += stride) {
    const o = p * 4;
    if (rgba[o + 3] < 128) {
      hasTransparent = true;
      continue;
    }
    sample.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
  }
  const maxColors = hasTransparent ? 255 : 256;
  const palette = medianCut(sample, maxColors);
  const transparentIndex = hasTransparent ? palette.length : -1;
  if (hasTransparent) palette.push([0, 0, 0]);

  const cache = new Map();
  const indices = new Uint8Array(total);
  for (let p = 0; p < total; p += 1) {
    const o = p * 4;
    indices[p] = rgba[o + 3] < 128
      ? transparentIndex
      : nearestIndex(rgba[o], rgba[o + 1], rgba[o + 2], palette, cache);
  }
  const colorBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))));
  return {
    palette,
    transparentIndex,
    hasTransparent,
    minCodeSize: Math.max(2, colorBits),
    tableSizeCode: Math.max(0, colorBits - 1),
    compressed: lzwCompress(indices, Math.max(2, colorBits)),
  };
}

/**
 * Encode an animated GIF89a (multiple frames, NETSCAPE looping).
 * @param {number} width
 * @param {number} height
 * @param {Array<{data: Uint8ClampedArray, delayCs: number}>} frames
 * @returns {Uint8Array} the .gif file bytes
 */
export function encodeGifAnimated(width, height, frames) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!(w > 0 && h > 0 && w <= MAX_DIM && h <= MAX_DIM)) throw new Error('bad-size');
  if (!Array.isArray(frames) || frames.length < 2 || frames.length > 120) throw new Error('bad-frames');
  if (w * h > MAX_PIXELS) throw new Error('too-large');

  const bytes = [];
  const pushStr = (s) => {
    for (let i = 0; i < s.length; i += 1) bytes.push(s.charCodeAt(i));
  };
  const push16 = (v) => {
    bytes.push(v & 0xff, (v >> 8) & 0xff);
  };
  const pushBlocks = (compressed) => {
    for (let i = 0; i < compressed.length; i += 255) {
      const chunk = compressed.subarray(i, i + 255);
      bytes.push(chunk.length);
      for (const b of chunk) bytes.push(b);
    }
    bytes.push(0x00);
  };

  pushStr('GIF89a');
  push16(w);
  push16(h);
  bytes.push(0x70); // no global color table; 8-bit color resolution
  bytes.push(0);
  bytes.push(0);
  // NETSCAPE2.0 — loop forever.
  bytes.push(0x21, 0xff, 0x0b);
  pushStr('NETSCAPE2.0');
  bytes.push(0x03, 0x01);
  push16(0);
  bytes.push(0x00);

  for (const frame of frames) {
    const rgba = frame.data;
    if (!rgba || rgba.length < w * h * 4) throw new Error('bad-input');
    const enc = encodeFrame(w, h, rgba);
    const delayCs = Math.min(65535, Math.max(2, Math.round(Number(frame.delayCs) || 10)));
    // Graphic Control Extension
    bytes.push(0x21, 0xf9, 0x04);
    bytes.push(enc.hasTransparent ? 0x05 : 0x04); // disposal=1 (do not dispose)
    push16(delayCs);
    bytes.push(enc.hasTransparent ? enc.transparentIndex : 0);
    bytes.push(0x00);
    // Image Descriptor with a per-frame local color table
    bytes.push(0x2c);
    push16(0);
    push16(0);
    push16(w);
    push16(h);
    bytes.push(0x80 | enc.tableSizeCode);
    const entries = 1 << (enc.tableSizeCode + 1);
    for (let i = 0; i < entries; i += 1) {
      const c = enc.palette[i] || [0, 0, 0];
      bytes.push(c[0], c[1], c[2]);
    }
    bytes.push(enc.minCodeSize);
    pushBlocks(enc.compressed);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}
/**
 * Encode RGBA pixels as a single-frame GIF89a file.
 */
export function encodeGif(width, height, rgba) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!(w > 0 && h > 0 && w <= MAX_DIM && h <= MAX_DIM)) throw new Error('bad-size');
  if (w * h > MAX_PIXELS) throw new Error('too-large');
  if (!rgba || rgba.length < w * h * 4) throw new Error('bad-input');

  const enc = encodeFrame(w, h, rgba);
  const { palette, transparentIndex, hasTransparent, minCodeSize } = enc;
  const gctSizeCode = enc.tableSizeCode;

  // Assemble GIF89a.
  const gctEntries = 1 << (gctSizeCode + 1);
  const bytes = [];
  const pushStr = (s) => {
    for (let i = 0; i < s.length; i += 1) bytes.push(s.charCodeAt(i));
  };
  const push16 = (v) => {
    bytes.push(v & 0xff, (v >> 8) & 0xff);
  };

  pushStr('GIF89a');
  push16(w);
  push16(h);
  bytes.push(0x80 | 0x70 | gctSizeCode); // GCT flag, 8-bit color res, GCT size
  bytes.push(0); // background color index
  bytes.push(0); // pixel aspect ratio
  for (let i = 0; i < gctEntries; i += 1) {
    const c = palette[i] || [0, 0, 0];
    bytes.push(c[0], c[1], c[2]);
  }
  if (hasTransparent) {
    bytes.push(0x21, 0xf9, 0x04); // Graphic Control Extension
    bytes.push(0x01); // transparent color flag
    push16(0); // delay
    bytes.push(transparentIndex);
    bytes.push(0x00); // terminator
  }
  bytes.push(0x2c); // Image Descriptor
  push16(0);
  push16(0);
  push16(w);
  push16(h);
  bytes.push(0x00); // no local color table
  bytes.push(minCodeSize);
  for (let i = 0; i < enc.compressed.length; i += 255) {
    const chunk = enc.compressed.subarray(i, i + 255);
    bytes.push(chunk.length);
    for (const b of chunk) bytes.push(b);
  }
  bytes.push(0x00); // block terminator
  bytes.push(0x3b); // trailer
  return Uint8Array.from(bytes);
}

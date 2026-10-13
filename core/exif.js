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
 * ImgFetch — core/exif.js
 * Minimal EXIF parser for JPEG files. Pure, no DOM, no chrome.*.
 * Reads: camera make/model, date taken, orientation, pixel dimensions,
 * and GPS coordinates when present. Returns null when there's no EXIF.
 */

function readAscii(view, offset, length) {
  let s = '';
  for (let i = 0; i < length; i += 1) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function tagValue(view, tiffStart, little, type, count, valueOffset) {
  const getU16 = (o) => little ? view.getUint16(o, true) : view.getUint16(o, false);
  const getU32 = (o) => little ? view.getUint32(o, true) : view.getUint32(o, false);
  const inline = type === 3 ? 2 : type === 4 ? 4 : 1;
  const total = inline * count;
  const base = total <= 4 ? valueOffset : tiffStart + getU32(valueOffset);
  if (type === 2) return readAscii(view, base, count); // ASCII
  if (type === 3 && count === 1) return getU16(base); // SHORT
  if (type === 4 && count === 1) return getU32(base); // LONG
  if (type === 5 && count === 1) { // RATIONAL
    const num = little ? view.getUint32(base, true) : view.getUint32(base, false);
    const den = little ? view.getUint32(base + 4, true) : view.getUint32(base + 4, false);
    return den === 0 ? 0 : num / den;
  }
  if (type === 5) { // RATIONAL array (GPS coords)
    const vals = [];
    for (let i = 0; i < count; i += 1) {
      const num = little ? view.getUint32(base + i * 8, true) : view.getUint32(base + i * 8, false);
      const den = little ? view.getUint32(base + i * 8 + 4, true) : view.getUint32(base + i * 8 + 4, false);
      vals.push(den === 0 ? 0 : num / den);
    }
    return vals;
  }
  return null;
}

function parseIfd(view, tiffStart, little, ifdOffset, want) {
  const out = {};
  const getU16 = (o) => little ? view.getUint16(o, true) : view.getUint16(o, false);
  const entries = getU16(tiffStart + ifdOffset);
  if (entries > 200) return out;
  for (let i = 0; i < entries; i += 1) {
    const e = tiffStart + ifdOffset + 2 + i * 12;
    const tag = getU16(e);
    if (!Object.prototype.hasOwnProperty.call(want, tag)) continue;
    const type = getU16(e + 2);
    const count = little ? view.getUint32(e + 4, true) : view.getUint32(e + 4, false);
    out[want[tag]] = tagValue(view, tiffStart, little, type, count, e + 8);
  }
  const nextIfd = (little ? view.getUint32(tiffStart + ifdOffset + 2 + entries * 12, true)
    : view.getUint32(tiffStart + ifdOffset + 2 + entries * 12, false));
  return { values: out, nextIfd };
}

function gpsToDecimal(ref, vals) {
  if (!Array.isArray(vals) || vals.length < 3) return null;
  const dec = vals[0] + vals[1] / 60 + vals[2] / 3600;
  const neg = ref === 'S' || ref === 'W';
  return Math.round((neg ? -dec : dec) * 1e6) / 1e6;
}

/**
 * @param {Uint8Array|ArrayBuffer} input - JPEG file bytes (head is enough)
 * @returns {object|null} EXIF summary or null
 */
export function parseExif(input) {
  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 20) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0) !== 0xffd8) return null; // not a JPEG

    // Walk JPEG segments to APP1/Exif.
    let pos = 2;
    let exifStart = -1;
    let exifLen = 0;
    while (pos + 4 < bytes.length) {
      if (view.getUint8(pos) !== 0xff) break;
      const marker = view.getUint8(pos + 1);
      if (marker === 0xda || marker === 0xd9) break; // SOS / EOI
      const len = view.getUint16(pos + 2);
      if (len < 2) break;
      if (marker === 0xe1 && len > 10) {
        const head = readAscii(view, pos + 4, 6);
        if (head.startsWith('Exif')) {
          exifStart = pos + 10;
          exifLen = len - 8;
          break;
        }
      }
      pos += 2 + len;
    }
    if (exifStart < 0) return null;

    const tiffStart = exifStart;
    const endian = view.getUint16(tiffStart);
    const little = endian === 0x4949; // "II"
    if (!little && endian !== 0x4d4d) return null;
    const getU32 = (o) => little ? view.getUint32(o, true) : view.getUint32(o, false);
    const magic = little ? view.getUint16(tiffStart + 2, true) : view.getUint16(tiffStart + 2, false);
    if (magic !== 42) return null;
    const ifd0Offset = getU32(tiffStart + 4);
    const ifd0 = parseIfd(view, tiffStart, little, ifd0Offset, {
      0x010f: 'make',
      0x0110: 'model',
      0x0132: 'dateTime',
      0x0112: 'orientation',
      0x8769: '_exifIfd',
      0x8825: '_gpsIfd',
    });
    const result = { ...ifd0.values };
    delete result._exifIfd;
    delete result._gpsIfd;

    if (typeof ifd0.values._exifIfd === 'number') {
      const ex = parseIfd(view, tiffStart, little, ifd0.values._exifIfd, {
        0xa002: 'pixelWidth',
        0xa003: 'pixelHeight',
        0x9003: 'dateTaken',
      });
      Object.assign(result, ex.values);
    }
    if (typeof ifd0.values._gpsIfd === 'number') {
      const g = parseIfd(view, tiffStart, little, ifd0.values._gpsIfd, {
        0x0001: 'latRef',
        0x0002: 'lat',
        0x0003: 'lngRef',
        0x0004: 'lng',
      });
      const lat = gpsToDecimal(g.values.latRef, g.values.lat);
      const lng = gpsToDecimal(g.values.lngRef, g.values.lng);
      if (lat != null && lng != null) result.gps = { lat, lng };
    }
    if (Object.keys(result).length === 0) return null;
    return result;
  } catch {
    return null;
  }
}

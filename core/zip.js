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
 * ImgFetch — core/zip.js
 * Minimal pure-JS ZIP writer (stored entries, no compression). No DOM,
 * no chrome.* — safe to unit test in Node.
 *
 * Used for "Download as ZIP": many images packed into one .zip download.
 * Filenames are sanitized (no directories, no traversal) and flagged UTF-8.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Strip directories / traversal; keep a safe basename. */
export function safeZipName(name) {
  const base = String(name || 'file')
    .split('/')
    .pop()
    .split('\\')
    .pop()
    .replace(/^\.+/, '')
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .slice(0, 120)
    .trim();
  return base || 'file';
}

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

/**
 * DOS date/time for ZIP headers — real modified time, not 1980 (B6).
 */
function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const time =
    ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const dateBits =
    (((d.getFullYear() - 1980) & 127) << 9) |
    (((d.getMonth() + 1) & 15) << 5) |
    (d.getDate() & 31);
  return { time, date: dateBits };
}

/**
 * @param {Array<{name: string, data: Uint8Array}>} files
 * @param {Date} [now] override for tests
 * @returns {{parts: Uint8Array[], size: number, count: number}}
 * Header/data parts in final order.
 *
 * B6: returns the zip as separate parts instead of one concatenated buffer,
 * so the caller can do `new Blob(parts)` directly — no giant intermediate
 * copy (the old path peaked near 900 MB on large archives: file data +
 * zip buffer + Blob copy).
 */
export function createZipParts(files, now) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('bad-input');
  if (files.length > 500) throw new Error('too-many-files');
  const seen = new Set();
  const prepared = files.map((file) => {
    const data = file.data instanceof Uint8Array ? file.data : Uint8Array.from(file.data || []);
    let name = safeZipName(file.name);
    if (seen.has(name)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let i = 2;
      while (seen.has(`${stem}-${i}${ext}`)) i += 1;
      name = `${stem}-${i}${ext}`;
    }
    seen.add(name);
    return { name, nameBytes: utf8Bytes(name), data, crc: crc32(data) };
  });

  const { time: modTime, date: modDate } = dosDateTime(now);
  const parts = [];
  let size = 22; // end of central directory
  let offset = 0;
  const centralOffsets = [];
  const centralParts = [];

  const localHead = (f) => {
    const head = new Uint8Array(30);
    const v = new DataView(head.buffer);
    v.setUint32(0, 0x04034b50, true); // signature
    v.setUint16(4, 20, true); // version needed
    v.setUint16(6, 0x0800, true); // flags: UTF-8 filename
    v.setUint16(8, 0, true); // method: stored
    v.setUint16(10, modTime, true); // B6: real modified time
    v.setUint16(12, modDate, true); // B6: real modified date
    v.setUint32(14, f.crc >>> 0, true);
    v.setUint32(18, f.data.length >>> 0, true);
    v.setUint32(22, f.data.length >>> 0, true);
    v.setUint16(26, f.nameBytes.length, true);
    v.setUint16(28, 0, true); // extra length
    return head;
  };

  for (const f of prepared) {
    const head = localHead(f);
    centralOffsets.push(offset);
    parts.push(head, f.nameBytes, f.data);
    offset += head.length + f.nameBytes.length + f.data.length;
    size += 30 + f.nameBytes.length + f.data.length; // local header
    size += 46 + f.nameBytes.length; // central entry
  }

  const centralStart = offset;
  prepared.forEach((f, i) => {
    const head = new Uint8Array(46);
    const v = new DataView(head.buffer);
    v.setUint32(0, 0x02014b50, true); // central signature
    v.setUint16(4, 20, true); // version made by
    v.setUint16(6, 20, true); // version needed
    v.setUint16(8, 0x0800, true); // flags: UTF-8
    v.setUint16(10, 0, true); // method: stored
    v.setUint16(12, modTime, true); // B6: real modified time
    v.setUint16(14, modDate, true); // B6: real modified date
    v.setUint32(16, f.crc >>> 0, true);
    v.setUint32(20, f.data.length >>> 0, true);
    v.setUint32(24, f.data.length >>> 0, true);
    v.setUint16(28, f.nameBytes.length, true);
    v.setUint16(30, 0, true); // extra length
    v.setUint16(32, 0, true); // comment length
    v.setUint16(34, 0, true); // disk number
    v.setUint16(36, 0, true); // internal attrs
    v.setUint32(38, 0, true); // external attrs
    v.setUint32(42, centralOffsets[i] >>> 0, true);
    centralParts.push(head, f.nameBytes);
  });
  const centralSize = centralParts.reduce((n, part) => n + part.length, 0);

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // central dir disk
  ev.setUint16(8, prepared.length, true);
  ev.setUint16(10, prepared.length, true);
  ev.setUint32(12, centralSize >>> 0, true);
  ev.setUint32(16, centralStart >>> 0, true);
  ev.setUint16(20, 0, true); // comment length

  return { parts: [...parts, ...centralParts, end], size, count: prepared.length };
}

/**
 * @param {Array<{name: string, data: Uint8Array}>} files
 * @returns {Uint8Array} the .zip file bytes
 *
 * H3: builds from createZipParts into one preallocated buffer (kept for
 * callers that need the bytes, e.g. tests). Production ZIP downloads use
 * `new Blob(parts)` directly to avoid the extra copy.
 */
export function createZip(files, now) {
  const { parts, size } = createZipParts(files, now);
  const out = new Uint8Array(size);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  if (o !== size) throw new Error('zip-size-mismatch');
  return out;
}

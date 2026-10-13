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
 * ImgFetch — core/filenames.js
 * Filename safety: every user-visible filename is built through here.
 * Pure functions, no chrome.* dependencies (unit-testable in Node).
 */

export const SAFE_IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'svg',
]);

// Extensions that must never be produced by ImgFetch.
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'js', 'jse',
  'wsf', 'wsh', 'jar', 'html', 'htm', 'svgz',
]);

const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const MAX_SEGMENT = 96;
const MAX_FILENAME = 180;

/** Sanitize one path segment (file base name or folder name). */
// Case-insensitive: CON PRN AUX NUL COM1-COM9 LPT1-LPT9 (with or without extension).
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeSegment(raw) {
  let s = String(raw ?? '');
  // Decode percent-escapes defensively; never let them smuggle separators.
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep as-is */
  }
  s = s
    .replace(ILLEGAL_CHARS, '')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  // Collapse repeated dots/dashes left by removals.
  s = s.replace(/\.{2,}/g, '.').replace(/-{2,}/g, '-');
  if (!s) return '';
  if (s.length > MAX_SEGMENT) s = s.slice(0, MAX_SEGMENT).trim();
  // L1: Windows reserved device names (CON, NUL, COM1…) are illegal as file
  // names even with an extension — prefix with an underscore.
  const stem = s.split('.')[0];
  if (WIN_RESERVED.test(stem)) s = `_${s}`;
  return s;
}


/** Map a requested extension to a safe image extension. */
export function safeExtension(requested, fallback = 'png') {
  let ext = String(requested || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (ext === 'jpeg') ext = 'jpg';
  if (BLOCKED_EXTENSIONS.has(ext)) return fallback;
  if (SAFE_IMAGE_EXTENSIONS.has(ext)) return ext;
  return fallback;
}

/**
 * Build a safe filename from a template and context.
 * ctx: {site, name, date:Date|string, time, width, height, num, ext}
 */
export function buildFilename(template, ctx = {}) {
  const mode = template === 'site' || template === 'original' || template === 'custom'
    ? template
    : 'original';
  const now = ctx.date instanceof Date ? ctx.date : new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

  const site = sanitizeSegment(ctx.site || 'download') || 'download';
  const rawName = sanitizeSegment(ctx.name || 'image') || 'image';
  // Strip any extension the page supplied; we attach our own safe one.
  const name = rawName.replace(/\.[a-z0-9]{2,5}$/i, '');
  const num = ctx.num != null ? String(ctx.num).padStart(3, '0') : '001';
  const dims = ctx.width && ctx.height ? `${ctx.width}x${ctx.height}` : '';

  let base;
  if (mode === 'original') {
    base = name || 'image';
  } else if (mode === 'site') {
    base = `${site} - ${date} - ${num}`;
  } else {
    base = String(ctx.custom || '{site} - {date} - {num}')
      .replaceAll('{site}', site)
      .replaceAll('{name}', name || 'image')
      .replaceAll('{date}', date)
      .replaceAll('{time}', time)
      .replaceAll('{width}', String(ctx.width || ''))
      .replaceAll('{height}', String(ctx.height || ''))
      .replaceAll('{dimensions}', dims)
      .replaceAll('{num}', num);
    base = sanitizeSegment(base) || 'image';
  }

  const ext = safeExtension(ctx.ext, 'png');
  let filename = `${base}.${ext}`;
  if (filename.length > MAX_FILENAME) {
    filename = `${base.slice(0, MAX_FILENAME - ext.length - 1)}.${ext}`;
  }
  return filename;
}

/**
 * Join an optional subfolder with a filename for chrome.downloads.
 * Returns just the filename when no folder is configured. Never allows
 * traversal outside the Downloads folder.
 * `extraExts` lets callers keep a non-image extension (e.g. 'zip') that
 * safeExtension would otherwise map back to the image fallback.
 */
export function joinDownloadPath(folder, filename, extraExts = []) {
  const file = sanitizeSegment(filename).replace(/\.[a-z0-9]{2,5}$/i, '');
  const ext = (String(filename).match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'png';
  const extra = new Set(extraExts.map((e) => String(e).toLowerCase().replace(/[^a-z0-9]/g, '')));
  const normExt = String(ext).toLowerCase();
  const safeExt = extra.has(normExt) ? normExt : safeExtension(ext);
  const safeFile = `${file || 'image'}.${safeExt}`;
  const folderParts = String(folder || '')
    .split(/[\\/]/)
    .map((p) => sanitizeSegment(p))
    .filter((p) => p && p !== '.' && p !== '..');
  const safeFolder = folderParts.slice(0, 3).join('/');
  return safeFolder ? `${safeFolder}/${safeFile}` : safeFile;
}

/** Validate an imported settings JSON string; returns parsed object or throws. */
export function parseSettingsImport(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('not-an-object');
  }
  return data;
}

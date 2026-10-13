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
 * ImgFetch — core/filters.js
 * Search / filter / sort for scanned images. Pure functions.
 *
 * Image: { id, src, width, height, format, alt, filename, pageTitle,
 *          pageHost, foundAt, isBackground }
 */

/**
 * Size filter chips use minimum-threshold semantics (H1):
 * 'medium' means "400px and up", not "exactly the medium bucket".
 * Images with unknown size (0x0) always pass — never hide what we
 * can't measure; the scan-time minSizePreset already dropped the
 * ones the user asked to skip.
 */
export const SIZE_FILTERS = {
  any: { label: 'Any size', min: 0, max: Infinity },
  small: { label: 'Under 400px', min: 0, max: 399 },
  medium: { label: '400px and up', min: 400, max: Infinity },
  large: { label: '1200px and up', min: 1200, max: Infinity },
};

/** Map a scan-time minSizePreset to the matching results size chip. */
export function sizeChipForPreset(preset) {
  if (preset === 'large' || preset === 'xlarge') return 'large';
  if (preset === 'medium') return 'medium';
  return 'any';
}

export function longestSide(img) {
  return Math.max(Number(img.width) || 0, Number(img.height) || 0);
}

/** Size bucket for the Size filter chips. */
export function sizeBucket(img) {
  const l = longestSide(img);
  if (l <= 0) return 'unknown';
  if (l < 400) return 'small';
  if (l < 1200) return 'medium';
  return 'large';
}

export function orientationOf(img) {
  const w = Number(img.width) || 0;
  const h = Number(img.height) || 0;
  if (!w || !h) return 'unknown';
  const ratio = w / h;
  if (ratio > 1.15) return 'landscape';
  if (ratio < 0.87) return 'portrait';
  return 'square';
}

export function formatGroup(format) {
  const f = String(format || '').toLowerCase();
  if (['jpg', 'jpeg'].includes(f)) return 'jpg';
  if (['png', 'webp', 'gif', 'avif'].includes(f)) return f;
  return f ? 'other' : 'unknown';
}

/**
 * filters: { size:'any'|'small'|'medium'|'large', formats:Set|string[],
 *            orientations:Set|string[], minLongest:number }
 */
export function applyFilters(images, filters = {}) {
  const formats = new Set(filters.formats || []);
  const orientations = new Set(filters.orientations || []);
  const minLongest = Number(filters.minLongest) || 0;
  const sizeRule = SIZE_FILTERS[filters.size] || SIZE_FILTERS.any;
  return (images || []).filter((img) => {
    if (longestSide(img) < minLongest) return false;
    const l = longestSide(img);
    if (l > 0 && (l < sizeRule.min || l > sizeRule.max)) return false;
    if (formats.size && !formats.has(formatGroup(img.format))) return false;
    if (orientations.size && !orientations.has(orientationOf(img))) return false;
    return true;
  });
}

export function matchesQuery(img, query, pageCtx) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  // M5: records are slim — page title/host come from the scan payload.
  const ctx = pageCtx || {};
  const hay = [img.filename, img.alt, img.src, img.pageTitle, img.pageHost, ctx.title, ctx.pageHost]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((token) => hay.includes(token));
}

export function sortImages(images, mode = 'order') {
  const list = [...(images || [])];
  switch (mode) {
    case 'largest':
      return list.sort((a, b) => longestSide(b) - longestSide(a));
    case 'smallest':
      return list.sort((a, b) => longestSide(a) - longestSide(b));
    case 'newest':
      return list.sort((a, b) => (b.foundAt || 0) - (a.foundAt || 0));
    case 'order':
    default:
      return list.sort((a, b) => (a.order || 0) - (b.order || 0));
  }
}


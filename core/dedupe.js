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
 * ImgFetch — core/dedupe.js
 * Remove duplicate images from scan results. Pure, no DOM, no chrome.*.
 *
 * Two passes:
 *  1. Exact duplicates — same normalized URL → keep first.
 *  2. Same image, several sizes — URLs that match after stripping size/crop
 *     query params (w, h, width, height, resize, fit, crop, q, quality, …)
 *     are grouped; only the largest (by pixel area) is kept.
 */

/** Query params that only change size/crop/quality — safe to ignore. */
const SIZE_PARAMS = new Set([
  'w', 'h', 'width', 'height', 'resize', 'fit', 'crop', 'q', 'quality',
  'auto', 'fm', 's', 'size', 'maxw', 'maxh', 'dpr',
]);

function normalizeKey(raw) {
  try {
    const u = new URL(String(raw));
    for (const p of [...u.searchParams.keys()]) {
      if (SIZE_PARAMS.has(p.toLowerCase())) u.searchParams.delete(p);
    }
    u.hash = '';
    // Sort remaining params so param order doesn't split groups.
    u.searchParams.sort();
    return u.origin + u.pathname + u.search;
  } catch {
    return String(raw).split('#')[0];
  }
}

/**
 * @param {Array<{url: string, width?: number, height?: number}>} images
 * @returns {{images: Array, removed: number}}
 */
export function dedupeImages(images) {
  if (!Array.isArray(images)) return { images: [], removed: 0 };
  const seenExact = new Set();
  const unique = [];
  for (const img of images) {
    const url = String((img && img.url) || '');
    if (!url) continue;
    if (seenExact.has(url)) continue;
    seenExact.add(url);
    unique.push(img);
  }

  // Group by size-stripped URL; keep the largest of each group.
  const groups = new Map();
  for (const img of unique) {
    const key = normalizeKey(img.url);
    const list = groups.get(key) || [];
    list.push(img);
    groups.set(key, list);
  }
  const out = [];
  let removed = images.length - unique.length;
  for (const list of groups.values()) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }
    // Keep the largest by area (unknown dimensions count as 0).
    let best = list[0];
    let bestArea = (best.width || 0) * (best.height || 0);
    for (let i = 1; i < list.length; i += 1) {
      const area = (list[i].width || 0) * (list[i].height || 0);
      if (area > bestArea) {
        best = list[i];
        bestArea = area;
      }
    }
    out.push(best);
    removed += list.length - 1;
  }
  return { images: out, removed };
}

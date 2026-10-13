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
 * ImgFetch — core/image-url.js
 * Pick the best copyable image URL from a right-clicked <img> descriptor.
 *
 * Priority (per spec):
 *   1. currentSrc — what the browser actually rendered (srcset/<picture> aware)
 *   2. the src attribute
 *   3. <picture>/<source> srcset — best (largest) candidate
 *   4. lazy-load data-* attributes (only when applicable: the rendered
 *      source is a data: URI or a 1px/placeholder image)
 *
 * Never invents URLs: candidates come only from the element's own
 * attributes. data: URIs are never returned (a truncated data: URL on the
 * clipboard is worse than an honest failure). Pure logic — no chrome.*,
 * no DOM — so this module is unit-testable in Node.
 */

import { parseSrcset } from './urls.js';

const LAZY_ATTRS = [
  'data-src',
  'data-original',
  'data-lazy-src',
  'data-srcset',
  'data-original-src',
  'data-full-src',
  'data-hi-res-src',
  'data-large-src',
];

// blank.gif, pixel.png, spacer.gif, 1x1.jpg … the usual placeholder files.
const PLACEHOLDER_FILE = /(^|\/)(blank|pixel|spacer|transparent|1x1|clear|dot)(\.(gif|png|jpe?g|webp|svg))?([?#]|$)/i;

function clean(v) {
  return String(v || '').trim();
}

function usable(v) {
  const s = clean(v);
  return !!s && !/^data:/i.test(s);
}

/** True when the rendered source is obviously a placeholder, not the photo. */
function looksPlaceholder(desc, url) {
  const s = clean(url);
  if (!s) return false;
  if (PLACEHOLDER_FILE.test(s)) return true;
  const w = Number(desc.naturalWidth) || 0;
  const h = Number(desc.naturalHeight) || 0;
  return w > 0 && h > 0 && w <= 2 && h <= 2;
}

function firstLazy(desc) {
  const lazy = (desc && desc.lazy) || {};
  for (const a of LAZY_ATTRS) {
    if (usable(lazy[a])) return clean(lazy[a]);
  }
  return null;
}

/**
 * @param {object} desc — { currentSrc, srcAttr, sourceSrcsets[], lazy{},
 *                         naturalWidth, naturalHeight } as collected from the
 *                         right-clicked <img> in the page.
 * @returns {string|null} the raw best URL (still relative-safe; the caller
 *                        normalizes it against the page URL), or null.
 */
export function pickBestImageUrl(desc) {
  if (!desc || typeof desc !== 'object') return null;
  const lazy = firstLazy(desc);

  const cur = clean(desc.currentSrc);
  if (usable(cur)) {
    if (lazy && looksPlaceholder(desc, cur)) return lazy;
    return cur;
  }

  const src = clean(desc.srcAttr);
  if (usable(src)) {
    if (lazy && looksPlaceholder(desc, src)) return lazy;
    return src;
  }

  // <picture>/<source> srcsets — take the largest candidate.
  const sets = Array.isArray(desc.sourceSrcsets) ? desc.sourceSrcsets : [];
  let best = null;
  let bestScore = -1;
  for (const raw of sets) {
    for (const c of parseSrcset(raw)) {
      if (!usable(c.url)) continue;
      const score = c.kind === 'w' ? c.value : c.kind === 'x' ? c.value * 1000 : 1;
      if (score > bestScore) {
        bestScore = score;
        best = clean(c.url);
      }
    }
  }
  if (best) return best;

  return lazy;
}

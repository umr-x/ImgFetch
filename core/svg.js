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
 * ImgFetch — core/svg.js
 * Allowlist SVG sanitizer (B4, ROUND 2). A saved .svg opened in a browser
 * can run embedded scripts — the old denylist (strip <script>, on*,
 * javascript:) had working bypasses (tab/newline inside the scheme,
 * <set>/<animate> retargeting href, <foreignObject>, @import …).
 *
 * This module keeps only known-safe elements and attributes, normalizes
 * URL values before checking their scheme (browsers ignore tab/LF/CR
 * inside URLs), and neutralizes dangerous CSS. Pure policy over a parsed
 * document — unit-testable with a stub DOM, used by offscreen.js with the
 * real DOMParser. No dependencies.
 */

/** Elements that can never carry script: kept (attributes still filtered). */
const ALLOWED_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'desc', 'title', 'metadata',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath',
  'use', 'image', 'symbol', 'a', 'switch', 'view',
  'lineargradient', 'radialgradient', 'stop',
  'clippath', 'mask', 'pattern',
  'filter',
  'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite',
  'feconvolvematrix', 'fediffuselighting', 'fedisplacementmap',
  'fedistantlight', 'fedropshadow', 'feflood', 'fefunca', 'fefuncb',
  'fefuncg', 'fefuncr', 'fegaussianblur', 'feimage', 'femerge',
  'femergenode', 'femorphology', 'feoffset', 'fepointlight',
  'fespecularlighting', 'fespotlight', 'fetile', 'feturbulence',
  'style',
  // SMIL animation: kept only when NOT retargeting href (checked below).
  'animate', 'animatemotion', 'animatetransform', 'set', 'mpath',
]);

/** Animation elements get an extra href-retarget check. */
const ANIMATION_ELEMENTS = new Set(['animate', 'animatemotion', 'animatetransform', 'set']);

/** Attributes holding URLs — value must pass isSafeSvgUrl(). */
const URL_ATTRS = new Set(['href', 'xlink:href', 'src']);

/**
 * Safe attributes (compared lowercased; XML keeps the original spelling).
 * Presentation, geometry, gradients, filters, text, animation timing —
 * nothing that can carry script or event handlers.
 */
const ALLOWED_ATTRS = new Set([
  'id', 'class', 'xmlns', 'xmlns:xlink', 'version', 'lang', 'tabindex',
  'transform', 'transform-origin',
  'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry',
  'x1', 'y1', 'x2', 'y2', 'dx', 'dy', 'offset', 'rotate',
  'd', 'points', 'pathlength',
  'viewbox', 'preserveaspectratio',
  'gradientunits', 'gradienttransform', 'spreadmethod',
  'patternunits', 'patterncontentunits', 'patterntransform',
  'maskunits', 'maskcontentunits', 'mask-type',
  'clippathunits', 'filterunits', 'primitiveunits',
  'marker-start', 'marker-mid', 'marker-end',
  'markerunits', 'markerwidth', 'markerheight', 'orient', 'refx', 'refy',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'opacity', 'color', 'color-interpolation', 'color-interpolation-filters',
  'color-rendering', 'shape-rendering', 'text-rendering', 'image-rendering',
  'font-family', 'font-size', 'font-size-adjust', 'font-stretch',
  'font-style', 'font-variant', 'font-weight',
  'text-anchor', 'text-decoration', 'letter-spacing', 'word-spacing',
  'writing-mode', 'direction', 'unicode-bidi',
  'dominant-baseline', 'alignment-baseline', 'baseline-shift',
  'clip-rule', 'clip-path', 'mask', 'filter',
  'display', 'visibility', 'overflow', 'isolation',
  'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity',
  'lighting-color',
  'stddeviation', 'basefrequency', 'numoctaves', 'surfacescale',
  'specularconstant', 'specularexponent', 'kernelmatrix', 'kernelunitlength',
  'limitingconeangle', 'pointsatx', 'pointsaty', 'pointsz',
  'azimuth', 'elevation', 'diffuseconstant', 'scale', 'seed', 'stitchtiles',
  'type', 'tablevalues', 'slope', 'intercept', 'amplitude', 'exponent',
  'mode', 'operator', 'in', 'in2', 'result',
  'method', 'spacing', 'startoffset', 'side', 'textlength', 'lengthadjust',
  'requiredfeatures', 'requiredextensions', 'systemlanguage',
  'attributename', 'attributetype', 'begin', 'dur', 'end',
  'min', 'max', 'restart', 'repeatcount', 'repeatdur',
  'calcmode', 'values', 'keytimes', 'keysplines',
  'from', 'to', 'by', 'additive', 'accumulate', 'keypoints', 'path',
  'origin', 'media',
]);

/**
 * Browsers strip ASCII whitespace/control chars inside URLs, so
 * "java\tscript:alert(1)" IS a working javascript: URL. Normalize first,
 * then check the scheme.
 */
function normalizeUrlValue(v) {
  return String(v == null ? '' : v).replace(/[^ -~]+/g, '').trim();
}

/**
 * True for URL values that cannot navigate to script or exfiltrate:
 * same-document fragments, http(s) images, and data: images. A
 * data:image/svg+xml payload that itself carries a script is rejected.
 */
export function isSafeSvgUrl(value) {
  const v = normalizeUrlValue(value);
  if (!v) return false;
  if (v[0] === '#') return true;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^data:image\//i.test(v)) {
    const comma = v.indexOf(',');
    const payload = comma === -1 ? '' : v.slice(comma + 1);
    let text = payload;
    try {
      text = decodeURIComponent(payload);
    } catch {
      /* keep the raw payload for the sniff */
    }
    if (/<script[\s>]/i.test(text) || /javascript:/i.test(text)) return false;
    return true;
  }
  return false;
}

/** Neutralize dangerous CSS: drop @import, allow url() only to #fragment or data:image. */
function sanitizeCssUrls(css) {
  return String(css).replace(/url\(\s*([^)]*?)\s*\)/gi, (m, inner) => {
    const v = normalizeUrlValue(String(inner).replace(/^['"]|['"]$/g, ''));
    if (/^#/.test(v) || /^data:image\//i.test(v)) return m; // keep as written
    return 'none';
  });
}

function sanitizeStyleText(css) {
  return sanitizeCssUrls(String(css).replace(/@import[^;]*;?/gi, ''));
}

function getAttr(el, name) {
  for (const a of el.attributes || []) {
    if (String(a.name || '').toLowerCase() === name) return a.value;
  }
  return null;
}

/** True when a SMIL animation element retargets href to something dangerous. */
function animationTargetsHref(el) {
  const attrName = String(getAttr(el, 'attributename') || '').toLowerCase();
  if (attrName === 'href' || attrName === 'xlink:href') return true;
  for (const a of ['to', 'from', 'by', 'values']) {
    if (/javascript:/i.test(normalizeUrlValue(getAttr(el, a) || ''))) return true;
  }
  return false;
}

function sanitizeElementAttributes(el, idOnly) {
  for (const attr of Array.from(el.attributes || [])) {
    const name = String(attr.name || '');
    const lower = name.toLowerCase();
    if (lower.startsWith('on')) {
      el.removeAttribute(name); // event handler
      continue;
    }
    if (URL_ATTRS.has(lower)) {
      if (!isSafeSvgUrl(attr.value)) el.removeAttribute(name);
      continue;
    }
    if (lower === 'style') {
      el.setAttribute(name, sanitizeStyleText(attr.value || ''));
      continue;
    }
    if (idOnly) {
      if (lower !== 'id' && lower !== 'media') el.removeAttribute(name);
      continue;
    }
    if (!ALLOWED_ATTRS.has(lower)) {
      el.removeAttribute(name);
      continue;
    }
    // url(...) can hide in any kept value: fill="url(#g)", filter="url(#f)" …
    if (/url\(/i.test(String(attr.value || ''))) {
      el.setAttribute(name, sanitizeCssUrls(attr.value));
    }
  }
}

/**
 * Apply the allowlist to a parsed SVG document (real DOM or stub).
 * Returns the number of elements removed.
 */
export function sanitizeSvgDocument(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return 0;
  let removed = 0;
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'style') {
      sanitizeElementAttributes(el, true);
      try {
        el.textContent = sanitizeStyleText(el.textContent || '');
      } catch {
        /* stub without textContent setter — attributes already cleaned */
      }
      continue;
    }
    // B4: script, foreignObject, iframe, embed, object and friends are
    // simply not on the allowlist — no denylist to bypass.
    if (!ALLOWED_ELEMENTS.has(tag)) {
      el.remove();
      removed += 1;
      continue;
    }
    if (ANIMATION_ELEMENTS.has(tag) && animationTargetsHref(el)) {
      el.remove();
      removed += 1;
      continue;
    }
    sanitizeElementAttributes(el, false);
  }
  return removed;
}

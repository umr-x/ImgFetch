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
 * ImgFetch — core/export.js
 * Pure helpers for the Smart Download export engine.
 * No chrome.* dependencies (unit-testable in Node).
 */

/** Formats ImgFetch can produce via the "Save as" pipeline. */
export const EXPORT_FORMATS = Object.freeze([
  'png', 'jpg', 'webp', 'avif', 'gif', 'svg', 'bmp',
]);

const LABELS = {
  png: 'PNG',
  jpg: 'JPEG',
  webp: 'WebP',
  avif: 'AVIF',
  gif: 'GIF',
  svg: 'SVG',
  bmp: 'BMP',
};

/** Normalize a user- or menu-supplied format id to a canonical export format. */
export function normalizeExportFormat(input) {
  const f = String(input || '').toLowerCase().replace(/[^a-z]/g, '');
  if (f === 'jpeg') return 'jpg';
  return EXPORT_FORMATS.includes(f) ? f : 'png';
}

/** Human label for an export format id. */
export function formatLabel(format) {
  return LABELS[normalizeExportFormat(format)] || 'PNG';
}

/**
 * Encoding quality for a format. Returns undefined for formats where the
 * quality parameter is meaningless (vector SVG, BMP, GIF, AVIF which is
 * always 100%). PNG uses the quality slider for color quantization
 * (100% = lossless).
 */
export function qualityForFormat(format, settings) {
  const f = normalizeExportFormat(format);
  const s = settings || {};
  const clamp = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0.1, n)) : fallback;
  };
  if (f === 'jpg') return clamp(s.jpgQuality, 1);
  if (f === 'png') return clamp(s.pngQuality, 1);
  if (f === 'webp') return clamp(s.webpQuality, 1);
  if (f === 'avif') return 1; // no slider — AVIF always encodes at 100%
  return undefined;
}


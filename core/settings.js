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
 * ImgFetch — core/settings.js
 * Settings schema, defaults and validation. Pure (no chrome.*).
 */

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  // General
  theme: 'system', // system | light | dark
  afterDownload: 'notify', // notify | silent
  autoCollapseQueue: true, // collapse the download progress pane when everything finishes
  // Downloads
  saveAsDialog: false,
  maxConcurrent: 3,
  autoRetryOnce: true,
  // Image Quality
  qualityPreference: 'smart', // smart | original
  jpgQuality: 1,
  pngQuality: 1,
  webpQuality: 1,
  screenshotFormat: 'png', // png | jpg
  screenshotQuality: 1,
  // File naming
  filenameMode: 'original', // original | site | custom
  customTemplate: '{site} - {date} - {num}',
  askFilename: false, // open the rename sheet before single downloads
  // Folders
  organizeBySite: false, // legacy alias of folderMode === 'site'
  folderMode: 'site', // flat | site | type | date
  subfolder: '',
  useSubfolder: false, // master switch for the default subfolder (off = organize mode only)
  // Scanning
  minSizePreset: 'any', // any | medium | large | xlarge
  includeBackgrounds: true,
  scanDepth: 'loaded', // loaded | scroll — scan what's loaded, or scroll the page first to reveal lazy images
  detectLazyScroll: true, // legacy alias of scanDepth === 'scroll'
  dedupeScan: true, // drop duplicate images from scan results
  // Screenshots
  annotateAfterCapture: true, // open the annotation editor after capturing
  // History & privacy
  historyEnabled: true,
  historyRetentionDays: 30,
  // Advanced
  sitePrefs: {}, // { host: 'smart' | 'best'(legacy) | 'normal' | 'disabled' }
});

const ENUMS = {
  theme: ['system', 'light', 'dark'],
  afterDownload: ['notify', 'silent'],
  qualityPreference: ['smart', 'original'],
  screenshotFormat: ['png', 'jpg'],
  filenameMode: ['original', 'site', 'custom'],
  folderMode: ['flat', 'site', 'type', 'date'],
  minSizePreset: ['any', 'medium', 'large', 'xlarge'],
  scanDepth: ['loaded', 'scroll'],
};

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Merge stored settings over defaults and validate every field. */
export function normalizeSettings(stored) {
  const s = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  // B3: defaultAction is removed (it had no UI and no generic download
  // button exists — every action names its mode explicitly). Drop it from
  // old installs instead of carrying a dead key forever.
  delete s.defaultAction;
  // AVIF quality slider removed (2026-10-12): AVIF always encodes at 100%.
  // Drop the dead key from old installs.
  delete s.avifQuality;
  for (const [key, values] of Object.entries(ENUMS)) {
    if (!values.includes(s[key])) s[key] = DEFAULT_SETTINGS[key];
  }
  s.jpgQuality = clampNumber(s.jpgQuality, 0.1, 1, DEFAULT_SETTINGS.jpgQuality);
  s.pngQuality = clampNumber(s.pngQuality, 0.1, 1, DEFAULT_SETTINGS.pngQuality);
  s.webpQuality = clampNumber(s.webpQuality, 0.1, 1, DEFAULT_SETTINGS.webpQuality);
  s.screenshotQuality = clampNumber(
    s.screenshotQuality, 0.1, 1, DEFAULT_SETTINGS.screenshotQuality,
  );
  // The quality default changed from 0.92 to 1 (100%). Stored values
  // that still equal the old default are moved to the new default; values
  // the user chose themselves are left alone.
  for (const k of ['jpgQuality', 'pngQuality', 'webpQuality', 'screenshotQuality']) {
    if (stored && stored[k] === 0.92) s[k] = 1;
  }
  s.maxConcurrent = Math.round(clampNumber(s.maxConcurrent, 1, 6, 3));
  s.historyRetentionDays = Math.round(
    clampNumber(s.historyRetentionDays, 1, 365, 30),
  );
  for (const k of ['saveAsDialog', 'autoRetryOnce', 'organizeBySite', 'includeBackgrounds', 'historyEnabled', 'detectLazyScroll', 'dedupeScan', 'askFilename', 'annotateAfterCapture', 'useSubfolder']) {
    s[k] = s[k] === true;
  }
  // Legacy alias: organizeBySite true => folderMode 'site'.
  if (s.organizeBySite && s.folderMode === 'flat') s.folderMode = 'site';
  // Legacy alias: detectLazyScroll false => scanDepth 'loaded'.
  if (s.detectLazyScroll === false && !((stored || {}).scanDepth)) s.scanDepth = 'loaded';
  s.subfolder = String(s.subfolder || '').slice(0, 120);
  s.customTemplate = String(s.customTemplate || DEFAULT_SETTINGS.customTemplate).slice(0, 160);
  // Validate site preferences: {host: mode}
  const prefs = {};
  if (s.sitePrefs && typeof s.sitePrefs === 'object') {
    for (const [host, mode] of Object.entries(s.sitePrefs)) {
      const h = String(host).toLowerCase().slice(0, 253);
      if (/^[a-z0-9.-]+$/.test(h) && ['smart', 'best', 'normal', 'disabled'].includes(mode)) {
        prefs[h] = mode;
      }
    }
  }
  s.sitePrefs = prefs;
  s.version = SETTINGS_VERSION;
  return s;
}

/** Resolve the effective quality mode for a host (site pref wins). */
export function qualityModeForHost(settings, host) {
  const h = String(host || '').toLowerCase();
  const legacy = (v) => (v === 'best' ? 'smart' : v); // legacy installs stored 'best'
  if (h && settings.sitePrefs[h]) {
    const pref = settings.sitePrefs[h];
    if (pref === 'disabled') return 'disabled';
    return legacy(pref); // 'smart' | 'normal'
  }
  // B3: defaultAction is gone — with no site pref and no explicit request,
  // qualityPreference alone decides between smart and original.
  if (settings.qualityPreference === 'original') return 'original';
  return 'smart';
}

/**
 * B3: qualityPreference is a real setting. 'smart' (default) probes every
 * candidate source for the best genuine version; 'original' skips probing
 * and saves the exact source URL — fewer requests, faster, more private.
 * Returns false for non-smart modes (nothing to probe).
 */
export function shouldProbeBestSources(settings, mode) {
  if (String(mode) !== 'smart') return false;
  return !settings || settings.qualityPreference !== 'original';
}

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
 * ImgFetch, background/service-worker.js
 * The extension's engine: context menus, message routing, download queue,
 * screenshots, history and the offscreen conversion pipeline.
 *
 * Thin by design: all pure logic lives in ../core/*.js so it can be unit
 * tested in Node. This file only touches chrome.* APIs.
 */
import { idb } from './idb.js';
import {
  normalizeUrl,
  getExtensionFromUrl,
  getHostLabel,
  filenameHintFromUrl,
  normalizeHost,
  isPrivateNetworkFetchBlocked,
  lensUrlBlocked,
} from '../core/urls.js';
import {
  buildFilename,
  joinDownloadPath,
  safeExtension,
  sanitizeSegment,
} from '../core/filenames.js';
import {
  normalizeExportFormat,
  qualityForFormat,
  formatLabel,
} from '../core/export.js';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  qualityModeForHost,
  shouldProbeBestSources,
} from '../core/settings.js';
import { DownloadQueue } from '../core/queue.js';
import { planFullPageCapture } from '../core/fullpage-capture.js';
import {
  isValidMessage,
  senderKind,
  SENDER_RULES,
  friendlyError,
} from '../core/validation.js';
import { addRecord, pruneRecords, MAX_RECORDS } from '../core/history.js';
import { dedupeImages } from '../core/dedupe.js';
import { pickBestImageUrl } from '../core/image-url.js';
import { coerceScanState } from '../core/scan-state.js';
import { bulkItemPayload, singleItemPayload, pickUpgrade } from '../core/bulk-payload.js';
import { resolveFolder } from '../core/folders.js';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const SETTINGS_KEY = 'imgfetch.settings';
const HISTORY_KEY = 'imgfetch.history';
const LAST_SCAN_KEY = 'imgfetch.lastScan';
const COUNTER_KEY = 'imgfetch.fileCounter';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
/* Pending screenshots (memory first, session storage as backup)        */
/* ------------------------------------------------------------------ */

let settingsCache = null;
let creatingOffscreen = null;
let offscreenLastUsed = 0;
let offscreenInflight = 0; // H4: jobs currently running in the offscreen document
const CAPS_SESSION_KEY = 'imgfetch.caps'; // legacy session backup key (removed on write)
const pendingCompletions = new Map(); // chrome downloadId -> { resolve, reject }
let queueDrainTimer = null;

const queue = new DownloadQueue({
  concurrency: 3,
  maxAttempts: 2,
  starter: (item) => performDownload(item),
  onUpdate: (snapshot) => {
    broadcastQueueUpdate(snapshot); // M11: throttled
    scheduleQueuePersist(); // H5
  },
});

/**
 * M11: throttle queue broadcasts. A 500-item bulk fires an update per item
 * state change, thousands of messages. Send at most one per 200 ms, with
 * a trailing send so the final state always lands.
 */
let queueBroadcastTimer = null;
let queueBroadcastPending = null;
function broadcastQueueUpdate(snapshot) {
  queueBroadcastPending = snapshot;
  if (queueBroadcastTimer) return;
  broadcast({ type: 'QUEUE_UPDATE', snapshot });
  queueBroadcastPending = null;
  queueBroadcastTimer = setTimeout(() => {
    queueBroadcastTimer = null;
    const snap = queueBroadcastPending;
    queueBroadcastPending = null;
    if (snap) broadcast({ type: 'QUEUE_UPDATE', snapshot: snap });
  }, 200);
}

/**
 * H5: persist unfinished queue items to session storage (throttled) so a
 * service-worker restart mid-bulk doesn't lose the user's work.
 * N4: flush() persists immediately when a chromeDownloadId is assigned.
 */
import { createQueuePersister, QUEUE_SESSION_KEY } from '../core/queue-persist.js';

const queuePersister = createQueuePersister({
  getState: () => queue.serialize(),
  storage: chrome.storage.session,
});
function scheduleQueuePersist() {
  queuePersister.schedule();
}
// N4: immediate persist, called by trackDownload() the moment a
// chromeDownloadId is assigned, so a restart can adopt the download.
function persistQueueNow() {
  queuePersister.flush();
}

/**
 * H5: rebuild queue state after a worker restart. Items that never
 * started (or died before reaching chrome.downloads) are re-queued;
 * downloads still running in the browser are adopted, tracked to
 * completion instead of being duplicated or lost.
 */
async function restoreQueueState() {
  let saved = null;
  try {
    saved = (await chrome.storage.session.get(QUEUE_SESSION_KEY))[QUEUE_SESSION_KEY];
  } catch {
    return;
  }
  if (!Array.isArray(saved) || !saved.length) return;
  let downloads = [];
  try {
    downloads = (await chrome.downloads.search({})) || [];
  } catch {
    downloads = [];
  }
  const byId = new Map(downloads.map((d) => [d.id, d]));
  const triaged = [];
  const adopted = [];
  for (const s of saved) {
    if (!s || !s.id) continue;
    if (s.state === 'failed') {
      triaged.push({ ...s, state: 'failed' });
      continue;
    }
    if (s.state !== 'active' && s.state !== 'pending') continue; // done/cancelled stay gone
    const dl = s.chromeDownloadId != null ? byId.get(s.chromeDownloadId) : null;
    if (dl && dl.state === 'complete') continue; // finished while we were gone
    if (dl && dl.state === 'in_progress') {
      adopted.push(s);
      triaged.push({ ...s, state: 'pending' });
      continue;
    }
    if (dl) {
      triaged.push({ ...s, state: 'failed', error: 'The download was interrupted.' });
      continue;
    }
    triaged.push({ ...s, state: 'pending' });
  }
  if (!triaged.length) return;
  // B1: adopted ids go straight into restore() as ACTIVE, the starter is
  // never called for them, so a restart can't duplicate a running download.
  queue.restore(
    triaged,
    adopted.map((s) => s.id),
  );
  for (const s of adopted) {
    // Re-attach to the still-running browser download (source of truth).
    pendingCompletions.set(s.chromeDownloadId, {
      resolve: async () => {
        const done = queue.settleAdopted(s.id, true);
        // Best-effort: history is a log, not the download itself, a failed
        // write must not break adoption of the running download.
        if (done && done.history) {
          done.history.bytes = await downloadFileSize(s.chromeDownloadId);
          recordHistory(done.history).catch(() => {});
        }
      },
      reject: (err) => {
        queue.settleAdopted(s.id, false, err && err.message);
      },
    });
  }
  const resumed = triaged.filter((t) => t.state === 'pending').length;
  const failed = triaged.filter((t) => t.state === 'failed').length;
  if (resumed > 0 || failed > 0) {
    broadcast({
      type: 'NOTICE_TEXT',
      text: `ImgFetch restarted, resumed ${resumed} queued download${resumed === 1 ? '' : 's'}${failed > 0 ? `, ${failed} failed` : ''}.`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Download launcher                                                  */
/* ------------------------------------------------------------------ */

/**
 * The one shared way to start a browser download: caller-built filename,
 * the user's save-as preference, always uniquify on conflict.
 * Returns the download id, or null when the download could not be started.
 * M10: extracted from 4 duplicated call sites.
 */
async function saveToDownloads({ url, path, saveAs }) {
  return chrome.downloads.download({
    url,
    filename: path,
    saveAs: !!saveAs,
    conflictAction: 'uniquify',
  }).catch(() => null);
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settingsCache = normalizeSettings(stored[SETTINGS_KEY]);
  return settingsCache;
}

async function saveSettings(next) {
  settingsCache = normalizeSettings(next);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) {
    settingsCache = normalizeSettings(changes[SETTINGS_KEY].newValue);
    queue.concurrency = settingsCache.maxConcurrent;
  }
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    /* no listener, popup/options not open */
  });
}

/**
 * Google Lens direct search (2026-10-13).
 * lens.google.com/uploadbyurl?url= takes the image URL and redirects
 * straight into the Lens results page: one click, Google Lens searches the
 * image directly, no dialog, no pasting.
 *
 * Safety guard: lensUrlBlocked (core/urls.js) rejects page-local data:/blob:
 * URLs and private-network URLs before anything is sent to Google.
 */
async function openLensWithUrl(imageUrl) {
  // Direct upload-by-URL: one click, Google Lens searches the image directly.
  const url = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
  const tab = await chrome.tabs.create({ url });
  if (!tab || !Number.isInteger(tab.id)) throw new Error('lens-tab-failed');
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function isScannableTab(tab) {
  return !!tab && typeof tab.id === 'number' && /^https?:\/\//.test(tab.url || '');
}

/**
 * Tab to capture: the active tab when it's a normal web page, otherwise the
 * most recently used web tab (e.g. when captures are triggered from the
 * Settings page, which is focused at that moment).
 */
async function captureTargetTab() {
  const tab = await activeTab();
  if (isScannableTab(tab)) {
    assertSiteAllowed(await getSettings(), tab.url); // H8: paused sites block capture
    return tab;
  }
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true }).catch(() => []);
  const fallback = (tabs || [])
    .filter(isScannableTab)
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  if (fallback) assertSiteAllowed(await getSettings(), fallback.url); // H8
  return fallback || null;
}

async function nextFileNumber() {
  const stored = await chrome.storage.local.get(COUNTER_KEY);
  const n = (Number(stored[COUNTER_KEY]) || 0) + 1;
  await chrome.storage.local.set({ [COUNTER_KEY]: n });
  return n;
}

/** Peek the next number without consuming it (for rename suggestions). */
async function peekFileNumber() {
  const stored = await chrome.storage.local.get(COUNTER_KEY);
  return (Number(stored[COUNTER_KEY]) || 0) + 1;
}

/** Pick the download filename: user-typed name wins, else the naming mode. */
async function pickFilename(item, settings, parts) {
  const custom = item && item.payload && sanitizeCustomName(item.payload.customName, parts.ext);
  if (custom) return custom;
  return buildFilename(settings.filenameMode, {
    site: parts.site,
    name: parts.name,
    ext: parts.ext,
    date: new Date(),
    num: await nextFileNumber(),
    width: parts.width,
    height: parts.height,
    custom: settings.customTemplate,
  });
}

/** Sanitize a user-typed filename; enforce the target extension. */
function sanitizeCustomName(raw, ext) {
  let name = String(raw || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  if (!name) return '';
  const wantExt = String(ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const dot = name.lastIndexOf('.');
  const curExt = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  if (wantExt && curExt !== wantExt) {
    name = (dot > 0 ? name.slice(0, dot) : name) + '.' + wantExt;
  }
  return name || '';
}

/** Run a function inside the page's content-script world. */
async function runInPage(tabId, func, args = []) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/scanner.js'],
  });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func,
    args,
  });
  return result && result.result;
}

/**
 * blob: URLs only exist inside the page that created them, the offscreen
 * document and chrome.downloads cannot touch them. Fetch one in-page and
 * return a data URL everyone downstream can consume. With {thumb:true},
 * returns a small JPEG preview instead (for popup thumbnails).
 * Returns null when the blob cannot be resolved.
 */
async function resolveBlobUrl(tabId, blobUrl, opts = {}) {
  if (!blobUrl || !blobUrl.startsWith('blob:')) return blobUrl;
  if (!Number.isInteger(tabId)) return null;
  const thumb = !!opts.thumb;
  try {
    const dataUrl = await runInPage(
      tabId,
      (url, wantThumb) =>
        fetch(url)
          .then((res) => {
            if (!res.ok) throw new Error('fetch-failed');
            return res.blob();
          })
          .then(
            (blob) =>
              new Promise((resolve, reject) => {
                if (!blob || !String(blob.type || '').startsWith('image/')) {
                  reject(new Error('not-image'));
                  return;
                }
                if (blob.size > 25_000_000) {
                  reject(new Error('too-large'));
                  return;
                }
                if (!wantThumb) {
                  const fr = new FileReader();
                  fr.onload = () => resolve(String(fr.result || ''));
                  fr.onerror = () => reject(new Error('read-failed'));
                  fr.readAsDataURL(blob);
                  return;
                }
                // Thumbnail path: decode and downscale to keep the
                // popup light, a 320px JPEG preview is plenty.
                const objUrl = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => {
                  try {
                    const scale = Math.min(1, 320 / Math.max(img.width || 1, img.height || 1));
                    const w = Math.max(1, Math.round((img.width || 320) * scale));
                    const h = Math.max(1, Math.round((img.height || 320) * scale));
                    const c = document.createElement('canvas');
                    c.width = w;
                    c.height = h;
                    c.getContext('2d').drawImage(img, 0, 0, w, h);
                    resolve(c.toDataURL('image/jpeg', 0.72));
                  } catch (e) {
                    reject(e);
                  } finally {
                    URL.revokeObjectURL(objUrl);
                  }
                };
                img.onerror = () => {
                  URL.revokeObjectURL(objUrl);
                  reject(new Error('decode-failed'));
                };
                img.src = objUrl;
              }),
          ),
      [blobUrl, thumb],
    );
    return typeof dataUrl === 'string' && dataUrl.startsWith('data:') ? dataUrl : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Offscreen document (conversion, crop, clipboard)                     */
/* ------------------------------------------------------------------ */

async function ensureOffscreen() {
  // B6: one shared promise around the WHOLE ensure step (check, optional
  // close, create). Without this, two conversions starting together after
  // 30 s idle could both close and both create, the second create fails
  // with "only a single offscreen document".
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    const exists = await chrome.offscreen.hasDocument?.().catch(() => false);
    if (exists) {
      // Don't let an idle offscreen document sit in memory: reap it after
      // 30 s of disuse, but never while a job is still running (H4).
      if (offscreenInflight === 0 && Date.now() - offscreenLastUsed > 30_000) {
        try {
          await chrome.offscreen.closeDocument();
        } catch {
          /* already gone */
        }
      } else {
        return;
      }
    }
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['BLOBS', 'CLIPBOARD'],
      justification:
        'Convert downloaded images between formats, crop screenshots, and copy image links.',
    });
  })().finally(() => {
    creatingOffscreen = null;
  });
  return creatingOffscreen;
}

async function offscreenCall(message) {
  await ensureOffscreen();
  offscreenLastUsed = Date.now();
  offscreenInflight += 1;
  try {
    const payload = { ...message, target: 'offscreen' };
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await chrome.runtime.sendMessage(payload);
      } catch (err) {
        lastErr = err;
        // createDocument resolves before the offscreen page's scripts have
        // registered their listener, retry instead of failing the job.
        if (/receiving end does not exist/i.test(String((err && err.message) || '')) && attempt < 3) {
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } finally {
    offscreenInflight -= 1;
    offscreenLastUsed = Date.now();
  }
}

/* ------------------------------------------------------------------ */
/* Ranked-source cache: probing costs network round-trips, so repeat       */
/* downloads of the same image reuse the last ranking for 3 minutes.       */
/* ------------------------------------------------------------------ */
const rankedCache = new Map(); // srcUrl -> { at, ranked }

async function findRankedSourcesCached(srcUrl, pageUrl, tabId, candidates) {
  const hit = rankedCache.get(srcUrl);
  if (hit && Date.now() - hit.at < 180_000) return hit.ranked;
  const ranked = await findRankedSources(srcUrl, pageUrl, tabId, candidates);
  rankedCache.set(srcUrl, { at: Date.now(), ranked });
  if (rankedCache.size > 200) {
    const oldest = rankedCache.keys().next();
    if (!oldest.done) rankedCache.delete(oldest.value);
  }
  return ranked;
}

/**
 * M11: screenshot storage. Captures live in IndexedDB (primary), not worker
 * memory, a full-page capture can be tens of MB as a data URL. A tiny
 * in-memory LRU (2 entries) covers the hot path; IndexedDB survives worker
 * restarts and has a far larger quota than chrome.storage.session (~10 MB).
 */
const CAP_CACHE_SIZE = 2;
const capCache = new Map(); // id -> data (LRU, hot path only)

async function rememberCapture(id, data) {
  capCache.set(id, data);
  if (capCache.size > CAP_CACHE_SIZE) {
    const oldest = [...capCache.keys()][0];
    capCache.delete(oldest);
  }
  try {
    await idb.put('captures', { id, ...data });
    // Prune stale captures (older than 1h, keep at most 5).
    const all = await idb.all('captures');
    const cutoff = Date.now() - 3600e3;
    const stale = all.filter((c) => c.at < cutoff).slice(0, Math.max(0, all.length - 5));
    await Promise.all(stale.map((c) => idb.del('captures', c.id)));
  } catch {
    /* IndexedDB unavailable, the memory cache covers the normal case */
  }
  // Drop the legacy session-storage backup (superseded by IndexedDB).
  try {
    await chrome.storage.session.remove(CAPS_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

async function recallCapture(id) {
  const mem = capCache.get(id);
  if (mem) return mem;
  try {
    const rec = await idb.get('captures', id);
    if (rec) {
      const { id: _id, ...data } = rec;
      capCache.set(id, data);
      return data;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function forgetCapture(id) {
  capCache.delete(id);
  try {
    await idb.del('captures', id);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

/**
 * Perform one queued download. Resolves when the file is fully saved,
 * rejects with a friendly error code when it cannot be saved.
 */
async function performDownload(item) {
  if (item.payload && item.payload.kind === 'zip') {
    return performZipDownload(item);
  }
  if (item.payload && item.payload.mode === 'smart') {
    return performSmartDownload(item);
  }
  const { srcUrl, mode, format, pageUrl, pageTitle, kind } = item.payload;
  checkPublicFetch(srcUrl, pageUrl); // M7
  const settings = await getSettings();
  // Page blob: URLs must be resolved in-page to a data URL first —
  // nothing outside the page can fetch them.
  let src = srcUrl;
  if (typeof src === 'string' && src.startsWith('blob:')) {
    const resolved = await resolveBlobUrl(item.payload.tabId, src);
    if (!resolved) throw new Error(friendlyError('blocked'));
    src = resolved;
  }
  const url = normalizeUrl(src, pageUrl);
  if (!url) throw new Error(friendlyError('bad-url'));

  let finalUrl = url;
  let targetExt = getExtensionFromUrl(url) || 'png';
  let width = 0;
  let height = 0;
  let usedMode = mode;
  let didConvert = false; // L11: skip sniffing when we encoded it ourselves

  if (mode === 'normal' && settings.qualityPreference !== 'original') {
    // M4b: 'normal' bulk downloads also attempt a cheap upgrade from the
    // scan-time candidates already collected in-page, bounded probing,
    // no discovery round-trip. 'original' keeps its exact-URL contract,
    // and qualityPreference 'original' opts out of probing entirely.
    const upgraded = await tryScanCandidateUpgrade(
      url, pageUrl, item.payload.tabId, item.payload.candidates);
    if (upgraded) {
      finalUrl = upgraded.url;
      width = upgraded.width;
      height = upgraded.height;
    }
  } else if (mode === 'best' || mode === 'original') {
    const found = await findValidatedSource(url, pageUrl, mode, item.payload.tabId);
    if (found && found.url) {
      finalUrl = found.url;
      // The validated source may be a different URL (and format) than the
      // clicked one, track its extension; SNIFF_TYPE below confirms bytes.
      targetExt = getExtensionFromUrl(found.url) || targetExt;
      width = found.width || 0;
      height = found.height || 0;
    } else if (mode === 'original') {
      // Honest fallback: best available instead of a wrong "original".
      usedMode = 'best-fallback';
    }
  }

  if (format && format !== 'as-is') {
    const want = safeExtension(format);
    const have = safeExtension(targetExt);
    if (want !== have) {
      // Route through convertSource so every format uses its real encoder:
      // GIF/BMP/SVG have dedicated converters, while CONVERT_IMAGE only
      // handles png/jpg/webp/avif and rejects the rest (which used to
      // fall back to the source URL saved as PNG).
      try {
        const converted = await convertSource(finalUrl, want, settings, pageUrl);
        finalUrl = converted.dataUrl;
        targetExt = converted.ext;
        didConvert = true;
        width = converted.width || width;
        height = converted.height || height;
      } catch {
        // Conversion failed: fall back to the plain source URL instead of
        // failing the whole download; the user gets a notice.
        broadcast({ type: 'NOTICE', code: 'convert-failed' });
        finalUrl = url;
        targetExt = getExtensionFromUrl(url) || 'png';
      }
    }
  }

  finalUrl = await maybeSanitizeSvg(finalUrl, targetExt, pageUrl); // M3

  // L11: for direct downloads the URL's extension is a claim, not a fact.
  // Sniff the real type from the first bytes (cheap Range request); on any
  // failure keep the URL's extension (previous behavior).
  if (/^https?:\/\//i.test(finalUrl) && !didConvert) {
    try {
      const sniffed = await offscreenCall({ type: 'SNIFF_TYPE', srcUrl: finalUrl, pageUrl });
      if (sniffed && sniffed.ok && sniffed.ext) targetExt = sniffed.ext;
    } catch {
      /* keep URL-derived extension */
    }
  }

  const filename = await pickFilename(item, settings, {
    site: getHostLabel(pageUrl || url),
    name: filenameHintFromUrl(finalUrl.startsWith('data:') ? url : finalUrl),
    ext: targetExt,
    width: '',
    height: '',
  });
  const folder = resolveFolder(settings, pageUrl, url, targetExt);
  const path = joinDownloadPath(folder, filename);

  const downloadId = await saveToDownloads({ url: finalUrl, path, saveAs: settings.saveAsDialog });
  if (downloadId == null) throw new Error(friendlyError('download-failed'));

  // Wait for the download to actually finish so the queue reflects reality.
  await trackDownload(item, downloadId, {
    filename: path.split('/').pop(),
    site: sanitizeSegment(getHostLabel(pageUrl || url)),
    pageHost: pageUrl ? new URL(pageUrl).hostname : '',
    format: targetExt,
    width,
    height,
    kind: kind || 'single',
  });

  if (settings.afterDownload === 'notify') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-48.png'),
      title: 'ImgFetch',
      message: `Saved ${path.split('/').pop()}`,
      // Cosmetic: the download already succeeded; a denied notification
      // permission must not surface as an error.
    }).catch(() => {});
  }

  return { downloadId, filename: path, mode: usedMode };
}

/**
 * Ask the page to gather + validate candidates for a source URL.
 * Prefers the tab the download came from; falls back to the active tab.
 * Returns { url, width, height, confidence } or null.
 */
async function findValidatedSource(srcUrl, pageUrl, mode, tabId) {
  let tab = null;
  if (Number.isInteger(tabId)) {
    tab = await chrome.tabs.get(tabId).catch(() => null);
  }
  if (!isScannableTab(tab)) tab = await activeTab();
  if (!isScannableTab(tab)) return null;
  try {
    const pageResult = await runInPage(tab.id, (src, wantOriginal) => {
      const api = window.__imgfetch;
      if (!api || typeof api.findBestSource !== 'function') return null;
      return api.findBestSource(src, { original: wantOriginal });
    }, [srcUrl, mode === 'original']);
    if (!pageResult || !pageResult.url) return null;
    return pageResult;
  } catch {
    return null;
  }
}


/**
 * Ask the page for ALL validated sources for a URL, ranked best-first.
 * This is the Smart Download engine's raw material: only genuinely
 * loadable images, never URL-pattern guesses.
 * Returns [{ url, width, height }] (best first).
 */
async function findRankedSources(srcUrl, pageUrl, tabId, candidates) {
  let tab = null;
  if (Number.isInteger(tabId)) {
    tab = await chrome.tabs.get(tabId).catch(() => null);
  }
  if (!isScannableTab(tab)) tab = await activeTab();
  if (!isScannableTab(tab)) return [];
  try {
    // M4: scan-time candidates ride along, one in-page call, no
    // separate discovery round-trip per image.
    const res = await runInPage(tab.id, (src, cands) => {
      const api = window.__imgfetch;
      if (!api || typeof api.findRankedSources !== 'function') return [];
      return api.findRankedSources(src, cands);
    }, [srcUrl, Array.isArray(candidates) ? candidates : null]);
    return Array.isArray(res) ? res.filter((r) => r && r.url).slice(0, 8) : [];
  } catch {
    return [];
  }
}

/**
 * M4b: cheap best-quality attempt for 'normal' bulk downloads.
 * Uses only the scan-time candidates already collected in-page during the
 * scan, no second discovery round-trip. Probing is bounded (top 4 by
 * width hint; full probing is what the explicit best-quality path does),
 * and it never "upgrades" to a smaller source. Returns
 * { url, width, height } or null. Never throws.
 */
async function tryScanCandidateUpgrade(srcUrl, pageUrl, tabId, candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const trimmed = candidates
    .filter((c) => c && typeof c.u === 'string' && c.u)
    .sort((a, b) => (b.w || 0) - (a.w || 0))
    .slice(0, 4);
  if (!trimmed.length) return null;
  let ranked;
  try {
    ranked = await findRankedSourcesCached(srcUrl, pageUrl, tabId, trimmed);
  } catch {
    return null;
  }
  if (!ranked || !ranked.length) return null;
  return pickUpgrade(srcUrl, ranked);
}

/** Resolve when a chrome download actually finishes; reject on failure. */
function waitForDownloadComplete(downloadId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCompletions.delete(downloadId);
      reject(new Error(friendlyError('timeout')));
    }, 10 * 60 * 1000);
    pendingCompletions.set(downloadId, {
      resolve: () => {
        clearTimeout(timer);
        pendingCompletions.delete(downloadId);
        resolve();
      },
      reject: (err) => {
        clearTimeout(timer);
        pendingCompletions.delete(downloadId);
        reject(err);
      },
    });
  });
}

/**
 * Actual on-disk size of a finished download, for history records.
 * chrome.downloads.search reports fileSize once the download completes —
 * this is the exact size the user got, not an estimate.
 */
async function downloadFileSize(downloadId) {
  // fileSize may not be populated immediately after download completes;
  // retry a few times before giving up.
  for (let i = 0; i < 5; i++) {
    try {
      const [d] = await chrome.downloads.search({ id: downloadId });
      const n = d && Number(d.fileSize);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    } catch {
      return 0;
    }
    if (i < 4) await new Promise((r) => setTimeout(r, 200));
  }
  return 0;
}

/**
 * H5: tie a chrome.downloads id to its queue item and wait for it.
 * If the worker restarts mid-download, restoreQueueState() re-attaches
 * to the still-running browser download instead of losing the work,
 * and records the history entry the dead worker never got to write.
 */
function trackDownload(item, downloadId, historyEntry) {
  queue.updateItem(item.id, { chromeDownloadId: downloadId, history: historyEntry || null });
  persistQueueNow(); // N4: the id must be on disk before the worker can die
  return waitForDownloadComplete(downloadId)
    .then(async () => {
      if (historyEntry) {
        historyEntry.bytes = await downloadFileSize(downloadId);
        await recordHistory(historyEntry);
      }
    })
    .finally(() => {
      // B6: keep chromeDownloadId on finished items so the popup can offer
      // "Show in folder" (chrome.downloads.show). Done items are never
      // re-serialized for restart recovery, so the id can't go stale there.
      queue.updateItem(item.id, { history: null });
    });
}

/**
 * M3: network SVGs are sanitized before saving, a saved .svg opened in
 * a browser could run embedded scripts. Our generated SVG wrapper is a
 * data: URL and skips this. Failures fall through to the original file
 * rather than losing the download.
 */
async function maybeSanitizeSvg(finalUrl, targetExt, pageUrl) {
  if (targetExt !== 'svg' || String(finalUrl || '').startsWith('data:')) return finalUrl;
  const clean = await offscreenCall({ type: 'SANITIZE_SVG', srcUrl: finalUrl, pageUrl }).catch(() => null);
  return clean && clean.ok && clean.dataUrl ? clean.dataUrl : finalUrl;
}

/**
 * Convert one source to the requested format: decode once, encode once,
 * directly into the target format. Throws a friendly error on failure.
 * GIF is encoded by ImgFetch's own pure-JS encoder (core/gif.js); AVIF
 * requires browser support.
 */
async function convertSource(srcUrl, format, settings, pageUrl) {
  const want = normalizeExportFormat(format);
  if (want === 'gif') {
    const res = await offscreenCall({ type: 'CONVERT_GIF', srcUrl, pageUrl });
    if (!res || !res.ok || !res.dataUrl) throw new Error(friendlyError('convert-failed'));
    return { ...res, ext: 'gif' };
  }
  if (want === 'bmp') {
    const res = await offscreenCall({ type: 'CONVERT_BMP', srcUrl, pageUrl });
    if (!res || !res.ok || !res.dataUrl) throw new Error(friendlyError('convert-failed'));
    return { ...res, ext: 'bmp' };
  }
  if (want === 'svg') {
    const res = await offscreenCall({ type: 'CONVERT_SVG', srcUrl, pageUrl });
    if (!res || !res.ok || !res.dataUrl) throw new Error(friendlyError('convert-failed'));
    return { ...res, ext: 'svg' };
  }
  if (want === 'avif') {
    // The fast probe can misfire, so a "not supported" verdict is verified
    // with one real encode before giving up, the offscreen encoder
    // MIME-verifies its output, so a silent fallback can't slip through.
    if (!(await avifReallyAvailable(srcUrl, settings, pageUrl))) {
      throw new Error(friendlyError('avif-unavailable'));
    }
  }
  try {
    return await encodeImageFormat(srcUrl, want, settings, pageUrl);
  } catch (err) {
    if (String((err && err.message) || err).includes('encode-unsupported')) {
      throw new Error(friendlyError('avif-unavailable'));
    }
    throw err;
  }
}

/** Raw offscreen encode with output verification. Throws on any failure. */
async function encodeImageFormat(srcUrl, format, settings, pageUrl) {
  const want = normalizeExportFormat(format);
  let res;
  try {
    res = await offscreenCall({
      type: 'CONVERT_IMAGE',
      srcUrl,
      format: want,
      quality: qualityForFormat(want, settings),
      pageUrl,
    });
  } catch {
    res = null;
  }
  if (!res || !res.ok || !res.dataUrl) {
    const code = res && res.error ? String(res.error) : '';
    if (code.includes('encode-unsupported')) throw new Error('encode-unsupported');
    throw new Error(friendlyError('convert-failed'));
  }
  return { ...res, ext: want };
}

/**
 * Is AVIF really encodable? Fast probe first; on failure, one real encode
 * attempt (its output is MIME-verified) before concluding it isn't.
 */
async function avifReallyAvailable(srcUrl, settings, pageUrl) {
  if (await supportsAvif()) return true;
  try {
    await encodeImageFormat(srcUrl, 'avif', settings, pageUrl);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download one ranked candidate. When a target format is requested, the best
 * valid source is found first and only then converted, never the reverse.
 * Returns the download result or throws a friendly error.
 */
async function attemptSmartCandidate(item, candidate, wantFormat, settings, say) {
  const { pageUrl, kind } = item.payload;
  let finalUrl = candidate.url;
  let targetExt = getExtensionFromUrl(candidate.url) || 'png';
  let width = candidate.width || 0;
  let height = candidate.height || 0;

  if (wantFormat && wantFormat !== targetExt) {
    say(`Converting to ${formatLabel(wantFormat)}…`);
    const converted = await convertSource(candidate.url, wantFormat, settings, pageUrl);
    finalUrl = converted.dataUrl;
    targetExt = converted.ext;
    width = converted.width || width;
    height = converted.height || height;
    if (getExtensionFromUrl(candidate.url) === 'gif') {
      say('Note: animated images are saved as a still frame.');
    }
  }

  say('Downloading…');
  finalUrl = await maybeSanitizeSvg(finalUrl, targetExt, pageUrl); // M3
  // L11: direct (unconverted) smart downloads get the same sniff check.
  if (/^https?:\/\//i.test(finalUrl) && finalUrl === candidate.url) {
    try {
      const sniffed = await offscreenCall({ type: 'SNIFF_TYPE', srcUrl: finalUrl, pageUrl });
      if (sniffed && sniffed.ok && sniffed.ext) targetExt = sniffed.ext;
    } catch {
      /* keep URL-derived extension */
    }
  }
  const filename = await pickFilename(item, settings, {
    site: getHostLabel(pageUrl || candidate.url),
    name: filenameHintFromUrl(finalUrl.startsWith('data:') ? candidate.url : finalUrl),
    ext: targetExt,
    width: '',
    height: '',
  });
  const folder = resolveFolder(settings, pageUrl, candidate.url, targetExt);
  const path = joinDownloadPath(folder, filename);

  const downloadId = await saveToDownloads({ url: finalUrl, path, saveAs: settings.saveAsDialog });
  if (downloadId == null) throw new Error(friendlyError('download-failed'));
  await trackDownload(item, downloadId, {
    filename: path.split('/').pop(),
    site: sanitizeSegment(getHostLabel(pageUrl || candidate.url)),
    pageHost: pageUrl ? new URL(pageUrl).hostname : '',
    format: targetExt,
    width,
    height,
    kind: kind || 'single',
  });

  if (settings.afterDownload === 'notify') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-48.png'),
      title: 'ImgFetch',
      message: `Saved ${path.split('/').pop()}`,
      // Cosmetic: the download already succeeded; a denied notification
      // permission must not surface as an error.
    }).catch(() => {});
  } else if (kind !== 'bulk') {
    say('Downloaded successfully.');
  }

  return { downloadId, filename: path };
}

/* ------------------------------------------------------------------ */
/* ZIP download: pack many images into one .zip file.                   */
/* ------------------------------------------------------------------ */
async function performZipDownload(item) {
  const settings = await getSettings();
  const { files, pageUrl, tabId } = item.payload;
  const say = (text) => {
    queue.updateItem(item.id, { label: text });
    broadcast({ type: 'NOTICE_TEXT', text });
  };
  if (!Array.isArray(files) || !files.length) throw new Error(friendlyError('bad-url'));

  // H3: resolve page blob: URLs in-page first (nothing outside the page
  // can fetch them). Unresolvable ones count as skipped, not silent.
  const capped = files.slice(0, 200);
  const cappedNote = files.length > 200 ? ` (first 200 of ${files.length})` : '';
  let skipped = 0;
  const resolved = [];
  for (const f of capped) {
    const url = String((f && f.url) || '');
    if (url.startsWith('blob:')) {
      const dataUrl = Number.isInteger(tabId) ? await resolveBlobUrl(tabId, url, {}) : null;
      if (dataUrl && dataUrl.startsWith('data:')) {
        resolved.push({ url: dataUrl, name: String((f && f.name) || 'image') });
      } else {
        skipped += 1;
      }
    } else {
      try {
        checkPublicFetch(url, pageUrl); // M7
        resolved.push({ url, name: String((f && f.name) || 'image') });
      } catch {
        skipped += 1;
      }
    }
  }

  say(`Preparing ZIP (${resolved.length} images${cappedNote}, as shown)…`);
  // B6: blob: URLs were resolved to data URLs in-page, those can be huge,
  // so split the payload into small messages (no single runtime message
  // near the size limit). The offscreen side accumulates the chunks.
  const ZIP_MSG_BUDGET = 12_000_000;
  const chunks = [];
  let cur = [];
  let curBytes = 0;
  for (const f of resolved) {
    const est = f.url.startsWith('data:') ? f.url.length : 512;
    if (cur.length && curBytes + est > ZIP_MSG_BUDGET) {
      chunks.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(f);
    curBytes += est;
  }
  if (cur.length) chunks.push(cur);
  let res = null;
  // B6: one token per ZIP so concurrent bulk ZIPs accumulate independently.
  const zipToken = `zip-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  try {
    for (let i = 0; i < chunks.length; i += 1) {
      // N2: stop a cancelled build between chunks, the catch below sends
      // ZIP_ABORT so accumulated chunks are released, not finished in vain.
      if (queue.cancelled) throw new Error(friendlyError('cancelled'));
      res = await offscreenCall({
        type: 'BUILD_ZIP',
        files: chunks[i],
        pageUrl,
        zipToken,
        more: i < chunks.length - 1,
      });
      if (!res || !res.ok) throw new Error(friendlyError('convert-failed'));
    }
  } catch (err) {
    // N2: release the offscreen accumulator's chunks immediately, do not
    // leak them until the offscreen document closes. Best-effort: the
    // offscreen may be gone already.
    try {
      await offscreenCall({ type: 'ZIP_ABORT', zipToken });
    } catch { /* offscreen gone, nothing to release */ }
    throw err;
  }
  if (!res || !res.url) throw new Error(friendlyError('convert-failed'));
  skipped += Number(res.skipped) || 0;

  say('Downloading ZIP…');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const folder = resolveFolder(settings, pageUrl, '', 'zip');
  const path = joinDownloadPath(folder, `imgfetch-images-${stamp}.zip`, ['zip']);
  let downloadId;
  const zipHistory = {
    filename: path.split('/').pop(),
    site: sanitizeSegment(getHostLabel(pageUrl || '')),
    pageHost: pageUrl ? new URL(pageUrl).hostname : '',
    format: 'zip',
    width: 0,
    height: 0,
    kind: 'bulk',
    count: res.count,
  };
  try {
    downloadId = await saveToDownloads({ url: res.url, path, saveAs: settings.saveAsDialog });
    if (downloadId == null) throw new Error(friendlyError('download-failed'));
    await trackDownload(item, downloadId, zipHistory); // H3: don't report "done" early
  } finally {
    // Best-effort cleanup: the offscreen document may already be gone.
    await offscreenCall({ type: 'REVOKE_URL', url: res.url }).catch(() => {});
  }
  const doneMsg = skipped > 0
    ? `ZIP downloaded (${res.count} of ${capped.length} images, ${skipped} skipped).`
    : `ZIP downloaded (${res.count} images).`;
  say(doneMsg);
  return { downloadId };
}

/**
 * Smart Download: find every genuinely available source, rank them,
 * take the best valid one (converting only if a target format was asked
 * for), and walk down the list automatically when a source fails.
 * Never upscales; never claims quality it has not measured.
 */
async function performSmartDownload(item) {
  const settings = await getSettings();
  const { srcUrl, pageUrl, kind } = item.payload;
  checkPublicFetch(srcUrl, pageUrl); // M7
  const single = kind !== 'bulk';
  const say = (text) => {
    queue.updateItem(item.id, { label: text });
    if (single) broadcast({ type: 'NOTICE_TEXT', text });
  };

  let wantFormat = item.payload.format && item.payload.format !== 'as-is'
    ? normalizeExportFormat(item.payload.format)
    : null;

  // Page blob: URLs are resolved in-page first; the blob itself is the
  // source, so best-source probing is skipped for them.
  let smartSrc = srcUrl;
  let isBlobSource = false;
  if (typeof smartSrc === 'string' && smartSrc.startsWith('blob:')) {
    const resolved = await resolveBlobUrl(item.payload.tabId, smartSrc);
    if (!resolved) throw new Error(friendlyError('blocked'));
    smartSrc = resolved;
    isBlobSource = true;
  }

  const url = normalizeUrl(smartSrc, pageUrl);
  if (!url) throw new Error(friendlyError('bad-url'));

  say('Finding best quality…');
  // B3: qualityPreference 'original' skips best-source probing entirely —
  // the exact source URL is used (fewer requests, faster, more private).
  const ranked = isBlobSource || !shouldProbeBestSources(settings, 'smart')
    ? []
    : await findRankedSourcesCached(url, pageUrl, item.payload.tabId, item.payload.candidates);
  const attempts = ranked.length ? ranked : [{ url, width: 0, height: 0 }];
  if (!attempts.some((a) => a.url === url)) attempts.push({ url, width: 0, height: 0 });

  // When a specific format is requested, prefer the candidate that is already
  // in that format: it downloads directly with zero conversion, this keeps
  // animated GIFs animated instead of pointlessly re-encoding a sibling.
  if (wantFormat) {
    attempts.sort((a, b) => {
      const am = getExtensionFromUrl(a.url) === wantFormat ? 0 : 1;
      const bm = getExtensionFromUrl(b.url) === wantFormat ? 0 : 1;
      return am - bm;
    });
  }

  // GIF requests are genuinely encoded by ImgFetch (core/gif.js), so any
  // source can satisfy them, animated sources still download directly to
  // preserve their animation (see the sort above + attemptSmartCandidate).
  if (wantFormat === 'avif' && !(await avifReallyAvailable(url, settings, pageUrl))) {
    say(friendlyError('avif-unavailable'));
    wantFormat = 'png';
  }

  const tried = new Set();
  let lastError = null;
  for (const candidate of attempts.slice(0, 5)) {
    if (tried.has(candidate.url)) continue;
    tried.add(candidate.url);
    try {
      return await attemptSmartCandidate(item, candidate, wantFormat, settings, say);
    } catch (err) {
      lastError = err;
      say('ImgFetch could not use the highest-quality version. Trying another available source…');
    }
  }
  const final = lastError || new Error(friendlyError('download-failed'));
  if (single) broadcast({ type: 'NOTICE_TEXT', text: final.message });
  throw final;
}

async function recordHistory(entry) {
  const settings = await getSettings();
  if (!settings.historyEnabled) return;
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  let records = addRecord(stored[HISTORY_KEY] || [], { ...entry, at: Date.now() });
  records = pruneRecords(records, settings.historyRetentionDays);
  await chrome.storage.local.set({ [HISTORY_KEY]: records.slice(0, MAX_RECORDS) });
}

chrome.downloads.onChanged.addListener((delta) => {
  const pending = pendingCompletions.get(delta.id);
  if (!pending) return;
  if (delta.state && delta.state.current === 'complete') {
    pending.resolve();
  } else if (delta.state && delta.state.current === 'interrupted') {
    pending.reject(new Error(friendlyError('download-failed')));
  } else if (delta.error && delta.error.current) {
    pending.reject(new Error(friendlyError('download-failed')));
  }
});

/* ------------------------------------------------------------------ */
/* Page scanning                                                       */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Scan lifecycle: idle -> scanning -> results | error                   */
/* The state lives in session storage so the popup can pick up a scan    */
/* that was started by the global shortcut while it was closed.          */
/* ------------------------------------------------------------------ */

const SCAN_STATE_KEY = 'imgfetch.scanState';
const scanInflight = new Map(); // tabId -> Promise (debounce/lock)

async function setScanState(patch) {
  const cur = (await chrome.storage.session.get(SCAN_STATE_KEY))[SCAN_STATE_KEY] || { status: 'idle' };
  const next = { ...cur, ...patch };
  // Ephemeral UI state: if session storage is unavailable the scan still
    // ran, the popup just won't show its progress.
    await chrome.storage.session.set({ [SCAN_STATE_KEY]: next }).catch(() => {});
  return next;
}

async function getScanState() {
  const stored = (await chrome.storage.session.get(SCAN_STATE_KEY))[SCAN_STATE_KEY];
  return coerceScanState(stored);
}

/**
 * Start (or join) a scan for a tab. Rapid double-presses of the shortcut
 *, or the popup's Scan button racing the shortcut, share one inflight
 * scan instead of starting duplicates.
 */
function requestScan(tabId) {
  const id = Number(tabId);
  const existing = scanInflight.get(id);
  if (existing) return existing;
  // Mark SCANNING synchronously (the storage write is kicked off now) so a
  // popup opened in the next tick already sees the live state.
  const marked = setScanState({ status: 'scanning', tabId: id, at: Date.now(), error: '' });
  const p = (async () => {
    await marked;
    // Wake a popup that is already open on its dashboard: it switches to
    // the scanning pane on progress events (no new message type needed).
    broadcast({ type: 'SCAN_PROGRESS', done: 0, total: 1 });
    try {
      const scan = await scanPage(id);
      await setScanState({ status: 'results', tabId: id, at: Date.now(), error: '' });
      return scan;
    } catch (err) {
      const msg = String((err && err.message) || err).slice(0, 200);
      await setScanState({ status: 'error', tabId: id, at: Date.now(), error: msg });
      throw err;
    } finally {
      scanInflight.delete(id);
    }
  })();
  scanInflight.set(id, p);
  // Every caller attaches its own handlers; this guards the shared promise
  // itself against unhandled rejections between attach points.
  p.catch(() => {});
  return p;
}

async function scanPage(tabId) {
  const tab = tabId
    ? await chrome.tabs.get(tabId).catch(() => null)
    : await activeTab();
  if (!isScannableTab(tab)) throw new Error(friendlyError('no-tab'));

  const settings = await getSettings();
  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true }, // M5: images inside iframes
    files: ['content/scanner.js'],
  });
  // Optional: scroll through the page so lazy-loaded images reveal
  // themselves, then restore the user's scroll position before scanning.
  // scanDepth 'loaded' skips this for speed; 'scroll' (default) does it.
  const scrollScan = settings.scanDepth
    ? settings.scanDepth !== 'loaded'
    : settings.detectLazyScroll !== false;
  if (scrollScan) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => new Promise((resolve) => {
        try {
          const doc = document.documentElement;
          const vh = Math.max(window.innerHeight || 1, 1);
          const y0 = window.scrollY || 0;
          let i = 0;
          const tick = () => {
            try {
              // Re-read height each step: infinite-scroll pages grow.
              const total = Math.max(doc.scrollHeight || 0, 1);
              const steps = Math.min(16, Math.max(2, Math.ceil(total / vh)));
              if (i >= steps) {
                window.scrollTo(0, y0);
                // Let freshly revealed images decode before scanning.
                setTimeout(() => resolve(true), 600);
                return;
              }
              window.scrollTo(0, Math.round((total / steps) * i));
              i += 1;
              setTimeout(tick, 400);
            } catch {
              resolve(false);
            }
          };
          tick();
        } catch {
          resolve(false);
        }
      }),
    }).catch(() => null);
  }
  const scanResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true }, // M5: scan inside iframes too
    world: 'ISOLATED',
    func: (options) => window.__imgfetch.scanPage(options),
    args: [{
      includeBackgrounds: settings.includeBackgrounds,
      minLongest: { any: 0, medium: 400, large: 1200, xlarge: 2000 }[settings.minSizePreset] ?? 400,
    }],
  }).catch(() => []);
  // Merge per-frame results (frames that failed to inject return nothing).
  let images = [];
  let droppedBySize = 0;
  let droppedByRelevance = 0;
  let frameCount = 0;
  for (const r of scanResults || []) {
    const s = r && r.result;
    if (!s || !Array.isArray(s.images)) continue;
    frameCount += 1;
    images.push(...s.images);
    droppedBySize += Number(s.droppedBySize) || 0;
    droppedByRelevance += Number(s.droppedByRelevance) || 0;
  }
  if (!images.length && frameCount === 0) throw new Error(friendlyError('scan-failed'));
  // Hard cap so a pathological page can't blow up memory/storage.
  const MAX_SCAN_IMAGES = 3000;
  if (images.length > MAX_SCAN_IMAGES) images = images.slice(0, MAX_SCAN_IMAGES);

  // Duplicate removal: same image in several sizes → keep the largest only.
  let deduped = 0;
  if (settings.dedupeScan) {
    try {
      const r = dedupeImages(images.map((img) => ({
        url: img.src || img.url || '',
        width: img.width || 0,
        height: img.height || 0,
        ref: img,
      })));
      images = r.images.map((d) => d.ref);
      deduped = r.removed;
    } catch {
      /* dedupe is best-effort; keep the original list on failure */
    }
  }

  const payload = {
    tabId: tab.id,
    url: tab.url,
    title: tab.title || '',
    pageHost: (() => { try { return new URL(tab.url).hostname; } catch { return ''; } })(),
    at: Date.now(),
    images,
    deduped,
    droppedBySize,
    droppedByRelevance,
  };
  // Session storage is only a restore cache, the popup already received the
  // full scan via SCAN_DONE. If the payload is too large, store a trimmed
  // copy rather than failing the whole scan.
  try {
    await chrome.storage.session.set({ [LAST_SCAN_KEY]: payload });
  } catch {
    try {
      const trimmed = {
        ...payload,
        images: payload.images.filter((img) => {
          const src = img.src || '';
          return !src.startsWith('data:') || src.length <= 200_000;
        }),
      };
      await chrome.storage.session.set({ [LAST_SCAN_KEY]: trimmed });
    } catch {
      /* popup already has the data */
    }
  }
  broadcast({ type: 'SCAN_DONE', scan: payload });
  return payload;
}

/* ------------------------------------------------------------------ */
/* Screenshots                                                         */
/* ------------------------------------------------------------------ */

async function captureVisible() {
  const tab = await captureTargetTab();
  if (!tab || typeof tab.windowId !== 'number') throw new Error(friendlyError('no-tab'));
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch(() => null);
  if (!dataUrl) throw new Error(friendlyError('capture-failed'));
  return finishCapture(dataUrl, 0, 0);
}

/**
 * Shared tail for every screenshot: store it and open the preview/annotate
 * page. M10: extracted from captureVisible/Area/Element (3 identical tails).
 */
async function finishCapture(dataUrl, width, height) {
  const id = `cap-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await rememberCapture(id, { dataUrl, width, height, at: Date.now() });
  const st = await getSettings();
  const page = st.annotateAfterCapture ? 'pages/annotate.html' : 'pages/capture.html';
  await openResultTab(page, id);
  return { id };
}

/**
 * Single reused result tab for screenshots: each new capture replaces the
 * previous result tab instead of spawning one tab per screenshot.
 */
let resultTabId = 0;

async function openResultTab(page, id) {
  const url = chrome.runtime.getURL(`${page}#${id}`);
  if (resultTabId) {
    try {
      await chrome.tabs.get(resultTabId);
      await chrome.tabs.update(resultTabId, { url, active: true });
      // Hash-only updates don't reload the page, force it so the new
      // capture id is picked up.
      await chrome.tabs.reload(resultTabId);
      return;
    } catch {
      resultTabId = 0; // tab was closed, fall through and create
    }
  }
  const tab = await chrome.tabs.create({ url });
  resultTabId = tab.id;
}

/**
 * Capture a region chosen with the overlay picker (area or element).
 * M10: captureArea() and captureElement() merged, their bodies were
 * identical except for the picker function.
 */
async function captureRegion(pick) {
  const tab = await captureTargetTab();
  if (!isScannableTab(tab)) throw new Error(friendlyError('no-tab'));
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content/overlay.js'],
  });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'ISOLATED',
    func: pick,
  });
  const rect = result && result.result;
  if (!rect) return { cancelled: true };
  const full = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch(() => null);
  if (!full) throw new Error(friendlyError('capture-failed'));
  const cropped = await offscreenCall({ type: 'CROP_IMAGE', dataUrl: full, rect, format: 'png', quality: 0.92 });
  if (!cropped || !cropped.ok) throw new Error(friendlyError('capture-failed'));
  // L4: the element picker clamps to the viewport, say so when it cut the element.
  const res = await finishCapture(cropped.dataUrl, cropped.width, cropped.height);
  if (rect && rect.clipped) {
    broadcast({
      type: 'NOTICE_TEXT',
      text: 'That element is taller than the screen, only the visible part was captured. Use Full page for the whole thing.',
    });
  }
  return res;
}

async function captureArea() {
  return captureRegion(() => window.__imgfetch.selectArea());
}

/** Capture a single page element chosen with the picker. */
async function captureElement() {
  return captureRegion(() => window.__imgfetch.selectElement());
}

async function saveCapture(id) {
  const cap = await recallCapture(id);
  if (!cap) throw new Error(friendlyError('capture-failed'));
  const settings = await getSettings();
  let dataUrl = cap.dataUrl;
  // H7: the extension follows the actual bytes, only claim JPG after a
  // successful conversion, otherwise the file stays an honest PNG.
  let ext = 'png';
  if (settings.screenshotFormat === 'jpg') {
    const converted = await offscreenCall({
      type: 'CONVERT_IMAGE',
      srcUrl: dataUrl,
      format: 'jpg',
      quality: settings.screenshotQuality,
    });
    if (converted && converted.ok) {
      dataUrl = converted.dataUrl;
      ext = 'jpg';
    }
  }
  const filename = buildFilename(settings.filenameMode, {
    site: 'screenshot',
    name: 'imgfetch-screenshot',
    ext,
    date: new Date(),
    num: await nextFileNumber(),
    width: cap.width,
    height: cap.height,
    custom: settings.customTemplate,
  });
  const path = joinDownloadPath(settings.useSubfolder ? settings.subfolder : '', filename);
  const downloadId = await saveToDownloads({ url: dataUrl, path, saveAs: settings.saveAsDialog });
  if (downloadId == null) throw new Error(friendlyError('download-failed'));
  await forgetCapture(id);
  await recordHistory({
    filename: path.split('/').pop(),
    site: 'screenshot',
    pageHost: '',
    format: ext,
    width: cap.width,
    height: cap.height,
    bytes: await downloadFileSize(downloadId),
    kind: 'screenshot',
  });
  return { filename: path };
}

/**
 * Full-page screenshot: scroll through the page capturing each viewport,
 * then stitch the tiles into one image in the offscreen document.
 * Very long pages are capped so the browser never builds a giant canvas.
 */
/* H2/B6: full-page capture limits live in core/fullpage-capture.js (pure, tested).
 * Tiles are captured at CSS-viewport size; the OUTPUT is capped by area
 * (100 MP, max side 32767) and downscaled with a user notice instead of
 * failing or silently truncating. Pages needing more than 24 tiles capture
 * the first 24 from the top, with a notice. */
const TILE_GAP_MS = 650; // captureVisibleTab is rate-limited (~2/s)

/** One viewport tile with a single retry on rate-limit failure. */
async function captureTile(windowId) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }).catch(() => null);
    if (shot) return shot;
    await new Promise((res) => setTimeout(res, TILE_GAP_MS));
  }
  return null;
}

async function captureFullPage() {
  const tab = await captureTargetTab();
  if (!isScannableTab(tab)) throw new Error(friendlyError('no-tab'));
  const tabId = tab.id;
  const windowId = tab.windowId;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/scanner.js'] });
  const metrics = await runInPage(tabId, () => window.__imgfetch.getPageMetrics());
  if (!metrics || !metrics.viewportW || !metrics.viewportH) {
    throw new Error(friendlyError('capture-failed'));
  }
  const dpr = metrics.dpr || 1;
  const fullW = Math.max(1, Math.round(metrics.scrollWidth || metrics.viewportW));
  const fullH = Math.max(1, Math.round(metrics.scrollHeight || metrics.viewportH));
  // B6: pure capture plan (tested in test-core.mjs), tiles capped at 24
  // from the top, output capped by area instead of the old 8192px side cap.
  const plan = planFullPageCapture({
    fullW,
    fullH,
    viewportW: metrics.viewportW,
    viewportH: metrics.viewportH,
    dpr,
  });
  const { cols, rows, tileCount, tileCapped, capW, capH, scale, outW, outH } = plan;
  if (tileCapped) {
    broadcast({
      type: 'NOTICE_TEXT',
      text: `This page is very long, capturing the first ${tileCount} tiles (top portion). Use area capture for the rest.`,
    });
  }
  if (scale < 1) {
    broadcast({
      type: 'NOTICE_TEXT',
      text: `This page is very large, the full-page image was scaled to ${Math.round(scale * 100)}% to fit memory limits.`,
    });
  }

  const origX = metrics.scrollX || 0;
  const origY = metrics.scrollY || 0;
  const setFixedHidden = (hide) =>
    runInPage(tabId, (h) => window.__imgfetch.setFixedHidden(h), [hide]).catch(() => 0);
  // H2: abort if the user switches tab mid-capture, captureVisibleTab
  // would otherwise capture the wrong tab.
  const assertTabStillActive = async () => {
    const live = await chrome.tabs.get(tabId).catch(() => null);
    if (!live || live.windowId !== windowId) throw new Error(friendlyError('capture-failed'));
    const active = await activeTab().catch(() => null);
    if (!active || active.id !== tabId) throw new Error(friendlyError('capture-failed'));
  };

  const begin = await offscreenCall({ type: 'STITCH_BEGIN', width: outW, height: outH, scale });
  if (!begin || !begin.ok) throw new Error(friendlyError('capture-failed'));
  let n = 0;
  try {
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        await assertTabStillActive();
        const sx = Math.max(0, Math.min(c * metrics.viewportW, capW - metrics.viewportW));
        const sy = Math.max(0, Math.min(r * metrics.viewportH, capH - metrics.viewportH));
        await runInPage(tabId, (x, y) => window.scrollTo(x, y), [sx, sy]);
        // After the first tile, hide fixed headers/banners so they don't
        // repeat in every tile (restored in finally).
        if (n === 1) await setFixedHidden(true);
        await new Promise((res) => setTimeout(res, TILE_GAP_MS));
        const shot = await captureTile(windowId);
        if (!shot) throw new Error(friendlyError('capture-failed'));
        n += 1;
        if (tileCount > 1) {
          broadcast({ type: 'NOTICE_TEXT', text: `Capturing full page, tile ${n} of ${tileCount}…` });
        }
        // Tile positions are in output (downscaled device) pixels.
        const res = await offscreenCall({
          type: 'STITCH_TILE',
          dataUrl: shot,
          x: Math.round(sx * dpr * scale),
          y: Math.round(sy * dpr * scale),
        });
        if (!res || !res.ok) throw new Error(friendlyError('capture-failed'));
      }
    }
  } catch (err) {
    await offscreenCall({ type: 'STITCH_ABORT' }).catch(() => null);
    throw err;
  } finally {
    // Always restore scroll position and fixed elements, even on failure.
    // Best-effort: the tab may be closed already; the capture result stands.
    await runInPage(tabId, (x, y) => window.scrollTo(x, y), [origX, origY]).catch(() => {});
    await setFixedHidden(false);
  }

  const stitched = await offscreenCall({ type: 'STITCH_END', format: 'png' });
  if (!stitched || !stitched.ok || !stitched.dataUrl) {
    throw new Error(friendlyError('capture-failed'));
  }
  const id = `cap-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await rememberCapture(id, {
    dataUrl: stitched.dataUrl,
    width: stitched.width,
    height: stitched.height,
    at: Date.now(),
  });
  {
    const st = await getSettings();
    const page = st.annotateAfterCapture ? 'pages/annotate.html' : 'pages/capture.html';
    await openResultTab(page, id);
  }
  if (tileCount > 1 || scale < 1) {
    broadcast({ type: 'NOTICE_TEXT', text: `Full page captured (${stitched.width} × ${stitched.height}px).` });
  }
  return { id };
}

/**
 * Copy an image to the clipboard from inside the page itself. The page owns
 * blob: URLs and sends its own referrer/cookies, so this succeeds where the
 * offscreen copy fails (page blobs, hotlink-protected images). Returns true
 * when something image-like landed on the clipboard.
 */
/**
 * Copy Image Link support: read the right-clicked <img> straight from the
 * page so we can prefer its currentSrc (what the browser actually rendered
 * for srcset/<picture>), then its src attribute, <source> srcsets and the
 * page's own lazy-load attributes. Matches the element by the context
 * menu's srcUrl; returns null when the element can't be reached (restricted
 * page, shadow DOM, …) and the caller falls back to info.srcUrl.
 */
async function readImageDescriptor(tabId, srcUrl) {
  if (!Number.isInteger(tabId) || tabId < 0 || !srcUrl) return null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (wantedSrc) => {
        try {
          const norm = (u) => {
            try {
              return new URL(String(u), location.href).href;
            } catch {
              return '';
            }
          };
          const target = norm(wantedSrc);
          if (!target) return null;
          const imgs = Array.from(document.querySelectorAll('img'));
          const el =
            imgs.find((i) => norm(i.currentSrc) === target) ||
            imgs.find((i) => norm(i.getAttribute('src') || '') === target);
          if (!el) return null;
          const pic = el.closest('picture');
          const sourceSrcsets = [];
          if (pic) {
            for (const s of pic.querySelectorAll('source')) {
              const ss = s.getAttribute('srcset');
              if (ss) sourceSrcsets.push(ss);
            }
          }
          const lazy = {};
          for (const a of [
            'data-src',
            'data-original',
            'data-lazy-src',
            'data-srcset',
            'data-original-src',
            'data-full-src',
            'data-hi-res-src',
            'data-large-src',
          ]) {
            const v = el.getAttribute(a);
            if (v) lazy[a] = v;
          }
          return {
            currentSrc: el.currentSrc || '',
            srcAttr: el.getAttribute('src') || '',
            sourceSrcsets,
            lazy,
            naturalWidth: el.naturalWidth || 0,
            naturalHeight: el.naturalHeight || 0,
          };
        } catch {
          return null;
        }
      },
      args: [String(srcUrl)],
    });
    return (res && res.result) || null;
  } catch {
    return null;
  }
}

/**
 * Copy a URL as plain text inside the page (ISOLATED world). The context
 * menu click carries user activation, which is why this succeeds where the
 * offscreen document's clipboard write can fail ("Document is not focused").
 * Same pattern as copyImageInPage, which is why Copy Image already works.
 */
async function copyLinkTextInPage(tabId, text) {
  if (!Number.isInteger(tabId) || tabId < 0 || !text) return false;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (t) =>
        (async () => {
          try {
            await navigator.clipboard.writeText(t);
            return true;
          } catch {
            try {
              const ta = document.createElement('textarea');
              ta.value = t;
              ta.setAttribute('readonly', '');
              ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
              document.documentElement.appendChild(ta);
              ta.select();
              const ok = document.execCommand('copy');
              ta.remove();
              return !!ok;
            } catch {
              return false;
            }
          }
        })(),
      args: [String(text)],
    });
    return !!(res && res.result === true);
  } catch {
    return false;
  }
}

/**
 * Small non-blocking toast inside the page (auto-fades, never navigates,
 * never opens anything). Used for the Copy Image Link confirmations.
 */
async function showPageToast(tabId, text, isError) {
  if (!Number.isInteger(tabId) || tabId < 0 || !text) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (msg, err) => {
        try {
          const prev = document.querySelector('[data-imgfetch-toast]');
          if (prev) prev.remove();
          const el = document.createElement('div');
          el.setAttribute('data-imgfetch-toast', '1');
          el.textContent = msg;
          el.style.cssText =
            'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);' +
            'z-index:2147483647;background:' +
            (err ? '#b3261e' : '#171a2e') +
            ';color:#fff;font:13px/1.4 system-ui,sans-serif;padding:10px 16px;' +
            'border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.4);' +
            'pointer-events:none;opacity:0;transition:opacity .18s ease;';
          document.documentElement.appendChild(el);
          requestAnimationFrame(() => {
            el.style.opacity = '1';
          });
          setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 300);
          }, 2200);
        } catch {
          /* never break the page */
        }
      },
      args: [String(text), !!isError],
    });
  } catch {
    /* toast is best-effort */
  }
}

async function copyImageInPage(tabId, srcUrl) {
  if (!Number.isInteger(tabId) || tabId < 0 || !srcUrl) return false;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: (src) => (async () => {
      try {
        let blob = null;
        try {
          const res = await fetch(src, { credentials: 'include' });
          if (res.ok) {
            const b = await res.blob();
            if (b && String(b.type || '').startsWith('image/')) blob = b;
          }
        } catch {
          blob = null;
        }
        if (!blob) {
          // Canvas route: load via <img>, re-export as PNG. Needs a
          // CORS-clean image; a tainted canvas throws and we bail out.
          const img = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error('load-failed'));
            if (!src.startsWith('blob:') && !src.startsWith('data:')) {
              im.crossOrigin = 'anonymous';
            }
            im.src = src;
          });
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          if (!(w > 0 && h > 0) || w > 8000 || h > 8000 || w * h > 32_000_000) {
            return false;
          }
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d').drawImage(img, 0, 0);
          blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
        }
        if (!blob) return false;
        const type = String(blob.type || '').startsWith('image/') ? blob.type : 'image/png';
        await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
        return true;
      } catch {
        return false;
      }
    })(),
    args: [String(srcUrl)],
  }).catch(() => null);
  return !!(results && results[0] && results[0].result === true);
}

/* ------------------------------------------------------------------ */
/* Context menus                                                       */
/* ------------------------------------------------------------------ */

const MENU_IDS = {
  rootImage: 'imgfetch-image',
  smart: 'imgfetch-smart',
  saveAs: 'imgfetch-saveas',
  savePng: 'imgfetch-save-png',
  saveJpg: 'imgfetch-save-jpg',
  saveWebp: 'imgfetch-save-webp',
  saveAvif: 'imgfetch-save-avif',
  saveGif: 'imgfetch-save-gif',
  saveSvg: 'imgfetch-save-svg',
  saveBmp: 'imgfetch-save-bmp',
  sepImage1: 'imgfetch-sep-image-1',
  openOriginal: 'imgfetch-open-original',
  copyLink: 'imgfetch-copy-link',
  copyImage: 'imgfetch-copy-image',
  lensSearch: 'imgfetch-lens-search',
  imageInfo: 'imgfetch-info',
  sepImage2: 'imgfetch-sep-image-2',
  more: 'imgfetch-more',
  scanPage: 'imgfetch-scan-page',
  screenshot: 'imgfetch-screenshot',
  shotVisible: 'imgfetch-shot-visible',
  shotArea: 'imgfetch-shot-area',
  shotFull: 'imgfetch-shot-full',
  shotElement: 'imgfetch-shot-element',
  addSitePref: 'imgfetch-add-site',
  disableSite: 'imgfetch-disable-site',
  openSettings: 'imgfetch-open-settings',
  rootPage: 'imgfetch-page',
  pageScan: 'imgfetch-page-scan',
  pageShotVisible: 'imgfetch-page-shot-visible',
  pageShotArea: 'imgfetch-page-shot-area',
  pageShotFull: 'imgfetch-page-shot-full',
  pageShotElement: 'imgfetch-page-shot-element',
};

function hostOfPageUrl(pageUrl) {
  try {
    return normalizeHost(new URL(pageUrl).hostname);
  } catch {
    return '';
  }
}

/**
 * H8: single choke point for site preferences and global quality defaults.
 * Returns the effective download mode for a page.
 * Precedence: per-site preference > the action's requested mode >
 * qualityPreference (B3: defaultAction was removed, every action names its
 * mode explicitly, so there is no generic case left for it).
 * Throws when ImgFetch is paused on the site ('disabled').
 */
function sitePrefFor(settings, host) {
  const h = String(host || '').toLowerCase();
  const raw = h && settings.sitePrefs[h];
  if (!raw) return '';
  return raw === 'best' ? 'smart' : raw; // legacy installs stored 'best'
}

function resolveDownloadMode(settings, pageUrl, requested) {
  const host = hostOfPageUrl(pageUrl);
  const pref = sitePrefFor(settings, host);
  if (pref === 'disabled') throw new Error(friendlyError('disabled-site'));
  if (pref === 'smart' || pref === 'normal') return pref;
  const req = String(requested || '');
  if (req === 'smart' || req === 'normal' || req === 'original' || req === 'best') return req;
  const q = qualityModeForHost(settings, host); // 'smart' | 'original' here
  return q === 'disabled' ? 'smart' : q; // unreachable, safety net
}

/** Throw when ImgFetch is paused on the page's site (H8). */
function assertSiteAllowed(settings, pageUrl) {
  if (sitePrefFor(settings, hostOfPageUrl(pageUrl)) === 'disabled') {
    throw new Error(friendlyError('disabled-site'));
  }
}

/** Apply concurrency + retry settings to the queue before enqueuing (H8). */
function prepareQueue(settings) {
  queue.concurrency = settings.maxConcurrent;
  queue.maxAttempts = settings.autoRetryOnce ? 2 : 1;
}

/**
 * M7: block extension-privileged fetches (no CORS) to private networks —
 * loopback, link-local, RFC-1918, unless the page itself is on that host.
 * A malicious page could otherwise make the browser GET internal URLs.
 * Throws a friendly error; the queue surfaces it like any download failure.
 * B2: the rule lives in core/urls.js so offscreen.js and info.js apply
 * the identical check.
 */
function checkPublicFetch(url, pageUrl) {
  if (!isPrivateNetworkFetchBlocked(url, pageUrl)) return;
  throw new Error(friendlyError('private-network'));
}

let menuBuildChain = Promise.resolve();
async function buildMenus() {
  // F6: serialize overlapping calls so removeAll/create cannot interleave
  // and produce duplicate-id errors.
  const run = menuBuildChain.then(() => buildMenusInner());
  menuBuildChain = run.catch(() => {});
  return run;
}

async function buildMenusInner() {
  chrome.contextMenus.removeAll(() => {
    const img = ['image'];
    const page = ['page'];
    const M = MENU_IDS;

    // ---- Image menu: ImgFetch ----
    // D7: flat top level, Smart Download, Save as, Copy Link, Copy Image,
    // Image Info, More. Rarely used items live under More.
    chrome.contextMenus.create({ id: M.rootImage, title: 'ImgFetch', contexts: img });
    chrome.contextMenus.create({
      id: M.smart, parentId: M.rootImage, title: 'Smart Download', contexts: img,
    });
    chrome.contextMenus.create({
      id: M.saveAs, parentId: M.rootImage, title: 'Save as...', contexts: img,
    });
    for (const [id, label] of [
      [M.savePng, 'PNG'],
      [M.saveJpg, 'JPG'],
      [M.saveWebp, 'WebP'],
      [M.saveAvif, 'AVIF'],
      [M.saveGif, 'GIF'],
      [M.saveSvg, 'SVG (embedded image)'],
      [M.saveBmp, 'BMP'],
    ]) {
      chrome.contextMenus.create({ id, parentId: M.saveAs, title: label, contexts: img });
    }
    chrome.contextMenus.create({
      id: M.sepImage1, type: 'separator', parentId: M.rootImage, contexts: img,
    });
    chrome.contextMenus.create({
      id: M.copyLink, parentId: M.rootImage, title: 'Copy Image Link', contexts: img,
    });
    chrome.contextMenus.create({
      id: M.copyImage, parentId: M.rootImage, title: 'Copy Image', contexts: img,
    });
    chrome.contextMenus.create({
      id: M.imageInfo, parentId: M.rootImage, title: 'Image Info', contexts: img,
    });
    chrome.contextMenus.create({
      id: M.sepImage2, type: 'separator', parentId: M.rootImage, contexts: img,
    });
    chrome.contextMenus.create({
      id: M.more, parentId: M.rootImage, title: 'More...', contexts: img,
    });
    chrome.contextMenus.create({
      id: M.openOriginal, parentId: M.more, title: 'Open Original', contexts: img,
    });
    chrome.contextMenus.create({
      id: M.lensSearch, parentId: M.more, title: 'Search Image with Google Lens', contexts: img,
    });
    chrome.contextMenus.create({
      id: M.scanPage, parentId: M.more, title: 'Scan This Page', contexts: img,
    });
    chrome.contextMenus.create({
      id: M.screenshot, parentId: M.more, title: 'Screenshot', contexts: img,
    });
    for (const [id, label] of [
      [M.shotVisible, 'Capture Visible Area'],
      [M.shotArea, 'Select Area'],
      [M.shotElement, 'Capture Element'],
      [M.shotFull, 'Full Page'],
    ]) {
      chrome.contextMenus.create({ id, parentId: M.screenshot, title: label, contexts: img });
    }
    chrome.contextMenus.create({
      id: M.addSitePref, parentId: M.more, title: 'Add Site Preference', contexts: img,
    });
    chrome.contextMenus.create({
      id: M.disableSite, parentId: M.more, title: 'Disable on This Site', contexts: img,
    });
    chrome.contextMenus.create({
      id: M.openSettings, parentId: M.more, title: 'Settings', contexts: img,
    });

    // ---- Page menu ----
    chrome.contextMenus.create({ id: M.rootPage, title: 'ImgFetch', contexts: page });
    chrome.contextMenus.create({
      id: M.pageScan, parentId: M.rootPage, title: 'Scan This Page', contexts: page,
    });
    chrome.contextMenus.create({
      id: M.pageShotVisible, parentId: M.rootPage, title: 'Capture Visible Area', contexts: page,
    });
    chrome.contextMenus.create({
      id: M.pageShotArea, parentId: M.rootPage, title: 'Select Area', contexts: page,
    });
    chrome.contextMenus.create({
      id: M.pageShotFull, parentId: M.rootPage, title: 'Full Page', contexts: page,
    });
    chrome.contextMenus.create({
      id: M.pageShotElement, parentId: M.rootPage, title: 'Capture Element', contexts: page,
    });
  });
}

/** Surface capture errors even when the popup is already closed. */
function shotError(err) {
  const msg = String((err && err.message) || err).slice(0, 200);
  broadcast({ type: 'NOTICE', detail: msg });
  chrome.notifications
    .create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-48.png'), title: 'ImgFetch', message: msg })
    .catch(() => {});
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    await handleMenuClick(info, tab);
  } catch (err) {
    broadcast({ type: 'NOTICE', code: 'download-failed', detail: String(err && err.message || err).slice(0, 200) });
  }
});

async function handleMenuClick(info, tab) {
  const settings = await getSettings();
  const pageUrl = (tab && tab.url) || '';
  const host = hostOfPageUrl(pageUrl);
  const siteAllowed = [
    MENU_IDS.openSettings,
    MENU_IDS.addSitePref,
    MENU_IDS.disableSite,
  ];
  // H8: paused sites are honored here; the settings/site menus stay
  // available so the user can re-enable the site.
  try {
    assertSiteAllowed(settings, pageUrl);
  } catch {
    if (!siteAllowed.includes(info.menuItemId)) {
      broadcast({ type: 'NOTICE', code: 'disabled-site' });
      return;
    }
  }

  const enqueueOne = (srcUrl, mode, format) => {
    const effMode = resolveDownloadMode(settings, pageUrl, mode); // H8
    // "Ask for filename", open the rename sheet instead of downloading.
    if (settings.askFilename) {
      const q = new URLSearchParams({
        src: srcUrl || '',
        mode: effMode,
        format: format || 'as-is',
        pageUrl: pageUrl || '',
        tabId: tab && typeof tab.id === 'number' ? String(tab.id) : '',
      });
      chrome.tabs.create({ url: chrome.runtime.getURL(`pages/rename.html?${q.toString()}`) });
      return;
    }
    prepareQueue(settings);
    queue.enqueue([{
      id: `m-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      label: filenameHintFromUrl(srcUrl) || 'image',
      payload: {
        srcUrl, mode: effMode, format, pageUrl,
        pageTitle: (tab && tab.title) || '',
        tabId: tab && typeof tab.id === 'number' ? tab.id : null,
        kind: 'single',
      },
    }]);
    broadcast({ type: 'NOTICE', code: 'queued' });
    // Show the popup with the download progress (best-effort: needs a user
    // gesture and Chrome 127+; silently ignored otherwise).
    try { chrome.action.openPopup().catch(() => {}); } catch { /* old Chrome; ignore */ }
  };



  switch (info.menuItemId) {
    case MENU_IDS.smart:
      enqueueOne(info.srcUrl, 'smart', 'as-is');
      break;
    case MENU_IDS.savePng:
      enqueueOne(info.srcUrl, 'smart', 'png');
      break;
    case MENU_IDS.saveJpg:
      enqueueOne(info.srcUrl, 'smart', 'jpg');
      break;
    case MENU_IDS.saveWebp:
      enqueueOne(info.srcUrl, 'smart', 'webp');
      break;
    case MENU_IDS.saveAvif:
      enqueueOne(info.srcUrl, 'smart', 'avif');
      break;
    case MENU_IDS.saveGif:
      enqueueOne(info.srcUrl, 'smart', 'gif');
      break;
    case MENU_IDS.saveSvg:
      enqueueOne(info.srcUrl, 'smart', 'svg');
      break;
    case MENU_IDS.saveBmp:
      enqueueOne(info.srcUrl, 'smart', 'bmp');
      break;
    case MENU_IDS.openOriginal: {
      const ranked = await findRankedSourcesCached(info.srcUrl, pageUrl, tab && typeof tab.id === 'number' ? tab.id : null);
      const target = normalizeUrl((ranked[0] && ranked[0].url) || info.srcUrl, pageUrl);
      if (target) chrome.tabs.create({ url: target });
      break;
    }
    case MENU_IDS.imageInfo: {
      const src = encodeURIComponent(info.srcUrl || '');
      const tabParam = tab && typeof tab.id === 'number' ? `&tabId=${tab.id}` : '';
      const pageParam = pageUrl ? `&pageUrl=${encodeURIComponent(pageUrl)}` : '';
      chrome.tabs.create({ url: chrome.runtime.getURL(`pages/info.html?src=${src}${tabParam}${pageParam}`) });
      break;
    }
    case MENU_IDS.copyLink: {
      // Copy Image Link: the image URL as plain text ONLY. Never opens a
      // tab, never navigates the page, never copies image data. Kept
      // strictly separate from Copy Image (which copies the bitmap).
      const tabId = tab && typeof tab.id === 'number' ? tab.id : -1;
      // 1-2. Best URL from the actual element (currentSrc first), else the
      // menu's own srcUrl as the validated fallback.
      let raw = null;
      const desc = await readImageDescriptor(tabId, info.srcUrl);
      if (desc) raw = pickBestImageUrl(desc);
      const url = normalizeUrl(raw || '', pageUrl) || normalizeUrl(info.srcUrl, pageUrl);
      if (!url) {
        await showPageToast(tabId, "Couldn't copy image link.", true);
        broadcast({ type: 'NOTICE_TEXT', text: "Couldn't copy image link." });
        break;
      }
      // 3. Clipboard: in-page first (the menu click's user activation makes
      // this the reliable path), offscreen document as backup.
      let copied = await copyLinkTextInPage(tabId, url);
      if (!copied) {
        try {
          const res = await offscreenCall({ type: 'CLIPBOARD_WRITE', text: url });
          copied = !!(res && res.ok);
        } catch (err) {
          console.debug('[imgfetch] copy-link failed:', err);
          copied = false;
        }
      }
      if (copied) {
        await showPageToast(tabId, 'Image link copied.', false);
        broadcast({ type: 'NOTICE', code: 'copied' });
      } else {
        await showPageToast(tabId, "Couldn't copy image link.", true);
        broadcast({ type: 'NOTICE_TEXT', text: "Couldn't copy image link." });
      }
      break;
    }
    case MENU_IDS.copyImage: {
      const url = normalizeUrl(info.srcUrl, pageUrl);
      if (!url) {
        broadcast({ type: 'NOTICE', code: 'bad-url' });
        break;
      }
      try {
        checkPublicFetch(url, pageUrl); // M7
      } catch (err) {
        broadcast({ type: 'NOTICE_TEXT', text: err.message });
        break;
      }
      // Fallback chain: (1) offscreen copy, (2) in-page copy, the page
      // owns blob: URLs and sends its own referrer/cookies, fixing hotlink-
      // protected and page-blob images, (3) copy the link as text so the
      // clipboard never ends up empty.
      try {
        const res = await offscreenCall({ type: 'CLIPBOARD_IMAGE', srcUrl: url, pageUrl });
        if (!res || !res.ok) throw new Error('copy-failed');
        broadcast({ type: 'NOTICE', code: 'copied' });
      } catch {
        let done = false;
        try {
          done = await copyImageInPage(tab && tab.id, url);
        } catch {
          done = false;
        }
        if (done) {
          broadcast({ type: 'NOTICE', code: 'copied' });
          break;
        }
        try {
          const res = await offscreenCall({ type: 'CLIPBOARD_WRITE', text: url });
          if (res && res.ok) {
            broadcast({
              type: 'NOTICE_TEXT',
              text: 'The image itself could not be copied, so its link was copied instead.',
            });
          } else {
            broadcast({ type: 'NOTICE', code: 'copy-failed' });
          }
        } catch {
          broadcast({ type: 'NOTICE', code: 'copy-failed' });
        }
      }
      break;
    }
    case MENU_IDS.lensSearch: {
      const url = normalizeUrl(info.srcUrl, pageUrl);
      if (!url) {
        broadcast({ type: 'NOTICE', code: 'bad-url' });
        break;
      }
      // J1 safety guard: never send page-local or private-network URLs to Google.
      const blocked = lensUrlBlocked(url, pageUrl);
      if (blocked) {
        broadcast({ type: 'NOTICE', code: blocked });
        break;
      }
      // Direct Lens search: uploadbyurl redirects straight into results.
      openLensWithUrl(url).catch(() => {
        broadcast({ type: 'NOTICE', code: 'lens-failed' });
      });
      break;
    }
    case MENU_IDS.openSettings:
      chrome.runtime.openOptionsPage();
      break;
    case MENU_IDS.scanPage:
    case MENU_IDS.pageScan:
      if (tab && typeof tab.id === 'number') {
        scanPage(tab.id).catch((err) => broadcast({ type: 'NOTICE', detail: String(err.message || err).slice(0, 200) }));
        // Best-effort: openPopup needs a user gesture and can be denied; the
        // requested action itself already ran or surfaced its own notice.
        chrome.action.openPopup().catch(() => {});
      }
      break;
    case MENU_IDS.shotVisible:
    case MENU_IDS.pageShotVisible:
      captureVisible().catch(shotError);
      break;
    case MENU_IDS.shotArea:
    case MENU_IDS.pageShotArea:
      captureArea().catch(shotError);
      break;
    case MENU_IDS.shotFull:
    case MENU_IDS.pageShotFull:
      captureFullPage().catch(shotError);
      break;
    case MENU_IDS.shotElement:
    case MENU_IDS.pageShotElement:
      captureElement().catch(shotError);
      break;
    case MENU_IDS.addSitePref: {
      if (!host) {
        broadcast({ type: 'NOTICE', code: 'no-tab' });
        break;
      }
      const s = await getSettings();
      if (!s.sitePrefs[host]) s.sitePrefs[host] = 'smart';
      await saveSettings(s);
      broadcast({ type: 'NOTICE_TEXT', text: `${host} added to site preferences.` });
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#sites') });
      break;
    }
    case MENU_IDS.disableSite: {
      if (!host) {
        broadcast({ type: 'NOTICE', code: 'no-tab' });
        break;
      }
      const s = await getSettings();
      s.sitePrefs[host] = 'disabled';
      await saveSettings(s);
      broadcast({ type: 'NOTICE_TEXT', text: `ImgFetch paused on ${host}.` });
      break;
    }
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Message router                                                      */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Offscreen document messages are handled by the offscreen page itself;
  // never route or answer them here (answering 'invalid-message' could win
  // a response race against the offscreen's real handler).
  if (msg && msg.target === 'offscreen') return false;
  if (!isValidMessage(msg)) {
    sendResponse({ ok: false, error: 'invalid-message' });
    return false;
  }
  // M6: only accept messages from our own extension, and only the message
  // types each sender kind is allowed to send. Fail closed.
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'foreign-sender' });
    return false;
  }

  // M6: only accept messages from our own extension, and only the message
  // types each sender kind is allowed to send. Fail closed.
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'foreign-sender' });
    return false;
  }
  const kind = senderKind(sender);
  const allowed = SENDER_RULES[msg.type];
  if (!allowed || !allowed.includes(kind)) {
    sendResponse({ ok: false, error: 'forbidden' });
    return false;
  }
  (async () => {
    try {
      const result = await routeMessage(msg, kind, sender);
      sendResponse({ ok: true, ...result });
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
    }
  })();
  return true; // async response
});

async function routeMessage(msg, kind, sender) {
  const settings = await getSettings();
  switch (msg.type) {
    case 'GET_SETTINGS':
      return { settings };

    case 'SAVE_SETTINGS': {
      if (kind !== 'extension') throw new Error('forbidden');
      const next = await saveSettings(msg.settings || {});
      return { settings: next };
    }

    case 'RESET_SETTINGS': {
      if (kind !== 'extension') throw new Error('forbidden');
      const next = await saveSettings({ ...DEFAULT_SETTINGS });
      return { settings: next };
    }

    case 'SCAN_PAGE': {
      const tab = await activeTab();
      if (!isScannableTab(tab)) throw new Error(friendlyError('no-tab'));
      assertSiteAllowed(settings, tab.url); // H8: paused sites block scanning too
      // Shared inflight lock: racing the global shortcut never double-scans.
      const scan = await requestScan(tab.id);
      return { scan };
    }

    case 'GET_SCAN_STATE': {
      const tab = await activeTab();
      const scanState = await getScanState();
      return {
        state: scanState,
        forCurrentTab: !!(tab && scanState.tabId === tab.id),
      };
    }

    case 'GET_LAST_SCAN': {
      const stored = await chrome.storage.session.get(LAST_SCAN_KEY);
      const tab = await activeTab();
      const last = stored[LAST_SCAN_KEY];
      const fresh = last && tab && last.tabId === tab.id && last.url === tab.url
        && Date.now() - last.at < 5 * 60 * 1000;
      return { scan: fresh ? last : null };
    }

    case 'SUGGEST_FILENAME': {
      const srcUrl = normalizeUrl(msg.srcUrl, msg.pageUrl);
      const ext = msg.format && msg.format !== 'as-is'
        ? normalizeExportFormat(msg.format)
        : (getExtensionFromUrl(srcUrl) || 'png');
      const name = buildFilename(settings.filenameMode, {
        site: getHostLabel(msg.pageUrl || srcUrl),
        name: filenameHintFromUrl(srcUrl) || 'image',
        ext,
        date: new Date(),
        num: await peekFileNumber(),
        width: 0,
        height: 0,
        custom: settings.customTemplate,
      });
      return { name };
    }

    case 'DOWNLOAD_IMAGE': {
      // H6: prefer the originating context's page/tab (rename and info
      // pages are extension tabs, activeTab() would point at them).
      const explicitTabId = Number.parseInt(msg.tabId, 10);
      const tab = Number.isInteger(explicitTabId) && explicitTabId >= 0
        ? await chrome.tabs.get(explicitTabId).catch(() => null)
        : await activeTab();
      const pageUrl = typeof msg.pageUrl === 'string' && msg.pageUrl
        ? msg.pageUrl
        : (tab && tab.url) || '';
      prepareQueue(settings);
      queue.enqueue([{
        id: msg.id || `d-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        label: filenameHintFromUrl(msg.srcUrl) || 'image',
        payload: singleItemPayload(msg, {
          mode: resolveDownloadMode(settings, pageUrl, msg.mode), // H8
          pageUrl,
          pageTitle: (tab && tab.title) || '',
          tabId: tab && typeof tab.id === 'number' ? tab.id : null,
        }),
      }]);
      return { queued: true };
    }

    case 'DOWNLOAD_ZIP': {
      const tab = await activeTab();
      const pageUrl = (tab && tab.url) || '';
      assertSiteAllowed(settings, pageUrl); // H8
      const files = Array.isArray(msg.files) ? msg.files.slice(0, 200) : [];
      if (!files.length) return { queued: 0 };
      prepareQueue(settings);
      queue.enqueue([{
        id: msg.id || `z-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        label: `ZIP (${files.length} images, as shown)`,
        payload: {
          kind: 'zip',
          files,
          pageUrl,
          tabId: tab && typeof tab.id === 'number' ? tab.id : null,
        },
      }]);
      broadcast({ type: 'NOTICE', code: 'queued' });
      return { queued: 1 };
    }

    case 'DOWNLOAD_STRIPPED': {
      // L9: re-encoded copy with all metadata (EXIF/GPS) removed.
      const srcUrl = String(msg.url || '');
      if (!/^https?:\/\//i.test(srcUrl) && !srcUrl.startsWith('data:image/')) {
        throw new Error(friendlyError('bad-url'));
      }
      checkPublicFetch(srcUrl, msg.pageUrl); // M7/B2: same gate as downloads
      const stripped = await offscreenCall({ type: 'STRIP_METADATA', srcUrl, pageUrl: msg.pageUrl });
      if (!stripped || !stripped.ok || !stripped.dataUrl) {
        throw new Error(friendlyError('convert-failed'));
      }
      const ext = String(stripped.format || 'png').toLowerCase();
      const stem = sanitizeSegment(filenameHintFromUrl(srcUrl)).replace(/\.[a-z0-9]{2,4}$/i, '') || 'image';
      const filename = `${stem}-clean.${ext}`;
      const folder = resolveFolder(settings, msg.pageUrl || '', srcUrl, ext);
      const path = joinDownloadPath(folder, filename);
      const downloadId = await saveToDownloads({ url: stripped.dataUrl, path, saveAs: settings.saveAsDialog });
      if (downloadId == null) throw new Error(friendlyError('download-failed'));
      await recordHistory({
        filename: path.split('/').pop(),
        url: srcUrl,
        pageUrl: msg.pageUrl || '',
        width: stripped.width || 0,
        height: stripped.height || 0,
        bytes: await downloadFileSize(downloadId),
        format: ext,
      });
      return { ok: true };
    }

    case 'DOWNLOAD_MANY': {
      const tab = await activeTab();
      const pageUrl = (tab && tab.url) || '';
      const list = Array.isArray(msg.items) ? msg.items.slice(0, 500) : [];
      prepareQueue(settings);
      queue.enqueue(list.map((it, i) => ({
        id: it.id || `b-${Date.now()}-${i}`,
        label: filenameHintFromUrl(it.srcUrl) || `image-${i + 1}`,
        payload: bulkItemPayload(it, {
          mode: resolveDownloadMode(settings, pageUrl, it.mode), // H8
          format: it.format,
          pageUrl,
          pageTitle: (tab && tab.title) || '',
          tabId: tab && typeof tab.id === 'number' ? tab.id : null,
        }),
      })));
      return { queued: list.length };
    }

    case 'GET_QUEUE':
      return { snapshot: queue.snapshot() };
    case 'RETRY_QUEUE':
      return { snapshot: queue.retryFailed() };
    case 'CANCEL_QUEUE': {
      // L10: cancel honestly, active chrome.downloads are cancelled too,
      // not just pending queue items.
      const snap = queue.snapshot();
      const activeIds = (snap.items || [])
        .filter((it) => it.state === 'active' && it.chromeDownloadId != null)
        .map((it) => it.chromeDownloadId);
      // Best-effort per download: an id may already be finished/gone; the
      // queue item is marked cancelled regardless.
      await Promise.all(activeIds.map((id) => chrome.downloads.cancel(id).catch(() => {})));
      return { snapshot: queue.cancel() };
    }
    case 'CLEAR_QUEUE':
      return { snapshot: queue.clearFinished() };

    case 'GET_HISTORY': {
      const stored = await chrome.storage.local.get(HISTORY_KEY);
      return { records: stored[HISTORY_KEY] || [] };
    }
    case 'CLEAR_HISTORY': {
      if (kind !== 'extension') throw new Error('forbidden');
      await chrome.storage.local.set({ [HISTORY_KEY]: [] });
      return { cleared: true };
    }

    case 'CAPTURE_VISIBLE':
      return captureVisible();
    case 'CAPTURE_AREA':
      return captureArea().catch((err) => { shotError(err); throw err; });
    case 'CAPTURE_ELEMENT':
      return captureElement().catch((err) => { shotError(err); throw err; });
    case 'CAPTURE_FULL':
      return captureFullPage();
    case 'SAVE_CAPTURE':
      if (kind !== 'extension') throw new Error('forbidden');
      return saveCapture(String(msg.id || ''));

    case 'SAVE_ANNOTATED': {
      if (kind !== 'extension') throw new Error('forbidden');
      const capId = String(msg.id || '');
      const dataUrl = String(msg.dataUrl || '');
      if (!capId || !dataUrl.startsWith('data:image/png')) throw new Error('bad-input');
      if (dataUrl.length > 40_000_000) throw new Error('too-large');
      const cap = await recallCapture(capId);
      if (!cap) throw new Error(friendlyError('capture-failed'));
      // Swap in the annotated image, then save through the normal path.
      await rememberCapture(capId, { ...cap, dataUrl });
      return saveCapture(capId);
    }

    case 'GET_CAPTURE': {
      const cap = await recallCapture(String(msg.id || ''));
      if (!cap) throw new Error(friendlyError('capture-failed'));
      return { dataUrl: cap.dataUrl, width: cap.width, height: cap.height };
    }

    case 'GET_IMAGE_INFO': {
      // The info page itself becomes the active tab when it loads, so prefer
      // the source tab id passed in the page URL; fall back to active tab.
      let tab = null;
      const requested = Number(msg.tabId);
      if (Number.isInteger(requested) && requested >= 0) {
        tab = await chrome.tabs.get(requested).catch(() => null);
      }
      if (!isScannableTab(tab)) tab = await activeTab();
      if (!isScannableTab(tab)) throw new Error(friendlyError('no-tab'));
      const info = await runInPage(tab.id, (src) => {
        const api = window.__imgfetch;
        if (!api || typeof api.getImageInfo !== 'function') return null;
        return api.getImageInfo(src);
      }, [String(msg.srcUrl || '')]);
      if (!info) throw new Error(friendlyError('not-image'));
      return { info };
    }

    case 'RESOLVE_BLOB': {
      // Popup thumbnails / previews for page blob: URLs: fetch in-page and
      // return a data URL the popup can render. mode 'full' returns the
      // original bytes; anything else returns a light JPEG preview.
      const tabId = Number(msg.tabId);
      if (!Number.isInteger(tabId)) throw new Error(friendlyError('bad-url'));
      const full = String(msg.mode || '') === 'full';
      const dataUrl = await resolveBlobUrl(tabId, String(msg.url || ''), { thumb: !full });
      if (!dataUrl) throw new Error(friendlyError('blocked'));
      return { dataUrl };
    }

    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      return {};

    case 'SHOW_DOWNLOAD': {
      // B6: reveal a finished download in the file manager.
      const downloadId = Number(msg.downloadId);
      if (!Number.isInteger(downloadId) || downloadId < 0) {
        throw new Error(friendlyError('bad-url'));
      }
      chrome.downloads.show(downloadId);
      return {};
    }

    case 'GET_FORMAT_SUPPORT':
      return { avif: await supportsAvif() };

    case 'SCAN_PROGRESS':
      // Progress is consumed directly by the popup's own message listener.
      return {};

    default:
      throw new Error('unknown-message');
  }
}

let avifSupport = null;
async function supportsAvif() {
  if (avifSupport !== null) return avifSupport;
  // J3: cache only a definite answer. A failed probe (offscreen not ready,
  // transient error) is inconclusive — do not cache it as false for the
  // whole session; retry on the next call.
  try {
    const res = await offscreenCall({ type: 'SUPPORTS_AVIF' });
    if (res && typeof res.ok === 'boolean') avifSupport = res.ok;
  } catch {
    /* inconclusive — leave uncached so the next call retries */
  }
  return avifSupport === true;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/**
 * The global Scan shortcut is a real command, not a popup opener:
 * validate the active tab -> start the scan -> open the popup on top of
 * the live SCANNING state. The scan is NOT awaited here: the popup opens
 * immediately and flips to RESULTS by itself. Restricted pages
 * (chrome://, edge://, web store, PDFs) and paused sites get a useful
 * error instead of silence or a crash.
 */
async function handleScanCommand() {
  const tab = await activeTab();
  if (!tab || !Number.isInteger(tab.id) || !isScannableTab(tab)) {
    notifyScanIssue('ImgFetch can only scan normal web pages, browser pages like chrome://, edge:// or the web store are off-limits.');
    return;
  }
  try {
    assertSiteAllowed(await getSettings(), tab.url); // H8: paused sites block the shortcut too
  } catch {
    notifyScanIssue('ImgFetch is paused on this site (see Site Preferences).');
    return;
  }
  requestScan(tab.id).catch((err) => {
    notifyScanIssue(String((err && err.message) || err).slice(0, 200));
  });
  // Best-effort: openPopup needs a user gesture and can be denied; the
  // requested action itself already ran or surfaced its own notice.
  chrome.action.openPopup().catch(() => {});
}

/** Surface scan-command problems even when the popup is closed. */
function notifyScanIssue(message) {
  broadcast({ type: 'NOTICE_TEXT', text: message });
  chrome.notifications
    .create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-48.png'), title: 'ImgFetch', message })
    .catch(() => {});
}

/**
 * Select Element (Alt+Shift+E): pick any element on the page and show its
 * image details. Image → Image Info page; image container → its largest
 * image; anything else → a graceful "no image" note. Never reads form
 * values or page content, only image attributes.
 */
async function handleSelectElement() {
  const tab = await activeTab();
  if (!tab || !Number.isInteger(tab.id) || !isScannableTab(tab)) {
    notifyScanIssue('ImgFetch can only pick elements on normal web pages, browser pages like chrome://, edge:// or the web store are off-limits.');
    return;
  }
  try {
    assertSiteAllowed(await getSettings(), tab.url); // H8: paused sites block it too
  } catch {
    notifyScanIssue('ImgFetch is paused on this site (see Site Preferences).');
    return;
  }
  const pageUrl = tab.url || '';
  let picked = null;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/overlay.js'],
    });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: () => window.__imgfetch.pickElement(),
    });
    picked = (res && res.result) || null;
  } catch (err) {
    console.debug('[imgfetch] select-element failed:', err);
    picked = null;
  }
  if (!picked) return; // Esc / cancelled, silent, like the area selector
  let url = null;
  if (picked.descriptor) {
    url = normalizeUrl(pickBestImageUrl(picked.descriptor) || '', pageUrl);
  } else if (picked.backgroundUrl) {
    url = normalizeUrl(picked.backgroundUrl, pageUrl);
  }
  if (!url) {
    await showPageToast(tab.id, 'No image found in the selected element.', true);
    return;
  }
  const src = encodeURIComponent(url);
  chrome.tabs.create({
    url: chrome.runtime.getURL(
      `pages/info.html?src=${src}&tabId=${tab.id}&pageUrl=${encodeURIComponent(pageUrl)}`,
    ),
  }).catch((err) => console.debug('[imgfetch] select-element: could not open info tab:', err));
}

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === 'imgfetch-scan-page' || command === 'imgfetch-scan-page-alt') {
      await handleScanCommand();
    } else if (command === 'imgfetch-select-element') {
      await handleSelectElement();
    } else if (command === 'imgfetch-capture-area') {
      await captureArea();
    } else if (command === 'imgfetch-capture-element') {
      await captureElement();
    }
  } catch (err) {
    broadcast({ type: 'NOTICE', detail: String(err.message || err).slice(0, 200) });
  }
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  await getSettings(); // writes defaults on first run
  buildMenus();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/welcome.html') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  buildMenus();
});

// H5: every worker start (install, browser start, or restart after being
// killed idle) reconciles the persisted queue with real download state.
restoreQueueState().catch(() => {
  /* never break worker startup */
});

// Friendly codes used with NOTICE broadcasts.
const NOTICE_TEXT = {
  queued: 'Added to the ImgFetch download queue.',
  copied: 'Image link copied.',
  'disabled-site': 'ImgFetch is paused on this site (see Site Preferences).',
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'NOTICE' && msg.code && NOTICE_TEXT[msg.code]) {
    // Re-broadcast resolved text for surfaces that want plain strings.
    broadcast({ type: 'NOTICE_TEXT', text: NOTICE_TEXT[msg.code] });
  }
  return false;
});

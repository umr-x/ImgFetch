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
 * ImgFetch — core/validation.js
 * Message + sender validation for the background service worker.
 * Every runtime message is checked here before it is routed.
 */

export const MESSAGE_TYPES = new Set([
  // Popup / options / pages -> background
  'GET_SETTINGS',
  'SAVE_SETTINGS',
  'RESET_SETTINGS',
  'SCAN_PAGE',
  'GET_LAST_SCAN',
  'GET_SCAN_STATE',
  'DOWNLOAD_IMAGE',
  'DOWNLOAD_MANY',
  'GET_QUEUE',
  'RETRY_QUEUE',
  'CANCEL_QUEUE',
  'CLEAR_QUEUE',
  'GET_HISTORY',
  'CLEAR_HISTORY',
  'CAPTURE_VISIBLE',
  'CAPTURE_AREA',
  'CAPTURE_ELEMENT',
  'CAPTURE_FULL',
  'SAVE_CAPTURE',
  'SAVE_ANNOTATED',
  'SUGGEST_FILENAME',
  'GET_CAPTURE',
  'GET_IMAGE_INFO',
  'OPEN_OPTIONS',
  'GET_FORMAT_SUPPORT',
  'DOWNLOAD_ZIP',
  'DOWNLOAD_STRIPPED', // L9: info page -> clean copy without EXIF/GPS
  'RESOLVE_BLOB', // page blob: URL -> data URL (in-page fetch)
  'SHOW_DOWNLOAD', // B6: reveal a finished download in the file manager
  // Content script -> background
  'SCAN_PROGRESS',
  // Background -> popup (broadcast)
  'QUEUE_UPDATE',
  'SCAN_DONE',
  'NOTICE',
  'NOTICE_TEXT',
]);

const STRING_FIELDS = {
  DOWNLOAD_IMAGE: ['srcUrl', 'mode', 'format', 'customName', 'pageUrl', 'tabId'],
  DOWNLOAD_MANY: [],
  SCAN_PAGE: [],
  GET_LAST_SCAN: [],
  GET_SCAN_STATE: [],
  SAVE_SETTINGS: [],
  GET_CAPTURE: ['id'],
  GET_IMAGE_INFO: ['srcUrl', 'tabId'],
  CAPTURE_AREA: [],
  CAPTURE_VISIBLE: [],
  CAPTURE_ELEMENT: [],
  CAPTURE_FULL: [],
  SAVE_CAPTURE: ['id'],
  SAVE_ANNOTATED: ['id', 'dataUrl'],
  SUGGEST_FILENAME: ['srcUrl', 'format', 'pageUrl'],
  DOWNLOAD_ZIP: [],
  DOWNLOAD_STRIPPED: ['url'],
  RESOLVE_BLOB: ['url', 'tabId', 'mode'],
  SHOW_DOWNLOAD: ['downloadId'],
  GET_HISTORY: [],
  CLEAR_HISTORY: [],
  GET_QUEUE: [],
  RETRY_QUEUE: [],
  CANCEL_QUEUE: [],
  CLEAR_QUEUE: [],
  GET_SETTINGS: [],
  RESET_SETTINGS: [],
  OPEN_OPTIONS: [],
  GET_FORMAT_SUPPORT: [],
  SCAN_PROGRESS: [],
};

/** True when the message envelope is well-formed and expected. */
export function isValidMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  if (typeof msg.type !== 'string' || !MESSAGE_TYPES.has(msg.type)) return false;
  const fields = STRING_FIELDS[msg.type];
  if (!fields) return false;
  for (const f of fields) {
    if (f in msg && typeof msg[f] !== 'string') return false;
  }
  // Reject oversized payloads (abuse / memory protection). Image data URLs
  // (annotated screenshots) legitimately exceed the default cap.
  const maxLen = msg.type === 'SAVE_ANNOTATED' ? 45_000_000 : 1_000_000;
  try {
    if (JSON.stringify(msg).length > maxLen) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Classify the sender. Extension pages (popup, options, capture, info) always
 * have a chrome-extension:// URL — even when they are open in a tab, in which
 * case sender.tab is also set. Content scripts have the page's http(s) URL.
 * Checking the URL scheme first is what keeps settings/capture working.
 * Fail-closed: anything unrecognized is 'unknown', never 'extension' (M6).
 */
export function senderKind(sender) {
  const url = (sender && sender.url) || '';
  if (url.startsWith('chrome-extension://')) return 'extension';
  if (sender && sender.tab && typeof sender.tab.id === 'number') return 'content';
  return 'unknown';
}

/**
 * Least-privilege inbound routing (M6): which sender kinds may send each
 * message type to the service worker. Anything not listed here is denied.
 */
export const SENDER_RULES = {
  SCAN_PROGRESS: ['content'],
  GET_SETTINGS: ['extension'],
  SAVE_SETTINGS: ['extension'],
  RESET_SETTINGS: ['extension'],
  SCAN_PAGE: ['extension'],
  GET_LAST_SCAN: ['extension'],
  GET_SCAN_STATE: ['extension'],
  DOWNLOAD_IMAGE: ['extension'],
  DOWNLOAD_ZIP: ['extension'],
  DOWNLOAD_STRIPPED: ['extension'],
  DOWNLOAD_MANY: ['extension'],
  GET_QUEUE: ['extension'],
  RETRY_QUEUE: ['extension'],
  CANCEL_QUEUE: ['extension'],
  CLEAR_QUEUE: ['extension'],
  GET_HISTORY: ['extension'],
  CLEAR_HISTORY: ['extension'],
  CAPTURE_VISIBLE: ['extension'],
  CAPTURE_AREA: ['extension'],
  CAPTURE_ELEMENT: ['extension'],
  CAPTURE_FULL: ['extension'],
  SAVE_CAPTURE: ['extension'],
  SAVE_ANNOTATED: ['extension'],
  SUGGEST_FILENAME: ['extension'],
  GET_CAPTURE: ['extension'],
  GET_IMAGE_INFO: ['extension'],
  OPEN_OPTIONS: ['extension'],
  GET_FORMAT_SUPPORT: ['extension'],
  RESOLVE_BLOB: ['extension'],
  SHOW_DOWNLOAD: ['extension'],
};

/** Human-friendly error mapping. Never leaks raw technical errors. */
export function friendlyError(code) {
  const map = {
    'no-tab': 'Open a normal web page first, then try again.',
    'bad-url': 'This image link looks unsafe, so ImgFetch skipped it.',
    'not-image': 'ImgFetch could not find a usable image here.',
    'blocked': 'The website did not allow this image to be saved.',
    'convert-failed': 'ImgFetch could not convert this image. The original was saved instead.',
    'gif-unavailable': "ImgFetch couldn't encode this image as GIF. Nothing was saved.",
    'avif-unavailable': "AVIF encoding isn't available in this browser (needs Chrome/Edge 130+, update the browser to enable it). A PNG was saved instead.",
    'page-too-large': 'This page is too large to capture in one image.',
    'original-unknown': 'ImgFetch could not confidently find the original. The best available version was used.',
    'scan-failed': 'ImgFetch could not scan this page. Try reloading the page and scanning again.',
    'capture-failed': 'ImgFetch could not capture this page.',
    'download-failed': 'The download did not start. Please try again.',
    'cancelled': 'Cancelled.',
    'timeout': 'This took too long. Please try again.',
    'private-network': 'ImgFetch blocked a request to a private network address (like localhost or a router page) to protect your local network.',
    'disabled-site': 'ImgFetch is paused on this site. Re-enable it in Settings → Site Preferences.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

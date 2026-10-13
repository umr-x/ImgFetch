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
 * ImgFetch, pages/info.js
 * Image info page: details + every download action + copyable link.
 */
import { parseExif } from '../core/exif.js';
import { isPrivateNetworkFetchBlocked } from '../core/urls.js';

(() => {
  'use strict';
  const UI = window.ImgFetchUI;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const srcUrl = params.get('src') || '';
  const tabId = params.get('tabId') || '';
  const pageUrl = params.get('pageUrl') || '';

  document.addEventListener('DOMContentLoaded', init);

  /** Fetch just the file head (EXIF lives at the start) with a size cap. */
  async function fetchHead(url, maxBytes) {
    // B2: the info page fetches with extension privileges, apply the same
    // private-network rule as the worker (with the same-host exception).
    if (isPrivateNetworkFetchBlocked(url, pageUrl)) return null;
    const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, maxBytes - total);
      chunks.push(value.subarray(0, take));
      total += take;
      if (total >= maxBytes) {
        // Best-effort: the reader may already be closed; we already have
        // the bytes we need.
        reader.cancel().catch(() => {});
        break;
      }
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  async function readExif(url) {
    if (!/^https?:/i.test(url)) return null;
    const head = await fetchHead(url, 262144);
    if (!head) return null;
    return parseExif(head);
  }

  function formatExifDate(raw) {
    const m = /^(\d{4}):(\d{2}):(\d{2})[ ](\d{2}):(\d{2})/.exec(String(raw || ''));
    if (!m) return String(raw || '-');
    return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}`;
  }

  async function init() {
    try {
      const { settings } = await UI.send('GET_SETTINGS');
      UI.applyTheme(settings.theme);
    } catch {
      UI.applyTheme('system');
    }
    if (!srcUrl) {
      fail('No image was specified.');
      return;
    }
    let info;
    try {
      ({ info } = await UI.send('GET_IMAGE_INFO', { srcUrl, tabId }));
    } catch (err) {
      fail(err.message);
      return;
    }
    $('preview').src = info.url;
    $('preview').alt = info.alt || 'Image preview';
    $('link').value = info.url;

    const kv = $('kv');
    const rows = [
      ['File name', info.filename || 'image'],
      ['Dimensions', UI.formatDims(info.width, info.height)],
      ['Format', (info.format || 'unknown').toUpperCase()],
      ['Shown at', info.renderedWidth ? `${info.renderedWidth} × ${info.renderedHeight} px` : '-'],
    ];
    if (info.alt) rows.push(['Alt text', info.alt]);
    for (const [k, v] of rows) {
      kv.append(UI.el('dt', k), UI.el('dd', v));
    }

    // EXIF (JPEG): camera, date taken, orientation, GPS, read from the file head.
    try {
      const exif = await readExif(info.url);
      if (exif) {
        const kvExif = UI.el('dl', null, 'kv');
        kvExif.style.marginTop = '12px';
        const erows = [];
        if (exif.make || exif.model) erows.push(['Camera', [exif.make, exif.model].filter(Boolean).join(' ')]);
        if (exif.dateTaken || exif.dateTime) erows.push(['Taken on', formatExifDate(exif.dateTaken || exif.dateTime)]);
        if (exif.pixelWidth) erows.push(['Full size', `${exif.pixelWidth} × ${exif.pixelHeight} px`]);
        if (exif.gps) erows.push(['Location', `${exif.gps.lat}, ${exif.gps.lng}`]);
        if (erows.length) {
          const h = UI.el('h3', 'Photo details');
          h.style.cssText = 'font-size:13px;margin:14px 0 6px;color:var(--muted)';
          kv.after(h);
          for (const [k, v] of erows) kvExif.append(UI.el('dt', k), UI.el('dd', v));
          h.after(kvExif);
          // L9: GPS coordinates can reveal where someone lives or works.
          if (exif.gps) {
            const warn = UI.el('p', 'This photo contains GPS coordinates. Sharing the original file shares the exact location it was taken. Use “Save without metadata” for a clean copy.', 'small');
            warn.style.cssText = 'color:var(--warning,#b7791f);font-size:12px;margin:8px 0 0;line-height:1.5;';
            kvExif.after(warn);
            const stripBtn = UI.el('button', 'Save without metadata', 'btn');
            stripBtn.style.marginTop = '8px';
            stripBtn.addEventListener('click', async () => {
              stripBtn.disabled = true;
              try {
                await UI.send('DOWNLOAD_STRIPPED', { url: info.url, pageUrl: info.pageUrl });
                UI.toast('Saved a copy with metadata removed.');
              } catch (err) {
                UI.toast(err.message || 'Could not strip metadata.');
                stripBtn.disabled = false;
              }
            });
            warn.after(stripBtn);
          }
        }
      }
    } catch {
      /* EXIF is best-effort */
    }

    $('loading').hidden = true;
    $('content').hidden = false;

    const dl = (mode, format) => async () => {
      try {
        await UI.send('DOWNLOAD_IMAGE', { srcUrl: info.url, mode, format: format || 'as-is', pageUrl, tabId });
        UI.toast('Added to the ImgFetch download queue.');
      } catch (err) {
        UI.toast(err.message);
      }
    };
    $('btnDownload').addEventListener('click', dl('smart'));
    $('btnPng').addEventListener('click', dl('smart', 'png'));
    $('btnJpg').addEventListener('click', dl('smart', 'jpg'));
    $('btnWebp').addEventListener('click', dl('smart', 'webp'));
    $('btnAvif').addEventListener('click', dl('smart', 'avif'));
    $('btnOpen').addEventListener('click', () => {
      if (/^https?:\/\//i.test(info.url)) {
        chrome.tabs.create({ url: info.url });
      } else {
        UI.toast('This image cannot be opened in a tab.');
      }
    });
    $('btnCopy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(info.url);
        UI.toast('Image link copied.');
      } catch {
        $('link').select();
        UI.toast('Copy the selected link manually.');
      }
    });
    $('link').addEventListener('click', (e) => e.target.select());
  }

  function fail(message) {
    const loading = $('loading');
    loading.textContent = '';
    loading.append(UI.el('p', message, 'muted'));
  }
})();

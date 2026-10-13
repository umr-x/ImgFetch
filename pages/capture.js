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
 * ImgFetch, pages/capture.js
 * Screenshot preview: shows the capture, lets the user save / retake / discard.
 */
(() => {
  'use strict';
  const UI = window.ImgFetchUI;
  const $ = (id) => document.getElementById(id);
  const id = location.hash.replace('#', '');

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      const { settings } = await UI.send('GET_SETTINGS');
      UI.applyTheme(settings.theme);
      UI.watchSystemTheme(() => settings.theme);
    } catch {
      UI.applyTheme('system');
    }
    if (!id) {
      fail('This preview link is invalid.');
      return;
    }
    try {
      const cap = await UI.send('GET_CAPTURE', { id });
      $('shot').src = cap.dataUrl;
      $('meta').textContent = cap.width > 0 && cap.height > 0
        ? `${cap.width} × ${cap.height} pixels`
        : 'Screenshot ready';
      $('loading').hidden = true;
      $('content').hidden = false;
    } catch (err) {
      fail(err.message);
    }

    $('btnSave').addEventListener('click', async () => {
      $('btnSave').disabled = true;
      try {
        const { filename } = await UI.send('SAVE_CAPTURE', { id });
        UI.toast(`Saved ${filename.split('/').pop()}`);
        setTimeout(() => window.close(), 900);
      } catch (err) {
        UI.toast(err.message);
        $('btnSave').disabled = false;
      }
    });
    // B6: copy the screenshot bitmap to the clipboard (user gesture).
    $('btnCopyShot').addEventListener('click', async () => {
      try {
        const cap = await UI.send('GET_CAPTURE', { id });
        const blob = await (await fetch(cap.dataUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
        UI.toast('Screenshot copied to clipboard.');
      } catch (err) {
        UI.toast('Could not copy the screenshot.');
      }
    });
    $('btnRetakeVisible').addEventListener('click', async () => {
      try {
        await UI.send('CAPTURE_VISIBLE');
        window.close();
      } catch (err) {
        UI.toast(err.message);
      }
    });
    $('btnRetakeArea').addEventListener('click', async () => {
      try {
        await UI.send('CAPTURE_AREA');
        window.close();
      } catch (err) {
        UI.toast(err.message);
      }
    });
    $('btnDiscard').addEventListener('click', () => window.close());
  }

  function fail(message) {
    const loading = $('loading');
    loading.textContent = '';
    loading.append(UI.el('p', message, 'muted'));
  }
})();

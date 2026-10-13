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
 * ImgFetch, pages/rename.js
 * Extracted from pages/rename.html: MV3 blocks inline scripts (CSP),
 * so page logic must live in an external file.
 */
  (() => {
'use strict';
const UI = window.ImgFetchUI;

const q = new URLSearchParams(location.search);
const srcUrl = q.get('src') || '';
const format = q.get('format') || 'as-is';
const mode = q.get('mode') || 'smart';
const pageUrl = q.get('pageUrl') || '';
const tabId = q.get('tabId') || '';

const $ = (id) => document.getElementById(id);
UI.applyTheme('system');

async function init() {
  if (srcUrl) $('preview').src = srcUrl;
  try {
    const { settings } = await UI.send('GET_SETTINGS');
    UI.applyTheme(settings.theme);
    const res = await UI.send('SUGGEST_FILENAME', { srcUrl, format, pageUrl });
    if (res && res.name) $('filename').value = res.name;
  } catch {
    /* fall back to URL hint */
    try {
      $('filename').value = (srcUrl.split('/').pop() || 'image').split('?')[0] || 'image';
    } catch { /* malformed URL; keep default filename */ }
  }
  const fmt = format && format !== 'as-is' ? format.toUpperCase() : 'original format';
  $('formatHint').textContent = `Will be saved as ${fmt}. The correct extension is added automatically.`;
  $('filename').focus();
  $('filename').select();
}

$('btnSave').addEventListener('click', async () => {
  const customName = $('filename').value.trim();
  $('btnSave').disabled = true;
  try {
    await UI.send('DOWNLOAD_IMAGE', { srcUrl, mode, format, customName, pageUrl, tabId });
  } finally {
    window.close();
  }
});
$('btnCancel').addEventListener('click', () => window.close());
$('filename').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btnSave').click();
  if (e.key === 'Escape') window.close();
});

init();
  })();

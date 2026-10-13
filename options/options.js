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
 * ImgFetch, options/options.js
 * Settings page controller. Every change saves automatically (debounced).
 */
import { parseSettingsImport } from '../core/filenames.js';
import { normalizeHost } from '../core/urls.js';
import { groupByDay } from '../core/history.js';

const UI = window.ImgFetchUI;
const $ = (id) => document.getElementById(id);

// Public repository URL. Used by the About section links.
const GITHUB_REPO = 'https://github.com/umr-x/imgfetch';

let settings = null;
let saveTimer = 0;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  try {
    const res = await UI.send('GET_SETTINGS');
    settings = res.settings;
  } catch (err) {
    UI.toast(err.message);
    return;
  }
  UI.applyTheme(settings.theme);
  UI.watchSystemTheme(() => settings.theme);
  paintAll();
  wireAll();
  $('aboutVersion').textContent = chrome.runtime.getManifest().version;
  $('aboutLicenceLink').href = GITHUB_REPO + '/blob/main/LICENSE';
  $('aboutRepoLink').href = GITHUB_REPO;
  $('aboutRepoLink').textContent = GITHUB_REPO.replace('https://', '');
  $('aboutPrivacyLink').href = GITHUB_REPO + '/blob/main/PRIVACY.md';
}

function scheduleSave() {
  const el = $('saveState');
  el.textContent = 'Saving…';
  el.className = 'saving';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const res = await UI.send('SAVE_SETTINGS', { settings });
      settings = res.settings;
      UI.applyTheme(settings.theme);
      el.textContent = 'All changes saved';
      el.className = '';
    } catch (err) {
      el.textContent = 'Could not save, try again';
      el.className = 'error';
      UI.toast(err.message);
    }
  }, 350);
}

/* ---------------- paint ---------------- */

function seg(id, value) {
  document.querySelectorAll(`#${id} button`).forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.v === value));
  });
}

function paintAll() {
  seg('themeSeg', settings.theme);
  seg('afterDlSeg', settings.afterDownload);
  seg('shotFormatSeg', settings.screenshotFormat);
  document.querySelectorAll('input[name="qualityPreference"]').forEach((r) => {
    r.checked = r.value === settings.qualityPreference;
  });

  $('saveAsDialog').checked = settings.saveAsDialog;
  $('autoRetryOnce').checked = settings.autoRetryOnce;
  $('maxConcurrent').value = settings.maxConcurrent;
  $('maxConcVal').textContent = settings.maxConcurrent;

  document.querySelectorAll('input[name="filenameMode"]').forEach((r) => {
    r.checked = r.value === settings.filenameMode;
  });
  $('customTemplate').value = settings.customTemplate;
  $('customTemplateWrap').hidden = settings.filenameMode !== 'custom';

  $('folderMode').value = settings.folderMode;
  $('subfolder').value = settings.subfolder;
  $('useSubfolder').checked = settings.useSubfolder === true;
  syncSubfolderField();

  $('jpgQuality').value = settings.jpgQuality;
  $('jpgQVal').textContent = `${Math.round(settings.jpgQuality * 100)}%`;
  $('pngQuality').value = settings.pngQuality;
  $('pngQVal').textContent = `${Math.round(settings.pngQuality * 100)}%`;
  $('webpQuality').value = settings.webpQuality;
  $('webpQVal').textContent = `${Math.round(settings.webpQuality * 100)}%`;
  $('screenshotQuality').value = settings.screenshotQuality;
  $('shotQVal').textContent = `${Math.round(settings.screenshotQuality * 100)}%`;

  $('minSizePreset').value = settings.minSizePreset;
  $('includeBackgrounds').checked = settings.includeBackgrounds;
  seg('scanDepthSeg', settings.scanDepth === 'loaded' ? 'loaded' : 'scroll');
  $('dedupeScan').checked = settings.dedupeScan;
  $('annotateAfterCapture').checked = settings.annotateAfterCapture;
  $('askFilename').checked = settings.askFilename;
  $('autoCollapseQueue').checked = settings.autoCollapseQueue !== false;

  $('historyEnabled').checked = settings.historyEnabled;
  $('historyRetentionDays').value = settings.historyRetentionDays;

  renderSiteList();
}

/* ---------------- wire ---------------- */

function wireSeg(id, key) {
  document.querySelectorAll(`#${id} button`).forEach((b) => {
    b.addEventListener('click', () => {
      settings[key] = b.dataset.v;
      seg(id, b.dataset.v);
      scheduleSave();
    });
  });
}

function wireCheck(id, key) {
  $(id).addEventListener('change', (e) => {
    settings[key] = e.target.checked;
    scheduleSave();
  });
}

/** The subfolder name field is only meaningful while its toggle is on. */
function syncSubfolderField() {
  const on = $('useSubfolder').checked;
  $('subfolder').disabled = !on;
  $('subfolder').closest('.field').style.opacity = on ? '' : '0.55';
}

function wireAll() {
  wireSeg('themeSeg', 'theme');
  wireSeg('afterDlSeg', 'afterDownload');
  wireSeg('shotFormatSeg', 'screenshotFormat');
  document.querySelectorAll('input[name="qualityPreference"]').forEach((r) => {
    r.addEventListener('change', () => {
      settings.qualityPreference = document.querySelector('input[name="qualityPreference"]:checked').value;
      scheduleSave();
    });
  });

  wireCheck('saveAsDialog', 'saveAsDialog');
  wireCheck('autoRetryOnce', 'autoRetryOnce');
  wireCheck('includeBackgrounds', 'includeBackgrounds');
  document.querySelectorAll('#scanDepthSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      settings.scanDepth = b.dataset.v;
      settings.detectLazyScroll = b.dataset.v === 'scroll'; // keep legacy alias in sync
      seg('scanDepthSeg', b.dataset.v);
      scheduleSave();
    });
  });
  wireCheck('dedupeScan', 'dedupeScan');
  wireCheck('annotateAfterCapture', 'annotateAfterCapture');
  wireCheck('askFilename', 'askFilename');
  wireCheck('historyEnabled', 'historyEnabled');
  wireCheck('autoCollapseQueue', 'autoCollapseQueue');
  wireCheck('useSubfolder', 'useSubfolder');
  $('useSubfolder').addEventListener('change', syncSubfolderField);

  $('maxConcurrent').addEventListener('input', (e) => {
    settings.maxConcurrent = Number(e.target.value);
    $('maxConcVal').textContent = e.target.value;
    scheduleSave();
  });
  $('jpgQuality').addEventListener('input', (e) => {
    settings.jpgQuality = Number(e.target.value);
    $('jpgQVal').textContent = `${Math.round(e.target.value * 100)}%`;
    scheduleSave();
  });
  $('pngQuality').addEventListener('input', (e) => {
    settings.pngQuality = Number(e.target.value);
    $('pngQVal').textContent = `${Math.round(e.target.value * 100)}%`;
    scheduleSave();
  });
  $('webpQuality').addEventListener('input', (e) => {
    settings.webpQuality = Number(e.target.value);
    $('webpQVal').textContent = `${Math.round(e.target.value * 100)}%`;
    scheduleSave();
  });
  $('screenshotQuality').addEventListener('input', (e) => {
    settings.screenshotQuality = Number(e.target.value);
    $('shotQVal').textContent = `${Math.round(e.target.value * 100)}%`;
    scheduleSave();
  });

  document.querySelectorAll('input[name="filenameMode"]').forEach((r) => {
    r.addEventListener('change', () => {
      settings.filenameMode = document.querySelector('input[name="filenameMode"]:checked').value;
      $('customTemplateWrap').hidden = settings.filenameMode !== 'custom';
      scheduleSave();
    });
  });
  $('customTemplate').addEventListener('input', UI.debounce((e) => {
    settings.customTemplate = e.target.value;
    scheduleSave();
  }));
  $('subfolder').addEventListener('input', UI.debounce((e) => {
    settings.subfolder = e.target.value;
    scheduleSave();
  }));
  $('minSizePreset').addEventListener('change', (e) => {
    settings.minSizePreset = e.target.value;
    scheduleSave();
  });
  $('folderMode').addEventListener('change', (e) => {
    settings.folderMode = e.target.value;
    scheduleSave();
  });
  $('historyRetentionDays').addEventListener('change', (e) => {
    const n = Math.min(365, Math.max(1, Math.round(Number(e.target.value) || 30)));
    settings.historyRetentionDays = n;
    e.target.value = n;
    scheduleSave();
  });

  wireSites();
  wireHistorySection();
  wireBackup();
  wireScreenshots();
  wireShortcuts();
  wireAbout();
  wireSidebar();
}

/* ---------------- site preferences ---------------- */

function renderSiteList() {
  const list = $('siteList');
  list.textContent = '';
  const entries = Object.entries(settings.sitePrefs || {});
  if (!entries.length) {
    list.append(UI.el('p', 'No site preferences yet.', 'muted small'));
    return;
  }
  const frag = document.createDocumentFragment();
  const labels = { smart: 'Smart', best: 'Smart', normal: 'As shown', disabled: 'Paused' };
  for (const [host, mode] of entries.sort()) {
    const row = UI.el('div', null, 'site-row');
    const name = UI.el('strong', host);
    name.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis;';
    const select = document.createElement('select');
    select.className = 'inline';
    select.setAttribute('aria-label', `Behavior for ${host}`);
    for (const [v, label] of Object.entries(labels)) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = label;
      if (v === mode) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      settings.sitePrefs[host] = select.value;
      scheduleSave();
    });
    const remove = UI.el('button', 'Remove', 'btn btn-sm btn-ghost');
    remove.addEventListener('click', () => {
      delete settings.sitePrefs[host];
      renderSiteList();
      scheduleSave();
    });
    row.append(name, select, remove);
    frag.append(row);
  }
  list.append(frag);
}

function cleanHost(raw) {
  return normalizeHost(raw); // single shared rule, see core/urls.js (H9)
}

function wireSites() {
  $('btnAddSite').addEventListener('click', () => {
    const host = cleanHost($('siteHost').value);
    if (!host) {
      UI.toast('Type a website domain, like example.com.');
      return;
    }
    settings.sitePrefs[host] = settings.sitePrefs[host] || 'smart';
    $('siteHost').value = '';
    renderSiteList();
    scheduleSave();
    UI.toast(`Added ${host}.`);
  });
  $('btnCurrentSite').addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const host = tab && tab.url ? cleanHost(new URL(tab.url).hostname) : '';
      if (!host) {
        UI.toast('Could not read the current site.');
        return;
      }
      $('siteHost').value = host;
      UI.toast(`Current site: ${host}`);
    } catch {
      UI.toast('Could not read the current site.');
    }
  });
}

/* ---------------- download history ---------------- */

function wireHistorySection() {
  loadOptHistory();
  $('btnClearHistory').addEventListener('click', async () => {
    const ok = await UI.confirmDialog({
      title: 'Clear download history?',
      message: 'This removes the list of files ImgFetch downloaded. The files themselves stay on your device.',
      confirmLabel: 'Clear history',
      danger: true,
    });
    if (!ok) return;
    try {
      await UI.send('CLEAR_HISTORY');
      UI.toast('History cleared.');
      loadOptHistory();
    } catch (err) {
      UI.toast(err.message || 'Could not clear history.');
    }
  });
}

let optHistoryLoadSeq = 0;
async function loadOptHistory() {
  const seq = ++optHistoryLoadSeq;
  const list = $('optHistoryList');
  list.textContent = '';
  try {
    const { records } = await UI.send('GET_HISTORY');
    // A newer load started while we awaited (e.g. rapid section switches) —
    // only the latest may paint, or rows duplicate.
    if (seq !== optHistoryLoadSeq) return;
    if (!records || !records.length) {
      list.append(UI.el('p', 'No downloads yet. Your saved images will appear here.', 'muted small'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const group of groupByDay(records)) {
      frag.append(UI.el('div', `${group.label} · ${group.count}`, 'hist-day'));
      for (const r of group.items) {
        const row = UI.el('div', null, 'hist-item');
        row.append(UI.el('span', (r.format || '').toUpperCase(), 'fmt'));
        const name = UI.el('span', r.filename || 'image');
        name.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
        name.title = r.filename || '';
        row.append(name, UI.el('span', UI.formatHistorySize(r), 'muted small'));
        frag.append(row);
      }
    }
    list.append(frag);
  } catch (err) {
    list.append(UI.el('p', err.message, 'muted small'));
  }
}

/* ---------------- backup & reset ---------------- */

function wireBackup() {
  $('btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ imgfetch: 1, version: 1, settings }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'imgfetch-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    UI.toast('Settings exported.');
  });

  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const data = parseSettingsImport(text);
      const imported = data.settings && typeof data.settings === 'object' ? data.settings : data;
      const res = await UI.send('SAVE_SETTINGS', { settings: imported });
      settings = res.settings;
      paintAll();
      UI.toast('Settings imported.');
    } catch {
      UI.toast('That file is not a valid ImgFetch settings export.');
    }
  });

  $('btnReset').addEventListener('click', async () => {
    const ok = await UI.confirmDialog({
      title: 'Reset all settings?',
      message: 'Every ImgFetch setting returns to its default. Your download history is kept.',
      confirmLabel: 'Reset settings',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await UI.send('RESET_SETTINGS');
      settings = res.settings;
      paintAll();
      UI.toast('Settings reset.');
    } catch (err) {
      UI.toast(err.message);
    }
  });
}

/* ---------------- screenshots: capture now ---------------- */

function wireScreenshots() {
  const run = async (type, label) => {
    try {
      const res = await UI.send(type);
      if (res && res.cancelled) return;
      UI.toast(`${label}, check the preview tab to save it.`);
    } catch (err) {
      UI.toast(err.message);
    }
  };
  $('shotNowVisible').addEventListener('click', () => run('CAPTURE_VISIBLE', 'Visible area captured'));
  $('shotNowArea').addEventListener('click', () => run('CAPTURE_AREA', 'Area captured'));
  $('shotNowElement').addEventListener('click', () => run('CAPTURE_ELEMENT', 'Element captured'));
  $('shotNowFull').addEventListener('click', () => run('CAPTURE_FULL', 'Full page captured'));
}

/* ---------------- shortcuts: real bindings ---------------- */

const COMMAND_LABELS = {
  'imgfetch-scan-page': 'Scan this page',
  'imgfetch-scan-page-alt': 'Scan this page (alternative)',
  'imgfetch-select-element': 'Select element',
  'imgfetch-capture-area': 'Capture selected area',
  'imgfetch-capture-element': 'Capture element',
};

async function wireShortcuts() {
  const list = $('shortcutList');
  try {
    const commands = await chrome.commands.getAll();
    const known = commands.filter((c) => COMMAND_LABELS[c.name]);
    list.textContent = '';
    if (!known.length) {
      list.append(UI.el('p', 'No shortcuts registered.', 'small muted'));
    } else {
      const dl = UI.el('dl', null, 'kv');
      for (const c of known) {
        dl.append(UI.el('dt', COMMAND_LABELS[c.name] || c.name));
        const dd = document.createElement('dd');
        if (c.shortcut) {
          for (const part of String(c.shortcut).split('+')) {
            dd.append(UI.el('kbd', part.trim()));
            dd.append(document.createTextNode(' + '));
          }
          dd.removeChild(dd.lastChild);
        } else {
          dd.append(UI.el('span', 'Not set', 'muted small'));
        }
        dl.append(dd);
      }
      list.append(dl);
    }
  } catch {
    list.textContent = '';
    list.append(UI.el('p', 'Could not read shortcut bindings.', 'small muted'));
  }
  $('btnCopyShortcutLink').addEventListener('click', async () => {
    // L2: Edge uses edge://, Chrome uses chrome://.
    const scheme = navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome';
    const link = `${scheme}://extensions/shortcuts`;
    try {
      await navigator.clipboard.writeText(link);
      UI.toast('Shortcuts page link copied, paste it into your address bar.');
    } catch {
      UI.toast(link);
    }
  });
}

/* ---------------- about ---------------- */

const PERMISSION_DESCRIPTIONS = {
  contextMenus: 'Add ImgFetch items to the right-click menu.',
  downloads: 'Save image files to your Downloads folder.',
  storage: 'Remember your settings and history on this device.',
  scripting: 'Scan pages you ask it to, looking for images.',
  activeTab: 'Work with the tab that is currently open.',
  offscreen: 'Convert images between formats in the background.',
  notifications: 'Tell you when a download finishes (only if you enable it).',
  clipboardWrite: 'Copy image links to your clipboard for you.',
};

function wireAbout() {
  const manifest = chrome.runtime.getManifest();
  $('aboutVersion').textContent = manifest.version || '–';
  if (manifest.description) $('aboutTagline').textContent = manifest.description;
  const ul = $('aboutPermissions');
  ul.textContent = '';
  const perms = [...(manifest.permissions || [])];
  const hosts = manifest.host_permissions || [];
  for (const p of perms) {
    if (p === 'offscreen') continue; // implementation detail, covered by "convert"
    const li = document.createElement('li');
    li.textContent = PERMISSION_DESCRIPTIONS[p] || p;
    ul.append(li);
  }
  if (hosts.length) {
    const li = document.createElement('li');
    li.textContent = 'Read images on websites you visit, only when you scan a page or start a download.';
    ul.append(li);
  }
}

/* ---------------- sidebar navigation ---------------- */

const SECTION_IDS = [
  'general', 'downloads', 'quality', 'filenames', 'scanning', 'screenshots',
  'sites', 'shortcuts', 'folders', 'history', 'backup', 'about', 'privacy',
];

function showSection(id) {
  if (!SECTION_IDS.includes(id)) id = 'general';
  for (const s of SECTION_IDS) {
    const el = $(s);
    if (el) el.hidden = s !== id;
  }
  document.querySelectorAll('.side-nav button').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.section === id));
  });
  // The browser tab title follows the open section, so the tab never says
  // "Settings" while showing something else (e.g. Download History).
  const navLabel = document.querySelector(`.side-nav button[data-section="${id}"]`);
  const label = navLabel ? navLabel.textContent.trim() : '';
  document.title = label && id !== 'general' ? `${label} - ImgFetch Settings` : 'ImgFetch Settings';
  const select = $('navSelect');
  if (select) select.value = id;
  if (location.hash !== `#${id}`) {
    history.replaceState(null, '', `#${id}`);
  }
  document.querySelector('.settings-main').scrollTo?.(0, 0);
  window.scrollTo(0, 0);
  // The history list is a live log, refresh it every time the section opens,
  // so downloads made after the page loaded (popup, menu, shortcuts) appear.
  if (id === 'history') loadOptHistory();
}

function wireSidebar() {
  document.querySelectorAll('.side-nav button').forEach((b) => {
    b.addEventListener('click', () => showSection(b.dataset.section));
  });
  $('navSelect').addEventListener('change', (e) => showSection(e.target.value));
  window.addEventListener('hashchange', () => {
    showSection(location.hash.replace('#', ''));
  });
  // Deep links (e.g. the "Add Site Preference" menu opens #sites).
  const initial = location.hash.replace('#', '');
  showSection(SECTION_IDS.includes(initial) ? initial : 'general');
}

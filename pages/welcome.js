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
 * ImgFetch, pages/welcome.js
 * 4-step onboarding (the last step is a curated mini-settings panel).
 * External script (extension pages block inline JS).
 */
(() => {
  'use strict';
  const UI = window.ImgFetchUI;
  let step = 0;
  let settings = null;
  let saveTimer = 0;
  const $ = (id) => document.getElementById(id);
  const steps = () => [...document.querySelectorAll('.step')];
  const dots = () => [...document.querySelectorAll('.dots i')];

  function paint() {
    steps().forEach((s, i) => s.classList.toggle('active', i === step));
    dots().forEach((d, i) => d.classList.toggle('on', i === step));
    document.getElementById('btnBack').hidden = step === 0;
    document.getElementById('btnNext').textContent = step === steps().length - 1 ? 'Start using ImgFetch' : 'Next';
  }

  document.getElementById('btnBack').addEventListener('click', () => {
    if (step > 0) {
      step -= 1;
      paint();
    }
  });

  document.getElementById('btnNext').addEventListener('click', async () => {
    if (step < steps().length - 1) {
      step += 1;
      paint();
      return;
    }
    // L7: the onboarded flag was written but never read, the welcome page
    // only opens on fresh install (see onInstalled), so the flag is dead state.
    UI.toast('Enjoy ImgFetch!');
    setTimeout(() => window.close(), 600);
  });

  UI.send('GET_SETTINGS').then(({ settings: s }) => {
    settings = s;
    UI.applyTheme(s.theme);
    paintMini();
    wireMini();
  }).catch(() => UI.applyTheme('system'));

  /* ----- mini settings on step 4 ----- */

  function paintMini() {
    if (!settings) return;
    $('wAnnotate').checked = !!settings.annotateAfterCapture;
    $('wAskName').checked = !!settings.askFilename;
    $('wSubfolder').value = settings.subfolder || '';
    document.querySelectorAll('#wAfterDl button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.v === settings.afterDownload));
    });
  }

  function saveMini() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      UI.send('SAVE_SETTINGS', { settings }).catch((err) => UI.toast(err.message));
    }, 300);
  }

  function wireMini() {
    $('wAnnotate').addEventListener('change', (e) => {
      settings.annotateAfterCapture = e.target.checked;
      saveMini();
    });
    $('wAskName').addEventListener('change', (e) => {
      settings.askFilename = e.target.checked;
      saveMini();
    });
    $('wSubfolder').addEventListener('input', UI.debounce((e) => {
      settings.subfolder = e.target.value;
      // Typing a name means "use it", the toggle follows the field here.
      settings.useSubfolder = e.target.value.trim().length > 0;
      saveMini();
    }));
    document.querySelectorAll('#wAfterDl button').forEach((b) => {
      b.addEventListener('click', () => {
        settings.afterDownload = b.dataset.v;
        paintMini();
        saveMini();
      });
    });
    $('wFullSettings').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
    });
  }

  // F4: show the real shortcuts from chrome.commands.getAll(), not hardcoded
  // values. Handles user rebinding, empty (unbound) commands, and Mac.
  function renderShortcut(el, shortcut) {
    el.textContent = '';
    if (!shortcut) {
      const s = document.createElement('span');
      s.className = 'muted';
      s.textContent = 'Not set, assign in browser shortcut settings';
      el.append(s);
      return;
    }
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const pretty = isMac
      ? shortcut.replace(/Ctrl|Control/g, '⌘').replace(/Alt/g, '⌥').replace(/Shift/g, '⇧')
      : shortcut;
    const parts = pretty.split('+');
    parts.forEach((part, i) => {
      if (i > 0) el.append(document.createTextNode(isMac ? ' ' : ' + '));
      const k = document.createElement('kbd');
      k.textContent = part.trim();
      el.append(k);
    });
  }

  async function paintShortcuts() {
    let cmds = [];
    try {
      cmds = await chrome.commands.getAll();
    } catch {
      cmds = [];
    }
    const byName = Object.fromEntries(cmds.map((c) => [c.name, c.shortcut || '']));
    renderShortcut($('scScan'), byName['imgfetch-scan-page']);
    renderShortcut($('scCapture'), byName['imgfetch-capture-area']);
  }

  paint();
  paintShortcuts();
})();

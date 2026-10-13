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
 * ImgFetch — shared/ui.js
 * Tiny view helpers shared by popup, options and pages. No dependencies.
 */
(() => {
  'use strict';

  /** Resolve "system" to light/dark and apply [data-theme] on <html>. */
  function applyTheme(theme) {
    const root = document.documentElement;
    let resolved = theme || 'system';
    if (resolved === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    if (root.getAttribute('data-theme') === resolved) return resolved;
    // Smooth cross-fade so switching themes never flashes or jerks.
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      root.classList.add('theme-fade');
      setTimeout(() => root.classList.remove('theme-fade'), 350);
    }
    root.setAttribute('data-theme', resolved);
    try { root.style.colorScheme = resolved; } catch { /* old browser; ignore */ }
    return resolved;
  }

  function watchSystemTheme(getTheme) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getTheme() === 'system') applyTheme('system');
    });
  }

  /** Safe text: create an element with textContent (never innerHTML). */
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function toast(message, ms) {
    let stack = document.querySelector('.toast-stack');
    if (!stack) {
      stack = el('div', null, 'toast-stack');
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    const t = el('div', message, 'toast');
    stack.appendChild(t);
    setTimeout(() => t.remove(), ms || 2600);
    while (stack.children.length > 3) stack.firstChild.remove();
  }

  /**
   * L6: inline confirmation dialog matching the ImgFetch design — replaces
   * window.confirm(). Returns a Promise<boolean>. Focus-trapped, Escape
   * cancels, and it restores focus to the invoking element.
   */
  function confirmDialog({ title, message, confirmLabel, danger }) {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const backdrop = el('div', null, 'confirm-backdrop');
      backdrop.style.cssText =
        'position:fixed;inset:0;background:rgba(10,12,25,.5);z-index:9999;' +
        'display:flex;align-items:center;justify-content:center;padding:20px;';
      const dialog = el('div', null, 'confirm-dialog');
      dialog.setAttribute('role', 'alertdialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', title);
      dialog.style.cssText =
        'background:var(--surface);border:1px solid var(--border);border-radius:14px;' +
        'padding:18px;max-width:340px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.3);';
      const h = el('h3', title);
      h.style.cssText = 'margin:0 0 8px;font-size:15px;';
      const p = el('p', message);
      p.style.cssText = 'margin:0 0 16px;color:var(--muted);font-size:13px;line-height:1.5;';
      const row = el('div', null, 'row');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      const cancelBtn = el('button', 'Cancel', 'btn');
      cancelBtn.type = 'button';
      const okBtn = el('button', confirmLabel || 'Confirm', danger ? 'btn btn-danger' : 'btn btn-primary');
      okBtn.type = 'button';
      row.append(cancelBtn, okBtn);
      dialog.append(h, p, row);
      backdrop.append(dialog);
      document.body.append(backdrop);

      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        backdrop.remove();
        if (prevFocus && prevFocus.focus) prevFocus.focus();
        resolve(value);
      };
      cancelBtn.addEventListener('click', () => finish(false));
      okBtn.addEventListener('click', () => finish(true));
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) finish(false);
      });
      backdrop.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') finish(false);
        // Simple focus trap: keep Tab cycling inside the dialog.
        if (e.key === 'Tab') {
          e.preventDefault();
          (document.activeElement === cancelBtn ? okBtn : cancelBtn).focus();
        }
      });
      okBtn.focus();
    });
  }

  /** Promise wrapper around chrome.runtime.sendMessage with friendly errors. */
  function send(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...(payload || {}) }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error('ImgFetch is starting up, please try again in a moment.'));
          return;
        }
        if (!res || res.ok !== true) {
          reject(new Error((res && res.error) || 'Something went wrong. Please try again.'));
          return;
        }
        resolve(res);
      });
    });
  }

  function formatBytes(n) {
    if (!n || n <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = n;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
      v /= 1024;
      u += 1;
    }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
  }

  function formatDims(w, h) {
    return w > 0 && h > 0 ? `${w} × ${h}` : 'Unknown size';
  }

  /**
   * History row size: the exact on-disk file size when known (measured at
   * download completion), otherwise the image dimensions, otherwise the
   * honest "Unknown size".
   */
  function formatHistorySize(r) {
    const b = r && Number(r.bytes);
    if (b > 0) return formatBytes(b);
    return '-';
  }

  function debounce(fn, ms) {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms || 200);
    };
  }

  window.ImgFetchUI = {
    applyTheme,
    watchSystemTheme,
    el,
    toast,
    confirmDialog,
    send,
    formatBytes,
    formatDims,
    formatHistorySize,
    debounce,
  };
})();

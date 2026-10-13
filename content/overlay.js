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
 * ImgFetch — content/overlay.js
 * Full-page area selector for screenshots. Exposes
 *   window.__imgfetch.selectArea() -> Promise<{x,y,width,height}|null>
 * Coordinates are in CSS pixels relative to the viewport.
 */
(() => {
  'use strict';

  function selectArea() {
    return new Promise((resolve) => {
      if (document.documentElement.hasAttribute('data-imgfetch-selecting')) {
        resolve(null);
        return;
      }
      document.documentElement.setAttribute('data-imgfetch-selecting', '1');

      const overlay = document.createElement('div');
      overlay.setAttribute('data-imgfetch-overlay', '1');
      const hint = document.createElement('div');
      hint.textContent = 'Drag to select: arrows move, Shift+arrows resize, Enter confirms, Esc cancels';
      const box = document.createElement('div');
      const style = document.createElement('style');
      style.textContent = `
        [data-imgfetch-overlay]{position:fixed;inset:0;z-index:2147483647;cursor:crosshair;
          background:rgba(10,12,25,.35);user-select:none;-webkit-user-select:none;touch-action:none}
        [data-imgfetch-overlay] .sx-hint{position:fixed;top:14px;left:50%;transform:translateX(-50%);
          background:#171a2e;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:8px 14px;
          border-radius:999px;box-shadow:0 4px 18px rgba(0,0,0,.35);pointer-events:none;white-space:nowrap}
        [data-imgfetch-overlay] .sx-box{position:absolute;border:2px solid #6c63ff;
          background:rgba(108,99,255,.12);box-shadow:0 0 0 9999px rgba(10,12,25,.35);display:none}
        [data-imgfetch-overlay] .sx-size{position:absolute;left:0;top:-26px;background:#171a2e;color:#fff;
          font:12px/1.4 system-ui,sans-serif;padding:3px 8px;border-radius:6px;white-space:nowrap}
      `;
      const size = document.createElement('div');
      size.className = 'sx-size';
      hint.className = 'sx-hint';
      box.className = 'sx-box';
      box.appendChild(size);
      overlay.appendChild(style);
      overlay.appendChild(hint);
      overlay.appendChild(box);
      document.documentElement.appendChild(overlay);

      let startX = 0;
      let startY = 0;
      let dragging = false;
      let finished = false;

      let onKeyArea = null; // L5: assigned below; removed in cleanup.
      const cleanup = () => {
        document.documentElement.removeAttribute('data-imgfetch-selecting');
        overlay.remove();
        window.removeEventListener('keydown', onKey, true);
        if (onKeyArea) window.removeEventListener('keydown', onKeyArea, true);
      };
      const finish = (rect) => {
        if (finished) return;
        finished = true;
        cleanup();
        // L3: wait two animation frames so the compositor paints the page
        // without the dim layer before the worker captures the screenshot.
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(rect)));
      };

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish(null);
        }
      };
      window.addEventListener('keydown', onKey, true);

      const paint = (x1, y1, x2, y2) => {
        const x = Math.min(x1, x2);
        const y = Math.min(y1, y2);
        const w = Math.abs(x2 - x1);
        const h = Math.abs(y2 - y1);
        box.style.display = 'block';
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
        box.style.width = `${w}px`;
        box.style.height = `${h}px`;
        size.textContent = `${Math.round(w)} × ${Math.round(h)}`;
      };

      // L5: Pointer Events unify mouse, touch and pen. setPointerCapture
      // keeps the drag alive when the pointer leaves the window;
      // pointercancel ends a stuck drag instead of leaving it hanging.
      overlay.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        try {
          overlay.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        paint(startX, startY, startX, startY);
        e.preventDefault();
      });
      overlay.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        paint(startX, startY, e.clientX, e.clientY);
      });
      const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        const x = Math.min(startX, e.clientX);
        const y = Math.min(startY, e.clientY);
        const w = Math.abs(e.clientX - startX);
        const h = Math.abs(e.clientY - startY);
        if (w < 8 || h < 8) {
          box.style.display = 'none';
          return; // too small — let the user try again
        }
        const dpr = window.devicePixelRatio || 1;
        finish({
          x: Math.round(x * dpr),
          y: Math.round(y * dpr),
          width: Math.round(w * dpr),
          height: Math.round(h * dpr),
        });
      };
      overlay.addEventListener('pointerup', endDrag);
      overlay.addEventListener('pointercancel', () => {
        dragging = false;
        box.style.display = 'none';
      });

      // L5: keyboard-only path. Arrow keys move a selection box (Shift resizes
      // it), Enter confirms, Escape cancels. The box starts centered.
      let kbBox = null;
      overlay.tabIndex = -1;
      overlay.focus();
      onKeyArea = (e) => {
        const k = e.key;
        if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        if (!kbBox) {
          const w = Math.min(480, window.innerWidth - 40);
          const h = Math.min(320, window.innerHeight - 40);
          kbBox = { x: (window.innerWidth - w) / 2, y: (window.innerHeight - h) / 2, w, h };
        }
        const step = 10;
        if (k === 'Enter') {
          const dpr = window.devicePixelRatio || 1;
          finish({
            x: Math.round(kbBox.x * dpr),
            y: Math.round(kbBox.y * dpr),
            width: Math.round(kbBox.w * dpr),
            height: Math.round(kbBox.h * dpr),
          });
          return;
        }
        if (e.shiftKey) {
          if (k === 'ArrowRight') kbBox.w = Math.max(8, kbBox.w + step);
          if (k === 'ArrowDown') kbBox.h = Math.max(8, kbBox.h + step);
          if (k === 'ArrowLeft') kbBox.w = Math.max(8, kbBox.w - step);
          if (k === 'ArrowUp') kbBox.h = Math.max(8, kbBox.h - step);
        } else {
          if (k === 'ArrowLeft') kbBox.x = Math.max(0, kbBox.x - step);
          if (k === 'ArrowRight') kbBox.x = Math.min(window.innerWidth - kbBox.w, kbBox.x + step);
          if (k === 'ArrowUp') kbBox.y = Math.max(0, kbBox.y - step);
          if (k === 'ArrowDown') kbBox.y = Math.min(window.innerHeight - kbBox.h, kbBox.y + step);
        }
        paint(kbBox.x, kbBox.y, kbBox.x + kbBox.w, kbBox.y + kbBox.h);
      };
      window.addEventListener('keydown', onKeyArea, true);
    });
  }

  window.__imgfetch = window.__imgfetch || {};
  window.__imgfetch.selectArea = selectArea;

  /**
   * Element picker: hover highlights the element under the cursor,
   * click captures it. Returns device-pixel rect or null on cancel.
   */
  function selectElement() {
    return new Promise((resolve) => {
      if (document.documentElement.hasAttribute('data-imgfetch-selecting')) {
        resolve(null);
        return;
      }
      document.documentElement.setAttribute('data-imgfetch-selecting', '1');

      const overlay = document.createElement('div');
      overlay.setAttribute('data-imgfetch-overlay', '1');
      const hint = document.createElement('div');
      hint.textContent = 'Click an element to capture it, Esc to cancel';
      hint.className = 'sx-hint';
      const box = document.createElement('div');
      box.className = 'sx-box';
      box.style.display = 'none';
      const style = document.createElement('style');
      style.textContent = `
        [data-imgfetch-overlay]{position:fixed;inset:0;z-index:2147483647;cursor:pointer;user-select:none;-webkit-user-select:none}
        [data-imgfetch-overlay] .sx-hint{position:fixed;top:14px;left:50%;transform:translateX(-50%);
          background:#171a2e;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:8px 14px;
          border-radius:999px;box-shadow:0 4px 18px rgba(0,0,0,.35);pointer-events:none;white-space:nowrap}
        [data-imgfetch-overlay] .sx-box{position:fixed;border:2px solid #6c63ff;
          background:rgba(108,99,255,.12);pointer-events:none;display:none}
      `;
      overlay.appendChild(style);
      overlay.appendChild(hint);
      overlay.appendChild(box);
      document.documentElement.appendChild(overlay);

      let finished = false;
      const cleanup = () => {
        document.documentElement.removeAttribute('data-imgfetch-selecting');
        overlay.remove();
        window.removeEventListener('keydown', onKey, true);
      };
      const finish = (rect) => {
        if (finished) return;
        finished = true;
        cleanup();
        // L3: wait two animation frames so the compositor paints the page
        // without the dim layer before the worker captures the screenshot.
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(rect)));
      };
      const onKey = (e) => {
        if (e.key === 'Escape') finish(null);
      };
      window.addEventListener('keydown', onKey, true);

      const pickUnder = (x, y) => {
        // The overlay covers the viewport, so elementFromPoint would always
        // return the overlay itself. Walk the stack and skip our own nodes.
        const els = document.elementsFromPoint(x, y);
        return els.find((n) => n !== overlay && !overlay.contains(n)) || null;
      };

      overlay.addEventListener('mousemove', (e) => {
        const el = pickUnder(e.clientX, e.clientY);
        if (!el) {
          box.style.display = 'none';
          return;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) {
          box.style.display = 'none';
          return;
        }
        box.style.display = 'block';
        box.style.left = `${r.left}px`;
        box.style.top = `${r.top}px`;
        box.style.width = `${r.width}px`;
        box.style.height = `${r.height}px`;
        box.title = el.tagName.toLowerCase();
      });
      overlay.addEventListener('click', (e) => {
        const el = pickUnder(e.clientX, e.clientY);
        if (!el) {
          finish(null);
          return;
        }
        const r = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // Clamp to the viewport (captureVisibleTab only sees the viewport).
        // L4: flag when the element is taller than the viewport so the
        // worker can tell the user part of it was cut.
        const clipped = r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw;
        const x = Math.max(0, Math.min(r.left, vw - 1));
        const y = Math.max(0, Math.min(r.top, vh - 1));
        const w = Math.max(1, Math.min(r.width, vw - x));
        const h = Math.max(1, Math.min(r.height, vh - y));
        finish({
          x: Math.round(x * dpr),
          y: Math.round(y * dpr),
          width: Math.round(w * dpr),
          height: Math.round(h * dpr),
          clipped,
        });
      });
    });
  }

  window.__imgfetch.selectElement = selectElement;

  /* ---------------------------------------------------------------- */
  /* Element image picker helpers (module scope so tests can use them) */
  /* ---------------------------------------------------------------- */

  const PICK_LAZY_ATTRS = [
    'data-src', 'data-original', 'data-lazy-src', 'data-srcset',
    'data-original-src', 'data-full-src', 'data-hi-res-src', 'data-large-src',
  ];

  /** Image-attribute descriptor for an <img> (same shape as copy-link's). */
  function describeImg(img) {
    const pic = img.closest('picture');
    const sourceSrcsets = [];
    if (pic) {
      for (const s of pic.querySelectorAll('source')) {
        const ss = s.getAttribute('srcset');
        if (ss) sourceSrcsets.push(ss);
      }
    }
    const lazy = {};
    for (const a of PICK_LAZY_ATTRS) {
      const v = img.getAttribute(a);
      if (v) lazy[a] = v;
    }
    return {
      currentSrc: img.currentSrc || '',
      srcAttr: img.getAttribute('src') || '',
      sourceSrcsets,
      lazy,
      naturalWidth: img.naturalWidth || 0,
      naturalHeight: img.naturalHeight || 0,
    };
  }

  /** Largest <img> inside a container (by rendered area). */
  function largestImg(root) {
    let best = null;
    let bestArea = 0;
    for (const im of root.querySelectorAll('img')) {
      try {
        const r = im.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea && (im.currentSrc || im.getAttribute('src'))) {
          bestArea = area;
          best = im;
        }
      } catch {
        /* ignore */
      }
    }
    return best;
  }

  /** First http(s) CSS background image on the element itself. */
  function backgroundUrlOf(el) {
    try {
      const bg = getComputedStyle(el).backgroundImage || '';
      const m = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(bg);
      const u = m && m[1].trim();
      if (u && !u.startsWith('data:')) {
        const abs = new URL(u, location.href);
        if (/^https?:$/.test(abs.protocol)) return abs.toString();
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /**
   * Resolve what was picked: { descriptor } | { backgroundUrl } |
   * { none: true }. Only image attributes are read — form controls are
   * never inspected for values.
   */
  function resolveImage(el) {
    if (!el) return { none: true };
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'img') return { descriptor: describeImg(el) };
    // Never read form controls' values — only look for images.
    if (/^(input|textarea|select|button)$/.test(tag)) return { none: true };
    const inner = largestImg(el);
    if (inner) return { descriptor: describeImg(inner) };
    const bg = backgroundUrlOf(el);
    if (bg) return { backgroundUrl: bg };
    return { none: true };
  }

  /**
   * Element image picker (Select Element shortcut): hover highlights the
   * element under the cursor, click resolves its image. Returns:
   *   { descriptor }     — for <img> (or the largest <img> inside a container)
   *   { backgroundUrl }  — for a CSS background image on the element
   *   { none: true }     — clicked element has no image
   *   null               — Esc / cancelled
   */
  function pickElement() {
    return new Promise((resolve) => {
      if (document.documentElement.hasAttribute('data-imgfetch-selecting')) {
        resolve(null);
        return;
      }
      document.documentElement.setAttribute('data-imgfetch-selecting', '1');

      const overlay = document.createElement('div');
      overlay.setAttribute('data-imgfetch-overlay', '1');
      const hint = document.createElement('div');
      hint.textContent = 'Click an element to inspect its image, Esc to cancel';
      hint.className = 'sx-hint';
      const box = document.createElement('div');
      box.className = 'sx-box';
      box.style.display = 'none';
      const style = document.createElement('style');
      style.textContent = `
        [data-imgfetch-overlay]{position:fixed;inset:0;z-index:2147483647;cursor:pointer;user-select:none;-webkit-user-select:none}
        [data-imgfetch-overlay] .sx-hint{position:fixed;top:14px;left:50%;transform:translateX(-50%);
          background:#171a2e;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:8px 14px;
          border-radius:999px;box-shadow:0 4px 18px rgba(0,0,0,.35);pointer-events:none;white-space:nowrap}
        [data-imgfetch-overlay] .sx-box{position:fixed;border:2px solid #6c63ff;
          background:rgba(108,99,255,.12);pointer-events:none;display:none}
      `;
      overlay.appendChild(style);
      overlay.appendChild(hint);
      overlay.appendChild(box);
      document.documentElement.appendChild(overlay);

      let finished = false;
      const cleanup = () => {
        document.documentElement.removeAttribute('data-imgfetch-selecting');
        overlay.remove();
        window.removeEventListener('keydown', onKey, true);
      };
      const finish = (value) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish(null);
        }
      };
      window.addEventListener('keydown', onKey, true);

      const pickUnder = (x, y) => {
        const els = document.elementsFromPoint(x, y);
        return els.find((n) => n !== overlay && !overlay.contains(n)) || null;
      };

      overlay.addEventListener('mousemove', (e) => {
        const el = pickUnder(e.clientX, e.clientY);
        if (!el) {
          box.style.display = 'none';
          return;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) {
          box.style.display = 'none';
          return;
        }
        box.style.display = 'block';
        box.style.left = `${r.left}px`;
        box.style.top = `${r.top}px`;
        box.style.width = `${r.width}px`;
        box.style.height = `${r.height}px`;
        box.title = el.tagName.toLowerCase();
      });
      // Let the page keep scrolling under the picker.
      overlay.addEventListener('wheel', (e) => {
        e.preventDefault();
        try {
          window.scrollBy(0, e.deltaY);
        } catch {
          /* ignore */
        }
      }, { passive: false });
      overlay.addEventListener('click', (e) => {
        finish(resolveImage(pickUnder(e.clientX, e.clientY)));
      });
    });
  }

  window.__imgfetch.pickElement = pickElement;
  // Exposed for unit tests (tests/test-overlay.mjs).
  window.__imgfetch.pickHelpers = { describeImg, largestImg, backgroundUrlOf, resolveImage };
})();

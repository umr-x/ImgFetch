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
 * ImgFetch — content/scanner.js
 * Runs in the page (ISOLATED world). Exposes window.__imgfetch:
 *   scanPage(options)        -> { images:[...], pageTitle, pageHost, pageUrl }
 *   findBestSource(srcUrl)   -> { url, width, height, confidence, kind }
 *   getImageInfo(srcUrl)     -> { ... } | null
 *
 * Classic script (not a module): content scripts injected via
 * chrome.scripting cannot use ES module imports, so the small helpers it
 * needs are intentionally duplicated here in page-safe form.
 */
(() => {
  'use strict';
  if (window.__imgfetch && window.__imgfetch.__v === 1) return;

  // L12: scanner discovery cap for data: URLs (2 MB). Scan results travel
  // through extension messaging — keep them small. The download path allows
  // more (DATA_URL_DOWNLOAD_MAX in core/urls.js); the limits differ by path.
  const SCAN_DATA_URL_MAX = 2_000_000;

  const LAZY_ATTRS = [
    'data-src', 'data-original', 'data-lazy-src', 'data-lazysrc',
    'data-srcset', 'data-image', 'data-full', 'data-full-src',
    'data-hi-res', 'data-large', 'data-large-src', 'data-zoom-image',
    'data-original-src', 'data-master', 'data-raw-src',
  ];
  const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif|bmp|svg|ico|tiff?)(\?|#|$)/i;

  function absUrl(raw, base) {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value || value.length > 8192) return null;
    try {
      const u = new URL(value, base || document.baseURI);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        if (u.username || u.password) return null;
        u.hash = '';
        return u.toString();
      }
      if (u.protocol === 'data:' && /^data:image\//i.test(value.slice(0, 64))) {
        // L12: scanner discovery cap (2 MB) — see DATA_URL_DOWNLOAD_MAX in
        // core/urls.js for why the download path allows more.
        return value.length > SCAN_DATA_URL_MAX ? null : value;
      }
      // blob: URLs are how GIF-heavy sites (Giphy, Tenor, editors) serve
      // media. They only resolve inside the page, so the service worker
      // converts them to data URLs (in-page) before downloading.
      if (u.protocol === 'blob:') return u.toString();
    } catch {
      /* ignore */
    }
    return null;
  }

  function parseSrcset(srcset) {
    const out = [];
    if (typeof srcset !== 'string') return out;
    for (const part of srcset.split(',')) {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      let kind = 'none';
      let value = 0;
      if (tokens[1]) {
        const m = /^(\d+(?:\.\d+)?)(w|x)$/.exec(tokens[1]);
        if (m) {
          kind = m[2];
          value = parseFloat(m[1]);
        }
      }
      out.push({ url: tokens[0], kind, value });
    }
    return out;
  }

  /** Largest entry of a srcset value (for lazy data-srcset fallbacks). */
  function bestOfSrcset(srcset) {
    let best = null;
    for (const entry of parseSrcset(srcset)) {
      const url = absUrl(entry.url);
      if (!url) continue;
      if (!best || (entry.kind === 'w' && entry.value > (best.value || 0))) {
        best = { url, kind: entry.kind, value: entry.value };
      }
    }
    return best ? best.url : null;
  }

  /** True when an <img> src is just a lazy placeholder, not the real image. */
  function isPlaceholderSrc(el, src) {
    if (!src) return true;
    if (src.startsWith('data:') && src.length < 2048) return true;
    if ((el.naturalWidth || 0) <= 2 && (el.loading === 'lazy' || LAZY_ATTRS.some((a) => el.hasAttribute(a)))) {
      return true;
    }
    return false;
  }

  /**
   * Evidence-backed candidate sources for one <img> element.
   * Returns [{ url, kind, hintW, hintH }]: the live currentSrc, the src
   * attribute, srcset entries ('w' descriptors carry genuine width
   * evidence as hintW), <picture>/<source> srcsets, and supported
   * lazy-load attributes. Inline data: URLs are skipped as alternates —
   * the record's own src already carries the current one, and shipping
   * megabyte data URLs per candidate would blow up extension messaging.
   * Nothing is invented: no URL-pattern guessing, every candidate comes
   * from the element itself. Never throws (scan wraps it anyway).
   */
  function candidatesForImg(img) {
    const out = [];
    const seen = new Set();
    const push = (rawUrl, kind, hintW, hintH) => {
      let url = null;
      try {
        url = absUrl(rawUrl);
      } catch {
        return;
      }
      if (!url || seen.has(url)) return;
      // data: alternates are inline already — the record src covers them.
      if (url.startsWith('data:')) return;
      seen.add(url);
      out.push({ url, kind, hintW: hintW || 0, hintH: hintH || 0 });
    };
    if (!img || typeof img.getAttribute !== 'function') return out;

    // 1) the live source the browser actually picked + the src attribute.
    try {
      const current = img.currentSrc || img.src || '';
      push(current, 'current');
      const srcAttr = img.getAttribute('src') || '';
      if (srcAttr && srcAttr !== current) push(srcAttr, 'src');
    } catch {
      /* ignore */
    }

    // 2) the img's own srcset + 3) <picture>/<source> srcsets.
    const pushSrcset = (value, kind) => {
      try {
        for (const entry of parseSrcset(value)) {
          if (entry.kind === 'w') push(entry.url, kind, Math.round(entry.value), 0);
          else push(entry.url, kind, 0, 0);
        }
      } catch {
        /* ignore malformed srcset */
      }
    };
    try {
      pushSrcset(img.getAttribute('srcset') || '', 'srcset');
      const parent = img.parentElement;
      if (parent && parent.tagName === 'PICTURE') {
        const sources = parent.querySelectorAll('source');
        for (const s of sources) {
          if (!s || typeof s.getAttribute !== 'function') continue;
          pushSrcset(s.getAttribute('srcset') || '', 'picture');
          const sSrc = s.getAttribute('src');
          if (sSrc) push(sSrc, 'picture');
        }
      }
    } catch {
      /* ignore */
    }

    // 4) lazy-load attributes — the real (often larger) URL hides here.
    try {
      for (const attr of LAZY_ATTRS) {
        const v = img.getAttribute(attr);
        if (!v) continue;
        if (attr === 'data-srcset') pushSrcset(v, 'lazy-srcset');
        else push(v, 'lazy');
      }
    } catch {
      /* ignore */
    }
    return out.slice(0, 24);
  }

  /**
   * Rank probed sources best-first by genuine measured area.
   * measured: [{ url, width, height }] — only images that actually loaded
   * (probe() returns null for failures/timeouts, so they never appear).
   * normalized: the current source URL — preferred on exact ties so a
   * byte-identical alternate doesn't cause a pointless re-download.
   * Never invents dimensions, never upscales: unmeasured URLs are simply
   * absent, and callers fall back to the current source.
   */
  function rankMeasured(measured, normalized) {
    const list = (Array.isArray(measured) ? measured : [])
      .filter((m) => m && typeof m.url === 'string'
        && Number.isFinite(m.width) && Number.isFinite(m.height)
        && m.width > 0 && m.height > 0)
      .map((m) => ({ url: m.url, width: m.width, height: m.height }));
    const seen = new Set();
    const uniq = [];
    for (const m of list) {
      if (seen.has(m.url)) continue;
      seen.add(m.url);
      uniq.push(m);
    }
    uniq.sort((a, b) => {
      const byArea = (b.width * b.height) - (a.width * a.height);
      if (byArea !== 0) return byArea;
      if (a.url === normalized) return -1;
      if (b.url === normalized) return 1;
      return 0;
    });
    // Format preservation (2026-10-12): a right-clicked GIF must stay a GIF —
    // Smart Download picks the best source IN THE CLICKED FORMAT, not a
    // "better" WebP. Same-format candidates keep their area order; other
    // formats follow as fallback when nothing same-format validated.
    const clickedExt = extOfUrl(normalized);
    if (clickedExt) {
      const same = [];
      const other = [];
      for (const m of uniq) {
        (extOfUrl(m.url) === clickedExt ? same : other).push(m);
      }
      if (same.length > 0) return [...same, ...other];
    }
    return uniq;
  }

  /** Extension of a URL's path (mirrors core/urls getExtensionFromUrl). */
  function extOfUrl(raw) {
    try {
      // All ranked URLs are absolute (via absUrl); no base needed, which
      // also keeps this working in non-DOM test harnesses.
      const u = new URL(String(raw || ''));
      const last = (u.pathname.split('/').pop() || '');
      const dot = last.lastIndexOf('.');
      if (dot > 0 && dot < last.length - 1) {
        const ext = last.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
        if (/^(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico)$/.test(ext)) {
          return ext === 'jpeg' ? 'jpg' : ext;
        }
      }
    } catch {
      /* ignore */
    }
    return '';
  }

  /** querySelectorAll that pierces open shadow roots (missed images often
   *  live inside web components). Closed shadow roots stay unreachable. */
  function queryAllDeep(selector) {
    const out = [];
    const visit = (root) => {
      const found = root.querySelectorAll(selector);
      for (let k = 0; k < found.length; k += 1) out.push(found[k]);
      const hosts = root.querySelectorAll('*');
      for (let k = 0; k < hosts.length; k += 1) {
        if (hosts[k].shadowRoot) visit(hosts[k].shadowRoot);
      }
    };
    visit(document);
    return out;
  }

  function extFromUrl(url) {
    if (!url) return '';
    if (url.startsWith('data:')) {
      const m = /^data:image\/([a-z0-9+.-]+)/i.exec(url);
      return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : '';
    }
    const m = IMAGE_EXT_RE.exec(url);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : '';
  }

  function filenameFromUrl(url) {
    if (!url || url.startsWith('data:')) return 'image';
    try {
      const path = new URL(url).pathname;
      const last = decodeURIComponent(path.split('/').pop() || '').split('?')[0];
      return last || 'image';
    } catch {
      return 'image';
    }
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  /* ---------------------------------------------------------------- */
  /* Relevance scoring: separate real content images from website UI   */
  /* chrome (logos, nav icons, buttons, pixels, favicons, sprites).   */
  /* Multi-signal — no single rule decides, nothing is site-specific, */
  /* SVGs and small images are never excluded as whole categories.    */
  /* ---------------------------------------------------------------- */

  // Set true while developing to log every dropped candidate and why.
  // Production keeps it off: only console.debug, never console.log.
  const SCAN_DEBUG = false;

  const UI_CLASS_RE = /(^|[-_])(icon|icons|sprite|sprites|logo|badge|badges|favicon|emoji|avatar)([-_]|$)/i;
  const UI_URL_RE = /(^|[/_?#.-])(icon|icons|sprite|sprites|logo|emoji|badge|badges|avatar|favicon)([/_?#.-]|$)/i;
  const TRACKING_URL_RE = /(^|[/_?#.-])(pixel|beacon|tracking|spacer|blank|1x1|clear\.gif|dot\.gif)([/_?#.-]|$)/i;
  const CONTENT_URL_RE = /(^|[/_?#.-])(photo|photos|image|images|img|media|upload|uploads|content|picture|pictures|full|large|original|hero|banner)([/_?#.-]|$)/i;
  const UI_CONTAINER_SEL = 'header,nav,footer,[role="banner"],[role="navigation"],[role="contentinfo"],[role="search"]';
  const CONTENT_CONTAINER_SEL = 'main,article,figure,[role="main"]';

  function uiClassHit(el) {
    // Tested separately: a trailing join space would break the $ anchor
    // (class="avatar" must match).
    try {
      const cls = el.getAttribute('class') || '';
      const id = el.getAttribute('id') || '';
      return UI_CLASS_RE.test(cls) || UI_CLASS_RE.test(id);
    } catch {
      return false;
    }
  }

  /**
   * Score a candidate. c: { el, kind, url, renderedW/H, naturalW/H, alt,
   * format }. kind: img|poster|background|input|object|svg|canvas|
   * meta-image|favicon. Returns { score, keep, reasons }.
   */
  function relevanceOf(c, occurrences) {
    const reasons = [];
    const dbg = (pts, why) => {
      if (SCAN_DEBUG) reasons.push(`${pts > 0 ? '+' : ''}${pts} ${why}`);
    };
    // The page's chosen representative image (og:image / twitter:image):
    // always meaningful, no layout info available.
    if (c.kind === 'meta-image') return { score: 3, keep: true, reasons: ['og-image'] };
    if (c.kind === 'favicon') return { score: -100, keep: false, reasons: ['favicon'] };
    if (c.kind === 'input') return { score: -100, keep: false, reasons: ['form-button'] };

    const rw = c.renderedW || 0;
    const rh = c.renderedH || 0;
    const longest = Math.max(rw, rh);
    const nLongest = Math.max(c.naturalW || 0, c.naturalH || 0);
    const url = c.url || '';

    // --- hard excludes ---
    // A 0x0 box is only "invisible" when the image isn't a pending lazy
    // load — dimension-less lazy <img> tags are "unknown size", not hidden.
    if (c.el && longest <= 0 && !c.fromLazy) {
      return { score: -100, keep: false, reasons: ['invisible'] };
    }
    if (c.el) {
      try {
        const cs = getComputedStyle(c.el);
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0)) {
          return { score: -100, keep: false, reasons: ['hidden-style'] };
        }
      } catch {
        /* ignore */
      }
    }
    // Tracking pixels: tiny on screen AND tiny in bytes (never a lazy load).
    if (!c.fromLazy && longest <= 8 && nLongest <= 8) {
      return { score: -100, keep: false, reasons: ['tracking-pixel'] };
    }

    let s = 0;
    const add = (pts, why) => {
      s += pts;
      dbg(pts, why);
    };

    // Suspicious URL ≠ verdict on its own (a blog post about "order
    // tracking" is legit) — a strong penalty, not a hard exclude.
    if (TRACKING_URL_RE.test(url)) add(-4, 'tracking-url');

    // --- size signals (bands, not a single cutoff) ---
    // An unmeasured lazy image scores 0 here (unknown size, not tiny).
    if (longest <= 0 && c.fromLazy) dbg(0, 'lazy-unmeasured');
    else if (longest >= 300) add(4, 'rendered>=300');
    else if (longest >= 150) add(3, 'rendered>=150');
    else if (longest >= 80) add(2, 'rendered>=80');
    else if (longest >= 40) add(1, 'rendered>=40');
    else if (longest >= 24) add(-1, 'rendered<40');
    else add(-3, 'rendered<24');

    if (nLongest >= 600) add(2, 'natural>=600');
    else if (nLongest >= 300) add(1, 'natural>=300');

    // Inline SVG: tiny ones are UI icons, large ones are legit artwork —
    // never exclude the whole category.
    if (c.kind === 'svg') {
      if (longest <= 48) add(-6, 'tiny-inline-svg');
      else add(1, 'large-inline-svg');
    } else if (c.format === 'svg' && longest <= 48) {
      add(-4, 'tiny-svg-file');
    }

    // --- DOM context signals ---
    if (c.el) {
      try {
        if (c.el.closest(UI_CONTAINER_SEL)) add(-3, 'ui-container');
        if (c.el.closest(CONTENT_CONTAINER_SEL)) add(2, 'content-container');
        if (c.el.closest('button')) add(-3, 'inside-button');
        if (uiClassHit(c.el)) add(-3, 'ui-class');
      } catch {
        /* ignore */
      }
    }

    // --- content signals ---
    if (c.alt && c.alt.trim().length > 2) add(1, 'has-alt');
    if (CONTENT_URL_RE.test(url)) add(1, 'content-url');
    if (UI_URL_RE.test(url)) add(-2, 'ui-url');

    // --- repetition: the same asset stamped across the page is UI chrome ---
    const occ = occurrences.get(url.toLowerCase()) || 1;
    if (occ >= 6) add(-4, `repeated-x${occ}`);
    else if (occ >= 3) add(-2, `repeated-x${occ}`);

    return { score: s, keep: s >= 0, reasons };
  }

  /** Load a URL as an image to measure it. Never throws. */
  const lastProbeByHost = new Map();
  const PROBE_HOST_GAP_MS = 150; // M4: per-host throttle — don't hammer one server
  function probe(url, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), timeoutMs || 5000);
      const run = () => {
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        img.onload = () => finish(
          img.naturalWidth > 0
            ? { url, width: img.naturalWidth, height: img.naturalHeight }
            : null,
        );
        img.onerror = () => finish(null);
        img.src = url;
      };
      try {
        const host = new URL(url).hostname;
        const last = lastProbeByHost.get(host) || 0;
        const wait = PROBE_HOST_GAP_MS - (Date.now() - last);
        lastProbeByHost.set(host, Date.now() + Math.max(0, wait));
        if (wait > 0) {
          setTimeout(run, wait);
        } else {
          run();
        }
      } catch {
        run();
      }
    });
  }

  async function probeAll(urls, concurrency, timeoutMs) {
    const results = [];
    const list = [...new Set(urls)];
    for (let i = 0; i < list.length; i += concurrency) {
      const batch = await Promise.all(
        list.slice(i, i + concurrency).map((u) => probe(u, timeoutMs)),
      );
      for (const r of batch) if (r) results.push(r);
    }
    return results;
  }

  async function findBestSource(srcUrl, opts) {
    const wantOriginal = opts && opts.original === true;
    const normalized = absUrl(srcUrl);
    if (!normalized) return null;

    let img = null;
    for (const el of document.images) {
      const cur = absUrl(el.currentSrc || el.src);
      if (cur === normalized) {
        img = el;
        break;
      }
    }

    let candidates = [];
    if (img) {
      candidates = candidatesForImg(img);
    } else {
      // M4: no URL-pattern guessing without evidence — probe the
      // current source only when the element itself wasn't found.
      candidates = [{ url: normalized, kind: 'current', hintW: 0, hintH: 0 }];
    }

    // Order probes: srcset 'w' descriptors largest-first so validation
    // budget is spent on the most promising candidates.
    candidates.sort((a, b) => (b.hintW || 0) - (a.hintW || 0));
    const toProbe = candidates.slice(0, 12).map((c) => c.url);
    const measured = await probeAll(toProbe, 6, 4000);
    const measuredByUrl = new Map(measured.map((m) => [m.url, m]));

    const ranked = rankMeasured(measured, normalized);
    const currentMeasured = measuredByUrl.get(normalized);

    if (wantOriginal) {
      const best = ranked[0];
      if (best) {
        return {
          url: best.url,
          width: best.width,
          height: best.height,
          confidence: 'high',
          validated: true,
          kind: 'original',
        };
      }
      return {
        url: normalized,
        width: currentMeasured ? currentMeasured.width : 0,
        height: currentMeasured ? currentMeasured.height : 0,
        confidence: 'low',
        validated: !!currentMeasured,
        kind: 'original-fallback',
      };
    }

    const best = ranked[0];
    if (!best) {
      return {
        url: normalized, width: 0, height: 0, confidence: 'low', validated: false, kind: 'current',
      };
    }
    let confidence = 'high';
    if (currentMeasured && best.width * best.height < currentMeasured.width * currentMeasured.height) {
      confidence = 'medium';
    } else if (best.url !== normalized && !measuredByUrl.has(best.url)) {
      confidence = 'medium';
    }
    return {
      url: best.url,
      width: best.width,
      height: best.height,
      confidence,
      validated: true,
      kind: 'best',
    };
  }

  /**
   * Ranked, validated sources for a URL — the Smart Download engine's input.
   * Returns [{ url, width, height }] best-first. Only genuinely loadable
   * images are returned; nothing is guessed from URL patterns alone.
   */
  /**
   * M4: ranked, validated sources. Accepts scan-time candidates (computed
   * in one in-page pass during scanPage) so downloads don't need a second
   * in-page discovery round-trip. Only evidence-based candidates are
   * probed — never guessed URL patterns.
   */
  async function findRankedSources(srcUrl, precomputed) {
    const normalized = absUrl(srcUrl);
    if (!normalized) return [];
    let candidates;
    if (Array.isArray(precomputed) && precomputed.length) {
      candidates = precomputed
        .map((c) => ({ url: absUrl(c.u), kind: c.k || 'scan', hintW: c.w || 0, hintH: 0 }))
        .filter((c) => c.url);
      if (!candidates.some((c) => c.url === normalized)) {
        candidates.unshift({ url: normalized, kind: 'current', hintW: 0, hintH: 0 });
      }
    } else {
      let img = null;
      for (const el of document.images) {
        if (absUrl(el.currentSrc || el.src) === normalized) {
          img = el;
          break;
        }
      }
      if (img) {
        candidates = candidatesForImg(img);
      } else {
        // M4: no URL-pattern guessing without evidence — probe the
        // current source only when the element itself wasn't found.
        candidates = [{ url: normalized, kind: 'current', hintW: 0, hintH: 0 }];
      }
    }
    candidates.sort((a, b) => (b.hintW || 0) - (a.hintW || 0));
    const toProbe = candidates.slice(0, 8).map((c) => c.url);
    const measured = await probeAll(toProbe, 6, 4000);
    return rankMeasured(measured, normalized).map((m) => ({
      url: m.url,
      width: m.width,
      height: m.height,
    }));
  }

  /** Page geometry for full-page screenshots. */
  function getPageMetrics() {
    const de = document.documentElement;
    const body = document.body;
    return {
      scrollWidth: Math.max(de.scrollWidth || 0, body ? body.scrollWidth || 0 : 0),
      scrollHeight: Math.max(de.scrollHeight || 0, body ? body.scrollHeight || 0 : 0),
      viewportW: window.innerWidth || 0,
      viewportH: window.innerHeight || 0,
      dpr: window.devicePixelRatio || 1,
      scrollX: window.scrollX || 0,
      scrollY: window.scrollY || 0,
    };
  }

  function getImageInfo(srcUrl) {
    const normalized = absUrl(srcUrl);
    if (!normalized) return null;
    for (const el of queryAllDeep('img')) {
      const cur = absUrl(el.currentSrc || el.src);
      if (cur === normalized) {
        const r = el.getBoundingClientRect();
        return {
          url: normalized,
          width: el.naturalWidth || Math.round(r.width),
          height: el.naturalHeight || Math.round(r.height),
          renderedWidth: Math.round(r.width),
          renderedHeight: Math.round(r.height),
          format: extFromUrl(normalized),
          alt: el.getAttribute('alt') || '',
          title: el.getAttribute('title') || '',
          filename: filenameFromUrl(normalized),
        };
      }
    }
    return {
      url: normalized,
      width: 0,
      height: 0,
      format: extFromUrl(normalized),
      alt: '',
      filename: filenameFromUrl(normalized),
    };
  }

  const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

  /**
   * Scan the page for images. Chunked so large pages stay responsive.
   * options: { includeBackgrounds, minLongest }
   */
  async function scanPage(options) {
    const opts = options || {};
    const includeBackgrounds = opts.includeBackgrounds !== false;
    const minLongest = Number(opts.minLongest) || 0;
    const images = [];
    const seen = new Set();
    const raw = []; // phase 1: unscored candidates { record, el, kind, naturalW, naturalH }
    let order = 0;
    let droppedBySize = 0;
    let droppedByRelevance = 0;

    const emit = (done, total) => {
      try {
        chrome.runtime.sendMessage({ type: 'SCAN_PROGRESS', done, total });
      } catch {
        /* popup may be closed */
      }
    };

    // Phase 1: collect every candidate with its element for scoring.
    // Exact-URL dedup happens here (src+srcset+lazy of one element).
    const collectRaw = (record, el, kind, naturalW, naturalH, fromLazy) => {
      const key = (record.src || '').toLowerCase();
      if (!key || seen.has(key)) return;
      // Extremely large inline data-URL images would blow up session storage
      // and thumbnails; skip them (documented limitation).
      if (key.startsWith('data:') && key.length > 500_000) return;
      seen.add(key);
      raw.push({
        record, el: el || null, kind,
        naturalW: naturalW || 0, naturalH: naturalH || 0,
        fromLazy: !!fromLazy, key,
      });
    };

    // Phase 2: the actual results list (after relevance scoring below).
    const pushImage = (record) => {
      const longest = Math.max(record.width || 0, record.height || 0);
      if (minLongest > 0 && longest > 0 && longest < minLongest) {
        droppedBySize += 1;
        return;
      }
      record.id = `img-${order}`;
      record.order = order;
      record.foundAt = Date.now();
      order += 1;
      images.push(record);
    };

    const pageUrl = location.href;
    let pageHost = '';
    try {
      pageHost = new URL(pageUrl).hostname;
    } catch {
      /* ignore */
    }
    const pageTitle = document.title || '';

    // 1) <img> elements (including open shadow DOM)
    const imgs = queryAllDeep('img');
    for (let i = 0; i < imgs.length; i += 100) {
      for (const el of imgs.slice(i, i + 100)) {
        try {
          let src = absUrl(el.currentSrc || el.src);
          // Lazy-loaded images often have an empty/tiny placeholder src with
          // the real URL in a data-* attribute — fall back to it so GIF
          // grids are found even before they scroll into view.
          let fromLazy = false;
          if (!src || isPlaceholderSrc(el, src)) {
            for (const attr of LAZY_ATTRS) {
              const v = el.getAttribute(attr);
              if (!v) continue;
              const cand = attr === 'data-srcset'
                ? bestOfSrcset(v)
                : absUrl(v);
              if (cand && !isPlaceholderSrc(el, cand)) {
                src = cand;
                fromLazy = true;
                break;
              }
            }
          }
          if (!src) continue;
          const r = el.getBoundingClientRect();
          // M4: evidence-based candidates (srcset, <picture>, data-* lazy
          // attrs) computed once here, in the scan's single in-page pass —
          // downloads reuse them instead of re-discovering per image.
          let scanCands = null;
          try {
            scanCands = candidatesForImg(el)
              .slice(0, 8)
              .map((c) => ({ u: c.url, k: c.kind, w: c.hintW || 0 }));
          } catch {
            scanCands = null;
          }
          collectRaw({
            src,
            width: el.naturalWidth || Math.round(r.width) || 0,
            height: el.naturalHeight || Math.round(r.height) || 0,
            renderedWidth: Math.round(r.width) || 0,
            renderedHeight: Math.round(r.height) || 0,
            format: extFromUrl(src),
            alt: (el.getAttribute('alt') || '').slice(0, 200),
            title: (el.getAttribute('title') || '').slice(0, 200),
            filename: filenameFromUrl(src),
            isBackground: false,
            candidates: scanCands,
          }, el, 'img', el.naturalWidth || 0, el.naturalHeight || 0, fromLazy);
        } catch {
          /* skip bad element */
        }
      }
      emit(raw.length, imgs.length);
      // eslint-disable-next-line no-await-in-loop
      await yieldToUI();
    }

    // 1b) <video> posters — GIF-heavy sites (Giphy, Tenor) serve animated
    // cards as <video>; the poster is the downloadable still/GIF preview.
    const videos = queryAllDeep('video');
    for (const el of videos) {
      try {
        const poster = absUrl(el.getAttribute('poster'));
        if (!poster) continue;
        const r = el.getBoundingClientRect();
        collectRaw({
          src: poster,
          width: el.videoWidth || Math.round(r.width) || 0,
          height: el.videoHeight || Math.round(r.height) || 0,
          renderedWidth: Math.round(r.width) || 0,
          renderedHeight: Math.round(r.height) || 0,
          format: extFromUrl(poster),
          alt: (el.getAttribute('aria-label') || '').slice(0, 200),
          title: '',
          filename: filenameFromUrl(poster),
          isBackground: false,
          isPoster: true,
        }, el, 'poster', el.videoWidth || 0, el.videoHeight || 0);
      } catch {
        /* skip bad element */
      }
    }

    // 2) CSS background images (chunked, capped for very large pages)
    if (includeBackgrounds) {
      const all = queryAllDeep('*');
      const total = Math.min(all.length, 20000);
      const bgUrlRe = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
      for (let i = 0; i < total; i += 400) {
        for (let j = i; j < Math.min(i + 400, total); j += 1) {
          const el = all[j];
          if (el instanceof HTMLImageElement) continue;
          let bg = '';
          try {
            if (!isVisible(el)) continue;
            bg = getComputedStyle(el).backgroundImage || '';
          } catch {
            continue;
          }
          if (!bg || bg === 'none' || bg.indexOf('url(') === -1) continue;
          let m;
          bgUrlRe.lastIndex = 0;
          const pushBg = (raw, isPseudo) => {
            const r2 = (raw || '').trim();
            if (!r2 || r2.startsWith('data:')) return;
            const url = absUrl(r2);
            if (!url) return;
            const r = el.getBoundingClientRect();
            collectRaw({
              src: url,
              width: Math.round(r.width) || 0,
              height: Math.round(r.height) || 0,
              renderedWidth: Math.round(r.width) || 0,
              renderedHeight: Math.round(r.height) || 0,
              format: extFromUrl(url),
              alt: '',
              title: '',
              filename: filenameFromUrl(url),
              isBackground: true,
              isPseudo: !!isPseudo,
            }, el, 'background', 0, 0);
          };
          while ((m = bgUrlRe.exec(bg)) !== null) pushBg(m[2], false);
          // M5: pseudo-element backgrounds (::before / ::after).
          for (const pseudo of ['::before', '::after']) {
            let pbg = '';
            try {
              pbg = getComputedStyle(el, pseudo).backgroundImage || '';
            } catch {
              continue;
            }
            if (!pbg || pbg === 'none' || pbg.indexOf('url(') === -1) continue;
            bgUrlRe.lastIndex = 0;
            let pm;
            while ((pm = bgUrlRe.exec(pbg)) !== null) pushBg(pm[2], true);
          }
        }
        emit(raw.length, total);
        // eslint-disable-next-line no-await-in-loop
        await yieldToUI();
      }
    }

    // 3) Extra sources (M5) — each cheap, clearly labeled, best-effort.
    // 3a) Meta images: og:image / twitter:image (the page's own chosen
    // representative image — meaningful) and favicons (UI chrome, filtered
    // out by relevance scoring). Main frame only.
    if (window === window.top) {
      try {
        const metaHits = [];
        for (const sel of [
          'meta[property="og:image"]',
          'meta[property="og:image:secure_url"]',
          'meta[name="twitter:image"]',
        ]) {
          const el = document.querySelector(sel);
          const c = el && el.getAttribute('content');
          if (c) metaHits.push({ raw: c, kind: 'meta-image' });
        }
        for (const rel of ['icon', 'apple-touch-icon']) {
          const el = document.querySelector(`link[rel="${rel}"]`);
          const h = el && el.getAttribute('href');
          if (h) metaHits.push({ raw: h, kind: 'favicon' });
        }
        for (const hit of metaHits) {
          const url = absUrl(hit.raw);
          if (!url) continue;
          collectRaw({
            src: url,
            width: 0,
            height: 0,
            renderedWidth: 0,
            renderedHeight: 0,
            format: extFromUrl(url),
            alt: '',
            title: '',
            filename: filenameFromUrl(url),
            isBackground: false,
            isMeta: true,
          }, null, hit.kind, 0, 0);
        }
      } catch {
        /* best-effort */
      }
    }

    // 3b) <input type="image"> — a graphical submit button (UI chrome).
    for (const el of queryAllDeep('input[type="image"]')) {
      try {
        const url = absUrl(el.getAttribute('src'));
        if (!url) continue;
        const r = el.getBoundingClientRect();
        collectRaw({
          src: url,
          width: Math.round(r.width) || 0,
          height: Math.round(r.height) || 0,
          renderedWidth: Math.round(r.width) || 0,
          renderedHeight: Math.round(r.height) || 0,
          format: extFromUrl(url),
          alt: (el.getAttribute('alt') || '').slice(0, 200),
          title: '',
          filename: filenameFromUrl(url),
          isBackground: false,
          isInput: true,
        }, el, 'input', 0, 0);
      } catch {
        /* skip */
      }
    }

    // 3c) Inline <svg>: serialize to a data URL so it can be saved/converted.
    // Tiny ones are UI icons — relevance scoring drops them, large artwork stays.
    for (const el of queryAllDeep('svg')) {
      try {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const markup = new XMLSerializer().serializeToString(el);
        if (!markup || markup.length > 2_000_000) continue;
        collectRaw({
          src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`,
          width: Math.round(r.width) || 0,
          height: Math.round(r.height) || 0,
          renderedWidth: Math.round(r.width) || 0,
          renderedHeight: Math.round(r.height) || 0,
          format: 'svg',
          alt: '',
          title: '',
          filename: 'inline-svg.svg',
          isBackground: false,
          isInlineSvg: true,
        }, el, 'svg', 0, 0);
      } catch {
        /* skip */
      }
    }

    // 3d) <canvas>: snapshot (tainted canvases throw and are skipped).
    for (const el of queryAllDeep('canvas')) {
      try {
        if (el.width < 2 || el.height < 2 || el.width > 4096 || el.height > 4096) continue;
        const url = el.toDataURL('image/png');
        if (!url || url.length < 100 || url.length > 10_000_000) continue;
        collectRaw({
          src: url,
          width: el.width,
          height: el.height,
          renderedWidth: el.width,
          renderedHeight: el.height,
          format: 'png',
          alt: '',
          title: '',
          filename: 'canvas.png',
          isBackground: false,
          isCanvas: true,
        }, el, 'canvas', 0, 0);
      } catch {
        /* tainted or empty */
      }
    }

    // 3e) <object>/<embed> with image-ish data.
    for (const el of queryAllDeep('object,embed')) {
      try {
        const raw = el.getAttribute('data') || el.getAttribute('src') || '';
        const url = absUrl(raw);
        if (!url || !/\.(svg|png|jpe?g|gif|webp|bmp)(\?|#|$)/i.test(url)) continue;
        const r = el.getBoundingClientRect();
        collectRaw({
          src: url,
          width: Math.round(r.width) || 0,
          height: Math.round(r.height) || 0,
          renderedWidth: Math.round(r.width) || 0,
          renderedHeight: Math.round(r.height) || 0,
          format: extFromUrl(url),
          alt: '',
          title: '',
          filename: filenameFromUrl(url),
          isBackground: false,
          isObject: true,
        }, el, 'object', 0, 0);
      } catch {
        /* skip */
      }
    }

    // Phase 2: relevance scoring. The same asset stamped across the page
    // (nav icons, logos) is UI chrome — count occurrences first so the
    // repetition signal sees the whole page.
    const occurrences = new Map();
    for (const c of raw) occurrences.set(c.key, (occurrences.get(c.key) || 0) + 1);
    for (const c of raw) {
      const r = relevanceOf(
        {
          el: c.el,
          kind: c.kind,
          url: c.record.src,
          renderedW: c.record.renderedWidth || 0,
          renderedH: c.record.renderedHeight || 0,
          naturalW: c.naturalW,
          naturalH: c.naturalH,
          alt: c.record.alt || '',
          format: c.record.format || '',
          fromLazy: c.fromLazy,
        },
        occurrences,
      );
      if (SCAN_DEBUG && !r.keep) {
        console.debug(`[imgfetch:scan] dropped (score ${r.score}): ${c.record.src}, ${r.reasons.join(', ')}`);
      }
      if (!r.keep) {
        droppedByRelevance += 1;
        continue;
      }
      c.record.relevance = r.score;
      pushImage(c.record);
    }
    if (SCAN_DEBUG) {
      console.debug(`[imgfetch:scan] ${images.length} kept, ${droppedByRelevance} UI assets filtered, ${droppedBySize} dropped by size filter`);
    }

    return { images, pageTitle, pageHost, pageUrl, count: images.length, droppedBySize, droppedByRelevance };
  }

  /**
   * H2: hide position:fixed elements (sticky headers, cookie banners) so
   * they don't repeat in every full-page tile. display:none on fixed
   * elements never reflows the page (they're out of flow), so tile math
   * stays valid. Restored after capture.
   */
  let fixedHidden = [];
  function setFixedHidden(hide) {
    if (hide) {
      fixedHidden = [];
      const els = document.querySelectorAll('*');
      const cap = Math.min(els.length, 20000);
      for (let i = 0; i < cap; i++) {
        const el = els[i];
        let pos = '';
        try {
          pos = getComputedStyle(el).position;
        } catch {
          pos = '';
        }
        if (pos === 'fixed') {
          fixedHidden.push([el, el.style.display]);
          el.style.display = 'none';
        }
      }
      return fixedHidden.length;
    }
    for (const [el, disp] of fixedHidden) {
      try {
        el.style.display = disp;
      } catch {
        /* element gone */
      }
    }
    fixedHidden = [];
    return 0;
  }

  window.__imgfetch = {
    __v: 1,
    scanPage,
    findBestSource,
    findRankedSources,
    getPageMetrics,
    getImageInfo,
    setFixedHidden,
    relevanceOf, // exposed for unit tests (tests/test-scanner.mjs)
    candidatesForImg, // exposed for unit tests (tests/test-candidates.mjs)
    rankMeasured, // exposed for unit tests (tests/test-candidates.mjs)
  };
})();

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
 * ImgFetch, popup/popup.js
 * Popup controller: scan results, filters, preview, queue and history.
 * Module script: imports pure core helpers directly.
 */
import {
  applyFilters,
  matchesQuery,
  sortImages,
  sizeChipForPreset,
  orientationOf,
  formatGroup,
  longestSide,
} from '../core/filters.js';
import { groupByDay } from '../core/history.js';

const UI = window.ImgFetchUI;
const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  scan: null,          // { images, url, title, at }
  visible: [],         // filtered+sorted images
  selected: new Set(),
  filters: { size: 'any', formats: [], orientations: [], query: '', sort: 'order' },
  quality: 'smart',    // 'smart' | 'normal'
  avifOk: null,       // M12: null = unknown (assume supported), false = hide AVIF UI
  gridShown: 0,       // M11: how many grid items are currently rendered (windowed)
  view: 'home',        // 'home' | 'history'
  pane: 'idle',        // home sub-view: 'idle' | 'scanning' | 'results' | 'queue'
};

/* ------------------------------------------------------------------ */
/* Page blob: thumbnails, blob: URLs only resolve inside the page, so the */
/* popup asks the service worker to fetch a preview in-page.               */
/* ------------------------------------------------------------------ */

const blobPreviewCache = new Map(); // blob: URL -> data URL
const blobPreviewPending = new Set();
const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * Assign an <img> source for a scan record. Page blob: URLs can't load in
 * the popup origin, so they resolve lazily (with a blank placeholder and
 * a shimmer class until the preview arrives). `full` resolves the original
 * bytes (preview modal); otherwise a light JPEG thumbnail is used.
 */
function setThumbSource(imgEl, img, full) {
  const src = img.src || '';
  if (!src.startsWith('blob:')) {
    imgEl.src = src;
    return;
  }
  imgEl.dataset.blobSrc = src;
  imgEl.dataset.blobMode = full ? 'full' : 'thumb';
  const cached = blobPreviewCache.get(src + (full ? '#full' : '#thumb'));
  if (cached) {
    imgEl.src = cached;
    return;
  }
  imgEl.src = BLANK_IMG;
  imgEl.classList.add('thumb-loading');
  const key = src + (full ? '#full' : '#thumb');
  if (blobPreviewPending.has(key)) return;
  blobPreviewPending.add(key);
  // B6: cap concurrent thumbnail resolutions, hundreds of results used to
  // fire one RESOLVE_BLOB message each, all at once.
  const tabId = state.scan && state.scan.tabId;
  enqueueBlobResolve(key, src, full, tabId);
}

/**
 * B6: bounded-concurrency queue for blob: thumbnail resolutions.
 * At most BLOB_RESOLVE_CONCURRENCY in flight; the rest wait their turn.
 */
const BLOB_RESOLVE_CONCURRENCY = 6;
let blobResolveActive = 0;
const blobResolveQueue = [];

function enqueueBlobResolve(key, src, full, tabId) {
  blobResolveQueue.push({ key, src, full, tabId });
  pumpBlobResolves();
}

function pumpBlobResolves() {
  while (blobResolveActive < BLOB_RESOLVE_CONCURRENCY && blobResolveQueue.length) {
    const job = blobResolveQueue.shift();
    blobResolveActive += 1;
    resolveOneBlob(job).finally(() => {
      blobResolveActive -= 1;
      pumpBlobResolves();
    });
  }
}

async function resolveOneBlob({ key, src, full, tabId }) {
  try {
    const res = await UI.send('RESOLVE_BLOB', {
      url: src,
      tabId: String(tabId == null ? '' : tabId),
      mode: full ? 'full' : 'thumb',
    });
    if (res && res.dataUrl) {
      blobPreviewCache.set(key, res.dataUrl);
      const wantMode = full ? 'full' : 'thumb';
      document.querySelectorAll('img[data-blob-src]').forEach((el) => {
        if (el.dataset.blobSrc === src && el.dataset.blobMode === wantMode) {
          el.src = res.dataUrl;
          el.classList.remove('thumb-loading');
        }
      });
    }
  } catch {
    /* thumbnail stays in shimmer state; the full image still downloads */
  } finally {
    blobPreviewPending.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  try {
    const { settings } = await UI.send('GET_SETTINGS');
    state.settings = settings;
    UI.applyTheme(settings.theme);
    UI.watchSystemTheme(() => state.settings.theme);
    // M12: hide AVIF options when the browser can't encode it.
    try {
      const { avif } = await UI.send('GET_FORMAT_SUPPORT');
      state.avifOk = !!avif;
    } catch {
      state.avifOk = false;
    }
    const avifOpt = document.querySelector('#dlFormat option[value="avif"]');
    if (avifOpt && !state.avifOk) {
      avifOpt.disabled = true;
      avifOpt.textContent = 'AVIF (not supported)';
    }
    // H1: results size filter starts from the user's scan setting.
    const chip = sizeChipForPreset(settings.minSizePreset);
    state.filters.size = chip;
    document.querySelectorAll('[data-size]').forEach((c) =>
      c.setAttribute('aria-pressed', String(c.getAttribute('data-size') === chip)));
  } catch {
    UI.applyTheme('system');
  }

  wireNav();
  wireHome();
  wireResults();
  wireQueue();
  wireHistory();

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  // The last scan and any running downloads are preserved, never lost.
  // A scan started by the global shortcut while the popup was closed is
  // picked up here: land on the live SCANNING pane, or show fresh RESULTS
  // directly. The user never presses Scan again for a scan that ran.
  try {
    const { scan } = await UI.send('GET_LAST_SCAN');
    if (scan && scan.images) state.scan = scan;
  } catch { /* no stored scan; continue without it */ }
  try {
    const { state: scanState, forCurrentTab } = await UI.send('GET_SCAN_STATE');
    if (scanState && forCurrentTab) {
      if (scanState.status === 'scanning') {
        applyRoute({ view: 'home', pane: 'idle' });
        renderHomeStatus();
        navigate('home', 'scanning');
        updateScanProgress(0, 1);
        return;
      }
      if (scanState.status === 'results' && state.scan && state.scan.images) {
        applyRoute({ view: 'home', pane: 'idle' });
        renderHomeStatus();
        showScan(state.scan, true);
        return;
      }
    }
  } catch { /* scan state unavailable; fall through to dashboard */ }
  applyRoute({ view: 'home', pane: 'idle' });
  renderHomeStatus();
  // If downloads are in flight when the popup opens, land on the queue pane
  // so the progress bar is visible immediately (not hidden on the dashboard).
  try {
    const { snapshot } = await UI.send('GET_QUEUE');
    if (snapshot && (snapshot.active > 0 || snapshot.pending > 0)) {
      navigate('home', 'queue');
    }
  } catch { /* queue unavailable; stay on dashboard */ }
}

function onRuntimeMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'SCAN_PROGRESS':
      // A scan started by the global shortcut while this popup sat on its
      // dashboard: follow it live instead of waiting for another click.
      if (state.view === 'home' && state.pane === 'idle') navigate('home', 'scanning');
      updateScanProgress(msg.done, msg.total);
      break;
    case 'SCAN_DONE':
      if (msg.scan) showScan(msg.scan, true);
      break;
    case 'QUEUE_UPDATE':
      if (msg.snapshot) {
        renderQueue(msg.snapshot);
        renderHomeStatus(msg.snapshot);
        maybeAutoCollapseQueue(msg.snapshot);
      }
      break;
    case 'NOTICE_TEXT':
      UI.toast(msg.text);
      break;
    case 'NOTICE':
      if (msg.detail) UI.toast(msg.detail);
      else if (msg.code) UI.toast(friendlyNotice(msg.code));
      break;
    default:
      break;
  }
}

function friendlyNotice(code) {
  const map = {
    queued: 'Added to the ImgFetch download queue.',
    copied: 'Copied to clipboard.',
    'copy-failed': 'Could not copy. Please try again.',
    'disabled-site': 'ImgFetch is paused on this site.',
    'convert-failed': 'Could not convert, the original was saved instead.',
    'original-unknown': 'Original not found, best available version used.',
    'lens-failed': 'Could not open Google Lens. Please try again.',
    'lens-paste-manually': 'Lens is open, paste the image link (Ctrl+V) into its link box.',
  };
  return map[code] || 'Done.';
}

/* ------------------------------------------------------------------ */
/* Queue auto-collapse, the progress pane gets out of the way once    */
/* everything finishes, instead of sitting open on a done list.       */
/* ------------------------------------------------------------------ */

let queueDoneTimer = 0;
let queueCompletedAt = 0;
let popupInteractedAt = 0;
['click', 'keydown'].forEach((ev) => document.addEventListener(ev, () => {
  popupInteractedAt = Date.now();
}, { passive: true, capture: true }));

function maybeAutoCollapseQueue(snapshot) {
  const total = snapshot.total || 0;
  const finished = (snapshot.done || 0) + (snapshot.failed || 0);
  clearTimeout(queueDoneTimer);
  if (!total || finished < total) return; // still running
  if (!state.settings || state.settings.autoCollapseQueue === false) return;
  queueCompletedAt = Date.now();
  queueDoneTimer = setTimeout(() => {
    // Don't yank the UI: skip when the user touched the popup after
    // completion, or when they already navigated elsewhere.
    if (popupInteractedAt > queueCompletedAt) return;
    if (state.view !== 'home' || state.pane !== 'queue') return;
    navigate('home', 'idle', { replace: true });
  }, 1000);
}

/* ------------------------------------------------------------------ */
/* Navigation, one predictable router                                  */
/* ------------------------------------------------------------------ */

// Top-level views: 'home' | 'history'. The home view has sub-panes:
// 'idle' (dashboard) | 'scanning' | 'results' | 'queue' (download status).
const PANE_IDS = {
  idle: 'paneIdle',
  scanning: 'paneScanning',
  results: 'paneResults',
  queue: 'paneQueue',
};

const nav = {
  stack: [], // previous { view, pane } routes, for Back
};

function currentRoute() {
  return { view: state.view, pane: state.pane };
}

function applyRoute(route) {
  state.view = route.view;
  state.pane = route.pane;
  $('viewHome').hidden = route.view !== 'home';
  $('viewHistory').hidden = route.view !== 'history';
  $('navHome').setAttribute('aria-pressed', String(route.view === 'home'));
  $('navHistory').setAttribute('aria-pressed', String(route.view === 'history'));
  if (route.view === 'home') {
    for (const [name, id] of Object.entries(PANE_IDS)) {
      $(id).hidden = name !== route.pane;
    }
  }
}

/**
 * Navigate to a view/pane. The previous route is pushed so Back works;
 * pass { replace: true } to skip the stack for transient states.
 */
function navigate(view, pane, opts = {}) {
  const next = { view, pane: view === 'home' ? (pane || 'idle') : null };
  const cur = currentRoute();
  const same = cur.view === next.view && cur.pane === next.pane;
  if (!same && !opts.replace) {
    nav.stack.push(cur);
    if (nav.stack.length > 20) nav.stack.shift();
  }
  applyRoute(next);
  onEnterRoute(next);
}

function goBack() {
  const prev = nav.stack.pop();
  if (prev) {
    applyRoute(prev);
    onEnterRoute(prev);
  } else {
    goHome();
  }
}

/**
 * Home always returns to the dashboard and resets *temporary* view state:
 * the selection and the search box. Persistent settings, download history,
 * the stored scan, and any running downloads are never touched.
 */
function goHome() {
  state.selected.clear();
  state.filters.query = '';
  const search = $('search');
  if (search) search.value = '';
  paintSelection();
  updateFooter();
  nav.stack.length = 0;
  const route = { view: 'home', pane: 'idle' };
  applyRoute(route);
  onEnterRoute(route);
}

function onEnterRoute(route) {
  if (route.view === 'history') {
    loadHistory();
    return;
  }
  if (route.pane === 'results' && state.scan) refreshVisible();
  if (route.pane === 'queue') refreshQueue();
  if (route.pane === 'idle') renderHomeStatus();
}

function wireNav() {
  $('navHome').addEventListener('click', goHome);
  $('navHistory').addEventListener('click', () => navigate('history'));
  $('navSettings').addEventListener('click', () => {
    // Fire-and-forget: the options page opens in a new tab; if the worker
    // is unreachable the click simply does nothing (no state to corrupt).
    UI.send('OPEN_OPTIONS').catch(() => {});
  });
}

/* ------------------------------------------------------------------ */
/* Home dashboard status                                               */
/* ------------------------------------------------------------------ */

function homeStatusCard(title, btnLabel, onClick) {
  const card = UI.el('div', null, 'status-card');
  card.append(UI.el('span', title, 'status-card-title'));
  const btn = UI.el('button', btnLabel, 'btn btn-sm btn-primary');
  btn.addEventListener('click', onClick);
  card.append(btn);
  return card;
}

/**
 * Dashboard status: an in-flight download queue or a stored scan, surfaced
 * as quick-access cards. Takes an optional queue snapshot so QUEUE_UPDATE
 * broadcasts don't need a second round-trip.
 */
async function renderHomeStatus(snapshot) {
  const box = $('homeStatus');
  if (!box) return;
  let snap = snapshot;
  if (!snap) {
    try {
      ({ snapshot: snap } = await UI.send('GET_QUEUE'));
    } catch {
      snap = null;
    }
  }
  box.textContent = '';
  if (snap && (snap.active > 0 || snap.pending > 0)) {
    const n = snap.active + snap.pending;
    box.append(homeStatusCard(
      `${n} download${n === 1 ? '' : 's'} in progress`,
      'View downloads',
      () => navigate('home', 'queue'),
    ));
  } else if (state.scan && state.scan.images && state.scan.images.length) {
    const n = state.scan.images.length;
    box.append(homeStatusCard(
      `${n} image${n === 1 ? '' : 's'} found on this page`,
      'View results',
      () => navigate('home', 'results'),
    ));
  }
  box.hidden = box.childNodes.length === 0;
}

/* ------------------------------------------------------------------ */
/* Home: scan + screenshots                                            */
/* ------------------------------------------------------------------ */

function wireHome() {
  $('btnScan').addEventListener('click', doScan);
  $('btnRescan').addEventListener('click', doScan);
  $('btnShotVisible').addEventListener('click', async () => {
    try {
      await UI.send('CAPTURE_VISIBLE');
      window.close();
    } catch (err) {
      UI.toast(err.message);
    }
  });
  $('btnShotArea').addEventListener('click', () => {
    // Fire-and-forget: the popup must close now so it doesn't swallow the
    // first click on the page. Errors surface as a notification.
    UI.send('CAPTURE_AREA').catch(() => {});
    window.close();
  });
  $('btnShotElement').addEventListener('click', () => {
    UI.send('CAPTURE_ELEMENT').catch(() => {});
    window.close();
  });
  $('btnShotFull').addEventListener('click', async () => {
    try {
      await UI.send('CAPTURE_FULL');
      window.close();
    } catch (err) {
      UI.toast(err.message);
    }
  });
}

async function doScan() {
  navigate('home', 'scanning');
  updateScanProgress(0, 1);
  try {
    const { scan } = await UI.send('SCAN_PAGE');
    // SCAN_DONE broadcast will also arrive; render directly for snappiness.
    if (scan) showScan(scan, true);
  } catch (err) {
    navigate('home', 'idle');
    UI.toast(err.message);
  }
}

function updateScanProgress(done, total) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  $('scanBar').style.width = `${pct}%`;
  $('scanStatus').textContent = total > 1 ? `Found ${done} so far…` : 'Looking for images';
}

/* ------------------------------------------------------------------ */
/* Results: filters + grid + selection                                 */
/* ------------------------------------------------------------------ */

function wireResults() {
  document.querySelectorAll('[data-size]').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('[data-size]').forEach((c) => c.setAttribute('aria-pressed', 'false'));
      chip.setAttribute('aria-pressed', 'true');
      state.filters.size = chip.getAttribute('data-size');
      refreshVisible();
    });
  });
  $('search').addEventListener('input', UI.debounce((e) => {
    state.filters.query = e.target.value;
    refreshVisible();
  }));
  $('filterFormat').addEventListener('change', (e) => {
    state.filters.formats = e.target.value ? [e.target.value] : [];
    refreshVisible();
  });
  $('filterOrient').addEventListener('change', (e) => {
    state.filters.orientations = e.target.value ? [e.target.value] : [];
    refreshVisible();
  });
  $('sortMode').addEventListener('change', (e) => {
    state.filters.sort = e.target.value;
    refreshVisible();
  });
  $('selAll').addEventListener('click', () => {
    state.visible.forEach((img) => state.selected.add(img.id));
    paintSelection();
    updateFooter();
  });
  $('selNone').addEventListener('click', () => {
    state.selected.clear();
    paintSelection();
    updateFooter();
  });
  $('selInvert').addEventListener('click', () => {
    for (const img of state.visible) {
      if (state.selected.has(img.id)) state.selected.delete(img.id);
      else state.selected.add(img.id);
    }
    paintSelection();
    updateFooter();
  });
  $('qSmart').addEventListener('click', () => setQuality('smart'));
  $('qNormal').addEventListener('click', () => setQuality('normal'));
  $('btnDownload').addEventListener('click', downloadSelected);
  $('btnZip').addEventListener('click', downloadZip);
}

function setQuality(q) {
  state.quality = q;
  $('qSmart').setAttribute('aria-pressed', String(q === 'smart'));
  $('qNormal').setAttribute('aria-pressed', String(q === 'normal'));
}

function showScan(scan, selectAll) {
  state.scan = scan;
  state.selected.clear();
  if (selectAll) {
    scan.images.forEach((img) => state.selected.add(img.id));
  }
  const n = scan.images.length;
  $('resTitle').textContent = `${n} image${n === 1 ? '' : 's'} found`;
  $('resSub').textContent = (scan.title || '').slice(0, 70);
  if (!scan.images.length) {
    navigate('home', 'idle');
    const dropped = Number(scan.droppedBySize) || 0;
    UI.toast(
      dropped > 0
        ? `No images found, ${dropped} small image${dropped === 1 ? ' was' : 's were'} skipped by your size filter. Lower it in Settings → Scanning.`
        : 'No images found on this page.',
    );
    return;
  }
  navigate('home', 'results');
}

function refreshVisible() {
  if (!state.scan) return;
  const f = state.filters;
  let list = applyFilters(state.scan.images, {
    size: f.size === 'any' ? 'any' : f.size,
    formats: f.formats,
    orientations: f.orientations,
  });
  list = list.filter((img) => matchesQuery(img, f.query, state.scan));
  list = sortImages(list, f.sort);
  state.visible = list;
  // Drop selections that are no longer visible.
  const ids = new Set(list.map((i) => i.id));
  for (const id of [...state.selected]) {
    if (!ids.has(id)) state.selected.delete(id);
  }
  renderGrid();
  updateFooter();
}

/**
 * M11: windowed grid rendering. A scan can return 3000 images, building
 * 3000 DOM nodes (and 3000 <img> loads) at once janks the popup. Render
 * the first page, then append more as the sentinel scrolls into view.
 */
const GRID_PAGE = 120;
let gridSentinelObserver = null;

function renderGrid() {
  const grid = $('grid');
  grid.textContent = '';
  state.gridShown = 0;
  // B6: drop queued thumbnail resolutions and virtualization state.
  blobResolveQueue.length = 0;
  if (gridPlaceholderObserver) {
    gridPlaceholderObserver.disconnect();
  }
  if (gridSentinelObserver) {
    gridSentinelObserver.disconnect();
    gridSentinelObserver = null;
  }
  if (!state.visible.length) {
    const empty = UI.el('div', null, 'empty');
    empty.style.gridColumn = '1 / -1';
    empty.append(UI.el('div', '◫', 'glyph'));
    empty.append(UI.el('p', 'No images match these filters.'));
    grid.append(empty);
    return;
  }
  appendGridPage();
}

function appendGridPage() {
  const grid = $('grid');
  const oldSentinel = $('gridSentinel');
  if (oldSentinel) oldSentinel.remove();
  const frag = document.createDocumentFragment();
  const end = Math.min(state.gridShown + GRID_PAGE, state.visible.length);
  for (let i = state.gridShown; i < end; i++) {
    frag.append(makeThumbAt(i));
  }
  state.gridShown = end;
  grid.append(frag);
  if (state.gridShown < state.visible.length) {
    const sentinel = UI.el('div', null, 'grid-sentinel');
    sentinel.id = 'gridSentinel';
    sentinel.style.gridColumn = '1 / -1';
    sentinel.style.textAlign = 'center';
    sentinel.style.padding = '12px';
    sentinel.style.color = 'var(--muted)';
    sentinel.style.fontSize = '12px';
    sentinel.textContent = `Showing ${state.gridShown} of ${state.visible.length}, scroll for more`;
    grid.append(sentinel);
    gridSentinelObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        gridSentinelObserver.disconnect();
        gridSentinelObserver = null;
        appendGridPage();
      }
    }, { root: null, rootMargin: '400px' });
    gridSentinelObserver.observe(sentinel);
  }
  maybeVirtualizeGrid();
  updateFooter();
}

/** Build the thumb wrapper for visible[i], tagged with its index. */
function makeThumbAt(i) {
  const el = makeThumbBtn(state.visible[i]);
  el.querySelector('.thumb').dataset.vindex = String(i);
  return el;
}

/**
 * B6: grid virtualization. Past GRID_VIRTUALIZE_AT rendered thumbs, pages
 * fully above the viewport are swapped for height-matched placeholders, so
 * the DOM stays bounded however far the user scrolls. Placeholders keep
 * their height (no scroll jump) and re-inflate when scrolled near.
 */
const GRID_VIRTUALIZE_AT = 360;
let gridPlaceholderObserver = null;

function ensurePlaceholderObserver() {
  if (!gridPlaceholderObserver) {
    gridPlaceholderObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) inflateGridPlaceholder(e.target);
      }
    }, { root: null, rootMargin: '800px' });
  }
}

function maybeVirtualizeGrid() {
  const grid = $('grid');
  ensurePlaceholderObserver();
  for (;;) {
    const thumbs = grid.querySelectorAll(':scope > .thumb-wrap');
    if (thumbs.length <= GRID_VIRTUALIZE_AT) return;
    const first = thumbs[0];
    if (first.getBoundingClientRect().bottom > -800) return; // near viewport, stop
    const take = Math.min(GRID_PAGE, thumbs.length - GRID_VIRTUALIZE_AT);
    const last = thumbs[take - 1];
    const h = Math.max(
      0,
      Math.round(last.getBoundingClientRect().bottom - first.getBoundingClientRect().top),
    );
    const ph = document.createElement('div');
    ph.className = 'grid-placeholder';
    ph.style.gridColumn = '1 / -1';
    ph.style.height = `${h}px`;
    ph.dataset.startIndex = first.querySelector('.thumb').dataset.vindex || '0';
    ph.dataset.count = String(take);
    grid.insertBefore(ph, first);
    for (let k = 0; k < take; k++) thumbs[k].remove();
    gridPlaceholderObserver.observe(ph);
  }
}

function inflateGridPlaceholder(ph) {
  if (gridPlaceholderObserver) gridPlaceholderObserver.unobserve(ph);
  const start = Number(ph.dataset.startIndex) || 0;
  const count = Number(ph.dataset.count) || GRID_PAGE;
  const frag = document.createDocumentFragment();
  const end = Math.min(start + count, state.visible.length);
  for (let i = start; i < end; i++) {
    frag.append(makeThumbAt(i));
  }
  ph.replaceWith(frag);
}

function makeThumbBtn(img) {
    // D2: click/tap toggles selection (checkbox semantics); the magnifier
    // button opens the preview. Keyboard: Space toggles, Enter previews.
    // B6: wrapper div with two SIBLING buttons, a button inside a button
    // is invalid HTML and confuses screen readers.
    const wrap = document.createElement('div');
    wrap.className = 'thumb-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'thumb';
    btn.setAttribute('role', 'checkbox');
    btn.setAttribute('aria-checked', String(state.selected.has(img.id)));
    btn.title = `${img.filename || 'image'}, ${UI.formatDims(img.width, img.height)}`;
    const thumb = document.createElement('img');
    thumb.loading = 'lazy';
    thumb.alt = img.alt || img.filename || 'image';
    // Thumbnails: never hand page HTML to the DOM as markup, src only.
    setThumbSource(thumb, img, false);
    thumb.referrerPolicy = 'no-referrer';
    const tick = UI.el('span', '✓', 'tick');
    tick.setAttribute('aria-hidden', 'true');
    const dims = UI.el('span', UI.formatDims(img.width, img.height), 'dims');
    const zoom = UI.el('button', null, 'zoom-btn');
    zoom.type = 'button';
    zoom.setAttribute('aria-label', `Preview ${img.filename || 'image'}`);
    zoom.title = 'Preview';
    // Magnifier icon built via DOM (no innerHTML, project convention).
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', '11');
    circle.setAttribute('cy', '11');
    circle.setAttribute('r', '7');
    const line = document.createElementNS(svgNS, 'path');
    line.setAttribute('d', 'm21 21-4.3-4.3');
    svg.append(circle, line);
    zoom.append(svg);
    btn.append(thumb, tick, dims);
    wrap.append(btn, zoom);
    btn.addEventListener('click', () => {
      toggleSelect(img.id);
    });
    zoom.addEventListener('click', (e) => {
      e.stopPropagation();
      openPreview(img);
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === ' ') {
        e.preventDefault();
        toggleSelect(img.id);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        openPreview(img);
      }
    });
    btn.dataset.imgId = img.id;
    return wrap;
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  paintSelection();
  updateFooter();
}

function paintSelection() {
  document.querySelectorAll('.thumb').forEach((btn) => {
    btn.setAttribute('aria-checked', String(state.selected.has(btn.dataset.imgId)));
  });
}

function updateFooter() {
  const n = state.selected.size;
  const total = state.scan ? state.scan.images.length : 0;
  const deduped = state.scan && state.scan.deduped ? ` · ${state.scan.deduped} duplicate${state.scan.deduped === 1 ? '' : 's'} removed` : '';
  const uiHidden = state.scan && state.scan.droppedByRelevance ? ` · ${state.scan.droppedByRelevance} interface asset${state.scan.droppedByRelevance === 1 ? '' : 's'} hidden` : '';
  const hidden = total - state.visible.length;
  const hiddenTxt = hidden > 0 ? ` · ${hidden} hidden by filters` : '';
  $('resultCount').textContent = `${state.visible.length} shown · ${total} found${deduped}${uiHidden}${hiddenTxt}`;
  $('btnDownload').textContent = n === 0 ? 'Download selected' : `Download ${n} image${n === 1 ? '' : 's'}`;
  $('btnDownload').disabled = n === 0;
  $('btnZip').disabled = n === 0;
}

async function selectedFiles() {
  return state.visible
    .filter((img) => state.selected.has(img.id))
    .slice(0, 200)
    .map((img, i) => ({
      url: img.src,
      name: `image-${String(i + 1).padStart(3, '0')}-${(img.src.split('/').pop() || 'img').split('?')[0].slice(0, 60) || 'img'}`,
    }));
}

async function downloadZip() {
  const files = await selectedFiles();
  if (!files.length) return;
  try {
    await UI.send('DOWNLOAD_ZIP', { files });
    navigate('home', 'queue');
  } catch (err) {
    UI.toast(err.message);
  }
}

async function downloadSelected() {
  // M4: bulk defaults to "as shown", probing hundreds of images would
  // hammer the site. The explicit "best quality" switch opts back in.
  const bestQuality = $('bulkBest') && $('bulkBest').checked;
  const items = state.visible
    .filter((img) => state.selected.has(img.id))
    .slice(0, 500)
    .map((img) => ({
      id: img.id,
      srcUrl: img.src,
      mode: bestQuality ? state.quality : 'normal',
      format: $('dlFormat').value,
      candidates: Array.isArray(img.candidates) ? img.candidates.slice(0, 6) : null,
    }));
  if (!items.length) return;
  try {
    await UI.send('DOWNLOAD_MANY', { items });
    navigate('home', 'queue');
  } catch (err) {
    UI.toast(err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Preview modal                                                       */
/* ------------------------------------------------------------------ */

function openPreview(img) {
  const root = $('modalRoot');
  root.textContent = '';
  const backdrop = UI.el('div', null, 'modal-backdrop');
  const modal = UI.el('div', null, 'modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', 'Image preview');

  const closeBtn = UI.el('button', '✕', 'icon-btn');
  closeBtn.setAttribute('aria-label', 'Close preview');
  closeBtn.style.cssText = 'float:right;';
  const title = UI.el('h3', img.filename || 'Image preview', 'section-title');
  title.style.cssText = 'margin:0 0 8px; padding-right:32px; word-break:break-all;';

  const preview = document.createElement('img');
  preview.className = 'preview';
  setThumbSource(preview, img, true);
  preview.alt = img.alt || 'Image preview';
  preview.referrerPolicy = 'no-referrer';

  const kv = document.createElement('dl');
  kv.className = 'kv';
  const rows = [
    ['Size', UI.formatDims(img.width, img.height)],
    ['Format', (img.format || 'unknown').toUpperCase()],
    ['Source', img.isBackground ? 'Background image' : 'Page image'],
  ];
  for (const [k, v] of rows) {
    kv.append(UI.el('dt', k), UI.el('dd', v));
  }

  const actions = UI.el('div', null, 'preview-actions');
  const mkBtn = (label, primary, fn) => {
    const b = UI.el('button', label, `btn ${primary ? 'btn-primary' : 'btn-ghost'}`);
    b.addEventListener('click', fn);
    return b;
  };
  const single = (mode, format) => async () => {
    close();
    try {
      await UI.send('DOWNLOAD_IMAGE', {
        srcUrl: img.src,
        mode,
        format: format || 'as-is',
        candidates: Array.isArray(img.candidates) ? img.candidates.slice(0, 6) : null,
      });
      navigate('home', 'queue');
    } catch (err) {
      UI.toast(err.message);
    }
  };
  actions.append(
    mkBtn('Smart Download', true, single('smart')),
    mkBtn('Save as PNG', false, single('smart', 'png')),
    mkBtn('Save as JPEG', false, single('smart', 'jpg')),
    mkBtn('Save as WebP', false, single('smart', 'webp')),
    // M12: no AVIF button when the browser can't encode it.
    ...(state.avifOk === false ? [] : [mkBtn('Save as AVIF', false, single('smart', 'avif'))]),
  );
  const moreRow = UI.el('div', null, 'row');
  moreRow.style.marginTop = '8px';
  const openBtn = mkBtn('Open original', false, async () => {
    close();
    if (/^https?:\/\//i.test(img.src)) {
      chrome.tabs.create({ url: img.src });
    } else {
      UI.toast('This image cannot be opened in a tab.');
    }
  });
  openBtn.classList.add('btn-sm');
  const infoBtn = mkBtn('Image info', false, () => {
    close();
    const scan = state.scan || {};
    const qp = new URLSearchParams({
      src: img.src || '',
      pageUrl: scan.url || '',
      tabId: scan.tabId != null ? String(scan.tabId) : '',
    });
    chrome.tabs.create({
      url: chrome.runtime.getURL(`pages/info.html?${qp.toString()}`),
    });
  });
  infoBtn.classList.add('btn-sm');
  moreRow.append(openBtn, infoBtn);

  const close = () => {
    root.textContent = '';
    document.removeEventListener('keydown', onEsc);
  };
  const onEsc = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onEsc);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  closeBtn.addEventListener('click', close);

  modal.append(closeBtn, title, preview, kv, actions, moreRow);
  backdrop.append(modal);
  root.append(backdrop);
  closeBtn.focus();
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

function wireQueue() {
  $('btnQueueRetry').addEventListener('click', async () => {
    try {
      const { snapshot } = await UI.send('RETRY_QUEUE');
      renderQueue(snapshot);
    } catch (err) {
      UI.toast(err.message);
    }
  });
  $('btnQueueCancel').addEventListener('click', async () => {
    try {
      const { snapshot } = await UI.send('CANCEL_QUEUE');
      renderQueue(snapshot);
    } catch (err) {
      UI.toast(err.message);
    }
  });
  $('btnQueueClear').addEventListener('click', async () => {
    try {
      const { snapshot } = await UI.send('CLEAR_QUEUE');
      renderQueue(snapshot);
    } catch (err) {
      UI.toast(err.message);
    }
  });
  $('btnBack').addEventListener('click', goBack);
}

async function refreshQueue() {
  try {
    const { snapshot } = await UI.send('GET_QUEUE');
    renderQueue(snapshot);
  } catch (err) {
    UI.toast(err.message);
  }
}

function renderQueue(snapshot) {
  const total = snapshot.total || 0;
  const done = snapshot.done || 0;
  const failed = snapshot.failed || 0;
  $('queueSummary').textContent =
    total === 0 ? 'Queue is empty.' : `${done} of ${total} saved${failed ? ` · ${failed} failed` : ''}`;
  $('queueBar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';

  const list = $('queueList');
  list.textContent = '';
  if (!total) {
    list.append(UI.el('p', 'Nothing here yet.', 'muted small'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const item of snapshot.items.slice(-30).reverse()) {
    const row = UI.el('div', null, 'q-item');
    const dot = UI.el('span', null, `q-dot q-${item.state}`);
    const label = UI.el('span', item.label || 'image');
    label.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    const status = UI.el('span', item.state, 'muted small');
    row.append(dot, label, status);
    if (item.state === 'failed' && item.error) row.title = item.error;
    // B6: finished downloads can be revealed in the file manager.
    if (item.state === 'done' && Number.isInteger(item.chromeDownloadId)) {
      const show = UI.el('button', 'Show in folder', 'btn btn-sm btn-ghost');
      show.style.marginLeft = '8px';
      show.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await UI.send('SHOW_DOWNLOAD', { downloadId: String(item.chromeDownloadId) });
        } catch (err) {
          UI.toast(err.message);
        }
      });
      row.append(show);
    }
    frag.append(row);
  }
  list.append(frag);
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

function wireHistory() {
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
      loadHistory();
      UI.toast('History cleared.');
    } catch (err) {
      UI.toast(err.message);
    }
  });
}

let historyLoadSeq = 0;
async function loadHistory() {
  const seq = ++historyLoadSeq;
  const list = $('historyList');
  list.textContent = '';
  try {
    const { records } = await UI.send('GET_HISTORY');
    // Only the latest overlapping load may paint (see options loadOptHistory).
    if (seq !== historyLoadSeq) return;
    if (!records || !records.length) {
      const empty = UI.el('div', null, 'empty');
      empty.append(UI.el('div', '◷', 'glyph'));
      empty.append(UI.el('p', 'No downloads yet. Your saved images will appear here.'));
      list.append(empty);
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
        const dims = UI.el('span', UI.formatHistorySize(r), 'muted small');
        row.append(name, dims);
        frag.append(row);
      }
    }
    list.append(frag);
  } catch (err) {
    list.append(UI.el('p', err.message, 'muted small'));
  }
}

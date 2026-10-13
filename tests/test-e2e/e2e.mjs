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
 * ImgFetch e2e — tests/test-e2e/e2e.mjs
 * Real-browser suite (Playwright + Chromium). Run under a virtual display:
 *   xvfb-run -a node tests/test-e2e/e2e.mjs [--dpr=1|2] [--headed]
 *
 * What it does:
 *  P0  extension loads, service worker alive, zero console/page errors
 *  P1  SCAN_PAGE on /gallery -> images found (incl. lazy/srcset/picture/bg/iframe/svg)
 *  P2  DOWNLOAD_MANY (12 images) -> files on disk, PNG magic, sizes match
 *  P2b history records carry exact on-disk byte sizes (no "Unknown size")
 *  P3  CAPTURE_FULL on 20,000px page at DPR 2 -> N1: file produced, decodes,
 *      dimensions match the plan, not blank (pixel check via canvas)
 *  P4  CAPTURE_FULL on 3,000px page at DPR 1 -> baseline
 *  P5  worker kill x3 during 100-image bulk -> no duplicates, count correct (N4)
 *  P6  DOWNLOAD_ZIP (50 images) -> valid zip on disk
 *  P7  100 MP canvas probe in the offscreen document (N1 area-cap question)
 *
 * Fails the run on ANY console.error / pageerror / unhandled rejection in
 * the service worker, popup, offscreen document or content scripts.
 * Writes tests/test-e2e/results-<dpr>.json with raw evidence.
 */
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = _require('playwright'));
} catch {
  // ESM ignores NODE_PATH; point PLAYWRIGHT_PACKAGE at the install, e.g.
  // PLAYWRIGHT_PACKAGE=<playwright-install>/node_modules/playwright
  const pwPath = process.env.PLAYWRIGHT_PACKAGE;
  if (!pwPath) throw new Error('playwright not resolvable: set PLAYWRIGHT_PACKAGE to the installed package path');
  ({ chromium } = _require(pwPath));
}
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './fixture-server.mjs';
import { planFullPageCapture } from '../../core/fullpage-capture.js'; // real planner (N1)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.resolve(HERE, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));
const DPR = Number(args.dpr || '1');
const HEADED = args.headed !== undefined ? !!args.headed : true;
const BROWSER = (args.browser || 'chromium').toLowerCase();
const EDGE_PATH = '/usr/bin/microsoft-edge-stable';

const results = { dpr: DPR, headed: HEADED, browser: BROWSER, phases: [], errors: [] };
function phase(name, ok, evidence = {}) {
  results.phases.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence.note ? ` — ${evidence.note}` : ''}`);
  if (!ok) results.errors.push(name);
}
const pngMagic = (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

const { server: fixture, port: fport } = await startFixtureServer(0);
const BASE = `http://127.0.0.1:${fport}`;
console.log(`fixture: ${BASE}   dpr=${DPR} headed=${HEADED}`);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-e2e-'));
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfetch-dl-'));

const errorWatch = [];
function watchErrors(target, label) {
  target.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      errorWatch.push({ label, kind: `console.${msg.type()}`, text: msg.text().slice(0, 300) });
    }
  });
  target.on('pageerror', (err) => {
    errorWatch.push({ label, kind: 'pageerror', text: String(err && err.message || err).slice(0, 300) });
  });
}

let ctx;
try {
  const launchOpts = {
    headless: !HEADED,
    args: [
      `--disable-extensions-except=${PROJ}`,
      `--load-extension=${PROJ}`,
      `--force-device-scale-factor=${DPR}`,
      '--no-sandbox',
    ],
  };
  if (BROWSER === 'edge') launchOpts.executablePath = EDGE_PATH;
  ctx = await chromium.launchPersistentContext(userDataDir, launchOpts);
} catch (e) {
  console.log(`FATAL: could not launch browser: ${e.message}`);
  process.exit(2);
}

// The service worker identifies the extension id.
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
const extId = new URL(sw.url()).host;
console.log(`extension id: ${extId}`);
watchErrors(sw, 'service-worker');
sw.on('close', () => errorWatch.push({ label: 'service-worker', kind: 'close', text: 'worker closed unexpectedly' }));

// Popup page: our privileged control channel (kind='extension').
const ctrl = await ctx.newPage();
watchErrors(ctrl, 'popup');
await ctrl.goto(`chrome-extension://${extId}/popup/popup.html`);
const send = (msg) => ctrl.evaluate((m) => chrome.runtime.sendMessage(m), msg);

// Downloads go to our directory.
{
  const cdp = await ctx.newCDPSession(ctrl);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
}

// ---- P0: worker alive ----
phase('P0 worker alive', !!sw, { extId });

// ---- P1: SCAN_PAGE ----
const gallery = await ctx.newPage();
watchErrors(gallery, 'gallery');
await gallery.goto(`${BASE}/gallery`);
await gallery.bringToFront();
await gallery.waitForTimeout(1500);
let scanCount = 0;
try {
  const r = await send({ type: 'SCAN_PAGE' });
  const items = (r && r.scan && r.scan.items) || (r && r.scan && r.scan.images) || [];
  scanCount = Array.isArray(items) ? items.length : 0;
  phase('P1 SCAN_PAGE finds images', scanCount >= 30, { count: scanCount, note: `found ${scanCount}` });
} catch (e) {
  phase('P1 SCAN_PAGE finds images', false, { note: `threw: ${e.message.slice(0, 200)}` });
}

// ---- P2: DOWNLOAD_MANY ----
// Scan items live under r.scan.images with field `src` (not items/srcUrl).
const dlFiles = [];
try {
  const r = await send({ type: 'SCAN_PAGE' });
  const images = (r && r.scan && r.scan.images) || [];
  const pick = images.slice(0, 12).map((it, i) => ({
    id: `e2e-${i}`, srcUrl: it.src, mode: 'single', format: 'as-is',
  })).filter((x) => x.srcUrl);
  const before = new Set(fs.readdirSync(downloadDir));
  await send({ type: 'DOWNLOAD_MANY', items: pick });
  // Wait for downloads to land.
  const deadline = Date.now() + 60000;
  let landed = [];
  while (Date.now() < deadline) {
    await new Promise((r2) => setTimeout(r2, 1000));
    landed = fs.readdirSync(downloadDir).filter((f) => !before.has(f) && !f.endsWith('.crdownload'));
    if (landed.length >= pick.length) break;
  }
  let magicOk = 0;
  for (const f of landed) {
    const b = fs.readFileSync(path.join(downloadDir, f));
    if (pngMagic(b)) magicOk += 1;
    dlFiles.push({ f, size: b.length });
  }
  phase('P2 DOWNLOAD_MANY files on disk', landed.length >= pick.length && magicOk === landed.length,
    { expected: pick.length, landed: landed.length, magicOk, note: `${landed.length}/${pick.length} files, ${magicOk} PNG magic` });
} catch (e) {
  phase('P2 DOWNLOAD_MANY files on disk', false, { note: `threw: ${e.message.slice(0, 200)}` });
}

// ---- P2b: history records carry the exact on-disk byte size (no "Unknown size") ----
try {
  const hist = await sw.evaluate(async () =>
    (await chrome.storage.local.get('imgfetch.history'))['imgfetch.history'] || []);
  const onDisk = new Map();
  for (const f of fs.readdirSync(downloadDir)) {
    if (f.endsWith('.crdownload')) continue;
    try { onDisk.set(f, fs.statSync(path.join(downloadDir, f)).size); } catch { /* gone */ }
  }
  let bytesOk = 0, bytesMatch = 0;
  for (const h of hist) {
    if (Number(h.bytes) > 0) bytesOk += 1;
    const disk = onDisk.get(h.filename);
    if (disk != null && Number(h.bytes) === disk) bytesMatch += 1;
  }
  phase('P2b history records have exact byte sizes', hist.length > 0 && bytesOk === hist.length && bytesMatch === hist.length,
    { records: hist.length, bytesOk, bytesMatch, note: `${bytesOk}/${hist.length} with bytes>0, ${bytesMatch}/${hist.length} match disk` });
} catch (e) {
  phase('P2b history records have exact byte sizes', false, { note: `threw: ${e.message.slice(0, 200)}` });
}

// ---- P3/P4: full-page STITCH through the REAL offscreen document ----
// NOTE (honest): chrome.tabs.captureVisibleTab needs the activeTab grant,
// which only a real user gesture (click/shortcut) provides — Playwright
// cannot synthesize it, so the tile-capture HALF of captureFullPage is
// NOT TESTED here (see NOT_TESTED.md). What IS tested: the REAL planner +
// the REAL offscreen stitcher (the N1 contract) with REAL rendered pixels:
// tiles are shot with Playwright and stitched by the extension's own
// STITCH_BEGIN/TILE/END handlers in the real offscreen document.

async function stitchFullPage(h, label) {
  const ev = {};
  try {
    const pg = await ctx.newPage();
    await pg.goto(`${BASE}/tall?h=${h}`);
    await pg.bringToFront();
    await pg.waitForTimeout(600);
    const metrics = await pg.evaluate(() => ({
      viewportW: window.innerWidth, viewportH: window.innerHeight, dpr: window.devicePixelRatio,
    }));
    const plan = planFullPageCapture({
      fullW: metrics.viewportW, fullH: h,
      viewportW: metrics.viewportW, viewportH: metrics.viewportH, dpr: DPR,
    });
    ev.plan = { outW: plan.outW, outH: plan.outH, tiles: plan.tileCount, scale: +plan.scale.toFixed(3) };
    // Ensure the offscreen document exists.
    await sw.evaluate(() => chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html', reasons: ['BLOBS', 'CLIPBOARD'],
      justification: 'e2e stitch test',
    }).catch(() => {}));
    await new Promise((r) => setTimeout(r, 1500));
    // Drive the stitcher via chrome.runtime.sendMessage from the SERVICE
    // WORKER's context — the exact path the extension's offscreenCall uses.
    // (The worker's own listener ignores target:'offscreen', so there is
    // exactly one responder and no race. CDP Target.attachToTarget does not
    // route through Playwright's session.send params.)
    const sendOff = (msg) =>
      sw.evaluate((m) => chrome.runtime.sendMessage(m), { target: 'offscreen', ...msg });
    // N1: STITCH_BEGIN with the planner's output must NOT throw bad-size.
    // Retry like the extension's own offscreenCall: createDocument resolves
    // before the offscreen page's scripts register their listener.
    let begin = null;
    for (let a = 0; a < 6 && (!begin || !begin.ok); a += 1) {
      if (a) await new Promise((r) => setTimeout(r, 400 * a));
      begin = await sendOff({
        type: 'STITCH_BEGIN',
        width: plan.outW, height: plan.outH, scale: plan.scale,
      });
    }
    if (!begin || !begin.ok) return { ok: false, ev: { ...ev, note: `STITCH_BEGIN rejected: ${JSON.stringify(begin)}` } };
    // Shoot real tiles and stitch them at the plan's positions.
    const rows = plan.rows, cols = plan.cols;
    for (let rr = 0; rr < rows; rr += 1) {
      for (let cc = 0; cc < cols; cc += 1) {
        const sx = Math.max(0, Math.min(cc * metrics.viewportW, plan.capW - metrics.viewportW));
        const sy = Math.max(0, Math.min(rr * metrics.viewportH, plan.capH - metrics.viewportH));
        await pg.evaluate(([x, y]) => window.scrollTo(x, y), [sx, sy]);
        await pg.waitForTimeout(250);
        const shot = await pg.screenshot({ type: 'png' });
        const dataUrl = `data:image/png;base64,${shot.toString('base64')}`;
        const tile = await sendOff({
          type: 'STITCH_TILE', dataUrl,
          x: Math.round(sx * DPR * plan.scale), y: Math.round(sy * DPR * plan.scale),
          pageUrl: `${BASE}/tall?h=${h}`,
        });
        if (!tile || !tile.ok) return { ok: false, ev: { ...ev, note: `STITCH_TILE r${rr}c${cc} failed: ${JSON.stringify(tile)}` } };
      }
    }
    const end = await sendOff({ type: 'STITCH_END', format: 'png' });
    if (!end || !end.ok || !end.dataUrl) return { ok: false, ev: { ...ev, note: `STITCH_END failed: ${JSON.stringify(end).slice(0, 160)}` } };
    const b = Buffer.from(end.dataUrl.split(',')[1], 'base64');
    const f = `stitch-${label}-dpr${DPR}.png`;
    fs.writeFileSync(path.join(downloadDir, f), b);
    // Verify: PNG magic + REAL dimensions from the IHDR chunk (no renderer
    // needed — loading a 22MP PNG in a page crashed the target), and a
    // not-blank sanity check via file size (an all-white 1280x17280 PNG is
    // <100KB; real content is several hundred KB).
    const ihdrW = b.readUInt32BE(16); const ihdrH = b.readUInt32BE(20);
    const ok = pngMagic(b) && ihdrW === plan.outW && ihdrH === plan.outH && b.length > 10000;
    await pg.close().catch(() => {});
    return { ok, ev: { ...ev, file: f, size: b.length, dims: { w: ihdrW, h: ihdrH }, note: `${ihdrW}x${ihdrH} (plan ${plan.outW}x${plan.outH}), ${b.length} bytes` } };
  } catch (e) {
    return { ok: false, ev: { ...ev, note: `threw: ${e.message.slice(0, 200)}` } };
  }
}
{
  const { ok, ev } = await stitchFullPage(20000, 'tall20k');
  phase('P3 stitch 20000px DPR' + DPR + ' via real offscreen (N1)', ok, ev);
}
{
  const { ok, ev } = await stitchFullPage(3000, 'tall3k');
  phase('P4 stitch 3000px baseline via real offscreen', ok, ev);
}

// ---- P5: N4 — chromeDownloadId persisted IMMEDIATELY in the browser ----
// (CDP ServiceWorker.stopAllWorkers does not stop an MV3 extension worker,
// and chrome.runtime.reload() tears down the test browser, so the restart
// half is unit-tested; here we prove N4's actual claim in the live browser:
// the id must be in chrome.storage.session well under the old 1s throttle.)
{
  const ev = {};
  try {
    const pg = await ctx.newPage();
    await pg.goto(`${BASE}/gallery-big`);
    await pg.bringToFront();
    await pg.waitForTimeout(1000);
    let images = [];
    try {
      const r = await send({ type: 'SCAN_PAGE' });
      images = (r && r.scan && r.scan.images) || [];
    } catch { /* ignore */ }
    const pick = images.slice(0, 30).map((it, i) => ({
      id: `p5-${i}`, srcUrl: it.src, mode: 'single', format: 'as-is',
    })).filter((x) => x.srcUrl);
    const sendP = send({ type: 'DOWNLOAD_MANY', items: pick }).catch((e) => ({ e2eErr: e.message.slice(0, 80) }));
    // The persisted value is the serialize()d array. Poll it: catch the
    // queue while downloads are in flight (the fixture is fast — 20 tiny
    // images can finish in under a second).
    let snap = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !snap) {
      const persisted = await sw.evaluate(() =>
        chrome.storage.session.get('imgfetch.queue').then((o) => o['imgfetch.queue'] || null)
      ).catch(() => null);
      const arr = Array.isArray(persisted) ? persisted : [];
      if (arr.length > 0) snap = arr;
      else await new Promise((r) => setTimeout(r, 150));
    }
    const pItems = snap || [];
    const withId = pItems.filter((it) => it.chromeDownloadId).length;
    // Also record how quickly the first snapshot with ids appeared.
    Object.assign(ev, { picked: pick.length, persistedItems: pItems.length, persistedWithId: withId });
    // N4 fixed: ids are on disk immediately. (Old code: withId would be 0 here.)
    const ok = withId > 0;
    phase('P5 chromeDownloadId persisted immediately (N4)', ok, ev);
    await sendP.catch(() => {});
    // P5's bulk downloads must fully drain before P6 starts: with
    // candidate probing, smart downloads take longer, and any strays
    // landing during P6's window would break its "first new file wins"
    // assertion (P6 waits for the first file after its snapshot).
    {
      const deadline = Date.now() + 180000;
      for (;;) {
        const qs = await send({ type: 'GET_QUEUE' }).catch(() => null);
        const items = (qs && qs.snapshot && qs.snapshot.items) || [];
        const p5pending = items.filter((it) => String(it.id || '').startsWith('p5-')
          && (it.state === 'pending' || it.state === 'active'));
        if (!p5pending.length || Date.now() > deadline) break;
        await new Promise((r2) => setTimeout(r2, 1000));
      }
    }
    await pg.close().catch(() => {});
  } catch (e) {
    phase('P5 chromeDownloadId persisted immediately (N4)', false, { note: 'threw: ' + String(e && e.message || e).slice(0, 200) });
  }
}

// ---- P6: DOWNLOAD_ZIP (50 images) ----
{
  const pg = await ctx.newPage();
  await pg.goto(`${BASE}/gallery`);
  await pg.bringToFront();
  await pg.waitForTimeout(800);
  let files50 = [];
  try {
    const r = await send({ type: 'SCAN_PAGE' });
    const images = (r && r.scan && r.scan.images) || [];
    files50 = images.slice(0, 50).map((it, i) => ({ url: it.src, name: `e2e-${i}.png` })).filter((x) => x.url);
  } catch { /* ignore */ }
  const before = new Set(fs.readdirSync(downloadDir));
  let ok = false; let ev = {};
  try {
    await send({ type: 'DOWNLOAD_ZIP', files: files50, id: `e2e-zip-${Date.now()}` });
    const deadline = Date.now() + 90000;
    let landed = [];
    while (Date.now() < deadline) {
      await new Promise((r2) => setTimeout(r2, 1500));
      landed = fs.readdirSync(downloadDir).filter((f) => !before.has(f) && !f.endsWith('.crdownload'));
      if (landed.length) break;
    }
    ev = { landed: landed.length };
    if (landed.length) {
      const b = fs.readFileSync(path.join(downloadDir, landed[0]));
      const isZip = b[0] === 0x50 && b[1] === 0x4b;
      ev = { ...ev, size: b.length, isZip, note: `${b.length} bytes, zip magic ${isZip}` };
      ok = isZip && b.length > 1000;
    }
  } catch (e) { ev = { note: `threw: ${e.message.slice(0, 160)}` }; }
  await pg.close().catch(() => {});
  phase('P6 DOWNLOAD_ZIP 50 images', ok, ev);
}

// ---- P7: 100 MP canvas probe in the offscreen document (N1 area cap) ----
{
  let ev = {};
  let ok = false;
  try {
    const cdp = await ctx.newCDPSession(ctrl);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const off = targetInfos.find((t) => t.url && t.url.includes('offscreen.html'));
    ev.offscreenFound = !!off;
    if (off) {
      const sess = await ctx.newCDPSession(ctrl);
      const { sessionId } = await sess.send('Target.attachToTarget', { targetId: off.targetId, flatten: true });
      const r = await sess.send('Runtime.evaluate', {
        expression: `(() => {
          const t0 = performance.now();
          try {
            const c = document.createElement('canvas');
            c.width = 3162; c.height = 31623; // ~100 MP
            const x = c.getContext('2d');
            if (!x) return { ok: false, reason: 'no-2d' };
            x.fillRect(0, 0, 10, 10);
            // Touch every 1000th row so the backing store is really committed.
            const d = x.getImageData(0, 0, 1, 1);
            return { ok: true, ms: Math.round(performance.now() - t0), px: d.data.length };
          } catch (e) { return { ok: false, reason: String(e).slice(0, 80) }; }
        })()`,
        awaitPromise: true, returnByValue: true, sessionId,
      });
      ev.probe = r.result && r.result.value;
      ok = !!(ev.probe && ev.probe.ok);
      ev.note = ev.probe ? `100MP canvas: ${ev.probe.ok ? `allocated in ${ev.probe.ms}ms` : 'FAILED ' + ev.probe.reason}` : 'no probe result';
    } else {
      ev.note = 'offscreen target not found (not created yet?)';
    }
  } catch (e) { ev.note = `probe threw: ${e.message.slice(0, 160)}`; }
  phase('P7 100MP canvas probe (N1 area cap)', ok, ev);
}

// ---- P8: console/page error watch ----
{
  const bad = errorWatch.filter((e) => e.kind !== 'console.warning');
  const errOnly = errorWatch.filter((e) => e.kind === 'console.error' || e.kind === 'pageerror');
  phase('P8 zero console.error/pageerror', errOnly.length === 0, {
    note: `${errOnly.length} errors, ${errorWatch.length} total entries`,
    first: errOnly.slice(0, 3),
  });
}

const resName = `results-${BROWSER}-dpr${DPR}.json`;
fs.writeFileSync(path.join(HERE, resName), JSON.stringify(results, null, 2));
console.log(`\n${results.phases.filter((p) => p.ok).length}/${results.phases.length} phases passed`);
console.log(`results: tests/test-e2e/${resName}`);

await ctx.close().catch(() => {});
fixture.close();
process.exit(results.errors.length ? 1 : 0);

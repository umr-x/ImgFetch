#!/usr/bin/env node
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
 * ImgFetch — scripts/regression-diff.mjs
 * Pattern check #3: run the same inputs through the old pre-release builds
 * and the new core. Any case that got WORSE must be reported (this would
 * have caught N1: the later pre-release build failed tall DPR-2 pages that
 * the earlier build downscaled fine).
 *
 * Provenance (honest):
 *  - earlier-build planner: RECONSTRUCTED from the documented old behavior
 *    (the later build's own docstring: "refuse pages needing more than 24 tiles,
 *    cap the output's longest side at 8192 device px"; third audit:
 *    "In the earlier build this case worked (downscaled to 8192)"). No old tree
 *    was available, so this is a behavioral model, not the original code.
 *  - later-build core: pristine, extracted from the old dist zip.
 *  - new core: the working tree.
 *
 * Usage: node scripts/regression-diff.mjs [path-to-old-tree]
 */
import { planFullPageCapture as planNew, isStitchSizeAccepted } from '../core/fullpage-capture.js';
import { isPrivateNetworkUrl as guardNew } from '../core/urls.js';
import { createRequire } from 'node:module';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
const oldRoot = process.argv[2] || join(tmpdir(), 'old-build');
const require = createRequire(import.meta.url);
import { existsSync } from 'node:fs';
if (!existsSync(`${oldRoot}/core/fullpage-capture.js`)) {
  console.log('SKIP: pre-release reference tree not present — regression diff needs it.');
  process.exit(0);
}
// The old core is ESM; load via dynamic import of absolute file URLs.
const oldCapture = await import(`file://${oldRoot}/core/fullpage-capture.js`);
const oldUrls = await import(`file://${oldRoot}/core/urls.js`);
const planOld = oldCapture.planFullPageCapture;
const guardOld = oldUrls.isPrivateNetworkUrl;

// --- earlier-build planner: reconstructed behavioral model (see header) ---
function planEarlier({ fullW, fullH, viewportW, viewportH, dpr }) {
  const w = Math.max(1, Math.round(fullW || 0));
  const h = Math.max(1, Math.round(fullH || 0));
  const vw = Math.max(1, Math.round(viewportW || 0));
  const vh = Math.max(1, Math.round(viewportH || 0));
  const ratio = Math.max(0.5, Number(dpr) || 1);
  const cols = Math.max(1, Math.ceil(w / vw));
  const rows = Math.max(1, Math.ceil(h / vh));
  if (cols * rows > 24) return { refused: true, outW: 0, outH: 0 };
  const devW = w * ratio;
  const devH = h * ratio;
  let scale = 1;
  const longest = Math.max(devW, devH);
  if (longest > 8192) scale = 8192 / longest;
  return { refused: false, outW: Math.max(1, Math.round(devW * scale)), outH: Math.max(1, Math.round(devH * scale)), scale };
}
// earlier-build stitcher accepted whatever its planner emitted (both capped 8192).
const stitchEarlierAccepts = (w, h) => w > 0 && h > 0 && w <= 8192 && h <= 8192;
// later-build stitcher: private STITCH_MAX_SIDE = 12000 (the N1 bug).
const stitchLaterAccepts = (w, h) => w > 0 && h > 0 && w <= 12000 && h <= 12000;

let worse = 0;
let fixed = 0;
let total = 0;
const worseCases = [];

const heights = [1000, 3000, 6000, 8000, 12000, 20000, 30000, 40000, 60000];
const viewports = [[1280, 800], [1920, 900], [390, 844]];
const dprs = [1, 1.25, 1.5, 2, 3];

for (const h of heights) {
  for (const [vw, vh] of viewports) {
    for (const dpr of dprs) {
      total += 1;
      const inp = { fullW: vw, fullH: h, viewportW: vw, viewportH: vh, dpr };
      const rEarlier = planEarlier(inp);
      const rOld = planOld(inp);
      const rNew = planNew(inp);
      const okEarlier = !rEarlier.refused && stitchEarlierAccepts(rEarlier.outW, rEarlier.outH);
      const okOld = stitchLaterAccepts(rOld.outW, rOld.outH);
      const okNew = isStitchSizeAccepted(rNew.outW, rNew.outH);
      const label = `${vw}x${h} dpr=${dpr}`;
      if (!okOld && okEarlier) {
        // The N1 regression: the later build failed where the earlier build worked.
        if (okNew) { fixed += 1; }
        else { worse += 1; worseCases.push(`STILL BROKEN (v177 ok, v178 broken, new broken): ${label}`); }
      } else if (okEarlier && okNew) {
        // No quality regression: new output must be at least as large.
        const a177 = rEarlier.outW * rEarlier.outH;
        const aNew = rNew.outW * rNew.outH;
        if (aNew < a177) {
          worse += 1;
          worseCases.push(`QUALITY REGRESSION ${label}: v177 ${rEarlier.outW}x${rEarlier.outH}, new ${rNew.outW}x${rNew.outH}`);
        }
      } else if (okEarlier && !okNew) {
        worse += 1;
        worseCases.push(`NEW FAILURE ${label}: v177 produced ${rEarlier.outW}x${rEarlier.outH}, new rejected`);
      }
    }
  }
}

console.log(`planner regression grid: ${total} cases`);
console.log(`  v177-ok-but-v178-broken cases now fixed by new core: ${fixed}`);
console.log(`  cases worse than before: ${worse}`);
if (worseCases.length) {
  console.log('WORSE CASES:');
  for (const c of worseCases.slice(0, 15)) console.log(`  ${c}`);
}

// --- URL guard: old vs new over a fixed corpus. Intended diffs: N3 only.
const corpus = [
  'http://[::127.0.0.1]/a', 'http://[64:ff9b::7f00:1]/a', 'http://[2002:7f00:1::]/a',
  'http://[64:ff9b::c0a8:101]/a', 'http://[2002:c0a8:101::]/a',
  'http://127.0.0.1/a', 'http://10.0.0.5/a', 'http://192.168.1.1/a', 'http://[::1]/a',
  'http://[fe80::1]/a', 'http://[fd00::1]/a', 'http://[::ffff:10.0.0.1]/a',
  'https://example.com/a', 'https://8.8.8.8/a', 'http://[2001:db8::1]/a',
  'http://[64:ff9b::808:808]/a', 'http://[2002:808:808::]/a', 'http://[::808:808]/a',
  'http://localhost/a', 'http://printer/a', 'http://[::]/a',
];
const intendedN3 = new Set([
  'http://[::127.0.0.1]/a', 'http://[64:ff9b::7f00:1]/a', 'http://[2002:7f00:1::]/a',
  'http://[64:ff9b::c0a8:101]/a', 'http://[2002:c0a8:101::]/a',
]);
let guardDiffs = 0;
for (const u of corpus) {
  const a = guardOld(u);
  const b = guardNew(u);
  if (a !== b) {
    guardDiffs += 1;
    const ok = intendedN3.has(u) && b === true;
    console.log(`  guard diff ${u}: v178=${a} new=${b} ${ok ? '(intended N3 fix)' : '(UNEXPECTED!)'}`);
    if (!ok) worse += 1;
  }
}
console.log(`url guard diffs v178->new: ${guardDiffs} (all intended N3: ${guardDiffs === intendedN3.size})`);

if (worse) {
  console.log(`\nREGRESSION-CHECK FAILED: ${worse} worse case(s)`);
  process.exit(1);
}
console.log('\nOK: nothing got worse vs the pre-release builds; N1 regression fixed');

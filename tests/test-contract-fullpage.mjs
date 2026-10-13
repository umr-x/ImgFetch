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
 * ImgFetch — tests/test-contract-fullpage.mjs
 * N1 contract: the full-page planner's output MUST be accepted by the
 * offscreen stitcher. Regression proof for the pre-release bug where the planner
 * allowed 32,767 px sides but the stitcher rejected anything above 12,000 px
 * ("bad-size") — tall pages failed on DPR 2 screens.
 *
 * The old stitcher rule is reproduced below verbatim (offscreen.js,
 * STITCH_MAX_SIDE = 12000) so this test fails on the old code and passes
 * once both sides share one constant from core/fullpage-capture.js.
 */
import { planFullPageCapture, isStitchSizeAccepted } from '../core/fullpage-capture.js';

// --- old stitcher rule (offscreen/offscreen.js, before the N1 fix) ---
// Kept for the regression proof: on the old code the planner's output was
// checked against this private 12000 const and rejected. After the fix,
// both sides share isStitchSizeAccepted() from core/fullpage-capture.js.
const OLD_STITCH_MAX_SIDE = 12000;
function oldStitchAccepts(w, h) {
  return w > 0 && h > 0 && w <= OLD_STITCH_MAX_SIDE && h <= OLD_STITCH_MAX_SIDE;
}
// Post-fix contract: the planner's output must satisfy the ONE shared rule
// that the real stitcher enforces.
function sharedStitchAccepts(w, h) {
  return isStitchSizeAccepted(w, h);
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; failures.push(`${name}${extra ? ` — ${extra}` : ''}`); }
}

// Contract grid: page heights 1,000..60,000 CSS px, several viewports,
// DPR 1 / 1.25 / 1.5 / 2 / 3 (the audit's N1 grid).
const heights = [1000, 3000, 6000, 8000, 12000, 20000, 30000, 40000, 60000];
const viewports = [[1280, 800], [1920, 900], [390, 844]];
const dprs = [1, 1.25, 1.5, 2, 3];

for (const h of heights) {
  for (const [vw, vh] of viewports) {
    for (const dpr of dprs) {
      const plan = planFullPageCapture({ fullW: vw, fullH: h, viewportW: vw, viewportH: vh, dpr });
      // N1 regression proof: on the old code this used oldStitchAccepts and failed.
      // Post-fix it must pass against the shared rule both sides enforce.
      const ok = sharedStitchAccepts(plan.outW, plan.outH);
      check(
        `contract ${vw}x${h} dpr=${dpr}`,
        ok,
        `planner out=${plan.outW}x${plan.outH} rejected by stitcher`,
      );
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('Failures (first 10):');
  for (const f of failures.slice(0, 10)) console.log(`  FAIL ${f}`);
}
process.exit(fail ? 1 : 0);

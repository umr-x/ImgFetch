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
 * ImgFetch — core/capture.js
 * Pure full-page capture planning (B6, ROUND 2). No chrome.* — the service
 * worker calls planFullPageCapture() and then executes the plan.
 *
 * Old behavior: refuse pages needing more than 24 tiles, and cap the
 * output's longest side at 8192 device px (a 20,000px page at DPR 2 shrank
 * to ~20% — unreadable). New behavior: capture the first 24 tiles worth
 * from the top and say so, and cap by AREA (100 MP, max side 32,767) so
 * long pages stay readable.
 */

export const FULLPAGE_MAX_TILES = 24;
export const FULLPAGE_MAX_AREA = 100_000_000; // device pixels
export const FULLPAGE_MAX_SIDE = 32767; // canvas limit

/**
 * N1: single source of truth for the stitcher's acceptance rule.
 * BOTH the planner (which must never emit an un-acceptable size) and the
 * offscreen stitcher (which enforces it before allocating the canvas) use
 * this predicate. The pre-release bug was two copies of the rule disagreeing
 * (planner: 32767 side, stitcher: private 12000 const) — tall pages failed
 * on DPR 2 screens with a generic "bad-size".
 */
export function isStitchSizeAccepted(width, height) {
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  return (
    w > 0 &&
    h > 0 &&
    w <= FULLPAGE_MAX_SIDE &&
    h <= FULLPAGE_MAX_SIDE &&
    w * h <= FULLPAGE_MAX_AREA
  );
}

/**
 * Plan a full-page capture.
 * Input: CSS px page size, CSS px viewport, devicePixelRatio.
 * Returns { cols, rows, tileCount, tileCapped, capW, capH, scale, outW, outH }
 * where capW/capH is the actually-captured region (top portion when capped)
 * and scale is the output downscale (1 = full device resolution).
 */
export function planFullPageCapture({ fullW, fullH, viewportW, viewportH, dpr }) {
  const w = Math.max(1, Math.round(fullW || 0));
  const h = Math.max(1, Math.round(fullH || 0));
  const vw = Math.max(1, Math.round(viewportW || 0));
  const vh = Math.max(1, Math.round(viewportH || 0));
  const ratio = Math.max(0.5, Number(dpr) || 1);

  const cols = Math.max(1, Math.ceil(w / vw));
  let rows = Math.max(1, Math.ceil(h / vh));
  let tileCapped = false;
  if (cols * rows > FULLPAGE_MAX_TILES) {
    rows = Math.max(1, Math.floor(FULLPAGE_MAX_TILES / cols));
    tileCapped = true;
  }
  const tileCount = cols * rows;
  const capW = w;
  const capH = Math.min(h, rows * vh);

  // Area-based device-pixel budget.
  let scale = 1;
  const devW = capW * ratio;
  const devH = capH * ratio;
  const area = devW * devH;
  if (area > FULLPAGE_MAX_AREA) scale = Math.sqrt(FULLPAGE_MAX_AREA / area);
  const longest = Math.max(devW, devH) * scale;
  if (longest > FULLPAGE_MAX_SIDE) scale = FULLPAGE_MAX_SIDE / Math.max(devW, devH);

  const outW0 = Math.max(1, Math.round(devW * scale));
  const outH0 = Math.max(1, Math.round(devH * scale));
  // N1: rounding can push the area a hair over the cap (contract test
  // caught 100,004,446 > 100,000,000). Trim the long side down so the
  // planner's output ALWAYS satisfies isStitchSizeAccepted().
  let outW = outW0;
  let outH = outH0;
  if (outW * outH > FULLPAGE_MAX_AREA) {
    const trim = Math.sqrt(FULLPAGE_MAX_AREA / (outW * outH));
    outW = Math.max(1, Math.floor(outW * trim));
    outH = Math.max(1, Math.floor(outH * trim));
  }
  return { cols, rows, tileCount, tileCapped, capW, capH, scale, outW, outH };
}

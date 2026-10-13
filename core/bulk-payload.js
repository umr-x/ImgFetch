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
 * ImgFetch — core/bulk-payload.js
 * Pure queue-payload builders for DOWNLOAD_IMAGE / DOWNLOAD_MANY.
 *
 * Scan-time candidates ({ u, k, w } as produced by scanPage) must survive
 * the trip from scan results -> popup selection -> DOWNLOAD_MANY ->
 * queue payload -> performSmartDownload -> findRankedSourcesCached.
 * They are evidence-backed URLs (srcset, <picture>, lazy attrs) collected
 * in-page during the scan; the download engine re-validates them by
 * actually loading each one, so a stale/malicious entry can only fail
 * probing — it can never inject an unvalidated download source.
 */

const MAX_CANDIDATES = 8;
const MAX_CANDIDATE_URL_LEN = 8192;

/**
 * Validate + normalize a candidates array from an extension message.
 * Returns null when nothing usable remains (callers then fall back to
 * in-page re-discovery). Never throws.
 */
export function sanitizeCandidates(cands) {
  if (!Array.isArray(cands)) return null;
  const out = [];
  const seen = new Set();
  for (const c of cands) {
    if (!c || typeof c !== 'object') continue;
    const u = typeof c.u === 'string' ? c.u.trim() : '';
    if (!u || u.length > MAX_CANDIDATE_URL_LEN || seen.has(u)) continue;
    // Reject only schemes that can never be image sources. http(s) go
    // through the normal download guards (checkPublicFetch); data:/blob:
    // are page-scoped and only ever probed in-page. The download engine
    // re-validates every candidate by actually loading it.
    if (/^\s*javascript:/i.test(u)) continue;
    const k = typeof c.k === 'string' ? c.k.slice(0, 32) : 'scan';
    const w = Number(c.w);
    seen.add(u);
    out.push({ u, k, w: Number.isFinite(w) && w >= 0 ? Math.floor(w) : 0 });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out.length ? out : null;
}

/**
 * Pure upgrade decision: given probed + ranked sources (best-first) and the
 * current source URL, return the upgrade target or null. Never "upgrades"
 * to the same URL or to a smaller source. Used by the 'normal' bulk path.
 */
export function pickUpgrade(srcUrl, ranked) {
  if (!Array.isArray(ranked) || !ranked.length) return null;
  const best = ranked[0];
  if (!best || !best.url || best.url === srcUrl) return null;
  const current = ranked.find((r) => r.url === srcUrl);
  const bestArea = (best.width || 0) * (best.height || 0);
  const curArea = current ? (current.width || 0) * (current.height || 0) : 0;
  if (bestArea <= curArea) return null;
  return best;
}

/**
 * Queue payload for one DOWNLOAD_MANY item.
 * it: { id, srcUrl, mode, format, candidates } (from the popup)
 * resolved: { mode, format, pageUrl, pageTitle, tabId } (worker-computed)
 */
export function bulkItemPayload(it, resolved) {
  const r = resolved || {};
  return {
    srcUrl: it.srcUrl,
    mode: r.mode,
    format: r.format || 'as-is',
    pageUrl: r.pageUrl || '',
    pageTitle: r.pageTitle || '',
    tabId: typeof r.tabId === 'number' ? r.tabId : null,
    kind: 'bulk',
    candidates: sanitizeCandidates(it.candidates),
  };
}

/**
 * Queue payload for a DOWNLOAD_IMAGE (single) message.
 * msg: the validated message; resolved: { mode, pageUrl, pageTitle, tabId }.
 */
export function singleItemPayload(msg, resolved) {
  const r = resolved || {};
  return {
    srcUrl: msg.srcUrl,
    mode: r.mode,
    format: msg.format || 'as-is',
    customName: typeof msg.customName === 'string' ? msg.customName.slice(0, 120) : '',
    pageUrl: r.pageUrl || '',
    pageTitle: r.pageTitle || '',
    tabId: typeof r.tabId === 'number' ? r.tabId : null,
    kind: 'single',
    candidates: sanitizeCandidates(msg.candidates),
  };
}

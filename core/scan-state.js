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
 * ImgFetch — core/scan-state.js
 * Scan lifecycle state shared between the service worker and the popup:
 *   idle -> scanning -> results | error
 *
 * The worker writes it to chrome.storage.session when a scan starts and
 * finishes; the popup reads it on open so a shortcut-triggered scan is
 * never lost just because the popup was closed. A 'scanning' state older
 * than SCAN_STATE_STALE_MS means the worker died mid-scan — treat it as
 * idle instead of hanging the popup. Pure logic, unit-testable in Node.
 */

export const SCAN_STATE_STALE_MS = 120_000; // 2 minutes

/** True when a 'scanning' state is too old to still be real. */
export function isScanStateStale(s, now = Date.now()) {
  if (!s || typeof s !== 'object' || s.status !== 'scanning') return false;
  return now - (Number(s.at) || 0) > SCAN_STATE_STALE_MS;
}

/** Normalize a stored scan state; stale 'scanning' degrades to 'idle'. */
export function coerceScanState(s, now = Date.now()) {
  const cur = s && typeof s === 'object' && typeof s.status === 'string'
    ? s
    : { status: 'idle' };
  if (isScanStateStale(cur, now)) return { status: 'idle' };
  return cur;
}

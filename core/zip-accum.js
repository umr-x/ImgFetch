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
 * ImgFetch — core/zip-accum.js
 * Pure accumulator for chunked offscreen ZIP builds (N2).
 *
 * B6 splits huge BUILD_ZIP payloads into small runtime messages; the
 * offscreen side accumulates per zipToken until the final chunk
 * (more:false) builds the zip. the pre-release code kept those entries (up to 300 MB)
 * forever when a chunk failed, threw, or the user cancelled — only a
 * successful final build deleted them.
 *
 * N2 fixes that two ways:
 *  1. abort(token) — the worker sends ZIP_ABORT in its catch/finally, so a
 *     failed or cancelled build releases its chunks immediately.
 *  2. sweep(now) — a 2-minute TTL deletes tokens that went stale (e.g. the
 *     worker died mid-build). The offscreen sweeps on every BUILD_ZIP.
 */
export const ZIP_ACCUM_TTL_MS = 120_000;

export function createZipAccumulator(ttlMs = ZIP_ACCUM_TTL_MS) {
  const accums = new Map(); // token -> { entries, skipped, total, touchedAt }

  function get(token) {
    const key = String(token || 'default');
    let acc = accums.get(key);
    if (!acc) {
      acc = { entries: [], skipped: [], total: 0, touchedAt: Date.now() };
      accums.set(key, acc);
    }
    acc.touchedAt = Date.now();
    return acc;
  }

  function remove(token) {
    const key = String(token || 'default');
    const acc = accums.get(key);
    accums.delete(key);
    return acc || null;
  }

  return {
    /** Get-or-create the accumulator for a token (touch refreshes the TTL). */
    get,
    /** Take and remove the accumulator for the final build. */
    take: remove,
    /** N2: drop a failed/cancelled build immediately. */
    abort: remove,
    /** N2: delete tokens untouched for longer than the TTL. */
    sweep(now = Date.now()) {
      for (const [key, acc] of accums) {
        if (now - acc.touchedAt > ttlMs) accums.delete(key);
      }
    },
    /** Diagnostics for tests: live token count / retained bytes. */
    tokenCount: () => accums.size,
    retainedBytes: () => {
      let n = 0;
      for (const acc of accums.values()) n += acc.total;
      return n;
    },
  };
}

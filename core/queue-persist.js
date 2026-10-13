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
 * ImgFetch — core/queue-persist.js
 * Pure persist-scheduling for the download queue (N4).
 *
 * H5 persists unfinished queue items to chrome.storage.session so a
 * service-worker restart mid-bulk doesn't lose work. Bulk updates fire
 * constantly, so schedule() coalesces writes to at most one per delayMs.
 *
 * N4: a download can only be *adopted* after a restart if its
 * chromeDownloadId was already saved. trackDownload() therefore calls
 * flush() the moment the id is assigned — the id is on disk even if the
 * worker dies a millisecond later. flush() also cancels any pending
 * throttled write so the same state isn't written twice.
 */
export const QUEUE_SESSION_KEY = 'imgfetch.queue';

export function createQueuePersister({ getState, storage, delayMs = 1000 }) {
  let timer = 0;

  const write = () => {
    timer = 0;
    try {
      const p = storage.set({ [QUEUE_SESSION_KEY]: getState() });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* storage unavailable (e.g. during shutdown) — next update retries */
    }
  };

  return {
    /** Throttled write for high-frequency queue updates. */
    schedule() {
      if (timer) return;
      timer = setTimeout(write, delayMs);
    },
    /** N4: immediate write, cancelling any pending throttled one. */
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = 0;
      }
      write();
    },
    /** Test/cleanup hook. */
    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = 0;
      }
    },
  };
}

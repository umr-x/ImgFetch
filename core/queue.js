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
 * ImgFetch — core/queue.js
 * Controlled download queue: concurrency, progress, retry, cancel.
 * Pure logic — the actual download starter is injected, so this is
 * unit-testable without chrome.*.
 *
 * Item: { id, label }
 * starter(item, attempt) => Promise<result>
 * events: onUpdate(snapshot)
 * snapshot: { total, done, failed, active, pending, items:[{id,label,state,attempts,error}] }
 */

export const ItemState = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export class DownloadQueue {
  constructor({ concurrency = 3, maxAttempts = 2, starter, onUpdate } = {}) {
    if (typeof starter !== 'function') throw new Error('starter-required');
    this.concurrency = Math.min(6, Math.max(1, concurrency | 0));
    this.maxAttempts = Math.min(4, Math.max(1, maxAttempts | 0));
    this.starter = starter;
    this.onUpdate = typeof onUpdate === 'function' ? onUpdate : () => {};
    this.items = new Map();
    this.active = 0;
    this.cancelled = false;
    this.seq = 0;
  }

  enqueue(list) {
    for (const entry of list || []) {
      const id = entry.id || `q${++this.seq}-${Date.now()}`;
      if (this.items.has(id)) continue;
      this.items.set(id, {
        id,
        label: String(entry.label || 'image'),
        payload: entry.payload,
        state: ItemState.PENDING,
        attempts: 0,
        error: null,
      });
    }
    this.cancelled = false;
    this.#pump();
    this.#emit();
    return this.snapshot();
  }

  retryFailed() {
    let changed = false;
    for (const item of this.items.values()) {
      if (item.state === ItemState.FAILED) {
        item.state = ItemState.PENDING;
        item.error = null;
        changed = true;
      }
    }
    if (changed) {
      this.cancelled = false;
      this.#pump();
      this.#emit();
    }
    return this.snapshot();
  }

  cancel() {
    this.cancelled = true;
    for (const item of this.items.values()) {
      if (item.state === ItemState.PENDING) item.state = ItemState.CANCELLED;
    }
    this.#emit();
    return this.snapshot();
  }

  clearFinished() {
    for (const [id, item] of this.items) {
      if ([ItemState.DONE, ItemState.FAILED, ItemState.CANCELLED].includes(item.state)) {
        this.items.delete(id);
      }
    }
    this.#emit();
    return this.snapshot();
  }

  /**
   * Patch a queued item (e.g. update its label with a progress stage).
   * Used by long-running starters to report stages like
   * "Finding best quality…". Never touches id or payload.
   */
  updateItem(id, patch) {
    const item = this.items.get(id);
    if (!item) return this.snapshot();
    for (const [key, value] of Object.entries(patch || {})) {
      if (key === 'id' || key === 'payload') continue;
      item[key] = value;
    }
    this.#emit();
    return this.snapshot();
  }

  /**
   * H5: serializable queue state for chrome.storage.session, so a
   * service-worker restart mid-bulk doesn't lose the user's work.
   * Only unfinished items are kept; DONE/CANCELLED are dropped.
   */
  serialize() {
    return [...this.items.values()]
      .filter((i) =>
        [ItemState.PENDING, ItemState.ACTIVE, ItemState.FAILED].includes(i.state),
      )
      .slice(0, 500)
      .map((i) => ({
        id: i.id,
        label: i.label,
        payload: i.payload,
        state: i.state,
        attempts: i.attempts,
        error: i.error,
        chromeDownloadId: i.chromeDownloadId || null,
        history: i.history || null,
      }));
  }

  /**
   * H5: rebuild the queue from serialized state after a worker restart.
   * B1 fix: `adoptedIds` are downloads still running in the browser — they
   * enter directly as ACTIVE with their chromeDownloadId and the starter
   * is NEVER called for them (no duplicate download). Entries triaged as
   * failed stay failed; everything else becomes pending. One pump at the
   * end fills only the free concurrency slots.
   */
  restore(list, adoptedIds) {
    const adopted = new Set(adoptedIds || []);
    for (const s of list || []) {
      if (!s || !s.id || this.items.has(s.id)) continue;
      if (adopted.has(s.id)) {
        this.items.set(s.id, {
          id: s.id,
          label: String(s.label || 'image'),
          payload: s.payload,
          state: ItemState.ACTIVE,
          attempts: Math.max(0, s.attempts | 0),
          error: null,
          chromeDownloadId: s.chromeDownloadId != null ? s.chromeDownloadId : null,
          history: s.history || null,
        });
        this.active += 1; // adopted downloads genuinely occupy a slot
        continue;
      }
      this.items.set(s.id, {
        id: s.id,
        label: String(s.label || 'image'),
        payload: s.payload,
        state: s.state === ItemState.FAILED ? ItemState.FAILED : ItemState.PENDING,
        attempts: Math.max(0, s.attempts | 0),
        error: s.error || null,
        chromeDownloadId: s.chromeDownloadId != null ? s.chromeDownloadId : null,
        history: s.history || null,
      });
    }
    this.cancelled = false;
    this.#pump();
    this.#emit();
    return this.snapshot();
  }

  /**
   * H5: adopt a download that is still running in the browser after a
   * worker restart. Marks the item active WITHOUT running the starter
   * (no duplicate download); settleAdopted() finishes it later.
   * B1 fix: the active counter is maintained so concurrency stays exact.
   */
  adopt(id) {
    const item = this.items.get(id);
    if (!item || item.state === ItemState.DONE) return null;
    if (item.state !== ItemState.ACTIVE) {
      item.state = ItemState.ACTIVE;
      this.active += 1;
    }
    this.#emit();
    return item;
  }

  settleAdopted(id, ok, error) {
    const item = this.items.get(id);
    if (!item) return null;
    // B1 fix: adopted items never went through the starter's finally(),
    // so release their concurrency slot here (guarded against double-call).
    if (item.state === ItemState.ACTIVE) this.active = Math.max(0, this.active - 1);
    item.state = ok ? ItemState.DONE : ItemState.FAILED;
    item.error = ok ? null : String(error || 'failed').slice(0, 300);
    item.chromeDownloadId = null;
    this.#emit();
    this.#pump();
    return item;
  }

  get size() {
    return this.items.size;
  }

  snapshot() {
    const items = [...this.items.values()].map((i) => ({ ...i }));
    const count = (s) => items.filter((i) => i.state === s).length;
    return {
      total: items.length,
      done: count(ItemState.DONE),
      failed: count(ItemState.FAILED),
      active: count(ItemState.ACTIVE),
      pending: count(ItemState.PENDING),
      items,
    };
  }

  #emit() {
    try {
      this.onUpdate(this.snapshot());
    } catch {
      /* listener errors must not break the queue */
    }
  }

  #pump() {
    if (this.cancelled) return;
    while (this.active < this.concurrency) {
      const next = [...this.items.values()].find(
        (i) => i.state === ItemState.PENDING,
      );
      if (!next) break;
      this.active += 1;
      next.state = ItemState.ACTIVE;
      next.attempts += 1;
      this.#emit();
      Promise.resolve()
        .then(() => this.starter(next, next.attempts))
        .then(() => {
          next.state = ItemState.DONE;
          next.error = null;
        })
        .catch((err) => {
          const message = err && err.message ? String(err.message).slice(0, 300) : 'failed';
          if (!this.cancelled && next.attempts < this.maxAttempts) {
            next.state = ItemState.PENDING; // automatic retry
            next.error = message;
          } else {
            next.state = ItemState.FAILED;
            next.error = message;
          }
        })
        .finally(() => {
          this.active -= 1;
          this.#emit();
          this.#pump();
        });
    }
  }
}

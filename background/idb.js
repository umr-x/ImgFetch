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
 * ImgFetch — background/idb.js
 * Minimal promise-based IndexedDB wrapper for the service worker.
 * M11: screenshots are large (a full-page capture can be tens of MB as a
 * data URL). Keeping them in worker memory risks eviction pressure and
 * bloats every worker restart snapshot; chrome.storage.session is capped
 * at ~10 MB. IndexedDB is the right home — it survives worker restarts
 * and has a far larger quota. Zero dependencies, no build step.
 */

const DB_NAME = 'imgfetch';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('captures')) {
        db.createObjectStore('captures', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // If opening fails (private mode, etc.), don't poison later calls.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Run fn(store) inside a transaction. fn returns the request promise;
 * we resolve with its value once the transaction completes, so a failed
 * request rejects instead of resolving undefined.
 */
function tx(storeName, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        let reqPromise;
        try {
          const t = db.transaction(storeName, mode);
          const store = t.objectStore(storeName);
          reqPromise = fn(store);
          t.oncomplete = () => resolve(reqPromise);
          t.onerror = () => reject(t.error || new Error('idb-tx'));
          t.onabort = () => reject(t.error || new Error('idb-abort'));
        } catch (err) {
          reject(err);
        }
      }),
  );
}

export const idb = {
  /** Get one record by key. Resolves undefined when missing. */
  get(storeName, key) {
    return tx(storeName, 'readonly', (store) => promisify(store.get(key)));
  },
  /** Put (upsert) one record. */
  put(storeName, record) {
    return tx(storeName, 'readwrite', (store) => promisify(store.put(record)));
  },
  /** Delete one record by key. */
  del(storeName, key) {
    return tx(storeName, 'readwrite', (store) => promisify(store.delete(key)));
  },
  /** All records in a store (for pruning). */
  all(storeName) {
    return tx(storeName, 'readonly', (store) => promisify(store.getAll()));
  },
};

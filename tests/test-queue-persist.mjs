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
 * ImgFetch — tests/test-queue-persist.mjs
 * N4: the queue must be persisted IMMEDIATELY when a chromeDownloadId is
 * assigned. the pre-release code only scheduled a throttled (1 s) write — if the worker
 * died inside that window, the adopted download's id was never saved and
 * the item was re-queued (possible duplicate download).
 *
 * Contract: createQueuePersister({ getState, storage }) exposes
 *   schedule() — throttled write (unchanged old behavior), and
 *   flush()    — synchronous immediate write (N4: called by trackDownload).
 */
import { createQueuePersister } from '../core/queue-persist.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

const writes = [];
const storage = {
  set: (obj) => { writes.push({ ...obj, at: Date.now() }); return Promise.resolve(); },
};
const state = { items: [{ id: 'a', chromeDownloadId: null }] };
const getState = () => JSON.parse(JSON.stringify(state));

// 1. schedule() defers — the old throttled behavior is kept for bulk updates.
{
  writes.length = 0;
  const p = createQueuePersister({ getState, storage, delayMs: 1000 });
  p.schedule();
  p.schedule(); // second call coalesces
  check('schedule() does not write synchronously', writes.length === 0, `writes=${writes.length}`);
  p.dispose();
}

// 2. flush() writes immediately — N4.
{
  writes.length = 0;
  const p = createQueuePersister({ getState, storage, delayMs: 1000 });
  state.items[0].chromeDownloadId = 42; // trackDownload assigned the id
  p.flush(); // N4: persistQueueNow() in trackDownload
  check('flush() writes synchronously', writes.length === 1, `writes=${writes.length}`);
  check('flushed state carries the chromeDownloadId',
    writes[0] && writes[0]['imgfetch.queue'] && writes[0]['imgfetch.queue'].items[0].chromeDownloadId === 42);
  p.dispose();
}

// 3. flush() cancels a pending throttled write (no double write).
{
  writes.length = 0;
  const p = createQueuePersister({ getState, storage, delayMs: 50 });
  p.schedule();
  p.flush();
  await new Promise((r) => setTimeout(r, 120));
  check('flush() coalesces the pending schedule (one write)', writes.length === 1, `writes=${writes.length}`);
  p.dispose();
}

// 4. Old regression: schedule-only leaves the id unsaved inside the window.
{
  writes.length = 0;
  const p = createQueuePersister({ getState, storage, delayMs: 1000 });
  state.items[0].chromeDownloadId = 43;
  p.schedule(); // old code path: no flush
  const savedId = writes.length ? writes[0]['imgfetch.queue'].items[0].chromeDownloadId : null;
  check('schedule-only does NOT save the id synchronously (the N4 bug)', savedId !== 43);
  p.dispose();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

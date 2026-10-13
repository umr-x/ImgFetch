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
 * ImgFetch — tests/test-races.mjs
 * Pattern check #7: race tests with real timers against the real modules.
 *  - cancel() during an active download: in-flight finishes, nothing new
 *    starts, a failed in-flight item does NOT retry after cancel.
 *  - interleaved ZIP chunks across two tokens: aborting one token leaves
 *    the other intact (N2 token isolation under concurrency).
 *  - rapid schedule() bursts coalesce to one write (persist race).
 */
import { strict as assert } from 'node:assert';
import { DownloadQueue } from '../core/queue.js';
import { createZipAccumulator } from '../core/zip-accum.js';
import { createQueuePersister } from '../core/queue-persist.js';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); pass += 1; }
  catch (e) { fail += 1; console.log(`  FAIL ${name}: ${e.message}`); }
}

await test('race: cancel during active — in-flight finishes, nothing new starts', async () => {
  const started = [];
  const finished = [];
  const q = new DownloadQueue({
    concurrency: 1,
    maxAttempts: 2,
    starter: async (item) => {
      started.push(item.id);
      await new Promise((r) => setTimeout(r, 60));
      finished.push(item.id);
    },
  });
  q.enqueue([{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }, { id: 'c', label: 'c' }]);
  await new Promise((r) => setTimeout(r, 20)); // 'a' is active
  q.cancel();
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(started, ['a'], `only 'a' should have started, got ${started}`);
  assert.deepEqual(finished, ['a'], `in-flight 'a' finishes honestly`);
  const snap = q.snapshot();
  assert.equal(snap.items.find((i) => i.id === 'b').state, 'cancelled');
});

await test('race: failed in-flight does not retry after cancel', async () => {
  let attempts = 0;
  const q = new DownloadQueue({
    concurrency: 1,
    maxAttempts: 3,
    starter: async () => {
      attempts += 1;
      await new Promise((r) => setTimeout(r, 30));
      throw new Error('boom');
    },
  });
  q.enqueue([{ id: 'x', label: 'x' }]);
  await new Promise((r) => setTimeout(r, 10));
  q.cancel();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(attempts, 1, `no retry after cancel, got ${attempts} attempts`);
  assert.equal(q.snapshot().items[0].state, 'failed');
});

await test('race: interleaved ZIP chunks — abort one token, other survives', async () => {
  const za = createZipAccumulator();
  const a = za.get('tok-a');
  const b = za.get('tok-b');
  a.entries.push({ name: 'a1', data: new Uint8Array(10) }); a.total += 10;
  b.entries.push({ name: 'b1', data: new Uint8Array(20) }); b.total += 20;
  a.entries.push({ name: 'a2', data: new Uint8Array(10) }); a.total += 10;
  za.abort('tok-a'); // chunk failure on A mid-build
  assert.equal(za.tokenCount(), 1);
  assert.equal(za.retainedBytes(), 20);
  const taken = za.take('tok-b');
  assert.equal(taken.entries.length, 1);
  assert.equal(taken.entries[0].name, 'b1');
  assert.equal(za.tokenCount(), 0);
});

await test('race: 100 rapid schedule() calls coalesce to one write', async () => {
  let writes = 0;
  const p = createQueuePersister({
    getState: () => ({}),
    storage: { set: () => { writes += 1; return Promise.resolve(); } },
    delayMs: 40,
  });
  for (let i = 0; i < 100; i += 1) p.schedule();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(writes, 1, `expected 1 write, got ${writes}`);
  p.dispose();
});

await test('race: enqueue after cancel resumes only the new item', async () => {
  // Designed behavior: enqueue() and retryFailed() are the resume paths —
  // otherwise no download could ever start again after one cancel.
  // Previously-cancelled items must stay cancelled.
  const started = [];
  const q = new DownloadQueue({
    concurrency: 1,
    starter: async (item) => {
      started.push(item.id);
      await new Promise((r) => setTimeout(r, 80)); // slow: still active at cancel
    },
  });
  q.enqueue([{ id: 'old', label: 'old' }, { id: 'older', label: 'older' }]);
  await new Promise((r) => setTimeout(r, 10)); // 'old' active, 'older' pending
  q.cancel(); // 'older' -> cancelled
  q.enqueue([{ id: 'z', label: 'z' }]);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(started, ['old', 'z'], `got ${started}`);
  assert.equal(q.snapshot().items.find((i) => i.id === 'older').state, 'cancelled');
});

// F6: buildMenus serialization. Two overlapping calls must not interleave
// removeAll/create. Uses the same promise-chain pattern as the worker.
await test('race: serialized menu builds do not interleave', async () => {
  const calls = [];
  let chain = Promise.resolve();
  const inner = async (tag) => {
    calls.push(`${tag}:removeAll`);
    await new Promise((r) => setTimeout(r, 20)); // simulate async work
    calls.push(`${tag}:create`);
  };
  const buildMenus = (tag) => {
    const run = chain.then(() => inner(tag));
    chain = run.catch(() => {});
    return run;
  };
  await Promise.all([buildMenus('A'), buildMenus('B')]);
  // Without serialization this would be A:removeAll, B:removeAll, A:create, B:create.
  // With serialization: A:removeAll, A:create, B:removeAll, B:create.
  assert.deepEqual(calls, [
    'A:removeAll', 'A:create',
    'B:removeAll', 'B:create',
  ], `got ${calls.join(', ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

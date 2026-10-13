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
 * ImgFetch — tests/test-zip-accum.mjs
 * N2: a failed multi-chunk ZIP must leave ZERO retained entries in the
 * offscreen accumulator. the pre-release code had no ZIP_ABORT and no TTL — accumulated
 * chunks (up to 300 MB) stayed until the offscreen document closed.
 */
import { createZipAccumulator, ZIP_ACCUM_TTL_MS } from '../core/zip-accum.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

// 1. Abort after partial chunks leaves nothing retained.
{
  const za = createZipAccumulator();
  const acc = za.get('tok-1');
  acc.entries.push({ name: 'a.jpg', data: new Uint8Array(10) });
  acc.total += 10;
  const acc2 = za.get('tok-2');
  acc2.entries.push({ name: 'b.jpg', data: new Uint8Array(20) });
  acc2.total += 20;
  check('two tokens accumulated', za.tokenCount() === 2 && za.retainedBytes() === 30);
  za.abort('tok-1'); // N2: worker sends ZIP_ABORT on failure/cancel
  check('abort drops the token', za.tokenCount() === 1, `tokens=${za.tokenCount()}`);
  check('aborted bytes released', za.retainedBytes() === 20, `bytes=${za.retainedBytes()}`);
}

// 2. TTL: stale tokens are swept even if abort was never sent.
{
  const za = createZipAccumulator(120_000);
  check('TTL is 2 minutes', ZIP_ACCUM_TTL_MS === 120_000, `ttl=${ZIP_ACCUM_TTL_MS}`);
  const acc = za.get('tok-old');
  acc.entries.push({ name: 'x.jpg', data: new Uint8Array(100) });
  acc.total += 100;
  // Simulate 3 minutes passing without any abort.
  za.sweep(Date.now() + 180_000);
  check('stale token swept by TTL', za.tokenCount() === 0, `tokens=${za.tokenCount()}`);
  check('stale bytes released', za.retainedBytes() === 0);
}

// 3. Fresh tokens survive the sweep.
{
  const za = createZipAccumulator(120_000);
  za.get('tok-fresh');
  za.sweep(Date.now() + 60_000);
  check('fresh token survives sweep', za.tokenCount() === 1);
}

// 4. take() removes and returns for the final build.
{
  const za = createZipAccumulator();
  const acc = za.get('tok-final');
  acc.entries.push({ name: 'z.jpg', data: new Uint8Array(5) });
  const taken = za.take('tok-final');
  check('take returns entries', taken && taken.entries.length === 1);
  check('take removes token', za.tokenCount() === 0 && za.retainedBytes() === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

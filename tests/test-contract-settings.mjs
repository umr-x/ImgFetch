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
 * ImgFetch — tests/test-contract-settings.mjs
 * Contract: the settings schema (core/settings.js) is the producer, the
 * options page and the worker are consumers. normalizeSettings() must:
 *  - round-trip DEFAULT_SETTINGS unchanged,
 *  - never throw on garbage input and always return a complete, valid
 *    settings object (all DEFAULT keys present, enums in range),
 *  - drop unknown keys and coerce wrong types.
 * Fuzz uses a fixed seed (deterministic).
 */
import { DEFAULT_SETTINGS, normalizeSettings, SETTINGS_VERSION } from '../core/settings.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1. Round-trip: defaults normalize to themselves.
{
  const n = normalizeSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  const keys = Object.keys(DEFAULT_SETTINGS);
  check('version preserved', n.version === SETTINGS_VERSION);
  check('all default keys present', keys.every((k) => k in n), `missing: ${keys.filter((k) => !(k in n)).join(',')}`);
  check('defaults unchanged', JSON.stringify(n) === JSON.stringify(DEFAULT_SETTINGS));
}

// 2. Garbage fuzz: never throws, always complete and valid.
{
  const rand = rng32(20261005);
  const garbagePool = [null, undefined, 0, 1, -1, NaN, Infinity, '', 'x', [], [1, 2],
    {}, { a: 1 }, true, false, 1e308, -1e308, '\0', '🔥'.repeat(100)];
  const pick = () => garbagePool[Math.floor(rand() * garbagePool.length)];
  const keys = Object.keys(DEFAULT_SETTINGS);
  let threw = 0;
  for (let i = 0; i < 2000; i += 1) {
    const obj = {};
    for (const k of keys) if (rand() < 0.7) obj[k] = pick();
    if (rand() < 0.3) obj[`unknown_${i}`] = pick();
    let n;
    try {
      n = normalizeSettings(obj);
    } catch {
      threw += 1;
      continue;
    }
    if (!keys.every((k) => k in n)) { check(`complete keys (iter ${i})`, false); break; }
    if (typeof n.maxConcurrent !== 'number' || n.maxConcurrent < 1) { check(`maxConcurrent valid (iter ${i})`, false); break; }
  }
  check('never throws on garbage (2000 cases)', threw === 0, `threw=${threw}`);
}

// 3. Wrong types are coerced/clamped; unknown keys are preserved for
// forward compatibility (a newer version's keys survive a downgrade).
{
  const n = normalizeSettings({ theme: 'neon', maxConcurrent: '99', saveAsDialog: 'yes', nope: 1 });
  check('bad enum falls back to default', n.theme === DEFAULT_SETTINGS.theme);
  check('numeric string coerced then clamped to 1..6', n.maxConcurrent === 6);
  check('truthy string is not true', n.saveAsDialog === false);
  check('unknown key preserved (forward-compat)', n.nope === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

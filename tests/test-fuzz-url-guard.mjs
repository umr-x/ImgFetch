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
 * ImgFetch — tests/test-fuzz-url-guard.mjs
 * N3 + pattern check #5: fuzz the private-network URL guard over thousands
 * of IP spellings with a FIXED seed (deterministic). Every spelling of a
 * private IP must be blocked; every spelling of a public IP must stay
 * allowed. The WHATWG URL parser canonicalizes host spellings (hex/octal/
 * integer IPv4 -> dotted decimal, IPv6 -> lowercase groups), so the guard
 * only ever sees normalized forms — the fuzz proves no spelling slips
 * through that normalization.
 */
import { isPrivateNetworkUrl } from '../core/urls.js';

// Deterministic PRNG (mulberry32), fixed seed.
function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng32(1337); // fixed seed — deterministic fuzz
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const PRIVATE_V4 = [[10, 1, 2, 3], [172, 20, 5, 6], [192, 168, 1, 1], [127, 0, 0, 1], [169, 254, 9, 9], [100, 70, 1, 2], [0, 0, 0, 0]];
const PUBLIC_V4 = [[8, 8, 8, 8], [1, 1, 1, 1], [93, 184, 216, 34], [151, 101, 1, 69]];

function v4Spellings([a, b, c, d]) {
  const hex = (n) => '0x' + n.toString(16);
  const oct = (n) => '0' + n.toString(8);
  const int32 = ((a * 256 + b) * 256 + c) * 256 + d;
  return [
    `${a}.${b}.${c}.${d}`,
    `${hex(a)}.${hex(b)}.${hex(c)}.${hex(d)}`,
    `${oct(a)}.${oct(b)}.${oct(c)}.${oct(d)}`,
    `${int32}`,
    `0x${int32.toString(16)}`,
    `${hex(a)}.${b}.${c}.${d}`, // mixed
    `${a}.${b}.${c}.${d}.`, // trailing dot
  ];
}

function v6Spellings([a, b, c, d]) {
  const g6 = ((a << 8) | b).toString(16);
  const g7 = ((c << 8) | d).toString(16);
  const dotted = `${a}.${b}.${c}.${d}`;
  return [
    `[::ffff:${g6}:${g7}]`, // mapped, hex groups
    `[::ffff:${dotted}]`, // mapped, dotted tail
    `[::${g6}:${g7}]`, // compatible
    `[64:ff9b::${g6}:${g7}]`, // NAT64
    `[64:ff9b::${dotted}]`, // NAT64, dotted tail
    `[2002:${g6}:${g7}::]`, // 6to4
    `[2002:${g6}:${g7}::1]`, // 6to4, subnet/host bits set
  ];
}

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond) {
  if (cond) { pass += 1; }
  else { fail += 1; if (failures.length < 10) failures.push(name); }
}

const CASES = 3000;
for (let i = 0; i < CASES; i += 1) {
  const priv = rand() < 0.5;
  const ip = pick(priv ? PRIVATE_V4 : PUBLIC_V4);
  const spellings = [...v4Spellings(ip), ...v6Spellings(ip)];
  // Random case mangling (URL lowercases the host anyway).
  const s = pick(spellings);
  const mangled = rand() < 0.3 ? s.toUpperCase().replace('HTTP', 'http') : s;
  const url = `http://${mangled}/img.jpg`;
  let got;
  try { got = isPrivateNetworkUrl(url); } catch { got = 'threw'; }
  check(`${priv ? 'blocked' : 'allowed'} ${url}`, got === priv);
}

console.log(`\n${pass} passed, ${fail} failed over ${CASES} fuzz cases`);
if (failures.length) { console.log('First failures:'); for (const f of failures) console.log(`  FAIL ${f}`); }
process.exit(fail ? 1 : 0);

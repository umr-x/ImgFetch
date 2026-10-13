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
 * ImgFetch — tests/test-urls-ipv6.mjs
 * N3: the IPv6 private-network guard must also block IPv4-compatible
 * (::127.0.0.1), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) by extracting
 * the embedded IPv4 and re-checking it. the pre-release code let all three through.
 * Public URLs must stay allowed.
 */
import { isPrivateNetworkUrl } from '../core/urls.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

// N3: must be blocked (private).
const blocked = [
  'http://[::127.0.0.1]/x.jpg', // IPv4-compatible
  'http://[::ffff:127.0.0.1]/x.jpg', // IPv4-mapped (already blocked in the pre-release code)
  'http://[64:ff9b::7f00:1]/x.jpg', // NAT64 -> 127.0.0.1
  'http://[64:ff9b::c0a8:101]/x.jpg', // NAT64 -> 192.168.1.1
  'http://[2002:7f00:1::]/x.jpg', // 6to4 -> 127.0.0.1
  'http://[2002:c0a8:101::]/x.jpg', // 6to4 -> 192.168.1.1
  'http://[::1]/x.jpg',
  'http://[::]/x.jpg',
  'http://[fe80::1]/x.jpg',
  'http://[fd00::1]/x.jpg',
  'http://127.0.0.1/x.jpg',
  'http://[64:FF9B::7F00:1]/x.jpg', // uppercase NAT64
  'http://[2002:7F00:1::]/x.jpg', // uppercase 6to4
];
for (const u of blocked) check(`blocked ${u}`, isPrivateNetworkUrl(u) === true);

// Public URLs must stay allowed.
const allowed = [
  'https://example.com/x.jpg',
  'https://8.8.8.8/x.jpg',
  'http://[2001:db8::1]/x.jpg', // documentation range
  'http://[2606:4700:4700::1111]/x.jpg', // public IPv6
  'http://[64:ff9b::808:808]/x.jpg', // NAT64 -> 8.8.8.8 (public)
  'http://[2002:808:808::]/x.jpg', // 6to4 -> 8.8.8.8 (public)
  'http://[::808:808]/x.jpg', // IPv4-compatible -> 8.8.8.8 (public)
  'http://[::ffff:808:808]/x.jpg', // IPv4-mapped -> 8.8.8.8 (public)
];
for (const u of allowed) check(`allowed ${u}`, isPrivateNetworkUrl(u) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

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
 * ImgFetch — tests/test-contract-filename.mjs
 * Contract: buildFilename() (producer — scanner/popup side) -> the real
 * output fed into joinDownloadPath() (consumer — the chrome.downloads
 * path). The joined path must never escape the Downloads folder, never be
 * absolute, and always keep a safe extension — over hostile names
 * (Urdu, emoji, 200-char, ../, reserved names, control chars).
 */
import { buildFilename, joinDownloadPath } from '../core/filenames.js';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass += 1; }
  else { fail += 1; if (failures.length < 12) failures.push(`${name}${extra ? ` — ${extra}` : ''}`); }
}

const hostileNames = [
  '../../../etc/passwd',
  '..\\..\\windows\\system32',
  'C:\\Users\\x\\evil',
  '/absolute/path',
  'CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1',
  'a'.repeat(200),
  'تصویر نمبر 1 📸🎉',
  'emoji-🖼️-name',
  'name\x00with\x1fcontrols',
  'trailing...',
  '  spaces  ',
  '.hidden',
  'double..dots',
  'semi;colon',
  'quote"tick\'',
  'star*wars?.jpg',
  'pipe|name',
  '<tag>name',
  'ünïcödé-ß-名-前',
  '....',
  '',
];

const folders = ['', 'mysite', '../escape', 'a/b/c/d/e', 'sub\\dir', '...', 'ok-folder'];

let n = 0;
for (const name of hostileNames) {
  for (const mode of ['original', 'site', 'custom']) {
    for (const folder of folders) {
      n += 1;
      const built = buildFilename(mode, {
        site: 'example.com', name, ext: 'jpg', num: 7,
        custom: '{site} - {name} - {num}', date: new Date('2026-10-05T12:00:00Z'),
      });
      const joined = joinDownloadPath(folder, built);
      const parts = joined.split('/');
      check(`no traversal [${name.slice(0, 20)}|${folder}]`, !parts.includes('..') && !joined.includes('\\'), joined);
      check(`not absolute [${name.slice(0, 20)}]`, !joined.startsWith('/'), joined);
      check(`safe ext [${name.slice(0, 20)}]`, /\.(png|jpg|jpeg|webp|avif|gif|bmp|svg|zip)$/i.test(joined), joined);
      check(`non-empty [${name.slice(0, 20)}]`, joined.length > 4, joined);
      check(`bounded length [${name.slice(0, 20)}]`, joined.length <= 260, `len=${joined.length}`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed over ${n} producer->consumer cases`);
if (failures.length) { console.log('First failures:'); for (const f of failures) console.log(`  FAIL ${f}`); }
process.exit(fail ? 1 : 0);

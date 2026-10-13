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
 * ImgFetch — tests/test-svg-real-dom.mjs
 * Pattern check #6: the SVG sanitizer must ALSO pass against a REAL DOM.
 * test-svg.mjs uses a stub DOM; this file parses every attack payload with
 * jsdom's real DOMParser (image/svg+xml), runs the REAL sanitizeSvgDocument
 * from core/svg.js, and asserts the serialized output is inert.
 *
 * Requires jsdom: npm i jsdom   (kept out of the shipped zip)
 * Usage: NODE_PATH=~/workspace/imgfetch-testdeps/node_modules node tests/test-svg-real-dom.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.log('SKIPPED: jsdom not installed (npm i jsdom to run the real-DOM suite)');
  process.exit(0);
}
import { sanitizeSvgDocument } from '../core/svg.js';

const dom = new JSDOM('', { contentType: 'text/html' });
const parser = new dom.window.DOMParser();
const serializer = new dom.window.XMLSerializer();

function sanitize(svgText) {
  const doc = parser.parseFromString(svgText, 'image/svg+xml');
  const removed = sanitizeSvgDocument(doc);
  return { out: serializer.serializeToString(doc), removed };
}

const PAYLOADS = [
  ['tab in javascript:', '<svg xmlns="http://www.w3.org/2000/svg"><a href="java\tscript:alert(1)"><text>x</text></a></svg>'],
  ['newline in javascript:', '<svg xmlns="http://www.w3.org/2000/svg"><a href="java\nscript:alert(1)"><text>x</text></a></svg>'],
  ['mixed case JavaScript:', '<svg xmlns="http://www.w3.org/2000/svg"><a href="JaVaScRiPt:alert(1)"><text>x</text></a></svg>'],
  ['<set> href retarget', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/><set attributeName="href" to="javascript:alert(1)"/></svg>'],
  ['<animate> href retarget', '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href" values="javascript:alert(1)" dur="1s"/></svg>'],
  ['foreignObject+iframe', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="10" height="10"><iframe src="https://evil.example/"/></foreignObject></svg>'],
  ['xhtml script', '<svg xmlns="http://www.w3.org/2000/svg"><script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script></svg>'],
  ['plain script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
  ['style @import', '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url("https://evil.example/x.css");</style></svg>'],
  ['CDATA style', '<svg xmlns="http://www.w3.org/2000/svg"><style><![CDATA[@import "https://evil.example/y.css";]]></style></svg>'],
  ['style attr url()', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" style="fill: url(javascript:alert(1))"/></svg>'],
  ['data:svg with script', '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml,<svg><script>alert(1)</script></svg>"/></svg>'],
  ['data:text/html', '<svg xmlns="http://www.w3.org/2000/svg"><a href="data:text/html,<script>alert(1)</script>"><text>x</text></a></svg>'],
  ['XML entity', '<svg xmlns="http://www.w3.org/2000/svg"><!DOCTYPE svg [<!ENTITY x "javascript:alert(1)">]><a href="&x;"><text>x</text></a></svg>'],
  ['onload handler', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" onload="alert(1)"/></svg>'],
  ['embed/object', '<svg xmlns="http://www.w3.org/2000/svg"><embed src="https://evil.example/x"/><object data="https://evil.example/y"/></svg>'],
  ['handler+xml mime trick', '<svg xmlns="http://www.w3.org/2000/svg"><a href="JaVa\tScRiPt\n:alert(1)"><text>x</text></a></svg>'],
];

function inert(out) {
  const flat = out.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
  const problems = [];
  if (/<script[\s>]/.test(out.toLowerCase())) problems.push('<script> present');
  if (flat.includes('javascript:')) problems.push('javascript: present');
  if (/\son[a-z]+\s*=/i.test(out)) problems.push('event handler present');
  if (/<(foreignobject|iframe|embed|object)[\s>]/i.test(out)) problems.push('active element present');
  if (flat.includes('data:text/html')) problems.push('data:text/html present');
  return problems;
}

let pass = 0;
let fail = 0;
for (const [name, payload] of PAYLOADS) {
  const { out, removed } = sanitize(payload);
  const problems = inert(out);
  if (problems.length === 0) { pass += 1; }
  else { fail += 1; console.log(`  FAIL ${name}: ${problems.join('; ')}`); }
}

// A normal SVG with gradient, viewBox and text must survive unchanged.
{
  const normal = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><text x="10" y="20">Hello</text></svg>';
  const { out } = sanitize(normal);
  const ok = out.includes('linearGradient') && out.includes('viewBox="0 0 100 100"')
    && out.includes('Hello') && out.includes('stop-color="red"');
  if (ok) { pass += 1; } else { fail += 1; console.log('  FAIL normal SVG was mangled'); }
}

console.log(`\n${pass} passed, ${fail} failed (real DOM via jsdom)`);
process.exit(fail ? 1 : 0);

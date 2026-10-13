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
 * ImgFetch SVG sanitizer tests — runs with plain Node, no dependencies:
 *   node tests/test-svg.mjs
 *
 * B4 (ROUND 2): the old sanitizer was a denylist with known bypasses.
 * These tests run every payload from the review against the sanitizer and
 * assert the payload is neutralized, while normal SVGs survive unchanged
 * in appearance. The stub DOM below implements just what
 * core/svg.js needs (querySelectorAll, attributes, remove/removeAttribute,
 * textContent) — the policy code is the real thing.
 */
import { strict as assert } from 'node:assert';
import { sanitizeSvgDocument, isSafeSvgUrl } from '../core/svg.js';

// ---------------------------------------------------------------- stub DOM

function makeEl(tag, attrs, parent) {
  const el = {
    tagName: tag,
    attributes: [],
    childNodes: [],
    parentNode: parent || null,
    get textContent() {
      return this.childNodes.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    },
    set textContent(v) {
      this.childNodes = [String(v)];
    },
    remove() {
      if (this.parentNode) {
        const i = this.parentNode.childNodes.indexOf(this);
        if (i !== -1) this.parentNode.childNodes.splice(i, 1);
      }
    },
    removeAttribute(name) {
      this.attributes = this.attributes.filter((a) => a.name !== name);
    },
    setAttribute(name, value) {
      const a = this.attributes.find((a) => a.name === name);
      if (a) a.value = String(value);
      else this.attributes.push({ name, value: String(value) });
    },
    getAttribute(name) {
      const a = this.attributes.find((a) => a.name === name);
      return a ? a.value : null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const c of node.childNodes) {
          if (typeof c === 'string') continue;
          if (sel === '*' || c.tagName.toLowerCase() === sel.toLowerCase()) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
  };
  for (const [k, v] of attrs) el.attributes.push({ name: k, value: v });
  return el;
}

/** Tiny XML parser — enough for the flat test payloads below. */
function parseStubXml(xml) {
  const root = makeEl('#document', [], null);
  const stack = [root];
  const re = /<(\/?)([A-Za-z][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[5] !== undefined) {
      if (m[5]) stack[stack.length - 1].childNodes.push(m[5]);
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2];
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = [];
    const are = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let am;
    while ((am = are.exec(m[3] || ''))) attrs.push([am[1], am[3] !== undefined ? am[3] : am[4]]);
    const el = makeEl(tag, attrs, stack[stack.length - 1]);
    stack[stack.length - 1].childNodes.push(el);
    if (m[4] !== '/') stack.push(el);
  }
  return { querySelectorAll: (sel) => root.querySelectorAll(sel) };
}

function sanitize(xml) {
  const doc = parseStubXml(xml);
  sanitizeSvgDocument(doc);
  return doc;
}

function findTag(doc, tag) {
  return doc.querySelectorAll('*').filter((e) => e.tagName.toLowerCase() === tag.toLowerCase());
}

function htmlOf(doc) {
  // crude serializer for assertions
  const ser = (node) => {
    if (typeof node === 'string') return node;
    const attrs = node.attributes.map((a) => ` ${a.name}="${a.value}"`).join('');
    const kids = node.childNodes.map(ser).join('');
    return `<${node.tagName}${attrs}>${kids}</${node.tagName}>`;
  };
  return doc.querySelectorAll('*').map(ser).join('');
}

// ---------------------------------------------------------------- harness

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push(`${name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- payloads

await test('B4: tab inside javascript: URL is neutralized', () => {
  const doc = sanitize('<svg xmlns="http://www.w3.org/2000/svg"><a href="java\tscript:alert(1)"><text>x</text></a></svg>');
  const a = findTag(doc, 'a');
  assert.equal(a.length, 1, 'the link element itself is harmless and stays');
  assert.equal(a[0].getAttribute('href'), null, 'tab-obfuscated javascript: href must be removed');
});

await test('B4: newline inside javascript: URL is neutralized', () => {
  const doc = sanitize('<svg xmlns="http://www.w3.org/2000/svg"><a href="java\nscript:alert(1)"><text>x</text></a></svg>');
  assert.equal(findTag(doc, 'a')[0].getAttribute('href'), null);
});

await test('B4: <set> targeting href is removed', () => {
  const doc = sanitize('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/><set attributeName="href" to="javascript:alert(1)"/></svg>');
  assert.equal(findTag(doc, 'set').length, 0, '<set> must be gone');
  assert.equal(findTag(doc, 'rect').length, 1, 'innocent rect stays');
});

await test('B4: <animate> targeting href is removed', () => {
  const doc = sanitize('<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href" values="javascript:alert(1)" dur="1s"/></svg>');
  assert.equal(findTag(doc, 'animate').length, 0);
});

await test('B4: innocent <animate> (opacity) survives', () => {
  const doc = sanitize('<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"><animate attributeName="opacity" values="0;1" dur="1s"/></circle></svg>');
  assert.equal(findTag(doc, 'animate').length, 1, 'non-href animation is harmless and stays');
});

await test('B4: foreignObject with iframe is removed', () => {
  const doc = sanitize('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="10" height="10"><iframe src="https://evil.example/"/></foreignObject><rect width="5" height="5"/></svg>');
  assert.equal(findTag(doc, 'foreignObject').length, 0);
  assert.equal(findTag(doc, 'iframe').length, 0);
  assert.equal(findTag(doc, 'rect').length, 1);
});

await test('B4: script/embed/object are removed', () => {
  const doc = sanitize('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><embed src="https://evil.example/x"/><object data="https://evil.example/y"/><circle r="3"/></svg>');
  for (const t of ['script', 'embed', 'object']) assert.equal(findTag(doc, t).length, 0, `<${t}> must be gone`);
  assert.equal(findTag(doc, 'circle').length, 1);
});

await test('B4: event handler attributes are removed', () => {
  const doc = sanitize('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" onload="alert(1)" fill="red"/></svg>');
  const rect = findTag(doc, 'rect')[0];
  assert.equal(rect.getAttribute('onload'), null);
  assert.equal(rect.getAttribute('fill'), 'red', 'safe attributes stay');
});

await test('B4: @import and external url() in <style> are stripped', () => {
  const doc = sanitize('<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/x.css); .a { fill: url(https://evil.example/g.png); } .b { fill: url(#grad); }</style><rect width="5" height="5"/></svg>');
  const css = findTag(doc, 'style')[0].textContent;
  assert.ok(!/@import/i.test(css), '@import must be gone');
  assert.ok(!/evil\.example/.test(css), 'external url() must be gone');
  assert.ok(/url\(#grad\)/.test(css), 'local fragment url() must survive');
});

await test('B4: normal SVG artwork survives unchanged in appearance', () => {
  const doc = sanitize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><use href="#icon"/><text x="10" y="20" font-size="12">hi</text><image href="https://cdn.example/p.png" width="10" height="10"/></svg>');
  for (const t of ['linearGradient', 'stop', 'rect', 'use', 'text', 'image']) {
    assert.ok(findTag(doc, t).length > 0, `<${t}> must survive`);
  }
  assert.equal(findTag(doc, 'rect')[0].getAttribute('fill'), 'url(#g)');
  assert.equal(findTag(doc, 'use')[0].getAttribute('href'), '#icon');
  assert.equal(findTag(doc, 'image')[0].getAttribute('href'), 'https://cdn.example/p.png');
  assert.equal(findTag(doc, 'svg')[0].getAttribute('viewBox'), '0 0 100 100');
});

await test('B4: isSafeSvgUrl allows #fragment, http(s), data:image', () => {
  assert.equal(isSafeSvgUrl('#icon'), true);
  assert.equal(isSafeSvgUrl('https://cdn.example/a.png'), true);
  assert.equal(isSafeSvgUrl('http://cdn.example/a.png'), true);
  assert.equal(isSafeSvgUrl('data:image/png;base64,iVBORw0KGgo='), true);
  assert.equal(isSafeSvgUrl('java\tscript:alert(1)'), false);
  assert.equal(isSafeSvgUrl('javascript:alert(1)'), false);
  assert.equal(isSafeSvgUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeSvgUrl('ftp://example.com/a.png'), false);
  assert.equal(isSafeSvgUrl(''), false);
});

await test('B4: data:image/svg+xml carrying a script is rejected', () => {
  assert.equal(isSafeSvgUrl('data:image/svg+xml,<svg><script>alert(1)</script></svg>'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}

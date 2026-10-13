#!/usr/bin/env node
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
 * ImgFetch — scripts/check-duplicates.mjs
 * Pattern check #1: single source of truth. Every shared numeric limit,
 * key string and rule function must be defined ONCE (in its canonical
 * module) and imported everywhere else. A second literal copy of the same
 * rule is how N1 happened (planner 32767 vs stitcher 12000).
 *
 * Fails the build (exit 1) when:
 *  1. A registered limit's literal value appears in any project JS file
 *     other than its canonical module (tests/ may use literals).
 *  2. A registered constant/rule name is defined (const/let NAME =) in more
 *     than one project file.
 *  3. A message type handled by a router (case 'X':) is missing from
 *     MESSAGE_TYPES in core/validation.js (the AGENTS.md two-place rule).
 *
 * Usage: node scripts/check-duplicates.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function jsFiles(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      // tests/ may use literals freely; dist/ is build output.
      if (relative(ROOT, p) === 'tests' || relative(ROOT, p) === 'dist') continue;
      jsFiles(p, out);
    } else if (e.endsWith('.js') || e.endsWith('.mjs')) {
      if (relative(ROOT, p).startsWith('tests/')) continue;
      if (relative(ROOT, p) === 'scripts/check-duplicates.mjs') continue; // self
      out.push(p);
    }
  }
  return out;
}

// { name, canonical (relative), literals: [source spellings that may appear] }
const LIMITS = [
  { name: 'FULLPAGE_MAX_SIDE', canonical: 'core/fullpage-capture.js', literals: ['32767'] },
  { name: 'FULLPAGE_MAX_AREA', canonical: 'core/fullpage-capture.js', literals: ['100_000_000', '100000000'],
    allowSameValue: ['offscreen/offscreen.js /* GIF_PROBE_MAX_BYTES: distinct 100 MB fetch cap */'] },
  { name: 'FULLPAGE_MAX_TILES', canonical: 'core/fullpage-capture.js', literals: [] }, // value too common; name check only
  { name: 'ZIP_ACCUM_TTL_MS', canonical: 'core/zip-accum.js', literals: ['120_000', '120000'],
    allowSameValue: ['core/scan-state.js /* SCAN_STATE_STALE_MS: distinct 2-min scan staleness */'] },
  { name: 'QUEUE_SESSION_KEY', canonical: 'core/queue-persist.js', literals: ["'imgfetch.queue'", '"imgfetch.queue"'] },
  { name: 'SCAN_STATE_STALE_MS', canonical: 'core/scan-state.js', literals: [],
    allowSameValue: ['core/zip-accum.js /* ZIP_ACCUM_TTL_MS: distinct 2-min zip TTL */'] },
];

// Rule functions that must have exactly one definition.
const RULES = [
  'isStitchSizeAccepted',
  'isPrivateIPv4Octets',
  'isPrivateNetworkUrl',
  'createZipAccumulator',
  'createQueuePersister',
  'planFullPageCapture',
];

const files = jsFiles(ROOT);
const src = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const rel = (f) => relative(ROOT, f);
let failures = 0;
const fail = (msg) => { failures += 1; console.log(`  DUPLICATE-RULE FAIL: ${msg}`); };

console.log('check-duplicates: single source of truth');

for (const lim of LIMITS) {
  // 1. literal value must not appear outside the canonical module
  for (const lit of lim.literals) {
    for (const [f, text] of src) {
      if (rel(f) === lim.canonical) continue;
      const allowedFiles = (lim.allowSameValue || []).map((a) => a.split(' /*')[0]);
      if (allowedFiles.includes(rel(f))) continue;
      // ignore comments-only lines? No — a literal in a comment is still a
      // smell, but allow it to avoid false positives on docs.
      const lines = text.split('\n').filter((l) => l.includes(lit) && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
      if (lines.length) {
        fail(`${lim.name}: literal ${lit} also in ${rel(f)} (canonical: ${lim.canonical})`);
      }
    }
  }
  // 2. constant name defined exactly once
  const defs = [];
  const defRe = new RegExp(`\\b(?:export\\s+)?const\\s+${lim.name}\\b`);
  for (const [f, text] of src) if (defRe.test(text)) defs.push(rel(f));
  if (defs.length !== 1) {
    fail(`${lim.name}: defined ${defs.length}x (${defs.join(', ') || 'nowhere'})`);
  }
}

for (const rule of RULES) {
  const defs = [];
  const defRe = new RegExp(`\\bfunction\\s+${rule}\\b|\\bconst\\s+${rule}\\s*=`);
  for (const [f, text] of src) if (defRe.test(text)) defs.push(rel(f));
  if (defs.length !== 1) {
    fail(`rule ${rule}: defined ${defs.length}x (${defs.join(', ') || 'nowhere'})`);
  }
}

// 3. every router case 'X' must be in MESSAGE_TYPES (two-place rule).
// The offscreen document has its OWN internal dispatcher (service-worker.js
// ignores target:'offscreen' messages) — exempt from the runtime allowlist.
const RUNTIME_ROUTERS = ['background/service-worker.js', 'popup/popup.js'];
const validationSrc = src.get(join(ROOT, 'core/validation.js')) || '';
const typeSet = new Set([...validationSrc.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]));
for (const [f, text] of src) {
  if (!RUNTIME_ROUTERS.includes(rel(f))) continue;
  for (const m of text.matchAll(/case\s+'([A-Z][A-Z0-9_]+)'\s*:/g)) {
    const t = m[1];
    if (!typeSet.has(t)) {
      fail(`message type '${t}' handled in ${rel(f)} but missing from MESSAGE_TYPES`);
    }
  }
}

if (failures) {
  console.log(`\n${failures} single-source violation(s) — build FAILED`);
  process.exit(1);
}
console.log('OK: all shared limits and rules have a single source of truth');

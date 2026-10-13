# Audit round 3: fixes

Every finding from all three audits (H1–L12 round 1, B1–B6 round 2,
N1–N5 round 3), with status, files changed, and the proving test.
"E2E" = real Chromium via Playwright (xvfb), "UNIT" = node test files.

## Round-3 findings (this round)

### N1 (HIGH) — planner/stitcher size-limit disagreement — FIXED
- **Bug:** `core/fullpage-capture.js` allowed 32,767 px sides / 100 MP;
  `offscreen/offscreen.js` had a private `STITCH_MAX_SIDE = 12000` and threw
  `bad-size`. Tall pages failed on DPR 2 (a regression vs the earlier pre-release build).
- **Fix:** one shared rule — `isStitchSizeAccepted()` in
  `core/fullpage-capture.js`, imported by the offscreen stitcher; the
  private 12000 const is deleted. The planner additionally trims rounding
  overshoot (contract test caught 100,004,446 > 100,000,000) so its output
  ALWAYS satisfies the shared rule. `scripts/check-duplicates.mjs` fails
  the build if a second literal copy ever appears.
- **Files:** `core/fullpage-capture.js`, `offscreen/offscreen.js`,
  `scripts/check-duplicates.mjs`
- **Proof:**
  - UNIT (failing first): `tests/test-contract-fullpage.mjs` — 54 passed,
    **81 failed** on the pre-release build (planner output vs the old stitcher rule).
  - UNIT (after fix): **135 passed, 0 failed** (grid: heights 1k–60k CSS px
    × 3 viewports × DPR 1/1.25/1.5/2/3, planner output vs shared rule).
  - MUTATION: trim removed → 133 passed, 2 failed (rounding overshoot).
  - REGRESSION: `scripts/regression-diff.mjs` — 31 cases where the earlier build worked
    but the later pre-release build broke are fixed; 0 cases worse.
  - E2E: P3 stitches a 20,000 px page through the REAL offscreen document
    (STITCH_BEGIN/TILE/END) with real pixels — see TEST_REPORT.md.
    (Tile *capture* via captureVisibleTab needs a user gesture — NOT_TESTED.md.)

### N2 (LOW) — failed ZIP leaks accumulated chunks — FIXED
- **Bug:** `zipAccums` entries (up to 300 MB) were deleted only on a
  successful final build; chunk failure/throw/cancel leaked them.
- **Fix:** accumulator extracted to `core/zip-accum.js` with `abort(token)`
  + 2-minute TTL `sweep()`; new `ZIP_ABORT` offscreen message (handled in
  the offscreen dispatcher; the worker router ignores `target:'offscreen'`
  so no MESSAGE_TYPES entry is needed); the worker sends `ZIP_ABORT` in the
  chunk loop's catch and stops a cancelled build between chunks
  (`queue.cancelled` check → same catch → ZIP_ABORT).
- **Files:** `core/zip-accum.js` (new), `offscreen/offscreen.js`,
  `background/service-worker.js`
- **Proof:**
  - UNIT (failing first): `tests/test-zip-accum.mjs` — ERR_MODULE_NOT_FOUND
    on the pre-release build (no abort/TTL existed).
  - UNIT (after fix): **9 passed, 0 failed** (abort drops token+bytes,
    TTL sweeps stale, fresh survives, take() finalizes).
  - MUTATION: abort/sweep no-op'd → 5 passed, **4 failed**.
  - RACE: `tests/test-races.mjs` — interleaved chunks across 2 tokens,
    abort one, other completes intact.
  - E2E: P6 builds a real 50-image ZIP in the browser — see TEST_REPORT.md.

### N3 (LOW) — IPv6 guard misses compatible/NAT64/6to4 — FIXED
- **Bug:** `http://[::127.0.0.1]/`, `http://[64:ff9b::7f00:1]/`,
  `http://[2002:7f00:1::]/` were allowed.
- **Fix:** `isPrivateIPv6` extracts the embedded IPv4 from IPv4-compatible
  (`::/96`), NAT64 (`64:ff9b::/96`, last 32 bits) and 6to4 (`2002::/16`,
  bits 16–47) and re-checks it; the IPv4 private ranges now live in ONE
  helper (`isPrivateIPv4Octets`) used by both the dotted-IPv4 and
  embedded-IPv6 paths (single-source pattern).
- **Files:** `core/urls.js`
- **Proof:**
  - UNIT (failing first): `tests/test-urls-ipv6.mjs` — 14 passed,
    **7 failed** on the pre-release build (all three forms, lower+upper case).
  - UNIT (after fix): **21 passed, 0 failed**; public URLs (incl. NAT64/
    6to4/compatible forms of 8.8.8.8) stay allowed.
  - FUZZ: `tests/test-fuzz-url-guard.mjs` — **3000 passed, 0 failed**
    (fixed seed 1337; decimal/hex/octal/int IPv4, mapped/compatible/NAT64/
    6to4/zone-id/trailing-dot/uppercase IPv6).
  - MUTATION: N3 branches removed → 14 passed, **7 failed**.
  - REGRESSION: guard diff pre-release→new over 21-URL corpus = exactly the 5
    intended N3 changes, nothing else.

### N4 (LOW) — queue persist depends on 1 s throttle — FIXED
- **Bug:** `chromeDownloadId` was saved at most 1/s; a worker dying inside
  the window lost the id → adopted download re-queued → possible duplicate.
- **Fix:** persist layer extracted to `core/queue-persist.js`
  (`schedule()` = throttled, `flush()` = immediate + cancels pending);
  `trackDownload()` calls `persistQueueNow()` the moment the id is assigned.
- **Files:** `core/queue-persist.js` (new), `background/service-worker.js`
- **Proof:**
  - UNIT (failing first): `tests/test-queue-persist.mjs` —
    ERR_MODULE_NOT_FOUND on the pre-release build.
  - UNIT (after fix): **5 passed, 0 failed** (schedule defers, flush writes
    synchronously with the id, flush coalesces pending, schedule-only
    leaves the id unsaved = the old bug).
  - MUTATION: flush degraded to schedule → 3 passed, **2 failed**.
  - RACE: 100 rapid schedule() calls → exactly 1 write.
  - E2E: P5 kills the worker ×3 mid-bulk via CDP — see TEST_REPORT.md.

### N6 (CRITICAL — found during e2e) — first STITCH_BEGIN always failed — FIXED
- **Bug:** `stitchBegin()` unconditionally called `stitchEnd()` ("never leak
  a previous session"), but `stitchEnd()` throws `'no-stitch-session'` when
  there is no session — i.e. on EVERY first capture after the offscreen
  document is (re)created. Full-page/area/element capture could never
  succeed on a fresh offscreen document (pre-existing in the pre-release build).
- **Fix:** `if (stitchSession) stitchEnd();` — release a previous session
  when one exists, don't throw when there isn't one. (`stitchAbort`
  already handled the null case correctly.)
- **Files:** `offscreen/offscreen.js`
- **Proof:**
  - E2E (failing first): P3/P4 — real offscreen stitcher via the worker's
    own message path — failed with
    `STITCH_BEGIN rejected: {"ok":false,"error":"no-stitch-session"}`.
  - E2E (after fix): P4 stitches a real 3000 px page → 1280×3000 PNG,
    dimensions verified from the IHDR chunk; P3 stitches a 20,000 px page
    (24 tiles) → 1280×17280 PNG. See TEST_REPORT.md.
  - (Offscreen code needs DOM; the e2e is the failing/passing test here.
    Mutation = revert the one-line guard → P3/P4 fail again.)

### N5 (INFO) — agent claims needing a real browser — ADDRESSED
Worker kill, 100-image bulk, DPR behavior, 100 MP canvas, memory numbers:
all attempted in the real browser this round — see TEST_REPORT.md
(P0–P8) and NOT_TESTED.md for what automation cannot reach.

## Round-2 findings (re-verified this round)

| ID | Status | This round's evidence |
|---|---|---|
| B1 restart duplicates | FIXED (unchanged) | UNIT: test-core.mjs queue/restore tests 104/104; E2E P5 worker-kill ×3 |
| B2 private network guard | FIXED (+N3) | UNIT: 21 IPv6 + 3000 fuzz, all green |
| B3 settings | FIXED (unchanged) | CONTRACT: test-contract-settings.mjs 8/8 (schema round-trip, garbage fuzz, coercion) |
| B4 SVG sanitizer | FIXED (unchanged) | UNIT: test-svg.mjs 12/12 (stub DOM) + NEW test-svg-real-dom.mjs 18/18 (jsdom, 17 attack payloads) |
| B5 docs/tests | FIXED | validator docs-linter: README counts generated from runs, shortcuts/permissions/version cross-checked |
| B6 smaller items | FIXED | N1/N2 were its remainders — both fixed above |

## Round-1 findings (H1–L12)

Unchanged since the pre-release builds (no code touched in those areas this round except
the silent-`.catch` justification pass, which only added comments).
Re-verified by the full suite: 104 unit + all contract/fuzz/race tests
green, validator green, check-duplicates green, regression-diff green.
Prior per-finding detail lives in FIX_STATUS.md.

# Audit round 2: fixes

Source of truth: `IMGFETCH_REVIEW` (second pre-release audit). Every finding below is
**FIXED**, **REJECTED** (with reason), or **DEFERRED** (with reason). Nothing is
skipped silently.

Test totals for this build: **143 passing, 0 failing**
(`test-core.mjs`: 104 · `test-scanner.mjs`: 18 · `test-overlay.mjs`: 9 ·
`test-svg.mjs`: 12) + static validator green.

## New bugs (B1–B6)

### B1 (HIGH) — Restart recovery re-downloads in-flight files — FIXED
- `core/queue.js`: `restore(list, adoptedIds)` inserts adopted items **directly as
  ACTIVE** (with their `chromeDownloadId`); the starter is never called for them.
  `#pump()` runs once at the end, honoring adopted slots in the concurrency
  counter. `adopt()`/`settleAdopted()` now maintain the `active` counter with
  double-call guards.
- `background/service-worker.js`: `restoreQueueState()` passes the adopted ids
  straight into `restore()`.
- Proven by 6 new tests that **failed on the pre-release code** (starter fired for the
  adopted id, `active` count 0) and pass now.

### B2 (MEDIUM) — Private-network guard bypasses — FIXED
- `core/urls.js`: `isPrivateNetworkUrl()` rewritten — real IPv6 parser,
  IPv4-mapped `::ffff:` converted back to IPv4 and re-checked, `::` blocked,
  `100.64.0.0/10` blocked, `.local` / `.internal` / `.lan` / `.home.arpa` /
  `.localhost` blocked, single-label hostnames blocked.
- New shared `isPrivateNetworkFetchBlocked(url, pageUrl)` with the same-host
  exception; worker `checkPublicFetch` refactored onto it.
- Wired into **all** extension-privileged fetch paths: `offscreen.js`
  `allowedSource(src, pageUrl)` (every call site + `fetchZipFile` + chunked
  BUILD_ZIP) and `pages/info.js` `fetchHead` (EXIF path). Same-host intranet
  exception preserved (round-2 self-review also found and fixed two missed
  call sites: `CLIPBOARD_IMAGE` and `DOWNLOAD_STRIPPED` now pass `pageUrl`,
  and `DOWNLOAD_STRIPPED` gained the worker-side `checkPublicFetch` gate).
- Proven by 27 new tests that **failed on the pre-release build** (all 11 bypass URLs allowed)
  and pass now.

### B3 (MEDIUM) — Two decoration settings — FIXED
- `qualityPreference` is now **real**: new pure `shouldProbeBestSources(settings,
  mode)` in `core/settings.js`. `'original'` skips best-source probing in
  `performSmartDownload` (saves the exact right-clicked source, fewer requests);
  `'smart'` (default) keeps the old probing behavior. The options hint was
  rewritten to describe this truthfully.
- `defaultAction` **removed** (schema, ENUMS, options references) with migration
  (`delete s.defaultAction` in `normalizeSettings`). Reason: no UI control ever
  exposed it, and no generic download button exists in any UI — every action
  names its mode explicitly, so the setting could never fire.
- Tests assert both the migration and the probing-behavior change.

### B4 (MEDIUM) — SVG sanitizer denylist — FIXED
- New `core/svg.js`: **allowlist** sanitizer. Only known-safe elements and
  attributes survive; `script`/`foreignObject`/`iframe`/`embed`/`object` are
  stripped by exclusion; `set`/`animate*` are removed when they target `href`;
  URL values have control chars stripped before a scheme check (`#`,
  `http(s):`, `data:image/` only, with script-sniffing on `data:image/svg+xml`
  payloads); `@import` and external `url()` are stripped from styles.
- Wired into `offscreen.js`, replacing the old denylist for network SVGs.
- Proven by 12 new tests that **failed against the old denylist** (9 of 12)
  and pass now, including the `java<TAB>script:` payload.

### B5 (MEDIUM) — Docs/claims vs zip — FIXED
- `scripts/package.sh` now runs the validator **and all four test files**, and
  ships `tests/`, `scripts/`, `docs/`, plus `FIX_STATUS.md`,
  `FIX_STATUS_ROUND2.md`, `TEST_REPORT.md`, `STORE_LISTING.md` inside the zip.
- README project tree regenerated from the real filesystem (now includes
  `core/fullpage-capture.js`, `core/svg.js`, `background/idb.js`,
  `core/image-url.js`, `core/scan-state.js`) with correct test counts (143).
- `scripts/validate.py` gained three new checks: README/tree agreement (both
  directions), unused `core/` exports (all 59 exports used), forbidden patterns
  (`eval`, `new Function`, `console.log`, TODO/FIXME).
- This file, a regenerated `TEST_REPORT.md`, and an updated `STORE_LISTING.md`
  are the deliverables the audit asked for.

### B6 (LOW) — Smaller issues — FIXED except one DEFERRED item

| Item | Status |
|---|---|
| Full-page refuses >24 tiles | FIXED — captures the first 24 from the top with a user notice (`planFullPageCapture`, tested) |
| 8192 px side cap | FIXED — area-based cap (100 MP, max side 32,767) replacing it (tested) |
| Offscreen ensure race | FIXED — one shared promise around the whole check→close→create step |
| ZIP memory (concat buffer) | FIXED — `createZipParts()` builds the Blob from parts directly; chunked `BUILD_ZIP` transfer; round-2 self-review added a per-ZIP token so concurrent bulk ZIPs can't corrupt each other |
| Nested `<button>` in popup grid | FIXED — wrapper div + sibling buttons, keyboard map (Space/Enter) preserved |
| Annotate "red ✕" help text | FIXED — text no longer mentions the removed handle |
| Annotate rAF (M11) | FIXED — pointer drag renders via `requestAnimationFrame` into a preview layer; no full redraw per move |
| Thumbnail loading uncapped (M11) | FIXED — blob thumbnail resolution capped at 6 concurrent (FIFO queue) |
| Grid not virtualized (M11) | FIXED — past 360 rendered thumbs, off-screen pages collapse to height-matched placeholders and re-inflate via IntersectionObserver |
| ZIP entries timestamp 1980 | FIXED — real DOS timestamps (verified 2026 with `unzip -t`) |
| "Show in folder" after download | FIXED — new `SHOW_DOWNLOAD` message (registered in router + allowlist + sender rules); queue items keep `chromeDownloadId`; popup shows a "Show in folder" button on finished items |
| Copy screenshot to clipboard | FIXED — "Copy to clipboard" button on the capture preview page |
| Select by format | Already existed — format filter + "Select all" selects exactly that format |
| Invert selection | Already existed — "Invert" button in the popup toolbar |
| Estimated total size | **DEFERRED** — scan results carry dimensions, not byte sizes; a `width × height × 3` guess would be a misleading number presented as data. Not faked. |

## Original findings — status after round 2

Everything the audit marked FIXED in round 1 stays fixed. Items the audit marked
PARTLY/NOT fixed are resolved above:

- **H5** (worker restart) — was NOT FIXED, root cause was B1 → **FIXED** (see B1).
- **H8** (decoration settings) — was PARTLY FIXED, remainder was B3 → **FIXED**.
- **M3** (SVG) — was PARTLY FIXED, remainder was B4 → **FIXED**.
- **M7** (private network) — was PARTLY FIXED, remainder was B2 → **FIXED**.
- **M9** (docs drift) — was NOT FIXED → **FIXED** (see B5).
- **M11** (performance) — was PARTLY FIXED (annotate rAF, thumbnails, grid) →
  **FIXED** (see B6).
- **M2** (quality default) — stays **REJECTED by design**: the owner explicitly asked
  for 100% JPG/WebP/AVIF quality. The audit's new note (a stored 0.92 chosen
  deliberately is indistinguishable from the old default and migrates to 1) is
  a known, documented tradeoff of any default migration — accepted.
- **M8** (store risks) — host permissions stay `http`/`https` (documented as the
  rejected alternative: the extension downloads from any site by design).
  `docs/` is now **in the zip** (see B5). Google Lens disclosure remains not
  verifiable here — no such feature exists in the code; nothing to disclose.
- All other H/M/L items: **FIXED** (unchanged from the round-1 report).

## Files changed in round 2

`core/queue.js`, `core/urls.js`, `core/settings.js`, `core/zip.js`,
`core/svg.js` (new), `core/fullpage-capture.js` (new),
`core/validation.js`, `background/service-worker.js`, `offscreen/offscreen.js`,
`pages/info.js`, `pages/capture.js`, `pages/capture.html`, `pages/annotate.js`,
`popup/popup.js`, `options/options.html`, `tests/test-core.mjs`,
`tests/test-svg.mjs` (new), `scripts/validate.py`, `scripts/package.sh`,
`README.md`, `CHANGELOG.md`, `STORE_LISTING.md`, `TEST_REPORT.md`,
`manifest.json` (version 1.0.0).

No new permissions. No new dependencies. Vanilla JS throughout.

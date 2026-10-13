# ImgFetch, Smart Image Downloader

**Version 1.0.0**: a Manifest V3 browser extension for Chrome and Edge.
Save any image in its best validated quality, scan whole pages, capture
screenshots. No accounts, no tracking, no analytics.

Keyboard shortcuts: Ctrl+Shift+S (scan), Ctrl+Shift+X (capture area),
Alt+Shift+E (pick element), Ctrl+Shift+E (capture element), rebindable in
Settings and in the browser's extension-shortcut page.

## Features

**Smart Download**: right-click → Smart Download finds every genuinely
available image source (original, `srcset`, `<picture>`, lazy-loaded,
variants), validates each one, and saves the best valid source. No
upscaling, no false quality claims.

**Save as…**: PNG / JPEG / WebP / AVIF, plus More formats… (GIF, SVG, BMP).
The best valid source is found first, then converted into the target format.
The PNG quality slider is real: 100% is lossless, lower values reduce
colours to make smaller files.

**Right-click menu**: Smart Download · Save as… · Open Original · Copy Image
Link · Image Info · Search Image with Google Lens · More… (Scan This Page,
Screenshot, Add Site Preference, Disable on This Site, Settings).

**Page scanner**: finds images, srcset/picture, lazy-loaded and CSS
background images; chunked so large pages stay responsive.

**Download queue**: simultaneous downloads, real completion tracking,
automatic retry, cancel, retry-failed, clear-finished. Bulk downloads use
Smart Download by default, or pack into a ZIP.

**Smart file names**: original / site-date-number / custom templates; every
name sanitized, dangerous extensions blocked, folder traversal impossible.

**Screenshots**: visible page, selected area, or full page (scroll-and-stitch),
preview page, PNG/JPG, optional annotation editor.

**Organization**: per-website folders or a custom subfolder, download history
with exact file sizes, filters, search, sort.

**Settings**: sidebar layout, 13 sections (General → About), per-site
preferences, live shortcut bindings, import/export/reset.

## Install

**From the stores:** ImgFetch on the Chrome Web Store and on Microsoft Edge
Add-ons (links to be added).

**Load unpacked:** open `chrome://extensions` (or `edge://extensions`),
enable Developer mode, choose Load unpacked, select this `imgfetch/` folder.
No build step, no dependencies.

## Documentation

- `docs/USER_GUIDE.md`, how to use ImgFetch
- `docs/PERMISSIONS.md`, why each permission is needed
- `docs/LIMITATIONS.md`, known limitations
- `docs/ARCHITECTURE.md`, how the code is organized
- `docs/BUILD.md`, packaging for the Chrome Web Store / Edge Add-ons
- `docs/PERFORMANCE.md`, performance notes
- `docs/security-model.md`, threat model and mitigations
- `docs/history/`, public records of how ImgFetch was built
- `docs/tests/`, test report, manual checklist, testing notes
- `PRIVACY.md`, privacy policy
- `TERMS.md`, terms of use
- `SECURITY.md`, how to report a vulnerability
- `CHANGELOG.md`, release history

## Permissions

| Permission | Why |
|---|---|
| `contextMenus` | The right-click ImgFetch menu on images and pages |
| `downloads` | Saving files to your Downloads folder |
| `storage` | Settings, site preferences and history, on this device |
| `scripting` | Running the page scanner when you start a scan |
| `activeTab` | Capturing screenshots of the page you invoked it from |
| `offscreen` | Format conversion and ZIP building in a hidden document |
| `notifications` | Optional "download finished" note (on by default, can be turned off) |
| `clipboardWrite` | "Copy Image Link" |
| Host access (`https://*/*`, `http://*/*`) | Downloading images from the sites you visit |

## License

ImgFetch is free software, licensed under the GNU General Public License v3
or later (see LICENSE). You may use, study, modify and redistribute it,
including commercially, as long as every distributed copy or modified version
keeps the same licence, keeps the copyright notices, and makes its source
code available. Copyright (C) 2026 ImgFetch Developer.

## Issues

Open an issue on the GitHub repository: https://github.com/umr-x/imgfetch/issues

## Project structure

```
imgfetch/
├── manifest.json                 # MV3 manifest (Chrome + Edge, 4 suggested shortcuts)
├── LICENSE                       # GNU General Public License v3
├── PRIVACY.md                    # Privacy policy
├── TERMS.md                      # Terms of use
├── SECURITY.md                   # Vulnerability reporting policy
├── CHANGELOG.md                  # Release history
├── CONTRIBUTING.md               # How to contribute
├── .gitignore                    # dist/, zips, node_modules/
├── README.md                     # This file
├── background/
│   ├── service-worker.js         # Menus, message router, download queue, screenshots
│   └── idb.js                    # IndexedDB store for captures/queue persistence
├── content/
│   ├── scanner.js                # Page scanner + relevance scoring + best-source validation
│   └── overlay.js                # Area-select overlay, element picker for screenshots
├── offscreen/
│   ├── offscreen.html
│   └── offscreen.js              # Format conversion, SVG sanitize, ZIP build, clipboard
├── popup/
│   ├── popup.html
│   └── popup.js                  # Scan results, filters, preview, queue, history
├── options/
│   ├── options.html
│   └── options.js                # 13-section settings page
├── pages/
│   ├── welcome.html / welcome.js # 3-step onboarding
│   ├── capture.html / capture.js # Screenshot preview
│   ├── annotate.html / annotate.js # Screenshot annotation editor
│   ├── rename.html / rename.js   # "Ask for filename" sheet
│   └── info.html / info.js       # Image info + actions
├── shared/
│   ├── ui.css                    # ImgFetch design system (light + dark)
│   └── ui.js                     # Theme, toast, messaging helpers
├── core/                         # Pure, testable logic (no chrome.* APIs)
│   ├── urls.js                   # URL normalize / parse / host rules / private-net guard
│   ├── filenames.js              # Safe filename building, traversal-proof paths
│   ├── filters.js                # Search / filter / sort (threshold size chips)
│   ├── settings.js               # Schema, defaults, validation, quality resolver
│   ├── queue.js                  # Concurrency, retry, cancel, restart persistence
│   ├── validation.js             # Message + sender validation, friendly errors
│   ├── history.js                # History records, pruning, grouping
│   ├── dedupe.js                 # Scan-result deduplication
│   ├── exif.js                   # EXIF parsing (orientation, GPS)
│   ├── export.js                 # Format conversion planning
│   ├── gif.js                    # Pure-JS GIF encoder (animated stills)
│   ├── png-quantize.js           # PNG quality: median-cut color reduction
│   ├── zip.js                    # Part-based ZIP builder (no concat buffer, DOS dates)
│   ├── fullpage-capture.js       # Full-page tile planner (shared stitch limits)
│   ├── zip-accum.js              # Chunked-ZIP accumulator: abort + 2-min TTL
│   ├── queue-persist.js           # Throttled + immediate queue persistence
│   ├── image-url.js              # Best image-URL picking for Copy Image Link
│   ├── scan-state.js             # Scan lifecycle state (idle/scanning/results)
│   ├── svg.js                    # Allowlist SVG sanitizer
│   ├── bulk-payload.js           # DOWNLOAD_IMAGE/MANY queue payloads + candidate sanitizer
│   └── folders.js                # Smart folder resolution (subfolder toggle + organize modes)
├── assets/brand/                 # ImgFetch brand masters
│   ├── imgfetch-mark-exact.svg  # Logo master (vector)
│   └── imgfetch-mark-master.png # Logo master render 1600px
├── icons/                        # Extension icon set (16/32/48/128/512)
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   ├── icon-128.png
│   └── icon-512.png
├── store-assets/                 # Store listing graphics (not shipped in zips)
│   └── promo-tile-440x280.png   # Store promo tile
├── tests/
│   ├── test-core.mjs             # 108 unit tests (queue, settings, urls, validation…)
│   ├── test-png-quantize.mjs     # 5 PNG quantization tests
│   ├── test-scanner.mjs          # 18 relevance-scoring tests (stub DOM)
│   ├── test-overlay.mjs          # 9 element-picker tests (stub DOM)
│   ├── test-svg.mjs              # 12 SVG sanitizer tests (stub DOM)
│   ├── test-svg-real-dom.mjs     # 18 SVG sanitizer tests (real DOM via jsdom)
│   ├── test-contract-fullpage.mjs # 135 planner/stitcher contract tests
│   ├── test-contract-filename.mjs # 2730 filename to download-path contract checks
│   ├── test-contract-settings.mjs # 8 settings schema contract tests
│   ├── test-fuzz-url-guard.mjs   # 3000 seeded fuzz cases
│   ├── test-urls-ipv6.mjs        # 21 IPv6 private-network guard tests
│   ├── test-zip-accum.mjs        # 9 chunked-ZIP abort/TTL tests
│   ├── test-queue-persist.mjs    # 5 immediate-persist tests
│   ├── test-races.mjs            # 6 race tests (cancel, token isolation, bursts)
│   ├── test-candidates.mjs       # 21 candidate-discovery + bulk-payload tests
│   └── test-e2e/
│       ├── e2e.mjs               # Playwright phases P0-P8 (see test-e2e/RUN.md)
│       ├── fixture-server.mjs    # Generated fixture pages/assets (no internet)
│       └── RUN.md                # How to run the real-browser suite
├── scripts/
│   ├── make-icons.py             # Regenerate icons
│   ├── validate.py               # Static checks (JSON, syntax, security, README/tree, docs)
│   ├── check-duplicates.mjs     # Single-source-of-truth: shared limits/rules
│   ├── regression-diff.mjs       # Pre-release vs current behavior diff
│   ├── release-check.sh          # Release gate: runs all tests, validator, packaging
│   └── package.sh                # Build store zips (runs validator + all tests)
└── docs/
    ├── ARCHITECTURE.md           # How the code is organized
    ├── BUILD.md                  # Packaging for the Chrome Web Store / Edge Add-ons
    ├── LIMITATIONS.md            # Known limitations, deferred and rejected features
    ├── PERFORMANCE.md            # Performance notes
    ├── PERMISSIONS.md            # Why each permission is needed
    ├── USER_GUIDE.md             # How to use ImgFetch
    ├── security-model.md         # Threat model and mitigations
    ├── history/
    │   ├── README.md
    │   ├── 01-initial-build-plan.md
    │   ├── 02-audit-round-1-fixes.md
    │   ├── 03-audit-round-2-fixes.md
    │   ├── 04-audit-round-3-fixes.md
    │   └── 05-audit-round-4-fixes.md
    └── tests/
        ├── README.md             # Testing notes
        ├── manual-test-checklist.md
        └── test-report.md        # Generated test report
```

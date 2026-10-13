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

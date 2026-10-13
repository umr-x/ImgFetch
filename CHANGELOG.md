# Changelog

## 1.0.0 (2026-10-12)

ImgFetch 1.0.0, the first public release. Everything below ships in this
version: smart image downloading, whole-page scanning, screenshots with a
built-in editor, and a download queue that manages itself. No accounts, no
analytics, no telemetry, everything stays on your device.

### Downloading

- **Right-click menu**: Smart Download, Save as…, Open Original, Copy Image
  Link, Copy Image, Image Info, Scan This Page, Screenshot submenu, Add Site
  Preference, Disable on This Site, Settings.
- **Smart Download** finds every genuinely available source (original,
  srcset, `<picture>`, lazy-loaded variants), validates each one in the
  page, and downloads the best valid source directly, no conversion, no
  upscaling, never claims quality without measured evidence. If the top
  source fails it tries the next (up to 5), with honest stage feedback
  ("Finding best quality…" → "Downloading…" → "Downloaded successfully.").
- **Save as…** finds the highest-quality valid source first, then decodes
  once and encodes straight into the requested format, PNG, JPEG, WebP,
  AVIF, GIF, SVG, BMP. No re-compression chains.
- **Real encoders, honest labels**: the file's binary content, MIME type
  and extension always match. ImgFetch ships its own pure-JS GIF89a encoder
  (median-cut 256-color palette, LZW, 1-bit transparency) and 24-bit BMP
  encoder; animated WebP/APNG convert to genuine multi-frame GIFs via
  WebCodecs; AVIF support is probed with a real encode and output is
  MIME-verified, so a capable browser is never silently downgraded.
- **Copy Image Link** copies the image's actual URL as plain text, it runs
  inside the page (where the click carries user activation) and prefers
  `currentSrc`, so srcset/`<picture>` resolve to what you actually see.
- **Copy Image** copies the actual pixels to the clipboard with a 3-step
  fallback chain (offscreen → in-page → link-as-text), so the clipboard
  never ends up empty, even for hotlink-protected images.
- **Image Info** shows full details including EXIF data (camera, date taken,
  full size, GPS) for JPEGs that carry it.
- **Download queue**: concurrency 1–6, real completion tracking, auto-retry
  once, cancel (also cancels the browser-side download), retry-failed,
  clear-finished, "Show in folder" on finished items. The queue survives
  service-worker restarts: pending items re-queue and in-flight browser
  downloads are adopted, never duplicated. When everything finishes, the
  progress pane shows the final count and collapses back home after a
  moment (toggleable in Settings).
- **Download selected as ZIP**: packs scan results into one `.zip` with
  ImgFetch's own pure-JS writer (verified against Python's `zipfile`).
  Caps: 200 files, 50 MB each, 300 MB total. ZIPs are labeled "as shown"
  and appear in History with a ZIP badge.
- **Smart file names**: original name, site-date-number, or custom
  templates (with a helper); optional rename sheet with image preview
  before single downloads; optional "ask file name" per download.
- **Smart folders**: one place, by website, by type (Photos / Screenshots /
  GIFs / Graphics), or by date; per-site overrides.
- **Download history**: the last 200 downloads with retention controls,
  search and clear.

### Smart quality, honestly

- Two modes everywhere: **Smart** (recommended, best verified source) and
  **As shown** (exactly what the page displays). Bulk download defaults to
  As shown, with an explicit opt-in for best-quality probing.
- **"Original" quality preference** skips probing entirely and takes the
  exact page source.
- Scan-time candidate evidence only: currentSrc, src, srcset width hints,
  `<picture>` sources and lazy-load attributes, ranked by measured area.
  ImgFetch never invents, guesses or rewrites URLs; bounded upgrade probing
  (top candidates only) never downgrades.

### Page scanner

- **Relevance scoring** across multiple signals, rendered/natural
  dimensions, visibility, DOM context (article/main/figure = content,
  header/nav/button = UI chrome), CSS classes, URL patterns, repetition,
  alt text. Interface assets (logos, nav icons, tracking pixels, favicons,
  sprites) are filtered out; the footer honestly reports how many were
  hidden. Nothing is site-specific.
- **Broad source coverage**: iframes, `og:image`, `<input type=image>`,
  inline `<svg>`, `<canvas>` snapshots, `<object>`/`<embed>`,
  `::before`/`::after` backgrounds, page `blob:` URLs (resolved in-page),
  `<video>` posters, open shadow DOM, and lazy-load attributes.
- **Scan This Page** with depth control (Loaded page / Scroll page),
  duplicate removal (keeps the largest variant), size/orientation/format
  filters, text search, sorting, bulk selection and a preview modal.
- **Global shortcut** (Ctrl+Shift+S) starts a real scan with live progress -
  the popup follows it whether it was open or not; double-presses share one
  in-flight scan; restricted pages and paused sites get a clear explanation
  instead of silence.

### Screenshots & annotation

- **Visible area, Select area, Full page, Capture element**: via popup,
  right-click menu, Settings buttons, or keyboard shortcuts (Ctrl+Shift+X
  area, Ctrl+Shift+E element, Alt+Shift+E pick element).
- **Full-page capture** scrolls and stitches with one shared size rule
  between planner and stitcher, per-tile progress, fixed-header hiding,
  tab-switch abort, and scroll-position restore.
- **Built-in annotation editor** (on by default): pen, arrow, rectangle,
  circle, text and blur/pixelate for hiding faces and names, with undo,
  colors, line widths and custom SVG icons. Each screenshot reuses a single
  result tab instead of spawning a new one per capture.
- Screenshot JPEG quality defaults to 100%; screenshots can be copied to
  the clipboard.

### Popup & interface

- A single predictable router: Home dashboard and History views; Home
  panes for idle / scanning / results / queue, with Back navigation.
- The dashboard surfaces live status cards ("3 downloads in progress",
  "24 images found") instead of hijacking your view; lists update in
  place; panes fade gently between states.
- **Onboarding** (4 steps): welcome, core concepts, keyboard shortcuts,
  and "Make it yours", five curated settings (screenshot editor,
  download notifications, subfolder, ask-for-filename, full-settings link)
  with live save.
- **Themes**: system, light, dark with smooth cross-fade; every control
  follows the theme. Toggle switches for ON/OFF, checkboxes for
  multi-select, segmented controls for one-of-many, with
  `prefers-reduced-motion` honored throughout.
- Keyboard-accessible throughout: focus-visible states, arrow/space/enter
  on result cards, Esc to cancel pickers.

### Settings

- 13 sections (General, Downloads, Quality, File Names, Scanning,
  Screenshots, Site Preferences, Shortcuts, Folders, Download History,
  Backup & Reset, About, Privacy) with live save ("All changes saved").
- **Per-site preferences**: Smart / As shown / Paused per website, honored
  by the menu, popup and shortcuts alike.
- **Shortcuts page** shows your actual live key bindings with a link to the
  browser's shortcut settings, no fake shortcut manager.
- **Backup & Reset**: export settings (`imgfetch-settings.json`), import
  with validation, reset to defaults (with confirmation).
- **About**: logo, live version, and a human-readable permission list
  generated from the manifest.

### Reliability & performance

- The queue, in-flight captures and scan state all survive service-worker
  restarts; the offscreen document is never closed mid-job and is reaped
  after 30 s idle.
- Source probing runs 6-wide with short timeouts and a 3-minute ranked
  cache, repeat downloads start near-instantly; bulk probing is opt-in.
- Thumbnails render at most 6 concurrently; the results grid virtualizes
  past 360 items.
- Hardened paths: oversized data-URLs skipped gracefully, screenshot JPG
  never mislabeled, ZIP entries named by real content sniffing, failures
  reported with counts ("48 of 52 images, 4 skipped") instead of silence.

### Security & privacy

- **Local-only**: settings, history and captures never leave your device.
  No accounts, no analytics, no telemetry, no remote code.
- Least-privilege message routing: senders must be this extension, every
  message type has an explicit sender allowlist, and the offscreen document
  verifies its sender.
- Extension-privileged fetches block private-network URLs (localhost,
  LAN ranges, IPv6 equivalents) unless the page itself is on that host.
- Network SVGs are sanitized through an allowlist before saving (scripts,
  event handlers and `javascript:` URLs stripped).

### Brand

- ImgFetch ships with its abstract-mark logo: a gradient tile carrying a
  minimal landscape mark, regenerated at exact icon sizes (16/32/48/128,
  512 master), crisp at every size with clean transparent edges, in both
  themes.

### Quality & testing

- 6000+ unit, contract, fuzz and race tests green; real-browser end-to-end
  suite 9/9 on Chromium and Edge; static checks (manifest, permissions,
  no remote code, no inline scripts, message router↔allowlist audit,
  duplicate-limit checks, docs/claims linter) all green.

### Independent review fixes (folded into 1.0.0, unpublished)

- Chrome and Edge zips are built from one tree; package.sh extracts both
  and fails the build if diff -r finds any difference.
- validate.py runs against extracted zips (new argv[1] mode); project-only
  files (assets/brand, store-assets, manual matrix) are exempt from the
  zip check.
- Welcome page shows live shortcuts from chrome.commands.getAll() (handles
  rebinding and unbound keys; Mac symbols); the wrong Ctrl+Shift+C is gone.
- Context-menu build is serialized (promise chain); a race test covers
  overlapping builds.
- Removed the redundant activeTab permission (broad host permissions cover
  it; e2e 10/10 without it).
- scripts/release-check.sh runs every test and writes TEST_REPORT.md from
  real output; no hand-typed counts.
- All 5 icon sizes regenerated from the single SVG master
  (assets/brand/imgfetch-mark-exact.svg).
- Every silent catch now carries a one-line reason.

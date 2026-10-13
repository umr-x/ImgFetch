# ImgFetch, Architecture

## Principles

1. **Pure core, thin edges.** All decision-making lives in `core/` as pure
   functions with no `chrome.*` dependencies, so it runs in Node unit tests.
   The service worker, content scripts and UI are thin adapters over it.
2. **Validate, don't guess.** URL transforms (thumbnail stripping, size-suffix
   removal) are treated as *weak signals*: every candidate is loaded and
   measured before ImgFetch claims anything about quality.
3. **Fail soft, speak plain.** Conversion or best-source failures fall back to
   the plain download and tell the user in plain language, never a stack trace.
4. **Zero dependencies, zero build.** Vanilla JS/CSS/HTML. The folder loads
   unpacked directly; anyone can read and audit every line.

## Components

```
┌──────────────┐   messages    ┌──────────────────────┐
│ popup /      │ ◄───────────► │ background            │
│ options /    │  (validated)  │ service-worker.js     │
│ pages        │               │  · context menus      │
└──────────────┘               │  · message router     │
       │                       │  · download queue     │
       │ scripting             │  · screenshots        │
       ▼                       │  · history writer     │
┌──────────────┐               └──────┬─────────┬──────┘
│ content/     │                      │         │
│ scanner.js   │   conversion/crop/   │         │ downloads
│ overlay.js   │   clipboard          │         │ API
└──────────────┘                      ▼         ▼
                               ┌──────────┐ ┌──────────┐
                               │offscreen │ │ browser  │
                               │document  │ │downloads │
                               └──────────┘ └──────────┘
```

- **background/service-worker.js**: owns the context menus, validates and
  routes every runtime message (`core/validation.js`), owns the
  `DownloadQueue`, manages the offscreen document lifecycle, performs
  screenshots (`tabs.captureVisibleTab` + offscreen crop), writes history.
- **content/scanner.js**: injected on demand via `chrome.scripting`. Collects
  `<img>` (currentSrc, srcset, `<picture>` sources, lazy-load attributes) and
  CSS background images in time-sliced chunks; `findBestSource()` gathers
  candidates and *probes* them with `Image()` (concurrency 3, 6 s timeout,
  12-candidate cap), then ranks: validated first, larger pixels next,
  current-source only as a near-tie breaker.
- **content/overlay.js**: fullscreen area selector returning device-pixel
  rects; Esc cancels.
- **offscreen/**: `fetch` → `createImageBitmap` → canvas → `dataURL` for
  conversion (PNG/JPG/WebP/AVIF) and screenshot cropping; `CLIPBOARD_WRITE`
  for the copy-link action. Input URLs are allow-listed (http/https/data:image).
- **core/queue.js**: `DownloadQueue` with injected starter: the background
  starter resolves only when `downloads.onChanged` reports *complete*, so the
  queue reflects reality, not just “download started”.
- **UI**: popup (scan → filter → preview → queue → history), options
  (13 sections, autosave), three pages (welcome, capture, info). Shared
  `ui.css` design system with light/dark themes.

## Data flow: Smart Download

1. Context menu → background validates the message and enqueues one item
   (mode `'smart'`, optional target format).
2. `performSmartDownload`: normalize URL → ask the page (`findRankedSources`)
   for ALL validated sources, ranked best-first → walk the ranked list:
   for each candidate, optionally convert (decode once → encode directly to
   the requested format via the offscreen document; formats that need real
   encoders use `CONVERT_BMP` / `CONVERT_SVG`) → build a safe filename
   (`core/filenames.js`) → `downloads.download` → wait for real completion.
   On any candidate failure, broadcast “Trying another available source…” and
   continue with the next candidate (up to 5); only friendly, non-technical
   messages ever surface.
3. Stage feedback updates the queue item label (`queue.updateItem`) and, for
   single downloads, broadcasts short notices: “Finding best quality…” →
   “Converting to JPEG…” → “Downloading…” → “Downloaded successfully.”
4. On complete: history record, optional notification, `QUEUE_UPDATE`
   broadcast to the popup.

## Data flow: full-page screenshot

1. `captureFullPage`: get page metrics (`getPageMetrics` in the content
   script) → tile the page into viewport-sized segments (capped at 16 tiles /
   12,000 CSS px) → scroll to each tile, `captureVisibleTab`, collect tiles →
   always restore the original scroll position.
2. Offscreen `STITCH_IMAGES` draws tiles at their offsets on one canvas and
   encodes PNG → stored via `rememberCapture` (memory + session backup) →
   preview page (`pages/capture.html`) → save → `downloads.download`.

## Popup navigation

`popup/popup.js` drives the popup through one router: top-level views
`home`/`history`, and home sub-panes `idle` (dashboard) / `scanning` /
`results` / `queue`. `navigate(view, pane)` pushes the previous route onto a
Back stack (cap 20); `goBack()` pops it; `goHome()` resets to the dashboard,
clears selection + search, empties the stack, and never touches settings,
history, or the background-owned download queue. The dashboard renders
status cards from the preserved scan and the live queue snapshot, so
reopening the popup always starts at Home without losing work.

## Storage

| Key | Store | Contents |
|---|---|---|
| `imgfetch.settings` | `storage.local` | Normalized settings object |
| `imgfetch.history` | `storage.local` | ≤200 records, pruned by retention |
| `imgfetch.fileCounter` | `storage.local` | Monotonic file number |
| `imgfetch.lastScan` | `storage.session` | Last scan for the active tab (5 min) |
| `imgfetch.onboarded` | `storage.local` | Onboarding seen flag |

Everything stays on-device. See `docs/PRIVACY.md`.

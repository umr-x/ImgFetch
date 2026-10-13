# Initial build plan

> Historical document. This is the first build plan. The shipped product differs (shortcuts, permissions and settings have changed). See README.md and docs/USER_GUIDE.md for the current behaviour.


## Feature matrix

### Tier 1 — Essential (this build)
| Feature | Notes |
|---|---|
| Right-click menu hierarchy | Parent "ImgFetch", children: Download Image, Best Quality, Original Image, Save as PNG/JPG/WebP, Open Original in New Tab, Image Info, More… |
| Page scanner | Chunked content script: `<img>`, `<picture>`/srcset, lazy-load attrs, CSS backgrounds; scan-all + scan-from-menu on current tab |
| Best Quality detection | Candidate ranking (srcset/picture/lazy/variant) + validation by loading; confidence labels high/medium/low |
| Original detection | Largest *validated* candidate; honest fallback when nothing validates |
| Format conversion | Offscreen document pipeline (PNG/JPG/WebP/AVIF-if-supported), quality setting, fallback to original on failure |
| Download queue | Concurrency (1–6), progress, cancel, auto-retry once, friendly errors |
| Smart filenames | original/site/custom templates, sanitization, blocked dangerous extensions |
| Domain folders | optional organize-by-site + custom subfolder, traversal-proof |
| Screenshot: visible page | tabs.captureVisibleTab → preview → save |
| Screenshot: area select | page overlay → rect → offscreen crop → preview → save |
| Keyboard shortcuts | scan (Ctrl/Cmd+Shift+S), area capture (Ctrl/Cmd+Shift+C), reconfigurable |
| History | last 200, 30-day retention, grouped by day, clear |
| Filters/search/sort | size chips, format, orientation, text search, sort (order/largest/newest) |
| Settings page | 10 sections, import/export/reset, site preferences |
| Onboarding | 3 short screens on first install |

### Tier 2 — Nice-to-have (partially in)
- Per-site preferences (quality mode per host) — IN
- Preview modal with zoom — IN (basic)
- Duplicate detection by URL — IN

### Tier 3 / Deferred
- Cloud upload, translations (EN only), OCR on screenshots, video frame capture,
  scheduled/batch from URLs list, AI upscaling, Firefox/Safari ports.

## UX flow (key paths)
1. Right-click image → ImgFetch → Best Quality → toast/progress → history entry.
2. Toolbar → Scan this page → progress bar → grid results → select → Download Selected → progress → summary with retry.
3. Toolbar → screenshot icon → Visible/Area → preview → Save PNG/JPG.
4. Gear → Settings → sections; Import/Export in Privacy/About.

## Information architecture
- Popup: Home (scan / results / queue) · History · gear→options.
- Options: General, Downloads, File Naming, Folders, Image Quality, Screenshot,
  Shortcuts, Site Preferences, Privacy, About.
- Pages: welcome.html (onboarding), capture.html (screenshot preview), info.html (image info).

## Permission matrix
| Permission | Why it is needed |
|---|---|
| contextMenus | Right-click menu items |
| downloads | Save files to Downloads |
| storage | Settings, history, session scan cache |
| scripting | Inject scanner/overlay on demand |
| activeTab | Scan and capture the page the user is on |
| offscreen | Format conversion + screenshot crop off the UI thread |
| notifications | Optional completion alerts (setting; default off) |
| clipboardWrite | "Copy image link" menu action |
| https://*/* http://*/* | Fetch image bytes cross-origin for conversion; scan pages |

No `tabs`, no `<all_urls>` (scheme-scoped instead), no remote code, no analytics.

## Architecture
- `core/` — pure JS modules (urls, filenames, ranking, filters, settings, queue,
  validation, history): zero chrome deps, Node-tested.
- `background/service-worker.js` — menus, message router, queue owner, offscreen
  manager, screenshots, history writer. Thin; delegates logic to core.
- `content/scanner.js` — page scan + candidate validation (Image probing).
- `content/overlay.js` — area-select overlay.
- `offscreen/` — fetch→bitmap→canvas→dataURL conversion & crop.
- `popup/`, `options/`, `pages/` — UI, ImgFetch design system in `ui.css`.

## Testing matrix
- Node unit tests: core/* (urls, filenames, ranking, filters, settings, queue,
  validation, history).
- Static: JSON validity, manifest schema sanity, JS syntax check (node --check),
  no remote URLs in code, permission justification audit.
- Manual checklist (documented in docs/tests/README.md): menus, scan, conversion,
  queue, screenshots, settings import/export, onboarding, dark mode.

## Security checklist
- URL allowlist (http/https/data:image only), length caps.
- Filename sanitization + blocked extensions + traversal-proof paths.
- Message type allowlist + payload size cap + sender classification.
- Offscreen fetch restricted to validated URLs; data URLs length-capped.
- No eval/new Function, no innerHTML with page data (textContent + escaping).
- Host permissions documented in PERMISSIONS.md.

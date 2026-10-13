# ImgFetch, User guide

## Install

**Chrome:** open `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → choose the `imgfetch` folder.
**Edge:** same steps at `edge://extensions`.

## Save a single image

Right-click any image → **ImgFetch** and choose:

- **Smart Download**: ImgFetch automatically finds every genuinely available
  source (original, `srcset`, `<picture>`, lazy-loaded, variants), checks
  each one really loads, and saves the best valid source directly. If the
  best source fails, it tries the next one automatically and tells you.
  Never upscales, never invents quality.
- **Save as…**: PNG, JPEG, WebP, AVIF, plus **More formats…** (GIF, SVG,
  BMP). ImgFetch finds the best valid source first, then converts once into
  the format you picked: lossless PNG, high-quality JPEG/WebP/AVIF,
  transparency preserved. GIF works by saving genuine GIF sources (the
  browser can't create GIFs, ImgFetch says so plainly).
- **Open Original**, **Copy Image Link**, **Image Info**.
- **More…** → **Scan This Page**, **Screenshot** (Visible area / Select
  area / **Full page**), **Add Site Preference**, **Disable on This Site**,
  **Settings**.

## Scan a whole page

Click the ImgFetch toolbar button → **Scan this page**. When results appear:

- **Search** by name, alt text or site; filter by **size**, **format**,
  **orientation**; sort by page order or size.
- Click a thumbnail to **preview** it (Smart Download and all Save-as
  actions live there too), or **Shift/Ctrl-click** (or Space/Enter) to toggle
  selection.
- **Select all / Select none**, choose **Smart Download** or **As shown**
  and a target format, then **Download selected**.

The **Downloads** view shows live progress per file, including stages like
“Finding best quality…”, with **Retry failed**, **Cancel** and **Clear
finished**.

## Screenshots

- Toolbar button → **Capture visible page**, **Capture selected area**, or
  **Capture full page** (scrolls the whole page and stitches it into one
  image), or right-click the page → **ImgFetch → Screenshot**.
- **Capture selected area**: drag a rectangle (Esc cancels), then preview and
  **Save screenshot** (PNG or JPEG per your settings).

## History

Toolbar button → clock icon. Grouped by day; clear any time. Disable entirely
under Settings → Privacy.

## Popup navigation

The popup works like a small app: **Home** (dashboard), **History**, and
inside Home the Scan → Results → Downloads flow. The **Home** button always
returns to the dashboard and clears your current selection; it never closes
anything or stops a running download. **Back** returns to the previous view.
Reopening ImgFetch always starts at Home, an in-progress download queue or a
fresh scan appears as a status card ("View downloads", "View results").

## Settings highlights

Settings uses a sidebar (or a dropdown on narrow screens): General ·
Downloads · Quality · Scanning · Screenshots · File Names · Folders ·
Shortcuts · Site Preferences · Privacy · About. All changes save
automatically.

- **General**: light/dark/system theme, download notification.
- **Quality**: Smart Download (recommended) or prefer verified original;
  JPEG / WebP / AVIF conversion quality. PNG quality slider: 100% is
  lossless; lower values reduce colours to make smaller files.
- **Scanning**: minimum image size, background images, detect images that
  load while scrolling.
- **Screenshots**: default format + JPEG quality, and Capture-now buttons.
- **File names**: keep original · site-date-number · custom templates
  (`{site} {name} {date} {time} {width} {height} {dimensions} {num}` -
  tokens listed in a collapsible helper).
- **Folders**: a folder per website, or one fixed subfolder.
- **Shortcuts**: your actual current key bindings, with a link to the
  browser's shortcut settings.
- **Site prefs**: per-domain behavior, Smart, As shown, or Paused.
- **Privacy**: history toggle + retention, export/import settings as JSON,
  reset everything (asks first).
- **About**: version, permissions in plain language, docs/privacy summary.

## Keyboard shortcuts

- `Ctrl+Shift+S`, scan this page (customize at `chrome://extensions/shortcuts`)
- `Ctrl+Shift+X`, capture a selected area
- `Alt+Shift+E`, pick an element
- `Ctrl+Shift+E`, capture an element

(On Mac, use ⌘ instead of Ctrl.)

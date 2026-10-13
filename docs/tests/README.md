# ImgFetch, Testing report

Date: 2026-10-02 · Version 1.0.0

## Automated

| Suite | Command | Result |
|---|---|---|
| Unit tests (27) | `node tests/test-core.mjs` | **27 passed, 0 failed** |
| Static validation | `python3 scripts/validate.py` | **All checks passed** |

**Unit coverage** (`tests/test-core.mjs`, zero dependencies):
- `urls`: relative resolution, scheme allow-list, credential/hash handling,
  data-URL allow + caps, extension guessing, srcset parsing, host labels,
  variant-candidate bounds.
- `filenames`: illegal-character stripping, traversal removal, blocked
  executable extensions (`exe`→`png`), `jpeg`→`jpg`, all three naming modes,
  token substitution, length caps, `joinDownloadPath` traversal-proofing.
- `ranking`: validated-before-unvalidated ordering, pixel-size ordering,
  confidence labels (`high`/`medium`/`low`), `pickOriginal` returning `null`
  when nothing validated, dedupe.
- `filters`: size buckets, orientation, format groups, combined filters,
  multi-token search, all sort modes, URL dedupe.
- `settings`: enum/number/boolean clamping, hostile `sitePrefs` scrubbing,
  per-host quality resolution.
- `queue`: concurrency ceiling respected (max 2 observed under load),
  automatic retry then failure, attempt counting, cancel stops pending items.
- `validation`: message allow-list, field type checks, oversized payload
  rejection, sender classification, friendly-error mapping.
- `history`: 200-record cap, retention pruning, day grouping (Today/Yesterday).

**Static checks** (`scripts/validate.py`):
- `manifest.json` valid JSON, MV3, all 7 file references exist.
- `node --check` clean on all 18 JS files.
- No remote script references in extension code; no `innerHTML` anywhere.
- Permission usage in code matches manifest declarations.

## Manual test plan (for the release pass on a real browser)

Because this build environment has no Chrome/Edge binary, the following must
be walked through once on a real machine before store submission:

1. Load unpacked → no console errors; toolbar icon and popup open on the Home dashboard.
2. Popup nav: Scan → select several images → Home → dashboard appears, selection and search cleared. Back from Downloads returns to Results; Back again returns to Home. Start a download, go Home mid-download → download continues; reopen popup → Home with a "downloads in progress" card.
3. Settings: open all 11 sections via the sidebar; narrow the window → compact dropdown appears, no wrapping pills. Change each setting → behavior changes (theme applies, quality sliders, lazy-scroll toggle, site pref Paused → menu shows paused notice). Reload/close/reopen → values persist. Export → reset (confirmation appears) → import → values restored.
4. Right-click image → Smart Download saves the best validated source; Save as… → JPEG/WebP/AVIF/More formats (GIF/SVG/BMP) each produce a real file in that format; Open Original / Image Info / Copy Image Link work; More… → Screenshot ▸ shows three capture options; Add Site Preference adds the site and opens Settings; Disable on This Site pauses with notice.
5. Scan a photo-heavy page (e.g. Unsplash search): results render, filters and search narrow them, select-all → download → queue completes → history entry.
6. Smart Download on a WordPress-style `-300x200` thumbnail saves the larger validated file; queue shows "Finding best quality…" stages.
7. Save as JPEG of a transparent PNG yields a white background, not black; Save as WebP keeps transparency; Save as BMP produces a real .bmp; Save as SVG produces a valid .svg; Save as GIF on a non-GIF saves the original with a plain-language note.
8. Area capture: drag → preview → save PNG; Esc cancels cleanly. Full-page capture on a long article stitches into one image and restores scroll.
9. Keyboard shortcuts fire from `chrome://extensions/shortcuts`.
10. Edge: same zip installs and all of the above works.

## Known gaps

- No automated DOM/browser tests (no headless Chrome in this environment);
  covered by the manual plan above instead.
- Screenshot pixel comparison is manual by nature.

## Regression fixes verified by audit (v1.0.0)

A line-by-line audit of every user flow (menu → queue, scan → bulk download,
screenshots, info page, settings) found and fixed: bulk quality-mode default
ignoring "As shown"; image-info probing the wrong tab; best/original probing
bound to the active tab instead of the source tab; scan-progress messages
hitting the unknown-message path; screenshots lost on worker restart;
oversized data-URL images risking session-storage quota. All covered by the
static checks + unit suite where applicable, and by the manual plan above
for browser-only behavior.

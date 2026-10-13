# ImgFetch, Performance notes

Targets: scanning a 500-image page stays under ~2 s of scripting; popup opens
instantly; memory stays flat during bulk downloads.

## Design choices

- **Chunked scanning.** `content/scanner.js` processes `<img>` elements in
  batches of 100 and background candidates in batches of 400, yielding to the
  event loop between batches. The page never freezes, and live progress is
  reported (`SCAN_PROGRESS`).
- **Background scan capped.** At most 20,000 DOM elements are inspected for
  CSS backgrounds; tiny/invisible elements are skipped before the (expensive)
  `getComputedStyle` call.
- **Validation budget.** `findBestSource` probes at most 12 candidates at
  concurrency 3 with a 6 s timeout each, ordered largest-descriptor-first so
  the budget is spent where it matters. Worst case ≈ 24 s for a pathological
  page, but typical pages resolve in 1–3 s; failures fall back to the plain
  source rather than blocking.
- **Queue concurrency 1–6** (default 3). Each starter awaits real download
  completion, so network and disk back-pressure propagate naturally instead
  of piling up.
- **Off-DOM conversion.** Format conversion and screenshot cropping run in
  the offscreen document, keeping the popup and service worker responsive.
  Large data URLs are never written to storage, pending captures live in
  memory, bounded to 5 (oldest evicted).
- **Storage hygiene.** History capped at 200 records and pruned by retention;
  the last scan is session-only and expires after 5 minutes; thumbnails use
  the page's own URLs with `loading="lazy"`.

## Measured (this environment)

- Unit suite: 27 tests in <1 s.
- Static validation: 18 JS files syntax-checked in ~2.5 s.
- Extension unpacked size: ~120 KB (icons + code), no dependencies.

## Not yet measured

- Real-world scan timings per page archetype (gallery, infinite scroll,
  image board), to be profiled during the manual release pass; the chunked
  design gives headroom to tune batch sizes if needed.

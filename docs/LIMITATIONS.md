# ImgFetch, Known limitations

Honest edges of v1.0.0, things ImgFetch won't do, or does with caveats.

1. **No bypassing protections.** Images behind login walls, DRM or
   canvas-only renderers may not download. Page `blob:` URLs (e.g. GIF
   sites) *do* download while the page is open, ImgFetch resolves them
   in-page to real bytes; they can't be re-fetched after the tab closes.
   ImgFetch never circumvents access controls; screenshots capture only
   what's visibly rendered.
2. **Smart Download is best-effort.** It validates real candidates
   (srcset, zoom attributes, size-suffix variants), but some sites serve the
   “original” only after interaction (lightbox open, login). When nothing
   validates, ImgFetch says so and falls back, never invents quality.
3. **Format support follows the browser.** AVIF/WebP *decoding* depends on
   the browser; *encoding* to AVIF is offered only if the browser supports
   it (probed with a real encode at runtime, otherwise a clear message
   explains the PNG fallback; encoded output is MIME-verified so a file is
   never mislabeled). **PNG quality:** the PNG slider is real - 100% is
   lossless and pixel-identical; lower values reduce the colour count
   (median-cut) to make smaller files, with alpha preserved. Animated GIF/WebP are saved as-is; converting an animation to
   PNG/JPG/WebP/AVIF keeps the first frame only (ImgFetch says so in a notice).
   **GIF:** ImgFetch ships its own pure-JS GIF89a encoder (median-cut 256-color
   palette, LZW, 1-bit transparency), “Save as GIF” now genuinely produces a
   .gif from any source. Animated GIF sources download directly (animation
   intact); animated WebP/APNG sources are converted to real multi-frame
   animated GIFs (up to 60 frames) via WebCodecs frame decoding; a still
   source can only ever produce a still GIF, animation needs multiple
   frames. **SVG:** a valid SVG document wrapping the best source’s raster
   (vector tracing is out of scope). **BMP:** real 24-bit encoding; alpha is
   flattened (no standard alpha channel).
4. **Screenshots.** “Visible page” captures the current viewport.
   **“Full page”** scrolls and stitches (up to 16 tiles, 12,000 CSS px tall);
   sticky headers may repeat across tiles, pages that change height while
   scrolling (infinite scroll) may stitch imperfectly, and your scroll
   position is always restored afterward. Very large area selections are
   capped (16,000 px per side).
5. **Download progress is per-file, not per-byte.** The queue shows each
   file's state (pending → active → done/failed); byte-level progress lives in
   the browser's own download shelf.
6. **English only.** The UI ships in English; no localization yet.
7. **Chrome/Edge only.** Manifest V3 as implemented here targets
   Chromium-based browsers. Firefox and Safari ports are deferred (different
   APIs for offscreen documents and screenshots).
8. **Huge inline images.** Images embedded as data-URLs larger than ~500 KB
   are skipped by the scanner to protect memory and storage quotas.
9. **Google Lens.** Google Lens search depends on Google keeping its
   upload-by-URL address working; if Google changes it, the menu item may
   stop working.

# Deferred features (Tier 2/3, not in v1)

- Cloud upload targets (Drive/Dropbox/S3)
- OCR on screenshots
- Video frame capture
- Batch download from a pasted URL list
- AI upscaling
- Translations / RTL layouts
- Firefox and Safari ports

# Rejected (deliberately not built)

- **Background scraping without user action**: scans and downloads always
  start from an explicit user gesture.
- **`<all_urls>` host permission**: scheme-scoped `https/http` is sufficient
  and less alarming.
- **`tabs` permission**: unnecessary; host permissions already expose tab URLs.
- **Remote code / analytics SDKs**: incompatible with the privacy promise and
  with store policy; all code ships in the package.
- **Automatic “HD-ify” claims**: ImgFetch never labels an unvalidated file as
  best/original quality.

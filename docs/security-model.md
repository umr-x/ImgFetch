# Security model

Threat model: a malicious or compromised web page tries to make ImgFetch
exfiltrate data, write dangerous files, or execute code; a malicious image
URL tries to escape the Downloads folder or run as an executable.

## Mitigations (implemented and verified)

**URL validation** (`core/urls.js`, enforced in background + offscreen)
- Only `http:`, `https:` and `data:image/*` URLs are ever fetched or
  downloaded. `javascript:`, `data:text/html`, `ftp:`, `file:` etc. are
  rejected. URLs with embedded credentials are rejected.
- Length caps: 8 KB for URLs, 2 MB for data URLs (scanner), 25 MB in the
  offscreen converter.

**Filename safety** (`core/filenames.js`)
- Every filename goes through `sanitizeSegment`: strips `<>:"/\|?*` and
  control characters, trims leading dots/spaces, caps length.
- `safeExtension` maps the output extension onto an allow-list of image
  formats; executables and scripts (`exe`, `js`, `html`, `ps1`, …) can never
  be produced, the request falls back to `png`.
- `joinDownloadPath` builds the `downloads.download` path from sanitized
  segments only; `..` and separators are removed, so traversal outside the
  Downloads folder is impossible.

**Message validation** (`core/validation.js`)
- Background accepts only an allow-list of message types; unknown types and
  malformed envelopes are rejected. String fields are type-checked, payloads
  over 1 MB are dropped.
- Senders are classified (`content` vs `extension`); settings/history/capture
  writes require extension-page senders.

**XSS hygiene**
- No `innerHTML` anywhere in extension code (enforced by `validate.py`).
  Page-supplied strings (alt text, filenames, URLs) enter the DOM only via
  `textContent` or `src` attributes. Image `src` values are normalized through
  the URL allow-list first.

**Code integrity**
- No `eval`, no `new Function`, no remote scripts. CSP
  `script-src 'self'; object-src 'self'` on all extension pages.
- Content scripts run in the ISOLATED world; page JavaScript cannot reach
  `window.__imgfetch` internals or spoof messages (messages are only *sent*
  outward to the background, which validates them).

**Conversion sandbox**
- The offscreen document fetches with `credentials: 'omit'` and
  `referrerPolicy: 'no-referrer'`, no cookies or auth tokens leak to image
  hosts. Fetched blobs must have an `image/*` MIME type before decoding.
- JPEG encoding paints a white background first (no alpha-channel surprises).

**Clipboard**
- `CLIPBOARD_WRITE` accepts max 8 KB of text and only URLs that passed the
  allow-list; on failure the UI falls back to showing the link for manual copy.


**Google Lens**
- The "Search Image with Google Lens" menu item acts only after a user
  click. The extension opens `https://lens.google.com/uploadbyurl?url=`
  with the sanitized image address; no content script is injected into
  Google pages and nothing is read back.
- Before opening, `lensUrlBlocked` (core/urls.js) rejects `data:`/`blob:`
  URLs and private-network URLs (intranet/localhost), so those never leave
  the local machine. The image URL passes the same http/https allow-list
  as downloads.

## Residual risks (accepted, documented)

- A page can lie about `naturalWidth`/`naturalHeight` before validation; the
  probing step re-measures independently, so rankings use real pixels.
- `tabs.captureVisibleTab` captures whatever is on screen, including DRM
  overlays as rendered, ImgFetch does not bypass any protection, it captures
  pixels like the OS would.
- Service-worker memory holds pending screenshots until saved/discarded
  (bounded to 5, oldest evicted).

## Verification

- `node tests/test-core.mjs`, 108 unit tests incl. traversal, blocked
  extensions, oversized/unsafe URLs, message validation, Lens guard.
- `python3 scripts/validate.py`, JSON validity, manifest reference check,
  `node --check` on all 53 JS/MJS files, no remote code, no `innerHTML`,
  permission-usage audit. All green.

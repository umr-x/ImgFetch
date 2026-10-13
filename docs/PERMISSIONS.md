# ImgFetch, Permission report

Every permission ImgFetch requests, why it is needed, and what would break
without it. Deliberately **not** requested: `tabs` (unneeded, host
permissions expose tab URLs), `<all_urls>` (scheme-scoped hosts are enough),
`bookmarks`, `history`, `cookies`, `webRequest`, `debugger`.

## Permissions

| Permission | Used for | If removed |
|---|---|---|
| `contextMenus` | The right-click **ImgFetch** menu hierarchy on images and pages. | No right-click integration, the extension's primary entry point. |
| `downloads` | Saving files via `chrome.downloads.download`; tracking completion via `downloads.onChanged`. | Cannot save anything. |
| `storage` | Settings, history, file counter (`storage.local`); last-scan cache (`storage.session`). | No settings persistence or history. |
| `scripting` | Injecting `content/scanner.js` and `content/overlay.js` on demand into the active tab. | No page scanning, no best/original detection, no area select. |
| `activeTab` | Temporary access to the tab the user invoked ImgFetch from (screenshot capture via shortcut). | Screenshots may fail without it. |
| `offscreen` | Offscreen document for format conversion, ZIP assembly, screenshot stitching and clipboard writes. Reasons: `BLOBS`, `CLIPBOARD` (exact, no unused reasons). | No Save-as PNG/JPG/WebP, no ZIP, no area-capture crop, no copy-link. |
| `notifications` | Completion alerts. ON by default (`afterDownload: notify`); can be turned off in Settings. | No completion toasts. |
| `clipboardWrite` | “Copy image link” menu action (via offscreen clipboard). | Cannot copy links. |

## Host permissions

| Pattern | Used for |
|---|---|
| `https://*/*`, `http://*/*` | Fetching image bytes cross-origin for format conversion and ZIP; reading the active tab's URL for site-aware naming; injecting the scanner into iframes (`allFrames`) for complete page scans. |

Why not narrower: image CDNs live on unpredictable hosts; conversion must
fetch the bytes itself (canvas tainting rules). `optional_host_permissions`
was evaluated and rejected: ImgFetch's single purpose is downloading images
from any site the user visits, prompting for host access on every new site
would break context menus, background-tab scans and iframe scanning mid-task.
The permission is declared up-front with this justification.

## Content Security Policy

`extension_pages`: `script-src 'self'; object-src 'self'`, no inline scripts
(all pages use external files), no remote code, no plugins. Verified by
`scripts/validate.py` (no `innerHTML`, no remote `src=` in extension code).

## Data actually touched

- Image URLs and bytes the user explicitly asks to download/convert.
- Page image lists during a user-initiated scan (kept in session storage,
  never transmitted).
- Filenames, history entries, settings, all in on-device storage.

No browsing history, no cookies, no page content beyond images, no network
calls except fetching the images the user asked for.

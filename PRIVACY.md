# ImgFetch - Privacy Policy

Effective date: 2026-10-13

**Short version: ImgFetch does not collect, store or transmit your browsing
activity. It has no account, no server, no analytics, and no telemetry.**

## What stays on your device

- Settings, per-site preferences, download history (file names, source hosts,
  formats and sizes - no image bytes), the file counter and the last page
  scan - all in `chrome.storage` on your device.
- Screenshots waiting in the preview page live in the service worker's memory
  until you save or discard them.

## What leaves your device

- Only the image files you explicitly ask to download or convert. Fetching an
  image necessarily reveals your IP address to that image's host (as with any
  download) - ImgFetch adds no cookies or credentials to these requests.
- **Result thumbnails:** when you scan a page, the popup loads small previews
  directly from the image hosts so you can see what was found. This contacts
  those hosts (as any image view would); nothing is sent to ImgFetch or any
  third party.
- **Google Lens (only if you click it):** the "Search Image with Google Lens"
  menu item opens a Google Lens tab with the image's address so Google can
  search for it. This happens only after you click the menu item - ImgFetch
  never contacts Google otherwise, and nothing is sent to ImgFetch servers
  (there are none).

## What ImgFetch never does

- No analytics, telemetry, crash reporting or A/B testing.
- No accounts, no sign-in, no sync to any server.
- No reading of browsing history, bookmarks, cookies or page text - scans
  look at image elements only, and only when you start a scan.
- No advertising, no affiliate links, no data sale (there is no data to sell).

## Permissions

- `contextMenus`: the right-click ImgFetch menu on images and pages.
- `downloads`: saving files to your Downloads folder.
- `storage`: settings, site preferences and download history on this device.
- `scripting`: running the page scanner when you start a scan.
- `activeTab`: capturing screenshots of the page you invoked ImgFetch from.
- `offscreen`: format conversion and ZIP building in a hidden document.
- `notifications`: an optional note when a download finishes (you can turn
  it off in Settings).
- `clipboardWrite`: "Copy Image Link".
- Host access (`https://*/*`, `http://*/*`): downloading images from the
  sites you visit.

## Your controls

- **Settings - Privacy**: disable history, shorten retention (1-365 days),
  export or import settings as JSON, reset everything.
- **Popup - History**: clear history at any time.
- Uninstalling ImgFetch removes its on-device storage with it.

## Contact

Open an issue on the GitHub repository: https://github.com/umr-x/imgfetch/issues

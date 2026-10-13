# Audit round 1: fixes

Independent audit remediation pass on the pre-release code, executed 2026-10-03 per
`IMGFETCH_AUDIT_REPORT.md` + `IMGFETCH_AGENT_PROMPT.md`. Every finding ends
FIXED, REJECTED (technical reason), or DEFERRED — nothing silently skipped.

**Test evidence:** 49/49 unit tests pass (`node tests/test-core.mjs`),
`python3 scripts/validate.py` → ALL STATIC CHECKS PASSED.
Headless-Chromium smoke test: extension loads, service worker starts,
zero console errors in worker/popup/options, message routing verified.

## Phase A — must fix before any store submission

| ID | Finding | Status | What changed |
|---|---|---|---|
| H1 | Size filter hid large/unknown-size images | FIXED | Chips are minimum thresholds (Any / <400px / 400px+ / 120px+); unknown-size never hidden; starts from Settings default; "N hidden by filters" |
| H2 | Full-page screenshot scale/tile bugs | FIXED | Device-pixel cap (8192) + downscale notice; streaming tile protocol; 650 ms spacing + retry; progress; fixed-element hiding; tab-switch abort |
| H3 | ZIP memory/scale failure past ~45 MB | FIXED | Preallocated ZIP writer; blob: URL handoff; concurrency 4 + 30 s timeout; magic-byte entry names; skipped-file report; labeled "as shown" |
| H4 | Offscreen could close mid-job | FIXED | In-flight counter; reaped only after 30 s idle with zero jobs |
| H5 | Worker restart lost queue/capture state | FIXED | Queue persists to session storage; reconciles on restart (re-queue / adopt) |
| H6 | Ask-filename / Image Info lost Smart quality + folders | FIXED | Real pageUrl/tabId passed through |
| H7 | JPG fallback saved PNG bytes as .jpg | FIXED | Extension follows actual bytes |
| H8 | Site prefs / quality / default action did nothing | FIXED | resolveDownloadMode + assertSiteAllowed + prepareQueue enforced everywhere |
| H9 | www. host mismatch | FIXED | One shared normalizeHost() |
| M6 | Fail-open sender classification | FIXED | sender.id check; per-message SENDER_RULES; fail-closed unknown |
| M7 | Private-network fetch guard | FIXED | isPrivateNetworkUrl blocks loopback/RFC-1918 unless same host |

## Phase B — quality and trust

| ID | Finding | Status | What changed |
|---|---|---|---|
| M1 | getHostLabel folder rule | FIXED | Registrable domain without www., TLD kept |
| M2 | Lower default quality to 0.92–0.95 | **REJECTED** | the owner explicitly required 100% quality defaults. The audit's suggestion conflicts with a direct owner directive; not applied. |
| M3 | SVG safety | FIXED | Network SVGs sanitized on save; `<img>` fallback for rasterization; label "SVG (embedded image)" |
| M4 | URL-pattern probing | FIXED | Guessing removed; evidence-only candidates; per-host 150 ms throttle; bulk defaults "as shown" + opt-in checkbox |
| M5 | Scanner coverage | FIXED | allFrames + per-frame merge; og/icons, input[type=image], inline svg, canvas, object/embed, pseudo backgrounds; slimmer records |
| M8 | Permissions/privacy | FIXED | PERMISSIONS.md justifies every permission; optional_host_permissions evaluated and rejected (documented); PRIVACY.md discloses Lens, thumbnails, history |
| M9 | Docs/version drift | FIXED | README structure regenerated; CHANGELOG 1.0.0; version bumped |
| M12 | AVIF shown when unsupported | FIXED | Menu item hidden; popup button hidden; dlFormat option disabled with "(not supported)" |

## Phase C — clean code and performance

| ID | Finding | Status | What changed |
|---|---|---|---|
| M10 | Dead code | FIXED | ranking.js deleted; 7 dead exports removed; saveToDownloads() extracted; captureRegion/finishCapture merged. (QUALITY_DEFAULTS and duplicate buildMenus from the report were verified absent — report was stale.) |
| M11 | Performance | FIXED | Queue broadcasts throttled (200 ms); grid windowed (120/page + sentinel); annotate preview layer (no full repaint on drag/selection); captures moved to IndexedDB |
| L1 | Windows reserved names | FIXED | `_` prefix; unit test |
| L2 | Shortcuts link always chrome:// | FIXED | edge:// in Edge |
| L3 | Overlay in screenshot | FIXED | 2 animation frames after removal |
| L4 | Element clamp cuts tall elements | FIXED | User notice with Full-page suggestion |
| L5 | Overlay mouse-only, stuck drags | FIXED | Pointer Events + capture; keyboard path (arrows/Shift/Enter); pointercancel |
| L6 | window.confirm | FIXED | UI.confirmDialog (focus-trapped, styled) |
| L7 | No popup title; dead onboarded flag | FIXED | `<title>ImgFetch</title>`; dead write removed |
| L8 | "Blur" is fixed-14px pixelation | FIXED | Renamed Pixelate; block scales with image; one-time weak-redaction warning |
| L9 | EXIF GPS shown, no warning | FIXED | Privacy warning + "Save without metadata" (DOWNLOAD_STRIPPED, re-encode drops EXIF) |
| L10 | Cancel only cancels pending | FIXED | Active chrome.downloads cancelled too |
| L11 | Extension trusted from URL | FIXED | SNIFF_TYPE (Range-request magic bytes) corrects direct-download extensions |
| L12 | data: URL limit mismatch | FIXED | Per-path named limits + documented rationale |

## Phase D — UI/UX (audit §4)

| # | Item | Status |
|---|---|---|
| 1 | Popup hierarchy | FIXED — screenshot icon row; primary scan button |
| 2 | Grid interaction | FIXED — click toggles, magnifier previews, Invert selection |
| 3 | Filter bar | Already satisfied by H1 (chips, hidden-count, reset) |
| 4 | Queue progress | Partial — per-item status shown; byte-level speed deferred (needs downloads.onChanged plumbing) |
| 5 | Settings order | Considered — current 13-section order already matches the recommended hierarchy; File Names/Folders merge deferred (large restructure, modest gain) |
| 6 | Screenshot flow | Partial — capture page has Save/Annotate; clipboard copy deferred |
| 7 | Menu depth | FIXED — 6-item top level; Save as… flattened to one submenu; Lens/Open Original under More |
| 8 | Premium look | Considered — tokens, spacing, shadows already consistent; full redesign out of scope for a fix pass |
| 9 | Accessibility | FIXED — aria-live on scan + queue; titles on all pages |
| 10 | Honest copy | FIXED — "best available version" replaces "best quality" claims |

## Remaining risks (honest)

- No real-browser acceptance yet: needs the manual matrix (Chrome/Edge stable, Chrome 116) — worker-restart mid-bulk, 200-image ZIP, 20000 px capture at DPR 2.
- SNIFF_TYPE adds one tiny Range request per direct download; servers ignoring Range fall back to full 32-byte fetch — still cheap, but it's a behavior change to watch.
- IndexedDB capture store: quota errors are caught and fall back to the memory cache; private-mode edge cases untested.
- Store review outcome can't be guaranteed; M8 work is risk reduction.

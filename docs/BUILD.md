# ImgFetch, Build & packaging instructions

No toolchain required: ImgFetch is dependency-free and loads unpacked as-is.
Packaging only zips the extension files for store upload.

## 1. Validate

```bash
cd imgfetch
python3 scripts/validate.py   # JSON, manifest refs, JS syntax, security checks
node tests/test-core.mjs      # 107 unit tests
```

Both must pass before packaging.

## 2. Regenerate icons (optional)

```bash
python3 scripts/make-icons.py  # needs Pillow; writes icons/icon-{16,32,48,128}.png
```

## 3. Package

```bash
bash scripts/package.sh
```

Produces (in `dist/`):
- `imgfetch-chrome-1.0.0.zip`
- `imgfetch-edge-1.0.0.zip`

The two zips contain identical files, Chrome and Edge both accept the same
Manifest V3 package; separate names are for your own release bookkeeping.
package.sh extracts both zips and runs diff -r; the build fails if they
differ by anything. Shipped inside the zips: manifest.json, the code folders
(background, content, core, offscreen, options, pages, popup, shared),
icons, LICENSE, README.md, PRIVACY.md, TERMS.md, CHANGELOG.md, and
docs/USER_GUIDE.md, docs/PERMISSIONS.md, docs/LIMITATIONS.md. Everything
else (tests/, scripts/, docs/history, docs/tests, the other docs, assets/,
store-assets/) stays in the repository only.

## 4. Publish

**Chrome Web Store:** Developer Dashboard → New item → upload
`imgfetch-chrome-1.0.0.zip` → fill the listing (the permission justifications in
`docs/PERMISSIONS.md` map directly onto the store's disclosure questions) →
submit for review.

**Edge Add-ons:** Partner Center → New extension → upload
`imgfetch-edge-1.0.0.zip` → same listing flow.

## 5. Versioning

- Bump `version` in `manifest.json` and add a `CHANGELOG.md` entry.
- Re-run validation + tests, re-package, upload the new zip.

## Manual release checklist

Before every store submission, walk `docs/tests/README.md` → “Manual test plan”
on real Chrome and Edge builds.

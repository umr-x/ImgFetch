#!/usr/bin/env bash
# ImgFetch - smart image downloader
# Copyright (C) 2026 ImgFetch Developer
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
# ImgFetch packaging: validate, test, then build Chrome/Edge store zips.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== ImgFetch: validating =="
python3 scripts/validate.py
for t in tests/test-*.mjs; do
  echo "-- $t"
  # test-svg-real-dom.mjs self-skips when jsdom is absent; give it jsdom when present.
  if [ -d "$HOME/workspace/imgfetch-testdeps/node_modules" ]; then
    NODE_PATH="$HOME/workspace/imgfetch-testdeps/node_modules${NODE_PATH:+:$NODE_PATH}" node "$t" || exit 1
  else
    node "$t" || exit 1
  fi
done
node scripts/check-duplicates.mjs || exit 1
node scripts/regression-diff.mjs || exit 1

VERSION="$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")"
DIST="$ROOT/dist"
rm -rf "$DIST"
mkdir -p "$DIST"

# Store zip contents (I3): manifest, code folders, icons, licence and the
# user-facing docs only. Excluded: assets/, docs/history, docs/tests,
# docs/ARCHITECTURE.md, docs/BUILD.md, docs/PERFORMANCE.md,
# docs/security-model.md, SECURITY.md, tests/, scripts/, store-assets/,
# results JSON, dist/.
INCLUDE=(
  manifest.json
  background content core offscreen options pages popup shared icons
  LICENSE README.md PRIVACY.md TERMS.md CHANGELOG.md
  docs/USER_GUIDE.md docs/PERMISSIONS.md docs/LIMITATIONS.md
)

for TARGET in chrome edge; do
  ZIP="$DIST/imgfetch-${TARGET}-${VERSION}.zip"
  rm -f "$ZIP"
  zip -q -r "$ZIP" "${INCLUDE[@]}" \
    -x "*/.*" "*/__pycache__/*" "tests/test-e2e/results-*.json"
  echo "built: $ZIP ($(du -h "$ZIP" | cut -f1))"
done

# F1: the two zips must be identical in content (only the file name differs).
# Extract both and diff; fail the build on any difference.
TMPD="$(mktemp -d)"
unzip -q "$DIST/imgfetch-chrome-${VERSION}.zip" -d "$TMPD/chrome"
unzip -q "$DIST/imgfetch-edge-${VERSION}.zip" -d "$TMPD/edge"
if ! diff -r "$TMPD/chrome" "$TMPD/edge" > "$TMPD/zipdiff.txt" 2>&1; then
  echo "FATAL: Chrome and Edge zips differ:"
  cat "$TMPD/zipdiff.txt"
  rm -rf "$TMPD"
  exit 1
fi
rm -rf "$TMPD"
echo "== zip content check: Chrome and Edge identical =="

echo "== done =="

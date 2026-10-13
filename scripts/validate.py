#!/usr/bin/env python3
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
"""ImgFetch static validation: JSON, JS syntax, manifest sanity, no remote code."""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Allow running against an extracted zip: pass the directory as argv[1].
# Files that live in the project but are excluded from store zips.
ZIP_EXCLUDED = {
    'assets/brand/', 'assets/brand/imgfetch-mark-exact.svg',
    'assets/brand/imgfetch-mark-master.png',
    'store-assets/', 'store-assets/promo-tile-440x280.png',
    'MANUAL_MATRIX_CHECKLIST.md',
}
if len(sys.argv) > 1:
    ROOT = Path(sys.argv[1]).resolve()
# IS_ZIP: validating an extracted store zip (not the dev tree). The README
# tree documents the repo; the zip holds a subset, so the reverse tree
# check (every tree entry exists on disk) is skipped for zips.
IS_ZIP = len(sys.argv) > 1
failures = []


def fail(msg):
    failures.append(msg)
    print(f"FAIL: {msg}")


def ok(msg):
    print(f"ok: {msg}")


# 1. manifest.json parses and has required MV3 fields.
manifest_path = ROOT / "manifest.json"
try:
    manifest = json.loads(manifest_path.read_text())
    ok("manifest.json is valid JSON")
except Exception as e:
    fail(f"manifest.json invalid: {e}")
    manifest = {}

for field in ["manifest_version", "name", "version", "background", "action"]:
    if field not in manifest:
        fail(f"manifest missing required field: {field}")
if manifest.get("manifest_version") != 3:
    fail("manifest_version must be 3")

# Every file referenced by the manifest must exist.
refs = []
bg = manifest.get("background", {})
if isinstance(bg, dict) and bg.get("service_worker"):
    refs.append(bg["service_worker"])
action = manifest.get("action", {})
if isinstance(action, dict):
    if action.get("default_popup"):
        refs.append(action["default_popup"])
if manifest.get("options_page"):
    refs.append(manifest["options_page"])
for size, path in (manifest.get("icons") or {}).items():
    refs.append(path)
for path in refs:
    if not (ROOT / path).exists():
        fail(f"manifest references missing file: {path}")
if refs:
    ok(f"all {len(refs)} manifest file references exist")

# 2. JS syntax check with node.
js_files = sorted(ROOT.rglob("*.js")) + sorted(ROOT.rglob("*.mjs"))
if not js_files:
    fail("no JS files found")
node_ok = True
for f in js_files:
    rel = f.relative_to(ROOT)
    if "node_modules" in str(rel):
        continue
    r = subprocess.run(["node", "--check", str(f)], capture_output=True, text=True)
    if r.returncode != 0:
        node_ok = False
        fail(f"syntax error in {rel}: {r.stderr.strip()[:300]}")
if node_ok:
    ok(f"node --check passed for {len(js_files)} JS files")

# 3. No remote code: extension JS/HTML must not fetch remote scripts.
remote_re = re.compile(r"""src\s*=\s*["']https?://|from\s+["']https?://|import\s*\(\s*["']https?://""")
for f in list(ROOT.rglob("*.js")) + list(ROOT.rglob("*.mjs")) + list(ROOT.rglob("*.html")):
    rel = f.relative_to(ROOT)
    if rel.parts[0] in ("docs", "hidden", "tests"):
        continue
    try:
        text = f.read_text()
    except Exception:
        continue
    for i, line in enumerate(text.splitlines(), 1):
        if remote_re.search(line):
            fail(f"remote code reference in {rel}:{i}: {line.strip()[:100]}")
ok("no remote script references in extension code")

# 3b. No inline scripts: MV3's CSP blocks them, so every page script must be
# external (this silently broke pages/annotate.html once — never again).
inline_re = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>")
for f in ROOT.rglob("*.html"):
    rel = f.relative_to(ROOT)
    if rel.parts[0] in ("docs", "hidden"):
        continue
    try:
        text = f.read_text()
    except Exception:
        continue
    if inline_re.search(text):
        fail(f"inline <script> in {rel} — MV3 CSP blocks it; use an external file")
ok("no inline scripts in extension pages")

# 4. No innerHTML with untrusted data patterns (quick heuristic).
dangerous = re.compile(r"\.innerHTML\s*=")
for f in list(ROOT.rglob("*.js")) + list(ROOT.rglob("*.mjs")):
    rel = f.relative_to(ROOT)
    if rel.parts[0] in ("docs", "hidden", "tests"):
        continue
    text = f.read_text()
    if dangerous.search(text):
        fail(f"{rel} uses innerHTML (use textContent/DOM instead)")

# 5. Permissions used in code should be declared (spot check).
declared = set(manifest.get("permissions", []))
code = "\n".join(
    f.read_text()
    for f in list(ROOT.rglob("*.js")) + list(ROOT.rglob("*.mjs"))
    if f.relative_to(ROOT).parts[0] not in ("docs", "hidden", "tests")
)
for perm, api in {
    "contextMenus": "contextMenus",
    "downloads": "downloads.download",
    "storage": "storage.local",
    "scripting": "scripting.executeScript",
    "offscreen": "offscreen.createDocument",
    "notifications": "notifications.create",
}.items():
    if api in code and perm not in declared:
        fail(f"code uses chrome.{api} but '{perm}' not declared")
ok("permission usage matches declarations")

# 6. Brand check: user-visible name should be ImgFetch.
if manifest.get("name") != "ImgFetch":
    fail("manifest name is not ImgFetch")

# 7. B5: README project structure must match the real file tree.
# The tree lists basenames under each directory, so match on basenames
# (they are unique in this project — enforced below).
readme_text = (ROOT / "README.md").read_text()
tree_files = []
for f in sorted(ROOT.rglob("*")):
    if not f.is_file():
        continue
    rel = f.relative_to(ROOT)
    if rel.parts[0] in ("dist", "hidden", "private", "node_modules", ".git"):
        continue
    if "__pycache__" in rel.parts or rel.suffix == ".pyc":
        continue
    # Generated e2e evidence — lives in TEST_REPORT.md, not in the zip.
    if rel.match("tests/test-e2e/results-*.json"):
        continue
    tree_files.append(rel.as_posix())
basenames = [Path(p).name for p in tree_files]
# README.md is conventional in subdirectories; allow it to repeat.
dupes = {b for b in basenames if b != 'README.md' and basenames.count(b) > 1}
if dupes:
    fail(f"basename check needs unique names, duplicates: {sorted(dupes)}")
missing_from_readme = [p for p in tree_files if Path(p).name not in readme_text]
for p in missing_from_readme:
    fail(f"README does not mention real project file: {p}")
if not missing_from_readme and not dupes:
    ok(f"README mentions all {len(tree_files)} project files")
# Reverse direction: names listed in the tree block must exist.
# Skipped for extracted store zips (the tree documents the full repo).
listed_names = set()
for line in readme_text.splitlines():
    m = re.search(r"[├└]──\s+([^\s#]+)", line)
    if m:
        listed_names.add(m.group(1).strip())
known_basenames = {Path(p).name for p in tree_files}
reverse_bad = 0
zip_excluded_basenames = {Path(p.rstrip('/')).name for p in ZIP_EXCLUDED}
if IS_ZIP:
    ok("README tree reverse check skipped for extracted zip")
else:
    for name in sorted(listed_names):
        # Project-only files (brand assets, store graphics, manual matrix) are
        # excluded from store zips; do not fail when validating an extracted zip.
        # README lists basenames, so match on basename as well as full path.
        if (name in ZIP_EXCLUDED or name.rstrip('/') in zip_excluded_basenames
                or any(name == p or p.startswith(name) for p in ZIP_EXCLUDED)):
            continue
        if name.endswith('/'):
            # Directory entry: must exist as a directory somewhere in the tree.
            stripped = name.rstrip('/')
            found = any(
                (ROOT / p / stripped).is_dir()
                for p in [Path('.'), Path('tests'), Path('scripts'), Path('docs')]
            ) or (ROOT / stripped).is_dir()
            if not found:
                fail(f"README lists unknown directory: {name}")
                reverse_bad += 1
        elif "/" in name:
            if not (ROOT / name).exists():
                fail(f"README lists missing path: {name}")
                reverse_bad += 1
        elif name not in known_basenames:
            fail(f"README lists unknown file: {name}")
            reverse_bad += 1
    if reverse_bad == 0:
        ok("README tree entries all exist")

# 8. B5: every export from core/*.js must be used somewhere (no dead exports).
# Dev-tree check only: the store zip excludes tests/, which exercise some
# exports, so this does not apply to extracted zips.
search_roots = [
    f
    for f in list(ROOT.rglob("*.js")) + list(ROOT.rglob("*.mjs"))
    if f.relative_to(ROOT).parts[0] not in ("docs", "hidden", "dist", "node_modules")
]
if IS_ZIP:
    ok("dead-exports check skipped for extracted zip (tests/ not shipped)")
else:
    core_exports = {}
    for f in sorted((ROOT / "core").glob("*.js")):
        text = f.read_text()
        for m in re.finditer(
            r"export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)", text
        ):
            core_exports.setdefault(m.group(1), f.name)
        for m in re.finditer(r"export\s*\{\s*([^}]+?)\s*\}", text):
            for part in m.group(1).split(","):
                nm = part.strip().split(" as ")[-1].strip()
                if nm and re.match(r"^[A-Za-z_$][\w$]*$", nm):
                    core_exports.setdefault(nm, f.name)
    dead = []
    for name, deffile in sorted(core_exports.items()):
        hits = 0
        for f in search_roots:
            n = len(re.findall(r"\b" + re.escape(name) + r"\b", f.read_text()))
            if f.name == deffile:
                n = max(0, n - 1)  # the export declaration itself doesn't count
            hits += n
            if hits > 0:
                break
        if hits == 0:
            dead.append(f"core/{deffile} exports '{name}' but nothing uses it")
    for d in dead:
        fail(d)
    if not dead:
        ok(f"all {len(core_exports)} core exports are used somewhere")

# 9. B5: forbidden patterns in shipped extension code.
forbidden = [
    (re.compile(r"\beval\s*\("), "eval()"),
    (re.compile(r"\bnew\s+Function\s*\("), "new Function()"),
    (re.compile(r"\bconsole\.log\s*\("), "console.log (use console.debug)"),
    (re.compile(r"\bTODO\b|\bFIXME\b|\bXXX\b"), "TODO/FIXME marker"),
]
prod_js = [
    f
    for f in search_roots
    if f.relative_to(ROOT).parts[0] not in ("tests", "scripts")
]
for rx, label in forbidden:
    hits = []
    for f in prod_js:
        for i, line in enumerate(f.read_text().splitlines(), 1):
            if rx.search(line):
                hits.append(f"{f.relative_to(ROOT)}:{i}")
    for h in hits:
        fail(f"forbidden pattern {label} in {h}")
    if not hits:
        ok(f"no {label} in shipped code")

# 9c. About page must carry the GPL section 5d notice (Appropriate Legal
# Notices) and must not point at docs/ paths that are not shipped.
about_html = (ROOT / "options" / "options.html").read_text()
for snippet in [
    "ABSOLUTELY NO WARRANTY",
    "GNU General Public License v3 or later",
    "aboutLicenceLink",
]:
    if snippet not in about_html:
        fail(f"options/options.html About section is missing: {snippet!r}")
if "docs/PRIVACY.md" in about_html:
    fail("About section still points at docs/PRIVACY.md (not shipped)")
if not [l for l in about_html.splitlines() if 'id="aboutLicence"' in l]:
    fail("About section is missing the licence notice paragraph")
if "ABSOLUTELY NO WARRANTY" in about_html:
    ok("About section carries the GPL legal notice")

print()
# 9b. Licence headers: every shipped .js/.mjs/.html/.css must carry the
# GPL header ("Copyright (C) 2026 ImgFetch Developer") near the top.
header_marker = "Copyright (C) 2026 ImgFetch Developer"
headerless = []
for f in list(ROOT.rglob("*.js")) + list(ROOT.rglob("*.mjs")) + \
        list(ROOT.rglob("*.html")) + list(ROOT.rglob("*.css")):
    rel = f.relative_to(ROOT)
    if rel.parts[0] in ("docs", "hidden", "dist", "node_modules"):
        continue
    head = f.read_text(encoding="utf-8", errors="replace")[:2000]
    if header_marker not in head:
        headerless.append(str(rel))
for h in headerless:
    fail(f"missing licence header: {h}")
if not headerless:
    ok("all shipped JS/HTML/CSS files carry the licence header")

print()
if failures:
    print(f"{len(failures)} FAILURE(S) in static checks")
    sys.exit(1)
print("ALL STATIC CHECKS PASSED — running docs/claims linter...")

# 10. Docs/claims linter (final-round pattern check #9): README, CHANGELOG,
# docs and the manifest must agree with each other and with reality.
# Test counts are generated by RUNNING the tests, never typed by hand.
import os

manifest_version = manifest.get("version", "")

# 10a. Version: README's "Version X" line and CHANGELOG must name the
# manifest version.
if f"Version {manifest_version}" not in readme_text:
    fail(f"README does not state 'Version {manifest_version}' (manifest)")
else:
    ok(f"README states Version {manifest_version}")
changelog_text = (ROOT / "CHANGELOG.md").read_text()
if manifest_version not in changelog_text:
    fail(f"CHANGELOG.md does not mention version {manifest_version}")
else:
    ok(f"CHANGELOG.md mentions version {manifest_version}")

# 10b. Shortcuts: every suggested_key in the manifest must appear in README.
suggested = []
for cmd, spec in (manifest.get("commands") or {}).items():
    key = ((spec or {}).get("suggested_key") or {}).get("default")
    if key:
        suggested.append(key)
missing_keys = [k for k in suggested if k not in readme_text]
if missing_keys:
    fail(f"README shortcut list misses manifest suggested keys: {missing_keys}")
else:
    ok(f"README lists all {len(suggested)} manifest suggested shortcuts")

# 10c. Permissions: docs/PERMISSIONS.md must justify every manifest permission.
perms_doc = (ROOT / "docs" / "PERMISSIONS.md").read_text()
missing_perms = [p for p in declared if p not in perms_doc]
if missing_perms:
    fail(f"docs/PERMISSIONS.md does not mention permissions: {missing_perms}")
else:
    ok(f"docs/PERMISSIONS.md covers all {len(declared)} permissions")

# 10d. Test counts: run every tests/test-*.mjs, parse "N passed", and require
# the README tree comment for that file to state the same N.
test_env = dict(os.environ)
local_jsdom = Path.home() / "workspace" / "imgfetch-testdeps" / "node_modules"
if local_jsdom.is_dir():
    test_env["NODE_PATH"] = str(local_jsdom) + (
        ":" + test_env["NODE_PATH"] if test_env.get("NODE_PATH") else ""
    )
count_fail = 0
for tf in sorted((ROOT / "tests").glob("test-*.mjs")):
    r = subprocess.run(
        ["node", str(tf)], capture_output=True, text=True, env=test_env, timeout=120
    )
    out = (r.stdout or "") + (r.stderr or "")
    if "SKIPPED" in out:
        ok(f"{tf.name}: skipped (optional dependency missing) — count check waived")
        continue
    m = re.search(r"(\d+)\s+passed,\s*(\d+)\s+failed", out)
    if not m or r.returncode != 0:
        fail(f"{tf.name}: did not run green: {(out.strip()[:200])}")
        count_fail += 1
        continue
    passed, failed = int(m.group(1)), int(m.group(2))
    if failed:
        fail(f"{tf.name}: {failed} test(s) failed")
        count_fail += 1
        continue
    # Find the README tree line for this file and its claimed count.
    claimed = None
    for line in readme_text.splitlines():
        if tf.name in line:
            cm = re.search(r"#\s*(\d+)", line)
            if cm:
                claimed = int(cm.group(1))
            break
    if claimed is None:
        fail(f"README tree has no count comment for {tf.name}")
        count_fail += 1
    elif claimed != passed:
        fail(f"README claims {claimed} for {tf.name} but the run shows {passed}")
        count_fail += 1
if count_fail == 0:
    ok("README test counts match real test runs")

# F4: shortcuts must agree across manifest, README, USER_GUIDE, and welcome.
# Welcome page uses chrome.commands.getAll() dynamically, so it must not
# hardcode shortcut strings.
manifest_cmds = manifest.get('commands', {})
expected = {}
for name, cmd in manifest_cmds.items():
    sk = cmd.get('suggested_key', {})
    if sk.get('default'):
        expected[name] = sk['default']
readme_text_full = (ROOT / "README.md").read_text()
guide_text = (ROOT / "docs" / "USER_GUIDE.md").read_text()
welcome_html = (ROOT / "pages" / "welcome.html").read_text()
for name, shortcut in expected.items():
    if shortcut not in readme_text_full:
        fail(f"README missing shortcut {shortcut} for {name}")
    if shortcut not in guide_text:
        fail(f"USER_GUIDE missing shortcut {shortcut} for {name}")
# Welcome must not hardcode (it reads live via getAll); Ctrl+Shift+C was wrong.
if 'Ctrl+Shift+C' in welcome_html:
    fail("welcome.html still contains the wrong Ctrl+Shift+C")
if re.search(r'Ctrl\+Shift\+[SXE]', welcome_html):
    fail("welcome.html hardcodes shortcuts; use chrome.commands.getAll()")
if not failures or all('shortcut' not in f.lower() and 'welcome' not in f.lower() for f in failures):
    ok("shortcuts agree across manifest, README, USER_GUIDE; welcome is dynamic")

# Format conversion in the single-download path must route through
# convertSource (per-format encoders: GIF/BMP/SVG have dedicated converters).
# The old inline CONVERT_IMAGE call rejected gif/bmp/svg, which fell back to
# the source URL saved as PNG ("Save as GIF" saved a PNG).
sw_text = (ROOT / "background" / "service-worker.js").read_text()
if 'convert-failed-internal' in sw_text:
    fail("service-worker still uses the inline CONVERT_IMAGE conversion path")
else:
    ok("no inline CONVERT_IMAGE conversion path in service-worker")
if 'convertSource(finalUrl, want, settings, pageUrl)' not in sw_text:
    fail("single-download conversion does not route through convertSource")
else:
    ok("single-download conversion routes through convertSource")

print()
if failures:
    print(f"{len(failures)} FAILURE(S)")
    sys.exit(1)
print("ALL CHECKS PASSED (including docs/claims linter)")

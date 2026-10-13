# Contributing to ImgFetch

## Before you start

Open an issue first describing what you want to change and why, so the
approach can be agreed before you write code.

## Licence

Contributions are accepted under the GNU General Public License v3 or
later, the same licence as ImgFetch itself. By contributing you agree that
your changes will be distributed under those terms.

## Before a pull request

Run the full release check:

```
bash scripts/release-check.sh
```

It runs every test, the static validator, the packaging step and writes
`docs/tests/test-report.md` from real output. The check must pass with no
failures. Do not bump the version number.

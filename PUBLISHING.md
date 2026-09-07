# Marketplace Publishing Checklist

Tracks remaining work before first `vsce publish`. See `scripts/install-local.sh --publish-help` for the step-by-step publish commands once these are done.

## Blocking

- [x] **`icon.png`** — 256×256 PNG at repo root, generated via `scripts/generate-icon.py` (placeholder table-grid glyph; swap for real branding before publish if wanted).
- [ ] **Push repo to GitHub** — `git remote -v` is empty. `package.json`'s `repository.url` points at `github.com/gerardovitale/tablas`, which doesn't exist yet. Add remote, push.
- [ ] **Publisher account** — create at https://marketplace.visualstudio.com/manage, publisher id `gerardovitale` (must match `package.json`).
- [ ] **PAT + login** — Azure DevOps PAT (scope: Marketplace → Manage), then `vsce login gerardovitale`.
- [x] **DuckDB multi-platform strategy** — `scripts/package-targets.sh` builds one `.vsix` per platform. Note: `vsce package --target <x>` does **not** prune `node_modules` by target on its own (verified empirically — packaging `--target linux-x64` while both `darwin-arm64` and `linux-x64` bindings were installed shipped both, ~180MB). The script works around this by swapping in exactly one `@duckdb/node-bindings-<arch>` package per target before each `vsce package` call, and pruning back anything npm silently re-adds (npm re-resolves the lockfile and restores the dev machine's own matching optionalDependency on every `npm install`, even a scoped `--force` one). Builds all 8 targets DuckDB ships bindings for (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `alpine-x64`, `alpine-arm64`, `win32-x64`, `win32-arm64`; no `win32-ia32`/`linux-armhf` — DuckDB has no bindings for either). Each `.vsix` drops from ~58MB (both platforms present) to ~15–36MB (one). Packaging-only: doesn't prove a foreign-platform `.vsix` actually loads — a linux `.so`/win32 `.dll` can't be exercised on this macOS dev machine, so still needs a real smoke test per platform (or CI runners) before publish.

## Before hitting publish

- [x] Dry-run all 8 targets locally via `scripts/package-targets.sh`, inspected `.vsix` contents/size — confirmed exactly one `@duckdb/node-bindings-*` per package.
- [ ] Smoke-test at least one non-macOS `.vsix` on its real platform (or CI) — packaging-only dry-run above doesn't prove the native binding loads.
- [ ] `CHANGELOG.md` entry for the version being published (0.1.0 draft already in place).
- [ ] `npm test` green (compile + tsc + vscode-test, unit + integration).

## Publish

Build all platform `.vsix`s, then publish each:

```bash
scripts/package-targets.sh          # writes dist-vsix/tablas-<version>-<target>.vsix
vsce publish --packagePath dist-vsix/tablas-0.1.0-darwin-arm64.vsix
vsce publish --packagePath dist-vsix/tablas-0.1.0-darwin-x64.vsix
# ...repeat per target in dist-vsix/
```

`scripts/package-targets.sh --skip-build` reuses an existing `dist/` (skips `compile:production`); pass specific targets (e.g. `scripts/package-targets.sh linux-x64 win32-x64`) to build a subset.

## Later / nice-to-have

- [ ] Marketplace `galleryBanner` (color/theme) in `package.json` — optional, improves listing page look.
- [ ] Screenshots/GIF in README for the Marketplace page (README is shown there as-is).

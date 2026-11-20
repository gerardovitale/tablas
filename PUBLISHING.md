# Marketplace Publishing Checklist

Tracks remaining work before first `vsce publish`. See `scripts/install-local.sh --publish-help` for the step-by-step publish commands once these are done.

## Blocking

- [x] **`icon.png`** — 256×256 PNG at repo root, generated via `scripts/generate-icon.py` (placeholder table-grid glyph; swap for real branding before publish if wanted).
- [ ] **Push `main` to GitHub** — `origin` is `git@github.com:gerardovitale/tablas.git` but local commits are unpushed. `package.json`'s `repository.url` points there, and `.github/workflows/package.yml` (per-platform builds) only runs once it is pushed.
- [ ] **Publisher account** — create at https://marketplace.visualstudio.com/manage, publisher id `gerardovitale` (must match `package.json`).
- [ ] **PAT + login** — Azure DevOps PAT (scope: Marketplace → Manage), then `vsce login gerardovitale`.
- [ ] **DuckDB multi-platform strategy** — `.github/workflows/package.yml` builds each target on a runner of its own platform (the two Alpine targets in a `node:20-alpine` container), runs `scripts/smoke-package.js` (layout check plus opening a DuckDB and a SQLite file from the packaged layout) and uploads `tablas-<target>.vsix` as an artifact; it does not publish. Needs a green run on all 8 targets (runner labels `macos-15-intel`, `windows-11-arm`, `ubuntu-24.04-arm` have not been exercised yet, and the arm runners are only free for public repositories). `scripts/package-targets.sh` remains the local cross-packaging alternative, but it cannot prove a foreign `.vsix` loads.

## Before hitting publish

- [x] Dry-run all 8 targets locally via `scripts/package-targets.sh`, inspected `.vsix` contents/size — confirmed exactly one `@duckdb/node-bindings-*` per package.
- [ ] Package workflow green on all 8 targets, and one non-macOS `.vsix` artifact opened in a real VS Code window (the CI smoke test does not start VS Code).
- [ ] `CHANGELOG.md` entry for the version being published (0.1.0 draft already in place).
- [ ] `npm test` green (compile + tsc + vscode-test, unit + integration).
- [ ] DuckDB engine: `npm view @duckdb/node-api dist-tags`; if `latest` moved past the exact pin in `package.json` (`2.0.0-r.1`), bump it and re-run `npm test` before building the `.vsix`s.

## Publish

Take the per-target `.vsix` files from the package workflow's artifacts (or build them with `scripts/package-targets.sh`), then publish each:

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

# Marketplace Publishing Checklist

Tracks remaining work before first `vsce publish`. See `scripts/install-local.sh --publish-help` for the step-by-step publish commands once these are done.

## Blocking

- [x] **`icon.png`** — 256×256 PNG at repo root, generated via `scripts/generate-icon.py` (placeholder table-grid glyph; swap for real branding before publish if wanted).
- [ ] **Push `main` to GitHub** — `origin` is `git@github.com:gerardovitale/tablas.git` but local commits are unpushed. `package.json`'s `repository.url` points there, and `.github/workflows/package.yml` (per-platform builds) only runs once it is pushed.
- [x] **Publisher account** — publisher id `gerardovitale` exists (matches `package.json`; the id cannot be changed).
- [x] **Trusted Publishing policy** — "Release workflow" on that publisher: GitHub Actions, owner `gerardovitale`, repository `tablas`, workflow `publish.yml`, no environment. No PAT is used: Azure DevOps retires global PATs on 2026-12-01, and `.github/workflows/publish.yml` publishes with `vsce publish --oidc` (a short-lived token exchanged from GitHub's OIDC token). The policy only accepts tokens from *that* workflow file, so do not move the publish step to another file or rename it without editing the policy. (If the repo is private, the policy must be used within 48 hours of creation.)
- [x] **DuckDB multi-platform strategy** — `.github/workflows/package.yml` builds each target on a runner of its own platform (the two Alpine targets in a `node:20-alpine` container), runs `scripts/smoke-package.js` (layout check plus opening a DuckDB and a SQLite file from the packaged layout) and uploads `tablas-<target>.vsix` as an artifact; it does not publish. The first run (2026-11-20) was green on all 8 targets. `scripts/package-targets.sh` remains the local cross-packaging alternative, but it cannot prove a foreign `.vsix` loads.

## Before hitting publish

- [x] Dry-run all 8 targets locally via `scripts/package-targets.sh`, inspected `.vsix` contents/size — confirmed exactly one `@duckdb/node-bindings-*` per package.
- [x] Package workflow green on all 8 targets (2026-11-20).
- [ ] One non-macOS `.vsix` artifact opened in a real VS Code window (the CI smoke test does not start VS Code).
- [ ] `CHANGELOG.md` entry for the version being published (0.1.0 draft already in place).
- [ ] `npm test` green (compile + tsc + vscode-test, unit + integration).
- [ ] DuckDB engine: `npm view @duckdb/node-api dist-tags`; if `latest` moved past the exact pin in `package.json` (`2.0.0-r.1`), bump it and re-run `npm test` before building the `.vsix`s.

## Publish

Nothing is published from a laptop. A published version cannot be replaced, so before the run:

1. Bump `version` in `package.json` and give `CHANGELOG.md` a dated section for it. The first release is `0.1.0`, and its section (dated 2026-11-20) is already written: change that date to the day you publish. For later releases, move `[Unreleased]` into a new dated section.
2. Push `main`, and wait for the **Package** workflow to be green on all 8 targets.
3. Actions -> **Publish** -> *Run workflow* on `main`. First run it with **publish unticked**: it rebuilds and smoke-tests every target (and uploads the `.vsix` files as artifacts) without publishing.
4. Run it again with **publish ticked**. It checks that all 8 `.vsix` files exist, then runs `npx @vscode/vsce publish --oidc --packagePath vsix/*.vsix`.

Not yet exercised: whether `vsce publish --oidc` accepts `--packagePath` with several platform-specific `.vsix` files (the docs only show `publish --oidc` building the package itself). If the first real run rejects it, change that one step, for example to one `--packagePath` call per file or `vsce publish --oidc --target <t>` per target after a build.

## Later / nice-to-have

- [ ] Marketplace `galleryBanner` (color/theme) in `package.json` — optional, improves listing page look.
- [ ] Screenshots/GIF in README for the Marketplace page (README is shown there as-is).

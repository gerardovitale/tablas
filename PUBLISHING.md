# Marketplace Publishing Checklist

Tracks the release process. **0.1.0 was published on 2026-11-21 for all 8 targets** (see "State of 0.1.0" below); the checklists record what was done for the first release. See `scripts/install-local.sh --publish-help` for the short version.

## Blocking

- [x] **`icon.png`** — 256×256 PNG at repo root, generated via `scripts/generate-icon.py` (placeholder table-grid glyph; swap for real branding before publish if wanted).
- [x] **Push `main` to GitHub** — `origin` is `git@github.com:gerardovitale/tablas.git` but local commits are unpushed. `package.json`'s `repository.url` points there, and `.github/workflows/package.yml` (per-platform builds) only runs once it is pushed.
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

1. Bump `version` in `package.json` and give `CHANGELOG.md` a dated section for it (set the date to the day you publish).
2. Push `main`, and wait for the **Package** workflow to be green on all 8 targets.
3. Actions -> **Publish** -> *Run workflow* on `main`. First run it with **publish unticked**: it rebuilds and smoke-tests every target (and uploads the `.vsix` files as artifacts) without publishing.
4. Run it again with **publish ticked** and **confirm_version** set to the version in `package.json` (the run refuses to publish if they differ, so a stray tick does nothing). It checks that all 8 `.vsix` files exist, then runs `npx @vscode/vsce publish --oidc --packagePath <files>`. **targets** (space-separated, e.g. `linux-x64 win32-x64`; empty means all 8) limits which targets are published.

**State of 0.1.0 (2026-11-21):** published for all 8 targets. A first Publish run was started with *publish* ticked by mistake and cancelled while running; it had already published `alpine-arm64` (validated by the Marketplace), and no other target. A second run (44905404375, `0e80950`) published the other 7 with `targets` set to them: `alpine-x64 darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-arm64 win32-x64`. A target cannot be published twice for the same version, which is why that input exists. The `alpine-arm64` package was built from `469dc88` and the other seven from `0e80950`; the only difference is workflow files, which are not in the `.vsix`. The packages carry the changelog date `2026-11-20`; the repository now says `2026-11-21`, the day it was published.

Those runs showed that `vsce publish --oidc --packagePath` with a list of platform-specific `.vsix` files works: Trusted Publishing was accepted and each file was published in turn (about 4 seconds each). Each target then goes through Marketplace validation and sends a confirmation email.

## Later / nice-to-have

- [ ] Marketplace `galleryBanner` (color/theme) in `package.json` — optional, improves listing page look.
- [ ] Screenshots/GIF in README for the Marketplace page (README is shown there as-is).

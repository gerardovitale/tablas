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

Nothing is published from a laptop. A published version cannot be replaced. **A release is a pushed `vX.Y.Z` tag.**

1. Bump `version` in `package.json` (and `package-lock.json`: `npm install --package-lock-only`), and turn `[Unreleased]` in `CHANGELOG.md` into a dated `## [X.Y.Z] - YYYY-MM-DD` section (the day you publish). Run `npm test`.
2. Commit, push `main`, and wait for the **Package** workflow to be green on all 8 targets.
3. `bash scripts/check-release.sh X.Y.Z --on-main HEAD` (the same check the workflow runs: `package.json` version, a dated changelog heading, the commit is on `origin/main`).
4. `git tag -a vX.Y.Z -m "Tablas X.Y.Z" && git push origin vX.Y.Z`. (The pre-push hook runs `npm test` again, so a tag push takes a minute.)
5. The tag starts **Publish** (`.github/workflows/publish.yml`, the workflow file *as at the tagged commit*): it re-runs the checks, builds and smoke-tests all 8 targets, publishes them with `vsce publish --oidc --skip-duplicate --packagePath <files>`, then creates the GitHub Release `vX.Y.Z` with the changelog section as notes and the 8 `.vsix` files attached. A wrong tag (version mismatch, undated changelog, not on `main`) fails in the first job, before any build; since nothing was published, fix the commit, then delete the tag locally and on `origin` (`git push origin :refs/tags/vX.Y.Z`) and tag the fixed commit again.
6. If the run fails part way, re-run the failed jobs: `--skip-duplicate` skips every target the Marketplace already has for that version, and the Release step edits an existing Release instead of failing. Once anything has been published for the version, do not move the tag: re-run instead.

**Rehearsal / manual fallback:** Actions -> **Publish** -> *Run workflow* on `main`. With **publish unticked** it only rebuilds and smoke-tests every target (and uploads the `.vsix` files as artifacts). With **publish ticked** and **confirm_version** set to the version in `package.json` it publishes (it refuses if they differ, so a stray tick does nothing); **targets** (space-separated, e.g. `linux-x64 win32-x64`; empty means all 8) limits which targets are published. A manual run makes no GitHub Release or tag.

**Trusted Publishing and tags:** the policy names `publish.yml` with no environment and no branch/tag condition, but until the first tag-triggered release it is untested that the Marketplace accepts an OIDC token whose ref is `refs/tags/vX.Y.Z` (all 0.1.0 publishes ran from `refs/heads/main`). If the first tag run's *publish* step is rejected for that reason, nothing was published: use the manual run on `main` instead (it makes no GitHub Release; create it by hand with `gh release create vX.Y.Z <the .vsix files from the run's artifacts> --notes-file <changelog section>`), and record the finding here.

**Recommended GitHub setting:** a repository ruleset restricting creation, update and deletion of `v*` tags to admins, since pushing one now publishes to the Marketplace.

**State of 0.1.0 (2026-11-21):** published for all 8 targets. A first Publish run was started with *publish* ticked by mistake and cancelled while running; it had already published `alpine-arm64` (validated by the Marketplace), and no other target. A second run (44905404375, `0e80950`) published the other 7 with `targets` set to them: `alpine-x64 darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-arm64 win32-x64`. A target cannot be published twice for the same version, which is why that input exists. The `alpine-arm64` package was built from `469dc88` and the other seven from `0e80950`; the only difference is workflow files, which are not in the `.vsix`. The packages carry the changelog date `2026-11-20`; the repository now says `2026-11-21`, the day it was published. `v0.1.0` was tagged afterwards, on `0e80950` (that commit's workflow has no tag trigger, so pushing it ran nothing); there is no GitHub Release for it.

Those runs showed that `vsce publish --oidc --packagePath` with a list of platform-specific `.vsix` files works: Trusted Publishing was accepted and each file was published in turn (about 4 seconds each). Each target then goes through Marketplace validation and sends a confirmation email.

## Later / nice-to-have

- [ ] Marketplace `galleryBanner` (color/theme) in `package.json` — optional, improves listing page look.
- [ ] Screenshots/GIF in README for the Marketplace page (README is shown there as-is).

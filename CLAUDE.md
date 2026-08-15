# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Vision

Tablas aims to become a JetBrains-style data-file editor for VS Code (think DataGrip's/IntelliJ's built-in table viewer): open a data file, see a real table, search it, edit a cell, done. See `README.md` for the user-facing pitch.

Current stage: local install only (`npm run install:local`, unpublished). Target: publish to the VS Code Marketplace under publisher `gerardovitale`. Keep marketplace-readiness in mind for anything packaging/metadata-related — `package.json` fields (`displayName`, `description`, `categories`, `keywords`, `icon`), `CHANGELOG.md` (required by `vsce`, doesn't exist yet), and an `icon.png` are still outstanding before a first `vsce publish`. See `scripts/install-local.sh --publish-help` for the full publishing checklist.

Today: CSV only, read-only. Planned, roughly in order:
1. **Parquet support** — a second source format feeding the same table renderer.
2. **In-table find/filter** — search within the rendered table (not VS Code's plain-text Ctrl+F).
3. **Basic cell editing** — writes back to the source file; requires moving off `CustomReadonlyEditorProvider` to a real edit model (dirty state, undo/redo, save).

Keep this trajectory in mind when touching the architecture below:
- New source formats (Parquet, etc.) should get their own parser module (parallel to `csvParser.ts`) that produces the *same* `{headers, rows, rowCount, columnCount}` shape, so `src/webview/main.js` doesn't need to know or care what format it came from.
- The extension-host-parses / webview-only-renders split is the thing to preserve — don't add format-specific logic to the webview.
- Editing support will need a real `vscode.CustomDocument` implementation (currently `CsvDocument` is a bare stub) plus an edit/undo model — flag this explicitly if asked to implement editing rather than quietly bolting writes onto the read-only provider.

## Commands

```bash
npm run compile              # esbuild both bundles (extension + webview), dev mode
npm run compile:production   # same, minified, no sourcemaps
npm run watch                # esbuild --watch, both bundles
npm run check-types          # tsc --noEmit
npm run test:unit            # fast: ts-node + mocha directly on test/unit/**, no Electron
npm test                     # full: compile + tsc (emits to out/) + vscode-test (unit + integration)
npm run install:local         # build, package, install into local VS Code (scripts/install-local.sh)
npm run install:local:quick   # same but --skip-tests
```

Run a single unit test file: `npx mocha --require ts-node/register test/unit/csvParser.test.ts`

There is no lint script configured.

## Architecture

Two independent esbuild bundles come out of `esbuild.js`, built together by `npm run compile`:

- `dist/extension.js` — CJS, Node platform, entry `src/extension.ts`. This is the extension host code (`main` in package.json). `papaparse` is bundled in here.
- `media/webview.js` — IIFE, browser platform, entry `src/webview/main.js`. This runs inside the VS Code webview sandbox.

**Parsing happens only in the extension host, never in the webview.** `src/csvParser.ts` wraps PapaParse and returns a `CsvParseOutcome` discriminated union (`{success: true, data, errors}` or `{success: false, errors}`). `src/csvEditorProvider.ts` reads the file, calls `parseCsv`, and posts the result to the webview as a `csv-data` message. The webview (`src/webview/main.js`) only renders pre-parsed data — it has no CSV-parsing logic and imports nothing from `csvParser` at runtime (only referenced in a JSDoc type import).

`CsvEditorProvider` (registered as `tablas.csvViewer`, a `CustomReadonlyEditorProvider`) does a ready-handshake: it waits for a `{type: 'ready'}` message from the webview before it reads/parses the file and posts `{type: 'csv-data', payload: outcome}` back. Webview HTML is built per-request with a fresh CSP nonce (`crypto.randomBytes(16)`) and `script-src 'nonce-...'`; `default-src 'none'`.

All DOM writes in `src/webview/main.js` use `textContent`/`setAttribute` only — never `innerHTML` — this is a deliberate XSS-safety rule for any rendered cell/header content, since CSV content is untrusted.

### Test setup

Two separate compiled outputs feed tests, both driven by `.vscode-test.mjs`:
- `unit` project: `out/test/unit/**/*.test.js`, no workspace/Electron needed conceptually but still run via `vscode-test`.
- `integration` project: `out/test/integration/**/*.test.js`, runs with `workspaceFolder: './test/fixtures'` and `extensionDevelopmentPath: '.'` — these tests open real fixture files through `vscode.commands.executeCommand('vscode.openWith', uri, 'tablas.csvViewer')` in an actual Extension Development Host.

`npm run test:unit` bypasses `vscode-test`/Electron entirely (ts-node + mocha directly against `.ts`), so use it for fast iteration on `csvParser.ts` logic. `npm test` is the only path that compiles to `out/` (via `tsc`, per `tsconfig.json`) and runs the integration suite — needed before verifying anything that touches `csvEditorProvider.ts` or the webview handshake.

Test style: `describe`/`it` (BDD), not `suite`/`test` — mocha is configured with `ui: 'bdd'` in both test projects.

Fixture paths in tests are built from `process.cwd()`, not `__dirname` — this is required for the same test file to work under both ts-node (`test:unit`) and the tsc-compiled output in `out/` (`test`).

## Packaging / publishing

`scripts/install-local.sh` builds production, runs `npm test` (unless `--skip-tests`), packages with `vsce package`, and installs the resulting `.vsix` via `code --install-extension`. Run `bash scripts/install-local.sh --publish-help` for the Marketplace publishing checklist (publisher id, PAT scope, `vsce login`/`vsce publish` steps).

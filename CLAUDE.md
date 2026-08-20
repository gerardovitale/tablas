# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Vision

Tablas aims to become a JetBrains-style data-file editor for VS Code (think DataGrip's/IntelliJ's built-in table viewer): open a data file, see a real table, search it, edit a cell, done. See `README.md` for the user-facing pitch.

Current stage: local install only (`npm run install:local`, unpublished). Target: publish to the VS Code Marketplace under publisher `gerardovitale`. Keep marketplace-readiness in mind for anything packaging/metadata-related — `package.json` fields (`displayName`, `description`, `categories`, `keywords`, `icon`), `CHANGELOG.md` (required by `vsce`, doesn't exist yet), and an `icon.png` are still outstanding before a first `vsce publish`. See `scripts/install-local.sh --publish-help` for the full publishing checklist.

Today: CSV, Parquet, and SQLite (`.db`/`.sqlite`/`.sqlite3`), read-only. Planned, roughly in order:
1. **DuckDB support** — a second multi-table source alongside SQLite, reusing `MultiTableParseOutcome`/the table-picker UI/the `select-table` message protocol (see the SQLite section below) rather than inventing a new one.
2. **In-table find/filter** — search within the rendered table (not VS Code's plain-text Ctrl+F).
3. **Basic cell editing** — writes back to the source file; requires moving off `CustomReadonlyEditorProvider` to a real edit model (dirty state, undo/redo, save).

Keep this trajectory in mind when touching the architecture below:
- New single-table source formats should get their own parser module (parallel to `csvParser.ts`/`parquetParser.ts`) that produces the *same* `{headers, rows, rowCount, columnCount}` shape (`ParsedTable` in `src/tableData.ts`), so `src/webview/main.js` doesn't need to know or care what format it came from. New *multi-table* sources (parallel to `sqliteParser.ts`) instead produce `MultiTableParseOutcome`.
- The extension-host-parses / webview-only-renders split is the thing to preserve — don't add format-specific logic to the webview.
- Editing support will need a real `vscode.CustomDocument` implementation (currently `CsvDocument`/`ParquetDocument` are bare stubs) plus an edit/undo model — flag this explicitly if asked to implement editing rather than quietly bolting writes onto the read-only provider. `SqliteDocument` is already a partial exception: it holds a live database handle (see below), but still only for read access.

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

## Architecture

Two independent esbuild bundles come out of `esbuild.js`, built together by `npm run compile`:

- `dist/extension.js` — CJS, Node platform, entry `src/extension.ts`. This is the extension host code (`main` in package.json). `papaparse` and `hyparquet` are fully bundled in here; `sql.js` is kept `external` instead (see below).
- `media/webview.js` — IIFE, browser platform, entry `src/webview/main.js`. This runs inside the VS Code webview sandbox.

**Parsing happens only in the extension host, never in the webview.** `src/csvParser.ts` wraps PapaParse and returns a `CsvParseOutcome` discriminated union (`{success: true, data, errors}` or `{success: false, errors}`). `src/csvEditorProvider.ts` reads the file, calls `parseCsv`, and posts the result to the webview as a `csv-data` message. `src/parquetParser.ts`/`src/parquetEditorProvider.ts` mirror this exactly for `.parquet`. The webview (`src/webview/main.js`) only renders pre-parsed data — it has no format-parsing logic and imports nothing from the parser modules at runtime (only referenced in JSDoc type imports).

`CsvEditorProvider` (registered as `tablas.csvViewer`, a `CustomReadonlyEditorProvider`) does a ready-handshake: it waits for a `{type: 'ready'}` message from the webview before it reads/parses the file and posts `{type: 'csv-data', payload: outcome}` back. Webview HTML is built per-request with a fresh CSP nonce (`crypto.randomBytes(16)`) and `script-src 'nonce-...'`; `default-src 'none'`.

All DOM writes in `src/webview/main.js` use `textContent`/`setAttribute` only — never `innerHTML` — this is a deliberate XSS-safety rule for any rendered cell/header content, since file content is untrusted. `eslint.config.js` has a `no-restricted-syntax` rule making this machine-checked (bans `innerHTML`/`outerHTML` assignment).

### SQLite (multi-table sources)

`.db`/`.sqlite`/`.sqlite3` files (registered as `tablas.sqliteViewer`) are the first *multi-table* source and deviate from the CSV/Parquet pattern in three ways:

- **Library**: `sql.js` (WASM SQLite), not a native binding — a single `.wasm` asset works on every platform VS Code runs on, avoiding a per-OS/arch `.vsix` matrix. It's `external` in `esbuild.js`'s extension bundle (can't be inlined — a `.wasm` binary isn't JS text) and `sqliteParser.ts` locates it via `require.resolve('sql.js/dist/sql-wasm.wasm')`.
- **Data shape**: `src/tableData.ts`'s `MultiTableParseOutcome`/`MultiTableData`/`TableRef` wrap a list of tables/views plus the currently-selected one's `ParsedTable`, additively alongside (not replacing) the single-table `TableParseOutcome` CSV/Parquet use.
- **Stateful document + bidirectional messaging**: unlike `CsvDocument`/`ParquetDocument`'s bare stubs, `SqliteDocument` (in `sqliteEditorProvider.ts`) holds the live `SqliteHandle` for the document's lifetime, so switching tables re-queries the already-open database instead of re-reading the file. `SqliteEditorProvider`'s `onDidReceiveMessage` listener stays registered after the ready-handshake (CSV/Parquet's disposes itself) to also handle `{type: 'select-table', table}` requests, responding with the same `sqlite-data` message type used for the initial load. The webview (`renderMultiTableOutcome`/`renderTableSelector` in `main.js`) renders a `<select>` above the table and posts `select-table` on change.

### Packaging gotcha: `.vscodeignore` isn't real gitignore semantics

`@vscode/vsce`'s `.vscodeignore` matching (see `collectFiles` in its `package.js`) is **not** gitignore's last-match-wins/directory-aware negation — it's flat: a file survives if it matches *any* negate (`!...`) line, full stop, regardless of ordering or which `ignore` line "would have" excluded it. A broad `!node_modules/sql.js/**`-style re-include line silently defeats every narrower exclusion meant to trim that package down (this bit us trying to keep only `sql.js`'s `dist/sql-wasm.{js,wasm}` out of its ~30x-larger full `dist/` folder — see the comment in `.vscodeignore`). When trimming a dependency's shipped files, list exact negate patterns for only what's needed; don't try to "subtract" from a broad re-include.

### Test setup

Two separate compiled outputs feed tests, both driven by `.vscode-test.mjs`:
- `unit` project: `out/test/unit/**/*.test.js`, no workspace/Electron needed conceptually but still run via `vscode-test`.
- `integration` project: `out/test/integration/**/*.test.js`, runs with `workspaceFolder: './test/fixtures'` and `extensionDevelopmentPath: '.'` — these tests open real fixture files through `vscode.commands.executeCommand('vscode.openWith', uri, 'tablas.csvViewer')` in an actual Extension Development Host.

`npm run test:unit` bypasses `vscode-test`/Electron entirely (ts-node + mocha directly against `.ts`), so use it for fast iteration on `csvParser.ts` logic. `npm test` is the only path that compiles to `out/` (via `tsc`, per `tsconfig.json`) and runs the integration suite — needed before verifying anything that touches `csvEditorProvider.ts` or the webview handshake.

Test style: `describe`/`it` (BDD), not `suite`/`test` — mocha is configured with `ui: 'bdd'` in both test projects.

Fixture paths in tests are built from `process.cwd()`, not `__dirname` — this is required for the same test file to work under both ts-node (`test:unit`) and the tsc-compiled output in `out/` (`test`).

Binary fixtures (`.parquet`, `.db`) are regenerated via `scripts/generate-parquet-fixtures.py` / `scripts/generate-sqlite-fixtures.py` rather than hand-authored — the latter needs only Python's stdlib `sqlite3` module, no `pip install`.

A file that `import`s `'vscode'` can never live under `test/unit/`: `npm run test:unit` runs that folder directly via ts-node with no Electron and no `vscode` module available, so it would crash the whole run. This is why there's no `sqliteEditorProvider.test.ts`/`csvEditorProvider.test.ts` under `test/unit/` despite `sqliteEditorProvider.ts` having host-side logic (`handleSelectTable`) worth covering in isolation from the webview — that coverage lives in `test/integration/sqliteEditorProvider.test.ts` instead, calling the provider's methods directly (bypassing `resolveCustomEditor`/the webview entirely, since there's no public API to simulate a message arriving *from* a webview).

## Packaging / publishing

`scripts/install-local.sh` builds production, runs `npm test` (unless `--skip-tests`), packages with `vsce package`, and installs the resulting `.vsix` via `code --install-extension`. Run `bash scripts/install-local.sh --publish-help` for the Marketplace publishing checklist (publisher id, PAT scope, `vsce login`/`vsce publish` steps).

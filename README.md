# Tablas — CSV Viewer for VS Code

Open data files in a pretty, theme-aware table view — right inside VS Code, no leaving the editor.

## Vision

VS Code has no first-class way to *look at* structured data files. JetBrains editors (DataGrip, IntelliJ's built-in CSV/table viewer) get this right: open a data file, see a real table, search it, tweak a cell, done. Tablas aims to bring that experience to VS Code.

**Where we are:** read-only CSV viewing (parse → render as `<table>`, theme-aware, XSS-safe).

**Where we're going**, roughly in order:
1. **Parquet support** — same table view, different source format. Parsing stays in the extension host; the webview keeps rendering pre-parsed rows/headers and shouldn't need to know the source format.
2. **Find/filter within a file** — locate matching cells/rows in the currently open table (JetBrains-style in-table search, not just VS Code's text-based Ctrl+F, which doesn't work well on a rendered table).
3. **Basic in-place editing** — edit a cell and persist it back to the source file. This is the point where the editor stops being `CustomReadonlyEditorProvider` and needs real document/edit-model semantics (undo/redo, dirty state, save).

## Current status

CSV only, read-only, installed locally (not yet on the Marketplace). Publishing there is the near-term goal — see `scripts/install-local.sh --publish-help` for the checklist. See `CLAUDE.md` for architecture and how the pieces fit together if you're changing code here.

## Development

```bash
npm run compile      # build both bundles (extension + webview)
npm run lint         # eslint (includes a project rule banning innerHTML assignment)
npm run check-types  # tsc --noEmit
npm run test:unit    # fast unit tests + c8 coverage report, no Electron
npm test             # full suite: compile + typecheck + vscode-test (unit + integration)
```

`npm run install:local` builds, tests, packages, and installs the extension into your local VS Code. See `scripts/install-local.sh --publish-help` for Marketplace publishing steps.

### Test gates

`npm install` installs [husky](https://typicode.github.io/husky/) git hooks (no GitHub remote is configured yet, so this is the enforcement point until CI is wired up):
- **pre-commit**: `lint` + `check-types` + `test:unit` — fast, no Electron.
- **pre-push**: full `npm test`, including the Electron-backed integration suite.

Coverage (`npm run test:unit`, via `c8`, config in `.c8rc.json`) only instruments the unit suite. `src/csvEditorProvider.ts` and `src/extension.ts` are explicitly excluded from it: both `import 'vscode'`, a module that only exists inside a real Extension Development Host, so they can only ever be exercised by the integration suite (which `c8` can't instrument — it runs in a separate Electron process). Everything else under `src/` uses `all: true`, so a new unit-testable file with no tests shows up as 0% rather than being silently absent from the report.

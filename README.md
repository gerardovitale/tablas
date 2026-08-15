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
npm run test:unit    # fast unit tests, no Electron
npm test             # full suite: compile + typecheck + vscode-test (unit + integration)
```

`npm run install:local` builds, tests, packages, and installs the extension into your local VS Code. See `scripts/install-local.sh --publish-help` for Marketplace publishing steps.

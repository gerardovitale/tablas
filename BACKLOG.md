# Backlog

Open follow-ups for Tablas that are not done yet. When an item ships, delete it here and add a line to `CHANGELOG.md` under `[Unreleased]`. IDs are stable, so don't renumber.

- **Priority:** P1 = blocks the first Marketplace release, or an advertised behavior is broken or can freeze the extension host; P2 = soon after release (scale, robustness, top features); P3 = cleanup and polish.
- **Size:** S = under an hour, M = a few hours, L = a day or more.

Current milestone: **first Marketplace publish** (re-prioritised 2026-11-20).

## Release order

1. **V-1** smoke test in a real VS Code window (also reproduces Q-14 and eyeballs Q-13).
2. **V-2** pin a stable DuckDB release.
3. **P-2** bundle the extension and trim the `.vsix`.
4. **P-3** per-platform `.vsix` builds.
5. **Q-14** undo/redo in the SQL box (if V-1 reproduces it).
6. **D-5** manifest stall and **F-6** uncached re-parse stall (both can freeze the extension host).
7. Publish (see `PUBLISHING.md`). Then **T-1** column sort and **T-2** in-table find.

## Packaging and marketplace

### P-2 · `vsce package` warns: "217 files, 186 are JavaScript, you should bundle your extension" · P1 · M

Warning text: `This extension consists of 217 files, out of which 186 are JavaScript files. For performance reasons, you should bundle your extension: https://aka.ms/vscode-bundle-extension. You should also exclude unnecessary files by adding them to your .vscodeignore: https://aka.ms/vscode-vscodeignore.`

Where the files come from (`vsce ls`, local darwin-arm64 build, 229 files on 2026-11-20):
- `@duckdb/node-api`: ~174 files. The `!node_modules/@duckdb/node-api/lib/**/*.js` line ships its whole `lib/` tree unbundled. This is nearly all of the warning.
- `papaparse`: ~23 files (`tests/`, `player/`, `.github/`, ...). `papaparse` is already bundled into `dist/extension.js`, so the `!node_modules/papaparse/**` line is dead weight.
- `media/webview.js.map` and `dist/extension.js.map` ship (`*.map` in `.vscodeignore` only matches at the root).
- `PUBLISHING.md` ships. (`CLAUDE.md` and `BACKLOG.md` are already excluded.)

Acceptance:
- Remove the `!node_modules/papaparse/**` line from `.vscodeignore`.
- Bundle `@duckdb/node-api`'s JS into `dist/extension.js`: drop it from `external` in `esbuild.js`, keep only `@duckdb/node-bindings` external (the native `.node` must stay a separate file), and drop the `@duckdb/node-api` negate lines. Check that `@duckdb/node-bindings`' `duckdb.js` still resolves its platform package at runtime.
- Exclude `**/*.map` and `PUBLISHING.md`.
- `vsce ls` shows well under 20 files and `vsce package` prints no warning.
- `npm test` passes and a DuckDB file opens in the installed extension (`npm run install:local:quick`).
- Update the `.vscodeignore` notes and the DuckDB section of `CLAUDE.md` ("both ... are `external`") to match.

### P-3 · Per-platform `.vsix` builds · P1 · L

`scripts/install-local.sh` runs a plain `vsce package`, which ships only the dev machine's `@duckdb/node-bindings-<platform-arch>`. A Marketplace `.vsix` must be built per target. Moved here from the Roadmap.

Acceptance:
- A script (or CI workflow) runs `vsce package --target <t>` for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64` and `win32-x64`, each with only its own `@duckdb/node-bindings-<t>` package installed/included.
- `vsce ls` per target shows exactly one platform binding; at least one non-host target is opened on a matching machine (or VM) and loads a DuckDB file.
- `vsce publish` flow in `PUBLISHING.md` and the Packaging note in `CLAUDE.md` updated. Touches the same `.vscodeignore` lines as P-2, so do P-2 first.

### V-2 · Engine version: CLAUDE.md text vs the installed package, and a pre-release pin · P1 · S

CLAUDE.md talks about a bundled `@duckdb/node-api` "1.5"/storage versions, while `package.json` pins `^2.0.0-r.1` (a pre-release tag; `node_modules` has `2.0.0-r.1`). Acceptance: pin a stable release before publishing (or record why not), check which engine and storage versions it reads, and fix the CLAUDE.md text.

## Checks before release

### V-1 · The 2026-11 UI work was never seen in a real VS Code window · P1 · S

Type icons, row virtualization, selection + copy, SQL highlighting and column filtering were verified with unit/integration tests and in real Chrome with scratch pages (permissive CSP, stub host), never in an installed extension. Run `npm run install:local:quick` and check, in Dark+, Light+ and a high-contrast theme:
- Type badges and their colours (also with a forced-dark extension off).
- A 200k-row DuckDB table: scrolling, row numbers, a filter, then Cmd+C of a big selection into a spreadsheet.
- Selection: click, shift/cmd ranges, row/column select, arrows, Escape order with the stats card and a filter box.
- SQL box under the **strict webview CSP** (no inline styles): overlay alignment, scroll sync, and a live theme switch (the `sql-theme` colours), plus One Dark / Dracula for the resolved palette. Note any gross mismatch with a `.sql` tab for Q-13.
- SQL box undo/redo (Cmd+Z / Cmd+Shift+Z), also after a refresh and after Run: reproduce Q-14.
- Filtering: a CSV with more than 5000 rows finds matches past row 5000 with an exact count; SQLite and DuckDB switch tables with a filter active; XLSX switches sheets with a filter active; Alt+click on an empty cell gives the "is empty" filter; Esc, the `×` in the gutter, and the statistics card opening below the filter row.

Anything found becomes its own item; fix P1-level breakage before publishing.

## Column filtering follow-ups

These come from the code review of the column-filtering work. The feature itself is shipped (see `CLAUDE.md`, "Column filtering"); everything below is a gap in it.

### F-4 · Parquet filtering decodes the whole file in one call · P2 · M

`parquetRowsForFilter` goes through `parseParquet`, which holds all row objects plus the full `string[][]` at once, up to the 20M-cell cap. It also parses the footer twice. `parquetStats` avoids this by decoding one row group at a time and yielding between groups.

Acceptance:
- Decode per row group, stringify each group as it is read, yield between groups, and parse the footer once.
- Measure peak memory on a generated multi-million-cell file before and after.

### F-5 · XLSX filtering allocates empty cells for sparse sheets · P2 · S

`xlsxRowsForFilter` reuses `readXlsxSheet`, which uses `getRow`/`getCell`. Those create an empty Row/Cell for every gap, and they stay on the retained `Workbook` for the document's lifetime. The stats code uses `findRow`/`findCell` for exactly this reason.

Acceptance:
- A filter-specific reader uses `findRow`/`findCell` and treats a missing cell as `''`, with the same text as `stringifyXlsxCell` for existing cells.
- A test on a sparse sheet shows the workbook's cell count is unchanged after filtering.

### F-6 · Uncached CSV and Parquet re-parse the whole file on every keystroke pause · P1 · M

Tables above `maxCachedCells` (5M) are re-read and re-parsed on each debounced request, synchronously for CSV. `maxCells` (20M) was sized for stats, not for parse plus filter, so one request can block the extension host for seconds.

Acceptance:
- Measure parse plus filter time at 5M, 10M and 20M cells.
- Pick caps (lower the uncached limit, raise the cache limit, or yield during the work) so the worst case is near the SQLite budget of about 1.3 s.
- Update `filterLimits` and its comment with the measurements.

### F-7 · DuckDB filtering runs four statements and scans twice · P3 · M

Per request: list tables, a `LIMIT 0` schema probe, a full `COUNT(*)`, then the row query. The same `WHERE` is evaluated in two separate scans, all inside the per-handle queue that also blocks stats and table switches.

Acceptance:
- Fold the count into the row query (for example `count(*) OVER ()`) and avoid the redundant table-list check.
- Results are identical, and the parity and differential tests stay green.
- Measure on a large table.

### F-8 · Share one `handleFilter` body between CSV and Parquet · P3 · M

The two providers have about 40 near-identical lines (plan, seq check, cache, read) and identical document fields. Extract `runCachedStringFilter(document, message, loadRows)` into `src/filter.ts`, which has no `vscode` import. As a bonus, the Parquet "clear overtook a decode" race could then be a plain unit test instead of the current integration test, which patches the `parquetRowsForFilter` export.

### F-9 · SQL and JS text differences in DuckDB filters · P3 · S · decide fix or keep documented

Documented in `CLAUDE.md`, not fixed:
- SQL `trim()` strips only spaces, so tab, newline or NBSP padding is not treated as blank.
- DOUBLEs with magnitude of at least 1e15, or under 1e-6, print in exponent form (`1e+15`, `1e-07`), so an exact `=` on them misses.

### F-10 · Row numbers in a filtered view restart at 1 · P3 · S

The gutter numbers the shown rows 1..N, not their original row numbers. Fixing it needs the host to send the original row indices in `filter-data`, so it is a protocol change across all five engines.

### F-11 · `=` cannot match values with trailing spaces · P3 · S

The filter box is trimmed, so `=abc ` becomes `=abc`. Alt+click now skips such cells so it never produces a filter that matches nothing. A real fix would be an exact-match escape, or not trimming the right side after `=`.

### F-13 · Month and datetime operands compare as plain strings · P3 · S

Only an exact `YYYY-MM-DD` operand gets the day-precision compare. Any other operand that is not a number (`>=2024-03`, `>=2024-01-15 10:30`) still compares the whole cell text by code unit. So a time operand sees the `T` of Parquet's `2024-01-15T10:30:00.000Z` and DuckDB's space as different separators, and the `.000Z` suffix sorts after a bare time.

Related gaps found in the F-1 code review, decide together with this one:
- `=` and `!=` on a DATE/TIMESTAMP column still match the displayed text exactly, so `=2024-01-01` finds 2 rows in CSV and DuckDB but 0 in Parquet (`2024-01-01T00:00:00.000Z`), and finds nothing on a TIMESTAMP column. This follows the "a filter matches what the table shows" rule, but no `FILTER_CASES` entry covers it, and `<=d AND >=d` disagrees with `=d`.
- The day rule reads the displayed wall-clock text, so `2024-01-01T23:30:00-05:00` compares as 2024-01-01, DuckDB TIMESTAMPTZ follows the session timezone, and Parquet uses UTC.
- A padded cell such as ` 2024-01-15` never takes part in a date compare, while number compares trim. The prefix test is untrimmed on purpose, since SQL `trim()` strips only spaces; left-trimming spaces in both engines would fix it.
- `filter.ts` now has its own ISO-day regexes next to the stricter `DATE_RE` in `columnStats.ts`. Consider sharing one grammar.

Acceptance:
- Truncate the cell to the operand's precision (month, day, minute, second), treating `T` and a space as the same separator, in `compileCellPredicate` and in `filterPredicateSql`.
- Add cases to `FILTER_CASES` (including `=`/`!=` on columns 6-7) and to the DuckDB differential test.

## Live refresh (DuckDB)

### R-1 · Refresh copies the main file only, not the `.wal` · P2 · M

`handleReload` reads `foo.duckdb` into a temp copy. While a long-lived writer holds uncheckpointed data in `foo.duckdb.wal`, the 30 s wait cap reloads without it, so the view can lag a running build. Acceptance: find out whether DuckDB opens a read-only copy that has a `.wal` next to it (and replays it); if so copy both. Test with a writer that keeps its connection open.

### R-2 · Every refresh re-reads the whole file, even when it did not change · P3 · S

A `.wal`-only event, the 30 s cap, or the manual button re-reads and re-copies the full database (multi-GB warehouses cost a multi-GB read, a synchronous temp write and two temp copies at once), and the re-render closes an open stats card or picker. Acceptance: skip the swap and the re-render when size and mtime of the main file match the last load; consider a size guard for auto-refresh.

### R-3 · A refresh that lands on a half-written file is not retried · P2 · S

A torn read fails once with "Refresh failed" and waits for the next file event. Acceptance: retry once or twice after a short delay before reporting the failure.

### R-4 · `loadInitial` overwrites `document.handle` without closing the old one · P3 · S · pre-existing

If VS Code re-resolves the same document with a new panel (not verified that it does, e.g. when a tab moves to another window), the earlier handle and its temp copy leak. Acceptance: close any existing handle before assigning in `loadInitial`.

## SQL box (DuckDB)

### Q-9 · A reload while the SQL box shows still reads and posts the hidden table · P3 · M

The host does `COUNT(*)`, a `maxRows` read and the dbt descriptions for the selected table on every reload even when the webview is in SQL mode and draws none of it. Skipping it needs the webview to tell the host its mode and to ask for the table (a `select-table`) when the user switches back, with filters/scroll restored after that reply. Measure first: it is small next to re-copying the file (R-2).

### Q-1 · A running query cannot be cancelled by the user · P2 · S

A slow query blocks the connection's queue (stats, filters and table switches wait behind it) until it ends or hits the 30 s limit. A Cancel button would send `{type:'cancel-query'}` and call `interrupt()`, but `interrupt()` is connection-wide: it must only fire while *that query* is the one running, so track which request holds the connection.

### Q-2 · No way to export or reuse a query result · P3 · M

`COPY .. TO` is refused on purpose (see CLAUDE.md, "SQL box"). A result export (CSV) would be its own button: host-side write to a path the user picks in a save dialog, never from SQL text.

### Q-3 · Nothing is offered while typing a query · P3 · L

Highlighting shipped (see CLAUDE.md, "SQL highlighting and theme colours"). Still missing: completion of table names (schema-qualified, quoted when needed), column names (after `alias.` / `table.` and in the statement's tables), keywords and functions, as a popup that follows the caret. Needs a host `get-catalog` request (columns of every table, `duckdb_functions()`), memoized per handle and dropped on a reload swap.

Plan (next session can start here):
- **Protocol:** `{type:'get-catalog'}` → `{type:'catalog-data', payload:{tables:[{name,schema,table,columns:[{name,type}]}], keywords, functions}}` in `src/queryMessage.ts` (guards + unit tests). Request once when SQL mode opens.
- **Host:** build in `duckdbParser.ts` under `runExclusive`: `information_schema.columns` for the file's own catalog with the same filter as `listDuckdbTables`, plus `duckdb_keywords()` and `SELECT DISTINCT function_name FROM duckdb_functions()`. Memoize per handle like `tableRefs`; a reload swap gets a new handle, so it drops by itself.
- **Context (webview, inside `main.js`):** after `FROM`/`JOIN`/`INTO` → tables; after `schema.` → that schema's tables; after `alias.`/`table.` → columns (resolve aliases from `FROM x [AS] a` with a light scan); otherwise columns of the statement's tables + keywords + functions (a function inserts `name(`). Prefix match then fuzzy, case-insensitive, keywords inserted upper-case.
- **Popup:** reuse the table picker's listbox pattern (`renderTableSelector`, `appendHighlighted`): `role=listbox`, `aria-activedescendant` on the textarea, positioned at the caret by measuring a mirror span in `.query-highlight`. Ctrl+Space opens, typing filters, ↑/↓/Tab/Enter accept, Esc closes; Enter without a popup stays a newline, Cmd+Enter still runs.
- **Tests:** completion context (FROM/JOIN/`alias.`/`schema.`), popup keyboard, catalog guards, catalog SQL against `schemas.duckdb`. Delete this item when it ships.

### Q-4 · A query with unsent edits and a stuck "Running…" · P2 · S

If the host never answers (for example `document.handle` is missing), the status stays "Running…". Add a timeout in the webview or an explicit "not available" reply.

### Q-5 · Table ids can collide when a `main` table name contains a dot · P3 · S

`TableRef.name` for a table outside `main` is `schema.table`, so a `main` table `"a.b"` and table `b` in schema `a` get the same id, and the picker, reads, stats and filters resolve both to the last one listed (silent wrong data). Same for a schema name with a dot. Acceptance: an unambiguous id for non-`main` refs (or qualify the `main` one on a duplicate), with a fixture holding both.

### Q-6 · The SQL box binds every statement twice, and `EXPORT DATABASE` leaves a folder · P3 · M

Each statement is `prepare`d to learn its type (binding, which for `read_csv`/remote sources can mean sniffing or fetching), then `streamAndReadUntil(sql)` parses and binds the whole text again. A refused `EXPORT DATABASE '<dir>'` still creates `<dir>` while binding. Acceptance: classify without binding, or run the prepared statements instead of re-parsing, and refuse by leading keyword before preparing.

### Q-7 · Per-file query and last-table entries are never pruned · P3 · S

`tablas.lastQuery:<uri>` (up to 100k characters) and `tablas.lastTable:<uri>` stay in `workspaceState` for every file ever opened. Q-12 removes the `lastQuery` persistence, so this shrinks to `lastTable` (plus clearing any old `lastQuery:*` keys once). Acceptance: cap the number of remembered files (drop the least recently used) or drop entries for files that no longer exist.

### Q-8 · The auto re-run after a refresh ignores how slow the query is · P3 · S

A refresh re-runs the last query even if the previous run took most of the 30 s budget, and each run holds the connection queue (table switches, filters and stats wait behind it). Now at most one re-run waits behind a running query. Acceptance: skip the automatic re-run when the last run took longer than a few seconds and show a "Run again" hint instead.

### Q-12 · The SQL box should open on `select * from <table> limit 5` · P2 · S

Today the box opens on the remembered query (`MultiTableData.lastQuery`, kept per file in `workspaceState`), and only when there is none on `suggestQuery()` in `src/duckdbParser.ts`, which is `SELECT * FROM <table> LIMIT 100`. Wanted: the first time the box opens it always holds `select * from <the table the file was opened on> limit 5` (qualified/quoted as `quotedTableName` does).

Decided (2026-11-20): **every panel open** starts from the suggestion; a remembered query only survives refreshes of the open panel (the webview already keeps its text in module state across re-renders).

Acceptance:
- Change `suggestQuery` to `select * from <table> limit 5` (lower-case keywords as written above; the highlighter does not care) and update its unit test and the README/CLAUDE.md "SQL box" text and the CHANGELOG line that says `LIMIT 100`.
- Stop restoring `tablas.lastQuery:<uri>` on open: drop `rememberedQuery`/`MultiTableData.lastQuery` and the `workspaceState` writes (`main.js` `queryText = lastQuery || querySuggestion`, ~line 2388), unless a test shows the refresh path needs them.
- If the shown table changes before the user typed anything, the suggestion follows it; once the user edited the text it does not.

### Q-13 · The SQL colors do not match VS Code's `.sql` editor · P3 · M

Cosmetic; promote to P2 if V-1 shows a gross mismatch.


The palette resolved from the theme (`src/sqlTheme.ts`, `SQL_TOKEN_SCOPES`, the fallbacks in `media/styles.css`) looks off next to a real `.sql` file. Probable causes to check, in this order:
- The tokenizer's classes are coarser than the SQL grammar's: VS Code (the `sql` grammar) colors DML/DDL keywords (`keyword.other.DML.sql`, `keyword.other.DDL.create.II.sql`, `storage.type.sql`), data types, `constant.language`, operators, numbers and `variable`/`entity.name.function` differently, and plain identifiers/columns keep the editor foreground. Compare token by token with the same query in a `.sql` file (Developer: Inspect Editor Tokens and Scopes) and list which scope each of our classes should really use.
- Scope matching is a simplification of TextMate's (no parent selectors beyond `source.sql`, no `-`/`|`); a theme rule like `source.sql keyword.other` or an exclusion may pick a different color in VS Code.
- Semantic highlighting and `editor.semanticTokenColorCustomizations` are not read; the built-in SQL has no semantic provider, so this is probably not it.
- The dark/light fallbacks (used when no theme file resolves, e.g. built-in themes in the app bundle) may not equal Dark+/Light+; verify `findThemeFile` finds built-in themes (`vscode.extensions.all` includes the `theme-defaults` extensions), and that the high-contrast variants fall back correctly.

Acceptance: for Dark+, Light+, One Dark Pro and a high-contrast theme, a sample query (keywords, functions, types, strings, numbers, comments, quoted identifiers, operators) shows the same colors as a `.sql` editor tab, checked side by side in a real VS Code window (V-1). Add the finer token classes if needed (extend `SQL_TOKEN_CLASSES`, the tokenizer, the CSS variables and the tests together).

### Q-14 · Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z must work in the SQL box · P1 · S

The box is a native `<textarea>`, so undo/redo is expected to work, but it does not in the installed extension (not yet reproduced; check in a real window first). Suspects:
- VS Code intercepts the key in the webview and runs its own undo (the editor's, not the textarea's); the keydown handler (`main.js` ~2490) may need to let the key through, or call `document.execCommand('undo'|'redo')` itself on Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (Ctrl+Y on Windows/Linux).
- The textarea's value is replaced from script (a refresh rebuilding the box in `renderQueryPanel`, the suggestion, any `input.value = ...`), which clears the browser's undo stack; keep the same element across re-renders or keep our own history.
- Any future completion insertion (Q-3) must go through `execCommand('insertText')` (or `setRangeText` plus an input event) so accepted suggestions stay undoable.

Acceptance: type, Cmd+Z undoes by word/chunk and Cmd+Shift+Z redoes, also after a refresh of the file and after Run; test what can be tested in jsdom (the handler), and verify the rest in the installed extension (V-1).

### Q-10 · The comment-stripping regex is quadratic on an unterminated `/*` · P3 · S

The statement splitter/classifier in the SQL path strips comments with a regex that backtracks on a `/*` that never closes: a 100k-character paste blocks the extension host for about 0.8 s per Run. Acceptance: replace it with a single forward scan (like `tokenizeSql` in the webview), with a test on a 100k `/*` input that finishes in milliseconds.

### Q-11 · An empty or half-written DuckDB file has no refresh button · P2 · S

If the first load finds no tables (empty file, or a build still writing), the panel shows "No tables found" without the toolbar, so the user must close and reopen the tab. The file watcher usually recovers it, but not with `tablas.autoRefresh` off. Acceptance: render the toolbar (`capabilities.refresh`) on the empty and failed first-load states too.

### W-1 · The table picker hard-codes DuckDB's `main` schema in the webview · P3 · S

The webview treats a ref without `schema` as `main` when grouping (CLAUDE.md, "Table/view listing and schemas"), which is format knowledge in the renderer. Acceptance: the host sends the group label (or a `defaultSchema`) and the webview only groups by what it is given.

## dbt support

### D-1 · No dbt model description, tests or run results in the viewer · P3 · M

Only column descriptions are shown. The manifest also has the model `description`, `tests` and `depends_on`, and `target/run_results.json` has per-model status and timing of the last build. Candidates: the model description beside the table picker, a "last built 14:32, 3 s" note, a failing-test marker. Read `run_results.json` the same cached way as the manifest.

### D-2 · Preview Model only knows `.sql` models · P3 · S

Python models (`.py`) and seeds (`.csv`) have manifest nodes too. Extend the menu `when` clauses and the extension check, and map a seed's file to its node.

### D-3 · The DuckDB file is found by name, not from `profiles.yml` · P3 · M

dbt-duckdb's `path:` lives in `profiles.yml` (often outside the project) and can be relative to where dbt ran. Today the manifest's `database` (the catalog name, equal to the file name for the default setup) and a quick pick decide. Acceptance: read `profiles.yml` (`~/.dbt` or `DBT_PROFILES_DIR`) for the active profile and target to find the file directly; keep the current search as the fallback.

### D-4 · Preview from the table back to the model · P3 · S

The reverse direction: from a table in the picker, open the model's `.sql` file (`original_file_path` from the manifest).

### D-5 · Reading a big manifest can stall the extension host · P1 · M

`loadDbtManifest` reads the whole file and `JSON.parse`s it synchronously (cap 300 MB, far too high for a shared extension host), on every first load, table switch and reload after the manifest's mtime changes, and the table's first render waits for it. Concurrent callers each parse the same file (no in-flight sharing). Acceptance: lower the cap (around 50 MB), share one in-flight promise per file, and consider posting the rows before the descriptions arrive.

### D-6 · Descriptions can be missing at startup · P3 · S

`getDbtProjectRoots()` is empty until the first `findFiles` scan finishes, and `columnDescriptionsFor` uses it as the "workspace's only project" fallback, so a restored `.duckdb` tab outside the project can load without descriptions. Acceptance: `withColumnDescriptions` awaits the first scan (an exported promise from `registerDbtSupport`).

### D-7 · `pendingReveals` lifecycle and the 15 s limit · P3 · S

A second reveal for the same file overwrites the first (which then waits out its timer); a panel disposed before its handshake leaves its entry until the timer, so a manual reopen within that window opens on the previewed table; and 15 s is short for a multi-GB file that is read into memory and copied. Acceptance: settle a replaced entry at once, settle and delete the entry in the panel's `onDidDispose`, and tie the wait to the load rather than a fixed time.

### D-8 · Files with dots in the name never get dbt descriptions · P3 · S

The catalog name DuckDB derives from `warehouse.v2.duckdb` is not the manifest's `database` (the file name without the last extension, as dbt-duckdb reports it), so `relationForFile` finds no node. Acceptance: compare against both the DuckDB catalog name and the stem, with a fixture or a unit test on a dotted name.

### D-9 · The dbt integration tests depend on state left by earlier tests · P3 · S

They share the fixture project, the provider's `pendingReveals`/`selectors` and the dbt caches, so reordering or running one alone can fail. Acceptance: each test sets up and clears its own state (`clearDbtProjectCache()`, fresh provider), and each passes when run alone (`--grep`).

## Table features

### T-1 · Column sort · P2 · L

Click a header to sort asc, desc, then off. The biggest gap against DataGrip and other viewers. Host-side over the whole table, like filters (one meaning across all five engines).

Acceptance:
- Protocol: the `filter` request gains an optional `sort: {column, dir}` (or a sibling `sort` message) so sort and filters compose; the reply keeps `seq`/`table` echo rules and the first `tablas.maxRows` rows of the sorted, filtered set. Clearing the sort restores the original order locally.
- Engines: CSV/Parquet/XLSX sort the cached string rows with a comparator that treats numeric text as numbers (same grammar as `NUMBER_PATTERN` in `filter.ts`) and ISO dates as text order; SQLite/DuckDB use `ORDER BY` on typed values. NULL/empty sorts last in both directions. Ties keep original order (stable).
- A parity test like `filterParity.test.ts` runs shared cases against all five fixtures and asserts identical row order.
- Limits and skip reasons like filters (`filterLimits`), and the webview shows the sort state on the header (`aria-sort`), works with virtualization and selection reset (`showRows`), and statistics stay untouched.

### T-2 · In-table find · P2 · L

Cmd/Ctrl+F inside the table (not VS Code's text find): a find bar that highlights matching cells across the whole table and jumps between them.

Acceptance:
- First check in the installed extension (V-1) how a webview receives Cmd/Ctrl+F, so the find bar opens without fighting VS Code's own binding.
- Host-side search over the whole table, reusing the filter engines' "contains" semantics (`compileCellPredicate`, `filterPredicateSql`); the reply is the match count and the first N positions (row index in the shown rows + column), capped.
- Next/previous (Enter / Shift+Enter) moves the selection cursor and scrolls with `revealCell`; highlighting is painted only on drawn cells (virtualization), like `paintSelection`.
- Works together with active filters and sort (positions are indices into the rows being shown). Esc closes the bar.

## Selection

### S-1 · No auto-scroll while dragging a selection past the edge · P3 · S

A drag only extends over cells that are drawn and under the pointer, so sweeping beyond the visible rows needs Shift+click or the keyboard. Acceptance: while the button is down and the pointer is within a few pixels of (or past) the wrapper's top/bottom/left/right edge, scroll that way on a timer and keep extending.

### S-2 · No context menu, and no "copy as ..." beyond TSV · P3 · M

A right-click menu on the selection (Copy, Copy with headers, Copy as CSV/JSON/Markdown) and "filter by this value" next to Alt+click. Needs a menu widget that follows the theme and the strict CSP.

### S-3 · A selection is lost when a refresh re-applies a filter · P3 · S

`restoreReloadState` restores the cell selection only when no filter is active, because the rows are swapped again when the filter answers (`showRows` resets the selection). Acceptance: carry it through that swap when the table, headers and the filter text are unchanged.

## Activity bar and side view

### A-1 · Design a first version of an activity bar icon and a Primary Side Bar view · P3 · M · design first, then build

Tablas has no presence in the Activity Bar today; it only appears when a data file is opened. Wanted: an icon in the Activity Bar that opens a Tablas view in the Primary Side Bar (the one VS Code toggles with Cmd/Ctrl+B).

Design questions to settle before building (write the answers into this item or a short design note):
- **What the view shows.** Candidates: the data files found in the workspace (`.csv`, `.parquet`, `.xlsx`, `.db`/`.sqlite`, `.duckdb`) grouped by folder or format, with a filter box; for a file that is open, its tables/sheets and columns with type icons (reusing the badges), so one can jump to a table or copy a column name; recent files; for dbt projects, the models with their built tables (ties into D-1/D-4). Pick a small first slice, not all of them.
- **Tree view or webview view.** A native `TreeView` (`contributes.views`, `TreeDataProvider`) is cheap, themed and accessible, and fits a file/table list. A `WebviewView` allows the same rendering as the editor but costs CSP, theming and state work. Likely: tree view first.
- **Scanning cost.** Use `workspace.findFiles` with exclusions (`node_modules`, `.git`, `target`), a file watcher for changes, and never open or parse a file just to list it; a table list for an open DuckDB/SQLite file comes from the live handle the editor already holds.
- **Actions.** Click opens the file with the right viewer (`vscode.openWith`), a table node opens/selects it (the reveal flow in `DuckdbEditorProvider.revealTable`), context menu: Reveal in Explorer, Copy path, Refresh.
- **Icon.** A monochrome 24x24 SVG that follows the theme (single `currentColor` path, like codicons), plus the colored `icon.png` the Marketplace still needs (see Packaging); a table/grid glyph that is distinct from the built-in Explorer and Search icons. Check it at 16/24 px in dark, light and high-contrast.
- **Empty and large workspaces.** Message with a "Open a data file" action when nothing is found; a cap and a "N more" node for huge trees; no activation cost (activate on view open, not at startup).

Acceptance for this task (design, not the full feature):
- A short written design (content of the view, tree vs webview, data sources, actions, empty states) with a mockup or ASCII sketch.
- A draft icon SVG checked in the three theme kinds.
- A follow-up build task, sized, with `package.json` contribution points named (`viewsContainers.activitybar`, `views`, `commands`, `menus`, `activationEvents`).

## Ideas for later (not started, ranked)

Column sort and in-table find were promoted to T-1 and T-2.

1. **Column resize and freeze**: drag the header edge, persist widths per file, freeze the first column.
2. **Value viewer**: a side panel for long or JSON cells (cells clip at 400px today).
3. **Test gap**: `runReload` coalescing, `selectTable`, the watcher path filter and `refreshActive` are closures inside `resolveCustomEditor` (excluded from coverage, untested). Extract them into a small testable class (for example `DuckdbPanelController`).

## Roadmap items (not started)

Tracked in `README.md`, listed here so nothing lives in two places:
- Column sort: see T-1. In-table find (JetBrains-style, not VS Code's text Ctrl+F): see T-2. Per-column filtering is already done.
- Basic cell editing. This needs a real edit model (dirty state, undo/redo, save) instead of `CustomReadonlyEditorProvider`.
- Marketplace publishing: see the release order at the top, P-3 for per-platform `.vsix` builds, `PUBLISHING.md` and the packaging notes in `CLAUDE.md`.

# Backlog

Open follow-ups for Tablas that are not done yet. When an item ships, delete it here and add a line to `CHANGELOG.md` under `[Unreleased]`. IDs are stable, so don't renumber.

- **Priority:** P1 = blocks the first Marketplace release, or an advertised behavior is broken or can freeze the extension host; P2 = soon after release (scale, robustness, top features); P3 = cleanup and polish.
- **Size:** S = under an hour, M = a few hours, L = a day or more.

Current milestone: **0.1.0 is published** (2026-11-21, all 8 platform targets). Next: confirm it works as installed from the Marketplace (P-3), then **T-1** column sort and **T-2** in-table find.

## Release order

1. **P-3** install the published extension on a non-macOS platform and open a file.
2. **T-1** column sort, then **T-2** in-table find.

The real-window smoke test (V-1) passed on 2026-11-20 in the installed extension: type icons, virtualization, selection and copy, filtering, the SQL box under the strict CSP and undo/redo all behaved. It found one bug (SQL colours taken from the wrong theme with an auto-detected colour scheme, fixed in `9011d97`) and nothing else.

## Packaging and marketplace

### P-3 · Install the published extension on a non-macOS platform and open a file · P1 · S

0.1.0 went out for all 8 targets on 2026-11-21 (alpine-arm64 from an interrupted first run, the other seven from run 44905404375). CI built and smoke-tested every target (layout, plus opening a DuckDB and a SQLite file from the packaged layout, which covers the bundled `detect-libc` and the musl binding on Alpine), but nothing has started VS Code with a non-macOS build.

Acceptance:
- On Windows and/or Linux (a machine, VM, dev container or Codespace), install **Tablas** from the Marketplace (or `code --install-extension gerardovitale.tablas`) and open a `.duckdb` file and a `.csv`. Note the VS Code version used, and confirm it is 1.90 or newer.
- If a platform fails, fix it and publish 0.1.1 for all targets (a published target cannot be replaced).

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

### Q-9 · A reload while the SQL box shows still reads and posts the hidden table · P3 · M · superseded by Q-15

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

### Q-7 · Per-file last-table entries are never pruned · P3 · S

`tablas.lastTable:<uri>` stays in `workspaceState` for every file ever opened. (The SQL box no longer stores query text, so there are no `tablas.lastQuery:*` keys to prune; no build that wrote them was ever published.) Acceptance: cap the number of remembered files (drop the least recently used) or drop entries for files that no longer exist.

### Q-8 · The auto re-run after a refresh ignores how slow the query is · P3 · S

A refresh re-runs the last query even if the previous run took most of the 30 s budget, and each run holds the connection queue (table switches, filters and stats wait behind it). Now at most one re-run waits behind a running query. Acceptance: skip the automatic re-run when the last run took longer than a few seconds and show a "Run again" hint instead.

### Q-13 · The SQL colours are coarser than VS Code's `.sql` editor · P3 · M

Cosmetic. The big mismatch seen in the V-1 smoke test (a dark window painted with the light theme's palette) was the theme lookup ignoring `window.autoDetectColorScheme`, fixed in `9011d97`; with the right theme the keywords, strings, numbers and comments match a `.sql` tab. What is left is that the tokenizer's classes are coarser than the SQL grammar's (`src/sqlTheme.ts` `SQL_TOKEN_SCOPES`, the fallbacks in `media/styles.css`):
- Plain identifiers (`b.id`, `main.big`) keep the default colour; the `.sql` editor colours them (`variable`/`meta.*` rules of the theme).
- Operators: our `keyword.operator.sql` scope does not exist in the grammar (it has `keyword.operator.star.sql`, `.math.sql`, `.comparison.sql`, `.concatenator.sql`), so `*` and `::` take the fallback.
- Types (`DECIMAL(12,2)`, `TIMESTAMP`) and DML/DDL keywords (`keyword.other.DML.sql`, `keyword.other.DDL.create.II.sql`, `storage.type.sql`) can differ from the editor in themes that colour them separately.
- Scope matching is a simplification of TextMate's (no parent selectors beyond `source.sql`, no `-`/`|`); semantic highlighting is not read (the built-in SQL has no semantic provider).

Acceptance: for Dark+, Light+, One Dark Pro and a high-contrast theme, a sample query (keywords, functions, types, strings, numbers, comments, quoted identifiers, operators, plain identifiers) shows the same colors as a `.sql` editor tab, side by side (Developer: Inspect Editor Tokens and Scopes lists each token's scope). Add the finer token classes if needed (extend `SQL_TOKEN_CLASSES`, the tokenizer, the CSS variables and the tests together).

### Q-10 · The comment-stripping regex is quadratic on an unterminated `/*` · P3 · S

The statement splitter/classifier in the SQL path strips comments with a regex that backtracks on a `/*` that never closes: a 100k-character paste blocks the extension host for about 0.8 s per Run. Acceptance: replace it with a single forward scan (like `tokenizeSql` in the webview), with a test on a 100k `/*` input that finishes in milliseconds.

### Q-11 · An empty or half-written DuckDB file has no refresh button · P2 · S

If the first load finds no tables (empty file, or a build still writing), the panel shows "No tables found" without the toolbar, so the user must close and reopen the tab. The file watcher usually recovers it, but not with `tablas.autoRefresh` off. Acceptance: render the toolbar (`capabilities.refresh`) on the empty and failed first-load states too.

### SQL box redesign (Q-15, Q-16)

Why: the box exists only for DuckDB files and lives in a separate Table|SQL mode that hides the table and the picker. (A result is already a real table with types, strips and filters: see CHANGELOG.) What is left is the layout (Q-15) and SQL for Parquet/CSV (Q-16). Ordered; each is an independently shippable commit.

Decisions already made:
- A result is materialized into a DuckDB `TEMP` table (verified 2026-11-22: `CREATE TEMP TABLE` and `read_parquet` both work on a `READ_ONLY` database, so the source file is untouched), capped at the **first N rows** (propose N, e.g. 100,000, within `queryLimits.duckdbTimeoutMs`). Stats/filters (and later sort) then cover those N rows and the UI says so ("Statistics and filters cover the first N rows of this result"), in the style of the existing "Statistics cover all N rows" and "N+ rows" notes. A small result (a `GROUP BY` with 30 rows) behaves exactly like a table. Rejected alternative: wrap the user's SQL in each stats/filter request (always complete, but re-runs the query per keystroke and can change between runs).
- The SQL view of a Parquet/CSV file is named after the **file's stem**: `sales_2024.parquet` -> `select * from sales_2024`. A stem that is not a plain identifier (`sales-2024.final`, spaces, leading digit, reserved word) is quoted, and the box's starting suggestion is already quoted correctly. (Rejected: a fixed name `data`.)

### Q-15 · One layout: the query box above the table, no Table|SQL toggle · P2 · L

Acceptance:
- A collapsible query panel above the table (DataGrip console style); the picker stays visible. Run replaces the grid with the result and shows a chip such as `Result of query ✕`; the ✕ returns to the table with its filters and scroll restored (reuse `savedTableState`/`captureReloadState`). The toggle and the hidden-picker SQL mode go away.
- Everything that works today keeps working: highlighting and theme colours, Ctrl/Cmd+Enter, re-run after a live refresh (`queryRerun`/`queryStale`), caret/scroll preservation (`captureQueryUiState`), keyboard and screen-reader access, the CSP rules (no `innerHTML`, CSSOM only).
- Supersedes Q-9 (a reload no longer reads a hidden table the user is not looking at) and simplifies Q-8; delete those two when this ships, and fold the module state (`queryMode`, `queryResult`, `savedTableState`, `queryResultHost`) into the new layout.
- Verify in a real window in light, dark and high-contrast, with a large result.

### Q-16 · SQL for Parquet and CSV through an in-memory DuckDB · P2 · L · needs Q-15

Acceptance:
- `capabilities.query` for `.parquet` and `.csv`: the host opens an in-memory DuckDB and exposes the file as a view named after its stem (`read_parquet`/`read_csv`), with the same read-only guard, limits, result table, stats and filters as a DuckDB file. For non-`file:` URIs copy the bytes to a private temp file as `openDuckdbDatabase` does and clean it on dispose. Cover name quoting/sanitising, an empty or colliding stem, and a file replaced on disk.
- The normal table view keeps its hyparquet/PapaParse paths; DuckDB is only the SQL engine. Decide and document how to keep `select *` close to the table view where DuckDB's CSV sniffer disagrees with PapaParse (types, quoting, headers): explicit read options or `all_varchar`, plus a note under the box.
- Out of scope: XLSX (DuckDB's Excel reader needs a network `INSTALL`, which the box refuses on purpose) and SQLite via `sql.js` (separate follow-up).
- Tests against the `filter.parquet`/`filter.csv`/`multiline.csv`/`nested.parquet` fixtures; update README, CLAUDE.md and CHANGELOG.

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
- V-1 found that Cmd/Ctrl+F does nothing in the installed viewer (no VS Code find widget opens over the table or the SQL box), so the key is free to use. Not yet confirmed: whether the webview's own `keydown` receives it (log it from the Webview Developer Tools before relying on it), and the same for Cmd+G / F3 for next/previous.
- Host-side search over the whole table, reusing the filter engines' "contains" semantics (`compileCellPredicate`, `filterPredicateSql`); the reply is the match count and the first N positions (row index in the shown rows + column), capped.
- Next/previous (Enter / Shift+Enter) moves the selection cursor and scrolls with `revealCell`; highlighting is painted only on drawn cells (virtualization), like `paintSelection`.
- Works together with active filters and sort (positions are indices into the rows being shown). Esc closes the bar.

## Postgres (first remote source)

Open and browse tables of a PostgreSQL server, read-only. The first source that is a *connection*, not a file, so the work is mostly the connection layer; the table view reuses the multi-table protocol (`MultiTableParseOutcome`, `select-table`, `capabilities.refresh`). Items are ordered; PG-1 gates the rest.

Design decisions already made (from the planning discussion):
- **Driver:** `pg` (node-postgres), pure JS, bundled by esbuild (mark or ignore its optional `pg-native`), so the `.vsix` matrix does not change. Not DuckDB's postgres extension: `INSTALL`/`LOAD` reach outside the file and are refused in the SQL box on purpose.
- **Credentials:** profiles (no password) in `globalState`, passwords only in `context.secrets`. Connections come from user settings/secrets only, never from a workspace file, and every connect is user-initiated (the manifest declares `untrustedWorkspaces: limited`, and a workspace must not be able to point the extension at a host). Mind `test/unit/packageManifest.test.ts`.
- **Read-only and bounded:** `SET default_transaction_read_only = on` (or `BEGIN READ ONLY`) plus `statement_timeout` per session, so the server enforces it; every read has a `LIMIT` at `tablas.maxRows`; recommend a read-only role in the README.
- **Text for everything:** force all values to text (custom `types` parser or `::text`) so BIGINT/NUMERIC/dates are exact and display like the other engines; column kinds for stats come from the result's type OIDs (`dataTypeID`).
- **Document identity:** a virtual URI such as `tablas-postgres:/<connId>` opened with `vscode.openWith`; a restored tab whose secret is gone prompts instead of failing. Like `DuckdbDocument`, the document holds the live client for its lifetime, closes it on dispose and reconnects on a dropped connection.

### PG-1 · Spike: `pg` client in the extension bundle · P2 · S

Prove the shape before building on it. Acceptance:
- `pg` connects to a local Postgres (docker) from the extension host, reads one table and bundles with esbuild (`pg-native` handled); report the bundle size, that `smoke-package.js`'s file-count and `node_modules` limits still hold, and that nothing needs `.vscodeignore` entries.
- Settle the test infrastructure: a `services: postgres` container in `package.yml`'s `check` job, plus tests that skip when `TABLAS_TEST_PG_URL` is unset so `npm run test:unit` still works offline. Fixtures cannot be binary files here: a script that seeds the schema (including a `filter.*`-parity table).

### PG-2 · MVP: connect, pick a table, view rows · P2 · L

Needs PG-1. Acceptance:
- Command "Tablas: Connect to Postgres" (host/port/database/user/SSL mode, password to SecretStorage), a saved-connections quick pick, and a virtual-URI custom editor (`postgresParser.ts` + `postgresEditorProvider.ts`, parallel to `duckdbParser.ts`/`duckdbEditorProvider.ts`) producing `MultiTableParseOutcome`.
- The table picker lists schemas, tables, views and materialized views from `pg_catalog`, with `TableRef.approxRows` from `pg_class.reltuples` (no scan) and the same `schema.table` naming as DuckDB (see Q-5 for the collision caveat).
- Read-only session, `statement_timeout` and a `maxRows` cap on every read; manual refresh only (`↻`, `tablas.refresh`); the last table per connection is remembered like DuckDB's.
- Stats and filters: either implemented (PG-4) or the webview gains capability gating, so the MVP never shows boxes that do nothing. Decide this before building (see "Open questions").
- Workspace Trust: connect refused or restricted in an untrusted workspace; `packageManifest.test.ts` updated.
- Integration test against the CI Postgres; README note that the extension now makes outbound network connections (Marketplace privacy).

### PG-3 · Browse connections in a tree view · P3 · M · after A-1

Connections → schemas → tables in the Activity Bar tree designed in A-1; clicking a table opens or selects it (the `DuckdbEditorProvider.revealTable` flow). Acceptance: the tree never connects until the user expands a connection, and a table list comes from the live client the editor already holds when one is open.

### PG-4 · Filter and statistics parity for Postgres · P2 · L

Needs PG-2. Acceptance:
- `filterPredicateSql` for Postgres, a third hand-written mirror of `compileCellPredicate` (change one, change the other, as for DuckDB), added to `FILTER_CASES` and `filterParity.test.ts` (runs only when `TABLAS_TEST_PG_URL` is set), with its known text-form differences documented in `CLAUDE.md`.
- Statistics pushed down as aggregate SQL with a timeout, like `duckdbTableStats`. The "stats cover the whole table" rule cannot hold for a remote table with hundreds of millions of rows: skip (or `TABLESAMPLE`) above a `reltuples` threshold with a `skippedReason`, and say so in the card.
- Filters follow `filterLimits` semantics (timeout, `maxTextLength`) and the `seq`/`table` echo rules.

### PG-5 · SQL box for Postgres · P3 · M

Needs PG-2 and PG-4. Reuse the DuckDB box (protocol in `queryMessage.ts`, highlighting, Table/SQL toggle). The guard differs: Postgres has no "prepare to learn the statement type", so run inside `BEGIN READ ONLY` with a timeout and rely on the server, and document that side-effecting functions (`nextval`, `pg_terminate_backend`, `dblink`) remain possible, so a read-only role is the real boundary. Acceptance: the refused-statement behaviour and the 30 s budget match the DuckDB box, with tests against the CI Postgres.

### PG-6 · Out of scope for the first version · P3 · L · not started

SSH tunnels, RDS/IAM token auth, client certificates beyond the basic SSL modes, pgbouncer quirks, and other servers (MySQL, SQL Server). Keep the connection layer generic enough that a second server is a new parser module, not a rewrite. dbt-postgres manifests (`database`/`schema`) could later feed column descriptions as for DuckDB (D-1..D-4).

**Open questions** (answer before PG-2):
1. May the MVP ship without filter/stats parity (capability-gated webview), or must it match the other formats first?
2. Entry point: a command + quick pick first, or wait for the A-1 tree view?

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

## Dependencies

### DEP-1 · `npm audit` reports 3 issues in `exceljs`'s transitive dependencies · P3 · S · accepted, revisit on an `exceljs` update

`npm audit --omit=dev` (2026-11-20): `brace-expansion` (high, via `exceljs` -> `archiver` -> `glob`/`minimatch`) and `uuid` (moderate, `exceljs` -> `uuid`). Neither is reachable: those are zip-writing and `uuid.v4()` code paths (the `uuid` advisory is about v3/v5/v6 with a `buf` argument), Tablas never writes zips, and file contents never reach a glob. The only audit fix is `--force`, which downgrades `exceljs` to 3.4.0. Acceptance: when a newer `exceljs` (or a replacement) drops them, update and re-run the audit; until then do not "fix" it with `--force`.

## Ideas for later (not started, ranked)

Column sort and in-table find were promoted to T-1 and T-2.

1. **Column resize and freeze**: drag the header edge, persist widths per file, freeze the first column.
2. **Value viewer**: a side panel for long or JSON cells (cells clip at 400px today).
3. **Test gap**: `runReload` coalescing, `selectTable`, the watcher path filter and `refreshActive` are closures inside `resolveCustomEditor` (excluded from coverage, untested). Extract them into a small testable class (for example `DuckdbPanelController`).

## Roadmap items (not started)

Tracked in `README.md`, listed here so nothing lives in two places:
- Column sort: see T-1. In-table find (JetBrains-style, not VS Code's text Ctrl+F): see T-2. Per-column filtering is already done.
- Postgres connections (read-only): see PG-1 to PG-6.
- Basic cell editing. This needs a real edit model (dirty state, undo/redo, save) instead of `CustomReadonlyEditorProvider`.
- Marketplace publishing: see the release order at the top, P-3 for per-platform `.vsix` builds, `PUBLISHING.md` and the packaging notes in `CLAUDE.md`.

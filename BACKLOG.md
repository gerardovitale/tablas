# Backlog

Open follow-ups for Tablas that are not done yet. When an item ships, delete it here and add a line to `CHANGELOG.md` under `[Unreleased]`. IDs are stable, so don't renumber.

- **Priority:** P1 = advertised behavior is wrong or untested; P2 = scale, robustness or a missing check; P3 = cleanup and polish.
- **Size:** S = under an hour, M = a few hours, L = a day or more.

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

### F-6 · Uncached CSV and Parquet re-parse the whole file on every keystroke pause · P2 · M

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

### F-12 · Manual smoke test in a real VS Code window · P2 · S

Not done yet. The filter was checked with unit and integration tests and in a scratch page with a stub host, never in an installed extension. Run `npm run install:local:quick`, then check:
- A CSV with more than 5000 rows: filtering finds matches past row 5000, and the count is exact.
- SQLite and DuckDB: switch tables with a filter active.
- XLSX: switch sheets with a filter active.
- Alt+click on an empty cell gives the "is empty" filter.
- Esc, the `×` in the gutter, and the statistics card opening below the filter row.
- A high-contrast theme.

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

### R-3 · A refresh that lands on a half-written file is not retried · P3 · S

A torn read fails once with "Refresh failed" and waits for the next file event. Acceptance: retry once or twice after a short delay before reporting the failure.

### R-4 · `loadInitial` overwrites `document.handle` without closing the old one · P3 · S · pre-existing

If VS Code re-resolves the same document with a new panel (not verified that it does, e.g. when a tab moves to another window), the earlier handle and its temp copy leak. Acceptance: close any existing handle before assigning in `loadInitial`.

## SQL box (DuckDB)

### Q-1 · A running query cannot be cancelled by the user · P2 · S

A slow query blocks the connection's queue (stats, filters and table switches wait behind it) until it ends or hits the 30 s limit. A Cancel button would send `{type:'cancel-query'}` and call `interrupt()`, but `interrupt()` is connection-wide: it must only fire while *that query* is the one running, so track which request holds the connection.

### Q-2 · No way to export or reuse a query result · P3 · M

`COPY .. TO` is refused on purpose (see CLAUDE.md, "SQL box"). A result export (CSV) would be its own button: host-side write to a path the user picks in a save dialog, never from SQL text.

### Q-3 · Table names are not offered while typing · P3 · M

The box is a plain `<textarea>`: no completion, no highlighting. Candidates: insert the picked table's qualified name from a picker, or a small completion list from `TableRef`s.

### Q-4 · A query with unsent edits and a stuck "Running…" · P3 · S

If the host never answers (for example `document.handle` is missing), the status stays "Running…". Add a timeout in the webview or an explicit "not available" reply.

### Q-5 · Table ids can collide when a `main` table name contains a dot · P3 · S

`TableRef.name` for a table outside `main` is `schema.table`, so a `main` table `"a.b"` and table `b` in schema `a` get the same id, and the picker, reads, stats and filters resolve both to the last one listed (silent wrong data). Same for a schema name with a dot. Acceptance: an unambiguous id for non-`main` refs (or qualify the `main` one on a duplicate), with a fixture holding both.

### Q-6 · The SQL box binds every statement twice, and `EXPORT DATABASE` leaves a folder · P3 · M

Each statement is `prepare`d to learn its type (binding, which for `read_csv`/remote sources can mean sniffing or fetching), then `streamAndReadUntil(sql)` parses and binds the whole text again. A refused `EXPORT DATABASE '<dir>'` still creates `<dir>` while binding. Acceptance: classify without binding, or run the prepared statements instead of re-parsing, and refuse by leading keyword before preparing.

### Q-7 · Per-file query and last-table entries are never pruned · P3 · S

`tablas.lastQuery:<uri>` (up to 100k characters) and `tablas.lastTable:<uri>` stay in `workspaceState` for every file ever opened. Acceptance: cap the number of remembered files (drop the least recently used) or drop entries for files that no longer exist.

### Q-8 · The auto re-run after a refresh ignores how slow the query is · P3 · S

A refresh re-runs the last query even if the previous run took most of the 30 s budget, and each run holds the connection queue (table switches, filters and stats wait behind it). Now at most one re-run waits behind a running query. Acceptance: skip the automatic re-run when the last run took longer than a few seconds and show a "Run again" hint instead.

## dbt support

### D-1 · No dbt model description, tests or run results in the viewer · P3 · M

Only column descriptions are shown. The manifest also has the model `description`, `tests` and `depends_on`, and `target/run_results.json` has per-model status and timing of the last build. Candidates: the model description beside the table picker, a "last built 14:32, 3 s" note, a failing-test marker. Read `run_results.json` the same cached way as the manifest.

### D-2 · Preview Model only knows `.sql` models · P3 · S

Python models (`.py`) and seeds (`.csv`) have manifest nodes too. Extend the menu `when` clauses and the extension check, and map a seed's file to its node.

### D-3 · The DuckDB file is found by name, not from `profiles.yml` · P3 · M

dbt-duckdb's `path:` lives in `profiles.yml` (often outside the project) and can be relative to where dbt ran. Today the manifest's `database` (the catalog name, equal to the file name for the default setup) and a quick pick decide. Acceptance: read `profiles.yml` (`~/.dbt` or `DBT_PROFILES_DIR`) for the active profile and target to find the file directly; keep the current search as the fallback.

### D-4 · Preview from the table back to the model · P3 · S

The reverse direction: from a table in the picker, open the model's `.sql` file (`original_file_path` from the manifest).

### D-5 · Reading a big manifest can stall the extension host · P2 · M

`loadDbtManifest` reads the whole file and `JSON.parse`s it synchronously (cap 300 MB, far too high for a shared extension host), on every first load, table switch and reload after the manifest's mtime changes, and the table's first render waits for it. Concurrent callers each parse the same file (no in-flight sharing). Acceptance: lower the cap (around 50 MB), share one in-flight promise per file, and consider posting the rows before the descriptions arrive.

### D-6 · Descriptions can be missing at startup · P3 · S

`getDbtProjectRoots()` is empty until the first `findFiles` scan finishes, and `columnDescriptionsFor` uses it as the "workspace's only project" fallback, so a restored `.duckdb` tab outside the project can load without descriptions. Acceptance: `withColumnDescriptions` awaits the first scan (an exported promise from `registerDbtSupport`).

### D-7 · `pendingReveals` lifecycle and the 15 s limit · P3 · S

A second reveal for the same file overwrites the first (which then waits out its timer); a panel disposed before its handshake leaves its entry until the timer, so a manual reopen within that window opens on the previewed table; and 15 s is short for a multi-GB file that is read into memory and copied. Acceptance: settle a replaced entry at once, settle and delete the entry in the panel's `onDidDispose`, and tie the wait to the load rather than a fixed time.

## Packaging and marketplace

### P-1 · Internal docs probably ship in the `.vsix` · P2 · S

`.vscodeignore` has no exclusion for root markdown files, so `CLAUDE.md` and `PUBLISHING.md` look like they get packaged (`BACKLOG.md` is excluded). Verify with `vsce ls`, then exclude anything that shouldn't ship. This belongs on the existing "outstanding before `vsce publish`" list.

### P-2 · `vsce package` warns: "217 files, 186 are JavaScript, you should bundle your extension" · P2 · M

Warning text: `This extension consists of 217 files, out of which 186 are JavaScript files. For performance reasons, you should bundle your extension: https://aka.ms/vscode-bundle-extension. You should also exclude unnecessary files by adding them to your .vscodeignore: https://aka.ms/vscode-vscodeignore.`

Where the files come from (`vsce ls`, local darwin-arm64 build):
- `@duckdb/node-api`: ~174 files. The `!node_modules/@duckdb/node-api/lib/**/*.js` line ships its whole `lib/` tree unbundled. This is nearly all of the warning.
- `papaparse`: ~23 files (`tests/`, `player/`, `.github/`, ...). `papaparse` is already bundled into `dist/extension.js`, so the `!node_modules/papaparse/**` line is dead weight.
- `media/webview.js.map` and `dist/extension.js.map` ship (`*.map` in `.vscodeignore` only matches at the root).
- `PUBLISHING.md` ships (see P-1).

Acceptance:
- Remove the `!node_modules/papaparse/**` line from `.vscodeignore`.
- Bundle `@duckdb/node-api`'s JS into `dist/extension.js`: drop it from `external` in `esbuild.js`, keep only `@duckdb/node-bindings` external (the native `.node` must stay a separate file), and drop the `@duckdb/node-api` negate lines. Check that `@duckdb/node-bindings`' `duckdb.js` still resolves its platform package at runtime.
- Exclude `**/*.map` and `PUBLISHING.md`.
- `vsce ls` shows well under 20 files and `vsce package` prints no warning.
- `npm test` passes and a DuckDB file opens in the installed extension (`npm run install:local:quick`).
- Update the `.vscodeignore` notes and the DuckDB section of `CLAUDE.md` ("both ... are `external`") to match.

Related: the per-platform `.vsix` work (see Roadmap) touches the same `@duckdb/node-bindings-*` lines.

## Roadmap items (not started)

Tracked in `README.md`, listed here so nothing lives in two places:
- In-table find (JetBrains-style, not VS Code's text Ctrl+F). Per-column filtering is already done.
- Basic cell editing. This needs a real edit model (dirty state, undo/redo, save) instead of `CustomReadonlyEditorProvider`.
- Marketplace publishing, including per-platform `.vsix` builds. See `PUBLISHING.md` and the packaging notes in `CLAUDE.md`.

# Changelog

All notable changes to the "Tablas" extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- A SQL box for DuckDB files. Switch **Table | SQL** in the toolbar, type a query (it starts with `SELECT * FROM <the table you were viewing> LIMIT 100`) and press Run or Ctrl/⌘+Enter. The result shows as a table with its row count and run time; an error shows DuckDB's message and keeps your text. Only read statements run (`SELECT`/`WITH`/`FROM`, `SHOW`, `DESCRIBE`, `SUMMARIZE`, `PIVOT`, `EXPLAIN`, and read-style pragmas such as `PRAGMA table_info(t)`); anything else, such as `COPY .. TO`, `INSTALL`, `ATTACH`, `CALL`, an `INSERT`, or `EXPLAIN ANALYZE` (which runs what it explains), is refused before it runs. Results are capped at `tablas.maxRows` rows (the box says when a query returned more) and a query is stopped after 30 s. When the file refreshes after a `dbt build`, the query behind the result on screen runs again, so the result follows the data; the last query you ran is remembered per file. Switching back to Table keeps your filters and scroll position, and a refresh while you type keeps your cursor, selection and scroll.
- DuckDB tables and views in every schema now show in the table picker, not just `main`. dbt warehouses keep models in schemas such as `staging` or `main_marts`, which used to be invisible. When a file has more than one schema the picker groups by schema (`main` first) with counts, shows the short table name under each header, and searching also matches the schema. Tables outside `main` are named `schema.table`, so two schemas can each have an `orders` table. Statistics and filters work on them too.
- The table picker shows an approximate row count (`~1.2K`) beside each DuckDB table, taken from DuckDB's own table statistics without scanning the table. Views have none.
- DuckDB files reopen on the table you last looked at (remembered per file in the workspace), instead of always the first table.
- DuckDB files refresh themselves when they change on disk, so the `dbt build` → look at the result loop no longer needs closing and reopening the tab. After the file stops changing (and DuckDB's `.wal` file is gone, i.e. the build finished) the view re-reads it and keeps the selected table, your filters (re-applied to the new data), the focused filter box and the scroll position. The toolbar shows when it was updated and how the row count moved (`rows 1,204 → 1,310 (+106)`), "Build in progress…" while it waits, or why a refresh failed (the old view stays). A `↻` button, the editor-title button and the `Tablas: Refresh` command refresh on demand; the `tablas.autoRefresh` setting turns the automatic part off. Tablas works on a copy of the file, so it never holds a lock that could block `dbt`.
- Column filtering for every supported format. Each column header has a filter box in a second header row. Type text to match (case-insensitive), or `!text` (does not contain), `=text` / `!=text` (exact), `=` / `!=` (empty / not empty), `>`, `>=`, `<`, `<=` (numbers compare as numbers; a `YYYY-MM-DD` date compares by day against date and timestamp cells, so `<=2024-01-01` keeps every time on that day), or `\` to search for an operator literally. Boxes combine with AND. Filters search the **whole table**, not just the rows shown (`tablas.maxRows` only limits how many matches are displayed), and the status bar shows the exact match count. Esc clears a box, the `×` in the row-number gutter clears all, and Alt+click a cell filters its column to that value. CSV, Parquet and Excel filter in the extension host; SQLite and DuckDB filter inside the database. Very large tables skip filtering with a reason instead of freezing the editor.
- Column statistics for every supported format, computed over the whole table (not just the rows shown; `tablas.maxRows` does not limit them). Every column header shows a profile strip: type badge, null share, and a mini histogram for numeric columns or a distinct-count bar for text. Clicking a header profile opens a detail card with nulls, distinct count, min, max, mean and a full histogram with per-bin tooltips. Statistics are requested after the rows are already on screen, so the table never waits for them; a status note next to the row count shows "Computing…", or why statistics were skipped or unavailable for a very large table.

### Changed
- The table/view/sheet selector for SQLite, DuckDB and Excel files is now a searchable picker instead of a plain dropdown. Click it (or press Down) to open a list, type to narrow it with the match highlighted, and use Up/Down/Enter/Esc to choose. Tables and views are grouped with counts when a file has both, and views carry a `view` tag.

### Fixed
- The table selector no longer shows as a white box on dark themes. It now uses the active VS Code theme's colours, and native scrollbars follow the dark or light scheme.
- DuckDB files written by DuckDB 2.x (storage version 999, e.g. from the Python `duckdb` 2.0 package) now open. The bundled engine moved from DuckDB 1.5 to 2.0, which still reads older files. A file newer than the bundled engine now fails with a message that says so and suggests updating Tablas, instead of DuckDB's raw `version number 999` error.
- DuckDB views that read files by a relative path (such as `read_parquet('../data/*.parquet')`) now find them next to the `.duckdb` file for local files, instead of failing with "No files found". If one table or view cannot be read, the table selector stays and the error shows in its place, so you can switch to another table instead of the whole file failing.
- Excel date and time cells now show as ISO text (`2024-01-01`, `2024-01-01 10:30:00`, or `10:30:00` for time-only formats) instead of locale- and timezone-dependent JavaScript date text such as `Mon Jan 01 2024 00:00:00 GMT+0100`. The cell's number format decides whether the date, the time or both show. This applies in the table, the statistics card and filters, so date filters such as `>=2024-01-01` now work on Excel date cells. Elapsed-time formats such as `[h]:mm` show as a time.
- Excel merged cells whose top-left cell is a formula now show the formula result in every cell of the range, not `[object Object]`, and formula error results (`#DIV/0!`) show their error text.

## [0.1.0] - 2026-08-21

### Added
- CSV viewer — read-only table view via `tablas.csvViewer`.
- Parquet viewer — read-only table view via `tablas.parquetViewer`.
- SQLite viewer (`.db`/`.sqlite`/`.sqlite3`) via `tablas.sqliteViewer`, with a table/view selector.
- Excel viewer (`.xlsx`) via `tablas.xlsxViewer`, with a sheet selector.
- DuckDB viewer (`.duckdb`/`.ddb`) via `tablas.duckdbViewer`, with a table/view selector.
- `tablas.maxRows` setting to cap rows loaded per file (default 5000).
- Theme-aware, XSS-safe rendering (no `innerHTML` anywhere in the webview).

# Changelog

All notable changes to the "Tablas" extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Column filtering for every supported format. Each column header has a filter box in a second header row. Type text to match (case-insensitive), or `!text` (does not contain), `=text` / `!=text` (exact), `=` / `!=` (empty / not empty), `>`, `>=`, `<`, `<=` (numbers compare as numbers; a `YYYY-MM-DD` date compares by day against date and timestamp cells, so `<=2024-01-01` keeps every time on that day), or `\` to search for an operator literally. Boxes combine with AND. Filters search the **whole table**, not just the rows shown (`tablas.maxRows` only limits how many matches are displayed), and the status bar shows the exact match count. Esc clears a box, the `×` in the row-number gutter clears all, and Alt+click a cell filters its column to that value. CSV, Parquet and Excel filter in the extension host; SQLite and DuckDB filter inside the database. Very large tables skip filtering with a reason instead of freezing the editor.
- Column statistics for every supported format, computed over the whole table (not just the rows shown; `tablas.maxRows` does not limit them). Every column header shows a profile strip: type badge, null share, and a mini histogram for numeric columns or a distinct-count bar for text. Clicking a header profile opens a detail card with nulls, distinct count, min, max, mean and a full histogram with per-bin tooltips. Statistics are requested after the rows are already on screen, so the table never waits for them; a status note next to the row count shows "Computing…", or why statistics were skipped or unavailable for a very large table.

### Fixed
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

# Changelog

All notable changes to the "Tablas" extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Column statistics for every supported format, computed over the whole table (not just the rows shown; `tablas.maxRows` does not limit them). A **Statistics** control next to the row count switches between Off, **Headers** (a profile strip in every column header: type badge, null share, and a mini histogram for numeric columns or a distinct-count bar for text), and **Overview** (one row per column). Clicking a header profile opens a detail card with nulls, distinct count, min, max, mean and a full histogram with per-bin tooltips. The chosen mode is remembered. Statistics are computed only when you first switch the view on, so they add nothing to the time it takes to open a file.

## [0.1.0] - 2026-08-21

### Added
- CSV viewer — read-only table view via `tablas.csvViewer`.
- Parquet viewer — read-only table view via `tablas.parquetViewer`.
- SQLite viewer (`.db`/`.sqlite`/`.sqlite3`) via `tablas.sqliteViewer`, with a table/view selector.
- Excel viewer (`.xlsx`) via `tablas.xlsxViewer`, with a sheet selector.
- DuckDB viewer (`.duckdb`/`.ddb`) via `tablas.duckdbViewer`, with a table/view selector.
- `tablas.maxRows` setting to cap rows loaded per file (default 5000).
- Theme-aware, XSS-safe rendering (no `innerHTML` anywhere in the webview).

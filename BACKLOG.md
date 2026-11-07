# Backlog

Open follow-ups for Tablas that are not done yet. When an item ships, delete it here and add a line to `CHANGELOG.md` under `[Unreleased]`. IDs are stable, so don't renumber.

- **Priority:** P1 = advertised behavior is wrong or untested; P2 = scale, robustness or a missing check; P3 = cleanup and polish.
- **Size:** S = under an hour, M = a few hours, L = a day or more.

## Column filtering follow-ups

These come from the code review of the column-filtering work. The feature itself is shipped (see `CLAUDE.md`, "Column filtering"); everything below is a gap in it.

### F-2 · XLSX Date cells filter on `Date.toString()` text · P1 · M · needs a decision

A real Date cell displays (and so filters) as e.g. `Mon Jan 01 2024 ...`, which depends on locale and timezone. A date compare such as `>=2024-01-01` matches nothing on these cells (only cells that start with an ISO date take part), and a text filter matches the locale text. This comes from exceljs's `cell.text`, already noted in `CLAUDE.md`. `filter.xlsx` holds its `d`/`ts` columns as ISO strings today; switch them to real Date cells when this lands, and update `DISPLAYED_DATES` in `test/unit/filterParity.test.ts`.

Options:
1. Display and filter dates as ISO (`YYYY-MM-DD`, with the time when present). This changes what the table shows, in `stringifyXlsxCell` in `src/xlsxParser.ts`.
2. Filter on ISO text but keep the current display. This breaks the rule that a filter matches what the table shows.
3. Leave it and document that date filters don't work on XLSX Date cells.

Recommendation: option 1. It fixes the table display too, not only filtering. Needs an owner decision before work starts.

### F-3 · Soften the date wording in the README · P1 · S

The README example `<=2024-01-01` holds in every format except XLSX workbooks with real Date cells (see F-2), where it matches nothing. Either land F-2 first, or reword now. The CHANGELOG line already states the day-compare rule.

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

## Packaging and marketplace

### P-1 · Internal docs probably ship in the `.vsix` · P2 · S

`.vscodeignore` has no exclusion for root markdown files, so `CLAUDE.md` and `PUBLISHING.md` look like they get packaged (`BACKLOG.md` is excluded). Verify with `vsce ls`, then exclude anything that shouldn't ship. This belongs on the existing "outstanding before `vsce publish`" list.

## Roadmap items (not started)

Tracked in `README.md`, listed here so nothing lives in two places:
- In-table find (JetBrains-style, not VS Code's text Ctrl+F). Per-column filtering is already done.
- Basic cell editing. This needs a real edit model (dirty state, undo/redo, save) instead of `CustomReadonlyEditorProvider`.
- Marketplace publishing, including per-platform `.vsix` builds. See `PUBLISHING.md` and the packaging notes in `CLAUDE.md`.

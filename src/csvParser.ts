import Papa from 'papaparse';
import {
  computeStringTableStats,
  exceedsStatsCellCap,
  reportStatsFailure,
  skippedStats,
  STATS_TOO_LARGE_REASON,
} from './columnStats';
import {
  exceedsFilterCellCap,
  filterTable,
  FILTER_FAILED_REASON,
  FILTER_TOO_LARGE_REASON,
  reportFilterFailure,
  type ColumnFilterSpec,
  type FilterableRows,
  type FilterOutcome,
} from './filter';
import {
  clampMaxRows,
  type ParsedTable,
  type ParseError,
  type TableParseOutcome,
  type TableStats,
} from './tableData';

export type ParsedCsv = ParsedTable;
export type { ParseError };
export type CsvParseOutcome = TableParseOutcome;

interface CsvRows {
  headers: string[];
  allRows: string[][];
  errors: ParseError[];
  hasFatalError: boolean;
}

/**
 * The one place PapaParse is configured, shared by `parseCsv` (rows to show)
 * and `csvStats` (whole-table statistics) so the two can never disagree about
 * what a row or a header is. Callers must pass non-blank content.
 */
function parseCsvRows(rawContent: string): CsvRows {
  const result = Papa.parse<Record<string, string>>(rawContent, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    delimiter: '',
    transformHeader: (h: string) => h.trim(),
  });

  const errors: ParseError[] = (result.errors ?? []).map((e) => ({
    type: e.type,
    code: e.code,
    message: e.message,
    row: e.row,
  }));

  const headers: string[] = result.meta?.fields ?? [];
  const allRows: string[][] = (result.data ?? []).map((row) =>
    headers.map((h) => String(row[h] ?? ''))
  );

  const hasFatalError =
    errors.length > 0 &&
    errors.every((e) => e.type === 'Delimiter' || e.code === 'UndetectableDelimiter')
      ? false
      : errors.some((e) => e.type === 'Abort');

  return { headers, allRows, errors, hasFatalError };
}

export function parseCsv(rawContent: string, maxRowsInput?: number): CsvParseOutcome {
  const maxRows = clampMaxRows(maxRowsInput);
  if (rawContent.trim() === '') {
    return {
      success: true,
      data: { headers: [], rows: [], rowCount: 0, columnCount: 0 },
      errors: [],
    };
  }

  const { headers, allRows, errors, hasFatalError } = parseCsvRows(rawContent);
  const totalRows = allRows.length;
  // Papaparse has already parsed the whole string by this point, so this
  // slice doesn't save decode time -- it shrinks the postMessage payload
  // and the webview's DOM node count, same as the parquet row cap.
  const rows: string[][] = maxRows != null ? allRows.slice(0, maxRows) : allRows;

  if (hasFatalError) {
    return { success: false, errors };
  }

  return {
    success: true,
    data: {
      headers,
      rows,
      rowCount: rows.length,
      columnCount: headers.length,
      totalRowCount: totalRows,
    },
    errors,
  };
}

/**
 * Whole-file column statistics (every row, regardless of `tablas.maxRows`).
 * Computed on request -- the editor re-reads and re-parses the file when the
 * webview asks after rendering the table -- so it takes the raw text rather than
 * relying on anything `parseCsv` kept. `undefined` means "no stats" (blank
 * file, unparseable file, no columns, or an unexpected failure, which is
 * reported through `statsHooks`); it never throws, because a stats problem
 * must not break showing the table.
 */
export function csvStats(rawContent: string): TableStats | undefined {
  if (rawContent.trim() === '') {
    return undefined;
  }
  try {
    const { headers, allRows, hasFatalError } = parseCsvRows(rawContent);
    if (hasFatalError || headers.length === 0) {
      return undefined;
    }
    if (exceedsStatsCellCap(allRows.length, headers.length)) {
      return skippedStats(STATS_TOO_LARGE_REASON);
    }
    return computeStringTableStats(headers.length, allRows);
  } catch (err) {
    reportStatsFailure(err);
    return undefined;
  }
}

/**
 * Every row of the file as strings (regardless of `tablas.maxRows`), for
 * filtering. Shares `parseCsvRows` with `parseCsv`, so a filter and the table
 * can never disagree about what a row is. Never throws: a blank file yields no
 * columns, and an unparseable or oversized one yields a `failedReason`.
 */
export function csvRowsForFilter(rawContent: string): FilterableRows | { failedReason: string } {
  if (rawContent.trim() === '') {
    return { columnCount: 0, rows: [] };
  }
  try {
    const { headers, allRows, hasFatalError } = parseCsvRows(rawContent);
    if (hasFatalError) {
      return { failedReason: FILTER_FAILED_REASON };
    }
    if (exceedsFilterCellCap(allRows.length, headers.length)) {
      return { failedReason: FILTER_TOO_LARGE_REASON };
    }
    return { columnCount: headers.length, rows: allRows };
  } catch (err) {
    reportFilterFailure(err);
    return { failedReason: FILTER_FAILED_REASON };
  }
}

/**
 * Filters the whole file: up to `maxRows` matching rows plus the exact match
 * count. Re-parses `rawContent` on every call -- the editor caches the result
 * of `csvRowsForFilter` instead when the table is small enough.
 */
export function csvFilter(
  rawContent: string,
  specs: readonly ColumnFilterSpec[],
  maxRows: number
): FilterOutcome {
  const table = csvRowsForFilter(rawContent);
  return 'failedReason' in table ? table : filterTable(table, specs, maxRows);
}

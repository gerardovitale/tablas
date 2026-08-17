import Papa from 'papaparse';
import { clampMaxRows, type ParsedTable, type ParseError, type TableParseOutcome } from './tableData';

export type ParsedCsv = ParsedTable;
export type { ParseError };
export type CsvParseOutcome = TableParseOutcome;

export function parseCsv(rawContent: string, maxRowsInput?: number): CsvParseOutcome {
  const maxRows = clampMaxRows(maxRowsInput);
  if (rawContent.trim() === '') {
    return {
      success: true,
      data: { headers: [], rows: [], rowCount: 0, columnCount: 0 },
      errors: [],
    };
  }

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
  const totalRows = allRows.length;
  // Papaparse has already parsed the whole string by this point, so this
  // slice doesn't save decode time -- it shrinks the postMessage payload
  // and the webview's DOM node count, same as the parquet row cap.
  const rows: string[][] = maxRows != null ? allRows.slice(0, maxRows) : allRows;

  const hasFatalError =
    errors.length > 0 &&
    errors.every((e) => e.type === 'Delimiter' || e.code === 'UndetectableDelimiter')
      ? false
      : errors.some((e) => e.type === 'Abort');

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

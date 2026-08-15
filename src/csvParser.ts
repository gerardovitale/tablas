import Papa from 'papaparse';

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  rowCount: number;
  columnCount: number;
}

export interface ParseError {
  type: string;
  code: string;
  message: string;
  row?: number;
}

export type CsvParseOutcome =
  | { success: true; data: ParsedCsv; errors: ParseError[] }
  | { success: false; errors: ParseError[] };

export function parseCsv(rawContent: string): CsvParseOutcome {
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
  const rows: string[][] = (result.data ?? []).map((row) =>
    headers.map((h) => String(row[h] ?? ''))
  );

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
    },
    errors,
  };
}

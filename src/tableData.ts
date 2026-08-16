/**
 * Shared shape produced by every source-format parser (CSV, Parquet, ...).
 * The webview only ever renders this shape — it never knows or cares which
 * parser produced it. See CLAUDE.md's architecture section.
 */
export interface ParsedTable {
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

export type TableParseOutcome =
  | { success: true; data: ParsedTable; errors: ParseError[] }
  | { success: false; errors: ParseError[] };

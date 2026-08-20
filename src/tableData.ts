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
  /**
   * True row count in the source file, when it exceeds `rowCount` (i.e. the
   * result was truncated by a maxRows cap). Omitted, or equal to
   * `rowCount`, means the result is not truncated.
   */
  totalRowCount?: number;
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

/**
 * A single table or view inside a multi-table source (e.g. a SQLite
 * database). Distinct from `ParsedTable`, which is the *contents* of one
 * such table/view once selected.
 */
export interface TableRef {
  name: string;
  type: 'table' | 'view';
}

/**
 * The full picture posted to the webview for a multi-table source: every
 * table/view available in the file, which one is currently selected, and
 * that selection's parsed contents. Named generically (not `Sqlite*`) so a
 * future multi-table format (e.g. DuckDB) can reuse this shape and the
 * webview's rendering path unchanged.
 */
export interface MultiTableData {
  tables: TableRef[];
  selectedTable: string;
  data: ParsedTable;
}

export type MultiTableParseOutcome =
  | { success: true; data: MultiTableData; errors: ParseError[] }
  | { success: false; errors: ParseError[] };

/**
 * Normalizes a caller-supplied `maxRows` into a safe integer >= 1, or
 * `undefined` (meaning "no cap"). Guards against negative/fractional
 * values reaching `Array.slice`/hyparquet's `rowEnd` unsanitized -- e.g.
 * `allRows.slice(0, -5)` doesn't truncate from the start, it means "all
 * but the last 5," which is not what a negative maxRows should do.
 * `undefined`/non-finite input passes through as "no cap", matching every
 * existing caller that omits the parameter.
 */
export function clampMaxRows(maxRows: number | undefined): number | undefined {
  if (maxRows === undefined || !Number.isFinite(maxRows)) {
    return maxRows;
  }
  return Math.max(1, Math.floor(maxRows));
}

/**
 * Converts a bigint row count (e.g. Parquet's metadata.num_rows) into a
 * plain number, clamping to Number.MAX_SAFE_INTEGER instead of letting
 * Number(bigint) silently round once the value passes 2^53. Unrealistic
 * for an actual file's row count, but a deterministic clamp beats a
 * silently-inexact cast.
 */
export function bigIntToSafeNumber(value: bigint): number {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.MAX_SAFE_INTEGER;
}

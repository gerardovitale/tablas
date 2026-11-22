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

export type ColumnKind =
  | 'integer'
  | 'float'
  | 'boolean'
  | 'date'
  | 'text'
  | 'mixed'
  | 'other'
  | 'empty';

export interface HistogramStats {
  lo: number;
  hi: number;
  counts: number[];
}

/**
 * Stats for one column. Crosses `postMessage` as JSON, so no bigint, NaN,
 * Infinity or Date may appear anywhere: min/max are display strings, and
 * mean/histogram bounds are always finite.
 */
export interface ColumnStats {
  type: ColumnKind;
  nullCount: number;
  /**
   * The source's own type for the column (`BIGINT`, `DECIMAL(10,2)`, `INT64`, a SQLite
   * declared type), shown beside the inferred kind. Omitted when the format has none
   * (CSV, XLSX) or it is unknown (a SQLite expression column).
   */
  nativeType?: string;
  /** Omitted for `'other'` columns (nested/binary values). */
  distinctCount?: number;
  /** True when distinct tracking hit its cap, so `distinctCount` is a floor. */
  distinctIsLowerBound?: boolean;
  min?: string;
  max?: string;
  /** Integer/float columns only. */
  mean?: number;
  /** Integer/float columns with more than one distinct numeric value only. */
  histogram?: HistogramStats;
}

/**
 * Whole-table column statistics (never limited by maxRows). Not part of
 * `ParsedTable`: they're computed lazily, on request, and travel in their own
 * `stats-data` message (see statsMessage.ts).
 */
export interface TableStats {
  /** Parallel to the table's headers; empty when `skippedReason` is set. */
  columns: ColumnStats[];
  skippedReason?: string;
}

export interface ParseError {
  type: string;
  code: string;
  message: string;
  row?: number;
}

/**
 * What a single-table source (CSV, Parquet) tells the webview beyond its rows, when its host can run
 * queries: the same fields `MultiTableData` carries, so the webview treats every source alike.
 */
export interface SingleTableQueryInfo {
  capabilities?: SourceCapabilities;
  /** The SQL box's starting text (the file's view, named after the file). */
  querySuggestion?: string;
  /** A line shown under the box (for example how DuckDB's reading can differ from the table view). */
  queryNote?: string;
}

export type TableParseOutcome =
  | ({ success: true; data: ParsedTable; errors: ParseError[] } & SingleTableQueryInfo)
  | { success: false; errors: ParseError[] };

/** DuckDB's default schema: tables in it keep their bare name as `TableRef.name`. */
export const MAIN_SCHEMA = 'main';

/**
 * A single table or view inside a multi-table source (e.g. a SQLite
 * database). Distinct from `ParsedTable`, which is the *contents* of one
 * such table/view once selected.
 */
export interface TableRef {
  /**
   * Unique id of the table within the source: what `select-table`, stats and
   * filter requests carry. For a DuckDB table outside the `main` schema it is
   * `schema.table`; everything else keeps its bare name.
   */
  name: string;
  type: 'table' | 'view';
  /** Schema, only for a table outside `main` (DuckDB); a ref without one is in `main`. */
  schema?: string;
  /** The unqualified table name; set together with `schema`. */
  table?: string;
  /**
   * Approximate row count from the engine's own table statistics, without
   * scanning (DuckDB tables only; views and other sources omit it).
   */
  approxRows?: number;
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
  /**
   * Set when the table list loaded but reading `selectedTable` failed (e.g. a
   * DuckDB view over files that cannot be found). `data` is then empty. The
   * webview shows this under the table selector, so the user can switch to
   * another table instead of losing the whole file to one bad table.
   */
  tableError?: string;
  /**
   * Set when this payload is a re-read of the same file (the source changed on
   * disk, or the user asked to refresh), not a first load or a table switch.
   * The webview then keeps the user's filters and scroll position, and shows
   * when the data was refreshed and how the row count moved.
   */
  reload?: ReloadInfo;
  /**
   * What the host can do for this source. The webview gates toolbar controls on
   * these flags, never on the file format, so it stays format-agnostic.
   */
  capabilities?: SourceCapabilities;
  /**
   * A starter query for the selected table, when the source can run queries. The SQL box opens
   * on it (and follows the table until the user edits the text); no query text is remembered.
   */
  querySuggestion?: string;
  /** A line shown under the SQL box, when the host has something to say about how it reads the source. */
  queryNote?: string;
  /**
   * Column descriptions for the selected table (from dbt's `manifest.json` when the
   * file belongs to a dbt project), by column name; the webview shows them in the
   * header tooltip and the detail card. Omitted when there are none.
   */
  columnDescriptions?: Record<string, string>;
  /**
   * The host chose this table (the dbt "Preview Model" command), as opposed to the
   * user picking it in the picker. The webview adopts it even though it differs
   * from the user's last pick, and leaves the SQL box.
   */
  hostSelected?: boolean;
}

export interface ReloadInfo {
  /** ISO timestamp of the re-read. */
  at: string;
  /** Row count of the same table before the reload; omitted if the table changed or was unreadable. */
  previousRowCount?: number;
}

export interface SourceCapabilities {
  /** The host answers `{type:'refresh'}` by re-reading the file. */
  refresh?: boolean;
  /** The host answers `{type:'run-query'}` (read-only SQL, see queryMessage.ts). */
  query?: boolean;
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

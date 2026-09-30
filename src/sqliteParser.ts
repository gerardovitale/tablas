import initSqlJs from 'sql.js';
import {
  clipStat,
  exceedsStatsCellCap,
  histogramFromCounts,
  planHistogram,
  reportStatsFailure,
  skippedStats,
  StatsCache,
  STATS_TOO_LARGE_REASON,
  statsLimits,
} from './columnStats';
import {
  clampMaxRows,
  type ColumnKind,
  type ColumnStats,
  type MultiTableData,
  type MultiTableParseOutcome,
  type ParsedTable,
  type ParseError,
  type TableRef,
  type TableStats,
} from './tableData';

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>;
type SqliteDatabase = InstanceType<SqlJsStatic['Database']>;
type SqlCellValue = number | string | Uint8Array | null;

export interface SqliteHandle {
  readonly db: SqliteDatabase;
  close(): void;
}

// Lazily initializes the WASM VM once per extension-host process --
// instantiating it is comparatively expensive, and every file open/table
// switch after the first reuses this same cached instance.
let sqlJsPromise: Promise<SqlJsStatic> | undefined;
function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      // sql.js's default locateFile resolution can behave differently
      // depending on how the caller itself was loaded (ts-node vs. an
      // esbuild-bundled, `external`-kept require) -- resolving the wasm
      // binary explicitly here works identically in both.
      locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm'),
    });
  }
  return sqlJsPromise;
}

// First 16 bytes of every valid SQLite database file.
const SQLITE_MAGIC = 'SQLite format 3\0';

function hasSqliteMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < SQLITE_MAGIC.length) {
    return false;
  }
  for (let i = 0; i < SQLITE_MAGIC.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

// Double-quotes an identifier for safe interpolation into SQL, doubling any
// embedded '"' per standard SQL escaping. Table/view names always come from
// sqlite_master (not raw external input), but SQLite technically allows any
// character in an identifier, including '"' and spaces.
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Stringify one raw sql.js cell value into the string-only shape the
 * webview renders. sql.js's dynamic typing maps SQLite's INTEGER/REAL to a
 * plain `number`, TEXT to `string`, BLOB to `Uint8Array`, and NULL to
 * `null`.
 *
 * Known, accepted limitation: sql.js returns large SQLite INTEGERs as a
 * plain `number`, so values beyond `Number.MAX_SAFE_INTEGER` can lose
 * precision -- the same class of limit `bigIntToSafeNumber` bounds for
 * Parquet's bigint row counts, but sql.js gives no bigint path here to
 * intercept it on.
 */
export function stringifySqliteCell(value: SqlCellValue): string {
  if (value === null) {
    return '';
  }
  if (value instanceof Uint8Array) {
    return Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return String(value);
}

/** Shared "nothing to show" table shape -- 0-byte input and a valid-but-empty database both use it. */
export function emptyParsedTable(): ParsedTable {
  return { headers: [], rows: [], rowCount: 0, columnCount: 0 };
}

/** Opens a SQLite database from raw file bytes, sniffing the header first. */
export async function openSqliteDatabase(
  bytes: Uint8Array
): Promise<SqliteHandle | { error: ParseError }> {
  if (!hasSqliteMagic(bytes)) {
    return {
      error: {
        type: 'SqliteError',
        code: 'NotASqliteFile',
        message: 'File does not look like a SQLite database (missing "SQLite format 3" header).',
      },
    };
  }
  try {
    const SQL = await loadSqlJs();
    const db = new SQL.Database(bytes);
    return { db, close: () => db.close() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: { type: 'SqliteError', code: 'OpenFailed', message } };
  }
}

/** Lists user tables and views in a database, excluding SQLite's own bookkeeping tables. */
export function listSqliteTables(handle: SqliteHandle): TableRef[] {
  const stmt = handle.db.prepare(
    `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name ASC`
  );
  const tables: TableRef[] = [];
  try {
    while (stmt.step()) {
      const [name, type] = stmt.get();
      tables.push({ name: String(name), type: type === 'view' ? 'view' : 'table' });
    }
  } finally {
    stmt.free();
  }
  return tables;
}

// Columns per aggregate scan. Keeps the generated SQL comfortably under
// SQLite's expression/term limits for very wide tables; each chunk is one
// full table scan.
const STATS_COLUMN_CHUNK = 40;
// Aggregates selected per column, in the order buildColumnStats reads them.
const STATS_VALUES_PER_COLUMN = 8;

// Handles are read-only for the document's lifetime, so asking again for an
// already-computed table's stats (including a failure) reuses the answer
// instead of re-scanning.
const statsCache = new StatsCache<SqliteHandle>();

function resolveSqliteKind(ints: number, reals: number, texts: number, blobs: number): ColumnKind {
  const numeric = ints + reals > 0;
  const kinds = (numeric ? 1 : 0) + (texts > 0 ? 1 : 0) + (blobs > 0 ? 1 : 0);
  if (kinds === 0) {
    return 'empty';
  }
  if (kinds > 1) {
    return 'mixed';
  }
  if (numeric) {
    return reals > 0 ? 'float' : 'integer';
  }
  return texts > 0 ? 'text' : 'other';
}

/**
 * Builds one column's stats from its aggregate row slice. Types come from
 * `typeof()` storage-class counts, not declared column types: SQLite's
 * dynamic typing lets a column declared INTEGER hold text, so declared types
 * aren't trustworthy.
 */
function buildColumnStats(
  handle: SqliteHandle,
  quotedTable: string,
  quotedColumn: string,
  total: number,
  agg: readonly SqlCellValue[]
): ColumnStats {
  const [nonNullRaw, intsRaw, realsRaw, textsRaw, distinctRaw, minRaw, maxRaw, avgRaw] = agg;
  const nonNull = Number(nonNullRaw ?? 0);
  const ints = Number(intsRaw ?? 0);
  const reals = Number(realsRaw ?? 0);
  const texts = Number(textsRaw ?? 0);
  const type = resolveSqliteKind(ints, reals, texts, nonNull - ints - reals - texts);

  const stats: ColumnStats = { type, nullCount: total - nonNull };
  if (type === 'other') {
    return stats;
  }
  stats.distinctCount = Number(distinctRaw ?? 0);

  if (type === 'text') {
    stats.min = clipStat(String(minRaw));
    stats.max = clipStat(String(maxRaw));
  } else if ((type === 'integer' || type === 'float') && typeof minRaw === 'number' && typeof maxRaw === 'number') {
    let min = String(minRaw);
    let max = String(maxRaw);
    if (type === 'integer' && !(Number.isSafeInteger(minRaw) && Number.isSafeInteger(maxRaw))) {
      // sql.js hands back a rounded double for INTEGERs beyond 2^53; ask
      // SQLite for the exact text instead.
      const exact = handle.db.exec(
        `SELECT CAST(MIN(${quotedColumn}) AS TEXT), CAST(MAX(${quotedColumn}) AS TEXT) FROM ${quotedTable}`
      )[0]?.values[0];
      min = String(exact?.[0] ?? min);
      max = String(exact?.[1] ?? max);
    }
    stats.min = min;
    stats.max = max;
    if (typeof avgRaw === 'number' && Number.isFinite(avgRaw)) {
      stats.mean = avgRaw;
    }
    const plan = planHistogram(minRaw, maxRaw, type === 'integer');
    if (plan) {
      // CAST(... AS REAL) forces real division (integer / integer would
      // truncate); the two-arg scalar MIN clamps the max value into the last
      // bin, mirroring columnStats.bucketIndex.
      const buckets = handle.db.exec(
        `SELECT MIN(CAST((CAST(${quotedColumn} AS REAL) - ?) / ? AS INTEGER), ?), COUNT(*) ` +
          `FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL GROUP BY 1 ORDER BY 1`,
        [plan.lo, plan.width, plan.bins - 1]
      )[0]?.values ?? [];
      stats.histogram = histogramFromCounts(
        plan,
        buckets.map(([bucket, count]) => [Number(bucket), Number(count)] as const)
      );
    }
  }
  return stats;
}

/** The uncached work behind `sqliteTableStats`; may throw. */
function computeSqliteStats(handle: SqliteHandle, tableName: string): TableStats | undefined {
  const quotedTable = quoteIdentifier(tableName);
  const totalRowCount = Number(handle.db.exec(`SELECT COUNT(*) FROM ${quotedTable}`)[0]?.values[0]?.[0] ?? 0);
  // Zero rows still need the column names, which db.exec drops (see readSqliteTable).
  const probe = handle.db.prepare(`SELECT * FROM ${quotedTable} LIMIT 0`);
  let headers: string[];
  try {
    headers = probe.getColumnNames();
  } finally {
    probe.free();
  }
  if (headers.length === 0) {
    return undefined;
  }
  if (exceedsStatsCellCap(totalRowCount, headers.length, statsLimits.sqliteMaxCells)) {
    return skippedStats(STATS_TOO_LARGE_REASON);
  }

  const columns: ColumnStats[] = [];
  for (let start = 0; start < headers.length; start += STATS_COLUMN_CHUNK) {
    const quotedColumns = headers.slice(start, start + STATS_COLUMN_CHUNK).map(quoteIdentifier);
    const selectList = quotedColumns
      .map(
        (q) =>
          `COUNT(${q}), SUM(typeof(${q}) = 'integer'), SUM(typeof(${q}) = 'real'), ` +
          `SUM(typeof(${q}) = 'text'), COUNT(DISTINCT ${q}), MIN(${q}), MAX(${q}), AVG(${q})`
      )
      .join(', ');
    const row = handle.db.exec(`SELECT COUNT(*), ${selectList} FROM ${quotedTable}`)[0]?.values[0];
    if (!row) {
      return undefined;
    }
    const total = Number(row[0]);
    quotedColumns.forEach((q, i) => {
      const offset = 1 + i * STATS_VALUES_PER_COLUMN;
      columns.push(
        buildColumnStats(handle, quotedTable, q, total, row.slice(offset, offset + STATS_VALUES_PER_COLUMN) as SqlCellValue[])
      );
    });
  }
  return { columns };
}

/**
 * Whole-table column statistics via SQL push-down (regardless of
 * `tablas.maxRows`): one aggregate scan per chunk of columns plus one small
 * bucket query per numeric column. Computed on demand -- when the user first
 * opens the Statistics view -- and synchronous, so it holds the extension
 * host for the duration (hence `statsLimits.sqliteMaxCells`). `undefined` =
 * no stats (no columns, or a failure such as a view with duplicate column
 * names, reported through `statsHooks`); it never throws, and every outcome
 * is remembered per handle.
 */
export function sqliteTableStats(handle: SqliteHandle, tableName: string): TableStats | undefined {
  const cached = statsCache.lookup(handle, tableName);
  if (cached.hit) {
    return cached.stats;
  }
  let stats: TableStats | undefined;
  try {
    stats = computeSqliteStats(handle, tableName);
  } catch (err) {
    reportStatsFailure(err);
  }
  statsCache.store(handle, tableName, stats);
  return stats;
}

/** Reads one table/view's contents, honoring `maxRowsInput` the same way CSV/Parquet do. */
export function readSqliteTable(
  handle: SqliteHandle,
  tableName: string,
  maxRowsInput?: number
): ParsedTable {
  const maxRows = clampMaxRows(maxRowsInput);
  const quoted = quoteIdentifier(tableName);

  const countResult = handle.db.exec(`SELECT COUNT(*) FROM ${quoted}`);
  const totalRowCount = Number(countResult[0]?.values[0]?.[0] ?? 0);

  // db.prepare + step/get, not db.exec, for the data query -- db.exec drops
  // column names entirely for a zero-row result, which would break showing
  // headers for an empty table (mirrors csvParser's use of
  // result.meta?.fields and parquetParser's schema-derived headers).
  const selectSql =
    maxRows != null ? `SELECT * FROM ${quoted} LIMIT ${maxRows}` : `SELECT * FROM ${quoted}`;
  const stmt = handle.db.prepare(selectSql);
  const headers = stmt.getColumnNames();
  const rows: string[][] = [];
  try {
    while (stmt.step()) {
      rows.push((stmt.get() as SqlCellValue[]).map(stringifySqliteCell));
    }
  } finally {
    stmt.free();
  }

  return {
    headers,
    rows,
    rowCount: rows.length,
    columnCount: headers.length,
    totalRowCount,
  };
}

/**
 * Selects a table (falling back to the first one, alphabetically, if
 * `desiredTable` is unset or doesn't exist) and reads it, wrapping the
 * result in the `MultiTableData` shape shared by every caller that needs
 * "given an open handle and its table list, produce the next thing to
 * render" -- `parseSqlite` below, and `sqliteEditorProvider.ts`'s
 * `loadInitial`/`handleSelectTable`, which otherwise each re-implement this
 * same selection-fallback + read + wrap sequence.
 */
export function readSelectedTable(
  handle: SqliteHandle,
  tables: TableRef[],
  desiredTable: string | undefined,
  maxRowsInput?: number
): MultiTableData {
  if (tables.length === 0) {
    return { tables: [], selectedTable: '', data: emptyParsedTable() };
  }
  const target =
    desiredTable && tables.some((t) => t.name === desiredTable) ? desiredTable : tables[0].name;
  const data = readSqliteTable(handle, target, maxRowsInput);
  return { tables, selectedTable: target, data };
}

/**
 * One-shot convenience wrapper used by tests and any caller that doesn't
 * need to keep the database open across multiple table selections. The
 * editor provider keeps its own long-lived `SqliteHandle` instead (see
 * `sqliteEditorProvider.ts`) so switching tables re-queries the
 * already-open database rather than re-opening it on every selection.
 */
export async function parseSqlite(
  bytes: Uint8Array,
  maxRowsInput?: number,
  selectedTable?: string
): Promise<MultiTableParseOutcome> {
  if (bytes.byteLength === 0) {
    return {
      success: true,
      data: { tables: [], selectedTable: '', data: emptyParsedTable() },
      errors: [],
    };
  }

  const opened = await openSqliteDatabase(bytes);
  if ('error' in opened) {
    return { success: false, errors: [opened.error] };
  }

  try {
    const tables = listSqliteTables(opened);
    const data = readSelectedTable(opened, tables, selectedTable, maxRowsInput);
    return { success: true, data, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, errors: [{ type: 'SqliteError', code: 'ReadFailed', message }] };
  } finally {
    opened.close();
  }
}

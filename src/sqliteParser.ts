import initSqlJs from 'sql.js';
import {
  clampMaxRows,
  type MultiTableData,
  type MultiTableParseOutcome,
  type ParsedTable,
  type ParseError,
  type TableRef,
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

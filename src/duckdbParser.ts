import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DuckDBInstance, type DuckDBConnection, type Json } from '@duckdb/node-api';
import {
  clampMaxRows,
  type MultiTableData,
  type MultiTableParseOutcome,
  type ParsedTable,
  type ParseError,
  type TableRef,
} from './tableData';

/**
 * Unlike sql.js/exceljs, `@duckdb/node-api` opens a database from a file
 * *path*, not an in-memory byte buffer. To keep `parseDuckdb(bytes, ...)`
 * symmetric with `parseSqlite`/`parseXlsx` -- same signature shape, same
 * unit-test style (fixtures loaded as bytes via `fs.readFileSync`), and
 * correctness over non-local `vscode.FileSystemProvider` filesystems -- the
 * bytes are written to a temp file first, and DuckDB is opened against that.
 * `DuckdbHandle.close()` deletes the temp file alongside closing the
 * connection/instance, so every caller that opens a handle also owns
 * cleaning up its temp file.
 *
 * Known residual limitation: cleanup only happens if `close()` actually
 * runs. If the extension host process is killed (crash, forced quit)
 * between `openDuckdbDatabase` and disposal, the temp file -- a full copy
 * of the source database's bytes -- is orphaned in `os.tmpdir()`. Mode
 * 0o600 (see `openDuckdbDatabase`) limits who can read it while it exists,
 * but doesn't make it self-cleaning; OS temp-dir reaping is the only
 * backstop. SQLite/XLSX don't have this exposure at all, since they never
 * write the source bytes to disk in the first place.
 */
export interface DuckdbHandle {
  readonly connection: DuckDBConnection;
  readonly tempFilePath: string;
  close(): void;
}

function makeTempFilePath(): string {
  return path.join(os.tmpdir(), `tablas-${crypto.randomBytes(8).toString('hex')}.duckdb`);
}

// Double-quotes an identifier for safe interpolation into SQL, doubling any
// embedded '"' per standard SQL escaping -- mirrors sqliteParser.ts's
// quoteIdentifier. Table/view names always come from information_schema
// (not raw external input), but DuckDB, like SQLite, allows any character
// in a quoted identifier.
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Stringify one cell read via `getRowsJson()` into the string-only shape the
 * webview renders. DuckDB's own `JsonDuckDBValueConverter` (used internally
 * by `getRowsJson()`) already reduces every type to a JSON-safe value:
 * BIGINT/HUGEINT/DECIMAL/DATE/TIMESTAMP/UUID/BLOB/etc. all come through as
 * `string`, booleans/most integers/floats as `number`/`boolean`, and
 * LIST/STRUCT/MAP/ARRAY/UNION as nested JSON arrays/objects -- only the
 * latter need any handling here, since `ParsedTable`'s cells are
 * string-only.
 */
export function stringifyDuckdbCell(value: Json): string {
  if (value === null) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Shared "nothing to show" table shape, mirroring sqliteParser.ts/xlsxParser.ts. */
export function emptyParsedTable(): ParsedTable {
  return { headers: [], rows: [], rowCount: 0, columnCount: 0 };
}

/**
 * Opens a DuckDB database from raw file bytes by writing them to a temp
 * file and opening that read-only (see the module comment above). No
 * magic-byte pre-check, unlike SQLite's 16-byte sniff / XLSX's 2-byte ZIP
 * sniff -- DuckDB's own open call already rejects a non-database file with
 * a clear error, so hand-rolling a header check here would just duplicate
 * that validation.
 */
export async function openDuckdbDatabase(
  bytes: Uint8Array
): Promise<DuckdbHandle | { error: ParseError }> {
  const tempFilePath = makeTempFilePath();
  try {
    // Mode 0o600 -- os.tmpdir() is a shared, world-readable directory on a
    // multi-user machine, and this file is a full copy of the source
    // database's bytes for as long as the handle stays open. Unlike
    // sql.js/exceljs (which never touch disk), that copy would otherwise be
    // readable by any other local user.
    fs.writeFileSync(tempFilePath, bytes, { mode: 0o600 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: { type: 'DuckdbError', code: 'OpenFailed', message } };
  }

  let instance: DuckDBInstance;
  try {
    instance = await DuckDBInstance.create(tempFilePath, { access_mode: 'READ_ONLY' });
  } catch (err) {
    try {
      fs.unlinkSync(tempFilePath);
    } catch {
      // best-effort cleanup -- a leaked temp file isn't worth failing the caller over
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: { type: 'DuckdbError', code: 'OpenFailed', message } };
  }

  try {
    const connection = await instance.connect();
    return {
      connection,
      tempFilePath,
      close: () => {
        try {
          connection.closeSync();
        } catch {
          // best-effort -- nothing more to do if the connection is already gone
        }
        try {
          instance.closeSync();
        } catch {
          // best-effort, same as above
        }
        try {
          fs.unlinkSync(tempFilePath);
        } catch {
          // best-effort cleanup -- a leaked temp file isn't worth failing the caller over
        }
      },
    };
  } catch (err) {
    // instance.connect() failed after create() already succeeded -- close
    // the instance itself here (not just the temp file), otherwise it's a
    // native handle leaked for the process's lifetime since no `close()`
    // was ever handed back to the caller to do it.
    try {
      instance.closeSync();
    } catch {
      // best-effort, as above
    }
    try {
      fs.unlinkSync(tempFilePath);
    } catch {
      // best-effort, as above
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: { type: 'DuckdbError', code: 'OpenFailed', message } };
  }
}

/** Lists user tables and views in the database's main schema. */
export async function listDuckdbTables(handle: DuckdbHandle): Promise<TableRef[]> {
  const reader = await handle.connection.runAndReadAll(
    `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name ASC`
  );
  return reader.getRowsJson().map((row) => ({
    name: String(row[0]),
    type: row[1] === 'VIEW' ? 'view' : 'table',
  }));
}

/** Reads one table/view's contents, honoring `maxRowsInput` the same way CSV/Parquet/SQLite/XLSX do. */
export async function readDuckdbTable(
  handle: DuckdbHandle,
  tableName: string,
  maxRowsInput?: number
): Promise<ParsedTable> {
  const maxRows = clampMaxRows(maxRowsInput);
  const quoted = quoteIdentifier(tableName);

  const countReader = await handle.connection.runAndReadAll(`SELECT COUNT(*) FROM ${quoted}`);
  const totalRowCount = Number(countReader.getRowsJson()[0]?.[0] ?? 0);

  const selectSql =
    maxRows != null ? `SELECT * FROM ${quoted} LIMIT ${maxRows}` : `SELECT * FROM ${quoted}`;
  const reader = await handle.connection.runAndReadAll(selectSql);
  const headers = reader.columnNames();
  const rows = reader.getRowsJson().map((row) => row.map(stringifyDuckdbCell));

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
 * result in the `MultiTableData` shape shared by every multi-table source --
 * mirrors sqliteParser.ts's/xlsxParser.ts's readSelectedTable/readSelectedSheet.
 */
export async function readSelectedTable(
  handle: DuckdbHandle,
  tables: TableRef[],
  desiredTable: string | undefined,
  maxRowsInput?: number
): Promise<MultiTableData> {
  if (tables.length === 0) {
    return { tables: [], selectedTable: '', data: emptyParsedTable() };
  }
  const target =
    desiredTable && tables.some((t) => t.name === desiredTable) ? desiredTable : tables[0].name;
  const data = await readDuckdbTable(handle, target, maxRowsInput);
  return { tables, selectedTable: target, data };
}

/**
 * One-shot convenience wrapper used by tests and any caller that doesn't
 * need to keep the database open across multiple table selections. The
 * editor provider keeps its own long-lived `DuckdbHandle` instead (see
 * duckdbEditorProvider.ts) so switching tables re-queries the already-open
 * database rather than re-opening it (and re-writing its temp file) on
 * every selection.
 */
export async function parseDuckdb(
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

  const opened = await openDuckdbDatabase(bytes);
  if ('error' in opened) {
    return { success: false, errors: [opened.error] };
  }

  try {
    const tables = await listDuckdbTables(opened);
    const data = await readSelectedTable(opened, tables, selectedTable, maxRowsInput);
    return { success: true, data, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, errors: [{ type: 'DuckdbError', code: 'ReadFailed', message }] };
  } finally {
    opened.close();
  }
}

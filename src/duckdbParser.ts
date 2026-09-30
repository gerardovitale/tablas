import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BIGINT,
  DOUBLE,
  DuckDBInstance,
  DuckDBTypeId,
  type DuckDBConnection,
  type Json,
} from '@duckdb/node-api';
import {
  clipStat,
  histogramFromCounts,
  planHistogram,
  reportStatsFailure,
  skippedStats,
  StatsCache,
  STATS_TIMED_OUT_REASON,
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

// One connection serves a whole document, and `connection.interrupt()` (used
// to cap a runaway stats query) is connection-wide: it kills whatever query
// happens to be running. Users can switch tables faster than stats finish, so
// every operation that touches the connection is queued per handle -- an
// interrupt then only ever hits the stats query that armed it.
const queues = new WeakMap<DuckdbHandle, Promise<void>>();

/**
 * Runs `fn` once every earlier `runExclusive` call on this handle has settled
 * (successfully or not), and resolves/rejects with `fn`'s own outcome. Never
 * nest calls on the same handle: the inner one would wait on the outer forever.
 */
export function runExclusive<T>(handle: DuckdbHandle, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(handle) ?? Promise.resolve();
  const run = previous.then(fn);
  queues.set(handle, run.then(() => undefined, () => undefined));
  return run;
}

/** Lists user tables and views in the database's main schema. */
export function listDuckdbTables(handle: DuckdbHandle): Promise<TableRef[]> {
  return runExclusive(handle, async () => {
    const reader = await handle.connection.runAndReadAll(
      `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name ASC`
    );
    return reader.getRowsJson().map((row) => ({
      name: String(row[0]),
      type: row[1] === 'VIEW' ? ('view' as const) : ('table' as const),
    }));
  });
}

/** Column kind implied by DuckDB's own type system (no value inference needed). */
function duckdbKind(typeId: DuckDBTypeId): ColumnKind {
  switch (typeId) {
    case DuckDBTypeId.TINYINT:
    case DuckDBTypeId.SMALLINT:
    case DuckDBTypeId.INTEGER:
    case DuckDBTypeId.BIGINT:
    case DuckDBTypeId.UTINYINT:
    case DuckDBTypeId.USMALLINT:
    case DuckDBTypeId.UINTEGER:
    case DuckDBTypeId.UBIGINT:
    case DuckDBTypeId.HUGEINT:
    case DuckDBTypeId.UHUGEINT:
      return 'integer';
    case DuckDBTypeId.FLOAT:
    case DuckDBTypeId.DOUBLE:
    case DuckDBTypeId.DECIMAL:
      return 'float';
    case DuckDBTypeId.BOOLEAN:
      return 'boolean';
    case DuckDBTypeId.DATE:
    case DuckDBTypeId.TIME:
    case DuckDBTypeId.TIME_TZ:
    case DuckDBTypeId.TIME_NS:
    case DuckDBTypeId.TIMESTAMP:
    case DuckDBTypeId.TIMESTAMP_S:
    case DuckDBTypeId.TIMESTAMP_MS:
    case DuckDBTypeId.TIMESTAMP_NS:
    case DuckDBTypeId.TIMESTAMP_TZ:
      return 'date';
    case DuckDBTypeId.VARCHAR:
    case DuckDBTypeId.ENUM:
    case DuckDBTypeId.UUID:
      return 'text';
    default:
      return 'other'; // BLOB, INTERVAL, LIST, STRUCT, MAP, ARRAY, UNION, BIT, ...
  }
}

// Aggregates selected per column, in the order buildDuckdbColumn reads them.
// Unused slots are selected as NULL so every column has the same layout.
const DUCKDB_STATS_VALUES_PER_COLUMN = 7;

// Handles are read-only for the document's lifetime, so asking again for an
// already-computed table's stats -- including one that timed out or failed --
// reuses the answer instead of re-scanning.
const statsCache = new StatsCache<DuckdbHandle>();

function statsSelectList(quotedColumn: string, typeId: DuckDBTypeId): string[] {
  const kind = duckdbKind(typeId);
  const isNumeric = kind === 'integer' || kind === 'float';
  const isFloating = typeId === DuckDBTypeId.FLOAT || typeId === DuckDBTypeId.DOUBLE;
  const x = `CAST(${quotedColumn} AS DOUBLE)`;
  // FLOAT/DOUBLE extremes come back as numbers and are formatted with
  // String() so they match the table cell text (CAST AS VARCHAR gives "10.0").
  const wantsTextExtremes = kind !== 'other' && kind !== 'boolean' && !isFloating;
  return [
    `COUNT(${quotedColumn})`,
    kind === 'other' ? 'NULL' : `COUNT(DISTINCT ${quotedColumn})`,
    wantsTextExtremes ? `CAST(MIN(${quotedColumn}) AS VARCHAR)` : 'NULL',
    wantsTextExtremes ? `CAST(MAX(${quotedColumn}) AS VARCHAR)` : 'NULL',
    isNumeric ? `AVG(${x}) FILTER (WHERE isfinite(${x}))` : 'NULL',
    isNumeric ? `MIN(${x}) FILTER (WHERE isfinite(${x}))` : 'NULL',
    isNumeric ? `MAX(${x}) FILTER (WHERE isfinite(${x}))` : 'NULL',
  ];
}

async function buildDuckdbColumn(
  handle: DuckdbHandle,
  quotedTable: string,
  quotedColumn: string,
  typeId: DuckDBTypeId,
  total: number,
  agg: readonly Json[]
): Promise<ColumnStats> {
  const [nonNullRaw, distinctRaw, minText, maxText, avgRaw, loRaw, hiRaw] = agg;
  const kind = duckdbKind(typeId);
  const stats: ColumnStats = { type: kind, nullCount: total - Number(nonNullRaw ?? 0) };
  if (kind === 'other') {
    return stats;
  }
  stats.distinctCount = Number(distinctRaw ?? 0);

  if (kind === 'text' || kind === 'date') {
    if (typeof minText === 'string' && typeof maxText === 'string') {
      stats.min = clipStat(minText);
      stats.max = clipStat(maxText);
    }
  } else if ((kind === 'integer' || kind === 'float') && typeof loRaw === 'number' && typeof hiRaw === 'number') {
    const isFloating = typeId === DuckDBTypeId.FLOAT || typeId === DuckDBTypeId.DOUBLE;
    stats.min = typeof minText === 'string' && !isFloating ? minText : String(loRaw);
    stats.max = typeof maxText === 'string' && !isFloating ? maxText : String(hiRaw);
    if (typeof avgRaw === 'number' && Number.isFinite(avgRaw)) {
      stats.mean = avgRaw;
    }
    const plan = planHistogram(loRaw, hiRaw, kind === 'integer');
    if (plan) {
      const x = `CAST(${quotedColumn} AS DOUBLE)`;
      // LEAST clamps the max value into the last bin, mirroring
      // columnStats.bucketIndex. GROUP BY/ORDER BY use ordinals: an alias
      // could collide with a user column of the same name. The bounds are
      // bound as explicit DOUBLEs: node-api would otherwise turn a whole
      // number like a HUGEINT column's max into an int64 and reject it.
      const reader = await handle.connection.runAndReadAll(
        `SELECT LEAST(CAST(FLOOR((${x} - ?) / ?) AS BIGINT), ?), COUNT(*) FROM ${quotedTable} ` +
          `WHERE isfinite(${x}) GROUP BY 1 ORDER BY 1`,
        [plan.lo, plan.width, plan.bins - 1],
        [DOUBLE, DOUBLE, BIGINT]
      );
      stats.histogram = histogramFromCounts(
        plan,
        reader.getRowsJson().map((row) => [Number(row[0]), Number(row[1])] as const)
      );
    }
  }
  return stats;
}

/** The uncached work behind `duckdbTableStats`; may throw (including on interrupt). */
async function computeDuckdbStats(handle: DuckdbHandle, tableName: string): Promise<TableStats | undefined> {
  const quotedTable = quoteIdentifier(tableName);
  // Column names and types come from a zero-row read, which still carries
  // the full result schema.
  const schemaReader = await handle.connection.runAndReadAll(`SELECT * FROM ${quotedTable} LIMIT 0`);
  const headers = schemaReader.columnNames();
  if (headers.length === 0) {
    return undefined;
  }
  const typeIds = headers.map((_, i) => schemaReader.columnTypeId(i));

  const quotedColumns = headers.map(quoteIdentifier);
  const selectList = quotedColumns.flatMap((q, i) => statsSelectList(q, typeIds[i]));
  const aggReader = await handle.connection.runAndReadAll(
    `SELECT COUNT(*), ${selectList.join(', ')} FROM ${quotedTable}`
  );
  const row = aggReader.getRowsJson()[0];
  if (!row) {
    return undefined;
  }
  const total = Number(row[0]);
  const columns: ColumnStats[] = [];
  for (let i = 0; i < headers.length; i++) {
    const offset = 1 + i * DUCKDB_STATS_VALUES_PER_COLUMN;
    columns.push(
      await buildDuckdbColumn(
        handle,
        quotedTable,
        quotedColumns[i],
        typeIds[i],
        total,
        row.slice(offset, offset + DUCKDB_STATS_VALUES_PER_COLUMN)
      )
    );
  }
  return { columns };
}

/**
 * Whole-table column statistics via SQL push-down (regardless of
 * `tablas.maxRows`): one aggregate scan plus one small bucket query per
 * numeric column. Computed on demand -- when the user first opens the
 * Statistics view. DuckDB is native and async so it doesn't block the
 * extension host the way sql.js would, but a pathological table could still
 * run long, hence a wall-clock budget enforced with `connection.interrupt()`
 * (safe because `runExclusive` guarantees nothing else is running); hitting it
 * yields a `skippedStats` result. `undefined` = no stats (no columns, or a
 * failure, reported through `statsHooks`); it never throws. Every outcome,
 * timeouts and failures included, is remembered per handle so re-selecting
 * the table doesn't repeat an expensive attempt.
 */
export function duckdbTableStats(handle: DuckdbHandle, tableName: string): Promise<TableStats | undefined> {
  return runExclusive(handle, async () => {
    const cached = statsCache.lookup(handle, tableName);
    if (cached.hit) {
      return cached.stats;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      handle.connection.interrupt();
    }, statsLimits.duckdbTimeoutMs);
    let stats: TableStats | undefined;
    try {
      stats = await computeDuckdbStats(handle, tableName);
    } catch (err) {
      if (timedOut) {
        stats = skippedStats(STATS_TIMED_OUT_REASON);
      } else {
        reportStatsFailure(err);
      }
    } finally {
      clearTimeout(timer);
    }
    statsCache.store(handle, tableName, stats);
    return stats;
  });
}

/** Reads one table/view's contents, honoring `maxRowsInput` the same way CSV/Parquet/SQLite/XLSX do. */
export function readDuckdbTable(
  handle: DuckdbHandle,
  tableName: string,
  maxRowsInput?: number
): Promise<ParsedTable> {
  return runExclusive(handle, async () => {
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
  });
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

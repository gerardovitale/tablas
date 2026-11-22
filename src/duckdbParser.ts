import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BIGINT,
  DOUBLE,
  DuckDBInstance,
  DuckDBTypeId,
  JsonDuckDBValueConverter,
  StatementType,
  VARCHAR,
  version,
  type DuckDBConnection,
  type DuckDBDataChunk,
  type DuckDBResult,
  type DuckDBType,
  type Json,
} from '@duckdb/node-api';
import {
  clipNativeType,
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
  hasUnknownColumn,
  filterLimits,
  ISO_DATE_PREFIX_PATTERN,
  ISO_DAY_LENGTH,
  isIsoDateOperand,
  NUMBER_PATTERN,
  parseNumber,
  FILTER_FAILED_REASON,
  FILTER_TIMED_OUT_REASON,
  FILTER_UNKNOWN_COLUMN_REASON,
  reportFilterFailure,
  type ColumnFilterSpec,
  type CompareOp,
  type FilterOutcome,
} from './filter';
import { RESULT_GONE_REASON, type QueryOutcome } from './queryMessage';
import {
  clampMaxRows,
  MAIN_SCHEMA,
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
 * The copy lives in its own private folder and keeps the *source file's name*
 * (see `tempCopyName`: DuckDB derives the catalog name from it, and views can
 * hard-code that catalog). `DuckdbHandle.close()` deletes the folder alongside
 * closing the connection/instance, so every caller that opens a handle also
 * owns cleaning up its temp copy.
 *
 * Known residual limitation: cleanup only happens if `close()` actually
 * runs. If the extension host process is killed (crash, forced quit)
 * between `openDuckdbDatabase` and disposal, the temp folder -- holding a full
 * copy of the source database's bytes -- is orphaned in `os.tmpdir()`. The
 * folder (mode 0700) and file (0600) limit who can read it while it exists,
 * but don't make it self-cleaning; OS temp-dir reaping is the only
 * backstop. SQLite/XLSX don't have this exposure at all, since they never
 * write the source bytes to disk in the first place.
 */
export interface DuckdbHandle {
  readonly connection: DuckDBConnection;
  readonly tempFilePath: string;
  close(): void;
}

/** Used when the caller does not say what the source file is called. */
const DEFAULT_TEMP_NAME = 'database.duckdb';

/**
 * The file name of the temp copy. It is the *source file's own name*, not a random
 * one: DuckDB names a database's catalog after its file, and a view can hard-code
 * that catalog (dbt-duckdb writes `"warehouse"."main"."stg_orders"` into view SQL
 * for a file called `warehouse.duckdb`). A copy called `tablas-1a2b.duckdb` has a
 * different catalog, so such a view fails with `schema "warehouse.main" does not
 * exist`. Characters a file name cannot hold are replaced, so any name is safe.
 */
function tempCopyName(fileName: string | undefined): string {
  const cleaned = Array.from(fileName ?? '')
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .trim();
  return cleaned === '' || cleaned.startsWith('.') ? DEFAULT_TEMP_NAME : cleaned.slice(0, 200);
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
 * DuckDB's message when the file's storage version is newer than the bundled
 * engine understands. Only the closing sentence tells newer from older: the
 * "version number N, but we can only read ..." line is the same for a file too
 * old to read, which an update would not help. ("... version number 999, but we can only read versions
 * between 64 and 68. The database file was created with an newer version of
 * DuckDB."). Storage is backward- but not forward-compatible, so the only
 * fixes are a newer engine (update Tablas) or re-saving the file for an older
 * one -- neither is obvious from DuckDB's raw text, which reads like a
 * corrupt file.
 */
const NEWER_STORAGE_PATTERN = /created with an? newer version of DuckDB/i;

/**
 * Turns a `DuckDBInstance.create` failure message into what the user sees.
 * A newer-storage-version failure gets an actionable hint naming the bundled
 * engine version, with DuckDB's own text kept underneath; anything else is
 * returned unchanged. Pure so it can be unit-tested without a native open.
 */
export function describeDuckdbOpenError(message: string, bundledVersion: string): string {
  if (!NEWER_STORAGE_PATTERN.test(message)) {
    return message;
  }
  return (
    `This file was written by a newer DuckDB than the one built into Tablas ` +
    `(DuckDB ${bundledVersion}). Update Tablas, or re-save the file with an older ` +
    `storage_compatibility_version.\n\n${message}`
  );
}

/**
 * Views often read files by a relative path (`read_parquet('../data/*.parquet')`).
 * The database is opened from a temp copy, so DuckDB would resolve those
 * against the extension host's working directory and find nothing. Pointing
 * `file_search_path` at the source file's folder makes them resolve next to the
 * original. Best effort: a failure here must not stop the file from opening.
 * `file_search_path` is a comma-separated list, so a folder with a comma in its
 * name is skipped rather than split.
 */
async function applyFileSearchPath(connection: DuckDBConnection, searchDir: string | undefined): Promise<void> {
  if (!searchDir || searchDir.includes(',')) {
    return;
  }
  try {
    await connection.run(`SET file_search_path = '${searchDir.replace(/'/g, "''")}'`);
  } catch {
    // best-effort, as described above
  }
}

/**
 * Opens a DuckDB database from raw file bytes by writing them to a temp
 * file and opening that read-only (see the module comment above). No
 * magic-byte pre-check, unlike SQLite's 16-byte sniff / XLSX's 2-byte ZIP
 * sniff -- DuckDB's own open call already rejects a non-database file with
 * a clear error, so hand-rolling a header check here would just duplicate
 * that validation. `options.searchDir` is where relative file paths inside
 * views resolve (see `applyFileSearchPath`); `options.fileName` is the source
 * file's name, which the temp copy keeps so the database's catalog name is the
 * same (see `tempCopyName`). The one failure it does reword is a file from a
 * newer DuckDB than the bundled engine (see `describeDuckdbOpenError`).
 */
export async function openDuckdbDatabase(
  bytes: Uint8Array,
  options: { searchDir?: string; fileName?: string } = {}
): Promise<DuckdbHandle | { error: ParseError }> {
  // A private folder per open (mode 0700, from mkdtemp), holding the copy under the
  // source file's name. os.tmpdir() is shared and world-readable on a multi-user
  // machine, and this is a full copy of the source database for as long as the
  // handle stays open; unlike sql.js/exceljs, which never touch disk, it would
  // otherwise be readable by any other local user (the file is 0600 as well).
  let tempDir: string | undefined;
  const removeTemp = (): void => {
    if (tempDir === undefined) {
      return;
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup -- a leaked temp folder isn't worth failing the caller over
    }
  };
  let tempFilePath: string;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-db-'));
    tempFilePath = path.join(tempDir, tempCopyName(options.fileName));
    fs.writeFileSync(tempFilePath, bytes, { mode: 0o600 });
  } catch (err) {
    removeTemp();
    const message = err instanceof Error ? err.message : String(err);
    return { error: { type: 'DuckdbError', code: 'OpenFailed', message } };
  }

  let instance: DuckDBInstance;
  try {
    instance = await DuckDBInstance.create(tempFilePath, { access_mode: 'READ_ONLY' });
  } catch (err) {
    removeTemp();
    const raw = err instanceof Error ? err.message : String(err);
    const message = describeDuckdbOpenError(raw, version());
    return { error: { type: 'DuckdbError', code: 'OpenFailed', message } };
  }

  try {
    const connection = await instance.connect();
    await applyFileSearchPath(connection, options.searchDir);
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
        removeTemp();
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
    removeTemp();
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

// The table list of each handle, by `TableRef.name`. A handle is a snapshot of
// one file's bytes, so its list never changes; the SQL builders below look a
// name up here to know which schema it lives in. A name that was never listed
// (a caller that skipped `listDuckdbTables`) is a bare `main` table.
const tableRefs = new WeakMap<DuckdbHandle, Map<string, TableRef>>();
// And the list itself: stats and filter requests list the tables just to check
// a name is known, which must not re-run the catalog join every time.
const tableLists = new WeakMap<DuckdbHandle, TableRef[]>();

/**
 * The query result a handle keeps as a TEMP table (see `duckdbRunQuery`): the
 * newest one only, since the box shows one result at a time. `seq` is the
 * `run-query` that made it, which is how the webview addresses it; `sqlName` is
 * the table's unique name (also its stats-cache key) and `quoted` how SQL refers
 * to it. Temp tables go away with the connection, so a reload's handle swap
 * drops the old result by itself and the new handle starts with none.
 */
interface ResultTable {
  seq: number;
  sqlName: string;
  quoted: string;
}
const resultTables = new WeakMap<DuckdbHandle, ResultTable>();

/** `"schema"."table"` for a table outside `main`, else `"table"`; see `tableRefs`. */
function quotedTableName(handle: DuckdbHandle, name: string): string {
  const ref = tableRefs.get(handle)?.get(name);
  return ref?.schema !== undefined
    ? `${quoteIdentifier(ref.schema)}.${quoteIdentifier(ref.table ?? name)}`
    : quoteIdentifier(name);
}


/**
 * Lists the user tables and views of every schema in the database (not
 * `information_schema` / `pg_catalog`; dbt keeps models in schemas such as
 * `staging` or `main_marts`), `main` first, then by schema and name. Tables
 * in `main` keep their bare name, so a name stays valid however many other
 * schemas the file gains; the rest are `schema.table`. `approxRows` comes from
 * `duckdb_tables()` (no scan) and is left out for views.
 */
export function listDuckdbTables(handle: DuckdbHandle): Promise<TableRef[]> {
  // Still through the queue when cached: a caller that lists first and checks
  // whether it was overtaken (the filter's `seq` check) relies on that wait.
  return runExclusive(handle, async () => {
    const cached = tableLists.get(handle);
    if (cached) {
      return cached;
    }
    const reader = await handle.connection.runAndReadAll(
      `SELECT t.table_schema, t.table_name, t.table_type, d.estimated_size
       FROM information_schema.tables t
       LEFT JOIN duckdb_tables() d
         ON d.database_name = t.table_catalog AND d.schema_name = t.table_schema AND d.table_name = t.table_name
       WHERE t.table_catalog = current_database() AND t.table_schema NOT IN ('information_schema', 'pg_catalog')
       ORDER BY (t.table_schema = '${MAIN_SCHEMA}') DESC, t.table_schema ASC, t.table_name ASC`
    );
    const refs = reader.getRowsJson().map((row): TableRef => {
      const schema = String(row[0]);
      const table = String(row[1]);
      const size = row[3] === null || row[3] === undefined ? NaN : Number(row[3]);
      return {
        name: schema === MAIN_SCHEMA ? table : `${schema}.${table}`,
        type: row[2] === 'VIEW' ? 'view' : 'table',
        ...(schema !== MAIN_SCHEMA && { schema, table }),
        ...(Number.isFinite(size) && size >= 0 && { approxRows: size }),
      };
    });
    tableRefs.set(handle, new Map(refs.map((ref) => [ref.name, ref])));
    tableLists.set(handle, refs);
    return refs;
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
async function computeDuckdbStats(handle: DuckdbHandle, quotedTable: string): Promise<TableStats | undefined> {
  // Column names and types come from a zero-row read, which still carries
  // the full result schema.
  const schemaReader = await handle.connection.runAndReadAll(`SELECT * FROM ${quotedTable} LIMIT 0`);
  const headers = schemaReader.columnNames();
  if (headers.length === 0) {
    return undefined;
  }
  const typeIds = headers.map((_, i) => schemaReader.columnTypeId(i));
  const nativeTypes = headers.map((_, i) => clipNativeType(schemaReader.columnType(i).toString()));

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
    const column = await buildDuckdbColumn(
      handle,
      quotedTable,
      quotedColumns[i],
      typeIds[i],
      total,
      row.slice(offset, offset + DUCKDB_STATS_VALUES_PER_COLUMN)
    );
    if (nativeTypes[i] !== '') {
      column.nativeType = nativeTypes[i];
    }
    columns.push(column);
  }
  return { columns };
}

/**
 * Whole-table column statistics via SQL push-down (regardless of
 * `tablas.maxRows`): one aggregate scan plus one small bucket query per
 * numeric column. Computed on request -- the webview asks right after it
 * renders each table. DuckDB is native and async so it doesn't block the
 * extension host the way sql.js would, but a pathological table could still
 * run long, hence a wall-clock budget enforced with `connection.interrupt()`
 * (safe because `runExclusive` guarantees nothing else is running); hitting it
 * yields a `skippedStats` result. `undefined` = no stats (no columns, or a
 * failure, reported through `statsHooks`); it never throws. Every outcome,
 * timeouts and failures included, is remembered per handle so re-selecting
 * the table doesn't repeat an expensive attempt.
 */
export function duckdbTableStats(handle: DuckdbHandle, tableName: string): Promise<TableStats | undefined> {
  return statsFor(handle, () => ({ key: tableName, quoted: quotedTableName(handle, tableName) }));
}

/**
 * `duckdbTableStats` for the query result kept under `resultSeq` (see
 * `duckdbRunQuery`); `undefined` if that result is gone. Cached under the result
 * table's own unique name, so a later run never inherits it.
 */
export function duckdbResultStats(handle: DuckdbHandle, resultSeq: number): Promise<TableStats | undefined> {
  return statsFor(handle, () => {
    const result = resultTables.get(handle);
    return result && result.seq === resultSeq ? { key: result.sqlName, quoted: result.quoted } : undefined;
  });
}

/** `resolve` runs inside the queue, so a result dropped while this waited is seen as gone. */
function statsFor(
  handle: DuckdbHandle,
  resolve: () => { key: string; quoted: string } | undefined
): Promise<TableStats | undefined> {
  return runExclusive(handle, async () => {
    const target = resolve();
    if (!target) {
      return undefined;
    }
    const cached = statsCache.lookup(handle, target.key);
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
      stats = await computeDuckdbStats(handle, target.quoted);
    } catch (err) {
      if (timedOut) {
        stats = skippedStats(STATS_TIMED_OUT_REASON);
      } else {
        reportStatsFailure(err);
      }
    } finally {
      clearTimeout(timer);
    }
    statsCache.store(handle, target.key, stats);
    return stats;
  });
}

// ── Column filtering ────────────────────────────────────────────────────

const COMPARE_SQL: Record<CompareOp, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=' };

/**
 * SQL for a cell's text, matching what the table shows. Whole-number
 * FLOAT/DOUBLE values are printed without ".0" (DuckDB's CAST prints "10.0",
 * the table shows "10"), so `=10` finds them. Known remaining differences,
 * where DuckDB's own text form is used: non-whole FLOAT (32-bit) values, and
 * nested (LIST/STRUCT/MAP) and BLOB columns; DOUBLEs of magnitude >= 1e15 or
 * < 1e-6 (DuckDB prints `1e+15`, JS prints `1000000000000000`). Numeric
 * comparisons are not affected. Also unlike JS, SQL `trim()` strips only
 * spaces, so tab/newline/NBSP padding is not treated as blank.
 */
function filterTextExpr(column: string, typeId: DuckDBTypeId): string {
  if (typeId === DuckDBTypeId.FLOAT || typeId === DuckDBTypeId.DOUBLE) {
    const x = `CAST(${column} AS DOUBLE)`;
    return (
      `CASE WHEN ${column} IS NULL THEN '' ` +
      `WHEN isfinite(${x}) AND ${x} = floor(${x}) AND abs(${x}) < 1e15 THEN CAST(CAST(${x} AS BIGINT) AS VARCHAR) ` +
      `ELSE CAST(${column} AS VARCHAR) END`
    );
  }
  return `COALESCE(CAST(${column} AS VARCHAR), '')`;
}

/**
 * One filter as a SQL boolean. Every user-supplied value is appended to
 * `params`/`types` (positionally, in the order its `?` appears) -- none is
 * spliced into the SQL text. Mirrors `compileCellPredicate` in filter.ts.
 */
function filterPredicateSql(
  spec: ColumnFilterSpec,
  typeId: DuckDBTypeId,
  params: Array<string | number>,
  types: DuckDBType[]
): string {
  const column = `c${spec.column}`;
  const text = filterTextExpr(column, typeId);
  const { op, value } = spec.filter;
  switch (op) {
    case 'contains':
    case 'notContains':
      params.push(value.toLowerCase());
      types.push(VARCHAR);
      return `${op === 'notContains' ? 'NOT ' : ''}contains(lower(${text}), ?)`;
    case 'equals':
    case 'notEquals':
      params.push(value);
      types.push(VARCHAR);
      return `${text} ${op === 'equals' ? '=' : '<>'} ?`;
    case 'empty':
      return `trim(${text}) = ''`;
    case 'notEmpty':
      return `trim(${text}) <> ''`;
    default: {
      const symbol = COMPARE_SQL[op];
      const operand = parseNumber(value);
      if (operand === undefined) {
        if (isIsoDateOperand(value)) {
          // Day compare: only cells starting with an ISO day take part, compared
          // by their first ISO_DAY_LENGTH characters (DATE prints '2024-01-01',
          // TIMESTAMP '2024-01-01 10:30:00'). NULL is '' here, which fails the
          // prefix test. Mirrors the date branch of `compileCellPredicate`.
          params.push(ISO_DATE_PREFIX_PATTERN, value);
          types.push(VARCHAR, VARCHAR);
          return `(regexp_matches(${text}, ?) AND left(${text}, ${ISO_DAY_LENGTH}) ${symbol} ?)`;
        }
        // Plain string compare for any other non-number operand; empty cells never match.
        params.push(value);
        types.push(VARCHAR);
        return `(trim(${text}) <> '' AND ${text} ${symbol} ?)`;
      }
      const kind = duckdbKind(typeId);
      if (kind === 'integer' || kind === 'float') {
        const x = `CAST(${column} AS DOUBLE)`;
        params.push(operand);
        types.push(DOUBLE);
        return `(isfinite(${x}) AND ${x} ${symbol} ?)`;
      }
      // Any other column: only cells whose text is a number take part.
      const trimmed = `trim(${text})`;
      const cast = `TRY_CAST(${trimmed} AS DOUBLE)`;
      params.push(NUMBER_PATTERN, operand);
      types.push(VARCHAR, DOUBLE);
      return `(regexp_full_match(${trimmed}, ?) AND isfinite(${cast}) AND ${cast} ${symbol} ?)`;
    }
  }
}

/**
 * Filters one table/view across all of its rows (regardless of
 * `tablas.maxRows`) with a native SQL `WHERE`: up to `maxRows` matching rows
 * plus the exact match count (two queries, one `COUNT(*)` and one `LIMIT`).
 * Runs under `runExclusive` with the same wall-clock budget mechanism as
 * stats (`filterLimits.duckdbTimeoutMs`, enforced with `interrupt()`); hitting
 * it yields a `failedReason`. Never throws.
 *
 * Columns are renamed to `c0..cN` (`FROM "t" AS s(c0, ...)`) so the SQL never
 * depends on user-visible names. See `filterTextExpr` for where the text DuckDB
 * filters on can differ from the table's cell text.
 */
export function duckdbTableFilter(
  handle: DuckdbHandle,
  tableName: string,
  specs: readonly ColumnFilterSpec[],
  maxRows: number
): Promise<FilterOutcome> {
  return filterFor(handle, () => quotedTableName(handle, tableName), specs, maxRows);
}

/**
 * `duckdbTableFilter` for the query result kept under `resultSeq`: the same SQL
 * over the result's table, so a filter means the same thing as on a real table.
 * A result that is gone yields a `failedReason`.
 */
export function duckdbResultFilter(
  handle: DuckdbHandle,
  resultSeq: number,
  specs: readonly ColumnFilterSpec[],
  maxRows: number
): Promise<FilterOutcome> {
  return filterFor(
    handle,
    () => {
      const result = resultTables.get(handle);
      return result && result.seq === resultSeq ? result.quoted : undefined;
    },
    specs,
    maxRows
  );
}

/** `resolve` runs inside the queue, so a result dropped while this waited is seen as gone. */
function filterFor(
  handle: DuckdbHandle,
  resolve: () => string | undefined,
  specs: readonly ColumnFilterSpec[],
  maxRows: number
): Promise<FilterOutcome> {
  return runExclusive(handle, async (): Promise<FilterOutcome> => {
    const quotedTable = resolve();
    if (quotedTable === undefined) {
      return { failedReason: RESULT_GONE_REASON };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      handle.connection.interrupt();
    }, filterLimits.duckdbTimeoutMs);
    try {
      const schemaReader = await handle.connection.runAndReadAll(`SELECT * FROM ${quotedTable} LIMIT 0`);
      const headers = schemaReader.columnNames();
      if (headers.length === 0 || hasUnknownColumn(specs, headers.length)) {
        return { failedReason: FILTER_UNKNOWN_COLUMN_REASON };
      }
      const typeIds = headers.map((_, i) => schemaReader.columnTypeId(i));

      const params: Array<string | number> = [];
      const types: DuckDBType[] = [];
      const where = specs.map((spec) => filterPredicateSql(spec, typeIds[spec.column], params, types)).join(' AND ');
      const aliases = headers.map((_, i) => `c${i}`).join(', ');
      const from = `${quotedTable} AS s(${aliases})${where ? ` WHERE ${where}` : ''}`;

      const countReader = await handle.connection.runAndReadAll(
        `SELECT COUNT(*) FROM ${from}`,
        params,
        types
      );
      const matchCount = Number(countReader.getRowsJson()[0]?.[0] ?? 0);
      if (matchCount === 0) {
        return { rows: [], matchCount };
      }
      const limit = clampMaxRows(maxRows);
      const rowsReader = await handle.connection.runAndReadAll(
        `SELECT * FROM ${from}${limit !== undefined && Number.isFinite(limit) ? ` LIMIT ${limit}` : ''}`,
        params,
        types
      );
      return { rows: rowsReader.getRowsJson().map((row) => row.map(stringifyDuckdbCell)), matchCount };
    } catch (err) {
      if (timedOut) {
        return { failedReason: FILTER_TIMED_OUT_REASON };
      }
      reportFilterFailure(err);
      return { failedReason: FILTER_FAILED_REASON };
    } finally {
      clearTimeout(timer);
    }
  });
}

/** Limits for the read-only SQL box (mutable so tests can drive the timeout and length paths). */
export const queryLimits = {
  /** Wall-clock budget per query, enforced with `connection.interrupt()`. */
  duckdbTimeoutMs: 30_000,
  /** Longest query text accepted; the webview's textarea carries the same `maxlength`. */
  maxSqlLength: 100_000,
  /**
   * Most rows a result keeps as a table (the first ones; at least `tablas.maxRows`). Statistics and
   * filters cover that table, so beyond it they cover "the first N rows". A constant, not a setting:
   * workspace settings can come from an untrusted repo (see `MAX_ROWS_CEILING`).
   */
  maxResultRows: 100_000,
};

/** The result table's columns are renamed `c0..cN`, so duplicate or odd result names cannot break the DDL. */
function resultColumnDefinitions(types: readonly DuckDBType[]): string {
  return types.map((type, i) => `c${i} ${type.toString()}`).join(', ');
}

/**
 * Keeps the rows of a finished stream as a new TEMP table and makes it the
 * handle's current result (the previous one is dropped only after this one
 * exists, so a failure here leaves the old result usable). `chunks` hold at most
 * `limit` rows once trimmed. Returns the registered table, or `undefined` when no
 * table could be made (a type whose `toString()` is not valid DDL): the caller
 * then shows the rows without statistics or filters.
 */
async function materializeResult(
  handle: DuckdbHandle,
  seq: number,
  types: readonly DuckDBType[],
  chunks: readonly DuckDBDataChunk[]
): Promise<ResultTable | undefined> {
  const sqlName = `__tablas_result_${crypto.randomBytes(4).toString('hex')}_${seq}`;
  const quoted = `temp.main.${quoteIdentifier(sqlName)}`;
  try {
    await handle.connection.run(`CREATE TEMP TABLE ${quoteIdentifier(sqlName)} (${resultColumnDefinitions(types)})`);
  } catch {
    return undefined;
  }
  try {
    const appender = await handle.connection.createAppender(sqlName, 'main', 'temp');
    try {
      for (const chunk of chunks) {
        appender.appendDataChunk(chunk);
      }
    } finally {
      appender.closeSync();
    }
  } catch {
    await handle.connection.run(`DROP TABLE IF EXISTS ${quoted}`).catch(() => undefined);
    return undefined;
  }
  const previous = resultTables.get(handle);
  const created: ResultTable = { seq, sqlName, quoted };
  resultTables.set(handle, created);
  if (previous) {
    await handle.connection.run(`DROP TABLE IF EXISTS ${previous.quoted}`).catch(() => undefined);
  }
  return created;
}

/**
 * Forgets the result kept under `seq` (the webview stopped showing it) and drops
 * its table. A newer result is left alone. Never throws.
 */
export function duckdbDropResult(handle: DuckdbHandle, seq: number): Promise<void> {
  return runExclusive(handle, async () => {
    const current = resultTables.get(handle);
    if (!current || current.seq !== seq) {
      return;
    }
    resultTables.delete(handle);
    await handle.connection.run(`DROP TABLE IF EXISTS ${current.quoted}`).catch(() => undefined);
  });
}

/**
 * Drops whichever result the handle holds *by the time this reaches the front of the queue*:
 * a run still in flight when the user picked a table has registered its result by then.
 */
export function duckdbDropCurrentResult(handle: DuckdbHandle): Promise<void> {
  return runExclusive(handle, async () => {
    const current = resultTables.get(handle);
    if (!current) {
      return;
    }
    resultTables.delete(handle);
    await handle.connection.run(`DROP TABLE IF EXISTS ${current.quoted}`).catch(() => undefined);
  });
}

/** The seq of the result the handle keeps as a table, if any (for the provider and tests). */
export function currentResultSeq(handle: DuckdbHandle): number | undefined {
  return resultTables.get(handle)?.seq;
}

// What the SQL box will run: reads. `SELECT` covers WITH, FROM-first, SHOW,
// DESCRIBE, SUMMARIZE and the read-style pragmas (`PRAGMA table_info(..)`,
// `PRAGMA database_size`); MULTI is what PIVOT expands to; EXPLAIN is allowed
// only without ANALYZE (below). Everything else is refused *before* it runs,
// because the database being read-only does not make a statement harmless:
// `COPY .. TO` writes a file, `INSTALL`/`LOAD` fetch and load extension code,
// `ATTACH` opens other files, `PRAGMA profiling_output = ..` redirects a file
// every later query writes to, `CALL` runs functions with side effects (a plain
// `SELECT * FROM fn()` covers the read-only ones), and the box re-runs its query
// after every refresh. This is a guard against slips on the user's own machine,
// not a sandbox.
const READ_STATEMENT_TYPES: ReadonlySet<StatementType> = new Set([
  StatementType.SELECT,
  StatementType.EXPLAIN,
  StatementType.MULTI,
]);

// `EXPLAIN ANALYZE <statement>` *executes* the statement (it is typed EXPLAIN, so
// the allow-list cannot tell it apart): `EXPLAIN ANALYZE COPY .. TO 'f'` writes
// the file. Matched anywhere in the text, so `EXPLAIN (ANALYZE) ..` and
// `EXPLAIN /* */ ANALYSE ..` are caught too; a stray hit only costs the user a
// clear message and a plain EXPLAIN.
const EXPLAIN_ANALYZE_PATTERN = /\banaly[sz]e\b/i;
const EXPLAIN_ANALYZE_REFUSAL = 'EXPLAIN ANALYZE runs the statement it explains, so it is not available here. Use EXPLAIN instead.';

function refusal(statementType: StatementType): string {
  const label = statementType === StatementType.LOAD ? 'INSTALL or LOAD' : (StatementType[statementType] ?? 'different');
  const article = /^[AEIOU]/.test(label) ? 'an' : 'a';
  return (
    'Only read queries can be run here (SELECT/WITH, FROM, SHOW, DESCRIBE, SUMMARIZE, PIVOT, EXPLAIN). ' +
    `This is ${article} ${label} statement.`
  );
}

/** `select * from <table> limit 5`, with the table qualified as the file needs it. */
export function suggestQuery(handle: DuckdbHandle, tableName: string): string {
  return `select * from ${quotedTableName(handle, tableName)} limit 5`;
}

/**
 * Runs one SQL text from the query box and reads at most `maxRows` rows (it asks
 * DuckDB for one more, to know whether the result was cut). Several statements
 * run in order and the last one's result is returned, like the DuckDB CLI.
 *
 * Only read statements run (see `READ_STATEMENT_TYPES`): every statement is
 * prepared first, which binds but does not execute it, and anything else is
 * answered with an error before the first one runs. The result is streamed, so
 * `SELECT * FROM huge_table` never materializes the table; the stream is closed
 * after reading, which also frees the connection for the next request. Runs
 * under `runExclusive` with a wall-clock budget (`queryLimits.duckdbTimeoutMs`)
 * enforced with `interrupt()`. Never throws: problems come back as `{ error }`
 * with DuckDB's own message. `shouldRun` is asked once the request reaches the
 * front of the queue; `false` means a newer request overtook it, and nothing
 * runs (`undefined` is returned).
 */
export function duckdbRunQuery(
  handle: DuckdbHandle,
  sql: string,
  maxRowsInput: number,
  options: { shouldRun?: () => boolean; resultSeq?: number } = {}
): Promise<QueryOutcome | undefined> {
  // Comments and semicolons alone are no query either (DuckDB answers them with
  // "Error in native callback"). Only used for this check, so a `--` inside a
  // string literal being stripped too is harmless.
  if (/^[\s;]*$/.test(sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, ''))) {
    return Promise.resolve({ error: 'Type a query to run.' });
  }
  if (sql.length > queryLimits.maxSqlLength) {
    return Promise.resolve({
      error: `The query is too long (${sql.length.toLocaleString()} characters; the limit is ${queryLimits.maxSqlLength.toLocaleString()}).`,
    });
  }
  return runExclusive(handle, async (): Promise<QueryOutcome | undefined> => {
    if (options.shouldRun && !options.shouldRun()) {
      return undefined;
    }
    const started = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      handle.connection.interrupt();
    }, queryLimits.duckdbTimeoutMs);
    let stream: DuckDBResult | undefined;
    try {
      const statements = await handle.connection.extractStatements(sql);
      for (let i = 0; i < statements.count; i++) {
        const prepared = await statements.prepare(i);
        const { statementType } = prepared;
        try {
          prepared.destroySync();
        } catch {
          // best effort: only the type was wanted, and GC frees it anyway
        }
        if (!READ_STATEMENT_TYPES.has(statementType)) {
          return { error: refusal(statementType) };
        }
        if (statementType === StatementType.EXPLAIN && EXPLAIN_ANALYZE_PATTERN.test(sql)) {
          return { error: EXPLAIN_ANALYZE_REFUSAL };
        }
      }
      const maxRows = clampMaxRows(maxRowsInput) ?? 1;
      // What the result table may hold; the grid itself shows at most `maxRows` of it.
      const cap = Math.max(queryLimits.maxResultRows, maxRows);
      stream = await handle.connection.stream(sql);
      const headers = stream.columnNames();
      const types = stream.columnTypes();
      // Streamed, so `SELECT * FROM huge_table` never materializes more than `cap` + one chunk.
      let chunks: DuckDBDataChunk[] = [];
      let total = 0;
      if (headers.length > 0) {
        while (total <= cap) {
          const chunk = await stream.fetchChunk();
          if (!chunk || chunk.rowCount === 0) {
            break;
          }
          chunks.push(chunk);
          total += chunk.rowCount;
        }
      }
      // The stream must be closed before anything else runs on the connection (see the finally).
      stream.closeSync();
      stream = undefined;
      const capped = total > cap;
      if (capped) {
        const last = chunks[chunks.length - 1];
        last.rowCount = last.rowCount - (total - cap);
        total = cap;
        chunks = chunks.filter((chunk) => chunk.rowCount > 0);
      }
      const rows: string[][] = [];
      for (const chunk of chunks) {
        if (rows.length >= maxRows) {
          break;
        }
        for (const row of chunk.convertRows(JsonDuckDBValueConverter)) {
          if (rows.length >= maxRows) {
            break;
          }
          rows.push(row.map(stringifyDuckdbCell));
        }
      }
      // Kept as a table so the table-keyed protocol (statistics, filters) can serve it.
      const table = headers.length > 0 ? await materializeResult(handle, options.resultSeq ?? 0, types, chunks) : undefined;
      return {
        data: {
          headers,
          rows,
          rowCount: rows.length,
          columnCount: headers.length,
          ...(table !== undefined && total > rows.length && { totalRowCount: total }),
        },
        truncated: total > rows.length || capped,
        elapsedMs: Date.now() - started,
        ...(table !== undefined && { result: table.seq, materializedRows: total, ...(capped && { capped: true }) }),
      };
    } catch (err) {
      if (timedOut) {
        return { error: `The query was stopped after ${queryLimits.duckdbTimeoutMs / 1000} s (the limit for queries run from Tablas).` };
      }
      const raw = err instanceof Error ? err.message : String(err);
      return { error: raw.replace(/^Failed to extract statements: /, '') };
    } finally {
      clearTimeout(timer);
      try {
        stream?.closeSync();
      } catch {
        // best effort: the connection is only blocked if the result stays open
      }
    }
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
    const quoted = quotedTableName(handle, tableName);

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
  try {
    const data = await readDuckdbTable(handle, target, maxRowsInput);
    return { tables, selectedTable: target, data };
  } catch (err) {
    // A view can fail on its own (e.g. `read_parquet` over files that are not
    // there). Keep the table list so the user can pick another table.
    const tableError = err instanceof Error ? err.message : String(err);
    return { tables, selectedTable: target, data: emptyParsedTable(), tableError };
  }
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

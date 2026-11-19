import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DuckDBInstance } from '@duckdb/node-api';
import { statsHooks, statsLimits, STATS_TIMED_OUT_REASON } from '../../src/columnStats';
import {
  describeDuckdbOpenError,
  duckdbRunQuery,
  duckdbTableFilter,
  duckdbTableStats,
  listDuckdbTables,
  openDuckdbDatabase,
  parseDuckdb,
  queryLimits,
  readDuckdbTable,
  readSelectedTable,
  runExclusive,
  stringifyDuckdbCell,
  suggestQuery,
  type DuckdbHandle,
} from '../../src/duckdbParser';
import {
  filterLimits,
  filterStringRows,
  FILTER_FAILED_REASON,
  FILTER_TIMED_OUT_REASON,
  FILTER_UNKNOWN_COLUMN_REASON,
  resolveFilters,
  type ColumnFilterSpec,
} from '../../src/filter';
import { FILTER_CASES, idsOf } from './filterCases';

// Use process.cwd() (always the project root) to locate fixtures regardless
// of whether we're running via ts-node or compiled JS in out/.
const fixturesDir = path.join(process.cwd(), 'test', 'fixtures');

async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(path.join(fixturesDir, name)));
}

async function openFixture(name: string): Promise<DuckdbHandle> {
  const opened = await openDuckdbDatabase(await fixtureBytes(name));
  if ('error' in opened) {
    throw new Error(`fixture ${name} failed to open: ${opened.error.message}`);
  }
  return opened;
}

describe('parseDuckdb', () => {
  describe('empty content', () => {
    it('returns success with empty data for 0-byte content', async () => {
      const result = await parseDuckdb(new Uint8Array());
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.tables, []);
        assert.strictEqual(result.data.selectedTable, '');
        assert.deepStrictEqual(result.data.data.headers, []);
        assert.strictEqual(result.data.data.rowCount, 0);
        assert.strictEqual(result.data.data.columnCount, 0);
      }
    });
  });

  describe('simple.duckdb', () => {
    it('lists the one table and selects it by default', async () => {
      const result = await parseDuckdb(await fixtureBytes('simple.duckdb'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.tables, [{ name: 'people', type: 'table', approxRows: 3 }]);
        assert.strictEqual(result.data.selectedTable, 'people');
      }
    });

    it('parses correct headers, row and column count', async () => {
      const result = await parseDuckdb(await fixtureBytes('simple.duckdb'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.data.headers, ['id', 'name', 'score', 'active']);
        assert.strictEqual(result.data.data.rowCount, 3);
        assert.strictEqual(result.data.data.columnCount, 4);
        assert.strictEqual(result.data.data.totalRowCount, 3);
      }
    });

    it('stringifies INTEGER/VARCHAR/DOUBLE/BOOLEAN columns without throwing', async () => {
      const result = await parseDuckdb(await fixtureBytes('simple.duckdb'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.data.rows[0], ['1', 'Alice', '9.5', 'true']);
        assert.deepStrictEqual(result.data.data.rows[1], ['2', 'Bob', '4', 'false']);
      }
    });
  });

  describe('maxRows', () => {
    it('truncates rows and reports the true total via totalRowCount', async () => {
      const result = await parseDuckdb(await fixtureBytes('simple.duckdb'), 2);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rows.length, 2);
        assert.strictEqual(result.data.data.rowCount, 2);
        assert.strictEqual(result.data.data.totalRowCount, 3);
      }
    });

    it('is a no-op when maxRows exceeds the actual row count', async () => {
      const result = await parseDuckdb(await fixtureBytes('simple.duckdb'), 100);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rowCount, 3);
        assert.strictEqual(result.data.data.totalRowCount, 3);
      }
    });

    it('clamps a negative maxRows to 1 row instead of an invalid LIMIT', async () => {
      const result = await parseDuckdb(await fixtureBytes('simple.duckdb'), -1);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rowCount, 1);
        assert.deepStrictEqual(result.data.data.rows[0], ['1', 'Alice', '9.5', 'true']);
      }
    });

    it('floors a fractional maxRows', async () => {
      const result = await parseDuckdb(await fixtureBytes('simple.duckdb'), 1.9);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rowCount, 1);
      }
    });
  });

  describe('empty.duckdb', () => {
    it('returns headers from the query with zero rows', async () => {
      const result = await parseDuckdb(await fixtureBytes('empty.duckdb'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.data.headers, ['id', 'label']);
        assert.strictEqual(result.data.data.rowCount, 0);
        assert.strictEqual(result.data.data.columnCount, 2);
      }
    });
  });

  describe('multi-table.duckdb', () => {
    it('lists tables and the view, ordered by name, distinguishing type', async () => {
      const result = await parseDuckdb(await fixtureBytes('multi-table.duckdb'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.tables, [
          { name: 'customer_totals', type: 'view' },
          { name: 'customers', type: 'table', approxRows: 2 },
          { name: 'orders', type: 'table', approxRows: 3 },
        ]);
      }
    });

    it('defaults to the first table alphabetically', async () => {
      const result = await parseDuckdb(await fixtureBytes('multi-table.duckdb'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.selectedTable, 'customer_totals');
      }
    });

    it('reads an explicitly selected table', async () => {
      const result = await parseDuckdb(await fixtureBytes('multi-table.duckdb'), undefined, 'orders');
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.selectedTable, 'orders');
        assert.strictEqual(result.data.data.rowCount, 3);
      }
    });

    it('reads a view like any other table', async () => {
      const result = await parseDuckdb(
        await fixtureBytes('multi-table.duckdb'),
        undefined,
        'customer_totals'
      );
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.data.headers, ['name', 'total']);
        assert.strictEqual(result.data.data.rowCount, 2);
      }
    });

    it('falls back to the first table when an unknown table name is requested', async () => {
      const result = await parseDuckdb(
        await fixtureBytes('multi-table.duckdb'),
        undefined,
        'nonexistent'
      );
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.selectedTable, 'customer_totals');
      }
    });
  });

  describe('nulls.duckdb', () => {
    it('renders null cells as empty string', async () => {
      const result = await parseDuckdb(await fixtureBytes('nulls.duckdb'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rows[0][1], '');
        assert.strictEqual(result.data.data.rows[1][0], '');
        assert.strictEqual(result.data.data.rows[1][1], '');
        assert.strictEqual(result.data.data.rows[2][1], 'x');
      }
    });
  });

  describe('dates-and-decimals.duckdb', () => {
    it('stringifies DATE/DECIMAL/BIGINT without losing precision', async () => {
      const result = await parseDuckdb(await fixtureBytes('dates-and-decimals.duckdb'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.data.rows[0], [
          '1',
          '2023-11-14',
          '1234.50',
          // Beyond Number.MAX_SAFE_INTEGER -- DuckDB's own JSON conversion
          // renders BIGINT as a string, so no precision is lost the way
          // sql.js's plain-number path would lose it.
          '9007199254740993',
        ]);
      }
    });
  });

  describe('no-tables.duckdb', () => {
    it('returns success with an empty table list for a valid but empty database', async () => {
      const result = await parseDuckdb(await fixtureBytes('no-tables.duckdb'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.tables, []);
        assert.strictEqual(result.data.selectedTable, '');
        assert.strictEqual(result.data.data.columnCount, 0);
      }
    });
  });

  describe('corrupt.duckdb', () => {
    it('returns a clean failure for a non-duckdb file, not a throw', async () => {
      const result = await parseDuckdb(await fixtureBytes('corrupt.duckdb'));
      assert.strictEqual(result.success, false);
      if (!result.success) {
        assert.strictEqual(result.errors[0].type, 'DuckdbError');
        assert.strictEqual(result.errors[0].code, 'OpenFailed');
      }
    });
  });
});

describe('storage-v2.duckdb (written by DuckDB 2.x)', () => {
  it('opens a storage version 999 file, which engines before 2.0 reject', async () => {
    const result = await parseDuckdb(await fixtureBytes('storage-v2.duckdb'));
    assert.strictEqual(result.success, true);
    if (result.success) {
      assert.strictEqual(result.data.selectedTable, 'readings');
      assert.deepStrictEqual(result.data.data.headers, ['id', 'label']);
      assert.deepStrictEqual(result.data.data.rows, [
        ['1', 'a'],
        ['2', 'b'],
      ]);
    }
  });
});

describe('tables in several schemas (dbt-shaped warehouse)', () => {
  it('lists every schema, main first, naming only tables outside main as schema.table', async () => {
    const handle = await openFixture('schemas.duckdb');
    try {
      assert.deepStrictEqual(await listDuckdbTables(handle), [
        { name: 'raw_events', type: 'table', approxRows: 2 },
        { name: 'main_marts.orders', type: 'table', schema: 'main_marts', table: 'orders', approxRows: 2 },
        { name: 'main_staging.orders', type: 'table', schema: 'main_staging', table: 'orders', approxRows: 3 },
        { name: 'main_staging.stg_events', type: 'view', schema: 'main_staging', table: 'stg_events' },
        { name: 'my schema.odd "name"', type: 'table', schema: 'my schema', table: 'odd "name"', approxRows: 1 },
      ]);
    } finally {
      handle.close();
    }
  });

  it('selects the first table (main first) when none is asked for', async () => {
    const result = await parseDuckdb(await fixtureBytes('schemas.duckdb'));
    assert.strictEqual(result.success && result.data.selectedTable, 'raw_events');
  });

  it('reads the right table when two schemas share a table name', async () => {
    const marts = await parseDuckdb(await fixtureBytes('schemas.duckdb'), undefined, 'main_marts.orders');
    const staging = await parseDuckdb(await fixtureBytes('schemas.duckdb'), undefined, 'main_staging.orders');
    assert.ok(marts.success && staging.success);
    if (marts.success && staging.success) {
      assert.deepStrictEqual(marts.data.data.headers, ['id', 'total']);
      assert.deepStrictEqual(marts.data.data.rows, [['1', '19.99'], ['2', '5.5']]);
      assert.deepStrictEqual(staging.data.data.headers, ['id', 'status']);
      assert.strictEqual(staging.data.data.rowCount, 3);
    }
  });

  it('reads a view outside main and a table whose schema and name need quoting', async () => {
    const view = await parseDuckdb(await fixtureBytes('schemas.duckdb'), undefined, 'main_staging.stg_events');
    const odd = await parseDuckdb(await fixtureBytes('schemas.duckdb'), undefined, 'my schema.odd "name"');
    assert.ok(view.success && odd.success);
    if (view.success && odd.success) {
      assert.deepStrictEqual(view.data.data.rows, [['1', 'click'], ['2', 'view']]);
      assert.deepStrictEqual(odd.data.data.rows, [['7']]);
      assert.strictEqual(odd.data.tableError, undefined);
    }
  });

  it('falls back to the first table for a name that is not listed (bare name of a non-main table)', async () => {
    const result = await parseDuckdb(await fixtureBytes('schemas.duckdb'), undefined, 'orders');
    assert.strictEqual(result.success && result.data.selectedTable, 'raw_events');
  });

  it('computes statistics for a table outside main', async () => {
    const handle = await openFixture('schemas.duckdb');
    try {
      await listDuckdbTables(handle);
      const stats = await duckdbTableStats(handle, 'main_marts.orders');
      assert.strictEqual(stats?.columns.length, 2);
      assert.strictEqual(stats?.columns[1].type, 'float');
      assert.strictEqual(stats?.columns[1].max, '19.99');
    } finally {
      handle.close();
    }
  });

  it('filters a table outside main, and not the same-named table in another schema', async () => {
    const handle = await openFixture('schemas.duckdb');
    try {
      await listDuckdbTables(handle);
      const resolved = resolveFilters([{ column: 1, text: '=paid' }]);
      assert.ok('specs' in resolved);
      if ('specs' in resolved) {
        const outcome = await duckdbTableFilter(handle, 'main_staging.orders', resolved.specs, 100);
        assert.deepStrictEqual(outcome, {
          rows: [['2', 'paid'], ['3', 'paid']],
          matchCount: 2,
        });
      }
    } finally {
      handle.close();
    }
  });
});

describe('views that name their own catalog (dbt-duckdb writes warehouse.main.t into view SQL)', () => {
  // DuckDB names a database's catalog after its file. The viewer opens a temp copy, which
  // must therefore keep the source file's name, or such a view fails with
  // `schema "warehouse.main" does not exist`. qualified-views.duckdb is written by
  // DuckDB 1.x (scripts/generate-duckdb-legacy-fixtures.py): 2.x rewrites the
  // reference away when it creates the view, so a 2.x fixture cannot show the problem.
  async function readView(fileName?: string) {
    const opened = await openDuckdbDatabase(await fixtureBytes('qualified-views.duckdb'), { fileName });
    if ('error' in opened) {
      throw new Error(opened.error.message);
    }
    try {
      return await readSelectedTable(opened, await listDuckdbTables(opened), 'stg_invoice_line');
    } finally {
      opened.close();
    }
  }

  async function catalogOf(fileName?: string): Promise<string> {
    const opened = await openDuckdbDatabase(await fixtureBytes('simple.duckdb'), { fileName });
    if ('error' in opened) {
      throw new Error(opened.error.message);
    }
    try {
      return String((await opened.connection.runAndReadAll('SELECT current_database()')).getRowsJson()[0][0]);
    } finally {
      opened.close();
    }
  }

  it('reads such a view when the copy keeps the source file name', async () => {
    const result = await readView('warehouse.duckdb');
    assert.strictEqual(result.tableError, undefined);
    assert.deepStrictEqual(result.data.rows, [['1', 'a'], ['2', 'b']]);
  });

  it('fails with the exact error from the bug report when the copy has another name', async () => {
    const result = await readView();
    assert.match(
      result.tableError ?? '',
      /Table with name "warehouse\.main\.stg_invoice" does not exist because schema "warehouse\.main" does not exist/
    );
    assert.strictEqual(result.data.columnCount, 0);
  });

  it('gives the copy the catalog name DuckDB derives from the source file name', async () => {
    assert.strictEqual(await catalogOf('warehouse.duckdb'), 'warehouse');
    assert.strictEqual(await catalogOf('my warehouse.ddb'), 'my warehouse');
    // DuckDB takes what precedes the first dot, whatever the extension: the same name gives the same catalog.
    assert.strictEqual(await catalogOf('my.data.duckdb'), 'my');
    assert.strictEqual(await catalogOf(undefined), 'database');
  });

  it('keeps every copy inside its own private folder, whatever the name contains', async () => {
    const bytes = await fixtureBytes('simple.duckdb');
    for (const fileName of ['a/b\\c:d*e?.duckdb', '../../escape.duckdb', '', '.hidden', 'x'.repeat(400) + '.duckdb', undefined]) {
      const opened = await openDuckdbDatabase(bytes, { fileName });
      if ('error' in opened) {
        throw new Error(`${JSON.stringify(fileName)}: ${opened.error.message}`);
      }
      try {
        const dir = path.dirname(opened.tempFilePath);
        assert.ok(path.basename(dir).startsWith('tablas-db-'), `${opened.tempFilePath} is in a private tablas-db-* folder`);
        assert.strictEqual(path.dirname(path.dirname(opened.tempFilePath)), path.dirname(dir));
        assert.strictEqual((await readDuckdbTable(opened, 'people')).rowCount, 3);
      } finally {
        opened.close();
      }
    }
  });

  it('removes the whole folder on close, and when opening fails', async () => {
    const before = () => fsSync.readdirSync(os.tmpdir()).filter((f) => f.startsWith('tablas-db-'));
    const existing = new Set(before());
    const opened = await openDuckdbDatabase(await fixtureBytes('simple.duckdb'), { fileName: 'simple.duckdb' });
    if ('error' in opened) {
      throw new Error(opened.error.message);
    }
    const dir = path.dirname(opened.tempFilePath);
    assert.strictEqual(fsSync.existsSync(dir), true);
    opened.close();
    assert.strictEqual(fsSync.existsSync(dir), false, 'the folder goes with the file');

    const failed = await openDuckdbDatabase(await fixtureBytes('corrupt.duckdb'), { fileName: 'corrupt.duckdb' });
    assert.ok('error' in failed);
    assert.deepStrictEqual(before().filter((f) => !existing.has(f)), [], 'a failed open leaves nothing behind');
  });
});

describe('views over files read by a relative path', () => {
  // A view like read_parquet('../data/x.parquet') is stored with the path as
  // written. The database is opened from a temp copy, so without a search
  // directory DuckDB looks next to the extension host's cwd and finds nothing.
  async function buildDb(root: string): Promise<Uint8Array> {
    fsSync.mkdirSync(path.join(root, 'data', 'sub'), { recursive: true });
    const dbPath = path.join(root, 'data', 'src.duckdb');
    const instance = await DuckDBInstance.create(dbPath);
    const connection = await instance.connect();
    try {
      await connection.run(
        `COPY (SELECT 1 AS id, 'a' AS label) TO '${path.join(root, 'data', 'sub', 'x.parquet')}' (FORMAT parquet)`
      );
      // CREATE VIEW binds the path now, so resolve it the way the producer's cwd would.
      await connection.run(`SET file_search_path = '${path.join(root, 'data')}'`);
      await connection.run("CREATE VIEW v AS SELECT * FROM read_parquet('../data/sub/*.parquet')");
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
    return new Uint8Array(fsSync.readFileSync(dbPath));
  }

  let root: string;
  beforeEach(() => {
    root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'tablas-relpath-'));
  });
  afterEach(() => {
    fsSync.rmSync(root, { recursive: true, force: true });
  });

  it('resolves the path next to the source file when given its folder', async () => {
    const bytes = await buildDb(root);
    const opened = await openDuckdbDatabase(bytes, { searchDir: path.join(root, 'data') });
    if ('error' in opened) {
      throw new Error(opened.error.message);
    }
    try {
      const tables = await listDuckdbTables(opened);
      const result = await readSelectedTable(opened, tables, 'v');
      assert.strictEqual(result.tableError, undefined);
      assert.deepStrictEqual(result.data.rows, [['1', 'a']]);
    } finally {
      opened.close();
    }
  });

  it('keeps the table list and reports the error for just that view when the files are not found', async () => {
    const bytes = await buildDb(root);
    const opened = await openDuckdbDatabase(bytes);
    if ('error' in opened) {
      throw new Error(opened.error.message);
    }
    try {
      const tables = await listDuckdbTables(opened);
      const result = await readSelectedTable(opened, tables, 'v');
      assert.deepStrictEqual(result.tables.map((t) => t.name), ['v']);
      assert.strictEqual(result.selectedTable, 'v');
      assert.strictEqual(result.data.columnCount, 0);
      assert.ok(result.tableError && result.tableError.includes('No files found'));
    } finally {
      opened.close();
    }
  });

  it('skips a folder with a comma (file_search_path is comma-separated): opens, but the view stays unresolved', async () => {
    const bytes = await buildDb(root);
    // Without the guard this would set two bogus search folders, `<root>/data,x` split in two.
    const opened = await openDuckdbDatabase(bytes, { searchDir: path.join(root, 'data') + ',x' });
    if ('error' in opened) {
      throw new Error(opened.error.message);
    }
    try {
      const result = await readSelectedTable(opened, await listDuckdbTables(opened), 'v');
      assert.ok(result.tableError && result.tableError.includes('No files found'));
    } finally {
      opened.close();
    }
  });
});

describe('describeDuckdbOpenError', () => {
  const newerStorage =
    'IO Error: Trying to read a database file with version number 999, but we can only read versions between 64 and 68.\n' +
    'The database file was created with an newer version of DuckDB.';

  it('adds an update hint naming the bundled version and keeps DuckDB\'s own text', () => {
    const out = describeDuckdbOpenError(newerStorage, 'v1.5.5');
    assert.ok(out.includes('newer DuckDB than the one built into Tablas'));
    assert.ok(out.includes('DuckDB v1.5.5'));
    assert.ok(out.endsWith(newerStorage));
  });

  it('does not claim a too-old file is newer', () => {
    const older =
      'IO Error: Trying to read a database file with version number 12, but we can only read versions between 64 and 68.\n' +
      'The database file was created with an older version of DuckDB.';
    assert.strictEqual(describeDuckdbOpenError(older, 'v2.0.0'), older);
  });

  it('leaves unrelated open errors unchanged', () => {
    const msg = 'IO Error: The file is not a valid DuckDB database file!';
    assert.strictEqual(describeDuckdbOpenError(msg, 'v2.0.0'), msg);
  });
});

describe('openDuckdbDatabase / listDuckdbTables / readDuckdbTable', () => {
  it('keeps the handle open across multiple readDuckdbTable calls', async () => {
    const handle = await openFixture('multi-table.duckdb');
    try {
      const tables = await listDuckdbTables(handle);
      assert.strictEqual(tables.length, 3);

      const customers = await readDuckdbTable(handle, 'customers');
      assert.strictEqual(customers.rowCount, 2);

      const orders = await readDuckdbTable(handle, 'orders');
      assert.strictEqual(orders.rowCount, 3);
    } finally {
      handle.close();
    }
  });

  it('opens read-only, rejecting a write attempt against the handle', async () => {
    // openDuckdbDatabase always opens with access_mode: 'READ_ONLY' so the
    // viewer never mutates the source file (see the module comment) --
    // proves that guarantee actually holds rather than trusting the config
    // option name/value are correct.
    const handle = await openFixture('simple.duckdb');
    try {
      await assert.rejects(() => handle.connection.run('INSERT INTO people VALUES (4, 4, 4, 4)'));
    } finally {
      handle.close();
    }
  });

  it('quotes table names safely, even ones containing a double quote', async () => {
    // Not exercised via any committed fixture -- proves quoteIdentifier's
    // escaping doesn't produce broken SQL for a table name DuckDB itself
    // allows in a quoted identifier. openDuckdbDatabase always opens
    // read-only (see its comment), so the odd-named table has to be built
    // via a separate read-write instance first, mirroring how
    // scripts/generate-duckdb-fixtures.js builds fixtures.
    const buildPath = path.join(os.tmpdir(), `tablas-test-${Date.now()}.duckdb`);
    const buildInstance = await DuckDBInstance.create(buildPath);
    const buildConnection = await buildInstance.connect();
    try {
      await buildConnection.run('CREATE TABLE "wei""rd" (x INTEGER)');
      await buildConnection.run('INSERT INTO "wei""rd" VALUES (1)');
    } finally {
      buildConnection.closeSync();
      buildInstance.closeSync();
    }

    const bytes = new Uint8Array(fsSync.readFileSync(buildPath));
    fsSync.unlinkSync(buildPath);
    const opened = await openDuckdbDatabase(bytes);
    if ('error' in opened) {
      throw new Error(`failed to open: ${opened.error.message}`);
    }
    try {
      const result = await readDuckdbTable(opened, 'wei"rd');
      assert.strictEqual(result.rowCount, 1);
      assert.deepStrictEqual(result.rows[0], ['1']);
    } finally {
      opened.close();
    }
  });

  it('deletes its backing temp file on close', async () => {
    const handle = await openFixture('simple.duckdb');
    const tempFilePath = handle.tempFilePath;
    assert.strictEqual(fsSync.existsSync(tempFilePath), true);
    handle.close();
    assert.strictEqual(fsSync.existsSync(tempFilePath), false);
  });
});

describe('stringifyDuckdbCell', () => {
  it('renders null as empty string', () => {
    assert.strictEqual(stringifyDuckdbCell(null), '');
  });

  it('renders numbers, booleans and strings via String()', () => {
    assert.strictEqual(stringifyDuckdbCell(9.5), '9.5');
    assert.strictEqual(stringifyDuckdbCell(42), '42');
    assert.strictEqual(stringifyDuckdbCell(true), 'true');
    assert.strictEqual(stringifyDuckdbCell('hello'), 'hello');
  });

  it('renders LIST/STRUCT-shaped values as JSON', () => {
    assert.strictEqual(stringifyDuckdbCell([1, 2, 3]), '[1,2,3]');
    assert.strictEqual(stringifyDuckdbCell({ a: 1, b: 'x' }), '{"a":1,"b":"x"}');
  });
});

describe('duckdbTableStats', () => {
  async function withHandle<T>(name: string, fn: (handle: DuckdbHandle) => Promise<T>): Promise<T> {
    const handle = await openFixture(name);
    try {
      return await fn(handle);
    } finally {
      handle.close();
    }
  }

  function statsFor(name: string, table: string) {
    return withHandle(name, (handle) => duckdbTableStats(handle, table));
  }

  async function silenced<T>(fn: (reported: unknown[]) => Promise<T>): Promise<T> {
    const original = statsHooks.onError;
    const reported: unknown[] = [];
    statsHooks.onError = (err) => {
      reported.push(err);
    };
    try {
      return await fn(reported);
    } finally {
      statsHooks.onError = original;
    }
  }

  it('computes column stats for simple.duckdb', async () => {
    const stats = (await statsFor('simple.duckdb', 'people'))!;
    assert.deepStrictEqual(
      stats.columns.map((c) => c.type),
      ['integer', 'text', 'float', 'boolean']
    );
    assert.strictEqual(stats.columns[0].min, '1');
    assert.strictEqual(stats.columns[0].max, '3');
    assert.strictEqual(stats.columns[0].mean, 2);
    assert.deepStrictEqual(stats.columns[0].histogram, { lo: 1, hi: 3, counts: [1, 1, 1] });
    assert.strictEqual(stats.columns[2].min, '4');
    assert.strictEqual(stats.columns[2].max, '9.5');
    assert.strictEqual(stats.columns[3].distinctCount, 2);
  });

  it('counts NULLs (nulls.duckdb)', async () => {
    const stats = (await statsFor('nulls.duckdb', 'readings'))!;
    assert.strictEqual(stats.columns[0].nullCount, 1);
    assert.strictEqual(stats.columns[1].nullCount, 2);
    assert.strictEqual(stats.columns[1].distinctCount, 1);
  });

  it('keeps the schema type for a zero-row table (empty.duckdb)', async () => {
    const stats = (await statsFor('empty.duckdb', 'items'))!;
    assert.deepStrictEqual(stats.columns, [
      { type: 'integer', nullCount: 0, distinctCount: 0 },
      { type: 'text', nullCount: 0, distinctCount: 0 },
    ]);
  });

  it('formats dates, decimals and BIGINTs exactly (dates-and-decimals.duckdb)', async () => {
    const stats = (await statsFor('dates-and-decimals.duckdb', 'events'))!;
    assert.deepStrictEqual(
      [stats.columns[1].type, stats.columns[1].min, stats.columns[1].max],
      ['date', '2023-11-14', '2023-11-14']
    );
    assert.strictEqual(stats.columns[2].type, 'float');
    assert.strictEqual(stats.columns[2].min, '1234.50');
    assert.strictEqual(stats.columns[3].type, 'integer');
    assert.strictEqual(stats.columns[3].max, '9007199254740993');
  });

  it('computes stats for a view as well as tables (multi-table.duckdb)', async () => {
    const view = (await statsFor('multi-table.duckdb', 'customer_totals'))!;
    assert.strictEqual(view.columns.length, 2);
    assert.strictEqual(view.columns[1].type, 'float');
  });

  describe('stats.duckdb', () => {
    let columns: NonNullable<Awaited<ReturnType<typeof statsFor>>>['columns'];
    before(async () => {
      columns = (await statsFor('stats.duckdb', 'mixed'))!.columns;
    });

    it('keeps exact text for BIGINT and HUGEINT extremes', () => {
      assert.strictEqual(columns[1].max, '9007199254740993');
      assert.strictEqual(columns[2].type, 'integer');
      assert.strictEqual(columns[2].max, '170141183460469231731687303715884105727');
      assert.ok(columns[2].histogram);
    });

    it('excludes NaN and Infinity from min/max/mean/histogram but counts them distinct', () => {
      const ratio = columns[3];
      assert.strictEqual(ratio.type, 'float');
      assert.strictEqual(ratio.min, '1.5');
      assert.strictEqual(ratio.max, '4');
      assert.strictEqual(ratio.distinctCount, 5);
      assert.ok(Number.isFinite(ratio.mean));
      assert.strictEqual(
        ratio.histogram!.counts.reduce((a, b) => a + b, 0),
        3
      );
    });

    it('formats DECIMAL extremes like the table cell', () => {
      assert.strictEqual(columns[4].min, '0.05');
      assert.strictEqual(columns[4].max, '10.00');
    });

    it('types booleans, dates, timestamps and strings', () => {
      assert.strictEqual(columns[5].type, 'boolean');
      assert.deepStrictEqual([columns[6].type, columns[6].min, columns[6].max], [
        'date',
        '2019-01-01',
        '2021-01-01',
      ]);
      assert.deepStrictEqual([columns[7].type, columns[7].min, columns[7].max], [
        'date',
        '2019-03-01 00:00:00',
        '2021-06-01 12:30:00',
      ]);
      assert.deepStrictEqual([columns[8].type, columns[8].min, columns[8].max], ['text', 'a', 'c']);
    });

    it('leaves BLOB and LIST columns unsummarised with only a null count', () => {
      assert.deepStrictEqual(columns[9], { type: 'other', nullCount: 3 });
      assert.deepStrictEqual(columns[10], { type: 'other', nullCount: 1 });
    });

    it('keeps the schema type for an all-NULL column', () => {
      assert.deepStrictEqual(columns[11], { type: 'integer', nullCount: 6, distinctCount: 0 });
    });

    it('handles identifiers containing double quotes', () => {
      assert.strictEqual(columns[12].max, '60');
    });

    it('is JSON-safe', () => {
      assert.deepStrictEqual(JSON.parse(JSON.stringify(columns)), columns);
    });

    it('covers a view over the table', async () => {
      const view = (await statsFor('stats.duckdb', 'label_counts'))!;
      assert.strictEqual(view.columns[0].nullCount, 1);
      assert.strictEqual(view.columns[1].max, '2');
    });
  });

  it('covers the whole table, however many rows readDuckdbTable returns', async () => {
    await withHandle('stats.duckdb', async (handle) => {
      const shown = await readDuckdbTable(handle, 'mixed', 1);
      assert.strictEqual(shown.rowCount, 1);
      assert.strictEqual('stats' in shown, false, 'stats are no longer attached to the rows');
      assert.strictEqual((await duckdbTableStats(handle, 'mixed'))!.columns[0].max, '6');
    });
  });

  it('reuses the cached result when a table is asked about again on the same handle', async () => {
    await withHandle('stats.duckdb', async (handle) => {
      const first = await duckdbTableStats(handle, 'mixed');
      assert.ok(first);
      assert.strictEqual(await duckdbTableStats(handle, 'mixed'), first);
    });
  });

  it('gives an unknown table no stats, reported rather than thrown', async () => {
    await silenced(async (reported) => {
      await withHandle('simple.duckdb', async (handle) => {
        assert.strictEqual(await duckdbTableStats(handle, 'no_such_table'), undefined);
        assert.strictEqual(reported.length, 1);
      });
    });
  });

  /**
   * A stand-in handle whose aggregate stats query (the only one containing
   * COUNT(DISTINCT)) hangs until interrupt() is called, so the timeout path is
   * exercised deterministically instead of by racing a real slow query. Every
   * other query passes through to the real connection.
   */
  function hangingStatsHandle(handle: DuckdbHandle) {
    let rejectPending: ((err: Error) => void) | undefined;
    const events: string[] = [];
    let aggregateStarts = 0;
    const connection = new Proxy(handle.connection, {
      get(target, prop) {
        if (prop === 'runAndReadAll') {
          return (sql: string, ...rest: unknown[]) => {
            if (sql.includes('COUNT(DISTINCT')) {
              aggregateStarts++;
              events.push('stats-start');
              return new Promise((_, reject) => {
                rejectPending = reject;
              });
            }
            events.push(sql.startsWith('SELECT COUNT(*) FROM') ? 'read-start' : 'other');
            return (target.runAndReadAll as (...args: unknown[]) => Promise<unknown>)(sql, ...rest);
          };
        }
        if (prop === 'interrupt') {
          return () => {
            events.push('interrupt');
            rejectPending?.(new Error('INTERRUPT Error'));
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const hanging: DuckdbHandle = { connection, tempFilePath: handle.tempFilePath, close: handle.close };
    return { hanging, events, aggregateStarts: () => aggregateStarts };
  }

  describe('time budget', () => {
    async function withShortBudget<T>(fn: () => Promise<T>): Promise<T> {
      const original = statsLimits.duckdbTimeoutMs;
      statsLimits.duckdbTimeoutMs = 10;
      try {
        return await fn();
      } finally {
        statsLimits.duckdbTimeoutMs = original;
      }
    }

    it('gives up with a reason when the stats query exceeds it', () =>
      withShortBudget(() =>
        withHandle('simple.duckdb', async (handle) => {
          const { hanging, events } = hangingStatsHandle(handle);
          assert.deepStrictEqual(await duckdbTableStats(hanging, 'people'), {
            columns: [],
            skippedReason: STATS_TIMED_OUT_REASON,
          });
          assert.ok(events.includes('interrupt'));
          // the table itself is unaffected
          assert.strictEqual((await readDuckdbTable(hanging, 'people')).rowCount, 3);
        })
      ));

    it('remembers the timeout instead of re-running the scan on every ask', () =>
      withShortBudget(() =>
        withHandle('simple.duckdb', async (handle) => {
          const { hanging, aggregateStarts } = hangingStatsHandle(handle);
          const first = await duckdbTableStats(hanging, 'people');
          const second = await duckdbTableStats(hanging, 'people');
          assert.strictEqual(second, first);
          assert.strictEqual(aggregateStarts(), 1, 'the expensive scan must not be repeated');
        })
      ));

    it('interrupts only the stats query: a read queued behind it waits, then completes', () =>
      withShortBudget(() =>
        withHandle('simple.duckdb', async (handle) => {
          const { hanging, events } = hangingStatsHandle(handle);
          const statsPromise = duckdbTableStats(hanging, 'people');
          const readPromise = readDuckdbTable(hanging, 'people'); // queued behind the hanging stats
          const [stats, read] = await Promise.all([statsPromise, readPromise]);
          assert.strictEqual(stats?.skippedReason, STATS_TIMED_OUT_REASON);
          assert.strictEqual(read.rowCount, 3, 'the queued read must not be killed by the interrupt');
          // The read's first query only starts after the interrupt has fired.
          assert.ok(events.indexOf('read-start') > events.indexOf('interrupt'), events.join(','));
        })
      ));
  });

  describe('when the stats query fails outright', () => {
    function failingHandle(handle: DuckdbHandle) {
      let attempts = 0;
      const failing: DuckdbHandle = {
        tempFilePath: handle.tempFilePath,
        close: handle.close,
        connection: new Proxy(handle.connection, {
          get(target, prop) {
            if (prop === 'runAndReadAll') {
              return (sql: string, ...rest: unknown[]) => {
                if (sql.includes('COUNT(DISTINCT')) {
                  attempts++;
                  return Promise.reject(new Error('boom'));
                }
                return (target.runAndReadAll as (...args: unknown[]) => Promise<unknown>)(sql, ...rest);
              };
            }
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      };
      return { failing, attempts: () => attempts };
    }

    it('reports through statsHooks and returns undefined; the table still reads', () =>
      silenced((reported) =>
        withHandle('simple.duckdb', async (handle) => {
          const { failing } = failingHandle(handle);
          assert.strictEqual(await duckdbTableStats(failing, 'people'), undefined);
          assert.strictEqual(reported.length, 1);
          assert.strictEqual((reported[0] as Error).message, 'boom');
          assert.strictEqual((await readDuckdbTable(failing, 'people')).rowCount, 3);
        })
      ));

    it('remembers the failure instead of retrying it on every ask', () =>
      silenced((reported) =>
        withHandle('simple.duckdb', async (handle) => {
          const { failing, attempts } = failingHandle(handle);
          await duckdbTableStats(failing, 'people');
          await duckdbTableStats(failing, 'people');
          assert.strictEqual(attempts(), 1);
          assert.strictEqual(reported.length, 1);
        })
      ));
  });
});

describe('runExclusive', () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('runs operations on one handle strictly one after another, in call order', async () => {
    const handle = await openFixture('simple.duckdb');
    try {
      const log: string[] = [];
      let releaseFirst!: () => void;
      const first = runExclusive(handle, async () => {
        log.push('first:start');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        log.push('first:end');
        return 1;
      });
      const second = runExclusive(handle, async () => {
        log.push('second:start');
        return 2;
      });
      await tick();
      await tick();
      assert.deepStrictEqual(log, ['first:start'], 'second must wait for first');
      releaseFirst();
      assert.deepStrictEqual(await Promise.all([first, second]), [1, 2]);
      assert.deepStrictEqual(log, ['first:start', 'first:end', 'second:start']);
    } finally {
      handle.close();
    }
  });

  it('keeps going after an operation rejects, and still rejects that caller', async () => {
    const handle = await openFixture('simple.duckdb');
    try {
      const failed = runExclusive(handle, async () => {
        throw new Error('nope');
      });
      const after = runExclusive(handle, async () => 'still ran');
      await assert.rejects(failed, /nope/);
      assert.strictEqual(await after, 'still ran');
    } finally {
      handle.close();
    }
  });

  it('does not make different handles wait for each other', async () => {
    const a = await openFixture('simple.duckdb');
    const b = await openFixture('simple.duckdb');
    try {
      let releaseA!: () => void;
      const blockedA = runExclusive(a, () => new Promise<void>((resolve) => {
        releaseA = resolve;
      }));
      assert.strictEqual(await runExclusive(b, async () => 'b ran'), 'b ran');
      releaseA();
      await blockedA;
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('duckdbTableFilter', () => {
  async function withHandle<T>(name: string, fn: (handle: DuckdbHandle) => Promise<T>): Promise<T> {
    const handle = await openFixture(name);
    try {
      return await fn(handle);
    } finally {
      handle.close();
    }
  }

  /** Builds a throwaway database (openDuckdbDatabase is read-only, so it needs its own writable instance). */
  async function withInlineDb<T>(statements: string[], fn: (handle: DuckdbHandle) => Promise<T>): Promise<T> {
    const buildPath = path.join(os.tmpdir(), `tablas-filter-test-${process.pid}-${Date.now()}.duckdb`);
    const instance = await DuckDBInstance.create(buildPath);
    const connection = await instance.connect();
    try {
      for (const sql of statements) {
        await connection.run(sql);
      }
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
    const bytes = new Uint8Array(fsSync.readFileSync(buildPath));
    fsSync.unlinkSync(buildPath);
    const opened = await openDuckdbDatabase(bytes);
    if ('error' in opened) {
      throw new Error(opened.error.message);
    }
    try {
      return await fn(opened);
    } finally {
      opened.close();
    }
  }

  function specsOf(filters: Parameters<typeof resolveFilters>[0]): ColumnFilterSpec[] {
    const resolved = resolveFilters(filters);
    if ('errors' in resolved) {
      assert.fail('unexpected filter error');
    }
    return resolved.specs;
  }

  async function silenced<T>(fn: () => Promise<T>): Promise<T> {
    const original = statsHooks.log;
    statsHooks.log = () => undefined;
    try {
      return await fn();
    } finally {
      statsHooks.log = original;
    }
  }

  for (const c of FILTER_CASES) {
    it(c.name, () =>
      withHandle('filter.duckdb', async (handle) => {
        const outcome = await duckdbTableFilter(handle, 'items', specsOf(c.filters), 100);
        assert.ok(!('failedReason' in outcome), 'failedReason' in outcome ? outcome.failedReason : '');
        assert.deepStrictEqual(idsOf(outcome.rows), c.ids);
        assert.strictEqual(outcome.matchCount, c.ids.length);
      }));
  }

  it('caps the returned rows at maxRows but counts every match', () =>
    withHandle('filter.duckdb', async (handle) => {
      const outcome = await duckdbTableFilter(handle, 'items', specsOf([{ column: 3, text: '>=1' }]), 2);
      assert.ok(!('failedReason' in outcome));
      assert.strictEqual(outcome.rows.length, 2);
      assert.strictEqual(outcome.matchCount, 6);
    }));

  it('returns the same cell text as readDuckdbTable', () =>
    withHandle('filter.duckdb', async (handle) => {
      const outcome = await duckdbTableFilter(handle, 'items', specsOf([{ column: 1, text: 'e' }]), 100);
      assert.ok(!('failedReason' in outcome));
      const all = (await readDuckdbTable(handle, 'items')).rows;
      assert.deepStrictEqual(outcome.rows, all.filter((row) => row[1].toLowerCase().includes('e')));
    }));

  it('finds a whole-number DOUBLE by the text the table shows ("10", not "10.0")', () =>
    withHandle('filter.duckdb', async (handle) => {
      const shown = (await readDuckdbTable(handle, 'whole_numbers')).rows.map((r) => r[0]);
      assert.deepStrictEqual(shown, ['10', '20', '']);
      const equals = await duckdbTableFilter(handle, 'whole_numbers', specsOf([{ column: 0, text: '=10' }]), 10);
      assert.ok(!('failedReason' in equals));
      assert.deepStrictEqual(equals.rows, [['10']]);
      const contains = await duckdbTableFilter(handle, 'whole_numbers', specsOf([{ column: 0, text: '0' }]), 10);
      assert.ok(!('failedReason' in contains));
      assert.strictEqual(contains.matchCount, 2);
    }));

  it('treats SQL metacharacters in a filter as plain text', () =>
    withHandle('filter.duckdb', async (handle) => {
      const evil = `'; DROP TABLE items; --`;
      const outcome = await duckdbTableFilter(handle, 'items', specsOf([{ column: 1, text: evil }]), 100);
      assert.ok(!('failedReason' in outcome));
      assert.strictEqual(outcome.matchCount, 0);
      assert.strictEqual((await readDuckdbTable(handle, 'items')).rowCount, 7);
    }));

  it('refuses a filter on a column the table does not have', () =>
    withHandle('filter.duckdb', async (handle) => {
      const outcome = await duckdbTableFilter(handle, 'items', specsOf([{ column: 99, text: 'x' }]), 100);
      assert.deepStrictEqual(outcome, { failedReason: FILTER_UNKNOWN_COLUMN_REASON });
    }));

  it('reports an unknown table as a failed filter, without throwing', () =>
    silenced(() =>
      withHandle('filter.duckdb', async (handle) => {
        const outcome = await duckdbTableFilter(handle, 'no_such_table', specsOf([{ column: 0, text: '1' }]), 100);
        assert.deepStrictEqual(outcome, { failedReason: FILTER_FAILED_REASON });
      })));

  it('gives the same answer as the JS engine over the displayed text, for every column type', () =>
    withInlineDb(
      [
        'CREATE TABLE t (label VARCHAR, dec DECIMAL(10,2), d DATE, f DOUBLE, flag BOOLEAN, ts TIMESTAMP, big BIGINT, iso VARCHAR)',
        // `iso` holds ISO-looking text in several shapes (T/Z suffix, space time, leading space, trailing text, not a date).
        `INSERT INTO t VALUES
           ('10', 1234.50, DATE '2024-01-15', 'NaN', true, TIMESTAMP '2024-01-15 10:30:00', 9007199254740993, '2024-01-15T10:30:00Z'),
           (' 7 ', 5.25, DATE '2023-01-01', 'Infinity', false, TIMESTAMP '2023-01-01 00:00:00', -5, ' 2024-01-15'),
           ('abc', NULL, NULL, 2.5, NULL, NULL, NULL, '2024-01-15x'),
           ('1e3', 0.5, DATE '2025-06-30', 10, true, TIMESTAMP '2025-06-30 23:59:59', 0, '2024-01-15 23:59:59'),
           ('', -3.10, DATE '2024-01-15', -0.5, false, TIMESTAMP '2024-01-15 10:30:00', 12, NULL),
           ('ÉCOLE', 100, DATE '2022-02-02', '-Infinity', NULL, NULL, 7, '2023-12-31')`,
      ],
      async (handle) => {
        const table = await readDuckdbTable(handle, 't');
        const texts: Array<[number, string[]]> = [
          [0, ['>5', '<=10', '<9999', '>=abc', '=10', '!=10', '=', '!=', 'é', '!1', '= 7 ', '\\1', '>=2024-01-01', '<2999-01-01']],
          [1, ['>1000', '<=5.25', '=1234.50', '>0', '<0', '5', '!.', '>=2024-01-01']],
          [2, ['>=2024-01-01', '<2024-01-01', '>5', '=', '!=', '2024', '=2024-01-15', '<=2023-01-01', '<=2024-01-15', '>2024-01-15', '>=2025-06-30', '<2022-02-02']],
          [3, ['>2', '<=10', '=10', '=2.5', 'nan', 'inf', '>-1', '=-0.5', '!5', '<=2024-01-15']],
          [4, ['=true', 'false', '=', '!=', '!true']],
          [5, ['>=2024-01-15 10:30:00', '<2024-01-01', '2024', '=', '>5', '<=2024-01-15', '>2024-01-15', '>=2025-06-30', '<=2023-01-01']],
          [6, ['>0', '<=7', '=9007199254740993', '9007', '=', '<-1', '>=2024-01-01']],
          [7, ['>=2024-01-15', '<=2024-01-15', '>2024-01-14', '<2024-01-16', '<2999-01-01', '>=2024-01-15x', '=', '!=']],
        ];
        for (const [column, filters] of texts) {
          for (const text of filters) {
            const specs = specsOf([{ column, text }]);
            const sql = await duckdbTableFilter(handle, 't', specs, 100);
            assert.ok(!('failedReason' in sql), `${JSON.stringify(text)}: ${'failedReason' in sql ? sql.failedReason : ''}`);
            const js = filterStringRows(table.rows, specs, 100);
            assert.deepStrictEqual(sql.rows, js.rows, `column ${column} ${JSON.stringify(text)}`);
            assert.strictEqual(sql.matchCount, js.matchCount, `column ${column} ${JSON.stringify(text)}`);
          }
        }
      }
    ));

  describe('time budget', () => {
    /** A stand-in handle whose filter queries (the only ones renaming columns to c0..) hang until interrupt(). */
    function hangingFilterHandle(handle: DuckdbHandle) {
      let rejectPending: ((err: Error) => void) | undefined;
      const events: string[] = [];
      const connection = new Proxy(handle.connection, {
        get(target, prop) {
          if (prop === 'runAndReadAll') {
            return (sql: string, ...rest: unknown[]) => {
              if (sql.includes(' AS s(c0')) {
                events.push('filter-start');
                return new Promise((_, reject) => {
                  rejectPending = reject;
                });
              }
              events.push(sql.startsWith('SELECT COUNT(*) FROM') ? 'read-start' : 'other');
              return (target.runAndReadAll as (...args: unknown[]) => Promise<unknown>)(sql, ...rest);
            };
          }
          if (prop === 'interrupt') {
            return () => {
              events.push('interrupt');
              rejectPending?.(new Error('INTERRUPT Error'));
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const hanging: DuckdbHandle = { connection, tempFilePath: handle.tempFilePath, close: handle.close };
      return { hanging, events };
    }

    async function withShortBudget<T>(fn: () => Promise<T>): Promise<T> {
      const original = filterLimits.duckdbTimeoutMs;
      filterLimits.duckdbTimeoutMs = 10;
      try {
        return await fn();
      } finally {
        filterLimits.duckdbTimeoutMs = original;
      }
    }

    it('gives up with a reason when the filter query exceeds it', () =>
      withShortBudget(() =>
        withHandle('filter.duckdb', async (handle) => {
          const { hanging, events } = hangingFilterHandle(handle);
          const outcome = await duckdbTableFilter(hanging, 'items', specsOf([{ column: 1, text: 'a' }]), 100);
          assert.deepStrictEqual(outcome, { failedReason: FILTER_TIMED_OUT_REASON });
          assert.ok(events.includes('interrupt'));
          // the table itself is unaffected
          assert.strictEqual((await readDuckdbTable(hanging, 'items')).rowCount, 7);
        })));

    it('interrupts only the filter query: a read queued behind it waits, then completes', () =>
      withShortBudget(() =>
        withHandle('filter.duckdb', async (handle) => {
          const { hanging, events } = hangingFilterHandle(handle);
          const filtering = duckdbTableFilter(hanging, 'items', specsOf([{ column: 1, text: 'a' }]), 100);
          const reading = readDuckdbTable(hanging, 'items'); // queued behind the hanging filter
          const [outcome, read] = await Promise.all([filtering, reading]);
          assert.deepStrictEqual(outcome, { failedReason: FILTER_TIMED_OUT_REASON });
          assert.strictEqual(read.rowCount, 7, 'the queued read must not be killed by the interrupt');
          assert.ok(events.indexOf('read-start') > events.indexOf('interrupt'), events.join(','));
        })));
  });
});

describe('duckdbRunQuery (the read-only SQL box)', () => {
  async function withQueryHandle<T>(name: string, fn: (handle: DuckdbHandle) => Promise<T>): Promise<T> {
    const handle = await openFixture(name);
    try {
      await listDuckdbTables(handle);
      return await fn(handle);
    } finally {
      handle.close();
    }
  }
  const run = (name: string, sql: string, maxRows = 100) =>
    withQueryHandle(name, (handle) => duckdbRunQuery(handle, sql, maxRows));

  it('returns the rows of a select as display text', async () => {
    const outcome = await run('multi-table.duckdb', 'SELECT name, id FROM customers ORDER BY id');
    assert.ok(outcome && 'data' in outcome);
    if (outcome && 'data' in outcome) {
      assert.deepStrictEqual(outcome.data.headers, ['name', 'id']);
      assert.deepStrictEqual(outcome.data.rows, [['Acme', '1'], ['Globex', '2']]);
      assert.strictEqual(outcome.data.rowCount, 2);
      assert.strictEqual(outcome.truncated, false);
      assert.ok(outcome.elapsedMs >= 0);
    }
  });

  it('cuts the result at maxRows and says so, without reading the whole table', async () => {
    const outcome = await run('multi-table.duckdb', 'SELECT range AS n FROM range(1000000)', 3);
    assert.ok(outcome && 'data' in outcome);
    if (outcome && 'data' in outcome) {
      assert.deepStrictEqual(outcome.data.rows, [['0'], ['1'], ['2']]);
      assert.strictEqual(outcome.truncated, true);
    }
  });

  it('is not truncated when the result is exactly maxRows', async () => {
    const outcome = await run('multi-table.duckdb', 'SELECT range AS n FROM range(3)', 3);
    assert.ok(outcome && 'data' in outcome);
    if (outcome && 'data' in outcome) {
      assert.strictEqual(outcome.data.rowCount, 3);
      assert.strictEqual(outcome.truncated, false);
    }
  });

  it('leaves the connection usable after a result that was cut short', async () => {
    await withQueryHandle('multi-table.duckdb', async (handle) => {
      await duckdbRunQuery(handle, 'SELECT range FROM range(1000000)', 2);
      // A stream left open would make each of these fail with "connection has an open result".
      assert.ok('data' in ((await duckdbRunQuery(handle, 'SELECT 1', 5)) ?? {}));
      assert.strictEqual((await readDuckdbTable(handle, 'orders')).rowCount, 3);
      assert.ok((await duckdbTableStats(handle, 'orders'))?.columns.length);
    });
  });

  it('runs SHOW, DESCRIBE, SUMMARIZE, WITH, FROM-first, read pragmas, EXPLAIN, table functions and PIVOT', async () => {
    const statements = [
      'SHOW TABLES',
      'DESCRIBE orders',
      'SUMMARIZE orders',
      'WITH a AS (SELECT 1 AS x) SELECT * FROM a',
      'FROM orders',
      'PRAGMA table_info(orders)',
      'PRAGMA database_size',
      'EXPLAIN SELECT 1',
      'SELECT * FROM duckdb_tables()',
      'PIVOT orders ON customer_id USING sum(total)',
    ];
    await withQueryHandle('multi-table.duckdb', async (handle) => {
      for (const sql of statements) {
        const outcome = await duckdbRunQuery(handle, sql, 10);
        assert.ok(outcome && 'data' in outcome, `${sql} should run: ${JSON.stringify(outcome)}`);
      }
    });
  });

  it('returns the last result of several statements', async () => {
    const outcome = await run('multi-table.duckdb', 'SELECT 1 AS a; SELECT 2 AS b');
    assert.ok(outcome && 'data' in outcome);
    if (outcome && 'data' in outcome) {
      assert.deepStrictEqual(outcome.data.headers, ['b']);
    }
  });

  it('refuses anything that is not a read, before running any of it', async () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'tablas-query-'));
    const target = path.join(dir, 'out.csv');
    try {
      await withQueryHandle('multi-table.duckdb', async (handle) => {
        const refused: Array<[string, RegExp]> = [
          [`COPY (SELECT 1) TO '${target}'`, /a COPY statement/],
          ['INSTALL httpfs', /an INSTALL or LOAD statement/],
          ['LOAD httpfs', /an INSTALL or LOAD statement/],
          ["ATTACH ':memory:' AS m", /an ATTACH statement/],
          ['SET threads = 1', /a SET statement/],
          // Pragmas that assign are SETs; CALL runs functions with side effects.
          ["PRAGMA profiling_output = '/tmp/tablas-never.json'", /a SET statement/],
          ['CALL duckdb_tables()', /a CALL statement/],
          [`EXPORT DATABASE '${path.join(dir, 'exp')}'`, /an EXPORT statement/],
          ['CREATE TABLE t AS SELECT 1', /a CREATE statement/],
          ['INSERT INTO orders VALUES (9, 9, 9)', /an INSERT statement/],
          ['DROP TABLE orders', /a DROP statement/],
          // A read first must not let a later write through.
          [`SELECT 1; COPY (SELECT 1) TO '${target}'`, /a COPY statement/],
        ];
        for (const [sql, kind] of refused) {
          const outcome = await duckdbRunQuery(handle, sql, 10);
          assert.ok(outcome && 'error' in outcome, `${sql} must be refused`);
          if (outcome && 'error' in outcome) {
            assert.match(outcome.error, /^Only read queries can be run here/);
            assert.match(outcome.error, kind);
          }
        }
        assert.strictEqual(fsSync.existsSync(target), false, 'a refused COPY must not write its file');
        assert.strictEqual((await readDuckdbTable(handle, 'orders')).rowCount, 3);
      });
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses EXPLAIN ANALYZE, which would run the statement it explains', async () => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'tablas-explain-'));
    const target = path.join(dir, 'out.csv');
    try {
      await withQueryHandle('multi-table.duckdb', async (handle) => {
        const attempts = [
          `EXPLAIN ANALYZE COPY (SELECT 1 AS a) TO '${target}'`,
          `explain analyse copy (select 1 as a) to '${target}'`,
          `EXPLAIN (ANALYZE) COPY (SELECT 1 AS a) TO '${target}'`,
          `EXPLAIN /* hidden */ ANALYZE COPY (SELECT 1 AS a) TO '${target}'`,
          'EXPLAIN ANALYZE SELECT 1', // harmless, but indistinguishable by type: the same rule
        ];
        for (const sql of attempts) {
          const outcome = await duckdbRunQuery(handle, sql, 10);
          assert.ok(outcome && 'error' in outcome, `${sql} must be refused`);
          if (outcome && 'error' in outcome) {
            assert.match(outcome.error, /^EXPLAIN ANALYZE runs the statement it explains/);
          }
        }
        assert.strictEqual(fsSync.existsSync(target), false, 'the write inside EXPLAIN ANALYZE must not happen');
        // Plain EXPLAIN is still fine.
        assert.ok('data' in ((await duckdbRunQuery(handle, 'EXPLAIN SELECT * FROM orders', 10)) ?? {}));
      });
    } finally {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports DuckDB's own message for an invalid query, without the internal prefix", async () => {
    const syntax = await run('multi-table.duckdb', 'SELEC 1');
    assert.ok(syntax && 'error' in syntax);
    if (syntax && 'error' in syntax) {
      assert.match(syntax.error, /^Parser Error: syntax error at or near "SELEC"/);
    }
    const missing = await run('multi-table.duckdb', 'SELECT * FROM nope');
    assert.ok(missing && 'error' in missing);
    if (missing && 'error' in missing) {
      assert.match(missing.error, /nope/);
    }
  });

  it('asks for a query when the text is empty, or only semicolons, whitespace and comments', async () => {
    for (const sql of ['', '   \n', ' ; ;', '-- just a note', '/* nothing */ ;', '-- a\n/* b */\n;']) {
      assert.deepStrictEqual(await run('multi-table.duckdb', sql), { error: 'Type a query to run.' });
    }
  });

  it('refuses a query over the length limit', async () => {
    const original = queryLimits.maxSqlLength;
    queryLimits.maxSqlLength = 20;
    try {
      const outcome = await run('multi-table.duckdb', 'SELECT 1 FROM orders WHERE 1 = 1');
      assert.ok(outcome && 'error' in outcome);
      if (outcome && 'error' in outcome) {
        assert.match(outcome.error, /too long/);
      }
    } finally {
      queryLimits.maxSqlLength = original;
    }
  });

  it('stops a query that runs past the time budget, and the connection survives', async () => {
    const original = queryLimits.duckdbTimeoutMs;
    queryLimits.duckdbTimeoutMs = 100;
    try {
      await withQueryHandle('multi-table.duckdb', async (handle) => {
        const outcome = await duckdbRunQuery(
          handle,
          'SELECT sum(a.range * b.range) FROM range(100000) a, range(100000) b',
          10
        );
        assert.ok(outcome && 'error' in outcome);
        if (outcome && 'error' in outcome) {
          assert.match(outcome.error, /stopped after/);
        }
        assert.strictEqual((await readDuckdbTable(handle, 'orders')).rowCount, 3);
      });
    } finally {
      queryLimits.duckdbTimeoutMs = original;
    }
  });

  it('does not run a request that a newer one overtook while it waited in the queue', async () => {
    await withQueryHandle('multi-table.duckdb', async (handle) => {
      let current = 1;
      const first = duckdbRunQuery(handle, 'SELECT 1', 5, { shouldRun: () => current === 1 });
      current = 2; // the second request arrives before the first reached the front
      const second = duckdbRunQuery(handle, 'SELECT 2 AS two', 5, { shouldRun: () => current === 2 });
      assert.strictEqual(await first, undefined);
      const outcome = await second;
      assert.ok(outcome && 'data' in outcome);
    });
  });

  it('queries tables outside main by their schema', async () => {
    const outcome = await run('schemas.duckdb', 'SELECT count(*) AS n FROM main_staging.orders');
    assert.ok(outcome && 'data' in outcome);
    if (outcome && 'data' in outcome) {
      assert.deepStrictEqual(outcome.data.rows, [['3']]);
    }
  });

  it('lists the tables once per handle, not on every stats or filter request', async () => {
    await withQueryHandle('multi-table.duckdb', async (handle) => {
      const connection = handle.connection;
      const original = connection.runAndReadAll.bind(connection);
      let queries = 0;
      connection.runAndReadAll = ((...args: Parameters<typeof original>) => {
        queries++;
        return original(...args);
      }) as typeof connection.runAndReadAll;
      const first = await listDuckdbTables(handle); // withQueryHandle already listed: served from memory
      const second = await listDuckdbTables(handle);
      assert.strictEqual(queries, 0, 'no catalog query for an already listed handle');
      assert.strictEqual(second, first);
    });
  });

  describe('suggestQuery', () => {
    it('selects from the table as the file needs it written', async () => {
      await withQueryHandle('schemas.duckdb', async (handle) => {
        assert.strictEqual(suggestQuery(handle, 'raw_events'), 'SELECT * FROM "raw_events" LIMIT 100');
        assert.strictEqual(
          suggestQuery(handle, 'main_marts.orders'),
          'SELECT * FROM "main_marts"."orders" LIMIT 100'
        );
        assert.strictEqual(
          suggestQuery(handle, 'my schema.odd "name"'),
          'SELECT * FROM "my schema"."odd ""name""" LIMIT 100'
        );
      });
    });
  });
});

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  listDuckdbTables,
  openDuckdbDatabase,
  parseDuckdb,
  readDuckdbTable,
  stringifyDuckdbCell,
  type DuckdbHandle,
} from '../../src/duckdbParser';

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
        assert.deepStrictEqual(result.data.tables, [{ name: 'people', type: 'table' }]);
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
          { name: 'customers', type: 'table' },
          { name: 'orders', type: 'table' },
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

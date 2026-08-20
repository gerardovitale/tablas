import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  listSqliteTables,
  openSqliteDatabase,
  parseSqlite,
  readSqliteTable,
  stringifySqliteCell,
  type SqliteHandle,
} from '../../src/sqliteParser';

// Use process.cwd() (always the project root) to locate fixtures regardless
// of whether we're running via ts-node or compiled JS in out/.
const fixturesDir = path.join(process.cwd(), 'test', 'fixtures');

async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(path.join(fixturesDir, name)));
}

async function openFixture(name: string): Promise<SqliteHandle> {
  const opened = await openSqliteDatabase(await fixtureBytes(name));
  if ('error' in opened) {
    throw new Error(`fixture ${name} failed to open: ${opened.error.message}`);
  }
  return opened;
}

describe('parseSqlite', () => {
  describe('empty content', () => {
    it('returns success with empty data for 0-byte content', async () => {
      const result = await parseSqlite(new Uint8Array());
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

  describe('simple.db', () => {
    it('lists the one table and selects it by default', async () => {
      const result = await parseSqlite(await fixtureBytes('simple.db'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.tables, [{ name: 'people', type: 'table' }]);
        assert.strictEqual(result.data.selectedTable, 'people');
      }
    });

    it('parses correct headers, row and column count', async () => {
      const result = await parseSqlite(await fixtureBytes('simple.db'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.data.headers, ['id', 'name', 'score', 'active']);
        assert.strictEqual(result.data.data.rowCount, 3);
        assert.strictEqual(result.data.data.columnCount, 4);
        assert.strictEqual(result.data.data.totalRowCount, 3);
      }
    });

    it('stringifies INTEGER/TEXT/REAL columns without throwing', async () => {
      const result = await parseSqlite(await fixtureBytes('simple.db'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.data.rows[0], ['1', 'Alice', '9.5', '1']);
        assert.deepStrictEqual(result.data.data.rows[1], ['2', 'Bob', '4', '0']);
      }
    });
  });

  describe('maxRows', () => {
    it('truncates rows and reports the true total via totalRowCount', async () => {
      const result = await parseSqlite(await fixtureBytes('simple.db'), 2);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rows.length, 2);
        assert.strictEqual(result.data.data.rowCount, 2);
        assert.strictEqual(result.data.data.totalRowCount, 3);
      }
    });

    it('is a no-op when maxRows exceeds the actual row count', async () => {
      const result = await parseSqlite(await fixtureBytes('simple.db'), 100);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rowCount, 3);
        assert.strictEqual(result.data.data.totalRowCount, 3);
      }
    });

    it('clamps a negative maxRows to 1 row instead of an invalid LIMIT', async () => {
      const result = await parseSqlite(await fixtureBytes('simple.db'), -1);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rowCount, 1);
        assert.deepStrictEqual(result.data.data.rows[0], ['1', 'Alice', '9.5', '1']);
      }
    });

    it('floors a fractional maxRows', async () => {
      const result = await parseSqlite(await fixtureBytes('simple.db'), 1.9);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rowCount, 1);
      }
    });
  });

  describe('empty.db', () => {
    it('returns headers from the prepared statement with zero rows', async () => {
      const result = await parseSqlite(await fixtureBytes('empty.db'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.data.headers, ['id', 'label']);
        assert.strictEqual(result.data.data.rowCount, 0);
        assert.strictEqual(result.data.data.columnCount, 2);
      }
    });
  });

  describe('multi-table.db', () => {
    it('lists tables and the view, ordered by name, distinguishing type', async () => {
      const result = await parseSqlite(await fixtureBytes('multi-table.db'));
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
      const result = await parseSqlite(await fixtureBytes('multi-table.db'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.selectedTable, 'customer_totals');
      }
    });

    it('reads an explicitly selected table', async () => {
      const result = await parseSqlite(await fixtureBytes('multi-table.db'), undefined, 'orders');
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.selectedTable, 'orders');
        assert.strictEqual(result.data.data.rowCount, 3);
      }
    });

    it('reads a view like any other table', async () => {
      const result = await parseSqlite(await fixtureBytes('multi-table.db'), undefined, 'customer_totals');
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.data.headers, ['name', 'total']);
        assert.strictEqual(result.data.data.rowCount, 2);
      }
    });

    it('falls back to the first table when an unknown table name is requested', async () => {
      const result = await parseSqlite(await fixtureBytes('multi-table.db'), undefined, 'nonexistent');
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.selectedTable, 'customer_totals');
      }
    });
  });

  describe('nulls.db', () => {
    it('renders null cells as empty string', async () => {
      const result = await parseSqlite(await fixtureBytes('nulls.db'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rows[0][1], '');
        assert.strictEqual(result.data.data.rows[1][0], '');
        assert.strictEqual(result.data.data.rows[1][1], '');
        assert.strictEqual(result.data.data.rows[2][1], 'x');
      }
    });
  });

  describe('no-tables.db', () => {
    it('returns success with an empty table list for a valid but empty database', async () => {
      const result = await parseSqlite(await fixtureBytes('no-tables.db'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.tables, []);
        assert.strictEqual(result.data.selectedTable, '');
        assert.strictEqual(result.data.data.columnCount, 0);
      }
    });
  });

  describe('corrupt.db', () => {
    it('returns a clean failure for a non-sqlite file, not a throw', async () => {
      const result = await parseSqlite(await fixtureBytes('corrupt.db'));
      assert.strictEqual(result.success, false);
      if (!result.success) {
        assert.strictEqual(result.errors[0].type, 'SqliteError');
        assert.strictEqual(result.errors[0].code, 'NotASqliteFile');
      }
    });
  });
});

describe('openSqliteDatabase / listSqliteTables / readSqliteTable', () => {
  it('keeps the handle open across multiple readSqliteTable calls', async () => {
    const handle = await openFixture('multi-table.db');
    try {
      const tables = listSqliteTables(handle);
      assert.strictEqual(tables.length, 3);

      const customers = readSqliteTable(handle, 'customers');
      assert.strictEqual(customers.rowCount, 2);

      const orders = readSqliteTable(handle, 'orders');
      assert.strictEqual(orders.rowCount, 3);
    } finally {
      handle.close();
    }
  });

  it('quotes table names safely, even ones containing a double quote', async () => {
    // Not exercised via any committed fixture (sqlite_master names never
    // contain a raw quote there) -- proves quoteIdentifier's escaping
    // doesn't produce broken SQL for a table name SQLite itself allows.
    const handle = await openFixture('empty.db');
    try {
      handle.db.run('CREATE TABLE "wei""rd" (x INTEGER)');
      handle.db.run('INSERT INTO "wei""rd" VALUES (1)');
      const result = readSqliteTable(handle, 'wei"rd');
      assert.strictEqual(result.rowCount, 1);
      assert.deepStrictEqual(result.rows[0], ['1']);
    } finally {
      handle.close();
    }
  });
});

describe('stringifySqliteCell', () => {
  it('renders null as empty string', () => {
    assert.strictEqual(stringifySqliteCell(null), '');
  });

  it('renders numbers and strings via String()', () => {
    assert.strictEqual(stringifySqliteCell(9.5), '9.5');
    assert.strictEqual(stringifySqliteCell(42), '42');
    assert.strictEqual(stringifySqliteCell('hello'), 'hello');
  });

  it('renders a BLOB as a lowercase hex string', () => {
    assert.strictEqual(stringifySqliteCell(new Uint8Array([0, 255, 16])), '00ff10');
  });
});

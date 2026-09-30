import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { statsHooks, statsLimits, STATS_TOO_LARGE_REASON } from '../../src/columnStats';
import {
  listSqliteTables,
  openSqliteDatabase,
  parseSqlite,
  readSqliteTable,
  sqliteTableStats,
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

describe('sqliteTableStats', () => {
  async function withHandle<T>(name: string, fn: (handle: SqliteHandle) => T | Promise<T>): Promise<T> {
    const opened = await openSqliteDatabase(await fixtureBytes(name));
    assert.ok(!('error' in opened));
    const handle = opened as SqliteHandle;
    try {
      return await fn(handle);
    } finally {
      handle.close();
    }
  }

  async function silenced<T>(fn: (reported: unknown[]) => T | Promise<T>): Promise<T> {
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

  function statsFor(name: string, table: string) {
    return withHandle(name, (handle) => sqliteTableStats(handle, table));
  }

  it('computes column stats for simple.db', async () => {
    const stats = (await statsFor('simple.db', 'people'))!;
    assert.deepStrictEqual(
      stats.columns.map((c) => c.type),
      ['integer', 'text', 'float', 'integer']
    );
    assert.strictEqual(stats.columns[0].min, '1');
    assert.strictEqual(stats.columns[0].max, '3');
    assert.strictEqual(stats.columns[0].mean, 2);
    assert.deepStrictEqual(stats.columns[0].histogram, { lo: 1, hi: 3, counts: [1, 1, 1] });
    assert.strictEqual(stats.columns[2].min, '4');
    assert.strictEqual(stats.columns[2].max, '9.5');
    // 0/1 flag: one bin per value.
    assert.deepStrictEqual(stats.columns[3].histogram, { lo: 0, hi: 1, counts: [1, 2] });
  });

  it('counts NULLs (nulls.db)', async () => {
    const stats = (await statsFor('nulls.db', 'readings'))!;
    assert.strictEqual(stats.columns[0].nullCount, 1);
    assert.strictEqual(stats.columns[1].nullCount, 2);
    assert.strictEqual(stats.columns[1].distinctCount, 1);
  });

  it('gives zero-row stats with empty-typed columns (empty.db)', async () => {
    const stats = (await statsFor('empty.db', 'items'))!;
    assert.deepStrictEqual(stats.columns, [
      { type: 'empty', nullCount: 0, distinctCount: 0 },
      { type: 'empty', nullCount: 0, distinctCount: 0 },
    ]);
  });

  it('computes stats for a view as well as tables (multi-table.db)', async () => {
    const view = (await statsFor('multi-table.db', 'customer_totals'))!;
    assert.strictEqual(view.columns.length, 2);
    assert.strictEqual(view.columns[1].type, 'float');
    const orders = (await statsFor('multi-table.db', 'orders'))!;
    assert.strictEqual(orders.columns[2].max, '42');
  });

  describe('stats.db', () => {
    let columns: NonNullable<Awaited<ReturnType<typeof statsFor>>>['columns'];
    before(async () => {
      columns = (await statsFor('stats.db', 'mixed'))!.columns;
    });

    it('keeps exact text for INTEGERs beyond 2^53', () => {
      assert.strictEqual(columns[1].type, 'integer');
      assert.strictEqual(columns[1].min, '1');
      assert.strictEqual(columns[1].max, '9007199254740993');
    });

    it('types by storage class, not declared type', () => {
      assert.strictEqual(columns[2].type, 'float');
      assert.strictEqual(columns[3].type, 'text');
      // declared with no type, holds integer + text + real
      assert.deepStrictEqual(columns[4], { type: 'mixed', nullCount: 1, distinctCount: 3 });
    });

    it('reports BLOB columns as unsummarised with only a null count', () => {
      assert.deepStrictEqual(columns[5], { type: 'other', nullCount: 2 });
    });

    it('reports an all-NULL column as empty', () => {
      assert.deepStrictEqual(columns[6], { type: 'empty', nullCount: 5, distinctCount: 0 });
    });

    it('handles identifiers containing double quotes', () => {
      assert.strictEqual(columns[7].type, 'integer');
      assert.strictEqual(columns[7].max, '50');
    });

    it('buckets float histograms with the max value in the last bin', () => {
      const hist = columns[2].histogram!;
      assert.strictEqual(hist.counts.length, 10);
      assert.strictEqual(hist.counts[9], 1); // ratio 10.0
      assert.strictEqual(
        hist.counts.reduce((a, b) => a + b, 0),
        4
      );
    });

    it('is JSON-safe', () => {
      assert.deepStrictEqual(JSON.parse(JSON.stringify(columns)), columns);
    });

    it('covers a view over the table', async () => {
      const view = (await statsFor('stats.db', 'label_counts'))!;
      assert.strictEqual(view.columns[0].nullCount, 1);
      assert.strictEqual(view.columns[1].max, '2');
    });
  });

  it('covers the whole table, however many rows readSqliteTable returns', async () => {
    await withHandle('stats.db', (handle) => {
      const shown = readSqliteTable(handle, 'mixed', 1);
      assert.strictEqual(shown.rowCount, 1);
      assert.strictEqual('stats' in shown, false, 'stats are no longer attached to the rows');
      assert.strictEqual(sqliteTableStats(handle, 'mixed')!.columns[0].max, '5');
    });
  });

  it('reuses the cached result when a table is asked about again on the same handle', async () => {
    await withHandle('stats.db', (handle) => {
      const first = sqliteTableStats(handle, 'mixed');
      assert.ok(first);
      assert.strictEqual(sqliteTableStats(handle, 'mixed'), first);
    });
  });

  it('skips stats with a reason when the table exceeds the cell cap', async () => {
    const original = statsLimits.sqliteMaxCells;
    try {
      statsLimits.sqliteMaxCells = 4;
      assert.deepStrictEqual(await statsFor('simple.db', 'people'), {
        columns: [],
        skippedReason: STATS_TOO_LARGE_REASON,
      });
    } finally {
      statsLimits.sqliteMaxCells = original;
    }
  });

  describe('when the stats query fails', () => {
    /** A handle whose aggregate queries throw, counting how often they were attempted. */
    function failingHandle(handle: SqliteHandle): { failing: SqliteHandle; attempts: () => number } {
      const realExec = handle.db.exec.bind(handle.db);
      let attempts = 0;
      const failing: SqliteHandle = {
        close: handle.close,
        db: new Proxy(handle.db, {
          get(target, prop) {
            if (prop === 'exec') {
              return (sql: string, params?: never) => {
                if (sql.includes('typeof(')) {
                  attempts++;
                  throw new Error('boom');
                }
                return realExec(sql, params);
              };
            }
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      };
      return { failing, attempts: () => attempts };
    }

    it('reports through statsHooks and returns undefined instead of throwing', async () => {
      await silenced((reported) =>
        withHandle('simple.db', (handle) => {
          const { failing } = failingHandle(handle);
          assert.strictEqual(sqliteTableStats(failing, 'people'), undefined);
          assert.strictEqual(reported.length, 1);
          assert.strictEqual((reported[0] as Error).message, 'boom');
          // ...and the table itself still reads fine.
          assert.strictEqual(readSqliteTable(failing, 'people').rowCount, 3);
        })
      );
    });

    it('remembers the failure instead of re-running the aggregates on every ask', async () => {
      await silenced((reported) =>
        withHandle('simple.db', (handle) => {
          const { failing, attempts } = failingHandle(handle);
          sqliteTableStats(failing, 'people');
          sqliteTableStats(failing, 'people');
          sqliteTableStats(failing, 'people');
          assert.strictEqual(attempts(), 1);
          assert.strictEqual(reported.length, 1);
        })
      );
    });
  });

  it('remembers a skipped (too large) result too', async () => {
    const original = statsLimits.sqliteMaxCells;
    try {
      statsLimits.sqliteMaxCells = 4;
      await withHandle('simple.db', (handle) => {
        const first = sqliteTableStats(handle, 'people');
        statsLimits.sqliteMaxCells = 1_000_000; // would now succeed if recomputed
        assert.strictEqual(sqliteTableStats(handle, 'people'), first);
        assert.strictEqual(first?.skippedReason, STATS_TOO_LARGE_REASON);
      });
    } finally {
      statsLimits.sqliteMaxCells = original;
    }
  });

  it('gives an unknown table no stats, reported rather than thrown', async () => {
    await silenced(async (reported) => {
      await withHandle('simple.db', (handle) => {
        assert.strictEqual(sqliteTableStats(handle, 'no_such_table'), undefined);
        assert.strictEqual(reported.length, 1);
      });
    });
  });
});

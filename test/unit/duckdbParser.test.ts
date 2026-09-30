import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DuckDBInstance } from '@duckdb/node-api';
import { statsHooks, statsLimits, STATS_TIMED_OUT_REASON } from '../../src/columnStats';
import {
  duckdbTableStats,
  listDuckdbTables,
  openDuckdbDatabase,
  parseDuckdb,
  readDuckdbTable,
  runExclusive,
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

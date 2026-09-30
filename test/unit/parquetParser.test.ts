import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { statsHooks, statsLimits, STATS_TOO_LARGE_REASON } from '../../src/columnStats';
import { declaredKind, parquetStats, parseParquet, stringifyCell } from '../../src/parquetParser';
import type { SchemaTree } from 'hyparquet' with { 'resolution-mode': 'import' };

// Use process.cwd() (always the project root) to locate fixtures regardless
// of whether we're running via ts-node or compiled JS in out/.
const fixturesDir = path.join(process.cwd(), 'test', 'fixtures');

async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(path.join(fixturesDir, name)));
}

describe('parseParquet', () => {
  describe('empty content', () => {
    it('returns success with empty data for 0-byte content', async () => {
      const result = await parseParquet(new Uint8Array());
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.headers, []);
        assert.deepStrictEqual(result.data.rows, []);
        assert.strictEqual(result.data.rowCount, 0);
        assert.strictEqual(result.data.columnCount, 0);
      }
    });
  });

  describe('simple.parquet', () => {
    it('parses headers from schema', async () => {
      const result = await parseParquet(await fixtureBytes('simple.parquet'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.headers, ['id', 'name', 'score', 'active']);
      }
    });

    it('parses correct row and column count', async () => {
      const result = await parseParquet(await fixtureBytes('simple.parquet'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.rowCount, 3);
        assert.strictEqual(result.data.columnCount, 4);
        assert.strictEqual(result.data.totalRowCount, 3);
      }
    });

    it('stringifies int64/bool/double columns without throwing', async () => {
      const result = await parseParquet(await fixtureBytes('simple.parquet'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.rows[0], ['1', 'Alice', '9.5', 'true']);
        assert.deepStrictEqual(result.data.rows[1], ['2', 'Bob', '4', 'false']);
      }
    });
  });

  describe('maxRows', () => {
    it('truncates rows and reports the true total via totalRowCount', async () => {
      const result = await parseParquet(await fixtureBytes('simple.parquet'), 2);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.rows.length, 2);
        assert.strictEqual(result.data.rowCount, 2);
        assert.strictEqual(result.data.totalRowCount, 3);
        assert.deepStrictEqual(result.data.rows[0], ['1', 'Alice', '9.5', 'true']);
        assert.deepStrictEqual(result.data.rows[1], ['2', 'Bob', '4', 'false']);
      }
    });

    it('is a no-op when maxRows exceeds the actual row count', async () => {
      const result = await parseParquet(await fixtureBytes('simple.parquet'), 100);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.rowCount, 3);
        assert.strictEqual(result.data.totalRowCount, 3);
      }
    });

    it('clamps a negative maxRows to 1 row instead of an invalid rowEnd', async () => {
      const result = await parseParquet(await fixtureBytes('simple.parquet'), -1);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.rowCount, 1);
        assert.deepStrictEqual(result.data.rows[0], ['1', 'Alice', '9.5', 'true']);
      }
    });

    it('floors a fractional maxRows', async () => {
      const result = await parseParquet(await fixtureBytes('simple.parquet'), 1.9);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.rowCount, 1);
      }
    });
  });

  describe('empty.parquet', () => {
    it('returns headers from schema with zero rows', async () => {
      const result = await parseParquet(await fixtureBytes('empty.parquet'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.headers, ['id', 'name']);
        assert.strictEqual(result.data.rowCount, 0);
        assert.strictEqual(result.data.columnCount, 2);
      }
    });
  });

  describe('nulls.parquet', () => {
    it('renders null cells as empty string', async () => {
      const result = await parseParquet(await fixtureBytes('nulls.parquet'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.rows[1][0], '');
        assert.strictEqual(result.data.rows[0][1], '');
        assert.strictEqual(result.data.rows[1][1], '');
        assert.strictEqual(result.data.rows[2][1], 'x');
      }
    });
  });

  describe('nested.parquet', () => {
    it('flattens a struct column into a JSON cell, end-to-end', async () => {
      const result = await parseParquet(await fixtureBytes('nested.parquet'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.headers, ['id', 'info']);
        assert.strictEqual(result.data.rows[0][0], '1');
        assert.strictEqual(result.data.rows[0][1], '{"x":"1","y":"a"}');
        assert.strictEqual(result.data.rows[1][1], '{"x":"2","y":"b"}');
      }
    });
  });

  describe('unsupported-codec.parquet', () => {
    it('returns a clean failure for a gzip-compressed file', async () => {
      const result = await parseParquet(await fixtureBytes('unsupported-codec.parquet'));
      assert.strictEqual(result.success, false);
      if (!result.success) {
        assert.match(result.errors[0].message, /compression codec/i);
      }
    });
  });

  describe('corrupt.parquet', () => {
    it('returns a clean failure for a non-parquet file, not a throw', async () => {
      const result = await parseParquet(await fixtureBytes('corrupt.parquet'));
      assert.strictEqual(result.success, false);
      if (!result.success) {
        assert.strictEqual(result.errors[0].type, 'ParquetError');
      }
    });
  });
});

describe('stringifyCell', () => {
  it('renders bigint via toString', () => {
    assert.strictEqual(stringifyCell(42n), '42');
  });

  it('renders boolean as "true"/"false"', () => {
    assert.strictEqual(stringifyCell(true), 'true');
    assert.strictEqual(stringifyCell(false), 'false');
  });

  it('renders Date as an ISO string', () => {
    const date = new Date('2023-11-14T22:13:20.000Z');
    assert.strictEqual(stringifyCell(date), '2023-11-14T22:13:20.000Z');
  });

  it('renders null/undefined as empty string', () => {
    assert.strictEqual(stringifyCell(null), '');
    assert.strictEqual(stringifyCell(undefined), '');
  });

  it('renders numbers and strings via String()', () => {
    assert.strictEqual(stringifyCell(9.5), '9.5');
    assert.strictEqual(stringifyCell('hello'), 'hello');
  });

  it('renders nested struct/list values as JSON, bigint-safe', () => {
    assert.strictEqual(stringifyCell({ a: 1n, b: 'x' }), '{"a":"1","b":"x"}');
    assert.strictEqual(stringifyCell([1n, 2n]), '["1","2"]');
  });
});

describe('parquetStats', () => {
  async function statsOf(name: string) {
    return parquetStats(await fixtureBytes(name));
  }

  it('computes column stats for simple.parquet', async () => {
    const stats = (await statsOf('simple.parquet'))!;
    assert.deepStrictEqual(
      stats.columns.map((c) => c.type),
      ['integer', 'text', 'float', 'boolean']
    );
    // id is int64 (bigint in JS) -- must still produce plain-number stats.
    assert.strictEqual(stats.columns[0].min, '1');
    assert.strictEqual(stats.columns[0].max, '3');
    assert.strictEqual(stats.columns[0].mean, 2);
    assert.deepStrictEqual(stats.columns[0].histogram, { lo: 1, hi: 3, counts: [1, 1, 1] });
    assert.strictEqual(stats.columns[2].min, '4');
    assert.strictEqual(stats.columns[2].max, '9.5');
  });

  it('counts nulls (nulls.parquet)', async () => {
    const stats = (await statsOf('nulls.parquet'))!;
    assert.strictEqual(stats.columns[0].nullCount, 1);
    assert.strictEqual(stats.columns[1].nullCount, 2);
  });

  it('falls back to the declared type for zero-row files (empty.parquet)', async () => {
    const stats = (await statsOf('empty.parquet'))!;
    assert.deepStrictEqual(stats.columns, [
      { type: 'integer', nullCount: 0, distinctCount: 0 },
      { type: 'text', nullCount: 0, distinctCount: 0 },
    ]);
  });

  it('reports struct columns as unsummarised', async () => {
    const stats = (await statsOf('nested.parquet'))!;
    assert.deepStrictEqual(stats.columns[1], { type: 'other', nullCount: 0 });
  });

  describe('stats.parquet (3 row groups, every type)', () => {
    let columns: NonNullable<Awaited<ReturnType<typeof statsOf>>>['columns'];
    before(async () => {
      columns = (await statsOf('stats.parquet'))!.columns;
    });

    it('reads every row group: null counts add up across all 3 groups', () => {
      // Guards the row-group loop's rowStart/rowEnd bookkeeping: the null in
      // row 3 lives in the last-but-one group, all_null spans every group.
      assert.deepStrictEqual(
        columns.map((c) => c.nullCount),
        [0, 1, 1, 1, 1, 1, 1, 1, 1, 5]
      );
    });

    it('keeps exact text for int64 beyond 2^53 as min/max', () => {
      assert.strictEqual(columns[1].type, 'integer');
      assert.strictEqual(columns[1].min, '1');
      assert.strictEqual(columns[1].max, '9007199254740993');
      assert.strictEqual(columns[1].distinctCount, 4);
    });

    it('excludes NaN from min/max/mean/histogram but counts it as distinct', () => {
      const score = columns[2];
      assert.strictEqual(score.type, 'float');
      assert.strictEqual(score.min, '1.5');
      assert.strictEqual(score.max, '4');
      assert.strictEqual(score.distinctCount, 4);
      assert.ok(Number.isFinite(score.mean));
      assert.strictEqual(
        score.histogram!.counts.reduce((a, b) => a + b, 0),
        3
      );
    });

    it('types booleans, timestamps, dates and strings', () => {
      assert.strictEqual(columns[3].type, 'boolean');
      assert.deepStrictEqual([columns[4].type, columns[4].min, columns[4].max], [
        'date',
        '2019-03-01T00:00:00.000Z',
        '2021-06-01T00:00:00.000Z',
      ]);
      assert.strictEqual(columns[5].type, 'date');
      assert.deepStrictEqual([columns[6].type, columns[6].min, columns[6].max], ['text', 'a', 'c']);
    });

    it('treats decimals as float with numeric stats', () => {
      assert.strictEqual(columns[7].type, 'float');
      assert.strictEqual(columns[7].min, '1.5');
      assert.strictEqual(columns[7].max, '10');
    });

    it('leaves lists unsummarised and an all-null column at its declared type', () => {
      assert.deepStrictEqual(columns[8], { type: 'other', nullCount: 1 });
      assert.deepStrictEqual(columns[9], { type: 'integer', nullCount: 5, distinctCount: 0 });
    });

    it('is JSON-safe (no bigint / NaN / Infinity / Date)', () => {
      assert.deepStrictEqual(JSON.parse(JSON.stringify(columns)), columns);
    });
  });

  it('covers the whole file, however many rows parseParquet returns', async () => {
    const shown = await parseParquet(await fixtureBytes('stats.parquet'), 1);
    assert.ok(shown.success);
    if (shown.success) {
      assert.strictEqual(shown.data.rowCount, 1);
      assert.strictEqual('stats' in shown.data, false, 'stats are no longer attached to the rows');
    }
    assert.strictEqual((await statsOf('stats.parquet'))!.columns[0].max, '5');
  });

  it('has nothing to say about empty input', async () => {
    assert.strictEqual(await parquetStats(new Uint8Array()), undefined);
  });

  describe('when the file cannot be read', () => {
    async function withSilencedHook(fn: (reported: unknown[]) => Promise<void>) {
      const original = statsHooks.onError;
      const reported: unknown[] = [];
      statsHooks.onError = (err) => {
        reported.push(err);
      };
      try {
        await fn(reported);
      } finally {
        statsHooks.onError = original;
      }
    }

    it('reports a corrupt file through statsHooks and returns undefined instead of throwing', async () => {
      await withSilencedHook(async (reported) => {
        assert.strictEqual(await statsOf('corrupt.parquet'), undefined);
        assert.strictEqual(reported.length, 1);
      });
    });

    it('does the same for an unsupported compression codec', async () => {
      await withSilencedHook(async (reported) => {
        assert.strictEqual(await statsOf('unsupported-codec.parquet'), undefined);
        assert.strictEqual(reported.length, 1);
      });
    });
  });

  it('spends one distinct-value budget across all columns', async () => {
    const original = statsLimits.distinctBudget;
    try {
      statsLimits.distinctBudget = 5;
      const stats = (await statsOf('stats.parquet'))!;
      const tracked = stats.columns.reduce((sum, c) => sum + (c.distinctCount ?? 0), 0);
      assert.strictEqual(tracked, 5);
      assert.ok(stats.columns.some((c) => c.distinctIsLowerBound));
    } finally {
      statsLimits.distinctBudget = original;
    }
  });

  it('skips stats with a reason when the file exceeds the cell cap', async () => {
    const original = statsLimits.maxCells;
    try {
      statsLimits.maxCells = 4;
      assert.deepStrictEqual(await statsOf('simple.parquet'), {
        columns: [],
        skippedReason: STATS_TOO_LARGE_REASON,
      });
    } finally {
      statsLimits.maxCells = original;
    }
  });
});

describe('declaredKind', () => {
  function col(
    element: Partial<SchemaTree['element']>,
    children: SchemaTree[] = []
  ): SchemaTree {
    return { children, count: 1, path: ['c'], element: { name: 'c', ...element } };
  }

  it('maps physical types', () => {
    assert.strictEqual(declaredKind(col({ type: 'BOOLEAN' })), 'boolean');
    assert.strictEqual(declaredKind(col({ type: 'INT32' })), 'integer');
    assert.strictEqual(declaredKind(col({ type: 'INT64' })), 'integer');
    assert.strictEqual(declaredKind(col({ type: 'FLOAT' })), 'float');
    assert.strictEqual(declaredKind(col({ type: 'DOUBLE' })), 'float');
    assert.strictEqual(declaredKind(col({ type: 'INT96' })), 'date');
    assert.strictEqual(declaredKind(col({ type: 'BYTE_ARRAY' })), 'text');
    assert.strictEqual(declaredKind(col({ type: 'FIXED_LEN_BYTE_ARRAY' })), 'other');
  });

  it('lets logical/converted types override the physical type', () => {
    assert.strictEqual(declaredKind(col({ type: 'INT32', converted_type: 'DATE' })), 'date');
    assert.strictEqual(
      declaredKind(col({ type: 'INT64', logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MILLIS' } })),
      'date'
    );
    assert.strictEqual(declaredKind(col({ type: 'INT32', converted_type: 'DECIMAL' })), 'float');
    assert.strictEqual(
      declaredKind(col({ type: 'FIXED_LEN_BYTE_ARRAY', logical_type: { type: 'DECIMAL', precision: 10, scale: 2 } })),
      'float'
    );
    assert.strictEqual(declaredKind(col({ type: 'BYTE_ARRAY', converted_type: 'JSON' })), 'other');
    assert.strictEqual(declaredKind(col({ type: 'INT32', converted_type: 'TIME_MILLIS' })), 'other');
    assert.strictEqual(declaredKind(col({ type: 'FIXED_LEN_BYTE_ARRAY', logical_type: { type: 'UUID' } })), 'text');
  });

  it('treats nested and repeated columns as other', () => {
    assert.strictEqual(declaredKind(col({}, [col({ type: 'INT32' })])), 'other');
    assert.strictEqual(declaredKind(col({ type: 'INT32', repetition_type: 'REPEATED' })), 'other');
  });
});

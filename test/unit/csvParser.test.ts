import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { csvStats, parseCsv } from '../../src/csvParser';
import { statsHooks, statsLimits, STATS_TOO_LARGE_REASON } from '../../src/columnStats';

// Use process.cwd() (always the project root) to locate fixtures regardless
// of whether we're running via ts-node or compiled JS in out/.
const fixturesDir = path.join(process.cwd(), 'test', 'fixtures');

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf-8');
}

describe('parseCsv', () => {
  describe('empty file', () => {
    it('returns success with empty data for 0-byte content', () => {
      const result = parseCsv('');
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.headers, []);
        assert.deepStrictEqual(result.data.rows, []);
        assert.strictEqual(result.data.rowCount, 0);
        assert.strictEqual(result.data.columnCount, 0);
      }
    });

    it('returns success with empty data for whitespace-only content', () => {
      const result = parseCsv('   \n   \n');
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.headers, []);
        assert.deepStrictEqual(result.data.rows, []);
      }
    });

    it('returns success for empty.csv fixture', () => {
      const result = parseCsv(fixture('empty.csv'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.rowCount, 0);
        assert.strictEqual(result.data.columnCount, 0);
      }
    });
  });

  describe('headers-only file', () => {
    it('returns headers with no rows', () => {
      const result = parseCsv(fixture('headers-only.csv'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.headers, ['name', 'age', 'city']);
        assert.strictEqual(result.data.rows.length, 0);
        assert.strictEqual(result.data.rowCount, 0);
        assert.strictEqual(result.data.columnCount, 3);
      }
    });
  });

  describe('simple CSV', () => {
    it('parses headers correctly', () => {
      const result = parseCsv(fixture('simple.csv'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.headers, ['name', 'age', 'city']);
      }
    });

    it('parses correct row count', () => {
      const result = parseCsv(fixture('simple.csv'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.rowCount, 3);
        assert.strictEqual(result.data.columnCount, 3);
        assert.strictEqual(result.data.totalRowCount, 3);
      }
    });

    it('parses row values correctly', () => {
      const result = parseCsv(fixture('simple.csv'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.rows[0], ['Alice', '30', 'New York']);
        assert.deepStrictEqual(result.data.rows[1], ['Bob', '25', 'London']);
        assert.deepStrictEqual(result.data.rows[2], ['Carol', '35', 'Paris']);
      }
    });
  });

  describe('quoted cells', () => {
    it('handles commas inside quoted cells', () => {
      const result = parseCsv(fixture('quoted.csv'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.headers.length, 3);
        assert.strictEqual(result.data.rowCount, 3);
      }
    });

    it('handles embedded double-quotes', () => {
      const result = parseCsv(fixture('quoted.csv'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.ok(result.data.rows[0][1].includes('"hello"'));
      }
    });

    it('handles embedded newlines inside quoted cells', () => {
      const result = parseCsv(fixture('quoted.csv'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.ok(result.data.rows[1][1].includes('\n'));
      }
    });
  });

  describe('semicolon delimiter', () => {
    it('auto-detects semicolon delimiter', () => {
      const result = parseCsv(fixture('semicolon.csv'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.headers, ['name', 'age', 'city']);
        assert.strictEqual(result.data.rowCount, 3);
      }
    });

    it('parses semicolon-delimited values correctly', () => {
      const result = parseCsv(fixture('semicolon.csv'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.rows[0], ['Alice', '30', 'New York']);
      }
    });
  });

  describe('multiline cells', () => {
    it('parses cells with embedded newlines', () => {
      const result = parseCsv(fixture('multiline.csv'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.rowCount, 3);
        assert.ok(result.data.rows[0][1].includes('\n'));
      }
    });
  });

  describe('maxRows', () => {
    it('truncates rows and reports the true total via totalRowCount', () => {
      const result = parseCsv(fixture('simple.csv'), 2);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.rows.length, 2);
        assert.strictEqual(result.data.rowCount, 2);
        assert.strictEqual(result.data.totalRowCount, 3);
        assert.deepStrictEqual(result.data.rows[0], ['Alice', '30', 'New York']);
        assert.deepStrictEqual(result.data.rows[1], ['Bob', '25', 'London']);
      }
    });

    it('is a no-op when maxRows exceeds the actual row count', () => {
      const result = parseCsv(fixture('simple.csv'), 100);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.rowCount, 3);
        assert.strictEqual(result.data.totalRowCount, 3);
      }
    });

    it('clamps a negative maxRows to 1 row instead of slicing from the end', () => {
      // A raw Array.slice(0, -1) would mean "all but the last row" --
      // clampMaxRows must intercept this before it reaches the slice.
      const result = parseCsv(fixture('simple.csv'), -1);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.rowCount, 1);
        assert.deepStrictEqual(result.data.rows[0], ['Alice', '30', 'New York']);
      }
    });

    it('floors a fractional maxRows', () => {
      const result = parseCsv(fixture('simple.csv'), 1.9);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.rowCount, 1);
      }
    });

    it('clamps a zero maxRows up to 1 row rather than returning none', () => {
      const result = parseCsv(fixture('simple.csv'), 0);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.rowCount, 1);
      }
    });
  });

  describe('inline content', () => {
    it('parses simple inline CSV string', () => {
      const csv = 'a,b,c\n1,2,3\n4,5,6';
      const result = parseCsv(csv);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.headers, ['a', 'b', 'c']);
        assert.strictEqual(result.data.rowCount, 2);
        assert.deepStrictEqual(result.data.rows[0], ['1', '2', '3']);
        assert.deepStrictEqual(result.data.rows[1], ['4', '5', '6']);
      }
    });

    it('trims whitespace from headers', () => {
      const csv = ' name , age , city \nAlice,30,NY';
      const result = parseCsv(csv);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.headers, ['name', 'age', 'city']);
      }
    });

    it('all values remain as strings (dynamicTyping disabled)', () => {
      const csv = 'x,y\n1,2\ntrue,false';
      const result = parseCsv(csv);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(typeof result.data.rows[0][0], 'string');
        assert.strictEqual(typeof result.data.rows[1][0], 'string');
      }
    });
  });
});

describe('csvStats', () => {
  it('computes per-column stats for simple.csv', () => {
    const stats = csvStats(fixture('simple.csv'))!;
    assert.strictEqual(stats.columns.length, 3);
    const [name, age, city] = stats.columns;
    assert.strictEqual(name.type, 'text');
    assert.strictEqual(name.min, 'Alice');
    assert.strictEqual(name.max, 'Carol');
    assert.strictEqual(age.type, 'integer');
    assert.strictEqual(age.min, '25');
    assert.strictEqual(age.max, '35');
    assert.strictEqual(age.mean, 30);
    assert.strictEqual(age.nullCount, 0);
    assert.strictEqual(city.distinctCount, 3);
  });

  it('counts empty cells as nulls', () => {
    const stats = csvStats('a,b\n1,\n,x\n3,y')!;
    assert.strictEqual(stats.columns[0].nullCount, 1);
    assert.strictEqual(stats.columns[1].nullCount, 1);
  });

  it('covers every row: it does not depend on how many rows parseCsv returns', () => {
    const csv = 'n\n' + Array.from({ length: 50 }, (_, i) => String(i + 1)).join('\n');
    const shown = parseCsv(csv, 5);
    assert.ok(shown.success);
    if (shown.success) {
      assert.strictEqual(shown.data.rowCount, 5);
    }
    assert.strictEqual(csvStats(csv)!.columns[0].max, '50');
  });

  it('returns nothing for blank content and gives empty-typed columns for headers-only', () => {
    assert.strictEqual(csvStats(''), undefined);
    assert.strictEqual(csvStats('   \n  '), undefined);
    const stats = csvStats(fixture('headers-only.csv'))!;
    assert.strictEqual(stats.columns.length, 3);
    assert.ok(stats.columns.every((c) => c.type === 'empty' && c.nullCount === 0));
  });

  it('skips with a reason when the table exceeds the cell cap', () => {
    const original = statsLimits.maxCells;
    try {
      statsLimits.maxCells = 3;
      assert.deepStrictEqual(csvStats('a,b\n1,2\n3,4'), { columns: [], skippedReason: STATS_TOO_LARGE_REASON });
    } finally {
      statsLimits.maxCells = original;
    }
  });

  it('is JSON-safe (it crosses postMessage)', () => {
    const stats = csvStats('a,b\n1.5,x\n2,y\n3,')!;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(stats)), stats);
  });

  it('never throws: an unexpected failure is reported through statsHooks and yields undefined', () => {
    const original = statsLimits.maxCells;
    const originalHook = statsHooks.onError;
    const reported: unknown[] = [];
    statsHooks.onError = (err) => {
      reported.push(err);
    };
    try {
      // Make reading the cap throw, standing in for any unexpected failure inside stats.
      Object.defineProperty(statsLimits, 'maxCells', {
        configurable: true,
        get() {
          throw new Error('boom');
        },
      });
      assert.strictEqual(csvStats('a\n1'), undefined);
      assert.strictEqual(reported.length, 1);
      assert.strictEqual((reported[0] as Error).message, 'boom');
    } finally {
      Object.defineProperty(statsLimits, 'maxCells', { configurable: true, writable: true, value: original });
      statsHooks.onError = originalHook;
    }
  });
});

describe('parseCsv no longer carries stats', () => {
  it('leaves stats to csvStats', () => {
    const result = parseCsv(fixture('simple.csv'));
    assert.ok(result.success);
    if (result.success) {
      assert.strictEqual('stats' in result.data, false);
    }
  });
});

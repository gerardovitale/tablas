import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseParquet, stringifyCell } from '../../src/parquetParser';

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

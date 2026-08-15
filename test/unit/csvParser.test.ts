import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseCsv, ParsedCsv } from '../../src/csvParser';

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

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseXlsx } from '../../src/xlsxParser';

// Use process.cwd() (always the project root) to locate fixtures regardless
// of whether we're running via ts-node or compiled JS in out/.
const fixturesDir = path.join(process.cwd(), 'test', 'fixtures');

async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(path.join(fixturesDir, name)));
}

describe('parseXlsx', () => {
  describe('empty content', () => {
    it('returns success with empty data for 0-byte content', async () => {
      const result = await parseXlsx(new Uint8Array());
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.tables, []);
        assert.strictEqual(result.data.selectedTable, '');
        assert.deepStrictEqual(result.data.data.headers, []);
        assert.strictEqual(result.data.data.rowCount, 0);
      }
    });
  });

  describe('simple.xlsx', () => {
    it('parses headers from row 1', async () => {
      const result = await parseXlsx(await fixtureBytes('simple.xlsx'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.tables, [{ name: 'people', type: 'table' }]);
        assert.strictEqual(result.data.selectedTable, 'people');
        assert.deepStrictEqual(result.data.data.headers, ['id', 'name', 'score', 'active']);
      }
    });

    it('parses correct row and column count', async () => {
      const result = await parseXlsx(await fixtureBytes('simple.xlsx'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rowCount, 3);
        assert.strictEqual(result.data.data.columnCount, 4);
        assert.strictEqual(result.data.data.totalRowCount, 3);
      }
    });

    it('stringifies number/string/bool cells via cell.text', async () => {
      const result = await parseXlsx(await fixtureBytes('simple.xlsx'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.data.rows[0], ['1', 'Alice', '9.5', 'true']);
        assert.deepStrictEqual(result.data.data.rows[1], ['2', 'Bob', '4', 'false']);
      }
    });
  });

  describe('maxRows', () => {
    it('truncates rows and reports the true total via totalRowCount', async () => {
      const result = await parseXlsx(await fixtureBytes('simple.xlsx'), 2);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rows.length, 2);
        assert.strictEqual(result.data.data.rowCount, 2);
        assert.strictEqual(result.data.data.totalRowCount, 3);
      }
    });

    it('is a no-op when maxRows exceeds the actual row count', async () => {
      const result = await parseXlsx(await fixtureBytes('simple.xlsx'), 100);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rowCount, 3);
        assert.strictEqual(result.data.data.totalRowCount, 3);
      }
    });

    it('clamps a negative maxRows to 1 row instead of an invalid range', async () => {
      const result = await parseXlsx(await fixtureBytes('simple.xlsx'), -1);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rowCount, 1);
        assert.deepStrictEqual(result.data.data.rows[0], ['1', 'Alice', '9.5', 'true']);
      }
    });

    it('floors a fractional maxRows', async () => {
      const result = await parseXlsx(await fixtureBytes('simple.xlsx'), 1.9);
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rowCount, 1);
      }
    });
  });

  describe('empty.xlsx', () => {
    it('returns headers from row 1 with zero data rows', async () => {
      const result = await parseXlsx(await fixtureBytes('empty.xlsx'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.data.headers, ['id', 'label']);
        assert.strictEqual(result.data.data.rowCount, 0);
        assert.strictEqual(result.data.data.columnCount, 2);
        assert.strictEqual(result.data.data.totalRowCount, 0);
      }
    });
  });

  describe('multi-sheet.xlsx', () => {
    it('lists every sheet and defaults to the first one', async () => {
      const result = await parseXlsx(await fixtureBytes('multi-sheet.xlsx'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.deepStrictEqual(result.data.tables, [
          { name: 'customers', type: 'table' },
          { name: 'orders', type: 'table' },
        ]);
        assert.strictEqual(result.data.selectedTable, 'customers');
        assert.strictEqual(result.data.data.rowCount, 2);
      }
    });

    it('reads the requested sheet when selectedSheet is given', async () => {
      const result = await parseXlsx(await fixtureBytes('multi-sheet.xlsx'), undefined, 'orders');
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.selectedTable, 'orders');
        assert.strictEqual(result.data.data.rowCount, 3);
      }
    });

    it('falls back to the first sheet when asked for one that does not exist', async () => {
      const result = await parseXlsx(await fixtureBytes('multi-sheet.xlsx'), undefined, 'nope');
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.selectedTable, 'customers');
      }
    });
  });

  describe('nulls.xlsx', () => {
    it('renders blank cells as empty string', async () => {
      const result = await parseXlsx(await fixtureBytes('nulls.xlsx'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        assert.strictEqual(result.data.data.rows[0][1], '');
        assert.strictEqual(result.data.data.rows[1][0], '');
        assert.strictEqual(result.data.data.rows[1][1], '');
        assert.strictEqual(result.data.data.rows[2][1], 'x');
      }
    });
  });

  describe('dates-and-formulas.xlsx', () => {
    it('formats a Date cell and resolves a formula cell to its cached result', async () => {
      const result = await parseXlsx(await fixtureBytes('dates-and-formulas.xlsx'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        const [, when, total] = result.data.data.rows[0];
        assert.match(when, /2023/);
        assert.strictEqual(total, '6');
      }
    });
  });

  describe('corrupt.xlsx', () => {
    it('returns a clean failure for a non-xlsx file, not a throw', async () => {
      const result = await parseXlsx(await fixtureBytes('corrupt.xlsx'));
      assert.strictEqual(result.success, false);
      if (!result.success) {
        assert.strictEqual(result.errors[0].type, 'XlsxError');
        assert.strictEqual(result.errors[0].code, 'NotAnXlsxFile');
      }
    });
  });
});

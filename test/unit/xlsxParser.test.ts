import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Workbook, type Worksheet } from 'exceljs';
import { statsHooks, statsLimits, STATS_TOO_LARGE_REASON } from '../../src/columnStats';
import { listXlsxSheets, openXlsxWorkbook, parseXlsx, readXlsxSheet, xlsxSheetStats } from '../../src/xlsxParser';
import type { TableStats } from '../../src/tableData';

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

describe('xlsxSheetStats', () => {
  async function sheetOf(bytes: Uint8Array, sheetName?: string): Promise<Worksheet> {
    const opened = await openXlsxWorkbook(bytes);
    assert.ok('workbook' in opened);
    const workbook = (opened as { workbook: Workbook }).workbook;
    return sheetName ? workbook.getWorksheet(sheetName)! : workbook.worksheets[0];
  }

  async function statsOf(fixtureName: string, sheetName?: string): Promise<TableStats | undefined> {
    return xlsxSheetStats(await sheetOf(await fixtureBytes(fixtureName), sheetName));
  }

  // exceljs is a runtime dependency already, so edge cases are built in memory
  // rather than adding another binary fixture.
  async function edgeCaseWorkbookBytes(): Promise<Uint8Array> {
    const wb = new Workbook();
    const ws = wb.addWorksheet('edge');
    ws.addRow(['n', 'flag', 'z', 'mix', 'err', 'rt', 'd', 'm']);
    ws.getRow(2).values = [
      1, true, { formula: 'A2-A2', result: 0 }, 1, { error: '#N/A' },
      { richText: [{ text: 'a' }, { text: 'b' }] }, new Date(Date.UTC(2020, 0, 1)), 5,
    ];
    ws.getRow(3).values = [
      2, false, { formula: '2+2', result: 4 }, 'x', 'ok',
      { text: 'link', hyperlink: 'http://example.com' }, new Date(Date.UTC(2021, 0, 1)),
    ];
    // Row 4 intentionally never created: a fully sparse row must count as nulls.
    ws.getRow(5).values = [3.5, true, { formula: '1', result: 4 }, 2, 'ok', 'zz', new Date(Date.UTC(2020, 6, 1))];
    ws.getRow(6).values = [null, false, { formula: '1', result: 0 }, 3, 'ok', 'zz'];
    ws.mergeCells('H2:H3');
    return new Uint8Array(await wb.xlsx.writeBuffer());
  }

  it('computes column stats for simple.xlsx', async () => {
    const stats = (await statsOf('simple.xlsx'))!;
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

  it('counts blank cells as nulls (nulls.xlsx)', async () => {
    const stats = (await statsOf('nulls.xlsx'))!;
    assert.strictEqual(stats.columns[0].nullCount, 1);
    assert.strictEqual(stats.columns[1].nullCount, 2);
    assert.strictEqual(stats.columns[1].distinctCount, 1);
  });

  it('classifies dates and formula results (dates-and-formulas.xlsx)', async () => {
    const stats = (await statsOf('dates-and-formulas.xlsx'))!;
    assert.deepStrictEqual(
      stats.columns.map((c) => c.type),
      ['text', 'date', 'integer']
    );
    assert.strictEqual(stats.columns[2].min, '6');
  });

  it('gives zero-row stats with empty-typed columns (empty.xlsx)', async () => {
    const stats = (await statsOf('empty.xlsx'))!;
    assert.strictEqual(stats.columns.length, 2);
    assert.ok(stats.columns.every((c) => c.type === 'empty' && c.nullCount === 0));
  });

  it('has nothing to say about a sheet with no cells at all', () => {
    assert.strictEqual(xlsxSheetStats(new Workbook().addWorksheet('blank')), undefined);
  });

  it('computes stats per sheet of a multi-sheet workbook', async () => {
    const bytes = await fixtureBytes('multi-sheet.xlsx');
    const opened = await openXlsxWorkbook(bytes);
    assert.ok('workbook' in opened);
    const workbook = (opened as { workbook: Workbook }).workbook;
    for (const { name } of listXlsxSheets(workbook)) {
      const ws = workbook.getWorksheet(name)!;
      assert.strictEqual(xlsxSheetStats(ws)?.columns.length, ws.columnCount, name);
    }
  });

  it('covers the whole sheet, however many rows readXlsxSheet returns', async () => {
    const ws = await sheetOf(await fixtureBytes('simple.xlsx'));
    assert.strictEqual(readXlsxSheet(ws, 1).rowCount, 1);
    assert.strictEqual(xlsxSheetStats(ws)!.columns[0].max, '3');
  });

  it('is no longer attached to the rows readXlsxSheet returns', async () => {
    const ws = await sheetOf(await fixtureBytes('simple.xlsx'));
    assert.strictEqual('stats' in readXlsxSheet(ws), false);
  });

  describe('in-memory edge cases', () => {
    let stats: TableStats;
    before(async () => {
      stats = xlsxSheetStats(await sheetOf(await edgeCaseWorkbookBytes()))!;
    });

    it('treats sparse rows and blank cells as nulls', () => {
      // Row 4 is missing entirely and row 6 has no value in column A.
      assert.strictEqual(stats.columns[0].type, 'float');
      assert.strictEqual(stats.columns[0].nullCount, 2);
    });

    it('resolves formulas to their cached result, including 0', () => {
      const z = stats.columns[2];
      assert.strictEqual(z.type, 'integer');
      assert.strictEqual(z.min, '0');
      assert.strictEqual(z.max, '4');
      assert.strictEqual(z.nullCount, 1); // only the fully sparse row 4
    });

    it('marks a numbers+text column as mixed', () => {
      assert.strictEqual(stats.columns[3].type, 'mixed');
    });

    it('treats error cells as text', () => {
      const err = stats.columns[4];
      assert.strictEqual(err.type, 'text');
      assert.strictEqual(err.min, '#N/A');
      assert.strictEqual(err.max, 'ok');
    });

    it('flattens rich text and hyperlinks to text', () => {
      const rt = stats.columns[5];
      assert.strictEqual(rt.type, 'text');
      assert.strictEqual(rt.min, 'ab');
      assert.strictEqual(rt.max, 'zz');
      assert.strictEqual(rt.distinctCount, 3);
    });

    it('reports date columns with min/max', () => {
      const d = stats.columns[6];
      assert.strictEqual(d.type, 'date');
      assert.strictEqual(d.distinctCount, 3);
      assert.ok(d.min && d.max);
    });

    it('counts a merged range as its master value in every merged cell', () => {
      const m = stats.columns[7];
      assert.strictEqual(m.type, 'integer');
      assert.strictEqual(m.distinctCount, 1);
      assert.strictEqual(m.nullCount, 3);
    });

    it('survives a JSON round-trip', () => {
      assert.deepStrictEqual(JSON.parse(JSON.stringify(stats)), stats);
    });
  });

  it('counts falsy formula results (0 and false) as values, not nulls', async () => {
    // exceljs's cell.value getter drops falsy formula results; the parser must
    // read cell.result instead.
    const wb = new Workbook();
    const ws = wb.addWorksheet('f');
    ws.addRow(['n', 'flag']);
    ws.getRow(2).values = [{ formula: '1-1', result: 0 }, { formula: '1=0', result: false }];
    ws.getRow(3).values = [{ formula: '1+1', result: 2 }, { formula: '1=1', result: true }];
    const stats = xlsxSheetStats(await sheetOf(new Uint8Array(await wb.xlsx.writeBuffer())))!;
    assert.strictEqual(stats.columns[0].min, '0');
    assert.strictEqual(stats.columns[0].nullCount, 0);
    assert.strictEqual(stats.columns[1].type, 'boolean');
    assert.strictEqual(stats.columns[1].nullCount, 0);
    assert.strictEqual(stats.columns[1].distinctCount, 2);
  });

  it('reuses the cached result when the same sheet is asked again', async () => {
    const ws = await sheetOf(await fixtureBytes('simple.xlsx'));
    assert.strictEqual(xlsxSheetStats(ws), xlsxSheetStats(ws));
  });

  it('skips with a reason when the sheet exceeds the cell cap', async () => {
    const original = statsLimits.maxCells;
    try {
      statsLimits.maxCells = 2;
      assert.deepStrictEqual(await statsOf('simple.xlsx'), { columns: [], skippedReason: STATS_TOO_LARGE_REASON });
    } finally {
      statsLimits.maxCells = original;
    }
  });

  it('spends one distinct-value budget across the whole sheet', async () => {
    const original = statsLimits.distinctBudget;
    try {
      statsLimits.distinctBudget = 4;
      // simple.xlsx has 3 unique ids + 3 unique names + 3 unique scores + 2 bools;
      // only 4 keys may be tracked in total.
      const stats = (await statsOf('simple.xlsx'))!;
      const tracked = stats.columns.reduce((sum, c) => sum + (c.distinctCount ?? 0), 0);
      assert.strictEqual(tracked, 4);
      assert.ok(stats.columns.some((c) => c.distinctIsLowerBound));
    } finally {
      statsLimits.distinctBudget = original;
    }
  });

  describe('when computing fails', () => {
    function failingSheet(ws: Worksheet): { sheet: Worksheet; findRowCalls: () => number } {
      let calls = 0;
      const sheet = new Proxy(ws, {
        get(target, prop) {
          if (prop === 'findRow') {
            return () => {
              calls++;
              throw new Error('boom');
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return { sheet, findRowCalls: () => calls };
    }

    it('reports through statsHooks, returns undefined, and remembers the failure', async () => {
      const original = statsHooks.onError;
      const reported: unknown[] = [];
      statsHooks.onError = (err) => {
        reported.push(err);
      };
      try {
        const { sheet, findRowCalls } = failingSheet(await sheetOf(await fixtureBytes('simple.xlsx')));
        assert.strictEqual(xlsxSheetStats(sheet), undefined);
        assert.strictEqual(reported.length, 1);
        assert.strictEqual((reported[0] as Error).message, 'boom');
        const callsAfterFirst = findRowCalls();
        assert.strictEqual(xlsxSheetStats(sheet), undefined);
        assert.strictEqual(findRowCalls(), callsAfterFirst, 'a cached failure must not be retried');
        assert.strictEqual(reported.length, 1);
      } finally {
        statsHooks.onError = original;
      }
    });
  });
});

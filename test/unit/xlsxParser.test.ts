import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Workbook, type Worksheet } from 'exceljs';
import { statsHooks, statsLimits, STATS_TOO_LARGE_REASON } from '../../src/columnStats';
import { formatXlsxDate, listXlsxSheets, openXlsxWorkbook, parseXlsx, readXlsxSheet, xlsxRowsForFilter, xlsxSheetFilter, xlsxSheetStats } from '../../src/xlsxParser';
import { filterLimits, FILTER_TOO_LARGE_REASON, FILTER_UNKNOWN_COLUMN_REASON, resolveFilters } from '../../src/filter';
import { FILTER_CASES, idsOf } from './filterCases';
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
    it('formats a Date cell as ISO text and resolves a formula cell to its cached result', async () => {
      const result = await parseXlsx(await fixtureBytes('dates-and-formulas.xlsx'));
      assert.strictEqual(result.success, true);
      if (result.success) {
        const [, when, total] = result.data.data.rows[0];
        assert.strictEqual(when, '2023-11-14');
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

  it('reports date min/max as the same ISO text the table shows (dates-and-formulas.xlsx)', async () => {
    const stats = (await statsOf('dates-and-formulas.xlsx'))!;
    assert.strictEqual(stats.columns[1].min, '2023-11-14');
    assert.strictEqual(stats.columns[1].max, '2023-11-14');
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

describe('xlsxSheetFilter', () => {
  async function sheet(name = 'filter.xlsx'): Promise<Worksheet> {
    const opened = await openXlsxWorkbook(await fixtureBytes(name));
    if ('error' in opened) {
      assert.fail(opened.error.message);
    }
    return opened.workbook.worksheets[0];
  }

  for (const c of FILTER_CASES) {
    it(c.name, async () => {
      const resolved = resolveFilters(c.filters);
      if ('errors' in resolved) {
        assert.fail('unexpected filter error');
      }
      const outcome = xlsxSheetFilter(await sheet(), resolved.specs, 100);
      assert.ok(!('failedReason' in outcome), 'failedReason' in outcome ? outcome.failedReason : '');
      assert.deepStrictEqual(idsOf(outcome.rows), c.ids);
      assert.strictEqual(outcome.matchCount, c.ids.length);
    });
  }

  it('caps the returned rows at maxRows but counts every match', async () => {
    const outcome = xlsxSheetFilter(await sheet(), [{ column: 3, filter: { op: 'gte', value: '1' } }], 2);
    assert.ok(!('failedReason' in outcome));
    assert.strictEqual(outcome.rows.length, 2);
    assert.strictEqual(outcome.matchCount, 6);
  });

  it('filters the text the table shows (dates formatted, formula results resolved)', async () => {
    const ws = await sheet('dates-and-formulas.xlsx');
    const shown = readXlsxSheet(ws).rows[0];
    const outcome = xlsxSheetFilter(ws, [{ column: 2, filter: { op: 'equals', value: shown[2] } }], 10);
    assert.ok(!('failedReason' in outcome));
    assert.strictEqual(outcome.matchCount, 1);
  });

  it('compares dates by day on real Date cells (dates-and-formulas.xlsx)', async () => {
    const ws = await sheet('dates-and-formulas.xlsx');
    for (const text of ['>=2023-11-14', '<=2023-11-14', '=2023-11-14', '>2023-11-13', '<2023-11-15']) {
      const resolved = resolveFilters([{ column: 1, text }]);
      assert.ok(!('errors' in resolved));
      const outcome = xlsxSheetFilter(ws, resolved.specs, 10);
      assert.ok(!('failedReason' in outcome), text);
      assert.strictEqual(outcome.matchCount, 1, text);
    }
    for (const text of ['>2023-11-14', '<2023-11-14']) {
      const resolved = resolveFilters([{ column: 1, text }]);
      assert.ok(!('errors' in resolved));
      const outcome = xlsxSheetFilter(ws, resolved.specs, 10);
      assert.ok(!('failedReason' in outcome), text);
      assert.strictEqual(outcome.matchCount, 0, text);
    }
  });

  it('refuses a filter on a column the sheet does not have', async () => {
    const outcome = xlsxSheetFilter(await sheet(), [{ column: 99, filter: { op: 'contains', value: 'x' } }], 10);
    assert.deepStrictEqual(outcome, { failedReason: FILTER_UNKNOWN_COLUMN_REASON });
  });

  it('refuses a sheet over the cell cap, before reading any cell', async () => {
    const original = filterLimits.maxCells;
    filterLimits.maxCells = 10;
    try {
      assert.deepStrictEqual(xlsxRowsForFilter(await sheet()), { failedReason: FILTER_TOO_LARGE_REASON });
    } finally {
      filterLimits.maxCells = original;
    }
  });

  it('yields no columns for an empty sheet', () => {
    const empty = new Workbook().addWorksheet('empty');
    assert.deepStrictEqual(xlsxRowsForFilter(empty), { columnCount: 0, rows: [] });
  });
});

describe('formatXlsxDate', () => {
  const midnight = new Date(Date.UTC(2024, 0, 1));
  const morning = new Date(Date.UTC(2024, 0, 1, 10, 30));

  it('shows only the date for a date format, even when the value has a time', () => {
    assert.strictEqual(formatXlsxDate(morning, 'yyyy-mm-dd'), '2024-01-01');
    assert.strictEqual(formatXlsxDate(morning, 'm/d/yyyy'), '2024-01-01');
    assert.strictEqual(formatXlsxDate(morning, 'mmmm d, yyyy'), '2024-01-01');
    assert.strictEqual(formatXlsxDate(morning, 'mmm'), '2024-01-01');
  });

  it('shows date and time for a datetime format, even at midnight', () => {
    assert.strictEqual(formatXlsxDate(morning, 'yyyy-mm-dd hh:mm:ss'), '2024-01-01 10:30:00');
    assert.strictEqual(formatXlsxDate(midnight, 'yyyy-mm-dd hh:mm:ss'), '2024-01-01 00:00:00');
    assert.strictEqual(formatXlsxDate(morning, 'm/d/yy h:mm'), '2024-01-01 10:30:00');
  });

  it('shows only the time for a time format, with m meaning minutes', () => {
    assert.strictEqual(formatXlsxDate(morning, 'h:mm:ss'), '10:30:00');
    assert.strictEqual(formatXlsxDate(morning, 'h:mm AM/PM'), '10:30:00');
    assert.strictEqual(formatXlsxDate(morning, 'mm:ss'), '10:30:00');
  });

  it('adds milliseconds only when they are not 0', () => {
    const withMs = new Date(Date.UTC(2024, 0, 1, 10, 30, 0, 250));
    assert.strictEqual(formatXlsxDate(withMs, 'yyyy-mm-dd hh:mm:ss.000'), '2024-01-01 10:30:00.250');
    assert.strictEqual(formatXlsxDate(withMs, 'h:mm:ss'), '10:30:00.250');
    assert.strictEqual(formatXlsxDate(withMs, 'yyyy-mm-dd'), '2024-01-01');
    assert.strictEqual(formatXlsxDate(morning, 'hh:mm:ss.000'), '10:30:00');
  });

  it('ignores letters inside quotes, [..] sections and escapes', () => {
    assert.strictEqual(formatXlsxDate(morning, '[$-409]mmmm d, yyyy'), '2024-01-01');
    assert.strictEqual(formatXlsxDate(morning, 'yyyy-mm-dd "h"'), '2024-01-01');
    assert.strictEqual(formatXlsxDate(morning, 'yyyy-mm-dd \\h'), '2024-01-01');
    assert.strictEqual(formatXlsxDate(morning, '"at" h:mm'), '10:30:00');
  });

  it('treats elapsed-time sections as time tokens, not as months', () => {
    const afternoon = new Date(Date.UTC(1899, 11, 30, 14, 5, 0));
    for (const fmt of ['[h]:mm', '[hh]:mm', '[h]:mm:ss', '[mm]:ss', '[s]']) {
      assert.strictEqual(formatXlsxDate(afternoon, fmt), '14:05:00', fmt);
    }
    // Only the unquoted section counts; a colour/locale section is not a token.
    assert.strictEqual(formatXlsxDate(afternoon, '"[h]" yyyy'), '1899-12-30');
    assert.strictEqual(formatXlsxDate(afternoon, '[Red]yyyy-mm-dd'), '1899-12-30');
  });

  it('lets the value decide when there is no usable format', () => {
    for (const fmt of [undefined, '', 'General']) {
      assert.strictEqual(formatXlsxDate(midnight, fmt), '2024-01-01', String(fmt));
      assert.strictEqual(formatXlsxDate(morning, fmt), '2024-01-01 10:30:00', String(fmt));
    }
  });

  it('does not throw on an invalid Date', () => {
    assert.strictEqual(formatXlsxDate(new Date(NaN), 'yyyy-mm-dd'), 'Invalid Date');
  });
});

describe('XLSX merged cells with a formula master', () => {
  // Every cell of a merged range shows the master's text; exceljs's own
  // MergeValue.toString() would print `[object Object]` for the others.
  async function mergedFormulaSheet(): Promise<Worksheet> {
    const wb = new Workbook();
    const ws = wb.addWorksheet('merged');
    ws.addRow(['n', 'n2', 's', 's2', 't', 't2', 'e', 'e2', 'd', 'd2']);
    ws.addRow([]);
    const set = (address: string, formula: string, result: unknown) => {
      ws.getCell(address).value = { formula, result } as never;
    };
    set('A2', '1+1', 2);
    set('C2', '"a"&"b"', 'ab');
    set('E2', '1=1', true);
    set('G2', '1/0', { error: '#DIV/0!' });
    set('I2', 'DATE(2024,1,1)', new Date(Date.UTC(2024, 0, 1)));
    ws.getCell('I2').numFmt = 'yyyy-mm-dd';
    for (const range of ['A2:B2', 'C2:D2', 'E2:F2', 'G2:H2', 'I2:J2']) {
      ws.mergeCells(range);
    }
    const opened = await openXlsxWorkbook(new Uint8Array(await wb.xlsx.writeBuffer()));
    assert.ok('workbook' in opened);
    return (opened as { workbook: Workbook }).workbook.worksheets[0];
  }

  it('shows the same text in every cell of the range', async () => {
    assert.deepStrictEqual(readXlsxSheet(await mergedFormulaSheet()).rows[0], [
      '2', '2', 'ab', 'ab', 'true', 'true', '#DIV/0!', '#DIV/0!', '2024-01-01', '2024-01-01',
    ]);
  });

  it('filters and profiles the same text', async () => {
    const ws = await mergedFormulaSheet();
    const resolved = resolveFilters([{ column: 1, text: '=2' }, { column: 7, text: '=#DIV/0!' }]);
    assert.ok(!('errors' in resolved));
    const outcome = xlsxSheetFilter(ws, resolved.specs, 10);
    assert.ok(!('failedReason' in outcome));
    assert.strictEqual(outcome.matchCount, 1);
    const stats = xlsxSheetStats(ws)!;
    assert.strictEqual(stats.columns[1].min, '2');
    assert.strictEqual(stats.columns[9].min, '2024-01-01');
  });
});

describe('XLSX date cells as ISO text', () => {
  async function workbookWithDates(): Promise<Worksheet> {
    const wb = new Workbook();
    const ws = wb.addWorksheet('dates');
    ws.addRow(['date', 'datetime', 'time', 'formula', 'merged', 'merged-slave']);
    const row = ws.addRow([
      new Date(Date.UTC(2024, 0, 1)),
      new Date(Date.UTC(2024, 0, 1, 10, 30)),
      new Date(Date.UTC(1899, 11, 30, 14, 5, 9)),
      null,
      new Date(Date.UTC(2020, 1, 29)),
    ]);
    row.getCell(1).numFmt = 'yyyy-mm-dd';
    row.getCell(2).numFmt = 'yyyy-mm-dd hh:mm:ss';
    row.getCell(3).numFmt = 'h:mm:ss';
    row.getCell(4).value = { formula: 'B2', result: new Date(Date.UTC(2024, 0, 1, 10, 30)) };
    row.getCell(4).numFmt = 'yyyy-mm-dd hh:mm';
    row.getCell(5).numFmt = 'yyyy-mm-dd';
    ws.mergeCells('E2:F2');
    const opened = await openXlsxWorkbook(new Uint8Array(await wb.xlsx.writeBuffer()));
    assert.ok('workbook' in opened);
    return (opened as { workbook: Workbook }).workbook.worksheets[0];
  }

  const EXPECTED = ['2024-01-01', '2024-01-01 10:30:00', '14:05:09', '2024-01-01 10:30:00', '2020-02-29', '2020-02-29'];

  it('uses the number format that survives a save/load round trip', async () => {
    assert.deepStrictEqual(readXlsxSheet(await workbookWithDates()).rows[0], EXPECTED);
  });

  it('gives the same text in any timezone', async () => {
    const ws = await workbookWithDates();
    const original = process.env.TZ;
    try {
      for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
        process.env.TZ = tz;
        assert.deepStrictEqual(readXlsxSheet(ws).rows[0], EXPECTED, tz);
      }
    } finally {
      if (original === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = original;
      }
    }
  });

  it('shows an elapsed-time duration as a time (round trip)', async () => {
    const wb = new Workbook();
    const ws = wb.addWorksheet('durations');
    ws.addRow(['hm', 'ms']);
    const row = ws.addRow([new Date(Date.UTC(1899, 11, 30, 14, 5)), new Date(Date.UTC(1899, 11, 30, 0, 7, 9))]);
    row.getCell(1).numFmt = '[h]:mm';
    row.getCell(2).numFmt = '[mm]:ss';
    const opened = await openXlsxWorkbook(new Uint8Array(await wb.xlsx.writeBuffer()));
    assert.ok('workbook' in opened);
    const loaded = (opened as { workbook: Workbook }).workbook.worksheets[0];
    assert.deepStrictEqual(readXlsxSheet(loaded).rows[0], ['14:05:00', '00:07:09']);
  });

  it('filters and profiles the same text the table shows', async () => {
    const ws = await workbookWithDates();
    const resolved = resolveFilters([{ column: 1, text: '>=2024-01-01' }, { column: 2, text: '=14:05:09' }]);
    assert.ok(!('errors' in resolved));
    const outcome = xlsxSheetFilter(ws, resolved.specs, 10);
    assert.ok(!('failedReason' in outcome));
    assert.strictEqual(outcome.matchCount, 1);
    const stats = xlsxSheetStats(ws)!;
    assert.strictEqual(stats.columns[1].min, '2024-01-01 10:30:00');
    assert.strictEqual(stats.columns[3].max, '2024-01-01 10:30:00');
  });
});

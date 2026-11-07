import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { csvFilter } from '../../src/csvParser';
import { duckdbTableFilter, openDuckdbDatabase, type DuckdbHandle } from '../../src/duckdbParser';
import { resolveFilters, type ColumnFilterSpec, type FilterOutcome } from '../../src/filter';
import { parquetFilter } from '../../src/parquetParser';
import { openSqliteDatabase, sqliteTableFilter, type SqliteHandle } from '../../src/sqliteParser';
import { openXlsxWorkbook, xlsxSheetFilter } from '../../src/xlsxParser';
import { FILTER_CASES } from './filterCases';

const fixturesDir = path.join(process.cwd(), 'test', 'fixtures');
const MAX_ROWS = 100;

/** Columns 0-5 (id..day) show identical text in every format; 6-7 (d, ts) are typed and display per format. */
const SHARED_COLUMNS = 6;

/** Row id=1's `d` and `ts` as each format displays them. Pins that the fixtures hold typed values. */
const DISPLAYED_DATES: Record<string, [d: string, ts: string]> = {
  csv: ['2024-01-01', '2024-01-01 10:30:00'],
  parquet: ['2024-01-01T00:00:00.000Z', '2024-01-01T10:30:00.000Z'],
  xlsx: ['2024-01-01', '2024-01-01 10:30:00'], // real Date cells, shown as ISO text by formatXlsxDate
  sqlite: ['2024-01-01', '2024-01-01 10:30:00'],
  duckdb: ['2024-01-01', '2024-01-01 10:30:00'],
};

/** An outcome reduced to what every format must agree on. */
function comparable(outcome: FilterOutcome) {
  assert.ok(!('failedReason' in outcome), 'failedReason' in outcome ? outcome.failedReason : '');
  return { rows: outcome.rows.map((row) => row.slice(0, SHARED_COLUMNS)), matchCount: outcome.matchCount };
}

/**
 * The same 7 logical rows ship as filter.csv / .parquet / .xlsx / .db /
 * .duckdb. A filter must keep exactly the same rows -- same order, same match
 * count, same cell text in the shared columns -- in every format. The `d`/`ts`
 * columns are real DATE/TIMESTAMP where the format has them, so their text
 * legitimately differs (see `DISPLAYED_DATES`); the filters on them must still
 * agree. The JS engine (CSV, Parquet, XLSX), a JS callback inside SQLite, and
 * native SQL in DuckDB are three different implementations of one meaning, and
 * this is what keeps them honest. (Where the DuckDB SQL form legitimately
 * differs from the table's cell text, that is documented on `filterTextExpr`
 * and has its own test.)
 */
describe('filter parity across formats', () => {
  let csv: string;
  let parquet: Uint8Array;
  let sheet: Awaited<ReturnType<typeof openXlsxWorkbook>>;
  let sqlite: SqliteHandle;
  let duckdb: DuckdbHandle;

  before(async () => {
    csv = await fs.readFile(path.join(fixturesDir, 'filter.csv'), 'utf-8');
    parquet = new Uint8Array(await fs.readFile(path.join(fixturesDir, 'filter.parquet')));
    sheet = await openXlsxWorkbook(new Uint8Array(await fs.readFile(path.join(fixturesDir, 'filter.xlsx'))));
    const sqliteOpened = await openSqliteDatabase(new Uint8Array(await fs.readFile(path.join(fixturesDir, 'filter.db'))));
    const duckdbOpened = await openDuckdbDatabase(new Uint8Array(await fs.readFile(path.join(fixturesDir, 'filter.duckdb'))));
    assert.ok(!('error' in sheet) && !('error' in sqliteOpened) && !('error' in duckdbOpened));
    sqlite = sqliteOpened as SqliteHandle;
    duckdb = duckdbOpened as DuckdbHandle;
  });

  after(() => {
    sqlite?.close();
    duckdb?.close();
  });

  async function runAll(specs: ColumnFilterSpec[]): Promise<Record<string, FilterOutcome>> {
    assert.ok(!('error' in sheet));
    return {
      csv: csvFilter(csv, specs, MAX_ROWS),
      parquet: await parquetFilter(parquet, specs, MAX_ROWS),
      xlsx: xlsxSheetFilter(sheet.workbook.worksheets[0], specs, MAX_ROWS),
      sqlite: sqliteTableFilter(sqlite, 'items', specs, MAX_ROWS),
      duckdb: await duckdbTableFilter(duckdb, 'items', specs, MAX_ROWS),
    };
  }

  for (const c of FILTER_CASES) {
    it(c.name, async () => {
      const resolved = resolveFilters(c.filters);
      assert.ok(!('errors' in resolved));
      const outcomes = await runAll(resolved.specs);
      const reference = comparable(outcomes.csv);
      for (const [format, outcome] of Object.entries(outcomes)) {
        assert.deepStrictEqual(comparable(outcome), reference, `${format} disagrees with csv`);
      }
    });
  }

  it('holds real DATE/TIMESTAMP values, which each format displays in its own way', async () => {
    const resolved = resolveFilters([{ column: 0, text: '=1' }]);
    assert.ok(!('errors' in resolved));
    for (const [format, outcome] of Object.entries(await runAll(resolved.specs))) {
      assert.ok(!('failedReason' in outcome));
      assert.deepStrictEqual(outcome.rows[0].slice(SHARED_COLUMNS), DISPLAYED_DATES[format], format);
    }
  });

  it('agrees when the row cap truncates the result', async () => {
    const resolved = resolveFilters([{ column: 3, text: '>=1' }]);
    assert.ok(!('errors' in resolved));
    const outcomes = await Promise.all([
      csvFilter(csv, resolved.specs, 3),
      parquetFilter(parquet, resolved.specs, 3),
      sqliteTableFilter(sqlite, 'items', resolved.specs, 3),
      duckdbTableFilter(duckdb, 'items', resolved.specs, 3),
    ]);
    for (const outcome of outcomes) {
      assert.ok(!('failedReason' in outcome));
      assert.strictEqual(outcome.rows.length, 3);
      assert.strictEqual(outcome.matchCount, 6);
      assert.deepStrictEqual(comparable(outcome), comparable(outcomes[0]));
    }
  });
});

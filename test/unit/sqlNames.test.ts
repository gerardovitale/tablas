import * as assert from 'assert';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  DUCKDB_NON_UNRESERVED_KEYWORDS,
  FALLBACK_VIEW_NAME,
  quoteIdentifier,
  quoteIdentifierIfNeeded,
  suggestQueryFor,
  viewNameForFile,
} from '../../src/sqlNames';

describe('viewNameForFile', () => {
  it('is the file name without its last extension', () => {
    assert.strictEqual(viewNameForFile('sales_2024.parquet'), 'sales_2024');
    assert.strictEqual(viewNameForFile('sales-2024.final.csv'), 'sales-2024.final');
    assert.strictEqual(viewNameForFile('noextension'), 'noextension');
    assert.strictEqual(viewNameForFile('.hidden.csv'), '.hidden');
  });

  it('uses the base name of a path', () => {
    assert.strictEqual(viewNameForFile('/a/b/orders.csv'), 'orders');
    assert.strictEqual(viewNameForFile('C:\\data\\orders.csv'), 'orders');
  });

  it('falls back to "data" when nothing usable is left', () => {
    for (const name of ['', '.csv', '.', '...', '  .parquet', '\u0001\u0002.csv']) {
      assert.strictEqual(viewNameForFile(name), FALLBACK_VIEW_NAME, JSON.stringify(name));
    }
  });

  it('removes control characters and clips a very long name', () => {
    assert.strictEqual(viewNameForFile('a\u0000b\nc.csv'), 'abc');
    const long = viewNameForFile(`${'x'.repeat(300)}.csv`);
    assert.strictEqual(long.length, 100);
  });

  it('keeps spaces, accents and quotes (the name is quoted when written)', () => {
    assert.strictEqual(viewNameForFile('Ventas 2024 é.csv'), 'Ventas 2024 é');
    assert.strictEqual(viewNameForFile('say "hi".csv'), 'say "hi"');
  });
});

describe('quoteIdentifierIfNeeded', () => {
  it('leaves a plain identifier bare', () => {
    for (const name of ['sales', 'sales_2024', '_x', 'Sales', 'a1']) {
      assert.strictEqual(quoteIdentifierIfNeeded(name), name);
    }
  });

  it('quotes dashes, dots, spaces, a leading digit, non-ASCII and the empty name', () => {
    assert.strictEqual(quoteIdentifierIfNeeded('sales-2024.final'), '"sales-2024.final"');
    assert.strictEqual(quoteIdentifierIfNeeded('my file'), '"my file"');
    assert.strictEqual(quoteIdentifierIfNeeded('2024'), '"2024"');
    assert.strictEqual(quoteIdentifierIfNeeded('café'), '"café"');
    assert.strictEqual(quoteIdentifierIfNeeded(''), '""');
  });

  it('quotes a keyword, in any case, and doubles an embedded quote', () => {
    assert.strictEqual(quoteIdentifierIfNeeded('order'), '"order"');
    assert.strictEqual(quoteIdentifierIfNeeded('SELECT'), '"SELECT"');
    assert.strictEqual(quoteIdentifierIfNeeded('say "hi"'), '"say ""hi"""');
    assert.strictEqual(quoteIdentifier('a"b'), '"a""b"');
  });
});

describe('suggestQueryFor', () => {
  it('writes the file view as it must be typed', () => {
    assert.strictEqual(suggestQueryFor('sales_2024'), 'select * from sales_2024 limit 5');
    assert.strictEqual(suggestQueryFor('sales-2024.final'), 'select * from "sales-2024.final" limit 5');
    assert.strictEqual(suggestQueryFor('order'), 'select * from "order" limit 5');
  });
});

describe('the keyword list matches the bundled DuckDB', () => {
  it('holds exactly the keywords that are not unreserved', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      const reader = await connection.runAndReadAll(
        "SELECT DISTINCT keyword_name FROM duckdb_keywords() WHERE keyword_category <> 'unreserved' ORDER BY 1"
      );
      const fromEngine = reader.getRowsJson().map((row) => String(row[0]));
      assert.deepStrictEqual([...DUCKDB_NON_UNRESERVED_KEYWORDS].sort(), fromEngine);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });

  it('quotes every one of them so the view can be created (the bare form is not relied on)', async () => {
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      for (const keyword of DUCKDB_NON_UNRESERVED_KEYWORDS) {
        await connection.run(`CREATE OR REPLACE VIEW ${quoteIdentifierIfNeeded(keyword)} AS SELECT 1 AS x`);
        const reader = await connection.runAndReadAll(`SELECT x FROM ${quoteIdentifierIfNeeded(keyword)}`);
        assert.deepStrictEqual(reader.getRowsJson(), [[1]], keyword);
      }
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });
});

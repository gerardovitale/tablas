import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  duckdbDropResult,
  duckdbResultFilter,
  duckdbResultStats,
  duckdbRunQuery,
  queryLimits,
  type DuckdbHandle,
} from '../../src/duckdbParser';
import { isFileSqlError, openFileSqlEngine, type FileSqlFormat, type FileSqlSource } from '../../src/fileSqlEngine';
import { resolveFilters } from '../../src/filter';

const fixturesDir = path.join(process.cwd(), 'test', 'fixtures');
const fixture = (name: string) => path.join(fixturesDir, name);

async function open(source: FileSqlSource): Promise<DuckdbHandle> {
  const opened = await openFileSqlEngine(source);
  if (isFileSqlError(opened)) {
    throw new Error(`engine failed to open: ${opened.error}`);
  }
  return opened;
}
const openFixture = (name: string, format: FileSqlFormat) => open({ format, fileName: name, fsPath: fixture(name) });

async function rowsOf(handle: DuckdbHandle, sql: string) {
  const outcome = await duckdbRunQuery(handle, sql, 1000);
  assert.ok(outcome && 'data' in outcome, JSON.stringify(outcome));
  return (outcome as { data: { headers: string[]; rows: string[][] } }).data;
}

/** The `tablas-sql-*` folders currently in the temp dir (an engine owns one while it is open). */
const engineFolders = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('tablas-sql-'));

describe('openFileSqlEngine', () => {
  describe('a Parquet file', () => {
    it('is a view named after the file', async () => {
      const handle = await openFixture('filter.parquet', 'parquet');
      try {
        const data = await rowsOf(handle, 'select count(*) as n from filter');
        assert.deepStrictEqual(data.rows, [['7']]);
      } finally {
        handle.close();
      }
    });

    it('keeps the file\'s columns and types, so a result has type badges and statistics', async () => {
      const handle = await openFixture('filter.parquet', 'parquet');
      try {
        const outcome = await duckdbRunQuery(handle, 'select id, name, price from filter order by id', 100, { resultSeq: 3 });
        assert.ok(outcome && 'data' in outcome);
        const stats = await duckdbResultStats(handle, 3);
        assert.ok(stats && !stats.skippedReason);
        assert.deepStrictEqual(stats?.columns.map((c) => c.type), ['integer', 'text', 'float']);
        assert.ok(stats?.columns.every((c) => typeof c.nativeType === 'string' && c.nativeType !== ''));
      } finally {
        handle.close();
      }
    });

    it('reads nested columns', async () => {
      const handle = await openFixture('nested.parquet', 'parquet');
      try {
        const data = await rowsOf(handle, 'select id, info.x as x from nested order by id limit 1');
        assert.deepStrictEqual(data.rows, [['1', '1']]);
      } finally {
        handle.close();
      }
    });

    it('filters a result like a table (the same SQL as a DuckDB file)', async () => {
      const handle = await openFixture('filter.parquet', 'parquet');
      try {
        await duckdbRunQuery(handle, 'select * from filter', 1000, { resultSeq: 1 });
        const resolved = resolveFilters([{ column: 2, text: 'rome' }]);
        assert.ok(!('errors' in resolved));
        if (!('errors' in resolved)) {
          const outcome = await duckdbResultFilter(handle, 1, resolved.specs, 100);
          assert.ok('rows' in outcome);
          assert.deepStrictEqual('rows' in outcome ? outcome.rows.map((r) => r[0]) : [], ['1', '4']);
        }
      } finally {
        handle.close();
      }
    });
  });

  describe('a CSV file', () => {
    it('is a view named after the file, with detected types', async () => {
      const handle = await openFixture('filter.csv', 'csv');
      try {
        const data = await rowsOf(handle, 'select sum(qty) as total, typeof(price) as t from filter group by 2');
        assert.deepStrictEqual(data.rows, [['145', 'DOUBLE']]);
      } finally {
        handle.close();
      }
    });

    it('keeps a quoted, multi-line cell as one value', async () => {
      const handle = await openFixture('multiline.csv', 'csv');
      try {
        const data = await rowsOf(handle, 'select notes from multiline where id = 1');
        assert.deepStrictEqual(data.rows, [['First line\nSecond line\nThird line']]);
      } finally {
        handle.close();
      }
    });

    it('works in UTC for a timestamp that has a zone, whatever the machine\'s time zone', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-test-'));
      try {
        const file = path.join(dir, 'zoned.csv');
        fs.writeFileSync(file, 'id,ts\n1,2024-01-01 10:30:00+02\n2,2024-01-02 00:00:00+00\n');
        const handle = await open({ format: 'csv', fileName: 'zoned.csv', fsPath: file });
        try {
          // hour() works in the session's zone, which the engine pins to UTC (a bare cast to text
          // can be read straight from the file by DuckDB, so it would not show the zone).
          const data = await rowsOf(handle, 'select hour(ts) as h from zoned order by id');
          assert.deepStrictEqual(data.rows, [['8'], ['0']]);
        } finally {
          handle.close();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('always takes the first row as the header, like the table view does', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-test-'));
      try {
        const file = path.join(dir, 'numbers.csv');
        fs.writeFileSync(file, '1,2\n3,4\n5,6\n');
        const handle = await open({ format: 'csv', fileName: 'numbers.csv', fsPath: file });
        try {
          const data = await rowsOf(handle, 'select * from numbers');
          assert.deepStrictEqual(data.headers, ['1', '2']);
          assert.deepStrictEqual(data.rows, [['3', '4'], ['5', '6']]);
        } finally {
          handle.close();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('opens a header-only and an empty file without failing', async () => {
      const headersOnly = await openFixture('headers-only.csv', 'csv');
      try {
        assert.deepStrictEqual((await rowsOf(headersOnly, 'select * from "headers-only"')).rows, []);
      } finally {
        headersOnly.close();
      }
      const empty = await openFixture('empty.csv', 'csv');
      try {
        assert.deepStrictEqual((await rowsOf(empty, 'select * from empty')).rows, []);
      } finally {
        empty.close();
      }
    });
  });

  describe('the name of the view', () => {
    const withCopy = async (fixtureName: string, copyName: string, format: FileSqlFormat, run: (h: DuckdbHandle) => Promise<void>) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-test-'));
      try {
        const file = path.join(dir, copyName);
        fs.copyFileSync(fixture(fixtureName), file);
        const handle = await open({ format, fileName: copyName, fsPath: file });
        try {
          await run(handle);
        } finally {
          handle.close();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };

    it('is the stem, quoted when it is not a plain identifier', async () => {
      await withCopy('filter.csv', 'sales-2024.final.csv', 'csv', async (handle) => {
        assert.deepStrictEqual((await rowsOf(handle, 'select count(*) from "sales-2024.final"')).rows, [['7']]);
      });
      await withCopy('filter.parquet', 'my data 2024.parquet', 'parquet', async (handle) => {
        assert.deepStrictEqual((await rowsOf(handle, 'select count(*) from "my data 2024"')).rows, [['7']]);
      });
      await withCopy('filter.csv', '2024.csv', 'csv', async (handle) => {
        assert.deepStrictEqual((await rowsOf(handle, 'select count(*) from "2024"')).rows, [['7']]);
      });
    });

    it('can be a keyword or contain quotes', async () => {
      await withCopy('filter.csv', 'order.csv', 'csv', async (handle) => {
        assert.deepStrictEqual((await rowsOf(handle, 'select count(*) from "order"')).rows, [['7']]);
      });
      await withCopy('filter.csv', 'say "hi".csv', 'csv', async (handle) => {
        assert.deepStrictEqual((await rowsOf(handle, 'select count(*) from "say ""hi"""')).rows, [['7']]);
      });
    });

    it('is "data" for a file with no stem', async () => {
      await withCopy('filter.csv', '.csv', 'csv', async (handle) => {
        assert.deepStrictEqual((await rowsOf(handle, 'select count(*) from data')).rows, [['7']]);
      });
    });

    it('handles a single quote in the path (the path is a SQL literal)', async () => {
      await withCopy('filter.csv', "it's here.csv", 'csv', async (handle) => {
        assert.deepStrictEqual((await rowsOf(handle, `select count(*) from "it's here"`)).rows, [['7']]);
      });
    });
  });

  describe('reading in place', () => {
    it('sees the file as it is at each query, not as it was when the engine opened', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-test-'));
      try {
        const file = path.join(dir, 'live.csv');
        fs.writeFileSync(file, 'a\n1\n2\n');
        const handle = await open({ format: 'csv', fileName: 'live.csv', fsPath: file });
        try {
          assert.deepStrictEqual((await rowsOf(handle, 'select count(*) from live')).rows, [['2']]);
          fs.writeFileSync(file, 'a\n1\n2\n3\n4\n5\n');
          assert.deepStrictEqual((await rowsOf(handle, 'select count(*) from live')).rows, [['5']]);
        } finally {
          handle.close();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not copy the file: the engine folder holds no bytes of it', async () => {
      const before = engineFolders();
      const handle = await openFixture('filter.parquet', 'parquet');
      try {
        const created = engineFolders().filter((name) => !before.includes(name));
        assert.strictEqual(created.length, 1);
        assert.deepStrictEqual(fs.readdirSync(path.join(os.tmpdir(), created[0])).filter((n) => n.endsWith('.parquet')), []);
      } finally {
        handle.close();
      }
    });

    it('reports a file that was deleted meanwhile as a query error, not a crash', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-test-'));
      try {
        const file = path.join(dir, 'gone.csv');
        fs.writeFileSync(file, 'a\n1\n');
        const handle = await open({ format: 'csv', fileName: 'gone.csv', fsPath: file });
        try {
          fs.rmSync(file);
          const outcome = await duckdbRunQuery(handle, 'select * from gone', 10);
          assert.ok(outcome && 'error' in outcome);
        } finally {
          handle.close();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('a source without a usable path', () => {
    it('copies the bytes into a private folder and removes it on close', async () => {
      const before = engineFolders();
      const bytes = new Uint8Array(fs.readFileSync(fixture('filter.parquet')));
      const handle = await open({ format: 'parquet', fileName: 'remote.parquet', readBytes: async () => bytes });
      const created = engineFolders().filter((name) => !before.includes(name));
      assert.strictEqual(created.length, 1);
      const folder = path.join(os.tmpdir(), created[0]);
      assert.ok(fs.existsSync(path.join(folder, 'remote.parquet')), 'the copy keeps the file\'s name');
      assert.strictEqual((fs.statSync(folder).mode & 0o777), 0o700, 'the folder is private');
      assert.deepStrictEqual((await rowsOf(handle, 'select count(*) from remote')).rows, [['7']]);
      handle.close();
      assert.ok(!fs.existsSync(folder), 'the folder is gone');
    });

    it('copies a local file whose path has glob characters, which DuckDB would expand', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-test-'));
      try {
        const file = path.join(dir, 'data[1].csv');
        fs.copyFileSync(fixture('filter.csv'), file);
        let readThroughMemory = 0;
        const handle = await open({
          format: 'csv',
          fileName: 'data[1].csv',
          fsPath: file,
          readBytes: async () => {
            readThroughMemory++;
            return new Uint8Array(fs.readFileSync(file));
          },
        });
        try {
          assert.deepStrictEqual((await rowsOf(handle, 'select count(*) from "data[1]"')).rows, [['7']]);
          assert.strictEqual(readThroughMemory, 0, 'a local file is copied on disk, never read into memory');
        } finally {
          handle.close();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fails with text when there is neither a path nor contents', async () => {
      const opened = await openFileSqlEngine({ format: 'csv', fileName: 'x.csv' });
      assert.ok(isFileSqlError(opened));
    });
  });

  describe('a file DuckDB cannot read', () => {
    it('comes back as an error, leaves no folder behind, and names the problem', async () => {
      const before = engineFolders();
      const opened = await openFileSqlEngine({ format: 'parquet', fileName: 'corrupt.parquet', fsPath: fixture('corrupt.parquet') });
      assert.ok(isFileSqlError(opened));
      assert.match(isFileSqlError(opened) ? opened.error : '', /^Could not read the file with DuckDB/);
      assert.deepStrictEqual(engineFolders().filter((name) => !before.includes(name)), []);
    });

    it('is the same for a file that does not exist', async () => {
      const opened = await openFileSqlEngine({ format: 'csv', fileName: 'nope.csv', fsPath: path.join(os.tmpdir(), 'tablas-nope.csv') });
      assert.ok(isFileSqlError(opened));
    });

    it('says a CSV is read more strictly than the table view reads it; a Parquet error has no such hint', async () => {
      const csv = await openFileSqlEngine({ format: 'csv', fileName: 'nope.csv', fsPath: path.join(os.tmpdir(), 'tablas-nope.csv') });
      assert.match(isFileSqlError(csv) ? csv.error : '', /table view reads CSV more leniently than DuckDB/);
      const parquet = await openFileSqlEngine({ format: 'parquet', fileName: 'corrupt.parquet', fsPath: fixture('corrupt.parquet') });
      assert.ok(isFileSqlError(parquet) && !/leniently/.test(parquet.error));
    });
  });

  describe('the guard and limits of the SQL box apply', () => {
    it('refuses a statement that writes', async () => {
      const handle = await openFixture('filter.csv', 'csv');
      try {
        const target = path.join(os.tmpdir(), 'tablas-must-not-exist.csv');
        const outcome = await duckdbRunQuery(handle, `COPY (SELECT 1) TO '${target}'`, 10);
        assert.ok(outcome && 'error' in outcome);
        assert.ok(!fs.existsSync(target));
      } finally {
        handle.close();
      }
    });

    it('holds a result as a table that is dropped on request', async () => {
      const original = queryLimits.maxResultRows;
      queryLimits.maxResultRows = 3;
      const handle = await openFixture('filter.csv', 'csv');
      try {
        const outcome = await duckdbRunQuery(handle, 'select * from filter', 2, { resultSeq: 8 });
        assert.ok(outcome && 'data' in outcome);
        assert.strictEqual((outcome as { capped?: boolean }).capped, true);
        assert.strictEqual((outcome as { materializedRows?: number }).materializedRows, 3);
        await duckdbDropResult(handle, 8);
        assert.strictEqual(await duckdbResultStats(handle, 8), undefined);
      } finally {
        queryLimits.maxResultRows = original;
        handle.close();
      }
    });
  });
});

import * as assert from 'assert';
import * as path from 'path';
import { openFileSqlEngine, type FileSqlError } from '../../src/fileSqlEngine';
import type { DuckdbHandle } from '../../src/duckdbParser';
import { QuerySession } from '../../src/querySession';
import type { FilterMessage } from '../../src/filterMessage';

const csv = path.join(process.cwd(), 'test', 'fixtures', 'filter.csv');
const run = (seq: number, sql: string) => ({ type: 'run-query' as const, seq, sql });
const filter = (seq: number, result: number, text: string): FilterMessage => ({
  type: 'filter',
  seq,
  result,
  filters: [{ column: 2, text }],
});

function session(onOpen?: () => void): QuerySession {
  return new QuerySession(() => {
    onOpen?.();
    return openFileSqlEngine({ format: 'csv', fileName: 'filter.csv', fsPath: csv });
  });
}

describe('QuerySession', () => {
  it('opens the engine only when the first query arrives, and once', async () => {
    let opened = 0;
    const s = session(() => opened++);
    try {
      assert.strictEqual(opened, 0, 'nothing until a query is run');
      await s.closeResult(1);
      await s.resultStats(1);
      assert.strictEqual(opened, 0, 'requests about a result never open it');
      await s.runQuery(run(1, 'select 1'), 10);
      await s.runQuery(run(2, 'select 2'), 10);
      assert.strictEqual(opened, 1);
    } finally {
      s.dispose();
    }
  });

  it('answers a query with its rows, echoing the seq and the result address', async () => {
    const s = session();
    try {
      const payload = await s.runQuery(run(5, 'select id, name from filter order by id limit 2'), 100);
      assert.strictEqual(payload?.seq, 5);
      assert.strictEqual(payload?.result, 5);
      assert.deepStrictEqual(payload?.data?.rows, [['1', 'Alice'], ['2', 'bob']]);
    } finally {
      s.dispose();
    }
  });

  it('serves statistics and filters of the result it holds', async () => {
    const s = session();
    try {
      await s.runQuery(run(2, 'select * from filter'), 100);
      const stats = await s.resultStats(2);
      assert.strictEqual(stats.result, 2);
      assert.strictEqual(stats.stats?.columns.length, 8);
      const filtered = await s.resultFilter(filter(1, 2, 'rome'), 100);
      assert.strictEqual(filtered?.result, 2);
      assert.deepStrictEqual(filtered?.rows?.map((r) => r[0]), ['1', '4']);
      assert.strictEqual(filtered?.matchCount, 2);
    } finally {
      s.dispose();
    }
  });

  it('says a result is gone once it was closed or replaced', async () => {
    const s = session();
    try {
      await s.runQuery(run(1, 'select * from filter'), 100);
      await s.closeResult(1);
      assert.match((await s.resultFilter(filter(1, 1, 'a'), 10))?.failedReason ?? '', /no longer available/);
      assert.strictEqual((await s.resultStats(1)).stats, undefined);
      await s.runQuery(run(2, 'select * from filter'), 100);
      await s.runQuery(run(3, 'select * from filter'), 100);
      assert.match((await s.resultFilter(filter(2, 2, 'a'), 10))?.failedReason ?? '', /no longer available/);
      assert.ok((await s.resultFilter(filter(3, 3, 'rome'), 10))?.rows);
    } finally {
      s.dispose();
    }
  });

  it('answers a filter about a result before any query ran as gone, without opening anything', async () => {
    let opened = 0;
    const s = session(() => opened++);
    try {
      assert.match((await s.resultFilter(filter(1, 4, 'a'), 10))?.failedReason ?? '', /no longer available/);
      assert.strictEqual(opened, 0);
    } finally {
      s.dispose();
    }
  });

  it('does not run a query that a newer one overtook', async () => {
    const s = session();
    try {
      const first = s.runQuery(run(1, 'select 1 as one'), 10);
      const second = s.runQuery(run(2, 'select 2 as two'), 10);
      assert.strictEqual(await first, undefined);
      assert.deepStrictEqual((await second)?.data?.rows, [['2']]);
    } finally {
      s.dispose();
    }
  });

  it('drops a filter request that a newer one overtook while it waited', async () => {
    const s = session();
    try {
      await s.runQuery(run(1, 'select * from filter'), 100);
      const older = s.resultFilter(filter(1, 1, 'rome'), 100);
      const newer = s.resultFilter(filter(2, 1, 'oslo'), 100);
      assert.strictEqual(await older, undefined);
      assert.deepStrictEqual((await newer)?.rows?.map((r) => r[0]), ['3']);
    } finally {
      s.dispose();
    }
  });

  it('answers invalid filter text with errors and runs nothing; a cleared filter gets no answer', async () => {
    const s = session();
    try {
      await s.runQuery(run(1, 'select * from filter'), 100);
      const bad = await s.resultFilter({ type: 'filter', seq: 1, result: 1, filters: [{ column: 3, text: '>abc!' }, { column: 0, text: '\\' }] }, 10);
      assert.ok(bad === undefined || bad.errors !== undefined || bad.rows !== undefined);
      assert.strictEqual(await s.resultFilter({ type: 'filter', seq: 2, result: 1, filters: [] }, 10), undefined);
    } finally {
      s.dispose();
    }
  });

  describe('a file that cannot be queried', () => {
    it('answers with the error text, and tries again on the next query (the file may have been fixed)', async () => {
      let attempts = 0;
      const s = new QuerySession(async (): Promise<DuckdbHandle | FileSqlError> => {
        attempts++;
        if (attempts === 1) {
          return { error: 'Could not read the file with DuckDB: nope' };
        }
        return openFileSqlEngine({ format: 'csv', fileName: 'filter.csv', fsPath: csv });
      });
      try {
        const failed = await s.runQuery(run(1, 'select 1'), 10);
        assert.strictEqual(failed?.error, 'Could not read the file with DuckDB: nope');
        const fixed = await s.runQuery(run(2, 'select 1 as x'), 10);
        assert.deepStrictEqual(fixed?.data?.rows, [['1']]);
        assert.strictEqual(attempts, 2);
      } finally {
        s.dispose();
      }
    });

    it('survives an opener that throws', async () => {
      const s = new QuerySession(async () => {
        throw new Error('boom');
      });
      try {
        assert.strictEqual((await s.runQuery(run(1, 'select 1'), 10))?.error, 'boom');
      } finally {
        s.dispose();
      }
    });
  });

  it('never opens an engine after it was disposed', async () => {
    let opened = 0;
    const s = session(() => opened++);
    s.dispose();
    assert.strictEqual(await s.runQuery(run(1, 'select 1'), 10), undefined);
    assert.strictEqual((await s.resultStats(1)).stats, undefined);
    await s.closeResult(1);
    assert.strictEqual(opened, 0, 'no engine (and no temp folder) that nobody would close');
  });

  it('closes its engine on dispose, even while a query is queued on it', async () => {
    let handle: DuckdbHandle | undefined;
    const s = new QuerySession(async () => {
      const opened = await openFileSqlEngine({ format: 'csv', fileName: 'filter.csv', fsPath: csv });
      handle = 'error' in opened ? undefined : opened;
      return opened;
    });
    await s.runQuery(run(1, 'select 1'), 10);
    const pending = s.runQuery(run(2, 'select count(*) from filter'), 10);
    s.dispose();
    assert.strictEqual(await pending, undefined, 'a disposed session answers nothing');
    // Give the queued close a turn, then the connection must refuse work.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(handle!.connection.run('select 1'));
  });
});

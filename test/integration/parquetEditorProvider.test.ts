import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import type { TablasApi } from '../../src/extension';
import type { ParquetParseOutcome } from '../../src/parquetParser';
import { ParquetEditorProvider } from '../../src/parquetEditorProvider';
import * as parquetParser from '../../src/parquetParser';
import { statsHooks } from '../../src/columnStats';
import { filterLimits, FILTER_FAILED_REASON } from '../../src/filter';
import { idsOf } from '../unit/filterCases';

const fixturesDir = path.join(process.cwd(), 'test', 'fixtures');

function fixtureUri(name: string): vscode.Uri {
  return vscode.Uri.file(path.join(fixturesDir, name));
}

function getApi(): TablasApi {
  const ext = vscode.extensions.getExtension<TablasApi>('gerardovitale.tablas');
  assert.ok(ext, 'Extension should be installed in Extension Development Host');
  assert.ok(ext.isActive, 'Extension should be active');
  assert.ok(ext.exports, 'Extension should export its public API');
  return ext.exports;
}

/**
 * Opens a fixture through the real `tablas.parquetViewer` custom editor and
 * waits for `onDidPostParquetData` — i.e. for the extension host to
 * actually finish the ready-handshake and post `parquet-data` to the
 * webview. Just awaiting `vscode.openWith` isn't enough:
 * `resolveCustomEditor`'s `onDidReceiveMessage` handler is async and
 * unawaited, so a broken handshake wouldn't make `openWith`'s promise
 * reject.
 */
function openParquetAndAwaitOutcome(name: string): Promise<ParquetParseOutcome> {
  const api = getApi();
  return new Promise<ParquetParseOutcome>((resolve, reject) => {
    const subscription = api.onDidPostParquetData((outcome) => {
      subscription.dispose();
      resolve(outcome);
    });
    vscode.commands
      .executeCommand('vscode.openWith', fixtureUri(name), 'tablas.parquetViewer')
      .then(undefined, (err) => {
        subscription.dispose();
        reject(err);
      });
  });
}

describe('ParquetEditorProvider Integration', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('gerardovitale.tablas');
    assert.ok(ext, 'Extension should be installed in Extension Development Host');
    if (!ext.isActive) {
      await ext.activate();
    }
    assert.strictEqual(ext.isActive, true, 'Extension should be active');
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('tablas.parquetViewer opens a Parquet file', async () => {
    await openParquetAndAwaitOutcome('simple.parquet');
    assert.ok(
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => tab.label.includes('simple.parquet'))
      ),
      'simple.parquet should be open in a tab'
    );
  });

  it('posts parsed parquet-data for simple.parquet', async () => {
    const outcome = await openParquetAndAwaitOutcome('simple.parquet');
    assert.strictEqual(outcome.success, true, 'Parsing simple.parquet should succeed');
    if (outcome.success) {
      assert.strictEqual(outcome.data.rowCount, 3);
      assert.strictEqual(outcome.data.columnCount, 4);
    }
  });

  it('posts parsed parquet-data for empty.parquet', async () => {
    const outcome = await openParquetAndAwaitOutcome('empty.parquet');
    assert.strictEqual(outcome.success, true, 'Parsing empty.parquet should succeed');
    if (outcome.success) {
      assert.strictEqual(outcome.data.rowCount, 0);
      assert.ok(outcome.data.columnCount > 0, 'empty.parquet should still expose its schema');
    }
  });

  it('posts parsed parquet-data for nulls.parquet', async () => {
    const outcome = await openParquetAndAwaitOutcome('nulls.parquet');
    assert.strictEqual(outcome.success, true, 'Parsing nulls.parquet should succeed');
    if (outcome.success) {
      assert.ok(outcome.data.rowCount > 0, 'nulls.parquet should parse at least one row');
    }
  });

  it('posts a failed outcome for a corrupt file, through the real handshake', async () => {
    const outcome = await openParquetAndAwaitOutcome('corrupt.parquet');
    assert.strictEqual(outcome.success, false, 'Parsing corrupt.parquet should fail cleanly');
  });

  it('posts a failed outcome for an unsupported compression codec', async () => {
    const outcome = await openParquetAndAwaitOutcome('unsupported-codec.parquet');
    assert.strictEqual(
      outcome.success,
      false,
      'Parsing a gzip-compressed file should fail cleanly'
    );
  });

  describe('handleGetStats (lazy column statistics, no webview involved)', () => {
    function providerAndDocument(name: string) {
      const provider = new ParquetEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
      return { provider, document: provider.openCustomDocument(fixtureUri(name)) };
    }

    /** These cases fail on purpose; keep the expected warning out of the test output. */
    async function quietly<T>(fn: () => Promise<T>): Promise<T> {
      const original = statsHooks.log;
      statsHooks.log = () => undefined;
      try {
        return await fn();
      } finally {
        statsHooks.log = original;
      }
    }

    it('re-reads the file and computes whole-file stats', async () => {
      const { provider, document } = providerAndDocument('stats.parquet');
      const payload = await provider.handleGetStats(document);
      assert.strictEqual(payload.table, undefined);
      assert.strictEqual(payload.stats?.columns.length, 10);
      assert.strictEqual(payload.stats?.columns[0].max, '5');
    });

    it('answers a corrupt file with no stats instead of throwing', async () => {
      const { provider, document } = providerAndDocument('corrupt.parquet');
      assert.deepStrictEqual(await quietly(() => provider.handleGetStats(document)), { stats: undefined });
    });

    it('answers an unreadable file with no stats instead of throwing', async () => {
      const { provider, document } = providerAndDocument('does-not-exist.parquet');
      assert.deepStrictEqual(await quietly(() => provider.handleGetStats(document)), { stats: undefined });
    });
  });

  describe('handleFilter (whole-file filtering, no webview involved)', () => {
    function providerAndDocument(name: string) {
      const provider = new ParquetEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
      return { provider, document: provider.openCustomDocument(fixtureUri(name)) };
    }

    const request = (seq: number, ...filters: Array<{ column: number; text: string }>) => ({
      type: 'filter' as const,
      seq,
      filters,
    });

    /** These cases fail on purpose; keep the expected warning out of the test output. */
    async function quietly<T>(fn: () => Promise<T>): Promise<T> {
      const original = statsHooks.log;
      statsHooks.log = () => undefined;
      try {
        return await fn();
      } finally {
        statsHooks.log = original;
      }
    }

    it('filters the whole file, echoing seq and no table', async () => {
      const { provider, document } = providerAndDocument('filter.parquet');
      const payload = await provider.handleFilter(document, request(4, { column: 2, text: 'rome' }));
      assert.ok(payload && payload.rows);
      assert.strictEqual(payload.seq, 4);
      assert.ok(!('table' in payload));
      assert.strictEqual(payload.matchCount, 2);
      assert.deepStrictEqual(idsOf(payload.rows), [1, 4]);
    });

    it('ANDs filters across columns', async () => {
      const { provider, document } = providerAndDocument('filter.parquet');
      const payload = await provider.handleFilter(
        document,
        request(1, { column: 2, text: 'rome' }, { column: 3, text: '>9' })
      );
      assert.deepStrictEqual(idsOf(payload?.rows ?? []), [1]);
    });

    it('answers invalid filter text with errors and runs nothing', async () => {
      const { provider, document } = providerAndDocument('filter.parquet');
      const payload = await provider.handleFilter(document, request(2, { column: 3, text: '>' }));
      assert.strictEqual(payload?.seq, 2);
      assert.strictEqual(payload?.errors?.[0].column, 3);
      assert.ok(!payload?.rows);
      assert.strictEqual(document.filterRows, undefined, 'nothing was loaded');
    });

    it('keeps the parsed rows while filtering and releases them when the filters are cleared', async () => {
      const { provider, document } = providerAndDocument('filter.parquet');
      await provider.handleFilter(document, request(1, { column: 2, text: 'rome' }));
      const cached = document.filterRows;
      assert.ok(cached, 'a small table is cached between keystrokes');
      await provider.handleFilter(document, request(2, { column: 2, text: 'oslo' }));
      assert.strictEqual(document.filterRows, cached, 'the next keystroke reuses the same rows');
      assert.strictEqual(await provider.handleFilter(document, request(3)), undefined, 'clearing sends no reply');
      assert.strictEqual(document.filterRows, undefined);
    });

    it('treats blank filter boxes as cleared', async () => {
      const { provider, document } = providerAndDocument('filter.parquet');
      await provider.handleFilter(document, request(1, { column: 2, text: 'rome' }));
      assert.strictEqual(await provider.handleFilter(document, request(2, { column: 2, text: '  ' })), undefined);
      assert.strictEqual(document.filterRows, undefined);
    });

    it('does not keep a table over the cache limit, but still filters it', async () => {
      const { provider, document } = providerAndDocument('filter.parquet');
      const original = filterLimits.maxCachedCells;
      filterLimits.maxCachedCells = 5;
      try {
        const payload = await provider.handleFilter(document, request(1, { column: 2, text: 'rome' }));
        assert.strictEqual(payload?.matchCount, 2);
        assert.strictEqual(document.filterRows, undefined);
      } finally {
        filterLimits.maxCachedCells = original;
      }
    });

    it('drops a request that a newer one overtook while it waited on the file', async () => {
      const { provider, document } = providerAndDocument('filter.parquet');
      const [stale, fresh] = await Promise.all([
        provider.handleFilter(document, request(1, { column: 2, text: 'rome' })),
        provider.handleFilter(document, request(2, { column: 2, text: 'oslo' })),
      ]);
      assert.strictEqual(stale, undefined);
      assert.strictEqual(fresh?.seq, 2);
      assert.deepStrictEqual(idsOf(fresh?.rows ?? []), [3]);
    });

    it('does not re-fill the cache for a request that a clear overtook while it was decoding', async () => {
      // The post-read seq check can't see this window: the clear must land
      // *during* the decode, so the loader is gated and signals when it starts.
      const { provider, document } = providerAndDocument('filter.parquet');
      const patchable = parquetParser as unknown as { parquetRowsForFilter: typeof parquetParser.parquetRowsForFilter };
      const original = patchable.parquetRowsForFilter;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const insideLoader = new Promise<void>((resolve) => {
        entered = resolve;
      });
      patchable.parquetRowsForFilter = async (bytes) => {
        entered();
        await gate;
        return original(bytes);
      };
      try {
        const stale = provider.handleFilter(document, request(1, { column: 2, text: 'rome' }));
        await insideLoader;
        assert.strictEqual(await provider.handleFilter(document, request(2)), undefined, 'the clear sends no reply');
        release();
        assert.strictEqual(await stale, undefined, 'the overtaken request is dropped');
        assert.strictEqual(document.filterRows, undefined, 'and must not leave rows cached after the clear');
      } finally {
        patchable.parquetRowsForFilter = original;
      }
    });

    it('refuses a filter on a column the file does not have', async () => {
      const { provider, document } = providerAndDocument('filter.parquet');
      const payload = await provider.handleFilter(document, request(1, { column: 99, text: 'x' }));
      assert.ok(payload?.failedReason);
      assert.ok(!payload?.rows);
    });

    it('answers an unreadable file with a failed filter instead of throwing', async () => {
      const { provider, document } = providerAndDocument('does-not-exist.parquet');
      const payload = await quietly(() => provider.handleFilter(document, request(1, { column: 0, text: 'x' })));
      assert.deepStrictEqual(payload, { seq: 1, failedReason: FILTER_FAILED_REASON });
    });
  });
});

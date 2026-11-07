import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import type { TablasApi } from '../../src/extension';
import type { CsvParseOutcome } from '../../src/csvParser';
import { CsvEditorProvider } from '../../src/csvEditorProvider';
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
 * Opens a fixture through the real `tablas.csvViewer` custom editor and
 * waits for `onDidPostCsvData` — i.e. for the extension host to actually
 * finish the ready-handshake and post `csv-data` to the webview. Just
 * awaiting `vscode.openWith` isn't enough: `resolveCustomEditor`'s
 * `onDidReceiveMessage` handler is async and unawaited, so a broken
 * handshake wouldn't make `openWith`'s promise reject.
 */
function openCsvAndAwaitOutcome(name: string): Promise<CsvParseOutcome> {
  const api = getApi();
  return new Promise<CsvParseOutcome>((resolve, reject) => {
    const subscription = api.onDidPostCsvData((outcome) => {
      subscription.dispose();
      resolve(outcome);
    });
    vscode.commands
      .executeCommand('vscode.openWith', fixtureUri(name), 'tablas.csvViewer')
      .then(undefined, (err) => {
        subscription.dispose();
        reject(err);
      });
  });
}

describe('CsvEditorProvider Integration', () => {
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

  it('extension is present', () => {
    const ext = vscode.extensions.getExtension('gerardovitale.tablas');
    assert.ok(ext, 'Extension should be installed in Extension Development Host');
  });

  it('extension activates successfully', async () => {
    const ext = vscode.extensions.getExtension('gerardovitale.tablas');
    assert.ok(ext, 'Extension should be installed');
    await ext.activate();
    assert.strictEqual(ext.isActive, true, 'Extension should be active');
  });

  it('tablas.csvViewer opens a CSV file', async () => {
    await openCsvAndAwaitOutcome('simple.csv');
    assert.ok(
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => tab.label.includes('simple.csv'))
      ),
      'simple.csv should be open in a tab'
    );
  });

  it('posts parsed csv-data for simple.csv', async () => {
    const outcome = await openCsvAndAwaitOutcome('simple.csv');
    assert.strictEqual(outcome.success, true, 'Parsing simple.csv should succeed');
    if (outcome.success) {
      assert.ok(outcome.data.rowCount > 0, 'simple.csv should parse at least one row');
      assert.ok(outcome.data.columnCount > 0, 'simple.csv should parse at least one column');
    }
  });

  it('posts parsed csv-data for empty.csv', async () => {
    const outcome = await openCsvAndAwaitOutcome('empty.csv');
    assert.strictEqual(outcome.success, true, 'Parsing empty.csv should succeed');
    if (outcome.success) {
      assert.strictEqual(outcome.data.rowCount, 0);
      assert.strictEqual(outcome.data.columnCount, 0);
    }
  });

  it('posts parsed csv-data for quoted.csv', async () => {
    const outcome = await openCsvAndAwaitOutcome('quoted.csv');
    assert.strictEqual(outcome.success, true, 'Parsing quoted.csv should succeed');
    if (outcome.success) {
      assert.ok(outcome.data.rowCount > 0, 'quoted.csv should parse at least one row');
    }
  });

  describe('handleGetStats (lazy column statistics, no webview involved)', () => {
    function providerAndDocument(name: string) {
      const provider = new CsvEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
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
      const { provider, document } = providerAndDocument('simple.csv');
      const payload = await provider.handleGetStats(document);
      assert.strictEqual(payload.table, undefined);
      assert.strictEqual(payload.stats?.columns.length, 3);
      assert.strictEqual(payload.stats?.columns[1].type, 'integer');
      assert.strictEqual(payload.stats?.columns[1].max, '35');
    });

    it('gives an empty file no stats', async () => {
      const { provider, document } = providerAndDocument('empty.csv');
      assert.deepStrictEqual(await provider.handleGetStats(document), { stats: undefined });
    });

    it('answers an unreadable file with no stats instead of throwing', async () => {
      const { provider, document } = providerAndDocument('does-not-exist.csv');
      assert.deepStrictEqual(await quietly(() => provider.handleGetStats(document)), { stats: undefined });
    });
  });

  describe('handleFilter (whole-file filtering, no webview involved)', () => {
    function providerAndDocument(name: string) {
      const provider = new CsvEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
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
      const { provider, document } = providerAndDocument('filter.csv');
      const payload = await provider.handleFilter(document, request(4, { column: 2, text: 'rome' }));
      assert.ok(payload && payload.rows);
      assert.strictEqual(payload.seq, 4);
      assert.ok(!('table' in payload));
      assert.strictEqual(payload.matchCount, 2);
      assert.deepStrictEqual(idsOf(payload.rows), [1, 4]);
    });

    it('ANDs filters across columns', async () => {
      const { provider, document } = providerAndDocument('filter.csv');
      const payload = await provider.handleFilter(
        document,
        request(1, { column: 2, text: 'rome' }, { column: 3, text: '>9' })
      );
      assert.deepStrictEqual(idsOf(payload?.rows ?? []), [1]);
    });

    it('answers invalid filter text with errors and runs nothing', async () => {
      const { provider, document } = providerAndDocument('filter.csv');
      const payload = await provider.handleFilter(document, request(2, { column: 3, text: '>' }));
      assert.strictEqual(payload?.seq, 2);
      assert.strictEqual(payload?.errors?.[0].column, 3);
      assert.ok(!payload?.rows);
      assert.strictEqual(document.filterRows, undefined, 'nothing was loaded');
    });

    it('keeps the parsed rows while filtering and releases them when the filters are cleared', async () => {
      const { provider, document } = providerAndDocument('filter.csv');
      await provider.handleFilter(document, request(1, { column: 2, text: 'rome' }));
      const cached = document.filterRows;
      assert.ok(cached, 'a small table is cached between keystrokes');
      await provider.handleFilter(document, request(2, { column: 2, text: 'oslo' }));
      assert.strictEqual(document.filterRows, cached, 'the next keystroke reuses the same rows');
      assert.strictEqual(await provider.handleFilter(document, request(3)), undefined, 'clearing sends no reply');
      assert.strictEqual(document.filterRows, undefined);
    });

    it('treats blank filter boxes as cleared', async () => {
      const { provider, document } = providerAndDocument('filter.csv');
      await provider.handleFilter(document, request(1, { column: 2, text: 'rome' }));
      assert.strictEqual(await provider.handleFilter(document, request(2, { column: 2, text: '  ' })), undefined);
      assert.strictEqual(document.filterRows, undefined);
    });

    it('does not keep a table over the cache limit, but still filters it', async () => {
      const { provider, document } = providerAndDocument('filter.csv');
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
      const { provider, document } = providerAndDocument('filter.csv');
      const [stale, fresh] = await Promise.all([
        provider.handleFilter(document, request(1, { column: 2, text: 'rome' })),
        provider.handleFilter(document, request(2, { column: 2, text: 'oslo' })),
      ]);
      assert.strictEqual(stale, undefined);
      assert.strictEqual(fresh?.seq, 2);
      assert.deepStrictEqual(idsOf(fresh?.rows ?? []), [3]);
    });

    it('refuses a filter on a column the file does not have', async () => {
      const { provider, document } = providerAndDocument('filter.csv');
      const payload = await provider.handleFilter(document, request(1, { column: 99, text: 'x' }));
      assert.ok(payload?.failedReason);
      assert.ok(!payload?.rows);
    });

    it('answers an unreadable file with a failed filter instead of throwing', async () => {
      const { provider, document } = providerAndDocument('does-not-exist.csv');
      const payload = await quietly(() => provider.handleFilter(document, request(1, { column: 0, text: 'x' })));
      assert.deepStrictEqual(payload, { seq: 1, failedReason: FILTER_FAILED_REASON });
    });
  });
});

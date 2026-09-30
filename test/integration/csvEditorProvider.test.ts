import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import type { TablasApi } from '../../src/extension';
import type { CsvParseOutcome } from '../../src/csvParser';
import { CsvEditorProvider } from '../../src/csvEditorProvider';
import { statsHooks } from '../../src/columnStats';

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
});

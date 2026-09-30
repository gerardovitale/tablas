import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import type { TablasApi } from '../../src/extension';
import type { MultiTableParseOutcome } from '../../src/tableData';
import { XlsxEditorProvider } from '../../src/xlsxEditorProvider';
import { openXlsxWorkbook } from '../../src/xlsxParser';

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
 * Opens a fixture through the real `tablas.xlsxViewer` custom editor and
 * waits for `onDidPostXlsxData` — i.e. for the extension host to actually
 * finish the ready-handshake and post `xlsx-data` to the webview. Just
 * awaiting `vscode.openWith` isn't enough: `resolveCustomEditor`'s
 * `onDidReceiveMessage` handler is async and unawaited, so a broken
 * handshake wouldn't make `openWith`'s promise reject.
 */
function openXlsxAndAwaitOutcome(name: string): Promise<MultiTableParseOutcome> {
  const api = getApi();
  return new Promise<MultiTableParseOutcome>((resolve, reject) => {
    const subscription = api.onDidPostXlsxData((outcome) => {
      subscription.dispose();
      resolve(outcome);
    });
    vscode.commands
      .executeCommand('vscode.openWith', fixtureUri(name), 'tablas.xlsxViewer')
      .then(undefined, (err) => {
        subscription.dispose();
        reject(err);
      });
  });
}

describe('XlsxEditorProvider Integration', () => {
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

  it('tablas.xlsxViewer opens an XLSX file', async () => {
    await openXlsxAndAwaitOutcome('simple.xlsx');
    assert.ok(
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => tab.label.includes('simple.xlsx'))
      ),
      'simple.xlsx should be open in a tab'
    );
  });

  it('posts parsed xlsx-data for simple.xlsx, selecting its one sheet', async () => {
    const outcome = await openXlsxAndAwaitOutcome('simple.xlsx');
    assert.strictEqual(outcome.success, true, 'Parsing simple.xlsx should succeed');
    if (outcome.success) {
      assert.deepStrictEqual(outcome.data.tables, [{ name: 'people', type: 'table' }]);
      assert.strictEqual(outcome.data.selectedTable, 'people');
      assert.strictEqual(outcome.data.data.rowCount, 3);
    }
  });

  it('posts parsed xlsx-data for multi-sheet.xlsx, listing every sheet', async () => {
    const outcome = await openXlsxAndAwaitOutcome('multi-sheet.xlsx');
    assert.strictEqual(outcome.success, true, 'Parsing multi-sheet.xlsx should succeed');
    if (outcome.success) {
      assert.deepStrictEqual(outcome.data.tables, [
        { name: 'customers', type: 'table' },
        { name: 'orders', type: 'table' },
      ]);
      assert.strictEqual(outcome.data.selectedTable, 'customers');
    }
  });

  it('posts parsed xlsx-data for empty.xlsx', async () => {
    const outcome = await openXlsxAndAwaitOutcome('empty.xlsx');
    assert.strictEqual(outcome.success, true, 'Parsing empty.xlsx should succeed');
    if (outcome.success) {
      assert.strictEqual(outcome.data.data.rowCount, 0);
      assert.ok(outcome.data.data.columnCount > 0, 'empty.xlsx should still expose its headers');
    }
  });

  it('posts a failed outcome for a corrupt file, through the real handshake', async () => {
    const outcome = await openXlsxAndAwaitOutcome('corrupt.xlsx');
    assert.strictEqual(outcome.success, false, 'Parsing corrupt.xlsx should fail cleanly');
  });

  /**
   * The sheet-switch round trip (webview `<select>` change -> `select-table`
   * message -> host response) can't be driven end-to-end from test code:
   * `vscode-test`/`@vscode/test-electron` exposes `Webview.postMessage` for
   * the *host* to send messages, and `onDidReceiveMessage` for the host to
   * *listen*, but there is no public API to inject a message as if it came
   * from the webview's own script without actually executing that script.
   * So the host-side switch logic is exercised directly here instead, via
   * `XlsxEditorProvider.handleSelectTable` -- the same method
   * `resolveCustomEditor`'s message listener calls in production -- bypassing
   * the webview entirely. This mirrors
   * test/integration/sqliteEditorProvider.test.ts's equivalent coverage.
   */
  describe('handleSelectTable (host-side sheet switch, no webview involved)', () => {
    async function openDocumentWithWorkbook(name: string) {
      const provider = new XlsxEditorProvider({
        extensionPath: process.cwd(),
      } as vscode.ExtensionContext);
      const uri = fixtureUri(name);
      const document = provider.openCustomDocument(uri);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const opened = await openXlsxWorkbook(bytes);
      assert.ok(!('error' in opened), `fixture ${name} should open cleanly`);
      if (!('error' in opened)) {
        document.workbook = opened.workbook;
      }
      return { provider, document };
    }

    it('re-reads the already-parsed workbook for a different sheet', async () => {
      const { provider, document } = await openDocumentWithWorkbook('multi-sheet.xlsx');
      const outcome = provider.handleSelectTable(document, 'orders');
      assert.ok(outcome, 'handleSelectTable should not no-op once the workbook is parsed');
      assert.strictEqual(outcome?.success, true);
      if (outcome?.success) {
        assert.strictEqual(outcome.data.selectedTable, 'orders');
        assert.strictEqual(outcome.data.data.rowCount, 3);
        // Stats are lazy now: rows never carry them (see handleGetStats below).
        assert.strictEqual('stats' in outcome.data.data, false);
        // The full sheet list is preserved regardless of which one is selected.
        assert.strictEqual(outcome.data.tables.length, 2);
      }
    });

    it('falls back to the first sheet when asked for one that does not exist', async () => {
      const { provider, document } = await openDocumentWithWorkbook('multi-sheet.xlsx');
      const outcome = provider.handleSelectTable(document, 'nope');
      assert.strictEqual(outcome?.success, true);
      if (outcome?.success) {
        assert.strictEqual(outcome.data.selectedTable, 'customers');
      }
    });

    it('is a no-op returning undefined when the workbook is not parsed yet', () => {
      const provider = new XlsxEditorProvider({
        extensionPath: process.cwd(),
      } as vscode.ExtensionContext);
      const document = provider.openCustomDocument(fixtureUri('multi-sheet.xlsx'));
      const outcome = provider.handleSelectTable(document, 'orders');
      assert.strictEqual(outcome, undefined);
    });

    describe('handleGetStats (lazy column statistics)', () => {
      it('computes stats for the requested sheet, echoing its name', async () => {
        const { provider, document } = await openDocumentWithWorkbook('multi-sheet.xlsx');
        const payload = await provider.handleGetStats(document, 'orders');
        assert.strictEqual(payload?.table, 'orders');
        assert.ok(payload?.stats && payload.stats.columns.length > 0);
      });

      it('answers an unknown sheet with a payload that has no stats, rather than throwing', async () => {
        const { provider, document } = await openDocumentWithWorkbook('multi-sheet.xlsx');
        assert.deepStrictEqual(await provider.handleGetStats(document, 'nope'), { table: 'nope', stats: undefined });
        assert.deepStrictEqual(await provider.handleGetStats(document), { table: undefined, stats: undefined });
      });

      it('is a no-op returning undefined when the workbook is not parsed yet', async () => {
        const provider = new XlsxEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
        const document = provider.openCustomDocument(fixtureUri('multi-sheet.xlsx'));
        assert.strictEqual(await provider.handleGetStats(document, 'orders'), undefined);
      });
    });
  });
});

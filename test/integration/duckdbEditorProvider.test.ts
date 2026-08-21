import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import type { TablasApi } from '../../src/extension';
import type { MultiTableParseOutcome } from '../../src/tableData';
import { DuckdbEditorProvider } from '../../src/duckdbEditorProvider';
import { openDuckdbDatabase } from '../../src/duckdbParser';

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
 * Opens a fixture through the real `tablas.duckdbViewer` custom editor and
 * waits for `onDidPostDuckdbData` — i.e. for the extension host to
 * actually finish the ready-handshake and post `duckdb-data` to the
 * webview. Just awaiting `vscode.openWith` isn't enough:
 * `resolveCustomEditor`'s `onDidReceiveMessage` handler is async and
 * unawaited, so a broken handshake wouldn't make `openWith`'s promise
 * reject.
 */
function openDuckdbAndAwaitOutcome(name: string): Promise<MultiTableParseOutcome> {
  const api = getApi();
  return new Promise<MultiTableParseOutcome>((resolve, reject) => {
    const subscription = api.onDidPostDuckdbData((outcome) => {
      subscription.dispose();
      resolve(outcome);
    });
    vscode.commands
      .executeCommand('vscode.openWith', fixtureUri(name), 'tablas.duckdbViewer')
      .then(undefined, (err) => {
        subscription.dispose();
        reject(err);
      });
  });
}

describe('DuckdbEditorProvider Integration', () => {
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

  it('tablas.duckdbViewer opens a DuckDB file', async () => {
    await openDuckdbAndAwaitOutcome('simple.duckdb');
    assert.ok(
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => tab.label.includes('simple.duckdb'))
      ),
      'simple.duckdb should be open in a tab'
    );
  });

  it('posts parsed duckdb-data for simple.duckdb, selecting its one table', async () => {
    const outcome = await openDuckdbAndAwaitOutcome('simple.duckdb');
    assert.strictEqual(outcome.success, true, 'Parsing simple.duckdb should succeed');
    if (outcome.success) {
      assert.deepStrictEqual(outcome.data.tables, [{ name: 'people', type: 'table' }]);
      assert.strictEqual(outcome.data.selectedTable, 'people');
      assert.strictEqual(outcome.data.data.rowCount, 3);
    }
  });

  it('posts parsed duckdb-data for multi-table.duckdb, listing every table and view', async () => {
    const outcome = await openDuckdbAndAwaitOutcome('multi-table.duckdb');
    assert.strictEqual(outcome.success, true, 'Parsing multi-table.duckdb should succeed');
    if (outcome.success) {
      assert.deepStrictEqual(outcome.data.tables, [
        { name: 'customer_totals', type: 'view' },
        { name: 'customers', type: 'table' },
        { name: 'orders', type: 'table' },
      ]);
    }
  });

  it('posts parsed duckdb-data for empty.duckdb', async () => {
    const outcome = await openDuckdbAndAwaitOutcome('empty.duckdb');
    assert.strictEqual(outcome.success, true, 'Parsing empty.duckdb should succeed');
    if (outcome.success) {
      assert.strictEqual(outcome.data.data.rowCount, 0);
      assert.ok(outcome.data.data.columnCount > 0, 'empty.duckdb should still expose its schema');
    }
  });

  it('posts a success outcome with no tables for no-tables.duckdb', async () => {
    const outcome = await openDuckdbAndAwaitOutcome('no-tables.duckdb');
    assert.strictEqual(outcome.success, true, 'Opening no-tables.duckdb should succeed');
    if (outcome.success) {
      assert.deepStrictEqual(outcome.data.tables, []);
    }
  });

  it('posts a failed outcome for a corrupt file, through the real handshake', async () => {
    const outcome = await openDuckdbAndAwaitOutcome('corrupt.duckdb');
    assert.strictEqual(outcome.success, false, 'Parsing corrupt.duckdb should fail cleanly');
  });

  /**
   * The table-switch round trip (webview `<select>` change -> `select-table`
   * message -> host response) can't be driven end-to-end from test code --
   * see sqliteEditorProvider.test.ts's identical comment. The host-side
   * switch logic is exercised directly here instead, via
   * `DuckdbEditorProvider.handleSelectTable` -- the same method
   * `resolveCustomEditor`'s message listener calls in production -- bypassing
   * the webview entirely.
   */
  describe('handleSelectTable (host-side table switch, no webview involved)', () => {
    async function openDocumentWithHandle(name: string) {
      const provider = new DuckdbEditorProvider({
        extensionPath: process.cwd(),
      } as vscode.ExtensionContext);
      const uri = fixtureUri(name);
      const document = provider.openCustomDocument(uri);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const opened = await openDuckdbDatabase(bytes);
      assert.ok(!('error' in opened), `fixture ${name} should open cleanly`);
      if (!('error' in opened)) {
        document.handle = opened;
      }
      return { provider, document };
    }

    it('re-queries the already-open database for a different table', async () => {
      const { provider, document } = await openDocumentWithHandle('multi-table.duckdb');
      try {
        const outcome = await provider.handleSelectTable(document, 'orders');
        assert.ok(outcome, 'handleSelectTable should not no-op once the database is open');
        assert.strictEqual(outcome?.success, true);
        if (outcome?.success) {
          assert.strictEqual(outcome.data.selectedTable, 'orders');
          assert.strictEqual(outcome.data.data.rowCount, 3);
          // The full table list is preserved regardless of which one is selected.
          assert.strictEqual(outcome.data.tables.length, 3);
        }
      } finally {
        document.dispose();
      }
    });

    it('falls back to the first table when asked for one that does not exist', async () => {
      const { provider, document } = await openDocumentWithHandle('multi-table.duckdb');
      try {
        const outcome = await provider.handleSelectTable(document, 'nope');
        assert.strictEqual(outcome?.success, true);
        if (outcome?.success) {
          assert.strictEqual(outcome.data.selectedTable, 'customer_totals');
        }
      } finally {
        document.dispose();
      }
    });

    it('is a no-op returning undefined when the database is not open yet', async () => {
      const provider = new DuckdbEditorProvider({
        extensionPath: process.cwd(),
      } as vscode.ExtensionContext);
      const document = provider.openCustomDocument(fixtureUri('multi-table.duckdb'));
      const outcome = await provider.handleSelectTable(document, 'orders');
      assert.strictEqual(outcome, undefined);
    });
  });
});

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import type { TablasApi } from '../../src/extension';
import type { MultiTableParseOutcome } from '../../src/tableData';
import { SqliteEditorProvider } from '../../src/sqliteEditorProvider';
import { openSqliteDatabase } from '../../src/sqliteParser';

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
 * Opens a fixture through the real `tablas.sqliteViewer` custom editor and
 * waits for `onDidPostSqliteData` — i.e. for the extension host to
 * actually finish the ready-handshake and post `sqlite-data` to the
 * webview. Just awaiting `vscode.openWith` isn't enough:
 * `resolveCustomEditor`'s `onDidReceiveMessage` handler is async and
 * unawaited, so a broken handshake wouldn't make `openWith`'s promise
 * reject.
 */
function openSqliteAndAwaitOutcome(name: string): Promise<MultiTableParseOutcome> {
  const api = getApi();
  return new Promise<MultiTableParseOutcome>((resolve, reject) => {
    const subscription = api.onDidPostSqliteData((outcome) => {
      subscription.dispose();
      resolve(outcome);
    });
    vscode.commands
      .executeCommand('vscode.openWith', fixtureUri(name), 'tablas.sqliteViewer')
      .then(undefined, (err) => {
        subscription.dispose();
        reject(err);
      });
  });
}

describe('SqliteEditorProvider Integration', () => {
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

  it('tablas.sqliteViewer opens a SQLite file', async () => {
    await openSqliteAndAwaitOutcome('simple.db');
    assert.ok(
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => tab.label.includes('simple.db'))
      ),
      'simple.db should be open in a tab'
    );
  });

  it('posts parsed sqlite-data for simple.db, selecting its one table', async () => {
    const outcome = await openSqliteAndAwaitOutcome('simple.db');
    assert.strictEqual(outcome.success, true, 'Parsing simple.db should succeed');
    if (outcome.success) {
      assert.deepStrictEqual(outcome.data.tables, [{ name: 'people', type: 'table' }]);
      assert.strictEqual(outcome.data.selectedTable, 'people');
      assert.strictEqual(outcome.data.data.rowCount, 3);
    }
  });

  it('posts parsed sqlite-data for multi-table.db, listing every table and view', async () => {
    const outcome = await openSqliteAndAwaitOutcome('multi-table.db');
    assert.strictEqual(outcome.success, true, 'Parsing multi-table.db should succeed');
    if (outcome.success) {
      assert.deepStrictEqual(outcome.data.tables, [
        { name: 'customer_totals', type: 'view' },
        { name: 'customers', type: 'table' },
        { name: 'orders', type: 'table' },
      ]);
    }
  });

  it('posts parsed sqlite-data for empty.db', async () => {
    const outcome = await openSqliteAndAwaitOutcome('empty.db');
    assert.strictEqual(outcome.success, true, 'Parsing empty.db should succeed');
    if (outcome.success) {
      assert.strictEqual(outcome.data.data.rowCount, 0);
      assert.ok(outcome.data.data.columnCount > 0, 'empty.db should still expose its schema');
    }
  });

  it('posts a success outcome with no tables for no-tables.db', async () => {
    const outcome = await openSqliteAndAwaitOutcome('no-tables.db');
    assert.strictEqual(outcome.success, true, 'Opening no-tables.db should succeed');
    if (outcome.success) {
      assert.deepStrictEqual(outcome.data.tables, []);
    }
  });

  it('posts a failed outcome for a corrupt file, through the real handshake', async () => {
    const outcome = await openSqliteAndAwaitOutcome('corrupt.db');
    assert.strictEqual(outcome.success, false, 'Parsing corrupt.db should fail cleanly');
  });

  /**
   * The table-switch round trip (webview `<select>` change -> `select-table`
   * message -> host response) can't be driven end-to-end from test code:
   * `vscode-test`/`@vscode/test-electron` exposes `Webview.postMessage` for
   * the *host* to send messages, and `onDidReceiveMessage` for the host to
   * *listen*, but there is no public API to inject a message as if it came
   * from the webview's own script without actually executing that script.
   * So the host-side switch logic is exercised directly here instead, via
   * `SqliteEditorProvider.handleSelectTable` -- the same method
   * `resolveCustomEditor`'s message listener calls in production -- bypassing
   * the webview entirely. The webview-side `change` -> `postMessage` wiring
   * is covered separately in test/unit/webview/render.test.ts.
   */
  describe('handleSelectTable (host-side table switch, no webview involved)', () => {
    async function openDocumentWithHandle(name: string) {
      const provider = new SqliteEditorProvider({
        extensionPath: process.cwd(),
      } as vscode.ExtensionContext);
      const uri = fixtureUri(name);
      const document = provider.openCustomDocument(uri);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const opened = await openSqliteDatabase(bytes);
      assert.ok(!('error' in opened), `fixture ${name} should open cleanly`);
      if (!('error' in opened)) {
        document.handle = opened;
      }
      return { provider, document };
    }

    it('re-queries the already-open database for a different table', async () => {
      const { provider, document } = await openDocumentWithHandle('multi-table.db');
      try {
        const outcome = provider.handleSelectTable(document, 'orders');
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
      const { provider, document } = await openDocumentWithHandle('multi-table.db');
      try {
        const outcome = provider.handleSelectTable(document, 'nope');
        assert.strictEqual(outcome?.success, true);
        if (outcome?.success) {
          assert.strictEqual(outcome.data.selectedTable, 'customer_totals');
        }
      } finally {
        document.dispose();
      }
    });

    it('is a no-op returning undefined when the database is not open yet', () => {
      const provider = new SqliteEditorProvider({
        extensionPath: process.cwd(),
      } as vscode.ExtensionContext);
      const document = provider.openCustomDocument(fixtureUri('multi-table.db'));
      const outcome = provider.handleSelectTable(document, 'orders');
      assert.strictEqual(outcome, undefined);
    });
  });
});

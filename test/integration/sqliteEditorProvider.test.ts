import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import type { TablasApi } from '../../src/extension';
import type { MultiTableParseOutcome } from '../../src/tableData';
import { SqliteEditorProvider } from '../../src/sqliteEditorProvider';
import { openSqliteDatabase } from '../../src/sqliteParser';
import { idsOf } from '../unit/filterCases';
import { FILTER_UNKNOWN_TABLE_REASON } from '../../src/filter';

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
          // Stats are lazy now: rows never carry them (see handleGetStats below).
          assert.strictEqual('stats' in outcome.data.data, false);
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

    describe('handleGetStats (lazy column statistics)', () => {
      it('computes stats for the requested table, echoing its name', async () => {
        const { provider, document } = await openDocumentWithHandle('multi-table.db');
        try {
          const payload = await provider.handleGetStats(document, 'orders');
          assert.strictEqual(payload?.table, 'orders');
          assert.strictEqual(payload?.stats?.columns.length, 3);
          assert.strictEqual(payload?.stats?.columns[2].max, '42');
        } finally {
          document.dispose();
        }
      });

      it('works for a view too', async () => {
        const { provider, document } = await openDocumentWithHandle('multi-table.db');
        try {
          const payload = await provider.handleGetStats(document, 'customer_totals');
          assert.strictEqual(payload?.stats?.columns.length, 2);
        } finally {
          document.dispose();
        }
      });

      it('answers an unknown table with a payload that has no stats, rather than throwing', async () => {
        const { provider, document } = await openDocumentWithHandle('multi-table.db');
        try {
          assert.deepStrictEqual(await provider.handleGetStats(document, 'nope'), { table: 'nope', stats: undefined });
          assert.deepStrictEqual(await provider.handleGetStats(document), { table: undefined, stats: undefined });
        } finally {
          document.dispose();
        }
      });

      it('is a no-op returning undefined when the database is not open yet', async () => {
        const provider = new SqliteEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
        const document = provider.openCustomDocument(fixtureUri('multi-table.db'));
        assert.strictEqual(await provider.handleGetStats(document, 'orders'), undefined);
      });
    });
  });

  describe('handleFilter (whole-table filtering, no webview involved)', () => {
    async function openDocumentWithHandle(name: string) {
      const provider = new SqliteEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
      const uri = fixtureUri(name);
      const document = provider.openCustomDocument(uri);
      const opened = await openSqliteDatabase(await vscode.workspace.fs.readFile(uri));
      assert.ok(!('error' in opened), `fixture ${name} should open cleanly`);
      if (!('error' in opened)) {
        document.handle = opened;
      }
      return { provider, document };
    }

    const request = (seq: number, table: string | undefined, ...filters: Array<{ column: number; text: string }>) => ({
      type: 'filter' as const,
      seq,
      ...(table !== undefined && { table }),
      filters,
    });

    it('filters the requested table, echoing seq and table', async () => {
      const { provider, document } = await openDocumentWithHandle('filter.db');
      try {
        const payload = await provider.handleFilter(document, request(3, 'items', { column: 2, text: 'rome' }));
        assert.ok(payload && payload.rows);
        assert.strictEqual(payload.seq, 3);
        assert.strictEqual(payload.table, 'items');
        assert.strictEqual(payload.matchCount, 2);
        assert.deepStrictEqual(idsOf(payload.rows), [1, 4]);
      } finally {
        document.dispose();
      }
    });

    it('answers invalid filter text with errors and runs nothing', async () => {
      const { provider, document } = await openDocumentWithHandle('filter.db');
      try {
        const payload = await provider.handleFilter(document, request(2, 'items', { column: 3, text: '<=' }));
        assert.strictEqual(payload?.errors?.[0].column, 3);
        assert.ok(!payload?.rows);
      } finally {
        document.dispose();
      }
    });

    it('sends no reply when the filters were cleared', async () => {
      const { provider, document } = await openDocumentWithHandle('filter.db');
      try {
        assert.strictEqual(await provider.handleFilter(document, request(2, 'items')), undefined);
        assert.strictEqual(await provider.handleFilter(document, request(3, 'items', { column: 1, text: '' })), undefined);
      } finally {
        document.dispose();
      }
    });

    it('fails cleanly for an unknown table, or none at all', async () => {
      const { provider, document } = await openDocumentWithHandle('filter.db');
      try {
        const unknown = await provider.handleFilter(document, request(1, 'nope', { column: 0, text: '1' }));
        assert.deepStrictEqual(unknown, { seq: 1, table: 'nope', failedReason: FILTER_UNKNOWN_TABLE_REASON });
        const missing = await provider.handleFilter(document, request(2, undefined, { column: 0, text: '1' }));
        assert.deepStrictEqual(missing, { seq: 2, failedReason: FILTER_UNKNOWN_TABLE_REASON });
      } finally {
        document.dispose();
      }
    });

    it('drops a request that a newer one overtook while it was queued', async () => {
      const { provider, document } = await openDocumentWithHandle('filter.db');
      try {
        const [stale, fresh] = await Promise.all([
          provider.handleFilter(document, request(1, 'items', { column: 2, text: 'rome' })),
          provider.handleFilter(document, request(2, 'items', { column: 2, text: 'oslo' })),
        ]);
        assert.strictEqual(stale, undefined);
        assert.strictEqual(fresh?.seq, 2);
        assert.deepStrictEqual(idsOf(fresh?.rows ?? []), [3]);
      } finally {
        document.dispose();
      }
    });

    it('is a no-op returning undefined when the database is not open yet', async () => {
      const provider = new SqliteEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
      const document = provider.openCustomDocument(fixtureUri('filter.db'));
      assert.strictEqual(await provider.handleFilter(document, request(1, 'items', { column: 0, text: '1' })), undefined);
    });
  });
});

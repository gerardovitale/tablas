import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { TablasApi } from '../../src/extension';
import type { MultiTableParseOutcome } from '../../src/tableData';
import { DuckdbEditorProvider } from '../../src/duckdbEditorProvider';
import { DuckDBInstance } from '@duckdb/node-api';
import { openDuckdbDatabase, queryLimits } from '../../src/duckdbParser';
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
      assert.deepStrictEqual(outcome.data.tables, [{ name: 'people', type: 'table', approxRows: 3 }]);
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
        { name: 'customers', type: 'table', approxRows: 2 },
        { name: 'orders', type: 'table', approxRows: 3 },
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
   * The table-switch round trip (webview table picker choice -> `select-table`
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

    describe('handleGetStats (lazy column statistics)', () => {
      it('computes stats for the requested table, echoing its name', async () => {
        const { provider, document } = await openDocumentWithHandle('multi-table.duckdb');
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
        const { provider, document } = await openDocumentWithHandle('multi-table.duckdb');
        try {
          const payload = await provider.handleGetStats(document, 'customer_totals');
          assert.strictEqual(payload?.stats?.columns.length, 2);
        } finally {
          document.dispose();
        }
      });

      it('answers a table switch and a stats request issued together without either failing', async () => {
        const { provider, document } = await openDocumentWithHandle('multi-table.duckdb');
        try {
          const [outcome, payload] = await Promise.all([
            provider.handleSelectTable(document, 'customers'),
            provider.handleGetStats(document, 'orders'),
          ]);
          assert.strictEqual(outcome?.success, true);
          assert.strictEqual(payload?.stats?.columns.length, 3);
        } finally {
          document.dispose();
        }
      });

      it('answers an unknown table with a payload that has no stats, rather than throwing', async () => {
        const { provider, document } = await openDocumentWithHandle('multi-table.duckdb');
        try {
          assert.deepStrictEqual(await provider.handleGetStats(document, 'nope'), { table: 'nope', stats: undefined });
          assert.deepStrictEqual(await provider.handleGetStats(document), { table: undefined, stats: undefined });
        } finally {
          document.dispose();
        }
      });

      it('is a no-op returning undefined when the database is not open yet', async () => {
        const provider = new DuckdbEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
        const document = provider.openCustomDocument(fixtureUri('multi-table.duckdb'));
        assert.strictEqual(await provider.handleGetStats(document, 'orders'), undefined);
      });
    });
  });

  describe('handleFilter (whole-table filtering, no webview involved)', () => {
    async function openDocumentWithHandle(name: string) {
      const provider = new DuckdbEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
      const uri = fixtureUri(name);
      const document = provider.openCustomDocument(uri);
      const opened = await openDuckdbDatabase(await vscode.workspace.fs.readFile(uri));
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
      const { provider, document } = await openDocumentWithHandle('filter.duckdb');
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
      const { provider, document } = await openDocumentWithHandle('filter.duckdb');
      try {
        const payload = await provider.handleFilter(document, request(2, 'items', { column: 3, text: '<=' }));
        assert.strictEqual(payload?.errors?.[0].column, 3);
        assert.ok(!payload?.rows);
      } finally {
        document.dispose();
      }
    });

    it('sends no reply when the filters were cleared', async () => {
      const { provider, document } = await openDocumentWithHandle('filter.duckdb');
      try {
        assert.strictEqual(await provider.handleFilter(document, request(2, 'items')), undefined);
        assert.strictEqual(await provider.handleFilter(document, request(3, 'items', { column: 1, text: '' })), undefined);
      } finally {
        document.dispose();
      }
    });

    it('fails cleanly for an unknown table, or none at all', async () => {
      const { provider, document } = await openDocumentWithHandle('filter.duckdb');
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
      const { provider, document } = await openDocumentWithHandle('filter.duckdb');
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
      const provider = new DuckdbEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
      const document = provider.openCustomDocument(fixtureUri('filter.duckdb'));
      assert.strictEqual(await provider.handleFilter(document, request(1, 'items', { column: 0, text: '1' })), undefined);
    });
  });
  /**
   * The last table shown per file is kept in `workspaceState`. The provider is
   * built with a stub memento here; `loadInitial` is what the ready-handshake
   * calls on first open.
   */
  describe('remembering the last table', () => {
    function stubContext(initial: Record<string, string> = {}) {
      const store = new Map<string, string>(Object.entries(initial));
      const context = {
        extensionPath: process.cwd(),
        workspaceState: {
          get: <T>(key: string) => store.get(key) as T | undefined,
          update: async (key: string, value: string) => {
            store.set(key, value);
          },
        },
      } as unknown as vscode.ExtensionContext;
      return { store, context };
    }
    const keyFor = (name: string) => `tablas.lastTable:${fixtureUri(name).toString()}`;

    it('stores the table after a successful switch', async () => {
      const { store, context } = stubContext();
      const provider = new DuckdbEditorProvider(context);
      const document = provider.openCustomDocument(fixtureUri('multi-table.duckdb'));
      try {
        await provider.loadInitial(document);
        assert.strictEqual(store.size, 0, 'the default first table is not a choice, so nothing is stored');
        await provider.handleSelectTable(document, 'orders');
        assert.strictEqual(store.get(keyFor('multi-table.duckdb')), 'orders');
      } finally {
        document.dispose();
      }
    });

    it('opens on the remembered table', async () => {
      const { context } = stubContext({ [keyFor('multi-table.duckdb')]: 'orders' });
      const provider = new DuckdbEditorProvider(context);
      const document = provider.openCustomDocument(fixtureUri('multi-table.duckdb'));
      try {
        const outcome = await provider.loadInitial(document);
        assert.strictEqual(outcome.success && outcome.data.selectedTable, 'orders');
      } finally {
        document.dispose();
      }
    });

    it('falls back to the first table when the remembered one no longer exists', async () => {
      const { context } = stubContext({ [keyFor('multi-table.duckdb')]: 'dropped_by_a_rebuild' });
      const provider = new DuckdbEditorProvider(context);
      const document = provider.openCustomDocument(fixtureUri('multi-table.duckdb'));
      try {
        const outcome = await provider.loadInitial(document);
        assert.strictEqual(outcome.success && outcome.data.selectedTable, 'customer_totals');
      } finally {
        document.dispose();
      }
    });

    it('remembers a table in another schema by its qualified name, and never stores an unreadable one', async () => {
      const { store, context } = stubContext();
      const provider = new DuckdbEditorProvider(context);
      const document = provider.openCustomDocument(fixtureUri('schemas.duckdb'));
      try {
        await provider.loadInitial(document);
        await provider.handleSelectTable(document, 'main_staging.orders');
        assert.strictEqual(store.get(keyFor('schemas.duckdb')), 'main_staging.orders');
        // A name that is not listed falls back to the first table; that is not the user's choice either way,
        // but what was actually shown (raw_events) is what gets remembered.
        await provider.handleSelectTable(document, 'nope');
        assert.strictEqual(store.get(keyFor('schemas.duckdb')), 'raw_events');
      } finally {
        document.dispose();
      }
    });

    it('works without a workspace state (a provider built with a bare context)', async () => {
      const provider = new DuckdbEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
      const document = provider.openCustomDocument(fixtureUri('multi-table.duckdb'));
      try {
        await provider.loadInitial(document);
        assert.strictEqual((await provider.handleSelectTable(document, 'orders'))?.success, true);
      } finally {
        document.dispose();
      }
    });
  });

  /** The SQL box: `handleRunQuery` is what the webview's `run-query` message ends up calling. */
  describe('handleRunQuery (read-only SQL, no webview involved)', () => {
    function stubContext() {
      const store = new Map<string, string | undefined>();
      const context = {
        extensionPath: process.cwd(),
        workspaceState: {
          get: <T>(key: string) => store.get(key) as T | undefined,
          update: async (key: string, value: string | undefined) => {
            store.set(key, value);
          },
        },
      } as unknown as vscode.ExtensionContext;
      return { store, context };
    }
    const queryKey = (name: string) => `tablas.lastQuery:${fixtureUri(name).toString()}`;

    async function open(name: string, context?: vscode.ExtensionContext) {
      const provider = new DuckdbEditorProvider(context ?? ({ extensionPath: process.cwd() } as vscode.ExtensionContext));
      const document = provider.openCustomDocument(fixtureUri(name));
      const outcome = await provider.loadInitial(document);
      return { provider, document, outcome };
    }

    it('answers with the rows, echoing seq', async () => {
      const { provider, document } = await open('multi-table.duckdb');
      try {
        const payload = await provider.handleRunQuery(document, {
          type: 'run-query',
          seq: 7,
          sql: 'SELECT name FROM customers ORDER BY id',
        });
        assert.strictEqual(payload?.seq, 7);
        assert.deepStrictEqual(payload?.data?.rows, [['Acme'], ['Globex']]);
        assert.strictEqual(payload?.truncated, false);
        assert.strictEqual(payload?.error, undefined);
      } finally {
        document.dispose();
      }
    });

    it('answers a refused or invalid query with the error text', async () => {
      const { provider, document } = await open('multi-table.duckdb');
      try {
        const copy = await provider.handleRunQuery(document, { type: 'run-query', seq: 1, sql: "COPY (SELECT 1) TO '/tmp/tablas-never.csv'" });
        assert.match(copy?.error ?? '', /^Only read queries can be run here/);
        assert.strictEqual(copy?.data, undefined);
        const bad = await provider.handleRunQuery(document, { type: 'run-query', seq: 2, sql: 'SELEC 1' });
        assert.match(bad?.error ?? '', /syntax error/);
        // and the connection is still good for the next table read
        assert.strictEqual((await provider.handleSelectTable(document, 'orders'))?.success, true);
      } finally {
        document.dispose();
      }
    });

    it('caps the rows at tablas.maxRows', async () => {
      const { provider, document } = await open('multi-table.duckdb');
      const config = vscode.workspace.getConfiguration('tablas');
      try {
        await config.update('maxRows', 2, vscode.ConfigurationTarget.Global);
        const payload = await provider.handleRunQuery(document, { type: 'run-query', seq: 1, sql: 'SELECT range FROM range(50)' });
        assert.strictEqual(payload?.data?.rowCount, 2);
        assert.strictEqual(payload?.truncated, true);
      } finally {
        await config.update('maxRows', undefined, vscode.ConfigurationTarget.Global);
        document.dispose();
      }
    });

    it('drops a request that a newer one overtook, and does nothing before the database is open', async () => {
      const { provider, document } = await open('multi-table.duckdb');
      try {
        const first = provider.handleRunQuery(document, { type: 'run-query', seq: 1, sql: 'SELECT 1' });
        const second = provider.handleRunQuery(document, { type: 'run-query', seq: 2, sql: 'SELECT 2 AS two' });
        assert.strictEqual(await first, undefined, 'the older request must not run');
        assert.deepStrictEqual((await second)?.data?.rows, [['2']]);
      } finally {
        document.dispose();
      }
      const closed = new DuckdbEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
      const unopened = closed.openCustomDocument(fixtureUri('multi-table.duckdb'));
      assert.strictEqual(await closed.handleRunQuery(unopened, { type: 'run-query', seq: 1, sql: 'SELECT 1' }), undefined);
    });

    it('remembers the query, and offers it again with a suggestion for the shown table', async () => {
      const { store, context } = stubContext();
      const first = await open('multi-table.duckdb', context);
      try {
        assert.ok(first.outcome.success);
        if (first.outcome.success) {
          assert.deepStrictEqual(first.outcome.data.capabilities, { refresh: true, query: true });
          assert.strictEqual(first.outcome.data.querySuggestion, 'SELECT * FROM "customer_totals" LIMIT 100');
          assert.strictEqual(first.outcome.data.lastQuery, undefined);
        }
        await first.provider.handleRunQuery(first.document, { type: 'run-query', seq: 1, sql: 'SELECT count(*) FROM orders' });
        assert.strictEqual(store.get(queryKey('multi-table.duckdb')), 'SELECT count(*) FROM orders');
      } finally {
        first.document.dispose();
      }
      const second = await open('multi-table.duckdb', context);
      try {
        assert.ok(second.outcome.success && second.outcome.data.lastQuery === 'SELECT count(*) FROM orders');
      } finally {
        second.document.dispose();
      }
    });

    it('keeps the last query that ran when a later text is too long to run', async () => {
      const { store, context } = stubContext();
      const { provider, document } = await open('multi-table.duckdb', context);
      const original = queryLimits.maxSqlLength;
      try {
        await provider.handleRunQuery(document, { type: 'run-query', seq: 1, sql: 'SELECT 1' });
        queryLimits.maxSqlLength = 20;
        const payload = await provider.handleRunQuery(document, {
          type: 'run-query',
          seq: 2,
          sql: 'SELECT * FROM orders WHERE 1 = 1',
        });
        assert.match(payload?.error ?? '', /too long/);
        assert.strictEqual(store.get(queryKey('multi-table.duckdb')), 'SELECT 1', 'the good query is not replaced or cleared');
      } finally {
        queryLimits.maxSqlLength = original;
        document.dispose();
      }
    });

    it('refuses EXPLAIN ANALYZE of a write through the whole handler, and writes nothing', async () => {
      const { provider, document } = await open('multi-table.duckdb');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-explain-'));
      const out = path.join(dir, 'out.csv');
      try {
        const payload = await provider.handleRunQuery(document, {
          type: 'run-query',
          seq: 1,
          sql: `EXPLAIN ANALYZE COPY (SELECT 1 AS a) TO '${out}'`,
        });
        assert.match(payload?.error ?? '', /^EXPLAIN ANALYZE runs the statement it explains/);
        assert.strictEqual(fs.existsSync(out), false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        document.dispose();
      }
    });

    it('suggests the schema-qualified name for a table outside main', async () => {
      const { provider, document } = await open('schemas.duckdb');
      try {
        const outcome = await provider.handleSelectTable(document, 'main_marts.orders');
        assert.ok(outcome?.success);
        if (outcome?.success) {
          assert.strictEqual(outcome.data.querySuggestion, 'SELECT * FROM "main_marts"."orders" LIMIT 100');
        }
      } finally {
        document.dispose();
      }
    });

    it('does not offer queries before there is a database (a file still being created)', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-query-'));
      const target = path.join(dir, 'empty-so-far.duckdb');
      fs.writeFileSync(target, new Uint8Array(0));
      try {
        const provider = new DuckdbEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
        const document = provider.openCustomDocument(vscode.Uri.file(target));
        const outcome = await provider.loadInitial(document);
        assert.ok(outcome.success);
        if (outcome.success) {
          assert.deepStrictEqual(outcome.data.capabilities, { refresh: true, query: false });
          assert.strictEqual(outcome.data.querySuggestion, undefined);
        }
        document.dispose();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('lists tables in every schema through the real handshake', async () => {
    const outcome = await openDuckdbAndAwaitOutcome('schemas.duckdb');
    assert.strictEqual(outcome.success, true);
    if (outcome.success) {
      assert.deepStrictEqual(
        outcome.data.tables.map((t) => t.name),
        ['raw_events', 'main_marts.orders', 'main_staging.orders', 'main_staging.stg_events', 'my schema.odd "name"']
      );
    }
  });

  /**
   * Live refresh: `handleReload` is what the file watcher, the toolbar button and
   * `tablas.refresh` all end up calling. Tested directly for the same reason as
   * `handleSelectTable`: a webview can't be driven from test code.
   */
  describe('handleReload (re-read the file from disk, no webview involved)', () => {
    let workDir: string;
    let target: string;

    beforeEach(() => {
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-reload-'));
      target = path.join(workDir, 'warehouse.duckdb');
    });

    afterEach(() => {
      fs.rmSync(workDir, { recursive: true, force: true });
    });

    const copyFixture = (name: string) => fs.copyFileSync(path.join(fixturesDir, name), target);

    async function openTarget() {
      const provider = new DuckdbEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
      const document = provider.openCustomDocument(vscode.Uri.file(target));
      const opened = await openDuckdbDatabase(await vscode.workspace.fs.readFile(document.uri));
      assert.ok(!('error' in opened), 'the copied fixture should open cleanly');
      if (!('error' in opened)) {
        document.handle = opened;
      }
      return { provider, document };
    }

    async function waitUntil(condition: () => boolean, what: string): Promise<void> {
      for (let i = 0; i < 100 && !condition(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(condition(), what);
    }

    it('keeps the selected table, swaps the handle and closes the old one', async () => {
      copyFixture('multi-table.duckdb');
      const { provider, document } = await openTarget();
      try {
        await provider.handleSelectTable(document, 'orders');
        const old = document.handle!;
        const outcome = await provider.handleReload(document);
        assert.strictEqual(outcome?.success, true);
        if (outcome?.success) {
          assert.strictEqual(outcome.data.selectedTable, 'orders');
          assert.strictEqual(outcome.data.data.rowCount, 3);
          assert.strictEqual(outcome.data.reload?.previousRowCount, 3);
          assert.ok(!Number.isNaN(Date.parse(outcome.data.reload?.at ?? '')), 'reload.at is an ISO timestamp');
          assert.deepStrictEqual(outcome.data.capabilities, { refresh: true, query: true });
        }
        assert.notStrictEqual(document.handle, old, 'a fresh handle replaces the old one');
        await waitUntil(() => !fs.existsSync(old.tempFilePath), 'the old handle should be closed');
        assert.ok(fs.existsSync(document.handle!.tempFilePath), 'the new handle stays open');
      } finally {
        document.dispose();
      }
    });

    it('shows the new contents when the file changed, and falls back if the table vanished', async () => {
      copyFixture('multi-table.duckdb');
      const { provider, document } = await openTarget();
      try {
        await provider.handleSelectTable(document, 'orders');
        copyFixture('simple.duckdb'); // a different warehouse: only `people`
        const outcome = await provider.handleReload(document);
        assert.strictEqual(outcome?.success, true);
        if (outcome?.success) {
          assert.deepStrictEqual(outcome.data.tables, [{ name: 'people', type: 'table', approxRows: 3 }]);
          assert.strictEqual(outcome.data.selectedTable, 'people');
          assert.strictEqual(outcome.data.reload?.previousRowCount, undefined, 'a different table has no previous count');
        }
      } finally {
        document.dispose();
      }
    });

    it('keeps the old handle and view when the file is unreadable right now', async () => {
      copyFixture('multi-table.duckdb');
      const { provider, document } = await openTarget();
      try {
        const old = document.handle!;
        fs.copyFileSync(path.join(fixturesDir, 'corrupt.duckdb'), target);
        const corrupt = await provider.handleReload(document);
        assert.strictEqual(corrupt?.success, false);
        fs.writeFileSync(target, new Uint8Array(0));
        const empty = await provider.handleReload(document);
        assert.strictEqual(empty?.success, false);
        assert.match(empty?.success === false ? empty.errors[0].message : '', /empty/);
        assert.strictEqual(document.handle, old, 'the working handle must survive a failed reload');
        assert.ok(fs.existsSync(old.tempFilePath));
        // ...and it still answers queries.
        const stillWorks = await provider.handleSelectTable(document, 'orders');
        assert.strictEqual(stillWorks?.success, true);
      } finally {
        document.dispose();
      }
    });

    it('is a no-op when the database is not open yet', async () => {
      copyFixture('multi-table.duckdb');
      const provider = new DuckdbEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
      const document = provider.openCustomDocument(vscode.Uri.file(target));
      assert.strictEqual(await provider.handleReload(document), undefined);
    });

    it('does the first load when it had failed, e.g. a warehouse opened while dbt was still creating it', async () => {
      fs.writeFileSync(target, new Uint8Array(0));
      const provider = new DuckdbEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
      const document = provider.openCustomDocument(vscode.Uri.file(target));
      document.initialLoadDone = true; // the first load ran and found nothing usable
      try {
        const stillEmpty = await provider.handleReload(document);
        assert.strictEqual(stillEmpty?.success, false);
        assert.strictEqual(document.handle, undefined);

        copyFixture('multi-table.duckdb'); // dbt finished
        const outcome = await provider.handleReload(document);
        assert.strictEqual(outcome?.success, true);
        assert.ok(document.handle, 'the reload becomes the first load');
        if (outcome?.success) {
          assert.strictEqual(outcome.data.tables.length, 3);
          assert.strictEqual(outcome.data.reload?.previousRowCount, undefined);
          assert.deepStrictEqual(outcome.data.capabilities, { refresh: true, query: true });
        }
      } finally {
        document.dispose();
      }
    });

    it('keeps the old handle and view when the shown table cannot be read from the new file', async () => {
      // A view over a parquet file that disappears, as a rebuild can leave it for a moment.
      const parquetDir = path.join(workDir, 'sub');
      fs.mkdirSync(parquetDir);
      const instance = await DuckDBInstance.create(target);
      const connection = await instance.connect();
      try {
        await connection.run(`COPY (SELECT 1 AS id) TO '${path.join(parquetDir, 'x.parquet')}' (FORMAT parquet)`);
        await connection.run(`SET file_search_path = '${workDir}'`);
        await connection.run("CREATE VIEW v AS SELECT * FROM read_parquet('sub/*.parquet')");
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
      const provider = new DuckdbEditorProvider({ extensionPath: process.cwd() } as vscode.ExtensionContext);
      const document = provider.openCustomDocument(vscode.Uri.file(target));
      const opened = await openDuckdbDatabase(await vscode.workspace.fs.readFile(document.uri), { searchDir: workDir });
      assert.ok(!('error' in opened));
      if ('error' in opened) {
        return;
      }
      document.handle = opened;
      document.initialLoadDone = true;
      try {
        const shown = await provider.handleSelectTable(document, 'v');
        assert.strictEqual(shown?.success, true);
        fs.rmSync(parquetDir, { recursive: true });

        const outcome = await provider.handleReload(document);
        assert.strictEqual(outcome?.success, false, 'a table that cannot be read is a failed reload, not a new view');
        assert.match(outcome?.success === false ? outcome.errors[0].message : '', /Could not read "v"/);
        assert.strictEqual(document.handle, opened, 'the working handle must survive');
        assert.ok(fs.existsSync(opened.tempFilePath));
        assert.strictEqual(document.selectedTable, 'v');
      } finally {
        document.dispose();
      }
    });

    it('does not undo a table pick that lands while the reload is running', async () => {
      copyFixture('multi-table.duckdb');
      const { provider, document } = await openTarget();
      try {
        await provider.handleSelectTable(document, 'customers');
        const reload = provider.handleReload(document);
        await provider.handleSelectTable(document, 'orders');
        const outcome = await reload;
        assert.strictEqual(outcome?.success, true);
        assert.strictEqual(document.selectedTable, 'orders', 'the host must not go back to the table the user left');
        // A reload payload that arrives after the pick shows the picked table's rows.
        if (outcome?.success && outcome.data.selectedTable === 'orders') {
          assert.strictEqual(outcome.data.data.rowCount, 3);
        }
      } finally {
        document.dispose();
      }
    });

    it('opens the remembered table, not the first one, when the reload is the first load', async () => {
      fs.writeFileSync(target, new Uint8Array(0)); // dbt still creating the file
      const remembered = `tablas.lastTable:${vscode.Uri.file(target).toString()}`;
      const context = {
        extensionPath: process.cwd(),
        workspaceState: {
          get: <T>(key: string) => (key === remembered ? ('orders' as unknown as T) : undefined),
          update: async () => undefined,
        },
      } as unknown as vscode.ExtensionContext;
      const provider = new DuckdbEditorProvider(context);
      const document = provider.openCustomDocument(vscode.Uri.file(target));
      document.initialLoadDone = true;
      try {
        copyFixture('multi-table.duckdb');
        const outcome = await provider.handleReload(document);
        assert.strictEqual(outcome?.success && outcome.data.selectedTable, 'orders');
        assert.strictEqual(document.selectedTable, 'orders');
      } finally {
        document.dispose();
      }
    });

    it('does not leak a handle when the document is disposed while reloading', async () => {
      copyFixture('multi-table.duckdb');
      const { provider, document } = await openTarget();
      const tempCopies = () => new Set(fs.readdirSync(os.tmpdir()).filter((f) => /^tablas-.*\.duckdb$/.test(f)));
      const before = tempCopies();
      const pending = provider.handleReload(document);
      document.dispose();
      assert.strictEqual(await pending, undefined);
      const created = [...tempCopies()].filter((f) => !before.has(f));
      assert.deepStrictEqual(created, [], 'the reload must close the handle it opened for a disposed document');
    });
  });
});

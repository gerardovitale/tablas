import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import {
  duckdbTableFilter,
  duckdbTableStats,
  emptyParsedTable,
  listDuckdbTables,
  openDuckdbDatabase,
  readSelectedTable,
  runExclusive,
  type DuckdbHandle,
} from './duckdbParser';
import { reportStatsFailure } from './columnStats';
import {
  filterPayload,
  planFilter,
  reportFilterFailure,
  FILTER_FAILED_REASON,
  FILTER_UNKNOWN_TABLE_REASON,
} from './filter';
import { filterDataMessage, isFilterMessage, type FilterMessage, type FilterPayload } from './filterMessage';
import { isGetStatsMessage, statsDataMessage, type StatsPayload } from './statsMessage';
import type { MultiTableData, MultiTableParseOutcome } from './tableData';
import { ReloadScheduler } from './reloadScheduler';
import { buildWebviewHtml } from './webviewHtml';
import { getAutoRefreshSetting, getMaxRowsSetting } from './config';

/** Quiet period after the last file event before a changed file is re-read. */
const RELOAD_DEBOUNCE_MS = 750;
/** How long a burst of events may wait for the writer's `.wal` to go away. */
const RELOAD_MAX_WAIT_MS = 30_000;

class DuckdbDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  /**
   * Unlike CsvDocument/ParquetDocument's bare stubs, this holds the live
   * database handle (and its backing temp file) for the document's
   * lifetime: switching tables re-queries the already-open database instead
   * of re-reading and re-opening the whole file on every dropdown change.
   * Undefined until the ready-handshake completes (or forever, if opening
   * the file/database failed).
   */
  handle?: DuckdbHandle;
  /** `seq` of the newest `filter` request received; an older one still queued is dropped. */
  filterSeq = 0;
  /**
   * True once the first load has been attempted (it may have failed or found an
   * empty file, leaving `handle` undefined). A reload may then do the load that
   * did not work, e.g. a warehouse opened while `dbt` was still creating it.
   */
  initialLoadDone = false;
  /** The table last posted to the webview; a reload keeps showing it. */
  selectedTable?: string;
  /** Its (total) row count, to report how a reload moved it. */
  shownRowCount?: number;
  private disposed = false;
  get isDisposed(): boolean {
    return this.disposed;
  }
  dispose(): void {
    this.disposed = true;
    this.handle?.close();
  }
}

export class DuckdbEditorProvider
  implements vscode.CustomReadonlyEditorProvider<DuckdbDocument>
{
  public static readonly viewType = 'tablas.duckdbViewer';

  /**
   * Registers the provider and returns both the disposable (for
   * `context.subscriptions`) and the provider instance itself, so callers
   * — namely `extension.ts`'s public API — can observe
   * `onDidPostDuckdbData`. Integration tests subscribe to that event to
   * verify the extension-host/webview handshake actually completes, since
   * `vscode.commands.executeCommand('vscode.openWith', ...)` resolving
   * doesn't imply the webview ever received data: the
   * `onDidReceiveMessage` handler below is async and unawaited by
   * `resolveCustomEditor`, so an error inside it can't reject that
   * command's promise.
   */
  public static register(context: vscode.ExtensionContext): {
    disposable: vscode.Disposable;
    provider: DuckdbEditorProvider;
  } {
    const provider = new DuckdbEditorProvider(context);
    const disposable = vscode.window.registerCustomEditorProvider(
      DuckdbEditorProvider.viewType,
      provider,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      }
    );
    const refreshCommand = vscode.commands.registerCommand('tablas.refresh', () => provider.refreshActive());
    return { disposable: vscode.Disposable.from(disposable, refreshCommand), provider };
  }

  /** Re-read triggers of the open panels, keyed by document URI (see `refreshActive`). */
  private readonly refreshers = new Map<string, () => Promise<void>>();

  /** `tablas.refresh`: re-reads the DuckDB file shown in the active editor tab. */
  public async refreshActive(): Promise<void> {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputCustom && input.viewType === DuckdbEditorProvider.viewType) {
      await this.refreshers.get(input.uri.toString())?.();
    }
  }

  private readonly _onDidPostDuckdbData = new vscode.EventEmitter<MultiTableParseOutcome>();
  /**
   * Fires whenever `duckdb-data` has been posted to a webview, with the
   * parsed outcome -- on the initial load *and* on every subsequent table
   * switch (unlike CSV/Parquet's equivalent events, which only fire once).
   */
  public readonly onDidPostDuckdbData: vscode.Event<MultiTableParseOutcome> =
    this._onDidPostDuckdbData.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose(): void {
    this._onDidPostDuckdbData.dispose();
  }

  openCustomDocument(uri: vscode.Uri): DuckdbDocument {
    return new DuckdbDocument(uri);
  }

  async resolveCustomEditor(
    document: DuckdbDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const webview = webviewPanel.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))],
    };

    // Generate a per-request nonce for CSP
    const nonce = crypto.randomBytes(16).toString('hex');

    webview.html = buildWebviewHtml(webview, this.context.extensionPath, nonce, 'DuckDB Viewer');

    // Unlike CSV/Parquet's one-shot 'ready' listener (which disposes
    // itself), this stays registered for the document's lifetime: it also
    // handles every subsequent 'select-table' request against the same
    // already-open database.
    let hasLoadedInitial = false;

    // ── Live refresh ──
    let panelDisposed = false;
    const post = (message: unknown): void => {
      if (panelDisposed) {
        return;
      }
      try {
        void webview.postMessage(message).then(undefined, () => undefined);
      } catch {
        // webview went away between the check and the call
      }
    };
    let reloading = false;
    let reloadQueued = false;
    let initialLoading: Promise<MultiTableParseOutcome> | undefined;
    // Re-reads the file now and posts the result. One at a time: a request that
    // lands mid-reload is remembered and runs once more afterwards.
    const runReload = async (): Promise<void> => {
      if (panelDisposed) {
        return;
      }
      // A change that lands during the first load is not lost: it re-reads once
      // that load has been posted.
      if (initialLoading) {
        await initialLoading.then(undefined, () => undefined);
      }
      if (panelDisposed || (!document.handle && !document.initialLoadDone)) {
        return;
      }
      if (reloading) {
        reloadQueued = true;
        return;
      }
      reloading = true;
      try {
        do {
          reloadQueued = false;
          post({ type: 'reload-status', state: 'refreshing' });
          const outcome = await this.handleReload(document);
          if (panelDisposed || outcome === undefined) {
            break;
          }
          if (outcome.success) {
            post({ type: 'duckdb-data', payload: outcome });
            this._onDidPostDuckdbData.fire(outcome);
          } else {
            // Keep what is on screen; just say why it is not up to date.
            const reason = outcome.errors.map((e) => e.message).join('\n');
            post({ type: 'reload-status', state: 'failed', message: reason });
          }
        } while (reloadQueued && !panelDisposed);
      } finally {
        reloading = false;
      }
    };
    const key = document.uri.toString();
    this.refreshers.set(key, runReload);

    let scheduler: ReloadScheduler | undefined;
    let watcher: vscode.FileSystemWatcher | undefined;
    if (document.uri.scheme === 'file') {
      const filePath = document.uri.fsPath;
      const walPath = filePath + '.wal';
      scheduler = new ReloadScheduler({
        debounceMs: RELOAD_DEBOUNCE_MS,
        maxWaitMs: RELOAD_MAX_WAIT_MS,
        isWriteInProgress: () =>
          fs.promises.stat(walPath).then(
            () => true,
            () => false
          ),
        onWaiting: () => post({ type: 'reload-status', state: 'building' }),
        reload: runReload,
      });
      // Non-recursive: the file and its `.wal` live in one folder, which may sit
      // outside the workspace. Watches every file there and filters by exact path
      // below: a pattern built from the file name would misfire for names holding
      // glob characters (`sales[2024].duckdb`, `{prod}.duckdb`).
      watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.dirname(filePath)), '*')
      );
      const onFileEvent = (uri: vscode.Uri): void => {
        if ((uri.fsPath === filePath || uri.fsPath === walPath) && getAutoRefreshSetting()) {
          scheduler?.notify();
        }
      };
      watcher.onDidChange(onFileEvent);
      watcher.onDidCreate(onFileEvent);
      watcher.onDidDelete(onFileEvent);
    }
    webviewPanel.onDidDispose(() => {
      panelDisposed = true;
      scheduler?.dispose();
      watcher?.dispose();
      if (this.refreshers.get(key) === runReload) {
        this.refreshers.delete(key);
      }
    });

    webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        // A real webview only posts 'ready' once per panel lifetime, but
        // guard against a duplicate anyway: without this, re-entering
        // loadInitial would open a second database (and write a second
        // temp file) and overwrite document.handle without closing the
        // first one, leaking both for the process's lifetime.
        if (hasLoadedInitial) {
          return;
        }
        hasLoadedInitial = true;
        initialLoading = this.loadInitial(document);
        const outcome = await initialLoading;
        await webview.postMessage({ type: 'duckdb-data', payload: outcome });
        this._onDidPostDuckdbData.fire(outcome);
      } else if (message?.type === 'select-table' && typeof message.table === 'string') {
        const outcome = await this.handleSelectTable(document, message.table);
        // undefined means the database isn't open yet (shouldn't happen
        // given the ready-gate above, but cheap to guard) -- no-op.
        if (outcome) {
          await webview.postMessage({ type: 'duckdb-data', payload: outcome });
          this._onDidPostDuckdbData.fire(outcome);
        }
      } else if (message?.type === 'refresh') {
        await runReload();
      } else if (isGetStatsMessage(message)) {
        const payload = await this.handleGetStats(document, message.table);
        if (payload) {
          await webview.postMessage(statsDataMessage(payload));
        }
      } else if (isFilterMessage(message)) {
        const payload = await this.handleFilter(document, message);
        if (payload) {
          await webview.postMessage(filterDataMessage(payload));
        }
      }
    });
  }

  /** First load: reads the file, opens the database, stashes the handle, reads the first table. */
  private async loadInitial(document: DuckdbDocument): Promise<MultiTableParseOutcome> {
    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      if (bytes.byteLength === 0) {
        // Still advertises refresh: the file may be about to be written.
        const empty: MultiTableData = { tables: [], selectedTable: '', data: emptyParsedTable() };
        return { success: true, data: this.publish(document, empty), errors: [] };
      }

      // Relative paths inside views resolve next to the source file, which only
      // means something for a local file.
      const searchDir = document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined;
      const opened = await openDuckdbDatabase(bytes, { searchDir });
      if ('error' in opened) {
        return { success: false, errors: [opened.error] };
      }

      let data: MultiTableData;
      try {
        const tables = await listDuckdbTables(opened);
        data = await readSelectedTable(opened, tables, undefined, getMaxRowsSetting());
      } catch (err) {
        opened.close();
        throw err;
      }
      // Only now: a reload must not swap in while this first read is running.
      document.handle = opened;
      return { success: true, data: this.publish(document, data), errors: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errors: [{ type: 'IOError', code: 'ReadFailed', message }],
      };
    } finally {
      document.initialLoadDone = true;
    }
  }

  /**
   * Final touches on a payload before it goes to the webview: remembers what is
   * on screen (so a reload can keep the table and report the row delta) and
   * advertises what the host can do. `reloadAt` marks the payload as a re-read.
   */
  private publish(document: DuckdbDocument, data: MultiTableData, reloadAt?: string): MultiTableData {
    const previousRowCount =
      reloadAt !== undefined && document.selectedTable === data.selectedTable ? document.shownRowCount : undefined;
    document.selectedTable = data.selectedTable === '' ? undefined : data.selectedTable;
    document.shownRowCount =
      data.tableError === undefined && data.selectedTable !== ''
        ? (data.data.totalRowCount ?? data.data.rowCount)
        : undefined;
    return {
      ...data,
      capabilities: { refresh: true },
      ...(reloadAt !== undefined && {
        reload: { at: reloadAt, ...(previousRowCount !== undefined && { previousRowCount }) },
      }),
    };
  }

  /**
   * Re-reads the file into a fresh database handle and, if that works, swaps it
   * in and returns the same table's new contents (`reload` set). On any failure
   * -- the file is unreadable, empty or corrupt, or the shown table cannot be
   * read from it (e.g. a view whose source files are missing mid-build) -- the
   * old handle and what the webview shows stay untouched and a `success: false`
   * outcome says why. If the first load had failed (no handle yet), a successful
   * reload is that first load. `undefined` = nothing to do (the first load has
   * not been attempted yet, or the document was disposed meanwhile). Public so an
   * integration test can call it without a real webview.
   *
   * A table pick can land while this runs: the table is read from
   * `document.selectedTable` and re-read if it changed meanwhile, so a reload
   * never records (or shows) a table the user already left.
   *
   * The old handle is closed only after queries already queued on it finished,
   * and the reload never holds a lock on the source file (it works on a copy), so
   * a running `dbt build` is never blocked.
   */
  public async handleReload(document: DuckdbDocument): Promise<MultiTableParseOutcome | undefined> {
    if (!document.handle && !document.initialLoadDone) {
      return undefined;
    }
    const old = document.handle;
    const failed = (code: string, message: string): MultiTableParseOutcome => ({
      success: false,
      errors: [{ type: 'DuckdbError', code, message }],
    });
    let opened: DuckdbHandle;
    let data: MultiTableData;
    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      if (bytes.byteLength === 0) {
        return failed('ReloadFailed', 'The file is empty right now (it may still be being written).');
      }
      const searchDir = document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined;
      const result = await openDuckdbDatabase(bytes, { searchDir });
      if ('error' in result) {
        return { success: false, errors: [result.error] };
      }
      opened = result;
      try {
        const tables = await listDuckdbTables(opened);
        let target: string | undefined;
        let attempts = 0;
        do {
          target = document.selectedTable;
          data = await readSelectedTable(opened, tables, target, getMaxRowsSetting());
        } while (document.selectedTable !== target && ++attempts < 3);
      } catch (err) {
        opened.close();
        throw err;
      }
    } catch (err) {
      return failed('ReloadFailed', err instanceof Error ? err.message : String(err));
    }

    if (document.isDisposed) {
      opened.close();
      return undefined;
    }
    if (data.tableError !== undefined) {
      opened.close();
      return failed('ReloadFailed', `Could not read "${data.selectedTable}": ${data.tableError}`);
    }
    document.handle = opened;
    // Let queries already queued on the old handle finish before closing it.
    if (old) {
      void runExclusive(old, async () => undefined).then(() => old.close());
    }
    return { success: true, data: this.publish(document, data, new Date().toISOString()), errors: [] };
  }

  /**
   * Re-queries the already-open database for a different table. Exposed as
   * a directly-callable, public method (rather than folded straight into
   * the message listener) specifically so a unit test can exercise the
   * table-switch logic without a real webview -- `vscode-test`/
   * `@vscode/test-electron` has no way to drive a real webview's table picker
   * from Node-side test code. See test/integration/duckdbEditorProvider.test.ts
   * (it can't live under test/unit/ -- this file imports 'vscode', which
   * only exists inside a real Extension Development Host).
   *
   * Returns `undefined` (a no-op for the caller) if the document's database
   * isn't open yet.
   */
  public async handleSelectTable(
    document: DuckdbDocument,
    table: string
  ): Promise<MultiTableParseOutcome | undefined> {
    if (!document.handle) {
      return undefined;
    }
    try {
      const tables = await listDuckdbTables(document.handle);
      const data = await readSelectedTable(document.handle, tables, table, getMaxRowsSetting());
      return { success: true, data: this.publish(document, data), errors: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errors: [{ type: 'DuckdbError', code: 'ReadFailed', message }],
      };
    }
  }

  /**
   * Column statistics for one table, computed against the already-open
   * database when the webview first asks for them. Like `handleSelectTable`,
   * public so an integration test can call it without a real webview.
   * Returns `undefined` if the database isn't open yet; an unknown or
   * missing table (or a failure) yields a payload without `stats`. Stats
   * queue behind any other query on the same connection (see
   * `runExclusive`), so a slow scan can't collide with a table switch.
   */
  public async handleGetStats(document: DuckdbDocument, table?: string): Promise<StatsPayload | undefined> {
    if (!document.handle) {
      return undefined;
    }
    try {
      const known = table !== undefined && (await listDuckdbTables(document.handle)).some((t) => t.name === table);
      return { table, stats: known ? await duckdbTableStats(document.handle, table) : undefined };
    } catch (err) {
      reportStatsFailure(err);
      return { table, stats: undefined };
    }
  }

  /**
   * Filters one table/view of the already-open database for the webview's
   * filter row: up to `tablas.maxRows` matching rows plus the exact match
   * count. Returns `undefined` (nothing to post) when the database isn't open,
   * the filters were cleared, or a newer request superseded this one. An
   * unknown table yields a failed filter. Public so an integration test can
   * call it without a real webview.
   *
   * All connection work is queued per handle (`runExclusive`), so a stale
   * request waits behind the one running; listing the tables first is that
   * wait, and the `filterSeq` check right after it is what lets a stale
   * request skip the expensive query.
   */
  public async handleFilter(document: DuckdbDocument, message: FilterMessage): Promise<FilterPayload | undefined> {
    if (!document.handle) {
      return undefined;
    }
    document.filterSeq = message.seq;
    const plan = planFilter(message);
    if (plan.kind === 'cleared') {
      return undefined;
    }
    if (plan.kind === 'invalid') {
      return plan.payload;
    }
    try {
      const table = message.table;
      const known = table !== undefined && (await listDuckdbTables(document.handle)).some((t) => t.name === table);
      if (document.filterSeq !== message.seq) {
        return undefined;
      }
      if (!known || table === undefined) {
        return filterPayload(message, { failedReason: FILTER_UNKNOWN_TABLE_REASON });
      }
      return filterPayload(message, await duckdbTableFilter(document.handle, table, plan.specs, getMaxRowsSetting()));
    } catch (err) {
      reportFilterFailure(err);
      return filterPayload(message, { failedReason: FILTER_FAILED_REASON });
    }
  }
}

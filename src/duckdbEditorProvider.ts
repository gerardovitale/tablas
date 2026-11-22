import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import {
  duckdbDropCurrentResult,
  duckdbDropResult,
  duckdbResultFilter,
  duckdbResultStats,
  duckdbTableFilter,
  duckdbTableStats,
  emptyParsedTable,
  listDuckdbTables,
  openDuckdbDatabase,
  readSelectedTable,
  duckdbRunQuery,
  runExclusive,
  suggestQuery,
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
import {
  isCloseResultMessage,
  isRunQueryMessage,
  queryDataMessage,
  queryPayload,
  type QueryPayload,
  type RunQueryMessage,
} from './queryMessage';
import type { MultiTableData, MultiTableParseOutcome } from './tableData';
import { ReloadScheduler } from './reloadScheduler';
import { columnDescriptionsFor, findTableRef, type TableTarget } from './dbt';
import { sqlThemeMessage } from './sqlTheme';
import { loadSqlColors, SQL_THEME_SETTINGS } from './sqlThemeHost';
import { getDbtProjectRoots } from './dbtCommands';
import { buildWebviewHtml } from './webviewHtml';
import { getAutoRefreshSetting, getMaxRowsSetting } from './config';

/** Quiet period after the last file event before a changed file is re-read. */
const RELOAD_DEBOUNCE_MS = 750;
/** How long a burst of events may wait for the writer's `.wal` to go away. */
const RELOAD_MAX_WAIT_MS = 30_000;

/** `workspaceState` key of the table last shown for a file. */
function lastTableKey(uri: vscode.Uri): string {
  return `tablas.lastTable:${uri.toString()}`;
}

/** How `revealTable` went: shown, or why not (see its doc). */
export type RevealOutcome = 'shown' | 'missing' | 'unavailable';

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
  /** Same for `run-query`: a query still queued behind a newer one never runs. */
  querySeq = 0;
  /**
   * Counts table switches. One that finishes after a newer one started is
   * superseded and publishes nothing: the host's idea of the shown table
   * (`selectedTable`) must end up the same as the webview's.
   */
  selectSeq = 0;
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

  /** What the dbt "Preview Model" command can ask an open panel to do, keyed by document URI. */
  private readonly selectors = new Map<
    string,
    { reveal: () => void; select: (target: TableTarget) => Promise<RevealOutcome> }
  >();

  /**
   * A table to open on, for a file whose first load has not happened yet (the file
   * is not open, or its panel has not finished its handshake). `loadInitial` takes
   * it and settles the promise `revealTable` is waiting on.
   */
  private readonly pendingReveals = new Map<string, { target: TableTarget; settle: (outcome: RevealOutcome) => void }>();

  /**
   * Shows `target` (a table as dbt names it) in `uri`, opening the file if needed
   * and bringing its panel forward: the dbt "Preview Model" command. `'missing'`
   * = the file is open but has no such table (the model is not built yet, or is in
   * another file); `'unavailable'` = the file could not be opened or read.
   */
  public async revealTable(uri: vscode.Uri, target: TableTarget): Promise<RevealOutcome> {
    const open = this.selectors.get(uri.toString());
    if (open) {
      open.reveal();
      return open.select(target);
    }
    return this.awaitFirstLoad(uri.toString(), target, () =>
      vscode.commands.executeCommand('vscode.openWith', uri, DuckdbEditorProvider.viewType)
    );
  }

  /** Registers `target` for the first load of `key` and resolves with how that went (or `'unavailable'` after 15 s). */
  private awaitFirstLoad(key: string, target: TableTarget, start?: () => Thenable<unknown>): Promise<RevealOutcome> {
    return new Promise<RevealOutcome>((resolve) => {
      let done = false;
      const entry = {
        target,
        settle: (outcome: RevealOutcome) => {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          if (this.pendingReveals.get(key) === entry) {
            this.pendingReveals.delete(key);
          }
          resolve(outcome);
        },
      };
      const timer = setTimeout(() => entry.settle('unavailable'), 15_000);
      this.pendingReveals.set(key, entry);
      start?.().then(undefined, () => entry.settle('unavailable'));
    });
  }

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

    // The dbt "Preview Model" command: switch this panel to a table of the host's choosing.
    const selectTable = async (target: TableTarget): Promise<RevealOutcome> => {
      if (panelDisposed) {
        return 'unavailable';
      }
      if (!initialLoading && !document.handle && !document.initialLoadDone) {
        // The webview has not said 'ready' yet: the first load will open on it.
        return this.awaitFirstLoad(key, target);
      }
      try {
        if (initialLoading) {
          await initialLoading.then(undefined, () => undefined);
        }
        const handle = document.handle;
        if (panelDisposed || !handle) {
          return 'unavailable';
        }
        const ref = findTableRef(await listDuckdbTables(handle), target);
        if (!ref) {
          return 'missing';
        }
        if (document.selectedTable === ref.name && document.shownRowCount !== undefined) {
          // Already on screen: bringing the panel forward is all there is to do. Re-posting
          // it would throw away the user's filters, scroll position and query result. Only
          // a webview sitting in SQL mode has to be told to give way to the table.
          post({ type: 'show-table' });
          return 'shown';
        }
        const outcome = await this.handleSelectTable(document, ref.name);
        if (!outcome || panelDisposed) {
          return 'unavailable';
        }
        if (!outcome.success) {
          // Not pushed: an error page would replace what the user is looking at.
          return 'unavailable';
        }
        // `hostSelected`: not the user's pick, so the webview must not drop it as a stale reply.
        // Posted whatever table it turned out to be, so the webview and the host agree.
        const pushed: MultiTableParseOutcome = { ...outcome, data: { ...outcome.data, hostSelected: true } };
        post({ type: 'duckdb-data', payload: pushed });
        this._onDidPostDuckdbData.fire(pushed);
        // A reload can swap the handle between the lookup and the read; the table asked for
        // may be gone from the new one, and the read then falls back to another. One that was
        // found but could not be read is not "shown" either: the panel has an error under the picker.
        if (outcome.data.tableError !== undefined) {
          return 'unavailable';
        }
        return outcome.data.selectedTable === ref.name ? 'shown' : 'missing';
      } catch {
        return 'unavailable';
      }
    };
    const selectorEntry = { reveal: () => webviewPanel.reveal(), select: selectTable };
    this.selectors.set(key, selectorEntry);

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
    // The SQL box colours its text with the active theme's syntax colours, which a webview
    // is not given: send them now, and again when the theme or its customizations change.
    const sendSqlTheme = async (): Promise<void> => {
      post(sqlThemeMessage(await loadSqlColors()));
    };
    const themeSubscriptions = [
      vscode.window.onDidChangeActiveColorTheme(() => void sendSqlTheme()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (SQL_THEME_SETTINGS.some((setting) => event.affectsConfiguration(setting))) {
          void sendSqlTheme();
        }
      }),
    ];
    webviewPanel.onDidDispose(() => {
      panelDisposed = true;
      scheduler?.dispose();
      watcher?.dispose();
      themeSubscriptions.forEach((subscription) => subscription.dispose());
      if (this.refreshers.get(key) === runReload) {
        this.refreshers.delete(key);
      }
      // Like `refreshers`: a newer panel for the same file may have registered before this one's dispose fires.
      if (this.selectors.get(key) === selectorEntry) {
        this.selectors.delete(key);
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
        void sendSqlTheme();
        initialLoading = this.loadInitial(document);
        const outcome = await initialLoading;
        // `post`, not `webview.postMessage`: the panel may be gone by now, and an
        // unawaited async listener has nobody to catch the rejection.
        post({ type: 'duckdb-data', payload: outcome });
        this._onDidPostDuckdbData.fire(outcome);
      } else if (message?.type === 'select-table' && typeof message.table === 'string') {
        const outcome = await this.handleSelectTable(document, message.table);
        // undefined means the database isn't open yet (shouldn't happen
        // given the ready-gate above, but cheap to guard) -- no-op.
        if (outcome) {
          post({ type: 'duckdb-data', payload: outcome });
          this._onDidPostDuckdbData.fire(outcome);
        }
      } else if (message?.type === 'refresh') {
        await runReload();
      } else if (isGetStatsMessage(message)) {
        const payload = await this.handleGetStats(document, message.table, message.result);
        if (payload) {
          post(statsDataMessage(payload, message.seq));
        }
      } else if (isFilterMessage(message)) {
        const payload = await this.handleFilter(document, message);
        if (payload) {
          post(filterDataMessage(payload));
        }
      } else if (isRunQueryMessage(message)) {
        const payload = await this.handleRunQuery(document, message);
        if (payload) {
          post(queryDataMessage(payload));
        }
      } else if (isCloseResultMessage(message)) {
        await this.handleCloseResult(document, message.seq);
      }
    });
  }

  /**
   * The table the user last looked at in this file, kept in the workspace state
   * so reopening the file (or a new VS Code window on the same workspace) lands
   * on it instead of the first table. `workspaceState` is optional because tests
   * build the provider with a bare context.
   */
  private rememberedTable(document: DuckdbDocument): string | undefined {
    try {
      return this.context.workspaceState?.get<string>(lastTableKey(document.uri));
    } catch {
      return undefined;
    }
  }

  private rememberTable(document: DuckdbDocument, table: string): void {
    try {
      void this.context.workspaceState?.update(lastTableKey(document.uri), table)?.then(undefined, () => undefined);
    } catch {
      // best effort: forgetting the last table is not worth failing a table switch
    }
  }

  /**
   * First load: reads the file, opens the database, stashes the handle, reads
   * the remembered table (else the first one). Public so an integration test
   * can call it without a real webview.
   */
  public async loadInitial(document: DuckdbDocument): Promise<MultiTableParseOutcome> {
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
      const opened = await openDuckdbDatabase(bytes, { searchDir, fileName: path.posix.basename(document.uri.path) });
      if ('error' in opened) {
        return { success: false, errors: [opened.error] };
      }

      let data: MultiTableData;
      let revealed: RevealOutcome | undefined;
      let revealedTable: string | undefined;
      try {
        const tables = await listDuckdbTables(opened);
        // A table the dbt command asked for beats the remembered one.
        const pending = this.pendingReveals.get(document.uri.toString());
        const wanted = pending ? findTableRef(tables, pending.target) : undefined;
        if (pending) {
          revealed = wanted ? 'shown' : 'missing';
          revealedTable = wanted?.name;
        }
        data = await readSelectedTable(opened, tables, wanted?.name ?? this.rememberedTable(document), getMaxRowsSetting());
        data = await this.withColumnDescriptions(document, data);
      } catch (err) {
        opened.close();
        throw err;
      }
      if (document.isDisposed) {
        // The tab was closed while the file was being read: `dispose()` already ran
        // without a handle, so nobody else would ever close this one (and its temp copy).
        opened.close();
        return {
          success: false,
          errors: [{ type: 'IOError', code: 'Disposed', message: 'The editor was closed while the file was loading.' }],
        };
      }
      // Only now: a reload must not swap in while this first read is running.
      document.handle = opened;
      if (revealedTable !== undefined && data.tableError === undefined && data.selectedTable === revealedTable) {
        // Like a pick in the picker: reopening the file later lands on the previewed model.
        this.rememberTable(document, revealedTable);
      }
      if (revealed) {
        // A table that was found but could not be read is not "shown": the panel has an error under the picker.
        const settled: RevealOutcome =
          revealed === 'shown' && data.tableError !== undefined ? 'unavailable' : revealed;
        this.pendingReveals.get(document.uri.toString())?.settle(settled);
      }
      return { success: true, data: this.publish(document, data), errors: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errors: [{ type: 'IOError', code: 'ReadFailed', message }],
      };
    } finally {
      document.initialLoadDone = true;
      // Whoever asked for a table and is still waiting: the file could not be opened.
      this.pendingReveals.get(document.uri.toString())?.settle('unavailable');
    }
  }

  /**
   * Adds dbt's column descriptions for the selected table, when the file belongs to
   * a dbt project whose manifest knows it. Never throws and never delays a table by
   * more than reading (and, once, parsing) the manifest.
   */
  private async withColumnDescriptions(document: DuckdbDocument, data: MultiTableData): Promise<MultiTableData> {
    if (document.uri.scheme !== 'file' || data.tableError !== undefined) {
      return data;
    }
    const ref = data.tables.find((t) => t.name === data.selectedTable);
    if (!ref) {
      return data;
    }
    try {
      const columnDescriptions = await columnDescriptionsFor(document.uri.fsPath, ref, getDbtProjectRoots());
      return columnDescriptions ? { ...data, columnDescriptions } : data;
    } catch {
      return data;
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
    // Without a handle (an empty file so far) there is nothing to query yet.
    const handle = document.handle;
    return {
      ...data,
      capabilities: { refresh: true, query: handle !== undefined },
      ...(handle !== undefined && data.selectedTable !== '' && { querySuggestion: suggestQuery(handle, data.selectedTable) }),
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
      const result = await openDuckdbDatabase(bytes, { searchDir, fileName: path.posix.basename(document.uri.path) });
      if ('error' in result) {
        return { success: false, errors: [result.error] };
      }
      opened = result;
      try {
        const tables = await listDuckdbTables(opened);
        // What is on screen, else (a first load that failed, so nothing is) what the
        // user last looked at, like `loadInitial` would have opened.
        const wanted = (): string | undefined => document.selectedTable ?? this.rememberedTable(document);
        let target: string | undefined;
        let attempts = 0;
        do {
          target = wanted();
          data = await readSelectedTable(opened, tables, target, getMaxRowsSetting());
          // Inside the loop: this await takes real time (project and manifest files), and a pick
          // that lands during it must send the loop round again, not be overwritten by `publish`.
          data = await this.withColumnDescriptions(document, data);
        } while (wanted() !== target && ++attempts < 3);
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
    const seq = ++document.selectSeq;
    // A table pick leaves the query result (if one was still held): its table is dead weight.
    void duckdbDropCurrentResult(document.handle);
    try {
      // One handle for the list and the read: the table list of one database must not be
      // paired with the rows of another. A reload that swapped `document.handle` while the
      // list waited in the (busy) old handle's queue has queued that handle's close behind
      // it, so reading from the old one would hit a closed connection: go again on the new.
      let handle = document.handle;
      let tables = await listDuckdbTables(handle);
      for (let retries = 0; document.handle !== handle && document.handle && retries < 3; retries++) {
        handle = document.handle;
        tables = await listDuckdbTables(handle);
      }
      const data = await this.withColumnDescriptions(
        document,
        await readSelectedTable(handle, tables, table, getMaxRowsSetting())
      );
      if (document.selectSeq !== seq) {
        // A newer switch started meanwhile (the manifest read above takes real time);
        // publishing this one afterwards would leave `selectedTable` on the wrong table.
        return undefined;
      }
      if (data.tableError === undefined && data.selectedTable !== '') {
        this.rememberTable(document, data.selectedTable);
      }
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
  public async handleGetStats(
    document: DuckdbDocument,
    table?: string,
    result?: number
  ): Promise<StatsPayload | undefined> {
    if (!document.handle) {
      return undefined;
    }
    if (result !== undefined) {
      // A query result the host kept as a table (see `duckdbRunQuery`); `undefined` stats if it is gone.
      try {
        return { result, stats: await duckdbResultStats(document.handle, result) };
      } catch (err) {
        reportStatsFailure(err);
        return { result, stats: undefined };
      }
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
   * Runs the SQL the user typed in the query box against the already-open
   * database (reads only, capped at `tablas.maxRows` rows; see `duckdbRunQuery`)
   * and answers with the rows or the error text. Returns `undefined` (nothing
   * to post) when the database is not open or a newer request overtook this one
   * while it waited in the connection's queue. The text is not kept anywhere: the box
   * opens on a suggestion each time, and the query is never run unless the user asks,
   * except that a refresh re-runs the last query the webview itself sent.
   * Public so an integration test can call it without a real webview.
   */
  public async handleRunQuery(document: DuckdbDocument, message: RunQueryMessage): Promise<QueryPayload | undefined> {
    if (!document.handle) {
      return undefined;
    }
    document.querySeq = message.seq;
    const outcome = await duckdbRunQuery(document.handle, message.sql, getMaxRowsSetting(), {
      shouldRun: () => document.querySeq === message.seq,
      resultSeq: message.seq,
    });
    return outcome === undefined ? undefined : queryPayload(message, outcome);
  }

  /**
   * The webview stopped showing the result made by `run-query` `seq`: drop its table.
   * A newer result is left alone. Public so an integration test can call it without a webview.
   */
  public async handleCloseResult(document: DuckdbDocument, seq: number): Promise<void> {
    if (document.handle) {
      await duckdbDropResult(document.handle, seq);
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
    if (message.result !== undefined) {
      // A query result: the same SQL as for a table, over the result's own table. Like the table
      // path, wait in the connection's queue first (that is where a stale request is overtaken)
      // and drop the request if a newer one arrived meanwhile.
      try {
        const handle = document.handle;
        await runExclusive(handle, async () => undefined);
        if (document.filterSeq !== message.seq) {
          return undefined;
        }
        return filterPayload(message, await duckdbResultFilter(handle, message.result, plan.specs, getMaxRowsSetting()));
      } catch (err) {
        reportFilterFailure(err);
        return filterPayload(message, { failedReason: FILTER_FAILED_REASON });
      }
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

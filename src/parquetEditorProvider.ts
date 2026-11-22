import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { parquetRowsForFilter, parquetStats, parseParquet, ParquetParseOutcome } from './parquetParser';
import { reportStatsFailure } from './columnStats';
import {
  filterPayload,
  filterTable,
  fitsFilterCache,
  planFilter,
  reportFilterFailure,
  FILTER_FAILED_REASON,
  type FilterableRows,
} from './filter';
import { filterDataMessage, isFilterMessage, type FilterMessage, type FilterPayload } from './filterMessage';
import { isGetStatsMessage, statsDataMessage, type StatsPayload } from './statsMessage';
import { createFileQuerySession, queryInfoFor } from './fileSqlHost';
import type { QuerySession } from './querySession';
import {
  isCloseResultMessage,
  isRunQueryMessage,
  queryDataMessage,
  type QueryPayload,
  type RunQueryMessage,
} from './queryMessage';
import { watchSqlTheme } from './sqlThemeHost';
import { buildWebviewHtml } from './webviewHtml';
import { getMaxRowsSetting } from './config';

class ParquetDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  /** `seq` of the newest `filter` request received; an older request still waiting on I/O is dropped. */
  filterSeq = 0;
  /**
   * The file's rows as strings, kept only while a filter is active and only
   * for tables small enough to hold (`fitsFilterCache`), so typing in a filter
   * box doesn't re-read and re-decode the file per keystroke. Released when
   * the filters are cleared and on dispose; a file edited on disk meanwhile is
   * not noticed until then.
   */
  filterRows?: FilterableRows;
  /** The SQL box's engine, created on the first query (see `QuerySession`). */
  sql?: QuerySession;
  dispose(): void {
    this.filterRows = undefined;
    this.sql?.dispose();
  }
}

export class ParquetEditorProvider
  implements vscode.CustomReadonlyEditorProvider<ParquetDocument>
{
  public static readonly viewType = 'tablas.parquetViewer';

  /**
   * Registers the provider and returns both the disposable (for
   * `context.subscriptions`) and the provider instance itself, so callers
   * — namely `extension.ts`'s public API — can observe
   * `onDidPostParquetData`. Integration tests subscribe to that event to
   * verify the extension-host/webview handshake actually completes, since
   * `vscode.commands.executeCommand('vscode.openWith', ...)` resolving
   * doesn't imply the webview ever received data: the
   * `onDidReceiveMessage` handler below is async and unawaited by
   * `resolveCustomEditor`, so an error inside it can't reject that
   * command's promise.
   */
  public static register(context: vscode.ExtensionContext): {
    disposable: vscode.Disposable;
    provider: ParquetEditorProvider;
  } {
    const provider = new ParquetEditorProvider(context);
    const disposable = vscode.window.registerCustomEditorProvider(
      ParquetEditorProvider.viewType,
      provider,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      }
    );
    return { disposable, provider };
  }

  private readonly _onDidPostParquetData = new vscode.EventEmitter<ParquetParseOutcome>();
  /** Fires whenever `parquet-data` has been posted to a webview, with the parsed outcome. */
  public readonly onDidPostParquetData: vscode.Event<ParquetParseOutcome> =
    this._onDidPostParquetData.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose(): void {
    this._onDidPostParquetData.dispose();
  }

  openCustomDocument(uri: vscode.Uri): ParquetDocument {
    return new ParquetDocument(uri);
  }

  async resolveCustomEditor(
    document: ParquetDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const webview = webviewPanel.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'media')),
      ],
    };

    // Generate a per-request nonce for CSP
    const nonce = crypto.randomBytes(16).toString('hex');

    webview.html = buildWebviewHtml(webview, this.context.extensionPath, nonce, 'Parquet Viewer');

    // Stays registered for the document's lifetime: after the 'ready'
    // handshake it also answers 'get-stats' requests (the guard keeps a
    // duplicate 'ready' from decoding the file twice).
    let hasLoadedInitial = false;
    // The SQL box colours its text with the active theme's syntax colours (see `sqlThemeHost.ts`).
    let panelDisposed = false;
    const theme = watchSqlTheme((themeMessage) => {
      if (!panelDisposed) {
        void webview.postMessage(themeMessage).then(undefined, () => undefined);
      }
    });
    webviewPanel.onDidDispose(() => {
      panelDisposed = true;
      theme.dispose();
    });
    webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        if (hasLoadedInitial) {
          return;
        }
        hasLoadedInitial = true;
        void theme.send();
        const outcome = await this.loadAndParseParquet(document.uri);
        await webview.postMessage({ type: 'parquet-data', payload: outcome });
        this._onDidPostParquetData.fire(outcome);
      } else if (isGetStatsMessage(message)) {
        await webview.postMessage(statsDataMessage(await this.handleGetStats(document, message.result), message.seq));
      } else if (isFilterMessage(message)) {
        const payload = await this.handleFilter(document, message);
        if (payload) {
          await webview.postMessage(filterDataMessage(payload));
        }
      } else if (isRunQueryMessage(message)) {
        const payload = await this.handleRunQuery(document, message);
        if (payload) {
          await webview.postMessage(queryDataMessage(payload));
        }
      } else if (isCloseResultMessage(message)) {
        await this.handleCloseResult(document, message.seq);
      }
    });
  }

  /**
   * Filters the whole file for the webview's filter row: up to
   * `tablas.maxRows` matching rows plus the exact match count. Returns
   * `undefined` (nothing to post) when the filters were cleared or a newer
   * request superseded this one. Public so an integration test can exercise it
   * without a webview.
   */
  public async handleFilter(document: ParquetDocument, message: FilterMessage): Promise<FilterPayload | undefined> {
    if (message.result !== undefined) {
      // A query result the SQL engine keeps as a table, not the file's own rows.
      return this.sqlSession(document).resultFilter(message, getMaxRowsSetting());
    }
    document.filterSeq = message.seq;
    const plan = planFilter(message);
    if (plan.kind === 'cleared') {
      document.filterRows = undefined;
      return undefined;
    }
    if (plan.kind === 'invalid') {
      return plan.payload;
    }
    try {
      let table = document.filterRows;
      if (!table) {
        const bytes = await vscode.workspace.fs.readFile(document.uri);
        if (document.filterSeq !== message.seq) {
          return undefined;
        }
        const loaded = await parquetRowsForFilter(bytes);
        // Decoding can outlast a newer request, including a "cleared" one that
        // already released the cache: don't re-fill it for a request nobody awaits.
        if (document.filterSeq !== message.seq) {
          return undefined;
        }
        if ('failedReason' in loaded) {
          return filterPayload(message, loaded);
        }
        table = loaded;
        if (fitsFilterCache(table)) {
          document.filterRows = table;
        }
      }
      return filterPayload(message, filterTable(table, plan.specs, getMaxRowsSetting()));
    } catch (err) {
      reportFilterFailure(err);
      return filterPayload(message, { failedReason: FILTER_FAILED_REASON });
    }
  }

  /**
   * Whole-file column statistics, computed when the webview first asks for
   * them. The document keeps no bytes, so this re-reads the file; a file
   * edited on disk since it was loaded therefore yields stats for its newer
   * content. Public so an integration test can exercise it without a webview.
   */
  public async handleGetStats(document: ParquetDocument, result?: number): Promise<StatsPayload> {
    if (result !== undefined) {
      return this.sqlSession(document).resultStats(result);
    }
    try {
      return { stats: await parquetStats(await vscode.workspace.fs.readFile(document.uri)) };
    } catch (err) {
      reportStatsFailure(err);
      return { stats: undefined };
    }
  }

  /** The document's SQL engine, created (not yet opened) on first use. */
  private sqlSession(document: ParquetDocument): QuerySession {
    document.sql ??= createFileQuerySession(document.uri, 'parquet');
    return document.sql;
  }

  /**
   * Runs the SQL box's query over the file through DuckDB (opened on the first one; see
   * `QuerySession`). `undefined` = nothing to post. Public so an integration test can call it
   * without a webview.
   */
  public async handleRunQuery(document: ParquetDocument, message: RunQueryMessage): Promise<QueryPayload | undefined> {
    return this.sqlSession(document).runQuery(message, getMaxRowsSetting());
  }

  /** The webview stopped showing the result made by run `seq`: drop its table. */
  public async handleCloseResult(document: ParquetDocument, seq: number): Promise<void> {
    await this.sqlSession(document).closeResult(seq);
  }

  private async loadAndParseParquet(uri: vscode.Uri): Promise<ParquetParseOutcome> {
    try {
      // Binary format -- no TextDecoder step, bytes go straight to parseParquet.
      const bytes = await vscode.workspace.fs.readFile(uri);
      const outcome = await parseParquet(bytes, getMaxRowsSetting());
      // The SQL box is offered next to the table (see `queryInfoFor`).
      return outcome.success ? { ...outcome, ...queryInfoFor(uri, 'parquet') } : outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false as const,
        errors: [{ type: 'IOError', code: 'ReadFailed', message }],
      };
    }
  }
}

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
  dispose(): void {
    this.filterRows = undefined;
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
    webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        if (hasLoadedInitial) {
          return;
        }
        hasLoadedInitial = true;
        const outcome = await this.loadAndParseParquet(document.uri);
        await webview.postMessage({ type: 'parquet-data', payload: outcome });
        this._onDidPostParquetData.fire(outcome);
      } else if (isGetStatsMessage(message)) {
        await webview.postMessage(statsDataMessage(await this.handleGetStats(document)));
      } else if (isFilterMessage(message)) {
        const payload = await this.handleFilter(document, message);
        if (payload) {
          await webview.postMessage(filterDataMessage(payload));
        }
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
  public async handleGetStats(document: ParquetDocument): Promise<StatsPayload> {
    try {
      return { stats: await parquetStats(await vscode.workspace.fs.readFile(document.uri)) };
    } catch (err) {
      reportStatsFailure(err);
      return { stats: undefined };
    }
  }

  private async loadAndParseParquet(uri: vscode.Uri): Promise<ParquetParseOutcome> {
    try {
      // Binary format -- no TextDecoder step, bytes go straight to parseParquet.
      const bytes = await vscode.workspace.fs.readFile(uri);
      return await parseParquet(bytes, getMaxRowsSetting());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false as const,
        errors: [{ type: 'IOError', code: 'ReadFailed', message }],
      };
    }
  }
}

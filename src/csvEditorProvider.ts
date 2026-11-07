import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { csvRowsForFilter, csvStats, parseCsv, CsvParseOutcome } from './csvParser';
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

class CsvDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  /** `seq` of the newest `filter` request received; an older request still waiting on I/O is dropped. */
  filterSeq = 0;
  /**
   * The file's rows as strings, kept only while a filter is active and only
   * for tables small enough to hold (`fitsFilterCache`), so typing in a filter
   * box doesn't re-read and re-parse the file per keystroke. Released when the
   * filters are cleared and on dispose; a file edited on disk meanwhile is
   * not noticed until then.
   */
  filterRows?: FilterableRows;
  dispose(): void {
    this.filterRows = undefined;
  }
}

export class CsvEditorProvider
  implements vscode.CustomReadonlyEditorProvider<CsvDocument>
{
  public static readonly viewType = 'tablas.csvViewer';

  /**
   * Registers the provider and returns both the disposable (for
   * `context.subscriptions`) and the provider instance itself, so callers
   * — namely `extension.ts`'s public API — can observe
   * `onDidPostCsvData`. Integration tests subscribe to that event to
   * verify the extension-host/webview handshake actually completes,
   * since `vscode.commands.executeCommand('vscode.openWith', ...)`
   * resolving doesn't imply the webview ever received data: the
   * `onDidReceiveMessage` handler below is async and unawaited by
   * `resolveCustomEditor`, so an error inside it can't reject that
   * command's promise.
   */
  public static register(context: vscode.ExtensionContext): {
    disposable: vscode.Disposable;
    provider: CsvEditorProvider;
  } {
    const provider = new CsvEditorProvider(context);
    const disposable = vscode.window.registerCustomEditorProvider(
      CsvEditorProvider.viewType,
      provider,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      }
    );
    return { disposable, provider };
  }

  private readonly _onDidPostCsvData = new vscode.EventEmitter<CsvParseOutcome>();
  /** Fires whenever `csv-data` has been posted to a webview, with the parsed outcome. */
  public readonly onDidPostCsvData: vscode.Event<CsvParseOutcome> = this._onDidPostCsvData.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose(): void {
    this._onDidPostCsvData.dispose();
  }

  openCustomDocument(uri: vscode.Uri): CsvDocument {
    return new CsvDocument(uri);
  }

  async resolveCustomEditor(
    document: CsvDocument,
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

    webview.html = buildWebviewHtml(webview, this.context.extensionPath, nonce, 'CSV Viewer');

    // Stays registered for the document's lifetime: after the 'ready'
    // handshake it also answers 'get-stats' requests (the guard keeps a
    // duplicate 'ready' from parsing the file twice).
    let hasLoadedInitial = false;
    webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        if (hasLoadedInitial) {
          return;
        }
        hasLoadedInitial = true;
        const outcome = await this.loadAndParseCsv(document.uri);
        await webview.postMessage({ type: 'csv-data', payload: outcome });
        this._onDidPostCsvData.fire(outcome);
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
  public async handleFilter(document: CsvDocument, message: FilterMessage): Promise<FilterPayload | undefined> {
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
        const loaded = csvRowsForFilter(new TextDecoder('utf-8').decode(bytes));
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
   * them. The document keeps no parsed rows (they'd sit in memory for the
   * editor's whole lifetime), so this re-reads and re-parses the file; a file
   * edited on disk since it was loaded therefore yields stats for its newer
   * content. Public, like the multi-table providers' `handleSelectTable`, so
   * an integration test can exercise it without a real webview.
   */
  public async handleGetStats(document: CsvDocument): Promise<StatsPayload> {
    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      return { stats: csvStats(new TextDecoder('utf-8').decode(bytes)) };
    } catch (err) {
      reportStatsFailure(err);
      return { stats: undefined };
    }
  }

  private async loadAndParseCsv(uri: vscode.Uri): Promise<CsvParseOutcome> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const rawContent = new TextDecoder('utf-8').decode(bytes);
      return parseCsv(rawContent, getMaxRowsSetting());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false as const,
        errors: [{ type: 'IOError', code: 'ReadFailed', message }],
      };
    }
  }
}

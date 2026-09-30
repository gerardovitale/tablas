import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { csvStats, parseCsv, CsvParseOutcome } from './csvParser';
import { reportStatsFailure } from './columnStats';
import { isGetStatsMessage, statsDataMessage, type StatsPayload } from './statsMessage';
import { buildWebviewHtml } from './webviewHtml';
import { getMaxRowsSetting } from './config';

class CsvDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
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
      }
    });
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

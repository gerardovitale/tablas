import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { parquetStats, parseParquet, ParquetParseOutcome } from './parquetParser';
import { reportStatsFailure } from './columnStats';
import { isGetStatsMessage, statsDataMessage, type StatsPayload } from './statsMessage';
import { buildWebviewHtml } from './webviewHtml';
import { getMaxRowsSetting } from './config';

class ParquetDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
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
      }
    });
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

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseParquet, ParquetParseOutcome } from './parquetParser';
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

    // Wait for 'ready' from webview, then send data
    const disposable = webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        disposable.dispose();
        const outcome = await this.loadAndParseParquet(document.uri);
        await webview.postMessage({ type: 'parquet-data', payload: outcome });
        this._onDidPostParquetData.fire(outcome);
      }
    });
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

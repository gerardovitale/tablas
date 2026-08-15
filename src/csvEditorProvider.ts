import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseCsv, CsvParseOutcome } from './csvParser';

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

    webview.html = this.buildWebviewHtml(webview, nonce);

    // Wait for 'ready' from webview, then send data
    const disposable = webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        disposable.dispose();
        const outcome = await this.loadAndParseCsv(document.uri);
        await webview.postMessage({ type: 'csv-data', payload: outcome });
        this._onDidPostCsvData.fire(outcome);
      }
    });
  }

  private async loadAndParseCsv(uri: vscode.Uri): Promise<CsvParseOutcome> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const rawContent = new TextDecoder('utf-8').decode(bytes);
      return parseCsv(rawContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false as const,
        errors: [{ type: 'IOError', code: 'ReadFailed', message }],
      };
    }
  }

  private buildWebviewHtml(webview: vscode.Webview, nonce: string): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(this.context.extensionPath, 'media', 'webview.js')
      )
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(this.context.extensionPath, 'media', 'styles.css')
      )
    );
    const csp = webview.cspSource;

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             img-src ${csp} data:;
             style-src ${csp};
             script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>CSV Viewer</title>
</head>
<body>
  <div id="app">
    <p class="message">Loading…</p>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
